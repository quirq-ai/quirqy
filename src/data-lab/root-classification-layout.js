const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareEntry = (a, b) => compare(a.path, b.path) || compare(a.id || '', b.id || '');

export const ROOT_CLASSIFICATION_ROW_PITCH = 8;
export const ROOT_CLASSIFICATION_TIER_PITCH = 28;
export const ROOT_CLASSIFICATION_LABEL_SCALE = 4;
const LABEL_HEIGHT = 4.5;
const LABEL_GAP = 1.25;
const PADDING = 2;
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
const entryKey = entry => `${entry.kind}:${entry.kind === 'folder' ? entry.path : entry.id}`;

// Reserve complete monospace names, including a folder's commit-count suffix.
// These are world-space slots at the reading scale, not a cap on visible data.
function labelWidth(name, folder) {
  let pixels = 8;
  for (const glyph of `${name || ''}${folder ? ' · 999 touches' : ''}`) {
    pixels += /[^\x00-\x7f]/.test(glyph) ? 13 : 8;
  }
  return pixels / ROOT_CLASSIFICATION_LABEL_SCALE;
}

function cloneEntry(source, pinnedWidths) {
  const key = entryKey(source);
  const pinned = pinnedWidths instanceof Map ? pinnedWidths.get(key) : pinnedWidths?.[key];
  return {
    ...source,
    ...(source.children ? { children: [...source.children] } : {}),
    ...(source.directFiles ? { directFiles: [...source.directFiles] } : {}),
    position: [...source.position],
    labelWidthWorld: Number.isFinite(pinned) && pinned > 0
      ? Math.max(labelWidth(source.name, false), pinned)
      : labelWidth(source.name, source.kind === 'folder'),
    labelDirection: [0, -1, 0], labelPlacement: 'below', visible: true,
  };
}

function curveBetween(parent, child) {
  const start = parent.position, end = child.position;
  const dy = end[1] - start[1];
  // Endpoints lie on exact depth planes. Alternating shallow relief retains
  // volume without shifting level labels; adjacent edges share fork tangents.
  const startRelief = parent.depth % 2 ? -0.65 : 0.65;
  const endRelief = child.depth % 2 ? -0.65 : 0.65;
  return [
    [...start],
    [start[0], start[1] + dy * 0.46, startRelief],
    [end[0], end[1] - dy * 0.46, -endRelief],
    [...end],
  ];
}

/**
 * A fully expanded top-down tidy tree. Exact hierarchy depth controls Y, with
 * all folder junctions on one horizontal plane per level. Lexical subtrees own
 * disjoint X intervals; each real basename reserves a centered reading slot.
 * Folder junctions sit at the center of their descendants' allocated interval.
 * Z relief exists only along the ropes, never at level-aligned endpoints.
 *
 * Callers may pin tierPitch, lanePitch and labelWidths (Map keyed folder:path or
 * file:id, in world units) across a loaded history. Membership can change its
 * real subtree span, but camera movement and commit attention cannot move tiers.
 */
