// Run: node tests/model-bootstrap.mjs
// Executes the production downloader and engine with Cache/Fetch/Worker doubles.
// Only weight sizes are reduced to 64 bytes; no model or user audio is uploaded.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFileSync(root + name, 'utf8');
let fixtures = 0;
const downloadSource = read('model-download.js').replace(
  /(asset\('[^']+', '[^']+', '[^']+', )\d+(, \[)/g,
  (_, start, end) => { fixtures++; return start + '64' + end; });
assert.equal(fixtures, 10, 'all model assets use small fixture bodies');
const tests = [];
const test = (name, run) => tests.push({ name, run });
let cleanups = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate) {
  const end = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() > end) throw new Error('fixture did not reach the expected state');
    await tick();
  }
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const abortable = (signal) => new Promise((_, reject) => {
  const abort = () => reject(new DOMException('fixture abort', 'AbortError'));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
});

function harness(options = {}) {
  const stores = new Map(), events = [], requests = [], probes = [], workers = [], commits = [];
  const timers = new Set(), intervals = new Set();
  let clock = null;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        match: async url => store.get(url)?.clone(),
        delete: async url => store.delete(url),
        put: async (url, response) => {
          const bytes = await response.arrayBuffer(); // Cache.put publishes atomically.
          store.set(url, new Response(bytes, { headers: response.headers }));
          commits.push({ url, bytes: bytes.byteLength });
        }
      };
    },
    delete: async name => stores.delete(name),
    keys: async () => [...stores.keys()]
  };
  const adapter = options.adapter === undefined ? { features: new Set(['shader-f16']), info: {} } : options.adapter;
  const navigator = {
    storage: { persist: async () => true, estimate: async () => ({ usage: 0, quota: 10 ** 10 }) },
    ...(options.noGpu ? {} : { gpu: { requestAdapter: async spec => {
      probes.push(spec);
      if (options.gpuRequest) return options.gpuRequest();
      return adapter;
    } } })
  };
  const context = vm.createContext({
    console, self: {}, caches, navigator, crypto: webcrypto,
    AbortController, DOMException, Headers, Response, Blob, TransformStream, ReadableStream,
    Uint8Array, Float32Array, Int32Array, ArrayBuffer, TextDecoder, TextEncoder, URL,
    performance: { now: () => clock ?? performance.now() },
    setTimeout(fn, ms) {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id); return id;
    },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); },
    setInterval(fn, ms) { const id = setInterval(fn, ms); intervals.add(id); return id; },
    clearInterval(id) { clearInterval(id); intervals.delete(id); },
    fetch: async (url, init = {}) => {
      const request = { url: String(url), ...init, range: Boolean(init.headers?.Range) };
      requests.push(request);
      if (options.fetch) return options.fetch(request);
      return new Response(new Uint8Array(64), { status: request.range ? 206 : 200 });
    },
    chrome: { runtime: {
      getURL: file => `chrome-extension://fixture/${file}`,
      onMessage: { addListener() {} }, sendMessage: async message => { events.push(message); }
    } },
    Worker: class {
      constructor(url) { this.url = url; this.listeners = {}; this.messages = []; workers.push(this); }
      addEventListener(type, callback) { this.listeners[type] = callback; }
      terminate() { this.terminated = true; }
      postMessage(message) {
        this.messages.push(message);
        if (!['init', 'qwen-init'].includes(message.type)) return;
        options.onInit?.(message, stores);
        queueMicrotask(() => {
          if (this.terminated) return;
          const error = options.workerError?.(message);
          this.listeners.message({ data: error
            ? { type: 'error', requestType: 'init', error }
            : { type: 'ready', metrics: { backend: message.mode, precision: message.mode === 'wasm' ? 'int8' : 'fp16' } } });
        });
      }
    }
  });
  vm.runInContext(downloadSource, context);
  vm.runInContext(read('browser-engine.js') + `
    globalThis.audit = { initializeModel, initializeModelWithFallback, cancelInitialization,
      beginDirectSession, updateAudioDownloadProgress,
      state: value => {activeSession=value;}, benchmark: value => {benchmarkRun=value;},
      current: () => activeSession, waiter: () => initWaiter };
    downloadDirectAudio = async () => new ArrayBuffer(16);
    decodeDirectAudio = async state => { state.metrics.capturedAudioSeconds=1; return new Float32Array(16000); };
    processDirectVoice = async () => {};
    prepareCompleteDirectSegments = () => {};
    dispatchNextDirectSegment = state => { globalThis.continued=state; };
  `, context);
  const manager = context.self.BscgModelDownload;
  cleanups.push(async () => {
    context.audit.cancelInitialization('test cleanup');
    await manager.cancel();
    for (const timer of timers) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
  });
  return { ...context.audit, context, manager, caches, stores, requests, events, probes, workers, commits,
    now: value => { clock = value; },
    makeState(overrides = {}) {
      const state = { sessionId: 'first', tabId: 1, asrProfile: 'sensevoice_browser', backendMode: 'webgpu',
        stopping: false, sourceMode: 'direct', metrics: {}, cues: [], ...overrides };
      context.audit.state(state);
      return state;
    },
    async seed(route, { legacy = false, size = 64 } = {}) {
      for (const file of manager.assets.filter(file => file.routes.includes(route))) {
        const cache = await caches.open(file.cacheName);
        await cache.put(file.canonicalUrl, new Response(new Uint8Array(size), {
          headers: legacy ? {} : { 'x-bscg-model-size': String(size) }
        }));
      }
    }
  };
}

