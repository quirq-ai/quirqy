import { parseRepositoryUrl } from '../data-lab/github.js';
import { buildModel } from '../data-lab/model.js';

// Only repository metadata is cached. Authentication and source blobs do not
// belong in this session. The small pointer can be saved synchronously on seek.
export const REPOSITORY_SESSION_STORAGE_KEY = 'quirq-observatory.repository-session.v1';
const SCHEMA = 1;
const DATABASE = 'quirq-observatory.repository-cache';
const STORE = 'snapshots';
const SHA = /^[a-f\d]{40}$/i;
const STATUSES = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => structuredClone(value);
const validDate = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const string = (value, max, fallback = '') => {
  requireValue(value == null || (typeof value === 'string' && value.length <= max), 'Invalid metadata text.');
  return value ?? fallback;
};
const count = value => {
  requireValue(Number.isSafeInteger(value) && value >= 0, 'Invalid metadata count.');
  return value;
};
function path(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !value.startsWith('/') && !value.includes('\0')
    && !value.split('/').some(part => part === '.' || part === '..' || part === ''), 'Invalid repository path.');
  return value;
}
function sha(value) {
  requireValue(typeof value === 'string' && SHA.test(value), 'Invalid commit reference.');
  return value.toLowerCase();
}

function normalizeAuthorProfile(profile) {
  if (!profile || typeof profile.login !== 'string'
    || !/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}(?:\[bot\])?$/i.test(profile.login)) return null;
  let avatarUrl = null;
  const candidate = profile.avatarUrl ?? profile.avatar_url;
  if (typeof candidate === 'string' && /^\/data-lab\/authors\/[a-z\d_-]+\.(?:png|jpe?g|webp)$/i.test(candidate)) avatarUrl = candidate;
  else if (typeof candidate === 'string') {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname === 'avatars.githubusercontent.com'
        && !url.username && !url.password && !url.port && !url.hash) avatarUrl = url.href;
    } catch { /* An invalid image URL falls back to initials. */ }
  }
  return { login: profile.login, avatarUrl, url: `https://github.com/${encodeURIComponent(profile.login)}` };
}

