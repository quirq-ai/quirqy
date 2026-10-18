import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityLayout, REPOSITORY_NODE_ID } from './scene-layout.js';

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
