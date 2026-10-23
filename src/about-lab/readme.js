import { parseRepositoryUrl } from '../data-lab/github.js';
import { normalizeRepositoryCount } from './repository-stats.js';
import { normalizeRepositoryWebsite } from './repository-website.js';

export const MAX_README_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = MAX_README_BYTES * 2;
const API = 'https://api.github.com';
const abortError = () => new DOMException('README loading was cancelled.', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };

// The signal also guards custom fetchers/body readers that do not implement abort.
async function abortable(work, signal) {
  checkAbort(signal);
  if (!signal) return work();
  let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => reject(abortError());
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { checkAbort(signal); return work(); }), cancelled]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

async function readJson(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_JSON_BYTES) {
    throw new Error('This README is too large to display here (maximum 1 MiB). Open it on GitHub to read it.');
  }
  // Bound streamed responses before parsing. Small mock/custom responses may expose json only.
  if (!response.body?.getReader) return abortable(() => response.json(), signal);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_BYTES) throw new Error('This README is too large to display here (maximum 1 MiB). Open it on GitHub to read it.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(path, { signal, fetcher, readme = false }) {
  let response;
  try {
    response = await abortable(() => fetcher(`${API}${path}`, {
      signal,
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json' },
    }), signal);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError();
    throw new Error('GitHub could not be reached. Check your connection and try again.');
  }
  checkAbort(signal);
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      throw new Error('GitHub has limited or denied this public request. Please try again later; API access is shared by your network.');
    }
    if (response.status === 404) {
      throw new Error(readme
        ? 'This repository does not have a README on its default branch yet.'
        : 'Repository not found. Check the URL; About supports public GitHub repositories.');
    }
    if (response.status === 409) throw new Error('This repository is empty and has no README yet.');
    throw new Error(`GitHub returned HTTP ${response.status}. Please try again later.`);
  }
  try {
    const data = await readJson(response, signal);
    checkAbort(signal);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid JSON response.');
    return data;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError();
    if (/too large/.test(error?.message)) throw error;
    throw new Error('GitHub returned an unreadable README response. Please try again.');
  }
}

function decodeReadme(data) {
  if (data.type && data.type !== 'file') throw new Error('GitHub did not return a README file.');
  if (Number(data.size) > MAX_README_BYTES) throw new Error('This README is too large to display here (maximum 1 MiB). Open it on GitHub to read it.');
  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new Error('GitHub did not return readable README content. Open the README on GitHub.');
  }
  // Check length before removing whitespace or allocating the decoded byte array.
  if (data.content.length > MAX_JSON_BYTES) throw new Error('This README is too large to display here (maximum 1 MiB). Open it on GitHub to read it.');
  const base64 = data.content.replace(/\s/g, '');
  if (base64.length > Math.ceil(MAX_README_BYTES / 3) * 4) throw new Error('This README is too large to display here (maximum 1 MiB). Open it on GitHub to read it.');
  let bytes;
  try { bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0)); }
  catch { throw new Error('GitHub returned invalid README content. Please try again.'); }
  if (bytes.byteLength > MAX_README_BYTES) throw new Error('This README is too large to display here (maximum 1 MiB). Open it on GitHub to read it.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('This README is not valid UTF-8 text. Open it on GitHub to read it.'); }
}

export function encodeRepositoryPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function repositoryDetails(metadata) {
  return {
    homepage: normalizeRepositoryWebsite(metadata.homepage),
    stars: normalizeRepositoryCount(metadata.stargazers_count),
    forks: normalizeRepositoryCount(metadata.forks_count),
    statsFetchedAt: new Date().toISOString(),
  };
}

/** Refresh cached repository details without downloading or replacing the readable README. */
export async function loadRepositoryDetails(input, { signal, fetcher = globalThis.fetch } = {}) {
  const parsed = parseRepositoryUrl(input);
  const metadata = await request(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`, { signal, fetcher });
  return repositoryDetails(metadata);
}

/** Public README from the connected repository's default branch; no source execution or credentials. */
export async function loadReadme(input, { signal, fetcher = globalThis.fetch, onProgress = () => {} } = {}) {
  const parsed = parseRepositoryUrl(input);
  const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const progress = message => { checkAbort(signal); onProgress(message); };
  progress('Reading repository details…');
  const metadata = await request(base, { signal, fetcher });
  if (!metadata.default_branch) throw new Error('This repository has no default branch to read yet.');
  // Resolve redirects/renames only through the same strict GitHub repository parser.
  let canonical = parsed;
  try { canonical = parseRepositoryUrl(`https://github.com/${metadata.full_name}`); } catch { /* Keep the validated input. */ }
  const repository = {
    fullName: canonical.fullName,
    name: String(metadata.name || canonical.repo),
    url: canonical.url,
    description: String(metadata.description || ''),
    defaultBranch: String(metadata.default_branch),
    ...repositoryDetails(metadata),
  };
  progress('Opening the repository README…');
  const data = await request(`${base}/readme?ref=${encodeURIComponent(repository.defaultBranch)}`, { signal, fetcher, readme: true });
  const path = String(data.path || 'README.md');
  if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\u0000-\u001f]/.test(path)) {
    throw new Error('GitHub returned an invalid README path.');
  }
  const markdown = decodeReadme(data);
  checkAbort(signal);
  return {
    repository,
    path,
    sha: String(data.sha || ''),
    markdown,
    htmlUrl: `${repository.url}/blob/${encodeURIComponent(repository.defaultBranch)}/${encodeRepositoryPath(path)}`,
    fetchedAt: new Date().toISOString(),
  };
}
