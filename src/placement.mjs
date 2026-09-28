import { isAbsolute, relative, resolve } from 'node:path';
import { realpath as nativeRealpath } from 'node:fs/promises';
import { MESSAGES } from './dispatch/contracts.mjs';

export const isWithin = (root, path) => typeof root === 'string' && typeof path === 'string'
  && isAbsolute(root) && isAbsolute(path) && (path === root || (!relative(root, path).startsWith('..' + '/') && relative(root, path) !== '..' && !isAbsolute(relative(root, path))));
const failure = (code, message) => { throw Object.assign(new Error(message), { code }); };

// Private placement facts. Keep the public monitor normalization unchanged.
export async function preparePlacementSnapshot(snapshot, { realpath = nativeRealpath } = {}) {
  const cache = new Map();
  const canonical = path => {
    if (typeof path !== 'string' || !isAbsolute(path)) return Promise.resolve(null);
    if (!cache.has(path)) cache.set(path, Promise.resolve().then(() => realpath(path)).catch(() => null));
    return cache.get(path);
  };
  const panes = await Promise.all((snapshot.panes ?? []).map(async pane => ({ ...pane,
    canonical_cwd: await canonical(pane.foreground_cwd ?? pane.cwd) })));
  const agents = await Promise.all((snapshot.agents ?? []).map(async agent => ({ ...agent,
    canonical_cwd: await canonical(agent.foreground_cwd ?? agent.cwd ?? panes.find(p => p.pane_id === agent.pane_id && p.terminal_id === agent.terminal_id)?.canonical_cwd) })));
  const workspaces = await Promise.all((snapshot.workspaces ?? []).map(async workspace => ({ ...workspace,
    ...(workspace.worktree ? { worktree: { ...workspace.worktree,
      canonical_checkout: await canonical(workspace.worktree.checkout_path),
      canonical_root: await canonical(workspace.worktree.repo_root),
      canonical_common_dir: await canonical(workspace.worktree.repo_key) } } : {}) })));
  return { ...snapshot, panes, agents, workspaces };
}

export function resolvePlacement({ intent, project, snapshot, reservations = [] }) {
  if (!project || intent.projectKey !== project.key || intent.root !== project.root) failure('changed_project', 'The project identity changed. Refresh and select it again.');
  const linked = (project.worktrees ?? []).map(w => w.path);
  const main = cwd => isWithin(project.root, cwd) && !linked.some(path => isWithin(path, cwd));
  const busy = (snapshot.agents ?? []).find(a => ['working', 'blocked'].includes(a.agent_status) && main(a.canonical_cwd));
  const reserved = reservations.find(r => r.projectKey === project.key && main(r.cwd));
  let mode, reason;
  if (intent.mode === 'wt') { mode = 'worktree'; reason = 'Worktree requested'; }
  else if (intent.mode === 'here') { mode = 'here'; reason = 'Main checkout requested'; }
  else if (project.isolation === 'always') { mode = 'worktree'; reason = 'Project always uses worktrees'; }
  else if (project.isolation === 'never') { mode = 'here'; reason = 'Project isolation is disabled'; }
  else if (project.kind === 'git' && (busy || reserved)) {
    mode = 'worktree'; reason = busy ? `Auto → worktree: ${busy.agent || 'an agent'} is ${busy.agent_status} in ${project.name}` : 'Auto → worktree: another launch reserved this checkout';
  } else { mode = 'here'; reason = 'Auto → here: checkout is available'; }
  if (mode === 'worktree') {
    if (project.kind !== 'git') failure('worktree_needs_git', MESSAGES.worktreeNeedsGit.replace('{project}', project.name));
    return { targetKind: 'worktree', mode, reason, sourceRoot: project.root, cwd: null,
      notices: intent.subfolder ? [MESSAGES.worktreeSubfolder.replace('{subfolder}', intent.subfolder)] : [] };
  }
  const cwd = resolve(project.root, intent.subfolder || '.');
  if (!isWithin(project.root, cwd)) failure('invalid_cwd', 'The selected subfolder must remain inside its project.');
  const candidates = (snapshot.workspaces ?? []).filter(workspace => {
    const wt = workspace.worktree;
    return wt == null || (wt.is_linked_worktree === false && wt.canonical_checkout === project.root
      && wt.canonical_root === project.root && project.commonDir && wt.canonical_common_dir === project.commonDir);
  }).map(workspace => ({ workspace, panes: (snapshot.panes ?? []).filter(p => p.workspace_id === workspace.workspace_id && main(p.canonical_cwd)) }))
    .filter(item => item.panes.length).sort((a, b) => Number(b.workspace.label?.toLowerCase() === project.name.toLowerCase()) - Number(a.workspace.label?.toLowerCase() === project.name.toLowerCase())
      || b.panes.length - a.panes.length || (a.workspace.number ?? Infinity) - (b.workspace.number ?? Infinity));
  const selected = candidates[0];
  if (!selected) return { targetKind: 'workspace', mode, reason, sourceRoot: project.root, cwd, notices: [] };
  const anchorPane = selected.panes.find(p => p.tab_id === selected.workspace.active_tab_id && p.focused)
    ?? selected.panes.find(p => p.tab_id === selected.workspace.active_tab_id) ?? selected.panes[0];
  return { targetKind: intent.placementStyle === 'split' ? 'split' : 'tab', mode, reason, sourceRoot: project.root,
    cwd, workspaceId: selected.workspace.workspace_id, ...(intent.placementStyle === 'split' ? { anchorPane } : {}), notices: [] };
}
