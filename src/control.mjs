import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import * as nativeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { DEFAULT_CONFIG, DELIVERY_POLICIES, LIMITS, MESSAGES as DISPATCH_MESSAGES, PATTERNS, validateDispatchRequest, validatePrompt } from './dispatch/contracts.mjs';
import { sessionMatches, trustedSession } from './agent-identity.mjs';
import { createGitRunner } from './gitinfo.mjs';
import { normalizeControlSnapshot } from './herdr.mjs';
import { safeText } from './terminal.mjs';
import { createTargetService } from './dispatch/targets.mjs';
import { createLaunchRunner } from './dispatch/launch.mjs';
import { createCleanupOperations } from './dispatch/cleanup.mjs';
import { randomBytes } from 'node:crypto';

// Herdr 0.9.1's documented interactive kinds and canonical executables.
const PROVIDERS = [
  ['claude', 'Claude', 'claude'], ['codex', 'Codex', 'codex'], ['grok', 'Grok', 'grok'],
  ['kiro', 'Kiro', 'kiro-cli'], ['gemini', 'Gemini', 'gemini'], ['cursor', 'Cursor', 'cursor-agent'],
  ['pi', 'Pi', 'pi'], ['devin', 'Devin', 'devin'], ['agy', 'Antigravity', 'agy'],
  ['cline', 'Cline', 'cline'], ['omp', 'OMP', 'omp'], ['mastracode', 'MastraCode', 'mastracode'],
  ['opencode', 'OpenCode', 'opencode'], ['copilot', 'Copilot', 'copilot'], ['kimi', 'Kimi', 'kimi'],
  ['droid', 'Droid', 'droid'], ['amp', 'Amp', 'amp'], ['hermes', 'Hermes', 'hermes'],
  ['kilo', 'Kilo', 'kilo'], ['qodercli', 'Qoder', 'qodercli'], ['qwen', 'Qwen', 'qwen'],
  ['letta', 'Letta', 'letta'], ['maki', 'Maki', 'maki'], ['muse', 'Muse', 'muse'],
];
const KINDS = new Map(PROVIDERS.map(([id, name, executable]) => [id, { name, executable }]));
const UNCERTAIN = new Set(['timeout', 'unavailable', 'invalid_response', 'too_large', 'disposed', 'agent_start_transport_failed']);
const NEEDS_INPUT = new Set(['agent_not_ready', 'agent_blocked']);
const MESSAGES = Object.assign(Object.create(null), {
  outside_herdr: 'Agent controls require the current Herdr pane. Reopen Shep inside Herdr.',
  demo: 'Agent controls are unavailable in demo mode.',
  disconnected: 'Reconnect to Herdr before controlling an agent.',
  busy: 'Another agent action is still running. Wait for its result.',
  disposed: 'Shep has stopped. Any created agent pane was left open; no further commands will be sent.',
  invalid_provider: 'Choose a supported agent provider.',
  unavailable_provider: 'The agent executable was not found on the current PATH. Install it and reopen Shep.',
  invalid_prompt: 'Enter a nonempty prompt no larger than 64 KiB. Newlines and tabs are allowed; terminal control characters are not.',
  invalid_name: 'Agent names must start with a lowercase letter and contain at most 32 lowercase letters, digits, underscores or hyphens.',
  duplicate_name: 'That agent name is already in use. Choose another name.',
  invalid_args: 'Agent arguments must be at most 32 separate strings of 512 bytes each, without control characters.',
  changed_project: 'The project identity changed. Refresh and select it again.',
  branch_collision: 'No unused worktree branch name was found after five checks. Choose another task name.',
  placement_pending: 'An earlier workspace creation is not yet confirmed. Inspect or dismiss that task before creating another workspace.',
  unowned_worktree: 'Only a worktree created by this Shep session can be removed here.',
  untrusted_repository: 'This repository needs explicit trust confirmation before retrying.',
  trust_reconciliation_failed: 'Repository or Herdr resources changed after the trust refusal. Inspect them before launching again.',
  git_failed: 'Git could not verify this repository. Check the repository and refresh before dispatching.',
  invalid_cwd: 'Choose an existing absolute directory on this machine.',
  workspace_missing: 'The selected workspace is no longer available. Refresh and choose it again.',
  no_room: 'The target pane is too small or zoomed. Enlarge or unzoom it before dispatching.',
  invalid_target: 'Select an agent with a confirmed pane and terminal identity.',
  self_target: 'Shep cannot focus or close its own pane as an agent.',
  changed_target: 'The selected agent changed or exited. Refresh and select it again.',
  changed_status: 'The agent status changed after selection. Review its current status before closing.',
  not_found: 'Herdr was not found. Check HERDR_BIN_PATH.',
  timeout: 'Herdr did not finish the request in time.',
  unavailable: 'The Herdr connection failed.',
  invalid_response: 'Herdr returned an unexpected response. Check the running Herdr version.',
  too_large: 'The Herdr response exceeded the output limit.',
  failed: 'Herdr could not complete this action.',
});

