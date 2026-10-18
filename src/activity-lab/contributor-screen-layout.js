const CLEARANCE_EPSILON = .001;
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const rectangle = value => ({
  id: value.id,
  x: finite(value.x, 0), y: finite(value.y, 0),
  width: Math.max(1, finite(value.width, 1)), height: Math.max(1, finite(value.height, 1)),
});
const overlaps = (a, b, gap) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap
  && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Find the nearest free center on a vertical line through x. Finite occupied
 * rectangles give a finite union of forbidden intervals; above/below it is free. */
function nearestY(x, y, width, height, occupied, gap, minimumY, maximumY = Infinity) {
  if (maximumY < minimumY) return null;
  const intervals = [];
  for (const other of occupied) {
    if (Math.abs(x - other.x) >= (width + other.width) / 2 + gap) continue;
    const half = (height + other.height) / 2 + gap;
    intervals.push([other.y - half, other.y + half]);
  }
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + 2 * CLEARANCE_EPSILON) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  let best = null, distance = Infinity, cursor = minimumY;
  const consider = (low, high) => {
    if (high < low) return;
    const candidate = clamp(y, low, high), delta = Math.abs(candidate - y);
    if (delta < distance) { best = candidate; distance = delta; }
  };
  for (const [low, high] of merged) {
    if (high < minimumY) continue;
    if (low > maximumY) break;
    consider(cursor, Math.min(maximumY, low - CLEARANCE_EPSILON));
    cursor = Math.max(cursor, high + CLEARANCE_EPSILON);
    if (cursor > maximumY) break;
  }
  consider(cursor, maximumY);
  return best;
}

/** Repack the complete set when locally good choices have fragmented the
 * viewport. Variable-width bottom/top-edge packing fills rows without reserving
 * every card the width of the longest name. A few deterministic orders are cheap
 * for contributor groups and avoid relying on one unlucky greedy order. */
function repackWithinBounds(cards, { left, right, top, bottom, gap, obstacles, priorityId, priorityPosition }) {
  const width = right - left, height = bottom - top;
  if (![left, right, top, bottom].every(Number.isFinite) || width <= 0 || height <= 0
    || cards.some(card => card.width > width || card.height > height)
    || cards.reduce((sum, card) => sum + card.width * card.height, 0) > width * height) return null;
  const byId = (a, b) => compare(String(a.id), String(b.id));
  const orders = [
    (a, b) => b.height - a.height || b.width - a.width || byId(a, b),
    (a, b) => b.width - a.width || b.height - a.height || byId(a, b),
    (a, b) => b.width * b.height - a.width * a.height || byId(a, b),
    (a, b) => a.width - b.width || b.height - a.height || byId(a, b),
  ];
  const selected = cards.find(card => card.id === priorityId);
  const pinned = selected && priorityPosition ? { ...selected, ...priorityPosition } : null;
  const canPin = pinned && pinned.x - pinned.width / 2 >= left && pinned.x + pinned.width / 2 <= right
    && pinned.y - pinned.height / 2 >= top && pinned.y + pinned.height / 2 <= bottom
    && !obstacles.some(obstacle => overlaps(pinned, obstacle, gap));
  // Keep the selected card fixed whenever any complete packing permits it.
  for (const pinPriority of canPin ? [true, false] : [false]) {
    let best = null, bestCost = Infinity;
    for (const order of orders) for (const horizontal of [1, -1]) for (const vertical of [1, -1]) {
      const occupied = [...obstacles], positions = new Map();
      if (pinPriority) { occupied.push(pinned); positions.set(pinned.id, { x: pinned.x, y: pinned.y }); }
      const pending = cards.filter(card => !pinPriority || card.id !== priorityId).sort(order);
      let failed = false;
      for (const card of pending) {
        const lowX = left + card.width / 2, highX = right - card.width / 2;
        const lowY = top + card.height / 2, highY = bottom - card.height / 2;
        const xs = new Set([lowX, highX]);
        for (const other of occupied) {
          const half = (card.width + other.width) / 2 + gap + CLEARANCE_EPSILON;
          for (const x of [other.x - half, other.x + half]) if (x >= lowX && x <= highX) xs.add(x);
        }
        let placement = null;
        for (const x of [...xs].sort((a, b) => horizontal * (a - b))) {
          const y = nearestY(x, vertical > 0 ? lowY : highY, card.width, card.height, occupied, gap, lowY, highY);
          if (y === null) continue;
          if (!placement || vertical * y < vertical * placement.y - 1e-8) placement = { x, y };
        }
        if (!placement) { failed = true; break; }
        positions.set(card.id, placement);
        occupied.push({ ...card, ...placement });
      }
      if (failed) continue;
      const cost = cards.reduce((sum, card) => {
        const position = positions.get(card.id);
        return sum + (position.x - card.x) ** 2 + (position.y - card.y) ** 2;
      }, 0);
      if (cost < bestCost) { best = positions; bestCost = cost; }
    }
    if (best) return new Map(cards.map(card => [card.id, best.get(card.id)]));
  }
  return null;
}

