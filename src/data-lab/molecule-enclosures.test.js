import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, stateAt } from './model.js';
import { createDemoDataset } from './demo.js';
import { buildMolecularTree, molecularTreeState } from './molecule-layout.js';
import { buildFolderEnclosures } from './molecule-enclosures.js';

const create = (paths, commits = []) => {
  const model = buildModel({ repository: { name: 'enclosure-fixture' }, files: paths.map(path => ({ path })), commits });
  return { model, graph: buildMolecularTree(model) };
};
const stateFor = (model, graph, index) => {
  const state = stateAt(model, index);
  return molecularTreeState(graph, state.activeIds, Object.fromEntries(state.files.map(file => [file.id, file.path])));
};
const inside = (enclosure, position) => position.reduce((sum, value, axis) => sum + ((value - enclosure.center[axis]) / [enclosure.radiusX, enclosure.radiusY, enclosure.radiusZ][axis]) ** 2, 0);
const isDescendant = (path, ancestor) => !ancestor || path === ancestor || path.startsWith(`${ancestor}/`);
const atomSphere = (atom, padding = 0) => {
  const points = [];
  for (let latitude = 0; latitude <= 12; latitude++) for (let longitude = 0; longitude < 24; longitude++) {
    const polar = latitude / 12 * Math.PI, angle = longitude / 24 * Math.PI * 2, radius = atom.radius + padding;
    points.push([
      atom.position[0] + Math.sin(polar) * Math.cos(angle) * radius,
      atom.position[1] + Math.cos(polar) * radius,
      atom.position[2] + Math.sin(polar) * Math.sin(angle) * radius,
    ]);
  }
  return points;
};

function verify(graph, structure, enclosures) {
  assert.equal(enclosures.length, structure.folders.length);
  const byPath = new Map(enclosures.map(enclosure => [enclosure.folder, enclosure]));
  for (const enclosure of enclosures) {
    assert.equal(enclosure.radiusX, enclosure.radiusZ, 'horizontal footprint must be circular');
    assert.ok([enclosure.radiusX, enclosure.radiusY, enclosure.radiusZ].every(value => Number.isFinite(value) && value > 0));
    assert.ok(enclosure.center.every(Number.isFinite));
    assert.equal(enclosure.center[0], graph.folderByPath.get(enclosure.folder).position[0]);
    assert.equal(enclosure.center[2], graph.folderByPath.get(enclosure.folder).position[2]);
    const files = structure.atoms.filter(atom => isDescendant(atom.folder, enclosure.folder));
    const folders = structure.backboneAtoms.filter(atom => isDescendant(atom.folder, enclosure.folder));
    assert.equal(enclosure.count, files.length);
    assert.equal(enclosure.atomCount, files.length + folders.length);
    for (const atom of [...files, ...folders]) for (const point of atomSphere(atom, 0.2)) {
      assert.ok(inside(enclosure, point) <= 1 + 1e-8, `${enclosure.folder} must enclose padded atom ${atom.id}`);
    }
    const folder = graph.folderByPath.get(enclosure.folder), parent = byPath.get(folder.parent);
    if (parent) {
      // Circular footprints make this radial/vertical plane the worst case.
      const dx = enclosure.center[0] - parent.center[0], dz = enclosure.center[2] - parent.center[2];
      const radial = Math.hypot(dx, dz), x = radial ? dx / radial : 1, z = radial ? dz / radial : 0;
      for (let index = 0; index < 720; index++) {
        const angle = index / 720 * Math.PI * 2;
        const point = [
          enclosure.center[0] + Math.cos(angle) * enclosure.radiusX * x,
          enclosure.center[1] + Math.sin(angle) * enclosure.radiusY,
          enclosure.center[2] + Math.cos(angle) * enclosure.radiusZ * z,
        ];
        assert.ok(inside(parent, point) <= 1 + 1e-8, `${folder.parent} must contain the full ${folder.path} child enclosure`);
      }
    }
  }
}

test('current demo enclosures fit padded file/folder spheres and nest inside their parents', () => {
  const model = buildModel(createDemoDataset()), graph = buildMolecularTree(model);
  const structure = stateFor(model, graph, model.commits.length - 1);
  const enclosures = buildFolderEnclosures(graph, structure);
  verify(graph, structure, enclosures);
  const root = enclosures.find(enclosure => enclosure.folder === '');
  assert.equal(root.count, 53);
  assert.ok(enclosures.every(enclosure => enclosure.radiusX > enclosure.radiusY), 'ordinary sample folders have wide, shallow boundaries');
  assert.ok(root.radiusX < 75 && root.radiusY < 37, 'root also fits current descendants without an arbitrary height budget');
  assert.ok(enclosures.filter(enclosure => enclosure.folder).every(enclosure => enclosure.radiusX < 21 && enclosure.radiusY < 13), 'fitted vertical centers remove excess height without inflating horizontal caps');
});

