#!/usr/bin/env node
// Controlled stand-in for the external Herdr executable. Tests never contact Herdr.
const mode = process.env.SHEP_TEST_MODE;
const dispatcherModes = new Set(['tab-create', 'workspace-create', 'worktree-create', 'worktree-untrusted', 'worktree-remove-dirty', 'notify-fail', 'argv-echo', 'scripted']);
if (dispatcherModes.has(mode)) {
  module.exports = dispatcherMain().catch(error => {
    process.stderr.write(JSON.stringify({ id: 'fixture', error: { code: 'fixture_error', message: error.message } }));
    process.exitCode = 1;
  });
} else if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'failure') {
  process.stderr.write('PRIVATE_OUTPUT_SHOULD_NOT_LEAK');
  process.exitCode = 1;
} else if (mode === 'malformed') {
  process.stdout.write('PRIVATE_OUTPUT_SHOULD_NOT_LEAK');
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(100000));
} else if (mode === 'wrong-shape') {
  process.stdout.write(JSON.stringify({ result: { agents: [] } }));
} else {
  process.stdout.write(JSON.stringify({
    result: {
      snapshot: {
        version: '0.9.1-test',
        panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
        agents: [{
          pane_id: 'w1:p1', terminal_id: 't1', agent: 'codex', agent_status: 'working',
          name: JSON.stringify(process.argv.slice(2)),
          workspace_id: 'w1', cwd: process.env.HERDR_SOCKET_PATH || '/fixture',
        }],
        workspaces: [{ workspace_id: 'w1', label: 'Controlled CLI' }],
      },
    },
  }));
}

