importScripts('media-discovery.js', 'feedback-shared.js', 'translate.js', 'translate-onnx-models.js', 'translate-performance.js');
// translate.js 把自己封在 IIFE 里、只对外挂一个 BSCG_TRANSLATE，这里显式取出要用的
// 函数，避免下面直接裸调用时 ReferenceError。
const {
  translateActiveConfig,
  translateIsReady,
  translateUnavailableReason,
  translateLines,
  parseTranslatedLines,
  listTranslateModels
} = BSCG_TRANSLATE;

async function translateWithConfiguredModel(config, lines) {
  try {
    if (config.abortSignal?.aborted) throw new Error('翻译已取消');
    if (config.mode !== 'onnx') {
      const result = await translateLines(config, lines, config.abortSignal || null);
      if (result.ok) BSCG_TRANSLATION_PERFORMANCE.validate(config, result.texts, lines.length);
      return result;
    }
    const response = await sendToOffscreen({
      type: 'BILI_ASR_TRANSLATE_ONNX', model: config.model,
      sourceLanguage: config.sourceLanguage, targetLanguage: config.targetLanguage, lines,
      realtime: Boolean(config.realtime), qualityRetry: Boolean(config.qualityRetry)
    });
    if (config.abortSignal?.aborted) throw new Error('翻译已取消');
    if (!response?.ok) throw new Error(response?.error || 'ONNX 翻译失败');
    const texts = Array.isArray(response.texts) ? response.texts
      : parseTranslatedLines(response.content, lines.length);
    if (texts && (texts.length !== lines.length || !texts.every((text) => typeof text === 'string'))) {
      throw new Error(`ONNX 翻译结果数量或类型无效（期望 ${lines.length} 条）`);
    }
    if (!texts) throw new Error(`ONNX 翻译行数不匹配（期望 ${lines.length} 行）`);
    BSCG_TRANSLATION_PERFORMANCE.validate(config, texts, lines.length);
    return { ok: true, texts };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

const BG_VERSION = chrome.runtime.getManifest().version;
const JOB_TTL_MS = 60 * 60 * 1000;
const TASK_TTL_MS = 6 * 60 * 60 * 1000;
const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 5：结果必须记录媒体时长（mediaDuration），复用时与当前分P 权威时长比对。
// 6：字幕必须覆盖整支视频（拒绝"只有开头几十秒/几乎全是音乐标注"的平台字幕），
//    并记录字幕覆盖度；5 及更早的缓存可能是那种不可用字幕，统一作废并重新识别。
// 7：整句音频时间轴与译文身份；旧的按字数分配时间缓存需要重新生成。
// 8: calibrated CTC sentence ranges; old whole-window rows cannot be realigned.
const RESULT_SCHEMA_VERSION = 8;
const JOB_CLEANUP_ALARM = 'bscg-job-cleanup';
const OFFSCREEN_IDLE_ALARM = 'bscg-offscreen-idle';
const ASR_REQUEST_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const LIVE_SETTINGS_VERSION = 7;
const BROWSER_ENGINE_SETTINGS_VERSION = 5;
const BROWSER_DIRECT_LEAD_SECONDS = 1;
const MAX_LIVE_ROWS = 20000;
const QWEN_LIVE_WINDOW_SECONDS = 7.75;
const SENSEVOICE_LIVE_WINDOW_SECONDS = 11.5;
const LIVE_CAPTION_MAX_CHARACTERS = 18;
const MAX_CONCURRENT_TASKS = 3;
function ensureTaskSlot() {
  if (translationBenchmarkRunning) throw new Error('单句翻译测速正在运行，请等待完成后再开始识别');
  if (liveCaptures.size + activeTranscriptions.size >= MAX_CONCURRENT_TASKS) {
    throw new Error(`本地任务并发已达上限（${MAX_CONCURRENT_TASKS} 个），请等待其中一个完成后再试`);
  }
}

function findTabTranscription(tabId) {
  for (const control of activeTranscriptions.values()) {
    if (control && control.tabId === tabId && !control.cancelled) return control;
  }
  return null;
}

function acceptedTranscriptionResponse(control, title, deduped = false) {
  const queueAhead = Math.max(0, Number(control?.queueAhead) || 0);
  return {
    ok: true,
    backgroundTask: true,
    queued: queueAhead > 0,
    queueAhead,
    queuePosition: queueAhead > 0 ? queueAhead + 1 : 0,
    queueBlocker: String(control?.queueBlocker || ''),
    deduped,
    taskId: control?.taskId || '',
    title: title || '在线视频',
    source: control?.engineLabel || ''
  };
}
const activeTranscriptions = new Map();
const liveCaptures = new Map();
const captionDisplayByTab = new Map();
const browserEngineSessions = new Map();
const browserRequestQueue = [];
let activeBrowserRequest = null;
let browserQueueDraining = false;
let activeBenchmarkId = '';
let translationBenchmarkRunning = false;
let liveTranslationRefreshRevision = 0;
let activeModelDownloadId = '';
let browserSettingsRestartPending = false;
let browserSettingsRestartInFlight = false;
let browserSettingsRestartTimer = null;
const cancelledExtractionRequests = new Set();
const observedMediaByTab = new Map();
const documentByTab = new Map();
const bilibiliHeaderRuleBySession = new Map();
const BILIBILI_DNR_RULE_BASE = 1800000000;
const MEDIA_DNR_RULE_BASE = 1900000000;
const mediaHeaderLeases = new Map();
let mediaHeaderNextId = MEDIA_DNR_RULE_BASE;
let mediaHeaderQueue = Promise.resolve();
let mediaHeaderInitialized = false;
let creatingOffscreenDocument = null;
let offscreenCloseTimer = null;
let liveStartChain = Promise.resolve();
let liveStartRevision = 0;

function watchActiveBenchmark(id) {
  setTimeout(async () => {
    if (!id || activeBenchmarkId !== id) return;
    const response = await sendToOffscreen({ type: 'BILI_ASR_BENCHMARK_STATUS', id }).catch(() => null);
    if (!response) {
      watchActiveBenchmark(id);
      return;
    }
    if (response?.benchmark?.status === 'running') {
      watchActiveBenchmark(id);
      return;
    }
    activeBenchmarkId = '';
    void drainBrowserRequestQueue();
    schedulePendingBrowserSettingsRestart();
    void maybeCloseOffscreenDocument();
  }, 1000);
}

function watchActiveModelDownload(id) {
  setTimeout(async () => {
    if (!id || activeModelDownloadId !== id) return;
    const response = await sendToOffscreen({ type: 'BILI_ASR_MODEL_DOWNLOAD_STATUS', id }).catch(() => null);
    if (!response) {
      watchActiveModelDownload(id);
      return;
    }
    if (response?.download?.status === 'running') {
      void drainBrowserRequestQueue();
      watchActiveModelDownload(id);
      return;
    }
    activeModelDownloadId = '';
    void drainBrowserRequestQueue();
    schedulePendingBrowserSettingsRestart();
    void maybeCloseOffscreenDocument();
  }, 1000);
}

function browserRuntimeBusy() {
  return Boolean(
    liveCaptures.size || activeTranscriptions.size || browserEngineSessions.size ||
    activeBrowserRequest || browserRequestQueue.length || browserQueueDraining ||
    activeBenchmarkId || activeModelDownloadId
  );
}

function schedulePendingBrowserSettingsRestart(delay = 0) {
  if (!browserSettingsRestartPending || browserSettingsRestartInFlight || browserSettingsRestartTimer) return;
  browserSettingsRestartTimer = setTimeout(() => {
    browserSettingsRestartTimer = null;
    void flushPendingBrowserSettingsRestart();
  }, Math.max(0, Number(delay) || 0));
}

async function flushPendingBrowserSettingsRestart() {
  if (!browserSettingsRestartPending || browserSettingsRestartInFlight || browserRuntimeBusy()) return { ok: true, deferred: true };
  browserSettingsRestartPending = false;
  browserSettingsRestartInFlight = true;
  try {
    const response = await sendToOffscreen({ type: 'BILI_ASR_RESTART_ENGINE' });
    if (!response?.ok) throw new Error(response?.error || '推理引擎重启失败');
    return response;
  } catch (error) {
    browserSettingsRestartPending = true;
    throw error;
  } finally {
    browserSettingsRestartInFlight = false;
    if (browserSettingsRestartPending) schedulePendingBrowserSettingsRestart(1500);
  }
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function bilibiliHeaderRuleId(sessionId) {
  return BILIBILI_DNR_RULE_BASE + (parseInt(hashString(`bilibili:${sessionId}`), 16) % 100000000);
}

async function acquireBilibiliHeaderRule(sessionId, referer, urls = []) {
  const id = String(sessionId || '');
  if (!id || !chrome.declarativeNetRequest?.updateSessionRules) throw new Error('临时请求头规则不可用');
  const page = new URL(String(referer || ''));
  if (page.protocol !== 'https:' || !/(^|\.)bilibili\.com$/i.test(page.hostname)) {
    throw new Error('B站 Referer 不是受信任页面');
  }
  const requestDomains = [...new Set((Array.isArray(urls) ? urls : []).map((value) => {
    try {
      const candidate = new URL(String(value || ''));
      return /^https?:$/.test(candidate.protocol) ? candidate.hostname : '';
    } catch {
      return '';
    }
  }).filter(Boolean))].slice(0, 100);
  if (!requestDomains.length) throw new Error('没有可设置 Referer 的音轨域名');
  const ruleId = bilibiliHeaderRuleId(id);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Referer', operation: 'set', value: page.href }]
      },
      condition: {
        requestDomains,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    }]
  });
  bilibiliHeaderRuleBySession.set(id, ruleId);
  return { ok: true, ruleId };
}

async function releaseBilibiliHeaderRule(sessionId) {
  const id = String(sessionId || '');
  if (!id || !chrome.declarativeNetRequest?.updateSessionRules) return { ok: true, idle: true };
  const ruleId = bilibiliHeaderRuleBySession.get(id) || bilibiliHeaderRuleId(id);
  bilibiliHeaderRuleBySession.delete(id);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  return { ok: true, ruleId };
}

function buildMediaKey({ platform = '', pageUrl = '', videoId = '', partId = '', mediaSrc = '', duration = 0 } = {}) {
  let site = platform || 'web';
  try { site = platform || new URL(pageUrl).hostname || 'web'; } catch {}
  const stableId = [videoId, partId].filter(Boolean).join(':') || hashString(`${pageUrl}|${mediaSrc}|${Number(duration) || 0}`);
  return `${site}:${stableId}`;
}

// Only an active direct session can lease a rule. Each rule matches one exact
// resource URL and this extension's requests; page traffic is never rewritten.
function mediaRequestHeaderRule(ruleId, resourceUrl, referer) {
  const resource = new URL(resourceUrl);
  const page = new URL(referer);
  if (!/^https?:$/.test(resource.protocol) || !/^https?:$/.test(page.protocol) ||
      resource.username || resource.password || page.username || page.password) throw new Error('媒体请求上下文无效');
  resource.hash = ''; page.hash = '';
  // Do not send a secure page path on a downgrade.
  if (page.protocol === 'https:' && resource.protocol !== 'https:') throw new Error('拒绝降级传送媒体 Referer');
  const regexFilter = '^' + resource.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  if (regexFilter.length > 1800) throw new Error('媒体 URL 超出临时规则长度限制');
  return { id: ruleId, priority: 2,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: page.href }] },
    condition: { regexFilter, isUrlFilterCaseSensitive: true, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] } };
}

function acquireMediaHeaderRule(sessionId, resourceUrl) {
  const work = mediaHeaderQueue.then(async () => {
    const session = browserEngineSessions.get(sessionId);
    if (!session?.directReferer || session.settled || session.aborting || session.abortError) throw new Error('媒体会话已结束');
    if (!mediaHeaderInitialized) {
      const existing = await chrome.declarativeNetRequest.getSessionRules();
      const stale = existing.filter(rule => rule.id >= MEDIA_DNR_RULE_BASE && rule.id < MEDIA_DNR_RULE_BASE + 1000000);
      if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale.map(rule => rule.id) });
      mediaHeaderInitialized = true;
    }
    if (mediaHeaderLeases.size >= 64) throw new Error('并行媒体请求超过临时规则限制');
    do {
      mediaHeaderNextId = MEDIA_DNR_RULE_BASE + (mediaHeaderNextId - MEDIA_DNR_RULE_BASE + 1) % 1000000;
    } while (mediaHeaderLeases.has(mediaHeaderNextId));
    const rule = mediaRequestHeaderRule(mediaHeaderNextId, resourceUrl, session.directReferer);
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
    mediaHeaderLeases.set(rule.id, sessionId);
    if (session.settled || session.aborting || session.abortError || browserEngineSessions.get(sessionId) !== session) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule.id] });
      mediaHeaderLeases.delete(rule.id);
      throw new Error('媒体会话已结束');
    }
    return { ok: true, ruleId: rule.id };
  });
  mediaHeaderQueue = work.catch(() => {});
  return work;
}

function releaseMediaHeaderRules(sessionId, ruleId = 0) {
  const work = mediaHeaderQueue.then(async () => {
    const ids = [...mediaHeaderLeases].filter(([id, owner]) => owner === sessionId && (!ruleId || id === ruleId)).map(([id]) => id);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    for (const id of ids) mediaHeaderLeases.delete(id);
    return { ok: true };
  });
  mediaHeaderQueue = work.catch(() => {});
  return work;
}

function currentDocumentId(tabId, fallback = '') {
  const normalized = String(fallback || '');
  if (normalized && Number.isInteger(Number(tabId))) documentByTab.set(Number(tabId), normalized);
  return String(normalized || documentByTab.get(Number(tabId)) || '');
}

function responseHeader(details, name) {
  const wanted = String(name || '').toLowerCase();
  const entry = (details?.responseHeaders || []).find((header) => String(header?.name || '').toLowerCase() === wanted);
  return String(entry?.value || '').trim();
}

