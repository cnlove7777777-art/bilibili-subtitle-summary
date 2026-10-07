'use strict';

import { env, pipeline } from './vendor/transformers.min.js';
import './translate-onnx-models.js';
import { translateOnnxLines } from './translate-onnx-core.js';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('vendor/', self.location.href).href;
env.backends.onnx.wasm.numThreads = 1;

let generator = null;
let currentModel = '';
let loading = null;
let queue = Promise.resolve();

async function loadModel(modelId) {
  const spec = globalThis.BSCG_ONNX_TRANSLATION_MODELS[modelId];
  if (!spec) throw new Error(`未知 ONNX 翻译模型：${modelId}`);
  if (!navigator.gpu) throw new Error('当前浏览器未提供 WebGPU');
  if (generator && currentModel === modelId) return generator;
  if (!loading) {
    loading = pipeline('text-generation', spec.repo, {
      device: spec.device, dtype: spec.dtype, revision: spec.revision,
      progress_callback: (progress) => self.postMessage({ type: 'progress', progress })
    }).then((result) => {
      generator = result;
      currentModel = modelId;
      return result;
    }).finally(() => { loading = null; });
  }
  return loading;
}

async function translate(message) {
  const model = await loadModel(message.model);
  self.postMessage({ type: 'started', id: message.id });
  const texts = await translateOnnxLines(model, message.lines, message.targetLanguage, message.sourceLanguage,
    { realtime: message.realtime, qualityRetry: message.qualityRetry });
  self.postMessage({ type: 'result', id: message.id, texts });
}

self.addEventListener('message', ({ data }) => {
  if (data?.type !== 'translate') return;
  queue = queue.catch(() => {}).then(() => translate(data)).catch((error) => {
    self.postMessage({ type: 'error', id: data.id, error: error?.message || String(error) });
  });
});
