import { ROOT_LENGTH_PER_TOUCH } from './root-proportions.js';
export { ROOT_LENGTH_PER_TOUCH } from './root-proportions.js';
const DEFAULT_PADDING = 2;

const nonnegative = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};
const readTouches = (values, id) => Math.floor(nonnegative(values instanceof Map ? values.get(id) : values?.[id], 0));

/** Cubic Bezier arc length, integrated from its speed rather than its chord. */
export function rootCurveLength(curve) {
  const [p0, p1, p2, p3] = curve;
  const speed = t => {
    const u = 1 - t;
    const derivative = axis => 3 * (u * u * (p1[axis] - p0[axis])
      + 2 * u * t * (p2[axis] - p1[axis]) + t * t * (p3[axis] - p2[axis]));
    return Math.hypot(derivative(0), derivative(1), derivative(2));
  };
  const a = speed(0), b = speed(0.5), c = speed(1);
  const whole = (a + 4 * b + c) / 6;
  const integrate = (start, end, left, middle, right, estimate, tolerance, depth) => {
    const midpoint = (start + end) / 2;
    const first = speed((start + midpoint) / 2), second = speed((midpoint + end) / 2);
    const leftArea = (midpoint - start) * (left + 4 * first + middle) / 6;
    const rightArea = (end - midpoint) * (middle + 4 * second + right) / 6;
    const difference = leftArea + rightArea - estimate;
    if (!depth || Math.abs(difference) <= 15 * tolerance) return leftArea + rightArea + difference / 15;
    return integrate(start, midpoint, left, first, middle, leftArea, tolerance / 2, depth - 1)
      + integrate(midpoint, end, middle, second, right, rightArea, tolerance / 2, depth - 1);
  };
  return Math.max(0, integrate(0, 1, a, b, c, whole, Math.max(1e-9, whole * 1e-10), 16));
}

function cloneRecord(record) {
  const curve = record.curve.map(point => [...point]);
  return {
    ...record, position: [...record.position], curve, points: curve,
    ...(record.children ? { children: [...record.children] } : {}),
    ...(record.directFiles ? { directFiles: [...record.directFiles] } : {}),
    ...(record.rowSpan ? { rowSpan: [...record.rowSpan] } : {}),
    ...(record.laneBounds ? { laneBounds: [...record.laneBounds] } : {}),
    ...(record.labelDirection ? { labelDirection: [...record.labelDirection] } : {}),
    ...(record.labelBounds ? { labelBounds: { min: [...record.labelBounds.min], max: [...record.labelBounds.max] } } : {}),
  };
}

// Every touch has the same downward displacement, regardless of file size
// or initial branch shape. Moving the last two controls together preserves
// the assigned X/Z lane and both endpoint tangents.
function growClassificationCurve(node, addedLength) {
  const curve = node.curve.map(point => [...point]);
  const displacement = -addedLength;
  curve[2][1] += displacement;
  curve[3][1] += displacement;
  if (node.labelBounds) {
    node.labelBounds.min[1] += displacement;
    node.labelBounds.max[1] += displacement;
  }
  return curve;
}

function expandedBase(baseLayout, min, max) {
  const fileCount = baseLayout.nodes.length;
  const capacityScale = Math.sqrt(Math.max(1, fileCount / 64));
  const original = baseLayout.base || {
    fileCount, capacityScale, countRadiusX: 50 * capacityScale, countRadiusZ: 30 * capacityScale,
    radiusX: 50 * capacityScale, radiusZ: 30 * capacityScale, padding: 6,
  };
  const padding = nonnegative(original.padding, 6);
  const halfWidth = Math.max(Math.abs(min[0]), Math.abs(max[0])) + padding;
  const halfDepth = Math.max(Math.abs(min[2]), Math.abs(max[2])) + padding;
  const radiusX = original.radiusX, radiusZ = original.radiusZ;
  const scale = Math.max(1, Math.hypot(halfWidth / radiusX, halfDepth / radiusZ));
  return { ...original, radiusX: radiusX * scale, radiusZ: radiusZ * scale };
}

