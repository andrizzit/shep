import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
let directory, prefix, caller, fakeBinary, callLog, hostState, baseEnv, hostEnv, packed;
const pane = { pane_id: 'w9:p7', tab_id: 'w9:t3', workspace_id: 'w9', terminal_id: 'shell-terminal' };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'shep-launcher-review-'));
  prefix = join(directory, 'installed package');
  caller = join(directory, 'unrelated caller');
  fakeBinary = join(directory, 'fake herdr');
  callLog = join(directory, 'calls.jsonl');
  hostState = join(directory, 'host-state.json');
  await mkdir(prefix);
  await mkdir(caller);
  baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) {
    if (key.startsWith('HERDR_') || key.startsWith('SHEP_')) delete baseEnv[key];
  }
  baseEnv.npm_config_cache = join(directory, 'npm-cache');
  const result = await execute('npm', ['pack', '--json', '--pack-destination', directory], {
    cwd: project, env: baseEnv, timeout: 30000,
  });
  [packed] = JSON.parse(result.stdout);
  await execute('npm', ['install', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', join(directory, packed.filename)], {
    cwd: caller, env: baseEnv, timeout: 30000,
  });
  baseEnv.PATH = `${join(prefix, 'node_modules', '.bin')}${delimiter}${baseEnv.PATH}`;
  await writeFile(fakeBinary, `#!/usr/bin/env node
const fs = require('node:fs');
void (async () => {
let state = JSON.parse(fs.readFileSync(process.env.LAUNCHER_REVIEW_STATE, 'utf8'));
const readNumber = fs.readFileSync(process.env.LAUNCHER_REVIEW_LOG, 'utf8').trim().split('\\n').filter(Boolean).length + 1;
fs.appendFileSync(process.env.LAUNCHER_REVIEW_LOG, JSON.stringify({
  args: process.argv.slice(2), socket: process.env.HERDR_SOCKET_PATH,
  pane: process.env.HERDR_PANE_ID, tab: process.env.HERDR_TAB_ID,
  workspace: process.env.HERDR_WORKSPACE_ID,
}) + '\\n');
while (readNumber > 1 && state.holdSubsequentReads) {
  await new Promise(resolve => setTimeout(resolve, 10));
  state = JSON.parse(fs.readFileSync(process.env.LAUNCHER_REVIEW_STATE, 'utf8'));
}
if (state.fail) { process.stderr.write('PRIVATE_HOST_DIAGNOSTIC'); process.exit(7); }
const shell = { pane_id: 'w9:p7', tab_id: 'w9:t3', workspace_id: 'w9', terminal_id: 'shell-terminal', ...state.pane };
process.stdout.write(JSON.stringify({ result: { snapshot: {
  version: '0.9.1', protocol: 22,
  panes: state.noPanes ? [] : [shell],
  tabs: [{ tab_id: 'w9:t3', workspace_id: 'w9' }], layouts: [],
  workspaces: [{ workspace_id: 'w9', label: 'Caller workspace' }, { workspace_id: 'w4', label: 'Agent workspace' }],
  agents: [{ agent: 'codex', name: 'Fixture coder', agent_status: 'working', terminal_id: 'agent-terminal',
    pane_id: 'w4:p2', tab_id: 'w4:t1', workspace_id: 'w4', cwd: '/fixture/agent-workspace' }],
}}}));
})();
`, { mode: 0o755 });
  hostEnv = {
    ...baseEnv, HERDR_BIN_PATH: fakeBinary, HERDR_SOCKET_PATH: join(directory, 'current herdr.sock'),
    HERDR_PANE_ID: pane.pane_id, HERDR_TAB_ID: pane.tab_id, HERDR_WORKSPACE_ID: pane.workspace_id,
    SHEP_SESSION: 'other-session; $(must-not-run)',
    LAUNCHER_REVIEW_STATE: hostState, LAUNCHER_REVIEW_LOG: callLog,
  };
  await resetHost();
});

