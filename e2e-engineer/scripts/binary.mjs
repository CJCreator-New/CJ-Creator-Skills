// Identity of a native app binary. A commit SHA does not identify an APK, AAB, IPA or simulator .app:
// store builds, debug builds and rebuilt binaries differ. The ledger records this hash, computed here,
// and a run is current only while the binary still has it. A .app bundle is a folder; its hash covers
// every file's path and bytes, in sorted order.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const NATIVE_EXTENSIONS = ['.apk', '.aab', '.ipa', '.app'];

function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)]))
    .sort();
}

export function isNativeBinary(file) {
  const lower = String(file).toLowerCase();
  return NATIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Streams the file, so large binaries are hashed without loading them into memory. Every failure is
// a rejection, so callers can handle one kind of error.
export async function describeBinary(file) {
  if (!isNativeBinary(file)) {
    throw new Error(`${file} is not a native binary (expected ${NATIVE_EXTENSIONS.join(', ')})`);
  }
  const info = statSync(file);
  if (String(file).toLowerCase().endsWith('.app')) {
    if (!info.isDirectory()) throw new Error(`${file} is not a .app bundle folder`);
    const hash = createHash('sha256');
    let bytes = 0;
    for (const path of filesIn(file)) {
      const data = readFileSync(path);
      bytes += data.length;
      hash.update(`${relative(file, path)}\0`).update(data);
    }
    return { file, bytes, sha256: hash.digest('hex') };
  }
  if (!info.isFile()) throw new Error(`${file} is not a file`);
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve({ file, bytes: info.size, sha256: hash.digest('hex') }));
  });
}
