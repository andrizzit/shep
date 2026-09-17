const STATUS = { working: 'Working', blocked: 'Needs input', done: 'Done', idle: 'Idle', unknown: 'Unknown' };
const PRIORITY = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
const PROVIDERS = { claude: { name: 'Claude', icon: '✳' }, codex: { name: 'Codex', icon: '⌘' }, kiro: { name: 'Kiro', icon: 'K' } };
const el = (id) => document.getElementById(id);
const groups = new Map();
const cards = new Map();
let snapshot = null;
let transportError = null;
let filter = 'all';
let query = '';
let inFlight = false;
let timer = null;

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function setText(id, value) { el(id).textContent = value; }
function providerInfo(id) {
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : { name: id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Other', icon: (id || '?').charAt(0).toUpperCase() };
}
function statusOf(agent) { return Object.hasOwn(STATUS, agent.status) ? agent.status : 'unknown'; }
function timestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
function age(value) {
  const time = timestamp(value);
  if (time === null) return 'Time unavailable';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function exactTime(value) {
  const time = timestamp(value);
  return time === null ? 'Time unavailable' : new Date(time).toLocaleString();
}
function sourceState() {
  if (transportError) return 'disconnected';
  return snapshot?.source?.state || 'connecting';
}
function hasData() { return Boolean(snapshot?.updatedAt); }

function createGroup(provider) {
  const section = node('section', 'provider-group');
  const header = node('div', 'provider-header');
  const info = providerInfo(provider);
  const icon = node('span', 'provider-icon', info.icon);
  icon.dataset.provider = Object.hasOwn(PROVIDERS, provider) ? provider : 'other';
  icon.setAttribute('aria-hidden', 'true');
  const heading = node('h3', '', info.name);
  const count = node('span', 'provider-count', '0');
  count.setAttribute('aria-label', '0 agents');
  header.append(icon, heading, count);
  const list = node('div', 'provider-cards');
  const empty = node('p', 'provider-empty');
  section.append(header, list, empty);
  section.setAttribute('aria-label', `${info.name} agents`);
  const group = { section, list, empty, count };
  groups.set(provider, group);
  return group;
}

function createCard(id) {
  const article = node('article', 'agent-card');
  article.dataset.agentId = id;
  const top = node('div', 'agent-card-top');
  const name = node('h4', 'agent-name');
  const badge = node('span', 'status-badge');
  const dot = node('span', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  const status = node('span');
  badge.append(dot, status);
  top.append(name, badge);
  const workspace = node('p', 'workspace-name');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('class', 'folder-icon');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2 4.5V3h4l1.5 2H14v8H2V4.5Z');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.2');
  path.setAttribute('stroke-linejoin', 'round');
  icon.append(path);
  const workspaceName = node('span');
  workspace.append(icon, workspaceName);
  const workspacePath = node('p', 'workspace-path');
  const footer = node('div', 'agent-card-footer');
  const identity = node('span', 'agent-identity');
  const lastSeen = node('span', 'last-seen');
  footer.append(identity, lastSeen);
  article.append(top, workspace, workspacePath, footer);
  const card = { article, name, badge, dot, status, workspaceName, workspacePath, identity, lastSeen };
  cards.set(id, card);
  return card;
}

function updateCard(agent) {
  const card = cards.get(agent.id) || createCard(agent.id);
  const status = statusOf(agent);
  card.article.dataset.status = status;
  card.name.textContent = agent.name || providerInfo(agent.provider).name;
  card.badge.dataset.status = status;
  card.dot.dataset.status = status;
  card.status.textContent = STATUS[status];
  card.badge.title = status === 'done' ? 'Completed and not yet marked seen in Herdr.' : status === 'unknown' ? 'Herdr has not established this agent’s activity.' : STATUS[status];
  card.workspaceName.textContent = agent.workspace?.name || 'Workspace unavailable';
  card.workspacePath.textContent = agent.workspace?.path || 'Workspace path unavailable';
  card.identity.textContent = agent.paneId || agent.id;
  card.identity.title = `Session: ${agent.id}`;
  card.lastSeen.textContent = `Seen ${age(agent.lastSeenAt)}`;
  card.lastSeen.title = exactTime(agent.lastSeenAt);
  card.lastSeen.setAttribute('aria-label', `Last seen ${exactTime(agent.lastSeenAt)}`);
  return card;
}

function renderHealth() {
  const state = sourceState();
  const demo = snapshot?.mode === 'demo';
  const badgeState = state === 'connected' && demo ? 'demo' : state;
  el('connection-badge').dataset.state = badgeState;
  setText('connection-text', state === 'disconnected' ? 'Connection lost' : state === 'connecting' ? 'Connecting' : demo ? 'Demo mode' : 'Live connection');
  el('mode-banner').hidden = !demo;
  setText('source-name', demo ? 'Sample session' : `${snapshot?.source?.name || 'Herdr'}${snapshot?.source?.version ? ` ${snapshot.source.version}` : ''}`);
  setText('source-scope', snapshot?.source?.scope || 'Current Herdr session');
  el('notice').hidden = state === 'connected';
  el('notice').dataset.kind = state;
  el('retry-button').hidden = state !== 'disconnected';
  el('retry-button').disabled = inFlight;
  if (state === 'disconnected') {
    setText('notice-title', hasData() ? 'Connection interrupted. Showing the last known snapshot.' : 'Unable to connect to your agents.');
    const detail = transportError || snapshot?.source?.message || 'Herdr is unavailable. Check that your Herdr session is running.';
    setText('notice-message', `${detail}${hasData() ? ` Data may be stale. Last success: ${exactTime(snapshot.updatedAt)}.` : ''}`);
  } else if (state === 'connecting') {
    setText('notice-title', 'Connecting to your agents…');
    setText('notice-message', 'Getting the latest snapshot from Herdr.');
  }
  const interval = Math.max(1, Math.round((snapshot?.refreshIntervalMs || 2000) / 1000));
  setText('updated-label', `${hasData() ? `Last updated ${age(snapshot.updatedAt)}` : 'Waiting for Herdr'} · Refreshes every ${interval}s`);
  el('updated-label').title = hasData() ? exactTime(snapshot.updatedAt) : 'No successful snapshot yet';
}

function render() {
  renderHealth();
  const agents = snapshot?.agents || [];
  const available = hasData();
  setText('total-count', available ? agents.length : '—');
  setText('working-count', available ? agents.filter((agent) => statusOf(agent) === 'working').length : '—');
  setText('blocked-count', available ? agents.filter((agent) => statusOf(agent) === 'blocked').length : '—');
  const workspaces = new Set(agents.map((agent) => agent.workspace?.id || agent.workspace?.path).filter(Boolean));
  setText('workspace-count', available ? workspaces.size : '—');
  setText('filter-all-count', available ? agents.length : '—');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = agents.filter((agent) => {
    if (filter !== 'all' && statusOf(agent) !== filter) return false;
    const haystack = [agent.name, agent.provider, providerInfo(agent.provider).name, agent.workspace?.name, agent.workspace?.path, agent.paneId].filter(Boolean).join(' ').toLocaleLowerCase();
    return !normalizedQuery || haystack.includes(normalizedQuery);
  });
  matches.sort((a, b) => PRIORITY[statusOf(a)] - PRIORITY[statusOf(b)] || (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id));
  setText('visible-count', available ? `${matches.length} of ${agents.length} agent${agents.length === 1 ? '' : 's'} shown` : 'Waiting for a snapshot');
  const filtered = filter !== 'all' || Boolean(normalizedQuery);
  const empty = available && matches.length === 0;
  el('empty-state').hidden = !empty;
  el('clear-filters').hidden = !filtered;
  setText('empty-title', agents.length === 0 ? 'No agents found yet' : 'No sessions match your filters');
  setText('empty-message', agents.length === 0 ? 'Run a coding agent inside this Herdr session and it will appear here. Shep can only see agents managed by this session.' : 'Try another workspace or agent name, or clear your filters to see the whole herd.');
  const providers = [...new Set(['claude', 'codex', 'kiro', ...agents.map((agent) => agent.provider)])];
  const extra = providers.filter((id) => !Object.hasOwn(PROVIDERS, id)).sort((a, b) => a.localeCompare(b));
  const ordered = ['claude', 'codex', 'kiro', ...extra];
  const validIds = new Set(agents.map((agent) => agent.id));
  for (const [id, card] of cards) {
    if (!validIds.has(id)) { card.article.remove(); cards.delete(id); }
  }
  for (const [id, group] of groups) {
    if (!ordered.includes(id)) { group.section.remove(); groups.delete(id); }
  }
  for (const provider of ordered) {
    const group = groups.get(provider) || createGroup(provider);
    const visible = matches.filter((agent) => agent.provider === provider);
    group.count.textContent = available ? visible.length : '—';
    group.count.setAttribute('aria-label', available ? `${visible.length} agents shown` : 'Loading agents');
    group.empty.hidden = visible.length > 0;
    group.empty.textContent = !available ? sourceState() === 'disconnected' ? 'Waiting for a connection' : 'Checking for sessions…' : filtered ? 'No matching sessions' : `No ${providerInfo(provider).name} sessions`;
    const wanted = new Set(visible.map((agent) => agent.id));
    for (const child of [...group.list.children]) {
      if (!wanted.has(child.dataset.agentId)) child.remove();
    }
    for (let index = 0; index < visible.length; index += 1) {
      const card = updateCard(visible[index]);
      if (group.list.children[index] !== card.article) group.list.insertBefore(card.article, group.list.children[index] || null);
    }
    const index = ordered.indexOf(provider);
    if (el('agent-board').children[index] !== group.section) el('agent-board').insertBefore(group.section, el('agent-board').children[index] || null);
  }
}

function validateSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.agents) || !value.source || !['connected', 'connecting', 'disconnected'].includes(value.source.state) || !['live', 'demo'].includes(value.mode)) throw new Error('The local server returned an unsupported snapshot.');
  const ids = new Set();
  for (const agent of value.agents) {
    if (!agent || typeof agent.id !== 'string' || !agent.id || ids.has(agent.id) || typeof agent.provider !== 'string' || typeof agent.name !== 'string') throw new Error('The local server returned an invalid agent snapshot.');
    ids.add(agent.id);
  }
  return value;
}

