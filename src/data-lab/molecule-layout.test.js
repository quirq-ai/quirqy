import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, stateAt } from './model.js';
import { createRepositoryFixture } from './test-fixtures/repository.js';
import { FILE_ATOM_KINDS, fileAtomKind, buildMolecularTree, molecularTreeState } from './molecule-layout.js';

const modelFor = paths => buildModel({ repository: { name: 'fixture' }, files: paths.map(path => ({ path, size: 128 })), commits: [] });
const at = (model, graph, index) => {
  const frame = stateAt(model, index);
  return molecularTreeState(graph, frame.activeIds, Object.fromEntries(frame.files.map(file => [file.id, file.path])));
};
const movedFixture = () => buildModel({
  repository: { name: 'rename-fixture' },
  files: ['README.md', 'packages/core/entry.md', 'config/settings.json', 'docs/start.md'].map(path => ({ path })),
  commits: [
    { sha: 'initial', files: ['README.md', 'src/deep/nested/lib/main.js', 'config/settings.json', 'assets/icon.svg'].map(path => ({ path, status: 'added' })) },
    { sha: 'move', files: [{ path: 'packages/core/entry.md', previousPath: 'src/deep/nested/lib/main.js', status: 'renamed' }, { path: 'docs/start.md', status: 'added' }] },
    { sha: 'delete', files: [{ path: 'assets/icon.svg', status: 'removed' }] },
  ],
});

function assertState(graph, state) {
  assert.equal(state.atoms.length, state.atomCount);
  assert.equal(state.backboneAtoms.length, state.backboneCount);
  assert.equal(state.backboneCount, state.moleculeCount, 'exactly one carbon per active folder');
  assert.equal(graph.backboneAtoms.length, graph.folders.length, 'no additional scaffold carbons');
  assert.equal(state.atoms.length + state.ghosts.length, graph.nodes.length);
  assert.equal(new Set([...state.atoms, ...state.ghosts].map(node => node.id)).size, graph.nodes.length, 'each mapped identity has exactly one file record');
  assert.equal(state.moleculeCount, state.folders.length);
  assert.equal(state.folderBondCount, state.moleculeCount - 1);
  assert.equal(Object.values(state.typeCounts).reduce((sum, count) => sum + count, 0), state.atomCount);
  assert.equal(state.bonds.length, state.atomCount + state.backboneCount - 1, 'one exact acyclic containment tree');
  const files = new Map(state.atoms.map(atom => [atom.id, atom]));
  const carbons = new Map(state.backboneAtoms.map(atom => [atom.id, atom]));
  const neighbors = new Map([...files.keys(), ...carbons.keys()].map(id => [id, []]));
  for (const node of state.nodes) {
    assert.equal(node.radius, node.kind.radius);
    assert.equal(node.element, node.kind.element);
    assert.ok(node.position.every(Number.isFinite));
    const parent = graph.backboneById.get(node.backboneId);
    assert.ok(node.position[1] + node.radius < parent.position[1] - parent.radius, 'every file atom lies completely below its folder carbon');
  }
  for (const bond of state.bonds) {
    assert.ok(bond.a.every(Number.isFinite) && bond.b.every(Number.isFinite));
    const length = Math.hypot(...bond.a.map((value, axis) => value - bond.b[axis]));
    assert.ok(Number.isFinite(length) && length > 0, 'containment links have finite positive length');
    const a = bond.aBackboneId || bond.aFileId, b = bond.bBackboneId || bond.bFileId;
    assert.ok(neighbors.has(a) && neighbors.has(b));
    neighbors.get(a).push(b); neighbors.get(b).push(a);
    if (bond.kind === 'membership') {
      assert.ok(carbons.has(bond.aBackboneId));
      assert.ok(files.has(bond.bFileId));
      assert.equal(carbons.get(bond.aBackboneId).folder, bond.folder);
      assert.equal(files.get(bond.bFileId).folder, bond.folder);
    } else {
      assert.ok(carbons.has(bond.aBackboneId) && carbons.has(bond.bBackboneId));
      assert.equal(carbons.get(bond.bBackboneId).folder, bond.folder);
      assert.equal(bond.kind, 'folder', 'carbon bonds are actual parent-child folder relationships only');
      assert.equal(bond.parent, graph.folderByPath.get(bond.folder).parent);
      assert.equal(carbons.get(bond.aBackboneId).folder, bond.parent);
    }
  }
  const visited = new Set(), queue = [state.backboneAtoms[0].id];
  while (queue.length) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id); queue.push(...neighbors.get(id));
  }
  assert.equal(visited.size, neighbors.size, 'all present file and folder atoms form one connected containment tree');
  for (const atom of state.atoms) assert.equal(neighbors.get(atom.id).length, 1, `file atom ${atom.element} must be terminal`);
  for (const atom of state.backboneAtoms) {
    const folder = graph.folderByPath.get(atom.folder);
    assert.equal(atom.element, 'C');
    assert.deepEqual(folder.backboneIds, [atom.id]);
    assert.deepEqual(folder.carbonIds, [atom.id]);
    assert.equal(folder.anchorId, atom.id);
    assert.deepEqual(folder.position, atom.position);
    const directFiles = state.atoms.filter(file => file.folder === atom.folder).length;
    const directFolders = state.folders.filter(child => child.parent === atom.folder).length;
    assert.equal(neighbors.get(atom.id).length, directFiles + directFolders + (folder.parent === null ? 0 : 1), 'carbon degree follows actual direct containment');
  }
  for (const folder of state.folders) {
    const direct = state.atoms.filter(node => node.folder === folder.path);
    assert.equal(folder.directCount, direct.length);
    assert.equal(state.bonds.filter(bond => bond.kind === 'membership' && bond.folder === folder.path).length, direct.length);
    assert.equal(folder.totalCount, state.atoms.filter(node => !folder.path || node.folder === folder.path || node.folder.startsWith(`${folder.path}/`)).length);
  }
}

