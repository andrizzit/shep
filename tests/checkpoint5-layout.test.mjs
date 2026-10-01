import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import React from 'react';
import { render, renderToString, measureElement } from 'ink';
import { createTuiModel, hitTest } from '../src/tui-model.mjs';
import { TuiView } from '../src/tui.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { createFakeRegistry, makeProject } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const providers = ['codex', 'claude', 'grok', 'kiro', 'gemini', 'pi', 'copilot', 'qwen'].map(id => ({ id, name: id.toUpperCase(), available: true }));
providers.push({ id: 'cursor', name: 'Unavailable Cursor', available: false, reason: 'Cursor is not installed.' });
const projects = Array.from({ length: 7 }, (_, index) => makeProject({ key: `dir:/fixture/project${index}`, name: `project${index}`, root: `/fixture/project${index}`, aliases: [], kind: 'folder', commonDir: null }));

async function fixture() {
  const calls = [];
  const snapshot = { mode: 'live', updatedAt: new Date().toISOString(), source: { state: 'connected' }, agents: [] };
  const model = createTuiModel({ monitor: { getSnapshot: () => snapshot, subscribe: () => () => {} }, registry: createFakeRegistry({ projects }), controller: {
    getProfiles: async () => ({ providers, workspaces: [], defaultCwd: projects[0].root }),
    dispatch: async (request, { onProgress }) => {
      calls.push(request); await onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString() });
      return { ok: true, state: 'submitted', message: 'Submitted.', taskId: request.taskId, attemptId: request.attemptId };
    },
  } });
  await model.ready; return { model, calls };
}

