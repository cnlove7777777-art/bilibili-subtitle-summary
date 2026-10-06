'use strict';

const DEFAULTS = {
  prompt: '完整总结视频字幕中的观点和内容。',
  aiStudioPrompt: '完整总结视频字幕中的观点和内容。',
  deepseekPrompt: '完整总结视频字幕中的观点和内容。',
  language: 'zh',
  asrProfile: 'sensevoice_browser',
  asrBackend: 'auto',
  gpuPreference: 'high-performance',
  summaryEngine: 'external-page',
  chatgptUrl: 'https://chatgpt.com/',
  aiStudioUrl: 'https://aistudio.google.com/prompts/new_chat?model=gemini-3.1-pro-preview',
  deepseekUrl: 'https://chat.deepseek.com/',
  defaultDestination: 'chatgpt',
  liveChunkSeconds: 11.5,
  recognitionThreads: 0,
  scanPlaybackRate: 4,
  voiceEnhance: false,
  voiceEnhancePreset: 'balanced',
  autoCaptionsMainstream: false,
  autoCaptionsOther: false,
  // 前瞻字幕翻译：只对能直接取到音轨的整轨识别（B站音轨 / M3U8 / MP4）生效
  translateEnabled: false,
  translateMode: 'local',
  translateLocalBaseUrl: 'http://127.0.0.1:8888/v1',
  translateLocalApiKey: '',
  translateLocalModel: '',
  translateRemoteBaseUrl: 'https://api.openai.com/v1',
  translateRemoteApiKey: '',
  translateRemoteModel: '',
  translateTargetLanguage: 'zh',
  // translated：只显示译文（默认）；bilingual：译文为主 + 原文字号更小
  translateDisplayMode: 'translated'
};

const fieldIds = [
  'prompt', 'aiStudioPrompt', 'deepseekPrompt', 'language', 'asrProfile', 'asrBackend',
  'chatgptUrl', 'aiStudioUrl', 'deepseekUrl', 'defaultDestination',
  'liveChunkSeconds', 'recognitionThreads', 'scanPlaybackRate', 'voiceEnhancePreset',
  'translateMode', 'translateTargetLanguage', 'translateDisplayMode',
  'translateLocalBaseUrl', 'translateLocalApiKey', 'translateLocalModel',
  'translateRemoteBaseUrl', 'translateRemoteApiKey', 'translateRemoteModel'
];
const toggleIds = ['voiceEnhance', 'autoCaptionsMainstream', 'autoCaptionsOther', 'translateEnabled'];
const NUMBER_FIELDS = {
  liveChunkSeconds: { min: 4, max: 12, fallback: 11.5 },
  recognitionThreads: { min: 0, max: 16, fallback: 0 },
  scanPlaybackRate: { min: 1, max: 8, fallback: 4 }
};

const elements = Object.fromEntries(fieldIds.map((id) => [id, document.getElementById(id)]));
const status = document.getElementById('status');
const debugStatus = document.getElementById('debugStatus');
const benchmarkStatus = document.getElementById('benchmarkStatus');
const modelDownloadStatus = document.getElementById('modelDownloadStatus');
const modelDownloadList = document.getElementById('modelDownloadList');
const toast = document.getElementById('toast');
let toastTimer = null;
let saveQueue = Promise.resolve();
let currentBenchmarkId = '';
let currentModelDownloadId = '';
let modelDownloadPollTimer = null;
let currentModelDownloadSnapshot = null;
let loadPromise = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

function clampNumber(id, raw) {
  const range = NUMBER_FIELDS[id];
  return Math.max(range.min, Math.min(range.max, Number(raw) || range.fallback));
}

function normalizeThreads(raw) {
  const hardwareMaximum = Math.max(1, Math.min(16, Number(navigator.hardwareConcurrency) || 1));
  const value = Math.round(clampNumber('recognitionThreads', raw));
  return value === 0 ? 0 : Math.max(1, Math.min(hardwareMaximum, value));
}

function populateThreadOptions() {
  const select = elements.recognitionThreads;
  const maximum = Math.max(1, Math.min(16, Number(navigator.hardwareConcurrency) || 1));
  const selected = normalizeThreads(select.value);
  select.replaceChildren(new Option('自动', '0'));
  for (let threads = 1; threads <= maximum; threads += 1) {
    select.append(new Option(String(threads), String(threads)));
  }
  select.value = String(Math.min(selected, maximum));
}

