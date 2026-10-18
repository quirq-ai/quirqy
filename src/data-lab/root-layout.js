const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const depthOf = path => path ? path.split('/').length : 0;

export const ROOT_TIER_HEIGHT = 16;
const TIP_FOOTPRINT = 3.2;
const SIBLING_GAP = 2.2;
const MAX_WIDTH = 160;
const MAX_DEPTH = 100;

// Small groups form the familiar horizontal sibling row. Dense groups use
// symmetric rows in Z, preserving every real child without an enormous strip.
function rowCounts(count) {
  if (count <= 24) return [count];
  let rows = Math.ceil(Math.sqrt(count / 1.6));
  if (count % 2 && !(rows % 2)) rows++;
  const base = Math.floor(count / rows);
  const counts = new Array(rows).fill(base);
  let remainder = count - base * rows;
  if (rows % 2 && remainder % 2) { counts[Math.floor(rows / 2)]++; remainder--; }
  for (let distance = 0; remainder > 0; distance++) {
    const left = Math.floor((rows - 1) / 2) - distance - (rows % 2 ? 1 : 0);
    const right = rows - 1 - left;
    counts[left]++; counts[right]++; remainder -= 2;
  }
  return counts;
}

function packChildren(children, footprints) {
  if (!children.length) return { width: TIP_FOOTPRINT, depth: TIP_FOOTPRINT, offsets: new Map() };
  const counts = rowCounts(children.length);
  const rows = [];
  let cursor = 0;
  for (const count of counts) {
    const members = children.slice(cursor, cursor + count);
    cursor += count;
    rows.push({
      members,
      width: members.reduce((sum, child) => sum + footprints.get(child).width, 0) + SIBLING_GAP * Math.max(0, count - 1),
      depth: Math.max(TIP_FOOTPRINT, ...members.map(child => footprints.get(child).depth)),
    });
  }
  const width = Math.max(TIP_FOOTPRINT, ...rows.map(row => row.width));
  const baseDepth = rows.reduce((sum, row) => sum + row.depth, 0) + SIBLING_GAP * (rows.length - 1);
  let z = -baseDepth / 2;
  let occupiedDepth = baseDepth / 2;
  const offsets = new Map();
  for (const row of rows) {
    let x = -row.width / 2;
    const centerZ = z + row.depth / 2;
    for (const child of row.members) {
      const box = footprints.get(child);
      const centerX = x + box.width / 2;
      // Mirrored siblings share Z: a shallow arch supplies real depth while the
      // frontal hierarchy stays balanced. Reserve its full footprint below.
      const normalizedX = row.width > box.width ? centerX / ((row.width - box.width) / 2) : 0;
      const relief = rows.length === 1 && children.length > 1 ? 2 + 3 * (1 - normalizedX ** 2) : 0;
      const childZ = centerZ + relief;
      offsets.set(child, [centerX, childZ]);
      occupiedDepth = Math.max(occupiedDepth, Math.abs(childZ) + box.depth / 2);
      x += box.width + SIBLING_GAP;
    }
    z += row.depth + SIBLING_GAP;
  }
  return { width, depth: occupiedDepth * 2, offsets };
}

function cubicBetween(start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1], dz = end[2] - start[2];
  const bow = Math.min(2.1, 1.2 + Math.abs(dx) * 0.02);
  return [
    [...start],
    [start[0] + dx * 0.18, start[1] + dy * 0.36, start[2] + dz * 0.12 + bow],
    [start[0] + dx * 0.85, start[1] + dy * 0.76, start[2] + dz * 0.88 + bow * 0.6],
    [...end],
  ];
}

/**
 * Fully expanded current repository hierarchy, rendered as a balanced 3D tree.
 * Every real folder/file keeps its immediate parent. The repository root is the
 * canopy trunk's ground anchor, not a second node below it. No display caps,
 * collapsed directories, pagination, inferred empty folders, or fake clusters.
 *
 * `paths` maps stable file IDs to historical paths. Omitted activeIds uses pinned
 * head membership when supplied by the model. Curves contain four cubic Bezier
 * control points. Dense sibling groups pack in X/Z; Y always represents depth.
 */
