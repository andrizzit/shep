import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { createTuiModel } from '../src/tui-model.mjs';
import { TuiView } from '../src/tui.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { createFakeController, createFakeRegistry } from './helpers/dispatch-fakes.mjs';

test('native board keeps focus controls and bounded rows without obsolete dock warnings', async t => {
  const agent = { id: 'agent-terminal', terminalId: 'agent-terminal', paneId: 'w1:p2', provider: 'claude',
    agentName: 'scratch', name: 'scratch', status: 'working', sessionId: 'session-a',
    workspace: { id: 'w1', name: 'scratch', path: '/private/tmp' } };
  const snapshot = { mode: 'live', source: { state: 'connected' }, updatedAt: new Date().toISOString(), agents: [agent] };
  const monitor = { getSnapshot: () => structuredClone(snapshot), subscribe: () => () => {} };
  const model = createTuiModel({ monitor, controller: createFakeController(), registry: createFakeRegistry(), onQuit: () => {} });
  t.after(() => model.destroy());
  await model.ready;
  model.action('board-toggle');
  const state = model.getSnapshot();
  for (const [width, height] of [[60, 15], [115, 40]]) {
    const rendered = renderToString(React.createElement(TuiView, { state, model, width, height }));
    const lines = rendered.split('\n');
    assert(lines.length <= height, `${width}: ${lines.length} lines`);
    assert(lines.every(line => displayWidth(line) <= width), `${width}: line overflow`);
    assert.doesNotMatch(rendered, /docked agent|Ctrl\+B then h|dock off/);
    assert.match(rendered, /focus/i);
    assert.match(rendered, /scratch/);
    if (width === 115) assert.match(rendered, /Task text unavailable/);
  }
});
