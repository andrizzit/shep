import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/control.mjs';
import { getHerdrContext } from '../src/herdr.mjs';

const clone = value => structuredClone(value);

function fixture({ width = 172, layoutMismatch = false, pending = false, provider = 'claude', name = 'synthetic', sessionId = 'session-a' } = {}) {
  const snapshot = {
    version: '0.9.1', focused_pane_id: 'w1:p1',
    workspaces: [
      { workspace_id: 'w1', active_tab_id: 'w1:t1' },
      { workspace_id: 'w2', active_tab_id: 'w2:t1' },
    ],
    tabs: [
      { tab_id: 'w1:t1', workspace_id: 'w1' },
      { tab_id: 'w2:t1', workspace_id: 'w2' },
    ],
    panes: [
      { pane_id: 'w1:p1', terminal_id: 'own-terminal', tab_id: 'w1:t1', workspace_id: 'w1', focused: true, cwd: '/private/tmp' },
      { pane_id: 'w2:p1', terminal_id: 'agent-terminal', tab_id: 'w2:t1', workspace_id: 'w2', focused: false, cwd: '/private/tmp' },
    ],
    agents: [{ pane_id: 'w2:p1', terminal_id: 'agent-terminal', tab_id: 'w2:t1', workspace_id: 'w2',
      agent: provider, name, agent_status: 'working', launch_pending: pending,
      agent_session: { kind: 'id', value: sessionId }, process_id: 15036 }],
  };
  const calls = [];
  const monitorState = { mode: 'live', source: { state: 'connected' } };
  let nextPane = 3, nextTab = 2, nextWorkspace = 3, moveError = null, renameError = false;
  const flag = (argv, value) => argv.includes(value) ? argv[argv.indexOf(value) + 1] : null;
  const f = {
    snapshot, calls,
    target: { paneId: 'w2:p1', terminalId: 'agent-terminal', provider, agentName: name, sessionId },
    monitorState,
    setMoveError(value) { moveError = value; },
    setRenameError(value) { renameError = value; },
    createController() {
      return createController({
        context: getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/private/tmp/shep-dock-test.sock',
          HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1' }),
        monitor: { getSnapshot: () => monitorState },
        readRaw: async () => ({ result: { snapshot: clone(snapshot) } }),
        run: async argv => {
          calls.push(clone(argv));
          const [type, action] = argv;
          if (type === 'pane' && action === 'layout') return { result: { layout: { workspace_id: layoutMismatch ? 'w2' : 'w1', tab_id: 'w1:t1', zoomed: false,
            panes: [{ pane_id: 'w1:p1', rect: { x: 0, width, height: 40 } }] } } };
          if (type === 'pane' && action === 'get') return { result: { pane: clone(snapshot.panes.find(p => p.pane_id === argv[2])) } };
          if (type === 'pane' && action === 'process-info') return { result: { process_info: {
            pane_id: flag(argv, '--pane'), shell_pid: 40002, foreground_process_group_id: 40002,
            foreground_processes: [{ pid: 40002, name: 'zsh', argv0: 'zsh', argv: ['-zsh'] }],
          } } };
          if (type === 'agent' && action === 'get') return { result: { agent: clone(snapshot.agents.find(a => a.pane_id === argv[2])) } };
          if (type === 'pane' && action === 'split') {
            const source = snapshot.panes.find(p => p.pane_id === flag(argv, '--pane'));
            const pane = { ...source, pane_id: `${source.workspace_id}:p${nextPane++}`, terminal_id: 'placeholder-terminal',
              focused: false, label: null };
            snapshot.panes.push(pane);
            return { result: { pane: clone(pane) } };
          }
          if (type === 'pane' && action === 'rename') {
            if (renameError) throw Object.assign(new Error('synthetic rename failure'), { code: 'timeout' });
            const pane = snapshot.panes.find(p => p.pane_id === argv[2]); pane.label = argv[3];
            return { result: { pane: clone(pane) } };
          }
          if (type === 'pane' && action === 'move') {
            if (moveError === 'throw') throw Object.assign(new Error('synthetic timeout'), { code: 'timeout' });
            if (moveError === 'unchanged') return { result: { move_result: { changed: false, reason: 'synthetic' } } };
            const source = snapshot.panes.find(p => p.pane_id === argv[2]);
            const oldId = source.pane_id;
            let tabId = flag(argv, '--tab'), workspaceId = tabId?.split(':')[0];
            if (argv.includes('--new-tab')) {
              workspaceId = flag(argv, '--workspace'); tabId = `${workspaceId}:t${nextTab++}`;
              snapshot.tabs.push({ tab_id: tabId, workspace_id: workspaceId });
            } else if (argv.includes('--new-workspace')) {
              workspaceId = `w${nextWorkspace++}`; tabId = `${workspaceId}:t1`;
              snapshot.workspaces.push({ workspace_id: workspaceId, active_tab_id: tabId });
              snapshot.tabs.push({ tab_id: tabId, workspace_id: workspaceId });
            }
            source.pane_id = `${workspaceId}:p${nextPane++}`;
            source.workspace_id = workspaceId; source.tab_id = tabId;
            const agent = snapshot.agents.find(a => a.terminal_id === source.terminal_id);
            if (agent) { agent.pane_id = source.pane_id; agent.workspace_id = workspaceId; agent.tab_id = tabId; }
            return { result: { move_result: { changed: true, pane: clone(source), previous_pane_id: oldId } } };
          }
          if (type === 'pane' && action === 'close') {
            snapshot.panes = snapshot.panes.filter(p => p.pane_id !== argv[2]);
            snapshot.agents = snapshot.agents.filter(a => a.pane_id !== argv[2]);
            return { result: {} };
          }
          throw new Error(`Unexpected ${argv.join(' ')}`);
        },
      });
    },
  };
  return f;
}

