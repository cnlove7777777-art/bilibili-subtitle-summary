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

async function readCandidate(source) {
  if (/^https:\/\//i.test(source)) {
    const response = await fetch(source, { redirect: 'follow' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${source}`);
    return Buffer.from(await response.arrayBuffer());
  }
  try {
    return await readFile(source);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkedCopyFromCandidates(candidates, targetName) {
  const expected = EXPECTED[targetName];
  const mismatches = [];
  for (const source of candidates) {
    const bytes = await readCandidate(source);
    if (!bytes) continue;
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) {
      mismatches.push(`${source}: ${actual}`);
      continue;
    }
    await mkdir(vendor, { recursive: true });
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(vendor, targetName), bytes));
    console.log(`OK ${targetName} (${bytes.length} bytes) <- ${source}`);
    return;
  }
  throw new Error(
    `Unable to restore ${targetName}; no pinned candidate matched SHA-256 ${expected}` +
    (mismatches.length ? `\nCandidates with different hashes:\n${mismatches.join('\n')}` : '')
  );
}

try {
  execFileSync(npm, [
    'install', '--ignore-scripts', '--no-save', '--no-package-lock', '--prefix', temp,
    `@huggingface/transformers@${TRANSFORMERS_VERSION}`,
    `onnxruntime-web@${ORT_VERSION}`
  ], { stdio: 'inherit' });
  await mkdir(vendor, { recursive: true });
  const transformersDist = join(temp, 'node_modules', '@huggingface', 'transformers', 'dist');
  const ortDist = join(temp, 'node_modules', 'onnxruntime-web', 'dist');
  await checkedCopyFromCandidates(
    [join(transformersDist, 'transformers.min.js')],
    'transformers.min.js'
  );
  for (const name of Object.keys(EXPECTED).filter(name => name !== 'transformers.min.js')) {
    const stem = name.endsWith('.mjs') ? name.slice(0, -4) : '';
    const cdnName = name;
    await checkedCopyFromCandidates([
      join(ortDist, name),
      join(transformersDist, name),
      ...(stem ? [join(transformersDist, `${stem}.js`)] : []),
      `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/${cdnName}`,
      `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/${cdnName}`,
      ...(stem ? [
        `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/${stem}.js`,
        `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/${stem}.js`
      ] : [])
    ], name);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