class ControlError extends Error {
  constructor(code, privateMessage) { super(MESSAGES[code] ?? MESSAGES.failed); this.code = code; this.privateMessage = privateMessage; }
}
const present = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const fail = code => { throw new ControlError(code); };
const outcome = (state, message, details = {}) => ({ ok: ['submitted', 'focused', 'closed', 'removed', 'dismissed'].includes(state), state, message, ...details });
const errorCode = error => typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : 'failed';

function commandRunner(context) {
  return (argv, { timeoutMs = 4000, maxBuffer = 8 * 1024 * 1024, signal } = {}) => new Promise((resolve, reject) => {
    execFile(context.binary, argv, { env: context.env, encoding: 'utf8', timeout: timeoutMs, maxBuffer, killSignal: 'SIGKILL', signal }, (error, stdout, stderr) => {
      let envelope;
      try { envelope = JSON.parse(error ? stderr : stdout); } catch { /* Only structured server errors are inspected. */ }
      if (envelope?.error) return reject(new ControlError(errorCode(envelope.error), envelope.error.message));
      if (error) {
        if (signal?.aborted) return reject(new ControlError('disposed'));
        const code = error.code === 'ENOENT' ? 'not_found' : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'too_large' : error.killed || error.signal === 'SIGKILL' ? 'timeout' : 'unavailable';
        return reject(new ControlError(code));
      }
      if (!envelope?.result || typeof envelope.result !== 'object') return reject(new ControlError('invalid_response'));
      resolve(envelope);
    });
  });
}

async function hasExecutable(executable, env) {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = join(directory, executable);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return true;
    } catch { /* Continue along the pinned PATH. */ }
  }
  return false;
}

