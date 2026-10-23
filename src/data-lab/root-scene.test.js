import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RepositoryRoots, ROOT_NEUTRAL_ALPHA } from './root-scene.js';
import { buildModel, stateAt } from './model.js';

function renderer() {
  const roots = Object.create(RepositoryRoots.prototype);
  const labels = {
    records: [], files: [], mode: 'organic', clear() { this.records = []; this.files = []; },
    setFocusFolder(path) { this.focusedPath = path || null; }, setPresentationMode(mode) { this.mode = mode; },
    setLayout(folders, files) {
      this.files = [...files].map(([key, source]) => ({ key, source, textWidth: source.node.name.length * 7 }));
      this.records = this.files;
    }, update() {}, dispose() { this.clear(); },
  };
  Object.assign(roots, {
    camera: new THREE.PerspectiveCamera(42, 1.6, .05, 8e6), group: new THREE.Group(), labels,
    files: new Map(), folders: new Map(), options: { roots: true, labels: true, activity: true },
    selectedId: null, hovered: null, changedIds: new Set(), statuses: {},
    presentationMode: 'organic', signature: null, index: null, transition: null,
    motionPreference: null, disposed: false,
  });
  return roots;
}

function model(suffix = '') {
  return buildModel({
    repository: { name: `mode-test${suffix}` },
    files: [{ path: `src/a${suffix}.js`, size: 100 }, { path: `test/b${suffix}.js`, size: 200 }, { path: '.cache/hidden', size: 100 }],
    commits: [{ sha: `touch${suffix}`, files: [{ path: `src/a${suffix}.js`, status: 'modified', sizeBefore: 50, sizeAfter: 100 }] }],
  });
}
const shape = roots => [...roots.files].map(([id, record]) => [id, record.position.toArray(), [record.curve.v0, record.curve.v1, record.curve.v2, record.curve.v3].map(point => point.toArray()), record.radius, record.touchCount, record.addedLength]);
const setFrame = (roots, index) => {
  const frame = stateAt(roots.model, index);
  roots.setFrame({ index, activeIds: frame.activeIds, paths: new Map(frame.files.map(file => [file.id, file.path])), selectedId: roots.selectedId, animate: false });
};

test('root focus rebuilds classification, restores the exact organic pose, and disposes replaced batches', () => {
  const roots = renderer(); roots.setModel(model());
  assert.equal(roots.files.size, 2, 'hidden paths remain excluded in both presentations');
  const organic = shape(roots), selected = [...roots.files.keys()][0];
  roots.select(selected);
  let disposed = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (const batch of [roots.fileBatch, roots.folderBatch]) batch.geometry.addEventListener('dispose', () => disposed++);
    assert.equal(roots.setPresentationMode('classification'), true);
    assert.equal(roots.layout.kind, 'classification'); assert.equal(roots.labels.mode, 'classification');
    assert.equal(roots.selectedId, selected); assert.equal(roots.index, 0);
    assert.equal(roots.selectionTrace.visible, true);
    for (const record of roots.strands) {
      assert.ok(record.range.segments <= 256);
      assert.ok(record.position.toArray().every(Number.isFinite));
    }
    const geometry = roots.fileBatch.geometry;
    assert.equal(roots.setPresentationMode('classification'), false);
    assert.equal(roots.fileBatch.geometry, geometry, 'repeating a presentation must not rebuild it');
    for (const batch of [roots.fileBatch, roots.folderBatch]) batch.geometry.addEventListener('dispose', () => disposed++);
    roots.setPresentationMode('organic');
    assert.deepEqual(shape(roots), organic, 'Frame view must restore original lengths, thickness, and positions exactly');
  }
  assert.equal(disposed, 12);
  roots.setPresentationMode('classification');
  const head = shape(roots);
  setFrame(roots, -1);
  const baseline = shape(roots);
  assert.deepEqual(head.map(row => [row[0], row[1][0], row[1][2]]), baseline.map(row => [row[0], row[1][0], row[1][2]]), 'vertical touch growth must retain classification X/Z lanes');
  setFrame(roots, 0); assert.deepEqual(shape(roots), head);
  roots.setModel(model('-new'));
  assert.equal(roots.layout.kind, 'classification');
  assert.equal(roots.selectedId, null);
  assert.ok([...roots.files.values()].every(record => record.node.path.includes('-new')));
  roots.setPresentationMode('organic');
  assert.notEqual(roots.layout.kind, 'classification');
  roots.dispose(); assert.equal(roots.group.children.length, 0);
});