export function createRootClassificationLayout(baseLayout, { tierPitch, lanePitch, labelWidths } = {}) {
  const pitch = positive(lanePitch, ROOT_CLASSIFICATION_ROW_PITCH);
  const tier = positive(tierPitch, ROOT_CLASSIFICATION_TIER_PITCH);
  const folders = baseLayout.folders.map(entry => cloneEntry(entry, labelWidths));
  const nodes = baseLayout.nodes.map(entry => cloneEntry(entry, labelWidths));
  const byPath = new Map(folders.map(folder => [folder.path, folder]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const root = byPath.get('');
  const ground = baseLayout.groundY;
  const children = new Map(folders.map(folder => [folder, [
    ...folder.children.map(path => byPath.get(path)),
    ...folder.directFiles.map(id => byId.get(id)),
  ].sort(compareEntry)]));
  root.labelWidthWorld = 0; // The trunk already names the repository.
  const widths = new Map(nodes.map(node => [node, Math.max(pitch, node.labelWidthWorld + pitch)]));
  const fileCounts = new Map(nodes.map(node => [node, 1]));
  for (const folder of [...folders].sort((a, b) => b.depth - a.depth || compareEntry(a, b))) {
    const descendants = children.get(folder);
    widths.set(folder, Math.max(folder.labelWidthWorld + pitch, descendants.reduce((sum, child) => sum + widths.get(child), 0)));
    fileCounts.set(folder, descendants.reduce((sum, child) => sum + fileCounts.get(child), 0));
  }

  const rows = [], pending = [{ entry: root, left: -widths.get(root) / 2 }];
  let cursor = 0;
  while (pending.length) {
    const { entry, left } = pending.pop();
    const width = widths.get(entry), count = fileCounts.get(entry);
    entry.rowSpan = [cursor, Math.max(cursor, cursor + count - 1)];
    entry.row = cursor + Math.max(0, count - 1) / 2;
    entry.side = 0;
    entry.laneBounds = [left, left + width];
    entry.position = [left + width / 2, ground - entry.depth * tier, 0];
    if (entry === root) entry.position = [0, ground, 0];
    else {
      const [x, y, z] = entry.position;
      entry.labelBounds = {
        min: [x - entry.labelWidthWorld / 2, y - LABEL_GAP - LABEL_HEIGHT, z],
        max: [x + entry.labelWidthWorld / 2, y - LABEL_GAP, z],
      };
    }
    rows.push(entry);
    if (entry.kind === 'file') cursor++;
    else {
      const descendants = children.get(entry);
      const contentWidth = descendants.reduce((sum, child) => sum + widths.get(child), 0);
      let childLeft = left + (width - contentWidth) / 2;
      const placements = descendants.map(child => {
        const placement = { entry: child, left: childLeft };
        childLeft += widths.get(child);
        return placement;
      });
      for (let index = placements.length - 1; index >= 0; index--) pending.push(placements[index]);
    }
  }
  for (const entry of rows) {
    entry.curve = entry === root ? Array.from({ length: 4 }, () => [...root.position])
      : curveBetween(byPath.get(entry.kind === 'file' ? entry.folder : entry.parent), entry);
    entry.points = entry.curve;
  }

  const min = [0, ground, 0], max = [0, ground, 0];
  const include = point => point.forEach((value, axis) => { min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); });
  for (const entry of rows) {
    entry.curve.forEach(include);
    if (entry.labelBounds) { include(entry.labelBounds.min); include(entry.labelBounds.max); }
  }
  const spanWidth = max[0] - min[0];
  for (let axis = 0; axis < 3; axis++) { min[axis] -= PADDING; max[axis] += PADDING; }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const extent = Math.hypot(...max.map((value, axis) => value - center[axis]));
  const base = { ...baseLayout.base };
  const halfWidth = Math.max(Math.abs(min[0]), Math.abs(max[0])) + 6;
  const halfDepth = Math.max(Math.abs(min[2]), Math.abs(max[2])) + 6;
  const radiusX = Math.max(base.countRadiusX || 50, halfWidth);
  const radiusZ = Math.max(base.countRadiusZ || 30, halfDepth);
  const enclosure = Math.max(1, Math.hypot(halfWidth / radiusX, halfDepth / radiusZ));
  base.radiusX = radiusX * enclosure; base.radiusZ = radiusZ * enclosure;
  const depthOffsets = Array.from({ length: baseLayout.maxDepth + 1 }, (_, depth) => depth * tier);
  const levels = depthOffsets.map((offset, depth) => ({ depth, y: ground - offset }));
  const reservedWidths = new Map(rows.map(entry => [entryKey(entry), entry.labelWidthWorld]));
  return {
    ...baseLayout, kind: 'classification', folders, nodes, rows, bounds: { min, max }, center, extent, base,
    footprint: { ...baseLayout.footprint, width: spanWidth, depth: max[2] - min[2], scaleX: 1, scaleZ: 1 },
    proportions: { ...baseLayout.proportions },
    classification: {
      orientation: 'down', depthAxis: 'y', rowAxis: 'x', growthDirection: [0, -1, 0],
      tierPitch: tier, lanePitch: pitch, rowPitch: pitch, depthOffsets, levels,
      rowCount: nodes.length, labelWidths: reservedWidths,
    },
    readability: {
      ...baseLayout.readability, classification: true, rowPitch: pitch, lanePitch: pitch, tierPitch: tier,
      labelHeightWorld: LABEL_HEIGHT, labelPixelsPerWorld: ROOT_CLASSIFICATION_LABEL_SCALE, labelGapWorld: LABEL_GAP,
    },
  };
}
