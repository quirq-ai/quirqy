import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, stateAt, activityInsights } from './model.js';
import { createRepositoryFixture } from './test-fixtures/repository.js';
import { loadRepository, parseRepositoryUrl } from './github.js';

const repository = { name: 'sample', fullName: 'example/sample', source: 'demo', headSha: 'c3' };
const file = (path, status, extra = {}) => ({ path, status, additions: 1, deletions: 0, ...extra });
const commit = (sha, files) => ({ sha, message: sha, author: 'Example', date: '', url: '', files });
const dataset = (files, commits) => ({ repository, files, commits, coverage: { label: 'Test', limitations: [] } });
const pathsAt = (model, index) => stateAt(model, index).files.filter(file => file.exists).map(file => file.path).sort();

 test('demo replay preserves the baseline and reaches exactly the pinned head', () => {
  const data = createRepositoryFixture();
  const original = JSON.stringify(data);
  const model = buildModel(data);
  assert.equal(data.repository.source, 'demo');
  assert.equal(data.commits.length, 22);
  assert.equal(model.directories.length, 6);
  assert.equal(stateAt(model, -1).summary.activeFiles, 48);
  assert.deepEqual(pathsAt(model, 21), data.files.filter(file => file.existsAtHead).map(file => file.path).sort());
  assert.equal(stateAt(model, 21).summary.activeFiles, 53);
  assert.equal(JSON.stringify(data), original, 'building/replaying must not mutate source data');
  const initial = stateAt(model, -1).files.find(file => file.path === 'engine/sampler.js');
  const renamed = stateAt(model, 10).files.find(file => file.path === 'engine/trajectory.js' && file.exists);
  assert.equal(initial.id, renamed.id);
  assert.equal(renamed.status, 'renamed');
  assert.ok(activityInsights(model, 10).some(text => text.includes('node identity')));
  assert.deepEqual(buildModel(createRepositoryFixture()).nodes, model.nodes);
});

 test('rename chains preserve identity, while remove and re-add create a new identity', () => {
  const data = dataset([
    { path: 'src/c.js', existsAtHead: true },
    { path: 'src/a.js', existsAtHead: false },
    { path: 'src/b.js', existsAtHead: false },
    { path: 'notes.md', existsAtHead: true },
  ], [
    commit('1', [file('src/b.js', 'renamed', { previousPath: 'src/a.js' })]),
    commit('2', [file('notes.md', 'removed')]),
    commit('3', [file('src/c.js', 'renamed', { previousPath: 'src/b.js' }), file('notes.md', 'added')]),
  ]);
  const model = buildModel(data);
  const before = stateAt(model, -1).files.find(file => file.exists && file.path === 'src/a.js');
  const after = stateAt(model, 2).files.find(file => file.exists && file.path === 'src/c.js');
  assert.equal(before.id, after.id);
  const oldNote = stateAt(model, -1).files.find(file => file.exists && file.path === 'notes.md');
  const newNote = stateAt(model, 2).files.find(file => file.exists && file.path === 'notes.md');
  assert.notEqual(oldNote.id, newNote.id);
  assert.equal(pathsAt(model, 1).includes('notes.md'), false);
  assert.deepEqual(pathsAt(model, 0), ['notes.md', 'src/b.js']);
});

 test('copied files receive distinct identities and cursor bounds are safe', () => {
  const model = buildModel(dataset([{ path: 'a' }, { path: 'b' }], [commit('1', [file('b', 'copied', { previousPath: 'a' })])]));
  assert.deepEqual(pathsAt(model, -100), ['a']);
  assert.deepEqual(pathsAt(model, 100), ['a', 'b']);
  assert.equal(stateAt(model, 0).summary.addedFiles, 1);
  assert.equal(model.nodes.length, 2);
});

 test('repository URL parser accepts only an HTTPS GitHub repository root', () => {
  assert.deepEqual(parseRepositoryUrl(' https://github.com/OpenAI/example.git/ '), { owner: 'OpenAI', repo: 'example', fullName: 'OpenAI/example', url: 'https://github.com/OpenAI/example' });
  for (const value of ['http://github.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com.evil/a/b', 'https://github.com/a/b?q=x', 'https://github.com/a/b#main', 'https://user@github.com/a/b', 'https://github.com/a/..', 'https://github.com/a%2fb/c', 'https://github.com:444/a/b']) {
    assert.throws(() => parseRepositoryUrl(value), undefined, value);
  }
});

function mockResponse(data, { status = 200, headers = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => data };
}
function apiCommit(sha, parents, files) {
  return { sha, parents: parents.map(sha => ({ sha })), commit: { tree: { sha: `tree-${sha}` }, message: sha, author: { name: 'Example', date: '2026-01-01T00:00:00Z' } }, files };
}

 test('GitHub intake pins the tree and walks only the first parent, with explicit merge comparison', async t => {
  const calls = [];
  const responses = new Map([
    ['/repos/example/sample', { default_branch: 'main', name: 'sample', full_name: 'example/sample' }],
    ['/repos/example/sample/commits/main?per_page=100&page=1', apiCommit('merge', ['first', 'side'], [])],
    ['/repos/example/sample/git/trees/tree-merge?recursive=1', { tree: [{ type: 'blob', path: 'a' }, { type: 'blob', path: 'b' }], truncated: false }],
    ['/repos/example/sample/git/trees/tree-first?recursive=1', { tree: [{ type: 'blob', path: 'a' }], truncated: false }],
    ['/repos/example/sample/compare/first...merge?per_page=1', { files: [{ filename: 'b', status: 'added', additions: 4, deletions: 0 }] }],
    ['/repos/example/sample/commits/first?per_page=100&page=1', apiCommit('first', [], [{ filename: 'a', status: 'added', additions: 2, deletions: 0 }])],
  ]);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(path);
    assert.equal(options.credentials, 'omit');
    assert.ok(responses.has(path), path);
    return mockResponse(responses.get(path));
  });
  const data = await loadRepository('https://github.com/example/sample');
  assert.equal(data.repository.headSha, 'merge');
  assert.deepEqual(data.commits.map(commit => commit.sha), ['first', 'merge']);
  assert.ok(data.commits[1].isMerge);
  assert.ok(!calls.some(path => path.includes('/commits/side')));
  const model = buildModel(data);
  assert.deepEqual(pathsAt(model, -1), []);
  assert.deepEqual(pathsAt(model, 0), ['a']);
  assert.deepEqual(pathsAt(model, 1), ['a', 'b']);
});