function rememberObservedMedia(details) {
  const tabId = Number(details?.tabId);
  const rawUrl = String(details?.url || '');
  if (tabId < 0 || !/^https?:/i.test(rawUrl)) return;
  if (Number(details.frameId) === 0 && details.documentId && currentDocumentId(tabId) &&
      details.documentId !== currentDocumentId(tabId)) return;
  const responseType = responseHeader(details, 'content-type').split(';')[0].trim().toLowerCase();
  const isYouTubeMedia = /(?:^|\.)googlevideo\.com\/videoplayback/i.test(rawUrl);
  const hlsByType = /mpegurl|vnd\.apple\.mpegurl/i.test(responseType);
  const dashByType = /dash\+xml/i.test(responseType);
  const isManifest = /\.(?:m3u8|mpd)(?:$|[?#])/i.test(rawUrl) || hlsByType || dashByType;
  const isFragment = /\.(?:m4s|cmfa|cmfv|ts)(?:$|[?#])/i.test(rawUrl);
  const isMediaFile = /\.(?:mp4|m4a|m4v|mov|webm|mp3|aac|ogg|opus|flac|wav)(?:$|[?#])/i.test(rawUrl);
  const mediaByType = /^(?:audio|video)\//i.test(responseType) || /^(?:application\/mp4|application\/ogg)$/i.test(responseType);
  let isBilibiliFragment = false;
  try {
    const hostname = new URL(rawUrl).hostname;
    isBilibiliFragment = isFragment && /(^|\.)(?:bilivideo|hdslb)\.com$/i.test(hostname);
  } catch {}
  const isMediaRequest = details?.type === 'media' && !isFragment;
  if (!isYouTubeMedia && !isManifest && !isMediaFile && !isMediaRequest && !isBilibiliFragment && !mediaByType) return;
  let url = rawUrl;
  let canonicalUrl = rawUrl;
  let mimeType = responseType;
  let bitrate = 0;
  try {
    const parsed = new URL(rawUrl);
    if (isYouTubeMedia) {
      mimeType = decodeURIComponent(parsed.searchParams.get('mime') || '') || mimeType;
      bitrate = Number(parsed.searchParams.get('bitrate')) || 0;
      // 用去掉瞬时 Range 参数的地址去重，但保留播放器真实发出的签名 URL 供下载。
      // 某些 GoogleVideo 签名会覆盖查询参数，改写实际请求可能直接导致 403。
      for (const key of ['range', 'rn', 'rbuf', 'alr']) parsed.searchParams.delete(key);
      canonicalUrl = parsed.href;
    }
  } catch {}
  const records = observedMediaByTab.get(tabId) || [];
  const kind = isManifest
    ? (dashByType || /\.mpd(?:$|[?#])/i.test(rawUrl) ? 'dash' : 'hls')
    : isBilibiliFragment ? 'fragment' : 'media';
  const key = `${kind}\n${canonicalUrl}`;
  const next = records.filter((entry) => entry.key !== key);
  next.push({
    key, url, kind, mimeType, bitrate,
    frameId: Math.max(0, Number(details?.frameId) || 0), at: Date.now()
  });
  const retained = next.slice(-80);
  observedMediaByTab.set(tabId, retained);
  void chrome.storage.session.set({ [`observedMedia:${tabId}`]: retained }).catch(() => {});
}

async function getObservedMediaRecords(tabId) {
  if (observedMediaByTab.has(tabId)) return observedMediaByTab.get(tabId) || [];
  const key = `observedMedia:${tabId}`;
  const stored = await chrome.storage.session.get(key).catch(() => ({}));
  const records = Array.isArray(stored[key]) ? stored[key] : [];
  observedMediaByTab.set(tabId, records);
  return records;
}

chrome.webRequest.onBeforeRequest.addListener(
  rememberObservedMedia,
  { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other'] }
);

// URL suffixes are not enough for modern MSE players: manifests and audio can
// be extensionless or fetched from workers. Classify the response once headers
// are available, similar to media-sniffer extensions, without changing requests.
chrome.webRequest.onResponseStarted.addListener(
  rememberObservedMedia,
  { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);

// ---- 运行日志 ----
// 【排查入口 / read-before-debugging】扩展所有运行环节都经由 pushLog 汇总到这里。
// 设计约定（改动本区块前先读完）：
//   1) 每条日志带自增序号 n。设置页用 n 做增量拉取（BSCG_GET_LOGS + since），
//      因此 n 必须严格单调递增：不允许重排、回退或复用。SW 重启后会把历史条目
//      与本次新条目合并，保留历史最大序号（见 ensureLogBuffer），保证对外单调递增。
//   2) 存储位置由设置项 logPersist（设置 → 日志 → 开发者模式）决定：
//      关闭 = storage.session（内存，浏览器重启即清，最多 LOG_BUFFER_MAX 条）；
//      打开 = storage.local（持久，重启不丢，最多 LOG_PERSIST_MAX 条）。
//   3) 消息前缀即链路名，是排查时的主要过滤手段：
//      [init] [session] [browser] [browser/queue] [browser/inference]
//      [browser/lookahead] [transport] [media/route]
//      [translate] [translate/realtime] [translate/settings] [translate/display]
//      [capture] [cache] [payload] [offscreen] [bilibili] [youtube]
//   4) 只记"能据此定位问题"的事实：走了哪个分支、为什么降级、关键计数与耗时。
//      高频逐帧信息（每个分片、每次 tick）不进日志，需要时读 metrics / 用 DEBUG 级。
//      已有节流的三处（改动时不要去掉节流，否则长片会在十几分钟内刷满缓冲区）：
//      [translate] 批次进度 10s、[translate/realtime] 失败 10s、
//      [browser/lookahead] 窗口进度 20s。
//   5) 典型症状 → 该看哪条日志（按此顺序查，能少走弯路）：
//      · 字幕一直显示原文            → [translate/realtime] 单句翻译失败？
//                                      否则看 [media/route] 是否降级到实时取音
//                                      （实时取音链路没有未来音频，本来就不能提前翻译）
//      · 字幕比声音越来越慢          → [browser/lookahead] 的"识别领先"是否持续下降，
//                                      再看 [browser/inference] 单次推理耗时
//      · 开着翻译却一次都没请求模型  → 有没有 [translate] 启用行（没有 = 配置未就绪）；
//                                      有启用但无进度 = 看 [xx/direct] 是否"整轨直取失败…切换实时取音"
//      · 播放中卡顿/字幕整段消失     → [session] 收尾原因 + [browser/queue] 排队情况
//      · 换了视频还显示旧字幕        → [cache] 作废记录 + [session] 的媒体/文档校验记录
//      · 拖动进度条后字幕空白        → [translate/realtime] 的"已丢弃 N 个单句"，
//                                      其后应紧跟新的入队记录；否则队列没重建
const LOG_BUFFER_MAX = 600;
const LOG_PERSIST_MAX = 4000;
const LOG_STORAGE_KEY = 'bscgLogs';
let logBuffer = [];
let logSeq = 0;
let logRestored = false;
let logRestorePromise = null;
let logWriteQueue = Promise.resolve();
// 落盘开关：由 settings.logPersist 驱动，onChanged 里同步，决定日志写 session 还是 local。
let logPersistEnabled = false;
let logPersistTimer = null;
// 页面上的进度条要能显示"最新进展"，因此日志除了进缓冲区，还要广播给标签页。
let liveLogSink = null;

function logStorageArea() {
  try { return logPersistEnabled ? chrome.storage.local : chrome.storage.session; } catch { return null; }
}

function trimLogBuffer() {
  const max = logPersistEnabled ? LOG_PERSIST_MAX : LOG_BUFFER_MAX;
  if (logBuffer.length > max) logBuffer.splice(0, logBuffer.length - max);
}

// 单次恢复历史并与启动早期新条目合并，避免并发读取看到尚未恢复的缓冲。
// 恢复期间的新条目在历史最大序号之后编号；写盘与对外读取都必须先 await。
async function ensureLogBuffer() {
  if (logRestored) return logBuffer;
  if (!logRestorePromise) logRestorePromise = (async () => {
    let stored = null;
    try {
      const settings = await chrome.storage.local.get('logPersist');
      logPersistEnabled = Boolean(settings.logPersist);
      stored = (await logStorageArea()?.get(LOG_STORAGE_KEY))?.[LOG_STORAGE_KEY];
      if (!Array.isArray(stored) || !stored.length) {
        const other = logPersistEnabled ? chrome.storage.session : chrome.storage.local;
        stored = (await other?.get(LOG_STORAGE_KEY))?.[LOG_STORAGE_KEY];
      }
    } catch {}
    const history = Array.isArray(stored) ? stored.filter(entry => entry && entry.msg) : [];
    const keys = new Set();
    const merged = [];
    let seq = 0;
    for (const entry of [...history, ...logBuffer]) {
      const key = JSON.stringify([entry.t, entry.level, entry.msg]);
      if (keys.has(key)) continue;
      keys.add(key);
      seq = Math.max(seq + 1, Number(entry.n) || 0);
      merged.push({ ...entry, n: seq });
    }
    logBuffer = merged;
    logSeq = Math.max(logSeq, seq);
    trimLogBuffer();
    logRestored = true;
    return logBuffer;
  })();
  return logRestorePromise;
}

function scheduleLogPersist() {
  clearTimeout(logPersistTimer);
  logPersistTimer = setTimeout(() => {
    logPersistTimer = null;
    logWriteQueue = logWriteQueue.catch(() => {}).then(async () => {
      await ensureLogBuffer(); // never overwrite history with startup-only rows
      await logStorageArea()?.set({ [LOG_STORAGE_KEY]: logBuffer.slice(-(logPersistEnabled ? LOG_PERSIST_MAX : LOG_BUFFER_MAX)) });
    }).catch(() => {});
  }, 500);
}

// 落盘开关切换时迁移存储：新区域写入当前缓冲，旧区域的键清掉，避免两份日志并存。
async function migrateLogStorage() {
  logWriteQueue = logWriteQueue.catch(() => {}).then(async () => {
    await ensureLogBuffer();
    const target = logStorageArea();
    const stale = logPersistEnabled ? chrome.storage.session : chrome.storage.local;
    await target?.set({ [LOG_STORAGE_KEY]: logBuffer.slice(-(logPersistEnabled ? LOG_PERSIST_MAX : LOG_BUFFER_MAX)) });
    await stale?.remove(LOG_STORAGE_KEY); // only remove after a successful write
  });
  return logWriteQueue;
}

function pushLog(level, message) {
  const entry = { n: ++logSeq, t: Date.now(), level: String(level || 'info'), msg: String(message).slice(0, 600) };
  logBuffer.push(entry);
  trimLogBuffer();
  scheduleLogPersist();
  try { liveLogSink?.(entry); } catch {}
}

async function getLogs() {
  return ensureLogBuffer();
}

// 广播给页面进度条：节流 200ms，只保留最新一条；串行发送避免并发打满消息通道。
// 初始化版本、缓存判定与发送凭据属于"要主动查日志"的信息，不往进度条里塞。
const LIVE_LOG_INTERVAL_MS = 200;
const LIVE_LOG_SILENT = /^(?:\[init\]|\[cache\]|\[payload\])/;
let liveLogPending = null;
let liveLogTimer = null;
let liveLogSending = false;

function publishLiveLog(entry) {
  const text = String(entry?.msg || '').trim();
  if (!text || LIVE_LOG_SILENT.test(text)) return;
  liveLogPending = { at: Number(entry.t) || Date.now(), level: entry.level, text: text.slice(0, 300) };
  if (liveLogTimer || liveLogSending) return;
  liveLogTimer = setTimeout(() => {
    liveLogTimer = null;
    void flushLiveLog();
  }, LIVE_LOG_INTERVAL_MS);
}

async function flushLiveLog() {
  if (liveLogSending || !liveLogPending) return;
  const payload = liveLogPending;
  liveLogPending = null;
  liveLogSending = true;
  try {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id)) continue;
      if (!/^(https?|file):/i.test(String(tab.url || ''))) continue;
      try { await chrome.tabs.sendMessage(tab.id, { type: 'BSCG_LOG_ENTRY', entry: payload }); } catch {}
    }
  } finally {
    liveLogSending = false;
    if (liveLogPending) {
      liveLogTimer = setTimeout(() => { liveLogTimer = null; void flushLiveLog(); }, LIVE_LOG_INTERVAL_MS);
    }
  }
}
liveLogSink = publishLiveLog;

const DEFAULTS = {
  prompt: '完整总结视频字幕中的观点和内容。',  language: 'zh', asrLanguage: 'auto',
  asrProfile: 'sensevoice_browser',
  asrBackend: 'auto',
  gpuPreference: 'high-performance',
  summaryEngine: 'external-page',
  chatgptUrl: 'https://chatgpt.com/',
  aiStudioPrompt: '完整总结视频字幕中的观点和内容。',
  aiStudioUrl: 'https://aistudio.google.com/prompts/new_chat?model=gemini-3.1-pro-preview',
  deepseekPrompt: '完整总结视频字幕中的观点和内容。',
  deepseekUrl: 'https://chat.deepseek.com/',
  defaultDestination: 'chatgpt',
  liveChunkSeconds: 11.5,
  recognitionThreads: 0,
  scanPlaybackRate: 4,
  voiceEnhance: false,
  voiceEnhancePreset: 'balanced',
  autoCaptionsMainstream: false,
  autoCaptionsOther: false,
  // 前瞻字幕翻译：只对音轨整轨前瞻（浏览器本地识别）的字幕段生效。
  // 本地默认指向本机 UNSLOTH Studio 的 OpenAI 兼容端点；远程走任意兼容服务。
  translateEnabled: false,
  translateMode: 'local',
  translateLocalBaseUrl: 'http://127.0.0.1:8888/v1',
  translateLocalApiKey: '',
  translateLocalModel: '',
  translateRemoteBaseUrl: 'https://api.openai.com/v1',
  translateRemoteApiKey: '',
  translateRemoteModel: '',
  translateOnnxModel: 'qwen3-0.6b-q4f16',
  translateTargetLanguage: 'zh',
  // translated：只显示译文（默认）；bilingual：译文为主 + 原文字号更小
  translateDisplayMode: 'translated',
  // 开发者模式：日志落盘。false = 只在当前浏览器会话内保留（storage.session，重启即空）；
  // true = 写入 storage.local，浏览器重启后仍可回溯。切换时由 migrateLogStorage 迁移。
  logPersist: false
};
const REMOVED_TRANSLATION_KEYS = [
  'translationApiUrl', 'translationServiceName', 'translationModel',
  'translationApiKey', 'translationTargetLanguage', 'subtitleDisplayMode',
  // 旧版的一键发送设置已废弃；当前版本不会替用户提交消息。
  'autoSendSummary' 
];
const REMOVED_NATIVE_KEYS = [
  'modelDir', 'autoDownloadModel', 'nativeEngineId', 'nativeProviderCuda',
  'voiceEnhanceEngine', 'browserEngine', 'modelPreparationStatus',
  'modelPreparationError'
];

async function initializeExtension() {
  const current = await chrome.storage.local.get([
    ...Object.keys(DEFAULTS), ...REMOVED_NATIVE_KEYS,
    'liveSettingsVersion', 'browserEngineSettingsVersion'
  ]);
  // 落盘开关必须在写第一条日志之前确定：否则 [init] 会被写进 session，
  // 重启后读不到，表现为"已开启落盘却每次重启都没有历史"。
  logPersistEnabled = Boolean(current.logPersist);
  // 后台每次启动都留一条版本记录：出问题时能直接从日志确认真正在跑的是哪一版。
  pushLog('info', `[init] 后台已就绪 version=${BG_VERSION} 日志落盘=${logPersistEnabled ? '开' : '关'}`);
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  if (current.liveSettingsVersion !== LIVE_SETTINGS_VERSION) {
    await chrome.storage.local.set({
      liveChunkSeconds: 11.5,
      // 2× 是旧版默认值；升级用户自动迁移到新的 4× 默认。曾主动选择
      // 其它速度的用户保持原设置，并仍可在设置页选择 1–8×。
      scanPlaybackRate: Number(current.scanPlaybackRate) === 2
        ? 4
        : Math.max(1, Math.min(8, Number(current.scanPlaybackRate) || 4)),
      liveSettingsVersion: LIVE_SETTINGS_VERSION
    });
  }
  if (current.browserEngineSettingsVersion !== BROWSER_ENGINE_SETTINGS_VERSION) {
    const asrProfile = current.asrProfile === 'qwen3_asr_0_6b'
      ? 'qwen3_asr_0_6b'
      : 'sensevoice_browser';
    await chrome.storage.local.set({
      asrProfile,
      // Qwen CPU was retired in 0.16.0. Keep the user's model choice, but
      // migrate every legacy Qwen/WASM selection to the only valid route.
      asrBackend: asrProfile === 'qwen3_asr_0_6b'
        ? 'auto'
        : current.asrBackend === 'wasm' ? 'wasm' : 'auto',
      gpuPreference: 'high-performance',
      summaryEngine: 'external-page',
      browserEngineSettingsVersion: BROWSER_ENGINE_SETTINGS_VERSION
    });
  }
  await chrome.storage.local.remove([...REMOVED_TRANSLATION_KEYS, ...REMOVED_NATIVE_KEYS, 'aheadSeconds', 'timelineBufferVersion']);
  await cleanupJobCache(false);
  await chrome.alarms.create(JOB_CLEANUP_ALARM, { periodInMinutes: 15 });
}

chrome.runtime.onInstalled.addListener((details) => {
  void initializeExtension();
});
chrome.runtime.onStartup.addListener(() => { void initializeExtension(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OFFSCREEN_IDLE_ALARM) {
    void closeIdleOffscreenDocument();
    return;
  }
  if (alarm.name === JOB_CLEANUP_ALARM || alarm.name.startsWith('bscg-job-expire:')) {
    void cleanupJobCache(false);
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('logPersist' in changes) {
    // 落盘开关切换：先更新写入门控，再记一条（这条会写进新区域），最后迁移旧区域数据。
    const next = Boolean(changes.logPersist.newValue);
    if (next !== logPersistEnabled) {
      logPersistEnabled = next;
      pushLog('info', `[log] 日志落盘${next ? '已开启：写入 storage.local，浏览器重启后仍可回溯' : '已关闭：仅保留当前浏览器会话'}`);
      void migrateLogStorage().catch(() => {});
    }
  }
  if (Object.keys(changes).some(key => key === 'language' || key.startsWith('translate'))) {
    void refreshLiveTranslationSettings().catch(error => pushLog('warn', `[translate/settings] ${error?.message || String(error)}`));
  }
  for (const [key, change] of Object.entries(changes)) {
    if (key.startsWith('job:') && change.newValue === undefined) {
      void chrome.alarms.clear(`bscg-job-expire:${key.slice(4)}`);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  observedMediaByTab.delete(tabId);
  documentByTab.delete(tabId);
  void chrome.storage.session.remove(`observedMedia:${tabId}`).catch(() => {});
  cancelTranscriptionsForTab(tabId);
  void cleanupClosedTab(tabId);
  if (liveCaptures.has(tabId)) void abortLiveCapture(liveCaptures.get(tabId), '标签页已关闭');
  setTimeout(() => {
    void chrome.runtime.sendMessage({ type: 'BILI_ASR_FORGET_TAB', target: 'offscreen', tabId }).catch(() => {});
  }, 0);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    observedMediaByTab.delete(tabId);
    void chrome.storage.session.remove(`observedMedia:${tabId}`).catch(() => {});
    cancelTranscriptionsForTab(tabId, changeInfo.url);
    void pruneResultsForTabUrl(tabId, changeInfo.url);
    void pruneJobsForTargetTabUrl(tabId, changeInfo.url);
  }
  const session = liveCaptures.get(tabId);
  if (session && changeInfo.url && !matchesLiveSource(session, changeInfo.url)) {
    void abortLiveCapture(session, '页面已经切换，实时字幕已停止，以免混入其他视频的声音');
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-live-captions') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    if (liveCaptures.has(tab.id)) await requestLiveStop(tab.id);
    else await startLiveCapture(tab.id);
  } catch (error) {
    await sendLive(tab.id, { type: 'BSCG_LIVE_ERROR', error: error?.message || String(error) });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (['BILI_ASR_MEDIA_HEADERS_ACQUIRE', 'BILI_ASR_MEDIA_HEADERS_RELEASE'].includes(message?.type) && message.target === 'background') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('offscreen.html')) {
      sendResponse({ ok: false, error: '仅离屏音轨引擎可申请临时请求头' });
      return false;
    }
    const action = message.type === 'BILI_ASR_MEDIA_HEADERS_ACQUIRE'
      ? acquireMediaHeaderRule(String(message.sessionId || ''), String(message.url || ''))
      : releaseMediaHeaderRules(String(message.sessionId || ''), Number(message.ruleId) || 0);
    action.then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BILI_ASR_EVENT') {
    handleBrowserEngineEvent(message);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'BILI_ASR_DNR_ACQUIRE' && message?.target === 'background') {
    acquireBilibiliHeaderRule(
      String(message.sessionId || ''), String(message.referer || ''), message.urls || []
    ).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BILI_ASR_DNR_RELEASE' && message?.target === 'background') {
    releaseBilibiliHeaderRule(String(message.sessionId || ''))
      .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BILI_ASR_PAGE_FETCH_REQUEST' && message?.target === 'background') {
    pageFetchInTab(
      Number(message.tabId), String(message.url || ''), String(message.requestId || ''),
      Number(message.maxBytes) || 536870912, Number(message.frameId) || 0
    ).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BILI_ASR_PAGE_FETCH_CANCEL' && message?.target === 'background') {
    pageFetchCancelInTab(
      Number(message.tabId), String(message.requestId || ''), Number(message.frameId) || 0
    ).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_LOCAL_FILE_AUTHORIZE') {
    const token = String(message.token || '');
    const size = Math.max(0, Number(message.size) || 0);
    if (!sender.tab?.id || !/^file:/i.test(sender.url || sender.tab.url || '') || !token || !size || size > 512 * 1024 * 1024) {
      sendResponse({ ok: false, error: '本地文件桥授权请求无效' });
      return false;
    }
    chrome.storage.session.set({
      [`localFileAuth:${token}`]: { tabId: sender.tab.id, size, expiresAt: Date.now() + 60 * 1000 }
    }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (['BSCG_LOCAL_FILE_BEGIN', 'BSCG_LOCAL_FILE_CHUNK', 'BSCG_LOCAL_FILE_END'].includes(message?.type)) {
    const mappedType = message.type.replace(/^BSCG_/, 'BILI_ASR_');
    sendToOffscreen({ ...message, type: mappedType, tabId: sender.tab?.id || message.tabId || 0 })
      .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_SCAN_READY' || message?.type === 'BSCG_SCAN_ERROR') {
    const scan = browserEngineSessions.get(String(message.sessionId || ''));
    if (!scan?.scanMode || scan.settled || sender.tab?.id !== scan.tabId || sender.frameId !== scan.scanFrameId) {
      sendResponse({ ok: false, error: '扫描任务已经结束' });
      return false;
    }
    if (message.type === 'BSCG_SCAN_ERROR') {
      scan.abort(message.error || '播放器倍速采集已中断');
      sendResponse({ ok: true });
      return false;
    }
    sendToOffscreen({ ...message, type: 'BILI_ASR_SCAN_READY', tabId: scan.tabId })
      .then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_SCAN_PROGRESS') {
    const scan = browserEngineSessions.get(String(message.sessionId || ''));
    if (scan?.scanMode && !scan.settled) {
      const current = Math.max(0, Number(message.currentTime) || 0);
      const duration = Math.max(current, Number(message.duration) || 0);
      scan.onProgress?.({ type: 'progress', text: `自动扫描 ${formatTime(current)} / ${formatTime(duration)} · ${Number(message.playbackRate || scan.scanPlaybackRate).toFixed(1)}×` });
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'BSCG_SCAN_ENDED') {
    const scan = browserEngineSessions.get(String(message.sessionId || ''));
    if (scan?.scanMode && !scan.settled) {
      void (async () => {
        if (scan.externalCapture && Number.isInteger(scan.scanFrameId)) {
          await chrome.tabs.sendMessage(scan.tabId, { type: 'BSCG_INPAGE_CAPTURE_STOP', sessionId: scan.sessionId }, { frameId: scan.scanFrameId }).catch(() => null);
        }
        return sendToOffscreen({ type: 'BILI_ASR_STOP', tabId: scan.tabId, sessionId: scan.sessionId, reason: 'scan-complete' });
      })().then(sendResponse).catch((error) => {
        finishBrowserEngineSession(scan, error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
      return true;
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'BSCG_EXTRACT_CURRENT') {
    extractCurrentTab(message.tabId || sender.tab?.id, { ...message, documentId: currentDocumentId(message.tabId || sender.tab?.id, sender.documentId || message.documentId) }).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }
  if (message?.type === 'BSCG_VIDEO_TRANSLATION_GET' || message?.type === 'BSCG_VIDEO_TRANSLATION_SET') {
    resolveRequestedTabId(message, sender).then((tabId) => videoTranslationPreference(tabId, message))
      .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_LIVE_START') {
    const liveMessage = { ...message, documentId: currentDocumentId(message.tabId || sender.tab?.id, sender.documentId || message.documentId) };
    resolveRequestedTabId(message, sender).then((tabId) => startLiveCapture(tabId, Boolean(message.ignoreCache), liveMessage)).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }
  if (message?.type === 'BSCG_LIVE_STOP') {
    const tabId = sender.tab?.id || message.tabId || liveCaptures.keys().next().value;
    requestLiveStop(tabId, message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }
  if (message?.type === 'BSCG_CAPTIONS_SHOW') {
    resolveRequestedTabId(message, sender).then((tabId) => showRetainedCaptions(tabId, message))
      .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_EXPORT_CURRENT') {
    exportCurrentSubtitles(message.tabId || sender.tab?.id, message.pageUrl || '', message.segments).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }
  if (message?.type === 'BSCG_LIVE_SEEK') {
    handleLiveSeek(message.tabId || sender.tab?.id, Number(message.currentTime) || 0).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }
  if (message?.type === 'BSCG_LIVE_MEDIA_ENDED') {
    const session = liveCaptures.get(sender.tab?.id);
    const input = browserEngineSessions.get(session?.browserControl?.engineSessionId || '');
    if (session?.mode === 'browser-capture' && !session.isLive && message.sessionId === session.sessionId && input && !input.externalCapture) {
      sendToOffscreen({ type: 'BILI_ASR_STOP', sessionId: input.sessionId, tabId: input.tabId, reason: 'media-ended' })
        .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    sendResponse({ ok: true, ignored: true });
    return false;
  }
  if (message?.type === 'BSCG_VIDEO_POSITION') {
    const reportedTabId = message.tabId || sender.tab?.id;
    const session = liveCaptures.get(reportedTabId);
    if (session) {
      session.currentVideoTime = Math.max(0, Number(message.currentTime) || 0);
      session.playbackRate = Math.max(0.1, Number(message.playbackRate) || 1);
      session.paused = Boolean(message.paused);
      // 翻译队列据此判断压着的行是否还领先播放头；被追平（快进/回拖）就立刻
      // 落地识别原文，不让用户面对空字幕。
      session.translator?.tick?.();
      const translationProgress = session.translator?.stats?.();
      if (session.mode === 'capture') rememberCaptureClock(session, message);
      if (session.backend === 'browser') {
        void sendToOffscreen({
          type: 'BILI_ASR_CLOCK', tabId: session.tabId,
          sessionId: session.browserControl?.engineSessionId || session.sessionId,
          mediaKey: session.mediaKey || '',
          currentTime: session.currentVideoTime,
          duration: Number(message.duration) || 0,
          playbackRate: session.playbackRate,
          preservesPitch: message.preservesPitch,
          paused: session.paused,
          translatedThrough: translationProgress?.translatedContiguousTo,
          translationLatencyP95Ms: translationProgress?.latencyP95Ms
        }).catch(() => {});
      }
    }
    const scan = [...browserEngineSessions.values()].find((candidate) => candidate.scanMode && candidate.tabId === reportedTabId && !candidate.settled);
    if (scan && !session && sender.frameId === scan.scanFrameId &&
        (!message.sessionId || message.sessionId === scan.sessionId)) {
      void sendToOffscreen({
        type: 'BILI_ASR_CLOCK', tabId: reportedTabId,
        sessionId: scan.sessionId, mediaKey: scan.mediaKey || '',
        currentTime: Math.max(0, Number(message.currentTime) || 0),
        duration: Math.max(0, Number(message.duration) || 0),
        playbackRate: Math.max(0.1, Number(message.playbackRate) || 1),
        preservesPitch: message.preservesPitch,
        paused: Boolean(message.paused)
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'BSCG_CAPTURE_CHUNK') {
    const browserInput = browserEngineSessions.get(String(message.sessionId || ''));
    if (browserInput?.externalCapture && !browserInput.settled &&
        sender.tab?.id === browserInput.tabId && sender.frameId === browserInput.scanFrameId) {
      sendToOffscreen({
        type: 'BILI_ASR_PCM_CHUNK', sessionId: browserInput.sessionId,
        pcmBase64: message.pcmBase64, durationSeconds: Number(message.durationSeconds) || 0,
        sequence: message.sequence, captureGeneration: message.captureGeneration,
        timing: message.timing
      }).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    sendResponse({ ok: false, error: '对应的浏览器捕获任务不存在' });
    return false;
  }
  if (message?.type === 'BSCG_CAPTURE_RESET') {
    const input = browserEngineSessions.get(String(message.sessionId || ''));
    if (!input?.externalCapture || input.settled || sender.tab?.id !== input.tabId || sender.frameId !== input.scanFrameId) {
      sendResponse({ ok: true, ignored: true });
      return false;
    }
    sendToOffscreen({
      type: 'BILI_ASR_CAPTURE_SEEK', sessionId: input.sessionId,
      captureGeneration: message.captureGeneration, timing: message.timing
    }).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_CAPTURE_BOUNDARY') {
    const input = browserEngineSessions.get(String(message.sessionId || ''));
    if (!input?.isLive || !input.externalCapture || input.settled ||
        sender.tab?.id !== input.tabId || sender.frameId !== input.scanFrameId) {
      sendResponse({ ok: true, ignored: true });
      return false;
    }
    sendToOffscreen({ type: 'BILI_ASR_CAPTURE_BOUNDARY', sessionId: input.sessionId })
      .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_CAPTURE_STOPPED') {
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'BSCG_CAPTURE_ERROR') {
    const browserInput = browserEngineSessions.get(String(message.sessionId || ''));
    if (browserInput?.externalCapture && !browserInput.settled) browserInput.abort(message.error || '页面内音频捕获失败');
    const session = findLiveSession(message.sessionId);
    if (session) void failLiveCapture(session, message.error || '标签页音频捕获失败');
  }
  if (message?.type === 'BSCG_FRAME_VIDEO_PRESENT') {
    // 播放器 iframe 里的视频代理报告本页有视频；中转给顶层帧显示入口气泡。
    if (sender.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, {
        type: 'BSCG_TAB_FRAME_VIDEO', frameId: sender.frameId,
        present: message.present !== false && bscgPageAllowsControls(sender.tab.url)
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'BSCG_CLEAR_CACHE') {
    resolveRequestedTabId(message, sender).then((tabId) => clearResultCacheForTab(tabId)).then((removed) => sendResponse({ ok: true, removed })).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }
  if (message?.type === 'BSCG_LIVE_UI_READY') {
    resolveRequestedTabId(message, sender).then((tabId) => getLiveUiState(tabId, message.pageUrl || '')).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }
  if (message?.type === 'BSCG_AUTO_START_CHECK') {
    resolveRequestedTabId(message, sender)
      .then((tabId) => chrome.tabs.get(tabId))
      .then((tab) => shouldAutoStartCaptions(tab))
      .then((autoStart) => sendResponse({ ok: true, autoStart }))
      .catch(() => sendResponse({ ok: true, autoStart: false }));
    return true;
  }
  if (message?.type === 'BSCG_OPEN_FEEDBACK') {
    openFeedbackPage(sender.tab?.id || message.tabId, message.error || '').then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: '无法打开反馈页' }));
    return true;
  }
  if (message?.type === 'BSCG_FEEDBACK_CONTEXT') {
    // Only our dedicated extension page can retrieve a prepared report.
    const expected = chrome.runtime.getURL('feedback.html');
    if (sender.id !== chrome.runtime.id || String(sender.url || '').split('?')[0] !== expected) {
      sendResponse({ ok: false }); return false;
    }
    const key = `feedbackDraft:${String(message.draftId || '').slice(0, 80)}`;
    chrome.storage.session.get(key).then(values => sendResponse({ ok: true, diagnostics: values[key] || {} }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'BSCG_OPEN_OPTIONS') {
    const opening = message.section === 'logs'
      ? chrome.tabs.create({ url: chrome.runtime.getURL('options.html#sec-logs') })
      : chrome.runtime.openOptionsPage();
    opening.then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }
  if (message?.type === 'BSCG_CAPTURE_ENDED') {
    const browserInput = browserEngineSessions.get(String(message.sessionId || ''));
    const completion = browserInput?.externalCapture && !browserInput.settled
      ? sendToOffscreen({
          type: 'BILI_ASR_STOP', tabId: browserInput.tabId,
          sessionId: browserInput.sessionId, reason: message.reason || 'stream-ended'
        })
      : Promise.resolve({ ok: true });
    completion.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_TASK_CANCEL') {
    resolveRequestedTabId(message, sender)
      .then((tabId) => cancelTranscriptionTask(tabId, message.taskId || '', message.requestId || ''))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_CAPTURE_STARTED') {
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'BSCG_LOG') {
    pushLog(message.level || 'info', `[${message.source || 'ext'}] ${message.text || ''}`);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'BSCG_GET_LOGS') {
    // 设置页自动刷新协议：since > 0 时只回传序号更大的新条目。
    // truncated 为真说明 since 太旧、对应条目已被环形缓冲挤掉，设置页必须整体重载
    // 而不是继续增量追加，否则会丢中间一段日志。
    const since = Math.max(0, Number(message.since) || 0);
    getLogs().then((logs) => {
      const last = logs.length ? Number(logs[logs.length - 1].n) || 0 : 0;
      const first = logs.length ? Number(logs[0].n) || 0 : 0;
      sendResponse({
        ok: true,
        logs: since > 0 ? logs.filter((entry) => (Number(entry.n) || 0) > since) : logs,
        seq: last,
        total: logs.length,
        truncated: since > 0 && (first > since + 1 || since > last)
      });
    }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_BROWSER_STATUS') {
    sendToOffscreen({ type: 'BILI_ASR_CAPABILITIES' }).then((response) => {
      const runningDownload = response?.modelDownload?.status === 'running' ? response.modelDownload.id || '' : '';
      const runningBenchmark = response?.benchmark?.status === 'running' ? response.benchmark.id || '' : '';
      if (runningDownload && activeModelDownloadId !== runningDownload) {
        activeModelDownloadId = runningDownload;
        watchActiveModelDownload(runningDownload);
      }
      if (runningBenchmark && activeBenchmarkId !== runningBenchmark) {
        activeBenchmarkId = runningBenchmark;
        watchActiveBenchmark(runningBenchmark);
      }
      sendResponse(response);
    }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_BROWSER_BENCHMARK_START') {
    if (translationBenchmarkRunning || liveCaptures.size || activeTranscriptions.size || browserEngineSessions.size || activeBrowserRequest || browserRequestQueue.length || activeModelDownloadId) {
      sendResponse({ ok: false, error: '请先停止或取消当前字幕/总结任务' });
      return false;
    }
    sendToOffscreen({
      type: 'BILI_ASR_BENCHMARK_START',
      profile: message.profile,
      backend: message.backend,
      cpuThreads: Number(message.cpuThreads) || 0
    }).then((response) => {
      if (response?.ok && response.benchmark?.status === 'running') activeBenchmarkId = response.benchmark.id || '';
      if (activeBenchmarkId) watchActiveBenchmark(activeBenchmarkId);
      sendResponse(response);
    }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_BROWSER_BENCHMARK_STATUS') {
    sendToOffscreen({ type: 'BILI_ASR_BENCHMARK_STATUS', id: message.id || '' })
      .then((response) => {
        if (response?.benchmark?.status !== 'running') {
          activeBenchmarkId = '';
          void drainBrowserRequestQueue();
          schedulePendingBrowserSettingsRestart();
        }
        sendResponse(response);
      }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_BROWSER_BENCHMARK_CANCEL') {
    sendToOffscreen({ type: 'BILI_ASR_BENCHMARK_CANCEL', id: message.id || '' })
      .then((response) => {
        activeBenchmarkId = '';
        void drainBrowserRequestQueue();
        schedulePendingBrowserSettingsRestart();
        sendResponse(response);
      }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_MODEL_DOWNLOAD_START') {
    if (translationBenchmarkRunning || liveCaptures.size || activeTranscriptions.size || browserEngineSessions.size || activeBrowserRequest || browserRequestQueue.length || activeBenchmarkId) {
      sendResponse({ ok: false, error: '请先停止或取消当前字幕、总结或测速任务' });
      return false;
    }
    sendToOffscreen({
      type: 'BILI_ASR_MODEL_DOWNLOAD_START',
      routeId: String(message.routeId || ''),
      parallelism: Number(message.parallelism) || 4
    })
      .then((response) => {
        const runningId = response?.ok && response.download?.status === 'running' ? response.download.id || '' : '';
        if (runningId && activeModelDownloadId !== runningId) {
          activeModelDownloadId = runningId;
          watchActiveModelDownload(runningId);
        }
        sendResponse(response);
      }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_MODEL_DOWNLOAD_STATUS') {
    sendToOffscreen({ type: 'BILI_ASR_MODEL_DOWNLOAD_STATUS', id: message.id || '' })
      .then((response) => {
        if (response?.download?.status !== 'running') {
          activeModelDownloadId = '';
          void drainBrowserRequestQueue();
          schedulePendingBrowserSettingsRestart();
        }
        sendResponse(response);
      }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_MODEL_DOWNLOAD_CANCEL') {
    sendToOffscreen({
      type: 'BILI_ASR_MODEL_DOWNLOAD_CANCEL',
      id: message.id || '',
      routeId: String(message.routeId || '')
    })
      .then((response) => {
        activeModelDownloadId = response?.download?.status === 'running' ? response.download.id || '' : '';
        void drainBrowserRequestQueue();
        schedulePendingBrowserSettingsRestart();
        sendResponse(response);
      }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_CLEAR_MODEL_CACHE') {
    sendToOffscreen({ type: 'BILI_ASR_CLEAR_CACHE' })
      .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_BROWSER_SETTINGS_APPLIED') {
    browserSettingsRestartPending = true;
    if (browserRuntimeBusy()) {
      sendResponse({ ok: true, deferred: true, reason: '当前识别结束后生效' });
      return false;
    }
    flushPendingBrowserSettingsRestart()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_CLEAR_LOGS') {
    // 清空两个区域：落盘开关可能刚切换过，另一侧还留着上一次的副本。
    logWriteQueue = logWriteQueue.catch(() => {}).then(async () => {
      await ensureLogBuffer();
      logBuffer = []; // retain the sequence, so an old cursor never hides new rows
      await Promise.all([chrome.storage.session.remove(LOG_STORAGE_KEY), chrome.storage.local.remove(LOG_STORAGE_KEY)]);
    });
    logWriteQueue.then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_CAPTURE_NOTE') {
    // 页面内捕获的看门狗提示：经后台转成气泡状态（content script 之间不能直接互发）
    const noteSession = findLiveSession(message.sessionId);
    if (noteSession) void sendLive(noteSession.tabId, { type: 'BSCG_LIVE_PROGRESS', text: String(message.text || '') });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'BSCG_TRANSLATE_LIST_MODELS') {
    // 设置页获取可选模型：本地（UNSLOTH/llama.cpp）与远程（OpenAI 兼容）同一形状。
    (async () => {
      const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
      const config = translateActiveConfig({ ...stored, ...(message.settings || {}) });
      const models = config.mode === 'onnx'
        ? Object.entries(globalThis.BSCG_ONNX_TRANSLATION_MODELS).map(([id, spec]) => ({ id, label: spec.label }))
        : await listTranslateModels(config);
      return { ok: true, models, config: { baseUrl: config.baseUrl, model: config.model, targetLanguage: config.targetLanguage } };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_TRANSLATE_BENCHMARK') {
    (async () => {
      if (liveCaptures.size || activeBenchmarkId || activeModelDownloadId || activeTranscriptions.size || activeBrowserRequest || browserRequestQueue.length || browserEngineSessions.size) {
        throw new Error('请先停止字幕和总结任务，再运行独立翻译测速');
      }
      if (translationBenchmarkRunning) throw new Error('翻译测速正在运行');
      translationBenchmarkRunning = true;
      try {
        const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
        const config = translateActiveConfig({ ...stored, ...(message.settings || {}), translateEnabled: true });
        if (!translateIsReady(config)) throw new Error(translateUnavailableReason(config));
        const report = await BSCG_TRANSLATION_PERFORMANCE.measure(config, translateWithConfiguredModel);
        await chrome.storage.session.set({ [`translationPerformance:${report.fingerprint}`]: report });
        pushLog('info', `[translate/benchmark] 单句 P95=${Math.round(report.p95Ms)}ms ` +
          `100ms参考=${report.meets100msTarget ? '达到' : '未达到'} 不自动关闭翻译`);
        return { ok: true, report };
      } finally { translationBenchmarkRunning = false; }
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'BSCG_TRANSLATE_TEST') {
    // 设置页试译：真实打一发请求，确认端点/Key/模型/目标语言整条链路。
    (async () => {
      if (translationBenchmarkRunning) throw new Error('请等待单句翻译测速完成');
      const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
      const config = translateActiveConfig({ ...stored, ...(message.settings || {}) });
      if (!translateIsReady(config)) throw new Error(translateUnavailableReason(config) || '翻译未配置');
      // 原文一并回给设置页，避免试译文案在两处各写一份后漂移。
      const sources = BSCG_TRANSLATION_PERFORMANCE.samplesForSource(config.sourceLanguage).slice(0, 2);
      const result = await translateWithConfiguredModel(config, sources);
      if (!result.ok) throw new Error(result.error || '翻译请求失败');
      return { ok: true, texts: result.texts, sources, targetLanguage: config.targetLanguage, mode: config.mode, model: config.model };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
});

function handleRouteChange(details) {
  if (Number(details?.frameId) !== 0 || !Number.isInteger(details?.tabId)) return;
  const tabId = details.tabId;
  captionDisplayByTab.delete(tabId);
  const url = String(details.url || '');
  const documentId = String(details.documentId || '');
  if (documentId) documentByTab.set(tabId, documentId);
  observedMediaByTab.delete(tabId);
  void chrome.storage.session.remove(`observedMedia:${tabId}`).catch(() => {});
  cancelTranscriptionsForTab(tabId, url, documentId);
  void pruneResultsForTabUrl(tabId, url);
  void pruneJobsForTargetTabUrl(tabId, url);
  const session = liveCaptures.get(tabId);
  const replacedDocument = Boolean(session?.documentId && documentId && session.documentId !== documentId);
  if (session && (replacedDocument || !matchesLiveSource(session, url))) {
    void abortLiveCapture(session, '页面或视频已经切换，旧字幕任务已停止');
  }
  void chrome.tabs.sendMessage(tabId, { type: 'ROUTE_CHANGED', documentId, url }).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener(handleRouteChange, { url: [{ schemes: ['http', 'https', 'file'] }] });
chrome.webNavigation.onHistoryStateUpdated.addListener(handleRouteChange, { url: [{ schemes: ['http', 'https'] }] });

async function resolveRequestedTabId(message, sender) {
  const direct = Number(message?.tabId ?? sender?.tab?.id);
  if (Number.isInteger(direct) && direct >= 0) return direct;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (Number.isInteger(active?.id)) return active.id;
  throw new Error('无法识别当前视频标签页');
}

async function progress(tabId, text, level = 'info') {
  try { await chrome.tabs.sendMessage(tabId, { type: 'BSCG_PROGRESS', text, level }); } catch {}
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('metadata-timeout'), 6000);
  try {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`${new URL(url).hostname} HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
    : [m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function safeFileName(value) {
  return String(value || '在线视频').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
}

async function getVideoInfo(bvid, pageNumber, lockedCid = null) {
  const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (view.code !== 0 || !view.data) throw new Error(view.message || '读取视频信息失败');
  const pages = view.data.pages || [];
  const page = lockedCid
    ? pages.find((item) => String(item.cid) === String(lockedCid))
    : pages[Math.max(1, pageNumber) - 1] || pages[0];
  if (lockedCid && !page) throw new Error('当前播放器 CID 不属于这个视频，已拒绝继续');
  if (!page?.cid) throw new Error('没有找到当前分P');
  return { view: view.data, page };
}

async function getCurrentPlayerState(tabId, expectedBvid) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    injectImmediately: true,
    args: [expectedBvid],
    func: async (wantedBvid) => {
      const read = () => {
        const urlBvid = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || '';
        const videoData = window.__INITIAL_STATE__?.videoData;
        const initialBvid = videoData?.bvid || '';
        const pageNumber = Math.max(1, Number(new URL(location.href).searchParams.get('p')) || 1);
        const initialCid = initialBvid === urlBvid
          ? String(videoData?.pages?.[pageNumber - 1]?.cid || (pageNumber === 1 ? videoData?.cid : '') || '') : '';
        const playurls = Array.isArray(window.__BROWSER_SENSEVOICE_PLAYURLS__)
          ? window.__BROWSER_SENSEVOICE_PLAYURLS__ : [];
        // 最新一条属于本视频且带 cid 的 playurl 记录代表"播放器此刻真正在放的分P"。
        // URL 的 p 参数在站内切换分P时会滞后，因此分P身份必须以它为准。
        const latestPlayurl = [...playurls].reverse().find((entry) =>
          String(entry?.bvid || '') === urlBvid && String(entry?.cid || '')) || null;
        const urlPlayurl = latestPlayurl
          && (initialCid ? String(latestPlayurl.cid) === initialCid : Number(latestPlayurl.pageNumber) === pageNumber)
          ? latestPlayurl : null;
        return {
          href: location.href,
          urlBvid,
          initialBvid,
          initialCid,
          pageNumber,
          pageInfo: initialBvid === urlBvid ? videoData?.pages?.[pageNumber - 1] || null : null,
          title: initialBvid === urlBvid ? String(videoData?.title || '') : '',
          playurlCid: String(urlPlayurl?.cid || ''),
          playingCid: String(latestPlayurl?.cid || ''),
          playingPageNumber: Math.max(0, Number(latestPlayurl?.pageNumber) || 0),
          hasVideo: Boolean(document.querySelector('video')),
          hasSubtitleControl: Boolean(document.querySelector(
            '.bpx-player-ctrl-subtitle, .bilibili-player-video-btn-subtitle'
          ))
        };
      };
      let state = read();
      for (let attempt = 0; attempt < 8 && state.urlBvid === wantedBvid &&
        (!state.hasVideo || (!state.playurlCid && !state.initialCid)); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        state = read();
      }
      return state;
    }
  });
  const state = results?.[0]?.result;
  if (!state || state.urlBvid !== expectedBvid) throw new Error('当前标签页已切换到其他视频，已取消任务');
  if (!state.hasVideo) throw new Error('当前播放器尚未加载，请稍后再试');
  assertBilibiliPlayingPart(state);
  return state;
}

// 站内切换分P 后 URL 的 p 参数可能滞后，而页面标题/字幕接口都按 p 解析。
// 一旦两者指向不同分P，标题与字幕就必然错配，因此宁可拒绝也不能继续。
function assertBilibiliPlayingPart(state) {
  const playingCid = String(state?.playingCid || '');
  const resolvedCid = String(state?.initialCid || '');
  const playingPage = Number(state?.playingPageNumber) || 0;
  const resolvedPage = Number(state?.pageNumber) || 0;
  const cidMismatch = Boolean(playingCid && resolvedCid && playingCid !== resolvedCid);
  const pageMismatch = Boolean(playingPage && resolvedPage && playingPage !== resolvedPage);
  if (!cidMismatch && !pageMismatch) return;
  pushLog('warn', `[bilibili] 分P错配已拦截：播放中 cid=${playingCid || '-'} p=${playingPage || '-'}，` +
    `地址解析 cid=${resolvedCid || '-'} p=${resolvedPage || '-'}`);
  throw new Error('播放器正在播放的分P与当前地址不一致，标题会与字幕错配；请刷新视频页面或切换到目标分P后重新点击总结');
}

async function fetchPlayerMetadataInTab(tabId, urls) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    injectImmediately: true,
    args: [urls],
    func: async (requestUrls) => {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.setAttribute('aria-hidden', 'true');
      document.documentElement.appendChild(frame);
      try {
        const pageFetch = frame.contentWindow.fetch.bind(frame.contentWindow);
        const responses = [];
        for (const requestUrl of requestUrls) {
          const parsed = new URL(requestUrl);
          if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.bilibili.com' ||
              !['/x/player/wbi/v2', '/x/player/v2'].includes(parsed.pathname)) {
            throw new Error('拒绝非预期字幕接口');
          }
          try {
            const response = await pageFetch(parsed.href, { credentials: 'include', cache: 'no-store' });
            responses.push(response.ok ? await response.json() : null);
          } catch {
            responses.push(null);
          }
        }
        return responses;
      } finally {
        frame.remove();
      }
    }
  });
  const value = results?.[0]?.result;
  if (!Array.isArray(value) || value.length !== urls.length) throw new Error('B站页面没有返回完整字幕元数据');
  return value;
}

// 平台字幕自带时间戳，可以用来判断它是否"真的覆盖了整支视频"。
// 只有前几十秒、或全是"♪ 音乐 ♪"这类非语音标注的字幕，虽然格式合法，
// 却完全不能用来总结；过去这种字幕会被当成完整字幕直接发出去。
const NON_SPEECH_CAPTION = /^[\s♪♫♬🎵🎶\-–—_.·、,，。!！?？…()（）\[\]【】"'"'`]*$/u;

function captionSpeechLength(value) {
  return Array.from(String(value || '')
    .replace(/[♪♫♬🎵🎶]/gu, '')
    .replace(/[\s，,。.!！？?；;：:、—…"'“”‘’（）()【】\[\]]/g, '')).length;
}

function looksLikeNonSpeechCaption(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (NON_SPEECH_CAPTION.test(text)) return true;
  // 只剩"音乐/掌声/笑声"这类标注、没有其它实词时也不算语音内容。
  return captionSpeechLength(text.replace(/(音乐|掌声|笑声|欢呼|BGM|bgm|applause|laughter|music)/g, '')) === 0;
}

// 字幕可用性：结束时间必须覆盖到接近片尾，且不能几乎全是非语音标注。
function assessSubtitleCoverage(rows, expectedDuration) {
  const list = Array.isArray(rows) ? rows : [];
  const span = ccSubtitleSpan(list);
  const duration = Number(expectedDuration) || 0;
  const cues = list.length;
  let speech = 0;
  for (const row of list) if (!looksLikeNonSpeechCaption(row?.content)) speech += 1;
  const speechRatio = cues ? speech / cues : 0;
  const covered = duration > 0 ? span.to / duration : 1;
  // 判据一：必须覆盖到片尾（至少一半时长）。只有开头的字幕没有总结价值。
  // 判据二：不能完全没有语音内容（纯音乐/音效标注）。
  // 注意"覆盖全片但大部分是音乐标注"仍属可用，只是信息稀疏，不能因此判为不可用。
  const tooShort = duration > 0 && covered < 0.5;
  const noSpeech = cues > 0 && speechRatio <= 0.05;
  return { usable: cues > 0 && !tooShort && !noSpeech, cues, speech, speechRatio, covered, span, duration };
}

// B 站字幕自带时间戳，而分P 的总时长是权威的：字幕时间跨度一旦超出总时长，
// 就说明这份字幕不属于当前分P（缓存、张冠李戴或接口返回了别的稿件），
// 必须拒绝，否则标题与内容会静默错配。
function ccSubtitleSpan(rows) {
  let from = Infinity;
  let to = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const start = Number(row?.from);
    const end = Number(row?.to);
    if (Number.isFinite(start)) from = Math.min(from, start);
    if (Number.isFinite(end)) to = Math.max(to, end);
  }
  return { from: Number.isFinite(from) ? from : 0, to };
}

function ccSubtitleFitsPart(rows, expectedDuration, toleranceSeconds = 10) {
  const duration = Number(expectedDuration) || 0;
  if (duration <= 0) return true; // 没有权威时长时不擅自拒绝
  const span = ccSubtitleSpan(rows);
  return span.to > 0 && span.to <= duration + Math.max(toleranceSeconds, duration * 0.02);
}

async function extractRemoteRows(tabId, bvid, view, page) {
  const stamp = Date.now();
  const query = `bvid=${encodeURIComponent(bvid)}&aid=${encodeURIComponent(view.aid)}&cid=${encodeURIComponent(page.cid)}&_=${stamp}`;
  const urls = [
    `https://api.bilibili.com/x/player/wbi/v2?${query}`,
    `https://api.bilibili.com/x/player/v2?${query}`
  ];
  let wbiPlayer;
  let legacyPlayer;
  try {
    [wbiPlayer, legacyPlayer] = await fetchPlayerMetadataInTab(tabId, urls);
    if (!wbiPlayer && !legacyPlayer) throw new Error('页面内字幕接口均不可用');
  } catch {
    [wbiPlayer, legacyPlayer] = await Promise.all(urls.map(async (url) => {
      try { return await fetchJson(url); } catch { return null; }
    }));
  }
  const isCurrentPlayer = (player) => player?.code === 0 && String(player.data?.cid) === String(page.cid);
  const validWbi = isCurrentPlayer(wbiPlayer);
  const validLegacy = isCurrentPlayer(legacyPlayer);
  if (!validWbi && !validLegacy) return null;

  // 字幕条目本身也带 cid：与分P cid 不符时直接拒绝，避免用到别的稿件的字幕。
  const expectedDuration = Number(page.duration) || Number(view?.duration) || 0;
  const rejectedCids = [wbiPlayer, legacyPlayer]
    .filter((player) => player?.code === 0 && player.data?.cid !== undefined
      && String(player.data.cid) !== String(page.cid))
    .map((player) => String(player.data.cid));
  for (const subtitle of [wbiPlayer, legacyPlayer].flatMap((player) => player?.data?.subtitle?.subtitles || [])) {
    const entryCid = subtitle?.cid ?? subtitle?.subtitle_cid;
    if (entryCid !== undefined && String(entryCid) !== String(page.cid)) rejectedCids.push(String(entryCid));
  }
  if (rejectedCids.length) {
    pushLog('warn', `[bilibili] 已拒绝 cid 不符的字幕条目：${[...new Set(rejectedCids)].join(',')}（当前分P ${page.cid}）`);
  }

  const normalizeUrl = (value) => {
    if (!value) return null;
    const absolute = value.startsWith('//') ? `https:${value}` : value;
    try {
      const parsed = new URL(absolute);
      return { absolute, identity: `${parsed.hostname}${parsed.pathname}` };
    } catch { return null; }
  };
  const toTracks = (player) => (player.data?.subtitle?.subtitles || [])
    .filter((track) => {
      const entryCid = track?.cid ?? track?.subtitle_cid;
      return entryCid === undefined || String(entryCid) === String(page.cid);
    })
    .map((track) => ({ track, url: normalizeUrl(track.subtitle_url || track.subtitleUrl) }))
    .filter((item) => item.url && item.url.absolute.startsWith('https://aisubtitle.hdslb.com/'));
  const wbiTracks = validWbi ? toTracks(wbiPlayer) : [];
  const legacyTracks = validLegacy ? toTracks(legacyPlayer) : [];
  const seenTrackIdentities = new Set();
  const usable = [...wbiTracks, ...legacyTracks].filter((item) => {
    if (seenTrackIdentities.has(item.url.identity)) return false;
    seenTrackIdentities.add(item.url.identity);
    return true;
  });
  if (!usable.length) return null;

  // 逐条轨道校验：时间跨度必须在当前分P 之内，且必须真的覆盖整支视频。
  // "只有开头几十秒"或"几乎全是 ♪ 音乐 ♪"的字幕格式合法却毫无用处，
  // 过去会被当成完整字幕直接发送，导致总结拿到的是空内容。
  const preferred = usable.find(({ track }) => /zh|ai-zh/i.test(track.lan || '')) || usable[0];
  const ordered = [preferred, ...usable.filter((item) => item !== preferred)];
  const rejected = [];
  for (const { track, url } of ordered) {
    const subtitle = await fetchJson(url.absolute);
    const rows = Array.isArray(subtitle.body) ? subtitle.body : [];
    if (!rows.length) { rejected.push(`${track.lan || '?'}:空`); continue; }
    if (!ccSubtitleFitsPart(rows, expectedDuration)) {
      rejected.push(`${track.lan || '?'}:时间跨度超出分P`);
      pushLog('warn', `[bilibili] 已拒绝时间跨度不符的 CC 字幕（${track.lan || '?'}）：结束 ${ccSubtitleSpan(rows).to.toFixed(1)}s / 分P ${expectedDuration}s`);
      continue;
    }
    const coverage = assessSubtitleCoverage(rows, expectedDuration);
    if (!coverage.usable) {
      rejected.push(`${track.lan || '?'}:覆盖不足`);
      pushLog('warn', `[bilibili] 已拒绝覆盖不足的 CC 字幕（${track.lan || '?'}）：仅 ${coverage.cues} 条、` +
        `覆盖到 ${(coverage.covered * 100).toFixed(1)}%、语音条目占比 ${(coverage.speechRatio * 100).toFixed(0)}%；改用本地识别`);
      continue;
    }
    return { rows, label: track.lan_doc || track.lan || 'B站字幕' };
  }
  if (rejected.length) pushLog('warn', `[bilibili] 没有可用 CC 字幕：${rejected.join('；')}`);
  return null;
}

function md5Ascii(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const words = new Uint32Array((((bytes.length + 8) >>> 6) + 1) * 16);
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >>> 2] |= bytes[index] << ((index & 3) * 8);
  }
  words[bytes.length >>> 2] |= 0x80 << ((bytes.length & 3) * 8);
  words[words.length - 2] = bytes.length * 8;
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const constants = Array.from({ length: 64 }, (_, index) =>
    Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);
  const add = (left, right) => (left + right) | 0;
  const rotate = (number, amount) => (number << amount) | (number >>> (32 - amount));
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let offset = 0; offset < words.length; offset += 16) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f;
      let wordIndex;
      let shift;
      if (index < 16) {
        f = (b & c) | (~b & d);
        wordIndex = index;
        shift = shifts[index & 3];
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) & 15;
        shift = shifts[4 + (index & 3)];
      } else if (index < 48) {
        f = b ^ c ^ d;
        wordIndex = (3 * index + 5) & 15;
        shift = shifts[8 + (index & 3)];
      } else {
        f = c ^ (b | ~d);
        wordIndex = (7 * index) & 15;
        shift = shifts[12 + (index & 3)];
      }
      const next = d;
      d = c;
      c = b;
      b = add(b, rotate(add(add(a, f), add(constants[index], words[offset + wordIndex])), shift));
      a = next;
    }
    a0 = add(a0, a);
    b0 = add(b0, b);
    c0 = add(c0, c);
    d0 = add(d0, d);
  }
  return [a0, b0, c0, d0].map((word) => [0, 8, 16, 24]
    .map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}

const BILIBILI_WBI_MIXIN_ORDER = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];
let bilibiliWbiKeyCache = { key: '', expiresAt: 0 };

async function getBilibiliWbiMixinKey(forceRefresh = false) {
  if (!forceRefresh && bilibiliWbiKeyCache.key && bilibiliWbiKeyCache.expiresAt > Date.now()) {
    return bilibiliWbiKeyCache.key;
  }
  const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
  if (nav?.code !== 0) throw new Error(`${nav?.code}: ${nav?.message || 'WBI 密钥不可用'}`);
  const filename = (url) => String(url || '').split('/').pop()?.split('.')[0] || '';
  const raw = filename(nav.data?.wbi_img?.img_url) + filename(nav.data?.wbi_img?.sub_url);
  const key = BILIBILI_WBI_MIXIN_ORDER.map((index) => raw[index] || '').join('').slice(0, 32);
  if (key.length !== 32) throw new Error('WBI 混合密钥不完整');
  bilibiliWbiKeyCache = { key, expiresAt: Date.now() + 10 * 60 * 1000 };
  return key;
}

async function buildBilibiliWbiPlayurlUrl(bvid, cid, forceRefresh = false) {
  const mixinKey = await getBilibiliWbiMixinKey(forceRefresh);
  const parameters = {
    bvid: String(bvid || ''), cid: String(cid || ''), fnval: '4048', fnver: '0', fourk: '1',
    wts: String(Math.floor(Date.now() / 1000))
  };
  const query = Object.keys(parameters).sort().map((key) => {
    const clean = parameters[key].replace(/[!'()*]/g, '');
    return `${encodeURIComponent(key)}=${encodeURIComponent(clean)}`;
  }).join('&');
  return `https://api.bilibili.com/x/player/wbi/playurl?${query}&w_rid=${md5Ascii(query + mixinKey)}`;
}

function bilibiliMediaPath(value) {
  try { return new URL(String(value || '')).pathname; } catch { return ''; }
}

function collectBilibiliAudioCandidates(data, source = 'playurl') {
  const dash = data?.dash || {};
  const asList = (value) => Array.isArray(value) ? value : value ? [value] : [];
  const trackRank = (track, audioClass) => {
    const bitrate = Math.max(0, Number(track?.bandwidth) || 0);
    const description = `${track?.mimeType || track?.mime_type || ''};${track?.codecs || track?.codec || ''}`;
    const ordinaryAac = audioClass === 'standard' && /(?:mp4a|aac|audio\/mp4)/i.test(description);
    if (ordinaryAac && bitrate >= 56000 && bitrate <= 160000) return Math.abs(bitrate - 128000) / 1000;
    if (ordinaryAac) return 200 + Math.abs(bitrate - 96000) / 1000;
    if (audioClass === 'standard') return 500 + Math.abs(bitrate - 96000) / 1000;
    if (audioClass === 'dolby') return 1000 + bitrate / 1000000;
    return 2000 + bitrate / 1000000;
  };
  const tracks = [
    ...asList(dash.audio).map((track) => ({ track, audioClass: 'standard' })),
    ...asList(dash.dolby?.audio).map((track) => ({ track, audioClass: 'dolby' })),
    ...asList(dash.flac?.audio).map((track) => ({ track, audioClass: 'flac' }))
  ].sort((left, right) => trackRank(left.track, left.audioClass) - trackRank(right.track, right.audioClass));
  const candidates = [];
  const seen = new Set();
  const add = (url, extra = {}) => {
    const raw = String(url || '');
    const normalized = raw.startsWith('//') ? `https:${raw}` : raw;
    if (!/^https?:/i.test(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ url: normalized, frameId: 0, source, ...extra });
  };
  for (const { track, audioClass } of tracks) {
    const bitrate = Number(track?.bandwidth) || 0;
    const mimeType = String(track?.mimeType || track?.mime_type || '');
    const codecs = String(track?.codecs || track?.codec || '');
    const rank = trackRank(track, audioClass);
    const metadata = {
      kind: 'dash-audio', bitrate, mimeType, codecs, audioClass, rank,
      trackKey: `${audioClass}:${track?.id || ''}:${bitrate}:${codecs}`
    };
    add(track?.baseUrl || track?.base_url || track?.url, metadata);
    for (const backup of asList(track?.backupUrl || track?.backup_url)) add(backup, metadata);
  }
  // 少数版权、地区或旧编码视频不返回 DASH audio，但仍提供带音频的 durl。
  for (const item of asList(data?.durl)) {
    const metadata = { kind: 'durl', bitrate: 0, mimeType: 'video/mp4', progressive: true, rank: 4000 };
    add(item?.url, metadata);
    for (const backup of asList(item?.backup_url || item?.backupUrl)) add(backup, metadata);
  }
  return candidates;
}

async function getBilibiliApiAudioCandidates(bvid, cid) {
  const traditionalUrl = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&fnval=4048&fnver=0&fourk=1`;
  const compatibleUrl = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=64&fnval=0&fnver=0`;
  const traditionalPromise = fetchJson(traditionalUrl);
  const wbiPromise = (async () => {
    let response = await fetchJson(await buildBilibiliWbiPlayurlUrl(bvid, cid));
    if (response?.code === -403) {
      response = await fetchJson(await buildBilibiliWbiPlayurlUrl(bvid, cid, true));
    }
    return response;
  })();
  const [wbiResult, traditionalResult] = await Promise.allSettled([
    wbiPromise, traditionalPromise
  ]);
  const errors = [];
  const candidates = [];
  const collectResult = (result, source, dashOnly = false) => {
    if (result.status === 'rejected') {
      errors.push(`${source}: ${result.reason?.message || result.reason}`);
      return;
    }
    if (result.value?.code !== 0) {
      errors.push(`${source}: ${result.value?.code} ${result.value?.message || ''}`.trim());
      return;
    }
    const found = collectBilibiliAudioCandidates(result.value.data, source);
    candidates.push(...(dashOnly ? found.filter((candidate) => candidate.kind === 'dash-audio') : found));
  };
  collectResult(wbiResult, 'wbi-playurl', true);
  collectResult(traditionalResult, 'playurl', true);
  if (!candidates.length) {
    const [compatibleResult] = await Promise.allSettled([fetchJson(compatibleUrl)]);
    collectResult(compatibleResult, 'playurl-compatible');
  }
  if (!candidates.length && errors.length) throw new Error(errors.join('；'));
  return candidates;
}

async function getBilibiliPlayerAudioCandidates(tabId, expectedBvid = '', expectedCid = '') {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    injectImmediately: true,
    args: [String(expectedBvid || ''), String(expectedCid || '')],
    func: async (wantedBvid, wantedCid) => {
      const currentBvid = () => location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || '';
      const read = () => {
        if (wantedBvid && currentBvid() !== wantedBvid) return null;
        const captured = Array.isArray(window.__BROWSER_SENSEVOICE_PLAYURLS__)
          ? [...window.__BROWSER_SENSEVOICE_PLAYURLS__].reverse().find((entry) =>
            String(entry?.bvid || '') === wantedBvid && String(entry?.cid || '') === wantedCid && entry?.data)
          : null;
        if (captured) return { data: captured.data, source: 'player-captured' };
        const data = window.__playinfo__?.data || null;
        const videoData = window.__INITIAL_STATE__?.videoData || null;
        const initialIsCurrent = String(videoData?.bvid || '') === currentBvid();
        const pageNumber = Math.max(1, Number(new URL(location.href).searchParams.get('p')) || 1);
        // __playinfo__ without an explicit CID belongs to the initial page;
        // inferring its CID from a later SPA part would attach the wrong track.
        const initialPage = window.__BROWSER_SENSEVOICE_INITIAL_PAGE__;
        const sameInitialPart = initialPage
          ? new URL(initialPage).pathname === location.pathname &&
            (Number(new URL(initialPage).searchParams.get('p')) || 1) === pageNumber
          : pageNumber === 1;
        const playinfoCid = String(data?.cid || (initialIsCurrent && sameInitialPart
          ? videoData?.pages?.[pageNumber - 1]?.cid || videoData?.cid : '') || '');
        if (!data || !playinfoCid || (wantedCid && playinfoCid !== wantedCid)) return null;
        return { data, source: 'player-playinfo' };
      };
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const value = read();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return null;
    }
  });
  const result = results?.[0]?.result;
  return collectBilibiliAudioCandidates(result?.data, result?.source || 'player');
}

// 页面里选中的媒体元素必须确实是目标视频：用分P 时长比对，避免把页面里
// 别的媒体（预览播放器、广告、相关推荐）当成当前视频的音轨。
function pageMediaMatchesExpectedDuration(candidate, expectedDuration, toleranceRatio = 0.08, toleranceSeconds = 6) {
  const expected = Number(expectedDuration) || 0;
  const actual = Number(candidate?.duration) || 0;
  if (expected <= 0) return true; // 没有权威时长可比对时不擅自拒绝
  if (!(actual > 0)) return false;
  return Math.abs(actual - expected) <= Math.max(expected * toleranceRatio, toleranceSeconds);
}

async function resolveBilibiliAudioCandidates(tabId, bvid, cid, { expectedDuration = 0, refreshAudio = false } = {}) {
  let rejectedPageMedia = null;
  const [playerResult, genericResult, observedResult] = await Promise.all([
    getBilibiliPlayerAudioCandidates(tabId, bvid, cid).then((candidates) => ({ candidates })).catch((error) => ({ candidates: [], error })),
    getGenericMediaSource(tabId).catch(() => null),
    getObservedMediaRecords(tabId).catch(() => [])
  ]);
  // A usable player DASH response is already authorized for this part. Do not
  // hold it behind unrelated metadata endpoints; refresh only when necessary.
  const apiResult = refreshAudio || !playerResult.candidates.some((candidate) => candidate.kind === 'dash-audio')
    ? await getBilibiliApiAudioCandidates(bvid, cid).then((candidates) => ({ candidates })).catch((error) => ({ candidates: [], error }))
    : { candidates: [] };
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate?.url || seen.has(candidate.url) || /^blob:/i.test(candidate.url)) return;
    seen.add(candidate.url);
    candidates.push(candidate);
  };
  const discovered = refreshAudio && apiResult.candidates.length
    ? apiResult.candidates : [...playerResult.candidates, ...apiResult.candidates];
  const pathToCandidate = new Map();
  for (const candidate of discovered) {
    const path = bilibiliMediaPath(candidate.url);
    if (path && candidate.kind === 'dash-audio' && !pathToCandidate.has(path)) pathToCandidate.set(path, candidate);
  }
  // Performance/webRequest observations contain both video and audio .m4s.
  // Keep only URLs whose path matches a DASH audio track from the current
  // bvid+cid response, then let the probe validate its bytes.
  for (const entry of (refreshAudio ? [] : [...observedResult].reverse())) {
    if (entry?.kind !== 'fragment') continue;
    const matched = pathToCandidate.get(bilibiliMediaPath(entry.url));
    if (!matched) continue;
    add({ ...matched, url: entry.url, source: 'observed-audio', observed: true });
  }
  // 播放器与 playurl 候选本身就带着当前 bvid+cid 的签名，直接采用。
  for (const candidate of discovered) add(candidate);
  // 只保留能证明属于当前 bvid+cid 的来源：
  //   · observed-audio：路径必须与当前视频 playurl 返回的 DASH 音轨逐条对应；
  //   · page-media：页面媒体元素的时长必须与当前分P 时长吻合。
  // 其余 observed / media 记录只是"这个标签页最近请求过什么"，不携带视频身份，
  // 一旦被当成音轨就会把别的视频的字幕配上当前标题。
  if (genericResult?.mediaUrl) {
    if (pageMediaMatchesExpectedDuration(genericResult, expectedDuration)) {
      add({
        url: genericResult.mediaUrl,
        kind: genericResult.manifest ? 'hls' : 'file',
        frameId: Number(genericResult.frameId) || 0,
        source: 'page-media'
      });
    } else {
      rejectedPageMedia = genericResult;
      pushLog('warn', `[bilibili] 已丢弃页面媒体候选：时长 ${Number(genericResult.duration) || 0}s ` +
        `与当前分P ${Number(expectedDuration) || 0}s 不符（避免识别到别的视频）`);
    }
  }
  const sourceRank = (source) => ({
    'observed-audio': 0, 'player-captured': 1, 'player-playinfo': 2,
    'wbi-playurl': 3, playurl: 4, 'playurl-compatible': 5,
    'page-media': 20, observed: 21
  })[source] ?? 50;
  const kindRank = (kind) => kind === 'dash-audio' ? 0 : kind === 'hls' ? 1 : kind === 'durl' ? 2 : 3;
  candidates.sort((left, right) => kindRank(left.kind) - kindRank(right.kind) ||
    (Number(left.rank) || 0) - (Number(right.rank) || 0) ||
    sourceRank(left.source) - sourceRank(right.source));
  if (playerResult.error) pushLog('warn', `[bilibili] 页面播放信息未提供音轨：${playerResult.error?.message || playerResult.error}`);
  if (apiResult.error) pushLog('warn', `[bilibili] playurl 音轨接口失败：${apiResult.error?.message || apiResult.error}`);
  pushLog('info', `[bilibili] 音轨候选 ${candidates.length} 条（player=${playerResult.candidates.length}, api=${apiResult.candidates.length}）`);
  // 候选全被拒且原因是页面媒体与当前分P 时长不符：这几乎总是"标签页里的媒体不是
  // 当前视频"，必须明确报错，而不是退回到随便一个媒体去识别。
  if (!candidates.length && rejectedPageMedia) {
    throw new Error('页面正在播放的媒体与当前分P 不是同一支视频，已拒绝转写以免字幕与标题错配；' +
      '请刷新视频页面或重新进入该分P后再试');
  }
  return candidates;
}

async function getGenericMediaSource(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: 'MAIN', injectImmediately: true,
    func: bscgFindMedia, args: ['source']
  });
  return results.map(item => item.result ? { ...item.result, frameId: Number(item.frameId) || 0 } : null)
    // Keep the frame that owns the active media even when its currentSrc is
    // blob:/MediaSource. webRequest may know the real HLS/DASH/audio URL.
    .filter(item => item && (item.mediaUrl || item.mediaSrc || Number(item.score) > 0))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0] || null;
}

function genericReplayCandidates(generic, observed = []) {
  if (!generic) return [];
  const candidates = [];
  const frameId = Math.max(0, Number(generic.frameId) || 0);
  const add = entry => {
    if (!/^https?:/i.test(entry.url || '') || candidates.some(candidate => candidate.url === entry.url)) return;
    candidates.push({ url: entry.url, kind: entry.kind === 'dash' ? 'dash-manifest' : entry.kind === 'hls' ? 'hls' : 'file',
      frameId, mimeType: entry.mimeType || '', bitrate: Number(entry.bitrate) || 0 });
  };
  if (generic.mediaUrl) add({ url: generic.mediaUrl, kind: generic.kind || (generic.manifest ? 'hls' : 'media') });
  for (const entry of generic.candidates || []) add(entry);
  const blobBacked = /^blob:/i.test(generic.mediaSrc || '');
  const noReadableSource = !generic.mediaUrl;
  for (const entry of observed) {
    if (Number(entry.frameId) !== frameId) continue;
    const mime = String(entry.mimeType || '');
    // Network sniffing is intentionally bounded to the frame that owns the
    // active media element. Extensionless HLS/DASH and audio are always useful.
    // For blob/MSE players (or when currentSrc yielded no readable URL), also
    // admit muxed MP4/WebM as a last-resort candidate; the engine range-probes
    // the container before accepting it, so an unrelated preload normally dies
    // here instead of being treated as the current video's audio.
    const likelyMuxed = entry.kind === 'media' &&
      /^(?:video\/(?:mp4|webm)|application\/mp4)$/i.test(mime);
    const safeObserved = ['hls', 'dash'].includes(entry.kind) || /^audio\//i.test(mime) ||
      (entry.kind === 'media' && blobBacked) || (noReadableSource && likelyMuxed);
    if (safeObserved) add(entry);
  }
  return candidates;
}

function completeYouTubeAudioUrl(value) {
  const raw = String(value || '');
  try {
    const parsed = new URL(raw);
    if (!/(^|\.)googlevideo\.com$/i.test(parsed.hostname)) return raw;
    const signed = new Set([parsed.searchParams.get('sparams'), parsed.searchParams.get('lsparams')]
      .filter(Boolean).join(',').split(','));
    const transient = new Set(['range', 'rn', 'rbuf', 'alr'].filter((key) => !signed.has(key)));
    // Filter the raw query so percent-encoding of signed values stays intact.
    const question = raw.indexOf('?');
    if (question < 0) return raw;
    const hash = raw.indexOf('#', question);
    const tail = hash < 0 ? '' : raw.slice(hash);
    const query = raw.slice(question + 1, hash < 0 ? undefined : hash).split('&')
      .filter((part) => !transient.has(decodeURIComponent(part.split('=')[0]))).join('&');
    return `${raw.slice(0, question)}${query ? `?${query}` : ''}${tail}`;
  } catch { return raw; }
}

async function getYouTubePlayerState(tabId, expectedVideoId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    injectImmediately: true,
    args: [expectedVideoId],
    func: async (wantedVideoId) => {
      const currentId = () => {
        const url = new URL(location.href);
        return url.searchParams.get('v') || url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
      };
      const labelText = (name) => name?.simpleText || (name?.runs || []).map((run) => run.text || '').join('') || '';
      const read = () => {
        const player = document.querySelector('#movie_player');
        let response = null;
        try { response = player?.getPlayerResponse?.() || null; } catch {}
        response ||= window.ytInitialPlayerResponse || null;
        if (!response && window.ytplayer?.config?.args?.player_response) {
          try { response = JSON.parse(window.ytplayer.config.args.player_response); } catch {}
        }
        const details = response?.videoDetails || {};
        const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const formats = response?.streamingData?.adaptiveFormats || [];
        return {
          href: location.href,
          urlVideoId: currentId(),
          responseVideoId: details.videoId || '',
          title: details.title || document.title.replace(/\s*-\s*YouTube\s*$/, ''),
          lengthSeconds: Number(details.lengthSeconds) || Number(document.querySelector('video')?.duration) || 0,
          isLive: Boolean(details.isLiveContent),
          hasVideo: Boolean(document.querySelector('video')),
          captions: tracks.map((track) => ({
            baseUrl: track.baseUrl || '',
            languageCode: track.languageCode || '',
            kind: track.kind || '',
            name: labelText(track.name)
          })).filter((track) => track.baseUrl),
          audioFormats: formats.filter((format) => /^audio\//i.test(format.mimeType || '') && format.url).map((format) => ({
            url: format.url,
            bitrate: Number(format.bitrate) || 0,
            mimeType: format.mimeType || ''
          })).sort((a, b) => b.bitrate - a.bitrate),
          muxedFormats: (response?.streamingData?.formats || [])
            .filter(format => format.url && /^video\/mp4/i.test(format.mimeType || '') &&
              /mp4a/i.test(format.mimeType || ''))
            .map(format => ({ url: format.url, mimeType: format.mimeType, bitrate: Number(format.bitrate) || 0,
              height: Number(format.height) || 0, itag: Number(format.itag) || 0 }))
            .sort((a, b) => a.height - b.height || a.bitrate - b.bitrate)
        };
      };
      let state = read();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (state.urlVideoId === wantedVideoId && state.responseVideoId === wantedVideoId && state.hasVideo) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
        state = read();
      }
      return state;
    }
  });
  const state = results?.[0]?.result;
  if (!state || state.urlVideoId !== expectedVideoId) throw new Error('当前标签页已经切换到其他 YouTube 视频，已取消任务');
  if (!state.hasVideo) throw new Error('YouTube 播放器尚未加载，请稍后再试');
  if (state.responseVideoId !== expectedVideoId) throw new Error('YouTube 页面地址与播放器尚未同步，请稍后再试');
  const audioItags = new Set(['139', '140', '141', '249', '250', '251', '256', '258', '325', '328', '338', '599', '600']);
  const observedAudio = (await getObservedMediaRecords(tabId)).map((entry) => {
    try {
      const parsed = new URL(entry.url);
      const mimeType = entry.mimeType || decodeURIComponent(parsed.searchParams.get('mime') || '');
      const itag = parsed.searchParams.get('itag') || '';
      if (!/^audio\//i.test(mimeType) && !audioItags.has(itag)) return null;
      return { url: entry.url, bitrate: entry.bitrate || Number(parsed.searchParams.get('bitrate')) || 0, mimeType, source: 'webRequest' };
    } catch { return null; }
  }).filter(Boolean);
  const seenAudio = new Set();
  state.audioFormats = [...(state.audioFormats || []), ...observedAudio]
    .map((format) => ({ ...format, url: completeYouTubeAudioUrl(format.url) }))
    .filter((format) => {
      if (!format?.url) return false;
      let identity = format.url;
      try {
        const parsed = new URL(format.url);
        if (/(^|\.)googlevideo\.com$/i.test(parsed.hostname)) {
          for (const key of ['range', 'rn', 'rbuf', 'alr']) parsed.searchParams.delete(key);
          identity = parsed.href;
        }
      } catch {}
      if (seenAudio.has(identity)) return false;
      seenAudio.add(identity);
      return true;
    })
    .sort((a, b) => Number(/audio\/mp4/i.test(b.mimeType || '')) - Number(/audio\/mp4/i.test(a.mimeType || '')) || Math.abs(Number(a.bitrate) - 128000) - Math.abs(Number(b.bitrate) - 128000));
  return state;
}

function youTubeReplayCandidates(state) {
  const audio = (state.audioFormats || []).filter(format => format.url).map(format => ({
    ...format, url: completeYouTubeAudioUrl(format.url), kind: 'file', frameId: 0,
    videoId: format.source === 'webRequest' ? '' : state.responseVideoId,
    identityConfidence: format.source === 'webRequest' ? 'observed-in-tab' : 'player-response',
    source: format.source || 'youtube-audio'
  }));
  const muxed = (state.muxedFormats || []).filter(format => format.url &&
    /^video\/mp4/i.test(format.mimeType || '') && /mp4a/i.test(format.mimeType || ''))
    .sort((a, b) => Number(a.height) - Number(b.height) || Number(a.bitrate) - Number(b.bitrate))
    .map(format => ({ ...format, url: completeYouTubeAudioUrl(format.url), kind: 'muxed-video',
      hasAudio: true, frameId: 0, videoId: state.responseVideoId, source: 'youtube-muxed' }));
  return audio.concat(muxed);
}

function selectYouTubeCaption(tracks, language) {
  const wanted = language && language !== 'auto' ? language.toLowerCase() : '';
  const languageMatches = (track, code) => {
    const actual = String(track.languageCode || '').toLowerCase();
    return actual === code || actual.startsWith(`${code}-`);
  };
  return (wanted && tracks.find((track) => languageMatches(track, wanted))) ||
    tracks.find((track) => languageMatches(track, 'zh')) ||
    tracks.find((track) => !track.kind) || tracks[0] || null;
}

async function extractYouTubeRows(playerState, language) {
  const selected = selectYouTubeCaption(playerState.captions || [], language);
  if (!selected) return null;
  const url = new URL(selected.baseUrl);
  if (url.protocol !== 'https:' || !/(^|\.)youtube\.com$/i.test(url.hostname)) {
    throw new Error('YouTube 返回了非预期字幕地址，已拒绝访问');
  }
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url.href, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(`YouTube 字幕 HTTP ${response.status}`);
  const subtitle = await response.json();
  const rows = (subtitle.events || []).map((event) => ({
    from: Number(event.tStartMs) / 1000,
    to: (Number(event.tStartMs) + Number(event.dDurationMs || 0)) / 1000,
    content: (event.segs || []).map((segment) => segment.utf8 || '').join('').replace(/\s+/g, ' ').trim()
  })).filter((row) => row.content);
  if (!rows.length) return null;
  // 与 B 站同理：字幕时间戳跨度超过视频总时长即说明不属于本视频。
  const stateDuration = Number(playerState?.lengthSeconds) || 0;
  if (!ccSubtitleFitsPart(rows, stateDuration)) {
    pushLog('warn', `[youtube] 已拒绝时间跨度不符的字幕：字幕结束 ${ccSubtitleSpan(rows).to.toFixed(1)}s ` +
      `超过视频总时长 ${stateDuration}s`);
    return null;
  }
  // 同样要求覆盖整支视频：只有开头的字幕没有总结价值。
  const coverage = assessSubtitleCoverage(rows, stateDuration);
  if (!coverage.usable) {
    pushLog('warn', `[youtube] 已拒绝覆盖不足的字幕：仅 ${coverage.cues} 条、覆盖到 ` +
      `${(coverage.covered * 100).toFixed(1)}%、语音条目占比 ${(coverage.speechRatio * 100).toFixed(0)}%；改用本地识别`);
    return null;
  }
  const automatic = selected.kind === 'asr' ? '自动字幕' : '字幕';
  return { rows, label: `YouTube ${automatic}${selected.name ? `（${selected.name}）` : ''}` };
}

function browserBackendMode(settings) {
  if (settings?.asrProfile !== 'sensevoice_browser') return 'webgpu';
  return settings?.asrBackend === 'wasm' ? 'wasm' : 'webgpu';
}

function browserPhraseWindow(profile, rawSeconds) {
  const ceiling = profile === 'sensevoice_browser'
    ? SENSEVOICE_LIVE_WINDOW_SECONDS
    : QWEN_LIVE_WINDOW_SECONDS;
  return Math.max(4, Math.min(ceiling, Number(rawSeconds) || ceiling));
}

function localEngineLabel(settings, realtime = false) {
  const model = settings?.asrProfile === 'sensevoice_browser' ? 'SenseVoice' : 'Qwen3-ASR 0.6B';
  const backend = settings?.asrProfile !== 'sensevoice_browser'
    ? 'WebGPU · FP16'
    : settings?.asrBackend === 'wasm'
    ? 'WASM CPU · INT8'
    : '自动 WebGPU FP16→WASM INT8';
  return `${realtime ? '浏览器实时' : '浏览器'} ${model}（${backend}）`;
}

function finishBrowserEngineSession(session, error = null) {
  if (!session || session.settled) return;
  session.settled = true;
  void releaseMediaHeaderRules(session.sessionId).catch(error => pushLog('warn', `[media/hls] 临时请求头清理失败：${error?.message || error}`));
  clearTimeout(session.timeout);
  clearTimeout(session.abortTimer);
  if (Number.isInteger(session.scanFrameId)) {
    void chrome.tabs.sendMessage(session.tabId, { type: 'BSCG_SCAN_STOP', sessionId: session.sessionId }, { frameId: session.scanFrameId }).catch(() => {});
    if (session.externalCapture) {
      void chrome.tabs.sendMessage(session.tabId, { type: 'BSCG_INPAGE_CAPTURE_STOP', sessionId: session.sessionId }, { frameId: session.scanFrameId }).catch(() => {});
    }
  }
  browserEngineSessions.delete(session.sessionId);
  schedulePendingBrowserSettingsRestart();
  if (session.control?.engineSessionId === session.sessionId) session.control.engineSessionId = '';
  setTimeout(() => { void maybeCloseOffscreenDocument(); }, 300);
  if (session.control?.abort === session.abort) session.control.abort = null;
  if (error) session.reject(error instanceof Error ? error : new Error(String(error)));
  else session.resolve({
    ok: true,
    segments: session.segments.slice(),
    metrics: session.metrics || {},
    reason: session.stopReason || session.metrics?.completionReason || ''
  });
}

function browserTaskCancelledError(reason = '浏览器转写任务已取消') {
  const error = new Error(reason);
  error.code = 'TASK_CANCELLED';
  return error;
}

function throwIfBrowserRequestCancelled(control) {
  if (control?.cancelReason) throw browserTaskCancelledError(control.cancelReason);
}

function compactQueueTitle(value) {
  const text = String(value || '未命名页面').replace(/\s+/g, ' ').trim();
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}

function browserQueueBlocker(request) {
  const requestTabId = Number(request?.tabId);
  const running = activeBrowserRequest?.request;
  if (running) {
    if (Number(running.tabId) === requestTabId) {
      return activeBrowserRequest.cancelled
        ? '本页上一项识别正在退出'
        : '本页已有一项识别正在运行';
    }
    return `另一标签页《${compactQueueTitle(running.title)}》正在识别`;
  }
  const engineSession = [...browserEngineSessions.values()].find((session) => !session.settled);
  if (engineSession) {
    return Number(engineSession.tabId) === requestTabId
      ? '本页上一项识别正在收尾'
      : `另一标签页《${compactQueueTitle(engineSession.title)}》正在收尾`;
  }
  if (activeBenchmarkId) return '诊断页正在测速';
  const queued = browserRequestQueue.find((entry) => !entry.cancelled && !entry.settled);
  if (!queued) return '';
  return Number(queued.request?.tabId) === requestTabId
    ? '本页已有一项待启动识别'
    : `另一标签页《${compactQueueTitle(queued.request?.title)}》正在等待识别`;
}

function browserEngineError(message, code = '') {
  const error = new Error(message || '浏览器 ASR 失败');
  if (code) error.code = code;
  return error;
}

function isDirectAudioFailure(error) {
  return error?.code === 'DIRECT_AUDIO_FAILED';
}

function bindBrowserSessionControl(control, abort) {
  if (!control) return;
  control.abort = abort;
}

async function settleCancelledBrowserStart(control, request, sessionId, session) {
  if (!control?.cancelReason) return false;
  if (!session || session.settled) return true;
  session.abortError ||= browserTaskCancelledError(control.cancelReason);
  const response = await sendToOffscreen({ type: 'BILI_ASR_STOP', tabId: Number(request.tabId), sessionId, reason: 'cancelled' })
    .catch((error) => ({ ok: false, error: error?.message || String(error) }));
  if (!response?.ok || response.idle) finishBrowserEngineSession(session, session.abortError);
  return true;
}

function abortBrowserEngineSession(session, reason) {
  if (!session || session.settled) return;
  session.abortError ||= browserTaskCancelledError(reason);
  if (!session.abortTimer) {
    session.abortTimer = setTimeout(() => {
      if (session.settled) return;
      pushLog('warn', `[browser] 取消收尾超时，重建离屏引擎 session=${session.sessionId}`);
      void chrome.offscreen.closeDocument()
        .catch(() => null)
        .finally(() => finishBrowserEngineSession(session, session.abortError));
    }, 12000);
  }
  if (session.aborting) return;
  session.aborting = true;
  void sendToOffscreen({ type: 'BILI_ASR_STOP', tabId: session.tabId, sessionId: session.sessionId, reason: 'cancelled' })
    .catch(() => finishBrowserEngineSession(session, session.abortError));
}

function handleBrowserEngineEvent(message) {
  const session = browserEngineSessions.get(String(message?.sessionId || ''));
  if (!session || session.settled) return;
  // A cancelled session still owns its stop acknowledgement even after navigation.
  // Reject its captions below, but release ownership before checking page identity.
  if (session.aborting && ['stopped', 'error'].includes(message.event)) {
    pushLog('info', `[browser/stop] 收到取消完成确认 event=${message.event} session=${session.sessionId}`);
    finishBrowserEngineSession(session, session.abortError || browserTaskCancelledError('识别已取消'));
    return;
  }
  if (message.sourceMode === 'direct' && Number(message.directGeneration || 0) < Number(session.directGeneration || 0)) {
    // A terminal event means this engine session has ended even if seek raced
    // its last message. Settle ownership without publishing obsolete rows.
    if (message.event === 'stopped') finishBrowserEngineSession(session, session.abortError || null);
    else if (message.event === 'error') finishBrowserEngineSession(session,
      browserEngineError(message.error || '浏览器 ASR 已结束', message.errorCode || 'DIRECT_AUDIO_FAILED'));
    return;
  }
  if ((message.mediaKey && session.mediaKey && message.mediaKey !== session.mediaKey) ||
      (session.documentId && currentDocumentId(session.tabId) && session.documentId !== currentDocumentId(session.tabId))) {
    session.abort('媒体或页面文档已经变化，已丢弃旧 ASR 结果');
    return;
  }
  const nextRows = Array.isArray(message.segments) ? message.segments.map((row) => ({
    from: Math.max(0, Number(row.from) || 0),
    to: Math.max(Number(row.from) || 0, Number(row.to) || Number(row.from) || 0),
    content: cleanDisplayCaption(row.content)
  })).filter((row) => row.content) : (session.segments || []);
  const nextPreview = message.previewSegment?.content ? {
    id: `${session.sessionId}:${String(message.previewSegment.id || 'current')}`,
    revision: Math.max(0, Number(message.previewSegment.revision) || 0),
    from: Math.max(0, Number(message.previewSegment.from) || 0),
    to: Math.max(Number(message.previewSegment.from) || 0, Number(message.previewSegment.to) || Number(message.previewSegment.from) || 0),
    content: formatLivePreviewCaption(message.previewSegment.content, message.previewSegment.stableContent),
    stableContent: cleanDisplayCaption(message.previewSegment.stableContent),
    provisional: true
  } : null;
  const previousPreview = session.previewSegment || null;
  for (const row of message.partialOnly ? [] : nextRows) {
    const key = `${row.from.toFixed(3)}\n${row.to.toFixed(3)}\n${row.content}`;
    if (session.seenSegments.has(key)) continue;
    session.seenSegments.add(key);
    session.onProgress?.({ type: 'segment', segment: row, metrics: message.metrics || {} });
  }
  session.segments = nextRows;
  if (message.finalSegment?.content && message.finalSegment.id !== session.lastFinalPhraseId) {
    session.lastFinalPhraseId = message.finalSegment.id;
    session.onProgress?.({ type: 'final', segment: {
      ...message.finalSegment,
      id: `${session.sessionId}:${message.finalSegment.id}`,
      content: cleanDisplayCaption(message.finalSegment.content)
    } });
  }
  if (nextPreview?.content) {
    const previewChanged = !previousPreview || previousPreview.id !== nextPreview.id ||
      previousPreview.revision !== nextPreview.revision || previousPreview.content !== nextPreview.content ||
      Math.abs(previousPreview.to - nextPreview.to) > 0.02;
    session.previewSegment = nextPreview;
    if (previewChanged) session.onProgress?.({ type: 'preview', segment: nextPreview });
  } else if (previousPreview) {
    session.previewSegment = null;
    session.onProgress?.({
      type: 'preview-clear',
      previewId: previousPreview.id,
      revision: previousPreview.revision
    });
  }
  session.metrics = message.metrics || session.metrics;
  if (message.sourceMode === 'direct') session.onProgress?.({ type: 'metrics', metrics: session.metrics });
  if ((message.event === 'pause-for-model' || message.event === 'resume-after-model') && message.sourceMode !== 'direct') {
    const scanMayRun = !['stopping', 'stopped', 'error'].includes(message.status);
    if (session.scanMode && scanMayRun && message.event === 'resume-after-model' && !session.scanStarted) {
      session.modelReady = true;
      if (!session.externalCapture || session.captureReady) void startAutomatedScan(session);
    } else if (session.scanMode && scanMayRun && session.scanStarted && Number.isInteger(session.scanFrameId)) {
      const type = message.event === 'pause-for-model' ? 'BSCG_SCAN_PAUSE' : 'BSCG_SCAN_RESUME';
      void chrome.tabs.sendMessage(session.tabId, {
        type,
        sessionId: session.sessionId
      }, { frameId: session.scanFrameId }).catch(() => null);
    }
  }
  // Segment and preview messages already have dedicated UI channels. Forwarding
  // their internal running text on every inference used to keep the feedback
  // bubble permanently visible and overwrite the useful queue state.
  if (message.statusText && message.event !== 'running' && message.statusText !== session.lastProgressText) {
    session.lastProgressText = message.statusText;
    session.onProgress?.({ type: 'progress', text: message.statusText, metrics: message.metrics || {} });
  }
  if (message.event === 'audio-ready') {
    // 【提前量观测点】整轨前瞻每完成一个滚动窗口上报一次，这是回答"字幕到底能提前
    // 多少秒"的唯一直接证据。三级进度分别对应三种瓶颈：
    //   fetchedTo    网络已拿到手的媒体秒数 —— 卡住说明下载慢（限速 / 分片太大）
    //   decodedTo    已解码成 PCM 的秒数   —— 卡住说明解封装/WebCodecs 慢
    //   recognizedTo 已出字幕的秒数        —— 卡住说明 ASR 推理慢
    // 识别领先 = recognizedTo − 播放头。它持续下降就是"跟不上播放"的确定信号，
    // 此时用户会看到字幕退回原文（[translate] 的降级日志会同时出现）。
    // 窗口本身约每 30 秒媒体时间一次，这里再按 20 秒墙钟节流，不丢关键节点又不刷屏。
    const nowAt = Date.now();
    if (!session.lastLookaheadLogAt || nowAt - session.lastLookaheadLogAt >= 20000) {
      session.lastLookaheadLogAt = nowAt;
      const metrics = message.metrics || {};
      const head = Number(session.currentVideoTime) || 0;
      const recognized = Number(metrics.recognizedTo || 0);
      pushLog('info', `[browser/lookahead] ${message.statusText || '滚动窗口已解码'} ` +
        `取到=${Number(metrics.fetchedTo || 0).toFixed(1)}s 解码到=${Number(metrics.decodedTo || 0).toFixed(1)}s ` +
        `识别到=${recognized.toFixed(1)}s 播放头=${head.toFixed(1)}s 识别领先=${(recognized - head).toFixed(1)}s`);
    }
  }
  if (message.event === 'direct-ready' && message.sourceMode === 'direct') {
    const metrics = message.metrics || {};
    pushLog('info', `[browser] 独立音轨就绪 source=${metrics.audioCandidate || 'unknown'} ` +
      `decoded=${Number(metrics.directDecodedSeconds || metrics.capturedAudioSeconds || 0).toFixed(1)}s ` +
      `expected=${Number(metrics.directExpectedSeconds || 0).toFixed(1)}s ` +
      `rms=${Number(metrics.directAudioRms || 0).toExponential(2)} downmix=${metrics.downmixMode || 'unknown'} ` +
      `model=${message.asrProfile || session.asrProfile} backend=${metrics.backend || message.backendMode || 'unknown'}`);
  }
  if (['inference-start', 'inference-progress', 'inference-complete', 'inference-timeout'].includes(message.event)) {
    const metrics = message.metrics || {};
    const diagnosticKey = `${message.phraseId}:${Boolean(message.preview)}:${message.event}:${message.inferencePhase}`;
    if (session.lastInferenceDiagnostic !== diagnosticKey) {
      session.lastInferenceDiagnostic = diagnosticKey;
      pushLog(message.event === 'inference-timeout' ? 'warn' : 'info',
        `[browser/inference] ${message.event} id=${message.phraseId} phase=${message.inferencePhase} ` +
        `model=${message.asrProfile || session.asrProfile} backend=${metrics.backend || message.backendMode || 'unknown'} ` +
        `audio=${Number(message.audioSeconds || 0).toFixed(1)}s elapsed=${(Number(message.inferenceElapsedMs || 0) / 1000).toFixed(1)}s`);
    }
  }
  if (message.event === 'phantom-dropped') {
    // 【静音幻觉观测点】SenseVoice 在静音/噪声/极短人声上会吐出固定英文短语
    // （The. / Yeah. / Oh. / Magic again. …）。识别侧已整段丢弃，这里留痕，
    // 便于回答"没说话为什么也出字幕"以及统计命中词与 voicedMs 分布。
    pushLog('info', `[browser/phantom] 丢弃静音幻觉 token=${message.phraseToken ?? ''} ` +
      `文案=${String(message.phantomText || '').replace(/\s+/g, ' ').slice(0, 24)} ` +
      `voiced=${Number(message.voicedMs || 0)}ms 音频=${(Number(message.audioSeconds) || 0).toFixed(1)}s ` +
      `断句=${message.reason || 'manual'} 撤下草稿=${message.previewRetracted ? '是' : '否'}`);
  }
  if (message.event === 'fallback') {
    const model = session.asrProfile === 'sensevoice_browser' ? 'SenseVoice' : 'Qwen3-ASR 0.6B';
    pushLog('warn', `[browser] ${model} WebGPU FP16 → WASM CPU INT8：${message.fallbackError || '自动降级'}`);
  } else if (message.event === 'error') {
    const failure = browserEngineError(
      message.error || message.statusText || '浏览器 ASR 失败',
      message.errorCode || ''
    );
    failure.metrics = message.metrics || session.metrics || {};
    finishBrowserEngineSession(session, failure);
  } else if (message.event === 'stopped') {
    session.stopReason = String(message.reason || message.metrics?.completionReason || '');
    finishBrowserEngineSession(session, session.abortError || null);
  }
}

async function browserDirectTranscribeRequest(request, onProgress, control = null) {
  throwIfBrowserRequestCancelled(control);
  if (request.directSource?.playerMediaSrc) {
    const current = await getGenericMediaSource(Number(request.tabId));
    if (!current || current.mediaSrc !== request.directSource.playerMediaSrc ||
        Number(current.frameId) !== Number(request.directSource.frameId)) {
      throw browserTaskCancelledError('主播放器或来源 frame 已变化，已取消旧视频取音');
    }
  }
  throwIfBrowserRequestCancelled(control);
  const sessionId = crypto.randomUUID();
  if (control) control.engineSessionId = sessionId;
  const completion = new Promise((resolve, reject) => {
    const session = {
      sessionId,
      tabId: Number(request.tabId),
      onProgress,
      control,
      resolve,
      reject,
      segments: [],
      seenSegments: new Set(),
      previewSegment: null,
      metrics: {},
      settled: false,
      directReferer: request.directSource?.platform === 'web' ? String(request.directSource.referer || request.sourceUrl || '') : '',
      mediaKey: String(request.mediaKey || ''),
      documentId: currentDocumentId(request.tabId, request.documentId),
      jobId: String(request.jobId || sessionId),
      asrProfile: request.asrProfile || DEFAULTS.asrProfile,
    asrLanguage: request.asrLanguage || 'auto',
      title: request.title || '在线视频',
      timeout: null,
      abortTimer: null,
      abortError: null,
      aborting: false,
      abort: null
    };
    session.abort = (reason = '浏览器转写任务已取消') => {
      abortBrowserEngineSession(session, reason);
    };
    session.timeout = setTimeout(() => session.abort('浏览器转写超过 4 小时，已停止'), ASR_REQUEST_TIMEOUT_MS);
    bindBrowserSessionControl(control, session.abort);
    browserEngineSessions.set(sessionId, session);
  });
  if (control?.cancelReason) {
    finishBrowserEngineSession(browserEngineSessions.get(sessionId), browserTaskCancelledError(control.cancelReason));
    return completion;
  }
  const initialStartTime = Math.max(0, Number(control?.pendingSeekTime ?? request.startTime) || 0);
  const response = await sendToOffscreen({
    type: 'BILI_ASR_START_DIRECT',
    sessionId,
    tabId: Number(request.tabId),
    asrProfile: request.asrProfile || DEFAULTS.asrProfile,
    asrLanguage: request.asrLanguage || 'auto',
    backendMode: request.asrProfile === 'sensevoice_browser' && request.backendMode === 'wasm' ? 'wasm' : 'webgpu',
    cpuThreads: Number(request.cpuThreads) || 0,
    voiceEnhance: Boolean(request.voiceEnhance),
    voiceEnhancePreset: request.voiceEnhancePreset || 'balanced',
    sourceMode: 'direct',
    directSource: request.directSource,
    startTime: initialStartTime,
    rollingLookahead: Boolean(request.rollingLookahead),
    initialClock: request.initialClock,
    title: request.title || '在线视频',
    sourceUrl: request.sourceUrl || '',
    mediaKey: request.mediaKey || '',
    documentId: currentDocumentId(request.tabId, request.documentId),
    jobId: request.jobId || sessionId
  }).catch((error) => ({ ok: false, error: error?.message || String(error), errorCode: error?.code || '' }));
  if (await settleCancelledBrowserStart(control, request, sessionId, browserEngineSessions.get(sessionId))) return completion;
  if (!response?.ok) {
    const session = browserEngineSessions.get(sessionId);
    finishBrowserEngineSession(session, browserEngineError(
      response?.error || '浏览器音轨处理器启动失败', response?.errorCode || ''
    ));
  } else {
    const latestStartTime = Math.max(0, Number(control?.pendingSeekTime ?? initialStartTime) || 0);
    if (Math.abs(latestStartTime - initialStartTime) > 0.1) {
      void sendToOffscreen({
        type: 'BILI_ASR_DIRECT_SEEK', tabId: Number(request.tabId),
        sessionId, currentTime: latestStartTime
      }).catch(() => null);
    }
  }
  return completion;
}

function isTabCaptureConsumptionFailure(error) {
  return /标签页音频流消费失败|Error starting tab capture|AbortError/i.test(String(error || ''));
}

async function startInPageAudioCapture(session, silentOutput, missingVideoError) {
  const target = await findVideoFrame(session.tabId).catch(() => null);
  if (!target) {
    session.abort(missingVideoError || '页面上找不到可捕获的视频元素');
    return false;
  }
  session.scanFrameId = target.frameId;
  const capture = await chrome.tabs.sendMessage(session.tabId, {
    type: 'BSCG_INPAGE_CAPTURE_START',
    sessionId: session.sessionId,
    silentOutput,
    scanMode: Boolean(session.scanMode),
    requireCopyStream: Boolean(session.requireCopyStream),
    isLive: Boolean(session.isLive)
  }, { frameId: target.frameId }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
  if (!capture?.ok) {
    session.abort(capture?.error || '页面内取音启动失败');
    return false;
  }
  session.captureReady = true;
  if (session.scanMode && session.modelReady) void startAutomatedScan(session);
  return true;
}

async function browserCaptureTranscribeRequest(request, onProgress, control = null) {
  throwIfBrowserRequestCancelled(control);
  let streamId = '';
  // 本地 file:// 页已有一个明确的媒体元素。直接复制该元素的播放流，既不需要
  // tabCapture 授权，也不会让 Chrome 因标签页被捕获而暂时切断原扬声器输出。
  let externalCapture = Boolean(request.preferInPageCapture);
  if (externalCapture) {
    onProgress?.({ type: 'progress', text: '优先复制当前播放器音频；不会接管标签页声音。' });
  } else {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: Number(request.tabId) });
    } catch (error) {
      externalCapture = true;
      onProgress?.({ type: 'progress', text: `标签页捕获未获授权，改用页面内取音：${error?.message || error}` });
    }
  }
  throwIfBrowserRequestCancelled(control);
  const sessionId = crypto.randomUUID();
  if (control) control.engineSessionId = sessionId;
  const completion = new Promise((resolve, reject) => {
    const session = {
      sessionId, tabId: Number(request.tabId), onProgress, control, resolve, reject,
      segments: [], seenSegments: new Set(), previewSegment: null, metrics: {}, settled: false, timeout: null,
      abortTimer: null, abortError: null, aborting: false, abort: null,
      captureMode: true, externalCapture, scanFrameId: null,
      isLive: Boolean(request.isLive),
      requireCopyStream: Boolean(request.requireCopyStream),
      mediaKey: String(request.mediaKey || ''),
      documentId: currentDocumentId(request.tabId, request.documentId),
      jobId: String(request.jobId || sessionId),
      asrProfile: request.asrProfile || DEFAULTS.asrProfile,
    asrLanguage: request.asrLanguage || 'auto',
      title: request.title || '在线视频'
    };
    session.abort = (reason = '浏览器实时字幕已取消') => {
      abortBrowserEngineSession(session, reason);
    };
    session.timeout = setTimeout(() => session.abort('浏览器实时字幕超过 4 小时，已停止'), ASR_REQUEST_TIMEOUT_MS);
    bindBrowserSessionControl(control, session.abort);
    browserEngineSessions.set(sessionId, session);
  });
  if (control?.cancelReason) {
    finishBrowserEngineSession(browserEngineSessions.get(sessionId), browserTaskCancelledError(control.cancelReason));
    return completion;
  }
  const initialClock = await getVideoClock(Number(request.tabId)).catch(() => request.initialClock || null);
  const startMessage = {
    type: externalCapture ? 'BILI_ASR_START_EXTERNAL' : 'BILI_ASR_START',
    sessionId, tabId: Number(request.tabId), streamId, initialClock,
    asrProfile: request.asrProfile || DEFAULTS.asrProfile,
    asrLanguage: request.asrLanguage || 'auto',
    backendMode: request.asrProfile === 'sensevoice_browser' && request.backendMode === 'wasm' ? 'wasm' : 'webgpu', cpuThreads: Number(request.cpuThreads) || 0,
    voiceEnhance: Boolean(request.voiceEnhance), voiceEnhancePreset: request.voiceEnhancePreset || 'balanced',
    sourceMode: 'capture', silentOutput: false, rollingPreview: true, isLive: Boolean(request.isLive),
    clockIndependent: Boolean(request.clockIndependent),
    maxPhraseSeconds: browserPhraseWindow(request.asrProfile, request.chunkSeconds),
    title: request.title || '在线视频', sourceUrl: request.sourceUrl || '',
    mediaKey: request.mediaKey || '',
    documentId: currentDocumentId(request.tabId, request.documentId),
    jobId: request.jobId || sessionId
  };
  let response = await sendToOffscreen(startMessage).catch((error) => ({ ok: false, error: error?.message || String(error) }));
  const session = browserEngineSessions.get(sessionId);
  if (await settleCancelledBrowserStart(control, request, sessionId, session)) return completion;
  if (!response?.ok && !externalCapture && session && isTabCaptureConsumptionFailure(response?.error)) {
    externalCapture = true;
    session.externalCapture = true;
    session.captureReady = false;
    onProgress?.({
      type: 'progress',
      text: `Chrome 拒绝离屏消费 tabCapture，已自动切换页面内取音：${response.error}`
    });
    response = await sendToOffscreen({ ...startMessage, type: 'BILI_ASR_START_EXTERNAL', streamId: '' })
      .catch((error) => ({ ok: false, error: error?.message || String(error) }));
  }
  if (await settleCancelledBrowserStart(control, request, sessionId, session)) return completion;
  if (!response?.ok) {
    finishBrowserEngineSession(session, new Error(response?.error || '浏览器实时音频处理器启动失败'));
  } else if (externalCapture && session) {
    await startInPageAudioCapture(
      session,
      false,
      '页面上找不到可捕获的视频元素'
    );
  }
  return completion;
}

async function startAutomatedScan(session) {
  if (!session || session.settled || session.scanStarted) return;
  if (session.externalCapture && !session.captureReady) return;
  session.scanStarted = true;
  const target = Number.isInteger(session.scanFrameId)
    ? { frameId: session.scanFrameId }
    : await findVideoFrame(session.tabId).catch(() => null);
  if (!target) {
    session.abort('页面上找不到可连续扫描的视频元素');
    return;
  }
  session.scanFrameId = target.frameId;
  const response = await chrome.tabs.sendMessage(session.tabId, {
    type: 'BSCG_SCAN_START', sessionId: session.sessionId, playbackRate: session.scanPlaybackRate
  }, { frameId: target.frameId }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
  if (!response?.ok) {
    session.abort(response?.error || '播放器拒绝自动连续扫描');
    return;
  }
  session.onProgress?.({
    type: 'progress',
    text: `正在静音连续 ${Number(response.playbackRate || session.scanPlaybackRate).toFixed(1)}× 扫描，音频恢复正常语速后识别；完成后恢复原播放状态。${response.rateFallback ? '播放器不支持关闭保调，已使用 1×。' : ''}`
  });
}

async function browserScanTranscribeRequest(request, onProgress, control = null, directError = null) {
  throwIfBrowserRequestCancelled(control);
  let streamId = '';
  let externalCapture = false;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: Number(request.tabId) });
  } catch (error) {
    externalCapture = true;
      onProgress?.({ type: 'progress', text: `标签页捕获未获授权，改用页面内取音：${error?.message || error}` });
  }
  throwIfBrowserRequestCancelled(control);
  const sessionId = crypto.randomUUID();
  if (control) control.engineSessionId = sessionId;
  const completion = new Promise((resolve, reject) => {
    const session = {
      sessionId, tabId: Number(request.tabId), onProgress, control, resolve, reject,
      segments: [], seenSegments: new Set(), previewSegment: null, metrics: {}, settled: false, timeout: null,
      abortTimer: null, abortError: null, aborting: false, abort: null,
      scanMode: true, scanStarted: false, scanFrameId: null, modelReady: false,
      externalCapture, captureReady: !externalCapture,
      mediaKey: String(request.mediaKey || ''),
      documentId: currentDocumentId(request.tabId, request.documentId),
      jobId: String(request.jobId || sessionId),
      asrProfile: request.asrProfile || DEFAULTS.asrProfile,
    asrLanguage: request.asrLanguage || 'auto',
      title: request.title || '在线视频',
      scanPlaybackRate: Math.max(1, Math.min(8, Number(request.scanPlaybackRate) || 4))
    };
    session.abort = (reason = '自动扫描任务已取消') => {
      if (session.externalCapture && Number.isInteger(session.scanFrameId)) {
        void chrome.tabs.sendMessage(session.tabId, { type: 'BSCG_INPAGE_CAPTURE_STOP', sessionId }, { frameId: session.scanFrameId }).catch(() => {});
      }
      abortBrowserEngineSession(session, reason);
    };
    session.timeout = setTimeout(() => session.abort('自动扫描超过 4 小时，已停止'), ASR_REQUEST_TIMEOUT_MS);
    bindBrowserSessionControl(control, session.abort);
    browserEngineSessions.set(sessionId, session);
  });
  if (control?.cancelReason) {
    finishBrowserEngineSession(browserEngineSessions.get(sessionId), browserTaskCancelledError(control.cancelReason));
    return completion;
  }
  const startMessage = {
    type: externalCapture ? 'BILI_ASR_START_EXTERNAL' : 'BILI_ASR_START', sessionId, tabId: Number(request.tabId), streamId,
    asrProfile: request.asrProfile || DEFAULTS.asrProfile,
    asrLanguage: request.asrLanguage || 'auto',
    backendMode: request.asrProfile === 'sensevoice_browser' && request.backendMode === 'wasm' ? 'wasm' : 'webgpu', cpuThreads: Number(request.cpuThreads) || 0,
    voiceEnhance: Boolean(request.voiceEnhance), voiceEnhancePreset: request.voiceEnhancePreset || 'balanced',
    sourceMode: 'capture', silentOutput: true, rollingPreview: false, scanMode: true,
    maxPhraseSeconds: browserPhraseWindow(request.asrProfile, request.chunkSeconds),
    title: request.title || '在线视频', sourceUrl: request.sourceUrl || '',
    mediaKey: request.mediaKey || '',
    documentId: currentDocumentId(request.tabId, request.documentId),
    jobId: request.jobId || sessionId
  };
  let response = await sendToOffscreen(startMessage).catch((error) => ({ ok: false, error: error?.message || String(error) }));
  const session = browserEngineSessions.get(sessionId);
  if (await settleCancelledBrowserStart(control, request, sessionId, session)) return completion;
  if (!response?.ok && !externalCapture && session && isTabCaptureConsumptionFailure(response?.error)) {
    externalCapture = true;
    session.externalCapture = true;
    session.captureReady = false;
    onProgress?.({
      type: 'progress',
      text: `Chrome 拒绝离屏消费 tabCapture，已自动切换页面内取音：${response.error}`
    });
    response = await sendToOffscreen({ ...startMessage, type: 'BILI_ASR_START_EXTERNAL', streamId: '' })
      .catch((error) => ({ ok: false, error: error?.message || String(error) }));
  }
  if (await settleCancelledBrowserStart(control, request, sessionId, session)) return completion;
  if (!response?.ok) {
    finishBrowserEngineSession(session, new Error(response?.error || '自动扫描音频处理器启动失败'));
  } else if (externalCapture && session) {
    await startInPageAudioCapture(
      session,
      true,
      `整轨重放失败（${directError?.message || directError || '未知原因'}），且页面内找不到可取音的视频`
    );
  }
  return completion;
}

async function refreshQueuedDirectSource(request, onProgress, control = null, force = false) {
  throwIfBrowserRequestCancelled(control);
  const platform = String(request.directSource?.platform || '');
  const waitedMs = Math.max(0, Number(request.queueWaitMs) || 0);
  if (request.captureOnly || request.forceScan || (!force && waitedMs < 4000) || !['bilibili', 'youtube'].includes(platform)) return false;
  try {
    const tab = await chrome.tabs.get(Number(request.tabId));
    throwIfBrowserRequestCancelled(control);
    const refreshed = await prepareBrowserDirectSource(tab, { refreshAudio: true });
    throwIfBrowserRequestCancelled(control);
    if (!refreshed?.candidates?.length || refreshed.platform !== platform) return false;
    const expectedVideoId = String(request.directSource?.videoId || '');
    const expectedPartId = String(request.directSource?.partId || '');
    if ((expectedVideoId && refreshed.videoId !== expectedVideoId) ||
        (expectedPartId && String(refreshed.partId) !== expectedPartId)) {
      throw browserTaskCancelledError('排队期间播放器已切换到其他视频');
    }
    request.directSource = {
      ...request.directSource,
      videoId: refreshed.videoId,
      partId: refreshed.partId,
      duration: Number(refreshed.duration) || Number(request.directSource.duration) || 0,
      referer: refreshed.referer || request.directSource.referer || '',
      candidates: refreshed.candidates
    };
    pushLog('info', `[browser/queue] 等待 ${(waitedMs / 1000).toFixed(1)} 秒后刷新 ${platform} 签名音轨，共 ${refreshed.candidates.length} 条`);
    onProgress?.({ type: 'progress', text: '已轮到本页，正在刷新音轨授权并启动识别…', queuePosition: 0 });
    return true;
  } catch (error) {
    if (error?.code === 'TASK_CANCELLED') throw error;
    pushLog('warn', `[browser/queue] 排队后刷新 ${platform} 音轨失败，继续尝试已有候选：${error?.message || error}`);
    return false;
  }
}

async function browserTranscribeRequestNow(request, onProgress, control = null) {
  throwIfBrowserRequestCancelled(control);
  if (request.captureOnly) return browserCaptureTranscribeRequest(request, onProgress, control);
  if (request.forceScan) return browserScanTranscribeRequest(request, onProgress, control, new Error('页面未暴露可重放的独立音轨'));
  try {
    await refreshQueuedDirectSource(request, onProgress, control);
    throwIfBrowserRequestCancelled(control);
    return await browserDirectTranscribeRequest(request, onProgress, control);
  } catch (error) {
    if (error?.code === 'TASK_CANCELLED' || control?.cancelReason) throw error;
    if (!isDirectAudioFailure(error)) throw error;
    // A cached player URL can expire even without a queue wait. Refresh the
    // same media once before giving up the fast audio-track path.
    if (request.directSource?.platform === 'bilibili' && !request.audioRefreshRetried) {
      request.audioRefreshRetried = true;
      if (await refreshQueuedDirectSource(request, onProgress, control, true)) {
        throwIfBrowserRequestCancelled(control);
        try {
          return await browserDirectTranscribeRequest(request, onProgress, control);
        } catch (retryError) {
          if (retryError?.code === 'TASK_CANCELLED' || control?.cancelReason || !isDirectAudioFailure(retryError)) throw retryError;
          error = retryError;
        }
      }
    }
    if (request.allowScan === false) throw error;
    onProgress?.({ type: 'segments_reset' });
    onProgress?.({ type: 'progress', text: `独立音轨无法完整重放：${error?.message || error}；准备连续扫描后备…` });
    return browserScanTranscribeRequest(request, onProgress, control, error);
  }
}

function browserTranscribeRequest(request, onProgress, control = null) {
  return new Promise((resolve, reject) => {
    const entry = {
      id: crypto.randomUUID(),
      request: { ...request },
      onProgress,
      control,
      innerControl: { abort: null, cancelReason: '' },
      resolve,
      reject,
      started: false,
      settled: false,
      cancelled: false,
      enqueuedAt: Date.now(),
      cancel: null
    };
    entry.cancel = (reason = '浏览器转写任务已取消') => {
      if (entry.settled) return;
      entry.cancelled = true;
      entry.innerControl.cancelReason = reason;
      if (entry.started) {
        if (control) control.queueState = 'stopping';
        entry.innerControl.abort?.(reason);
        return;
      }
      entry.settled = true;
      const index = browserRequestQueue.indexOf(entry);
      if (index >= 0) browserRequestQueue.splice(index, 1);
      if (control?.abort === entry.cancel) control.abort = null;
      if (control) control.queueState = 'done';
      reject(browserTaskCancelledError(reason));
      void drainBrowserRequestQueue();
    };
    if (control) {
      // The queue owns cancellation, while seek/clock/stop must see the engine
      // ID assigned later by the running request. Share these two live fields.
      for (const key of ['engineSessionId', 'pendingSeekTime']) {
        Object.defineProperty(entry.innerControl, key, {
          enumerable: true,
          get: () => control[key],
          set: (value) => { control[key] = value; }
        });
      }
      control.abort = entry.cancel;
      control.queueState = 'queued';
      control.queueId = entry.id;
    }
    for (let index = browserRequestQueue.length - 1; index >= 0; index -= 1) {
      if (browserRequestQueue[index].cancelled || browserRequestQueue[index].settled) browserRequestQueue.splice(index, 1);
    }
    const blocker = browserQueueBlocker(request);
    const ahead = browserRequestQueue.length + (activeBrowserRequest || browserEngineSessions.size || activeBenchmarkId ? 1 : 0);
    if (control) {
      control.queueAhead = ahead;
      control.queuePosition = ahead + 1;
      control.queueBlocker = blocker;
    }
    browserRequestQueue.push(entry);
    if (ahead > 0) {
      pushLog('info', `[browser/queue] 入队 tab=${Number(request.tabId)} position=${ahead + 1} ahead=${ahead}`);
      onProgress?.({
        type: 'queue',
        text: `本页等待中：${blocker || `前面 ${ahead} 个任务`}。结束后自动开始。`,
        queuePosition: ahead + 1,
        queueAhead: ahead,
        queueBlocker: blocker
      });
    }
    void drainBrowserRequestQueue();
  });
}

async function drainBrowserRequestQueue() {
  if (browserQueueDraining || activeBrowserRequest) return;
  browserQueueDraining = true;
  try {
    // browserEngineSessions is owned by activeBrowserRequest. A session left
    // without that owner can otherwise make every later page look permanently
    // queued even though no visible task exists.
    if (browserEngineSessions.size) {
      const dangling = [...browserEngineSessions.values()].filter((session) => !session.settled);
      pushLog('warn', `[browser/queue] 回收 ${dangling.length} 个失去队列所有者的离屏会话`);
      for (const session of dangling) {
        await sendToOffscreen({
          type: 'BILI_ASR_STOP', tabId: session.tabId,
          sessionId: session.sessionId, reason: 'orphaned-queue-owner'
        }).catch(() => null);
        finishBrowserEngineSession(session, browserTaskCancelledError('旧识别任务已自动回收'));
      }
    }
    let readyRoutes = null;
    const runtime = await sendToOffscreen({ type: 'BILI_ASR_CAPABILITIES' }).catch(() => null);
    if (!runtime) {
      setTimeout(() => { void drainBrowserRequestQueue(); }, 1000);
      return;
    }
    if (runtime.activeSession?.sessionId && !browserEngineSessions.has(runtime.activeSession.sessionId)) {
      await sendToOffscreen({
        type: 'BILI_ASR_STOP',
        tabId: Number(runtime.activeSession.tabId) || 0,
        sessionId: runtime.activeSession.sessionId,
        reason: 'orphaned-background'
      }).catch(() => null);
      setTimeout(() => { void drainBrowserRequestQueue(); }, 250);
      return;
    }
    if (runtime.benchmark?.status === 'running') {
      const runningId = runtime.benchmark.id || '';
      if (runningId && activeBenchmarkId !== runningId) {
        activeBenchmarkId = runningId;
        watchActiveBenchmark(runningId);
      }
      for (const candidate of browserRequestQueue) {
        if (candidate.benchmarkWaitReported) continue;
        candidate.benchmarkWaitReported = true;
        candidate.onProgress?.({ type: 'progress', text: '诊断测速完成后会自动开始识别…' });
      }
      return;
    }
    activeBenchmarkId = '';
    if (runtime.modelDownload?.status === 'running') {
      const runningId = runtime.modelDownload.id || '';
      if (runningId && activeModelDownloadId !== runningId) {
        activeModelDownloadId = runningId;
        watchActiveModelDownload(runningId);
      }
      readyRoutes = new Set(runtime.modelDownload.readyRoutes || []);
    } else {
      activeModelDownloadId = '';
    }
    if (activeBrowserRequest || browserEngineSessions.size || activeBenchmarkId) return;
    for (let index = browserRequestQueue.length - 1; index >= 0; index -= 1) {
      const candidate = browserRequestQueue[index];
      if (candidate.cancelled || candidate.settled) browserRequestQueue.splice(index, 1);
    }
    const routeFor = (request) => request.asrProfile === 'sensevoice_browser'
      ? `sense-${request.backendMode === 'wasm' ? 'wasm' : 'webgpu'}`
      : 'qwen-webgpu';
    const entryIndex = readyRoutes
      ? browserRequestQueue.findIndex((candidate) => readyRoutes.has(routeFor(candidate.request)))
      : (browserRequestQueue.length ? 0 : -1);
    if (entryIndex < 0) {
      if (readyRoutes && browserRequestQueue.length) {
        for (const candidate of browserRequestQueue) {
          if (candidate.modelWaitReported) continue;
          candidate.modelWaitReported = true;
          candidate.onProgress?.({
            type: 'progress',
            text: '所选模型仍在下载；对应链路准备好后会自动开始识别…'
          });
        }
      }
      if (!browserRequestQueue.length) void maybeCloseOffscreenDocument();
      return;
    }
    const entry = browserRequestQueue.splice(entryIndex, 1)[0];
    activeBrowserRequest = entry;
    entry.started = true;
    entry.request.queueWaitMs = Math.max(0, Date.now() - entry.enqueuedAt);
    if (entry.control) {
      entry.control.queueState = 'running';
      entry.control.queueAhead = 0;
      entry.control.queuePosition = 0;
      entry.control.queueBlocker = '';
    }
    pushLog('info', `[browser/queue] 出队 tab=${Number(entry.request.tabId)} wait=${(entry.request.queueWaitMs / 1000).toFixed(1)}s`);
    entry.onProgress?.({ type: 'progress', text: '识别任务开始运行…', queuePosition: 0 });
    try {
      throwIfBrowserRequestCancelled(entry.innerControl);
      const result = await browserTranscribeRequestNow(entry.request, entry.onProgress, entry.innerControl);
      if (entry.cancelled) throw browserTaskCancelledError(entry.innerControl.cancelReason);
      if (!entry.settled) {
        entry.settled = true;
        entry.resolve(result);
      }
    } catch (error) {
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(error);
      }
    } finally {
      if (entry.control?.abort === entry.cancel) entry.control.abort = null;
      if (entry.control) entry.control.queueState = 'done';
      activeBrowserRequest = null;
      queueMicrotask(() => { void drainBrowserRequestQueue(); });
    }
  } finally {
    browserQueueDraining = false;
    schedulePendingBrowserSettingsRestart();
  }
}

function transcribeTransport(settings) {
  pushLog('info', `[transport] 浏览器链路：profile=${settings.asrProfile || DEFAULTS.asrProfile} backend=${settings.asrBackend || 'auto'} resolved=${browserBackendMode(settings)} threads=${settings.recognitionThreads || 'auto'} audio=${settings.voiceEnhance ? `far-field/${settings.voiceEnhancePreset || 'balanced'}` : 'raw'}`);
  return {
    kind: 'browser',
    label: localEngineLabel(settings),
    start: browserTranscribeRequest,
    payload: ({ audioUrl, expectedDuration, tabId, directSource, localFileToken, title, sourceUrl, forceScan, mediaKey, documentId, jobId }) => ({
      tabId,
      title,
      sourceUrl,
      expectedDuration,
      mediaKey,
      documentId,
      jobId,
      asrProfile: settings.asrProfile || DEFAULTS.asrProfile,
      backendMode: browserBackendMode(settings),
      cpuThreads: Number(settings.recognitionThreads) || 0,
    asrLanguage: settings.asrLanguage || 'auto',
      voiceEnhance: Boolean(settings.voiceEnhance),
      voiceEnhancePreset: settings.voiceEnhancePreset || 'balanced',
      chunkSeconds: Number(settings.liveChunkSeconds) || SENSEVOICE_LIVE_WINDOW_SECONDS,
      scanPlaybackRate: Number(settings.scanPlaybackRate) || 4,
      allowScan: true,
      forceScan: Boolean(forceScan),
      directSource: directSource || {
        platform: /^file:/i.test(sourceUrl || '') ? 'local' : 'web',
        duration: Number(expectedDuration) || 0,
        candidates: localFileToken
          ? [{ url: `bscg-local:${localFileToken}`, token: localFileToken, kind: 'local-upload', frameId: 0 }]
          : [{ url: audioUrl, kind: /\.m3u8(?:$|[?#])/i.test(audioUrl || '') ? 'hls' : 'file', frameId: 0 }]
      }
    })
  };
}

function resultStorageKey(tabId, videoId, partId) {
  return `result:${tabId}:${encodeURIComponent(videoId)}:${encodeURIComponent(partId)}`;
}

function joinSummaryText(parts) {
  return parts.map((part) => cleanDisplayCaption(part)).filter(Boolean).join('')
    .replace(/([。！？!?；;，,])\1+/g, '$1')
    .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSummaryBlocks(segments) {
  const blocks = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    blocks.push({
      start: buffer[0].from,
      end: buffer.at(-1).to,
      text: joinSummaryText(buffer.map((row) => row.content)),
      sourceCueIds: buffer.map((row) => row.id)
    });
    buffer = [];
  };
  segments.forEach((row, index) => {
    buffer.push({ ...row, id: `cue-${index + 1}` });
    const duration = buffer.at(-1).to - buffer[0].from;
    const boundary = /[。！？!?；;]$/.test(buffer.at(-1).content);
    if (duration >= 55 || (duration >= 20 && boundary)) flush();
  });
  flush();
  return blocks.filter((block) => block.text);
}

async function createResult({ tabId, title, part, sourceUrl, platform = 'bilibili', videoId, partId, bvid, cid, label, rows, originalRows, pageUrl, mediaKey, documentId, mediaDuration = 0, settings = {} }) {
  const lockedVideoId = String(videoId || bvid || '');
  const lockedPartId = String(partId || cid || lockedVideoId);
  if (!lockedVideoId || !lockedPartId) throw new Error('字幕结果缺少视频身份，已拒绝保存');
  const lockedMediaKey = String(mediaKey || buildMediaKey({ platform, pageUrl: sourceUrl, videoId: lockedVideoId, partId: lockedPartId }));
  const segments = rows.map((row) => ({
    from: Math.max(0, Number(row.from) || 0),
    to: Math.max(Number(row.from) || 0, Number(row.to) || Number(row.from) || 0),
    content: cleanDisplayCaption(row.content),
    ...(row.translationVerified && row.originalContent ? {
      translationVerified: true, originalContent: cleanDisplayCaption(row.originalContent),
      ...(row.sourceContent ? { sourceContent: cleanDisplayCaption(row.sourceContent) } : {})
    } : {})
  })).filter((row) => row.content);
  const summaryBlocks = buildSummaryBlocks(segments);
  const partLine = part && part !== title ? `\n分P：${part}` : '';
  const header = `视频：${title}${partLine}\n链接：${sourceUrl}\n字幕来源：${label}\n\n`;
  const subtitleBody = segments.map((row) => `[${formatTime(row.from)}] ${row.content}`).join('\n');
  const summaryBody = summaryBlocks.map((block) => `[${formatTime(block.start)}–${formatTime(block.end)}] ${block.text}`).join('\n\n');
  const result = {
    resultId: crypto.randomUUID(),
    schemaVersion: RESULT_SCHEMA_VERSION,
    sourceTabId: tabId,
    fileName: `${safeFileName(title)}-字幕.txt`,
    text: header + (summaryBody || subtitleBody),
    subtitleText: header + subtitleBody,
    summaryText: header + (summaryBody || subtitleBody),
    sourceUrl,
    sourcePlatform: platform,
    sourceVideoId: lockedVideoId,
    sourcePartId: lockedPartId,
    mediaKey: lockedMediaKey,
    // 该结果对应的媒体总时长（分P/视频的权威时长）。缓存复用时用它证明
    // "这份字幕确实属于这支视频"，避免把别的视频的字幕配上当前标题。
    mediaDuration: Number(mediaDuration) || 0,
    documentId: currentDocumentId(tabId, documentId),
    asrModel: /(?:CC|字幕)/i.test(label) && !/SenseVoice|Qwen/i.test(label)
      ? 'platform-subtitles'
      : settings.asrProfile || DEFAULTS.asrProfile,
    summaryEngine: settings.summaryEngine || 'external-page',
    sourceLabel: label,
    rows: segments.length,
    segments,
    translationIdentity: segments.some(row => row.translationVerified) ? captionTranslationIdentity(settings) : '',
    originalSegments: (originalRows || rows).map(row => ({ from: row.from, to: row.to,
      content: cleanDisplayCaption(row.content) })).filter(row => row.content),
    summaryBlocks,
    createdAt: Date.now()
  };
  const activeDocumentId = currentDocumentId(tabId);
  if (result.documentId && activeDocumentId && result.documentId !== activeDocumentId) {
    throw new Error('页面文档已经替换，已拒绝保存旧媒体的字幕结果');
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    // file:// 页后台读不到 tab.url（返回空串），用消息里带的页面地址兜底，否则结果永远存不进缓存
    if (resultMatchesTabUrl(result, tab.url || pageUrl || '')) {
      const key = resultStorageKey(tabId, lockedVideoId, lockedPartId);
      await chrome.storage.local.set({ [key]: result });
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (!resultMatchesTabUrl(result, currentTab.url || pageUrl || '')) await chrome.storage.local.remove(key);
      } catch {
        await chrome.storage.local.remove(key);
      }
    }
  } catch {}
  return result;
}

async function findCachedResult(tabId, videoId, partId, expectedDuration = 0) {
  const key = resultStorageKey(tabId, videoId, partId);
  const result = (await chrome.storage.local.get(key))[key];
  if (!result?.text || Number(result.schemaVersion || 0) !== RESULT_SCHEMA_VERSION || Date.now() - result.createdAt > RESULT_TTL_MS) {
    if (result) await chrome.storage.local.remove(key);
    return null;
  }
  // 缓存必须能证明自己属于当前视频：记录时长与当前权威时长不符时作废重识别。
  // 否则一旦有错内容进了缓存，之后每次"总结"都会跳过识别、直接发出去。
  const recorded = Number(result.mediaDuration) || 0;
  const expected = Number(expectedDuration) || 0;
  if (expected > 0 && !resultDurationMatches(recorded, expected)) {
    await chrome.storage.local.remove(key);
    pushLog('warn', `[cache] 已作废时长不符的缓存字幕：记录 ${recorded}s 与当前媒体 ${expected}s 不符（${videoId}），将重新识别`);
    return null;
  }
  return result;
}

// 结果时长与本视频权威时长的一致性判据（容差 max(5%, 8s)）。
function resultDurationMatches(recorded, expected, toleranceRatio = 0.05, toleranceSeconds = 8) {
  const left = Number(recorded) || 0;
  const right = Number(expected) || 0;
  if (left <= 0 || right <= 0) return false; // 缺任一侧都无法自证
  return Math.abs(left - right) <= Math.max(right * toleranceRatio, toleranceSeconds);
}

function genericPageIdentity(value) {
  const url = new URL(value || 'https://invalid.local/');
  url.hash = '';
  // Ignore navigation noise that does not identify the media itself. Unknown
  // query parameters are intentionally preserved so ?id= / ?episode= changes
  // still invalidate stale captions and per-video translation overrides.
  const transient = /^(?:utm_.+|spm|spm_id_from|share_.+|feature|si|pp|ref|referrer|source|from|autoplay|start|t|time_continue)$/i;
  for (const key of [...url.searchParams.keys()]) {
    if (transient.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

function resultMatchesTabUrl(result, candidateUrl) {
  try {
    const currentUrl = new URL(candidateUrl || 'https://invalid.local/');
    const source = new URL(result.sourceUrl || 'https://invalid.local/');
    if (result.sourcePlatform === 'bilibili') {
      const currentId = currentUrl.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || '';
      const sourcePage = Math.max(1, Number(source.searchParams.get('p')) || 1);
      const currentPage = Math.max(1, Number(currentUrl.searchParams.get('p')) || 1);
      return currentId === result.sourceVideoId && sourcePage === currentPage;
    }
    if (result.sourcePlatform === 'youtube') {
      const currentId = currentUrl.searchParams.get('v') || currentUrl.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
      return currentId === result.sourceVideoId;
    }
    return genericPageIdentity(currentUrl.href) === genericPageIdentity(source.href);
  } catch {
    return false;
  }
}

async function pruneResultsForTabUrl(tabId, candidateUrl) {
  const data = await chrome.storage.local.get(null);
  const keys = Object.entries(data)
    .filter(([key, value]) => key.startsWith(`result:${tabId}:`) && !resultMatchesTabUrl(value || {}, candidateUrl))
    .map(([key]) => key);
  if (keys.length) await chrome.storage.local.remove(keys);
}

function cancelTranscriptionsForTab(tabId, candidateUrl = '', documentId = '') {
  for (const control of activeTranscriptions.values()) {
    if (!control || control.tabId !== tabId) continue;
    const replacedDocument = Boolean(documentId && control.documentId && control.documentId !== documentId);
    if (!replacedDocument && candidateUrl && resultMatchesTabUrl(control, candidateUrl)) continue;
    control.cancelled = true;
    try { control.abort?.(candidateUrl ? '源视频页面已经切换，本地转写已取消并清理' : '源视频标签页已关闭，本地转写已取消并清理'); } catch {}
  }
}

function throwIfExtractionCancelled(message) {
  const requestId = String(message?.requestId || '');
  if (!requestId || !cancelledExtractionRequests.has(requestId)) return;
  const error = new Error('总结请求已取消');
  error.code = 'TASK_CANCELLED';
  throw error;
}

function cancelTranscriptionTask(tabId, taskId = '', requestId = '') {
  const normalizedRequestId = String(requestId || '');
  if (normalizedRequestId) {
    cancelledExtractionRequests.add(normalizedRequestId);
    if (cancelledExtractionRequests.size > 100) cancelledExtractionRequests.delete(cancelledExtractionRequests.values().next().value);
  }
  let cancelled = 0;
  for (const control of activeTranscriptions.values()) {
    if (!control || control.tabId !== tabId || control.cancelled) continue;
    if (taskId && control.taskId !== taskId) continue;
    if (!taskId && normalizedRequestId && control.requestId !== normalizedRequestId) continue;
    control.cancelled = true;
    control.deliveryIntent = '';
    cancelled += 1;
    try { control.abort?.('用户取消了完整转写任务'); } catch {}
  }
  return { ok: true, cancelled };
}

async function releaseTranscriptionTask(control, taskKey) {
  try { await chrome.storage.local.remove(taskKey); } catch {}
  activeTranscriptions.delete(control.taskId);
  schedulePendingBrowserSettingsRestart();
  await sendLive(control.tabId, {
    type: 'BSCG_TASK_FINISHED',
    taskId: control.taskId,
    cancelled: Boolean(control.cancelled)
  });
  setTimeout(() => { void maybeCloseOffscreenDocument(); }, 300);
}

async function cleanupClosedTab(tabId) {
  captionDisplayByTab.delete(tabId);
  const data = await chrome.storage.local.get(null);
  const jobIds = [];
  const keys = Object.entries(data).filter(([key, value]) => {
    if (key.startsWith(`result:${tabId}:`)) return true;
    if (key.startsWith('task:') && Number(value?.sourceTabId) === Number(tabId)) return true;
    const sourceOwnedJob = key.startsWith('job:') && Number(value?.sourceTabId) === Number(tabId) && !value?.targetTabId && !value?.targetPending;
    const targetOwnedJob = key.startsWith('job:') && Number(value?.targetTabId) === Number(tabId);
    if (sourceOwnedJob || targetOwnedJob) {
      jobIds.push(String(value?.jobId || key.slice(4)));
      return true;
    }
    return false;
  }).map(([key]) => key);
  if (keys.length) await chrome.storage.local.remove(keys);
  await Promise.all(jobIds.map((jobId) => chrome.alarms.clear(`bscg-job-expire:${jobId}`).catch(() => false)));
}

async function pruneJobsForTargetTabUrl(tabId, candidateUrl) {
  const data = await chrome.storage.local.get(null);
  const keys = Object.entries(data).filter(([key, value]) => {
    if (!key.startsWith('job:') || Number(value?.targetTabId) !== Number(tabId)) return false;
    try {
      const url = new URL(candidateUrl || 'https://invalid.local/');
      const config = DESTINATIONS[value.destination];
      const officialPage = url.protocol === 'https:' && config?.hosts?.has(url.hostname);
      const matchingJob = url.searchParams.get('bili_subtitle_upload') === '1' && url.searchParams.get('job') === value.jobId;
      const recentRedirect = officialPage && Date.now() - Number(value.createdAt || 0) < 5 * 60 * 1000;
      return !matchingJob && !recentRedirect;
    } catch {
      return true;
    }
  }).map(([key]) => key);
  if (keys.length) await chrome.storage.local.remove(keys);
}

function formatSrtTime(seconds) {
  const milliseconds = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function buildSrt(rows) {
  return '\uFEFF' + rows.map((row, index) => {
    const from = Math.max(0, Number(row.from) || 0);
    const to = Math.max(from + 0.2, Number(row.to) || from + 2);
    return `${index + 1}\n${formatSrtTime(from)} --> ${formatSrtTime(to)}\n${cleanDisplayCaption(row.content)}`;
  }).filter((block) => !block.endsWith('\n')).join('\n\n') + '\n';
}

function matchesLiveSource(session, candidateUrl) {
  try {
    const candidate = new URL(candidateUrl || 'https://invalid.local/');
    const source = new URL(session.sourceUrl || 'https://invalid.local/');
    if (session.sourcePlatform === 'bilibili-live') {
      return liveCapturePolicy(candidate.href).roomId === session.sourceVideoId;
    }
    if (session.sourcePlatform === 'bilibili') {
      const candidateBvid = candidate.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || '';
      const sourcePage = Math.max(1, Number(source.searchParams.get('p')) || 1);
      const candidatePage = Math.max(1, Number(candidate.searchParams.get('p')) || 1);
      return candidateBvid === session.sourceVideoId && candidatePage === sourcePage;
    }
    if (session.sourcePlatform === 'youtube') {
      const candidateId = candidate.searchParams.get('v') || candidate.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
      return candidateId === session.sourceVideoId;
    }
    return genericPageIdentity(candidate.href) === genericPageIdentity(source.href);
  } catch {
    return false;
  }
}

async function clearResultCacheForTab(tabId) {
  // 清除当前标签页的全部缓存结果，并停止本页仍在运行的转写任务；
  // 之后生成/总结都会按当前模型与后端设置重新识别。
  cancelTranscriptionsForTab(tabId);
  const data = await chrome.storage.local.get(null);
  const keys = Object.keys(data).filter((key) => key.startsWith(`result:${tabId}:`));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

async function latestResultForTab(tabId, fallbackUrl = '') {
  const tab = await chrome.tabs.get(tabId);
  const tabUrl = tab.url || fallbackUrl || '';
  const data = await chrome.storage.local.get(null);
  return Object.entries(data)
    .filter(([key, value]) => key.startsWith(`result:${tabId}:`) && value?.text && Number(value.schemaVersion || 0) === RESULT_SCHEMA_VERSION && Date.now() - Number(value.createdAt || 0) <= RESULT_TTL_MS)
    .map(([, value]) => value)
    .filter((value) => resultMatchesTabUrl(value, tabUrl))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null;
}

async function exportCurrentSubtitles(tabId, fallbackUrl = '', displayedRows = []) {
  if (!tabId) throw new Error('无法识别当前视频标签页');
  const session = liveCaptures.get(tabId);
  if (session) {
    const tab = await chrome.tabs.get(tabId);
    if (!matchesLiveSource(session, tab.url || fallbackUrl)) throw new Error('页面已经切换，请为当前视频重新生成字幕');
  }
  const cached = session ? null : await latestResultForTab(tabId, fallbackUrl);
  const pageRows = Array.isArray(displayedRows) ? displayedRows.slice(-MAX_LIVE_ROWS)
    .filter((row) => !row?.provisional && Number.isFinite(row?.from) && Number.isFinite(row?.to) && row.to > row.from)
    .map((row) => ({ from: Math.max(0, row.from), to: row.to, content: cleanDisplayCaption(row.content) }))
    .filter((row) => row.content) : [];
  if (pageRows.length) {
    const tab = await chrome.tabs.get(tabId);
    if (!fallbackUrl || (tab.url && tab.url !== fallbackUrl)) throw new Error('页面已经切换，请为当前视频重新生成字幕');
  }
  // Stopped/partial sessions intentionally do not populate the full-result
  // cache. Their committed page rows remain exportable while the page is open.
  const rows = session?.rows?.length ? session.rows : pageRows.length ? pageRows : cached?.segments || [];
  if (!rows.length) throw new Error('当前页面还没有可导出的字幕');
  const title = session?.title || cached?.fileName?.replace(/-字幕\.txt$/i, '') || '视频字幕';
  const fileName = `${safeFileName(title)}-字幕.srt`;
  const content = buildSrt(rows);
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [content, fileName],
    func: (text, name) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/x-subrip;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.style.display = 'none';
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  });
  return { ok: true, rows: rows.length, fileName };
}

async function getLiveUiState(tabId, fallbackUrl = '') {
  if (!tabId) return { ok: true, extVersion: BG_VERSION, running: false, taskRunning: false, rows: 0, segments: [] };
  const task = findTabTranscription(tabId);
  const taskState = {
    captionVisibility: captionDisplayByTab.get(tabId)?.visible,
    taskRunning: Boolean(task),
    taskId: task?.taskId || '',
    taskQueued: task?.queueState === 'queued'
  };
  const session = liveCaptures.get(tabId);
  if (session) {
    const tab = await chrome.tabs.get(tabId);
    // file:// 页后台读不到 tab.url，用消息携带的页面地址兜底，否则本地视频永远无法恢复字幕状态
    const sourceMatches = matchesLiveSource(session, tab.url || fallbackUrl);
    if (!sourceMatches || session.finished) {
      return {
        ok: true,
        extVersion: BG_VERSION,
        ...taskState,
        running: false,
        stopping: true,
        sessionId: sourceMatches ? session.sessionId : '',
        rows: sourceMatches ? session.rows?.length || 0 : 0,
        segments: sourceMatches ? (session.rows || []).slice() : [],
        previewSegment: sourceMatches ? session.previewSegment || null : null,
        finalSegment: sourceMatches ? session.finalSegment || null : null
      };
    }
    return {
      ok: true,
      extVersion: BG_VERSION,
      ...taskState,
      running: !session.stopRequested,
      stopping: Boolean(session.stopRequested),
      sessionId: session.sessionId,
      mode: session.mode === 'browser-capture' ? (session.isLive ? 'live' : 'capture') : 'timeline',
      overlayOnTop: Boolean(session.overlayOnTop),
      queued: session.browserControl?.queueState === 'queued',
      queuePosition: Number(session.browserControl?.queuePosition) || 0,
      queueAhead: Number(session.browserControl?.queueAhead) || 0,
      queueBlocker: String(session.browserControl?.queueBlocker || ''),
      rows: session.rows?.length || 0,
      segments: (session.rows || []).slice(),
      lookahead: session.lookaheadMetrics || null,
      previewSegment: session.previewSegment || null,
      finalSegment: session.finalSegment || null,
      bufferedTo: Number(session.bufferedTo) || 0
    };
  }
  const tab = await chrome.tabs.get(tabId);
  const pageHost = new URL(tab.url || fallbackUrl || 'https://invalid.local/').hostname;
  const isLivePage = pageHost === 'live.bilibili.com' || /(^|\.)huya\.com$/i.test(pageHost);
  const cached = isLivePage ? null : await latestResultForTab(tabId, fallbackUrl);
  return {
    ok: true,
    extVersion: BG_VERSION,
    ...taskState,
    running: false,
    sessionId: cached ? `cached:${cached.resultId || cached.createdAt}` : '',
    rows: cached?.segments?.length || 0,
    segments: (cached?.segments || []).slice(),
    bufferedTo: cached?.segments?.reduce((value, row) => Math.max(value, Number(row.to) || 0), 0) || 0
  };
}

// 文件正文第一行固定是 `视频：<标题>`。附件名与正文出自同一次结果构造，正常情况下
// 必然对应；这里再校验一次，任何一条路径把两者拆散都会在此被纠正，而不是把
// 名不符实的字幕文件发到外部模型。
function textHeaderTitle(value) {
  return /^视频：([^\n]*)/.exec(String(value || ''))?.[1] || '';
}

function fileNameMatchesText(fileName, text) {
  const header = textHeaderTitle(text);
  if (!header) return true; // 没有头部信息时无从比对，不自作主张改名
  return safeFileName(header) === String(fileName || '').replace(/-字幕\.txt$/i, '');
}

function alignPayloadFileName(result) {
  const text = result?.summaryText || result?.text || '';
  const fileName = String(result?.fileName || '');
  if (!text || !fileName || fileNameMatchesText(fileName, text)) return fileName;
  const corrected = `${safeFileName(textHeaderTitle(text))}-字幕.txt`;
  pushLog('warn', `[payload] 附件名与正文标题不一致，已按正文重建：${fileName} -> ${corrected}`);
  return corrected;
}

async function createPayload(result, prompt, destination) {
  const jobId = crypto.randomUUID();
  const payload = {
    jobId,
    resultId: result.resultId,
    fileName: alignPayloadFileName(result),
    text: result.summaryText || result.text,
    prompt,
    destination,
    sourceUrl: result.sourceUrl,
    sourcePlatform: result.sourcePlatform,
    sourceVideoId: result.sourceVideoId,
    sourcePartId: result.sourcePartId,
    mediaKey: result.mediaKey,
    sourceDocumentId: result.documentId,
    asrModel: result.asrModel,
    summaryEngine: result.summaryEngine,
    sourceTabId: result.sourceTabId,
    targetTabId: null,
    targetPending: true,
    createdAt: Date.now()
  };
  await chrome.storage.local.set({ [`job:${jobId}`]: payload });
  await chrome.alarms.create(`bscg-job-expire:${jobId}`, { when: payload.createdAt + JOB_TTL_MS });
  // 发送链路的可核查凭据：附件名与正文标题必须指向同一支视频。
  pushLog('info', `[payload] 发送至 ${destination} 附件=${payload.fileName} 正文标题=${textHeaderTitle(payload.text) || '(无头部)'} ` +
    `视频=${payload.sourceVideoId || ''} 分P=${payload.sourcePartId || ''}`);
  return payload;
}

async function cleanupJobCache(removeAll = false) {
  const data = await chrome.storage.local.get(null);
  const expired = Object.entries(data).filter(([key, value]) =>
    (key.startsWith('job:') && (removeAll || !value?.createdAt || Date.now() - value.createdAt > JOB_TTL_MS)) ||
    (key.startsWith('task:') && (!activeTranscriptions.has(value?.taskId) || !value?.createdAt || Date.now() - value.createdAt > TASK_TTL_MS)) ||
    (key.startsWith('result:') && (Number(value?.schemaVersion || 0) !== RESULT_SCHEMA_VERSION || !value?.createdAt || Date.now() - value.createdAt > RESULT_TTL_MS))
  ).map(([key]) => key);
  if (expired.length) await chrome.storage.local.remove(expired);
}

const DESTINATIONS = {
  chatgpt: { name: 'ChatGPT', promptKey: 'prompt', urlKey: 'chatgptUrl', hosts: new Set(['chatgpt.com', 'chat.openai.com']) },
  aistudio: { name: 'Google AI Studio', promptKey: 'aiStudioPrompt', urlKey: 'aiStudioUrl', hosts: new Set(['aistudio.google.com']) },
  deepseek: { name: 'DeepSeek', promptKey: 'deepseekPrompt', urlKey: 'deepseekUrl', hosts: new Set(['chat.deepseek.com']) }
};

async function deliverToDestination({ tabId, message, settings, result }) {
  throwIfExtractionCancelled(message);
  if (message.destination === 'file') {
    // 字幕文件模式：只生成完整字幕并回显到页面（可导出 SRT、可再次总结），不打开 AI 页面。
    await sendLive(tabId, {
      type: 'BSCG_FILE_RESULT',
      rows: result.rows,
      segments: result.segments || [],
      title: String(result.fileName || '').replace(/-字幕\.txt$/i, ''),
      source: result.sourceLabel || ''
    });
    return { ok: true, rows: result.rows, file: true, reused: Boolean(message.reused) };
  }
  const config = DESTINATIONS[message.destination];
  if (!config) throw new Error('没有选择有效的发送目标');
  // 完整结果同时回显到源视频页：悬停预览/导出立即拿到全部分段，而不是等刷新后才恢复
  await sendLive(tabId, {
    type: 'BSCG_FILE_RESULT',
    rows: result.rows,
    segments: result.segments || [],
    title: String(result.fileName || '').replace(/-字幕\.txt$/i, ''),
    source: result.sourceLabel || ''
  });
  throwIfExtractionCancelled(message);
  await progress(tabId, `已得到 ${result.rows} 段文本，正在打开 ${config.name}…`, 'success');
  // Chrome Web Store 审核要求：扩展只负责打开官方 AI 页面、填入提示词并附加字幕。
  // 最终提交必须由用户在目标页面确认内容后手动完成，扩展不会点击发送 / Run。
  const payload = await createPayload(result, settings[config.promptKey] || DEFAULTS[config.promptKey], message.destination);
  try {
    throwIfExtractionCancelled(message);
  } catch (error) {
    await chrome.storage.local.remove(`job:${payload.jobId}`);
    await chrome.alarms.clear(`bscg-job-expire:${payload.jobId}`);
    throw error;
  }
  const target = new URL(settings[config.urlKey] || DEFAULTS[config.urlKey]);
  const allowedHosts = config.hosts;
  if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname)) {
    await chrome.storage.local.remove(`job:${payload.jobId}`);
    await chrome.alarms.clear(`bscg-job-expire:${payload.jobId}`);
    throw new Error(`${config.name} 地址不在允许的官方域名中`);
  }
  target.searchParams.set('bili_subtitle_upload', '1');
  target.searchParams.set('job', payload.jobId);
  try {
    const targetTab = await chrome.tabs.create({ url: target.href, active: true });
    if (!targetTab?.id) throw new Error(`无法打开 ${config.name} 标签页`);
    payload.targetTabId = targetTab.id;
    payload.targetPending = false;
    await chrome.storage.local.set({ [`job:${payload.jobId}`]: payload });
    try {
      await chrome.tabs.get(targetTab.id);
    } catch {
      await chrome.storage.local.remove(`job:${payload.jobId}`);
      throw new Error(`${config.name} 标签页已关闭，上传缓存已经清理`);
    }
  } catch (error) {
    await chrome.storage.local.remove(`job:${payload.jobId}`);
    await chrome.alarms.clear(`bscg-job-expire:${payload.jobId}`);
    throw error;
  }
  // 总结已送达（AI 页已打开）：源页的实时字幕链路完成使命，自动停止并回收。
  // 字幕文件模式（destination:'file'）不受影响，结果留在页面可继续查看/导出。
  const sourceLiveSession = liveCaptures.get(tabId);
  if (sourceLiveSession && !sourceLiveSession.stopRequested) void requestLiveStop(tabId);
  return { ok: true, rows: result.rows, source: result.sourceLabel, destination: message.destination, reused: Boolean(message.reused) };
}

async function launchLocalTranscription({ taskId, tabId, message, settings, view, page, control }) {
  const taskKey = `task:${taskId}`;
  if (control.cancelled) throw new Error('源视频标签页已经关闭');
  await chrome.storage.local.set({ [taskKey]: {
    taskId,
    sourceTabId: tabId,
    status: 'running',
    bvid: view.bvid,
    cid: String(page.cid),
    mediaKey: control.mediaKey,
    documentId: control.documentId,
    title: view.title,
    createdAt: Date.now()
  } });
  if (control.cancelled) throw new Error('源视频标签页已经关闭');
  await progress(tabId, '后台任务已启动，正在取得视频音轨…');
  const audioCandidates = await resolveBilibiliAudioCandidates(tabId, view.bvid, page.cid, {
    expectedDuration: Number(page.duration) || 0
  });
  const audioUrl = audioCandidates[0]?.url || '';
  if (!audioUrl) {
    throw new Error('播放器与 playurl 均未返回可读音轨；可能是登录/大会员、付费、地区或 DRM 限制，也可能需要先播放几秒让播放器完成授权');
  }
  if (control.cancelled) throw new Error('源视频标签页已经关闭');

  // 在消息事件返回前建立浏览器转写通道，页面切后台后任务仍由离屏文档继续。
  const transport = transcribeTransport(settings);
  const streamedSegments = [];
  control.streamedSegments = streamedSegments; // 同视频的字幕会话可实时借用显示
  const inferencePromise = transport.start(transport.payload({
    audioUrl,
    referer: message.url,
    tabId,
    title: view.title,
    sourceUrl: message.url,
    expectedDuration: Number(page.duration) || 0,
    mediaKey: control.mediaKey,
    documentId: control.documentId,
    jobId: taskId,
    directSource: {
      platform: 'bilibili',
      videoId: view.bvid,
      partId: String(page.cid),
      duration: Number(page.duration) || 0,
      referer: message.url,
      candidates: audioCandidates
    }
  }), (event) => {
    if (event.type === 'segments_reset') streamedSegments.length = 0;
    else if (event.type === 'segment' && event.segment?.content) {
      streamedSegments.push(event.segment);
      control.onSegment?.(event.segment); // 有字幕会话借用本任务时实时转发
    }
    else void progress(tabId, event.text || '本地转写中…');
  }, control);

  const task = (async () => {
    try {
      const inferenceResult = await inferencePromise;
      if (control.cancelled) throw new Error('源视频标签页已经关闭');
      const result = await createResult({
        tabId,
        title: view.title,
        part: page.part,
        sourceUrl: message.url,
        pageUrl: message.url,
        bvid: view.bvid,
        cid: page.cid,
        mediaKey: control.mediaKey,
        documentId: control.documentId,
        mediaDuration: Number(page.duration) || 0,
        settings,
        label: transport.label,
        rows: streamedSegments.length ? streamedSegments : inferenceResult.segments || []
      });
      if (control.cancelled) throw new Error('源视频标签页已经关闭');
      await deliverToDestination({
        tabId,
        message: { ...message, destination: control.deliveryIntent || message.destination },
        settings,
        result
      });
    } catch (error) {
      const text = error?.message || String(error);
      if (!control.cancelled) await progress(tabId, `后台转写失败：${text}`, 'error');
    } finally {
      await releaseTranscriptionTask(control, taskKey);
    }
  })();
  control.promise = task;
}

async function launchYouTubeLocalTranscription({ taskId, tabId, message, settings, playerState, control }) {
  const taskKey = `task:${taskId}`;
  if (control.cancelled) throw new Error('源视频标签页已经关闭');
  const transport = transcribeTransport(settings);
  // 优先使用播放器或 webRequest 观察到的原始已签名 GoogleVideo 音轨。
  const replayCandidates = youTubeReplayCandidates(playerState);
  const audioUrl = replayCandidates[0]?.url || '';
  await chrome.storage.local.set({ [taskKey]: {
    taskId,
    sourceTabId: tabId,
    status: 'running',
    platform: 'youtube',
    videoId: message.videoId,
    mediaKey: control.mediaKey,
    documentId: control.documentId,
    title: playerState.title,
    createdAt: Date.now()
  } });
  if (control.cancelled) throw new Error('源视频标签页已经关闭');
  await progress(tabId, '后台任务已启动，正在取得 YouTube 音轨…');
  if (control.cancelled) throw new Error('完整转写任务已取消');
  const streamedSegments = [];
  control.streamedSegments = streamedSegments; // 同视频的字幕会话可实时借用显示
  const inferencePromise = transport.start(transport.payload({
    audioUrl,
    expectedDuration: Number(playerState.lengthSeconds) || 0,
    tabId,
    title: playerState.title,
    sourceUrl: message.url,
    mediaKey: control.mediaKey,
    documentId: control.documentId,
    jobId: taskId,
    forceScan: !audioUrl,
    directSource: {
      platform: 'youtube',
      videoId: message.videoId,
      partId: message.videoId,
      duration: Number(playerState.lengthSeconds) || 0,
      candidates: replayCandidates
    }
  }), (event) => {
    if (event.type === 'segments_reset') streamedSegments.length = 0;
    else if (event.type === 'segment' && event.segment?.content) {
      streamedSegments.push(event.segment);
      control.onSegment?.(event.segment); // 有字幕会话借用本任务时实时转发
    }
    else void progress(tabId, event.text || '本地转写中…');
  }, control);

  const task = (async () => {
    try {
      const inferenceResult = await inferencePromise;
      if (control.cancelled) throw new Error('源视频标签页已经关闭');
      const result = await createResult({
        tabId,
        title: playerState.title,
        sourceUrl: message.url,
        pageUrl: message.url,
        platform: 'youtube',
        videoId: message.videoId,
        partId: message.videoId,
        mediaKey: control.mediaKey,
        documentId: control.documentId,
        mediaDuration: Number(playerState.lengthSeconds) || 0,
        settings,
        label: transport.label,
        rows: streamedSegments.length ? streamedSegments : inferenceResult.segments || []
      });
      if (control.cancelled) throw new Error('源视频标签页已经关闭');
      await deliverToDestination({ tabId, message: { ...message, destination: control.deliveryIntent || message.destination }, settings, result });
    } catch (error) {
      const text = error?.message || String(error);
      if (!control.cancelled) await progress(tabId, `后台转写失败：${text}`, 'error');
    } finally {
      await releaseTranscriptionTask(control, taskKey);
    }
  })();
  control.promise = task;
}

function assertBilibiliPlayerSelection(state, bvid, cid, initialHref) {
  const currentCid = state.playurlCid || state.initialCid;
  const partNumber = (href) => Math.max(1, Number(new URL(href).searchParams.get('p')) || 1);
  if (state.urlBvid !== bvid || (currentCid && String(currentCid) !== String(cid)) ||
      partNumber(state.href) !== partNumber(initialHref)) {
    throw new Error('字幕读取期间视频或分P发生变化，已取消任务，请在当前视频重新点击总结');
  }
}

async function startBilibiliExtraction(message, tab) {
  throwIfExtractionCancelled(message);
  if (message.destination !== 'file' && !DESTINATIONS[message.destination]) throw new Error('没有选择有效的发送目标');
  if (!tab?.id) throw new Error('无法识别当前标签页');
  if (!String(tab.url || '').includes(`/video/${message.bvid}`)) throw new Error('页面已经切换到其他视频，已取消任务');
  const tabId = tab.id;
  await cleanupJobCache(false);
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  await progress(tabId, '正在读取视频信息…');
  const playerState = await getCurrentPlayerState(tabId, message.bvid);
  const lockedCid = message.allowLocalTranscription
    ? message.expectedCid
    : playerState.playurlCid || playerState.initialCid;
  if (message.allowLocalTranscription && !lockedCid) throw new Error('确认任务缺少锁定的 CID，已拒绝转写');
  const { view, page } = await getVideoInfo(message.bvid, message.pageNumber || 1, lockedCid || null);
  throwIfExtractionCancelled(message);
  if (view.bvid !== message.bvid) throw new Error('视频身份校验失败，请刷新页面后重试');
  assertBilibiliPlayerSelection(playerState, message.bvid, page.cid, playerState.href);

  // CC 字幕优先级永远最高：总结/生成字幕文件时先读 B站 CC 字幕，读到了就直接用。
  await progress(tabId, '正在读取 B站字幕…');
  const ccExtracted = await extractRemoteRows(tabId, message.bvid, view, page).catch((error) => {
    pushLog('error', `[bilibili] 读取 CC 字幕失败：${error?.message || error}`);
    return null;
  });
  throwIfExtractionCancelled(message);
  // Subtitle controls may be absent, hidden or recreated even when the API
  // returns a valid track. Guard media identity for both CC and local fallback.
  const finalState = await getCurrentPlayerState(tabId, message.bvid);
  assertBilibiliPlayerSelection(finalState, message.bvid, page.cid, playerState.href);
  throwIfExtractionCancelled(message);
  if (ccExtracted) {
    const result = await createResult({
      tabId,
      title: view.title,
      part: page.part,
      sourceUrl: message.url,
      pageUrl: message.url,
      bvid: view.bvid,
      cid: page.cid,
      label: ccExtracted.label,
      mediaDuration: Number(page.duration) || 0,
      rows: ccExtracted.rows
    });
    return deliverToDestination({ tabId, message, settings, result });
  }

  const cached = await findCachedResult(tabId, view.bvid, page.cid, page.duration);
  throwIfExtractionCancelled(message);
  if (cached) {
    return deliverToDestination({ tabId, message: { ...message, reused: true }, settings, result: cached });
  }
  await progress(tabId, '当前视频没有 CC 字幕，改用本地识别…');

  if (message.allowLocalTranscription) {
    if (String(message.expectedCid) !== String(page.cid)) {
      throw new Error('确认后视频已发生变化，已取消转写');
    }
    const mediaKey = buildMediaKey({ platform: 'bilibili', pageUrl: message.url, videoId: view.bvid, partId: String(page.cid) });
    const existingTask = findTabTranscription(tabId);
    if (existingTask && existingTask.mediaKey === mediaKey) {
      // 用户最近的选择为准：同一视频的完整转写已在进行，不重复起进程，
      // 只把最终交付意图（总结目标 / 字幕文件）更新为最新选择。
      existingTask.deliveryIntent = message.destination;
      return acceptedTranscriptionResponse(existingTask, view.title, true);
    }
    ensureTaskSlot();
    const taskId = crypto.randomUUID();
    const control = {
      taskId, tabId, cancelled: false, abort: null, promise: null, deliveryIntent: message.destination,
      requestId: String(message.requestId || ''),
      sourceUrl: message.url,
      sourcePlatform: 'bilibili',
      sourceVideoId: view.bvid,
      sourcePartId: String(page.cid),
      mediaKey,
      documentId: currentDocumentId(tabId, message.documentId),
      engineLabel: localEngineLabel(settings)
    };
    activeTranscriptions.set(taskId, control);
    try {
      await launchLocalTranscription({ taskId, tabId, message, settings, view, page, control });
    } catch (error) {
      activeTranscriptions.delete(taskId);
      await chrome.storage.local.remove(`task:${taskId}`);
      throw error;
    }
    return acceptedTranscriptionResponse(control, view.title);
  }

  // Return the locked CID to the existing one-click summary flow, which
  // immediately retries with local transcription enabled for this same part.
  return { ok: true, needsLocalConfirm: true, bvid: view.bvid, cid: page.cid, title: view.title };
}

async function startYouTubeExtraction(message, tab) {
  throwIfExtractionCancelled(message);
  if (message.destination !== 'file' && !DESTINATIONS[message.destination]) throw new Error('没有选择有效的发送目标');
  if (!tab?.id) throw new Error('无法识别当前标签页');
  const tabUrl = new URL(tab.url || 'https://invalid.local/');
  const tabVideoId = tabUrl.searchParams.get('v') || tabUrl.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
  if (!message.videoId || tabVideoId !== message.videoId) throw new Error('YouTube 页面已经切换到其他视频，已取消任务');
  const tabId = tab.id;
  await cleanupJobCache(false);
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  await progress(tabId, '正在读取 YouTube 视频和字幕信息…');
  const playerState = await getYouTubePlayerState(tabId, message.videoId);
  throwIfExtractionCancelled(message);

  // 与 B站一致：平台 CC 永远优先于缓存与本地转写。
  const extracted = await extractYouTubeRows(playerState, settings.language).catch((error) => {
    pushLog('error', `[youtube] 读取 CC 字幕失败：${error?.message || error}`);
    return null;
  });
  throwIfExtractionCancelled(message);
  if (extracted) {
    const finalState = await getYouTubePlayerState(tabId, message.videoId);
    if (finalState.responseVideoId !== message.videoId) throw new Error('字幕读取期间 YouTube 播放器发生变化，已拒绝上传');
    const result = await createResult({
      tabId,
      title: playerState.title,
      sourceUrl: message.url,
      pageUrl: message.url,
      platform: 'youtube',
      videoId: message.videoId,
      partId: message.videoId,
      label: extracted.label,
      mediaDuration: Number(playerState.lengthSeconds) || 0,
      rows: extracted.rows
    });
    return deliverToDestination({ tabId, message, settings, result });
  }

  const cached = await findCachedResult(tabId, message.videoId, message.videoId, playerState.lengthSeconds);
  throwIfExtractionCancelled(message);
  if (cached) return deliverToDestination({ tabId, message: { ...message, reused: true }, settings, result: cached });

  if (message.allowLocalTranscription) {
    if (message.expectedVideoId !== message.videoId || playerState.responseVideoId !== message.videoId) {
      throw new Error('确认后 YouTube 视频已经变化，已取消转写');
    }
    const mediaKey = buildMediaKey({ platform: 'youtube', pageUrl: message.url, videoId: message.videoId, partId: message.videoId });
    const existingTask = findTabTranscription(tabId);
    if (existingTask && existingTask.mediaKey === mediaKey) {
      existingTask.deliveryIntent = message.destination;
      return acceptedTranscriptionResponse(existingTask, playerState.title, true);
    }
    ensureTaskSlot();
    const taskId = crypto.randomUUID();
    const control = {
      taskId, tabId, cancelled: false, abort: null, promise: null, deliveryIntent: message.destination,
      requestId: String(message.requestId || ''),
      sourceUrl: message.url,
      sourcePlatform: 'youtube',
      sourceVideoId: message.videoId,
      sourcePartId: message.videoId,
      mediaKey,
      documentId: currentDocumentId(tabId, message.documentId),
      engineLabel: localEngineLabel(settings)
    };
    activeTranscriptions.set(taskId, control);
    try {
      await launchYouTubeLocalTranscription({ taskId, tabId, message, settings, playerState, control });
    } catch (error) {
      activeTranscriptions.delete(taskId);
      await chrome.storage.local.remove(`task:${taskId}`);
      throw error;
    }
    return acceptedTranscriptionResponse(control, playerState.title);
  }

  // 没有平台 CC 且用户尚未确认本地转写：让页面弹确认。
  await progress(tabId, '当前 YouTube 视频没有检测到字幕。');
  return { ok: true, needsLocalConfirm: true, videoId: message.videoId, title: playerState.title };
}

async function sourceHash(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

async function extractStandardTextTracks(tabId, expectedUrl) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    injectImmediately: true,
    args: [expectedUrl],
    func: async (lockedUrl) => {
      if (location.href !== lockedUrl) throw new Error('页面地址已经变化');
      const media = [...document.querySelectorAll('video, audio')].sort((a, b) => {
        const area = (element) => (element.getBoundingClientRect().width || 0) * (element.getBoundingClientRect().height || 0);
        return Number(!b.paused) - Number(!a.paused) || area(b) - area(a);
      })[0];
      if (!media) return { href: location.href, title: document.title, tracks: [] };
      const candidates = [...media.textTracks].filter((track) => ['captions', 'subtitles'].includes(track.kind));
      const previousModes = candidates.map((track) => track.mode);
      candidates.forEach((track) => { if (track.mode === 'disabled') track.mode = 'hidden'; });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const tracks = candidates.map((track) => {
        let cues = [];
        try {
          cues = [...(track.cues || [])].map((cue) => ({
            from: Number(cue.startTime) || 0,
            to: Number(cue.endTime) || Number(cue.startTime) || 0,
            content: String(cue.text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
          })).filter((cue) => cue.content);
        } catch {}
        return { language: track.language || '', label: track.label || track.language || '网页字幕', cues };
      });
      candidates.forEach((track, index) => { track.mode = previousModes[index]; });
      return { href: location.href, title: document.title, tracks };
    }
  });
  const value = results?.[0]?.result;
  if (!value || value.href !== expectedUrl) throw new Error('读取字幕时页面已经变化，请重试');
  return value;
}

async function extractCurrentTab(tabId, message = {}) {
  throwIfExtractionCancelled(message);
  const tab = await chrome.tabs.get(tabId);
  throwIfExtractionCancelled(message);
  if (!tab.url && message.pageUrl) tab.url = message.pageUrl;
  const url = new URL(tab.url || 'https://invalid.local/');
  const destination = message.destination;
  if (url.hostname === 'live.bilibili.com') {
    throw new Error('直播页面请使用“字幕”开启实时识别；本次定稿可在菜单中导出 SRT');
  }
  if (url.hostname === 'www.bilibili.com') {
    const bvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1];
    if (!bvid) throw new Error('当前页面不是 B站视频');
    return startBilibiliExtraction({
      platform: 'bilibili', destination, bvid,
      pageNumber: Math.max(1, Number(url.searchParams.get('p')) || 1),
      url: tab.url, title: tab.title,
      requestId: message.requestId,
      documentId: message.documentId,
      allowLocalTranscription: Boolean(message.allowLocalTranscription),
      expectedCid: message.expectedCid
    }, tab);
  }
  if (/(^|\.)youtube\.com$/i.test(url.hostname)) {
    const videoId = url.searchParams.get('v') || url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
    if (!videoId) throw new Error('当前页面不是 YouTube 视频');
    return startYouTubeExtraction({
      platform: 'youtube', destination, videoId,
      url: tab.url, title: tab.title,
      requestId: message.requestId,
      documentId: message.documentId,
      allowLocalTranscription: Boolean(message.allowLocalTranscription),
      expectedVideoId: message.expectedVideoId
    }, tab);
  }

  // 任意网页：先读网页 CC 字幕，再找缓存；都没有时走当前选中的本地 ASR。
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  const identity = await sourceHash(tab.url);
  const extracted = await extractStandardTextTracks(tabId, tab.url);
  throwIfExtractionCancelled(message);
  const wanted = settings.language === 'auto' ? '' : settings.language.toLowerCase();
  const selected = (wanted && extracted.tracks.find((track) => String(track.language).toLowerCase().startsWith(wanted))) ||
    extracted.tracks.find((track) => track.cues.length) || null;
  if (selected?.cues?.length) {
    const result = await createResult({
      tabId,
      title: extracted.title,
      sourceUrl: tab.url,
      pageUrl: tab.url,
      platform: 'web',
      videoId: identity,
      partId: identity,
      label: `网页 CC 字幕${selected.label ? `（${selected.label}）` : ''}`,
      mediaDuration: Math.max(0, ...selected.cues.map((cue) => Number(cue.to) || 0)),
      rows: selected.cues
    });
    return deliverToDestination({ tabId, message: { ...message, destination }, settings, result });
  }
  const cached = await findCachedResult(tabId, identity, identity, extracted.duration);
  throwIfExtractionCancelled(message);
  if (cached) return deliverToDestination({ tabId, message: { ...message, destination, reused: true }, settings, result: cached });

  if (message.allowLocalTranscription) {
    const mediaKey = buildMediaKey({ platform: 'web', pageUrl: tab.url, videoId: identity, partId: identity });
    const existingTask = findTabTranscription(tabId);
    if (existingTask && existingTask.mediaKey === mediaKey) {
      existingTask.deliveryIntent = message.destination;
      return acceptedTranscriptionResponse(existingTask, extracted.title, true);
    }
    ensureTaskSlot();
    const taskId = crypto.randomUUID();
    const control = {
      taskId, tabId, cancelled: false, abort: null, promise: null, deliveryIntent: message.destination,
      requestId: String(message.requestId || ''),
      sourceUrl: tab.url,
      sourcePlatform: 'web',
      sourceVideoId: identity,
      sourcePartId: identity,
      mediaKey,
      documentId: currentDocumentId(tabId, message.documentId),
      engineLabel: localEngineLabel(settings)
    };
    activeTranscriptions.set(taskId, control);
    try {
      await launchWebLocalTranscription({ taskId, tabId, message: { ...message, url: tab.url, title: extracted.title }, settings, control });
    } catch (error) {
      activeTranscriptions.delete(taskId);
      await chrome.storage.local.remove(`task:${taskId}`);
      throw error;
    }
    return acceptedTranscriptionResponse(control, extracted.title);
  }
  await progress(tabId, '当前网页没有检测到 CC 字幕。');
  return { ok: true, needsLocalConfirm: true, title: extracted.title };
}

async function launchWebLocalTranscription({ taskId, tabId, message, settings, control }) {
  const taskKey = `task:${taskId}`;
  if (control.cancelled) throw new Error('源视频标签页已经关闭');
  await chrome.storage.local.set({ [taskKey]: {
    taskId,
    sourceTabId: tabId,
    status: 'running',
    platform: 'web',
    mediaKey: control.mediaKey,
    documentId: control.documentId,
    title: message.title || tabTitle(tabId),
    createdAt: Date.now()
  } });
  if (control.cancelled) throw new Error('源视频标签页已经关闭');
  await progress(tabId, '后台任务已启动，正在锁定网页音轨…');
  const transport = transcribeTransport(settings);
  // 只使用页面播放器数据与浏览器已经观察到的媒体请求。
  let generic = await getGenericMediaSource(tabId);
  const observed = (await getObservedMediaRecords(tabId)).slice().reverse();
  if (message.localFileToken) {
    generic = { mediaUrl: `bscg-local:${message.localFileToken}`, duration: Number(generic?.duration) || 0, title: generic?.title || message.title || '' };
  }
  const browserCandidates = [];
  const addBrowserCandidate = (url, kind, frameId = 0, extra = {}) => {
    if (!url || browserCandidates.some((candidate) => candidate.url === url)) return;
    browserCandidates.push({ url, kind, frameId: Math.max(0, Number(frameId) || 0), ...extra });
  };
  if (message.localFileToken) {
    addBrowserCandidate(`bscg-local:${message.localFileToken}`, 'local-upload', 0, { token: message.localFileToken });
  } else {
    browserCandidates.push(...genericReplayCandidates(generic, observed));
  }
  const audioUrl = browserCandidates[0]?.url || '';
  if (control.cancelled) throw new Error('源视频标签页已经关闭');

  // 与 B站/YouTube 一致：消息事件返回前建立转写通道，页面切后台也继续转写。
  const streamedSegments = [];
  control.streamedSegments = streamedSegments; // 同视频的字幕会话可实时借用显示
  const inferencePromise = transport.start(transport.payload({
    audioUrl,
    expectedDuration: Number(generic?.duration) || 0,
    tabId,
    title: message.title || generic?.title || '网页视频',
    sourceUrl: message.url,
    mediaKey: control.mediaKey,
    documentId: control.documentId,
    jobId: taskId,
    localFileToken: message.localFileToken || '',
    forceScan: !browserCandidates.length,
    directSource: {
      platform: /^file:/i.test(message.url || '') ? 'local' : 'web',
      duration: Number(generic?.duration) || 0,
      playerMediaSrc: generic?.mediaSrc || '', frameId: Number(generic?.frameId) || 0,
      candidates: browserCandidates
    }
  }), (event) => {
    if (event.type === 'segments_reset') streamedSegments.length = 0;
    else if (event.type === 'segment' && event.segment?.content) {
      streamedSegments.push(event.segment);
      control.onSegment?.(event.segment); // 有字幕会话借用本任务时实时转发
    }
    else void progress(tabId, event.text || '本地转写中…');
  }, control);

  const task = (async () => {
    try {
      const inferenceResult = await inferencePromise;
      if (control.cancelled) throw new Error('源视频标签页已经关闭');
      const result = await createResult({
        tabId,
        title: message.title || generic?.title || '网页视频',
        sourceUrl: message.url,
        pageUrl: message.url,
        platform: 'web',
        videoId: control.sourceVideoId,
        partId: control.sourcePartId,
        mediaKey: control.mediaKey,
        documentId: control.documentId,
        settings,
        label: transport.label,
        mediaDuration: Number(generic?.duration) || 0,
        rows: streamedSegments.length ? streamedSegments : inferenceResult.segments || []
      });
      if (control.cancelled) throw new Error('源视频标签页已经关闭');
      await deliverToDestination({ tabId, message: { ...message, destination: control.deliveryIntent || message.destination }, settings, result });
    } catch (error) {
      const text = error?.message || String(error);
      if (!control.cancelled) await progress(tabId, `后台转写失败：${text}`, 'error');
    } finally {
      await releaseTranscriptionTask(control, taskKey);
    }
  })();
  control.promise = task;
}

async function tabTitle(tabId) {
  try { return (await chrome.tabs.get(tabId)).title || '网页视频'; } catch { return '网页视频'; }
}

async function sendLive(tabId, message) {
  if (!tabId) return;
  // A stored summary transcript is available for export, but does not itself
  // express an intent to turn captions on (including after page hydration).
  if (message.type === 'BSCG_FILE_RESULT' && !captionDisplayByTab.has(tabId)) {
    captionDisplayByTab.set(tabId, { visible: false, documentId: currentDocumentId(tabId) });
  }
  if (message.type === 'BSCG_LIVE_STARTED' || message.type === 'BSCG_LIVE_REUSED') {
    message = { ...message, captionVisibility: captionDisplayByTab.get(tabId)?.visible };
  }
  try { await chrome.tabs.sendMessage(tabId, message); } catch {}
}

async function setCaptionDisplay(tabId, visible, message = {}) {
  if (!tabId) return { ok: true, ignored: true };
  const state = { visible: Boolean(visible), documentId: currentDocumentId(tabId) };
  captionDisplayByTab.set(tabId, state);
  const display = {
    type: 'BSCG_CAPTIONS_VISIBILITY', visible: state.visible,
    fromControls: Boolean(message.fromControls)
  };
  // Redisplay the page's retained VOD rows without creating a download/ASR job.
  if (state.visible && message.mode === 'file' && !liveCaptures.has(tabId)) {
    display.mode = 'file';
    display.sessionId = String(message.sessionId || '');
    display.segments = (Array.isArray(message.segments) ? message.segments : []).slice(-MAX_LIVE_ROWS)
      .filter((row) => Number.isFinite(row?.from) && Number.isFinite(row?.to) && row.to > row.from)
      .map((row) => ({ from: Math.max(0, row.from), to: row.to, content: cleanDisplayCaption(row.content) }))
      .filter((row) => row.content);
  }
  await sendLive(tabId, display);
  return { ok: true };
}

async function showRetainedCaptions(tabId, message) {
  await setCaptionDisplay(tabId, true, message);
  if (message.mode !== 'file' || liveCaptures.has(tabId) || !message.segments?.length) return { ok: true };
  const tab = await chrome.tabs.get(tabId);
  const pageUrl = tab.url || message.pageUrl;
  if (message.pageUrl && videoTranslationIdentity(message.pageUrl) !== videoTranslationIdentity(pageUrl)) {
    return { ok: false, error: '视频已切换，请重新开启字幕' };
  }
  const settings = await settingsForVideo(tabId, pageUrl, { ...DEFAULTS,
    ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });
  const cached = await latestResultForTab(tabId, pageUrl).catch(() => null);
  const rows = cached?.originalSegments || message.segments.slice(-MAX_LIVE_ROWS)
    .filter(row => Number.isFinite(row?.from) && Number.isFinite(row?.to) && row.to > row.from)
    .map(row => ({ from: row.from, to: row.to,
      content: cleanDisplayCaption(row.originalContent || row.sourceContent || row.content) }));
  return startCachedCaptionSession({ ...tab, url: pageUrl }, settings, rows);
}

async function getVideoClock(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: 'MAIN', func: bscgFindMedia
  });
  return results?.map((item) => item.result).filter(Boolean).sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0] ||
    { currentTime: 0, duration: 0, paused: true, playbackRate: 1, score: 0 };
}

function queueLiveMessage(session, message) {
  if (!session) return Promise.resolve();
  const preview = message.type === 'BSCG_LIVE_PREVIEW';
  if (preview) {
    session.pendingPreviewMessage = message;
    if (session.previewMessageScheduled) return session.liveMessageChain || Promise.resolve();
    session.previewMessageScheduled = true;
  } else if (message.type === 'BSCG_LIVE_FINAL' &&
      session.pendingPreviewMessage?.previewId === message.segment?.id) {
    session.pendingPreviewMessage = null;
  }
  const previous = session.liveMessageChain || Promise.resolve();
  const next = previous.catch(() => {}).then(() => {
    const outgoing = preview ? session.pendingPreviewMessage : message;
    if (preview) { session.pendingPreviewMessage = null; session.previewMessageScheduled = false; }
    if (!outgoing) return;
    if (liveCaptures.get(session.tabId) !== session) return;
    if (outgoing.segment && session.settings) {
      const config = translateActiveConfig(session.settings);
      if (config.enabled && config.displayMode === 'translated' && !outgoing.segment.translationVerified) {
        pushLog('warn', `[translate/display] 已拦截未验证的 ${outgoing.type} 字幕`);
        return;
      }
    }
    return sendLive(session.tabId, { ...outgoing, sessionId: session.sessionId });
  });
  session.liveMessageChain = next;
  return next;
}

async function findVideoFrame(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: 'MAIN', func: bscgFindMedia
  });
  return results.filter((entry) => entry.result).sort((a, b) => Number(b.result.score) - Number(a.result.score))[0] || null;
}

// Subtitle generation never owns the media element. Summary scanning uses its
// separate, explicitly requested BSCG_SCAN_* controller.
function controlBrowserLiveMedia(_session, _action) {
  return Promise.resolve();
}

function findLiveSession(sessionId) {
  for (const session of liveCaptures.values()) {
    if (session.sessionId === sessionId) return session;
  }
  return null;
}

async function pageFetchInTab(tabId, url, requestId, maxBytes, frameId = 0) {
  if (!Number.isInteger(tabId) || tabId < 0 || !/^https?:/i.test(url)) throw new Error('页面音轨代理参数无效');
  const armed = await chrome.tabs.sendMessage(tabId, { type: 'BILI_ASR_PAGE_FETCH_ARM', requestId }, { frameId }).catch(() => null);
  if (!armed?.ok) throw new Error('页面音轨代理未就绪；请刷新视频页面后重试');
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    injectImmediately: true,
    args: [url, requestId, Math.max(1, Number(maxBytes) || 536870912)],
    func: pageFetchMediaInPage
  });
  const result = results?.[0]?.result;
  if (!result?.ok) throw new Error(result?.error || '页面音轨代理失败');
  return result;
}

// Serialized into the selected player's MAIN world; keep this self-contained.
async function pageFetchMediaInPage(audioUrl, id, limit) {
  window.__BSCG_PAGE_FETCH_CONTROLLERS__ ||= new Map();
  const controller = new AbortController();
  window.__BSCG_PAGE_FETCH_CONTROLLERS__.set(id, controller);
  let stallTimer = null;
  let phase = '等待响应头';
  let received = 0;
  let stallMs = 20000;
  const touch = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort('audio-fetch-stalled'), stallMs);
  };
  const emit = (payload) => window.postMessage({ marker: 'BROWSER_SENSEVOICE_PAGE_FETCH_V1', requestId: id, ...payload }, '*');
  const toBase64 = (bytes) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
    }
    return btoa(binary);
  };
  try {
    let loaded = 0;
    let total = 0;
    let contentType = '';
    // HLS CDNs commonly allow the page Origin but not credentialed CORS.
    // Same-origin preserves local cookies without requiring ACAC remotely.
    // Retry cookie authentication only before reading any response bytes.
    const origin = new URL(audioUrl).origin;
    const page = location.href;
    window.__BSCG_PAGE_FETCH_CREDENTIALS__ ||= new Map();
    const modes = window.__BSCG_PAGE_FETCH_CREDENTIALS__;
    const remembered = modes.get(origin);
    let credentials = remembered?.page === page ? remembered.mode : 'same-origin';
    for (let requestIndex = 0; requestIndex < 512; requestIndex += 1) {
      let response;
      const failures = [];
      for (const mode of [credentials, credentials === 'include' ? 'same-origin' : 'include']) {
        if (controller.signal.aborted) throw new Error('页面音轨请求已取消');
        phase = '等待响应头'; stallMs = 20000;
        emit({ type: 'progress', loaded, phase });
        touch();
        try {
          response = await fetch(audioUrl, {
            credentials: mode, cache: 'no-store', redirect: 'follow',
            headers: loaded ? { Range: `bytes=${loaded}-` } : undefined,
            signal: controller.signal
          });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          failures.push(`${mode}: ${error?.message || String(error)}`);
          continue;
        }
        if (response.ok) { credentials = mode; break; }
        const status = response.status;
        void response.body?.cancel().catch(() => {});
        response = null;
        failures.push(`${mode}: HTTP ${status}`);
        if (status !== 401 && status !== 403) break;
      }
      if (!response?.ok) throw new Error(`页面读取失败（${failures.join('；')}）`);
      modes.set(origin, { page, mode: credentials });
      while (modes.size > 64) modes.delete(modes.keys().next().value);
      phase = '读取响应体'; stallMs = 15000;
      touch();
      const contentRange = response.headers.get('content-range') || '';
      const range = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
      if (response.status === 206 && !range) throw new Error('CDN 返回无法证明完整性的 206 局部响应');
      if (range && Number(range[1]) !== loaded) throw new Error(`CDN 分段不连续：${contentRange}`);
      if (!range && loaded) throw new Error('CDN 忽略续传 Range，无法证明音轨连续');
      total = Math.max(total, range ? Number(range[3]) : Number(response.headers.get('content-length')) || 0);
      if (total > limit) throw new Error(`音轨超过 ${limit} 字节限制`);
      contentType ||= response.headers.get('content-type') || '';
      if (requestIndex === 0) emit({ type: 'start', total, contentType });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('页面 fetch 没有可读响应体');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        loaded += value.byteLength;
        received = loaded;
        if (loaded > limit) { await reader.cancel(); throw new Error(`音轨超过 ${limit} 字节限制`); }
        for (let offset = 0; offset < value.length; offset += 262144) {
          emit({ type: 'chunk', data: toBase64(value.subarray(offset, Math.min(value.length, offset + 262144))), loaded, total });
        }
      }
      if (range && loaded !== Number(range[2]) + 1) throw new Error(`CDN 分段长度与 Content-Range 不符：${contentRange}`);
      if (!range || loaded >= total) {
        emit({ type: 'end', loaded, total, contentType });
        return { ok: true, loaded };
      }
    }
    throw new Error('CDN 音轨分段超过 512 次安全限制');
  } catch (error) {
    const text = controller.signal.reason === 'audio-fetch-stalled'
      ? `页面音轨超时：${phase}连续 ${stallMs / 1000} 秒无数据（已收 ${received} 字节）`
      : error?.message || String(error);
    emit({ type: 'error', error: text });
    return { ok: false, error: text };
  } finally {
    clearTimeout(stallTimer);
    if (!controller.signal.aborted) controller.abort('page-fetch-finished');
    if (window.__BSCG_PAGE_FETCH_CONTROLLERS__.get(id) === controller) {
      window.__BSCG_PAGE_FETCH_CONTROLLERS__.delete(id);
    }
  }
}

async function pageFetchCancelInTab(tabId, requestId, frameId = 0) {
  if (!Number.isInteger(tabId) || tabId < 0 || !requestId) return { ok: true, idle: true };
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    injectImmediately: true,
    args: [requestId],
    func: (id) => {
      const controller = window.__BSCG_PAGE_FETCH_CONTROLLERS__?.get(id);
      if (!controller) return false;
      controller.abort('session-stopped');
      window.__BSCG_PAGE_FETCH_CONTROLLERS__.delete(id);
      return true;
    }
  }).catch(() => []);
  return { ok: true, cancelled: Boolean(results?.[0]?.result) };
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl] });
  if (contexts.length) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'WORKERS'],
      justification: '读取当前视频音轨或捕获标签页声音，并在独立 Worker 中运行浏览器内 Qwen3-ASR 或 SenseVoice。'
    }).finally(() => { creatingOffscreenDocument = null; });
  }
  await creatingOffscreenDocument;
}

// offscreen 文档可能因浏览器回收而消失（"Receiving end does not exist"）。
// 统一入口：先确保文档存在，再发消息；连接错误时重建文档并重试一次。
async function sendToOffscreen(message) {
  const readOnly = ['BILI_ASR_CAPABILITIES', 'BILI_ASR_GET_STATE', 'BILI_ASR_BENCHMARK_STATUS', 'BILI_ASR_MODEL_DOWNLOAD_STATUS', 'BILI_ASR_TRANSLATE_ONNX_STATUS'].includes(message.type);
  if (!readOnly) {
    if (offscreenCloseTimer) { clearTimeout(offscreenCloseTimer); offscreenCloseTimer = null; }
    await chrome.alarms.clear(OFFSCREEN_IDLE_ALARM);
  }
  await ensureOffscreenDocument();
  try {
    return await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  } catch (error) {
    const text = String(error?.message || error);
    if (!/Receiving end does not exist/i.test(text)) throw error;
    pushLog('warn', `[offscreen] 文档不可达，重建后重试：${message.type || message.action || ''}`);
    await ensureOffscreenDocument();
    return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  }
}

async function maybeCloseOffscreenDocument() {
  if (liveCaptures.size || browserEngineSessions.size || activeBrowserRequest || browserRequestQueue.length || activeBenchmarkId || activeModelDownloadId || creatingOffscreenDocument) return;
  if (!await chrome.alarms.get(OFFSCREEN_IDLE_ALARM)) {
    await chrome.alarms.create(OFFSCREEN_IDLE_ALARM, { delayInMinutes: 5 });
  }
}

async function closeIdleOffscreenDocument() {
  if (liveCaptures.size || browserEngineSessions.size || activeBrowserRequest || browserRequestQueue.length || activeBenchmarkId || activeModelDownloadId || creatingOffscreenDocument) return;
  // Read the offscreen owner's state: service-worker globals may have been lost
  // during suspension. A status read must not create a new offscreen document.
  const translation = await chrome.runtime.sendMessage({ type: 'BILI_ASR_TRANSLATE_ONNX_STATUS', target: 'offscreen' }).catch(() => null);
  if (translation?.busy) {
    await chrome.alarms.create(OFFSCREEN_IDLE_ALARM, { delayInMinutes: 5 });
    return;
  }
  const runtime = await chrome.runtime.sendMessage({ type: 'BILI_ASR_CAPABILITIES', target: 'offscreen' }).catch(() => null);
  if (!runtime) return;
  if (runtime.activeSession || runtime.initializing || runtime.benchmark?.status === 'running' || runtime.modelDownload?.status === 'running') {
    await chrome.alarms.create(OFFSCREEN_IDLE_ALARM, { delayInMinutes: 5 });
    return;
  }
  try { await chrome.offscreen.closeDocument(); } catch {}
}

async function injectLiveOverlay(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['media-discovery.js', 'capture-audio.js', 'universal.js'], injectImmediately: true });
}

