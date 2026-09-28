import { PROVIDERS } from './dispatch/contracts.mjs';
import { safeText } from './terminal.mjs';

// Watches metadata only. Wiring into the application lifecycle belongs to D5.
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
      if (!tracked.some(task => task.target?.paneId === agent.paneId && task.target?.terminalId === agent.terminalId)) {
        tracked.push({ id: `external:${agent.paneId}:${agent.terminalId}`, target: agent,
          project: agent.workspace?.name ?? 'Workspace', provider: agent.provider, label: agent.name });
      }
    }
    const current = new Map();
    for (const task of tracked) {
      const agent = snapshot.agents?.find(a => a.paneId === task.target?.paneId && a.terminalId === task.target?.terminalId);
      const value = { status: agent?.status ?? 'unknown', observed: Boolean(agent), launch: task.launch?.state, paneId: task.target?.paneId ?? null, terminalId: task.target?.terminalId ?? null };
      current.set(task.id, value);
      const old = previous.get(task.id);
      if (!baseline || !value.paneId || !value.terminalId) continue;
      const setup = value.launch === 'needs_input' && old?.launch !== 'needs_input';
      const sameTarget = old?.paneId === value.paneId && old?.terminalId === value.terminalId;
      // An idle shell may precede execution. Only a real agent's done status
      // supports first-observation completion; synthetic unknown is no evidence.
      const firstCompletion = value.launch === 'submitted' && value.observed && value.status === 'done'
        && (!old?.paneId || (sameTarget && !old.observed));
      if (!setup && !firstCompletion && !sameTarget) continue;
      let transition, title, body = task.label, sound;
      const label = `${safeText(task.project)} · ${safeText(names.get(task.provider) ?? task.provider ?? 'Agent')}`;
      if (setup) {
        transition = 'setup'; title = `⚠ ${label} needs setup`; body = task.launch.message; sound = 'request';
      } else if (old?.status !== 'blocked' && value.status === 'blocked') {
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
