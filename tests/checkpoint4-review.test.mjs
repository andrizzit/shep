import test from 'node:test';
import assert from 'node:assert/strict';
import { createTuiModel } from '../src/tui-model.mjs';
import { deferredCommand } from '../src/tui-tasks.mjs';
import { DEFAULT_CONFIG } from '../src/dispatch/contracts.mjs';
import { createFakeRegistry, makeProject } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const project = makeProject();
const providers = ['codex', 'claude', 'pi'].map(id => ({ id, name: id, available: true }));
const context = { providers, projects: [project], config: DEFAULT_CONFIG };
async function setup(t, { config = DEFAULT_CONFIG, dispatch } = {}) {
  let snapshot = { mode: 'live', updatedAt: new Date().toISOString(), source: { state: 'connected' }, agents: [] }, listener;
  const calls = [], panes = [];
  const controller = {
    getProfiles: async () => ({ providers, workspaces: [], defaultCwd: project.root, ownPaneId: 'own-pane', ownTerminalId: 'own-terminal' }),
    dispatch: async (request, { onProgress }) => {
      calls.push({ method: 'dispatch', request });
      await onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString() });
      return { taskId: request.taskId, attemptId: request.attemptId, ...(dispatch ? dispatch(request) : { ok: true, state: 'submitted', message: 'Submitted.' }) };
    },
    getControlSnapshot: async () => ({ panes: structuredClone(panes), agents: [], workspaces: [], tabs: [] }),
    dismissTask: request => { calls.push({ method: 'dismissTask', request }); return { ok: true, state: 'dismissed', message: 'Cleared.' }; },
    closeAgent: async target => { calls.push({ method: 'closeAgent', target }); return { ok: true, state: 'closed', message: 'Closed.' }; },
  };
  const model = createTuiModel({ monitor: { getSnapshot: () => snapshot, subscribe: fn => { listener = fn; return () => { listener = null; }; } },
    controller, registry: createFakeRegistry(), getConfig: () => config });
  t.after(model.destroy); await model.ready;
  return { model, calls, panes, publish(patch) { snapshot = { ...snapshot, ...patch }; listener?.(snapshot); } };
}

for (const command of [
  '/dispatch codex.md is outdated, update it',
  '/dispatch claude.md needs a section',
  '/dispatch pi.js is broken',
]) test(`checkpoint4 literal filename: ${command}`, async t => {
  assert.equal(deferredCommand(command, context), null);
  const { model, calls } = await setup(t);
  model.paste(command); model.key('', { return: true }); model.key('', { return: true }); await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.provider, 'codex');
  assert.equal(calls[0].request.prompt, command.slice('/dispatch '.length));
  assert.equal(calls[0].request.inputTask, calls[0].request.prompt);
  assert.equal(calls[0].request.placement.projectKey, project.key);
});

test('checkpoint4 defers configured profiles and explicit syntax, while unknown dotted suffixes stay literal', async t => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.agents.codex = { args: [], profiles: { fast: { args: [] }, md: { args: [] } } };
  const configured = { ...context, config };
  const { model, calls } = await setup(t, { config });
  for (const prefix of ['codex.fast', 'codex.md', 'codex.md+here', 'codex.missing@shep', 'claude.fast@missing', 'codex.md,claude', 'pi.js+wt']) {
    const command = `/dispatch ${prefix} preserve this task`;
    assert.equal(deferredCommand(command, configured), deferredCommand(`/dispatch ${prefix}: preserve this task`, configured));
    model.action('cancel'); model.paste(command); model.key('', { return: true }); await tick();
    assert.match(model.getSnapshot().notice.message, /not enabled|deferred/);
    assert.equal(model.getSnapshot().command, command);
  }
  assert.equal(calls.length, 0); assert.equal(model.getTasks().length, 0);
  for (const literal of ['codex.missing is literal', 'claude.fast has no configured profile', 'codex.md.bak stays literal', 'pi.constructor stays literal', 'pi.js+here stays literal']) {
    assert.equal(deferredCommand('/dispatch ' + literal, configured), null);
    model.action('cancel'); model.paste('/dispatch ' + literal); model.key('', { return: true }); await tick();
    assert.equal(calls.at(-1).request.provider, 'codex'); assert.equal(calls.at(-1).request.prompt, literal);
  }
  assert.equal(calls.length, 5);
  for (const prefix of ['codex@shep+wt', '@shep+wt']) {
    const command = `/dispatch ${prefix} preserve this task`;
    assert.equal(deferredCommand(command, configured), null);
    model.action('cancel'); model.paste(command); model.key('', { return: true }); await tick();
    assert.equal(calls.at(-1).request.placement.mode, 'wt'); assert.equal(calls.at(-1).request.prompt, 'preserve this task');
  }
  assert.equal(calls.length, 7);
});

