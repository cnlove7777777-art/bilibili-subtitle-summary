'use strict';

// Keep the selectable models here. New entries need a Transformers.js-compatible
// ONNX repository, a pinned revision, and a dtype supported by that repository.
const BSCG_ONNX_TRANSLATION_MODELS = Object.freeze({
  'qwen3-0.6b-q4f16': Object.freeze({
    label: 'Qwen3-0.6B · WebGPU Q4F16 (约 570 MB)',
    repo: 'onnx-community/Qwen3-0.6B-ONNX',
    revision: '558750086ed49d78cb701ed6fa85af33fd16453f',
    dtype: 'q4f16',
    device: 'webgpu'
  })
});

globalThis.BSCG_ONNX_TRANSLATION_MODELS = BSCG_ONNX_TRANSLATION_MODELS;
if (typeof module !== 'undefined' && module.exports) module.exports = BSCG_ONNX_TRANSLATION_MODELS;
