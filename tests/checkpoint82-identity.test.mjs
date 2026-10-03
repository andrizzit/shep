import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createController } from '../src/control.mjs';
import { getHerdrContext } from '../src/herdr.mjs';
import { trustedSession, sessionMatches } from '../src/agent-identity.mjs';
import { createNotifier } from '../src/notify.mjs';
import { DEFAULT_CONFIG } from '../src/dispatch/contracts.mjs';
import { matchesTask } from '../src/tui-tasks.mjs';
import { displayState, groupTasks } from '../src/tasks.mjs';
import { makeProject, makeSnapshot, deferred } from './helpers/dispatch-fakes.mjs';

const copy = value => structuredClone(value);
const raised = code => Object.assign(new Error('Synthetic host error'), { code });
const mutations = f => f.calls.filter(argv => ['rename', 'prompt', 'focus', 'close', 'start', 'split'].includes(argv[1]));
function fixture(t, { provider = 'codex', name = null, beforeGet, beforeRead, rename, afterRename } = {}) {
  const snapshot = makeSnapshot();
  const pane = { ...snapshot.panes[0], pane_id: 'w1:p2', terminal_id: 'target-terminal', focused: false };
  const agent = { ...pane, agent: provider, name, agent_status: 'idle', interactive_ready: true, launch_pending: false,
    agent_session: { kind: 'id', value: 'session-a' } };
  snapshot.panes.push(pane); snapshot.agents.push(agent);
  const calls = [], monitorState = { mode: 'live', source: { state: 'connected' } };
  let reads = 0, gets = 0;
  const f = { snapshot, pane, agent, calls, monitorState, target: { paneId: pane.pane_id, terminalId: pane.terminal_id,
    provider, agentName: name, sessionId: 'session-a', status: 'idle' } };
  const controller = createController({
    context: getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/private/tmp/shep-synthetic.sock',
      HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', PATH: '' }),
    monitor: { getSnapshot: () => monitorState },
    readRaw: async () => { await beforeRead?.(f, ++reads); return { result: { snapshot: copy(snapshot) } }; },
    run: async argv => {
      calls.push([...argv]);
      if (argv[1] === 'get') { await beforeGet?.(f, ++gets); return { result: { agent: copy(agent) } }; }
      if (argv[1] === 'rename') {
        await rename?.(f, argv); agent.name = argv[3];
        const response = { result: { agent: copy(agent) } }; await afterRename?.(f, response); return response;
      }
      if (argv[1] === 'prompt') return { result: { agent: copy(agent) } };
      if (argv[1] === 'focus') { snapshot.focused_pane_id = argv[2]; return { result: {} }; }
      if (argv[1] === 'close') { snapshot.panes = snapshot.panes.filter(p => p.pane_id !== argv[2]); snapshot.agents = []; return { result: {} }; }
      throw new Error(`Unexpected synthetic command ${argv[0]} ${argv[1]}`);
    },
  });
  f.controller = controller; t.after(controller.dispose); return f;
}

test('session trust ignores only Codex and preserves other providers supplied and optional matching rules', () => {
  assert.equal(trustedSession('codex', 'session-a'), undefined);
  for (const provider of ['claude', 'grok', 'other']) {
    assert.equal(trustedSession(provider, 'session-a'), 'session-a');
    assert.equal(trustedSession(provider, ''), '');
    assert.equal(sessionMatches(provider, 'session-a', 'session-b'), false);
    assert.equal(sessionMatches(provider, '', undefined, true), false);
    assert.equal(sessionMatches(provider, '', undefined), true);
  }
  assert.equal(sessionMatches('codex', 'session-a', 'session-b', true), true);
});

test('Codex session churn remains controllable; Claude and Grok replacements are refused for every control', async t => {
  for (const provider of ['codex', 'claude', 'grok']) for (const method of ['focus', 'closeAgent', 'followUp', 'rename']) {
    const f = fixture(t, { provider, name: 'captured' });
    f.agent.agent_session.value = 'different-session';
    const request = method === 'followUp' ? { target: f.target, text: 'Reply with OK' }
      : method === 'rename' ? { target: f.target, name: 'new-name' } : f.target;
    const result = await f.controller[method](request);
    assert.equal(result.ok, provider === 'codex', `${provider}/${method}`);
    assert.equal(mutations(f).length, provider === 'codex' ? 1 : 0, `${provider}/${method}`);
  }
});

