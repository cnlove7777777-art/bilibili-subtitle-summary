// Run: node tests/ui-summary-regressions.mjs
// Uses isolated DOM/API fixtures. Does not contact Bilibili or an AI destination.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const ui = read('universal.js'), media = read('media-discovery.js'), background = read('background.js');
const frame = ui.slice(ui.indexOf('  function runIframeReporter()'));
const checks = [];
const test = (name, run) => checks.push({ name, run });
function fn(text, name) {
  const start = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, 'm').exec(text);
  assert.ok(start, name);
  const end = text.indexOf('\n' + start[1] + '}', start.index);
  assert.ok(end >= 0, name);
  return text.slice(start.index, end + start[1].length + 2);
}

function surface() {
  const classes = new Set();
  return { inert: false, attributes: {}, classList: {
    toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    contains: name => classes.has(name)
  }, setAttribute(name, value) { this.attributes[name] = value; } };
}

test('Live directories are ineligible, while Bilibili and Huya rooms remain eligible', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fn(media, 'bscgPageAllowsControls'), context);
  for (const url of ['https://live.bilibili.com/', 'https://live.bilibili.com/all',
    'https://live.bilibili.com/p/eden/area-tags?parentAreaId=1', 'https://www.huya.com/', 'https://www.huya.com/g']) {
    assert.equal(context.bscgPageAllowsControls(url), false, url);
  }
  for (const url of ['https://live.bilibili.com/12345?spm_id_from=abc', 'https://live.bilibili.com/blanc/12345',
    'https://www.huya.com/12345', 'https://www.bilibili.com/video/BVtest', 'file:///video.mp4']) {
    assert.equal(context.bscgPageAllowsControls(url), true, url);
  }
});

test('Cross-origin player frames respect the parent live-directory policy', () => {
  const context = vm.createContext({ URL, location: { href: 'https://player.example.test/' },
    document: { referrer: 'https://live.bilibili.com/all' }, window: { top: {} } });
  Object.defineProperty(context.window.top, 'location', { get() { throw new Error('cross-origin'); } });
  vm.runInContext(fn(media, 'bscgPageAllowsControls') + '\n' + fn(ui, 'pageAllowsControls'), context);
  assert.equal(context.pageAllowsControls(), false);
  context.document.referrer = 'https://live.bilibili.com/12345';
  assert.equal(context.pageAllowsControls(), true);
});

test('Directory UI stays hidden despite stale frame reports, without querying players or progress bars', () => {
  const captions = surface();
  const context = vm.createContext({ pageAllowsControls: () => false,
    host: { style: { display: 'block' } }, activeVideo: {}, captions,
    setupSeekPreviewFor: value => assert.equal(value, null),
    visibleVideo: () => { throw new Error('must not scan directory players'); }, frameHasVideo: true });
  vm.runInContext(fn(ui, 'setCaptionSurfaceVisible') + '\n' + fn(ui, 'positionCaptions'), context);
  context.positionCaptions();
  assert.equal(context.host.style.display, 'none');
  assert.equal(context.activeVideo, null);
  assert.equal(captions.inert, true);
});

test('Hidden subtitle surfaces become inert and leave the accessibility tree; showing restores them', () => {
  const context = vm.createContext({});
  vm.runInContext(fn(ui, 'setCaptionSurfaceVisible'), context);
  const captions = surface();
  context.setCaptionSurfaceVisible(captions, false);
  assert.equal(captions.inert, true);
  assert.equal(captions.classList.contains('hidden'), true);
  assert.equal(captions.attributes['aria-hidden'], 'true');
  context.setCaptionSurfaceVisible(captions, true);
  assert.equal(captions.inert, false);
  assert.equal(captions.classList.contains('hidden'), false);
  assert.equal(captions.attributes['aria-hidden'], 'false');
});

