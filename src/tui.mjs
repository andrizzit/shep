import React, { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { render, Box, Text, useInput, usePaste, useWindowSize, measureElement } from 'ink';
import { createTuiModel, visibleAgents, knownStatus, STATUS_LABELS, providerName, FIELDS, graphemes, parseMouse, hitTest, controlBlock } from './tui-model.mjs';
import { safeText, displayWidth } from './terminal.mjs';

export const TUI_COLORS = Object.freeze({ canvas: '#111b19', panel: '#172420', selected: '#293f34', border: '#465c4e', ink: '#eef2e8', muted: '#acb9ac', faint: '#829889', orange: '#f09365', working: '#e5c86e', blocked: '#f18b89', done: '#7fd3c7', idle: '#93cd95', unknown: '#a2aaa5' });
const C = TUI_COLORS;
const dots = { working: '●', blocked: '●', done: '●', idle: '○', unknown: '·' };
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';
const sprite = ['DD.....DD', 'DDDDWDDDD', 'DD.DWD.DD', 'DD.WWW.DD', '.DWW.WWD.', '.DDWWWDD.', '.DD...DD.', '.WW...WW.'];

function truncate(value, width) {
  if (width <= 0) return '';
  const text = safeText(value);
  if (displayWidth(text) <= width) return text;
  let result = '';
  for (const glyph of graphemes(text)) {
    if (displayWidth(result + glyph) > width - 1) break;
    result += glyph;
  }
  return result + '…';
}
const line = (value, props = {}) => h(Text, { color: C.ink, wrap: 'truncate-end', ...props }, safeText(value));
function Click({ registry, id, action, children, ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!registry) return undefined;
    registry.set(id, { ref, action });
    return () => registry.delete(id);
  }, [registry, id, action]);
  return h(Box, { ref, ...props }, children);
}
function Button({ label, active = false, disabled = false, registry, id, action }) {
  return h(Click, { registry, id, action, flexShrink: 0, paddingX: 1, backgroundColor: active ? C.orange : C.panel },
    line(label, { color: disabled ? C.faint : active ? C.canvas : C.ink, bold: active }));
}
function Dog({ compact = false }) {
  if (compact) return h(Text, null, h(Text, { color: '#888d96' }, '▟▀'), h(Text, { color: '#f2f1eb' }, 'ᴥ'), h(Text, { color: '#888d96' }, '▀▙'));
  const fur = { '.': C.canvas, D: '#888d96', W: '#f2f1eb' };
  const monochrome = Object.hasOwn(process.env, 'NO_COLOR') || process.env.TERM === 'dumb';
  return h(Box, { flexDirection: 'column', width: 10, flexShrink: 0 }, ...[0, 2, 4, 6].map(row => h(Text, { key: row }, ...Array.from(sprite[row], (pixel, column) => {
    const bottom = sprite[row + 1][column];
    const char = pixel === '.' && bottom === '.' ? ' ' : monochrome ? pixel === '.' ? '▄' : bottom === '.' ? '▀' : '█' : '▀';
    return h(Text, { key: column, color: fur[pixel], backgroundColor: fur[bottom] }, char);
  }))));
}
function health(state) {
  if (state.snapshot.mode === 'demo') return { label: 'DEMO · actions disabled', color: C.working };
  if (state.snapshot.source.state === 'connected') return { label: 'LIVE', color: C.idle };
  return { label: state.snapshot.updatedAt ? 'STALE · actions disabled' : 'CONNECTING', color: C.blocked };
}
export function listRows(state) {
  const agents = visibleAgents(state);
  const defaults = ['claude', 'codex', 'grok', 'kiro'];
  const providers = [...defaults, ...new Set(agents.map(agent => agent.provider).filter(provider => !defaults.includes(provider)))].sort((a, b) => {
    const order = value => defaults.includes(value) ? defaults.indexOf(value) : defaults.length;
    return order(a) - order(b) || a.localeCompare(b);
  });
  const rows = [];
  for (const provider of providers) {
    const group = agents.filter(agent => agent.provider === provider);
    rows.push({ type: 'provider', provider, count: group.length });
    if (!group.length) rows.push({ type: 'empty', provider });
    for (const agent of group) {
      rows.push({ type: 'agent', agent });
      rows.push({ type: 'path', agent });
    }
  }
  return rows;
}
function AgentList({ state, model, width, height, registry, offset, compactActions = false }) {
  const rows = listRows(state);
  const capacity = Math.max(1, height - 4);
  const shown = rows.slice(offset, offset + capacity);
  const selected = state.snapshot.agents.find(agent => agent.id === state.selectedId);
  return h(Box, { width, height, borderStyle: 'round', borderColor: C.border, flexDirection: 'column', paddingX: 1, overflow: 'hidden' },
    h(Box, { height: 1, justifyContent: 'space-between', flexShrink: 0 }, line('YOUR AGENTS', { color: C.muted, bold: true }), line(`${visibleAgents(state).length} shown`, { color: C.faint })),
    ...shown.map((row, index) => {
      if (row.type === 'provider') return h(Box, { key: `p-${row.provider}`, height: 1, flexShrink: 0 }, line(`${providerName(row.provider)} (${row.count})`, { color: C.orange, bold: true }));
      if (row.type === 'empty') return h(Box, { key: `e-${row.provider}`, height: 1, flexShrink: 0 }, line('  No agents', { color: C.faint }));
      const status = knownStatus(row.agent);
      const active = selected?.id === row.agent.id;
      return h(Click, { key: `${row.type}-${row.agent.id}`, registry, id: `${row.type}-${row.agent.id}`, action: () => model.action('select', row.agent.id), width: '100%', height: 1, flexShrink: 0, backgroundColor: active ? C.selected : C.canvas },
        row.type === 'agent' ? h(Box, { width: '100%', justifyContent: 'space-between' },
          h(Box, { flexGrow: 1, minWidth: 0 }, line(`${active ? '›' : ' '} ${row.agent.name}`, { bold: active })),
          line(` ${dots[status]} ${STATUS_LABELS[status]}`, { color: C[status] })) : line(`  ${row.agent.workspace?.name || 'Workspace?'} · ${row.agent.workspace?.path || 'Path unavailable'}`, { color: active ? C.muted : C.faint }));
    }),
    h(Box, { flexGrow: 1 }),
    compactActions ? h(Box, { gap: 1, flexShrink: 0 },
      h(Button, { label: 'Focus ↵', registry, id: 'focus', disabled: Boolean(controlBlock(state)) || state.view === 'command', action: () => model.action('focus') }),
      h(Button, { label: 'Close x', registry, id: 'close', disabled: Boolean(controlBlock(state)) || state.view === 'command', action: () => model.action('close') }),
      line(`${offset + 1}/${rows.length}`, { color: C.faint })) :
      line(rows.length > capacity ? `${offset + 1}–${Math.min(offset + capacity, rows.length)} of ${rows.length} rows · wheel / ↑↓` : 'Click to select · Enter to focus', { color: C.faint }));
}
function Detail({ state, model, width, height, registry }) {
  const agent = state.snapshot.agents.find(item => item.id === state.selectedId);
  const disabled = Boolean(controlBlock(state)) || state.view === 'command';
  return h(Box, { width, height, borderStyle: 'round', borderColor: C.border, flexDirection: 'column', paddingX: 1, overflow: 'hidden' },
    line('SELECTED AGENT', { color: C.muted, bold: true }),
    h(Box, { height: 1, flexShrink: 0 }),
    agent ? h(Box, { flexDirection: 'column', flexGrow: 1, minHeight: 0 },
      line(agent.name, { bold: true }),
      line(`${dots[knownStatus(agent)]} ${STATUS_LABELS[knownStatus(agent)]}`, { color: C[knownStatus(agent)] }),
      h(Box, { height: 1, flexShrink: 0 }),
      line(providerName(agent.provider), { color: C.orange }),
      line(`Workspace  ${agent.workspace?.name || 'Unavailable'}`, { color: C.muted }),
      h(Text, { color: C.muted, wrap: 'wrap' }, safeText(agent.workspace?.path || 'Working directory unavailable')),
      line(`Pane       ${agent.paneId}`, { color: C.faint }),
      line(`Terminal   ${agent.terminalId || agent.id}`, { color: C.faint }),
      h(Box, { flexGrow: 1 }),
      h(Box, { gap: 1, flexShrink: 0 },
        h(Button, { label: 'Enter Focus', registry, id: 'focus', disabled, action: () => model.action('focus') }),
        h(Button, { label: 'x Close', registry, id: 'close', disabled, action: () => model.action('close') })),
      line('Closing stops the agent process.', { color: C.faint })) : h(Box, { flexDirection: 'column' }, line('No agent selected', { color: C.faint }), line('n creates a native Herdr agent.', { color: C.muted })));
}
function editorLines(text, cursor, width, height) {
  const chars = graphemes(text);
  const result = [''];
  let cursorLine = 0;
  for (let index = 0; index <= chars.length; index += 1) {
    if (index === cursor) {
      if (displayWidth(result.at(-1)) >= width) result.push('');
      cursorLine = result.length - 1;
      result[result.length - 1] += '▏';
    }
    if (index === chars.length) break;
    const char = chars[index];
    if (char === '\n') result.push('');
    else {
      const safe = char === '\t' ? '  ' : safeText(char);
      if (displayWidth(result.at(-1) + safe) > width) result.push('');
      result[result.length - 1] += safe;
    }
  }
  const start = Math.max(0, cursorLine - height + 1);
  return result.slice(start, start + height);
}
function Composer({ state, model, width, height, registry }) {
  const provider = state.profiles.providers.find(item => item.id === state.draft.provider);
  const workspace = state.profiles.workspaces.find(item => item.id === state.draft.workspaceId);
  const narrow = height < (state.dispatchHold ? 26 : 23);
  const promptRows = Math.max(2, Math.min(7, height - 12));
  const blocked = controlBlock(state) || state.dispatchHold || !provider?.available || state.profilesLoading;
  const title = name => ({ provider: 'Provider', name: 'Name (optional)', workspaceId: 'Workspace', cwd: 'Working directory', prompt: 'Prompt', dispatch: 'Launch' })[name];
  const renderField = field => {
    const active = state.field === field;
    const color = active ? C.orange : C.muted;
    if (field === 'dispatch') return h(Box, { key: field, flexDirection: 'column', flexShrink: 0 },
      h(Button, { label: state.busy === 'dispatch' ? 'Starting…' : 'Dispatch agent  Ctrl+S', registry, id: 'dispatch', active, disabled: Boolean(blocked), action: () => model.action('dispatch') }));
    let value;
    if (field === 'provider') value = `${provider?.name || 'Loading…'}${provider && !provider.available ? ' · unavailable' : ''}  ‹ ›`;
    else if (field === 'workspaceId') value = `${workspace?.name || state.draft.workspaceId || 'Current workspace'}  ‹ ›`;
    else value = state.draft[field];
    const fieldHeight = field === 'prompt' ? narrow ? Math.max(1, height - (state.dispatchHold ? 11 : 8)) : promptRows : 1;
    const content = ['prompt', 'name', 'cwd'].includes(field) && active ? editorLines(value, state.cursor[field], Math.max(3, width - 6), fieldHeight) : field === 'prompt' ? value.split('\n').slice(0, fieldHeight).map(value => safeText(value)) : [safeText(value)];
    return h(Click, { key: field, registry, id: `field-${field}`, action: () => model.action('field', field), flexDirection: 'column', flexShrink: 0, minHeight: fieldHeight + 1 },
      line(`${active ? '›' : ' '} ${title(field)}${field === 'prompt' ? ' · Enter newline' : ''}`, { color, bold: active }),
      h(Box, { flexDirection: 'column', paddingX: 1, minHeight: fieldHeight, backgroundColor: active ? C.selected : C.panel },
        ...content.map((value, index) => line(value || (field === 'prompt' && index === 0 ? 'Describe the work…' : field === 'name' ? 'generated automatically' : ' '), { key: index, color: value ? C.ink : C.faint }))));
  };
  const fields = narrow ? state.field === 'dispatch' ? ['dispatch'] : [state.field, 'dispatch'] : FIELDS;
  return h(Box, { width, height, borderStyle: 'round', borderColor: C.orange, flexDirection: 'column', paddingX: 1, overflow: 'hidden' },
    h(Box, { justifyContent: 'space-between', height: 1, flexShrink: 0 }, line('NEW AGENT', { color: C.orange, bold: true }), line(`${FIELDS.indexOf(state.field) + 1}/6`, { color: C.faint })),
    line(state.profilesError || (narrow ? 'Tab: next field · draft stays on Esc' : 'Native Herdr session · auth remains in the agent pane'), { color: state.profilesError ? C.blocked : C.faint }),
    ...fields.map(renderField),
    h(Box, { flexGrow: 1 }),
    state.field === 'provider' && provider?.reason ? line(provider.reason, { color: provider.available ? C.faint : C.working }) :
      line(state.field === 'name' ? 'Name: a-z then a-z, 0-9, _ or -; max 32.' : state.field === 'prompt' ? `${Buffer.byteLength(state.draft.prompt)} / 65536 prompt bytes · paste supported` : controlBlock(state) || '←/→ choose · Tab next · Esc keeps draft', { color: C.faint }));
}
function Confirmation({ state, model, width, height, registry }) {
  const target = state.confirmation;
  const reason = model.targetBlock(target, true);
  const compact = height < 14;
  return h(Box, { width, height, borderStyle: 'round', borderColor: C.blocked, paddingX: 1, flexDirection: 'column', overflow: 'hidden' },
    line('CLOSE THIS AGENT?', { color: C.blocked, bold: true }),
    line(target?.name, { bold: true }),
    line(`${providerName(target?.provider)} · ${target?.paneId} · ${STATUS_LABELS[knownStatus(target)]}`, { color: C.muted }),
    line(`Identity: ${target?.terminalId || target?.id}`, { color: C.faint }),
    !compact && line(target?.workspace?.path || 'Working directory unavailable', { color: C.muted }),
    line('Stops its process and removes its Herdr pane.', { color: C.blocked }),
    reason && line(reason, { color: C.working }),
    h(Box, { flexGrow: 1 }),
    h(Box, { gap: 2, flexShrink: 0 },
      h(Button, { label: 'Cancel  Esc', active: !state.confirmClose, registry, id: 'cancel-close', action: () => model.action('cancel') }),
      h(Button, { label: 'Close agent  y', active: state.confirmClose, disabled: Boolean(reason), registry, id: 'confirm-close', action: () => model.action('confirm-close') })));
}

