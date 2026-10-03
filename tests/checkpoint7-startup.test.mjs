import test from 'node:test';
import assert from 'node:assert/strict';
import { createTuiModel, agentPresentation, visibleAgents } from '../src/tui-model.mjs';
import { taskRows, taskPresentation, TASK_LABELS } from '../src/tui-tasks.mjs';
import { createNotifier } from '../src/notify.mjs';
import { DEFAULT_CONFIG } from '../src/dispatch/contracts.mjs';
import { createFakeRegistry, deferred, makeProject } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const project = makeProject();
async function fixture(t, dispatch, { early = false } = {}) {
  let clock = 1000, sequence = 0;
  let snapshot = { mode: 'live', updatedAt: new Date(clock).toISOString(), source: { state: 'connected' }, agents: [] };
  const listeners = new Set(), calls = [], notifications = [], panes = [];
  const monitor = { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const controller = {
    getProfiles: async () => ({ providers: ['codex', 'claude', 'kiro'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), available: true })),
      workspaces: [], defaultCwd: project.root, ownPaneId: 'own', ownTerminalId: 'own-terminal' }),
    getControlSnapshot: async () => ({ panes: [...panes], agents: [], workspaces: [], tabs: [] }),
    focus: async target => { calls.push({ method: 'focus', target }); return { ok: true, state: 'focused', message: 'Focused.' }; },
    notify: async value => { notifications.push(value); },
    dispatch: async (request, hooks) => {
      calls.push({ method: 'dispatch', request });
      const number = ++sequence;
      panes.push({ pane_id: `pane-${number}`, terminal_id: `terminal-${number}` });
      await hooks.onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'start', at: new Date(clock).toISOString(),
        ...(early ? { delivery: 'launch', target: { paneId: `pane-${number}`, terminalId: `terminal-${number}`, provider: request.provider, agentName: request.name } } : {}) });
      const outcome = dispatch ? await dispatch(request, number, hooks) : { state: 'submitted', ok: true, delivery: 'launch', message: 'Opened.' };
      return { taskId: request.taskId, attemptId: request.attemptId, paneId: `pane-${number}`, terminalId: `terminal-${number}`, agentName: request.name, ...outcome };
    },
  };
  const model = createTuiModel({ monitor, controller, registry: createFakeRegistry(), now: () => clock });
  await model.ready;
  const notifier = createNotifier({ monitor, controller, config: structuredClone(DEFAULT_CONFIG), getTasks: model.getTasks, now: () => clock });
  const destroy = () => { notifier.dispose(); model.destroy(); };
  t.after(destroy);
  const publish = (agents, advance = 0, patch = {}) => {
    clock += advance; snapshot = { ...snapshot, agents, updatedAt: new Date(clock).toISOString(), ...patch };
    for (const listener of listeners) listener(snapshot);
  };
  const send = async text => { model.paste(text); model.key('', { return: true }); await tick(); return model.getTasks().at(-1); };
  const agent = (task, status = 'idle', patch = {}) => ({ id: task.target?.terminalId, ...task.target, provider: task.agent.provider,
    name: task.name, agentName: task.name, status, focused: false, workspace: { path: project.root }, ...patch });
  return { model, monitor, controller, calls, notifications, publish, send, agent, destroy };
}
const label = f => TASK_LABELS[taskPresentation(taskRows(f.model.getSnapshot())[0])];

test('Codex idle/ready startup metadata needs the owner, then alerts once after five seconds', async t => {
  const f = await fixture(t), task = await f.send('/dispatch codex: Reply with OK');
  const agent = f.agent(task, 'idle', { interactiveReady: true });
  f.publish([agent]);
  assert.equal(label(f), 'Needs you'); assert.equal(agentPresentation(f.model.getSnapshot(), agent), 'blocked');
  assert.match(f.model.getSnapshot().notice.message, /^Codex opened in shep · check its pane$/);
  assert.doesNotMatch(f.model.getSnapshot().notice.message, /started/);
  assert.equal(f.notifications.length, 0);
  f.publish([agent], 4999); assert.equal(f.notifications.length, 0);
  f.publish([agent], 1); assert.equal(f.notifications.length, 1); assert.match(f.notifications[0].title, /Needs you/);
  f.publish([agent], 31000); assert.equal(f.notifications.length, 1, 'Continuous startup idle does not repeat');
  agent.status = 'working'; f.publish([agent]); assert.equal(label(f), 'Working');
  agent.status = 'idle'; f.publish([agent]); assert.equal(label(f), 'Done');
  assert.equal(f.model.getTasks()[0].observedActivity, true);
  assert.equal(f.notifications.filter(value => value.sound === 'request').length, 1);
  assert.equal(f.notifications.filter(value => value.sound === 'done').length, 1);
});

