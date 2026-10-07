'use strict';

import { FFT, InferenceSession, Tensor, ortEnv } from './asr-worker.js';

const SAMPLE_RATE = 16000;
const N_FFT = 400;
const HOP_LENGTH = 160;
const N_MELS = 128;
const MIN_AUDIO_SAMPLES = 8000;
const AUDIO_FRAME_MULTIPLE = 800;
const AUDIO_TOKENS_PER_WINDOW = 104;
const HIDDEN_SIZE = 1024;
const NUM_LAYERS = 28;
const NUM_KV_HEADS = 8;
const HEAD_DIM = 128;
const MAX_NEW_TOKENS = 128;
const MASKED_FP16 = -65504;
const EOS_TOKEN_IDS = new Set([151643, 151645]);
const SPECIAL_TOKEN_IDS = Object.freeze({
  imStart: 151644,
  imEnd: 151645,
  audioStart: 151669,
  audioEnd: 151670,
  audioPad: 151676,
  newline: 198
});

const MODEL_REVISION = '62493632e19acdf7b4a5733a2d4a032cf1abce90';
const MODEL_ROOT = `https://huggingface.co/goryodog/tokihisu-qwen3-asr-0.6b-webgpu/resolve/${MODEL_REVISION}`;
const CACHE_NAME = 'bscg-qwen3-asr-0.6b-webgpu-fp16-6249363-v1';
const OLD_CACHE_NAMES = ['bscg-qwen3-asr-webgpu-v1'];
const FILES = Object.freeze({
  encoderGraph: { remote: 'onnx/audio_encoder_fp16.onnx', size: 316850 },
  encoderData: { remote: 'onnx/audio_encoder_fp16.onnx_data', size: 372749504 },
  decoderGraph: { remote: 'onnx/decoder_with_past_fp16.onnx', size: 1325505 },
  decoderData: { remote: 'onnx/decoder_with_past_fp16.onnx_data', size: 1503250432 },
  tokenizer: { remote: 'processor/tokenizer.json', size: 11429653 }
});
for (const file of Object.values(FILES)) file.url = `${MODEL_ROOT}/${file.remote}`;
const TOTAL_MODEL_BYTES = Object.values(FILES).reduce((sum, file) => sum + file.size, 0);

let encoderSession = null;
let decoderSession = null;
let tokenizer = null;
let metrics = {};
let queue = Promise.resolve();
let aggregateLoaded = 0;
let gpuAdapter = null;
let activeRequest = null;
const halfFloatView = new Float32Array(1);
const halfIntView = new Uint32Array(halfFloatView.buffer);

const fft = new FFT(N_FFT);
const hannWindow = Float64Array.from({ length: N_FFT }, (_, index) =>
  0.5 - 0.5 * Math.cos(2 * Math.PI * index / N_FFT));

function emit(type, extra = {}) {
  self.postMessage({ type, ...extra });
}

function errorText(error) {
  return error?.stack || error?.message || String(error);
}

function heapMetrics() {
  const memory = performance?.memory;
  return memory ? {
    workerHeapUsed: Number(memory.usedJSHeapSize) || 0,
    workerHeapTotal: Number(memory.totalJSHeapSize) || 0,
    workerHeapLimit: Number(memory.jsHeapSizeLimit) || 0
  } : {};
}

function configureOrtRuntime(baseUrl = '') {
  const extensionRoot = new URL('./', baseUrl || self.location.href).href;
  ortEnv.logLevel = 'warning';
  ortEnv.wasm.proxy = false;
  ortEnv.wasm.initTimeout = 180000;
  ortEnv.wasm.numThreads = 1;
  // WebGPU 仍要加载 ORT 的 WASM 核心。若不显式指定，动态 import
  // 会错误地查找扩展根目录下的 mjs，而运行库实际打包在 vendor/。
  ortEnv.wasm.wasmPaths = {
    mjs: new URL('vendor/ort-wasm-simd-threaded.asyncify.mjs', extensionRoot).href,
    wasm: new URL('vendor/ort-wasm-simd-threaded.asyncify.wasm', extensionRoot).href
  };
}

function progress(file, loaded, status) {
  const current = aggregateLoaded + Math.max(0, Number(loaded) || 0);
  emit('progress', {
    backend: 'webgpu', status, file: file.remote,
    loaded: current, total: TOTAL_MODEL_BYTES,
    progress: Math.min(100, current / TOTAL_MODEL_BYTES * 100)
  });
}

