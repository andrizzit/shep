import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { renderToString } from 'ink';
import { createTuiModel } from '../src/tui-model.mjs';
import { TuiView, noticeLines, startTui } from '../src/tui.mjs';
import { deferredCommand, displayArgs, commandSuggestions } from '../src/tui-tasks.mjs';
import { resolvePlacement } from '../src/placement.mjs';
import { DEFAULT_CONFIG } from '../src/dispatch/contracts.mjs';
import { createFakeRegistry, makeProject, deferred } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const project = makeProject();
async function setup(options = {}) {
  let snapshot = { mode: 'live', updatedAt: new Date().toISOString(), source: { state: 'connected' }, agents: [] };
  let listener;
  const calls = [];
  const registry = options.registry || createFakeRegistry();
  const monitor = { getSnapshot: () => snapshot, subscribe: callback => { listener = callback; return () => { listener = null; }; }, refresh: async () => snapshot };
  const controller = {
    getProfiles: async () => ({ providers: ['codex', 'claude', 'grok'].map(id => ({ id, name: id, available: true })), workspaces: [], defaultCwd: '/fixture/shep', ownPaneId: 'own-pane', ownTerminalId: 'own-terminal' }),
    dispatch: async (request, { onProgress } = {}) => {
      calls.push(request);
      await onProgress?.({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString() });
      return { ok: true, state: 'submitted', message: 'Prompt submitted; awaiting live status.', taskId: request.taskId, attemptId: request.attemptId };
    }, ...options.controller,
  };
  const model = createTuiModel({ ...options, monitor, controller, registry });
  if (!options.skipReady) await model.ready;
  return { model, calls, registry, controller, publish(patch) { snapshot = { ...snapshot, ...patch }; listener?.(snapshot); } };
}

test('modern command sends literal task plus original input and project intent; no live status is invented', async t => {
  const { model, calls } = await setup(); t.after(model.destroy);
  model.paste('/dispatch claude@sh:  keep +wt, codex.fast and /test literal\n$(shell)');
  model.key('', { return: true }); await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  assert.equal(calls[0].prompt, ' keep +wt, codex.fast and /test literal\n$(shell)');
  assert.equal(calls[0].inputTask, calls[0].prompt);
  assert.equal(calls[0].placement.projectKey, project.key);
  assert.equal(calls[0].placement.mode, 'auto');
  assert.equal(model.getTasks()[0].live.status, null);
  assert.equal(model.getTasks()[0].launch.state, 'submitted');
  assert.equal(model.getSnapshot().boardView, 'tasks');
});

test('checkpoint gates only deferred syntax and keeps its draft without a task', async t => {
  const { model, calls } = await setup(); t.after(model.destroy);
  for (const command of ['/test codex: task', '/dispatch codex.fast: task', '/dispatch codex,claude: task']) {
    model.action('cancel'); model.paste(command); model.key('', { return: true }); await tick();
    assert.match(model.getSnapshot().notice.message, /checkpoint|not enabled/);
    assert.equal(model.getSnapshot().command, command);
  }
  assert.equal(calls.length, 0); assert.equal(model.getTasks().length, 0);
  model.action('cancel'); model.paste('/dispatch codex+wt: task'); model.key('', { return: true }); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].placement.mode, 'wt'); assert.equal(calls[0].prompt, 'task');
  assert.equal(deferredCommand('/dispatch codex: use +wt, .fast and /test'), null);
});

test('discovery remains asynchronous, preserves input, and never guesses a target', async t => {
  const waiting = deferred();
  const registry = createFakeRegistry({ overrides: { refresh: () => waiting.promise } });
  const { model, calls } = await setup({ registry, skipReady: true }); t.after(model.destroy);
  model.paste('/dispatch while projects load'); model.key('', { return: true });
  assert.equal(model.getSnapshot().command, '/dispatch while projects load');
  assert.match(model.getSnapshot().notice.message, /loading/);
  assert.equal(calls.length, 0);
  waiting.resolve(); await model.ready;
  model.key('', { return: true }); await tick(); assert.equal(calls.length, 1);
});

