import test from 'node:test';
import assert from 'node:assert/strict';
import { expandTemplate, validateTemplates } from '../src/dispatch/templates.mjs';
import { BUILTIN_TEMPLATES } from '../src/dispatch/contracts.mjs';

test('templates expand all placeholders literally and retain builtin overrides', () => {
  const task = '$& $1 $(echo no);\n`literal`';
  assert.equal(expandTemplate('test', task, { test: '{task} then {task}' }), `${task} then ${task}`);
  for (const name of Object.keys(BUILTIN_TEMPLATES)) assert.equal(expandTemplate(name, 'ABC'), BUILTIN_TEMPLATES[name].replace('{task}', 'ABC'));
  assert.equal(expandTemplate(null, task), task);
  assert.equal(expandTemplate('test', 'ABC', { test: '' }).code, 'unknown_template');
});
test('template validation prevents reserved names, missing placeholders and expanded overflow', () => {
  for (const overrides of [{ dispatch: '{task}' }, { remember: '{task}' }, { memory: '{task}' }, { Upper: '{task}' }, { x: 'missing' }, { x: `${'a'.repeat(4096)}{task}` }]) assert.ok(validateTemplates(overrides).errors.length);
  assert.deepEqual(validateTemplates({ test: '' }).errors, []);
  assert.equal(expandTemplate('x', 'a'.repeat(40000), { x: '{task}{task}' }).code, 'invalid_prompt');
});
