import test from 'node:test';
import assert from 'node:assert/strict';
import { createTuiModel } from '../src/tui-model.mjs';
import { taskRows } from '../src/tui-tasks.mjs';
import { createModelReader } from '../src/model-info.mjs';
import { createFakeController, createFakeRegistry, deferred } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const external = (patch = {}) => ({ id: 'external-terminal', terminalId: 'external-terminal', paneId: 'w1:p2', provider: 'codex',
  name: 'Codex w1:p2', agentName: null, sessionId: 'session-a', status: 'idle', workspace: { path: '/fixture/shep' }, ...patch });
async function fixture(t, { agents = [external()], rename, dispatch, readModel, summarize } = {}) {
  let snapshot = { mode: 'live', updatedAt: new Date(1000).toISOString(), source: { state: 'connected' }, agents }, clock = 1000;
  const subscribers = new Set(), renamed = [];
  const monitor = { getSnapshot: () => snapshot, subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); } };
  const controller = createFakeController();
  if (dispatch) controller.dispatch = (request, options) => {
    controller.calls.push({ method: 'dispatch', request: structuredClone(request) });
    return dispatch(request, options);
  };
  controller.rename = async request => {
    renamed.push(structuredClone(request));
    return rename ? rename(request) : { ok: true, state: 'submitted', message: 'Renamed.', agentName: request.name,
      paneId: request.target.paneId, terminalId: request.target.terminalId };
  };
  const model = createTuiModel({ monitor, controller, registry: createFakeRegistry(), readModel, summarize, now: () => clock });
  t.after(() => { model.destroy(); controller.dispose(); }); await model.ready;
  const publish = (patch, advance = 0) => {
    clock += advance; snapshot = { ...snapshot, ...patch, updatedAt: new Date(clock).toISOString() };
    for (const fn of subscribers) fn(snapshot);
  };
  const send = async (provider = 'codex', pending = false) => {
    model.paste(`/dispatch ${provider}: Reply with OK`); model.key('', { return: true }); await tick();
    const request = controller.calls.findLast(call => call.method === 'dispatch').request;
    if (!pending) {
      await controller.emit(request, 'start');
      controller.publishControlSnapshot({ panes: [{ pane_id: 'w1:task', terminal_id: 'task-terminal' }], agents: [], tabs: [], workspaces: [] });
      controller.settle(request, { ok: true, state: 'submitted', message: 'Sent.', paneId: 'w1:task', terminalId: 'task-terminal', agentName: request.name,
        placement: { mode: 'here', targetKind: 'tab', reason: 'Main folder', cwd: '/fixture/shep', notices: [] } });
      await tick();
    }
    return model.getTasks().at(-1);
  };
  return { model, monitor, controller, renamed, publish, send };
}

test('e opens a blank rename editor for unnamed external agents in Tasks and Agents; Esc cancels without a command', async t => {
  for (const agentsView of [false, true]) {
    const f = await fixture(t); if (agentsView) f.model.key('g');
    f.model.key('e'); assert.equal(f.model.getSnapshot().view, 'rename');
    assert.equal(f.model.getSnapshot().rename.text, '');
    f.model.paste('new-name'); f.model.key('', { escape: true });
    assert.equal(f.model.getSnapshot().view, 'board'); assert.equal(f.renamed.length, 0);
  }
});

test('rename prefills managed names, keeps cursor editing single-line and refuses invalid names inline', async t => {
  const f = await fixture(t, { agents: [external({ agentName: 'captured', name: 'captured' })] });
  f.model.key('e'); assert.equal(f.model.getSnapshot().rename.text, 'captured');
  f.model.key('u', { ctrl: true }); f.model.paste('Bad name'); f.model.key('', { return: true }); await tick();
  assert.equal(f.renamed.length, 0); assert.equal(f.model.getSnapshot().view, 'rename');
  assert.match(f.model.getSnapshot().rename.error, /lowercase/);
  f.model.key('u', { ctrl: true }); assert.equal(f.model.getSnapshot().rename.error, null);
  f.model.paste('new\nname'); assert.equal(f.model.getSnapshot().rename.text.includes('\n'), false);
  assert.equal(f.renamed.length, 0, 'Paste never submits a name or another action');
});

test('Enter renames once while busy and changes only the terminal-private snapshot after confirmation', async t => {
  const pending = deferred(), f = await fixture(t, { rename: () => pending.promise });
  const publicBefore = structuredClone(f.monitor.getSnapshot());
  f.model.key('e'); f.model.paste('new-name'); f.model.key('', { return: true }); f.model.key('', { return: true });
  assert.equal(f.renamed.length, 1); assert.equal(f.model.getSnapshot().busy, 'rename');
  assert.equal(f.renamed[0].target.agentName, null);
  pending.resolve({ ok: true, state: 'submitted', message: 'Renamed.', paneId: 'w1:p2', terminalId: 'external-terminal', agentName: 'new-name' }); await tick();
  assert.equal(f.model.getSnapshot().view, 'board');
  assert.equal(f.model.selected().agentName, 'new-name'); assert.equal(f.model.selected().name, 'new-name');
  assert.deepEqual(f.monitor.getSnapshot(), publicBefore);
  assert.equal(f.controller.calls.length, 0, 'Rename cannot dispatch, prompt, close or clean up');
});

