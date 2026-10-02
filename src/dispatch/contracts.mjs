// Smart dispatcher v1 contracts. Freeze approval and evidence are recorded in docs/internal/STATUS.md.
// Interfaces and validation only; no dispatcher implementation is supplied here.
import { isAbsolute } from 'node:path';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const CONTRACT_REVISION = '2';
export const SPIKE_FACTS = freeze({
  herdrVersion: '0.9.1', protocol: 22, schemaVersion: 1,
  evidence: { live: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'], ownerConfirmed: ['S8'], documentedOnly: ['S9'] },
  serverAutoStarts: false,
  untrustedRepositoryCode: 'worktree_create_failed',
  ownershipMessagePrefix: "fatal: detected dubious ownership in repository at '",
  trustQualification: 'Live Herdr/Git under synthetic dubious ownership; exact canonical root and anchored native message required.',
  trustRefusalMayCreateEmptyScaffolding: true,
  reconciledSingleTrustRetrySucceeded: true,
  scopedGitSafeDirectorySucceeded: true,
  branchExistsCode: null,
  branchCollision: 'Existing used path fails with worktree_create_failed; unused branch plus fresh path succeeds unchanged. Preflight branch names.',
  dirtyWorktreeCode: 'dirty_worktree_requires_force',
  newRootPaneReady: true, readinessProvider: 'codex',
  worktreeLaunchCwd: 'repository root, including when requested subfolder exists',
  implicitPrimaryWorkspace: 'May be created but is not cleanup-owned merely because it appeared.',
  removalKeepsBranch: true, removalClosesWorkspace: true,
  nativeArgsPreserved: true, nativeArgsProvider: 'codex',
  concurrentTabsDistinct: true, concurrentWorktreesDistinct: true,
  paneCloseResultType: 'ok',
  blockedPromptCode: 'agent_blocked', blockedPromptLiveVerified: false,
});

export const PROVIDERS = freeze([
  { id: 'claude', name: 'Claude', executable: 'claude' },
  { id: 'codex', name: 'Codex', executable: 'codex' },
  { id: 'grok', name: 'Grok', executable: 'grok' },
  { id: 'kiro', name: 'Kiro', executable: 'kiro-cli' },
  { id: 'gemini', name: 'Gemini', executable: 'gemini' },
  { id: 'cursor', name: 'Cursor', executable: 'cursor-agent' },
  { id: 'pi', name: 'Pi', executable: 'pi' },
  { id: 'devin', name: 'Devin', executable: 'devin' },
  { id: 'agy', name: 'Antigravity', executable: 'agy' },
  { id: 'cline', name: 'Cline', executable: 'cline' },
  { id: 'omp', name: 'OMP', executable: 'omp' },
  { id: 'mastracode', name: 'MastraCode', executable: 'mastracode' },
  { id: 'opencode', name: 'OpenCode', executable: 'opencode' },
  { id: 'copilot', name: 'Copilot', executable: 'copilot' },
  { id: 'kimi', name: 'Kimi', executable: 'kimi' },
  { id: 'droid', name: 'Droid', executable: 'droid' },
  { id: 'amp', name: 'Amp', executable: 'amp' },
  { id: 'hermes', name: 'Hermes', executable: 'hermes' },
  { id: 'kilo', name: 'Kilo', executable: 'kilo' },
  { id: 'qodercli', name: 'Qoder', executable: 'qodercli' },
  { id: 'qwen', name: 'Qwen', executable: 'qwen' },
  { id: 'letta', name: 'Letta', executable: 'letta' },
  { id: 'maki', name: 'Maki', executable: 'maki' },
  { id: 'muse', name: 'Muse', executable: 'muse' },
]);
export const PROVIDER_IDS = freeze(PROVIDERS.map(({ id }) => id));
export const DEFAULT_PROVIDER = 'codex';
export const LIMITS = freeze({
  promptBytes: 65536, templateBytes: 4096, nativeArgs: 32, nativeArgBytes: 512,
  agentsPerDispatch: 4, maxLaunches: 4, rootEntries: 500, recentProjects: 200,
  projectNameCharacters: 64, profileNameCharacters: 16, agentNameCharacters: 32,
  slugCharacters: 24, tabLabelCharacters: 40, branchPrefixCharacters: 32,
  branchSuffixAttempts: 5, suggestions: 5, projectSuggestions: 3,
  projectSuggestionDistance: 2, registryFreshMs: 30000, duplicateWindowMs: 600000,
  notificationDedupeMs: 30000, summaryThrottleMs: 10000, gitConcurrency: 4,
  registryGitTimeoutMs: 1000, summaryGitTimeoutMs: 2000,
  followUpTimeoutMs: 8000, startTimeoutMs: 30000, startTransportTimeoutMs: 35000,
  prelaunchNoticeTimeoutMs: 1500, gitStatusBytes: 1048576,
});
export const PATTERNS = freeze({
  project: /^[A-Za-z0-9._-]{1,64}$/,
  profile: /^[a-z][a-z0-9-]{0,15}$/,
  agentName: /^[a-z][a-z0-9_-]{0,31}$/,
  branchPrefix: /^(?=.{1,32}$)[A-Za-z0-9._/-]*\/$/,
});
export const SCRUBBED_GIT_ENV = freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES',
]);
export const BUILTIN_TEMPLATES = freeze({
  test: "Add unit tests for {task}. Follow this repository's existing test framework and conventions, run the relevant tests, and report what you added and the results.",
  fix: 'Fix {task}. Find the root cause, make the smallest correct change, add or update a test that covers it, run the relevant tests, and summarize the change.',
  review: 'Review {task}. Report concrete bugs and risks with file and line references. Do not change any files.',
});
export const RESERVED_TEMPLATES = freeze(['dispatch', 'remember', 'memory']);
export const DEFAULT_CONFIG = freeze({
  placement: 'tab',
  projects: { roots: [], entries: [] },
  worktrees: { branchPrefix: 'shep/', trustedRepos: [] },
  agents: {}, templates: { ...BUILTIN_TEMPLATES },
  notifications: { enabled: true, sound: true, onlyWhenUnfocused: true, external: false },
  history: { enabled: true, limit: 500 }, concurrency: { maxLaunches: 3 },
});
export const PROJECT_SOURCES = freeze(['config', 'session', 'herdr', 'roots', 'history']);
export const MODE_INTENTS = freeze(['auto', 'here', 'wt']);
export const RESOLVED_MODES = freeze(['here', 'worktree']);
export const PLACEMENT_STYLES = freeze(['tab', 'split']);
export const TARGET_KINDS = freeze(['split', 'tab', 'workspace', 'worktree']);
export const LAUNCH_STATES = freeze([
  'queued', 'starting', 'submitted', 'needs_input', 'needs_confirmation', 'uncertain', 'failed',
]);
export const LAUNCH_OUTCOMES = freeze(['submitted', 'needs_input', 'needs_confirmation', 'uncertain', 'failed']);
export const DELIVERY_POLICIES = freeze(['auto', 'type']);
export const DELIVERY_MODES = freeze(['launch', 'type']);
export const FINAL_LAUNCH_STATES = freeze(['submitted', 'needs_input', 'uncertain', 'failed']);
export const LIVE_STATES = freeze(['working', 'blocked', 'done', 'idle', 'unknown', 'closed']);
export const PROGRESS_STAGES = freeze(['queued', 'target', 'start', 'prompt']);
export const OUTCOME_STAGES = freeze(['target', 'start', 'prompt']);
export const LAUNCH_TRANSITIONS = freeze({
  queued: ['starting', 'failed'],
  starting: ['submitted', 'needs_input', 'needs_confirmation', 'uncertain', 'failed'],
  needs_confirmation: ['starting', 'failed'],
  submitted: [], needs_input: [], uncertain: [], failed: [],
});
export const BOARD_STATE_ORDER = freeze([
  'blocked', 'needs_input', 'needs_confirmation', 'working', 'starting', 'queued',
  'uncertain', 'done', 'idle', 'unknown', 'failed', 'closed',
]);
export const DUPLICATE_GUARD_STATES = freeze(['starting', 'queued', 'uncertain', 'needs_input']);
export const COMPOSE_FIELDS = freeze([
  'agents', 'profile', 'project', 'subfolder', 'mode', 'template', 'name', 'task', 'dispatch',
]);
export const DIALOG_KINDS = freeze(['close', 'trust', 'profile', 'duplicate', 'remove-worktree', 'force-remove-worktree']);
export const CLI_EXIT_CODES = freeze({ submitted: 0, failed: 1, usage: 2, needs_input: 3, needs_confirmation: 3, uncertain: 4 });
export const HISTORY_FIELDS = freeze([
  'v', 'id', 'at', 'command', 'agents', 'profile', 'project', 'subfolder',
  'mode', 'modeIntent', 'template', 'task', 'state',
]);
export const PRIVACY = freeze({
  publicMetadata: ['agent names', 'workspace labels', 'paths'],
  neverPublic: ['prompts', 'tasks', 'expanded templates', 'history', 'profile arguments', 'config'],
  historyFileMode: 0o600, historyDirectoryMode: 0o700,
  configWrites: ['worktrees.trustedRepos'],
  historyExpandedPrompt: false, historyFollowUpText: false,
  coordinationScope: 'one Shep process',
});
export const ALIAS_RULES = freeze({ namePrefixCharacters: 32, initialHashCharacters: 8, hashStepCharacters: 4, maxCharacters: 64 });
export const ALIAS_VECTORS = freeze([
  { name: 'app', root: '/work/app', alias: 'app.work', stage: 'parent' },
  { name: 'app', root: '/oss/app', alias: 'app.oss', stage: 'parent' },
  { name: 'app', root: '/work/client/app', alias: 'app.work-client', stage: 'grandparent' },
  { key: 'git:/fixture/one/app/.git', hash: '8fb994fb', stage: 'hash' },
  { key: 'git:/fixture/two/app/.git', hash: '1b4febe0', stage: 'hash' },
]);
export const NAMING_VECTORS = freeze([
  { task: 'add unit test for ABC', slug: 'add-unit-test-abc', agent: 'add-unit-test-abc-claude', suffix: '7f3a', branch: 'shep/add-unit-test-abc-7f3a' },
  { task: 'Fix the title bug in the header, please', slug: 'fix-title-bug-header', agent: 'fix-title-bug-header-claude', suffix: '09c1', branch: 'shep/fix-title-bug-header-09c1' },
  { task: '2FA login flow', slug: 't-2fa-login-flow', agent: 't-2fa-login-flow-claude', suffix: 'b77e', branch: 'shep/t-2fa-login-flow-b77e' },
  { task: '¿Qué pasa con el build?', slug: 'que-pasa-con-el-build', agent: 'que-pasa-con-el-build-claude', suffix: 'abcd', branch: 'shep/que-pasa-con-el-build-abcd' },
  { task: '!!!', slug: 'task', agent: 'task-claude', suffix: '3d20', branch: 'shep/task-3d20' },
]);

