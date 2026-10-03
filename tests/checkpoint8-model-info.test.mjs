import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createModelReader } from '../src/model-info.mjs';

const claude = (model = 'claude-opus-5-5', effort = 'high', extra = {}) => ({ type: 'assistant',
  message: { role: 'assistant', model, content: [{ type: 'text', text: 'SYNTHETIC-PRIVATE-CONVERSATION' }] }, effort, ...extra });
const grok = (model = 'grok-4.7-build', effort = 'high', extra = {}) => ({ type: 'assistant', model_id: model,
  reasoning_effort: effort, content: 'SYNTHETIC-PRIVATE-CONVERSATION', ...extra });
const jsonl = records => records.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n') + '\n';
async function fixture(t) {
  const home = await mkdtemp('/private/tmp/shep-model-fixture-'); t.after(() => rm(home, { recursive: true, force: true }));
  const paths = { claude: join(home, '.claude', 'projects', '-synthetic-project', 'session-1.jsonl'),
    grok: join(home, '.grok', 'sessions', '%2Fsynthetic%2Fproject', 'session-2', 'chat_history.jsonl') };
  for (const path of Object.values(paths)) await mkdir(join(path, '..'), { recursive: true });
  return { home, paths, put: (provider, records) => writeFile(paths[provider], jsonl(records)) };
}