test('nonempty default argv needs first-use consent, hides values and transports originals', async t => {
  let config = structuredClone(DEFAULT_CONFIG);
  config.agents.codex = { args: ['--api-key=secret-value', 'literal $(not executed)'], profiles: {} };
  const { model, calls } = await setup({ getConfig: () => config }); t.after(model.destroy);
  model.paste('/dispatch first'); model.key('', { return: true }); await tick();
  assert.equal(calls.length, 0); assert.equal(model.getTasks().length, 0);
  assert.equal(model.getSnapshot().decision.kind, 'argv');
  const rendered = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width: 90, height: 30 }));
  assert.doesNotMatch(rendered, /secret-value|not executed/);
  assert.match(rendered, /value hidden/);
  model.key('y'); await tick();
  assert.deepEqual(calls[0].args, config.agents.codex.args);
  model.paste('/dispatch second'); model.key('', { return: true }); await tick(); assert.equal(calls.length, 2);
  config = structuredClone(config); config.agents.codex.args = ['--changed'];
  model.paste('/dispatch third'); model.key('', { return: true }); await tick();
  assert.equal(calls.length, 2); assert.equal(model.getSnapshot().decision.kind, 'argv');
  assert.equal(displayArgs(['--token=abc', 'secret']), '--token=<value hidden> <value hidden>');
});

test('trust candidate asks before the first task; exact-root approval refreshes then dispatches', async t => {
  const candidate = { kind: 'trust_required', root: project.root, name: project.name, aliases: project.aliases, source: 'config', path: project.root, message: 'Git ownership needs confirmation.' };
  let trusted = false;
  const roots = [];
  const registry = createFakeRegistry({ projects: [], trustRequired: [candidate], overrides: { refresh: () => trusted ? { projects: [project], trustRequired: [] } : undefined } });
  const { model, calls } = await setup({ registry, addTrustedRepo: async root => { roots.push(root); trusted = true; return { errors: [] }; } }); t.after(model.destroy);
  model.paste('/dispatch codex@sh: literal task'); model.key('', { return: true }); await tick();
  assert.equal(model.getSnapshot().decision.kind, 'trust'); assert.equal(model.getTasks().length, 0); assert.equal(calls.length, 0);
  model.key('', { return: true }); await tick(); assert.equal(roots.length, 0, 'Cancel is the default');
  model.key('', { return: true }); await tick(); model.key('y'); await tick();
  assert.deepEqual(roots, [project.root]); assert.equal(calls.length, 1); assert.equal(calls[0].prompt, 'literal task');
});

test('required location notice waits for its exact acknowledgement and retains full event', async t => {
  const flush = deferred(); const seen = []; let created = false;
  let model;
  const result = await setup({ acknowledgeNotice: async token => { seen.push(token); await flush.promise; }, controller: {
    getProfiles: async () => ({ providers: [{ id: 'codex', name: 'Codex', available: true }], workspaces: [], defaultCwd: project.root + '/src/api' }),
    dispatch: async (request, { onProgress }) => {
      await onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString(), placement: { mode: 'worktree', reason: 'Busy main checkout' }, noticeRequired: true,
        message: `Worktree starts at the repository root; subfolder ${request.placement.subfolder} isn't applied` });
      created = true;
      return { ok: true, state: 'submitted', message: 'Sent', taskId: request.taskId, attemptId: request.attemptId };
    },
  } }); model = result.model; t.after(model.destroy);
  model.paste('/dispatch task'); model.key('', { return: true }); await tick();
  assert.equal(created, false); assert.equal(seen.length, 1);
  const required = model.getSnapshot().requiredNotice;
  assert.equal(required.token, seen[0]); assert.match(required.event.message, /subfolder src\/api isn't applied/);
  model.showNotice('Unrelated notification');
  assert.equal(model.getSnapshot().requiredNotice.token, required.token);
  flush.resolve(); await tick(); assert.equal(created, true); assert.equal(model.getSnapshot().requiredNotice, null);
});

test('long-path compact notice preserves complete consequence and exact original event', () => {
  const path = 'subfolder/'.repeat(70);
  const state = { requiredNotice: { subfolder: path, event: { message: `Worktree starts at the repository root; subfolder ${path} isn't applied` } } };
  const lines = noticeLines(state, 39);
  assert.match(lines.slice(0, -1).join(' '), /Worktree starts at repository root; selected subfolder is not applied/);
  assert.match(lines.at(-1), /^Path: .*…$/);
  assert.equal(state.requiredNotice.subfolder, path);
  assert(lines.every(line => line.length <= 37));
});

test('session-only recall restores draft; Enter never accepts suggestions', async t => {
  const { model, calls } = await setup(); t.after(model.destroy);
  model.paste('/dispatch first'); model.key('', { return: true }); await tick();
  model.paste('/dispatch draft'); model.key('', { upArrow: true });
  assert.equal(model.getSnapshot().command, '/dispatch first');
  model.key('', { escape: true }); assert.equal(model.getSnapshot().command, '/dispatch draft');
  model.action('cancel'); model.key('/dis'); model.key('', { return: true }); await tick(); assert.equal(calls.length, 1);
  model.key('', { tab: true }); assert.equal(model.getSnapshot().command, '/dispatch');
  assert.deepEqual(model.getSnapshot().recall, ['/dispatch first']);
});