test('empty supplied non-Codex session IDs still refuse a different session before control', async t => {
  for (const provider of ['claude', 'grok']) {
    const f = fixture(t, { provider }); f.target.sessionId = '';
    assert.equal((await f.controller.rename({ target: f.target, name: 'new-name' })).code, 'changed_target');
    assert.equal(mutations(f).length, 0);
  }
});

test('rename accepts an unnamed external agent, even a detected provider outside the launch catalog, exactly once', async t => {
  for (const provider of ['codex', 'new-provider']) {
    const f = fixture(t, { provider });
    const result = await f.controller.rename({ target: f.target, name: 'owner_agent-2' });
    assert.deepEqual(result, { ok: true, state: 'submitted', message: 'Agent renamed.',
      paneId: 'w1:p2', terminalId: 'target-terminal', agentName: 'owner_agent-2' });
    assert.deepEqual(mutations(f), [['agent', 'rename', 'w1:p2', 'owner_agent-2']]);
    assert.equal(f.calls.filter(argv => argv[1] === 'get').length, 2, 'Fresh native preflight and postflight');
  }
});

test('rename refuses invalid literal names without sending a mutation', async t => {
  for (const name of ['', 'Uppercase', '--option', 'two words', 'a'.repeat(33), 'a\nenter', '$(literal)', 'a\0b']) {
    const f = fixture(t); assert.equal((await f.controller.rename({ target: f.target, name })).code, 'invalid_name');
    assert.equal(mutations(f).length, 0, JSON.stringify(name));
  }
});

test('rename retains own-pane, own-terminal, stale, demo, startup and provider-confirmation refusals', async t => {
  for (const condition of ['own-pane', 'own-terminal', 'disconnected', 'demo', 'pending-snapshot', 'pending-get', 'no-provider', 'disposed']) {
    const f = fixture(t, condition === 'pending-get' ? { beforeGet: f => { f.agent.launch_pending = true; } } : {});
    if (condition === 'own-pane') f.target.paneId = 'w1:p1';
    if (condition === 'own-terminal') f.target.terminalId = 'own-terminal';
    if (condition === 'disconnected') f.monitorState.source.state = 'disconnected';
    if (condition === 'demo') f.monitorState.mode = 'demo';
    if (condition === 'pending-snapshot') f.agent.launch_pending = true;
    if (condition === 'no-provider') delete f.target.provider;
    if (condition === 'disposed') f.controller.dispose();
    const result = await f.controller.rename({ target: f.target, name: 'new-name' });
    assert.equal(result.ok, false, condition); assert.equal(mutations(f).length, 0, condition);
  }
});

test('rename matches the captured old name including null, pane, terminal and provider on both preflight reads', async t => {
  for (const phase of ['snapshot', 'get']) for (const field of ['pane_id', 'terminal_id', 'agent', 'name']) {
    const change = f => { f.agent[field] = 'replacement'; if (field === 'terminal_id' && phase === 'snapshot') f.pane.terminal_id = 'replacement'; };
    const f = fixture(t, phase === 'get' ? { beforeGet: change } : {});
    if (phase === 'snapshot') change(f);
    const result = await f.controller.rename({ target: f.target, name: 'new-name' });
    assert.equal(result.code, 'changed_target', `${phase}/${field}`); assert.equal(mutations(f).length, 0);
  }
  const named = fixture(t, { name: 'captured', beforeGet: f => { f.agent.name = null; } });
  assert.equal((await named.controller.rename({ target: named.target, name: 'new-name' })).code, 'changed_target');
  assert.equal(mutations(named).length, 0);
});

