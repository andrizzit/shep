import { stripVTControlCharacters } from 'node:util';
import { safeText } from './terminal.mjs';

export const STATUS_LABELS = Object.freeze({ working: 'Working', blocked: 'Needs input', done: 'Done', idle: 'Idle', unknown: 'Unknown' });
export const FIELDS = ['provider', 'name', 'workspaceId', 'cwd', 'prompt', 'dispatch'];
const priority = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
const providerNames = new Map([['claude', 'Claude'], ['codex', 'Codex'], ['grok', 'Grok'], ['kiro', 'Kiro']]);
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = value => [...segmenter.segment(String(value))].map(item => item.segment);
export const knownStatus = agent => Object.hasOwn(STATUS_LABELS, agent?.status) ? agent.status : 'unknown';
export const providerName = provider => providerNames.get(provider) || safeText(provider || 'Other');

export function parseDispatch(command, providers) {
  const match = /^\/dispatch(?:[ \t]+([\s\S]*))?$/.exec(command);
  if (!match) throw new Error('Use /dispatch [agent:] your task. Example: /dispatch claude: review this project');
  let prompt = match[1] || '';
  let provider = 'codex';
  // The first token followed by ':' is an explicit provider. Consume at most
  // one separating space/tab after it; the rest of the prompt stays literal.
  const prefix = /^([^\s:]+):([ \t]?)([\s\S]*)$/.exec(prompt);
  const explicit = prefix && providers.find(item => item.id.toLocaleLowerCase() === prefix[1].toLocaleLowerCase());
  if (prefix && !explicit) throw new Error(`Unknown agent “${safeText(prefix[1])}”. Choose a configured provider such as codex: or claude:.`);
  if (explicit) { provider = explicit.id; prompt = prefix[3]; }
  if (!prompt.trim()) throw new Error('Add a task after /dispatch and the optional agent: prefix.');
  return { provider, prompt, explicitProvider: Boolean(explicit) };
}

