// Run: node tests/scan-audio.mjs
// Real resampler/VAD/controller code; simulated browser audio and messaging.
// No model is downloaded and no transcript is sent to an AI service.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const ui = read('universal.js'), bg = read('background.js');
const checks = [], cleanup = [];
const test = (name, run) => checks.push({ name, run });
const turns = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fn(source, name) {
  const start = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, name);
  const end = source.indexOf('\n' + start[1] + '}', start.index);
  return source.slice(start.index, end + start[1].length + 2);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function timerFixture() {
  const timers = new Set(), intervals = new Map();
  cleanup.push(() => { for (const id of timers) clearTimeout(id); intervals.clear(); });
  return {
    setTimeout(run, ms) { const id = setTimeout(() => { timers.delete(id); run(); }, ms); timers.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); },
    setInterval(run) { const id = {}; intervals.set(id, run); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
}
const audio = vm.createContext({ Float32Array });
vm.runInContext(read('capture-audio.js'), audio);
const create = audio.BscgCaptureAudio.createResampler;
function join(parts) {
  const result = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
const tone = (count, rate, frequency, start = 0) => Float32Array.from({ length: count },
  (_, index) => 0.4 * Math.sin(2 * Math.PI * frequency * (index + start) / rate));
function restore(input, inputRate, speed, block = 2048) {
  const converter = create(inputRate, speed), parts = [];
  for (let at = 0; at < input.length; at += block) parts.push(converter.process(input.subarray(at, at + block)));
  parts.push(converter.flush());
  assert.equal(converter.flush().length, 0);
  return join(parts);
}
function frequency(input, rate = 16000) {
  let crossings = 0;
  for (let i = 1; i < input.length; i++) if (input[i - 1] <= 0 && input[i] > 0) crossings++;
  return crossings / (input.length / rate);
}

test('1x/2x/4x/8x capture recovers normal duration and pitch at 44.1/48 kHz', () => {
  for (const inputRate of [44100, 48000]) for (const speed of [1, 2, 4, 8]) {
    const input = tone(inputRate, inputRate, 600 * speed);
    const output = restore(input, inputRate, speed);
    assert.equal(output.length, 16000 * speed);
    assert.ok(Math.abs(frequency(output) - 600) < 1.1);
    let error = 0;
    for (let i = 0; i < output.length; i++) error += (output[i] - 0.4 * Math.sin(2 * Math.PI * 600 * i / 16000)) ** 2;
    assert.ok(Math.sqrt(error / output.length) < 0.035, `${inputRate}/${speed}: normal pitch restored`);
  }
});

test('Fractional sample phases survive arbitrary chunks without duration drift', () => {
  for (const speed of [1, 1.5, 3, 4, 6, 8]) {
    const input = tone(93017, 44100, 440 * speed);
    const whole = restore(input, 44100, speed, input.length);
    const split = restore(input, 44100, speed, 137);
    assert.equal(split.length, whole.length);
    let maximum = 0;
    for (let i = 0; i < whole.length; i++) maximum = Math.max(maximum, Math.abs(whole[i] - split[i]));
    assert.ok(maximum < 0.00001, `${speed}: callback boundaries are inaudible`);
  }
});

function engine() {
  let now = 0;
  const jobs = [], events = [];
  const context = vm.createContext({ console, Float32Array, Int16Array, Uint8Array, ArrayBuffer,
    AbortController, performance: { now: () => now }, navigator: { storage: {} },
    self: { BscgCaptureAudio: audio.BscgCaptureAudio }, ...timerFixture(),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    chrome: { runtime: { onMessage: { addListener() {} }, getURL: file => file,
      sendMessage: async message => events.push(message) } }, jobs });
  vm.runInContext(read('browser-engine.js') + `
    globalThis.audit={prepareScanCapture,receiveTabAudio,acceptExternalPcm,flushPhrase,
      setState:value=>{activeSession=value;},stopSession};
    dispatchNextCapturePhrase=state=>{
      for(const job of state.pending.values()) jobs.push(job);
      state.pending.clear();state.metrics.queuedAudioSeconds=0;
    };
  `, context);
  const state = { sessionId: 'scan', tabId: 1, asrProfile: 'sensevoice_browser',
    sourceMode: 'capture', scanMode: true, scanReady: false, modelReady: true, acceptAudio: true,
    inputRate: 16000, captureSourceRate: 48000, stopping: false, previewEnabled: false,
    maxPhraseSeconds: 11.5, preRoll: [], phraseChunks: [], phraseSamples: 0,
    phraseTokenSequence: 0, phraseSequence: 0, phraseVoiced: false, silenceSamples: 0,
    noiseFloor: 0.003, pending: new Map(), cues: [],
    metrics: { capturedAudioSeconds: 0, queuedAudioSeconds: 0, totalInferenceMs: 0 } };
  context.audit.setState(state);
  return { ...context.audit, state, context, jobs, events, now: value => { now = value; },
    ready(rate = 4) { return context.audit.prepareScanCapture({ sessionId: 'scan', currentTime: 0,
      duration: 100, playbackRate: rate, preservesPitch: false }); } };
}

test('Restored scan VAD splits original media seconds and never submits 46-second timestamps for 11.5 seconds of PCM', async () => {
  for (const speed of [4, 8]) {
    const h = engine();
    h.receiveTabAudio(h.state, tone(2048, 48000, 600 * speed));
    assert.equal(h.state.metrics.capturedAudioSeconds, 0, 'drop audio before scan is armed');
    assert.equal(h.ready(speed).ok, true);
    const count = 48000 * 26 / speed;
    for (let offset = 0; offset < count; offset += 2048) {
      const length = Math.min(2048, count - offset);
      h.now((offset + length) / 48);
      h.receiveTabAudio(h.state, tone(length, 48000, 600 * speed, offset));
    }
    await h.flushPhrase(h.state, 'final', 26);
    assert.equal(h.jobs.length, 3);
    for (const job of h.jobs) {
      assert.ok(job.audioSeconds <= 11.521);
      assert.ok(Math.abs(job.endVideo - job.startVideo - job.audioSeconds) < 0.03);
      assert.ok(Math.abs(frequency(job.retryAudio) - 600) < 1);
    }
    assert.ok(Math.abs(h.jobs.reduce((sum, job) => sum + job.audioSeconds, 0) - 26) < 0.001);
  }
});

test('Qwen scan windows stay below 8 seconds even with large 8x callbacks', async () => {
  const h = engine(); h.state.asrProfile = 'qwen3_asr_0_6b'; h.state.maxPhraseSeconds = 7.75;
  h.ready(8);
  for (let offset = 0; offset < 96000; offset += 4096) {
    const length = Math.min(4096, 96000 - offset);
    h.now((offset + length) / 48);
    h.receiveTabAudio(h.state, tone(length, 48000, 4800, offset));
  }
  await h.flushPhrase(h.state, 'final', 16);
  assert.ok(h.jobs.length >= 2);
  assert.ok(h.jobs.every(job => job.audioSeconds < 8));
});

test('Scan handshake rejects preserved-pitch acceleration and external PCM cannot be restored twice', () => {
  const h = engine();
  assert.equal(h.prepareScanCapture({ sessionId: 'scan', currentTime: 0, playbackRate: 4, preservesPitch: true }).ok, false);
  assert.equal(h.state.scanReady, false);
  assert.equal(h.ready().ok, true);
  h.state.externalInput = true;
  const pcm = new Int16Array(3200).fill(9000);
  const message = { sessionId: 'scan', pcmBase64: Buffer.from(pcm.buffer).toString('base64'),
    timing: { currentTime: 0.2, playbackRate: 4, paused: false } };
  assert.throws(() => h.acceptExternalPcm(message), /未恢复正常语速/);
  message.timing = { currentTime: 0.2, playbackRate: 1, speedRestored: true, paused: false };
  assert.equal(h.acceptExternalPcm(message).ok, true);
  assert.ok(Math.abs(h.state.metrics.capturedAudioSeconds - 0.2) < 1e-9);
});

function videoFixture() {
  const listeners = new Map();
  let position = 0;
  const video = { tagName: 'VIDEO', currentSrc: 'blob:fixture', volume: 1, muted: false,
    duration: 60, paused: true, playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: true,
    readyState: 4, isConnected: true, seeking: false, loop: false, clientWidth: 800, clientHeight: 450,
    getBoundingClientRect: () => ({ width: 800, height: 450 }), getAttribute: () => null,
    get currentTime() { return position; }, set currentTime(value) { position = value; queueMicrotask(() => video.emit('seeked')); },
    addEventListener(name, run) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(run); },
    removeEventListener(name, run) { listeners.get(name)?.delete(run); },
    emit(name) { for (const run of [...(listeners.get(name) || [])]) run(); },
    pause() { video.paused = true; }, async play() { video.paused = false; } };
  return video;
}

test('In-page 4x audio is restored before 16 kHz transport, including the Worklet tail', async () => {
  const video = videoFixture(), sent = [], processors = [];
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  class AudioContext {
    sampleRate = 48000; state = 'running'; destination = {};
    audioWorklet = { addModule: async () => {} };
    async resume() {} createGain() { return node(); } createMediaElementSource() { return node(); }
  }
  class AudioWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage: message => {
        if (message.type === 'flush') queueMicrotask(() => {
          if (this.tail) this.port.onmessage?.({ data: this.tail });
          this.port.onmessage?.({ data: { type: 'flushed' } });
        });
      } }; processors.push(this);
    }
    connect() {} disconnect() {}
  }
  const context = vm.createContext({ console, window: {}, scanCaptureHooks: null,
    bscgFindMedia: () => [{ video }], URL, location: { href: 'https://video.test/', origin: 'https://video.test' },
    BscgCaptureAudio: audio.BscgCaptureAudio, Float32Array, Int16Array, Uint8Array,
    AudioContext, AudioWorkletNode, ...timerFixture(), document: { querySelectorAll: () => [] },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    chrome: { runtime: { getURL: file => file,
      onMessage: { addListener: run => { context.receive = run; } },
      sendMessage: async message => { sent.push(message); return { ok: true }; } } }
  });
  vm.runInContext(ui.slice(ui.indexOf('  function installInpageCapture()'), ui.lastIndexOf('})();')) + '\ninstallInpageCapture();', context);
  const response = await new Promise(resolve => context.receive({ type: 'BSCG_INPAGE_CAPTURE_START',
    sessionId: 'page', silentOutput: true, scanMode: true }, {}, resolve));
  assert.equal(response.ok, true);
  video.emit('ended'); await turns();
  assert.ok(!sent.some(message => message.type === 'BSCG_CAPTURE_ENDED'), 'cold model preparation survives an early media end');
  video.playbackRate = 4; video.preservesPitch = false; video.paused = false;
  context.scanCaptureHooks.start('page', 4);
  const input = tone(48000 + 37, 48000, 2400 * 4);
  for (let at = 0; at < 48000; at += 2048) {
    const end = Math.min(48000, at + 2048);
    video.currentTime = end / 48000 * 4;
    processors[0].port.onmessage({ data: input.subarray(at, end) });
    await turns();
  }
  processors[0].tail = input.subarray(48000);
  video.currentTime = input.length / 48000 * 4; video.paused = true;
  await context.scanCaptureHooks.stop('page');
  const messages = sent.filter(message => message.type === 'BSCG_CAPTURE_CHUNK');
  assert.ok(messages.length > 0);
  const restored = join(messages.map(message => {
    assert.equal(message.timing.playbackRate, 1);
    assert.equal(message.timing.speedRestored, true);
    const bytes = Buffer.from(message.pcmBase64, 'base64');
    return Float32Array.from({ length: bytes.length / 2 }, (_, index) => bytes.readInt16LE(index * 2) / 32768);
  }));
  assert.equal(restored.length, Math.floor(input.length * 4 / 3));
  assert.ok(Math.abs(frequency(restored) - 2400) < 1);
  assert.ok(sent.findIndex(message => message.type === 'BSCG_CAPTURE_ENDED') > sent.lastIndexOf(messages.at(-1)));
});

