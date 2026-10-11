import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/control.mjs';
import { getHerdrContext, normalizeSnapshot } from '../src/herdr.mjs';
import { DEFAULT_CONFIG, validateOutcome } from '../src/dispatch/contracts.mjs';
import { makeSnapshot, makeProject, createFakeRegistry, deferred } from './helpers/dispatch-fakes.mjs';

const clone = structuredClone;
const sha = 'a'.repeat(40);
const error = (code, privateMessage) => Object.assign(new Error(privateMessage || 'PRIVATE fixture detail'), { code, privateMessage });
const trustMessage = root => `fatal: detected dubious ownership in repository at '${root}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${root}`;
async function fixture(t, { beforeRun, afterRun, gitOverride, projectPatch, snapshotPatch, settings } = {}) {
  const temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'shep-targets-')));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'repo'), home = join(temp, 'home'), bin = join(temp, 'bin');
  await Promise.all([fs.mkdir(join(root, '.git'), { recursive: true }), fs.mkdir(join(root, 'src'), { recursive: true }), fs.mkdir(home), fs.mkdir(bin)]);
  await fs.writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const project = makeProject({ root, commonDir: join(root, '.git'), key: `git:${join(root, '.git')}`, ...projectPatch });
  if (project.kind === 'folder') { project.key = `dir:${root}`; project.commonDir = null; }
  const snapshot = makeSnapshot(snapshotPatch);
  snapshot.panes[0].cwd = root; snapshot.panes[0].foreground_cwd = root;
  const registry = createFakeRegistry({ projects: [project] });
  const config = clone(DEFAULT_CONFIG); if (settings) Object.assign(config, settings);
  const calls = [], gitCalls = [], worktrees = [], branches = new Set(), notices = [];
  let sequence = 10, random = 1;
  const context = getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: join(temp, 'host.sock'), HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', PATH: bin, HOME: home });
  const f = { temp, root, home, snapshot, registry, project, config, calls, gitCalls, worktrees, branches, notices };
  const git = async (argv, options) => {
    gitCalls.push({ argv: [...argv], options });
    const custom = await gitOverride?.(argv, options, f); if (custom !== undefined) return custom;
    let stdout = '', code = 0;
    if (argv.includes('--show-toplevel')) stdout = root + '\n';
    else if (argv.includes('--git-common-dir')) stdout = join(root, '.git') + '\n';
    else if (argv[0] === 'rev-parse') stdout = sha + '\n';
    else if (argv[0] === 'show-ref') code = branches.has(argv.at(-1).replace('refs/heads/', '')) ? 0 : 1;
    else if (argv[0] === 'for-each-ref') stdout = [...branches].sort().join('\n');
    else if (argv[0] === 'worktree') stdout = JSON.stringify(worktrees.map(w => [w.path, w.branch]));
    else throw new Error('Unexpected Git read');
    return { code, stdout, stderr: '' };
  };
  const run = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    const injected = await beforeRun?.(argv, f, options); if (injected !== undefined) return injected;
    const command = argv.slice(0, 2).join(' ');
    const flag = name => argv[argv.indexOf(name) + 1];
    let result;
    if (['tab create', 'workspace create', 'worktree create', 'pane split'].includes(command)) {
      const n = sequence++, newWorkspace = ['workspace create', 'worktree create'].includes(command);
      const workspaceId = newWorkspace ? `w${n}` : command === 'pane split' ? snapshot.panes.find(p => p.pane_id === flag('--pane')).workspace_id : flag('--workspace');
      const tabId = command === 'pane split' ? snapshot.panes.find(p => p.pane_id === flag('--pane')).tab_id : `${workspaceId}:t${n}`;
      let cwd = flag('--cwd');
      if (command === 'worktree create') { cwd = join(temp, `checkout-${n}`); await fs.mkdir(cwd); }
      const pane = { pane_id: `${workspaceId}:p${n}`, terminal_id: `terminal-${n}`, workspace_id: workspaceId, tab_id: tabId, cwd, foreground_cwd: cwd, focused: false };
      const tab = { tab_id: tabId, workspace_id: workspaceId, number: n, label: flag('--label') };
      const workspace = { workspace_id: workspaceId, number: n, label: flag('--label'), active_tab_id: tabId, worktree: null };
      if (command === 'worktree create') workspace.worktree = { is_linked_worktree: true, checkout_path: cwd, repo_root: root, repo_key: join(root, '.git') };
      snapshot.panes.push(pane); if (command !== 'pane split') snapshot.tabs.push(tab); if (newWorkspace) snapshot.workspaces.push(workspace);
      result = command === 'pane split' ? { pane: clone(pane) } : { tab: clone(tab), root_pane: clone(pane), ...(newWorkspace ? { workspace: clone(workspace) } : {}) };
      if (command === 'worktree create') {
        const wt = { path: cwd, branch: flag('--branch'), open_workspace_id: workspaceId, is_linked_worktree: true };
        worktrees.push(wt); branches.add(wt.branch); result.worktree = clone(wt);
      }
    } else if (command === 'pane layout') {
      const pane = snapshot.panes.find(p => p.pane_id === flag('--pane'));
      result = { layout: { tab_id: pane.tab_id, workspace_id: pane.workspace_id, zoomed: false, panes: [{ pane_id: pane.pane_id, rect: { width: 140, height: 40 } }] } };
    } else if (command === 'agent start') {
      const pane = snapshot.panes.find(p => p.pane_id === flag('--pane'));
      const agent = { ...pane, agent: flag('--kind'), name: argv[2], agent_status: 'idle', interactive_ready: true, launch_pending: false };
      snapshot.agents.push(agent); result = { agent: clone(agent), argv: [agent.agent, ...(argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [])] };
    } else if (command === 'agent get' || command === 'agent prompt') {
      result = { agent: clone(snapshot.agents.find(a => a.pane_id === argv[2])) };
    } else if (command === 'agent focus') {
      snapshot.panes.forEach(p => { p.focused = p.pane_id === argv[2]; }); result = {};
    } else if (command === 'pane close') {
      snapshot.panes = snapshot.panes.filter(p => p.pane_id !== argv[2]); snapshot.agents = snapshot.agents.filter(p => p.pane_id !== argv[2]); result = { type: 'ok' };
    } else if (command === 'worktree list') result = { worktrees: clone(worktrees) };
    else if (command === 'worktree remove') {
      const workspaceId = flag('--workspace');
      worktrees.splice(worktrees.findIndex(w => w.open_workspace_id === workspaceId), 1);
      for (const key of ['workspaces', 'tabs', 'panes', 'agents']) snapshot[key] = snapshot[key].filter(p => p.workspace_id !== workspaceId);
      result = { workspace_id: workspaceId };
    } else if (command === 'notification show') result = {};
    else throw new Error('Unexpected command ' + command);
    return await afterRun?.(argv, f, { result }, options) ?? { result };
  };
  f.controller = createController({ context, delivery: 'type', monitor: { getSnapshot: () => ({ mode: 'live', source: { state: 'connected' } }) }, registry,
    getConfig: () => config, onNotice: message => notices.push(message), run, readRaw: async () => ({ result: { snapshot: clone(snapshot) } }), git,
    randomHex: length => (random++).toString(16).padStart(length, '0') });
  t.after(() => f.controller.dispose());
  f.request = (patch = {}) => ({ taskId: `task-${sequence}`, attemptId: `attempt-${sequence}`, name: `review-${sequence}`, provider: 'codex', prompt: 'Review this code', inputTask: 'Review this code', args: [],
    placement: { projectKey: project.key, root, mode: 'here', subfolder: '', label: 'Review code', placementStyle: 'tab' }, ...patch });
  return f;
}
const mutations = f => f.calls.filter(c => ['create', 'split', 'start', 'prompt', 'remove', 'close'].includes(c.argv[1]));
const creations = f => f.calls.filter(c => ['create', 'split'].includes(c.argv[1]));

