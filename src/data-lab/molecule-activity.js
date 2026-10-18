// Activity belongs to the loaded commit window, not the full repository history.
// These stable keys distinguish separate file identities and their historical
// folder attachments, including renames and delete/re-add cycles.
export const membershipActivityKey = (folder, fileId) => JSON.stringify([folder, fileId]);
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const freezeList = values => Object.freeze([...values]);
const point = value => Object.freeze([...value]);
const countTouch = (map, key) => map.set(key, (map.get(key) || 0) + 1);

/** A fixed curve keeps the same touch count equally bright across repositories. */
export function activityLevel(count) {
  const touches = Math.max(0, Number(count) || 0);
  return 1 - Math.exp(-touches / 4);
}

function routeFor(graph, fileId, path, status, role) {
  if (typeof path !== 'string') return null;
  const folder = parentOf(path);
  const destination = graph.folderSlots.get(folder)?.get(fileId);
  if (!destination) return null;
  const folderPaths = [];
  let current = folder;
  while (current !== null) {
    const record = graph.folderByPath.get(current);
    if (!record) return null;
    folderPaths.unshift(current);
    current = record.parent;
  }
  const points = folderPaths.map(path => point(graph.folderByPath.get(path).position));
  points.push(point(destination));
  const segments = [];
  for (let index = 1; index < folderPaths.length; index++) {
    const parent = folderPaths[index - 1], child = folderPaths[index];
    segments.push(Object.freeze({
      kind: 'folder', key: child, folder: child, parent,
      a: points[index - 1], b: points[index],
      aBackboneId: graph.folderByPath.get(parent).anchorId,
      bBackboneId: graph.folderByPath.get(child).anchorId,
      aFileId: null, bFileId: null,
    }));
  }
  const key = membershipActivityKey(folder, fileId);
  segments.push(Object.freeze({
    kind: 'membership', key, folder, fileId,
    a: points[points.length - 2], b: points[points.length - 1],
    aBackboneId: graph.folderByPath.get(folder).anchorId,
    bBackboneId: null, aFileId: null, bFileId: fileId,
  }));
  return {
    key, fileId, folder, path, paths: [path], role, roles: [role], status,
    folderPaths, points, segments,
  };
}

/**
 * Build immutable per-commit touch sets and world-space routes. A rename can
 * touch both old and new folder paths, but a file, folder or physical edge is
 * counted only once per commit. Unmapped files never influence the display.
 */
export function buildActivityHistory(model, graph) {
  const frames = (model.commits || []).map((commit, index) => {
    const fileIds = new Set(), folderPaths = new Set(), membershipKeys = new Set(), folderBondPaths = new Set();
    const routes = new Map();
    for (const change of commit.changes || []) {
      const node = graph.nodeById.get(change.id);
      if (!node) continue;
      fileIds.add(change.id);
      const status = change.status || 'modified';
      const paths = status === 'renamed' && typeof change.previousPath === 'string'
        ? [{ path: change.previousPath, role: 'previous' }, { path: change.path, role: 'current' }]
        : [{ path: change.path, role: 'current' }];
      for (const entry of paths) {
        const route = routeFor(graph, change.id, entry.path, status, entry.role);
        // Incomplete external datasets may omit a historical alias. Preserve
        // the known file's touch without inventing an incorrect path to it.
        if (!route) continue;
        const existing = routes.get(route.key);
        if (existing) {
          if (!existing.paths.includes(route.path)) existing.paths.push(route.path);
          if (!existing.roles.includes(route.role)) existing.roles.push(route.role);
          if (route.role === 'current') { existing.path = route.path; existing.role = route.role; existing.status = route.status; }
        } else routes.set(route.key, route);
        for (const path of route.folderPaths) folderPaths.add(path);
        membershipKeys.add(route.key);
        for (const path of route.folderPaths.slice(1)) folderBondPaths.add(path);
      }
    }
    const frozenRoutes = [...routes.values()].sort((a, b) => compare(a.key, b.key)).map(route => Object.freeze({
      ...route,
      paths: freezeList(route.paths), roles: freezeList(route.roles),
      folderPaths: freezeList(route.folderPaths), points: freezeList(route.points), segments: freezeList(route.segments),
    }));
    return Object.freeze({
      index, sha: commit.sha || null,
      fileIds: freezeList([...fileIds].sort(compare)), folderPaths: freezeList([...folderPaths].sort(compare)),
      membershipKeys: freezeList([...membershipKeys].sort(compare)), folderBondPaths: freezeList([...folderBondPaths].sort(compare)),
      routes: freezeList(frozenRoutes),
    });
  });
  return Object.freeze({ commitCount: frames.length, frames: freezeList(frames) });
}

/**
 * Return independent cumulative counters for the selected loaded-history prefix.
 * Baseline is index -1. Fresh Maps/Sets make arbitrary seeks and consumer edits
 * independent of earlier results; the route descriptions are deeply immutable.
 */
export function activityAt(history, requestedIndex) {
  const numeric = Number.isFinite(Number(requestedIndex)) ? Math.floor(Number(requestedIndex)) : -1;
  const index = Math.max(-1, Math.min(history.commitCount - 1, numeric));
  const fileTouches = new Map(), folderTouches = new Map(), membershipTouches = new Map(), folderBondTouches = new Map();
  for (let cursor = 0; cursor <= index; cursor++) {
    const frame = history.frames[cursor];
    for (const id of frame.fileIds) countTouch(fileTouches, id);
    for (const path of frame.folderPaths) countTouch(folderTouches, path);
    for (const key of frame.membershipKeys) countTouch(membershipTouches, key);
    for (const path of frame.folderBondPaths) countTouch(folderBondTouches, path);
  }
  const frame = history.frames[index];
  return {
    index, commitCount: history.commitCount, commitSha: frame?.sha || null,
    fileTouches, folderTouches, membershipTouches, folderBondTouches,
    touchedFiles: new Set(frame?.fileIds || []), touchedFolders: new Set(frame?.folderPaths || []),
    touchedMemberships: new Set(frame?.membershipKeys || []), touchedFolderBonds: new Set(frame?.folderBondPaths || []),
    routes: frame?.routes || Object.freeze([]),
  };
}
