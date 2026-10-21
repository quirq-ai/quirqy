import { createRepositoryLayout, stableHash } from './layout.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TAU = Math.PI * 2;
const add = (a, b) => a.map((value, index) => value + b[index]);
const scale = (value, factor) => value.map(component => component * factor);
const lerp = (a, b, amount) => a.map((value, index) => value + (b[index] - value) * amount);
const normalize = value => scale(value, 1 / (Math.hypot(...value) || 1));
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const random = value => stableHash(value) / 4294967295;

export const TREE_REFERENCE_BYTES = 1024 * 1024;
export const LEAF_REFERENCE_BYTES = 16 * 1024;
export const UNKNOWN_LEAF_SCALE = 0.55;
const knownSize = size => typeof size === 'number' && Number.isFinite(size) && size >= 0;

/** Fixed calibration across repositories and every frame of their history. */
export function leafSizing(nodes) {
  const known = nodes.filter(node => knownSize(node.size));
  return { referenceBytes: LEAF_REFERENCE_BYTES, knownCount: known.length, unknownCount: nodes.length - known.length, clampedCount: 0 };
}

export function leafScale(node) {
  const sizeKnown = knownSize(node.size);
  const areaRatio = sizeKnown ? node.size / LEAF_REFERENCE_BYTES : null;
  return { sizeKnown, areaRatio, scale: sizeKnown ? Math.sqrt(areaRatio) : UNKNOWN_LEAF_SCALE };
}

/** Linear dimensions encode the cube root of the current known byte subtotal. */
export function treeByteScale(bytes) {
  return knownSize(bytes) ? Math.cbrt(bytes / TREE_REFERENCE_BYTES) : 0;
}
export const treeLengthScale = treeByteScale;
export function trunkRadius(bytes) { return 1.18 * treeByteScale(bytes); }

// Cubic interpolation is shared by the pure layout and Three.js curves.
export const treePoint = (points, t) => {
  const u = 1 - t;
  return add(add(scale(points[0], u ** 3), scale(points[1], 3 * u * u * t)), add(scale(points[2], 3 * u * t * t), scale(points[3], t ** 3)));
};

