import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, open, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCodexModelReader } from '../src/codex-model-info.mjs';

const rootId = '00000000-0000-7000-8000-000000000001';
const childId = '00000000-0000-7000-8000-000000000002';
const otherId = '00000000-0000-7000-8000-000000000003';
const target = { paneId: 'w9:p2', terminalId: 'terminal-codex' };
const jsonl = records => records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n';
const meta = (id = rootId, extra = {}) => ({ type: 'session_meta', payload: { id, session_id: id, source: 'cli',
  base_instructions: 'PRIVATE-INSTRUCTIONS', cwd: '/PRIVATE-CWD', ...extra } });
const turn = (model = 'gpt-6.1-sol', effort = 'high') => ({ type: 'turn_context', payload: { model, effort, cwd: '/PRIVATE-CWD',
  summary: 'PRIVATE-CONVERSATION', approval_policy: 'PRIVATE-SETTINGS' } });

async function fixture(t) {
  const home = await mkdtemp('/private/tmp/shep-codex-model-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const folder = join(home, '.codex', 'sessions', '2026', '10', '06');
  await mkdir(folder, { recursive: true });
  const path = id => join(folder, `rollout-2026-10-06T22-05-49-${id}.jsonl`);
  const f = { home, path, calls: [], clock: 0, pid: 701, shellPid: 700, paths: [path(rootId)], failures: {}, overrides: {}, counts: {} };
  f.put = (id, records = [meta(id), turn()]) => writeFile(path(id), jsonl(records));
  await f.put(rootId);
  f.descriptors = async () => {
    const records = [];
    for (const [index, path] of f.paths.entries()) {
      const info = await stat(path);
      records.push(`f${index + 3}\nD0x${info.dev.toString(16)}\ni${info.ino}\nn${path}`);
    }
    return `p${f.pid}\n${records.join('\n')}\n`;
  };
  const execute = (binary, args, options, done) => {
    f.calls.push({ binary, args: [...args], options });
    const count = f.counts[binary] = (f.counts[binary] || 0) + 1;
    Promise.resolve().then(async () => {
      if (f.failures[binary]) throw f.failures[binary];
      const custom = await f.overrides[binary]?.(count, args);
      if (custom !== undefined) return custom;
      if (binary === 'herdr-fixture') return JSON.stringify({ result: { process_info: { pane_id: target.paneId, shell_pid: f.shellPid,
        foreground_processes: [{ pid: f.pid, name: 'PRIVATE-NAME', argv: ['PRIVATE-PROMPT'], command_line: 'PRIVATE-COMMAND' }] } } });
      if (binary === 'ps') return `${f.shellPid} 1 /bin/zsh\n${f.pid} ${f.shellPid} /installed/bin/codex\n`;
      if (binary === 'lsof') return f.descriptors();
      throw new Error('Unexpected binary');
    }).then(output => done(null, output), error => done(error, 'PRIVATE-ERROR-OUTPUT'));
  };
  f.read = createCodexModelReader({ home, context: { binary: 'herdr-fixture', env: { HERDR_SOCKET_PATH: '/fixture/current.sock' } }, execute, now: () => f.clock, readSharedModel: async () => undefined });
  f.advance = () => { f.clock += 10_000; };
  return f;
}

test('Codex reader binds a root rollout to its exact foreground process and projects only model/effort', async t => {
  const f = await fixture(t);
  const result = await f.read({ ...target, sessionId: otherId, provider: 'codex', cwd: '/untrusted' });
  assert.deepEqual(result, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(f.calls.map(call => [call.binary, call.args]), [
    ['herdr-fixture', ['pane', 'process-info', '--pane', target.paneId]],
    ['ps', ['-o', 'pid=,ppid=,comm=', '-p', '700,701']],
    ['lsof', ['-nP', '-a', '-p', '701', '-FpfDin']],
    ['herdr-fixture', ['pane', 'process-info', '--pane', target.paneId]],
    ['ps', ['-o', 'pid=,ppid=,comm=', '-p', '700,701']],
  ]);
  for (const { options } of f.calls) {
    assert.equal(options.env.LC_ALL, 'C'); assert.equal(options.timeout, 2000);
    assert.equal(options.shell, undefined); assert.equal(options.killSignal, 'SIGKILL'); assert(options.maxBuffer <= 256 * 1024);
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|session|pid|path|cwd/);
});

test('Codex reader excludes subagents and deduplicates repeated descriptors for the same root', async t => {
  const f = await fixture(t);
  await f.put(childId, [meta(childId, { source: { subagent: { other: 'guardian' } }, session_id: rootId, parent_thread_id: rootId }), turn('subagent-model', 'low')]);
  f.paths = [f.path(childId), f.path(rootId), f.path(rootId)];
  assert.deepEqual(await f.read(target), { model: 'gpt-6.1-sol', effort: 'high' });
  await f.put(childId, [meta(childId, { parent_thread_id: rootId }), turn('subagent-model', 'low')]); f.advance();
  assert.deepEqual(await f.read(target), { model: 'gpt-6.1-sol', effort: 'high' });
});

test('multiple root rollouts and shared clients without owned rollouts stay blank', async t => {
  const f = await fixture(t); await f.put(otherId);
  f.paths.push(f.path(otherId)); assert.equal(await f.read(target), undefined);
  f.paths = []; f.advance(); assert.equal(await f.read(target), undefined);
  assert.equal(f.calls.filter(call => call.binary === 'lsof').length, 2);
});

test('Codex metadata requires matching filename/root ID, CLI source and a complete bounded header', async t => {
  const f = await fixture(t);
  for (const header of [meta(otherId), meta(rootId, { session_id: otherId }), meta(rootId, { source: 'vscode' }),
    meta(rootId, { parent_thread_id: rootId }), { type: 'user', payload: meta().payload }, 'malformed',
    meta(rootId, { base_instructions: 'x'.repeat(70 * 1024) })]) {
    await f.put(rootId, [header, turn()]); f.advance(); assert.equal(await f.read(target), undefined);
  }
});

test('only one actual Codex shell child with valid process rows can own metadata', async t => {
  const f = await fixture(t);
  for (const output of ['', 'malformed', '700 1 /bin/zsh\n701 700 /bin/claude\n', '700 1 /bin/zsh\n701 1 /bin/codex\n',
    '700 1 /bin/zsh\n701 700 /bin/codex\n701 700 /bin/codex\n', '700 1 /bin/zsh\n701 700 /bin/codex\n999 700 /bin/codex\n']) {
    f.overrides.ps = () => output; f.advance(); assert.equal(await f.read(target), undefined);
  }
  f.overrides.ps = () => '700 1 /bin/zsh\n701 700 /bin/codex\n702 700 /bin/codex\n';
  f.overrides['herdr-fixture'] = () => JSON.stringify({ result: { process_info: { pane_id: target.paneId, shell_pid: 700, foreground_processes: [{ pid: 701 }, { pid: 702 }] } } });
  f.advance(); assert.equal(await f.read(target), undefined);
  assert.equal(f.calls.filter(call => call.binary === 'lsof').length, 0);
});

test('Codex process and transport failures never fall back to files or Herdr session IDs', async t => {
  const f = await fixture(t);
  for (const binary of ['herdr-fixture', 'ps', 'lsof']) {
    f.failures[binary] = new Error('PRIVATE-ERROR'); f.advance(); assert.equal(await f.read(target), undefined); delete f.failures[binary];
  }
  for (const raw of ['not-json', '{}', JSON.stringify({ result: { process_info: { pane_id: 'wrong', shell_pid: 700, foreground_processes: [{ pid: 701 }] } } })]) {
    f.overrides['herdr-fixture'] = () => raw; f.advance(); assert.equal(await f.read(target), undefined);
  }
});

test('owned descriptor device/inode and PID must match the opened rollout', async t => {
  const f = await fixture(t);
  for (const transform of [s => s.replace('p701', 'p999'), s => s.replace(/D0x[0-9a-f]+/, 'D0x1'),
    s => s.replace(/i\d+/, 'i1'), s => s.replace(/i\d+\n/, ''), s => s.replace(/D0x[0-9a-f]+/, 'Dbad')]) {
    f.overrides.lsof = async () => transform(await f.descriptors()); f.advance(); assert.equal(await f.read(target), undefined);
  }
  f.overrides.lsof = async () => {
    const held = await f.descriptors();
    await rename(f.path(rootId), f.path(rootId) + '.old'); await f.put(rootId, [meta(), turn('replacement-model')]);
    return held;
  };
  f.advance(); assert.equal(await f.read(target), undefined, 'A replaced path is not the file held by the process');
});

test('Codex reader refuses symlinked files and session ancestors', async t => {
  const f = await fixture(t), outside = join(f.home, 'outside.jsonl');
  await writeFile(outside, jsonl([meta(), turn()])); await rm(f.path(rootId)); await symlink(outside, f.path(rootId));
  assert.equal(await f.read(target), undefined);
  await rm(f.path(rootId)); await f.put(rootId);
  const sessions = join(f.home, '.codex', 'sessions'); await rename(sessions, sessions + '.old'); await symlink(sessions + '.old', sessions);
  f.advance(); assert.equal(await f.read(target), undefined);
});

test('Codex refresh cache shares pending reads, copies fields and forgets removed terminals', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.read(target), f.read(target)]);
  first.model = 'caller-mutation'; assert.equal(second.model, 'gpt-6.1-sol'); assert.equal(f.calls.length, 5);
  await appendFile(f.path(rootId), jsonl([turn('gpt-next', 'xhigh')]));
  f.clock = 9999; assert.equal((await f.read(target)).model, 'gpt-6.1-sol'); assert.equal(f.calls.length, 5);
  f.clock = 10_000; assert.deepEqual(await f.read(target), { model: 'gpt-next', effort: 'xhigh' });
  f.read.retain([]); assert.equal((await f.read(target)).model, 'gpt-next'); assert.equal(f.calls.length, 15);
});

