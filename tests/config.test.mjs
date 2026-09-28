import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { configPath, validateConfig, loadConfig, addTrustedRepo } from '../src/config.mjs';
import { DEFAULT_CONFIG, VALIDATION_PROBLEMS as P } from '../src/dispatch/contracts.mjs';
import { makeFolder } from './helpers/git-fixtures.mjs';

test('config defaults, tilde paths, section fallback and unknown-key warnings', () => {
  assert.deepEqual(validateConfig({}).config, DEFAULT_CONFIG);
  assert.equal(configPath({ env: {}, homeDir: '/fixture/home' }), '/fixture/home/.config/shep/config.json');
  assert.equal(configPath({ env: { XDG_CONFIG_HOME: '~/custom' }, homeDir: '/fixture/home' }), '/fixture/home/custom/shep/config.json');
  const result = validateConfig({ projects: { roots: ['~/code'], entries: [{ name: 'notes', path: '~/notes' }] }, worktrees: { trustedRepos: ['~'] }, notifications: { sound: 'bad', enabled: false }, surprise: true }, { homeDir: '/fixture/home' });
  assert.equal(result.config.projects.roots[0], '/fixture/home/code');
  assert.equal(result.config.projects.entries[0].path, '/fixture/home/notes');
  assert.equal(result.config.worktrees.trustedRepos[0], '/fixture/home');
  assert.deepEqual(result.config.notifications, DEFAULT_CONFIG.notifications);
  assert.equal(result.warnings[0].message, P.unknown);
});

const invalid = [
  [null, '', P.object], [{ placement: 'pane' }, 'placement', P.placement],
  [{ projects: [] }, 'projects', P.object], [{ projects: { roots: false } }, 'projects.roots', P.array],
  [{ projects: { roots: ['relative'] } }, 'projects.roots.0', P.absolutePath],
  [{ projects: { entries: false } }, 'projects.entries', P.array],
  [{ projects: { entries: [null] } }, 'projects.entries.0', P.object],
  [{ projects: { entries: [{ name: 'bad name', path: '/ok' }] } }, 'projects.entries.0.name', P.projectName],
  [{ projects: { entries: [{ name: 'ok', path: '/ok', aliases: ['bad alias'] }] } }, 'projects.entries.0.aliases', P.projectName],
  [{ projects: { entries: [{ name: 'ok', path: '/ok', isolation: 'sometimes' }] } }, 'projects.entries.0.isolation', P.isolation],
  [{ worktrees: { branchPrefix: 'bad' } }, 'worktrees.branchPrefix', P.branchPrefix],
  [{ worktrees: { trustedRepos: ['relative'] } }, 'worktrees.trustedRepos.0', P.absolutePath],
  [{ agents: { unknown: {} } }, 'agents.unknown', P.provider],
  [{ agents: { codex: { args: Array(33).fill('a') } } }, 'agents.codex.args', P.argsCount],
  [{ agents: { codex: { args: ['x\x1b'] } } }, 'agents.codex.args.0', P.argument],
  [{ agents: { codex: { profiles: { Upper: { args: [] } } } } }, 'agents.codex.profiles.Upper', P.profileName],
  [{ templates: { dispatch: '{task}' } }, 'templates.dispatch', P.templateName],
  [{ templates: { test: 'bad' } }, 'templates.test', P.template],
  [{ notifications: { enabled: 1 } }, 'notifications.enabled', P.boolean],
  [{ history: { enabled: 'yes' } }, 'history.enabled', P.boolean],
  [{ history: { limit: 0 } }, 'history.limit', P.historyLimit],
  [{ concurrency: { maxLaunches: 5 } }, 'concurrency.maxLaunches', P.maxLaunches],
];
test('config reports every validation category and formats actionable file/key messages', async () => {
  const folder = await makeFolder(); const path = join(folder.root, 'config.json');
  for (const [value, key, message] of invalid) {
    assert.ok(validateConfig(value).errors.some(issue => issue.path === key && issue.message === message), `${key}: ${message}`);
    await fs.writeFile(path, JSON.stringify(value));
    const loaded = await loadConfig({ path });
    assert.ok(loaded.errors.some(issue => issue.message === `Config ${path}: ${key || '$'}: ${message}`));
  }
  await fs.rm(path); assert.deepEqual((await loadConfig({ path })).config, DEFAULT_CONFIG);
  await fs.writeFile(path, '{bad'); assert.match((await loadConfig({ path })).errors[0].message, /valid JSON/);
});

test('trust updates are atomic and preserve unrelated bytes, including unknown settings', async () => {
  const folder = await makeFolder(); const path = join(folder.root, 'config.json');
  const original = '{\n  "custom": { "number": 1e2, "escaped": "\\u0061" },\n  "worktrees": { "branchPrefix": "team/", "trustedRepos": [] },\n  "placement": "split"\n}\n';
  await fs.writeFile(path, original);
  const calls = [];
  const tracked = { ...fs, writeFile: async (...args) => { calls.push(['write', args[0], args[2]]); return fs.writeFile(...args); }, rename: async (...args) => { calls.push(['rename', ...args]); return fs.rename(...args); } };
  await Promise.all([addTrustedRepo(folder.root, { path, fs: tracked }), addTrustedRepo(folder.root, { path, fs: tracked })]);
  assert.equal(await fs.readFile(path, 'utf8'), original.replace('"trustedRepos": []', `"trustedRepos": ${JSON.stringify([folder.root])}`));
  assert.equal(calls.filter(call => call[0] === 'write').length, 1);
  assert.notEqual(calls[0][1], path); assert.equal(calls[0][2].flag, 'wx'); assert.equal(calls[0][2].mode, 0o600);
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
});

test('trust refuses redirected canonical roots and malformed config before any write', async () => {
  const folder = await makeFolder(); const path = join(folder.root, 'config.json');
  await fs.writeFile(path, '{bad');
  await assert.rejects(addTrustedRepo(folder.root, { path }), /valid JSON/);
  assert.equal(await fs.readFile(path, 'utf8'), '{bad');
  let writes = 0;
  const redirected = { ...fs, realpath: async () => `${folder.root}/other`, writeFile: async () => { writes += 1; }, mkdir: async () => { writes += 1; } };
  await assert.rejects(addTrustedRepo(folder.root, { path, fs: redirected }), /root changed/);
  assert.equal(writes, 0);
});