test('renaming a tracked task updates its name and target atomically, keeps one selected row and follows later Working/Done metadata', async t => {
  const f = await fixture(t, { agents: [] }), task = await f.send();
  const agent = external({ id: task.target.terminalId, ...task.target, name: task.name, status: 'working', sessionId: 'session-a' });
  f.publish({ agents: [agent] }); f.model.key('d'); f.model.key('e');
  assert.equal(f.model.getSnapshot().rename.text, task.name); assert.equal(f.model.getSnapshot().rename.returnView, 'detail');
  f.model.key('u', { ctrl: true }); f.model.paste('review-task');
  let incomplete = false;
  const stop = f.model.subscribe(() => {
    const current = f.model.getTasks()[0]; if ((current.name === 'review-task') !== (current.target.agentName === 'review-task')) incomplete = true;
  });
  f.model.key('', { return: true }); await tick(); stop();
  const renamed = f.model.getTasks()[0];
  assert.equal(incomplete, false); assert.equal(renamed.name, 'review-task'); assert.equal(renamed.target.agentName, 'review-task');
  for (const field of ['id', 'attemptId', 'created', 'placement', 'launch', 'followUp']) assert.deepEqual(renamed[field], task[field]);
  assert.equal(f.model.getSnapshot().view, 'detail'); assert.equal(taskRows(f.model.getSnapshot()).length, 1);
  assert.equal(taskRows(f.model.getSnapshot())[0].agent.agentName, 'review-task');
  f.publish({ agents: [{ ...agent, name: 'review-task', agentName: 'review-task', sessionId: 'session-b', status: 'done' }] });
  const rows = taskRows(f.model.getSnapshot()); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'done');
  assert.equal(f.model.getSnapshot().selectedTaskId, `task:${task.id}`);
  assert.equal(f.renamed.length, 1);
});

test('rename refuses local changed names including null, pane, terminal, provider and trusted sessions before sending', async t => {
  for (const provider of ['codex', 'claude', 'grok']) for (const field of ['agentName', 'paneId', 'terminalId', 'provider', 'sessionId']) {
    const f = await fixture(t, { agents: [external({ provider })] });
    f.model.key('e'); f.model.paste('new-name');
    const replacement = external({ provider, [field]: 'replacement' });
    if (field === 'agentName') replacement.name = 'replacement';
    f.publish({ agents: [replacement] }); f.model.key('', { return: true }); await tick();
    assert.equal(f.renamed.length, field === 'sessionId' && provider === 'codex' ? 1 : 0, `${provider}/${field}`);
  }
});

test('rename refuses own, stale, demo, unconfirmed and pending agents, but a blocked agent may be renamed without answering it', async t => {
  for (const patch of [{ agents: [external({ paneId: 'w1:p1' })] }, { agents: [external({ terminalId: 'own-terminal' })] },
    { source: { state: 'disconnected' } }, { mode: 'demo' }, { agents: [external({ paneId: null })] },
    { agents: [external({ terminalId: null })] }, { agents: [external({ launchPending: true })] }]) {
    const f = await fixture(t); f.publish(patch); f.model.key('e');
    assert.equal(f.model.getSnapshot().view, 'board'); assert.equal(f.renamed.length, 0);
  }
  const f = await fixture(t, { agents: [external({ status: 'blocked' })] });
  f.model.key('e'); f.model.paste('blocked-agent'); f.model.key('', { return: true }); await tick();
  assert.equal(f.renamed.length, 1); assert.equal(f.controller.calls.length, 0);
});

test('tracked startup tasks cannot be renamed even after their native agent appears', async t => {
  const gate = deferred();
  const f = await fixture(t, { agents: [], dispatch: async (request, { onProgress }) => {
    await onProgress({ taskId: request.taskId, attemptId: request.attemptId, stage: 'start', at: new Date(1000).toISOString(),
      target: { paneId: 'w1:task', terminalId: 'task-terminal', provider: 'codex', agentName: request.name }, delivery: 'launch' });
    return gate.promise;
  } }), task = await f.send('codex', true);
  const request = f.controller.calls.find(call => call.method === 'dispatch').request;
  assert.equal(task.launch.state, 'starting');
  f.publish({ agents: [external({ id: 'task-terminal', paneId: 'w1:task', terminalId: 'task-terminal', name: task.name, agentName: task.name })] });
  f.model.key('e'); assert.equal(f.model.getSnapshot().view, 'board'); assert.equal(f.renamed.length, 0);
  assert.match(f.model.getSnapshot().notice.message, /starting/);
  gate.resolve({ ok: true, state: 'submitted', message: 'Done.', taskId: request.taskId, attemptId: request.attemptId,
    paneId: 'w1:task', terminalId: 'task-terminal', agentName: task.name, delivery: 'launch' }); await tick();
});

