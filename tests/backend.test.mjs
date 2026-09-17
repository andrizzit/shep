import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHerdrSnapshot, readDemoSnapshot, normalizeSnapshot, HerdrReadError } from '../src/herdr.mjs';

const FIXTURE = new URL('./fixtures/demo-snapshot.json', import.meta.url);

async function fakeCli(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shep-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'fake-herdr');
  await writeFile(binary, await readFile(new URL('./fixtures/fake-herdr.cjs', import.meta.url)), { mode: 0o700 });
  return binary;
}

test('normalizes every provider, preserves shared workspaces, and uses path precedence', async () => {
  const raw = JSON.parse(await readFile(FIXTURE, 'utf8'));
  raw.result.snapshot.agents[0].foreground_cwd = '/foreground';
  const result = normalizeSnapshot(raw, '2026-09-16T12:00:00.000Z');
  assert.equal(result.version, '0.9.1');
  assert.equal(result.agents.length, 7);
  assert.equal(result.agents[0].workspace.path, '/foreground');
  assert.equal(result.agents[0].workspace.id, result.agents[1].workspace.id);
  assert.notEqual(result.agents[0].id, result.agents[1].id);
  assert.equal(result.agents[4].workspace.path, '/projects/shep');
  assert.equal(result.agents[5].workspace.path, null);
  assert.equal(result.agents[6].provider, 'gemini');
  assert.equal(result.agents[0].lastSeenAt, '2026-09-16T12:00:00.000Z');
});

test('normalization sanitizes terminal controls, handles aliases, and maps unknown status', () => {
  const result = normalizeSnapshot({ result: { snapshot: { agents: [{
    agent: 'CUSTOM', agent_status: 'new-host-state', agent_name: 'Alias',
    name: '\u001b[31mNamed\u001b[0m\u0007\nagent', pane_id: 'w1:p1',
  }], workspaces: [] } } });
  const agent = result.agents[0];
  assert.equal(agent.name, 'Namedagent');
  assert.equal(agent.status, 'unknown');
  assert.equal(agent.id, 'w1:p1');
  assert.equal(agent.provider, 'custom');
  assert.equal(agent.workspace.name, 'Workspace unavailable');
});

test('explicit demo reader returns sample agents through the same normalizer', async () => {
  const result = await readDemoSnapshot();
  assert.equal(result.agents.length, 7);
  assert.equal(result.agents[0].id, 'demo-claude-1');
});

test('external CLI path uses literal argv and inherits socket context', async (t) => {
  const binary = await fakeCli(t);
  const session = 'team; $(this-is-not-a-shell)';
  const result = await readHerdrSnapshot({ binary, session, env: { HERDR_SOCKET_PATH: '/fixture/herdr.sock', SHEP_TEST_MODE: '' } });
  assert.deepEqual(JSON.parse(result.agents[0].name), ['--session', session, 'api', 'snapshot']);
  assert.equal(result.agents[0].workspace.path, '/fixture/herdr.sock');
  const configured = await readHerdrSnapshot({ env: { HERDR_BIN_PATH: binary, SHEP_SESSION: 'named', SHEP_TEST_MODE: '' } });
  assert.deepEqual(JSON.parse(configured.agents[0].name), ['--session', 'named', 'api', 'snapshot']);
});

test('missing executable produces actionable diagnostics', async () => {
  await assert.rejects(readHerdrSnapshot({ binary: '/shep-does-not-exist/herdr' }), (error) => error instanceof HerdrReadError && error.code === 'not_found');
});

test('CLI failures and invalid output do not reveal raw command output', async (t) => {
  const binary = await fakeCli(t);
  for (const mode of ['failure', 'malformed', 'wrong-shape']) {
    await assert.rejects(readHerdrSnapshot({ binary, env: { SHEP_TEST_MODE: mode } }), (error) => {
      assert(error instanceof HerdrReadError);
      assert(!error.message.includes('PRIVATE_OUTPUT'));
      return true;
    });
  }
});

test('CLI timeout is bounded even when SIGTERM would be ignored', { timeout: 3000 }, async (t) => {
  const binary = await fakeCli(t);
  const started = performance.now();
  await assert.rejects(readHerdrSnapshot({ binary, timeoutMs: 100, env: { SHEP_TEST_MODE: 'hang' } }), (error) => error.code === 'timeout');
  assert(performance.now() - started < 2000);
});

test('CLI output limit rejects oversized responses', async (t) => {
  const binary = await fakeCli(t);
  await assert.rejects(readHerdrSnapshot({ binary, maxBuffer: 1024, env: { SHEP_TEST_MODE: 'overflow' } }), (error) => error.code === 'too_large');
});
