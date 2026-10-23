import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReadme, loadRepositoryDetails, MAX_README_BYTES } from './readme.js';

const repository = { full_name: 'owner/repo', name: 'repo', default_branch: 'feature/docs', description: 'Repository description' };
const content = (text = '# Read me', extra = {}) => ({ type: 'file', path: 'docs/README.md', sha: 'blob123', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text), ...extra });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => data });
const fetchPair = (data, extra = {}) => async url => url.includes('/readme?') ? response(data, extra.status || 200) : response(repository);

test('README loads the default branch without credentials and decodes Unicode accurately', async () => {
  const calls = [];
  const progress = [];
  const markdown = '# Welcome 🌏\n\nසිංහල, 日本語, café.';
  const result = await loadReadme('https://github.com/owner/repo.git', {
    fetcher: async (url, options) => {
      calls.push(url);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Accept, 'application/vnd.github+json');
      assert.equal(options.headers.Authorization, undefined);
      return response(url.includes('/readme?') ? content(markdown) : repository);
    },
    onProgress: text => progress.push(text),
  });
  assert.deepEqual(calls, ['https://api.github.com/repos/owner/repo', 'https://api.github.com/repos/owner/repo/readme?ref=feature%2Fdocs']);
  assert.equal(result.markdown, markdown);
  assert.equal(result.htmlUrl, 'https://github.com/owner/repo/blob/feature%2Fdocs/docs/README.md');
  assert.equal(result.path, 'docs/README.md');
  assert.equal(result.sha, 'blob123');
  assert.equal(result.repository.description, repository.description);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.equal(progress.length, 2);
});

test('README honors canonical repository renames, validates paths and ignores arbitrary API html URLs', async () => {
  const result = await loadReadme('https://github.com/old/project', { fetcher: fetchPair(content('ok', { html_url: 'javascript:alert(1)', path: '.github/README file.md' })) });
  assert.equal(result.repository.fullName, 'owner/repo');
  assert.equal(result.htmlUrl, 'https://github.com/owner/repo/blob/feature%2Fdocs/.github/README%20file.md');
  for (const path of ['../README.md', '/README.md', 'docs//README.md', 'docs\\README.md']) {
    await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: fetchPair(content('ok', { path })) }), /invalid README path/);
  }
});

test('README errors distinguish missing repository, missing README, rate limits and network errors', async () => {
  await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: async () => response({}, 404) }), /Repository not found/);
  await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: fetchPair({}, { status: 404 }) }), /does not have a README/);
  for (const status of [403, 429]) {
    await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: async () => response({}, status) }), /limited or denied/);
  }
  await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: async () => { throw new TypeError('Failed to fetch'); } }), /could not be reached/);
  await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: async () => response({}, 409) }), /empty/);
});

test('README bounds encoded and decoded content, including misleading size metadata', async () => {
  for (const data of [content('small', { size: MAX_README_BYTES + 1 }), content('x'.repeat(MAX_README_BYTES + 1), { size: 1 })]) {
    await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: fetchPair(data) }), /too large/);
  }
  const oversized = new Response('x'.repeat(MAX_README_BYTES * 2 + 1));
  await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: async () => oversized }), /too large/);
});

test('README rejects invalid encoding, UTF-8, and unusable API bodies', async () => {
  await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: fetchPair(content('', { encoding: 'none' })) }), /readable README/);
  await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: fetchPair(content('', { content: '%%%bad' })) }), /invalid README content/);
  await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: fetchPair(content('', { content: '/w==' })) }), /UTF-8/);
  await assert.rejects(loadReadme('https://github.com/owner/repo', { fetcher: async () => ({ ...response({}), json: () => { throw new Error('bad JSON'); } }) }), /unreadable/);
});