export function parseMouse(input) {
  const match = /^(?:\x1b)?\[<(\d+);(\d+);(\d+)([mM])$/.exec(input);
  if (!match) return null;
  const [, button, x, y, phase] = match;
  return { button: Number(button), x: Number(x) - 1, y: Number(y) - 1, release: phase === 'm' };
}

export function hitTest(point, entries, measure) {
  return [...entries].reverse().find(entry => {
    if (!entry.ref.current) return false;
    const box = measure(entry.ref.current);
    return box.width > 0 && box.height > 0 && point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height;
  });
}

export function visibleAgents(state) {
  const query = safeText(state.query).trim().toLocaleLowerCase();
  const order = ['claude', 'codex', 'grok', 'kiro'];
  return (state.snapshot.agents || []).filter(agent => {
    if (state.filter !== 'all' && knownStatus(agent) !== state.filter) return false;
    return !query || [agent.name, agent.provider, agent.paneId, agent.workspace?.name, agent.workspace?.path].join(' ').toLocaleLowerCase().includes(query);
  }).sort((a, b) => {
    const index = provider => order.includes(provider) ? order.indexOf(provider) : order.length;
    return index(a.provider) - index(b.provider) || (index(a.provider) === order.length ? a.provider.localeCompare(b.provider) : 0) || priority[knownStatus(a)] - priority[knownStatus(b)] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

export function controlBlock(state) {
  if (state.busy) return 'An action is already in progress.';
  if (state.snapshot.mode === 'demo') return 'Demo data: agent actions are disabled.';
  if (state.snapshot.source.state !== 'connected' || !state.snapshot.updatedAt) return 'Reconnect to Herdr before controlling agents.';
  return null;
}

function cleanInput(value, multiline) {
  return stripVTControlCharacters(String(value)).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(multiline ? /\u2028|\u2029/gu : /[\n\t\u2028\u2029]/gu, multiline ? '\n' : ' ');
}

export function editText(value, cursor, input, key = {}, multiline = false) {
  const chars = graphemes(value);
  cursor = Math.max(0, Math.min(cursor, chars.length));
  const lineStart = () => chars.slice(0, cursor).lastIndexOf('\n') + 1;
  const lineEnd = () => { const index = chars.indexOf('\n', cursor); return index < 0 ? chars.length : index; };
  if (key.leftArrow) cursor = Math.max(0, cursor - 1);
  else if (key.rightArrow) cursor = Math.min(chars.length, cursor + 1);
  else if (key.home || (key.ctrl && input === 'a')) cursor = lineStart();
  else if (key.end || (key.ctrl && input === 'e')) cursor = lineEnd();
  else if (key.upArrow && multiline) {
    const start = lineStart();
    const previousStart = chars.slice(0, Math.max(0, start - 1)).lastIndexOf('\n') + 1;
    cursor = start === 0 ? 0 : previousStart + Math.min(cursor - start, start - previousStart - 1);
  } else if (key.downArrow && multiline) {
    const end = lineEnd();
    const nextEnd = chars.indexOf('\n', end + 1);
    cursor = end === chars.length ? chars.length : end + 1 + Math.min(cursor - lineStart(), (nextEnd < 0 ? chars.length : nextEnd) - end - 1);
  } else if (key.backspace && cursor > 0) { chars.splice(cursor - 1, 1); cursor -= 1; }
  else if (key.delete) chars.splice(cursor, 1);
  else if (key.ctrl && input === 'u') { const start = lineStart(); chars.splice(start, cursor - start); cursor = start; }
  else if (key.return && multiline) { chars.splice(cursor, 0, '\n'); cursor += 1; }
  else if (!key.ctrl && !key.meta && input) {
    const addition = graphemes(cleanInput(input, multiline));
    chars.splice(cursor, 0, ...addition);
    cursor += addition.length;
  }
  return { value: chars.join(''), cursor };
}

export function createTuiModel({ monitor, controller, onQuit = () => {} }) {
  let alive = true;
  let initialized = false;
  let catalogGeneration = 0;
  const subscribers = new Set();
  let state = {
    snapshot: monitor.getSnapshot(), view: 'board', selectedId: null, filter: 'all', query: '', command: '',
    field: 'provider', cursor: { name: 0, cwd: 0, prompt: 0, search: 0, command: 0 },
    draft: { provider: '', name: '', workspaceId: '', cwd: '', prompt: '' },
    profiles: { providers: [], workspaces: [], defaultCwd: '', defaultWorkspaceId: '' },
    profilesLoading: true, profilesError: null, busy: null, notice: null,
    confirmation: null, confirmClose: false, dispatchHold: false, resultTarget: null,
  };
  function change(patch) {
    if (!alive) return;
    state = { ...state, ...patch };
    const matches = visibleAgents(state);
    if (!matches.some(agent => agent.id === state.selectedId)) state = { ...state, selectedId: matches[0]?.id || null };
    for (const subscriber of subscribers) subscriber();
  }
  change({});
  const unsubscribe = monitor.subscribe(snapshot => change({ snapshot }));
  const selected = () => state.snapshot.agents.find(agent => agent.id === state.selectedId);
  function targetBlock(target, closing = false) {
    const blocked = controlBlock(state);
    if (blocked) return blocked;
    if (!target) return 'Select an agent first.';
    if (target.paneId === state.profiles.ownPaneId || (target.terminalId && target.terminalId === state.profiles.ownTerminalId)) return 'Shep cannot control its own pane.';
    const current = state.snapshot.agents.find(agent => agent.id === target.id);
    if (!current || current.paneId !== target.paneId || current.terminalId !== target.terminalId || current.provider !== target.provider) return 'This agent is no longer available. Select it again from the live list.';
    if (closing && current.status !== target.status) return 'The agent status changed. Cancel and review it before closing.';
    return null;
  }
  function inform(message, kind = 'info') { change({ notice: { message: safeText(message), kind } }); }
  async function refreshProfiles() {
    const generation = ++catalogGeneration;
    change({ profilesLoading: true, profilesError: null });
    try {
      const profiles = await controller.getProfiles();
      if (!alive || generation !== catalogGeneration) return;
      if (!Array.isArray(profiles.providers) || !Array.isArray(profiles.workspaces)) throw new Error('Herdr returned invalid launch settings.');
      const patch = { profiles, profilesLoading: false };
      if (!initialized) {
        initialized = true;
        patch.draft = { ...state.draft, provider: profiles.providers.find(provider => provider.id === 'codex' && provider.available)?.id || profiles.providers.find(provider => provider.available)?.id || profiles.providers[0]?.id || '', workspaceId: profiles.defaultWorkspaceId || profiles.workspaces[0]?.id || '', cwd: profiles.defaultCwd || '' };
        patch.cursor = { ...state.cursor, cwd: graphemes(patch.draft.cwd).length };
      }
      change(patch);
    } catch (error) { if (generation === catalogGeneration) change({ profilesLoading: false, profilesError: safeText(error.message || 'Unable to read launch settings.') }); }
  }
  async function run(kind, target, partial = false) {
    const blocked = partial ? controlBlock(state) || (target?.paneId === state.profiles.ownPaneId ? 'Shep cannot focus its own pane.' : null) : targetBlock(target, kind === 'closeAgent');
    if (blocked) { inform(blocked, 'warning'); return; }
    change({ busy: kind, notice: { message: kind === 'focus' ? 'Focusing agent…' : 'Closing agent…', kind: 'info' } });
    try {
      const outcome = await controller[kind](structuredClone(target));
      change({ busy: null, notice: { message: safeText(outcome.message), kind: outcome.ok ? 'success' : 'warning' }, ...(kind === 'closeAgent' && outcome.ok ? { view: 'board', confirmation: null } : {}) });
    } catch (error) { change({ busy: null, notice: { message: safeText(error.message || 'The action failed. Check Herdr before retrying.'), kind: 'warning' } }); }
  }
  async function dispatch() {
    const blocked = controlBlock(state);
    if (blocked) { inform(blocked, 'warning'); return; }
    if (state.dispatchHold) { inform('Review the previous launch, then use “Allow another launch” before dispatching again.', 'warning'); return; }
    const provider = state.profiles.providers.find(item => item.id === state.draft.provider);
    if (state.profilesLoading || state.profilesError) { inform('Wait for launch settings or refresh them with Ctrl+R.', 'warning'); return; }
    if (!provider?.available) { inform(provider?.reason || 'This provider executable is unavailable.', 'warning'); return; }
    if (!state.draft.prompt.trim()) { change({ field: 'prompt' }); inform('Add a prompt before dispatching.', 'warning'); return; }
    if (Buffer.byteLength(state.draft.prompt, 'utf8') > 65536) { change({ field: 'prompt' }); inform('The prompt exceeds 65536 UTF-8 bytes. Shorten it before dispatching.', 'warning'); return; }
    if (state.draft.name.trim() && !/^[a-z][a-z0-9_-]{0,31}$/.test(state.draft.name.trim())) { change({ field: 'name' }); inform('Names start with a-z and use a-z, 0-9, _ or -; maximum 32 characters.', 'warning'); return; }
    if (!state.draft.cwd.trim()) { change({ field: 'cwd' }); inform('Choose a working directory.', 'warning'); return; }
    const draft = { ...state.draft };
    change({ busy: 'dispatch', notice: { message: 'Starting a native Herdr agent…', kind: 'info' } });
    try {
      const result = await controller.dispatch({ provider: draft.provider, prompt: draft.prompt, cwd: draft.cwd, ...(draft.name.trim() ? { name: draft.name.trim() } : {}), ...(draft.workspaceId ? { workspaceId: draft.workspaceId } : {}) });
      const successful = result.ok && result.state === 'submitted';
      const hold = !successful && (result.state === 'uncertain' || result.state === 'needs_input' || Boolean(result.paneId));
      const target = result.paneId ? { ...result, id: result.terminalId || result.paneId, paneId: result.paneId, terminalId: result.terminalId, provider: draft.provider, name: result.agentName || draft.name || provider.name, status: 'unknown', workspace: { id: draft.workspaceId, path: draft.cwd } } : null;
      change({ busy: null, notice: { message: safeText(`${result.message}${result.paneId ? ` Pane: ${result.paneId}.` : ''}`), kind: successful ? 'success' : 'warning' }, dispatchHold: hold, resultTarget: target,
        ...(successful ? { view: 'board', command: '', draft: { ...draft, name: '', prompt: '' }, cursor: { ...state.cursor, name: 0, prompt: 0, command: 0 } } : {}) });
    } catch (error) {
      change({ busy: null, dispatchHold: true, notice: { message: safeText(`${error.message || 'Launch outcome unavailable.'} Check Herdr before another launch; your prompt is preserved.`), kind: 'warning' } });
    }
  }
  function submitCommand() {
    if (controlBlock(state)) { inform(controlBlock(state), 'warning'); return; }
    if (state.profilesLoading || state.profilesError) { inform('Launch settings are unavailable. Use Ctrl+R to refresh them.', 'warning'); return; }
    try {
      const parsed = parseDispatch(state.command, state.profiles.providers);
      const provider = state.profiles.providers.find(item => item.id === parsed.provider);
      if (!provider?.available) { inform(`${provider?.name || parsed.provider}: ${provider?.reason || 'This provider executable is unavailable.'}`, 'warning'); return; }
      change({ draft: { ...state.draft, provider: parsed.provider, name: '', prompt: parsed.prompt }, cursor: { ...state.cursor, prompt: graphemes(parsed.prompt).length } });
      void dispatch();
    } catch (error) { inform(error.message, 'warning'); }
  }
  function edit(input, key = {}, paste = false) {
    const field = state.view === 'search' ? 'search' : state.view === 'command' ? 'command' : state.field;
    if (!['name', 'cwd', 'prompt', 'search', 'command'].includes(field)) return;
    const value = field === 'search' ? state.query : field === 'command' ? state.command : state.draft[field];
    const edited = editText(value, state.cursor[field], input, paste ? {} : key, field === 'prompt' || field === 'command');
    if (Buffer.byteLength(edited.value, 'utf8') > 256 * 1024) { inform('This draft exceeds 256 KiB. Paste a smaller prompt.', 'warning'); return; }
    change({ cursor: { ...state.cursor, [field]: edited.cursor }, ...(field === 'search' ? { query: edited.value } : field === 'command' ? { command: edited.value } : { draft: { ...state.draft, [field]: edited.value } }) });
  }
  function cycleField(direction = 1) {
    const index = FIELDS.indexOf(state.field);
    change({ field: FIELDS[(index + direction + FIELDS.length) % FIELDS.length] });
  }
  function cycleChoice(direction = 1) {
    const list = state.field === 'provider' ? state.profiles.providers : state.profiles.workspaces;
    if (!list.length) return;
    const index = list.findIndex(item => item.id === state.draft[state.field]);
    const next = list[(index + direction + list.length) % list.length];
    const draft = { ...state.draft, [state.field]: next.id };
    if (state.field === 'workspaceId' && next.path) draft.cwd = next.path;
    change({ draft, cursor: { ...state.cursor, cwd: graphemes(draft.cwd).length } });
  }
  function moveSelection(direction) {
    const agents = visibleAgents(state);
    if (!agents.length) return;
    const index = agents.findIndex(agent => agent.id === state.selectedId);
    change({ selectedId: agents[Math.max(0, Math.min(agents.length - 1, index + direction))].id });
  }
  function action(name, value) {
    if (name === 'quit') { onQuit(); return; }
    if (state.view === 'command' && ['select', 'focus', 'close', 'new', 'search', 'filter'].includes(name)) return;
    if (name === 'command') { const command = state.command || '/dispatch '; change({ view: 'command', command, cursor: { ...state.cursor, command: graphemes(command).length } }); return; }
    if (name === 'select') { if (state.view === 'board' || state.view === 'search') change({ selectedId: value }); return; }
    if (name === 'field') { if (state.view === 'compose') { if (state.field === value && ['provider', 'workspaceId'].includes(value)) cycleChoice(1); else change({ field: value }); } return; }
    if (name === 'refresh') { void monitor.refresh(); if (state.view === 'compose' || state.view === 'command') void refreshProfiles(); return; }
    if (name === 'search') { change({ view: 'search', cursor: { ...state.cursor, search: graphemes(state.query).length } }); return; }
    if (name === 'filter') { const filters = ['all', ...Object.keys(STATUS_LABELS)]; change({ filter: filters[(filters.indexOf(state.filter) + 1) % filters.length] }); return; }
    if (name === 'new') { change({ view: 'compose', field: state.draft.prompt ? 'prompt' : 'provider', confirmation: null }); return; }
    if (name === 'cancel') { if (!state.busy) change({ view: 'board', confirmation: null }); return; }
    if (name === 'move') { moveSelection(value); return; }
    if (name === 'choice') { cycleChoice(value); return; }
    if (name === 'allow-launch') { if (!state.busy) change({ dispatchHold: false, resultTarget: null, notice: { kind: 'warning', message: 'Another launch is enabled. The preserved prompt will create a new agent.' } }); return; }
    if (name === 'focus-result') {
      const target = state.snapshot.agents.find(agent => agent.paneId === state.resultTarget?.paneId && (!state.resultTarget.terminalId || agent.terminalId === state.resultTarget.terminalId));
      if (target) void run('focus', target);
      else if (state.resultTarget?.paneId && state.resultTarget.terminalId) void run('focus', state.resultTarget, true);
      else inform('The created agent has no confirmed identity yet. Check its Herdr pane before focusing it.', 'warning');
      return;
    }
    if (name === 'dispatch') { void dispatch(); return; }
    if (name === 'focus') { const target = selected(); void run('focus', target); return; }
    if (name === 'close') {
      const target = selected();
      const blocked = targetBlock(target);
      if (blocked) inform(blocked, 'warning');
      else change({ view: 'confirm', confirmation: structuredClone(target), confirmClose: false });
      return;
    }
    if (name === 'confirm-close') { void run('closeAgent', state.confirmation); return; }
  }
  function key(input, key = {}) {
    if (key.eventType === 'release') return;
    // Ink can deliver typed text and a following Enter/Tab in the same chunk.
    // Bracketed paste has its own channel and never enters this branch.
    if (input.length > 1 && /[\r\n\t\x03\x04\x13]/.test(input)) {
      for (const part of input.split(/([\r\n\t\x03\x04\x13])/u).filter(Boolean)) {
        if (part === '\r' || part === '\n') modelKey('', { return: true });
        else if (part === '\t') modelKey('', { tab: true });
        else if (part === '\x03' || part === '\x04' || part === '\x13') modelKey(part === '\x03' ? 'c' : part === '\x04' ? 'd' : 's', { ctrl: true });
        else modelKey(part, {});
      }
      return;
    }
    if (key.ctrl && (input === 'c' || input === 'd')) { action('quit'); return; }
    if (state.busy) return;
    if (key.ctrl && input === 'r') { action('refresh'); return; }
    if (['command', 'compose'].includes(state.view) && key.ctrl && input === 'y' && state.dispatchHold) { action('allow-launch'); return; }
    if (['command', 'compose'].includes(state.view) && key.ctrl && input === 'f' && state.resultTarget) { action('focus-result'); return; }
    if (state.view === 'command') {
      if (key.escape) change({ view: 'board' });
      else if (key.return) submitCommand();
      else edit(input, key);
      return;
    }
    if (state.view === 'confirm') {
      if (key.escape || input === 'n') action('cancel');
      else if (key.tab || key.leftArrow || key.rightArrow) change({ confirmClose: !state.confirmClose });
      else if (input === 'y') action('confirm-close');
      else if (key.return) action(state.confirmClose ? 'confirm-close' : 'cancel');
      return;
    }
    if (state.view === 'compose') {
      if (key.escape) { action('cancel'); return; }
      if (key.ctrl && input === 's') { action('dispatch'); return; }
      if (key.tab) { cycleField(key.shift ? -1 : 1); return; }
      if (['provider', 'workspaceId'].includes(state.field)) {
        if (key.leftArrow || key.upArrow) cycleChoice(-1);
        else if (key.rightArrow || key.downArrow || input === ' ') cycleChoice(1);
        else if (key.return) cycleField();
      } else if (state.field === 'dispatch') {
        if (key.return || input === ' ') action('dispatch');
        else if (input === 'a' && state.dispatchHold) action('allow-launch');
        else if (input === 'f' && state.resultTarget) action('focus-result');
      } else if (key.return && state.field !== 'prompt') cycleField();
      else edit(input, key);
      return;
    }
    if (state.view === 'search') {
      if (key.escape) change({ view: 'board', query: '' });
      else if (key.return) change({ view: 'board' });
      else edit(input, key);
      return;
    }
    if (input === 'q') action('quit');
    else if (input === 'n') action('new');
    else if (input.startsWith('/') && !key.ctrl && !key.meta) { change({ view: 'command', command: input, cursor: { ...state.cursor, command: graphemes(input).length } }); }
    else if (input === 's') action('search');
    else if (input === 'f') action('filter');
    else if (input === 'r') action('refresh');
    else if (input === 'x') action('close');
    else if (key.return) action('focus');
    else if (key.downArrow || input === 'j' || key.tab && !key.shift) moveSelection(1);
    else if (key.upArrow || input === 'k' || key.tab && key.shift) moveSelection(-1);
    else if (key.pageDown) moveSelection(5);
    else if (key.pageUp) moveSelection(-5);
    else if (key.home) change({ selectedId: visibleAgents(state)[0]?.id || null });
    else if (key.end) change({ selectedId: visibleAgents(state).at(-1)?.id || null });
    else if (key.escape) change({ query: '', filter: 'all' });
  }
  const modelKey = key;
  const ready = refreshProfiles();
  return { getSnapshot: () => state, subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
    action, key, paste: text => {
      if (state.busy) return;
      if (state.view === 'board' && text.startsWith('/dispatch')) { change({ view: 'command', command: '', cursor: { ...state.cursor, command: 0 } }); edit(text, {}, true); }
      else if (['compose', 'search', 'command'].includes(state.view)) edit(text, {}, true);
    }, ready,
    selected, targetBlock, destroy: () => { alive = false; catalogGeneration += 1; unsubscribe(); subscribers.clear(); } };
}
