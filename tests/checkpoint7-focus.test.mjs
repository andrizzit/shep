import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createController } from '../src/control.mjs';
import { getHerdrContext } from '../src/herdr.mjs';
import { makeProject, makeSnapshot, createFakeRegistry, deferred } from './helpers/dispatch-fakes.mjs';

async function fixture(t, { detected = false, split = false, progress, beforeFocus, beforeGet } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'shep-start-focus-'))), bin = join(root, 'bin');
  await fs.mkdir(bin); await fs.writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const project = makeProject({ root, kind: 'folder', commonDir: null, key: `dir:${root}` });
  const snapshot = makeSnapshot(); snapshot.panes[0].cwd = snapshot.panes[0].foreground_cwd = root;
  const monitor = { mode: 'live', source: { state: 'connected' } }, calls = [], entered = deferred(), release = deferred(), events = [];
  const context = getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: join(root, 'fixture.sock'), HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', PATH: bin });
  const run = async argv => {
    calls.push([...argv]); const flag = value => argv[argv.indexOf(value) + 1];
    if (argv[0] === 'tab' && argv[1] === 'create' || argv[0] === 'pane' && argv[1] === 'split') {
      const pane = { ...snapshot.panes[0], pane_id: 'w1:p2', terminal_id: 'created', tab_id: split ? 'w1:t1' : 'w1:t2', focused: false };
      const tab = { tab_id: pane.tab_id, workspace_id: 'w1', number: 2 };
      snapshot.panes.push(pane); if (!split) snapshot.tabs.push(tab);
      return { result: split ? { pane } : { tab, root_pane: pane } };
    }
    if (argv[1] === 'layout') return { result: { layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false,
      panes: [{ pane_id: 'w1:p1', rect: { width: 120, height: 40 } }] } } };
    if (argv[1] === 'start') {
      const agent = { ...snapshot.panes[1], name: argv[2], agent: flag('--kind'), agent_status: 'working', interactive_ready: false, launch_pending: false };
      if (detected) snapshot.agents.push(agent); entered.resolve(); await release.promise;
      if (!snapshot.agents.length) snapshot.agents.push(agent);
      return { result: { agent: structuredClone(agent), argv: ['codex', argv.at(-1)] } };
    }
    if (argv[1] === 'get') {
      await beforeGet?.();
      return { result: { agent: structuredClone(snapshot.agents.find(agent => agent.pane_id === argv[2])) } };
    }
    if (argv[1] === 'focus') {
      if (await beforeFocus?.(argv, snapshot) === false) return { result: {} };
      const selected = argv[0] === 'tab' ? snapshot.panes.find(pane => pane.tab_id === argv[2])?.pane_id : argv[2];
      for (const pane of snapshot.panes) pane.focused = pane.pane_id === selected;
      snapshot.focused_pane_id = selected; return { result: {} };
    }
    throw new Error('Unexpected mutation');
  };
  const controller = createController({ context, monitor: { getSnapshot: () => monitor }, registry: createFakeRegistry({ projects: [project] }),
    run, readRaw: async () => ({ result: { snapshot: structuredClone(snapshot) } }) });
  const request = { taskId: 'task', attemptId: 'attempt', provider: 'codex', name: 'new-task', prompt: 'Reply with OK', inputTask: 'Reply with OK', args: [],
    placement: { root, projectKey: project.key, mode: 'here', subfolder: '', label: 'New task', placementStyle: split ? 'split' : 'tab' } };
  const pending = controller.dispatch(request, { onProgress: event => { events.push(structuredClone(event)); progress?.(event); } });
  t.after(async () => { release.resolve(); await pending; controller.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await entered.promise;
  return { controller, snapshot, monitor, calls, events, pending, release, target: events.find(event => event.target).target };
}
const focusCalls = f => f.calls.filter(argv => argv[1] === 'focus');

test('exact pending startup focus opens its created single-pane tab and leaves other mutation locks intact', async t => {
  const f = await fixture(t);
  assert.equal(f.events.find(event => event.target).delivery, 'launch');
  assert.deepEqual(f.target, { paneId: 'w1:p2', terminalId: 'created', provider: 'codex', agentName: 'new-task' });
  assert.equal((await f.controller.focus(f.target)).state, 'focused');
  assert.deepEqual(focusCalls(f), [['tab', 'focus', 'w1:t2']]);
  assert.equal((await f.controller.closeAgent({ ...f.target, status: 'working' })).code, 'busy');
  assert.equal((await f.controller.followUp({ target: f.target, text: 'Never send this' })).code, 'busy');
  assert.equal(f.calls.filter(argv => argv[1] === 'start').length, 1);
  assert.equal(f.calls.filter(argv => ['prompt', 'close', 'remove'].includes(argv[1])).length, 0);
  f.release.resolve(); assert.equal((await f.pending).state, 'submitted');
});

test('detected pending agents keep full native agent focus identity checks', async t => {
  const f = await fixture(t, { detected: true });
  assert.equal((await f.controller.focus(f.target)).state, 'focused'); assert.deepEqual(focusCalls(f), [['agent', 'focus', 'w1:p2']]);
  for (const field of ['terminal_id', 'agent', 'name']) {
    const saved = f.snapshot.agents[0][field]; f.snapshot.agents[0][field] = 'replacement';
    assert.equal((await f.controller.focus(f.target)).ok, false); f.snapshot.agents[0][field] = saved;
  }
  assert.equal(focusCalls(f).length, 1);
});

test('pending focus refuses external, split, altered topology, identities, own pane and disconnected/demo targets', async t => {
  for (const scenario of ['split', 'extra-pane', 'tab-moved', 'terminal-replaced', 'provider', 'name', 'known-session', 'external', 'own', 'demo', 'disconnected']) {
    const f = await fixture(t, { split: scenario === 'split' }); let target = { ...f.target };
    if (scenario === 'extra-pane') f.snapshot.panes.push({ ...f.snapshot.panes[1], pane_id: 'extra', terminal_id: 'extra' });
    if (scenario === 'tab-moved') f.snapshot.tabs.find(tab => tab.tab_id === 'w1:t2').workspace_id = 'replacement';
    if (scenario === 'terminal-replaced') f.snapshot.panes[1].terminal_id = 'replacement';
    if (scenario === 'provider') target.provider = 'claude';
    if (scenario === 'name') target.agentName = 'replacement';
    if (scenario === 'known-session') target.sessionId = 'an-observed-session';
    if (scenario === 'external') { f.snapshot.panes.push({ ...f.snapshot.panes[1], pane_id: 'external', terminal_id: 'external' }); target = { ...target, paneId: 'external', terminalId: 'external' }; }
    if (scenario === 'own') target = { ...target, paneId: 'w1:p1', terminalId: 'own-terminal' };
    if (scenario === 'demo') f.monitor.mode = 'demo';
    if (scenario === 'disconnected') f.monitor.source.state = 'disconnected';
    assert.equal((await f.controller.focus(target)).ok, scenario === 'known-session', scenario); assert.equal(focusCalls(f).length, scenario === 'known-session' ? 1 : 0, scenario);
    assert.equal(f.calls.filter(argv => argv[1] === 'start').length, 1);
    assert.equal(f.calls.filter(argv => ['prompt', 'close', 'remove'].includes(argv[1])).length, 0);
  }
});

test('a progress observer cannot mutate the controller-owned startup identity', async t => {
  const f = await fixture(t, { progress: event => { if (event.target) { event.target.provider = 'claude'; event.target.agentName = 'replacement'; } } });
  assert.equal((await f.controller.focus(f.target)).state, 'focused');
  assert.equal(f.calls.find(argv => argv[1] === 'start')[2], 'new-task');
  assert.equal(f.calls.find(argv => argv[1] === 'start')[4], 'codex');
});

test('pending focus retains per-pane serialization after startup resolves', async t => {
  const focusing = deferred(), focusDone = deferred();
  const f = await fixture(t, { beforeFocus: async () => { focusing.resolve(); await focusDone.promise; } });
  t.after(() => focusDone.resolve());
  const action = f.controller.focus(f.target); await focusing.promise;
  f.release.resolve(); assert.equal((await f.pending).state, 'submitted');
  assert.equal((await f.controller.focus(f.target)).code, 'busy');
  assert.equal((await f.controller.closeAgent({ ...f.target, status: 'working' })).code, 'busy');
  assert.equal((await f.controller.followUp({ target: f.target, text: 'Never send this' })).code, 'busy');
  assert.equal(focusCalls(f).length, 1); assert.equal(f.calls.filter(argv => ['prompt', 'close'].includes(argv[1])).length, 0);
  focusDone.resolve(); assert.equal((await action).state, 'focused');
  assert.equal((await f.controller.focus(f.target)).state, 'focused');
});

test('an unconfirmed early-tab focus reports uncertainty without repeating the focus', async t => {
  const f = await fixture(t, { beforeFocus: () => false });
  const outcome = await f.controller.focus(f.target);
  assert.equal(outcome.state, 'uncertain'); assert.equal(outcome.code, 'invalid_response');
  assert.equal(focusCalls(f).length, 1); assert.equal(f.calls.filter(argv => ['prompt', 'close', 'remove'].includes(argv[1])).length, 0);
});

test('disposal during early-tab focus sends no further commands or retries', async t => {
  const focusing = deferred(), focusDone = deferred();
  const f = await fixture(t, { beforeFocus: async () => { focusing.resolve(); await focusDone.promise; } });
  t.after(() => focusDone.resolve());
  const action = f.controller.focus(f.target); await focusing.promise;
  f.controller.dispose(); focusDone.resolve();
  const outcome = await action;
  assert.equal(outcome.state, 'uncertain'); assert.equal(outcome.code, 'disposed');
  const count = f.calls.length;
  f.release.resolve(); assert.equal((await f.pending).code, 'disposed');
  assert.equal(f.calls.length, count); assert.equal(focusCalls(f).length, 1);
  assert.equal(f.calls.filter(argv => ['prompt', 'close', 'remove'].includes(argv[1])).length, 0);
});

test('focus remains available during launch postflight while close and follow-up stay locked', async t => {
  const checking = deferred(), checked = deferred(); let reads = 0;
  const f = await fixture(t, { beforeGet: async () => { if (++reads === 1) { checking.resolve(); await checked.promise; } } });
  f.release.resolve(); await checking.promise;
  try {
    assert.equal((await f.controller.focus(f.target)).state, 'focused');
    assert.deepEqual(focusCalls(f), [['agent', 'focus', 'w1:p2']]);
    assert.equal((await f.controller.closeAgent({ ...f.target, status: 'working' })).code, 'busy');
    assert.equal((await f.controller.followUp({ target: f.target, text: 'Never send this' })).code, 'busy');
    assert.equal(f.calls.filter(argv => argv[1] === 'start').length, 1);
    assert.equal(f.calls.filter(argv => ['prompt', 'close', 'remove'].includes(argv[1])).length, 0);
  } finally { checked.resolve(); }
  assert.equal((await f.pending).state, 'submitted');
});
