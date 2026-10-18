import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeLayout, createTreePose, treeLengthScale, treePoint, leafSizing, leafScale, trunkRadius } from './tree-layout.js';
import { createDemoDataset } from './demo.js';
import { createLeafGeometry } from './tree-scene.js';
import { buildModel, stateAt } from './model.js';

test('growth tree uses exactly the mapped file identities and connected directory hierarchy', () => {
  const model = buildModel(createDemoDataset());
  const layout = createTreeLayout(model);
  assert.equal(layout.nodes.length, model.nodes.length);
  assert.equal(new Set(layout.nodes.map(node => node.id)).size, model.nodes.length);
  const folders = new Map(layout.folders.map(folder => [folder.path, folder]));
  for (const node of layout.nodes) {
    assert.ok(folders.has(node.folder));
    assert.equal(node.position.length, 3);
    assert.ok(node.position.every(Number.isFinite));
    assert.ok(node.stemStart.every(Number.isFinite));
  }
  for (const folder of layout.folders) {
    if (folder.path) assert.ok(folders.has(folder.parent));
    assert.equal(folder.curve.length, 4);
    assert.ok(folder.curve.flat().every(Number.isFinite));
  }
  assert.ok(layout.bounds.max[1] - layout.bounds.min[1] > 65);
});

test('base attachment layout and byte normalization are independent of the history cursor', () => {
  const model = buildModel(createDemoDataset());
  const initial = createTreeLayout(model);
  const anchors = Object.fromEntries(initial.nodes.map(node => [node.id, node.position]));
  for (const index of [-1, 7, 12, 0, model.commits.length - 1]) {
    stateAt(model, index);
    const layout = createTreeLayout(model);
    assert.deepEqual(Object.fromEntries(layout.nodes.map(node => [node.id, node.position])), anchors);
    assert.deepEqual(layout.sizing, initial.sizing);
  }
});

test('leaf surface area follows byte ratios with explicit clamps and unknown fallback', () => {
  const nodes = [{ size: 100 }, { size: 200 }, { size: 400 }, { size: null }, { size: 0 }, { size: 1e9 }];
  const sizing = leafSizing(nodes);
  const a = leafScale(nodes[0], sizing), b = leafScale(nodes[1], sizing);
  assert.equal(b.areaRatio / a.areaRatio, 2);
  assert.ok(Math.abs((b.scale / a.scale) ** 2 - 2) < 1e-10);
  assert.equal(leafScale(nodes[3], sizing).sizeKnown, false);
  assert.equal(leafScale(nodes[3], sizing).areaRatio, 0.65);
  assert.equal(leafScale(nodes[4], sizing).sizeKnown, true);
  assert.equal(leafScale(nodes[4], sizing).areaRatio, sizing.minAreaRatio);
  assert.equal(leafScale(nodes[5], sizing).areaRatio, sizing.maxAreaRatio);
  assert.equal(sizing.unknownCount, 1);
});

test('each forward commit thickens trunk and cursor rewinds reproduce the exact radius', () => {
  const sequence = Array.from({ length: 24 }, (_, index) => trunkRadius(index - 1));
  for (let index = 1; index < sequence.length; index++) assert.ok(sequence[index] > sequence[index - 1]);
  for (const cursor of [14, -1, 4, 20, 4]) assert.equal(trunkRadius(cursor), sequence[cursor + 1]);
  assert.ok(trunkRadius(-1) > 0);
});

test('the tree cap preserves changed identities and never invents leaves', () => {
  const model = buildModel(createDemoDataset());
  const layout = createTreeLayout(model, { maxNodes: 20, maxFolders: 3 });
  const ids = new Set(model.nodes.map(node => node.id));
  assert.equal(layout.nodes.length, 20);
  assert.ok(layout.nodes.every(node => ids.has(node.id)));
  assert.ok(layout.folders.length <= 4);
  const sizing = leafSizing(model.nodes);
  assert.deepEqual(layout.sizing, sizing);
});

// Zero normals at a collapsed leaf tip poisoned PBR pixels and then the shared
// bloom image. This checks geometry rather than accepting invisible pick targets.
test('folded leaves have finite unit normals and no collapsed triangles for bloom', () => {
  const geometry = createLeafGeometry();
  const normals = geometry.attributes.normal.array;
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]);
    assert.ok(Number.isFinite(length) && length > 0.99 && length < 1.01);
  }
  const positions = geometry.attributes.position.array, indices = geometry.index.array;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index] * 3, b = indices[index + 1] * 3, c = indices[index + 2] * 3;
    const ab = [0, 1, 2].map(axis => positions[b + axis] - positions[a + axis]);
    const ac = [0, 1, 2].map(axis => positions[c + axis] - positions[a + axis]);
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    assert.ok(Math.hypot(...cross) > 1e-7);
  }
  geometry.dispose();
});


const branchLength = folder => {
  let length = 0, previous = folder.curve[0];
  for (let step = 1; step <= 100; step++) {
    const point = treePoint(folder.curve, step / 100);
    length += Math.hypot(...point.map((value, axis) => value - previous[axis]));
    previous = point;
  }
  return length;
};

function weightedFixture(count = 72) {
  return {
    repository: { name: 'Weighted tree' }, commits: [],
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `file-${String(index).padStart(3, '0')}`, path: `src/ui/components/file-${index}.js`, size: index % 3 ? 100 + index : null,
    })),
  };
}

