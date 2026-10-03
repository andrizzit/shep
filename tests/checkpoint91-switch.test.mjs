import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/control.mjs';
import { getHerdrContext } from '../src/herdr.mjs';

const copy = value => structuredClone(value);
const flag = (argv, name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;

function switchFixture({ missingOrigin = false } = {}) {
  const snapshot = {
    focused_pane_id: 'w1:p1',
    workspaces: ['w1', 'w2', 'w3'].map(workspace_id => ({ workspace_id })),
    tabs: ['w1', 'w2', 'w3'].map(workspace_id => ({ workspace_id, tab_id: `${workspace_id}:t1` })),
    panes: [
      { pane_id: 'w1:p1', terminal_id: 'shep-terminal', workspace_id: 'w1', tab_id: 'w1:t1' },
      { pane_id: 'w2:p1', terminal_id: 'agent-a-terminal', workspace_id: 'w2', tab_id: 'w2:t1', cwd: '/private/tmp' },
      { pane_id: 'w3:p1', terminal_id: 'agent-b-terminal', workspace_id: 'w3', tab_id: 'w3:t1', cwd: '/private/tmp' },
    ],
    agents: ['a', 'b'].map((letter, index) => ({ pane_id: `w${index + 2}:p1`, terminal_id: `agent-${letter}-terminal`,
      workspace_id: `w${index + 2}`, tab_id: `w${index + 2}:t1`, agent: 'claude', name: `agent-${letter}`,
      agent_status: 'working', agent_session: { kind: 'id', value: `session-${letter}` }, process_id: 5000 + index })),
  };
  const calls = [], layouts = [];
  let serial = 2, busyTerminal = null, failOldRestore = null;
  const paneFor = terminal => snapshot.panes.find(pane => pane.terminal_id === terminal);
  const targetFor = letter => {
    const agent = snapshot.agents.find(item => item.terminal_id === `agent-${letter}-terminal`);
    return { paneId: agent.pane_id, terminalId: agent.terminal_id, provider: 'claude', agentName: agent.name,
      sessionId: `session-${letter}` };
  };
  const controller = createController({
    context: getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/private/tmp/shep-switch-test.sock',
      HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', SHELL: '/bin/zsh' }),
    monitor: { getSnapshot: () => ({ mode: 'live', source: { state: 'connected' } }) },
    readRaw: async () => ({ result: { snapshot: copy(snapshot) } }),
    run: async argv => {
      calls.push(copy(argv));
      const [type, action] = argv;
      if (type === 'pane' && action === 'layout') {
        const docked = snapshot.agents.filter(agent => agent.tab_id === 'w1:t1');
        const shepWidth = docked.length ? 115 : 328;
        return { result: { layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false,
          panes: [{ pane_id: 'w1:p1', rect: { x: 0, width: shepWidth, height: 40 } },
            ...docked.map((agent, index) => ({ pane_id: agent.pane_id,
              rect: { x: shepWidth + index * Math.floor((328 - shepWidth) / docked.length),
                width: Math.floor((328 - shepWidth) / docked.length), height: 40 } }))] } } };
      }
      if (type === 'pane' && action === 'get') return { result: { pane: copy(snapshot.panes.find(pane => pane.pane_id === argv[2])) } };
      if (type === 'agent' && action === 'get') return { result: { agent: copy(snapshot.agents.find(agent => agent.pane_id === argv[2])) } };
      if (type === 'pane' && action === 'process-info') {
        const pane = snapshot.panes.find(item => item.pane_id === flag(argv, '--pane'));
        const pid = pane.shell_pid, foreground = pane.terminal_id === busyTerminal ? pid + 1 : pid;
        return { result: { process_info: { pane_id: pane.pane_id, shell_pid: pid, foreground_process_group_id: foreground,
          foreground_processes: [{ pid: foreground, name: foreground === pid ? 'zsh' : 'sleep',
            argv0: foreground === pid ? 'zsh' : 'sleep', argv: [foreground === pid ? '-zsh' : 'sleep'] }] } } };
      }
      if (type === 'pane' && action === 'split') {
        const source = snapshot.panes.find(pane => pane.pane_id === flag(argv, '--pane'));
        const pane = { pane_id: `${source.workspace_id}:p${serial++}`, terminal_id: `placeholder-${serial}`,
          workspace_id: source.workspace_id, tab_id: source.tab_id, shell_pid: 40000 + serial, label: null };
        snapshot.panes.push(pane);
        return { result: { pane: copy(pane) } };
      }
      if (type === 'pane' && action === 'rename') {
        const pane = snapshot.panes.find(item => item.pane_id === argv[2]); pane.label = argv[3];
        return { result: { pane: copy(pane) } };
      }
      if (type === 'pane' && action === 'move') {
        const pane = snapshot.panes.find(item => item.pane_id === argv[2]);
        const agent = snapshot.agents.find(item => item.terminal_id === pane.terminal_id);
        if (failOldRestore === 'before' && agent?.name === 'agent-a' && flag(argv, '--tab') === 'w2:t1') {
          failOldRestore = null;
          throw Object.assign(new Error('synthetic old restore failure'), { code: 'timeout' });
        }
        const workspace = argv.includes('--new-tab') ? flag(argv, '--workspace') : flag(argv, '--tab').split(':')[0];
        const tab = argv.includes('--new-tab') ? `${workspace}:t${serial++}` : flag(argv, '--tab');
        if (argv.includes('--new-tab')) snapshot.tabs.push({ workspace_id: workspace, tab_id: tab });
        pane.pane_id = `${workspace}:p${serial++}`; pane.workspace_id = workspace; pane.tab_id = tab;
        agent.pane_id = pane.pane_id; agent.workspace_id = workspace; agent.tab_id = tab;
        layouts.push({ moved: agent.name, tab, shepPanes: snapshot.agents.filter(item => item.tab_id === 'w1:t1').length + 1 });
        if (failOldRestore === 'after' && agent.name === 'agent-a' && tab === 'w2:t1') {
          failOldRestore = null;
          throw Object.assign(new Error('synthetic response lost after old restore'), { code: 'timeout' });
        }
        return { result: { move_result: { changed: true, pane: copy(pane) } } };
      }
      if (type === 'pane' && action === 'close') {
        snapshot.panes = snapshot.panes.filter(pane => pane.pane_id !== argv[2]);
        return { result: {} };
      }
      throw new Error(`Unexpected command: ${argv.join(' ')}`);
    },
  });
  return { snapshot, calls, layouts, controller, paneFor, targetFor,
    busy(terminal) { busyTerminal = terminal; },
    failOldRestore(when = 'before') { failOldRestore = when; },
    removeOrigin() {
      const placeholder = snapshot.panes.find(pane => pane.tab_id === 'w2:t1');
      snapshot.panes = snapshot.panes.filter(pane => pane !== placeholder);
      snapshot.tabs = snapshot.tabs.filter(tab => tab.tab_id !== 'w2:t1');
    }, missingOrigin };
}