function syncRecognitionControls(preferredBackend = elements.asrBackend.value) {
  const qwen = elements.asrProfile.value === 'qwen3_asr_0_6b';
  elements.asrBackend.replaceChildren(new Option(
    qwen ? 'GPU FP16（WebGPU）' : 'GPU FP16 → CPU INT8',
    'auto'
  ));
  if (!qwen) elements.asrBackend.append(new Option('CPU INT8', 'wasm'));
  elements.asrBackend.value = qwen ? 'auto' : preferredBackend === 'wasm' ? 'wasm' : 'auto';
  elements.asrBackend.disabled = qwen;
  elements.recognitionThreads.disabled = qwen;
  const maximum = Math.max(1, Math.min(16, Number(navigator.hardwareConcurrency) || 1));
  const hint = document.getElementById('recognitionThreadsHint');
  if (hint) hint.textContent = qwen
    ? 'Qwen 仅使用 GPU；此项不参与推理。'
    : `自动最多 8，手动可调至 ${maximum}。`;
  const phraseHint = document.getElementById('liveChunkSecondsHint');
  if (phraseHint) phraseHint.textContent = qwen
    ? 'Qwen 固定最高 7.75 秒，避免跨入双倍编码窗口。'
    : 'SenseVoice 最长 12 秒；临时字幕仍会低延迟刷新。';
}

function backendLabel(values) {
  if (values.asrProfile === 'qwen3_asr_0_6b') return 'GPU FP16';
  return values.asrBackend === 'wasm' ? 'CPU INT8' : 'GPU FP16 → CPU INT8';
}

function collectValues() {
  const values = {
    gpuPreference: 'high-performance',
    summaryEngine: 'external-page'
  };
  for (const id of fieldIds) values[id] = String(elements[id].value || '').trim();
  values.liveChunkSeconds = clampNumber('liveChunkSeconds', values.liveChunkSeconds);
  values.recognitionThreads = normalizeThreads(values.recognitionThreads);
  values.scanPlaybackRate = clampNumber('scanPlaybackRate', values.scanPlaybackRate);
  if (values.asrProfile === 'qwen3_asr_0_6b') values.asrBackend = 'auto';
  if (!['gentle', 'balanced', 'strong'].includes(values.voiceEnhancePreset)) values.voiceEnhancePreset = 'balanced';
  for (const id of toggleIds) values[id] = document.getElementById(id).checked;
  return values;
}

function syncVoiceControls() {
  elements.voiceEnhancePreset.disabled = !document.getElementById('voiceEnhance').checked;
}

// 05 翻译：本地（UNSLOTH Studio / llama.cpp 直连）与远程（任意 OpenAI 兼容端点）字段完全
// 同构，只有「填哪一组」不同，所以这里用同一张表驱动面板显隐与两个动作按钮。
const TRANSLATE_SOURCES = {
  local: {
    panel: 'translateLocalPanel',
    baseUrl: 'translateLocalBaseUrl',
    apiKey: 'translateLocalApiKey',
    model: 'translateLocalModel',
    list: 'translateLocalModelList',
    hint: 'translateLocalModelHint',
    label: '本地服务'
  },
  remote: {
    panel: 'translateRemotePanel',
    baseUrl: 'translateRemoteBaseUrl',
    apiKey: 'translateRemoteApiKey',
    model: 'translateRemoteModel',
    list: 'translateRemoteModelList',
    hint: 'translateRemoteModelHint',
    label: '远程 API'
  }
};
const translateStatus = document.getElementById('translateStatus');

function translateSourceKey() {
  return elements.translateMode.value === 'remote' ? 'remote' : 'local';
}

function translateLanguageLabel(code) {
  const select = elements.translateTargetLanguage;
  const option = [...select.options].find((candidate) => candidate.value === code);
  return option ? option.textContent : String(code || '');
}

