import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/control.mjs';
import { getHerdrContext } from '../src/herdr.mjs';

const clone = value => structuredClone(value);
const flag = (argv, name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;

function fixture({ width = 328, agents = ['alpha', 'beta'] } = {}) {
  const snapshot = {
    focused_pane_id: 'w1:p1',
    workspaces: [{ workspace_id: 'w1', active_tab_id: 'w1:t1' }, { workspace_id: 'w2', active_tab_id: 'w2:t1' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'Shep' }, { tab_id: 'w2:t1', workspace_id: 'w2', label: 'Agents' }],
    panes: [{ pane_id: 'w1:p1', terminal_id: 'shep-terminal', tab_id: 'w1:t1', workspace_id: 'w1', cwd: '/private/tmp' },
      ...agents.map((name, index) => ({ pane_id: `w2:p${index + 1}`, terminal_id: `terminal-${name}`,
        tab_id: 'w2:t1', workspace_id: 'w2', cwd: '/private/tmp' }))],
    agents: agents.map((name, index) => ({ pane_id: `w2:p${index + 1}`, terminal_id: `terminal-${name}`,
      tab_id: 'w2:t1', workspace_id: 'w2', agent: 'claude', name, agent_status: 'working',
      launch_pending: false, agent_session: { kind: 'id', value: `session-${name}` }, process_id: 15036 + index })),
  };
  const calls = [];
  let serial = 10, nextTab = 2, busy = false, moveFailure = null, notificationFailure = false;
  const renameBehaviors = [];
  const target = name => {
    const pane = snapshot.panes.find(item => item.terminal_id === `terminal-${name}`);
    return { paneId: pane.pane_id, terminalId: pane.terminal_id, provider: 'claude', agentName: name, sessionId: `session-${name}` };
  };
  const f = {
    snapshot, calls, target,
    tabLabel(tabId = 'w2:t1') { return snapshot.tabs.find(tab => tab.tab_id === tabId)?.label; },
    placeholder() { return snapshot.panes.find(pane => typeof pane.label === 'string' && pane.label.startsWith('shep-dock:v1:')); },
    setBusy(value = true) { busy = value; },
    failNextTabRename() { renameBehaviors.push('throw'); },
    nextTabRename(value) { renameBehaviors.push(value); },
    failMove(value) { moveFailure = value; },
    failNotification() { notificationFailure = true; },
    closeOrigin() { snapshot.tabs = snapshot.tabs.filter(tab => tab.tab_id !== 'w2:t1');
      snapshot.panes = snapshot.panes.filter(pane => pane.tab_id !== 'w2:t1'); },
    createController() {
      return createController({
        context: getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/private/tmp/shep-c93-test.sock',
          HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', SHELL: '/bin/zsh' }),
        monitor: { getSnapshot: () => ({ mode: 'live', source: { state: 'connected' } }) },
        readRaw: async () => ({ result: { snapshot: clone(snapshot) } }),
        run: async argv => {
          calls.push(clone(argv));
          const [kind, action] = argv;
          if (kind === 'pane' && action === 'layout') {
            const docked = snapshot.panes.find(pane => pane.tab_id === 'w1:t1' && pane.terminal_id !== 'shep-terminal');
            return { result: { layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false,
              panes: [{ pane_id: 'w1:p1', rect: { x: 0, width: docked ? 114 : width, height: 40 } },
                ...(docked ? [{ pane_id: docked.pane_id, rect: { x: 114, width: width - 114, height: 40 } }] : [])] } } };
          }
          if (kind === 'pane' && action === 'get') return { result: { pane: clone(snapshot.panes.find(pane => pane.pane_id === argv[2])) } };
          if (kind === 'agent' && action === 'get') return { result: { agent: clone(snapshot.agents.find(agent => agent.pane_id === argv[2])) } };
          if (kind === 'tab' && action === 'get') {
            const tab = snapshot.tabs.find(item => item.tab_id === argv[2]);
            if (!tab) throw Object.assign(new Error('missing tab'), { code: 'tab_not_found' });
            return { result: { tab: clone(tab) } };
          }
          if (kind === 'tab' && action === 'rename') {
            const behavior = renameBehaviors.shift();
            if (behavior === 'throw') throw Object.assign(new Error('rename failed'), { code: 'failed' });
            const tab = snapshot.tabs.find(item => item.tab_id === argv[2]);
            if (behavior === 'noop') return { result: { tab: clone(tab) } };
            tab.label = argv[3];
            if (behavior === 'malformed') return { result: { tab: { tab_id: 'wrong', label: argv[3] } } };
            return { result: { tab: clone(tab) } };
          }
          if (kind === 'pane' && action === 'process-info') {
            const paneId = flag(argv, '--pane');
            const pid = busy ? 40003 : 40002;
            const name = busy ? 'sleep' : 'zsh';
            return { result: { process_info: { pane_id: paneId, shell_pid: 40002,
              foreground_process_group_id: pid,
              foreground_processes: [{ pid, name, argv0: name, argv: [busy ? 'sleep' : '-zsh'] }] } } };
          }
          if (kind === 'pane' && action === 'split') {
            const source = snapshot.panes.find(pane => pane.pane_id === flag(argv, '--pane'));
            const pane = { pane_id: `${source.workspace_id}:p${serial++}`, terminal_id: `placeholder-${serial}`,
              tab_id: source.tab_id, workspace_id: source.workspace_id, cwd: source.cwd, label: null };
            snapshot.panes.push(pane);
            return { result: { pane: clone(pane) } };
          }
          if (kind === 'pane' && action === 'rename') {
            const pane = snapshot.panes.find(item => item.pane_id === argv[2]); pane.label = argv[3];
            return { result: { pane: clone(pane) } };
          }
          if (kind === 'pane' && action === 'move') {
            if (moveFailure === 'before') { moveFailure = null; throw Object.assign(new Error('move timeout'), { code: 'timeout' }); }
            const pane = snapshot.panes.find(item => item.pane_id === argv[2]);
            let tabId = flag(argv, '--tab');
            let workspaceId = tabId?.split(':')[0];
            if (argv.includes('--new-tab')) {
              workspaceId = flag(argv, '--workspace'); tabId = `${workspaceId}:t${nextTab++}`;
              snapshot.tabs.push({ tab_id: tabId, workspace_id: workspaceId, label: flag(argv, '--label') });
            }
            pane.pane_id = `${workspaceId}:p${serial++}`;
            pane.tab_id = tabId; pane.workspace_id = workspaceId;
            const agent = snapshot.agents.find(item => item.terminal_id === pane.terminal_id);
            agent.pane_id = pane.pane_id; agent.tab_id = tabId; agent.workspace_id = workspaceId;
            if (moveFailure === 'after') { moveFailure = null; throw Object.assign(new Error('move timeout'), { code: 'timeout' }); }
            return { result: { move_result: { changed: true, pane: clone(pane) } } };
          }
          if (kind === 'pane' && action === 'close') {
            snapshot.panes = snapshot.panes.filter(item => item.pane_id !== argv[2]);
            return { result: {} };
          }
          if (kind === 'notification' && action === 'show') {
            if (notificationFailure) throw Object.assign(new Error('offline'), { code: 'unavailable' });
            return { result: { ok: true } };
          }
          throw new Error(`Unexpected ${argv.join(' ')}`);
        },
      });
    },
  };
  return f;
}

