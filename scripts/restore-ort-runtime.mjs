import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const VERSION = '1.24.0-dev.20251116-b39e144322';
const EXPECTED = {
  'ort-wasm-simd-threaded.asyncify.mjs': '4b90d459fc7b1c57b8744cfc8acda25930016f9cd8f264b33bd12f0c01b18bca',
  'ort-wasm-simd-threaded.asyncify.wasm': 'e0c0c6d3e73d43b8a249972f8358f845b08cc16fec3c80efafdf8bed40366786'
};

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)));
const vendor = join(root, 'vendor');
const temp = await mkdtemp(join(tmpdir(), 'bscg-ort-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  console.log(`Restoring onnxruntime-web@${VERSION} ...`);
  execFileSync(npm, ['install', '--ignore-scripts', '--no-save', '--no-package-lock', '--prefix', temp, `onnxruntime-web@${VERSION}`], { stdio: 'inherit' });
  await mkdir(vendor, { recursive: true });
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const source = join(temp, 'node_modules', 'onnxruntime-web', 'dist', name);
    const bytes = await readFile(source);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`${name} SHA-256 mismatch: ${actual}`);
    await copyFile(source, join(vendor, name));
    console.log(`OK ${name} (${bytes.length} bytes)`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