// 模型下拉：先保住已保存的选择，再并入服务端返回的列表；服务端列表里没有但已保存
// 的模型不能丢（服务临时下线时用户不该被迫重选）。
function populateTranslateModels(select, models, selected) {
  const value = String(selected || '').trim();
  select.replaceChildren(new Option('未选择', ''));
  const seen = new Set(['']);
  for (const model of Array.isArray(models) ? models : []) {
    const id = String(model?.id || model || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const quant = model?.quant ? ` · ${model.quant}` : '';
    select.append(new Option(`${id}${quant}`, id));
  }
  if (value && !seen.has(value)) select.append(new Option(`${value}（已保存，不在当前列表）`, value));
  select.value = value;
}

function syncTranslatePanels() {
  const key = translateSourceKey();
  for (const [name, source] of Object.entries(TRANSLATE_SOURCES)) {
    document.getElementById(source.panel).hidden = name !== key;
  }
}

async function load() {
  populateThreadOptions();
  const values = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  if (values.asrBackend === 'webgpu' || values.asrProfile === 'qwen3_asr_0_6b' && values.asrBackend !== 'auto') {
    values.asrBackend = 'auto';
    await chrome.storage.local.set({ asrBackend: 'auto' });
  }
  const storedThreads = Number(values.recognitionThreads) || 0;
  values.recognitionThreads = normalizeThreads(storedThreads);
  if (values.recognitionThreads !== storedThreads) {
    await chrome.storage.local.set({ recognitionThreads: values.recognitionThreads });
  }
  if (!['gentle', 'balanced', 'strong'].includes(values.voiceEnhancePreset)) values.voiceEnhancePreset = 'balanced';
  for (const id of fieldIds) elements[id].value = String(values[id]);
  for (const id of toggleIds) document.getElementById(id).checked = Boolean(values[id]);
  syncRecognitionControls(values.asrBackend);
  syncVoiceControls();
  for (const [name, source] of Object.entries(TRANSLATE_SOURCES)) {
    populateTranslateModels(document.getElementById(source.model), [], values[source.model]);
    void name;
  }
  syncTranslatePanels();
  syncTranslateStatus();
  const model = values.asrProfile === 'qwen3_asr_0_6b' ? 'Qwen3-ASR 0.6B' : 'SenseVoice Small';
  const backend = backendLabel(values);
  const audio = values.voiceEnhance ? `远场控制/${{ gentle: '轻度', balanced: '平衡', strong: '强' }[values.voiceEnhancePreset]}` : '原始音频';
  status.textContent = `已保存：${model} · ${backend} · ${audio}`;
}

function autoSave(event) {
  const changedId = event?.currentTarget?.id || '';
  if (changedId === 'asrProfile') syncRecognitionControls();
  const values = collectValues();
  for (const id of Object.keys(NUMBER_FIELDS)) elements[id].value = String(values[id]);
  const restartEngine = ['asrProfile', 'asrBackend', 'recognitionThreads'].includes(changedId);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await chrome.storage.local.set(values);
    const stored = await chrome.storage.local.get(['asrProfile', 'asrBackend', 'recognitionThreads']);
    if (stored.asrProfile !== values.asrProfile || stored.asrBackend !== values.asrBackend || Number(stored.recognitionThreads) !== values.recognitionThreads) {
      throw new Error('设置写入后校验不一致');
    }
    let applied = { ok: true };
    if (restartEngine) {
      applied = await chrome.runtime.sendMessage({ type: 'BSCG_BROWSER_SETTINGS_APPLIED' });
      if (!applied?.ok) throw new Error(applied?.error || '模型 Worker 切换失败');
    }
    const audioChange = ['voiceEnhance', 'voiceEnhancePreset'].includes(changedId);
    if (changedId.startsWith('translate')) {
      // 配置一变就把上一轮的试译结果清掉，避免拿旧结果当现配置的证据。
      syncTranslatePanels();
      syncTranslateStatus();
    }
    showToast(applied.deferred ? `保存成功，${applied.reason}` : audioChange ? '保存成功，下次识别生效' : '保存成功并已应用');
    return values;
  }).catch((error) => {
    showToast(`保存失败：${error?.message || String(error)}`);
    return null;
  });
  return saveQueue;
}

for (const id of [...fieldIds, ...toggleIds]) {
  document.getElementById(id).addEventListener('change', autoSave);
}
document.getElementById('voiceEnhance').addEventListener('change', syncVoiceControls);

function describeCapabilities(response, values = collectValues()) {
  const model = values.asrProfile === 'sensevoice_browser' ? 'SenseVoice Small' : 'Qwen3-ASR 0.6B';
  const selected = backendLabel(values);
  const worker = response.workerKey || (response.modelCached ? '已创建，但版本未报告精确路由' : '尚未创建');
  const cacheCount = Array.isArray(response.modelCaches) ? response.modelCaches.length : 0;
  const benchmark = response.benchmark?.status === 'running'
    ? `运行中 · ${response.benchmark.profile}/${response.benchmark.backend} · ${response.benchmark.statusText}`
    : response.benchmark?.status
      ? `${response.benchmark.status} · ${response.benchmark.profile}/${response.benchmark.backend}`
      : '空闲';
  const download = response.modelDownload?.status === 'running'
    ? `${(Number(response.modelDownload.progress) || 0).toFixed(1)}% · ${response.modelDownload.completedFiles || 0}/${response.modelDownload.totalFiles || 0} 文件`
    : response.modelDownload?.status === 'complete' ? '已完成'
      : response.modelDownload?.status === 'partial' ? '部分完成' : '空闲';
  return [
    `选择：${model} · ${selected}`,
    `音频：${values.voiceEnhance ? `远场控制/${{ gentle: '轻度', balanced: '平衡', strong: '强' }[values.voiceEnhancePreset] || '平衡'}` : '原始 PCM'}`,
    `WebGPU：${response.webgpu ? '可用' : '不可用'} · 隔离环境：${response.crossOriginIsolated ? '是' : '否'}`,
    `CPU：${response.hardwareConcurrency || '未知'} 逻辑处理器 · ${values.asrProfile === 'qwen3_asr_0_6b' ? 'Qwen 不提供 CPU 链路' : response.sharedArrayBuffer ? `SenseVoice ${values.recognitionThreads || '自动'} 线程` : 'SenseVoice 实际 1 线程（隔离环境不可用）'}`,
    `Worker：${worker}`,
    `初始化：${response.initializing ? `运行中（${response.initializingSessionId || '未知任务'}）` : '空闲'} · 测速：${benchmark} · 下载：${download}`,
    `模型缓存：${cacheCount} 组 · 存储 ${formatBytes(response.storageUsage)} / ${formatBytes(response.storageQuota)}`
  ].join('\n');
}