test('missing public agent never closes a task while its private pane still exists', async t => {
  let present = true;
  const { model, publish } = await setup({ controller: {
    dispatch: async (request, { onProgress }) => {
      onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString() });
      return { ok: true, state: 'submitted', message: 'Sent', taskId: request.taskId, attemptId: request.attemptId, paneId: 'w1:p7', terminalId: 'terminal7' };
    }, getControlSnapshot: async () => ({ panes: present ? [{ pane_id: 'w1:p7', terminal_id: 'terminal7' }] : [], tabs: [], workspaces: [], agents: [] }),
  }, now: (() => { let time = Date.now(); return () => time += 1001; })() }); t.after(model.destroy);
  model.paste('/dispatch task'); model.key('', { return: true }); await tick();
  assert.equal(model.getTasks()[0].live.status, null);
  publish({ agents: [] }); await tick(); assert.equal(model.getTasks()[0].live.status, null);
  present = false; publish({ agents: [] }); await tick(); assert.equal(model.getTasks()[0].live.status, 'closed');
});


test('Ink flushes the complete long-path consequence at physical40×15 before creation', async t => {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, ref() {}, unref() {}, setRawMode(value) { this.isRaw = value; } });
  const writes = [];
  const output = new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } });
  Object.assign(output, { isTTY: true, columns: 40, rows: 15 });
  const long = 'deep-folder/'.repeat(50);
  const snapshot = { mode: 'live', updatedAt: new Date().toISOString(), source: { state: 'connected' }, agents: [] };
  let creationOutput = null;
  const controller = {
    getProfiles: async () => ({ providers: [{ id: 'codex', name: 'Codex', available: true }], workspaces: [], defaultCwd: project.root + '/' + long }),
    dispatch: async (request, { onProgress }) => {
      await onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString(), placement: { mode: 'worktree', reason: 'Busy main checkout' }, noticeRequired: true,
        message: `Worktree starts at the repository root; subfolder ${request.placement.subfolder} isn't applied` });
      creationOutput = stripVTControlCharacters(writes.join('')).replace(/\r?\n/g, '').replace(/ +/g, ' ');
      return { ok: true, state: 'submitted', message: 'Sent', taskId: request.taskId, attemptId: request.attemptId };
    },
  };
  const stop = startTui({ monitor: { getSnapshot: () => snapshot, subscribe: () => () => {} }, controller, registry: createFakeRegistry(), input, output });
  t.after(() => { stop(); input.destroy(); output.destroy(); });
  await stop.ready; input.write('/dispatch task\r');
  for (let attempt = 0; attempt < 50 && creationOutput === null; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert(creationOutput, 'The notice should fit and allow the native operation');
  assert.match(creationOutput, /Worktree starts at repository root; selected subfolder is not applied/);
  assert.match(creationOutput, /Path: /);
  assert.equal(stop.getTasks()[0].locationNotice.subfolder, long.replace(/\/$/, ''));
});

test('unmount during required notice never acknowledges creation', async t => {
  const flush = deferred(); let created = false;
  const { model } = await setup({ acknowledgeNotice: () => flush.promise, controller: {
    dispatch: async (request, { onProgress }) => {
      await onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString(), placement: { mode: 'worktree', reason: 'Busy' }, noticeRequired: true, message: 'Start at repository root; selected subfolder is not applied' });
      created = true;
      return { ok: true, state: 'submitted', message: 'Sent', taskId: request.taskId, attemptId: request.attemptId };
    },
  } }); t.after(model.destroy);
  model.paste('/dispatch task'); model.key('', { return: true }); await tick();
  model.destroy(); flush.resolve(); await tick(); assert.equal(created, false);
});

