// Identity of a native app binary. A commit SHA does not identify an APK, AAB or IPA: store builds,
// debug builds and rebuilt binaries differ. The ledger records this hash, computed here, and a run
// is current only while the binary still has it.

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';

export const NATIVE_EXTENSIONS = ['.apk', '.aab', '.ipa'];

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
  if (!info.isFile()) throw new Error(`${file} is not a file`);
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve({ file, bytes: info.size, sha256: hash.digest('hex') }));
  });
}
