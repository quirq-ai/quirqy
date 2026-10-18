const BASE_RADIUS = 0.002;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const readRadius = (values, key, baseRadius) => {
  const value = values instanceof Map ? values.get(key) : values?.[key];
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : baseRadius;
};
const strainFor = (radius, baseRadius) => {
  const growth = Math.max(0, radius - baseRadius);
  return growth * 1.1 + Math.sqrt(growth) * 1.3 + Math.max(0, Math.log2(radius / baseRadius)) * 0.38;
};
const growthAboveBaseline = (radius, baseRadius) => Math.max(0, radius - baseRadius);
const growthSteps = (radius, baseRadius) => Math.max(0, Math.log2(Math.max(baseRadius, radius) / baseRadius));
const delta = (a, b) => a.map((value, axis) => value - b[axis]);
const magnitude = value => Math.hypot(...value);
const unit = value => {
  const length = magnitude(value);
  return length > 1e-12 ? value.map(component => component / length) : [0, -1, 0];
};
const along = (origin, direction, length) => origin.map((value, axis) => value + direction[axis] * length);

function joinTangents(folders, entries, radii, byPath, root) {
  for (const folder of folders) {
    const children = entries.get(folder);
    // The existing canopy trunk is the root anchor, with no separate incoming
    // root curve. Other folder junctions have a genuine ancestral strand.
    if (folder === root || !children.length) continue;
    const parent = byPath.get(folder.parent);
    const incoming = unit(delta(folder.position, parent.position));
    const largest = children.reduce((value, child) => Math.max(value, radii.get(child) || 0), 0);
    const strongest = children.filter(child => Math.abs((radii.get(child) || 0) - largest) <= Math.max(1e-12, largest * 1e-9));
    const outgoing = [0, 0, 0];
    for (const child of strongest) {
      const direction = unit(delta(child.position, folder.position));
      for (let axis = 0; axis < 3; axis++) outgoing[axis] += direction[axis] / strongest.length;
    }
    // Average equally thick routes before blending; lexical tie-breaking would
    // introduce an artificial left/right bias into a balanced repository.
    const outgoingDirection = unit(outgoing);
    const direction = unit(incoming.map((value, axis) => value + outgoingDirection[axis]));
    const safeHandle = (length, verticalDrop, currentLength) => {
      // Wide sibling fans can have a much longer chord than their vertical
      // drop. Bound the Y projection too, so a join never turns above its parent.
      const verticalLimit = verticalDrop * 0.45 / Math.max(1e-12, -direction[1]);
      return Math.min(length * 0.34, verticalLimit, Math.max(length * 0.16, currentLength));
    };
    const incomingLength = magnitude(delta(folder.position, parent.position));
    const incomingHandle = safeHandle(incomingLength, parent.position[1] - folder.position[1], magnitude(delta(folder.position, folder.curve[2])));
    folder.curve[2] = along(folder.position, direction, -incomingHandle);
    for (const child of children) {
      const length = magnitude(delta(child.position, folder.position));
      const handle = safeHandle(length, folder.position[1] - child.position[1], magnitude(delta(child.curve[1], folder.position)));
      // All offshoots share the incoming tangent briefly, then peel away toward
      // their own tips. The dominant route therefore has no angular tube seam.
      child.curve[1] = along(folder.position, direction, handle);
    }
  }
}

// Match the base hierarchy's horizontal fans and dense symmetric grid rows.
// This partitions immediate siblings; it never compares every file pair.
function rowCounts(count) {
  if (count <= 24) return [count];
  let rows = Math.ceil(Math.sqrt(count / 1.6));
  if (count % 2 && !(rows % 2)) rows++;
  const counts = new Array(rows).fill(Math.floor(count / rows));
  let remaining = count % rows;
  if (rows % 2 && remaining % 2) { counts[Math.floor(rows / 2)]++; remaining--; }
  for (let distance = 0; remaining > 0; distance++) {
    const left = Math.floor((rows - 1) / 2) - distance - (rows % 2 ? 1 : 0);
    counts[left]++; counts[rows - 1 - left]++; remaining -= 2;
  }
  return counts;
}

