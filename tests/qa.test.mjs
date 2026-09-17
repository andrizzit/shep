import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeSnapshot } from '../src/herdr.mjs';
import { createMonitor } from '../src/monitor.mjs';
import { startServer } from '../src/server.mjs';
import { boardLines, safeText } from '../src/terminal.mjs';

const observedAt = '2026-09-16T22:00:00.000Z';
const cliFile = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const agent = (overrides = {}) => ({
  terminal_id: 'term-a', pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1',
  agent: 'codex', agent_status: 'working', ...overrides,
});
const envelope = (agents = [], workspaces = []) => ({
  result: { snapshot: { version: '0.9.1', protocol: 22, agents, workspaces } },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function controlledHerdrEnv(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shep-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'herdr');
  await writeFile(binary, await readFile(new URL('./fixtures/fake-herdr.cjs', import.meta.url)), { mode: 0o700 });
  return { ...process.env, HERDR_BIN_PATH: binary, HERDR_SOCKET_PATH: '/controlled/herdr.sock',
    HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', SHEP_TEST_MODE: '' };
}

function request(server, path, headers = {}, method = 'GET') {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function childResult(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Shep child did not exit within the lifecycle test deadline'));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
}

test('QA: sessions retain distinct identities, user names, and workspace associations', () => {
  const result = normalizeSnapshot(envelope([
    agent({ name: 'Implement API', cwd: '/fallback-a', foreground_cwd: '/actual-a' }),
    agent({ terminal_id: 'term-b', pane_id: 'w1:p2', name: 'Review API' }),
    agent({ terminal_id: 'term-c', pane_id: 'w2:p1', workspace_id: 'w2', agent: 'kiro' }),
  ], [
    { workspace_id: 'w2', label: 'Second', worktree: { checkout_path: '/work/second' } },
    { workspace_id: 'w1', label: 'First', worktree: { checkout_path: '/work/first' } },
  ]), observedAt);
  assert.equal(result.agents.length, 3);
  const byId = new Map(result.agents.map((item) => [item.id, item]));
  assert.equal(byId.size, 3);
  assert.equal(byId.get('term-a').name, 'Implement API');
  assert.equal(byId.get('term-b').name, 'Review API');
  assert.equal(byId.get('term-a').workspace.name, 'First');
  assert.equal(byId.get('term-a').workspace.path, '/actual-a');
  assert.equal(byId.get('term-b').workspace.path, '/work/first');
  assert.equal(byId.get('term-c').workspace.name, 'Second');
  assert.equal(byId.get('term-c').workspace.path, '/work/second');
});

test('QA: unfamiliar providers/statuses and absent metadata do not fabricate state or leak extra fields', () => {
  const result = normalizeSnapshot(envelope([
    agent({ terminal_id: null, agent: 'future-agent', agent_status: 'thinking',
      cwd: 123, foreground_cwd: {}, name: [], tokens: { SECRET: 'sensitive-value' },
      transcript: 'sensitive-transcript' }),
  ]), observedAt);
  const item = result.agents[0];
  assert.equal(item.id, 'w1:p1');
  assert.equal(item.provider, 'future-agent');
  assert.equal(item.status, 'unknown');
  assert.equal(item.workspace.path, null);
  assert.equal(typeof item.workspace.name, 'string');
  assert.equal(typeof item.name, 'string');
  assert.equal(JSON.stringify(result).includes('sensitive-'), false);
});

test('QA: malformed snapshot collections cannot masquerade as an empty success', () => {
  for (const value of [null, {}, { result: {} }, { result: { snapshot: {} } },
    { result: { snapshot: { agents: [], workspaces: {} } } },
    { result: { snapshot: { agents: null, workspaces: [] } } },
    envelope([null]), envelope([{}])]) {
    assert.throws(() => normalizeSnapshot(value, observedAt));
  }
});

test('QA: providers named like JavaScript object properties remain visible', () => {
  const result = normalizeSnapshot(envelope([
    agent({ agent: 'constructor' }),
    agent({ terminal_id: 'term-b', pane_id: 'w1:p2', agent: '__proto__' }),
  ]), observedAt);
  assert.equal(result.agents[0].name, 'Constructor · w1:p1');
  assert.equal(result.agents[1].name, '__proto__ · w1:p2');
  const text = boardLines({ mode: 'live', source: { state: 'connected', scope: 'Test' },
    updatedAt: observedAt, agents: result.agents }, { height: 60 }).lines.join('\n');
  assert.match(text, /constructor  \(1\)/);
  assert.match(text, /__proto__  \(1\)/);
  assert.match(text, /Constructor · w1:p1/);
});

test('QA: terminal metadata cannot set titles, hyperlinks, clipboard data, or forged rows', () => {
  const malicious = '\x1b]0;FORGED TITLE\x07ok\x1b]52;c;U0VDUkVU\x07\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\\r\nnext\u009b31m\u202e';
  const result = safeText(malicious);
  assert.doesNotMatch(result, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u);
  assert.doesNotMatch(result, /FORGED TITLE|U0VDUkVU|evil\.test/);
});

test('QA: very small terminal dimensions keep unavailable-state output within the viewport', () => {
  const snapshot = { mode: 'live', source: { state: 'disconnected', scope: 'Current session',
    message: 'Herdr is unavailable' }, updatedAt: observedAt, agents: [] };
  for (const width of [1, 20, 39, 40]) {
    for (const height of [1, 8, 9, 10]) {
      const board = boardLines(snapshot, { width, height, url: 'http://localhost:4317' });
      assert.ok(board.lines.length <= height, `height ${height}, width ${width}`);
      assert.ok(board.lines.every((line) => Array.from(line).length <= width));
    }
  }
});

test('QA: failures preserve data; an empty successful snapshot clears stale agents and recovers', async () => {
  let outcome = normalizeSnapshot(envelope([agent()]), observedAt);
  const monitor = createMonitor({ read: async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  } });
  try {
    assert.equal(monitor.getSnapshot().updatedAt, null);
    await monitor.refresh();
    const good = monitor.getSnapshot();
    assert.equal(good.source.state, 'connected');
    assert.equal(good.agents.length, 1);
    outcome = new Error('CLI stderr contains sensitive-private-token');
    await monitor.refresh();
    const stale = monitor.getSnapshot();
    assert.equal(stale.source.state, 'disconnected');
    assert.deepEqual(stale.agents, good.agents);
    assert.equal(stale.updatedAt, good.updatedAt);
    assert.equal(JSON.stringify(stale).includes('sensitive-private-token'), false);
    outcome = { version: '0.9.1', agents: [] };
    await monitor.refresh();
    const empty = monitor.getSnapshot();
    assert.equal(empty.source.state, 'connected');
    assert.deepEqual(empty.agents, []);
    assert.equal(empty.source.message, null);
  } finally {
    monitor.stop();
  }
});

test('QA: overlapping refresh requests share one read and stop prevents future scheduled reads', async () => {
  const pending = deferred();
  let calls = 0;
  const monitor = createMonitor({ intervalMs: 25, read: () => {
    calls += 1;
    return pending.promise;
  } });
  let publications = 0;
  monitor.subscribe(() => { publications += 1; });
  try {
    const initial = monitor.start();
    const overlapping = monitor.refresh();
    await delay(5);
    assert.equal(calls, 1);
    monitor.stop();
    pending.resolve({ version: '0.9.1', agents: [] });
    await Promise.all([initial, overlapping]);
    await delay(80);
    assert.equal(calls, 1);
    assert.equal(publications, 0);
  } finally {
    monitor.stop();
  }
});

test('QA: loopback HTTP protects snapshot reads and exposes only approved resources', async (t) => {
  const monitor = createMonitor({ read: async () => ({ version: '0.9.1', agents: [] }) });
  const server = await startServer({ monitor, port: 0 });
  t.after(async () => {
    monitor.stop();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1');
  await monitor.refresh();
  const sameOrigin = await request(server, '/api/snapshot', { Origin: `http://127.0.0.1:${port}` });
  assert.equal(sameOrigin.status, 200);
  assert.equal(JSON.parse(sameOrigin.body).source.state, 'connected');
  assert.match(sameOrigin.headers['cache-control'], /no-store/);
  assert.equal(sameOrigin.headers['access-control-allow-origin'], undefined);
  const localhost = await request(server, '/api/snapshot', { Host: `localhost:${port}` });
  assert.equal(localhost.status, 200);
  for (const headers of [
    { Host: `attacker.example:${port}` },
    { Host: '127.0.0.1:1' },
    { Host: `127.0.0.1.evil.test:${port}` },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
  ]) {
    const result = await request(server, '/api/snapshot', headers);
    assert.equal(result.status, 403, JSON.stringify(headers));
    assert.equal(result.body.includes('"agents"'), false);
  }
  for (const path of ['/PROJECT.md', '/src/herdr.mjs', '/.git/config', '/../package.json', '/%2e%2e/package.json']) {
    assert.equal((await request(server, path)).status, 404, path);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.equal((await request(server, '/api/snapshot', {}, method)).status, 405, method);
  }
});

test('QA: CLI port conflict fails clearly without disturbing the existing listener', async (t) => {
  const monitor = createMonitor();
  const server = await startServer({ monitor, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const child = spawn(process.execPath, [cliFile, '--demo', '--web', '--port', String(port)], {
    env: await controlledHerdrEnv(t), stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', (part) => { output += part; });
  child.stderr.on('data', (part) => { output += part; });
  assert.equal((await childResult(child)).code, 1);
  assert.match(output, /already in use/);
  assert.doesNotMatch(output, /http:\/\/localhost:/);
  assert.equal((await request(server, '/api/snapshot')).status, 200);
});

test('QA: CLI in a controlled Herdr pane serves explicit demo state and releases its port on SIGTERM', async (t) => {
  const reservation = http.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [cliFile, '--demo', '--web', '--port', String(port)], {
    env: await controlledHerdrEnv(t), stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = childResult(child);
  let output = '';
  child.stdout.on('data', (part) => { output += part; });
  child.stderr.on('data', (part) => { output += part; });
  let snapshot;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      snapshot = JSON.parse((await request({ address: () => ({ port }) }, '/api/snapshot')).body);
      if (snapshot.source.state === 'connected') break;
    } catch { /* Startup is asynchronous; the loop is bounded. */ }
    await delay(20);
  }
  assert.equal(snapshot?.source.state, 'connected', output);
  assert.equal(snapshot.mode, 'demo');
  assert.ok(snapshot.agents.length > 0);
  assert.match(output, /DEMO/);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
  await assert.rejects(request({ address: () => ({ port }) }, '/api/snapshot'), { code: 'ECONNREFUSED' });
});
