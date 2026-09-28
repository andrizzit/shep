import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { renderToString } from 'ink';
import { createTuiModel } from '../src/tui-model.mjs';
import { TuiView, noticeLines, startTui } from '../src/tui.mjs';
import { deferredCommand, displayArgs } from '../src/tui-tasks.mjs';
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
  for (const command of ['/test codex: task', '/dispatch codex.fast: task', '/dispatch codex,claude: task', '/dispatch codex+wt: task']) {
    model.action('cancel'); model.paste(command); model.key('', { return: true }); await tick();
    assert.match(model.getSnapshot().notice.message, /checkpoint|not enabled/);
    assert.equal(model.getSnapshot().command, command);
  }
  assert.equal(calls.length, 0); assert.equal(model.getTasks().length, 0);
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
    }, getControlSnapshot: async () => ({ panes: present ? [{ pane_id: 'w1:p7', terminal_id: 'terminal7' }] : [] }),
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
