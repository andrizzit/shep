import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { createTuiModel, visibleAgents } from '../src/tui-model.mjs';
import { TuiView } from '../src/tui.mjs';
import { taskRows, taskPresentation, TASK_LABELS, TASK_FILTERS, commandSuggestions, deferredCommand } from '../src/tui-tasks.mjs';
import { resolvePlacement, preparePlacementSnapshot } from '../src/placement.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { DEFAULT_CONFIG } from '../src/dispatch/contracts.mjs';
import { createFakeRegistry, deferred, makeProject, makeSnapshot } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const project = makeProject();
const providers = ['codex', 'claude'].map(id => ({ id, name: id === 'codex' ? 'Codex' : 'Claude', available: true }));
async function fixture(t, options = {}) {
  let snapshot = { mode: 'live', updatedAt: new Date().toISOString(), source: { state: 'connected' }, agents: [] };
  let listener, sequence = 0, clock = Date.now();
  const calls = [], topology = { panes: [], agents: [], workspaces: [], tabs: [] };
  const controller = {
    getProfiles: async () => ({ providers, workspaces: [], defaultCwd: project.root, ownPaneId: 'own-pane', ownTerminalId: 'own-terminal' }),
    getControlSnapshot: async () => structuredClone(topology),
    dismissTask: async request => { calls.push({ method: 'dismiss', request }); return { ok: true, state: 'dismissed', message: 'Released.' }; },
    focus: async request => { calls.push({ method: 'focus', request }); return { ok: true, state: 'focused', message: 'Focused.' }; },
    closeAgent: async request => { calls.push({ method: 'close', request }); return { ok: true, state: 'closed', message: 'Closed.' }; },
    ...options.controller,
  };
  controller.dispatch = async (request, { onProgress }) => {
    calls.push({ method: 'dispatch', request });
    const number = ++sequence, paneId = `pane-${number}`, terminalId = `terminal-${number}`;
    topology.panes.push({ pane_id: paneId, terminal_id: terminalId });
    await onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'start', at: new Date(clock).toISOString() });
    const result = options.dispatch ? await options.dispatch(request, number) : { ok: true, state: 'submitted', message: 'Started.' };
    return { paneId, terminalId, agentName: request.name, ...result, taskId: request.taskId, attemptId: request.attemptId };
  };
  const model = createTuiModel({ monitor: { getSnapshot: () => snapshot, subscribe: fn => { listener = fn; return () => { listener = null; }; } },
    controller, registry: createFakeRegistry(), now: () => clock });
  t.after(model.destroy); await model.ready;
  const publish = patch => { clock += 1001; snapshot = { ...snapshot, ...patch }; listener?.(snapshot); };
  const send = async command => { model.action('cancel'); model.paste(command); model.key('', { return: true }); await tick(); return model.getTasks().at(-1); };
  const agent = (task, status = 'idle', patch = {}) => ({ id: task.target.terminalId, ...task.target, name: task.name, provider: task.agent.provider,
    status, workspace: { path: project.root }, ...patch });
  return { model, calls, topology, publish, send, agent };
}

test('partial launches preserve their literal draft, select their row, and never hold independent dispatches', async t => {
  const pending = deferred();
  const f = await fixture(t, { dispatch: (_request, number) => number === 1 ? pending.promise : { ok: true, state: 'submitted', message: 'Started.' } });
  f.model.action('board-toggle'); f.model.action('search'); f.model.paste('no matches'); f.model.key('', { return: true }); f.model.action('filter');
  const literal = 'Review $(literal)\nsecond line';
  f.model.paste('/dispatch claude: ' + literal); f.model.key('', { return: true }); f.model.key('', { return: true });
  await tick(); assert.equal(f.calls.filter(call => call.method === 'dispatch').length, 1);
  pending.resolve({ ok: false, state: 'needs_input', message: 'Answer in the agent pane.' }); await tick();
  const task = f.model.getTasks()[0], state = f.model.getSnapshot();
  assert.equal(state.view, 'board'); assert.equal(state.boardView, 'tasks'); assert.equal(state.query, ''); assert.equal(state.filter, 'all');
  assert.equal(state.selectedTaskId, `task:${task.id}`); assert.equal(state.draft.prompt, literal); assert.equal(Object.hasOwn(state, 'dispatchHold'), false);
  f.model.key('', { return: true }); await tick();
  const focus = f.calls.find(call => call.method === 'focus');
  assert.equal(focus.request.paneId, task.target.paneId); assert.equal(focus.request.terminalId, task.target.terminalId);
  assert.equal(f.calls.filter(call => call.method === 'dispatch').length, 1, 'Opening the pane cannot resend the task');
  await f.send('/dispatch codex: Start another task');
  const launches = f.calls.filter(call => call.method === 'dispatch');
  assert.equal(launches.length, 2); assert.equal(launches[0].request.prompt, literal); assert.equal(launches[1].request.prompt, 'Start another task');
  assert.notEqual(launches[0].request.taskId, launches[1].request.taskId);
  assert.match(f.model.getSnapshot().notice.message, /^Codex started in shep · Enter to open$/);
});