// Controlled scenarios are synthetic. Native Herdr 0.9.1 qualification is recorded
// in SPIKE_FACTS and the spike evidence; fixture_ errors are explicitly invented.
// Scenario v1: {snapshot?, worktreeSource?, worktreePath?, steps:[{id?, match:argv|{prefix:argv},
// times?, effect?:'default', snapshot?, result?, error?, stdout?, exitCode?,
// signalPath?, barrierPath?, barrierTimeoutMs?, delayMs?}]}.
// A step has NO default mutation unless effect:'default'; it can acknowledge,
// refuse, corrupt, delay, or hide a completed mutation deterministically.
// State v1 stores {nextId,uses,worktrees,scaffolding,snapshot}. Scaffolding is a
// synthetic typed manifest only: this fake never creates real checkouts/directories.
async function dispatcherMain() {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const args = process.argv.slice(2);
  const responseId = `cli:${args[0]}:${args[1]}`;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const flag = (name, fallback = null) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const scenarioPath = process.env.SHEP_TEST_SCENARIO;
  const scenario = scenarioPath ? JSON.parse(await fs.readFile(scenarioPath, 'utf8')) : { version: 1 };
  if (scenario.version !== 1) throw new Error('Unsupported synthetic scenario version');
  const worktreeSource = scenario.worktreeSource ?? { repo_key: '/fixture/repo/.git', repo_name: 'repo',
    repo_root: '/fixture/repo', source_checkout_path: flag('--cwd', '/fixture/repo'), source_workspace_id: null };
  const statePath = process.env.SHEP_TEST_STATE;
  const logPath = process.env.SHEP_TEST_LOG;
  const pane = (workspaceId, tabId, n, cwd) => ({ pane_id: `${workspaceId}:p${n}`, terminal_id: `fixture-terminal-${n}`,
    workspace_id: workspaceId, tab_id: tabId, cwd, foreground_cwd: cwd, focused: false, agent_status: 'unknown', revision: 0,
    scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 40 } });
  const tab = (workspaceId, n, label = 'Synthetic tab') => ({ tab_id: `${workspaceId}:t${n}`, workspace_id: workspaceId,
    number: n, label, focused: false, pane_count: 1, agent_status: 'unknown' });
  const workspace = (n, label = 'Synthetic workspace') => ({ workspace_id: `w${n}`, number: n, label,
    focused: false, pane_count: 1, tab_count: 1, active_tab_id: `w${n}:t1`, agent_status: 'unknown', worktree: null });
  const initial = () => ({ version: 1, nextId: 10, uses: {}, worktrees: [], scaffolding: [], snapshot: scenario.snapshot ?? {
    version: '0.9.1-fixture', protocol: 22, focused_pane_id: 'w1:p1', agents: [], layouts: [],
    panes: [{ ...pane('w1', 'w1:t1', 1, '/fixture/repo'), focused: true }], tabs: [tab('w1', 1)],
    workspaces: [{ ...workspace(1, 'fixture'), focused: true }],
  } });
  let state;
  let response;
  let step;
  let unlock = async () => {};
  if (statePath) {
    // Serialize only the short state read/modify/write. Delays and barriers below
    // happen after release, allowing deterministic concurrent command tests.
    const lock = statePath + '.lock';
    const deadline = Date.now() + 2500;
    for (;;) {
      try { await fs.mkdir(lock); unlock = () => fs.rmdir(lock); break; }
      catch (error) { if (error.code !== 'EEXIST' || Date.now() > deadline) throw error; await pause(5); }
    }
  }
  try {
    try { state = statePath ? JSON.parse(await fs.readFile(statePath, 'utf8')) : initial(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = initial(); }
    state.uses ??= {};
    const matches = pattern => Array.isArray(pattern) ? JSON.stringify(pattern) === JSON.stringify(args)
      : pattern && Array.isArray(pattern.prefix) && pattern.prefix.every((value, i) => args[i] === value);
    step = (scenario.steps ?? []).find((item, i) => matches(item.match) && (state.uses[item.id ?? String(i)] ?? 0) < (item.times ?? 1));
    if (step) {
      const index = scenario.steps.indexOf(step); const id = step.id ?? String(index);
      state.uses[id] = (state.uses[id] ?? 0) + 1;
    }
    if (logPath) await fs.appendFile(logPath, JSON.stringify({ args, socket: process.env.HERDR_SOCKET_PATH ?? null,
      paneId: process.env.HERDR_PANE_ID ?? null, stepId: step?.id ?? null }) + '\n');
    if (mode === 'argv-echo') response = { type: 'fixture_argv', argv: args };
    else if (!step || step.effect === 'default') response = perform(state);
    if (step?.snapshot) state.snapshot = step.snapshot;
    if (Object.hasOwn(step ?? {}, 'result')) response = step.result;
    if (statePath) {
      const next = statePath + `.${process.pid}.next`;
      await fs.writeFile(next, JSON.stringify(state), { mode: 0o600 }); await fs.rename(next, statePath);
    }
  } finally { await unlock(); }

  if (step?.signalPath) await fs.writeFile(step.signalPath, 'entered\n', { mode: 0o600 });
  if (step?.barrierPath) {
    const deadline = Date.now() + (step.barrierTimeoutMs ?? 5000);
    for (;;) {
      try { await fs.access(step.barrierPath); break; }
      catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error; await pause(5); }
    }
  }
  if (step?.delayMs) await pause(step.delayMs);
  if (step?.error) {
    process.stderr.write(JSON.stringify({ id: responseId, error: { message: 'Synthetic structured failure', ...step.error } }));
    process.exitCode = step.exitCode ?? 1;
  } else if (Object.hasOwn(step ?? {}, 'stdout')) {
    process.stdout.write(step.stdout); process.exitCode = step.exitCode ?? 0;
  } else {
    process.stdout.write(JSON.stringify({ id: responseId, result: response })); process.exitCode = step?.exitCode ?? 0;
  }

  function perform(state) {
    const snapshot = state.snapshot;
    const command = args.slice(0, 2).join(' ');
    if (command === 'api snapshot') return { type: 'session_snapshot', snapshot };
    if (command === 'pane layout') {
      const target = snapshot.panes.find(item => item.pane_id === flag('--pane'));
      if (!target) throw new Error('Unknown synthetic pane');
      return { type: 'pane_layout', layout: { workspace_id: target.workspace_id, tab_id: target.tab_id, zoomed: false,
        area: { x: 0, y: 0, width: 150, height: 50 }, focused_pane_id: target.pane_id, splits: [],
        panes: [{ pane_id: target.pane_id, focused: target.focused, rect: { x: 0, y: 0, width: 150, height: 50 } }] } };
    }
    if (['tab create', 'workspace create', 'worktree create', 'pane split'].includes(command)) {
      if (command === 'worktree create' && mode === 'worktree-untrusted' && !args.includes('--trust-repository')) {
        const root = flag('--cwd', '/fixture/repo');
        const parents = path.join(process.env.HOME ?? '/fixture/home', '.herdr', 'worktrees');
        const repository = path.basename(root);
        state.scaffolding = [{ path: path.dirname(parents), type: 'directory', entries: ['worktrees'] },
          { path: parents, type: 'directory', entries: [repository] },
          { path: path.join(parents, repository), type: 'directory', entries: [] }];
        step = { error: { code: 'worktree_create_failed',
          message: `fatal: detected dubious ownership in repository at '${root}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${root}` } };
        return;
      }
      // Observed empty-session worktree creation also opens an implicit primary
      // workspace. It is deliberately absent from the creation response/receipt.
      if (command === 'worktree create' && snapshot.workspaces.length === 0) {
        const source = worktreeSource;
        const primaryId = state.nextId++;
        const primary = workspace(primaryId, source.repo_name);
        primary.focused = true;
        primary.worktree = { checkout_path: source.repo_root, repo_key: source.repo_key,
          repo_name: source.repo_name, repo_root: source.repo_root, is_linked_worktree: false };
        const primaryTab = { ...tab(primary.workspace_id, 1, '1'), focused: true };
        const primaryPane = { ...pane(primary.workspace_id, primaryTab.tab_id, primaryId, source.repo_root), focused: true };
        snapshot.workspaces.push(primary); snapshot.tabs.push(primaryTab); snapshot.panes.push(primaryPane);
        snapshot.focused_pane_id = primaryPane.pane_id;
        snapshot.focused_tab_id = primaryTab.tab_id;
        snapshot.focused_workspace_id = primary.workspace_id;
      }
      const id = state.nextId++;
      let currentWorkspace;
      let currentTab;
      let worktree;
      if (command === 'workspace create' || command === 'worktree create') {
        currentWorkspace = workspace(id, flag('--label', 'Synthetic workspace'));
        currentTab = tab(currentWorkspace.workspace_id, 1, flag('--label', 'Synthetic tab'));
        snapshot.workspaces.push(currentWorkspace); snapshot.tabs.push(currentTab);
      } else {
        const anchor = snapshot.panes.find(item => item.pane_id === flag('--pane'));
        const workspaceId = command === 'pane split' ? anchor?.workspace_id : flag('--workspace');
        currentWorkspace = snapshot.workspaces.find(item => item.workspace_id === workspaceId);
        if (!currentWorkspace) throw new Error('Unknown synthetic workspace');
        currentTab = command === 'pane split' ? snapshot.tabs.find(item => item.tab_id === anchor.tab_id) : tab(workspaceId, id, flag('--label', 'Synthetic tab'));
        if (command !== 'pane split') { snapshot.tabs.push(currentTab); currentWorkspace.tab_count += 1; }
        else currentTab.pane_count += 1;
        currentWorkspace.pane_count += 1;
      }
      let cwd = flag('--cwd', '/fixture/repo');
      if (command === 'worktree create') {
        cwd = flag('--path', scenario.worktreePath ?? `/fixture/worktrees/worktree-${id}`);
        worktree = { path: cwd, branch: flag('--branch', `shep/fixture-${id}`), label: flag('--label', 'Synthetic worktree'),
          open_workspace_id: currentWorkspace.workspace_id, is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true };
        state.worktrees.push(worktree);
        currentWorkspace.worktree = { checkout_path: cwd, repo_key: worktreeSource.repo_key,
          repo_name: worktreeSource.repo_name, repo_root: worktreeSource.repo_root, is_linked_worktree: true };
      }
      const rootPane = pane(currentWorkspace.workspace_id, currentTab.tab_id, id, cwd);
      snapshot.panes.push(rootPane);
      if (command === 'pane split') return { type: 'pane_info', pane: rootPane };
      if (command === 'tab create') return { type: 'tab_created', tab: currentTab, root_pane: rootPane };
      return { type: command === 'worktree create' ? 'worktree_created' : 'workspace_created', workspace: currentWorkspace,
        tab: currentTab, root_pane: rootPane, ...(worktree ? { worktree } : {}) };
    }
    if (command === 'worktree list') return { type: 'worktree_list', source: worktreeSource, worktrees: state.worktrees };
    if (command === 'worktree remove') {
      const workspaceId = flag('--workspace');
      const target = state.worktrees.find(item => item.open_workspace_id === workspaceId);
      if (!target) throw new Error('Unknown synthetic worktree');
      if (mode === 'worktree-remove-dirty' && !args.includes('--force')) {
        step = { error: { code: 'dirty_worktree_requires_force',
          message: `fatal: '${target.path}' contains modified or untracked files, use --force to delete it` } };
        return;
      }
      state.worktrees = state.worktrees.filter(item => item !== target);
      snapshot.workspaces = snapshot.workspaces.filter(item => item.workspace_id !== workspaceId);
      snapshot.tabs = snapshot.tabs.filter(item => item.workspace_id !== workspaceId);
      snapshot.panes = snapshot.panes.filter(item => item.workspace_id !== workspaceId);
      snapshot.agents = snapshot.agents.filter(item => item.workspace_id !== workspaceId);
      snapshot.layouts = snapshot.layouts.filter(item => item.workspace_id !== workspaceId);
      return { type: 'worktree_removed', workspace_id: workspaceId, path: target.path, forced: args.includes('--force') };
    }
    if (command === 'agent start') {
      const target = snapshot.panes.find(item => item.pane_id === flag('--pane'));
      if (!target) throw new Error('Unknown synthetic pane');
      const agent = { ...target, name: args[2], agent: flag('--kind'), agent_status: 'idle', interactive_ready: true, launch_pending: false };
      snapshot.agents.push(agent);
      const divider = args.indexOf('--');
      return { type: 'agent_started', agent, argv: [agent.agent, ...(divider < 0 ? [] : args.slice(divider + 1))] };
    }
    if (['agent get', 'agent prompt', 'agent focus'].includes(command)) {
      const agent = snapshot.agents.find(item => item.pane_id === args[2]);
      if (!agent) throw new Error('Unknown synthetic agent');
      if (command === 'agent prompt' && agent.agent_status === 'blocked') { step = { error: { code: 'agent_blocked' } }; return; }
      if (command === 'agent prompt') agent.agent_status = 'working';
      if (command === 'agent focus') {
        snapshot.focused_pane_id = agent.pane_id;
        for (const item of [...snapshot.panes, ...snapshot.agents]) item.focused = item.pane_id === agent.pane_id;
      }
      return { type: command === 'agent prompt' ? 'agent_prompted' : 'agent_info', agent };
    }
    if (command === 'pane close') {
      const target = snapshot.panes.find(item => item.pane_id === args[2]);
      if (!target) throw new Error('Unknown synthetic pane');
      snapshot.panes = snapshot.panes.filter(item => item.pane_id !== args[2]);
      snapshot.agents = snapshot.agents.filter(item => item.pane_id !== args[2]);
      snapshot.tabs.find(item => item.tab_id === target.tab_id).pane_count -= 1;
      const parent = snapshot.workspaces.find(item => item.workspace_id === target.workspace_id);
      parent.pane_count -= 1;
      if (!snapshot.panes.some(item => item.tab_id === target.tab_id)) {
        snapshot.tabs = snapshot.tabs.filter(item => item.tab_id !== target.tab_id);
        snapshot.layouts = snapshot.layouts.filter(item => item.tab_id !== target.tab_id);
        parent.tab_count -= 1;
        if (parent.active_tab_id === target.tab_id) parent.active_tab_id = snapshot.tabs.find(item => item.workspace_id === parent.workspace_id)?.tab_id ?? '';
      }
      if (parent.pane_count === 0) snapshot.workspaces = snapshot.workspaces.filter(item => item !== parent);
      if (snapshot.focused_pane_id === target.pane_id) delete snapshot.focused_pane_id;
      if (snapshot.focused_tab_id === target.tab_id && !snapshot.tabs.some(item => item.tab_id === target.tab_id)) delete snapshot.focused_tab_id;
      if (snapshot.focused_workspace_id === target.workspace_id && parent.pane_count === 0) delete snapshot.focused_workspace_id;
      // Observed CLI envelope (the typed API pane_closed result is available
      // only when explicitly supplied by a scenario).
      return { type: 'ok' };
    }
    if (command === 'notification show') {
      if (mode === 'notify-fail') { step = { error: { code: 'fixture_notification_failed' } }; return; }
      return { type: 'notification_show', shown: true, reason: 'shown' };
    }
    throw new Error('Unsupported synthetic command: ' + command);
  }
}
