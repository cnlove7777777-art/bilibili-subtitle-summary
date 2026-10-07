'use strict';

const TARGET_SAMPLE_RATE = 16000;
const DEFAULT_ASR_PROFILE = 'sensevoice_browser';
// Stay below the Qwen encoder's 800-frame boundary. AudioWorklet messages can
// overshoot the threshold by ~85 ms at 48 kHz; 7.75 s keeps live phrases in
// one 800-frame WebGPU window instead of padding a tiny overrun to 1600.
const MAX_PHRASE_SECONDS = 7.75;
// SenseVoice accepts a longer utterance than the fixed-shape Qwen encoder. Its
// preview remains low latency, while the final pass can use more context.
const SENSEVOICE_MAX_PHRASE_SECONDS = 11.5;
const PRE_ROLL_SECONDS = 0.28;
// A two-stage endpoint avoids both half-sentences and long run-ons: a normal
// utterance may close on a medium pause, while a short utterance needs a much
// clearer pause before it is committed.
const QWEN_NORMAL_ENDPOINT_SECONDS = 2.2;
const QWEN_NORMAL_SILENCE_SECONDS = 0.50;
const SENSEVOICE_NORMAL_ENDPOINT_SECONDS = 2.8;
const SENSEVOICE_NORMAL_SILENCE_SECONDS = 0.54;
const SHORT_ENDPOINT_SECONDS = 0.95;
const STRONG_SILENCE_SECONDS = 0.68;
// Preview inference re-runs the audio accumulated in the current phrase. Use
// an adaptive cadence: quick backends update often, slower ones keep updating
// at a wider gap instead of disabling previews after the first result.
const PREVIEW_MIN_SECONDS = 0.8;
const PREVIEW_INTERVAL_SECONDS = 1.15;
const PREVIEW_MAX_INTERVAL_SECONDS = 3.2;
const PREVIEW_MAX_REVISIONS = 7;
const MAX_QUEUED_AUDIO_SECONDS = 65;
const MODEL_WARMUP_BUFFER_SECONDS = 90;
const SCAN_QUEUE_PAUSE_SECONDS = 18;
const SCAN_QUEUE_RESUME_SECONDS = 6;
const DIRECT_LEAD_SECONDS = 1;
const DIRECT_MIN_LEAD_SECONDS = 0.5;
const DIRECT_MAX_LEAD_SECONDS = 2;
const DIRECT_MAX_BYTES = 512 * 1024 * 1024;
const MP4_MAX_NETWORK_BYTES = 2 * 1024 * 1024 * 1024;
const HLS_MAX_NETWORK_BYTES = 2 * 1024 * 1024 * 1024;
const HLS_MAX_FETCH_CONCURRENCY = 8;
const HLS_STARTUP_SECONDS = 9;
const HLS_WINDOW_SECONDS = 30;
const HLS_MIN_STARTUP_SEGMENTS = 1;
const DASH_STARTUP_SECONDS = 8.5;
const DASH_RANGE_CHUNK_BYTES = 512 * 1024;
const DIRECT_PROBE_BYTES = 64 * 1024;
const DIRECT_PROBE_TIMEOUT_MS = 4 * 1000;
const LOCAL_UPLOAD_TTL_MS = 30 * 60 * 1000;
const MODEL_INIT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
// These bound one inference, independently of model downloads and page clocks.
const GPU_INFERENCE_STALL_MS = 45 * 1000;
const CPU_INFERENCE_STALL_MS = 120 * 1000;
const QWEN_INFERENCE_STALL_MS = 90 * 1000;
const INFERENCE_HEARTBEAT_MS = 2000;
const DIRECT_FETCH_STALL_TIMEOUT_MS = 5 * 1000;
const PAGE_FETCH_STALL_TIMEOUT_MS = 25 * 1000;
const DIRECT_SILENCE_RMS = 0.0008;
const DIRECT_DIGITAL_SILENCE_RMS = 0.0000001;

let activeSession = null;
let asrWorker = null;
let asrWorkerKey = '';
let initWaiter = null;
let benchmarkRun = null;
let benchmarkWaiter = null;
let cancelWaiter = null;
let disposeWaiter = null;
let workerIdleTimer = null;
const MODEL_IDLE_RELEASE_MS = 90 * 1000;
const lastStates = new Map();
const forgottenTabs = new Set();
const pageFetchWaiters = new Map();
const localUploads = new Map();
const RETIRED_QWEN_CPU_CACHE = 'bscg-qwen3-asr-0.6b-int8-68818b2-v1';
const retiredModelCleanup = typeof caches === 'undefined'
  ? Promise.resolve(false)
  : caches.delete(RETIRED_QWEN_CPU_CACHE).catch(() => false);

function normalizeBackendMode(profile, backendMode) {
  if (profile === 'qwen3_asr_0_6b') return 'webgpu';
  return backendMode === 'wasm' ? 'wasm' : 'webgpu';
}

function openLocalMediaDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bscg-browser-media', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('files')) request.result.createObjectStore('files', { keyPath: 'token' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开浏览器媒体缓存'));
  });
}

async function readLocalMediaFile(token) {
  const database = await openLocalMediaDatabase();
  try {
    const record = await new Promise((resolve, reject) => {
      const transaction = database.transaction('files', 'readonly');
      const request = transaction.objectStore('files').get(token);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('无法读取浏览器媒体缓存'));
    });
    if (!record?.file || !(record.file instanceof Blob)) return null;
    if (!record.file.size || record.file.size > DIRECT_MAX_BYTES) throw new Error('本地媒体缓存大小无效');
    return record.file.arrayBuffer();
  } finally {
    database.close();
  }
}

function errorText(error) {
  return error?.message || String(error);
}

function engineError(message, code = '') {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function withErrorCode(error, code) {
  if (typeof error?.code === 'string' && error.code) return error;
  const tagged = engineError(errorText(error), code);
  try { tagged.cause = error; } catch {}
  return tagged;
}

function clearInitializationWatchdog(waiter) {
  if (waiter?.stallTimer) clearTimeout(waiter.stallTimer);
  if (waiter) waiter.stallTimer = null;
}

function touchInitializationWatchdog() {
  const waiter = initWaiter;
  if (!waiter) return;
  clearInitializationWatchdog(waiter);
  waiter.stallTimer = setTimeout(() => {
    if (initWaiter !== waiter) return;
    initWaiter = null;
    waiter.controller?.abort('initialization-timeout');
    terminateInferenceWorker();
    waiter.reject(engineError('模型初始化连续 5 分钟没有进展，已回收 Worker；请检查网络或模型缓存后重试', 'INIT_TIMEOUT'));
  }, MODEL_INIT_STALL_TIMEOUT_MS);
}

function modelDownloadSnapshot() {
  return self.BscgModelDownload?.snapshot?.() || null;
}

function ensureModelDownloadIdle(route = {}) {
  const profile = route.asrProfile || DEFAULT_ASR_PROFILE;
  const backendMode = normalizeBackendMode(profile, route.backendMode);
  if (self.BscgModelDownload?.isRunning?.() &&
      !self.BscgModelDownload?.isRouteReady?.(profile, backendMode)) {
    throw engineError('所选模型仍在下载；已完整缓存的其它模型可以继续使用', 'MODEL_DOWNLOAD_BUSY');
  }
}

function terminateInferenceWorker() {
  clearTimeout(workerIdleTimer);
  workerIdleTimer = null;
  if (cancelWaiter) { clearTimeout(cancelWaiter.timer); cancelWaiter.resolve(false); cancelWaiter = null; }
  if (disposeWaiter) { clearTimeout(disposeWaiter.timer); disposeWaiter.resolve(false); disposeWaiter = null; }
  clearInferenceWatchdog(activeSession);
  const worker = asrWorker;
  asrWorker = null;
  asrWorkerKey = '';
  try { worker?.terminate(); } catch {}
}

async function cancelInferenceForSwitch(state) {
  if (!asrWorker || !asrWorkerKey.startsWith('qwen3_asr_0_6b') || initWaiter) {
    terminateInferenceWorker();
    return false;
  }
  clearInferenceWatchdog(state);
  const worker = asrWorker;
  const stopped = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (cancelWaiter?.worker !== worker) return;
      cancelWaiter = null;
      resolve(false);
    }, 4000);
    cancelWaiter = { sessionId: state.sessionId, worker, resolve, timer };
    try { worker.postMessage({ type: 'qwen-cancel-session', sessionId: state.sessionId }); }
    catch { clearTimeout(timer); cancelWaiter = null; resolve(false); }
  });
  if (!stopped && asrWorker === worker) terminateInferenceWorker();
  return stopped;
}

async function releaseIdleModel() {
  if (activeSession || initWaiter || benchmarkRun?.status === 'running' || !asrWorker) return false;
  const worker = asrWorker;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (disposeWaiter?.worker !== worker) return;
      disposeWaiter = null;
      resolve(false);
    }, 2000);
    disposeWaiter = { worker, resolve, timer };
    try { worker.postMessage({ type: asrWorkerKey.startsWith('qwen3_asr_0_6b') ? 'qwen-dispose' : 'dispose' }); }
    catch { clearTimeout(timer); disposeWaiter = null; resolve(false); }
  });
  if (asrWorker === worker && !activeSession && !initWaiter) terminateInferenceWorker();
  return true;
}

function scheduleModelRelease() {
  clearTimeout(workerIdleTimer);
  workerIdleTimer = setTimeout(() => { void releaseIdleModel(); }, MODEL_IDLE_RELEASE_MS);
}

function initializationOwnerIsLive(sessionId) {
  return Boolean(
    (activeSession?.sessionId === sessionId && !activeSession.stopping) ||
    (benchmarkRun?.id === sessionId && benchmarkRun.status === 'running')
  );
}

function cancelInitialization(reason, sessionId = '', terminateWorker = true) {
  if (!initWaiter || (sessionId && initWaiter.sessionId !== sessionId)) return false;
  const waiter = initWaiter;
  initWaiter = null;
  clearInitializationWatchdog(waiter);
  waiter.controller?.abort('initialization-cancelled');
  if (terminateWorker) terminateInferenceWorker();
  waiter.reject(engineError(reason || '模型初始化已取消', 'INIT_CANCELLED'));
  return true;
}

function runtimeLabel(state) {
  const engine = state?.metrics?.engine || (state?.asrProfile === 'qwen3_asr_0_6b' ? 'Qwen3-ASR 0.6B' : 'SenseVoice');
  const precision = String(state?.metrics?.precision || (state?.backendMode === 'wasm' ? 'INT8' : 'FP16')).toUpperCase();
  return `${engine} ${precision}/${state?.metrics?.backend === 'wasm' || state?.backendMode === 'wasm' ? 'WASM CPU' : 'WebGPU'}`;
}

function modelRouteLabel(state) {
  if (state?.asrProfile === 'qwen3_asr_0_6b') return 'Qwen3-ASR 0.6B · WebGPU FP16';
  return state?.backendMode === 'wasm'
    ? 'SenseVoice Small · WASM CPU INT8'
    : 'SenseVoice Small · WebGPU FP16';
}

function modelProgressText(state, message) {
  const file = String(message?.file || '').split('/').pop();
  if (!file) return `${modelRouteLabel(state)} · 正在准备模型…`;
  return `${modelRouteLabel(state)} · 准备 ${file}：${(Number(message.progress) || 0).toFixed(1)}%`;
}

function sendEvent(state, event, extra = {}) {
  if (!state?.tabId) return;
  chrome.runtime.sendMessage({
    type: 'BILI_ASR_EVENT',
    tabId: state.tabId,
    sessionId: state.sessionId,
    mediaKey: state.mediaKey || '',
    documentId: state.documentId || '',
    jobId: state.jobId || state.sessionId,
    event,
    status: state.status,
    statusText: state.statusText,
    asrProfile: state.asrProfile,
    backendMode: state.backendMode,
    cpuThreads: state.cpuThreads,
    sourceMode: state.sourceMode,
    directGeneration: state.directGeneration || 0,
    backend: state.metrics.backend,
    // Provisional text has its own channel and must never enter export/cache.
    ...(extra.partialOnly ? {} : {
      srt: renderSrt(state.cues),
      segments: state.cues.map((cue) => ({ from: cue.from, to: cue.to, content: cue.text }))
    }),
    finalSegment: state.finalCue || null,
    previewSegment: state.previewCue?.text ? {
      id: state.previewCue.id,
      revision: state.previewCue.revision,
      from: state.previewCue.from,
      to: state.previewCue.to,
      content: state.previewCue.text,
      stableContent: state.previewCue.stableText || '',
      provisional: true
    } : null,
    metrics: { ...state.metrics },
    ...extra
  }).catch(() => {});
}

function visibleHeap() {
  const memory = performance?.memory;
  return memory ? {
    heapUsed: Number(memory.usedJSHeapSize) || 0,
    heapTotal: Number(memory.totalJSHeapSize) || 0,
    heapLimit: Number(memory.jsHeapSizeLimit) || 0
  } : {};
}

async function updateResourceMetrics(state, notify = false) {
  if (!state) return;
  try {
    const estimate = await navigator.storage.estimate();
    state.metrics.storageUsage = Number(estimate.usage) || 0;
    state.metrics.storageQuota = Number(estimate.quota) || 0;
  } catch {
    // Storage estimate is diagnostic only.
  }
  Object.assign(state.metrics, visibleHeap());
  if (notify) sendEvent(state, 'metrics');
}

function workerSpec(profile, backendMode, cpuThreads = 0) {
  if (profile === 'qwen3_asr_0_6b') {
    return { key: 'qwen3_asr_0_6b:webgpu', file: 'qwen-webgpu-worker.js', module: true, qwen: true };
  }
  const backend = backendMode === 'wasm' ? 'wasm' : 'webgpu';
  const threadKey = backend === 'wasm' ? `:${Math.max(0, Math.min(16, Number(cpuThreads) || 0))}` : '';
  return { key: `sensevoice_browser:${backend}${threadKey}`, file: 'asr-worker.js', module: true, qwen: false };
}

function createWorker(profile = activeSession?.asrProfile, backendMode = activeSession?.backendMode, cpuThreads = activeSession?.cpuThreads) {
  clearTimeout(workerIdleTimer);
  workerIdleTimer = null;
  if (disposeWaiter) terminateInferenceWorker();
  const spec = workerSpec(profile || 'sensevoice_browser', backendMode || 'wasm', cpuThreads);
  if (asrWorker && asrWorkerKey === spec.key) return asrWorker;
  if (asrWorker) {
    terminateInferenceWorker();
  }
  asrWorker = spec.module
    ? new Worker(chrome.runtime.getURL(spec.file), { type: 'module' })
    : new Worker(chrome.runtime.getURL(spec.file));
  const workerInstance = asrWorker;
  asrWorkerKey = spec.key;
  asrWorker.addEventListener('message', (event) => {
    if (asrWorker !== workerInstance) return;
    try {
      handleWorkerMessage(event.data || {});
    } catch (error) {
      // A result-processing exception used to escape the event listener after
      // deleting pending, leaving the UI on segment 1 with no next dispatch.
      if (activeSession) {
        const state = activeSession;
        terminateInferenceWorker();
        void failSession(state, withErrorCode(error, 'ASR_MESSAGE_PROCESSING_FAILED'));
      }
    }
  });
  asrWorker.addEventListener('error', (event) => {
    if (asrWorker !== workerInstance) return;
    const message = event.message || 'ASR Worker 崩溃';
    if (initWaiter) {
      const waiter = initWaiter;
      initWaiter = null;
      clearInitializationWatchdog(waiter);
      terminateInferenceWorker();
      waiter.reject(engineError(message, 'WORKER_CRASH'));
      // initializeModelWithFallback owns initialization failures and may
      // create the SenseVoice CPU worker. Do not fail the session in parallel.
      return;
    }
    if (benchmarkWaiter) {
      clearTimeout(benchmarkWaiter.timeout);
      benchmarkWaiter.reject(engineError(message, 'WORKER_CRASH'));
      benchmarkWaiter = null;
      return;
    }
    if (activeSession) {
      const state = activeSession;
      const error = new Error(message);
      if (!startRuntimeCpuFallback(state, error)) {
        terminateInferenceWorker();
        void failSession(state, error);
      }
    }
  });
  return asrWorker;
}

function postWorkerMessage(state, type, payload = {}, transfer = []) {
  const spec = workerSpec(state?.asrProfile || 'sensevoice_browser', state?.backendMode || 'wasm', state?.cpuThreads);
  const worker = createWorker(state?.asrProfile, state?.backendMode, state?.cpuThreads);
  const messageType = spec.qwen ? `qwen-${type}` : type;
  if (type === 'transcribe' && activeSession === state) beginInferenceWatchdog(state, payload);
  try {
    worker.postMessage({ type: messageType, language: state?.asrLanguage || 'auto', ...(spec.qwen ? { workerKind: spec.key } : {}), ...payload }, transfer);
  } catch (error) {
    if (activeSession !== state || type !== 'transcribe') throw error;
    clearInferenceWatchdog(state);
    // Do not recurse into dispatch/fallback while its caller is still updating state.
    void Promise.resolve().then(() => handleTranscriptionError(payload, withErrorCode(error, 'ASR_DISPATCH_FAILED')));
  }
}

function clearInferenceWatchdog(state) {
  const job = state?.inferenceJob;
  if (job?.timer) clearInterval(job.timer);
  if (state) state.inferenceJob = null;
}

function matchesInferenceJob(job, message) {
  return Boolean(job && job.sessionId === message.sessionId && job.phraseId === message.phraseId &&
    job.preview === Boolean(message.preview) && (!job.preview ||
      (job.previewToken === message.previewToken && job.previewRevision === Number(message.previewRevision || 0))));
}

function inferenceProgressDetails(state, job) {
  const elapsedMs = Math.max(0, performance.now() - job.startedAt);
  const labels = {
    dispatch: '等待模型接收音频', features: '提取音频特征',
    encoder: '音频编码', model: '模型计算（首次可能编译）',
    prefill: '准备文字解码', decode: '解码文字', ctc: '整理识别文字'
  };
  state.metrics.inferencePhase = job.phase;
  state.metrics.inferenceElapsedMs = elapsedMs;
  state.metrics.inferenceAudioSeconds = job.audioSeconds;
  state.metrics.inferencePhraseId = job.phraseId;
  const target = job.direct ? '音轨识别' : job.preview ? '字幕草稿' : '字幕定稿';
  return {
    phraseId: job.phraseId, preview: job.preview, inferencePhase: job.phase,
    inferenceElapsedMs: elapsedMs, audioSeconds: job.audioSeconds,
    statusText: `${target} · ${runtimeLabel(state)} · ${labels[job.phase] || job.phase}，已用 ${(elapsedMs / 1000).toFixed(0)} 秒…`
  };
}

function beginInferenceWatchdog(state, payload) {
  clearInferenceWatchdog(state);
  const qwen = state.asrProfile === 'qwen3_asr_0_6b';
  const stallMs = qwen ? QWEN_INFERENCE_STALL_MS : state.backendMode === 'wasm'
    ? CPU_INFERENCE_STALL_MS : GPU_INFERENCE_STALL_MS;
  const job = {
    sessionId: state.sessionId, phraseId: payload.phraseId,
    preview: Boolean(payload.preview), previewToken: payload.previewToken,
    previewRevision: Number(payload.previewRevision) || 0, direct: Boolean(payload.direct),
    audioSeconds: (payload.audio?.byteLength || 0) / 4 / TARGET_SAMPLE_RATE,
    phase: 'dispatch', startedAt: performance.now(), lastProgressAt: performance.now(),
    stallMs, maxMs: qwen ? 300000 : stallMs * 2, timer: null
  };
  state.inferenceJob = job;
  job.timer = setInterval(() => checkInferenceWatchdog(state, job), INFERENCE_HEARTBEAT_MS);
  const details = inferenceProgressDetails(state, job);
  state.statusText = details.statusText;
  sendEvent(state, 'inference-start', details);
}

function checkInferenceWatchdog(state, job = state?.inferenceJob) {
  if (!job || activeSession !== state || state.inferenceJob !== job) return;
  const now = performance.now();
  if (now - job.lastProgressAt >= job.stallMs || now - job.startedAt >= job.maxMs) {
    const details = inferenceProgressDetails(state, job);
    const error = engineError(
      `${runtimeLabel(state)} 单段识别超时：阶段=${job.phase}，音频 ${job.audioSeconds.toFixed(1)} 秒，已等待 ${(details.inferenceElapsedMs / 1000).toFixed(0)} 秒`,
      'ASR_INFERENCE_TIMEOUT'
    );
    state.metrics.inferenceTimeouts = (Number(state.metrics.inferenceTimeouts) || 0) + 1;
    sendEvent(state, 'inference-timeout', { ...details, error: error.message, errorCode: error.code });
    // A stuck GPU Promise cannot be cancelled by clearing our pending map.
    terminateInferenceWorker();
    state.directInFlightPhraseId = null;
    state.captureInFlightPhraseId = null;
    state.previewInFlight = false;
    if (!state.stopping && startRuntimeCpuFallback(state, error)) return;
    void failSession(state, error);
    return;
  }
  const details = inferenceProgressDetails(state, job);
  state.statusText = details.statusText;
  sendEvent(state, 'inference-waiting', details);
}

function handleInferenceProgress(message) {
  const state = activeSession;
  const job = state?.inferenceJob;
  if (!matchesInferenceJob(job, message)) return;
  job.phase = String(message.phase || job.phase);
  job.lastProgressAt = performance.now();
  const details = inferenceProgressDetails(state, job);
  state.statusText = details.statusText;
  sendEvent(state, 'inference-progress', details);
}

function finishInferenceWatchdog(state, message) {
  const job = state?.inferenceJob;
  if (!matchesInferenceJob(job, message)) return;
  const details = inferenceProgressDetails(state, job);
  clearInferenceWatchdog(state);
  if (message.type !== 'error') sendEvent(state, 'inference-complete', details);
}

function isModelResourceError(error) {
  return error?.name === 'AbortError' || /^MODEL_(DOWNLOAD|RESOURCE|CACHE)/.test(error?.code || '') ||
    /Failed to fetch|NetworkError|Load failed|fetch.*failed|下载.*(?:失败|HTTP)|缓存.*(?:失败|空间不足)|QuotaExceededError/i.test(errorText(error));
}

