// Run: node tests/verify.mjs. No model download or physical GPU is required.
// These verify numerical equivalence and lifecycle/UI control flow, not GPU RTF.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FFT } from '../asr-worker.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = name => fs.readFileSync(root + name, 'utf8');
const qwenSource = source('qwen-webgpu-worker.js').replace(/^import .*;\s*$/m, '')
  .replace(/\nexport \{[\s\S]*?\};\s*$/, '');
const engineSource = source('browser-engine.js');
const backgroundSource = source('background.js');
const uiSource = source('universal.js');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const turns = async (count = 12) => { for (let i = 0; i < count; i++) await Promise.resolve(); };

function fn(text, name) {
  const match = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, 'm').exec(text);
  assert.ok(match, `function ${name} exists`);
  const end = text.indexOf('\n' + match[1] + '}', match.index);
  assert.ok(end >= 0);
  return text.slice(match.index, end + match[1].length + 2);
}

function qwenHarness() {
  const live = new Set();
  const events = [];
  let listener;
  let clock = 0;
  class Tensor {
    constructor(type, data, dims, gpu = false) {
      Object.assign(this, { type, data, dims, gpu });
      live.add(this);
    }
    dispose() { live.delete(this); this.disposed = true; }
  }
  const context = vm.createContext({ Tensor, FFT, Uint16Array, Uint32Array, Int32Array,
    Float32Array, Float64Array, Uint8Array, TextDecoder, TextEncoder, URL,
    performance: { now: () => clock }, ortEnv: { wasm: {}, webgpu: {} },
    navigator: { storage: {}, gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']), info: {} }) } },
    InferenceSession: { create: async () => { throw new Error('unconfigured session'); } },
    self: { location: { href: 'https://example.test/' }, postMessage: e => events.push(e),
      addEventListener: (type, callback) => { listener = callback; } }
  });
  vm.runInContext(qwenSource + `
    globalThis.audit = { generate, transcribe, encodeAudio, initialize, floatToHalf,
      halfToFloat, argmaxLogits, logMelSpectrogram, melFilters, hannWindow, reflectIndex,
      createTokenizer, queue: () => queue,
      setSessions: (encoder, decoder, tokens) => {encoderSession=encoder; decoderSession=decoder; tokenizer=tokens;},
      setLoader: loader => {loadBytes=loader;},
      sessions: () => [encoderSession, decoderSession, tokenizer],
      addEos: id => EOS_TOKEN_IDS.add(id) };
  `, context);
  context.audit.addEos(0);
  let calls = 0;
  let failAt = 0;
  let maxCalls = 4;
  const encoder = { release: async () => {}, run: async () => ({
    audio_embeddings: new Tensor('float16', new Uint16Array(100 * 1024), [1, 100, 1024]),
    audio_token_mask: new Tensor('int32', new Int32Array(100).fill(1), [1, 100])
  }) };
  const decoder = { release: async () => {}, run: async feeds => {
    calls++;
    clock += 150;
    if (calls === failAt) throw new Error('injected failure');
    const length = feeds['past.0.key'].dims[2] + feeds.input_ids.dims[1];
    const outputs = { logits: new Tensor('float32', new Float32Array(calls < maxCalls ? [0, 1] : [1, 0]), [1, 1, 2]) };
    for (let layer = 0; layer < 28; layer++) for (const kind of ['key', 'value']) {
      outputs[`present.${layer}.${kind}`] = new Tensor('float16', null, [1, 8, length, 128], true);
    }
    return outputs;
  } };
  const tokenizer = { decode: ids => ids.filter(id => id !== 0).map(() => '\uFFFD').join('') };
  context.audit.setSessions(encoder, decoder, tokenizer);
  return { ...context.audit, context, Tensor, live, events, encoder, decoder, tokenizer,
    send: message => listener({ data: message }),
    configure: (fail = 0, total = 4) => {calls = 0; failAt = fail; maxCalls = total;},
    tick: ms => {clock += ms;} };
}

function engineHarness() {
  const events = [];
  const timers = new Map();
  let serial = 0;
  const context = vm.createContext({ console, Float32Array, Int32Array, Uint8Array,
    performance: { now: () => 1000 }, self: {}, navigator: { storage: {} },
    chrome: { runtime: { onMessage: { addListener() {} }, getURL: file => file,
      sendMessage: async e => { events.push(e); } } },
    setTimeout: (run, ms) => { const id = ++serial; timers.set(id, { run, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    Worker: class { constructor() { throw new Error('unexpected duplicate worker'); } }
  });
  vm.runInContext(engineSource + `
    globalThis.audit={handleWorkerMessage,handleTranscriptionResult,createWorker,
      cancelInferenceForSwitch,releaseIdleModel,scheduleModelRelease,initializeModel,
      state:s=>{activeSession=s;},worker:(w,key)=>{asrWorker=w;asrWorkerKey=key;},
      getWorker:()=>asrWorker,getState:()=>activeSession};
    dispatchNextCapturePhrase=()=>{};submitPreview=()=>{};updateResourceMetrics=async()=>{};
    resumeWarmupDrain=()=>{};
  `, context);
  return { ...context.audit, context, events, timers };
}

test('JavaScript syntax and manifest version', () => {
  for (const file of ['qwen-webgpu-worker.js', 'browser-engine.js', 'model-download.js', 'capture-audio.js', 'audio-worklet.js', 'background.js', 'universal.js', 'media-discovery.js', 'attachment-guard.js', 'deepseek.js', 'chatgpt.js', 'aistudio.js']) {
    execFileSync(process.execPath, ['--check', root + file]);
  }
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.version, '0.16.24');
  assert.equal(uiSource.match(/const CS_VERSION = '([^']+)'/)[1], manifest.version);
  assert.ok(manifest.permissions.includes('alarms'));
});

test('FP16 conversion preserves all representable half values', () => {
  const q = qwenHarness();
  for (let bits = 0; bits < 65536; bits++) {
    if ((bits & 0x7fff) > 0x7c00) continue;
    assert.equal(q.floatToHalf(q.halfToFloat(bits)), bits);
  }
});

test('FP16 argmax matches numeric comparison, including NaNs and signed zeros', () => {
  const q = qwenHarness();
  const cases = [[0x8000, 0], [0x7e00, 0xfc00], [0xfc00, 0x7e00, 0], [0x3c00, 0x3c00], [0x7c00, 0x7c00]];
  let seed = 103;
  for (let run = 0; run < 20; run++) {
    const values = new Uint16Array(10000);
    for (let i = 0; i < values.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; values[i] = seed & 65535; }
    cases.push(values);
  }
  for (const values of cases) {
    let best = -Infinity, expected = 0;
    const data = Uint16Array.from(values);
    for (let i = 0; i < data.length; i++) if (q.halfToFloat(data[i]) > best) { best = q.halfToFloat(data[i]); expected = i; }
    assert.equal(q.argmaxLogits({ data, dims: [1, 1, data.length] }), expected);
  }
});

test('Sparse log-Mel is identical to dense reference for silence and speech-like signals', () => {
  const q = qwenHarness();
  const fft = new FFT(400);
  for (const seconds of [0.5, 1.3, 7.5]) {
    const audio = Float32Array.from({ length: seconds * 16000 }, (_, i) => seconds === 0.5 ? 0 :
      0.3 * Math.sin(i * 0.087) + 0.1 * Math.sin(i * 0.023));
    const actual = q.logMelSpectrogram(audio).data;
    const frames = Math.floor(audio.length / 160);
    const expected = new Float32Array(128 * frames);
    const frame = new Float64Array(400), spectrum = new Float64Array(fft.outputBufferSize), power = new Float64Array(201);
    let maximum = -Infinity;
    for (let t = 0; t < frames; t++) {
      for (let i = 0; i < 400; i++) frame[i] = audio[q.reflectIndex(t * 160 - 200 + i, audio.length)] * q.hannWindow[i];
      fft.realTransform(spectrum, frame);
      for (let bin = 0; bin < 201; bin++) power[bin] = spectrum[bin * 2] ** 2 + spectrum[bin * 2 + 1] ** 2;
      for (let mel = 0; mel < 128; mel++) {
        let energy = 0;
        for (let bin = 0; bin < 201; bin++) energy += q.melFilters[mel][bin] * power[bin];
        const value = Math.log10(Math.max(1e-10, energy));
        expected[mel * frames + t] = value;
        maximum = Math.max(maximum, value);
      }
    }
    for (let i = 0; i < expected.length; i++) expected[i] = (Math.max(expected[i], maximum - 8) + 4) / 4;
    assert.deepEqual(actual, expected);
  }
});

test('Normal, prefill-error and decode-error paths release all owned tensors', async () => {
  const q = qwenHarness();
  for (const failAt of [0, 1, 2, 3, 0, 2, 0]) {
    q.configure(failAt);
    if (failAt) await assert.rejects(q.generate(new Float32Array(8000)), /injected/);
    else await q.generate(new Float32Array(8000));
    assert.equal(q.live.size, 0, `no retained tensors after failure ${failAt}`);
  }
});

test('Encoder incomplete-output failure releases outputs and inputs', async () => {
  const q = qwenHarness();
  q.encoder.run = async () => ({ audio_embeddings: new q.Tensor('float16', new Uint16Array(1024), [1, 1, 1024]) });
  await assert.rejects(q.generate(new Float32Array(8000)), /输出不完整/);
  assert.equal(q.live.size, 0);
});

test('Failed initialization releases a successfully created encoder', async () => {
  const q = qwenHarness();
  q.setSessions(null, null, null);
  q.setLoader(async () => new Uint8Array(1));
  let creates = 0, releases = 0;
  q.context.InferenceSession.create = async () => {
    if (++creates === 2) throw new Error('decoder initialization failed');
    return { release: async () => {releases++;} };
  };
  await assert.rejects(q.initialize({}), /decoder initialization failed/);
  assert.equal(releases, 1);
  assert.ok(q.sessions().every(value => value === null));
});

test('Tokenizer partials suppress language metadata and incomplete UTF-8 tails', () => {
  const q = qwenHarness();
  const tokenizer = q.createTokenizer({ model: { vocab: { language: 1, '<asr_text>': 2, hello: 3, '\uFFFD': 4 } } });
  assert.equal(tokenizer.decode([1], { partial: true }), '');
  assert.equal(tokenizer.decode([1, 2, 3], { partial: true }), 'hello');
  assert.equal(tokenizer.decode([1, 2, 3, 4], { partial: true }), 'hello');
});

test('Qwen streams genuine decode updates before a single final result', async () => {
  const q = qwenHarness();
  await q.transcribe({ sessionId: 's', phraseId: 1, audio: new Float32Array(8000).buffer, stream: true });
  const partials = q.events.filter(event => event.type === 'partial-result');
  assert.ok(partials.length >= 2);
  assert.ok(partials[1].text.length > partials[0].text.length);
  assert.equal(q.events.at(-1).type, 'result');
  assert.equal(q.events.filter(event => event.type === 'result').length, 1);
  assert.equal(q.live.size, 0);
});

test('Cancellation interrupts decoding, releases KV, then acknowledges session reuse', async () => {
  const q = qwenHarness();
  let resume;
  const run = q.decoder.run;
  q.decoder.run = async feeds => {
    const outputs = await run(feeds);
    if (feeds.input_ids.dims[1] === 1) await new Promise(resolve => {resume = resolve;});
    return outputs;
  };
  q.send({ type: 'qwen-transcribe', sessionId: 'old', phraseId: 0, preview: true, stream: true, audio: new Float32Array(8000).buffer });
  await turns(30);
  assert.equal(typeof resume, 'function');
  q.send({ type: 'qwen-cancel-session', sessionId: 'old' });
  resume();
  await q.queue();
  assert.equal(q.live.size, 0);
  assert.equal(q.events.at(-1).type, 'session-cancelled');
  assert.ok(q.events.some(event => event.type === 'error' && event.cancelled));
  assert.ok(!q.events.some(event => event.type === 'result'));
  q.decoder.run = run;
  q.configure();
  await q.transcribe({ sessionId: 'new', phraseId: 1, audio: new Float32Array(8000).buffer });
  assert.equal(q.events.at(-1).sessionId, 'new');
  assert.equal(q.live.size, 0);
});

test('Partial updates do not release the inference slot or enter exported cues; full correction is retained', () => {
  const h = engineHarness();
  const state = { sessionId: 's', tabId: 1, sourceMode: 'capture', modelReady: true, previewEnabled: true,
    previewInFlight: true, activePhraseToken: 'p1', cues: [], pending: new Map(), metrics: { totalInferenceMs: 0, totalInferredAudioSeconds: 0 } };
  h.state(state);
  h.handleWorkerMessage({ type: 'partial-result', sessionId: 's', phraseId: 0, preview: true,
    previewToken: 'p1', previewStartVideo: 0, previewEndVideo: 3, text: '杩欐槸閿欏瓧', firstPartialMs: 230 });
  assert.equal(state.previewInFlight, true);
  assert.equal(state.cues.length, 0);
  assert.equal(h.events.at(-1).partialOnly, true);
  assert.equal(h.events.at(-1).segments, undefined);
  state.previewInFlight = false;
  state.pending.set(1, { phraseId: 1, phraseToken: 'p1', startVideo: 0, endVideo: 4, audioSeconds: 4 });
  const corrected = '这是完整的修正版，前面和后面的文字都应该保留下来，而不是只显示最后一个分段。';
  h.handleTranscriptionResult({ sessionId: 's', phraseId: 1, text: corrected, inferenceMs: 300, audioSeconds: 4 });
  assert.ok(state.cues.length > 1);
  assert.equal(state.finalCue.content, corrected);
  assert.equal(h.events.at(-1).finalSegment.content, corrected);
  state.activePhraseToken = 'p2';
  h.handleWorkerMessage({ type: 'partial-result', sessionId: 's', phraseId: 0, preview: true,
    previewToken: 'p2', previewStartVideo: 4, previewEndVideo: 6, text: '下一句' });
  assert.equal(state.finalCue.content, corrected);
});

test('Final correction and next draft render together; stale same-phrase draft cannot cover final', () => {
  const context = vm.createContext({});
  vm.runInContext(fn(uiSource, 'captionDisplayRows') + '\nglobalThis.select=captionDisplayRows;', context);
  const final = { id: 'p1', from: 0, to: 4, content: '完整修正后的上一句话' };
  const draft = { id: 'p2', from: 4, to: 7, content: '下一句草稿' };
  let rows = context.select(null, final, 5000, draft, 1000);
  assert.deepEqual(Array.from(rows, row => row.content), [final.content, draft.content]);
  rows = context.select(null, final, 5000, { ...draft, id: 'p1' }, 1000);
  assert.equal(rows.length, 1);
  rows = context.select(null, final, 5000, draft, 6000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, draft.content);
});

test('Preview delivery coalesces revisions and preserves final ordering', async () => {
  const delivered = [];
  const session = { tabId: 1, sessionId: 's' };
  const context = vm.createContext({ liveCaptures: new Map([[1, session]]), sendLive: async (_tab, message) => delivered.push(message) });
  vm.runInContext(fn(backgroundSource, 'queueLiveMessage') + '\nglobalThis.send=queueLiveMessage;', context);
  const p1 = context.send(session, { type: 'BSCG_LIVE_PREVIEW', previewId: 'p', revision: 1 });
  context.send(session, { type: 'BSCG_LIVE_PREVIEW', previewId: 'p', revision: 2 });
  await p1;
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].revision, 2);
  context.send(session, { type: 'BSCG_LIVE_PREVIEW', previewId: 'p', revision: 3 });
  await context.send(session, { type: 'BSCG_LIVE_FINAL', segment: { id: 'p', content: 'final' } });
  assert.equal(delivered.length, 2);
  assert.equal(delivered.at(-1).type, 'BSCG_LIVE_FINAL');
});

test('Model handoff reuses one Worker; idle disposal releases then terminates it', async () => {
  const h = engineHarness();
  let terminated = 0;
  const messages = [];
  const worker = { terminate: () => {terminated++;}, postMessage: message => {
    messages.push(message.type);
    if (message.type === 'qwen-cancel-session') queueMicrotask(() => h.handleWorkerMessage({ type: 'session-cancelled', sessionId: message.sessionId }));
    if (message.type === 'qwen-dispose') queueMicrotask(() => h.handleWorkerMessage({ type: 'disposed' }));
  } };
  h.worker(worker, 'qwen3_asr_0_6b:webgpu');
  assert.equal(await h.cancelInferenceForSwitch({ sessionId: 'old' }), true);
  assert.equal(h.createWorker('qwen3_asr_0_6b', 'webgpu', 0), worker);
  assert.equal(terminated, 0);
  assert.equal(await h.releaseIdleModel(), true);
  assert.equal(terminated, 1);
  assert.equal(h.getWorker(), null);
  assert.deepEqual(messages, ['qwen-cancel-session', 'qwen-dispose']);
});

test('Automatic handoff only stops other caption sessions when the requested tab is active', async () => {
  const events = [];
  const session = { tabId: 1, sessionId: 'old', rows: [], mode: 'browser-capture', browserControl: { engineSessionId: 'e1' } };
  const engine = { sessionId: 'e1' };
  let active = false;
  const context = vm.createContext({ liveStartRevision: 4, liveCaptures: new Map([[1, session]]), browserEngineSessions: new Map([['e1', engine]]),
    chrome: { tabs: { get: async () => ({ active }), sendMessage: async () => {} } },
    queueLiveMessage: async (_s, m) => events.push(m.type), setCaptionDisplay: async () => {},
    sendToOffscreen: async m => { events.push(m.reason); return { ok: true }; },
    finishBrowserEngineSession: e => {e.settled = true;}, browserTaskCancelledError: text => new Error(text),
    finalizeLiveCapture: async s => {s.finished = true;}
  });
  vm.runInContext(fn(backgroundSource, 'isLiveStartCurrent') + '\n' + fn(backgroundSource, 'handoffLiveCaptures') + '\nglobalThis.handoff=handoffLiveCaptures;', context);
  assert.equal(await context.handoff({ id: 2 }, { startRevision: 4, automatic: true }), false);
  assert.equal(events.length, 0);
  active = true;
  assert.equal(await context.handoff({ id: 2 }, { startRevision: 4, automatic: true }), true);
  assert.equal(session.stopRequested, true);
  assert.equal(session.finished, true);
  assert.ok(events.includes('tab-switch'));
  assert.ok(events.includes('BSCG_LIVE_HANDOFF'));
});

test('Rapid starts follow the latest request without starting superseded queued pages', async () => {
  const started = [];
  let resume;
  const context = vm.createContext({ startLiveCaptureNow: async tab => {
    started.push(tab);
    if (tab === 1) await new Promise(resolve => {resume = resolve;});
    return { ok: true, tab };
  } });
  vm.runInContext('let liveStartChain=Promise.resolve();let liveStartRevision=0;\n' + fn(backgroundSource, 'startLiveCapture') + '\nglobalThis.start=startLiveCapture;', context);
  const first = context.start(1);
  await turns();
  const second = context.start(2), third = context.start(3);
  resume();
  await first;
  assert.equal((await second).superseded, true);
  assert.equal((await third).tab, 3);
  assert.deepEqual(started, [1, 3]);
});

test('Automatic starts require window focus and reject requests superseded during eligibility checks', async () => {
  let active = true, focused = false, supersedeDuringRead = false;
  const context = vm.createContext({ liveStartRevision: 8,
    chrome: { tabs: { get: async () => {
      if (supersedeDuringRead) context.liveStartRevision++;
      return { active, windowId: 1 };
    } }, windows: { get: async () => ({ focused }) } }
  });
  vm.runInContext(fn(backgroundSource, 'isLiveStartCurrent') + '\nglobalThis.eligible=isLiveStartCurrent;', context);
  const request = { automatic: true, startRevision: 8 };
  assert.equal(await context.eligible(2, request), false);
  focused = true;
  assert.equal(await context.eligible(2, request), true);
  active = false;
  assert.equal(await context.eligible(2, request), false);
  assert.equal(await context.eligible(2, { startRevision: 8 }), true);
  active = true;
  supersedeDuringRead = true;
  assert.equal(await context.eligible(2, request), false);
});

test('The Bilibili part identity rejects a stale URL page instead of pairing the wrong subtitles with the title', () => {
  const logged = [];
  const context = vm.createContext({ pushLog: (level, text) => logged.push(`${level}:${text}`) });
  vm.runInContext(fn(backgroundSource, 'assertBilibiliPlayingPart') + '\nglobalThis.check=assertBilibiliPlayingPart;', context);
  // URL and player agree: cid and page both match.
  context.check({ initialCid: '101', playingCid: '101', pageNumber: 1, playingPageNumber: 1 });
  assert.equal(logged.length, 0);
  // In-page part switch with a lagging URL: player cid/page differ from what the URL resolves to.
  assert.throws(() => context.check({ initialCid: '101', playingCid: '202', pageNumber: 1, playingPageNumber: 2 }), /分P/);
  assert.match(logged.at(-1), /分P错配已拦截.*202.*101/s);
  assert.throws(() => context.check({ initialCid: '101', playingCid: '202', pageNumber: 1, playingPageNumber: 0 }), /分P/);
  // Unknown player state must not block a legitimate single-part summary.
  context.check({ initialCid: '101', playingCid: '', pageNumber: 1, playingPageNumber: 0 });
  context.check({ initialCid: '', playingCid: '202', pageNumber: 2, playingPageNumber: 2 });
  context.check({});
  assert.equal(logged.length, 2);
});

test('A subtitle attachment whose name disagrees with its own text header is rejected', () => {
  const context = vm.createContext({ safeFileName: value =>
    String(value || '在线视频').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100),
    pushLog() {} });
  vm.runInContext(['textHeaderTitle', 'fileNameMatchesText', 'alignPayloadFileName'].map(name => fn(backgroundSource, name)).join('\n') +
    '\nglobalThis.matches=fileNameMatchesText;globalThis.realign=alignPayloadFileName;', context);

  const text = '视频：真正的标题\n链接：https://www.bilibili.com/video/BV1\n字幕来源：中文\n\n[00:00–00:10] 正文';
  assert.equal(context.matches('真正的标题-字幕.txt', text), true);
  assert.equal(context.matches('另一个视频的标题-字幕.txt', text), false);
  // Names are sanitized on write, so a cleanable title must not look like a mismatch.
  const piped = '视频：A | B\n\n[00:00–00:10] 正文';
  assert.equal(context.matches('A _ B-字幕.txt', piped), true);
  // With no header there is nothing to compare against.
  assert.equal(context.matches('随便-字幕.txt', '没有头部'), true);

  assert.equal(context.realign({ fileName: '真正的标题-字幕.txt', text }), '真正的标题-字幕.txt');
  const corrected = context.realign({ fileName: '另一个视频的标题-字幕.txt', text });
  assert.equal(corrected, '真正的标题-字幕.txt');
  assert.equal(context.realign({ fileName: '另一个视频的标题-字幕.txt', text, summaryText: text }), '真正的标题-字幕.txt');
  // Without usable header information the original name is kept.
  assert.equal(context.realign({ fileName: '保持-字幕.txt', text: '没有头部' }), '保持-字幕.txt');
});

