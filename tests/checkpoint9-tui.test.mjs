import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { createTuiModel } from '../src/tui-model.mjs';
import { TuiView } from '../src/tui.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { taskRows } from '../src/tui-tasks.mjs';
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
async function fixture({ agents = [agent('alpha', 'agents:p1'), agent('beta', 'agents:p2'), agent('gamma', 'agents:p3')],
  recover = { ok: true, state: 'none', message: 'No leftover dock.' }, mode = 'live', connected = true, now } = {}) {
  const calls = [], monitor = monitorFixture(agents);
  monitor.publish({ mode, source: { state: connected ? 'connected' : 'disconnected' } });
  const controller = { ...createFakeController(),
    async recoverDock() { calls.push(['recover']); if (recover instanceof Error) throw recover; return recover; },
    async dock({ target }) { calls.push(['dock', target]); throw new Error('New docking must be unreachable.'); },
    async undock() { calls.push(['undock']); throw new Error('Normal shutdown must not restore panes.'); },
    async focus(target) { calls.push(['focus', target]); return { ok: true, state: 'focused', message: 'Focused.' }; },
    async closeAgent(target) { calls.push(['closeAgent', target]); return { ok: true, state: 'closed', message: 'Closed.' }; },
  };
  let quitCount = 0;
  const model = createTuiModel({ monitor, controller, registry: createFakeRegistry(), now, onQuit: () => { quitCount++; } });
  await model.ready;
  model.action('board-toggle');
  return { model, monitor, controller, calls, quitCount: () => quitCount };
}
const doubleClick = (model, action, id) => { model.action(action, id); model.action(action, id); };
const layoutCalls = calls => calls.filter(call => ['dock', 'undock', 'split', 'move', 'renameTab'].includes(call[0]));

test('startup, resting selections, arrows, resize, refresh and retired dock shortcut never move panes', async t => {
  const { model, calls } = await fixture(); t.after(() => model.destroy());
  model.action('select', 'terminal-alpha');
  model.key('', { downArrow: true });
  assert.equal(model.getSnapshot().selectedId, 'terminal-beta');
  model.key('t'); model.action('dock-toggle'); model.action('viewport-resized', 200); model.action('refresh');
  await delay(460);
  assert.deepEqual(layoutCalls(calls), []);
  assert.deepEqual(calls.filter(call => call[0] === 'focus'), []);
  assert.equal(calls.filter(call => call[0] === 'recover').length, 1);
  assert.equal(Object.hasOwn(model.getSnapshot(), 'dockedTarget'), false);
});

test('Enter focuses the selected original native pane once', async t => {
  const { model, calls } = await fixture(); t.after(() => model.destroy());
  model.action('select', 'terminal-beta');
  model.key('', { return: true }); await settle();
  assert.deepEqual(calls.filter(call => call[0] === 'focus').map(call => call[1].paneId), ['agents:p2']);
  assert.deepEqual(layoutCalls(calls), []);
});

test('single row clicks select; double clicks focus the original agent/task pane', async t => {
  const { model, calls } = await fixture(); t.after(() => model.destroy());
  model.action('click-agent', 'terminal-beta'); await settle();
  assert.equal(model.getSnapshot().selectedId, 'terminal-beta');
  assert.equal(calls.filter(call => call[0] === 'focus').length, 0);
  model.action('click-agent', 'terminal-beta'); await settle();
  model.action('board-toggle');
  const gamma = taskRows(model.getSnapshot()).find(row => row.agent?.id === 'terminal-gamma');
  model.action('click-task', gamma.id); await settle();
  assert.equal(model.getSnapshot().selectedTaskId, gamma.id);
  assert.equal(calls.filter(call => call[0] === 'focus').length, 1);
  model.action('click-task', gamma.id); await settle();
  assert.deepEqual(calls.filter(call => call[0] === 'focus').map(call => call[1].paneId), ['agents:p2', 'agents:p3']);
  assert.deepEqual(layoutCalls(calls), []);
});

test('missing or filtered row clicks cannot accidentally focus another row', async t => {
  const { model, calls } = await fixture(); t.after(() => model.destroy());
  doubleClick(model, 'click-agent', 'terminal-missing');
  model.action('search'); model.paste('alpha');
  doubleClick(model, 'click-agent', 'terminal-beta');
  model.action('board-toggle'); doubleClick(model, 'click-task', 'missing'); await settle();
  assert.deepEqual(calls.filter(call => call[0] === 'focus'), []);
});