test('same-file large reply growth and subsequent unchanged refreshes keep verified fields', async t => {
  const f = await fixture(t); assert.equal((await f.read(target)).model, 'gpt-6.1-sol');
  await appendFile(f.path(rootId), jsonl([{ type: 'response_item', payload: { text: 'PRIVATE'.repeat(5_000_000), model: 'spoof' } }]));
  for (let index = 0; index < 3; index++) { f.advance(); assert.deepEqual(await f.read(target), { model: 'gpt-6.1-sol', effort: 'high' }); }
  await f.put(rootId, [meta(), { type: 'response_item', payload: { text: 'PRIVATE' } }]);
  f.advance(); assert.equal(await f.read(target), undefined, 'Truncation does not inherit fields');
});

test('normal log append during a bounded tail read does not blank the model', async t => {
  const f = await fixture(t), handle = await open(f.path(rootId)), prototype = Object.getPrototypeOf(handle), originalRead = prototype.read;
  await handle.close(); let reads = 0;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await originalRead.apply(this, args);
    if (++reads === 2) await appendFile(f.path(rootId), jsonl([{ type: 'response_item', payload: { text: 'PRIVATE-APPEND' } }]));
    return result;
  });
  assert.deepEqual(await f.read(target), { model: 'gpt-6.1-sol', effort: 'high' });
  assert(reads >= 3, 'Growth rechecks the root header');
});

