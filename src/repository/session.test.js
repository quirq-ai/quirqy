import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepositorySession, REPOSITORY_SESSION_STORAGE_KEY } from './session.js';

const ref = number => number.toString(16).padStart(40, '0');
const fileId = 'file:src%2Fa.js';
function dataset(seed = 1) {
  return {
    repository: { name: 'repo', fullName: 'owner/repo', url: 'https://github.com/owner/repo', branch: 'main', source: 'github', headSha: ref(seed + 1) },
    files: [{ path: 'src/a.js', size: 123, existsAtHead: true }],
    commits: [seed, seed + 1].map(number => ({
      sha: ref(number), message: `Commit ${number}`, author: 'A person', date: '2026-10-19T12:00:00Z',
      url: `https://github.com/owner/repo/commit/${ref(number)}`, isMerge: false, partial: false,
      files: [{ path: 'src/a.js', status: 'modified', additions: 3, deletions: 1 }],
    })),
    coverage: { label: '2 first-parent commits', limitations: ['A pinned snapshot.'] },
  };
}
function storage() {
  const values = new Map();
  return {
    values, blocked: false,
    getItem(key) { if (this.blocked) throw new Error('Storage blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (this.blocked) throw new Error('Storage blocked'); values.set(key, String(value)); },
    removeItem(key) { if (this.blocked) throw new Error('Storage blocked'); values.delete(key); },
  };
}
function backend() {
  const values = new Map();
  return {
    values, writes: [], failure: false, beforeCommit: null, beforeGet: null,
    async get(key) { if (this.beforeGet) await this.beforeGet(); return structuredClone(values.get(key) || null); },
    async commit(record, limits) {
      this.writes.push({ key: record.key, limits });
      if (this.beforeCommit) await this.beforeCommit(record);
      if (this.failure) throw new Error('Quota exceeded');
      values.set(record.key, structuredClone(record));
      return true;
    },
    async clear() { values.clear(); return true; },
  };
}
function fixture(options = {}) {
  const durable = options.backend || backend();
  const local = options.storage || storage();
  let tick = 0;
  const settings = { backend: durable, storage: local, now: () => Date.UTC(2026, 9, 19, 12, 0, tick++), ...options };
  return { durable, local, session: createRepositorySession(settings), reload: () => createRepositorySession(settings) };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

test('a fresh session reads no IndexedDB until a valid pointer exists', async () => {
  let opened = 0;
  const session = createRepositorySession({ storage: storage(), backend: () => { opened++; return backend(); } });
  assert.equal(await session.restoreRepositorySession(), null);
  assert.equal(opened, 0);
});

test('dataset, baseline and file selection survive a new page session without another load', async () => {
  const { session, reload, local } = fixture();
  const input = dataset();
  assert.equal(await session.saveRepositoryDataset(input), true);
  assert.equal(session.updateRepositorySelection({ commitSha: null, fileId }), true);
  const pointer = JSON.parse(local.getItem(REPOSITORY_SESSION_STORAGE_KEY));
  assert.deepEqual(pointer.selection, { commitSha: null, fileId });
  assert.equal(owns(pointer, 'dataset'), false);
  const restored = await reload().restoreRepositorySession();
  assert.deepEqual(restored.dataset, input);
  assert.deepEqual(restored.selection, { commitSha: null, fileId });
  assert.equal(restored.savedAt, '2026-10-19T12:00:00.000Z');
});
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

test('saving and restoring never exposes caller-owned mutable dataset objects', async () => {
  const { session, reload } = fixture();
  const input = dataset();
  const saving = session.saveRepositoryDataset(input);
  input.commits[0].message = 'Changed by caller';
  await saving;
  const restored = await session.restoreRepositorySession();
  assert.equal(restored.dataset.commits[0].message, 'Commit 1');
  restored.dataset.commits[0].message = 'Changed through restored copy';
  assert.equal((await session.restoreRepositorySession()).dataset.commits[0].message, 'Commit 1');
  assert.equal((await reload().restoreRepositorySession()).dataset.commits[0].message, 'Commit 1');
});

test('missing or stale commit/file references fall back to head and clear the file', async () => {
  const { session, reload, local } = fixture();
  await session.saveRepositoryDataset(dataset(), { commitSha: ref(999), fileId: 'file:missing' });
  assert.deepEqual((await session.restoreRepositorySession()).selection, { commitSha: ref(2), fileId: null });
  const pointer = JSON.parse(local.getItem(REPOSITORY_SESSION_STORAGE_KEY));
  pointer.selection = { commitSha: 'not-a-sha', fileId: 'file:old' };
  local.setItem(REPOSITORY_SESSION_STORAGE_KEY, JSON.stringify(pointer));
  assert.deepEqual((await reload().restoreRepositorySession()).selection, { commitSha: ref(2), fileId: null });
  session.updateRepositorySelection({ fileId });
  session.updateRepositorySelection({ commitSha: ref(1) });
  assert.deepEqual((await session.restoreRepositorySession()).selection, { commitSha: ref(1), fileId });
});

test('selection during a pending dataset write is published only with the completed dataset', async () => {
  const { session, durable, local, reload } = fixture();
  await session.saveRepositoryDataset(dataset());
  const previous = local.getItem(REPOSITORY_SESSION_STORAGE_KEY);
  const gate = deferred();
  durable.beforeCommit = () => gate.promise;
  const saving = session.saveRepositoryDataset(dataset(10));
  await turn();
  assert.equal(session.updateRepositorySelection({ commitSha: ref(10), fileId }), false);
  assert.equal(local.getItem(REPOSITORY_SESSION_STORAGE_KEY), previous, 'Old durable dataset remains valid until replacement commits.');
  let flushed = false;
  const flushing = session.flushRepositorySession().then(() => { flushed = true; });
  await turn();
  assert.equal(flushed, false);
  gate.resolve();
  assert.equal(await saving, true);
  await flushing;
  assert.deepEqual((await reload().restoreRepositorySession()).selection, { commitSha: ref(10), fileId });
});

test('rapid imports commit in order and flush waits for the newest queued dataset', async () => {
  const { session, durable, reload } = fixture();
  const gate = deferred();
  durable.beforeCommit = record => record.dataset.repository.headSha === ref(2) ? gate.promise : undefined;
  const first = session.saveRepositoryDataset(dataset());
  await turn();
  const second = session.saveRepositoryDataset(dataset(10));
  const third = session.saveRepositoryDataset(dataset(20));
  const flushing = session.flushRepositorySession();
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  await flushing;
  assert.equal(durable.writes.length, 3);
  assert.equal((await reload().restoreRepositorySession()).dataset.repository.headSha, ref(21));
  assert.equal(durable.writes[1].limits.protectedKey, durable.writes[0].key);
  assert.equal(durable.writes[2].limits.protectedKey, durable.writes[1].key);
});

test('a quota failure preserves the previous durable session and keeps new metadata in memory', async () => {
  const { session, durable, local, reload } = fixture();
  await session.saveRepositoryDataset(dataset(), { commitSha: ref(1) });
  const previous = local.getItem(REPOSITORY_SESSION_STORAGE_KEY);
  durable.failure = true;
  assert.equal(await session.saveRepositoryDataset(dataset(10)), false);
  assert.equal(local.getItem(REPOSITORY_SESSION_STORAGE_KEY), previous);
  assert.equal((await reload().restoreRepositorySession()).dataset.repository.headSha, ref(2));
  assert.equal((await session.restoreRepositorySession()).dataset.repository.headSha, ref(11));
});

test('the newest successful queued snapshot stays durable if the following write fails', async () => {
  const { session, durable, reload } = fixture();
  const gate = deferred();
  durable.beforeCommit = async record => {
    if (record.dataset.repository.headSha === ref(2)) await gate.promise;
    if (record.dataset.repository.headSha === ref(21)) throw new Error('Quota');
  };
  const first = session.saveRepositoryDataset(dataset());
  const second = session.saveRepositoryDataset(dataset(10));
  const third = session.saveRepositoryDataset(dataset(20));
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, false]);
  assert.equal((await reload().restoreRepositorySession()).dataset.repository.headSha, ref(11));
});

test('blocked localStorage keeps the existing pointer intact and provides memory fallback', async () => {
  const { session, durable, local, reload } = fixture();
  await session.saveRepositoryDataset(dataset());
  const previous = local.getItem(REPOSITORY_SESSION_STORAGE_KEY);
  local.blocked = true;
  assert.equal(await session.saveRepositoryDataset(dataset(10)), false);
  assert.equal(session.updateRepositorySelection({ commitSha: null }), false);
  assert.equal((await session.restoreRepositorySession()).selection.commitSha, null);
  local.blocked = false;
  assert.equal(local.getItem(REPOSITORY_SESSION_STORAGE_KEY), previous);
  assert.equal((await reload().restoreRepositorySession()).dataset.repository.headSha, ref(2));
  assert.equal(durable.writes.at(-1).limits.protectedKey, durable.writes[0].key);
});

test('missing browser storage and a throwing storage getter do not crash or lose in-memory selection', async () => {
  for (const local of [null, () => { throw new Error('SecurityError'); }]) {
    const session = createRepositorySession({ storage: local, backend: null });
    assert.equal(await session.saveRepositoryDataset(dataset()), false);
    session.updateRepositorySelection({ commitSha: ref(1), fileId });
    await session.flushRepositorySession();
    assert.deepEqual((await session.restoreRepositorySession()).selection, { commitSha: ref(1), fileId });
  }
});

test('corrupt JSON, unknown schema, missing records and mismatched immutable keys restore safely', async () => {
  const { session, durable, local, reload } = fixture();
  await session.saveRepositoryDataset(dataset());
  const pointer = JSON.parse(local.getItem(REPOSITORY_SESSION_STORAGE_KEY));
  for (const value of ['{broken', JSON.stringify({ ...pointer, schema: 99 }), JSON.stringify({ ...pointer, key: 'missing' })]) {
    local.setItem(REPOSITORY_SESSION_STORAGE_KEY, value);
    assert.equal(await reload().restoreRepositorySession(), null);
  }
  local.setItem(REPOSITORY_SESSION_STORAGE_KEY, JSON.stringify(pointer));
  const record = durable.values.get(pointer.key);
  record.dataset.repository.headSha = ref(999);
  assert.equal(await reload().restoreRepositorySession(), null);
});

test('invalid imports leave the last successful session unchanged', async () => {
  const { session } = fixture();
  await session.saveRepositoryDataset(dataset());
  const invalid = [
    value => { value.repository.url = 'https://secret@github.com/owner/repo'; },
    value => { value.repository.headSha = 'short-ref'; },
    value => { value.repository.branch = ''; },
    value => { value.commits[0].files[0].path = '../escape'; },
    value => { value.commits[0].files[0].path = 'not-in-file-union'; },
    value => { value.commits[0].files[0].additions = -1; },
    value => { value.commits[0].sha = value.commits[1].sha; },
    value => { value.commits[1].firstParent = ref(999); },
  ];
  for (const mutate of invalid) {
    const value = dataset(10); mutate(value);
    assert.equal(await session.saveRepositoryDataset(value), false);
    assert.equal((await session.restoreRepositorySession()).dataset.repository.headSha, ref(2));
  }
});

test('only metadata fields persist; source contents, credentials and untrusted profile links are excluded', async () => {
  const { session, reload } = fixture();
  const value = dataset();
  value.token = 'secret'; value.repository.accessToken = 'secret';
  value.files[0].content = 'source code'; value.commits[0].files[0].patch = 'source diff';
  value.commits[0].files[0].binary = true;
  value.commits[0].authorProfile = { login: 'person', avatarUrl: 'javascript:bad', url: 'https://bad.invalid', token: 'secret' };
  value.commits[0].url = 'https://bad.invalid';
  assert.equal(await session.saveRepositoryDataset(value), true);
  const saved = (await reload().restoreRepositorySession()).dataset;
  const json = JSON.stringify(saved);
  assert.equal(json.includes('secret'), false);
  assert.equal(json.includes('source code'), false);
  assert.equal(json.includes('source diff'), false);
  assert.equal(json.includes('bad.invalid'), false);
  assert.equal(saved.commits[0].files[0].binary, true);
  assert.deepEqual(saved.commits[0].authorProfile, { login: 'person', avatarUrl: null, url: 'https://github.com/person' });
});

test('head, history window, branch and source produce separate cache identities', async () => {
  const { session, durable } = fixture();
  const original = dataset();
  await session.saveRepositoryDataset(original);
  await session.saveRepositoryDataset({ ...dataset(), commits: [dataset().commits[1]] });
  const branch = dataset(); branch.repository.branch = 'release'; await session.saveRepositoryDataset(branch);
  const example = dataset(); example.repository.source = 'example'; example.repository.capturedAt = '2026-10-19T00:00:00Z'; await session.saveRepositoryDataset(example);
  await session.saveRepositoryDataset(dataset(10));
  assert.equal(new Set(durable.writes.map(write => write.key)).size, 5);
});

test('oversized metadata does not enter the durable cache or evict its previous pointer', async () => {
  const { session, durable, local } = fixture({ maxBytes: 8192 });
  assert.equal(await session.saveRepositoryDataset(dataset()), true);
  const previous = local.getItem(REPOSITORY_SESSION_STORAGE_KEY);
  const large = dataset(10); large.commits[0].message = 'x'.repeat(5000);
  assert.equal(await session.saveRepositoryDataset(large), false);
  assert.equal(durable.writes.length, 1);
  assert.equal(local.getItem(REPOSITORY_SESSION_STORAGE_KEY), previous);
});

test('clear cancels publication of pending saves and removes durable session data', async () => {
  const { session, durable, local, reload } = fixture();
  const gate = deferred(); durable.beforeCommit = () => gate.promise;
  const saving = session.saveRepositoryDataset(dataset());
  await turn();
  const clearing = session.clearRepositorySession();
  gate.resolve();
  assert.equal(await saving, false);
  await clearing;
  assert.equal(local.getItem(REPOSITORY_SESSION_STORAGE_KEY), null);
  assert.equal(durable.values.size, 0);
  assert.equal(await session.restoreRepositorySession(), null);
  assert.equal(await reload().restoreRepositorySession(), null);
});

test('a delayed restore cannot replace a newer repository selection', async () => {
  const { session, durable, reload } = fixture();
  await session.saveRepositoryDataset(dataset());
  const gate = deferred(); durable.beforeGet = () => gate.promise;
  const nextPage = reload();
  const restoring = nextPage.restoreRepositorySession();
  await turn();
  await nextPage.saveRepositoryDataset(dataset(10), { commitSha: ref(10), fileId });
  gate.resolve();
  assert.equal((await restoring).dataset.repository.headSha, ref(11));
  assert.deepEqual((await nextPage.restoreRepositorySession()).selection, { commitSha: ref(10), fileId });
});

test('refresh restores a different lab’s durable dataset and selection into a retained page', async () => {
  const { session: dataPage, reload } = fixture();
  await dataPage.saveRepositoryDataset(dataset(), { commitSha: ref(1) });
  const activityPage = reload();
  await activityPage.restoreRepositorySession();
  await activityPage.saveRepositoryDataset(dataset(10), { commitSha: null, fileId });
  assert.equal((await dataPage.restoreRepositorySession()).dataset.repository.headSha, ref(2), 'Ordinary reads use memory.');
  const refreshed = await dataPage.restoreRepositorySession({ refresh: true });
  assert.equal(refreshed.dataset.repository.headSha, ref(11));
  assert.deepEqual(refreshed.selection, { commitSha: null, fileId });
});

test('refresh sees another page’s seek within the same immutable snapshot', async () => {
  const { session: dataPage, reload } = fixture();
  await dataPage.saveRepositoryDataset(dataset());
  const activityPage = reload();
  await activityPage.restoreRepositorySession();
  activityPage.updateRepositorySelection({ commitSha: ref(1), fileId });
  assert.deepEqual((await dataPage.restoreRepositorySession({ refresh: true })).selection, { commitSha: ref(1), fileId });
});

test('refresh preserves current memory when persistence is blocked or corrupted', async () => {
  const { session, local } = fixture();
  await session.saveRepositoryDataset(dataset(), { commitSha: ref(1), fileId });
  local.blocked = true;
  assert.deepEqual((await session.restoreRepositorySession({ refresh: true })).selection, { commitSha: ref(1), fileId });
  local.blocked = false;
  local.setItem(REPOSITORY_SESSION_STORAGE_KEY, '{broken');
  assert.deepEqual((await session.restoreRepositorySession({ refresh: true })).selection, { commitSha: ref(1), fileId });
});

test('refresh never overwrites a local seek made while a durable read is pending', async () => {
  const { session, durable, reload } = fixture();
  await session.saveRepositoryDataset(dataset());
  const otherPage = reload();
  await otherPage.restoreRepositorySession();
  otherPage.updateRepositorySelection({ commitSha: null });
  const gate = deferred(); durable.beforeGet = () => gate.promise;
  const refreshing = session.restoreRepositorySession({ refresh: true });
  await turn();
  session.updateRepositorySelection({ commitSha: ref(1), fileId });
  gate.resolve();
  assert.deepEqual((await refreshing).selection, { commitSha: ref(1), fileId });
});

test('refresh protects a selection that failed to persist and later updates can retry it', async () => {
  const { session, local, reload } = fixture();
  await session.saveRepositoryDataset(dataset());
  local.blocked = true;
  session.updateRepositorySelection({ commitSha: null, fileId });
  local.blocked = false;
  assert.deepEqual((await session.restoreRepositorySession({ refresh: true })).selection, { commitSha: null, fileId });
  assert.equal(session.updateRepositorySelection({}), true, 'A cached dataset may retry its small pointer write.');
  assert.deepEqual((await reload().restoreRepositorySession()).selection, { commitSha: null, fileId });
});

test('historical delete/re-add file identities remain selectable after restore', async () => {
  const { session, reload } = fixture();
  const value = dataset();
  value.commits[0].files[0].status = 'removed';
  value.commits[1].files[0].status = 'added';
  const historicalId = `${fileId}:2`;
  await session.saveRepositoryDataset(value, { commitSha: null, fileId: historicalId });
  assert.equal((await reload().restoreRepositorySession()).selection.fileId, historicalId);
});

test('a blocked IndexedDB open falls back without leaving navigation flush pending', async () => {
  const indexedDB = () => ({ open() { const request = {}; queueMicrotask(() => request.onblocked()); return request; } });
  const session = createRepositorySession({ storage: storage(), indexedDB });
  assert.equal(await session.saveRepositoryDataset(dataset()), false);
  await session.flushRepositorySession();
  assert.equal((await session.restoreRepositorySession()).dataset.repository.headSha, ref(2));
});
