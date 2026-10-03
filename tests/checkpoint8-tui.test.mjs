import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'ink';
import { createTuiModel } from '../src/tui-model.mjs';
import { TuiView, boardRows, listRows } from '../src/tui.mjs';
import { taskRows } from '../src/tui-tasks.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { createFakeController, createFakeRegistry, deferred, makeProject } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const makeAgent = (overrides = {}) => ({ id: 'terminal-1', terminalId: 'terminal-1', paneId: 'w2:p1', provider: 'claude',
  agentName: 'review', name: 'review', status: 'working', sessionId: 'session-1', workspace: { id: 'w2', name: 'shep', path: '/fixture/shep' }, ...overrides });
function monitorFixture(agents = [makeAgent()], mode = 'live') {
  let snapshot = { mode, source: { state: 'connected' }, updatedAt: new Date().toISOString(), agents };
  const subscribers = new Set();
  return { getSnapshot: () => structuredClone(snapshot), subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    publish(patch) { snapshot = { ...snapshot, ...patch }; for (const fn of subscribers) fn(structuredClone(snapshot)); } };
}

if (!process.env.SHEP_CHECKPOINT8_TUI_CASE) {
  test('checkpoint8 model fields are private terminal state, never agent metadata or control targets', async t => {
    const monitor = monitorFixture(), before = monitor.getSnapshot(), calls = [];
    const model = createTuiModel({ monitor, controller: createFakeController(), registry: createFakeRegistry(),
      readModel: async request => { calls.push(request); return { model: 'claude-opus-5-5', effort: 'high', text: 'SYNTHETIC-PRIVATE-TEXT' }; } });
    t.after(() => model.destroy()); await model.ready;
    assert.deepEqual(calls, [{ provider: 'claude', sessionId: 'session-1' }]);
    assert.deepEqual(model.getSnapshot().modelInfoByAgent, { 'terminal-1': { model: 'claude-opus-5-5', effort: 'high' } });
    assert.deepEqual(model.getSnapshot().snapshot, before); assert.deepEqual(monitor.getSnapshot(), before);
    assert.deepEqual(model.selected(), before.agents[0]);
    assert.doesNotMatch(JSON.stringify(model.getSnapshot()), /SYNTHETIC-PRIVATE-TEXT/);
    monitor.publish({ agents: [] }); await tick(); assert.deepEqual(model.getSnapshot().modelInfoByAgent, {});
  });
  test('checkpoint8 absent sessions, demo data and reader failures leave fields blank', async t => {
    let calls = 0;
    for (const [agents, mode] of [[[makeAgent({ sessionId: null })], 'live'], [[makeAgent()], 'demo']]) {
      const model = createTuiModel({ monitor: monitorFixture(agents, mode), controller: createFakeController(), registry: createFakeRegistry(),
        readModel: async () => { calls++; throw new Error('Unreadable synthetic log'); } });
      t.after(() => model.destroy()); await model.ready; assert.deepEqual(model.getSnapshot().modelInfoByAgent, {});
    }
    assert.equal(calls, 0);
    const model = createTuiModel({ monitor: monitorFixture(), controller: createFakeController(), registry: createFakeRegistry(),
      readModel: async () => { throw new Error('Unreadable synthetic log'); } });
    t.after(() => model.destroy()); await model.ready; assert.deepEqual(model.getSnapshot().modelInfoByAgent, {});
  });
  test('checkpoint8 late metadata cannot cross pane, terminal, provider or session changes', async () => {
    for (const patch of [{ paneId: 'w3:p1' }, { terminalId: 'replacement' }, { provider: 'codex' }, { sessionId: 'replacement-session' }]) {
      const gate = deferred(), monitor = monitorFixture(); let reads = 0;
      const model = createTuiModel({ monitor, controller: createFakeController(), registry: createFakeRegistry(),
        readModel: async () => ++reads === 1 ? gate.promise : undefined });
      monitor.publish({ agents: [makeAgent(patch)] });
      gate.resolve({ model: 'old-model', effort: 'high' }); await model.ready; await tick();
      assert.deepEqual(model.getSnapshot().modelInfoByAgent, {}, JSON.stringify(patch)); model.destroy();
    }
  });
  test('checkpoint8 refresh replaces or removes terminal-only fields without changing selection', async t => {
    const monitor = monitorFixture(); let value = { model: 'claude-opus-5-5', effort: 'high' };
    const model = createTuiModel({ monitor, controller: createFakeController(), registry: createFakeRegistry(), readModel: async () => value });
    t.after(() => model.destroy()); await model.ready; const selected = model.getSnapshot().selectedTaskId;
    value = { model: 'claude-sonnet-5-5', effort: 'medium' }; monitor.publish({}); await tick();
    assert.deepEqual(model.getSnapshot().modelInfoByAgent['terminal-1'], value); assert.equal(model.getSnapshot().selectedTaskId, selected);
    value = undefined; monitor.publish({}); await tick(); assert.deepEqual(model.getSnapshot().modelInfoByAgent, {});
  });
}

