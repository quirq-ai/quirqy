const CLEARANCE = .001;
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const circle = value => ({
  x: finite(value?.x), y: finite(value?.y), radius: Math.max(0, finite(value?.radius)),
});

/** Enclose the complete screen-space portraits and names, retaining the
 * original category circle as the minimum capacity. Coordinates are CSS pixels.
 * A deterministic center search follows the contributor collection as its
 * cards spread out while avoiding excess area around irregular portrait rows. */
export function encloseContributorCards(cards, { minimumCircle, padding = 14 } = {}) {
  const base = circle(minimumCircle);
  const inset = Math.max(0, finite(padding, 14));
  const corners = [];
  let left = base.x - base.radius, right = base.x + base.radius;
  let top = base.y - base.radius, bottom = base.y + base.radius;
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card) continue;
    const x = finite(card.x), y = finite(card.y);
    const halfWidth = Math.max(0, finite(card.width)) / 2 + inset;
    const halfHeight = Math.max(0, finite(card.height)) / 2 + inset;
    left = Math.min(left, x - halfWidth); right = Math.max(right, x + halfWidth);
    top = Math.min(top, y - halfHeight); bottom = Math.max(bottom, y + halfHeight);
    for (const dx of [-halfWidth, halfWidth]) for (const dy of [-halfHeight, halfHeight]) corners.push({ x: x + dx, y: y + dy });
  }
  if (!corners.length) return base;
  const radiusAt = (x, y) => {
    let radius = Math.hypot(x - base.x, y - base.y) + base.radius;
    for (const corner of corners) radius = Math.max(radius, Math.hypot(corner.x - x, corner.y - y));
    return radius;
  };
  const x = left / 2 + right / 2, y = top / 2 + bottom / 2;
  let best = { x, y, radius: radiusAt(x, y) };
  const baseRadius = radiusAt(base.x, base.y);
  if (baseRadius < best.radius) best = { x: base.x, y: base.y, radius: baseRadius };
  // Irregular portrait rows leave empty corners in their bounding rectangle.
  // Tighten the circle with a bounded search over this convex radius function;
  // every candidate is itself a valid enclosure, never an estimated radius.
  const diagonal = Math.SQRT1_2;
  const directions = [[1, 0], [diagonal, diagonal], [0, 1], [-diagonal, diagonal],
    [-1, 0], [-diagonal, -diagonal], [0, -1], [diagonal, -diagonal]];
  let step = Math.max(right - left, bottom - top) / 4;
  for (let iteration = 0; iteration < 20 && step > .01 && best.radius > base.radius; iteration++) {
    let next = best;
    for (const [dx, dy] of directions) {
      const px = best.x + dx * step, py = best.y + dy * step;
      const radius = radiusAt(px, py);
      if (radius < next.radius - 1e-7) next = { x: px, y: py, radius };
    }
    if (next === best) step /= 2;
    else best = next;
  }
  return best;
}

function intersectionPoints(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
  if (!distance || distance > a.radius + b.radius || distance < Math.abs(a.radius - b.radius)) return [];
  const along = (a.radius ** 2 - b.radius ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, a.radius ** 2 - along ** 2));
  const x = a.x + along * dx / distance, y = a.y + along * dy / distance;
  const px = -dy * height / distance, py = dx * height / distance;
  return [{ x: x + px, y: y + py }, { x: x - px, y: y - py }];
}

function angleFor(id) {
  let hash = 2166136261;
  for (const char of String(id)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) / 0x100000000 * Math.PI * 2;
}

function nearestFreeCenter(anchor, occupied, gap) {
  // Expand fixed circles by the moving circle's radius. Placement then reduces
  // to finding the nearest point outside their union, without resizing anything.
  const forbidden = occupied.map(other => ({ ...other, radius: other.radius + anchor.radius + gap + CLEARANCE }));
  const free = point => forbidden.every(other => Math.hypot(point.x - other.x, point.y - other.y) >= other.radius - 1e-7);
  if (free(anchor)) return { x: anchor.x, y: anchor.y };
  const candidates = [];
  const angle = angleFor(anchor.id);
  for (const other of forbidden) {
    const dx = anchor.x - other.x, dy = anchor.y - other.y, distance = Math.hypot(dx, dy);
    const ux = distance > 1e-9 ? dx / distance : Math.cos(angle);
    const uy = distance > 1e-9 ? dy / distance : Math.sin(angle);
    candidates.push({ x: other.x + ux * other.radius, y: other.y + uy * other.radius });
  }
  // A closest free point lies on a circle's radial projection or at the meeting
  // of two boundaries. Enumerating both avoids iterative pushes and drift.
  for (let i = 0; i < forbidden.length; i++) for (let j = 0; j < i; j++) candidates.push(...intersectionPoints(forbidden[i], forbidden[j]));
  let result = null, bestDistance = Infinity;
  for (const candidate of candidates) {
    if (!free(candidate)) continue;
    const distance = Math.hypot(candidate.x - anchor.x, candidate.y - anchor.y);
    if (distance < bestDistance - 1e-7 || (Math.abs(distance - bestDistance) <= 1e-7
      && result && (candidate.x < result.x || (candidate.x === result.x && candidate.y < result.y)))) {
      result = candidate; bestDistance = distance;
    }
  }
  if (result) return result;
  // Numerical degeneracy cannot leave a category intersecting its neighbors:
  // beyond the rightmost expanded edge is always free for these finite circles.
  return { x: Math.max(anchor.x, ...forbidden.map(other => other.x + other.radius)) + CLEARANCE, y: anchor.y };
}

/** Translate whole neighboring category circles away from the expanded
 * contributor enclosure, the repository, and each other. Input coordinates are
 * original projected anchors; invoking this each frame therefore cannot drift.
 * Radii are preserved and no viewport limits compromise required clearance.
 * Fixed obstacles may overlap one another; returned circles overlap none of them.
 */
export function displaceConstellationClusters(clusters, { enclosure, obstacles = [], gap = 18 } = {}) {
  const separation = Math.max(0, finite(gap, 18));
  const occupied = [circle(enclosure), ...(Array.isArray(obstacles) ? obstacles : []).filter(Boolean).map(circle)];
  const ordered = (Array.isArray(clusters) ? clusters : []).filter(Boolean)
    .map(value => ({ id: value.id, ...circle(value) }))
    .sort((a, b) => compare(String(a.id), String(b.id)) || a.x - b.x || a.y - b.y || a.radius - b.radius);
  const result = new Map();
  for (const cluster of ordered) {
    if (result.has(cluster.id)) continue;
    const position = { ...nearestFreeCenter(cluster, occupied, separation), radius: cluster.radius };
    result.set(cluster.id, position);
    occupied.push(position);
  }
  return result;
}