async function layoutCase({ columns, rows, color }) {
  const width = columns - 1, height = rows - 1;
  const { model, calls } = await fixture();
  const registry = new Map(), input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  Object.assign(output, { columns, rows, isTTY: true });
  const tree = state => React.createElement(TuiView, { state, model, width, height, registry });
  const instance = render(tree(model.getSnapshot()), { stdin: input, stdout: output, stderr: output, exitOnCtrlC: false, patchConsole: false, interactive: false });
  async function draw(state = model.getSnapshot()) {
    instance.rerender(tree(state)); await tick(); await instance.waitUntilRenderFlush();
    const colored = renderToString(React.createElement(TuiView, { state, model, width, height }), { columns: width });
    if (color) assert.match(colored, /\x1b\[/); else assert.doesNotMatch(colored, /\x1b\[/);
    const screen = stripVTControlCharacters(colored), lines = screen.split('\n');
    assert(lines.length <= height); assert(lines.every(line => displayWidth(line) <= width));
    return { screen, lines };
  }
  function entries(prefix) {
    return [...registry].filter(([key]) => key.startsWith(prefix)).map(([id, entry]) => ({ id, entry, ...measureElement(entry.ref.current) })).sort((a, b) => a.y - b.y);
  }
  function clickable(row) {
    assert(row.width > 0); assert.equal(row.height, 1); assert(row.y >= 0 && row.y < height);
    const hit = hitTest({ x: row.x + Math.min(1, row.width / 2), y: row.y }, registry.values(), measureElement);
    assert.equal(hit, row.entry, `${row.id} must have its own mouse hitbox`);
    return hit;
  }
  try {
    model.paste('/dispatch @'); let painted = await draw();
    assert.equal(model.getSnapshot().suggestions.length, 5, 'The frozen completion cap remains unchanged');
    let choices = entries('suggest-');
    assert(choices.length >= 1 && choices.length <= 5);
    if (columns === 40) assert(choices.length < 5); else assert.equal(choices.length, 5);
    assert.equal(choices[0].y, measureElement(registry.get('command').ref.current).y + 1);
    choices.forEach((row, index) => { clickable(row); assert.equal(row.y, choices[0].y + index); });
    assert.match(painted.screen, /↑↓ choose · Tab\/Enter accept/);
    assert.match(painted.lines[choices[0].y], /› project0/);
    assert(!registry.has('suggest-next')); assert(!registry.has('suggest-current'));
    for (let step = 0; step < 4; step += 1) model.key('', { downArrow: true });
    painted = await draw(); choices = entries('suggest-');
    const last = choices.find(row => row.id === 'suggest-4'); assert(last);
    assert.match(painted.lines[last.y], /› project4/);
    if (columns === 40) assert(!registry.has('suggest-0'), 'The compact list scrolls past hidden options');
    choices.forEach(clickable);
    const chosenIndex = Number(choices[0].id.slice('suggest-'.length));
    clickable(choices[0]).action(); await draw();
    assert.equal(model.getSnapshot().command, `/dispatch @project${chosenIndex}`); assert.equal(calls.length, 0);

    model.action('cancel'); model.action('new'); painted = await draw();
    let agents = entries('provider-');
    assert(agents.length >= 1 && agents.length <= 5); assert(!registry.has('provider-cursor'));
    assert.match(painted.lines[agents[0].y], /› CODEX/);
    assert.doesNotMatch(painted.screen, /‹ ›|Unavailable Cursor/);
    agents.forEach((row, index) => { clickable(row); assert.equal(row.y, agents[0].y + index); });
    for (let step = 0; step < 7; step += 1) model.key('', { downArrow: true });
    painted = await draw(); agents = entries('provider-');
    assert.equal(model.getSnapshot().draft.provider, 'qwen');
    const selected = agents.find(row => row.id === 'provider-qwen'); assert(selected);
    assert.match(painted.lines[selected.y], /› QWEN/); assert(!registry.has('provider-codex'));
    model.key('', { upArrow: true }); assert.equal(model.getSnapshot().draft.provider, 'copilot');
    model.key('', { leftArrow: true }); assert.equal(model.getSnapshot().draft.provider, 'pi');
    model.key('', { rightArrow: true }); assert.equal(model.getSnapshot().draft.provider, 'copilot');
    model.key('', { downArrow: true }); await draw(); agents = entries('provider-');
    agents.forEach(clickable); clickable(agents[0]).action();
    assert.equal(model.getSnapshot().draft.provider, agents[0].id.slice('provider-'.length));
    model.key('', { return: true }); assert.equal(model.getSnapshot().field, 'projectKey');
    model.action('field', 'provider'); model.key('', { tab: true }); assert.equal(model.getSnapshot().field, 'projectKey');
    assert.equal(calls.length, 0);

    model.action('field', 'provider');
    const base = model.getSnapshot();
    for (const extra of [{}, { dispatchHold: true }, { dispatchHold: true, draft: { ...base.draft, subfolder: 'src/api' }, projects: [makeProject({ key: base.draft.projectKey })] },
      { requiredNotice: { token: 'fixture-notice', subfolder: 'src/api', event: { message: 'Worktree starts at repository root; selected subfolder is not applied' } } }]) {
      const { screen } = await draw({ ...base, ...extra });
      assert.match(screen, /Dispatch agent/);
      if (columns === 40) assert.match(screen, /Prev.*Next.*Back/);
      else { assert.match(screen, /Project/); assert.match(screen, /Name \(optional\)/); }
      assert(entries('provider-').length >= 1);
      if (extra.requiredNotice) assert(screen.replace(/\s/g, '').includes(extra.requiredNotice.event.message.replace(/\s/g, '')));
    }
    painted = await draw({ ...base, profiles: { ...base.profiles, providers: [{ id: 'cursor', name: 'Cursor', available: false, reason: 'Cursor is not installed.' }] }, draft: { ...base.draft, provider: 'cursor' } });
    assert.match(painted.screen, /No installed agents/); assert.match(painted.screen, /Cursor is not installed/); assert.equal(entries('provider-').length, 0);
    painted = await draw({ ...base, draft: { ...base.draft, provider: '' } });
    assert.doesNotMatch(painted.screen, /undefined|NaN/); assert(entries('provider-').length > 0);
  } finally { instance.cleanup(); model.destroy(); input.destroy(); output.destroy(); }
}

if (process.env.SHEP_CHECKPOINT5_LAYOUT) {
  await layoutCase(JSON.parse(process.env.SHEP_CHECKPOINT5_LAYOUT));
} else {
  for (const [columns, rows] of [[120, 40], [40, 15]]) for (const color of [true, false]) {
    test(`checkpoint5 vertical choices, scrolling and mouse targets at ${columns}×${rows} ${color ? 'color' : 'NO_COLOR'}`, async () => {
      const env = { ...process.env, SHEP_CHECKPOINT5_LAYOUT: JSON.stringify({ columns, rows, color }) };
      delete env.FORCE_COLOR; delete env.NO_COLOR;
      if (color) env.FORCE_COLOR = '3'; else env.NO_COLOR = '1';
      await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url)], { env, timeout: 15000, maxBuffer: 1024 * 1024 });
    });
  }
  test('checkpoint5 vertical rendering preserves Enter gating, Tab, wrap and recall keys', async t => {
    const { model, calls } = await fixture(); t.after(model.destroy);
    model.paste('/dispatch @'); model.key('', { upArrow: true }); assert.equal(model.getSnapshot().suggestionIndex, 4);
    model.key('', { downArrow: true }); assert.equal(model.getSnapshot().suggestionIndex, 0);
    model.key('', { downArrow: true }); model.key('', { return: true }); await tick();
    assert.equal(model.getSnapshot().command, '/dispatch @project1'); assert.equal(calls.length, 0);
    model.key(' task'); model.key('', { return: true }); await tick(); assert.equal(calls[0].prompt, 'task');
    model.paste('/dispatch c'); model.key('', { return: true }); await tick(); assert.equal(calls[1].prompt, 'c');
    model.paste('/dispatch c'); model.key('', { tab: true, shift: true }); model.key('', { tab: true });
    assert.equal(model.getSnapshot().command, '/dispatch claude'); assert.equal(calls.length, 2);
    model.action('cancel'); model.paste('/dispatch preserved draft'); assert.equal(model.getSnapshot().suggestions.length, 0);
    model.key('', { upArrow: true }); assert.equal(model.getSnapshot().command, '/dispatch c');
    model.key('', { escape: true }); assert.equal(model.getSnapshot().command, '/dispatch preserved draft');
  });
}