async function readWithProgress(response, file) {
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  let loaded = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loaded += value.byteLength;
      progress(file, loaded, 'downloading');
      controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return new Response(stream).arrayBuffer();
}

async function loadBytes(file) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(file.url);
  if (cached) {
    progress(file, 0, 'cached');
    const buffer = await cached.arrayBuffer();
    if (buffer.byteLength !== file.size) {
      await cache.delete(file.url);
      emit('cache-warning', {
        file: file.remote,
        error: `缓存大小不符，已删除并重新下载（预期 ${file.size}，实际 ${buffer.byteLength}）`
      });
    } else {
      aggregateLoaded += buffer.byteLength;
      progress(file, 0, 'cached');
      return new Uint8Array(buffer);
    }
  }

  let response;
  try {
    response = await fetch(file.url, { cache: 'no-store', redirect: 'follow' });
  } catch (error) {
    throw new Error(`下载 ${file.remote} 网络请求失败：${errorText(error)}；URL=${file.url}`);
  }
  if (!response.ok) throw new Error(`下载 ${file.remote} 失败：HTTP ${response.status}`);
  const cacheWrite = cache.put(file.url, response.clone()).catch((error) => {
    emit('cache-warning', { file: file.remote, error: errorText(error) });
  });
  const buffer = await readWithProgress(response, file);
  await cacheWrite;
  if (buffer.byteLength !== file.size) {
    await cache.delete(file.url);
    throw new Error(`Qwen FP16 下载文件大小不符：${file.remote}，预期 ${file.size}，实际 ${buffer.byteLength}`);
  }
  aggregateLoaded += buffer.byteLength;
  progress(file, 0, 'downloaded');
  return new Uint8Array(buffer);
}

function adapterDescription(adapter, info = {}) {
  return [...new Set([
    info.vendor, info.architecture, info.device, info.description, info.type,
    info.driver, info.backend
  ].filter(Boolean).map(String))].join(' · ') ||
    (adapter?.isFallbackAdapter ? 'WebGPU fallback adapter' : 'WebGPU adapter');
}

async function requestFp16Adapter() {
  if (!navigator.gpu) throw new Error('当前 Chrome 没有暴露 WebGPU；Qwen GPU 版不会尝试 INT8 图。');
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
    forceFallbackAdapter: false
  });
  if (!adapter) throw new Error('Chrome 没有返回高性能 GPUAdapter。');
  if (!adapter.features?.has('shader-f16')) {
    throw new Error(`当前 ${adapterDescription(adapter)} 不支持 shader-f16，无法运行 Qwen3-ASR FP16。`);
  }
  let info = adapter.info || {};
  if (!Object.values(info).some(Boolean) && typeof adapter.requestAdapterInfo === 'function') {
    try { info = await adapter.requestAdapterInfo(); } catch {}
  }
  return { adapter, info, description: adapterDescription(adapter, info) };
}

function hzToMel(frequency) {
  const fSp = 200 / 3;
  if (frequency < 1000) return frequency / fSp;
  return 15 + Math.log(frequency / 1000) / (Math.log(6.4) / 27);
}

function melToHz(mel) {
  const fSp = 200 / 3;
  if (mel < 15) return mel * fSp;
  return 1000 * Math.exp((Math.log(6.4) / 27) * (mel - 15));
}

function createMelFilters() {
  const minMel = hzToMel(0);
  const maxMel = hzToMel(SAMPLE_RATE / 2);
  const points = Float64Array.from({ length: N_MELS + 2 }, (_, index) =>
    melToHz(minMel + (maxMel - minMel) * index / (N_MELS + 1)));
  const frequencies = Float64Array.from({ length: N_FFT / 2 + 1 }, (_, index) =>
    index * SAMPLE_RATE / N_FFT);
  return Array.from({ length: N_MELS }, (_, melIndex) => {
    const left = points[melIndex];
    const center = points[melIndex + 1];
    const right = points[melIndex + 2];
    const norm = 2 / Math.max(Number.EPSILON, right - left);
    return Float64Array.from(frequencies, (frequency) =>
      Math.max(0, Math.min((frequency - left) / (center - left), (right - frequency) / (right - center))) * norm);
  });
}

const melFilters = createMelFilters();
const sparseMelFilters = melFilters.map((filter) => {
  const bins = [];
  for (let bin = 0; bin < filter.length; bin += 1) if (filter[bin] !== 0) bins.push(bin);
  return { bins, weights: bins.map((bin) => filter[bin]) };
});