function attachmentDom(nodes) {
  const make = (spec) => {
    const attributes = spec.attrs || {};
    const value = {
      attrs: attributes, textContent: spec.text || '', children: [],
      getAttribute: name => attributes[name] ?? null,
      closest: () => null
    };
    value.children = (spec.children || []).map(make);
    return value;
  };
  const list = nodes.map(make);
  const document = {
    querySelectorAll: selector => list.filter(node => {
      const kind = node.attrs['data-kind'] || '';
      if (kind === 'aria') return selector.includes('aria-label');
      if (kind === 'title') return /\[title\]/.test(selector);
      if (kind === 'fileclass') return selector.includes('class*="file"');
      if (kind === 'attachclass') return selector.includes('class*="attach"');
      return false;
    })
  };
  const context = vm.createContext({ document, setTimeout, Promise });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(new URL('../attachment-guard.js', import.meta.url), 'utf8'), context);
  return context;
}

test('Attachment checks only trust real attachment entries, never the prompt or editor text', () => {
  const guard = attachmentDom([
    // 提示词里出现的标题（编辑区内容）绝不能算作附件。
    { attrs: { 'data-kind': 'fileclass' }, text: '完整总结视频字幕中的观点和内容。' },
    { attrs: { 'data-kind': 'fileclass' }, text: '真正的标题-字幕.txt' }
  ]).BSCG_ATTACHMENT_GUARD;
  const matched = guard.state('真正的标题-字幕.txt');
  assert.equal(matched.ours.length, 1);
  assert.equal(matched.stale.length, 0);
  // 标题只出现在提示词里时，不得判定为"已附带"。
  const missing = guard.state('另一个视频的标题-字幕.txt');
  assert.equal(missing.ours.length, 0);
});

