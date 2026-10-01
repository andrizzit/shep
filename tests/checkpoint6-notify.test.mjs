import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/notify.mjs';
import { DEFAULT_CONFIG } from '../src/dispatch/contracts.mjs';

function fixture() {
  const calls = [], agent = { paneId: 'pane', terminalId: 'terminal', provider: 'codex', agentName: 'task-agent', status: 'idle', focused: false };
  const task = { id: 'task', target: null, project: { name: 'Project' }, agent: { provider: 'codex' },
    intent: { label: 'Reply with OK' }, launch: { state: 'starting', message: '' } };
  const snapshot = { mode: 'live', source: { state: 'connected' }, agents: [] };
  let publish, time = 0;
  const notifier = createNotifier({ monitor: { getSnapshot: () => snapshot, subscribe: listener => { publish = listener; return () => {}; } },
    controller: { notify: request => calls.push(request) }, config: structuredClone(DEFAULT_CONFIG), getTasks: () => [task], now: () => time });
  return { calls, task, snapshot, agent, notifier, tick: () => publish(snapshot), advance: () => { time += 31000; },
    bind: launch => { task.target = { paneId: agent.paneId, terminalId: agent.terminalId, provider: agent.provider, agentName: agent.agentName }; task.launch = launch; snapshot.agents = [agent]; } };
}

for (const launch of [{ state: 'needs_input', message: 'Check the pane to finish startup.' },
  { state: 'uncertain', code: 'agent_prompt_stalled', message: 'Prompt not picked up. Check the pane.' }]) {
  test(`${launch.state}: outcome and delayed blocked metadata emit one Needs you notification`, () => {
    for (const metadataMissing of [false, true]) {
      const f = fixture(); f.bind(launch);
      if (metadataMissing) f.snapshot.agents = [];
      f.tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].title, '⚠ Project · Codex · Needs you');
      assert.equal(f.calls[0].body, launch.message); assert.equal(f.calls[0].sound, 'request');
      f.advance(); f.snapshot.agents = [f.agent]; f.agent.status = 'blocked'; f.tick(); f.tick();
      assert.equal(f.calls.length, 1, 'A late blocked update is the same attention episode, even after the dedupe interval');
      f.agent.status = 'working'; f.tick(); f.advance(); f.agent.status = 'blocked'; f.tick(); f.tick();
      assert.equal(f.calls.length, 2, 'New work followed by another blocked state is a new attention episode');
      assert.equal(f.calls[1].title, f.calls[0].title); f.notifier.dispose();
    }
  });
}

test('blocked-at-launch uses the same Needs you title once and keeps the existing 30-second dedupe', () => {
  const f = fixture(); f.bind({ state: 'submitted', message: 'Agent started with its task.' });
  f.agent.status = 'blocked'; f.tick(); f.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].title, '⚠ Project · Codex · Needs you'); assert.equal(f.calls[0].body, 'Reply with OK');
  f.agent.status = 'working'; f.tick(); f.agent.status = 'blocked'; f.tick(); assert.equal(f.calls.length, 1);
  f.advance(); f.agent.status = 'working'; f.tick(); f.agent.status = 'blocked'; f.tick(); assert.equal(f.calls.length, 2);
  f.notifier.dispose();
});

test('unchanged launch attention does not re-arm after work settles to idle', () => {
  for (const launch of [{ state: 'needs_input', message: 'Review setup' },
    { state: 'uncertain', code: 'agent_prompt_stalled', message: 'Check the pane' }]) {
    const f = fixture(); f.bind(launch); f.tick();
    assert.equal(f.calls.filter(call => call.sound === 'request').length, 1);
    f.agent.status = 'working'; f.tick(); f.agent.status = 'idle'; f.tick();
    assert.equal(f.calls.filter(call => call.sound === 'done').length, 1);
    f.advance(); f.agent.status = 'blocked'; f.tick(); f.tick();
    assert.equal(f.calls.filter(call => call.sound === 'request').length, 2, 'A later blocked state remains visible despite an unchanged historical launch outcome');
    f.notifier.dispose();
  }
});

test('a real launch-path uncertain task outcome retains delivery and alerts once without changing legacy uncertainty', async () => {
  const { createTask, transition } = await import('../src/tasks.mjs');
  const { makeProject } = await import('./helpers/dispatch-fakes.mjs');
  for (const delivery of ['launch', 'type', undefined]) for (const status of ['idle', 'unknown']) {
    const f = fixture();
    const project = makeProject({ name: 'Project' }), at = '2026-09-30T12:00:00.000Z';
    const spec = { kind: 'dispatch', agents: [{ provider: 'codex', profile: null }], project, mode: 'auto', modeIntent: 'auto',
      subfolder: '', template: null, task: 'Reply with OK', inputTask: 'Reply with OK', command: '/dispatch Reply with OK' };
    const task = createTask(spec, { id: f.task.id, attemptId: 'attempt', at, name: f.agent.agentName,
      placement: { projectKey: project.key, root: project.root, mode: 'auto', subfolder: '', label: 'Reply with OK', placementStyle: 'tab' } });
    Object.assign(f.task, transition(task, { type: 'progress', event: { taskId: task.id, attemptId: task.attemptId, stage: 'start', at } }));
    const outcome = { ok: false, state: 'uncertain', code: 'timeout', message: 'Check the preserved pane.',
      taskId: f.task.id, attemptId: f.task.attemptId, paneId: f.agent.paneId, terminalId: f.agent.terminalId,
      agentName: f.agent.agentName, ...(delivery ? { delivery } : {}) };
    Object.assign(f.task, transition(f.task, { type: 'outcome', outcome }));
    assert.equal(f.task.launch.delivery, delivery); assert.equal(Object.hasOwn(f.task.launch, 'delivery'), delivery !== undefined);
    f.agent.status = status; f.snapshot.agents = [f.agent]; f.tick(); f.tick();
    assert.equal(f.calls.length, delivery === 'launch' ? 1 : 0, `${delivery}/${status}`);
    if (delivery === 'launch') {
      assert.equal(f.calls[0].title, '⚠ Project · Codex · Needs you'); assert.equal(f.calls[0].body, outcome.message);
      f.advance(); f.agent.status = 'blocked'; f.tick(); assert.equal(f.calls.length, 1, 'Late blocked metadata is still the initial uncertainty episode');
      f.agent.status = 'working'; f.tick(); f.agent.status = 'idle'; f.tick();
      assert.equal(f.calls.filter(call => call.sound === 'done').length, 1);
      f.advance(); f.agent.status = 'blocked'; f.tick(); assert.equal(f.calls.filter(call => call.sound === 'request').length, 2);
    }
    f.notifier.dispose();
  }
});