function controllerFixture({ pitchLocked = false, hooks = {}, send = async () => ({ ok: true }) } = {}) {
  const video = videoFixture(), calls = [], listeners = [];
  video.currentTime = 12; video.playbackRate = 1.5; video.volume = 0.7;
  video.play = async () => { video.paused = false; calls.push('play'); };
  if (pitchLocked) Object.defineProperty(video, 'preservesPitch', { get: () => true, set() {} });
  const context = vm.createContext({ window: {}, ...timerFixture(),
    scanCaptureHooks: { start: (...args) => { calls.push('capture-start'); hooks.start?.(...args); },
      stop: async (...args) => { calls.push('capture-stop'); await hooks.stop?.(...args); } },
    document: { querySelectorAll: () => [video] }, getComputedStyle: () => ({ opacity: '1' }),
    chrome: { runtime: { onMessage: { addListener: run => listeners.push(run) },
      sendMessage: async message => { calls.push(message.type); return send(message); } } }
  });
  const start = ui.indexOf('  if (!window.__bscgBrowserScanController)');
  const end = ui.indexOf('  // 顶层帧：', start);
  vm.runInContext(ui.slice(start, end), context);
  return { video, calls, context,
    message: message => new Promise(resolve => listeners[0](message, {}, resolve)) };
}

