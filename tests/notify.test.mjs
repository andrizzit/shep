import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/notify.mjs';
import { DEFAULT_CONFIG } from '../src/dispatch/contracts.mjs';
function fixture(settings = {}, initialStatus = 'working') {
  let listener, time = 1000;
  const calls = [], config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.notifications, settings);
  const task = { id: 'task', target: { paneId: 'pane', terminalId: 'terminal' }, project: { name: 'project' }, agent: { provider: 'codex' },
    intent: { label: 'Review changes' }, launch: { state: 'starting', message: '' } };
  const snapshot = { mode: 'live', source: { state: 'connected' }, agents: [{ paneId: 'pane', terminalId: 'terminal', status: initialStatus, focused: false }] };
  const notifier = createNotifier({ monitor: { getSnapshot: () => snapshot, subscribe: fn => { listener = fn; return () => { listener = null; }; } },
    controller: { notify: request => { calls.push(request); return Promise.resolve(); } }, config, getTasks: () => [task], now: () => time });
  return { snapshot, task, calls, config, notifier, tick: () => listener?.(snapshot), advance: () => { time += 30000; } };
}
test('notifier uses startup baseline, transitions, focused suppression and 30s dedupe', () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  f.snapshot.agents[0].status = 'done'; f.tick(); assert.equal(f.calls[0].sound, 'done');
  f.snapshot.agents[0].status = 'working'; f.tick(); f.snapshot.agents[0].status = 'idle'; f.tick(); assert.equal(f.calls.length, 1);
  f.advance(); f.snapshot.agents[0].status = 'working'; f.tick(); f.snapshot.agents[0].status = 'idle'; f.tick(); assert.equal(f.calls.length, 2);
  f.snapshot.agents[0].focused = true; f.snapshot.agents[0].status = 'blocked'; f.tick(); assert.equal(f.calls.length, 2);
  f.snapshot.agents[0].focused = false; f.snapshot.agents[0].status = 'working'; f.tick(); f.snapshot.agents[0].status = 'blocked'; f.tick(); assert.equal(f.calls[2].sound, 'request');
  f.notifier.dispose(); f.tick(); assert.equal(f.calls.length, 3);
});
test('startup setup, disabled notifications/sounds and external opt-in remain explicit', () => {
  const f = fixture({ sound: false }); f.task.launch = { state: 'needs_input', message: 'Review setup' }; f.tick();
  assert.equal(f.calls[0].sound, 'none'); assert.match(f.calls[0].title, /needs setup/);
  f.config.notifications.enabled = false; f.snapshot.agents[0].status = 'blocked'; f.tick(); assert.equal(f.calls.length, 1);
  const g = fixture(); const external = { paneId: 'other', terminalId: 'other', provider: 'claude', name: 'External', status: 'working', workspace: { name: 'Elsewhere' } };
  g.snapshot.agents.push(external); g.tick(); external.status = 'done'; g.tick(); assert.equal(g.calls.length, 0);
  g.config.notifications.external = true; external.status = 'working'; g.tick(); external.status = 'done'; g.tick(); assert.equal(g.calls.length, 1);
});

test('startup outcome gains its pane identity after starting and still emits one setup notice', () => {
  const f = fixture(); f.task.target = null; f.tick();
  f.task.target = { paneId: 'pane', terminalId: 'terminal' }; f.task.launch = { state: 'needs_input', message: 'Review trust in pane' };
  f.tick(); f.tick(); assert.equal(f.calls.length, 1); assert.match(f.calls[0].title, /needs setup/);
});

test('new task binds its submitted outcome after a fast done completion between monitor polls', () => {
  for (const status of ['done']) {
    const f = fixture(); f.task.target = null; f.tick();
    // A controller outcome is the first event carrying target identity. Progress
    // events only supply task/attempt IDs and stage, so starting has no target.
    const outcome = { ok: true, state: 'submitted', paneId: 'new-pane', terminalId: 'new-terminal', message: 'Prompt submitted.' };
    f.task.target = { paneId: outcome.paneId, terminalId: outcome.terminalId }; f.task.launch = outcome;
    f.snapshot.agents = [{ paneId: outcome.paneId, terminalId: outcome.terminalId, status, focused: false }];
    f.tick(); f.tick(); assert.equal(f.calls.length, 1); assert.match(f.calls[0].title, /finished/);
  }
});

test('first submitted idle is silent until actual working or unknown status is observed on that target', () => {
  for (const observedStatus of ['working', 'unknown']) {
    const f = fixture(); f.task.target = null; f.tick();
    const outcome = { ok: true, state: 'submitted', paneId: 'new-pane', terminalId: 'new-terminal', message: 'Prompt submitted.' };
    f.task.target = { paneId: outcome.paneId, terminalId: outcome.terminalId }; f.task.launch = outcome;
    const agent = { paneId: outcome.paneId, terminalId: outcome.terminalId, status: 'idle', focused: false };
    f.snapshot.agents = [agent]; f.tick(); f.tick();
    assert.equal(f.calls.length, 0, 'A newly bound idle agent may not have begun the submitted task');
    agent.status = observedStatus; f.tick(); agent.status = 'idle'; f.tick();
    assert.equal(f.calls.length, 1); assert.match(f.calls[0].title, /finished/);
  }
});

test('missing agent metadata is not observed unknown execution evidence', () => {
  const f = fixture(); f.task.target = null; f.tick();
  f.task.target = { paneId: 'new-pane', terminalId: 'new-terminal' };
  f.task.launch = { state: 'submitted', message: 'Prompt submitted.' };
  f.snapshot.agents = []; f.tick();
  f.snapshot.agents = [{ paneId: 'new-pane', terminalId: 'new-terminal', status: 'idle', focused: false }];
  f.tick(); assert.equal(f.calls.length, 0);
});

