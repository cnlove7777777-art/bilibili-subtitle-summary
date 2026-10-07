import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = (name) => readFileSync(new URL(name, root), 'utf8');
const manifest = JSON.parse(source('manifest.json'));
const background = source('background.js');
const universal = source('universal.js');
const translateSource = source('translate.js');
const popup = source('popup.js');
const tests = [];
const test = (name, run) => tests.push({ name, run });

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const brace = src.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadTranslate(overrides = {}) {
  const context = vm.createContext({
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '译文' } }] }) }),
    ...overrides
  });
  vm.runInContext(`${translateSource}\nglobalThis.api = BSCG_TRANSLATE;`, context);
  return context.api;
}

test('version and JavaScript syntax are coherent', () => {
  assert.equal(manifest.version, '0.16.44');
  assert.equal(universal.match(/const CS_VERSION = '([^']+)'/)?.[1], manifest.version);
  for (const name of [
    'aistudio.js','asr-worker.js','attachment-guard.js','audio-worklet.js','background.js','browser-engine.js',
    'capture-audio.js','chatgpt.js','deepseek.js','feedback-shared.js','feedback.js','fetch-bridge.js','hls.js',
    'local-file-bridge.js','media-discovery.js','media-observer.js','model-download.js','options.js','popup.js',
    'qwen-webgpu-worker.js','translate-onnx-bridge.js','translate-onnx-core.js','translate-onnx-models.js',
    'translate-onnx-worker.js','translate-performance.js','translate.js','universal.js','voice-dsp.js'
  ]) execFileSync(process.execPath, ['--check', new URL(name, root).pathname]);
});

test('0.16.43 translation UX cannot silently regress again', () => {
  assert.match(universal, /id="translation-menu"/);
  assert.match(universal, /data-translation="inherit"[^>]*>跟随全局设置</);
  assert.match(universal, /data-translation="on"[^>]*>翻译</);
  assert.match(universal, /data-translation="off"[^>]*>不翻译</);
  assert.match(universal, /BSCG_VIDEO_TRANSLATION_GET/);
  assert.match(universal, /BSCG_VIDEO_TRANSLATION_SET/);
  for (const name of ['translate-onnx-bridge.js','translate-onnx-core.js','translate-onnx-models.js','translate-onnx-worker.js']) {
    assert.ok(existsSync(new URL(name, root)), `${name} missing`);
  }
  assert.match(source('offscreen.html'), /translate-onnx-bridge\.js/);
});

test('translated-only mode blocks unverified source captions', () => {
  assert.match(background, /config\.enabled && config\.displayMode === 'translated' && !outgoing\.segment\.translationVerified/);
  assert.match(background, /displayMode === 'translated' \|\| aheadSeconds\(row\) >= DISPLAY_LEAD_SECONDS/);
  assert.match(background, /if \(displayMode !== 'translated'\) emitCaptionRow\(session, row\)/);
  assert.match(background, /translationVerified: true/);
  assert.match(background, /仅译文模式不会显示未验证原文/);
});

test('manual final send remains the Chrome Web Store behavior', () => {
  assert.match(manifest.description, /发送前由用户确认/);
  for (const name of ['chatgpt.js','aistudio.js','deepseek.js']) {
    const text = source(name);
    assert.match(text, /手动|手工|不会|不.*自动|用户.*发送|用户.*Run/i, `${name} must explain manual submission`);
  }
});

test('generic SPA identity ignores navigation noise but keeps media ids', () => {
  const ctx = vm.createContext({ URL });
  vm.runInContext(`${extractFunction(background, 'genericPageIdentity')}\nglobalThis.id = genericPageIdentity;`, ctx);
  assert.equal(
    ctx.id('https://video.example/watch?id=abc&utm_source=feed#comments'),
    ctx.id('https://video.example/watch?spm=share&id=abc#player')
  );
  assert.notEqual(ctx.id('https://video.example/watch?id=abc'), ctx.id('https://video.example/watch?id=def'));
});

test('file URL permission recovery lives in the popup, not dead action.onClicked code', () => {
  assert.match(popup, /isAllowedFileSchemeAccess/);
  assert.doesNotMatch(background, /chrome\.action\.onClicked\.addListener/);
});

