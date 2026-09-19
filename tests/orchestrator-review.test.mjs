import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../src/control.mjs';
import { getHerdrContext, normalizeSnapshot } from '../src/herdr.mjs';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
let temporary, executables;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'shep-orchestrator-review-'));
  executables = join(temporary, 'controlled binaries');
  await mkdir(executables);
  for (const name of ['codex', 'claude', 'kiro-cli', 'grok']) {
    await writeFile(join(executables, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

let installed;
async function installedCommand() {
  if (installed) return installed;
  const prefix = join(temporary, 'installed app');
  const env = { ...process.env, npm_config_cache: join(temporary, 'npm-cache') };
  const packed = await execute('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: project, env, timeout: 60000 });
  const [artifact] = JSON.parse(packed.stdout);
  await execute('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, artifact.filename)], {
    cwd: temporary, env, timeout: 60000,
  });
  installed = join(prefix, 'node_modules', '.bin', 'shep');
  return installed;
}

async function atomicJson(path, value) {
  await writeFile(path + '.next', JSON.stringify(value));
  await rename(path + '.next', path);
}

// Serialized into a separate controlled executable; this never invokes Herdr.
async function fakeHerdrMain() {
  const fs = require('node:fs');
  const stateFile = process.env.ORCHESTRATOR_QA_STATE;
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const save = state => { fs.writeFileSync(stateFile + '.writer', JSON.stringify(state)); fs.renameSync(stateFile + '.writer', stateFile); };
  const args = process.argv.slice(2);
  const send = result => process.stdout.write(JSON.stringify({ result }));
  fs.appendFileSync(process.env.ORCHESTRATOR_QA_LOG, JSON.stringify({ args, socket: process.env.HERDR_SOCKET_PATH }) + '\n');
  let state = read();
  const snapshot = state.snapshot;
  if (args[0] === 'api' && args[1] === 'snapshot') return send({ snapshot });
  if (args[0] === 'pane' && args[1] === 'layout') {
    const pane = snapshot.panes.find(item => item.pane_id === args[args.indexOf('--pane') + 1]);
    return send({ layout: { workspace_id: pane.workspace_id, tab_id: pane.tab_id, zoomed: false,
      panes: [{ ...pane, rect: { x: 0, y: 0, width: 150, height: 50 } }] } });
  }
  if (args[0] === 'pane' && args[1] === 'split') {
    const anchor = snapshot.panes.find(item => item.pane_id === args[args.indexOf('--pane') + 1]);
    const number = state.nextPane++;
    const pane = { pane_id: anchor.workspace_id + ':p' + number, terminal_id: 'created-' + number,
      workspace_id: anchor.workspace_id, tab_id: anchor.tab_id, cwd: args[args.indexOf('--cwd') + 1] };
    snapshot.panes.push(pane); save(state); return send({ pane });
  }
  if (args[0] === 'agent' && args[1] === 'start') {
    const pane = snapshot.panes.find(item => item.pane_id === args[args.indexOf('--pane') + 1]);
    const agent = { ...pane, agent: args[args.indexOf('--kind') + 1], name: args[2],
      agent_status: 'idle', interactive_ready: true, launch_pending: false };
    snapshot.agents.push(agent); save(state);
    while (state.holdStart) { await new Promise(resolve => setTimeout(resolve, 10)); state = read(); }
    return send({ agent });
  }
  if (args[0] === 'agent' && args[1] === 'get') return send({ agent: snapshot.agents.find(item => item.pane_id === args[2]) });
  if (args[0] === 'agent' && args[1] === 'prompt') {
    const agent = snapshot.agents.find(item => item.pane_id === args[2]);
    agent.agent_status = 'working'; save(state); return send({ agent });
  }
  if (args[0] === 'agent' && args[1] === 'focus') {
    snapshot.focused_pane_id = args[2];
    snapshot.panes.forEach(pane => { pane.focused = pane.pane_id === args[2]; });
    save(state); return send({ agent: snapshot.agents.find(item => item.pane_id === args[2]) });
  }
  if (args[0] === 'pane' && args[1] === 'close') {
    snapshot.panes = snapshot.panes.filter(item => item.pane_id !== args[2]);
    snapshot.agents = snapshot.agents.filter(item => item.pane_id !== args[2]);
    save(state); return send({ pane_id: args[2] });
  }
  process.stderr.write(JSON.stringify({ error: { code: 'unsupported_fixture_command' } }));
  process.exitCode = 1;
}

async function transportFixture() {
  const directory = await mkdtemp(join(temporary, 'pty-host-'));
  const statePath = join(directory, 'state.json');
  const logPath = join(directory, 'calls.jsonl');
  const binary = join(directory, 'controlled-herdr');
  const raw = controllerFixture().raw;
  raw.result.snapshot.panes[0].cwd = directory;
  raw.result.snapshot.workspaces.forEach(workspace => {
    workspace.active_tab_id = workspace.workspace_id === 'w1' ? 'w1:t1' : 'w2:t1';
    workspace.worktree.checkout_path = directory;
  });
  raw.result.snapshot.agents = [
    plainAgent({ agent: 'claude', name: 'alpha-fixture', agent_status: 'blocked', terminal_id: 'alpha-terminal' }),
    plainAgent({ agent: 'codex', name: 'beta-fixture', agent_status: 'done', pane_id: 'w2:p3', terminal_id: 'beta-terminal' }),
  ];
  raw.result.snapshot.panes[1].terminal_id = 'alpha-terminal';
  raw.result.snapshot.panes.push({ ...otherPane, pane_id: 'w2:p3', terminal_id: 'beta-terminal' });
  await atomicJson(statePath, { snapshot: raw.result.snapshot, nextPane: 9, holdStart: false });
  await writeFile(logPath, '');
  await writeFile(binary, '#!/usr/bin/env node\n(' + fakeHerdrMain.toString() + ')();\n', { mode: 0o755 });
  const env = controllerFixture().context.env;
  Object.assign(env, { HERDR_BIN_PATH: binary, ORCHESTRATOR_QA_STATE: statePath, ORCHESTRATOR_QA_LOG: logPath,
    TERM: 'xterm-256color', FORCE_COLOR: '1', CI: '' });
  delete env.NO_COLOR;
  return {
    directory, env, statePath,
    calls: async () => (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    readState: async () => JSON.parse(await readFile(statePath, 'utf8')),
    setState: value => atomicJson(statePath, value),
  };
}

const PTY_RUNNER = String.raw`
import os,sys,pty,termios,fcntl,struct,subprocess,select,json,signal,codecs
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',int(sys.argv[1]),int(sys.argv[2]),0,0))
original=termios.tcgetattr(slave)
app=subprocess.Popen(sys.argv[3:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
pending=b''
decoder=codecs.getincrementaldecoder('utf-8')('replace')
def emit(value):
 print(json.dumps(value),flush=True)
try:
 while True:
  ready,_,_=select.select([master,sys.stdin],[],[],0.04)
  if master in ready:
   try: data=os.read(master,65536)
   except OSError: data=b''
   if data: emit({'event':'data','text':decoder.decode(data)})
  if sys.stdin in ready:
   data=os.read(sys.stdin.fileno(),65536)
   if not data: break
   pending+=data
   while b'\n' in pending:
    line,pending=pending.split(b'\n',1)
    command=json.loads(line)
    if command['type']=='input': os.write(master,command['value'].encode())
    elif command['type']=='resize':
     fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',command['rows'],command['columns'],0,0))
     os.kill(app.pid,signal.SIGWINCH)
    elif command['type']=='stop': app.terminate()
  if app.poll() is not None and master not in ready: break
 if app.poll() is None: app.terminate()
 try: app.wait(timeout=3)
 except subprocess.TimeoutExpired: app.kill();app.wait()
 emit({'event':'exit','code':app.returncode,'rawRestored':termios.tcgetattr(slave)==original})
finally:
 if app.poll() is None:
  os.killpg(app.pid,signal.SIGKILL);app.wait()
 os.close(master);os.close(slave)
`;

async function waitFor(check, description, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  assert.fail(description);
}

async function startInstalledPty(t, fixture, { columns = 140, rows = 45 } = {}) {
  const reservation = http.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const command = await installedCommand();
  const child = spawn('python3', ['-u', '-c', PTY_RUNNER, String(rows), String(columns), command, '--port', String(port)], {
    cwd: fixture.directory, env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending = '', transcript = '', errorOutput = '', exit;
  child.stdout.on('data', chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const event = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (event.event === 'data') transcript += event.text;
      if (event.event === 'exit') exit = event;
    }
  });
  child.stderr.on('data', chunk => { errorOutput += chunk; });
  const finished = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await Promise.race([finished, delay(4000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const pty = {
    port, output: () => transcript, errors: () => errorOutput, exited: () => exit,
    send: value => child.stdin.write(JSON.stringify({ type: 'input', value }) + '\n'),
    screen: () => terminalScreen(transcript, columns, rows),
    resize: (nextColumns, nextRows) => {
      columns = nextColumns; rows = nextRows; transcript = '';
      child.stdin.write(JSON.stringify({ type: 'resize', columns, rows }) + '\n');
    },
  };
  await waitFor(() => pty.screen().includes('YOUR AGENTS'), 'Installed Ink app did not render: ' + errorOutput);
  return pty;
}

function terminalScreen(transcript, width = 140, height = 45) {
  const grid = Array.from({ length: height }, () => Array(width).fill(' '));
  let x = 0, y = 0;
  const clear = () => grid.forEach(row => row.fill(' '));
  for (const token of transcript.matchAll(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[^\x1b]/gu)) {
    const value = token[0];
    if (value.startsWith('\x1b[')) {
      const command = value.at(-1);
      const parameter = value.slice(2, -1);
      const numbers = parameter.split(';').map(Number);
      const amount = numbers[0] || 1;
      if (parameter.startsWith('?')) { if (parameter === '?1049' && command === 'h') { clear(); x = y = 0; } continue; }
      if (command === 'H' || command === 'f') { y = Math.max(0, Math.min(height - 1, (numbers[0] || 1) - 1)); x = Math.max(0, Math.min(width - 1, (numbers[1] || 1) - 1)); }
      else if (command === 'A') y = Math.max(0, y - amount);
      else if (command === 'B') y = Math.min(height - 1, y + amount);
      else if (command === 'C') x = Math.min(width - 1, x + amount);
      else if (command === 'D') x = Math.max(0, x - amount);
      else if (command === 'G') x = Math.min(width - 1, amount - 1);
      else if (command === 'J' && [2, 3].includes(numbers[0])) clear();
      else if (command === 'K') grid[y].fill(' ', numbers[0] === 2 ? 0 : x, numbers[0] === 1 ? x + 1 : width);
      continue;
    }
    if (value.startsWith('\x1b')) continue;
    if (value === '\r') { x = 0; continue; }
    if (value === '\n') { y += 1; if (y >= height) { grid.shift(); grid.push(Array(width).fill(' ')); y = height - 1; } continue; }
    if (value === '\b') { x = Math.max(0, x - 1); continue; }
    if (value.codePointAt(0) < 32 || value.codePointAt(0) === 127) continue;
    if (x >= width) { x = 0; y = Math.min(height - 1, y + 1); }
    grid[y][x++] = value;
  }
  return grid.map(row => row.join('')).join('\n');
}

async function clickText(pty, text) {
  const screen = await waitFor(() => {
    const rows = pty.screen().split('\n');
    const y = rows.findIndex(row => row.includes(text));
    return y < 0 ? null : { x: rows[y].indexOf(text), y };
  }, 'Missing clickable terminal label: ' + text);
  const position = (screen.x + 2) + ';' + (screen.y + 1);
  pty.send('\x1b[<0;' + position + 'M');
  pty.send('\x1b[<0;' + position + 'm');
}

const ownPane = { pane_id: 'w1:p1', terminal_id: 'shep-terminal', tab_id: 'w1:t1', workspace_id: 'w1' };
const otherPane = { pane_id: 'w2:p2', terminal_id: 'agent-terminal', tab_id: 'w2:t1', workspace_id: 'w2' };
const plainAgent = (overrides = {}) => ({
  ...otherPane, agent: 'codex', name: 'Fixture agent', agent_status: 'done',
  interactive_ready: true, launch_pending: false, cwd: temporary, ...overrides,
});

function controllerFixture({ mode = 'live', state = 'connected', invoke } = {}) {
  const raw = { result: { snapshot: {
    version: '0.9.1', protocol: 22, panes: [{ ...ownPane }, { ...otherPane }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1' }, { tab_id: 'w2:t1', workspace_id: 'w2' }],
    workspaces: [
      { workspace_id: 'w1', label: 'Launch workspace', worktree: { checkout_path: temporary } },
      { workspace_id: 'w2', label: 'Other workspace', worktree: { checkout_path: temporary } },
    ],
    agents: [plainAgent()], layouts: [], focused_pane_id: ownPane.pane_id,
  } } };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_') && !key.startsWith('SHEP_')));
  Object.assign(env, {
    HERDR_ENV: '1',
    HERDR_BIN_PATH: process.execPath, HERDR_SOCKET_PATH: join(temporary, 'current.sock'),
    HERDR_PANE_ID: ownPane.pane_id, HERDR_TAB_ID: ownPane.tab_id, HERDR_WORKSPACE_ID: ownPane.workspace_id,
    PATH: executables + delimiter + (env.PATH || ''),
  });
  const context = getHerdrContext(env);
  const calls = [];
  let snapshot = {
    schemaVersion: 1, mode, source: { state, name: 'Herdr', scope: 'Current test session' },
    agents: normalizeSnapshot(raw).agents, updatedAt: new Date().toISOString(), polledAt: new Date().toISOString(),
  };
  const monitor = {
    getSnapshot: () => structuredClone(snapshot),
    refresh: async () => {
      snapshot = { ...snapshot, agents: normalizeSnapshot(raw).agents, updatedAt: new Date().toISOString() };
      return structuredClone(snapshot);
    },
  };
  const run = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    if (invoke) {
      const intercepted = await invoke(argv, raw, options);
      if (intercepted !== undefined) return intercepted;
    }
    if (argv[0] === 'pane' && argv[1] === 'layout') {
      const target = raw.result.snapshot.panes.find((pane) => pane.pane_id === argv.at(-1));
      return { result: { layout: {
        workspace_id: target.workspace_id, tab_id: target.tab_id, zoomed: false,
        panes: [{ ...target, rect: { x: 0, y: 0, width: 150, height: 50 } }],
      } } };
    }
    if (argv[0] === 'pane' && argv[1] === 'split') {
      const pane = { pane_id: 'w1:p9', terminal_id: 'new-terminal', tab_id: 'w1:t1', workspace_id: 'w1' };
      raw.result.snapshot.panes.push(pane);
      return { result: { pane } };
    }
    if (argv[0] === 'agent' && argv[1] === 'start') {
      const pane = raw.result.snapshot.panes.find((item) => item.pane_id === argv[argv.indexOf('--pane') + 1]);
      const agent = plainAgent({ ...pane, name: argv[2], agent: argv[argv.indexOf('--kind') + 1], agent_status: 'idle' });
      raw.result.snapshot.agents.push(agent);
      return { result: { agent } };
    }
    if (argv[0] === 'agent' && argv[1] === 'get') {
      const agent = raw.result.snapshot.agents.find((item) => item.pane_id === argv.at(-1) || item.name === argv.at(-1));
      return { result: { agent } };
    }
    if (argv[1] === 'focus') {
      raw.result.snapshot.focused_pane_id = argv.at(-1);
      return { result: {} };
    }
    if (argv[0] === 'pane' && argv[1] === 'close') {
      raw.result.snapshot.agents = raw.result.snapshot.agents.filter((item) => item.pane_id !== argv.at(-1));
      raw.result.snapshot.panes = raw.result.snapshot.panes.filter((item) => item.pane_id !== argv.at(-1));
      return { result: {} };
    }
    if (argv[0] === 'agent' && argv[1] === 'prompt') {
      const agent = raw.result.snapshot.agents.find((item) => item.pane_id === argv[2]);
      return { result: { agent } };
    }
    throw new Error('Unexpected controlled command: ' + argv.slice(0, 2).join(' '));
  };
  const controller = createController({ context, monitor, mode, run, readRaw: async () => structuredClone(raw) });
  return { controller, raw, calls, monitor, context,
    setState: (value) => { snapshot.source.state = value; },
    selected: () => structuredClone(snapshot.agents[0]),
  };
}

function writes(fixture) {
  return fixture.calls.filter(({ argv }) => ['close', 'focus', 'split', 'start', 'prompt'].includes(argv[1]));
}

test('orchestrator QA: stale/demo views cannot mutate and own pane cannot be closed', async () => {
  for (const settings of [{ mode: 'demo' }, { state: 'disconnected' }, { state: 'connecting' }]) {
    const fixture = controllerFixture(settings);
    assert.equal((await fixture.controller.focus(fixture.selected())).ok, false);
    assert.equal((await fixture.controller.closeAgent(fixture.selected())).ok, false);
    assert.equal((await fixture.controller.dispatch({ provider: 'codex', prompt: 'A fixture task', cwd: temporary })).ok, false);
    assert.deepEqual(writes(fixture), []);
  }
  const fixture = controllerFixture();
  fixture.raw.result.snapshot.agents.push(plainAgent({ ...ownPane }));
  const own = normalizeSnapshot(fixture.raw).agents.find((agent) => agent.paneId === ownPane.pane_id);
  assert.equal((await fixture.controller.closeAgent(own)).ok, false);
  assert.deepEqual(writes(fixture), []);
});

test('orchestrator QA: changed invoking context and reused target identity refuse destructive action', async () => {
  for (const change of ['own-context', 'terminal-replaced', 'target-gone', 'work-resumed']) {
    const fixture = controllerFixture();
    const captured = fixture.selected();
    if (change === 'own-context') fixture.raw.result.snapshot.panes[0].tab_id = 'w1:other-tab';
    if (change === 'terminal-replaced') {
      fixture.raw.result.snapshot.panes[1].terminal_id = 'replacement-terminal';
      fixture.raw.result.snapshot.agents[0].terminal_id = 'replacement-terminal';
    }
    if (change === 'target-gone') fixture.raw.result.snapshot.agents = [];
    if (change === 'work-resumed') fixture.raw.result.snapshot.agents[0].agent_status = 'working';
    const result = await fixture.controller.closeAgent(captured);
    assert.equal(result.ok, false, change);
    assert.deepEqual(writes(fixture), [], change);
  }
});

test('orchestrator QA: focus and close use the captured pane among same-name agents', async () => {
  const fixture = controllerFixture();
  fixture.raw.result.snapshot.agents.push(plainAgent({
    pane_id: 'w2:p3', terminal_id: 'same-name-other-terminal',
  }));
  fixture.raw.result.snapshot.panes.push({ ...otherPane, pane_id: 'w2:p3', terminal_id: 'same-name-other-terminal' });
  const captured = fixture.selected();
  const focused = await fixture.controller.focus(captured);
  assert.equal(focused.ok, true, focused.message);
  assert.equal(focused.state, 'focused');
  const closed = await fixture.controller.closeAgent(captured);
  assert.equal(closed.ok, true, closed.message);
  assert.equal(closed.state, 'closed');
  assert.ok(fixture.raw.result.snapshot.agents.some((agent) => agent.terminal_id === 'same-name-other-terminal'));
  assert.deepEqual(writes(fixture).map(({ argv }) => [argv[1], argv.at(-1)]), [
    ['focus', otherPane.pane_id], ['close', otherPane.pane_id],
  ]);
});

test('orchestrator QA: prompt punctuation and multiline content remain one literal argument', async () => {
  const fixture = controllerFixture();
  const tick = String.fromCharCode(96);
  const prompt = '--permission-mode bypassPermissions\nQuotes: "hello", ' + tick + 'literal' + tick + ', $(no-command); café\nDo not execute this fixture.';
  const result = await fixture.controller.dispatch({ provider: 'codex', name: 'literal-fixture', prompt, cwd: temporary });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.state, 'submitted');
  const sent = fixture.calls.filter(({ argv }) => argv[0] === 'agent' && argv[1] === 'prompt');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].argv, ['agent', 'prompt', 'w1:p9', prompt]);
  assert.equal(writes(fixture).filter(({ argv }) => argv[1] === 'split').length, 1);
  assert.equal(writes(fixture).filter(({ argv }) => argv[1] === 'start').length, 1);
  assert.equal(writes(fixture).filter(({ argv }) => argv[1] === 'close').length, 0);
});

test('orchestrator QA: invalid drafts do not create or start an agent', async () => {
  for (const draft of [
    { prompt: '   ' }, { prompt: 'literal\u0000nul' }, { prompt: 'x'.repeat(1_000_000) },
    { provider: 'not-a-registered-provider' }, { cwd: join(temporary, 'missing-folder') },
  ]) {
    const fixture = controllerFixture();
    const result = await fixture.controller.dispatch({ provider: 'codex', prompt: 'Fixture task', cwd: temporary, ...draft });
    assert.equal(result.ok, false);
    assert.deepEqual(writes(fixture), []);
  }
});

test('orchestrator QA: authentication or trust block never receives a prompt or synthetic approval', async () => {
  const fixture = controllerFixture({ invoke: (argv, raw) => {
    if (argv[0] === 'agent' && argv[1] === 'get' && argv.at(-1) === 'w1:p9') {
      const agent = raw.result.snapshot.agents.find((item) => item.pane_id === 'w1:p9');
      agent.interactive_ready = false;
      agent.agent_status = 'blocked';
      return { result: { agent } };
    }
  } });
  const result = await fixture.controller.dispatch({ provider: 'codex', prompt: 'Wait for user trust.', cwd: temporary });
  assert.equal(result.state, 'needs_input', result.message);
  assert.equal(result.paneId, 'w1:p9');
  assert.equal(fixture.calls.some(({ argv }) => ['prompt', 'send_keys', 'send_text', 'close'].includes(argv[1])), false);
  assert.ok(fixture.raw.result.snapshot.panes.some((pane) => pane.pane_id === 'w1:p9'));
});

test('orchestrator QA: ambiguous prompt timeout is not retried or rolled back by closing its pane', async () => {
  const fixture = controllerFixture({ invoke: (argv) => {
    if (argv[0] === 'agent' && argv[1] === 'prompt') {
      const error = new Error('PRIVATE_TRANSPORT_DETAILS');
      error.code = 'timeout';
      throw error;
    }
  } });
  const result = await fixture.controller.dispatch({ provider: 'codex', prompt: 'One submission only.', cwd: temporary });
  assert.equal(result.state, 'uncertain', result.message);
  assert.equal(result.paneId, 'w1:p9');
  assert.equal(fixture.calls.filter(({ argv }) => argv[1] === 'prompt').length, 1);
  assert.equal(fixture.calls.some(({ argv }) => argv[1] === 'close'), false);
  assert.doesNotMatch(result.message, /PRIVATE_TRANSPORT_DETAILS/);
});

test('orchestrator QA: concurrent launch is rejected and disposal aborts pending startup without later writes', async () => {
  let entered;
  const starting = new Promise(resolve => { entered = resolve; });
  let signal;
  const fixture = controllerFixture({ invoke: (argv, _raw, options) => {
    if (argv[0] !== 'agent' || argv[1] !== 'start') return undefined;
    signal = options.signal;
    entered();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('Controlled local request aborted');
        error.code = 'disposed';
        reject(error);
      }, { once: true });
    });
  } });
  const pending = fixture.controller.dispatch({ provider: 'codex', prompt: 'Only one launch.', cwd: temporary });
  await starting;
  const duplicate = await fixture.controller.dispatch({ provider: 'codex', prompt: 'Only one launch.', cwd: temporary });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'busy');
  fixture.controller.dispose();
  assert.equal((await pending).ok, false);
  assert.equal(signal.aborted, true);
  assert.equal(writes(fixture).filter(({ argv }) => argv[1] === 'split').length, 1);
  assert.equal(writes(fixture).filter(({ argv }) => argv[1] === 'start').length, 1);
  assert.equal(writes(fixture).filter(({ argv }) => ['prompt', 'close'].includes(argv[1])).length, 0);
  assert.ok(fixture.raw.result.snapshot.panes.some(pane => pane.pane_id === 'w1:p9'));
  const count = fixture.calls.length;
  assert.equal((await fixture.controller.focus(fixture.selected())).ok, false);
  assert.equal(fixture.calls.length, count);
});