/** A deterministic directory tree: folders are limbs, file identities are leaves. */
export function createTreeLayout(model, options = {}) {
  // Selection and ancestor compression remain identical to the structure view.
  const base = createRepositoryLayout(model, options);
  const trunk = [[0, -40, 0], [-2.5, -21, 1.8], [2.6, 1, -1.3], [0, 25, 0]];
  const folders = base.folders.map(folder => ({ ...folder, position: [0, 25, 0], children: [] }));
  const byPath = new Map(folders.map(folder => [folder.path, folder]));
  for (const folder of folders) if (folder.parent !== null) byPath.get(folder.parent).children.push(folder.path);
  const root = byPath.get('');
  root.curve = trunk;
  root.branchWeight = 1;
  root.direction = [0, 1, 0];
  root.attachmentT = 0;
  const populate = folder => {
    const count = folder.children.length;
    folder.children.forEach((path, index) => {
      const child = byPath.get(path);
      let start, end;
      if (!folder.depth) {
        const angle = index * GOLDEN_ANGLE + 0.55;
        const heightOrder = count === 1 ? 0.6 : index / Math.max(1, count - 1);
        child.attachmentT = 0.35 + heightOrder * 0.43;
        start = treePoint(trunk, child.attachmentT);
        const spread = Math.min(34, 23 + Math.sqrt(count) * 2.1) * (1 - heightOrder * 0.15);
        end = [Math.cos(angle) * spread, 15 + heightOrder * 20 + random(path) * 4, Math.sin(angle) * spread * 0.8];
      } else {
        const direction = normalize([folder.direction[0], 0.56, folder.direction[2]]);
        const angle = index * GOLDEN_ANGLE + random(path) * 1.1;
        const length = (17 + Math.sqrt(count) * 1.5) * Math.pow(0.78, folder.depth - 1);
        child.attachmentT = 0.68 + (index + 0.5) / Math.max(count, 1) * 0.26;
        start = treePoint(folder.curve, child.attachmentT);
        const side = [-direction[2], 0, direction[0]];
        const fan = count === 1 ? 0.22 : 0.8;
        const outward = normalize(add(direction, add(scale(side, Math.cos(angle) * fan), [0, Math.sin(angle) * 0.28, 0])));
        end = add(start, scale(outward, length));
      }
      const vector = end.map((value, axis) => value - start[axis]);
      child.curve = [start, add(start, [vector[0] * 0.18, Math.max(5, vector[1] * 0.55), vector[2] * 0.18]), add(lerp(start, end, 0.72), [0, 2.8, 0]), end];
      child.position = end;
      child.direction = normalize(vector);
      child.branchWeight = 0.82 * Math.pow(0.76, child.depth - 1);
      populate(child);
    });
  };
  populate(root);
  const nodes = [];
  for (const folder of folders) {
    const members = base.nodes.filter(node => node.folder === folder.path);
    const phase = random(folder.path) * TAU;
    members.forEach((node, index) => {
      const fraction = (index + 0.5) / Math.max(1, members.length);
      const angle = index * GOLDEN_ANGLE + phase;
      const attachmentT = (folder.depth ? 0.57 : 0.66) + fraction * (folder.depth ? 0.41 : 0.32);
      const stemStart = treePoint(folder.curve, attachmentT);
      const radius = (folder.depth ? 7.5 : 14) + Math.cbrt(members.length) * 0.7;
      const side = normalize([-folder.direction[2], 0, folder.direction[0]]);
      const outward = folder.depth ? normalize([folder.direction[0], 0.38, folder.direction[2]]) : [0, 1, 0];
      let offset;
      if (folder.depth) {
        offset = add(scale(outward, 3 + fraction * 5), add(scale(side, Math.cos(angle) * radius), [0, Math.sin(angle) * radius * 0.43 + 3.7, Math.sin(angle) * radius * 0.55]));
      } else {
        offset = [Math.cos(angle) * radius * (0.55 + fraction * 0.45), 3 + Math.sin(angle * 0.7) * 4, Math.sin(angle) * radius * 0.75];
      }
      const position = add(stemStart, offset);
      const stemControl = add(lerp(stemStart, position, 0.48), [0, 2.5, 0]);
      const direction = normalize(add(normalize(offset), [0, 0.38, 0]));
      nodes.push({ ...node, position, stemStart, stemControl, attachmentT, direction, roll: (random(node.id) - 0.5) * 1.1 });
    });
  }
  // Retain all loaded identities for byte totals, even when the visible canopy is capped.
  const sizing = leafSizing(model.nodes || []);
  for (const node of nodes) Object.assign(node, leafScale(node, sizing));
  const points = [...trunk, ...folders.map(folder => folder.position), ...nodes.map(node => node.position)];
  const min = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis])) - 6);
  const max = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])) + 6);
  const center = lerp(min, max, 0.5);
  const extent = Math.max(...points.map(point => Math.hypot(...point.map((value, axis) => value - center[axis])))) + 6;
  return { ...base, byteNodes: (model.nodes || []).map(node => ({ ...node })), nodes, folders: folders.map(({ children, ...folder }) => folder), trunk, sizing, center, extent, bounds: { min, max } };
}


function poseBounds(folders, nodes) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const include = (point, radius = 0) => point.forEach((value, axis) => {
    min[axis] = Math.min(min[axis], value - radius);
    max[axis] = Math.max(max[axis], value + radius);
  });
  // Control-point hulls contain the curves. Four units contain the authored
  // leaf at any orientation; leaf size is independent of the canopy scale.
  for (const folder of folders) for (const point of folder.curve) include(point, folder.radius * 1.8);
  for (const node of nodes) {
    include(node.stemStart); include(node.stemControl);
    include(node.position, node.active ? node.scale * 4 : 0);
  }
  for (const axis of [0, 1, 2]) { min[axis] -= 2; max[axis] += 2; }
  const center = lerp(min, max, 0.5);
  return { bounds: { min, max }, center, extent: Math.hypot(...subtract(max, min)) / 2 };
}

