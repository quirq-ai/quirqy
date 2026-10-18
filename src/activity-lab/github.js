import { parseRepositoryUrl } from '../data-lab/github.js';

const API = 'https://api.github.com';
export const ACTIVITY_LIMITS = Object.freeze({ pullRequests: 20, issueListing: 50, comments: 30, reviewComments: 30, forks: 20, contributors: 30, issueEvents: 50, reviewedPullRequests: 8, reviewsPerPullRequest: 30 });
const endpoints = {
  pulls: '/pulls?state=all&sort=updated&direction=desc&per_page=20&page=1',
  issues: '/issues?state=all&sort=updated&direction=desc&per_page=50&page=1',
  comments: '/issues/comments?sort=updated&direction=desc&per_page=30&page=1',
  reviewComments: '/pulls/comments?sort=updated&direction=desc&per_page=30&page=1',
  forks: '/forks?sort=newest&per_page=20&page=1',
  contributors: '/contributors?per_page=30&page=1',
  issueEvents: '/issues/events?per_page=50&page=1',
};
const labels = { repository: 'Repository details', pulls: 'Pull requests', issues: 'Issue/PR listing', comments: 'Conversation comments', reviewComments: 'Inline review comments', forks: 'Forks', contributors: 'Contributors', issueEvents: 'Issue workflow events' };
const emptyActor = () => ({ login: null, avatarUrl: null, url: null });
const text = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const idValue = value => Number.isSafeInteger(value) && value > 0 ? String(value) : null;
function githubUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port ? url.href : null; }
  catch { return null; }
}
export function normalizeCommunityActor(user) {
  if (!user || typeof user.login !== 'string' || !/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}(?:\[bot\])?$/i.test(user.login)) return emptyActor();
  let avatarUrl = null;
  try {
    const avatar = new URL(user.avatar_url || user.avatarUrl);
    if (avatar.protocol === 'https:' && avatar.hostname === 'avatars.githubusercontent.com' && !avatar.username && !avatar.password && !avatar.port && !avatar.hash) avatarUrl = avatar.href;
  } catch { /* Missing/deleted profiles keep an honest empty avatar. */ }
  return { login: user.login, avatarUrl, url: `https://github.com/${encodeURIComponent(user.login)}` };
}
function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Activity loading was cancelled.', 'AbortError');
}
function reviewNumbers(responses) {
  const pulls = Array.isArray(responses.pulls?.data) ? responses.pulls.data : [];
  const issues = Array.isArray(responses.issues?.data) ? responses.issues.data.filter(issue => issue.pull_request) : [];
  return [...new Set((pulls.length ? pulls : issues).map(pull => pull.number).filter(number => idValue(number)))].slice(0, ACTIVITY_LIMITS.reviewedPullRequests);
}