test('double click requires the same row within 400ms and is cancelled by keyboard or scrolling', async t => {
  let at = 1000;
  const { model, calls } = await fixture({ now: () => at }); t.after(() => model.destroy());
  model.action('click-agent', 'terminal-beta'); at += 401;
  model.action('click-agent', 'terminal-beta'); await settle();
  assert.equal(calls.filter(call => call[0] === 'focus').length, 0);
  model.action('click-agent', 'terminal-gamma');
  model.action('click-agent', 'terminal-beta'); await settle();
  assert.equal(calls.filter(call => call[0] === 'focus').length, 0);
  model.key('', { downArrow: true }); model.action('click-agent', 'terminal-beta'); await settle();
  assert.equal(calls.filter(call => call[0] === 'focus').length, 0);
  model.action('cancel-row-click'); model.action('click-agent', 'terminal-beta'); await settle();
  assert.equal(calls.filter(call => call[0] === 'focus').length, 0);
  at += 400; model.action('click-agent', 'terminal-beta'); await settle();
  assert.deepEqual(calls.filter(call => call[0] === 'focus').map(call => call[1].paneId), ['agents:p2']);
  assert.deepEqual(layoutCalls(calls), []);
});

test('a changed pane or trusted session between clicks requires a fresh double click', async t => {
  for (const patch of [{ paneId: 'agents:replacement' }, { terminalId: 'replacement' }, { provider: 'grok' }, { sessionId: 'replacement-session' }]) {
    const { model, monitor, calls } = await fixture(); t.after(() => model.destroy());
    model.action('click-agent', 'terminal-beta');
    monitor.publish({ agents: [agent('alpha', 'agents:p1'), agent('beta', 'agents:p2', patch)] });
    model.action('click-agent', 'terminal-beta'); await settle();
    assert.deepEqual(calls.filter(call => call[0] === 'focus'), [], JSON.stringify(patch));
    model.action('click-agent', 'terminal-beta'); await settle();
    assert.equal(calls.filter(call => call[0] === 'focus').length, 1);
  }
});

test('row clicks retain demo, STALE, own-pane and busy action guards', async t => {
  const own = agent('own', 'w1:p1', { terminalId: 'own-terminal' });
  const { model, monitor, calls } = await fixture({ agents: [own, agent('beta', 'agents:p2')] }); t.after(() => model.destroy());
  doubleClick(model, 'click-agent', own.id); await settle();
  monitor.publish({ source: { state: 'disconnected' } }); doubleClick(model, 'click-agent', 'terminal-beta'); await settle();
  monitor.publish({ source: { state: 'connected' }, mode: 'demo' }); doubleClick(model, 'click-agent', 'terminal-beta'); await settle();
  monitor.publish({ mode: 'live' });
  doubleClick(model, 'click-agent', 'terminal-beta'); doubleClick(model, 'click-agent', 'terminal-own'); await settle();
  assert.equal(model.getSnapshot().selectedId, 'terminal-beta');
  assert.deepEqual(calls.filter(call => call[0] === 'focus').map(call => call[1].paneId), ['agents:p2']);
  assert.deepEqual(layoutCalls(calls), []);
});

test('command and compose views do not treat their background board rows as clicks', async t => {
  const { model, calls } = await fixture(); t.after(() => model.destroy());
  model.key('/dispatch this is a draft'); doubleClick(model, 'click-agent', 'terminal-beta');
  assert.equal(model.getSnapshot().view, 'command');
  model.action('cancel'); model.action('new'); doubleClick(model, 'click-agent', 'terminal-beta'); await settle();
  assert.equal(model.getSnapshot().selectedId, 'terminal-alpha');
  assert.deepEqual(calls.filter(call => call[0] === 'focus'), []);
});

