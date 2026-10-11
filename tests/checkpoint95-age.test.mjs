import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createAgeReader, parseElapsedTime, processIds } from '../src/age-info.mjs';
import { createTuiModel } from '../src/tui-model.mjs';
import { createFakeController, createFakeRegistry, deferred } from './helpers/dispatch-fakes.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const target = { paneId: 'w9:p2V', terminalId: 'terminal-one' };
const info = () => ({ result: { process_info: { pane_id: target.paneId, shell_pid: 700,
  foreground_processes: [{ pid: 702, name: 'caffeinate', argv: ['PRIVATE-STARTUP-TASK'] }, { pid: 701, name: '2.1.296', argv: ['PRIVATE-STARTUP-TASK'] }] } } });
const ps = '  700  1 04-00:59:32\n 702 1 27:59\n701 700 02:14:59\n';
function readerFixture() {
  let time = Date.parse('2026-10-10T12:00:00Z'), processInfo = JSON.stringify(info()), processOutput = ps;
  const calls = [], failures = {};
  const execute = (binary, args, options, callback) => {
    calls.push({ binary, args, options });
    queueMicrotask(() => callback(failures[binary], binary === 'herdr-fixture' ? processInfo : processOutput));
  };
  const read = createAgeReader({ context: { binary: 'herdr-fixture', env: { HERDR_SOCKET_PATH: '/fixture/current.sock', LC_ALL: 'it_IT', SHEP_SESSION: 'ignored' } },
    execute, now: () => time });
  return { read, calls, failures, advance: value => { time += value; }, now: () => time,
    info: value => { processInfo = value; }, ps: value => { processOutput = value; } };
}

test('checkpoint95 parses process elapsed mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
  for (const [value, expected] of [['00:00', 0], ['27:59', 1679000], ['02:14:59', 8099000], ['04-00:59:32', 349172000], ['125:00:00', 450000000]]) {
    assert.equal(parseElapsedTime(value), expected, value);
  }
  for (const value of ['', null, 'bad', '1', '-1:00', '1-20:00', '01:60', '01:60:00', '01-24:00:00', '999999999999-00:00:00', '01:01 private']) {
    assert.equal(parseElapsedTime(value), undefined, String(value));
  }
});

test('checkpoint95 selects only the shell direct child despite caffeinate and a version process name', async () => {
  const f = readerFixture(), result = await f.read(target);
  assert.deepEqual(result, { pid: 701, startedAt: f.now() - 8099000 });
  assert.deepEqual(f.calls.map(({ binary, args }) => ({ binary, args })), [
    { binary: 'herdr-fixture', args: ['pane', 'process-info', '--pane', 'w9:p2V'] },
    { binary: 'ps', args: ['-o', 'pid=,ppid=,etime=', '-p', '700,702,701'] },
  ]);
  for (const { options } of f.calls) {
    assert.equal(options.env.LC_ALL, 'C'); assert.equal(options.env.HERDR_SOCKET_PATH, '/fixture/current.sock');
    assert.equal(options.timeout, 2000); assert.equal(options.killSignal, 'SIGKILL'); assert.equal(options.encoding, 'utf8');
    assert.equal(options.shell, undefined); assert(options.maxBuffer <= 256 * 1024);
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|argv|caffeinate|2\.1\.296/);
});

test('checkpoint95 process projection never accesses argv, commands or names, even via getters', () => {
  const raw = info();
  for (const process of raw.result.process_info.foreground_processes) for (const key of ['argv', 'argv0', 'command', 'command_line', 'name']) {
    Object.defineProperty(process, key, { get() { throw new Error(`Forbidden read: ${key}`); }, enumerable: true });
  }
  assert.deepEqual(processIds(raw, target.paneId), { shellPid: 700, pids: [702, 701] });
});

test('checkpoint95 an exited non-child process omitted by ps does not hide the direct child age', async () => {
  const f = readerFixture(); f.ps(ps.replace(' 702 1 27:59\n', ''));
  assert.deepEqual(await f.read(target), { pid: 701, startedAt: f.now() - 8099000 });
});