test('orchestrator QA: installed Ink accepts keyboard/mouse focus, confirmed close, and literal colon dispatch commands', { timeout: 90000 }, async t => {
  const fixture = await transportFixture();
  const pty = await startInstalledPty(t, fixture);
  assert.match(pty.output(), /\x1b\[\?1000h/);
  assert.match(pty.output(), /\x1b\[\?1006h/);
  pty.send('\x1b[B');
  await delay(80);
  pty.send('\r');
  await waitFor(async () => (await fixture.calls()).some(({ args }) => args[0] === 'agent' && args[1] === 'focus' && args[2] === 'w2:p3'), 'Arrow/Enter did not focus the second agent');
  await waitFor(() => pty.screen().includes('Focused the selected'), 'Focus was not acknowledged in Ink');
  await clickText(pty, 'alpha-fixture');
  await delay(80);
  await clickText(pty, 'Enter Focus');
  await waitFor(async () => (await fixture.calls()).some(({ args }) => args[0] === 'agent' && args[1] === 'focus' && args[2] === 'w2:p2'), 'Mouse selection/focus did not target the first agent');
  await delay(80);
  pty.send('x');
  await waitFor(() => pty.screen().includes('CLOSE THIS AGENT?'), 'Close confirmation did not open');
  pty.send('n');
  await waitFor(() => !pty.screen().includes('CLOSE THIS AGENT?'), 'Close cancel did not restore the board');
  assert.equal((await fixture.calls()).filter(({ args }) => args[1] === 'close').length, 0);
  pty.send('x');
  await waitFor(() => pty.screen().includes('CLOSE THIS AGENT?'), 'Second close confirmation did not open');
  pty.send('y');
  await waitFor(async () => (await fixture.calls()).some(({ args }) => args[0] === 'pane' && args[1] === 'close' && args[2] === 'w2:p2'), 'Confirmed close targeted the wrong pane');
  await waitFor(() => pty.screen().includes('selected agent pane is closed'), 'Close result did not reach Ink');

  for (const invalid of ['/dispatch codex:', '/dispatch nonexistent: do a fixture task']) {
    const prior = (await fixture.calls()).filter(({ args }) => args[1] === 'start').length;
    pty.send('\x1b[200~' + invalid + '\x1b[201~');
    await delay(60);
    pty.send('\r');
    await waitFor(() => pty.screen().includes(invalid.includes('nonexistent') ? 'Unknown agent' : 'Add a task'), 'Invalid dispatch was not explained');
    assert.equal((await fixture.calls()).filter(({ args }) => args[1] === 'start').length, prior);
    pty.send('\x1b');
    await delay(100);
  }
  const literal = '--flag $(no-shell); "quoted"\nUnicode café and a literal second line';
  const cases = [
    ['/dispatch claude: fix the ledger', 'claude', 'fix the ledger'],
    ['/dispatch fix the settings pange', 'codex', 'fix the settings pange'],
    ['/dispatch grok: write the docker compose file', 'grok', 'write the docker compose file'],
    ['/dispatch claude explain this fixture', 'codex', 'claude explain this fixture'],
    ['/dispatch add voice input to shep', 'codex', 'add voice input to shep'],
    ['/dispatch claude: ' + literal, 'claude', literal],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [command, provider, prompt] = cases[index];
    if (index === 0) { const state = await fixture.readState(); state.holdStart = true; await fixture.setState(state); }
    pty.send('\x1b[200~' + command + '\x1b[201~');
    await delay(60);
    assert.equal((await fixture.calls()).filter(({ args }) => args[1] === 'prompt').length, index, 'Pasting must not dispatch');
    pty.send('\r');
    if (index === 0) {
      await waitFor(async () => (await fixture.readState()).snapshot.agents.some(agent => agent.terminal_id === 'created-9'), 'Created agent was not recorded before pending start');
      pty.send('\r');
      await delay(60);
      assert.equal((await fixture.calls()).filter(({ args }) => args[1] === 'start').length, 1, 'Duplicate Enter launched twice');
      const state = await fixture.readState(); state.holdStart = false; await fixture.setState(state);
    }
    await waitFor(async () => (await fixture.calls()).filter(({ args }) => args[1] === 'prompt').length === index + 1, 'Slash command did not dispatch exactly once: ' + command);
    await waitFor(() => pty.screen().includes('Prompt submitted'), 'Dispatch result did not reach Ink');
    await delay(70);
    const calls = await fixture.calls();
    const starts = calls.filter(({ args }) => args[1] === 'start');
    const prompts = calls.filter(({ args }) => args[1] === 'prompt');
    assert.equal(starts[index].args[starts[index].args.indexOf('--kind') + 1], provider);
    assert.equal(prompts[index].args[3], prompt);
  }
  const response = await fetch('http://127.0.0.1:' + pty.port + '/api/snapshot');
  assert.equal(response.status, 200);
  pty.send('q');
  const exit = await waitFor(() => pty.exited(), 'Ink did not quit cleanly');
  assert.equal(exit.code, 0, pty.errors());
  assert.equal(exit.rawRestored, true);
  for (const sequence of ['\x1b[?1000l', '\x1b[?1006l', '\x1b[?1049l']) assert.ok(pty.output().includes(sequence), 'Missing terminal cleanup sequence');
  await assert.rejects(fetch('http://127.0.0.1:' + pty.port + '/api/snapshot'));
  assert.ok((await fixture.readState()).snapshot.panes.some(pane => pane.terminal_id === 'created-9'), 'Quitting must preserve created agents');
});

test('orchestrator QA: quitting installed Ink during pending startup exits promptly and never sends the prompt', { timeout: 30000 }, async t => {
  const fixture = await transportFixture();
  const state = await fixture.readState(); state.holdStart = true; await fixture.setState(state);
  const pty = await startInstalledPty(t, fixture);
  pty.send('\x1b[200~/dispatch keep this fixture pending\x1b[201~');
  await delay(70);
  pty.send('\r');
  await waitFor(async () => (await fixture.readState()).snapshot.agents.some(agent => agent.terminal_id === 'created-9'), 'Pending startup was not entered');
  const started = Date.now();
  pty.send('\x03');
  const exit = await waitFor(() => pty.exited(), 'Quit hung on the pending Herdr startup', 4500);
  assert.ok(Date.now() - started < 4500);
  assert.equal(exit.code, 0, pty.errors());
  assert.equal(exit.rawRestored, true);
  const commands = await fixture.calls();
  assert.equal(commands.some(({ args }) => ['prompt', 'close'].includes(args[1])), false);
  assert.ok((await fixture.readState()).snapshot.panes.some(pane => pane.terminal_id === 'created-9'));
  for (const sequence of ['\x1b[?1000l', '\x1b[?1006l', '\x1b[?1049l']) assert.ok(pty.output().includes(sequence));
});

test('orchestrator QA: installed NO_COLOR layout fits exact terminal width and compact confirmation survives resize', { timeout: 30000 }, async t => {
  const fixture = await transportFixture();
  fixture.env.NO_COLOR = '1';
  delete fixture.env.FORCE_COLOR;
  const pty = await startInstalledPty(t, fixture, { columns: 123, rows: 35 });
  await waitFor(() => pty.screen().includes('SELECTED AGENT'), 'Desktop detail panel did not render');
  const desktop = pty.screen().split('\n');
  const desktopTop = desktop.find(row => row.includes('╭'));
  assert.equal(desktopTop?.slice(-2), '╮ ', 'Desktop right border must fit with one reserved physical column');
  const desktopBottom = desktop.find(row => row.includes('╰'));
  assert.equal(desktopBottom?.slice(-2), '╯ ', 'Desktop bottom border must fit within 123 columns');
  assert.doesNotMatch(pty.output(), /\x1b\[[0-9;]*(?:38|48);[0-9;]*m/, 'NO_COLOR must avoid explicit foreground/background color');
  pty.resize(40, 16);
  await waitFor(() => pty.screen().includes('Focus ↵'), 'Compact action bar did not render after resize');
  const compact = pty.screen().split('\n');
  assert.equal(compact.find(row => row.includes('╭'))?.slice(-2), '╮ ');
  assert.equal(compact.find(row => row.includes('╰'))?.slice(-2), '╯ ');
  pty.send('x');
  await waitFor(() => pty.screen().includes('CLOSE THIS AGENT?'), 'Compact confirmation did not open');
  assert.ok(pty.screen().includes('alpha-terminal'), 'Compact confirmation must retain exact target terminal identity');
  assert.ok(pty.screen().includes('Cancel') && pty.screen().includes('Close agent'), 'Both compact dialog actions must be visible');
  pty.send('\x1b');
  await waitFor(() => !pty.screen().includes('CLOSE THIS AGENT?'), 'Compact dialog did not cancel');
  pty.send('q');
  const exit = await waitFor(() => pty.exited(), 'NO_COLOR app did not exit');
  assert.equal(exit.code, 0, pty.errors());
  assert.equal(exit.rawRestored, true);
  assert.equal((await fixture.calls()).some(({ args }) => ['close', 'focus', 'split', 'start', 'prompt'].includes(args[1])), false);
});