test('Fresh GPU captions auto-download only their route via mirror and resume the original direct task', async () => {
  const h = harness({
    fetch: request => {
      if (request.url.startsWith('https://huggingface.co/')) throw new TypeError('Failed to fetch');
      return new Response(new Uint8Array(64), { status: request.range ? 206 : 200 });
    },
    onInit: (_message, stores) => assert.equal(stores.get('browser-sensevoice-v2').size, 4)
  });
  const response = await h.beginDirectSession({ sessionId: 'direct', tabId: 1,
    directSource: { candidates: [{ url: 'https://media.test/audio' }] } });
  assert.equal(response.ok, true);
  await until(() => Boolean(h.context.continued));
  assert.equal(h.context.continued.sessionId, 'direct');
  assert.equal(h.probes[0].powerPreference, 'high-performance');
  assert.equal(h.probes[0].forceFallbackAdapter, false);
  assert.deepEqual(Array.from(h.manager.snapshot().completedRoutes), ['sense-webgpu']);
  assert.equal(h.requests.filter(request => !request.range && request.url.includes('hf-mirror.com')).length, 4);
  assert.ok(h.requests.every(request => !/model\.int8\.onnx|qwen3-asr/.test(request.url)));
  assert.equal(h.workers.length, 1);
  assert.ok(h.events.some(event => event.modelPreparation && /缓存/.test(event.statusText)));
  assert.ok(h.events.some(event => event.event === 'direct-ready'));
});

test('Missing GPU, missing FP16 and fallback adapters choose CPU before any GPU weights download', async () => {
  for (const config of [{ noGpu: true }, { adapter: null }, { adapter: { features: new Set() } },
    { adapter: { features: new Set(['shader-f16']), isFallbackAdapter: true } }]) {
    const h = harness(config);
    const state = h.makeState();
    await h.initializeModelWithFallback(state);
    assert.equal(state.backendMode, 'wasm');
    assert.deepEqual(Array.from(h.manager.snapshot().completedRoutes), ['sense-wasm']);
    assert.ok(h.requests.every(request => !/\/model\.onnx(?:\.data)?$/.test(request.url)));
    assert.equal(h.workers[0].messages[0].mode, 'wasm');
  }
});

test('Explicit CPU skips GPU detection; an explicit Qwen selection is preserved', async () => {
  const cpu = harness();
  await cpu.initializeModelWithFallback(cpu.makeState({ backendMode: 'wasm' }));
  assert.equal(cpu.probes.length, 0);
  assert.deepEqual(Array.from(cpu.manager.snapshot().completedRoutes), ['sense-wasm']);
  const qwen = harness();
  await qwen.initializeModelWithFallback(qwen.makeState({ asrProfile: 'qwen3_asr_0_6b' }));
  assert.equal(qwen.workers[0].messages[0].type, 'qwen-init');
  assert.deepEqual(Array.from(qwen.manager.snapshot().completedRoutes), ['qwen-webgpu']);
  assert.ok(qwen.requests.every(request => request.url.includes('qwen3-asr')));
});

test('Strict GPU benchmark and Qwen do not silently run CPU when GPU is unavailable', async () => {
  const h = harness({ noGpu: true });
  const state = h.makeState();
  h.state(null);
  h.benchmark({ id: state.sessionId, status: 'running' });
  await assert.rejects(h.initializeModel(state), error => error.code === 'WEBGPU_UNAVAILABLE');
  await assert.rejects(h.initializeModelWithFallback(h.makeState({ asrProfile: 'qwen3_asr_0_6b' })),
    error => error.code === 'WEBGPU_UNAVAILABLE');
  assert.equal(h.requests.length, 0);
});