after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function resetHost(state = {}) {
  await setHostState(state);
  await writeFile(callLog, '');
}

async function setHostState(state) {
  const next = hostState + '.next';
  await writeFile(next, JSON.stringify(state));
  await rename(next, hostState);
}

async function calls() {
  return (await readFile(callLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function launch(t, command, args, env = hostEnv) {
  const child = spawn(command, args, { cwd: caller, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (part) => { stdout += part; });
  child.stderr.on('data', (part) => { stderr += part; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => {});
  });
  return { child, exited, output: () => `${stdout}${stderr}`, stdout: () => stdout };
}

async function outcome(run) {
  let timeout;
  try {
    return await Promise.race([run.exited, new Promise((_, reject) => {
      timeout = setTimeout(() => { run.child.kill('SIGKILL'); reject(new Error(`Installed command did not exit: ${run.output()}`)); }, 5000);
    })]);
  } finally { clearTimeout(timeout); }
}

async function reserve(t) {
  const server = http.createServer((_, response) => response.end('reservation'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, port: server.address().port };
}

async function freePort(t) {
  const reserved = await reserve(t);
  await new Promise((resolve) => reserved.server.close(resolve));
  return reserved.port;
}

async function waitSnapshot(port, predicate, description) {
  const deadline = Date.now() + 6500;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
      last = await response.json();
      if (predicate(last)) return last;
    } catch { /* Listener startup/shutdown is expected to be asynchronous. */ }
    await delay(40);
  }
  assert.fail(`${description}: ${JSON.stringify(last)}`);
}

test('launcher QA: actual tarball installs executable aliases and complete runtime assets', async (t) => {
  const entries = new Set(packed.files.map((file) => file.path));
  for (const entry of ['bin/shep.mjs', 'src/cli.mjs', 'src/herdr.mjs', 'public/index.html', 'public/app.js', 'public/styles.css', 'public/favicon.svg', 'herdr-plugin.toml']) {
    assert.ok(entries.has(entry), `Missing packed runtime asset: ${entry}`);
  }
  for (const command of ['shep', 'shep-run']) {
    await access(join(prefix, 'node_modules', '.bin', command), constants.X_OK);
    for (const arg of ['--help', '--version']) {
      const run = launch(t, command, [arg], baseEnv);
      assert.equal((await outcome(run)).code, 0, run.output());
      assert.ok(run.output().trim().length > 0);
    }
  }
  assert.deepEqual(await readdir(caller), []);
});

test('launcher QA: all running modes refuse outside Herdr before touching the occupied port', async (t) => {
  await resetHost();
  const { port } = await reserve(t);
  for (const command of ['shep', 'shep-run']) {
    for (const args of [[], ['--web'], ['--demo']]) {
      const run = launch(t, command, [...args, '--port', String(port)], baseEnv);
      assert.notEqual((await outcome(run)).code, 0);
      assert.match(run.output(), /Herdr/i);
      assert.doesNotMatch(run.output(), /already in use|http:\/\/localhost:|\x1b\[\?1049h/);
    }
  }
  assert.deepEqual(await calls(), []);
  assert.deepEqual(await readdir(caller), []);
});

test('launcher QA: missing context markers refuse without invoking Herdr', async (t) => {
  const { port } = await reserve(t);
  for (const key of ['HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID']) {
    await resetHost();
    const env = { ...hostEnv };
    delete env[key];
    const run = launch(t, 'shep', ['--port', String(port)], env);
    assert.notEqual((await outcome(run)).code, 0, key);
    assert.match(run.output(), /Herdr/i);
    assert.doesNotMatch(run.output(), /already in use|\x1b\[\?1049h/);
    assert.deepEqual(await calls(), [], key);
  }
});

test('launcher QA: stale or mismatched live pane context refuses before startup', async (t) => {
  const { port } = await reserve(t);
  for (const state of [{ noPanes: true }, { pane: { pane_id: 'w9:p99' } },
    { pane: { tab_id: 'w9:t99' } }, { pane: { workspace_id: 'w99' } }, { fail: true }]) {
    await resetHost(state);
    const run = launch(t, 'shep-run', ['--port', String(port)]);
    assert.notEqual((await outcome(run)).code, 0, JSON.stringify(state));
    assert.doesNotMatch(run.output(), /already in use|http:\/\/localhost:|PRIVATE_HOST_DIAGNOSTIC|\x1b\[\?1049h/);
    assert.equal((await calls()).length, 1);
  }
});

test('launcher QA: session overrides and invalid arguments never launch a host read', async (t) => {
  for (const args of [['--session', 'other'], ['--session=other'], ['--socket', '/other.sock'], ['--port', 'nope'], ['--wat']]) {
    await resetHost();
    const run = launch(t, 'shep', args);
    assert.notEqual((await outcome(run)).code, 0, args.join(' '));
    assert.deepEqual(await calls(), []);
  }
});

test('launcher QA: installed default command monitors the current shell context across polls and recovers', async (t) => {
  // Hold every read after preflight until we explicitly switch to failure.
  // Startup can issue a second poll immediately; it must not replace the
  // captured success while this test is checking the installed web assets.
  await resetHost({ holdSubsequentReads: true });
  const port = await freePort(t);
  const run = launch(t, 'shep-run', ['--port', String(port)]);
  const good = await waitSnapshot(port, (value) => value.source.state === 'connected', run.output());
  assert.equal(good.mode, 'live');
  assert.equal(good.agents[0].workspace.path, '/fixture/agent-workspace');
  assert.match(run.stdout(), /Codex|Fixture coder/);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Your agents, together/);
  for (const asset of ['/app.js', '/styles.css', '/favicon.svg']) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${asset}`)).status, 200, asset);
  }
  const pendingReadDeadline = Date.now() + 2500;
  while ((await calls()).length < 2 && Date.now() < pendingReadDeadline) await delay(10);
  assert.equal((await calls()).length, 2, 'Second startup read must be pending behind the fixture gate');
  await setHostState({ noPanes: true });
  const stale = await waitSnapshot(port, (value) => value.source.state === 'disconnected', 'Lost current pane should disconnect');
  assert.deepEqual(stale.agents, good.agents);
  assert.equal(stale.updatedAt, good.updatedAt);
  await setHostState({});
  await waitSnapshot(port, (value) => value.source.state === 'connected', 'Matching current pane should recover');
  const reads = await calls();
  assert.ok(reads.length >= 3);
  for (const read of reads) {
    assert.deepEqual(read.args, ['api', 'snapshot']);
    assert.equal(read.socket, hostEnv.HERDR_SOCKET_PATH);
    assert.equal(read.pane, pane.pane_id);
    assert.equal(read.tab, pane.tab_id);
    assert.equal(read.workspace, pane.workspace_id);
  }
  run.child.kill('SIGTERM');
  assert.deepEqual(await outcome(run), { code: 0, signal: null });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/snapshot`));
  assert.deepEqual(await readdir(caller), []);
});

test('launcher QA: installed explicit web demo validates Herdr and loads its packaged fixtures', async (t) => {
  await resetHost();
  const port = await freePort(t);
  const run = launch(t, 'shep', ['--demo', '--web', '--port', String(port)]);
  const snapshot = await waitSnapshot(port, (value) => value.source.state === 'connected', run.output());
  assert.equal(snapshot.mode, 'demo');
  assert.ok(snapshot.agents.some((agent) => agent.provider === 'claude'));
  assert.ok(snapshot.agents.some((agent) => agent.provider === 'kiro'));
  assert.match(run.stdout(), /DEMO/);
  assert.ok((await calls()).length >= 1, 'Demo must still validate the current Herdr context');
  run.child.kill('SIGTERM');
  assert.equal((await outcome(run)).code, 0);
});