test('switch keeps a busy old placeholder and removes its dock marker', async t => {
  const f = switchFixture(); t.after(f.controller.dispose);
  assert.equal((await f.controller.dock({ target: f.targetFor('a') })).state, 'docked');
  const oldPlaceholder = f.snapshot.panes.find(pane => pane.tab_id === 'w2:t1');
  f.busy(oldPlaceholder.terminal_id);
  const result = await f.controller.dock({ target: f.targetFor('b') });
  assert.equal(result.state, 'docked', result.message);
  assert.match(result.message, /placeholder kept \(busy or unverified\)/);
  assert.equal(f.paneFor(oldPlaceholder.terminal_id)?.label, 'Shell');
  assert.equal(f.paneFor('agent-a-terminal').workspace_id, 'w2');
  assert.equal(f.paneFor('agent-b-terminal').tab_id, 'w1:t1');
});

test('changed old placeholder terminal blocks a switch before any mutation', async t => {
  const f = switchFixture(); t.after(f.controller.dispose);
  assert.equal((await f.controller.dock({ target: f.targetFor('a') })).state, 'docked');
  const oldPlaceholder = f.snapshot.panes.find(pane => pane.tab_id === 'w2:t1');
  oldPlaceholder.terminal_id = 'replacement-terminal';
  const before = f.calls.filter(argv => ['split', 'move', 'rename', 'close'].includes(argv[1])).length;
  const result = await f.controller.dock({ target: f.targetFor('b') });
  assert.equal(result.ok, false);
  assert.equal(f.calls.filter(argv => ['split', 'move', 'rename', 'close'].includes(argv[1])).length, before);
  assert.equal(f.paneFor('agent-a-terminal').tab_id, 'w1:t1');
  assert.equal(f.paneFor('agent-b-terminal').tab_id, 'w3:t1');
});