test('A leftover subtitle attachment from a previous summary is reported as stale', () => {
  const guard = attachmentDom([
    { attrs: { 'data-kind': 'aria' }, text: '真正的标题-字幕.txt' },
    { attrs: { 'data-kind': 'attachclass' }, text: '上一次的标题-字幕.txt' }
  ]).BSCG_ATTACHMENT_GUARD;
  const state = guard.state('真正的标题-字幕.txt');
  assert.equal(state.ours.length, 1);
  assert.equal(state.stale.length, 1);
  assert.match(guard.textOf(state.stale[0]), /上一次的标题-字幕\.txt/);
  // 图片等非字幕附件不算冲突。
  const withImage = attachmentDom([
    { attrs: { 'data-kind': 'fileclass' }, text: '真正的标题-字幕.txt' },
    { attrs: { 'data-kind': 'fileclass' }, text: 'screenshot.png' }
  ]).BSCG_ATTACHMENT_GUARD.state('真正的标题-字幕.txt');
  assert.equal(withImage.stale.length, 0);
  // 整块正文容器（多行）不得被当成附件条目。
  const prose = attachmentDom([
    { attrs: { 'data-kind': 'fileclass' }, text: '真正的标题-字幕.txt\n[00:00–00:10] 正文\n[00:10–00:20] 更多正文' }
  ]).BSCG_ATTACHMENT_GUARD.state('真正的标题-字幕.txt');
  assert.equal(prose.ours.length, 0);
  // 只匹配"带 -字幕 的文本文件"是不够的：其它任务的字幕文件必须被识别为冲突。
  const differentExtension = attachmentDom([
    { attrs: { 'data-kind': 'fileclass' }, text: '真正的标题-字幕.txt' },
    { attrs: { 'data-kind': 'fileclass' }, text: '别的东西-字幕.srt' }
  ]).BSCG_ATTACHMENT_GUARD.state('真正的标题-字幕.txt');
  assert.equal(differentExtension.stale.length, 1);
});