test('Reachable mirror is not blocked by a hanging primary host', async () => {
  const h = harness({ fetch: request => request.url.startsWith('https://huggingface.co/')
    ? abortable(request.signal) : new Response(new Uint8Array(64), { status: request.range ? 206 : 200 }) });
  const start = performance.now();
  await h.initializeModelWithFallback(h.makeState());
  assert.ok(performance.now() - start < 2500, 'usable mirror does not wait for the 30-second probe timeout');
  assert.ok(h.requests.find(request => request.url.startsWith('https://huggingface.co/')).signal.aborted);
});

test('Cached models including old headerless entries start without a network request', async () => {
  for (const legacy of [false, true]) {
    const h = harness();
    await h.seed('sense-webgpu', { legacy });
    await h.initializeModelWithFallback(h.makeState());
    assert.equal(h.requests.length, 0);
    for (const entry of h.stores.get('browser-sensevoice-v2').values()) {
      assert.equal(entry.headers.get('x-bscg-model-size'), '64');
    }
  }
});

test('A completed route is rechecked after cache eviction; only missing files are fetched', async () => {
  const h = harness();
  await h.manager.ensureRoute('sense-webgpu');
  const file = h.manager.assets.find(file => file.remote === 'model.onnx.data');
  await (await h.caches.open(file.cacheName)).delete(file.canonicalUrl);
  h.requests.length = 0;
  await h.manager.ensureRoute('sense-webgpu');
  assert.ok(h.requests.length > 0);
  assert.ok(h.requests.every(request => request.url.endsWith('/model.onnx.data')));
  assert.equal(h.manager.snapshot().routes.find(route => route.id === 'sense-webgpu').completedFiles, 4);
});

test('A truncated old cache is discarded and a short new response cannot be published', async () => {
  const h = harness({ fetch: request => new Response(new Uint8Array(request.range ? 64 : 12), {
    status: request.range ? 206 : 200
  }) });
  await h.seed('sense-webgpu', { legacy: true, size: 12 });
  h.commits.length = 0;
  await assert.rejects(h.manager.ensureRoute('sense-webgpu'), error => error.code === 'MODEL_DOWNLOAD_FAILED');
  assert.equal(h.stores.get('browser-sensevoice-v2').size, 0);
  assert.equal(h.commits.length, 0, 'invalid verified-size headers never reach CacheStorage');
});

test('Download failure reports source details, never switches to CPU, and the next click retries', async () => {
  let fail = true;
  const h = harness({ fetch: request => {
    if (fail) throw new TypeError('Failed to fetch');
    return new Response(new Uint8Array(64), { status: request.range ? 206 : 200 });
  } });
  const state = h.makeState();
  await assert.rejects(h.initializeModelWithFallback(state), error =>
    error.code === 'MODEL_DOWNLOAD_FAILED' && /Hugging Face/.test(error.message) && /HF Mirror/.test(error.message));
  assert.equal(state.backendMode, 'webgpu');
  assert.equal(h.workers.length, 0);
  assert.ok(!h.events.some(event => event.event === 'fallback'));
  fail = false;
  await h.initializeModelWithFallback(state);
  assert.equal(h.workers.length, 1);
});

test('Worker resource fetch errors remain resource failures, while GPU execution errors can fall back', async () => {
  const resource = harness({ workerError: () => 'TypeError: Failed to fetch' });
  await assert.rejects(resource.initializeModelWithFallback(resource.makeState()), /Failed to fetch/);
  assert.equal(resource.workers.length, 1);
  assert.ok(!resource.requests.some(request => request.url.endsWith('/model.int8.onnx')));
  const gpu = harness({ workerError: message => message.mode === 'webgpu' ? 'GPU shader compilation failed' : '' });
  await gpu.initializeModelWithFallback(gpu.makeState());
  assert.equal(gpu.workers.length, 2);
  assert.equal(gpu.workers[0].terminated, true);
  assert.equal(gpu.workers[1].messages[0].mode, 'wasm');
});

test('Two callers share one route; cancelling one keeps the other download alive', async () => {
  const gate = deferred();
  const h = harness({ fetch: async request => {
    if (!request.range) await gate.promise;
    return new Response(new Uint8Array(64), { status: request.range ? 206 : 200 });
  } });
  const controller = new AbortController();
  const first = h.manager.ensureRoute('sense-webgpu', { signal: controller.signal });
  const second = h.manager.ensureRoute('sense-webgpu');
  await until(() => h.requests.some(request => !request.range));
  const rejected = assert.rejects(first, error => error.name === 'AbortError');
  controller.abort();
  await rejected;
  assert.equal(h.manager.isRunning(), true);
  gate.resolve();
  await second;
  assert.equal(h.requests.filter(request => !request.range).length, 4);
});