test('failed old restore rolls the verified new agent home and retains the old dock', async t => {
  const f = switchFixture(); t.after(f.controller.dispose);
  assert.equal((await f.controller.dock({ target: f.targetFor('a') })).state, 'docked');
  f.failOldRestore();
  const result = await f.controller.dock({ target: f.targetFor('b') });
  assert.equal(result.state, 'uncertain');
  assert.equal(f.paneFor('agent-a-terminal').tab_id, 'w1:t1');
  assert.equal(f.paneFor('agent-b-terminal').tab_id, 'w3:t1');
  assert.equal(f.controller.getDockState()?.target.terminalId, 'agent-a-terminal');
  assert.equal(f.controller.getDockState()?.phase, 'uncertain');
  assert.equal(f.snapshot.panes.filter(pane => typeof pane.label === 'string' && pane.label.startsWith('shep-dock')).length, 1);
});

test('lost old restore response never retries an uncertain move', async t => {
  const f = switchFixture(); t.after(f.controller.dispose);
  assert.equal((await f.controller.dock({ target: f.targetFor('a') })).state, 'docked');
  f.failOldRestore('after');
  const result = await f.controller.dock({ target: f.targetFor('b') });
  assert.equal(result.state, 'uncertain');
  assert.equal(f.paneFor('agent-a-terminal').tab_id, 'w2:t1');
  assert.equal(f.paneFor('agent-b-terminal').tab_id, 'w3:t1');
  assert.equal(f.controller.getDockState()?.phase, 'uncertain');
  const moves = f.calls.filter(argv => argv[1] === 'move').length;
  await f.controller.undock();
  await f.controller.dock({ target: f.targetFor('b') });
  assert.equal(f.calls.filter(argv => argv[1] === 'move').length, moves);
});

for (const missingOrigin of [false, true]) {
  test(`switch keeps the right pane occupied and preserves both agents${missingOrigin ? ' after origin tab closure' : ''}`, async t => {
    const f = switchFixture({ missingOrigin }); t.after(f.controller.dispose);
    assert.equal((await f.controller.dock({ target: f.targetFor('a') })).state, 'docked');
    if (missingOrigin) f.removeOrigin();
    const before = f.layouts.length;
    const result = await f.controller.dock({ target: f.targetFor('b') });
    assert.equal(result.state, 'docked', result.message);
    assert.equal(result.restoredTarget.terminalId, 'agent-a-terminal');
    assert.deepEqual(f.layouts.slice(before).map(item => item.moved), ['agent-b', 'agent-a']);
    assert.deepEqual(f.layouts.slice(before).map(item => item.shepPanes), [3, 2]);
    if (missingOrigin) {
      const restoredMove = f.calls.find(argv => argv[1] === 'move' && argv.includes('--new-tab'));
      assert.equal(flag(restoredMove, '--label'), 'agent-a');
    }
    assert.equal(f.paneFor('agent-a-terminal').workspace_id, 'w2');
    assert.equal(f.paneFor('agent-b-terminal').tab_id, 'w1:t1');
    assert.equal(f.snapshot.agents[0].process_id, 5000);
    assert.equal(f.snapshot.agents[1].process_id, 5001);
    assert.equal((await f.controller.undock()).state, 'undocked');
    assert.equal(f.paneFor('agent-b-terminal').workspace_id, 'w3');
  });
}