export const MESSAGES = freeze({
  emptyTask: 'Add a task after /dispatch and the optional agent: prefix.',
  unknownCommand: 'Use /dispatch [agent:] your task. Example: /dispatch claude: review this project or a template: /test, /fix, /review',
  tooManyAgents: 'Dispatch to at most 4 agents at once.',
  unknownMode: 'Unknown mode “+{mode}”. Use +wt or +here.',
  unknownAgent: 'Unknown agent “{agent}”. Choose a configured provider such as codex: or claude:.',
  unknownProject: 'Unknown project “{project}”.',
  unknownProjectSuggestion: 'Unknown project “{project}”. Did you mean {suggestions}?',
  ambiguousProject: '“{project}” matches {count} projects: {matches}. Use Tab to pick one.',
  unknownProfile: '{agent} has no profile “{profile}”. Configured: {profiles}.',
  duplicateAgent: '{agent} is listed twice.',
  worktreeNeedsGit: '+wt needs a Git project; {project} is a plain folder.',
  parallelNeedsGit: 'Parallel agents need a Git project',
  needsTrust: 'Herdr needs you to confirm you trust {root} before creating worktrees.',
  trustConfirmation: 'Trust this repository for worktrees? y/N',
  duplicateConfirmation: 'Dispatch this again? y/N',
  blockedFollowUp: 'The agent is waiting for input in its pane. Answer it there.',
  worktreeWorking: 'Wait for the agent to finish or close it first',
  worktreeSubfolder: "Worktree starts at the repository root; subfolder {subfolder} isn't applied",
  prelaunchNoticeFailed: 'The worktree location notice could not be displayed. No launch was started.',
  invalidPrompt: 'Enter a nonempty prompt no larger than 64 KiB. Newlines and tabs are allowed; terminal control characters are not.',
  config: 'Config {path}: {key}: {problem}',
});
export const VALIDATION_PROBLEMS = freeze({
  object: 'must be an object', string: 'must be a string', boolean: 'must be a boolean',
  array: 'must be an array', unknown: 'unknown key', absolutePath: 'must be an absolute path after ~ expansion',
  placement: 'must be tab or split', isolation: 'must be auto, always or never',
  projectName: 'must contain 1–64 letters, digits, dots, underscores or hyphens',
  profileName: 'must start with a lowercase letter and contain at most 16 lowercase letters, digits or hyphens',
  branchPrefix: 'must contain 1–32 letters, digits, dots, underscores, slashes or hyphens and end with /',
  maxLaunches: 'must be an integer between 1 and 4', historyLimit: 'must be a positive integer',
  provider: 'must be a supported Herdr agent kind', argsCount: 'must contain at most 32 arguments',
  argument: 'must be a string of at most 512 UTF-8 bytes without control characters',
  templateName: 'must be an unreserved template name', template: 'must contain {task} and be at most 4096 UTF-8 bytes, or be empty to disable it',
});

/** @typedef {{path:string, code:string, message:string}} ValidationIssue */
/** @typedef {{errors:ValidationIssue[], warnings:ValidationIssue[]}} ValidationResult */
/** @typedef {{provider:string, profile:string|null}} AgentSpec */
/**
 * @typedef {object} Project
 * @property {string} key git:<canonical-common-dir> or dir:<canonical-root>
 * @property {string} name
 * @property {string[]} aliases Configured aliases precede generated aliases.
 * @property {'git'|'folder'} kind
 * @property {string} root Main checkout from first git worktree list entry; never dirname(commonDir).
 * @property {string|null} commonDir
 * @property {'auto'|'always'|'never'} isolation
 * @property {string[]} workspaceIds
 * @property {('config'|'session'|'herdr'|'roots'|'history')[]} sources
 * @property {{path:string,branch:string|null,workspaceId:string|null}[]} worktrees Linked checkouts only; never includes project.root.
 */
/**
 * @typedef {object} DispatchSpec
 * @property {'dispatch'} kind
 * @property {AgentSpec[]} agents
 * @property {Project} project
 * @property {'auto'|'here'|'worktree'} mode Normalized syntax: fan-out forces worktree.
 * @property {'auto'|'here'|'wt'} modeIntent Fan-out keeps the parsed intent; placement forces worktrees.
 * @property {string} subfolder Relative path retained from context, '' for root.
 * @property {string|null} template
 * @property {string} task Final expanded prompt, preserving the literal remainder.
 * @property {string} inputTask Original, unexpanded task text.
 * @property {string} command Original command for recall, not replay authority.
 */
/** @typedef {{kind:'trust_required',root:string,name:string,aliases:string[],source:'config'|'session'|'herdr'|'roots'|'history',path:string,message:string}} TrustRequired Canonical verified root, no project key until Git identity resolves. */
/** @typedef {{error:string, code?:string, trust?:TrustRequired}} ParseError */
/**
 * @typedef {object} GrammarContext
 * @property {{id:string,name:string,available:boolean}[]} providers
 * @property {Project[]} projects
 * @property {TrustRequired[]} trustRequired Registry candidates blocked by exact qualified ownership refusal.
 * @property {string|null} contextProjectKey
 * @property {string} contextSubfolder
 * @property {object} config Effective validated config.
 */
