import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/control.mjs';
import { getHerdrContext } from '../src/herdr.mjs';

async function fixture(t, { delivery, beforeRun, afterRun } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'shep-launch6-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await fs.mkdir(bin);
  for (const executable of ['claude', 'codex', 'grok', 'kiro-cli']) await fs.writeFile(join(bin, executable), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const snapshot = { panes: [{ pane_id: 'w1:p1', terminal_id: 'own', tab_id: 'w1:t1', workspace_id: 'w1', cwd: root }],
    workspaces: [{ workspace_id: 'w1', active_tab_id: 'w1:t1' }], agents: [] };
  const context = getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: join(root, 'fixture.sock'),
    HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', PATH: bin });
  const calls = [], events = [], monitor = { getSnapshot: () => ({ mode: 'live', source: { state: 'connected' } }) };
  const f = { root, snapshot, context, calls, events, monitor };
  const run = async (argv, options) => {
    calls.push({ argv: [...argv], options }); await beforeRun?.(argv, f);
    const flag = name => argv[argv.indexOf(name) + 1]; let result;
    if (argv[1] === 'layout') result = { layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false, panes: [{ pane_id: 'w1:p1', rect: { width: 120, height: 40 } }] } };
    else if (argv[1] === 'split') {
      const pane = { ...snapshot.panes[0], pane_id: 'w1:p9', terminal_id: 'created', cwd: flag('--cwd') };
      snapshot.panes.push(pane); result = { pane };
    } else if (argv[1] === 'start') {
      const agent = { ...snapshot.panes.at(-1), agent: flag('--kind'), name: argv[2], agent_status: 'idle', interactive_ready: true, launch_pending: false };
      snapshot.agents.push(agent); result = { agent: structuredClone(agent), argv: [agent.agent, ...argv.slice(argv.indexOf('--') + 1)] };
    } else if (argv[1] === 'get' || argv[1] === 'prompt') result = { agent: structuredClone(snapshot.agents[0]) };
    else throw new Error(`Unexpected mutation: ${argv[0]} ${argv[1]}`);
    const response = { result }; return await afterRun?.(argv, f, response) ?? response;
  };
  f.controller = createController({ context, monitor, delivery, run, readRaw: async () => ({ result: { snapshot: structuredClone(snapshot) } }) });
  t.after(() => f.controller.dispose());
  f.request = patch => ({ taskId: 'task', attemptId: 'attempt', provider: 'codex', name: 'review-task', prompt: 'Reply with OK', cwd: root, ...patch });
  f.dispatch = request => f.controller.dispatch(request, { onProgress: event => events.push(event) });
  return f;
}
const started = f => f.calls.filter(call => call.argv[1] === 'start');
const prompted = f => f.calls.filter(call => call.argv[1] === 'prompt');
const unsafe = f => f.calls.filter(call => ['close', 'remove', 'send-keys', 'send-text'].includes(call.argv[1]));
const hostError = code => Object.assign(new Error('PRIVATE host text'), { code });

for (const provider of ['claude', 'codex', 'grok']) test(`${provider}: launch receives the entire literal task once after -- with no typed prompt or activity wait`, async t => {
  const f = await fixture(t);
  const prompt = 'Explain "quotes", \'apostrophes\', $(no-shell), `no-shell`; 羊 🐕 exactly';
  const request = f.request({ provider, prompt, args: ['--model', 'fixture'] });
  const result = await f.dispatch(request);
  assert.equal(result.state, 'submitted'); assert.equal(result.delivery, 'launch'); assert.equal(result.stage, 'start');
  assert.deepEqual(started(f)[0].argv, ['agent', 'start', 'review-task', '--kind', provider, '--pane', 'w1:p9', '--timeout', '30000', '--', '--model', 'fixture', prompt]);
  assert.deepEqual(result.argv, [provider, '--model', 'fixture', prompt]);
  assert.equal(started(f)[0].options.timeoutMs, 35000); assert.equal(prompted(f).length, 0);
  assert.deepEqual(f.events.map(event => event.stage), ['queued', 'target', 'start']);
  assert.deepEqual(await f.dispatch(request), result); assert.equal(started(f).length, 1);
  assert.equal(unsafe(f).length, 0); assert.equal(f.snapshot.panes.length, 2);
});

