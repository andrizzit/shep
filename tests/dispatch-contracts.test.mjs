import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  DEFAULT_CONFIG, PROVIDERS, LIMITS, MESSAGES, NAMING_VECTORS, ALIAS_VECTORS, ALIAS_RULES, PATTERNS,
  FINAL_LAUNCH_STATES, LAUNCH_TRANSITIONS, CLI_EXIT_CODES, HISTORY_FIELDS,
  validatePrompt, validateArgs, validateProject, validateDispatchSpec,
  validateDispatchRequest, validateConfigShape, validateProgressEvent,
  validateOutcome, validateHistoryRecord, validateTrustRequired, assertContract,
} from '../src/dispatch/contracts.mjs';
import { parseDispatch } from '../src/tui-model.mjs';

// During isolated D0 drafting QA owns the fixture in a sibling worktree. The
// integrated branch and CI use the repository fixture without this override.
const vectors = JSON.parse(await readFile(process.env.SHEP_CONTRACT_FIXTURE
  ?? new URL('./fixtures/dispatch-grammar.json', import.meta.url), 'utf8'));
const project = vectors.context.projects[0];
const at = '2026-09-27T12:00:00.000Z';
const placement = { projectKey: project.key, root: project.root, mode: 'auto', subfolder: '', label: 'Fixture task', placementStyle: 'tab' };
const request = { taskId: 'task-1', attemptId: 'attempt-1', provider: 'codex', prompt: 'Fixture task', inputTask: 'Fixture task', name: 'fixture-task-codex', args: [], placement };
const result = { ok: true, state: 'submitted', message: 'Fixture submitted.', taskId: 'task-1', attemptId: 'attempt-1', paneId: 'w2:p1', terminalId: 'terminal-2',
  placement: { mode: 'here', targetKind: 'workspace', reason: 'No project workspace open', cwd: project.root, workspaceId: 'w2', notices: [] },
  created: { workspaceId: 'w2', tabId: 'w2:t1', tabIds: ['w2:t1'], panes: [{ paneId: 'w2:p1', terminalId: 'terminal-2', tabId: 'w2:t1', workspaceId: 'w2' }] } };
const history = { v: 1, id: 'task-1', at, command: '/test codex: ABC', agents: ['codex'], profile: null,
  project: { name: project.name, root: project.root }, subfolder: '', mode: 'here', modeIntent: 'auto', template: 'test', task: 'ABC', state: 'submitted' };

test('D0 schema: every grammar vector has a valid input and declared result shape', async t => {
  assert.equal(vectors.version, 1);
  assert.ok(vectors.cases.length >= 21);
  assert.equal(new Set(vectors.cases.map(item => item.id)).size, vectors.cases.length);
  for (const vector of vectors.cases) await t.test(vector.id, () => {
    assert.equal(typeof vector.input, 'string');
    const context = { ...vectors.context, ...vector.context };
    for (const entry of context.projects) assert.deepEqual(validateProject(entry), []);
    for (const candidate of context.trustRequired ?? []) assert.deepEqual(validateTrustRequired(candidate), []);
    const expected = vector.expected;
    if (Object.hasOwn(expected, 'error')) {
      assert.equal(typeof expected.error, 'string');
      assert.ok(expected.error.length > 0);
      if (expected.trust) {
        assert.equal(expected.code, 'needs_confirmation');
        assert.deepEqual(validateTrustRequired(expected.trust), []);
      }
      return;
    }
    const mode = expected.agents.length > 1 || expected.modeIntent === 'wt' ? 'worktree' : expected.modeIntent;
    assert.equal(expected.mode, mode, 'fixture mode must match normalized intent and fan-out');
    const spec = { ...expected, kind: 'dispatch', project: context.projects.find(entry => entry.key === expected.projectKey) };
    assert.deepEqual(validateDispatchSpec(spec), []);
    assert.equal(expected.command, vector.input);
    if (expected.template === null) assert.equal(expected.task, expected.inputTask);
  });
});

test('D0 compatibility: existing parser still preserves the frozen legacy literals', () => {
  const legacy = new Set(['default', 'legacy-provider', 'case-and-no-space', 'literal-colons', 'provider-word-is-task', 'retained-leading-space', 'tabs', 'literal-shell-text']);
  for (const id of legacy) assert.ok(vectors.cases.some(vector => vector.id === id), `Missing legacy vector: ${id}`);
  for (const vector of vectors.cases.filter(item => legacy.has(item.id))) {
    const parsed = parseDispatch(vector.input, vectors.context.providers);
    const expected = vector.id === 'provider-word-is-task'
      ? { provider: 'codex', prompt: 'claude review this code' }
      : { provider: vector.expected.agents[0].provider, prompt: vector.expected.task };
    assert.equal(parsed.provider, expected.provider, vector.id);
    assert.equal(parsed.prompt, expected.prompt, vector.id);
  }
});