function mediaFixture() {
  const nodes = [];
  const document = { nodeType: 9,
    querySelectorAll: selector => selector === '*' ? nodes : nodes.filter(node => /VIDEO|AUDIO/.test(node.tagName)) };
  const node = (tagName, options = {}) => {
    const value = {
      tagName, nodeType: 1, isConnected: true, parentElement: null, attrs: {}, classes: [],
      paused: false, ended: false, readyState: 4, muted: false, volume: 1,
      controls: false, currentTime: 10, playbackRate: 1, duration: Infinity,
      style: { display: 'block', visibility: 'visible', opacity: '1', filter: 'none' },
      rect: { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 },
      getBoundingClientRect() { return this.rect; }, getRootNode: () => document,
      getAttribute(name) { return this.attrs[name] ?? null; },
      hasAttribute(name) { return name === 'href' ? Boolean(this.href) : name in this.attrs; },
      matches(selector) {
        return selector.split(',').some(raw => {
          const item = raw.trim();
          return item.startsWith('.') ? this.classes.includes(item.slice(1)) :
            item.startsWith('[') && this.hasAttribute(item.slice(1, -1));
        });
      }, querySelector: () => null,
      ...options
    };
    nodes.push(value);
    return value;
  };
  const context = vm.createContext({ document, URL, location: { href: 'https://www.bilibili.com/video/BVmain' },
    innerWidth: 1280, innerHeight: 720, getComputedStyle: node => node.style });
  vm.runInContext(fn(media, 'bscgFindMedia'), context);
  return { node, find: () => Array.from(context.bscgFindMedia('controls'), item => item.video) };
}

test('Preview roles and navigation cards are ignored; muted official players and audio remain usable', () => {
  const h = mediaFixture();
  const main = h.node('VIDEO', { muted: true });
  const card = h.node('DIV', { classes: ['bili-live-card'] });
  h.node('VIDEO', { parentElement: card });
  const preview = h.node('DIV', { attrs: { 'data-hover-preview': '' } });
  h.node('VIDEO', { parentElement: preview });
  const link = h.node('A', { href: 'https://live.bilibili.com/67890' });
  h.node('VIDEO', { parentElement: link });
  const audio = h.node('AUDIO', { style: { display: 'none', visibility: 'hidden', opacity: '0' } });
  assert.deepEqual(new Set(h.find()), new Set([main, audio]));
});

test('An invisible ancestor suppresses a video control without suppressing a visible player', () => {
  const h = mediaFixture();
  const parent = h.node('DIV', { style: { display: 'block', visibility: 'visible', opacity: '0' } });
  const hidden = h.node('VIDEO', { parentElement: parent });
  const main = h.node('VIDEO');
  assert.deepEqual(h.find(), [main]);
  parent.style.opacity = '1';
  assert.equal(h.find().includes(hidden), true);
});

function seekFixture(iframe = false) {
  let queries = 0, removals = 0, now = 100;
  const captions = surface();
  const video = { controls: false, getBoundingClientRect: () => ({ width: 640, height: 360, top: 0 }),
    closest: () => ({ querySelectorAll: () => { queries++; return []; } }) };
  const context = vm.createContext({ video, captionsEl: captions, captionsVisible: false,
    captionsDismissed: false, topOwnsOverlay: false, frameMode: 'capture', liveMode: 'capture', rows: [],
    seekBar: null, seekBarVideo: null, seekBarNative: false, seekScanAt: -Infinity,
    SEEK_BAR_SELECTORS: ['.progress'], performance: { now: () => now },
    document: { querySelector: () => {queries++; return null;} },
    hideSeekPreview() {}, onSeekMove() {}, onSeekMouseMove() {} });
  vm.runInContext(fn(iframe ? frame : ui, 'attachSeekBar') + '\n' +
    fn(iframe ? frame : ui, iframe ? 'setupSeekPreview' : 'setupSeekPreviewFor'), context);
  return { context, captions, queries: () => queries, advance: ms => { now += ms; },
    setup: () => iframe ? context.setupSeekPreview() : context.setupSeekPreviewFor(video),
    fakeBinding: () => { context.seekBar = { removeEventListener: () => {removals++;}, isConnected: true }; },
    removals: () => removals };
}

