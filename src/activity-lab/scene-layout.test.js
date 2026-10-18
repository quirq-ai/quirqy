import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityLayout, activityFrameBounds, activityClusterVisible, activityRadius, REPOSITORY_NODE_ID } from './scene-layout.js';

const items = [
  { id: 'person:a', kind: 'contributor', actor: { login: 'alice' } },
  { id: 'issue:1', kind: 'issue', actor: { login: 'alice' } },
  { id: 'review:2', kind: 'review', actor: { login: 'other' }, parentId: 'pr:2' },
  { id: 'pr:2', kind: 'pull_request', actor: { login: 'alice' } },
  { id: 'comment:3', kind: 'comment', actor: null, parentId: 'missing' },
  { id: 'fork:other/repo', kind: 'fork', actor: { login: 'other' } },
];

for (const view of ['constellation', 'orbits', 'contributors']) test(`${view}: finite deterministic positions represent only actual records`, () => {
  const layout = createActivityLayout(items, view);
  const reverse = createActivityLayout([...items].reverse(), view);
  assert.equal(layout.positions.size, items.length);
  assert.deepEqual([...layout.positions], [...reverse.positions]);
  assert.ok([...layout.positions.values()].every(position => position.length === 3 && position.every(Number.isFinite)));
  assert.equal(new Set([...layout.positions.values()].map(position => position.join(','))).size, items.length);
  assert.ok(Number.isFinite(layout.extent));
});

test('links encode only supplied parents, known contributor identities, or direct repository membership', () => {
  const { links } = createActivityLayout(items);
  assert.ok(links.some(link => link.kind === 'parent' && link.from === 'pr:2' && link.to === 'review:2'));
  assert.ok(links.some(link => link.kind === 'actor' && link.from === 'person:a' && link.to === 'issue:1'));
  assert.ok(!links.some(link => link.from === 'missing' || link.to === 'missing'));
  assert.ok(!links.some(link => link.kind === 'actor' && link.to === 'fork:other/repo'));
  assert.ok(links.some(link => link.kind === 'repository' && link.from === REPOSITORY_NODE_ID && link.to === 'fork:other/repo'));
});

test('empty and sparse repositories retain finite framing without invented entities', () => {
  assert.equal(createActivityLayout([]).items.length, 0);
  assert.equal(createActivityLayout([]).extent, 12);
  const single = createActivityLayout([{ id: 'one', kind: 'contributor', actor: { login: 'a' } }], 'contributors');
  assert.equal(single.items.length, 1);
  assert.equal(single.clusters.length, 1);
  assert.ok(single.positions.has('one'));
});

test('dense orbit groups retain separate radial bands for different kinds', () => {
  const dense = ['pull_request', 'issue', 'comment'].flatMap(kind => Array.from({ length: 80 }, (_, index) => ({ id: `${kind}:${index}`, kind })));
  const layout = createActivityLayout(dense, 'orbits');
  let previousMax = 0;
  for (const kind of ['pull_request', 'issue', 'comment']) {
    const radii = dense.filter(item => item.kind === kind).map(item => Math.hypot(...layout.positions.get(item.id)));
    assert.ok(Math.min(...radii) - previousMax > 10);
    previousMax = Math.max(...radii);
  }
});


test('category volume follows repository total rather than the loaded sample', () => {
  const sample = [{ id: 'pr:1', kind: 'pull_request', state: 'open' }];
  const small = createActivityLayout(sample, 'constellation', { pull_request: { total: 8, open: 1, exact: true } });
  const large = createActivityLayout(sample, 'constellation', { pull_request: { total: 64, open: 1, exact: true } });
  assert.equal(large.clusters[0].radius / small.clusters[0].radius, 2);
  assert.equal(large.clusters[0].loaded, 1);
  assert.equal(large.clusters[0].total, 64);
  assert.equal(large.items.length, 1);
  assert.equal(large.positions.size, 1);
});