function rememberCaptureClock(session, message) {
  const receivedAt = Date.now();
  const suppliedAt = Number(message.wallTime);
  const at = Number.isFinite(suppliedAt) && Math.abs(suppliedAt - receivedAt) <= 10000 ? suppliedAt : receivedAt;
  const sample = {
    at,
    currentTime: Math.max(0, Number(message.currentTime) || 0),
    playbackRate: Math.max(0.1, Number(message.playbackRate) || 1),
    paused: Boolean(message.paused)
  };
  session.clockHistory ||= [];
  const last = session.clockHistory.at(-1);
  if (last && at < last.at) return;
  if (last && at === last.at) session.clockHistory[session.clockHistory.length - 1] = sample;
  else session.clockHistory.push(sample);
  if (session.clockHistory.length > 80) session.clockHistory.splice(0, session.clockHistory.length - 80);
}

function finalizeLiveCapture(session, inferenceMessage) {
  if (session.finalizingPromise) return session.finalizingPromise;
  const result = finalizeLiveCaptureNow(session, inferenceMessage);
  session.finalizingPromise = result;
  return result;
}

async function finalizeLiveCaptureNow(session, inferenceMessage) {
  if (session.finished) return;
  // 前瞻字幕翻译：先把展示缓冲里最后一段落地并送翻，等翻译队列彻底清空后再读 rows，
  // 保证导出的 SRT、写入缓存与发去总结的文本同文同种（全是译文）。
  publishTranslatedCaptionSegment(session, null, true);
  let finishingTranslator;
  do {
    finishingTranslator = session.translator;
    if (finishingTranslator) await finishingTranslator.finish().catch(() => {});
  } while (session.translator !== finishingTranslator);
  const completionReason = String(inferenceMessage?.reason || inferenceMessage?.metrics?.completionReason || session.stopReason || 'unknown');
  pushLog('info', `[session] 任务收尾 tab=${session.tabId} mode=${session.mode} ` +
    `reason=${completionReason} 共 ${Array.isArray(session.rows) ? session.rows.length : 0} 段`);
  session.finished = true;
  if (session.stopTimer) clearTimeout(session.stopTimer);
  if (session.positionHeartbeat) clearInterval(session.positionHeartbeat);
  if (session.borrowWatch) clearInterval(session.borrowWatch);
  const rows = Array.isArray(session.rows) ? session.rows : inferenceMessage.segments || [];
  // 保留原文与翻译身份元数据供缓存回放；createResult 的文本导出只读取 content。
  const exportRows = rows;
  // 缓存策略：只有自然完成的会话（读到音轨末尾/收尾完整）才把结果写入缓存供
  // "总结"复用。用户手动点停的会话只覆盖了"已播放部分"，写进缓存后会被总结
  // 当成完整结果发送——这是"总结发了没生成完的字幕"的根因，改为不落缓存。
  const cacheableComplete = !session.translationFailures && !session.isLive && !session.stopRequested && session.fullTrack &&
    (session.mode === 'browser-direct' ? completionReason === 'direct-complete' :
      ['media-ended', 'stream-ended'].includes(completionReason) && !inferenceMessage?.metrics?.modelWarmupDropped &&
      !inferenceMessage?.metrics?.failedSegments && !inferenceMessage?.metrics?.captureSeeks &&
      Number.isFinite(inferenceMessage?.metrics?.firstCapturedVideoTime) && inferenceMessage.metrics.firstCapturedVideoTime <= 1);
  if (rows.length && !session.borrowTask && cacheableComplete) {
    const identity = session.sourceVideoId || await sourceHash(session.sourceUrl);
    await createResult({
      tabId: session.tabId,
      title: session.title,
      sourceUrl: session.sourceUrl,
      pageUrl: session.sourceUrl,
      platform: session.sourcePlatform || 'web',
      videoId: identity,
      partId: session.sourcePartId || identity,
      mediaKey: session.mediaKey,
      documentId: session.documentId,
      settings: session.settings,
      label: localEngineLabel(session.settings, true),
      mediaDuration: Number(session.mediaDuration) || 0,
      rows: exportRows,
      originalRows: session.originalCaptionRows ? [...session.originalCaptionRows.values()] : exportRows
    });
  } else if (rows.length && session.stopRequested) {
    pushLog('info', `[session] 手动停止：${rows.length} 段仅保留在页面预览/导出，不写入缓存（防止总结发送半成品）`);
  }
  if (session.backend === 'browser') await controlBrowserLiveMedia(session, 'resume').catch(() => {});
  releaseBorrowedTask(session);
  await queueLiveMessage(session, {
    type: 'BSCG_LIVE_STOPPED', rows: rows.length, reason: completionReason,
    keepVisible: !session.stopRequested && rows.length > 0
  });
  session.clockHistory = [];
  if (liveCaptures.get(session.tabId) === session) liveCaptures.delete(session.tabId);
  schedulePendingBrowserSettingsRestart();
  setTimeout(() => { void maybeCloseOffscreenDocument(); }, 300);
}

