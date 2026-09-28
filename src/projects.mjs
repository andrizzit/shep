import * as nativeFs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { ALIAS_RULES, DEFAULT_CONFIG, LIMITS, MESSAGES, PROJECT_SOURCES, SCRUBBED_GIT_ENV } from './dispatch/contracts.mjs';
import { validateConfig } from './config.mjs';
import { safeText } from './terminal.mjs';

const copy = value => structuredClone(value);
const lower = value => value.toLowerCase();
const expand = (path, home) => path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
const within = (root, path) => { const rest = relative(root, path); return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('../')); };
const named = (project, value) => [project.name, ...project.aliases].some(name => lower(name) === lower(value));
const cleanName = value => safeText(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 64) || 'project';
const parentPart = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const problem = (message, code = 'project_unavailable') => ({ error: safeText(message), code });

function semaphore(limit) {
  let active = 0; const waiting = [];
  return async callback => {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve)); else active += 1;
    try { return await callback(); } finally { const next = waiting.shift(); if (next) next(); else active -= 1; }
  };
}

// This private default uses the same injectable Git seam as INT's Git services.
function defaultGit(getConfig, fs) {
  return async (args, { cwd, timeoutMs = LIMITS.registryGitTimeoutMs, maxBuffer = LIMITS.gitStatusBytes, signal, trustedRoot } = {}) => {
    const argv = [];
    if (trustedRoot) {
      const canonical = await fs.realpath(trustedRoot);
      if (canonical !== trustedRoot || !(getConfig().worktrees?.trustedRepos ?? []).includes(canonical)) throw new Error('Repository trust changed; reselect the project.');
      argv.push('-c', `safe.directory=${canonical}`);
    }
    const env = { ...process.env };
    for (const key of SCRUBBED_GIT_ENV) delete env[key];
    return new Promise((resolve, reject) => execFile('git', [...argv, '-C', cwd, ...args], { env, timeout: timeoutMs, maxBuffer, signal, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error || (Number.isInteger(error.code) && !error.killed)) resolve({ code: error?.code ?? 0, stdout, stderr });
      else reject(Object.assign(new Error('Git discovery timed out or could not run.'), { code: error?.code ?? 'git_transport' }));
    }));
  };
}

