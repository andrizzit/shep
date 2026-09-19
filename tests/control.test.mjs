import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/control.mjs';
import { getHerdrContext, normalizeSnapshot } from '../src/herdr.mjs';

let temporary, executables;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'shep-control-'));
  executables = join(temporary, 'binaries');
  await mkdir(executables);
  for (const name of ['codex', 'claude', 'grok', 'kiro-cli']) {
    await writeFile(join(executables, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

function contextFor(extra = {}) {
  return getHerdrContext({
    HERDR_ENV: '1', HERDR_SOCKET_PATH: join(temporary, 'pinned.sock'),
    HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1',
    PATH: executables, ...extra,
  });
}

function fixture({ beforeRun, afterRun, readRaw, context, monitorState = 'connected', mode = 'live', width = 140, height = 45 } = {}) {
  const raw = { result: { snapshot: {
    version: '0.9.1', panes: [
      { pane_id: 'w1:p1', terminal_id: 'own', tab_id: 'w1:t1', workspace_id: 'w1', cwd: temporary, focused: true },
      { pane_id: 'w2:p1', terminal_id: 'second', tab_id: 'w2:t1', workspace_id: 'w2', cwd: temporary },
      { pane_id: 'w2:p2', terminal_id: 'inactive', tab_id: 'w2:t2', workspace_id: 'w2', cwd: temporary },
    ],
    workspaces: [
      { workspace_id: 'w1', label: 'Main', active_tab_id: 'w1:t1' },
      { workspace_id: 'w2', label: 'Other', active_tab_id: 'w2:t1' },
    ], agents: [],
  } } };
  const calls = [];
  const monitor = { getSnapshot: () => ({ mode, source: { state: monitorState } }) };
  const run = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    if (beforeRun) await beforeRun(argv, raw, options);
    const snapshot = raw.result.snapshot;
    const flag = name => argv[argv.indexOf(name) + 1];
    let response;
    if (argv[0] === 'pane' && argv[1] === 'layout') {
      const pane = snapshot.panes.find(p => p.pane_id === flag('--pane'));
      response = { result: { layout: { workspace_id: pane.workspace_id, tab_id: pane.tab_id, zoomed: false, panes: [{ pane_id: pane.pane_id, rect: { width, height } }] } } };
    } else if (argv[0] === 'pane' && argv[1] === 'split') {
      const anchor = snapshot.panes.find(p => p.pane_id === flag('--pane'));
      const pane = { ...anchor, pane_id: `${anchor.workspace_id}:p9`, terminal_id: 'new-terminal', focused: false, cwd: flag('--cwd') };
      snapshot.panes.push(pane);
      response = { result: { pane: structuredClone(pane) } };
    } else if (argv[0] === 'agent' && argv[1] === 'start') {
      const pane = snapshot.panes.find(p => p.pane_id === flag('--pane'));
      const agent = { ...pane, agent: flag('--kind'), name: argv[2], agent_status: 'idle', interactive_ready: true, launch_pending: false };
      snapshot.agents.push(agent);
      response = { result: { agent: structuredClone(agent), argv: [agent.agent] } };
    } else if (argv[0] === 'agent' && argv[1] === 'get') {
      response = { result: { agent: structuredClone(snapshot.agents.find(a => a.pane_id === argv[2])) } };
    } else if (argv[0] === 'agent' && argv[1] === 'prompt') {
      response = { result: { agent: structuredClone(snapshot.agents.find(a => a.pane_id === argv[2])) } };
    } else if (argv[0] === 'agent' && argv[1] === 'focus') {
      for (const pane of snapshot.panes) pane.focused = pane.pane_id === argv[2];
      response = { result: {} };
    } else if (argv[0] === 'pane' && argv[1] === 'close') {
      snapshot.panes = snapshot.panes.filter(p => p.pane_id !== argv[2]);
      snapshot.agents = snapshot.agents.filter(a => a.pane_id !== argv[2]);
      response = { result: {} };
    } else throw new Error(`Unexpected command ${argv.slice(0,2).join(' ')}`);
    return afterRun ? await afterRun(argv, raw, response, options) ?? response : response;
  };
  const controller = createController({ context: context ?? contextFor(), monitor, mode, run, readRaw: readRaw ?? (async () => structuredClone(raw)) });
  return { controller, raw, calls, run };
}
const writes = f => f.calls.filter(c => ['split', 'start', 'prompt', 'focus', 'close'].includes(c.argv[1]));
const request = extras => ({ provider: 'codex', prompt: 'Review the code', cwd: temporary, name: 'reviewer', ...extras });
const raised = code => Object.assign(new Error('PRIVATE raw host output'), { code });

test('profiles list native executable availability and current workspace metadata without executing agents', async () => {
  const f = fixture();
  const profile = await f.controller.getProfiles();
  assert.equal(profile.ownPaneId, 'w1:p1');
  assert.equal(profile.ownTerminalId, 'own');
  assert.equal(profile.defaultWorkspaceId, 'w1');
  assert.equal(profile.defaultCwd, temporary);
  assert.deepEqual(profile.workspaces.map(w => w.id), ['w1', 'w2']);
  for (const id of ['codex', 'claude', 'grok', 'kiro']) assert.equal(profile.providers.find(p => p.id === id).available, true);
  assert.equal(profile.providers.find(p => p.id === 'cursor').available, false);
  assert.deepEqual(f.calls, []);
});

test('dispatch passes exact literal prompt and verified pane/workspace identities through native commands', async () => {
  const prompt = '--timeout=1\n`touch /tmp/never` $(whoami) "quoted" \'single\'\t羊🐑';
  const f = fixture();
  const result = await f.controller.dispatch(request({ prompt }));
  assert.equal(result.state, 'submitted', result.message);
  assert.deepEqual(writes(f).map(c => c.argv.slice(0,2).join('.')), ['pane.split', 'agent.start', 'agent.prompt']);
  assert.deepEqual(f.calls.find(c => c.argv[1] === 'split').argv, ['pane', 'split', '--pane', 'w1:p1', '--direction', 'right', '--cwd', temporary, '--no-focus']);
  assert.deepEqual(f.calls.find(c => c.argv[1] === 'prompt').argv, ['agent', 'prompt', 'w1:p9', prompt]);
  assert.equal(f.calls.find(c => c.argv[1] === 'start').options.timeoutMs, 35000);
  assert.equal(f.calls.find(c => c.argv[1] === 'prompt').options.timeoutMs, 8000);
  assert.ok(f.calls.every(c => c.options.signal instanceof AbortSignal));
});

test('dispatch into another existing workspace uses its active tab and measured vertical layout', async () => {
  const f = fixture({ width: 65, height: 40 });
  const result = await f.controller.dispatch(request({ workspaceId: 'w2' }));
  assert.equal(result.state, 'submitted');
  const split = f.calls.find(c => c.argv[1] === 'split').argv;
  assert.equal(split[split.indexOf('--pane') + 1], 'w2:p1');
  assert.equal(split[split.indexOf('--direction') + 1], 'down');
  assert.equal(result.paneId, 'w2:p9');
  assert.ok(!f.calls.some(c => c.argv[0] === 'tab' || c.argv[0] === 'workspace'));
});

test('invalid drafts and unavailable providers never split or start panes', async () => {
  const cases = [
    [{ prompt: '' }, 'invalid_prompt'], [{ prompt: '  \n\t' }, 'invalid_prompt'],
    [{ prompt: 'a\0b' }, 'invalid_prompt'], [{ prompt: '\x1b[31munsafe' }, 'invalid_prompt'],
    [{ prompt: 'x\rsubmit' }, 'invalid_prompt'], [{ prompt: '🐑'.repeat(16385) }, 'invalid_prompt'],
    [{ name: '--bad' }, 'invalid_name'], [{ name: 'a'.repeat(33) }, 'invalid_name'],
    [{ provider: 'constructor' }, 'invalid_provider'], [{ provider: 'cursor' }, 'unavailable_provider'],
    [{ cwd: '.' }, 'invalid_cwd'], [{ cwd: temporary + '/missing' }, 'invalid_cwd'],
    [{ cwd: join(executables, 'codex') }, 'invalid_cwd'], [{ workspaceId: 'missing' }, 'workspace_missing'],
  ];
  for (const [extras, code] of cases) {
    const f = fixture();
    assert.equal((await f.controller.dispatch(request(extras))).code, code);
    assert.equal(writes(f).length, 0, JSON.stringify(extras).slice(0,100));
  }
});

test('duplicate name introduced during layout read is caught before splitting', async () => {
  const f = fixture({ afterRun: (argv, raw) => {
    if (argv[1] === 'layout') raw.result.snapshot.agents.push({ name: 'reviewer' });
  } });
  assert.equal((await f.controller.dispatch(request())).code, 'duplicate_name');
  assert.equal(writes(f).length, 0);
});

test('small or zoomed layout refuses dispatch before creating a pane', async () => {
  for (const config of [{ width: 70, height: 20 }, { afterRun: (argv, raw, response) => { if (argv[1] === 'layout') response.result.layout.zoomed = true; } }]) {
    const f = fixture(config);
    assert.equal((await f.controller.dispatch(request())).code, 'no_room');
    assert.equal(writes(f).length, 0);
  }
});

test('trust, startup uncertainty and prompt uncertainty preserve pane without retries or approval keys', async () => {
  for (const [stage, code, state] of [['start', 'agent_not_ready', 'needs_input'], ['start', 'timeout', 'uncertain'], ['start', 'agent_start_transport_failed', 'uncertain'], ['prompt', 'timeout', 'uncertain'], ['prompt', 'unexpected_transport_code', 'uncertain']]) {
    const f = fixture({ beforeRun: argv => { if (argv[1] === stage) throw raised(code); } });
    const result = await f.controller.dispatch(request());
    assert.equal(result.state, state, `${stage}/${code}: ${result.message}`);
    assert.equal(result.paneId, 'w1:p9');
    assert.ok(f.raw.result.snapshot.panes.some(p => p.pane_id === result.paneId));
    assert.equal(f.calls.filter(c => c.argv[1] === stage).length, 1);
    assert.ok(!f.calls.some(c => ['close', 'send-keys', 'send-text'].includes(c.argv[1])));
    if (stage === 'start') assert.ok(!f.calls.some(c => c.argv[1] === 'prompt'));
    assert.ok(!result.message.includes('PRIVATE'));
  }
});

test('missing readiness metadata never permits prompt delivery', async () => {
  const f = fixture({ afterRun: (argv, raw) => {
    if (argv[1] === 'start') delete raw.result.snapshot.agents[0].interactive_ready;
  } });
  assert.equal((await f.controller.dispatch(request())).state, 'needs_input');
  assert.ok(!f.calls.some(c => c.argv[1] === 'prompt'));
});

test('unexpected host error codes never resolve object prototype fields or expose raw output', async () => {
  const f = fixture({ beforeRun: argv => { if (argv[1] === 'start') throw raised('constructor'); } });
  const result = await f.controller.dispatch(request());
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, 'string');
  assert.ok(!result.message.includes('PRIVATE'));
  assert.ok(!result.message.includes('native code'));
});

test('concurrent actions reject duplicate dispatch while dispose prevents delayed prompt delivery', async () => {
  let release, started;
  const reachedStart = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let signal;
  const f = fixture({ afterRun: async (argv, raw, response, options) => {
    if (argv[1] === 'start') { signal = options.signal; started(); await pending; }
  } });
  const action = f.controller.dispatch(request());
  await reachedStart;
  assert.equal((await f.controller.dispatch(request())).code, 'busy');
  f.controller.dispose();
  f.controller.dispose();
  assert.equal(signal.aborted, true);
  release();
  const result = await action;
  assert.equal(result.state, 'uncertain');
  assert.equal(result.code, 'disposed');
  assert.ok(f.raw.result.snapshot.panes.some(p => p.pane_id === 'w1:p9'));
  assert.ok(!f.calls.some(c => ['prompt', 'close'].includes(c.argv[1])));
  assert.equal((await f.controller.dispatch(request())).code, 'disposed');
  await assert.rejects(f.controller.getProfiles(), { code: 'disposed' });
});

test('fresh session identity and status are required before closing a selected agent', async () => {
  for (const field of ['terminal_id', 'agent', 'name', 'agent_session', 'agent_status']) {
    const f = fixture();
    await f.controller.dispatch(request());
    const agent = f.raw.result.snapshot.agents[0];
    agent.agent_session = { kind: 'id', value: 'session-a' };
    const target = normalizeSnapshot(f.raw).agents[0];
    if (field === 'terminal_id') agent.terminal_id = 'replacement';
    if (field === 'agent') agent.agent = 'claude';
    if (field === 'name') agent.name = 'replacement';
    if (field === 'agent_session') agent.agent_session.value = 'session-b';
    if (field === 'agent_status') agent.agent_status = 'working';
    assert.equal((await f.controller.closeAgent(target)).ok, false, field);
    assert.ok(!f.calls.some(c => c.argv[1] === 'close'));
  }
});

test('focus is direct and close confirms disappearance even when close acknowledgement times out', async () => {
  const f = fixture({ afterRun: argv => { if (argv[1] === 'close') throw raised('timeout'); } });
  await f.controller.dispatch(request());
  const target = normalizeSnapshot(f.raw).agents[0];
  assert.equal((await f.controller.focus(target)).state, 'focused');
  assert.deepEqual(f.calls.find(c => c.argv[1] === 'focus').argv, ['agent', 'focus', 'w1:p9']);
  assert.equal((await f.controller.closeAgent(target)).state, 'closed');
  assert.equal(f.calls.filter(c => c.argv[1] === 'close').length, 1);
});

test('real execFile boundary preserves prompt bytes and pinned context with no shell interpretation', async () => {
  const statePath = join(temporary, 'transport-state.json');
  const logPath = join(temporary, 'transport-log.jsonl');
  const executable = join(temporary, 'fake-herdr');
  const f = fixture();
  await writeFile(statePath, JSON.stringify(f.raw));
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ args, socket: process.env.HERDR_SOCKET_PATH, own: process.env.HERDR_PANE_ID, marker: process.env.TEST_MARKER }) + '\\n');
const raw = JSON.parse(fs.readFileSync(process.env.TEST_STATE, 'utf8'));
const snapshot = raw.result.snapshot;
let response;
if (args[0] === 'api') response = raw;
if (args[1] === 'layout') response = {result:{layout:{workspace_id:'w1',tab_id:'w1:t1',zoomed:false,panes:[{pane_id:'w1:p1',rect:{width:140,height:40}}]}}};
if (args[1] === 'split') { const pane = {...snapshot.panes[0],pane_id:'w1:p9',terminal_id:'new-terminal'}; snapshot.panes.push(pane); response={result:{pane}}; }
if (args[1] === 'start') {const agent={...snapshot.panes.at(-1),name:args[2],agent:'codex',agent_status:'idle',interactive_ready:true};snapshot.agents.push(agent);response={result:{agent}};}
if (args[1] === 'get' || args[1] === 'prompt') response={result:{agent:snapshot.agents[0]}};
fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(raw));
process.stdout.write(JSON.stringify(response));
`, { mode: 0o755 });
  // Node determines ESM from the .mjs target, so use a symlink-free .mjs executable.
  const moduleExecutable = executable + '.mjs';
  await writeFile(moduleExecutable, await readFile(executable), { mode: 0o755 });
  const context = contextFor({ HERDR_BIN_PATH: moduleExecutable, TEST_STATE: statePath, TEST_LOG: logPath, TEST_MARKER: 'pinned' });
  const controller = createController({ context, monitor: { getSnapshot: () => ({ mode: 'live', source: { state: 'connected' } }) } });
  context.env.TEST_MARKER = 'changed-after-creation';
  const prompt = '--wait\n$(touch /tmp/shep-never) `echo nope` "quote"\t羊';
  assert.equal((await controller.dispatch(request({ prompt }))).state, 'submitted');
  const commands = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(commands.find(c => c.args[1] === 'prompt').args, ['agent', 'prompt', 'w1:p9', prompt]);
  assert.ok(commands.every(c => c.socket === context.env.HERDR_SOCKET_PATH && c.own === 'w1:p1' && c.marker === 'pinned'));
  controller.dispose();
});
