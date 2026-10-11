import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { createTuiModel } from '../src/tui-model.mjs';
import { TuiView } from '../src/tui.mjs';
import { createFakeController, createFakeRegistry, deferred } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const agent = (patch = {}) => ({ id: 'terminal-1', terminalId: 'terminal-1', paneId: 'w2:p1', provider: 'codex',
  name: 'review', agentName: 'review', status: 'working', sessionId: 'untrusted-herdr-id',
  workspace: { id: 'w2', name: 'shep', path: '/fixture/shep' }, ...patch });
function fixture(t, options = {}) {
  let snapshot = { mode: 'live', source: { state: 'connected' }, updatedAt: new Date().toISOString(), agents: [agent()], ...options.snapshot };
  const subscribers = new Set();
  const monitor = { getSnapshot: () => structuredClone(snapshot), subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); } };
  const model = createTuiModel({ monitor, controller: createFakeController(), registry: createFakeRegistry(), ...options });
  t.after(() => model.destroy());
  return { model, monitor, publish(patch) { snapshot = { ...snapshot, ...patch }; for (const fn of subscribers) fn(structuredClone(snapshot)); } };
}

test('verified Codex fields appear in rows/details without trusting Herdr IDs or changing control targets', async t => {
  const requests = [], f = fixture(t, { readModel: () => { throw new Error('Codex must not use the Herdr-ID reader'); },
    readCodexModel: async request => { requests.push(request); return { model: 'gpt-6.1-sol', effort: 'xhigh', text: 'PRIVATE-CONVERSATION' }; } });
  const before = f.monitor.getSnapshot(); await f.model.ready;
  assert.deepEqual(requests, [{ paneId: 'w2:p1', terminalId: 'terminal-1' }]);
  assert.deepEqual(f.model.getSnapshot().modelInfoByAgent, { 'terminal-1': { model: 'gpt-6.1-sol', effort: 'xhigh' } });
  assert.deepEqual(f.monitor.getSnapshot(), before); assert.deepEqual(f.model.selected(), before.agents[0]);
  assert.doesNotMatch(JSON.stringify(f.model.getSnapshot()), /PRIVATE-CONVERSATION/);
  const draw = () => renderToString(React.createElement(TuiView, { model: f.model, state: f.model.getSnapshot(), width: 170, height: 39, offset: 0 }), { columns: 170 });
  assert.match(draw(), /gpt-6\.1-sol/); assert.match(draw(), /xhigh/);
  f.model.action('details'); await tick(); assert.match(draw(), /gpt-6\.1-sol/); assert.match(draw(), /xhigh/);
});

test('Codex metadata survives Herdr ID churn and STALE while reads pause, then disappears on failed verification', async t => {
  let count = 0, value = { model: 'gpt-6.1-sol', effort: 'high' };
  const f = fixture(t, { readCodexModel: async () => { count++; return value; } }); await f.model.ready;
  f.publish({ source: { state: 'stale' }, agents: [agent({ sessionId: 'another-wrong-id' })] }); await tick();
  assert.equal(count, 1); assert.deepEqual(f.model.getSnapshot().modelInfoByAgent['terminal-1'], value);
  value = undefined; f.publish({ source: { state: 'connected' } }); await tick();
  assert.equal(count, 2); assert.deepEqual(f.model.getSnapshot().modelInfoByAgent, {});
});

test('late Codex metadata cannot cross a changed pane, terminal, provider, demo or disconnected source', async t => {
  for (const patch of [{ agents: [agent({ paneId: 'w3:p1' })] }, { agents: [agent({ terminalId: 'replacement' })] },
    { agents: [agent({ provider: 'claude', sessionId: null })] }, { agents: [] }, { mode: 'demo' }, { source: { state: 'stale' } }]) {
    const gate = deferred(); let count = 0;
    const f = fixture(t, { readCodexModel: async () => ++count === 1 ? gate.promise : undefined });
    f.publish(patch); gate.resolve({ model: 'old-model', effort: 'high' }); await f.model.ready; await tick();
    assert.deepEqual(f.model.getSnapshot().modelInfoByAgent, {}, JSON.stringify(patch));
  }
});

test('Codex reader is skipped for demo, STALE, missing identities and other providers; its cache is pruned', async t => {
  let count = 0; const retained = [];
  const readCodexModel = async () => { count++; return undefined; };
  readCodexModel.retain = ids => retained.push(ids);
  for (const snapshot of [{ mode: 'demo' }, { source: { state: 'stale' } }, { agents: [agent({ paneId: null })] },
    { agents: [agent({ terminalId: null })] }, { agents: [agent({ provider: 'grok' })] }]) {
    const f = fixture(t, { snapshot, readCodexModel }); await f.model.ready;
  }
  assert.equal(count, 0);
  const f = fixture(t, { readCodexModel }); await f.model.ready;
  f.publish({ agents: [] }); await tick(); assert.deepEqual(retained.at(-1), []);
});