function bilibiliAudioContext(options = {}) {
  const logs = [];
  const context = vm.createContext({
    pushLog: (level, text) => logs.push(`${level}:${text}`),
    getBilibiliPlayerAudioCandidates: async () => options.player || [],
    getBilibiliApiAudioCandidates: async () => options.api || [],
    getGenericMediaSource: async () => options.generic || null,
    getObservedMediaRecords: async () => options.observed || [],
    fetchJson: async () => ({ code: 0, data: {} }),
    bilibiliMediaPath: value => String(value || '').split('?')[0],
    buildBilibiliWbiPlayurlUrl: async () => 'https://api.bilibili.com/x/player/wbi/playurl',
    collectBilibiliAudioCandidates: () => [],
    Promise, URL, console
  });
  vm.runInContext(['pageMediaMatchesExpectedDuration', 'resolveBilibiliAudioCandidates'].map(name => fn(backgroundSource, name)).join('\n') +
    '\nglobalThis.durationOk=pageMediaMatchesExpectedDuration;globalThis.resolve=resolveBilibiliAudioCandidates;', context);
  const dash = { url: 'https://upos.example/audio.m4s?sig=1', kind: 'dash-audio', source: 'player-captured' };
  return { context, logs, dash };
}

test('A media element whose duration disagrees with the current part is never used as its audio', async () => {
  const dashCandidate = { url: 'https://upos.example/audio.m4s?sig=1', kind: 'dash-audio', source: 'player-captured' };
  const { context, logs, dash } = bilibiliAudioContext({ player: [dashCandidate], generic: { mediaUrl: 'https://example/other.mp4', duration: 757 } });
  assert.equal(dash.url, dashCandidate.url);
  // 1044s 是当前分P 的权威时长；757s 的媒体属于别的视频。
  const rejected = await context.resolve(7, 'BV1fBbN6XECK', '41667070955', { expectedDuration: 1044 });
  assert.deepEqual(Array.from(rejected, item => item.url), [dash.url]);
  assert.match(logs.join('\n'), /已丢弃页面媒体候选/);
  // 时长吻合时才允许作为候选（页面媒体排在自带签名的候选之后）。
  const accepted = await context.resolve(7, 'BV1fBbN6XECK', '41667070955', { expectedDuration: 750 });
  assert.equal(accepted.map(item => item.url).includes('https://example/other.mp4'), true);
  // 时长无法确认时不得擅自拒绝。
  assert.equal(context.durationOk({ duration: 500 }, 0), true);
  assert.equal(context.durationOk({ duration: 1044 }, 1044), true);
  assert.equal(context.durationOk({ duration: 757 }, 1044), false);
  assert.equal(context.durationOk({ duration: 0 }, 1044), false);
});

test('Audio resolution refuses to guess when the only candidate belongs to another video', async () => {
  const { context, logs } = bilibiliAudioContext({ generic: { mediaUrl: 'https://example/other.mp4', duration: 757 } });
  await assert.rejects(
    context.resolve(7, 'BV1fBbN6XECK', '41667070955', { expectedDuration: 1044 }),
    /不是同一支视频/);
  // 没有页面媒体可比对时，仍然只是"没有候选"，不能谎报身份冲突。
  const empty = bilibiliAudioContext({});
  const candidates = await empty.context.resolve(7, 'BV1fBbN6XECK', '41667070955', { expectedDuration: 1044 });
  assert.equal(candidates.length, 0);
  assert.doesNotMatch(logs.join('\n'), /不是同一支视频/);
});

test('Platform subtitles whose timestamps overrun the video length are rejected', () => {
  const context = vm.createContext({});
  vm.runInContext(['ccSubtitleSpan', 'ccSubtitleFitsPart'].map(name => fn(backgroundSource, name)).join('\n') +
    '\nglobalThis.span=ccSubtitleSpan;globalThis.fits=ccSubtitleFitsPart;', context);
  const cues = (...pairs) => pairs.map(([from, to]) => ({ from, to, content: '句子' }));

  // 正常：字幕在 1044s 的视频内结束。
  const good = cues([0, 3], [500, 520], [1040, 1043.5]);
  assert.equal(context.fits(good, 1044), true);
  assert.equal(context.span(good).to, 1043.5);
  // 错配：756s 结束的字幕配到 1044s 的分P 上本身不算超限，
  // 但结束时间明显超出总时长时必须拒绝。
  assert.equal(context.fits(cues([0, 3], [1100, 1200]), 1044), false);
  // 边界：片尾多出一点（转场/结尾卡）仍在容差内。
  assert.equal(context.fits(cues([0, 3], [1044, 1050]), 1044), true);
  assert.equal(context.fits(cues([0, 3], [1044, 1120]), 1044), false);
  // 没有权威时长时不擅自拒绝。
  assert.equal(context.fits(cues([0, 3], [9999, 10000]), 0), true);
  // 空字幕/无有效时间戳不得被当成"符合"。
  assert.equal(context.fits([], 1044), false);
  assert.equal(context.fits(cues([0, 0]), 1044), false);
});

test('A track that only covers the opening minutes is not treated as a usable subtitle', () => {
  const context = vm.createContext({});
  const nonSpeechLiteral = /const NON_SPEECH_CAPTION = (\/.*\/u);/.exec(backgroundSource)[1];
  vm.runInContext(`const NON_SPEECH_CAPTION = ${nonSpeechLiteral};\n` +
    ['ccSubtitleSpan', 'captionSpeechLength', 'looksLikeNonSpeechCaption', 'assessSubtitleCoverage']
      .map(name => fn(backgroundSource, name)).join('\n') +
    '\nglobalThis.assess=assessSubtitleCoverage;globalThis.nonSpeech=looksLikeNonSpeechCaption;', context);

  // 真实故障数据：1123s 的视频，B 站字幕只有 19 条、全是 ♪ 音乐 ♪、覆盖到 56.98s。
  const musicOnly = Array.from({ length: 19 }, (_, i) => ({ from: 7.7 + i * 2, to: 9.2 + i * 2, content: '♪ 音乐 ♪' }));
  const coverage = context.assess(musicOnly, 1123);
  assert.equal(coverage.usable, false);
  assert.equal(coverage.cues, 19);
  assert.equal(coverage.speech, 0);
  assert.ok(coverage.covered < 0.1);

  // 覆盖到片尾但夹杂音乐标注：仍然可用。
  const withMusic = [
    ...musicOnly,
    { from: 100, to: 130, content: '今天我们来聊聊这种药物的作用机制' },
    { from: 1080, to: 1120, content: '以上就是本期内容，感谢观看' }
  ];
  assert.equal(context.assess(withMusic, 1123).usable, true);
  // 覆盖不足一半：即便句句是正常语音也不可用。
  const halfOnly = [{ from: 0, to: 500, content: '这是正常的字幕内容值得总结' }];
  assert.equal(context.assess(halfOnly, 1123).usable, false);
  // 10 分钟的短视频里 6 分钟字幕：可用。
  assert.equal(context.assess([{ from: 0, to: 360, content: '正常内容' }], 600).usable, true);
  // 非语音标注的判定。
  assert.equal(context.nonSpeech('♪ 音乐 ♪'), true);
  assert.equal(context.nonSpeech('[音乐]'), true);
  assert.equal(context.nonSpeech('（掌声）'), true);
  assert.equal(context.nonSpeech('大家好，今天我们聊聊 GLP-1'), false);
  assert.equal(context.nonSpeech(''), true);
});