async function checkModelGpu(signal) {
  if (signal.aborted) throw engineError('模型准备已取消', 'INIT_CANCELLED');
  if (!navigator.gpu) throw engineError('当前浏览器未提供 WebGPU', 'WEBGPU_UNAVAILABLE');
  let timer;
  let onAbort;
  try {
    const adapter = await Promise.race([
      navigator.gpu.requestAdapter({ powerPreference: 'high-performance', forceFallbackAdapter: false }),
      new Promise((_, reject) => {
        onAbort = () => reject(engineError('模型准备已取消', 'INIT_CANCELLED'));
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => reject(engineError('GPU 检测超时', 'WEBGPU_UNAVAILABLE')), 10000);
      })
    ]);
    if (signal.aborted) throw engineError('模型准备已取消', 'INIT_CANCELLED');
    if (!adapter || adapter.isFallbackAdapter) throw engineError('未检测到可用的硬件 WebGPU 适配器', 'WEBGPU_UNAVAILABLE');
    if (!adapter.features?.has('shader-f16')) throw engineError('当前 GPU 不支持 WebGPU FP16', 'GPU_FP16_UNSUPPORTED');
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function reportModelPreparation(state, waiter, value) {
  if (initWaiter !== waiter || waiter.controller.signal.aborted) return;
  const snapshot = typeof value === 'string' ? null : value;
  const loaded = Number(snapshot?.loaded) || 0;
  const total = Number(snapshot?.total) || 0;
  const progress = Number(snapshot?.progress) || 0;
  const label = snapshot?.label || '';
  let statusText = typeof value === 'string' ? value : snapshot.statusText;
  if (snapshot?.phase === 'checking') statusText = `正在检查 ${label} 缓存；首次使用会自动下载缺失文件…`;
  if (snapshot?.phase === 'probing') statusText = `正在选择可用下载源：${label}（约 ${(total / 1000000).toFixed(0)} MB）…`;
  if (snapshot?.phase === 'downloading') statusText = `正在准备 ${label}：${(loaded / 1000000).toFixed(1)} / ${(total / 1000000).toFixed(1)} MB · ${snapshot.source || '选择下载源'} · ${snapshot.statusText}`;
  if (snapshot?.phase === 'complete') statusText = `${label} 文件已就绪，正在初始化推理…`;
  const progressKey = `${statusText}:${loaded}:${snapshot?.completedFiles || 0}`;
  if (waiter.progressKey === progressKey) return;
  waiter.progressKey = progressKey;
  touchInitializationWatchdog();
  if (benchmarkRun?.id === state.sessionId && benchmarkRun.status === 'running') {
    Object.assign(benchmarkRun, { phase: 'loading', statusText, loaded, total, progress });
  }
  if (activeSession !== state || state.stopping) return;
  state.status = 'loading';
  state.statusText = statusText;
  sendEvent(state, 'progress', { progress, loaded, total, modelPreparation: true });
}

function initializeModel(state) {
  if (initWaiter) {
    if (initWaiter.sessionId === state.sessionId) return initWaiter.promise;
    if (!initializationOwnerIsLive(initWaiter.sessionId)) {
      cancelInitialization('上一个模型初始化任务已经失去所属会话，已自动回收');
    } else {
      return Promise.reject(engineError('已有模型初始化任务正在运行', 'INIT_BUSY'));
    }
  }
  const spec = workerSpec(state.asrProfile, state.backendMode, state.cpuThreads);
  if (asrWorker && asrWorkerKey !== spec.key) terminateInferenceWorker();
  let resolveWaiter;
  let rejectWaiter;
  const promise = new Promise((resolve, reject) => {
    resolveWaiter = resolve;
    rejectWaiter = reject;
  });
  const waiter = initWaiter = {
    sessionId: state.sessionId,
    workerKey: '',
    controller: new AbortController(),
    promise,
    resolve: resolveWaiter,
    reject: rejectWaiter
  };
  touchInitializationWatchdog();
  void (async () => {
    try {
      if (state.backendMode !== 'wasm') {
        reportModelPreparation(state, waiter, '正在检测高性能 GPU 与 FP16 支持…');
        await checkModelGpu(waiter.controller.signal);
      }
      if (initWaiter !== waiter) return;
      if (!self.BscgModelDownload?.ensureRoute) throw engineError('模型下载组件未就绪，请重新加载扩展', 'MODEL_RESOURCE_UNAVAILABLE');
      const route = spec.qwen ? 'qwen-webgpu' : `sense-${state.backendMode === 'wasm' ? 'wasm' : 'webgpu'}`;
      // Populate the workers' canonical cache through the same downloader used
      // by Settings, including mirror retry and complete-file validation.
      await self.BscgModelDownload.ensureRoute(route, {
        signal: waiter.controller.signal,
        onProgress: (snapshot) => reportModelPreparation(state, waiter, snapshot)
      });
      if (initWaiter !== waiter || waiter.controller.signal.aborted) return;
      if (!initializationOwnerIsLive(state.sessionId)) {
        cancelInitialization('所属任务已结束，模型准备已取消', state.sessionId);
        return;
      }
      const worker = createWorker(state.asrProfile, state.backendMode, state.cpuThreads);
      waiter.workerKey = asrWorkerKey;
      touchInitializationWatchdog();
      worker.postMessage({
        type: spec.qwen ? 'qwen-init' : 'init',
        ...(spec.qwen ? { workerKind: spec.key } : {}),
        mode: state.backendMode,
        cpuThreads: state.cpuThreads,
        baseUrl: chrome.runtime.getURL('')
      });
    } catch (error) {
      if (initWaiter !== waiter) return;
      initWaiter = null;
      clearInitializationWatchdog(waiter);
      waiter.controller.abort('initialization-failed');
      terminateInferenceWorker();
      waiter.reject(error);
    }
  })();
  return promise;
}

async function initializeModelWithFallback(state) {
  try {
    return await initializeModel(state);
  } catch (error) {
    if (['INIT_BUSY', 'INIT_CANCELLED', 'INIT_TIMEOUT'].includes(error?.code) || isModelResourceError(error)) throw error;
    if (state.asrProfile !== 'sensevoice_browser' || state.backendMode === 'wasm' || activeSession !== state || state.stopping) throw error;
    state.statusText = `WebGPU 初始化失败，正在明确降级到 INT8/WASM CPU：${errorText(error)}`;
    sendEvent(state, 'fallback', { from: state.backendMode, to: 'wasm', fallbackError: errorText(error) });
    terminateInferenceWorker();
    initWaiter = null;
    state.backendMode = 'wasm';
    return initializeModel(state);
  }
}

function handleWorkerMessage(message) {
  const state = activeSession;
  if (message.type === 'session-cancelled' && cancelWaiter?.sessionId === message.sessionId) {
    const waiter = cancelWaiter;
    cancelWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(true);
    return;
  }
  if (message.type === 'disposed' && disposeWaiter) {
    const waiter = disposeWaiter;
    disposeWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(true);
    return;
  }
  if (message.type === 'partial-result') {
    if (!state || state.stopping || message.sessionId !== state.sessionId) return;
    const pending = message.preview ? null : state.pending.get(message.phraseId);
    if (!message.preview && !pending) return;
    state.metrics.firstPartialMs = Number(message.firstPartialMs) || 0;
    handleTranscriptionResult({
      ...message, partial: true, preview: true,
      previewToken: pending?.phraseToken || message.previewToken,
      previewStartVideo: pending?.startVideo ?? message.previewStartVideo,
      previewEndVideo: pending?.endVideo ?? message.previewEndVideo
    });
    return;
  }
  if (message.type === 'inference-progress') {
    handleInferenceProgress(message);
    return;
  }
  if (message.type === 'progress') {
    touchInitializationWatchdog();
    if (benchmarkRun?.status === 'running') {
      benchmarkRun.phase = 'loading';
      benchmarkRun.statusText = modelProgressText({
        asrProfile: benchmarkRun.profile,
        backendMode: benchmarkRun.backend
      }, message);
      benchmarkRun.progress = Number(message.progress) || 0;
      benchmarkRun.loaded = Number(message.loaded) || 0;
      benchmarkRun.total = Number(message.total) || 0;
    }
    if (!state) return;
    state.status = 'loading';
    state.statusText = modelProgressText(state, message);
    sendEvent(state, 'progress', {
      progress: Number(message.progress) || 0,
      loaded: Number(message.loaded) || 0,
      total: Number(message.total) || 0
    });
    return;
  }

  if (message.type === 'status') {
    touchInitializationWatchdog();
    if (benchmarkRun?.status === 'running') {
      benchmarkRun.phase = 'loading';
      benchmarkRun.statusText = message.statusText || '正在初始化模型…';
    }
    if (!state) return;
    state.status = message.status || 'loading';
    state.statusText = message.statusText || '正在初始化模型…';
    sendEvent(state, 'status');
    return;
  }

  if (message.type === 'fallback') {
    if (!state) return;
    state.statusText = message.to === 'wasm'
      ? 'WebGPU 不可用或执行失败，正在自动降级到 WASM…'
      : `后端失败：${message.error || '未知错误'}`;
    sendEvent(state, 'fallback', { from: message.from, to: message.to, fallbackError: message.error });
    return;
  }

  if (message.type === 'cache-warning') {
    if (!state) return;
    state.statusText = `模型可继续使用，但 ${message.file || '权重'} 未能写入缓存；下次可能需要重新下载。`;
    sendEvent(state, 'cache-warning', { cacheError: message.error });
    return;
  }

  if (message.type === 'ready') {
    if (state) {
      Object.assign(state.metrics, message.metrics || {});
      state.metrics.backend = message.metrics?.backend || state.metrics.backend;
      const engine = message.metrics?.engine || (state.asrProfile === 'qwen3_asr_0_6b' ? 'Qwen3-ASR 0.6B' : 'SenseVoice');
      const precision = String(message.metrics?.precision || '').toUpperCase();
      state.statusText = `${engine} ${precision}/${message.metrics?.backend === 'wasm' ? 'WASM CPU' : 'WebGPU'} 模型已就绪。`;
      // 独立音轨与模型并行准备。模型 ready 只说明推理 Worker 可用，不能
      // 冒充音轨已下载/解码完成；真正的 direct-ready 在音轨产生 PCM 后发送。
      sendEvent(state, state.sourceMode === 'direct' ? 'model-loaded' : 'model-ready');
    }
    if (initWaiter && initWaiter.workerKey === asrWorkerKey) {
      const waiter = initWaiter;
      initWaiter = null;
      clearInitializationWatchdog(waiter);
      waiter.resolve(message.metrics || {});
    }
    return;
  }

  if (message.type === 'result') {
    if (benchmarkWaiter && message.sessionId === benchmarkRun?.id && message.phraseId === benchmarkWaiter.phraseId) {
      const waiter = benchmarkWaiter;
      benchmarkWaiter = null;
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    handleTranscriptionResult(message);
    return;
  }

  if (message.type === 'error') {
    const error = new Error(message.error || '浏览器推理失败');
    if (message.errorCode) error.code = message.errorCode;
    if (message.cancelled && state?.stopping) return;
    if (message.fatal && state) {
      terminateInferenceWorker();
      void failSession(state, error);
      return;
    }
    if (message.cancelled && message.preview && state?.sessionId === message.sessionId) {
      finishInferenceWatchdog(state, { ...message, type: 'error' });
      state.previewInFlight = false;
      dispatchNextCapturePhrase(state);
      return;
    }
    if (message.requestType === 'init' && initWaiter) {
      const waiter = initWaiter;
      initWaiter = null;
      clearInitializationWatchdog(waiter);
      try { asrWorker?.terminate(); } catch {}
      asrWorker = null;
      asrWorkerKey = '';
      waiter.reject(error);
      return;
    }
    if (benchmarkWaiter && message.sessionId === benchmarkRun?.id) {
      const waiter = benchmarkWaiter;
      benchmarkWaiter = null;
      clearTimeout(waiter.timeout);
      waiter.reject(error);
      return;
    }
    handleTranscriptionError(message, error);
  }
}

function resampleTo16k(input, inputRate) {
  if (inputRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  if (ratio >= 1) {
    for (let i = 0; i < outputLength; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start + 1, Math.min(input.length, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += input[j];
      output[i] = sum / (end - start);
    }
  } else {
    for (let i = 0; i < outputLength; i += 1) {
      const position = i * ratio;
      const left = Math.floor(position);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = position - left;
      output[i] = input[left] * (1 - fraction) + input[right] * fraction;
    }
  }
  return output;
}

function mergeChunks(chunks, length) {
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function rmsOf(samples) {
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i];
  return Math.sqrt(energy / Math.max(1, samples.length));
}

function normalizeVoicePreset(value) {
  return ['gentle', 'balanced', 'strong'].includes(value) ? value : 'balanced';
}

function voiceControlLabel(state) {
  if (!state?.voiceEnhance) return '';
  const preset = self.BscgVoiceDsp?.PRESETS?.[state.voiceEnhancePreset];
  return ` · 远场控制/${preset?.label || '平衡'}`;
}

function ensureVoiceProcessor(state, sampleRate) {
  if (!state?.voiceEnhance) return null;
  if (!self.BscgVoiceDsp?.createProcessor || !self.BscgVoiceDsp?.processVoiceChunk) {
    throw new Error('远场音频控制器未加载');
  }
  const rate = Number(sampleRate) || TARGET_SAMPLE_RATE;
  if (!state.voiceProcessor || state.voiceProcessor.sampleRate !== rate) {
    state.voiceProcessor = self.BscgVoiceDsp.createProcessor(rate, state.voiceEnhancePreset);
  }
  state.metrics.voiceEnhance = true;
  state.metrics.voiceEnhancePreset = state.voiceEnhancePreset;
  return state.voiceProcessor;
}

function processCapturedVoice(state, samples) {
  const processor = ensureVoiceProcessor(state, state.inputRate);
  return processor ? self.BscgVoiceDsp.processVoiceChunk(processor, samples) : samples;
}

async function processDirectVoice(state) {
  if (!state.voiceEnhance || !state.directAudio?.length) return;
  await processDirectVoiceBuffer(state, state.directAudio);
}

async function processDirectVoiceBuffer(state, audio, quiet = false) {
  if (!state.voiceEnhance || !audio?.length) return audio;
  if (!self.BscgVoiceDsp?.createProcessor || !self.BscgVoiceDsp?.processVoiceChunk) {
    throw new Error('远场音频控制器未加载');
  }
  const processor = self.BscgVoiceDsp.createProcessor(TARGET_SAMPLE_RATE, state.voiceEnhancePreset);
  state.metrics.voiceEnhance = true;
  state.metrics.voiceEnhancePreset = state.voiceEnhancePreset;
  const startedAt = performance.now();
  const blockSamples = TARGET_SAMPLE_RATE;
  if (!quiet) {
    state.statusText = `正在执行远场音频控制（${self.BscgVoiceDsp.PRESETS[state.voiceEnhancePreset].label}）…`;
    sendEvent(state, 'status');
  }
  for (let offset = 0, block = 0; offset < audio.length; offset += blockSamples, block += 1) {
    if (activeSession !== state || state.stopping) return audio;
    const end = Math.min(audio.length, offset + blockSamples);
    const processed = self.BscgVoiceDsp.processVoiceChunk(processor, audio.subarray(offset, end));
    audio.set(processed, offset);
    if (block > 0 && block % 30 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  state.metrics.voiceDspMs = performance.now() - startedAt;
  return audio;
}

function estimateVideoTime(state, now = performance.now()) {
  const clock = state.clock;
  if (!clock) return state.sourceMode === 'direct' ? 0 : (state.metrics.capturedAudioSeconds || 0);
  if (clock.paused) return clock.currentTime;
  const elapsed = Math.max(0, now - clock.receivedAt) / 1000;
  return Math.max(0, clock.currentTime + elapsed * clock.playbackRate);
}

function initialCaptureClock(value) {
  if (!Number.isFinite(value?.currentTime)) return null;
  return {
    currentTime: Math.max(0, value.currentTime), duration: Math.max(0, Number(value.duration) || 0),
    playbackRate: Math.max(0.1, Number(value.playbackRate) || 1), paused: Boolean(value.paused),
    receivedAt: performance.now()
  };
}

function phraseWindowSeconds(state) {
  const ceiling = state?.asrProfile === 'sensevoice_browser'
    ? SENSEVOICE_MAX_PHRASE_SECONDS
    : MAX_PHRASE_SECONDS;
  return Math.max(4, Math.min(ceiling, Number(state?.maxPhraseSeconds) || ceiling));
}

function phraseEndpointReason(state, phraseSeconds, silenceSeconds) {
  const senseVoice = state?.asrProfile === 'sensevoice_browser';
  const normalSeconds = senseVoice ? SENSEVOICE_NORMAL_ENDPOINT_SECONDS : QWEN_NORMAL_ENDPOINT_SECONDS;
  const normalSilence = senseVoice ? SENSEVOICE_NORMAL_SILENCE_SECONDS : QWEN_NORMAL_SILENCE_SECONDS;
  if (phraseSeconds >= normalSeconds && silenceSeconds >= normalSilence) return 'silence';
  if (phraseSeconds >= SHORT_ENDPOINT_SECONDS && silenceSeconds >= STRONG_SILENCE_SECONDS) return 'strong-silence';
  return '';
}

function resetPhrase(state) {
  state.phraseChunks = [];
  state.phraseSamples = 0;
  state.phraseStartVideo = null;
  state.phraseEndVideo = null;
  state.lastPreviewSamples = 0;
  state.activePhraseToken = null;
  state.phraseVoiced = false;
  state.phraseVoicedSamples = 0;
  state.silenceSamples = 0;
}

function commonPreviewPrefix(left, right) {
  const first = Array.from(cleanText(left));
  const second = Array.from(cleanText(right));
  let length = 0;
  while (length < first.length && length < second.length && first[length] === second[length]) length += 1;
  if (length < 4) return '';
  const prefix = first.slice(0, length);
  // Do not mark the currently growing word/phrase tail as stable. Prefer a
  // punctuation boundary; otherwise retain a two-character correction margin.
  for (let index = prefix.length - 1; index >= 3; index -= 1) {
    if (/[\s，,。.!！？?；;：:、]/u.test(prefix[index])) return prefix.slice(0, index + 1).join('').trim();
  }
  return prefix.slice(0, Math.max(0, prefix.length - 2)).join('').trim();
}

function clearPreviewCue(state, event = 'preview-cleared') {
  if (!state?.previewCue) return false;
  const previewId = state.previewCue.id || '';
  const previewRevision = Number(state.previewCue.revision) || 0;
  state.previewCue = null;
  sendEvent(state, event, { previewId, previewRevision });
  return true;
}

function trimPreRoll(state) {
  const maxSamples = Math.round(state.inputRate * PRE_ROLL_SECONDS);
  let total = state.preRoll.reduce((sum, chunk) => sum + chunk.length, 0);
  while (state.preRoll.length > 1 && total - state.preRoll[0].length >= maxSamples) {
    total -= state.preRoll.shift().length;
  }
  if (total > maxSamples && state.preRoll.length) {
    const last = state.preRoll[state.preRoll.length - 1];
    state.preRoll = [last.slice(Math.max(0, last.length - maxSamples))];
  }
}

function warmupTiming(state) {
  return {
    currentTime: estimateVideoTime(state),
    playbackRate: Math.max(0.1, Number(state.clock?.playbackRate) || 1),
    paused: Boolean(state.clock?.paused)
  };
}

function bufferWarmupAudio(state, samples, capturedTiming = null) {
  const copy = samples.slice();
  state.warmupChunks ||= [];
  state.warmupSamples = (Number(state.warmupSamples) || 0) + copy.length;
  const timing = capturedTiming ? { ...capturedTiming } : warmupTiming(state);
  if (!state.clock && !capturedTiming) {
    state.warmupMediaSeconds = (Number(state.warmupMediaSeconds) || 0) +
      copy.length / state.inputRate * timing.playbackRate;
    timing.currentTime = state.warmupMediaSeconds;
  }
  state.warmupChunks.push({ samples: copy, timing });
  const maximum = Math.max(1, Math.round(state.inputRate * MODEL_WARMUP_BUFFER_SECONDS));
  while (state.warmupChunks.length > 1 && state.warmupSamples > maximum) {
    state.warmupSamples -= state.warmupChunks.shift().samples.length;
    state.metrics.modelWarmupDropped = true;
  }
  state.metrics.modelWarmupBufferedSeconds = state.warmupSamples / state.inputRate;
}

async function drainWarmupAudio(state) {
  if (state.drainingWarmup) return;
  state.drainingWarmup = true;
  let count = 0;
  try {
    while (state.warmupChunks?.length && activeSession === state && !state.stopping && state.modelReady) {
      // A 90-second cold-start buffer must not be dumped into a 65-second
      // inference queue at once. New live PCM joins the same ordered buffer.
      if (state.metrics.queuedAudioSeconds >= MAX_QUEUED_AUDIO_SECONDS - phraseWindowSeconds(state) - 1) {
        await new Promise((resolve) => { state.warmupDrainResume = resolve; });
        continue;
      }
      const chunk = state.warmupChunks.shift();
      state.warmupSamples = Math.max(0, state.warmupSamples - chunk.samples.length);
      state.metrics.modelWarmupBufferedSeconds = state.warmupSamples / state.inputRate;
      if (chunk.boundary) {
        await flushPhrase(state, 'live-interruption');
        state.preRoll = [];
        continue;
      }
      handleAudioChunk(state, chunk.samples, chunk.timing, true);
      if (++count % 40 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    state.drainingWarmup = false;
    state.warmupDrainResume = null;
  }
}

function resumeWarmupDrain(state) {
  const resume = state.warmupDrainResume;
  state.warmupDrainResume = null;
  resume?.();
}

function handleAudioChunk(state, samples, capturedTiming = null, replayingWarmup = false) {
  if (activeSession !== state || state.stopping || !state.acceptAudio) return;
  const vadFrameSamples = Math.max(1, Math.round(state.inputRate * 0.02));
  if (samples.length > vadFrameSamples && state.modelReady && (!state.drainingWarmup || replayingWarmup)) {
    // In-page transport batches ~200ms, whereas tabCapture sends ~43ms. VAD
    // must see the same 20ms windows: averaging a whole transport packet hides
    // short pauses and lets speech at its edge mark all 200ms as voiced.
    const timing = capturedTiming || {
      currentTime: state.clock ? estimateVideoTime(state)
        : (state.metrics.capturedAudioSeconds || 0) + samples.length / state.inputRate,
      playbackRate: Math.max(0.1, Number(state.clock?.playbackRate) || 1),
      paused: Boolean(state.clock?.paused)
    };
    for (let offset = 0; offset < samples.length; offset += vadFrameSamples) {
      const end = Math.min(samples.length, offset + vadFrameSamples);
      handleAudioChunk(state, samples.subarray(offset, end), {
        ...timing, currentTime: Math.max(0, timing.currentTime -
          (samples.length - end) / state.inputRate * timing.playbackRate)
      }, replayingWarmup);
    }
    return;
  }
  if (state.isLive && !replayingWarmup) {
    // Live media time may jump backwards whenever MSE reconnects. All capture
    // adapters use the same accumulated PCM timeline, starting at zero.
    const paused = state.clockIndependent ? false : capturedTiming ? Boolean(capturedTiming.paused) : Boolean(state.clock?.paused);
    state.liveAudioSeconds = (Number(state.liveAudioSeconds) || 0) + (paused ? 0 : samples.length / state.inputRate);
    capturedTiming = { currentTime: state.liveAudioSeconds, playbackRate: 1, paused };
  }
  if (!state.modelReady || (state.drainingWarmup && !replayingWarmup)) {
    bufferWarmupAudio(state, samples, capturedTiming);
    return;
  }
  // After a rewind, a cached utterance already owns this interval. Resume audio
  // at its end instead of recognizing a fragment starting in its middle.
  if (!state.isLive && state.captureCachedThrough > 0) {
    const end = Number.isFinite(capturedTiming?.currentTime) ? capturedTiming.currentTime : estimateVideoTime(state);
    const rate = Math.max(0.1, Number(capturedTiming?.playbackRate) || Number(state.clock?.playbackRate) || 1);
    if (end <= state.captureCachedThrough) return;
    const remaining = Math.round((end - state.captureCachedThrough) / rate * state.inputRate);
    if (remaining < samples.length) samples = samples.subarray(samples.length - Math.max(0, remaining));
    state.captureCachedThrough = 0;
    if (!samples.length) return;
  }
  const duration = samples.length / state.inputRate;
  state.metrics.capturedAudioSeconds += duration;
  const timelineNow = Number.isFinite(capturedTiming?.currentTime)
    ? Math.max(0, Number(capturedTiming.currentTime))
    : estimateVideoTime(state);
  const timelineRate = Math.max(0.1, Number(capturedTiming?.playbackRate) || Number(state.clock?.playbackRate) || 1);
  const timelinePaused = capturedTiming ? Boolean(capturedTiming.paused) : Boolean(state.clock?.paused);
  const lastTiming = state.lastCaptureTiming;
  if (lastTiming && !timelinePaused &&
      Math.abs(timelineNow - lastTiming.currentTime - duration * timelineRate) > 1.6) {
    void flushPhrase(state, 'discontinuity', lastTiming.currentTime);
    state.preRoll = [];
    clearPreviewCue(state);
  }
  state.lastCaptureTiming = { currentTime: timelineNow, playbackRate: timelineRate, paused: timelinePaused };

  if (timelinePaused) {
    state.preRoll = [];
    if (state.phraseSamples && state.phraseVoiced) void flushPhrase(state, 'pause', state.phraseEndVideo ?? timelineNow);
    else {
      resetPhrase(state);
      clearPreviewCue(state);
    }
    return;
  }

  if (!Number.isFinite(state.metrics.firstCapturedVideoTime)) {
    state.metrics.firstCapturedVideoTime = Math.max(0, timelineNow - duration * timelineRate);
  }

  try {
    samples = processCapturedVoice(state, samples);
  } catch (error) {
    void failSession(state, error);
    return;
  }

  const rms = rmsOf(samples);
  if (!state.phraseVoiced && rms < 0.025) {
    state.noiseFloor = state.noiseFloor * 0.96 + rms * 0.04;
  }
  const threshold = Math.max(0.004, Math.min(0.028, state.noiseFloor * 2.8 + 0.0015));
  const voiced = rms >= threshold;

  if (!state.phraseSamples && !voiced) {
    state.preRoll.push(samples);
    trimPreRoll(state);
    return;
  }

  if (!state.phraseSamples && voiced) {
    const preSamples = state.preRoll.reduce((sum, chunk) => sum + chunk.length, 0);
    state.phraseChunks = [...state.preRoll, samples];
    state.phraseSamples = preSamples + samples.length;
    const offsetSeconds = state.phraseSamples / state.inputRate * timelineRate;
    state.phraseStartVideo = Math.max(0, timelineNow - offsetSeconds);
    state.activePhraseToken = ++state.phraseTokenSequence;
    state.preRoll = [];
    state.phraseVoiced = true;
    state.phraseVoicedSamples = samples.length;
    state.silenceSamples = 0;
  } else {
    state.phraseChunks.push(samples);
    state.phraseSamples += samples.length;
    if (voiced) {
      state.phraseVoiced = true;
      state.phraseVoicedSamples = (state.phraseVoicedSamples || 0) + samples.length;
      state.silenceSamples = 0;
    } else {
      state.silenceSamples += samples.length;
    }
  }

  state.phraseEndVideo = timelineNow;
  const phraseSeconds = state.phraseSamples / state.inputRate;
  const silenceSeconds = state.silenceSamples / state.inputRate;
  const maxPhraseSeconds = phraseWindowSeconds(state);
  const endpointReason = phraseEndpointReason(state, phraseSeconds, silenceSeconds);
  if (endpointReason || phraseSeconds >= maxPhraseSeconds) {
    void flushPhrase(state, phraseSeconds >= maxPhraseSeconds ? 'max-window' : endpointReason, timelineNow);
  } else {
    void submitPreview(state, timelineNow);
  }
}

function handleRestoredScanAudio(state, samples, timing) {
  // Keep VAD and the Qwen encoder window measured in original media seconds,
  // even when one 8x callback contains several hundred milliseconds of speech.
  for (let offset = 0; offset < samples.length; offset += 320) {
    const end = Math.min(samples.length, offset + 320);
    handleAudioChunk(state, samples.subarray(offset, end), {
      ...timing, playbackRate: 1,
      currentTime: Math.max(0, timing.currentTime - (samples.length - end) / TARGET_SAMPLE_RATE)
    });
  }
}

function receiveTabAudio(state, samples) {
  if (!state.scanMode) { handleAudioChunk(state, samples); return; }
  if (!state.scanReady || state.stopping) return;
  const clock = state.clock;
  const paused = !state.captureEnding && Boolean(clock?.paused);
  const timing = {
    currentTime: state.captureEnding ? state.captureEndTime : estimateVideoTime(state),
    playbackRate: 1, paused, speedRestored: true
  };
  if (paused) { handleAudioChunk(state, new Float32Array(0), timing); return; }
  if (Math.abs((clock?.playbackRate || 1) - state.scanPlaybackRate) > 0.05 ||
      (state.scanPlaybackRate !== 1 && clock?.preservesPitch !== false)) {
    void failSession(state, engineError('扫描倍速或保调状态发生变化，已停止；请用 1× 重新识别', 'CAPTURE_RATE_UNSUPPORTED'));
    return;
  }
  state.captureResampler ||= self.BscgCaptureAudio.createResampler(state.captureSourceRate, state.scanPlaybackRate);
  const restored = state.captureResampler.process(samples);
  state.metrics.captureWallSeconds = (state.metrics.captureWallSeconds || 0) + samples.length / state.captureSourceRate;
  state.metrics.restoredPlaybackRate = state.scanPlaybackRate;
  if (restored.length) handleRestoredScanAudio(state, restored, timing);
}

function prepareScanCapture(message) {
  const state = activeSession;
  if (!state?.scanMode || state.sessionId !== message.sessionId || state.stopping || !state.modelReady) {
    return { ok: false, error: '扫描识别任务未就绪或已经停止' };
  }
  const rate = Number(message.playbackRate);
  if (!(rate >= 1 && rate <= 8) || (rate !== 1 && message.preservesPitch !== false)) {
    return { ok: false, error: '播放器未允许关闭保调，无法恢复倍速音频' };
  }
  state.scanPlaybackRate = rate;
  state.scanReady = true;
  state.captureResampler = null;
  resetCaptureTimeline(state);
  try { state.worklet?.port.postMessage({ type: 'reset' }); } catch {}
  state.clock = initialCaptureClock({ ...message, paused: false });
  state.clock.preservesPitch = message.preservesPitch;
  state.metrics.restoredPlaybackRate = rate;
  return { ok: true };
}

async function submitPreview(state, previewEndTime = null) {
  if (state.stopping || !state.modelReady || state.drainingWarmup || state.captureInFlightPhraseId) return false;
  if (state.sourceMode !== 'capture' || state.previewEnabled === false || state.previewInFlight || !state.activePhraseToken) return false;
  if (state.pending.size) return false;
  // A slow backend still gets one early draft, but does not spend the whole
  // phrase re-running drafts that would delay the higher-priority final job.
  if (state.previewThrottleToken === state.activePhraseToken) return false;
  if (state.previewCountToken !== state.activePhraseToken) {
    state.previewCountToken = state.activePhraseToken;
    state.previewCountForToken = 0;
  }
  const qwen = state.asrProfile === 'qwen3_asr_0_6b';
  if (state.previewCountForToken >= (qwen ? 3 : PREVIEW_MAX_REVISIONS)) return false;
  if (state.previewCountForToken > 0 && Number(state.metrics.previewRtf) >= 1) return false;
  const phraseSeconds = state.phraseSamples / state.inputRate;
  if (phraseSeconds < PREVIEW_MIN_SECONDS) return false;
  // Pre-roll and trailing silence must not qualify a tiny interjection for
  // speculative recognition. Finals still retain short meaningful replies.
  if (Number(state.phraseVoicedSamples) / state.inputRate < 0.5) return false;
  const previewRtf = Math.max(0, Number(state.metrics.previewRtf) || 0);
  const adaptiveGap = Math.max(PREVIEW_INTERVAL_SECONDS, Math.min(
    PREVIEW_MAX_INTERVAL_SECONDS,
    PREVIEW_INTERVAL_SECONDS + previewRtf * Math.min(4, Math.max(1, phraseSeconds))
  ));
  const requiredGap = state.lastPreviewSamples ? adaptiveGap : PREVIEW_MIN_SECONDS;
  state.metrics.previewCadenceSeconds = requiredGap;
  if (state.phraseSamples - state.lastPreviewSamples < state.inputRate * requiredGap) return false;

  const source = mergeChunks(state.phraseChunks, state.phraseSamples);
  const audio = resampleTo16k(source, state.inputRate);
  const previewRevision = ++state.previewRevisionSequence;
  state.previewInFlight = true;
  state.previewCountForToken += 1;
  state.lastPreviewSamples = state.phraseSamples;
  postWorkerMessage(state, 'transcribe', {
    sessionId: state.sessionId,
    phraseId: 0,
    stream: true,
    preview: true,
    previewToken: state.activePhraseToken,
    previewRevision,
    previewStartVideo: state.phraseStartVideo,
    previewEndVideo: Math.max(
      state.phraseStartVideo + 0.2,
      Number.isFinite(previewEndTime) ? Number(previewEndTime) : estimateVideoTime(state)
    ),
    audio: audio.buffer
  }, [audio.buffer]);
  return true;
}

async function flushPhrase(state, reason = 'manual', capturedEndTime = null) {
  if (!state.phraseSamples || !state.phraseVoiced) {
    resetPhrase(state);
    return false;
  }
  const chunks = state.phraseChunks;
  const sampleCount = state.phraseSamples;
  const startVideo = Number.isFinite(state.phraseStartVideo) ? state.phraseStartVideo : estimateVideoTime(state);
  const endVideo = Math.max(
    startVideo + 0.2,
    Number.isFinite(capturedEndTime) ? Number(capturedEndTime) : (state.phraseEndVideo ?? estimateVideoTime(state))
  );
  const phraseToken = state.activePhraseToken;
  const endpointAt = Date.now();
  const trailingSilenceMs = state.silenceSamples / state.inputRate * 1000;
  const voicedMs = (state.phraseVoicedSamples || 0) / state.inputRate * 1000;
  resetPhrase(state);
  state.lastPreviewSamples = 0;

  const source = mergeChunks(chunks, sampleCount);
  const audio = resampleTo16k(source, state.inputRate);
  const audioSeconds = audio.length / TARGET_SAMPLE_RATE;
  if (audioSeconds < 0.4) {
    clearPreviewCue(state);
    return false;
  }

  const phraseId = ++state.phraseSequence;
  state.pending.set(phraseId, {
    phraseId, startVideo, endVideo, audioSeconds, reason, phraseToken, endpointAt, trailingSilenceMs, voicedMs,
    previewText: state.previewCue?.token === phraseToken ? state.previewCue.text : '',
    // Keep at most MAX_QUEUED_AUDIO_SECONDS of retry PCM. The transferred
    // buffer is detached, so WebGPU -> CPU recovery needs a separate copy.
    retryAudio: audio.slice()
  });
  // The final pass owns the full utterance. Stop an obsolete Qwen draft at the
  // next decode boundary, retaining its last visible text until finalization.
  if (state.previewInFlight && state.asrProfile === 'qwen3_asr_0_6b') {
    asrWorker?.postMessage({ type: 'qwen-cancel-preview', sessionId: state.sessionId });
  }
  state.metrics.queueLength = state.pending.size;
  state.metrics.queuedAudioSeconds = [...state.pending.values()].reduce((sum, item) => sum + item.audioSeconds, 0);
  state.statusText = `正在识别第 ${phraseId} 段（${audioSeconds.toFixed(1)} 秒音频）…`;
  sendEvent(state, 'running');

  if (state.metrics.queuedAudioSeconds > MAX_QUEUED_AUDIO_SECONDS) {
    void failSession(state, new Error('识别速度长期跟不上视频，待处理音频超过 65 秒；已停止以保护内存。'));
    return false;
  }

  // 高倍速总结扫描可以快于模型，但不能无限堆积。积压到阈值时暂停扫描
  // 播放器，消化到低水位后再恢复；普通实时字幕从不控制页面播放。
  if (state.sourceMode === 'capture' && state.scanMode &&
      !state.scanFlowPaused && state.metrics.queuedAudioSeconds >= SCAN_QUEUE_PAUSE_SECONDS) {
    state.scanFlowPaused = true;
    state.statusText = `扫描音频已领先识别 ${state.metrics.queuedAudioSeconds.toFixed(1)} 秒，暂缓播放器以消化队列。`;
    sendEvent(state, 'pause-for-model', { statusText: state.statusText });
  }

  dispatchNextCapturePhrase(state);
  return true;
}

function dispatchNextCapturePhrase(state) {
  if (activeSession !== state || state.sourceMode !== 'capture' || !state.modelReady ||
      state.previewInFlight || state.captureInFlightPhraseId) return;
  const pending = state.pending.values().next().value;
  if (!pending?.retryAudio?.length) return;
  const audio = pending.retryAudio.slice();
  state.captureInFlightPhraseId = pending.phraseId;
  pending.dispatchedAt = Date.now();
  postWorkerMessage(state, 'transcribe', {
    sessionId: state.sessionId, phraseId: pending.phraseId, audio: audio.buffer,
    stream: state.previewEnabled !== false
  }, [audio.buffer]);
}

function cleanText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').replace(/<\|[^|]+\|>/g, '').trim();
  return /[\u3040-\u30ff]/u.test(value)
    ? value.replace(/([\p{Script=Han}\u3040-\u30ff]) +(?=[\p{Script=Han}\u3040-\u30ff])/gu, '$1') : value;
}

// ── 静音幻觉（幽灵短语）拦截 ────────────────────────────────────────────────
// SenseVoice 在纯静音/噪声/极短人声上会吐出训练语料里的固定短语。0.16.36 实机日志
// （omgjav.com 日语访谈，voicedMs 20–1320ms）里"整句"出现的只有这几个：
//   The. / Yeah. / Oh. / Magic again. / Mジ game. / 系y。
// 它们全部落在 voicedMs < 1.5s（或音频 < 2.5s）的 strong-silence / pause 段上，
// 与"用户真的说了个英文单词"无关。判定必须同时满足"文本命中白名单"+"段确实很短"，
// 才既能杀掉幻觉，又不会误伤真实存在的日语短应答（はい / うん / ちょっと）。
const PHANTOM_FINAL_TEXTS = new Set([
  'the', 'yeah', 'yea', 'yep', 'oh', 'ohh', 'ah', 'ahh',
  'magicagain', 'mジgame', 'mjgame', '系y'
]);
const PHANTOM_MAX_VOICED_MS = 1500;
const PHANTOM_MAX_AUDIO_SECONDS = 2.5;

function phantomFinalKey(text) {
  // 去空白、去标点/符号后小写比较："The." / "the" / "T.h.e" 都归一为 "the"。
  return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

// 0ms 是有效人声测量；只有缺少测量时才用音频时长。两项未知时不推断短段。
function phantomFinalText(text, voicedMs, audioSeconds) {
  const key = phantomFinalKey(text);
  if (!key || key.length > 14 || !PHANTOM_FINAL_TEXTS.has(key)) return '';
  const hasVoiced = voicedMs != null && voicedMs !== '';
  const voiced = Number(voicedMs);
  const seconds = Number(audioSeconds);
  const short = hasVoiced
    ? Number.isFinite(voiced) && voiced >= 0 && voiced < PHANTOM_MAX_VOICED_MS
    : audioSeconds != null && audioSeconds !== '' && Number.isFinite(seconds) && seconds > 0 && seconds < PHANTOM_MAX_AUDIO_SECONDS;
  return short ? String(text).trim() : '';
}

function splitCaptionText(text, maximumCharacters = 18) {
  const remaining = Array.from(cleanText(text));
  const parts = [];
  const softBoundary = /[\s，,。.!！？?；;：:、]/u;
  while (remaining.length > maximumCharacters) {
    let cut = maximumCharacters;
    const minimumCut = Math.max(8, Math.floor(maximumCharacters * 0.55));
    for (let index = maximumCharacters - 1; index >= minimumCut; index -= 1) {
      if (softBoundary.test(remaining[index])) {
        cut = index + 1;
        break;
      }
    }
    const part = remaining.splice(0, cut).join('').trim();
    if (part) parts.push(part);
  }
  const tail = remaining.join('').trim();
  if (tail) parts.push(tail);
  return parts;
}

function addResultCues(state, pending, message) {
  const resultCues = [];
  const audioSeconds = Math.max(0.1, Number(message.audioSeconds) || pending.audioSeconds);
  const videoSpan = Math.max(0, pending.endVideo - pending.startVideo);
  const scale = videoSpan / audioSeconds;
  const chunks = Array.isArray(message.chunks) && message.chunks.some((chunk) => cleanText(chunk.text))
    ? message.chunks
    : [{ text: message.text, timestamp: [0, audioSeconds] }];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const text = cleanText(chunk.text);
    if (!text) continue;
    const stamp = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
    const relativeStart = Number.isFinite(stamp[0]) ? Math.max(0, stamp[0]) : 0;
    let relativeEnd = Number.isFinite(stamp[1]) && stamp[1] > relativeStart ? stamp[1] : null;
    if (relativeEnd === null) {
      const nextStart = chunks[index + 1]?.timestamp?.[0];
      relativeEnd = Number.isFinite(nextStart) && nextStart > relativeStart ? nextStart : audioSeconds;
    }
    const chunkFrom = pending.startVideo + Math.min(audioSeconds, relativeStart) * scale;
    const chunkTo = Math.min(pending.endVideo, pending.startVideo + Math.min(audioSeconds, relativeEnd) * scale);
    if (chunkTo <= chunkFrom) continue;
    // Only ASR/audio timestamps are authoritative. Character-count splitting
    // invents alignment and can send half of a Japanese predicate to translation.
    const duplicate = state.cues.find(cue => cue.text === text && Math.abs(cue.from - chunkFrom) < 0.05);
    const cue = duplicate || { from: chunkFrom, to: chunkTo, text };
    resultCues.push(cue);
    if (!duplicate) state.cues.push(cue);
  }
  state.cues.sort((a, b) => a.from - b.from || a.to - b.to);
  return resultCues;
}

function handleTranscriptionResult(message) {
  const state = activeSession;
  if (!state || message.sessionId !== state.sessionId) return;
  if (!message.partial) finishInferenceWatchdog(state, message);
  if (message.preview) {
    if (!message.partial) state.previewInFlight = false;
    const token = message.previewToken;
    const stillRelevant = state.activePhraseToken === token || [...state.pending.values()].some((item) => item.phraseToken === token);
    const text = cleanText(message.text);
    if (message.partial && state.previewCue?.token === token && text.length < state.previewCue.text.length) return;
    const seconds = Number(message.audioSeconds) || 0;
    const inferenceMs = Number(message.inferenceMs) || 0;
    if (stillRelevant && seconds > 0) {
      state.metrics.lastRtf = inferenceMs / 1000 / seconds;
      state.metrics.previewRtf = state.metrics.lastRtf;
      state.metrics.previewSlow = Number(state.metrics.previewRtf) >= 1;
    }
    if (stillRelevant && text) {
      const waiting = [...state.pending.values()].find((item) => item.phraseToken === token);
      if (waiting) waiting.previewText = text;
      const previousText = state.previewHypothesisToken === token ? state.previewHypothesisText : '';
      const stableText = commonPreviewPrefix(previousText, text);
      if (!message.partial && state.activePhraseToken === token) {
        state.previewHypothesisToken = token;
        state.previewHypothesisText = text;
      }
      state.previewCue = {
        token,
        id: `phrase:${token}`,
        revision: state.previewDisplayRevision = (state.previewDisplayRevision || 0) + 1,
        from: Math.max(0, Number(message.previewStartVideo) || 0),
        to: Math.max(Number(message.previewStartVideo) + 0.25, Number(message.previewEndVideo) || 0.25),
        text,
        stableText
      };
      state.statusText = '实时字幕中；停顿后整句定稿。';
      sendEvent(state, 'running', message.partial ? { partialOnly: true } : {});
    }
    if (message.partial) return;
    dispatchNextCapturePhrase(state);
    if (state.activePhraseToken === token) void submitPreview(state);
    return;
  }
  const pending = state.pending.get(message.phraseId);
  if (state.directInFlightPhraseId === message.phraseId) state.directInFlightPhraseId = null;
  if (state.captureInFlightPhraseId === message.phraseId) state.captureInFlightPhraseId = null;
  if (!pending) {
    if (state.sourceMode === 'direct') dispatchNextDirectSegment(state);
    else dispatchNextCapturePhrase(state);
    return;
  }
  state.consecutiveInferenceErrors = 0;
  state.pending.delete(message.phraseId);
  const matchingPreview = !pending.direct && state.previewCue &&
    state.previewCue.token === pending.phraseToken ? state.previewCue : null;
  // 静音幻觉：整段丢弃，不入 cues、不上屏、不翻译。屏幕上若已有同句草稿一并撤下，
  // 否则"没说话时"会留下一行 The.。丢弃后仍走完后面的队列调度，保证链路不卡住。
  const phantom = phantomFinalText(message.text, pending.voicedMs, pending.audioSeconds);
  let phantomPreviewRetracted = false;
  if (phantom) {
    // 只撤下"确实是这一次幻觉"的草稿：属于同一 phrase token，或本身也是幽灵短语。
    // 不能无条件清空，否则会误删下一条句子的正常草稿。
    const preview = state.previewCue;
    const previewIsPhantom = preview && PHANTOM_FINAL_TEXTS.has(phantomFinalKey(preview.text));
    if (preview && (preview.token === pending.phraseToken || previewIsPhantom)) {
      state.previewCue = null;
      phantomPreviewRetracted = true;
    }
    state.metrics.phantomFinals = (Number(state.metrics.phantomFinals) || 0) + 1;
    sendEvent(state, 'phantom-dropped', {
      phraseToken: pending.phraseToken, phantomText: phantom,
      voicedMs: Math.round(Number(pending.voicedMs) || 0),
      audioSeconds: Number((Number(pending.audioSeconds) || 0).toFixed(1)),
      reason: pending.reason || '', previewRetracted: phantomPreviewRetracted
    });
  }
  const previewFallback = phantom ? '' : (matchingPreview
    ? cleanText(matchingPreview.text)
    : cleanText(pending.previewText));
  if (matchingPreview) state.previewCue = null;
  const cuesBeforeFinal = state.cues.length;
  const resultCues = phantom ? [] : addResultCues(state, pending, message);
  // 短句或弱音量下，最终长窗口偶尔会返回空文本。已有非空草稿时将它按
  // 同一时间范围定稿，避免用户刚看到的句子凭空消失。
  if (!phantom && !pending.direct && previewFallback && state.cues.length === cuesBeforeFinal) {
    resultCues.push(...addResultCues(state, pending, {
      text: previewFallback,
      audioSeconds: pending.audioSeconds,
      chunks: []
    }));
    state.metrics.previewPromotedToFinal = (Number(state.metrics.previewPromotedToFinal) || 0) + 1;
  }
  const finalText = phantom ? '' : (cleanText(message.text) || previewFallback);
  if (!pending.direct && !state.scanMode && finalText) {
    const timedSegments = resultCues
      .map(cue => ({ from: cue.from, to: cue.to, content: cue.text }));
    state.finalCue = {
      id: `phrase:${pending.phraseToken}`, from: pending.startVideo, to: pending.endVideo,
      timedSegments,
      content: finalText, revision: (state.finalCue?.revision || 0) + 1,
      // 断句原因（silence/strong-silence/max-window/pause）与短语音频时长：
      // background 侧记入 [asr/final] 日志后剥离，不进字幕导出。
      reason: pending.reason || '', audioSeconds: Number(pending.audioSeconds) || 0,
      asrReadyAt: Date.now(),
      timing: { voicedMs: Math.round(pending.voicedMs || 0), endpointWaitMs: Math.round(pending.trailingSilenceMs || 0),
        asrQueueMs: Math.max(0, (pending.dispatchedAt || Date.now()) - (pending.endpointAt || Date.now())),
        asrWallMs: Math.max(0, Date.now() - (pending.dispatchedAt || Date.now())),
        inferenceMs: Math.round(Number(message.inferenceMs) || 0) }
    };
  }
  if (pending.direct) {
    state.directCompletedThrough = Math.max(state.directCompletedThrough, pending.endVideo);
    state.metrics.recognizedTo = state.directCompletedThrough;
    maybeResumeDirectPlayback(state);
  }

  const inferenceMs = Number(message.inferenceMs) || 0;
  const audioSeconds = Number(message.audioSeconds) || pending.audioSeconds;
  state.metrics.totalInferenceMs += inferenceMs;
  state.metrics.totalInferredAudioSeconds += audioSeconds;
  state.metrics.lastRtf = audioSeconds > 0 ? inferenceMs / 1000 / audioSeconds : 0;
  state.metrics.avgRtf = state.metrics.totalInferredAudioSeconds > 0
    ? state.metrics.totalInferenceMs / 1000 / state.metrics.totalInferredAudioSeconds
    : 0;
  state.metrics.queueLength = state.pending.size;
  state.metrics.queuedAudioSeconds = [...state.pending.values()].reduce((sum, item) => sum + item.audioSeconds, 0);
  resumeWarmupDrain(state);
  state.metrics.backend = message.backend || state.metrics.backend;
  Object.assign(state.metrics, message.metrics || {}, visibleHeap());
  state.statusText = state.stopping
    ? `停止中：还剩 ${state.pending.size} 段…`
    : state.sourceMode === 'direct'
      ? `音轨前瞻：已完成 ${state.directIndex || 0}/${state.directSegments?.length || 0} 段。`
      : `已输出 ${state.cues.length} 条字幕；继续捕获中。`;
  const resumeScan = !state.stopping && state.sourceMode === 'capture' &&
    state.scanMode && state.scanFlowPaused &&
    state.metrics.queuedAudioSeconds <= SCAN_QUEUE_RESUME_SECONDS;
  if (resumeScan) {
    state.scanFlowPaused = false;
    state.statusText = `识别队列已降至 ${state.metrics.queuedAudioSeconds.toFixed(1)} 秒，继续高倍速扫描。`;
  }
  sendEvent(state, resumeScan ? 'resume-after-model' : (state.stopping ? 'stopping' : 'running'));
  void updateResourceMetrics(state, true);

  if (state.stopping && state.pending.size === 0) {
    finalizeStopped(state);
  } else if (state.sourceMode === 'direct') {
    dispatchNextDirectSegment(state);
  } else {
    dispatchNextCapturePhrase(state);
    void submitPreview(state);
  }
}

function startRuntimeCpuFallback(state, error) {
  if (state.stopping || state.asrProfile !== 'sensevoice_browser' || state.backendMode === 'wasm' || state.runtimeFallbackTried) return false;
  state.runtimeFallbackTried = true;
  state.backendMode = 'wasm';
  const bufferLiveAudio = state.sourceMode === 'capture' && !state.scanMode;
  state.modelReady = false;
  state.acceptAudio = bufferLiveAudio;
  state.status = 'loading';
  state.statusText = `WebGPU 推理执行失败，正在降级到 INT8/WASM CPU：${errorText(error)}`;
  sendEvent(state, 'fallback', { from: 'webgpu', to: 'wasm', fallbackError: errorText(error) });
  sendEvent(state, state.scanMode ? 'pause-for-model' : 'status', { statusText: state.statusText });
  terminateInferenceWorker();
  initWaiter = null;
  state.directInFlightPhraseId = null;
  state.captureInFlightPhraseId = null;
  state.previewInFlight = false;
  resumeWarmupDrain(state);

  const fallbackPromise = initializeModel(state).then(async (metrics) => {
    if (activeSession !== state) return;
    if (state.stopping) {
      state.pending.clear();
      finalizeStopped(state);
      return;
    }
    Object.assign(state.metrics, metrics || {});
    for (const [phraseId, pending] of state.pending) {
      let retryAudio = null;
      if (pending.direct && state.directAudio) {
        const baseTime = Number(state.directAudioBaseTime) || 0;
        const fromSample = Math.max(0, Math.round((pending.startVideo - baseTime) * TARGET_SAMPLE_RATE));
        const toSample = Math.min(state.directAudio.length, Math.round((pending.endVideo - baseTime) * TARGET_SAMPLE_RATE));
        retryAudio = state.directAudio.slice(fromSample, toSample);
      } else if (pending.retryAudio?.length) {
        retryAudio = pending.retryAudio.slice();
      }
      if (!retryAudio?.length) {
        state.pending.delete(phraseId);
        continue;
      }
      if (!pending.direct) {
        pending.retryAudio = retryAudio;
        continue;
      }
      state.directInFlightPhraseId = phraseId;
      postWorkerMessage(state, 'transcribe', {
        sessionId: state.sessionId,
        phraseId,
        direct: Boolean(pending.direct),
        audio: retryAudio.buffer
      }, [retryAudio.buffer]);
    }
    state.metrics.queueLength = state.pending.size;
    state.metrics.queuedAudioSeconds = [...state.pending.values()].reduce((sum, item) => sum + item.audioSeconds, 0);
    state.modelReady = true;
    state.acceptAudio = true;
    dispatchNextCapturePhrase(state);
    if (bufferLiveAudio) await drainWarmupAudio(state);
    state.status = 'running';
    state.statusText = `已降级到 ${runtimeLabel(state)}，已重投 ${state.pending.size} 段待处理音频。`;
    if (state.scanMode) sendEvent(state, 'resume-after-model', { statusText: state.statusText });
    sendEvent(state, 'running');
    if (state.sourceMode === 'direct' && !state.pending.size) dispatchNextDirectSegment(state);
  }).catch((fallbackError) => {
    if (activeSession !== state) return;
    if (state.stopping) {
      state.pending.clear();
      finalizeStopped(state);
      return;
    }
    void failSession(state, fallbackError);
  });
  state.modelInitPromise = fallbackPromise;
  void fallbackPromise;
  return true;
}

function handleTranscriptionError(message, error) {
  const state = activeSession;
  if (!state || (message.sessionId && message.sessionId !== state.sessionId)) return;
  finishInferenceWatchdog(state, { ...message, type: 'error' });
  if (message.preview) {
    state.previewInFlight = false;
    if (message.previewToken !== state.activePhraseToken &&
        ![...state.pending.values()].some((item) => item.phraseToken === message.previewToken)) {
      dispatchNextCapturePhrase(state);
      return;
    }
    if (startRuntimeCpuFallback(state, error)) return;
    state.previewThrottleToken = message.previewToken || state.activePhraseToken;
    state.statusText = `临时字幕失败，仍会在停顿后提交整句：${errorText(error)}`;
    sendEvent(state, 'segment-error', { error: errorText(error) });
    dispatchNextCapturePhrase(state);
    return;
  }
  const failedPending = message.phraseId ? state.pending.get(message.phraseId) : null;
  if (state.directInFlightPhraseId === message.phraseId) state.directInFlightPhraseId = null;
  if (state.captureInFlightPhraseId === message.phraseId) state.captureInFlightPhraseId = null;
  if (message.phraseId && !failedPending) {
    if (state.sourceMode === 'direct') dispatchNextDirectSegment(state);
    else dispatchNextCapturePhrase(state);
    return;
  }
  if (startRuntimeCpuFallback(state, error)) return;
  if (message.phraseId) state.pending.delete(message.phraseId);
  state.consecutiveInferenceErrors = (Number(state.consecutiveInferenceErrors) || 0) + 1;
  state.metrics.failedSegments = (Number(state.metrics.failedSegments) || 0) + 1;
  state.metrics.queueLength = state.pending.size;
  state.metrics.queuedAudioSeconds = [...state.pending.values()].reduce((sum, item) => sum + item.audioSeconds, 0);
  resumeWarmupDrain(state);
  state.statusText = `某段识别失败：${errorText(error)}`;
  sendEvent(state, 'segment-error', { error: errorText(error) });
  if (failedPending?.direct || state.consecutiveInferenceErrors >= 3) {
    terminateInferenceWorker();
    void failSession(state, error);
    return;
  }
  if (state.stopping && state.pending.size === 0) finalizeStopped(state);
  else dispatchNextCapturePhrase(state);
}

function formatTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function renderSrt(cues) {
  const rows = [...(cues || [])];
  rows.sort((a, b) => a.from - b.from || a.to - b.to);
  return rows.map((cue, index) => (
    `${index + 1}\n${formatTimestamp(cue.from)} --> ${formatTimestamp(cue.to)}\n${cue.text}`
  )).join('\n\n');
}

async function openTabStream(message) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: message.streamId
        }
      },
      video: false
    });
  } catch (error) {
    const chromeVersion = navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/)?.[1] || 'unknown';
    throw new Error(
      `标签页音频流消费失败：${error?.name || 'Error'}: ${error?.message || error}` +
      `（Chrome ${chromeVersion}，crossOriginIsolated=${self.crossOriginIsolated}）。` +
      '后台将尝试切换到页面内视频取音；若页面也拒绝捕获，再检查其它录屏/字幕扩展。'
    );
  }
}

