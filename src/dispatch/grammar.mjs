import { homedir } from 'node:os';
import { BUILTIN_TEMPLATES, DEFAULT_PROVIDER, LIMITS, MESSAGES, PATTERNS, PROVIDERS, validatePrompt } from './contracts.mjs';
import { expandTemplate } from './templates.mjs';
import { safeText } from '../terminal.mjs';

const lower = value => String(value).toLowerCase();
const error = (message, code) => ({ error: message, code });
const names = new Map(PROVIDERS.map(provider => [provider.id, provider.name]));
const text = (message, values) => message.replace(/\{(\w+)\}/g, (_, key) => safeText(values[key] ?? ''));
const templatesFor = ctx => ({ ...BUILTIN_TEMPLATES, ...ctx.config?.templates });
const entriesFor = ctx => [...(ctx.projects ?? []), ...(ctx.trustRequired ?? [])];
const matches = (project, value) => [project.name, ...(project.aliases ?? [])].some(name => lower(name) === lower(value));

function distance(a, b) {
  a = lower(a); b = lower(b);
  const limit = a.length + b.length, seen = new Map();
  const grid = Array.from({ length: a.length + 2 }, () => Array(b.length + 2).fill(0));
  grid[0][0] = limit;
  for (let i = 0; i <= a.length; i += 1) { grid[i + 1][0] = limit; grid[i + 1][1] = i; }
  for (let j = 0; j <= b.length; j += 1) { grid[0][j + 1] = limit; grid[1][j + 1] = j; }
  for (let i = 1; i <= a.length; i += 1) {
    let lastMatch = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const previousRow = seen.get(b[j - 1]) ?? 0, previousColumn = lastMatch;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      if (!cost) lastMatch = j;
      grid[i + 1][j + 1] = Math.min(grid[i][j] + cost, grid[i + 1][j] + 1, grid[i][j + 1] + 1,
        grid[previousRow][previousColumn] + i - previousRow - 1 + 1 + j - previousColumn - 1);
    }
    seen.set(a[i - 1], i);
  }
  return grid[a.length + 1][b.length + 1];
}

function resolveProject(value, ctx) {
  const projects = entriesFor(ctx);
  const selected = projects.filter(project => matches(project, value));
  if (selected.length === 1) return selected[0];
  if (selected.length > 1) {
    const home = homedir();
    const matches = selected.map(project => `${project.name} (${project.root.startsWith(`${home}/`) ? `~${project.root.slice(home.length)}` : project.root})`).join(', ');
    return error(text(MESSAGES.ambiguousProject, { project: value, count: selected.length, matches }), 'ambiguous_project');
  }
  const suggestions = [...new Set(projects.map(project => project.name))].map(name => ({ name, distance: distance(name, value) }))
    .filter(item => item.distance <= LIMITS.projectSuggestionDistance).sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, LIMITS.projectSuggestions).map(item => item.name);
  return error(text(suggestions.length ? MESSAGES.unknownProjectSuggestion : MESSAGES.unknownProject, { project: value, suggestions: suggestions.join(', ') }), 'unknown_project');
}

export function parseCommand(line, ctx = {}) {
  if (typeof line !== 'string') return error(MESSAGES.unknownCommand, 'unknown_command');
  const command = /^\/([a-z][a-z0-9-]*)(?:[ \t]+([\s\S]*))?$/.exec(line);
  const templates = templatesFor(ctx);
  if (!command || (command[1] !== 'dispatch' && !(Object.hasOwn(templates, command[1]) && templates[command[1]]))) return error(MESSAGES.unknownCommand, 'unknown_command');
  const template = command[1] === 'dispatch' ? null : command[1];
  let inputTask = command[2] ?? '';
  let agents = [{ provider: DEFAULT_PROVIDER, profile: null }], projectName = null, modeIntent = 'auto';
  const prefix = /^([^\s:]+):[ \t]?([\s\S]*)$/.exec(inputTask);
  if (prefix) {
    inputTask = prefix[2];
    const spec = /^([^@+]*)(?:@([^+]*))?(?:\+(.*))?$/.exec(prefix[1]);
    if (!spec) return error('Invalid dispatch prefix. Use agent@project+wt: task.', 'invalid_spec');
    const tokens = spec[1] ? spec[1].split(',') : [DEFAULT_PROVIDER];
    if (tokens.length > LIMITS.agentsPerDispatch) return error(MESSAGES.tooManyAgents, 'too_many_agents');
    agents = [];
    for (const token of tokens) {
      const [rawProvider, profile, extra] = token.split('.');
      const provider = lower(rawProvider);
      if (!names.has(provider)) return error(text(MESSAGES.unknownAgent, { agent: rawProvider }), 'unknown_agent');
      if (agents.some(agent => agent.provider === provider)) return error(text(MESSAGES.duplicateAgent, { agent: names.get(provider) }), 'duplicate_agent');
      const profiles = ctx.config?.agents?.[provider]?.profiles ?? {};
      if (profile !== undefined && (extra !== undefined || !PATTERNS.profile.test(profile) || !Object.hasOwn(profiles, profile))) {
        return error(text(MESSAGES.unknownProfile, { agent: names.get(provider), profile: token.slice(rawProvider.length + 1), profiles: Object.keys(profiles).join(', ') || 'none' }), 'unknown_profile');
      }
      agents.push({ provider, profile: profile ?? null });
    }
    if (spec[2] !== undefined) {
      if (!PATTERNS.project.test(spec[2])) return error('Project names contain 1–64 letters, digits, dots, underscores or hyphens.', 'invalid_project');
      projectName = spec[2];
    }
    if (spec[3] !== undefined) {
      if (!['wt', 'here'].includes(spec[3])) return error(text(MESSAGES.unknownMode, { mode: spec[3] }), 'unknown_mode');
      modeIntent = spec[3];
    }
  }
  if (!inputTask.trim()) return error(MESSAGES.emptyTask, 'invalid_prompt');
  if (validatePrompt(inputTask).length) return error(MESSAGES.invalidPrompt, 'invalid_prompt');
  const task = expandTemplate(template, inputTask, templates);
  if (typeof task !== 'string') return task;
  let project = projectName ? resolveProject(projectName, ctx) : entriesFor(ctx).find(project => project.key === ctx.contextProjectKey);
  if (!project && !projectName) project = (ctx.trustRequired ?? []).find(candidate => candidate.root === ctx.contextProjectKey);
  if (!project) return error('Choose a project before dispatching. Use @project: or the project picker.', 'project_required');
  if (project.error) return project;
  if (project.kind === 'trust_required') return { error: project.message, code: 'needs_confirmation', trust: structuredClone(project) };
  if (agents.length > 1 && project.kind !== 'git') return error(MESSAGES.parallelNeedsGit, 'worktree_needs_git');
  if (modeIntent === 'wt' && project.kind !== 'git') return error(text(MESSAGES.worktreeNeedsGit, { project: project.name }), 'worktree_needs_git');
  return { kind: 'dispatch', agents, project: structuredClone(project), mode: agents.length > 1 || modeIntent === 'wt' ? 'worktree' : modeIntent,
    modeIntent, subfolder: projectName ? '' : ctx.contextSubfolder ?? '', template, task, inputTask, command: line };
}

