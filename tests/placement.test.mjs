import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePlacementSnapshot, resolvePlacement } from '../src/placement.mjs';
import { makeProject, makeSnapshot } from './helpers/dispatch-fakes.mjs';
const project = makeProject();
const intent = { projectKey: project.key, root: project.root, mode: 'auto', subfolder: '', label: 'Task', placementStyle: 'tab' };
async function decide({ project: p = project, intent: i = intent, snapshot = makeSnapshot(), reservations = [] } = {}) {
  const prepared = await preparePlacementSnapshot(snapshot, { realpath: async p => p });
  return resolvePlacement({ intent: i, project: p, snapshot: prepared, reservations });
}

test('placement decision table covers explicit policies, busy status and folder guards', async () => {
  for (const isolation of ['auto', 'always', 'never']) for (const mode of ['auto', 'here', 'wt']) for (const busy of [false, true]) {
    const snapshot = makeSnapshot(); if (busy) snapshot.agents.push({ agent: 'codex', agent_status: 'working', cwd: project.root });
    const result = await decide({ project: { ...project, isolation }, intent: { ...intent, mode }, snapshot });
    const expected = mode === 'here' ? 'here' : mode === 'wt' || isolation === 'always' || (isolation === 'auto' && busy) ? 'worktree' : 'here';
    assert.equal(result.mode, expected, `${isolation}/${mode}/${busy}`);
  }
  for (const status of ['blocked', 'working', 'done', 'idle', 'unknown']) {
    const snapshot = makeSnapshot(); snapshot.agents.push({ agent: 'codex', agent_status: status, cwd: project.root + '/src' });
    assert.equal((await decide({ snapshot })).mode, ['blocked', 'working'].includes(status) ? 'worktree' : 'here');
  }
  await assert.rejects(decide({ project: { ...project, kind: 'folder', isolation: 'always' } }), { code: 'worktree_needs_git' });
  assert.equal((await decide({ project: { ...project, kind: 'folder', isolation: 'always' }, intent: { ...intent, mode: 'here' } })).mode, 'here');
});

test('main checkout excludes linked worktrees, sibling prefix paths and failed canonicalization', async () => {
  for (const cwd of ['/fixture/shep-linked', '/fixture/shep2', '/fixture/shep/wt/sub']) {
    const snapshot = makeSnapshot(); snapshot.agents.push({ agent_status: 'working', cwd });
    assert.equal((await decide({ project: { ...project, worktrees: [{ path: '/fixture/shep/wt' }] }, snapshot })).mode, 'here');
  }
  const snapshot = makeSnapshot(); snapshot.agents.push({ agent_status: 'working', cwd: '/unknown' });
  const prepared = await preparePlacementSnapshot(snapshot, { realpath: async path => { if (path === '/unknown') throw Error(); return path; } });
  assert.equal(resolvePlacement({ intent, project, snapshot: prepared }).mode, 'here');
  assert.equal((await decide({ reservations: [{ projectKey: project.key, cwd: project.root }] })).mode, 'worktree');
});

test('workspace order prefers exact label then matching panes then native number', async () => {
  const snapshot = makeSnapshot();
  const add = (id, number, label, count) => {
    snapshot.workspaces.push({ workspace_id: id, number, label, worktree: null, active_tab_id: `${id}:t1` });
    for (let i = 0; i < count; i += 1) snapshot.panes.push({ pane_id: `${id}:p${i}`, terminal_id: `${id}:${i}`, tab_id: `${id}:t1`, workspace_id: id, cwd: project.root });
  };
  add('w99', 0, 'other', 4); add('w2', 5, 'SHEP', 2); add('w20', 2, 'shep', 2);
  assert.equal((await decide({ snapshot })).workspaceId, 'w20');
  snapshot.workspaces.find(w => w.workspace_id === 'w2').number = 1;
  assert.equal((await decide({ snapshot })).workspaceId, 'w2');
  const split = await decide({ snapshot, intent: { ...intent, placementStyle: 'split' } });
  assert.equal(split.targetKind, 'split'); assert.equal(split.anchorPane.workspace_id, 'w2');
});

test('verified primary metadata is reusable but linked/unknown/mismatched metadata is excluded', async () => {
  for (const patch of [{}, { is_linked_worktree: true }, { is_linked_worktree: undefined }, { repo_root: '/wrong' }, { repo_key: '/wrong' }]) {
    const snapshot = makeSnapshot(); snapshot.workspaces[0].worktree = { is_linked_worktree: false, checkout_path: project.root, repo_root: project.root, repo_key: project.commonDir, ...patch };
    assert.equal((await decide({ snapshot })).targetKind, Object.keys(patch).length ? 'workspace' : 'tab');
  }
});

test('worktree intent preserves requested subfolder but actual cwd is unknown until creation', async () => {
  const plan = await decide({ intent: { ...intent, mode: 'wt', subfolder: 'src/api' } });
  assert.equal(plan.cwd, null); assert.equal(plan.sourceRoot, project.root);
  assert.deepEqual(plan.notices, ["Worktree starts at the repository root; subfolder src/api isn't applied"]);
  assert.equal((await decide({ intent: { ...intent, subfolder: 'src' } })).cwd, project.root + '/src');
  await assert.rejects(decide({ intent: { ...intent, root: '/replacement' } }), { code: 'changed_project' });
});
