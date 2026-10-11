import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createCodexSharedModelReader } from '../src/codex-shared-model-info.mjs';
import { createCodexModelReader } from '../src/codex-model-info.mjs';

const root = '00000000-0000-7000-8000-000000000001';
const other = '00000000-0000-7000-8000-000000000003';
const child = '00000000-0000-7000-8000-000000000002';
const origin = 'http://127.0.0.1:52090';
const fields = { model: 'gpt-6.1-sol', effort: 'xhigh' };
const thread = (id = root, extra = {}) => ({ id, source: 'vscode', threadSource: 'user', parentThreadId: null,
  model: fields.model, reasoningEffort: fields.effort, preview: 'PRIVATE-CONVERSATION', name: 'PRIVATE-TITLE', cwd: '/PRIVATE-PATH', ...extra });
const status = (url = origin, extra = {}) => ({ data: [{ name: 'codex_tui', httpOrigin: url, runtimeStatus: 'connected',
  tools: { 'PRIVATE-TOOL': 'PRIVATE-SCHEMA' }, ...extra }], nextCursor: null });

function fixture(options = {}) {
  const f = { clock: 0, calls: [], sockets: [], listener: 'p701\nf7\nn127.0.0.1:52090\n', ids: [root, child],
    threads: new Map([[root, thread()], [child, thread(child, { source: { subAgent: { thread_spawn: { parent_thread_id: root } } }, parentThreadId: root })]]),
    endpoints: new Map([[root, status()], [child, status()]]), counts: new Map() };
  f.response = (request, socket) => {
    const count = (f.counts.get(request.method) || 0) + 1; f.counts.set(request.method, count);
    const custom = f.override?.(request, count, socket);
    if (custom !== undefined) return custom;
    if (request.method === 'initialize') return { userAgent: 'PRIVATE-USER-AGENT' };
    if (request.method === 'thread/loaded/list') return { data: [...f.ids], nextCursor: null };
    if (request.method === 'thread/read') return { thread: f.threads.get(request.params.threadId) };
    if (request.method === 'mcpServerStatus/list') return f.endpoints.get(request.params.threadId) || { data: [], nextCursor: null };
    throw new Error('Unexpected metadata request');
  };
  f.execute = (binary, args, configuration, done) => {
    f.calls.push({ binary, args, configuration });
    queueMicrotask(() => f.executeError ? done(new Error('PRIVATE-ERROR'), 'PRIVATE-OUTPUT') : done(null, f.listener));
  };
  f.createSocket = (url, configuration) => {
    const socket = new EventEmitter(); socket.url = url; socket.configuration = configuration; socket.requests = []; socket.terminated = false;
    socket.send = raw => {
      const request = JSON.parse(raw); socket.requests.push(request);
      if (!Object.hasOwn(request, 'id')) return;
      Promise.resolve().then(() => f.response(request, socket)).then(result => {
        if (!socket.terminated) socket.emit('message', Buffer.from(JSON.stringify({ id: request.id, result })), false);
      }, () => { if (!socket.terminated) socket.emit('message', Buffer.from(JSON.stringify({ id: request.id, error: { message: 'PRIVATE-ERROR' } })), false); });
    };
    socket.terminate = () => { if (!socket.terminated) { socket.terminated = true; socket.emit('close'); } };
    f.sockets.push(socket);
    queueMicrotask(() => f.connectError ? socket.emit('error', new Error('PRIVATE-ERROR')) : socket.emit('open'));
    return socket;
  };
  f.read = createCodexSharedModelReader({ home: '/fixture-home', execute: f.execute, env: { PRIVATE_ENV: 'fixture' }, now: () => f.clock,
    checkSocket: async () => ({ isSocket: () => true }), createSocket: f.createSocket, ...options });
  f.advance = () => { f.clock += 10_000; };
  return f;
}

