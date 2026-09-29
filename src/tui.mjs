import React, { createElement as h, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { render, Box, Text, useInput, usePaste, useWindowSize, measureElement } from 'ink';
import { createTuiModel, visibleAgents, knownStatus, STATUS_LABELS, providerName, FIELDS, graphemes, parseMouse, hitTest, controlBlock } from './tui-model.mjs';
import { taskGroups, taskRows, TASK_LABELS, displayArgs, summaryLabel } from './tui-tasks.mjs';
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
export function boardRows(state) {
  if (state.boardView !== 'tasks') return listRows(state);
  return taskGroups(state).flatMap(group => [{ type: 'project', group }, ...group.rows.flatMap(row => [{ type: 'task', row }, { type: 'task-path', row }])]);
}
const taskColor = status => status === 'closed' ? C.faint : C[status] || (['failed', 'needs_input', 'needs_confirmation'].includes(status) ? C.blocked : C.working);
const elapsed = milliseconds => milliseconds == null ? '' : milliseconds < 60000 ? '<1m' : milliseconds < 3600000 ? `${Math.floor(milliseconds / 60000)}m` : `${Math.floor(milliseconds / 3600000)}h`;
function taskSubline(row) {
  if (!row.task) return row.agent.workspace?.path || 'Path unavailable';
  const task = row.task;
  if (['done', 'idle'].includes(row.status) && task.summary) return summaryLabel(task.summary);
  if (['failed', 'uncertain', 'needs_input', 'needs_confirmation'].includes(task.launch.state)) return task.launch.message;
  if (task.placement) return task.placement.mode === 'worktree' ? `worktree ${task.created?.worktree?.branch || task.placement.cwd}` : `${task.placement.targetKind} · ${task.placement.cwd}`;
  return task.launch.message;
}
function TaskList({ state, model, width, height, registry, offset = 0, compactActions = false }) {
  const rows = boardRows(state);
  const capacity = Math.max(1, height - 4);
  return h(Box, { width, height, borderStyle: 'round', borderColor: C.border, flexDirection: 'column', paddingX: 1, overflow: 'hidden' },
    h(Box, { height: 1, flexShrink: 0, justifyContent: 'space-between' }, line('TASKS', { color: C.muted, bold: true }), line(`${taskRows(state).length} shown`, { color: C.faint })),
    ...rows.slice(offset, offset + capacity).map(item => {
      if (item.type === 'project') return line(`${item.group.name} (${item.group.rows.length})`, { key: `group-${item.group.key}`, color: C.orange, bold: true });
      const row = item.row, active = row.id === state.selectedTaskId;
      return h(Click, { key: `${item.type}-${row.id}`, registry, id: `${item.type}-${row.id}`, action: () => model.action('select-task', row.id), height: 1, flexShrink: 0, backgroundColor: active ? C.selected : C.canvas },
        item.type === 'task' ? h(Box, { width: '100%', justifyContent: 'space-between' },
          h(Box, { flexGrow: 1, minWidth: 0 }, line(`${active ? '›' : ' '} ${row.label}`, { bold: active })),
          line(` ${width > 65 ? providerName(row.task?.agent.provider || row.agent?.provider) + ' ' : ''}${TASK_LABELS[row.status] || 'Unknown'} ${elapsed(row.elapsedMs)}`, { color: taskColor(row.status) })) : line(`  ${taskSubline(row)}`, { color: active ? C.muted : C.faint }));
    }),
    !rows.length && line(state.projectsLoading ? 'Projects loading…' : state.query || state.filter !== 'all' ? 'No matching tasks.' : 'No tasks yet. /dispatch starts one.', { color: C.faint }),
    h(Box, { flexGrow: 1 }),
    compactActions ? h(Box, { gap: 0, flexShrink: 0 },
      h(Button, { label: 'Focus ↵', registry, id: 'focus', action: () => model.action('focus') }),
      h(Button, { label: 'Close x', registry, id: 'close', action: () => model.action('close') }),
      h(Button, { label: 'Details →', registry, id: 'details', action: () => model.action('details') })) : line('g Agents · Click to select · Enter to focus', { color: C.faint }));
}
function TaskDetail(props) {
  const row = taskRows(props.state).find(item => item.id === props.state.selectedTaskId);
  return row?.task ? h(OwnedTaskDetail, { ...props, row }) : h(Detail, props);
}
function OwnedTaskDetail({ state, model, width, height, registry, row }) {
  const task = row.task;
  const createdWorktree = task.created?.worktree;
  const worktree = createdWorktree && createdWorktree.workspaceId === task.created.workspaceId ? createdWorktree : null;
  // This is a copyable command only. Use the response-confirmed creation
  // receipt, never infer ownership from a discovered path or placement mode.
  const workspaceArg = worktree && (/^[\w:.-]+$/.test(worktree.workspaceId) ? worktree.workspaceId : `'${worktree.workspaceId.replaceAll("'", "'\\''")}'`);
  const content = [task.inputTask, '', `${providerName(task.agent.provider)} · ${TASK_LABELS[row.status]} · ${elapsed(row.elapsedMs)}`,
    `Project: ${task.project.name}`, task.project.root, `Requested subfolder: ${task.subfolder || '(root)'}`,
    `Placement: ${task.placement ? task.placement.mode + ' · ' + task.placement.targetKind : 'Automatic · awaiting target'}`,
    `Actual cwd: ${task.placement?.cwd || 'Not confirmed'}`, `Why: ${task.placement?.reason || 'Resolved again before launch'}`,
    ...(worktree ? [`Branch: ${worktree.branch}`, `Worktree path: ${worktree.path}`, 'Manual removal in current Herdr instance:', `herdr worktree remove --workspace ${workspaceArg}`] : []),
    `Launch: ${task.launch.state} · ${task.launch.message}`, `Pane: ${task.target?.paneId || 'Not confirmed'}`, `Terminal: ${task.target?.terminalId || 'Not confirmed'}`,
    ...(task.locationNotice ? ['Location notice (exact):', task.locationNotice.event.message, `Full subfolder: ${task.locationNotice.subfolder}`] : []),
    summaryLabel(task.summary), ...(task.summary?.at ? [`Checked: ${task.summary.at}`] : []), ...(task.summary?.message ? [task.summary.message] : [])];
  const lines = content.flatMap(text => wrappedLines(text, Math.max(1, width - 4)));
  const capacity = Math.max(1, height - 5);
  const offset = Math.min(state.detailOffset, Math.max(0, lines.length - capacity));
  useEffect(() => { if (state.detailOffset !== offset) model.action('detail-position', offset); }, [state.detailOffset, offset, model]);

  return h(Box, { width, height, borderStyle: 'round', borderColor: C.border, paddingX: 1, flexDirection: 'column', overflow: 'hidden' },
    line(`TASK · ${task.name}`, { color: C.orange, bold: true }),
    ...lines.slice(offset, offset + capacity).map((text, index) => line(text, { key: index, color: C.muted })),
    h(Box, { flexGrow: 1 }),
    h(Box, { gap: 0, flexShrink: 0 },
      h(Button, { label: '↑', registry, id: 'detail-up', action: () => model.action('detail-position', Math.max(0, offset - 1)) }),
      h(Button, { label: '↓', registry, id: 'detail-down', action: () => model.action('detail-position', Math.min(lines.length - 1, offset + 1)) }),
      line(`${offset + 1}–${Math.min(offset + capacity, lines.length)}/${lines.length}`, { color: C.faint })),
    h(Box, { gap: 0, flexShrink: 0 },
      h(Button, { label: 'Focus ↵', registry, id: 'focus', action: () => model.action('focus') }),
      h(Button, { label: 'Close x', registry, id: 'close', action: () => model.action('close') }),
      h(Button, { label: 'Back Esc', registry, id: 'detail-back', action: () => model.action('cancel') })));
}

function Detail({ state, model, width, height, registry }) {
  const agent = model.selected();
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
  const project = [...state.projects, ...state.trustRequired].find(item => (item.key || item.root) === state.draft.projectKey);
  const narrow = height < (state.dispatchHold ? 26 : 23);
  const locationPreview = project?.kind === 'git' && Boolean(state.draft.subfolder) && !state.requiredNotice;
  const promptRows = Math.max(2, Math.min(7, height - 12 - Number(locationPreview)));
  const blocked = controlBlock(state) || state.dispatchHold || !provider?.available || state.profilesLoading;
  const title = name => ({ provider: 'Provider', name: 'Name (optional)', projectKey: 'Project', subfolder: 'Subfolder (optional)', prompt: 'Task', dispatch: 'Launch' })[name];
  const renderField = field => {
    const active = state.field === field;
    const color = active ? C.orange : C.muted;
    if (field === 'dispatch') return h(Box, { key: field, flexDirection: 'column', flexShrink: 0 },
      h(Button, { label: state.busy === 'dispatch' ? 'Starting…' : 'Dispatch agent  Ctrl+S', registry, id: 'dispatch', active, disabled: Boolean(blocked), action: () => model.action('dispatch') }));
    let value;
    if (field === 'provider') value = `${provider?.name || 'Loading…'}${provider && !provider.available ? ' · unavailable' : ''}  ‹ ›`;
    else if (field === 'projectKey') value = `${project?.name || (state.projectsLoading ? 'Projects loading…' : 'Choose a project')}  Enter / click`;
    else value = state.draft[field];
    const fieldHeight = field === 'prompt' ? narrow ? Math.max(1, height - (state.dispatchHold ? 12 : 9) - Number(locationPreview)) : promptRows : 1;
    const content = ['prompt', 'name', 'subfolder'].includes(field) && active ? editorLines(value, state.cursor[field], Math.max(3, width - 6), fieldHeight) : field === 'prompt' ? value.split('\n').slice(0, fieldHeight).map(value => safeText(value)) : [safeText(value)];
    return h(Click, { key: field, registry, id: `field-${field}`, action: () => model.action('field', field), flexDirection: 'column', flexShrink: 0, minHeight: fieldHeight + 1 },
      line(`${active ? '›' : ' '} ${title(field)}${field === 'prompt' ? ' · Enter newline' : ''}`, { color, bold: active }),
      h(Box, { flexDirection: 'column', paddingX: 1, minHeight: fieldHeight, backgroundColor: active ? C.selected : C.panel },
        ...content.map((value, index) => line(value || (field === 'prompt' && index === 0 ? 'Describe the work…' : field === 'name' ? 'generated automatically' : ' '), { key: index, color: value ? C.ink : C.faint }))));
  };
  const fields = narrow ? state.field === 'dispatch' ? ['dispatch'] : [state.field, 'dispatch'] : FIELDS;
  return h(Box, { width, height, borderStyle: 'round', borderColor: C.orange, flexDirection: 'column', paddingX: 1, overflow: 'hidden' },
    h(Box, { justifyContent: 'space-between', height: 1, flexShrink: 0 }, line('NEW TASK', { color: C.orange, bold: true }), line(`${FIELDS.indexOf(state.field) + 1}/6`, { color: C.faint })),
    locationPreview ? h(Box, { height: 2, flexShrink: 0, flexDirection: 'column' },
      line('If worktree: starts at repo root;', { color: C.working }),
      line("selected subfolder isn't applied.", { color: C.working })) :
      line(state.profilesError || state.projectsError || (narrow ? 'Tab: next field · draft stays on Esc' : 'Automatic isolation · auth remains in the agent pane'), { color: state.profilesError ? C.blocked : C.faint }),
    ...fields.map(renderField),
    narrow && h(Box, { gap: 1, flexShrink: 0 },
      h(Button, { label: '‹ Prev', registry, id: 'field-prev', action: () => model.action('field-next', -1) }),
      h(Button, { label: 'Next ›', registry, id: 'field-next', action: () => model.action('field-next', 1) }),
      h(Button, { label: 'Back', registry, id: 'compose-back', action: () => model.action('cancel') })),
    h(Box, { flexGrow: 1 }),
    state.field === 'provider' && provider?.reason ? line(provider.reason, { color: provider.available ? C.faint : C.working }) :
      line(state.field === 'subfolder' ? 'Automatic isolation; worktrees start at root.' : state.field === 'projectKey' ? (project?.root || 'Choose Project or Other folder…') : state.field === 'name' ? 'Name: a-z then a-z, 0-9, _ or -; max 32.' : state.field === 'prompt' ? `${Buffer.byteLength(state.draft.prompt)} / 65536 prompt bytes · paste supported` : controlBlock(state) || '←/→ choose · Tab next · Esc keeps draft', { color: C.faint }));
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

function wrappedLines(value, width) {
  const lines = [''];
  for (const glyph of graphemes(String(value))) {
    if (glyph === '\n') { lines.push(''); continue; }
    const text = safeText(glyph);
    if (displayWidth(lines.at(-1) + text) > width) lines.push('');
    lines[lines.length - 1] += text;
  }
  return lines;
}
function Decision({ state, model, width, height, registry }) {
  const decision = state.decision;
  const content = decision.kind === 'trust'
    ? ['Trust this exact repository for Git operations?', decision.root, 'Only this canonical root is saved in Shep config. No global Git trust is changed.', decision.message]
    : [`${providerName(decision.provider)} · configured default argv`, displayArgs(decision.args), decision.message, 'Consent lasts for this session and this exact argv only.'];
  const lines = content.flatMap(value => wrappedLines(value, Math.max(1, width - 4)));
  const capacity = Math.max(1, height - 5);
  const offset = Math.min(decision.offset, Math.max(0, lines.length - capacity));
  useEffect(() => { if (decision.offset !== offset) model.action('decision-position', offset); }, [decision.offset, offset, model]);
  return h(Box, { width, height, borderStyle: 'round', borderColor: C.working, paddingX: 1, flexDirection: 'column', overflow: 'hidden' },
    line(decision.kind === 'trust' ? 'TRUST REPOSITORY?' : 'CONFIGURED ARGUMENTS?', { color: C.working, bold: true }),
    ...lines.slice(offset, offset + capacity).map((text, index) => line(text, { key: index, color: C.muted })),
    h(Box, { flexGrow: 1 }),
    h(Box, { gap: 1, flexShrink: 0 },
      h(Button, { label: '↑', registry, id: 'decision-up', action: () => model.action('decision-scroll', -1) }),
      h(Button, { label: '↓', registry, id: 'decision-down', action: () => model.action('decision-scroll', 1) }),
      line(`${offset + 1}–${Math.min(offset + capacity, lines.length)}/${lines.length}`, { color: C.faint })),
    h(Box, { gap: 1, flexShrink: 0 },
      h(Button, { label: 'Cancel Esc', active: !decision.confirm, registry, id: 'decision-cancel', action: () => model.action('decide', false) }),
      h(Button, { label: decision.kind === 'trust' ? 'Trust root y' : 'Use args y', active: decision.confirm, registry, id: 'decision-yes', action: () => model.action('decide', true) })));
}
function ProjectPicker({ state, model, width, height, registry }) {
  const folder = state.view === 'folder';
  const items = model.pickerItems();
  const capacity = Math.max(1, height - 6);
  const start = Math.max(0, state.pickerIndex - capacity + 1);
  return h(Box, { width, height, borderStyle: 'round', borderColor: C.orange, paddingX: 1, flexDirection: 'column', overflow: 'hidden' },
    line(folder ? 'OTHER FOLDER' : 'SELECT PROJECT', { color: C.orange, bold: true }),
    line(folder ? 'Absolute path · session only' : state.projectsLoading ? 'Projects loading…' : 'Type to filter · ↑↓ select', { color: C.muted }),
    line((folder ? state.folderPath : state.projectQuery) + '▏'),
    ...(folder ? wrappedLines(state.folderPath, width - 4).slice(-capacity) : items.slice(start, start + capacity).map((item, index) => h(Click, {
      key: item.key || item.root, registry, id: `project-${start + index}`, action: () => model.action('pick', start + index), height: 1, flexShrink: 0,
      backgroundColor: start + index === state.pickerIndex ? C.selected : C.canvas }, line(`${start + index === state.pickerIndex ? '›' : ' '} ${item.name}  ${item.root} ${item.kind === 'trust_required' ? '(needs trust)' : item.kind ? `(${item.kind})` : ''}`)))).map((item, index) => typeof item === 'string' ? line(item, { key: index }) : item),
    h(Box, { flexGrow: 1 }),
    h(Box, { gap: 1, flexShrink: 0 },
      !folder && h(Button, { label: '↑', registry, id: 'picker-up', action: () => model.action('picker-move', -1) }),
      !folder && h(Button, { label: '↓', registry, id: 'picker-down', action: () => model.action('picker-move', 1) }),
      h(Button, { label: 'Back Esc', registry, id: 'picker-back', action: () => model.action('cancel') }),
      h(Button, { label: folder ? state.folderLoading ? 'Checking…' : 'Use folder ↵' : 'Select ↵', registry, id: 'picker-use', action: () => model.action(folder ? 'folder-submit' : 'pick', state.pickerIndex) })));
}
function NoticeDetail({ state, model, width, height, registry }) {
  const notice = state.noticeDetail || state.notice;
  const lines = wrappedLines(notice?.message || 'No message.', width - 4);
  const capacity = Math.max(1, height - 4);
  const offset = Math.min(state.detailOffset, Math.max(0, lines.length - capacity));
  useEffect(() => { if (state.detailOffset !== offset) model.action('detail-position', offset); }, [state.detailOffset, offset, model]);
  return h(Box, { width, height, borderStyle: 'round', borderColor: C.border, paddingX: 1, flexDirection: 'column', overflow: 'hidden' },
    line('NOTICE · full message', { color: C.orange, bold: true }),
    ...lines.slice(offset, offset + capacity).map((text, index) => line(text, { key: index, color: C.muted })),
    h(Box, { flexGrow: 1 }),
    h(Box, { gap: 1, flexShrink: 0 },
      h(Button, { label: '↑', registry, id: 'notice-up', action: () => model.action('detail-position', Math.max(0, offset - 1)) }),
      h(Button, { label: '↓', registry, id: 'notice-down', action: () => model.action('detail-position', Math.min(lines.length - 1, offset + 1)) }),
      h(Button, { label: 'Back Esc', registry, id: 'notice-back', action: () => model.action('cancel') })));
}

function Suggestions({ state, model, width, registry }) {
  const candidates = state.suggestions || [];
  if (width < 70) {
    const item = candidates[state.suggestionIndex];
    return h(Box, { height: 1, flexShrink: 0 },
      h(Button, { label: 'Next', registry, id: 'suggest-next', action: () => model.action('suggest-next') }),
      h(Click, { registry, id: 'suggest-current', action: () => model.action('suggestion', state.suggestionIndex), flexGrow: 1, minWidth: 0, backgroundColor: C.selected }, line(`Tab ${item?.label || ''}`, { color: C.orange })));
  }
  const cell = Math.max(5, Math.floor(width / Math.max(1, candidates.length)) - 2);
  return h(Box, { height: 1, flexShrink: 0 }, ...candidates.map((item, index) =>
    h(Button, { key: index, label: truncate(item.label, cell), active: index === state.suggestionIndex, registry, id: `suggest-${index}`, action: () => model.action('suggestion', index) })));
}

export function noticeLines(state, width) {
  const required = state.requiredNotice;
  if (!required) return [];
  const exact = wrappedLines(required.event.message, Math.max(1, width - 2));
  if (exact.length <= 3) return exact;
  // Preserve the whole consequence. Only the separately labelled path elides;
  // the exact event and full subfolder remain in the selected task detail.
  return [...wrappedLines('Worktree starts at repository root;', Math.max(1, width - 2)), ...wrappedLines('selected subfolder is not applied', Math.max(1, width - 2)), truncate(`Path: ${required.subfolder}`, width - 2)];
}
function RequiredNotice({ state, width, onNoticeRendered }) {
  const token = state.requiredNotice.token;
  useLayoutEffect(() => { onNoticeRendered?.(token); }, [token, onNoticeRendered]);
  return h(Box, { flexDirection: 'column', paddingX: 1, flexShrink: 0 }, ...noticeLines(state, width).map((text, index) => line(text, { key: index, color: C.working, bold: index === 0 })));
}

export function TuiView({ state, model, url = '', width = 100, height = 28, registry, offset = 0, onNoticeRendered }) {
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
  const headerHeight = short ? 1 : compact ? 2 : 4;
  const toolbarHeight = compact && ['compose', 'confirm', 'decision', 'picker', 'folder', 'notice'].includes(state.view) ? 0 : 3;
  const footerHeight = short ? 1 : 2;
  const notificationHeight = state.requiredNotice ? noticeLines(state, width).length : state.dispatchHold ? 3 : 2;
  const suggestionHeight = state.view === 'command' && state.suggestions.length ? 1 : 0;
  const bodyHeight = Math.max(2, height - headerHeight - toolbarHeight - footerHeight - notificationHeight - suggestionHeight);
  const split = width >= 88 && bodyHeight >= 12 && (width >= 110 || !['compose', 'confirm', 'decision', 'picker', 'folder', 'notice'].includes(state.view));
  const listWidth = split ? Math.floor(width * .52) : width;
  const rightWidth = width - listWidth;
  const activePanel = state.view === 'compose' ? Composer : state.view === 'confirm' ? Confirmation : state.view === 'decision' ? Decision : state.view === 'notice' ? NoticeDetail : ['picker', 'folder'].includes(state.view) ? ProjectPicker : state.boardView === 'tasks' ? TaskDetail : Detail;
  const List = state.boardView === 'tasks' ? TaskList : AgentList;
  const notice = state.notice?.message || (state.snapshot.source.state !== 'connected' ? `${state.snapshot.updatedAt ? 'Stale snapshot. ' : ''}${state.snapshot.source.message || 'Waiting for Herdr…'}` : state.snapshot.mode === 'demo' ? 'Sample agents only. Launch, focus and close are disabled.' : state.view === 'command' ? 'Use agent: to choose a provider; without a prefix, Codex runs the task. Enter submits.' : state.view === 'confirm' ? 'Review the captured identity. Cancel is selected by default.' : state.view === 'compose' ? 'Optional launch settings. Escape keeps your draft.' : 'Ready. Type /dispatch your task, or select an agent to focus its native pane.');
  let footer = ['command', 'compose'].includes(state.view) && state.dispatchHold ? 'Ctrl+F focus pane · Ctrl+Y allow new · Esc back' : state.view === 'command' ? 'Enter dispatch · Esc keep command · Ctrl+C quit' : state.view === 'compose' ? short ? 'Tab fields · Ctrl+S dispatch · Esc back' : 'Tab / Shift+Tab fields  ←→ choose  Ctrl+S dispatch  Esc keep draft  Ctrl+C quit' : state.view === 'confirm' ? 'Tab choose · Enter activate · y close · Esc cancel' : state.view === 'search' ? 'Type to search · Enter keep · Esc clear · Ctrl+C quit' : short ? 'q quit · / dispatch · ↑↓ · ↵ focus · x' : '/ dispatch  ↑↓ / jk select  Enter focus  x close  n setup  s search  f filter  q quit';
  const project = [...state.projects, ...state.trustRequired].find(item => (item.key || item.root) === state.draft.projectKey);
  if (short) footer = state.view === 'command' ? '↵ send · Tab complete · Esc back' : state.view === 'compose' ? 'Tab fields · Ctrl+S send · Esc' : ['confirm', 'decision'].includes(state.view) ? 'Esc cancel · y confirm · ↑↓ more' : state.view === 'detail' ? '↑↓ scroll · ↵ focus · Esc back' : ['/ dispatch', '↑↓', '↵ focus', 'x close'].join(' · ');
  const defaults = `Codex · ${state.projectsLoading ? 'Projects loading…' : project?.name || 'Choose a project'} · ${project?.root || state.projectsError || 'n Setup → Project'}`;
  const commandValue = state.command || '/dispatch [agent][@project][+here]: task · default Codex';
  const commandDisplay = state.view === 'command' ? editorLines(state.command, state.cursor.command, Math.max(4, width - (width < 70 ? 4 : 10)), 1)[0] : commandValue;
  return h(Box, { width, height, flexDirection: 'column', backgroundColor: C.canvas, overflow: 'hidden' },
    h(Box, { height: headerHeight, flexShrink: 0, alignItems: compact ? 'flex-start' : 'center', gap: 1 },
      h(Dog, { compact }),
      h(Box, { flexDirection: 'column', flexGrow: 1, minWidth: 0 }, line('shep.  Your agents, together.', { bold: true, color: C.orange }), !short && line(`${agents.length} agents · ${agents.filter(agent => agent.status === 'working').length} working · ${agents.filter(agent => agent.status === 'blocked').length} need input`, { color: C.muted })),
      h(Box, { flexDirection: 'column', flexShrink: 0, maxWidth: Math.floor(width * .35) }, line(status.label, { color: status.color, bold: true }), !compact && line(state.snapshot.source.scope || 'Current Herdr session', { color: C.faint }))),
    toolbarHeight > 0 && h(Box, { height: toolbarHeight, flexShrink: 0, flexDirection: 'column' },
      state.view === 'command' && width < 70 ? h(Box, { height: 1, flexShrink: 0 },
        h(Button, { label: '↑ Recall', registry, id: 'recall-prev', action: () => model.action('command-recall', -1) }),
        h(Button, { label: '↓ Next', registry, id: 'recall-next', action: () => model.action('command-recall', 1) }),
        h(Button, { label: 'Refresh', registry, id: 'command-refresh', action: () => model.action('refresh') }),
        h(Button, { label: 'Back', registry, id: 'command-back', action: () => model.action('cancel') })) :
      h(Box, { height: 1, flexShrink: 0, gap: 0 },
        h(Button, { label: short ? 'n New' : 'n Setup', registry, id: 'new', disabled: state.view === 'command', action: () => model.action('new') }),
        h(Button, { label: `g ${state.boardView === 'tasks' ? 'Agents' : 'Tasks'}`, registry, id: 'board-toggle', action: () => model.action('board-toggle') }),
        h(Button, { label: `f ${state.filter === 'all' ? 'All' : TASK_LABELS[state.filter]}`, registry, id: 'filter', disabled: state.view === 'command', action: () => model.action('filter') }),
        h(Click, { registry, id: 'search', action: () => model.action('search'), flexGrow: 1, minWidth: 0 }, line(`s ${state.query}${state.view === 'search' ? '▏' : state.query ? '' : 'Search'}`, { color: state.view === 'search' ? C.orange : C.muted }))),
      line(`Default: ${defaults}`, { color: C.muted }),
      h(Box, { height: 1, flexShrink: 0 },
        h(Click, { registry, id: 'command', action: () => model.action('command'), flexGrow: 1, minWidth: 0, backgroundColor: state.view === 'command' ? C.selected : C.panel }, line(`› ${commandDisplay}`, { color: state.view === 'command' ? C.ink : C.orange })),
        state.view === 'command' && width >= 70 && h(Button, { label: '↑', registry, id: 'recall-prev', action: () => model.action('command-recall', -1) }),
        state.view === 'command' && width >= 70 && h(Button, { label: '↓', registry, id: 'recall-next', action: () => model.action('command-recall', 1) }))),
    h(Box, { height: bodyHeight, flexShrink: 0 },
      split ? h(React.Fragment, null,
        h(List, { state, model, width: listWidth, height: bodyHeight, registry, offset }),
        h(activePanel, { state, model, width: rightWidth, height: bodyHeight, registry })) :
        ['compose', 'confirm', 'decision', 'picker', 'folder', 'detail', 'notice'].includes(state.view) ? h(activePanel, { state, model, width, height: bodyHeight, registry }) : h(List, { state, model, width, height: bodyHeight, registry, offset, compactActions: true })),
    suggestionHeight > 0 && h(Suggestions, { state, model, width, registry }),
    state.requiredNotice ? h(RequiredNotice, { state, width, onNoticeRendered }) : h(Box, { height: notificationHeight, paddingX: 1, flexShrink: 0, overflow: 'hidden', flexDirection: 'column' },
      h(Click, { registry, id: 'notice-detail', action: () => model.action('notice-open'), height: 2, flexShrink: 0, overflow: 'hidden' }, h(Text, { color: state.notice?.kind === 'warning' ? C.working : state.notice?.kind === 'success' ? C.done : C.muted, wrap: 'wrap' }, truncate(`${state.notice ? 'ⓘ ' : ''}${notice}`, width * 2 - 4))),
      state.dispatchHold && h(Box, { gap: 1, flexShrink: 0 },
        h(Button, { label: 'Allow new launch', registry, id: 'notice-allow', action: () => model.action('allow-launch') }),
        state.resultTarget && h(Button, { label: 'Focus pane', registry, id: 'notice-focus', action: () => model.action('focus-result') }))),
    h(Box, { height: footerHeight, flexDirection: 'column', flexShrink: 0 },
      h(Box, { height: 1, flexShrink: 0 },
        h(Button, { label: short ? 'Quit' : 'Quit Ctrl+C', registry, id: 'quit', action: () => model.action('quit') }),
        h(Box, { flexGrow: 1, minWidth: 0 }, line(footer, { color: C.muted }))),
      !short && h(Box, { justifyContent: 'space-between' }, line(state.view === 'board' && !split ? `Selected: ${state.snapshot.agents.find(agent => agent.id === state.selectedId)?.paneId || 'none'}` : url, { color: C.faint }), line('Quit preserves agents', { color: C.faint }))));
}

function App({ model, url, output, registry, onNoticeRendered }) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const size = useWindowSize();
  // Leave the final physical cell unused: Ink's incremental repaint appends
  // eraseEndLine, which can erase a full-width row's last cell in pending-wrap
  // state. Herdr can also report one extra column on entering alternate screen.
  const width = Math.max(1, Math.min(300, (size.columns || output.columns || 100) - 1));
  const height = Math.max(1, Math.min(120, (size.rows || output.rows || 28) - 1));
  const [offset, setOffset] = useState(0);
  const rows = boardRows(state);
  const header = height < 25 ? 2 : 4;
  const capacity = Math.max(1, height - header - (state.dispatchHold ? 13 : 12));
  const maxOffset = Math.max(0, rows.length - capacity);
  const selectedRow = rows.findIndex(row => row.type === 'agent' && row.agent.id === state.selectedId || row.type === 'task' && row.row.id === state.selectedTaskId);
  useEffect(() => {
    setOffset(previous => Math.max(0, Math.min(maxOffset, selectedRow < previous ? selectedRow : selectedRow + Math.min(2, capacity) > previous + capacity ? selectedRow + Math.min(2, capacity) - capacity : previous)));
  }, [state.selectedId, state.selectedTaskId, selectedRow, capacity, maxOffset]);
  useInput((input, key) => {
    if (width < 39 || height < 14) { if (input === 'q' || key.ctrl && ['c', 'd'].includes(input)) model.action('quit'); return; }
    const mouse = parseMouse(input);
    if (mouse) {
      if (mouse.release || state.busy) return;
      if ((mouse.button & 64) === 64) {
        const direction = (mouse.button & 1) ? 1 : -1;
        if (state.view === 'board' || state.view === 'search') setOffset(previous => Math.max(0, Math.min(maxOffset, previous + direction * 3)));
        else if (state.view === 'picker') model.action('picker-move', direction);
        else if (state.view === 'detail' || state.view === 'notice') model.action('detail-scroll', direction);
        else if (state.view === 'decision') model.action('decision-scroll', direction);
        return;
      }
      if ((mouse.button & 3) !== 0) return;
      const target = hitTest(mouse, registry.values(), measureElement);
      target?.action();
      return;
    }
    model.key(input, key);
  });
  usePaste(text => model.paste(text));
  return h(TuiView, { state, model, url, width, height, registry, offset: Math.min(offset, maxOffset), onNoticeRendered });
}

export function startTui({ monitor, controller, registry: projects, getConfig, reloadConfig, addTrustedRepo, summarize, url = '', onQuit, input = process.stdin, output = process.stdout }) {
  if (!input.isTTY || !output.isTTY) throw new Error('The Ink interface requires a terminal. Use the plain terminal fallback for redirected output.');
  const registry = new Map();
  let instance;
  let stopped = false;
  let renderedNotice = null;
  let outputError = null;
  const outputFailed = error => { outputError = error; };
  output.on('error', outputFailed);
  const model = createTuiModel({ monitor, controller, registry: projects, getConfig, reloadConfig, addTrustedRepo, summarize, onQuit,
    acknowledgeNotice: async (token, signal) => {
      if (!instance || stopped || signal.aborted || output.destroyed || outputError) throw new Error('The terminal cannot display the required location notice.');
      await instance.waitUntilRenderFlush();
      if (stopped || signal.aborted || output.destroyed || outputError || renderedNotice !== token) throw new Error('The required location notice was not flushed for this task.');
    } });
  const priorRaw = Boolean(input.isRaw);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    model.destroy();
    registry.clear();
    output.off('error', outputFailed);
    try { output.write(MOUSE_OFF); } catch { /* Output may have already closed. */ }
    try { instance?.cleanup(); } finally {
      try { if (Boolean(input.isRaw) !== priorRaw) input.setRawMode(priorRaw); } catch { /* Detached input. */ }
    }
  };
  try {
    // Tasks/Agents replace sibling Yoga trees. Ink's incremental cache can
    // retain erased rows across that swap; full repaint keeps borders/hitboxes
    // aligned while the frame remains bounded by the terminal dimensions.
    instance = render(h(App, { model, url, output, registry, onNoticeRendered: token => { renderedNotice = token; } }), { stdin: input, stdout: output, stderr: output, exitOnCtrlC: false, patchConsole: false, alternateScreen: true, interactive: true, incrementalRendering: false, maxFps: 30 });
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
  stop.getTasks = model.getTasks;
  stop.showNotice = model.showNotice;
  return stop;
}