test('D0 schema: naming vectors meet native limits without claiming naming implementation', () => {
  assert.equal(PROVIDERS.length, 24);
  for (const vector of NAMING_VECTORS) {
    assert.match(vector.agent, PATTERNS.agentName);
    assert.equal(vector.agent, `${vector.slug}-claude`);
    assert.equal(vector.branch, `shep/${vector.slug}-${vector.suffix}`);
    assert.match(vector.suffix, /^[a-f0-9]{4}$/);
  }
  assert.equal(PATTERNS.branchPrefix.test(`${'a'.repeat(31)}/`), true);
  assert.equal(PATTERNS.branchPrefix.test(`${'a'.repeat(32)}/`), false);
});

test('D0 schema: aliases preserve parent chains and canonical-key hash fallback', () => {
  assert.equal(ALIAS_RULES.maxCharacters, 64);
  for (const vector of ALIAS_VECTORS) {
    if (vector.alias) assert.match(vector.alias, PATTERNS.project);
    if (vector.hash) assert.equal(createHash('sha256').update(vector.key).digest('hex').slice(0, ALIAS_RULES.initialHashCharacters), vector.hash);
  }
});

test('D0 registry record excludes the main checkout from linked worktrees', () => {
  assert.ok(validateProject({ ...project, worktrees: [{ path: project.root, branch: 'main', workspaceId: 'w1' }] }).length);
  assert.deepEqual(validateProject({ ...project, worktrees: [{ path: '/fixture/linked-checkout', branch: 'shep/task-abcd', workspaceId: 'w2' }] }), []);
});

test('D0 trust candidates preserve session folder intent without claiming Git identity', () => {
  const candidate = { kind: 'trust_required', root: '/fixture/repo', name: 'repo', aliases: [], source: 'session', path: '/fixture/repo/src', message: 'Confirm this repository.' };
  assert.deepEqual(validateTrustRequired(candidate), []);
  assert.ok(validateTrustRequired({ ...candidate, key: 'git:/fixture/repo/.git' }).length);
  assert.ok(validateTrustRequired({ ...candidate, source: 'untrusted-prompt' }).length);
});

test('D0 parse contract refuses fan-out and explicit-wt mode contradictions', () => {
  for (const id of ['fanout', 'forced-worktree']) {
    const vector = vectors.cases.find(entry => entry.id === id);
    const spec = { ...vector.expected, kind: 'dispatch', project };
    assert.deepEqual(validateDispatchSpec(spec), []);
    for (const mode of ['auto', 'here']) assert.ok(validateDispatchSpec({ ...spec, mode }).some(entry => entry.path === 'mode'));
  }
});

test('D0 validation: prompt and native arguments have distinct literal byte/control rules', () => {
  assert.deepEqual(validatePrompt('Line one\n\t`literal` $(not-a-command)'), []);
  assert.deepEqual(validatePrompt('😀'.repeat(LIMITS.promptBytes / 4)), []);
  assert.equal(validatePrompt('😀'.repeat(LIMITS.promptBytes / 4 + 1))[0].code, 'invalid_prompt');
  for (const value of ['', ' ', 'a\0b', 'a\rb', 'a\x1bb']) assert.ok(validatePrompt(value).length);
  assert.deepEqual(validateArgs(['--model', 'value with spaces', '$(literal)']), []);
  for (const value of [['a\nb'], ['x'.repeat(513)], new Array(33).fill('x'), 'not-an-array']) assert.ok(validateArgs(value).length);
});

test('D0 validation: modern placement intent requires attempt IDs and legacy split stays valid', () => {
  assert.deepEqual(validateDispatchRequest(request), []);
  assert.deepEqual(validateDispatchRequest({ provider: 'codex', prompt: 'Legacy task', cwd: '/fixture' }), []);
  for (const key of ['taskId', 'attemptId']) {
    const invalid = structuredClone(request); delete invalid[key];
    assert.ok(validateDispatchRequest(invalid).some(item => item.path === key));
  }
  assert.ok(validateDispatchRequest({ ...request, placement: { ...placement, subfolder: '../escape' } }).length);
  assert.deepEqual(validateDispatchRequest({ ...request, placement: { ...placement, subfolder: 'src/api', mode: 'wt' } }), []);
});

test('Contract change 001: original naming input is required only for modern requests', () => {
  const modern = { ...request, inputTask: 'Please\nimplement foo', prompt: 'Template: Please\nimplement foo', name: 'custom-name' };
  assert.deepEqual(validateDispatchRequest(modern), []);
  assert.equal(modern.prompt, 'Template: Please\nimplement foo');
  for (const inputTask of [undefined, '', ' ', 'bad\x1btext', '🙂'.repeat(16385)]) {
    assert.ok(validateDispatchRequest({ ...modern, inputTask }).some(issue => issue.path === 'inputTask'));
  }
  assert.deepEqual(validateDispatchRequest({ provider: 'codex', prompt: 'Literal legacy task', cwd: '/fixture' }), []);
  assert.deepEqual(validateDispatchRequest({ provider: 'codex', prompt: 'Literal legacy task', cwd: '/fixture', inputTask: '\x1b' }), []);
});

