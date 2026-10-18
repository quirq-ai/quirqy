export const ACTIVITY_KIND_COLORS = Object.freeze({
  pull_request: '#a6baf0', issue: '#86d7ad', review: '#e5ba78',
  comment: '#87c8d0', fork: '#c6a5dd', contributor: '#d9dfe9',
});
export const ACTIVITY_KIND_LABELS = Object.freeze({
  pull_request: 'Pull requests', issue: 'Issues', review: 'Reviews',
  comment: 'Comments', fork: 'Forks', contributor: 'Contributors',
});
export const REPOSITORY_NODE_ID = '@repository';
const KINDS = Object.keys(ACTIVITY_KIND_COLORS);
const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function activityHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return hash >>> 0;
}
export function activityRadius(item) {
  return { pull_request: 2.55, issue: 2.35, review: 1.65, comment: 1.35, fork: 2.7, contributor: 2.8 }[item.kind] || 1.7;
}
const add = (a, b) => a.map((value, axis) => value + b[axis]);
const actorKey = item => typeof item.actor?.login === 'string' && item.actor.login.trim() ? item.actor.login.trim().toLowerCase() : '';
const integer = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
// Radius follows the cube root of total: spherical capacity is proportional to
// repository count, apart from the minimum needed to keep sparse groups legible.
const radiusFor = count => Math.max(10, Math.cbrt(Math.max(1, count)) * 8.5);
const bodyExtent = item => activityRadius(item) * (item.kind === 'fork' ? 1.65 : item.kind === 'pull_request' ? 1.35 : 1.08);
const rotateOrbit = (point, tilt, rotation) => {
  const [x, y, z] = point;
  const tiltedY = y * Math.cos(tilt) + z * Math.sin(tilt);
  const tiltedZ = z * Math.cos(tilt) - y * Math.sin(tilt);
  return [x * Math.cos(rotation) - tiltedZ * Math.sin(rotation), tiltedY, x * Math.sin(rotation) + tiltedZ * Math.cos(rotation)];
};
const volumePoint = (index, count, radius, phase = 0) => {
  if (count === 1) return [0, 0, 0];
  const y = 1 - 2 * ((index + .5) / count);
  const circle = Math.sqrt(1 - y * y);
  const angle = index * GOLDEN_ANGLE + phase;
  const distance = radius * Math.cbrt(.24 + .76 * (((index + .5) * .61803398875) % 1));
  return [Math.cos(angle) * circle * distance, y * distance, Math.sin(angle) * circle * distance];
};

/** Category filters affect envelopes; record/state/history filters never do. */
export function activityClusterVisible(cluster, kinds = []) {
  const selected = kinds instanceof Set ? kinds : new Set(kinds || []);
  return cluster.total > 0 && (!selected.size || cluster.kinds.some(kind => selected.has(kind)));
}

/** Stable framing of total capacity, including categories with no shown bodies. */
export function activityFrameBounds(layout, kinds = []) {
  return [{ position: [0, 0, 0], radius: 9 }, ...(layout?.clusters || [])
    .filter(cluster => activityClusterVisible(cluster, kinds))
    .map(cluster => ({ position: [...cluster.bounds.position], radius: cluster.bounds.radius + 5 }))];
}

