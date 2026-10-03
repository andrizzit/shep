import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/control.mjs';
import { getHerdrContext } from '../src/herdr.mjs';

const clone = value => structuredClone(value);
const flag = (argv, name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;

function fixture(width = 172) {
  const snapshot = {
    focused_pane_id: 'w1:p1',
    workspaces: [{ workspace_id: 'w1', active_tab_id: 'w1:t1' }, { workspace_id: 'w2', active_tab_id: 'w2:t1' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1' }, { tab_id: 'w2:t1', workspace_id: 'w2' }],
    panes: [
      { pane_id: 'w1:p1', terminal_id: 'shep-terminal', tab_id: 'w1:t1', workspace_id: 'w1', cwd: '/private/tmp' },
      { pane_id: 'w2:p1', terminal_id: 'agent-terminal', tab_id: 'w2:t1', workspace_id: 'w2', cwd: '/private/tmp' },
    ],
    agents: [{ pane_id: 'w2:p1', terminal_id: 'agent-terminal', tab_id: 'w2:t1', workspace_id: 'w2',
      agent: 'claude', name: 'scratch', agent_status: 'working', launch_pending: false,
      agent_session: { kind: 'id', value: 'session-a' }, process_id: 15036 }],
  };
  const calls = [];
  let serial = 3, busy = false, execReplacement = false, shellPid = 40002, startupChildren = 0;
  let emptySamples = 0, processReads = 0, replaceAfterRead = null;
  const target = { paneId: 'w2:p1', terminalId: 'agent-terminal', provider: 'claude', agentName: 'scratch', sessionId: 'session-a' };
  const f = {
    snapshot, calls, target,
    busy(value = true) { busy = value; },
    execReplacement(value = true) { execReplacement = value; },
    startupChildren(value) { startupChildren = value; },
    emptySamples(value) { emptySamples = value; },
    replaceAfterRead(value) { replaceAfterRead = value; },
    shellPid(value) { shellPid = value; },
    placeholder() { return snapshot.panes.find(pane => pane.terminal_id === 'placeholder-terminal'); },
    createController() {
      return createController({
        context: getHerdrContext({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/private/tmp/shep-c91-test.sock',
          HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1' }),
        monitor: { getSnapshot: () => ({ mode: 'live', source: { state: 'connected' } }) },
        readRaw: async () => ({ result: { snapshot: clone(snapshot) } }),
        run: async argv => {
          calls.push(clone(argv));
          const [kind, action] = argv;
          if (kind === 'pane' && action === 'layout') return { result: { layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false,
            panes: [{ pane_id: 'w1:p1', rect: { x: 0, width, height: 40 } }] } } };
          if (kind === 'pane' && action === 'get') return { result: { pane: clone(snapshot.panes.find(p => p.pane_id === argv[2])) } };
          if (kind === 'agent' && action === 'get') return { result: { agent: clone(snapshot.agents.find(a => a.pane_id === argv[2])) } };
          if (kind === 'pane' && action === 'process-info') {
            processReads++;
            const pid = busy ? 40003 : shellPid;
            const name = busy || execReplacement ? 'sleep' : 'zsh';
            const processes = [{ pid, name, argv0: name, argv: [name === 'zsh' ? '-zsh' : 'sleep'] }];
            if (emptySamples > 0) { emptySamples--; processes.length = 0; }
            if (startupChildren > 0) {
              startupChildren--;
              processes.push({ pid: 40005, name: 'path_helper', argv0: 'path_helper', argv: ['/usr/libexec/path_helper', '-s'] });
            }
            if (processReads === replaceAfterRead) snapshot.panes.find(pane => pane.pane_id === flag(argv, '--pane')).terminal_id = 'replacement-terminal';
            return { result: { process_info: { pane_id: flag(argv, '--pane'), shell_pid: shellPid,
              foreground_process_group_id: pid, foreground_processes: processes } } };
          }
          if (kind === 'pane' && action === 'split') {
            const source = snapshot.panes.find(p => p.pane_id === flag(argv, '--pane'));
            const pane = { ...source, pane_id: `w2:p${serial++}`, terminal_id: 'placeholder-terminal', label: null };
            snapshot.panes.push(pane);
            return { result: { pane: clone(pane) } };
          }
          if (kind === 'pane' && action === 'rename') {
            const pane = snapshot.panes.find(p => p.pane_id === argv[2]); pane.label = argv[3];
            return { result: { pane: clone(pane) } };
          }
          if (kind === 'pane' && action === 'move') {
            const source = snapshot.panes.find(p => p.pane_id === argv[2]);
            const tabId = flag(argv, '--tab');
            const workspaceId = tabId.split(':')[0];
            source.pane_id = `${workspaceId}:p${serial++}`;
            source.workspace_id = workspaceId; source.tab_id = tabId;
            const agent = snapshot.agents.find(a => a.terminal_id === source.terminal_id);
            agent.pane_id = source.pane_id; agent.workspace_id = workspaceId; agent.tab_id = tabId;
            return { result: { move_result: { changed: true, pane: clone(source) } } };
          }
          if (kind === 'pane' && action === 'close') {
            snapshot.panes = snapshot.panes.filter(p => p.pane_id !== argv[2]);
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

test('dock uses the target pane width and keeps both sides above their minimums', async t => {
  for (const width of [139, 140, 171, 172, 328]) {
    const f = fixture(width); const controller = f.createController(); t.after(controller.dispose);
    const result = await controller.dock({ target: f.target });
    if (width === 139) {
      assert.equal(result.code, 'dock_narrow');
      assert.deepEqual(mutations(f), []);
      continue;
    }
    assert.equal(result.state, 'docked', `${width}: ${result.message}`);
    const move = f.calls.find(argv => argv[1] === 'move');
    const ratio = Number(flag(move, '--ratio'));
    const shepWidth = Math.round(width * ratio);
    assert(shepWidth >= 60, `${width}: Shep ${shepWidth}`);
    assert(width - shepWidth >= 80, `${width}: agent ${width - shepWidth}`);
    assert(Math.abs(ratio - Math.max(0.35, 60 / width)) < 1e-9);
  }
});

test('idle placeholder closes only after a shell-only process check', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target })).state, 'docked');
  const result = await controller.undock();
  assert.equal(result.state, 'undocked');
  assert.equal(f.placeholder(), undefined);
  const closeIndex = f.calls.findIndex(argv => argv[1] === 'close');
  const processChecks = f.calls.flatMap((argv, index) => argv[1] === 'process-info' ? [index] : []);
  assert.equal(processChecks.length, 2);
  assert(closeIndex > processChecks.at(-1));
});

test('shell startup helpers settle before marker and move without changing shell identity', async t => {
  const f = fixture(); f.startupChildren(2);
  const controller = f.createController(); t.after(controller.dispose);
  const result = await controller.dock({ target: f.target });
  assert.equal(result.state, 'docked', result.message);
  assert.equal(f.calls.filter(argv => argv[1] === 'process-info').length, 3);
  assert.deepEqual(mutations(f).map(argv => argv[1]), ['split', 'rename', 'move']);
  assert.equal((await controller.undock()).state, 'undocked');
});

test('early empty foreground samples wait for the created shell before docking', async t => {
  const f = fixture(); f.emptySamples(2);
  const controller = f.createController(); t.after(controller.dispose);
  const result = await controller.dock({ target: f.target });
  assert.equal(result.state, 'docked', result.message);
  assert.equal(f.calls.filter(argv => argv[1] === 'process-info').length, 3);
  assert.deepEqual(mutations(f).map(argv => argv[1]), ['split', 'rename', 'move']);
});

test('replacement placeholder during readiness wait is never marked or moved', async t => {
  const f = fixture(); f.startupChildren(2); f.replaceAfterRead(2);
  const controller = f.createController(); t.after(controller.dispose);
  const result = await controller.dock({ target: f.target });
  assert.equal(result.state, 'uncertain');
  assert.equal(f.snapshot.panes.find(pane => pane.terminal_id === 'replacement-terminal')?.label, null);
  assert.equal(f.snapshot.agents[0].tab_id, 'w2:t1');
  assert.deepEqual(mutations(f).map(argv => argv[1]), ['split']);
});

test('shell that never settles leaves an unmarked placeholder without moving the agent', async t => {
  const f = fixture(); f.startupChildren(30);
  const controller = f.createController(); t.after(controller.dispose);
  const result = await controller.dock({ target: f.target });
  assert.equal(result.state, 'uncertain');
  assert.equal(f.placeholder()?.label, null);
  assert.equal(f.snapshot.agents[0].tab_id, 'w2:t1');
  assert.deepEqual(mutations(f).map(argv => argv[1]), ['split']);
});

test('busy placeholder stays open without marker while the agent returns alongside it', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target })).state, 'docked');
  f.busy();
  const result = await controller.undock();
  assert.equal(result.state, 'undocked', result.message);
  assert.match(result.message, /placeholder kept \(busy or unverified\)/);
  assert.equal(f.snapshot.agents[0].tab_id, 'w2:t1');
  assert.equal(f.placeholder()?.label, 'Shell');
  assert.equal(f.calls.filter(argv => argv[1] === 'close').length, 0);
  assert.equal(controller.getDockState(), null);
});

test('startup recovery also restores beside a busy shell and clears its marker', async t => {
  const f = fixture(); const first = f.createController(); t.after(first.dispose);
  assert.equal((await first.dock({ target: f.target })).state, 'docked');
  f.busy();
  const restarted = f.createController(); t.after(restarted.dispose);
  const result = await restarted.recoverDock();
  assert.equal(result.state, 'recovered', result.message);
  assert.match(result.message, /placeholder kept \(busy or unverified\)/);
  assert.equal(f.snapshot.agents[0].tab_id, 'w2:t1');
  assert.equal(f.placeholder()?.label, 'Shell');
  assert.equal(f.calls.filter(argv => argv[1] === 'close').length, 0);
});

test('replacement shell PID keeps the placeholder even when its foreground is otherwise idle', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target })).state, 'docked');
  f.shellPid(40004);
  const result = await controller.undock();
  assert.equal(result.state, 'undocked');
  assert.match(result.message, /placeholder kept \(busy or unverified\)/);
  assert.equal(f.placeholder()?.label, 'Shell');
  assert.equal(f.calls.filter(argv => argv[1] === 'close').length, 0);
});