function decodeBase64(value) {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

function asciiAt(bytes, offset, length) {
  let value = '';
  for (let index = 0; index < length && offset + index < bytes.length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]);
  }
  return value;
}

function sniffCompleteAudioAsset(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) throw new Error('音轨数据过短');
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WAVE') return 'wav';
  if (asciiAt(bytes, 0, 4) === 'OggS') return 'ogg';
  if (asciiAt(bytes, 0, 4) === 'fLaC') return 'flac';
  if (asciiAt(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'mpeg-audio';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';

  const view = new DataView(buffer);
  let offset = 0;
  let hasFtyp = false;
  let hasMoov = false;
  let hasMedia = false;
  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset, false);
    const type = asciiAt(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      size = Number(view.getBigUint64(offset + 8, false));
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (!Number.isSafeInteger(size) || size < header || offset + size > bytes.length) break;
    if (type === 'ftyp') hasFtyp = true;
    else if (type === 'moov') hasMoov = true;
    else if (type === 'mdat' || type === 'moof') hasMedia = true;
    offset += size;
  }
  if (hasFtyp && hasMoov && hasMedia) return 'mp4';
  if (hasFtyp || asciiAt(bytes, 4, 4) === 'styp' || asciiAt(bytes, 4, 4) === 'moof') {
    throw new Error('检测到缺少完整 init/moov 的 fMP4；拒绝把裸分片交给 decodeAudioData');
  }
  throw new Error('不是受支持的完整独立音轨容器');
}

