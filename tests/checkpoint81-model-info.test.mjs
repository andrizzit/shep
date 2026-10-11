import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createModelReader } from '../src/model-info.mjs';

const records = (provider, model, effort = 'high') => JSON.stringify(provider === 'claude'
  ? { type: 'assistant', message: { role: 'assistant', model, content: 'SYNTHETIC-PRIVATE-TEXT' }, effort }
  : { type: 'assistant', model_id: model, reasoning_effort: effort, content: 'SYNTHETIC-PRIVATE-TEXT' }) + '\n';
async function fixture(t, provider = 'claude') {
  const home = await mkdtemp('/private/tmp/shep-model-steady-'); t.after(() => rm(home, { recursive: true, force: true }));
  const path = provider === 'claude' ? join(home, '.claude', 'projects', '-synthetic-project', 'session-1.jsonl')
    : join(home, '.grok', 'sessions', '%2Fsynthetic-project', 'session-1', 'chat_history.jsonl');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, records(provider, 'first-model'));
  let clock = 0;
  const reader = createModelReader({ home, now: () => clock });
  return { home, path, read: () => reader({ provider, sessionId: 'session-1' }), advance: () => { clock += 10_000; } };
}

for (const provider of ['claude', 'grok']) {
  test(`checkpoint81 ${provider}: giant tool and partial records keep only last observed fields until a complete update`, async t => {
    const f = await fixture(t, provider); assert.deepEqual(await f.read(), { model: 'first-model', effort: 'high' });
    await appendFile(f.path, JSON.stringify({ type: 'tool', content: 'SYNTHETIC-TOOL-TEXT'.repeat(25_000) }) + '\n');
    assert((await stat(f.path)).size > 412 * 1024); f.advance();
    assert.deepEqual(await f.read(), { model: 'first-model', effort: 'high' });
    await appendFile(f.path, '{"type":"assistant","unfinished":"SYNTHETIC'); f.advance();
    assert.deepEqual(await f.read(), { model: 'first-model', effort: 'high' });
    await appendFile(f.path, '\n' + records(provider, 'second-model', 'medium')); f.advance();
    assert.deepEqual(await f.read(), { model: 'second-model', effort: 'medium' });
    assert.equal(await createModelReader({ home: f.home })({ provider, sessionId: 'absent' }), undefined);
  });
  test(`checkpoint81 ${provider}: inode replacement cannot inherit previous fields even when its log is larger`, async t => {
    const f = await fixture(t, provider); await f.read(); const before = await stat(f.path);
    const replacement = join(f.home, 'replacement.jsonl');
    await writeFile(replacement, JSON.stringify({ type: 'tool', content: 'x'.repeat(450_000) }) + '\n');
    await rename(replacement, f.path); const after = await stat(f.path);
    assert.notEqual(after.ino, before.ino); assert(after.size > before.size); f.advance();
    assert.equal(await f.read(), undefined);
    await appendFile(f.path, records(provider, 'replacement-model')); f.advance();
    assert.deepEqual(await f.read(), { model: 'replacement-model', effort: 'high' });
  });
}
test('checkpoint81 malformed lines are skipped without dropping complete fields or retaining conversation data', async t => {
  const f = await fixture(t);
  await appendFile(f.path, 'not-json\n' + records('claude', 'new-model', 'low') + '{"partial":');
  assert.deepEqual(await f.read(), { model: 'new-model', effort: 'low' });
  assert.doesNotMatch(JSON.stringify(await f.read()), /SYNTHETIC|content|message|type/);
});
test('checkpoint81 a healthy cached path reads changes without walking an unreadable directory again', async t => {
  const f = await fixture(t); await f.read();
  const project = dirname(f.path);
  try {
    await chmod(project, 0o111); await appendFile(f.path, records('claude', 'second-model')); f.advance();
    assert.equal(await createModelReader({ home: f.home })({ provider: 'claude', sessionId: 'session-1' }), undefined,
      'A fresh reader cannot list this directory');
    assert.deepEqual(await f.read(), { model: 'second-model', effort: 'high' }, 'The known exact path remains safely readable without readdir');
  } finally { await chmod(project, 0o700); }
});
test('checkpoint81 a vanished cached path is rediscovered by exact session ID', async t => {
  const f = await fixture(t); await f.read();
  const relocated = join(f.home, '.claude', 'projects', '-relocated-project', 'session-1.jsonl');
  await mkdir(dirname(relocated)); await rename(f.path, relocated);
  await appendFile(relocated, records('claude', 'relocated-model')); f.advance();
  assert.deepEqual(await f.read(), { model: 'relocated-model', effort: 'high' });
});
test('checkpoint81 cached values are not retained after truncation, disappearance or revoked access', async t => {
  const f = await fixture(t); await f.read();
  await writeFile(f.path, 'not-json\n'); f.advance(); assert.equal(await f.read(), undefined);
  await writeFile(f.path, records('claude', 'readable-model')); f.advance(); await f.read();
  try { await chmod(f.path, 0); f.advance(); assert.equal(await f.read(), undefined); }
  finally { await chmod(f.path, 0o600); }
  f.advance(); assert.deepEqual(await f.read(), { model: 'readable-model', effort: 'high' });
  await rm(f.path); f.advance(); assert.equal(await f.read(), undefined);
});
test('checkpoint81 warm cached provider roots, project/session directories and files cannot become symlinks', async t => {
  const cases = [['claude', 'root'], ['claude', 'project'], ['claude', 'file'], ['grok', 'session']];
  for (const [provider, point] of cases) {
    const f = await fixture(t, provider); await f.read();
    const selected = point === 'root' ? join(f.home, '.claude') : point === 'file' ? f.path : dirname(f.path);
    const saved = join(f.home, `saved-${point}`); await rename(selected, saved);
    await symlink(saved, selected); f.advance();
    assert.equal(await f.read(), undefined, `${provider} ${point} (even internal symlinks stay refused)`);
  }
});