test('a delayed topology response cannot close a newer task target', async t => {
  const oldRead = deferred(); let reads = 0; let launches = 0;
  const { model, publish } = await setup({ controller: {
    dispatch: async (request, { onProgress }) => {
      onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString() });
      launches += 1;
      return { ok: true, state: 'submitted', message: 'Sent', taskId: request.taskId, attemptId: request.attemptId, paneId: `w1:p${launches + 5}`, terminalId: `terminal${launches}` };
    }, getControlSnapshot: () => { reads += 1; return reads === 1 ? oldRead.promise : Promise.resolve({ panes: [], tabs: [], workspaces: [], agents: [] }); },
  }, now: (() => { let time = Date.now(); return () => time += 1001; })() }); t.after(model.destroy);
  model.paste('/dispatch first'); model.key('', { return: true }); await tick();
  assert.equal(reads, 1);
  model.paste('/dispatch second'); model.key('', { return: true }); await tick();
  assert.equal(model.getTasks().length, 2);
  oldRead.resolve({ panes: [], tabs: [], workspaces: [], agents: [] }); await tick();
  assert.equal(model.getTasks()[0].live.status, 'closed');
  assert.equal(model.getTasks()[1].live.status, null, 'A target created after the read needs fresh topology');
  publish({ agents: [] }); await tick(); assert.equal(model.getTasks()[1].live.status, 'closed');
});

test('summaries use actual target cwd, throttle ten seconds and reject reused agent sessions', async t => {
  let time = Date.now(); const summaries = []; let request;
  const { model, publish } = await setup({ now: () => time, summarize: async (cwd, options) => {
    summaries.push({ cwd, options });
    return { state: 'available', changedFiles: 2, insertions: 8, deletions: 3, commitsAhead: 0, at: new Date(time).toISOString() };
  }, controller: { dispatch: async (input, { onProgress }) => {
    request = input;
    onProgress({ taskId: input.taskId, attemptId: input.attemptId, stage: 'target', at: new Date(time).toISOString() });
    return { ok: true, state: 'submitted', message: 'Sent', taskId: input.taskId, attemptId: input.attemptId, paneId: 'w1:p7', terminalId: 'terminal7',
      placement: { mode: 'here', targetKind: 'tab', reason: 'Auto → here', cwd: project.root + '/src', notices: [] } };
  } } }); t.after(model.destroy);
  model.paste('/dispatch task'); model.key('', { return: true }); await tick();
  const agent = { id: 'terminal7', terminalId: 'terminal7', paneId: 'w1:p7', provider: 'codex', name: request.name, agentName: request.name, sessionId: 'native-session1', status: 'working', workspace: { path: project.root } };
  publish({ agents: [agent] }); await tick(); assert.equal(summaries.length, 0);
  publish({ agents: [{ ...agent, status: 'done' }] }); await tick();
  assert.equal(summaries.length, 1); assert.equal(summaries[0].cwd, project.root + '/src');
  assert.equal(model.getTasks()[0].target.sessionId, 'native-session1');
  publish({ agents: [{ ...agent, status: 'done' }] }); await tick(); assert.equal(summaries.length, 1);
  time += 10001;
  publish({ agents: [{ ...agent, sessionId: 'replacement-session', status: 'done' }] }); await tick(); assert.equal(summaries.length, 1);
  publish({ source: { state: 'disconnected' }, agents: [{ ...agent, status: 'done' }] }); await tick(); assert.equal(summaries.length, 1);
  publish({ source: { state: 'connected' }, agents: [{ ...agent, status: 'done' }] }); await tick(); assert.equal(summaries.length, 2);
  assert.equal(model.getTasks()[0].summary.changedFiles, 2);
});

