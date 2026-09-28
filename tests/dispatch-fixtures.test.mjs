import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, makeFolder, makeClone, addWorktree, symlinkTo } from './helpers/git-fixtures.mjs';
import { createFakeController, createFakeRegistry, makeProject, deferred, makeSnapshot } from './helpers/dispatch-fakes.mjs';

const execute = promisify(execFile);
const binary = fileURLToPath(new URL('./fixtures/fake-herdr.cjs', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function host(t, { mode = 'scripted', ...scenario } = {}) {
  const directory = await makeFolder();
  t.after(directory.cleanup);
  const state = join(directory.root, 'state.json');
  const log = join(directory.root, 'calls.jsonl');
  const script = join(directory.root, 'scenario.json');
  await writeFile(script, JSON.stringify({ version: 1, ...scenario }));
  const env = { ...directory.env, SHEP_TEST_MODE: mode, SHEP_TEST_SCENARIO: script,
    SHEP_TEST_STATE: state, SHEP_TEST_LOG: log, HERDR_SOCKET_PATH: '/fixture/pinned.sock', HERDR_PANE_ID: 'w1:p1' };
  async function run(args, options = {}) {
    const result = await execute(process.execPath, [binary, ...args], { env, timeout: 3000, maxBuffer: 1024 * 1024, ...options });
    return JSON.parse(result.stdout);
  }
  return { directory, env, state, log, script, run,
    read: async () => JSON.parse(await readFile(state, 'utf8')),
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('D0 grammar vectors preserve original and expanded task fields without implementing a parser', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/dispatch-grammar.json', import.meta.url), 'utf8'));
  assert.equal(fixture.version, 1);
  assert.equal(fixture.cases.length, 30);
  assert.equal(new Set(fixture.cases.map(item => item.id)).size, fixture.cases.length);
  for (const item of fixture.cases) {
    assert.equal(typeof item.input, 'string');
    if (item.expected.error) { assert.equal(typeof item.expected.error, 'string'); continue; }
    const expected = item.expected;
    assert.equal(expected.command, item.input);
    assert.ok(expected.agents.length >= 1 && expected.agents.length <= 4);
    assert.ok(['auto', 'here', 'wt'].includes(expected.modeIntent));
    assert.equal(expected.mode, expected.agents.length > 1 || expected.modeIntent === 'wt' ? 'worktree' : expected.modeIntent);
    assert.equal(typeof expected.inputTask, 'string');
    assert.ok(Buffer.byteLength(expected.task) <= 65536);
    const context = { ...fixture.context, ...item.context };
    assert.ok(context.projects.some(project => project.key === expected.projectKey));
  }
  const template = fixture.cases.find(item => item.id === 'template').expected;
  assert.equal(template.inputTask, 'parseDispatch');
  assert.notEqual(template.task, template.inputTask);
  assert.equal(fixture.cases.find(item => item.id === 'fanout').expected.modeIntent, 'auto');
  assert.equal(fixture.cases.find(item => item.id === 'fanout').expected.mode, 'worktree');
  const trust = fixture.cases.find(item => item.id === 'trust-required-project').expected;
  assert.equal(trust.code, 'needs_confirmation');
  assert.equal(trust.trust.kind, 'trust_required');
  assert.equal(Object.hasOwn(trust, 'projectKey'), false);
});

test('D0 Git helpers isolate repositories, linked worktrees, clones, folders, and HOME', async t => {
  const repo = await makeRepo({ files: { 'src/entry.txt': 'synthetic\n' } }); t.after(repo.cleanup);
  const one = await addWorktree(repo); const two = await addWorktree(repo);
  const clone = await makeClone(repo); t.after(clone.cleanup);
  const folder = await makeFolder(); t.after(folder.cleanup);
  assert.equal(one.commonDir, repo.commonDir); assert.equal(two.commonDir, repo.commonDir);
  assert.notEqual(clone.commonDir, repo.commonDir);
  assert.equal((await one.git(['rev-parse', 'HEAD'])).trim(), repo.baseCommit);
  assert.equal(await realpath(await symlinkTo(repo)), repo.root);
  assert.ok((await repo.git(['worktree', 'list', '--porcelain', '-z'])).startsWith('worktree ' + repo.root + '\0'));
  assert.ok(repo.env.HOME.startsWith(repo.container));
  assert.equal(repo.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(repo.env.HERDR_SOCKET_PATH, undefined);
  await assert.rejects(stat(join(folder.root, '.git')), { code: 'ENOENT' });
  await assert.rejects(makeClone({ root: '/unrelated/repository' }), /helper-owned/);
  await assert.rejects(repo.write('../escape.txt', 'x'), /escapes/);
});

test('D0 deferred controller correlates attempts and preserves target notices before completion', async () => {
  const controller = createFakeController();
  const events = [];
  const first = { taskId: 'task-1', attemptId: 'attempt-1' };
  const second = { taskId: 'task-1', attemptId: 'attempt-2' };
  const firstResult = controller.dispatch(first, { onProgress: event => events.push(event) });
  const secondResult = controller.dispatch(second, { onProgress: () => { throw new Error('Synthetic observer error'); } });
  const message = "Worktree starts at the repository root; subfolder src/api isn't applied";
  assert.equal(await controller.emit(first, 'target', { placement: { mode: 'worktree', reason: 'forced' }, message }), true);
  await assert.rejects(controller.emit(first, 'target', { taskId: 'different-task' }), /Unknown fixture progress/);
  await assert.rejects(controller.emit(first, 'prompt', { message }), /target progress/);
  assert.throws(() => controller.settle(first, { taskId: 'different-task' }), /attempt identity/);
  controller.settle(second, { ok: false, state: 'needs_confirmation', message: 'Synthetic trust confirmation.' });
  assert.equal((await secondResult).attemptId, second.attemptId);
  assert.equal(events.at(-1).message, message);
  assert.equal(events.at(-1).attemptId, first.attemptId);
  controller.settle(first);
  assert.equal((await firstResult).state, 'submitted');
  assert.equal(await controller.emit(second, 'prompt'), false, 'Completed attempt must not emit later progress');
  controller.dispose();
});

test('D0 fake disposal settles queued and in-progress jobs without later action calls', async () => {
  const controller = createFakeController();
  const queued = { taskId: 'queued', attemptId: 'a' }; const active = { taskId: 'active', attemptId: 'a' };
  const q = controller.dispatch(queued); const a = controller.dispatch(active);
  await controller.emit(active, 'start'); controller.dispose();
  assert.equal((await q).state, 'failed'); assert.equal((await a).state, 'uncertain');
  const before = controller.calls.length;
  await assert.rejects(controller.closeAgent({ paneId: 'w1:p2' }), /disposed/);
  await controller.notify({ title: 'ignored after disposal' });
  assert.equal(await controller.emit(active, 'prompt'), false);
  assert.equal(controller.calls.length, before);
});

const requiredNotice = { placement: { mode: 'worktree', reason: 'Explicit worktree' }, noticeRequired: true,
  message: "Worktree starts at the repository root; subfolder src/api isn't applied" };

test('D0 required target notice waits for acknowledgement before fixture progress can advance', async () => {
  const controller = createFakeController(); const flush = deferred();
  const request = { taskId: 'notice-task', attemptId: 'notice-attempt' };
  const result = controller.dispatch(request, { onProgress: event => event.noticeRequired ? flush.promise : undefined });
  const acknowledgement = controller.emit(request, 'target', requiredNotice);
  await assert.rejects(controller.emit(request, 'start'), /Await the required notice/);
  assert.throws(() => controller.settle(request), /Await the required notice/);
  assert.deepEqual(controller.calls.map(item => item.method), ['dispatch']);
  flush.resolve(); assert.equal(await acknowledgement, true);
  assert.equal(await controller.emit(request, 'start'), true);
  controller.settle(request);
  assert.equal((await result).state, 'submitted');
  controller.dispose();
});

test('D0 failed or disposed required notices cannot advance; ordinary observer failures remain nonfatal', async () => {
  for (const kind of ['missing', 'rejected', 'timeout', 'disposed']) {
    const controller = createFakeController({ noticeTimeoutMs: 20 });
    const flush = deferred();
    const request = { taskId: `notice-${kind}`, attemptId: 'attempt' };
    const onProgress = kind === 'missing' ? undefined : event => {
      if (!event.noticeRequired) return;
      return kind === 'rejected' ? Promise.reject(new Error('Synthetic failed flush')) : flush.promise;
    };
    const result = controller.dispatch(request, { onProgress });
    const acknowledgement = controller.emit(request, 'target', requiredNotice);
    if (kind === 'disposed') controller.dispose();
    assert.equal(await acknowledgement, false, kind);
    const outcome = await result;
    assert.equal(outcome.state, 'failed', kind);
    assert.equal(outcome.code, kind === 'disposed' ? 'disposed' : 'prelaunch_notice_failed', kind);
    if (kind !== 'disposed') {
      assert.equal(outcome.stage, 'target');
      assert.equal(outcome.message, 'The worktree location notice could not be displayed. No launch was started.');
      assert.equal(Object.hasOwn(outcome, 'created'), false);
    }
    flush.resolve();
    assert.equal(await controller.emit(request, 'start'), false, kind);
    assert.deepEqual(controller.calls.map(item => item.method), ['dispatch'], kind);
    controller.dispose();
  }
  const controller = createFakeController();
  const request = { taskId: 'ordinary-notice', attemptId: 'attempt' };
  const result = controller.dispatch(request, { onProgress: async () => { throw new Error('Non-required observer'); } });
  assert.equal(await controller.emit(request, 'target', { placement: { mode: 'here', reason: 'Default' } }), true);
  controller.settle(request);
  assert.equal((await result).state, 'submitted');
  controller.dispose();
});

test('D0 registry and private controller snapshots do not expose mutable fixture state', async () => {
  const registry = createFakeRegistry();
  const snapshot = registry.getSnapshot(); snapshot.projects[0].aliases.push('mutated');
  assert.equal(registry.resolve('sh').key, makeProject().key);
  assert.ok(registry.resolve('mutated').error);
  assert.equal(registry.containing('/fixture/shep/src').key, makeProject().key);
  assert.equal(registry.containing('/fixture/shepherd'), null);
  assert.equal(registry.search('she').length, 1);
  assert.equal((await registry.refresh({ force: true })).updatedAt, '2026-09-27T12:00:00.000Z');
  registry.destroy();
  const controller = createFakeController();
  const privateSnapshot = await controller.getControlSnapshot();
  privateSnapshot.workspaces[0].number = 99;
  assert.equal((await controller.getControlSnapshot()).workspaces[0].number, 1);
  controller.publishControlSnapshot(privateSnapshot);
  assert.equal((await controller.getControlSnapshot()).workspaces[0].number, 99);
  controller.dispose();
});

test('D0 registry trust candidates and deferred folder discovery preserve configured project identity', async () => {
  const configured = makeProject();
  const candidate = { kind: 'trust_required', root: '/fixture/locked', name: 'locked', aliases: ['lk'],
    source: 'config', path: '/fixture/locked/src', message: 'Synthetic repository trust required.' };
  const refreshGate = deferred(); const folderGate = deferred();
  const registry = createFakeRegistry({ trustRequired: [candidate], overrides: {
    refresh: () => refreshGate.promise,
    registerEphemeral: path => path === configured.root ? { project: configured, subfolder: '' } : folderGate.promise,
  } });
  assert.equal(registry.resolve('lk').kind, 'trust_required');
  assert.equal(registry.containing('/fixture/locked/src').root, candidate.root);
  assert.equal(registry.search('lock')[0].kind, 'trust_required');
  const reused = await registry.registerEphemeral(configured.root);
  assert.deepEqual(reused.project.sources, ['config']);
  assert.equal(registry.getSnapshot().projects.length, 1);
  const refresh = registry.refresh({ force: true });
  assert.equal(registry.getSnapshot().trustRequired.length, 1, 'A pending refresh retains the last registry snapshot');
  refreshGate.resolve({ trustRequired: [] }); await refresh;
  assert.equal(registry.getSnapshot().trustRequired.length, 0);
  const discover = registry.registerEphemeral('/fixture/notes');
  assert.equal(registry.search('notes').length, 0, 'A pending discovery is not yet a project');
  const project = makeProject({ key: 'dir:/fixture/notes', name: 'notes', aliases: [], root: '/fixture/notes', commonDir: null, kind: 'folder', sources: ['session'] });
  folderGate.resolve({ project, subfolder: '' });
  assert.equal((await discover).project.key, project.key);
  assert.equal((await registry.refresh()).projects.find(item => item.key === project.key).sources[0], 'session');
  const ambiguous = createFakeRegistry({ trustRequired: [{ ...candidate, name: 'shep', aliases: [] }] });
  assert.ok(ambiguous.resolve('shep').error, 'Resolved and trust-required candidates both participate in ambiguity');
  registry.destroy(); ambiguous.destroy();
});

test('D0 implicit primary workspace is outside the returned receipt and CLI close removes empty containers', async t => {
  const fixture = await host(t, { snapshot: makeSnapshot({ workspaces: [], tabs: [], panes: [], focused_pane_id: null }) });
  const created = (await fixture.run(['worktree', 'create', '--cwd', '/fixture/repo', '--branch', 'shep/task', '--no-focus'])).result;
  const state = await fixture.read();
  assert.equal(state.snapshot.workspaces.length, 2);
  const primary = state.snapshot.workspaces.find(item => item.worktree?.is_linked_worktree === false);
  assert.notEqual(primary.workspace_id, created.workspace.workspace_id);
  assert.equal(created.workspace.worktree.repo_key, '/fixture/repo/.git');
  assert.equal(primary.worktree.repo_key, created.workspace.worktree.repo_key);
  assert.equal((await fixture.run(['worktree', 'list', '--cwd', '/fixture/repo'])).result.source.repo_key, primary.worktree.repo_key);
  await fixture.run(['worktree', 'remove', '--workspace', created.workspace.workspace_id]);
  assert.deepEqual((await fixture.read()).snapshot.workspaces.map(item => item.workspace_id), [primary.workspace_id]);
  const extra = (await fixture.run(['tab', 'create', '--workspace', primary.workspace_id, '--cwd', '/fixture/repo', '--no-focus'])).result;
  assert.equal((await fixture.run(['pane', 'close', extra.root_pane.pane_id])).result.type, 'ok');
  const afterTab = (await fixture.read()).snapshot;
  assert.equal(afterTab.tabs.length, 1); assert.equal(afterTab.workspaces.length, 1);
  assert.equal(afterTab.workspaces[0].tab_count, 1);
  assert.equal((await fixture.run(['pane', 'close', afterTab.panes[0].pane_id])).result.type, 'ok');
  const afterLast = (await fixture.read()).snapshot;
  for (const field of ['panes', 'tabs', 'workspaces', 'agents']) assert.deepEqual(afterLast[field], []);
});

test('D0 synthetic tab/workspace/worktree results carry root identities and literal native argv', async t => {
  const fixture = await host(t);
  // Required fields from the installed protocol-22 success-response schema.
  const required = {
    root_pane: ['pane_id', 'terminal_id', 'workspace_id', 'tab_id', 'focused', 'agent_status', 'revision'],
    tab: ['tab_id', 'workspace_id', 'number', 'label', 'focused', 'pane_count', 'agent_status'],
    workspace: ['workspace_id', 'number', 'label', 'focused', 'pane_count', 'tab_count', 'active_tab_id', 'agent_status'],
    worktree: ['path', 'is_bare', 'is_detached', 'is_prunable', 'is_linked_worktree', 'label'],
  };
  for (const [args, type] of [
    [['tab', 'create', '--workspace', 'w1', '--cwd', '/fixture/repo', '--label', 'literal $()', '--no-focus'], 'tab_created'],
    [['workspace', 'create', '--cwd', '/fixture/other', '--label', 'other', '--no-focus'], 'workspace_created'],
    [['worktree', 'create', '--cwd', '/fixture/repo/src', '--branch', 'shep/example', '--label', 'task', '--no-focus', '--base', 'a'.repeat(40)], 'worktree_created'],
  ]) {
    const { result } = await fixture.run(args);
    assert.equal(result.type, type);
    assert.equal(result.root_pane.tab_id, result.tab.tab_id);
    assert.equal(result.root_pane.workspace_id, result.tab.workspace_id);
    assert.equal(result.root_pane.focused, false);
    for (const [key, fields] of Object.entries(required)) {
      if (result[key]) for (const field of fields) assert.ok(Object.hasOwn(result[key], field), `${type}.${key}.${field}`);
    }
    if (result.worktree) assert.equal(result.root_pane.cwd, result.worktree.path, 'Worktree starts at checkout root');
  }
  const state = await fixture.read(); const target = state.snapshot.panes.at(-1).pane_id;
  const layout = (await fixture.run(['pane', 'layout', '--pane', target])).result.layout;
  for (const key of ['workspace_id', 'tab_id', 'zoomed', 'area', 'focused_pane_id', 'panes', 'splits']) assert.ok(Object.hasOwn(layout, key));
  assert.equal(layout.panes[0].focused, false);
  const nativeArgs = ['--example-flag', 'literal $(no-shell)', '--cwd=/fixture/custom'];
  const start = await fixture.run(['agent', 'start', 'synthetic-agent', '--kind', 'codex', '--pane', target, '--timeout', '30000', '--', ...nativeArgs]);
  assert.deepEqual(start.result.argv, ['codex', ...nativeArgs]);
  const prompt = '--wait\n"quoted" $(not-executed) 羊';
  await fixture.run(['agent', 'prompt', target, prompt]);
  assert.deepEqual((await fixture.calls()).at(-1).args, ['agent', 'prompt', target, prompt]);
  assert.equal((await fixture.read()).snapshot.focused_pane_id, 'w1:p1');
});

test('D0 synthetic shared-state transactions keep concurrent creation identities distinct', async t => {
  const fixture = await host(t);
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => fixture.run(['tab', 'create', '--workspace', 'w1', '--cwd', '/fixture/repo', '--label', String(index), '--no-focus'])));
  assert.equal(new Set(results.map(result => result.result.root_pane.terminal_id)).size, 4);
  assert.equal((await fixture.read()).snapshot.panes.length, 5);
  assert.equal((await fixture.calls()).length, 4);
});

test('D0 scripted structured refusal has no default side effect and preserves stderr envelope', async t => {
  const fixture = await host(t, { steps: [{ id: 'refuse', match: { prefix: ['worktree', 'create'] }, error: { code: 'synthetic_trust_error' } }] });
  await assert.rejects(fixture.run(['worktree', 'create', '--cwd', '/fixture/repo']), error => {
    assert.equal(JSON.parse(error.stderr).error.code, 'synthetic_trust_error'); return true;
  });
  assert.equal((await fixture.read()).snapshot.panes.length, 1);
  assert.equal((await fixture.calls())[0].stepId, 'refuse');
});

test('D0 blocked prompt fixture returns documented agent_blocked without changing state or sending approval', async t => {
  const snapshot = makeSnapshot();
  snapshot.panes[0].agent_status = 'blocked';
  snapshot.agents = [{ ...snapshot.panes[0], agent: 'codex', name: 'Synthetic blocked agent', interactive_ready: false }];
  const fixture = await host(t, { snapshot });
  const argv = ['agent', 'prompt', snapshot.panes[0].pane_id, 'Literal fixture prompt $(not-executed)'];
  await assert.rejects(fixture.run(argv), error => {
    assert.equal(JSON.parse(error.stderr).error.code, 'agent_blocked');
    return true;
  });
  assert.deepEqual((await fixture.read()).snapshot, snapshot);
  assert.deepEqual((await fixture.calls()).map(item => item.args), [argv]);
});

test('D0 timeout after synthetic creation preserves the created pane without a second call', async t => {
  const fixture = await host(t);
  const entered = join(fixture.directory.root, 'entered'); const barrier = join(fixture.directory.root, 'release');
  await writeFile(fixture.script, JSON.stringify({ version: 1, steps: [{ id: 'created-no-ack', match: { prefix: ['tab', 'create'] }, effect: 'default', signalPath: entered, barrierPath: barrier }] }));
  const pending = fixture.run(['tab', 'create', '--workspace', 'w1', '--cwd', '/fixture/repo', '--no-focus'], { timeout: 350, killSignal: 'SIGKILL' });
  const rejection = assert.rejects(pending, error => error.killed === true);
  const deadline = Date.now() + 1000;
  for (;;) {
    try { await stat(entered); break; } catch (error) { if (Date.now() > deadline) throw error; await wait(5); }
  }
  await rejection;
  assert.equal((await fixture.read()).snapshot.panes.length, 2);
  assert.equal((await fixture.calls()).length, 1);
  // The killed child had released its state lock before waiting at the barrier.
  assert.equal((await fixture.run(['api', 'snapshot'])).result.snapshot.panes.length, 2);
});

test('D0 all named modes remain explicit and synthetic', async t => {
  for (const mode of ['tab-create', 'workspace-create', 'worktree-create']) {
    const fixture = await host(t, { mode });
    const command = mode.replace('-create', '');
    assert.equal((await fixture.run([command, 'create', '--workspace', 'w1', '--cwd', '/fixture/repo', '--no-focus'])).result.type, `${command}_created`);
  }
  const echo = await host(t, { mode: 'argv-echo' });
  assert.deepEqual((await echo.run(['agent', 'prompt', 'w1:p1', 'x; $(no-shell)'])).result.argv, ['agent', 'prompt', 'w1:p1', 'x; $(no-shell)']);
  const untrusted = await host(t, { mode: 'worktree-untrusted' });
  const before = (await untrusted.run(['api', 'snapshot'])).result.snapshot;
  await assert.rejects(untrusted.run(['worktree', 'create', '--cwd', '/fixture/repo']), error => {
    const envelope = JSON.parse(error.stderr);
    assert.equal(envelope.id, 'cli:worktree:create');
    assert.equal(envelope.error.code, 'worktree_create_failed');
    assert.equal(envelope.error.message.split('\n')[0], "fatal: detected dubious ownership in repository at '/fixture/repo'");
    return true;
  });
  const refusalState = await untrusted.read();
  assert.equal(refusalState.worktrees.length, 0);
  assert.deepEqual(refusalState.snapshot, before);
  assert.deepEqual(refusalState.scaffolding, [
    { path: join(untrusted.directory.home, '.herdr'), type: 'directory', entries: ['worktrees'] },
    { path: join(untrusted.directory.home, '.herdr/worktrees'), type: 'directory', entries: ['repo'] },
    { path: join(untrusted.directory.home, '.herdr/worktrees/repo'), type: 'directory', entries: [] },
  ]);
  assert.equal((await untrusted.run(['worktree', 'create', '--cwd', '/fixture/repo', '--trust-repository'])).result.type, 'worktree_created');
  assert.equal((await untrusted.read()).worktrees.length, 1);
  const notification = await host(t, { mode: 'notify-fail' });
  await assert.rejects(notification.run(['notification', 'show', 'Synthetic']), error => JSON.parse(error.stderr).error.code === 'fixture_notification_failed');
  const dirty = await host(t, { mode: 'worktree-remove-dirty' });
  const created = (await dirty.run(['worktree', 'create', '--cwd', '/fixture/repo'])).result;
  const beforeDirty = (await dirty.read()).snapshot;
  await assert.rejects(dirty.run(['worktree', 'remove', '--workspace', created.workspace.workspace_id]), error => {
    const envelope = JSON.parse(error.stderr);
    assert.equal(envelope.error.code, 'dirty_worktree_requires_force');
    assert.equal(envelope.error.message, `fatal: '${created.worktree.path}' contains modified or untracked files, use --force to delete it`);
    return true;
  });
  assert.equal((await dirty.read()).worktrees.length, 1);
  assert.deepEqual((await dirty.read()).snapshot, beforeDirty);
  assert.equal((await dirty.run(['worktree', 'remove', '--workspace', created.workspace.workspace_id, '--force'])).result.forced, true);
  assert.equal((await dirty.read()).worktrees.length, 0);
});
