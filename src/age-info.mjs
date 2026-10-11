import { execFile } from 'node:child_process';
import { getHerdrContext } from './herdr.mjs';

const REFRESH_MS = 30_000;
const validPid = value => Number.isSafeInteger(value) && value > 0;

export function parseElapsedTime(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(value);
  if (!match || match[1] !== undefined && match[2] === undefined) return undefined;
  const [, days, hours, minutes, seconds] = match;
  if (+minutes >= 60 || +seconds >= 60 || days !== undefined && +hours >= 24) return undefined;
  const milliseconds = ((+(days || 0) * 24 + +(hours || 0)) * 3600 + +minutes * 60 + +seconds) * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

// Project only the process identifiers. In particular, never access process
// names, command lines or argv: startup tasks can be present in those fields.
export function processIds(raw, paneId) {
  const info = raw?.result?.process_info;
  if (!info || info.pane_id !== paneId || !validPid(info.shell_pid) || !Array.isArray(info.foreground_processes)
    || !info.foreground_processes.length || info.foreground_processes.length > 256) return undefined;
  const pids = info.foreground_processes.map(process => process?.pid);
  if (pids.some(pid => !validPid(pid))) return undefined;
  return { shellPid: info.shell_pid, pids: [...new Set(pids)] };
}

function directChild(output, { shellPid, pids }) {
  if (typeof output !== 'string' || !output.trim()) return undefined;
  const requested = new Set([shellPid, ...pids]), rows = new Map();
  for (const line of output.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) return undefined;
    const pid = +match[1], parentPid = +match[2], elapsedMs = parseElapsedTime(match[3]);
    if (!validPid(pid) || !Number.isSafeInteger(parentPid) || !requested.has(pid) || rows.has(pid) || elapsedMs === undefined) return undefined;
    rows.set(pid, { pid, parentPid, elapsedMs });
  }
  // ps can omit a process that exited after process-info was read.
  const matches = pids.map(pid => rows.get(pid)).filter(row => row && row.pid !== shellPid && row.parentPid === shellPid);
  return matches.length === 1 ? matches[0] : undefined;
}

export function createAgeReader({ context, execute = execFile, now = Date.now, timeoutMs = 2000 } = {}) {
  if (!context) { try { context = getHerdrContext(); } catch { /* Optional metadata outside the host stays blank. */ } }
  const env = context && { ...context.env, LC_ALL: 'C' };
  const cache = new Map();
  const copy = value => value && { pid: value.pid, startedAt: value.startedAt };
  function invoke(binary, args, project = value => value) {
    return new Promise(resolve => {
      execute(binary, args, { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024, killSignal: 'SIGKILL', windowsHide: true }, (error, stdout) => {
        if (error) return resolve(undefined);
        try { resolve(project(stdout)); } catch { resolve(undefined); }
      });
    });
  }
  async function readAge({ paneId, terminalId } = {}) {
    if (!context || typeof paneId !== 'string' || !paneId || typeof terminalId !== 'string' || !terminalId) return undefined;
    let entry = cache.get(terminalId);
    if (entry?.pending) return copy(await entry.pending);
    if (entry && now() - entry.checkedAt < REFRESH_MS) return copy(entry.visible);
    if (!entry) { entry = {}; cache.set(terminalId, entry); }
    entry.checkedAt = now();
    entry.pending = (async () => {
      try {
        const ids = await invoke(context.binary, ['pane', 'process-info', '--pane', paneId], output => processIds(JSON.parse(output), paneId));
        const output = ids && await invoke('ps', ['-o', 'pid=,ppid=,etime=', '-p', [...new Set([ids.shellPid, ...ids.pids])].join(',')]);
        const process = ids && directChild(output, ids);
        if (!process) { entry.visible = undefined; return undefined; }
        // Revalidate at most every 30 seconds, but keep the original start
        // estimate for an unchanged terminal/PID so second rounding never drifts.
        if (entry.known?.pid !== process.pid) entry.known = { pid: process.pid, startedAt: now() - process.elapsedMs };
        entry.visible = entry.known;
        return entry.visible;
      } catch { entry.visible = undefined; return undefined; }
      finally { entry.pending = null; }
    })();
    return copy(await entry.pending);
  }
  // Removed agents must not leave an unbounded process cache behind.
  readAge.retain = terminalIds => {
    const live = new Set(terminalIds);
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  };
  return readAge;
}