test('checkpoint95 zero or multiple direct children and malformed process data stay blank', async () => {
  for (const output of [ps.replace('701 700', '701 1'), ps.replace('702 1', '702 700'), '', 'bad output', ps.replace('02:14:59', 'garbage'),
    ps.replace('701 700 02:14:59\n', ''), ps + '701 700 02:14:59\n', ps + '703 700 00:01\n']) {
    const f = readerFixture(); f.ps(output); assert.equal(await f.read(target), undefined, output);
  }
  for (const raw of [null, {}, { result: { process_info: { ...info().result.process_info, pane_id: 'w9:wrong' } } },
    { result: { process_info: { ...info().result.process_info, shell_pid: '700' } } },
    { result: { process_info: { ...info().result.process_info, foreground_processes: [] } } },
    { result: { process_info: { ...info().result.process_info, foreground_processes: [{ pid: '701' }] } } }]) {
    const f = readerFixture(); f.info(JSON.stringify(raw)); assert.equal(await f.read(target), undefined); assert.equal(f.calls.length, 1);
  }
  const f = readerFixture(); f.info('not json'); assert.equal(await f.read(target), undefined); assert.equal(f.calls.length, 1);
});

test('checkpoint95 failures clear visible ages and blank results also respect the thirty second check interval', async () => {
  for (const binary of ['herdr-fixture', 'ps']) {
    const f = readerFixture(), first = await f.read(target);
    f.advance(30000); f.failures[binary] = new Error('PRIVATE-ERROR-BODY');
    assert.equal(await f.read(target), undefined); const count = f.calls.length;
    f.advance(29999); assert.equal(await f.read(target), undefined); assert.equal(f.calls.length, count);
    delete f.failures[binary]; f.advance(1); assert.deepEqual(await f.read(target), first, 'A known unchanged PID retains its original start after a transient failure');
  }
});

for (const phase of ['process-info', 'ps']) test(`checkpoint95 real execFile timeout in ${phase} leaves age blank`, async () => {
  const read = createAgeReader({ context: { binary: 'herdr-fixture', env: { ...process.env } }, timeoutMs: 25,
    execute(binary, args, options, callback) {
      if ((binary === 'ps') === (phase === 'ps')) return execFile(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], options, callback);
      queueMicrotask(() => callback(null, binary === 'ps' ? ps : JSON.stringify(info())));
    } });
  const start = Date.now(); assert.equal(await read(target), undefined); assert(Date.now() - start < 5000);
});

test('checkpoint95 checks once per thirty seconds, preserves the same PID start, and recomputes when the PID changes', async () => {
  const f = readerFixture(), first = await f.read(target);
  first.startedAt = 0;
  f.advance(29999); assert.equal((await f.read(target)).startedAt, f.now() - 29999 - 8099000); assert.equal(f.calls.length, 2);
  f.advance(1); f.ps(ps.replace('02:14:59', '02:15:28'));
  assert.equal((await f.read(target)).startedAt, f.now() - 30000 - 8099000); assert.equal(f.calls.length, 4);
  f.advance(30000); const raw = info(); raw.result.process_info.foreground_processes[1].pid = 703;
  f.info(JSON.stringify(raw)); f.ps(ps.replace('701 700 02:14:59', '703 700 00:06'));
  assert.deepEqual(await f.read(target), { pid: 703, startedAt: f.now() - 6000 }); assert.equal(f.calls.length, 6);
  f.read.retain([]); assert.deepEqual(await f.read(target), { pid: 703, startedAt: f.now() - 6000 }); assert.equal(f.calls.length, 8);
  assert.deepEqual(await f.read({ ...target, terminalId: 'new-terminal' }), { pid: 703, startedAt: f.now() - 6000 }); assert.equal(f.calls.length, 10);
});

test('checkpoint95 concurrent refreshes share one process-info/ps pair', async () => {
  const f = readerFixture(), results = await Promise.all([f.read(target), f.read(target), f.read(target)]);
  assert.equal(f.calls.length, 2); assert.deepEqual(results[0], results[1]); assert.notEqual(results[0], results[1]);
});

const agent = (overrides = {}) => ({ id: target.terminalId, ...target, provider: 'codex', name: 'review', agentName: 'review', status: 'working',
  workspace: { id: 'w9', name: 'shep', path: '/fixture/shep' }, ...overrides });