export function createController({ context, monitor, mode = 'live', delivery = 'auto', run, readRaw, config = DEFAULT_CONFIG, getConfig = () => config, registry, git, fs = nativeFs, now = () => new Date().toISOString(), randomHex = length => randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length), onNotice } = {}) {
  if (!DELIVERY_POLICIES.includes(delivery)) throw new TypeError('Dispatch delivery must be auto or type.');
  const pinned = {
    binary: context?.binary ?? context?.env?.HERDR_BIN_PATH ?? 'herdr',
    env: { ...context?.env },
    context: { ...context?.context },
  };
  const transport = run ?? commandRunner(pinned);
  const abort = new AbortController();
  let disposed = false;
  const active = () => { if (disposed) fail('disposed'); };
  const invoke = async (argv, options = {}) => {
    active();
    if (hasMutation(argv)) assertLive();
    const response = await transport(argv, { ...options, signal: abort.signal });
    active();
    return response;
  };
  const read = readRaw ?? (() => invoke(['api', 'snapshot']));
  let ownTerminalId = null;
  const gitRead = git ?? createGitRunner({ env: pinned.env, getConfig, fs });
  const jobs = new Map(), taskAttempts = new Map(), reservations = new Map(), receipts = new Map();
  const projectLocks = new Map(), operationLocks = new Map(), queue = [];
  let launches = 0, notificationFailed = false;
  const timestamp = () => new Date(now()).toISOString();
  const messageFor = code => code === 'prelaunch_notice_failed' ? DISPATCH_MESSAGES.prelaunchNoticeFailed : MESSAGES[code] ?? 'The action could not be completed safely. Refresh and inspect Herdr.';
  const trusted = root => (getConfig()?.worktrees?.trustedRepos ?? []).includes(root);
  const jobKey = request => JSON.stringify([request.taskId, request.attemptId]);
  const hasMutation = argv => ['create', 'split', 'start', 'prompt', 'focus', 'close', 'remove', 'rename'].includes(argv[1]);


  function assertContext() {
    active();
    const { paneId, tabId, workspaceId } = pinned.context;
    if (pinned.env.HERDR_ENV !== '1' || !present(pinned.env.HERDR_SOCKET_PATH)
      || !isAbsolute(pinned.env.HERDR_SOCKET_PATH) || ![paneId, tabId, workspaceId].every(present)
      || pinned.env.HERDR_PANE_ID !== paneId || pinned.env.HERDR_TAB_ID !== tabId || pinned.env.HERDR_WORKSPACE_ID !== workspaceId) fail('outside_herdr');
  }

  function assertLive() {
    assertContext();
    if (mode !== 'live' || monitor?.getSnapshot()?.mode === 'demo') fail('demo');
    if (monitor?.getSnapshot()?.source?.state !== 'connected') fail('disconnected');
  }

  async function fresh() {
    assertContext();
    const raw = await read({ signal: abort.signal });
    active();
    const snapshot = raw?.result?.snapshot;
    if (!snapshot || !['agents', 'panes', 'workspaces'].every(key => Array.isArray(snapshot[key]))) fail('invalid_response');
    const own = snapshot.panes.find(p => p?.pane_id === pinned.context.paneId && p.tab_id === pinned.context.tabId && p.workspace_id === pinned.context.workspaceId);
    if (!own || !present(own.terminal_id) || (ownTerminalId && own.terminal_id !== ownTerminalId)) fail('outside_herdr');
    ownTerminalId ??= own.terminal_id;
    return { snapshot, own };
  }

  async function profiles(snapshot, own) {
    const providers = await Promise.all(PROVIDERS.map(async ([id, name, executable]) => {
      const available = await hasExecutable(executable, pinned.env);
      return { id, name, available, reason: available ? null : `${executable} is not on the current PATH` };
    }));
    const workspaces = snapshot.workspaces.filter(w => present(w?.workspace_id)).map(w => {
      const pane = snapshot.panes.find(p => p.workspace_id === w.workspace_id && p.tab_id === w.active_tab_id) ?? snapshot.panes.find(p => p.workspace_id === w.workspace_id);
      return { id: w.workspace_id, name: w.label || w.workspace_id, path: pane?.foreground_cwd ?? pane?.cwd ?? w.worktree?.checkout_path ?? null };
    });
    return { providers, workspaces, ownPaneId: own.pane_id, ownTerminalId: own.terminal_id, defaultWorkspaceId: own.workspace_id, defaultCwd: own.foreground_cwd ?? own.cwd ?? workspaces.find(w => w.id === own.workspace_id)?.path ?? null };
  }

  async function getProfiles() {
    const { snapshot, own } = await fresh();
    return { ...await profiles(snapshot, own), snapshot: structuredClone(snapshot) };
  }

  const sameStartupTarget = (target, captured) => captured && target?.paneId === captured.paneId && target?.terminalId === captured.terminalId
    && target?.provider === captured.provider && (target?.agentName ?? target?.name) === captured.agentName;
  async function operation(target, action, workspace = false, startupFocus = false) {
    if (!workspace && operationLocks.has(`focus:${target?.paneId}`)) return outcome('failed', MESSAGES.busy, { code: 'busy' });
    const ordinaryKey = `${workspace ? 'workspace' : 'pane'}:${workspace ? target?.workspaceId : target?.paneId}`;
    const pendingStart = startupFocus && sameStartupTarget(target, operationLocks.get(ordinaryKey)?.startupTarget);
    const key = pendingStart ? `focus:${target.paneId}` : ordinaryKey;
    if (operationLocks.has(key)) return outcome('failed', MESSAGES.busy, { code: 'busy' });
    const lock = { workspaceId: workspace ? target?.workspaceId : null };
    operationLocks.set(key, lock);
    try {
      assertLive();
      const initial = await fresh();
      lock.workspaceId ??= initial.snapshot.panes.find(p => p.pane_id === target?.paneId)?.workspace_id;
      if ([...operationLocks.entries()].some(([otherKey, other]) => otherKey !== key && other.workspaceId === lock.workspaceId && (workspace || otherKey.startsWith('workspace:')))) fail('busy');
      return await action();
    } catch (error) { const code = errorCode(error); return outcome('failed', messageFor(code), { code }); }
    finally { operationLocks.delete(key); }
  }

  async function getControlSnapshot() {
    const { snapshot } = await fresh();
    return normalizeControlSnapshot({ result: { snapshot } });
  }

  function checkTarget(target, own) {
    if (!target || !present(target.paneId) || !present(target.terminalId)) fail('invalid_target');
    if (target.paneId === own.pane_id || target.terminalId === own.terminal_id) fail('self_target');
  }

  function compareAgent(target, agent, checkStatus = false, exactName = false) {
    const managedName = value => typeof value === 'string' && value.length ? value : null;
    if (!agent || agent.pane_id !== target.paneId || agent.terminal_id !== target.terminalId
      || (target.provider && agent.agent !== target.provider)
      || (target.agentName != null && agent.name !== target.agentName)
      || (exactName && managedName(agent.name) !== managedName(target.agentName))
      || !sessionMatches(target.provider ?? agent.agent, target.sessionId, agent.agent_session?.kind === 'id' ? agent.agent_session.value : undefined, true)) fail('changed_target');
    if (checkStatus && (!present(target.status) || agent.agent_status !== target.status)) fail('changed_status');
  }

  async function checkedAgent(target, checkStatus = false, exactName = false) {
    const { snapshot, own } = await fresh();
    checkTarget(target, own);
    const pane = snapshot.panes.find(p => p.pane_id === target.paneId);
    if (!pane || pane.terminal_id !== target.terminalId) fail('changed_target');
    const agent = snapshot.agents.find(a => a.pane_id === target.paneId);
    compareAgent(target, agent, checkStatus, exactName);
    // This second read narrows the race against an agent replacement after confirmation.
    const current = (await invoke(['agent', 'get', target.paneId])).result?.agent;
    compareAgent(target, current, checkStatus, exactName);
    return { snapshot, agent: current };
  }

  async function directionFor(pane) {
    const layout = (await invoke(['pane', 'layout', '--pane', pane.pane_id])).result?.layout;
    const rect = layout?.panes?.find(p => p.pane_id === pane.pane_id)?.rect;
    if (layout?.workspace_id !== pane.workspace_id || layout?.tab_id !== pane.tab_id || layout?.zoomed
      || !Number.isFinite(rect?.width) || !Number.isFinite(rect?.height)) fail('no_room');
    if (rect.width >= 100 && rect.width >= rect.height * 2) return 'right';
    if (rect.height >= 24) return 'down';
    if (rect.width >= 100) return 'right';
    fail('no_room');
  }

  // Queue waiting never holds a project lock. Active launches serialize only their
  // target stage per canonical project; startup/prompt can proceed concurrently.
  function pump() {
    const limit = Math.max(1, Math.min(4, getConfig()?.concurrency?.maxLaunches ?? 3));
    while (!disposed && launches < limit && queue.length) {
      const job = queue.shift(); launches += 1;
      launch(job).then(job.resolve, error => job.resolve(outcome('failed', messageFor(errorCode(error)), { ...job.ids, code: errorCode(error), stage: 'target' })))
        .finally(() => { launches -= 1; job.finished = true; pump(); });
    }
  }

  function observe(job, stage, details = {}) {
    job.stage = stage === 'queued' ? 'target' : stage;
    const event = { ...job.ids, stage, at: timestamp(), ...details };
    if (!details.noticeRequired) {
      try { Promise.resolve(job.onProgress?.(event)).catch(() => {}); } catch { /* Observers do not control launches. */ }
      return Promise.resolve();
    }
    if (typeof job.onProgress !== 'function') return Promise.reject(new ControlError('prelaunch_notice_failed'));
    return new Promise((resolveNotice, reject) => {
      let done = false;
      const finish = error => { if (done) return; done = true; clearTimeout(timer); abort.signal.removeEventListener('abort', cancel); error ? reject(error) : resolveNotice(); };
      const cancel = () => finish(new ControlError('disposed'));
      const timer = setTimeout(() => finish(new ControlError('prelaunch_notice_failed')), LIMITS.prelaunchNoticeTimeoutMs);
      abort.signal.addEventListener('abort', cancel, { once: true });
      if (abort.signal.aborted) return cancel();
      try { Promise.resolve(job.onProgress(event)).then(() => finish(), () => finish(new ControlError('prelaunch_notice_failed'))); }
      catch { finish(new ControlError('prelaunch_notice_failed')); }
    });
  }

  async function locked(key, action) {
    const previous = projectLocks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    projectLocks.set(key, tail);
    try { await previous; active(); return await action(); }
    finally { release(); if (projectLocks.get(key) === tail) projectLocks.delete(key); }
  }

  function dispatch(request = {}, { onProgress } = {}) {
    const legacy = !Object.hasOwn(request, 'placement');
    const ids = { taskId: request.taskId ?? (legacy ? `legacy-${randomHex(8)}` : ''), attemptId: request.attemptId ?? (legacy ? `attempt-${randomHex(8)}` : '') };
    const captured = structuredClone({ ...request, ...ids });
    const key = jobKey(captured);
    if (jobs.has(key)) return jobs.get(key).promise;
    let resolveJob;
    const promise = new Promise(resolve => { resolveJob = resolve; });
    const job = { request: captured, ids, key, onProgress, promise, resolve: resolveJob, legacy, stage: 'target', finished: false, mutated: false };
    const previous = taskAttempts.get(ids.taskId);
    try {
      assertLive();
      const invalid = validateDispatchRequest(captured);
      if (invalid.length) fail(invalid[0].code);
      if (previous && (!previous.finished || previous.result?.state !== 'needs_confirmation' || previous.retried)) fail('busy');
      if (previous) {
        const root = previous.trustRoot;
        if (!root || !trusted(root) || root !== captured.placement?.root) fail('untrusted_repository');
        previous.retried = true; job.trustRetry = previous;
      }
    } catch (error) { return Promise.resolve(outcome('failed', messageFor(errorCode(error)), { ...ids, code: errorCode(error), stage: 'target' })); }
    jobs.set(key, job); taskAttempts.set(ids.taskId, job);
    void observe(job, 'queued'); queue.push(job); pump();
    return promise;
  }

  async function focus(target) {
    return operation(target, async () => {
      const initial = await fresh();
      checkTarget(target, initial.own);
      if (!initial.snapshot.panes.some(p => p.pane_id === target.paneId && p.terminal_id === target.terminalId)) fail('changed_target');
      let command = ['agent', 'focus', target.paneId];
      if (!initial.snapshot.agents.some(a => a.pane_id === target.paneId)) {
        const pending = operationLocks.get(`pane:${target.paneId}`);
        const created = !trustedSession(target.provider, target.sessionId) && sameStartupTarget(target, pending?.startupTarget) ? receipts.get(pending.taskKey)?.created : null;
        const receipt = created?.panes.find(pane => pane.paneId === target.paneId && pane.terminalId === target.terminalId);
        const panes = receipt && initial.snapshot.panes.filter(pane => pane.tab_id === receipt.tabId);
        if (!receipt || !created.tabIds.includes(receipt.tabId) || panes.length !== 1
          || panes[0].pane_id !== receipt.paneId || panes[0].terminal_id !== receipt.terminalId || panes[0].workspace_id !== receipt.workspaceId
          || !initial.snapshot.tabs?.some(tab => tab.tab_id === receipt.tabId && tab.workspace_id === receipt.workspaceId)) {
          return outcome('needs_input', 'This pane has no detected agent yet. Select it directly in Herdr to review startup.', { code: 'agent_not_ready', paneId: target.paneId, terminalId: target.terminalId });
        }
        command = ['tab', 'focus', receipt.tabId];
      } else await checkedAgent(target);
      try {
        await invoke(command);
        const { snapshot } = await fresh();
        const pane = snapshot.panes.find(p => p.pane_id === target.paneId && p.terminal_id === target.terminalId);
        if (!pane || !(pane.focused || snapshot.focused_pane_id === target.paneId)) fail('invalid_response');
        return outcome('focused', 'Focused the selected agent pane.', { paneId: target.paneId, terminalId: target.terminalId });
      } catch (error) {
        return outcome('uncertain', 'Focus could not be confirmed. Check Herdr; Shep will not repeat the action automatically.', { code: errorCode(error), paneId: target.paneId, terminalId: target.terminalId });
      }
    }, false, true);
  }

  async function closeAgent(target) {
    return operation(target, async () => {
      await checkedAgent(target, true);
      let commandError;
      try { await invoke(['pane', 'close', target.paneId]); } catch (error) { commandError = error; }
      try {
        const { snapshot } = await fresh();
        if (!snapshot.panes.some(p => p.pane_id === target.paneId || p.terminal_id === target.terminalId)) {
          return outcome('closed', 'The selected agent pane is closed.', { paneId: target.paneId, terminalId: target.terminalId });
        }
      } catch (error) { commandError ??= error; }
      const code = commandError ? errorCode(commandError) : 'invalid_response';
      return outcome(commandError && !UNCERTAIN.has(code) ? 'failed' : 'uncertain', 'The pane closure could not be confirmed. Refresh and inspect Herdr before trying again.', { code, paneId: target.paneId, terminalId: target.terminalId });
    });
  }

  async function followUp({ target, text } = {}) {
    return operation(target, async () => {
      if (validatePrompt(text).length) fail('invalid_prompt');
      const { agent } = await checkedAgent(target);
      if (agent.agent_status === 'blocked') return outcome('needs_input', DISPATCH_MESSAGES.blockedFollowUp, { code: 'agent_blocked', paneId: target.paneId, terminalId: target.terminalId });
      try {
        const response = await invoke(['agent', 'prompt', target.paneId, text], { timeoutMs: LIMITS.followUpTimeoutMs });
        compareAgent(target, response.result?.agent);
        return outcome('submitted', 'Follow-up submitted.', { paneId: target.paneId, terminalId: target.terminalId });
      } catch (error) {
        const code = errorCode(error);
        return outcome(code === 'agent_blocked' ? 'needs_input' : 'uncertain', code === 'agent_blocked' ? DISPATCH_MESSAGES.blockedFollowUp : 'Follow-up delivery could not be confirmed. Inspect the agent before sending it again.', { code, paneId: target.paneId, terminalId: target.terminalId });
      }
    });
  }

  async function rename({ target, name } = {}) {
    const captured = target && { ...target, agentName: Object.hasOwn(target, 'agentName') ? target.agentName : target.name ?? null };
    return operation(captured, async () => {
      if (typeof name !== 'string' || !PATTERNS.agentName.test(name)) fail('invalid_name');
      if (!present(captured?.provider)) fail('invalid_target');
      const current = await checkedAgent(captured, false, true);
      if (current.agent.launch_pending === true || current.snapshot.agents.find(agent => agent.pane_id === captured.paneId)?.launch_pending === true) fail('busy');
      const renamed = { ...captured, agentName: name };
      try {
        const response = await invoke(['agent', 'rename', captured.paneId, name]);
        compareAgent(renamed, response.result?.agent, false, true);
        await checkedAgent(renamed, false, true);
        return outcome('submitted', 'Agent renamed.', { paneId: captured.paneId, terminalId: captured.terminalId, agentName: name });
      } catch (error) {
        return outcome('uncertain', 'Rename could not be confirmed. Check the pane; Shep will not repeat it automatically.', { code: errorCode(error), paneId: captured.paneId, terminalId: captured.terminalId });
      }
    });
  }

  async function notify({ title, body, sound = 'none' } = {}) {
    try {
      assertLive();
      if (!present(title) || !['none', 'done', 'request'].includes(sound)) fail('invalid_request');
      await invoke(['notification', 'show', safeText(title), ...(body !== undefined ? ['--body', safeText(body)] : []), '--sound', sound]);
    } catch {
      if (!notificationFailed && !disposed) {
        notificationFailed = true;
        try { Promise.resolve(onNotice?.('Herdr notifications could not be delivered. Check the task board for status.')).catch(() => {}); } catch { /* Optional notice. */ }
      }
    }
  }

  function dismissTask(request) {
    const key = jobKey(request ?? {}), job = jobs.get(key);
    if (!job || !job.finished) return outcome('failed', MESSAGES.busy, { code: 'busy' });
    reservations.delete(key);
    return outcome('dismissed', 'The local reservation was released. Created resources were kept.');
  }

  function dispose() {
    disposed = true;
    abort.abort();
    for (const job of queue.splice(0)) {
      job.finished = true;
      job.result = outcome('failed', MESSAGES.disposed, { ...job.ids, stage: 'target', code: 'disposed' });
      job.resolve(job.result);
    }
  }

  const targetService = createTargetService({ abort, active, assertLive, fresh, getControlSnapshot, invoke, directionFor, locked,
    registry, gitRead, fs, pinned, trusted, reservations, receipts, operationLocks, observe, randomHex, getConfig,
    fail, ControlError, errorCode, present });
  const launch = createLaunchRunner({ assertLive, hasExecutable, KINDS, pinned, fail, randomHex, delivery,
    ...targetService, observe, fresh, operationLocks, operation, invoke, compareAgent, checkedAgent, outcome,
    reservations, errorCode, trusted, NEEDS_INPUT, UNCERTAIN, messageFor });
  const { listWorktrees, removeWorktree } = createCleanupOperations({ assertLive, directory: targetService.directory,
    invoke, trusted, fail, operation, receipts, pinned, locked, getControlSnapshot, fs, outcome,
    operationLocks, jobs, UNCERTAIN, errorCode, messageFor, reservations });
  return { getProfiles, getControlSnapshot, dispatch, focus, closeAgent, followUp, rename, notify, listWorktrees, removeWorktree, dismissTask, dispose };
}