/** @typedef {{label:string,value:string,replaceStart:number,replaceEnd:number,projectKey?:string}} Suggestion UTF-16 offsets, never grapheme offsets. */
/**
 * CORE module interfaces (D1/D9 implement these; this file declares only contracts):
 * grammar: parseCommand(line, ctx) -> DispatchSpec|ParseError;
 *   suggest(line, cursor, ctx) -> Suggestion[]; format(spec) -> string.
 * naming: slug(task); agentName(task, provider, {takenNames,randomHex});
 *   tabLabel(task); branchName(task, {branchPrefix,randomHex}).
 * templates: validateTemplates(overrides) -> ValidationResult;
 *   expandTemplate(name, inputTask, templates) -> string|ParseError.
 * config: configPath({env,homeDir}); validateConfig(value,{homeDir}) ->
 *   {config,errors,warnings}; loadConfig({path,fs,homeDir}) -> Promise<{path,config,errors,warnings}>;
 *   addTrustedRepo(root,{path,fs,homeDir}) -> Promise<{path,config,errors,warnings}>.
 * registry: createProjectRegistry({config,getConfig,snapshot,history,git,fs,now,homeDir}) ->
 *   {refresh,getSnapshot,resolve,containing,search,registerEphemeral};
 *   refresh({force=false}) -> Promise<{projects,trustRequired,updatedAt,warnings}>;
 *   getSnapshot() -> {projects,trustRequired,updatedAt,warnings};
 *   resolve(name) -> Project|TrustRequired|ParseError;
 *   containing(canonicalDirectory) -> Project|TrustRequired|null;
 *   search(query) -> (Project|TrustRequired)[].
 *   registerEphemeral(path) -> Promise<{project:Project,subfolder:string}|ParseError>:
 *   expand ~, validate an existing absolute folder, canonicalize/discover through the
 *   same bounded Git adapter, retain the Git-relative subfolder, and add a session-only
 *   explicit entry. Reuse configured projects first. The overlay survives refresh but
 *   never writes config/history by itself and disappears on exit. Sources are ordered
 *   config > session > herdr > roots > history. History never introduces plain folders.
 * getConfig() defaults to () => config; refresh/registerEphemeral use fresh validated
 * config, including just-approved trust. Ownership refusal retains submitted path and
 * exact verified root in its candidate, so consent refresh retries only that same path.
 * Ambiguity includes both resolved projects and trust candidates. Grammar returns
 * {error,code:'needs_confirmation',trust:candidate} for a selected trust candidate;
 * consent and refreshed Git identity precede ANY taskId/attemptId. Preserve draft
 * subfolder through the refresh; if the canonical root changes, stop and reselect.
 * Unknown Git errors stay actionable failures, never a silent plain-folder fallback.
 * Generated alias order: <name>.<parent>, then <name>.<grandparent>-<parent>,
 * expanding toward root; sanitize parent components to lowercase [a-z0-9-].
 * Keep aliases <=64 characters and reserve configured names/aliases first.
 * Exhausted parent chains use bounded name.parent-<sha256(canonicalKey)[0:8]>;
 * extend the hash by four characters on collision, trimming name/parent to fit.
 * Reserve hash+hyphen first, preserve name prefix up to32, then the rightmost
 * parent-chain characters that fit. Strip separator fragments at boundaries.
 * At 64 hash characters use hash only; if still occupied, return a collision error.
 * Never override configured aliases; matching is case-insensitive.
 * tasks: createTask(spec,{id,attemptId,groupId,at,name,args,placement}) -> Task;
 *   transition(task,event) -> Task (throws on invalid transition);
 *   displayState(task,agents); groupTasks(tasks,agents,projects,{query,filter,now}).
 * history: createHistory({config,fs,env,platform,homeDir,now}) ->
 *   {load,append,getRecords,commands}; load() -> Promise<{records,malformedCount,warnings}>;
 *   append(record) -> Promise<void>; getRecords() -> HistoryRecord[]; commands() -> string[].
 * All dependencies are injectable. Disabled history performs no reads, mkdir or writes.
 * Shared Git seam: git(args,{cwd,timeoutMs,maxBuffer,signal,trustedRoot?}) ->
 * Promise<{code,stdout,stderr}>. argv is always literal; code=1 for show-ref means
 * absent. Timeout/transport reject typed errors. stderr is private. The adapter
 * scrubs SCRUBBED_GIT_ENV and applies invocation-scoped safe.directory only for an
 * exact canonical root with persisted consent; a caller boolean is never authority.
 */

/**
 * @typedef {object} PlacementIntent
 * @property {string} projectKey
 * @property {string} root Canonical main checkout or plain-folder root.
 * @property {'auto'|'here'|'wt'} mode Fan-out sends wt for every child.
 * @property {string} subfolder Relative, resolves inside root; no symlink escape.
 * @property {string} label
 * @property {'tab'|'split'} placementStyle
 */
/**
 * @typedef {object} AgentTarget
 * @property {string} paneId
 * @property {string} terminalId
 * @property {string} [provider]
 * @property {string|null} [agentName]
 * @property {string|null} [sessionId] Preserve existing session identity check.
 * @property {string} [status] Required and rechecked when closing.
 */
/** @typedef {{paneId:string,terminalId:string,tabId:string,workspaceId:string}} PaneReceipt */
/**
 * @typedef {object} CreatedResources
 * @property {string} [workspaceId]
 * @property {string} [tabId] Root tab for compatibility/convenience.
 * @property {string[]} tabIds Every tab this task created.
 * @property {PaneReceipt[]} panes Every created pane and its original terminal identity.
 * @property {{repoCwd:string,path:string,branch:string,workspaceId:string,baseCommit:string}} [worktree]
 */
/**
 * @typedef {object} ActualPlacement
 * @property {'here'|'worktree'} mode
 * @property {string} reason
 * @property {'split'|'tab'|'workspace'|'worktree'} targetKind
 * @property {string} cwd Actual root in worktree mode; requested subfolder stays in intent.
 * @property {string} [workspaceId]
 * @property {string} [baseCommit] Captured immediately before create and always passed explicitly.
 * @property {string[]} notices Includes the pre-launch worktree root-only notice.
 */
/**
 * @typedef {object} DispatchRequest
 * @property {string} taskId
 * @property {string} attemptId Different for a confirmed trust retry, same taskId.
 * @property {string} provider
 * @property {string} prompt Final expanded task; one literal argv entry, delivered at most once.
 * @property {string} inputTask Original unexpanded task, required for modern placement requests; used for naming only, never sent in place of prompt.
 * @property {string} name
 * @property {string[]} [args]
 * @property {PlacementIntent} placement Resolved from fresh private snapshot inside project lock.
 */
/**
 * @typedef {object} ProgressEvent
 * @property {string} taskId
 * @property {string} attemptId
 * @property {'queued'|'target'|'start'|'prompt'} stage
 * @property {string} at
 * @property {{mode:'here'|'worktree',reason:string}} [placement] Target-stage decision, not a receipt or ActualPlacement.
 * @property {string} [message] Target-only notice, emitted before the first mutation.
 * @property {true} [noticeRequired] Target-only worktree notice requiring a visible-flush acknowledgement.
 * @property {{paneId:string,terminalId:string,provider:string,agentName:string}} [target] Start-only exact created identity, for focus/observation; never cleanup authority.
 * @property {'launch'|'type'} [delivery] Start-only selected route; never a delivery acknowledgement.
 */
/**
 * @typedef {object} Outcome
 * @property {boolean} ok
 * @property {string} state Dispatch: LAUNCH_OUTCOMES; actions: focused, closed, removed, failed, uncertain.
 * @property {string} message
 * @property {string} [code] Host codes are D0-qualified; ownership classification additionally requires the exact anchored native Git message and canonical root.
 * @property {'target'|'start'|'prompt'} [stage]
 * @property {string} [taskId] Always present for dispatch, including legacy generated IDs.
 * @property {string} [attemptId]
 * @property {string} [paneId]
 * @property {string} [terminalId]
 * @property {string} [agentName]
 * @property {'launch'|'type'} [delivery] Selected delivery route, never a receipt by itself. Submitted with launch means started with its task, not completed.
 * @property {string[]} [argv] Private in-memory field; redact credential-like arguments in notices.
 * @property {ActualPlacement} [placement] Authoritative controller result, not UI preview.
 * @property {CreatedResources} [created] Retained on every later failure/uncertain result.
 */