test('Scan controller disables pitch preservation, arms the engine before playback and restores original settings', async () => {
  const h = controllerFixture();
  const result = await h.message({ type: 'BSCG_SCAN_START', sessionId: 'scan', playbackRate: 4 });
  assert.equal(result.ok, true);
  assert.equal(h.video.preservesPitch, false);
  assert.equal(h.video.playbackRate, 4);
  assert.ok(h.calls.indexOf('BSCG_SCAN_READY') < h.calls.indexOf('play'));
  await h.message({ type: 'BSCG_SCAN_STOP', sessionId: 'scan' });
  assert.equal(h.video.currentTime, 12);
  assert.equal(h.video.playbackRate, 1.5);
  assert.equal(h.video.preservesPitch, true);
  assert.equal(h.video.volume, 0.7);
  assert.equal(h.video.paused, true);
});

test('A player that refuses pitch changes scans at 1x instead of mislabelling accelerated audio', async () => {
  const h = controllerFixture({ pitchLocked: true });
  const result = await h.message({ type: 'BSCG_SCAN_START', sessionId: 'scan', playbackRate: 8 });
  assert.equal(result.ok, true); assert.equal(result.playbackRate, 1); assert.equal(result.rateFallback, true);
  await h.message({ type: 'BSCG_SCAN_STOP', sessionId: 'scan' });
});