test('other agents, option-like tasks, one-word tasks and multiline tasks keep literal once-only typed delivery', async t => {
  for (const patch of [{ provider: 'kiro' }, { prompt: '-literal option' }, { prompt: '  -literal option' }, { prompt: 'update' },
    { prompt: '  update  ' }, { prompt: 'Reply\nwith OK' }, { prompt: 'Reply\twith OK' }, { prompt: 'Reply\rwith OK' }]) {
    const f = await fixture(t); const request = f.request(patch), result = await f.dispatch(request);
    if (request.prompt.includes('\r')) { assert.equal(result.code, 'invalid_prompt'); assert.equal(started(f).length, 0); continue; }
    assert.equal(result.state, 'submitted', JSON.stringify(patch)); assert.equal(result.delivery, 'type');
    assert.equal(started(f)[0].argv.includes('--'), false);
    assert.deepEqual(prompted(f)[0].argv, ['agent', 'prompt', 'w1:p9', request.prompt, '--wait', '--until', 'working', '--timeout', '6000']);
    assert.equal(prompted(f)[0].options.timeoutMs, 8000); assert.equal(prompted(f).length, 1);
    await f.dispatch(request); assert.equal(started(f).length, 1); assert.equal(prompted(f).length, 1); assert.equal(unsafe(f).length, 0);
  }
});

test('explicit typed test harness preserves the old path for an otherwise launchable task', async t => {
  const f = await fixture(t, { delivery: 'type' }); const result = await f.dispatch(f.request());
  assert.equal(result.delivery, 'type'); assert.equal(result.state, 'submitted'); assert.equal(started(f).length, 1); assert.equal(prompted(f).length, 1);
});

test('a working launch is submitted without requiring an idle input prompt', async t => {
  const f = await fixture(t, { afterRun: (argv, current, response) => {
    if (argv[1] === 'start') Object.assign(current.snapshot.agents[0], { agent_status: 'working', interactive_ready: false });
    return response;
  } });
  const result = await f.dispatch(f.request()); assert.equal(result.state, 'submitted'); assert.equal(result.delivery, 'launch');
  assert.equal(prompted(f).length, 0); assert.equal(unsafe(f).length, 0);
});

test('blocked and unready launch results keep the pane and never type or answer setup', async t => {
  for (const metadata of [{ agent_status: 'blocked' }, { interactive_ready: false }, { launch_pending: true }]) {
    const f = await fixture(t, { afterRun: (argv, current) => { if (argv[1] === 'start') Object.assign(current.snapshot.agents[0], metadata); } });
    const result = await f.dispatch(f.request()); assert.equal(result.state, 'needs_input'); assert.equal(result.delivery, 'launch');
    assert.match(result.message, /Needs you/); assert.doesNotMatch(result.message, /prompt was not sent/i);
    assert.equal(result.paneId, 'w1:p9'); assert.equal(f.snapshot.panes.length, 2);
    assert.equal(started(f).length, 1); assert.equal(prompted(f).length, 0); assert.equal(unsafe(f).length, 0);
  }
});

test('startup errors never retry or send a second copy and preserve the original target receipt', async t => {
  for (const [code, state] of [['agent_not_ready', 'needs_input'], ['agent_blocked', 'needs_input'], ['timeout', 'uncertain'], ['agent_start_transport_failed', 'uncertain']]) {
    const f = await fixture(t, { beforeRun: argv => { if (argv[1] === 'start') throw hostError(code); } });
    const request = f.request(), result = await f.dispatch(request);
    assert.equal(result.state, state); assert.equal(result.code, code); assert.equal(result.delivery, 'launch');
    assert.equal(result.paneId, 'w1:p9'); assert.equal(f.snapshot.panes.length, 2); assert.doesNotMatch(result.message, /PRIVATE/);
    assert.deepEqual(await f.dispatch(request), result); assert.equal(started(f).length, 1); assert.equal(prompted(f).length, 0); assert.equal(unsafe(f).length, 0);
  }
});

test('startup timeout only resolves from an exact working or blocked target and never restarts', async t => {
  for (const status of ['working', 'blocked', 'idle', 'done']) for (const changed of [false, true]) {
    const f = await fixture(t, { afterRun: (argv, current) => {
      if (argv[1] === 'start') {
        current.snapshot.agents[0].agent_status = status;
        if (changed) current.snapshot.agents[0].name = 'replacement';
        throw hostError('timeout');
      }
    } });
    const result = await f.dispatch(f.request());
    assert.equal(result.state, changed ? 'uncertain' : status === 'working' ? 'submitted' : status === 'blocked' ? 'needs_input' : 'uncertain', `${status}/${changed}`);
    assert.equal(started(f).length, 1); assert.equal(prompted(f).length, 0); assert.equal(unsafe(f).length, 0);
  }
});