function updateAudioDownloadProgress(state, loaded, total, viaPage = false) {
  const safeLoaded = Math.max(0, Number(loaded) || 0);
  const safeTotal = Math.max(safeLoaded, Number(total) || 0);
  state.metrics.audioDownloadBytes = safeLoaded;
  state.metrics.audioDownloadTotal = safeTotal;
  const now = performance.now();
  const previous = state.audioDownloadNotice;
  const complete = safeTotal > 0 && safeLoaded >= safeTotal;
  const reset = !previous || safeLoaded < previous.loaded || safeTotal !== previous.total || viaPage !== previous.viaPage;
  if (!reset && (safeLoaded === previous.loaded || (!complete && now - previous.at < 500))) return;
  state.audioDownloadNotice = { at: now, loaded: safeLoaded, total: safeTotal, viaPage };
  state.status = 'loading';
  state.statusText = `${viaPage ? '页面代理' : '扩展'}正在下载独立音轨：${(safeLoaded / 1024 / 1024).toFixed(1)}` +
    `${safeTotal ? ` / ${(safeTotal / 1024 / 1024).toFixed(1)}` : ''} MiB`;
  sendEvent(state, 'audio-progress', {
    audioLoaded: safeLoaded,
    audioTotal: safeTotal,
    audioProgress: safeTotal ? Math.min(100, safeLoaded / safeTotal * 100) : 0
  });
}

async function openSessionFetch(state, url, options = {}) {
  const { stallTimeoutMs = DIRECT_FETCH_STALL_TIMEOUT_MS, signal: extraSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const parentSignal = state?.networkController?.signal;
  const onParentAbort = () => controller.abort(parentSignal.reason || 'session-stopped');
  const onExtraAbort = () => controller.abort(extraSignal.reason || 'request-cancelled');
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  if (extraSignal?.aborted) onExtraAbort();
  else extraSignal?.addEventListener('abort', onExtraAbort, { once: true });
  let stallTimer = null;
  const touch = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort('audio-fetch-stalled'), stallTimeoutMs);
  };
  const close = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    parentSignal?.removeEventListener('abort', onParentAbort);
    extraSignal?.removeEventListener('abort', onExtraAbort);
    if (!controller.signal.aborted) controller.abort('request-closed');
  };
  try {
    touch();
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    touch();
    return { response, controller, parentSignal, state, touch, close };
  } catch (error) {
    close();
    if (parentSignal?.aborted || state?.stopping) throw engineError('任务已停止', 'TASK_CANCELLED');
    if (controller.signal.reason === 'audio-fetch-stalled') {
      throw new Error(`音轨请求连续 ${stallTimeoutMs / 1000} 秒没有收到数据`);
    }
    throw error;
  }
}

async function readSessionResponse(request, maxBytes, onProgress = null) {
  const response = request.response;
  try {
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) throw new Error(`资源超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB 限制`);
      return buffer;
    }
    let received = 0;
    const monitored = response.body.pipeThrough(new TransformStream({
      transform(chunk, streamController) {
        request.touch();
        received += chunk.byteLength;
        if (received > maxBytes) {
          streamController.error(new Error(`资源超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB 限制`));
          request.controller.abort('size-overflow');
          return;
        }
        onProgress?.(received);
        streamController.enqueue(chunk);
      }
    }));
    return await new Response(monitored).arrayBuffer();
  } catch (error) {
    if (request.parentSignal?.aborted || request.state?.stopping) {
      throw engineError('任务已停止', 'TASK_CANCELLED');
    }
    if (request.controller.signal.reason === 'audio-fetch-stalled') {
      throw new Error('音轨请求在允许时间内没有收到数据');
    }
    throw error;
  }
}

function sniffAudioProbe(buffer, candidate = {}) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) throw new Error('探测响应过短');
  const box = asciiAt(bytes, 4, 4);
  if (['ftyp', 'styp', 'moof'].includes(box)) {
    const description = `${candidate.mimeType || ''};${candidate.codecs || ''}`;
    if (candidate.kind === 'dash-audio' && description && !/(?:audio|mp4a|aac|ec-3|ac-3|flac|opus)/i.test(description)) {
      throw new Error(`DASH 响应不是音频轨：${description}`);
    }
    return 'mp4';
  }
  if (asciiAt(bytes, 0, 4) === 'OggS') return 'ogg';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  if (asciiAt(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'mpeg-audio';
  throw new Error('Range 响应没有可识别的音频容器头');
}

async function probeDirectCandidate(state, candidate, signal) {
  let candidateHost = '';
  try { candidateHost = new URL(candidate.url).hostname; } catch {}
  state.metrics.directProbesStarted = (Number(state.metrics.directProbesStarted) || 0) + 1;
  state.metrics.lastAudioProbe = [candidate.source || candidate.kind || 'media', candidateHost]
    .filter(Boolean).join('@');
  const request = await openSessionFetch(state, candidate.url, {
    cache: 'no-store', credentials: 'include', redirect: 'follow', signal,
    stallTimeoutMs: DIRECT_PROBE_TIMEOUT_MS,
    headers: { Range: `bytes=0-${DIRECT_PROBE_BYTES - 1}` }
  });
  try {
    const response = request.response;
    const contentRange = response.headers.get('content-range') || '';
    const range = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    if (response.status !== 206 || !range || Number(range[1]) !== 0) {
      throw new Error(`探测必须返回从 0 开始的 206/Content-Range，实际 HTTP ${response.status}`);
    }
    const end = Number(range[2]);
    const total = Number(range[3]);
    if (!Number.isSafeInteger(total) || total <= end || total > MP4_MAX_NETWORK_BYTES) {
      throw new Error('探测返回的音轨总长度无效');
    }
    if (end + 1 > DIRECT_PROBE_BYTES * 2) throw new Error('CDN 探测响应超出小范围限制');
    const buffer = await readSessionResponse(request, DIRECT_PROBE_BYTES * 2);
    if (buffer.byteLength !== end + 1) throw new Error(`探测字节数与 Content-Range 不符：${contentRange}`);
    const container = sniffAudioProbe(buffer, candidate);
    return { candidate, buffer, total, end, container, contentType: response.headers.get('content-type') || '' };
  } finally {
    request.close();
  }
}

async function raceProbeBatch(state, candidates) {
  const raceController = new AbortController();
  try {
    return await Promise.any(candidates.slice(0, 12).map((candidate) =>
      probeDirectCandidate(state, candidate, raceController.signal).then((result) => {
        if (!raceController.signal.aborted) raceController.abort('candidate-selected');
        return result;
      })
    ));
  } finally {
    if (!raceController.signal.aborted) raceController.abort('probe-batch-finished');
  }
}

async function selectBilibiliDashCandidate(state, candidates) {
  const dash = candidates.filter((candidate) => candidate?.kind === 'dash-audio' ||
    (state.directSource?.platform === 'youtube' && /^audio\/mp4/i.test(candidate?.mimeType || '')));
  const muxed = candidates.filter(candidate => candidate?.kind === 'muxed-video' && candidate.hasAudio)
    .sort((a, b) => Number(a.height) - Number(b.height) || Number(a.bitrate) - Number(b.bitrate));
  const generic = candidates.filter(candidate => !dash.includes(candidate) && !muxed.includes(candidate) &&
    candidate?.kind === 'file' && (/mp4|m4a|mp4a|aac/i.test(candidate.mimeType || '') ||
      /\.(mp4|m4a|m4v|mov)(?:$|[?#])/i.test(candidate.url || '')));
  if (!dash.length && !muxed.length && !generic.length) return null;
  const ordinaryAac = dash.filter((candidate) => (!candidate.audioClass || candidate.audioClass === 'standard') &&
    /(?:mp4a|aac|audio\/mp4)/i.test(`${candidate.mimeType || ''};${candidate.codecs || ''}`));
  const standardOther = dash.filter((candidate) => candidate.audioClass === 'standard' && !ordinaryAac.includes(candidate));
  const premium = dash.filter((candidate) => !ordinaryAac.includes(candidate) && !standardOther.includes(candidate));
  const failures = [];
  for (const group of [ordinaryAac, standardOther, premium, ...muxed.map(candidate => [candidate]), generic]) {
    if (!group.length) continue;
    try {
      return await raceProbeBatch(state, group);
    } catch (error) {
      failures.push(errorText(error));
    }
  }
  state.metrics.dashProbeFailure = failures.slice(-3).join('；');
  return null;
}

async function acquireDirectRequestHeaders(state) {
  if (state.directSource?.platform !== 'bilibili') return false;
  const urls = (state.directSource.candidates || []).map((candidate) => candidate?.url).filter(Boolean);
  const response = await chrome.runtime.sendMessage({
    target: 'background', type: 'BILI_ASR_DNR_ACQUIRE', sessionId: state.sessionId,
    referer: state.directSource.referer || state.sourceUrl, urls
  });
  if (!response?.ok) throw new Error(response?.error || '无法设置 B站临时 Referer');
  state.metrics.bilibiliRefererRule = true;
  return true;
}

async function releaseDirectRequestHeaders(state) {
  if (state.directSource?.platform !== 'bilibili') return;
  await chrome.runtime.sendMessage({
    target: 'background', type: 'BILI_ASR_DNR_RELEASE', sessionId: state.sessionId
  }).catch(() => {});
}

async function fetchExactRange(state, url, start, end, totalHint = 0) {
  const request = await openSessionFetch(state, url, {
    cache: 'no-store', credentials: 'include', redirect: 'follow',
    headers: { Range: `bytes=${start}-${end}` }
  });
  try {
    const response = request.response;
    const contentRange = response.headers.get('content-range') || '';
    const range = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    if (response.status !== 206 || !range || Number(range[1]) !== start) {
      throw new Error(`CDN 没有返回连续的 206/Content-Range：${contentRange || `HTTP ${response.status}`}`);
    }
    const responseEnd = Number(range[2]);
    const total = Number(range[3]);
    if (responseEnd > end || (totalHint && total !== totalHint) || total > MP4_MAX_NETWORK_BYTES) {
      throw new Error(`CDN Range 元数据不一致：${contentRange}`);
    }
    const buffer = await readSessionResponse(request, end - start + 1, (received) => {
      updateAudioDownloadProgress(state, start + received, total);
    });
    if (buffer.byteLength !== responseEnd - start + 1) {
      throw new Error(`CDN Range 实际长度不符：${contentRange}`);
    }
    return { buffer, end: responseEnd, total };
  } finally {
    request.close();
  }
}

function mp4AudioDecoderConfig(file, track) {
  const trak = file.getTrackById?.(track.id);
  const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  const decoderSpecificInfo = entry?.esds?.esd?.findDescriptor?.(4)?.findDescriptor?.(5)?.data;
  if (!decoderSpecificInfo?.byteLength) throw new Error('MP4 AAC 缺少 AudioSpecificConfig');
  return {
    codec: track.codec,
    sampleRate: Number(track.audio?.sample_rate) || 0,
    numberOfChannels: Number(track.audio?.channel_count) || 0,
    description: new Uint8Array(decoderSpecificInfo)
  };
}

function validateDirectMediaDuration(actual, expected, label = '媒体') {
  const wanted = Number(expected) || 0;
  const measured = Number(actual) || 0;
  if (wanted < 15 || measured <= 0) return;
  if (Math.abs(measured - wanted) > Math.max(3, wanted * 0.03)) {
    throw engineError(`${label} 时长 ${measured.toFixed(1)} 秒与当前视频 ${wanted.toFixed(1)} 秒不匹配`, 'DIRECT_AUDIO_FAILED');
  }
}

function validateDecodedAudioTimestamp(timestamp, nextPts, frames, sampleRate) {
  if (!Number.isFinite(timestamp)) return nextPts;
  const pts = timestamp / 1000000;
  if (nextPts == null && Math.abs(pts) > 0.25) {
    throw engineError('MP4 音轨起始时间戳不在零点附近，当前路径无法可靠对齐', 'DIRECT_AUDIO_FAILED');
  }
  if (nextPts != null && Math.abs(pts - nextPts) > 0.25) {
    throw engineError('MP4 音轨时间戳存在跳变，已停止发布可能错位的字幕', 'DIRECT_AUDIO_FAILED');
  }
  return pts + frames / sampleRate;
}

async function downloadProgressiveMp4Audio(state, probe) {
  if (!self.MP4Box?.createFile || typeof AudioDecoder !== 'function' || typeof EncodedAudioChunk !== 'function') {
    throw new Error('当前 Chrome 不支持 MP4Box.js + WebCodecs 渐进音频解码');
  }
  const file = self.MP4Box.createFile();
  const decodedChunks = [];
  let decodedFrames = 0;
  let decodedSampleRate = 0;
  let nextAudioPts = null;
  let decoder = null;
  let audioTrack = null;
  let failed = null;
  let startupSettled = false;
  let startupIsComplete = false;
  let fullSettled = false;
  let resolveStartup;
  let rejectStartup;
  let resolveFull;
  let rejectFull;
  const readers = new Set();
  let windowController = new AbortController();
  let disposed = false;
  let requestedThrough = Math.max(DASH_STARTUP_SECONDS, Number(state.directStartTime) || 0);
  const wakeReaders = () => { for (const wake of [...readers]) wake(); };
  const startupPromise = new Promise((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  const fullAudioPromise = new Promise((resolve, reject) => { resolveFull = resolve; rejectFull = reject; });
  void fullAudioPromise.catch(() => {});
  const mergeDecoded = () => {
    if (!decodedFrames || !decodedSampleRate) throw new Error('WebCodecs 没有输出可用 PCM');
    const merged = mergeChunks(decodedChunks, decodedFrames);
    return decodedSampleRate === TARGET_SAMPLE_RATE ? merged : resampleTo16k(merged, decodedSampleRate);
  };
  const readWindow = async (time, seconds = 30) => {
    const signal = windowController.signal;
    const target = Math.max(0, Number(time) || 0);
    requestedThrough = Math.max(requestedThrough, target + seconds);
    wakeReaders();
    await new Promise((resolve, reject) => {
      const wake = () => {
        if (signal.aborted || disposed || failed || fullSettled ||
            (decodedSampleRate && decodedFrames / decodedSampleRate >= target + seconds)) {
          readers.delete(wake);
          signal.removeEventListener('abort', wake);
          if (failed) reject(failed);
          else if (signal.aborted || disposed) reject(engineError('DASH 窗口已取消', 'TASK_CANCELLED'));
          else resolve();
        }
      };
      readers.add(wake);
      signal.addEventListener('abort', wake, { once: true });
      wake();
    });
    const end = Math.min(decodedFrames / decodedSampleRate, target + seconds);
    if (end <= target) return null;
    const start = Math.max(0, target - 1);
    const fromFrame = Math.round(start * decodedSampleRate);
    const toFrame = Math.min(decodedFrames, Math.round(end * decodedSampleRate));
    const mixed = sliceDecodedPcm(decodedChunks, fromFrame, toFrame);
    const audio = decodedSampleRate === TARGET_SAMPLE_RATE ? mixed : resampleTo16k(mixed, decodedSampleRate);
    return { start: fromFrame / decodedSampleRate, end: toFrame / decodedSampleRate,
      complete: fullSettled && toFrame === decodedFrames, audio };
  };
  const fail = (error) => {
    if (failed) return;
    failed = error instanceof Error ? error : new Error(String(error));
    if (!startupSettled) { startupSettled = true; rejectStartup(failed); }
    if (!fullSettled) { fullSettled = true; rejectFull(failed); }
    wakeReaders();
    try { decoder?.close(); } catch {}
  };
  const maybeResolveStartup = () => {
    if (startupSettled || !decodedSampleRate || decodedFrames / decodedSampleRate < DASH_STARTUP_SECONDS) return;
    try {
      startupSettled = true;
      resolveStartup(mergeDecoded());
    } catch (error) {
      fail(error);
    }
  };
  const handleAudioData = (audioData) => {
    try {
      if (disposed) return;
      const sampleRate = Number(audioData.sampleRate) || 0;
      const frames = Number(audioData.numberOfFrames) || 0;
      const channels = Math.max(1, Number(audioData.numberOfChannels) || 1);
      state.metrics.downmixMode = channels === 1 ? 'mono' : 'adaptive-channel-mix';
      if (!sampleRate || !frames) throw new Error('WebCodecs 返回了空音频帧');
      if (Number.isFinite(audioData.timestamp)) {
        const pts = audioData.timestamp / 1000000;
        if (nextAudioPts == null) state.metrics.firstAudioPtsSeconds = pts;
        nextAudioPts = validateDecodedAudioTimestamp(audioData.timestamp, nextAudioPts, frames, sampleRate);
      }
      if (decodedSampleRate && decodedSampleRate !== sampleRate) throw new Error('DASH 音轨中途改变采样率');
      decodedSampleRate ||= sampleRate;
      const mixed = new Float32Array(frames);
      let strongestPlane = null;
      let strongestEnergy = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        const options = { planeIndex: channel, format: 'f32-planar' };
        const plane = new Float32Array(audioData.allocationSize(options) / Float32Array.BYTES_PER_ELEMENT);
        audioData.copyTo(plane, options);
        let energy = 0;
        for (let index = 0; index < frames; index += 1) {
          mixed[index] += (plane[index] || 0) / channels;
          energy += (plane[index] || 0) ** 2;
        }
        if (energy > strongestEnergy) { strongestEnergy = energy; strongestPlane = plane; }
      }
      if (strongestPlane && rmsOf(mixed) ** 2 * frames < strongestEnergy * 0.25) mixed.set(strongestPlane.subarray(0, frames));
      decodedChunks.push(mixed);
      decodedFrames += frames;
      state.metrics.dashRetainedPcmBytes = decodedFrames * Float32Array.BYTES_PER_ELEMENT;
      maybeResolveStartup();
      wakeReaders();
    } catch (error) {
      fail(error);
    } finally {
      audioData.close();
    }
  };
  file.onError = (error) => fail(new Error(`MP4Box.js 解析失败：${errorText(error)}`));
  file.onReady = (info) => {
    try {
      audioTrack = (info.audioTracks || info.tracks?.filter((track) => track.audio) || [])[0];
      if (!audioTrack || !/^mp4a\./i.test(audioTrack.codec || '')) {
        throw new Error(`渐进解码只接受普通 AAC，实际为 ${audioTrack?.codec || '未知编码'}`);
      }
      validateDirectMediaDuration(Number(audioTrack.duration) / Math.max(1, Number(audioTrack.timescale) || 1),
        state.directSource?.duration, 'MP4 音轨');
      state.metrics.demuxedVideoTracks = (info.videoTracks || []).length;
      state.metrics.videoDecodeRequired = false;
      const config = mp4AudioDecoderConfig(file, audioTrack);
      if (!config.sampleRate || !config.numberOfChannels) throw new Error('MP4 AAC 解码参数不完整');
      decoder = new AudioDecoder({ output: handleAudioData, error: fail });
      decoder.configure(config);
      file.onSamples = (trackId, user, samples) => {
        if (failed || !decoder || decoder.state !== 'configured') return;
        try {
          for (const sample of samples) {
            decoder.decode(new EncodedAudioChunk({
              type: 'key',
              timestamp: Math.round(Number(sample.cts) / Number(sample.timescale) * 1000000),
              duration: Math.max(1, Math.round(Number(sample.duration) / Number(sample.timescale) * 1000000)),
              data: sample.data
            }));
          }
          const last = samples[samples.length - 1];
          if (last) file.releaseUsedSamples(trackId, Number(last.number) + 1);
        } catch (error) {
          fail(error);
        }
      };
      file.setExtractionOptions(audioTrack.id, null, { nbSamples: 48, rapAlignement: false });
      file.start();
    } catch (error) {
      fail(error);
    }
  };
  const append = (buffer, fileStart) => {
    if (failed) throw failed;
    buffer.fileStart = fileStart;
    file.appendBuffer(buffer);
    if (failed) throw failed;
  };
  void (async () => {
    try {
      const total = Number(probe.total) || 0;
      if (!total || total > MP4_MAX_NETWORK_BYTES) throw new Error('MP4 音轨长度无效或超过 2 GiB 读取预算');
      append(probe.buffer, 0);
      let loaded = probe.buffer.byteLength;
      updateAudioDownloadProgress(state, loaded, total);
      while (loaded < total) {
        if (disposed || state.stopping || activeSession !== state) throw engineError('任务已停止', 'TASK_CANCELLED');
        // Fetch/decode follows consumer demand, rather than filling all PCM
        // during model warmup or while the viewer has paused the video.
        if (decodedSampleRate && decodedFrames / decodedSampleRate > requestedThrough + 60) {
          await new Promise((resolve, reject) => {
            const wake = () => {
              if (disposed || failed || decodedFrames / decodedSampleRate <= requestedThrough + 60) {
                readers.delete(wake);
                if (failed) reject(failed);
                else if (disposed) reject(engineError('任务已停止', 'TASK_CANCELLED'));
                else resolve();
              }
            };
            readers.add(wake);
            wake();
          });
          if (disposed || state.stopping || activeSession !== state) throw engineError('任务已停止', 'TASK_CANCELLED');
        }
        const end = Math.min(total - 1, loaded + DASH_RANGE_CHUNK_BYTES - 1);
        const part = await fetchExactRange(state, probe.candidate.url, loaded, end, total);
        append(part.buffer, loaded);
        if (decoder?.state === 'configured') await decoder.flush();
        loaded = part.end + 1;
        updateAudioDownloadProgress(state, loaded, total);
      }
      file.flush();
      if (failed) throw failed;
      if (!decoder || !audioTrack) throw new Error('MP4Box.js 没有发现 AAC 音轨');
      await decoder.flush();
      if (failed) throw failed;
      validateDirectMediaDuration(decodedFrames / decodedSampleRate, state.directSource?.duration, '已解码音轨');
      if (!startupSettled) { startupSettled = true; startupIsComplete = true; resolveStartup(mergeDecoded()); }
      fullSettled = true;
      resolveFull({ decodedSeconds: decodedFrames / decodedSampleRate });
      wakeReaders();
      decoder.close();
    } catch (error) {
      fail(error);
    }
  })();
  const initialAudio = await startupPromise;
  const duration = Math.max(0, Number(audioTrack?.duration) / Math.max(1, Number(audioTrack?.timescale) || 1));
  state.metrics.audioContainer = 'mp4-progressive';
  state.metrics.dashProgressive = true;
  return {
    kind: 'dash-progressive', initialAudio, fullAudioPromise, readWindow,
    cancelWindow: () => { windowController.abort(); windowController = new AbortController(); },
    dispose: () => { disposed = true; windowController.abort(); wakeReaders(); decodedChunks.length = 0;
      state.metrics.dashRetainedPcmBytes = 0; try { decoder?.close(); } catch {} },
    // Network completion is not PCM completeness: initialAudio may still be
    // only the startup prefix even if the full promise resolved in this tick.
    duration, timelineOffset: 0, complete: startupIsComplete
  };
}

function sliceDecodedPcm(chunks, fromFrame, toFrame) {
  const output = new Float32Array(Math.max(0, toFrame - fromFrame));
  let offset = 0;
  let written = 0;
  for (const chunk of chunks) {
    const from = Math.max(0, fromFrame - offset);
    const to = Math.min(chunk.length, toFrame - offset);
    if (to > from) { output.set(chunk.subarray(from, to), written); written += to - from; }
    offset += chunk.length;
    if (offset >= toFrame) break;
  }
  if (written !== output.length) throw new Error('DASH 解码窗口存在 PCM 缺口');
  return output;
}

async function fetchAudioFromExtension(state, url, seed = null) {
  const chunks = seed?.buffer ? [new Uint8Array(seed.buffer)] : [];
  let loaded = seed?.buffer ? seed.buffer.byteLength : 0;
  let total = Math.max(0, Number(seed?.total) || 0);
  if (total && loaded === total) return joinByteArrays(chunks);
  for (let requestIndex = 0; requestIndex < 512; requestIndex += 1) {
    if (state.stopping || activeSession !== state) throw engineError('任务已停止', 'TASK_CANCELLED');
    const request = await openSessionFetch(state, url, {
      cache: 'no-store',
      credentials: 'include',
      redirect: 'follow',
      headers: loaded ? { Range: `bytes=${loaded}-` } : undefined
    });
    try {
      const response = request.response;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentRange = response.headers.get('content-range') || '';
      const range = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
      if (response.status === 206 && !range) throw new Error('CDN 返回无法证明完整性的 206 局部响应');
      if (range && Number(range[1]) !== loaded) {
        throw new Error(`CDN 分段不连续：期望从 ${loaded} 开始，实际为 ${contentRange}`);
      }
      if (!range && loaded) {
        // A 200 response contains the whole resource. Discard the prefix,
        // rather than duplicating it or rejecting a valid CDN fallback.
        chunks.length = 0;
        loaded = 0;
        total = 0;
      }
      const responseTotal = range ? Number(range[3]) : Number(response.headers.get('content-length')) || 0;
      if (range && total && responseTotal !== total) throw new Error('CDN 音轨总长度在续传期间发生变化');
      total = Math.max(total, responseTotal);
      if (total > DIRECT_MAX_BYTES) throw new Error(`音轨超过 ${Math.round(DIRECT_MAX_BYTES / 1024 / 1024)} MiB 限制`);
      const remaining = Math.max(1, DIRECT_MAX_BYTES - loaded);
      const buffer = await readSessionResponse(request, remaining, (received) => {
        updateAudioDownloadProgress(state, loaded + received, total);
      });
      const bytes = new Uint8Array(buffer);
      if (!bytes.byteLength) throw new Error('CDN 返回了空音轨分段');
      loaded += bytes.byteLength;
      if (loaded > DIRECT_MAX_BYTES) throw new Error(`音轨超过 ${Math.round(DIRECT_MAX_BYTES / 1024 / 1024)} MiB 限制`);
      if (range && loaded !== Number(range[2]) + 1) {
        throw new Error(`CDN 分段长度与 Content-Range 不符：${contentRange}`);
      }
      chunks.push(bytes);
      updateAudioDownloadProgress(state, loaded, total);
      if (!range || loaded >= total) return joinByteArrays(chunks);
    } finally {
      request.close();
    }
  }
  throw new Error('CDN 音轨分段超过 512 次安全限制');
}

function fetchAudioThroughPage(state, url, maxBytes = DIRECT_MAX_BYTES, trackProgress = true, signal = null) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let timeout = null;
    const cancelForStall = () => {
      pageFetchWaiters.delete(requestId);
      chrome.runtime.sendMessage({
        target: 'background', type: 'BILI_ASR_PAGE_FETCH_CANCEL',
        tabId: state.tabId, frameId: Number(state.pageFetchFrameId) || 0, requestId
      }).catch(() => {});
      waiter.reject(new Error(`页面音轨代理连续 ${PAGE_FETCH_STALL_TIMEOUT_MS / 1000} 秒没有数据`));
    };
    const touch = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(cancelForStall, PAGE_FETCH_STALL_TIMEOUT_MS);
    };
    const waiter = {
      state,
      requestId,
      frameId: Number(state.pageFetchFrameId) || 0,
      chunks: [],
      loaded: 0,
      total: 0,
      maxBytes,
      contentType: '',
      trackProgress,
      touch,
      resolve: (buffer) => {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timeout);
        pageFetchWaiters.delete(requestId);
        resolve(buffer);
      },
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timeout);
        pageFetchWaiters.delete(requestId);
        reject(error);
      }
    };
    const onAbort = () => {
      chrome.runtime.sendMessage({ target: 'background', type: 'BILI_ASR_PAGE_FETCH_CANCEL',
        tabId: state.tabId, frameId: waiter.frameId, requestId }).catch(() => {});
      waiter.reject(engineError('前瞻窗口已取消', 'TASK_CANCELLED'));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    pageFetchWaiters.set(requestId, waiter);
    touch();
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'BILI_ASR_PAGE_FETCH_REQUEST',
      tabId: state.tabId,
      frameId: Number(state.pageFetchFrameId) || 0,
      requestId,
      url,
      maxBytes
    }).then((result) => {
      if (!result?.ok) pageFetchWaiters.get(requestId)?.reject(new Error(result?.error || '页面音轨代理失败'));
    }).catch((error) => pageFetchWaiters.get(requestId)?.reject(error));
  });
}

