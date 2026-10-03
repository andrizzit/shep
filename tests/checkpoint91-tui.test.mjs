import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { createTuiModel } from '../src/tui-model.mjs';
import { TuiView } from '../src/tui.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { createFakeController, createFakeRegistry } from './helpers/dispatch-fakes.mjs';

const WARNING = 'Quit Shep with q before closing this tab — closing the tab also closes the docked agent.';

test('dock footer keeps the full tab-close warning and narrow list within Shep width', async t => {
  const agent = { id: 'agent-terminal', terminalId: 'agent-terminal', paneId: 'w1:p2', provider: 'claude',
    agentName: 'scratch', name: 'scratch', status: 'working', sessionId: 'session-a',
    workspace: { id: 'w1', name: 'scratch', path: '/private/tmp' } };
  const snapshot = { mode: 'live', source: { state: 'connected' }, updatedAt: new Date().toISOString(), agents: [agent] };
  const monitor = { getSnapshot: () => structuredClone(snapshot), subscribe: () => () => {} };
  const model = createTuiModel({ monitor, controller: createFakeController(), registry: createFakeRegistry(), onQuit: () => {} });
  t.after(() => model.destroy());
  await model.ready;
  model.action('board-toggle');
  const state = { ...model.getSnapshot(), dockedTarget: { ...agent } };
  for (const [width, height] of [[60, 15], [115, 40]]) {
    const rendered = renderToString(React.createElement(TuiView, { state, model, width, height }));
    const lines = rendered.split('\n');
    assert(lines.length <= height, `${width}: ${lines.length} lines`);
    assert(lines.every(line => displayWidth(line) <= width), `${width}: line overflow`);
    assert.match(rendered.replace(/\s+/g, ' '), /Quit Shep with q before closing this tab — closing the tab also closes the docked agent\./);
    assert.match(rendered, /Ctrl\+B then h returns to Shep/);
    assert((rendered.match(/scratch/g) ?? []).length >= 2, `${width}: selected agent row is hidden`);
    assert.doesNotMatch(rendered, /Task text unavailable for this agent/);
  }
});