for (const kind of ['tab', 'workspace']) for (const code of ['agent_prompt_stalled', 'timeout', 'agent_blocked']) {
  test(`${kind}: ${code} preserves the first prompt receipt and never resubmits`, async t => {
    const f = await fixture(t, { beforeRun: argv => { if (argv[1] === 'prompt') throw error(code); } });
    if (kind === 'workspace') f.snapshot.panes[0].foreground_cwd = f.temp;
    const request = f.request({ prompt: '--wait\nKeep this literal prompt exactly once.\t羊' });
    const result = await f.controller.dispatch(request);
    assert.equal(result.state, code === 'agent_blocked' ? 'needs_input' : 'uncertain');
    assert.equal(result.code, code); assert.equal(result.stage, 'prompt');
    if (code === 'agent_prompt_stalled') assert.equal(result.message, 'Prompt not picked up. Check the pane.');
    if (code === 'agent_blocked') assert.match(result.message, /prompt was not sent/);
    assert.equal(result.placement.targetKind, kind);
    assert.equal(result.created.panes[0].paneId, result.paneId);
    assert.equal(result.created.panes[0].terminalId, result.terminalId);
    assert.ok(f.snapshot.panes.some(pane => pane.pane_id === result.paneId && pane.terminal_id === result.terminalId));
    assert.deepEqual(validateOutcome(result), []);
    const promptCalls = f.calls.filter(call => call.argv[1] === 'prompt');
    assert.equal(promptCalls.length, 1); assert.equal(promptCalls[0].argv[3], request.prompt);
    assert.deepEqual(await f.controller.dispatch(request), result, 'The same completed attempt is returned without another send');
    assert.equal(f.calls.filter(call => call.argv[1] === 'prompt').length, 1);
    assert.equal(creations(f).length, 1);
    assert.ok(!f.calls.some(call => ['close', 'remove', 'send-keys', 'send-text'].includes(call.argv[1])));
    assert.doesNotMatch(result.message, /PRIVATE/);
  });
}