function reflectIndex(index, length) {
  if (length <= 1) return 0;
  let value = index;
  // torch.stft(center=true, pad_mode="reflect") excludes the edge sample:
  // -1 -> 1 and length -> length - 2.
  while (value < 0 || value >= length) value = value < 0 ? -value : 2 * length - value - 2;
  return value;
}

function logMelSpectrogram(audio) {
  const frameCount = Math.max(1, Math.floor(audio.length / HOP_LENGTH));
  const output = new Float32Array(N_MELS * frameCount);
  const frame = new Float64Array(N_FFT);
  const spectrum = new Float64Array(fft.outputBufferSize);
  const power = new Float64Array(N_FFT / 2 + 1);
  let globalMax = -Infinity;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * HOP_LENGTH - N_FFT / 2;
    for (let index = 0; index < N_FFT; index += 1) {
      frame[index] = audio[reflectIndex(start + index, audio.length)] * hannWindow[index];
    }
    fft.realTransform(spectrum, frame);
    for (let bin = 0; bin < power.length; bin += 1) {
      const real = spectrum[bin * 2];
      const imaginary = spectrum[bin * 2 + 1];
      power[bin] = real * real + imaginary * imaginary;
    }
    for (let mel = 0; mel < N_MELS; mel += 1) {
      let energy = 0;
      const filter = sparseMelFilters[mel];
      for (let index = 0; index < filter.bins.length; index += 1) {
        energy += filter.weights[index] * power[filter.bins[index]];
      }
      const value = Math.log10(Math.max(1e-10, energy));
      output[mel * frameCount + frameIndex] = value;
      globalMax = Math.max(globalMax, value);
    }
  }

  const floor = globalMax - 8;
  for (let index = 0; index < output.length; index += 1) {
    output[index] = (Math.max(output[index], floor) + 4) / 4;
  }
  return { data: output, frames: frameCount };
}

function floatToHalf(value) {
  halfFloatView[0] = value;
  const bits = halfIntView[0];
  const sign = (bits >>> 16) & 0x8000;
  const floatExponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (floatExponent === 0xff) return mantissa ? sign | 0x7e00 : sign | 0x7c00;

  const exponent = floatExponent - 127;
  if (exponent > 15) return sign | 0x7c00;
  // Exponent -25 still needs rounding against half of the smallest fp16
  // subnormal (2^-25); only smaller exponents are guaranteed to underflow.
  if (exponent < -25) return sign;

  if (exponent < -14) {
    const significand = mantissa | 0x800000;
    const shift = -exponent - 1;
    let halfMantissa = significand >>> shift;
    const remainderMask = (1 << shift) - 1;
    const remainder = significand & remainderMask;
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && (halfMantissa & 1))) halfMantissa += 1;
    return sign | halfMantissa;
  }

  let halfExponent = exponent + 15;
  let halfMantissa = mantissa >>> 13;
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && (halfMantissa & 1))) {
    halfMantissa += 1;
    if (halfMantissa === 0x400) {
      halfMantissa = 0;
      halfExponent += 1;
      if (halfExponent >= 31) return sign | 0x7c00;
    }
  }
  return sign | (halfExponent << 10) | halfMantissa;
}