const callsFor = (f, kind, action) => f.calls.filter(argv => argv[0] === kind && argv[1] === action);

test('origin tab shows agent name while docked and restores its exact label on undock', async t => {
  const f = fixture({ agents: ['alpha'] }); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target('alpha') })).state, 'docked');
  assert.equal(f.tabLabel(), 'alpha · in Shep');
  assert.equal((await controller.undock()).state, 'undocked');
  assert.equal(f.tabLabel(), 'Agents');
  assert.deepEqual(callsFor(f, 'tab', 'rename').map(argv => argv[3]), ['alpha · in Shep', 'Agents']);
});

test('busy placeholder remains open while the original tab label returns', async t => {
  const f = fixture({ agents: ['alpha'] }); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target('alpha') })).state, 'docked');
  f.setBusy();
  const restored = await controller.undock();
  assert.equal(restored.state, 'undocked', restored.message);
  assert.match(restored.message, /placeholder kept/);
  assert.equal(f.tabLabel(), 'Agents');
  assert.equal(f.snapshot.panes.find(pane => pane.label === 'Shell')?.tab_id, 'w2:t1');
});

test('missing origin tab gets a new tab without renaming a replacement tab', async t => {
  const f = fixture({ agents: ['alpha'] }); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target('alpha') })).state, 'docked');
  f.closeOrigin();
  const restored = await controller.undock();
  assert.equal(restored.state, 'undocked', restored.message);
  assert.equal(f.snapshot.agents[0].tab_id, 'w2:t2');
  assert.equal(f.tabLabel('w2:t2'), 'alpha');
  assert.deepEqual(callsFor(f, 'tab', 'rename').map(argv => argv[3]), ['alpha · in Shep']);
});

