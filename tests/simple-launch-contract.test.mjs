import test from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERY_POLICIES, DELIVERY_MODES, validateOutcome } from '../src/dispatch/contracts.mjs';

test('change 004: optional delivery distinguishes launch and type without changing outcome safety', () => {
  assert.deepEqual(DELIVERY_POLICIES, ['auto', 'type']);
  assert.deepEqual(DELIVERY_MODES, ['launch', 'type']);
  const base = { taskId: 'task', attemptId: 'attempt', state: 'submitted', ok: true, stage: 'start', message: 'Started with its task.' };
  for (const delivery of ['launch', 'type']) assert.deepEqual(validateOutcome({ ...base, delivery }), []);
  assert.deepEqual(validateOutcome(base), [], 'Existing outcome fixtures remain valid');
  for (const delivery of ['auto', '', null, false]) assert(validateOutcome({ ...base, delivery }).some(issue => issue.path === 'delivery'));
  assert(validateOutcome({ ...base, delivery: 'launch', ok: false }).some(issue => issue.path === 'ok'));
  assert(validateOutcome({ ...base, delivery: 'launch', stage: 'retry' }).some(issue => issue.path === 'stage'));
});
