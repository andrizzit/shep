import { isAbsolute, relative } from 'node:path';
import { BOARD_STATE_ORDER, FINAL_LAUNCH_STATES, LAUNCH_TRANSITIONS, LIVE_STATES, PROGRESS_STAGES,
  assertContract, validateArgs, validateDispatchSpec, validateOutcome, validatePlacementIntent, validateProgressEvent } from './dispatch/contracts.mjs';
import { tabLabel } from './dispatch/naming.mjs';
import { safeText } from './terminal.mjs';

const copy = value => structuredClone(value);
const fail = message => { throw new TypeError(message); };
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const inside = (root, path) => { if (!root || !path || !isAbsolute(path)) return false; const rest = relative(root, path); return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('../')); };
const identify = (task, agent) => task.target && agent.paneId === task.target.paneId && agent.terminalId === task.target.terminalId
  && (!task.target.provider || agent.provider === task.target.provider)
  && (!task.target.agentName || agent.agentName === task.target.agentName || agent.name === task.target.agentName)
  && (!task.target.sessionId || agent.sessionId === task.target.sessionId);

export function createTask(spec, { id, attemptId, groupId = null, at, name, args = [], placement } = {}) {
  assertContract(validateDispatchSpec(spec));
  assertContract(validateArgs(args));
  assertContract(validatePlacementIntent(placement));
  if (!id || !attemptId || !instant(at) || spec.agents.length !== 1 || typeof name !== 'string') fail('A task needs one agent, a name, task/attempt IDs and a timestamp.');
  return { id, attemptId, groupId, at, command: spec.command, inputTask: spec.inputTask, prompt: spec.task,
    agent: copy(spec.agents[0]), project: copy(spec.project), subfolder: spec.subfolder, modeIntent: spec.modeIntent,
    template: spec.template, name, args: [...args], intent: copy(placement), placement: null,
    launch: { state: 'queued', message: 'Queued for launch.', code: null, stage: null },
    live: { status: null, since: null }, target: null, created: null,
    followUp: { count: 0, lastAt: null }, summary: null, dismissed: false };
}

function launchState(task, next) {
  if (!LAUNCH_TRANSITIONS[task.launch.state]?.includes(next)) fail(`Invalid task transition: ${task.launch.state} → ${next}.`);
}

export function transition(task, event) {
  if (!task?.launch || !event?.type) fail('A task and event are required.');
  const updated = copy(task);
  if (event.type === 'progress') {
    const progress = event.event;
    assertContract(validateProgressEvent(progress));
    if (progress.taskId !== task.id || progress.attemptId !== task.attemptId) fail('Progress belongs to a different task attempt.');
    if (FINAL_LAUNCH_STATES.includes(task.launch.state) || task.launch.state === 'needs_confirmation') fail('This launch attempt already has an outcome.');
    const current = task.launch.stage === null ? -1 : PROGRESS_STAGES.indexOf(task.launch.stage);
    const next = PROGRESS_STAGES.indexOf(progress.stage);
    const confirmedQueue = task.launch.state === 'starting' && task.launch.stage === null && progress.stage === 'queued';
    if (next < current || (task.launch.state === 'starting' && progress.stage === 'queued' && !confirmedQueue)) fail('Launch progress cannot move backwards.');
    if (progress.stage !== 'queued' && task.launch.state === 'queued') launchState(task, 'starting');
    updated.launch = { ...task.launch, state: progress.stage === 'queued' ? task.launch.state : 'starting', stage: progress.stage, message: progress.message ?? (progress.stage === 'queued' ? 'Queued for launch.' : 'Starting agent…') };
  } else if (event.type === 'outcome') {
    const outcome = event.outcome;
    assertContract(validateOutcome(outcome));
    if (outcome.taskId !== task.id || outcome.attemptId !== task.attemptId) fail('Outcome belongs to a different task attempt.');
    launchState(task, outcome.state);
    updated.launch = { state: outcome.state, message: outcome.message, code: outcome.code ?? null, stage: outcome.stage ?? task.launch.stage,
      ...(outcome.delivery ? { delivery: outcome.delivery } : {}) };
    if (outcome.placement) updated.placement = copy(outcome.placement);
    if (outcome.created) updated.created = copy(outcome.created);
    if (outcome.paneId && outcome.terminalId) updated.target = { paneId: outcome.paneId, terminalId: outcome.terminalId, provider: task.agent.provider, agentName: outcome.agentName ?? task.name };
  } else if (event.type === 'confirmation') {
    if (task.launch.state !== 'needs_confirmation' || typeof event.approved !== 'boolean' || !instant(event.at)) fail('No trust confirmation is pending for this task.');
    const state = event.approved ? 'starting' : 'failed';
    launchState(task, state);
    if (event.approved) {
      if (!event.attemptId || event.attemptId === task.attemptId) fail('A confirmed retry needs a new attempt ID.');
      updated.attemptId = event.attemptId;
    }
    updated.launch = { state, message: event.approved ? 'Repository trust confirmed.' : 'Repository trust was declined.', code: event.approved ? null : 'confirmation_declined', stage: null };
  } else if (event.type === 'live') {
    if (!LIVE_STATES.includes(event.status) || !instant(event.since) || !task.target
      || event.paneId !== task.target.paneId || event.terminalId !== task.target.terminalId
      || task.live.status === 'closed' || !['submitted', 'needs_input', 'uncertain'].includes(task.launch.state)) fail('Live status does not match an open task pane.');
    // Caller establishes closed from fresh PRIVATE topology, never missing agents.
    updated.live = { status: event.status, since: task.live.status === event.status ? task.live.since : event.since };
  } else if (event.type === 'follow-up') {
    assertContract(validateOutcome(event.outcome, { dispatch: false }));
    if (!task.target || task.live.status === 'closed' || !instant(event.at)) fail('Follow-up requires an open task pane.');
    if (event.outcome.paneId && (event.outcome.paneId !== task.target.paneId || event.outcome.terminalId !== task.target.terminalId)) fail('Follow-up belongs to another pane.');
    if (event.outcome.state === 'submitted' || event.outcome.state === 'uncertain') updated.followUp = { count: task.followUp.count + 1, lastAt: event.at };
  } else if (event.type === 'dismiss') {
    if (!FINAL_LAUNCH_STATES.includes(task.launch.state)) fail('Only a final task attempt can be dismissed.');
    updated.dismissed = true;
  } else fail('Unknown task event.');
  return updated;
}