function rejectPageFetchWaiters(state, error) {
  for (const [requestId, waiter] of [...pageFetchWaiters]) {
    if (waiter.state !== state) continue;
    chrome.runtime.sendMessage({
      target: 'background', type: 'BILI_ASR_PAGE_FETCH_CANCEL',
      tabId: state.tabId, frameId: waiter.frameId, requestId
    }).catch(() => {});
    waiter.reject(error);
  }
}

async function fetchResource(state, url, maxBytes = 64 * 1024 * 1024, options = {}) {
  const { resourceKind = '分片/初始化段', ...requestOptions } = options;
  const pageEligible = /^https?:/i.test(url);
  const routeKey = pageEligible ? `${Number(state.pageFetchFrameId) || 0}:${new URL(url).origin}` : '';
  state.resourceFetchRoutes ||= new Map();
  const preferPage = state.resourceFetchRoutes.get(routeKey) === 'page';
  const extensionFetch = async () => {
    let lease = null;
    let request = null;
    try {
      if (pageEligible && state.directSource?.platform === 'web') {
        lease = await chrome.runtime.sendMessage({ target: 'background', type: 'BILI_ASR_MEDIA_HEADERS_ACQUIRE',
          sessionId: state.sessionId, url }).catch(() => null);
        if (lease?.ok) {
          state.metrics.hlsRefererRequests = (Number(state.metrics.hlsRefererRequests) || 0) + 1;
          delete state.metrics.hlsRefererError;
        }
        else state.metrics.hlsRefererError = lease?.error || '临时 Referer 不可用';
      }
      if (options.signal?.aborted || state.stopping || state.networkController?.signal.aborted) {
        throw engineError('前瞻窗口已取消', 'TASK_CANCELLED');
      }
      request = await openSessionFetch(state, url, { cache: 'no-store', credentials: 'include', redirect: 'follow',
        stallTimeoutMs: 20000, ...requestOptions });
      const response = request.response;
      if (!response.ok) throw new Error(`HTTP ${response.status}${state.metrics.hlsRefererError ? `（Referer：${state.metrics.hlsRefererError}）` : ''}`);
      const declared = Number(response.headers.get('content-length')) || 0;
      if (declared > maxBytes) throw new Error(`资源超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB 限制`);
      return await readSessionResponse(request, maxBytes);
    } finally {
      request?.close();
      if (lease?.ok) await chrome.runtime.sendMessage({ target: 'background', type: 'BILI_ASR_MEDIA_HEADERS_RELEASE',
        sessionId: state.sessionId, ruleId: lease.ruleId }).catch(() => {});
    }
  };
  const routes = !pageEligible ? ['extension'] : preferPage ? ['page', 'extension'] : ['extension', 'page'];
  const failures = [];
  for (const route of routes) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (options.signal?.aborted || state.stopping || state.networkController?.signal.aborted) {
        throw engineError('前瞻窗口已取消', 'TASK_CANCELLED');
      }
      try {
        const buffer = route === 'page'
          ? await fetchAudioThroughPage(state, url, maxBytes, false, options.signal)
          : await extensionFetch();
        if (pageEligible) {
          state.resourceFetchRoutes.set(routeKey, route);
          while (state.resourceFetchRoutes.size > 64) state.resourceFetchRoutes.delete(state.resourceFetchRoutes.keys().next().value);
        }
        const metric = route === 'page' ? 'resourcePageReads' : 'resourceExtensionReads';
        state.metrics[metric] = (Number(state.metrics[metric]) || 0) + 1;
        return buffer;
      } catch (error) {
        if (options.signal?.aborted || state.stopping || state.networkController?.signal.aborted || error?.code === 'TASK_CANCELLED') {
          throw engineError('前瞻窗口已取消', 'TASK_CANCELLED');
        }
        failures.push(`${route === 'page' ? '页面代理' : '扩展直取'}：${errorText(error)}`);
        state.resourceFetchRoutes.delete(routeKey);
        if (attempt === 0 && /超时|没有收到数据|没有数据|audio-fetch-stalled|Failed to fetch|HTTP (?:408|429|5\d\d)/i.test(errorText(error))) {
          state.metrics.hlsReadRetries = (Number(state.metrics.hlsReadRetries) || 0) + 1;
          state.statusText = `HLS ${resourceKind} ${new URL(url).hostname} ` +
            `${route === 'page' ? '页面代理' : '扩展直取'}暂时失败，重试 1/1：${errorText(error)}`;
          sendEvent(state, 'status');
          continue;
        }
        break;
      }
    }
  }
  throw new Error(`${resourceKind}@${new URL(url).hostname}：${failures.join('；')}`);
}

function joinByteArrays(chunks, maximum = DIRECT_MAX_BYTES) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total > maximum) throw new Error(`解复用后的音轨超过 ${(maximum / 1024 / 1024).toFixed(0)} MiB 内存限制`);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return output.buffer;
}

function looksLikeTransportStream(bytes) {
  for (let offset = 0; offset < Math.min(188, bytes.length); offset += 1) {
    if (bytes[offset] === 0x47 && bytes[offset + 188] === 0x47 && bytes[offset + 376] === 0x47) return true;
  }
  return false;
}

function looksLikeAdts(bytes) {
  for (let offset = 0; offset < Math.min(4096, bytes.length - 1); offset += 1) {
    if (bytes[offset] === 0xff && (bytes[offset + 1] & 0xf6) === 0xf0) return true;
  }
  return false;
}

async function decryptHlsSegment(state, segment, buffer, keyCache, signal = null) {
  if (!segment.key) return buffer;
  let keyPromise = keyCache.get(segment.key.url);
  if (!keyPromise) {
    keyPromise = fetchResource(state, segment.key.url, 1024, { signal, resourceKind: '密钥' }).then((value) => {
      const keyBytes = new Uint8Array(value);
      if (keyBytes.byteLength !== 16) throw new Error(`HLS AES-128 密钥长度为 ${keyBytes.byteLength}，预期 16`);
      return keyBytes;
    }).catch(error => {
      if (keyCache.get(segment.key.url) === keyPromise) keyCache.delete(segment.key.url);
      throw error;
    });
    keyCache.set(segment.key.url, keyPromise);
  }
  const keyBytes = await keyPromise;
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  const iv = self.BrowserHls.parseIv(segment.key.iv, segment.sequence);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buffer);
}

async function resolveHlsMediaPlaylist(state, manifestUrl) {
  let currentUrl = manifestUrl;
  for (let depth = 0; depth < 4; depth += 1) {
    const buffer = await fetchResource(state, currentUrl, 8 * 1024 * 1024, { resourceKind: '清单' });
    const playlist = self.BrowserHls.parsePlaylist(new TextDecoder().decode(buffer), currentUrl);
    if (!playlist.master) return playlist;
    const hasAudio = variant => Boolean(variant.audioGroup || /mp4a|opus|ac-3|ec-3/i.test(variant.codecs));
    const variant = playlist.variants.sort((a, b) => Number(hasAudio(b)) - Number(hasAudio(a)) || Number(a.bandwidth) - Number(b.bandwidth))[0];
    const renditions = playlist.audioRenditions.filter(audio => !variant?.audioGroup || audio.groupId === variant.audioGroup);
    const language = String(state.directSource?.audioLanguage || '').toLowerCase();
    const audio = renditions.sort((a, b) =>
      Number(Boolean(language) && b.language.toLowerCase() === language) - Number(Boolean(language) && a.language.toLowerCase() === language) ||
      Number(b.default) - Number(a.default) || Number(b.autoselect) - Number(a.autoselect))[0];
    currentUrl = audio?.url || variant?.url || '';
    if (!currentUrl) throw new Error('HLS 主清单没有可用的音频或视频变体');
  }
  throw new Error('HLS 主清单嵌套超过 4 层');
}

function hlsFetchConcurrency() {
  const connection = String(navigator.connection?.effectiveType || '').toLowerCase();
  if (connection.includes('2g')) return 2;
  if (connection === '3g') return 4;
  const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 4);
  return Math.max(4, Math.min(HLS_MAX_FETCH_CONCURRENCY, Math.ceil(cores / 2)));
}

function hlsStartupSegmentCount(segments) {
  let duration = 0;
  let count = 0;
  while (count < segments.length && (count < HLS_MIN_STARTUP_SEGMENTS || duration < HLS_STARTUP_SECONDS)) {
    duration += Math.max(0.5, Number(segments[count]?.duration) || 6);
    count += 1;
  }
  return Math.max(1, count);
}

function detectHlsFormat(initBuffer, firstSegment) {
  if (initBuffer?.byteLength) return 'fmp4';
  const bytes = new Uint8Array(firstSegment || new ArrayBuffer(0));
  if (looksLikeTransportStream(bytes)) return 'ts';
  if (looksLikeAdts(bytes)) return 'adts';
  if (asciiAt(bytes, 4, 4) === 'styp' || asciiAt(bytes, 4, 4) === 'moof' || asciiAt(bytes, 4, 4) === 'ftyp') return 'fmp4';
  throw new Error('HLS 分片既不是 MPEG-TS、ADTS，也不是带 init 的 fMP4');
}

function assembleHlsAudio(format, initBuffer, segmentBuffers) {
  if (format === 'ts') {
    const demuxer = new self.BrowserHls.TsAudioDemuxer();
    for (const buffer of segmentBuffers) demuxer.feed(new Uint8Array(buffer));
    return demuxer.finish();
  }
  const chunks = [];
  if (initBuffer?.byteLength) chunks.push(new Uint8Array(initBuffer));
  for (const buffer of segmentBuffers) chunks.push(new Uint8Array(buffer));
  return { buffer: joinByteArrays(chunks), codec: format };
}

async function downloadHlsAudio(state, manifestUrl) {
  state.statusText = '正在解析 HLS 音轨并定位当前播放位置…';
  sendEvent(state, 'status');
  const playlist = await resolveHlsMediaPlaylist(state, manifestUrl);
  if (!playlist.endList) throw new Error('动态/直播 HLS 暂使用实时取音，不能预取尚未产生的音频');
  if (playlist.unsupportedByteRange) throw new Error('当前 HLS 使用 BYTERANGE，尚未接入范围分片读取');
  if (!playlist.segments.length || playlist.segments.length > 10000) throw new Error('HLS 分片数量无效或超过 10000');
  if (playlist.segments.some(segment => !(segment.duration > 0))) throw new Error('HLS 分片缺少有效时长，不能建立前瞻时间轴');
  const duration = playlist.segments.at(-1).end;
  validateDirectMediaDuration(duration, state.directSource?.duration, 'HLS 清单');
  state.statusText = `HLS 点播清单已解析：${playlist.segments.length} 个分片，${duration.toFixed(1)} 秒；正在读取当前窗口。`;
  sendEvent(state, 'status');
  const keyCache = new Map();
  const cache = new Map();
  let cacheBytes = 0;
  let downloaded = 0;
  const concurrency = hlsFetchConcurrency();
  const cacheLimit = 64 * 1024 * 1024;
  const controller = { current: new AbortController() };
  const assertActive = signal => {
    if (state.stopping || activeSession !== state || signal.aborted) throw engineError('前瞻窗口已取消', 'TASK_CANCELLED');
  };
  async function readResource(url, segment, signal) {
    assertActive(signal);
    const id = JSON.stringify([url, segment?.key?.url || '', segment?.key?.iv || '', segment?.sequence ?? null]);
    if (cache.has(id)) {
      const buffer = cache.get(id);
      cache.delete(id);
      cache.set(id, buffer);
      return buffer;
    }
    let buffer = await fetchResource(state, url, 32 * 1024 * 1024, { signal });
    if (segment?.key) buffer = await decryptHlsSegment(state, segment, buffer, keyCache, signal);
    assertActive(signal);
    downloaded += buffer.byteLength;
    if (downloaded > HLS_MAX_NETWORK_BYTES) throw new Error('HLS 累计读取超过 2 GiB 限制');
    while (cache.size && cacheBytes + buffer.byteLength > cacheLimit) {
      const first = cache.keys().next().value;
      cacheBytes -= cache.get(first).byteLength;
      cache.delete(first);
    }
    cache.set(id, buffer);
    cacheBytes += buffer.byteLength;
    while (keyCache.size > 32) keyCache.delete(keyCache.keys().next().value);
    state.metrics.hlsCacheBytes = cacheBytes;
    state.metrics.audioDownloadBytes = downloaded;
    return buffer;
  }
  async function readWindow(time, seconds = HLS_WINDOW_SECONDS) {
    const signal = controller.current.signal;
    assertActive(signal);
    const plan = self.BrowserHls.planWindow(playlist.segments, time, seconds);
    if (!plan) return null;
    if (plan.end - plan.start > 120) throw new Error('HLS 单分片/窗口超过 120 秒，不能保持有限的前瞻解码缓存');
    const segments = playlist.segments.slice(plan.from, plan.to);
    const map = segments[0].initMap;
    if (map?.key && !map.key.iv) throw new Error('加密 HLS 初始化段必须有显式 IV');
    const initBuffer = map ? await readResource(map.url, { key: map.key, sequence: playlist.mediaSequence }, signal) : null;
    const buffers = [];
    let bytes = initBuffer?.byteLength || 0;
    for (let from = 0; from < segments.length; from += concurrency) {
      const batch = await Promise.all(segments.slice(from, from + concurrency)
        .map(segment => readResource(segment.url, segment, signal)));
      assertActive(signal);
      for (const buffer of batch) {
        bytes += buffer.byteLength;
        if (bytes > cacheLimit) throw new Error('单个 HLS 前瞻窗口超过 64 MiB，已停止整轨读取');
        buffers.push(buffer);
      }
    }
    const format = detectHlsFormat(initBuffer, buffers[0]);
    const assembled = assembleHlsAudio(format, initBuffer, buffers);
    state.metrics.audioContainer = format === 'ts' ? `hls-ts-${assembled.codec}` : `hls-${format}`;
    state.metrics.hlsSegmentsTotal = playlist.segments.length;
    state.metrics.hlsWindowFrom = plan.from;
    state.metrics.hlsWindowTo = plan.to;
    state.metrics.hlsFetchConcurrency = concurrency;
    state.metrics.fetchedTo = plan.end;
    sendEvent(state, 'audio-progress', { audioLoaded: plan.to, audioTotal: playlist.segments.length });
    return { ...plan, buffer: assembled.buffer, timelineOffset: plan.start, format };
  }
  const source = { kind: 'hls-windowed', duration, readWindow,
    cancelWindow: () => {
      controller.current.abort('window-replaced');
      controller.current = new AbortController();
    },
    dispose: () => { controller.current.abort('session-finished'); cache.clear(); keyCache.clear(); cacheBytes = 0;
      if (state.hlsHeaderLease) { state.hlsHeaderLease = false; void releaseDirectRequestHeaders(state); } }
  };
  state.hlsSource = source;
  source.initialWindow = await readWindow(state.directStartTime, HLS_STARTUP_SECONDS);
  if (!source.initialWindow) throw new Error('当前播放位置已超过 HLS 音轨末尾');
  state.metrics.hlsWindowed = true;
  return source;
}


function directXmlChildren(node, localName) {
  return [...(node?.children || [])].filter((child) => child.localName === localName || child.nodeName === localName);
}

function dashNodeBase(node, parentBase) {
  const base = directXmlChildren(node, 'BaseURL')[0]?.textContent?.trim();
  if (!base) return parentBase;
  try { return new URL(base, parentBase).href; } catch { return parentBase; }
}

function dashHasSegmentedAddressing(node) {
  return directXmlChildren(node, 'SegmentTemplate').length > 0 || directXmlChildren(node, 'SegmentList').length > 0;
}

async function resolveGenericDashAudioCandidates(state, manifestCandidate) {
  state.statusText = '正在解析 DASH MPD 并寻找可直接读取的音频轨…';
  sendEvent(state, 'status');
  const buffer = await fetchResource(state, manifestCandidate.url, 8 * 1024 * 1024, { resourceKind: 'DASH 清单' });
  const xml = new TextDecoder().decode(buffer);
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('DASH MPD XML 解析失败');
  const mpd = document.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('不是有效的 DASH MPD');
  const mpdBase = dashNodeBase(mpd, manifestCandidate.url);
  const output = [];
  const seen = new Set();
  const periods = directXmlChildren(mpd, 'Period');
  for (const period of periods) {
    const periodBase = dashNodeBase(period, mpdBase);
    for (const adaptation of directXmlChildren(period, 'AdaptationSet')) {
      const adaptationBase = dashNodeBase(adaptation, periodBase);
      const adaptationMime = String(adaptation.getAttribute('mimeType') || '');
      const adaptationType = String(adaptation.getAttribute('contentType') || '');
      const adaptationCodecs = String(adaptation.getAttribute('codecs') || '');
      const protectedSet = adaptation.getElementsByTagName('ContentProtection').length > 0;
      if (protectedSet) continue;
      const adaptationSegmented = dashHasSegmentedAddressing(adaptation) || dashHasSegmentedAddressing(period);
      for (const representation of directXmlChildren(adaptation, 'Representation')) {
        const mimeType = String(representation.getAttribute('mimeType') || adaptationMime || '');
        const codecs = String(representation.getAttribute('codecs') || adaptationCodecs || '');
        const contentType = String(representation.getAttribute('contentType') || adaptationType || '');
        const audioLike = contentType.toLowerCase() === 'audio' || /^audio\//i.test(mimeType) ||
          /(?:mp4a|aac|opus|vorbis|ac-3|ec-3|flac)/i.test(codecs);
        if (!audioLike || representation.getElementsByTagName('ContentProtection').length) continue;
        // SegmentTemplate / SegmentList requires constructing many media URLs.
        // Keep this resolver conservative and only hand complete/SegmentBase audio
        // resources to the existing progressive range reader.
        if (adaptationSegmented || dashHasSegmentedAddressing(representation)) continue;
        const url = dashNodeBase(representation, adaptationBase);
        if (!url || url === manifestCandidate.url || /\/$/.test(url) || seen.has(url)) continue;
        seen.add(url);
        output.push({
          url,
          kind: 'dash-audio',
          source: 'dash-mpd',
          frameId: Number(manifestCandidate.frameId) || 0,
          mimeType,
          codecs,
          bitrate: Math.max(0, Number(representation.getAttribute('bandwidth')) || 0),
          audioClass: 'standard',
          identityConfidence: 'manifest-audio-representation'
        });
      }
    }
  }
  output.sort((a, b) =>
    Number(/audio\/mp4/i.test(b.mimeType || '')) - Number(/audio\/mp4/i.test(a.mimeType || '')) ||
    Math.abs((Number(a.bitrate) || 128000) - 128000) - Math.abs((Number(b.bitrate) || 128000) - 128000));
  state.metrics.genericDashRepresentations = output.length;
  if (!output.length) {
    throw new Error('MPD 没有发现可直接读取的完整/SegmentBase 音频 Representation；SegmentTemplate/List 暂回退实时取音');
  }
  return output;
}