test('crash recovery reads marker metadata and restores the original tab label', async t => {
  const f = fixture({ agents: ['alpha'] }); const first = f.createController(); t.after(first.dispose);
  assert.equal((await first.dock({ target: f.target('alpha') })).state, 'docked');
  const restarted = f.createController(); t.after(restarted.dispose);
  const result = await restarted.recoverDock();
  assert.equal(result.state, 'recovered', result.message);
  assert.equal(f.tabLabel(), 'Agents');
});

test('crash recovery preserves a tab label changed by the user', async t => {
  const f = fixture({ agents: ['alpha'] }); const first = f.createController(); t.after(first.dispose);
  assert.equal((await first.dock({ target: f.target('alpha') })).state, 'docked');
  f.snapshot.tabs.find(tab => tab.tab_id === 'w2:t1').label = 'Pinned by user';
  const restarted = f.createController(); t.after(restarted.dispose);
  assert.equal((await restarted.recoverDock()).state, 'recovered');
  assert.equal(f.tabLabel(), 'Pinned by user');
});

test('wide switch with shared origin changes label alpha to beta then restores Agents', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target('alpha') })).state, 'docked');
  assert.equal(f.tabLabel(), 'alpha · in Shep');
  const switched = await controller.dock({ target: f.target('beta') });
  assert.equal(switched.state, 'docked', switched.message);
  assert.equal(f.tabLabel(), 'beta · in Shep');
  assert.equal((await controller.undock()).state, 'undocked');
  assert.equal(f.tabLabel(), 'Agents');
  assert.deepEqual(callsFor(f, 'tab', 'rename').map(argv => argv[3]),
    ['alpha · in Shep', 'Agents', 'beta · in Shep', 'Agents']);
});

test('tab rename failure leaves docking usable; a user-changed label is never overwritten', async t => {
  const f = fixture({ agents: ['alpha'] }); const controller = f.createController(); t.after(controller.dispose);
  f.failNextTabRename();
  const docked = await controller.dock({ target: f.target('alpha') });
  assert.equal(docked.state, 'docked');
  assert.match(docked.message, /Warning: origin tab label did not change/);
  assert.equal(f.tabLabel(), 'Agents');
  assert.equal((await controller.undock()).state, 'undocked');
  assert.equal(f.tabLabel(), 'Agents');
  assert.equal((await controller.dock({ target: f.target('alpha') })).state, 'docked');
  f.snapshot.tabs.find(tab => tab.tab_id === 'w2:t1').label = 'My custom title';
  assert.equal((await controller.undock()).state, 'undocked');
  assert.equal(f.tabLabel(), 'My custom title');
});

test('failed label restoration returns a warning after safely returning the agent', async t => {
  const f = fixture({ agents: ['alpha'] }); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target('alpha') })).state, 'docked');
  f.failNextTabRename();
  const restored = await controller.undock();
  assert.equal(restored.state, 'undocked');
  assert.match(restored.message, /Warning: origin tab label could not be restored/);
  assert.equal(f.snapshot.agents[0].tab_id, 'w2:t1');
  assert.equal(f.tabLabel(), 'alpha · in Shep');
  const renameCount = callsFor(f, 'tab', 'rename').length;
  await controller.undock();
  assert.equal(callsFor(f, 'tab', 'rename').length, renameCount);
});

test('post-rename read catches a successful no-op without retrying it', async t => {
  const f = fixture({ agents: ['alpha'] }); const controller = f.createController(); t.after(controller.dispose);
  f.nextTabRename('noop');
  const docked = await controller.dock({ target: f.target('alpha') });
  assert.equal(docked.state, 'docked');
  assert.match(docked.message, /Warning: origin tab label did not change/);
  assert.equal(f.tabLabel(), 'Agents');
  await controller.undock();
  assert.equal(callsFor(f, 'tab', 'rename').length, 1);

  assert.equal((await controller.dock({ target: f.target('alpha') })).state, 'docked');
  f.nextTabRename('noop');
  const restored = await controller.undock();
  assert.match(restored.message, /Warning: origin tab label could not be restored/);
  assert.equal(f.tabLabel(), 'alpha · in Shep');
});

