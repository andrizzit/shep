import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createController } from '../src/control.mjs';
import { getHerdrContext, normalizeSnapshot } from '../src/herdr.mjs';
import { createTuiModel } from '../src/tui-model.mjs';
import { taskRows, taskPresentation, TASK_LABELS } from '../src/tui-tasks.mjs';
import { createNotifier } from '../src/notify.mjs';
import { DEFAULT_CONFIG } from '../src/dispatch/contracts.mjs';
import { makeProject, makeSnapshot, createFakeRegistry, deferred } from './helpers/dispatch-fakes.mjs';

const hostError = code => Object.assign(new Error('Synthetic host error'), { code });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, hooks = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'shep-timeout-recovery-'))), bin = join(root, 'bin');
  await fs.mkdir(bin); await fs.writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const project = makeProject({ root, kind: 'folder', commonDir: null, key: `dir:${root}` });
  const registry = createFakeRegistry({ projects: [project] }), snapshot = makeSnapshot();
  snapshot.panes[0].cwd = snapshot.panes[0].foreground_cwd = root;
  let publicSnapshot = { mode: 'live', source: { state: 'connected' }, updatedAt: new Date(1000).toISOString(), agents: [] };
  const listeners = new Set(), calls = [], events = [];
  const monitor = { getSnapshot: () => publicSnapshot, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const context = getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: join(root, 'fixture.sock'), HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', PATH: bin });
  const f = { root, project, registry, snapshot, monitor, calls, events, getCount: 0,
    publish(patch = {}) {
      publicSnapshot = { ...publicSnapshot, ...normalizeSnapshot({ result: { snapshot } }), ...patch };
      for (const fn of listeners) fn(publicSnapshot);
    } };
  const run = async argv => {
    calls.push([...argv]); const flag = name => argv[argv.indexOf(name) + 1];
    if (argv[0] === 'tab' && argv[1] === 'create') {
      const pane = { ...snapshot.panes[0], pane_id: 'w1:p2', terminal_id: 'created', tab_id: 'w1:t2', focused: false };
      const tab = { tab_id: pane.tab_id, workspace_id: 'w1', number: 2 };
      snapshot.panes.push(pane); snapshot.tabs.push(tab); return { result: { tab, root_pane: pane } };
    }
    if (argv[1] === 'start') {
      snapshot.agents.push({ ...snapshot.panes[1], agent: flag('--kind'), agent_status: 'working', interactive_ready: false,
        agent_session: { kind: 'id', value: 'started-session' } });
      await hooks.start?.(f, argv); throw hostError(hooks.error ?? 'timeout');
    }
    if (argv[1] === 'get') {
      f.getCount += 1; await hooks.get?.(f, f.getCount);
      return { result: { agent: structuredClone(snapshot.agents.find(agent => agent.pane_id === argv[2])) } };
    }
    if (argv[1] === 'rename') {
      await hooks.rename?.(f, argv);
      snapshot.agents[0].name = argv[3];
      const response = { result: { agent: structuredClone(snapshot.agents[0]) } };
      await hooks.renamed?.(f, response); return response;
    }
    if (argv[1] === 'focus') {
      await hooks.focus?.(f);
      snapshot.focused_pane_id = argv[2]; return { result: {} };
    }
    if (argv[0] === 'notification' && argv[1] === 'show') return { result: {} };
    throw new Error(`Unexpected command: ${argv[0]} ${argv[1]}`);
  };
  f.controller = createController({ context, monitor, registry, delivery: hooks.delivery, run,
    readRaw: async () => { await hooks.read?.(f); return { result: { snapshot: structuredClone(snapshot) } }; } });
  f.request = { taskId: 'task', attemptId: 'attempt', provider: 'codex', name: 'reply-task', prompt: 'Reply with "OK"; $(literal)', inputTask: 'Reply with "OK"; $(literal)', args: [],
    placement: { root, projectKey: project.key, mode: 'here', subfolder: '', label: 'Reply task', placementStyle: 'tab' } };
  f.dispatch = () => f.controller.dispatch(f.request, { onProgress: event => events.push(structuredClone(event)) });
  f.target = { paneId: 'w1:p2', terminalId: 'created', provider: 'codex', agentName: f.request.name, sessionId: 'started-session' };
  t.after(async () => { f.controller.dispose(); registry.destroy(); await fs.rm(root, { recursive: true, force: true }); });
  return f;
}
const commands = (f, action) => f.calls.filter(argv => argv[1] === action);
function assertOnceOnly(f, renameCount) {
  assert.equal(commands(f, 'start').length, 1);
  assert.equal(commands(f, 'rename').length, renameCount);
  assert.equal(f.calls.filter(argv => ['prompt', 'close', 'remove', 'send-keys', 'send-text'].includes(argv[1])).length, 0);
}

