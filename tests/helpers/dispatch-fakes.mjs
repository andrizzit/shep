// D0 test doubles. These are controllable contracts, not a scheduler implementation.
export const FIXTURE_SCHEMA_VERSION = 1;
export const PROGRESS_STAGES = Object.freeze(['queued', 'target', 'start', 'prompt']);
export const SYNTHETIC_AT = '2026-09-27T12:00:00.000Z';
const copy = value => structuredClone(value);

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function makeProject(overrides = {}) {
  return { key: 'git:/fixture/shep/.git', name: 'shep', aliases: ['sh'], kind: 'git', root: '/fixture/shep',
    commonDir: '/fixture/shep/.git', isolation: 'auto', workspaceIds: ['w1'], sources: ['config'], worktrees: [], ...copy(overrides) };
}

export function makeSnapshot(overrides = {}) {
  return { version: '0.9.1-fixture', protocol: 22, focused_pane_id: 'w1:p1',
    workspaces: [{ workspace_id: 'w1', number: 1, label: 'shep', active_tab_id: 'w1:t1', worktree: null,
      focused: true, pane_count: 1, tab_count: 1, agent_status: 'unknown' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1', focused: true, pane_count: 1, agent_status: 'unknown' }],
    panes: [{ pane_id: 'w1:p1', terminal_id: 'own-terminal', tab_id: 'w1:t1', workspace_id: 'w1', cwd: '/fixture/shep', foreground_cwd: '/fixture/shep',
      focused: true, revision: 0, agent_status: 'unknown', scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 40 } }],
    agents: [], layouts: [], ...copy(overrides) };
}

export function createFakeRegistry({ projects = [makeProject()], trustRequired = [], contextProjectKey = projects[0]?.key ?? null, contextSubfolder = '', overrides = {} } = {}) {
  let state = { projects: copy(projects), trustRequired: copy(trustRequired), contextProjectKey, contextSubfolder, updatedAt: SYNTHETIC_AT, warnings: [] };
  const listeners = new Set();
  const calls = [];
  const candidates = () => [...state.projects, ...state.trustRequired];
  return {
    calls,
    getSnapshot: () => copy(state),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async refresh(options = {}) {
      calls.push({ method: 'refresh', options: copy(options) });
      const result = await overrides.refresh?.(copy(options), copy(state));
      if (result !== undefined) state = { ...state, ...copy(result) };
      for (const fn of listeners) fn(copy(state));
      return copy(state);
    },
    async registerEphemeral(path) {
      calls.push({ method: 'registerEphemeral', path });
      const result = await overrides.registerEphemeral?.(path, copy(state));
      if (result === undefined) throw new TypeError('Provide a controlled registerEphemeral result');
      if (result.project) {
        const project = copy(result.project);
        const existing = state.projects.find(item => item.key === project.key);
        if (!existing && !project.sources.includes('session')) throw new TypeError('New ephemeral fixture project must have session source');
        if (!existing) state.projects = [...state.projects, project];
      }
      return copy(result);
    },
    resolve(name) {
      if (overrides.resolve) return copy(overrides.resolve(name));
      const matches = candidates().filter(item => [item.name, ...item.aliases].some(value => value.toLowerCase() === name.toLowerCase()));
      return copy(matches.length === 1 ? matches[0] : { error: matches.length ? 'Synthetic ambiguous project.' : `Unknown project “${name}”.` });
    },
    containing(directory) {
      if (overrides.containing) return copy(overrides.containing(directory));
      return copy(candidates().filter(item => directory === item.root || directory.startsWith(item.root + '/')).sort((a, b) => b.root.length - a.root.length)[0] ?? null);
    },
    search(query) {
      if (overrides.search) return copy(overrides.search(query));
      // Controlled substring results only; production ranking is tested separately.
      return copy(candidates().filter(item => [item.name, ...item.aliases].some(value => value.toLowerCase().includes(query.toLowerCase()))));
    },
    publish(patch) { state = { ...state, ...copy(patch) }; for (const fn of listeners) fn(copy(state)); },
    destroy() { listeners.clear(); },
  };
}

export function createFakeController({ profiles, controlSnapshot, now = () => SYNTHETIC_AT } = {}) {
  const calls = [];
  const pending = new Map();
  const listeners = new Set();
  let disposed = false;
  const profileValue = profiles ?? {
    providers: ['claude', 'codex', 'grok', 'kiro'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), available: true })),
    workspaces: [{ id: 'w1', name: 'shep', path: '/fixture/shep' }], defaultCwd: '/fixture/shep', defaultWorkspaceId: 'w1',
    ownPaneId: 'w1:p1', ownTerminalId: 'own-terminal', snapshot: makeSnapshot(),
  };
  let privateSnapshot = copy(controlSnapshot ?? profileValue.snapshot ?? makeSnapshot());
  const keyFor = request => `${request.taskId}\0${request.attemptId}`;
  function outcome(request, value) {
    for (const key of ['taskId', 'attemptId']) {
      if (value[key] !== undefined && value[key] !== request[key]) throw new TypeError('Fixture outcome cannot change its attempt identity');
    }
    return { ...copy(value), taskId: request.taskId, attemptId: request.attemptId };
  }
  function record(method, request) {
    if (disposed) throw new Error('Fixture controller is disposed');
    calls.push({ method, request: copy(request) });
  }
  function emit(request, stage, details = {}) {
    if (!PROGRESS_STAGES.includes(stage)) throw new TypeError('Unknown fixture progress stage');
    const job = pending.get(keyFor(request));
    if (!job || disposed) return false;
    if (Object.keys(details).length && stage !== 'target') throw new TypeError('Placement notice belongs to target progress');
    if (Object.keys(details).some(key => !['placement', 'message'].includes(key))) throw new TypeError('Unknown fixture progress detail');
    if (details.message !== undefined && typeof details.message !== 'string') throw new TypeError('Fixture notice must be text');
    if (details.placement !== undefined && (!details.placement || !['here', 'worktree'].includes(details.placement.mode)
      || typeof details.placement.reason !== 'string'
      || Object.keys(details.placement).some(key => !['mode', 'reason'].includes(key)))) throw new TypeError('Invalid fixture target placement');
    const event = { taskId: request.taskId, attemptId: request.attemptId, stage, at: now(), ...copy(details) };
    job.stage = stage;
    try { job.onProgress?.(copy(event)); } catch { /* UI failures cannot abort a native launch. */ }
    for (const fn of listeners) { try { fn(copy(event)); } catch { /* Independent observer. */ } }
    return true;
  }
  return {
    calls,
    getProfiles: async () => copy(profileValue),
    async getControlSnapshot() { record('getControlSnapshot', {}); return copy(privateSnapshot); },
    publishControlSnapshot(snapshot) { privateSnapshot = copy(snapshot); },
    dispatch(request, { onProgress } = {}) {
      if (!request?.taskId || !request?.attemptId) throw new TypeError('Fake dispatch requires taskId and attemptId');
      if (disposed) return Promise.resolve(outcome(request, { ok: false, state: 'failed', code: 'disposed', message: 'Fixture disposed.' }));
      if (pending.has(keyFor(request))) throw new TypeError('Duplicate fixture task/attempt identity');
      record('dispatch', request);
      const gate = deferred();
      pending.set(keyFor(request), { request: copy(request), onProgress, gate });
      emit(request, 'queued');
      return gate.promise;
    },
    emit,
    settle(request, value = { ok: true, state: 'submitted', message: 'Synthetic prompt submitted.' }) {
      const job = pending.get(keyFor(request));
      if (!job) throw new TypeError('No pending fixture attempt');
      const result = outcome(job.request, value);
      pending.delete(keyFor(request));
      job.gate.resolve(result);
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async focus(target) { record('focus', target); return { ok: true, state: 'focused', message: 'Synthetic focus.' }; },
    async closeAgent(target) { record('closeAgent', target); return { ok: true, state: 'closed', message: 'Synthetic close.' }; },
    async followUp(request) { record('followUp', request); return { ok: true, state: 'submitted', message: 'Synthetic follow-up.' }; },
    async notify(request) { if (!disposed) record('notify', request); },
    async listWorktrees(request) { record('listWorktrees', request); return []; },
    async removeWorktree(request) { record('removeWorktree', request); return { ok: true, state: 'removed', message: 'Synthetic removal.' }; },
    dismissTask(request) { record('dismissTask', request); return { ok: true, state: 'dismissed', message: 'Synthetic local dismissal.' }; },
    dispose() {
      disposed = true;
      for (const job of pending.values()) job.gate.resolve(outcome(job.request, { ok: false, state: job.stage === 'queued' ? 'failed' : 'uncertain', code: 'disposed', message: 'Fixture stopped; created resources kept.' }));
      pending.clear(); listeners.clear();
    },
  };
}