test('classification joins preserve helical phase across bounded connector pitches', () => {
  const roots = renderer();
  roots.setModel(buildModel({ repository: { name: 'Long connector' }, commits: [], files: Array.from({ length: 75 }, (_, index) => ({ path: `src/file-${index}.js`, size: 100 })) }));
  roots.setPresentationMode('classification');
  assert.ok(roots.classificationCalibration.tierPitch > 28, 'a wide historical hierarchy needs separated overview tiers');
  assert.equal(roots.classificationCalibration.tierPitch, roots.classificationCalibration.referenceWidth / 40);
  let different = 0;
  for (const record of roots.strands) {
    const parent = record.kind === 'file' ? record.folder : roots.folders.get(record.parent);
    if (!parent?.range || parent.range.pitch === record.range.pitch) continue;
    different++;
    assert.ok(Math.abs(record.ropeStartDistance / record.range.pitch - parent.ropeEndDistance / parent.range.pitch) < 1e-10);
    for (let index = 0; index < 2; index++) {
      const parentEnd = parent.range.vines[index].vertexStart + parent.range.segments * (parent.range.sides + 1);
      const childStart = record.range.vines[index].vertexStart;
      const a = new THREE.Vector3().fromArray(parent.batch.centers, parentEnd * 3);
      const b = new THREE.Vector3().fromArray(record.batch.centers, childStart * 3);
      assert.ok(a.distanceTo(b) < 1e-5, 'actual helix center rings must meet at the folder junction');
    }
  }
  assert.ok(different > 0, 'fixture must exercise different decorative pitches');
  roots.dispose();
});

test('classification folder focus dims unrelated geometry and restores it on exit', () => {
  const roots = renderer(); roots.setModel(model()); roots.setPresentationMode('classification');
  const unrelated = [...roots.files.values()].find(record => record.node.folder === 'test');
  const original = unrelated.range.color.clone();
  roots.setFocusFolder('src');
  assert.ok(unrelated.range.color.r < original.r * .2);
  roots.setFocusFolder(null);
  assert.ok(unrelated.range.color.equals(original));
  roots.dispose();
});


test('historical names and depth calibration stay pinned while files are added and renamed', () => {
  const roots = renderer();
  const files = Array.from({ length: 10 }, (_, index) => ({ path: `large/file-${index}.js`, size: 100 }));
  roots.setModel(buildModel({
    repository: { name: 'Historical tiers' },
    files: [{ path: 'new/a.js', size: 100 }, { path: 'small/b.js', size: 100 }, { path: 'src/loose.js', size: 100 }, ...files],
    commits: [
      { sha: 'add-first', files: files.slice(0, 5).map(file => ({ path: file.path, status: 'added' })) },
      { sha: 'add-second', files: files.slice(5).map(file => ({ path: file.path, status: 'added' })) },
      { sha: 'rename', files: [
        { path: 'new/a.js', previousPath: 'old/a.js', status: 'renamed' },
        { path: 'src/loose.js', previousPath: 'loose.js', status: 'renamed' },
      ] },
    ],
  }));
  roots.setPresentationMode('classification');
  const head = shape(roots), looseId = roots.model.nodes.find(node => node.path === 'src/loose.js').id;
  const calibration = roots.classificationCalibration;
  assert.ok(calibration.labelWidths.has('folder:old'));
  assert.ok(calibration.labelWidths.has(`file:${looseId}`));
  assert.equal(calibration.tierPitch, 28); assert.equal(calibration.lanePitch, 8);
  for (const index of [-1, 1, 0, -1, 1]) {
    setFrame(roots, index);
    assert.equal(roots.classificationCalibration, calibration);
    assert.equal(roots.folders.get('old').position.y, -40 - calibration.tierPitch);
    assert.equal(roots.files.get(looseId).node.depth, 1);
    for (const folder of roots.folders.values()) assert.equal(folder.position.y, -40 - folder.depth * calibration.tierPitch);
  }
  setFrame(roots, 2);
  assert.deepEqual(shape(roots), head, 'historical calibration must leave the current head layout exactly unchanged');
  roots.dispose();
});

