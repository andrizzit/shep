import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { render, renderToString, measureElement } from 'ink';
import { TuiView, boardRows, listRows } from '../src/tui.mjs';
import { hitTest } from '../src/tui-model.mjs';
import { taskRows } from '../src/tui-tasks.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { makeProject } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const project = makeProject({ worktrees: [{ path: '/fixture/shep-ui', branch: 'ui' }] });
  const agents = [
    ['a1', 'orchestrator', 'claude', 'done', project.root],
    ['a2', 'design', 'claude', 'blocked', project.root],
    ['a3', 'research', 'grok', 'working', project.root],
    ['a4', 'frontend', 'codex', 'idle', project.root + '/src/ui'],
    ['a5', null, 'codex', 'idle', '/fixture/shep-ui'],
  ].map(([id, name, provider, status, path], index) => ({ id, terminalId: id, paneId: `w1:p${index + 1}`, agentName: name,
    name: name || 'Codex · w1:p5', provider, status, workspace: { name: 'shep', path }, sessionId: id + '-session' }));
  const tasks = agents.slice(0, 2).map((agent, index) => ({ id: `task-${agent.id}`, attemptId: 'attempt-' + agent.id,
    name: agent.name, inputTask: index ? 'Review the interface and report findings.' : 'Improve the application.',
    project, agent: { provider: agent.provider }, at: new Date(Date.now() - 720000).toISOString(), dismissed: false,
    launch: { state: index ? 'needs_input' : 'submitted', message: index ? 'Answer in the agent pane.' : 'Agent opened.', delivery: 'launch' },
    live: { status: agent.status, since: new Date().toISOString() }, target: { ...agent }, subfolder: '',
    placement: { mode: 'here', targetKind: 'tab', cwd: project.root, reason: 'Main checkout by default' },
    summary: index ? null : { state: 'available', changedFiles: 3, insertions: 4, deletions: 2 }, observedActivity: !index,
  }));
  let state = { snapshot: { mode: 'live', updatedAt: new Date().toISOString(), source: { state: 'connected' }, agents },
    boardView: 'tasks', view: 'board', query: '', filter: 'all', selectedTaskId: 'task:task-a1', selectedId: 'a1',
    tasks, projects: [project], trustRequired: [], projectsLoading: false, profilesLoading: false, busy: null, notice: null,
    profiles: { providers: ['codex', 'claude', 'grok'].map(id => ({ id, name: id, available: true })) },
    draft: { provider: 'codex', projectKey: project.key, subfolder: '', name: '', prompt: '' }, command: '', cursor: { command: 0 },
    field: 'provider', suggestions: [], detailOffset: 0, requiredNotice: null };
  const actions = [];
  const model = { getSnapshot: () => state,
    selected: () => state.boardView === 'tasks' ? taskRows(state).find(row => row.id === state.selectedTaskId)?.agent : agents.find(agent => agent.id === state.selectedId),
    action: (name, value) => {
      actions.push([name, value]);
      if (name === 'click-task') state = { ...state, selectedTaskId: value };
      if (name === 'click-agent') state = { ...state, selectedId: value };
      if (name === 'detail-position') state = { ...state, detailOffset: value };
    } };
  return { model, actions, patch: patch => { state = { ...state, ...patch }; } };
}