test('one terminal typed atom represents each file with element-inspired display colors and radii', () => {
  assert.deepEqual(FILE_ATOM_KINDS.map(kind => kind.id), ['code', 'data', 'document', 'asset']);
  for (const [path, type] of [['main.ts', 'code'], ['data.json', 'data'], ['README', 'document'], ['image.svg', 'asset']]) assert.equal(fileAtomKind(path).id, type);
  assert.deepEqual(FILE_ATOM_KINDS.map(kind => kind.element), ['N', 'O', 'H', 'S']);
  for (const kind of FILE_ATOM_KINDS) assert.deepEqual(Object.keys(kind).sort(), ['color', 'element', 'elementName', 'id', 'label', 'radius']);
  const graph = buildMolecularTree(modelFor(['src/a.js', 'src/settings.json', 'docs/readme.md', 'icon.svg']));
  const state = molecularTreeState(graph);
  assert.equal(state.atomCount, 4);
  assertState(graph, state);
  assert.ok(!('molarMass' in state) && !('carbons' in graph) && !('hydrogens' in graph));
});

test('every demo frame has exactly one active or ghost atom per mapped identity', () => {
  const model = buildModel(createRepositoryFixture()), graph = buildMolecularTree(model);
  for (let index = -1; index < model.commits.length; index++) {
    const state = at(model, graph, index), expected = stateAt(model, index).activeIds.filter(id => graph.nodeById.has(id));
    assert.equal(state.atomCount, expected.length);
    assertState(graph, state);
  }
});

test('cross-folder rename changes membership and type while old empty folder chains disappear', () => {
  const model = movedFixture(), graph = buildMolecularTree(model);
  const baseline = at(model, graph, -1), initial = at(model, graph, 0), moved = at(model, graph, 1), final = at(model, graph, 2);
  assert.deepEqual([baseline.atomCount, initial.atomCount, moved.atomCount, final.atomCount], [0, 4, 5, 4]);
  assert.deepEqual([baseline.moleculeCount, initial.moleculeCount, moved.moleculeCount, final.moleculeCount], [1, 7, 6, 5]);
  for (const state of [baseline, initial, moved, final]) assertState(graph, state);
  const old = initial.atoms.find(atom => atom.path.endsWith('main.js'));
  const renamed = moved.atoms.find(atom => atom.id === old.id);
  assert.equal(old.folder, 'src/deep/nested/lib');
  assert.equal(old.type, 'code');
  assert.equal(renamed.path, 'packages/core/entry.md');
  assert.equal(renamed.folder, 'packages/core');
  assert.equal(renamed.type, 'document');
  assert.notDeepEqual(old.position, renamed.position);
  assert.ok(!moved.folderIds.has('src'));
  assert.ok(moved.folderIds.has('packages/core'));
  assert.ok(!final.folderIds.has('assets'));
  assert.deepEqual(at(model, graph, 0), initial, 'rewinding restores exact slots, folders and types');
  const unchanged = initial.atoms.find(atom => atom.path === 'config/settings.json');
  assert.deepEqual(moved.atoms.find(atom => atom.id === unchanged.id).position, unchanged.position);
});

