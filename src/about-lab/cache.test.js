import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReadme } from './readme.js';
import { readCachedReadme } from './cache.js';
const url = 'https://github.com/example/repo';
const document = { repository: { url, defaultBranch: 'main', description: 'A repository' }, markdown: '# Hello', path: 'docs/README.md', fetchedAt: '2026-10-23T12:00:00Z', htmlUrl: 'https://evil.example/' };
const storage = value => ({ getItem: () => JSON.stringify(value) });
test('saved README URLs and repository identity are reconstructed from the requested repository', () => {
 const saved = readCachedReadme(url, storage(document));
 assert.equal(saved.htmlUrl, url + '/blob/main/docs/README.md');
 assert.equal(saved.repository.fullName, 'example/repo');
 assert.equal(saved.repository.name, 'repo');
 assert.equal(saved.source, 'saved');
 assert.equal(readCachedReadme('https://github.com/example/other', storage(document)), null);
});
test('malformed and oversized UTF-8 caches fall through to fresh loading', () => {
 for (const saved of [null, {...document, markdown:'😀'.repeat(270000)}, {...document, path:'../README.md'}, {...document, fetchedAt:'broken'}, {...document, repository:{url}}]) assert.equal(readCachedReadme(url, storage(saved)), null);
 assert.equal(readCachedReadme(url, {getItem(){throw new Error('blocked')}}), null);
});

test('legacy and malformed cached counts stay unknown while valid README content remains usable', () => {
 const legacy = readCachedReadme(url, storage(document));
 assert.deepEqual([legacy.repository.stars, legacy.repository.forks, legacy.repository.statsFetchedAt], [null, null, null]);
 for (const value of [null, '0', '26', true, false, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, [], {}]) {
  const saved = readCachedReadme(url, storage({ ...document, repository: { ...document.repository, stars: value, forks: value, statsFetchedAt: 'not a timestamp' } }));
  assert.equal(saved.markdown, document.markdown);
  assert.deepEqual([saved.repository.stars, saved.repository.forks, saved.repository.statsFetchedAt], [null, null, null]);
 }
});

test('live GitHub counts and their source timestamp survive the browser cache round trip', async () => {
 for (const [stars, forks] of [[0, 0], [1234567, 42]]) {
  const loaded = await loadReadme(url, { fetcher: async address => ({
   ok: true, status: 200, headers: new Headers(),
   json: async () => address.includes('/readme?')
    ? { type: 'file', path: 'README.md', encoding: 'base64', content: Buffer.from('# Cached').toString('base64') }
    : { full_name: 'example/repo', default_branch: 'main', stargazers_count: stars, forks_count: forks },
  }) });
  const saved = readCachedReadme(url, storage(loaded));
  assert.deepEqual([saved.repository.stars, saved.repository.forks], [stars, forks]);
  assert.equal(saved.repository.statsFetchedAt, loaded.repository.statsFetchedAt);
  assert.equal(saved.fetchedAt, loaded.fetchedAt);
  assert.equal(saved.markdown, loaded.markdown);
 }
});

test('bundled example counts retain their separate verified metadata capture time through cache', () => {
 for (const name of ['xo', 'xo-space']) {
  const snapshot = JSON.parse(readFileSync(new URL(`./examples/${name}.json`, import.meta.url), 'utf8'));
  assert.ok(Number.isSafeInteger(snapshot.repository.stars) && snapshot.repository.stars >= 0);
  assert.ok(Number.isSafeInteger(snapshot.repository.forks) && snapshot.repository.forks >= 0);
  assert.ok(Number.isFinite(Date.parse(snapshot.repository.statsFetchedAt)));
  const saved = readCachedReadme(snapshot.repository.url, storage(snapshot));
  assert.deepEqual([saved.repository.stars, saved.repository.forks], [snapshot.repository.stars, snapshot.repository.forks]);
  assert.equal(saved.repository.statsFetchedAt, snapshot.repository.statsFetchedAt);
  assert.equal(saved.fetchedAt, snapshot.fetchedAt);
  assert.equal(saved.markdown, snapshot.markdown);
 }
});
