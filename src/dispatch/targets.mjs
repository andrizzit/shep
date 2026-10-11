import { basename, isAbsolute, join, resolve } from 'node:path';
import { LIMITS, validateActualPlacement } from './contracts.mjs';
import { branchName } from './naming.mjs';
import { preparePlacementSnapshot, resolvePlacement, isWithin } from '../placement.mjs';
import { classifyOwnershipFailure } from '../gitinfo.mjs';
import { normalizeControlSnapshot } from '../herdr.mjs';
import { safeText } from '../terminal.mjs';

// Owns only the target phase. Identity/trust/receipt checks run while the
// canonical project's lock is held; this module never starts or prompts agents.
export function createTargetService(deps) {
  const { abort, active, assertLive, fresh, getControlSnapshot, invoke, directionFor, locked,
    registry, gitRead, fs, pinned, trusted, reservations, receipts, operationLocks,
    observe, randomHex, getConfig, fail, ControlError, errorCode, present } = deps;
  async function directory(path) {
    if (!present(path) || !isAbsolute(path) || Buffer.byteLength(path) > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) fail('invalid_cwd');
    try { const canonical = await fs.realpath(path); if (!(await fs.stat(canonical)).isDirectory()) fail('invalid_cwd'); return canonical; }
    catch { fail('invalid_cwd'); }
  }

  async function resolveProject(intent) {
    const project = registry?.getSnapshot()?.projects?.find(p => p.key === intent.projectKey);
    if (!project || project.root !== intent.root || await directory(project.root) !== project.root) fail('changed_project');
    if (project.kind === 'folder' && project.key !== `dir:${project.root}`) fail('changed_project');
    if (project.kind === 'git' && project.key !== `git:${project.commonDir}`) fail('changed_project');
    const cwd = await directory(resolve(project.root, intent.subfolder || '.'));
    if (!isWithin(project.root, cwd)) fail('invalid_cwd');
    return { project: structuredClone(project), cwd };
  }

  async function gitAt(root, args) {
    const response = await gitRead(args, { cwd: root, timeoutMs: LIMITS.registryGitTimeoutMs, maxBuffer: LIMITS.gitStatusBytes,
      signal: abort.signal, ...(trusted(root) ? { trustedRoot: root } : {}) });
    active();
    if (!response || !Number.isInteger(response.code) || typeof response.stdout !== 'string' || typeof response.stderr !== 'string') fail('invalid_response');
    return response;
  }
  async function gitSuccess(root, args) {
    const response = await gitAt(root, args);
    if (response.code !== 0) {
      const error = new ControlError('git_failed', response.stderr);
      error.trust = classifyOwnershipFailure({ source: 'git', stage: 'target', code: response.code, message: response.stderr, canonicalRoot: root });
      throw error;
    }
    return response.stdout;
  }

  function reconcileReservations(snapshot) {
    for (const [key, reservation] of reservations) {
      if (!reservation.final || !reservation.pane) continue;
      const agent = snapshot.agents.find(a => a.pane_id === reservation.pane.paneId && a.terminal_id === reservation.pane.terminalId);
      // An initial/unready shell or idle agent cannot resolve uncertain submission.
      if (agent && ['working', 'blocked', 'done'].includes(agent.agent_status)) reservations.delete(key);
    }
  }

  const topology = snapshot => JSON.stringify({
    workspaces: snapshot.workspaces.map(w => w.workspace_id).sort(),
    tabs: snapshot.tabs.map(t => [t.tab_id, t.workspace_id]).sort(),
    panes: snapshot.panes.map(p => [p.pane_id, p.terminal_id, p.tab_id, p.workspace_id]).sort(),
  });
  async function scaffolding(root) {
    if (!present(pinned.env.HOME) || !isAbsolute(pinned.env.HOME)) throw new ControlError('unavailable');
    const paths = [join(pinned.env.HOME, '.herdr'), join(pinned.env.HOME, '.herdr', 'worktrees'), join(pinned.env.HOME, '.herdr', 'worktrees', basename(root))];
    const result = [];
    for (const path of paths) {
      try {
        const info = await fs.lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new ControlError('unavailable');
        const entries = await fs.readdir(path);
        if (entries.length > 1000) throw new ControlError('too_large');
        result.push({ path, exists: true, entries: entries.sort() });
      } catch (error) { if (error.code !== 'ENOENT') throw error; result.push({ path, exists: false, entries: [] }); }
    }
    return result;
  }
  async function trustEvidence(root, snapshot) {
    return { topology: topology(snapshot), refs: await gitSuccess(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/']),
      worktrees: await gitSuccess(root, ['worktree', 'list', '--porcelain']), scaffold: await scaffolding(root) };
  }
  function sameEvidence(before, after) {
    if (before.topology !== after.topology || before.refs !== after.refs || before.worktrees !== after.worktrees) return false;
    return before.scaffold.every((old, index) => {
      const next = after.scaffold[index];
      if (old.exists && !next.exists) return false;
      const allowedChild = index === 0 ? 'worktrees' : index === 1 ? basename(after.scaffold[2].path) : null;
      return old.entries.every(entry => next.entries.includes(entry))
        && next.entries.every(entry => old.entries.includes(entry) || entry === allowedChild);
    });
  }

  async function createTarget(job, state) {
    const request = job.request, name = state.name;
    let plan, project, pane, created;
    try {
      const preliminary = job.legacy ? null : await resolveProject(request.placement);
      const lockKey = preliminary?.project.key ?? `legacy:${request.workspaceId ?? pinned.context.workspaceId}`;
      await locked(lockKey, async () => {
        assertLive();
        let { snapshot, own } = await fresh();
        if (!job.legacy) {
          snapshot = normalizeControlSnapshot({ result: { snapshot } });
          const current = await resolveProject(request.placement); project = current.project;
          if (project.kind === 'git') {
            const top = (await gitSuccess(project.root, ['rev-parse', '--show-toplevel'])).trim();
            const common = (await gitSuccess(project.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
            if (await directory(top) !== project.root || await fs.realpath(common) !== project.commonDir) fail('changed_project');
          }
          const prepared = await preparePlacementSnapshot(snapshot, { realpath: path => fs.realpath(path) });
          reconcileReservations(prepared);
          plan = resolvePlacement({ intent: request.placement, project, snapshot: prepared });
          if (plan.mode === 'here') plan.cwd = current.cwd;
          if (plan.targetKind === 'workspace' && [...reservations.values()].some(r => r.projectKey === project.key && r.creatingWorkspace)) fail('placement_pending');
        } else {
          const workspaceId = request.workspaceId ?? own.workspace_id;
          const workspace = snapshot.workspaces.find(w => w.workspace_id === workspaceId);
          if (!workspace) fail('workspace_missing');
          const anchor = workspaceId === own.workspace_id ? own
            : snapshot.panes.find(p => p.workspace_id === workspaceId && p.tab_id === workspace.active_tab_id && p.focused)
              ?? snapshot.panes.find(p => p.workspace_id === workspaceId && p.tab_id === workspace.active_tab_id);
          if (!anchor) fail('workspace_missing');
          const cwd = request.cwd ?? anchor.foreground_cwd ?? anchor.cwd ?? workspace.worktree?.checkout_path;
          await directory(cwd);
          plan = { targetKind: 'split', mode: 'here', reason: 'Legacy split placement', sourceRoot: cwd, cwd, workspaceId, anchorPane: anchor, notices: [] };
        }
        if (snapshot.agents.some(a => a.name === name) || [...reservations.values()].some(r => r.name === name)) fail('duplicate_name');
        reservations.set(job.key, { projectKey: project?.key ?? lockKey, cwd: plan.mode === 'here' ? plan.cwd : null, name, final: false, creatingWorkspace: plan.targetKind === 'workspace' });
        await observe(job, 'target', { placement: { mode: plan.mode, reason: safeText(plan.reason) },
          ...(plan.notices.length ? { message: safeText(plan.notices.join(' ')), noticeRequired: true } : {}) });
        active();
        let argv, baseCommit, branch, evidence;
        if (plan.targetKind === 'split') {
          const direction = await directionFor(plan.anchorPane);
          argv = ['pane', 'split', '--pane', plan.anchorPane.pane_id, '--direction', direction, '--cwd', plan.cwd, '--no-focus'];
        } else if (plan.targetKind === 'tab') argv = ['tab', 'create', '--workspace', plan.workspaceId, '--cwd', plan.cwd, '--label', safeText(request.placement.label), '--no-focus'];
        else if (plan.targetKind === 'workspace') argv = ['workspace', 'create', '--cwd', plan.cwd, '--label', project.name, '--no-focus'];
        else {
          baseCommit = (await gitSuccess(project.root, ['rev-parse', 'HEAD'])).trim();
          if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseCommit)) fail('invalid_response');
          for (let count = 0; count < LIMITS.branchSuffixAttempts; count += 1) {
            const candidate = branchName(request.inputTask, { branchPrefix: getConfig()?.worktrees?.branchPrefix ?? 'shep/', randomHex });
            const check = await gitAt(project.root, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
            if (check.code === 1) { branch = candidate; break; }
            if (check.code !== 0) {
              const error = new ControlError('git_failed', check.stderr);
              error.trust = classifyOwnershipFailure({ source: 'git', stage: 'target', code: check.code, message: check.stderr, canonicalRoot: project.root }); throw error;
            }
          }
          if (!branch) fail('branch_collision');
          // Evidence is collected before mutation; failure to capture it does not
          // stop a normal create, but forbids the exceptional trust-retry route.
          try { evidence = await trustEvidence(project.root, snapshot); } catch { active(); }
          if (job.trustRetry?.evidence) {
            if (!evidence || !sameEvidence(job.trustRetry.evidence, evidence)) fail('trust_reconciliation_failed');
          }
          argv = ['worktree', 'create', '--cwd', project.root, '--branch', branch, '--base', baseCommit,
            '--label', safeText(request.placement.label), '--no-focus', ...(trusted(project.root) ? ['--trust-repository'] : [])];
        }
        const before = await fresh();
        if (before.snapshot.agents.some(a => a.name === name)) fail('duplicate_name');
        if (plan.anchorPane && !before.snapshot.panes.some(p => p.pane_id === plan.anchorPane.pane_id && p.terminal_id === plan.anchorPane.terminal_id && p.tab_id === plan.anchorPane.tab_id && p.workspace_id === plan.workspaceId)) fail('changed_target');
        if (plan.workspaceId && !before.snapshot.workspaces.some(w => w.workspace_id === plan.workspaceId)) fail('workspace_missing');
        if (!job.legacy) {
          const validated = await resolveProject(request.placement);
          if (validated.project.key !== project.key || (plan.mode === 'here' && validated.cwd !== plan.cwd)) fail('changed_project');
        }
        if (plan.workspaceId && operationLocks.has(`workspace:${plan.workspaceId}`)) fail('busy');
        const creationLock = `create:${job.key}`;
        operationLocks.set(creationLock, { workspaceId: plan.workspaceId });
        job.mutated = true;
        let response;
        try { response = (await invoke(argv)).result; }
        catch (error) {
          const classified = plan.targetKind === 'worktree' && classifyOwnershipFailure({ source: 'herdr', stage: 'target', code: errorCode(error), message: error.privateMessage ?? error.message, canonicalRoot: project.root });
          if (classified && evidence && !job.trustRetry) {
            try {
              const after = await getControlSnapshot();
              const afterEvidence = await trustEvidence(project.root, after);
              if (sameEvidence(evidence, afterEvidence)) { error.trust = classified; job.evidence = afterEvidence; job.mutated = false; }
            } catch { active(); }
          }
          throw error;
        } finally { operationLocks.delete(creationLock); }
        const candidate = response?.pane ?? response?.root_pane;
        if (!present(candidate?.pane_id) || !present(candidate?.terminal_id) || candidate.pane_id === own.pane_id || candidate.terminal_id === own.terminal_id) fail('invalid_response');
        pane = candidate;
        if (before.snapshot.panes.some(p => p.pane_id === pane.pane_id || p.terminal_id === pane.terminal_id)) fail('invalid_response');
        if (plan.targetKind !== 'split' && before.snapshot.tabs?.some(t => t.tab_id === pane.tab_id)) fail('invalid_response');
        if (['workspace', 'worktree'].includes(plan.targetKind) && before.snapshot.workspaces.some(w => w.workspace_id === pane.workspace_id)) fail('invalid_response');
        if (![pane.workspace_id, pane.tab_id].every(present)) fail('invalid_response');
        if (plan.targetKind === 'split') {
          if (pane.workspace_id !== plan.workspaceId || pane.tab_id !== plan.anchorPane.tab_id) fail('invalid_response');
        } else if (response.tab?.tab_id !== pane.tab_id || response.tab?.workspace_id !== pane.workspace_id) fail('invalid_response');
        if (plan.targetKind === 'tab' && pane.workspace_id !== plan.workspaceId) fail('invalid_response');
        if (['workspace', 'worktree'].includes(plan.targetKind) && response.workspace?.workspace_id !== pane.workspace_id) fail('invalid_response');
        const paneReceipt = { paneId: pane.pane_id, terminalId: pane.terminal_id, tabId: pane.tab_id, workspaceId: pane.workspace_id };
        created = { tabIds: plan.targetKind === 'split' ? [] : [pane.tab_id], panes: [paneReceipt],
          ...(plan.targetKind !== 'split' ? { tabId: pane.tab_id } : {}),
          ...(['workspace', 'worktree'].includes(plan.targetKind) ? { workspaceId: pane.workspace_id } : {}) };
        let actualCwd = plan.cwd;
        if (!job.legacy && plan.mode === 'here' && await directory(pane.foreground_cwd ?? pane.cwd) !== plan.cwd) fail('invalid_response');
        if (plan.targetKind === 'worktree') {
          const wt = response.worktree;
          if (wt?.open_workspace_id !== pane.workspace_id || wt.is_linked_worktree !== true || wt.branch !== branch || !present(wt.path)) fail('invalid_response');
          actualCwd = await directory(wt.path);
          if (actualCwd === project.root || await directory(pane.foreground_cwd ?? pane.cwd) !== actualCwd) fail('invalid_response');
          const metadata = response.workspace.worktree;
          if (metadata?.is_linked_worktree !== true || await fs.realpath(metadata.checkout_path) !== actualCwd
            || await fs.realpath(metadata.repo_root) !== project.root || await fs.realpath(metadata.repo_key) !== project.commonDir) fail('invalid_response');
          created.worktree = { repoCwd: project.root, path: actualCwd, branch, workspaceId: pane.workspace_id, baseCommit };
        }
        job.placement = { mode: plan.mode, reason: safeText(plan.reason), targetKind: plan.targetKind, cwd: actualCwd,
          workspaceId: pane.workspace_id, notices: plan.notices.map(safeText), ...(baseCommit ? { baseCommit } : {}) };
        if (validateActualPlacement(job.placement).length) fail('invalid_response');
        Object.assign(reservations.get(job.key), { cwd: actualCwd, pane: paneReceipt });
        receipts.set(job.key, { created: structuredClone(created), projectKey: project?.key, taskId: job.ids.taskId });
      });
    } finally { Object.assign(state, { plan, project, pane, created }); }
  }
  return { createTarget, directory };
}
