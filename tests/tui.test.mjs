import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { renderToString } from 'ink';
import { createTuiModel, editText, parseMouse, hitTest, visibleAgents, parseDispatch } from '../src/tui-model.mjs';
import { TuiView, startTui } from '../src/tui.mjs';
import { displayWidth } from '../src/terminal.mjs';

function fixture() {
  return { mode: 'live', updatedAt: new Date().toISOString(), source: { state: 'connected', scope: 'Fixture session' }, agents: [
    { id: 't1', terminalId: 't1', paneId: 'w1:p1', name: 'alpha', provider: 'claude', status: 'done', workspace: { id: 'w1', name: 'App', path: '/projects/app' } },
    { id: 't2', terminalId: 't2', paneId: 'w1:p2', name: 'beta', provider: 'codex', status: 'working', workspace: { id: 'w1', name: 'App', path: '/projects/app' } },
  ] };
}
async function harness(overrides = {}) {
  let snapshot = fixture();
  let listener;
  const calls = [];
  const monitor = { getSnapshot: () => snapshot, subscribe: callback => { listener = callback; return () => { listener = null; }; }, refresh: async () => snapshot };
  const controller = {
    getProfiles: async () => ({ providers: [{ id: 'claude', name: 'Claude', available: true }, { id: 'codex', name: 'Codex', available: true }, { id: 'grok', name: 'Grok', available: false, reason: 'Not installed.' }], workspaces: [{ id: 'w1', name: 'App', path: '/projects/app' }, { id: 'w2', name: 'Docs', path: '/projects/docs' }], defaultWorkspaceId: 'w1', defaultCwd: '/projects/app', ownPaneId: 'w1:p9', ownTerminalId: 't9' }),
    dispatch: async draft => { calls.push(['dispatch', draft]); return { ok: true, state: 'submitted', message: 'Submitted.' }; },
    focus: async target => { calls.push(['focus', target]); return { ok: true, state: 'focused', message: 'Focused.' }; },
    closeAgent: async target => { calls.push(['close', target]); return { ok: true, state: 'closed', message: 'Closed.' }; },
    ...overrides,
  };
  const model = createTuiModel({ monitor, controller, onQuit: () => calls.push(['quit']) });
  await model.ready;
  return { model, calls, publish(change) { snapshot = change(structuredClone(snapshot)); listener?.(snapshot); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('stable selection and draft survive refresh and Escape; paste never triggers shortcuts', async t => {
  const { model, calls, publish } = await harness(); t.after(model.destroy);
  model.action('select', 't2');
  model.action('new'); model.action('field', 'prompt');
  model.paste('q\nx\n`echo shell` $(not-a-command)\n\x1b[<0;1;1M');
  publish(snapshot => { snapshot.agents.reverse(); return snapshot; });
  assert.equal(model.getSnapshot().selectedId, 't2');
  assert.match(model.getSnapshot().draft.prompt, /q\nx\n`echo shell`/);
  assert.equal(calls.length, 0);
  model.key('', { escape: true }); model.action('new');
  assert.match(model.getSnapshot().draft.prompt, /not-a-command/);
});

test('dispatch captures selected provider/workspace/prompt and rejects duplicate pending submit', async t => {
  let finish;
  const calls = [];
  const { model } = await harness({ dispatch: draft => { calls.push(draft); return new Promise(resolve => { finish = resolve; }); } }); t.after(model.destroy);
  model.action('new'); model.key('', { leftArrow: true });
  model.action('field', 'workspaceId'); model.key('', { rightArrow: true });
  model.action('field', 'prompt'); model.paste('First line\nSecond line');
  model.key('s', { ctrl: true }); model.key('s', { ctrl: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { provider: 'claude', workspaceId: 'w2', cwd: '/projects/docs', prompt: 'First line\nSecond line' });
  finish({ ok: true, state: 'submitted', message: 'Sent.' }); await settle();
  assert.equal(model.getSnapshot().view, 'board');
  assert.equal(model.getSnapshot().draft.prompt, '');
});

test('partial launch keeps draft, prevents blind retry, and focuses the controller-tracked pane', async t => {
  let launches = 0;
  const { model, calls } = await harness({ dispatch: async () => { launches += 1; return { ok: false, state: 'needs_input', message: 'Complete authentication.', paneId: 'w1:p7', terminalId: 't7', agentName: 'new-worker' }; } }); t.after(model.destroy);
  model.action('new'); model.action('field', 'prompt'); model.paste('Keep this prompt.');
  model.action('dispatch'); await settle();
  model.action('dispatch'); await settle();
  assert.equal(launches, 1);
  assert.equal(model.getSnapshot().draft.prompt, 'Keep this prompt.');
  model.action('focus-result'); await settle();
  assert.equal(calls[0][0], 'focus'); assert.equal(calls[0][1].terminalId, 't7');
  model.action('allow-launch'); model.action('dispatch'); await settle();
  assert.equal(launches, 2);
});

test('close confirmation freezes target and refuses changed status or reused pane identity', async t => {
  const { model, calls, publish } = await harness(); t.after(model.destroy);
  model.action('select', 't1'); model.action('close');
  assert.equal(model.getSnapshot().confirmation.id, 't1');
  publish(snapshot => { snapshot.agents[0].status = 'working'; return snapshot; });
  model.key('y'); await settle();
  assert.equal(calls.length, 0);
  assert.match(model.getSnapshot().notice.message, /status changed/);
  model.action('cancel'); model.action('close');
  publish(snapshot => { snapshot.agents[0].terminalId = 'replacement'; return snapshot; });
  model.action('confirm-close'); await settle(); assert.equal(calls.length, 0);
  assert.match(model.getSnapshot().notice.message, /no longer available/);
});

test('close defaults Cancel and explicit confirmation only closes captured agent', async t => {
  const { model, calls } = await harness(); t.after(model.destroy);
  model.action('close'); model.key('', { return: true });
  assert.equal(calls.length, 0); assert.equal(model.getSnapshot().view, 'board');
  model.action('select', 't2'); model.action('close'); model.key('y'); await settle();
  assert.equal(calls[0][0], 'close'); assert.equal(calls[0][1].id, 't2');
});

test('stale/demo/own-pane guards prevent every control action', async t => {
  const { model, calls, publish } = await harness(); t.after(model.destroy);
  model.action('new'); model.action('field', 'prompt'); model.paste('Build');
  publish(snapshot => { snapshot.source.state = 'disconnected'; return snapshot; });
  model.action('dispatch'); model.action('focus'); model.action('close'); await settle(); assert.equal(calls.length, 0);
  publish(snapshot => { snapshot.source.state = 'connected'; snapshot.mode = 'demo'; return snapshot; });
  model.action('dispatch'); model.action('focus'); model.action('close'); await settle(); assert.equal(calls.length, 0);
  publish(snapshot => { snapshot.mode = 'live'; snapshot.agents[0].paneId = 'w1:p9'; return snapshot; });
  model.action('cancel'); model.action('select', 't1'); model.action('focus'); model.action('close'); await settle(); assert.equal(calls.length, 0);
});

test('prompt size is measured in UTF-8 bytes and invalid names keep the draft', async t => {
  const { model, calls } = await harness(); t.after(model.destroy);
  model.action('new'); model.action('field', 'prompt'); model.paste('😀'.repeat(16385));
  model.action('dispatch'); await settle(); assert.equal(calls.length, 0); assert.match(model.getSnapshot().notice.message, /65536 UTF-8 bytes/);
  assert.equal(model.getSnapshot().draft.prompt.length, 32770);
});

test('text editing preserves Unicode graphemes and supports multiline cursor navigation', () => {
  assert.deepEqual(editText('é👩🏽‍💻', 2, '', { backspace: true }), { value: 'é', cursor: 1 });
  assert.deepEqual(editText('first\nlast', 8, '', { upArrow: true }, true), { value: 'first\nlast', cursor: 2 });
  assert.deepEqual(editText('first\nlast', 2, '', { downArrow: true }, true), { value: 'first\nlast', cursor: 8 });
});

test('SGR mouse parsing uses terminal coordinates and real measured hitboxes', () => {
  const point = parseMouse('[<0;12;6M');
  assert.deepEqual(point, { button: 0, x: 11, y: 5, release: false });
  assert.equal(parseMouse('q'), null);
  assert.equal(parseMouse('[<0;12;6m').release, true);
  const entries = [{ ref: { current: { x: 0, y: 0, width: 10, height: 10 } }, action: 'wrong' }, { ref: { current: { x: 10, y: 5, width: 10, height: 1 } }, action: 'right' }];
  assert.equal(hitTest(point, entries, node => node).action, 'right');
});

test('/dispatch uses Codex default, accepts explicit provider, and sends the exact remainder', async t => {
  const { model, calls } = await harness(); t.after(model.destroy);
  assert.equal(model.getSnapshot().draft.provider, 'codex');
  model.key('/dispatch add voice input to shep\r'); await settle();
  assert.equal(calls[0][1].provider, 'codex'); assert.equal(calls[0][1].prompt, 'add voice input to shep');
  model.paste('/dispatch claude: review `literal` $(shell)\nsecond line');
  assert.equal(calls.length, 1, 'paste waits for explicit Enter');
  model.key('', { return: true }); await settle();
  assert.equal(calls[1][1].provider, 'claude'); assert.equal(calls[1][1].prompt, 'review `literal` $(shell)\nsecond line');
  assert.equal(model.getSnapshot().draft.provider, 'claude');
  model.key('/dispatch fix the settings pange\r'); await settle();
  assert.equal(calls[2][1].provider, 'codex'); assert.equal(calls[2][1].prompt, 'fix the settings pange');
});

test('/dispatch unavailable provider never falls back; provider alone and invalid command do not launch', async t => {
  const { model, calls } = await harness(); t.after(model.destroy);
  model.key('/dispatch grok: investigate\r'); await settle();
  assert.equal(calls.length, 0); assert.match(model.getSnapshot().notice.message, /Not installed/);
  assert.equal(model.getSnapshot().draft.provider, 'codex');
  model.key('', { escape: true }); model.key('/dispatch codex:\r'); await settle();
  assert.equal(calls.length, 0); assert.match(model.getSnapshot().notice.message, /Add a task/);
  assert.throws(() => parseDispatch('/delete codex: task', model.getSnapshot().profiles.providers), /Use \/dispatch/);
  assert.throws(() => parseDispatch('/dispatch unknown: task', model.getSnapshot().profiles.providers), /Unknown agent/);
  assert.deepEqual(parseDispatch('/dispatch claude review this', model.getSnapshot().profiles.providers), { provider: 'codex', prompt: 'claude review this', explicitProvider: false });
  assert.deepEqual(parseDispatch('/dispatch claude:  keep one leading space\nnext', model.getSnapshot().profiles.providers), { provider: 'claude', prompt: ' keep one leading space\nnext', explicitProvider: true });
});

test('command input captures control-like letters; partial command stays and blocks repeat Enter', async t => {
  const { model, calls } = await harness({ dispatch: async draft => { calls.push(['dispatch', draft]); return { ok: false, state: 'uncertain', message: 'Check the new pane.', paneId: 'w1:p7', terminalId: 't7' }; } }); t.after(model.destroy);
  model.key('/dispatch codex: x q n / are literal');
  model.action('focus'); model.action('close'); assert.equal(calls.length, 0);
  model.key('', { return: true }); await settle(); model.key('', { return: true }); await settle();
  assert.equal(calls.length, 1); assert.equal(model.getSnapshot().command, '/dispatch codex: x q n / are literal');
  assert.equal(model.getSnapshot().draft.prompt, 'x q n / are literal');
});

test('Ink fixtures fit desktop/narrow panes and preserve essential controls', async t => {
  const { model, publish } = await harness(); t.after(model.destroy);
  publish(snapshot => { snapshot.agents.push({ ...snapshot.agents[0], id: 't3', terminalId: 't3', provider: '__proto__', name: '\x1b]52;c;bad\x07 <hostile>' }); return snapshot; });
  assert(visibleAgents(model.getSnapshot()).some(agent => agent.provider === '__proto__'));
  for (const [width, height] of [[120, 40], [100, 28], [60, 24], [40, 16], [39, 15]]) {
    for (const view of ['board', 'compose', 'confirm']) {
      model.action('cancel');
      if (view === 'compose') { model.action('new'); model.action('field', 'prompt'); }
      if (view === 'confirm') model.action('close');
      const rendered = renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width, height }));
      const lines = rendered.split('\n');
      assert(lines.length <= height, `${width}×${height} ${view}: too many rows (${lines.length})`);
      assert(lines.every(line => displayWidth(line) <= width), `${width}×${height} ${view}: line overflow`);
      assert.doesNotMatch(rendered, /\x1b/);
      assert.match(rendered, view === 'compose' ? /dispatch/i : view === 'confirm' ? /cancel/i : /quit/i);
      if (view === 'confirm' && width === 39) {
        assert.match(rendered, /Identity: t1/);
        assert.match(rendered, /Stops its process/);
        assert.match(rendered, /Cancel\s+Esc/);
        assert.match(rendered, /Close agent\s+y/);
      }
    }
  }
});

test('live Ink startup and resize reserve the final physical column', async t => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.ref = input.unref = () => input;
  input.setRawMode = enabled => { input.isRaw = enabled; return input; };
  const writes = [];
  const output = new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } });
  output.isTTY = true;
  output.columns = 121;
  output.rows = 40;
  const snapshot = fixture();
  const monitor = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  const controller = { getProfiles: async () => ({ providers: [{ id: 'codex', name: 'Codex', available: true }], workspaces: [], defaultCwd: '/projects/app' }) };
  const stop = startTui({ monitor, controller, input, output, onQuit: () => {} });
  t.after(() => { stop(); input.destroy(); output.destroy(); });
  await stop.ready;
  await settle();
  await stop.waitUntilRenderFlush();
  const borders = chunks => chunks.flatMap(chunk => stripVTControlCharacters(chunk).split('\n')).filter(row => row.startsWith('╭') && row.endsWith('╮'));
  assert(borders(writes).some(row => displayWidth(row) === 120), '121-column terminal must initially paint a complete 120-column border');
  assert(borders(writes).every(row => displayWidth(row) < 121), 'No border enters the final physical cell');
  const mark = writes.length;
  output.columns = 84;
  output.emit('resize');
  await settle();
  await stop.waitUntilRenderFlush();
  assert(borders(writes.slice(mark)).some(row => displayWidth(row) === 83), 'Resize to84columns must repaint a complete83-column border');
  stop();
  assert.equal(input.isRaw, false);
  assert(writes.join('').includes('\x1b[?1006l'), 'Mouse reporting is restored');
});