test('delete and rename boundaries follow current paths and rewind exactly', () => {
  const { model, graph } = create(['README.md', 'packages/core/entry.md', 'config/settings.json', 'docs/start.md'], [
    { sha: 'initial', files: ['README.md', 'src/deep/nested/lib/main.js', 'config/settings.json', 'assets/icon.svg'].map(path => ({ path, status: 'added' })) },
    { sha: 'move', files: [{ path: 'packages/core/entry.md', previousPath: 'src/deep/nested/lib/main.js', status: 'renamed' }, { path: 'docs/start.md', status: 'added' }] },
    { sha: 'remove', files: [{ path: 'assets/icon.svg', status: 'removed' }] },
  ]);
  const frames = [-1, 0, 1, 2].map(index => {
    const structure = stateFor(model, graph, index), enclosures = buildFolderEnclosures(graph, structure);
    verify(graph, structure, enclosures);
    return enclosures;
  });
  assert.deepEqual(frames.map(enclosures => enclosures.length), [1, 7, 6, 5]);
  assert.deepEqual(frames.map(enclosures => enclosures.find(enclosure => enclosure.folder === '').count), [0, 4, 5, 4]);
  assert.ok(!frames[2].some(enclosure => enclosure.folder.startsWith('src')));
  assert.ok(frames[2].some(enclosure => enclosure.folder === 'packages/core'));
  assert.ok(!frames[3].some(enclosure => enclosure.folder === 'assets'));
  assert.deepEqual(buildFolderEnclosures(graph, stateFor(model, graph, 0)), frames[1]);
});

test('ghost and future slot positions do not size current contents', () => {
  const { graph } = create(['src/a.js', 'src/b.js']);
  const a = graph.nodes.find(node => node.path === 'src/a.js'), b = graph.nodes.find(node => node.path === 'src/b.js');
  const structure = molecularTreeState(graph, [a.id]);
  const before = buildFolderEnclosures(graph, structure);
  structure.ghosts[0].position = [1e8, -1e8, 1e8];
  graph.folderSlots.get('src').set(b.id, [1e8, -1e8, 1e8]);
  assert.deepEqual(buildFolderEnclosures(graph, structure), before);
  assert.equal(before.find(enclosure => enclosure.folder === 'src').count, 1);
});

test('an extreme current file enlarges the boundary and its removal shrinks it', () => {
  const { graph } = create(['src/a.js', 'src/b.js']);
  const a = graph.nodes.find(node => node.path === 'src/a.js'), b = graph.nodes.find(node => node.path === 'src/b.js');
  const both = molecularTreeState(graph, [a.id, b.id]);
  both.atoms.find(atom => atom.id === b.id).position[0] += 400;
  const large = buildFolderEnclosures(graph, both).find(enclosure => enclosure.folder === 'src');
  const small = buildFolderEnclosures(graph, molecularTreeState(graph, [a.id])).find(enclosure => enclosure.folder === 'src');
  assert.equal(large.count, 2); assert.equal(small.count, 1);
  assert.ok(large.radiusX > small.radiusX * 5);
});

test('empty root stays finite and deep chains do not recursively inflate into huge spheres', () => {
  const empty = create([]), emptyState = molecularTreeState(empty.graph);
  const emptyEnclosures = buildFolderEnclosures(empty.graph, emptyState);
  assert.equal(emptyEnclosures.length, 1);
  assert.equal(emptyEnclosures[0].count, 0);
  assert.equal(emptyEnclosures[0].radiusX, emptyState.backboneAtoms[0].radius + 0.2);
  assert.equal(emptyEnclosures[0].radiusY, emptyEnclosures[0].radiusX);
  assert.deepEqual(emptyEnclosures[0].center, emptyState.backboneAtoms[0].position);
  verify(empty.graph, emptyState, emptyEnclosures);
  const path = `${Array.from({ length: 40 }, (_, index) => `level${index}`).join('/')}/file.js`;
  const deep = create([path]), structure = molecularTreeState(deep.graph), enclosures = buildFolderEnclosures(deep.graph, structure);
  verify(deep.graph, structure, enclosures);
  const root = enclosures.find(enclosure => enclosure.folder === '');
  const verticalSpan = deep.graph.bounds.max[1] - deep.graph.bounds.min[1];
  assert.ok(root.radiusY < verticalSpan, 'height remains proportional to the actual hierarchy');
  assert.ok(root.radiusX < root.radiusY, 'a truly deep hierarchy need not force an enormous horizontal radius');
});