test('every commit visibly elongates the tree from the same grounded trunk base', () => {
  const layout = createTreeLayout(weightedFixture());
  const sequence = Array.from({ length: 23 }, (_, step) => createTreePose(layout, { index: step - 1, commitCount: 22 }));
  for (const pose of sequence) assert.deepEqual(pose.trunk[0], [0, -40, 0]);
  for (let step = 1; step < sequence.length; step++) {
    assert.ok(sequence[step].trunk[3][1] > sequence[step - 1].trunk[3][1]);
    assert.ok(branchLength(sequence[step].folders[0]) > branchLength(sequence[step - 1].folders[0]));
  }
  assert.ok(branchLength(sequence.at(-1).folders[0]) / branchLength(sequence[0].folders[0]) > 3);
  assert.equal(treeLengthScale(-10, 22), treeLengthScale(-1, 22));
  assert.equal(treeLengthScale(100, 22), treeLengthScale(21, 22));
});

test('many present leaves extend a branch sideways and lower its tip; removal unloads it', () => {
  const model = weightedFixture();
  const layout = createTreeLayout(model);
  const activeIds = model.nodes.slice(0, 2).map(node => node.id);
  const light = createTreePose(layout, { index: 9, commitCount: 10, activeIds });
  const heavy = createTreePose(layout, { index: 9, commitCount: 10 });
  const lightBranch = light.folders.find(folder => folder.path === 'src');
  const heavyBranch = heavy.folders.find(folder => folder.path === 'src');
  assert.equal(heavyBranch.loadCount, 72);
  assert.equal(lightBranch.loadCount, 2);
  assert.ok(heavyBranch.lengthFactor > 1.9);
  assert.ok(branchLength(heavyBranch) > branchLength(lightBranch) * 1.2);
  assert.ok(heavyBranch.position[1] < lightBranch.position[1] - 20);
  const reach = branch => Math.hypot(branch.position[0] - branch.curve[0][0], branch.position[2] - branch.curve[0][2]);
  assert.ok(reach(heavyBranch) > reach(lightBranch) * 1.8);
  assert.deepEqual(createTreePose(layout, { index: 9, commitCount: 10, activeIds }), light);
});

test('bending keeps every child branch and leaf twig attached to the posed parent', () => {
  const model = weightedFixture();
  const layout = createTreeLayout(model);
  for (const index of [-1, 6, 15]) {
    const pose = createTreePose(layout, { index, commitCount: 16, activeIds: model.nodes.slice(0, 49).map(node => node.id) });
    const byPath = new Map(pose.folders.map(folder => [folder.path, folder]));
    for (const folder of pose.folders) {
      if (!folder.path) continue;
      assert.deepEqual(folder.curve[0], treePoint(byPath.get(folder.parent).curve, folder.attachmentT));
      assert.ok(folder.curve.flat().every(Number.isFinite));
    }
    for (const node of pose.nodes) {
      assert.deepEqual(node.stemStart, treePoint(byPath.get(node.folder).curve, node.attachmentT));
      assert.ok(Math.abs(Math.hypot(...node.direction) - 1) < 1e-10);
    }
  }
});

test('cursor seeks preserve byte-based leaf areas and reproduce poses without mutating layout', () => {
  const model = buildModel(createDemoDataset());
  const layout = createTreeLayout(model), before = JSON.stringify(layout);
  const poses = new Map();
  for (const index of [4, 21, -1, 7, 4, -1, 21]) {
    const pose = createTreePose(layout, { index, commitCount: model.commits.length, activeIds: stateAt(model, index).activeIds });
    if (poses.has(index)) assert.deepEqual(pose, poses.get(index));
    else poses.set(index, pose);
    assert.deepEqual(pose.nodes.map(node => [node.id, node.scale, node.areaRatio, node.sizeKnown]), layout.nodes.map(node => [node.id, node.scale, node.areaRatio, node.sizeKnown]));
  }
  assert.equal(JSON.stringify(layout), before);
});

test('load counts use active mapped descendants once, including unknown and zero-size leaves', () => {
  const model = weightedFixture(80);
  model.nodes.push({ id: 'root-file', path: 'README.md', size: 0 });
  const layout = createTreeLayout(model, { maxNodes: 35, maxFolders: 2 });
  const ids = layout.nodes.slice(0, 13).map(node => node.id);
  const pose = createTreePose(layout, { index: 0, commitCount: 1, activeIds: [...ids, ids[0], 'unmapped-id'] });
  const root = pose.folders.find(folder => !folder.path);
  assert.equal(root.loadCount, 13);
  for (const folder of pose.folders.filter(folder => folder.path)) {
    const expected = pose.nodes.filter(node => ids.includes(node.id) && (node.folder === folder.path || node.folder.startsWith(`${folder.path}/`))).length;
    assert.equal(folder.loadCount, expected);
  }
  assert.equal(pose.nodes.length, layout.nodes.length);
});

test('empty, root-only, and single-commit trees produce finite bounded poses', () => {
  for (const nodes of [[], [{ id: 'readme', path: 'README.md', size: null }]]) {
    const layout = createTreeLayout({ nodes, commits: [] });
    for (const commitCount of [0, 1, 20]) {
      const pose = createTreePose(layout, { index: commitCount - 1, commitCount });
      assert.ok(pose.trunk.flat().every(Number.isFinite));
      assert.ok(pose.center.every(Number.isFinite));
      assert.ok(Number.isFinite(pose.extent) && pose.extent > 0);
      for (const node of pose.nodes) for (const axis of [0, 1, 2]) {
        assert.ok(node.position[axis] > pose.bounds.min[axis]);
        assert.ok(node.position[axis] < pose.bounds.max[axis]);
      }
    }
  }
  assert.ok(Number.isFinite(treeLengthScale(Infinity, Infinity)));
});