function halfToFloat(value) {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x3ff;
  if (!exponent) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function toHalfArray(values) {
  const output = new Uint16Array(values.length);
  for (let index = 0; index < values.length; index += 1) output[index] = floatToHalf(values[index]);
  return output;
}

function buildPaddedMel(audio) {
  // Qwen3ASRFeatureExtractor pads sub-500 ms clips to 8000 samples before
  // STFT. The padded samples intentionally remain valid in the mel mask.
  let waveform = audio;
  if (audio.length < MIN_AUDIO_SAMPLES) {
    waveform = new Float32Array(MIN_AUDIO_SAMPLES);
    waveform.set(audio);
  }
  const mel = logMelSpectrogram(waveform);
  const paddedFrames = Math.max(AUDIO_FRAME_MULTIPLE,
    Math.ceil(mel.frames / AUDIO_FRAME_MULTIPLE) * AUDIO_FRAME_MULTIPLE);
  const padded = new Uint16Array(N_MELS * paddedFrames);
  for (let melIndex = 0; melIndex < N_MELS; melIndex += 1) {
    const sourceOffset = melIndex * mel.frames;
    const targetOffset = melIndex * paddedFrames;
    for (let frameIndex = 0; frameIndex < mel.frames; frameIndex += 1) {
      padded[targetOffset + frameIndex] = floatToHalf(mel.data[sourceOffset + frameIndex]);
    }
  }
  const mask = new Int32Array(paddedFrames);
  mask.fill(1, 0, mel.frames);
  return { features: padded, mask, frames: mel.frames, paddedFrames };
}

function buildPromptIds(audioTokenCount) {
  const ids = [
    SPECIAL_TOKEN_IDS.imStart, 9125, SPECIAL_TOKEN_IDS.newline,
    SPECIAL_TOKEN_IDS.imEnd, SPECIAL_TOKEN_IDS.newline,
    SPECIAL_TOKEN_IDS.imStart, 882, SPECIAL_TOKEN_IDS.newline,
    SPECIAL_TOKEN_IDS.audioStart
  ];
  const audioOffset = ids.length;
  for (let index = 0; index < audioTokenCount; index += 1) ids.push(SPECIAL_TOKEN_IDS.audioPad);
  ids.push(
    SPECIAL_TOKEN_IDS.audioEnd, SPECIAL_TOKEN_IDS.imEnd, SPECIAL_TOKEN_IDS.newline,
    SPECIAL_TOKEN_IDS.imStart, 77091, SPECIAL_TOKEN_IDS.newline
  );
  return { ids: Int32Array.from(ids), audioOffset };
}

function causalMask(sequenceLength, pastLength) {
  const totalLength = pastLength + sequenceLength;
  const masked = floatToHalf(MASKED_FP16);
  const data = new Uint16Array(sequenceLength * totalLength);
  for (let row = 0; row < sequenceLength; row += 1) {
    const rowOffset = row * totalLength;
    // Typed arrays start at zero: only write the dummy past token and future.
    data[rowOffset] = masked;
    data.fill(masked, rowOffset + pastLength + row + 1, rowOffset + totalLength);
  }
  return new Tensor('float16', data, [1, 1, sequenceLength, totalLength]);
}

function positionIds(start, length) {
  return new Tensor('int32', Int32Array.from({ length }, (_, index) => start + index), [1, length]);
}

function emptyPast() {
  const feeds = {};
  for (let layer = 0; layer < NUM_LAYERS; layer += 1) {
    feeds[`past.${layer}.key`] = new Tensor('float16', new Uint16Array(NUM_KV_HEADS * HEAD_DIM), [1, NUM_KV_HEADS, 1, HEAD_DIM]);
    feeds[`past.${layer}.value`] = new Tensor('float16', new Uint16Array(NUM_KV_HEADS * HEAD_DIM), [1, NUM_KV_HEADS, 1, HEAD_DIM]);
  }
  return feeds;
}

function argmaxLogits(tensor) {
  const data = tensor.data;
  const vocabSize = tensor.dims[tensor.dims.length - 1];
  const offset = data.length - vocabSize;
  let bestIndex = 0;
  if (data instanceof Uint16Array) {
    // IEEE half bits are ordered by magnitude within each sign. Compare keys
    // directly, preserving signed-zero ties and ignoring NaNs like the FP32 path.
    let bestKey = 0x0400; // negative infinity
    for (let index = 0; index < vocabSize; index += 1) {
      const bits = data[offset + index];
      const magnitude = bits & 0x7fff;
      if (magnitude > 0x7c00) continue;
      const key = bits & 0x8000 ? 0x8000 - magnitude : 0x8000 + magnitude;
      if (key > bestKey) { bestKey = key; bestIndex = index; }
    }
    return bestIndex;
  }
  let bestValue = -Infinity;
  for (let index = 0; index < vocabSize; index += 1) {
    const value = Number(data[offset + index]);
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function disposePast(past) {
  for (const tensor of Object.values(past || {})) {
    try { tensor.dispose(); } catch {}
  }
}

function disposeTensorGroups(...groups) {
  const tensors = new Set(groups.flatMap((group) => Object.values(group || {})));
  for (const tensor of tensors) {
    try { tensor?.dispose(); } catch {}
  }
}

function checkCancelled(shouldCancel) {
  if (!shouldCancel()) return;
  const error = new Error('识别已取消');
  error.name = 'AbortError';
  throw error;
}

function disposeNonPastFeeds(feeds) {
  for (const [name, tensor] of Object.entries(feeds || {})) {
    if (name.startsWith('past.')) continue;
    try { tensor.dispose(); } catch {}
  }
}

function nextPast(outputs) {
  const past = {};
  for (let layer = 0; layer < NUM_LAYERS; layer += 1) {
    past[`past.${layer}.key`] = outputs[`present.${layer}.key`];
    past[`past.${layer}.value`] = outputs[`present.${layer}.value`];
  }
  return past;
}

function buildByteDecoder() {
  const visible = [];
  for (let value = 33; value <= 126; value += 1) visible.push(value);
  for (let value = 161; value <= 172; value += 1) visible.push(value);
  for (let value = 174; value <= 255; value += 1) visible.push(value);
  const bytes = visible.slice();
  const codepoints = visible.slice();
  let extra = 0;
  for (let value = 0; value < 256; value += 1) {
    if (bytes.includes(value)) continue;
    bytes.push(value);
    codepoints.push(256 + extra++);
  }
  return new Map(codepoints.map((codepoint, index) => [String.fromCodePoint(codepoint), bytes[index]]));
}

const byteDecoder = buildByteDecoder();

function parseQwenAsrText(raw) {
  const text = String(raw || '').replace(/<\|[^|]+\|>/g, '').trim();
  // The language header is model metadata. Preserve the boundary until after
  // byte decoding (it may be an added special token or several normal tokens).
  const boundary = text.indexOf('<asr_text>');
  return (boundary >= 0 ? text.slice(boundary + '<asr_text>'.length) : text).trim();
}

function createTokenizer(config) {
  const byId = [];
  const specials = new Set();
  for (const [token, id] of Object.entries(config?.model?.vocab || {})) byId[Number(id)] = token;
  for (const token of config?.added_tokens || []) {
    byId[Number(token.id)] = token.content;
    if (token.special) specials.add(Number(token.id));
  }
  if (!byId.length) throw new Error('Qwen tokenizer.json 没有可用词表');
  const encoder = new TextEncoder();
  const tokenBytes = new Map();
  function bytesFor(id) {
    if (tokenBytes.has(id)) return tokenBytes.get(id);
    const token = byId[id];
    const bytes = [];
    if (typeof token === 'string' && (!specials.has(id) || token === '<asr_text>')) {
      for (const character of token) {
        const byte = byteDecoder.get(character);
        if (byte !== undefined) bytes.push(byte);
        else bytes.push(...encoder.encode(character));
      }
    }
    const result = Uint8Array.from(bytes);
    tokenBytes.set(id, result);
    return result;
  }
  return {
    // Each transcription owns its stream. Consume only newly appended tokens;
    // TextDecoder retains incomplete UTF-8 bytes across token boundaries.
    createStream() {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let consumed = 0;
      let raw = '';
      return {
        decode(ids) {
          for (; consumed < ids.length; consumed++) {
            raw += decoder.decode(bytesFor(ids[consumed]), { stream: true });
          }
          return raw.includes('<asr_text>') ? parseQwenAsrText(raw).replace(/\uFFFD+$/u, '') : '';
        }
      };
    },
    decode(ids, { partial = false } = {}) {
      const bytes = [];
      for (const id of ids) for (const byte of bytesFor(id)) bytes.push(byte);
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));
      // Do not stream the language header or an incomplete UTF-8 character.
      if (partial && !raw.includes('<asr_text>')) return '';
      return parseQwenAsrText(raw).replace(/\uFFFD+$/u, '');
    }
  };
}

async function encodeAudio(audio, report = () => {}) {
  report('features');
  const mel = buildPaddedMel(audio);
  const feeds = {
    input_features: new Tensor('float16', mel.features, [1, N_MELS, mel.paddedFrames]),
    input_features_mask: new Tensor('int32', mel.mask, [1, mel.paddedFrames])
  };
  report('encoder');
  let outputs;
  try {
    outputs = await encoderSession.run(feeds);
    const embeddings = outputs.audio_embeddings;
    const tokenMask = outputs.audio_token_mask;
    if (!embeddings || !tokenMask) throw new Error('Qwen FP16 音频编码器输出不完整');
    const maskData = tokenMask.data;
    const raw = embeddings.data;
    const tokenCapacity = Math.floor(raw.length / HIDDEN_SIZE);
    const validIndexes = [];
    for (let index = 0; index < Math.min(tokenCapacity, maskData.length); index += 1) {
      if (Number(maskData[index])) validIndexes.push(index);
    }
    if (!validIndexes.length || validIndexes.length > Math.ceil(mel.paddedFrames / AUDIO_FRAME_MULTIPLE) * AUDIO_TOKENS_PER_WINDOW) {
      throw new Error(`Qwen FP16 音频 token mask 无效：${validIndexes.length}`);
    }
    const compact = new Uint16Array(validIndexes.length * HIDDEN_SIZE);
    for (let index = 0; index < validIndexes.length; index += 1) {
      const sourceStart = validIndexes[index] * HIDDEN_SIZE;
      const targetStart = index * HIDDEN_SIZE;
      if (raw instanceof Uint16Array) {
        compact.set(raw.subarray(sourceStart, sourceStart + HIDDEN_SIZE), targetStart);
      } else {
        for (let hidden = 0; hidden < HIDDEN_SIZE; hidden += 1) {
          compact[targetStart + hidden] = floatToHalf(Number(raw[sourceStart + hidden]));
        }
      }
    }
    return compact;
  } finally {
    disposeTensorGroups(feeds, outputs);
  }
}

async function generate(audio, report = () => {}, onPartial = () => {}, shouldCancel = () => false, maxTokens = MAX_NEW_TOKENS) {
  let past = {};
  let feeds;
  let outputs;
  try {
    checkCancelled(shouldCancel);
    const compactAudio = await encodeAudio(audio, report);
    checkCancelled(shouldCancel);
    const audioTokenCount = compactAudio.length / HIDDEN_SIZE;
    const prompt = buildPromptIds(audioTokenCount);
    const sequenceLength = prompt.ids.length;
    const alignedAudio = new Uint16Array(sequenceLength * HIDDEN_SIZE);
    alignedAudio.set(compactAudio, prompt.audioOffset * HIDDEN_SIZE);
    const audioMask = new Uint16Array(sequenceLength);
    audioMask.fill(floatToHalf(1), prompt.audioOffset, prompt.audioOffset + audioTokenCount);
    past = emptyPast();
    let pastLength = 1;
    feeds = {
      input_ids: new Tensor('int32', prompt.ids, [1, sequenceLength]),
      audio_embeddings: new Tensor('float16', alignedAudio, [1, sequenceLength, HIDDEN_SIZE]),
      audio_mask: new Tensor('float16', audioMask, [1, sequenceLength, 1]),
      attention_mask: causalMask(sequenceLength, pastLength),
      position_ids: positionIds(0, sequenceLength),
      ...past
    };
    report('prefill');
    outputs = await decoderSession.run(feeds);
    checkCancelled(shouldCancel);
    disposeNonPastFeeds(feeds);
    disposePast(past);
    past = nextPast(outputs);
    pastLength += sequenceLength;
    let nextToken = argmaxLogits(outputs.logits);
    try { outputs.logits.dispose(); } catch {}
    const generated = [nextToken];
    report('decode');
    onPartial(generated);

    for (let step = 1; step < maxTokens && !EOS_TOKEN_IDS.has(nextToken); step += 1) {
      checkCancelled(shouldCancel);
      feeds = {
        input_ids: new Tensor('int32', Int32Array.of(nextToken), [1, 1]),
        audio_embeddings: new Tensor('float16', new Uint16Array(HIDDEN_SIZE), [1, 1, HIDDEN_SIZE]),
        audio_mask: new Tensor('float16', new Uint16Array(1), [1, 1, 1]),
        attention_mask: causalMask(1, pastLength),
        position_ids: positionIds(pastLength - 1, 1),
        ...past
      };
      // Clear the previous output map before awaiting the next allocation.
      outputs = null;
      outputs = await decoderSession.run(feeds);
      checkCancelled(shouldCancel);
      disposeNonPastFeeds(feeds);
      disposePast(past);
      past = nextPast(outputs);
      pastLength += 1;
      nextToken = argmaxLogits(outputs.logits);
      try { outputs.logits.dispose(); } catch {}
      generated.push(nextToken);
      onPartial(generated);
      if (step % 8 === 0) report('decode');
    }
    while (generated.length && EOS_TOKEN_IDS.has(generated[generated.length - 1])) generated.pop();
    return tokenizer.decode(generated);
  } finally {
    disposeTensorGroups(feeds, past, outputs);
  }
}

async function initialize(message) {
  if (message.mode === 'wasm') throw new Error('Qwen3-ASR 仅支持 WebGPU FP16，不提供 WASM CPU 链路。');
  if (encoderSession && decoderSession && tokenizer) {
    emit('ready', { metrics: { ...metrics, warmModel: true, ...heapMetrics() } });
    return;
  }
  await dispose();
  try {
    const startedAt = performance.now();
    aggregateLoaded = 0;
    emit('status', {
      status: 'loading', backend: 'webgpu',
      statusText: '正在初始化 Qwen3-ASR 0.6B FP16/WebGPU（首次约下载 1.89 GB）…'
    });
    try { await navigator.storage?.persist?.(); } catch {}
    const adapterInfo = await requestFp16Adapter();
    gpuAdapter = adapterInfo.adapter;
    configureOrtRuntime(message.baseUrl);
    ortEnv.webgpu.powerPreference = 'high-performance';
    ortEnv.webgpu.forceFallbackAdapter = false;
    ortEnv.webgpu.adapter = gpuAdapter;

    // Create each session before fetching the next large external-data file.
    // Passing Uint8Array also avoids Blob.arrayBuffer() duplicating 1.5 GB.
    emit('status', { status: 'loading', backend: 'webgpu', statusText: '正在载入 Qwen FP16 音频编码器…' });
    let encoderGraph = await loadBytes(FILES.encoderGraph);
    let encoderData = await loadBytes(FILES.encoderData);
    encoderSession = await InferenceSession.create(encoderGraph, {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
      externalData: [{ path: 'audio_encoder_fp16.onnx_data', data: encoderData }]
    });
    encoderGraph = null;
    encoderData = null;

    emit('status', { status: 'loading', backend: 'webgpu', statusText: '正在载入 Qwen FP16 28 层解码器…' });
    let decoderGraph = await loadBytes(FILES.decoderGraph);
    let decoderData = await loadBytes(FILES.decoderData);
    const outputLocations = { logits: 'cpu' };
    for (let layer = 0; layer < NUM_LAYERS; layer += 1) {
      outputLocations[`present.${layer}.key`] = 'gpu-buffer';
      outputLocations[`present.${layer}.value`] = 'gpu-buffer';
    }
    decoderSession = await InferenceSession.create(decoderGraph, {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
      externalData: [{ path: 'decoder_with_past_fp16.onnx_data', data: decoderData }],
      preferredOutputLocation: outputLocations
    });
    decoderGraph = null;
    decoderData = null;

    const tokenizerBytes = await loadBytes(FILES.tokenizer);
    tokenizer = createTokenizer(JSON.parse(new TextDecoder('utf-8').decode(tokenizerBytes)));
    const expectedEncoderInputs = ['input_features', 'input_features_mask'];
    if (!expectedEncoderInputs.every((name) => encoderSession.inputNames.includes(name))) {
      throw new Error(`Qwen FP16 音频编码器输入不匹配：${encoderSession.inputNames.join(', ')}`);
    }
    if (!['input_ids', 'audio_embeddings', 'audio_mask', 'attention_mask', 'position_ids']
      .every((name) => decoderSession.inputNames.includes(name))) {
      throw new Error(`Qwen FP16 解码器输入不匹配：${decoderSession.inputNames.slice(0, 8).join(', ')}`);
    }
    metrics = {
      engine: 'Qwen3-ASR-0.6B', backend: 'webgpu', precision: 'fp16',
      device: adapterInfo.description,
      adapterVendor: String(adapterInfo.info?.vendor || ''),
      adapterType: String(adapterInfo.info?.type || ''),
      fallbackAdapter: Boolean(gpuAdapter.isFallbackAdapter),
      fp16: true,
      threads: 0,
      crossOriginIsolated: Boolean(self.crossOriginIsolated),
      hardwareConcurrency: Number(navigator.hardwareConcurrency) || 1,
      modelBytes: TOTAL_MODEL_BYTES,
      modelRevision: MODEL_REVISION,
      modelLoadMs: performance.now() - startedAt,
      ...heapMetrics()
    };
    emit('ready', { metrics });
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function transcribe(message) {
  if (!encoderSession || !decoderSession || !tokenizer) throw new Error('Qwen3-ASR FP16 模型尚未初始化');
  const audio = new Float32Array(message.audio);
  const startedAt = performance.now();
  const request = { sessionId: message.sessionId, preview: Boolean(message.preview), cancelled: false };
  activeRequest = request;
  let lastPartialAt = -Infinity;
  let lastPartialText = '';
  let partialIndex = 0;
  let firstPartialMs = 0;
  const partialDecoder = message.stream ? tokenizer.createStream?.() : null;
  try {
    const text = await generate(audio, (phase) => emit('inference-progress', {
      sessionId: message.sessionId, phraseId: message.phraseId,
      preview: Boolean(message.preview), previewToken: message.previewToken || null,
      previewRevision: Number(message.previewRevision) || 0,
      phase, backend: 'webgpu'
    }), (ids) => {
      if (!message.stream || request.cancelled || performance.now() - lastPartialAt < 120) return;
      const partial = partialDecoder ? partialDecoder.decode(ids) : tokenizer.decode(ids, { partial: true });
      if (!partial || partial === lastPartialText) return;
      lastPartialAt = performance.now();
      lastPartialText = partial;
      if (!firstPartialMs) firstPartialMs = lastPartialAt - startedAt;
      emit('partial-result', {
        sessionId: message.sessionId, phraseId: message.phraseId,
        preview: Boolean(message.preview), previewToken: message.previewToken || null,
        previewRevision: Number(message.previewRevision) || 0,
        previewStartVideo: Number(message.previewStartVideo), previewEndVideo: Number(message.previewEndVideo),
        partialIndex: ++partialIndex, text: partial, firstPartialMs, backend: 'webgpu'
      });
    }, () => request.cancelled, message.preview
      ? Math.min(96, Math.max(32, Math.ceil(audio.length / SAMPLE_RATE * 12) + 16))
      : MAX_NEW_TOKENS);
    emit('result', {
      sessionId: message.sessionId,
      phraseId: message.phraseId,
      text,
      chunks: [],
      audioSeconds: audio.length / SAMPLE_RATE,
      inferenceMs: performance.now() - startedAt,
      backend: 'webgpu',
      preview: Boolean(message.preview),
      previewToken: message.previewToken || null,
      previewRevision: Number(message.previewRevision) || 0,
      previewStartVideo: Number(message.previewStartVideo),
      previewEndVideo: Number(message.previewEndVideo),
      direct: Boolean(message.direct),
      metrics: { ...metrics, firstPartialMs, streamedUpdates: partialIndex, ...heapMetrics() }
    });
  } finally {
    if (activeRequest === request) activeRequest = null;
  }
}

async function dispose() {
  try { await encoderSession?.release(); } catch {}
  try { await decoderSession?.release(); } catch {}
  encoderSession = null;
  decoderSession = null;
  tokenizer = null;
  metrics = {};
  gpuAdapter = null;
}

async function clearCache() {
  await dispose();
  const names = await caches.keys();
  const targets = names.filter((name) => name === CACHE_NAME || OLD_CACHE_NAMES.includes(name));
  await Promise.all(targets.map((name) => caches.delete(name)));
  emit('cache-cleared', { deletedCaches: targets });
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') self.addEventListener('message', (event) => {
  const message = event.data || {};
  // Cancellation must bypass the inference queue so it can stop token decoding.
  if (message.type === 'qwen-cancel-session' || message.type === 'qwen-cancel-preview') {
    if (activeRequest?.sessionId === message.sessionId &&
        (message.type === 'qwen-cancel-session' || activeRequest.preview)) activeRequest.cancelled = true;
    if (message.type === 'qwen-cancel-session') {
      queue = queue.then(() => emit('session-cancelled', { sessionId: message.sessionId }));
    }
    return;
  }
  queue = queue.then(async () => {
    if (message.type === 'qwen-init') await initialize(message);
    else if (message.type === 'qwen-transcribe') await transcribe(message);
    else if (message.type === 'qwen-clear-cache') await clearCache();
    else if (message.type === 'qwen-dispose') {
      await dispose();
      emit('disposed');
    }
  }).catch(async (error) => {
    const fatal = /out[ -]of[ -]memory|\bOOM\b|device.{0,20}lost|GPUDevice.{0,30}destroyed/i.test(errorText(error));
    if (fatal) await dispose();
    emit('error', {
      requestType: String(message.type || '').replace(/^qwen-/, ''),
      sessionId: message.sessionId,
      phraseId: message.phraseId,
      preview: Boolean(message.preview),
      previewToken: message.previewToken || null,
      previewRevision: Number(message.previewRevision) || 0,
      error: errorText(error),
      cancelled: error?.name === 'AbortError', fatal,
      backend: 'webgpu',
      metrics: { ...metrics, ...heapMetrics() }
    });
  });
});

export {
  buildPaddedMel,
  buildPromptIds,
  createTokenizer,
  parseQwenAsrText,
  floatToHalf,
  halfToFloat,
  logMelSpectrogram,
  reflectIndex
};