test('replacement, unreadable and removed rollouts clear cached fields', async t => {
  const f = await fixture(t); await f.read(target);
  await rename(f.path(rootId), f.path(rootId) + '.old'); await f.put(rootId, [meta(), { type: 'response_item', payload: { text: 'PRIVATE' } }]);
  f.advance(); assert.equal(await f.read(target), undefined);
  await f.put(rootId); f.advance(); assert((await f.read(target)).model);
  try { await chmod(f.path(rootId), 0); f.advance(); assert.equal(await f.read(target), undefined); }
  finally { await chmod(f.path(rootId), 0o600); }
  await rm(f.path(rootId)); f.advance(); assert.equal(await f.read(target), undefined);
});

test('a pane process replaced during metadata reading rejects the late result', async t => {
  const f = await fixture(t);
  f.overrides['herdr-fixture'] = count => { if (count === 2) f.pid = 702; };
  assert.equal(await f.read(target), undefined);
  assert.equal(f.calls.length, 5);
});

test('malformed tails and unsafe model/effort fields never expose other record content', async t => {
  const f = await fixture(t);
  for (const [records, expected] of [
    [[meta(), turn(), 'partial {'], { model: 'gpt-6.1-sol', effort: 'high' }],
    [[meta(), { type: 'user', payload: { model: 'spoof', effort: 'spoof' } }], undefined],
    [[meta(), turn('\u001b[31mPRIVATE', 'high')], { effort: 'high' }],
    [[meta(), turn('gpt-valid', 'PRIVATE\nMESSAGE')], { model: 'gpt-valid' }],
    [[meta(), turn({ private: 'PRIVATE' }, ['high'])], undefined],
  ]) {
    await f.put(rootId, records); f.advance(); assert.deepEqual(await f.read(target), expected);
  }
  await f.put(rootId, [meta(), turn(), { type: 'response_item', payload: { text: 'PRIVATE'.repeat(5_000_000) } }]);
  f.read.retain([]); assert.equal(await f.read(target), undefined, 'A fresh reader never scans outside its bounded tail');
});

