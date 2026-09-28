import { stripVTControlCharacters } from 'node:util';
import { safeText } from './terminal.mjs';
import { createTaskSession, taskRows, commandSuggestions, TASK_LABELS } from './tui-tasks.mjs';

export const STATUS_LABELS = Object.freeze({ working: 'Working', blocked: 'Needs input', done: 'Done', idle: 'Idle', unknown: 'Unknown' });
export const FIELDS = ['provider', 'projectKey', 'subfolder', 'name', 'prompt', 'dispatch'];
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

export function createTuiModel({ monitor, controller, registry, getConfig, reloadConfig, addTrustedRepo, summarize, acknowledgeNotice, now, onQuit = () => {} }) {
  let alive = true;
  let initialized = false;
  let catalogGeneration = 0;
  const subscribers = new Set();
  let state = {
    snapshot: monitor.getSnapshot(), view: 'board', boardView: 'tasks', selectedTaskId: null, selectedId: null, filter: 'all', query: '', command: '',
    field: 'provider', cursor: { name: 0, subfolder: 0, prompt: 0, search: 0, command: 0, projectQuery: 0, folderPath: 0 },
    draft: { provider: '', name: '', projectKey: '', subfolder: '', prompt: '' },
    profiles: { providers: [], workspaces: [], defaultCwd: '', defaultWorkspaceId: '' },
    profilesLoading: true, profilesError: null, busy: null, notice: null,
    confirmation: null, confirmClose: false, dispatchHold: false, resultTarget: null,
    tasks: [], projects: [], trustRequired: [], projectsLoading: true, projectsError: null, projectWarnings: [],
    decision: null, requiredNotice: null, detailOffset: 0, projectQuery: '', pickerIndex: 0, folderPath: '', folderLoading: false,
    suggestions: [], suggestionIndex: 0, recall: [], recallIndex: null, recallDraft: '',
  };
  function change(patch) {
    if (!alive) return;
    state = { ...state, ...patch };
    const matches = visibleAgents(state);
    if (!matches.some(agent => agent.id === state.selectedId)) state = { ...state, selectedId: matches[0]?.id || null };
    const rows = taskRows(state);
    if (!rows.some(row => row.id === state.selectedTaskId)) state = { ...state, selectedTaskId: rows[0]?.id || null };
    for (const subscriber of subscribers) subscriber();
  }
  change({});
  const session = createTaskSession({ controller, registry, getConfig, reloadConfig, addTrustedRepo, summarize, acknowledgeNotice, now, read: () => state, change, inform });
  const unsubscribe = monitor.subscribe(snapshot => { change({ snapshot }); session.observe(snapshot); });
  const selected = () => state.boardView === 'tasks' ? taskRows(state).find(row => row.id === state.selectedTaskId)?.agent : state.snapshot.agents.find(agent => agent.id === state.selectedId);
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
        patch.draft = { ...state.draft, provider: profiles.providers.find(provider => provider.id === 'codex' && provider.available)?.id || profiles.providers.find(provider => provider.available)?.id || profiles.providers[0]?.id || '' };

      }
      change(patch);
      session.initializeProject();
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
  async function dispatch(source = 'compose') {
    const blocked = controlBlock(state);
    if (blocked) { inform(blocked, 'warning'); return; }
    if (state.dispatchHold) { inform('Review the previous launch, then use “Allow another launch” before dispatching again.', 'warning'); return; }
    if (state.profilesLoading || state.profilesError) { inform('Launch settings are unavailable. Use Ctrl+R to refresh them.', 'warning'); return; }
    await session.submit(source);
  }
  const submitCommand = () => { void dispatch('command'); };
  function updateSuggestions() {
    const cursor = graphemes(state.command).slice(0, state.cursor.command).join('').length;
    change({ suggestions: commandSuggestions(state.command, cursor, session.context()), suggestionIndex: 0 });
  }
  function acceptSuggestion(index = state.suggestionIndex) {
    const suggestion = state.suggestions[index];
    if (!suggestion) return;
    const command = state.command.slice(0, suggestion.replaceStart) + suggestion.value + state.command.slice(suggestion.replaceEnd);
    const cursor = graphemes(command.slice(0, suggestion.replaceStart + suggestion.value.length)).length;
    change({ command, cursor: { ...state.cursor, command: cursor }, recallIndex: null });
    updateSuggestions();
  }
  function recall(direction) {
    if (state.command.includes('\n') || !state.recall.length) return false;
    const index = state.recallIndex === null ? state.recall.length : state.recallIndex;
    const next = Math.max(0, Math.min(state.recall.length, index + direction));
    const recallDraft = state.recallIndex === null ? state.command : state.recallDraft;
    const command = next === state.recall.length ? recallDraft : state.recall[next];
    change({ command, recallDraft, recallIndex: next, cursor: { ...state.cursor, command: graphemes(command).length } });
    updateSuggestions(); return true;
  }
  function pickerItems() {
    const query = state.projectQuery.toLocaleLowerCase().trim();
    const all = [...state.projects, ...state.trustRequired];
    const ranked = registry?.search?.(query) || all;
    const projects = [...ranked, ...all.filter(project => query && project.root.toLocaleLowerCase().includes(query) && !ranked.some(item => (item.key || item.root) === (project.key || project.root)))];
    return [...projects, { other: true, name: 'Other folder…', root: 'Use a folder for this session' }];
  }
  function chooseProject(index = state.pickerIndex) {
    const project = pickerItems()[index];
    if (!project) return;
    if (project.other) { change({ view: 'folder', cursor: { ...state.cursor, folderPath: graphemes(state.folderPath).length } }); return; }
    change({ view: 'compose', field: 'subfolder', draft: { ...state.draft, projectKey: project.key || project.root, subfolder: '' } });
  }
  function edit(input, key = {}, paste = false) {
    const field = state.view === 'search' ? 'search' : state.view === 'command' ? 'command' : state.view === 'picker' ? 'projectQuery' : state.view === 'folder' ? 'folderPath' : state.field;
    if (!['name', 'subfolder', 'prompt', 'search', 'command', 'projectQuery', 'folderPath'].includes(field)) return;
    const top = ['command', 'projectQuery', 'folderPath'].includes(field);
    const value = field === 'search' ? state.query : top ? state[field] : state.draft[field];
    const edited = editText(value, state.cursor[field], input, paste ? {} : key, field === 'prompt' || field === 'command');
    if (Buffer.byteLength(edited.value, 'utf8') > 256 * 1024) { inform('This draft exceeds 256 KiB. Paste a smaller prompt.', 'warning'); return; }
    change({ recallIndex: null, cursor: { ...state.cursor, [field]: edited.cursor }, ...(field === 'search' ? { query: edited.value } : top ? { [field]: edited.value, ...(field === 'projectQuery' ? { pickerIndex: 0 } : {}) } : { draft: { ...state.draft, [field]: edited.value } }) });
    if (field === 'command') updateSuggestions();
  }
  function cycleField(direction = 1) {
    const index = FIELDS.indexOf(state.field);
    change({ field: FIELDS[(index + direction + FIELDS.length) % FIELDS.length] });
  }
  function cycleChoice(direction = 1) {
    const list = state.profiles.providers.filter(provider => provider.available);
    if (!list.length) return;
    const index = list.findIndex(item => item.id === state.draft.provider);
    change({ draft: { ...state.draft, provider: list[(index + direction + list.length) % list.length].id } });
  }
  function moveSelection(direction) {
    const rows = state.boardView === 'tasks' ? taskRows(state) : visibleAgents(state);
    if (!rows.length) return;
    const field = state.boardView === 'tasks' ? 'selectedTaskId' : 'selectedId';
    const index = rows.findIndex(row => row.id === state[field]);
    change({ [field]: rows[Math.max(0, Math.min(rows.length - 1, index + direction))].id, detailOffset: 0 });
  }
  function action(name, value) {
    if (name === 'quit') { onQuit(); return; }
    if (state.busy || state.requiredNotice) return;
    if (state.view === 'decision') {
      if (name === 'decide') { if (value && controlBlock(state)) inform(controlBlock(state), 'warning'); else void session.decide(Boolean(value)); }
      else if (name === 'cancel') void session.decide(false);
      else if (name === 'decision-scroll') change({ decision: { ...state.decision, offset: Math.max(0, state.decision.offset + value) } });
      else if (name === 'decision-position') change({ decision: { ...state.decision, offset: value } });
      return;
    }
    if (name === 'board-toggle') { if (['board', 'search', 'detail'].includes(state.view)) change({ boardView: state.boardView === 'tasks' ? 'agents' : 'tasks', detailOffset: 0 }); return; }
    if (name === 'select-task') { if (['board', 'search'].includes(state.view)) change({ selectedTaskId: value, detailOffset: 0 }); return; }
    if (name === 'details') { if (['board', 'search'].includes(state.view)) { change({ view: 'detail', detailOffset: 0 }); if (state.boardView === 'tasks') session.inspect(state.selectedTaskId); } return; }
    if (name === 'notice-open') { if (state.notice) change({ view: 'notice', noticeDetail: { ...state.notice }, detailOffset: 0 }); return; }
    if (name === 'detail-scroll') { if (['board', 'detail', 'notice'].includes(state.view)) change({ detailOffset: Math.max(0, state.detailOffset + value) }); return; }
    if (name === 'detail-position') { change({ detailOffset: value }); return; }
    if (name === 'suggest-next') { if (state.view === 'command') change({ suggestionIndex: (state.suggestionIndex + 1) % Math.max(1, state.suggestions.length) }); return; }
    if (name === 'command-recall') { if (state.view === 'command') recall(value); return; }
    if (name === 'suggestion') { if (state.view === 'command') acceptSuggestion(value); return; }
    if (name === 'pick-project') { change({ view: 'picker', projectQuery: '', pickerIndex: 0, cursor: { ...state.cursor, projectQuery: 0 } }); return; }
    if (name === 'pick') { if (state.view === 'picker') chooseProject(value); return; }
    if (name === 'picker-move') { if (state.view === 'picker') change({ pickerIndex: Math.max(0, Math.min(pickerItems().length - 1, state.pickerIndex + value)) }); return; }
    if (name === 'folder-submit') { if (!state.folderLoading && !controlBlock(state)) void session.otherFolder(state.folderPath); return; }
    if (name === 'field-next') { if (state.view === 'compose') cycleField(value); return; }
    if (state.view === 'command' && ['select', 'focus', 'close', 'new', 'search', 'filter'].includes(name)) return;
    if (name === 'command') { const command = state.command || '/dispatch '; change({ view: 'command', command, cursor: { ...state.cursor, command: graphemes(command).length } }); updateSuggestions(); return; }
    if (name === 'select') { if (state.view === 'board' || state.view === 'search') change({ selectedId: value, selectedTaskId: taskRows(state).find(row => row.agent?.id === value)?.id || state.selectedTaskId }); return; }
    if (name === 'field') { if (state.view === 'compose') { if (value === 'projectKey') action('pick-project'); else if (state.field === value && value === 'provider') cycleChoice(1); else change({ field: value }); } return; }
    if (name === 'refresh') { void monitor.refresh?.(); void refreshProfiles(); void session.refresh({ force: true }); return; }
    if (name === 'search') { change({ view: 'search', cursor: { ...state.cursor, search: graphemes(state.query).length } }); return; }
    if (name === 'filter') { const filters = ['all', ...Object.keys(state.boardView === 'tasks' ? TASK_LABELS : STATUS_LABELS)]; change({ filter: filters[(filters.indexOf(state.filter) + 1) % filters.length] }); return; }
    if (name === 'new') { change({ view: 'compose', field: state.draft.prompt ? 'prompt' : 'provider', confirmation: null }); return; }
    if (name === 'cancel') { if (!state.busy) change({ view: ['picker', 'folder'].includes(state.view) ? 'compose' : 'board', confirmation: null }); return; }
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
    if (state.view === 'decision') {
      if (key.escape || input === 'n') action('decide', false);
      else if (key.tab || key.leftArrow || key.rightArrow) change({ decision: { ...state.decision, confirm: !state.decision.confirm } });
      else if (input === 'y') action('decide', true);
      else if (key.return) action('decide', state.decision.confirm);
      else if (key.downArrow || key.pageDown) action('decision-scroll', 1);
      else if (key.upArrow || key.pageUp) action('decision-scroll', -1);
      return;
    }
    if (state.view === 'picker') {
      if (key.escape) action('cancel');
      else if (key.return) chooseProject();
      else if (key.downArrow || key.upArrow || key.tab) change({ pickerIndex: Math.max(0, Math.min(pickerItems().length - 1, state.pickerIndex + (key.upArrow || key.shift ? -1 : 1))) });
      else edit(input, key);
      return;
    }
    if (state.view === 'folder') {
      if (key.escape) action('cancel');
      else if (key.return) action('folder-submit');
      else if (!state.folderLoading) edit(input, key);
      return;
    }
    if (state.view === 'command') {
      if (key.escape && state.recallIndex !== null) { change({ command: state.recallDraft, recallIndex: null, cursor: { ...state.cursor, command: graphemes(state.recallDraft).length } }); updateSuggestions(); }
      else if (key.escape) change({ view: 'board' });
      else if (key.tab) { if (key.shift) change({ suggestionIndex: (state.suggestionIndex + 1) % Math.max(1, state.suggestions.length) }); else acceptSuggestion(); }
      else if ((key.upArrow || key.downArrow) && recall(key.upArrow ? -1 : 1)) return;
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
      if (state.field === 'projectKey') { action('pick-project'); if (input && !key.return) edit(input, key); }
      else if (state.field === 'provider') {
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
    if (state.view === 'detail' || state.view === 'notice') {
      if (key.escape || key.leftArrow) action('cancel');
      else if (key.downArrow || input === 'j' || key.pageDown) action('detail-scroll', 1);
      else if (key.upArrow || input === 'k' || key.pageUp) action('detail-scroll', -1);
      else if (key.return && state.view === 'detail') action('focus');
      else if (input === 'x' && state.view === 'detail') action('close');
      else if (input === 'q') action('quit');
      return;
    }
    if (input === 'q') action('quit');
    else if (input === 'g') action('board-toggle');
    else if (input === 'i') action('notice-open');
    else if (key.rightArrow || input === 'd') action('details');
    else if (input === 'n') action('new');
    else if (input.startsWith('/') && !key.ctrl && !key.meta) { change({ view: 'command', command: input, cursor: { ...state.cursor, command: graphemes(input).length } }); updateSuggestions(); }
    else if (input === 's') action('search');
    else if (input === 'f') action('filter');
    else if (input === 'r') action('refresh');
    else if (input === 'x') action('close');
    else if (key.return) action('focus');
    else if (key.downArrow || input === 'j' || key.tab && !key.shift) moveSelection(1);
    else if (key.upArrow || input === 'k' || key.tab && key.shift) moveSelection(-1);
    else if (key.pageDown) moveSelection(5);
    else if (key.pageUp) moveSelection(-5);
    else if (key.home) moveSelection(-Infinity);
    else if (key.end) moveSelection(Infinity);
    else if (key.escape) change({ query: '', filter: 'all' });
  }
  const modelKey = key;
  const ready = Promise.all([refreshProfiles(), session.refresh()]);
  return { getSnapshot: () => state, subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
    action, key, paste: text => {
      if (state.busy) return;
      if (state.view === 'board' && text.startsWith('/')) { change({ view: 'command', command: '', cursor: { ...state.cursor, command: 0 } }); edit(text, {}, true); }
      else if (['compose', 'search', 'command', 'picker', 'folder'].includes(state.view)) edit(text, {}, true);
    }, ready,
    selected, targetBlock, pickerItems, getTasks: session.getTasks, showNotice: inform, destroy: () => { session.destroy(); alive = false; catalogGeneration += 1; unsubscribe(); subscribers.clear(); } };
}
