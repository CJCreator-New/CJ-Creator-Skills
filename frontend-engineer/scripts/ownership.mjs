// Path rules for a frontend-engineer run's file list. Shared by the write guard (hooks) and the
// gate checks (scripts/gates.mjs) so that both decide ownership the same way.
//
// An entry ending in "/" names a folder and everything under it. Any other entry names one file.
// Entries are project-relative. "./" prefixes and Windows separators are normalised.

import { isAbsolute, relative, resolve, sep } from 'node:path';

export function normalizeEntry(entry) {
  return entry.replace(/\\/g, '/').replace(/^\.\//, '');
}

// The project-relative, forward-slash form of filePath, or null when it is outside the project.
export function relativePath(filePath, projectDir) {
  const rel = relative(projectDir, resolve(projectDir, filePath));
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

export function covers(entries, filePath, projectDir) {
  const target = relativePath(filePath, projectDir);
  if (target === null) return false;
  return entries.some((entry) => {
    const pattern = normalizeEntry(entry);
    return pattern.endsWith('/') ? target.startsWith(pattern) : target === pattern;
  });
}

// Two entries overlap when they name the same path, or one is a folder that contains the other.
export function overlaps(a, b) {
  const x = normalizeEntry(a);
  const y = normalizeEntry(b);
  return x === y || (x.endsWith('/') && y.startsWith(x)) || (y.endsWith('/') && x.startsWith(y));
}

export function unionEntries(lists) {
  return [...new Set(lists.flat().filter((e) => typeof e === 'string' && e.trim() !== '').map(normalizeEntry))].sort();
}