test('large and mixed folders remain finite and include every current descendant', () => {
  const { graph } = create([
    ...Array.from({ length: 500 }, (_, index) => `src/file-${index}.js`),
  ]);
  const structure = molecularTreeState(graph), enclosures = buildFolderEnclosures(graph, structure);
  assert.equal(enclosures.length, 2);
  assert.equal(enclosures.find(enclosure => enclosure.folder === 'src').count, 500);
  assert.ok(enclosures.every(enclosure => enclosure.radiusX < 10000));
  // Checking every sphere on this dense fixture adds little beyond the demo;
  // check its centers and all outer cardinal extents instead.
  for (const enclosure of enclosures) for (const atom of [...structure.atoms, ...structure.backboneAtoms].filter(atom => isDescendant(atom.folder, enclosure.folder))) {
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const point = [...atom.position]; point[axis] += sign * (atom.radius + 0.2);
      assert.ok(inside(enclosure, point) <= 1 + 1e-8);
    }
  }
  const mixed = create(['root.js', 'a/direct.json', 'a/sub/doc.md', 'a/sub/nested/icon.svg', 'b/one.js', 'b/two.js']);
  const mixedState = molecularTreeState(mixed.graph);
  verify(mixed.graph, mixedState, buildFolderEnclosures(mixed.graph, mixedState));
});

test('reserved camera contents work without state counters and calls never mutate graph or atom tiers', () => {
  const { graph } = create(['src/a.js', 'docs/readme.md']);
  const reserved = {
    folders: graph.folders, backboneAtoms: graph.backboneAtoms,
    atoms: [...graph.folderSlots].flatMap(([folder, slots]) => [...slots].map(([id, position]) => ({ id, folder, position, radius: graph.nodeById.get(id).radius }))),
  };
  const graphBefore = structuredClone(graph), contentsBefore = structuredClone(reserved);
  const first = buildFolderEnclosures(graph, reserved), second = buildFolderEnclosures(graph, reserved);
  assert.deepEqual(first, second);
  assert.deepEqual(graph, graphBefore);
  assert.deepEqual(reserved, contentsBefore);
  assert.equal(first.find(enclosure => enclosure.folder === '').count, 2);
});


test('tight fit beats an independent volume grid and leaves no removable uniform margin', () => {
  const model = buildModel(createDemoDataset()), graph = buildMolecularTree(model);
  const structure = stateFor(model, graph, model.commits.length - 1);
  const enclosure = buildFolderEnclosures(graph, structure).find(record => record.folder === 'app');
  const atoms = [...structure.atoms, ...structure.backboneAtoms].filter(atom => atom.folder === 'app');
  const supports = atoms.map(atom => ({
    y: atom.position[1], radius: atom.radius + 0.2,
    offset: Math.hypot(atom.position[0] - enclosure.center[0], atom.position[2] - enclosure.center[2]),
  }));
  const minY = Math.min(...supports.map(atom => atom.y)), maxY = Math.max(...supports.map(atom => atom.y));
  const angles = Array.from({ length: 129 }, (_, index) => {
    const angle = index / 128 * Math.PI / 2;
    return { sin: Math.sin(angle), cos: Math.cos(angle) };
  });
  let gridVolume = Infinity;
  for (let centerIndex = 0; centerIndex <= 40; centerIndex++) {
    const centerY = minY + (maxY - minY) * centerIndex / 40;
    const minimumHeight = Math.max(...supports.map(atom => Math.abs(atom.y - centerY) + atom.radius));
    for (let heightIndex = 0; heightIndex <= 40; heightIndex++) {
      const height = minimumHeight * (1.0001 + heightIndex / 40);
      let radius = 0;
      for (const atom of supports) for (const angle of angles) {
        const y = (Math.abs(atom.y - centerY) + atom.radius * angle.sin) / height;
        radius = Math.max(radius, (atom.offset + atom.radius * angle.cos) / Math.sqrt(1 - y * y));
      }
      gridVolume = Math.min(gridVolume, radius * radius * height);
    }
  }
  const volume = enclosure.radiusX ** 2 * enclosure.radiusY;
  assert.ok(volume <= gridVolume * 1.02, 'bounded fit stays within 2% of an independently sampled minimum');
  assert.ok(volume < 17.54 ** 2 * 16.30 * 0.6, 'fit removes over 40% of the previous app boundary volume');
  const shrunken = { ...enclosure, radiusX: enclosure.radiusX * 0.99, radiusY: enclosure.radiusY * 0.99, radiusZ: enclosure.radiusZ * 0.99 };
  assert.ok(atoms.some(atom => atomSphere(atom, 0.2).some(point => inside(shrunken, point) > 1)), 'another uniform 1% shrink would cut through the padded contents');
});

test('a singleton has only its real sphere radius and clearance, with no count or dimension floor', () => {
  const { graph } = create([]), structure = molecularTreeState(graph);
  structure.backboneAtoms[0] = { ...structure.backboneAtoms[0], radius: 0.05 };
  const [enclosure] = buildFolderEnclosures(graph, structure);
  assert.equal(enclosure.radiusX, 0.25);
  assert.equal(enclosure.radiusY, 0.25);
  assert.equal(enclosure.radiusZ, 0.25);
  assert.equal(enclosure.count, 0);
});
