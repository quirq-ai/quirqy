import { normalizeAuthorProfile } from './author-profile.js';
import { createSizeSnapshot } from './size-history.js';

// Public GitHub metadata only. No source execution, credentials or backend.
const API = 'https://api.github.com';
const MAX_COMMITS = 20;
export const DEFAULT_REPOSITORY_COMMIT_LIMIT = 20;
const MAX_DIFF_FILES = 200;
const MAX_PATHS = 2500;
const comparePath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export function parseRepositoryUrl(input) {
  const match = /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]+)\/?$/i.exec(String(input || '').trim());
  if (!match) throw new Error('Enter a public repository URL such as https://github.com/owner/repository. Branch, file and query URLs are not supported.');
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') throw new Error('The GitHub repository name is missing or invalid.');
  return { owner, repo, fullName: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}` };
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Repository loading was cancelled.', 'AbortError');
}

async function request(path, signal) {
  checkAbort(signal);
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      signal,
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json' },
    });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw new Error('GitHub could not be reached. Check your connection and try again.');
  }
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      const seconds = Number(response.headers.get('x-ratelimit-reset'));
      const reset = seconds > 0 ? ` Try again after ${new Date(seconds * 1000).toLocaleTimeString()}.` : ' Try again later.';
      throw new Error(`GitHub has limited or denied this unauthenticated request.${reset} Public API access is shared by your network; no token is used.`);
    }
    if (response.status === 404) throw new Error('Repository or commit not found. Check the URL; this draft supports public repositories only.');
    if (response.status === 409) throw new Error('This repository has no accessible commit history yet.');
    throw new Error(`GitHub returned HTTP ${response.status}. Please try again later.`);
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('GitHub returned an unreadable response. Please try again.'); }
  return { data, more: /rel="next"/.test(response.headers.get('link') || '') };
}

function normalizeChange(file) {
  return {
    path: file.filename,
    status: file.status || 'modified',
    additions: Math.max(0, Number(file.additions) || 0),
    deletions: Math.max(0, Number(file.deletions) || 0),
    ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
  };
}

/** Commits are in first-parent order, oldest to newest. files is a fixed-layout
 * union: existsAtHead distinguishes the pinned tree from historical paths. */
export async function loadRepository(input, { signal, onProgress = () => {}, limit = DEFAULT_REPOSITORY_COMMIT_LIMIT } = {}) {
  const parsed = parseRepositoryUrl(input);
  const count = Math.min(MAX_COMMITS, Math.max(1, Math.floor(Number(limit) || DEFAULT_REPOSITORY_COMMIT_LIMIT)));
  const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const limitations = [];
  const trees = new Map();
  const readTree = treeSha => {
    if (!trees.has(treeSha)) trees.set(treeSha, request(`${base}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, signal).then(({ data }) => {
      if (!Array.isArray(data.tree)) throw new Error('GitHub did not return a usable file tree.');
      return data;
    }));
    return trees.get(treeSha);
  };
  const entries = tree => tree.tree.filter(entry => entry.type === 'blob' || entry.type === 'commit');
  const note = text => { if (!limitations.includes(text)) limitations.push(text); };
  const progress = message => { checkAbort(signal); onProgress(message); };
  progress('Reading repository details…');
  const { data: metadata } = await request(base, signal);
  if (!metadata.default_branch) throw new Error('This repository has no default branch to display.');
  progress('Pinning the default branch to one commit…');
  let detail = await request(`${base}/commits/${encodeURIComponent(metadata.default_branch)}?per_page=100&page=1`, signal);
  const headSha = detail.data.sha;
  const treeSha = detail.data.commit?.tree?.sha;
  if (!headSha || !treeSha) throw new Error('GitHub did not return a usable commit and file tree.');
  progress('Reading the pinned file tree…');
  const tree = await readTree(treeSha);
  if (tree.truncated) note('GitHub truncated the recursive tree. Some unchanged paths may be absent; membership for unreturned paths is inferred from the sampled changes.');
  const treeFiles = entries(tree)
    .map(entry => ({ path: entry.path, ...(Number.isFinite(entry.size) ? { size: entry.size } : {}) }))
    .sort(comparePath);
  if (tree.tree.some(entry => entry.type === 'commit')) note('Submodules are shown as repository entries; their internal history is not loaded.');
  const commits = [];
  let reachedRoot = false;
  for (let index = 0; index < count; index++) {
    checkAbort(signal);
    const data = detail.data;
    progress(`Reading first-parent commit ${index + 1} of ${count}…`);
    const parents = Array.isArray(data.parents) ? data.parents : [];
    const isMerge = parents.length > 1;
    let rawFiles = Array.isArray(data.files) ? data.files : [];
    let partial = false;
    if (isMerge) {
      // A direct parent-to-commit comparison avoids combined merge-diff ambiguity.
      const comparison = await request(`${base}/compare/${encodeURIComponent(parents[0].sha)}...${encodeURIComponent(data.sha)}?per_page=1`, signal);
      rawFiles = Array.isArray(comparison.data.files) ? comparison.data.files : [];
      partial = rawFiles.length > MAX_DIFF_FILES;
      note('Merge activity is the net change from its first parent. Side-branch commits are not shown separately.');
    } else if (detail.more && rawFiles.length < MAX_DIFF_FILES) {
      const next = await request(`${base}/commits/${encodeURIComponent(data.sha)}?per_page=100&page=2`, signal);
      rawFiles = rawFiles.concat(next.data.files || []);
      partial = next.more;
    } else if (detail.more) {
      partial = true;
    }
    partial ||= rawFiles.length > MAX_DIFF_FILES;
    if (partial) note(`Commit ${String(data.sha).slice(0, 7)} shows at most ${MAX_DIFF_FILES} changed files; replay and totals are partial for that commit.`);
    commits.push({
      sha: data.sha,
      treeSha: data.commit?.tree?.sha,
      firstParent: parents[0]?.sha || null,
      message: data.commit?.message || '(No commit message)',
      author: data.commit?.author?.name || data.author?.login || 'Unknown author',
      authorProfile: normalizeAuthorProfile(data.author),
      date: data.commit?.committer?.date || data.commit?.author?.date || '',
      url: `https://github.com/${parsed.fullName}/commit/${data.sha}`,
      isMerge,
      partial,
      files: rawFiles.slice(0, MAX_DIFF_FILES).filter(file => typeof file.filename === 'string').map(normalizeChange),
    });
    if (!parents[0]?.sha) { reachedRoot = true; break; }
    if (index + 1 < count) detail = await request(`${base}/commits/${encodeURIComponent(parents[0].sha)}?per_page=100&page=1`, signal);
  }
  commits.reverse(); // Do not sort timestamps: first-parent ancestry is the sequence.
  if (!reachedRoot) note(`The view covers ${commits.length} recent first-parent commits, not the repository's full history.`);

  const headByPath = new Map(treeFiles.map(file => [file.path, file]));
  const observedHead = new Map();
  // Complete chronological changes tell us the final presence of returned paths,
  // including paths missing from a truncated tree.
  for (const commit of commits) for (const file of commit.files) {
    if (file.status === 'renamed' && file.previousPath) observedHead.set(file.previousPath, false);
    observedHead.set(file.path, file.status !== 'removed');
  }
  const selected = new Set();
  // Keep changes and rename pairs before filling space with unchanged tree files.
  for (const commit of [...commits].reverse()) for (const file of commit.files) {
    const needed = [file.path, ...(file.previousPath ? [file.previousPath] : [])].filter(path => !selected.has(path));
    if (selected.size + needed.length <= MAX_PATHS) for (const path of needed) selected.add(path);
  }
  for (const file of treeFiles) {
    if (selected.size >= MAX_PATHS) break;
    selected.add(file.path);
  }
  let omittedChanges = 0;
  for (const commit of commits) {
    const before = commit.files.length;
    commit.files = commit.files.filter(file => selected.has(file.path) && (!file.previousPath || selected.has(file.previousPath)));
    omittedChanges += before - commit.files.length;
    if (before !== commit.files.length) commit.partial = true;
  }
  const omittedTree = treeFiles.some(file => !selected.has(file.path));
  if (omittedTree || omittedChanges) {
    note(`The diagram is limited to ${MAX_PATHS.toLocaleString()} paths, prioritizing sampled changes. Other paths${omittedChanges ? ' and some changes' : ''} are omitted.`);
  }
  const files = [...selected].sort().map(path => ({
    path,
    ...(headByPath.get(path)?.size != null ? { size: headByPath.get(path).size } : {}),
    existsAtHead: headByPath.has(path) || (tree.truncated && observedHead.get(path) === true),
  }));
  // Tree metadata gives exact byte sizes for text and binary blobs without
  // downloading source contents. Reuse identical tree objects, including head,
  // and keep at most two historical tree requests in flight.
  const boundarySha = commits[0]?.firstParent || null;
  let boundaryTreeSha = null;
  if (boundarySha) {
    progress('Reading the history boundary tree…');
    const { data: boundary } = await request(`${base}/git/commits/${encodeURIComponent(boundarySha)}`, signal);
    boundaryTreeSha = boundary.tree?.sha;
    if (!boundaryTreeSha) throw new Error('GitHub did not return a usable history boundary tree.');
  }
  const pendingTrees = [...new Set([...commits.map(commit => commit.treeSha), boundaryTreeSha].filter(Boolean))];
  if (commits.some(commit => !commit.treeSha)) throw new Error('GitHub did not return a usable historical file tree.');
  let nextTree = 0, completedTrees = 0, failure;
  const worker = async () => {
    while (nextTree < pendingTrees.length && !failure) {
      const sha = pendingTrees[nextTree++];
      try {
        progress(`Measuring file bytes in tree ${completedTrees + 1} of ${pendingTrees.length}…`);
        await readTree(sha);
        completedTrees++;
      } catch (error) { failure ||= error; }
    }
  };
  await Promise.all([worker(), worker()]);
  if (failure) throw failure;
  checkAbort(signal);
  const snapshot = async (sha, treeSha) => {
    if (!treeSha) return createSizeSnapshot([], { sha, selectedPaths: selected });
    const data = await readTree(treeSha);
    if (data.truncated) note('Some historical trees were truncated by GitHub. Byte totals are partial where tree entries or their sizes are unavailable.');
    return createSizeSnapshot(entries(data), { sha, treeSha, complete: !data.truncated, selectedPaths: selected });
  };
  const sizeHistory = {
    version: 1,
    baseline: await snapshot(boundarySha, boundaryTreeSha),
    commits: await Promise.all(commits.map(commit => snapshot(commit.sha, commit.treeSha))),
  };
  const partialSizes = [sizeHistory.baseline, ...sizeHistory.commits].some(snapshot => !snapshot.complete);
  if (partialSizes) note('Unknown file sizes, including submodule entries, remain unknown; displayed known bytes are not presented as a complete repository total.');
  note('Line additions and deletions describe Git diffs; they do not measure runtime behavior, code quality or individual productivity.');
  progress('Preparing the repository map…');
  return {
    repository: {
      name: metadata.name || parsed.repo,
      fullName: metadata.full_name || parsed.fullName,
      url: parsed.url,
      branch: metadata.default_branch,
      description: metadata.description || '',
      source: 'github',
      headSha,
    },
    files,
    commits,
    sizeHistory,
    coverage: {
      label: `${commits.length} first-parent commits · pinned ${String(headSha).slice(0, 7)}${tree.truncated || omittedChanges || omittedTree || partialSizes || commits.some(commit => commit.partial) ? ' · partial coverage' : ''}`,
      limitations,
    },
  };
}
