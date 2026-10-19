import test from 'node:test';
import assert from 'node:assert/strict';
import { encloseContributorCards, displaceConstellationClusters } from './constellation-enclosure.js';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const contains = (outer, inner) => distance(outer, inner) + (inner.radius || 0) <= outer.radius + 1e-7;
const separated = (a, b, gap) => distance(a, b) >= a.radius + b.radius + gap - 1e-7;
const corners = (card, padding = 0) => [-1, 1].flatMap(x => [-1, 1].map(y => ({
  x: card.x + x * (card.width / 2 + padding), y: card.y + y * (card.height / 2 + padding),
})));

const base = { x: 220, y: 250, radius: 60 };
const cards = [
  { id: 'alice', x: 170, y: 180, width: 95, height: 80 },
  { id: 'long-github-handle', x: 325, y: 280, width: 180, height: 100 },
  { id: 'carol', x: 210, y: 380, width: 95, height: 85 },
];

test('enclosure contains every full portrait/name corner, with padding, and original capacity', () => {
  const enclosing = encloseContributorCards(cards, { minimumCircle: base, padding: 16 });
  assert.ok(contains(enclosing, base));
  assert.ok(cards.flatMap(card => corners(card, 16)).every(point => contains(enclosing, point)));
  assert.ok(enclosing.radius > base.radius);
});

test('empty or compact contributor collections never shrink original capacity', () => {
  assert.deepEqual(encloseContributorCards([], { minimumCircle: base }), base);
  const compact = encloseContributorCards([{ x: 220, y: 250, width: 15, height: 15 }], { minimumCircle: base });
  assert.deepEqual(compact, base);
});

test('additional spread and longer full handles expand the enclosing circle', () => {
  const start = encloseContributorCards(cards.slice(0, 1), { minimumCircle: base });
  const spread = encloseContributorCards(cards, { minimumCircle: base });
  const longer = encloseContributorCards(cards.map(card => ({ ...card, width: card.width + 200 })), { minimumCircle: base });
  assert.ok(spread.radius > start.radius);
  assert.ok(longer.radius > spread.radius);
});

test('irregular portrait rows get a tighter circle without losing full cards or original capacity', () => {
  const irregular = [
    { id: 'left', x: 50, y: 100, width: 80, height: 70 },
    { id: 'right', x: 300, y: 100, width: 80, height: 70 },
    { id: 'lower', x: 90, y: 250, width: 80, height: 70 },
  ];
  const minimum = { x: 175, y: 150, radius: 45 };
  const original = structuredClone(irregular);
  const points = irregular.flatMap(card => corners(card));
  const boxCenter = { x: 175, y: 175 };
  const boxRadius = Math.max(distance(boxCenter, minimum) + minimum.radius,
    ...points.map(point => distance(boxCenter, point)));
  const result = encloseContributorCards(irregular, { minimumCircle: minimum, padding: 0 });
  assert.ok(result.radius < boxRadius - 10, 'unused bounding-box corners no longer inflate the enclosure');
  assert.ok(contains(result, minimum));
  assert.ok(points.every(point => contains(result, point)));
  assert.deepEqual(result, encloseContributorCards([...irregular].reverse(), { minimumCircle: minimum, padding: 0 }));
  assert.deepEqual(irregular, original);
});

test('enclosure is deterministic under reordering, does not mutate, and handles nonfinite missing data', () => {
  const original = structuredClone(cards);
  assert.deepEqual(encloseContributorCards(cards, { minimumCircle: base }), encloseContributorCards([...cards].reverse(), { minimumCircle: base }));
  assert.deepEqual(cards, original);
  for (const circle of [encloseContributorCards(), encloseContributorCards([null, { x: NaN, y: Infinity, width: -2 }], { minimumCircle: { radius: Infinity }, padding: NaN })]) {
    assert.ok(Object.values(circle).every(Number.isFinite));
    assert.ok(circle.radius >= 0);
  }
});

const clusterAnchors = [
  { id: 'issues', x: 125, y: 200, radius: 45 },
  { id: 'pull_requests', x: 400, y: 250, radius: 68 },
  { id: 'forks', x: 235, y: 375, radius: 22 },
  { id: 'comments', x: 270, y: 175, radius: 31 },
  { id: 'reviews', x: 300, y: 300, radius: 26 },
];
const sun = { x: 40, y: 250, radius: 30 };