const mutations = f => f.calls.filter(argv => ['split', 'rename', 'move', 'close'].includes(argv[1]));

test('dock moves the exact live pane beside Shep, keeps process/focus, and restores original tab', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  const before = clone(f.snapshot.agents[0]);
  const docked = await controller.dock({ target: f.target });
  assert.equal(docked.state, 'docked', docked.message);
  assert.equal(docked.target.terminalId, f.target.terminalId);
  assert.equal(docked.target.paneId.startsWith('w1:'), true);
  assert.equal(f.snapshot.agents[0].process_id, before.process_id);
  assert.equal(f.snapshot.agents[0].name, before.name);
  assert.equal(f.snapshot.agents[0].agent_status, before.agent_status);
  assert.equal(f.snapshot.focused_pane_id, 'w1:p1');
  assert.equal(f.snapshot.panes.find(p => p.terminal_id === 'placeholder-terminal').label.startsWith('shep-dock'), true);
  assert.deepEqual(mutations(f).map(argv => argv[1]), ['split', 'rename', 'move']);
  assert.equal((await controller.closeAgent(docked.target)).code, 'dock_marker', 'Close must wait for the dock to restore');
  assert.deepEqual(mutations(f).map(argv => argv[1]), ['split', 'rename', 'move']);
  const restored = await controller.undock();
  assert.equal(restored.state, 'undocked', restored.message);
  assert.equal(restored.target.terminalId, f.target.terminalId);
  assert.equal(f.snapshot.panes.find(p => p.terminal_id === f.target.terminalId).tab_id, 'w2:t1');
  assert.equal(f.snapshot.panes.some(p => p.terminal_id === 'placeholder-terminal'), false);
  assert.equal(f.snapshot.agents[0].process_id, before.process_id);
  assert.equal(f.snapshot.focused_pane_id, 'w1:p1');
  assert.deepEqual(mutations(f).map(argv => argv[1]), ['split', 'rename', 'move', 'move', 'close']);
});

test('dock refuses narrow tab, own pane, pending agent and changed identity without a mutation', async t => {
  for (const condition of ['narrow', 'wrong-layout', 'own', 'pending', 'changed-name', 'changed-session']) {
    const f = fixture({ width: condition === 'narrow' ? 139 : 172, layoutMismatch: condition === 'wrong-layout', pending: condition === 'pending' });
    const controller = f.createController(); t.after(controller.dispose);
    if (condition === 'own') { f.target.paneId = 'w1:p1'; f.target.terminalId = 'own-terminal'; }
    if (condition === 'changed-name') f.snapshot.agents[0].name = 'replacement';
    if (condition === 'changed-session') f.snapshot.agents[0].agent_session.value = 'replacement';
    const result = await controller.dock({ target: f.target });
    assert.equal(result.ok, false, condition);
    assert.deepEqual(mutations(f), [], condition);
  }
});

test('undock restores through a stale monitor when the pinned native session remains reachable', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target })).state, 'docked');
  f.monitorState.source.state = 'disconnected';
  const restored = await controller.undock();
  assert.equal(restored.state, 'undocked', restored.message);
  assert.equal(f.snapshot.panes.find(p => p.terminal_id === f.target.terminalId).tab_id, 'w2:t1');
});

test('startup recovery uses only the marked pane and exact agent identity', async t => {
  const f = fixture(); const first = f.createController(); t.after(first.dispose);
  assert.equal((await first.dock({ target: f.target })).state, 'docked');
  const second = f.createController(); t.after(second.dispose);
  const recovered = await second.recoverDock();
  assert.equal(recovered.state, 'recovered', recovered.message);
  assert.equal(f.snapshot.panes.find(p => p.terminal_id === f.target.terminalId).tab_id, 'w2:t1');
  assert.equal(f.snapshot.panes.some(p => p.terminal_id === 'placeholder-terminal'), false);
});