async function failLiveCapture(session, error) {
  if (!session || session.finished) return;
  session.translator?.cancel?.();
  pushLog('error', `[session] 任务失败 tab=${session.tabId} mode=${session.mode}：${error}`);
  session.finished = true;
  releaseBorrowedTask(session);
  if (session.stopTimer) clearTimeout(session.stopTimer);
  if (session.positionHeartbeat) clearInterval(session.positionHeartbeat);
  if (session.borrowWatch) clearInterval(session.borrowWatch);
  await queueLiveMessage(session, { type: 'BSCG_LIVE_ERROR', error });
  if (session.backend === 'browser') await controlBrowserLiveMedia(session, 'resume').catch(() => {});
  session.browserControl?.abort?.(error || '浏览器字幕任务已停止');
  session.clockHistory = [];
  if (liveCaptures.get(session.tabId) === session) liveCaptures.delete(session.tabId);
  schedulePendingBrowserSettingsRestart();
  setTimeout(() => { void maybeCloseOffscreenDocument(); }, 300);
}

async function abortLiveCapture(session, reason) {
  return failLiveCapture(session, reason);
}


// 借用进行中转写任务的分段：清洗并标记来源（borrow），让字幕会话立即显示已生成区域
function borrowedTaskRows(task) {
  const source = Array.isArray(task?.streamedSegments) ? task.streamedSegments : [];
  return source.map((row) => ({
    from: Math.max(0, Number(row.from) || 0),
    to: Math.max(Number(row.from) || 0, Number(row.to) || Number(row.from) || 0),
    content: cleanDisplayCaption(row.content),
    src: 'borrow'
  })).filter((row) => row.content).sort((a, b) => a.from - b.from);
}

