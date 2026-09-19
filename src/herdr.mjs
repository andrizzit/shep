import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { isAbsolute } from 'node:path';

const STATUSES = new Set(['working', 'blocked', 'done', 'idle', 'unknown']);
const DISPLAY_NAMES = { claude: 'Claude', codex: 'Codex', kiro: 'Kiro' };
const DEMO_FILE = new URL('../tests/fixtures/demo-snapshot.json', import.meta.url);

export class HerdrReadError extends Error {
  constructor(message, code = 'unavailable') {
    super(message);
    this.name = 'HerdrReadError';
    this.code = code;
  }
}

export function getHerdrContext(env = process.env) {
  const names = ['HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID'];
  if (names.some(name => typeof env[name] !== 'string' || !env[name].trim())
    || !isAbsolute(env.HERDR_SOCKET_PATH)) {
    throw new HerdrReadError('Shep runs only inside Herdr. Open a Herdr pane and run shep there.', 'outside_herdr');
  }
  return {
    binary: env.HERDR_BIN_PATH || 'herdr',
    env: { ...env },
    // An explicit null prevents SHEP_SESSION from redirecting the CLI.
    session: null,
    context: { paneId: env.HERDR_PANE_ID, tabId: env.HERDR_TAB_ID, workspaceId: env.HERDR_WORKSPACE_ID },
  };
}

// Host metadata can contain terminal escapes. Never forward them to a terminal UI.
function clean(value) {
  if (typeof value !== 'string') return null;
  const result = stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
  return result || null;
}

function invalidSnapshot() {
  return new HerdrReadError('Herdr returned an unsupported snapshot. Check the running Herdr version.', 'invalid_snapshot');
}

export function normalizeSnapshot(raw, now = new Date().toISOString()) {
  const snapshot = raw?.result?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.workspaces)) {
    throw invalidSnapshot();
  }
  const workspaces = new Map();
  for (const workspace of snapshot.workspaces) {
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) throw invalidSnapshot();
    const id = clean(workspace.workspace_id);
    if (id) workspaces.set(id, workspace);
  }
  const timestamp = now instanceof Date ? now.toISOString() : now;
  const seen = new Set();
  const agents = snapshot.agents.map((agent) => {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) throw invalidSnapshot();
    const paneId = clean(agent.pane_id);
    if (!paneId) throw invalidSnapshot();
    const terminalId = clean(agent.terminal_id);
    const id = terminalId ?? paneId;
    if (seen.has(id)) throw invalidSnapshot();
    seen.add(id);
    const provider = clean(agent.agent)?.toLowerCase() ?? 'unknown';
    const displayName = Object.hasOwn(DISPLAY_NAMES, provider) ? DISPLAY_NAMES[provider] : provider[0].toUpperCase() + provider.slice(1);
    const workspaceId = clean(agent.workspace_id);
    const workspace = workspaces.get(workspaceId);
    return {
      id,
      provider,
      name: clean(agent.name) ?? clean(agent.agent_name) ?? `${displayName} · ${paneId}`,
      status: STATUSES.has(agent.agent_status) ? agent.agent_status : 'unknown',
      workspace: {
        id: workspaceId,
        name: clean(workspace?.label) ?? workspaceId ?? 'Workspace unavailable',
        path: clean(agent.foreground_cwd) ?? clean(agent.cwd) ?? clean(workspace?.worktree?.checkout_path),
      },
      paneId,
      tabId: clean(agent.tab_id),
      terminalId,
      agentName: clean(agent.name) ?? clean(agent.agent_name),
      sessionId: agent.agent_session?.kind === 'id' ? clean(agent.agent_session.value) : null,
      focused: agent.focused === true,
      interactiveReady: agent.interactive_ready === true,
      launchPending: agent.launch_pending === true,
      lastSeenAt: timestamp,
    };
  });
  return { version: clean(snapshot.version), agents };
}

export function readHerdrSnapshot(options = {}) {
  const env = { ...process.env, ...options.env };
  const binary = options.binary ?? env.HERDR_BIN_PATH ?? 'herdr';
  const session = options.context ? null : options.session === undefined ? env.SHEP_SESSION : options.session;
  const args = [...(session ? ['--session', session] : []), 'api', 'snapshot'];
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 4000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      killSignal: 'SIGKILL',
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        if (error.code === 'ENOENT') {
          reject(new HerdrReadError('Herdr was not found. Install Herdr or set HERDR_BIN_PATH.', 'not_found'));
        } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new HerdrReadError('Herdr snapshot exceeded the 8 MiB output limit.', 'too_large'));
        } else if (error.killed || error.signal === 'SIGKILL') {
          reject(new HerdrReadError('Herdr did not respond in time. Check that its server is running.', 'timeout'));
        } else {
          reject(new HerdrReadError('Unable to reach Herdr. Check its server and the selected session.', 'unavailable'));
        }
        return;
      }
      try {
        const raw = JSON.parse(stdout);
        const result = normalizeSnapshot(raw);
        if (options.context) {
          const { paneId, tabId, workspaceId } = options.context;
          const panes = raw.result.snapshot.panes;
          if (!Array.isArray(panes) || !panes.some(pane => pane?.pane_id === paneId
            && pane.tab_id === tabId && pane.workspace_id === workspaceId)) {
            throw new HerdrReadError('This pane is not in the current Herdr session. Open a Herdr pane and run shep again.', 'outside_herdr');
          }
        }
        resolve(result);
      } catch (error) {
        reject(error instanceof HerdrReadError ? error : invalidSnapshot());
      }
    });
  });
}

// Explicit sample mode only; live reads never fall back to these records.
export async function readDemoSnapshot() {
  return normalizeSnapshot(JSON.parse(await readFile(DEMO_FILE, 'utf8')));
}
