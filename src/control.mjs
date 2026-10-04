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
const DOCK_MARKER = 'shep-dock:v1:';
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'nu', 'elvish', 'xonsh']);
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
  dock_pending: 'The selected agent is still starting. Wait until it is ready before docking.',
  dock_marker: 'A previous dock needs recovery. Restart Shep or inspect the marked pane in Herdr.',
  dock_narrow: 'Docking needs at least 60 columns for Shep and 80 for the agent. Enlarge Shep’s pane first.',
  dock_missing: 'The docked agent or its placeholder changed. Inspect Herdr before trying again.',
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
const outcome = (state, message, details = {}) => ({ ok: ['submitted', 'focused', 'closed', 'removed', 'dismissed', 'docked', 'undocked', 'recovered'].includes(state), state, message, ...details });
const errorCode = error => typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : 'failed';

function parseDockMarker(label) {
  if (typeof label !== 'string' || !label.startsWith(DOCK_MARKER)) return null;
  try {
    const value = JSON.parse(Buffer.from(label.slice(DOCK_MARKER.length), 'base64url').toString('utf8'));
    if (value?.version !== 1 || !['ownTerminalId', 'agentTerminalId', 'provider', 'originTabId', 'originWorkspaceId'].every(key => present(value[key]))
      || (value.shellPid !== undefined && (!Number.isSafeInteger(value.shellPid) || value.shellPid <= 0))
      || ['shellName', 'shellArgv0', 'shellCommand'].some(key => value[key] !== undefined && !present(value[key]))
      || (value.originTabLabel !== undefined && value.originTabLabel !== null && !present(value.originTabLabel))
      || (value.dockedTabLabel !== undefined && value.dockedTabLabel !== null && !present(value.dockedTabLabel))
      || (value.previousDockedTabLabel !== undefined && value.previousDockedTabLabel !== null && !present(value.previousDockedTabLabel))
      || !(value.agentName === null || present(value.agentName)) || !(value.sessionId === null || present(value.sessionId))) return null;
    return value;
  } catch { return null; }
}