/** Public metadata only. At most 16 requests, no token, source code or writes. */
export async function loadActivityRepository(input, { signal, onProgress = () => {}, fetcher = globalThis.fetch } = {}) {
  const parsed = parseRepositoryUrl(input);
  const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const responses = {};
  async function request(key, path, required = false) {
    checkAbort(signal);
    const label = labels[key] || `Reviews for PR #${key.replace('reviews-', '')}`;
    onProgress(`Reading ${label.toLowerCase()}…`);
    const url = `${API}${base}${path}`;
    let result;
    try {
      const response = await fetcher(url, { signal, credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } });
      checkAbort(signal);
      if (!response.ok && response.status !== 204) {
        const limited = response.status === 403 || response.status === 429;
        const reset = Number(response.headers?.get('x-ratelimit-reset'));
        throw new Error(`GitHub HTTP ${response.status}${limited ? ' (access or rate limit)' : ''}${limited && Number.isFinite(reset) && reset > 0 ? `; retry after ${new Date(reset * 1000).toISOString()}` : ''}`);
      }
      const data = response.status === 204 ? [] : await response.json();
      checkAbort(signal);
      if (required ? !data || typeof data !== 'object' || Array.isArray(data) : !Array.isArray(data)) throw new Error('GitHub returned an invalid response');
      result = { url, status: response.status, fetchedAt: new Date().toISOString(), data, more: /rel="next"/.test(response.headers?.get('link') || '') };
    } catch (error) {
      checkAbort(signal);
      if (error?.name === 'AbortError') throw error;
      if (required) throw new Error(`Could not load this public GitHub repository. ${error.message}`);
      result = { url, status: null, fetchedAt: new Date().toISOString(), data: [], more: false, error: `${label} unavailable: ${error.message}.` };
    }
    responses[key] = result;
  }
  await request('repository', '', true);
  const jobs = Object.entries(endpoints);
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < jobs.length) { const [key, path] = jobs[next++]; await request(key, path); }
  }));
  checkAbort(signal);
  if (jobs.every(([key]) => responses[key]?.error)) {
    throw new Error(`Repository details loaded, but all collaboration sources failed. Try again or use a preloaded example. ${responses[jobs[0][0]].error}`);
  }
  const reviews = reviewNumbers(responses);
  next = 0;
  await Promise.all(Array.from({ length: Math.min(3, reviews.length) }, async () => {
    while (next < reviews.length) {
      const number = reviews[next++];
      await request(`reviews-${number}`, `/pulls/${number}/reviews?per_page=30&page=1`);
    }
  }));
  checkAbort(signal);
  onProgress('Preparing collaboration activity…');
  return normalizeActivityResponses(parsed.url, responses, { fetchedAt: new Date().toISOString(), source: 'github' });
}

