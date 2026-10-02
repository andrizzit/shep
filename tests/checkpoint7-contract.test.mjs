import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProgressEvent } from '../src/dispatch/contracts.mjs';
import { createTask, transition } from '../src/tasks.mjs';
import { makeProject } from './helpers/dispatch-fakes.mjs';

const at = '2026-10-02T12:00:00.000Z';
const target = { paneId: 'pane', terminalId: 'terminal', provider: 'codex', agentName: 'task-agent' };
const event = { taskId: 'task', attemptId: 'attempt', stage: 'start', at, target, delivery: 'launch' };
function task() {
  const project = makeProject();
  return createTask({ kind: 'dispatch', agents: [{ provider: 'codex', profile: null }], project, mode: 'auto', modeIntent: 'auto', subfolder: '',
    template: null, task: 'Reply with OK', inputTask: 'Reply with OK', command: '/dispatch Reply with OK' },
  { id: 'task', attemptId: 'attempt', at, name: 'task-agent', placement: { projectKey: project.key, root: project.root, mode: 'auto', subfolder: '', label: 'Reply with OK', placementStyle: 'tab' } });
}

test('change005 accepts legacy progress and validates early identity/delivery only at start', () => {
  assert.deepEqual(validateProgressEvent(event), []);
  assert.deepEqual(validateProgressEvent({ taskId: 'task', attemptId: 'attempt', stage: 'start', at }), []);
  for (const stage of ['queued', 'target', 'prompt']) {
    assert(validateProgressEvent({ ...event, stage }).length);
    assert(validateProgressEvent({ taskId: 'task', attemptId: 'attempt', at, stage, delivery: 'launch' }).length);
  }
  for (const field of Object.keys(target)) {
    const incomplete = { ...target }; delete incomplete[field];
    assert(validateProgressEvent({ ...event, target: incomplete }).length, field);
    assert(validateProgressEvent({ ...event, target: { ...target, [field]: '' } }).length, field);
  }
  assert(validateProgressEvent({ ...event, target: { ...target, provider: 'unverified' } }).length);
  assert(validateProgressEvent({ ...event, target: { ...target, agentName: 'INVALID NAME' } }).length);
  assert(validateProgressEvent({ ...event, delivery: 'repeat' }).length);
});

test('early focus target must match task, attempt, provider and name without granting cleanup ownership', () => {
  const pending = transition(task(), { type: 'progress', event });
  assert.deepEqual(pending.target, target); assert.equal(pending.launch.delivery, 'launch');
  assert.equal(pending.launch.state, 'starting'); assert.equal(pending.created, null); assert.equal(pending.placement, null);
  assert.equal(pending.live.status, null);
  for (const patch of [{ taskId: 'wrong' }, { attemptId: 'wrong' }, { target: { ...target, provider: 'claude' } }, { target: { ...target, agentName: 'wrong' } }]) {
    assert.throws(() => transition(task(), { type: 'progress', event: { ...event, ...patch } }));
  }
  for (const field of ['paneId', 'terminalId']) assert.throws(() => transition(pending, { type: 'progress', event: { ...event, target: { ...target, [field]: 'replacement' } } }));
});

test('final outcomes preserve observed session identity and cannot replace an early target or route', () => {
  const pending = transition(task(), { type: 'progress', event }); pending.target.sessionId = 'session-a'; pending.observedActivity = true;
  const outcome = { taskId: 'task', attemptId: 'attempt', ok: true, state: 'submitted', message: 'Opened.', paneId: 'pane', terminalId: 'terminal', agentName: 'task-agent', delivery: 'launch' };
  const finished = transition(pending, { type: 'outcome', outcome });
  assert.equal(finished.target.sessionId, 'session-a'); assert.equal(finished.observedActivity, true);
  for (const patch of [{ paneId: 'replacement' }, { terminalId: 'replacement' }, { agentName: 'replacement' }, { delivery: 'type' }]) {
    assert.throws(() => transition(pending, { type: 'outcome', outcome: { ...outcome, ...patch } }));
  }
  assert.equal(pending.launch.state, 'starting'); assert.equal(pending.target.terminalId, 'terminal');
});