function worktreeRecords(text) {
  const records = []; let current;
  for (const field of text.split('\0')) {
    if (field.startsWith('worktree ')) { current = { path: field.slice(9), branch: null, workspaceId: null }; records.push(current); }
    else if (current && field.startsWith('branch ')) current.branch = field.slice(7).replace(/^refs\/heads\//, '');
    else if (field === 'bare' && current) current.bare = true;
  }
  return records;
}

function aliasStem(name, parent, budget) {
  const first = name.slice(0, Math.min(ALIAS_RULES.namePrefixCharacters, budget)).replace(/[._-]+$/g, '');
  const remaining = budget - first.length - 1;
  const last = remaining > 0 ? parent.slice(-remaining).replace(/^[._-]+|[._-]+$/g, '') : '';
  return last ? `${first}.${last}` : first;
}

function assignAliases(projects, candidates) {
  const entries = [...projects, ...candidates];
  const occupied = new Set(entries.flatMap(entry => [entry.name, ...entry.aliases]).map(lower));
  for (const entry of entries) {
    if (entries.filter(other => lower(other.name) === lower(entry.name)).length < 2) continue;
    const components = dirname(entry.root).split('/').filter(Boolean).map(parentPart).filter(Boolean);
    let generated;
    for (let depth = 1; depth <= components.length; depth += 1) {
      const alias = aliasStem(entry.name, components.slice(-depth).join('-'), 64);
      if (alias && !occupied.has(lower(alias))) { generated = alias; break; }
    }
    if (!generated) {
      const hash = createHash('sha256').update(entry.key ?? `trust:${entry.root}`).digest('hex');
      for (let length = 8; length <= 64; length += 4) {
        const stem = aliasStem(entry.name, components.join('-'), 64 - length - 1);
        const alias = length === 64 ? hash : `${stem ? `${stem}-` : ''}${hash.slice(0, length)}`;
        if (!occupied.has(lower(alias))) { generated = alias; break; }
      }
    }
    if (!generated) throw new Error('Project alias collision. Change a configured alias.');
    occupied.add(lower(generated)); entry.aliases.push(generated);
  }
}

export function createProjectRegistry({ config = DEFAULT_CONFIG, getConfig = () => config, snapshot = {}, history = [], git, fs = nativeFs, now = Date.now, homeDir = homedir() } = {}) {
  const effective = () => validateConfig(getConfig(), { homeDir }).config;
  const execute = git ?? defaultGit(effective, fs);
  const bounded = semaphore(LIMITS.gitConcurrency);
  const overlays = new Map(), expectedRoots = new Map(), selectedPaths = new Map();
  let state = { projects: [], trustRequired: [], updatedAt: null, warnings: [] }, pending = null;

  async function markerAt(path) {
    let current = path;
    while (true) {
      try { const marker = await fs.stat(join(current, '.git')); if (marker.isDirectory() || marker.isFile()) return current; }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      const parent = dirname(current); if (parent === current) return null; current = parent;
    }
  }

  async function discover(entry, currentConfig) {
    if (typeof entry.path !== 'string' || !isAbsolute(expand(entry.path, homeDir))) return problem('Project discovery requires an absolute folder.');
    let path, marker;
    try { path = await fs.realpath(expand(entry.path, homeDir)); if (!(await fs.stat(path)).isDirectory()) return problem(`Project folder is unavailable: ${entry.path}`); marker = await markerAt(path); }
    catch { return problem(`Project folder is unavailable: ${entry.path}`); }
    const expectedRoot = entry.expectedRoot ?? expectedRoots.get(entry.path);
    if (expectedRoot && marker !== expectedRoot) return problem('The repository root changed. Reselect it before dispatching.', 'project_changed');
    const opts = { cwd: path, timeoutMs: LIMITS.registryGitTimeoutMs, maxBuffer: LIMITS.gitStatusBytes };
    if (marker && currentConfig.worktrees.trustedRepos.includes(marker)) opts.trustedRoot = marker;
    let identity;
    try { identity = await bounded(() => execute(['rev-parse', '--path-format=absolute', '--git-common-dir'], opts)); }
    catch { return problem(`Could not inspect Git identity for ${path}. Retry project discovery.`); }
    if (identity.code !== 0) {
      const qualified = marker && `fatal: detected dubious ownership in repository at '${marker}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${marker}`;
      if (marker && identity.code === 128 && identity.stderr.replace(/[ \t\r\n]+$/u, '') === qualified) {
        expectedRoots.set(entry.path, marker);
        return { kind: 'trust_required', root: marker, name: entry.name ?? cleanName(basename(marker)), aliases: [...(entry.aliases ?? [])], source: entry.source, path,
          message: MESSAGES.needsTrust.replace('{root}', safeText(marker)) };
      }
      if (!marker && identity.code === 128 && /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(identity.stderr)) {
        return { key: `dir:${path}`, name: entry.name ?? cleanName(basename(path)), aliases: [...(entry.aliases ?? [])], kind: 'folder', root: path, commonDir: null,
          isolation: entry.isolation ?? 'auto', workspaceIds: [], sources: [entry.source], worktrees: [] };
      }
      return problem(`Could not inspect Git identity for ${path}. Check repository access and retry.`);
    }
    try {
      if (!identity.stdout.trim()) return problem(`Git returned no repository identity for ${path}. Retry project discovery.`);
      const commonDir = await fs.realpath(resolvePath(path, identity.stdout.trim()));
      const listing = await bounded(() => execute(['worktree', 'list', '--porcelain', '-z'], opts));
      if (listing.code !== 0) return problem(`Could not list Git checkouts for ${path}. Retry project discovery.`);
      const records = worktreeRecords(listing.stdout);
      if (!records.length || records[0].bare) return problem(`Project ${path} has no main working checkout.`);
      const root = await fs.realpath(records[0].path);
      const worktrees = [];
      for (const record of records.slice(1)) {
        try { const canonical = await fs.realpath(record.path); if (canonical !== root) worktrees.push({ path: canonical, branch: record.branch, workspaceId: null }); }
        catch { /* Prunable checkouts do not represent usable paths. */ }
      }
      if (![root, ...worktrees.map(item => item.path)].some(checkout => within(checkout, path))) return problem(`Git checkout identity changed for ${path}. Reselect the folder.`, 'project_changed');
      return { key: `git:${commonDir}`, name: entry.name ?? cleanName(basename(root)), aliases: [...(entry.aliases ?? [])], kind: 'git', root, commonDir,
        isolation: entry.isolation ?? 'auto', workspaceIds: [], sources: [entry.source], worktrees };
    } catch { return problem(`Could not resolve Git checkout paths for ${path}. Retry project discovery.`); }
  }

  async function workspaceMatches(workspace, project) {
    const meta = workspace.worktree;
    if (meta == null) return true;
    if (meta.is_linked_worktree !== false || project.kind !== 'git' || typeof meta.checkout_path !== 'string' || typeof meta.repo_root !== 'string' || typeof meta.repo_key !== 'string') return false;
    try { return await fs.realpath(meta.checkout_path) === project.root && await fs.realpath(meta.repo_root) === project.root && await fs.realpath(meta.repo_key) === project.commonDir; }
    catch { return false; }
  }

  async function build() {
    const currentConfig = effective(), warnings = [];
    const host = typeof snapshot === 'function' ? await snapshot() : snapshot;
    const records = typeof history === 'function' ? await history() : typeof history.getRecords === 'function' ? history.getRecords() : history;
    const entries = currentConfig.projects.entries.map(entry => ({ ...entry, source: 'config' }));
    entries.push(...overlays.values());
    const workspaces = host?.workspaces ?? [];
    for (const workspace of workspaces) {
      if (workspace.worktree != null && workspace.worktree.is_linked_worktree !== false) continue;
      const workspaceId = workspace.workspace_id ?? workspace.id;
      if (!workspaceId) continue;
      const panes = (host.panes ?? []).filter(pane => (pane.workspace_id ?? pane.workspaceId) === workspaceId);
      const paths = [...new Set([workspace.cwd ?? workspace.path, ...panes.map(pane => pane.foreground_cwd ?? pane.cwd)].filter(Boolean))];
      for (const path of paths) entries.push({ path, source: 'herdr', workspace });
    }
    for (const root of currentConfig.projects.roots) {
      try {
        const directory = await fs.opendir(root); let count = 0;
        try {
          while (count < LIMITS.rootEntries) {
            const child = await directory.read(); if (!child) break; count += 1;
            if (child.name.startsWith('.') || (!child.isDirectory() && !child.isSymbolicLink())) continue;
            const path = join(root, child.name);
            try { const marker = await fs.stat(join(path, '.git')); if (marker.isDirectory() || marker.isFile()) entries.push({ path, source: 'roots' }); }
            catch { /* Only immediate Git children are discovery candidates. */ }
          }
        } finally { await directory.close(); }
      } catch { warnings.push(`Could not scan project root ${safeText(root)}.`); }
    }
    for (const record of [...(records ?? [])].reverse().slice(0, LIMITS.recentProjects)) if (record?.project?.root) entries.push({ path: record.project.root, source: 'history' });
    const projects = new Map(), trust = new Map(), labels = new Map();
    // I/O runs concurrently, but source precedence is independent of completion order.
    const discoveries = await Promise.all(entries.map(entry => discover(entry, currentConfig)));
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index], found = discoveries[index];
      if (found.error) { warnings.push(found.error); continue; }
      if (found.kind === 'trust_required') {
        if (!trust.has(found.root)) trust.set(found.root, found);
        if (entry.source === 'session') overlays.set(entry.path, { ...entry, expectedRoot: found.root });
        continue;
      }
      if (entry.source === 'history' && found.kind === 'folder' && !projects.has(found.key)) continue;
      if (entry.workspace && !await workspaceMatches(entry.workspace, found)) continue;
      const existing = projects.get(found.key);
      if (!existing) projects.set(found.key, found);
      const project = existing ?? found;
      if (!project.sources.includes(entry.source)) project.sources.push(entry.source);
      for (const alias of found.aliases) if (!project.aliases.some(item => lower(item) === lower(alias))) project.aliases.push(alias);
      if (entry.workspace) {
        const workspaceId = entry.workspace.workspace_id ?? entry.workspace.id;
        if (!project.workspaceIds.includes(workspaceId)) project.workspaceIds.push(workspaceId);
        if (!labels.has(project.key)) labels.set(project.key, new Set());
        if (entry.workspace.label) labels.get(project.key).add(cleanName(entry.workspace.label));
      }
    }
    // Linked workspaces describe a known checkout, never a primary-placement target.
    for (const workspace of workspaces) {
      if (workspace.worktree?.is_linked_worktree !== true) continue;
      try {
        const path = await fs.realpath(workspace.worktree.checkout_path), common = await fs.realpath(workspace.worktree.repo_key);
        const project = projects.get(`git:${common}`), checkout = project?.worktrees.find(item => item.path === path);
        if (checkout) checkout.workspaceId = workspace.workspace_id ?? workspace.id;
      } catch { /* Unverified metadata grants no identity. */ }
    }
    const list = [...projects.values()]; const candidates = [...trust.values()].filter(candidate => !list.some(project => project.root === candidate.root));
    for (const project of list) if (project.sources[0] === 'herdr' && labels.get(project.key)?.size === 1) project.name = [...labels.get(project.key)][0];
    const recency = new Map((records ?? []).map((record, index) => [record.project?.root, index]));
    list.sort((a, b) => (recency.get(b.root) ?? -1) - (recency.get(a.root) ?? -1));
    try { assignAliases(list, candidates); } catch (error) { warnings.push(error.message); }
    for (const project of list) project.sources.sort((a, b) => PROJECT_SOURCES.indexOf(a) - PROJECT_SOURCES.indexOf(b));
    state = { projects: list, trustRequired: candidates, updatedAt: Number(now()), warnings: [...new Set(warnings)] };
    return copy(state);
  }

  async function refresh({ force = false } = {}) {
    if (pending) return pending;
    if (!force && state.updatedAt !== null && Number(now()) - state.updatedAt < LIMITS.registryFreshMs) return copy(state);
    pending = build();
    try { return await pending; } finally { pending = null; }
  }
  const all = () => [...state.projects, ...state.trustRequired];
  function resolve(name) {
    const matches = all().filter(project => named(project, name));
    if (matches.length === 1) return copy(matches[0]);
    if (matches.length > 1) return problem(`“${name}” matches ${matches.length} projects: ${matches.map(project => `${project.name} (${project.root})`).join(', ')}. Use Tab to pick one.`, 'ambiguous_project');
    return problem(MESSAGES.unknownProject.replace('{project}', name), 'unknown_project');
  }
  function containing(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) return null;
    return copy(all().flatMap(project => [project.root, ...(project.worktrees ?? []).map(worktree => worktree.path)]
      .filter(root => within(root, path)).map(root => ({ root, project }))).sort((a, b) => b.root.length - a.root.length)[0]?.project ?? null);
  }
  function search(query = '') {
    query = lower(query);
    const rank = project => Math.min(...[project.name, ...project.aliases].map(name => {
      name = lower(name); if (name.startsWith(query)) return 0; if (name.includes(query)) return 1;
      let index = 0; for (const char of name) if (char === query[index]) index += 1; return index === query.length ? 2 : Infinity;
    }));
    return copy(all().map((project, index) => ({ project, index, rank: rank(project) })).filter(item => Number.isFinite(item.rank))
      .sort((a, b) => a.rank - b.rank || a.index - b.index).map(item => item.project));
  }
  async function registerEphemeral(input) {
    if (typeof input !== 'string' || input.includes('\0') || !isAbsolute(expand(input, homeDir))) return problem('Choose an existing absolute folder.', 'invalid_folder');
    let path; try { path = await fs.realpath(expand(input, homeDir)); } catch { return problem('Choose an existing absolute folder.', 'invalid_folder'); }
    if (selectedPaths.has(input) && selectedPaths.get(input) !== path) return problem('The selected folder changed. Reselect it before dispatching.', 'project_changed');
    const old = overlays.get(path);
    const entry = { path, source: 'session', ...(old?.expectedRoot ? { expectedRoot: old.expectedRoot } : {}) };
    const found = await discover(entry, effective());
    if (found.error) return found;
    if (found.kind === 'trust_required') {
      selectedPaths.set(input, path);
      overlays.set(path, { ...entry, expectedRoot: found.root });
      await refresh({ force: true });
      return { error: found.message, code: 'needs_confirmation', trust: found };
    }
    overlays.set(path, entry); await refresh({ force: true });
    const project = state.projects.find(project => project.key === found.key);
    if (!project) return problem('Project discovery changed. Reselect the folder.', 'project_changed');
    const checkout = [project.root, ...project.worktrees.map(worktree => worktree.path)].filter(root => within(root, path)).sort((a, b) => b.length - a.length)[0];
    if (!checkout) return problem('The selected folder is outside the resolved checkout.', 'project_changed');
    return { project: copy(project), subfolder: relative(checkout, path) };
  }
  return { refresh, getSnapshot: () => copy(state), resolve, containing, search, registerEphemeral };
}