test('successful HTTP translation clears its timeout timer', async () => {
  let nextId = 0;
  const cleared = new Set();
  const api = loadTranslate({
    setTimeout: () => ++nextId,
    clearTimeout: (id) => cleared.add(id),
    fetch: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '你好' } }] }) })
  });
  const result = await api.translateLines({ mode:'remote', baseUrl:'https://api.example/v1', apiKey:'', model:'x', targetLanguage:'zh' }, ['こんにちは']);
  assert.equal(result.ok, true);
  assert.ok(cleared.size >= 1, 'request timeout timer was not cleared after success');
});

test('cancelling a session aborts an in-flight HTTP translation request', async () => {
  let sawAbort = false;
  const api = loadTranslate({
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        sawAbort = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })
  });
  const parent = new AbortController();
  const pending = api.translateLines({ mode:'remote', baseUrl:'https://api.example/v1', apiKey:'', model:'x', targetLanguage:'zh' }, ['こんにちは'], parent.signal);
  await Promise.resolve();
  parent.abort('test-cancel');
  const result = await pending;
  assert.equal(sawAbort, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /取消/);
});

test('translation global concurrency remains capped at four', async () => {
  let active = 0;
  let maximum = 0;
  const api = loadTranslate({
    fetch: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { ok: true, json: async () => ({ choices: [{ finish_reason:'stop', message: { content:'译文' } }] }) };
    }
  });
  const cfg = { mode:'remote', baseUrl:'https://api.example/v1', apiKey:'', model:'x', targetLanguage:'zh' };
  const results = await Promise.all(Array.from({ length: 12 }, () => api.translateLines(cfg, ['x'])));
  assert.ok(results.every(x => x.ok));
  assert.equal(maximum, 4);
});


test('dock stays vertically centered and the collapsed blue strip is half-width', () => {
  assert.match(universal, /#dock\{[^}]*top:50%;[^}]*transform:translateY\(-50%\)/);
  assert.match(universal, /#dock::before\{[^}]*width:1\.25px/);
  assert.match(universal, /if \(dock\.style\.top !== '50%'\) dock\.style\.top = '50%'/);
});

test('generic media discovery keeps active-frame extensionless fallbacks even for blob/MSE players', () => {
  assert.match(background, /chrome\.webRequest\.onResponseStarted\.addListener/);
  assert.match(background, /responseHeader\(details, 'content-type'\)/);
  assert.match(background, /mpegurl\|vnd\\.apple\\.mpegurl/);
  assert.match(background, /dash\\\+xml/);
  assert.match(source('media-discovery.js'), /mediaUrl: first\?\.url \|\| ''/);
  assert.match(background, /item\.mediaUrl \|\| item\.mediaSrc \|\| Number\(item\.score\) > 0/);
  const ctx = vm.createContext({});
  vm.runInContext(`${extractFunction(background, 'genericReplayCandidates')}\nglobalThis.replay = genericReplayCandidates;`, ctx);
  const rows = ctx.replay({
    mediaUrl: '', kind: '', frameId: 0,
    mediaSrc: 'blob:https://video.example/abcd', candidates: []
  }, [
    { frameId: 0, kind: 'hls', url: 'https://cdn.example/stream?id=1', mimeType: 'application/vnd.apple.mpegurl' },
    { frameId: 0, kind: 'media', url: 'https://cdn.example/audio?id=1', mimeType: 'audio/mp4' },
    { frameId: 0, kind: 'media', url: 'https://cdn.example/video?id=2', mimeType: 'video/mp4' },
    { frameId: 2, kind: 'hls', url: 'https://other-frame.example/live', mimeType: 'application/x-mpegurl' }
  ]);
  const urls = Array.from(rows, row => row.url);
  assert.ok(urls.includes('https://cdn.example/stream?id=1'));
  assert.ok(urls.includes('https://cdn.example/audio?id=1'));
  assert.ok(urls.includes('https://cdn.example/video?id=2'));
  assert.ok(!urls.includes('https://other-frame.example/live'));
});

test('generic DASH MPD support is conservative and DRM-aware', () => {
  const engine = source('browser-engine.js');
  assert.match(engine, /async function resolveGenericDashAudioCandidates/);
  assert.match(engine, /new DOMParser\(\)\.parseFromString\(xml, 'application\/xml'\)/);
  assert.match(engine, /ContentProtection/);
  assert.match(engine, /SegmentTemplate/);
  assert.match(engine, /SegmentList/);
  assert.match(engine, /kind: 'dash-audio'/);
  assert.match(engine, /source: 'dash-mpd'/);
});

let passed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}\n${error.stack}`);
    process.exitCode = 1;
  }
}
console.log(`${passed}/${tests.length} review regression checks passed.`);