test('URL imports default to 20 commits and preserve smaller explicit windows', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (url.endsWith('/repos/example/sample')) return mockResponse({ default_branch: 'main' });
    if (url.includes('/git/trees/')) return mockResponse({ tree: [{ type: 'blob', path: 'a.js' }], truncated: false });
    const ref = new URL(url).pathname.split('/').at(-1);
    if (url.includes('/git/commits/')) return mockResponse({ tree: { sha: `tree-${ref}` } });
    const index = ref === 'main' ? 50 : Number(ref.slice(1));
    assert.ok(index > 0 && index <= 50, `Unexpected commit reference: ${ref}`);
    return mockResponse(apiCommit(`c${index}`, [`c${index - 1}`], [
      { filename: 'a.js', status: 'modified', additions: 1, deletions: 1 },
    ]));
  });
  for (const [options, expected] of [[undefined, 20], [{ limit: 12 }, 12], [{ limit: 50 }, 20]]) {
    calls.length = 0;
    const data = await loadRepository('https://github.com/example/sample', options);
    assert.equal(data.commits.length, expected);
    assert.equal(calls.filter(url => url.includes('/sample/commits/')).length, expected);
    assert.equal(data.commits[0].sha, `c${51 - expected}`);
    assert.equal(data.commits.at(-1).sha, 'c50');
    assert.equal(data.repository.headSha, 'c50');
    assert.equal(calls.length, expected * 2 + 3, 'metadata, selected commits, unique trees and boundary metadata are fetched');
  }
});

 test('commit file pagination includes page two without falsely labelling a complete 200-file diff', async t => {
  const all = Array.from({ length: 200 }, (_, i) => ({ filename: `file-${i}`, status: 'added', additions: 1, deletions: 0 }));
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/repos/example/sample')) return mockResponse({ default_branch: 'main' });
    if (url.includes('/git/trees/')) return mockResponse({ tree: all.map(file => ({ type: 'blob', path: file.filename })), truncated: false });
    if (url.includes('page=2')) return mockResponse(apiCommit('head', [], all.slice(100)));
    return mockResponse(apiCommit('head', [], all.slice(0, 100)), { headers: { link: '<https://api.github.com/next>; rel="next"' } });
  });
  const data = await loadRepository('https://github.com/example/sample', { limit: 1 });
  assert.equal(data.commits[0].files.length, 200);
  assert.equal(data.commits[0].partial, false);
  assert.deepEqual(pathsAt(buildModel(data), -1), []);
});

 test('rate limits and cancellation fail visibly rather than returning demo data', async t => {
  t.mock.method(globalThis, 'fetch', async () => mockResponse({}, { status: 403, headers: { 'x-ratelimit-reset': '1900000000' } }));
  await assert.rejects(loadRepository('https://github.com/example/sample'), /limited or denied/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadRepository('https://github.com/example/sample', { signal: controller.signal }), { name: 'AbortError' });
});

 test('bounded diagram prioritizes changed paths and labels omitted tree coverage', async t => {
  const tree = Array.from({ length: 2500 }, (_, i) => ({ type: 'blob', path: `a/${String(i).padStart(4, '0')}` }));
  tree.push({ type: 'blob', path: 'z/changed.js' });
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/repos/example/sample')) return mockResponse({ default_branch: 'main' });
    if (url.includes('/git/trees/')) return mockResponse({ tree, truncated: false });
    if (url.includes('/git/commits/')) return mockResponse({ tree: { sha: 'tree-parent' } });
    return mockResponse(apiCommit('head', ['parent'], [{ filename: 'z/changed.js', status: 'modified', additions: 4, deletions: 2 }]));
  });
  const data = await loadRepository('https://github.com/example/sample', { limit: 1 });
  assert.equal(data.files.length, 2500);
  assert.ok(data.files.some(file => file.path === 'z/changed.js'));
  assert.match(data.coverage.label, /partial coverage/);
  assert.equal(stateAt(buildModel(data), 0).summary.changedFiles, 1);
});

 test('diff pages beyond the bounded second page are explicitly partial', async t => {
  const all = Array.from({ length: 200 }, (_, i) => ({ filename: `f${i}`, status: 'added', additions: 1, deletions: 0 }));
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/repos/example/sample')) return mockResponse({ default_branch: 'main' });
    if (url.includes('/git/trees/')) return mockResponse({ tree: all.map(file => ({ type: 'blob', path: file.filename })), truncated: true });
    return mockResponse(apiCommit('head', [], all.slice(url.includes('page=2') ? 100 : 0, url.includes('page=2') ? 200 : 100)), { headers: { link: '<https://api.github.com/next>; rel="next"' } });
  });
  const data = await loadRepository('https://github.com/example/sample', { limit: 1 });
  assert.equal(data.commits[0].files.length, 200);
  assert.equal(data.commits[0].partial, true);
  assert.match(data.coverage.label, /partial coverage/);
  assert.ok(data.coverage.limitations.some(text => text.includes('truncated')));
});