/**
 * Controller interface:
 * createController({context,monitor,mode,run,readRaw,config,getConfig,registry,git,fs,now,randomHex,onNotice,delivery='auto'})
 * delivery='auto' passes eligible Claude/Codex/Grok tasks as one literal startup
 * argument; other providers, leading '-', single-word, newline and tab tasks use
 * the unchanged typed path. delivery='type' is a fixture compatibility setting.
 * CLI fixtures may set SHEP_TEST_DELIVERY=type; it only selects that same path,
 * never bypasses checks, never writes config, and is unset for default-path QA.
 * No launch-path failure ever retries or falls back to typing. A startup timeout
 * can mean the exact created agent is already working: only fresh identity-bound
 * observation supports submitted in that case; otherwise preserve uncertainty.
 * dispatch(request,{onProgress}={}) -> Promise<Outcome>;
 * onProgress(event) -> void|Promise<void>.
 * Start progress may expose target/delivery after owned creation and exact checks.
 * A matching task/attempt/provider/name may bind that target before the final outcome,
 * observe metadata and focus it. Final certainty still comes from the dispatch promise.
 * Pending startup focus keeps all identity/own-pane/stale/demo checks. Before agent
 * detection it may focus only the controller-created tab whose fresh topology still
 * contains exactly its captured sole pane; split/external/changed topology refuses.
 * Close/follow-up retain startup locks. Early targets grant no cleanup/trust authority.
 * getProfiles() -> Promise<existing profiles plus {snapshot: private Herdr snapshot}>.
 * getControlSnapshot() -> Promise<complete fresh private snapshot>; no executable
 * availability scan. Agent-only public snapshots never prove that a pane disappeared.
 * focus(target), closeAgent(target) -> Promise<Outcome>; close remains available for ANY
 *   selected agent with confirmation, identity/status rechecks and own-pane protection.
 * followUp({target,text}) -> Promise<Outcome>; no wait, 8 s timeout, no retry.
 * notify({title,body,sound}) -> Promise<void>; never throws. The first notification
 * failure invokes onNotice once per session. getConfig() supplies fresh config after
 * trust writes or Ctrl+R, defaulting to the supplied config when omitted.
 * listWorktrees({cwd}) -> Promise<WorktreeInfo[]>.
 * removeWorktree({workspaceId,path,branch,force}) -> Promise<Outcome>; controller-owned
 *   receipts, not caller claims, authorize deletion. Recheck all descendant IDs and
 *   terminals; refuse any unowned descendant or working/blocked agent. Never delete branch.
 * dismissTask({taskId,attemptId}) -> Outcome; local-only reservation release for final
 *   attempts, busy otherwise; preserves creation receipts and never touches Herdr.
 * dispose() -> void; abort pending commands and queue, never close created resources.
 *
 * Legacy dispatch({provider,prompt,name?,cwd?,workspaceId?}) is explicit split behavior
 * when placement is absent; generated IDs are allowed ONLY for legacy callers.
 * Ordinary progress callbacks are nonfatal observers: catch sync throws and rejected
 * promises. Required target notices are the exception below. Events retain task/attempt IDs;
 * queued -> target -> start -> prompt, skipping later stages after failure. A callback
 * never implies prompt delivery. Final outcomes may not overwrite another task/draft.
 * Target-stage placement/message is emitted AFTER fresh locked resolution but BEFORE
 * any creation. Worktree + nonempty requested subfolder always announces the root-only
 * notice; no extra tab, shell cd or native cwd argument is permitted. Render-only text
 * is sanitized; the intent is unchanged. Headless notices go to stderr, preserving JSON.
 * That root-only notice sets noticeRequired:true. The controller derives the requirement
 * from resolved worktree mode and nonempty requested subfolder, never a request override.
 * Before any native mutation, await onProgress completion for this required event only,
 * bounded by prelaunchNoticeTimeoutMs (1500 ms) and abortable on dispose. Missing handler,
 * rejection or timeout returns failed/target with code prelaunch_notice_failed and the
 * sanitized prelaunchNoticeFailed message; nothing is created or started by that attempt.
 * Dispose uses the shutdown outcome instead; recheck disposed after acknowledgement.
 * A frontend acknowledgement means THIS task/attempt notice has visibly flushed: Ink
 * waits for waitUntilRenderFlush(), CLI waits for its stderr write callback. Merely
 * updating state is insufficient. Concurrent notices must not acknowledge an overwritten
 * notice; serialize flushes or otherwise establish each specific notice was rendered.
 * Sync completed writes may acknowledge immediately. This is no owner-approval dialog.
 * Per-project target locks and reservations cover one process. Uncertain reservations
 * are not freed merely because an unready shell appears; reconcile the receipt safely.
 */
/**
 * Placement: explicit wt or project.isolation=always uses a worktree; otherwise
 * use the main folder, including occupied or reserved checkouts and explicit here.
 * Fan-out remains deferred. Known linked-worktree paths are excluded when finding
 * the main workspace. Worktree mode requires Git; ordinary plain folders use here.
 * Workspace eligibility: worktree=null OR verified is_linked_worktree=false primary
 * metadata whose canonical checkout/root/commonDir agree with the Project. Linked,
 * unknown or mismatched metadata is excluded. The same rule applies to discovery.
 * Workspace order: matching project label, most matching panes, lowest native workspace.number.
 * Create one target with --no-focus; a newly created workspace uses its root pane.
 * Pure resolvePlacement({intent,project,snapshot,reservations}) returns a target plan.
 * Plan: {targetKind,mode,reason,sourceRoot,cwd,workspaceId?,anchorPane?,notices}.
 * cwd is null for a not-yet-created worktree; sourceRoot is never claimed as its cwd.
 * mode is here|worktree; anchorPane is the complete selected split-pane identity.
 * Folder projects with isolation always fail before mutation; here does not override it.
 * preparePlacementSnapshot(snapshot,{realpath}) asynchronously supplies canonical cwd
 * facts first, shared by preview/execution. Resolve registry projectKey and verify its
 * canonical root agrees with intent before taking its lock; caller paths confer no trust.
 * UI preview is advisory. Controller resolves again under lock before any creation.
 * A private snapshot has complete tabs[], panes[], workspaces[], agents[]; workspace
 * and tab number fields are native numbers, not parsed IDs. Each pane supplies its
 * pane_id/terminal_id/tab_id/workspace_id and canonical foreground_cwd or cwd. Missing
 * descendant arrays forbid removal, while legacy split/focus/close remain compatible
 * with their old snapshot fixtures. worktree.open_workspace_id must match the returned
 * workspace and root-pane tuple before it authorizes any later cleanup. Native
 * is_linked_worktree must be true and canonical path must differ from project.root;
 * unknown or contradictory metadata preserves resources without cleanup authority.
 * worktree.create may also introduce a primary workspace absent from its response;
 * discover/reuse it as shared, but never infer ownership from a snapshot difference.
 * Only response-confirmed linked workspace/root identities permit task cleanup.
 */

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} attemptId
 * @property {string|null} groupId One fan-out group, one task per provider.
 * @property {string} at
 * @property {string} command
 * @property {string} inputTask Original text, used for naming and rerun.
 * @property {string} prompt Expanded text, memory only.
 * @property {AgentSpec} agent
 * @property {Project} project
 * @property {string} subfolder
 * @property {'auto'|'here'|'wt'} modeIntent Re-resolved on rerun.
 * @property {string|null} template
 * @property {string} name
 * @property {string[]} args Effective argv; changed argv requires consent again.
 * @property {PlacementIntent} intent
 * @property {ActualPlacement|null} placement
 * @property {{state:string,message:string,code:string|null,stage:string|null}} launch
 * @property {{status:string|null,since:string|null}} live Never replaces launch certainty.
 * @property {AgentTarget|null} target
 * @property {CreatedResources|null} created
 * @property {{count:number,lastAt:string|null}} followUp No follow-up text is persisted.
 * @property {object|null} summary Computed git summary, not persisted.
 * @property {boolean} dismissed Local task dismissal does not authorize cleanup.
 */