function assertClear(positions, enclosure, obstacles, gap) {
  const circles = [...positions.values()];
  for (let index = 0; index < circles.length; index++) {
    const value = circles[index];
    assert.ok(Object.values(value).every(Number.isFinite));
    assert.ok(separated(value, enclosure, gap), 'category clears contributor enclosure');
    for (const obstacle of obstacles) assert.ok(separated(value, obstacle, gap), 'category clears fixed obstacles');
    for (let previous = 0; previous < index; previous++) assert.ok(separated(value, circles[previous], gap), 'categories clear one another');
  }
}

test('expanded enclosure pushes whole neighboring categories without changing their size', () => {
  const enclosure = encloseContributorCards(cards, { minimumCircle: base });
  const placed = displaceConstellationClusters(clusterAnchors, { enclosure, obstacles: [sun], gap: 20 });
  assert.equal(placed.size, clusterAnchors.length);
  for (const cluster of clusterAnchors) {
    assert.equal(placed.get(cluster.id).radius, cluster.radius);
    assert.ok(distance(placed.get(cluster.id), cluster) > 0);
  }
  assertClear(placed, enclosure, [sun], 20);
});

test('clear original anchors remain unchanged and reapplying original inputs cannot drift', () => {
  const clusters = [{ id: 'remote', x: 900, y: 800, radius: 22 }, ...clusterAnchors];
  const original = structuredClone(clusters), fixed = structuredClone([sun]);
  const options = { enclosure: base, obstacles: fixed };
  const once = displaceConstellationClusters(clusters, options);
  assert.deepEqual(once.get('remote'), { x: 900, y: 800, radius: 22 });
  for (let frame = 0; frame < 20; frame++) assert.deepEqual(displaceConstellationClusters([...clusters].reverse(), options), once);
  assert.deepEqual(clusters, original);
  assert.deepEqual(fixed, [sun]);
});

test('more contributor spread forces occupied neighbors outward, without resizing category capacity', () => {
  const anchors = [{ id: 'issues', x: 350, y: 250, radius: 35 }];
  const before = displaceConstellationClusters(anchors, { enclosure: base }).get('issues');
  const after = displaceConstellationClusters(anchors, { enclosure: { ...base, radius: 180 } }).get('issues');
  assert.ok(distance(after, base) > distance(before, base));
  assert.equal(after.radius, before.radius);
});

test('coincident anchors and overlapping obstacles still resolve every category in bounded work', () => {
  const clusters = Array.from({ length: 15 }, (_, i) => ({ id: `cluster-${i}`, x: 0, y: 0, radius: 10 + i }));
  const enclosure = { x: 0, y: 0, radius: 140 };
  const obstacles = [{ x: 50, y: 0, radius: 100 }, { x: 0, y: 50, radius: 100 }, enclosure];
  const placed = displaceConstellationClusters(clusters, { enclosure, obstacles, gap: 18 });
  assertClear(placed, enclosure, obstacles, 18);
  assert.deepEqual(placed, displaceConstellationClusters([...clusters].reverse(), { enclosure, obstacles: [...obstacles].reverse(), gap: 18 }));
});

test('packing remains clear across a deterministic set of camera-like projected layouts', () => {
  for (let frame = 0; frame < 40; frame++) {
    const enclosure = { x: 200 + 20 * Math.sin(frame), y: 260, radius: 50 + frame * 3 };
    const projected = clusterAnchors.map((cluster, index) => ({ ...cluster, x: 220 + 130 * Math.cos(frame / 6 + index), y: 260 + 75 * Math.sin(frame / 5 + index) }));
    assertClear(displaceConstellationClusters(projected, { enclosure, obstacles: [sun], gap: 18 }), enclosure, [sun], 18);
  }
});

test('empty and incomplete cluster collections yield finite results', () => {
  assert.equal(displaceConstellationClusters().size, 0);
  const positions = displaceConstellationClusters([{ id: 'missing', x: Infinity, radius: NaN }, null], { gap: NaN });
  assert.equal(positions.size, 1);
  assert.ok(Object.values(positions.get('missing')).every(Number.isFinite));
});
