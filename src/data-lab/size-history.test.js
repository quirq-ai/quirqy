import test from 'node:test';
import assert from 'node:assert/strict';
import { createSizeSnapshot, fileBytes } from './size-history.js';
import { buildModel, stateAt } from './model.js';

const tree = (sha, entries, options) => createSizeSnapshot(entries.map(([path, size]) => ({ path, size })), { sha, ...options });
const change = (path, status = 'modified', extra = {}) => ({ path, status, additions: 0, deletions: 0, ...extra });
const commit = (sha, files) => ({ sha, files });
const bytes = frame => Object.fromEntries(frame.files.filter(file => file.exists).map(file => [file.path, file.size]));
const dataset = (files, commits, snapshots) => ({
  repository: { name: 'bytes' }, files: files.map(([path, size]) => ({ path, size })), commits,
  ...(snapshots ? { sizeHistory: { version: 1, baseline: snapshots[0], commits: snapshots.slice(1) } } : {}),
});

test('snapshot totals cover the whole tree before the display path selection', () => {
  const snapshot = createSizeSnapshot([{ path: 'a', size: 0 }, { path: 'b', size: 120 }, { path: 'c', size: 350 }], { selectedPaths: new Set(['a']) });
  assert.deepEqual(snapshot.files, [{ path: 'a', size: 0 }]);
  assert.equal(snapshot.totalBytes, 470);
  assert.equal(snapshot.fileCount, 3);
  assert.equal(snapshot.knownFiles, 3);
  assert.equal(snapshot.complete, true);
  for (const invalid of [null, undefined, -1, NaN, Infinity, '100', 1.5]) assert.equal(fileBytes(invalid), null);
  assert.equal(fileBytes(0), 0);
});

test('submodules and truncated trees retain known bytes without inventing a full total', () => {
  const entries = [{ path: 'text', size: 12 }, { path: 'empty', size: 0 }, { path: 'submodule', type: 'commit', size: 999 }];
  const snapshot = createSizeSnapshot(entries);
  assert.equal(snapshot.files[2].size, 12); // lexical order: empty, submodule, text
  assert.equal(snapshot.files.find(file => file.path === 'submodule').size, null);
  assert.equal(snapshot.totalBytes, null);
  assert.equal(snapshot.knownBytes, 12);
  assert.equal(snapshot.unknownFiles, 1);
  assert.equal(snapshot.complete, false);
  const truncated = createSizeSnapshot(entries.slice(0, 2), { complete: false });
  assert.equal(truncated.totalBytes, null);
  assert.equal(truncated.knownBytes, 12);
  assert.equal(truncated.unknownFiles, 0);
  assert.equal(truncated.complete, false);
});

test('replay measures growth, unchanged bytes and shrink independently of diff line activity', () => {
  const data = dataset([['a', 60], ['quiet', 40]], [
    commit('grow', [change('a', 'modified', { additions: 100 })]),
    commit('same', [change('a', 'modified', { additions: 50, deletions: 50 })]),
    commit('shrink', [change('a', 'modified', { deletions: 1 })]),
  ], [tree('baseline', [['a', 100], ['quiet', 40]]), tree('grow', [['a', 200], ['quiet', 40]]), tree('same', [['a', 200], ['quiet', 40]]), tree('shrink', [['a', 60], ['quiet', 40]])]);
  const original = JSON.stringify(data), model = buildModel(data);
  assert.deepEqual([-1, 0, 1, 2].map(index => stateAt(model, index).sizeSummary.totalBytes), [140, 240, 240, 100]);
  assert.deepEqual([-1, 0, 1, 2].map(index => bytes(stateAt(model, index)).a), [100, 200, 200, 60]);
  assert.deepEqual(bytes(stateAt(model, 0)), { a: 200, quiet: 40 });
  assert.deepEqual(bytes(stateAt(model, -1)), { a: 100, quiet: 40 });
  assert.equal(JSON.stringify(data), original);
});