/** Copy an allowlist of metadata fields, never arbitrary imported properties. */
function normalizeDataset(input) {
  requireValue(input && typeof input === 'object' && input.repository, 'Missing repository metadata.');
  const repo = input.repository;
  requireValue(typeof repo.url === 'string' && repo.url.length <= 512, 'Missing public repository URL.');
  const parsed = parseRepositoryUrl(repo.url);
  requireValue(repo.source === 'example' || repo.source === 'github', 'Unsupported repository source.');
  const branch = string(repo.branch, 256);
  requireValue(branch.length > 0 && !/[\u0000-\u001f]/.test(branch), 'Missing repository branch.');
  const headSha = sha(repo.headSha);
  const repository = {
    name: parsed.repo, fullName: parsed.fullName, url: parsed.url,
    branch, source: repo.source, headSha,
  };
  if (repo.description != null) repository.description = string(repo.description, 8192);
  if (repo.treeSha != null) repository.treeSha = sha(repo.treeSha);
  if (repo.capturedAt != null) {
    requireValue(validDate(repo.capturedAt), 'Invalid snapshot date.');
    repository.capturedAt = repo.capturedAt;
  }
  requireValue(repo.source !== 'example' || repository.capturedAt, 'Missing example snapshot date.');
  requireValue(Array.isArray(input.files) && input.files.length <= 10000, 'Invalid repository file list.');
  const paths = new Set();
  const files = input.files.map(file => {
    const value = { path: path(file?.path), existsAtHead: file.existsAtHead !== false };
    requireValue(!paths.has(value.path), 'Duplicate repository path.');
    paths.add(value.path);
    requireValue(file.existsAtHead == null || typeof file.existsAtHead === 'boolean', 'Invalid head membership.');
    if (file.size != null) value.size = count(file.size);
    return value;
  });
  requireValue(Array.isArray(input.commits) && input.commits.length <= 500, 'Invalid commit history.');
  const commitsSeen = new Set();
  const commits = input.commits.map(commit => {
    const commitSha = sha(commit?.sha);
    requireValue(!commitsSeen.has(commitSha), 'Duplicate commit reference.');
    commitsSeen.add(commitSha);
    const date = string(commit.date, 64);
    requireValue(date === '' || validDate(date), 'Invalid commit date.');
    requireValue(Array.isArray(commit.files) && commit.files.length <= 10000, 'Invalid commit changes.');
    const changedPaths = new Set();
    const changes = commit.files.map(file => {
      const filePath = path(file?.path);
      requireValue(paths.has(filePath) && !changedPaths.has(filePath), 'Change is missing from the file union or is duplicated.');
      changedPaths.add(filePath);
      const status = file.status || 'modified';
      requireValue(STATUSES.has(status), 'Invalid file status.');
      const value = { path: filePath, status, additions: count(file.additions ?? 0), deletions: count(file.deletions ?? 0) };
      if (file.previousPath != null) {
        value.previousPath = path(file.previousPath);
        requireValue(paths.has(value.previousPath), 'Rename source is missing from the file union.');
      }
      requireValue(!['renamed', 'copied'].includes(status) || value.previousPath, 'Missing previous file path.');
      if (file.binary != null) {
        requireValue(typeof file.binary === 'boolean', 'Invalid binary marker.');
        value.binary = file.binary;
      }
      return value;
    });
    const value = {
      sha: commitSha, message: string(commit.message, 131072, '(No commit message)'),
      author: string(commit.author, 1024, 'Unknown author'), date,
      url: `${parsed.url}/commit/${commitSha}`, isMerge: commit.isMerge === true,
      partial: commit.partial === true, files: changes,
    };
    if (commit.authorProfile != null) value.authorProfile = normalizeAuthorProfile(commit.authorProfile);
    if (owns(commit, 'firstParent')) value.firstParent = commit.firstParent === null ? null : sha(commit.firstParent);
    return value;
  });
  requireValue(!commits.length || commits.at(-1).sha === headSha, 'History does not end at the pinned head.');
  for (let index = 1; index < commits.length; index++) {
    requireValue(!owns(commits[index], 'firstParent') || commits[index].firstParent === commits[index - 1].sha,
      'History does not follow its first-parent sequence.');
  }
  const limitations = input.coverage?.limitations ?? [];
  requireValue(Array.isArray(limitations) && limitations.length <= 200, 'Invalid coverage notes.');
  const coverage = {
    label: string(input.coverage?.label, 2048), limitations: limitations.map(note => string(note, 8192)),
  };
  const dataset = { repository, files, commits, coverage };
  if (input.provenance && typeof input.provenance === 'object') {
    const source = input.provenance;
    const provenance = {};
    for (const key of ['formatVersion', 'commitCount', 'bundledCommitCount', 'headFileCount', 'historicalPathCount', 'changedFileCount', 'binaryChangeCount']) {
      if (source[key] != null) provenance[key] = count(source[key]);
    }
    for (const key of ['generator', 'source', 'branchRef']) if (source[key] != null) provenance[key] = string(source[key], 512);
    if (source.remote != null) provenance.remote = `${parsed.url}.git`;
    for (const key of ['headSha', 'treeSha', 'firstParentBoundarySha']) {
      if (owns(source, key)) provenance[key] = source[key] === null ? null : sha(source[key]);
    }
    if (source.capturedAt != null) {
      requireValue(validDate(source.capturedAt), 'Invalid provenance date.');
      provenance.capturedAt = source.capturedAt;
    }
    for (const key of ['completeHeadTree', 'completeCommitDiffs']) {
      if (source[key] != null) { requireValue(typeof source[key] === 'boolean', 'Invalid coverage flag.'); provenance[key] = source[key]; }
    }
    if (source.diff && typeof source.diff === 'object') {
      provenance.diff = {};
      for (const key of ['parent', 'renameThreshold', 'algorithm']) if (source.diff[key] != null) provenance.diff[key] = string(source.diff[key], 64);
      if (typeof source.diff.indentHeuristic === 'boolean') provenance.diff.indentHeuristic = source.diff.indentHeuristic;
    }
    dataset.provenance = provenance;
  }
  return dataset;
}

