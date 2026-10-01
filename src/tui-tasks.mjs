import { randomUUID } from 'node:crypto';
import { relative, isAbsolute } from 'node:path';
import { parseCommand, suggest } from './dispatch/grammar.mjs';
import { agentName, tabLabel } from './dispatch/naming.mjs';
import { DEFAULT_CONFIG, PROVIDER_IDS, validateArgs, validatePlacementIntent, validatePrompt } from './dispatch/contracts.mjs';
import { createTask, transition, groupTasks } from './tasks.mjs';
import { safeText } from './terminal.mjs';

export const TASK_LABELS = Object.freeze({ working: 'Working', blocked: 'Needs you', done: 'Done', idle: 'Done', unknown: 'Starting', closed: 'Closed', queued: 'Starting', starting: 'Starting', needs_input: 'Needs you', needs_confirmation: 'Needs you', uncertain: 'Needs you', failed: 'Failed' });
export const TASK_FILTERS = Object.freeze(['all', 'working', 'blocked', 'done', 'unknown', 'closed', 'failed']);
// Keep native status and launch certainty separate. Idle alone does not resolve
// a startup question or an uncertain delivery; observed work can supersede it.
export const taskPresentation = row => row.task && ['uncertain', 'needs_input', 'needs_confirmation'].includes(row.task.launch.state)
  && !['working', 'done', 'closed'].includes(row.status) && !(row.status === 'idle' && row.task.observedActivity) ? row.task.launch.state : row.status;
export const taskGroups = state => groupTasks(state.tasks || [], state.snapshot.agents || [], state.projects || [], { query: state.query, filter: 'all' })
  .map(group => {
    const rows = group.rows.filter(row => state.filter === 'all' || !state.filter || TASK_LABELS[taskPresentation(row)] === TASK_LABELS[state.filter]);
    return { ...group, rows, active: rows.some(row => !['Done', 'Failed', 'Closed'].includes(TASK_LABELS[taskPresentation(row)])) };
  }).filter(group => group.rows.length)
  .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
export const taskRows = state => taskGroups(state).flatMap(group => group.rows);

// These workflows exist in the grammar foundation, but are deliberately not
// enabled in this checkpoint. Inspect only syntax, never the literal task body.
export function deferredCommand(command, context = {}) {
  const name = /^\/([^\s]*)/.exec(command)?.[1]?.toLowerCase();
  if (name && name !== 'dispatch') return 'This checkpoint supports /dispatch only. Templates and other commands are not enabled.';
  const colonPrefix = /^\/dispatch[ \t]+([^\s:]+):/i.exec(command)?.[1];
  const prefix = colonPrefix ?? /^\/dispatch[ \t]+([^\s:]+)(?:[ \t]|$)/i.exec(command)?.[1];
  if (!prefix) return null;
  const agent = prefix.split('@')[0].split('+')[0];
  if (!colonPrefix) {
    // A deferred provider form remains explicit even if its project is unknown.
    // Ordinary dotted words, paths and unknown project-only tokens stay literal.
    const knownAgents = agent && agent.split(',').every(value => PROVIDER_IDS.includes(value.split('.')[0]));
    const project = /^@([^+]+)(?:\+[^+]*)?$/.exec(prefix)?.[1];
    const knownProject = project && [...(context.projects ?? []), ...(context.trustRequired ?? [])].some(entry =>
      [entry.name, ...(entry.aliases ?? [])].some(name => name.toLowerCase() === project.toLowerCase()));
    if (!knownAgents && !knownProject) return null;
    if (agent.includes('.') && !prefix.includes('@') && !agent.includes(',') && !prefix.endsWith('+wt')) {
      const [provider, profile, extra] = agent.split('.');
      // A filename such as codex.md is literal unless it names a configured profile.
      if (extra !== undefined || !Object.hasOwn(context.config?.agents?.[provider]?.profiles ?? {}, profile)) return null;
    }
  }
  if (agent.includes(',') || agent.includes('.')) return 'Named profiles and multiple agents are not enabled. Choose one provider, optionally @project.';
  const mode = prefix.includes('+') ? prefix.slice(prefix.indexOf('+') + 1) : null;
  if (mode !== null && colonPrefix && !['here', 'wt'].includes(mode)) return 'Choose +here for the main checkout or +wt for a worktree.';
  return null;
}