test('Top-level progress lookup is idle when captions are off or empty, and throttles missing bars', () => {
  const h = seekFixture();
  h.fakeBinding();
  for (let i = 0; i < 20; i++) h.setup();
  assert.equal(h.queries(), 0);
  assert.equal(h.removals(), 2);
  h.context.captionsVisible = true;
  h.setup();
  assert.equal(h.queries(), 0);
  h.context.rows = [{ content: '字幕' }];
  h.setup();
  const first = h.queries();
  assert.ok(first > 0);
  for (let i = 0; i < 20; i++) h.setup();
  assert.equal(h.queries(), first);
  h.advance(2001);
  h.setup();
  assert.ok(h.queries() > first);
  const beforeLive = h.queries();
  h.context.liveMode = 'live';
  h.setup();
  assert.equal(h.queries(), beforeLive);
});

test('Iframe progress lookup stops for hidden captions and overlays owned by the top frame', () => {
  const h = seekFixture(true);
  h.context.rows = [{ content: '字幕' }];
  h.captions.classList.toggle('hidden', true);
  h.fakeBinding();
  h.setup();
  assert.equal(h.removals(), 2);
  assert.equal(h.queries(), 0);
  h.captions.classList.toggle('hidden', false);
  h.context.topOwnsOverlay = true;
  h.setup();
  assert.equal(h.queries(), 0);
  h.context.topOwnsOverlay = false;
  h.setup();
  const first = h.queries();
  assert.ok(first > 0);
  h.setup();
  assert.equal(h.queries(), first);
});

test('Iframe removal or loss of a valid player withdraws its presence and clears progress bindings', () => {
  const presence = [], captions = surface();
  let cleared = 0;
  const start = frame.indexOf('    const scan = () => {');
  const end = frame.indexOf('\n    scan();', start);
  const context = vm.createContext({ video: { isConnected: true }, lastPresence: true, captionsEl: captions,
    findVideo: () => null, relayPresence: (_force, present) => presence.push(present),
    setupSeekPreview: () => {cleared++;} });
  vm.runInContext(fn(ui, 'setCaptionSurfaceVisible') + '\n' + frame.slice(start, end) + '\nscan();', context);
  assert.equal(context.video, null);
  assert.deepEqual(presence, [false]);
  assert.equal(cleared, 1);
  assert.equal(captions.inert, true);
});

test('A returning iframe player is bound once, and events from the previous player are ignored', () => {
  const sent = [];
  const player = () => ({ dataset: {}, listeners: [], currentTime: 10,
    addEventListener(type, run) { this.listeners.push({ type, run }); } });
  const a = player(), b = player();
  const context = vm.createContext({ video: null, boundMedia: new WeakSet(), hydrated: true,
    frameMode: 'capture', running: true, currentSessionId: 'session',
    ensureOverlay() {}, relayPresence() {}, report() {}, renderCue() {}, send: message => sent.push(message) });
  vm.runInContext(fn(frame, 'adopt'), context);
  context.adopt(a);
  context.video = null;
  context.adopt(a);
  assert.equal(a.listeners.length, 6);
  context.adopt(b);
  a.listeners.find(item => item.type === 'seeked').run();
  assert.equal(sent.length, 0);
  b.listeners.find(item => item.type === 'seeked').run();
  assert.equal(sent.length, 1);
});