test('rename failure and every changed postflight identity remain uncertain with one rename and no prompt or cleanup', async t => {
  for (const phase of ['response', 'snapshot', 'get']) for (const field of ['pane_id', 'terminal_id', 'agent', 'name', 'agent_session']) {
    const change = agent => { agent[field] = field === 'agent_session' ? { kind: 'id', value: 'replacement-session' } : 'replacement'; };
    const f = fixture(t, { provider: 'claude', afterRename: (f, response) => {
      if (phase === 'response') change(response.result.agent); if (phase === 'snapshot') change(f.agent);
    }, beforeGet: (f, count) => { if (phase === 'get' && count === 2) change(f.agent); } });
    assert.equal((await f.controller.rename({ target: f.target, name: 'new-name' })).state, 'uncertain', `${phase}/${field}`);
    assert.deepEqual(mutations(f), [['agent', 'rename', 'w1:p2', 'new-name']]);
  }
  for (const code of ['timeout', 'unavailable', 'invalid_response']) {
    const f = fixture(t, { rename: () => { throw raised(code); } });
    assert.equal((await f.controller.rename({ target: f.target, name: 'new-name' })).state, 'uncertain');
    assert.equal(mutations(f).length, 1);
  }
});

test('rename serializes concurrent actions and disposal during the single command sends no postflight or retry', async t => {
  for (const disposed of [false, true]) {
    const entered = deferred(), release = deferred();
    const f = fixture(t, { rename: async () => { entered.resolve(); await release.promise; } });
    t.after(() => release.resolve());
    const pending = f.controller.rename({ target: f.target, name: 'new-name' }); await entered.promise;
    for (const method of ['rename', 'followUp', 'closeAgent', 'focus']) {
      const request = method === 'rename' ? { target: f.target, name: 'second-name' } : method === 'followUp' ? { target: f.target, text: 'Do not send' } : f.target;
      assert.equal((await f.controller[method](request)).code, 'busy');
    }
    if (disposed) f.controller.dispose(); release.resolve();
    assert.equal((await pending).state, disposed ? 'uncertain' : 'submitted');
    assert.equal(f.calls.filter(argv => argv[1] === 'get').length, disposed ? 1 : 2);
    assert.equal(mutations(f).length, 1);
  }
});

test('mid-startup operation lock refuses rename even when native launch_pending is false', async t => {
  const root = await mkdtemp('/private/tmp/shep-c82-lock-'); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin); await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const snapshot = makeSnapshot(); snapshot.panes[0].cwd = snapshot.panes[0].foreground_cwd = root;
  const calls = [], entered = deferred(), release = deferred(); let agent;
  const controller = createController({ context: getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: join(root, 'fixture.sock'),
    HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', PATH: bin }),
    monitor: { getSnapshot: () => ({ mode: 'live', source: { state: 'connected' } }) }, readRaw: async () => ({ result: { snapshot: copy(snapshot) } }),
    run: async argv => {
      calls.push([...argv]);
      if (argv[1] === 'layout') return { result: { layout: { workspace_id: 'w1', tab_id: 'w1:t1', panes: [{ pane_id: 'w1:p1', rect: { width: 120, height: 40 } }] } } };
      if (argv[1] === 'split') { const pane = { ...snapshot.panes[0], pane_id: 'w1:p2', terminal_id: 'new-terminal', focused: false }; snapshot.panes.push(pane); return { result: { pane } }; }
      if (argv[1] === 'start') { agent = { ...snapshot.panes[1], name: argv[2], agent: 'codex', agent_status: 'working', launch_pending: false }; snapshot.agents.push(agent); entered.resolve(); await release.promise; return { result: { agent: copy(agent) } }; }
      if (argv[1] === 'get') return { result: { agent: copy(agent) } };
      throw new Error('Unexpected startup mutation');
    } });
  t.after(() => { release.resolve(); controller.dispose(); });
  const pending = controller.dispatch({ provider: 'codex', name: 'new-task', prompt: 'Reply with OK', workspaceId: 'w1' });
  await entered.promise;
  assert.equal((await controller.rename({ target: { paneId: 'w1:p2', terminalId: 'new-terminal', provider: 'codex', agentName: 'new-task' }, name: 'new-name' })).code, 'busy');
  release.resolve(); assert.equal((await pending).state, 'submitted');
  assert.equal(calls.filter(argv => argv[1] === 'rename').length, 0);
  assert.equal(calls.filter(argv => argv[1] === 'start').length, 1);
});