async function inspectBrowserRuntime(target = status) {
  await saveQueue.catch(() => {});
  target.textContent = '正在检查浏览器音频与推理能力…';
  const response = await chrome.runtime.sendMessage({ type: 'BSCG_BROWSER_STATUS' });
  if (!response?.ok) throw new Error(response?.error || '离屏处理器不可用');
  target.textContent = describeCapabilities(response);
  if (response.modelDownload) renderModelDownload(response.modelDownload);
  if (response.modelDownload?.status === 'running' && currentModelDownloadId !== response.modelDownload.id) {
    beginModelDownloadPolling(response.modelDownload.id || '');
  }
  return response;
}

document.getElementById('check').addEventListener('click', async () => {
  try {
    await inspectBrowserRuntime(status);
  } catch (error) {
    status.textContent = `浏览器引擎检查失败：${error?.message || String(error)}`;
  }
});

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 2 : 0)} ${units[index]}`;
}

function formatDuration(value) {
  const ms = Math.max(0, Number(value) || 0);
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} 秒` : `${ms.toFixed(0)} 毫秒`;
}

const debugRefresh = document.getElementById('debugRefresh');
debugRefresh.addEventListener('click', async () => {
  debugRefresh.disabled = true;
  try {
    await inspectBrowserRuntime(debugStatus);
  } catch (error) {
    debugStatus.textContent = `诊断失败：${error?.message || String(error)}`;
  } finally {
    debugRefresh.disabled = false;
  }
});

const runSelfTest = document.getElementById('runSelfTest');
runSelfTest.addEventListener('click', async () => {
  runSelfTest.disabled = true;
  debugStatus.textContent = '浏览器能力自检进行中…';
  try {
    const response = await inspectBrowserRuntime(debugStatus);
    debugStatus.textContent += [
      '',
      '消息与离屏文档：通过',
      `远场音频控制：${response.voiceDsp ? '可用' : '不可用'}`,
      `WASM 多线程：${response.crossOriginIsolated && response.sharedArrayBuffer ? '可用' : '不可用'}`
    ].join('\n');
  } catch (error) {
    debugStatus.textContent = `自检失败：${error?.message || String(error)}`;
  } finally {
    runSelfTest.disabled = false;
  }
});

const benchmarkButtons = [...document.querySelectorAll('.benchmark-button')];
const cancelBenchmarkButton = document.getElementById('cancelBenchmark');
const clearModelCacheButton = document.getElementById('clearModelCache');
const downloadAllModelsButton = document.getElementById('downloadAllModels');
const cancelModelDownloadButton = document.getElementById('cancelModelDownload');
let benchmarkBusy = false;

function benchmarkLabel(run) {
  const model = run?.profile === 'sensevoice_browser' ? 'SenseVoice Small' : 'Qwen3-ASR 0.6B';
  const route = run?.backend === 'wasm' ? 'WASM CPU INT8' : 'WebGPU FP16';
  return `${model} · ${route}`;
}

function syncDiagnosticControls() {
  const routes = currentModelDownloadSnapshot?.routes || [];
  const anyRouteRunning = routes.some((route) => route.status === 'running');
  const allRoutesSettled = routes.length > 0 && routes.every((route) => ['running', 'complete'].includes(route.status));
  for (const button of benchmarkButtons) button.disabled = benchmarkBusy || anyRouteRunning;
  clearModelCacheButton.disabled = benchmarkBusy || anyRouteRunning;
  downloadAllModelsButton.disabled = benchmarkBusy || allRoutesSettled;
  cancelBenchmarkButton.disabled = !benchmarkBusy;
  cancelModelDownloadButton.disabled = benchmarkBusy || !anyRouteRunning;
  for (const item of modelDownloadList.querySelectorAll('.model-download-item')) {
    const route = routes.find((candidate) => candidate.id === item.dataset.downloadRoute);
    const button = item.querySelector('.model-download-action');
    button.disabled = benchmarkBusy || route?.status === 'complete';
  }
}

