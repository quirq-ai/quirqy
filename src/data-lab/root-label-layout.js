const compare = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
// Half a CSS pixel of clearance avoids touching glyph rows and browser rounding
// turning an exact shared edge into a visible overlap.
const intersects = (a, b) => a.left < b.left + b.width + .5 && a.left + a.width + .5 > b.left
  && a.top < b.top + b.height + .5 && a.top + a.height + .5 > b.top;
const overlapArea = (a, b) => {
  const height = Math.min(a.top + a.height + 2, b.top + b.height + 2) - Math.max(a.top - 2, b.top - 2);
  if (height <= 0) return 0;
  return Math.max(0, Math.min(a.left + a.width + 2, b.left + b.width + 2) - Math.max(a.left - 2, b.left - 2)) * height;
};

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
  // Real sibling groups share a screen-space row rhythm. The median follows
  // the projected branch continuously as it rotates, without creating columns
  // detached from the file ends or depending on the input iteration order.
  const siblings = new Map(), rowInfo = new Map();
  for (const record of records) if (record.kind === 'file' && record.parentPath != null) {
    const group = siblings.get(record.parentPath) || [];
    group.push(record); siblings.set(record.parentPath, group);
  }
  for (const group of siblings.values()) {
    if (group.length < 2) continue;
    const ys = group.map(record => record.y).sort((a, b) => a - b);
    const middle = Math.floor(ys.length / 2);
    const median = ys.length % 2 ? ys[middle] : (ys[middle - 1] + ys[middle]) / 2;
    const stride = Math.max(...group.map(record => record.height)) + 4;
    for (const record of group) rowInfo.set(record.key, { baseline: median + 8, stride });
  }
  const projectedRow = record => {
    const row = rowInfo.get(record.key);
    return row ? row.baseline + Math.round((record.y + 8 - row.baseline) / row.stride) * row.stride : record.y;
  };
  const ordered = [...records].sort((a, b) => Number(a.kind !== 'folder') - Number(b.kind !== 'folder')
    || projectedRow(a) - projectedRow(b) || a.x - b.x || compare(a.key, b.key));
  const candidateCache = new Map();
  const candidatesFor = record => {
    if (candidateCache.has(record)) return candidateCache.get(record);
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
    const row = rowInfo.get(record.key);
    const result = candidates.map(([left, targetTop], candidate) => {
      let top = row ? row.baseline + Math.round((targetTop - row.baseline) / row.stride) * row.stride : targetTop;
      if (row && targetTop >= record.y && top < record.y + 4) top += row.stride;
      if (row && targetTop + boxHeight <= record.y && top + boxHeight > record.y - 4) top -= row.stride;
      return {
        left: clamp(left, 6, viewportWidth - boxWidth - 6),
        top: clamp(top, 6, viewportHeight - boxHeight - 6),
        width: boxWidth, height: boxHeight, candidate, ...row,
        displacement: Math.abs(clamp(left, 6, viewportWidth - boxWidth - 6) - left)
          + Math.abs(clamp(top, 6, viewportHeight - boxHeight - 6) - top),
      };
    }).filter(box => !row || Math.hypot(Math.max(box.left - record.x, record.x - box.left - box.width, 0),
      Math.max(box.top - record.y, record.y - box.top - box.height, 0)) <= (focusMode ? 52 : 32));
    candidateCache.set(record, result);
    return result;
  };
  const score = (box, ceiling = Infinity) => {
    let overlap = 0;
    const rowError = box.stride ? Math.abs(box.top - box.baseline - Math.round((box.top - box.baseline) / box.stride) * box.stride) : 0;
    const cost = () => overlap * 4 + box.candidate + box.displacement * .25 + rowError * 1.5;
    if (cost() >= ceiling) return { overlap, cost: cost() };
    if (exact) {
      for (const obstacle of obstacles) {
        overlap += overlapArea(box, obstacle) * 12;
        if (cost() >= ceiling) return { overlap, cost: cost() };
      }
      for (const [key, other] of placements) {
        overlap += overlapArea(box, other) * (kinds.get(key) === 'folder' ? 3 : 1);
        if (cost() >= ceiling) return { overlap, cost: cost() };
      }
    } else cells(box, index => { overlap += occupancy[index] * 4; });
    return { overlap, cost: cost() };
  };
  const place = record => {
    let best = null, bestScore = Infinity;
    for (const box of candidatesFor(record)) {
      const value = score(box, bestScore);
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
          const value = score(box, bestCost);
          const cost = value.cost + (Math.abs(dx) + Math.abs(dy)) * .25;
          if (cost < bestCost) { bestCost = cost; best = { ...box, overlapScore: value.overlap }; }
        }
      }
      placements.set(record.key, best);
      if (best !== old) changed = true;
    }
    if (!changed && pass >= 2) break;
  }
  // A rotated, compact branch can leave a valid gap between the fixed nudge
  // steps. Consider the exact nearby box edges for the few remaining conflicts.
  // This still uses the same local attachment radius and never moves a name to
  // an external column or introduces a leader line.
  if (exact) for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const record of pass % 2 ? ordered : [...ordered].reverse()) {
      if (record.kind === 'folder') continue;
      const old = placements.get(record.key);
      placements.delete(record.key);
      const boxes = [...placements.values()];
      const conflictCount = (box, limit = Infinity) => {
        let count = 0;
        for (const obstacle of obstacles) {
          if (intersects(box, obstacle)) count += 12;
          if (count > limit) return count;
        }
        for (const other of boxes) {
          if (intersects(box, other)) count++;
          if (count > limit) return count;
        }
        return count;
      };
      let best = old, bestConflicts = conflictCount(old), bestCost = score(old).cost;
      if (bestConflicts) {
        const reach = focusMode ? 52 : 32;
        const xs = new Set([old.left]), ys = new Set([old.top]);
        for (const box of candidatesFor(record)) { xs.add(box.left); ys.add(box.top); }
        for (const box of [...boxes, ...obstacles]) {
          for (const left of [box.left - old.width - 2, box.left + box.width + 2]) {
            if (left >= 6 && left + old.width <= viewportWidth - 6
              && left <= record.x + reach && left + old.width >= record.x - reach) xs.add(left);
          }
          for (const top of [box.top - old.height - 2, box.top + box.height + 2]) {
            if (top >= 6 && top + old.height <= viewportHeight - 6
              && top <= record.y + reach && top + old.height >= record.y - reach) ys.add(top);
          }
        }
        const nearest = (values, origin) => [...values].sort((a, b) => Math.abs(a - origin) - Math.abs(b - origin) || a - b).slice(0, 24);
        for (const left of nearest(xs, old.left)) for (const top of nearest(ys, old.top)) {
          const dx = Math.max(left - record.x, record.x - left - old.width, 0);
          const dy = Math.max(top - record.y, record.y - top - old.height, 0);
          if (Math.hypot(dx, dy) > reach) continue;
          const box = { ...old, left, top };
          const conflicts = conflictCount(box, bestConflicts);
          if (conflicts > bestConflicts) continue;
          const value = score(box, conflicts === bestConflicts ? bestCost : Infinity);
          const cost = value.cost + (Math.abs(left - old.left) + Math.abs(top - old.top)) * .5;
          if (conflicts < bestConflicts || cost < bestCost) {
            best = { ...box, overlapScore: value.overlap }; bestConflicts = conflicts; bestCost = cost;
          }
        }
      }
      placements.set(record.key, best);
      if (best !== old) changed = true;
    }
    if (!changed) break;
  }
  return placements;
}