test('Cancelling the only auto consumer aborts requests; manual downloads remain independently owned', async () => {
  for (const manual of [false, true]) {
    const h = harness({ fetch: request => abortable(request.signal) });
    if (manual) h.manager.startRoute('sense-webgpu');
    const controller = new AbortController();
    const operation = h.manager.ensureRoute('sense-webgpu', { signal: controller.signal });
    await until(() => h.requests.length > 0);
    const rejected = assert.rejects(operation, error => error.name === 'AbortError');
    controller.abort();
    await rejected;
    if (manual) {
      assert.equal(h.manager.isRunning(), true);
      assert.ok(h.requests.every(request => !request.signal.aborted));
      await h.manager.cancel();
    } else {
      await until(() => !h.manager.isRunning());
      assert.ok(h.requests.every(request => request.signal.aborted));
    }
  }
});

test('Stopping the task during GPU detection or download prevents stale Worker startup', async () => {
  const gate = deferred();
  const detecting = harness({ gpuRequest: () => gate.promise });
  const state = detecting.makeState();
  const operation = detecting.initializeModelWithFallback(state);
  const rejected = assert.rejects(operation, error => error.code === 'INIT_CANCELLED');
  detecting.cancelInitialization('stopped', state.sessionId);
  detecting.state(null);
  gate.resolve({ features: new Set(['shader-f16']) });
  await rejected;
  await tick();
  assert.equal(detecting.requests.length, 0);
  assert.equal(detecting.workers.length, 0);
  const downloading = harness({ fetch: request => abortable(request.signal) });
  const loading = downloading.initializeModelWithFallback(downloading.makeState());
  await until(() => downloading.requests.length > 0);
  const cancelled = assert.rejects(loading, error => error.code === 'INIT_CANCELLED');
  downloading.cancelInitialization('stopped');
  await cancelled;
  await until(() => !downloading.manager.isRunning());
  assert.equal(downloading.workers.length, 0);
  assert.equal(downloading.waiter(), null);
});

test('Cancelling a streamed file removes partial data; retry reuses complete files', async () => {
  let hold = true, bodyCancelled = false;
  const h = harness({ fetch: request => {
    if (!request.range && request.url.endsWith('/model.onnx.data') && hold) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(12)); },
      cancel() { bodyCancelled = true; }
    }));
    return new Response(new Uint8Array(64), { status: request.range ? 206 : 200 });
  } });
  const controller = new AbortController();
  const loading = h.manager.ensureRoute('sense-webgpu', { signal: controller.signal });
  await until(() => h.stores.get('browser-sensevoice-v2')?.size === 3);
  const cancelled = assert.rejects(loading, error => error.name === 'AbortError');
  controller.abort();
  await cancelled;
  await until(() => !h.manager.isRunning());
  assert.equal(bodyCancelled, true);
  assert.equal(h.stores.get('browser-sensevoice-v2').size, 3);
  h.requests.length = 0;
  hold = false;
  await h.manager.ensureRoute('sense-webgpu');
  assert.ok(h.requests.every(request => request.url.endsWith('/model.onnx.data')));
});

test('Rapid audio progress is throttled while metrics, completion and retry reset stay accurate', () => {
  const h = harness();
  const state = h.makeState();
  for (let i = 1; i <= 66; i++) {
    h.now(i * 20);
    h.updateAudioDownloadProgress(state, i * 100000, 6600000);
  }
  const notices = h.events.filter(event => event.event === 'audio-progress');
  assert.ok(notices.length <= 4);
  assert.equal(notices.at(-1).audioProgress, 100);
  assert.equal(state.metrics.audioDownloadBytes, 6600000);
  h.updateAudioDownloadProgress(state, 6600000, 6600000);
  assert.equal(h.events.length, notices.length);
  h.updateAudioDownloadProgress(state, 0, 6600000, true);
  assert.equal(h.events.at(-1).audioLoaded, 0);
});

let passed = 0;
for (const { name, run } of tests) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n`, error); process.exitCode = 1; }
  finally { for (const cleanup of cleanups) await cleanup(); cleanups = []; }
}
console.log(`${passed}/${tests.length} bootstrap checks passed. Actual GPU, CORS and live-site operation still require Chrome acceptance testing.`);
