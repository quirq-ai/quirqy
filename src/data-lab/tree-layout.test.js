import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeLayout, createTreePose, treeByteScale, treePoint, leafSizing, leafScale, trunkRadius, TREE_REFERENCE_BYTES, LEAF_REFERENCE_BYTES } from './tree-layout.js';
import { createRepositoryFixture } from './test-fixtures/repository.js';
import * as THREE from 'three';
import { createLeafGeometry, TreeScene } from './tree-scene.js';
import { buildModel, stateAt } from './model.js';

test('growth tree uses exactly the mapped file identities and connected directory hierarchy', () => {
  const model = buildModel(createRepositoryFixture());
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
  const model = buildModel(createRepositoryFixture());
  const initial = createTreeLayout(model);
  const anchors = Object.fromEntries(initial.nodes.map(node => [node.id, node.position]));
  for (const index of [-1, 7, 12, 0, model.commits.length - 1]) {
    stateAt(model, index);
    const layout = createTreeLayout(model);
    assert.deepEqual(Object.fromEntries(layout.nodes.map(node => [node.id, node.position])), anchors);
    assert.deepEqual(layout.sizing, initial.sizing);
  }
});

test('leaf area uses one absolute byte reference with no quantitative clamps', () => {
  const nodes = [{ size: 100 }, { size: 200 }, { size: 400 }, { size: null }, { size: 0 }, { size: 1e9 }];
  const sizing = leafSizing(nodes);
  assert.equal(sizing.referenceBytes, LEAF_REFERENCE_BYTES);
  assert.deepEqual(leafSizing([{ size: 1e12 }]).referenceBytes, sizing.referenceBytes);
  const a = leafScale(nodes[0]), b = leafScale(nodes[2]);
  assert.equal(b.areaRatio / a.areaRatio, 4);
  assert.equal(b.scale / a.scale, 2);
  assert.equal(leafScale(nodes[3]).sizeKnown, false);
  assert.equal(leafScale(nodes[3]).areaRatio, null);
  assert.equal(leafScale(nodes[4]).areaRatio, 0);
  assert.equal(leafScale(nodes[4]).scale, 0);
  assert.equal(leafScale(nodes[5]).areaRatio, 1e9 / LEAF_REFERENCE_BYTES);
  assert.equal(sizing.unknownCount, 1);
  assert.equal(sizing.clampedCount, 0);
});

test('eight times the bytes doubles every linear trunk dimension and shrink reverses it', () => {
  assert.equal(treeByteScale(TREE_REFERENCE_BYTES), 1);
  assert.equal(treeByteScale(8 * TREE_REFERENCE_BYTES), 2);
  assert.equal(trunkRadius(8 * TREE_REFERENCE_BYTES), trunkRadius(TREE_REFERENCE_BYTES) * 2);
  assert.equal(treeByteScale(0), 0);
  assert.equal(trunkRadius(0), 0);
  assert.equal(treeByteScale(Infinity), 0);
});