test('Natural end waits for audio drain and engine stop before restoration; stale resume cannot restart playback', async () => {
  const drain = deferred(), stop = deferred();
  const h = controllerFixture({ hooks: { stop: () => drain.promise },
    send: message => message.type === 'BSCG_SCAN_ENDED' ? stop.promise : Promise.resolve({ ok: true }) });
  await h.message({ type: 'BSCG_SCAN_START', sessionId: 'scan', playbackRate: 4 });
  h.video.currentTime = 60; h.video.paused = true; h.video.emit('ended');
  await turns();
  assert.equal(h.video.currentTime, 60);
  assert.ok(!h.calls.includes('BSCG_SCAN_ENDED'));
  const result = await h.message({ type: 'BSCG_SCAN_RESUME', sessionId: 'scan' });
  assert.equal(result.ignored, true); assert.equal(h.video.paused, true);
  drain.resolve(); await turns();
  assert.ok(h.calls.includes('BSCG_SCAN_ENDED')); assert.equal(h.video.currentTime, 60);
  stop.resolve({ ok: true }); await turns();
  assert.equal(h.video.currentTime, 12);
});

test('AudioWorklet flush exports the final short buffer before its acknowledgement', () => {
  const messages = []; let Processor;
  const context = vm.createContext({ Float32Array,
    AudioWorkletProcessor: class { port = { postMessage: message => messages.push(message) }; },
    registerProcessor: (_name, value) => { Processor = value; } });
  vm.runInContext(read('audio-worklet.js'), context);
  const processor = new Processor();
  processor.process([[new Float32Array(128).fill(0.25)]], [[new Float32Array(128)]]);
  assert.equal(messages.length, 0);
  processor.port.onmessage({ data: { type: 'flush' } });
  assert.equal(messages[0].length, 128); assert.equal(messages[1].type, 'flushed');
  processor.port.onmessage({ data: { type: 'flush' } });
  assert.equal(messages.length, 3, 'flushing twice does not duplicate samples');
});

test('Tab capture drains its final Worklet buffer and resampler before closing the audio graph', async () => {
  const h = engine(), order = [];
  h.ready(4);
  h.now(1000);
  h.receiveTabAudio(h.state, tone(48000, 48000, 2400));
  h.state.clock.duration = (48000 + 128) / 48000 * 4;
  h.state.source = { disconnect: () => order.push('disconnect') };
  h.state.worklet = { disconnect() {}, port: { postMessage: message => {
    if (message.type === 'flush') queueMicrotask(() => {
      order.push('flush');
      h.receiveTabAudio(h.state, tone(128, 48000, 2400, 48000));
      h.state.resolveCaptureFlush();
    });
  } } };
  h.state.audioContext = { close: async () => order.push('close') };
  await h.stopSession(h.state, 'scan-complete');
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].retryAudio.length, Math.floor((48000 + 128) * 4 / 3));
  assert.ok(order.indexOf('flush') < order.indexOf('close'));
});