test('dispose during the first prompt wait preserves its receipt and sends nothing else', async t => {
  const entered = deferred(), release = deferred();
  let signal;
  const f = await fixture(t, { afterRun: async (argv, _f, response, options) => {
    if (argv[1] === 'prompt') { signal = options.signal; entered.resolve(); await release.promise; }
    return response;
  } });
  const request = f.request(), pending = f.controller.dispatch(request);
  await entered.promise;
  f.controller.dispose(); assert.equal(signal.aborted, true);
  release.resolve();
  const result = await pending;
  assert.equal(result.state, 'uncertain'); assert.equal(result.code, 'disposed');
  assert.equal(result.created.panes[0].paneId, result.paneId);
  assert.ok(f.snapshot.panes.some(pane => pane.pane_id === result.paneId));
  assert.equal(f.calls.filter(call => call.argv[1] === 'prompt').length, 1);
  assert.ok(!f.calls.some(call => ['close', 'remove', 'send-keys', 'send-text'].includes(call.argv[1])));
});

test('successful activity-wait replies preserve identity checks even after fast completion', async t => {
  for (const status of ['working', 'done', 'idle']) {
    const f = await fixture(t, { afterRun: (argv, _f, response) => {
      if (argv[1] === 'prompt') response.result.agent.agent_status = status;
      return response;
    } });
    const result = await f.controller.dispatch(f.request());
    assert.equal(result.state, 'submitted', status);
    assert.equal(f.calls.filter(call => call.argv[1] === 'prompt').length, 1);
  }
  const replaced = await fixture(t, { afterRun: (argv, _f, response) => {
    if (argv[1] === 'prompt') response.result.agent.terminal_id = 'replacement';
    return response;
  } });
  const result = await replaced.controller.dispatch(replaced.request());
  assert.equal(result.state, 'uncertain'); assert.equal(result.code, 'changed_target');
  assert.equal(replaced.calls.filter(call => call.argv[1] === 'prompt').length, 1);
  assert.ok(!replaced.calls.some(call => ['close', 'remove'].includes(call.argv[1])));
});

for (const kind of ['tab', 'workspace', 'worktree', 'split']) test(`${kind}: one creation, no-focus, exact args and prompt, complete owned receipt`, async t => {
  const f = await fixture(t);
  if (kind === 'workspace') { f.snapshot.panes[0].cwd = f.temp; f.snapshot.panes[0].foreground_cwd = f.temp; }
  const request = f.request(); request.placement.mode = kind === 'worktree' ? 'wt' : 'here'; request.placement.placementStyle = kind === 'split' ? 'split' : 'tab';
  request.args = ['--example', '$(literal)', "quoted 'arg'", '羊']; request.prompt = '--wait\n$(do not execute)\t羊';
  const progress = [];
  const result = await f.controller.dispatch(request, { onProgress: event => progress.push(event) });
  assert.equal(result.state, 'submitted', JSON.stringify(result)); assert.deepEqual(validateOutcome(result), []);
  assert.equal(result.placement.targetKind, kind); assert.equal(creations(f).length, 1);
  assert.ok(creations(f)[0].argv.includes('--no-focus'));
  assert.deepEqual(f.calls.find(c => c.argv[1] === 'start').argv.slice(-5), ['--', ...request.args]);
  assert.deepEqual(f.calls.find(c => c.argv[1] === 'prompt').argv, ['agent', 'prompt', result.paneId, request.prompt, '--wait', '--until', 'working', '--timeout', '6000']);
  assert.deepEqual(progress.map(e => e.stage), ['queued', 'target', 'start', 'prompt']);
  assert.ok(progress.every(e => e.taskId === request.taskId && e.attemptId === request.attemptId));
  if (kind === 'worktree') {
    assert.equal(creations(f)[0].argv[creations(f)[0].argv.indexOf('--base') + 1], sha);
    assert.equal(result.created.worktree.baseCommit, sha); assert.notEqual(result.placement.cwd, f.root);
  }
});