test('startup timeout restores only an absent managed name once, then verifies the exact working target', async t => {
  for (const missing of [undefined, null, '']) {
    const f = await fixture(t, { start: f => { f.snapshot.agents[0].name = missing; } });
    const result = await f.dispatch();
    assert.equal(result.state, 'submitted'); assert.equal(result.delivery, 'launch'); assert.equal(result.agentName, 'reply-task');
    assert.deepEqual(commands(f, 'rename'), [['agent', 'rename', 'w1:p2', 'reply-task']]);
    assert.deepEqual(commands(f, 'start')[0].slice(commands(f, 'start')[0].indexOf('--') + 1), [f.request.prompt]);
    assert.equal(f.getCount, 2, 'One unnamed preflight and one strict postflight');
    assert.deepEqual(await f.dispatch(), result); assertOnceOnly(f, 1);
    assert.equal(f.snapshot.panes.length, 2); assert.deepEqual(result.created.panes, [{ paneId: 'w1:p2', terminalId: 'created', tabId: 'w1:t2', workspaceId: 'w1' }]);
  }
});

test('existing expected names keep timeout classification without a rename; typed and other errors never restore names', async t => {
  for (const status of ['working', 'blocked', 'idle', 'done']) {
    const f = await fixture(t, { start: f => Object.assign(f.snapshot.agents[0], { name: f.request.name, agent_status: status }) });
    assert.equal((await f.dispatch()).state, status === 'working' ? 'submitted' : status === 'blocked' ? 'needs_input' : 'uncertain');
    assertOnceOnly(f, 0);
  }
  for (const hooks of [{ delivery: 'type' }, { error: 'agent_start_transport_failed' }, { error: 'agent_not_ready' }]) {
    const f = await fixture(t, hooks); assert.notEqual((await f.dispatch()).state, 'submitted'); assertOnceOnly(f, 0);
  }
});

test('timeout recovery never renames a replacement, a different present name or a changed creation tuple', async t => {
  const variants = [
    f => { f.snapshot.agents[0].name = 'other-agent'; },
    ...[0, false, ' ', '\t'].map(name => f => { f.snapshot.agents[0].name = name; }),
    f => { f.snapshot.agents[0].agent = 'claude'; },
    f => { f.snapshot.agents[0].pane_id = 'other-pane'; },
    f => { f.snapshot.agents[0].terminal_id = 'other-terminal'; },
    f => { f.snapshot.panes[1].terminal_id = 'other-terminal'; },
    f => { f.snapshot.panes[1].tab_id = 'other-tab'; },
    f => { f.snapshot.panes[1].workspace_id = 'other-workspace'; },
    f => { f.snapshot.panes[0].terminal_id = 'replaced-own-pane'; },
    f => { f.snapshot.agents.length = 0; },
    f => { f.snapshot.panes.pop(); },
  ];
  for (const start of variants) {
    const f = await fixture(t, { start }); assert.equal((await f.dispatch()).state, 'uncertain'); assertOnceOnly(f, 0);
  }
});

test('the second preflight read must still be unnamed, same-provider and same-session before restoring a name', async t => {
  for (const field of ['name', 'agent', 'terminal_id', 'agent_session']) {
    const f = await fixture(t, { get: (f, count) => {
      if (count === 1) f.snapshot.agents[0][field] = field === 'agent_session' ? { kind: 'id', value: 'replacement-session' } : 'replacement';
    } });
    assert.equal((await f.dispatch()).state, 'uncertain'); assertOnceOnly(f, 0);
  }
  const f = await fixture(t, { start: f => { f.snapshot.agents[0].name = 'other-agent'; },
    get: f => { delete f.snapshot.agents[0].name; } });
  assert.equal((await f.dispatch()).state, 'uncertain'); assertOnceOnly(f, 0);
});

test('rename failures and changed postflight identity remain uncertain and never repeat any mutation', async t => {
  for (const code of ['timeout', 'unavailable', 'invalid_response']) {
    const f = await fixture(t, { rename: () => { throw hostError(code); } });
    const result = await f.dispatch(); assert.equal(result.state, 'uncertain'); assert.deepEqual(await f.dispatch(), result); assertOnceOnly(f, 1);
  }
  for (const phase of ['response', 'snapshot', 'get']) for (const field of ['name', 'agent', 'pane_id', 'terminal_id', 'agent_session']) {
    const change = agent => { agent[field] = field === 'agent_session' ? { kind: 'id', value: 'replacement-session' } : 'replacement'; };
    const f = await fixture(t, {
      renamed: (f, response) => { if (phase === 'response') change(response.result.agent); if (phase === 'snapshot') change(f.snapshot.agents[0]); },
      get: (f, count) => { if (phase === 'get' && count === 2) change(f.snapshot.agents[0]); },
    });
    assert.equal((await f.dispatch()).state, 'uncertain', `${phase}/${field}`); assertOnceOnly(f, 1);
  }
  for (const phase of ['snapshot', 'get']) {
    const failRead = f => { if (commands(f, 'rename').length) throw hostError('unavailable'); };
    const f = await fixture(t, phase === 'snapshot' ? { read: failRead } : { get: failRead });
    const result = await f.dispatch(); assert.equal(result.state, 'uncertain');
    assert.deepEqual(await f.dispatch(), result); assertOnceOnly(f, 1);
  }
});

