// Folder envelopes are context geometry only: they never create repository
// atoms, containment edges or activity touches. Positions supplied by the
// molecular layout stay untouched.
const PADDING = 0.2;
const validRadius = atom => Number.isFinite(atom.radius) && atom.radius > 0 ? atom.radius : 1.4;
const finitePoint = position => Array.isArray(position) && position.length === 3 && position.every(Number.isFinite);

// For horizontally circular ellipsoids, the worst child surface lies in the
// vertical plane through both centers. A first-quadrant parameter covers that
// plane after taking absolute center offsets. Interval bounds use decreasing
// cos(theta) and increasing sin(theta), so the result is conservative rather
// than relying on sampled surface points to prove containment.
function horizontalRadiusForChild(offset, vertical, childRadius, childHeight, parentHeight) {
  if (offset < 1e-12 && vertical < 1e-12) return childRadius;
  const evaluate = angle => {
    const y = (vertical + childHeight * Math.sin(angle)) / parentHeight;
    return (offset + childRadius * Math.cos(angle)) / Math.sqrt(Math.max(1e-15, 1 - y * y));
  };
  const upper = (low, high) => {
    const y = (vertical + childHeight * Math.sin(high)) / parentHeight;
    return (offset + childRadius * Math.cos(low)) / Math.sqrt(Math.max(1e-15, 1 - y * y));
  };
  const heap = [];
  const push = item => {
    heap.push(item);
    let index = heap.length - 1;
    while (index) {
      const parent = (index - 1) >> 1;
      if (heap[parent].bound >= item.bound) break;
      heap[index] = heap[parent]; index = parent;
    }
    heap[index] = item;
  };
  const pop = () => {
    const first = heap[0], last = heap.pop();
    if (!heap.length) return first;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && heap[child + 1].bound > heap[child].bound) child++;
      if (heap[child].bound <= last.bound) break;
      heap[index] = heap[child]; index = child;
    }
    heap[index] = last;
    return first;
  };
  const end = Math.PI / 2;
  let best = Math.max(evaluate(0), evaluate(end), evaluate(end / 2));
  push({ low: 0, high: end, bound: upper(0, end) });
  for (let split = 0; split < 256 && heap.length; split++) {
    if (heap[0].bound <= best + Math.max(0.001, best * 0.00005)) break;
    const interval = pop(), middle = (interval.low + interval.high) / 2;
    best = Math.max(best, evaluate(middle));
    for (const [low, high] of [[interval.low, middle], [middle, interval.high]]) {
      best = Math.max(best, evaluate((low + high) / 2));
      const bound = upper(low, high);
      if (bound > best) push({ low, high, bound });
    }
  }
  return Math.max(best, heap[0]?.bound || 0);
}

const ANGLES = Array.from({ length: 17 }, (_, index) => {
  const angle = index / 16 * Math.PI / 2;
  return { angle, sin: Math.sin(angle), cos: Math.cos(angle) };
});
const GOLDEN = (Math.sqrt(5) - 1) / 2;

// Search trials use a small angular bracket; only final candidates need the
// conservative interval solver above. Returned enclosures always use a
// conservative radius.
function trialRadius(item, centerY, height) {
  const vertical = Math.abs(item.y - centerY);
  if (item.offset < 1e-12 && vertical < 1e-12) return item.radius;
  const evaluate = (sin, cos) => {
    const y = (vertical + item.height * sin) / height;
    return (item.offset + item.radius * cos) / Math.sqrt(Math.max(1e-15, 1 - y * y));
  };
  let best = 0, index = 0;
  for (let sample = 0; sample < ANGLES.length; sample++) {
    const value = evaluate(ANGLES[sample].sin, ANGLES[sample].cos);
    if (value > best) { best = value; index = sample; }
  }
  let low = ANGLES[Math.max(0, index - 1)].angle, high = ANGLES[Math.min(16, index + 1)].angle;
  let left = high - GOLDEN * (high - low), right = low + GOLDEN * (high - low);
  let a = evaluate(Math.sin(left), Math.cos(left)), b = evaluate(Math.sin(right), Math.cos(right));
  for (let step = 0; step < 7; step++) {
    if (a > b) {
      high = right; right = left; b = a; left = high - GOLDEN * (high - low);
      a = evaluate(Math.sin(left), Math.cos(left));
    } else {
      low = left; left = right; a = b; right = low + GOLDEN * (high - low);
      b = evaluate(Math.sin(right), Math.cos(right));
    }
  }
  return Math.max(best, a, b);
}