test('new-row Enter retains identity, own-pane, stale, demo and close protections before public discovery', async t => {
  for (const patch of [{ source: { state: 'disconnected' } }, { mode: 'demo' }]) {
    const f = await fixture(t); await f.send('/dispatch Start a task'); f.publish(patch);
    f.model.key('', { return: true }); f.model.key('x'); await tick();
    assert.equal(f.calls.filter(call => ['focus', 'close'].includes(call.method)).length, 0);
  }
  for (const target of [{ paneId: 'own-pane' }, { terminalId: 'own-terminal' }]) {
    const f = await fixture(t, { dispatch: () => ({ ok: true, state: 'submitted', message: 'Started.', ...target }) });
    await f.send('/dispatch Start a task'); f.model.key('', { return: true }); await tick();
    assert.equal(f.calls.filter(call => call.method === 'focus').length, 0); assert.match(f.model.getSnapshot().notice.message, /own pane/);
  }
  const f = await fixture(t); const task = await f.send('/dispatch Start a task');
  f.publish({ agents: [f.agent(task, 'working', { terminalId: 'replacement', id: 'replacement' })] });
  f.model.key('', { return: true }); await tick();
  assert.equal(f.calls.at(-1).request.terminalId, task.target.terminalId, 'Native controller receives the captured target, never a reused occupant');
  f.model.key('x'); assert.equal(f.calls.filter(call => call.method === 'close').length, 0);
});

test('confirmed closed tasks disappear after five seconds without disturbing the editor or touching panes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t), task = await f.send('/dispatch Close this task');
  f.publish({ agents: [] }); await tick();
  assert.equal(taskRows(f.model.getSnapshot()).length, 1, 'Missing public agent alone cannot close a task');
  t.mock.timers.tick(6000); await tick(); assert.equal(f.calls.filter(call => call.method === 'dismiss').length, 0);
  f.topology.panes = []; f.publish({ agents: [] }); await tick();
  assert.equal(f.model.getTasks()[0].live.status, 'closed');
  f.model.action('new'); f.model.action('field', 'prompt'); f.model.paste('Unrelated draft');
  const draft = f.model.getSnapshot().draft;
  t.mock.timers.tick(4999); await tick(); assert.equal(taskRows(f.model.getSnapshot()).length, 1);
  t.mock.timers.tick(1); await tick(); assert.equal(taskRows(f.model.getSnapshot()).length, 0);
  assert.equal(f.model.getSnapshot().view, 'compose'); assert.deepEqual(f.model.getSnapshot().draft, draft);
  assert.deepEqual(f.calls.filter(call => call.method === 'dismiss').map(call => call.request), [{ taskId: task.id, attemptId: task.attemptId }]);
  assert.equal(f.calls.filter(call => call.method === 'close').length, 0);
  t.mock.timers.tick(10000); await tick(); assert.equal(f.calls.filter(call => call.method === 'dismiss').length, 1);
});

test('closed-row timers stop on quit and manual clearing; C keeps open failed panes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['quit', 'clear']) {
    const f = await fixture(t); await f.send('/dispatch Close this task');
    f.topology.panes = []; f.publish({ agents: [] }); await tick();
    if (action === 'quit') f.model.destroy(); else { f.model.key('C'); await tick(); }
    const count = f.calls.filter(call => call.method === 'dismiss').length;
    t.mock.timers.tick(6000); await tick(); assert.equal(f.calls.filter(call => call.method === 'dismiss').length, count);
  }
  const f = await fixture(t, { dispatch: () => ({ ok: false, state: 'failed', message: 'Could not start.' }) });
  await f.send('/dispatch A failed task'); f.model.key('C'); await tick();
  assert.equal(f.model.getTasks()[0].dismissed, false); assert.match(f.model.getSnapshot().notice.message, /Close that pane in Herdr/);
  assert.equal(f.calls.filter(call => ['dismiss', 'close'].includes(call.method)).length, 0);
  f.topology.panes = []; f.model.key('C'); await tick(); assert.equal(f.model.getTasks()[0].dismissed, true);
  const unavailable = await fixture(t, { dispatch: () => ({ ok: false, state: 'failed', message: 'Could not start.' }),
    controller: { getControlSnapshot: async () => ({}) } });
  await unavailable.send('/dispatch A failed task'); unavailable.model.key('C'); await tick();
  assert.equal(unavailable.model.getTasks()[0].dismissed, false);
  assert.match(unavailable.model.getSnapshot().notice.message, /could not be verified/);
  assert.equal(unavailable.calls.filter(call => ['dismiss', 'close'].includes(call.method)).length, 0);
});