test('the tree cap preserves changed identities and never invents leaves', () => {
  const model = buildModel(createRepositoryFixture());
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

const frameFor = (nodes, multiplier = 1) => ({ files: nodes.map(node => ({ ...node, size: node.size === null ? null : node.size * multiplier })), activeIds: nodes.map(node => node.id) });

test('current repository bytes control growth and shrink, independent of commit position', () => {
  const model = weightedFixture(), layout = createTreeLayout(model);
  const early = createTreePose(layout, { frame: frameFor(model.nodes), index: -1 });
  const grown = createTreePose(layout, { frame: frameFor(model.nodes, 8), index: 4 });
  const shrunk = createTreePose(layout, { frame: frameFor(model.nodes), index: 20 });
  assert.deepEqual(early, shrunk, 'identical current quantities must reproduce identical geometry');
  assert.deepEqual(grown.trunk[0], [0, -40, 0]);
  assert.ok(Math.abs(branchLength(grown.folders[0]) / branchLength(early.folders[0]) - 2) < 1e-10);
  assert.equal(grown.trunkRadius / early.trunkRadius, 2);
  assert.equal(grown.lengthScale / early.lengthScale, 2);
  for (const folder of grown.folders) assert.equal(folder.droop, 0);
});

test('each branch radius follows its own descendant bytes, including omitted canopy files', () => {
  const model = weightedFixture(80);
  model.nodes.push({ id: 'elsewhere', path: 'tests/check.js', size: 1000 });
  const layout = createTreeLayout(model, { maxNodes: 15 });
  const before = createTreePose(layout, { frame: frameFor(model.nodes) });
  const frame = frameFor(model.nodes);
  frame.files.find(node => node.id === 'elsewhere').size *= 8;
  const after = createTreePose(layout, { frame });
  const branch = pose => pose.folders.find(folder => folder.path === 'src');
  const expected = model.nodes.filter(node => node.path.startsWith('src/') && node.size !== null).reduce((sum, node) => sum + node.size, 0);
  assert.equal(branch(before).loadBytes, expected);
  assert.equal(branch(before).loadCount, 80);
  assert.equal(branch(after).radius, branch(before).radius, 'growth in another subtree must not thin this branch');
  assert.ok(after.trunkRadius > before.trunkRadius);
  assert.equal(before.nodes.length, 15);
});

test('byte scaling keeps all branches and leaf twigs attached to their authored parent', () => {
  const model = weightedFixture(), layout = createTreeLayout(model);
  for (const multiplier of [0, 1, 8]) {
    const pose = createTreePose(layout, { frame: frameFor(model.nodes, multiplier) });
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

test('historical byte seeks resize leaves and reproduce exact poses without mutating the base', () => {
  const model = weightedFixture(), layout = createTreeLayout(model), before = JSON.stringify(layout);
  const frames = [frameFor(model.nodes), frameFor(model.nodes, 4), frameFor(model.nodes, 0.25)];
  const poses = frames.map(frame => createTreePose(layout, { frame }));
  const knownId = model.nodes.find(node => node.size > 0).id;
  const leaf = pose => pose.nodes.find(node => node.id === knownId);
  assert.equal(leaf(poses[1]).scale / leaf(poses[0]).scale, 2);
  assert.equal(leaf(poses[2]).scale / leaf(poses[0]).scale, 0.5);
  for (const index of [2, 0, 1, 0, 2]) assert.deepEqual(createTreePose(layout, { frame: frames[index] }), poses[index]);
  assert.equal(JSON.stringify(layout), before);
});

test('current byte sizes follow stable canopy slots across renames, while inactive files contribute nothing', () => {
  const model = { nodes: [{ id: 'a', path: 'src/a.js', size: 100 }, { id: 'b', path: 'test/b.js', size: 200 }], commits: [] };
  const layout = createTreeLayout(model);
  const pose = createTreePose(layout, { frame: { files: [{ id: 'a', path: 'test/renamed.js', size: 400 }, { id: 'b', path: 'test/b.js', size: null }], activeIds: ['a'] } });
  assert.equal(pose.knownBytes, 400);
  assert.equal(pose.folders.find(folder => folder.path === 'src').loadBytes, 400);
  assert.equal(pose.folders.find(folder => folder.path === 'test').loadBytes, 0);
  assert.equal(pose.nodes.find(node => node.id === 'a').size, 400);
  assert.equal(pose.nodes.find(node => node.id === 'b').size, null);
});

test('complete snapshot totals include files beyond the loaded model and partial totals remain explicit', () => {
  const layout = createTreeLayout({ nodes: [{ id: 'a', path: 'a.js', size: 16 }], commits: [] });
  const sizeSummary = { knownBytes: TREE_REFERENCE_BYTES, totalBytes: null, knownFiles: 20, unknownFiles: 1, fileCount: 21, complete: false };
  const pose = createTreePose(layout, { frame: { files: [{ id: 'a', path: 'a.js', size: 16 }], activeIds: ['a'], sizeSummary } });
  assert.equal(pose.lengthScale, 1);
  assert.equal(pose.folders[0].loadBytes, TREE_REFERENCE_BYTES);
  assert.deepEqual(pose.sizeSummary, sizeSummary);
  assert.equal(pose.totalBytes, null);
  assert.equal(pose.sizeComplete, false);
});

test('pose bounds contain actual unclamped leaf vertices, including very large files', () => {
  const layout = createTreeLayout({ nodes: [{ id: 'large', path: 'large.bin', size: 1e9 }], commits: [] });
  const pose = createTreePose(layout), leaf = pose.nodes[0];
  assert.ok(leaf.scale > 100);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(pose.bounds.min[axis] <= leaf.position[axis] - 3.9 * leaf.scale);
    assert.ok(pose.bounds.max[axis] >= leaf.position[axis] + 3.9 * leaf.scale);
  }
});

test('empty, unknown-only and zero-byte trees have finite bounds and honest zero quantitative size', () => {
  for (const nodes of [[], [{ id: 'readme', path: 'README.md', size: null }], [{ id: 'empty', path: 'empty.js', size: 0 }]]) {
    const pose = createTreePose(createTreeLayout({ nodes, commits: [] }));
    assert.ok(pose.trunk.flat().every(Number.isFinite));
    assert.ok(pose.center.every(Number.isFinite));
    assert.ok(Number.isFinite(pose.extent) && pose.extent > 0);
    assert.equal(pose.lengthScale, 0);
    assert.equal(pose.trunkRadius, 0);
    assert.equal(pose.knownBytes, 0);
    for (const node of pose.nodes) assert.ok(node.position.every(Number.isFinite));
  }
});


test('actual canopy buffers resize area, stem endpoints and picking together, including a zero-byte frame', () => {
  const model = buildModel({
    repository: { name: 'Byte animation' }, files: [{ path: 'file.js', size: 0 }],
    commits: [
      { sha: 'grow', files: [{ path: 'file.js', status: 'modified', sizeBefore: 16384, sizeAfter: 65536 }] },
      { sha: 'empty', files: [{ path: 'file.js', status: 'modified', sizeBefore: 65536, sizeAfter: 0 }] },
    ],
  });
  const scene = Object.create(TreeScene.prototype);
  scene.model = model; scene.layout = createTreeLayout(model);
  const pose = createTreePose(scene.layout, { frame: stateAt(model, -1) });
  scene.lengthScale = pose.lengthScale; scene.activeIds = new Set(stateAt(model, -1).activeIds);
  scene.animateTransition = true; scene.labelRecords = []; scene.folders = new Map(); scene.nodes = new Map();
  for (const folder of pose.folders) {
    const curve = new THREE.CubicBezierCurve3(...folder.curve.map(point => new THREE.Vector3(...point)));
    scene.folders.set(folder.path, { ...folder, curve, position: new THREE.Vector3(...folder.position), mesh: new THREE.Mesh(new THREE.TubeGeometry(curve, folder.path ? 28 : 44, 1, folder.path ? 9 : 14)) });
  }
  for (const node of pose.nodes) {
    const position = new THREE.Vector3(...node.position), quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...node.direction));
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(...node.stemStart), new THREE.Vector3(...node.stemControl), position.clone());
    scene.nodes.set(node.id, { size: node.scale, position, quaternion, center: new THREE.Vector3(), mesh: new THREE.Mesh(createLeafGeometry()), pick: new THREE.Object3D(), link: new THREE.Mesh(new THREE.TubeGeometry(curve, 12, .1, 5)) });
  }
  const leaf = [...scene.nodes.values()][0], branch = scene.folders.get('');
  const ids = [leaf.link.geometry.uuid, branch.mesh.geometry.uuid];
  scene._preparePose(0); scene._updatePose(.5);
  assert.ok(Math.abs(leaf.size ** 2 - 2.5) < 1e-10, 'halfway animation must interpolate area, not linear leaf size');
  assert.ok(Math.abs(leaf.pick.scale.x - leaf.size * 1.75) < 1e-10);
  const expectedCenter = new THREE.Vector3(0, 1.85 * leaf.size, 0).applyQuaternion(leaf.quaternion).add(leaf.position);
  assert.ok(leaf.pick.position.distanceTo(expectedCenter) < 1e-10);
  scene._updatePose(1);
  assert.equal(leaf.size, 2); assert.equal(leaf.currentBytes, 65536);
  scene._preparePose(1); scene._updatePose(1);
  assert.equal(leaf.size, 0); assert.equal(leaf.pick.scale.x, 1, 'empty files retain an invisible interaction target');
  assert.equal(scene.lengthScale, 0); assert.equal(branch.radius, 0);
  assert.deepEqual([leaf.link.geometry.uuid, branch.mesh.geometry.uuid], ids, 'animated resizing must reuse surface buffers');
  for (const geometry of [leaf.link.geometry, branch.mesh.geometry]) {
    assert.ok(geometry.attributes.position.array.every(Number.isFinite));
    const normals = geometry.attributes.normal.array;
    for (let index = 0; index < normals.length; index += 3) assert.ok(Math.abs(Math.hypot(normals[index], normals[index + 1], normals[index + 2]) - 1) < 1e-5, 'collapsed zero-byte geometry must keep finite unit PBR normals');
    geometry.dispose();
  }
  leaf.mesh.geometry.dispose();
});