// 字幕会话借用转写任务：后续分段随转写进度实时推进到会话与页面
function attachBorrowedTask(session, task) {
  if (!session || !task) return;
  session.borrowTask = task;
  task.onSegment = (segment) => {
    if (!session || session.finished || session.stopRequested) return;
    const normalized = {
      from: Math.max(0, Number(segment.from) || 0),
      to: Math.max(Number(segment.from) || 0, Number(segment.to) || Number(segment.from) || 0),
      content: cleanDisplayCaption(segment.content),
      src: 'borrow'
    };
    if (!normalized.content) return;
    if (session.publishCaptionSegment) {
      session.publishCaptionSegment(normalized);
      return;
    }
    addTimelineSegment(session, normalized, { src: 'borrow' });
    void queueLiveMessage(session, { type: 'BSCG_LIVE_SEGMENT', segment: { from: normalized.from, to: normalized.to, content: normalized.content }, bufferedTo: Number(session.bufferedTo) || normalized.to });
  };
}

function releaseBorrowedTask(session) {
  if (session?.borrowTask) {
    session.borrowTask.onSegment = null;
    session.borrowTask = null;
  }
}

function addTimelineSegment(session, segment, opts = {}) {
  const normalized = {
    from: Math.max(0, Number(segment.from) || 0),
    to: Math.max(Number(segment.from) || 0, Number(segment.to) || Number(segment.from) || 0),
    content: cleanDisplayCaption(segment.content)
  };
  if (!normalized.content) return null;
  // 双语模式：译文放 content，识别原文放 sourceContent，页面按小字号渲染第二行。
  const sourceContent = cleanDisplayCaption(segment.sourceContent);
  if (sourceContent) normalized.sourceContent = sourceContent;
  const originalContent = cleanDisplayCaption(segment.originalContent);
  if (originalContent) normalized.originalContent = originalContent;
  if (segment.translationVerified) normalized.translationVerified = true;
  if (segment.id) normalized.id = String(segment.id);
  if (segment.singleLine) normalized.singleLine = true;
  if (opts.src) normalized.src = opts.src;
  if (opts.src === 'borrow') {
    // 借用内容优先：清掉本地前瞻生成的重叠行，避免同段双份
    session.rows = session.rows.filter((row) => row.src === 'borrow' || row.to <= normalized.from || row.from >= normalized.to);
  } else if (session.borrowTask) {
    // 本会话正在借用转写任务：与借用内容重叠的区域不再本地重复生成
    if (session.rows.some((row) => row.src === 'borrow' && row.to > normalized.from && row.from < normalized.to &&
      Math.abs(row.from - normalized.from) >= 0.05)) return null;
  }
  let low = 0;
  let high = session.rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (session.rows[middle].from < normalized.from) low = middle + 1;
    else high = middle;
  }
  const duplicate = findSameCaptionOccurrence(session.rows, normalized);
  if (duplicate) {
    // Keep the canonical start used by the page and translation cache.
    normalized.from = duplicate.from;
    normalized.to = duplicate.to;
  }
  const nearIndex = duplicate ? session.rows.indexOf(duplicate)
    : [low - 1, low].find((index) => index >= 0 && index < session.rows.length && Math.abs(session.rows[index].from - normalized.from) < 0.05);
  if (nearIndex !== undefined) session.rows[nearIndex] = normalized;
  else session.rows.splice(low, 0, normalized);
  if (session.rows.length > MAX_LIVE_ROWS) session.rows.splice(0, session.rows.length - MAX_LIVE_ROWS);
  if (normalized.translationVerified && normalized.originalContent) {
    session.translationRows ||= new Map();
    session.translationRows.set(captionTranslationKey({ ...normalized, content: normalized.originalContent }), normalized);
    if (session.translationRows.size > MAX_LIVE_ROWS) session.translationRows.delete(session.translationRows.keys().next().value);
  }
  return normalized;
}