/**
 * Task events: {type:'progress',event:ProgressEvent}; {type:'outcome',outcome:Outcome};
 * {type:'confirmation',approved:boolean,attemptId:string,at:string};
 * {type:'live',status:LiveState,since:string,paneId:string,terminalId:string};
 * {type:'follow-up',outcome:Outcome,at:string}; {type:'dismiss',at:string}.
 * Reject an event for another task or attempt; leave task unchanged and show a notice
 * at runtime. Final launch values never change on live refresh. A closed live state
 * is terminal; a failed launch cannot transition to another launch state. Queued
 * disposal leaves recorded state intact. Missing agents on stale snapshots never
 * establish closure; use a fresh matching pane/terminal observation.
 * needs_confirmation ends one controller attempt but is NOT a final task/history
 * result: approval starts the same task with a new attemptId, replacing only that
 * provisional launch. Decline finalizes failed. Ignore late events from the old attempt.
 * displayState uses matching observed live status when present. Without a live status,
 * submitted displays unknown with the preserved submitted/awaiting-status notice;
 * every other launch state displays itself. Never infer working from delivery alone.
 */
/**
 * TUI state additions (existing editor/agent slices remain compatible):
 * tasks: Task[];
 * board: {view:'tasks'|'agents',selectedTaskId:string|null};
 * compose: {agents:AgentSpec[],projectKey:string|null,otherFolder:string,subfolder:string,
 *   modeIntent:'auto'|'here'|'wt',template:string|null,name:string,inputTask:string,
 *   field:string,projectQuery:string};
 * Project picker includes trustRequired candidates, labeled as requiring trust;
 * selecting one retains input until exact-root consent and registry refresh complete.
 * suggestions: {items:Suggestion[],selectedIndex:number};
 * followUp: {target:AgentTarget|null,text:string,cursor:number,drafts:Record<string,string>};
 * dialogs: {kind:string,taskId?:string,attemptId?:string,target?:AgentTarget,payload:object}|null.
 * Defaults: Tasks board; Enter submits, never accepts completion; Tab accepts;
 * Shift+Tab cycles. Recall is single-line only and Escape restores original draft.
 * Queue/progress does not globally block input. Every async result is correlated;
 * newer commands, edits and dialogs survive older task outcomes. All actions get Click entries.
 */
/**
 * @typedef {object} HistoryRecord
 * @property {1} v
 * @property {string} id
 * @property {string} at
 * @property {string} command Original command for recall, including fan-out syntax.
 * @property {string[]} agents One provider per task/record, even for fan-out children.
 * @property {string|null} profile
 * @property {{name:string,root:string}} project Re-resolve canonical root to project key.
 * @property {string} subfolder
 * @property {'here'|'worktree'|null} mode Authoritative decision, null if failure precedes it.
 * @property {'auto'|'here'|'wt'} modeIntent Rerun re-resolves this intent.
 * @property {string|null} template
 * @property {string} task Original inputTask, NEVER expanded prompt.
 * @property {string} state Final launch state after trust decision, not live status.
 */
/**
 * History: macOS ~/Library/Application Support/Shep/history.jsonl; Linux
 * ${XDG_STATE_HOME:-~/.local/state}/shep/history.jsonl. 0700 directory, 0600 file.
 * Append one final outcome per task using O_APPEND. Startup compacts only above
 * 2*limit, skips/counts malformed lines and deduplicates IDs, keeps newest limit,
 * writes temp then renames. Multiple processes may interleave/drop convenience
 * history during compaction; no extra store or cross-process coordination.
 * R replays resolved single-agent intent with original text and current templates;
 * A prefills composer. Profile consent is keyed to effective argv. Config trust
 * writes preserve unrelated keys/value formatting; malformed source is never clobbered.
 */
/**
 * Notifications: first snapshot establishes baseline only. working|unknown ->
 * done|idle: done sound; any -> blocked: request sound; starting -> needs_input:
 * request setup notice. Enabled/unfocused/external rules and 30 s pair dedupe apply.
 * createNotifier({monitor,controller,config,getTasks}) -> {dispose}; failures are
 * swallowed, with one session notice. No notification reads conversation text.
 * Git summaries: status --porcelain=v1 -z (1 MiB), diff --shortstat HEAD, plus
 * rev-list --count <baseCommit>..HEAD for worktrees, 2 s each and scrubbed env.
 * CLI: dispatch <body> [--json] [--template NAME] [--yes-trust] [--yes-profile];
 * projects [--json]; config path|check. Only config/help/version work outside Herdr.
 * --yes-trust persists consent for exactly the resolved repository and reports it.
 * Single dispatch JSON is Outcome. Fan-out JSON is {ok,outcomes:Outcome[]}; aggregate
 * exit precedence: uncertain 4 > failed 1 > needs_input/needs_confirmation 3 > submitted 0.
 * Whole-fanout parsing/validation precedes any launch; usage errors return 2 immediately.
 * Outcome.argv is optional in JSON and must pass the same credential display redactor
 * as notices: no raw credential-like argument values on stdout. Internal args stay literal.
 * Unknown git summary values are null, never zero/clean: summarize(dir,{baseCommit}) ->
 * {state:'available'|'unavailable',dirty:boolean|null,changedFiles:number|null,
 * insertions:number|null,deletions:number|null,commitsAhead:number|null,at,message?}.
 * An unavailable summary never authorizes removal.
 * Trust error mapping is target-only and uses a D0-qualified structured code plus an
 * anchored native Git dubious-ownership message naming the exact canonical repository.
 * Before the sole confirmed retry, reconcile no new branch/checkout/workspace/tab/pane;
 * only empty parent scaffolding is tolerated and it is never automatically removed.
 * After explicit persisted consent only, Git reads may use invocation-scoped
 * -c safe.directory=<exact canonical root>; no global trust configuration or wildcards.
 * classifyOwnershipFailure({source:'herdr'|'git',stage,code,message,canonicalRoot})
 * -> {root,kind:'untrusted_repository'}|null; only D0-qualified signatures match.
 * Reconciliation -> {state:'no_resources'|'resources_found'|'unknown',emptyScaffoldingOnly};
 * controller evidence and persisted consent authorize retry, never caller booleans.
 * Preflight before any creation needs consent but no creation reconciliation. One
 * trust retry per task maximum; refusal despite consent fails for manual inspection.
 */

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const validPath = value => nonempty(value) && isAbsolute(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const relativeFolder = value => typeof value === 'string' && !value.includes('\0') && !isAbsolute(value) && !value.split(/[\\/]/).includes('..');
const issue = (path, code, message) => ({ path, code, message });
const add = (errors, valid, path, code, message) => { if (!valid) errors.push(issue(path, code, message)); };
const prefixed = (issues, prefix) => issues.map(item => ({ ...item, path: `${prefix}${item.path ? `.${item.path}` : ''}` }));

export function validatePrompt(value) {
  return typeof value === 'string' && Boolean(value.trim()) && Buffer.byteLength(value, 'utf8') <= LIMITS.promptBytes
    && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value)
    ? [] : [issue('prompt', 'invalid_prompt', MESSAGES.invalidPrompt)];
}

export function validateArgs(args) {
  if (!Array.isArray(args)) return [issue('args', 'invalid_args', VALIDATION_PROBLEMS.array)];
  const errors = [];
  add(errors, args.length <= LIMITS.nativeArgs, 'args', 'invalid_args', VALIDATION_PROBLEMS.argsCount);
  Array.from(args).forEach((arg, index) => add(errors,
    typeof arg === 'string' && Buffer.byteLength(arg, 'utf8') <= LIMITS.nativeArgBytes && !/[\u0000-\u001f\u007f-\u009f]/u.test(arg),
    `args.${index}`, 'invalid_args', VALIDATION_PROBLEMS.argument));
  return errors;
}

