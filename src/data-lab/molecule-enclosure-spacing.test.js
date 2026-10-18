import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, stateAt } from './model.js';
import { createRepositoryFixture } from './test-fixtures/repository.js';
import { buildMolecularTree, molecularTreeState, fileAtomKind } from './molecule-layout.js';
import { buildFolderEnclosures } from './molecule-enclosures.js';
import { spaceFolderEnclosures } from './molecule-enclosure-spacing.js';

const modelFor = paths => buildModel({ repository: { name: 'spacing' }, files: paths.map(path => ({ path })), commits: [] });
const positions = graph => new Map([
  ...graph.folders.map(folder => [`folder:${folder.path}`, [...folder.position]]),
  ...[...graph.folderSlots].flatMap(([folder, slots]) => [...slots].map(([id, position]) => [`slot:${folder}:${id}`, [...position]])),
]);
const fileRadius = node => Math.max(node.radius, ...[node.path, ...node.aliases].map(path => fileAtomKind(path).radius));
const reserved = graph => ({
  folders: graph.folders, backboneAtoms: graph.backboneAtoms,
  atoms: [...graph.folderSlots].flatMap(([folder, slots]) => [...slots].map(([id, position]) => ({ id, folder, position, radius: fileRadius(graph.nodeById.get(id)) }))),
});

function verify(graph, before) {
  const after = positions(graph);
  assert.equal(after.size, before.size);
  for (const [key, position] of after) {
    assert.equal(position[1], before.get(key)[1], `${key}: vertical position must not change`);
    assert.ok(position.every(Number.isFinite));
    position.forEach((value, axis) => assert.ok(value >= graph.bounds.min[axis] && value <= graph.bounds.max[axis]));
  }
  const enclosures = new Map(buildFolderEnclosures(graph, reserved(graph)).map(record => [record.folder, record]));
  for (const folder of graph.folders) {
    const children = [
      ...folder.children.map(path => ({ key: `folder:${path}`, position: graph.folderByPath.get(path).position, radius: enclosures.get(path).radiusX })),
      ...[...graph.folderSlots.get(folder.path)].map(([id, position]) => ({ key: `slot:${folder.path}:${id}`, position, radius: fileRadius(graph.nodeById.get(id)) + 1 })),
    ];
    for (let a = 0; a < children.length; a++) for (let b = a + 1; b < children.length; b++) {
      const first = children[a], second = children[b];
      const distance = Math.hypot(first.position[0] - second.position[0], first.position[2] - second.position[2]);
      assert.ok(distance + 1e-7 >= first.radius + second.radius + 3, `${folder.path}: sibling footprints must not overlap`);
    }
    const oldParent = before.get(`folder:${folder.path}`);
    let sharedScale;
    for (const child of children) {
      const old = before.get(child.key), offset = [old[0] - oldParent[0], old[2] - oldParent[2]];
      const next = [child.position[0] - folder.position[0], child.position[2] - folder.position[2]];
      const length = Math.hypot(...offset);
      if (length < 1e-10) { assert.ok(Math.hypot(...next) < 1e-7); continue; }
      const scale = Math.hypot(...next) / length;
      assert.ok(scale >= 1 - 1e-9);
      assert.ok(Math.abs(offset[0] * next[1] - offset[1] * next[0]) < 1e-6, 'child direction must stay unchanged');
      if (sharedScale === undefined) sharedScale = scale;
      else assert.ok(Math.abs(scale - sharedScale) < 1e-8, 'files and folders use the same sibling scale');
    }
    assert.strictEqual(graph.backboneById.get(folder.anchorId).position, folder.position);
  }
  for (const node of graph.nodes) {
    assert.strictEqual(graph.nodeById.get(node.id), node);
    assert.deepEqual(node.position, graph.folderSlots.get(node.folder).get(node.id));
  }
  for (const bond of graph.bonds) {
    assert.strictEqual(bond.a, graph.folderByPath.get(bond.parent).position);
    assert.strictEqual(bond.b, graph.folderByPath.get(bond.folder).position);
  }
}

test('sample sibling environments separate without changing vertical tiers, directions or ordering', () => {
  const model = buildModel(createRepositoryFixture()), graph = buildMolecularTree(model), before = positions(graph);
  const order = graph.folders.map(folder => [folder.path, [...folder.children], [...folder.memberIds]]);
  spaceFolderEnclosures(graph);
  verify(graph, before);
  assert.deepEqual(graph.folders.map(folder => [folder.path, folder.children, folder.memberIds]), order);
  assert.ok([...positions(graph)].some(([key, value]) => value[0] !== before.get(key)[0] || value[2] !== before.get(key)[2]));
});

test('nested mixed siblings use one deterministic horizontal scale and preserve alias attachments', () => {
  const model = buildModel({ repository: { name: 'renames' }, files: ['README.md', 'src/entry.js', 'src/a/one.js', 'src/a/two.js', 'src/b/icon.svg', 'packages/core/moved.md'].map(path => ({ path })), commits: [
    { sha: 'add', files: [{ path: 'src/old/data.json', status: 'added' }] },
    { sha: 'move', files: [{ path: 'packages/core/moved.md', previousPath: 'src/old/data.json', status: 'renamed' }] },
  ] });
  const graph = buildMolecularTree(model), before = positions(graph);
  spaceFolderEnclosures(graph); verify(graph, before);
  const other = spaceFolderEnclosures(buildMolecularTree(model));
  assert.deepEqual(positions(graph), positions(other));
  for (const index of [-1, 0, 1]) {
    const frame = stateAt(model, index), state = molecularTreeState(graph, frame.activeIds, Object.fromEntries(frame.files.map(file => [file.id, file.path])));
    for (const atom of state.atoms) assert.deepEqual(atom.position, graph.folderSlots.get(atom.folder).get(atom.id));
    for (const bond of state.bonds.filter(bond => bond.kind === 'membership')) assert.deepEqual(bond.a, graph.folderByPath.get(bond.folder).position);
  }
  const once = positions(graph); spaceFolderEnclosures(graph);
  assert.deepEqual(positions(graph), once, 'spacing must not keep expanding when applied twice');
});

test('single-child chains retain their exact original positions', () => {
  const graph = buildMolecularTree(modelFor(['a/b/c/d/file.js'])), before = positions(graph);
  spaceFolderEnclosures(graph);
  assert.deepEqual(positions(graph), before);
  verify(graph, before);
});

test('500 mapped files keep finite nonoverlapping sibling footprints and exact levels', () => {
  const graph = buildMolecularTree(modelFor(Array.from({ length: 500 }, (_, index) => `group-${Math.floor(index / 10)}/file-${index}.js`))), before = positions(graph);
  spaceFolderEnclosures(graph);
  verify(graph, before);
  assert.equal(graph.nodes.length, 500);
  assert.ok(Number.isFinite(graph.extent));
});