function extraPacking(children, spaces) {
  const rows = [];
  let cursor = 0;
  for (const count of rowCounts(children.length)) {
    const members = children.slice(cursor, cursor + count);
    cursor += count;
    rows.push({
      members,
      width: members.reduce((sum, child) => sum + spaces.get(child).width, 0),
      depth: members.reduce((largest, child) => Math.max(largest, spaces.get(child).depth), 0),
    });
  }
  const width = rows.reduce((largest, row) => Math.max(largest, row.width), 0);
  const depth = rows.reduce((sum, row) => sum + row.depth, 0);
  const offsets = new Map();
  let z = -depth / 2;
  for (const row of rows) {
    let x = -row.width / 2;
    for (const child of row.members) {
      const space = spaces.get(child);
      offsets.set(child, [x + space.width / 2, z + row.depth / 2]);
      x += space.width;
    }
    z += row.depth;
  }
  return { width, depth, offsets };
}

/**
 * A deterministic growth-strain pose for the existing exact root hierarchy.
 * Radii stay physical inputs, never altered here. Expanded sibling footprints
 * reserve room for thick strands and displace neighboring quiet subtrees. Both
 * incident radii lengthen each edge so tips escape a thicker parent's body. The
 * log strain term makes early growth legible before a strand becomes very wide.
 * Set baseRadius to the physical radius of one untouched vine so the strain is
 * relative to that rope baseline, independent of the chosen world-unit scale.
 *
 * The base layout is never mutated. Missing/baseline radii reproduce its curves
 * and positions exactly. No time, previous pose or future commits are inputs.
 */