test('disposal, disconnected and demo state during recovery preflight prevent the rename', async t => {
  for (const state of ['disposed', 'disconnected', 'demo']) {
    const f = await fixture(t, { get: (f, count) => {
      if (count !== 1) return;
      if (state === 'disposed') f.controller.dispose();
      else if (state === 'demo') f.publish({ mode: 'demo' });
      else f.publish({ source: { state: 'disconnected' } });
    } });
    assert.equal((await f.dispatch()).state, 'uncertain'); assertOnceOnly(f, 0);
  }
  const f = await fixture(t, { rename: f => f.controller.dispose() });
  assert.equal((await f.dispatch()).state, 'uncertain'); assert.equal(f.getCount, 1); assertOnceOnly(f, 1);
});

test('name recovery retains per-pane serialization until strict postflight completes', async t => {
  for (const phase of ['rename', 'postflight']) {
    const entered = deferred(), release = deferred();
    const pause = async () => { entered.resolve(); await release.promise; };
    const f = await fixture(t, phase === 'rename' ? { rename: pause } : { get: (_f, count) => count === 2 ? pause() : undefined });
    const pending = f.dispatch(); await entered.promise;
    try {
      assert.equal((await f.controller.focus(f.target)).code, 'busy');
      assert.equal((await f.controller.closeAgent({ ...f.target, status: 'working' })).code, 'busy');
      assert.equal((await f.controller.followUp({ target: f.target, text: 'Do not send' })).code, 'busy');
      assertOnceOnly(f, 1);
    } finally { release.resolve(); }
    assert.equal((await pending).state, 'submitted');
  }
});

test('an in-flight startup focus prevents competing timeout rename recovery', async t => {
  const started = deferred(), finishStart = deferred(), focused = deferred(), finishFocus = deferred();
  const f = await fixture(t, {
    start: async f => { f.snapshot.agents[0].name = f.request.name; started.resolve(); await finishStart.promise; delete f.snapshot.agents[0].name; },
    focus: async () => { focused.resolve(); await finishFocus.promise; },
  });
  const pending = f.dispatch(); await started.promise;
  const focus = f.controller.focus(f.target); await focused.promise;
  finishStart.resolve();
  try { assert.equal((await pending).state, 'uncertain'); assertOnceOnly(f, 0); }
  finally { finishFocus.resolve(); }
  assert.equal((await focus).state, 'focused');
});

test('restored launch identity stays one Working then Done task and emits one finished notification', async t => {
  const f = await fixture(t), config = structuredClone(DEFAULT_CONFIG); config.notifications.external = true;
  const controller = { ...f.controller, dispatch: (...args) => { f.pending = f.controller.dispatch(...args); return f.pending; } };
  const model = createTuiModel({ monitor: f.monitor, controller, registry: f.registry, config, now: () => 1000 });
  await model.ready;
  const notifier = createNotifier({ monitor: f.monitor, controller, config, getTasks: model.getTasks, now: () => 1000 });
  t.after(() => { notifier.dispose(); model.destroy(); });
  model.paste('/dispatch codex: Reply with OK'); model.key('', { return: true });
  await tick(); assert(f.pending); assert.equal((await f.pending).state, 'submitted'); await tick();
  f.publish();
  let rows = taskRows(model.getSnapshot());
  assert.equal(rows.length, 1); assert.equal(rows[0].external, false); assert.equal(TASK_LABELS[taskPresentation(rows[0])], 'Working');
  assert.equal(model.getTasks()[0].observedActivity, true);
  f.snapshot.agents[0].agent_status = 'idle'; f.publish(); f.publish(); await tick();
  rows = taskRows(model.getSnapshot());
  assert.equal(rows.length, 1); assert.equal(rows[0].external, false); assert.equal(TASK_LABELS[taskPresentation(rows[0])], 'Done');
  const notices = f.calls.filter(argv => argv[0] === 'notification');
  assert.equal(notices.length, 1); assert.match(notices[0][2], /finished$/); assert.equal(notices[0].at(-1), 'done');
  assertOnceOnly(f, 1);
});