test('initial global done and idle snapshots remain silent', () => {
  for (const status of ['done', 'idle']) {
    const f = fixture({}, status); f.task.launch = { state: 'submitted', message: 'Already submitted' };
    f.tick(); f.tick(); assert.equal(f.calls.length, 0);
  }
});

for (const field of ['provider', 'agentName', 'sessionId']) test(`same-terminal replacement with changed or missing ${field} cannot notify an obsolete task`, () => {
  for (const status of ['done', 'idle', 'blocked']) for (const missing of [false, true]) {
    const f = fixture();
    Object.assign(f.task.target, { provider: 'codex', agentName: 'original-agent', sessionId: 'original-session' });
    Object.assign(f.snapshot.agents[0], { provider: 'codex', agentName: 'original-agent', name: 'original-agent', sessionId: 'original-session' });
    f.tick();
    const replacement = f.snapshot.agents[0]; replacement.status = status;
    if (missing) delete replacement[field]; else replacement[field] = 'replacement';
    if (field === 'agentName') { if (missing) delete replacement.name; else replacement.name = 'replacement'; }
    f.tick(); f.tick();
    assert.equal(f.calls.length, 0, `${field}/${status}/${missing ? 'missing' : 'changed'}`);
    f.task.launch = { state: 'needs_input', message: 'Obsolete startup outcome' };
    f.tick(); assert.equal(f.calls.length, 0, 'An obsolete setup outcome cannot alert for the replacement');
    f.notifier.dispose();
  }
});

test('agentName fallback matches the task model and known session identity still gates notifications', () => {
  const f = fixture();
  Object.assign(f.task.target, { provider: 'codex', agentName: 'review-agent', sessionId: 'known-session' });
  Object.assign(f.snapshot.agents[0], { provider: 'codex', name: 'review-agent', agentName: null, sessionId: 'known-session' });
  f.tick(); f.snapshot.agents[0].status = 'done'; f.tick();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].title, /finished/);
});

test('opt-in external replacement establishes its own baseline instead of inheriting prior agent execution', () => {
  const f = fixture({ external: true });
  const agent = { paneId: 'external-pane', terminalId: 'external-terminal', provider: 'claude', name: 'first',
    agentName: 'first', sessionId: 'first-session', status: 'working', workspace: { name: 'Elsewhere' } };
  f.snapshot.agents.push(agent); f.tick();
  Object.assign(agent, { provider: 'codex', name: 'second', agentName: 'second', sessionId: 'second-session', status: 'done' });
  f.tick(); assert.equal(f.calls.length, 0);
  agent.status = 'working'; f.tick(); agent.status = 'idle'; f.tick();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].title, /Elsewhere · Codex finished/);
});

test('real task outcomes retain conservative notifications regardless of snapshot/outcome arrival order', async () => {
  const { createTask, transition } = await import('../src/tasks.mjs');
  const { makeProject } = await import('./helpers/dispatch-fakes.mjs');
  const at = '2026-09-27T12:00:00.000Z';
  for (const snapshotFirst of [true, false]) for (const [state, status, expected] of [
    ['submitted', 'done', 1], ['submitted', 'idle', 0], ['needs_input', 'blocked', 1],
  ]) {
    const project = makeProject();
    const spec = { kind: 'dispatch', agents: [{ provider: 'codex', profile: null }], project, mode: 'auto', modeIntent: 'auto',
      subfolder: '', template: null, task: 'Review code', inputTask: 'Review code', command: '/dispatch Review code' };
    const placement = { projectKey: project.key, root: project.root, mode: 'auto', subfolder: '', label: 'Review code', placementStyle: 'tab' };
    let task = createTask(spec, { id: 'review', attemptId: 'attempt', at, name: 'review-codex', placement });
    const snapshot = { mode: 'live', source: { state: 'connected' }, agents: [] }, calls = [];
    let publish;
    const notifier = createNotifier({ monitor: { getSnapshot: () => snapshot, subscribe: listener => { publish = listener; return () => {}; } },
      controller: { notify: request => { calls.push(request); } }, config: DEFAULT_CONFIG, getTasks: () => [task] });
    task = transition(task, { type: 'progress', event: { taskId: task.id, attemptId: task.attemptId, stage: 'target', at } });
    assert.equal(task.target, null); publish(snapshot);
    const agent = { paneId: 'w1:p2', terminalId: 'new-terminal', provider: 'codex', name: task.name, agentName: task.name, status, focused: false };
    const outcome = { ok: state === 'submitted', state, message: state, taskId: task.id, attemptId: task.attemptId,
      paneId: agent.paneId, terminalId: agent.terminalId, agentName: task.name };
    if (snapshotFirst) { snapshot.agents = [agent]; publish(snapshot); }
    task = transition(task, { type: 'outcome', outcome }); publish(snapshot);
    if (!snapshotFirst) { snapshot.agents = [agent]; publish(snapshot); }
    publish(snapshot); assert.equal(calls.length, expected, `${state}/${status}/snapshotFirst=${snapshotFirst}`);
    // The same terminal can host a replacement CLI. Its later status must not
    // be attributed to the task whose target came from the genuine outcome.
    agent.provider = 'claude'; agent.status = 'done'; publish(snapshot);
    agent.status = 'blocked'; publish(snapshot);
    assert.equal(calls.length, expected, 'Replacement status is not the original task’s status');
    notifier.dispose();
  }
});
