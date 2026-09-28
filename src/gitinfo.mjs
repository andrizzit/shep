import { execFile } from 'node:child_process';
import * as nativeFs from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { DEFAULT_CONFIG, LIMITS, SCRUBBED_GIT_ENV, SPIKE_FACTS } from './dispatch/contracts.mjs';

const typed = code => Object.assign(new Error('Git information is unavailable.'), { code });
export function createGitRunner({ env = process.env, getConfig = () => DEFAULT_CONFIG, fs = nativeFs, binary = 'git' } = {}) {
  const pinnedEnv = { ...env, LC_ALL: 'C' };
  for (const key of SCRUBBED_GIT_ENV) delete pinnedEnv[key];
  let running = 0;
  const waiting = [];
  function pump() {
    while (running < LIMITS.gitConcurrency && waiting.length) {
      const job = waiting.shift();
      if (job.signal?.aborted) { job.reject(typed('disposed')); continue; }
      running += 1;
      job.start().then(job.resolve, job.reject).finally(() => { running -= 1; pump(); });
    }
  }
  return (args, { cwd, timeoutMs = LIMITS.registryGitTimeoutMs, maxBuffer = LIMITS.gitStatusBytes, signal, trustedRoot } = {}) => new Promise((resolve, reject) => {
    const job = { signal, resolve, reject, start: async () => {
      if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0')) || !isAbsolute(cwd)) throw typed('invalid_git_request');
      const trustArgs = [];
      if (trustedRoot !== undefined) {
        if (!isAbsolute(trustedRoot) || await fs.realpath(trustedRoot) !== trustedRoot || !(getConfig()?.worktrees?.trustedRepos ?? []).includes(trustedRoot)) throw typed('untrusted_repository');
        trustArgs.push('-c', `safe.directory=${trustedRoot}`);
      }
      if (signal?.aborted) throw typed('disposed');
      return new Promise((yes, no) => execFile(binary, [...trustArgs, '-C', cwd, ...args],
        { env: pinnedEnv, timeout: timeoutMs, maxBuffer, encoding: 'utf8', killSignal: 'SIGKILL', signal }, (error, stdout, stderr) => {
          if (signal?.aborted) return no(typed('disposed'));
          if (error && !Number.isInteger(error.code)) return no(typed(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'too_large' : error.killed ? 'timeout' : 'unavailable'));
          yes({ code: error?.code ?? 0, stdout, stderr });
        }));
    } };
    const cancel = () => { const index = waiting.indexOf(job); if (index >= 0) { waiting.splice(index, 1); reject(typed('disposed')); } };
    signal?.addEventListener('abort', cancel, { once: true });
    const originalResolve = job.resolve, originalReject = job.reject;
    job.resolve = value => { signal?.removeEventListener('abort', cancel); originalResolve(value); };
    job.reject = error => { signal?.removeEventListener('abort', cancel); originalReject(error); };
    waiting.push(job); pump();
  });
}

// Raw diagnostics stay private; exact native ownership wording is not a generic retry code.
export function classifyOwnershipFailure({ source, stage, code, message, canonicalRoot }) {
  if (stage !== 'target' || typeof message !== 'string' || typeof canonicalRoot !== 'string' || !isAbsolute(canonicalRoot)) return null;
  if (source === 'herdr' ? code !== SPIKE_FACTS.untrustedRepositoryCode : source !== 'git' || code !== 128) return null;
  const qualified = `${SPIKE_FACTS.ownershipMessagePrefix}${canonicalRoot}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${canonicalRoot}`;
  if (message.replace(/[ \t\r\n]+$/u, '') !== qualified) return null;
  return { root: canonicalRoot, kind: 'untrusted_repository' };
}

export async function summarize(dir, { baseCommit, git = createGitRunner(), now = () => new Date().toISOString(), signal, trustedRoot } = {}) {
  const at = new Date(now()).toISOString();
  const unknown = { state: 'unavailable', dirty: null, changedFiles: null, insertions: null, deletions: null, commitsAhead: null, at, message: 'Git summary is unavailable.' };
  try {
    if (!isAbsolute(dir) || (baseCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseCommit))) return unknown;
    const options = { cwd: dir, timeoutMs: LIMITS.summaryGitTimeoutMs, maxBuffer: LIMITS.gitStatusBytes, signal, ...(trustedRoot ? { trustedRoot } : {}) };
    const [status, diff, ahead] = await Promise.all([
      git(['status', '--porcelain=v1', '-z'], options), git(['diff', '--shortstat', 'HEAD'], options),
      baseCommit ? git(['rev-list', '--count', `${baseCommit}..HEAD`], options) : null,
    ]);
    if (status.code || diff.code || (ahead && ahead.code)) return unknown;
    const records = status.stdout.split('\0');
    let changedFiles = 0;
    for (let i = 0; i < records.length; i += 1) {
      if (!records[i]) continue;
      if (!/^[ MTADRCU?!]{2} /.test(records[i])) return unknown;
      changedFiles += 1;
      if (/[RC]/.test(records[i].slice(0, 2))) i += 1; // porcelain -z rename has a second filename.
    }
    const insertions = Number(/(\d+) insertion/.exec(diff.stdout)?.[1] ?? 0);
    const deletions = Number(/(\d+) deletion/.exec(diff.stdout)?.[1] ?? 0);
    const commitsAhead = ahead ? (/^\d+\s*$/.test(ahead.stdout) ? Number(ahead.stdout.trim()) : NaN) : null;
    if (Number.isNaN(commitsAhead)) return unknown;
    return { state: 'available', dirty: changedFiles > 0, changedFiles, insertions, deletions, commitsAhead, at };
  } catch { return unknown; }
}