test('first Codex metadata read finds a turn context beyond a long completed reply', async t => {
  const f = await fixture(t);
  await f.put(rootId, [meta(), turn(), { type: 'response_item', payload: { text: 'PRIVATE'.repeat(180_000) } }]);
  assert.deepEqual(await f.read(target), { model: 'gpt-6.1-sol', effort: 'high' });
});

test('fresh Codex metadata survives a completed tool response larger than eight MiB', async t => {
  const f = await fixture(t);
  await f.put(rootId, [meta(), turn(), { type: 'response_item', payload: { text: 'PRIVATE'.repeat(1_400_000) } }]);
  assert.deepEqual(await f.read(target), { model: 'gpt-6.1-sol', effort: 'high' });
  assert.doesNotMatch(JSON.stringify(await f.read(target)), /PRIVATE|response|text|path/);
});

test('backward Codex scan reassembles metadata records crossing chunk boundaries', async t => {
  const f = await fixture(t);
  await f.put(rootId, [meta(), { ...turn('gpt-boundary', 'xhigh'), extra: 'PRIVATE'.repeat(200) },
    { type: 'response_item', payload: { text: 'x'.repeat(64 * 1024 - 300) } }]);
  assert.deepEqual(await f.read(target), { model: 'gpt-boundary', effort: 'xhigh' });
});

test('a newer turn context larger than one read chunk replaces older model fields', async t => {
  const f = await fixture(t);
  await f.put(rootId, [meta(), turn('old-model', 'low'), { type: 'turn_context', payload: {
    ...turn('new-model', 'xhigh').payload, developer_instructions: 'PRIVATE'.repeat(12_000) } }]);
  assert.deepEqual(await f.read(target), { model: 'new-model', effort: 'xhigh' });
  await appendFile(f.path(rootId), jsonl([{ type: 'turn_context', payload: {
    ...turn('PRIVATE\u001b[31m', 'PRIVATE\nMESSAGE').payload, developer_instructions: 'PRIVATE'.repeat(12_000) } }]));
  f.advance(); assert.equal(await f.read(target), undefined, 'Invalid latest fields do not inherit older fields');
});

test('Codex tail scan has a thirty-two MiB cap and unchanged files avoid scanning again', async t => {
  const f = await fixture(t), handle = await open(f.path(rootId)), prototype = Object.getPrototypeOf(handle), originalRead = prototype.read;
  await handle.close(); const reads = [];
  t.mock.method(prototype, 'read', async function (...args) { reads.push({ length: args[2], offset: args[3] }); return originalRead.apply(this, args); });
  await f.put(rootId, [meta(), turn(), { type: 'response_item', payload: { text: 'x'.repeat(33 * 1024 * 1024) } }]);
  assert.equal(await f.read(target), undefined);
  assert(reads.every(item => item.length <= 64 * 1024));
  assert.equal(reads.filter(item => item.offset > 0).reduce((sum, item) => sum + item.length, 0), 32 * 1024 * 1024);
  reads.length = 0; f.advance(); assert.equal(await f.read(target), undefined);
  assert.deepEqual(reads.map(item => item.offset), [0], 'Unchanged verified files need only their root header');
});

test('invalid requests never execute a subprocess', async t => {
  const f = await fixture(t);
  for (const request of [undefined, null, {}, { paneId: '' }, { paneId: target.paneId }, { ...target, terminalId: null }]) assert.equal(await f.read(request), undefined);
  assert.equal(f.calls.length, 0);
});
