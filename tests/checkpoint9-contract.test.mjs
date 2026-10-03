import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutcome } from '../src/dispatch/contracts.mjs';

test('change 006 permits only non-dispatch dock and restore outcomes', () => {
  for (const state of ['docked', 'undocked', 'recovered']) {
    const result = { ok: true, state, message: 'Verified.' };
    assert.deepEqual(validateOutcome(result, { dispatch: false }), [], state);
    assert(validateOutcome({ ...result, ok: false }, { dispatch: false }).some(issue => issue.path === 'ok'), state);
    assert(validateOutcome({ ...result, taskId: 'task', attemptId: 'attempt' }).some(issue => issue.path === 'state'), state);
  }
  assert.deepEqual(validateOutcome({ ok: false, state: 'uncertain', message: 'Inspect Herdr.' }, { dispatch: false }), []);
});
