import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
let count = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS ${label}`); count++; }
  catch (error) { console.error(`FAIL ${label}: ${error.stack || error}`); process.exitCode = 1; }
}
function walk(dir='') {
  return readdirSync(join(root,dir), { withFileTypes:true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir,e.name)) : [join(dir,e.name).replaceAll('\\','/')]);
}
const files = walk().filter(f => !f.startsWith('.git/') && !f.startsWith('node_modules/'));
const source = new Set(files);
check('manifest and content-script versions match 0.16.51', () => {
  assert.equal(manifest.manifest_version,3);
  assert.equal(manifest.version,'0.16.51');
  assert.match(read('universal.js'), /const CS_VERSION = '0\.16\.51'/);
});
check('all source JavaScript files parse', () => {
  for (const f of files.filter(f=>f.endsWith('.js') || f.endsWith('.mjs')).filter(f=>!f.startsWith('vendor/'))) {
    execFileSync(process.execPath,['--check',join(root,f)],{stdio:'pipe'});
  }
});
check('manifest local references resolve', () => {
  const paths = [manifest.background.service_worker,manifest.action.default_popup,manifest.options_page];
  for (const icon of Object.values(manifest.icons||{})) paths.push(icon);
  for (const i of manifest.content_scripts||[]) paths.push(...i.js, ...(i.css||[]));
  for (const res of manifest.web_accessible_resources||[]) paths.push(...res.resources.filter(x=>!x.includes('*')));
  for(const p of paths) assert.ok(source.has(p),`${p} is absent`);
});
check('local runtime wrappers and attribution exist', () => {
  for(const p of ['vendor/mp4box.all.min.js','vendor/LICENSE-mp4box-bsd-3-clause.txt','vendor/LICENSE-transformers-apache-2.0.txt','vendor/LICENSE-onnxruntime-mit.txt']) assert.ok(source.has(p),p);
});
check('caption memory, YouTube and DASH paths are present', () => {
  const universal = read('universal.js');
  const background = read('background.js');
  const engine = read('browser-engine.js');
  assert.match(universal,/BSCG_VIDEO_TRANSLATION_GET/);
  assert.match(universal,/#dock\{[^}]*top:50%/);
  assert.match(background,/YouTube|youtube/i);
  assert.match(engine,/SegmentTemplate|SegmentTimeline/);
  assert.ok(source.has('dash-timeline.js'));
});
check('privacy disclosures are included', () => {
  assert.ok(source.has('privacy.html'));
  const privacy = read('privacy.html');
  assert.match(privacy,/API Key/);
  assert.match(privacy,/HTTPS/);
  assert.match(privacy,/字幕/);
});
check('old explicit adult-domain integration is absent', () => {
  for(const f of ['manifest.json','background.js','browser-engine.js','universal.js']) {
    assert.doesNotMatch(read(f),/missav\.(?:com|ai|ws|tv)/i,`adult host reference in ${f}`);
  }
});
console.log(`${count} release-source checks finished, exit=${process.exitCode||0}.`);