function setBenchmarkControls(running) {
  benchmarkBusy = Boolean(running);
  syncDiagnosticControls();
}

function setModelDownloadControls() {
  syncDiagnosticControls();
}

const DOWNLOAD_ROUTE_DEFS = {
  'qwen-webgpu': { total: 1889071944, files: 5 },
  'sense-webgpu': { total: 469271762, files: 4 },
  'sense-wasm': { total: 239597108, files: 3 }
};

function formatRate(value) {
  const bytesPerSecond = Math.max(0, Number(value) || 0);
  if (bytesPerSecond >= 1024 ** 2) return `${(bytesPerSecond / 1024 ** 2).toFixed(2)} MiB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KiB/s`;
  return `${bytesPerSecond.toFixed(0)} B/s`;
}

function idleDownloadRoute(id) {
  const definition = DOWNLOAD_ROUTE_DEFS[id];
  return {
    id,
    status: 'idle',
    phase: 'idle',
    statusText: '未开始',
    progress: 0,
    loaded: 0,
    total: definition.total,
    completedFiles: 0,
    totalFiles: definition.files,
    speedBytesPerSecond: 0,
    source: '',
    currentFile: '',
    error: ''
  };
}

function renderDownloadRoute(item, route) {
  const percent = Math.max(0, Math.min(100, Number(route.progress) || 0));
  const running = route.status === 'running';
  const button = item.querySelector('.model-download-action');
  const speed = running
    ? route.phase === 'probing' ? '测速中'
      : route.phase === 'checking' ? '检查中'
        : /等待/.test(route.statusText || '') ? '等待'
          : formatRate(route.speedBytesPerSecond)
    : route.status === 'complete' ? '完成' : '—';
  item.dataset.state = route.status;
  item.querySelector('[data-route-status]').textContent = route.statusText || route.status;
  item.querySelector('[data-route-speed]').textContent = speed;
  item.querySelector('[data-route-bar]').style.width = `${percent}%`;
  item.querySelector('[data-route-progress]').textContent = `${percent.toFixed(1)}% · ${formatBytes(route.loaded)} / ${formatBytes(route.total)} · ${route.completedFiles || 0}/${route.totalFiles || 0} 文件`;
  item.querySelector('[data-route-source]').textContent = [route.source, route.currentFile].filter(Boolean).join(' · ') || '等待下载';
  const error = item.querySelector('[data-route-error]');
  error.textContent = route.error || '';
  error.hidden = !route.error;
  button.textContent = running ? '停止'
    : route.status === 'complete' ? '已完成'
      : route.status === 'cancelled' ? '继续'
        : route.status === 'error' ? '重试' : '下载';
}

function renderModelDownload(run) {
  currentModelDownloadSnapshot = run || null;
  const routes = new Map((run?.routes || []).map((route) => [route.id, route]));
  const total = Number(run?.total) || 2597577547;
  const loaded = Number(run?.loaded) || 0;
  const percent = total > 0 ? Math.max(0, Math.min(100, loaded / total * 100)) : 0;
  modelDownloadStatus.querySelector('[data-download-total-percent]').textContent = `${percent.toFixed(1)}%`;
  modelDownloadStatus.querySelector('[data-download-total-bar]').style.width = `${percent}%`;
  modelDownloadStatus.querySelector('[data-download-total-meta]').textContent = `${formatBytes(loaded)} / ${formatBytes(total)} · ${run?.completedFiles || 0}/${run?.totalFiles || 10} 文件`;
  for (const item of modelDownloadList.querySelectorAll('.model-download-item')) {
    const id = item.dataset.downloadRoute;
    renderDownloadRoute(item, routes.get(id) || idleDownloadRoute(id));
  }
  setModelDownloadControls(run?.status === 'running');
}

async function pollModelDownload(id) {
  if (!id || currentModelDownloadId !== id) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BSCG_MODEL_DOWNLOAD_STATUS', id });
    if (!response?.ok) throw new Error(response?.error || '无法读取下载状态');
    const run = response.download;
    renderModelDownload(run);
    if (run?.status === 'running' && currentModelDownloadId === id) {
      modelDownloadPollTimer = setTimeout(() => void pollModelDownload(id), 500);
      return;
    }
    currentModelDownloadId = '';
    void inspectBrowserRuntime(debugStatus).catch(() => {});
  } catch (error) {
    showToast(`下载状态读取失败：${error?.message || String(error)}`);
    currentModelDownloadId = '';
    setModelDownloadControls(false);
  }
}