test('binary changes, same-byte renames, deletion and re-add retain exact size and identity semantics', () => {
  const data = dataset([['new.bin', 10]], [
    commit('binary', [change('old.bin', 'modified', { binary: true })]),
    commit('rename', [change('new.bin', 'renamed', { previousPath: 'old.bin' })]),
    commit('delete', [change('new.bin', 'removed')]),
    commit('readd', [change('new.bin', 'added')]),
  ], [tree(null, [['old.bin', 50]]), tree('binary', [['old.bin', 120]]), tree('rename', [['new.bin', 120]]), tree('delete', []), tree('readd', [['new.bin', 10]])]);
  const model = buildModel(data);
  const before = stateAt(model, 0).files.find(file => file.exists), renamed = stateAt(model, 1).files.find(file => file.exists), after = stateAt(model, 3).files.find(file => file.exists);
  assert.equal(before.id, renamed.id);
  assert.equal(before.size, 120);
  assert.equal(renamed.size, 120);
  assert.notEqual(before.id, after.id);
  assert.equal(after.size, 10);
  assert.equal(stateAt(model, 2).sizeSummary.totalBytes, 0);
  assert.ok(stateAt(model, 2).files.every(file => file.size === null));
  assert.equal(stateAt(model, -1).sizeSummary.totalBytes, 50);
});

test('partial diff listings cannot leave changed files with stale bytes when tree snapshots exist', () => {
  const data = dataset([['a', 90], ['b', 300]], [{ ...commit('partial', [change('a')]), partial: true }], [
    tree(null, [['a', 100], ['b', 100]]), tree('partial', [['a', 90], ['b', 300]]),
  ]);
  const model = buildModel(data);
  assert.deepEqual(bytes(stateAt(model, -1)), { a: 100, b: 100 });
  assert.deepEqual(bytes(stateAt(model, 0)), { a: 90, b: 300 });
  assert.equal(stateAt(model, 0).sizeSummary.totalBytes, 390);
  assert.equal(stateAt(model, 0).sizeSummary.complete, true);
});

test('legacy head bytes do not leak backwards across unknown edits, and explicit old bytes restore knowledge', () => {
  const data = dataset([['edited', 300], ['quiet', 40]], [commit('first', [change('edited')]), commit('last', [change('edited')])]);
  data.repository.source = 'github';
  const model = buildModel(data);
  assert.equal(bytes(stateAt(model, 1)).edited, 300);
  assert.equal(bytes(stateAt(model, 0)).edited, null);
  assert.equal(bytes(stateAt(model, -1)).edited, null);
  assert.equal(bytes(stateAt(model, -1)).quiet, 40);
  assert.deepEqual(stateAt(model, -1).sizeSummary, { totalBytes: null, knownBytes: 40, fileCount: 2, knownFiles: 1, unknownFiles: 1, complete: false });
  assert.ok(model.coverage.limitations.some(note => note.includes('Reload the repository')));
  const measured = dataset([['edited', 300]], [commit('first', [change('edited', 'modified', { sizeBefore: 0, sizeAfter: 200 })]), commit('last', [change('edited', 'modified', { sizeBefore: 200, sizeAfter: 300 })])]);
  assert.deepEqual([-1, 0, 1].map(index => bytes(stateAt(buildModel(measured), index)).edited), [0, 200, 300]);
});

test('partial tree snapshots report incomplete totals and missing file sizes stay unknown', () => {
  const data = dataset([['known', 0], ['unreturned', 200]], [commit('head', [])], [
    tree(null, [['known', 0]], { complete: false }), tree('head', [['known', 0]], { complete: false }),
  ]);
  const frame = stateAt(buildModel(data), 0);
  assert.equal(frame.sizeSummary.totalBytes, null);
  assert.equal(frame.sizeSummary.knownBytes, 0);
  assert.equal(frame.sizeSummary.complete, false);
  assert.deepEqual(bytes(frame), { known: 0, unreturned: null });
});


test('legacy URL imports cannot claim whole-repository totals without full-tree evidence', () => {
  const data = dataset([['retained.js', 300]], [commit('head', [])]);
  data.repository.source = 'github';
  const partial = stateAt(buildModel(data), 0);
  assert.equal(partial.files[0].size, 300);
  assert.equal(partial.sizeSummary.knownBytes, 300);
  assert.equal(partial.sizeSummary.totalBytes, null);
  assert.equal(partial.sizeSummary.complete, false);
  data.provenance = { completeHeadTree: true };
  assert.equal(stateAt(buildModel(data), 0).sizeSummary.totalBytes, 300);
});
