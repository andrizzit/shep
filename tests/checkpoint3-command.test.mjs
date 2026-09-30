import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { createTuiModel } from '../src/tui-model.mjs';
import { TuiView } from '../src/tui.mjs';
import { deferredCommand } from '../src/tui-tasks.mjs';
import { createFakeRegistry, makeProject } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const projects = [makeProject(), makeProject({ key: 'git:/fixture/folio/.git', root: '/fixture/folio', commonDir: '/fixture/folio/.git', name: 'folio', aliases: ['fo'] })];
const providers = [{ id: 'codex', name: 'Codex', available: true }, { id: 'claude', name: 'Claude', available: true }, { id: 'cursor', name: 'Cursor', available: false }];
async function setup(t) {
  const calls = [];
  const snapshot = { mode: 'live', updatedAt: new Date().toISOString(), source: { state: 'connected' }, agents: [] };
  const monitor = { getSnapshot: () => snapshot, subscribe: () => () => {}, refresh: async () => snapshot };
  const controller = {
    getProfiles: async () => ({ providers, workspaces: [], defaultCwd: projects[0].root, ownPaneId: 'own-pane', ownTerminalId: 'own-terminal' }),
    dispatch: async (request, { onProgress } = {}) => {
      calls.push(request);
      await onProgress?.({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString() });
      return { ok: true, state: 'submitted', message: 'Submitted.', taskId: request.taskId, attemptId: request.attemptId };
    },
  };
  const model = createTuiModel({ monitor, controller, registry: createFakeRegistry({ projects }) });
  t.after(model.destroy); await model.ready;
  return { model, calls };
}

test('checkpoint3: arrow selection wraps and Enter accepts without dispatching', async t => {
  const { model, calls } = await setup(t);
  model.paste('/dispatch c');
  assert.deepEqual(model.getSnapshot().suggestions.map(item => item.value), ['codex', 'claude']);
  model.key('', { upArrow: true }); assert.equal(model.getSnapshot().suggestionIndex, 1);
  model.key('', { downArrow: true }); assert.equal(model.getSnapshot().suggestionIndex, 0);
  model.key('', { downArrow: true }); model.key('', { return: true }); await tick();
  assert.equal(model.getSnapshot().command, '/dispatch claude'); assert.equal(calls.length, 0);
  assert.equal(model.getSnapshot().suggestionArrowMoved, false);
  model.key(' '); model.key('review this'); model.key('', { return: true }); await tick();
  assert.equal(calls.length, 1);
});

test('checkpoint3: editing resets arrow acceptance; Tab and Shift+Tab retain their behavior', async t => {
  const { model, calls } = await setup(t);
  model.paste('/dispatch cl'); model.key('', { downArrow: true }); model.key('x');
  assert.equal(model.getSnapshot().suggestionArrowMoved, false);
  model.key('', { return: true }); await tick();
  assert.equal(calls[0].prompt, 'clx');
  model.paste('/dispatch c'); model.key('', { tab: true, shift: true });
  assert.equal(model.getSnapshot().suggestionIndex, 1); assert.equal(model.getSnapshot().suggestionArrowMoved, false);
  model.key('', { return: true }); await tick(); assert.equal(calls[1].prompt, 'c');
  model.paste('/dispatch cl'); model.key('', { tab: true });
  assert.equal(model.getSnapshot().command, '/dispatch claude'); assert.equal(calls.length, 2);
});

test('checkpoint3: recall without suggestions and Escape restore the displaced draft', async t => {
  const { model, calls } = await setup(t);
  model.paste('/dispatch first task'); model.key('', { return: true }); await tick();
  model.paste('/dispatch unfinished draft'); assert.equal(model.getSnapshot().suggestions.length, 0);
  model.key('', { upArrow: true }); assert.equal(model.getSnapshot().command, '/dispatch first task');
  model.key('', { escape: true }); assert.equal(model.getSnapshot().command, '/dispatch unfinished draft');
  assert.equal(calls.length, 1);
});

test('checkpoint3: suggestion hint is visible in wide and narrow terminal layouts', async t => {
  const { model } = await setup(t); model.paste('/dispatch cl');
  for (const [width, height] of [[119, 40], [39, 15]]) {
    const screen = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width, height }));
    assert.match(screen, /↑↓ choose · Tab\/Enter accept/);
    assert.match(screen, /Claude/);
  }
});

test('checkpoint3: deferred no-colon forms use the same refusals and never dispatch', async t => {
  const { model, calls } = await setup(t);
  for (const prefix of ['claude.fast@shep', 'claude,codex@shep', 'codex@shep+wt', 'codex@unknown+wt', '@folio+wt']) {
    const command = `/dispatch ${prefix} literal task`;
    assert.equal(deferredCommand(command, { projects, providers }), deferredCommand(`/dispatch ${prefix}: literal task`, { projects, providers }));
    model.action('cancel'); model.paste(command); model.key('', { return: true }); await tick();
    assert.match(model.getSnapshot().notice.message, /not enabled|deferred/);
    assert.equal(model.getSnapshot().command, command);
  }
  assert.equal(calls.length, 0); assert.equal(model.getTasks().length, 0);
  for (const text of ['foo.bar task', 'apple,pear task', '@src/app.ts fix', '@unknown+wt task', 'Claude.fast task', 'codex: use +wt and claude.fast literally']) {
    assert.equal(deferredCommand(`/dispatch ${text}`, { projects, providers }), null, text);
  }
});