function beginModelDownloadPolling(id) {
  if (!id) return;
  currentModelDownloadId = id;
  clearTimeout(modelDownloadPollTimer);
  void pollModelDownload(id);
}

downloadAllModelsButton.addEventListener('click', async () => {
  downloadAllModelsButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BSCG_MODEL_DOWNLOAD_START', parallelism: 4 });
    if (!response?.ok) throw new Error(response?.error || '下载启动失败');
    renderModelDownload(response.download);
    if (response.download?.status === 'running') beginModelDownloadPolling(response.download.id || '');
  } catch (error) {
    showToast(`下载启动失败：${error?.message || String(error)}`);
    syncDiagnosticControls();
  }
});

cancelModelDownloadButton.addEventListener('click', async () => {
  cancelModelDownloadButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BSCG_MODEL_DOWNLOAD_CANCEL',
      id: currentModelDownloadId
    });
    if (!response?.ok) throw new Error(response?.error || '取消下载失败');
    renderModelDownload(response.download);
    if (response.download?.status === 'running') beginModelDownloadPolling(response.download.id || '');
    else currentModelDownloadId = '';
  } catch (error) {
    showToast(`停止失败：${error?.message || String(error)}`);
    syncDiagnosticControls();
  }
});

modelDownloadList.addEventListener('click', async (event) => {
  const button = event.target.closest('.model-download-action');
  const item = button?.closest('.model-download-item');
  if (!button || !item) return;
  const targetRoute = item.dataset.downloadRoute;
  const route = currentModelDownloadSnapshot?.routes?.find((candidate) => candidate.id === targetRoute);
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage(route?.status === 'running' ? {
      type: 'BSCG_MODEL_DOWNLOAD_CANCEL',
      id: currentModelDownloadId || currentModelDownloadSnapshot?.id || '',
      routeId: targetRoute
    } : {
      type: 'BSCG_MODEL_DOWNLOAD_START',
      routeId: targetRoute,
      parallelism: 4
    });
    if (!response?.ok) throw new Error(response?.error || '模型下载操作失败');
    renderModelDownload(response.download);
    if (response.download?.status === 'running') beginModelDownloadPolling(response.download.id || '');
    else currentModelDownloadId = '';
  } catch (error) {
    showToast(`操作失败：${error?.message || String(error)}`);
    syncDiagnosticControls();
  }
});

function renderBenchmark(run) {
  if (!run) {
    benchmarkStatus.textContent = '尚未运行模型测速';
    return;
  }
  const lines = [
    `链路：${benchmarkLabel(run)}`,
    `状态：${run.statusText || run.status}`
  ];
  if (run.status === 'running') {
    if (run.phase === 'measuring' && run.benchmarkAudioSeconds > 0) {
      lines.push(`真实语音：${Number(run.measuredSeconds || 0).toFixed(1)} / ${Number(run.benchmarkAudioSeconds).toFixed(1)} 秒`);
    } else if (run.phase === 'loading' && run.total > 0) {
      lines.push(`权重进度：${(Number(run.progress) || 0).toFixed(1)}% · ${formatBytes(run.loaded)} / ${formatBytes(run.total)}`);
    }
  } else if (run.status === 'complete' && run.result) {
    const result = run.result;
    const warmupRtf = result.warmupAudioSeconds > 0
      ? result.warmupInferenceMs / 1000 / result.warmupAudioSeconds
      : 0;
    lines.push(
      `结论：通过（实际 ${result.actualBackend} / ${String(result.precision || '').toUpperCase()}）`,
      `设备：${result.device || (result.actualBackend === 'wasm' ? 'CPU · WebAssembly' : 'WebGPU adapter')}`,
      result.actualBackend === 'wasm'
        ? `线程：实际 ${result.threads || 1} · 请求 ${result.requestedCpuThreads || '自动'} · Chrome ${result.hardwareConcurrency || '未知'} 逻辑处理器`
        : '线程：WebGPU 链路不使用 CPU 推理线程设置',
      `模型准备：${formatDuration(result.modelLoadWallMs)}${result.warmModel ? '（已保温）' : ''}`,
      `预热：${formatDuration(result.warmupInferenceMs)} · RTF ${warmupRtf.toFixed(3)}`,
      `${Number(result.audioSeconds).toFixed(1)} 秒真实语音：推理 ${formatDuration(result.inferenceMs)} · 总耗时 ${formatDuration(result.benchmarkWallMs)} · RTF ${Number(result.rtf).toFixed(3)} · ${result.rtf < 1 ? '快于实时' : '慢于实时'}`,
      `测速文件：${formatBytes(result.benchmarkAssetBytes)} · ${result.benchmarkSegmentCount || 0} 段 · 模型权重 ${formatBytes(result.modelBytes)}`,
      `扩展源存储：${formatBytes(result.storageAfter)}`,
      `识别输出：${result.text || '（空文本；链路与推理仍已完成）'}`
    );
  } else if (run.status === 'error') {
    lines.push(`结论：失败`, `原始错误：${run.error || '未知错误'}`);
  } else if (run.status === 'cancelled') {
    lines.push('结论：已由用户取消');
  }
  benchmarkStatus.textContent = lines.join('\n');
}