test('stalled prompt warning survives live Idle, summary and focus while preserving draft without a launch hold', async t => {
  for (const source of ['command', 'compose']) {
    const requests = [], focused = []; let closed = 0;
    const message = 'Prompt not picked up. Check the pane.';
    const summary = { state: 'available', changedFiles: 0, insertions: 0, deletions: 0, commitsAhead: 0, at: new Date().toISOString() };
    const { model, publish } = await setup({ summarize: async () => summary, controller: {
      dispatch: async (request, { onProgress }) => {
        requests.push(request);
        await onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'prompt', at: new Date().toISOString() });
        return { ok: false, state: 'uncertain', code: 'agent_prompt_stalled', message, taskId: request.taskId, attemptId: request.attemptId,
          paneId: 'w1:p7', terminalId: 'terminal7', agentName: request.name,
          placement: { mode: 'here', targetKind: 'tab', reason: 'Auto → here', cwd: project.root, notices: [] } };
      },
      focus: async target => { focused.push(target); return { ok: true, state: 'focused', message: 'Focused.' }; },
      closeAgent: async () => { closed += 1; return { ok: true, state: 'closed', message: 'Closed.' }; },
    } }); t.after(model.destroy);
    const prompt = 'Keep this literal prompt.\n$(not-a-command)';
    if (source === 'command') model.paste('/dispatch codex: ' + prompt);
    else { model.action('new'); model.action('field', 'prompt'); model.paste(prompt); }
    const before = model.getSnapshot();
    const submit = () => source === 'command' ? model.key('', { return: true }) : model.key('s', { ctrl: true });
    submit(); await tick();
    assert.equal(model.getSnapshot().view, 'board');
    assert.equal(requests[0].prompt, prompt);
    assert.match(model.getSnapshot().notice.message, /^Needs you · Prompt not picked up\. Check the pane\./);
    assert.equal(model.getTasks()[0].launch.code, 'agent_prompt_stalled');

    const agent = { id: 'terminal7', terminalId: 'terminal7', paneId: 'w1:p7', provider: 'codex', name: requests[0].name,
      agentName: requests[0].name, sessionId: 'native-session7', status: 'idle', workspace: { path: project.root } };
    publish({ agents: [agent] }); await tick();
    assert.equal(model.getTasks()[0].live.status, 'idle');
    assert.equal(model.getTasks()[0].launch.state, 'uncertain');
    assert.deepEqual(model.getTasks()[0].summary, summary);
    if (source === 'compose') { submit(); await tick(); }
    assert.equal(requests.length, 1, 'Returning to the board must not resend a stalled prompt');
    model.action('focus-result'); await tick();
    assert.equal(focused.length, 1); assert.deepEqual(focused[0], agent);
    assert.equal(model.getSnapshot().notice.message, 'Focused.', 'Focus replaces the transient launch warning');
    assert.equal(Object.hasOwn(model.getSnapshot(), 'dispatchHold'), false);
    assert.deepEqual(model.getSnapshot().draft, { ...before.draft, prompt });
    assert.equal(model.getSnapshot().command, before.command);

    model.key('', { escape: true });
    // Below the split-panel threshold, only the task row can expose the warning.
    const board = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width: 87, height: 30 }));
    assert.match(board, /Needs you/);
    assert(board.includes(message), 'The row warning must remain visible instead of the Git summary');
    const compact = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width: 39, height: 14, offset: 1 }));
    assert.match(compact, /Needs you/); assert.match(compact, /Prompt not picked up\./);
    assert(readCompactDetail(model).includes('Startup: ' + message));
    assert.equal(requests.length, 1); assert.equal(closed, 0);
    assert.equal(Object.hasOwn(model.getSnapshot(), 'dispatchHold'), false);
    model.action('cancel'); model.paste('/dispatch A separate task'); model.key('', { return: true }); await tick();
    assert.equal(requests.length, 2, 'A separate launch needs no manual allowance');
  }
});

test('Other folder is session-only, preserves relative subfolder and never writes config', async t => {
  const picked = makeProject({ key: 'dir:/fixture/other', root: '/fixture/other', name: 'other', kind: 'folder', commonDir: null, sources: ['session'] });
  const registry = createFakeRegistry({ overrides: { registerEphemeral: path => path === '/fixture/other/src' ? { project: picked, subfolder: 'src' } : { error: 'Choose an existing absolute folder.', code: 'invalid_folder' } } });
  let writes = 0;
  const { model, calls } = await setup({ registry, addTrustedRepo: async () => { writes += 1; } }); t.after(model.destroy);
  model.action('new'); model.action('pick-project'); model.key('', { downArrow: true }); model.key('', { return: true });
  assert.equal(model.getSnapshot().view, 'folder');
  model.paste('/fixture/other/src'); model.key('', { return: true }); await tick();
  assert.equal(model.getSnapshot().view, 'compose');
  assert.equal(model.getSnapshot().draft.projectKey, picked.key); assert.equal(model.getSnapshot().draft.subfolder, 'src');
  model.action('field', 'prompt'); model.paste('literal task'); model.action('dispatch'); await tick();
  assert.equal(calls[0].placement.root, picked.root); assert.equal(calls[0].placement.subfolder, 'src');
  assert.equal(writes, 0); assert(registry.calls.some(call => call.method === 'registerEphemeral' && call.path === '/fixture/other/src'));
});

test('linked checkout context retains its own relative subfolder', async t => {
  const linked = makeProject({ worktrees: [{ path: '/fixture/shep-feature', workspaceId: 'w2', branch: 'feature' }] });
  const { model, calls } = await setup({ registry: createFakeRegistry({ projects: [linked], overrides: { containing: () => linked } }), controller: {
    getProfiles: async () => ({ providers: [{ id: 'codex', name: 'Codex', available: true }], workspaces: [], defaultCwd: '/fixture/shep-feature/src/api' }),
  } }); t.after(model.destroy);
  model.paste('/dispatch task'); model.key('', { return: true }); await tick();
  assert.equal(calls[0].placement.root, project.root); assert.equal(calls[0].placement.subfolder, 'src/api');
});