test('shared Codex reader binds a PID-owned listener to one live root and projects model/effort', async () => {
  const f = fixture();
  assert.deepEqual(await f.read({ pid: 701, threadId: other, cwd: '/untrusted' }), fields);
  assert.equal(f.sockets.length, 1); assert(f.sockets[0].terminated);
  assert.equal(f.sockets[0].url, 'ws+unix:///fixture-home/.codex/app-server-control/app-server-control.sock:/');
  assert.equal(f.sockets[0].configuration.maxPayload, 2 * 1024 * 1024);
  assert.deepEqual(f.calls.map(call => call.args), Array(2).fill(['-nP', '-a', '-p', '701', '-iTCP', '-sTCP:LISTEN', '-Fpn']));
  assert(f.calls.every(call => call.binary === 'lsof' && call.configuration.env.LC_ALL === 'C' && call.configuration.timeout === 2000));
  const methods = f.sockets[0].requests.map(request => request.method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'mcpServerStatus/list', 'thread/read', 'thread/read', 'mcpServerStatus/list', 'thread/loaded/list']);
  for (const request of f.sockets[0].requests) {
    if (request.method === 'thread/read') assert.equal(request.params.includeTurns, false);
    if (request.method === 'mcpServerStatus/list') assert.deepEqual(request.params, { threadId: root, serverName: 'codex_tui', detail: 'toolsAndAuthOnly' });
  }
  assert.doesNotMatch(JSON.stringify(await f.read({ pid: 701 })), /PRIVATE|thread|pid|origin|path|source/);
});

test('shared Codex reader supports CLI roots and excludes subagents and non-user roots', async () => {
  const f = fixture();
  f.threads.set(root, thread(root, { source: 'cli', threadSource: undefined, parentThreadId: undefined }));
  assert.deepEqual(await f.read({ pid: 701 }), fields);
  for (const extra of [{ source: 'exec' }, { threadSource: 'agent' }, { parentThreadId: other }]) {
    f.advance(); f.threads.set(root, thread(root, extra)); assert.equal(await f.read({ pid: 701 }), undefined);
  }
});

test('listener PID, descriptor, IPv4 loopback, uniqueness and valid port must be exact', async () => {
  const f = fixture();
  for (const listener of ['', 'p999\nf7\nn127.0.0.1:52090\n', 'p701\nf7\nn*:52090\n', 'p701\nf7\nn[::1]:52090\n',
    'p701\nf7\nn127.0.0.1:0\n', 'p701\nf7\nn127.0.0.1:65536\n', 'p701\nf7\nn127.0.0.1:05209\n',
    'p701\nf7\nn127.0.0.1:52090\nf8\nn127.0.0.1:52090\n', 'p701\nf7\nn127.0.0.1:52090\np702\n', 'p701\nn127.0.0.1:52090\n']) {
    f.listener = listener; assert.equal(await f.read({ pid: 701 }), undefined);
  }
  f.executeError = true; assert.equal(await f.read({ pid: 701 }), undefined); assert.equal(f.sockets.length, 0);
});

test('shared metadata stays blank for no match, disconnected match or multiple matching roots', async () => {
  const f = fixture();
  for (const endpoint of [status('http://127.0.0.1:9999'), status(origin, { runtimeStatus: 'failed' }), status(origin, { runtimeStatus: null })]) {
    f.advance(); f.endpoints.set(root, endpoint); assert.equal(await f.read({ pid: 701 }), undefined);
  }
  f.advance(); f.endpoints.set(root, status()); f.ids.push(other); f.threads.set(other, thread(other)); f.endpoints.set(other, status());
  assert.equal(await f.read({ pid: 701 }), undefined);
  f.endpoints.set(other, status(origin, { runtimeStatus: 'connecting' })); f.advance(); assert.equal(await f.read({ pid: 701 }), undefined);
});

test('partial, duplicate, malformed or failed thread inventory cannot establish uniqueness', async () => {
  for (const result of [{ data: [root], nextCursor: other }, { data: [root, root], nextCursor: null }, { data: ['bad-id'] },
    { data: Array(129).fill(root) }, {}, { data: [root], nextCursor: '' }]) {
    const f = fixture(); f.override = request => request.method === 'thread/loaded/list' ? result : undefined;
    assert.equal(await f.read({ pid: 701 }), undefined);
  }
  for (const bad of [undefined, {}, thread(other), thread(child, { source: 'cli', parentThreadId: 22 }), thread(child, { source: 'cli', threadSource: 22 })]) {
    const f = fixture(); f.threads.set(child, bad); assert.equal(await f.read({ pid: 701 }), undefined);
  }
  const f = fixture(); f.override = request => { if (request.method === 'thread/read' && request.params.threadId === child) throw new Error('unavailable'); };
  assert.equal(await f.read({ pid: 701 }), undefined);
});