test('checkpoint4 preserves strict colon refusals and literal text after a valid colon prefix', async t => {
  const { model, calls } = await setup(t);
  for (const prefix of ['codex.md', 'claude.fast', 'codex,claude']) {
    const command = `/dispatch ${prefix}: task`;
    assert.match(deferredCommand(command, context), /not enabled|deferred/);
    model.action('cancel'); model.paste(command); model.key('', { return: true }); await tick();
  }
  assert.equal(calls.length, 0);
  const literal = ' codex.md, claude.fast@shep and pi.js+wt\n$(literal)';
  model.action('cancel'); model.paste('/dispatch claude: ' + literal); model.key('', { return: true }); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].request.provider, 'claude'); assert.equal(calls[0].request.prompt, literal);
  model.paste('/dispatch codex+wt: task'); model.key('', { return: true }); await tick();
  assert.equal(calls.length, 2); assert.equal(calls[1].request.placement.mode, 'wt'); assert.equal(calls[1].request.prompt, 'task');
});

test('checkpoint4 undetected retained panes have actionable Herdr guidance without widening x or clearing open panes', async t => {
  for (const receiptOnly of [false, true]) {
    const { model, calls, panes } = await setup(t, { dispatch: () => ({ ok: false, state: 'failed', message: 'Agent startup failed.',
      ...(receiptOnly ? { created: { tabIds: ['retained-tab'], panes: [{ paneId: 'retained-pane', terminalId: 'retained-terminal', tabId: 'retained-tab', workspaceId: 'w1' }] } }
        : { paneId: 'retained-pane', terminalId: 'retained-terminal' }) }) });
    panes.push({ pane_id: 'retained-pane', terminal_id: 'retained-terminal' });
    model.paste('/dispatch task'); model.key('', { return: true }); await tick(); model.action('cancel');
    model.key('x'); assert.equal(model.getSnapshot().view, 'board');
    assert.equal(model.getSnapshot().notice.message, 'Select an agent first.');
    model.key('c'); await tick();
    assert.equal(model.getSnapshot().notice.message, 'Pane retained-pane is still open, but no agent is detected. Close that pane in Herdr, then clear this task.');
    assert.equal(model.getTasks()[0].dismissed, false);
    assert.deepEqual(calls.map(call => call.method), ['dispatch']);
    panes.length = 0; model.key('c'); await tick();
    assert.equal(model.getTasks()[0].dismissed, true);
    assert.deepEqual(calls.map(call => call.method), ['dispatch', 'dismissTask']);
  }
});

test('checkpoint4 matching detected agents retain the existing x guidance', async t => {
  const { model, calls, panes, publish } = await setup(t, { dispatch: () => ({ ok: false, state: 'failed', message: 'Agent startup failed.', paneId: 'retained-pane', terminalId: 'retained-terminal' }) });
  panes.push({ pane_id: 'retained-pane', terminal_id: 'retained-terminal' });
  model.paste('/dispatch task'); model.key('', { return: true }); await tick(); model.action('cancel');
  const task = model.getTasks()[0];
  publish({ agents: [{ id: 'retained-terminal', paneId: 'retained-pane', terminalId: 'retained-terminal', provider: 'codex', name: task.name, agentName: task.name, status: 'idle', workspace: { path: project.root } }] });
  model.key('c'); await tick();
  assert.equal(model.getSnapshot().notice.message, 'This agent is still open. Close it with x first, or keep it.');
  assert.equal(model.getTasks()[0].dismissed, false);
  assert.deepEqual(calls.map(call => call.method), ['dispatch']);
});