test('checkpoint panels fit 120×40,90×30,40×15 with their active controls visible', async t => {
  const { model } = await setup(); t.after(model.destroy);
  const { displayWidth } = await import('../src/terminal.mjs');
  const verify = (pattern, width, height) => {
    const text = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width, height }));
    assert(text.split('\n').length <= height, `${width}×${height} overflowed vertically`);
    assert(text.split('\n').every(line => displayWidth(line) <= width), `${width}×${height} overflowed horizontally`);
    assert.match(text, pattern); assert.match(text, /Quit/); return text;
  };
  for (const [width, height] of [[119, 39], [89, 29], [39, 14]]) {
    model.action('cancel'); verify(/TASKS/, width, height);
    model.action('new'); model.action('field', 'prompt');
    const compose = verify(/Dispatch agent/, width, height);
    if (width === 39) assert.match(compose, /Prev.*Next.*Back/);
    model.action('pick-project'); verify(/Other folder/, width, height);
    model.action('pick', 1); verify(/Use folder/, width, height);
    model.action('cancel'); model.action('cancel'); model.key('/dis');
    verify(/dispatch/, width, height);
  }
});

test('a timed-out required acknowledgement clears only its attempt and leaves input usable', async t => {
  let acknowledgements = 0, creations = 0, attempts = 0;
  const never = new Promise(() => {});
  const { model } = await setup({ acknowledgeNotice: () => ++acknowledgements === 1 ? never : Promise.resolve(), controller: {
    dispatch: async (request, { onProgress }) => {
      attempts += 1;
      const receipt = onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString(), placement: { mode: 'worktree', reason: 'Busy' }, noticeRequired: true, message: 'Worktree starts at repository root; selected subfolder is not applied' });
      if (attempts === 1) {
        receipt.then(() => { creations += 1; }, () => {});
        await tick();
        return { ok: false, state: 'failed', code: 'prelaunch_notice_failed', message: 'The location notice could not be displayed.', taskId: request.taskId, attemptId: request.attemptId };
      }
      await receipt; creations += 1;
      return { ok: true, state: 'submitted', message: 'Sent', taskId: request.taskId, attemptId: request.attemptId };
    },
  } }); t.after(model.destroy);
  model.paste('/dispatch first'); model.key('', { return: true }); await tick(); await tick();
  assert.equal(model.getSnapshot().requiredNotice, null); assert.equal(model.getSnapshot().busy, null);
  assert.equal(model.getTasks()[0].launch.state, 'failed'); assert.equal(creations, 0);
  model.key('', { escape: true }); model.action('new'); assert.equal(model.getSnapshot().view, 'compose');
  model.action('cancel'); model.paste('/dispatch deliberate new attempt'); model.key('', { return: true }); await tick();
  assert.equal(creations, 1); assert.equal(model.getTasks()[1].launch.state, 'submitted');
});

test('opening task detail refreshes a throttled summary while working; stale failures cannot overwrite', async t => {
  let time = Date.now(), request, count = 0;
  const pending = deferred();
  const { model, publish } = await setup({ now: () => time, summarize: async () => { count += 1; return pending.promise; }, controller: {
    dispatch: async (input, { onProgress }) => {
      request = input; onProgress({ taskId: input.taskId, attemptId: input.attemptId, stage: 'target', at: new Date(time).toISOString() });
      return { ok: true, state: 'submitted', message: 'Sent', taskId: input.taskId, attemptId: input.attemptId, paneId: 'w1:p7', terminalId: 'terminal7',
        placement: { mode: 'here', targetKind: 'tab', reason: 'Auto → here', cwd: project.root, notices: [] } };
    },
  } }); t.after(model.destroy);
  model.paste('/dispatch task'); model.key('', { return: true }); await tick();
  model.action('details'); await tick(); assert.equal(count, 1);
  model.action('cancel'); model.action('details'); await tick(); assert.equal(count, 1);
  publish({ agents: [{ id: 'terminal7', paneId: 'w1:p7', terminalId: 'terminal7', provider: 'codex', name: request.name, sessionId: 'bound-session', status: 'working', workspace: { path: project.root } }] });
  pending.reject(new Error('Late Git failure')); await tick();
  assert.equal(model.getTasks()[0].summary, null, 'A failure from before identity binding must not overwrite the current task');
});

