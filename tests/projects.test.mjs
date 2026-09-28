import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createProjectRegistry } from '../src/projects.mjs';
import { validateProject, DEFAULT_CONFIG, LIMITS } from '../src/dispatch/contracts.mjs';
import { makeRepo, makeFolder, addWorktree, makeClone, symlinkTo } from './helpers/git-fixtures.mjs';

const config = entries => ({ ...structuredClone(DEFAULT_CONFIG), projects: { roots: [], entries } });
const gitFor = fixture => (args, options) => new Promise((resolve, reject) => execFile('git', ['-C', options.cwd, ...args], { env: fixture.env, timeout: options.timeoutMs, maxBuffer: options.maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
  if (error && !Number.isInteger(error.code)) reject(error); else resolve({ code: error?.code ?? 0, stdout, stderr });
}));

test('registry folds two real linked worktrees and symlink paths, but keeps a clone separate', async () => {
  const repo = await makeRepo({ files: { 'src/api/file.txt': 'synthetic' } });
  const first = await addWorktree(repo, { name: 'first', branch: 'first' });
  const second = await addWorktree(repo, { name: 'second', branch: 'second' });
  const clone = await makeClone(repo), link = await symlinkTo(repo);
  const registry = createProjectRegistry({ config: config([
    { name: 'app', path: link, aliases: ['primary'], isolation: 'always' },
    { name: 'linked', path: first.root }, { name: 'second', path: second.root }, { name: 'clone', path: clone.root },
  ]), git: gitFor(repo) });
  const snapshot = await registry.refresh(); assert.deepEqual(snapshot.warnings, []); assert.equal(snapshot.projects.length, 2);
  const project = registry.resolve('PRIMARY');
  assert.equal(project.key, `git:${repo.commonDir}`); assert.equal(project.root, repo.root); assert.equal(project.isolation, 'always');
  assert.deepEqual(project.worktrees.map(item => item.path).sort(), [first.root, second.root].sort());
  assert.equal(registry.containing(join(first.root, 'src/api')).key, project.key);
  for (const item of snapshot.projects) assert.deepEqual(validateProject(item), []);
  const selected = await registry.registerEphemeral(join(first.root, 'src/api'));
  assert.equal(selected.project.name, 'app'); assert.equal(selected.subfolder, 'src/api');
  assert.deepEqual(selected.project.sources, ['config', 'session']);
});

test('registry reads raw Herdr IDs, all pane roots and only verified primary metadata', async () => {
  const repo = await makeRepo(), plain = await makeFolder();
  const linked = await addWorktree(repo, { name: 'linked', branch: 'linked' });
  const metadata = { is_linked_worktree: false, checkout_path: repo.root, repo_root: repo.root, repo_key: repo.commonDir };
  const snapshot = { workspaces: [
    { workspace_id: 'w1', label: 'first-name', worktree: null },
    { workspace_id: 'w2', label: 'second-name', worktree: metadata },
    { workspace_id: 'w3', label: 'wrong-root', worktree: { ...metadata, repo_root: plain.root } },
    { workspace_id: 'w4', label: 'linked', worktree: { ...metadata, is_linked_worktree: true, checkout_path: linked.root } },
  ], panes: [
    { workspace_id: 'w1', cwd: plain.root, foreground_cwd: repo.root }, { workspace_id: 'w1', cwd: plain.root },
    { workspace_id: 'w2', cwd: repo.root }, { workspace_id: 'w3', cwd: repo.root }, { workspace_id: 'w4', cwd: linked.root },
  ] };
  const registry = createProjectRegistry({ snapshot, git: gitFor(repo) });
  const result = await registry.refresh(); assert.equal(result.projects.length, 2);
  const project = registry.containing(repo.root);
  assert.deepEqual(project.workspaceIds, ['w1', 'w2']); assert.equal(project.name, basename(repo.root));
  assert.equal(project.worktrees[0].workspaceId, 'w4');
  assert.equal(registry.containing(plain.root).kind, 'folder');
});

test('session folders survive refresh but never persist or enter another registry through history', async () => {
  const plain = await makeFolder({ files: { 'child/file': 'x' } });
  const git = gitFor(plain); const registry = createProjectRegistry({ git });
  const selected = await registry.registerEphemeral(plain.root);
  assert.equal(selected.project.kind, 'folder'); assert.deepEqual(selected.project.sources, ['session']);
  assert.equal((await registry.refresh({ force: true })).projects.length, 1);
  assert.equal((await createProjectRegistry({ git, history: [{ project: { root: plain.root } }] }).refresh()).projects.length, 0);
  assert.equal((await registry.registerEphemeral('relative')).code, 'invalid_folder');
  assert.equal((await registry.registerEphemeral(join(plain.root, 'missing'))).code, 'invalid_folder');
});

