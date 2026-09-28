import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGitRunner, summarize, classifyOwnershipFailure } from '../src/gitinfo.mjs';
import { makeRepo } from './helpers/git-fixtures.mjs';

const message = root => `fatal: detected dubious ownership in repository at '${root}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${root}`;
test('ownership classifier matches only complete qualified native diagnostics for the exact root and target stage', () => {
  const root = '/private/tmp/repo';
  for (const source of ['herdr', 'git']) {
    const input = { source, stage: 'target', code: source === 'git' ? 128 : 'worktree_create_failed', canonicalRoot: root, message: message(root) };
    assert.deepEqual(classifyOwnershipFailure(input), { kind: 'untrusted_repository', root });
    assert.ok(classifyOwnershipFailure({ ...input, message: message(root) + '\n\t ' }));
    for (const patch of [{ stage: 'start' }, { code: 'other' }, { message: 'generic failure' }, { message: 'prefix ' + message(root) }, { message: message(root) + '\nINJECTED' },
      { message: message(root).replace('To add', 'Unexpected instruction\nTo add') }, { message: message(root).replace(/safe.directory .+$/, 'safe.directory /wrong') },
      { message: message(root + '-other') }, { canonicalRoot: '/wrong' }]) assert.equal(classifyOwnershipFailure({ ...input, ...patch }), null, JSON.stringify(patch));
  }
});

test('Git summaries report clean, dirty, untracked, renames and commits ahead on isolated real repositories', async () => {
  const repo = await makeRepo(); const git = createGitRunner({ env: repo.env });
  const clean = await summarize(repo.root, { git, baseCommit: repo.baseCommit });
  assert.equal(clean.state, 'available'); assert.equal(clean.dirty, false); assert.equal(clean.changedFiles, 0); assert.equal(clean.commitsAhead, 0);
  await repo.write('README.md', 'First\nSecond\n'); await repo.write('new file.txt', 'untracked\n');
  const dirty = await summarize(repo.root, { git }); assert.equal(dirty.changedFiles, 2); assert.equal(dirty.dirty, true); assert.ok(dirty.insertions > 0); assert.equal(dirty.commitsAhead, null);
  await repo.git(['add', '--all']); await repo.git(['commit', '-m', 'Second fixture commit']);
  assert.equal((await summarize(repo.root, { git, baseCommit: repo.baseCommit })).commitsAhead, 1);
  await repo.git(['mv', 'new file.txt', 'renamed file.txt']);
  assert.equal((await summarize(repo.root, { git })).changedFiles, 1);
});

test('summary failures remain unknown, never clean or zero; base revision is validated', async () => {
  for (const git of [async () => { throw Object.assign(Error(), { code: 'timeout' }); }, async () => ({ code: 1, stdout: '', stderr: 'PRIVATE' })]) {
    const result = await summarize('/tmp/unused', { git }); assert.equal(result.state, 'unavailable');
    for (const key of ['dirty', 'changedFiles', 'insertions', 'deletions', 'commitsAhead']) assert.equal(result[key], null);
    assert.doesNotMatch(result.message, /PRIVATE/);
  }
  let calls = 0; assert.equal((await summarize('/tmp/unused', { baseCommit: '--bad', git: async () => { calls += 1; } })).state, 'unavailable'); assert.equal(calls, 0);
});

test('Git execFile seam scrubs inherited routing, retains literal argv, bounds timeout and verifies persisted exact trust', async () => {
  const repo = await makeRepo(), log = join(repo.container, 'git-log'), binary = join(repo.container, 'git.mjs');
  await writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.TEST_LOG,JSON.stringify({argv:process.argv.slice(2),GIT_DIR:process.env.GIT_DIR,GIT_WORK_TREE:process.env.GIT_WORK_TREE})+'\\n');\nif(process.argv.includes('hang'))setInterval(()=>{},1000);else process.stdout.write('ok');\n`, { mode: 0o755 });
  let allowed = false;
  const git = createGitRunner({ binary, env: { ...repo.env, GIT_DIR: '/wrong', GIT_WORK_TREE: '/wrong', TEST_LOG: log }, getConfig: () => ({ worktrees: { trustedRepos: allowed ? [repo.root] : [] } }) });
  await assert.rejects(git(['status'], { cwd: repo.root, trustedRoot: repo.root }), { code: 'untrusted_repository' });
  allowed = true;
  assert.equal((await git(['literal $(touch nope)', '羊'], { cwd: repo.root, trustedRoot: repo.root })).code, 0);
  const { readFile } = await import('node:fs/promises'); const line = JSON.parse((await readFile(log, 'utf8')).trim());
  assert.deepEqual(line.argv, ['-c', `safe.directory=${repo.root}`, '-C', repo.root, 'literal $(touch nope)', '羊']);
  assert.equal(line.GIT_DIR, undefined); assert.equal(line.GIT_WORK_TREE, undefined);
  await assert.rejects(git(['hang'], { cwd: repo.root, timeoutMs: 30 }), { code: 'timeout' });
});