export function commandSuggestions(command, cursor, context) {
  if (!/^\/[^\s]*$/.test(command) && deferredCommand(command, context)) return [];
  command = command.replace(/^\/dispatch(?=[ \t]|$)/i, '/dispatch');
  const before = command.slice(0, cursor);
  const prefix = /^\/dispatch[ \t]+([^\s:]*)$/.exec(before)?.[1];
  const agent = prefix?.split('@')[0].split('+')[0];
  if (agent?.includes(',') || agent?.includes('.')) return [];
  if (prefix?.includes('+')) return suggest(command, cursor, context).filter(item => ['here', 'wt'].includes(item.value));
  return suggest(command, cursor, context).filter(item => !/^\/(?!dispatch$)/.test(item.label));
}

// Consent shows structure, not secrets. Transport always uses the original
// untouched argv array. Hide values conservatively, including positional args.
export function displayArgs(args) {
  return args.map(value => value.startsWith('-') ? safeText(value.split('=')[0]) + (value.includes('=') ? '=<value hidden>' : '') : '<value hidden>').join(' ');
}
export function summaryLabel(summary) {
  if (!summary) return 'Changes: not checked';
  if (summary.state !== 'available') return 'Changes: unavailable';
  return `+${summary.insertions ?? 0} −${summary.deletions ?? 0} · ${summary.changedFiles ?? 0} files${summary.commitsAhead == null ? '' : ` · ${summary.commitsAhead} commits ahead`}`;
}

