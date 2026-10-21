import { createSizeSnapshot, fileBytes, sizeSummary } from './size-history.js';

// Deterministic file identities and replay states, shared by both visualizations.
const topDirectory = path => path.includes('/') ? path.split('/')[0] : '(root)';
const parentPath = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const lines = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function buildModel(dataset) {
  if (!dataset?.repository || !Array.isArray(dataset.files) || !Array.isArray(dataset.commits)) {
    throw new Error('The repository dataset is missing its files or commits.');
  }
  const nodes = [];
  const usedPaths = new Map();
  const nodeById = new Map();
  const makeNode = (path, file = {}) => {
    const ordinal = (usedPaths.get(path) || 0) + 1;
    usedPaths.set(path, ordinal);
    const id = `file:${encodeURIComponent(path)}${ordinal > 1 ? `:${ordinal}` : ''}`;
    const node = {
      id, path, name: path.split('/').pop(), directory: topDirectory(path), parentPath: parentPath(path),
      size: fileBytes(file.size), aliases: new Set([path]), existsAtHead: file.existsAtHead === true,
    };
    nodes.push(node);
    nodeById.set(id, node);
    return node;
  };
  const current = new Map();
  // Backwards compatibility: an unannotated file array means the head tree.
  for (const file of [...dataset.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (typeof file.path !== 'string' || file.existsAtHead === false || current.has(file.path)) continue;
    const node = makeNode(file.path, { ...file, existsAtHead: true });
    current.set(file.path, node.id);
  }
  const commits = dataset.commits.map(commit => ({ ...commit, changes: [] }));
  const snapshots = new Array(commits.length + 1);
  snapshots[commits.length] = new Map(current);
  const reconstructionNotes = [];
  const uncertain = message => { if (!reconstructionNotes.includes(message)) reconstructionNotes.push(message); };

  // Work from the pinned head tree backwards. A rename reuses its destination's
  // identity. A deletion followed by a new file at the same path gets two IDs.
  for (let index = commits.length - 1; index >= 0; index--) {
    const commit = commits[index];
    const after = new Map(current);
    const changes = [];
    for (const file of commit.files || []) {
      if (typeof file.path !== 'string') continue;
      let id;
      if (file.status === 'removed') {
        id = makeNode(file.path).id;
      } else {
        id = after.get(file.path);
        if (!id) {
          id = makeNode(file.path).id;
          after.set(file.path, id);
          uncertain('Some file membership was inferred from commit changes because the returned head tree or diff coverage was incomplete.');
        }
      }
      const node = nodeById.get(id);
      node.aliases.add(file.path);
      if (file.previousPath) node.aliases.add(file.previousPath);
      changes.push({
        id, path: file.path, status: file.status || 'modified',
        additions: lines(file.additions), deletions: lines(file.deletions),
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        ...(Object.hasOwn(file, 'sizeBefore') ? { sizeBefore: fileBytes(file.sizeBefore) } : {}),
        ...(Object.hasOwn(file, 'sizeAfter') ? { sizeAfter: fileBytes(file.sizeAfter) } : {}),
      });
    }
    commit.changes = changes;
    snapshots[index + 1] = after;
    current.clear();
    for (const [path, id] of after) current.set(path, id);
    // Remove all post-commit destinations before restoring pre-commit sources.
    for (const change of changes) {
      if (change.status === 'added' || change.status === 'copied' || (change.status === 'renamed' && change.previousPath)) {
        current.delete(change.path);
      }
    }
    for (const change of changes) {
      if (change.status === 'removed') current.set(change.path, change.id);
      else if (change.status === 'renamed' && change.previousPath) current.set(change.previousPath, change.id);
      else if (change.status !== 'added' && change.status !== 'copied') current.set(change.path, change.id);
    }
    snapshots[index] = new Map(current);
  }
  // Byte state is separate from stable file identity and membership. A complete
  // tree snapshot is authoritative even when the commit's diff listing is partial.
  // Legacy inputs know only head bytes: crossing an edited edge invalidates that
  // earlier size instead of projecting today's bytes backwards through history.
  const sizeHistory = dataset.sizeHistory?.version === 1 ? dataset.sizeHistory : null;
  if (!sizeHistory && dataset.repository.source === 'github') uncertain('Historical byte sizes may be unavailable in this saved dataset. Reload the repository to fetch measured file sizes.');
  const historyBySha = new Map((sizeHistory?.commits || []).map(snapshot => [snapshot.sha, snapshot]));
  const sizeSnapshots = new Array(snapshots.length), sizeSummaries = new Array(snapshots.length);
  let currentSizes = new Map(nodes.map(node => [node.id, node.size]));
  // Old URL imports did not record whether their head tree hit a display/API
  // limit. Without an explicit full-tree guarantee, their sums are known bytes
  // only, even if every retained file happens to have a size.
  let completeMembership = dataset.provenance?.completeHeadTree === true
    || (dataset.repository.source !== 'github' && dataset.provenance?.completeHeadTree !== false);
  for (let frame = commits.length; frame >= 0; frame--) {
    const membership = snapshots[frame];
    const exact = frame === 0 ? sizeHistory?.baseline : historyBySha.get(commits[frame - 1].sha);
    if (exact && Array.isArray(exact.files)) {
      const byPath = new Map(exact.files.map(file => [file.path, fileBytes(file.size)]));
      currentSizes = new Map([...membership].map(([path, id]) => [id, byPath.get(path) ?? null]));
    } else {
      for (const change of commits[frame - 1]?.changes || []) {
        if (Object.hasOwn(change, 'sizeAfter') && membership.get(change.path) === change.id) currentSizes.set(change.id, change.sizeAfter);
      }
    }
    const sizes = new Map([...membership].map(([, id]) => [id, currentSizes.get(id) ?? null]));
    sizeSnapshots[frame] = sizes;
    sizeSummaries[frame] = sizeSummary(exact || createSizeSnapshot([...membership].map(([path, id]) => ({ path, size: sizes.get(id) })), { complete: completeMembership }));
    if (!frame) continue;
    const commit = commits[frame - 1];
    if (commit.partial) completeMembership = false;
    for (const change of commit.changes) {
      if (change.status === 'added' || change.status === 'copied') currentSizes.delete(change.id);
      else currentSizes.set(change.id, Object.hasOwn(change, 'sizeBefore') ? change.sizeBefore : null);
    }
  }
  for (const node of nodes) node.aliases = [...node.aliases].sort();
  nodes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.id < b.id ? -1 : 1);
  const groupCounts = new Map();
  for (const node of nodes) groupCounts.set(node.directory, (groupCounts.get(node.directory) || 0) + 1);
  const directories = [...groupCounts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, count]) => ({ path, name: path, count }));
  return {
    dataset,
    repository: dataset.repository,
    nodes,
    commits,
    directories,
    baseline: [...snapshots[0]].map(([path, id]) => ({ id, path })),
    coverage: {
      label: dataset.coverage?.label || `${commits.length} sampled commits`,
      limitations: [...(dataset.coverage?.limitations || []), ...reconstructionNotes],
    },
    _snapshots: snapshots,
    _sizeSnapshots: sizeSnapshots,
    _sizeSummaries: sizeSummaries,
    _stateCache: new Map(),
  };
}