async function pollBenchmark(id) {
  if (!id || currentBenchmarkId !== id) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BSCG_BROWSER_BENCHMARK_STATUS', id });
    if (!response?.ok) throw new Error(response?.error || '无法读取测速状态');
    const run = response.benchmark;
    renderBenchmark(run);
    if (run?.status === 'running' && currentBenchmarkId === id) {
      setTimeout(() => void pollBenchmark(id), 800);
      return;
    }
    currentBenchmarkId = '';
    setBenchmarkControls(false);
    void inspectBrowserRuntime(debugStatus).catch(() => {});
  } catch (error) {
    benchmarkStatus.textContent = `测速状态读取失败：${error?.message || String(error)}`;
    currentBenchmarkId = '';
    setBenchmarkControls(false);
  }
}

for (const button of benchmarkButtons) {
  button.addEventListener('click', async () => {
    setBenchmarkControls(true);
    benchmarkStatus.textContent = '正在提交精确链路测速…';
    try {
      await loadPromise;
      await saveQueue.catch(() => {});
      const values = collectValues();
      const response = await chrome.runtime.sendMessage({
        type: 'BSCG_BROWSER_BENCHMARK_START',
        profile: button.dataset.profile,
        backend: button.dataset.backend,
        cpuThreads: values.recognitionThreads
      });
      if (!response?.ok) throw new Error(response?.error || '测速启动失败');
      currentBenchmarkId = response.benchmark?.id || '';
      renderBenchmark(response.benchmark);
      void pollBenchmark(currentBenchmarkId);
    } catch (error) {
      currentBenchmarkId = '';
      setBenchmarkControls(false);
      benchmarkStatus.textContent = `测速启动失败：${error?.message || String(error)}`;
    }
  });
}

cancelBenchmarkButton.addEventListener('click', async () => {
  cancelBenchmarkButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BSCG_BROWSER_BENCHMARK_CANCEL',
      id: currentBenchmarkId
    });
    if (!response?.ok) throw new Error(response?.error || '停止测速失败');
    renderBenchmark(response.benchmark);
  } catch (error) {
    benchmarkStatus.textContent += `\n停止失败：${error?.message || String(error)}`;
  } finally {
    currentBenchmarkId = '';
    setBenchmarkControls(false);
  }
});

clearModelCacheButton.addEventListener('click', async () => {
  if (!confirm('删除 Qwen 与 SenseVoice 的已下载权重？下次使用对应链路时需要重新下载。')) return;
  clearModelCacheButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BSCG_CLEAR_MODEL_CACHE' });
    if (!response?.ok) throw new Error(response?.error || '模型缓存清理失败');
    const names = response.deletedCaches || [];
    renderModelDownload(null);
    showToast(names.length ? `已删除 ${names.length} 组模型缓存` : '没有模型缓存');
    await inspectBrowserRuntime(debugStatus);
  } catch (error) {
    showToast(`模型缓存清理失败：${error?.message || String(error)}`);
  } finally {
    syncDiagnosticControls();
  }
});

// 翻译分区状态：只在 pre 里说清「当前这条配置能不能翻」，不在页面上堆额外控件。
function syncTranslateStatus() {
  const values = collectValues();
  const source = TRANSLATE_SOURCES[translateSourceKey()];
  const baseUrl = String(values[source.baseUrl] || '').trim();
  const model = String(values[source.model] || '').trim();
  const enabled = document.getElementById('translateEnabled').checked;
  const problems = [];
  if (!/^https?:\/\//i.test(baseUrl)) problems.push('Base URL 不是 http/https');
  if (!model) problems.push('还没选模型');
  translateStatus.dataset.state = '';
  translateStatus.textContent = problems.length
    ? `${enabled ? '已启用' : '未启用'} · ${source.label}：${problems.join('；')}。`
    : `${enabled ? '已启用' : '未启用'} · ${source.label}：${model} → ${translateLanguageLabel(values.translateTargetLanguage)}\n${baseUrl}`;
}

document.getElementById('translateMode').addEventListener('change', () => {
  syncTranslatePanels();
  syncTranslateStatus();
});
document.getElementById('translateEnabled').addEventListener('change', syncTranslateStatus);

for (const source of Object.values(TRANSLATE_SOURCES)) {
  document.getElementById(source.list).addEventListener('click', async () => {
    const button = document.getElementById(source.list);
    const hint = document.getElementById(source.hint);
    const select = document.getElementById(source.model);
    button.disabled = true;
    hint.textContent = '正在读取模型列表…本地服务首次冷启动可能要等几十秒。';
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'BSCG_TRANSLATE_LIST_MODELS',
        settings: collectValues()
      });
      if (!response?.ok) throw new Error(response?.error || '获取模型列表失败');
      const models = Array.isArray(response.models) ? response.models : [];
      populateTranslateModels(select, models, select.value);
      hint.textContent = `已获取 ${models.length} 个模型；选好后自动保存。`;
      showToast(`已获取 ${models.length} 个模型`);
    } catch (error) {
      hint.textContent = `获取失败：${error?.message || String(error)}`;
    } finally {
      button.disabled = false;
    }
  });
}