function fitEnvelope(constraints) {
  // A farther equal-height, equal-size atom dominates nearer atoms. This makes
  // even a 500-file tier cheap without dropping any containment constraint.
  const supports = new Map();
  for (const item of constraints) {
    const key = `${item.y}:${item.radius}:${item.height}`;
    if (!supports.has(key) || supports.get(key).offset < item.offset) supports.set(key, item);
  }
  const items = [...supports.values()];
  if (items.length === 1 && items[0].offset < 1e-12) {
    const item = items[0];
    return { centerY: item.y, radius: item.radius, height: item.height };
  }
  const minCenter = Math.min(...items.map(item => item.y)), maxCenter = Math.max(...items.map(item => item.y));
  const candidates = [];
  const atCenter = centerY => {
    const minimumHeight = Math.max(...items.map(item => Math.abs(item.y - centerY) + item.height));
    const evaluate = ratio => {
      const height = minimumHeight * ratio;
      let radius = 0;
      for (const item of items) radius = Math.max(radius, trialRadius(item, centerY, height));
      return { centerY, radius, height, volume: radius * radius * height };
    };
    const ratios = [1.0001, 1.03, 1.1, 1.25, 1.5, 1.9, 2.6, 4];
    const trials = ratios.map(evaluate);
    let best = trials[0], index = 0;
    for (let trial = 1; trial < trials.length; trial++) if (trials[trial].volume < best.volume) { best = trials[trial]; index = trial; }
    let low = ratios[Math.max(0, index - 1)], high = ratios[Math.min(ratios.length - 1, index + 1)];
    let left = high - GOLDEN * (high - low), right = low + GOLDEN * (high - low);
    let a = evaluate(left), b = evaluate(right);
    for (let step = 0; step < 13; step++) {
      if (a.volume < best.volume) best = a;
      if (b.volume < best.volume) best = b;
      if (a.volume < b.volume) {
        high = right; right = left; b = a; left = high - GOLDEN * (high - low); a = evaluate(left);
      } else {
        low = left; left = right; a = b; right = low + GOLDEN * (high - low); b = evaluate(right);
      }
    }
    if (a.volume < best.volume) best = a;
    if (b.volume < best.volume) best = b;
    candidates.push(best);
    return best;
  };
  const centers = minCenter === maxCenter ? [minCenter]
    : Array.from({ length: 7 }, (_, index) => minCenter + (maxCenter - minCenter) * index / 6);
  const trials = centers.map(atCenter);
  let best = trials[0], index = 0;
  for (let trial = 1; trial < trials.length; trial++) if (trials[trial].volume < best.volume) { best = trials[trial]; index = trial; }
  if (maxCenter > minCenter) {
    let low = centers[Math.max(0, index - 1)], high = centers[Math.min(centers.length - 1, index + 1)];
    let left = high - GOLDEN * (high - low), right = low + GOLDEN * (high - low);
    let a = atCenter(left), b = atCenter(right);
    for (let step = 0; step < 12; step++) {
      if (a.volume < b.volume) {
        high = right; right = left; b = a; left = high - GOLDEN * (high - low); a = atCenter(left);
      } else {
        low = left; left = right; a = b; right = low + GOLDEN * (high - low); b = atCenter(right);
      }
    }
  }
  // Re-evaluate the best few trials conservatively. This also avoids choosing
  // a near-pole fit merely because a search sample slightly underestimated it.
  best = null;
  for (const candidate of candidates.sort((a, b) => a.volume - b.volume).slice(0, 4)) {
    let radius = 0;
    for (const item of items) radius = Math.max(radius, horizontalRadiusForChild(
      item.offset, Math.abs(item.y - candidate.centerY), item.radius, item.height, candidate.height,
    ));
    const volume = radius * radius * candidate.height;
    if (!best || volume < best.volume) best = { ...candidate, radius, volume };
  }
  return best;
}

/**
 * Fit a tight, circular-footprint ellipsoid to each active folder. The bounded
 * search minimizes volume over its vertical center and height, then verifies
 * the required horizontal radius conservatively. Atoms retain a 0.2-unit clear
 * margin; immediate child envelopes are included in full, without extra padding.
 *
 * X/Z centers stay on the real folder carbon. Atom coordinates and vertical
 * tiers never change. Counts and geometry use current contents only; ghosts
 * and reserved historical slots are not consulted.
 */
export function buildFolderEnclosures(graph, structure) {
  const activeFolders = structure?.folders || [];
  if (!activeFolders.length) return [];
  const children = new Map(activeFolders.map(folder => [folder.path, []]));
  for (const folder of activeFolders) if (folder.parent !== null && children.has(folder.parent)) children.get(folder.parent).push(folder.path);
  const folderAtoms = new Map((structure.backboneAtoms || []).map(atom => [atom.folder, atom]));
  const directFiles = new Map(activeFolders.map(folder => [folder.path, []]));
  for (const atom of structure.atoms || []) {
    if (directFiles.has(atom.folder) && finitePoint(atom.position)) directFiles.get(atom.folder).push(atom);
  }
  const built = new Map();
  const ordered = [...activeFolders].sort((a, b) => b.depth - a.depth || b.path.length - a.path.length);
  for (const folder of ordered) {
    const fallback = graph?.folderByPath?.get(folder.path);
    const carbon = folderAtoms.get(folder.path) || { position: folder.position || fallback?.position, radius: 1.6 };
    if (!finitePoint(carbon.position)) continue;
    const descendants = children.get(folder.path).map(path => built.get(path)).filter(Boolean);
    const files = directFiles.get(folder.path);
    const atoms = [carbon, ...files];
    const constraints = atoms.map(atom => ({
      offset: Math.hypot(atom.position[0] - carbon.position[0], atom.position[2] - carbon.position[2]),
      y: atom.position[1], radius: validRadius(atom) + PADDING, height: validRadius(atom) + PADDING,
    }));
    for (const child of descendants) constraints.push({
      offset: Math.hypot(child.center[0] - carbon.position[0], child.center[2] - carbon.position[2]),
      y: child.center[1], radius: child.radiusX, height: child.radiusY,
    });
    const fit = fitEnvelope(constraints);
    built.set(folder.path, {
      folder: folder.path, center: [carbon.position[0], fit.centerY, carbon.position[2]],
      radiusX: fit.radius, radiusY: fit.height, radiusZ: fit.radius,
      count: files.length + descendants.reduce((sum, child) => sum + child.count, 0),
      atomCount: atoms.length + descendants.reduce((sum, child) => sum + child.atomCount, 0),
    });
  }
  return activeFolders.map(folder => built.get(folder.path)).filter(Boolean);
}
