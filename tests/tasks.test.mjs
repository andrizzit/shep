import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, transition, displayState, groupTasks } from '../src/tasks.mjs';
import { LAUNCH_TRANSITIONS, LAUNCH_OUTCOMES } from '../src/dispatch/contracts.mjs';
import { makeProject } from './helpers/dispatch-fakes.mjs';

const at = '2026-09-27T12:00:00.000Z', project = makeProject();
const spec = { kind: 'dispatch', agents: [{ provider: 'codex', profile: null }], project, mode: 'auto', modeIntent: 'auto', subfolder: '', template: null, task: 'Do thing', inputTask: 'Do thing', command: '/dispatch Do thing' };
const placement = { projectKey: project.key, root: project.root, mode: 'auto', subfolder: '', label: 'Do thing', placementStyle: 'tab' };
const fresh = (id = 'one') => createTask(spec, { id, attemptId: `${id}-attempt`, at, name: 'do-thing-codex', placement });
const outcome = (task, state, extra = {}) => ({ taskId: task.id, attemptId: task.attemptId, ok: state === 'submitted', state, message: state, ...extra });
const start = task => transition(task, { type: 'progress', event: { taskId: task.id, attemptId: task.attemptId, stage: 'target', at } });
const submitted = () => { const task = start(fresh()); return transition(task, { type: 'outcome', outcome: outcome(task, 'submitted', { paneId: 'w1:p2', terminalId: 'term2' }) }); };

test('all outcome state pairs follow the frozen transition table and preserve originals', () => {
  for (const state of Object.keys(LAUNCH_TRANSITIONS)) for (const next of LAUNCH_OUTCOMES) {
    const task = fresh(); task.launch.state = state; const original = structuredClone(task);
    const apply = () => transition(task, { type: 'outcome', outcome: outcome(task, next) });
    if (LAUNCH_TRANSITIONS[state].includes(next)) assert.equal(apply().launch.state, next, `${state}→${next}`);
    else assert.throws(apply, /transition/, `${state}→${next}`);
    assert.deepEqual(task, original);
  }
});
test('progress is correlated, ordered, and trust alone creates a fresh attempt', () => {
  let task = start(fresh());
  assert.throws(() => transition(task, { type: 'progress', event: { taskId: task.id, attemptId: 'stale', stage: 'start', at } }), /different/);
  assert.throws(() => transition(task, { type: 'progress', event: { taskId: task.id, attemptId: task.attemptId, stage: 'queued', at } }), /backwards/);
  task = transition(task, { type: 'outcome', outcome: outcome(task, 'needs_confirmation') });
  const prior = task.attemptId;
  task = transition(task, { type: 'confirmation', approved: true, attemptId: 'second-attempt', at });
  assert.equal(task.launch.state, 'starting'); assert.equal(task.attemptId, 'second-attempt');
  assert.throws(() => transition(task, { type: 'outcome', outcome: { ...outcome(task, 'submitted'), attemptId: prior } }), /different/);
  assert.throws(() => transition(submitted(), { type: 'confirmation', approved: true, attemptId: 'illegal', at }), /confirmation/);
});
test('live status and follow-up do not rewrite launch certainty or retain follow-up text', () => {
  let task = submitted(); assert.equal(displayState(task), 'unknown');
  const launch = structuredClone(task.launch);
  for (const status of ['working', 'blocked', 'done', 'idle', 'unknown']) {
    task = transition(task, { type: 'live', status, since: at, paneId: 'w1:p2', terminalId: 'term2' });
    assert.equal(displayState(task), status); assert.deepEqual(task.launch, launch);
  }
  assert.throws(() => transition(task, { type: 'live', status: 'closed', since: at, paneId: 'w1:p2', terminalId: 'reused' }), /match/);
  task = transition(task, { type: 'follow-up', at, text: 'DO NOT STORE', outcome: { ok: true, state: 'submitted', message: 'sent', paneId: 'w1:p2', terminalId: 'term2' } });
  assert.deepEqual(task.followUp, { count: 1, lastAt: at }); assert.ok(!JSON.stringify(task).includes('DO NOT STORE'));
  task = transition(task, { type: 'live', status: 'closed', since: at, paneId: 'w1:p2', terminalId: 'term2' });
  assert.equal(displayState(task), 'closed'); assert.deepEqual(task.launch, launch);
  assert.throws(() => transition(task, { type: 'live', status: 'working', since: at, paneId: 'w1:p2', terminalId: 'term2' }), /match/);
});
test('task groups avoid duplicates, rank active projects/states, and expose stable external rows', () => {
  const tracked = submitted(), queued = fresh('two');
  const agents = [{ id: 'a1', provider: 'codex', name: tracked.name, paneId: 'w1:p2', terminalId: 'term2', status: 'working', workspace: { path: project.root } },
    { id: 'a2', provider: 'claude', name: 'outside', paneId: 'w2:p1', terminalId: 'term3', status: 'idle', workspace: { path: '/elsewhere' } }];
  const groups = groupTasks([tracked, queued], agents, [project], { now: Date.parse(at) + 5000 });
  assert.equal(groups.length, 2); assert.equal(groups[0].key, project.key);
  assert.deepEqual(groups[0].rows.map(row => row.status), ['working', 'queued']);
  assert.equal(groups[0].rows[0].id, 'task:one'); assert.equal(groups[0].rows[0].elapsedMs, 5000);
  assert.equal(groups[1].rows[0].id, 'external:term3'); assert.equal(groups[1].rows[0].label, 'external · outside');
  assert.equal(groupTasks([tracked], agents, [project], { filter: 'idle' })[0].key, 'other');
  assert.equal(groupTasks([tracked], agents, [project], { query: 'no-match' }).length, 0);
  assert.throws(() => transition(queued, { type: 'dismiss' }), /final/);
  const dismissed = transition(tracked, { type: 'dismiss' }); assert.equal(dismissed.dismissed, true); assert.deepEqual(dismissed.target, tracked.target);
});