test('same-name projects retain ambiguity and receive bounded unique parent/hash aliases', async () => {
  const fixture = await makeFolder();
  const one = await fixture.write('work/app/file', 'x'), two = await fixture.write('oss/app/file', 'x');
  const registry = createProjectRegistry({ config: config([{ name: 'app', path: one.slice(0, -5) }, { name: 'app', path: two.slice(0, -5) }]), git: gitFor(fixture) });
  await registry.refresh(); assert.equal(registry.resolve('APP').code, 'ambiguous_project');
  assert.equal(registry.resolve('app.work').root, one.slice(0, -5)); assert.equal(registry.resolve('app.oss').root, two.slice(0, -5));
  // Repeated parent components and a maximal name exhaust truncating parent aliases.
  const long = 'a'.repeat(64), root1 = join(fixture.root, 'same', 'leaf'), root2 = join(fixture.root, 'other', 'same', 'leaf');
  await fs.mkdir(root1, { recursive: true }); await fs.mkdir(root2, { recursive: true });
  const reserved = `${'a'.repeat(32)}.same`;
  const entries = [{ name: long, path: root1, aliases: [reserved] }, { name: long, path: root2 }];
  const bounded = createProjectRegistry({ config: config(entries), git: gitFor(fixture) });
  const found = await bounded.refresh();
  const aliases = found.projects.flatMap(project => project.aliases);
  assert.equal(new Set(aliases.map(value => value.toLowerCase())).size, aliases.length);
  assert.ok(aliases.every(value => value.length <= 64)); assert.ok(aliases.includes(reserved));
  assert.equal(createHash('sha256').update('git:/fixture/one/app/.git').digest('hex').slice(0, 8), '8fb994fb');
});

test('alias exhaustion uses canonical hashes and extends them when configured aliases occupy a suffix', async () => {
  const roots = ['/fixture/one/app', '/fixture/two/app'];
  const entries = roots.map(path => ({ name: 'app', path }));
  entries[0].aliases = ['app.one', 'app.fixture-one', 'app.two', 'app.fixture-two', 'app.fixture-one-8fb994fb'];
  const fakeFs = { realpath: async path => path, stat: async () => ({ isDirectory: () => true, isFile: () => false }) };
  const git = async (args, { cwd }) => ({ code: 0, stderr: '', stdout: args[0] === 'rev-parse' ? `${cwd}/.git\n` : `worktree ${cwd}\0branch refs/heads/main\0\0` });
  const registry = createProjectRegistry({ config: config(entries), fs: fakeFs, git });
  const result = await registry.refresh(); assert.deepEqual(result.warnings, []);
  const firstHash = createHash('sha256').update(`git:${roots[0]}/.git`).digest('hex').slice(0, 12);
  assert.equal(result.projects[0].aliases.at(-1), `app.fixture-one-${firstHash}`);
  assert.equal(result.projects[1].aliases.at(-1), 'app.fixture-two-1b4febe0');
  assert.equal(registry.resolve('APP.FIXTURE-ONE-8FB994FB').root, roots[0]);
});

test('discovery caps directory reads at500, skips hidden children, and limits Git concurrency to4', async () => {
  const fixture = await makeFolder();
  await Promise.all(Array.from({ length: 600 }, (_, index) => fs.mkdir(join(fixture.root, `${index < 10 ? '.' : ''}entry-${String(index).padStart(3, '0')}`, '.git'), { recursive: true })));
  let reads = 0, running = 0, maximum = 0, calls = 0;
  const tracked = { ...fs, opendir: async path => {
    const directory = await fs.opendir(path);
    return { read: async () => { reads += 1; return directory.read(); }, close: () => directory.close() };
  } };
  const git = async (args, { cwd, timeoutMs }) => {
    running += 1; maximum = Math.max(maximum, running); calls += 1;
    assert.equal(timeoutMs, 1000); assert.ok(!basename(cwd).startsWith('.'));
    await new Promise(resolve => setImmediate(resolve)); running -= 1;
    return { code: 0, stderr: '', stdout: args[0] === 'rev-parse' ? `${cwd}/.git\n` : `worktree ${cwd}\0branch refs/heads/main\0\0` };
  };
  const result = await createProjectRegistry({ config: { projects: { roots: [fixture.root] } }, git, fs: tracked }).refresh();
  assert.equal(reads, 500); assert.ok(result.projects.length >= 490 && result.projects.length <= 500);
  assert.equal(maximum, 4); assert.equal(calls, result.projects.length * 2);
});

