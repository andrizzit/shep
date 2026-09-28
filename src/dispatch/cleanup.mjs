// Cleanup authority comes exclusively from response-confirmed creation receipts.
// Host topology is read afresh; unknown descendants or identities preserve resources.
import { MESSAGES as DISPATCH_MESSAGES } from './contracts.mjs';

export function createCleanupOperations(deps) {
  const { assertLive, directory, invoke, trusted, fail, operation, receipts, pinned,
    locked, getControlSnapshot, fs, outcome, operationLocks, jobs, UNCERTAIN,
    errorCode, messageFor, reservations } = deps;
  async function listWorktrees({ cwd } = {}) {
    assertLive();
    const root = await directory(cwd);
    const response = (await invoke(['worktree', 'list', '--cwd', root, ...(trusted(root) ? ['--trust-repository'] : [])])).result;
    if (!Array.isArray(response?.worktrees)) fail('invalid_response');
    return structuredClone(response.worktrees);
  }

  async function removeWorktree(request = {}) {
    return operation(request, async () => {
      const entry = [...receipts.values()].find(r => r.created.worktree?.workspaceId === request.workspaceId);
      const owned = entry?.created, wt = owned?.worktree;
      if (!wt || request.path !== wt.path || request.branch !== wt.branch || request.workspaceId === pinned.context.workspaceId || typeof request.force !== 'boolean') fail('unowned_worktree');
      return locked(entry.projectKey, async () => {
        const listing = await listWorktrees({ cwd: wt.repoCwd });
        const native = listing.find(w => w.open_workspace_id === wt.workspaceId && w.path === wt.path && w.branch === wt.branch && w.is_linked_worktree === true);
        if (!native || await directory(wt.path) !== wt.path || wt.path === wt.repoCwd) fail('changed_target');
        const snapshot = await getControlSnapshot();
        const workspace = snapshot.workspaces.find(w => w.workspace_id === wt.workspaceId);
        if (!workspace || workspace.worktree?.is_linked_worktree !== true || await fs.realpath(workspace.worktree.checkout_path) !== wt.path
          || await fs.realpath(workspace.worktree.repo_root) !== wt.repoCwd) fail('changed_target');
        const tabs = snapshot.tabs.filter(t => t.workspace_id === wt.workspaceId);
        const panes = snapshot.panes.filter(p => p.workspace_id === wt.workspaceId);
        if (tabs.some(t => !owned.tabIds.includes(t.tab_id)) || panes.some(p => !owned.panes.some(r => r.paneId === p.pane_id && r.terminalId === p.terminal_id && r.tabId === p.tab_id && r.workspaceId === p.workspace_id))) {
          return outcome('failed', 'This worktree contains an unowned or replaced tab or pane. Keep it open and review Herdr.', { code: 'unowned_descendant' });
        }
        if (snapshot.agents.some(a => a.workspace_id === wt.workspaceId && ['working', 'blocked'].includes(a.agent_status))) return outcome('failed', DISPATCH_MESSAGES.worktreeWorking, { code: 'agent_busy' });
        if ([...operationLocks.entries()].some(([key, lock]) => !key.startsWith('workspace:') && lock.workspaceId === wt.workspaceId)
          || [...jobs.values()].some(job => !job.finished && job.placement?.workspaceId === wt.workspaceId)) fail('busy');
        let removalError;
        try { await invoke(['worktree', 'remove', '--workspace', wt.workspaceId, ...(request.force ? ['--force'] : []), ...(trusted(wt.repoCwd) ? ['--trust-repository'] : [])]); }
        catch (error) { removalError = error; }
        if (removalError && !UNCERTAIN.has(errorCode(removalError))) return outcome('failed', errorCode(removalError) === 'dirty_worktree_requires_force' ? 'The worktree has changes. Force removal requires a separate confirmation.' : messageFor(errorCode(removalError)), { code: errorCode(removalError) });
        try {
          const [after, current] = await Promise.all([listWorktrees({ cwd: wt.repoCwd }), getControlSnapshot()]);
          if (!after.some(w => w.path === wt.path || w.open_workspace_id === wt.workspaceId) && !current.workspaces.some(w => w.workspace_id === wt.workspaceId)
            && !current.panes.some(p => p.workspace_id === wt.workspaceId) && !current.tabs.some(t => t.workspace_id === wt.workspaceId)) {
            for (const [key, receipt] of receipts) if (receipt === entry) { receipts.delete(key); reservations.delete(key); }
            return outcome('removed', 'The worktree and its workspace were removed. The branch was kept.');
          }
        } catch { /* Unknown cleanup result is never retried. */ }
        return outcome('uncertain', 'Worktree removal could not be confirmed. Inspect Herdr before trying again.', { code: removalError ? errorCode(removalError) : 'invalid_response' });
      });
    }, true);
  }

  return { listWorktrees, removeWorktree };
}