test('The progress bar keeps the latest entries newest-first and skips repeats', () => {
  const context = vm.createContext({ Date });
  vm.runInContext('const RECENT_LOG_MAX = 40;const ACTIVITY_CARD_LINES = 3;const recentLogs = [];\n' +
    fn(uiSource, 'recordActivity') + '\n' + fn(uiSource, 'activityCardLines') +
    '\nglobalThis.record=(level,text)=>recordActivity(level,text,()=>{});' +
    'globalThis.lines=()=>activityCardLines(recentLogs);globalThis.all=()=>recentLogs;', context);
  assert.equal(context.lines().length, 0);
  context.record('info', '正在读取视频信息…');
  context.record('info', '正在读取 B站字幕…');
  context.record('warn', '已拒绝覆盖不足的 CC 字幕：仅 19 条；改用本地识别');
  // 最新一条排最前，方便悬停时第一眼看到。
  assert.deepEqual(Array.from(context.lines(), item => item.text), [
    '已拒绝覆盖不足的 CC 字幕：仅 19 条；改用本地识别',
    '正在读取 B站字幕…',
    '正在读取视频信息…'
  ]);
  assert.equal(context.lines()[0].level, 'warn');
  // 卡片只保留 3 条，但缓冲区继续累积。
  context.record('info', '已得到 19 段文本，正在打开 DeepSeek…');
  assert.equal(context.lines().length, 3);
  assert.equal(context.all().length, 4);
  // 同一条状态重复推送不占位。
  context.record('info', '已得到 19 段文本，正在打开 DeepSeek…');
  assert.equal(context.all().length, 4);
  // 空文本不记录。
  context.record('info', '   ');
  assert.equal(context.all().length, 4);
  // 缓冲区有上限。
  for (let i = 0; i < 60; i += 1) context.record('info', `进度 ${i}`);
  assert.equal(context.all().length, 40);
  assert.equal(context.all().at(-1).text, '进度 59');
});

test('Attachment checks can tell "already sent or attached" apart from "not attached"', () => {
  // 复刻 attachment-guard 的 DOM 依赖：编辑器 + 收件区内的叶子节点。
  const makeNode = (tagName, text, children = []) => {
    const node = {
      tagName, textContent: text, children,
      querySelector: () => children.find((child) => child.tagName !== 'TEXTAREA') || null
    };
    return node;
  };
  const editor = { tagName: 'TEXTAREA', value: '', textContent: '' };
  const fileNameLeaf = makeNode('SPAN', '减肥神药”GLP-1：字幕.txt');
  const promptLeaf = makeNode('SPAN', '完整总结视频字幕中的观点和内容。');
  const wrapper = makeNode('DIV', `减肥神药”GLP-1：字幕.txt`, [fileNameLeaf]);
  const promptWrapper = makeNode('DIV', '完整总结视频字幕中的观点和内容。', [promptLeaf]);
  const composer = {
    querySelectorAll: () => [wrapper, fileNameLeaf, promptWrapper],
    contains: () => false
  };
  editor.closest = (selector) => (selector === 'form' ? composer : null);

  const context = vm.createContext({ document: { querySelectorAll: () => [] }, setTimeout, Promise });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(new URL('../attachment-guard.js', import.meta.url), 'utf8'), context);
  const guard = context.BSCG_ATTACHMENT_GUARD;

  // 编辑器已清空 → 消息已经发出，不该再报"没确认到附件"。
  editor.value = '';
  assert.equal(guard.composerLooksSent(editor), true);
  // 编辑器里还有内容 → 尚未发出。
  editor.value = '完整总结视频字幕中的观点和内容。';
  assert.equal(guard.composerLooksSent(editor), false);

  // 收件区里确实带着本次文件名 → 视为已附加。
  assert.equal(guard.fileNameInComposer(editor, '减肥神药”GLP-1：字幕.txt'), true);
  // 标题只出现在提示词里（编辑器的文本包含它）→ 不算附件。
  editor.value = '完整总结视频字幕中的观点和内容。';
  assert.equal(guard.fileNameInComposer(editor, '完整总结视频字幕中的观点和内容。'), false);
  // 完全不相干的名字 → 不算附件。
  assert.equal(guard.fileNameInComposer(editor, '别的视频-字幕.txt'), false);
  // 没有编辑器时不得抛错。
  assert.equal(guard.fileNameInComposer(null, 'x-字幕.txt'), false);
});

function cacheContext(stored) {
  const store = new Map(Object.entries(stored));
  const removed = [];
  const logs = [];
  const context = vm.createContext({
    console,
    pushLog: (level, text) => logs.push(`${level}:${text}`),
    chrome: { storage: { local: {
      get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
      remove: async (key) => { removed.push(key); store.delete(key); }
    } } },
    Promise, Date
  });
  vm.runInContext('const RESULT_TTL_MS = 7*24*60*60*1000;const RESULT_SCHEMA_VERSION = 6;let stored = null;\n' +
    fn(backgroundSource, 'resultStorageKey') + '\n' + fn(backgroundSource, 'resultDurationMatches') + '\n' +
    fn(backgroundSource, 'findCachedResult') + '\nglobalThis.matches=resultDurationMatches;globalThis.find=findCachedResult;', context);
  return { context, store, removed, logs };
}

test('A cached transcript that cannot prove its own duration is discarded and re-recognised', async () => {
  const poisoned = {
    schemaVersion: 6, createdAt: Date.now(), text: '视频：减肥神药…\n\n[00:00–00:55] 今天我们要吃贵阳街头',
    fileName: '减肥神药…-字幕.txt', mediaDuration: 757, sourceVideoId: 'BV1fBbN6XECK', sourcePartId: '41667070958'
  };
  const key = 'result:7:BV1fBbN6XECK:41667070958';
  const rejected = cacheContext({ [key]: poisoned });
  // 当前分P 权威时长 1044s，缓存自称 757s：必须作废而不是直接发出去。
  assert.equal(await rejected.context.find(7, 'BV1fBbN6XECK', '41667070958', 1044), null);
  assert.equal(rejected.store.has(key), false);
  assert.match(rejected.logs.join('\n'), /已作废时长不符的缓存字幕/);

  // 时长吻合时正常复用。
  const healthy = cacheContext({ [key]: { ...poisoned, mediaDuration: 1040 } });
  assert.ok(await healthy.context.find(7, 'BV1fBbN6XECK', '41667070958', 1044));
  // 缺任一侧的时长都无法自证：没有记录时长的旧缓存必须重新识别。
  const missingRecorded = cacheContext({ [key]: { ...poisoned, mediaDuration: 0 } });
  assert.equal(await missingRecorded.context.find(7, 'BV1fBbN6XECK', '41667070958', 1044), null);
  // 旧 schema 的缓存（无法自证身份）同样作废。
  const oldSchema = cacheContext({ [key]: { ...poisoned, schemaVersion: 4, mediaDuration: 1040 } });
  assert.equal(await oldSchema.context.find(7, 'BV1fBbN6XECK', '41667070958', 1044), null);
  // 判据本身：容差 max(5%, 8s)。
  assert.equal(rejected.context.matches(1044, 1044), true);
  assert.equal(rejected.context.matches(1040, 1044), true);
  assert.equal(rejected.context.matches(757, 1044), false);
  assert.equal(rejected.context.matches(0, 1044), false);
});

