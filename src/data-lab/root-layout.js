const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const depthOf = path => path ? path.split('/').length : 0;

export const ROOT_ROW_HEIGHT = 2.8;
export const ROOT_INDENT = 4.5;
export const ROOT_DEPTH_OFFSET = 0.45;

// These are right-angle polyline vertices, not Bezier control points. Keeping
// each segment on one axis preserves the familiar directory-tree connectors.
function connector(start, end) {
  return [
    [...start],
    [start[0], end[1], start[2]],
    [end[0], end[1], start[2]],
    [...end],
  ];
}

/**
 * Exact loaded paths, arranged as a computer directory outline below the soil.
 * The full hierarchy stays available in folders/nodes; only expanded and paged
 * rows are visible. Git does not record empty folders, so none are inferred.
 *
 * paths maps stable file IDs to current historical paths. With activeIds omitted,
 * pinned-head membership is used when supplied by the model. Pager start/end are
 * zero-based half-open indices into immediate children, folders before files.
 */
export function createRootLayout(model, {
  activeIds, paths, groundY = -40,
  expandedPaths = new Set(['']), pageByPath, pageSize = 32,
} = {}) {
  const ground = Number.isFinite(groundY) ? groundY : -40;
  const limit = Number.isFinite(Number(pageSize)) ? Math.max(1, Math.floor(Number(pageSize))) : 32;
  const expanded = expandedPaths instanceof Set ? expandedPaths : new Set(expandedPaths || []);
  const source = new Map((model.nodes || []).map(node => [node.id, node]));
  const active = activeIds === undefined
    ? new Set([...source.values()].filter(node => node.existsAtHead !== false).map(node => node.id))
    : activeIds instanceof Set ? activeIds : new Set(activeIds || []);
  const currentPath = node => {
    const path = paths instanceof Map ? paths.get(node.id) : paths?.[node.id];
    return typeof path === 'string' ? path : node.path;
  };
  const files = [...source.values()].filter(node => active.has(node.id)).map(node => ({ ...node, path: currentPath(node) }))
    .filter(node => typeof node.path === 'string' && node.path.length > 0)
    .sort((a, b) => compare(a.path, b.path) || compare(a.id, b.id));
  const folderPaths = new Set(['']);
  for (const file of files) {
    let parent = parentOf(file.path);
    while (parent && !folderPaths.has(parent)) {
      folderPaths.add(parent);
      parent = parentOf(parent);
    }
  }
  // Lexical prefix ordering keeps every parent before its descendants and does
  // not depend on browser locale, source ordering, or playback direction.
  const rootPosition = [0, ground - 3, 0];
  const folders = [...folderPaths].sort(compare).map(path => ({
    kind: 'folder', path,
    name: path.split('/').pop() || model.repository?.name || 'Repository',
    parent: path ? parentOf(path) : null,
    parentPath: path ? parentOf(path) : null,
    depth: depthOf(path),
    position: [...rootPosition],
    count: 0, children: [], directFiles: [],
    visible: false, expanded: expanded.has(path),
  }));
  const byPath = new Map(folders.map(folder => [folder.path, folder]));
  const nodes = files.map(file => ({
    ...file, kind: 'file', name: file.path.split('/').pop(),
    folder: parentOf(file.path), parentPath: parentOf(file.path),
    depth: depthOf(parentOf(file.path)) + 1,
    position: [...rootPosition], visible: false,
  }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const folder of folders) if (folder.parent !== null) byPath.get(folder.parent).children.push(folder.path);
  for (const node of nodes) byPath.get(node.folder).directFiles.push(node.id);
  for (const folder of [...folders].reverse()) {
    folder.count += folder.directFiles.length;
    if (folder.parent !== null) byPath.get(folder.parent).count += folder.count;
  }
  const entries = new Map();
  for (const folder of folders) {
    const children = [...folder.children.map(path => byPath.get(path)), ...folder.directFiles.map(id => byId.get(id))];
    entries.set(folder.path, children);
    folder.entryCount = children.length;
    folder.pageCount = Math.max(1, Math.ceil(children.length / limit));
    const requested = pageByPath instanceof Map ? pageByPath.get(folder.path) : pageByPath?.[folder.path];
    const page = Number.isFinite(Number(requested)) ? Math.floor(Number(requested)) : 0;
    folder.page = Math.max(0, Math.min(folder.pageCount - 1, page));
  }

  const rows = [];
  // Iterative DFS also supports unusually deep directory chains without relying
  // on the JavaScript call stack. Pagers belong to their actual parent folder.
  const pending = [byPath.get('')];
  while (pending.length) {
    const row = pending.pop();
    row.visible = true;
    row.position = [row.depth * ROOT_INDENT, rootPosition[1] - rows.length * ROOT_ROW_HEIGHT, row.depth * ROOT_DEPTH_OFFSET];
    rows.push(row);
    if (row.kind !== 'folder' || !row.expanded) continue;
    const children = entries.get(row.path);
    const start = row.page * limit;
    const end = Math.min(children.length, start + limit);
    if (row.pageCount > 1) {
      pending.push({
        kind: 'pager', id: `pager:${row.path}`, path: row.path,
        parentPath: row.path, depth: row.depth + 1,
        page: row.page, pageCount: row.pageCount,
        start, end, total: children.length,
        hasPrevious: row.page > 0, hasNext: row.page < row.pageCount - 1,
      });
    }
    for (let index = end - 1; index >= start; index--) pending.push(children[index]);
  }

  // Hidden entries retain exact parent data, but their display position falls
  // back to the nearest visible ancestor for selection/focus transitions.
  for (const folder of folders) {
    const parent = folder.parent === null ? null : byPath.get(folder.parent);
    if (!folder.visible && parent) folder.position = [...parent.position];
    folder.points = connector(parent?.position || folder.position, folder.position);
    folder.curve = folder.points;
  }
  for (const node of nodes) {
    const parent = byPath.get(node.folder);
    if (!node.visible) node.position = [...parent.position];
    node.points = connector(parent.position, node.position);
    node.curve = node.points;
  }
  for (const row of rows) if (row.kind === 'pager') {
    row.points = connector(byPath.get(row.parentPath).position, row.position);
    row.curve = row.points;
  }

  const min = [0, rootPosition[1], 0], max = [0, rootPosition[1], 0];
  const labelWidth = 18;
  for (const row of rows) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], row.position[axis]);
    max[axis] = Math.max(max[axis], row.position[axis] + (axis === 0 ? labelWidth : 0));
  }
  const margin = 2;
  for (let axis = 0; axis < 3; axis++) { min[axis] -= margin; max[axis] += margin; }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const extent = Math.hypot(...max.map((value, axis) => value - center[axis]));
  const maxDepth = Math.max(0, ...folders.map(folder => folder.depth), ...nodes.map(node => node.depth));
  return {
    folders, nodes, rows,
    bounds: { min, max }, center, extent, maxDepth,
    fileCount: nodes.length, folderCount: folders.length,
    visibleFileCount: nodes.filter(node => node.visible).length,
    visibleFolderCount: folders.filter(folder => folder.visible).length,
    groundY: ground, pageSize: limit,
    rowHeight: ROOT_ROW_HEIGHT, indent: ROOT_INDENT, depthOffset: ROOT_DEPTH_OFFSET,
  };
}
