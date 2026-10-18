import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommunityModel, filterCommunityItems } from './model.js';
import { loadActivityRepository, normalizeActivityResponses, normalizeCommunityActor, ACTIVITY_LIMITS } from './github.js';
import { getActivityExample, ACTIVITY_EXAMPLES } from './examples.js';

const url = 'https://github.com/owner/repo';
const user = login => ({ login, avatar_url: `https://avatars.githubusercontent.com/u/${login.length}`, html_url: `https://github.com/${login}` });
const envelope = data => ({ data, status: 200, more: false, fetchedAt: '2026-10-19T12:00:00Z', url: 'https://api.github.com/repos/owner/repo' });
function fixture() {
  const pull = { number: 7, title: 'Improve the project', html_url: `${url}/pull/7`, state: 'closed', user: user('alice'), created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-05T10:00:00Z', merged_at: '2026-10-05T10:00:00Z', closed_at: '2026-10-05T10:00:00Z' };
  const issue = { number: 8, title: 'A real issue', html_url: `${url}/issues/8`, state: 'open', user: user('carol'), created_at: '2026-10-02T10:00:00Z', updated_at: '2026-10-06T10:00:00Z' };
  return {
    repository: envelope({ full_name: 'owner/repo', description: 'Public project', stargazers_count: 3, forks_count: 1, open_issues_count: 2 }),
    pulls: envelope([pull]), issues: envelope([{ ...pull, pull_request: { merged_at: pull.merged_at } }, issue]),
    comments: envelope([{ id: 100, body: 'Conversation comment', user: user('bob'), html_url: `${url}/pull/7#issuecomment-100`, issue_url: 'https://api.github.com/repos/owner/repo/issues/7', created_at: '2026-10-03T10:00:00Z', updated_at: '2026-10-03T11:00:00Z' }]),
    reviewComments: envelope([{ id: 101, body: 'Inline comment', user: user('bob'), html_url: `${url}/pull/7#discussion_r101`, pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/7', created_at: '2026-10-04T10:00:00Z' }]),
    'reviews-7': envelope([{ id: 200, body: 'Review body', state: 'DISMISSED', user: user('reviewer[bot]'), html_url: `${url}/pull/7#pullrequestreview-200`, submitted_at: '2026-10-04T09:00:00Z' }]),
    forks: envelope([{ id: 10, full_name: 'frank/repo', html_url: 'https://github.com/frank/repo', owner: user('frank'), created_at: '2026-10-02T12:00:00Z' }]),
    contributors: envelope([{ ...user('alice'), contributions: 42 }]),
    issueEvents: envelope([{ id: 300, event: 'merged', issue: { ...pull, pull_request: {} }, actor: user('bob'), created_at: pull.merged_at }, { id: 301, event: 'reopened', issue, actor: user('carol'), created_at: '2026-10-06T10:00:00Z' }]),
  };
}
const normalized = responses => normalizeActivityResponses(url, responses, { fetchedAt: '2026-10-19T12:00:00Z' });

test('separates PRs from issues and connects actual reviews and both comment kinds to the PR', () => {
  const data = normalized(fixture());
  assert.equal(data.items.filter(item => item.kind === 'pull_request').length, 1);
  assert.equal(data.items.filter(item => item.kind === 'issue').length, 1);
  const children = data.items.filter(item => item.kind === 'review' || item.kind === 'comment');
  assert.equal(children.length, 3);
  assert.ok(children.every(item => item.parentId === 'owner/repo:pull_request:7'));
  assert.deepEqual(new Set(data.items.filter(item => item.kind === 'comment').map(item => item.commentType)), new Set(['conversation', 'inline_review']));
  assert.equal(data.repository.openIssuesIncludesPullRequests, true);
});

test('workflow event actors replace unknown timestamp actors without duplicating a merge', () => {
  const data = normalized(fixture());
  const merges = data.events.filter(event => event.action === 'merged');
  assert.equal(merges.length, 1);
  assert.equal(merges[0].actor.login, 'bob');
  assert.equal(merges[0].date, '2026-10-05T10:00:00.000Z');
  assert.equal(merges[0].provenance, 'GitHub issue event');
  assert.equal(data.events.filter(event => event.action === 'opened').length, 2);
  assert.equal(data.events.some(event => event.action === 'reopened'), true);
});

test('no actors or dates are invented for merges, forks, contributors or dismissed reviews', () => {
  const response = fixture(); response.issueEvents = envelope([]);
  const data = normalized(response);
  assert.equal(data.events.find(event => event.action === 'merged').actor.login, null);
  assert.equal(data.events.find(event => event.action === 'forked').actor.login, null);
  assert.equal(data.events.some(event => event.action === 'dismissed'), false, 'A submitted timestamp does not date a later dismissal.');
  const review = data.items.find(item => item.kind === 'review');
  assert.equal(review.state, 'dismissed');
  assert.equal(data.events.find(event => event.itemId === review.id).action, 'submitted');
  const contributor = data.items.find(item => item.kind === 'contributor');
  assert.equal(contributor.contributions, 42);
  assert.equal(contributor.createdAt, null);
  assert.equal(data.events.some(event => event.itemId === contributor.id), false);
});

test('missing parent metadata keeps its actual reference without synthesizing an object', () => {
  const response = fixture();
  response.comments.data[0].issue_url = 'https://api.github.com/repos/owner/repo/issues/999';
  response.comments.data[0].html_url = `${url}/pull/999#issuecomment-100`;
  const data = normalized(response);
  const comment = data.items.find(item => item.id.endsWith('issue_comment:100'));
  assert.equal(comment.parentId, 'owner/repo:pull_request:999');
  assert.equal(data.items.some(item => item.id === comment.parentId), false);
  assert.ok(data.limitations.some(note => note.includes('without inventing a parent')));
});

test('available parent objects are enriched from real issue responses', () => {
  const response = fixture();
  const parent = { number: 99, title: 'Older PR', state: 'closed', html_url: `${url}/pull/99`, pull_request: {}, user: user('older'), created_at: '2026-09-01T00:00:00Z' };
  response.issues.data.push(parent);
  response.comments.data[0].issue_url = 'https://api.github.com/repos/owner/repo/issues/99';
  response.comments.data[0].html_url = `${url}/pull/99#issuecomment-100`;
  const data = normalized(response);
  assert.equal(data.items.find(item => item.id === 'owner/repo:pull_request:99').title, 'Older PR');
});

test('invalid dates do not create replay events; actor URLs accept only intended public profiles', () => {
  const response = fixture();
  response.comments.data[0].created_at = 'not a date';
  response.comments.data[0].user = null;
  const data = normalized(response);
  const comment = data.items.find(item => item.id.endsWith('issue_comment:100'));
  assert.equal(comment.createdAt, null);
  assert.equal(comment.actor.login, null);
  assert.equal(data.events.some(event => event.itemId === comment.id), false);
  assert.equal(normalizeCommunityActor({ login: 'alice', avatar_url: 'https://user:secret@avatars.githubusercontent.com/u/1' }).avatarUrl, null);
  assert.equal(normalizeCommunityActor({ login: 'alice', avatar_url: 'javascript:alert(1)' }).avatarUrl, null);
  assert.equal(normalizeCommunityActor({ login: 'reviewer[bot]' }).login, 'reviewer[bot]');
  assert.equal(normalizeCommunityActor({ login: '../injected' }).login, null);
});

test('model sorts actual event dates, groups actors and filters collaboration kinds/query/state', () => {
  const data = normalized(fixture()); data.events.reverse();
  const model = buildCommunityModel(data);
  assert.deepEqual(model.events.map(event => event.date), [...model.events.map(event => event.date)].sort());
  assert.equal(model.actors.find(actor => actor.login === 'bob').itemCount, 2);
  assert.equal(filterCommunityItems(model, { kinds: ['pull_request'], historyKind: 'pull_request', state: 'merged', query: '#7' }).length, 1);
  assert.equal(filterCommunityItems(model, { kinds: new Set(['comment']), query: 'inline' }).length, 1);
  assert.equal(filterCommunityItems(model, { kinds: ['issue'], query: 'not present' }).length, 0);
});

test('cursor hides future objects while undated contributors remain visible without fabricated activity', () => {
  const model = buildCommunityModel(normalized(fixture()));
  const before = filterCommunityItems(model, {}, '2026-09-01T00:00:00Z');
  assert.deepEqual(before.map(item => item.kind), ['contributor']);
  assert.equal(filterCommunityItems(model, { kinds: ['comment'] }, '2026-10-03T10:00:00Z').length, 1);
  assert.equal(filterCommunityItems(model, { kinds: ['contributor'] }, new Date('2020-01-01')).length, 1);
  assert.equal(filterCommunityItems(model, {}, null).length, model.items.length - 1);
});

test('actor filtering includes actual workflow participation only after that event’s cursor time', () => {
  const model = buildCommunityModel(normalized(fixture()));
  assert.equal(filterCommunityItems(model, { kinds: ['pull_request'], historyKind: 'pull_request', actor: 'BOB' }, '2026-10-04T23:00:00Z').length, 0);
  assert.equal(filterCommunityItems(model, { kinds: ['pull_request'], historyKind: 'pull_request', actor: 'bob' }, '2026-10-05T10:00:00Z').length, 1);
});

test('unknown, duplicate and undated events are excluded without inventing missing items', () => {
  const data = normalized(fixture());
  data.events.push({ ...data.events[0] }, { id: 'orphan', itemId: 'missing', date: '2026-10-01' }, { id: 'undated', itemId: data.items[0].id, date: null });
  const model = buildCommunityModel(data);
  assert.equal(model.events.length, data.events.length - 3);
  assert.equal(model.items.length, data.items.length);
});

test('default view shows open and draft work while history is scoped to exactly one selected kind', () => {
  const data = normalized(fixture());
  const pull = data.items.find(item => item.kind === 'pull_request');
  const issue = data.items.find(item => item.kind === 'issue');
  data.items.push({ ...pull, id: 'draft', state: 'draft', number: 99 }, { ...pull, id: 'open-pr', state: 'open', number: 100 }, { ...issue, id: 'closed-issue', state: 'closed', number: 101 });
  const model = buildCommunityModel(data);
  const ids = filters => filterCommunityItems(model, filters).map(item => item.id);
  assert.ok(ids({}).includes('draft'));
  assert.ok(ids({}).includes('open-pr'));
  assert.ok(!ids({}).includes(pull.id));
  assert.ok(!ids({}).includes('closed-issue'));
  assert.ok(ids({ kinds: ['pull_request'], historyKind: 'pull_request' }).includes(pull.id));
  assert.ok(!ids({ kinds: ['pull_request'], historyKind: 'issue' }).includes(pull.id));
  assert.ok(!ids({ kinds: ['pull_request', 'issue'], historyKind: 'pull_request' }).includes(pull.id));
  assert.ok(!ids({ historyKind: 'issue' }).includes('closed-issue'));
  assert.ok(ids({ kinds: new Set(['issue']), historyKind: 'issue' }).includes('closed-issue'));
  assert.deepEqual(ids({ kinds: ['pull_request'], state: 'open' }), ['draft', 'open-pr']);
  assert.equal(filterCommunityItems(model).filter(item => !['issue', 'pull_request'].includes(item.kind)).length, data.items.filter(item => !['issue', 'pull_request'].includes(item.kind)).length);
});

test('complete repository search totals stay separate from loaded samples and replay visibility', () => {
  const response = fixture();
  response.countPulls = envelope({ total_count: 750, incomplete_results: false, items: [] });
  response.countIssues = envelope({ total_count: 120, incomplete_results: false, items: [] });
  response.openPulls = envelope({ total_count: 20, incomplete_results: false, items: [] });
  response.openIssues = envelope({ total_count: 10, incomplete_results: false, items: [] });
  const model = buildCommunityModel(normalized(response));
  assert.deepEqual(model.kindStats.pull_request, { total: 750, open: 20, loaded: 1, loadedOpen: 0, exact: true, openExact: true });
  assert.deepEqual(model.kindStats.issue, { total: 120, open: 10, loaded: 1, loadedOpen: 1, exact: true, openExact: true });
  assert.equal(model.kindStats.review.exact, false);
  assert.equal(model.kindStats.comment.exact, false);
  assert.equal(model.kindStats.fork.exact, true);
  assert.equal(model.kindStats.contributor.exact, true);
  assert.equal(model.kindStats.contributor.open, null);
  const before = structuredClone(model.kindStats);
  assert.equal(filterCommunityItems(model, {}, '2020-01-01').length, 1);
  filterCommunityItems(model, { kinds: ['pull_request'], historyKind: 'pull_request' });
  assert.deepEqual(model.kindStats, before);
});

test('incomplete or missing count searches never masquerade as exact totals', () => {
  const response = fixture();
  response.countPulls = envelope({ total_count: 9999, incomplete_results: true, items: [] });
  response.openPulls = envelope({ total_count: 9999, incomplete_results: true, items: [] });
  response.contributors.more = true;
  const data = normalized(response), model = buildCommunityModel(data);
  assert.deepEqual(model.kindStats.pull_request, { total: 1, open: 0, loaded: 1, loadedOpen: 0, exact: false, openExact: false });
  assert.equal(model.kindStats.issue.exact, false);
  assert.equal(model.kindStats.contributor.exact, false);
  assert.ok(data.limitations.some(note => note.includes('incomplete results')));
  assert.ok(data.limitations.some(note => note.includes('loaded lower bound')));
  data.counts.pull_request = { total: 0, open: 0, exact: true, openExact: true };
  assert.equal(buildCommunityModel(data).kindStats.pull_request.total, 1);
  assert.equal(buildCommunityModel(data).kindStats.pull_request.exact, false);
});

test('explicit open listings retain older open work outside the recent closed sample and deduplicate matches', () => {
  const response = fixture();
  const olderPull = { ...response.pulls.data[0], number: 1, title: 'Still open from last year', state: 'open', draft: true, created_at: '2025-01-01T00:00:00Z', merged_at: null, closed_at: null, pull_request: {} };
  const olderIssue = { ...response.issues.data[1], number: 2, title: 'Older open issue', created_at: '2025-02-01T00:00:00Z' };
  response.openPulls = envelope({ total_count: 1, incomplete_results: false, items: [olderPull] });
  response.openIssues = envelope({ total_count: 2, incomplete_results: false, items: [olderIssue, response.issues.data[1]] });
  response.countIssues = envelope({ total_count: 3, incomplete_results: false, items: [{ ...olderIssue, number: 3, title: 'Closed issue history', state: 'closed' }] });
  const model = buildCommunityModel(normalized(response));
  assert.equal(model.items.filter(item => item.kind === 'pull_request').length, 2);
  assert.equal(model.items.filter(item => item.kind === 'issue').length, 3);
  assert.deepEqual(filterCommunityItems(model, { kinds: ['pull_request'] }).map(item => item.number), [1]);
  assert.equal(filterCommunityItems(model, { kinds: ['issue'] }).length, 2);
  assert.equal(filterCommunityItems(model, { kinds: ['issue'], historyKind: 'issue' }).length, 3);
  assert.equal(model.kindStats.pull_request.loadedOpen, 1);
});

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function loaderMock({ failComments = false, manyPulls = false } = {}) {
  const calls = [];
  const source = fixture();
  const fetcher = async (request, options) => {
    calls.push({ request, options });
    const endpoint = new URL(request);
    const path = endpoint.pathname.replace('/repos/owner/repo', '');
    if (endpoint.pathname === '/search/issues') {
      const isPull = endpoint.searchParams.get('q').includes('is:pr');
      const open = endpoint.searchParams.get('q').includes('is:open');
      const records = isPull ? open ? [] : source.pulls.data : [source.issues.data[1]];
      return jsonResponse({ total_count: isPull ? open ? 0 : manyPulls ? 20 : 1 : 1, incomplete_results: false, items: records });
    }

    if (path === '') return jsonResponse(source.repository.data);
    if (path === '/pulls') return jsonResponse(manyPulls ? Array.from({ length: 20 }, (_, index) => ({ ...source.pulls.data[0], number: index + 1 })) : source.pulls.data, 200, { Link: '<https://api.github.com/page2>; rel="next"' });
    if (path === '/issues') return jsonResponse(source.issues.data);
    if (path === '/issues/comments') return failComments ? jsonResponse({ message: 'limit' }, 403) : jsonResponse(source.comments.data);
    if (path === '/pulls/comments') return jsonResponse(source.reviewComments.data);
    if (path === '/forks') return jsonResponse(source.forks.data);
    if (path === '/contributors') return jsonResponse(null, 204);
    if (path === '/issues/events') return jsonResponse(source.issueEvents.data);
    if (/\/pulls\/\d+\/reviews/.test(path)) return jsonResponse([]);
    throw new Error(`Unexpected request ${request}`);
  };
  return { fetcher, calls };
}

test('live loader uses bounded public reads and never sends credentials or tokens', async () => {
  const { fetcher, calls } = loaderMock({ manyPulls: true });
  const progress = [];
  const data = await loadActivityRepository(url, { fetcher, onProgress: message => progress.push(message) });
  assert.equal(data.source, 'github');
  assert.equal(calls.length, 12 + ACTIVITY_LIMITS.reviewedPullRequests);
  assert.ok(calls.every(call => call.options.credentials === 'omit' && !Object.keys(call.options.headers).some(key => key.toLowerCase() === 'authorization')));
  assert.ok(calls.every(call => new URL(call.request).searchParams.get('page') !== '2'));
  assert.ok(progress.includes('Preparing collaboration activity…'));
  assert.ok(data.limitations.some(note => note.includes('further results are omitted')));
});

test('optional endpoint failures preserve successful activity and surface explicit coverage gaps', async () => {
  const { fetcher } = loaderMock({ failComments: true });
  const data = await loadActivityRepository(url, { fetcher });
  assert.equal(data.items.some(item => item.kind === 'pull_request'), true);
  assert.equal(data.items.some(item => item.commentType === 'conversation'), false);
  assert.equal(data.items.some(item => item.commentType === 'inline_review'), true);
  assert.ok(data.limitations.some(note => note.includes('Conversation comments unavailable') && note.includes('403')));
});

test('successful metadata with all collaboration sources failing rejects instead of publishing an empty snapshot', async () => {
  const calls = [];
  const progress = [];
  const fetcher = async request => {
    calls.push(request);
    return new URL(request).pathname === '/repos/owner/repo'
      ? jsonResponse(fixture().repository.data)
      : jsonResponse({ message: 'API rate limit exceeded' }, 403);
  };
  await assert.rejects(loadActivityRepository(url, { fetcher, onProgress: message => progress.push(message) }), error => {
    assert.match(error.message, /all collaboration sources failed/);
    assert.match(error.message, /Try again or use a preloaded example/);
    assert.match(error.message, /403.*access or rate limit/);
    return true;
  });
  assert.equal(calls.length, 12, 'Only metadata, the seven bounded sources and four search requests are made.');
  assert.equal(progress.includes('Preparing collaboration activity…'), false);
});

test('successful count queries alone do not turn failed collaboration sources into success', async () => {
  await assert.rejects(loadActivityRepository(url, { fetcher: async request => {
    const endpoint = new URL(request);
    if (endpoint.pathname === '/repos/owner/repo') return jsonResponse(fixture().repository.data);
    if (endpoint.pathname === '/search/issues' && !endpoint.searchParams.get('q').includes('is:open')) return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
    return jsonResponse({ message: 'API rate limit exceeded' }, 403);
  } }), /all collaboration sources failed/);
});

test('an empty successful source still permits an honest partial empty snapshot', async () => {
  const data = await loadActivityRepository(url, { fetcher: async request => {
    const path = new URL(request).pathname;
    if (path === '/repos/owner/repo') return jsonResponse(fixture().repository.data);
    if (path.endsWith('/contributors')) return jsonResponse(null, 204);
    return jsonResponse({ message: 'API rate limit exceeded' }, 403);
  } });
  assert.equal(data.items.length, 0);
  assert.equal(data.provenance.endpoints.filter(endpoint => endpoint.error).length, 10);
  assert.ok(data.provenance.endpoints.some(endpoint => endpoint.name === 'contributors' && endpoint.status === 204));
});

test('repository failure throws and cancellation is never turned into a partial success', async () => {
  await assert.rejects(loadActivityRepository(url, { fetcher: async () => jsonResponse({}, 404) }), /Could not load this public GitHub repository/);
  const controller = new AbortController();
  await assert.rejects(loadActivityRepository(url, { signal: controller.signal, fetcher: async () => { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); } }), { name: 'AbortError' });
  const aborted = new AbortController(); aborted.abort();
  let called = false;
  await assert.rejects(loadActivityRepository(url, { signal: aborted.signal, fetcher: async () => { called = true; } }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('only the two real preloaded examples are available, independently cloned and complete enough to browse offline', async () => {
  assert.deepEqual(ACTIVITY_EXAMPLES.map(item => item.fullName), ['quirq-ai/xo', 'quirq-ai/xo-space']);
  const expected = { 'quirq-ai/xo': { pull_request: 20, issue: 2, review: 1, comment: 30, fork: 0, contributor: 1 }, 'quirq-ai/xo-space': { pull_request: 39, issue: 54, review: 13, comment: 60, fork: 4, contributor: 13 } };
  for (const example of ACTIVITY_EXAMPLES) {
    const data = await getActivityExample(example.url);
    const model = buildCommunityModel(data);
    assert.equal(data.source, 'snapshot');
    assert.ok(data.provenance.endpoints.every(endpoint => endpoint.status === 200 && (endpoint.url.startsWith('https://api.github.com/repos/quirq-ai/') || endpoint.url.startsWith('https://api.github.com/search/issues?'))));
    assert.equal(data.provenance.endpoints.length, 20);
    const totals = example.fullName === 'quirq-ai/xo' ? { pull_request: [46, 0], issue: [2, 2] } : { pull_request: [177, 24], issue: [71, 34] };
    for (const [kind, [total, open]] of Object.entries(totals)) {
      assert.equal(model.kindStats[kind].total, total);
      assert.equal(model.kindStats[kind].open, open);
      assert.equal(model.kindStats[kind].loadedOpen, open);
      assert.equal(model.kindStats[kind].exact, true);
      assert.equal(model.kindStats[kind].openExact, true);
    }
    assert.ok(filterCommunityItems(model).filter(item => ['pull_request', 'issue'].includes(item.kind)).every(item => ['open', 'draft'].includes(item.state)));

    for (const [kind, amount] of Object.entries(expected[example.fullName])) assert.equal(model.items.filter(item => item.kind === kind).length, amount);
    assert.ok(model.events.every(event => model.byId.has(event.itemId) && Number.isFinite(Date.parse(event.date))));
    assert.equal(model.events.some(event => event.kind === 'contributor'), false);
    data.items[0].title = 'Changed locally';
    assert.notEqual((await getActivityExample(example.url)).items[0].title, 'Changed locally');
  }
  assert.equal(await getActivityExample('https://github.com/other/example'), null);
});
