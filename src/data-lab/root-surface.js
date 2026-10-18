const RADIUS_X = 50;
const RADIUS_Z = 30;
const DEPTH_WEIGHT = 0.2;
export const MAX_ROOT_SURFACE_HEIGHT = 56;
const smoothstep = (start, end, value) => {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
};
const positive = (value, fallback = 0) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const clampScore = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
const depthWeight = surface => Number.isFinite(Number(surface?.depthWeight)) ? Math.max(0, Number(surface.depthWeight)) : DEPTH_WEIGHT;
const lowerBound = (values, target, inclusive = false) => {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target || (inclusive && values[middle] === target)) low = middle + 1;
    else high = middle;
  }
  return low;
};

function intervalCounter(size) {
  const counts = new Float64Array(size + 1);
  return {
    add(index, change) { for (let i = index + 1; i < counts.length; i += i & -i) counts[i] += change; },
    sum(end) { let total = 0; for (let i = end; i > 0; i -= i & -i) total += counts[i]; return total; },
  };
}

/**
 * Measure filenames at their unbent projected endpoints. Horizontal names use
 * centered (textWidth + 10) by 22px boxes; the default vertical names retain
 * their compact 11px columns. Both begin 8px below each tip.
 * Sorted X events and compressed Y interval counters count variable-width
 * rectangle overlaps in O(n log n), including thousands of coincident tips.
 */
export function measureRootSurfaceCrowding(points, { width, height, labelOrientation = 'vertical' } = {}) {
  const viewportWidth = positive(width), viewportHeight = positive(height);
  const visible = (points || []).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.visible !== false && point.x >= 0 && point.y >= 0
    && (!viewportWidth || point.x <= viewportWidth) && (!viewportHeight || point.y <= viewportHeight));
  const horizontal = labelOrientation === 'horizontal';
  const rectangles = visible.map(point => {
    const top = point.y + 8, textWidth = positive(point.textWidth, 12);
    const halfWidth = horizontal ? (textWidth + 10) / 2 : 5.5;
    return {
      left: point.x - halfWidth, right: point.x + halfWidth, top,
      bottom: Math.min(top + (horizontal ? 22 : textWidth + 4), viewportHeight || Infinity),
    };
  }).filter(rectangle => rectangle.bottom > rectangle.top);
  const coordinates = [...new Set(rectangles.flatMap(rectangle => [rectangle.top, rectangle.bottom]))].sort((a, b) => a - b);
  const events = rectangles.flatMap(rectangle => [
    { x: rectangle.left, change: 1, rectangle },
    { x: rectangle.right, change: -1, rectangle },
  ]).sort((a, b) => a.x - b.x || a.change - b.change
    || a.rectangle.top - b.rectangle.top || a.rectangle.bottom - b.rectangle.bottom);
  const starts = intervalCounter(coordinates.length), ends = intervalCounter(coordinates.length);
  let active = 0, overlapCount = 0, maxColumnLoad = 0;
  for (const { change, rectangle } of events) {
    if (change > 0) {
      // End events run first at equal X, and these inclusive/exclusive Y
      // queries likewise exclude labels whose edges merely touch.
      const below = ends.sum(lowerBound(coordinates, rectangle.top, true));
      const above = active - starts.sum(lowerBound(coordinates, rectangle.bottom));
      const overlaps = active - below - above;
      overlapCount += overlaps;
      maxColumnLoad = Math.max(maxColumnLoad, overlaps + 1);
    }
    starts.add(lowerBound(coordinates, rectangle.top), change);
    ends.add(lowerBound(coordinates, rectangle.bottom), change);
    active += change;
  }
  const averageOverlap = visible.length ? 2 * overlapCount / visible.length : 0;
  const score = Math.max(smoothstep(0.08, 1.4, averageOverlap), 0.45 * smoothstep(2, 8, maxColumnLoad));
  return {
    score, visibleFileCount: visible.length, measuredFileCount: rectangles.length,
    overlapCount, maxColumnLoad, averageOverlap, viewportWidth, viewportHeight,
  };
}

/**
 * Responsive presentation only: unmeasured or spacious clear views stay flat.
 * Actual projected overlap bends the surface; narrow viewports also create room
 * once about ten filenames are visible. Explicit height reserves geometry
 * capacity or supplies a deterministic test pose, independent of these metrics.
 */
export function createRootSurface(layout, { height, viewportWidth, crowding } = {}) {
  const nodes = layout.nodes || [];
  const measured = crowding && typeof crowding === 'object' ? crowding : null;
  const visibleFileCount = measured && Number.isFinite(measured.visibleFileCount)
    ? Math.max(0, Math.floor(measured.visibleFileCount)) : nodes.length;
  const projectedCrowding = clampScore(measured ? measured.score : crowding);
  const width = positive(viewportWidth, positive(measured?.viewportWidth));
  const populationPressure = smoothstep(8, 20, visibleFileCount);
  const narrowPressure = width ? (1 - smoothstep(420, 980, width)) * populationPressure : 0;
  const responsivePressure = Math.max(projectedCrowding, narrowPressure);
  const resolvedHeight = height === undefined ? MAX_ROOT_SURFACE_HEIGHT * responsivePressure : positive(height);
  return {
    height: resolvedHeight, radiusX: RADIUS_X, radiusZ: RADIUS_Z, depthWeight: DEPTH_WEIGHT,
    active: resolvedHeight > 0, groundY: layout.groundY ?? -40,
    fileCount: nodes.length, visibleFileCount, viewportWidth: width,
    projectedCrowding, narrowPressure, populationPressure, crowding: responsivePressure,
    overlapCount: measured?.overlapCount || 0, maxColumnLoad: measured?.maxColumnLoad || 0,
  };
}

