'use strict';

// Runs in the existing offscreen document, alongside the ASR WebGPU worker.
// Translation jobs share the background subtitle batching and result validation.
let onnxTranslationWorker = null;
let onnxTranslationModel = '';
let onnxTranslationBusy = 0;
let onnxTranslationSequence = 0;
let onnxTranslationIdleTimer = null;
const onnxTranslationPending = new Map();

function stopOnnxTranslationWorker(reason = '模型已切换') {
  if (onnxTranslationIdleTimer) clearTimeout(onnxTranslationIdleTimer);
  onnxTranslationIdleTimer = null;
  onnxTranslationWorker?.terminate();
  onnxTranslationWorker = null;
  onnxTranslationModel = '';
  for (const pending of onnxTranslationPending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  onnxTranslationPending.clear();
  onnxTranslationBusy = 0;
}

function getOnnxTranslationWorker(model) {
  if (!globalThis.BSCG_ONNX_TRANSLATION_MODELS[model]) throw new Error(`未知 ONNX 翻译模型：${model}`);
  if (onnxTranslationWorker && onnxTranslationModel !== model) stopOnnxTranslationWorker();
  if (onnxTranslationIdleTimer) clearTimeout(onnxTranslationIdleTimer);
  onnxTranslationIdleTimer = null;
  if (!onnxTranslationWorker) {
    const worker = new Worker(chrome.runtime.getURL('translate-onnx-worker.js'), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data?.type === 'progress') return;
      const pending = onnxTranslationPending.get(data?.id);
      if (!pending) return;
      if (data.type === 'started') {
        clearTimeout(pending.timer);
        // A hard watchdog covers a hung GPU dispatch (decode guards cannot run
        // while ONNX is stuck). Download time is excluded from this deadline.
        pending.timer = setTimeout(() => stopOnnxTranslationWorker('ONNX 推理超时，已回收 Worker'),
          pending.realtime ? 6000 : 120000);
        return;
      }
      onnxTranslationPending.delete(data.id);
      clearTimeout(pending.timer);
      onnxTranslationBusy = Math.max(0, onnxTranslationBusy - 1);
      if (!onnxTranslationBusy) {
        onnxTranslationIdleTimer = setTimeout(() => stopOnnxTranslationWorker('空闲模型已释放'), 2 * 60 * 1000);
      }
      if (data.type === 'result') pending.resolve(data.texts);
      else pending.reject(new Error(data.error || 'ONNX 翻译失败'));
    };
    worker.onerror = (event) => stopOnnxTranslationWorker(event.message || 'ONNX Worker 发生错误');
    onnxTranslationWorker = worker;
    onnxTranslationModel = model;
  }
  return onnxTranslationWorker;
}

function runOnnxTranslation(message) {
  const worker = getOnnxTranslationWorker(message.model);
  const id = ++onnxTranslationSequence;
  onnxTranslationBusy += 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopOnnxTranslationWorker('ONNX 翻译超时（20 分钟，含首次模型下载）');
    }, 20 * 60 * 1000);
    onnxTranslationPending.set(id, { resolve, reject, timer, realtime: Boolean(message.realtime) });
    worker.postMessage({ type: 'translate', id, model: message.model, lines: message.lines,
      sourceLanguage: message.sourceLanguage, targetLanguage: message.targetLanguage,
      realtime: Boolean(message.realtime), qualityRetry: Boolean(message.qualityRetry) });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'offscreen' && message.type === 'BILI_ASR_TRANSLATE_ONNX_STATUS') {
    sendResponse({ ok: true, busy: onnxTranslationBusy > 0 });
    return false;
  }
  if (message?.target !== 'offscreen' || message.type !== 'BILI_ASR_TRANSLATE_ONNX') return false;
  runOnnxTranslation(message).then((texts) => sendResponse({ ok: true, texts }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
