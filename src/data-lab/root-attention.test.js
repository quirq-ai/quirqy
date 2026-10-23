import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, stateAt } from './model.js';
import { createSizeSnapshot } from './size-history.js';
import { buildRootAttentionHistory, rootAttentionAt } from './root-attention.js';

const change = (path, status = 'modified', extra = {}) => ({ path, status, ...extra });
const snapshot = (sha, entries) => createSizeSnapshot(entries.map(([path, size]) => ({ path, size })), { sha });
function fixture(commits, trees) {
  return {
    repository: { name: 'root-attention' },
    files: trees.at(-1).map(([path, size]) => ({ path, size })), commits,
    sizeHistory: { version: 1, baseline: snapshot(null, trees[0]), commits: commits.map((commit, index) => snapshot(commit.sha, trees[index + 1])) },
  };
}
const byPath = (state, path) => [...state.files.values()].find(file => file.path === path);

test('latest exact byte comparison persists through unrelated commits independently of line activity', () => {
  const model = buildModel(fixture([
    { sha: 'grow', files: [change('a', 'modified', { additions: 0, deletions: 100 })] },
    { sha: 'shrink', files: [change('b', 'modified', { additions: 100, deletions: 0 })] },
    { sha: 'same', files: [change('c', 'modified', { additions: 20, deletions: 1 })] },
    { sha: 'quiet', files: [] },
  ], [
    [['a', 10], ['b', 100], ['c', 50], ['untouched', 80]],
    [['a', 30], ['b', 100], ['c', 50], ['untouched', 80]],
    [['a', 30], ['b', 20], ['c', 50], ['untouched', 80]],
    [['a', 30], ['b', 20], ['c', 50], ['untouched', 80]],
    [['a', 30], ['b', 20], ['c', 50], ['untouched', 80]],
  ]));
  const history = buildRootAttentionHistory(model), latest = rootAttentionAt(history, 3);
  assert.equal(rootAttentionAt(history, -1).files.size, 0);
  assert.deepEqual(['a', 'b', 'c'].map(path => { const file = byPath(latest, path); return [file.direction, file.deltaBytes, file.commitIndex, file.touchCount]; }), [
    ['increase', 20, 0, 1], ['decrease', -80, 1, 1], ['same', 0, 2, 1],
  ]);
  assert.equal(byPath(latest, 'untouched'), undefined);
  assert.equal(latest.touchedFiles.size, 0);
  assert.deepEqual(latest.files, rootAttentionAt(history, 2).files);
});

test('known zero bytes and genuine additions are quantitative; absent size data is never zero', () => {
  const names = ['empty', 'cleared', 'unknown-before', 'unknown-after', 'new-empty', 'new-content', 'new-unknown'];
  const model = buildModel(fixture([{ sha: 'one', files: names.map(path => change(path, path.startsWith('new-') ? 'added' : 'modified')) }], [
    [['empty', 0], ['cleared', 40], ['unknown-before', null], ['unknown-after', 40]],
    [['empty', 0], ['cleared', 0], ['unknown-before', 40], ['unknown-after', null], ['new-empty', 0], ['new-content', 12], ['new-unknown', null]],
  ]));
  const state = rootAttentionAt(buildRootAttentionHistory(model), 0);
  assert.deepEqual(names.map(path => { const file = byPath(state, path); return [file.direction, file.deltaBytes]; }), [
    ['same', 0], ['decrease', -40], ['unknown', null], ['unknown', null], ['same', 0], ['increase', 12], ['unknown', null],
  ]);
  assert.equal(byPath(state, 'new-content').beforeBytes, 0);
  assert.equal(byPath(state, 'unknown-before').beforeBytes, null);
  assert.equal(byPath(state, 'unknown-after').afterBytes, null);
});