test('exec replacement keeps the placeholder even with unchanged shell PID and foreground group', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target })).state, 'docked');
  f.execReplacement();
  const result = await controller.undock();
  assert.equal(result.state, 'undocked', result.message);
  assert.match(result.message, /placeholder kept \(busy or unverified\)/);
  assert.equal(f.snapshot.agents[0].tab_id, 'w2:t1');
  assert.equal(f.placeholder()?.label, 'Shell');
  assert.equal(f.calls.filter(argv => argv[1] === 'close').length, 0);
});

test('legacy marker without shell identity keeps an idle placeholder with an accurate notice', async t => {
  const f = fixture(); const first = f.createController(); t.after(first.dispose);
  assert.equal((await first.dock({ target: f.target })).state, 'docked');
  const placeholder = f.placeholder();
  const prefix = 'shep-dock:v1:';
  const marker = JSON.parse(Buffer.from(placeholder.label.slice(prefix.length), 'base64url').toString('utf8'));
  for (const key of ['shellPid', 'shellName', 'shellArgv0', 'shellCommand']) delete marker[key];
  placeholder.label = prefix + Buffer.from(JSON.stringify(marker)).toString('base64url');
  const restarted = f.createController(); t.after(restarted.dispose);
  const result = await restarted.recoverDock();
  assert.equal(result.state, 'recovered', result.message);
  assert.match(result.message, /placeholder kept \(busy or unverified\)/);
  assert.equal(f.snapshot.agents[0].tab_id, 'w2:t1');
  assert.equal(placeholder.label, 'Shell');
  assert.equal(f.calls.filter(argv => argv[1] === 'close').length, 0);
});

test('changed placeholder terminal refuses restore without moving or closing either pane', async t => {
  const f = fixture(); const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target })).state, 'docked');
  f.placeholder().terminal_id = 'replacement-terminal';
  const before = mutations(f).length;
  const result = await controller.undock();
  assert.equal(result.state, 'uncertain');
  assert.equal(mutations(f).length, before);
  assert.equal(f.snapshot.agents[0].tab_id, 'w1:t1');
});

test('marker scan happens once before docks with certain in-memory state', async t => {
  const f = fixture();
  f.snapshot.panes.push({ pane_id: 'w2:p9', terminal_id: 'other-terminal', tab_id: 'w2:t1', workspace_id: 'w2' });
  const controller = f.createController(); t.after(controller.dispose);
  assert.equal((await controller.dock({ target: f.target })).state, 'docked');
  const restored = await controller.undock();
  assert.equal(restored.state, 'undocked');
  const scanned = f.calls.filter(argv => argv[1] === 'get' && argv[2] === 'w2:p9').length;
  assert.equal(scanned, 1);
  assert.equal((await controller.dock({ target: restored.target })).state, 'docked');
  assert.equal(f.calls.filter(argv => argv[1] === 'get' && argv[2] === 'w2:p9').length, scanned);
});
