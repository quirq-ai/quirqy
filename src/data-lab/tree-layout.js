import { createRepositoryLayout, stableHash } from './layout.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TAU = Math.PI * 2;
const add = (a, b) => a.map((value, index) => value + b[index]);
const scale = (value, factor) => value.map(component => component * factor);
const lerp = (a, b, amount) => a.map((value, index) => value + (b[index] - value) * amount);
const normalize = value => scale(value, 1 / (Math.hypot(...value) || 1));
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const random = value => stableHash(value) / 4294967295;

export const LEAF_AREA_MIN = 0.16;
export const LEAF_AREA_MAX = 6.25;

/** Byte sizes describe the pinned tree, not reconstructed historical contents. */
export function leafSizing(nodes) {
  const known = nodes.filter(node => typeof node.size === 'number' && Number.isFinite(node.size) && node.size >= 0);
  const positive = known.map(node => node.size).filter(size => size > 0).sort((a, b) => a - b);
  const referenceBytes = positive[Math.floor(positive.length / 2)] || 1;
  return {
    referenceBytes, minAreaRatio: LEAF_AREA_MIN, maxAreaRatio: LEAF_AREA_MAX,
    knownCount: known.length, unknownCount: nodes.length - known.length,
    clampedCount: known.filter(node => node.size / referenceBytes < LEAF_AREA_MIN || node.size / referenceBytes > LEAF_AREA_MAX).length,
  };
}

export function leafScale(node, sizing) {
  const known = typeof node.size === 'number' && Number.isFinite(node.size) && node.size >= 0;
  const areaRatio = known ? Math.max(sizing.minAreaRatio, Math.min(sizing.maxAreaRatio, node.size / sizing.referenceBytes)) : 0.65;
  return { sizeKnown: known, areaRatio, scale: Math.sqrt(areaRatio) };
}

/** Growth is an absolute function of the cursor, so replay and seeking agree. */
export function trunkRadius(index) {
  return 1.18 + Math.log1p(Math.max(0, Math.floor(Number(index) || 0) + 1)) * 0.48;
}

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
      child.branchWeight = Math.max(0.16, Math.min(0.54, Math.sqrt(child.count / Math.max(1, base.nodes.length)) * 0.82)) * Math.pow(0.76, child.depth - 1);
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
  // Use all loaded file bytes as the reference, even when the visible map is capped.
  const sizing = leafSizing(model.nodes || []);
  for (const node of nodes) Object.assign(node, leafScale(node, sizing));
  const points = [...trunk, ...folders.map(folder => folder.position), ...nodes.map(node => node.position)];
  const min = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis])) - 6);
  const max = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])) + 6);
  const center = lerp(min, max, 0.5);
  const extent = Math.max(...points.map(point => Math.hypot(...point.map((value, axis) => value - center[axis])))) + 6;
  return { ...base, nodes, folders: folders.map(({ children, ...folder }) => folder), trunk, sizing, center, extent, bounds: { min, max } };
}


/** Every loaded commit adds the same visible amount of longitudinal growth. */
export function treeLengthScale(index, commitCount) {
  const count = Math.max(0, Number.isFinite(Number(commitCount)) ? Math.floor(Number(commitCount)) : 0);
  const cursor = Math.max(-1, Math.min(count - 1, Number.isFinite(Number(index)) ? Math.floor(Number(index)) : -1));
  return 0.42 + (count ? (cursor + 1) / count : 0) * 0.9;
}

function tangent(points, t) {
  const u = 1 - t;
  return normalize(add(add(scale(subtract(points[1], points[0]), 3 * u * u), scale(subtract(points[2], points[1]), 6 * u * t)), scale(subtract(points[3], points[2]), 3 * t * t)));
}

// Minimal rotation keeps each twig's deterministic side of its parent limb.
function rotateBetween(value, from, to) {
  const axis = cross(from, to), cosine = Math.max(-1, Math.min(1, dot(from, to)));
  if (cosine > 0.999999) return [...value];
  if (cosine < -0.999999) {
    const perpendicular = normalize(cross(from, Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    return subtract(scale(perpendicular, 2 * dot(value, perpendicular)), value);
  }
  return add(add(value, cross(axis, value)), scale(cross(axis, cross(axis, value)), 1 / (1 + cosine)));
}

function poseBounds(trunk, folders, nodes) {
  // A Bézier curve stays in its control-point hull. Include those points, twigs,
  // and the largest allowed leaf so fitting does not clip a bent branch.
  const points = [...trunk, ...folders.flatMap(folder => folder.curve), ...nodes.flatMap(node => [node.position, node.stemStart, node.stemControl])];
  const margin = 10;
  const min = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis])) - margin);
  const max = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])) + margin);
  const center = lerp(min, max, 0.5);
  const extent = Math.max(...points.map(point => Math.hypot(...subtract(point, center)))) + margin;
  return { bounds: { min, max }, center, extent };
}