test('visible agent and task rows still focus native panes beside wide details', async t => {
  for (const boardView of ['agents', 'tasks']) {
    const { model, calls } = await fixture(); t.after(() => model.destroy());
    if (boardView === 'tasks') model.action('board-toggle');
    model.action('details');
    assert.equal(model.getSnapshot().view, 'detail');
    const rendered = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width: 120, height: 40 }));
    assert.match(rendered, /beta/);
    const clickedId = boardView === 'agents' ? 'terminal-beta' : taskRows(model.getSnapshot()).find(row => row.agent?.id === 'terminal-beta').id;
    doubleClick(model, boardView === 'agents' ? 'click-agent' : 'click-task', clickedId); await settle();
    assert.equal(model.selected().id, 'terminal-beta');
    assert.deepEqual(calls.filter(call => call[0] === 'focus').map(call => call[1].paneId), ['agents:p2']);
    assert.deepEqual(layoutCalls(calls), []);
  }
});

test('starting agents stay in their native pane and can be opened to inspect startup', async t => {
  const { model, calls } = await fixture({ agents: [agent('pending', 'agents:p2', { launchPending: true })] });
  t.after(() => model.destroy()); doubleClick(model, 'click-agent', 'terminal-pending'); await settle();
  assert.deepEqual(calls.filter(call => call[0] === 'focus').map(call => call[1].paneId), ['agents:p2']);
  assert.deepEqual(layoutCalls(calls), []);
});

test('close confirmation captures the native target and does not close until confirmed', async t => {
  const { model, calls } = await fixture(); t.after(() => model.destroy());
  model.action('select', 'terminal-beta'); model.key('x');
  assert.equal(model.getSnapshot().view, 'confirm');
  assert.equal(model.getSnapshot().confirmation.paneId, 'agents:p2');
  assert.deepEqual(calls.filter(call => call[0] === 'closeAgent'), []);
  model.key('y'); await settle();
  assert.deepEqual(calls.filter(call => call[0] === 'closeAgent').map(call => call[1].paneId), ['agents:p2']);
  assert.deepEqual(layoutCalls(calls), []);
});

test('q and Ctrl+C quit once without a pane restore', async t => {
  for (const shortcut of ['q', 'ctrl-c']) {
    const { model, calls, quitCount } = await fixture(); t.after(() => model.destroy());
    model.action('select', 'terminal-beta');
    if (shortcut === 'q') model.key('q'); else model.key('c', { ctrl: true });
    model.action('quit'); await settle();
    assert.equal(quitCount(), 1); assert.deepEqual(layoutCalls(calls), []);
  }
});

test('startup recovers a legacy marker once and a recovery warning never retries on quit', async t => {
  for (const recover of [{ ok: true, state: 'recovered', message: 'Legacy agent returned.', target: agent('old', 'agents:p9') },
    { ok: false, state: 'uncertain', message: 'Inspect the legacy marker in Herdr.' }, new Error('Legacy marker scan unavailable.')]) {
    const { model, calls, quitCount } = await fixture({ recover }); t.after(() => model.destroy());
    assert.match(model.getSnapshot().notice.message, /Legacy|legacy/);
    model.key('t'); model.action('refresh'); model.key('q'); await settle();
    assert.equal(calls.filter(call => call[0] === 'recover').length, 1);
    assert.equal(quitCount(), 1); assert.deepEqual(layoutCalls(calls), []);
  }
});

test('demo and disconnected startup never attempt legacy recovery', async t => {
  for (const options of [{ mode: 'demo' }, { connected: false }]) {
    const { model, calls } = await fixture(options); t.after(() => model.destroy());
    assert.deepEqual(calls.filter(call => call[0] === 'recover'), []);
  }
});

test('native board keeps selected metadata details on wide panes and stays bounded', async t => {
  const { model } = await fixture({ agents: [agent('alpha', 'agents:p1')] }); t.after(() => model.destroy());
  const state = { ...model.getSnapshot(), modelInfoByAgent: { 'terminal-alpha': { model: 'claude-opus-5-5', effort: 'high' } } };
  for (const [width, height] of [[40, 15], [80, 40], [120, 40]]) {
    const rendered = renderToString(React.createElement(TuiView, { state, model, width, height }));
    const lines = rendered.split('\n');
    assert(lines.length <= height); assert(lines.every(line => displayWidth(line) <= width));
    assert.match(rendered, /alpha/); assert.doesNotMatch(rendered, /docked agent|dock off|Ctrl\+B then h/);
    if (width === 120) assert.match(rendered, /Task text unavailable/);
  }
});