export function TuiView({ state, model, url = '', width = 100, height = 28, registry, offset = 0 }) {
  width = Math.max(1, width);
  height = Math.max(1, height);
  if (width < 39 || height < 14) return h(Box, { width, height, flexDirection: 'column', overflow: 'hidden' },
    line('▟▀ᴥ▀▙  shep.', { color: C.orange, bold: true }),
    line('Enlarge this pane to at least 40 × 15.', { color: C.muted }),
    line('q / Ctrl+C quit; your agents keep running.', { color: C.muted }));
  const compact = height < 25;
  const short = height < 17;
  const status = health(state);
  const agents = state.snapshot.agents || [];
  const headerHeight = compact ? 2 : 4;
  const toolbarHeight = compact && ['compose', 'confirm'].includes(state.view) ? 0 : 4;
  const footerHeight = 2;
  const notificationHeight = state.dispatchHold ? 3 : 2;
  const bodyHeight = Math.max(2, height - headerHeight - toolbarHeight - footerHeight - notificationHeight);
  const split = width >= 90 && bodyHeight >= 12;
  const listWidth = split ? Math.floor(width * .52) : width;
  const rightWidth = width - listWidth;
  const activePanel = state.view === 'compose' ? Composer : state.view === 'confirm' ? Confirmation : Detail;
  const notice = state.notice?.message || (state.snapshot.source.state !== 'connected' ? `${state.snapshot.updatedAt ? 'Stale snapshot. ' : ''}${state.snapshot.source.message || 'Waiting for Herdr…'}` : state.snapshot.mode === 'demo' ? 'Sample agents only. Launch, focus and close are disabled.' : state.view === 'command' ? 'Use agent: to choose a provider; without a prefix, Codex runs the task. Enter submits.' : state.view === 'confirm' ? 'Review the captured identity. Cancel is selected by default.' : state.view === 'compose' ? 'Optional launch settings. Escape keeps your draft.' : 'Ready. Type /dispatch your task, or select an agent to focus its native pane.');
  const footer = ['command', 'compose'].includes(state.view) && state.dispatchHold ? 'Ctrl+F focus pane · Ctrl+Y allow new · Esc back' : state.view === 'command' ? 'Enter dispatch · Esc keep command · Ctrl+C quit' : state.view === 'compose' ? short ? 'Tab fields · Ctrl+S dispatch · Esc back' : 'Tab / Shift+Tab fields  ←→ choose  Ctrl+S dispatch  Esc keep draft  Ctrl+C quit' : state.view === 'confirm' ? 'Tab choose · Enter activate · y close · Esc cancel' : state.view === 'search' ? 'Type to search · Enter keep · Esc clear · Ctrl+C quit' : short ? '/ dispatch · ↑↓ select · Enter focus · x close · q quit' : '/ dispatch  ↑↓ / jk select  Enter focus  x close  n setup  s search  f filter  q quit';
  const defaults = `Codex · ${state.profiles.workspaces.find(item => item.id === state.draft.workspaceId)?.name || 'Current workspace'} · ${state.draft.cwd || 'Reading launch settings…'}`;
  const commandValue = state.command || '/dispatch [agent:] your task · default Codex';
  const commandDisplay = state.view === 'command' ? editorLines(state.command, state.cursor.command, Math.max(4, width - 4), 1)[0] : commandValue;
  return h(Box, { width, height, flexDirection: 'column', backgroundColor: C.canvas, overflow: 'hidden' },
    h(Box, { height: headerHeight, flexShrink: 0, alignItems: compact ? 'flex-start' : 'center', gap: 1 },
      h(Dog, { compact }),
      h(Box, { flexDirection: 'column', flexGrow: 1, minWidth: 0 }, line('shep.  Your agents, together.', { bold: true, color: C.orange }), line(`${agents.length} agents · ${agents.filter(agent => agent.status === 'working').length} working · ${agents.filter(agent => agent.status === 'blocked').length} need input`, { color: C.muted })),
      h(Box, { flexDirection: 'column', flexShrink: 0, maxWidth: Math.floor(width * .35) }, line(status.label, { color: status.color, bold: true }), !compact && line(state.snapshot.source.scope || 'Current Herdr session', { color: C.faint }))),
    toolbarHeight > 0 && h(Box, { height: toolbarHeight, flexShrink: 0, flexDirection: 'column' },
      h(Box, { height: 1, flexShrink: 0, gap: 1 },
        h(Button, { label: 'n Setup', registry, id: 'new', disabled: state.view === 'command', action: () => model.action('new') }),
        h(Button, { label: `f ${state.filter === 'all' ? 'All agents' : STATUS_LABELS[state.filter]}`, registry, id: 'filter', disabled: state.view === 'command', action: () => model.action('filter') }),
        h(Click, { registry, id: 'search', action: () => model.action('search'), flexGrow: 1, minWidth: 0 }, line(`s ${state.query}${state.view === 'search' ? '▏' : state.query ? '' : 'Search'}`, { color: state.view === 'search' ? C.orange : C.muted }))),
      line(`Default: ${defaults}`, { color: C.muted }),
      h(Click, { registry, id: 'command', action: () => model.action('command'), height: 1, flexShrink: 0, backgroundColor: state.view === 'command' ? C.selected : C.panel }, line(`› ${commandDisplay}`, { color: state.view === 'command' ? C.ink : C.orange }))),
    h(Box, { height: bodyHeight, flexShrink: 0 },
      split ? h(React.Fragment, null,
        h(AgentList, { state, model, width: listWidth, height: bodyHeight, registry, offset }),
        h(activePanel, { state, model, width: rightWidth, height: bodyHeight, registry })) :
        state.view === 'compose' || state.view === 'confirm' ? h(activePanel, { state, model, width, height: bodyHeight, registry }) : h(AgentList, { state, model, width, height: bodyHeight, registry, offset, compactActions: true })),
    h(Box, { height: notificationHeight, paddingX: 1, flexShrink: 0, overflow: 'hidden', flexDirection: 'column' },
      h(Box, { height: 2, flexShrink: 0, overflow: 'hidden' }, h(Text, { color: state.notice?.kind === 'warning' ? C.working : state.notice?.kind === 'success' ? C.done : C.muted, wrap: 'wrap' }, truncate(notice, width * 2 - 4))),
      state.dispatchHold && h(Box, { gap: 1, flexShrink: 0 },
        h(Button, { label: 'Allow new launch', registry, id: 'notice-allow', action: () => model.action('allow-launch') }),
        state.resultTarget && h(Button, { label: 'Focus pane', registry, id: 'notice-focus', action: () => model.action('focus-result') }))),
    h(Box, { height: footerHeight, flexDirection: 'column', flexShrink: 0 },
      line(footer, { color: C.muted }),
      h(Box, { justifyContent: 'space-between' }, line(state.view === 'board' && !split ? `Selected: ${state.snapshot.agents.find(agent => agent.id === state.selectedId)?.paneId || 'none'}` : url, { color: C.faint }), line('Quit preserves agents', { color: C.faint }))));
}