test('Codex session churn keeps task matching, board grouping and display without weakening Claude/Grok matching', () => {
  for (const provider of ['codex', 'claude', 'grok']) {
    const project = makeProject(), task = { id: 'task', agent: { provider }, name: 'captured', inputTask: 'Synthetic work', at: '2026-10-02T00:00:00Z',
      project, target: { paneId: 'pane', terminalId: 'terminal', provider, agentName: 'captured', sessionId: 'session-a' }, launch: { state: 'submitted' }, live: { status: null } };
    const agent = { id: 'terminal', paneId: 'pane', terminalId: 'terminal', provider, name: 'captured', agentName: 'captured', sessionId: 'session-b', status: 'working', workspace: { path: project.root } };
    assert.equal(Boolean(matchesTask(task, agent)), provider === 'codex');
    assert.equal(displayState(task, [agent]), provider === 'codex' ? 'working' : 'unknown');
    assert.equal(groupTasks([task], [agent], [project]).flatMap(group => group.rows).length, provider === 'codex' ? 1 : 2);
  }
});

test('Codex task and external notification identities ignore churn but strict Claude/Grok sessions still reject replacements', () => {
  for (const provider of ['codex', 'claude', 'grok']) for (const external of [false, true]) {
    const agent = { paneId: 'pane', terminalId: 'terminal', provider, name: 'captured', agentName: 'captured', sessionId: 'session-a', status: 'working', focused: false };
    const task = { id: 'task', agent: { provider }, target: { ...agent }, project: { name: 'Synthetic' }, launch: { state: 'submitted' }, intent: { label: 'Synthetic task' } };
    const calls = [], snapshot = { mode: 'live', source: { state: 'connected' }, agents: [agent] };
    let update;
    const config = copy(DEFAULT_CONFIG); config.notifications.external = external;
    const notifier = createNotifier({ monitor: { getSnapshot: () => snapshot, subscribe: fn => { update = fn; return () => {}; } },
      controller: { notify: request => calls.push(request) }, config, getTasks: () => external ? [] : [task] });
    agent.sessionId = 'session-b'; agent.status = 'done'; update(snapshot); update(snapshot);
    assert.equal(calls.length, provider === 'codex' ? 1 : 0, `${provider}/${external}`);
    if (calls.length) assert.equal(calls[0].sound, 'done');
    notifier.dispose();
  }
});

test('Codex session changes or missing IDs do not suppress first-bound blocked or stalled attention', () => {
  for (const state of ['submitted', 'uncertain']) for (const stalled of [false, true]) for (const missing of [false, true]) {
    const agent = { paneId: 'pane', terminalId: 'terminal', provider: 'codex', name: 'captured', agentName: 'captured', sessionId: missing ? undefined : 'session-b', status: stalled ? 'idle' : 'blocked', focused: false };
    const task = { id: 'task', agent: { provider: 'codex' }, target: null, project: { name: 'Synthetic' }, launch: { state: 'starting' } };
    const snapshot = { mode: 'live', source: { state: 'connected' }, agents: [] }, calls = []; let update;
    const notifier = createNotifier({ monitor: { getSnapshot: () => snapshot, subscribe: fn => { update = fn; return () => {}; } },
      controller: { notify: request => calls.push(request) }, config: copy(DEFAULT_CONFIG), getTasks: () => [task] });
    task.target = { ...agent, sessionId: 'session-a' };
    task.launch = { state: stalled ? 'uncertain' : state, message: 'Synthetic startup', ...(stalled ? { code: 'agent_prompt_stalled' } : {}) };
    snapshot.agents = [agent]; update(snapshot); update(snapshot);
    assert.equal(calls.length, 1, `${state}/${stalled}/${missing}`); assert.equal(calls[0].sound, 'request'); notifier.dispose();
  }
});

