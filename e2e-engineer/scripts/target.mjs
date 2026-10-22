#!/usr/bin/env node
// The target application's lifecycle, from the config: start it with the declared `start` command,
// check it with the declared `healthUrl`, and stop it. The skill never guesses a start command (G11).
// Also the one write the skill makes outside its state folder, and only with the user's consent: the
// line in the target's .gitignore that keeps run state and evidence out of version control (G17).
//
// node scripts/target.mjs start     <config> --root <repo>
// node scripts/target.mjs health    <config> --root <repo>
// node scripts/target.mjs stop      <config> --root <repo>
// node scripts/target.mjs gitignore <config> --root <repo> [--add]

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRun } from './safety.mjs';

export const STATE = join('.claude', 'e2e-engineer');
export const IGNORE_LINE = '.claude/e2e-engineer/';
const PID = 'target.pid';
const LOG = 'target.log';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Whether the run state is ignored by git in this repository. Without git, there is nothing to commit.
export function gitignoreStatus(root) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' });
  } catch {
    return { git: false, ignored: true, reason: 'not a git repository' };
  }
  try {
    execFileSync('git', ['check-ignore', '-q', `${IGNORE_LINE}ledger.json`], { cwd: root, stdio: 'ignore' });
    return { git: true, ignored: true, reason: null };
  } catch {
    return { git: true, ignored: false, reason: `${IGNORE_LINE} is not ignored, so run state and evidence could be committed` };
  }
}

// Adds the state folder to the repository's .gitignore. Call it only after the user agreed.
export function addGitignore(root) {
  const status = gitignoreStatus(root);
  if (status.ignored) return { changed: false, ...status };
  const file = join(root, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}# e2e-engineer run state and evidence\n${IGNORE_LINE}\n`);
  return { changed: true, ...gitignoreStatus(root) };
}

// One health check: the health URL answers 2xx within the timeout.
async function probeOnce(url, timeoutMs, fetchImpl) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    return res.ok ? null : `status ${res.status}`;
  } catch (error) {
    return error.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : error.message;
  }
}

// The stop condition: the environment fails its health check twice in a row. A pass at either attempt
// is healthy. Without a health URL, there is nothing to check, and the result says so.
export async function checkHealth(config, { fetchImpl = fetch, timeoutMs = 3000, pauseMs = 1000 } = {}) {
  if (!config.healthUrl) return { healthy: null, reason: 'no healthUrl is declared' };
  const first = await probeOnce(config.healthUrl, timeoutMs, fetchImpl);
  if (first === null) return { healthy: true, attempts: 1 };
  await sleep(pauseMs);
  const second = await probeOnce(config.healthUrl, timeoutMs, fetchImpl);
  if (second === null) return { healthy: true, attempts: 2 };
  return { healthy: false, attempts: 2, reason: `${config.healthUrl} failed its health check twice: ${second}` };
}

function refuseUnlessAllowed(config) {
  const decision = validateRun(config);
  if (!decision.allowed) throw new Error(`refused: ${decision.problems.join('; ')}`);
}

// Starts the target with the config's start command, in the repository, and waits until it is
// healthy. The process id and the log stay in the state folder. A target that does not become healthy
// within the time is stopped, and the start fails.
export async function startTarget({ config, root, env = process.env, waitSeconds = config.startTimeoutSeconds ?? 30, fetchImpl = fetch }) {
  refuseUnlessAllowed(config);
  if (typeof config.start !== 'string' || config.start.trim() === '') {
    throw new Error('no start command is declared in the config; the skill does not guess one. Start the target yourself, or declare start.');
  }
  if (!config.healthUrl) throw new Error('declare healthUrl, so the skill can tell when the target is ready');
  const state = join(root, STATE);
  mkdirSync(state, { recursive: true });
  if (existsSync(join(state, PID))) throw new Error(`a target is already recorded as started (${join(STATE, PID)}); stop it first`);
  const log = openSync(join(state, LOG), 'a');
  const child = spawn('sh', ['-c', config.start], { cwd: root, env: { ...env, ...(config.startEnv || {}) }, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  child.unref();
  writeFileSync(join(state, PID), `${child.pid}\n`);
  const deadline = Date.now() + waitSeconds * 1000;
  let last = 'not checked';
  while (Date.now() < deadline) {
    last = (await probeOnce(config.healthUrl, 2000, fetchImpl)) ?? 'healthy';
    if (last === 'healthy') return { started: true, pid: child.pid, log: join(STATE, LOG) };
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  stopTarget({ root });
  throw new Error(`the target did not become healthy within ${waitSeconds} s (${last}); see ${join(STATE, LOG)}`);
}

// Stops the target this skill started, and its child processes.
export function stopTarget({ root }) {
  const file = join(root, STATE, PID);
  if (!existsSync(file)) return { stopped: false, reason: 'no target was started by this skill' };
  const pid = Number(readFileSync(file, 'utf8').trim());
  rmSync(file, { force: true });
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return { stopped: false, pid, reason: 'the process had already exited' };
    }
  }
  return { stopped: true, pid };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, configArg, ...rest] = process.argv.slice(2);
  const rootIndex = rest.indexOf('--root');
  const root = resolve(rootIndex >= 0 ? rest[rootIndex + 1] : '.');
  const usage = 'usage: target.mjs <start|health|stop|gitignore> <config> --root <repo> [--add]';
  const run = async () => {
    if (!command || !configArg) throw new Error(usage);
    const config = JSON.parse(readFileSync(resolve(configArg), 'utf8'));
    if (command === 'start') return startTarget({ config, root });
    if (command === 'health') return checkHealth(config);
    if (command === 'stop') return stopTarget({ root });
    if (command === 'gitignore') return rest.includes('--add') ? addGitignore(root) : gitignoreStatus(root);
    throw new Error(usage);
  };
  run()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.healthy === false) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