export function validateProject(project) {
  if (!plainObject(project)) return [issue('', 'invalid_project', VALIDATION_PROBLEMS.object)];
  const errors = [];
  add(errors, typeof project.name === 'string' && PATTERNS.project.test(project.name), 'name', 'invalid_project', VALIDATION_PROBLEMS.projectName);
  add(errors, ['git', 'folder'].includes(project.kind), 'kind', 'invalid_project', 'must be git or folder');
  add(errors, validPath(project.root), 'root', 'invalid_project', VALIDATION_PROBLEMS.absolutePath);
  add(errors, project.kind === 'git' ? validPath(project.commonDir) : project.commonDir === null, 'commonDir', 'invalid_project', 'must be a canonical Git common directory or null for a folder');
  add(errors, project.key === (project.kind === 'git' ? `git:${project.commonDir}` : `dir:${project.root}`), 'key', 'invalid_project', 'must match canonical project identity');
  add(errors, Array.isArray(project.aliases) && project.aliases.every(alias => typeof alias === 'string' && PATTERNS.project.test(alias)), 'aliases', 'invalid_project', 'must contain grammar-valid aliases');
  add(errors, ['auto', 'always', 'never'].includes(project.isolation), 'isolation', 'invalid_project', VALIDATION_PROBLEMS.isolation);
  add(errors, Array.isArray(project.workspaceIds) && project.workspaceIds.every(nonempty), 'workspaceIds', 'invalid_project', 'must contain workspace IDs');
  add(errors, Array.isArray(project.sources) && project.sources.every(source => PROJECT_SOURCES.includes(source)), 'sources', 'invalid_project', 'must contain known project sources');
  add(errors, Array.isArray(project.worktrees), 'worktrees', 'invalid_project', VALIDATION_PROBLEMS.array);
  if (Array.isArray(project.worktrees)) project.worktrees.forEach((worktree, index) => add(errors,
    plainObject(worktree) && validPath(worktree.path) && worktree.path !== project.root && (worktree.branch === null || nonempty(worktree.branch)) && (worktree.workspaceId === null || nonempty(worktree.workspaceId)),
    `worktrees.${index}`, 'invalid_project', 'must have path, branch and workspaceId'));
  return errors;
}

export function validateTrustRequired(candidate) {
  if (!plainObject(candidate)) return [issue('', 'invalid_trust_candidate', VALIDATION_PROBLEMS.object)];
  const errors = [];
  add(errors, candidate.kind === 'trust_required', 'kind', 'invalid_trust_candidate', 'must be trust_required');
  for (const key of ['root', 'path']) add(errors, validPath(candidate[key]), key, 'invalid_trust_candidate', 'must preserve an absolute canonical root or discovery path');
  add(errors, typeof candidate.name === 'string' && PATTERNS.project.test(candidate.name), 'name', 'invalid_trust_candidate', VALIDATION_PROBLEMS.projectName);
  add(errors, Array.isArray(candidate.aliases) && candidate.aliases.every(alias => typeof alias === 'string' && PATTERNS.project.test(alias)), 'aliases', 'invalid_trust_candidate', 'must contain valid aliases');
  add(errors, PROJECT_SOURCES.includes(candidate.source), 'source', 'invalid_trust_candidate', 'must identify a discovery source');
  add(errors, typeof candidate.message === 'string', 'message', 'invalid_trust_candidate', VALIDATION_PROBLEMS.string);
  add(errors, !Object.hasOwn(candidate, 'key') && !Object.hasOwn(candidate, 'projectKey'), 'key', 'invalid_trust_candidate', 'must not claim an unresolved Git project key');
  return errors;
}

export function validateDispatchSpec(spec) {
  if (!plainObject(spec)) return [issue('', 'invalid_spec', VALIDATION_PROBLEMS.object)];
  const errors = [...validatePrompt(spec.task), ...prefixed(validateProject(spec.project), 'project')];
  add(errors, spec.kind === 'dispatch', 'kind', 'invalid_spec', 'must be dispatch');
  add(errors, Array.isArray(spec.agents) && spec.agents.length >= 1 && spec.agents.length <= 4, 'agents', 'invalid_spec', 'must contain 1–4 agents');
  const providers = new Set();
  if (Array.isArray(spec.agents)) spec.agents.forEach((agent, index) => {
    const valid = plainObject(agent) && PROVIDER_IDS.includes(agent.provider) && !providers.has(agent.provider)
      && (agent.profile === null || (typeof agent.profile === 'string' && PATTERNS.profile.test(agent.profile)));
    add(errors, valid, `agents.${index}`, 'invalid_spec', 'must identify a unique provider and optional profile');
    providers.add(agent?.provider);
  });
  add(errors, ['auto', ...RESOLVED_MODES].includes(spec.mode), 'mode', 'invalid_spec', 'must be auto, here or worktree');
  add(errors, MODE_INTENTS.includes(spec.modeIntent), 'modeIntent', 'invalid_spec', 'must be auto, here or wt');
  const normalizedMode = spec.agents?.length > 1 || spec.modeIntent === 'wt' ? 'worktree' : spec.modeIntent;
  add(errors, spec.mode === normalizedMode, 'mode', 'invalid_spec', 'must normalize mode intent, with fan-out forcing worktree');
  add(errors, relativeFolder(spec.subfolder), 'subfolder', 'invalid_spec', 'must be a relative subfolder');
  add(errors, spec.template === null || (typeof spec.template === 'string' && PATTERNS.profile.test(spec.template) && !RESERVED_TEMPLATES.includes(spec.template)), 'template', 'invalid_spec', VALIDATION_PROBLEMS.templateName);
  add(errors, validatePrompt(spec.inputTask).length === 0, 'inputTask', 'invalid_spec', 'must preserve original task text');
  add(errors, typeof spec.command === 'string', 'command', 'invalid_spec', 'must preserve original command text');
  return errors;
}