export function createRootLayout(model, { activeIds, paths, groundY = -40 } = {}) {
  const ground = Number.isFinite(groundY) ? groundY : -40;
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
    while (parent && !folderPaths.has(parent)) { folderPaths.add(parent); parent = parentOf(parent); }
  }
  const folders = [...folderPaths].sort(compare).map(path => ({
    kind: 'folder', path,
    name: path.split('/').pop() || model.repository?.name || 'Repository',
    parent: path ? parentOf(path) : null,
    parentPath: path ? parentOf(path) : null,
    depth: depthOf(path), count: 0,
    children: [], directFiles: [],
    position: [0, ground, 0], visible: true,
  }));
  const byPath = new Map(folders.map(folder => [folder.path, folder]));
  const nodes = files.map(file => ({
    ...file, kind: 'file', name: file.path.split('/').pop(),
    folder: parentOf(file.path), parentPath: parentOf(file.path),
    depth: depthOf(parentOf(file.path)) + 1,
    position: [0, ground, 0], visible: true,
  }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const folder of folders) if (folder.parent !== null) byPath.get(folder.parent).children.push(folder.path);
  for (const node of nodes) byPath.get(node.folder).directFiles.push(node.id);
  const entries = new Map();
  const footprints = new Map(nodes.map(node => [node, { width: TIP_FOOTPRINT, depth: TIP_FOOTPRINT }]));
  // Prefix order means reverse iteration completes every child before its parent.
  for (const folder of [...folders].reverse()) {
    const children = [...folder.children.map(path => byPath.get(path)), ...folder.directFiles.map(id => byId.get(id))];
    entries.set(folder, children);
    folder.count += folder.directFiles.length;
    if (folder.parent !== null) byPath.get(folder.parent).count += folder.count;
    footprints.set(folder, packChildren(children, footprints));
  }
  const root = byPath.get('');
  const rootFootprint = footprints.get(root);
  const scaleX = Math.min(1, MAX_WIDTH / rootFootprint.width);
  const scaleZ = Math.min(1, MAX_DEPTH / rootFootprint.depth);
  const rows = [], pending = [root];
  while (pending.length) {
    const item = pending.pop();
    rows.push(item);
    if (item.kind !== 'folder') continue;
    const children = entries.get(item);
    for (const child of children) {
      const offset = footprints.get(item).offsets.get(child);
      child.position = [item.position[0] + offset[0] * scaleX, ground - child.depth * ROOT_TIER_HEIGHT, item.position[2] + offset[1] * scaleZ];
    }
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  for (const folder of folders) {
    folder.curve = folder.parent === null
      ? Array.from({ length: 4 }, () => [...folder.position])
      : cubicBetween(byPath.get(folder.parent).position, folder.position);
    folder.points = folder.curve;
  }
  for (const node of nodes) {
    node.curve = cubicBetween(byPath.get(node.folder).position, node.position);
    node.points = node.curve;
  }

  const maxDepth = Math.max(0, ...folders.map(folder => folder.depth), ...nodes.map(node => node.depth));
  const width = rootFootprint.width * scaleX, depth = rootFootprint.depth * scaleZ;
  // Include the centered packing envelope as well as all curve controls. Camera
  // fitting therefore keeps the trunk centered even for an asymmetric repository.
  const min = [-width / 2, ground - maxDepth * ROOT_TIER_HEIGHT, -depth / 2];
  const max = [width / 2, ground, depth / 2];
  for (const item of rows) for (const point of item.curve) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]);
    max[axis] = Math.max(max[axis], point[axis]);
  }
  const margin = 2;
  for (let axis = 0; axis < 3; axis++) { min[axis] -= margin; max[axis] += margin; }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const extent = Math.hypot(...max.map((value, axis) => value - center[axis]));
  return {
    folders, nodes, rows, bounds: { min, max }, center, extent, maxDepth,
    fileCount: nodes.length, folderCount: folders.length,
    visibleFileCount: nodes.length, visibleFolderCount: folders.length,
    groundY: ground, tierHeight: ROOT_TIER_HEIGHT,
    footprint: { width, depth, scaleX, scaleZ },
  };
}