/** Layout uses all loaded records and repository totals, never a visible filter. */
export function createActivityLayout(input, view = 'constellation', kindStats = {}) {
  const byId = new Map();
  for (const item of input || []) if (item && typeof item.id === 'string' && KINDS.includes(item.kind) && !byId.has(item.id)) byId.set(item.id, item);
  const items = [...byId.values()].sort((a, b) => compare(a.id, b.id));
  const positions = new Map();
  const clusters = [], rings = [];
  const byKind = new Map(KINDS.map(kind => [kind, items.filter(item => item.kind === kind)]));
  const stats = Object.fromEntries(KINDS.map(kind => {
    const loaded = byKind.get(kind).length, supplied = kindStats?.[kind];
    const total = Math.max(loaded, integer(supplied?.total) ?? loaded);
    return [kind, { total, loaded, open: integer(supplied?.open), loadedOpen: integer(supplied?.loadedOpen),
      exact: Boolean(supplied?.exact && integer(supplied?.total) !== null && supplied.total >= loaded) }];
  }));
  const activeKinds = KINDS.filter(kind => stats[kind].total > 0);
  const category = (kind, records) => ({ id: kind, kind, kinds: [kind], label: ACTIVITY_KIND_LABELS[kind], color: ACTIVITY_KIND_COLORS[kind],
    ids: records.map(item => item.id), ...stats[kind] });

  if (view === 'orbits') {
    let nextInnerRadius = 18;
    for (const [kindIndex, kind] of activeKinds.entries()) {
      const records = byKind.get(kind);
      // A category's radial band grows with the cube root of its full total.
      // Only supplied records occupy it; the empty capacity is never fake data.
      const tubeRadius = Math.max(5.5, radiusFor(stats[kind].total) * .38);
      const innerRadius = nextInnerRadius, orbitRadius = innerRadius + tubeRadius;
      const outerRadius = orbitRadius + tubeRadius;
      nextInnerRadius = outerRadius + 12;
      const tilt = (kindIndex % 2 ? 1 : -1) * (.12 + kindIndex * .055), rotation = kindIndex * .22;
      const ringPoint = (radius, angle) => rotateOrbit([Math.cos(angle) * radius, 0, Math.sin(angle) * radius], tilt, rotation);
      rings.push(...[innerRadius, orbitRadius, outerRadius].map(radius => ({ kind, center: [0, 0, 0], radius, tilt, rotation, style: 'orbit' })));
      records.forEach((item, index) => {
        const angle = index * GOLDEN_ANGLE + .37 + kindIndex * .61;
        const phase = index * 1.731 + .4;
        const distance = Math.max(0, tubeRadius - bodyExtent(item) - .6) * .8;
        const radial = orbitRadius + Math.cos(phase) * distance;
        positions.set(item.id, rotateOrbit([Math.cos(angle) * radial, Math.sin(phase) * distance, Math.sin(angle) * radial], tilt, rotation));
      });
      clusters.push({ ...category(kind, records), position: ringPoint(outerRadius, -.28 - kindIndex * .13), radius: 0, labelOnly: true,
        envelope: 'band', innerRadius, outerRadius, orbitRadius, tubeRadius, tilt, rotation, bounds: { position: [0, 0, 0], radius: outerRadius } });
    }
  } else if (view === 'contributors') {
    const groups = new Map();
    for (const item of items) {
      const key = actorKey(item) || '@unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const groupsSorted = [...groups].sort(([a], [b]) => compare(a, b));
    const maximum = Math.max(10, ...groupsSorted.map(([, records]) => radiusFor(records.length)));
    const orbit = Math.max(32, maximum * 2.1, Math.sqrt(groupsSorted.length) * 18);
    groupsSorted.forEach(([key, records], groupIndex) => {
      const angle = groupIndex * GOLDEN_ANGLE + .4;
      const ring = Math.floor(groupIndex / 9);
      const distance = orbit + ring * maximum * 1.5;
      const center = [Math.cos(angle) * distance, Math.sin(angle) * distance * .59, Math.sin(angle * 1.7) * distance * .38];
      const radius = radiusFor(records.length);
      const contributor = records.find(item => item.kind === 'contributor');
      const satellites = records.filter(item => item !== contributor);
      if (contributor) positions.set(contributor.id, center);
      satellites.forEach((item, index) => {
        const usable = Math.max(0, radius - bodyExtent(item) - .75);
        // A single satellite needs a separate position from its real contributor.
        const point = satellites.length === 1 && contributor ? [usable * .86, 0, 0]
          : volumePoint(index, satellites.length, usable, (activityHash(key) % 100) / 100);
        positions.set(item.id, add(center, point));
      });
      clusters.push({ id: key, kinds: [...new Set(records.map(item => item.kind))], label: key === '@unknown' ? 'Unattributed' : records[0].actor.login,
        color: '#d9dfe9', ids: records.map(item => item.id), position: center, radius, actor: true, envelope: 'sphere',
        total: records.length, loaded: records.length, exact: false, bounds: { position: center, radius } });
    });
  } else {
    const angles = { pull_request: 2.6, issue: .53, review: 3.75, comment: 5.4, fork: 4.63, contributor: 1.57 };
    const directions = Object.fromEntries(activeKinds.map(kind => {
      const angle = angles[kind];
      return [kind, [Math.cos(angle), Math.sin(angle) * .67, Math.sin(angle * 2 + .6) * .28]];
    }));
    let orbit = 28;
    for (const kind of activeKinds) {
      orbit = Math.max(orbit, (radiusFor(stats[kind].total) + 14) / Math.hypot(...directions[kind]));
      for (const other of activeKinds) if (kind !== other) {
        const separation = Math.hypot(...directions[kind].map((value, axis) => value - directions[other][axis]));
        orbit = Math.max(orbit, (radiusFor(stats[kind].total) + radiusFor(stats[other].total) + 8) / separation);
      }
    }
    for (const kind of activeKinds) {
      const records = byKind.get(kind), radius = radiusFor(stats[kind].total);
      const center = directions[kind].map(value => value * orbit);
      records.forEach((item, index) => {
        const usable = Math.max(0, radius - bodyExtent(item) - .75);
        positions.set(item.id, add(center, volumePoint(index, records.length, usable, (activityHash(kind) % 100) / 100)));
      });
      clusters.push({ ...category(kind, records), position: center, radius, envelope: 'sphere', bounds: { position: center, radius } });
    }
  }

  const contributors = new Map();
  for (const item of items) if (item.kind === 'contributor' && actorKey(item) && !contributors.has(actorKey(item))) contributors.set(actorKey(item), item.id);
  const links = [];
  for (const item of items) {
    if (item.parentId && item.parentId !== item.id && byId.has(item.parentId)) links.push({ from: item.parentId, to: item.id, kind: 'parent' });
    else if (['pull_request', 'issue', 'fork', 'contributor'].includes(item.kind)) links.push({ from: REPOSITORY_NODE_ID, to: item.id, kind: 'repository' });
    const actor = contributors.get(actorKey(item));
    if (actor && actor !== item.id) links.push({ from: actor, to: item.id, kind: 'actor' });
  }
  let extent = 12;
  for (const cluster of clusters) extent = Math.max(extent, Math.hypot(...cluster.bounds.position) + cluster.bounds.radius + 5);
  return { view, items, positions, clusters, rings, links, extent, kindStats: stats, center: [0, 0, 0] };
}