export function createTaskSession({ controller, registry, getConfig = () => DEFAULT_CONFIG, reloadConfig, addTrustedRepo, summarize,
  read, change, inform, acknowledgeNotice = async () => { throw new Error('The required location notice could not be displayed.'); }, now = () => Date.now() }) {
  let alive = true, discovery = 0, topologyPending = false, lastTopology = 0;
  const noticeJobs = new Set();
  const closedTimers = new Map();
  const consent = new Set(), summaryAt = new Map(), summaryPending = new Set(), abort = new AbortController();
  let noticeQueue = Promise.resolve();
  const config = () => getConfig() || DEFAULT_CONFIG;
  const updateTask = (id, update) => change({ tasks: read().tasks.map(task => task.id === id ? update(task) : task) });
  const context = () => ({ providers: read().profiles.providers, projects: read().projects, trustRequired: read().trustRequired,
    contextProjectKey: read().draft.projectKey, contextSubfolder: read().draft.subfolder, config: config() });
  const targetSignature = task => JSON.stringify([task.attemptId, task.target?.paneId, task.target?.terminalId, task.target?.provider, task.target?.agentName, task.target?.sessionId]);
  const projectFor = key => [...read().projects, ...read().trustRequired].find(project => (project.key || project.root) === key);

  async function refresh({ force = false } = {}) {
    const generation = ++discovery;
    change({ projectsLoading: true, projectsError: null });
    if (!registry) { change({ projectsLoading: false, projectsError: 'Project discovery is unavailable. Restart Shep with its dispatcher registry.' }); return; }
    try {
      if (force && reloadConfig) await reloadConfig();
      await registry.refresh({ force });
      if (!alive || generation !== discovery) return;
      const snapshot = registry.getSnapshot();
      change({ projects: snapshot.projects || [], trustRequired: snapshot.trustRequired || [], projectsLoading: false, projectsError: null,
        projectWarnings: snapshot.warnings || [] });
      initializeProject();
    } catch (error) { if (alive && generation === discovery) change({ projectsLoading: false, projectsError: safeText(error.message || 'Project discovery failed. Use Ctrl+R to retry.') }); }
  }
  function initializeProject() {
    if (read().draft.projectKey || read().projectsLoading || !registry) return;
    const cwd = read().profiles.defaultCwd;
    const project = cwd && registry.containing(cwd);
    if (!project || project.error) return;
    const checkout = [project.root, ...(project.worktrees || []).map(item => item.path)].filter(root => cwd === root || cwd.startsWith(root + '/')).sort((a, b) => b.length - a.length)[0] || project.root;
    const subfolder = project.kind === 'trust_required' ? '' : relative(checkout, cwd);
    change({ draft: { ...read().draft, projectKey: project.key || project.root, subfolder: subfolder && !subfolder.startsWith('..') && !isAbsolute(subfolder) ? subfolder : '' } });
  }
  function discoveryBlock() {
    return read().projectsLoading ? 'Projects are loading. Your draft is preserved; submit when discovery finishes.' : read().projectsError;
  }
  function openDecision(decision) { change({ decision: { ...decision, confirm: false, offset: 0, returnView: read().view }, view: 'decision' }); }
  function parse(command) {
    const deferred = deferredCommand(command, context());
    if (deferred) return { error: deferred, code: 'deferred' };
    const result = parseCommand(command.replace(/^\/dispatch(?=[ \t]|$)/i, '/dispatch'), context());
    if (!result.error) result.command = command;
    return result;
  }
  function composeSpec() {
    const state = read(), project = projectFor(state.draft.projectKey);
    if (!project) return { error: 'Choose a project before dispatching.' };
    if (project.kind === 'trust_required') return { error: project.message, code: 'needs_confirmation', trust: structuredClone(project) };
    return { kind: 'dispatch', agents: [{ provider: state.draft.provider, profile: null }], project: structuredClone(project),
      mode: 'auto', modeIntent: 'auto', subfolder: state.draft.subfolder, template: null,
      task: state.draft.prompt, inputTask: state.draft.prompt, command: '' };
  }
  async function submit(source = 'compose', captured) {
    const blocked = discoveryBlock();
    if (blocked) { inform(blocked, 'warning'); return; }
    const command = captured?.command ?? read().command;
    const spec = captured?.spec ?? (source === 'command' ? parse(command) : composeSpec());
    if (spec.error) {
      if (spec.code === 'needs_confirmation') openDecision({ kind: 'trust', root: spec.trust.root, message: spec.trust.message,
        proceed: async () => submit(source, source === 'command' ? { command } : undefined) });
      else inform(spec.error, 'warning');
      return;
    }
    const provider = read().profiles.providers.find(item => item.id === spec.agents[0].provider);
    if (!provider?.available) { inform(`${provider?.name || spec.agents[0].provider}: ${provider?.reason || 'This provider executable is unavailable.'}`, 'warning'); return; }
    if (validatePrompt(spec.task).length) { inform('Add a task of at most 65536 UTF-8 bytes, without terminal control characters.', 'warning'); return; }
    const nameInput = source === 'command' ? '' : read().draft.name.trim();
    if (nameInput && !/^[a-z][a-z0-9_-]{0,31}$/.test(nameInput)) { inform('Names start with a-z and use a-z, 0-9, _ or -; maximum 32 characters.', 'warning'); return; }
    const args = [...(config().agents?.[provider.id]?.args || [])];
    if (validateArgs(args).length) { inform('The configured provider arguments are invalid. Check configuration and use Ctrl+R.', 'warning'); return; }
    const intent = { projectKey: spec.project.key, root: spec.project.root, mode: spec.modeIntent, subfolder: spec.subfolder,
      label: tabLabel(spec.inputTask), placementStyle: config().placement || 'tab' };
    const invalid = validatePlacementIntent(intent);
    if (invalid.length) { inform('The subfolder must be relative and stay inside the selected project.', 'warning'); return; }
    const signature = JSON.stringify([provider.id, args]);
    if (args.length && !consent.has(signature)) {
      openDecision({ kind: 'argv', provider: provider.id, args, signature, message: 'Use these configured default arguments for this provider? Values are hidden; transport stays literal.',
        proceed: () => submit(source, { command, spec }) });
      return;
    }
    const name = nameInput || agentName(spec.inputTask, provider.id, { takenNames: [...read().snapshot.agents.map(agent => agent.name), ...read().tasks.map(task => task.name)] });
    const task = createTask(spec, { id: randomUUID(), attemptId: randomUUID(), at: new Date(now()).toISOString(), name, args, placement: intent });
    change({ tasks: [...read().tasks, task], selectedTaskId: `task:${task.id}`, draft: { ...read().draft, provider: provider.id, prompt: spec.task, projectKey: spec.project.key, subfolder: spec.subfolder },
      recall: source === 'command' ? [...read().recall.filter(item => item !== command), command].slice(-100) : read().recall, recallIndex: null });
    await launch(task, source);
  }
  function cancelNotices(taskId, attemptId) {
    for (const job of noticeJobs) if (!taskId || job.taskId === taskId && job.attemptId === attemptId) job.cancel();
    const pending = read().requiredNotice;
    if (pending && (!taskId || pending.event.taskId === taskId && pending.event.attemptId === attemptId)) change({ requiredNotice: null });
  }
  function requiredProgress(event) {
    let cancel;
    const cancelled = new Promise(resolve => { cancel = resolve; });
    const record = { taskId: event.taskId, attemptId: event.attemptId, cancelled: false, cancel: () => { record.cancelled = true; cancel(); } };
    noticeJobs.add(record);
    const job = noticeQueue.catch(() => {}).then(async () => {
      if (!alive || abort.signal.aborted || record.cancelled) throw new Error('The location notice was cancelled.');
      const task = read().tasks.find(item => item.id === event.taskId && item.attemptId === event.attemptId);
      if (!task) throw new Error('The location notice no longer matches this attempt.');
      const token = `${event.taskId}:${event.attemptId}:${randomUUID()}`;
      change({ requiredNotice: { token, event: structuredClone(event), subfolder: task.subfolder } });
      try {
        await Promise.race([acknowledgeNotice(token, abort.signal), cancelled.then(() => { throw new Error('The location notice was cancelled before acknowledgement.'); })]);
        if (!alive || record.cancelled || read().requiredNotice?.token !== token) throw new Error('The location notice was not displayed for this attempt.');
      } finally { if (read().requiredNotice?.token === token) change({ requiredNotice: null }); }
    }).finally(() => noticeJobs.delete(record));
    // Keep the serial queue usable after a timeout or unmount. The caller still
    // receives the rejection; cancellation never counts as a successful flush.
    noticeQueue = job.catch(() => {});
    return job;
  }
  async function launch(task, source) {
    if (!alive) return;
    change({ busy: 'dispatch', notice: { message: 'Starting a native Herdr agent…', kind: 'info' } });
    try {
      const result = await controller.dispatch({ taskId: task.id, attemptId: task.attemptId, provider: task.agent.provider,
        prompt: task.prompt, inputTask: task.inputTask, name: task.name, args: task.args, placement: task.intent }, {
        onProgress: event => {
          if (!alive) return event.noticeRequired ? Promise.reject(new Error('Shep closed before the location notice.')) : undefined;
          const current = read().tasks.find(item => item.id === task.id);
          if (!current || current.attemptId !== event.attemptId || event.taskId !== task.id) return event.noticeRequired ? Promise.reject(new Error('The notice belongs to another attempt.')) : undefined;
          updateTask(task.id, item => ({ ...transition(item, { type: 'progress', event }), ...(event.noticeRequired ? { locationNotice: { event: structuredClone(event), subfolder: item.subfolder } } : {}) }));
          return event.noticeRequired ? requiredProgress(event) : undefined;
        },
      });
      if (!alive) return;
      cancelNotices(task.id, task.attemptId);
      updateTask(task.id, item => transition(item, { type: 'outcome', outcome: result }));
      const successful = result.ok && result.state === 'submitted';
      const target = result.paneId ? { ...result, id: result.terminalId || result.paneId, provider: task.agent.provider, name: result.agentName || task.name, status: 'unknown', workspace: { path: result.placement?.cwd || task.project.root } } : null;
      const provider = read().profiles.providers.find(item => item.id === task.agent.provider)?.name || task.agent.provider;
      const message = successful ? `${provider} started in ${task.project.name} · Enter to open`
        : `${TASK_LABELS[result.state] || 'Needs you'} · ${result.message}${result.paneId ? ` Pane: ${result.paneId}.` : ''}`;
      change({ busy: null, resultTarget: target, notice: { message: safeText(message), kind: successful ? 'success' : 'warning' },
        ...(successful || target ? { view: 'board', boardView: 'tasks', query: '', filter: 'all', selectedTaskId: `task:${task.id}`, detailOffset: 0 } : {}),
        ...(successful ? { command: '', draft: { ...read().draft, name: '', prompt: '' }, cursor: { ...read().cursor, command: 0, name: 0, prompt: 0 } } : {}) });
      if (result.state === 'needs_confirmation') openDecision({ kind: 'trust', root: task.project.root, message: result.message, taskId: task.id,
        proceed: async () => {
          const current = read().tasks.find(item => item.id === task.id);
          const next = transition(current, { type: 'confirmation', approved: true, attemptId: randomUUID(), at: new Date(now()).toISOString() });
          updateTask(task.id, () => next);
          await launch(next, source);
        } });
      observe(read().snapshot);
    } catch (error) {
      if (!alive) return;
      cancelNotices(task.id, task.attemptId);
      // No fabricated success or identity when the transport violates its seam.
      updateTask(task.id, item => ({ ...item, launch: { ...item.launch, state: 'uncertain', message: 'Launch response unavailable. Inspect Herdr before another launch.' } }));
      change({ busy: null, view: 'board', boardView: 'tasks', query: '', filter: 'all', selectedTaskId: `task:${task.id}` });
      inform(`Needs you · ${error.message || 'Launch outcome unavailable.'} Check Herdr; your prompt is preserved.`, 'warning');
    }
  }
  async function decide(approved) {
    const decision = read().decision;
    if (!decision || read().busy) return;
    if (!approved) {
      if (decision.taskId) updateTask(decision.taskId, task => transition(task, { type: 'confirmation', approved: false, at: new Date(now()).toISOString() }));
      change({ decision: null, view: decision.returnView === 'decision' ? 'board' : decision.returnView });
      inform('Cancelled. Your draft is preserved.'); return;
    }
    change({ busy: 'confirm' });
    try {
      if (decision.kind === 'trust') {
        if (!addTrustedRepo) throw new Error('Repository trust cannot be saved here. Configure this exact repository and refresh.');
        const result = await addTrustedRepo(decision.root);
        if (result?.errors?.length) throw new Error('Repository trust could not be saved. Review configuration and retry.');
        await refresh({ force: true });
        if (discoveryBlock()) throw new Error(discoveryBlock());
        const old = read().draft.projectKey;
        const project = read().projects.find(item => item.root === decision.root);
        if (old === decision.root && project) change({ draft: { ...read().draft, projectKey: project.key } });
      } else consent.add(decision.signature);
      if (!alive) return;
      change({ busy: null, decision: null, view: decision.returnView });
      await decision.proceed();
    } catch (error) { change({ busy: null }); inform(error.message || 'Confirmation failed. Your draft is preserved.', 'warning'); }
  }
  async function otherFolder(path) {
    if (!registry || read().projectsLoading) { inform(discoveryBlock() || 'Project discovery is unavailable.', 'warning'); return; }
    change({ folderLoading: true });
    try {
      const result = await registry.registerEphemeral(path);
      if (!alive) return;
      if (result.error) {
        if (result.code === 'needs_confirmation') openDecision({ kind: 'trust', root: result.trust.root, message: result.error, proceed: () => otherFolder(path) });
        else inform(result.error, 'warning');
        return;
      }
      const snapshot = registry.getSnapshot();
      change({ projects: snapshot.projects, trustRequired: snapshot.trustRequired || [], draft: { ...read().draft, projectKey: result.project.key, subfolder: result.subfolder || '' }, view: 'compose', field: 'subfolder' });
      inform('Folder selected for this session. Configuration was not changed.');
    } catch (error) { inform(error.message || 'Unable to use this folder.', 'warning'); }
    finally { change({ folderLoading: false }); }
  }
  function observe(snapshot) {
    if (!alive || snapshot.mode === 'demo' || snapshot.source.state !== 'connected' || !snapshot.updatedAt) return;
    let missing = false;
    const tasks = read().tasks.map(task => {
      if (!task.target || task.live.status === 'closed') return task;
      const agent = snapshot.agents.find(item => matchesTask(task, item));
      if (!agent) { missing = true; return task; }
      if (!['submitted', 'needs_input', 'uncertain'].includes(task.launch.state)) return task;
      const status = ['working', 'blocked', 'done', 'idle', 'unknown'].includes(agent.status) ? agent.status : 'unknown';
      const updated = transition(task, { type: 'live', status, since: new Date(now()).toISOString(), paneId: task.target.paneId, terminalId: task.target.terminalId });
      if (!updated.target.sessionId && agent.sessionId) updated.target.sessionId = agent.sessionId;
      if (['working', 'done'].includes(status)) updated.observedActivity = true;
      if (['done', 'idle'].includes(status)) void refreshSummary(updated);
      return updated;
    });
    change({ tasks });
    if (missing && snapshot.mode !== 'demo' && snapshot.source.state === 'connected' && snapshot.updatedAt && controller.getControlSnapshot && !topologyPending && now() - lastTopology >= 1000) {
      // A snapshot requested for older tasks cannot close a task that acquired
      // its target while the read was in flight. Compare the captured attempt.
      const candidates = new Map(tasks.filter(task => task.target).map(task => [task.id, targetSignature(task)]));
      topologyPending = true; lastTopology = now();
      Promise.resolve().then(() => controller.getControlSnapshot()).then(privateSnapshot => {
        if (!alive || !['panes', 'tabs', 'workspaces', 'agents'].every(key => Array.isArray(privateSnapshot?.[key])) || read().snapshot.source.state !== 'connected' || read().snapshot.mode === 'demo') return;
        change({ tasks: read().tasks.map(task => {
          if (!task.target || task.live.status === 'closed' || !['submitted', 'needs_input', 'uncertain'].includes(task.launch.state)) return task;
          if (candidates.get(task.id) !== targetSignature(task)) return task;
          if (privateSnapshot.panes.some(pane => pane.pane_id === task.target.paneId || pane.terminal_id === task.target.terminalId)) return task;
          if (read().snapshot.agents.some(agent => matchesTask(task, agent))) return task;
          return transition(task, { type: 'live', status: 'closed', since: new Date(now()).toISOString(), ...task.target });
        }) });
        scheduleClosedRows();
      }).catch(() => {}).finally(() => { topologyPending = false; });
    }
  }
  function scheduleClosedRows() {
    for (const task of read().tasks) {
      if (task.dismissed || task.live.status !== 'closed' || closedTimers.has(task.id)) continue;
      const identity = targetSignature(task);
      const timer = setTimeout(async () => {
        closedTimers.delete(task.id);
        const current = read().tasks.find(item => item.id === task.id);
        if (!alive || !current || current.dismissed || current.live.status !== 'closed' || targetSignature(current) !== identity) return;
        try {
          // Closure was already established from private topology. This only
          // releases the in-memory reservation; it never closes a native pane.
          const result = await controller.dismissTask({ taskId: task.id, attemptId: task.attemptId });
          if (alive && result.ok) updateTask(task.id, item => !item.dismissed && item.live.status === 'closed' && targetSignature(item) === identity
            ? transition(item, { type: 'dismiss', at: new Date(now()).toISOString() }) : item);
        } catch { /* Leave the row available for explicit c/C if local dismissal fails. */ }
      }, 5000);
      timer.unref?.();
      closedTimers.set(task.id, timer);
    }
  }
  const conflictingOccupant = task => read().snapshot.agents.some(agent => task.target && (agent.paneId === task.target.paneId || agent.terminalId === task.target.terminalId) && !matchesTask(task, agent));
  async function refreshSummary(task) {
    if (read().snapshot.mode === 'demo' || read().snapshot.source.state !== 'connected' || !read().snapshot.updatedAt) return;
    if (!summarize || !task.target || conflictingOccupant(task) || task.project.kind !== 'git' || !task.placement?.cwd || summaryPending.has(task.id) || now() - (summaryAt.get(task.id) ?? -Infinity) < 10000) return;
    const identity = targetSignature(task);
    const apply = summary => { if (alive) updateTask(task.id, current => targetSignature(current) === identity && current.placement?.cwd === task.placement.cwd && !conflictingOccupant(current) ? { ...current, summary } : current); };
    summaryPending.add(task.id); summaryAt.set(task.id, now());
    try {
      const summary = await summarize(task.placement.cwd, { baseCommit: task.placement.baseCommit, signal: abort.signal,
        trustedRoot: (config().worktrees?.trustedRepos || []).includes(task.project.root) ? task.project.root : undefined });
      apply(summary);
    } catch { apply({ state: 'unavailable', message: 'Change summary unavailable.', at: new Date(now()).toISOString() }); }
    finally { summaryPending.delete(task.id); }
  }
  async function dismiss(rowId, allClearable = false) {
    const candidates = read().tasks.filter(task => !task.dismissed && (allClearable ? task.live.status === 'closed' || task.launch.state === 'failed' : `task:${task.id}` === rowId));
    const openMessage = 'This agent is still open. Close it with x first, or keep it.';
    if (!candidates.length) { inform(allClearable ? 'No failed or closed tasks to clear.' : openMessage, 'warning'); return; }
    if (candidates.some(task => task.live.status !== 'closed' && task.launch.state !== 'failed')) { inform(openMessage, 'warning'); return; }
    change({ busy: 'dismiss' });
    let cleared = 0;
    try {
      for (const task of candidates) {
        const panes = task.target ? [task.target] : task.created?.panes || [];
        if (task.live.status !== 'closed' && panes.length) {
          if (read().snapshot.mode !== 'live' || read().snapshot.source.state !== 'connected') throw new Error('Reconnect to Herdr to verify that this task’s pane is closed.');
          const snapshot = await controller.getControlSnapshot();
          if (!Array.isArray(snapshot?.panes)) throw new Error('Pane closure could not be verified. Refresh before clearing this task.');
          const retained = snapshot.panes.find(pane => panes.some(target => pane.pane_id === target.paneId || pane.terminal_id === target.terminalId));
          if (retained) {
            const detected = read().snapshot.agents.some(agent => agent.paneId === retained.pane_id && agent.terminalId === retained.terminal_id);
            inform(detected ? openMessage : `Pane ${retained.pane_id} is still open, but no agent is detected. Close that pane in Herdr, then clear this task.`, 'warning'); return;
          }
        }
        if (!alive) return;
        const current = read().tasks.find(item => item.id === task.id);
        if (!current || current.dismissed || targetSignature(current) !== targetSignature(task)) continue;
        const result = await controller.dismissTask({ taskId: task.id, attemptId: task.attemptId });
        if (!alive) return;
        if (!result.ok) { inform(result.message, 'warning'); return; }
        updateTask(task.id, item => transition(item, { type: 'dismiss', at: new Date(now()).toISOString() }));
        clearTimeout(closedTimers.get(task.id)); closedTimers.delete(task.id);
        cleared += 1;
      }
      if (cleared) { change({ view: 'board' }); inform(allClearable ? `Cleared ${cleared} task${cleared === 1 ? '' : 's'}.` : 'Task cleared.'); }
    } catch (error) { inform(error.message || 'The task could not be cleared.', 'warning'); }
    finally { change({ busy: null }); }
  }
  function recordFollowUp(target, outcome) {
    const task = read().tasks.find(item => !item.dismissed && item.live.status !== 'closed' && matchesTask(item, target));
    if (task) updateTask(task.id, item => transition(item, { type: 'follow-up', outcome, at: new Date(now()).toISOString() }));
  }
  return { refresh, initializeProject, context, parse, submit, decide, otherFolder, projectFor, observe, dismiss, recordFollowUp,
    inspect: rowId => { const task = read().tasks.find(item => `task:${item.id}` === rowId); if (task) void refreshSummary(task); },
    getTasks: () => structuredClone(read().tasks),
    destroy: () => { alive = false; discovery += 1; abort.abort(); cancelNotices(); consent.clear(); for (const timer of closedTimers.values()) clearTimeout(timer); closedTimers.clear(); } };
}

export function matchesTask(task, agent) {
  return task.target && task.target.paneId === agent.paneId && task.target.terminalId === agent.terminalId
    && task.agent.provider === agent.provider && (!task.target.agentName || [agent.agentName, agent.name].includes(task.target.agentName))
    && (!task.target.sessionId || task.target.sessionId === agent.sessionId);
}
