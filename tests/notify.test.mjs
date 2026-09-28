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