function dockLabel(value) {
  return DOCK_MARKER + Buffer.from(JSON.stringify({ version: 1, ...value })).toString('base64url');
}

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
    const { allowDisconnected = false, ...transportOptions } = options;
    active();
    if (hasMutation(argv)) {
      if (allowDisconnected) {
        assertContext();
        if (mode !== 'live' || monitor?.getSnapshot()?.mode === 'demo') fail('demo');
      } else assertLive();
    }
    const response = await transport(argv, { ...transportOptions, signal: abort.signal });
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
  const hasMutation = argv => ['create', 'split', 'start', 'prompt', 'focus', 'close', 'remove', 'rename', 'move', 'swap'].includes(argv[1]);
  let dockState = null, dockBusy = false, dockMarkersChecked = false;
  const uncertainDockNotified = new Set();
  const tabRenameAttempted = new Set();
  const tabRestoreAttempted = new Set();


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
    if (dockState?.target.terminalId === target?.terminalId) return outcome('failed', 'Restore the docked agent before closing it.', { code: 'dock_marker' });
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

  const dockFailure = (error, details = {}) => outcome('failed', messageFor(errorCode(error)), { code: errorCode(error), ...details });
  const uncertainDock = async (message, error, details = {}, states = []) => {
    await warnUncertainDock(states);
    return outcome('uncertain', message, { code: errorCode(error), ...details });
  };
  const copyDockState = () => dockState ? structuredClone({ target: dockState.target, origin: dockState.origin,
    placeholder: dockState.placeholder, phase: dockState.phase }) : null;

  async function dockOperation(action, { requireLive = true } = {}) {
    if (dockBusy) return outcome('failed', MESSAGES.busy, { code: 'busy' });
    dockBusy = true;
    const reserved = new Set();
    const reserve = (...workspaceIds) => {
      for (const workspaceId of new Set(workspaceIds)) {
        if (!present(workspaceId) || reserved.has(workspaceId)) continue;
        if ([...operationLocks.entries()].some(([key, lock]) => !reserved.has(lock.workspaceId)
          && (lock.workspaceId === workspaceId || key === `workspace:${workspaceId}`))) fail('busy');
        operationLocks.set(`workspace:${workspaceId}`, { workspaceId });
        reserved.add(workspaceId);
      }
    };
    try {
      if (requireLive) assertLive();
      else {
        assertContext();
        if (mode !== 'live' || monitor?.getSnapshot()?.mode === 'demo') fail('demo');
      }
      return await action(reserve);
    }
    catch (error) { return dockFailure(error); }
    finally { for (const id of reserved) operationLocks.delete(`workspace:${id}`); dockBusy = false; }
  }

  async function paneGet(paneId) {
    const pane = (await invoke(['pane', 'get', paneId])).result?.pane;
    if (!pane || pane.pane_id !== paneId) fail('invalid_response');
    return pane;
  }

  async function tabGet(tabId) {
    const tab = (await invoke(['tab', 'get', tabId])).result?.tab;
    if (!tab || tab.tab_id !== tabId) fail('invalid_response');
    return tab;
  }

  async function originTabLabel(source, target, agent, switchFrom) {
    try {
      const tab = await tabGet(source.tab_id);
      if (tab.workspace_id !== source.workspace_id || !present(tab.label) || tab.label.length > 512) return null;
      const name = safeText(target.agentName || agent.name || KINDS.get(target.provider)?.name || target.provider);
      if (!present(name) || name.length > 128) return null;
      const docked = `${name} · in Shep`;
      const previous = switchFrom?.tabLabel;
      const inherited = previous?.tabId === source.tab_id && previous.workspaceId === source.workspace_id
        && tab.label === previous.docked;
      const original = inherited ? previous.original : tab.label;
      return { tabId: source.tab_id, workspaceId: source.workspace_id, original, docked,
        previousDocked: inherited ? previous.docked : null };
    } catch { return null; }
  }

  async function renameOriginTab(state) {
    const label = state?.tabLabel;
    if (!label) return 'unavailable';
    try {
      const tab = await tabGet(label.tabId);
      if (tab.workspace_id !== label.workspaceId || ![label.original, label.docked,
        ...(present(label.previousDocked) ? [label.previousDocked] : [])].includes(tab.label)) return 'changed';
      if (tab.label === label.docked) return 'renamed';
      if (tabRenameAttempted.has(state.marker)) return 'failed';
      tabRenameAttempted.add(state.marker);
      try { await invoke(['tab', 'rename', label.tabId, label.docked], { allowDisconnected: true }); }
      catch { /* A transport error may still mean the rename applied. Read once. */ }
      try {
        const after = await tabGet(label.tabId);
        return after.workspace_id === label.workspaceId && after.label === label.docked ? 'renamed' : 'failed';
      } catch { return 'failed'; }
    } catch { return 'failed'; }
  }

  async function restoreOriginTab(state) {
    const label = state?.tabLabel;
    if (!label || label.original === label.docked && !present(label.previousDocked)) return 'unchanged';
    try {
      const tab = await tabGet(label.tabId);
      if (tab.workspace_id !== label.workspaceId) return 'changed';
      if (tab.label === label.original) return 'unchanged';
      if (![label.docked, ...(present(label.previousDocked) ? [label.previousDocked] : [])].includes(tab.label)) return 'changed';
      if (tabRestoreAttempted.has(state.marker)) return 'failed';
      tabRestoreAttempted.add(state.marker);
      try { await invoke(['tab', 'rename', label.tabId, label.original], { allowDisconnected: true }); }
      catch { /* A transport error may still mean the rename applied. Read once. */ }
      try {
        const after = await tabGet(label.tabId);
        return after.workspace_id === label.workspaceId && after.label === label.original ? 'restored' : 'failed';
      } catch { return 'failed'; }
    } catch (error) { return errorCode(error) === 'tab_not_found' ? 'missing' : 'failed'; }
  }

  const restoredTabMessage = (message, status) => status === 'failed'
    ? `${message} Warning: origin tab label could not be restored.` : message;
  function clearDockLatches(state) {
    uncertainDockNotified.delete(state.target.terminalId);
    tabRenameAttempted.delete(state.marker);
    tabRestoreAttempted.delete(state.marker);
  }

  async function warnUncertainDock(states) {
    if (!states?.length) return;
    try {
      const { snapshot, own } = await fresh();
      for (const state of states) {
        const target = state?.target;
        if (!target?.terminalId) continue;
        const pane = snapshot.panes.find(item => item.terminal_id === target.terminalId
          && item.tab_id === own.tab_id && item.workspace_id === own.workspace_id && item.pane_id !== own.pane_id);
        if (!pane) continue;
        const currentTarget = { ...target, paneId: pane.pane_id };
        let agent;
        try {
          agent = snapshot.agents.find(item => item.pane_id === pane.pane_id);
          compareAgent(currentTarget, agent, false, true);
          compareAgent(currentTarget, (await invoke(['agent', 'get', pane.pane_id])).result?.agent, false, true);
        } catch { continue; }
        await renameOriginTab(state);
        if (uncertainDockNotified.has(target.terminalId)) continue;
        uncertainDockNotified.add(target.terminalId);
        const name = safeText(target.agentName || agent.name || KINDS.get(target.provider)?.name || target.provider || 'Agent');
        try { await invoke(['notification', 'show', `${name} is still docked in Shep's tab — don't close it`, '--sound', 'none']); }
        catch { /* The warning is best effort and must not retry a possibly delivered notification. */ }
      }
    } catch { /* The existing TUI and stderr uncertainty notices remain available. */ }
  }

  async function placeholderProcess(paneId) {
    const info = (await invoke(['pane', 'process-info', '--pane', paneId])).result?.process_info;
    if (!info || info.pane_id !== paneId || !Array.isArray(info.foreground_processes)) fail('invalid_response');
    return info;
  }

  const executableName = value => typeof value === 'string' ? value.replace(/^-/, '').split('/').at(-1) : null;
  function createdShell(info) {
    const process = info.foreground_processes.find(item => item?.pid === info.shell_pid);
    const shell = { shellPid: info.shell_pid, shellName: process?.name,
      shellArgv0: process?.argv0, shellCommand: process?.argv?.[0] };
    const name = executableName(shell.shellName);
    const expected = executableName(pinned.env.SHELL);
    if (!Number.isSafeInteger(shell.shellPid) || shell.shellPid <= 0 || !name
      || name !== executableName(shell.shellArgv0) || name !== executableName(shell.shellCommand)
      || (expected ? name !== expected : !SHELL_NAMES.has(name))) fail('invalid_response');
    return shell;
  }

  function shellOnly(info, shell) {
    const process = info.foreground_processes[0];
    return Number.isSafeInteger(shell?.shellPid) && shell.shellPid > 0
      && ['shellName', 'shellArgv0', 'shellCommand'].every(key => present(shell[key]))
      && info.shell_pid === shell.shellPid && info.foreground_process_group_id === shell.shellPid
      && info.foreground_processes.length === 1 && process?.pid === shell.shellPid
      && process.name === shell.shellName && process.argv0 === shell.shellArgv0
      && process.argv?.[0] === shell.shellCommand;
  }

  async function readyDockShell(placeholder, source) {
    let shell = null, shellPid = null;
    for (let attempt = 0; attempt < 21; attempt++) {
      const pane = await paneGet(placeholder.pane_id);
      if (pane.terminal_id !== placeholder.terminal_id || pane.tab_id !== source.tab_id
        || pane.workspace_id !== source.workspace_id || present(pane.label)
        || present(pane.agent) || pane.launch_pending === true) fail('dock_missing');
      const info = await placeholderProcess(placeholder.pane_id);
      if (Number.isSafeInteger(info.shell_pid) && info.shell_pid > 0) {
        if (shellPid !== null && shellPid !== info.shell_pid) fail('invalid_response');
        shellPid = info.shell_pid;
      } else if (shellPid !== null || info.foreground_processes.length) fail('invalid_response');
      if (info.foreground_processes.length && info.foreground_process_group_id !== shellPid) fail('invalid_response');
      const process = info.foreground_processes.find(item => item?.pid === shellPid);
      if (process) {
        if (!shell) shell = createdShell(info);
        else if (process.name !== shell.shellName || process.argv0 !== shell.shellArgv0
          || process.argv?.[0] !== shell.shellCommand) fail('invalid_response');
      }
      if (shell && shellOnly(info, shell)) return shell;
      if (attempt < 20) await new Promise(resolve => setTimeout(resolve, 100));
    }
    fail('timeout');
  }

  async function checkedPlaceholder(state, snapshot) {
    const pane = snapshot.panes.find(item => item.pane_id === state.placeholder.paneId
      && item.terminal_id === state.placeholder.terminalId);
    if (!pane || snapshot.agents.some(agent => agent.pane_id === pane.pane_id || agent.terminal_id === pane.terminal_id)) fail('dock_missing');
    const current = await paneGet(pane.pane_id);
    if (current.terminal_id !== state.placeholder.terminalId || current.label !== state.marker
      || current.workspace_id !== state.origin.workspaceId || present(current.agent) || current.launch_pending === true) fail('dock_missing');
    state.placeholder.paneId = pane.pane_id;
    return pane;
  }

  async function closeDockPlaceholder(state) {
    const { snapshot } = await fresh();
    const pane = await checkedPlaceholder(state, snapshot);
    const info = await placeholderProcess(pane.pane_id);
    if (!shellOnly(info, state.placeholder)) {
      await invoke(['pane', 'rename', pane.pane_id, 'Shell'], { allowDisconnected: true });
      const afterRename = await paneGet(pane.pane_id);
      if (afterRename.terminal_id !== state.placeholder.terminalId || afterRename.label !== 'Shell') fail('dock_missing');
      return false;
    }
    await invoke(['pane', 'close', pane.pane_id], { allowDisconnected: true });
    const after = await fresh();
    if (after.snapshot.panes.some(item => item.terminal_id === state.placeholder.terminalId)) fail('invalid_response');
    return true;
  }

  async function dockMarkers(snapshot) {
    const found = [];
    for (const candidate of snapshot.panes) {
      const pane = await paneGet(candidate.pane_id);
      if (typeof pane.label === 'string' && pane.label.startsWith(DOCK_MARKER)) found.push({ pane, marker: parseDockMarker(pane.label) });
    }
    return found;
  }

  async function movedAgent(target, terminalId, workspaceId, tabId) {
    const { snapshot, own } = await fresh();
    const matches = snapshot.panes.filter(pane => pane.terminal_id === terminalId);
    if (matches.length !== 1) fail('dock_missing');
    const pane = matches[0];
    if (pane.workspace_id !== workspaceId || (tabId && pane.tab_id !== tabId) || pane.pane_id === own.pane_id) fail('dock_missing');
    const updated = { ...target, paneId: pane.pane_id, terminalId };
    compareAgent(updated, snapshot.agents.find(agent => agent.pane_id === pane.pane_id), false, true);
    compareAgent(updated, (await invoke(['agent', 'get', pane.pane_id])).result?.agent, false, true);
    return { snapshot, pane, target: updated, own };
  }

  async function dockCore(target, reserve, switchFrom = null) {
    if (!present(target?.provider)) fail('invalid_target');
    const { snapshot, own } = await fresh();
    reserve(own.workspace_id);
    checkTarget(target, own);
    const source = snapshot.panes.find(pane => pane.pane_id === target.paneId && pane.terminal_id === target.terminalId);
    if (!source) fail('changed_target');
    reserve(source.workspace_id);
    if (snapshot.panes.some(pane => pane.pane_id === target.paneId && String(pane.label ?? '').startsWith(DOCK_MARKER))) fail('invalid_target');
    if (!dockMarkersChecked) {
      const markers = await dockMarkers(snapshot);
      if (markers.length) fail('dock_marker');
      dockMarkersChecked = true;
    }
    const { agent } = await checkedAgent(target, false, true);
    if (agent.launch_pending === true || snapshot.agents.find(item => item.pane_id === target.paneId)?.launch_pending === true) fail('dock_pending');
    const layout = (await invoke(['pane', 'layout', '--pane', own.pane_id])).result?.layout;
    if (layout?.workspace_id !== own.workspace_id || layout?.tab_id !== own.tab_id
      || !layout.panes?.some(item => item.pane_id === own.pane_id)) fail('dock_narrow');
    const ownRect = layout.panes.find(item => item.pane_id === own.pane_id)?.rect;
    const columns = ownRect?.width;
    const previousRect = switchFrom && layout.panes.find(item => item.pane_id === switchFrom.target.paneId)?.rect;
    if (layout?.zoomed || !Number.isSafeInteger(columns)
      || (switchFrom ? columns < 60 || !Number.isSafeInteger(previousRect?.width) || previousRect.width < 160 : columns < 140)) fail('dock_narrow');
    const shepRatio = switchFrom ? 0.5 : Math.max(0.35, 60 / columns);
    if (!switchFrom && (Math.round(columns * shepRatio) < 60 || columns - Math.round(columns * shepRatio) < 80)) fail('dock_narrow');
    if (switchFrom) {
      await movedAgent(switchFrom.target, switchFrom.target.terminalId, own.workspace_id, own.tab_id);
      const previousPlaceholder = snapshot.panes.find(pane => pane.terminal_id === switchFrom.placeholder.terminalId);
      if (snapshot.panes.some(pane => pane.pane_id === switchFrom.placeholder.paneId
        && pane.terminal_id !== switchFrom.placeholder.terminalId)) fail('dock_missing');
      if (previousPlaceholder) await checkedPlaceholder(switchFrom, snapshot);
    }
    const captured = { ...target, agentName: Object.hasOwn(target, 'agentName') ? target.agentName : target.name ?? null };
    const before = await checkedAgent(captured, false, true);
    if (before.snapshot.panes.find(pane => pane.pane_id === source.pane_id)?.terminal_id !== source.terminal_id) fail('changed_target');
    const tabLabel = await originTabLabel(source, captured, agent, switchFrom);
    let placeholder, placeholderShell, newState, shellReady = false, moveAttempted = false, moveVerified = false;
    try {
      const result = (await invoke(['pane', 'split', '--pane', source.pane_id, '--direction', 'right', '--ratio', '0.5',
        ...(isAbsolute(source.foreground_cwd ?? source.cwd ?? '') ? ['--cwd', source.foreground_cwd ?? source.cwd] : []), '--no-focus'])).result;
      placeholder = result?.pane;
      if (!present(placeholder?.pane_id) || !present(placeholder?.terminal_id) || placeholder.tab_id !== source.tab_id
        || placeholder.workspace_id !== source.workspace_id || placeholder.pane_id === source.pane_id) fail('invalid_response');
      placeholderShell = await readyDockShell(placeholder, source);
      shellReady = true;
      const beforeMarker = (await fresh()).snapshot;
      const matchingPane = beforeMarker.panes.find(pane => pane.pane_id === placeholder.pane_id
        && pane.terminal_id === placeholder.terminal_id && pane.tab_id === source.tab_id
        && pane.workspace_id === source.workspace_id);
      if (!matchingPane || beforeMarker.agents.some(agent => agent.pane_id === placeholder.pane_id
        || agent.terminal_id === placeholder.terminal_id)) fail('dock_missing');
      const exactPlaceholder = await paneGet(placeholder.pane_id);
      if (exactPlaceholder.terminal_id !== placeholder.terminal_id || exactPlaceholder.tab_id !== source.tab_id
        || exactPlaceholder.workspace_id !== source.workspace_id || present(exactPlaceholder.label)
        || present(exactPlaceholder.agent) || exactPlaceholder.launch_pending === true) fail('dock_missing');
      const marker = dockLabel({ ownTerminalId: own.terminal_id, agentTerminalId: target.terminalId,
        provider: target.provider, agentName: captured.agentName, sessionId: trustedSession(target.provider, target.sessionId) ?? null,
        originTabId: source.tab_id, originWorkspaceId: source.workspace_id,
        originTabLabel: tabLabel?.original ?? null, dockedTabLabel: tabLabel?.docked ?? null,
        previousDockedTabLabel: tabLabel?.previousDocked ?? null, ...placeholderShell });
      await invoke(['pane', 'rename', placeholder.pane_id, marker]);
      const marked = await paneGet(placeholder.pane_id);
      if (marked.terminal_id !== placeholder.terminal_id || marked.label !== marker) fail('invalid_response');
      newState = { target: captured, origin: { tabId: source.tab_id, workspaceId: source.workspace_id },
        placeholder: { paneId: placeholder.pane_id, terminalId: placeholder.terminal_id, ...placeholderShell },
        tabLabel, marker, phase: 'preparing' };
      if (!switchFrom) dockState = newState;
      await checkedAgent(captured, false, true);
      if (switchFrom) await movedAgent(switchFrom.target, switchFrom.target.terminalId, own.workspace_id, own.tab_id);
      moveAttempted = true;
      const moved = (await invoke(['pane', 'move', source.pane_id, '--tab', own.tab_id, '--split', 'right',
        '--target-pane', switchFrom?.target.paneId ?? own.pane_id, '--ratio', String(shepRatio), '--no-focus'])).result?.move_result;
      if (moved?.changed !== true || moved?.pane?.terminal_id !== target.terminalId) fail('invalid_response');
      const verified = await movedAgent(captured, target.terminalId, own.workspace_id, own.tab_id);
      moveVerified = true;
      if (snapshot.focused_pane_id === own.pane_id && [moved.focused_pane_id, moved.target_layout?.focused_pane_id,
        verified.snapshot.focused_pane_id].some(id => present(id) && id !== own.pane_id)) fail('invalid_response');
      const place = await paneGet(placeholder.pane_id);
      if (place.terminal_id !== placeholder.terminal_id || place.label !== marker || place.tab_id !== source.tab_id
        || place.workspace_id !== source.workspace_id) fail('dock_missing');
      newState = { ...newState, target: verified.target, phase: 'docked' };
      if (switchFrom) {
        const restored = await undockCore(reserve);
        if (!restored.ok) fail('dock_missing');
        dockState = newState;
        const labelResult = await renameOriginTab(newState);
        const message = labelResult === 'renamed'
          ? restored.message.includes('placeholder kept') ? restored.message : 'Selected agent docked beside Shep.'
          : restored.message.includes('placeholder kept')
            ? `${restored.message} Warning: origin tab label did not change; keep Shep's tab open.`
            : "Docked. Warning: origin tab label did not change; keep Shep's tab open.";
        return outcome('docked', message,
          { target: structuredClone(verified.target), restoredTarget: restored.target });
      }
      dockState = newState;
      const labelResult = await renameOriginTab(newState);
      return outcome('docked', labelResult === 'renamed' ? 'Selected agent docked beside Shep.'
        : "Docked. Warning: origin tab label did not change; keep Shep's tab open.",
      { target: structuredClone(verified.target) });
    } catch (error) {
      dockMarkersChecked = false;
      if (switchFrom && moveVerified) {
        const previous = dockState;
        try {
          dockState = newState;
          const restored = await undockCore(reserve);
          if (!restored.ok) fail('dock_missing');
          dockState = previous;
          if (dockState) dockState.phase = 'uncertain';
        } catch {
          dockState = previous;
          if (dockState) dockState.phase = 'uncertain';
        }
      } else if (dockState && moveAttempted) dockState.phase = 'uncertain';
      if ((!dockState || switchFrom && !moveAttempted) && shellReady && placeholder?.pane_id && placeholder?.terminal_id) {
        try {
          const current = (await fresh()).snapshot;
          const pane = current.panes.find(item => item.pane_id === placeholder.pane_id && item.terminal_id === placeholder.terminal_id
            && item.tab_id === source.tab_id && item.workspace_id === source.workspace_id);
          if (pane && !current.agents.some(item => item.pane_id === pane.pane_id)) {
            const exact = await paneGet(pane.pane_id);
            const process = await placeholderProcess(pane.pane_id);
            if (exact.terminal_id === placeholder.terminal_id && !present(exact.agent) && exact.launch_pending !== true
              && shellOnly(process, placeholderShell))
              await invoke(['pane', 'close', pane.pane_id], { allowDisconnected: true });
          }
        } catch { /* An uncertain created pane is left for inspection. */ }
      }
      return uncertainDock('Dock could not be confirmed. Inspect Herdr; Shep will not retry it automatically.', error,
        { target: dockState?.target ?? captured }, [newState, dockState]);
    }
  }

  async function canSwitchWithoutRemovingPane(state, target) {
    if (state.phase !== 'docked') return false;
    const { snapshot, own } = await fresh();
    const previous = snapshot.panes.find(pane => pane.terminal_id === state.target.terminalId);
    const next = snapshot.panes.find(pane => pane.pane_id === target?.paneId && pane.terminal_id === target?.terminalId);
    if (!previous || previous.pane_id !== state.target.paneId || previous.tab_id !== own.tab_id
      || previous.workspace_id !== own.workspace_id || !next || next.tab_id === own.tab_id) return false;
    const layout = (await invoke(['pane', 'layout', '--pane', own.pane_id])).result?.layout;
    const shepWidth = layout?.panes?.find(pane => pane.pane_id === own.pane_id)?.rect?.width;
    const agentWidth = layout?.panes?.find(pane => pane.pane_id === previous.pane_id)?.rect?.width;
    return layout?.tab_id === own.tab_id && layout?.workspace_id === own.workspace_id && !layout.zoomed
      && Number.isSafeInteger(shepWidth) && shepWidth >= 60
      && Number.isSafeInteger(agentWidth) && agentWidth >= 160;
  }

  async function undockCore(reserve) {
    if (!dockState) return outcome('undocked', 'No agent is docked.');
    const state = dockState;
    if (state.phase === 'uncertain') return uncertainDock('Dock movement was uncertain. Inspect Herdr before restoring it.',
      new ControlError('dock_missing'), { target: structuredClone(state.target) }, [state]);
    const { snapshot, own } = await fresh();
    reserve(own.workspace_id, state.origin.workspaceId);
    const candidate = snapshot.panes.filter(pane => pane.terminal_id === state.target.terminalId);
    if (candidate.length > 1) fail('dock_missing');
    const placeholderById = snapshot.panes.find(pane => pane.pane_id === state.placeholder.paneId);
    if (placeholderById && placeholderById.terminal_id !== state.placeholder.terminalId) fail('dock_missing');
    const placeholder = snapshot.panes.find(pane => pane.terminal_id === state.placeholder.terminalId);
    if (placeholder) await checkedPlaceholder(state, snapshot);
    if (!candidate.length) {
      if (!placeholder) fail('dock_missing');
      const closed = await closeDockPlaceholder(state);
      const tabStatus = await restoreOriginTab(state);
      clearDockLatches(state);
      dockState = null;
      dockMarkersChecked = true;
      return outcome('undocked', restoredTabMessage(closed ? 'The closed agent dock was cleared.' : 'Placeholder kept (busy or unverified); marker removed.', tabStatus));
    }
    const current = candidate[0];
    const verified = await movedAgent(state.target, state.target.terminalId, current.workspace_id, current.tab_id);
    if (current.tab_id !== own.tab_id && !(state.phase === 'preparing' && current.tab_id === state.origin.tabId)
      && !(state.phase === 'restoring' && current.workspace_id === state.origin.workspaceId)) fail('dock_missing');
    if (state.phase === 'preparing' && current.tab_id === state.origin.tabId) {
      if (!placeholder) fail('dock_missing');
      const closed = await closeDockPlaceholder(state);
      const tabStatus = await restoreOriginTab(state);
      clearDockLatches(state);
      dockState = null;
      dockMarkersChecked = true;
      return outcome('undocked', restoredTabMessage(closed ? 'Unfinished dock cleared.' : 'Agent home; placeholder kept (busy or unverified).', tabStatus), { target: verified.target });
    }
    if (state.phase === 'restoring') {
      const closed = placeholder ? await closeDockPlaceholder(state) : true;
      const tabStatus = await restoreOriginTab(state);
      clearDockLatches(state);
      dockState = null;
      dockMarkersChecked = true;
      return outcome('undocked', restoredTabMessage(closed ? 'Agent returned to its original workspace.' : 'Agent restored; placeholder kept (busy or unverified).', tabStatus), { target: verified.target });
    }
    const originWorkspace = snapshot.workspaces.some(workspace => workspace.workspace_id === state.origin.workspaceId);
    const originTab = originWorkspace && placeholder && snapshot.tabs?.some(tab => tab.tab_id === state.origin.tabId && tab.workspace_id === state.origin.workspaceId);
    const restoredLabel = safeText(state.target.agentName || 'Restored agent');
    const command = originTab
      ? ['pane', 'move', current.pane_id, '--tab', state.origin.tabId, '--split', 'right', '--target-pane', placeholder.pane_id, '--ratio', '0.5', '--no-focus']
      : originWorkspace
        ? ['pane', 'move', current.pane_id, '--new-tab', '--workspace', state.origin.workspaceId, '--label', restoredLabel, '--no-focus']
        : ['pane', 'move', current.pane_id, '--new-workspace', '--label', 'Restored origin', '--tab-label', restoredLabel, '--no-focus'];
    const moved = (await invoke(command, { allowDisconnected: true })).result?.move_result;
    if (moved?.changed !== true || moved?.pane?.terminal_id !== state.target.terminalId) fail('invalid_response');
    const restored = await movedAgent(verified.target, state.target.terminalId,
      originWorkspace ? state.origin.workspaceId : moved.pane.workspace_id, originTab ? state.origin.tabId : moved.pane.tab_id);
    state.target = restored.target;
    state.origin = { tabId: restored.pane.tab_id, workspaceId: restored.pane.workspace_id };
    state.phase = 'restoring';
    const closed = placeholder ? await closeDockPlaceholder(state) : true;
    const tabStatus = await restoreOriginTab(state);
    clearDockLatches(state);
    dockState = null;
    dockMarkersChecked = true;
    return outcome('undocked', restoredTabMessage(closed ? 'Agent returned to its original tab.' : 'Agent restored; placeholder kept (busy or unverified).', tabStatus), { target: restored.target });
  }

  async function dock({ target } = {}) {
    return dockOperation(async reserve => {
      let restoredTarget;
      if (dockState) {
        if (dockState.phase === 'uncertain') return uncertainDock('Dock movement was uncertain. Inspect Herdr before docking again.',
          new ControlError('dock_missing'), { target: structuredClone(dockState.target) }, [dockState]);
        if (dockState.phase === 'docked' && target?.terminalId === dockState.target.terminalId
          && target?.provider === dockState.target.provider && (target?.agentName ?? target?.name ?? null) === dockState.target.agentName) {
          await movedAgent(dockState.target, dockState.target.terminalId, pinned.context.workspaceId, pinned.context.tabId);
          if (!sessionMatches(target.provider, target.sessionId, dockState.target.sessionId, true)) fail('changed_target');
          return outcome('docked', 'Selected agent is already docked.', { target: structuredClone(dockState.target) });
        }
        if (await canSwitchWithoutRemovingPane(dockState, target)) return await dockCore(target, reserve, dockState);
        const restored = await undockCore(reserve);
        if (!restored.ok) return restored;
        restoredTarget = restored.target;
      }
      try {
        const result = await dockCore(target, reserve);
        return restoredTarget ? { ...result, restoredTarget } : result;
      } catch (error) { return { ...dockFailure(error), ...(restoredTarget ? { restoredTarget } : {}) }; }
    });
  }

  async function undock() {
    return dockOperation(async reserve => {
      try { return await undockCore(reserve); }
      catch (error) { dockMarkersChecked = false; return uncertainDock('Undock could not be confirmed. Inspect Herdr; Shep will not retry it automatically.', error,
        { ...(dockState?.target ? { target: structuredClone(dockState.target) } : {}) }, [dockState]); }
    }, { requireLive: false });
  }

  async function recoverDock() {
    return dockOperation(async reserve => {
      if (dockState) return outcome('failed', MESSAGES.busy, { code: 'busy' });
      const { snapshot, own } = await fresh();
      const markers = await dockMarkers(snapshot);
      if (markers.some(({ marker }) => !marker)) return outcome('failed', 'A malformed dock marker needs manual inspection in Herdr.', { code: 'dock_marker' });
      if (markers.length > 1) return outcome('failed', 'Multiple dock placeholders need manual inspection in Herdr.', { code: 'dock_marker' });
      const marked = markers.filter(({ marker }) => marker?.ownTerminalId === own.terminal_id);
      if (markers.length && !marked.length) return outcome('failed', 'A dock placeholder belongs to another Shep pane. Inspect Herdr before docking.', { code: 'dock_marker' });
      if (!marked.length) { dockMarkersChecked = true; return outcome('recovered', 'No leftover dock was found.'); }
      const { pane: placeholder, marker } = marked[0];
      const agentPane = snapshot.panes.filter(pane => pane.terminal_id === marker.agentTerminalId);
      if (agentPane.length > 1 || agentPane[0]?.pane_id === own.pane_id)
        return outcome('failed', 'Leftover dock could not be matched safely. Inspect Herdr.', { code: 'dock_missing' });
      const target = { paneId: agentPane[0]?.pane_id, terminalId: marker.agentTerminalId, provider: marker.provider,
        agentName: marker.agentName, sessionId: marker.sessionId };
      try {
        dockState = { target, origin: { tabId: marker.originTabId, workspaceId: marker.originWorkspaceId },
          placeholder: { paneId: placeholder.pane_id, terminalId: placeholder.terminal_id,
            shellPid: marker.shellPid, shellName: marker.shellName, shellArgv0: marker.shellArgv0, shellCommand: marker.shellCommand },
          tabLabel: present(marker.originTabLabel) && present(marker.dockedTabLabel)
            ? { tabId: marker.originTabId, workspaceId: marker.originWorkspaceId,
              original: marker.originTabLabel, docked: marker.dockedTabLabel,
              previousDocked: present(marker.previousDockedTabLabel) ? marker.previousDockedTabLabel : null } : null,
          marker: placeholder.label, phase: 'docked' };
        if (!agentPane.length) {
          const closed = await closeDockPlaceholder(dockState);
          const tabStatus = await restoreOriginTab(dockState);
          clearDockLatches(dockState);
          dockState = null;
          dockMarkersChecked = true;
          return outcome('recovered', restoredTabMessage(closed ? 'Cleared a leftover dock for a closed agent.' : 'Placeholder kept (busy or unverified); marker removed.', tabStatus));
        }
        if (agentPane[0].workspace_id === marker.originWorkspaceId && agentPane[0].tab_id === marker.originTabId) {
          await movedAgent(target, target.terminalId, marker.originWorkspaceId, marker.originTabId);
          const closed = await closeDockPlaceholder(dockState);
          const tabStatus = await restoreOriginTab(dockState);
          clearDockLatches(dockState);
          dockState = null;
          dockMarkersChecked = true;
          return outcome('recovered', restoredTabMessage(closed ? 'Cleared a leftover dock after the agent returned.' : 'Agent restored; placeholder kept (busy or unverified).', tabStatus), { target });
        }
        if (agentPane[0].tab_id !== own.tab_id || agentPane[0].workspace_id !== own.workspace_id) fail('dock_missing');
        await movedAgent(target, target.terminalId, own.workspace_id, own.tab_id);
        const result = await undockCore(reserve);
        return result.ok ? outcome('recovered', /placeholder kept|Warning:/.test(result.message)
          ? result.message : 'Recovered the agent from the previous dock.', { target: result.target }) : result;
      } catch (error) {
        dockMarkersChecked = false;
        return uncertainDock('Leftover dock could not be restored safely. Inspect Herdr.', error,
          { target: dockState?.target }, [dockState]);
      }
    }, { requireLive: false });
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
  return { getProfiles, getControlSnapshot, dispatch, focus, closeAgent, followUp, rename,
    dock, undock, recoverDock, getDockState: copyDockState,
    notify, listWorktrees, removeWorktree, dismissTask, dispose };
}
