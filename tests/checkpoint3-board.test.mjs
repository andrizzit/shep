import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { createController } from '../src/control.mjs';
import { getHerdrContext } from '../src/herdr.mjs';
import { createTuiModel } from '../src/tui-model.mjs';
import { TuiView } from '../src/tui.mjs';
import { taskRows } from '../src/tui-tasks.mjs';
import { displayWidth } from '../src/terminal.mjs';
import { createFakeRegistry, deferred, makeProject, makeSnapshot } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const project = makeProject();
const external = (patch = {}) => ({ id: 'external-terminal', terminalId: 'external-terminal', paneId: 'w1:p2', provider: 'codex',
  name: 'External Codex', agentName: null, sessionId: 'external-session', status: 'idle', workspace: { path: project.root }, ...patch });

test('existing controller sends once to an external unnamed agent by captured pane, terminal and session, without activity wait', async t => {
  const snapshot = makeSnapshot();
  const native = { pane_id: 'w1:p2', terminal_id: 'external-terminal', workspace_id: 'w1', tab_id: 'w1:t1', name: null,
    agent: 'codex', agent_status: 'idle', agent_session: { kind: 'id', value: 'external-session' } };
  snapshot.panes.push({ ...native, cwd: project.root }); snapshot.agents.push(native);
  const calls = [];
  const controller = createController({ context: getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/fixture/never-connected.sock',
    HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', PATH: '' }),
    monitor: { getSnapshot: () => ({ mode: 'live', source: { state: 'connected' } }) },
    readRaw: async () => ({ result: { snapshot: structuredClone(snapshot) } }),
    run: async (argv, options) => {
      calls.push({ argv, options });
      assert(['get', 'prompt'].includes(argv[1]), 'No pane or cleanup commands are allowed');
      return { result: { agent: structuredClone(native) } };
    } }); t.after(() => controller.dispose());
  const text = '--wait\n$(not executed) `literal`\t羊';
  const result = await controller.followUp({ target: external(), text });
  assert.equal(result.state, 'submitted');
  assert.deepEqual(calls.map(call => call.argv), [['agent', 'get', 'w1:p2'], ['agent', 'prompt', 'w1:p2', text]]);
  assert.equal(calls[1].options.timeoutMs, 8000);
});

async function fixture(t, { agents = [external()], controller: overrides = {} } = {}) {
  let snapshot = { mode: 'live', updatedAt: new Date().toISOString(), source: { state: 'connected' }, agents };
  let listener, sequence = 0;
  const calls = [], topology = { panes: [], workspaces: [], tabs: [], agents: [] };
  const monitor = { getSnapshot: () => snapshot, subscribe: fn => { listener = fn; return () => { listener = null; }; } };
  const controller = {
    getProfiles: async () => ({ providers: [{ id: 'codex', name: 'Codex', available: true }], workspaces: [], defaultCwd: project.root,
      ownPaneId: 'own-pane', ownTerminalId: 'own-terminal' }),
    followUp: async request => { calls.push({ method: 'followUp', request }); return { ok: true, state: 'submitted', message: 'Follow-up submitted.', paneId: request.target.paneId, terminalId: request.target.terminalId }; },
    dismissTask: request => { calls.push({ method: 'dismissTask', request }); return { ok: true, state: 'dismissed', message: 'Reservation released.' }; },
    getControlSnapshot: async () => structuredClone(topology),
    dispatch: async (request, { onProgress }) => {
      calls.push({ method: 'dispatch', request }); sequence += 1;
      const paneId = `w1:task${sequence}`, terminalId = `task-terminal${sequence}`;
      topology.panes.push({ pane_id: paneId, terminal_id: terminalId });
      await onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at: new Date().toISOString() });
      return { ok: true, state: 'submitted', message: 'Sent', taskId: request.taskId, attemptId: request.attemptId, paneId, terminalId, agentName: request.name };
    },
    closeAgent: async target => { calls.push({ method: 'closeAgent', target }); return { ok: true, state: 'closed', message: 'Closed.' }; },
    ...overrides,
  };
  const model = createTuiModel({ monitor, controller, registry: createFakeRegistry(), now: (() => { let time = Date.now(); return () => time += 1001; })() });
  t.after(model.destroy); await model.ready;
  const publish = patch => { snapshot = { ...snapshot, ...patch }; listener?.(snapshot); };
  const launch = async (text = 'Task') => {
    model.action('cancel'); model.paste('/dispatch codex: ' + text); model.key('', { return: true }); await tick();
    return model.getTasks().at(-1);
  };
  return { model, calls, publish, launch, topology };
}