test('matching startup activity, replacement, focus, stale metadata and quit cannot trigger a spurious delayed alert', async t => {
  for (const stop of ['working', 'done', 'replacement', 'focus', 'stale', 'quit']) {
    const f = await fixture(t), task = await f.send('/dispatch Reply with OK'), agent = f.agent(task);
    f.publish([agent]); f.publish([agent], 4999);
    if (stop === 'working' || stop === 'done') agent.status = stop;
    else if (stop === 'replacement') agent.agentName = agent.name = 'other-agent';
    else if (stop === 'focus') agent.focused = true;
    else if (stop === 'stale') { f.publish([agent], 0, { source: { state: 'disconnected' } }); }
    else f.destroy();
    f.publish([agent], 1);
    assert.equal(f.notifications.filter(value => value.sound === 'request').length, 0, stop);
    if (stop === 'focus') { agent.focused = false; f.publish([agent], 1000); assert.equal(f.notifications.length, 0); }
    if (stop === 'stale') {
      f.publish([agent], 10000, { source: { state: 'connected' } }); assert.equal(f.notifications.length, 0);
      f.publish([agent], 5000); assert.equal(f.notifications.length, 1);
    }
  }
});

test('return to the selected Starting row is immediate and late outcomes preserve a newer editor and selection', async t => {
  const gates = [deferred(), deferred()];
  const f = await fixture(t, (_request, number) => gates[number - 1].promise);
  const before = performance.now();
  f.model.paste('/dispatch First literal task'); f.model.key('', { return: true }); f.model.key('', { return: true });
  assert.equal(f.model.getSnapshot().view, 'board'); assert.equal(label(f), 'Starting');
  assert(performance.now() - before < 1000); await tick();
  assert.equal(f.calls.filter(call => call.method === 'dispatch').length, 1);
  assert.equal(f.model.getSnapshot().busy, null);
  await f.send('/dispatch Second literal task');
  assert.equal(f.calls.filter(call => call.method === 'dispatch').length, 2);
  const second = f.model.getTasks()[1]; assert.equal(f.model.getSnapshot().selectedTaskId, `task:${second.id}`);
  f.model.action('new'); f.model.action('field', 'prompt'); f.model.paste(' A newer draft');
  const owner = f.model.getSnapshot();
  gates[0].resolve({ ok: true, state: 'submitted', delivery: 'launch', message: 'First opened.' }); await tick();
  assert.equal(f.model.getSnapshot().view, owner.view); assert.equal(f.model.getSnapshot().selectedTaskId, owner.selectedTaskId);
  assert.deepEqual(f.model.getSnapshot().draft, owner.draft); assert.equal(f.model.getSnapshot().command, owner.command);
  gates[1].resolve({ ok: false, state: 'needs_input', delivery: 'launch', message: 'Needs you.' }); await tick();
  assert.equal(f.model.getSnapshot().view, owner.view); assert.deepEqual(f.model.getSnapshot().draft, owner.draft);
  assert.equal(f.calls.filter(call => call.method === 'dispatch').length, 2);
});

test('startup Needs you clears the original draft, while typed Needs you preserves its literal text', async t => {
  for (const delivery of ['launch', 'type']) {
    const f = await fixture(t, () => ({ ok: false, state: 'needs_input', delivery, message: 'Check the pane.' }));
    const command = '/dispatch Reply with OK'; await f.send(command);
    assert.equal(f.model.getSnapshot().view, 'board');
    assert.equal(f.model.getSnapshot().command, delivery === 'launch' ? '' : command);
    assert.equal(f.model.getSnapshot().draft.prompt, delivery === 'launch' ? '' : 'Reply with OK');
    assert.equal(f.calls.filter(call => call.method === 'dispatch').length, 1);
  }
});