test('main placement ignores occupancy and reservations while explicit wt and always isolate', async () => {
  const raw = makeSnapshot({ agents: [{ agent: 'codex', agent_status: 'working', cwd: project.root }] });
  const snapshot = await preparePlacementSnapshot(raw, { realpath: async path => path });
  const intent = { projectKey: project.key, root: project.root, mode: 'auto', subfolder: 'src', label: 'Task', placementStyle: 'tab' };
  const reservations = [{ projectKey: project.key, cwd: project.root }];
  const main = resolvePlacement({ intent, project, snapshot, reservations });
  assert.equal(main.mode, 'here'); assert.equal(main.targetKind, 'tab'); assert.equal(main.cwd, project.root + '/src');
  assert.equal(resolvePlacement({ intent: { ...intent, mode: 'wt' }, project, snapshot }).mode, 'worktree');
  assert.equal(resolvePlacement({ intent: { ...intent, mode: 'here' }, project: { ...project, isolation: 'always' }, snapshot }).mode, 'worktree');
  const context = { providers, projects: [project], config: DEFAULT_CONFIG };
  assert.deepEqual(commandSuggestions('/dispatch codex+', 16, context).map(item => item.value), ['wt', 'here']);
  assert.equal(deferredCommand('/dispatch codex@shep+wt: isolated task', context), null);
  assert.match(deferredCommand('/dispatch codex.fast+wt: isolated task', context), /not enabled/);
});

test('owner-facing status and compact boards show Needs you without a hold or invented Working', async t => {
  const f = await fixture(t, { dispatch: () => ({ ok: false, state: 'uncertain', message: 'Check the pane.' }) });
  const task = await f.send('/dispatch Review startup');
  for (const status of ['unknown', 'idle', 'blocked']) {
    f.publish({ agents: [f.agent(task, status)] });
    const row = taskRows(f.model.getSnapshot())[0];
    assert.equal(row.status, status); assert.equal(TASK_LABELS[taskPresentation(row)], 'Needs you');
    for (const [width, height] of [[119, 39], [39, 14]]) {
      const screen = stripVTControlCharacters(renderToString(React.createElement(TuiView, { state: f.model.getSnapshot(), model: f.model, width, height, offset: 1 })));
      assert.match(screen, /Needs you/); assert.doesNotMatch(screen, /Allow.*launch|Ctrl\+Y/);
      assert(screen.split('\n').length <= height); assert(screen.split('\n').every(line => displayWidth(line) <= width));
    }
  }
  for (const [native, label] of [['working', 'Working'], ['done', 'Done']]) {
    f.publish({ agents: [f.agent(task, native)] }); assert.equal(TASK_LABELS[taskPresentation(taskRows(f.model.getSnapshot())[0])], label);
  }
  assert.equal(TASK_LABELS.idle, 'Done'); assert.equal(TASK_LABELS.unknown, 'Starting');
});

test('only observed activity of the matching agent resolves startup attention on later Idle', async t => {
  for (const launchState of ['needs_input', 'uncertain']) {
    const f = await fixture(t, { dispatch: () => ({ ok: false, state: launchState, message: 'Check startup.' }) });
    const task = await f.send('/dispatch Review this task');
    const label = () => TASK_LABELS[taskPresentation(taskRows(f.model.getSnapshot()).find(row => row.task?.id === task.id))];
    f.publish({ agents: [f.agent(task, 'idle', { sessionId: 'original' })] });
    assert.equal(label(), 'Needs you'); assert.notEqual(f.model.getTasks()[0].observedActivity, true);
    f.publish({ agents: [f.agent(task, 'working', { sessionId: 'replacement' })] });
    assert.equal(label(), 'Needs you'); assert.notEqual(f.model.getTasks()[0].observedActivity, true);
    f.publish({ agents: [f.agent(task, 'working', { sessionId: 'original' })] });
    assert.equal(label(), 'Working'); assert.equal(f.model.getTasks()[0].observedActivity, true);
    f.publish({ agents: [f.agent(task, 'idle', { sessionId: 'original' })] });
    assert.equal(label(), 'Done'); assert.equal(f.model.getTasks()[0].launch.state, launchState);
    assert.equal(f.calls.filter(call => call.method === 'dispatch').length, 1);
  }
});

