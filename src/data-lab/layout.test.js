import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepositoryLayout } from './layout.js';

const make = count => ({ repository: { name: 'test' }, nodes: Array.from({ length: count }, (_, i) => ({ id: `file:${i}`, path: `src/feature${i % 8}/nested/file${i}.js` })), commits: [] });
test('containment layout is deterministic across input ordering and has genuine depth', () => {
  const model = make(80);
  const a = createRepositoryLayout(model);
  const b = createRepositoryLayout({ ...model, nodes: [...model.nodes].reverse() });
  assert.deepEqual(a, b);
  assert.ok(a.folders.some(folder => folder.path === 'src/feature2'));
  const ys = a.nodes.map(node => node.position[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 15);
  for (const node of a.nodes) {
    assert.ok(node.position.every(Number.isFinite));
    assert.ok(node.path.startsWith(`${node.folder}/`));
    assert.ok(a.folders.some(folder => folder.path === node.folder));
  }
});
test('display cap prioritizes changed identities and bounds complete folder chains', () => {
  const model = make(900);
  model.commits = [{ changes: [{ id: 'file:899' }] }];
  const layout = createRepositoryLayout(model, { maxNodes: 120, maxFolders: 6 });
  assert.equal(layout.nodes.length, 120);
  assert.ok(layout.nodes.some(node => node.id === 'file:899'));
  assert.ok(layout.folders.length <= 7);
  const paths = new Set(layout.folders.map(folder => folder.path));
  for (const folder of layout.folders) assert.ok(folder.parent === null || paths.has(folder.parent));
  for (const node of layout.nodes) for (const path of node.chain) assert.ok(paths.has(path));
});
test('empty and single-file repositories produce finite overview extents', () => {
  for (const model of [make(0), { nodes: [{ id: 'one', path: 'README.md' }], commits: [] }]) {
    const layout = createRepositoryLayout(model);
    assert.ok(Number.isFinite(layout.extent));
    assert.ok(layout.extent >= 16);
  }
});