/** Raw config shape only: D1 performs loading, section fallback and atomic writes. */
export function validateConfigShape(value, { homeDir = '' } = {}) {
  const errors = [], warnings = [];
  const check = (valid, path, problem) => add(errors, valid, path, 'invalid_config', problem);
  const object = (node, path, keys) => {
    if (!plainObject(node)) { check(false, path, VALIDATION_PROBLEMS.object); return false; }
    for (const key of Object.keys(node)) if (!keys.includes(key)) warnings.push(issue(path ? `${path}.${key}` : key, 'unknown_config_key', VALIDATION_PROBLEMS.unknown));
    return true;
  };
  const pathValue = (path, entry) => {
    const expanded = validPath(homeDir) && typeof entry === 'string'
      ? entry === '~' ? homeDir : entry.startsWith('~/') ? `${homeDir}/${entry.slice(2)}` : entry : entry;
    check(validPath(expanded), path, VALIDATION_PROBLEMS.absolutePath);
  };
  const paths = (path, entries) => {
    check(Array.isArray(entries), path, VALIDATION_PROBLEMS.array);
    if (Array.isArray(entries)) entries.forEach((entry, index) => pathValue(`${path}.${index}`, entry));
  };
  const args = (path, value) => errors.push(...validateArgs(value).map(item => ({ ...item, path: `${path}${item.path.slice(4)}`, code: 'invalid_config' })));
  if (!object(value, '', Object.keys(DEFAULT_CONFIG))) return { errors, warnings };
  for (const [section, node] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, section)) continue;
    if (section === 'placement') { check(PLACEMENT_STYLES.includes(node), section, VALIDATION_PROBLEMS.placement); continue; }
    const keys = section === 'agents' || section === 'templates' ? Object.keys(plainObject(node) ? node : {}) : Object.keys(DEFAULT_CONFIG[section]);
    if (!object(node, section, keys)) continue;
    if (section === 'projects') {
      if (Object.hasOwn(node, 'roots')) paths('projects.roots', node.roots);
      if (Object.hasOwn(node, 'entries')) {
        check(Array.isArray(node.entries), 'projects.entries', VALIDATION_PROBLEMS.array);
        if (Array.isArray(node.entries)) node.entries.forEach((entry, index) => {
          const path = `projects.entries.${index}`;
          if (!object(entry, path, ['name', 'path', 'aliases', 'isolation'])) return;
          check(typeof entry.name === 'string' && PATTERNS.project.test(entry.name), `${path}.name`, VALIDATION_PROBLEMS.projectName);
          pathValue(`${path}.path`, entry.path);
          if (Object.hasOwn(entry, 'aliases')) check(Array.isArray(entry.aliases) && entry.aliases.every(alias => typeof alias === 'string' && PATTERNS.project.test(alias)), `${path}.aliases`, VALIDATION_PROBLEMS.projectName);
          if (Object.hasOwn(entry, 'isolation')) check(['auto', 'always', 'never'].includes(entry.isolation), `${path}.isolation`, VALIDATION_PROBLEMS.isolation);
        });
      }
    } else if (section === 'worktrees') {
      if (Object.hasOwn(node, 'branchPrefix')) check(typeof node.branchPrefix === 'string' && PATTERNS.branchPrefix.test(node.branchPrefix), 'worktrees.branchPrefix', VALIDATION_PROBLEMS.branchPrefix);
      if (Object.hasOwn(node, 'trustedRepos')) paths('worktrees.trustedRepos', node.trustedRepos);
    } else if (section === 'agents') {
      for (const [provider, settings] of Object.entries(node)) {
        const path = `agents.${provider}`;
        check(PROVIDER_IDS.includes(provider), path, VALIDATION_PROBLEMS.provider);
        if (!object(settings, path, ['args', 'profiles'])) continue;
        if (Object.hasOwn(settings, 'args')) args(`${path}.args`, settings.args);
        if (Object.hasOwn(settings, 'profiles')) {
          if (!object(settings.profiles, `${path}.profiles`, Object.keys(plainObject(settings.profiles) ? settings.profiles : {}))) continue;
          for (const [name, profile] of Object.entries(settings.profiles)) {
            const profilePath = `${path}.profiles.${name}`;
            check(PATTERNS.profile.test(name), profilePath, VALIDATION_PROBLEMS.profileName);
            if (object(profile, profilePath, ['args'])) args(`${profilePath}.args`, profile.args);
          }
        }
      }
    } else if (section === 'templates') {
      for (const [name, text] of Object.entries(node)) {
        check(PATTERNS.profile.test(name) && !RESERVED_TEMPLATES.includes(name), `templates.${name}`, VALIDATION_PROBLEMS.templateName);
        check(typeof text === 'string' && (text === '' || (text.includes('{task}') && Buffer.byteLength(text, 'utf8') <= LIMITS.templateBytes)), `templates.${name}`, VALIDATION_PROBLEMS.template);
      }
    } else if (section === 'notifications') {
      for (const key of Object.keys(DEFAULT_CONFIG.notifications)) if (Object.hasOwn(node, key)) check(typeof node[key] === 'boolean', `notifications.${key}`, VALIDATION_PROBLEMS.boolean);
    } else if (section === 'history') {
      if (Object.hasOwn(node, 'enabled')) check(typeof node.enabled === 'boolean', 'history.enabled', VALIDATION_PROBLEMS.boolean);
      if (Object.hasOwn(node, 'limit')) check(Number.isSafeInteger(node.limit) && node.limit > 0, 'history.limit', VALIDATION_PROBLEMS.historyLimit);
    } else if (section === 'concurrency' && Object.hasOwn(node, 'maxLaunches')) check(Number.isInteger(node.maxLaunches) && node.maxLaunches >= 1 && node.maxLaunches <= 4, 'concurrency.maxLaunches', VALIDATION_PROBLEMS.maxLaunches);
  }
  return { errors, warnings };
}

export function validatePlacementIntent(placement) {
  if (!plainObject(placement)) return [issue('placement', 'invalid_target', VALIDATION_PROBLEMS.object)];
  const errors = [];
  add(errors, nonempty(placement.projectKey), 'projectKey', 'invalid_target', 'must identify a registered project');
  add(errors, validPath(placement.root), 'root', 'invalid_target', VALIDATION_PROBLEMS.absolutePath);
  add(errors, MODE_INTENTS.includes(placement.mode), 'mode', 'invalid_target', 'must be auto, here or wt');
  add(errors, relativeFolder(placement.subfolder), 'subfolder', 'invalid_target', 'must be relative and stay inside the project');
  add(errors, nonempty(placement.label), 'label', 'invalid_target', 'must be a nonempty tab label');
  add(errors, PLACEMENT_STYLES.includes(placement.placementStyle), 'placementStyle', 'invalid_target', VALIDATION_PROBLEMS.placement);
  return errors;
}

export function validateDispatchRequest(request, { allowLegacy = true } = {}) {
  if (!plainObject(request)) return [issue('', 'invalid_request', VALIDATION_PROBLEMS.object)];
  const errors = [...validatePrompt(request.prompt), ...validateArgs(request.args ?? [])];
  add(errors, PROVIDER_IDS.includes(request.provider), 'provider', 'invalid_provider', VALIDATION_PROBLEMS.provider);
  const legacy = !Object.hasOwn(request, 'placement') && allowLegacy;
  if (!legacy || request.name !== undefined) add(errors,
    typeof request.name === 'string' && PATTERNS.agentName.test(request.name), 'name', 'invalid_name', 'must be a valid agent name');
  if (legacy) {
    if (request.cwd !== undefined) add(errors, validPath(request.cwd), 'cwd', 'invalid_cwd', VALIDATION_PROBLEMS.absolutePath);
    if (request.workspaceId !== undefined) add(errors, nonempty(request.workspaceId), 'workspaceId', 'workspace_missing', 'must identify a workspace');
  } else {
    add(errors, validatePrompt(request.inputTask).length === 0, 'inputTask', 'invalid_request', 'must preserve original task text for naming');
    for (const key of ['taskId', 'attemptId']) add(errors, nonempty(request[key]), key, 'invalid_request', 'must be a nonempty ID');
    errors.push(...prefixed(validatePlacementIntent(request.placement), 'placement'));
  }
  return errors;
}

export function validateProgressEvent(event) {
  if (!plainObject(event)) return [issue('', 'invalid_progress', VALIDATION_PROBLEMS.object)];
  const errors = [];
  for (const key of ['taskId', 'attemptId']) add(errors, nonempty(event[key]), key, 'invalid_progress', 'must be a nonempty ID');
  add(errors, PROGRESS_STAGES.includes(event.stage), 'stage', 'invalid_progress', 'must be queued, target, start or prompt');
  add(errors, timestamp(event.at), 'at', 'invalid_progress', 'must be an ISO timestamp');
  if (event.placement !== undefined) add(errors,
    event.stage === 'target' && plainObject(event.placement) && RESOLVED_MODES.includes(event.placement.mode) && typeof event.placement.reason === 'string',
    'placement', 'invalid_progress', 'must be a target-stage placement decision');
  if (event.message !== undefined) add(errors, event.stage === 'target' && typeof event.message === 'string', 'message', 'invalid_progress', 'must be a target-stage notice');
  if (event.noticeRequired !== undefined) add(errors,
    event.noticeRequired === true && event.stage === 'target' && event.placement?.mode === 'worktree'
      && typeof event.message === 'string' && Boolean(event.message.trim()),
    'noticeRequired', 'invalid_progress', 'must mark a target-stage worktree notice with nonempty text');
  if (event.target !== undefined) add(errors, event.stage === 'start' && plainObject(event.target)
    && nonempty(event.target.paneId) && nonempty(event.target.terminalId)
    && PROVIDER_IDS.includes(event.target.provider) && typeof event.target.agentName === 'string' && PATTERNS.agentName.test(event.target.agentName),
    'target', 'invalid_progress', 'must identify the exact created pane, terminal, provider and agent name at start');
  if (event.delivery !== undefined) add(errors, event.stage === 'start' && DELIVERY_MODES.includes(event.delivery),
    'delivery', 'invalid_progress', 'must select launch or type at start');
  return errors;
}