async function layoutCase({ columns, rows, color }) {
  const width = columns - 1, height = rows - 1;
  const f = fixture(), registry = new Map(), input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  Object.assign(output, { columns, rows, isTTY: true });
  const tree = offset => React.createElement(TuiView, { state: f.model.getSnapshot(), model: f.model, width, height, registry, offset });
  const instance = render(tree(0), { stdin: input, stdout: output, stderr: output, exitOnCtrlC: false, patchConsole: false, interactive: false });
  async function draw(offset = 0) {
    instance.rerender(tree(offset)); await tick(); await instance.waitUntilRenderFlush();
    const ansi = renderToString(React.createElement(TuiView, { state: f.model.getSnapshot(), model: f.model, width, height, offset }), { columns: width });
    if (color) assert.match(ansi, /\x1b\[/); else assert.doesNotMatch(ansi, /\x1b\[/);
    const screen = stripVTControlCharacters(ansi), lines = screen.split('\n');
    assert(lines.length <= height); assert(lines.every(line => displayWidth(line) <= width));
    return { ansi, screen, lines };
  }
  function click(id) {
    const entry = registry.get(id); assert(entry, id);
    const box = measureElement(entry.ref.current); assert.equal(box.height, 1); assert(box.width > 0);
    assert(box.y >= 0 && box.y < height);
    assert.equal(hitTest({ x: box.x + 1, y: box.y }, registry.values(), measureElement), entry);
    entry.action();
  }
  try {
    const flat = boardRows(f.model.getSnapshot());
    const names = flat.filter(row => row.type === 'task').map(row => row.row.task?.name || row.row.agent.name);
    assert.equal(names[0], 'design', 'Needs you sorts before Done and Working in its project');
    assert.equal(flat.filter(row => row.type === 'task-extra').length, 2, 'Only attention and finished change summary add a line');
    let screen = await draw();
    assert.match(screen.screen, columns === 40 ? /n New\b/ : /n New agent/); assert.doesNotMatch(screen.screen, /n Setup|n setup/);
    assert.match(screen.screen, /! 1 need you/);
    assert.match(screen.screen, /▌.*design.*! Needs you/);
    const attentionLine = screen.ansi.split('\n').find(row => stripVTControlCharacters(row).includes('design') && stripVTControlCharacters(row).includes('! Needs you'));
    if (color) assert.match(attentionLine, /\x1b\[1m[^\n]*design/);
    click('task-task:task-a2'); assert.deepEqual(f.actions.at(-1), ['click-task', 'task:task-a2']);
    let listText = '';
    for (let offset = 0; offset < flat.length; offset += 1) {
      screen = await draw(offset);
      const item = flat[offset];
      if (item.type === 'task') {
        const entry = registry.get('task-' + item.row.id); assert(entry);
        const y = measureElement(entry.ref.current).y;
        listText += screen.lines[y] + '\n';
        click('task-' + item.row.id); assert.deepEqual(f.actions.at(-1), ['click-task', item.row.id]);
      }
    }
    assert.doesNotMatch(listText, /external ·|\/fixture\//);
    assert.match(listText, /src\/ui/); assert.match(listText, /Codex.*w1:p5/);
    if (columns === 120) assert.match(listText, /shep-ui/);
    f.patch({ boardView: 'agents', selectedId: 'a1' });
    const providerRows = listRows(f.model.getSnapshot());
    assert.equal(providerRows.filter(row => row.type === 'agent' && row.agent.provider === 'claude')[0].agent.id, 'a2');
    assert.equal(providerRows.filter(row => row.type === 'agent-extra').length, 2);
    for (let offset = 0; offset < providerRows.length; offset += 1) {
      const item = providerRows[offset]; if (item.type !== 'agent') continue;
      screen = await draw(offset); const y = measureElement(registry.get('agent-' + item.agent.id).ref.current).y;
      assert.doesNotMatch(screen.lines[y], /external ·|\/fixture\//);
      if (item.agent.id === 'a5') {
        assert.match(screen.lines[y], /Codex.*w1:p5/);
        if (color) assert.match(screen.ansi.split('\n')[y], /\x1b\[38;2;130;152;137m w1:p5/);
      }
      click('agent-' + item.agent.id); assert.deepEqual(f.actions.at(-1), ['click-agent', item.agent.id]);
    }
    f.patch({ boardView: 'tasks', view: 'detail', selectedTaskId: 'task:task-a2', detailOffset: 0,
      tasks: f.model.getSnapshot().tasks.map(task => task.id === 'task-a2' ? { ...task, name: 'design-exceptionally-long-name' } : task) });
    screen = await draw(); assert.match(screen.screen, /TASK ·.*design.*! Needs you/);
    let details = '', dimIds = '';
    for (let offset = 0; offset < 45; offset += 1) {
      f.patch({ detailOffset: offset }); screen = await draw();
      const at = screen.lines.findIndex(line => line.includes('TASK ·'));
      const range = screen.screen.match(/(\d+)–(\d+)\/(\d+)/); assert(range);
      const [, first, last, total] = range.map(Number);
      const shown = screen.lines.slice(at + 1, at + 1 + last - first + 1).join('\n');
      details += shown + '\n';
      dimIds += screen.ansi.split('\n').filter(line => /Pane:|Terminal:/.test(stripVTControlCharacters(line))).join('\n');
      if (last === total) break;
    }
    assert.match(details, /Review the interface/); assert.match(details, /\/fixture\/shep/);
    assert(details.indexOf('Review the interface') < details.indexOf('Pane:'));
    assert(details.indexOf('/fixture/shep') < details.indexOf('Pane:'));
    assert.match(details, /Pane: w1:p2/); assert.match(details, /Terminal: a2/);
    if (color) assert.match(dimIds, /\x1b\[38;2;130;152;137m(?:Pane:|Terminal:)/);
    assert.match(screen.screen, /Focus ↵/); assert.match(screen.screen, /Close x/); assert.match(screen.screen, /Back Esc/);
    f.patch({ boardView: 'agents', view: 'detail', selectedId: 'a5', detailOffset: 0 });
    let externalDetail = '';
    for (let page = 0; page < 20; page += 1) {
      screen = await draw(); externalDetail += screen.screen + '\n';
      assert.match(screen.screen, /Codex.*w1:p5.*Done/);
      assert.match(screen.screen, /Enter Focus/); assert.match(screen.screen, /x Close/); assert.match(screen.screen, /Esc Back/);
      const [, , last, total] = screen.screen.match(/(\d+)–(\d+)\/(\d+)/).map(Number);
      if (last === total) break;
      click('detail-down');
    }
    assert.match(externalDetail, /\/fixture\/shep-ui/); assert.match(externalDetail, /Pane: w1:p5/); assert.match(externalDetail, /Terminal: a5/);
    f.patch({ view: 'board', projects: [], tasks: [], snapshot: { ...f.model.getSnapshot().snapshot, agents: [] }, draft: { provider: 'codex', projectKey: '' } });
    screen = await draw(); if (columns === 120) assert.match(screen.screen, /n New agent → Project/);
  } finally { instance.unmount(); input.destroy(); output.destroy(); }
}

if (process.env.SHEP_CHECKPOINT7_LAYOUT_CASE) {
  await layoutCase(JSON.parse(process.env.SHEP_CHECKPOINT7_LAYOUT_CASE));
} else {
  for (const [columns, rows] of [[120, 40], [40, 15]]) for (const color of [true, false]) {
    test(`checkpoint7 hierarchy and exact mouse rows at ${columns}×${rows} ${color ? 'color' : 'NO_COLOR'}`, async () => {
      const env = { ...process.env, TERM: 'xterm-256color', SHEP_CHECKPOINT7_LAYOUT_CASE: JSON.stringify({ columns, rows, color }) };
      if (color) { delete env.NO_COLOR; env.FORCE_COLOR = '3'; } else { env.NO_COLOR = '1'; delete env.FORCE_COLOR; }
      await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url)], { env, maxBuffer: 2 * 1024 * 1024 });
    });
  }
}