/** Current byte quantities determine size; commit position never enters it. */
export function createTreePose(layout, { frame, activeIds } = {}) {
  const source = frame?.files || layout.byteNodes || layout.nodes;
  const requested = activeIds ?? frame?.activeIds;
  const active = requested === undefined
    ? new Set(source.filter(node => node.exists !== false && node.existsAtHead !== false).map(node => node.id))
    : requested instanceof Set ? requested : new Set(requested || []);
  const files = source.filter(node => active.has(node.id));
  const byId = new Map(files.map(node => [node.id, node]));
  const knownFiles = files.filter(node => knownSize(node.size));
  const computedBytes = knownFiles.reduce((sum, node) => sum + node.size, 0);
  const knownBytes = knownSize(frame?.sizeSummary?.knownBytes) ? frame.sizeSummary.knownBytes : computedBytes;
  const sizeSummary = frame?.sizeSummary ? { ...frame.sizeSummary } : { totalBytes: knownFiles.length === files.length ? knownBytes : null, knownBytes, fileCount: files.length, knownFiles: knownFiles.length, unknownFiles: files.length - knownFiles.length, complete: knownFiles.length === files.length };
  const lengthScale = treeByteScale(knownBytes), radius = trunkRadius(knownBytes);
  const origin = layout.trunk[0];
  const trunk = layout.trunk.map(point => add(origin, scale(subtract(point, origin), lengthScale)));
  const baseFolders = new Map(layout.folders.map(folder => [folder.path, folder]));
  const loads = new Map(layout.folders.map(folder => [folder.path, { count: 0, bytes: 0 }]));
  const mappedFolders = new Map(layout.nodes.map(node => [node.id, node.folder]));
  const authoredFiles = new Map((layout.byteNodes || layout.nodes).map(node => [node.id, node]));
  for (const node of files) {
    // The canopy retains authored attachment slots across renames. Its branch
    // load must follow those displayed slots; the roots show exact current paths.
    let path = mappedFolders.get(node.id) ?? String(authoredFiles.get(node.id)?.path || node.path || '').split('/').slice(0, -1).join('/');
    while (!baseFolders.has(path) && path) path = path.split('/').slice(0, -1).join('/');
    while (path !== null && baseFolders.has(path)) {
      const load = loads.get(path);
      load.count++; if (knownSize(node.size)) load.bytes += node.size;
      path = baseFolders.get(path).parent;
    }
  }
  const posed = new Map();
  const poseFolder = folder => {
    if (posed.has(folder.path)) return posed.get(folder.path);
    const load = loads.get(folder.path);
    let curve = trunk;
    if (folder.path) {
      const parent = poseFolder(baseFolders.get(folder.parent));
      const start = treePoint(parent.curve, folder.attachmentT);
      curve = folder.curve.map(point => add(start, scale(subtract(point, folder.curve[0]), lengthScale)));
    }
    const branchRadius = folder.path ? trunkRadius(load.bytes) * folder.branchWeight : radius;
    if (!folder.path) { load.bytes = knownBytes; load.count = sizeSummary.fileCount; }
    const result = { ...folder, curve, position: curve[3], radius: branchRadius, loadBytes: load.bytes, loadCount: load.count, loadWeight: knownBytes ? load.bytes / knownBytes : 0, lengthFactor: 1, droop: 0 };
    posed.set(folder.path, result);
    return result;
  };
  const folders = layout.folders.map(poseFolder);
  const nodes = layout.nodes.map(node => {
    const folder = posed.get(node.folder), current = byId.get(node.id);
    const stemStart = treePoint(folder.curve, node.attachmentT);
    const position = add(stemStart, scale(subtract(node.position, node.stemStart), lengthScale));
    const stemControl = add(stemStart, scale(subtract(node.stemControl, node.stemStart), lengthScale));
    const size = current?.size ?? null;
    return { ...node, size, active: active.has(node.id), position, stemStart, stemControl, ...leafScale({ size }) };
  });
  return { ...layout, trunk, folders, nodes, sizeSummary, knownBytes, totalBytes: sizeSummary.totalBytes, sizeComplete: sizeSummary.complete, trunkRadius: radius, sizing: leafSizing(files), lengthScale, ...poseBounds(folders, nodes) };
}
