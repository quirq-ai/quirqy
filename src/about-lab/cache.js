import { parseRepositoryUrl } from '../data-lab/github.js';
import { MAX_README_BYTES, encodeRepositoryPath } from './readme.js';
import { normalizeRepositoryCount } from './repository-stats.js';
import { normalizeRepositoryWebsite } from './repository-website.js';
export const README_CACHE_KEY = 'quirqy.about-readme.v1';

/** Browser caches are optional and untrusted; invalid entries fall through to GitHub. */
export function readCachedReadme(input, storage) {
  try {
    const expected = parseRepositoryUrl(input);
    const saved = JSON.parse((storage ?? globalThis.localStorage).getItem(README_CACHE_KEY));
    if (!saved || parseRepositoryUrl(saved.repository?.url).url.toLowerCase() !== expected.url.toLowerCase()) return null;
    if (typeof saved.markdown !== 'string' || saved.markdown.length > MAX_README_BYTES || new TextEncoder().encode(saved.markdown).byteLength > MAX_README_BYTES) return null;
    const path = saved.path, branch = saved.repository.defaultBranch;
    if (typeof path !== 'string' || !path || path.length > 4096 || path.startsWith('/') || /[\\\u0000-\u001f]/.test(path) || path.split('/').includes('..')) return null;
    if (typeof branch !== 'string' || !branch || branch.length > 255 || !Number.isFinite(Date.parse(saved.fetchedAt))) return null;
    return {
      repository: {
        ...expected, name: expected.repo,
        description: typeof saved.repository.description === 'string' ? saved.repository.description.slice(0, 2000) : '',
        defaultBranch: branch,
        // Absence identifies legacy caches that still need metadata hydration.
        ...(Object.hasOwn(saved.repository, 'homepage') ? { homepage: normalizeRepositoryWebsite(saved.repository.homepage) } : {}),
        stars: normalizeRepositoryCount(saved.repository.stars),
        forks: normalizeRepositoryCount(saved.repository.forks),
        statsFetchedAt: typeof saved.repository.statsFetchedAt === 'string' && Number.isFinite(Date.parse(saved.repository.statsFetchedAt))
          ? saved.repository.statsFetchedAt : null,
      },
      markdown: saved.markdown, path, sha: typeof saved.sha === 'string' ? saved.sha.slice(0, 64) : '',
      htmlUrl: `${expected.url}/blob/${encodeURIComponent(branch)}/${encodeRepositoryPath(path)}`,
      fetchedAt: saved.fetchedAt, source: 'saved',
    };
  } catch { return null; }
}