/**
 * Each visible file gains the same calibrated amount per stable-ID touch.
 * Organic mode adds exact arc length by scaling its cubic about its fixed parent.
 * Classification mode instead adds exact downward displacement in negative Y,
 * preserving its assigned X/Z lane. File bytes never enter either calculation.
 * addedLength is the quantitative extension in lengthGrowth.metric; length and
 * actualArcLength always describe the resulting curve's physical arc length.
 * Folder junctions, untouched files and neighbouring subtrees never move.
 * The default increment comes from the layout's repository-width proportions;
 * an explicit lengthPerTouch, including zero, overrides that data scale.
 *
 * Pass lifetime fileTouches from rootActivityAt, not current membership counts,
 * so a rename retains the file's accumulated growth. The caller supplies the
 * selected frame's exact hierarchy; this helper has no history or camera state.
 * Padding is world-space clearance and may include the largest physical radius.
 */
export function createRootLengthLayout(baseLayout, { fileTouches, lengthPerTouch, padding = DEFAULT_PADDING } = {}) {
  const inheritedIncrement = nonnegative(baseLayout.proportions?.lengthPerTouch, ROOT_LENGTH_PER_TOUCH);
  const increment = lengthPerTouch === undefined ? inheritedIncrement : nonnegative(lengthPerTouch, inheritedIncrement);
  const clearance = nonnegative(padding, DEFAULT_PADDING);
  const metric = baseLayout.kind === 'classification' ? 'vertical' : 'arc';
  const folders = baseLayout.folders.map(cloneRecord), nodes = baseLayout.nodes.map(cloneRecord);
  const byPath = new Map(folders.map(folder => [folder.path, folder]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  let totalAddedLength = 0, maxTouches = 0;
  for (const node of nodes) {
    const touches = readTouches(fileTouches, node.id);
    const baseLength = rootCurveLength(node.curve);
    const addedLength = increment * touches;
    node.touchCount = touches;
    node.baseLength = baseLength;
    node.addedLength = addedLength;
    node.length = baseLength + addedLength;
    node.actualArcLength = node.length;
    node.addedArcLength = addedLength;
    totalAddedLength += addedLength;
    maxTouches = Math.max(maxTouches, touches);
    if (!addedLength) continue;
    const origin = node.curve[0];
    if (metric === 'vertical') {
      node.curve = growClassificationCurve(node, addedLength);
      node.length = node.actualArcLength = rootCurveLength(node.curve);
      node.addedArcLength = node.actualArcLength - baseLength;
    } else if (baseLength > 1e-12) {
      const scale = 1 + addedLength / baseLength;
      node.curve = node.curve.map(point => point.map((value, axis) => origin[axis] + (value - origin[axis]) * scale));
    } else {
      // A coincident synthetic edge has no direction to preserve. The normal
      // hierarchy always has a vertical tier, but this keeps empty edges finite.
      node.curve = Array.from({ length: 4 }, (_, index) => [origin[0], origin[1] - addedLength * index / 3, origin[2]]);
    }
    node.points = node.curve;
    node.position = [...node.curve[3]];
  }
  const rows = (baseLayout.rows || [...baseLayout.folders, ...baseLayout.nodes])
    .map(row => row.kind === 'file' ? byId.get(row.id) : byPath.get(row.path));
  const active = totalAddedLength > 0;
  const min = [...baseLayout.bounds.min], max = [...baseLayout.bounds.max];
  // Keep the original reserved footprint, then enclose every current curve's
  // convex hull. A wider physical rope can request clearance even at baseline.
  for (const row of rows) for (const point of row.curve) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis] - clearance);
    max[axis] = Math.max(max[axis], point[axis] + clearance);
  }
  if (baseLayout.kind === 'classification') for (const row of rows) if (row.labelBounds) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], row.labelBounds.min[axis] - clearance);
      max[axis] = Math.max(max[axis], row.labelBounds.max[axis] + clearance);
    }
  }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const extent = Math.hypot(...max.map((value, axis) => value - center[axis]));
  const footprint = active && metric === 'arc' ? {
    ...baseLayout.footprint,
    width: 2 * Math.max(Math.abs(min[0]), Math.abs(max[0])),
    depth: 2 * Math.max(Math.abs(min[2]), Math.abs(max[2])),
  } : { ...baseLayout.footprint };
  return {
    ...baseLayout, folders, nodes, rows, bounds: { min, max }, center, extent, footprint,
    base: expandedBase(baseLayout, min, max),
    ...(baseLayout.readability ? { readability: { ...baseLayout.readability } } : {}),
    ...(baseLayout.proportions ? { proportions: { ...baseLayout.proportions } } : {}),
    lengthGrowth: { active, metric, lengthPerTouch: increment, totalAddedLength, maxTouches },
  };
}