test('legacy optional task targets use the known task provider when ignoring Codex notification signature IDs', () => {
  const target = { paneId: 'pane', terminalId: 'terminal', agentName: 'captured', sessionId: 'daemon-session-a' };
  const agent = { ...target, provider: 'codex', name: 'captured', status: 'working', focused: false };
  const task = { id: 'task', target, agent: { provider: 'codex' }, project: { name: 'Synthetic' }, launch: { state: 'submitted' } };
  const snapshot = { mode: 'live', source: { state: 'connected' }, agents: [agent] }, calls = []; let update;
  const notifier = createNotifier({ monitor: { getSnapshot: () => snapshot, subscribe: fn => { update = fn; return () => {}; } },
    controller: { notify: request => calls.push(request) }, config: copy(DEFAULT_CONFIG), getTasks: () => [task] });
  target.sessionId = agent.sessionId = 'daemon-session-b'; agent.status = 'done'; update(snapshot); update(snapshot);
  assert.equal(calls.length, 1); assert.equal(calls[0].sound, 'done'); notifier.dispose();
});

test('startup and timeout name recovery ignore only Codex session churn and retain Claude/Grok preflight and postflight checks', async t => {
  const root = await mkdtemp('/private/tmp/shep-c82-start-session-'); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  for (const provider of ['codex', 'claude', 'grok']) await writeFile(join(bin, provider), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const provider of ['codex', 'claude', 'grok']) for (const phase of ['startup', 'recovery-preflight', 'recovery-postflight']) {
    const snapshot = makeSnapshot(); snapshot.panes[0].cwd = snapshot.panes[0].foreground_cwd = root;
    const calls = []; let agent, gets = 0;
    const controller = createController({ context: getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: join(root, 'fixture.sock'),
      HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', PATH: bin }),
      monitor: { getSnapshot: () => ({ mode: 'live', source: { state: 'connected' } }) }, readRaw: async () => ({ result: { snapshot: copy(snapshot) } }),
      run: async argv => {
        calls.push([...argv]);
        if (argv[1] === 'layout') return { result: { layout: { workspace_id: 'w1', tab_id: 'w1:t1', panes: [{ pane_id: 'w1:p1', rect: { width: 120, height: 40 } }] } } };
        if (argv[1] === 'split') { const pane = { ...snapshot.panes[0], pane_id: 'w1:p2', terminal_id: 'new-terminal', focused: false }; snapshot.panes.push(pane); return { result: { pane } }; }
        if (argv[1] === 'start') {
          agent = { ...snapshot.panes[1], agent: provider, agent_status: 'working', launch_pending: false, agent_session: { kind: 'id', value: 'session-a' } };
          snapshot.agents.push(agent);
          if (phase !== 'startup') throw raised('timeout');
          agent.name = argv[2]; const response = { result: { agent: copy(agent) } }; agent.agent_session.value = 'session-b'; return response;
        }
        if (argv[1] === 'get') {
          if ((phase === 'recovery-preflight' && ++gets === 1) || (phase === 'recovery-postflight' && ++gets === 2)) agent.agent_session.value = 'session-b';
          return { result: { agent: copy(agent) } };
        }
        if (argv[1] === 'rename') { agent.name = argv[3]; return { result: { agent: copy(agent) } }; }
        throw new Error('Unexpected startup/session mutation');
      } });
    t.after(controller.dispose);
    const result = await controller.dispatch({ provider, name: 'reply-task', prompt: 'Reply with OK', workspaceId: 'w1' });
    assert.equal(result.ok, provider === 'codex', `${provider}/${phase}`);
    assert.equal(calls.filter(argv => argv[1] === 'start').length, 1);
    assert.equal(calls.filter(argv => argv[1] === 'rename').length, phase === 'startup' || phase === 'recovery-preflight' && provider !== 'codex' ? 0 : 1, `${provider}/${phase}`);
    assert.equal(calls.filter(argv => ['prompt', 'close', 'remove'].includes(argv[1])).length, 0);
  }
});
