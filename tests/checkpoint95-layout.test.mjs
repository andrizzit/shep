import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'ink';
import { TuiView } from '../src/tui.mjs';
import { taskRows } from '../src/tui-tasks.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { makeProject } from './helpers/dispatch-fakes.mjs';

const currentTime = new Date(2026, 9, 10, 23, 11).getTime();
function fixture() {
  const project = makeProject({ name: 'goosy', root: '/fixture/goosy' });
  const agents = [
    { id: 'a1', terminalId: 'a1', paneId: 'w9:p1', provider: 'claude', name: 'alpha-reviewer', agentName: 'alpha-reviewer', status: 'working' },
    { id: 'a2', terminalId: 'a2', paneId: 'w9:p2', provider: 'claude', name: 'bravo-reviewer', agentName: 'bravo-reviewer', status: 'done' },
  ].map(agent => ({ ...agent, workspace: { id: 'w9', name: project.name, path: '/fixture/goosy/goosy-ios' } }));
  const task = { id: 'owned', attemptId: 'owned-attempt', name: 'alpha-reviewer', inputTask: 'Review synthetic changes', project,
    agent: { provider: 'claude' }, at: new Date(currentTime - 10 * 86400000).toISOString(), dismissed: false,
    launch: { state: 'submitted', delivery: 'launch', message: 'Started' }, live: { status: 'working', since: new Date(currentTime).toISOString() },
    target: { ...agents[0] }, subfolder: '', observedActivity: true, placement: { mode: 'here', targetKind: 'tab', cwd: agents[0].workspace.path, reason: 'Main folder' } };
  let state = { snapshot: { mode: 'live', source: { state: 'connected' }, agents, updatedAt: new Date(currentTime).toISOString() },
    modelInfoByAgent: { a1: { model: 'claude-opus-5-5', effort: 'xhigh' } }, ageInfoByAgent: { a1: { pid: 701, startedAt: currentTime - 16 * 60000 } },
    boardView: 'agents', view: 'board', selectedTaskId: 'task:owned', selectedId: 'a1', tasks: [task], projects: [project], trustRequired: [],
    query: '', filter: 'all', suggestions: [], projectsLoading: false, profilesLoading: false, detailOffset: 0, busy: null, notice: null,
    draft: { provider: 'codex', projectKey: project.key, name: '', prompt: '', subfolder: '' }, command: '', cursor: { command: 0 },
    profiles: { providers: [{ id: 'codex', available: true }, { id: 'claude', available: true }] } };
  const model = { getSnapshot: () => state, selected: () => state.boardView === 'tasks'
    ? taskRows(state).find(row => row.id === state.selectedTaskId)?.agent : state.snapshot.agents.find(agent => agent.id === state.selectedId), action() {} };
  return { model, patch: patch => { state = { ...state, ...patch }; } };
}
const leftPanel = line => line.includes('││') ? line.slice(0, line.indexOf('││') + 1) : line;
function draw(f, width, height = 14) {
  const ansi = renderToString(React.createElement(TuiView, { state: f.model.getSnapshot(), model: f.model, width, height }), { columns: width });
  const text = stripVTControlCharacters(ansi), lines = text.split('\n');
  assert(lines.length <= height); assert(lines.every(line => displayWidth(line) <= width));
  return { ansi, text, lines: lines.map(leftPanel) };
}
const row = (screen, name = 'alpha-reviewer') => screen.lines.find(line => line.includes(name) && /Working|Done|Starting/.test(line));