function App({ model, url, output, registry }) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const size = useWindowSize();
  // Leave the final physical cell unused: Ink's incremental repaint appends
  // eraseEndLine, which can erase a full-width row's last cell in pending-wrap
  // state. Herdr can also report one extra column on entering alternate screen.
  const width = Math.max(1, Math.min(300, (size.columns || output.columns || 100) - 1));
  const height = Math.max(1, Math.min(120, (size.rows || output.rows || 28) - 1));
  const [offset, setOffset] = useState(0);
  const rows = listRows(state);
  const header = height < 25 ? 2 : 4;
  const capacity = Math.max(1, height - header - (state.dispatchHold ? 13 : 12));
  const maxOffset = Math.max(0, rows.length - capacity);
  const selectedRow = rows.findIndex(row => row.type === 'agent' && row.agent.id === state.selectedId);
  useEffect(() => {
    setOffset(previous => Math.max(0, Math.min(maxOffset, selectedRow < previous ? selectedRow : selectedRow + Math.min(2, capacity) > previous + capacity ? selectedRow + Math.min(2, capacity) - capacity : previous)));
  }, [state.selectedId, selectedRow, capacity, maxOffset]);
  useInput((input, key) => {
    if (width < 39 || height < 14) { if (input === 'q' || key.ctrl && ['c', 'd'].includes(input)) model.action('quit'); return; }
    const mouse = parseMouse(input);
    if (mouse) {
      if (mouse.release || state.busy) return;
      if ((mouse.button & 64) === 64) { if (state.view === 'board' || state.view === 'search') setOffset(previous => Math.max(0, Math.min(maxOffset, previous + ((mouse.button & 1) ? 3 : -3)))); return; }
      if ((mouse.button & 3) !== 0) return;
      const target = hitTest(mouse, registry.values(), measureElement);
      target?.action();
      return;
    }
    model.key(input, key);
  });
  usePaste(text => model.paste(text));
  return h(TuiView, { state, model, url, width, height, registry, offset: Math.min(offset, maxOffset) });
}