test('Status reads preserve the idle alarm; a restarted service worker checks actual engine activity', async () => {
  const alarms = new Map();
  let runtime = { activeSession: { sessionId: 's' } }, closed = 0;
  const context = vm.createContext({ OFFSCREEN_IDLE_ALARM: 'idle', offscreenCloseTimer: null,
    liveCaptures: new Map(), browserEngineSessions: new Map(), browserRequestQueue: [],
    activeBrowserRequest: null, activeBenchmarkId: '', activeModelDownloadId: '', creatingOffscreenDocument: null,
    chrome: { alarms: { get: async id => alarms.get(id), clear: async id => alarms.delete(id), create: async (id, value) => alarms.set(id, value) },
      runtime: { sendMessage: async () => runtime }, offscreen: { closeDocument: async () => {closed++;} } },
    ensureOffscreenDocument: async () => {}, pushLog() {}, clearTimeout() {}
  });
  vm.runInContext(['sendToOffscreen', 'maybeCloseOffscreenDocument', 'closeIdleOffscreenDocument'].map(name => fn(backgroundSource, name)).join('\n') +
    '\nglobalThis.audit={sendToOffscreen,maybeCloseOffscreenDocument,closeIdleOffscreenDocument};', context);
  await context.audit.maybeCloseOffscreenDocument();
  await context.audit.sendToOffscreen({ type: 'BILI_ASR_CAPABILITIES' });
  assert.ok(alarms.has('idle'));
  await context.audit.closeIdleOffscreenDocument();
  assert.equal(closed, 0);
  runtime = {};
  await context.audit.closeIdleOffscreenDocument();
  assert.equal(closed, 1);
});

test('Benchmark records compressed bytes before audio decode detaches the input', async () => {
  const context = vm.createContext({ TARGET_SAMPLE_RATE: 16000, chrome: { runtime: { getURL: file => file } },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(110670) }),
    decodeDirectAudio: async (_state, buffer) => { structuredClone(buffer, { transfer: [buffer] }); return new Float32Array(60 * 16000); }
  });
  vm.runInContext(fn(engineSource, 'loadBenchmarkAudio') + '\nglobalThis.load=loadBenchmarkAudio;', context);
  assert.equal((await context.load({})).compressedBytes, 110670);
});

// ---- 前瞻字幕翻译：只作用于能直接取到音轨的整轨识别路径（B站音轨 / M3U8 / MP4）----

const translateSource = source('translate.js');
const optionsSource = source('options.js');
const optionsHtmlSource = source('options.html');

function translateApi() {
  const context = vm.createContext({});
  vm.runInContext(`${translateSource}\nglobalThis.api = BSCG_TRANSLATE;`, context);
  return context.api;
}

// 翻译器夹具：除 translateLines / 端点判断外，其余全部取 background.js 里的真实函数，
// 连显示切分和 rows 覆盖都是真的，避免测到一条和运行时不同的"理想路径"。
// position 模拟播放头位置：领先量够（默认 0 起点、行从 0 开始）就先压着不上屏。
function translatorHarness(translateLines, options = {}) {
  const messages = [];
  const logs = [];
  const session = {
    tabId: 7, sessionId: 's1', mode: 'browser-direct', rows: [], bufferedTo: 0,
    currentVideoTime: Number(options.position) || 0
  };
  const context = vm.createContext({
    LIVE_CAPTION_MAX_CHARACTERS: 18,
    MAX_LIVE_ROWS: 20000,
    setTimeout: () => 0,
    clearTimeout: () => {},
    pushLog: (level, message) => logs.push(`${level}:${message}`),
    queueLiveMessage: async (_session, message) => { messages.push(message); },
    translateActiveConfig: () => ({ enabled: true, mode: 'local', baseUrl: 'http://127.0.0.1:8888/v1',
      apiKey: '', model: 'tencent/Hy-MT2-1.8B-GGUF', targetLanguage: 'zh',
      displayMode: options.displayMode || 'translated' }),
    translateIsReady: () => true,
    translateLines
  });
  const names = ['cleanDisplayCaption', 'joinDisplayCaption', 'captionTextLength', 'splitRecognizedCaption',
    'queueDisplaySegments', 'addTimelineSegment', 'publishRecognizedSegment', 'emitCaptionRow',
    'startBrowserDirectTranslator', 'publishTranslatedCaptionSegment'];
  vm.runInContext(`${names.map(name => fn(backgroundSource, name)).join('\n')}
globalThis.audit = { startBrowserDirectTranslator, publishTranslatedCaptionSegment, publishRecognizedSegment };`, context);
  return { session, messages, logs, audit: context.audit };
}

test('Translation targets the selected side and rejects unusable endpoints', () => {
  const api = translateApi();
  const local = api.translateActiveConfig({
    translateEnabled: true, translateMode: 'local',
    translateLocalBaseUrl: 'http://127.0.0.1:8888/v1/', translateLocalApiKey: 'sk-unsloth-x',
    translateLocalModel: 'tencent/Hy-MT2-1.8B-GGUF',
    translateRemoteBaseUrl: 'https://api.openai.com/v1', translateRemoteModel: 'gpt-4o-mini'
  });
  assert.equal(local.mode, 'local');
  assert.equal(local.model, 'tencent/Hy-MT2-1.8B-GGUF');
  // 尾部斜杠不收掉就会拼出 //chat/completions，本地服务直接 404。
  assert.equal(local.baseUrl, 'http://127.0.0.1:8888/v1');
  assert.equal(api.translateModelsUrl(local), 'http://127.0.0.1:8888/v1/models');
  assert.equal(api.translateCompletionsUrl(local), 'http://127.0.0.1:8888/v1/chat/completions');
  assert.equal(api.translateIsReady(local), true);

  const remote = api.translateActiveConfig({ translateEnabled: true, translateMode: 'remote',
    translateRemoteBaseUrl: 'https://api.openai.com/v1', translateRemoteModel: 'gpt-4o-mini' });
  assert.equal(remote.mode, 'remote');
  assert.equal(remote.model, 'gpt-4o-mini');
  assert.equal(remote.apiKey, '', '远程侧不会串到本地的 key');

  const defaults = api.translateActiveConfig({});
  assert.equal(defaults.enabled, false, '默认关闭，不改变现有行为');
  assert.equal(defaults.targetLanguage, 'zh', '默认翻译为中文（简体）');
  assert.equal(defaults.baseUrl, 'http://127.0.0.1:8888/v1', '本地默认指向 UNSLOTH Studio');
  assert.equal(api.translateIsReady(defaults), false);
  assert.match(api.translateUnavailableReason(defaults), /翻译未启用/);
  assert.match(api.translateUnavailableReason({ ...defaults, enabled: true, model: 'm', baseUrl: '127.0.0.1:8888/v1' }), /Base URL 无效/);
  assert.match(api.translateUnavailableReason({ ...defaults, enabled: true }), /未选择模型/);
  // 目标语言来自设置页，非法值必须回落，不能把奇怪的语言名塞进提示词。
  assert.equal(api.translateActiveConfig({ translateEnabled: true, translateTargetLanguage: '!!' }).targetLanguage, 'zh');
});

test('The translation prompt keeps one line per caption and the reply is parsed per line', () => {
  const api = translateApi();
  const prompt = api.translateSystemPrompt('zh');
  assert.match(prompt, /中文（简体）/);
  assert.match(prompt, /行序、行数严格一一对应/);
  assert.match(api.translateSystemPrompt('ja'), /日语/);
  // 行内换行必须压平：否则一条字幕会被模型当成两条，行号整体错位。
  assert.equal(api.translateUserContent([' a\nb ', 'c']), 'a b\nc');
  assert.deepEqual(Array.from(api.parseTranslatedLines('1. 你好\n2. 世界', 2)), ['你好', '世界']);
  assert.deepEqual(Array.from(api.parseTranslatedLines('“你好”\n世界', 2)), ['你好', '世界']);
  assert.deepEqual(Array.from(api.parseTranslatedLines(' 一整段 ', 1)), ['一整段']);
  // 行数不足必须判失败——错位的译文比不翻更糟。
  assert.equal(api.parseTranslatedLines('只有一行', 3), null);
  assert.equal(api.parseTranslatedLines('', 2), null);
  assert.ok(api.estimateMaxTokens(['a'.repeat(5000)]) <= 4000);
  assert.ok(api.estimateMaxTokens(['短句']) >= 160);
});