function layoutChecks({ columns, rows, color }) {
  const originalNow = Date.now; Date.now = () => currentTime;
  try {
    const f = fixture(), width = columns - 1, height = rows - 1;
    for (const boardView of ['tasks', 'agents']) {
      f.patch({ boardView }); const screen = draw(f, width, height), selected = row(screen);
      assert(selected); assert.match(selected, /alpha-reviewer\s+Working/);
      if (color) assert.match(screen.ansi, /\x1b\[/); else assert.doesNotMatch(screen.ansi, /\x1b\[/);
      if (columns === 120) {
        const blank = row(screen, 'bravo-reviewer'); assert(blank);
        assert.match(selected, /opus 5\.5\s+xhigh\s+16m\s+goosy-ios/);
        assert.equal(selected.indexOf('Working'), blank.indexOf('Done'));
        assert.equal(selected.indexOf('goosy-ios'), blank.indexOf('goosy-ios'));
        assert.equal(blank.slice(selected.indexOf('16m'), selected.indexOf('16m') + 3), '   ');
      } else assert.doesNotMatch(selected, /opus 5\.5|xhigh|16m|goosy-ios/);
    }
  } finally { Date.now = originalNow; }
}

if (process.env.SHEP_CHECKPOINT95_LAYOUT_CASE) layoutChecks(JSON.parse(process.env.SHEP_CHECKPOINT95_LAYOUT_CASE));
else {
  for (const [columns, rows] of [[120, 40], [40, 15]]) for (const color of [true, false]) test(
    `checkpoint95 aligned age and folder in Tasks/Agents at ${columns}x${rows} ${color ? 'color' : 'NO_COLOR'}`, async () => {
      const env = { ...process.env, TERM: 'xterm-256color', SHEP_CHECKPOINT95_LAYOUT_CASE: JSON.stringify({ columns, rows, color }) };
      if (color) { delete env.NO_COLOR; env.FORCE_COLOR = '3'; } else { env.NO_COLOR = '1'; delete env.FORCE_COLOR; }
      await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url)], { env, maxBuffer: 2e6 });
    });

  test('checkpoint95 narrow columns drop effort, model, age, then folder while keeping name and status', t => {
    t.mock.method(Date, 'now', () => currentTime); const f = fixture();
    for (const boardView of ['tasks', 'agents']) {
      f.patch({ boardView });
      for (const [width, visible] of [[90, ['xhigh', 'opus 5.5', '16m', 'goosy-ios']], [64, ['opus 5.5', '16m', 'goosy-ios']],
        [58, ['16m', 'goosy-ios']], [49, ['goosy-ios']], [40, []]]) {
        const selected = row(draw(f, width)); assert(selected); assert.match(selected, /alpha-reviewer\s+Working/);
        for (const value of ['xhigh', 'opus 5.5', '16m', 'goosy-ios']) assert.equal(selected.includes(value), visible.includes(value), `${boardView} width ${width}: ${selected}`);
      }
    }
  });

  test('checkpoint95 age is recalculated each render and formats minutes, hours and days', t => {
    let time = currentTime; t.mock.method(Date, 'now', () => time); const f = fixture();
    f.patch({ ageInfoByAgent: { a1: { pid: 701, startedAt: currentTime } } });
    for (const [milliseconds, expected] of [[0, '<1m'], [59000, '<1m'], [60000, '1m'], [16 * 60000, '16m'], [2 * 3600000, '2h'], [3 * 86400000, '3d']]) {
      time = currentTime + milliseconds; assert(row(draw(f, 100)).includes(expected));
    }
  });

  test('checkpoint95 details report process duration and local start time for owned and external agents', t => {
    t.mock.method(Date, 'now', () => currentTime); const f = fixture();
    const original = f.model.getSnapshot();
    f.patch({ view: 'detail', ageInfoByAgent: { a1: { pid: 701, startedAt: currentTime - 134 * 60000 } } });
    for (const boardView of ['tasks', 'agents']) for (const tasks of [original.tasks, []]) {
      f.patch({ boardView, tasks, selectedTaskId: tasks.length ? 'task:owned' : 'agent:claude:a1' });
      if (!tasks.length && boardView === 'tasks') f.patch({ selectedTaskId: taskRows(f.model.getSnapshot()).find(item => item.agent?.id === 'a1').id });
      assert.match(draw(f, 100, 38).text, /Running for 2h 14m \(since 20:57\)/);
      assert.doesNotMatch(draw(f, 100, 38).text, /10d|240h/);
    }
  });

  test('checkpoint95 details include the local start date when process duration includes days', t => {
    t.mock.method(Date, 'now', () => currentTime); const f = fixture();
    const original = f.model.getSnapshot();
    f.patch({ view: 'detail', ageInfoByAgent: { a1: { pid: 701, startedAt: currentTime - (3 * 86400 + 134 * 60) * 1000 } } });
    for (const boardView of ['tasks', 'agents']) for (const tasks of [original.tasks, []]) {
      f.patch({ boardView, tasks, selectedTaskId: tasks.length ? 'task:owned' : 'agent:claude:a1' });
      if (!tasks.length && boardView === 'tasks') f.patch({ selectedTaskId: taskRows(f.model.getSnapshot()).find(item => item.agent?.id === 'a1').id });
      assert.match(draw(f, 87, 38).text, /Running for 3d 2h 14m \(since 2026-10-07 20:57\)/);
    }
  });

  test('checkpoint95 Starting tasks and missing process metadata never fall back to task launch time', t => {
    t.mock.method(Date, 'now', () => currentTime); const f = fixture(), original = f.model.getSnapshot();
    f.patch({ boardView: 'tasks', ageInfoByAgent: {} });
    assert.doesNotMatch(row(draw(f, 100)), /\b(?:\d+[mhd]|<1m)\b/);
    f.patch({ snapshot: { ...original.snapshot, agents: [] }, tasks: [{ ...original.tasks[0], target: null, live: { status: 'unknown' }, launch: { state: 'starting', message: 'Starting synthetic agent' } }] });
    assert.match(row(draw(f, 100)), /Starting/); assert.doesNotMatch(row(draw(f, 100)), /\b(?:\d+[mhd]|<1m)\b/);
    f.patch({ view: 'detail' }); assert.doesNotMatch(draw(f, 100, 38).text, /Running for|10d|240h/);
  });
}