function findSameCaptionOccurrence(rows, candidate) {
  const key = row => String(row.originalContent || row.sourceContent || row.content || '')
    .toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const text = key(candidate);
  if (!text) return null;
  for (const row of rows) {
    if (Math.abs(row.from - candidate.from) > 0.25 || Math.abs(row.to - candidate.to) > 0.35) continue;
    const overlap = Math.min(row.to, candidate.to) - Math.max(row.from, candidate.from);
    const duration = Math.min(row.to - row.from, candidate.to - candidate.from);
    if (duration > 0 && overlap >= duration * 0.6 && key(row) === text) return row;
  }
  return null;
}

function captionTextLength(value) {
  return Array.from(String(value || '').replace(/[\s，,。.!！？?；;：:、—…"'“”‘’（）()【】\[\]]/g, '')).length;
}

function cleanDisplayCaption(value) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，,。.!！？?；;：:、])/g, '$1')
    .trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

function joinDisplayCaption(left, right) {
  const first = String(left || '').trim();
  const second = String(right || '').trim();
  const needsSpace = /[A-Za-z0-9]$/.test(first) && /^[A-Za-z0-9]/.test(second);
  return `${first}${needsSpace ? ' ' : ''}${second}`;
}

function splitRecognizedCaption(segment) {
  const source = String(segment?.content || '').replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const from = Math.max(0, Number(segment.from) || 0);
  const to = Math.max(from + 0.2, Number(segment.to) || from + 2);
  const clauses = source.match(/[^。.!！？?，,；;：:、]+[。.!！？?，,；;：:、]?/gu) || [source];
  const clauseWeights = clauses.map((clause) => Math.max(1, Array.from(clause).length));
  const totalWeight = clauseWeights.reduce((sum, value) => sum + value, 0);
  let elapsedWeight = 0;
  const units = [];

  clauses.forEach((clause, clauseIndex) => {
    const cleaned = cleanDisplayCaption(clause);
    const hardBoundary = /[。.!！？?；;]\s*$/.test(clause);
    const clauseStart = from + (to - from) * elapsedWeight / totalWeight;
    elapsedWeight += clauseWeights[clauseIndex];
    const clauseEnd = clauseIndex === clauses.length - 1 ? to : from + (to - from) * elapsedWeight / totalWeight;
    if (!cleaned) return;
    const characters = Array.from(cleaned);
    const maximumCharacters = LIVE_CAPTION_MAX_CHARACTERS;
    for (let offset = 0; offset < characters.length; offset += maximumCharacters) {
      const endOffset = Math.min(characters.length, offset + maximumCharacters);
      const content = characters.slice(offset, endOffset).join('').trim();
      if (!content) continue;
      units.push({
        from: clauseStart + (clauseEnd - clauseStart) * offset / characters.length,
        to: clauseStart + (clauseEnd - clauseStart) * endOffset / characters.length,
        content,
        hardBoundary: hardBoundary && endOffset === characters.length
      });
    }
  });
  return units;
}

function formatLivePreviewCaption(value, stableValue = '') {
  const content = cleanDisplayCaption(value);
  if (!content) return '';
  const units = splitRecognizedCaption({
    content,
    from: 0,
    to: Math.max(1, captionTextLength(content))
  });
  const lines = units.length ? units : [{ content }];
  const stable = cleanDisplayCaption(stableValue);
  if (stable && content.startsWith(stable)) {
    const stableUnits = splitRecognizedCaption({
      content: stable,
      from: 0,
      to: Math.max(1, captionTextLength(stable))
    });
    const tail = cleanDisplayCaption(content.slice(stable.length));
    const tailUnits = tail ? splitRecognizedCaption({
      content: tail,
      from: 0,
      to: Math.max(1, captionTextLength(tail))
    }) : [];
    const stableLine = stableUnits.at(-1)?.content || stable;
    const tailLine = tailUnits.at(-1)?.content || tail;
    return [stableLine, tailLine].filter(Boolean).slice(-2).join('\n');
  }
  return lines
    .slice(-2)
    .map((unit) => unit.content)
    .filter(Boolean)
    .join('\n');
}

function queueDisplaySegments(session, recognizedSegment, flush = false) {
  const emitted = [];
  const units = recognizedSegment ? splitRecognizedCaption(recognizedSegment) : [];
  for (const unit of units) {
    if (!session.displayPending) {
      session.displayPending = unit;
    } else {
      const pendingLength = captionTextLength(session.displayPending.content);
      const unitLength = captionTextLength(unit.content);
      const combined = joinDisplayCaption(session.displayPending.content, unit.content);
      const combinedLength = captionTextLength(combined);
      const shouldMerge = !session.displayPending.hardBoundary && combinedLength <= LIVE_CAPTION_MAX_CHARACTERS &&
        (pendingLength < 9 || unitLength < 6 || combinedLength <= 14);
      if (shouldMerge) {
        session.displayPending = {
          from: session.displayPending.from,
          to: unit.to,
          content: combined,
          hardBoundary: Boolean(unit.hardBoundary)
        };
      } else {
        emitted.push(session.displayPending);
        session.displayPending = unit;
      }
    }
    if (captionTextLength(session.displayPending?.content) >= LIVE_CAPTION_MAX_CHARACTERS) {
      emitted.push(session.displayPending);
      session.displayPending = null;
    }
  }
  if (session.displayPending && (flush || captionTextLength(session.displayPending.content) >= 12)) {
    emitted.push(session.displayPending);
    session.displayPending = null;
  }
  return emitted;
}

// 返回本次真正落到 rows 并向页面发出的字幕段，供预翻/翻译队列复用同一批行
// （必须与页面上显示的行完全一致，否则译文回填会错位）。
// deferDisplay=true 时只切分并落 rows，暂不发给页面——由翻译队列在译文就绪后
// （或判断领先量不足时）自行上屏，从而实现"第一个版本就是译文"。
function publishRecognizedSegment(session, recognizedSegment, metadata = {}, flush = false, deferDisplay = false) {
  // Recognition timestamps describe audio units, not equally paced characters.
  // Keep the complete timed unit for translation; wrapping belongs to the UI.
  const displayed = recognizedSegment?.content ? [recognizedSegment] : [];
  const published = [];
  displayed.forEach((candidate, index) => {
    const segment = deferDisplay ? { from: candidate.from, to: candidate.to,
      content: cleanDisplayCaption(candidate.content) } : addTimelineSegment(session, candidate);
    if (!segment) return;
    published.push(segment);
    if (deferDisplay) return;
    void queueLiveMessage(session, {
      type: 'BSCG_LIVE_SEGMENT',
      finalDisplayManaged: session.mode === 'browser-capture',
      sequence: Number(metadata.sequence || 0) + index,
      segment,
      bufferedTo: metadata.bufferedTo,
      cpuLoad: metadata.cpuLoad,
      numThreads: metadata.numThreads,
      batchSize: metadata.batchSize
    });
  });
  return published;
}

// 上屏并落到 rows。内容脚本与 rows 都按 from 就近（<0.05s）替换同一行——
// 译文回填、"先原文兜底后换译文"都靠这个语义。刻意不走 splitRecognizedCaption/
// queueDisplaySegments：译文长度与识别原文不同，重新切分会把时间轴推歪并产生重复行。
function emitCaptionRow(session, row) {
  const original = session.originalCaptionRows?.get(Number(row.from).toFixed(3));
  if (original) row = { ...row, originalContent: original.content };
  const segment = addTimelineSegment(session, row);
  if (!segment) return null;
  void queueLiveMessage(session, {
    type: 'BSCG_LIVE_SEGMENT',
    finalDisplayManaged: session.mode === 'browser-capture' && !session.translator,
    sequence: session.rows.length,
    segment,
    bufferedTo: Number(session.bufferedTo) || 0
  });
  return segment;
}

// 各取音方式复用翻译入口；捕获模式只翻译识别定稿，保存原音频时间范围。
// 仅译文模式等待译文，双语前瞻允许原文兜底。原文单独保存供设置切换与缓存使用。
function videoTranslationIdentity(pageUrl) {
  const url = new URL(pageUrl);
  if (/(^|\.)bilibili\.com$/i.test(url.hostname)) {
    const bvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1];
    if (bvid) return `bilibili:${bvid}:p${Math.max(1, Number(url.searchParams.get('p')) || 1)}`;
  }
  if (/(^|\.)youtube\.com$/i.test(url.hostname)) {
    const id = url.searchParams.get('v') || url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1];
    if (id) return `youtube:${id}`;
  }
  return genericPageIdentity(url.href);
}

async function settingsForVideo(tabId, pageUrl, settings) {
  const key = `videoTranslation:${tabId}:${videoTranslationIdentity(pageUrl)}`;
  const stored = await chrome.storage.session.get(key);
  const choice = stored[key];
  return choice === 'on' || choice === 'off'
    ? { ...settings, translateEnabled: choice === 'on' } : { ...settings };
}

function configureSessionTranslator(session, settings) {
  session.translator?.cancel?.();
  session.previewSegment = null;
  session.finalSegment = null;
  void queueLiveMessage(session, { type: 'BSCG_LIVE_PREVIEW_CLEAR' });
  session.settings = settings;
  const config = translateActiveConfig(settings);
  const identity = captionTranslationIdentity(settings);
  const reuse = session.translationIdentity === identity;
  session.translationIdentity = identity;
  session.lookaheadMetrics ||= { anchor: Number(session.currentVideoTime) || 0,
    recognizedTo: Number(session.currentVideoTime) || 0, translatedContiguousTo: Number(session.currentVideoTime) || 0 };
  session.originalCaptionRows ||= new Map();
  for (const row of session.rows || []) {
    const key = Number(row.from).toFixed(3);
    if (!session.originalCaptionRows.has(key)) session.originalCaptionRows.set(key, {
      from: row.from, to: row.to, content: row.originalContent || row.sourceContent || row.content
    });
  }
  if (config.enabled) {
    const retained = reuse ? (session.rows || []).filter(row => row.translationVerified && row.originalContent) : [];
    session.rows = retained;
    session.translationRows = new Map(retained.map(row => [captionTranslationKey({ ...row, content: row.originalContent }), row]));
    // A seek must not erase already translated timeline intervals in the page.
    if (!reuse) {
      void queueLiveMessage(session, { type: 'BSCG_LIVE_INVALIDATE_RANGE', from: 0, to: Number.MAX_SAFE_INTEGER });
    }
  } else {
    session.translationRows = new Map();
  }
  session.translator = startBrowserDirectTranslator(session, settings, (error) => {
    session.translationFailures = (session.translationFailures || 0) + 1;
    // 走到这里说明已经熔断（内容级失败会先在 drain() 里逐行重试，不回调本函数）。
    // 文案必须说清"不会自动恢复"：旧文案让人以为等一会儿译文就会自己接上。
    void queueLiveMessage(session, {
      type: 'BSCG_LIVE_PROGRESS',
      text: config.displayMode === 'translated'
        ? `翻译已停止：${String(error).slice(0, 90)}；仅译文模式不会显示未验证原文，拖动进度条或重新开始字幕即可恢复`
        : `翻译已停止：${String(error).slice(0, 90)}；后续字幕只显示识别原文，拖动进度条或重新开始字幕即可恢复`
    });
  });
  const originals = [...session.originalCaptionRows.values()];
  if (session.mode === 'browser-cache') session.lookaheadMetrics.recognizedTo = Math.max(
    session.lookaheadMetrics.anchor, ...originals.map(row => Number(row.to) || 0));
  const missing = originals.filter(row => !session.translationRows?.has(captionTranslationKey(row)));
  if (session.translator) session.translator.pushBacklog(session.translationSeekAnchor == null ? missing
    : missing.filter(row => row.to >= session.translationSeekAnchor && row.from < session.translationSeekAnchor + 60));
  else if (!config.enabled || config.displayMode !== 'translated') for (const row of originals) emitCaptionRow(session, row);
  session.publishCaptionSegment = (segment) => {
    session.bufferedTo = Math.max(Number(session.bufferedTo) || 0, Number(segment?.to) || 0);
    if (segment?.src === 'borrow') {
      const row = config.enabled && config.displayMode === 'translated'
        ? { ...segment } : addTimelineSegment(session, segment, { src: 'borrow' });
      if (!row) return;
      session.originalCaptionRows.set(Number(row.from).toFixed(3), { from: row.from, to: row.to, content: row.content });
      if (session.translator && !session.translator.isStopped()) session.translator.enqueue([row]);
      else if (!config.enabled || config.displayMode !== 'translated') emitCaptionRow(session, row);
      return;
    }
    publishTranslatedCaptionSegment(session, segment);
  };
  if (config.enabled && !session.translator) {
    void queueLiveMessage(session, { type: 'BSCG_LIVE_PROGRESS', text: `翻译暂不可用：${translateUnavailableReason(config)}` });
  }
}