function datasetKey(dataset) {
  const { repository, commits } = dataset;
  // The pointer changes; this identity always describes one pinned history window.
  return JSON.stringify([SCHEMA, repository.url.toLowerCase(), repository.branch, repository.headSha,
    commits[0]?.sha || null, commits.length, repository.source]);
}
function prepare(input, selection, savedAt) {
  const dataset = normalizeDataset(input);
  const key = datasetKey(dataset);
  const bytes = new TextEncoder().encode(JSON.stringify(dataset)).length + 2048;
  // Keep corrupted or unbounded inputs from building an excessive replay model.
  requireValue(bytes <= 16 * 1024 * 1024, 'Repository metadata is too large.');
  const fileIds = new Set(buildModel(dataset).nodes.map(node => node.id));
  const entry = { key, dataset, bytes, fileIds, savedAt, cached: false, persisted: false };
  entry.selection = normalizeSelection(entry, selection);
  return entry;
}
function normalizeSelection(entry, selection = {}) {
  const requested = selection?.commitSha;
  const commitSha = requested === null ? null
    : typeof requested === 'string' && entry.dataset.commits.some(commit => commit.sha === requested.toLowerCase())
      ? requested.toLowerCase() : entry.dataset.commits.at(-1)?.sha || null;
  const fileId = typeof selection?.fileId === 'string' && entry.fileIds.has(selection.fileId) ? selection.fileId : null;
  return { commitSha, fileId };
}
function snapshot(entry) {
  return entry ? { dataset: clone(entry.dataset), selection: { ...entry.selection }, savedAt: entry.savedAt } : null;
}
function pointerFor(entry) {
  return { schema: SCHEMA, key: entry.key, selection: { ...entry.selection }, savedAt: entry.savedAt };
}
function parsePointer(value) {
  if (typeof value !== 'string' || value.length > 32768) return null;
  try {
    const pointer = JSON.parse(value);
    return pointer?.schema === SCHEMA && typeof pointer.key === 'string' && pointer.key.length <= 2048
      && validDate(pointer.savedAt) ? pointer : null;
  } catch { return null; }
}

// Select before writing, so a quota/bounds failure cannot evict the previous
// durable session. The protected entry stays until its replacement pointer saves.
function retainedRecords(records, record, { maxEntries, maxBytes, protectedKey }) {
  const existing = records.filter(item => item?.schema === SCHEMA && typeof item.key === 'string'
    && Number.isSafeInteger(item.bytes) && item.bytes > 0 && validDate(item.savedAt) && item.key !== record.key);
  const protectedRecord = existing.find(item => item.key === protectedKey);
  const required = [record, ...(protectedRecord ? [protectedRecord] : [])];
  let bytes = required.reduce((total, item) => total + item.bytes, 0);
  if (required.length > maxEntries || bytes > maxBytes) return null;
  const retained = new Set(required.map(item => item.key));
  for (const item of existing.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))) {
    if (retained.has(item.key) || retained.size >= maxEntries || bytes + item.bytes > maxBytes) continue;
    retained.add(item.key);
    bytes += item.bytes;
  }
  return retained;
}

/** IndexedDB access is lazy: importing this module is safe without a browser. */
async function openIndexedBackend(getIndexedDB, timeoutMs = 2000) {
  const indexedDB = getIndexedDB();
  if (!indexedDB) return null;
  const db = await new Promise((resolve, reject) => {
    let finished = false;
    const request = indexedDB.open(DATABASE, SCHEMA);
    const timer = setTimeout(() => { finished = true; reject(new Error('Repository cache is unavailable.')); }, timeoutMs);
    const fail = () => {
      if (finished) return;
      finished = true; clearTimeout(timer); reject(request.error || new Error('Repository cache is blocked.'));
    };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onerror = fail;
    request.onblocked = fail;
    request.onsuccess = () => {
      if (finished) { request.result.close(); return; }
      finished = true; clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  function transact(mode, action) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error('Repository cache write failed.'));
      transaction.onerror = () => {}; // onabort carries transaction failures.
      action(transaction.objectStore(STORE), value => { result = value; });
    });
  }
  return {
    get: key => transact('readonly', (store, result) => { store.get(key).onsuccess = event => result(event.target.result || null); }),
    commit: (record, limits) => transact('readwrite', (store, result) => {
      store.getAll().onsuccess = event => {
        const records = event.target.result;
        const retained = retainedRecords(records, record, limits);
        if (!retained) { result(false); return; }
        store.put(record);
        for (const item of records) if (!retained.has(item.key)) store.delete(item.key);
        result(true);
      };
    }),
    clear: () => transact('readwrite', (store, result) => { store.clear(); result(true); }),
  };
}

/**
 * Inject storage (object/getter), backend (object/async factory), and now for tests.
 * A backend implements get(key), commit(record, limits), and clear(). commit must
 * atomically enforce maxEntries/maxBytes while retaining limits.protectedKey.
 */
