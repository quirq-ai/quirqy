import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRepository } from './github.js';
import { buildModel, stateAt } from './model.js';

const response = data => ({ ok: true, headers: new Headers(), json: async () => data });
const commit = (sha, parent, tree, files = [{ filename: 'a', status: 'modified', additions: 0, deletions: 0 }]) => ({
  sha, parents: parent ? [{ sha: parent }] : [], files,
  commit: { tree: { sha: tree }, message: sha, author: { name: 'Example' } },
});
const tree = size => ({ tree: [{ path: 'a', type: 'blob', size }], truncated: false });

test('historical byte intake caches identical trees, reuses head and limits tree concurrency to two', async t => {
  const commits = { main: commit('c4', 'c3', 'D'), c3: commit('c3', 'c2', 'C'), c2: commit('c2', 'c1', 'C'), c1: commit('c1', 'c0', 'B') };
  const sizes = { A: 100, B: 200, C: 200, D: 50 };
  const calls = [], active = { count: 0, max: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.credentials, 'omit');
    if (url.endsWith('/repos/example/repo')) return response({ default_branch: 'main' });
    if (url.includes('/git/commits/')) return response({ tree: { sha: 'A' } });
    if (url.includes('/git/trees/')) {
      active.count++; active.max = Math.max(active.max, active.count);
      await new Promise(resolve => setTimeout(resolve, 5));
      active.count--;
      return response(tree(sizes[new URL(url).pathname.split('/').at(-1)]));
    }
    return response(commits[new URL(url).pathname.split('/').at(-1)]);
  });
  const data = await loadRepository('https://github.com/example/repo', { limit: 4 });
  assert.equal(active.max, 2);
  assert.equal(calls.filter(url => url.includes('/git/trees/')).length, 4);
  assert.equal(calls.filter(url => url.includes('/git/trees/D')).length, 1);
  assert.equal(calls.filter(url => url.includes('/git/trees/C')).length, 1);
  assert.equal(data.sizeHistory.version, 1);
  assert.deepEqual([data.sizeHistory.baseline, ...data.sizeHistory.commits].map(snapshot => snapshot.totalBytes), [100, 200, 200, 200, 50]);
  const model = buildModel(data);
  assert.deepEqual([-1, 0, 1, 2, 3].map(index => stateAt(model, index).files[0].size), [100, 200, 200, 200, 50]);
  assert.equal(data.sizeHistory.baseline.sha, 'c0');
});

test('repository byte totals include entries omitted by the 2500-path display limit', async t => {
  const all = Array.from({ length: 2501 }, (_, index) => ({ type: 'blob', path: `file${index}`, size: index + 1 }));
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/repos/example/repo')) return response({ default_branch: 'main' });
    if (url.includes('/git/trees/')) return response({ tree: all, truncated: false });
    return response(commit('head', null, 'head-tree', []));
  });
  const data = await loadRepository('https://github.com/example/repo', { limit: 1 });
  const snapshot = data.sizeHistory.commits[0];
  assert.equal(data.files.length, 2500);
  assert.equal(snapshot.files.length, 2500);
  assert.equal(snapshot.fileCount, 2501);
  assert.equal(snapshot.totalBytes, 2501 * 2502 / 2);
  assert.equal(snapshot.complete, true);
  assert.equal(stateAt(buildModel(data), 0).sizeSummary.totalBytes, snapshot.totalBytes);
});

test('truncated historical trees and submodules remain explicitly partial', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/repos/example/repo')) return response({ default_branch: 'main' });
    if (url.includes('/git/commits/')) return response({ tree: { sha: 'old' } });
    if (url.includes('/git/trees/old')) return response({ tree: [{ path: 'a', type: 'blob', size: 10 }], truncated: true });
    if (url.includes('/git/trees/')) return response({ tree: [{ path: 'a', type: 'blob', size: 20 }, { path: 'sub', type: 'commit' }], truncated: false });
    return response(commit('head', 'parent', 'head-tree'));
  });
  const data = await loadRepository('https://github.com/example/repo', { limit: 1 });
  assert.equal(data.sizeHistory.baseline.complete, false);
  assert.equal(data.sizeHistory.baseline.totalBytes, null);
  assert.equal(data.sizeHistory.baseline.knownBytes, 10);
  assert.equal(data.sizeHistory.commits[0].unknownFiles, 1);
  assert.equal(data.sizeHistory.commits[0].totalBytes, null);
  assert.match(data.coverage.label, /partial coverage/);
});

test('cancelling during historical measurement rejects without returning head-only byte data', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.signal, controller.signal);
    if (url.endsWith('/repos/example/repo')) return response({ default_branch: 'main' });
    if (url.includes('/git/commits/')) return response({ tree: { sha: 'old' } });
    if (url.includes('/git/trees/old')) {
      controller.abort();
      throw new DOMException('Cancelled', 'AbortError');
    }
    if (url.includes('/git/trees/')) return response(tree(20));
    return response(commit('head', 'parent', 'head-tree'));
  });
  await assert.rejects(loadRepository('https://github.com/example/repo', { limit: 1, signal: controller.signal }), { name: 'AbortError' });
});