export function createRootWarpLayout(baseLayout, { fileRadii, folderRadii, baseRadius = BASE_RADIUS } = {}) {
  baseRadius = Number.isFinite(Number(baseRadius)) && Number(baseRadius) > 0 ? Number(baseRadius) : BASE_RADIUS;
  const clone = record => {
    const copy = {
      ...record, position: [...record.position],
      curve: record.curve.map(point => [...point]),
      ...(record.children ? { children: [...record.children] } : {}),
      ...(record.directFiles ? { directFiles: [...record.directFiles] } : {}),
    };
    copy.points = copy.curve;
    return copy;
  };
  const folders = baseLayout.folders.map(clone), nodes = baseLayout.nodes.map(clone);
  const byPath = new Map(folders.map(folder => [folder.path, folder]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const baseFolders = new Map(baseLayout.folders.map(folder => [folder.path, folder]));
  const baseFiles = new Map(baseLayout.nodes.map(node => [node.id, node]));
  const root = byPath.get('');
  const orderedFolders = [...folders].sort((a, b) => a.depth - b.depth || compare(a.path, b.path));
  const entries = new Map();
  const radii = new Map(), pressures = new Map(), spaces = new Map();
  let maxPressure = 0;
  for (const node of nodes) {
    const radius = readRadius(fileRadii, node.id, baseRadius), pressure = strainFor(radius, baseRadius);
    radii.set(node, radius); pressures.set(node, pressure);
    spaces.set(node, { width: pressure * 2.5, depth: pressure * 4 });
    maxPressure = Math.max(maxPressure, pressure);
  }
  for (const folder of [...orderedFolders].reverse()) {
    const children = [
      ...folder.children.map(path => byPath.get(path)),
      ...folder.directFiles.map(id => byId.get(id)),
    ].filter(Boolean);
    entries.set(folder, children);
    const radius = folder.path ? readRadius(folderRadii, folder.path, baseRadius) : 0;
    const pressure = strainFor(radius, baseRadius);
    radii.set(folder, radius); pressures.set(folder, pressure);
    const packing = extraPacking(children, spaces);
    spaces.set(folder, {
      width: Math.max(pressure * 2.5, packing.width + pressure * 0.2),
      depth: Math.max(pressure * 4, packing.depth + pressure * 0.56),
      offsets: packing.offsets,
    });
    maxPressure = Math.max(maxPressure, pressure);
  }

  if (maxPressure > 0) {
    for (const folder of orderedFolders) {
      const baseParent = baseFolders.get(folder.path);
      const parentShift = delta(folder.position, baseParent.position);
      for (const child of entries.get(folder)) {
        const original = child.kind === 'file' ? baseFiles.get(child.id) : baseFolders.get(child.path);
        const pressure = pressures.get(child);
        const [pushX, pushZ] = spaces.get(folder).offsets.get(child);
        const side = Math.sign(original.position[0] - baseParent.position[0]);
        const file = child.kind === 'file';
        const parentRadius = radii.get(folder) || 0;
        const childRadius = radii.get(child) || 0;
        // A quiet offshoot still needs enough free length to escape its thick
        // parent. Width is never capped or rescaled: both incident radii reserve
        // additional axial space, with a small parent-strain term for early growth.
        const axialClearance = 2 * (growthAboveBaseline(parentRadius, baseRadius) + growthAboveBaseline(childRadius, baseRadius)) + growthSteps(parentRadius, baseRadius) * 0.42;
        child.position = [
          original.position[0] + parentShift[0] + pushX + side * pressure * (file ? 0.25 : 0.1),
          original.position[1] + parentShift[1] - pressure * (file ? 0.55 : 0.22) - axialClearance,
          original.position[2] + parentShift[2] + pushZ + pressure * (file ? 0.8 : 0.28),
        ];
      }
    }
    for (const item of [...folders, ...nodes]) {
      const original = item.kind === 'file' ? baseFiles.get(item.id) : baseFolders.get(item.path);
      if (item === root) continue;
      const parent = byPath.get(item.kind === 'file' ? item.folder : item.parent);
      const baseParent = baseFolders.get(parent.path);
      const startShift = delta(parent.position, baseParent.position);
      const endShift = delta(item.position, original.position);
      const localShift = delta(endShift, startShift);
      const pressure = pressures.get(item);
      const bow = pressure * 0.55 + Math.hypot(localShift[0], localShift[2]) * 0.12;
      item.curve = original.curve.map((point, index) => {
        if (!index) return [...parent.position];
        if (index === 3) return [...item.position];
        const t = index === 1 ? 0.18 : 0.82;
        const warped = point.map((value, axis) => value + startShift[axis] * (1 - t) + endShift[axis] * t);
        warped[0] += localShift[0] * (index === 1 ? 0.12 : 0.24);
        warped[1] -= pressure * (index === 1 ? 0.08 : 0.1);
        warped[2] += bow * (index === 1 ? 0.8 : 1.2);
        return warped;
      });
      item.points = item.curve;
    }
    joinTangents(orderedFolders, entries, radii, byPath, root);
  }
  const rows = (baseLayout.rows || [...baseLayout.folders, ...baseLayout.nodes]).map(row => row.kind === 'file' ? byId.get(row.id) : byPath.get(row.path));
  const min = [...baseLayout.bounds.min], max = [...baseLayout.bounds.max];
  if (maxPressure > 0) for (const item of rows) {
    const radius = radii.get(item) || 0;
    for (const point of item.curve) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis] - radius - 2);
      max[axis] = Math.max(max[axis], point[axis] + radius + 2);
    }
  }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const extent = maxPressure > 0 ? Math.hypot(...max.map((value, axis) => value - center[axis])) : baseLayout.extent;
  return {
    ...baseLayout, folders, nodes, rows, bounds: { min, max }, center, extent,
    footprint: maxPressure > 0 ? { ...baseLayout.footprint, width: max[0] - min[0], depth: max[2] - min[2] } : { ...baseLayout.footprint },
    warp: { active: maxPressure > 0, maxPressure },
  };
}
