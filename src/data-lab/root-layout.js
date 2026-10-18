const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const depthOf = path => path ? path.split('/').length : 0;

export const ROOT_TIER_HEIGHT = 16;
const TIP_FOOTPRINT = 3.2;
const SIBLING_GAP = 2.2;
const MAX_WIDTH = 160;
const MAX_DEPTH = 100;
const ADAPTIVE_FILE_THRESHOLD = 160;
const ADAPTIVE_GAP = 3.2;
const ADAPTIVE_TIP_DEPTH = 6;
const ADAPTIVE_MIN_TIP_WIDTH = 8;
const WORLD_PER_CHARACTER = 0.8;
const BASE_FILES = 64;
const BASE_PADDING = 6;

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

// Large repositories reserve readable local slots before packing. A folder's
// footprint includes its entire descendant hierarchy, so neighbouring branches
// cannot borrow the same space merely because one has fewer immediate children.
// Shelves stay in X/Z: vertical levels continue to mean actual path depth.
function packAdaptiveChildren(children, footprints) {
  if (!children.length) return { width: ADAPTIVE_MIN_TIP_WIDTH, depth: ADAPTIVE_TIP_DEPTH, offsets: new Map() };
  const area = children.reduce((sum, child) => {
    const box = footprints.get(child);
    return sum + (box.width + ADAPTIVE_GAP) * (box.depth + ADAPTIVE_GAP);
  }, 0);
  const widest = Math.max(...children.map(child => footprints.get(child).width));
  const preferredWidth = Math.max(widest, Math.sqrt(area * 5 / 3));
  let best;
  // A few bounded alternatives avoid a narrow final shelf or one tall subtree
  // wasting most of a row. Input order stays lexical in every alternative.
  for (const factor of [0.8, 1, 1.25, 1.6]) {
    const limit = Math.max(widest, preferredWidth * factor);
    const rows = [];
    let row = { members: [], width: 0, depth: 0 };
    for (const child of children) {
      const box = footprints.get(child);
      const nextWidth = row.width + (row.members.length ? ADAPTIVE_GAP : 0) + box.width;
      if (row.members.length && nextWidth > limit) {
        rows.push(row);
        row = { members: [], width: 0, depth: 0 };
      }
      row.width += (row.members.length ? ADAPTIVE_GAP : 0) + box.width;
      row.depth = Math.max(row.depth, box.depth);
      row.members.push(child);
    }
    rows.push(row);
    const width = Math.max(...rows.map(item => item.width));
    const depth = rows.reduce((sum, item) => sum + item.depth, 0) + ADAPTIVE_GAP * (rows.length - 1);
    // Minimise the containing 5:3 footprint, so tall nested subtrees cannot
    // produce a long ribbon just because that arrangement has slightly less area.
    const cost = Math.max(width ** 2 / (5 / 3), depth ** 2 * (5 / 3));
    if (!best || cost < best.cost) best = { rows, width, depth, cost };
  }
  const offsets = new Map();
  let z = -best.depth / 2;
  let occupiedDepth = best.depth / 2;
  for (const row of best.rows) {
    let x = -row.width / 2;
    const centerZ = z + row.depth / 2;
    for (const child of row.members) {
      const box = footprints.get(child);
      const centerX = x + box.width / 2;
      const normalizedX = row.width > box.width ? centerX / ((row.width - box.width) / 2) : 0;
      const relief = best.rows.length === 1 && children.length > 1 ? 2 + 3 * (1 - normalizedX ** 2) : 0;
      const childZ = centerZ + relief;
      offsets.set(child, [centerX, childZ]);
      occupiedDepth = Math.max(occupiedDepth, Math.abs(childZ) + box.depth / 2);
      x += box.width + ADAPTIVE_GAP;
    }
    z += row.depth + ADAPTIVE_GAP;
  }
  return { width: best.width, depth: occupiedDepth * 2, offsets };
}

function baseForFootprint(fileCount, min, max) {
  const capacityScale = Math.sqrt(Math.max(1, fileCount / BASE_FILES));
  const countRadiusX = 50 * capacityScale;
  const countRadiusZ = 30 * capacityScale;
  const halfWidth = Math.max(Math.abs(min[0]), Math.abs(max[0])) + BASE_PADDING;
  const halfDepth = Math.max(Math.abs(min[2]), Math.abs(max[2])) + BASE_PADDING;
  let radiusX = Math.max(countRadiusX, halfWidth);
  let radiusZ = Math.max(countRadiusZ, halfDepth);
  // The ellipse must contain the reserved rectangular footprint, not just its
  // axis extrema. Expand both axes together to preserve their chosen proportion.
  const enclosure = Math.max(1, Math.hypot(halfWidth / radiusX, halfDepth / radiusZ));
  radiusX *= enclosure;
  radiusZ *= enclosure;
  return { radiusX, radiusZ, fileCount, capacityScale, countRadiusX, countRadiusZ, padding: BASE_PADDING };
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
 * Dot-prefixed path segments and their descendants are omitted from roots only.
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
    .filter(node => typeof node.path === 'string' && node.path.length > 0
      && !node.path.split('/').some(segment => segment.startsWith('.')))
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
  const adaptive = nodes.length > ADAPTIVE_FILE_THRESHOLD;
  const footprints = new Map(nodes.map(node => [node, adaptive
    ? { width: Math.max(ADAPTIVE_MIN_TIP_WIDTH, 4 + node.name.length * WORLD_PER_CHARACTER), depth: ADAPTIVE_TIP_DEPTH }
    : { width: TIP_FOOTPRINT, depth: TIP_FOOTPRINT }]));
  // Prefix order means reverse iteration completes every child before its parent.
  for (const folder of [...folders].reverse()) {
    const children = [...folder.children.map(path => byPath.get(path)), ...folder.directFiles.map(id => byId.get(id))];
    entries.set(folder, children);
    folder.count += folder.directFiles.length;
    if (folder.parent !== null) byPath.get(folder.parent).count += folder.count;
    footprints.set(folder, adaptive ? packAdaptiveChildren(children, footprints) : packChildren(children, footprints));
  }
  const root = byPath.get('');
  const rootFootprint = footprints.get(root);
  // Preserve the established small-repository composition. Large repositories
  // grow their ground footprint instead of compressing every local file slot.
  const scaleX = adaptive ? 1 : Math.min(1, MAX_WIDTH / rootFootprint.width);
  const scaleZ = adaptive ? 1 : Math.min(1, MAX_DEPTH / rootFootprint.depth);
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
    base: baseForFootprint(nodes.length, min, max),
    readability: {
      adaptive, minFileWidth: adaptive ? ADAPTIVE_MIN_TIP_WIDTH : TIP_FOOTPRINT * scaleX,
      minFileDepth: adaptive ? ADAPTIVE_TIP_DEPTH : TIP_FOOTPRINT * scaleZ,
      siblingGap: adaptive ? ADAPTIVE_GAP : SIBLING_GAP * Math.min(scaleX, scaleZ),
      worldPerCharacter: adaptive ? WORLD_PER_CHARACTER : 0,
    },
  };
}