test('all actual ancestor levels and folders survive beyond old depth and folder limits', () => {
  const deep = `${Array.from({ length: 14 }, (_, index) => `level${index}`).join('/')}/entry.js`;
  const graph = buildMolecularTree(modelFor([deep, ...Array.from({ length: 60 }, (_, index) => `folder${index}/file.js`)]));
  assert.equal(graph.nodes.length, 61);
  assert.equal(graph.folders.length, 75);
  assert.equal(Math.max(...graph.folders.map(folder => folder.depth)), 14);
  const state = molecularTreeState(graph);
  assert.equal(state.folderBondCount, 74);
  for (const folder of graph.folders) if (folder.parent !== null) {
    assert.ok(graph.folderByPath.has(folder.parent));
    assert.ok(folder.position[1] < graph.folderByPath.get(folder.parent).position[1], 'folder hierarchy runs downward');
    assert.ok(graph.bonds.some(bond => bond.kind === 'folder' && bond.folder === folder.path && bond.parent === folder.parent), 'child folder carbon bonds directly to its actual parent');
  }
  assertState(graph, state);
});

test('renames inside one folder keep the same atom slot and use the current extension', () => {
  const model = buildModel({ repository: { name: 'types' }, files: [{ path: 'src/output.json' }], commits: [{ sha: 'rename', files: [{ path: 'src/output.json', previousPath: 'src/output.js', status: 'renamed' }] }] });
  const graph = buildMolecularTree(model);
  const before = at(model, graph, -1), after = at(model, graph, 0);
  assert.equal(before.atoms[0].type, 'code');
  assert.equal(after.atoms[0].type, 'data');
  assert.deepEqual(before.atoms[0].position, after.atoms[0].position);
  assert.equal(graph.folderByPath.get('src').memberIds.length, 1);
});

test('display cap preserves recent-file priority without inventing atoms or compressing folders', () => {
  const model = modelFor(Array.from({ length: 540 }, (_, index) => `folder-${String(index).padStart(3, '0')}/src/entry.js`));
  const last = model.nodes[539];
  model.commits = [{ changes: [{ id: last.id }] }];
  const graph = buildMolecularTree(model);
  assert.equal(graph.nodes.length, 500);
  assert.equal(graph.totalCount, 540);
  assert.ok(graph.nodeById.has(last.id));
  assert.equal(graph.folders.length, 1001);
  assertState(graph, molecularTreeState(graph));
});

test('a folder with 500 files remains exactly one carbon with 500 direct file bonds', () => {
  const graph = buildMolecularTree(modelFor(Array.from({ length: 500 }, (_, index) => `src/module-${index}.js`)));
  const state = molecularTreeState(graph);
  assertState(graph, state);
  assert.equal(state.backboneCount, 2, 'root plus src, regardless of file count');
  assert.equal(state.bonds.filter(bond => bond.kind === 'membership' && bond.folder === 'src').length, 500);
  assert.equal(graph.folderByPath.get('src').carbonIds.length, 1);
  for (let a = 0; a < state.atoms.length; a++) for (let b = a + 1; b < state.atoms.length; b++) {
    assert.ok(Math.hypot(...state.atoms[a].position.map((value, index) => value - state.atoms[b].position[index])) > state.atoms[a].radius + state.atoms[b].radius, 'file spheres must not overlap');
  }
});

