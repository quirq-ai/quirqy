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
const radiusFor = count => Math.max(8, Math.sqrt(Math.max(1, count)) * 4.2);

/** Layout coordinates depend only on the actual records, never the visible filter. */
export function createActivityLayout(input, view = 'constellation') {
  const byId = new Map();
  for (const item of input || []) if (item && typeof item.id === 'string' && KINDS.includes(item.kind) && !byId.has(item.id)) byId.set(item.id, item);
  const items = [...byId.values()].sort((a, b) => compare(a.id, b.id));
  const positions = new Map();
  const clusters = [], rings = [];
  const byKind = new Map(KINDS.map(kind => [kind, items.filter(item => item.kind === kind)]));
  const activeKinds = KINDS.filter(kind => byKind.get(kind).length);

  if (view === 'orbits') {
    let nextOrbitRadius = 24;
    for (const [kindIndex, kind] of activeKinds.entries()) {
      const records = byKind.get(kind);
      const base = nextOrbitRadius;
      const capacity = Math.max(9, Math.floor(TAU * base / 8.5));
      const tilt = (kindIndex % 2 ? 1 : -1) * (.12 + kindIndex * .055);
      const rotation = kindIndex * .22;
      const ringPoint = (radius, angle) => {
        const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
        return [x * Math.cos(rotation) - z * Math.cos(tilt) * Math.sin(rotation), z * Math.sin(tilt), x * Math.sin(rotation) + z * Math.cos(tilt) * Math.cos(rotation)];
      };
      const shells = Math.ceil(records.length / capacity);
      nextOrbitRadius = base + (shells - 1) * 8 + 16;
      for (let shell = 0; shell < shells; shell++) rings.push({ kind, center: [0, 0, 0], radius: base + shell * 8, tilt, rotation, style: 'orbit' });
      records.forEach((item, index) => {
        const shell = Math.floor(index / capacity);
        const count = Math.min(capacity, records.length - shell * capacity);
        const angle = (index % capacity) / count * TAU + .37 + kindIndex * .61 + shell * .29;
        positions.set(item.id, ringPoint(base + shell * 8, angle));
      });
      clusters.push({ id: kind, label: ACTIVITY_KIND_LABELS[kind], color: ACTIVITY_KIND_COLORS[kind], ids: records.map(item => item.id), position: ringPoint(base, -.28 - kindIndex * .13), radius: 0, labelOnly: true });
    }
  } else if (view === 'contributors') {
    const groups = new Map();
    for (const item of items) {
      const key = actorKey(item) || '@unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const groupsSorted = [...groups].sort(([a], [b]) => compare(a, b));
    const maximum = Math.max(8, ...groupsSorted.map(([, records]) => radiusFor(records.length)));
    const orbit = Math.max(32, maximum * 1.8, Math.sqrt(groupsSorted.length) * 15);
    groupsSorted.forEach(([key, records], groupIndex) => {
      const angle = groupIndex * GOLDEN_ANGLE + .4;
      const ring = Math.floor(groupIndex / 9);
      const radius = orbit + ring * maximum * 1.25;
      const center = [Math.cos(angle) * radius, Math.sin(angle) * radius * .59, Math.sin(angle * 1.7) * radius * .38];
      const contributor = records.find(item => item.kind === 'contributor');
      const satellites = records.filter(item => item !== contributor);
      if (contributor) positions.set(contributor.id, center);
      satellites.forEach((item, index) => {
        const angle = index * GOLDEN_ANGLE + (activityHash(key) % 100) / 100;
        const r = 8.2 + Math.sqrt(index) * 4;
        positions.set(item.id, add(center, [Math.cos(angle) * r, Math.sin(angle) * r * .72, Math.sin(angle * 1.4) * r * .45]));
      });
      clusters.push({ id: key, label: key === '@unknown' ? 'Unattributed' : records[0].actor.login, color: '#d9dfe9',
        ids: records.map(item => item.id), position: center, radius: radiusFor(records.length), actor: true });
    });
  } else {
    const maxSpread = Math.max(8, ...activeKinds.map(kind => radiusFor(byKind.get(kind).length)));
    const orbit = Math.max(28, maxSpread * 1.85);
    const angles = { pull_request: 2.6, issue: .53, review: 3.75, comment: 5.4, fork: 4.63, contributor: 1.57 };
    for (const kind of activeKinds) {
      const records = byKind.get(kind), angle = angles[kind];
      const center = [Math.cos(angle) * orbit, Math.sin(angle) * orbit * .67, Math.sin(angle * 2 + .6) * orbit * .28];
      records.forEach((item, index) => {
        const phase = index * GOLDEN_ANGLE + (activityHash(kind) % 100) / 100;
        const r = records.length === 1 ? 0 : 4.5 + Math.sqrt(index) * 4;
        positions.set(item.id, add(center, [Math.cos(phase) * r, Math.sin(phase) * r * .82, Math.sin(phase * 1.43) * r * .5]));
      });
      clusters.push({ id: kind, label: ACTIVITY_KIND_LABELS[kind], color: ACTIVITY_KIND_COLORS[kind], ids: records.map(item => item.id), position: center, radius: radiusFor(records.length) });
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
  for (const item of items) extent = Math.max(extent, Math.hypot(...positions.get(item.id)) + activityRadius(item) * 2);
  return { view, items, positions, clusters, rings, links, extent, center: [0, 0, 0] };
}
