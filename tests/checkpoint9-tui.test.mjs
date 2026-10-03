import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { createTuiModel } from '../src/tui-model.mjs';
import { TuiView } from '../src/tui.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { createFakeController, createFakeRegistry } from './helpers/dispatch-fakes.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = () => new Promise(resolve => setImmediate(resolve));
const agent = (name, paneId, extra = {}) => ({ id: `terminal-${name}`, terminalId: `terminal-${name}`, paneId,
  provider: 'claude', agentName: name, name, status: 'working', sessionId: `session-${name}`,
  workspace: { id: 'agents', name: 'agents', path: '/fixture/agents' }, ...extra });
function monitorFixture(agents) {
  let snapshot = { mode: 'live', source: { state: 'connected' }, updatedAt: new Date().toISOString(), agents };
  const subscribers = new Set();
  return { getSnapshot: () => structuredClone(snapshot), subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    publish(patch) { snapshot = { ...snapshot, ...patch }; for (const fn of subscribers) fn(structuredClone(snapshot)); } };
}
async function fixture(agents = [agent('alpha', 'agents:p1'), agent('beta', 'agents:p2'), agent('gamma', 'agents:p3')], dockOverride, activate = true) {
  const calls = [], monitor = monitorFixture(agents);
  const base = createFakeController();
  let active = null;
  const controller = { ...base,
    async recoverDock() { calls.push(['recover']); return { ok: true, state: 'none', message: 'No leftover dock.' }; },
    getDockState() { return active && { target: active }; },
    async dock({ target }) {
      calls.push(['dock', target]);
      if (dockOverride) {
        const override = dockOverride(target);
        if (override) return override;
      }
      const restoredTarget = active && { ...active, paneId: `agents:${active.agentName}` };
      active = { ...target, paneId: `shep:${target.agentName}` };
      return { ok: true, state: 'docked', message: 'Docked.', target: active, ...(restoredTarget && { restoredTarget }) };
    },
    async undock() {
      calls.push(['undock']);
      const target = { ...active, paneId: `agents:${active.agentName}` };
      active = null;
      return { ok: true, state: 'undocked', message: 'Restored.', target };
    },
    async focus(target) { calls.push(['focus', target]); return { ok: true, state: 'focused', message: 'Focused.' }; },
  };
  let quitCount = 0;
  const model = createTuiModel({ monitor, controller, registry: createFakeRegistry(), onQuit: () => { quitCount++; } });
  await model.ready;
  model.action('board-toggle');
  if (activate) model.action('select', agents[0].id);
  return { model, monitor, controller, calls, quitCount: () => quitCount };
}

test('fresh startup never docks the default row until the user selects it', async t => {
  const { model, calls } = await fixture(undefined, undefined, false); t.after(() => model.destroy());
  await delay(460);
  assert.equal(calls.filter(call => call[0] === 'dock').length, 0);
  model.action('select', model.getSnapshot().selectedId);
  await delay(460);
  assert.equal(calls.filter(call => call[0] === 'dock').length, 1);
});

test('dock waits for a resting selection, switches once, and Enter focuses the moved pane', async t => {
  const { model, calls } = await fixture(); t.after(() => model.destroy());
  model.action('select', 'terminal-alpha');
  await delay(120);
  model.action('select', 'terminal-beta');
  await delay(460);
  assert.deepEqual(calls.filter(call => call[0] === 'dock').map(call => call[1].agentName), ['beta']);
  assert.equal(model.getSnapshot().dockedTarget.paneId, 'shep:beta');
  model.key('', { return: true }); await settle();
  assert.equal(calls.find(call => call[0] === 'focus')?.[1].paneId, 'shep:beta');
  model.action('select', 'terminal-gamma');
  await delay(460);
  assert.deepEqual(calls.filter(call => call[0] === 'dock').map(call => call[1].agentName), ['beta', 'gamma']);
  assert.equal(model.getSnapshot().dockedTarget.paneId, 'shep:gamma');
});

test('t restores and disables docking; q restores before quitting', async t => {
  const { model, calls, quitCount } = await fixture(); t.after(() => model.destroy());
  await delay(460);
  assert.equal(calls.filter(call => call[0] === 'dock').length, 1);
  model.key('t'); await settle();
  assert.equal(model.getSnapshot().dockEnabled, false);
  assert.equal(model.getSnapshot().dockedTarget, null);
  assert.equal(calls.filter(call => call[0] === 'undock').length, 1);
  await delay(460);
  assert.equal(calls.filter(call => call[0] === 'dock').length, 1);
  model.key('t');
  await delay(460);
  assert.equal(calls.filter(call => call[0] === 'dock').length, 2);
  model.key('q'); await settle();
  assert.equal(calls.filter(call => call[0] === 'undock').length, 2);
  assert.equal(quitCount(), 1);
});