test('empty data and an explicit zero cap retain one root carbon and no file atoms', () => {
  for (const graph of [buildMolecularTree(modelFor([])), buildMolecularTree(modelFor(['a.js']), { maxNodes: 0 })]) {
    const state = molecularTreeState(graph);
    assert.equal(state.atomCount, 0);
    assert.equal(state.moleculeCount, 1);
    assert.equal(state.folderBondCount, 0);
    assert.equal(state.bonds.length, 0);
    assertState(graph, state);
  }
});

test('layout is deterministic and active membership does not mutate reserved positions', () => {
  const model = movedFixture();
  const first = buildMolecularTree(model), second = buildMolecularTree(model);
  assert.deepEqual(first, second);
  const positions = JSON.stringify([...first.folderSlots].map(([path, slots]) => [path, [...slots]]));
  for (let index = -1; index < model.commits.length; index++) at(model, first, index);
  assert.equal(JSON.stringify([...first.folderSlots].map(([path, slots]) => [path, [...slots]])), positions);
});


test('representative containment tree separates file and folder spheres in genuine 3D', () => {
  const graph = buildMolecularTree(buildModel(createRepositoryFixture()));
  const state = molecularTreeState(graph), atoms = [...state.atoms, ...state.backboneAtoms];
  assert.ok(Math.max(...graph.folders.map(folder => folder.position[2])) - Math.min(...graph.folders.map(folder => folder.position[2])) > 5, 'folder centers have genuine z depth');
  for (let a = 0; a < atoms.length; a++) for (let b = a + 1; b < atoms.length; b++) {
    const distance = Math.hypot(...atoms[a].position.map((value, axis) => value - atoms[b].position[axis]));
    assert.ok(distance > atoms[a].radius + atoms[b].radius, `${atoms[a].id} overlaps ${atoms[b].id}`);
  }
  assertState(graph, state);
});


test('children spread below their parent with clear spacing, from single files to crowded folders', () => {
  for (const count of [1, 2, 5, 10, 12, 13, 23, 50, 500]) {
    const graph = buildMolecularTree(modelFor(Array.from({ length: count }, (_, index) => `nested/folder/file-${index}.svg`)));
    const folder = graph.folderByPath.get('nested/folder');
    const state = molecularTreeState(graph);
    assertState(graph, state);
    for (const atom of state.atoms) {
      const drop = folder.position[1] - atom.position[1];
      assert.ok(drop > atom.radius + graph.backboneById.get(folder.anchorId).radius, 'every file sphere stays below its folder carbon');
    }
    if (count === 1) {
      assert.ok(Math.abs(state.atoms[0].position[0] - folder.position[0]) < 1e-9);
      assert.ok(Math.abs(state.atoms[0].position[2] - folder.position[2]) < 1e-9);
    }
    for (let a = 0; a < state.atoms.length; a++) for (let b = a + 1; b < state.atoms.length; b++) {
      const first = state.atoms[a], second = state.atoms[b];
      assert.ok(Math.hypot(...first.position.map((value, axis) => value - second.position[axis])) > first.radius + second.radius + 2, 'file atoms retain visible space between their surfaces');
    }
  }
});


test('files and subfolders share one child tier, including mixed folder contents', () => {
  const graph = buildMolecularTree(modelFor([
    ...Array.from({ length: 12 }, (_, index) => `mixed/file-${index}.js`),
    ...Array.from({ length: 20 }, (_, index) => `mixed/nested/file-${index}.svg`),
    'mixed/other/readme.md',
  ]));
  const parent = graph.folderByPath.get('mixed');
  const children = [
    ...graph.nodes.filter(node => node.folder === parent.path),
    ...graph.folders.filter(folder => folder.parent === parent.path),
  ];
  assert.equal(new Set(children.map(child => child.position[1])).size, 1, 'files and folder carbons use the same downward tier');
  assert.ok(children.every(child => child.position[1] < parent.position[1]));
  assert.ok(new Set(children.map(child => child.position[0])).size > 1);
  assert.ok(new Set(children.map(child => child.position[2])).size > 1, 'both kinds share the same three-dimensional spread');
  assertState(graph, molecularTreeState(graph));
});