document.getElementById('translateTest').addEventListener('click', async () => {
  const button = document.getElementById('translateTest');
  button.disabled = true;
  translateStatus.dataset.state = '';
  translateStatus.textContent = '正在测试翻译链路…本地模型首次调用要把权重读进显存，可能要等几十秒。';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BSCG_TRANSLATE_TEST',
      settings: collectValues()
    });
    if (!response?.ok) throw new Error(response?.error || '翻译测试失败');
    const texts = Array.isArray(response.texts) ? response.texts : [];
    const sources = Array.isArray(response.sources) ? response.sources : [];
    const pairs = sources.flatMap((line, index) => [
      `原文：${line}`,
      `译文：${texts[index] || '（模型返回空行）'}`
    ]);
    translateStatus.dataset.state = 'ok';
    translateStatus.textContent = [
      `${response.mode === 'remote' ? '远程 API' : '本地服务'} · ${response.model} → ${translateLanguageLabel(response.targetLanguage)}`,
      ...pairs,
      '链路可用，可以开始识别了。'
    ].join('\n');
  } catch (error) {
    translateStatus.dataset.state = 'error';
    translateStatus.textContent = `测试失败：${error?.message || String(error)}`;
  } finally {
    button.disabled = false;
  }
});

const logsOutput = document.getElementById('logsOutput');function formatLogLine(entry) {
  const time = new Date(Number(entry.t) || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  const level = entry.level && entry.level !== 'info' ? `${entry.level.toUpperCase()} ` : '';
  return `[${clock}] ${level}${entry.msg}`;
}

async function refreshLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BSCG_GET_LOGS' });
    if (!response?.ok) throw new Error(response?.error || '未知错误');
    const logs = response.logs || [];
    logsOutput.textContent = logs.length ? logs.map(formatLogLine).join('\n') : '暂无日志';
    logsOutput.scrollTop = logsOutput.scrollHeight;
  } catch (error) {
    logsOutput.textContent = `日志读取失败：${error?.message || String(error)}`;
  }
}

document.getElementById('logsRefresh').addEventListener('click', refreshLogs);
document.getElementById('logsClear').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'BSCG_CLEAR_LOGS' }); } catch {}
  await refreshLogs();
});
document.getElementById('logsCopy').addEventListener('click', async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BSCG_GET_LOGS' });
    const logs = response?.logs || [];
    const header = `版本 ${chrome.runtime.getManifest().version} · ${navigator.userAgent} · ${new Date().toLocaleString()}\n`;
    await navigator.clipboard.writeText(header + (logs.length ? logs.map(formatLogLine).join('\n') : '（日志为空）'));
    showToast(`已复制 ${logs.length} 条日志`);
  } catch (error) {
    showToast(`复制失败：${error?.message || String(error)}`);
  }
});

const navItems = [...document.querySelectorAll('.nav-item')];
navItems.forEach((item) => item.addEventListener('click', () => {
  navItems.forEach((other) => {
    const selected = other === item;
    other.classList.toggle('active', selected);
    if (selected) other.setAttribute('aria-current', 'page');
    else other.removeAttribute('aria-current');
  });
  for (const section of document.querySelectorAll('.content > .card')) {
    section.hidden = section.id !== item.dataset.section;
  }
  if (item.dataset.section === 'sec-logs') void refreshLogs();
}));

loadPromise = load();
const requestedSection = location.hash.slice(1);
if (requestedSection === 'sec-logs') navItems.find((item) => item.dataset.section === requestedSection)?.click();
void loadPromise.then(() => inspectBrowserRuntime(debugStatus)).catch(() => {});

document.getElementById('logsFeedback').addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'BSCG_OPEN_FEEDBACK' });
});