function monitorFixture(agents = [agent()]) {
  let snapshot = { mode: 'live', source: { state: 'connected' }, updatedAt: new Date().toISOString(), agents };
  const listeners = new Set();
  return { getSnapshot: () => structuredClone(snapshot), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    publish(patch) { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(structuredClone(snapshot)); } };
}

test('checkpoint95 ages cover external agents after restart and stay outside shared browser snapshots and targets', async t => {
  const monitor = monitorFixture([agent(), agent({ id: 'two', terminalId: 'two', paneId: 'w9:p3', provider: 'claude' })]);
  const before = monitor.getSnapshot(), calls = [];
  const model = createTuiModel({ monitor, controller: createFakeController(), registry: createFakeRegistry(),
    readAge: async request => { calls.push(request); return { pid: 701, startedAt: 1000, argv: ['PRIVATE-TASK'] }; } });
  t.after(() => model.destroy()); await model.ready;
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], target);
  assert.deepEqual(model.getSnapshot().ageInfoByAgent, { 'terminal-one': { pid: 701, startedAt: 1000 }, two: { pid: 701, startedAt: 1000 } });
  assert.deepEqual(model.getSnapshot().snapshot, before); assert.deepEqual(monitor.getSnapshot(), before); assert.deepEqual(model.selected(), before.agents[0]);
  assert.doesNotMatch(JSON.stringify(model.getSnapshot()), /PRIVATE-TASK|argv/);
  monitor.publish({ agents: [] }); await tick(); assert.deepEqual(model.getSnapshot().ageInfoByAgent, {});
});

test('checkpoint95 optional process metadata failures, initially disconnected/demo and absent terminal IDs leave blank cells', async () => {
  for (const patch of [{}, { mode: 'demo' }, { source: { state: 'disconnected' } }, { agents: [agent({ terminalId: null })] }]) {
    const monitor = monitorFixture(); monitor.publish(patch); let reads = 0;
    const model = createTuiModel({ monitor, controller: createFakeController(), registry: createFakeRegistry(),
      readAge: async () => { reads++; throw new Error('PRIVATE-PROCESS-FAILURE'); } });
    await model.ready; assert.deepEqual(model.getSnapshot().ageInfoByAgent, {}); assert.equal(reads, Object.keys(patch).length ? 0 : 1); model.destroy();
  }
});

test('checkpoint95 known ages survive STALE without reads and clear on changed identity or failed reconnection', async t => {
  for (const patch of [{ agents: [] }, { agents: [agent({ terminalId: 'replacement' })] }, { agents: [agent({ paneId: 'w9:p4' })] },
    { agents: [agent({ provider: 'grok' })] }, { mode: 'demo' }, { source: { state: 'connected' } }]) {
    const monitor = monitorFixture(); let reads = 0;
    const model = createTuiModel({ monitor, controller: createFakeController(), registry: createFakeRegistry(),
      readAge: async () => ++reads === 1 ? { pid: 701, startedAt: 1000 } : undefined });
    t.after(() => model.destroy()); await model.ready;
    const known = model.getSnapshot().ageInfoByAgent;
    monitor.publish({ source: { state: 'disconnected' } }); await tick();
    assert.deepEqual(model.getSnapshot().ageInfoByAgent, known);
    assert.equal(reads, 1, 'STALE snapshots must not start new process lookups');
    monitor.publish(patch); await tick();
    assert.deepEqual(model.getSnapshot().ageInfoByAgent, {}, JSON.stringify(patch));
    assert.equal(reads, patch.source ? 2 : 1); model.destroy();
  }
});

test('checkpoint95 late process metadata cannot cross changed terminal/pane/provider or disconnected data', async () => {
  for (const patch of [{ agents: [agent({ terminalId: 'replacement' })] }, { agents: [agent({ paneId: 'w9:p4' })] },
    { agents: [agent({ provider: 'grok' })] }, { source: { state: 'disconnected' } }]) {
    const monitor = monitorFixture(), gate = deferred(); let calls = 0;
    const model = createTuiModel({ monitor, controller: createFakeController(), registry: createFakeRegistry(), readAge: async () => ++calls === 1 ? gate.promise : undefined });
    monitor.publish(patch); gate.resolve({ pid: 701, startedAt: 1000 }); await model.ready; await tick();
    assert.deepEqual(model.getSnapshot().ageInfoByAgent, {}); model.destroy();
  }
});