function layoutFixture() {
  const project = makeProject(), agents = [makeAgent(), makeAgent({ id: 'terminal-2', terminalId: 'terminal-2', paneId: 'w2:p2',
    provider: 'codex', sessionId: 'session-2', name: 'tests', agentName: 'tests', status: 'done' })];
  const task = { id: 'review-task', attemptId: 'review-attempt', name: 'review', inputTask: 'Reply with OK', project,
    agent: { provider: 'claude' }, at: new Date().toISOString(), dismissed: false, launch: { state: 'submitted', delivery: 'launch', message: 'Opened' },
    live: { status: 'working', since: new Date().toISOString() }, target: { ...agents[0] }, subfolder: '', observedActivity: true,
    placement: { mode: 'here', targetKind: 'tab', cwd: project.root, reason: 'Main folder' } };
  let state = { snapshot: { mode: 'live', source: { state: 'connected' }, updatedAt: new Date().toISOString(), agents },
    modelInfoByAgent: { 'terminal-1': { model: 'claude-opus-5-5', effort: 'high' }, 'terminal-2': { model: 'gpt-6.1-sol', effort: 'xhigh' } },
    view: 'board', boardView: 'tasks', selectedTaskId: 'task:review-task', selectedId: 'terminal-1', tasks: [task], projects: [project],
    trustRequired: [], projectsLoading: false, profilesLoading: false, busy: null, notice: null, requiredNotice: null, query: '', filter: 'all',
    profiles: { providers: [{ id: 'codex', available: true }, { id: 'claude', available: true }] }, suggestions: [], detailOffset: 0,
    draft: { provider: 'codex', projectKey: project.key, prompt: '', name: '', subfolder: '' }, command: '', cursor: { command: 0 } };
  const model = { getSnapshot: () => state, action: () => {}, selected: () => state.boardView === 'tasks'
    ? taskRows(state).find(row => row.id === state.selectedTaskId)?.agent : state.snapshot.agents.find(agent => agent.id === state.selectedId) };
  return { model, patch: patch => { state = { ...state, ...patch }; } };
}
async function layoutCase({ columns, rows, color }) {
  const f = layoutFixture(), width = columns - 1, height = rows - 1;
  const draw = offset => {
    const ansi = renderToString(React.createElement(TuiView, { state: f.model.getSnapshot(), model: f.model, width, height, offset }), { columns: width });
    if (color) assert.match(ansi, /\x1b\[/); else assert.doesNotMatch(ansi, /\x1b\[/);
    const text = stripVTControlCharacters(ansi), lines = text.split('\n');
    assert(lines.length <= height); assert(lines.every(line => displayWidth(line) <= width));
    return { ansi, text, lines };
  };
  const leftPanel = line => line.includes('││') ? line.slice(0, line.indexOf('││') + 1) : line;
  for (const boardView of ['tasks', 'agents']) {
    f.patch({ boardView });
    const flat = boardView === 'tasks' ? boardRows(f.model.getSnapshot()) : listRows(f.model.getSnapshot());
    for (const [id, modelText, effort] of [['terminal-1', 'opus 5.5', 'high'], ['terminal-2', 'gpt-6.1-sol', 'xhigh']]) {
      const index = flat.findIndex(item => (item.type === 'task' ? item.row.agent : item.type === 'agent' ? item.agent : null)?.id === id);
      const screen = draw(index);
      const rowIndex = screen.lines.findIndex(line => leftPanel(line).includes(id === 'terminal-1' ? 'review' : 'tests') && /Working|Done/.test(leftPanel(line)));
      const row = screen.lines[rowIndex] && leftPanel(screen.lines[rowIndex]);
      assert(row, `${boardView} ${id}`);
      if (columns === 120) { assert(row.includes(modelText), row); assert(row.includes(effort), row); }
      else { assert(!row.includes(modelText), row); assert(!row.includes(effort), row); }
      if (color && columns === 120) assert.match(screen.ansi.split('\n')[rowIndex], /\x1b\[38;2;130;152;137m(?:opus 5\.5|gpt-6\.1-sol)/);
    }
  }
  for (const boardView of ['tasks', 'agents']) {
    f.patch({ boardView, view: 'detail', detailOffset: 0 }); let text = '';
    for (let offset = 0; offset < 35; offset++) { f.patch({ detailOffset: offset }); text += draw().text + '\n'; }
    assert.match(text, /Model: claude-opus-5-5/); assert.match(text, /Effort: high/);
  }
  const original = f.model.getSnapshot();
  f.patch({ view: 'board', boardView: 'tasks', tasks: original.tasks.map(task => ({ ...task,
    name: 'Implement useful deployment diagnostics', placement: { ...task.placement, cwd: '/fixture/shep/deployment' } })) });
  const withFields = draw().lines.map(leftPanel).find(line => /Impl.*Working/.test(line));
  f.patch({ modelInfoByAgent: {} });
  const withoutFields = draw().lines.map(leftPanel).find(line => /Impl.*Working/.test(line));
  assert(withFields); assert(withoutFields);
  assert.equal(withFields.match(/(Impl.*?)\s+Working/)[1].trim(), withoutFields.match(/(Impl.*?)\s+Working/)[1].trim(),
    'Aligned optional columns must preserve the useful name text');
  if (columns === 120) { assert.match(withFields, /Implement useful/); assert.match(withFields, /deployment/); assert.match(withFields, /opus 5\.5.*high/); }
  else assert.doesNotMatch(withFields, /opus 5\.5|high/);
  f.patch({ tasks: original.tasks });
  f.patch({ view: 'board', boardView: 'tasks', modelInfoByAgent: {} });
  const blank = draw().text; assert.doesNotMatch(blank, /opus 5\.5|high|unknown/i);
  f.patch({ view: 'detail' }); let blankDetails = '';
  for (let offset = 0; offset < 30; offset++) { f.patch({ detailOffset: offset }); blankDetails += draw().text + '\n'; }
  assert.doesNotMatch(blankDetails, /Model:|Effort:|unknown/i);
}
if (process.env.SHEP_CHECKPOINT8_TUI_CASE) await layoutCase(JSON.parse(process.env.SHEP_CHECKPOINT8_TUI_CASE));
else for (const [columns, rows] of [[120, 40], [40, 15]]) for (const color of [true, false]) {
  test(`checkpoint8 terminal model rows/details at ${columns}x${rows} ${color ? 'color' : 'NO_COLOR'}`, async () => {
    const env = { ...process.env, TERM: 'xterm-256color', SHEP_CHECKPOINT8_TUI_CASE: JSON.stringify({ columns, rows, color }) };
    if (color) { delete env.NO_COLOR; env.FORCE_COLOR = '3'; } else { env.NO_COLOR = '1'; delete env.FORCE_COLOR; }
    await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url)], { env, maxBuffer: 2e6 });
  });
}
