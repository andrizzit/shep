import { HerdrReadError, readHerdrSnapshot } from './herdr.mjs';

export function createMonitor({ read = readHerdrSnapshot, intervalMs = 2000, mode = 'live', scope = 'Current Herdr session' } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new TypeError('intervalMs must be positive');
  if (!['live', 'demo'].includes(mode)) throw new TypeError('mode must be live or demo');
  let snapshot = {
    schemaVersion: 1,
    mode,
    source: { name: mode === 'demo' ? 'Sample data' : 'Herdr', state: 'connecting', message: null, version: null, scope },
    updatedAt: null,
    polledAt: null,
    refreshIntervalMs: intervalMs,
    agents: [],
  };
  let running = false;
  let timer = null;
  let inFlight = null;
  let generation = 0;
  const subscribers = new Set();

  function getSnapshot() {
    return structuredClone(snapshot);
  }

  function publish() {
    for (const callback of subscribers) {
      // A disconnected consumer must not turn a successful host read into a failure.
      try { callback(getSnapshot()); } catch { /* Subscriber owns its failure handling. */ }
    }
  }

  function refresh() {
    if (inFlight) return inFlight;
    const currentGeneration = generation;
    inFlight = Promise.resolve().then(read).then((result) => {
      if (!result || !Array.isArray(result.agents)) throw new Error('Invalid monitor reader');
      if (generation !== currentGeneration) return;
      const now = new Date().toISOString();
      snapshot = {
        ...snapshot,
        source: { ...snapshot.source, state: 'connected', message: null, version: result.version ?? null },
        agents: structuredClone(result.agents),
        updatedAt: now,
        polledAt: now,
      };
    }).catch((error) => {
      if (generation !== currentGeneration) return;
      snapshot = {
        ...snapshot,
        source: {
          ...snapshot.source,
          state: 'disconnected',
          message: error instanceof HerdrReadError ? error.message : 'Unable to refresh the agent list. Check the Herdr connection.',
        },
        polledAt: new Date().toISOString(),
      };
    }).then(() => {
      if (generation === currentGeneration) publish();
      return getSnapshot();
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function tick() {
    const currentGeneration = generation;
    return refresh().finally(() => {
      if (running && generation === currentGeneration) timer = setTimeout(tick, intervalMs);
    });
  }

  function start() {
    if (running) return inFlight ?? Promise.resolve(getSnapshot());
    running = true;
    generation += 1;
    return tick();
  }

  function stop() {
    running = false;
    generation += 1;
    clearTimeout(timer);
    timer = null;
  }

  function subscribe(callback) {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  return { start, stop, refresh, getSnapshot, subscribe };
}