export function stateAt(model, requestedIndex) {
  const numeric = Number.isFinite(Number(requestedIndex)) ? Math.floor(Number(requestedIndex)) : -1;
  const index = Math.max(-1, Math.min(model.commits.length - 1, numeric));
  if (model._stateCache.has(index)) return model._stateCache.get(index);
  const commit = model.commits[index] || null;
  const snapshot = model._snapshots[index + 1];
  const paths = new Map([...snapshot].map(([path, id]) => [id, path]));
  const changes = new Map((commit?.changes || []).map(change => [change.id, change]));
  const maxLines = Math.max(1, ...[...changes.values()].map(change => change.additions + change.deletions));
  const files = model.nodes.map(node => {
    const change = changes.get(node.id);
    return {
      ...node,
      size: paths.has(node.id) ? model._sizeSnapshots[index + 1].get(node.id) ?? null : null,
      path: paths.get(node.id) || change?.path || node.path,
      exists: paths.has(node.id),
      activity: change ? 0.3 + 0.7 * Math.log1p(change.additions + change.deletions) / Math.log1p(maxLines) : 0,
      status: change?.status || 'unchanged',
      additions: change?.additions || 0,
      deletions: change?.deletions || 0,
      ...(change?.previousPath ? { previousPath: change.previousPath } : {}),
    };
  });
  const changed = [...changes.values()];
  const result = {
    index,
    commit,
    files,
    activeIds: [...paths.keys()],
    changedIds: [...changes.keys()],
    sizeSummary: { ...model._sizeSummaries[index + 1] },
    summary: {
      activeFiles: paths.size,
      totalFiles: model.nodes.length,
      changedFiles: changes.size,
      addedFiles: changed.filter(change => change.status === 'added' || change.status === 'copied').length,
      removedFiles: changed.filter(change => change.status === 'removed').length,
      renamedFiles: changed.filter(change => change.status === 'renamed').length,
      additions: changed.reduce((sum, change) => sum + change.additions, 0),
      deletions: changed.reduce((sum, change) => sum + change.deletions, 0),
    },
  };
  model._stateCache.set(index, result);
  return result;
}

export function activityInsights(model, index) {
  const state = stateAt(model, index);
  if (!state.commit) return ['Baseline before the sampled commit window. File membership is reconstructed from the pinned tree and loaded changes.'];
  const { summary, commit } = state;
  const folders = new Map();
  for (const change of commit.changes) {
    const folder = topDirectory(change.path);
    folders.set(folder, (folders.get(folder) || 0) + 1);
  }
  const ranked = [...folders].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const insights = [`${summary.changedFiles} ${summary.changedFiles === 1 ? 'file changes' : 'files change'} in this commit; ${summary.activeFiles} sampled files exist after it.`];
  if (ranked.length) insights.push(`${ranked[0][0]} has the most changed paths (${ranked[0][1]}) across ${ranked.length} ${ranked.length === 1 ? 'directory' : 'directories'}.`);
  if (summary.addedFiles || summary.removedFiles) insights.push(`${summary.addedFiles} added · ${summary.removedFiles} removed. Absent files remain available in the inspector and historical-file view.`);
  if (summary.renamedFiles) insights.push(`${summary.renamedFiles} ${summary.renamedFiles === 1 ? 'rename keeps its' : 'renames keep their'} node identity through the history.`);
  if (commit.isMerge) insights.push('This merge shows the net change from its first parent, not each side-branch commit.');
  if (commit.partial) insights.push('This commit has a partial file listing; displayed counts cover only returned paths.');
  return insights;
}
