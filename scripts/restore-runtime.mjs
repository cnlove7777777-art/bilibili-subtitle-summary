import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRANSFORMERS_VERSION = '3.8.1';
const ORT_VERSION = '1.22.0-dev.20250409-89f8206ba4';
const EXPECTED = {
  'transformers.min.js': 'aa5002b70e789798da263f5f99c62bd3e8fcd0c119258a493c40c180648365fa',
  'ort.bundle.min.mjs': '96e80b413dda387fbcefbd2bb0015f6708323767cc0dd5383260106582e77781',
  'ort-wasm-simd-threaded.asyncify.mjs': '5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9',
  'ort-wasm-simd-threaded.asyncify.wasm': 'e0c0c6d3e73d43b8a249972f8358f845b08cc16fec3c80efafdf8bed40366786',
  'ort-wasm-simd-threaded.jsep.mjs': '08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9',
  'ort-wasm-simd-threaded.jsep.wasm': 'c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39'
};

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const vendor = join(root, 'vendor');
const temp = await mkdtemp(join(tmpdir(), 'bscg-runtime-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function checkedCopy(source, targetName) {
  const bytes = await readFile(source);
  const actual = createHash('sha256').update(bytes).digest('hex');
  const expected = EXPECTED[targetName];
  if (actual !== expected) throw new Error(`${targetName} SHA-256 mismatch: ${actual}`);
  await copyFile(source, join(vendor, targetName));
  console.log(`OK ${targetName} (${bytes.length} bytes)`);
}

try {
  execFileSync(npm, [
    'install', '--ignore-scripts', '--no-save', '--no-package-lock', '--prefix', temp,
    `@huggingface/transformers@${TRANSFORMERS_VERSION}`,
    `onnxruntime-web@${ORT_VERSION}`
  ], { stdio: 'inherit' });
  await mkdir(vendor, { recursive: true });
  await checkedCopy(join(temp, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.min.js'), 'transformers.min.js');
  for (const name of Object.keys(EXPECTED).filter(name => name !== 'transformers.min.js')) {
    await checkedCopy(join(temp, 'node_modules', 'onnxruntime-web', 'dist', name), name);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