test('follow-up drafts belong to captured agents, survive Escape and refresh, and paste is never a shortcut', async t => {
  const second = external({ id: 'second', terminalId: 'second', paneId: 'w1:p3', sessionId: 'second-session', name: 'Second' });
  const { model, calls, publish } = await fixture(t, { agents: [external(), second] });
  model.key('p'); assert.equal(model.getSnapshot().view, 'follow-up');
  model.paste('q\nc\np\n$(literal)');
  publish({ agents: [second, external()] });
  assert.equal(model.getSnapshot().followUp.target.terminalId, 'external-terminal');
  model.key('', { escape: true }); model.action('select-task', 'external:second'); model.key('p');
  assert.equal(model.getSnapshot().followUp.text, ''); model.paste('Second draft');
  model.key('', { escape: true }); model.action('select-task', 'external:external-terminal'); model.key('p');
  assert.equal(model.getSnapshot().followUp.text, 'q\nc\np\n$(literal)'); assert.equal(calls.length, 0);
  model.key('', { escape: true });
  publish({ agents: [second, external({ sessionId: 'replacement' })] }); model.key('p');
  assert.equal(model.getSnapshot().followUp.text, '', 'A reused pane never inherits another session’s draft');
});

test('Ctrl+S sends literal multiline follow-up once while busy and records only owned task metadata', async t => {
  for (const ownTask of [false, true]) {
    const pending = deferred(), sent = [];
    const { model, publish, launch } = await fixture(t, { controller: { followUp: request => { sent.push(request); return pending.promise; } } });
    let task;
    if (ownTask) {
      task = await launch();
      publish({ agents: [external({ id: task.target.terminalId, ...task.target, name: task.name, status: 'working', sessionId: 'task-session' })] });
      model.key('d'); assert.equal(model.getSnapshot().view, 'detail');
    } else model.key('g');
    model.key('p');
    const text = '--wait\n$(literal) `quoted`\t羊'; model.paste(text);
    model.key('s', { ctrl: true }); model.key('s', { ctrl: true });
    assert.equal(sent.length, 1); assert.equal(sent[0].text, text);
    assert.equal(sent[0].target.terminalId, ownTask ? task.target.terminalId : 'external-terminal');
    pending.resolve({ ok: true, state: 'submitted', message: 'Native accepted', paneId: sent[0].target.paneId, terminalId: sent[0].target.terminalId }); await tick();
    assert.equal(model.getSnapshot().view, ownTask ? 'detail' : 'board');
    assert.equal(model.getSnapshot().notice.message, 'Follow-up submitted');
    assert(!JSON.stringify(model.getTasks()).includes(text));
    if (ownTask) assert.equal(model.getTasks()[0].followUp.count, 1);
    model.key('p'); assert.equal(model.getSnapshot().followUp.text, '');
  }
});

