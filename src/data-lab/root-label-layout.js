const compare = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const intersects = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left
  && a.top < b.top + b.height && a.top + a.height > b.top;
const overlapArea = (a, b) => Math.max(0, Math.min(a.left + a.width + 2, b.left + b.width + 2) - Math.max(a.left - 2, b.left - 2))
  * Math.max(0, Math.min(a.top + a.height + 2, b.top + b.height + 2) - Math.max(a.top - 2, b.top - 2));

/**
 * Horizontal names stay near their real projected endpoints. Folders reserve
 * space first; a bounded set of alignments and rows places files around them.
 * Small views use exact overlap costs and compact local refinements. Dense views
 * use a screen occupancy grid, avoiding an unbounded all-pairs label comparison.
 * Every input receives a placement, preserving the complete available index.
 */
export function placeRootLabels(records, { width, height, focusMode = false, obstacles = [] } = {}) {
  const viewportWidth = Math.max(24, Number(width) || 24), viewportHeight = Math.max(24, Number(height) || 24);
  const exact = records.length <= 160;
  const cell = Math.max(exact ? 4 : 8, Math.ceil(Math.max(viewportWidth, viewportHeight) / 512));
  const columns = Math.ceil(viewportWidth / cell), rows = Math.ceil(viewportHeight / cell);
  const occupancy = new Float32Array(columns * rows);
  const placements = new Map(), kinds = new Map(records.map(record => [record.key, record.kind]));
  const cells = (box, visit) => {
    const x0 = clamp(Math.floor((box.left - 2) / cell), 0, columns - 1);
    const x1 = clamp(Math.floor((box.left + box.width + 2) / cell), 0, columns - 1);
    const y0 = clamp(Math.floor((box.top - 2) / cell), 0, rows - 1);
    const y1 = clamp(Math.floor((box.top + box.height + 2) / cell), 0, rows - 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) visit(y * columns + x);
  };
  for (const box of obstacles) cells(box, index => { occupancy[index] += 12; });
  const ordered = [...records].sort((a, b) => Number(a.kind !== 'folder') - Number(b.kind !== 'folder')
    || a.y - b.y || a.x - b.x || compare(a.key, b.key));
  const candidatesFor = record => {
    const boxWidth = Math.min(Math.max(12, record.width), viewportWidth - 12);
    const boxHeight = Math.min(Math.max(12, record.height), viewportHeight - 12);
    const candidates = [];
    if (record.kind === 'folder') {
      for (const shift of [0, -18, 18]) {
        candidates.push([record.x + 10, record.y - boxHeight / 2 + shift]);
        candidates.push([record.x - boxWidth - 10, record.y - boxHeight / 2 + shift]);
      }
    } else {
      const gaps = [];
      for (let gap = 8; gap <= (focusMode ? 48 : 28); gap += boxHeight + 4) gaps.push(gap);
      for (const gap of gaps) {
        candidates.push([record.x - boxWidth / 2, record.y + gap]);
        candidates.push([record.x + 8, record.y + gap]);
        candidates.push([record.x - boxWidth - 8, record.y + gap]);
      }
      for (const gap of focusMode ? gaps : [8]) {
        candidates.push([record.x - boxWidth / 2, record.y - boxHeight - gap]);
        candidates.push([record.x + 8, record.y - boxHeight - gap]);
        candidates.push([record.x - boxWidth - 8, record.y - boxHeight - gap]);
      }
      candidates.push([record.x + 10, record.y - boxHeight / 2]);
      candidates.push([record.x - boxWidth - 10, record.y - boxHeight / 2]);
    }
    return candidates.map(([left, top], candidate) => ({
      left: clamp(left, 6, viewportWidth - boxWidth - 6),
      top: clamp(top, 6, viewportHeight - boxHeight - 6),
      width: boxWidth, height: boxHeight, candidate,
      displacement: Math.abs(clamp(left, 6, viewportWidth - boxWidth - 6) - left)
        + Math.abs(clamp(top, 6, viewportHeight - boxHeight - 6) - top),
    }));
  };
  const score = box => {
    let overlap = 0;
    if (exact) {
      for (const obstacle of obstacles) overlap += overlapArea(box, obstacle) * 12;
      for (const [key, other] of placements) overlap += overlapArea(box, other) * (kinds.get(key) === 'folder' ? 3 : 1);
    } else cells(box, index => { overlap += occupancy[index] * 4; });
    return { overlap, cost: overlap * 4 + box.candidate + box.displacement * .25 };
  };
  const place = record => {
    let best = null, bestScore = Infinity;
    for (const box of candidatesFor(record)) {
      const value = score(box);
      if (value.cost < bestScore) { bestScore = value.cost; best = { ...box, overlapScore: value.overlap }; }
    }
    placements.set(record.key, best);
    cells(best, index => { occupancy[index] += record.kind === 'folder' ? 3 : 1; });
  };
  for (const record of ordered) place(record);
  if (records.length < 1000) for (let pass = 0; pass < 2; pass++) {
    const sequence = pass ? ordered : [...ordered].reverse();
    for (const record of sequence) {
      if (record.kind === 'folder') continue;
      const old = placements.get(record.key);
      placements.delete(record.key);
      cells(old, index => { occupancy[index] -= 1; });
      place(record);
    }
  }
  // Fixed rows can miss a clear nearby gap by only a few pixels. Resolve those
  // small conflicts locally without detaching names from their actual tips.
  // This exact pass has a fixed small-view limit; dense repositories retain the
  // bounded occupancy-grid path above.
  if (exact) for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const record of pass % 2 ? ordered : [...ordered].reverse()) {
      if (record.kind === 'folder') continue;
      const old = placements.get(record.key);
      placements.delete(record.key);
      const oldScore = score(old);
      let best = old, bestCost = oldScore.cost;
      const conflict = obstacles.some(box => intersects(old, box))
        || [...placements.values()].some(box => intersects(old, box));
      if (conflict) {
        const origins = pass < 2 ? [old] : [old, ...candidatesFor(record)];
        for (const origin of origins) for (const dx of [0, -4, 4, -8, 8]) for (const dy of [0, -4, 4, -8, 8]) {
          if (!dx && !dy) continue;
          const left = clamp(origin.left + dx, 6, viewportWidth - old.width - 6);
          const top = clamp(origin.top + dy, 6, viewportHeight - old.height - 6);
          const distanceX = Math.max(left - record.x, record.x - left - old.width, 0);
          const distanceY = Math.max(top - record.y, record.y - top - old.height, 0);
          if (Math.hypot(distanceX, distanceY) > (focusMode ? 52 : 32)) continue;
          const box = { ...origin, left, top };
          const value = score(box);
          const cost = value.cost + (Math.abs(dx) + Math.abs(dy)) * .25;
          if (cost < bestCost) { bestCost = cost; best = { ...box, overlapScore: value.overlap }; }
        }
      }
      placements.set(record.key, best);
      if (best !== old) changed = true;
    }
    if (!changed && pass >= 2) break;
  }
  return placements;
}