test('MCP inventory must be complete and exact even for another eligible root', async () => {
  for (const bad of [{}, { data: [status().data[0]], nextCursor: 'more' }, { data: [status().data[0], status().data[0]] },
    status(origin, { name: 'other' }), status(origin, { httpOrigin: 22 }), status(origin, { runtimeStatus: 'unexpected' })]) {
    const f = fixture(); f.ids.push(other); f.threads.set(other, thread(other)); f.endpoints.set(other, bad);
    assert.equal(await f.read({ pid: 701 }), undefined);
  }
});

test('cached roots recheck endpoints and read current settings rather than cached model values', async () => {
  const f = fixture(); f.ids.push(other); f.threads.set(other, thread(other)); f.endpoints.set(other, { data: [], nextCursor: null });
  assert.deepEqual(await f.read({ pid: 701 }), fields);
  const initialReads = f.counts.get('thread/read');
  f.threads.set(root, thread(root, { model: 'gpt-6-astra', reasoningEffort: 'high' }));
  assert.deepEqual(await f.read({ pid: 701 }), { model: 'gpt-6-astra', effort: 'high' });
  assert.equal(f.counts.get('thread/read'), initialReads + 1);
  f.endpoints.set(other, status()); assert.equal(await f.read({ pid: 701 }), undefined);
  f.advance(); assert.equal(await f.read({ pid: 701 }), undefined);
});

test('shared inventory deduplicates concurrent readers and refreshes after ten seconds', async () => {
  const f = fixture();
  assert.deepEqual(await Promise.all([f.read({ pid: 701 }), f.read({ pid: 701 })]), [fields, fields]);
  assert.equal(f.counts.get('thread/read'), 4); // One two-thread inventory, then one selected root read per caller.
  f.advance(); assert.deepEqual(await f.read({ pid: 701 }), fields); assert.equal(f.counts.get('thread/read'), 7);
  assert(f.sockets.every(socket => socket.terminated));
});

test('late listener, endpoint and loaded-thread changes reject metadata', async () => {
  for (const change of ['listener', 'endpoint', 'loaded', 'root']) {
    const f = fixture();
    f.override = (request, count) => {
      if (request.method === 'thread/read' && count === 3) {
        if (change === 'listener') f.listener = 'p701\nf7\nn127.0.0.1:52091\n';
        if (change === 'endpoint') f.endpoints.set(root, status('http://127.0.0.1:52091'));
        if (change === 'loaded') f.ids.push(other);
        if (change === 'root') f.threads.set(root, thread(root, { parentThreadId: other }));
      }
    };
    assert.equal(await f.read({ pid: 701 }), undefined);
  }
});

test('a second loaded root acquiring the listener during the selected read makes fresh metadata ambiguous', async () => {
  const f = fixture(); f.ids.push(other); f.threads.set(other, thread(other)); f.endpoints.set(other, status('http://127.0.0.1:9999'));
  f.override = (request, count) => {
    if (request.method === 'thread/read' && count === 4) f.endpoints.set(other, status());
  };
  assert.equal(await f.read({ pid: 701 }), undefined);
});

test('unsafe current fields clear metadata and never project other response properties', async () => {
  const f = fixture();
  for (const extra of [{ model: 'PRIVATE\nPROMPT', reasoningEffort: 'BAD\nEFFORT' }, { model: null, reasoningEffort: null },
    { model: 'x'.repeat(129), reasoningEffort: '1bad' }]) {
    f.threads.set(root, thread(root, extra)); assert.equal(await f.read({ pid: 701 }), undefined);
  }
  f.threads.set(root, thread(root, { reasoningEffort: null })); assert.deepEqual(await f.read({ pid: 701 }), { model: fields.model });
});

