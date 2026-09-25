import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
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
  constructor(code) { super(MESSAGES[code] ?? MESSAGES.failed); this.code = code; }
}
const present = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const fail = code => { throw new ControlError(code); };
const outcome = (state, message, details = {}) => ({ ok: ['submitted', 'focused', 'closed'].includes(state), state, message, ...details });
const errorCode = error => typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : 'failed';

function commandRunner(context) {
  return (argv, { timeoutMs = 4000, maxBuffer = 8 * 1024 * 1024, signal } = {}) => new Promise((resolve, reject) => {
    execFile(context.binary, argv, { env: context.env, encoding: 'utf8', timeout: timeoutMs, maxBuffer, killSignal: 'SIGKILL', signal }, (error, stdout, stderr) => {
      let envelope;
      try { envelope = JSON.parse(error ? stderr : stdout); } catch { /* Only structured server errors are inspected. */ }
      if (envelope?.error) return reject(new ControlError(errorCode(envelope.error)));
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

export function createController({ context, monitor, mode = 'live', run, readRaw } = {}) {
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
    const response = await transport(argv, { ...options, signal: abort.signal });
    active();
    return response;
  };
  const read = readRaw ?? (() => invoke(['api', 'snapshot']));
  let ownTerminalId = null;
  let busy = false;

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
    return profiles(snapshot, own);
  }

  async function exclusive(action) {
    if (busy) return outcome('failed', MESSAGES.busy, { code: 'busy' });
    busy = true;
    try { assertLive(); return await action(); }
    catch (error) { const code = errorCode(error); return outcome('failed', MESSAGES[code] ?? MESSAGES.failed, { code }); }
    finally { busy = false; }
  }

  function checkTarget(target, own) {
    if (!target || !present(target.paneId) || !present(target.terminalId)) fail('invalid_target');
    if (target.paneId === own.pane_id || target.terminalId === own.terminal_id) fail('self_target');
  }

  function compareAgent(target, agent, checkStatus = false) {
    if (!agent || agent.pane_id !== target.paneId || agent.terminal_id !== target.terminalId
      || (target.provider && agent.agent !== target.provider)
      || (target.agentName != null && agent.name !== target.agentName)
      || (target.sessionId != null && (agent.agent_session?.kind !== 'id' || agent.agent_session.value !== target.sessionId))) fail('changed_target');
    if (checkStatus && (!present(target.status) || agent.agent_status !== target.status)) fail('changed_status');
  }

  async function checkedAgent(target, checkStatus = false) {
    const { snapshot, own } = await fresh();
    checkTarget(target, own);
    const pane = snapshot.panes.find(p => p.pane_id === target.paneId);
    if (!pane || pane.terminal_id !== target.terminalId) fail('changed_target');
    const agent = snapshot.agents.find(a => a.pane_id === target.paneId);
    compareAgent(target, agent, checkStatus);
    // This second read narrows the race against an agent replacement after confirmation.
    const current = (await invoke(['agent', 'get', target.paneId])).result?.agent;
    compareAgent(target, current, checkStatus);
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

  async function dispatch(request = {}) {
    return exclusive(async () => {
      const { provider, prompt, name: requestedName } = request;
      if (!KINDS.has(provider)) fail('invalid_provider');
      if (typeof prompt !== 'string' || !prompt.trim() || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(prompt) || Buffer.byteLength(prompt, 'utf8') > 65536) fail('invalid_prompt');
      if (requestedName != null && (typeof requestedName !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(requestedName))) fail('invalid_name');
      const { snapshot, own } = await fresh();
      const workspaceId = request.workspaceId ?? own.workspace_id;
      const workspace = snapshot.workspaces.find(w => w.workspace_id === workspaceId);
      if (!workspace) fail('workspace_missing');
      const anchor = workspaceId === own.workspace_id ? own
        : snapshot.panes.find(p => p.workspace_id === workspaceId && p.tab_id === workspace.active_tab_id && p.focused)
          ?? snapshot.panes.find(p => p.workspace_id === workspaceId && p.tab_id === workspace.active_tab_id);
      if (!anchor) fail('workspace_missing');
      const cwd = request.cwd ?? anchor.foreground_cwd ?? anchor.cwd ?? workspace.worktree?.checkout_path;
      if (!present(cwd) || !isAbsolute(cwd) || Buffer.byteLength(cwd, 'utf8') > 4096) fail('invalid_cwd');
      try { if (!(await stat(cwd)).isDirectory()) fail('invalid_cwd'); } catch { fail('invalid_cwd'); }
      const name = requestedName ?? `shep-${provider.slice(0,12)}-${randomBytes(5).toString('hex')}`;
      if (snapshot.agents.some(a => a.name === name)) fail('duplicate_name');
      if (!await hasExecutable(KINDS.get(provider).executable, pinned.env)) fail('unavailable_provider');
      const direction = await directionFor(anchor);
      // Validate the anchor again immediately before changing layout.
      const beforeSplit = await fresh();
      if (!beforeSplit.snapshot.panes.some(p => p.pane_id === anchor.pane_id && p.terminal_id === anchor.terminal_id && p.workspace_id === workspaceId && p.tab_id === anchor.tab_id)) fail('changed_target');
      if (beforeSplit.snapshot.agents.some(a => a.name === name)) fail('duplicate_name');
      let pane;
      let stage = 'split';
      try {
        const response = await invoke(['pane', 'split', '--pane', anchor.pane_id, '--direction', direction, '--cwd', cwd, '--no-focus']);
        pane = response.result?.pane;
        if (!present(pane?.pane_id) || !present(pane?.terminal_id) || pane.pane_id === own.pane_id || pane.terminal_id === own.terminal_id
          || pane.workspace_id !== workspaceId || pane.tab_id !== anchor.tab_id) fail('invalid_response');
        const details = { paneId: pane.pane_id, terminalId: pane.terminal_id, agentName: name };
        stage = 'start';
        const beforeStart = await fresh();
        if (!beforeStart.snapshot.panes.some(p => p.pane_id === pane.pane_id && p.terminal_id === pane.terminal_id)) fail('changed_target');
        const start = await invoke(['agent', 'start', name, '--kind', provider, '--pane', pane.pane_id, '--timeout', '30000'], { timeoutMs: 35000 });
        const started = start.result?.agent;
        const target = { ...details, provider, agentName: name };
        compareAgent(target, started);
        const current = await checkedAgent(target);
        if (current.agent.agent_status === 'blocked' || current.agent.interactive_ready !== true || current.agent.launch_pending === true) {
          return outcome('needs_input', 'The new pane needs attention before receiving a prompt. Review its trust, authentication or approval screen; the prompt was not sent.', { ...details, code: 'agent_not_ready' });
        }
        if (!['idle', 'done'].includes(current.agent.agent_status)) {
          return outcome('uncertain', 'The new agent is not ready for a new prompt. Its pane was kept open; inspect it before submitting work.', { ...details, code: 'agent_not_ready' });
        }
        stage = 'prompt';
        // Herdr takes the first two positional arguments literally, including leading
        // dashes in text. It does not support an option terminator here. No replay:
        // a timeout does not prove these bytes were not delivered.
        const submitted = await invoke(['agent', 'prompt', pane.pane_id, prompt], { timeoutMs: 8000 });
        compareAgent(target, submitted.result?.agent);
        return outcome('submitted', 'Prompt submitted. Herdr will report the agent’s live status.', details);
      } catch (error) {
        const code = errorCode(error);
        const details = { code, ...(present(pane?.pane_id) && present(pane?.terminal_id) ? { paneId: pane.pane_id, terminalId: pane.terminal_id, agentName: name } : {}) };
        if (NEEDS_INPUT.has(code)) return outcome('needs_input', 'The new agent needs attention. Its pane was kept open and the prompt was not sent. Review trust, authentication or approval in that pane.', details);
        if (UNCERTAIN.has(code) || stage === 'prompt') {
          return outcome('uncertain', stage === 'split' ? 'Pane creation could not be confirmed. Inspect Herdr before dispatching again; Shep will not retry automatically.'
            : stage === 'prompt' ? 'Prompt delivery could not be confirmed. The pane was kept open. Inspect it before sending the prompt again.'
              : 'Agent startup could not be confirmed. The pane was kept open. Inspect it before dispatching again.', details);
        }
        return outcome('failed', pane ? `${MESSAGES[code] ?? 'Agent startup failed.'} The new pane was kept open; inspect it before retrying.` : MESSAGES[code] ?? MESSAGES.failed, details);
      }
    });
  }

  async function focus(target) {
    return exclusive(async () => {
      const initial = await fresh();
      checkTarget(target, initial.own);
      if (!initial.snapshot.panes.some(p => p.pane_id === target.paneId && p.terminal_id === target.terminalId)) fail('changed_target');
      if (!initial.snapshot.agents.some(a => a.pane_id === target.paneId)) {
        return outcome('needs_input', 'This pane has no detected agent yet. Select it directly in Herdr to review startup.', { code: 'agent_not_ready', paneId: target.paneId, terminalId: target.terminalId });
      }
      await checkedAgent(target);
      try {
        await invoke(['agent', 'focus', target.paneId]);
        const { snapshot } = await fresh();
        const pane = snapshot.panes.find(p => p.pane_id === target.paneId && p.terminal_id === target.terminalId);
        if (!pane || !(pane.focused || snapshot.focused_pane_id === target.paneId)) fail('invalid_response');
        return outcome('focused', 'Focused the selected agent pane.', { paneId: target.paneId, terminalId: target.terminalId });
      } catch (error) {
        return outcome('uncertain', 'Focus could not be confirmed. Check Herdr; Shep will not repeat the action automatically.', { code: errorCode(error), paneId: target.paneId, terminalId: target.terminalId });
      }
    });
  }

  async function closeAgent(target) {
    return exclusive(async () => {
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

  function dispose() {
    disposed = true;
    abort.abort();
  }

  return { getProfiles, dispatch, focus, closeAgent, dispose };
}