test('malformed rename response is accepted only after exact tab read-back', async t => {
  const f = fixture({ agents: ['alpha'] }); const controller = f.createController(); t.after(controller.dispose);
  f.nextTabRename('malformed');
  const docked = await controller.dock({ target: f.target('alpha') });
  assert.equal(docked.state, 'docked');
  assert.equal(docked.message, 'Selected agent docked beside Shep.');
  f.nextTabRename('malformed');
  const restored = await controller.undock();
  assert.equal(restored.state, 'undocked');
  assert.doesNotMatch(restored.message, /Warning:/);
  assert.equal(f.tabLabel(), 'Agents');
});

test('wide switch replaces an exact stale prior dock label after old restore rename fails', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target('alpha') })).state, 'docked');
  f.failNextTabRename();
  const switched = await controller.dock({ target: f.target('beta') });
  assert.equal(switched.state, 'docked', switched.message);
  assert.equal(f.tabLabel(), 'beta · in Shep');
  assert.equal((await controller.undock()).state, 'undocked');
  assert.equal(f.tabLabel(), 'Agents');
});

test('marker restores true original after both prior restore and new rename fail across restart', async t => {
  const f = fixture(); const first = f.createController(); t.after(first.dispose);
  assert.equal((await first.dock({ target: f.target('alpha') })).state, 'docked');
  f.failNextTabRename();
  f.failNextTabRename();
  const switched = await first.dock({ target: f.target('beta') });
  assert.equal(switched.state, 'docked');
  assert.match(switched.message, /Warning: origin tab label did not change/);
  assert.equal(f.tabLabel(), 'alpha · in Shep');
  const restarted = f.createController(); t.after(restarted.dispose);
  assert.equal((await restarted.recoverDock()).state, 'recovered');
  assert.equal(f.tabLabel(), 'Agents');
});

test('uncertain moved dock sends one exact warning and keeps origin label across repeated calls', async t => {
  const f = fixture({ agents: ['alpha'] }); const controller = f.createController(); t.after(controller.dispose);
  f.failMove('after');
  const result = await controller.dock({ target: f.target('alpha') });
  assert.equal(result.state, 'uncertain');
  assert.equal(f.tabLabel(), 'alpha · in Shep');
  assert.deepEqual(callsFor(f, 'notification', 'show').map(argv => argv[2]),
    ["alpha is still docked in Shep's tab — don't close it"]);
  await controller.undock();
  await controller.dock({ target: f.target('alpha') });
  assert.equal(callsFor(f, 'notification', 'show').length, 1);
  assert.equal(f.tabLabel(), 'alpha · in Shep');
});

test('wide switch uncertainty warns once for each exact agent still in Shep', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target('alpha') })).state, 'docked');
  f.failMove('after');
  assert.equal((await controller.dock({ target: f.target('beta') })).state, 'uncertain');
  assert.deepEqual(callsFor(f, 'notification', 'show').map(argv => argv[2]),
    ["beta is still docked in Shep's tab — don't close it", "alpha is still docked in Shep's tab — don't close it"]);
  await controller.undock();
  assert.equal(callsFor(f, 'notification', 'show').length, 2);
});

test('unmoved uncertainty sends no dock warning; failed notification is not retried', async t => {
  const before = fixture({ agents: ['alpha'] }); const first = before.createController(); t.after(first.dispose);
  before.failMove('before');
  assert.equal((await first.dock({ target: before.target('alpha') })).state, 'uncertain');
  assert.equal(before.tabLabel(), 'Agents');
  assert.equal(callsFor(before, 'notification', 'show').length, 0);

  const after = fixture({ agents: ['alpha'] }); const second = after.createController(); t.after(second.dispose);
  after.failMove('after'); after.failNotification();
  assert.equal((await second.dock({ target: after.target('alpha') })).state, 'uncertain');
  await second.undock();
  assert.equal(callsFor(after, 'notification', 'show').length, 1);
});
