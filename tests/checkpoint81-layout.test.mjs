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
  const project = makeProject({ name: 'goosy', root: '/fixture/goosy', worktrees: [{ path: '/fixture/goosy-backend' }, { path: '/fixture/goosy-ios' }] });
  const definitions = [['a1', 'backend', 'codex', 'working', '/fixture/goosy-backend'],
    ['a2', 'orchestrator', 'claude', 'done', project.root], ['a3', null, 'claude', 'idle', '/fixture/goosy-ios'],
    ['a4', null, 'grok', 'done', project.root], ['a5', null, 'claude', 'done', project.root]];
  const agents = definitions.map(([id, name, provider, status, path], index) => ({ id, terminalId: id, paneId: `w9:p${index + 1}`,
    name: name || provider, agentName: name, provider, status, sessionId: `session-${id}`, workspace: { id: 'w9', name: 'goosy', path } }));
  let state = { snapshot: { mode: 'live', source: { state: 'connected' }, agents, updatedAt: new Date().toISOString() },
    modelInfoByAgent: { a2: { model: 'claude-opus-5-5', effort: 'high' }, a3: { model: 'claude-opus-5-5', effort: 'high' },
      a4: { model: 'grok-4.7-build', effort: 'high' }, a5: { model: 'claude-fable-5-1' } },
    boardView: 'tasks', view: 'board', selectedTaskId: null, selectedId: 'a1', tasks: [], projects: [project], trustRequired: [],
    query: '', filter: 'all', suggestions: [], projectsLoading: false, profilesLoading: false, detailOffset: 0, busy: null, notice: null,
    draft: { provider: 'codex', projectKey: project.key, name: '', prompt: '', subfolder: '' }, command: '', cursor: { command: 0 },
    profiles: { providers: [{ id: 'codex', available: true }, { id: 'claude', available: true }] } };
  const actions = [];
  const model = { getSnapshot: () => state, selected: () => state.boardView === 'tasks'
    ? taskRows(state).find(row => row.id === state.selectedTaskId)?.agent : agents.find(agent => agent.id === state.selectedId),
    action(name, value) { actions.push([name, value]); if (name === 'click-task') state = { ...state, selectedTaskId: value };
      if (name === 'click-agent') state = { ...state, selectedId: value }; if (name === 'detail-position') state = { ...state, detailOffset: value }; } };
  return { model, actions, patch: patch => { state = { ...state, ...patch }; } };
}
async function layoutCase({ columns, rows, color }) {
  const f = fixture(), width = columns - 1, height = rows - 1, registry = new Map(), input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } }); Object.assign(output, { columns, rows, isTTY: true });
  const tree = offset => React.createElement(TuiView, { state: f.model.getSnapshot(), model: f.model, width, height, registry, offset });
  const instance = render(tree(0), { stdin: input, stdout: output, stderr: output, exitOnCtrlC: false, patchConsole: false, interactive: false });
  async function draw(offset = 0) {
    instance.rerender(tree(offset)); await tick(); await instance.waitUntilRenderFlush();
    const ansi = renderToString(React.createElement(TuiView, { state: f.model.getSnapshot(), model: f.model, width, height, offset }), { columns: width });
    if (color) assert.match(ansi, /\x1b\[/); else assert.doesNotMatch(ansi, /\x1b\[/);
    const text = stripVTControlCharacters(ansi), lines = text.split('\n');
    assert(lines.length <= height); assert(lines.every(line => displayWidth(line) <= width));
    return { ansi, text, lines };
  }
  try {
    for (const boardView of ['tasks', 'agents']) {
      f.patch({ boardView });
      const flat = boardView === 'tasks' ? boardRows(f.model.getSnapshot()) : listRows(f.model.getSnapshot());
      const named = flat.filter(item => item.type === (boardView === 'tasks' ? 'task' : 'agent'));
      if (columns === 120) {
        const screen = await draw(), rowLines = named.map(item => {
          const id = boardView === 'tasks' ? `task-${item.row.id}` : `agent-${item.agent.id}`;
          const entry = registry.get(id); assert(entry); const box = measureElement(entry.ref.current);
          assert.equal(box.height, 1); assert(box.width > 0);
          assert.equal(hitTest({ x: box.x + 1, y: box.y }, registry.values(), measureElement), entry);
          entry.action(); assert.equal(f.actions.at(-1)[0], boardView === 'tasks' ? 'click-task' : 'click-agent');
          const row = screen.lines[box.y], at = row.indexOf('││'); return at >= 0 ? row.slice(0, at + 1) : row;
        });
        const backend = rowLines.find(row => row.includes('backend')), orchestrator = rowLines.find(row => row.includes('orchestrator'));
        const ios = rowLines.find(row => row.includes('Claude w9:p3')), grok = rowLines.find(row => row.includes('Grok w9:p4'));
        const fable = rowLines.find(row => row.includes('Claude w9:p5'));
        assert(backend && orchestrator && ios && grok && fable);
        const statusAt = backend.indexOf('Working'), providerAt = backend.indexOf('Codex'), modelAt = orchestrator.indexOf('opus 5.5');
        const effortAt = orchestrator.indexOf('high'), folderAt = backend.indexOf('goosy-backend');
        for (const row of [orchestrator, ios, grok, fable]) assert.equal(row.indexOf('Done'), statusAt);
        for (const row of [orchestrator, ios, fable]) assert.equal(row.indexOf('Claude', statusAt), providerAt);
        assert.equal(grok.indexOf('Grok', statusAt), providerAt);
        assert.equal(ios.indexOf('opus 5.5'), modelAt); assert.equal(grok.indexOf('grok 4.7 build'), modelAt); assert.equal(fable.indexOf('fable 5.1'), modelAt);
        assert.equal(ios.indexOf('high'), effortAt); assert.equal(grok.indexOf('high'), effortAt);
        assert.equal(ios.indexOf('goosy-ios'), folderAt);
        assert.equal(backend.slice(modelAt, effortAt).trim(), '', 'Absent model reserves an empty aligned cell');
        assert.equal(fable.slice(effortAt, folderAt).trim(), '', 'Absent effort reserves its empty cell');
        assert.equal(orchestrator.slice(folderAt, -1).trim(), '', 'Absent folder keeps its column blank');
        assert.doesNotMatch(rowLines.join('\n'), /unknown|claude-fable|claude-opus/i);
        if (color) {
          assert.match(screen.ansi, /\x1b\[1m[^\n]*orchestrator/);
          assert.match(screen.ansi, /\x1b\[38;2;130;152;137m(?:opus 5\.5|fable 5\.1|grok 4\.7 build)/);
        }
      } else {
        for (let offset = 0; offset < flat.length; offset++) {
          const item = flat[offset]; if (!['task', 'agent'].includes(item.type)) continue;
          const screen = await draw(offset), id = boardView === 'tasks' ? `task-${item.row.id}` : `agent-${item.agent.id}`;
          const entry = registry.get(id); assert(entry); const box = measureElement(entry.ref.current);
          assert.equal(box.height, 1); assert(box.width > 0); assert(box.y >= 0 && box.y < height);
          assert.equal(hitTest({ x: box.x + 1, y: box.y }, registry.values(), measureElement), entry); entry.action();
          assert.match(screen.lines[box.y], /Working|Done/);
          assert.doesNotMatch(screen.lines[box.y], /opus 5\.5|fable 5\.1|grok 4\.7 build|xhigh|high/);
        }
      }
    }
    f.patch({ boardView: 'agents', view: 'detail', selectedId: 'a5', detailOffset: 0 });
    let details = '';
    for (let offset = 0; offset < 20; offset++) { f.patch({ detailOffset: offset }); details += (await draw()).text + '\n'; }
    assert.match(details, /Model: claude-fable-5-1/); assert.match(details, /Enter Focus/); assert.match(details, /Esc Back/);
  } finally { instance.unmount(); input.destroy(); output.destroy(); }
}
if (process.env.SHEP_CHECKPOINT81_LAYOUT_CASE) await layoutCase(JSON.parse(process.env.SHEP_CHECKPOINT81_LAYOUT_CASE));
else for (const [columns, rows] of [[120, 40], [40, 15]]) for (const color of [true, false]) test(
  `checkpoint81 aligned columns and empty cells at ${columns}x${rows} ${color ? 'color' : 'NO_COLOR'}`, async () => {
    const env = { ...process.env, TERM: 'xterm-256color', SHEP_CHECKPOINT81_LAYOUT_CASE: JSON.stringify({ columns, rows, color }) };
    if (color) { delete env.NO_COLOR; env.FORCE_COLOR = '3'; } else { env.NO_COLOR = '1'; delete env.FORCE_COLOR; }
    await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url)], { env, maxBuffer: 2e6 });
  });