test('startup recovery clears a marker left before move or after agent closure', async t => {
  for (const phase of ['before-move', 'closed-agent']) {
    const f = fixture(); const first = f.createController(); t.after(first.dispose);
    if (phase === 'before-move') f.setMoveError('unchanged');
    const docked = await first.dock({ target: f.target });
    assert.equal(docked.state, phase === 'before-move' ? 'uncertain' : 'docked');
    if (phase === 'closed-agent') {
      f.snapshot.panes = f.snapshot.panes.filter(p => p.terminal_id !== f.target.terminalId);
      f.snapshot.agents = [];
    }
    const second = f.createController(); t.after(second.dispose);
    const recovered = await second.recoverDock();
    assert.equal(recovered.state, 'recovered', `${phase}: ${recovered.message}`);
    assert.equal(f.snapshot.panes.some(p => p.terminal_id === 'placeholder-terminal'), false);
  }
});

test('closed original tab and workspace restore the unchanged agent to a replacement location', async t => {
  for (const closure of ['tab', 'workspace']) {
    const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
    assert.equal((await controller.dock({ target: f.target })).state, 'docked');
    f.snapshot.tabs = f.snapshot.tabs.filter(tab => tab.tab_id !== 'w2:t1');
    f.snapshot.panes = f.snapshot.panes.filter(p => p.terminal_id !== 'placeholder-terminal');
    if (closure === 'workspace') f.snapshot.workspaces = f.snapshot.workspaces.filter(w => w.workspace_id !== 'w2');
    const restored = await controller.undock();
    assert.equal(restored.state, 'undocked', `${closure}: ${restored.message}`);
    assert.equal(f.snapshot.panes.find(p => p.terminal_id === f.target.terminalId).workspace_id,
      closure === 'tab' ? 'w2' : 'w3');
    assert.equal(f.snapshot.agents[0].process_id, 15036);
  }
});

test('an uncertain move is never repeated or reported as docked', async t => {
  for (const failure of ['throw', 'unchanged']) {
    const f = fixture(); f.setMoveError(failure);
    const controller = f.createController(); t.after(controller.dispose);
    const result = await controller.dock({ target: f.target });
    assert.equal(result.state, 'uncertain');
    assert.equal(f.calls.filter(argv => argv[1] === 'move').length, 1);
    assert.equal(controller.getDockState().phase, 'uncertain');
    await controller.dock({ target: f.target });
    await controller.undock();
    assert.equal(f.calls.filter(argv => argv[1] === 'move').length, 1);
  }
});

test('failed marker rename cleans up only the new empty placeholder once', async t => {
  const f = fixture(); f.setRenameError(true);
  const controller = f.createController(); t.after(controller.dispose);
  const result = await controller.dock({ target: f.target });
  assert.equal(result.state, 'uncertain');
  assert.equal(controller.getDockState(), null);
  assert.equal(f.snapshot.panes.some(p => p.terminal_id === 'placeholder-terminal'), false);
  assert.deepEqual(mutations(f).map(argv => argv[1]), ['split', 'rename', 'close']);
});

test('malformed leftover marker refuses recovery and a new dock without mutation', async t => {
  const f = fixture();
  f.snapshot.panes.push({ pane_id: 'w2:p9', terminal_id: 'unowned-terminal', workspace_id: 'w2', tab_id: 'w2:t1',
    label: 'shep-dock:v1:malformed' });
  const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.recoverDock()).code, 'dock_marker');
  assert.equal((await controller.dock({ target: f.target })).code, 'dock_marker');
  assert.deepEqual(mutations(f), []);
});

test('restart in a different Shep pane surfaces an unmatched valid marker without moving the agent', async t => {
  const f = fixture(); const first = f.createController(); t.after(first.dispose);
  assert.equal((await first.dock({ target: f.target })).state, 'docked');
  const before = mutations(f).length;
  f.snapshot.panes[0].terminal_id = 'replacement-shep-terminal';
  const second = f.createController(); t.after(second.dispose);
  const result = await second.recoverDock();
  assert.equal(result.code, 'dock_marker');
  assert.match(result.message, /another Shep pane/);
  assert.equal(mutations(f).length, before);
  assert.equal(f.snapshot.panes.find(p => p.terminal_id === f.target.terminalId).tab_id, 'w1:t1');
});

test('undock never closes a marked placeholder that gained its own agent', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target })).state, 'docked');
  const placeholder = f.snapshot.panes.find(p => p.terminal_id === 'placeholder-terminal');
  f.snapshot.agents.push({ pane_id: placeholder.pane_id, terminal_id: placeholder.terminal_id,
    tab_id: placeholder.tab_id, workspace_id: placeholder.workspace_id,
    agent: 'codex', name: 'new-agent', agent_status: 'working', launch_pending: false });
  const before = mutations(f).length;
  const result = await controller.undock();
  assert.equal(result.state, 'uncertain');
  assert.equal(mutations(f).length, before, 'Neither agent nor marked placeholder is moved or closed');
  assert.equal(f.snapshot.panes.some(p => p.terminal_id === 'placeholder-terminal'), true);
  const restarted = f.createController(); t.after(restarted.dispose);
  const beforeRecovery = mutations(f).length;
  assert.equal((await restarted.recoverDock()).state, 'uncertain');
  assert.equal(mutations(f).length, beforeRecovery, 'Recovery also leaves the new placeholder agent intact');
});
