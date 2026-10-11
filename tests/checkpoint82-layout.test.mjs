import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { render, renderToString, measureElement } from 'ink';
import { TuiView } from '../src/tui.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { makeProject } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const project = makeProject({ name: 'goosy', root: '/fixture/goosy' });
  const agents = [
    { id: 'a1', terminalId: 'a1', paneId: 'w9:p1', provider: 'claude', name: 'review', agentName: 'review', status: 'working' },
    { id: 'a2', terminalId: 'a2', paneId: 'w9:p2', provider: 'claude', name: 'claude', agentName: null, status: 'done' },
  ].map(agent => ({ ...agent, workspace: { id: 'w9', name: project.name, path: project.root } }));
  let state = { snapshot: { mode: 'live', source: { state: 'connected' }, agents, updatedAt: new Date().toISOString() },
    modelInfoByAgent: { a1: { model: 'claude-opus-5-5', effort: 'high' } },
    boardView: 'agents', view: 'board', selectedTaskId: null, selectedId: 'a1', tasks: [], projects: [project], trustRequired: [],
    query: '', filter: 'all', suggestions: [], projectsLoading: false, profilesLoading: false, detailOffset: 0, busy: null, notice: null,
    draft: { provider: 'codex', projectKey: project.key, name: '', prompt: '', subfolder: '' }, command: '', cursor: { command: 0 },
    profiles: { providers: [{ id: 'codex', available: true }, { id: 'claude', available: true }] } };
  const actions = [];
  const model = { getSnapshot: () => state, selected: () => state.snapshot.agents.find(agent => agent.id === state.selectedId),
    action(name, value) { actions.push([name, value]); if (name === 'detail-position') state = { ...state, detailOffset: value }; } };
  return { model, actions, patch: patch => { state = { ...state, ...patch }; } };
}
const leftPanel = line => line.includes('││') ? line.slice(0, line.indexOf('││') + 1) : line;
async function renderingCase({ columns, rows, color }) {
  const f = fixture(), width = columns - 1, height = rows - 1, registry = new Map(), input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } }); Object.assign(output, { columns, rows, isTTY: true });
  const tree = () => React.createElement(TuiView, { state: f.model.getSnapshot(), model: f.model, width, height, registry });
  const instance = render(tree(), { stdin: input, stdout: output, stderr: output, exitOnCtrlC: false, patchConsole: false, interactive: false });
  async function draw() {
    instance.rerender(tree()); await tick(); await instance.waitUntilRenderFlush();
    const ansi = renderToString(React.createElement(TuiView, { state: f.model.getSnapshot(), model: f.model, width, height }), { columns: width });
    if (color) assert.match(ansi, /\x1b\[/); else assert.doesNotMatch(ansi, /\x1b\[/);
    const text = stripVTControlCharacters(ansi), lines = text.split('\n');
    assert(lines.length <= height); assert(lines.every(line => displayWidth(line) <= width));
    return { text, lines, ansi };
  }
  try {
    await tick(); await instance.waitUntilRenderFlush();
    for (const boardView of ['tasks', 'agents']) {
      f.patch({ boardView, view: 'board' });
      const withInfo = await draw(), rowId = boardView === 'tasks' ? 'task-agent:claude:a1' : 'agent-a1';
      // The two views use different row IDs; inspect their stable target box.
      const entry = [...registry.entries()].find(([id]) => id.startsWith(boardView === 'tasks' ? 'task-' : 'agent-') && id.endsWith('a1'))?.[1];
      assert(entry, `${rowId}: ${[...registry.keys()].join(',')}`); const box = measureElement(entry.ref.current);
      const selected = leftPanel(withInfo.lines[box.y]);
      assert.match(selected, /review\s+Working/);
      assert.match(withInfo.text, /e Rename/);
      if (columns === 120) {
        assert.equal(box.width, Math.floor(width * .7) - 4);
        assert.match(selected, /review\s+Working\s{2}Claude\s{2}opus 5\.5\s{2}high/);
        const unnamed = withInfo.lines.map(leftPanel).find(line => /Claude w9:p2.*Done/.test(line));
        assert(unnamed); assert.equal(unnamed.indexOf('Done'), selected.indexOf('Working'));
        assert.equal(unnamed.indexOf('Claude', unnamed.indexOf('Done')), selected.indexOf('Claude', selected.indexOf('Working')));
        assert.equal(unnamed.slice(selected.indexOf('opus 5.5')).replace(/[│ ]/g, ''), '', 'Missing fields leave blank aligned cells');
      } else assert.doesNotMatch(selected, /opus 5\.5|high/);
      f.patch({ modelInfoByAgent: {} });
      await draw(); assert.equal(measureElement(entry.ref.current).width, box.width, 'Model arrival/removal never changes list width');
      f.patch({ modelInfoByAgent: { a1: { model: 'claude-opus-5-5', effort: 'high' } } });
      f.patch({ view: 'detail' }); const detail = await draw();
      assert.match(detail.text, /e Rename/); assert.match(detail.text, /(?:Enter Focus|Focus ↵)/); assert.match(detail.text, /Close/);
      f.patch({ view: 'rename', rename: { target: f.model.selected(), text: 'review', cursor: 6, error: null, returnView: 'detail' } });
      const editor = await draw(); assert.match(editor.text, /RENAME AGENT/); assert.match(editor.text, /review▏/);
      assert.match(editor.text, /Rename Enter/); assert.match(editor.text, /Cancel Esc/);
      registry.get('rename-send').action(); assert.deepEqual(f.actions.at(-1), ['rename-send', undefined]);
      registry.get('rename-back').action(); assert.deepEqual(f.actions.at(-1), ['cancel', undefined]);
      f.patch({ rename: { ...f.model.getSnapshot().rename, text: 'Invalid', cursor: 7, error: 'Name must start with a-z.' } });
      assert.match((await draw()).text, /Name must start with a-z\./);
      f.patch({ rename: { ...f.model.getSnapshot().rename, text: 'a'.repeat(32), cursor: 32, error: null } });
      assert.match((await draw()).text, /a{28,32}▏/, 'The one-line editor keeps the name tail and cursor visible');
      f.patch({ rename: { ...f.model.getSnapshot().rename, target: f.model.getSnapshot().snapshot.agents[1], text: '', cursor: 0, error: null } });
      const unnamedEditor = await draw(); assert.match(unnamedEditor.text, /Claude · w9:p2/);
      assert.doesNotMatch(unnamedEditor.text, /claude▏|review▏/);
    }
    if (columns === 40) for (const status of ['failed', 'closed']) {
      const project = f.model.getSnapshot().projects[0];
      const task = { id: 'failed-task', attemptId: 'attempt-1', name: 'failed-task', inputTask: 'Reply with OK', project,
        agent: { provider: 'claude' }, at: new Date().toISOString(), dismissed: false, target: null,
        launch: { state: status === 'failed' ? 'failed' : 'submitted', message: 'Synthetic fixture' },
        live: { status: status === 'failed' ? 'unknown' : 'closed', since: new Date().toISOString() } };
      f.patch({ boardView: 'tasks', view: 'board', tasks: [task], selectedTaskId: 'task:failed-task', selectedId: null });
      const screen = await draw();
      for (const [id, label] of [['quit', 'Quit'], ['rename-footer', 'e Rename'], ['follow-up', 'p Send'], ['clear', 'c Clear'], ['clear-closed', 'C All']]) {
        const entry = registry.get(id); assert(entry, `${status} ${id}`); const box = measureElement(entry.ref.current);
        assert(box.x >= 0 && box.x + box.width <= width, `${status} ${id} stays outside reserved terminal column`);
        assert.equal(box.height, 1); assert.equal(box.y, height - 1);
        assert(screen.lines[box.y].includes(label), `${status} ${label} remains visible`);
      }
    }
  } finally { instance.unmount(); input.destroy(); output.destroy(); }
}
function thresholdCase() {
  const f = fixture();
  for (const boardView of ['tasks', 'agents']) for (const [width, gap] of [[69, 1], [70, 2], [99, 2], [100, 3]]) {
    f.patch({ boardView, view: 'board' });
    // A short pane does not split, so these are the exact list-panel widths.
    const text = stripVTControlCharacters(renderToString(React.createElement(TuiView,
      { state: f.model.getSnapshot(), model: f.model, width, height: 14 }), { columns: width }));
    const row = text.split('\n').find(line => /review\s+Working/.test(line));
    assert(row, `${boardView} ${width}`);
    assert.equal(row.indexOf('Claude', row.indexOf('Working')) - row.indexOf('Working') - 'Working'.length, gap);
    assert.equal(row.indexOf('opus 5.5') - row.indexOf('Claude', row.indexOf('Working')) - 'Claude'.length, gap);
    assert.equal(row.indexOf('high') - row.indexOf('opus 5.5') - 'opus 5.5'.length, gap);
  }
}
if (process.env.SHEP_CHECKPOINT82_LAYOUT_CASE) await renderingCase(JSON.parse(process.env.SHEP_CHECKPOINT82_LAYOUT_CASE));
else {
  test('checkpoint82 column gaps use list-panel widths at 69/70/99/100', thresholdCase);
  for (const [columns, rows] of [[120, 40], [40, 15]]) for (const color of [true, false]) test(
    `checkpoint82 fixed columns and rename editor at ${columns}x${rows} ${color ? 'color' : 'NO_COLOR'}`, async () => {
      const env = { ...process.env, TERM: 'xterm-256color', SHEP_CHECKPOINT82_LAYOUT_CASE: JSON.stringify({ columns, rows, color }) };
      if (color) { delete env.NO_COLOR; env.FORCE_COLOR = '3'; } else { env.NO_COLOR = '1'; delete env.FORCE_COLOR; }
      await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url)], { env, maxBuffer: 2e6 });
    });
}
