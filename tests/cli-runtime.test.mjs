import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDispatchRuntime } from '../src/cli.mjs';
import { makeRepo } from './helpers/git-fixtures.mjs';

function host(repo, mode = 'live') {
  const listeners = new Set();
  const snapshot = { mode, source: { state: 'connected' }, agents: [] };
  const context = { binary: join(repo.container, 'never-invoked-herdr'), env: { ...repo.env,
    HERDR_ENV: '1', HERDR_SOCKET_PATH: join(repo.container, 'synthetic.sock'),
    HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1' },
  context: { paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1' } };
  return { context, snapshot, listeners, monitor: {
    getSnapshot: () => structuredClone(snapshot),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  } };
}

test('private TUI runtime reads defaults without creating config/history or changing public snapshots', async t => {
  const repo = await makeRepo();
  const fixture = host(repo), configFile = join(repo.home, 'config', 'shep', 'config.json');
  const runtime = await createDispatchRuntime({ ...fixture, configFile });
  t.after(() => runtime.dispose());
  assert.deepEqual(runtime.tuiOptions.getConfig().projects, { roots: [], entries: [] });
  assert.deepEqual(runtime.tuiOptions.registry.getSnapshot().projects, []);
  const original = fixture.monitor.getSnapshot();
  runtime.attachTui({ getTasks: () => [], showNotice: () => assert.fail('No default warning expected') });
  assert.equal(fixture.listeners.size, 1);
  await runtime.tuiOptions.reloadConfig();
  await assert.rejects(access(configFile), { code: 'ENOENT' });
  for (const path of [join(repo.home, 'state', 'shep', 'history.jsonl'), join(repo.home, 'Library', 'Application Support', 'Shep', 'history.jsonl')]) {
    await assert.rejects(access(path), { code: 'ENOENT' });
  }
  assert.deepEqual(fixture.monitor.getSnapshot(), original);
  runtime.dispose();
  assert.equal(fixture.listeners.size, 0);
  await assert.rejects(runtime.tuiOptions.reloadConfig(), /stopping/);
});

test('explicit trust and reload share fresh config while preserving unrelated values and notifier lifecycle', async t => {
  const repo = await makeRepo(), fixture = host(repo);
  const configFile = join(repo.home, 'config', 'shep', 'config.json');
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, '{"placement":"split","custom":{"preserved":true}}\n');
  const runtime = await createDispatchRuntime({ ...fixture, configFile });
  t.after(() => runtime.dispose());
  const notices = [];
  runtime.attachTui({ getTasks: () => [], showNotice: message => notices.push(message) });
  assert.equal(notices.length, 1);
  const [trusted, reloaded] = await Promise.all([
    runtime.tuiOptions.addTrustedRepo(repo.root), runtime.tuiOptions.reloadConfig(),
  ]);
  assert.deepEqual(trusted.config.worktrees.trustedRepos, [repo.root]);
  assert.deepEqual(reloaded.config.worktrees.trustedRepos, [repo.root]);
  assert.deepEqual(runtime.tuiOptions.getConfig().worktrees.trustedRepos, [repo.root]);
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')).custom, { preserved: true });
  assert.equal(notices.length, 1, 'unchanged config warning is not repeated');
  const saved = JSON.parse(await readFile(configFile, 'utf8'));
  saved.notifications = { enabled: false };
  await writeFile(configFile, JSON.stringify(saved));
  await runtime.tuiOptions.reloadConfig();
  assert.equal(runtime.tuiOptions.getConfig().notifications.enabled, false);
  assert.equal(fixture.listeners.size, 1, 'reload replaces rather than duplicates the notifier');
  runtime.dispose();
  assert.equal(fixture.listeners.size, 0);
});

test('demo runtime ignores personal configuration, refuses trust writes and never creates a notifier', async t => {
  const repo = await makeRepo(), fixture = host(repo, 'demo');
  const configFile = join(repo.home, 'config.json');
  await writeFile(configFile, 'malformed fixture config');
  const runtime = await createDispatchRuntime({ ...fixture, mode: 'demo', configFile });
  t.after(() => runtime.dispose());
  runtime.attachTui({ getTasks: () => [], showNotice: () => assert.fail('Demo must not read this config') });
  assert.equal(fixture.listeners.size, 0);
  assert.deepEqual((await runtime.tuiOptions.reloadConfig()).errors, []);
  await assert.rejects(runtime.tuiOptions.addTrustedRepo(repo.root), /demo mode/);
  assert.equal(await readFile(configFile, 'utf8'), 'malformed fixture config');
  assert.deepEqual((await runtime.tuiOptions.registry.refresh()).projects, []);
});

test('quitting cancels active registry Git children and never starts queued discovery reads', async t => {
  const repo = await makeRepo(), fixture = host(repo);
  const bin = join(repo.container, 'bin'), log = join(repo.container, 'git-children.jsonl');
  await mkdir(bin);
  await writeFile(log, '');
  await writeFile(join(bin, 'git'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.FIXTURE_GIT_LOG, JSON.stringify({pid:process.pid})+'\\n');\nsetInterval(()=>{},1000);\n`, { mode: 0o755 });
  fixture.context.env.PATH = bin + ':' + fixture.context.env.PATH;
  fixture.context.env.FIXTURE_GIT_LOG = log;
  const runtime = await createDispatchRuntime({ ...fixture, configFile: join(repo.home, 'missing.json') });
  t.after(() => runtime.dispose());
  const reads = Array.from({ length: 8 }, () => runtime.tuiOptions.registry.registerEphemeral(repo.root));
  const children = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const deadline = Date.now() + 900;
  while ((await children()).length < 4 && Date.now() < deadline) await delay(10);
  assert.equal((await children()).length, 4, 'the four active reads are running; other reads remain queued');
  runtime.dispose();
  const results = await Promise.all(reads);
  assert.ok(results.every(result => result.error));
  const recorded = await children();
  assert.equal(recorded.length, 4, 'disposal never starts the queued Git children');
  for (const { pid } of recorded) {
    const exitDeadline = Date.now() + 1000;
    while (Date.now() < exitDeadline) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      await delay(10);
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'active child must terminate after disposal');
  }
});