test('latest unknown touch replaces an earlier comparison, including legacy head-only bytes', () => {
  const model = buildModel(fixture([
    { sha: 'known', files: [change('a')] }, { sha: 'unknown', files: [change('a')] }, { sha: 'quiet', files: [] },
  ], [[['a', 10]], [['a', 20]], [['a', null]], [['a', null]]]));
  const history = buildRootAttentionHistory(model);
  assert.equal(byPath(rootAttentionAt(history, 0), 'a').direction, 'increase');
  for (const index of [1, 2]) {
    const file = byPath(rootAttentionAt(history, index), 'a');
    assert.equal(file.direction, 'unknown'); assert.equal(file.deltaBytes, null); assert.equal(file.touchCount, 2);
  }
  const legacy = buildModel({ repository: { name: 'legacy' }, files: [{ path: 'a', size: 100 }], commits: [{ sha: 'one', files: [change('a')] }] });
  const old = byPath(rootAttentionAt(buildRootAttentionHistory(legacy), 0), 'a');
  assert.equal(old.afterBytes, 100); assert.equal(old.beforeBytes, null); assert.equal(old.direction, 'unknown');
});

test('rename keeps identity, duplicate records count once, and a re-added path starts fresh', () => {
  const model = buildModel(fixture([
    { sha: 'edit', files: [change('src/a')] },
    { sha: 'rename', files: [change('lib/a', 'renamed', { previousPath: 'src/a' })] },
    { sha: 'delete', files: [change('lib/a', 'removed')] },
    { sha: 'readd', files: [change('lib/a', 'added')] },
  ], [[['src/a', 10]], [['src/a', 20]], [['lib/a', 20]], [], [['lib/a', 5]]]));
  model.commits[1].changes.push({ ...model.commits[1].changes[0] });
  const history = buildRootAttentionHistory(model);
  const edited = byPath(rootAttentionAt(history, 0), 'src/a'), renamed = byPath(rootAttentionAt(history, 1), 'lib/a');
  assert.equal(edited.id, renamed.id); assert.equal(renamed.direction, 'same'); assert.equal(renamed.touchCount, 2);
  assert.equal(history.frames[1].files.length, 1);
  const deleted = rootAttentionAt(history, 2).files.get(edited.id);
  assert.equal(deleted.direction, 'unknown'); assert.equal(deleted.afterBytes, null);
  assert.equal(stateAt(model, 2).activeIds.length, 0, 'removal does not create a current root');
  const newId = stateAt(model, 3).activeIds[0], readded = rootAttentionAt(history, 3).files.get(newId);
  assert.notEqual(readded.id, edited.id); assert.equal(readded.touchCount, 1); assert.equal(readded.deltaBytes, 5);
});

test('rewinding, repeated reads, mutation and future commits cannot alter earlier attention', () => {
  const commits = [{ sha: 'first', files: [change('a')] }, { sha: 'future', files: [change('a')] }];
  const trees = [[['a', 10]], [['a', 20]], [['a', 5]]];
  const model = buildModel(fixture(commits, trees)), history = buildRootAttentionHistory(model);
  const original = rootAttentionAt(history, 0), head = rootAttentionAt(history, 1);
  assert.ok(Object.isFrozen(history.frames[0].files[0]));
  original.files.clear(); original.touchedFiles.clear();
  assert.equal(byPath(rootAttentionAt(history, 0), 'a').deltaBytes, 10);
  assert.deepEqual(rootAttentionAt(history, 1), head);
  const prefix = buildRootAttentionHistory(buildModel(fixture(commits.slice(0, 1), trees.slice(0, 2))));
  assert.deepEqual(rootAttentionAt(prefix, 0).files, rootAttentionAt(history, 0).files);
  assert.equal(rootAttentionAt(history, -100).files.size, 0);
  assert.equal(rootAttentionAt(history, NaN).index, -1);
  assert.equal(rootAttentionAt(history, 100).index, 1);
  assert.equal(rootAttentionAt(history, .9).index, 0);
});