for (const kind of ['tab', 'workspace', 'worktree', 'split']) for (const stage of ['target', 'start', 'prompt']) for (const code of ['fixture_refusal', 'timeout', 'invalid_response']) {
  test(`${kind}/${stage}/${code}: no creation or prompt replay; receipt survives`, async t => {
    const f = await fixture(t, { afterRun: (argv, f, response) => {
      if ((stage === 'target' && ['create', 'split'].includes(argv[1])) || argv[1] === stage) throw error(code);
    } });
    if (kind === 'workspace') f.snapshot.panes[0].foreground_cwd = f.temp;
    const request = f.request(); request.placement.mode = kind === 'worktree' ? 'wt' : 'here'; request.placement.placementStyle = kind === 'split' ? 'split' : 'tab';
    const result = await f.controller.dispatch(request);
    assert.equal(result.state, code === 'fixture_refusal' && stage !== 'prompt' ? 'failed' : 'uncertain');
    assert.equal(result.stage, stage); assert.equal(creations(f).length, 1);
    assert.ok(!f.calls.some(c => ['close', 'remove'].includes(c.argv[1])));
    assert.ok(f.calls.filter(c => c.argv[1] === 'prompt').length <= 1);
    if (stage !== 'target') assert.equal(result.created.panes[0].paneId, result.paneId);
    assert.doesNotMatch(result.message, /PRIVATE/);
  });
}

test('args, intent and symlink escapes fail before mutation', async t => {
  const f = await fixture(t); await fs.symlink(f.temp, join(f.root, 'escape'));
  for (const patch of [{ args: ['a\n'] }, { args: ['x'.repeat(513)] }, { args: Array(33).fill('x') }, { placement: { ...f.request().placement, subfolder: 'escape' } }, { placement: { ...f.request().placement, root: f.temp } }]) {
    const result = await f.controller.dispatch(f.request({ ...patch, taskId: String(Math.random()) }));
    assert.equal(result.state, 'failed'); assert.equal(mutations(f).length, 0);
  }
});