test('Stopping/error notifications never restart or resume a finished scan', () => {
  for (const started of [false, true]) for (const status of ['stopping', 'stopped', 'error']) {
    const calls = [];
    const session = { sessionId: 'scan', tabId: 1, scanMode: true, scanStarted: started,
      scanFrameId: 0, segments: [], seenSegments: new Set() };
    const context = vm.createContext({ browserEngineSessions: new Map([['scan', session]]),
      cleanDisplayCaption: value => value, startAutomatedScan: () => calls.push('start'),
      chrome: { tabs: { sendMessage: async () => calls.push('resume') } } });
    vm.runInContext(fn(bg, 'handleBrowserEngineEvent'), context);
    context.handleBrowserEngineEvent({ sessionId: 'scan', event: 'resume-after-model', status, sourceMode: 'capture' });
    assert.equal(calls.length, 0);
  }
});

test('A completed summary preserves hidden/visible/closed caption intent while retaining its transcript', () => {
  const start = ui.indexOf("    if (message?.type === 'BSCG_FILE_RESULT')");
  const end = ui.indexOf('    if (ignoreLiveMessages', start);
  for (const visible of [false, true]) {
    const context = vm.createContext({ captionsVisible: visible, liveMode: '', rows: [],
      mergeSegments: rows => { context.rows = rows; }, renderCurrentCue() {}, setStatus() {},
      setCaptionVisibility: value => { context.captionsVisible = value; } });
    vm.runInContext('globalThis.receive = message => {\n' + ui.slice(start, end) + '\n};', context);
    context.receive({ type: 'BSCG_FILE_RESULT', rows: 1, segments: [{ from: 0, to: 4, content: 'text' }] });
    assert.equal(context.captionsVisible, visible); assert.equal(context.rows.length, 1);
  }
});

test('Retained summary rows do not enable captions during page hydration', async () => {
  for (const visibility of [undefined, false, true]) {
    const response = { ok: true, running: false, captionVisibility: visibility,
      segments: [{ from: 0, to: 4, content: 'stored text' }] };
    const context = vm.createContext({ location: { href: 'https://video.test/' }, pageIdentity: () => 'same',
      currentSessionId: '', captionActionVersion: 0, captionsDismissed: false, captionsVisible: false,
      CS_VERSION: '0.16.16', rows: [], sendRuntime: async () => response, setSummaryTask() {}, resetForSession() {},
      mergeSegments: rows => { context.rows = rows; }, renderCurrentCue() {}, setRunning() {}, setStatus() {},
      setCaptionVisibility: value => { context.captionsVisible = Boolean(value) && !context.captionsDismissed; }
    });
    vm.runInContext(fn(ui, 'hydrateLiveState'), context);
    await context.hydrateLiveState();
    assert.equal(context.captionsVisible, visibility === true);
  }
});

test('Background result delivery persists hidden intent without overriding an explicit caption toggle', async () => {
  for (const initial of [undefined, false, true]) {
    const map = new Map(initial === undefined ? [] : [[1, { visible: initial }]]);
    const context = vm.createContext({ captionDisplayByTab: map, currentDocumentId: () => 'doc',
      chrome: { tabs: { sendMessage: async () => {} } } });
    vm.runInContext(fn(bg, 'sendLive'), context);
    await context.sendLive(1, { type: 'BSCG_FILE_RESULT' });
    assert.equal(map.get(1).visible, initial === true);
  }
});

test('Pre-fix transcript caches are not reused after the audio pipeline changes', async () => {
  const schema = Number(bg.match(/const RESULT_SCHEMA_VERSION = (\d+)/)[1]);
  let removed = false;
  const context = vm.createContext({ RESULT_SCHEMA_VERSION: schema, RESULT_TTL_MS: 60000,
    resultStorageKey: () => 'cache', chrome: { storage: { local: {
      get: async () => ({ cache: { schemaVersion: 3, text: 'bad scan transcript', createdAt: Date.now() } }),
      remove: async () => { removed = true; }
    } } } });
  vm.runInContext(fn(bg, 'findCachedResult'), context);
  assert.equal(await context.findCachedResult(1, 'video', 'part'), null);
  assert.equal(removed, true);
});

let passed = 0;
for (const { name, run } of checks) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n`, error); process.exitCode = 1; }
  finally { for (const clear of cleanup.splice(0)) clear(); }
}
console.log(`${passed}/${checks.length} scan checks passed. Browser resampling, 8x bandwidth and real ASR accuracy require hardware acceptance.`);
