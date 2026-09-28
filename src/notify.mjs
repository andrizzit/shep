import { PROVIDERS } from './dispatch/contracts.mjs';
import { safeText } from './terminal.mjs';

// Match the same optional identity constraints as tasks.mjs identify(). A pane
// and terminal can survive an agent replacement, so neither alone is sufficient.
const matches = (target, agent) => target && agent.paneId === target.paneId && agent.terminalId === target.terminalId
  && (!target.provider || agent.provider === target.provider)
  && (!target.agentName || agent.agentName === target.agentName || agent.name === target.agentName)
  && (!target.sessionId || agent.sessionId === target.sessionId);
const identity = target => JSON.stringify([target?.paneId, target?.terminalId, target?.provider ?? null,
  target?.agentName ?? null, target?.sessionId ?? null]);

// Watches metadata only; the caller owns lifecycle/config-reload wiring.
export function createNotifier({ monitor, controller, config, getTasks = () => [], now = Date.now } = {}) {
  let disposed = false, baseline = false;
  let previous = new Map();
  const delivered = new Map();
  const names = new Map(PROVIDERS.map(provider => [provider.id, provider.name]));
  function update(snapshot) {
    if (disposed || snapshot?.source?.state !== 'connected' || snapshot.mode === 'demo') return;
    const settings = config?.notifications ?? {};
    const tasks = getTasks();
    const tracked = tasks.map(task => ({
      id: task.id, target: task.target, project: task.project?.name ?? 'Project', provider: task.agent?.provider,
      label: task.intent?.label ?? task.name ?? '', launch: task.launch,
    }));
    if (settings.external) for (const agent of snapshot.agents ?? []) {
      if (!tracked.some(task => matches(task.target, agent))) {
        const target = { ...agent, agentName: agent.agentName || agent.name };
        tracked.push({ id: `external:${identity(target)}`, target,
          project: agent.workspace?.name ?? 'Workspace', provider: agent.provider, label: agent.name });
      }
    }
    const current = new Map();
    for (const task of tracked) {
      const occupant = snapshot.agents?.find(a => a.paneId === task.target?.paneId && a.terminalId === task.target?.terminalId);
      const agent = occupant && matches(task.target, occupant) ? occupant : null;
      const replaced = Boolean(occupant && !agent);
      const value = { status: agent?.status ?? 'unknown', observed: Boolean(agent), identity: identity(task.target), launch: task.launch?.state, paneId: task.target?.paneId ?? null, terminalId: task.target?.terminalId ?? null };
      current.set(task.id, value);
      const old = previous.get(task.id);
      if (!baseline || !value.paneId || !value.terminalId || replaced) continue;
      const setup = value.launch === 'needs_input' && old?.launch !== 'needs_input';
      const sameTarget = old?.identity === value.identity;
      // An idle shell may precede execution. Only a real agent's done status
      // supports first-observation completion; synthetic unknown is no evidence.
      const firstCompletion = value.launch === 'submitted' && value.observed && value.status === 'done'
        && (!old?.paneId || (sameTarget && !old.observed));
      // A dispatched agent can reach an input prompt before its outcome binds
      // the target. Its first blocked observation still needs attention.
      const firstBlocked = ['submitted', 'uncertain'].includes(value.launch) && value.observed && value.status === 'blocked'
        && (!old?.paneId || (sameTarget && !old.observed));
      if (!setup && !firstCompletion && !firstBlocked && !sameTarget) continue;
      let transition, title, body = task.label, sound;
      const label = `${safeText(task.project)} · ${safeText(names.get(task.provider) ?? task.provider ?? 'Agent')}`;
      if (setup) {
        transition = 'setup'; title = `⚠ ${label} needs setup`; body = task.launch.message; sound = 'request';
      } else if (old?.status !== 'blocked' && value.status === 'blocked'
        && !(old?.launch === 'needs_input' && !old.observed)) {
        transition = 'blocked'; title = `⚠ ${label} needs input`; sound = 'request';
      } else if (firstCompletion || (sameTarget && old.observed && value.observed
        && ['working', 'unknown'].includes(old.status) && ['done', 'idle'].includes(value.status))) {
        transition = 'finished'; title = `✓ ${label} finished`; sound = 'done';
      }
      const time = Number(now()), key = `${task.id}\0${transition}`;
      if (!transition || settings.enabled === false || (settings.onlyWhenUnfocused !== false && agent?.focused)
        || (delivered.has(key) && time - delivered.get(key) < 30000)) continue;
      delivered.set(key, time);
      try { Promise.resolve(controller.notify({ title, body: safeText(body ?? ''), sound: settings.sound === false ? 'none' : sound })).catch(() => {}); }
      catch { /* Controller handles its single-session failure notice. */ }
    }
    previous = current; baseline = true;
    const alive = new Set(tracked.map(task => task.id));
    for (const key of delivered.keys()) if (!alive.has(key.split('\0')[0])) delivered.delete(key);
  }
  // Establish the initial status before subscribing even for monitors whose
  // subscribe() does not immediately deliver their current snapshot.
  update(monitor.getSnapshot());
  const unsubscribe = monitor.subscribe(update);
  return { dispose() { disposed = true; unsubscribe(); previous.clear(); delivered.clear(); } };
}