test('required root notice waits for this acknowledgement before creation and disposal cancels it', async t => {
  const f = await fixture(t), entered = deferred(), flush = deferred();
  const request = f.request(); request.placement.mode = 'wt'; request.placement.subfolder = 'src';
  const pending = f.controller.dispatch(request, { onProgress: event => { if (event.noticeRequired) { assert.match(event.message, /subfolder src isn't applied/); entered.resolve(); return flush.promise; } } });
  await entered.promise; assert.equal(mutations(f).length, 0);
  flush.resolve(); const result = await pending; assert.equal(result.state, 'submitted'); assert.notEqual(result.placement.cwd, join(f.root, 'src'));
  const g = await fixture(t), reached = deferred();
  const req = g.request(); req.placement.mode = 'wt'; req.placement.subfolder = 'src';
  const stopped = g.controller.dispatch(req, { onProgress: event => { if (event.noticeRequired) { reached.resolve(); return new Promise(() => {}); } } });
  await reached.promise; g.controller.dispose(); assert.equal((await stopped).code, 'disposed'); assert.equal(mutations(g).length, 0);
});

for (const failure of ['missing', 'reject', 'timeout']) test(`required notice ${failure} fails before creation`, async t => {
  const f = await fixture(t); const request = f.request(); request.placement.mode = 'wt'; request.placement.subfolder = 'src';
  const options = failure === 'missing' ? {} : { onProgress: event => { if (event.noticeRequired) return failure === 'reject' ? Promise.reject(new Error('PRIVATE')) : new Promise(() => {}); } };
  const result = await f.controller.dispatch(request, options);
  assert.equal(result.code, 'prelaunch_notice_failed'); assert.equal(result.stage, 'target'); assert.equal(mutations(f).length, 0);
});

test('same-project creation locks, main-checkout reservations and 3-launch FIFO survive concurrent starts', async t => {
  const starts = [], entered = deferred(), gates = Array.from({ length: 4 }, deferred);
  const f = await fixture(t, { afterRun: async argv => { if (argv[1] === 'start') { const index = Number(argv[2].split('-').at(-1)); starts.push(argv[2]); if (starts.length === 3) entered.resolve(); await gates[index].promise; } } });
  const requests = Array.from({ length: 4 }, (_, i) => { const r = f.request({ taskId: `t${i}`, attemptId: `a${i}`, name: `agent-${i}` }); r.placement.mode = 'auto'; return r; });
  const pending = requests.map(r => f.controller.dispatch(r));
  await entered.promise;
  assert.equal(creations(f).length, 3); assert.equal(creations(f)[0].argv[0], 'tab'); assert.equal(creations(f)[1].argv[0], 'tab');
  assert.deepEqual([...starts].sort(), ['agent-0', 'agent-1', 'agent-2']);
  gates[1].resolve(); await pending[1];
  while (starts.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts[3], 'agent-3');
  gates.forEach(g => g.resolve());
  const results = await Promise.all(pending); assert.ok(results.every(r => r.state === 'submitted'));
  assert.equal(new Set(results.map(r => r.paneId)).size, 4); assert.equal(f.calls.filter(c => c.argv[1] === 'prompt').length, 4);
});

test('dispose rejects queued launch without mutation and coalesces repeated attempt IDs', async t => {
  const gate = deferred(), entered = deferred(); let count = 0;
  const f = await fixture(t, { afterRun: async argv => { if (argv[1] === 'start') { if (++count === 3) entered.resolve(); await gate.promise; } } });
  const requests = Array.from({ length: 4 }, (_, i) => f.request({ taskId: `task-${i}`, attemptId: `attempt-${i}`, name: `agent-${i}` }));
  const jobs = requests.map(r => f.controller.dispatch(r)); assert.equal(f.controller.dispatch(requests[0]), jobs[0]);
  await entered.promise; f.controller.dispose(); gate.resolve();
  const results = await Promise.all(jobs);
  assert.equal(results[3].state, 'failed'); assert.equal(results[3].code, 'disposed'); assert.equal(creations(f).length, 3);
  assert.equal(f.calls.filter(c => c.argv[1] === 'prompt').length, 0);
});

test('uncertain unready pane reservation no longer forces isolation before owner dismissal', async t => {
  let first = true;
  const f = await fixture(t, { afterRun: argv => { if (argv[1] === 'start' && first) { first = false; throw error('timeout'); } } });
  const request = f.request(); request.placement.mode = 'auto';
  const result = await f.controller.dispatch(request); assert.equal(result.state, 'uncertain');
  const next = f.request({ taskId: 'second', attemptId: 'second', name: 'second' }); next.placement.mode = 'auto';
  assert.equal((await f.controller.dispatch(next)).placement.mode, 'here');
  assert.equal(f.controller.dismissTask(request).state, 'dismissed');
  const last = f.request({ taskId: 'third', attemptId: 'third', name: 'third' }); last.placement.mode = 'auto';
  assert.equal((await f.controller.dispatch(last)).placement.mode, 'here');
});

test('branch collision uses new suffix and always passes captured base, no create on five collisions', async t => {
  let checks = 0;
  const f = await fixture(t, { gitOverride: argv => argv[0] === 'show-ref' ? { code: ++checks < 3 ? 0 : 1, stdout: '', stderr: '' } : undefined });
  const request = f.request(); request.placement.mode = 'wt';
  assert.equal((await f.controller.dispatch(request)).state, 'submitted'); assert.equal(checks, 3); assert.equal(creations(f).length, 1);
  const g = await fixture(t, { gitOverride: argv => argv[0] === 'show-ref' ? { code: 0, stdout: '', stderr: '' } : undefined });
  const r = g.request(); r.placement.mode = 'wt';
  assert.equal((await g.controller.dispatch(r)).code, 'branch_collision'); assert.equal(creations(g).length, 0);
});

test('qualified trust refusal reconciles empty scaffolding; exact persisted consent permits one retry', async t => {
  const f = await fixture(t, { beforeRun: async (argv, f) => {
    if (argv[0] === 'worktree' && argv[1] === 'create' && !argv.includes('--trust-repository')) {
      await fs.mkdir(join(f.home, '.herdr', 'worktrees', 'repo'), { recursive: true });
      throw error('worktree_create_failed', trustMessage(f.root));
    }
  } });
  const request = f.request(); request.placement.mode = 'wt';
  const first = await f.controller.dispatch(request); assert.equal(first.state, 'needs_confirmation', JSON.stringify(first));
  assert.equal((await f.controller.dispatch({ ...request, attemptId: 'not-consented' })).state, 'failed');
  f.config.worktrees.trustedRepos.push(f.root);
  const retry = await f.controller.dispatch({ ...request, attemptId: 'confirmed' });
  assert.equal(retry.state, 'submitted', JSON.stringify(retry)); assert.equal(creations(f).length, 2);
  assert.ok(creations(f)[1].argv.includes('--trust-repository')); assert.ok(f.gitCalls.some(c => c.options.trustedRoot === f.root));
});

for (const effect of ['branch', 'pane', 'file', 'wrong-message']) test(`trust refusal with ${effect} never offers retry`, async t => {
  const f = await fixture(t, { beforeRun: async (argv, f) => {
    if (argv[0] !== 'worktree' || argv[1] !== 'create') return;
    if (effect === 'branch') f.branches.add('unexpected');
    if (effect === 'pane') f.snapshot.panes.push({ ...f.snapshot.panes[0], pane_id: 'w1:unexpected', terminal_id: 'unexpected' });
    if (effect === 'file') { await fs.mkdir(join(f.home, '.herdr', 'worktrees', 'repo'), { recursive: true }); await fs.writeFile(join(f.home, '.herdr', 'worktrees', 'repo', 'unexpected'), 'x'); }
    throw error('worktree_create_failed', trustMessage(f.root) + (effect === 'wrong-message' ? '\nunknown message' : ''));
  } });
  const request = f.request(); request.placement.mode = 'wt';
  assert.equal((await f.controller.dispatch(request)).state, 'failed'); assert.equal(creations(f).length, 1);
});

test('preflight ownership refuses before creation; consent retries scoped reads only', async t => {
  const f = await fixture(t, { gitOverride: (argv, options, f) => options.trustedRoot ? undefined : { code: 128, stdout: '', stderr: trustMessage(f.root) } });
  const request = f.request(); request.placement.mode = 'wt';
  assert.equal((await f.controller.dispatch(request)).state, 'needs_confirmation'); assert.equal(creations(f).length, 0);
  f.config.worktrees.trustedRepos.push(f.root);
  assert.equal((await f.controller.dispatch({ ...request, attemptId: 'confirmed' })).state, 'submitted');
});

test('follow-up is literal once, blocked refuses, per-pane actions conflict but other targets proceed', async t => {
  let blockPrompt = false; const entered = deferred(), release = deferred();
  const f = await fixture(t, { beforeRun: async argv => { if (blockPrompt && argv[1] === 'prompt') { entered.resolve(); await release.promise; throw error('timeout'); } } });
  await f.controller.dispatch(f.request());
  const target = normalizeSnapshot({ result: { snapshot: f.snapshot } }).agents[0];
  f.snapshot.agents[0].agent_status = 'blocked';
  assert.equal((await f.controller.followUp({ target, text: 'Follow up' })).state, 'needs_input');
  f.snapshot.agents[0].agent_status = 'done'; blockPrompt = true;
  const pending = f.controller.followUp({ target, text: '--wait\nexact\t羊' }); await entered.promise;
  assert.equal((await f.controller.focus(target)).code, 'busy'); release.resolve();
  assert.equal((await pending).state, 'uncertain');
  assert.deepEqual(f.calls.filter(c => c.argv[1] === 'prompt').at(-1).argv, ['agent', 'prompt', target.paneId, '--wait\nexact\t羊']);
});

for (const blocker of ['path', 'branch', 'pane', 'terminal', 'tab', 'working', 'blocked']) test(`worktree cleanup refuses ${blocker} drift or unowned descendants`, async t => {
  const f = await fixture(t); const request = f.request(); request.placement.mode = 'wt';
  const launched = await f.controller.dispatch(request), wt = launched.created.worktree;
  const remove = { workspaceId: wt.workspaceId, path: wt.path, branch: wt.branch, force: false };
  if (blocker === 'path') remove.path += '/changed';
  if (blocker === 'branch') remove.branch += '-changed';
  if (blocker === 'pane') f.snapshot.panes.push({ ...f.snapshot.panes.at(-1), pane_id: 'new-pane', terminal_id: 'unowned' });
  if (blocker === 'terminal') f.snapshot.panes.at(-1).terminal_id = 'replacement';
  if (blocker === 'tab') f.snapshot.tabs.push({ ...f.snapshot.tabs.at(-1), tab_id: 'unowned-tab' });
  if (['working', 'blocked'].includes(blocker)) f.snapshot.agents.at(-1).agent_status = blocker;
  assert.equal((await f.controller.removeWorktree(remove)).state, 'failed');
  assert.equal(f.calls.filter(c => c.argv[1] === 'remove').length, 0);
});

test('owned clean removal verifies disappearance and retains branch; dirty requires explicit force', async t => {
  let dirty = true;
  const f = await fixture(t, { beforeRun: argv => { if (argv[1] === 'remove' && dirty && !argv.includes('--force')) throw error('dirty_worktree_requires_force'); } });
  const request = f.request(); request.placement.mode = 'wt';
  const launched = await f.controller.dispatch(request), wt = launched.created.worktree;
  const remove = { workspaceId: wt.workspaceId, path: wt.path, branch: wt.branch, force: false };
  assert.equal((await f.controller.removeWorktree(remove)).code, 'dirty_worktree_requires_force');
  assert.equal((await f.controller.removeWorktree({ ...remove, force: true })).state, 'removed');
  assert.ok(f.branches.has(wt.branch)); assert.ok(!f.gitCalls.some(c => c.argv.includes('-D') || c.argv.includes('-d')));
});

test('private snapshot requires complete topology and public shape remains unchanged', async t => {
  const f = await fixture(t);
  assert.ok(Array.isArray((await f.controller.getControlSnapshot()).tabs));
  const publicValue = normalizeSnapshot({ result: { snapshot: f.snapshot } }); assert.deepEqual(Object.keys(publicValue), ['version', 'agents']);
  delete f.snapshot.tabs;
  await assert.rejects(f.controller.getControlSnapshot());
});

for (const kind of ['tab', 'workspace', 'worktree', 'split']) test(`${kind}: an existing returned pane cannot confer launch or cleanup ownership`, async t => {
  const f = await fixture(t, { afterRun: (argv, f, response) => {
    if (!['create', 'split'].includes(argv[1])) return;
    const existing = f.snapshot.panes.find(p => p.pane_id === 'w1:p2');
    if (argv[1] === 'split') response.result.pane = clone(existing);
    else { response.result.root_pane = clone(existing); response.result.tab = clone(f.snapshot.tabs[0]); if (response.result.workspace) response.result.workspace = clone(f.snapshot.workspaces[0]); }
    return response;
  } });
  f.snapshot.panes.push({ ...f.snapshot.panes[0], pane_id: 'w1:p2', terminal_id: 'unowned-shell' });
  const request = f.request(); request.placement.mode = kind === 'worktree' ? 'wt' : 'here'; request.placement.placementStyle = kind === 'split' ? 'split' : 'tab';
  if (kind === 'workspace') f.snapshot.panes.forEach(p => { p.cwd = f.temp; p.foreground_cwd = f.temp; });
  const result = await f.controller.dispatch(request);
  assert.equal(result.code, 'invalid_response'); assert.equal(result.state, 'uncertain');
  assert.ok(!f.calls.some(c => ['start', 'prompt', 'remove'].includes(c.argv[1]))); assert.equal(result.created, undefined);
});

for (const field of ['workspace_id', 'tab_id', 'terminal_id']) test(`cleanup refuses contradictory or missing agent ${field}`, async t => {
  const f = await fixture(t); const request = f.request(); request.placement.mode = 'wt';
  const result = await f.controller.dispatch(request); const wt = result.created.worktree;
  f.snapshot.agents.at(-1).agent_status = 'working'; delete f.snapshot.agents.at(-1)[field];
  assert.equal((await f.controller.removeWorktree({ workspaceId: wt.workspaceId, path: wt.path, branch: wt.branch, force: true })).state, 'failed');
  assert.equal(f.calls.filter(c => c.argv[1] === 'remove').length, 0);
});

for (const sample of [
  { inputTask: 'Please\nimplement foo', label: 'Please', prompt: 'Please\nimplement foo', slug: 'implement-foo' },
  { inputTask: 'Please the a an to of in on and with please this that my our implement foo', label: 'Please the a an to of in on and with pleas…', prompt: 'Please the a an to of in on and with please this that my our implement foo', slug: 'implement-foo' },
  { inputTask: 'parse a message', label: 'parse a message', prompt: 'Add unit tests for parse a message. Follow repository conventions.', slug: 'parse-message' },
  { inputTask: 'repair parser', label: 'repair parser', prompt: 'repair parser', name: 'owner-custom-name', slug: 'repair-parser' },
]) test(`worktree branch names use original task: ${sample.slug}/${sample.label.slice(0, 12)}`, async t => {
  const f = await fixture(t); const request = f.request({ inputTask: sample.inputTask, prompt: sample.prompt, ...(sample.name ? { name: sample.name } : {}) });
  request.placement.mode = 'wt'; request.placement.label = sample.label;
  const result = await f.controller.dispatch(request); assert.equal(result.state, 'submitted');
  assert.match(result.created.worktree.branch, new RegExp(`^shep/${sample.slug}-[a-f0-9]{4}$`));
  assert.equal(f.calls.find(c => c.argv[1] === 'prompt').argv[3], sample.prompt);
  if (sample.name) assert.equal(result.agentName, sample.name);
});

test('missing or invalid original task is refused on modern requests before creation', async t => {
  const f = await fixture(t);
  for (const inputTask of [undefined, '', 'x\x1b', 'x'.repeat(65537)]) {
    const result = await f.controller.dispatch(f.request({ inputTask, taskId: String(Math.random()) }));
    assert.equal(result.state, 'failed'); assert.equal(mutations(f).length, 0);
  }
});

test('an implicit primary workspace is shared and never becomes a cleanup receipt', async t => {
  const f = await fixture(t, { afterRun: (argv, f) => {
    if (argv[0] === 'worktree' && argv[1] === 'create') {
      f.snapshot.workspaces.push({ workspace_id: 'w99', number: 99, active_tab_id: 'w99:t1', label: 'Shared primary', worktree: {
        is_linked_worktree: false, checkout_path: f.root, repo_root: f.root, repo_key: join(f.root, '.git') } });
      f.snapshot.tabs.push({ tab_id: 'w99:t1', workspace_id: 'w99', number: 1 });
      f.snapshot.panes.push({ pane_id: 'w99:p1', terminal_id: 'implicit-primary', tab_id: 'w99:t1', workspace_id: 'w99', cwd: f.root });
    }
  } });
  const request = f.request(); request.placement.mode = 'wt';
  const result = await f.controller.dispatch(request); assert.equal(result.state, 'submitted');
  assert.notEqual(result.created.workspaceId, 'w99'); assert.ok(result.created.panes.every(p => p.workspaceId !== 'w99'));
  const wt = result.created.worktree;
  assert.equal((await f.controller.removeWorktree({ workspaceId: 'w99', path: f.root, branch: wt.branch, force: true })).code, 'unowned_worktree');
  assert.equal((await f.controller.removeWorktree({ workspaceId: wt.workspaceId, path: wt.path, branch: wt.branch, force: false })).state, 'removed');
  assert.ok(f.snapshot.panes.some(p => p.terminal_id === 'implicit-primary'));
});

test('uncertain workspace creation reserves its destination even before its pane appears', async t => {
  let uncertain = true;
  const f = await fixture(t, { beforeRun: argv => { if (argv[0] === 'workspace' && argv[1] === 'create' && uncertain) { uncertain = false; throw error('timeout'); } } });
  f.snapshot.panes[0].foreground_cwd = f.temp;
  const first = f.request();
  assert.equal((await f.controller.dispatch(first)).state, 'uncertain');
  const second = f.request({ taskId: 'second', attemptId: 'second', name: 'second' });
  assert.equal((await f.controller.dispatch(second)).code, 'placement_pending'); assert.equal(creations(f).length, 1);
  assert.equal(f.controller.dismissTask(first).state, 'dismissed');
  assert.equal((await f.controller.dispatch(f.request({ taskId: 'third', attemptId: 'third', name: 'third' }))).state, 'submitted');
});

test('notification failure stays nonfatal and produces only one sanitized session notice', async t => {
  const f = await fixture(t, { beforeRun: argv => { if (argv[0] === 'notification') throw error('fixture_failure', 'PRIVATE'); } });
  for (let i = 0; i < 3; i += 1) await f.controller.notify({ title: 'Finished\x1b[2J', body: 'A\nB', sound: 'done' });
  assert.equal(f.notices.length, 1); assert.doesNotMatch(f.notices[0], /PRIVATE/);
  const argv = f.calls[0].argv; assert.deepEqual(argv, ['notification', 'show', 'Finished', '--body', 'A B', '--sound', 'done']);
});

test('an in-flight prompt blocks its own pane while another pane remains focusable', async t => {
  let heldPane = null; const gate = deferred(), entered = deferred();
  const f = await fixture(t, { beforeRun: async argv => { if (argv[1] === 'prompt' && argv[2] === heldPane) { entered.resolve(); await gate.promise; } } });
  await f.controller.dispatch(f.request());
  await f.controller.dispatch(f.request({ taskId: 'other', attemptId: 'other', name: 'other' }));
  const [first, second] = normalizeSnapshot({ result: { snapshot: f.snapshot } }).agents;
  heldPane = first.paneId;
  const pending = f.controller.followUp({ target: first, text: 'Follow up once' }); await entered.promise;
  assert.equal((await f.controller.focus(first)).code, 'busy'); assert.equal((await f.controller.focus(second)).state, 'focused');
  gate.resolve(); assert.equal((await pending).state, 'submitted');
});