test('classification renders persistent byte-direction colors in actual ropes and centerlines only', async () => {
  const { ROOT_ATTENTION_COLORS } = await import('./root-attention.js');
  const roots = renderer();
  roots.setModel(buildModel({
    repository: { name: 'Byte directions' },
    files: [{ path: 'src/grow', size: 40 }, { path: 'src/shrink', size: 10 }, { path: 'src/same', size: 20 }, { path: 'src/unknown', size: 20 }, { path: 'src/quiet', size: 99 }],
    commits: [
      { sha: 'edit', files: [
        { path: 'src/grow', status: 'modified', sizeBefore: 10, sizeAfter: 40 },
        { path: 'src/shrink', status: 'modified', sizeBefore: 50, sizeAfter: 10 },
        { path: 'src/same', status: 'modified', sizeBefore: 20, sizeAfter: 20 },
        { path: 'src/unknown', status: 'modified', sizeAfter: 20 },
      ] },
      { sha: 'unrelated', files: [] },
    ],
  }));
  const organic = [...roots.files].map(([id, record]) => [id, record.range.color.toArray()]);
  roots.setPresentationMode('classification');
  const byName = name => [...roots.files.values()].find(record => record.node.name === name);
  const assertColor = (record, hex) => {
    const color = new THREE.Color(hex);
    assert.ok(record.range.color.equals(color));
    assert.ok(record.centerlineRange.color.equals(color));
    for (const [array, start, shade] of [
      [record.batch.geometry.attributes.color.array, record.range.vines[0].vertexStart * record.batch.geometry.attributes.color.itemSize, record.batch.shades[record.range.vines[0].vertexStart]],
      [roots.centerlines.geometry.attributes.color.array, record.centerlineRange.vertexStart * roots.centerlines.geometry.attributes.color.itemSize, 1],
    ]) for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(array[start + axis] - color.toArray()[axis] * shade) < 1e-6, 'actual geometry attributes must carry the semantic hue beneath the rope shading');
  };
  const expected = { grow: 'increase', shrink: 'decrease', same: 'same', unknown: 'unknown', quiet: 'unknown' };
  for (const [name, direction] of Object.entries(expected)) assertColor(byName(name), ROOT_ATTENTION_COLORS[direction]);
  assert.equal(byName('grow').attention.commitIndex, 0);
  assert.equal(byName('grow').attention.deltaBytes, 30);
  assert.equal(byName('quiet').attention, null);
  assertColor(roots.folders.get('src'), ROOT_ATTENTION_COLORS.unknown);
  const settled = shape(roots), geometry = roots.fileBatch.geometry;
  roots.setOptions({ activity: false });
  for (const [name, direction] of Object.entries(expected)) assertColor(byName(name), ROOT_ATTENTION_COLORS[direction]);
  roots.select(byName('shrink').node.id);
  const selected = new THREE.Color(ROOT_ATTENTION_COLORS.decrease).lerp(new THREE.Color(0xe1eefc), .12);
  assert.ok(byName('shrink').range.color.equals(selected), 'selection must retain the red hue');
  roots.select(null); setFrame(roots, 1); setFrame(roots, 1);
  assert.equal(byName('grow').attention.touchCount, 1);
  assert.deepEqual(shape(roots), settled); assert.equal(roots.fileBatch.geometry, geometry);
  setFrame(roots, -1);
  for (const record of roots.files.values()) { assert.equal(record.attention, null); assertColor(record, ROOT_ATTENTION_COLORS.unknown); }
  setFrame(roots, 1); assert.deepEqual(shape(roots), settled);
  roots.setPresentationMode('organic');
  assert.deepEqual([...roots.files].map(([id, record]) => [id, record.range.color.toArray()]), organic, 'organic roots retain their existing palette');
  roots.dispose();
});