/**
 * Negative vertical displacement below the original ground. The trunk is the
 * global maximum, with zero displacement and slope. Horizontal curl is stronger
 * than depth curl, so the soil ellipse bends downward rather than translating.
 */
export function rootSurfaceHeight(surface, x, z) {
  const height = positive(surface?.height);
  if (!height) return 0;
  const rx = positive(surface?.radiusX, RADIUS_X), rz = positive(surface?.radiusZ, RADIUS_Z);
  const q = (x / rx) ** 2 + depthWeight(surface) * (z / rz) ** 2;
  const displacement = Number.isFinite(q) ? height * (q / (1 + q)) : height;
  return displacement ? -displacement : 0;
}

/** Jacobian slopes [dy/dx, dy/dz] for the shared downward field. */
export function rootSurfaceGradient(surface, x, z) {
  const height = positive(surface?.height);
  if (!height) return [0, 0];
  const rx = positive(surface?.radiusX, RADIUS_X), rz = positive(surface?.radiusZ, RADIUS_Z);
  const weight = depthWeight(surface);
  const q = (x / rx) ** 2 + weight * (z / rz) ** 2;
  if (!Number.isFinite(q)) return [0, 0];
  const denominator = (1 + q) ** 2;
  const dx = 2 * height * x / (rx ** 2 * denominator);
  const dz = 2 * height * weight * z / (rz ** 2 * denominator);
  return [dx ? -dx : 0, dz ? -dz : 0];
}

/**
 * Bend the existing hierarchy down with the same field used by the ground mesh.
 * Endpoint tangents use the field Jacobian, preserving aligned junctions rather
 * than bending each Bezier control independently. The transform leaves X/Z,
 * topology, identities, and physical rope radii untouched. Its determinant is 1.
 */
export function applyRootSurface(layout, surface) {
  const active = positive(surface?.height) > 0;
  const lift = point => [point[0], point[1] + rootSurfaceHeight(surface, point[0], point[2]), point[2]];
  const tangent = (point, vector) => {
    const [dx, dz] = rootSurfaceGradient(surface, point[0], point[2]);
    return [vector[0], vector[1] + dx * vector[0] + dz * vector[2], vector[2]];
  };
  const clone = record => {
    let curve = record.curve.map(point => [...point]);
    if (active) {
      const [p0, p1, p2, p3] = record.curve;
      const start = lift(p0), end = lift(p3);
      const outgoing = tangent(p0, p1.map((value, axis) => value - p0[axis]));
      const incoming = tangent(p3, p3.map((value, axis) => value - p2[axis]));
      curve = [
        start,
        start.map((value, axis) => value + outgoing[axis]),
        end.map((value, axis) => value - incoming[axis]),
        end,
      ];
    }
    return {
      ...record, position: active ? lift(record.position) : [...record.position],
      curve, points: curve,
      ...(record.children ? { children: [...record.children] } : {}),
      ...(record.directFiles ? { directFiles: [...record.directFiles] } : {}),
    };
  };
  const folders = layout.folders.map(clone), nodes = layout.nodes.map(clone);
  const byPath = new Map(folders.map(folder => [folder.path, folder]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const rows = (layout.rows || [...layout.folders, ...layout.nodes]).map(row => row.kind === 'file' ? byId.get(row.id) : byPath.get(row.path));
  const min = [...layout.bounds.min], max = [...layout.bounds.max];
  if (active) {
    // Keep the existing physical-radius padding around the actual control
    // envelope. Adding the full possible bowl height would reserve empty space
    // over the pinned trunk and unnecessarily shrink the roots when framing.
    let originalLow = Infinity, originalHigh = -Infinity;
    let transformedLow = Infinity, transformedHigh = -Infinity;
    for (const row of [...layout.folders, ...layout.nodes]) for (const point of row.curve) {
      originalLow = Math.min(originalLow, point[1]); originalHigh = Math.max(originalHigh, point[1]);
    }
    for (const row of rows) for (const point of row.curve) {
      transformedLow = Math.min(transformedLow, point[1]); transformedHigh = Math.max(transformedHigh, point[1]);
    }
    const lowerPadding = Math.max(0, originalLow - layout.bounds.min[1]);
    const upperPadding = Math.max(0, layout.bounds.max[1] - originalHigh);
    min[1] = transformedLow - lowerPadding;
    max[1] = transformedHigh + upperPadding;
  }
  const center = active ? min.map((value, axis) => (value + max[axis]) / 2) : [...layout.center];
  return {
    ...layout, folders, nodes, rows, bounds: { min, max }, center,
    extent: active ? Math.hypot(...max.map((value, axis) => value - center[axis])) : layout.extent,
    footprint: { ...layout.footprint }, surface: { ...surface, active },
  };
}