test('x restores before close confirmation, and Ctrl+C restores before quitting', async t => {
  const { model, calls, quitCount } = await fixture(); t.after(() => model.destroy());
  await delay(460);
  model.key('x'); await settle();
  assert.equal(calls.filter(call => call[0] === 'undock').length, 1);
  assert.equal(model.getSnapshot().view, 'confirm');
  assert.equal(model.getSnapshot().confirmation.paneId, 'agents:alpha');
  assert.equal(calls.filter(call => call[0] === 'closeAgent').length, 0);
  model.action('cancel');
  model.action('select', 'terminal-beta');
  await delay(460);
  assert.equal(model.getSnapshot().dockedTarget.agentName, 'beta');
  model.key('c', { ctrl: true }); await settle();
  assert.equal(calls.filter(call => call[0] === 'undock').length, 2);
  assert.equal(quitCount(), 1);
});

test('own pane, dock marker, and starting agents never reach dock controller', async t => {
  const agents = [agent('own', 'w1:p1', { terminalId: 'own-terminal' }), agent('shep-dock-test', 'agents:p2'),
    agent('pending', 'agents:p3', { launchPending: true })];
  const { model, calls } = await fixture(agents); t.after(() => model.destroy());
  for (const id of agents.map(item => item.id)) { model.action('select', id); await delay(430); }
  assert.equal(calls.filter(call => call[0] === 'dock').length, 0);
});

test('selecting a starting agent restores the previous dock without docking the new row', async t => {
  const { model, calls } = await fixture([agent('alpha', 'agents:p1'), agent('pending', 'agents:p2', { launchPending: true })]);
  t.after(() => model.destroy());
  await delay(460);
  assert.equal(model.getSnapshot().dockedTarget.agentName, 'alpha');
  model.action('select', 'terminal-pending');
  await delay(460);
  assert.equal(calls.filter(call => call[0] === 'undock').length, 1);
  assert.deepEqual(calls.filter(call => call[0] === 'dock').map(call => call[1].agentName), ['alpha']);
  assert.equal(model.getSnapshot().dockedTarget, null);
});

test('narrow tab keeps the prior board, avoids notices and repeated attempts until resize', async t => {
  let narrow = true;
  const { model, calls } = await fixture(undefined, () => narrow
    ? { ok: false, state: 'failed', code: 'dock_narrow', message: 'Tab too narrow.' } : null);
  t.after(() => model.destroy());
  await delay(460);
  model.action('select', 'terminal-beta');
  await delay(460);
  assert.equal(calls.filter(call => call[0] === 'dock').length, 1);
  assert.equal(model.getSnapshot().dockedTarget, null);
  assert.equal(model.getSnapshot().notice, null);
  const rendered = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width: 40, height: 15 }));
  assert.doesNotMatch(rendered, /Ctrl\+B then h returns to Shep/);
  narrow = false;
  model.action('viewport-resized', 120);
  await delay(460);
  assert.equal(calls.filter(call => call[0] === 'dock').length, 2);
  assert.equal(model.getSnapshot().dockedTarget.agentName, 'beta');
});

test('uncertain dock disables automatic retries and requires inspection', async t => {
  const { model, calls } = await fixture(undefined, () => ({ ok: false, state: 'uncertain', code: 'dock_missing', message: 'Inspect Herdr.' }));
  t.after(() => model.destroy());
  await delay(460);
  model.action('select', 'terminal-beta');
  await delay(460);
  assert.equal(calls.filter(call => call[0] === 'dock').length, 1);
  assert.equal(model.getSnapshot().dockEnabled, false);
  assert.match(model.getSnapshot().notice.message, /Inspect Herdr/);
  model.key('t');
  assert.equal(model.getSnapshot().dockEnabled, false);
  assert.equal(calls.filter(call => call[0] === 'dock').length, 1);
});

test('uncertain restore is latched across quit and shutdown callers', async t => {
  const { model, controller, calls, quitCount } = await fixture(); t.after(() => model.destroy());
  await delay(460);
  let attempts = 0;
  controller.undock = async () => { attempts++; return { ok: false, state: 'uncertain', message: 'Inspect Herdr.' }; };
  assert.equal(await model.restoreDock(), false);
  assert.equal(await model.restoreDock(), false);
  model.key('q'); await settle();
  assert.equal(attempts, 1);
  assert.equal(quitCount(), 0);
  assert.equal(calls.filter(call => call[0] === 'dock').length, 1);
  assert.equal(model.getSnapshot().dockEnabled, false);
});

test('confirmed dock renders one selected header and list without details panel', async t => {
  const { model } = await fixture([agent('alpha', 'agents:p1')]); t.after(() => model.destroy());
  await delay(460);
  const state = { ...model.getSnapshot(), modelInfoByAgent: { 'terminal-alpha': { model: 'claude-opus-5-5', effort: 'high' } } };
  for (const [width, height] of [[80, 40], [120, 40]]) {
    const rendered = renderToString(React.createElement(TuiView, { state, model, width, height }));
    const lines = rendered.split('\n');
    assert(lines.length <= height);
    assert(lines.every(line => displayWidth(line) <= width));
    assert.match(rendered, /alpha · Working · Claude · claude-opus-5-5 · high/);
    assert.match(rendered, /Ctrl\+B then h returns to Shep/);
    assert.doesNotMatch(rendered, /Task text unavailable for this agent/);
  }
});
