import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { processIds } from './age-info.mjs';
import { getHerdrContext } from './herdr.mjs';
import { createCodexSharedModelReader } from './codex-shared-model-info.mjs';

const REFRESH_MS = 10_000;
const READ_BYTES = 64 * 1024;
const SCAN_BYTES = 32 * 1024 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT = new RegExp(`^\\d{4}/\\d{2}/\\d{2}/rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})\\.jsonl$`);
const ROLLOUT_NAME = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})\\.jsonl$`);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const EFFORT = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const contained = (root, path) => { const child = relative(root, path); return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep)); };
const copy = value => value && { ...value };

function codexChild(output, ids) {
  if (typeof output !== 'string' || !output.trim()) return undefined;
  const requested = new Set([ids.shellPid, ...ids.pids]), rows = new Map();
  for (const line of output.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([^\u0000-\u001f\u007f]+?)\s*$/.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]), parent = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(parent) || parent < 0 || !requested.has(pid) || rows.has(pid)) return undefined;
    rows.set(pid, { pid, parent, command: match[3] });
  }
  const children = ids.pids.map(pid => rows.get(pid)).filter(row => row && row.pid !== ids.shellPid && row.parent === ids.shellPid);
  return children.length === 1 && basename(children[0].command) === 'codex'
    ? { shellPid: ids.shellPid, pid: children[0].pid } : undefined;
}

function rolloutFiles(output, pid, sessions) {
  if (typeof output !== 'string') return undefined;
  let seenPid = false, descriptor;
  const files = new Map();
  function finish() {
    const path = descriptor?.path;
    if (!path || !ROLLOUT_NAME.test(basename(path))) return true;
    if (!isAbsolute(path) || !contained(sessions, path) || !ROLLOUT.test(relative(sessions, path).split(sep).join('/'))) return false;
    if (!/^\d+$/.test(descriptor.fd) || !/^0x[0-9a-f]+$/i.test(descriptor.device || '') || !/^\d+$/.test(descriptor.inode || '')) return false;
    const dev = Number.parseInt(descriptor.device, 16), ino = Number(descriptor.inode);
    if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino) || ino < 1) return false;
    const previous = files.get(path);
    if (previous && (previous.dev !== dev || previous.ino !== ino)) return false;
    files.set(path, { path, dev, ino });
    return true;
  }
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith('p')) {
      if (seenPid || line !== `p${pid}`) return undefined;
      seenPid = true;
    } else if (line.startsWith('f') && seenPid) {
      if (!finish()) return undefined;
      descriptor = { fd: line.slice(1) };
    } else if (descriptor && ['D', 'i', 'n'].includes(line[0])) {
      const field = { D: 'device', i: 'inode', n: 'path' }[line[0]];
      if (Object.hasOwn(descriptor, field)) return undefined;
      descriptor[field] = line.slice(1);
    } else return undefined;
  }
  return seenPid && finish() ? [...files.values()] : undefined;
}

async function safeFile(providerRoot, path) {
  const rootInfo = await lstat(providerRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined;
  const root = await realpath(providerRoot);
  if (!contained(root, path)) return undefined;
  const components = relative(root, path).split(sep);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (current === path ? !info.isFile() : !info.isDirectory())) return undefined;
  }
  if (!contained(root, await realpath(path))) return undefined;
  return lstat(path);
}

async function metadata(file, size, id) {
  const head = Buffer.alloc(Math.min(READ_BYTES, size));
  const { bytesRead } = await file.read(head, 0, head.length, 0);
  const boundary = head.subarray(0, bytesRead).indexOf(10);
  if (boundary < 0) return false;
  let record;
  try { record = JSON.parse(head.subarray(0, boundary).toString('utf8')); } catch { return false; }
  const value = record?.payload;
  return record?.type === 'session_meta' && value?.id === id && value.source === 'cli' && (value.parent_thread_id === undefined || value.parent_thread_id === null)
    && (value.session_id === undefined || value.session_id === id);
}

function contextFields(line) {
  let record;
  try { record = JSON.parse(line.toString('utf8')); } catch { return undefined; }
  if (record?.type !== 'turn_context' || !record.payload || !Object.hasOwn(record.payload, 'model')) return undefined;
  const { model, effort } = record.payload;
  const fields = { ...(typeof model === 'string' && MODEL.test(model) ? { model } : {}),
    ...(typeof effort === 'string' && EFFORT.test(effort) ? { effort } : {}) };
  return { found: true, value: Object.keys(fields).length ? fields : undefined };
}

async function tailFields(file, size) {
  const lowerBound = Math.max(0, size - SCAN_BYTES);
  let end = size, suffix = [], suffixBytes = 0, oversized = false;
  // Records may cross multiple read chunks. Keep transient fragments only
  // within the scan bound, and discard every body after projecting fields.
  while (end > lowerBound) {
    const offset = Math.max(lowerBound, end - READ_BYTES), buffer = Buffer.alloc(end - offset);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (bytesRead !== buffer.length) throw new Error('Incomplete metadata read');
    let segmentEnd = buffer.length;
    for (let index = buffer.length - 1; index >= 0; index--) {
      if (buffer[index] !== 10) continue;
      const segment = buffer.subarray(index + 1, segmentEnd), length = segment.length + suffixBytes;
      if (!oversized && length <= SCAN_BYTES) {
        const found = contextFields(suffix.length ? Buffer.concat([segment, ...suffix], length) : segment);
        if (found) return found;
      }
      suffix = []; suffixBytes = 0; oversized = false; segmentEnd = index;
    }
    const prefix = buffer.subarray(0, segmentEnd);
    if (!oversized && prefix.length + suffixBytes <= SCAN_BYTES) { suffix.unshift(prefix); suffixBytes += prefix.length; }
    else { oversized = true; suffix = []; suffixBytes = 0; }
    end = offset;
  }
  return lowerBound === 0 && !oversized ? contextFields(Buffer.concat(suffix, suffixBytes)) || { found: false } : { found: false };
}

/** Bind a standalone Codex process to its one open root rollout, never to Herdr's session ID. */
export function createCodexModelReader({ context, execute = execFile, home = homedir(), now = Date.now, timeoutMs = 2000, readSharedModel } = {}) {
  if (!context) { try { context = getHerdrContext(); } catch { /* Optional metadata outside Herdr stays blank. */ } }
  const providerRoot = resolve(home, '.codex'), sessions = join(providerRoot, 'sessions');
  const env = context && { ...context.env, LC_ALL: 'C' }, cache = new Map();
  readSharedModel ||= createCodexSharedModelReader({ home, execute, env, now, timeoutMs });
  function invoke(binary, args, project = value => value) {
    return new Promise(resolveResult => {
      execute(binary, args, { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024, killSignal: 'SIGKILL', windowsHide: true }, (error, output) => {
        if (error) return resolveResult(undefined);
        try { resolveResult(project(output)); } catch { resolveResult(undefined); }
      });
    });
  }
  async function currentProcess(paneId) {
    const ids = await invoke(context.binary, ['pane', 'process-info', '--pane', paneId], output => processIds(JSON.parse(output), paneId));
    return ids && invoke('ps', ['-o', 'pid=,ppid=,comm=', '-p', [...new Set([ids.shellPid, ...ids.pids])].join(',')], output => codexChild(output, ids));
  }
  async function read(request = {}) {
    const paneId = request?.paneId, terminalId = request?.terminalId;
    if (!context || typeof paneId !== 'string' || !paneId || typeof terminalId !== 'string' || !terminalId) return undefined;
    const previous = cache.get(terminalId), checkedAt = now();
    if (previous?.paneId === paneId && (previous.pending || checkedAt - previous.checkedAt < REFRESH_MS)) return copy(previous.pending ? await previous.pending : previous.value);
    const entry = { paneId, checkedAt };
    cache.set(terminalId, entry);
    entry.pending = (async () => {
      try {
        const process = await currentProcess(paneId);
        if (!process) return undefined;
        const files = await invoke('lsof', ['-nP', '-a', '-p', String(process.pid), '-FpfDin'], output => rolloutFiles(output, process.pid, sessions));
        if (!files || files.length > 64) return undefined;
        if (!files.length) {
          const value = await readSharedModel({ pid: process.pid });
          const confirmed = await currentProcess(paneId);
          return confirmed?.shellPid === process.shellPid && confirmed.pid === process.pid ? value : undefined;
        }
        const matches = [];
        for (const owned of files) {
          const { path } = owned;
          const id = ROLLOUT.exec(relative(sessions, path).split(sep).join('/'))?.[1];
          const info = await safeFile(providerRoot, path);
          if (!info || info.dev !== owned.dev || info.ino !== owned.ino) return undefined;
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const current = await file.stat();
            if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || !await metadata(file, current.size, id)) continue;
            const unchanged = previous?.paneId === paneId && previous.shellPid === process.shellPid && previous.pid === process.pid
              && previous.path === path && previous.dev === current.dev && previous.ino === current.ino
              && previous.size === current.size && previous.mtimeMs === current.mtimeMs;
            matches.push({ path, dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs,
              tail: unchanged ? { found: false } : await tailFields(file, current.size) });
          } finally { await file.close(); }
          if (matches.length > 1) return undefined;
        }
        if (matches.length !== 1) return undefined;
        const match = matches[0], latest = await safeFile(providerRoot, match.path);
        if (!latest || latest.dev !== match.dev || latest.ino !== match.ino || latest.size < match.size
          || latest.size === match.size && latest.mtimeMs !== match.mtimeMs) return undefined;
        if (latest.size > match.size) {
          const file = await open(match.path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const current = await file.stat(), id = ROLLOUT.exec(relative(sessions, match.path).split(sep).join('/'))[1];
            if (current.dev !== match.dev || current.ino !== match.ino || !await metadata(file, current.size, id)) return undefined;
          } finally { await file.close(); }
        }
        const confirmed = await currentProcess(paneId);
        if (!confirmed || confirmed.shellPid !== process.shellPid || confirmed.pid !== process.pid) return undefined;
        const sameFile = previous?.paneId === paneId && previous.shellPid === process.shellPid && previous.pid === process.pid && previous.path === match.path && previous.dev === match.dev && previous.ino === match.ino;
        Object.assign(entry, { shellPid: process.shellPid, pid: process.pid, path: match.path, dev: match.dev, ino: match.ino, size: match.size, mtimeMs: match.mtimeMs });
        const unchanged = match.size === previous?.size && match.mtimeMs === previous?.mtimeMs;
        return match.tail.found ? match.tail.value : sameFile && (match.size > previous.size || unchanged) ? previous.value : undefined;
      } catch { return undefined; }
    })();
    entry.value = await entry.pending;
    delete entry.pending;
    return copy(entry.value);
  }
  read.retain = terminalIds => {
    const live = new Set(terminalIds);
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  };
  return read;
}