test('The translation module keeps request guards that would silently disable its timeouts', () => {
  // abortSignalFor 本身返回 signal；再取一层 .signal 会得到 undefined，超时彻底失效。
  assert.ok(!/abortSignalFor\([^)]*\)\.signal/.test(translateSource));
  assert.match(translateSource, /const signal = abortSignalFor\(TRANSLATE_REQUEST_TIMEOUT_MS\);/);
  assert.match(translateSource, /const signal = abortSignalFor\(TRANSLATE_MODEL_LIST_TIMEOUT_MS\);/);
  assert.ok(!/Array\.isable/.test(translateSource), 'Array.isable 是拼写错误，会直接抛错');
  // 本地 GGUF 冷启动要几十秒，旧的 15/120 秒会在首帧就把整轨翻译判死。
  assert.match(translateSource, /TRANSLATE_MODEL_LIST_TIMEOUT_MS = 45 \* 1000/);
  assert.match(translateSource, /TRANSLATE_REQUEST_TIMEOUT_MS = 240 \* 1000/);
  // 两种后端都按 OpenAI 兼容形状解析：data[].id 与 models[].name。
  assert.match(translateSource, /Array\.isArray\(payload\?\.models\)/);
});

test('Forecast captions are batched to the model and land back on the same timeline', async () => {
  const batches = [];
  const harness = translatorHarness(async (_config, texts) => {
    batches.push(texts.slice());
    return { ok: true, texts: texts.map(text => `译:${text}`) };
  });
  const { session, audit } = harness;
  const translator = audit.startBrowserDirectTranslator(session, {}, () => {});
  assert.ok(translator, '配置就绪时必须创建翻译队列');
  // publishTranslatedCaptionSegment 只有看到 session.translator 才会进队。
  session.translator = translator;

  // 每行 12 字（低于 LIVE_CAPTION_MAX_CHARACTERS=18，保证一行就是一条显示字幕，
  // 不会被 splitRecognizedCaption 二次切分）；20 行共 240 字，按"至少 200 字一批"
  // 应当拆成 17 + 3 两批。行从 40 秒起（播放头默认 0）：领先足够，压着等译文。
  const rows = Array.from({ length: 20 }, (_value, index) => ({
    from: 40 + index * 2, to: 42 + index * 2, content: `句子${index}`.padEnd(12, '好')
  }));
  const publish = (row) => audit.publishTranslatedCaptionSegment(session, row);
  publish(rows[0]);
  await Promise.resolve();
  assert.equal(batches.length, 0, '没凑够一批时不该逐条打请求');

  rows.slice(1).forEach(publish);
  await translator.finish();
  assert.equal(batches.length, 2, '先凑满一批（≥200 字）再收尾剩余');
  assert.ok(batches[0].length >= 17, `一批至少 200 字（实得 ${batches[0].length} 行）`);
  assert.ok(batches[0].join('').length >= 200, '单批字符数必须达到 200 字下限');
  // 关键不变量：时间轴与行数一字不动，只换内容；否则译文会盖到别的句子上。
  assert.deepEqual(session.rows.map(row => row.from), rows.map(row => row.from));
  assert.deepEqual(session.rows.map(row => row.to), rows.map(row => row.to));
  assert.ok(session.rows.every(row => row.content.startsWith('译:')), '全部换成译文');
  assert.equal(translator.stats().translated, rows.length);
});

test('Captions ahead of the playhead wait for the translation and show it first', async () => {
  const batches = [];
  // 播放头在 0 秒，行从 30 秒起：领先量远超阈值，必须压着等译文。
  const harness = translatorHarness(async (_config, texts) => {
    batches.push(texts.slice());
    return { ok: true, texts: texts.map(text => `译:${text}`) };
  }, { position: 0 });
  const { session, audit, messages } = harness;
  session.translator = audit.startBrowserDirectTranslator(session, {}, () => {});

  const rows = Array.from({ length: 12 }, (_value, index) => ({
    from: 30 + index * 3, to: 32 + index * 3, content: `ahead line ${index}`.padEnd(20, 'x')
  }));
  for (const row of rows) audit.publishTranslatedCaptionSegment(session, row);
  assert.equal(messages.filter(message => message.type === 'BSCG_LIVE_SEGMENT').length, 0,
    '领先足够时不得先把识别原文发上屏');
  assert.ok(session.translator.stats().held > 0, '应当有行被压住等译文');

  await session.translator.finish();
  const shown = messages.filter(message => message.type === 'BSCG_LIVE_SEGMENT');
  assert.equal(shown.length, rows.length, '收尾后每行都应上屏');
  assert.ok(shown.every(message => message.segment.content.startsWith('译:')),
    '页面看到的第一个版本就是译文，没有出现"先原文再覆盖"');
  assert.ok(!/译:译:/.test(shown.map(message => message.segment.content).join('')), '不得重复翻译');
});

test('When the playhead catches up the translation, the recognised text is shown at once', async () => {
  // 播放头 0 秒、行从 1 秒起：领先量不足阈值，必须立刻按识别原文上屏。
  const harness = translatorHarness(async (_config, texts) => ({ ok: true, texts: texts.map(t => `译:${t}`) }),
    { position: 0 });
  const { session, audit, messages } = harness;
  session.translator = audit.startBrowserDirectTranslator(session, {}, () => {});

  audit.publishTranslatedCaptionSegment(session, { from: 1, to: 3, content: 'right now' });
  const shown = messages.filter(message => message.type === 'BSCG_LIVE_SEGMENT');
  assert.equal(shown.length, 1, '被播放头追平的行必须立刻上屏，不能留空');
  assert.equal(session.translator.stats().fallback, 1);

  // 快进：压着的行被追平后，tick() 必须把它们按原文落地。
  const held = [];
  for (let index = 0; index < 4; index += 1) {
    held.push({ from: 40 + index * 3, to: 42 + index * 3, content: `later line ${index}`.padEnd(20, 'y') });
  }
  for (const row of held) audit.publishTranslatedCaptionSegment(session, row);
  const beforeTick = messages.filter(message => message.type === 'BSCG_LIVE_SEGMENT').length;
  session.currentVideoTime = 100;
  session.translator.tick();
  const afterTick = messages.filter(message => message.type === 'BSCG_LIVE_SEGMENT').length;
  assert.equal(afterTick - beforeTick, held.length, '快进越过识别区后必须立刻落地识别原文');
});

test('Bilingual mode keeps the recognised line as a smaller second row', async () => {
  const harness = translatorHarness(async (_config, texts) => ({ ok: true, texts: texts.map(t => `译:${t}`) }),
    { displayMode: 'bilingual' });
  const { session, audit } = harness;
  session.translator = audit.startBrowserDirectTranslator(session, {}, () => {});
  audit.publishTranslatedCaptionSegment(session, { from: 50, to: 52, content: 'Hello world' });
  await session.translator.finish();

  assert.equal(session.rows.length, 1);
  assert.equal(session.rows[0].content, '译:Hello world');
  assert.equal(session.rows[0].sourceContent, 'Hello world', '双语模式保留识别原文供小字行渲染');
  // 只有译文模式才配 sourceContent；双语只是叠加显示，不改时间轴。
  const plain = translatorHarness(async (_config, texts) => ({ ok: true, texts: texts.map(t => `译:${t}`) }));
  plain.session.translator = plain.audit.startBrowserDirectTranslator(plain.session, {}, () => {});
  plain.audit.publishTranslatedCaptionSegment(plain.session, { from: 50, to: 52, content: 'Hello world' });
  await plain.session.translator.finish();
  assert.equal(plain.session.rows[0].sourceContent, undefined, '译文模式不带原文，避免无谓的渲染分支');
});

test('A failed translation keeps the recognised captions on screen and reports once', async () => {
  const errors = [];
  const calls = [];
  const harness = translatorHarness(async (_config, texts) => {
    calls.push(texts.length);
    return { ok: false, error: '无法连接翻译服务：fetch failed' };
  });
  const { session, audit, messages } = harness;
  session.translator = audit.startBrowserDirectTranslator(session, {}, error => errors.push(error));

  for (let index = 0; index < 12; index += 1) {
    audit.publishTranslatedCaptionSegment(session, { from: 10 + index * 4, to: 13 + index * 4, content: `recognised line ${index}` });
  }
  await session.translator.finish();
  assert.deepEqual(calls, [12], '失败后不再重试，避免刷屏');
  assert.equal(errors.length, 1, '只报一次错');
  assert.match(errors[0], /无法连接翻译服务/);
  assert.ok(session.translator.stats().failure.length > 0);
  // 翻译失败绝不能留白：压着的行必须按识别原文全部落地。
  const shown = messages.filter(message => message.type === 'BSCG_LIVE_SEGMENT');
  assert.equal(shown.length, 12, '失败后仍要逐行显示识别原文');
  assert.equal(session.rows.length, 12);
  assert.ok(session.rows.every(row => row.content && !row.content.startsWith('译:')), '保留识别原文且没有空行');
});

