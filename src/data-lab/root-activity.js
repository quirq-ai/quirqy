// Root strands describe touches in the loaded commit window only. The history
// is independent of layout, visibility, rendering limits and animation time.
export const rootMembershipKey = (folder, fileId) => JSON.stringify([folder, fileId]);
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const immutableSorted = values => Object.freeze([...values].sort(compare));
const addTouch = (map, key) => map.set(key, (map.get(key) || 0) + 1);

/**
 * Unique per-commit touches for every known loaded file identity and real path.
 * Rename commits touch both attachments, but each file, ancestor and attachment
 * counts at most once in that commit. The trunk path '' is included in ancestry;
 * every other folder path identifies its edge from its immediate parent.
 */
export function buildRootActivityHistory(model) {
  const knownIds = new Set((model.nodes || []).map(node => node.id));
  const frames = (model.commits || []).map((commit, index) => {
    const fileIds = new Set(), folderPaths = new Set(), membershipKeys = new Set();
    for (const change of commit.changes || []) {
      if (!knownIds.has(change.id)) continue;
      fileIds.add(change.id);
      const paths = change.status === 'renamed' ? [change.previousPath, change.path] : [change.path];
      for (const path of paths) {
        // Incomplete changes can still identify a touched file. Do not fabricate
        // its historical route from today's path when the actual path is absent.
        if (typeof path !== 'string' || !path.length) continue;
        const folder = parentOf(path);
        membershipKeys.add(rootMembershipKey(folder, change.id));
        let ancestor = folder;
        while (ancestor) { folderPaths.add(ancestor); ancestor = parentOf(ancestor); }
        folderPaths.add('');
      }
    }
    return Object.freeze({
      index, sha: commit.sha || null,
      fileIds: immutableSorted(fileIds),
      folderPaths: immutableSorted(folderPaths),
      membershipKeys: immutableSorted(membershipKeys),
    });
  });
  return Object.freeze({ commitCount: frames.length, frames: Object.freeze(frames) });
}

/**
 * Absolute cumulative counts through the selected commit, with baseline at -1.
 * Fresh Maps/Sets prevent scrubbing order and consumer mutation from changing a
 * later result. Appending future commits never changes an earlier prefix count.
 */
export function rootActivityAt(history, requestedIndex) {
  const numeric = Number.isFinite(Number(requestedIndex)) ? Math.floor(Number(requestedIndex)) : -1;
  const index = Math.max(-1, Math.min(history.commitCount - 1, numeric));
  const fileTouches = new Map(), folderTouches = new Map(), membershipTouches = new Map();
  for (let cursor = 0; cursor <= index; cursor++) {
    const frame = history.frames[cursor];
    for (const id of frame.fileIds) addTouch(fileTouches, id);
    for (const path of frame.folderPaths) addTouch(folderTouches, path);
    for (const key of frame.membershipKeys) addTouch(membershipTouches, key);
  }
  const frame = history.frames[index];
  return {
    index, commitCount: history.commitCount, commitSha: frame?.sha || null,
    fileTouches, folderTouches, membershipTouches,
    touchedFiles: new Set(frame?.fileIds || []),
    touchedFolders: new Set(frame?.folderPaths || []),
    touchedMemberships: new Set(frame?.membershipKeys || []),
  };
}

/**
 * Physical growth for the routes that exist in the selected layout. A file uses
 * only its current folder attachment's touches. Each current folder carries
 * its cumulative historical touches: every commit affecting any descendant
 * grows that folder once, including when a file later moves or is deleted.
 * Only routes in the current layout are projected; historical data is unchanged.
 */
export function rootPathGrowth(layout, activityState) {
  const files = [...(layout.nodes || [])].sort((a, b) => compare(a.id, b.id));
  const paths = [...new Set((layout.folders || []).map(folder => folder.path))].sort(compare);
  const fileTouches = new Map();
  const folderTouches = new Map(paths.map(path => {
    const count = activityState?.folderTouches?.get(path);
    return [path, Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0];
  }));
  for (const file of files) {
    const folder = typeof file.folder === 'string' ? file.folder : parentOf(file.path || '');
    const count = activityState?.membershipTouches?.get(rootMembershipKey(folder, file.id));
    const touches = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    fileTouches.set(file.id, touches);
  }
  return { fileTouches, folderTouches };
}