test('classification clears a previous known hue on an unknown next touch and never adds deletion ghosts', async () => {
  const { ROOT_ATTENTION_COLORS } = await import('./root-attention.js');
  const roots = renderer();
  roots.setModel(buildModel({ repository: { name: 'Unknown and deleted' }, files: [{ path: 'src/quiet', size: 1 }], commits: [
    { sha: 'known', files: [{ path: 'src/a', status: 'modified', sizeBefore: 10, sizeAfter: 20 }] },
    { sha: 'unknown', files: [{ path: 'src/a', status: 'modified', sizeBefore: 20, sizeAfter: null }] },
    { sha: 'removed', files: [{ path: 'src/a', status: 'removed', sizeBefore: null }] },
  ] }));
  roots.setPresentationMode('classification');
  const id = roots.model.commits[0].changes[0].id;
  assert.equal(roots.files.has(id), false);
  setFrame(roots, 0);
  assert.equal(roots.files.get(id).attention.direction, 'increase');
  setFrame(roots, 1);
  assert.equal(roots.files.get(id).attention.direction, 'unknown');
  assert.ok(roots.files.get(id).range.color.equals(new THREE.Color(ROOT_ATTENTION_COLORS.unknown)));
  setFrame(roots, 2);
  assert.equal(roots.files.has(id), false); assert.equal(roots.renderedCount, 1);
  roots.dispose();
});

test('classification neutral alpha is real in ropes and lines, while selection and organic mode stay readable', () => {
  const roots = renderer(); roots.setModel(model());
  const original = shape(roots);
  assert.equal(roots.fileBatch.geometry.attributes.color.itemSize, 3);
  assert.equal(roots.filamentMesh.material.transparent, false);
  assert.equal(roots.filamentMesh.material.depthWrite, true);
  assert.equal(roots.centerlines.material.opacity, .38);
  roots.setPresentationMode('classification'); setFrame(roots, -1);
  const selected = [...roots.files.values()][0], geometry = roots.fileBatch.geometry;
  const assertAlpha = (record, alpha) => {
    assert.equal(record.alpha, alpha); assert.equal(record.range.alpha, alpha); assert.equal(record.centerlineRange.alpha, alpha);
    for (const [attribute, start, count] of [
      [record.batch.geometry.attributes.color, record.range.vertexStart, record.range.vertexCount],
      [roots.centerlines.geometry.attributes.color, record.centerlineRange.vertexStart, record.centerlineRange.vertexCount],
    ]) {
      assert.equal(attribute.itemSize, 4);
      for (let vertex = start; vertex < start + count; vertex++) assert.ok(Math.abs(attribute.array[vertex * 4 + 3] - alpha) < 1e-6);
    }
  };
  for (const record of roots.strands) assertAlpha(record, ROOT_NEUTRAL_ALPHA);
  for (const material of [roots.branchMesh.material, roots.filamentMesh.material, roots.centerlines.material]) {
    assert.equal(material.transparent, true); assert.equal(material.depthWrite, false); assert.equal(material.opacity, 1);
  }
  const baseline = shape(roots);
  roots.select(selected.node.id); assertAlpha(selected, .65);
  roots.select(null); assertAlpha(selected, ROOT_NEUTRAL_ALPHA);
  roots.setHovered({ kind: 'folder', path: selected.node.folder, root: true }); assertAlpha(selected.folder, .65);
  roots.setHovered(null); assertAlpha(selected.folder, ROOT_NEUTRAL_ALPHA);
  assert.deepEqual(shape(roots), baseline); assert.equal(roots.fileBatch.geometry, geometry);
  setFrame(roots, 0);
  const touched = [...roots.files.values()].find(record => record.attention?.direction === 'increase');
  assertAlpha(touched, 1); assertAlpha(touched.folder, 1);
  roots.setOptions({ activity: false }); assertAlpha(touched, 1); assertAlpha(touched.folder, 1);
  setFrame(roots, -1); for (const record of roots.strands) assertAlpha(record, ROOT_NEUTRAL_ALPHA);
  setFrame(roots, 0); roots.setPresentationMode('organic');
  assert.deepEqual(shape(roots), original);
  assert.equal(roots.fileBatch.geometry.attributes.color.itemSize, 3);
  assert.equal(roots.folderBatch.geometry.attributes.color.itemSize, 3);
  assert.equal(roots.centerlines.geometry.attributes.color.itemSize, 3);
  assert.equal(roots.filamentMesh.material.transparent, false); assert.equal(roots.filamentMesh.material.depthWrite, true);
  assert.equal(roots.centerlines.material.opacity, .38);
  roots.dispose();
});