test('compact Git-subfolder composer previews the root-only consequence without another confirmation', async t => {
  const { model, calls } = await setup(); t.after(model.destroy);
  model.action('new'); model.action('field', 'subfolder'); model.paste('src/api');
  model.action('field', 'prompt'); model.paste('task');
  const text = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width: 39, height: 14 }));
  assert.match(text, /If worktree: starts at repo root;/);
  assert.match(text, /selected subfolder isn't applied/);
  assert.match(text, /Dispatch agent/); assert.match(text, /Prev.*Next.*Back/);
  assert.equal(model.getSnapshot().decision, null); assert.equal(calls.length, 0);
});

test('ordinary long diagnostics have a full scrollable notice without losing the draft', async t => {
  const { model } = await setup(); t.after(model.destroy);
  const message = 'Config $: must contain valid JSON; file: /fixture/' + 'long-directory/'.repeat(15) + 'config.json';
  model.paste('/dispatch preserved'); model.showNotice(message, 'warning'); model.action('notice-open');
  assert.equal(model.getSnapshot().noticeDetail.message, message);
  const text = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width: 39, height: 14 }));
  assert.match(text, /NOTICE.*full message/); assert.match(text, /must contain valid JSON/); assert.match(text, /Back Esc/);
  model.key('', { downArrow: true }); assert.equal(model.getSnapshot().detailOffset, 1);
  model.key('', { escape: true }); model.action('command'); assert.equal(model.getSnapshot().command, '/dispatch preserved');
});

test('+here reaches placement despite a busy checkout, preserves literal text, and never changes the auto default', async t => {
  const requests = [], plans = [];
  const busySnapshot = { agents: [{ agent: 'codex', agent_status: 'working', canonical_cwd: project.root }], workspaces: [], panes: [] };
  const { model } = await setup({ controller: {
    getProfiles: async () => ({ providers: ['codex', 'claude'].map(id => ({ id, name: id, available: true })), workspaces: [], defaultCwd: project.root + '/src/api' }),
    dispatch: async (request, { onProgress }) => {
      requests.push(request); plans.push(resolvePlacement({ intent: request.placement, project, snapshot: busySnapshot }));
      onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString() });
      return { ok: true, state: 'submitted', message: 'Sent', taskId: request.taskId, attemptId: request.attemptId };
    },
  } }); t.after(model.destroy);
  const prompt = ' keep +wt, .fast and /test literal\n$(no-shell)';
  model.paste('/dispatch claude+here: ' + prompt); model.key('', { return: true }); await tick();
  assert.equal(requests.length, 1); assert.equal(requests[0].provider, 'claude');
  assert.equal(requests[0].prompt, prompt); assert.equal(requests[0].inputTask, prompt);
  assert.equal(requests[0].placement.mode, 'here'); assert.equal(requests[0].placement.subfolder, 'src/api');
  assert.equal(plans[0].mode, 'here'); assert.equal(plans[0].cwd, project.root + '/src/api');
  assert.equal(model.getTasks()[0].modeIntent, 'here'); assert.equal(model.getSnapshot().decision, null);

  model.paste('/dispatch @sh+here: explicit project'); model.key('', { return: true }); await tick();
  assert.equal(requests[1].provider, 'codex'); assert.equal(requests[1].placement.mode, 'here');
  assert.equal(requests[1].placement.subfolder, ''); assert.equal(plans[1].cwd, project.root);
  model.paste('/dispatch ordinary default'); model.key('', { return: true }); await tick();
  assert.equal(requests[2].placement.mode, 'auto'); assert.equal(plans[2].mode, 'here');
});

test('+here and +wt completion exposes no deferred agent workflows', async t => {
  const context = { providers: [{ id: 'codex', name: 'Codex', available: true }], projects: [project], config: DEFAULT_CONFIG };
  for (const command of ['/dispatch codex+', '/dispatch codex@sh+h', '/dispatch @sh+']) {
    const suggestions = commandSuggestions(command, command.length, context);
    assert.deepEqual(suggestions.map(item => item.value), command.endsWith('+h') ? ['here'] : ['wt', 'here']);
  }
  assert.deepEqual(commandSuggestions('/dispatch codex+wt', 17, context).map(item => item.value), ['wt']);
  for (const command of ['/dispatch codex.fast+', '/dispatch codex,claude+']) {
    assert.deepEqual(commandSuggestions(command, command.length, context), []);
  }
  const { model, calls } = await setup(); t.after(model.destroy);
  for (const command of ['/dispatch codex.fast+here: task', '/dispatch codex,claude+here: task', '/test codex+here: task']) {
    model.action('cancel'); model.paste(command); model.key('', { return: true }); await tick();
    assert.match(model.getSnapshot().notice.message, /checkpoint|not enabled/);
    assert.equal(model.getSnapshot().command, command);
  }
  assert.equal(calls.length, 0); assert.equal(model.getTasks().length, 0);
  model.action('cancel'); model.paste('/dispatch codex@sh+wt: task'); model.key('', { return: true }); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].placement.mode, 'wt'); assert.equal(calls[0].prompt, 'task');
});

