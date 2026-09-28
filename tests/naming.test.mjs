import test from 'node:test';
import assert from 'node:assert/strict';
import { slug, agentName, tabLabel, branchName } from '../src/dispatch/naming.mjs';
import { NAMING_VECTORS, PATTERNS } from '../src/dispatch/contracts.mjs';

for (const vector of NAMING_VECTORS) test(`naming: ${vector.task}`, () => {
  assert.equal(slug(vector.task), vector.slug);
  assert.equal(agentName(vector.task, 'claude'), vector.agent);
  assert.equal(branchName(vector.task, { randomHex: () => vector.suffix }), vector.branch);
});
test('names respect native limit, collisions, numeric prefix and first long word', () => {
  const task = '1234567890123456789012345678901234567890';
  assert.equal(slug(task), 't-123456789012345678901234');
  const takenNames = [];
  for (let index = 0; index < 10; index += 1) {
    const name = agentName(task, 'mastracode', { takenNames, randomHex: () => 'abc' });
    assert.match(name, PATTERNS.agentName); assert.ok(name.length <= 32); assert.ok(!takenNames.includes(name)); takenNames.push(name);
  }
  assert.match(takenNames[1], /-2$/); assert.match(takenNames[8], /-9$/); assert.match(takenNames[9], /-abc$/);
  assert.throws(() => agentName(task, 'invented'), /provider/);
  assert.throws(() => branchName(task, { randomHex: () => 'bad' }), /four/);
  assert.equal(slug('Please\nimplement foo'), 'implement-foo');
});
test('labels normalize first-line display without changing naming input', () => {
  assert.equal(tabLabel(' a\t b  \nsecond line'), 'a b');
  assert.equal(tabLabel('🙂'.repeat(41)), `${'🙂'.repeat(40)}…`);
  assert.equal(tabLabel('hello\x1b[31mworld'), 'helloworld');
});
