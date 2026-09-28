import * as nativeFs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, MESSAGES, validateConfigShape } from './dispatch/contracts.mjs';

const copy = value => structuredClone(value);
const expand = (path, homeDir) => path === '~' ? homeDir : path.startsWith('~/') ? join(homeDir, path.slice(2)) : path;
const writes = new Map();
const formatIssue = (issue, path) => ({ ...issue, message: MESSAGES.config.replace('{path}', path).replace('{key}', issue.path || '$').replace('{problem}', issue.message) });

export function configPath({ env = process.env, homeDir = homedir() } = {}) {
  const directory = expand(env.XDG_CONFIG_HOME || join(homeDir, '.config'), homeDir);
  if (!isAbsolute(directory)) throw new TypeError('XDG_CONFIG_HOME must be an absolute directory.');
  return join(directory, 'shep', 'config.json');
}

export function validateConfig(value, { homeDir = homedir() } = {}) {
  const { errors, warnings } = validateConfigShape(value, { homeDir });
  const config = copy(DEFAULT_CONFIG);
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!Object.hasOwn(value, key) || errors.some(issue => issue.path === '' || issue.path === key || issue.path.startsWith(`${key}.`))) continue;
    const section = value[key];
    if (key === 'placement') config[key] = section;
    else if (key === 'agents' || key === 'templates') config[key] = { ...config[key], ...copy(section) };
    else for (const property of Object.keys(config[key])) if (Object.hasOwn(section, property)) config[key][property] = copy(section[property]);
  }
  config.projects.roots = config.projects.roots.map(path => expand(path, homeDir));
  config.projects.entries = config.projects.entries.map(entry => ({ ...entry, path: expand(entry.path, homeDir), aliases: entry.aliases ?? [], isolation: entry.isolation ?? 'auto' }));
  config.worktrees.trustedRepos = config.worktrees.trustedRepos.map(path => expand(path, homeDir));
  return { config, errors, warnings };
}

export async function loadConfig({ fs = nativeFs, homeDir = homedir(), path = configPath({ homeDir }) } = {}) {
  let value;
  try { value = JSON.parse(await fs.readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { path, config: copy(DEFAULT_CONFIG), errors: [], warnings: [] };
    const issue = { path: '', code: 'invalid_config', message: error instanceof SyntaxError ? 'must contain valid JSON' : 'could not read configuration' };
    return { path, config: copy(DEFAULT_CONFIG), errors: [formatIssue(issue, path)], warnings: [] };
  }
  const result = validateConfig(value, { homeDir });
  return { path, ...result, errors: result.errors.map(issue => formatIssue(issue, path)), warnings: result.warnings.map(issue => formatIssue(issue, path)) };
}

// JSON.parse validates first. This small span reader edits one value while keeping
// every unrelated key, numeric spelling, escape sequence and whitespace byte.
function spans(text) {
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? '') && index < text.length) index += 1; };
  function string() { const start = index++; while (index < text.length) { if (text[index++] === '\\') index += 1; else if (text[index - 1] === '"') break; } return { start, end: index }; }
  function value() {
    whitespace(); const start = index;
    if (text[index] === '"') return string();
    if (text[index] === '{') {
      index += 1; const properties = new Map(); whitespace();
      while (text[index] !== '}') {
        const key = string(); whitespace(); index += 1;
        properties.set(JSON.parse(text.slice(key.start, key.end)), value());
        whitespace(); if (text[index] !== ',') break; index += 1; whitespace();
      }
      const close = index++;
      return { start, end: index, close, properties };
    }
    if (text[index] === '[') { index += 1; whitespace(); while (text[index] !== ']') { value(); whitespace(); if (text[index] !== ',') break; index += 1; } index += 1; }
    else while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
    return { start, end: index };
  }
  return value();
}

function setTrust(text, roots) {
  const root = spans(text);
  const worktrees = root.properties.get('worktrees');
  const trusted = worktrees?.properties?.get('trustedRepos');
  const serialized = JSON.stringify(roots);
  if (trusted) return text.slice(0, trusted.start) + serialized + text.slice(trusted.end);
  const object = worktrees ?? root;
  const addition = worktrees ? `"trustedRepos": ${serialized}` : `"worktrees": {"trustedRepos": ${serialized}}`;
  const prefix = object.properties.size ? ', ' : '';
  return text.slice(0, object.close) + prefix + addition + text.slice(object.close);
}

export async function addTrustedRepo(root, { fs = nativeFs, homeDir = homedir(), path = configPath({ homeDir }) } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new TypeError('Trust requires one absolute repository root.');
  const previous = writes.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const canonical = await fs.realpath(root);
    if (canonical !== root) throw new Error('The confirmed repository root changed. Reselect it before recording trust.');
    if (!(await fs.stat(canonical)).isDirectory()) throw new TypeError('Trust requires an existing repository directory.');
    let text = '{}\n';
    try { text = await fs.readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read configuration for the trust update.'); }
    let original;
    try { original = JSON.parse(text); } catch { throw new Error('Configuration must contain valid JSON before trust can be recorded.'); }
    if (!original || Array.isArray(original) || typeof original !== 'object') throw new Error('Configuration must be an object before trust can be recorded.');
    if (Object.hasOwn(original, 'worktrees') && validateConfigShape({ worktrees: original.worktrees }, { homeDir }).errors.length) throw new Error('Fix the worktrees configuration before recording trust.');
    const roots = original.worktrees?.trustedRepos ?? [];
    if (roots.some(path => expand(path, homeDir) === canonical)) return loadConfig({ path, fs, homeDir });
    const updated = setTrust(text, [...roots, canonical]);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(path), `.config-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, updated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, path);
    } finally { await fs.rm(temporary, { force: true }); }
    return loadConfig({ path, fs, homeDir });
  });
  writes.set(path, pending);
  try { return await pending; } finally { if (writes.get(path) === pending) writes.delete(path); }
}