test('missing existing socket, transport errors, malformed replies and total RPC timeout stay blank', async () => {
  const missing = fixture({ checkSocket: async () => ({ isSocket: () => false }) }); assert.equal(await missing.read({ pid: 701 }), undefined); assert.equal(missing.sockets.length, 0);
  const denied = fixture({ checkSocket: async () => { throw new Error('PRIVATE-ERROR'); } }); assert.equal(await denied.read({ pid: 701 }), undefined);
  const failed = fixture(); failed.connectError = true; assert.equal(await failed.read({ pid: 701 }), undefined);
  for (const data of ['bad-json', JSON.stringify({ id: 999, result: {} }), JSON.stringify([]), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    const f = fixture(); f.override = (request, count, socket) => {
      if (request.method === 'thread/loaded/list') { socket.emit('message', Buffer.from(data), false); return new Promise(() => {}); }
    };
    assert.equal(await f.read({ pid: 701 }), undefined); assert(f.sockets[0].terminated);
  }
  const stalled = fixture({ timeoutMs: 30 }); stalled.override = request => request.method === 'thread/loaded/list' ? new Promise(() => {}) : undefined;
  const started = Date.now(); assert.equal(await stalled.read({ pid: 701 }), undefined); assert(Date.now() - started < 500); assert(stalled.sockets[0].terminated);
});

test('invalid PID requests execute nothing', async () => {
  const f = fixture();
  for (const request of [null, undefined, {}, { pid: '701' }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }]) assert.equal(await f.read(request), undefined);
  assert.equal(f.calls.length, 0); assert.equal(f.sockets.length, 0);
});

test('default transport reads an existing Unix WebSocket without sending any mutation', async t => {
  const home = await mkdtemp('/private/tmp/shep-shared-codex-');
  const folder = join(home, '.codex', 'app-server-control'); await mkdir(folder, { recursive: true });
  const server = createServer(), websocketServer = new WebSocketServer({ server });
  const requests = [], f = fixture();
  websocketServer.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw); requests.push(request);
    if (Object.hasOwn(request, 'id')) socket.send(JSON.stringify({ id: request.id, result: f.response(request, socket) }));
  }));
  await new Promise(resolve => server.listen(join(folder, 'app-server-control.sock'), resolve));
  t.after(async () => { for (const socket of websocketServer.clients) socket.terminate(); await new Promise(resolve => websocketServer.close(resolve)); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const read = createCodexSharedModelReader({ home, execute: f.execute });
  assert.deepEqual(await read({ pid: 701 }), fields);
  assert(requests.every(request => ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'mcpServerStatus/list'].includes(request.method)));
});

test('pane reader only tries shared metadata after a valid empty standalone inventory and rejects process replacement', async () => {
  let sharedCalls = 0, psCalls = 0, inventory = 'p701\n', replace = false;
  const execute = (binary, args, options, done) => {
    if (binary === 'herdr') done(null, JSON.stringify({ result: { process_info: { pane_id: 'w9:p1', shell_pid: 700, foreground_processes: [{ pid: 701 }] } } }));
    else if (binary === 'ps') { psCalls++; done(null, `700 1 /bin/zsh\n701 ${replace && psCalls > 1 ? 1 : 700} /bin/codex\n`); }
    else done(null, inventory);
  };
  const make = () => createCodexModelReader({ context: { binary: 'herdr', env: {} }, execute,
    readSharedModel: async request => { sharedCalls++; assert.deepEqual(request, { pid: 701 }); return fields; } });
  const target = { paneId: 'w9:p1', terminalId: 'terminal-1' };
  assert.deepEqual(await make()(target), fields); assert.equal(sharedCalls, 1);
  for (const output of ['', 'p999\n', 'p701\nf7\niBAD\niDUPLICATE\nn/no-rollout\n',
    `p701\nf7\nD0x1\ni22\nn/outside/rollout-2026-10-06T22-05-49-${root}.jsonl\n`]) {
    inventory = output; assert.equal(await make()(target), undefined); assert.equal(sharedCalls, 1);
  }
  inventory = 'p701\n'; psCalls = 0; replace = true; assert.equal(await make()(target), undefined); assert.equal(sharedCalls, 2);
});
