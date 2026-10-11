import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

const REFRESH_MS = 10_000;
const MAX_THREADS = 128;
const MAX_PAYLOAD = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const EFFORT = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const SOURCE = new Set(['cli', 'vscode', 'exec', 'appServer', 'unknown']);
const STATUS = new Set(['connecting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled']);
const copy = value => value && { ...value };

function listenerOrigin(output, pid) {
  if (typeof output !== 'string') return undefined;
  const lines = output.trim().split('\n');
  if (lines.length !== 3 || lines[0] !== `p${pid}` || !/^f[0-9]+$/.test(lines[1])) return undefined;
  const match = /^n127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(lines[2]);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port <= 65535 ? `http://127.0.0.1:${port}` : undefined;
}

function loadedIds(result) {
  if (!result || !Array.isArray(result.data) || result.data.length > MAX_THREADS
    || result.nextCursor !== undefined && result.nextCursor !== null) throw new Error('Incomplete thread inventory');
  const ids = result.data;
  if (ids.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid thread inventory');
  return [...ids].sort();
}

function rootThread(result, id) {
  const thread = result?.thread;
  const subagent = thread?.source && typeof thread.source === 'object' && !Array.isArray(thread.source)
    && Object.keys(thread.source).length === 1 && Object.hasOwn(thread.source, 'subAgent');
  if (!thread || thread.id !== id || !SOURCE.has(thread.source) && !subagent
    || thread.threadSource !== undefined && thread.threadSource !== null && typeof thread.threadSource !== 'string'
    || thread.parentThreadId !== undefined && thread.parentThreadId !== null && (typeof thread.parentThreadId !== 'string' || !UUID.test(thread.parentThreadId))) {
    throw new Error('Invalid thread metadata');
  }
  if (!['cli', 'vscode'].includes(thread.source) || thread.parentThreadId !== undefined && thread.parentThreadId !== null
    || thread.threadSource !== undefined && thread.threadSource !== null && thread.threadSource !== 'user') return undefined;
  const value = { ...(typeof thread.model === 'string' && MODEL.test(thread.model) ? { model: thread.model } : {}),
    ...(typeof thread.reasoningEffort === 'string' && EFFORT.test(thread.reasoningEffort) ? { effort: thread.reasoningEffort } : {}) };
  return { id, value: Object.keys(value).length ? value : undefined };
}

function endpoint(result) {
  if (!result || !Array.isArray(result.data) || result.data.length > 1
    || result.nextCursor !== undefined && result.nextCursor !== null) throw new Error('Incomplete MCP inventory');
  if (!result.data.length) return undefined;
  const server = result.data[0];
  if (!server || server.name !== 'codex_tui' || server.httpOrigin !== null && typeof server.httpOrigin !== 'string'
    || server.runtimeStatus !== null && !STATUS.has(server.runtimeStatus)) throw new Error('Invalid MCP metadata');
  return { origin: server.httpOrigin, connected: server.runtimeStatus === 'connected' };
}

function sameIds(left, right) { return left.length === right.length && left.every((id, index) => id === right[index]); }

/** Read only live root settings bound to a TUI's own task-tools listener. */
export function createCodexSharedModelReader({ home = homedir(), execute = execFile, env = process.env, now = Date.now,
  timeoutMs = 2000, createSocket = (url, options) => new WebSocket(url, options), checkSocket = path => stat(path) } = {}) {
  const socketPath = join(resolve(home), '.codex', 'app-server-control', 'app-server-control.sock');
  let inventory;

  function currentOrigin(pid) {
    return new Promise(resolveResult => {
      execute('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fpn'],
        { env: { ...env, LC_ALL: 'C' }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024, killSignal: 'SIGKILL', windowsHide: true },
        (error, output) => resolveResult(error ? undefined : listenerOrigin(output, pid)));
    });
  }

  async function connect() {
    if (!(await checkSocket(socketPath)).isSocket()) throw new Error('No existing app server');
    const socket = createSocket(`ws+unix://${socketPath}:/`, { maxPayload: MAX_PAYLOAD, handshakeTimeout: timeoutMs });
    const pending = new Map();
    let sequence = 0, closed = false, opened = false;
    let readyResolve, readyReject;
    const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
    function fail() {
      closed = true;
      readyReject(new Error('Metadata connection unavailable'));
      for (const request of pending.values()) request.reject(new Error('Metadata request unavailable'));
      pending.clear();
    }
    socket.on('open', () => { opened = true; readyResolve(); });
    socket.on('error', fail);
    socket.on('close', fail);
    socket.on('message', (data, binary) => {
      if (binary || typeof data !== 'string' && !Buffer.isBuffer(data) || Buffer.byteLength(data) > MAX_PAYLOAD) { fail(); socket.terminate(); return; }
      let reply;
      try { reply = JSON.parse(data.toString()); } catch { fail(); socket.terminate(); return; }
      if (!reply || typeof reply !== 'object' || Array.isArray(reply)) { fail(); socket.terminate(); return; }
      if (reply.id === undefined) return; // Notifications are discarded without retaining their bodies.
      const request = pending.get(reply.id);
      if (!request) { fail(); socket.terminate(); return; }
      pending.delete(reply.id);
      if (reply.error || !Object.hasOwn(reply, 'result')) request.reject(new Error('Metadata request failed'));
      else request.resolve(reply.result);
    });
    const timer = setTimeout(() => { fail(); socket.terminate(); }, timeoutMs);
    const close = () => { clearTimeout(timer); fail(); socket.terminate(); };
    async function rpc(method, params) {
      if (!opened || closed) throw new Error('Metadata connection unavailable');
      const id = ++sequence;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        try { socket.send(JSON.stringify({ id, method, params })); } catch { fail(); }
      });
    }
    try {
      await ready;
      await rpc('initialize', { clientInfo: { name: 'shep_metadata', version: '0.4.0' }, capabilities: {
        experimentalApi: true, optOutNotificationMethods: ['thread/started', 'item/agentMessage/delta', 'item/started', 'item/completed'] } });
      socket.send(JSON.stringify({ method: 'initialized' }));
      return { rpc, close };
    } catch (error) { close(); throw error; }
  }

  async function loadInventory(rpc, ids) {
    const roots = [];
    for (const id of ids) {
      const root = rootThread(await rpc('thread/read', { threadId: id, includeTurns: false }), id);
      if (!root) continue;
      const server = endpoint(await rpc('mcpServerStatus/list', { threadId: id, serverName: 'codex_tui', detail: 'toolsAndAuthOnly' }));
      roots.push({ id, ...server });
    }
    return { ids, roots };
  }

  async function currentEndpoints(rpc, roots) {
    return Promise.all(roots.map(async root => {
      const server = endpoint(await rpc('mcpServerStatus/list', { threadId: root.id, serverName: 'codex_tui', detail: 'toolsAndAuthOnly' }));
      return { id: root.id, ...server };
    }));
  }

  return async function read(request = {}) {
    const pid = request?.pid;
    if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
    let client;
    try {
      const origin = await currentOrigin(pid);
      if (!origin) return undefined;
      client = await connect();
      const ids = loadedIds(await client.rpc('thread/loaded/list', { limit: MAX_THREADS }));
      const checkedAt = now();
      let fresh = false;
      if (!inventory || checkedAt - inventory.checkedAt >= REFRESH_MS || !sameIds(ids, inventory.ids)) {
        const entry = { checkedAt, ids };
        entry.pending = loadInventory(client.rpc, ids);
        inventory = entry;
        entry.value = await entry.pending;
        delete entry.pending;
        fresh = true;
      }
      const snapshot = inventory.pending ? await inventory.pending : inventory.value;
      if (!snapshot || !sameIds(ids, snapshot.ids)) return undefined;
      // A resumed, already loaded thread can change owner without changing the
      // loaded ID set. Cached roots therefore need current endpoint verification.
      const roots = fresh ? snapshot.roots : await currentEndpoints(client.rpc, snapshot.roots);
      const matches = roots.filter(root => root.origin === origin);
      if (matches.length !== 1 || !matches[0].connected) return undefined;
      const id = matches[0].id;
      // Inventory caches only ownership. Read the selected root's live settings again.
      const root = rootThread(await client.rpc('thread/read', { threadId: id, includeTurns: false }), id);
      const latestMatches = (await currentEndpoints(client.rpc, snapshot.roots)).filter(root => root.origin === origin);
      const latestIds = loadedIds(await client.rpc('thread/loaded/list', { limit: MAX_THREADS }));
      if (!root || latestMatches.length !== 1 || latestMatches[0].id !== id || !latestMatches[0].connected
        || !sameIds(ids, latestIds) || await currentOrigin(pid) !== origin) {
        inventory = undefined;
        return undefined;
      }
      return copy(root.value);
    } catch { inventory = undefined; return undefined; }
    finally { client?.close(); }
  };
}