test('qualified ownership refusal is first-class; unfamiliar diagnostics never become folders or trust', async () => {
  const repo = await makeRepo({ files: { 'src/file': 'x' } }); let cfg = config([{ name: 'safe', path: repo.root }]);
  const realGit = gitFor(repo);
  const diagnostic = `fatal: detected dubious ownership in repository at '${repo.root}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${repo.root}\n`;
  let suffix = '', calls = [];
  const git = async (args, options) => { calls.push(options); return options.trustedRoot ? realGit(args, options) : { code: 128, stdout: '', stderr: diagnostic + suffix }; };
  const registry = createProjectRegistry({ getConfig: () => cfg, git });
  let found = await registry.refresh(); assert.equal(found.projects.length, 0); assert.equal(found.trustRequired.length, 1);
  assert.equal(registry.resolve('safe').kind, 'trust_required'); assert.equal(registry.containing(join(repo.root, 'src')).kind, 'trust_required');
  suffix = 'unexpected diagnostic'; found = await registry.refresh({ force: true });
  assert.equal(found.projects.length, 0); assert.equal(found.trustRequired.length, 0); assert.ok(found.warnings.length);
  suffix = ''; const selection = await registry.registerEphemeral(join(repo.root, 'src')); assert.equal(selection.code, 'needs_confirmation'); assert.equal(selection.trust.path, join(repo.root, 'src'));
  cfg = { ...cfg, worktrees: { ...cfg.worktrees, trustedRepos: [repo.root] } };
  const selected = await registry.registerEphemeral(join(repo.root, 'src')); assert.equal(selected.project.root, repo.root); assert.equal(selected.subfolder, 'src');
  assert.ok(calls.some(options => options.trustedRoot === repo.root));
});

test('trust refresh refuses a submitted symlink that now points at a different repository', async () => {
  const repo = await makeRepo(), clone = await makeClone(repo), link = await symlinkTo(repo);
  const diagnostic = `fatal: detected dubious ownership in repository at '${repo.root}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${repo.root}\n`;
  const registry = createProjectRegistry({ git: async () => ({ code: 128, stdout: '', stderr: diagnostic }) });
  assert.equal((await registry.registerEphemeral(link)).code, 'needs_confirmation');
  await fs.unlink(link); await fs.symlink(clone.root, link, 'dir');
  assert.equal((await registry.registerEphemeral(link)).code, 'project_changed');
  assert.equal(registry.getSnapshot().projects.length, 0);
});

test('cache respects freshness, uses latest config and ranks history recency without reviving plain folders', async () => {
  const repo = await makeRepo(), clone = await makeClone(repo); let clock = 1000, calls = 0;
  let cfg = config([{ name: 'app', path: repo.root }, { name: 'apple', path: clone.root }]);
  const run = gitFor(repo);
  const registry = createProjectRegistry({ getConfig: () => cfg, now: () => clock, history: [{ project: { root: clone.root } }], git: async (...args) => { calls += 1; return run(...args); } });
  await registry.refresh(); const originalCalls = calls;
  await registry.refresh(); assert.equal(calls, originalCalls); assert.deepEqual(registry.search('app').map(project => project.name), ['apple', 'app']);
  clock += LIMITS.registryFreshMs; cfg = config([{ name: 'renamed', path: repo.root }]); await registry.refresh(); assert.ok(calls > originalCalls); assert.equal(registry.resolve('renamed').root, repo.root);
  const snapshot = registry.getSnapshot(); snapshot.projects.length = 0; assert.equal(registry.getSnapshot().projects.length, 2);
});

test('default Git adapter scrubs poisoned repository environment', async () => {
  const repo = await makeRepo(), clone = await makeClone(repo);
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys.slice(0, 5)) process.env[key] = clone.commonDir;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
    const result = await createProjectRegistry({ config: config([{ name: 'original', path: repo.root }]) }).refresh();
    assert.equal(result.projects[0].commonDir, repo.commonDir);
  } finally { for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});