test('D0 config schema: defaults, nested errors and warning-only unknown keys', () => {
  assert.deepEqual(validateConfigShape(DEFAULT_CONFIG), { errors: [], warnings: [] });
  assert.deepEqual(DEFAULT_CONFIG.projects, { roots: [], entries: [] });
  assert.throws(() => { DEFAULT_CONFIG.history.enabled = false; }, TypeError);
  assert.equal(validateConfigShape({ extra: true }).errors.length, 0);
  assert.equal(validateConfigShape({ extra: true }).warnings[0].path, 'extra');
  assert.deepEqual(validateConfigShape({ projects: { roots: ['~/work'] } }, { homeDir: '/fixture/home' }), { errors: [], warnings: [] });
  const bad = validateConfigShape({ concurrency: { maxLaunches: 5 }, history: { limit: 0 }, agents: { claude: { profiles: { fast: { args: ['bad\narg'] } } } } });
  assert.deepEqual(bad.errors.map(item => item.path), ['concurrency.maxLaunches', 'history.limit', 'agents.claude.profiles.fast.args.0']);
  assert.ok(validateConfigShape({ templates: { memory: '{task}' } }).errors.length);
  assert.deepEqual(validateConfigShape({ templates: { test: '' } }), { errors: [], warnings: [] });
});

test('D0 progress: only target events carry the pre-mutation root-only notice', () => {
  const event = { taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at,
    placement: { mode: 'worktree', reason: 'Checkout busy' },
    message: MESSAGES.worktreeSubfolder.replace('{subfolder}', 'src/api'), noticeRequired: true };
  assert.deepEqual(validateProgressEvent(event), []);
  assert.equal(event.message, "Worktree starts at the repository root; subfolder src/api isn't applied");
  assert.ok(validateProgressEvent({ ...event, stage: 'prompt' }).length);
  assert.ok(validateProgressEvent({ ...event, attemptId: '' }).length);
});

test('D0 required notice acknowledgement is explicit, bounded and target-worktree only', () => {
  const event = { taskId: request.taskId, attemptId: request.attemptId, stage: 'target', at,
    placement: { mode: 'worktree', reason: 'Checkout busy' }, message: 'Root-only worktree notice.', noticeRequired: true };
  assert.equal(LIMITS.prelaunchNoticeTimeoutMs, 1500);
  assert.deepEqual(validateProgressEvent(event), []);
  for (const patch of [{ noticeRequired: false }, { noticeRequired: 'true' }, { stage: 'start' },
    { message: undefined }, { message: '   ' }, { placement: { mode: 'here', reason: 'Main checkout' } }]) {
    assert.ok(validateProgressEvent({ ...event, ...patch }).some(item => item.path === 'noticeRequired'));
  }
  assert.deepEqual(validateProgressEvent({ taskId: request.taskId, attemptId: request.attemptId, stage: 'start', at }), []);
  const refused = { ok: false, state: 'failed', taskId: request.taskId, attemptId: request.attemptId,
    stage: 'target', code: 'prelaunch_notice_failed', message: MESSAGES.prelaunchNoticeFailed };
  assert.deepEqual(validateOutcome(refused), []);
  assert.equal(Object.hasOwn(refused, 'created'), false);
});

test('D0 outcome receipts reject cross-workspace and cross-terminal claims', () => {
  assert.deepEqual(validateOutcome(result), []);
  assert.ok(validateOutcome({ ...result, terminalId: 'replaced-terminal' }).length);
  const crossed = structuredClone(result); crossed.created.panes[0].workspaceId = 'w9';
  assert.ok(validateOutcome(crossed).length);
  assert.ok(validateOutcome({ ...result, placement: { ...result.placement, cwd: null } }).length);
  assert.deepEqual(validateOutcome({ ok: false, state: 'uncertain', message: 'Inspect creation', taskId: 'task-1', attemptId: 'attempt-1', stage: 'target' }), []);
});

test('D0 lifecycle: trust is provisional, certainty and private history remain separate', () => {
  assert.deepEqual(LAUNCH_TRANSITIONS.needs_confirmation, ['starting', 'failed']);
  assert.equal(FINAL_LAUNCH_STATES.includes('needs_confirmation'), false);
  assert.deepEqual(LAUNCH_TRANSITIONS.uncertain, []);
  assert.equal(CLI_EXIT_CODES.uncertain, 4);
  assert.deepEqual(Object.keys(history).sort(), [...HISTORY_FIELDS].sort());
  assert.deepEqual(validateHistoryRecord(history), []);
  assert.deepEqual(validateHistoryRecord({ ...history, state: 'failed', mode: null }), []);
  for (const record of [{ ...history, prompt: 'expanded' }, { ...history, args: ['private'] }, { ...history, state: 'needs_confirmation' }, { ...history, agents: ['claude', 'codex'] }]) assert.ok(validateHistoryRecord(record).length);
  assert.throws(() => assertContract(validateHistoryRecord({ ...history, args: ['private'] })), /privacy contract/);
});