function captionTranslationIdentity(settings) {
  const config = translateActiveConfig(settings);
  // Deliberately exclude credentials. Version the segmentation policy as well.
  return JSON.stringify([4, config.enabled, config.mode, config.model, config.baseUrl,
    config.sourceLanguage, config.targetLanguage, config.displayMode,
    settings.asrProfile, settings.asrLanguage]);
}

function finalCaptionUnits(segment) {
  const { timedSegments, ...base } = segment;
  const units = Array.isArray(timedSegments) && timedSegments.length ? timedSegments : [base];
  return units.map((unit, index) => ({ ...base, ...unit, id: `${base.id}:sentence:${index}` }));
}

function captionTranslationKey(row) {
  return JSON.stringify([Number(row.from).toFixed(3), Number(row.to).toFixed(3), String(row.content)]);
}

async function refreshLiveTranslationSettings() {
  const revision = ++liveTranslationRefreshRevision;
  const stored = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  if (revision !== liveTranslationRefreshRevision) return;
  const translationSettings = Object.fromEntries(Object.entries(stored).filter(([key]) => key === 'language' || key.startsWith('translate')));
  for (const session of liveCaptures.values()) {
    if (session.finished || session.stopRequested) continue;
    const settings = await settingsForVideo(session.tabId, session.sourceUrl, { ...session.settings, ...translationSettings });
    if (revision !== liveTranslationRefreshRevision) return;
    if (liveCaptures.get(session.tabId) !== session || session.finished || session.stopRequested) continue;
    if (JSON.stringify(translateActiveConfig(settings)) !== JSON.stringify(translateActiveConfig(session.settings))) {
      configureSessionTranslator(session, settings);
    }
  }
}

async function videoTranslationPreference(tabId, message) {
  const tab = await chrome.tabs.get(tabId);
  const pageUrl = tab.url || message.pageUrl;
  if (message.pageUrl && videoTranslationIdentity(message.pageUrl) !== videoTranslationIdentity(pageUrl)) {
    throw new Error('视频已切换，请重新打开翻译选项');
  }
  const key = `videoTranslation:${tabId}:${videoTranslationIdentity(pageUrl)}`;
  if (message.type === 'BSCG_VIDEO_TRANSLATION_SET') {
    if (!['inherit', 'on', 'off'].includes(message.choice)) throw new Error('翻译选项无效');
    if (message.choice === 'inherit') await chrome.storage.session.remove(key);
    else await chrome.storage.session.set({ [key]: message.choice });
  }
  const globalSettings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  const settings = await settingsForVideo(tabId, pageUrl, globalSettings);
  const choice = (await chrome.storage.session.get(key))[key] || 'inherit';
  const config = translateActiveConfig(settings);
  if (message.type === 'BSCG_VIDEO_TRANSLATION_SET') {
    const session = liveCaptures.get(tabId);
    if (session && !session.finished && videoTranslationIdentity(session.sourceUrl) === videoTranslationIdentity(pageUrl)) {
      configureSessionTranslator(session, settings);
    } else if (message.captionsVisible) {
      const cached = await latestResultForTab(tabId, pageUrl).catch(() => null);
      const rows = cached?.originalSegments || cached?.segments || (Array.isArray(message.segments)
        ? message.segments.slice(-MAX_LIVE_ROWS).map(row => ({ from: row.from, to: row.to,
          content: row.originalContent || row.sourceContent || row.content })) : null);
      if (rows?.length) await startCachedCaptionSession(tab, settings, rows, cached);
    }
  }
  return { ok: true, choice, enabled: config.enabled, ready: translateIsReady(config),
    reason: translateUnavailableReason(config), globalEnabled: Boolean(globalSettings.translateEnabled),
    sourceLanguage: config.sourceLanguage, targetLanguage: config.targetLanguage, translationMode: config.mode };
}

async function startCachedCaptionSession(tab, settings, rows, cached = null) {
  const clock = await getVideoClock(tab.id);
  const identity = captionTranslationIdentity(settings);
  const reuse = cached?.translationIdentity === identity;
  const displayRows = reuse ? cached.segments : rows;
  const session = { tabId: tab.id, sessionId: crypto.randomUUID(), mode: 'browser-cache',
    sourceUrl: tab.url, title: tab.title || '视频字幕', settings, rows: displayRows.map(row => ({ ...row })),
    translationIdentity: reuse ? identity : '',
    originalCaptionRows: new Map(rows.map(row => [Number(row.from).toFixed(3), { ...row }])),
    currentVideoTime: Number(clock?.currentTime) || 0, finished: false, fullTrack: false };
  liveCaptures.set(tab.id, session);
  await injectLiveOverlay(tab.id);
  await sendLive(tab.id, { type: 'BSCG_LIVE_REUSED', sessionId: session.sessionId,
    mode: 'timeline', segments: !translateActiveConfig(settings).enabled || reuse ? session.rows : [], rows: session.rows.length, title: session.title });
  configureSessionTranslator(session, settings);
  void finalizeLiveCapture(session, { segments: session.rows });
  return { ok: true, reused: true, sessionId: session.sessionId, mode: 'timeline', segments: session.rows, rows: session.rows.length };
}

// 实时捕获按完整识别句翻译。草稿只保留最新待处理版本，定稿优先且仅定稿入时间轴。
function startRealtimeCaptionTranslator(session, config, onError) {
  const requestController = new AbortController();
  config = { ...config, abortSignal: requestController.signal };
  let stopped = false;
  let inflight = null;
  let preview = null;
  let displayedOrder = 0;
  let newestCueFrom = -Infinity;
  let order = 0;
  let translated = 0;
  let displayEpoch = 0;
  let lastLatencyMs = 0;
  const finals = [];
  const finalKeys = new Set();
  const translationCache = new Map();
  const lastDraftText = new Map();
  const draftRuns = new Map();
  const versions = new Map();
  const finalized = new Set();
  const latencies = [];
  // 失败节流：模型不可达时每一句都会失败，不节流会在几分钟内刷满日志缓冲区。
  let lastFailNote = '';
  let lastFailAt = 0;
  const latencyP95 = (list) => list.length
    ? list.slice().sort((a, b) => a - b)[Math.min(list.length - 1, Math.ceil(list.length * .95) - 1)]
    : 0;
  let resolveCancelled;
  const cancelled = new Promise(resolve => { resolveCancelled = resolve; });
  const idFor = row => String(row.id || `row:${Number(row.from).toFixed(3)}`);
  // 日志对照用：实时链路逐句翻译，原文→译文是定位"中日掺杂"的唯一线索。
  const clip = (s, n = 40) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  function enqueueCue(row, final = false, silent = false) {
    if (stopped || !row?.content) return;
    if (!final && config.finalOnly) return;
    row = { ...row, content: BSCG_TRANSLATE.normalizeSubtitleText(row.content) };
    if (final) {
      const duplicate = findSameCaptionOccurrence(session.originalCaptionRows.values(), row);
      if (duplicate) row = { ...row, from: duplicate.from, to: duplicate.to, content: duplicate.content };
      // IDs may change on rewind; use canonical audio position for final deduplication.
      const key = captionTranslationKey(row);
      if (finals.some(job => captionTranslationKey(job.row) === key) || finalKeys.has(key)) return;
      finalKeys.add(key);
      while (finalKeys.size > MAX_LIVE_ROWS) finalKeys.delete(finalKeys.values().next().value);
    }
    if (final && session.translationRows?.has(captionTranslationKey(row))) return;
    if (!final && Object.hasOwn(row, 'stableContent')) {
      // A stable character prefix can still end before a Japanese predicate.
      // Translate only a stable complete clause, never blindly cut two chars.
      const stable = BSCG_TRANSLATE.normalizeSubtitleText(row.stableContent);
      const end = [...stable.matchAll(/[。！？!?；;]/gu)].at(-1);
      const id = idFor(row);
      if ((draftRuns.get(id) || 0) >= 2) return;
      if (end) {
        const content = stable.slice(0, end.index + 1);
        if (Array.from(content).length < 4) return;
        row.content = content;
      } else {
        // Waiting only for a stable period can hide translations for the entire
        // 11.5s window. Permit one substantial full hypothesis as a provisional
        // draft, then wait for a stable clause or the final (never a cut prefix).
        if (lastDraftText.has(id) || Number(row.to) - Number(row.from) < 2 ||
            Array.from(row.content).length < 8) return;
      }
    }
    const id = idFor(row);
    if (finalized.has(id)) return;
    if (!final && lastDraftText.get(id) === row.content) return;
    if (!final) lastDraftText.set(id, row.content);
    while (lastDraftText.size > 64) lastDraftText.delete(lastDraftText.keys().next().value);
    // 新草稿到来时保留在途译文的显示机会，避免 ASR 比翻译快时草稿一直被丢弃。
    // 定稿、清除与取消才使在途草稿失效。
    const version = (versions.get(id) || 0) + Number(final);
    versions.set(id, version);
    const job = { row: { ...row }, id, version, final, silent, epoch: displayEpoch, order: ++order, queuedAt: Date.now() };
    if (!silent) newestCueFrom = Math.max(newestCueFrom, Number(row.from) || 0);
    if (final) {
      finalized.add(id);
      if (preview?.id === id) preview = null;
      finals.push(job);
      session.originalCaptionRows.set(Number(row.from).toFixed(3), {
        from: row.from, to: row.to, content: row.content
      });
    } else preview = job;
    if (finalized.size > 64) {
      const oldest = finalized.values().next().value;
      if (!finals.some(item => item.id === oldest)) { finalized.delete(oldest); versions.delete(oldest); }
    }
    void pump();
  }
  async function drain() {
    while (!stopped && (finals.length || preview)) {
      const job = finals.shift() || preview;
      if (job === preview) preview = null;
      const began = Date.now();
      try {
        if (!job.final && Object.hasOwn(job.row, 'stableContent')) {
          const count = draftRuns.get(job.id) || 0;
          if (count >= 2) continue;
          draftRuns.set(job.id, count + 1);
          while (draftRuns.size > 64) draftRuns.delete(draftRuns.keys().next().value);
        }
        const cached = translationCache.get(job.row.content);
        const result = cached ? { ok: true, texts: [cached] }
          : await BSCG_TRANSLATE.translateWithQualityRetry({ ...config, realtime: true }, [job.row.content],
            translateWithConfiguredModel, issue => pushLog('warn', `[translate/quality] ${issue} id=${job.id}`), () => stopped);
        lastLatencyMs = Date.now() - began;
        if (!cached) latencies.push(lastLatencyMs);
        if (latencies.length > 20) latencies.shift();
        if (!result.ok || result.texts?.length !== 1 || !cleanDisplayCaption(result.texts[0])) {
          throw new Error(result.error || '模型未返回单句译文');
        }
        if (stopped) continue;
        // Cache a completed draft before checking its display revision: its
        // identical final may already be waiting and can reuse this generation.
        translationCache.delete(job.row.content);
        translationCache.set(job.row.content, result.texts[0]);
        if (translationCache.size > 64) translationCache.delete(translationCache.keys().next().value);
        if (versions.get(job.id) !== job.version) continue;
        const row = { ...job.row, id: job.id, content: cleanDisplayCaption(result.texts[0]),
          originalContent: job.row.content, stableContent: '', provisional: !job.final, singleLine: true, translationVerified: true };
        if (config.displayMode === 'bilingual') row.sourceContent = job.row.content;
        else delete row.sourceContent;
        // 后到的上一句定稿仍保存，但不盖住已显示的下一句草稿。
        const visible = job.epoch === displayEpoch && !job.silent && (job.final ||
          ((Number(row.from) || 0) >= newestCueFrom - 0.05 && job.order >= displayedOrder));
        if (job.final) {
          const segment = addTimelineSegment(session, row);
          void queueLiveMessage(session, { type: 'BSCG_LIVE_SEGMENT', segment,
            finalDisplayManaged: true, bufferedTo: session.bufferedTo });
          if (visible) {
            session.finalSegment = row;
            if (session.previewSegment?.id === job.id) session.previewSegment = null;
            void queueLiveMessage(session, { type: 'BSCG_LIVE_FINAL', segment: row });
          }
        } else if (visible) {
          session.previewSegment = row;
          void queueLiveMessage(session, { type: 'BSCG_LIVE_PREVIEW', previewId: job.id,
            revision: row.revision, segment: row });
        }
        if (visible) displayedOrder = Math.max(displayedOrder, job.order);
        translated++;
        // 实时链路逐句翻译，原文→译文对照是定位"中日掺杂"的唯一线索：
        // 草稿译文上屏后若定稿原文后到且 visible，日语会覆盖中文再被下一句定稿译文覆盖。
        pushLog('info', `[translate/realtime] ${job.final ? '定稿' : '草稿'} 单句 ${lastLatencyMs}ms ` +
          `排队=${began - job.queuedAt}ms${cached ? ' 复用译文' : ''} id=${job.id}` +
          ` 发出延迟=${job.row.asrReadyAt ? Date.now() - job.row.asrReadyAt : 'unknown'}ms · ` +
          `[原]${clip(job.row.content)}→[译]${clip(row.content)}`);
      } catch (error) {
        if (job.final) finalKeys.delete(captionTranslationKey(job.row));
        if (stopped || versions.get(job.id) !== job.version) continue;
        // 单句失败不停止后续翻译，也不向仅译文模式泄漏原文。但这正是"字幕一直
        // 显示原文"最常见的根因（模型不可达 / 超时 / 返回空），必须留痕；
        // 相同原因 10 秒内只记一条，防止整段失败把日志刷满。
        const note = String(error?.message || error);
        const nowMs = Date.now();
        if (note !== lastFailNote || nowMs - lastFailAt >= 10000) {
          lastFailNote = note;
          lastFailAt = nowMs;
          // 单句翻译失败时这一句不会上屏译文，ASR 已上屏的日语原文会残留——
          // 这是实时链路"中日掺杂"最常见的根因，必须带上原文才能定位是哪句。
          pushLog('warn', `[translate/realtime] 单句${job.final ? '定稿' : '草稿'}翻译失败（跳过该句，链路继续）` +
            `：${note} · 原文：${clip(job.row.content, 40)}`);
        }
        onError?.(note);
      }
    }
  }
  function pump() {
    if (inflight) return inflight;
    if (stopped) return Promise.resolve();
    inflight = drain().finally(() => {
      inflight = null;
      if (!stopped && (finals.length || preview)) void pump();
    });
    return inflight;
  }
  function clearPreview(id) {
    if (finalized.has(id)) return; // 保留已翻草稿，等对应定稿替换。
    if (id) versions.set(id, (versions.get(id) || 0) + 1);
    else for (const key of versions.keys()) if (!finalized.has(key)) versions.set(key, versions.get(key) + 1);
    if (!id || preview?.id === id) preview = null;
    if (!id || session.previewSegment?.id === id) {
      session.previewSegment = null;
      void queueLiveMessage(session, { type: 'BSCG_LIVE_PREVIEW_CLEAR', previewId: id || '' });
    }
  }
  pushLog('info', `[translate] 实时${config.finalOnly ? '仅定稿' : '草稿/定稿'}翻译已启用 mode=${config.mode} model=${config.model} source=${config.sourceLanguage} target=${config.targetLanguage} display=${config.displayMode}`);
  return {
    preview: row => enqueueCue(row), final: row => enqueueCue(row, true), clearPreview,
    enqueue: rows => rows.forEach(row => enqueueCue(row, true)),
    pushBacklog: rows => rows.forEach(row => enqueueCue(row, true, true)),
    tick: () => {},
    seek: () => {
      displayEpoch++;
      newestCueFrom = -Infinity;
      displayedOrder = 0;
      clearPreview();
      lastDraftText.clear();
      draftRuns.clear();
      session.finalSegment = null;
    },
    finish: async () => {
      while (!stopped && (inflight || finals.length || preview)) await Promise.race([pump(), cancelled]);
      // 汇总一条：实时链路按句翻译，只有总数和 P95 才能反映"跟不跟得上播放"。
      pushLog('info', `[translate/realtime] 实时翻译结束：已翻 ${translated} 句 · 请求 P95 ${latencyP95(latencies)}ms`);
    },
    cancel: () => {
      const dropped = finals.length + Number(Boolean(preview));
      stopped = true;
      if (!requestController.signal.aborted) requestController.abort('translation-cancelled');
      preview = null; finals.length = 0; resolveCancelled();
      // 拖动、改设置、会话结束都会走到这里，丢掉的是"还没翻完的句子"：
      // 排查"拖动后字幕短暂空白"时先看这条，再看其后是否重新入队。
      if (dropped) pushLog('info', `[translate/realtime] 已丢弃 ${dropped} 个在途/排队单句（设置变更、拖动或会话结束）`);
    },
    isStopped: () => stopped,
    stats: () => ({ translated, lastLatencyMs, queued: finals.length + Number(Boolean(preview)),
      latencyP95Ms: latencies.length ? latencies.slice().sort((a, b) => a - b)[Math.ceil(latencies.length * .95) - 1] : 0 })
  };
}

// 翻译失败必须分两类处理，否则一次抽风会带走整场翻译：
//   内容级——模型对这批文本本身处理失败：把多行并成一行、吐空行、复述提示词被质量检查拦下。
//             本地小模型（如 Hy-MT2-1.8B）上是高频行为，值得重试或拆小。
//   传输级——服务不可用、请求超时、HTTP 错误。重试只会再白等一轮 240 秒超时，必须熔断止损。
// 只按文案判定：这些错误串全部由本仓库自己产生（translate.js 与 translateWithConfiguredModel），
// 不依赖每个后端都回传同一个标记位，改动面最小。
const CONTENT_TRANSLATE_FAILURE = /行数不匹配|数量或类型无效|模型返回空译文|模型未返回单句译文|翻译质量|达到长度上限/;
function isContentTranslateFailure(error) {
  return CONTENT_TRANSLATE_FAILURE.test(String(error?.message || error || ''));
}

function startBrowserDirectTranslator(session, settings, onError) {
  let config = translateActiveConfig(settings);
  if (!translateIsReady(config)) return null;
  if (session.mode === 'browser-capture') return startRealtimeCaptionTranslator(session, {
    ...config, finalOnly: false, sourceLanguage: session.settings?.asrProfile === 'qwen3_asr_0_6b' ? 'auto' : (session.settings?.asrLanguage || 'auto')
  }, onError);
  const requestController = new AbortController();
  config = { ...config, abortSignal: requestController.signal };
  // API 优先凑够 200 字，上限 24 行 / 900 字；ONNX 使用小批次降低首句等待。
  // Local autoregressive GPU translation favors short jobs; API batching keeps
  // its existing throughput policy. Near the playhead, publish one GPU row first.
  const BATCH_MIN_CHARACTERS = config.mode === 'onnx' ? 48 : 200;
  const BATCH_MAX_LINES = config.mode === 'onnx' ? 4 : 24;
  const BATCH_MAX_CHARACTERS = config.mode === 'onnx' ? 240 : 900;
  const IDLE_FLUSH_MS = config.mode === 'onnx' ? 40 : 700;
  // 领先播放头不足这个秒数就立刻上屏识别原文，避免用户拖到已识别区域时字幕空着。
  const DISPLAY_LEAD_SECONDS = 3;
  // 日志对照用：把单行截断到固定长度，避免一批日志撑爆 pushLog 的 600 字符上限。
  // 中日文都是宽字符，30 字足够辨别语义；空白合并防止换行把对照拆散。
  const clip = (s, n = 30) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  // 批次进度日志的节流窗口。一部长片会有成百上千批，逐批记录会在十几分钟内
  // 冲掉 600 条的会话缓冲、把真正的错误挤走；所以常规进度按 10 秒记一条，
  // 只有"领先量不足"这种需要排查的时刻才无视节流立即记录。
  const PROGRESS_LOG_INTERVAL_MS = 10000;
  const displayMode = config.displayMode === 'bilingual' ? 'bilingual' : 'translated';
  const pending = [];
  const queuedKeys = new Set();
  const heldRows = [];
  let inflight = null;
  let idleTimer = null;
  let stopped = false;
  let translated = 0;
  let deferred = 0;
  let fallback = 0;
  let failure = '';
  let activeBatch = [];
  let lastLatencyMs = 0;
  const latencies = [];
  let lastProgressLogAt = 0;
  let resolveCancelled;
  const cancelled = new Promise(resolve => { resolveCancelled = resolve; });

  const rowKey = (row) => `${Number(row.from).toFixed(3)}\n${Number(row.to).toFixed(3)}\n${String(row.content)}`;
  const rowCharacters = (row) => Array.from(String(row.content || '')).length;
  const batchCharacters = (batch) => batch.reduce((sum, row) => sum + rowCharacters(row), 0);

  function updateWatermark() {
    const progress = session.lookaheadMetrics ||= { anchor: Number(session.currentVideoTime) || 0 };
    const anchor = Number(progress.anchor) || 0;
    const recognized = Math.max(anchor, Number(progress.recognizedTo) || 0);
    let contiguous = recognized;
    for (const rows of [pending, activeBatch]) for (const row of rows) {
      if (row.to > anchor) contiguous = Math.min(contiguous, Math.max(anchor, row.from));
    }
    progress.translatedContiguousTo = stopped ? anchor : Math.max(anchor, contiguous);
    progress.translationAheadSeconds = Math.max(0, progress.translatedContiguousTo - (Number(session.currentVideoTime) || 0));
    return progress;
  }

  function prioritizePending() {
    const position = Number(session.currentVideoTime) || 0;
    const priority = row => row.to >= position ? Math.max(0, row.from - position) : 1e9 + position - row.to;
    pending.sort((a, b) => priority(a) - priority(b));
  }

  // 播放位置一直在动，用会话上的实时值判断"这批是不是还在播放头前面"。
  // 传了 row 就按这一行自己的起始时间算；否则以队首（最早压着的行）为锚点。
  const aheadSeconds = (row = null) => {
    const position = Number(session.currentVideoTime) || 0;
    const anchor = row ? Number(row.from) || 0 : (heldRows.length ? Number(heldRows[0].from) : 0);
    return anchor - position;
  };

  // 领先量够 → 压着等译文；不够 → 立刻按识别原文上屏，不能留空。
  function shouldHold(row = null) {
    return displayMode === 'translated' || aheadSeconds(row) >= DISPLAY_LEAD_SECONDS;
  }

  // 把压着的行按识别原文落地。shouldKeep 返回 true 的行继续等译文，
  // 其余立刻上屏——快进只该影响被越过的那一段，不该把后面的也一起降级。
  function flushHeldAsRecognized(shouldKeep = null) {
    if (!heldRows.length) return 0;
    const keep = [];
    const drop = [];
    for (const row of heldRows) {
      if (shouldKeep && shouldKeep(row)) keep.push(row); else drop.push(row);
    }
    heldRows.length = 0;
    heldRows.push(...keep);
    for (const row of drop) {
      if (displayMode !== 'translated') emitCaptionRow(session, row);
      fallback += 1;
    }
    // 降级是"翻译没跟上播放"的直接证据。只在实际发生降级时记一条，并带上当时的
    // 领先量：领先为负 = 播放头追上了译文（正常但需关注）；领先仍为正 = 翻译失败
    // 或已中止（才是异常）。tick() 会频繁调用本函数，但 drop 为空时不产生日志。
    if (drop.length) {
      // 降级是"中日掺杂"最直接的来源：压着的日语原文被播放头追平后直接上屏，
      // 与已上屏的中文译文交替出现。带上原文才能定位是哪段追上了播放。
      pushLog('warn', `[translate] ${drop.length} 行不再等待译文` +
        `（${displayMode === 'translated' ? '仅译文模式不显示原文' : '已按识别原文上屏'}）· ` +
        `累计降级 ${fallback} 行 · 当时领先 ${aheadSeconds().toFixed(1)}s · ` +
        `原文：${drop.slice(0, 4).map((r) => clip(r.content)).join(' | ')}` +
        (drop.length > 4 ? ' …' : ''));
    }
    return drop.length;
  }

  // 熔断：只在"翻译服务本身不可用"（超时 / HTTP 错误 / 逐行重试也撞上传输级错误）时调用。
  // 内容级失败已在 drain() 里逐行兜底，不再走到这里——否则一批抽风就会让整场字幕
  // 从那一刻起全部退回识别原文，而界面上只留一句"稍后自动继续"，永远等不到。
  // 熔断后字幕按识别原文继续走完，heldRows 里压着的行必须立刻落地。
  function abort(error) {
    if (stopped) return;
    stopped = true;
    failure = String(error || '未知错误');
    pending.length = 0;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    flushHeldAsRecognized();
    pushLog('warn', `[translate] 前瞻字幕翻译中止，${displayMode === 'translated' ? '仅译文模式不显示原文' : '改显示识别原文'}：${failure}`);
    onError?.(failure);
  }

  function scheduleIdleFlush() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void pump();
    }, IDLE_FLUSH_MS);
  }

  async function translateBatch(batch) {
    const began = Date.now();
    const result = await BSCG_TRANSLATE.translateWithQualityRetry(config, batch.map((row) => row.content),
      translateWithConfiguredModel, issue => pushLog('warn', `[translate/quality] ${issue}`), () => stopped);
    lastLatencyMs = Date.now() - began;
    latencies.push(lastLatencyMs);
    if (latencies.length > 20) latencies.shift();
    if (!result.ok) throw new Error(result.error || '翻译请求失败');
    return batch.map((row, index) => {
      const text = cleanDisplayCaption(result.texts[index]);
      // 模型对噪声行返回空行时保留识别原文，宁可显示原文也不留空白。
      if (!text) throw new Error('模型返回空译文');
      return displayMode === 'bilingual'
        ? { from: row.from, to: row.to, content: text, sourceContent: row.content, translationVerified: true }
        : { from: row.from, to: row.to, content: text, translationVerified: true };
    });
  }

  // 内容级失败不熔断。整批重发会得到同样的合并结果，没有意义；按行拆开单独请求
  // 才是结构性可靠的退路——translateLines 收到单行时 parseTranslatedLines 走
  // expectedCount <= 1 分支，模型把整段当一条，逻辑上不可能再出现"行数不匹配"。
  // 单行仍翻不出来的只丢这一行（按识别原文落地，与 flushHeldAsRecognized 同口径），
  // 不牵连同批其余行。返回 null 表示撞上传输级错误，调用方必须熔断。
  async function recoverBatchLineByLine(batch) {
    const began = Date.now();
    const recovered = [];
    const pairs = [];
    for (const row of batch) {
      if (stopped) return null;
      let single;
      try {
        single = await translateBatch([row]);
      } catch (error) {
        if (!isContentTranslateFailure(error)) return null;
        pushLog('warn', `[translate] 单行重试仍失败，按识别原文显示：${clip(row.content)} · ${error?.message || String(error)}`);
        // 仅译文模式不泄漏原文，与 flushHeldAsRecognized 的降级口径保持一致。
        if (displayMode !== 'translated') emitCaptionRow(session, row);
        fallback += 1;
        continue;
      }
      recovered.push(...single);
      if (pairs.length < 4) pairs.push(`[原]${clip(row.content)}→[译]${clip(single[0]?.content)}`);
    }
    // 一行都没救回来：说明这批内容模型整体处理不了，再往下拖只会让字幕越落越远。
    if (!recovered.length) return null;
    pushLog('info', `[translate] 逐行恢复：本批 ${batch.length} 行 → 成功 ${recovered.length} 行 · ${Date.now() - began}ms` +
      (pairs.length ? `：${pairs.join(' | ')}` : '') + (batch.length > 4 ? ' …' : ''));
    return recovered;
  }

  async function drain() {
    while (pending.length && !stopped) {
      prioritizePending();
      const batch = [];
      let characters = 0;
      const position = Number(session.currentVideoTime) || 0;
      const urgent = config.mode === 'onnx' && pending[0].to >= position && pending[0].from - position <= 8;
      const batchLimit = urgent ? 1 : BATCH_MAX_LINES;
      // 达到当前后端的批次目标就发；队列见底时也发送尾行。
      while (batch.length < pending.length && batch.length < batchLimit) {
        const next = pending[batch.length];
        const size = rowCharacters(next);
        if (batch.length && characters + size > BATCH_MAX_CHARACTERS) break;
        batch.push(next);
        characters += size;
        if (characters >= BATCH_MIN_CHARACTERS) break;
      }
      if (!batch.length) break;
      pending.splice(0, batch.length);
      activeBatch = batch;
      updateWatermark();
      let output;
      let recoveredIndividually = false;
      try {
        output = await translateBatch(batch);
      } catch (error) {
        const message = error?.message || String(error);
        // 翻译失败若触发 abort，那条日志不带原文。补一条本批原文，
        // 排查"中日掺杂"时能定位是哪批日语没翻成中文而残留上屏。
        pushLog('warn', `[translate] 本批 ${batch.length} 行翻译失败，原文：` +
          batch.slice(0, 4).map((r) => clip(r.content)).join(' | ') +
          (batch.length > 4 ? ' …' : ''));
        // 只有传输级错误才熔断。内容级错误仅说明"这一批文本模型没处理好"，
        // 拆成单行重试继续，绝不能让一批抽风带走整场翻译。
        if (!isContentTranslateFailure(error)) {
          abort(message);
          return;
        }
        output = await recoverBatchLineByLine(batch);
        if (!output) {
          abort(message);
          return;
        }
        recoveredIndividually = true;
      }
      if (stopped) return;
      // 【对照日志】排查"中日掺杂"的核心观测点：每批原文→译文一目了然。
      // 每行截断 30 字、最多前 4 行，单条 < 600 字符上限。
      // 逐行恢复过的批次行数与原文不再一一对应，对照已由 recoverBatchLineByLine 记过。
      if (!recoveredIndividually) {
        pushLog('info', `[translate] 本批 ${batch.length} 行 ${lastLatencyMs}ms：` +
          batch.slice(0, 4).map((r, i) => `[原]${clip(r.content)}→[译]${clip(output[i]?.content)}`).join(' | ') +
          (batch.length > 4 ? ' …' : ''));
      }
      // Remove completed held rows in one linear pass, by identity. Repeated
      // findIndex/splice scans were O(batch * held), and equal timestamps could
      // remove a different cue that was still waiting for translation.
      const completed = new Set(batch);
      let heldWrite = 0;
      for (const row of heldRows) if (!completed.has(row)) heldRows[heldWrite++] = row;
      heldRows.length = heldWrite;
      // 一次请求里的行必须整体落屏：只落地一部分会让后面的行错位。
      for (const row of output) {
        emitCaptionRow(session, row);
        translated += 1;
      }
      activeBatch = [];
      const watermark = updateWatermark();
      // 【关键观测点】译文领先量 = 已完成连续译文 − 播放头。
      //   领先 > 0：字幕在"预见"播放，用户直接看到译文；
      //   领先 ≤ 0：翻译没追上，字幕退回识别原文（fallback 同步上涨）。
      // 首批必记（确认翻译链路真的通了），领先不足必记（这才是要排查的时刻），
      // 其余按 PROGRESS_LOG_INTERVAL_MS 节流，避免把真正的错误刷出缓冲区。
      const ahead = Number(watermark.translationAheadSeconds) || 0;
      const now = Date.now();
      if (translated === output.length || ahead < DISPLAY_LEAD_SECONDS || now - lastProgressLogAt >= PROGRESS_LOG_INTERVAL_MS) {
        lastProgressLogAt = now;
        pushLog(ahead < 0 ? 'warn' : 'info', `[translate] 已翻 ${translated} 行 · 译文领先 ${ahead.toFixed(1)}s · ` +
          `待译 ${pending.length} 压着 ${heldRows.length} · 本批 ${output.length} 行 ${lastLatencyMs}ms`);
      }
    }
  }

  function pump() {
    if (inflight) return inflight;
    if (stopped || !pending.length) return Promise.resolve();
    inflight = drain().catch((error) => abort(error?.message || String(error))).finally(() => {
      inflight = null;
      if (pending.length && !stopped) scheduleIdleFlush();
    });
    return inflight;
  }

  // 入队：领先足够就压着等译文，否则立刻按识别原文上屏。
  function enqueue(segments) {
    if (stopped) return;
    let held = 0;
    for (const row of Array.isArray(segments) ? segments : []) {
      if (!row?.content) continue;
      const normalized = {
        from: Number(row.from) || 0,
        to: Number(row.to) || 0,
        content: String(row.content),
        sourceContent: String(row.sourceContent || '')
      };
      const key = rowKey(normalized);
      if (session.translationRows?.has(captionTranslationKey(normalized))) continue;
      if (queuedKeys.has(key)) continue;
      queuedKeys.add(key);
      // 压着等译文的前提是这一行确实在播放头前面；被追平的行必须马上上屏。
      if (shouldHold(normalized)) {
        heldRows.push(normalized);
        held += 1;
      } else {
        emitCaptionRow(session, normalized);
        fallback += 1;
      }
      pending.push(normalized);
    }
    if (held) deferred += held;
    if (!pending.length) return;
    updateWatermark();
    const position = Number(session.currentVideoTime) || 0;
    if (pending.some(row => row.to >= position && row.from - position <= 8) ||
      batchCharacters(pending) >= BATCH_MIN_CHARACTERS || pending.length >= BATCH_MAX_LINES) void pump();
    else scheduleIdleFlush();
  }

  // 复用缓存行时的回填：插到队首优先翻，让播放位置附近先出现译文。
  // 缓存行本来就在页面上，不能再当成"压着等译文"的对象。
  function pushBacklog(rows) {
    if (stopped) return;
    const backlog = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row?.content) continue;
      const key = rowKey(row);
      if (session.translationRows?.has(captionTranslationKey(row))) continue;
      if (queuedKeys.has(key)) continue;
      queuedKeys.add(key);
      backlog.push({
        from: Number(row.from) || 0,
        to: Number(row.to) || 0,
        content: String(row.content),
        sourceContent: ''
      });
    }
    if (!backlog.length) return;
    pending.unshift(...backlog);
    pushLog('info', `[translate] 回填 ${backlog.length} 行已有字幕优先翻译（队列 ${pending.length}）`);
    void pump();
  }

  // 播放位置变化时的兜底：快进/回拖把播放头推过了某一行，那一行就不能再等译文。
  function tick() {
    if (stopped) return;
    flushHeldAsRecognized((row) => shouldHold(row));
    const position = Number(session.currentVideoTime) || 0;
    if (pending.some(row => row.to >= position && row.from - position <= 8)) void pump();
    updateWatermark();
  }

  // 收尾：把在途批次与剩余队列全部翻完（失败的按识别原文落地），调用方随后读
  // rows 才能拿到同文同种的字幕。
  async function finish() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    while (!stopped && (pending.length || inflight)) {
      await Promise.race([pump(), cancelled]);
      if (!pending.length && !inflight) break;
    }
    if (!stopped && heldRows.length) {
      // 全部翻完仍压着的行：队列已空说明这些行模型没返回，按原文兜底。
      flushHeldAsRecognized();
    }
    // 收尾汇总：一次会话只记一条，回答"这趟到底翻了多少、压后多久、降级几次"。
    // 排查时先看这条，再往上找第一条 [translate] 领先告警，就能定位卡在哪一批。
    const p95 = latencies.length ? latencies.slice().sort((a, b) => a - b)[Math.min(latencies.length - 1, Math.ceil(latencies.length * .95) - 1)] : 0;
    pushLog(fallback ? 'warn' : 'info', `[translate] 前瞻翻译结束：已翻 ${translated} 行 · ` +
      `压后显示 ${deferred} 行 · 降级 ${fallback} 行 · ${stopped ? '曾中止' : '正常收尾'} · 请求 P95 ${p95}ms`);
  }

  pushLog('info', `[translate] 前瞻字幕翻译已启用 mode=${config.mode} endpoint=${config.baseUrl} ` +
    `model=${config.model} target=${config.targetLanguage} display=${displayMode} ` +
    `（仅译文模式等待译文；实时捕获只翻译识别定稿）`);
  return {
    enqueue,
    pushBacklog,
    tick,
    finish,
    cancel: () => {
      stopped = true;
      if (!requestController.signal.aborted) requestController.abort('translation-cancelled');
      resolveCancelled();
      pending.length = 0;
      heldRows.length = 0;
      activeBatch = [];
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    },
    // 调用方要据此决定"还能不能延后显示"：一旦中止就必须立刻走识别原文上屏，
    // 否则延后的行永远不会被发出去，字幕会整段空白。用方法而非 getter，
    // 避免调用方解构后拿到一次性快照。
    isStopped: () => stopped,
    stats: () => ({ translated, deferred, fallback, failure, queued: pending.length, held: heldRows.length,
      ...updateWatermark(), lastLatencyMs,
      latencyP95Ms: latencies.length ? latencies.slice().sort((a, b) => a - b)[Math.ceil(latencies.length * .95) - 1] : 0 })
  };
}

// 发布 + 送翻 的唯一入口：页面显示什么，就送翻什么，两者严格同一批行。
// 翻译开启时识别段先进翻译队列（领先足够就压着不上屏，直接等译文）；
// 翻译未开启或已中止时，退化为立即按识别原文上屏。
function publishTranslatedCaptionSegment(session, recognizedSegment, flush = true) {
  const translator = session.translator;
  // 中止后不能再延后：翻译队列已经停摆，压着的行永远等不到译文。
  const config = translateActiveConfig(session.settings);
  const deferDisplay = Boolean(translator && !translator.isStopped()) || (config.enabled && config.displayMode === 'translated');
  const published = publishRecognizedSegment(session, recognizedSegment, { bufferedTo: session.bufferedTo }, flush, deferDisplay);
  session.originalCaptionRows ||= new Map();
  for (const row of published) session.originalCaptionRows.set(Number(row.from).toFixed(3), {
    from: row.from, to: row.to, content: row.content
  });
  session.lookaheadMetrics ||= { anchor: Number(session.currentVideoTime) || 0 };
  session.lookaheadMetrics.recognizedTo = Math.max(Number(session.lookaheadMetrics.recognizedTo) || 0,
    ...published.map(row => Number(row.to) || 0));
  if (translator && !translator.isStopped() && published.length) translator.enqueue(published);
  return published;
}