async function refresh() {
  if (inFlight) return;
  clearTimeout(timer);
  inFlight = true;
  el('retry-button').disabled = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5500);
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`The local server returned HTTP ${response.status}.`);
    snapshot = validateSnapshot(await response.json());
    transportError = null;
  } catch (error) {
    transportError = error.name === 'AbortError' ? 'The local server took too long to respond.' : error instanceof TypeError ? 'The local Shep server could not be reached. Check that Shep is still running.' : error.message || 'The local Shep server could not be reached.';
  } finally {
    clearTimeout(timeout);
    inFlight = false;
    render();
    timer = setTimeout(refresh, Math.max(1000, Math.min(10000, snapshot?.refreshIntervalMs || 2000)));
  }
}

for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    for (const item of document.querySelectorAll('[data-filter]')) {
      const selected = item === button;
      item.classList.toggle('is-active', selected);
      item.setAttribute('aria-pressed', String(selected));
    }
    render();
  });
}
el('search-input').addEventListener('input', (event) => { query = event.target.value; render(); });
el('retry-button').addEventListener('click', refresh);
el('clear-filters').addEventListener('click', () => {
  query = '';
  el('search-input').value = '';
  document.querySelector('[data-filter="all"]').click();
  el('search-input').focus();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
render();
refresh();