/**
 * Dense repositories keep every root, but reveal a name only when its complete
 * box fits near the tip. Zooming or focusing a folder creates room for more
 * names. A spatial index makes this bounded even for thousands of files.
 */
export function placeReadableRootLabels(records, { width, height, obstacles = [] } = {}) {
  const placements = new Map(), cells = new Map(), cellSize = 64;
  const visit = (box, callback) => {
    for (let y = Math.floor((box.top - 2) / cellSize); y <= Math.floor((box.top + box.height + 2) / cellSize); y++) {
      for (let x = Math.floor((box.left - 2) / cellSize); x <= Math.floor((box.left + box.width + 2) / cellSize); x++) callback(`${x}:${y}`);
    }
  };
  const reserve = box => visit(box, key => {
    const bucket = cells.get(key) || [];
    bucket.push(box); cells.set(key, bucket);
  });
  const fits = box => {
    if (box.left < 6 || box.top < 6 || box.left + box.width > width - 6 || box.top + box.height > height - 6) return false;
    let clear = true;
    visit(box, key => {
      if (clear && cells.get(key)?.some(other => intersects(box, other))) clear = false;
    });
    return clear;
  };
  for (const box of obstacles) reserve(box);
  const ordered = [...records].sort((a, b) => (b.priority || 0) - (a.priority || 0)
    || Number(a.kind !== 'folder') - Number(b.kind !== 'folder')
    || (a.depth || 0) - (b.depth || 0) || compare(a.key, b.key));
  for (const record of ordered) {
    const { x, y, width: w, height: h } = record;
    // All candidates stay attached to the actual endpoint. No leader lines or
    // remote text columns, and no truncating names just to fit the overview.
    const candidates = record.kind === 'folder'
      ? [[x + 8, y - h / 2], [x - w - 8, y - h / 2], [x - w / 2, y - h - 6], [x - w / 2, y + 6]]
      : [[x - w / 2, y + 6], [x - w / 2, y - h - 6], [x + 6, y + 6], [x - w - 6, y + 6]];
    for (const [left, top] of candidates) {
      const box = { left, top, width: w, height: h };
      if (!fits(box)) continue;
      placements.set(record.key, box); reserve(box); break;
    }
  }
  return placements;
}
