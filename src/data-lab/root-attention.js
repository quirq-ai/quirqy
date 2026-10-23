import { stateAt } from './model.js';
import { fileBytes } from './size-history.js';

// Classification colors encode the latest touched-file byte comparison, not
// file type, diff line counts, or how much horizontal attention it has received.
export const ROOT_ATTENTION_COLORS = Object.freeze({
  increase: 0x86d7ad,
  decrease: 0xcb8c87,
  same: 0xf1cf78,
  unknown: 0xb7b0a4,
});
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const directionOf = delta => delta === null ? 'unknown' : delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'same';
const addAncestors = (paths, path) => {
  if (typeof path !== 'string' || !path) return;
  let folder = parentOf(path);
  while (folder) { paths.add(folder); folder = parentOf(folder); }
  paths.add('');
};

function folderSnapshots(model, states) {
  const history = model.dataset?.sizeHistory?.version === 1 ? model.dataset.sizeHistory : null;
  const bySha = new Map((history?.commits || []).map(snapshot => [snapshot.sha, snapshot]));
  const snapshots = [history?.baseline, ...model.commits.map(commit => bySha.get(commit.sha))];
  const entries = states.map((frame, index) => snapshots[index]?.files
    || frame.files.filter(file => file.exists).map(file => ({ path: file.path, size: file.size })));
  const fullTree = snapshots.map(snapshot => snapshot?.complete === true && snapshot.files.length === snapshot.fileCount);
  // Complete measured trees establish their own inventory. A proven head tree
  // plus complete diffs can also prove an earlier inventory even if some of its
  // byte sizes are unknown. A capped/truncated list cannot make that guarantee.
  const head = states.at(-1);
  const explicitHead = model.dataset?.provenance?.completeHeadTree === true;
  const legacyHead = !history && model.repository.source !== 'github' && model.dataset?.provenance?.completeHeadTree !== false;
  let membershipKnown = (explicitHead || legacyHead) && head.sizeSummary?.fileCount === head.activeIds.length;
  const inventories = new Array(states.length);
  for (let index = states.length - 1; index >= 0; index--) {
    const present = new Set(states[index].files.filter(file => file.exists).map(file => file.path));
    const matches = entries[index].length === present.size && entries[index].every(file => present.has(file.path));
    if (fullTree[index] && matches) membershipKnown = true;
    inventories[index] = fullTree[index] || (membershipKnown && matches);
    if (index && model.commits[index - 1].partial) membershipKnown = false;
  }
  return states.map((frame, index) => {
    const totals = new Map([['', { bytes: 0, known: true }]]);
    for (const file of entries[index]) {
      if (typeof file.path !== 'string' || !file.path) continue;
      const ancestors = new Set();
      addAncestors(ancestors, file.path);
      const bytes = fileBytes(file.size);
      for (const path of ancestors) {
        const total = totals.get(path) || { bytes: 0, known: true };
        if (bytes === null) total.known = false;
        else { total.bytes += bytes; if (!Number.isSafeInteger(total.bytes)) total.known = false; }
        totals.set(path, total);
      }
    }
    const rootTotal = frame.sizeSummary?.complete === true ? fileBytes(frame.sizeSummary.totalBytes) : null;
    return path => {
      // Whole-repository totals may remain exact beyond the selected-path cap.
      if (path === '' && rootTotal !== null) return rootTotal;
      if (!inventories[index]) return null;
      const total = totals.get(path);
      // A missing folder is known empty only when the full inventory is known.
      return !total ? 0 : total.known ? total.bytes : null;
    };
  });
}

/** Exact byte comparisons for unique file and ancestor-folder touches. */
export function buildRootAttentionHistory(model) {
  const knownIds = new Set(model.nodes.map(node => node.id));
  const counts = new Map(), folderCounts = new Map();
  const states = Array.from({ length: model.commits.length + 1 }, (_, index) => stateAt(model, index - 1));
  const folderBytes = folderSnapshots(model, states);
  let before = new Map(states[0].files.map(file => [file.id, file]));
  const frames = model.commits.map((commit, index) => {
    const after = new Map(states[index + 1].files.map(file => [file.id, file]));
    const changes = new Map((commit.changes || []).filter(change => knownIds.has(change.id)).map(change => [change.id, change]));
    const touchedFolders = new Set();
    const files = [...changes].sort(([a], [b]) => compare(a, b)).map(([id, change]) => {
      const previous = before.get(id), current = after.get(id);
      if (previous?.exists) addAncestors(touchedFolders, previous.path);
      if (current?.exists) addAncestors(touchedFolders, current.path);
      addAncestors(touchedFolders, change.path);
      if (change.status === 'renamed') addAncestors(touchedFolders, change.previousPath);
      let beforeBytes = previous?.exists ? fileBytes(previous.size) : null;
      const afterBytes = current?.exists ? fileBytes(current.size) : null;
      // A known creation has no prior content. An unknown size of an existing
      // file is not zero, including when a partial diff calls it an addition.
      if ((change.status === 'added' || change.status === 'copied') && previous?.exists === false && current?.exists && afterBytes !== null) beforeBytes = 0;
      const deltaBytes = beforeBytes !== null && afterBytes !== null ? afterBytes - beforeBytes : null;
      const direction = directionOf(deltaBytes);
      const touchCount = (counts.get(id) || 0) + 1;
      counts.set(id, touchCount);
      return Object.freeze({
        id, path: current?.exists ? current.path : change.path,
        status: change.status || 'modified', commitIndex: index, commitSha: commit.sha || null,
        beforeBytes, afterBytes, deltaBytes, direction, touchCount,
      });
    });
    const folders = [...touchedFolders].sort(compare).map(path => {
      const beforeBytes = folderBytes[index](path), afterBytes = folderBytes[index + 1](path);
      const deltaBytes = beforeBytes !== null && afterBytes !== null ? afterBytes - beforeBytes : null;
      const touchCount = (folderCounts.get(path) || 0) + 1;
      folderCounts.set(path, touchCount);
      return Object.freeze({ path, commitIndex: index, commitSha: commit.sha || null,
        beforeBytes, afterBytes, deltaBytes, direction: directionOf(deltaBytes), touchCount });
    });
    before = after;
    return Object.freeze({ index, sha: commit.sha || null, files: Object.freeze(files), folders: Object.freeze(folders) });
  });
  return Object.freeze({ commitCount: frames.length, frames: Object.freeze(frames) });
}

/** Latest comparison through this cursor; baseline is neutral and has no touches. */
export function rootAttentionAt(history, requestedIndex) {
  const numeric = Number.isFinite(Number(requestedIndex)) ? Math.floor(Number(requestedIndex)) : -1;
  const index = Math.max(-1, Math.min(history.commitCount - 1, numeric));
  const files = new Map(), folders = new Map();
  for (let cursor = 0; cursor <= index; cursor++) {
    for (const file of history.frames[cursor].files) files.set(file.id, file);
    for (const folder of history.frames[cursor].folders || []) folders.set(folder.path, folder);
  }
  const frame = history.frames[index];
  return {
    index, commitCount: history.commitCount, commitSha: frame?.sha || null, files, folders,
    touchedFiles: new Set((frame?.files || []).map(file => file.id)),
    touchedFolders: new Set((frame?.folders || []).map(folder => folder.path)),
  };
}