for (const view of ['constellation', 'orbits']) test(`${view}: all-closed and unloaded categories retain total capacity`, () => {
  const stats = { pull_request: { total: 46, open: 0, exact: true }, issue: { total: 2, open: 2, exact: true } };
  const sample = [{ id: 'issue:1', kind: 'issue', state: 'open' }];
  const layout = createActivityLayout(sample, view, stats);
  const pr = layout.clusters.find(cluster => cluster.kind === 'pull_request');
  assert.ok(pr);
  assert.equal(pr.ids.length, 0);
  assert.equal(pr.total, 46);
  assert.ok(pr.bounds.radius > 0);
  assert.equal(layout.positions.size, 1);
  assert.equal(activityClusterVisible(pr, ['pull_request']), true);
  assert.equal(activityClusterVisible(pr, ['issue']), false);
  const prBounds = activityFrameBounds(layout, ['pull_request']);
  assert.equal(prBounds.length, 2);
  assert.equal(prBounds[1].radius, pr.bounds.radius + 5);
  assert.deepEqual(prBounds, activityFrameBounds(createActivityLayout([], view, stats), ['pull_request']));
});

for (const view of ['constellation', 'orbits', 'contributors']) test(`${view}: states and visible-history subsets cannot alter layout or framing`, () => {
  const records = Array.from({ length: 20 }, (_, index) => ({ id: `pr:${index}`, kind: 'pull_request', state: index % 2 ? 'closed' : 'open', actor: { login: 'alice' } }));
  const stats = { pull_request: { total: 100, open: 10, exact: true } };
  const layout = createActivityLayout(records, view, stats);
  const stateChanged = createActivityLayout(records.map(item => ({ ...item, state: 'closed' })), view, stats);
  assert.deepEqual([...layout.positions], [...stateChanged.positions]);
  assert.deepEqual(activityFrameBounds(layout), activityFrameBounds(stateChanged));
  const cluster = layout.clusters[0];
  for (const shown of [new Set(), new Set(records.filter(item => item.state === 'open').map(item => item.id)), new Set(records.map(item => item.id))]) {
    const count = cluster.ids.filter(id => shown.has(id)).length;
    assert.ok(count <= cluster.loaded);
    assert.ok(activityClusterVisible(cluster, ['pull_request']));
    assert.equal(activityFrameBounds(layout, ['pull_request'])[1].radius, cluster.bounds.radius + 5);
  }
});

test('loaded bodies stay fully inside their spherical or radial category envelopes', () => {
  const records = ['pull_request', 'issue', 'fork'].flatMap(kind => Array.from({ length: 80 }, (_, index) => ({ id: `${kind}:${index}`, kind, actor: { login: `person${index % 3}` } })));
  for (const view of ['constellation', 'orbits', 'contributors']) {
    const layout = createActivityLayout(records, view, { pull_request: { total: 300, exact: true } });
    for (const cluster of layout.clusters) for (const id of cluster.ids) {
      const item = records.find(record => record.id === id);
      const position = layout.positions.get(id);
      const size = activityRadius(item) * (item.kind === 'fork' ? 1.65 : item.kind === 'pull_request' ? 1.35 : 1.08);
      const distance = Math.hypot(...position.map((value, axis) => value - cluster.bounds.position[axis]));
      assert.ok(distance + size <= cluster.bounds.radius + 1e-8, `${view}: ${id} escapes capacity`);
      if (view === 'orbits') assert.ok(distance - size >= cluster.innerRadius - 1e-8);
    }
  }
});

test('contributors use loaded participation rather than unavailable per-person repository totals', () => {
  const a = createActivityLayout(items, 'contributors');
  const b = createActivityLayout(items, 'contributors', { pull_request: { total: 10000, exact: true }, contributor: { total: 5000, exact: true } });
  assert.deepEqual([...a.positions], [...b.positions]);
  assert.deepEqual(a.clusters, b.clusters);
  for (const cluster of a.clusters) assert.equal(cluster.total, cluster.ids.length);
});

test('missing or inconsistent totals fall back to real loaded counts', () => {
  const layout = createActivityLayout(items, 'constellation', { pull_request: { total: NaN, exact: true }, issue: { total: 0, exact: true } });
  assert.equal(layout.kindStats.pull_request.total, 1);
  assert.equal(layout.kindStats.pull_request.exact, false);
  assert.equal(layout.kindStats.issue.total, 1);
  assert.equal(layout.kindStats.issue.exact, false);
  assert.equal(layout.positions.size, items.length);
});