function biliFixture({ remote = null, cached = null, final = {}, initial = {} } = {}) {
  const bvid = 'BVtest123';
  const state = { urlBvid: bvid, playurlCid: '101', initialCid: '101', hasSubtitleControl: false,
    href: `https://www.bilibili.com/video/${bvid}?p=1` };
  const delivery = [], launches = [], logs = [];
  let reads = 0;
  const context = vm.createContext({ URL, DESTINATIONS: { deepseek: {} }, DEFAULTS: {},
    throwIfExtractionCancelled() {}, cleanupJobCache: async () => {},
    chrome: { storage: { local: { get: async () => ({}), remove: async () => {} } } },
    progress: async (_tab, text) => logs.push(text), pushLog: (...args) => logs.push(args.join(' ')),
    getCurrentPlayerState: async () => ({ ...state, ...(reads++ % 2 ? final : initial) }),
    getVideoInfo: async (_id, _part, cid) => ({ view: { bvid, title: '测试视频' }, page: { cid: cid || '101', part: 'P1' } }),
    extractRemoteRows: async () => { if (remote instanceof Error) throw remote; return remote; },
    createResult: async result => result,
    deliverToDestination: async value => {delivery.push(value); return { ok: true, delivered: true };},
    findCachedResult: async () => cached, buildMediaKey: data => `bilibili:${data.videoId}:${data.partId}`,
    findTabTranscription: () => null, ensureTaskSlot() {}, crypto: { randomUUID: () => 'test-task' },
    activeTranscriptions: new Map(), currentDocumentId: () => 'document-1', localEngineLabel: () => 'Qwen',
    launchLocalTranscription: async args => launches.push(args)
  });
  vm.runInContext(['assertBilibiliPlayerSelection', 'acceptedTranscriptionResponse', 'startBilibiliExtraction']
    .map(name => fn(background, name)).join('\n'), context);
  const message = { bvid, url: state.href, pageNumber: 1, destination: 'deepseek' };
  return { delivery, launches, logs, start: extra => context.startBilibiliExtraction({ ...message, ...extra }, { id: 7, url: state.href }) };
}

test('Valid CC subtitles can be summarized when the player subtitle button is absent', async () => {
  const h = biliFixture({ remote: { rows: [{ from: 0, to: 2, content: '来自字幕接口' }], label: 'CC' },
    final: { href: 'https://www.bilibili.com/video/BVtest123?p=1&spm_id_from=changed' } });
  assert.equal((await h.start()).delivered, true);
  assert.equal(h.delivery[0].result.rows[0].content, '来自字幕接口');
  assert.equal(h.launches.length, 0);
});

test('No CC track follows the locked-CID retry into local transcription', async () => {
  const h = biliFixture();
  const first = await h.start();
  assert.equal(first.needsLocalConfirm, true);
  assert.equal(String(first.cid), '101');
  const second = await h.start({ allowLocalTranscription: true, expectedCid: first.cid });
  assert.equal(second.backgroundTask, true);
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].message.destination, 'deepseek');
  assert.equal(h.launches[0].page.cid, '101');
  assert.equal(h.delivery.length, 0);
});

test('Subtitle API failures can fall back, and existing complete captions can still be reused', async () => {
  const failed = biliFixture({ remote: new Error('subtitle endpoint unavailable') });
  assert.equal((await failed.start()).needsLocalConfirm, true);
  const cached = { rows: [{ content: '缓存结果' }] };
  const h = biliFixture({ cached });
  assert.equal((await h.start()).delivered, true);
  assert.equal(h.delivery[0].result, cached);
  assert.equal(h.launches.length, 0);
});

test('Real BV/CID/part changes abort both CC delivery and no-CC local fallback', async () => {
  for (const final of [{ urlBvid: 'BVother' }, { playurlCid: '202' },
    { playurlCid: '', initialCid: '', href: 'https://www.bilibili.com/video/BVtest123?p=2' }]) {
    for (const remote of [null, { rows: [{ content: '字幕' }], label: 'CC' }]) {
      const h = biliFixture({ final, remote });
      await assert.rejects(h.start(), /视频或分P发生变化/);
      assert.equal(h.delivery.length, 0);
      assert.equal(h.launches.length, 0);
    }
  }
});

test('The local retry rejects a CID changed since the summary click', async () => {
  const h = biliFixture({ initial: { playurlCid: '202', initialCid: '202' } });
  await assert.rejects(h.start({ allowLocalTranscription: true, expectedCid: '101' }), /视频或分P发生变化/);
  assert.equal(h.launches.length, 0);
});

let passed = 0;
for (const { name, run } of checks) {
  try { await run(); console.log('PASS ' + name); passed++; }
  catch (error) { console.error('FAIL ' + name + '\n' + error.stack); process.exitCode = 1; }
}
console.log(`${passed}/${checks.length} UI/summary regressions passed. Real browser hit testing and live-site integration remain unverified.`);
