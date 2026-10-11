import { PROVIDERS } from './dispatch/contracts.mjs';
import { safeText } from './terminal.mjs';
import { sessionMatches, trustedSession } from './agent-identity.mjs';

// Match the same optional identity constraints as tasks.mjs identify(). A pane
// and terminal can survive an agent replacement, so neither alone is sufficient.
const matches = (target, agent) => target && agent.paneId === target.paneId && agent.terminalId === target.terminalId
  && (!target.provider || agent.provider === target.provider)
  && (!target.agentName || agent.agentName === target.agentName || agent.name === target.agentName)
  && sessionMatches(target.provider ?? agent.provider, target.sessionId, agent.sessionId);
const identity = (target, provider) => JSON.stringify([target?.paneId, target?.terminalId, target?.provider ?? null,
  target?.agentName ?? null, trustedSession(target?.provider ?? provider, target?.sessionId) ?? null]);

// Watches metadata only; the caller owns lifecycle/config-reload wiring.
export function createNotifier({ monitor, controller, config, getTasks = () => [], now = Date.now } = {}) {
  let disposed = false, baseline = false;
  let previous = new Map();
  const delivered = new Map();
  const names = new Map(PROVIDERS.map(provider => [provider.id, provider.name]));
  function update(snapshot) {
    if (disposed) return;
    if (snapshot?.source?.state !== 'connected' || snapshot.mode === 'demo') {
      for (const value of previous.values()) delete value.idleSince;
      return;
    }
    const time = Number(now());
    const settings = config?.notifications ?? {};
    const tasks = getTasks();
    const tracked = tasks.map(task => ({
      id: task.id, target: task.target, project: task.project?.name ?? 'Project', provider: task.agent?.provider,
      label: task.intent?.label ?? task.name ?? '', launch: task.launch, observedActivity: task.observedActivity,
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
      const value = { status: agent?.status ?? 'unknown', observed: Boolean(agent), identity: identity(task.target, task.provider), launch: task.launch?.state,
        launchCode: task.launch?.code ?? null, delivery: task.launch?.delivery, paneId: task.target?.paneId ?? null, terminalId: task.target?.terminalId ?? null };
      const old = previous.get(task.id);
      const setup = value.launch === 'needs_input' && old?.launch !== 'needs_input';
      const uncertain = value.launch === 'uncertain' && (value.delivery === 'launch' || value.launchCode === 'agent_prompt_stalled')
        && (old?.launch !== 'uncertain' || old?.launchCode !== value.launchCode || old?.delivery !== value.delivery);
      const sameTarget = old?.identity === value.identity;
      value.observedActivity = Boolean(task.observedActivity || (sameTarget && old.observedActivity)
        || (value.observed && ['working', 'done'].includes(value.status)));
      const startupIdle = value.delivery === 'launch' && value.observed && value.status === 'idle' && !value.observedActivity;
      // Monitor polls supply the clock: no new timer or screen inspection. A
      // baseline idle stays silent; newly opened idle agents get five seconds.
      value.idleSince = startupIdle ? (sameTarget && old.idleSince !== undefined ? old.idleSince : baseline ? time : null) : undefined;
      const delayedIdle = startupIdle && Number.isFinite(value.idleSince) && time - value.idleSince >= 5000;
      // A setup/stalled outcome and its later blocked metadata describe one
      // attention episode. Observed work or completion ends that episode.
      value.attention = setup || uncertain || delayedIdle || value.status === 'blocked'
        || (sameTarget && old.attention && !(value.observed && ['working', 'done'].includes(value.status)));
      current.set(task.id, value);
      if (!baseline || !value.paneId || !value.terminalId || replaced) continue;
      // An idle shell may precede execution. Only a real agent's done status
      // supports first-observation completion; synthetic unknown is no evidence.
      const firstCompletion = value.launch === 'submitted' && value.observed && value.status === 'done'
        && (!old?.paneId || (sameTarget && !old.observed));
      // A dispatched agent can reach an input prompt before its outcome binds
      // the target. Its first blocked observation still needs attention.
      const firstBlocked = ['submitted', 'uncertain'].includes(value.launch) && value.observed && value.status === 'blocked'
        && (!old?.paneId || (sameTarget && !old.observed));
      if (!setup && !uncertain && !delayedIdle && !firstCompletion && !firstBlocked && !sameTarget) continue;
      let transition, title, body = task.label, sound;
      const label = `${safeText(task.project)} · ${safeText(names.get(task.provider) ?? task.provider ?? 'Agent')}`;
      if ((setup || uncertain || delayedIdle || (old?.status !== 'blocked' && value.status === 'blocked'))
        && !(sameTarget && old?.attention)) {
        transition = 'attention'; title = `⚠ ${label} · Needs you`;
        if (setup || uncertain) body = task.launch.message;
        else if (delayedIdle) body = 'Check the agent pane · Enter to open';
        sound = 'request';
      } else if (!startupIdle && (firstCompletion || (sameTarget && old.observed && value.observed
        && ['working', 'unknown'].includes(old.status) && ['done', 'idle'].includes(value.status)))) {
        transition = 'finished'; title = `✓ ${label} finished`; sound = 'done';
      }
      const key = `${task.id}\0${transition}`;
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