export function createRepositorySession(options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.min(5, Math.max(2, Math.floor(options.maxEntries))) : 4;
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(4096, Math.floor(options.maxBytes)) : 8 * 1024 * 1024;
  const now = options.now || Date.now;
  let current = null, revision = 0, clearedAt = 0, durablePointer = null;
  let queue = Promise.resolve(), backendPromise = null, restoring = null;
  const getStorage = () => {
    try {
      if (owns(options, 'storage')) return typeof options.storage === 'function' ? options.storage() : options.storage;
      return globalThis.localStorage;
    } catch { return null; }
  };
  const readPointer = () => {
    try { return parsePointer(getStorage()?.getItem(REPOSITORY_SESSION_STORAGE_KEY)); }
    catch { return null; }
  };
  const writePointer = entry => {
    const pointer = pointerFor(entry);
    try {
      const storage = getStorage();
      if (!storage) return false;
      storage.setItem(REPOSITORY_SESSION_STORAGE_KEY, JSON.stringify(pointer));
      durablePointer = pointer;
      return true;
    } catch { return false; }
  };
  const getBackend = () => {
    if (!backendPromise) backendPromise = Promise.resolve().then(() => owns(options, 'backend')
      ? typeof options.backend === 'function' ? options.backend() : options.backend
      : openIndexedBackend(options.indexedDB || (() => globalThis.indexedDB)));
    return backendPromise;
  };
  const enqueue = operation => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => false);
    return queue;
  };

  function saveRepositoryDataset(dataset, selection = {}) {
    let entry;
    try { entry = prepare(dataset, selection, new Date(now()).toISOString()); }
    catch { return Promise.resolve(false); }
    entry.revision = ++revision;
    current = entry;
    return enqueue(async () => {
      try {
        // Reserve room for both the previous durable session and its replacement.
        if (entry.bytes > maxBytes / 2) return false;
        const backend = await getBackend();
        if (!backend) return false;
        const previous = readPointer() || durablePointer;
        const saved = await backend.commit({
          schema: SCHEMA, key: entry.key, dataset: clone(entry.dataset), bytes: entry.bytes, savedAt: entry.savedAt,
        }, { maxEntries, maxBytes, protectedKey: previous?.key || null });
        if (!saved || entry.revision < clearedAt) return false;
        entry.cached = true;
        entry.persisted = writePointer(entry);
        return entry.persisted;
      } catch { backendPromise = null; return false; }
    });
  }

  function updateRepositorySelection(selection = {}) {
    if (!current) return false;
    current.selection = normalizeSelection(current, { ...current.selection, ...selection });
    revision++;
    current.persisted = current.cached ? writePointer(current) : false;
    return current.persisted;
  }

  async function flushRepositorySession() {
    let pending;
    do { pending = queue; await pending; } while (pending !== queue);
  }

  async function restoreRepositorySession({ refresh = false } = {}) {
    await flushRepositorySession();
    // BFCache restores can retain a previous page's memory after another lab
    // changes the repository. Re-read storage unless local changes are unsaved.
    if (current && (!refresh || !current.persisted)) return snapshot(current);
    if (restoring) return restoring;
    const startedAt = revision;
    restoring = (async () => {
      const pointer = readPointer();
      if (!pointer) return snapshot(current);
      try {
        const backend = await getBackend();
        const record = await backend?.get(pointer.key);
        if (revision !== startedAt) return snapshot(current);
        if (!record || record.schema !== SCHEMA || !validDate(record.savedAt)) return snapshot(current);
        const entry = prepare(record.dataset, pointer.selection, record.savedAt);
        if (record.key !== pointer.key || entry.key !== pointer.key || entry.bytes > maxBytes / 2) return snapshot(current);
        if (revision !== startedAt) return snapshot(current);
        entry.cached = true;
        entry.persisted = true;
        current = entry;
        durablePointer = pointerFor(entry);
        return snapshot(entry);
      } catch { backendPromise = null; return snapshot(current); }
      finally { restoring = null; }
    })();
    // The no-pointer early return also needs to release this coalesced read.
    try { return await restoring; } finally { restoring = null; }
  }

  function clearRepositorySession() {
    current = null;
    clearedAt = ++revision;
    durablePointer = null;
    try { getStorage()?.removeItem(REPOSITORY_SESSION_STORAGE_KEY); } catch { /* Memory still clears. */ }
    return enqueue(async () => {
      try { return (await getBackend())?.clear() || false; }
      catch { backendPromise = null; return false; }
    });
  }

  return { restoreRepositorySession, saveRepositoryDataset, updateRepositorySelection, flushRepositorySession, clearRepositorySession };
}

const session = createRepositorySession();
export const restoreRepositorySession = (...args) => session.restoreRepositorySession(...args);
export const saveRepositoryDataset = (...args) => session.saveRepositoryDataset(...args);
export const updateRepositorySelection = (...args) => session.updateRepositorySelection(...args);
export const flushRepositorySession = (...args) => session.flushRepositorySession(...args);
export const clearRepositorySession = (...args) => session.clearRepositorySession(...args);