export function validateOutcome(outcome, { dispatch = true } = {}) {
  if (!plainObject(outcome)) return [issue('', 'invalid_outcome', VALIDATION_PROBLEMS.object)];
  const errors = [];
  const states = dispatch ? LAUNCH_OUTCOMES : [...LAUNCH_OUTCOMES, 'focused', 'closed', 'removed', 'dismissed'];
  add(errors, states.includes(outcome.state), 'state', 'invalid_outcome', 'must be a documented outcome');
  add(errors, typeof outcome.ok === 'boolean' && outcome.ok === ['submitted', 'focused', 'closed', 'removed', 'dismissed'].includes(outcome.state), 'ok', 'invalid_outcome', 'must agree with outcome state');
  add(errors, typeof outcome.message === 'string', 'message', 'invalid_outcome', VALIDATION_PROBLEMS.string);
  if (outcome.delivery !== undefined) add(errors, DELIVERY_MODES.includes(outcome.delivery), 'delivery', 'invalid_outcome', 'must be launch or type');
  if (dispatch) for (const key of ['taskId', 'attemptId']) add(errors, nonempty(outcome[key]), key, 'invalid_outcome', 'must correlate the dispatch attempt');
  if (outcome.stage !== undefined) add(errors, OUTCOME_STAGES.includes(outcome.stage), 'stage', 'invalid_outcome', 'must be target, start or prompt');
  if (outcome.placement !== undefined) errors.push(...prefixed(validateActualPlacement(outcome.placement), 'placement'));
  if (outcome.created !== undefined) {
    const created = outcome.created;
    add(errors, plainObject(created), 'created', 'invalid_outcome', VALIDATION_PROBLEMS.object);
    if (plainObject(created)) {
      add(errors, Array.isArray(created.tabIds) && created.tabIds.every(nonempty), 'created.tabIds', 'invalid_outcome', 'must contain created tab IDs');
      add(errors, Array.isArray(created.panes) && created.panes.every(pane => plainObject(pane) && ['paneId', 'terminalId', 'tabId', 'workspaceId'].every(key => nonempty(pane[key]))), 'created.panes', 'invalid_outcome', 'must contain complete created pane identities');
      if (outcome.state === 'submitted' || (Array.isArray(created.panes) && created.panes.length > 0 && outcome.paneId !== undefined && outcome.terminalId !== undefined)) add(errors,
        Array.isArray(created.panes) && created.panes.some(pane => pane?.paneId === outcome.paneId && pane?.terminalId === outcome.terminalId),
        'created.panes', 'invalid_outcome', 'must include the outcome’s exact pane and terminal identity');
      if (Array.isArray(created.panes) && Array.isArray(created.tabIds)) for (const pane of created.panes) {
        if (!plainObject(pane)) continue;
        // A split may belong to an existing tab; only newly created workspace receipts
        // require every descendant's tab and workspace to be owned by this task.
        if (created.workspaceId) add(errors, pane.workspaceId === created.workspaceId && created.tabIds.includes(pane.tabId), 'created.panes', 'invalid_outcome', 'must match the created workspace and tabs');
      }
      if (created.worktree !== undefined) {
        const worktree = created.worktree;
        add(errors, plainObject(worktree) && validPath(worktree.repoCwd) && validPath(worktree.path) && worktree.path !== worktree.repoCwd
          && nonempty(worktree.branch) && nonempty(worktree.workspaceId) && worktree.workspaceId === created.workspaceId
          && typeof worktree.baseCommit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(worktree.baseCommit),
        'created.worktree', 'invalid_outcome', 'must contain canonical paths, matching workspace, branch and full base commit');
        if (plainObject(worktree) && plainObject(outcome.placement)) add(errors,
          outcome.placement.mode === 'worktree' && outcome.placement.cwd === worktree.path
            && outcome.placement.workspaceId === worktree.workspaceId && outcome.placement.baseCommit === worktree.baseCommit,
          'placement', 'invalid_outcome', 'must match the created worktree receipt');
      }
    }
  }
  return errors;
}

export function validateActualPlacement(placement) {
  if (!plainObject(placement)) return [issue('', 'invalid_placement', VALIDATION_PROBLEMS.object)];
  const errors = [];
  add(errors, RESOLVED_MODES.includes(placement.mode), 'mode', 'invalid_placement', 'must be here or worktree');
  add(errors, TARGET_KINDS.includes(placement.targetKind), 'targetKind', 'invalid_placement', 'must identify the created target kind');
  add(errors, typeof placement.reason === 'string', 'reason', 'invalid_placement', VALIDATION_PROBLEMS.string);
  add(errors, validPath(placement.cwd), 'cwd', 'invalid_placement', 'must be the known actual absolute cwd');
  add(errors, Array.isArray(placement.notices) && placement.notices.every(notice => typeof notice === 'string'), 'notices', 'invalid_placement', 'must contain display notices');
  if (placement.mode === 'worktree') {
    add(errors, placement.targetKind === 'worktree', 'targetKind', 'invalid_placement', 'worktree mode requires a worktree target');
    add(errors, nonempty(placement.workspaceId), 'workspaceId', 'invalid_placement', 'must identify the created workspace');
    add(errors, typeof placement.baseCommit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(placement.baseCommit), 'baseCommit', 'invalid_placement', 'must be the captured full commit ID');
  } else add(errors, placement.targetKind !== 'worktree', 'targetKind', 'invalid_placement', 'here mode cannot claim a worktree target');
  return errors;
}

export function validateHistoryRecord(record) {
  if (!plainObject(record)) return [issue('', 'invalid_history', VALIDATION_PROBLEMS.object)];
  const errors = [];
  for (const key of Object.keys(record)) add(errors, HISTORY_FIELDS.includes(key), key, 'invalid_history', 'field is outside the history privacy contract');
  for (const key of HISTORY_FIELDS) add(errors, Object.hasOwn(record, key), key, 'invalid_history', 'required field is missing');
  add(errors, record.v === 1, 'v', 'invalid_history', 'must be 1');
  add(errors, nonempty(record.id), 'id', 'invalid_history', 'must identify the task');
  add(errors, timestamp(record.at), 'at', 'invalid_history', 'must be an ISO timestamp');
  add(errors, typeof record.command === 'string', 'command', 'invalid_history', VALIDATION_PROBLEMS.string);
  add(errors, Array.isArray(record.agents) && record.agents.length === 1 && PROVIDER_IDS.includes(record.agents[0]), 'agents', 'invalid_history', 'must contain this task’s single provider');
  add(errors, record.profile === null || (typeof record.profile === 'string' && PATTERNS.profile.test(record.profile)), 'profile', 'invalid_history', VALIDATION_PROBLEMS.profileName);
  const project = record.project;
  add(errors, plainObject(project) && Object.keys(project).every(key => ['name', 'root'].includes(key)) && typeof project.name === 'string' && PATTERNS.project.test(project.name) && validPath(project.root), 'project', 'invalid_history', 'must contain only project name and absolute root');
  add(errors, relativeFolder(record.subfolder), 'subfolder', 'invalid_history', 'must be a relative project subfolder');
  add(errors, (record.mode === null && ['failed', 'uncertain'].includes(record.state)) || RESOLVED_MODES.includes(record.mode), 'mode', 'invalid_history', 'must be here, worktree or null when failure precedes placement resolution');
  add(errors, MODE_INTENTS.includes(record.modeIntent), 'modeIntent', 'invalid_history', 'must be auto, here or wt');
  add(errors, record.template === null || (typeof record.template === 'string' && PATTERNS.profile.test(record.template) && !RESERVED_TEMPLATES.includes(record.template)), 'template', 'invalid_history', VALIDATION_PROBLEMS.templateName);
  add(errors, validatePrompt(record.task).length === 0, 'task', 'invalid_history', 'must contain original task text within the prompt limit');
  add(errors, FINAL_LAUNCH_STATES.includes(record.state), 'state', 'invalid_history', 'must contain the final launch outcome after confirmation');
  return errors;
}

export function assertContract(issues) {
  if (issues.length) {
    const error = new TypeError(issues.map(item => `${item.path || 'value'}: ${item.message}`).join('; '));
    error.code = 'invalid_contract';
    error.issues = issues;
    throw error;
  }
}