/**
 * Place full portrait + unabridged-name rectangles without hiding or resizing.
 * x/y are rectangle CENTERS in CSS pixels. The returned Map contains centers.
 *
 * Cards are processed by projected x, then y, then id, independently of input
 * array order, except an optional priorityId is processed first and retains its
 * free constrained anchor. An edge sweep chooses the nearest available position; expansion
 * prefers the optional top/bottom bounds before expanding below the viewport.
 * Optional left/right constrain whole fitting cards and top is always respected.
 * Before downward overflow, a global variable-width packing pass tries to fit
 * every complete card inside the bounds, keeping the priority anchor if possible.
 * Overflow remains the last fallback when the bounded attempts cannot fit all cards.
 * A card wider than those bounds is centered across them and may overflow.
 * Fixed obstacles use the same center/width/height convention and are untouched.
 *
 * Crowded bounded cards use available columns as preferred anchors, allowing
 * mobile layouts to wrap. Original noncolliding anchors remain unchanged.
 */
export function placeContributorCards(cards, { gap = 12, left, right, top, bottom, obstacles = [], priorityId } = {}) {
  const separation = Math.max(0, finite(gap, 12));
  const topEdge = finite(top, -Infinity);
  const bottomEdge = finite(bottom, Infinity);
  const minEdge = finite(left, -Infinity), maxEdge = finite(right, Infinity);
  const bounded = Number.isFinite(minEdge) && Number.isFinite(maxEdge) && maxEdge > minEdge;
  const available = bounded ? maxEdge - minEdge : Infinity;
  const occupied = (Array.isArray(obstacles) ? obstacles : []).filter(Boolean).map(rectangle);
  const fixedObstacles = [...occupied];
  const unique = new Map();
  for (const value of Array.isArray(cards) ? cards : []) if (value && !unique.has(value.id)) unique.set(value.id, rectangle(value));
  const isPriority = card => priorityId != null && card.id === priorityId;
  const ordered = [...unique.values()].sort((a, b) => Number(isPriority(b)) - Number(isPriority(a))
    || a.x - b.x || a.y - b.y || compare(String(a.id), String(b.id)));
  const range = card => bounded
    ? card.width > available ? [(minEdge + maxEdge) / 2, (minEdge + maxEdge) / 2]
      : [minEdge + card.width / 2, maxEdge - card.width / 2]
    : [-Infinity, Infinity];
  const anchors = ordered.map(card => {
    const [low, high] = range(card);
    return { ...card, x: clamp(card.x, low, high), y: Math.max(card.y, topEdge + card.height / 2) };
  });
  const crowded = new Set();
  if (bounded) for (let index = 0; index < anchors.length; index++) {
    const card = anchors[index];
    if (occupied.some(other => overlaps(card, other, separation))) crowded.add(card.id);
    for (let other = 0; other < index; other++) if (overlaps(card, anchors[other], separation)) {
      crowded.add(card.id); crowded.add(anchors[other].id);
    }
  }
  const fittingWidths = anchors.filter(card => card.width <= available).map(card => card.width);
  const columnWidth = fittingWidths.length ? Math.max(...fittingWidths) : available;
  const columns = bounded ? Math.max(1, Math.floor((available + separation) / (columnWidth + separation))) : 1;
  const columnStep = columnWidth + separation + CLEARANCE_EPSILON;
  const columnStart = bounded ? (minEdge + maxEdge) / 2 - (columns - 1) * columnStep / 2 : 0;
  const result = new Map();
  let triedRepacking = false;

  for (const card of anchors) {
    const [low, high] = range(card);
    let preferredX = card.x;
    if (bounded && columns > 1 && crowded.has(card.id) && card.width <= available && !isPriority(card)) {
      const index = clamp(Math.floor((card.x - columnStart) / columnStep + .5 - 1e-10), 0, columns - 1);
      preferredX = clamp(columnStart + index * columnStep, low, high);
    }
    const candidates = new Set([preferredX]);
    if (Number.isFinite(low)) candidates.add(low);
    if (Number.isFinite(high)) candidates.add(high);
    for (const other of occupied) {
      const half = (card.width + other.width) / 2 + separation + CLEARANCE_EPSILON;
      for (const x of [other.x - half, other.x + half]) if (x >= low && x <= high) candidates.add(x);
    }
    const xs = [...candidates].sort((a, b) => Math.abs(a - preferredX) - Math.abs(b - preferredX) || a - b);
    let best = null;
    // An offscreen placement must never beat a free onscreen alternative, even
    // when the latter is farther horizontally from the projected anchor.
    for (const [pass, maximumY] of [bottomEdge - card.height / 2, Infinity].entries()) {
      if (pass === 1 && !triedRepacking) {
        triedRepacking = true;
        const packed = repackWithinBounds(anchors, { left: minEdge, right: maxEdge, top: topEdge, bottom: bottomEdge,
          gap: separation, obstacles: fixedObstacles, priorityId, priorityPosition: result.get(priorityId) });
        if (packed) return packed;
      }
      let bestDistance = Infinity;
      for (const x of xs) {
        const dx = x - preferredX;
        if (dx * dx > bestDistance) break;
        const y = nearestY(x, card.y, card.width, card.height, occupied, separation, topEdge + card.height / 2, maximumY);
        if (y === null) continue;
        const distance = dx * dx + (y - card.y) ** 2;
        if (distance < bestDistance) { best = { x, y }; bestDistance = distance; }
      }
      if (best) break;
    }
    result.set(card.id, best);
    occupied.push({ ...card, ...best });
  }
  return result;
}