test('folders compare net totals including nested, unchanged and hidden files once per commit', () => {
  const model = buildModel(fixture([
    { sha: 'offset', files: [change('src/a'), change('src/deep/b'), change('src/.cache/data')] },
    { sha: 'elsewhere', files: [change('other/q')] },
  ], [
    [['src/a', 100], ['src/deep/b', 20], ['src/.cache/data', 30], ['src/quiet', 50], ['other/q', 5]],
    [['src/a', 120], ['src/deep/b', 5], ['src/.cache/data', 25], ['src/quiet', 50], ['other/q', 5]],
    [['src/a', 120], ['src/deep/b', 5], ['src/.cache/data', 25], ['src/quiet', 50], ['other/q', 8]],
  ]));
  model.commits[0].changes.push({ ...model.commits[0].changes[0] });
  const history = buildRootAttentionHistory(model), first = rootAttentionAt(history, 0), latest = rootAttentionAt(history, 1);
  assert.deepEqual([...first.folders.keys()], ['', 'src', 'src/.cache', 'src/deep']);
  assert.deepEqual([first.folders.get('src').beforeBytes, first.folders.get('src').afterBytes, first.folders.get('src').deltaBytes, first.folders.get('src').direction], [200, 200, 0, 'same']);
  assert.equal(first.folders.get('src/deep').deltaBytes, -15);
  assert.equal(first.folders.get('src/.cache').deltaBytes, -5);
  assert.equal(first.folders.get('').deltaBytes, 0);
  assert.ok([...first.folders.values()].every(folder => folder.touchCount === 1));
  assert.equal(byPath(first, 'src/a').direction, 'increase');
  assert.equal(byPath(first, 'src/deep/b').direction, 'decrease');
  assert.deepEqual(latest.folders.get('src'), first.folders.get('src'));
  assert.deepEqual([...latest.touchedFolders], ['', 'other']);
  assert.equal(latest.folders.get('').touchCount, 2);
  assert.equal(latest.folders.get('').deltaBytes, 3);
});

test('cross-folder moves update both ancestor routes and deletions leave exact empty-folder totals', () => {
  const model = buildModel(fixture([
    { sha: 'move', files: [change('new/deep/a', 'renamed', { previousPath: 'old/deep/a' })] },
    { sha: 'remove', files: [change('new/deep/a', 'removed')] },
    { sha: 'return', files: [change('new/deep/a', 'added')] },
  ], [
    [['old/deep/a', 40], ['old/quiet', 10], ['new/keep', 30]],
    [['new/deep/a', 40], ['old/quiet', 10], ['new/keep', 30]],
    [['old/quiet', 10], ['new/keep', 30]],
    [['new/deep/a', 5], ['old/quiet', 10], ['new/keep', 30]],
  ]));
  const history = buildRootAttentionHistory(model), moved = rootAttentionAt(history, 0), removed = rootAttentionAt(history, 1), restored = rootAttentionAt(history, 2);
  assert.deepEqual([...moved.touchedFolders], ['', 'new', 'new/deep', 'old', 'old/deep']);
  for (const path of ['old', 'old/deep']) assert.equal(moved.folders.get(path).deltaBytes, -40);
  for (const path of ['new', 'new/deep']) assert.equal(moved.folders.get(path).deltaBytes, 40);
  assert.equal(moved.folders.get('').direction, 'same');
  assert.equal(moved.folders.get('').touchCount, 1);
  assert.equal(moved.folders.get('old/deep').afterBytes, 0);
  assert.equal(moved.folders.get('new/deep').beforeBytes, 0);
  assert.equal(removed.folders.get('new/deep').afterBytes, 0);
  assert.equal(removed.folders.get('new/deep').direction, 'decrease');
  assert.equal(removed.folders.get('').deltaBytes, -40);
  assert.equal(restored.folders.get('new/deep').deltaBytes, 5);
  assert.equal(restored.folders.get('new/deep').touchCount, 3);
  assert.deepEqual(restored.folders.get('old'), moved.folders.get('old'));
  assert.equal(byPath(removed, 'new/deep/a').direction, 'unknown', 'existing removed-file semantics remain unchanged');
});

test('unknown descendants make their totals unknown without poisoning a provably complete sibling subtree', () => {
  const data = fixture([{ sha: 'edit', files: [change('src/a'), change('other/b')] }], [
    [['src/a', 10], ['src/unknown', null], ['other/b', 30]],
    [['src/a', 20], ['src/unknown', null], ['other/b', 31]],
  ]);
  data.provenance = { completeHeadTree: true, completeCommitDiffs: true };
  const state = rootAttentionAt(buildRootAttentionHistory(buildModel(data)), 0);
  for (const path of ['', 'src']) {
    assert.equal(state.folders.get(path).beforeBytes, null);
    assert.equal(state.folders.get(path).afterBytes, null);
    assert.equal(state.folders.get(path).direction, 'unknown');
  }
  assert.deepEqual([state.folders.get('other').beforeBytes, state.folders.get('other').afterBytes, state.folders.get('other').deltaBytes], [30, 31, 1]);
});