// Read each content row through the real keyboard-scrollable detail at the
// physical40×15 minimum (39×14 content), retaining wrapped rows in order.
function readCompactDetail(model) {
  model.action('details');
  const content = [];
  for (let count = 0; count < 200; count += 1) {
    const rendered = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width: 39, height: 14 }));
    const rows = rendered.split('\n');
    const title = rows.findIndex(row => row.includes('│ TASK ·'));
    const position = rendered.match(/(\d+)–(\d+)\/(\d+)/);
    assert(position, 'Task detail must expose its scroll position');
    assert(rows.length <= 14); assert.match(rendered, /Back Esc/);
    const [, first, last, total] = position.map(Number);
    for (let index = first; index <= last; index += 1) content[index - 1] = rows[title + index - first + 1].slice(2, -2).trimEnd();
    if (last === total) return content.join('');
    model.key('', { downArrow: true });
  }
  assert.fail('The complete task detail was not reachable by scrolling');
}

test('created worktree detail exposes its full path and safe manual command at minimum size without cleanup', async t => {
  for (const workspaceId of ['w23', "w'23;$(no-shell)"]) {
    const checkout = '/fixture/shep-worktrees/' + 'long-directory/'.repeat(8) + 'actual-checkout';
    const baseCommit = 'a'.repeat(40); let cleanup = 0;
    const { model } = await setup({ controller: {
      dispatch: async (request, { onProgress }) => {
        onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString() });
        return { ok: true, state: 'submitted', message: 'Sent', taskId: request.taskId, attemptId: request.attemptId,
          paneId: 'created-pane', terminalId: 'created-terminal',
          placement: { mode: 'worktree', targetKind: 'worktree', reason: 'Busy checkout', cwd: checkout, notices: [], workspaceId, baseCommit },
          created: { workspaceId, tabIds: ['created-tab'], panes: [{ paneId: 'created-pane', terminalId: 'created-terminal', tabId: 'created-tab', workspaceId }],
            worktree: { workspaceId, repoCwd: project.root, path: checkout, branch: 'shep/task-abcd', baseCommit } } };
      }, removeWorktree: async () => { cleanup += 1; }, closeAgent: async () => { cleanup += 1; },
    } }); t.after(model.destroy);
    model.paste('/dispatch task'); model.key('', { return: true }); await tick();
    const text = readCompactDetail(model);
    assert(text.includes('Worktree path: ' + checkout), 'The confirmed full path must remain accessible');
    assert(text.includes('Manual removal in current Herdr instance:'));
    const argument = workspaceId === 'w23' ? 'w23' : "'w'\\''23;$(no-shell)'";
    assert(text.includes('herdr worktree remove --workspace ' + argument));
    assert.doesNotMatch(text, /--force|--trust-repository/);
    model.key('W'); model.key('', { escape: true }); assert.equal(cleanup, 0);
  }
});

test('placement or discovery alone never produces a manual removal command', async t => {
  const registry = createFakeRegistry({ projects: [makeProject({ worktrees: [{ path: '/fixture/existing-checkout', branch: 'user-owned', workspaceId: 'existing' }] })] });
  const { model } = await setup({ registry, controller: {
    dispatch: async (request, { onProgress }) => {
      onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString() });
      return { ok: true, state: 'submitted', message: 'Sent', taskId: request.taskId, attemptId: request.attemptId,
        placement: { mode: 'worktree', targetKind: 'worktree', reason: 'Existing checkout', cwd: '/fixture/existing-checkout', notices: [], workspaceId: 'existing', baseCommit: 'a'.repeat(40) } };
    },
  } }); t.after(model.destroy);
  model.paste('/dispatch task'); model.key('', { return: true }); await tick();
  const text = readCompactDetail(model);
  assert.match(text, /Actual cwd: \/fixture\/existing-checkout/);
  assert.doesNotMatch(text, /herdr worktree remove|Manual removal/);
});