test('Translation is wired only into the whole-track audio path', () => {
  // 整轨直取（B站音轨 / M3U8 / MP4）的分段事件必须走翻译入口
  const direct = /} else if \(event\.type === 'segment' && event\.segment\?\.content\) \{[\s\S]{0,420}?\n {4}\} else if \(event\.type === 'media-control'\)/.exec(backgroundSource);
  assert.ok(direct, '整轨直取的分段事件分支存在');
  assert.match(direct[0], /publishTranslatedCaptionSegment\(session, event\.segment\)/);

  // 拿不到音轨时的实时取音后备不参与翻译：它的分段是滚动修订的，翻了会反复重打
  const capture = fn(backgroundSource, 'startBrowserCapturedLiveCapture');
  assert.ok(!/translator|publishTranslatedCaptionSegment/.test(capture));

  // 翻译队列只挂在 browser-direct 会话上，且会话必须真正登记进 liveCaptures
  const live = fn(backgroundSource, 'startBrowserDirectLive');
  assert.match(live, /session\.translator = startBrowserDirectTranslator\(session, settings,/);
  assert.match(live, /session\.publishCaptionSegment = \(segment\) => \{/);
  assert.match(live, /liveCaptures\.set\(tab\.id, session\)/);
  assert.ok(!/liveCaptapes/.test(backgroundSource), 'liveCaptapes 是拼写错误，会直接抛 ReferenceError');

  // 收尾必须先落地最后一段、等翻译清空，再读 rows 写缓存/发总结
  const finalize = fn(backgroundSource, 'finalizeLiveCaptureNow');
  const flushAt = finalize.indexOf('publishTranslatedCaptionSegment(session, null, true)');
  const finishAt = finalize.indexOf('await session.translator.finish()');
  const rowsAt = finalize.indexOf('const rows = Array.isArray(session.rows)');
  assert.ok(flushAt >= 0 && finishAt > flushAt && rowsAt > finishAt, '收尾顺序：落地 → 等翻译 → 读 rows');
  // 双语只叠加显示：导出/缓存/总结必须剥离 sourceContent，否则总结会变成中英夹杂。
  assert.match(finalize, /const exportRows = rows\.map\(\(row\) => row\.sourceContent/);
  assert.match(finalize, /rows: exportRows/);
});

test('The bilingual second line and the playhead tick are wired into the page script', () => {
  // 双语：译文主行 + 原文小字，字号靠 .cue-src 压低
  assert.match(uiSource, /source\.className = 'cue-src'/);
  assert.match(uiSource, /\.cue-src\{display:block;margin-top:2px;font-size:\.72em/);
  assert.match(uiSource, /sourceContent/);
  // 渲染 key 必须带上原文，否则双语<->仅译文切换后画面不刷新
  assert.match(uiSource, /renderKey = JSON\.stringify\(displayRows\.map\(\(row\) => \[row\.provisional, row\.content, row\.sourceContent/);

  // 播放位置变化必须触发 tick()，快进/回拖才能把压着的行落地
  assert.match(backgroundSource, /session\.translator\?\.tick\?\.\(\)/);
  // 中止后不得再延后显示，否则压着的行永远发不出去
  assert.match(backgroundSource, /const deferDisplay = Boolean\(translator && !translator\.isStopped\(\)\)/);
  assert.match(backgroundSource, /isStopped: \(\) => stopped/);
  // 至少 200 字一批：旧上限 10 行 × 18 字 = 180 字，永远够不着 200
  assert.match(backgroundSource, /BATCH_MIN_CHARACTERS = 200/);
  assert.match(backgroundSource, /BATCH_MAX_LINES = 24/);
  assert.match(backgroundSource, /const DISPLAY_LEAD_SECONDS = 3/);
});

test('Translation settings are consistent across the background defaults and the settings page', () => {
  const keysOf = (block) => [...block.matchAll(/^[ \t]*([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]);
  const backgroundDefaults = /^const DEFAULTS = \{([\s\S]*?)^\};/m.exec(backgroundSource)[1];
  const optionsDefaults = /^const DEFAULTS = \{([\s\S]*?)^\};/m.exec(optionsSource)[1];
  const backgroundKeys = keysOf(backgroundDefaults).filter(key => key.startsWith('translate'));
  const optionsKeys = keysOf(optionsDefaults).filter(key => key.startsWith('translate'));
  assert.equal(backgroundKeys.length, 10);
  assert.deepEqual(optionsKeys, backgroundKeys, '两处默认值的翻译字段必须完全一致');
  assert.match(backgroundDefaults, /translateTargetLanguage: 'zh'/);
  assert.match(backgroundDefaults, /translateDisplayMode: 'translated'/);
  assert.match(backgroundDefaults, /translateLocalBaseUrl: 'http:\/\/127\.0\.0\.1:8888\/v1'/);

  // 每个设置字段都要有控件，否则改了也存不进去
  for (const key of backgroundKeys) {
    assert.ok(new RegExp(`id="${key}"`).test(optionsHtmlSource), `设置页缺少 id="${key}"`);
    assert.ok(new RegExp(`'${key}'`).test(optionsSource), `options.js 未登记 ${key}`);
  }
  assert.match(optionsHtmlSource, /data-section="sec-translate"/);
  assert.match(optionsHtmlSource, /<section class="card" id="sec-translate" hidden>/);
  assert.match(optionsHtmlSource, /id="translateTest"/);
  assert.match(optionsSource, /type: 'BSCG_TRANSLATE_LIST_MODELS'/);
  assert.match(optionsSource, /type: 'BSCG_TRANSLATE_TEST'/);
  // 后台必须把 translate.js 引进来，并显式解构（它是 IIFE，只挂 BSCG_TRANSLATE）
  assert.match(backgroundSource, /importScripts\('media-discovery\.js', 'feedback-shared\.js', 'translate\.js'\)/);
  assert.match(backgroundSource, /\} = BSCG_TRANSLATE;/);
});

let passed = 0;
for (const { name, run } of tests) {
  try { await run(); console.log('PASS ' + name); passed++; }
  catch (error) { console.error('FAIL ' + name + '\n' + error.stack); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} checks passed. GPU latency, VRAM, ASR accuracy and real tab audio remain hardware acceptance tests.`);


test('Translation concurrency gate never exceeds four in-flight requests', async () => {
  let active = 0;
  let maximum = 0;
  const context = vm.createContext({
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '译文' } }] }) };
    }
  });
  vm.runInContext(`${translateSource}\nglobalThis.api = BSCG_TRANSLATE;`, context);
  const config = {
    enabled: true, mode: 'remote', baseUrl: 'https://example.invalid/v1',
    apiKey: '', model: 'test-model', targetLanguage: 'zh', displayMode: 'translated'
  };
  const results = await Promise.all(Array.from({ length: 12 }, () => context.api.translateLines(config, ['hello'])));
  assert.ok(results.every((item) => item.ok));
  assert.equal(maximum, 4);
});

test('Generic media identity ignores tracking/hash churn but keeps meaningful query changes', () => {
  const context = vm.createContext({});
  vm.runInContext(
    fn(backgroundSource, 'genericPageIdentity') + '\n' +
    fn(backgroundSource, 'matchesLiveSource') + '\n' +
    'globalThis.matches = matchesLiveSource;',
    context
  );
  const session = { sourcePlatform: 'web', sourceUrl: 'https://video.example/watch?id=abc&utm_source=feed#comments' };
  assert.equal(context.matches(session, 'https://video.example/watch?utm_source=share&id=abc#player'), true);
  assert.equal(context.matches(session, 'https://video.example/watch?id=def'), false);
});

test('Popup owns local-file permission recovery when an action popup is configured', () => {
  const popupSource = source('popup.js');
  assert.match(popupSource, /isAllowedFileSchemeAccess/);
  assert.doesNotMatch(backgroundSource, /chrome\.action\.onClicked\.addListener/);
});

test('Published privacy text discloses automatic AI summary submission', () => {
  const privacySource = source('privacy.html');
  const readmeSource = source('README.md');
  assert.match(privacySource, /自动触发该网页的 Send \/ Run 操作/);
  assert.match(readmeSource, /附件就绪后\*\*自动提交\*\*/);
  assert.doesNotMatch(privacySource, /不会替用户点击 Send \/ Run/);
});