test('checkpoint8 linked adapters extract only verified assistant model and effort fields', async t => {
  const f = await fixture(t);
  await f.put('claude', [claude(), { type: 'user', model: 'spoof', effort: 'spoof', text: 'PRIVATE' }]);
  await f.put('grok', [grok(), { type: 'turn_started', model_id: 'grok-alias', reasoning_effort: 'spoof' }]);
  const read = createModelReader({ home: f.home });
  assert.deepEqual(await read({ provider: 'claude', sessionId: 'session-1' }), { model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(await read({ provider: 'grok', sessionId: 'session-2' }), { model: 'grok-4.7-build', effort: 'high' });
  assert.equal(await read({ provider: 'codex', sessionId: 'session-1' }), undefined, 'Unlinked Codex never guesses from config or cwd');
});
test('checkpoint8 newest authoritative fields refresh after 10 seconds, never sooner', async t => {
  const f = await fixture(t); let clock = 1000;
  await f.put('claude', [claude()]); await f.put('grok', [grok()]);
  const read = createModelReader({ home: f.home, now: () => clock });
  const first = await read({ provider: 'claude', sessionId: 'session-1' });
  assert.deepEqual(first, { model: 'claude-opus-5-5', effort: 'high' }); first.model = 'caller-mutation';
  await appendFile(f.paths.claude, jsonl([claude('claude-sonnet-5-5', 'medium')]));
  await appendFile(f.paths.grok, jsonl([grok('grok-next', 'low')]));
  clock = 10_999;
  assert.deepEqual(await read({ provider: 'claude', sessionId: 'session-1' }), { model: 'claude-opus-5-5', effort: 'high' });
  clock = 11_000;
  assert.deepEqual(await read({ provider: 'claude', sessionId: 'session-1' }), { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(await read({ provider: 'grok', sessionId: 'session-2' }), { model: 'grok-next', effort: 'low' });
});
test('checkpoint8 cache uses both size and modification time and returns fresh field objects', async t => {
  const f = await fixture(t); let clock = 0;
  await f.put('claude', [claude('model-a', 'high')]); await utimes(f.paths.claude, 1_700_000_000, 1_700_000_000);
  const read = createModelReader({ home: f.home, now: () => clock });
  assert.deepEqual(await read({ provider: 'claude', sessionId: 'session-1' }), { model: 'model-a', effort: 'high' });
  const before = await stat(f.paths.claude);
  await f.put('claude', [claude('model-b', 'high')]); await utimes(f.paths.claude, 1_700_000_000, 1_700_000_000);
  assert.equal((await stat(f.paths.claude)).size, before.size);
  clock = 10_000; assert.equal((await read({ provider: 'claude', sessionId: 'session-1' })).model, 'model-a');
  await utimes(f.paths.claude, 1_700_000_001, 1_700_000_001);
  clock = 20_000; assert.equal((await read({ provider: 'claude', sessionId: 'session-1' })).model, 'model-b');
});
test('checkpoint8 cached fields disappear when a file becomes unreadable and return when access is restored', async t => {
  const f = await fixture(t); let clock = 0; await f.put('claude', [claude()]);
  const read = createModelReader({ home: f.home, now: () => clock });
  assert.deepEqual(await read({ provider: 'claude', sessionId: 'session-1' }), { model: 'claude-opus-5-5', effort: 'high' });
  try {
    await chmod(f.paths.claude, 0); clock = 10_000;
    assert.equal(await read({ provider: 'claude', sessionId: 'session-1' }), undefined);
  } finally { await chmod(f.paths.claude, 0o600); }
  clock = 20_000;
  assert.deepEqual(await read({ provider: 'claude', sessionId: 'session-1' }), { model: 'claude-opus-5-5', effort: 'high' });
});
test('checkpoint8 missing data, unreadable paths, malformed tails and unsupported formats stay blank', async t => {
  const f = await fixture(t); const read = () => createModelReader({ home: f.home });
  for (const request of [undefined, null, {}, { provider: 'claude' }, { provider: 'claude', sessionId: '' },
    { provider: 'unknown', sessionId: 'session-1' }, { provider: 'claude', sessionId: 'not-found' }]) assert.equal(await read()(request), undefined);
  await f.put('claude', ['not-json']); assert.equal(await read()({ provider: 'claude', sessionId: 'session-1' }), undefined);
  await f.put('claude', [{ model: 'config-default', effort: 'high' }]); assert.equal(await read()({ provider: 'claude', sessionId: 'session-1' }), undefined);
  await f.put('claude', [{ type: 'assistant', message: { role: 'user', model: 'spoof' }, effort: 'high' }]);
  assert.equal(await read()({ provider: 'claude', sessionId: 'session-1' }), undefined);
  await f.put('claude', [claude(), '{"type":"assistant"']);
  assert.equal(await read()({ provider: 'claude', sessionId: 'session-1' }), undefined, 'Malformed latest bytes must not reuse older fields as current');
  await rm(f.paths.claude); await mkdir(f.paths.claude);
  assert.equal(await read()({ provider: 'claude', sessionId: 'session-1' }), undefined);
});
test('checkpoint8 unsafe IDs are refused before path construction', async t => {
  const f = await fixture(t); await f.put('claude', [claude()]); const read = createModelReader({ home: f.home });
  for (const sessionId of ['../x', 'a/b', '/private/tmp/x', 'a\\b', '.', '..', 'session-1.jsonl', 'session 1', 'a\n', 'a\0', 'é', 123]) {
    assert.equal(await read({ provider: 'claude', sessionId }), undefined, JSON.stringify(sessionId));
    assert.equal(await read({ provider: 'grok', sessionId }), undefined, JSON.stringify(sessionId));
  }
});
test('checkpoint8 symlinked files, projects, session folders and provider roots are refused', async t => {
  const f = await fixture(t); const outside = join(f.home, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'session-1.jsonl'), jsonl([claude('outside-model')]));
  await symlink(join(outside, 'session-1.jsonl'), f.paths.claude);
  assert.equal(await createModelReader({ home: f.home })({ provider: 'claude', sessionId: 'session-1' }), undefined);
  await rm(join(f.paths.claude, '..'), { recursive: true }); await symlink(outside, join(f.paths.claude, '..'));
  assert.equal(await createModelReader({ home: f.home })({ provider: 'claude', sessionId: 'session-1' }), undefined);
  await writeFile(join(outside, 'chat_history.jsonl'), jsonl([grok('outside-model')]));
  await rm(join(f.paths.grok, '..'), { recursive: true }); await symlink(outside, join(f.paths.grok, '..'));
  assert.equal(await createModelReader({ home: f.home })({ provider: 'grok', sessionId: 'session-2' }), undefined);
  await rm(join(f.home, '.claude'), { recursive: true }); await symlink(outside, join(f.home, '.claude'));
  assert.equal(await createModelReader({ home: f.home })({ provider: 'claude', sessionId: 'session-1' }), undefined);
});
test('checkpoint8 reads only complete records inside the last 64KiB', async t => {
  const f = await fixture(t); const padding = jsonl([{ type: 'user', content: 'SYNTHETIC-PRIVATE-HEAD'.repeat(4000), model: 'spoof' }]);
  await f.put('claude', [claude('old-model')]); await appendFile(f.paths.claude, padding + jsonl([claude('current-model', 'medium')]));
  assert((await stat(f.paths.claude)).size > 64 * 1024);
  assert.deepEqual(await createModelReader({ home: f.home })({ provider: 'claude', sessionId: 'session-1' }), { model: 'current-model', effort: 'medium' });
  await f.put('grok', [grok('old-model')]); await appendFile(f.paths.grok, padding);
  assert.equal(await createModelReader({ home: f.home })({ provider: 'grok', sessionId: 'session-2' }), undefined, 'Model outside the bounded tail is never guessed');
  await writeFile(f.paths.claude, 'x'.repeat(80 * 1024));
  assert.equal(await createModelReader({ home: f.home })({ provider: 'claude', sessionId: 'session-1' }), undefined);
});
test('checkpoint8 exact session IDs never match other folders or ambiguous copies', async t => {
  const f = await fixture(t); await f.put('claude', [claude()]); await f.put('grok', [grok()]);
  const read = createModelReader({ home: f.home });
  assert.equal(await read({ provider: 'claude', sessionId: 'other-session' }), undefined);
  assert.equal(await read({ provider: 'grok', sessionId: 'other-session' }), undefined);
  const duplicate = join(f.home, '.claude', 'projects', '-another-project', 'session-1.jsonl');
  await mkdir(join(duplicate, '..')); await writeFile(duplicate, await readFile(f.paths.claude));
  assert.equal(await createModelReader({ home: f.home })({ provider: 'claude', sessionId: 'session-1' }), undefined);
  const duplicateGrok = join(f.home, '.grok', 'sessions', '%2Fanother', 'session-2', 'chat_history.jsonl');
  await mkdir(join(duplicateGrok, '..'), { recursive: true }); await writeFile(duplicateGrok, await readFile(f.paths.grok));
  assert.equal(await createModelReader({ home: f.home })({ provider: 'grok', sessionId: 'session-2' }), undefined);
});
test('checkpoint8 model fields with terminal controls or free-form content are omitted', async t => {
  const f = await fixture(t); await f.put('claude', [claude('\x1b[31mPRIVATE MESSAGE', 'high')]);
  assert.deepEqual(await createModelReader({ home: f.home })({ provider: 'claude', sessionId: 'session-1' }), { effort: 'high' });
  await f.put('grok', [grok('grok-valid', 'PRIVATE MESSAGE\n')]);
  assert.deepEqual(await createModelReader({ home: f.home })({ provider: 'grok', sessionId: 'session-2' }), { model: 'grok-valid' });
  await f.put('grok', [grok({ hidden: 'PRIVATE' }, ['high'])]);
  assert.equal(await createModelReader({ home: f.home })({ provider: 'grok', sessionId: 'session-2' }), undefined);
});