test('a replaced or mismatched launch target cannot be reported as submitted or receive another prompt', async t => {
  for (const phase of ['response', 'snapshot', 'get']) for (const field of ['pane_id', 'terminal_id', 'agent', 'name']) {
    const f = await fixture(t, { afterRun: (argv, current, response) => {
      if (argv[1] === 'start' && phase === 'response') response.result.agent[field] = 'replacement';
      if (argv[1] === 'start' && phase === 'snapshot') current.snapshot.agents[0][field] = 'replacement';
      if (argv[1] === 'get' && phase === 'get') response.result.agent[field] = 'replacement';
    } });
    const result = await f.dispatch(f.request()); assert.equal(result.ok, false); assert.equal(result.code, 'changed_target');
    assert.equal(started(f).length, 1); assert.equal(prompted(f).length, 0); assert.equal(unsafe(f).length, 0);
  }
});

test('disposing during launch leaves the pane and never sends or retries the already supplied task', async t => {
  let release, startedSignal; const pending = new Promise(resolve => { release = resolve; }); const reached = new Promise(resolve => { startedSignal = resolve; });
  const f = await fixture(t, { afterRun: async argv => { if (argv[1] === 'start') { startedSignal(); await pending; } } });
  const resultPromise = f.dispatch(f.request()); await reached; f.controller.dispose(); release(); const result = await resultPromise;
  assert.equal(result.state, 'uncertain'); assert.equal(result.code, 'disposed'); assert.equal(result.delivery, 'launch');
  assert.equal(started(f).length, 1); assert.equal(prompted(f).length, 0); assert.equal(unsafe(f).length, 0); assert.equal(f.snapshot.panes.length, 2);
});

test('real execFile startup preserves one literal prompt argument and the pinned environment without a shell', async t => {
  const f = await fixture(t);
  const executable = join(f.root, 'herdr-fixture.mjs'), statePath = join(f.root, 'state.json'), logPath = join(f.root, 'calls.jsonl');
  await fs.writeFile(statePath, JSON.stringify(f.snapshot));
  await fs.writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
const argv = process.argv.slice(2), snapshot = JSON.parse(fs.readFileSync(process.env.TEST_STATE, 'utf8'));
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ argv, marker: process.env.TEST_MARKER, pane: process.env.HERDR_PANE_ID }) + '\\n');
let result;
if (argv[0] === 'api') result = {snapshot};
else if (argv[1] === 'layout') result = {layout:{workspace_id:'w1',tab_id:'w1:t1',zoomed:false,panes:[{pane_id:'w1:p1',rect:{width:120,height:40}}]}};
else if (argv[1] === 'split') {const pane={...snapshot.panes[0],pane_id:'w1:p9',terminal_id:'created'};snapshot.panes.push(pane);result={pane};}
else if (argv[1] === 'start') {const agent={...snapshot.panes[1],agent:'codex',name:argv[2],agent_status:'working',interactive_ready:false};snapshot.agents.push(agent);result={agent,argv:['codex',...argv.slice(argv.indexOf('--')+1)]};}
else if (argv[1] === 'get') result = {agent:snapshot.agents[0]};
else throw new Error('Unexpected command');
fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(snapshot));
process.stdout.write(JSON.stringify({result}));
`, { mode: 0o755 });
  const context = { ...f.context, binary: executable, env: { ...f.context.env, TEST_STATE: statePath, TEST_LOG: logPath, TEST_MARKER: 'pinned' } };
  const controller = createController({ context, monitor: f.monitor }); t.after(() => controller.dispose());
  context.env.TEST_MARKER = 'changed';
  const prompt = 'Explain "double" and \'single\' $(not-a-command) `also-not-a-command`; 羊';
  const result = await controller.dispatch(f.request({ prompt }));
  assert.equal(result.state, 'submitted'); assert.equal(result.delivery, 'launch');
  const calls = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const starts = calls.filter(call => call.argv[1] === 'start'); assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].argv.slice(starts[0].argv.indexOf('--') + 1), [prompt]);
  assert.ok(calls.every(call => call.marker === 'pinned' && call.pane === 'w1:p1'));
  assert.equal(calls.filter(call => ['prompt', 'close', 'remove', 'send-keys', 'send-text'].includes(call.argv[1])).length, 0);
});

test('invalid delivery policies are rejected before any host call', () => {
  for (const delivery of [null, '', 'launch', 'retry', true, {}]) {
    let calls = 0;
    assert.throws(() => createController({ delivery, run: () => { calls += 1; }, readRaw: () => { calls += 1; } }), /delivery must be auto or type/);
    assert.equal(calls, 0);
  }
});