/**
 * Absolute history pose: growth depends on the cursor, load on present leaves.
 * It changes branch and twig lengths, never the byte-encoded leaf surface area.
 */
export function createTreePose(layout, { index = -1, commitCount = 0, activeIds } = {}) {
  const active = activeIds === undefined ? new Set(layout.nodes.map(node => node.id)) : activeIds instanceof Set ? activeIds : new Set(activeIds || []);
  const lengthScale = treeLengthScale(index, commitCount);
  const origin = layout.trunk[0];
  const trunk = layout.trunk.map(point => add(origin, scale(subtract(point, origin), lengthScale)));
  const baseFolders = new Map(layout.folders.map(folder => [folder.path, folder]));
  const loadCounts = new Map(layout.folders.map(folder => [folder.path, 0]));
  for (const node of layout.nodes) {
    if (!active.has(node.id)) continue;
    let path = node.folder;
    while (path !== null && baseFolders.has(path)) {
      loadCounts.set(path, loadCounts.get(path) + 1);
      path = baseFolders.get(path).parent;
    }
  }
  const posed = new Map();
  const poseFolder = folder => {
    if (posed.has(folder.path)) return posed.get(folder.path);
    const loadCount = loadCounts.get(folder.path) || 0;
    if (!folder.path) {
      const root = { ...folder, curve: trunk, position: trunk[3], direction: tangent(trunk, 1), loadCount, loadWeight: 0, lengthFactor: 1, droop: 0 };
      posed.set(folder.path, root);
      return root;
    }
    const parentBase = baseFolders.get(folder.parent);
    const parent = poseFolder(parentBase);
    const attachment = folder.attachmentT;
    const start = treePoint(parent.curve, attachment);
    const from = tangent(parentBase.curve, attachment), to = tangent(parent.curve, attachment);
    // A count-based load lets an empty or unknown-size file weigh like any other
    // leaf. It avoids implying that bytes measure physical branch weight.
    const loadWeight = 1 - Math.exp(-loadCount / 18);
    const lengthFactor = 1 + loadWeight * 1.05;
    const originalLength = Math.hypot(...subtract(folder.curve[3], folder.curve[0]));
    const droop = originalLength * lengthScale * Math.pow(loadWeight, 1.35) * 0.72;
    const curve = folder.curve.map((point, controlIndex) => {
      if (controlIndex === 0) return start;
      const local = rotateBetween(scale(subtract(point, folder.curve[0]), lengthScale), from, to);
      const reach = 1 + (lengthFactor - 1) * [0, 0.25, 0.8, 1][controlIndex];
      return add(start, [local[0] * reach, local[1] - droop * [0, 0.015, 0.48, 1][controlIndex], local[2] * reach]);
    });
    const result = { ...folder, curve, position: curve[3], direction: tangent(curve, 1), loadCount, loadWeight, lengthFactor, droop };
    posed.set(folder.path, result);
    return result;
  };
  const folders = layout.folders.map(poseFolder);
  const nodes = layout.nodes.map(node => {
    const base = baseFolders.get(node.folder), folder = posed.get(node.folder);
    const stemStart = treePoint(folder.curve, node.attachmentT);
    const from = tangent(base.curve, node.attachmentT), to = tangent(folder.curve, node.attachmentT);
    const twigScale = lengthScale * (1 + folder.loadWeight * 0.15);
    const position = add(stemStart, rotateBetween(scale(subtract(node.position, node.stemStart), twigScale), from, to));
    const stemControl = add(stemStart, rotateBetween(scale(subtract(node.stemControl, node.stemStart), twigScale), from, to));
    const direction = normalize(rotateBetween(node.direction, from, to));
    return { ...node, position, stemStart, stemControl, direction };
  });
  return { ...layout, trunk, folders, nodes, lengthScale, ...poseBounds(trunk, folders, nodes) };
}