test('uncertain rename returns to the board without updating task identity or replaying on a second Enter', async t => {
  for (const throwing of [false, true]) {
    const f = await fixture(t, { rename: () => { if (throwing) throw new Error('Synthetic transport'); return { ok: false, state: 'uncertain', message: 'Unconfirmed.' }; } });
    f.model.key('e'); f.model.paste('new-name'); f.model.key('', { return: true }); await tick();
    assert.equal(f.model.getSnapshot().view, 'board'); assert.equal(f.model.selected().agentName, null);
    assert.match(f.model.getSnapshot().notice.message, /could not be confirmed/);
    f.model.key('', { return: true }); await tick(); assert.equal(f.renamed.length, 1);
  }
});

test('Codex ID churn retains follow-up drafts and allows a single literal send without binding session IDs onto tasks', async t => {
  const f = await fixture(t), text = 'Keep this literal\n$(not executed)';
  f.model.key('p'); f.model.paste(text); f.model.key('', { escape: true });
  f.publish({ agents: [external({ sessionId: 'session-b' })] }); f.model.key('p');
  assert.equal(f.model.getSnapshot().followUp.text, text);
  f.publish({ agents: [external({ sessionId: 'session-c' })] }); f.model.key('s', { ctrl: true }); f.model.key('s', { ctrl: true }); await tick();
  const sent = f.controller.calls.filter(call => call.method === 'followUp'); assert.equal(sent.length, 1); assert.equal(sent[0].request.text, text);
  const task = await f.send();
  f.publish({ agents: [external({ id: task.target.terminalId, ...task.target, name: task.name, status: 'working', sessionId: 'different-session' })] });
  assert.equal(f.model.getTasks()[0].target.sessionId, undefined); assert.equal(taskRows(f.model.getSnapshot()).length, 1);
});

test('Claude and Grok keep session-specific follow-up drafts, send guards and task session binding', async t => {
  for (const provider of ['claude', 'grok']) {
    const f = await fixture(t, { agents: [external({ provider })] });
    f.model.key('p'); f.model.paste('Old draft'); f.model.key('', { escape: true });
    f.publish({ agents: [external({ provider, sessionId: 'session-b' })] }); f.model.key('p');
    assert.equal(f.model.getSnapshot().followUp.text, ''); f.model.paste('Do not misroute');
    f.publish({ agents: [external({ provider, sessionId: 'session-c' })] }); f.model.key('s', { ctrl: true }); await tick();
    assert.equal(f.controller.calls.filter(call => call.method === 'followUp').length, 0);
    f.model.key('', { escape: true }); const task = await f.send(provider);
    const agent = external({ id: task.target.terminalId, ...task.target, provider, name: task.name, status: 'working', sessionId: 'correct-session' });
    f.publish({ agents: [agent] }); assert.equal(f.model.getTasks()[0].target.sessionId, 'correct-session');
    f.publish({ agents: [{ ...agent, sessionId: 'replacement', status: 'done' }] });
    assert.equal(f.model.getTasks()[0].live.status, 'working'); assert.equal(taskRows(f.model.getSnapshot()).length, 2);
  }
});

test('Codex session changes do not invalidate an in-flight summary, and refresh uses the actual target folder', async t => {
  const gate = deferred(), calls = [], f = await fixture(t, { agents: [], summarize: (cwd, options) => { calls.push({ cwd, options }); return gate.promise; } });
  const task = await f.send(); f.model.action('details'); await tick(); assert.equal(calls.length, 1);
  f.publish({ agents: [external({ id: task.target.terminalId, ...task.target, name: task.name, status: 'working', sessionId: 'wrong-daemon-session' })] });
  gate.resolve({ state: 'available', changedFiles: 1, insertions: 2, deletions: 0, commitsAhead: 0 }); await tick();
  assert.equal(f.model.getTasks()[0].summary.changedFiles, 1); assert.equal(calls[0].cwd, '/fixture/shep');
  assert.equal(f.model.getTasks()[0].target.sessionId, undefined);
});

test('model enrichment and the reader never read Codex sessions while retaining raw metadata unchanged', async t => {
  const reads = [], codex = external(), claude = external({ id: 'claude-terminal', terminalId: 'claude-terminal', paneId: 'w1:p3', provider: 'claude' });
  const f = await fixture(t, { agents: [codex, claude], readModel: async request => { reads.push(request); return { model: 'claude-opus-5-5', effort: 'high' }; } });
  assert.deepEqual(reads, [{ provider: 'claude', sessionId: 'session-a' }]);
  f.publish({ agents: [external({ sessionId: 'session-b' })] }); await tick();
  assert.deepEqual(f.model.getSnapshot().modelInfoByAgent, {});
  assert.equal(f.monitor.getSnapshot().agents[0].sessionId, 'session-b');
  const reader = createModelReader({ home: '/private/tmp/never-read-synthetic-codex' });
  assert.equal(await reader({ provider: 'codex', sessionId: 'valid-id' }), undefined);
  assert.equal(reads.some(request => request.provider === 'codex'), false);
});