test('README cancellation is immediate even when a custom fetcher ignores AbortSignal', async () => {
  const controller = new AbortController();
  const promise = loadReadme('https://github.com/owner/repo', { signal: controller.signal, fetcher: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  let called = false;
  await assert.rejects(loadReadme('https://github.com/owner/repo', { signal: controller.signal, fetcher: () => { called = true; } }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('README does not publish a late body response after cancellation', async () => {
  const controller = new AbortController();
  let resolveBody;
  let reachedBody;
  const reading = new Promise(resolve => { reachedBody = resolve; });
  const promise = loadReadme('https://github.com/owner/repo', {
    signal: controller.signal,
    fetcher: async url => url.includes('/readme?')
      ? { ...response({}), json: () => { reachedBody(); return new Promise(resolve => { resolveBody = resolve; }); } }
      : response(repository),
  });
  await reading;
  controller.abort();
  resolveBody(content('stale'));
  await assert.rejects(promise, { name: 'AbortError' });
});

test('README accepts a valid empty file and reads streamed JSON', async () => {
  const result = await loadReadme('https://github.com/owner/repo', {
    fetcher: async url => new Response(JSON.stringify(url.includes('/readme?') ? content('') : repository)),
  });
  assert.equal(result.markdown, '');
});

test('README metadata maps GitHub stars and forks without replacing unknown values with zero', async () => {
  const cases = [
    [{ stargazers_count: 0, forks_count: 0 }, [0, 0]],
    [{ stargazers_count: 1234567, forks_count: 42 }, [1234567, 42]],
    [{ watchers_count: 999, forks: 888 }, [null, null]],
    [{ stargazers_count: null, forks_count: '4' }, [null, null]],
    [{ stargazers_count: -1, forks_count: 2.5 }, [null, null]],
    [{ stargazers_count: true, forks_count: Number.MAX_SAFE_INTEGER + 1 }, [null, null]],
    [{ stargazers_count: 26 }, [26, null]],
  ];
  for (const [counts, expected] of cases) {
    const result = await loadReadme('https://github.com/owner/repo', {
      fetcher: async url => response(url.includes('/readme?') ? content() : { ...repository, ...counts }),
    });
    assert.deepEqual([result.repository.stars, result.repository.forks], expected);
    assert.ok(Number.isFinite(Date.parse(result.repository.statsFetchedAt)));
    assert.ok(Date.parse(result.repository.statsFetchedAt) <= Date.parse(result.fetchedAt));
    assert.equal(result.markdown, '# Read me');
  }
});

test('legacy repository detail hydration makes one safe metadata request without downloading a README', async () => {
  const calls = [];
  const controller = new AbortController();
  const result = await loadRepositoryDetails('https://github.com/owner/repo.git', {
    signal: controller.signal,
    fetcher: async (url, options) => {
      calls.push(url);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.headers.Accept, 'application/vnd.github+json');
      assert.equal(options.headers.Authorization, undefined);
      return response({ stargazers_count: 0, forks_count: 42, homepage: 'example.com/project' });
    },
  });
  assert.deepEqual(calls, ['https://api.github.com/repos/owner/repo']);
  assert.deepEqual([result.stars, result.forks], [0, 42]);
  assert.deepEqual(Object.keys(result).sort(), ['forks', 'homepage', 'stars', 'statsFetchedAt']);
  assert.equal(result.homepage, 'https://example.com/project');
  assert.ok(Number.isFinite(Date.parse(result.statsFetchedAt)));
  const unknown = await loadRepositoryDetails('https://github.com/owner/repo', {
    fetcher: async () => response({ stargazers_count: '0', forks_count: -1 }),
  });
  assert.deepEqual([unknown.stars, unknown.forks], [null, null]);
  assert.equal(unknown.homepage, null);
});

test('legacy repository detail hydration propagates failed or cancelled requests without a fabricated result', async () => {
  await assert.rejects(loadRepositoryDetails('https://github.com/owner/repo', {
    fetcher: async () => response({}, 403),
  }), /limited or denied/);
  const controller = new AbortController();
  const pending = loadRepositoryDetails('https://github.com/owner/repo', {
    signal: controller.signal, fetcher: () => new Promise(() => {}),
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});


test('live README and metadata-only hydration share safe normalized GitHub homepage values', async () => {
  for (const [homepage, expected] of [
    ['https://example.com/docs', 'https://example.com/docs'],
    ['example.com', 'https://example.com/'],
    [undefined, null], [null, null], ['', null],
    ['javascript:alert(1)', null], ['https://user:pass@example.com', null],
  ]) {
    const metadata = { ...repository, homepage, stargazers_count: 26, forks_count: 4 };
    const fetcher = async address => response(address.includes('/readme?') ? content() : metadata);
    const loaded = await loadReadme('https://github.com/owner/repo', { fetcher });
    const details = await loadRepositoryDetails('https://github.com/owner/repo', { fetcher });
    assert.equal(loaded.repository.homepage, expected);
    assert.equal(details.homepage, expected);
    assert.deepEqual([details.stars, details.forks], [26, 4]);
    assert.equal(loaded.markdown, '# Read me');
  }
});