export function displayState(task, agents = []) {
  if (task.live.status === 'closed') return 'closed';
  const agent = agents.find(agent => identify(task, agent));
  if (agent) return LIVE_STATES.includes(agent.status) ? agent.status : 'unknown';
  if (task.live.status) return task.live.status;
  return task.launch.state === 'submitted' ? 'unknown' : task.launch.state;
}

export function groupTasks(tasks, agents, projects, { query = '', filter = 'all', now = Date.now() } = {}) {
  const groups = new Map(), matched = new Set();
  const milliseconds = typeof now === 'function' ? Number(now()) : typeof now === 'string' ? Date.parse(now) : Number(now);
  const search = safeText(query).toLowerCase().trim();
  function add(row) {
    if (filter !== 'all' && row.status !== filter) return;
    if (search && !safeText([row.label, row.task?.inputTask, row.agent?.name, row.task?.agent.provider ?? row.agent?.provider, row.project?.name, row.project?.root].join(' ')).toLowerCase().includes(search)) return;
    const key = row.project?.key ?? 'other';
    if (!groups.has(key)) groups.set(key, { key, name: row.project?.name ?? 'Other', project: row.project ?? null, active: false, rows: [] });
    const group = groups.get(key);
    group.active ||= !['done', 'idle', 'failed', 'closed'].includes(row.status);
    group.rows.push(row);
  }
  for (const task of tasks) {
    if (task.dismissed) continue;
    const agent = agents.find(agent => identify(task, agent)) ?? null;
    if (agent) matched.add(agent.id ?? agent.terminalId ?? agent.paneId);
    add({ id: `task:${task.id}`, task, agent, project: projects.find(project => project.key === task.project.key) ?? task.project,
      status: displayState(task, agents), label: tabLabel(task.inputTask), at: task.at, elapsedMs: Math.max(0, milliseconds - Date.parse(task.at)), external: false });
  }
  for (const agent of agents) {
    if (matched.has(agent.id ?? agent.terminalId ?? agent.paneId)) continue;
    const path = agent.workspace?.path;
    const project = projects.filter(project => inside(project.root, path) || project.worktrees.some(worktree => inside(worktree.path, path))).sort((a, b) => b.root.length - a.root.length)[0] ?? null;
    add({ id: `external:${agent.terminalId ?? agent.paneId ?? agent.id}`, task: null, agent, project,
      status: LIVE_STATES.includes(agent.status) ? agent.status : 'unknown', label: `external · ${safeText(agent.name ?? agent.provider)}`, at: agent.lastSeenAt ?? null, elapsedMs: null, external: true });
  }
  for (const group of groups.values()) group.rows.sort((a, b) => BOARD_STATE_ORDER.indexOf(a.status) - BOARD_STATE_ORDER.indexOf(b.status)
    || (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || a.id.localeCompare(b.id));
  return [...groups.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
