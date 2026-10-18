import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { normalizeAuthorProfile } from './author-profile.js';
import { loadRepository } from './github.js';
import { buildModel, stateAt } from './model.js';
import { EXAMPLE_REPOSITORIES, getExampleDataset } from './examples.js';

const apiAuthor = {
  login: 'real-author',
  avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4',
  html_url: 'https://github.com/real-author',
};
const normalizedAuthor = {
  login: 'real-author',
  avatarUrl: apiAuthor.avatar_url,
  url: apiAuthor.html_url,
};

test('author profiles accept GitHub accounts and offline raster avatars without arbitrary image or link URLs', () => {
  assert.deepEqual(normalizeAuthorProfile(apiAuthor), normalizedAuthor);
  assert.deepEqual(normalizeAuthorProfile(normalizedAuthor), normalizedAuthor);
  assert.equal(normalizeAuthorProfile({ login: 'github-actions[bot]' }).login, 'github-actions[bot]');
  assert.equal(normalizeAuthorProfile({ login: 'a', avatarUrl: '/data-lab/authors/a.webp' }).avatarUrl, '/data-lab/authors/a.webp');
  for (const login of ['', 'name with spaces', '../other', 'author/other', '-author', 'author-', 'two--hyphens', 'x'.repeat(40)]) {
    assert.equal(normalizeAuthorProfile({ login }), null, login);
  }
  for (const value of [null, undefined, 'Author Name', { name: 'real-author' }, { login: null }]) {
    assert.equal(normalizeAuthorProfile(value), null);
  }
  for (const avatarUrl of [
    'javascript:alert(1)', 'data:image/svg+xml,test', '//avatars.githubusercontent.com/u/1',
    'http://avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com.evil.test/u/1',
    'https://evil.test/avatar.png', 'https://user@avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com:444/u/1', '/data-lab/authors/../secret.png',
    '/data-lab/authors/author.svg', '/data-lab/authors/avatar.png?redirect=1',
  ]) {
    const profile = normalizeAuthorProfile({ login: 'real-author', avatarUrl, url: 'javascript:alert(1)' });
    assert.equal(profile.avatarUrl, null, avatarUrl);
    assert.equal(profile.url, 'https://github.com/real-author');
  }
});

test('GitHub intake credits the author, never the committer, and preserves unlinked-author fallback through replay', async t => {
  let author = apiAuthor;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    let data;
    if (url.endsWith('/repos/example/sample')) data = { default_branch: 'main' };
    else if (url.includes('/git/trees/')) data = { tree: [], truncated: false };
    else {
      assert.equal(url, 'https://api.github.com/repos/example/sample/commits/main?per_page=100&page=1');
      data = {
        sha: 'head', parents: [], files: [], author,
        committer: { login: 'merge-bot', avatar_url: 'https://avatars.githubusercontent.com/u/999' },
        commit: {
          tree: { sha: 'tree' }, message: 'A contribution',
          author: { name: 'Credited Contributor', date: '2026-01-01T00:00:00Z' },
          committer: { name: 'Merge Bot', date: '2026-01-02T00:00:00Z' },
        },
      };
    }
    return { ok: true, headers: new Headers(), json: async () => data };
  });
  for (const account of [apiAuthor, null, undefined, { name: 'Credited Contributor' }]) {
    author = account;
    calls.length = 0;
    const dataset = await loadRepository('https://github.com/example/sample');
    const expected = account === apiAuthor ? normalizedAuthor : null;
    assert.equal(dataset.commits[0].author, 'Credited Contributor');
    assert.deepEqual(dataset.commits[0].authorProfile, expected);
    assert.equal(calls.length, 3, 'profiles reuse commit metadata without extra API calls');
    const original = JSON.stringify(dataset);
    const frame = stateAt(buildModel(dataset), 0);
    assert.equal(frame.commit.author, 'Credited Contributor');
    assert.deepEqual(frame.commit.authorProfile, expected);
    assert.equal(JSON.stringify(dataset), original);
  }
});

test('bundled author credits match exact verified commit SHAs and all avatars are local assets', () => {
  const mapping = JSON.parse(readFileSync(new URL('./examples/author-profiles.json', import.meta.url), 'utf8'));
  const logins = new Set();
  for (const example of EXAMPLE_REPOSITORIES) {
    const dataset = getExampleDataset(example.url);
    const records = mapping.repositories[dataset.repository.fullName];
    assert.equal(records.headSha, dataset.repository.headSha);
    assert.ok(records.endpoint.startsWith(`https://api.github.com/repos/${dataset.repository.fullName}/commits?sha=${dataset.repository.headSha}`));
    for (const commit of dataset.commits) {
      const login = records.commits[commit.sha];
      assert.ok(login, `Missing verified author for ${commit.sha}`);
      assert.deepEqual(commit.authorProfile, normalizeAuthorProfile(mapping.profiles[login]));
      assert.ok(commit.authorProfile.avatarUrl.startsWith('/data-lab/authors/'));
      assert.ok(existsSync(new URL(`../../public${commit.authorProfile.avatarUrl}`, import.meta.url)), login);
      logins.add(login);
    }
    dataset.commits[0].authorProfile.login = 'modified';
    assert.notEqual(getExampleDataset(example.url).commits[0].authorProfile.login, 'modified');
  }
  assert.equal(logins.size, 7, 'both examples preserve their distinct verified contributors');
});