function liveCapturePolicy(pageUrl, clock = null, options = {}) {
  const url = new URL(pageUrl || 'https://invalid.local/');
  const biliLive = url.hostname === 'live.bilibili.com';
  const roomId = biliLive ? url.pathname.match(/^\/(?:blanc\/)?([1-9]\d*)\/?$/)?.[1] || '' : '';
  const huya = /^(?:www\.|m\.)?huya\.com$/i.test(url.hostname);
  const huyaRoom = huya && /^\/[\w-]+\/?$/.test(url.pathname) &&
    !/^\/(?:g|l|s|download|search|category|index|my)\/?$/i.test(url.pathname);
  const tabAudio = options.captureMode === 'tab';
  // 时长暂未加载不代表直播；未知 VOD 仍应先尝试清单前瞻。
  const isLive = Boolean(tabAudio || roomId || huyaRoom || clock?.isLive);
  return {
    isLive, roomId, directory: biliLive && !roomId && !tabAudio,
    overlayOnTop: tabAudio,
    preferInPageCapture: !tabAudio && (url.protocol === 'file:' || biliLive || url.hostname === 'www.bilibili.com' || /(^|\.)youtube\.com$/i.test(url.hostname)),
    // On new sites, never reroute a media element's original speaker output.
    // If captureStream is unavailable, the toolbar's tab-audio mode is available.
    requireCopyStream: url.protocol === 'file:' || biliLive || isLive || clock?.kind === 'audio'
  };
}

async function prepareBrowserDirectSource(tab, message = {}) {
  const url = new URL(tab.url || 'https://invalid.local/');
  if (url.hostname === 'live.bilibili.com') return null;
  if (message.localFileToken) {
    const identity = await sourceHash(tab.url);
    return {
      platform: 'local', videoId: identity, partId: identity,
      title: message.localFileName || tab.title || '本地视频', duration: 0,
      candidates: [{ url: `bscg-local:${message.localFileToken}`, token: message.localFileToken, kind: 'local-upload', frameId: 0 }]
    };
  }
  if (url.hostname === 'www.bilibili.com') {
    const bvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1];
    if (!bvid) return null;
    const playerState = await getCurrentPlayerState(tab.id, bvid);
    const lockedCid = playerState.playurlCid || playerState.initialCid;
    const pageNumber = Math.max(1, Number(url.searchParams.get('p')) || 1);
    const localPage = playerState.pageInfo;
    const { view, page } = localPage?.cid && (!lockedCid || String(localPage.cid) === String(lockedCid))
      ? { view: { title: playerState.title || tab.title, bvid }, page: localPage }
      : await getVideoInfo(bvid, pageNumber, lockedCid || null);
    const candidates = await resolveBilibiliAudioCandidates(tab.id, bvid, page.cid, {
      expectedDuration: Number(page.duration) || 0,
      refreshAudio: Boolean(message.refreshAudio)
    });
    if (!candidates.length) {
      throw new Error('播放器与 playurl 均未返回可读音轨；视频可能需要登录、会员/付费、地区授权，或采用 DRM');
    }
    return {
      platform: 'bilibili', videoId: bvid, partId: String(page.cid), title: view.title,
      duration: Number(page.duration) || 0,
      referer: tab.url,
      candidates
    };
  }
  if (/(^|\.)youtube\.com$/i.test(url.hostname)) {
    const videoId = url.searchParams.get('v') || url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
    if (!videoId) return null;
    const state = await getYouTubePlayerState(tab.id, videoId);
    const candidates = youTubeReplayCandidates(state);
    return candidates.length ? {
      platform: 'youtube', videoId, partId: videoId, title: state.title || tab.title,
      duration: Number(state.lengthSeconds) || 0, candidates
    } : null;
  }
  if (/^file:/i.test(tab.url || '')) return null;
  const generic = await getGenericMediaSource(tab.id).catch(() => null);
  if (!generic) return null;
  const observed = (await getObservedMediaRecords(tab.id)).slice().reverse();
  const candidates = genericReplayCandidates(generic, observed);
  if (!candidates.length) return null;
  const identity = await sourceHash(tab.url);
  return {
    platform: 'web', videoId: identity, partId: identity,
    title: tab.title || generic?.title || '在线视频', duration: Number(generic?.duration) || 0,
    referer: generic.referer || tab.url,
    frameId: generic.frameId,
    playerMediaSrc: generic.mediaSrc || '',
    candidates
  };
}

async function startBrowserDirectLive(tab, settings, source, borrowTask = null, startRequest = {}) {
  const clock = await getVideoClock(tab.id);
  const cached = await latestResultForTab(tab.id, tab.url).catch(() => null);
  const cachedOriginals = cached?.originalSegments || cached?.segments;
  const cachedRows = Array.isArray(cachedOriginals) ? cachedOriginals.map((row) => ({ ...row, content: cleanDisplayCaption(row.content) })).filter((row) => row.content) : [];
  const seededRows = cachedRows.concat(borrowedTaskRows(borrowTask)).sort((a, b) => a.from - b.from).slice(-MAX_LIVE_ROWS);
  await injectLiveOverlay(tab.id);
  if (!await isLiveStartCurrent(tab.id, startRequest)) return { ok: true, superseded: true };
  const mediaKey = source.mediaKey || buildMediaKey({
    platform: source.platform || 'web', pageUrl: tab.url,
    videoId: source.videoId, partId: source.partId || source.videoId,
    duration: source.duration
  });
  const session = {
    mode: 'browser-direct', backend: 'browser', sessionId: crypto.randomUUID(), tabId: tab.id,
    title: source.title || tab.title || '在线视频', sourceUrl: tab.url,
    sourcePlatform: source.platform || 'web', sourceVideoId: source.videoId,
    sourcePartId: source.partId || source.videoId, mediaKey,
    mediaDuration: Number(source.duration) || 0,
    documentId: currentDocumentId(tab.id), settings,
    rows: seededRows, displayPending: null, bufferedTo: 0,
    currentVideoTime: clock.currentTime, playbackRate: clock.playbackRate, paused: clock.paused,
    directCoverageStart: clock.currentTime,
    fullTrack: clock.currentTime <= 1,
    finished: false, stopRequested: false,
    browserControl: { abort: null, engineSessionId: '', pendingSeekTime: clock.currentTime }
  };
  liveCaptures.set(tab.id, session);
  attachBorrowedTask(session, borrowTask);
  await sendLive(tab.id, { type: 'BSCG_LIVE_STARTED', sessionId: session.sessionId, mode: 'timeline', segments: translateActiveConfig(settings).enabled ? [] : seededRows });
  configureSessionTranslator(session, settings);
  const request = {
    tabId: tab.id,
    asrProfile: settings.asrProfile || DEFAULTS.asrProfile,
    backendMode: browserBackendMode(settings),
    cpuThreads: Number(settings.recognitionThreads) || 0,
    asrLanguage: settings.asrLanguage || 'auto',
    voiceEnhance: Boolean(settings.voiceEnhance),
    voiceEnhancePreset: settings.voiceEnhancePreset || 'balanced',
    title: session.title,
    sourceUrl: tab.url,
    mediaKey: session.mediaKey,
    documentId: session.documentId,
    jobId: session.sessionId,
    startTime: clock.currentTime,
    rollingLookahead: true,
    initialClock: clock,
    allowScan: false,
    directSource: {
      platform: source.platform || 'web',
      videoId: source.videoId || '',
      partId: source.partId || source.videoId || '',
      duration: Number(source.duration) || 0,
      bitrate: Number(source.bitrate) || 0,
      referer: source.referer || '',
      playerMediaSrc: source.playerMediaSrc || '', frameId: Number(source.frameId) || 0,
      candidates: source.candidates
    }
  };
  void browserTranscribeRequest(request, (event) => {
    if (session.finished) return;
    if (event.metrics) {
      const metrics = event.metrics;
      session.lookaheadMetrics ||= { anchor: Number(session.currentVideoTime) || 0 };
      for (const key of ['fetchedTo', 'decodedTo', 'recognizedTo', 'targetAheadSeconds', 'hlsCacheBytes', 'decodedPcmBytes']) {
        if (Number.isFinite(metrics[key])) session.lookaheadMetrics[key] = metrics[key];
      }
      session.translator?.stats?.();
    }
    if (event.type === 'queue') {
      void queueLiveMessage(session, {
        type: 'BSCG_LIVE_QUEUED',
        text: event.text,
        queuePosition: Number(event.queuePosition) || 0,
        queueAhead: Number(event.queueAhead) || 0,
        queueBlocker: String(event.queueBlocker || '')
      });
    } else if (event.type === 'segments_reset') {
      session.rows = translateActiveConfig(session.settings).enabled ? [] : seededRows.slice();
      session.displayPending = null;
      session.bufferedTo = 0;
      void queueLiveMessage(session, { type: 'BSCG_LIVE_INVALIDATE_RANGE', from: 0, to: Number.MAX_SAFE_INTEGER });
    } else if (event.type === 'segment' && event.segment?.content) {
      session.bufferedTo = Math.max(Number(session.bufferedTo) || 0, Number(event.segment.to) || 0);
      // 整轨前瞻路径：统一走 publishCaptionSegment，翻译开启时同步送入翻译队列。
      publishTranslatedCaptionSegment(session, event.segment);
    } else if (event.type === 'media-control') {
      void controlBrowserLiveMedia(session, event.action);
    } else if (event.text) {
      void queueLiveMessage(session, { type: 'BSCG_LIVE_PROGRESS', text: event.text });
    }
  }, session.browserControl).then((result) => {
    if (!session.finished) void finalizeLiveCapture(session, result);
  }).catch((error) => {
    if (session.finished) return;
    if (session.stopRequested) {
      void finalizeLiveCapture(session, { segments: session.rows });
      return;
    }
    if (!isDirectAudioFailure(error)) {
      void failLiveCapture(session, error?.message || String(error));
      return;
    }
    void (async () => {
      const diagnostics = error?.metrics || {};
      pushLog('warn', `[${source.platform || 'web'}/direct] 整轨直取失败，候选=${source.candidates?.length || 0} ` +
        `探测=${Number(diagnostics.directProbesStarted) || 0} 下载=${Number(diagnostics.directCandidatesTried) || 0} ` +
        `最后=${diagnostics.lastAudioCandidate || 'unknown'}；切换实时取音：${error?.message || error}`);
      const retainedRows = session.rows.slice();
      session.translator?.cancel?.();
      session.finished = true;
      releaseBorrowedTask(session);
      await controlBrowserLiveMedia(session, 'resume').catch(() => {});
      if (liveCaptures.get(tab.id) === session) liveCaptures.delete(tab.id);
      schedulePendingBrowserSettingsRestart();
      if (!await isLiveStartCurrent(tab.id, startRequest)) return;
      await sendLive(tab.id, {
        type: 'BSCG_LIVE_PROGRESS',
        text: `整轨直取不可用，已自动切到浏览器实时取音：${error?.message || String(error)}`
      });
      try {
        await startBrowserCapturedLiveCapture(tab, settings, null, retainedRows, { startRequest });
      } catch (captureError) {
        await sendLive(tab.id, { type: 'BSCG_LIVE_ERROR', error: captureError?.message || String(captureError) });
      }
    })();
  });
  return {
    ok: true,
    sessionId: session.sessionId,
    mode: 'timeline',
    aheadSeconds: BROWSER_DIRECT_LEAD_SECONDS,
    segments: translateActiveConfig(settings).enabled ? [] : seededRows,
    queued: Number(session.browserControl.queueAhead) > 0,
    queuePosition: Number(session.browserControl.queuePosition) || 0,
    queueAhead: Number(session.browserControl.queueAhead) || 0,
    queueBlocker: String(session.browserControl.queueBlocker || '')
  };
}

async function startBrowserCapturedLiveCapture(tab, settings, borrowTask = null, initialRows = [], options = {}) {
  const clock = options.clock || await getVideoClock(tab.id);
  const policy = options.policy || liveCapturePolicy(tab.url, clock);
  const cached = policy.isLive ? null : await latestResultForTab(tab.id, tab.url).catch(() => null);
  if (policy.isLive) { borrowTask = null; initialRows = []; }
  const cachedOriginals = cached?.originalSegments || cached?.segments;
  const cachedRows = Array.isArray(cachedOriginals)
    ? cachedOriginals.map((row) => ({ ...row, content: cleanDisplayCaption(row.content) })).filter((row) => row.content)
    : [];
  const seededRows = cachedRows.concat(borrowedTaskRows(borrowTask), initialRows || [])
    .sort((a, b) => Number(a.from) - Number(b.from))
    .filter((row, index, rows) => {
      const previous = rows[index - 1];
      return !previous || Math.abs(Number(previous.from) - Number(row.from)) > 0.03 || previous.content !== row.content;
    }).slice(-MAX_LIVE_ROWS);
  const url = new URL(tab.url || 'https://invalid.local/');
  let sourcePlatform = 'web';
  let sourceVideoId = '';
  let sourcePartId = '';
  if (policy.roomId) {
    sourcePlatform = 'bilibili-live';
    sourceVideoId = policy.roomId;
    sourcePartId = policy.roomId;
  } else if (url.hostname === 'www.bilibili.com') {
    sourcePlatform = 'bilibili';
    sourceVideoId = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || '';
    sourcePartId = `${sourceVideoId}:p${Math.max(1, Number(url.searchParams.get('p')) || 1)}`;
  } else if (/(^|\.)youtube\.com$/i.test(url.hostname)) {
    sourcePlatform = 'youtube';
    sourceVideoId = url.searchParams.get('v') || url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
    sourcePartId = sourceVideoId;
  }
  if (!sourceVideoId) sourceVideoId = await sourceHash(tab.url);
  if (!sourcePartId) sourcePartId = sourceVideoId;
  const mediaKey = buildMediaKey({ platform: sourcePlatform, pageUrl: tab.url, videoId: sourceVideoId, partId: sourcePartId });
  await injectLiveOverlay(tab.id);
  if (!await isLiveStartCurrent(tab.id, options.startRequest)) return { ok: true, superseded: true };
  const session = {
    mode: 'browser-capture', backend: 'browser', sessionId: crypto.randomUUID(), tabId: tab.id,
    title: tab.title || '在线视频', sourceUrl: tab.url, sourcePlatform, sourceVideoId, sourcePartId,
    mediaKey, documentId: currentDocumentId(tab.id),
    mediaDuration: Number(clock?.duration) || 0,
    settings, rows: seededRows, displayPending: null, bufferedTo: 0,
    previewSegment: null,
    currentVideoTime: clock.currentTime, playbackRate: clock.playbackRate, paused: clock.paused,
    isLive: policy.isLive, overlayOnTop: Boolean(policy.overlayOnTop), fullTrack: !policy.isLive && clock.currentTime <= 1,
    finished: false, stopRequested: false, browserControl: { abort: null }
  };
  liveCaptures.set(tab.id, session);
  attachBorrowedTask(session, borrowTask);
  await sendLive(tab.id, { type: 'BSCG_LIVE_STARTED', sessionId: session.sessionId, mode: policy.isLive ? 'live' : 'capture', overlayOnTop: Boolean(policy.overlayOnTop), segments: translateActiveConfig(settings).enabled ? [] : seededRows });
  configureSessionTranslator(session, settings);
  if (policy.isLive) pushLog('info', `[live] 直播实时字幕 source=${sourcePlatform} room=${policy.roomId || 'generic'}；复用 capture → PCM → ASR 链路`);
  void browserTranscribeRequest({
    tabId: tab.id,
    captureOnly: true,
    isLive: policy.isLive,
    asrProfile: settings.asrProfile || DEFAULTS.asrProfile,
    backendMode: browserBackendMode(settings),
    cpuThreads: Number(settings.recognitionThreads) || 0,
    asrLanguage: settings.asrLanguage || 'auto',
    voiceEnhance: Boolean(settings.voiceEnhance),
    voiceEnhancePreset: settings.voiceEnhancePreset || 'balanced',
    chunkSeconds: Number(settings.liveChunkSeconds) || SENSEVOICE_LIVE_WINDOW_SECONDS,
    initialClock: clock,
    clockIndependent: Boolean(policy.overlayOnTop),
    // B站/YouTube 的 MSE 播放器优先 captureStream() 复制音频，避免
    // tabCapture 接管/归还扬声器时造成画面或声音抖动。
    preferInPageCapture: policy.preferInPageCapture,
    requireCopyStream: policy.requireCopyStream,
    title: session.title,
    sourceUrl: tab.url,
    mediaKey: session.mediaKey,
    documentId: session.documentId,
    jobId: session.sessionId
  }, (event) => {
    if (session.finished) return;
    if (event.type === 'queue') {
      void queueLiveMessage(session, {
        type: 'BSCG_LIVE_QUEUED',
        text: event.text,
        queuePosition: Number(event.queuePosition) || 0,
        queueAhead: Number(event.queueAhead) || 0,
        queueBlocker: String(event.queueBlocker || '')
      });
    } else if (event.type === 'segment' && event.segment?.content) {
      if (!translateActiveConfig(session.settings).enabled) session.publishCaptionSegment(event.segment);
    } else if (event.type === 'final' && event.segment?.content) {
      // 【ASR 定稿观测点】识别侧"草稿→定稿→存储"的定稿一环：断句原因直接回答
      // "这句话为什么在这里被切开"。max-window=硬窗强切（语义碎片高发）、
      // silence/strong-silence=静音端点、pause=播放暂停。reason/audioSeconds
      // 只进日志，剥离后不再向字幕链路（翻译/上屏/导出）传播。
      const { reason: phraseReason, audioSeconds: phraseAudioSeconds, timing: phraseTiming, timedSegments, ...finalSegment } = event.segment;
      pushLog('info', `[asr/final] 断句=${phraseReason || 'manual'} ` +
        `音频=${(Number(phraseAudioSeconds) || 0).toFixed(1)}s id=${finalSegment.id} ` +
        `timing=${JSON.stringify(phraseTiming || {})} · ${String(finalSegment.content).replace(/\s+/g, ' ').slice(0, 40)}`);
      session.captureCoverage ||= [];
      session.captureCoverage.push({ from: finalSegment.from, to: finalSegment.to });
      session.captureCoverage.sort((a, b) => a.from - b.from);
      session.captureCoverage = session.captureCoverage.reduce((ranges, range) => {
          const last = ranges.at(-1);
          if (last && range.from <= last.to + 0.05) last.to = Math.max(last.to, range.to);
          else ranges.push({ ...range });
          return ranges;
      }, []).slice(-MAX_LIVE_ROWS);
      if (translateActiveConfig(session.settings).enabled) {
        session.bufferedTo = Math.max(Number(session.bufferedTo) || 0, Number(finalSegment.to) || 0);
        // Only acoustic sentence boundaries may split a final. Never distribute
        // translated characters across the whole capture window.
        const units = finalCaptionUnits({ ...finalSegment, timedSegments });
        session.translator?.clearPreview?.(finalSegment.id);
        units.forEach(row => {
          if (session.translator && !session.translator.isStopped()) session.translator.final?.(row);
          else session.originalCaptionRows.set(Number(row.from).toFixed(3), {
            from: row.from, to: row.to, content: row.content
          });
        });
      }
      else void queueLiveMessage(session, { type: 'BSCG_LIVE_FINAL', segment: finalSegment });
    } else if (event.type === 'preview' && event.segment?.content) {
      if (translateActiveConfig(session.settings).enabled) {
        session.translator?.preview?.(event.segment);
        return;
      }
      session.previewSegment = event.segment;
      void queueLiveMessage(session, {
        type: 'BSCG_LIVE_PREVIEW',
        sessionId: session.sessionId,
        previewId: event.segment.id,
        revision: event.segment.revision,
        segment: event.segment
      });
    } else if (event.type === 'preview-clear') {
      if (translateActiveConfig(session.settings).enabled) {
        session.translator?.clearPreview?.(event.previewId);
        return;
      }
      if (!event.previewId || session.previewSegment?.id === event.previewId) session.previewSegment = null;
      void queueLiveMessage(session, {
        type: 'BSCG_LIVE_PREVIEW_CLEAR',
        sessionId: session.sessionId,
        previewId: event.previewId || '',
        revision: Number(event.revision) || 0
      });
    } else if (event.type === 'media-control') {
      void controlBrowserLiveMedia(session, event.action);
    } else if (event.text) {
      void queueLiveMessage(session, { type: 'BSCG_LIVE_PROGRESS', text: event.text });
    }
  }, session.browserControl).then((result) => {
    if (!session.finished) void finalizeLiveCapture(session, result);
  }).catch((error) => {
    if (session.finished) return;
    if (session.stopRequested) {
      void finalizeLiveCapture(session, { segments: session.rows });
      return;
    }
    void failLiveCapture(session, error?.message || String(error));
  });
  return {
    ok: true,
    sessionId: session.sessionId,
    mode: policy.isLive ? 'live' : 'capture',
    segments: translateActiveConfig(settings).enabled ? [] : seededRows,
    queued: Number(session.browserControl.queueAhead) > 0,
    queuePosition: Number(session.browserControl.queuePosition) || 0,
    queueAhead: Number(session.browserControl.queueAhead) || 0,
    queueBlocker: String(session.browserControl.queueBlocker || '')
  };
}

async function startBorrowedBrowserLiveSession(tab, settings, borrowTask) {
  const clock = await getVideoClock(tab.id);
  const seededRows = borrowedTaskRows(borrowTask).slice(-MAX_LIVE_ROWS);
  await injectLiveOverlay(tab.id);
  const session = {
    mode: 'browser-borrow', backend: 'borrow', sessionId: crypto.randomUUID(), tabId: tab.id,
    title: tab.title || '在线视频', sourceUrl: tab.url,
    sourcePlatform: borrowTask.sourcePlatform || 'web', sourceVideoId: borrowTask.sourceVideoId,
    sourcePartId: borrowTask.sourcePartId || borrowTask.sourceVideoId,
    mediaKey: borrowTask.mediaKey || buildMediaKey({
      platform: borrowTask.sourcePlatform || 'web', pageUrl: tab.url,
      videoId: borrowTask.sourceVideoId, partId: borrowTask.sourcePartId || borrowTask.sourceVideoId
    }),
    mediaDuration: Number(borrowTask.mediaDuration) || 0,
    documentId: currentDocumentId(tab.id, borrowTask.documentId),
    settings, rows: seededRows, displayPending: null, bufferedTo: seededRows.at(-1)?.to || 0,
    currentVideoTime: clock.currentTime, playbackRate: clock.playbackRate, paused: clock.paused,
    finished: false, stopRequested: false
  };
  liveCaptures.set(tab.id, session);
  attachBorrowedTask(session, borrowTask);
  await sendLive(tab.id, { type: 'BSCG_LIVE_STARTED', sessionId: session.sessionId, mode: 'timeline', segments: translateActiveConfig(settings).enabled ? [] : seededRows });
  await sendLive(tab.id, { type: 'BSCG_LIVE_PROGRESS', text: '正在复用完整转写任务；不会重复启动第二个识别引擎。' });
  configureSessionTranslator(session, settings);
  session.borrowWatch = setInterval(() => {
    if (session.finished) return;
    if (activeTranscriptions.has(borrowTask.taskId)) return;
    clearInterval(session.borrowWatch);
    session.borrowWatch = 0;
    void finalizeLiveCapture(session, { segments: session.rows });
  }, 800);
  return { ok: true, sessionId: session.sessionId, mode: 'timeline', borrowed: true, segments: translateActiveConfig(settings).enabled ? [] : seededRows };
}

async function handleLiveSeek(tabId, currentTime) {
  const session = liveCaptures.get(tabId);
  if (!session || session.finished) return { ok: true, ignored: true };
  if (session.isLive) return { ok: true, ignored: true };
  session.currentVideoTime = Math.max(0, currentTime);
  const recognizedTo = Math.max(Number(session.lookaheadMetrics?.recognizedTo) || 0, Number(session.bufferedTo) || 0);
  const cachedDirectSeek = session.mode === 'browser-direct' &&
    session.currentVideoTime >= Number(session.directCoverageStart ?? Infinity) && session.currentVideoTime < recognizedTo;
  if (session.mode === 'browser-direct' || session.mode === 'browser-capture') {
    session.translationSeekAnchor = session.currentVideoTime;
    session.lookaheadMetrics = { anchor: session.currentVideoTime, recognizedTo: cachedDirectSeek ? recognizedTo : session.currentVideoTime,
      translatedContiguousTo: session.currentVideoTime };
    if (session.mode === 'browser-capture' && session.translator && !session.translator.isStopped()) {
      session.translator.seek();
    } else configureSessionTranslator(session, session.settings);
  }
  pushLog('info', `[session] 拖动到 ${currentTime.toFixed(1)} 秒 tab=${session.tabId} mode=${session.mode}`);
  if (session.mode === 'browser-direct') {
    if (cachedDirectSeek) {
      session.translator?.tick?.();
      await sendLive(tabId, { type: 'BSCG_LIVE_PROGRESS', text: `已跳转到 ${formatTime(currentTime)}，复用已有字幕并继续预翻译。` });
      return { ok: true, cached: true };
    }
    session.directCoverageStart = session.currentVideoTime;
    session.displayPending = null;
    session.bufferedTo = session.currentVideoTime;
    if (session.currentVideoTime > 1) session.fullTrack = false;
    session.browserControl.pendingSeekTime = session.currentVideoTime;
    const engineSessionId = String(session.browserControl.engineSessionId || '');
    const engineSession = engineSessionId ? browserEngineSessions.get(engineSessionId) : null;
    if (!engineSession || engineSession.settled) {
      await sendLive(tabId, {
        type: 'BSCG_LIVE_PROGRESS',
        text: `已记录跳转位置 ${formatTime(currentTime)}，任务启动后从这里继续…`
      });
      return { ok: true, deferred: true };
    }
    engineSession.directGeneration = (engineSession.directGeneration || 0) + 1;
    const response = await sendToOffscreen({
      type: 'BILI_ASR_DIRECT_SEEK', tabId: session.tabId,
      sessionId: engineSessionId, currentTime: session.currentVideoTime,
      directGeneration: engineSession.directGeneration
    }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
    if (!response?.ok) {
      pushLog('warn', `[session] 忽略已失效的拖动请求 tab=${session.tabId} engine=${engineSessionId}：${response?.error || '引擎会话已结束'}`);
      return { ok: true, ignored: true };
    }
    await sendLive(tabId, { type: 'BSCG_LIVE_PROGRESS', text: `已跳转到 ${formatTime(currentTime)}，正在重新生成前瞻字幕…` });
  } else if (session.mode === 'browser-capture') {
    session.fullTrack = false;
    session.displayPending = null;
    session.previewSegment = null;
    session.finalSegment = null;
    await queueLiveMessage(session, { type: 'BSCG_LIVE_PREVIEW_CLEAR', sessionId: session.sessionId });
    let cachedThrough = session.currentVideoTime;
    for (const row of session.captureCoverage?.length ? session.captureCoverage : session.rows) {
      if (row.from <= cachedThrough + 0.01 && row.to > cachedThrough) cachedThrough = row.to;
    }
    await sendToOffscreen({
      type: 'BILI_ASR_CLOCK', tabId: session.tabId,
      sessionId: session.browserControl?.engineSessionId || session.sessionId,
      mediaKey: session.mediaKey,
      currentTime: session.currentVideoTime, playbackRate: session.playbackRate, paused: session.paused,
      seek: true, cachedThrough
    }).catch(() => null);
  }
  return { ok: true };
}

async function requestLiveStop(tabId, message = {}) {
  await setCaptionDisplay(tabId, false, message);
  const session = liveCaptures.get(tabId);
  if (!session || session.finished) return { ok: true, ignored: true };
  if (session.stopRequested) return { ok: true, stopping: true };
  session.stopRequested = true;
  session.translator?.cancel?.();
  pushLog('info', `[session] 用户停止 tab=${session.tabId} mode=${session.mode}`);
  await sendLive(tabId, { type: 'BSCG_LIVE_PROGRESS', text: '正在处理最后一个音频分段…' });
  if (session.mode === 'browser-borrow') {
    await finalizeLiveCapture(session, { segments: session.rows });
    return { ok: true, stopping: false };
  }
  if (session.mode === 'browser-direct' || session.mode === 'browser-capture') {
    const hasEngineSession = [...browserEngineSessions.values()].some((candidate) => candidate.tabId === session.tabId && !candidate.settled);
    if (session.browserControl?.queueState === 'queued' || (session.browserControl?.queueState === 'running' && !hasEngineSession)) {
      session.browserControl.abort?.('用户取消了排队中的字幕任务');
      await finalizeLiveCapture(session, { segments: session.rows });
      return { ok: true, stopping: false };
    }
    const input = browserEngineSessions.get(session.browserControl?.engineSessionId || '');
    if (input?.externalCapture && Number.isInteger(input.scanFrameId)) {
      // Flush the producer before closing the consumer, including its final
      // sub-frame. CAPTURE_ENDED may finish the engine during this await.
      await chrome.tabs.sendMessage(session.tabId, {
        type: 'BSCG_INPAGE_CAPTURE_STOP', sessionId: input.sessionId
      }, { frameId: input.scanFrameId }).catch(() => null);
      if (session.finished) return { ok: true, stopping: false };
    }
    const response = await sendToOffscreen({
      type: 'BILI_ASR_STOP', tabId: session.tabId,
      sessionId: session.browserControl?.engineSessionId || session.sessionId,
      reason: 'user'
    }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
    if (session.finished) return { ok: true, stopping: false };
    session.stopTimer = setTimeout(() => {
      if (session.finished) return;
      session.browserControl?.abort?.('浏览器字幕停止收尾超时');
      void finalizeLiveCapture(session, { segments: session.rows });
    }, 12000);
    return { ok: true, stopping: true, warning: response?.ok ? '' : response?.error || '浏览器引擎正在后台收尾' };
  }
  await finalizeLiveCapture(session, { segments: session.rows });
  return { ok: true, stopping: false };
}

async function shouldAutoStartCaptions(tab) {
  if (!tab?.id || !/^(https?|file):/i.test(tab.url || '')) return false;
  if (!bscgPageAllowsControls(tab.url)) return false;
  if (!tab.active) return false;
  if (Number.isInteger(tab.windowId) && !(await chrome.windows.get(tab.windowId)).focused) return false;
  if (liveCaptures.has(tab.id)) return false;
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  const url = new URL(tab.url);
  if (url.hostname === 'live.bilibili.com') return Boolean(liveCapturePolicy(tab.url).roomId && settings.autoCaptionsMainstream);
  if (url.hostname === 'www.bilibili.com' || /(^|\.)youtube\.com$/i.test(url.hostname)) {
    if (!settings.autoCaptionsMainstream) return false;
    try {
      const cached = await latestResultForTab(tab.id);
      if (cached?.segments?.length) return false; // 已经有生成过的结果，不重复启动
    } catch {}
    if (url.hostname === 'www.bilibili.com') {
      const bvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1];
      if (!bvid) return false;
      const playerState = await getCurrentPlayerState(tab.id, bvid).catch(() => null);
      return Boolean(playerState && !playerState.hasSubtitleControl);
    }
    const videoId = url.searchParams.get('v') || url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
    if (!videoId) return false;
    const state = await getYouTubePlayerState(tab.id, videoId).catch(() => null);
    return Boolean(state && state.hasVideo && (state.captions || []).length === 0);
  }
  return Boolean(settings.autoCaptionsOther);
}

async function isLiveStartCurrent(tabId, message = {}) {
  if (message.startRevision != null && message.startRevision !== liveStartRevision) return false;
  if (message.automatic) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.active) return false;
    if (Number.isInteger(tab.windowId) && !(await chrome.windows.get(tab.windowId).catch(() => null))?.focused) return false;
  }
  return message.startRevision == null || message.startRevision === liveStartRevision;
}

async function startLiveCapture(tabId, ignoreCache = false, message = {}) {
  if (message.automatic && !await isLiveStartCurrent(tabId, message)) return { ok: true, superseded: true };
  const revision = ++liveStartRevision;
  const start = async () => {
    if (revision !== liveStartRevision) return { ok: true, superseded: true };
    return startLiveCaptureNow(tabId, ignoreCache, { ...message, startRevision: revision });
  };
  const result = liveStartChain.then(start, start);
  liveStartChain = result.catch(() => {});
  return result;
}

async function handoffLiveCaptures(tab, message) {
  if (!await isLiveStartCurrent(tab.id, message)) return false;
  for (const session of [...liveCaptures.values()]) {
    if (session.tabId === tab.id || session.finished) continue;
    session.stopRequested = true;
    session.stopReason = 'tab-switch';
    await queueLiveMessage(session, { type: 'BSCG_LIVE_HANDOFF', text: '字幕已切换到新页面' });
    await setCaptionDisplay(session.tabId, false, {}).catch(() => null);
    const engine = browserEngineSessions.get(session.browserControl?.engineSessionId || '');
    if (engine && !engine.settled) {
      await sendToOffscreen({ type: 'BILI_ASR_STOP', tabId: session.tabId,
        sessionId: engine.sessionId, reason: 'tab-switch' }).catch(() => null);
      if (engine.externalCapture && Number.isInteger(engine.scanFrameId)) {
        await chrome.tabs.sendMessage(session.tabId, { type: 'BSCG_INPAGE_CAPTURE_STOP', sessionId: engine.sessionId },
          { frameId: engine.scanFrameId }).catch(() => null);
      }
      if (!engine.settled) finishBrowserEngineSession(engine, browserTaskCancelledError('字幕已切换到新页面'));
    } else if (session.mode !== 'browser-borrow') {
      session.browserControl?.abort?.('字幕已切换到新页面');
    }
    await finalizeLiveCapture(session, { segments: session.rows, reason: 'tab-switch' });
  }
  return message.startRevision === liveStartRevision;
}

async function startLiveCaptureNow(tabId, ignoreCache = false, message = {}) {
  if (!tabId) throw new Error('无法识别当前标签页');
  currentDocumentId(tabId, message.documentId);
  await setCaptionDisplay(tabId, true, message);
  if (liveCaptures.has(tabId)) {
    const existingSession = liveCaptures.get(tabId);
    if (!existingSession.stopRequested) return { ok: true, alreadyRunning: true, mode: existingSession.mode };
    // 用户刚点停止又立刻重新启动（最近选择为准）：等上一轮收尾完成后重开新会话。
    const deadline = Date.now() + 13000;
    while (liveCaptures.has(tabId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (liveCaptures.has(tabId)) return { ok: true, alreadyRunning: true, mode: liveCaptures.get(tabId).mode };
  }
  const tab = await chrome.tabs.get(tabId);
  if (message.automatic && !tab.active) return { ok: true, superseded: true };
  if (!tab.url && message.pageUrl) tab.url = message.pageUrl;
  if (!/^(https?|file):/i.test(tab.url || '')) throw new Error('当前页面不支持实时字幕');
  const settings = await settingsForVideo(tabId, tab.url, {
    ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS)))
  });
  const initialPolicy = liveCapturePolicy(tab.url, null, message);
  if (initialPolicy.directory) throw new Error('请先从直播首页进入具体直播间，开始播放后再点击“字幕”');
  const liveClock = await getVideoClock(tabId).catch(() => null);
  const capturePolicy = liveCapturePolicy(tab.url, liveClock, message);
  pushLog('info', `[media/route] version=${BG_VERSION} 请求=${message.captureMode || 'video'} ` +
    `kind=${liveClock?.kind || 'unknown'} 时长=${Number(liveClock?.duration) || 0}s 实时=${capturePolicy.isLive}`);
  if (capturePolicy.isLive) {
    if (!await handoffLiveCaptures(tab, message)) return { ok: true, superseded: true };
    ensureTaskSlot();
    return startBrowserCapturedLiveCapture(tab, settings, null, [], { clock: liveClock, policy: capturePolicy, startRequest: message });
  }
  // 已有完整字幕结果（右侧总结曾生成过，或上次实时识别的结果）时直接复用，不再重新识别。
  if (!ignoreCache) {
    const cached = await latestResultForTab(tabId, tab.url).catch(() => null);
    if (cached?.segments?.length) {
      return startCachedCaptionSession(tab, settings, cached.originalSegments || cached.segments, cached);
    }
  }
  // 同视频的完整转写正在后台进行（例如刚点过"总结"）：把已生成的分段实时借给
  // 字幕会话，已生成区域立即可见/可预览，后续分段随转写进度实时推进，不重复等。
  let borrowTask = null;
  if (!ignoreCache) {
    const task = findTabTranscription(tabId);
    if (task && resultMatchesTabUrl(task, tab.url)) borrowTask = task;
  }
  if (borrowTask) return startBorrowedBrowserLiveSession(tab, settings, borrowTask);
  if (!await handoffLiveCaptures(tab, message)) return { ok: true, superseded: true };
  ensureTaskSlot();
  if (liveClock?.kind === 'audio') {
    return startBrowserCapturedLiveCapture(tab, settings, null, [], { clock: liveClock, policy: capturePolicy, startRequest: message });
  }
  try {
    const browserSource = await prepareBrowserDirectSource(tab, message);
    if (!await isLiveStartCurrent(tabId, message)) return { ok: true, superseded: true };
    if (browserSource?.candidates?.length) {
      pushLog('info', `[media/route] 滚动前瞻候选=${browserSource.candidates.length} ` +
        `首选=${browserSource.candidates[0].kind} 时长=${Number(browserSource.duration) || 0}s`);
      return await startBrowserDirectLive(tab, settings, browserSource, null, message);
    }
    pushLog('warn', '[media/route] 未发现与当前播放器对应的可重放媒体地址，切到实时取音');
  } catch (error) {
    pushLog('warn', `[media/route] 前瞻准备失败：${error?.message || String(error)}`);
    await sendLive(tabId, { type: 'BSCG_LIVE_PROGRESS', text: `浏览器整轨直取暂不可用，准备实时后备：${error?.message || String(error)}` });
  }
  if (!await isLiveStartCurrent(tabId, message)) return { ok: true, superseded: true };
  return startBrowserCapturedLiveCapture(tab, settings, null, [], { startRequest: message });
}


async function openFeedbackPage(tabId, error = '') {
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const settings = await chrome.storage.local.get(['asrProfile', 'asrBackend']);
  const diagnostics = BscgFeedback.report({
    version: BG_VERSION, site: tab?.url || '', profile: settings.asrProfile || DEFAULTS.asrProfile,
    backend: settings.asrBackend || DEFAULTS.asrBackend,
    browser: navigator.userAgent, logs: await getLogs(), error
  });
  const id = crypto.randomUUID();
  const saved = await chrome.storage.session.get('feedbackDraftIds');
  const ids = Array.isArray(saved.feedbackDraftIds) ? saved.feedbackDraftIds : [];
  const expired = ids.splice(0, Math.max(0, ids.length - 7));
  if (expired.length) await chrome.storage.session.remove(expired.map(id => `feedbackDraft:${id}`));
  await chrome.storage.session.set({ [`feedbackDraft:${id}`]: diagnostics, feedbackDraftIds: [...ids, id] });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`feedback.html?draft=${encodeURIComponent(id)}`) });
  return { ok: true };
}
