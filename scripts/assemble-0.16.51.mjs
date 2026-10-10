import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const version = '0.16.51';
const expectedSha256 = 'ae2694c676729d05d0f5722817acdfcd22e9cd3992f00d661f7d5c115e51c202';
const expectedBytes = 11626394;
const count = 23;
const folder = join(root, 'release-parts', `v${version}`);
const outputDir = join(root, 'dist');
await mkdir(outputDir, { recursive: true });
const fullPath = join(outputDir, `bili-subtitle-summary-${version}-cws-review.zip`);
const chunks = [];
for (let i = 0; i < count; i++) {
  const filename = `part-${String(i).padStart(3, '0')}.bin`;
  chunks.push(await readFile(join(folder, filename)));
}
const buf = Buffer.concat(chunks);
const digest = createHash('sha256').update(buf).digest('hex');
if (digest !== expectedSha256 || buf.length !== expectedBytes) {
  throw new Error(`Archive checksum mismatch: length=${buf.length}, SHA-256=${digest}`);
}
await writeFile(fullPath, buf);
execFileSync('python3', ['-m', 'zipfile', '-t', fullPath], { stdio:'inherit' });
console.log(`VERIFIED_ARCHIVE=${fullPath}`);
console.log(`ARCHIVE_SHA256=${digest}`);