test('uncertain follow-up closes without resending, retains draft, and reopening is a deliberate new send', async t => {
  const sent = [], pending = deferred();
  const { model, publish, launch } = await fixture(t, { controller: { followUp: request => { sent.push(request); return pending.promise; } } });
  const task = await launch();
  publish({ agents: [external({ id: task.target.terminalId, ...task.target, name: task.name })] });
  model.key('p'); model.paste('Preserve uncertain text'); model.key('s', { ctrl: true }); model.key('s', { ctrl: true });
  pending.resolve({ ok: false, state: 'uncertain', message: 'Transport timeout', paneId: task.target.paneId, terminalId: task.target.terminalId }); await tick();
  assert.equal(model.getSnapshot().view, 'board');
  assert.equal(model.getSnapshot().notice.message, 'Follow-up delivery could not be confirmed. Inspect the agent before sending it again.');
  model.key('s', { ctrl: true }); await tick(); assert.equal(sent.length, 1);
  assert.equal(model.getTasks()[0].followUp.count, 1);
  model.key('p'); assert.equal(model.getSnapshot().followUp.text, 'Preserve uncertain text');
  model.key('s', { ctrl: true }); await tick(); assert.equal(sent.length, 2);
});

test('follow-up refuses own, stale, demo and unconfirmed targets before opening or sending', async t => {
  for (const patch of [
    { agents: [external({ paneId: 'own-pane' })] }, { agents: [external({ terminalId: 'own-terminal' })] },
    { source: { state: 'disconnected' } }, { mode: 'demo' }, { agents: [external({ paneId: null })] }, { agents: [external({ terminalId: null })] },
  ]) {
    const { model, calls, publish } = await fixture(t); publish(patch); model.key('p');
    assert.equal(model.getSnapshot().view, 'board'); assert(model.getSnapshot().notice?.message);
    model.key('s', { ctrl: true }); await tick(); assert.equal(calls.length, 0);
  }
  for (const patch of [{ agents: [external({ sessionId: 'replacement' })] }, { agents: [external({ agentName: 'replacement' })] }, { source: { state: 'disconnected' } }, { mode: 'demo' }]) {
    const { model, calls, publish } = await fixture(t, { agents: [external({ agentName: 'captured' })] });
    model.key('p'); model.paste('Do not misroute'); publish(patch); model.key('s', { ctrl: true }); await tick();
    assert.equal(calls.length, 0); assert.equal(model.getSnapshot().followUp.text, 'Do not misroute');
  }
});

test('blocked follow-up preserves text and shows the exact pane-input instruction without dispatch or close', async t => {
  const sent = [];
  const { model, calls } = await fixture(t, { controller: { followUp: async request => { sent.push(request); return { ok: false, state: 'needs_input', code: 'agent_blocked', message: 'Native blocked' }; } } });
  model.key('p'); model.paste('Answer after approval'); model.key('s', { ctrl: true }); await tick();
  assert.equal(sent.length, 1);
  assert.equal(model.getSnapshot().notice.message, 'The agent is waiting for input in its pane. Answer it there.');
  assert.equal(model.getSnapshot().followUp.text, 'Answer after approval'); assert.equal(calls.length, 0);
});

test('c and C dismiss failed and confirmed closed tasks locally without closing open agents', async t => {
  const { model, calls, launch, topology, publish } = await fixture(t, { agents: [] });
  const first = await launch('First'), second = await launch('Second');
  topology.panes = []; publish({ agents: [] }); await tick();
  assert(model.getTasks().every(task => task.live.status === 'closed'));
  model.action('select-task', `task:${first.id}`); model.key('d'); model.key('c'); await tick();
  assert.equal(model.getSnapshot().view, 'board');
  assert.equal(model.getTasks().find(task => task.id === first.id).dismissed, true);
  assert.equal(model.getTasks().find(task => task.id === second.id).dismissed, false);
  const open = await launch('Keep open'); model.key('c'); await tick();
  assert.equal(model.getSnapshot().notice.message, 'This agent is still open. Close it with x first, or keep it.');
  assert.equal(model.getTasks().find(task => task.id === open.id).dismissed, false);
  model.key('C'); await tick();
  assert.deepEqual(taskRows(model.getSnapshot()).map(row => row.task?.id), [open.id]);
  assert.deepEqual(calls.filter(call => call.method === 'dismissTask').map(call => call.request), [
    { taskId: first.id, attemptId: first.attemptId }, { taskId: second.id, attemptId: second.attemptId },
  ]);
  assert(!calls.some(call => call.method === 'closeAgent'));

  const failed = await fixture(t, { agents: [], controller: { dispatch: async request => ({ ok: false, state: 'failed', message: 'Before creation', taskId: request.taskId, attemptId: request.attemptId }) } });
  await failed.launch(); failed.model.action('cancel'); failed.model.key('C'); await tick();
  assert.equal(failed.model.getTasks()[0].dismissed, true);
  await failed.launch('Separate failed task'); failed.model.action('cancel');
  failed.model.key('c'); await tick(); assert.equal(failed.model.getTasks()[1].dismissed, true);
  assert.equal(failed.calls.filter(call => call.method === 'dismissTask').length, 2);
  assert(!failed.calls.some(call => call.method === 'closeAgent'));
});