/** Shared by the live loader, snapshot capture and response-level tests. */
export function normalizeActivityResponses(input, responses, { fetchedAt = new Date().toISOString(), source = 'github' } = {}) {
  const parsed = parseRepositoryUrl(input);
  const metadata = responses.repository?.data;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !metadata.full_name) throw new Error('Repository metadata is unavailable.');
  const fullName = parsed.fullName;
  const prefix = `${fullName.toLowerCase()}:`;
  const items = new Map(), events = new Map();
  const limitations = [];
  const note = message => { if (!limitations.includes(message)) limitations.push(message); };
  const rows = key => Array.isArray(responses[key]?.data) ? responses[key].data : [];
  const parentId = (kind, number) => `${prefix}${kind}:${number}`;
  const issueRows = new Map(rows('issues').map(item => [item.number, item]));
  for (const event of rows('issueEvents')) if (event.issue?.number && !issueRows.has(event.issue.number)) issueRows.set(event.issue.number, event.issue);
  const pullRows = new Map(rows('pulls').map(item => [item.number, item]));
  const knownPulls = new Set([...pullRows.keys(), ...[...issueRows.values()].filter(item => item.pull_request).map(item => item.number)]);
  function addEvent(item, action, when, actor, eventId = null, provenance = 'object timestamp') {
    const normalizedDate = date(when);
    if (!item || !normalizedDate) return;
    const key = `${item.id}|${action}|${normalizedDate}`;
    const previous = events.get(key);
    const value = { id: eventId || `${item.id}:${action}:${normalizedDate}`, itemId: item.id, kind: item.kind, action,
      date: normalizedDate, actor: normalizeCommunityActor(actor), provenance };
    if (!previous || provenance === 'GitHub issue event') events.set(key, value);
  }
  function addWorkItem(raw, forceKind = null) {
    if (!idValue(raw?.number)) return null;
    const kind = forceKind || (raw.pull_request || knownPulls.has(raw.number) ? 'pull_request' : 'issue');
    const id = parentId(kind, raw.number);
    if (items.has(id)) return items.get(id);
    const mergedAt = raw.merged_at || raw.pull_request?.merged_at;
    const state = kind === 'pull_request' && mergedAt ? 'merged' : raw.state === 'open' && raw.draft ? 'draft' : raw.state || null;
    const item = { id, kind, number: raw.number, title: text(raw.title, 1024) || `${kind === 'pull_request' ? 'Pull request' : 'Issue'} #${raw.number}`,
      url: githubUrl(raw.html_url) || `${parsed.url}/${kind === 'pull_request' ? 'pull' : 'issues'}/${raw.number}`,
      actor: normalizeCommunityActor(raw.user), createdAt: date(raw.created_at), updatedAt: date(raw.updated_at), state,
      closedAt: date(raw.closed_at), mergedAt: date(mergedAt) };
    items.set(id, item);
    addEvent(item, 'opened', raw.created_at, raw.user);
    if (mergedAt) addEvent(item, 'merged', mergedAt, raw.merged_by);
    else if (raw.closed_at) addEvent(item, 'closed', raw.closed_at, raw.closed_by);
    return item;
  }
  for (const raw of rows('pulls')) addWorkItem(raw, 'pull_request');
  for (const raw of rows('issues')) if (!raw.pull_request) addWorkItem(raw, 'issue');
  function ensureParent(number, kind = null) {
    if (!idValue(number)) return null;
    const actualKind = kind || (knownPulls.has(number) ? 'pull_request' : 'issue');
    const id = parentId(actualKind, number);
    if (!items.has(id)) {
      const raw = pullRows.get(number) || issueRows.get(number);
      if (raw) addWorkItem(raw, actualKind);
    }
    return id;
  }
  function parentFromUrl(raw, isReview = false) {
    const values = [isReview ? raw.pull_request_url : raw.issue_url, raw.html_url];
    for (const value of values) {
      try {
        const url = new URL(value);
        const base = url.hostname === 'api.github.com' ? `/repos/${fullName}/` : url.hostname === 'github.com' ? `/${fullName}/` : null;
        if (url.protocol !== 'https:' || !base || !url.pathname.toLowerCase().startsWith(base.toLowerCase())) continue;
        const match = /^(issues|pulls|pull)\/(\d+)$/.exec(url.pathname.slice(base.length));
        if (!match) continue;
        const number = Number(match[2]);
        const htmlPull = /\/pull\/\d+/.test(raw.html_url || '');
        return { number, kind: isReview || match[1] !== 'issues' || htmlPull || knownPulls.has(number) ? 'pull_request' : 'issue' };
      } catch { /* Invalid parent links remain unconnected. */ }
    }
    return null;
  }
  for (const [key, isReview] of [['comments', false], ['reviewComments', true]]) for (const raw of rows(key)) {
    if (!idValue(raw.id)) continue;
    const parent = parentFromUrl(raw, isReview);
    const parentKey = parent ? ensureParent(parent.number, parent.kind) : null;
    const preview = text(raw.body, 12000).replace(/\s+/g, ' ').trim().slice(0, 180);
    const item = { id: `${prefix}${isReview ? 'review_comment' : 'issue_comment'}:${raw.id}`, kind: 'comment',
      title: preview || `${isReview ? 'Review comment' : 'Comment'}${parent ? ` on #${parent.number}` : ''}`,
      url: githubUrl(raw.html_url), actor: normalizeCommunityActor(raw.user), createdAt: date(raw.created_at), updatedAt: date(raw.updated_at), state: null,
      number: parent?.number || null, ...(parentKey ? { parentId: parentKey } : {}), commentType: isReview ? 'inline_review' : 'conversation' };
    items.set(item.id, item);
    addEvent(item, 'commented', raw.created_at, raw.user);
  }
  for (const number of reviewNumbers(responses)) for (const raw of rows(`reviews-${number}`)) {
    if (!idValue(raw.id)) continue;
    const item = { id: `${prefix}review:${raw.id}`, kind: 'review', number,
      title: `${String(raw.state || 'Review').replaceAll('_', ' ').toLowerCase()} · PR #${number}${raw.body?.trim() ? ` · ${text(raw.body).replace(/\s+/g, ' ').slice(0, 140)}` : ''}`,
      url: githubUrl(raw.html_url), actor: normalizeCommunityActor(raw.user), createdAt: date(raw.submitted_at), updatedAt: date(raw.submitted_at),
      state: typeof raw.state === 'string' ? raw.state.toLowerCase() : null, parentId: ensureParent(number, 'pull_request') };
    items.set(item.id, item);
    // A review can later be dismissed; submitted_at does not date that dismissal.
    addEvent(item, 'submitted', raw.submitted_at, raw.user);
  }
  for (const raw of rows('forks')) {
    if (!idValue(raw.id)) continue;
    const item = { id: `${prefix}fork:${raw.id}`, kind: 'fork', number: null,
      title: text(raw.full_name, 256) || 'Repository fork', url: githubUrl(raw.html_url), actor: normalizeCommunityActor(raw.owner),
      createdAt: date(raw.created_at), updatedAt: date(raw.updated_at), state: null };
    items.set(item.id, item);
    // Creation is known; the current owner is not necessarily the original creator.
    addEvent(item, 'forked', raw.created_at, null);
  }
  for (const raw of rows('contributors')) {
    const actor = normalizeCommunityActor(raw);
    if (!actor.login) continue;
    const item = { id: `${prefix}contributor:${actor.login.toLowerCase()}`, kind: 'contributor', number: null,
      title: actor.login, url: actor.url, actor, createdAt: null, updatedAt: null, state: null, contributions: count(raw.contributions) };
    items.set(item.id, item);
  }
  const workflowActions = new Set(['closed', 'reopened', 'merged', 'labeled', 'unlabeled', 'assigned', 'unassigned', 'milestoned', 'demilestoned', 'renamed', 'locked', 'unlocked', 'review_requested', 'review_request_removed', 'ready_for_review', 'converted_to_draft']);
  for (const raw of rows('issueEvents')) {
    if (!workflowActions.has(raw.event) || !raw.issue?.number) continue;
    const id = ensureParent(raw.issue.number, raw.issue.pull_request ? 'pull_request' : null);
    addEvent(items.get(id), raw.event, raw.created_at, raw.actor, `${prefix}issue_event:${raw.id}`, 'GitHub issue event');
  }
  for (const [key, response] of Object.entries(responses)) {
    if (response.error) note(response.error);
    else if (response.status && response.status !== 200 && response.status !== 204) note(`${labels[key] || key} unavailable: GitHub HTTP ${response.status}.`);
    if (response.more) note(`${labels[key] || `Reviews for PR #${key.replace('reviews-', '')}`}: only the first requested page is included; further results are omitted.`);
  }
  note('Bounded public snapshot: up to 20 recently updated PRs; issues from the first 50 mixed issue/PR results; 30 conversation comments, 30 inline comments, 20 newest forks, 30 contributors and 50 issue events. Available parent objects may also be included to connect real comments and events.');
  note('Reviews cover the first 30 reviews, in chronological order, on at most 8 sampled recently updated PRs. Other reviews are not loaded.');
  note('Replay uses returned object timestamps and sampled issue events, not a complete historical audit. State, titles, ownership and contributor counts describe the fetched snapshot, not reconstructed historical values. Missing timestamps do not become invented events.');
  note('The issues endpoint includes pull requests; issue items and PR items are separated. GitHub’s repository open-issues total includes open pull requests.');
  note('Contributor counts are GitHub’s cached aggregate commit counts, not collaboration scores or productivity measures. Undated contributors remain visible outside replay; anonymous contributors are not requested.');
  if ([...items.values()].some(item => item.parentId && !items.has(item.parentId))) note('Some comments refer to PRs or issues outside the sampled parent listings. Their real parent reference is retained without inventing a parent object.');
  if (source === 'snapshot') note('Preloaded from actual GitHub API responses. This bundled snapshot works without API access and does not update automatically.');
  return {
    repository: { fullName: metadata.full_name, url: parsed.url, description: text(metadata.description, 8192), stars: count(metadata.stargazers_count), forks: count(metadata.forks_count), openIssues: count(metadata.open_issues_count), openIssuesIncludesPullRequests: true },
    fetchedAt: date(fetchedAt), source, items: [...items.values()], events: [...events.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), limitations,
    provenance: { provider: 'GitHub REST API', endpoints: Object.entries(responses).map(([key, response]) => ({ name: key, url: response.url, fetchedAt: response.fetchedAt, status: response.status, count: Array.isArray(response.data) ? response.data.length : null, more: Boolean(response.more), ...(response.error ? { error: response.error } : {}) })) },
  };
}