export function startTui({ monitor, controller, url = '', onQuit, input = process.stdin, output = process.stdout }) {
  if (!input.isTTY || !output.isTTY) throw new Error('The Ink interface requires a terminal. Use the plain terminal fallback for redirected output.');
  const registry = new Map();
  const model = createTuiModel({ monitor, controller, onQuit });
  let instance;
  let stopped = false;
  const priorRaw = Boolean(input.isRaw);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    model.destroy();
    registry.clear();
    try { output.write(MOUSE_OFF); } catch { /* Output may have already closed. */ }
    try { instance?.cleanup(); } finally {
      try { if (Boolean(input.isRaw) !== priorRaw) input.setRawMode(priorRaw); } catch { /* Detached input. */ }
    }
  };
  try {
    instance = render(h(App, { model, url, output, registry }), { stdin: input, stdout: output, stderr: output, exitOnCtrlC: false, patchConsole: false, alternateScreen: true, interactive: true, incrementalRendering: true, maxFps: 30 });
    output.write(MOUSE_ON);
    instance.waitUntilExit().then(() => { if (!stopped) { stop(); onQuit?.(); } }, error => {
      stop();
      onQuit?.();
      process.exitCode = 1;
      try { output.write(`Shep terminal: ${safeText(error.message)}\n`); } catch { /* Detached output. */ }
    });
  } catch (error) { stop(); throw error; }
  stop.ready = Promise.all([model.ready, instance.waitUntilRenderFlush()]);
  stop.waitUntilRenderFlush = () => instance.waitUntilRenderFlush();
  return stop;
}