test('visible filter cycle has one category per label and includes every Needs you and Done alias', async t => {
  const f = await fixture(t);
  const task = await f.send('/dispatch A filter fixture');
  const base = f.model.getTasks()[0];
  const states = ['blocked', 'needs_input', 'uncertain', 'needs_confirmation', 'done', 'idle', 'unknown', 'queued', 'starting', 'working', 'failed', 'closed'];
  const tasks = states.map((status, index) => ({ ...structuredClone(base), id: status, name: `fixture-${status}`, at: new Date(Date.now() + index).toISOString(),
    target: null, live: { status: ['blocked', 'done', 'idle', 'unknown', 'working', 'closed'].includes(status) ? status : null, since: null },
    launch: { ...base.launch, state: ['needs_input', 'uncertain', 'needs_confirmation', 'queued', 'starting', 'failed'].includes(status) ? status : 'submitted' } }));
  const state = { ...f.model.getSnapshot(), tasks };
  const selected = filter => taskRows({ ...state, filter }).map(row => row.task.id).sort();
  assert.deepEqual(selected('blocked'), ['blocked', 'needs_confirmation', 'needs_input', 'uncertain']);
  assert.deepEqual(selected('done'), ['done', 'idle']);
  assert.deepEqual(selected('unknown'), ['queued', 'starting', 'unknown']);
  assert.deepEqual(selected('working'), ['working']); assert.deepEqual(selected('failed'), ['failed']); assert.deepEqual(selected('closed'), ['closed']);
  const labels = [];
  for (let index = 0; index < TASK_FILTERS.length; index += 1) {
    const filter = f.model.getSnapshot().filter; labels.push(filter === 'all' ? 'All' : TASK_LABELS[filter]); f.model.key('f');
  }
  assert.equal(new Set(labels).size, labels.length); assert.equal(f.model.getSnapshot().filter, 'all');
  assert.deepEqual(labels, ['All', 'Working', 'Needs you', 'Done', 'Starting', 'Closed', 'Failed']);
  f.publish({ agents: [f.agent(task, 'idle'), f.agent(task, 'done', { id: 'second', paneId: 'second', terminalId: 'second' })] });
  f.model.key('g'); f.model.key('f'); f.model.key('f'); f.model.key('f');
  assert.equal(f.model.getSnapshot().filter, 'done'); assert.equal(visibleAgents(f.model.getSnapshot()).length, 2);
  const nativeStates = visibleAgents(f.model.getSnapshot()).map(agent => agent.status).sort(); assert.deepEqual(nativeStates, ['done', 'idle']);
  const agentLabels = [];
  for (let index = 0; index < 5; index += 1) { agentLabels.push(f.model.getSnapshot().filter); f.model.key('f'); }
  assert.equal(new Set(agentLabels).size, agentLabels.length); assert.equal(f.model.getSnapshot().filter, 'done');
});

test('task detail keeps startup evidence and Needs you without internal launch-state labels', async t => {
  for (const launchState of ['needs_input', 'uncertain', 'submitted']) {
    const message = 'Check the agent pane.';
    const f = await fixture(t, { dispatch: () => ({ ok: launchState === 'submitted', state: launchState, message }) });
    const task = await f.send('/dispatch Review startup');
    f.publish({ agents: [f.agent(task, 'blocked')] }); f.model.action('details');
    for (const [width, height] of [[119, 39], [39, 14]]) {
      f.model.action('detail-position', 0);
      let screens = '';
      for (let scroll = 0; scroll < 30; scroll += 1) {
        const screen = stripVTControlCharacters(renderToString(React.createElement(TuiView, { state: f.model.getSnapshot(), model: f.model, width, height })));
        assert(screen.split('\n').length <= height); assert(screen.split('\n').every(line => displayWidth(line) <= width));
        screens += screen + '\n';
        if (screens.includes('Startup: ' + message)) break;
        f.model.key('', { downArrow: true });
      }
      assert.match(screens, /Needs you/); assert(screens.includes('Startup: ' + message));
      assert.doesNotMatch(screens, /Launch:|\b(?:needs_input|uncertain|submitted)\b/);
    }
    assert.equal(f.model.getTasks()[0].launch.state, launchState);
    assert.equal(f.model.getTasks()[0].launch.message, message);
  }
});