function score(candidate, query) {
  candidate = lower(candidate); query = lower(query);
  if (candidate.startsWith(query)) return 0;
  if (candidate.includes(query)) return 1;
  let position = 0;
  for (const character of candidate) if (character === query[position]) position += 1;
  return position === query.length ? 2 : Infinity;
}

export function suggest(line, cursor, ctx = {}) {
  if (typeof line !== 'string' || !Number.isInteger(cursor) || cursor < 0 || cursor > line.length) return [];
  const before = line.slice(0, cursor);
  const command = /^\/([^\s]*)$/.exec(before);
  if (command) {
    const end = /^\/[^\s]*/.exec(line)?.[0].length ?? cursor;
    return ['dispatch', ...Object.keys(templatesFor(ctx)).filter(name => templatesFor(ctx)[name])].filter(name => name.startsWith(command[1]))
      .slice(0, LIMITS.suggestions).map(name => ({ label: `/${name}`, value: name, replaceStart: 1, replaceEnd: end }));
  }
  const prefix = /^\/[a-z][a-z0-9-]*[ \t]+([^\s:]*)$/.exec(before);
  if (!prefix) return [];
  const token = prefix[1];
  const start = cursor - token.length;
  const end = start + (/^[^\s:]*/.exec(line.slice(start))?.[0].length ?? 0);
  const installed = (ctx.providers ?? PROVIDERS.map(provider => ({ ...provider, available: true }))).filter(provider => provider.available);
  let segmentStart, values, separators = /[@+,.]/;
  if (token.includes('+')) {
    segmentStart = token.lastIndexOf('+') + 1;
    separators = /[,+@]/;
    values = ['wt', 'here'].map(value => ({ label: value, value }));
  } else if (token.includes('@')) {
    segmentStart = token.indexOf('@') + 1;
    separators = /[+]/;
    const projects = entriesFor(ctx);
    values = projects.map(project => {
      const unique = name => projects.filter(candidate => matches(candidate, name)).length === 1;
      const value = unique(project.name) ? project.name : (project.aliases ?? []).find(unique);
      return value ? { label: `${project.name}  ${safeText(project.root)}`, value, projectKey: project.key, match: project.name } : null;
    }).filter(Boolean);
  } else {
    segmentStart = token.lastIndexOf(',') + 1;
    const current = token.slice(segmentStart);
    if (current.includes('.')) {
      const dot = current.indexOf('.');
      const provider = lower(current.slice(0, dot));
      segmentStart += dot + 1;
      separators = /[@+,]/;
      values = installed.some(item => item.id === provider) ? Object.keys(ctx.config?.agents?.[provider]?.profiles ?? {}).map(value => ({ label: value, value })) : [];
    } else values = installed.map(provider => ({ label: provider.name, value: provider.id }));
  }
  const query = token.slice(segmentStart);
  const replaceEnd = Math.min(end, (() => { const tail = line.slice(start + segmentStart, end); const delimiter = tail.search(separators); return delimiter < 0 ? end : start + segmentStart + delimiter; })());
  return values.map((value, index) => ({ ...value, rank: Math.min(score(value.value, query), score(value.match ?? value.value, query)), index }))
    .filter(value => Number.isFinite(value.rank)).sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, LIMITS.suggestions)
    .map(({ rank, index, match, ...value }) => ({ ...value, replaceStart: start + segmentStart, replaceEnd }));
}

export function format(spec) {
  const agents = spec.agents.map(agent => `${agent.provider}${agent.profile ? `.${agent.profile}` : ''}`).join(',');
  const project = spec.project?.aliases?.[0] ?? spec.project?.name;
  const mode = spec.modeIntent && spec.modeIntent !== 'auto' ? `+${spec.modeIntent}` : '';
  return `/${spec.template ?? 'dispatch'} ${agents}${project ? `@${project}` : ''}${mode}: ${spec.inputTask}`;
}
