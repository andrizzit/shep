// Disposable Git data only. No helper accepts an arbitrary repository to mutate.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { after } from 'node:test';

const execute = promisify(execFile);
const owned = new Set();
const resources = new Set();
let sequence = 0;

export function isolatedEnvironment(home, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:GIT_|HERDR_|SHEP_|XDG_)/.test(key) && !['HOME', 'NODE_OPTIONS'].includes(key)));
  return { ...env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'),
    XDG_CACHE_HOME: join(home, 'cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Shep Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Shep Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-09-27T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-27T12:00:00Z', ...extra };
}

async function allocate(prefix) {
  const container = await realpath(await mkdtemp(join(tmpdir(), `shep-dispatch-${prefix}-`)));
  const home = join(container, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const emptyTemplate = join(container, 'empty-template');
  await mkdir(emptyTemplate);
  const fixture = { container, root: join(container, prefix), home,
    env: isolatedEnvironment(home, { GIT_TEMPLATE_DIR: emptyTemplate }),
    async cleanup() { await rm(container, { recursive: true, force: true }); resources.delete(fixture); owned.delete(fixture); } };
  resources.add(fixture); owned.add(fixture);
  return fixture;
}

function assertOwned(fixture) {
  if (!owned.has(fixture)) throw new TypeError('Only a helper-owned fixture may be mutated');
}
function localPath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new TypeError('Use a relative fixture path');
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new TypeError('Fixture path escapes its root');
  return target;
}
async function runGit(fixture, args, cwd = fixture.root) {
  assertOwned(fixture);
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
    { env: fixture.env, timeout: 3000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  return result.stdout;
}

export async function makeFolder({ files = {} } = {}) {
  const fixture = await allocate('folder');
  try {
    await mkdir(fixture.root);
    fixture.write = async (name, content) => {
      assertOwned(fixture);
      const target = localPath(fixture.root, name);
      await mkdir(resolve(target, '..'), { recursive: true });
      await writeFile(target, content);
      return target;
    };
    for (const [name, content] of Object.entries(files)) await fixture.write(name, content);
    return fixture;
  } catch (error) { await fixture.cleanup(); throw error; }
}

export async function makeRepo({ files = { 'README.md': 'Synthetic dispatcher repository.\n' }, branch = 'main' } = {}) {
  const fixture = await makeFolder({ files });
  try {
    fixture.git = args => runGit(fixture, args);
    await fixture.git(['init', '--initial-branch', branch]);
    await fixture.git(['add', '--all']);
    await fixture.git(['commit', '--allow-empty', '-m', 'Synthetic initial commit']);
    fixture.commonDir = await realpath((await fixture.git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    fixture.baseCommit = (await fixture.git(['rev-parse', 'HEAD'])).trim();
    return fixture;
  } catch (error) { await fixture.cleanup(); throw error; }
}

export async function addWorktree(repo, { branch = `fixture-${++sequence}`, name = `worktree-${sequence}`, base = repo.baseCommit } = {}) {
  assertOwned(repo);
  const root = localPath(repo.container, name);
  await repo.git(['worktree', 'add', '-b', branch, root, base]);
  // The parent's cleanup owns both the repository and all its linked checkouts.
  return { root, branch, commonDir: repo.commonDir, env: repo.env,
    git: args => runGit(repo, args, root), cleanup: repo.cleanup };
}

export async function makeClone(repo) {
  assertOwned(repo);
  const fixture = await allocate('clone');
  try {
    await execute('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--local', '--no-hardlinks', repo.root, fixture.root],
      { env: fixture.env, timeout: 3000, maxBuffer: 1024 * 1024 });
    fixture.git = args => runGit(fixture, args);
    fixture.commonDir = await realpath((await fixture.git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    fixture.baseCommit = (await fixture.git(['rev-parse', 'HEAD'])).trim();
    return fixture;
  } catch (error) { await fixture.cleanup(); throw error; }
}

export async function symlinkTo(fixture, { name = 'linked-folder' } = {}) {
  assertOwned(fixture);
  const link = localPath(fixture.container, name);
  await symlink(fixture.root, link, 'dir');
  return link;
}

after(async () => { for (const fixture of [...resources].reverse()) await fixture.cleanup(); });