test('folder pathway colors use exact descendant net bytes, including moves and removal, and rewind', async () => {
  const { ROOT_ATTENTION_COLORS } = await import('./root-attention.js');
  const roots = renderer();
  roots.setModel(buildModel({ repository: { name: 'Folder totals' }, files: [
    { path: 'src/quiet', size: 5 }, { path: 'lib/b', size: 60 }, { path: 'outside/c', size: 2 },
  ], commits: [
    { sha: 'mixed-negative', files: [
      { path: 'src/a', status: 'modified', sizeBefore: 10, sizeAfter: 20 },
      { path: 'src/b', status: 'modified', sizeBefore: 100, sizeAfter: 70 },
    ] },
    { sha: 'mixed-zero', files: [
      { path: 'src/a', status: 'modified', sizeBefore: 20, sizeAfter: 30 },
      { path: 'src/b', status: 'modified', sizeBefore: 70, sizeAfter: 60 },
    ] },
    { sha: 'unrelated', files: [{ path: 'outside/c', status: 'modified', sizeBefore: 1, sizeAfter: 2 }] },
    { sha: 'delete', files: [{ path: 'src/a', status: 'removed', sizeBefore: 30 }] },
    { sha: 'move', files: [{ path: 'lib/b', previousPath: 'src/b', status: 'renamed', sizeBefore: 60, sizeAfter: 60 }] },
  ] }));
  roots.setPresentationMode('classification');
  const check = (path, delta, direction) => {
    const folder = roots.folders.get(path);
    assert.equal(folder.attention.deltaBytes, delta); assert.equal(folder.attention.direction, direction);
    assert.equal(folder.alpha, 1);
    if (folder.range) { assert.ok(folder.range.color.equals(new THREE.Color(ROOT_ATTENTION_COLORS[direction]))); assert.equal(folder.range.alpha, 1); }
  };
  setFrame(roots, 0); check('src', -20, 'decrease');
  const a = [...roots.files.values()].find(record => record.node.path === 'src/a'), b = [...roots.files.values()].find(record => record.node.path === 'src/b');
  assert.equal(a.attention.direction, 'increase'); assert.equal(b.attention.direction, 'decrease');
  setFrame(roots, 1); check('src', 0, 'same');
  setFrame(roots, 2); check('src', 0, 'same'); assert.equal(roots.folders.get('src').attention.commitIndex, 1);
  setFrame(roots, 3); check('src', -30, 'decrease'); assert.equal(roots.files.has(a.node.id), false);
  setFrame(roots, 4); check('src', -60, 'decrease'); check('lib', 60, 'increase'); check('', 0, 'same');
  const head = shape(roots);
  setFrame(roots, -1); for (const folder of roots.folders.values()) { assert.equal(folder.attention, null); assert.equal(folder.alpha, ROOT_NEUTRAL_ALPHA); }
  setFrame(roots, 4); assert.deepEqual(shape(roots), head); check('src', -60, 'decrease'); check('lib', 60, 'increase');
  roots.dispose();
});

test('top-down guides match real folder levels without entering picking or surviving a mode switch', () => {
  const roots = renderer(); roots.setModel(buildModel({ repository: { name: 'Tier guides' }, commits: [], files: [
    { path: 'a/deep/one.js', size: 10 }, { path: 'b/deep/two.js', size: 20 }, { path: 'loose.js', size: 1 },
  ] }));
  roots.setPresentationMode('classification');
  assert.equal(roots.layout.classification.orientation, 'down');
  assert.equal(roots.layout.lengthGrowth.metric, 'vertical');
  assert.deepEqual(roots.folders.get('').position.toArray(), [0, -40, 0]);
  assert.equal(roots.levelGuides.isLineSegments, true);
  assert.equal(roots.pickables.includes(roots.levelGuides), false);
  assert.deepEqual(roots.levels.map(level => level.depth), [1, 2]);
  const points = roots.levelGuides.geometry.attributes.position;
  for (const [index, level] of roots.levels.entries()) {
    assert.equal(points.getY(index * 2), level.y); assert.equal(points.getY(index * 2 + 1), level.y);
    for (const folder of roots.folders.values()) if (folder.depth === level.depth) assert.equal(folder.position.y, level.y);
  }
  const guides = roots.levelGuides; let disposed = 0;
  guides.geometry.addEventListener('dispose', () => disposed++);
  roots.setPresentationMode('organic');
  assert.equal(disposed, 1); assert.equal(guides.parent, null);
  assert.equal(roots.levelGuides, null); assert.deepEqual(roots.levels, []);
  roots.dispose();
});
