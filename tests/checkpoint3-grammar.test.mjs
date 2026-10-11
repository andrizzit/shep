import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCommand } from '../src/dispatch/grammar.mjs';
import { validateDispatchSpec } from '../src/dispatch/contracts.mjs';

const baseline = JSON.parse(await readFile(new URL('./fixtures/dispatch-grammar.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('./fixtures/checkpoint3-grammar.json', import.meta.url), 'utf8'));
for (const vector of fixture.cases) test(`checkpoint3 grammar table: ${vector.id}`, () => {
  const actual = parseCommand(vector.input, { ...baseline.context, ...vector.context });
  const { project, kind, ...rest } = actual;
  assert.equal(kind, 'dispatch');
  assert.deepEqual({ ...rest, projectKey: project.key }, vector.expected);
  assert.deepEqual(validateDispatchSpec(actual), []);
  assert.equal(actual.command, vector.input);
  assert.equal(actual.mode, actual.agents.length > 1 || actual.modeIntent === 'wt' ? 'worktree' : actual.modeIntent);
});