test('failed tasks with retained panes require private absence; public-agent absence never permits clearing an open pane', async t => {
  for (const receiptOnly of [false, true]) {
  let present = true, available = true;
  const { model, calls, launch } = await fixture(t, { agents: [], controller: {
    dispatch: async request => ({ ok: false, state: 'failed', message: 'Agent start failed', taskId: request.taskId, attemptId: request.attemptId,
      ...(receiptOnly ? { created: { tabIds: ['retained-tab'], panes: [{ paneId: 'retained-pane', terminalId: 'retained-terminal', tabId: 'retained-tab', workspaceId: 'w1' }] } } : { paneId: 'retained-pane', terminalId: 'retained-terminal' }) }),
    getControlSnapshot: async () => available ? { panes: present ? [{ pane_id: 'retained-pane', terminal_id: 'retained-terminal' }] : [], agents: [], tabs: [], workspaces: [] } : {},
  } });
  await launch(); model.action('cancel'); model.key('c'); await tick();
  assert.equal(model.getSnapshot().notice.message, 'Pane retained-pane is still open, but no agent is detected. Close that pane in Herdr, then clear this task.');
  assert.equal(model.getTasks()[0].dismissed, false); assert(!calls.some(call => call.method === 'dismissTask'));
  available = false; model.key('c'); await tick(); assert.equal(model.getTasks()[0].dismissed, false);
  assert.match(model.getSnapshot().notice.message, /could not be verified/);
  available = true; present = false; model.key('c'); await tick(); assert.equal(model.getTasks()[0].dismissed, true);
  assert.equal(calls.filter(call => call.method === 'dismissTask').length, 1); assert(!calls.some(call => call.method === 'closeAgent'));
  }
});

test('new board controls and follow-up editor fit 120×40 and 40×15 without hiding identity or send/cancel', async t => {
  const { model } = await fixture(t);
  for (const [width, height] of [[119, 39], [39, 14]]) {
    const render = () => renderToString(React.createElement(TuiView, { state: model.getSnapshot(), model, width, height }));
    const board = render(); assert.match(board, /p Send/);
    model.key('p'); const editor = render();
    assert.match(editor, /External Codex/); assert.match(editor, /Done/); assert.match(editor, /w1:p2/);
    assert.match(editor, /Send Ctrl\+S/); assert.match(editor, /Back Esc/);
    assert(editor.split('\n').length <= height); assert(editor.split('\n').every(line => displayWidth(line) <= width));
    model.key('', { escape: true });
  }
  const closed = await fixture(t, { agents: [] }); await closed.launch();
  closed.topology.panes = []; closed.publish({ agents: [] }); await tick();
  for (const [width, height] of [[119, 39], [39, 14]]) {
    const board = renderToString(React.createElement(TuiView, { state: closed.model.getSnapshot(), model: closed.model, width, height }));
    assert.match(board, /c Clear/); assert.match(board, /C All/);
    assert(board.split('\n').length <= height); assert(board.split('\n').every(line => displayWidth(line) <= width));
  }
});