test('a failure before a pane exists stays on the board and retains the task in recall', async t => {
  const f = await fixture(t, () => ({ ok: false, state: 'failed', code: 'unavailable_provider', message: 'Unavailable.', paneId: undefined, terminalId: undefined }));
  await f.send('/dispatch Preserve the failed task');
  assert.equal(f.model.getSnapshot().view, 'board');
  f.model.key('/'); f.model.key('', { upArrow: true });
  assert.match(f.model.getSnapshot().recall.at(-1), /Preserve the failed task/);
  assert.equal(f.calls.filter(call => call.method === 'dispatch').length, 1);
});

test('owned idle startup rows sort and filter as attention in both task and agent views', async t => {
  const f = await fixture(t), first = await f.send('/dispatch First task'), second = await f.send('/dispatch Second task');
  const attention = f.agent(first), done = f.agent(second, 'done'); f.publish([done, attention]);
  assert.equal(taskRows(f.model.getSnapshot())[0].task.id, first.id);
  assert.equal(visibleAgents(f.model.getSnapshot())[0].paneId, attention.paneId);
  const state = { ...f.model.getSnapshot(), filter: 'blocked' };
  assert.equal(taskRows(state).length, 1); assert.equal(visibleAgents(state).length, 1);
  assert.equal(taskRows(state)[0].task.id, first.id); assert.equal(visibleAgents(state)[0].paneId, attention.paneId);
});

test('pending start binds its exact target for Enter, captures only matching session activity and preserves it at completion', async t => {
  const pending = deferred(), f = await fixture(t, () => pending.promise, { early: true });
  const task = await f.send('/dispatch Reply with OK');
  assert.equal(task.launch.state, 'starting'); assert.equal(task.launch.delivery, 'launch');
  assert.equal(task.target.paneId, 'pane-1'); assert.equal(task.created, null, 'Early focus metadata never grants cleanup ownership');
  assert.equal(f.model.getSnapshot().draft.prompt, ''); assert.equal(f.model.getSnapshot().command, '');
  f.model.key('', { return: true }); await tick();
  assert.equal(f.calls.filter(call => call.method === 'focus').length, 1);
  assert.equal(f.calls.find(call => call.method === 'focus').target.terminalId, 'terminal-1');
  assert.equal(f.calls.filter(call => call.method === 'dispatch').length, 1);
  const original = f.agent(task, 'idle', { sessionId: 'session-a' }); f.publish([original]);
  assert.equal(f.model.getTasks()[0].target.sessionId, undefined);
  f.publish([{ ...original, status: 'working', sessionId: 'session-b' }]);
  assert.equal(f.model.getTasks()[0].observedActivity, true);
  original.status = 'working'; f.publish([original]);
  assert.equal(f.model.getTasks()[0].observedActivity, true);
  assert.equal(f.model.getTasks()[0].live.status, null, 'Pending metadata does not broaden frozen live-state transitions');
  pending.resolve({ ok: true, state: 'submitted', delivery: 'launch', message: 'Opened.' }); await tick();
  assert.equal(f.model.getTasks()[0].target.sessionId, undefined);
  original.status = 'idle'; f.publish([original]); assert.equal(label(f), 'Done');
  assert.equal(f.notifications.filter(value => value.sound === 'request').length, 0);
});

test('a late repository-trust question stays on its row until the owner opens it', async t => {
  const pending = deferred(), f = await fixture(t, () => pending.promise);
  const task = await f.send('/dispatch codex+wt: Reply with OK');
  f.model.action('new'); f.model.action('field', 'prompt'); f.model.paste(' A different draft');
  const before = f.model.getSnapshot();
  pending.resolve({ ok: false, state: 'needs_confirmation', message: 'Confirm repository trust.', paneId: undefined, terminalId: undefined }); await tick();
  assert.equal(f.model.getSnapshot().view, 'compose'); assert.equal(f.model.getSnapshot().decision, null);
  assert.deepEqual(f.model.getSnapshot().draft, before.draft);
  f.model.action('cancel'); f.model.action('select-task', `task:${task.id}`); f.model.key('', { return: true });
  assert.equal(f.model.getSnapshot().view, 'decision'); assert.equal(f.model.getSnapshot().decision.root, project.root);
  assert.equal(f.calls.filter(call => call.method === 'dispatch').length, 1);
});
