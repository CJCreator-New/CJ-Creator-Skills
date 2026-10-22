// Content fingerprints for the backend-engineer ledger. A verification result is current only
// while the files it depends on still have the fingerprint they had when the check ran.
// Fingerprints need git. Without git every fingerprint is null, so no result counts as current.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;
const STATE_DIR = '.claude/';
const EXCLUDE_STATE = ':(exclude).claude';

// git's stderr is dropped: a path that matches nothing is reported by the ledger, not by git.
function git(cwd, args) {
  return execFileSync('git', args, { cwd, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
}

// The ls-files list, without the run's own state. The state folder is filtered here rather than
// with a :(exclude) pathspec, because git returns nothing for --cached combined with that pathspec.
function listed(output) {
  return output
    .toString('utf8')
    .split('\0')
    .filter((file) => file !== '' && !file.startsWith(STATE_DIR))
    .sort();
}

// The tracked or unignored files under the given paths, or null without git. An empty list means
// the paths match nothing, which a journey must not depend on.
export function pathFiles(cwd, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  try {
    return listed(git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...paths]));
  } catch {
    return null;
  }
}

// Hash of the contents of every tracked or unignored file under the given paths.
export function pathsHash(cwd, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  try {
    const files = pathFiles(cwd, paths);
    if (files === null) return null;
    const hash = createHash('sha256');
    for (const file of files) {
      hash.update(`\0${file}\0`);
      try {
        hash.update(readFileSync(join(cwd, file)));
      } catch {
        hash.update('<missing>');
      }
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

// Hash of the whole working-tree change against HEAD, plus untracked file contents.
export function treeHash(cwd) {
  try {
    const diff = git(cwd, ['diff', 'HEAD', '--binary', '--', '.', EXCLUDE_STATE]);
    const untracked = listed(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
    const hash = createHash('sha256').update(diff);
    for (const file of untracked) {
      hash.update(`\0${file}\0`);
      hash.update(readFileSync(join(cwd, file)));
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}