async function downloadDirectAudio(state) {
  const errors = [];
  let headerRuleActive = false;
  let headerCleanupHandedOff = false;
  let selectedProbe = null;
  try {
    try {
      headerRuleActive = await acquireDirectRequestHeaders(state);
    } catch (error) {
      state.metrics.bilibiliRefererRuleError = errorText(error);
      errors.push(`临时 Referer：${errorText(error)}`);
    }
    let candidates = (state.directSource.candidates || []).filter(candidate =>
      !candidate.videoId || !state.directSource.videoId || candidate.videoId === state.directSource.videoId);
    if (candidates.some((candidate) => candidate.kind === 'dash-manifest' || /\.mpd(?:$|[?#])/i.test(candidate.url || ''))) {
      const expanded = [];
      for (const candidate of candidates) {
        if (!(candidate.kind === 'dash-manifest' || /\.mpd(?:$|[?#])/i.test(candidate.url || ''))) {
          expanded.push(candidate);
          continue;
        }
        state.pageFetchFrameId = Number(candidate.frameId) || 0;
        try {
          expanded.push(...await resolveGenericDashAudioCandidates(state, candidate));
        } catch (error) {
          errors.push(`${candidate.source || 'dash-manifest'}：${errorText(error)}`);
        }
      }
      candidates = expanded;
    }
    if (candidates.length) {
      selectedProbe = await selectBilibiliDashCandidate(state, candidates);
      state.metrics.dashCandidatesProbed = candidates.filter((candidate) => candidate?.kind === 'dash-audio').length;
      // Range 竞速只决定优先尝试谁，不能决定 DASH 候选是否存在。某些 CDN
      // 会拒绝/忽略小 Range，却允许直接下载完整 m4s；旧逻辑在探测全败时
      // 把所有 dash-audio 都删掉，等于拿到了猫抓同款 URL 却从未真正读取。
      candidates = selectedProbe
        ? [selectedProbe.candidate, ...candidates.filter((candidate) => candidate !== selectedProbe.candidate)]
        : candidates;
    }
    for (const candidate of candidates) {
    if (state.stopping || activeSession !== state) throw engineError('任务已停止', 'TASK_CANCELLED');
    if (candidate.videoId && state.directSource.videoId && candidate.videoId !== state.directSource.videoId) {
      errors.push('候选视频身份与当前播放器不一致，已丢弃');
      continue;
    }
    let candidateHost = '';
    try { candidateHost = new URL(candidate.url).hostname; } catch {}
    const candidateLabel = [candidate.source || candidate.kind || 'media', candidateHost]
      .filter(Boolean).join('@');
    state.metrics.directCandidateCount = state.directSource.candidates.length;
    state.metrics.directCandidatesTried = (Number(state.metrics.directCandidatesTried) || 0) + 1;
    state.metrics.lastAudioCandidate = candidateLabel;
    const rememberCandidate = () => {
      state.metrics.audioCandidate = candidateLabel;
      state.metrics.audioCandidateSource = String(candidate.source || candidate.kind || 'media');
      state.metrics.audioCandidateHost = candidateHost;
      state.metrics.audioCandidateMime = String(candidate.mimeType || '');
      state.metrics.audioCandidateBitrate = Math.max(0, Number(candidate.bitrate) || 0);
    };
    state.pageFetchFrameId = Number(candidate.frameId) || 0;
    let buffer = null;
    if (candidate.kind === 'dash-manifest' || /\.mpd(?:$|[?#])/i.test(candidate.url || '')) {
      errors.push(`${candidateLabel}：DASH MPD 未解析出可直接读取的音频表示，改用实时取音`);
      continue;
    }
    if (candidate.kind === 'local-upload') {
      const token = String(candidate.token || candidate.url || '').replace(/^bscg-local:/, '');
      const upload = localUploads.get(token);
      try {
        if (upload?.complete) {
          upload.lastUsedAt = Date.now();
          buffer = joinByteArrays(upload.chunks);
        } else {
          buffer = await readLocalMediaFile(token);
        }
        if (!buffer) throw new Error('浏览器内文件缓存不存在或已经过期');
        state.metrics.audioDownloadBytes = buffer.byteLength;
        state.metrics.audioDownloadTotal = buffer.byteLength;
        state.metrics.audioContainer = sniffCompleteAudioAsset(buffer);
        rememberCandidate();
        return buffer;
      } catch (localError) {
        errors.push(`本地文件：${errorText(localError)}`);
        continue;
      }
    }
    if (candidate.kind === 'hls' || /\.m3u8(?:$|[?#])/i.test(candidate.url || '')) {
      try {
        const hls = await downloadHlsAudio(state, candidate.url);
        sniffCompleteAudioAsset(hls.initialWindow.buffer);
        rememberCandidate();
        if (headerRuleActive) { headerCleanupHandedOff = true; state.hlsHeaderLease = true; }
        return hls;
      } catch (hlsError) {
        state.hlsSource?.dispose();
        state.hlsSource = null;
        if (hlsError?.code === 'TASK_CANCELLED') throw hlsError;
        errors.push(`${candidateLabel} HLS：${errorText(hlsError)}`);
        continue;
      }
    }
    let probe = selectedProbe?.candidate === candidate ? selectedProbe : null;
    if (!probe && (candidate.kind === 'muxed-video' || /mp4|m4a|mp4a/i.test(candidate.mimeType || '') ||
        /\.(mp4|m4a|m4v|mov)(?:$|[?#])/i.test(candidate.url || ''))) {
      try { probe = await probeDirectCandidate(state, candidate); }
      catch (error) {
        if (error?.code === 'TASK_CANCELLED') throw error;
        errors.push(`${candidateLabel} MP4 范围探测：${errorText(error)}`);
      }
    }
    if (probe?.container === 'mp4' && (!candidate.audioClass || candidate.audioClass === 'standard')) {
      try {
        const progressive = await downloadProgressiveMp4Audio(state, probe);
        rememberCandidate();
        if (headerRuleActive && !progressive.complete) {
          headerCleanupHandedOff = true;
          void progressive.fullAudioPromise.then(
            () => releaseDirectRequestHeaders(state),
            () => releaseDirectRequestHeaders(state)
          );
        }
        return progressive;
      } catch (progressiveError) {
        if (progressiveError?.code === 'TASK_CANCELLED') throw progressiveError;
        errors.push(`${candidateLabel} 渐进解码：${errorText(progressiveError)}`);
        if (progressiveError?.code === 'DIRECT_AUDIO_FAILED') continue;
      }
    }
    try {
      buffer = await fetchAudioFromExtension(state, candidate.url, probe);
    } catch (error) {
      if (error?.code === 'TASK_CANCELLED') throw error;
      errors.push(`${candidateLabel} 扩展直取：${errorText(error)}`);
      try {
        state.statusText = 'CDN 拒绝扩展直取，正在借用当前页面的登录态读取音轨…';
        sendEvent(state, 'status');
        buffer = await fetchAudioThroughPage(state, candidate.url);
      } catch (pageError) {
        if (pageError?.code === 'TASK_CANCELLED') throw pageError;
        errors.push(`${candidateLabel} 页面代理：${errorText(pageError)}`);
      }
    }
    if (!buffer) continue;
    try {
      state.metrics.audioContainer = sniffCompleteAudioAsset(buffer);
      rememberCandidate();
      return buffer;
    } catch (containerError) {
      errors.push(`${candidateLabel} 容器校验：${errorText(containerError)}`);
    }
  }
    state.metrics.directFailureTail = errors.slice(-4).join('；');
    throw new Error(`无法读取独立音轨。${state.metrics.directFailureTail}。已自动准备实时取音后备。`);
  } finally {
    if (headerRuleActive && !headerCleanupHandedOff) await releaseDirectRequestHeaders(state);
  }
}

async function decodeDirectAudio(state, compressed, quiet = false) {
  if (!quiet) {
    state.statusText = '正在浏览器内解封装并解码为 16 kHz 单声道 PCM…';
    sendEvent(state, 'status');
  }
  const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'playback' });
  try {
    const buffer = await audioContext.decodeAudioData(compressed);
    if (buffer.duration > 6 * 60 * 60) throw new Error('音轨超过 6 小时安全限制');
    const mono = new Float32Array(buffer.length);
    let loudestChannel = 0;
    let loudestChannelRms = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      let energy = 0;
      for (let index = 0; index < data.length; index += 1) {
        const sample = data[index];
        mono[index] += sample / buffer.numberOfChannels;
        energy += sample * sample;
      }
      const channelRms = Math.sqrt(energy / Math.max(1, data.length));
      if (channelRms > loudestChannelRms) {
        loudestChannelRms = channelRms;
        loudestChannel = channel;
      }
    }
    const mixedRms = rmsOf(mono);
    // A straight L/R average can almost erase speech when a source contains
    // anti-phase or a silent companion channel. In that case use the strongest
    // channel; normal stereo keeps the quieter arithmetic downmix.
    const useLoudestChannel = buffer.numberOfChannels > 1 &&
      loudestChannelRms > 0 && mixedRms < loudestChannelRms * 0.5;
    if (useLoudestChannel) mono.set(buffer.getChannelData(loudestChannel));
    state.metrics.inputSampleRate = buffer.sampleRate;
    state.metrics.decodedChannels = buffer.numberOfChannels;
    state.metrics.downmixMode = useLoudestChannel ? `channel-${loudestChannel + 1}` : 'average';
    state.metrics.mixedAudioRms = mixedRms;
    state.metrics.loudestChannelRms = loudestChannelRms;
    state.metrics.capturedAudioSeconds = mono.length / buffer.sampleRate;
    state.metrics.decodedPcmBytes = mono.byteLength;
    const output = buffer.sampleRate === TARGET_SAMPLE_RATE ? mono : resampleTo16k(mono, buffer.sampleRate);
    state.metrics.directAudioRms = rmsOf(output);
    state.metrics.directDecodedSeconds = output.length / TARGET_SAMPLE_RATE;
    return output;
  } catch (error) {
    throw new Error(`Chrome 无法解码该独立音轨：${errorText(error)}。可改用“实时捕获”。`);
  } finally {
    await audioContext.close().catch(() => {});
  }
}

function splitDirectAudio(audio, timelineOffset = 0, firstSample = 0, maxSeconds = 11.5) {
  const segments = [];
  const totalSamples = audio.length;
  const minSearch = Math.round(0.7 * TARGET_SAMPLE_RATE);
  const maxWindow = Math.round(maxSeconds * TARGET_SAMPLE_RATE);
  const analysisWindow = Math.round(0.02 * TARGET_SAMPLE_RATE);
  const silenceNeeded = Math.round(0.54 * TARGET_SAMPLE_RATE);
  let start = Math.max(0, Math.min(totalSamples, Math.round(firstSample) || 0));
  while (start < totalSamples) {
    const hardEnd = Math.min(totalSamples, start + maxWindow);
    let end = hardEnd;
    let boundary = 'end';
    if (hardEnd - start > minSearch + analysisWindow) {
      let bestEnergy = Infinity;
      let quietSamples = 0;
      let quietStart = 0;
      let bestEnd = hardEnd;
      let speechEnergy = 0;
      for (let at = start + minSearch; at + analysisWindow <= hardEnd; at += analysisWindow) {
        const energy = rmsOf(audio.subarray(at, at + analysisWindow));
        speechEnergy = Math.max(speechEnergy, energy);
        if (energy < Math.max(DIRECT_SILENCE_RMS, speechEnergy * 0.08)) {
          if (!quietSamples) quietStart = at;
          quietSamples += analysisWindow;
          if (quietSamples >= silenceNeeded) {
            end = quietStart + Math.floor(quietSamples / 2);
            boundary = 'silence';
            break;
          }
        } else quietSamples = 0;
        if (at >= start + maxWindow * 0.75 && energy < bestEnergy) {
          bestEnergy = energy;
          bestEnd = at + Math.floor(analysisWindow / 2);
        }
      }
      if (boundary !== 'silence' && hardEnd < totalSamples) { end = bestEnd; boundary = 'max-window'; }
    }
    if (end <= start) end = hardEnd;
    const energy = rmsOf(audio.subarray(start, end));
    segments.push({
      fromSample: start,
      toSample: end,
      startVideo: timelineOffset + start / TARGET_SAMPLE_RATE,
      endVideo: timelineOffset + end / TARGET_SAMPLE_RATE,
      energy,
      boundary,
      silent: energy < DIRECT_SILENCE_RMS
    });
    start = end;
  }
  return segments;
}

function resetDirectSegmentsAt(state, startTime) {
  const timelineOffset = Math.max(0, Number(state.directAudioBaseTime) || 0);
  const availableEnd = timelineOffset + (state.directAudio?.length || 0) / TARGET_SAMPLE_RATE;
  const wanted = Math.max(timelineOffset, Number(startTime) || timelineOffset);
  if (!state.directAudio?.length || wanted >= availableEnd - 0.05) {
    state.directSegments = [];
    state.directIndex = 0;
    return false;
  }
  const firstSample = Math.max(0, Math.round((wanted - timelineOffset) * TARGET_SAMPLE_RATE));
  state.directSegments = splitDirectAudio(state.directAudio, timelineOffset, firstSample,
    state.asrProfile === 'qwen3_asr_0_6b' ? MAX_PHRASE_SECONDS : SENSEVOICE_MAX_PHRASE_SECONDS);
  state.directIndex = 0;
  return state.directSegments.length > 0;
}

function activateLowLevelDirectSegments(state, rejectDigitalSilence = false) {
  const segments = state.directSegments || [];
  const nonSilent = segments.filter((segment) => !segment.silent).length;
  state.metrics.directSegments = segments.length;
  state.metrics.directNonSilentSegments = nonSilent;
  if (!segments.length || nonSilent) return nonSilent;
  const strongestRms = Math.max(0, ...segments.map((segment) => Number(segment.energy) || 0));
  state.metrics.directStrongestSegmentRms = strongestRms;
  if (rejectDigitalSilence && strongestRms <= DIRECT_DIGITAL_SILENCE_RMS) {
    throw engineError('独立音轨解码后只有数字静音，已拒绝以 0 段结束', 'DIRECT_AUDIO_FAILED');
  }
  if (strongestRms > DIRECT_DIGITAL_SILENCE_RMS) {
    for (const segment of segments) segment.silent = false;
    state.metrics.lowLevelAudioForced = true;
    state.metrics.directNonSilentSegments = segments.length;
    return segments.length;
  }
  return 0;
}

function prepareCompleteDirectSegments(state, startTime) {
  const decodedSeconds = (state.directAudio?.length || 0) / TARGET_SAMPLE_RATE;
  const expectedSeconds = Math.max(0, Number(state.directSource?.duration) || 0);
  state.metrics.directDecodedSeconds = decodedSeconds;
  state.metrics.directExpectedSeconds = expectedSeconds;
  state.metrics.directRequestedStart = Math.max(0, Number(startTime) || 0);
  if (decodedSeconds < 0.5) {
    throw engineError(`独立音轨只解码出 ${decodedSeconds.toFixed(2)} 秒，内容不完整`, 'DIRECT_AUDIO_FAILED');
  }
  if (expectedSeconds >= 30 && decodedSeconds + 8 < expectedSeconds && decodedSeconds / expectedSeconds < 0.85) {
    throw engineError(
      `独立音轨时长不匹配：页面 ${expectedSeconds.toFixed(1)} 秒，实际解码 ${decodedSeconds.toFixed(1)} 秒`,
      'DIRECT_AUDIO_FAILED'
    );
  }
  validateDirectMediaDuration(decodedSeconds, expectedSeconds, '完整解码音轨');
  if (!resetDirectSegmentsAt(state, startTime)) {
    const availableEnd = Math.max(0, Number(state.directAudioBaseTime) || 0) + decodedSeconds;
    throw engineError(
      `当前播放位置 ${Math.max(0, Number(startTime) || 0).toFixed(1)} 秒不在已解码音轨范围内（末尾 ${availableEnd.toFixed(1)} 秒）`,
      'DIRECT_AUDIO_FAILED'
    );
  }
  activateLowLevelDirectSegments(state, true);
  return true;
}

function maybeResumeDirectPlayback(state) {
  const current = estimateVideoTime(state);
  state.metrics.aheadSeconds = Math.max(0, state.directCompletedThrough - current);
  const allScheduled = state.directSourceComplete && state.directIndex >= state.directSegments.length;
  const finished = allScheduled && state.pending.size === 0;
  const inferenceRtf = Math.max(0, Number(state.metrics.avgRtf ?? state.metrics.lastRtf) || 0);
  const targetLead = Math.max(DIRECT_MIN_LEAD_SECONDS,
    Math.min(DIRECT_MAX_LEAD_SECONDS, DIRECT_LEAD_SECONDS + inferenceRtf * 0.75));
  state.metrics.targetLeadSeconds = targetLead;
  // Report the first usable lookahead once. This is a readiness metric only;
  // subtitle generation never pauses or resumes playback.
  if (state.resumeSent) return;
  if (state.metrics.aheadSeconds >= targetLead || finished) {
    state.resumeSent = true;
    sendEvent(state, 'status', {
      statusText: `首个自然语句已完成（自适应水位 ${targetLead.toFixed(1)} 秒），继续预生成字幕。`
    });
  }
}

function dispatchNextDirectSegment(state) {
  if (activeSession !== state || state.stopping || !state.modelReady || state.sourceMode !== 'direct' ||
      state.pending.size || state.directInFlightPhraseId || ((state.hlsSource || state.dashSource) && state.hlsLoadingGeneration === state.directGeneration)) return;
  if (state.directContinuationError) {
    const error = state.directContinuationError;
    state.directContinuationError = null;
    void failSession(state, error);
    return;
  }
  const playbackRate = Math.max(0.1, Number(state.clock?.playbackRate) || 1);
  const targetAhead = Math.min(120, Math.max(20, playbackRate * (20 + (Number(state.metrics.avgRtf) || 0) * 15 +
    (Number(state.metrics.translationLatencyP95Ms) || 0) / 1000)));
  state.metrics.recognizedTo = state.directCompletedThrough;
  state.metrics.targetAheadSeconds = targetAhead;
  if (state.rollingLookahead && state.directCompletedThrough - estimateVideoTime(state) >= targetAhead) return;
  while (state.directIndex < state.directSegments.length) {
    if (state.rollingLookahead && state.directCompletedThrough - estimateVideoTime(state) >= targetAhead) return;
    const segment = state.directSegments[state.directIndex++];
    if (segment.silent) {
      state.directCompletedThrough = segment.endVideo;
      state.metrics.recognizedTo = state.directCompletedThrough;
      maybeResumeDirectPlayback(state);
      continue;
    }
    const audio = state.directAudio.slice(segment.fromSample, segment.toSample);
    state.directAttemptedSegments += 1;
    const phraseId = ++state.phraseSequence;
    const audioSeconds = audio.length / TARGET_SAMPLE_RATE;
    state.pending.set(phraseId, {
      phraseId,
      startVideo: segment.startVideo,
      endVideo: segment.endVideo,
      audioSeconds,
      reason: segment.boundary || 'direct-track',
      direct: true
    });
    state.metrics.queueLength = 1;
    state.metrics.queuedAudioSeconds = audioSeconds;
    state.directInFlightPhraseId = phraseId;
    state.status = 'running';
    state.statusText = `音轨前瞻：正在识别 ${state.directIndex}/${state.directSegments.length} 段…`;
    sendEvent(state, 'running');
    postWorkerMessage(state, 'transcribe', {
      sessionId: state.sessionId,
      phraseId,
      direct: true,
      audio: audio.buffer
    }, [audio.buffer]);
    return;
  }

  maybeResumeDirectPlayback(state);
  if (!state.pending.size) {
    if (!state.directSourceComplete) {
      if (state.hlsSource || state.dashSource) {
        state.directCompletedThrough = Math.max(state.directCompletedThrough, state.hlsWindowEnd);
        void loadNextHlsWindow(state);
        return;
      }
      state.status = 'running';
      const label = state.metrics.dashProgressive ? 'DASH' : 'HLS';
      state.statusText = `首批 ${label} 已识别到 ${state.directCompletedThrough.toFixed(1)} 秒；正在后台续取剩余音频…`;
      sendEvent(state, 'running');
      return;
    }
    if (state.directContinuationError) {
      const error = state.directContinuationError;
      state.directContinuationError = null;
      void failSession(state, error);
      return;
    }
    state.metrics.pipelineRtf = state.metrics.capturedAudioSeconds > 0
      ? (performance.now() - state.pipelineStartedAt) / 1000 / state.metrics.capturedAudioSeconds
      : null;
    if (!state.directAttemptedSegments && !state.cues.length && !state.hlsSource && !state.dashSource) {
      void failSession(state, engineError(
        '独立音轨没有产生可提交的音频分段，已拒绝以 0 段正常结束',
        'DIRECT_AUDIO_FAILED'
      ));
      return;
    }
    state.directAudio = null;
    state.hlsSource?.dispose();
    state.dashSource?.dispose();
    finalizeStopped(state, 'direct-complete');
  }
}

function prefetchHlsWindow(state) {
  if (!state.hlsSource || state.stopping || state.hlsWindowComplete || state.hlsPrefetch || state.hlsLoadingGeneration === state.directGeneration) return;
  const time = state.hlsWindowEnd;
  const generation = state.directGeneration;
  const promise = state.hlsSource.readWindow(time);
  void promise.catch(() => {});
  state.hlsPrefetch = { time, generation, promise };
}

async function decodeHlsWindow(state, window) {
  const audio = await decodeDirectAudio(state, window.buffer, true);
  const expected = window.end - window.start;
  const seconds = audio.length / TARGET_SAMPLE_RATE;
  if (seconds < 0.05 || Math.abs(seconds - expected) > Math.max(2, expected * 0.15)) {
    throw engineError(`HLS 窗口时长不匹配：清单 ${expected.toFixed(2)} 秒，解码 ${seconds.toFixed(2)} 秒`, 'DIRECT_AUDIO_FAILED');
  }
  if (!state.metrics.hlsDecodedNotice) {
    state.metrics.hlsDecodedNotice = true;
    state.statusText = `HLS 前瞻取音已就绪：${window.start.toFixed(1)}–${window.end.toFixed(1)} 秒，` +
      `PCM ${seconds.toFixed(1)} 秒；扩展直取 ${state.metrics.resourceExtensionReads || 0} 次，页面代理 ${state.metrics.resourcePageReads || 0} 次。`;
    sendEvent(state, 'status');
  }
  // Decoder padding must not accumulate at successive window boundaries.
  return audio.length > Math.round(expected * TARGET_SAMPLE_RATE)
    ? audio.slice(0, Math.round(expected * TARGET_SAMPLE_RATE)) : audio;
}

async function loadNextHlsWindow(state, requestedTime = null) {
  const source = state.hlsSource || state.dashSource;
  if (!source || state.stopping || activeSession !== state) return;
  const label = state.hlsSource ? 'HLS' : 'DASH';
  const generation = state.directGeneration;
  if (state.hlsLoadingGeneration === generation) return;
  state.hlsLoadingGeneration = generation;
  const time = Math.max(0, requestedTime ?? Math.max(state.directCompletedThrough, estimateVideoTime(state)));
  try {
    const prefetched = state.hlsPrefetch;
    state.hlsPrefetch = null;
    const usePrefetch = prefetched?.generation === generation && time >= prefetched.time && time < prefetched.time + HLS_WINDOW_SECONDS;
    if (prefetched && !usePrefetch) source.cancelWindow();
    const window = await (usePrefetch ? prefetched.promise : source.readWindow(time));
    if (activeSession !== state || state.stopping || generation !== state.directGeneration) return;
    if (!window) {
      state.directSourceComplete = true;
      state.directSegments = [];
      state.directIndex = 0;
      return;
    }
    const audio = window.audio || await decodeHlsWindow(state, window);
    if (activeSession !== state || state.stopping || generation !== state.directGeneration) return;
    await processDirectVoiceBuffer(state, audio, true);
    if (activeSession !== state || state.stopping || generation !== state.directGeneration) return;
    state.directAudio = audio;
    state.directAudioBaseTime = window.start;
    state.hlsWindowEnd = window.end;
    state.hlsWindowComplete = window.complete;
    state.directSourceComplete = window.complete;
    state.metrics.decodedTo = window.start + audio.length / TARGET_SAMPLE_RATE;
    const countKey = state.hlsSource ? 'hlsWindowsDecoded' : 'dashWindowsDecoded';
    state.metrics[countKey] = (state.metrics[countKey] || 0) + 1;
    state.metrics.decodedPcmBytes = audio.byteLength;
    state.metrics.hlsPcmWindowSeconds = audio.length / TARGET_SAMPLE_RATE;
    resetDirectSegmentsAt(state, time);
    activateLowLevelDirectSegments(state, false);
    // 这行文本会随 audio-ready 事件经 sendEvent 上报，后台把它记成
    // [browser/lookahead] 日志（见 background.js 的日志区块约定）。
    // 改这里的措辞等于改日志可读性；不要删掉时间区间，它是对齐播放头算提前量的依据。
    state.statusText = `${label} 滚动前瞻：${time.toFixed(1)}–${window.end.toFixed(1)} 秒音频已解码。`;
    sendEvent(state, 'audio-ready');
  } catch (error) {
    if (activeSession !== state || state.stopping || generation !== state.directGeneration) return;
    state.directContinuationError = withErrorCode(engineError(`${label} 窗口读取失败：${errorText(error)}`, error?.code), 'DIRECT_AUDIO_FAILED');
    state.directSourceComplete = true;
  } finally {
    if (state.hlsLoadingGeneration === generation) state.hlsLoadingGeneration = null;
    if (activeSession === state && !state.stopping && generation === state.directGeneration) {
      prefetchHlsWindow(state);
      dispatchNextDirectSegment(state);
    }
  }
}

async function finishProgressiveDash(state, source) {
  try {
    await source.fullAudioPromise;
    if (activeSession !== state || state.stopping) return;
    state.metrics.dashBackgroundComplete = true;
  } catch (error) {
    if (activeSession !== state || state.stopping) return;
    state.directContinuationError = withErrorCode(error, 'DIRECT_AUDIO_FAILED');
    state.directSourceComplete = true;
    dispatchNextDirectSegment(state);
  }
}

async function beginDirectSession(message) {
  ensureModelDownloadIdle(message);
  if (activeSession) throw new Error('已有捕获或收尾任务正在运行，请等待它完全停止。');
  forgottenTabs.delete(Number(message.tabId));
  if (!message.directSource?.candidates?.length) throw engineError('没有可读取的独立音轨 URL', 'DIRECT_AUDIO_FAILED');
  const state = {
    sessionId: message.sessionId,
    tabId: Number(message.tabId),
    mediaKey: String(message.mediaKey || ''),
    documentId: String(message.documentId || ''),
    jobId: String(message.jobId || message.sessionId),
    asrProfile: message.asrProfile || DEFAULT_ASR_PROFILE,
    asrLanguage: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(message.asrLanguage) ? message.asrLanguage : 'auto',
    backendMode: normalizeBackendMode(message.asrProfile || DEFAULT_ASR_PROFILE, message.backendMode),
    cpuThreads: Number(message.cpuThreads) || 0,
    voiceEnhance: Boolean(message.voiceEnhance),
    voiceEnhancePreset: normalizeVoicePreset(message.voiceEnhancePreset),
    voiceProcessor: null,
    sourceMode: 'direct',
    title: message.title || '在线视频',
    sourceUrl: message.sourceUrl || '',
    directSource: message.directSource,
    status: 'loading',
    statusText: '正在并行准备模型与独立音轨…',
    stopping: false,
    acceptAudio: false,
    clock: initialCaptureClock(message.initialClock),
    phraseSequence: 0,
    pending: new Map(),
    cues: [],
    previewCue: null,
    directAudio: null,
    directAudioBaseTime: 0,
    rollingLookahead: Boolean(message.rollingLookahead),
    directGeneration: 0,
    hlsLoadingGeneration: null,
    directDuration: 0,
    // 下载与模型异步启动。在第一批 PCM 真正到达前绝不能把音轨标成完整，
    // 否则页面初始化产生的 seeked(0) 会被误判为“0 秒完整音轨”并取消任务。
    directSourceComplete: false,
    directContinuationError: null,
    directStarted: false,
    modelReady: false,
    networkController: new AbortController(),
    directSegments: [],
    directIndex: 0,
    directInFlightPhraseId: null,
    directAttemptedSegments: 0,
    directStartTime: Math.max(0, Number(message.startTime) || 0),
    directCompletedThrough: 0,
    resumeSent: false,
    pipelineStartedAt: performance.now(),
    metrics: {
      backend: '',
      sourceMode: 'direct',
      platform: message.directSource.platform || 'web',
      bitrate: Number(message.directSource.bitrate) || 0,
      threads: 0,
      crossOriginIsolated: self.crossOriginIsolated,
      capturedAudioSeconds: 0,
      queueLength: 0,
      queuedAudioSeconds: 0,
      totalInferenceMs: 0,
      totalInferredAudioSeconds: 0,
      lastRtf: null,
      avgRtf: null,
      aheadSeconds: 0
    },
    metricTimer: null
  };
  activeSession = state;
  // 独立音轨从 CDN 旁路读取，不消费页面正在渲染的 PCM，因此准备模型和
  // 音轨都不应暂停、播放或重建页面播放器。
  sendEvent(state, 'status', {
    statusText: '正在并行准备模型并直接读取独立音轨；页面继续正常播放。'
  });
  state.metricTimer = setInterval(() => void updateResourceMetrics(state, true), 5000);
  void updateResourceMetrics(state, true);

  void (async () => {
    try {
      const [metrics, source] = await Promise.all([
        initializeModelWithFallback(state).then((result) => {
          state.modelReady = true;
          return result;
        }).catch((error) => {
          throw withErrorCode(error, 'MODEL_INIT_FAILED');
        }),
        downloadDirectAudio(state).catch((error) => {
          throw withErrorCode(error, 'DIRECT_AUDIO_FAILED');
        })
      ]);
      if (activeSession !== state || state.stopping) return;
      Object.assign(state.metrics, metrics || {});
      const progressiveHls = source?.kind === 'hls-windowed';
      const progressiveDash = source?.kind === 'dash-progressive';
      const progressive = progressiveHls || progressiveDash;
      state.directDuration = progressive ? Math.max(0, Number(source.duration) || 0) : 0;
      state.directSourceComplete = !progressive || Boolean(source.complete);
      try {
        if (progressiveDash) {
          state.dashSource = source;
          state.directAudio = source.initialAudio;
          state.hlsWindowEnd = state.directAudio.length / TARGET_SAMPLE_RATE;
          state.metrics.decodedTo = state.hlsWindowEnd;
          state.metrics.inputSampleRate = TARGET_SAMPLE_RATE;
          state.metrics.decodedChannels = 1;
          state.metrics.capturedAudioSeconds = state.directAudio.length / TARGET_SAMPLE_RATE;
          state.metrics.directDecodedSeconds = state.metrics.capturedAudioSeconds;
          state.metrics.directAudioRms = rmsOf(state.directAudio);
        } else if (progressiveHls) {
          let window = source.initialWindow;
          for (;;) {
            const generation = state.directGeneration;
            const time = state.directStartTime;
            if (!window || time < window.start || time >= window.end) window = await source.readWindow(time, HLS_STARTUP_SECONDS);
            if (!window) throw engineError('HLS 跳转位置超过音轨末尾', 'DIRECT_AUDIO_FAILED');
            const audio = await decodeHlsWindow(state, window);
            if (activeSession !== state || state.stopping) return;
            if (generation !== state.directGeneration) { window = null; continue; }
            state.directAudio = audio;
            source.timelineOffset = window.start;
            state.hlsWindowEnd = window.end;
            state.hlsWindowComplete = window.complete;
            state.directSourceComplete = window.complete;
            state.metrics.decodedTo = window.start + audio.length / TARGET_SAMPLE_RATE;
            state.metrics.hlsWindowsDecoded = 1;
            source.initialWindow = null;
            break;
          }
        } else {
          state.directAudio = await decodeDirectAudio(state, source);
        }
      } catch (error) {
        throw withErrorCode(error, 'DIRECT_AUDIO_FAILED');
      }
      if (activeSession !== state || state.stopping) return;
      try {
        await processDirectVoice(state);
      } catch (error) {
        throw withErrorCode(error, 'AUDIO_PROCESSING_FAILED');
      }
      if (activeSession !== state || state.stopping) return;
      state.directAudioBaseTime = progressive ? Number(source.timelineOffset) || 0 : 0;
      state.directDuration = Math.max(state.directDuration, state.directAudioBaseTime + state.directAudio.length / TARGET_SAMPLE_RATE);
      state.directCompletedThrough = state.directStartTime;
      if (progressiveHls && (state.directStartTime < state.directAudioBaseTime ||
          state.directStartTime >= state.directAudioBaseTime + state.directAudio.length / TARGET_SAMPLE_RATE)) {
        state.directStarted = true;
        state.directSourceComplete = false;
        void loadNextHlsWindow(state, state.directStartTime);
        return;
      }
      if (state.directSourceComplete && !progressiveHls) {
        prepareCompleteDirectSegments(state, state.directStartTime);
      } else {
        resetDirectSegmentsAt(state, state.directStartTime);
        activateLowLevelDirectSegments(state, false);
      }
      state.directStarted = true;
      state.metrics.directExpectedSeconds = Math.max(0, Number(state.directSource.duration) || Number(source?.duration) || 0);
      state.status = 'running';
      state.statusText = progressive && !state.directSourceComplete
        ? `${progressiveDash ? 'DASH' : 'HLS'} 首批 ${state.metrics.capturedAudioSeconds.toFixed(1)} 秒已就绪；立即开始识别，剩余音频后台续取${voiceControlLabel(state)}。`
        : `独立音轨已解码为 ${state.metrics.capturedAudioSeconds.toFixed(1)} 秒；开始离线前瞻识别${voiceControlLabel(state)}。`;
      sendEvent(state, 'direct-ready');
      dispatchNextDirectSegment(state);
      if (progressiveHls && !state.directSourceComplete) prefetchHlsWindow(state);
      if (progressiveDash && !state.directSourceComplete) void finishProgressiveDash(state, source);
    } catch (error) {
      if (activeSession === state && !state.stopping) await failSession(state, error);
    }
  })();

  return { ok: true, sessionId: state.sessionId, sourceMode: 'direct' };
}

function seekDirectSession(message) {
  const state = activeSession;
  if (!state || state.sourceMode !== 'direct' || state.stopping || (message.sessionId && message.sessionId !== state.sessionId)) {
    throw new Error('浏览器前瞻音轨任务不存在');
  }
  if (Number.isInteger(message.directGeneration) && message.directGeneration <= (state.directGeneration || 0)) {
    return { ok: true, ignored: true };
  }
  const duration = state.directSourceComplete
    ? state.directDuration || (state.directAudioBaseTime + (state.directAudio?.length || 0) / TARGET_SAMPLE_RATE)
    : Number(state.directSource?.duration) || 0;
  const startTime = Math.max(0, Math.min(duration || Infinity, Number(message.currentTime) || 0));
  state.directStartTime = startTime;
  state.directGeneration = Number.isInteger(message.directGeneration)
    ? message.directGeneration : (state.directGeneration || 0) + 1;
  state.metrics.recognizedTo = startTime;
  state.metrics.translatedThrough = startTime;
  // B 站播放器在绑定、换 P 或 MSE 初始化时会主动触发 seeked(0)。直取会话
  // 已经登记但异步 fetch 尚未返回时，只记录目标时间；不能清队列、不能判定
  // 越界，更不能把合法的 m4s 下载任务取消掉。
  if (!state.directStarted) {
    state.directCompletedThrough = startTime;
    state.metrics.directDeferredSeekCount = (Number(state.metrics.directDeferredSeekCount) || 0) + 1;
    state.statusText = `已记录跳转位置 ${formatTimestamp(startTime).slice(0, 8)}；独立音轨首批 PCM 就绪后从这里开始识别。`;
    sendEvent(state, 'status');
    return { ok: true, deferred: true, currentTime: startTime, waitingForSource: true };
  }
  state.pending.clear();
  state.hlsSource?.cancelWindow();
  state.dashSource?.cancelWindow();
  state.hlsPrefetch = null;
  state.hlsLoadingGeneration = null;
  // Keep directInFlightPhraseId until the old reply releases the worker. Repeated
  // seeks only replace the desired segments, never queue more obsolete inference.
  state.metrics.queueLength = 0;
  state.metrics.queuedAudioSeconds = 0;
  state.previewCue = null;
  const available = startTime >= (Number(state.directAudioBaseTime) || 0) && resetDirectSegmentsAt(state, startTime);
  if (!available && (state.hlsSource || state.dashSource)) {
    state.directSegments = [];
    state.directIndex = 0;
    state.directSourceComplete = false;
    state.directAudio = null;
    state.directCompletedThrough = startTime;
    void loadNextHlsWindow(state, startTime);
    return { ok: true, currentTime: startTime, waitingForSource: true };
  }
  if (available) activateLowLevelDirectSegments(state, false);
  state.directCompletedThrough = startTime;
  state.resumeSent = false;
  const progressiveLabel = state.metrics.dashProgressive ? 'DASH' : 'HLS';
  state.statusText = available
    ? `已跳转到 ${formatTimestamp(startTime).slice(0, 8)}，正在重新生成前瞻字幕…`
    : state.directSourceComplete
      ? `已跳转到 ${formatTimestamp(startTime).slice(0, 8)}，该位置没有可识别音频。`
      : `已跳转到 ${formatTimestamp(startTime).slice(0, 8)}，正在等待 ${progressiveLabel} 后台音频到达…`;
  // seek 只重新切分已经独立取得的 PCM，不控制页面播放。
  sendEvent(state, 'status', { statusText: state.statusText });
  if (!available && state.directSourceComplete) {
    const failure = engineError(
      `跳转位置 ${startTime.toFixed(1)} 秒不在已解码音轨范围内，已停止当前直取任务`,
      'DIRECT_AUDIO_FAILED'
    );
    void failSession(state, failure);
    return { ok: false, error: failure.message, errorCode: failure.code };
  }
  dispatchNextDirectSegment(state);
  return { ok: true, currentTime: startTime, segmentIndex: state.directIndex, waitingForSource: !available && !state.directSourceComplete };
}

async function beginExternalSession(message) {
  ensureModelDownloadIdle(message);
  if (activeSession) throw new Error('已有捕获或收尾任务正在运行，请等待它完全停止。');
  forgottenTabs.delete(Number(message.tabId));
  const state = {
    sessionId: message.sessionId,
    tabId: Number(message.tabId),
    mediaKey: String(message.mediaKey || ''),
    documentId: String(message.documentId || ''),
    jobId: String(message.jobId || message.sessionId),
    asrProfile: message.asrProfile || DEFAULT_ASR_PROFILE,
    asrLanguage: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(message.asrLanguage) ? message.asrLanguage : 'auto',
    backendMode: normalizeBackendMode(message.asrProfile || DEFAULT_ASR_PROFILE, message.backendMode),
    cpuThreads: Number(message.cpuThreads) || 0,
    voiceEnhance: Boolean(message.voiceEnhance),
    voiceEnhancePreset: normalizeVoicePreset(message.voiceEnhancePreset),
    voiceProcessor: null,
    sourceMode: 'capture',
    isLive: Boolean(message.isLive), liveAudioSeconds: 0,
    clockIndependent: Boolean(message.clockIndependent),
    title: message.title || '在线视频',
    sourceUrl: message.sourceUrl || '',
    externalInput: true,
    scanMode: Boolean(message.scanMode), scanReady: false,
    previewEnabled: message.rollingPreview !== false,
    maxPhraseSeconds: Number(message.maxPhraseSeconds) ||
      (message.asrProfile === 'sensevoice_browser' ? SENSEVOICE_MAX_PHRASE_SECONDS : MAX_PHRASE_SECONDS),
    status: 'loading',
    statusText: '页面内音频通道已连接；正在准备模型…',
    inputRate: TARGET_SAMPLE_RATE,
    acceptAudio: true,
    modelReady: false,
    warmupChunks: [],
    warmupSamples: 0,
    modelInitPromise: null,
    stopping: false,
    clock: initialCaptureClock(message.initialClock),
    preRoll: [],
    phraseChunks: [],
    phraseSamples: 0,
    phraseStartVideo: null,
    phraseTokenSequence: 0,
    activePhraseToken: null,
    phraseVoiced: false,
    silenceSamples: 0,
    noiseFloor: 0.003,
    phraseSequence: 0,
    pending: new Map(),
    cues: [],
    previewCue: null,
    previewInFlight: false,
    previewRevisionSequence: 0,
    previewThrottleToken: null,
    previewCountToken: null,
    previewCountForToken: 0,
    previewHypothesisToken: null,
    previewHypothesisText: '',
    lastPreviewSamples: 0,
    metrics: {
      backend: '', sourceMode: 'capture', threads: 0,
      crossOriginIsolated: self.crossOriginIsolated, inputSampleRate: TARGET_SAMPLE_RATE,
      capturedAudioSeconds: 0, queueLength: 0, queuedAudioSeconds: 0,
      totalInferenceMs: 0, totalInferredAudioSeconds: 0, lastRtf: null, avgRtf: null
    },
    metricTimer: null
  };
  activeSession = state;
  sendEvent(state, state.scanMode ? 'pause-for-model' : 'status', {
    statusText: !state.scanMode
      ? '浏览器模型准备中；页面保持播放，模型就绪后开始实时字幕。'
      : '浏览器模型准备中；自动扫描会在模型就绪后开始。'
  });
  state.metricTimer = setInterval(() => void updateResourceMetrics(state, true), 5000);
  state.modelInitPromise = (async () => {
    try {
      const metrics = await initializeModelWithFallback(state);
      if (activeSession !== state || state.stopping) return;
      Object.assign(state.metrics, metrics || {});
      state.modelReady = true;
      await drainWarmupAudio(state);
      state.acceptAudio = true;
      state.status = 'running';
      state.statusText = !state.scanMode
        ? `页面内取音已使用 ${runtimeLabel(state)}${voiceControlLabel(state)}；按停顿识别整句；字幕允许延后，播放器保持原速。`
        : `页面内取音已使用 ${runtimeLabel(state)}${voiceControlLabel(state)}；开始连续扫描。`;
      if (state.scanMode) sendEvent(state, 'resume-after-model');
      sendEvent(state, 'running');
    } catch (error) {
      if (activeSession === state && !state.stopping) await failSession(state, error);
    }
  })();
  void state.modelInitPromise;
  return { ok: true, sessionId: state.sessionId, externalInput: true };
}

function resetCaptureTimeline(state) {
  resetPhrase(state);
  state.preRoll = [];
  state.warmupChunks = [];
  state.warmupSamples = 0;
  state.lastCaptureTiming = null;
  state.pending.clear();
  state.metrics.queueLength = 0;
  state.metrics.queuedAudioSeconds = 0;
  state.metrics.modelWarmupBufferedSeconds = 0;
  state.metrics.captureSeeks = (Number(state.metrics.captureSeeks) || 0) + 1;
  resumeWarmupDrain(state);
  clearPreviewCue(state);
  // Keep the in-flight marker until the old worker reply arrives. Its phrase
  // ID is no longer pending, so it can release the slot but cannot add a cue.
}

function seekCapturedSession(message) {
  const state = activeSession;
  if (!state?.externalInput || state.sessionId !== message.sessionId || state.stopping) return { ok: true, ignored: true };
  const generation = Math.max(0, Number(message.captureGeneration) || 0);
  if (generation <= (state.captureGeneration || 0)) return { ok: true, ignored: true };
  state.captureGeneration = generation;
  if (state.isLive) return liveCaptureBoundary(state);
  resetCaptureTimeline(state);
  return { ok: true };
}

function liveCaptureBoundary(state) {
  if (!state?.isLive || activeSession !== state || state.stopping) return { ok: true, ignored: true };
  if (!state.modelReady || state.drainingWarmup) {
    if (!state.warmupChunks.at(-1)?.boundary) state.warmupChunks.push({ boundary: true, samples: new Float32Array(0) });
  } else {
    void flushPhrase(state, 'live-interruption');
    state.preRoll = [];
  }
  return { ok: true };
}

function acceptExternalPcm(message) {
  const state = activeSession;
  if (!state?.externalInput || state.sessionId !== message.sessionId || state.stopping) throw new Error('页面内音频任务已经结束');
  if (state.scanMode && !state.scanReady) return { ok: true, ignored: true };
  if (state.scanMode && (message.timing?.speedRestored !== true || Number(message.timing?.playbackRate) !== 1)) {
    throw new Error('拒绝未恢复正常语速的扫描音频，请重新加载扩展并刷新视频页面');
  }
  const generation = Math.max(0, Number(message.captureGeneration) || 0);
  if (generation < (state.captureGeneration || 0)) return { ok: true, ignored: true };
  if (generation > (state.captureGeneration || 0)) seekCapturedSession(message);
  if (Number.isInteger(message.sequence)) {
    if (message.sequence <= (state.lastExternalSequence ?? -1)) return { ok: true, ignored: true };
    state.lastExternalSequence = message.sequence;
  }
  if (String(message.pcmBase64 || '').length > 128000) throw new Error('页面内 PCM 帧过大');
  const bytes = decodeBase64(String(message.pcmBase64 || ''));
  if (!bytes.byteLength || bytes.byteLength % 2) throw new Error('页面内 PCM 分段无效');
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const samples = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) samples[index] = pcm[index] / (pcm[index] < 0 ? 32768 : 32767);
  const timing = Number.isFinite(message.timing?.currentTime) ? {
    currentTime: Math.max(0, message.timing.currentTime),
    playbackRate: Math.max(0.1, Number(message.timing.playbackRate) || 1),
    paused: Boolean(message.timing.paused), speedRestored: Boolean(message.timing.speedRestored)
  } : null;
  if (state.scanMode) handleRestoredScanAudio(state, samples, timing);
  else handleAudioChunk(state, samples, timing);
  return { ok: true };
}

async function beginSession(message) {
  ensureModelDownloadIdle(message);
  if (activeSession) throw new Error('已有捕获或收尾任务正在运行，请等待它完全停止。');
  forgottenTabs.delete(Number(message.tabId));

  const stream = await openTabStream(message);
  const audioContext = new AudioContext({ latencyHint: 'interactive' });
  let source;
  let worklet;
  let silent;
  let playback;
  try {
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
    source = audioContext.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(audioContext, 'bili-asr-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    silent = audioContext.createGain();
    silent.gain.value = 0;

    // 普通实时字幕把声音接回扬声器；自动整轨扫描只静音输出，不改变送入 ASR 的 PCM。
    playback = audioContext.createGain();
    playback.gain.value = message.silentOutput ? 0 : 1;
    source.connect(playback);
    playback.connect(audioContext.destination);
    source.connect(worklet);
    worklet.connect(silent);
    silent.connect(audioContext.destination);
    await audioContext.resume();
  } catch (error) {
    try { stream.getTracks().forEach((track) => track.stop()); } catch {}
    try { await audioContext.close(); } catch {}
    throw error;
  }

  const state = {
    sessionId: message.sessionId,
    tabId: Number(message.tabId),
    mediaKey: String(message.mediaKey || ''),
    documentId: String(message.documentId || ''),
    jobId: String(message.jobId || message.sessionId),
    asrProfile: message.asrProfile || DEFAULT_ASR_PROFILE,
    asrLanguage: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(message.asrLanguage) ? message.asrLanguage : 'auto',
    backendMode: normalizeBackendMode(message.asrProfile || DEFAULT_ASR_PROFILE, message.backendMode),
    cpuThreads: Number(message.cpuThreads) || 0,
    voiceEnhance: Boolean(message.voiceEnhance),
    voiceEnhancePreset: normalizeVoicePreset(message.voiceEnhancePreset),
    voiceProcessor: null,
    sourceMode: 'capture',
    scanMode: Boolean(message.scanMode), scanReady: false,
    isLive: Boolean(message.isLive), liveAudioSeconds: 0,
    clockIndependent: Boolean(message.clockIndependent),
    title: message.title || 'B站视频',
    sourceUrl: message.sourceUrl || '',
    previewEnabled: message.rollingPreview !== false,
    maxPhraseSeconds: Number(message.maxPhraseSeconds) ||
      (message.asrProfile === 'sensevoice_browser' ? SENSEVOICE_MAX_PHRASE_SECONDS : MAX_PHRASE_SECONDS),
    status: 'loading',
    statusText: '已捕获标签页声音；正在准备模型…',
    stream,
    audioContext,
    source,
    playback,
    worklet,
    silent,
    inputRate: message.scanMode ? TARGET_SAMPLE_RATE : audioContext.sampleRate,
    captureSourceRate: audioContext.sampleRate,
    acceptAudio: true,
    modelReady: false,
    warmupChunks: [],
    warmupSamples: 0,
    modelInitPromise: null,
    stopping: false,
    clock: initialCaptureClock(message.initialClock),
    preRoll: [],
    phraseChunks: [],
    phraseSamples: 0,
    phraseStartVideo: null,
    phraseTokenSequence: 0,
    activePhraseToken: null,
    phraseVoiced: false,
    silenceSamples: 0,
    noiseFloor: 0.003,
    phraseSequence: 0,
    pending: new Map(),
    cues: [],
    previewCue: null,
    previewInFlight: false,
    previewRevisionSequence: 0,
    previewThrottleToken: null,
    previewCountToken: null,
    previewCountForToken: 0,
    previewHypothesisToken: null,
    previewHypothesisText: '',
    lastPreviewSamples: 0,
    metrics: {
      backend: '',
      sourceMode: 'capture',
      threads: 0,
      crossOriginIsolated: self.crossOriginIsolated,
      inputSampleRate: audioContext.sampleRate,
      capturedAudioSeconds: 0,
      queueLength: 0,
      queuedAudioSeconds: 0,
      totalInferenceMs: 0,
      totalInferredAudioSeconds: 0,
      lastRtf: null,
      avgRtf: null
    },
    metricTimer: null
  };
  activeSession = state;
  worklet.port.onmessage = (event) => {
    if (event.data?.type === 'flushed') { state.resolveCaptureFlush?.(); return; }
    receiveTabAudio(state, new Float32Array(event.data));
  };
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (activeSession === state && !state.stopping) void stopSession(state, 'stream-ended');
    }, { once: true });
  });

  sendEvent(state, state.scanMode ? 'pause-for-model' : 'status', {
    statusText: !state.scanMode
      ? '模型准备中；页面保持播放，模型就绪后开始实时字幕。'
      : '模型准备期间正在等待自动扫描启动。'
  });
  state.metricTimer = setInterval(() => void updateResourceMetrics(state, true), 5000);
  void updateResourceMetrics(state, true);

  state.modelInitPromise = (async () => {
    try {
      const metrics = await initializeModelWithFallback(state);
      if (activeSession !== state || state.stopping) return;
      Object.assign(state.metrics, metrics || {});
      state.modelReady = true;
      await drainWarmupAudio(state);
      state.acceptAudio = true;
      state.status = 'running';
      state.statusText = `正在用 ${runtimeLabel(state)}${voiceControlLabel(state)} 捕获；按停顿识别整句；字幕允许延后，播放器保持原速。`;
      if (state.scanMode) sendEvent(state, 'resume-after-model');
      sendEvent(state, 'running');
    } catch (error) {
      if (activeSession === state && !state.stopping) await failSession(state, error);
    }
  })();
  void state.modelInitPromise;

  return { ok: true, sessionId: state.sessionId };
}

async function stopAudioGraph(state) {
  // 先恢复直通增益并释放 tabCapture，再拆节点。Chrome 在标签页捕获存活期间会
  // 把原始标签页输出交给捕获流；这个顺序可避免清理异常时把页面遗留在无声状态。
  try { if (state.playback?.gain) state.playback.gain.value = 1; } catch {}
  try { state.stream?.getTracks?.().forEach((track) => track.stop()); } catch {}
  try { state.worklet.port.onmessage = null; } catch {}
  try { state.worklet.disconnect(); } catch {}
  try { state.source.disconnect(); } catch {}
  try { state.playback?.disconnect(); } catch {}
  try { state.silent.disconnect(); } catch {}
  try { await state.audioContext.close(); } catch {}
}

async function stopSession(state, reason = 'user') {
  if (!state || state.stopping) return { ok: true, alreadyStopping: true };
  const discardPending = ['cancelled', 'orphaned-background', 'orphaned-queue-owner', 'tab-closed', 'page-changed', 'tab-switch'].includes(String(reason || ''));
  const preserveNaturalEnd = !discardPending && ['stream-ended', 'media-ended'].includes(String(reason || '')) &&
    state.sourceMode === 'capture' && (!state.modelReady || state.drainingWarmup) && Number(state.warmupSamples) > 0 && state.modelInitPromise;
  if (preserveNaturalEnd) {
    // A short clip can finish while a cold model is still loading. Its final PCM has
    // already reached this session, so let initialization drain the bounded warm-up
    // buffer before closing the phrase. Both natural-end routes have stopped producing input.
    state.status = 'stopping';
    state.statusText = '视频已经播完；正在等待模型就绪并提交已缓存的最后几句…';
    sendEvent(state, 'status');
    await state.modelInitPromise;
    if (activeSession !== state || state.stopping) return { ok: true, alreadyStopping: true };
  }
  if (!discardPending && state.sourceMode === 'capture' && !state.externalInput && state.worklet) {
    state.captureEnding = true;
    state.captureEndTime = reason === 'scan-complete' && state.clock?.duration
      ? state.clock.duration : Math.min(state.clock?.duration || Infinity, estimateVideoTime(state));
    state.captureFlushPromise ||= new Promise(resolve => {
      const timer = setTimeout(resolve, 400);
      state.resolveCaptureFlush = () => { clearTimeout(timer); resolve(); };
      try { state.source.disconnect(state.worklet); state.worklet.port.postMessage({ type: 'flush' }); }
      catch { state.resolveCaptureFlush(); }
    });
    await state.captureFlushPromise;
    state.resolveCaptureFlush = null;
    if (activeSession !== state || state.stopping) return { ok: true, alreadyStopping: true };
    const tail = state.captureResampler?.flush();
    if (tail?.length) handleAudioChunk(state, tail, {
      currentTime: state.captureEndTime, playbackRate: 1, paused: false
    });
  }
  state.stopping = true;
  state.stopReason = reason;
  resumeWarmupDrain(state);
  try { state.networkController?.abort('session-stopped'); } catch {}
  state.hlsSource?.dispose();
  state.dashSource?.dispose();
  cancelInitialization('识别任务已停止，模型初始化已回收', state.sessionId);
  rejectPageFetchWaiters(state, engineError('任务已停止', 'TASK_CANCELLED'));
  state.acceptAudio = false;
  state.warmupChunks = [];
  state.warmupSamples = 0;
  state.status = 'stopping';
  state.statusText = discardPending
    ? '正在立即取消识别任务…'
    : state.sourceMode === 'direct' ? '正在停止音轨前瞻任务…' : '正在提交最后一段音频…';
  if (discardPending) {
    // A tab close/model switch must not wait behind an in-flight WebGPU job.
    // Terminate only the transient worker; downloaded weights remain cached.
    if (reason === 'tab-switch') {
      await cancelInferenceForSwitch(state);
      state.inferenceJob = null;
      state.directInFlightPhraseId = null;
      state.captureInFlightPhraseId = null;
    } else if (state.pending.size || state.previewInFlight) terminateInferenceWorker();
    state.pending.clear();
    state.previewInFlight = false;
    state.metrics.queueLength = 0;
    state.metrics.queuedAudioSeconds = 0;
    resetPhrase(state);
    clearPreviewCue(state);
  } else if (state.sourceMode === 'capture') {
    await flushPhrase(state, 'stop');
  }
  await stopAudioGraph(state);
  state.directAudio = null;
  state.statusText = state.pending.size
    ? `正在等待最后 ${state.pending.size} 段识别完成…`
    : '捕获已停止。';
  // 用户可能在模型仍加载时停止；恢复仅由插件暂停过的视频。
  if (state.scanMode) sendEvent(state, 'resume-after-model');
  sendEvent(state, 'stopping', { reason });
  if (state.pending.size === 0) finalizeStopped(state, reason);
  return { ok: true, stopping: true };
}

function snapshotState(state) {
  return {
    status: state.status,
    statusText: state.statusText,
    asrProfile: state.asrProfile,
    backendMode: state.backendMode,
    cpuThreads: state.cpuThreads,
    sourceMode: state.sourceMode,
    srt: renderSrt(state.cues),
    metrics: { ...state.metrics }
  };
}

function finalizeStopped(state, reason = state?.stopReason || 'user') {
  if (activeSession !== state) return;
  if (state.inferenceJob || state.directInFlightPhraseId || state.previewInFlight) terminateInferenceWorker();
  clearInferenceWatchdog(state);
  try { state.networkController?.abort('session-finished'); } catch {}
  state.hlsSource?.dispose();
  state.dashSource?.dispose();
  cancelInitialization('识别任务已结束，模型初始化已回收', state.sessionId);
  if (state.metricTimer) clearInterval(state.metricTimer);
  state.status = 'stopped';
  state.statusText = reason === 'direct-complete'
    ? `整条独立音轨识别完成，共输出 ${state.cues.length} 条 SRT 字幕。`
    : `已停止，共输出 ${state.cues.length} 条 SRT 字幕。`;
  state.metrics.completionReason = reason;
  Object.assign(state.metrics, visibleHeap());
  if (forgottenTabs.has(state.tabId)) lastStates.delete(state.tabId);
  else lastStates.set(state.tabId, snapshotState(state));
  forgottenTabs.delete(state.tabId);
  sendEvent(state, 'stopped', { reason });
  activeSession = null;
  scheduleModelRelease();
}

async function failSession(state, error) {
  if (!state || activeSession !== state) return;
  const failure = withErrorCode(error, state.sourceMode === 'direct'
    ? (state.directStarted ? 'ASR_RUNTIME_FAILED' : 'DIRECT_PIPELINE_FAILED')
    : (state.status === 'loading' ? 'MODEL_INIT_FAILED' : 'ASR_RUNTIME_FAILED'));
  state.stopping = true;
  if (state.inferenceJob || state.directInFlightPhraseId || state.captureInFlightPhraseId || state.previewInFlight) terminateInferenceWorker();
  clearInferenceWatchdog(state);
  resumeWarmupDrain(state);
  try { state.networkController?.abort('session-failed'); } catch {}
  state.hlsSource?.dispose();
  state.dashSource?.dispose();
  cancelInitialization('识别任务失败，模型初始化已回收', state.sessionId);
  rejectPageFetchWaiters(state, failure);
  state.acceptAudio = false;
  state.warmupChunks = [];
  state.warmupSamples = 0;
  if (state.metricTimer) clearInterval(state.metricTimer);
  await stopAudioGraph(state);
  state.directAudio = null;
  state.status = 'error';
  state.statusText = '浏览器本地识别失败。';
  Object.assign(state.metrics, visibleHeap());
  if (forgottenTabs.has(state.tabId)) lastStates.delete(state.tabId);
  else {
    lastStates.set(state.tabId, {
      ...snapshotState(state),
      error: errorText(failure),
      errorCode: failure.code || ''
    });
  }
  forgottenTabs.delete(state.tabId);
  if (state.scanMode) sendEvent(state, 'resume-after-model');
  sendEvent(state, 'error', { error: errorText(failure), errorCode: failure.code || '' });
  activeSession = null;
  scheduleModelRelease();
}

function updateClock(message, sender) {
  const state = activeSession;
  if (!state || Number(sender.tab?.id || message.tabId) !== state.tabId) return;
  if ((message.sessionId && message.sessionId !== state.sessionId) ||
      (message.mediaKey && state.mediaKey && message.mediaKey !== state.mediaKey)) return;
  const next = {
    currentTime: Math.max(0, Number(message.currentTime) || 0),
    duration: Math.max(0, Number(message.duration) || 0),
    paused: Boolean(message.paused),
    playbackRate: Math.max(0.1, Number(message.playbackRate) || 1),
    preservesPitch: message.preservesPitch,
    receivedAt: performance.now()
  };
  if (state.clock) {
    const expected = estimateVideoTime(state, next.receivedAt);
    if (state.sourceMode === 'capture' && !state.isLive && !state.externalInput &&
        (message.seek || Math.abs(next.currentTime - expected) > 1.6)) resetCaptureTimeline(state);
  }
  state.clock = next;
  if (message.seek && Number.isFinite(message.cachedThrough)) state.captureCachedThrough = Math.max(next.currentTime, message.cachedThrough);
  if (Number.isFinite(message.translatedThrough)) state.metrics.translatedContiguousTo = message.translatedThrough;
  if (Number.isFinite(message.translationLatencyP95Ms)) state.metrics.translationLatencyP95Ms = message.translationLatencyP95Ms;
  if (state.sourceMode === 'direct' && state.directStarted) dispatchNextDirectSegment(state);
}

function benchmarkSnapshot(run = benchmarkRun) {
  if (!run) return null;
  return {
    id: run.id,
    profile: run.profile,
    backend: run.backend,
    status: run.status,
    phase: run.phase,
    statusText: run.statusText,
    progress: run.progress,
    loaded: run.loaded,
    total: run.total,
    measuredSeconds: run.measuredSeconds || 0,
    benchmarkAudioSeconds: run.benchmarkAudioSeconds || 0,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || 0,
    result: run.result || null,
    error: run.error || ''
  };
}

async function loadBenchmarkAudio(state) {
  const response = await fetch(chrome.runtime.getURL('assets/benchmark-speech.mp4'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`读取随包测速音频失败：HTTP ${response.status}`);
  const compressed = await response.arrayBuffer();
  const compressedBytes = compressed.byteLength;
  const decoded = await decodeDirectAudio(state, compressed);
  const targetSamples = 60 * TARGET_SAMPLE_RATE;
  if (decoded.length < targetSamples - TARGET_SAMPLE_RATE) {
    throw new Error(`测速音频不足 59 秒：实际 ${(decoded.length / TARGET_SAMPLE_RATE).toFixed(1)} 秒`);
  }
  return {
    audio: decoded.slice(0, Math.min(decoded.length, targetSamples)),
    compressedBytes
  };
}

function runBenchmarkInference(state, audio, phraseId) {
  if (benchmarkWaiter) return Promise.reject(engineError('已有测速推理正在运行', 'BENCHMARK_BUSY'));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (benchmarkWaiter?.phraseId !== phraseId) return;
      benchmarkWaiter = null;
      reject(engineError('单次测速推理超过 20 分钟，已停止等待', 'BENCHMARK_TIMEOUT'));
    }, 20 * 60 * 1000);
    benchmarkWaiter = { phraseId, resolve, reject, timeout };
    postWorkerMessage(state, 'transcribe', {
      sessionId: state.sessionId,
      phraseId,
      audio: audio.buffer
    }, [audio.buffer]);
  });
}

async function executeBenchmark(run) {
  const state = {
    sessionId: run.id,
    asrProfile: run.profile,
    backendMode: run.backend,
    cpuThreads: run.cpuThreads,
    stopping: false,
    metrics: {}
  };
  try {
    const before = await navigator.storage.estimate().catch(() => ({}));
    const loadStarted = performance.now();
    const metrics = await initializeModel(state);
    if (benchmarkRun !== run || run.status !== 'running') return;
    const modelLoadWallMs = performance.now() - loadStarted;
    run.phase = 'audio';
    run.statusText = '模型已就绪，正在解码一分钟随包真实语音…';
    const benchmarkAsset = await loadBenchmarkAudio(state);
    if (benchmarkRun !== run || run.status !== 'running') return;
    const benchmarkAudio = benchmarkAsset.audio;
    run.benchmarkAudioSeconds = benchmarkAudio.length / TARGET_SAMPLE_RATE;
    run.phase = 'warmup';
    run.statusText = '正在用真实语音执行 2 秒预热…';
    const warmup = await runBenchmarkInference(
      state,
      benchmarkAudio.slice(0, 2 * TARGET_SAMPLE_RATE),
      'benchmark-warmup'
    );
    if (benchmarkRun !== run || run.status !== 'running') return;
    run.phase = 'measuring';
    const expectedPrecision = run.backend === 'wasm' ? 'int8' : 'fp16';
    const chunks = [];
    const chunkSamples = Math.round(7.5 * TARGET_SAMPLE_RATE);
    for (let offset = 0; offset < benchmarkAudio.length; offset += chunkSamples) {
      chunks.push(benchmarkAudio.slice(offset, Math.min(benchmarkAudio.length, offset + chunkSamples)));
    }
    let inferenceMs = 0;
    let audioSeconds = 0;
    let actualBackend = '';
    let actualPrecision = '';
    const texts = [];
    const measureStarted = performance.now();
    for (let index = 0; index < chunks.length; index += 1) {
      run.statusText = `正在识别一分钟真实语音：${index + 1}/${chunks.length} 段…`;
      const chunkAudioSeconds = chunks[index].length / TARGET_SAMPLE_RATE;
      const measured = await runBenchmarkInference(state, chunks[index], `benchmark-measured-${index}`);
      if (benchmarkRun !== run || run.status !== 'running') return;
      actualBackend = String(measured.backend || measured.metrics?.backend || metrics?.backend || '');
      if (actualBackend !== run.backend) {
        throw new Error(`请求 ${run.backend}，Worker 实际返回 ${actualBackend || '未知后端'}；测速拒绝把回退结果计为通过`);
      }
      actualPrecision = String(measured.metrics?.precision || metrics?.precision || '').toLowerCase();
      if (actualPrecision !== expectedPrecision) {
        throw new Error(`请求 ${expectedPrecision.toUpperCase()}，Worker 实际返回 ${actualPrecision.toUpperCase() || '未知精度'}；测速拒绝把其它权重精度计为通过`);
      }
      inferenceMs += Number(measured.inferenceMs) || 0;
      audioSeconds += Number(measured.audioSeconds) || chunkAudioSeconds;
      if (String(measured.text || '').trim()) texts.push(String(measured.text).trim());
      run.measuredSeconds = audioSeconds;
      run.progress = Math.min(100, audioSeconds / run.benchmarkAudioSeconds * 100);
    }
    const benchmarkWallMs = performance.now() - measureStarted;
    const after = await navigator.storage.estimate().catch(() => ({}));
    run.status = 'complete';
    run.phase = 'complete';
    run.statusText = '指定链路模型加载与一分钟真实语音推理均通过。';
    run.finishedAt = Date.now();
    run.progress = 100;
    run.result = {
      profile: run.profile,
      requestedBackend: run.backend,
      actualBackend,
      precision: actualPrecision,
      engine: warmup.metrics?.engine || metrics?.engine || '',
      device: warmup.metrics?.device || metrics?.device || '',
      threads: Number(warmup.metrics?.threads ?? metrics?.threads) || 0,
      requestedCpuThreads: Number(warmup.metrics?.requestedCpuThreads ?? metrics?.requestedCpuThreads ?? run.cpuThreads) || 0,
      hardwareConcurrency: Number(warmup.metrics?.hardwareConcurrency ?? metrics?.hardwareConcurrency ?? navigator.hardwareConcurrency) || 1,
      wasmThreadsAvailable: Boolean(warmup.metrics?.wasmThreadsAvailable ?? metrics?.wasmThreadsAvailable),
      threadingMode: String(warmup.metrics?.threadingMode ?? metrics?.threadingMode ?? ''),
      modelBytes: Number(warmup.metrics?.modelBytes ?? metrics?.modelBytes) || 0,
      warmModel: Boolean(metrics?.warmModel),
      modelLoadWallMs,
      reportedModelLoadMs: Number(metrics?.modelLoadMs) || 0,
      warmupInferenceMs: Number(warmup.inferenceMs) || 0,
      warmupAudioSeconds: Number(warmup.audioSeconds) || 2,
      inferenceMs,
      benchmarkWallMs,
      audioSeconds,
      rtf: audioSeconds > 0 ? inferenceMs / 1000 / audioSeconds : 0,
      wallRtf: audioSeconds > 0 ? benchmarkWallMs / 1000 / audioSeconds : 0,
      benchmarkAssetBytes: benchmarkAsset.compressedBytes,
      benchmarkSegmentCount: chunks.length,
      storageBefore: Number(before.usage) || 0,
      storageAfter: Number(after.usage) || 0,
      text: texts.join(' ')
    };
    scheduleModelRelease();
  } catch (error) {
    if (benchmarkRun !== run || run.status === 'cancelled') return;
    run.status = 'error';
    run.phase = 'error';
    run.statusText = '指定链路测速失败。';
    run.error = errorText(error);
    run.finishedAt = Date.now();
    cancelInitialization('测速失败，模型初始化已回收', run.id);
    terminateInferenceWorker();
  }
}

function startBenchmark(message) {
  if (activeSession) throw new Error('请先停止当前字幕或整轨识别任务');
  if (benchmarkRun?.status === 'running') throw new Error('已有诊断测速正在运行');
  const profile = String(message.profile || '');
  const backend = String(message.backend || '');
  if (!['qwen3_asr_0_6b', 'sensevoice_browser'].includes(profile)) throw new Error('未知 ASR 模型');
  if (!['webgpu', 'wasm'].includes(backend)) throw new Error('测速必须指定 WebGPU 或 WASM，不能使用自动回退');
  if (profile === 'qwen3_asr_0_6b' && backend === 'wasm') throw new Error('Qwen3-ASR CPU 链路已移除；请使用 WebGPU FP16');
  ensureModelDownloadIdle({ asrProfile: profile, backendMode: backend });
  if (backend === 'webgpu' && !navigator.gpu) throw new Error('当前 Chrome 没有暴露 WebGPU');
  benchmarkRun = {
    id: `benchmark-${crypto.randomUUID()}`,
    profile,
    backend,
    cpuThreads: Number(message.cpuThreads) || 0,
    status: 'running',
    phase: 'loading',
    statusText: '正在启动指定模型 Worker；首次运行会下载并缓存权重…',
    progress: 0,
    loaded: 0,
    total: 0,
    measuredSeconds: 0,
    benchmarkAudioSeconds: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    result: null,
    error: ''
  };
  void executeBenchmark(benchmarkRun);
  return { ok: true, benchmark: benchmarkSnapshot() };
}

function cancelBenchmark(message = {}) {
  const run = benchmarkRun;
  if (!run || run.status !== 'running' || (message.id && message.id !== run.id)) return { ok: true, idle: true };
  run.status = 'cancelled';
  run.phase = 'cancelled';
  run.statusText = '测速已取消；未完整写入的网络响应不会作为模型缓存复用。';
  run.finishedAt = Date.now();
  cancelInitialization('诊断测速已取消', run.id, false);
  if (benchmarkWaiter) {
    const waiter = benchmarkWaiter;
    benchmarkWaiter = null;
    clearTimeout(waiter.timeout);
    waiter.reject(engineError('诊断测速已取消', 'INIT_CANCELLED'));
  }
  terminateInferenceWorker();
  return { ok: true, benchmark: benchmarkSnapshot(run) };
}

function startModelDownload(message = {}) {
  if (!self.BscgModelDownload?.startAll || !self.BscgModelDownload?.startRoute) throw new Error('模型下载器未加载');
  if (activeSession) throw new Error('请先停止当前字幕或整轨识别任务');
  if (benchmarkRun?.status === 'running') throw new Error('请先停止诊断测速');
  if (initWaiter) cancelInitialization('开始预下载全部模型，旧初始化任务已回收');
  const targetRoute = String(message.routeId || '');
  const options = { parallelism: Number(message.parallelism) || 4 };
  const download = targetRoute
    ? self.BscgModelDownload.startRoute(targetRoute, options)
    : self.BscgModelDownload.startAll(options);
  return { ok: true, download };
}

async function cancelModelDownload(message = {}) {
  if (!self.BscgModelDownload?.cancel) return { ok: true, download: null };
  return {
    ok: true,
    download: await self.BscgModelDownload.cancel(String(message.id || ''), String(message.routeId || ''))
  };
}

async function browserCapabilities() {
  await retiredModelCleanup;
  const [estimate, cacheNames] = await Promise.all([
    navigator.storage.estimate().catch(() => ({})),
    caches.keys().catch(() => [])
  ]);
  const modelCaches = cacheNames.filter((name) =>
    name.startsWith('bscg-qwen3-asr-') ||
    name === 'browser-sensevoice-v2' ||
    name === 'bili-browser-asr-poc-v1' ||
    name === 'bili-sensevoice-webgpu-v1' ||
    name.includes('transformers'));
  return {
    ok: true,
    webgpu: Boolean(navigator.gpu),
    crossOriginIsolated: Boolean(self.crossOriginIsolated),
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    voiceDsp: Boolean(self.BscgVoiceDsp?.createProcessor && self.BscgVoiceDsp?.processVoiceChunk),
    hardwareConcurrency: Number(navigator.hardwareConcurrency) || 1,
    modelCached: Boolean(asrWorker),
    workerKey: asrWorkerKey,
    initializing: Boolean(initWaiter),
    initializingSessionId: initWaiter?.sessionId || '',
    activeSession: activeSession ? {
      sessionId: activeSession.sessionId,
      tabId: activeSession.tabId,
      sourceMode: activeSession.sourceMode,
      status: activeSession.status
    } : null,
    benchmark: benchmarkSnapshot(),
    modelDownload: modelDownloadSnapshot(),
    allModelBytes: Number(self.BscgModelDownload?.totalBytes) || 0,
    modelCaches,
    storageUsage: Number(estimate.usage) || 0,
    storageQuota: Number(estimate.quota) || 0
  };
}

async function clearModelCache() {
  await retiredModelCleanup;
  if (activeSession) throw new Error('请先停止当前捕获任务');
  if (benchmarkRun?.status === 'running') throw new Error('请先停止诊断测速');
  if (self.BscgModelDownload?.isRunning?.()) throw new Error('请先停止全部模型下载');
  if (initWaiter) cancelInitialization('开始清理模型缓存，旧初始化任务已回收');
  terminateInferenceWorker();
  const cacheNames = await caches.keys();
  const targets = cacheNames.filter((name) =>
    name.startsWith('bscg-qwen3-asr-') ||
    name === 'browser-sensevoice-v2' ||
    name === 'bili-browser-asr-poc-v1' ||
    name === 'bili-sensevoice-webgpu-v1' ||
    name.includes('transformers'));
  await Promise.all(targets.map((name) => caches.delete(name)));
  self.BscgModelDownload?.reset?.();
  const estimate = await navigator.storage.estimate().catch(() => ({}));
  return {
    ok: true,
    deletedCaches: targets,
    metrics: {
      storageUsage: Number(estimate.usage) || 0,
      storageQuota: Number(estimate.quota) || 0,
      ...visibleHeap()
    }
  };
}

function restartInferenceEngine() {
  if (activeSession) throw new Error('请先停止当前识别任务再应用模型设置');
  if (benchmarkRun?.status === 'running') throw new Error('诊断测速正在运行，请先停止测速');
  if (self.BscgModelDownload?.isRunning?.()) throw new Error('全部模型正在下载，请先停止下载');
  if (initWaiter) cancelInitialization('设置已更新，旧模型初始化任务已回收');
  terminateInferenceWorker();
  return { ok: true };
}

function handlePageFetchMessage(message) {
  const waiter = pageFetchWaiters.get(String(message.requestId || ''));
  if (!waiter) return;
  waiter.touch?.();
  if (message.type === 'BILI_ASR_PAGE_FETCH_START') {
    waiter.total = Number(message.total) || 0;
    waiter.contentType = message.contentType || '';
    if (waiter.trackProgress) updateAudioDownloadProgress(waiter.state, 0, waiter.total, true);
    return;
  }
  if (message.type === 'BILI_ASR_PAGE_FETCH_CHUNK') {
    try {
      const bytes = decodeBase64(message.data || '');
      waiter.loaded += bytes.byteLength;
      if (waiter.loaded > waiter.maxBytes) throw new Error('页面代理返回的资源超过大小限制');
      waiter.chunks.push(bytes);
      if (waiter.trackProgress) updateAudioDownloadProgress(waiter.state, waiter.loaded, waiter.total || Number(message.total), true);
    } catch (error) {
      waiter.reject(error);
    }
    return;
  }
  if (message.type === 'BILI_ASR_PAGE_FETCH_ERROR') {
    waiter.reject(new Error(message.error || '页面音轨代理失败'));
    return;
  }
  if (message.type === 'BILI_ASR_PAGE_FETCH_END') {
    new Blob(waiter.chunks, { type: waiter.contentType || message.contentType || 'application/octet-stream' })
      .arrayBuffer().then(waiter.resolve).catch(waiter.reject);
  }
}

function cleanupLocalUploads() {
  const cutoff = Date.now() - LOCAL_UPLOAD_TTL_MS;
  for (const [token, upload] of localUploads) {
    if ((upload.lastUsedAt || upload.createdAt || 0) < cutoff) localUploads.delete(token);
  }
  while (localUploads.size > 2) localUploads.delete(localUploads.keys().next().value);
}

function beginLocalUpload(message) {
  cleanupLocalUploads();
  const token = String(message.token || '');
  const size = Math.max(0, Number(message.size) || 0);
  if (!token) throw new Error('本地文件令牌为空');
  if (!size || size > DIRECT_MAX_BYTES) throw new Error(`本地文件必须小于 ${Math.round(DIRECT_MAX_BYTES / 1024 / 1024)} MiB`);
  localUploads.set(token, {
    name: String(message.name || '本地视频'),
    type: String(message.mimeType || ''),
    size,
    received: 0,
    chunks: [],
    complete: false,
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  });
  return { ok: true };
}

function appendLocalUpload(message) {
  const upload = localUploads.get(String(message.token || ''));
  if (!upload || upload.complete) throw new Error('本地文件传输会话不存在或已经结束');
  const bytes = decodeBase64(String(message.data || ''));
  if (!bytes.byteLength || upload.received + bytes.byteLength > upload.size || upload.received + bytes.byteLength > DIRECT_MAX_BYTES) {
    throw new Error('本地文件分段大小不合法');
  }
  upload.chunks.push(bytes);
  upload.received += bytes.byteLength;
  upload.lastUsedAt = Date.now();
  return { ok: true, received: upload.received, size: upload.size };
}

function finishLocalUpload(message) {
  const upload = localUploads.get(String(message.token || ''));
  if (!upload) throw new Error('本地文件传输会话不存在');
  if (upload.received !== upload.size) throw new Error(`本地文件传输不完整：${upload.received}/${upload.size}`);
  upload.complete = true;
  upload.lastUsedAt = Date.now();
  return { ok: true, name: upload.name, size: upload.size };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  if (String(message.type || '').startsWith('BILI_ASR_PAGE_FETCH_')) {
    handlePageFetchMessage(message);
    return false;
  }

  if (message.type === 'BILI_ASR_LOCAL_FILE_BEGIN' || message.type === 'BILI_ASR_LOCAL_FILE_CHUNK' || message.type === 'BILI_ASR_LOCAL_FILE_END') {
    try {
      const response = message.type === 'BILI_ASR_LOCAL_FILE_BEGIN'
        ? beginLocalUpload(message)
        : message.type === 'BILI_ASR_LOCAL_FILE_CHUNK'
          ? appendLocalUpload(message)
          : finishLocalUpload(message);
      sendResponse(response);
    } catch (error) {
      sendResponse({ ok: false, error: errorText(error) });
    }
    return false;
  }

  if (message.type === 'BILI_ASR_START_DIRECT') {
    beginDirectSession(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: errorText(error), errorCode: error?.code || '' });
    });
    return true;
  }

  if (message.type === 'BILI_ASR_START') {
    beginSession(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: errorText(error), errorCode: error?.code || '' });
    });
    return true;
  }

  if (message.type === 'BILI_ASR_START_EXTERNAL') {
    beginExternalSession(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: errorText(error), errorCode: error?.code || '' });
    });
    return true;
  }

  if (message.type === 'BILI_ASR_PCM_CHUNK') {
    try { sendResponse(acceptExternalPcm(message)); }
    catch (error) { sendResponse({ ok: false, error: errorText(error) }); }
    return false;
  }

  if (message.type === 'BILI_ASR_SCAN_READY') {
    sendResponse(prepareScanCapture(message));
    return false;
  }

  if (message.type === 'BILI_ASR_CAPTURE_SEEK') {
    sendResponse(seekCapturedSession(message));
    return false;
  }
  if (message.type === 'BILI_ASR_CAPTURE_BOUNDARY') {
    const state = activeSession;
    sendResponse(message.sessionId === state?.sessionId ? liveCaptureBoundary(state) : { ok: true, ignored: true });
    return false;
  }

  if (message.type === 'BILI_ASR_STOP') {
    const state = activeSession;
    const staleSession = Boolean(message.sessionId && message.sessionId !== state?.sessionId);
    if (!state || staleSession || (message.tabId && Number(message.tabId) !== state.tabId)) {
      sendResponse({ ok: true, idle: true, staleSession });
      return false;
    }
    stopSession(state, message.reason || 'user').then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: errorText(error) });
    });
    return true;
  }

  if (message.type === 'BILI_ASR_DIRECT_SEEK') {
    try { sendResponse(seekDirectSession(message)); }
    catch (error) { sendResponse({ ok: false, error: errorText(error) }); }
    return false;
  }

  if (message.type === 'BILI_ASR_CLOCK') {
    updateClock(message, sender);
    return false;
  }

  if (message.type === 'BILI_ASR_GET_STATE') {
    const tabId = Number(message.tabId) || Number(sender.tab?.id);
    const state = activeSession?.tabId === tabId
      ? snapshotState(activeSession)
      : (lastStates.get(tabId) || {
        status: 'idle',
        statusText: '选择音频来源与后端，然后点击开始。',
        srt: '',
        metrics: {},
        backendMode: 'webgpu',
        sourceMode: 'direct'
      });
    sendResponse({ ok: true, state });
    return false;
  }

  if (message.type === 'BILI_ASR_CAPABILITIES') {
    browserCapabilities().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: errorText(error) });
    });
    return true;
  }

  if (message.type === 'BILI_ASR_BENCHMARK_START') {
    try { sendResponse(startBenchmark(message)); }
    catch (error) { sendResponse({ ok: false, error: errorText(error) }); }
    return false;
  }

  if (message.type === 'BILI_ASR_BENCHMARK_STATUS') {
    sendResponse({ ok: true, benchmark: benchmarkSnapshot() });
    return false;
  }

  if (message.type === 'BILI_ASR_BENCHMARK_CANCEL') {
    try { sendResponse(cancelBenchmark(message)); }
    catch (error) { sendResponse({ ok: false, error: errorText(error) }); }
    return false;
  }

  if (message.type === 'BILI_ASR_MODEL_DOWNLOAD_START') {
    try { sendResponse(startModelDownload(message)); }
    catch (error) { sendResponse({ ok: false, error: errorText(error) }); }
    return false;
  }

  if (message.type === 'BILI_ASR_MODEL_DOWNLOAD_STATUS') {
    sendResponse({ ok: true, download: modelDownloadSnapshot() });
    return false;
  }

  if (message.type === 'BILI_ASR_MODEL_DOWNLOAD_CANCEL') {
    cancelModelDownload(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: errorText(error) });
    });
    return true;
  }

  if (message.type === 'BILI_ASR_CLEAR_SRT') {
    const tabId = Number(sender.tab?.id) || Number(message.tabId);
    if (activeSession?.tabId === tabId) {
      activeSession.cues = [];
      activeSession.previewCue = null;
    }
    const existing = lastStates.get(tabId);
    if (existing) lastStates.set(tabId, { ...existing, srt: '' });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'BILI_ASR_FORGET_TAB') {
    const tabId = Number(message.tabId);
    if (Number.isInteger(tabId)) {
      if (activeSession?.tabId === tabId) forgottenTabs.add(tabId);
      else forgottenTabs.delete(tabId);
      lastStates.delete(tabId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'BILI_ASR_CLEAR_CACHE') {
    clearModelCache().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: errorText(error) });
    });
    return true;
  }


  if (message.type === 'BILI_ASR_RESTART_ENGINE') {
    try {
      sendResponse(restartInferenceEngine());
    } catch (error) {
      sendResponse({ ok: false, error: errorText(error) });
    }
    return false;
  }
});