test('whole-repository aggregates beyond a selected-path cap do not fabricate subtree totals', () => {
  const data = fixture([{ sha: 'edit', files: [change('src/a')] }], [
    [['src/a', 10], ['src/unmapped', 90]], [['src/a', 20], ['src/unmapped', 100]],
  ]);
  data.files = [{ path: 'src/a', size: 20 }];
  for (const tree of [data.sizeHistory.baseline, ...data.sizeHistory.commits]) tree.files = tree.files.filter(file => file.path === 'src/a');
  const state = rootAttentionAt(buildRootAttentionHistory(buildModel(data)), 0);
  assert.deepEqual([state.folders.get('').beforeBytes, state.folders.get('').afterBytes, state.folders.get('').deltaBytes], [100, 120, 20]);
  assert.equal(state.folders.get('').direction, 'increase');
  assert.equal(state.folders.get('src').beforeBytes, null);
  assert.equal(state.folders.get('src').afterBytes, null);
  assert.equal(state.folders.get('src').direction, 'unknown');
});

test('complete measured trees supply totals even when a partial diff omitted a historical file', () => {
  const data = fixture([{ sha: 'partial', partial: true, files: [change('src/a')] }], [
    [['src/a', 10], ['src/b', 40], ['src/.cache/x', 5]], [['src/a', 20], ['src/b', 10]],
  ]);
  const model = buildModel(data), state = rootAttentionAt(buildRootAttentionHistory(model), 0);
  assert.ok(!model.nodes.some(node => node.path === 'src/.cache/x'));
  assert.deepEqual([state.folders.get('src').beforeBytes, state.folders.get('src').afterBytes, state.folders.get('src').deltaBytes], [55, 30, -25]);
  assert.equal(state.folders.get('src').direction, 'decrease');
  assert.equal(byPath(state, 'src/a').direction, 'increase');
});

test('partial inventories and missing old folders remain unknown rather than claiming zero bytes', () => {
  const data = fixture([{ sha: 'partial', partial: true, files: [change('new/a', 'added')] }], [[], [['new/a', 10]]]);
  data.repository.source = 'github';
  data.sizeHistory.baseline = createSizeSnapshot([], { complete: false });
  const state = rootAttentionAt(buildRootAttentionHistory(buildModel(data)), 0);
  for (const path of ['', 'new']) {
    assert.equal(state.folders.get(path).beforeBytes, null);
    assert.equal(state.folders.get(path).afterBytes, 10);
    assert.equal(state.folders.get(path).direction, 'unknown');
  }
});

test('folder state is immutable, reversible and independent of future commits or caller mutation', () => {
  const commits = [{ sha: 'one', files: [change('src/a')] }, { sha: 'two', files: [change('src/a')] }];
  const trees = [[['src/a', 10]], [['src/a', 20]], [['src/a', 5]]];
  const history = buildRootAttentionHistory(buildModel(fixture(commits, trees)));
  const first = rootAttentionAt(history, 0), latest = rootAttentionAt(history, 1);
  assert.ok(Object.isFrozen(history.frames[0].folders));
  assert.ok(Object.isFrozen(history.frames[0].folders[0]));
  first.folders.clear(); first.touchedFolders.clear();
  assert.equal(rootAttentionAt(history, 0).folders.get('src').deltaBytes, 10);
  assert.deepEqual(rootAttentionAt(history, 1), latest);
  assert.equal(rootAttentionAt(history, -1).folders.size, 0);
  const prefix = buildRootAttentionHistory(buildModel(fixture(commits.slice(0, 1), trees.slice(0, 2))));
  assert.deepEqual(rootAttentionAt(prefix, 0).folders, rootAttentionAt(history, 0).folders);
});
