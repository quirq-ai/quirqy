import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRootLayout } from './root-layout.js';
import { createRootClassificationLayout } from './root-classification-layout.js';
import { createRootLengthLayout, rootCurveLength, ROOT_LENGTH_PER_TOUCH } from './root-length-layout.js';
import { buildModel, stateAt } from './model.js';
import { buildRootActivityHistory, rootActivityAt } from './root-activity.js';

const modelFor = paths => ({ repository: { name: 'length' }, nodes: paths.map((path, index) => ({ id: `f${index}`, path })) });
const geometry = layout => layout.rows.map(row => ({ kind: row.kind, id: row.id, path: row.path, position: row.position, curve: row.curve }));
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
const curvePoint = (curve, t) => {
  const u = 1 - t;
  return [0, 1, 2].map(axis => u ** 3 * curve[0][axis] + 3 * u * u * t * curve[1][axis]
    + 3 * u * t * t * curve[2][axis] + t ** 3 * curve[3][axis]);
};
// Independent chord accumulation verifies measured length, not just metadata or
// the same integration routine used to calculate the growth factor.
const polylineLength = (curve, steps = 12000) => {
  let previous = curve[0], length = 0;
  for (let index = 1; index <= steps; index++) {
    const point = curvePoint(curve, index / steps);
    length += Math.hypot(...point.map((value, axis) => value - previous[axis]));
    previous = point;
  }
  return length;
};
const assertConnected = layout => {
  const folders = new Map(layout.folders.map(folder => [folder.path, folder]));
  assert.deepEqual(folders.get('').position, [0, layout.groundY, 0]);
  for (const row of layout.rows) {
    if (row.kind === 'folder' && !row.path) continue;
    const parent = folders.get(row.kind === 'file' ? row.folder : row.parent);
    assert.deepEqual(row.curve[0], parent.position);
    assert.deepEqual(row.curve[3], row.position);
  }
};
const assertEnclosed = (layout, padding = 2) => {
  for (const row of layout.rows) for (const point of row.curve) {
    assert.ok(point.every(Number.isFinite));
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(point[axis] - padding >= layout.bounds.min[axis] - 1e-9);
      assert.ok(point[axis] + padding <= layout.bounds.max[axis] + 1e-9);
    }
  }
  const { radiusX, radiusZ } = layout.base;
  for (const x of [layout.bounds.min[0], layout.bounds.max[0]]) for (const z of [layout.bounds.min[2], layout.bounds.max[2]]) {
    assert.ok((x / radiusX) ** 2 + (z / radiusZ) ** 2 <= 1 + 1e-10);
  }
};

test('cubic length measures curves, straight lines and degenerate edges accurately', () => {
  near(rootCurveLength([[0, 0, 0], [1, 2, 2], [2, 4, 4], [3, 6, 6]]), 9);
  near(rootCurveLength(Array.from({ length: 4 }, () => [5, -40, 8])), 0);
  const curve = [[0, 0, 0], [8, -3, 12], [-6, -11, -8], [14, -16, 5]];
  near(rootCurveLength(curve), polylineLength(curve, 30000), 1e-6);
  assert.ok(rootCurveLength(curve) > Math.hypot(14, -16, 5));
});

test('baseline is unchanged and each touch adds exactly six measured world units', () => {
  const base = createRootLayout(modelFor(['left.js', 'center.js', 'right.js']));
  const original = structuredClone(base);
  const baseline = createRootLengthLayout(base);
  assert.deepEqual(geometry(baseline), geometry(base));
  assert.deepEqual(baseline.bounds, base.bounds);
  assert.deepEqual(baseline.base, base.base);
  assert.equal(baseline.lengthGrowth.active, false);
  assert.equal(baseline.lengthGrowth.metric, 'arc');
  const id = base.nodes[0].id;
  const length = polylineLength(base.nodes[0].curve);
  for (const count of [1, 2, 7, 30]) {
    const grown = createRootLengthLayout(base, { fileTouches: new Map([[id, count]]) });
    const file = grown.nodes[0];
    near(polylineLength(file.curve) - length, count * 6, 2e-5);
    near(rootCurveLength(file.curve) - rootCurveLength(base.nodes[0].curve), count * ROOT_LENGTH_PER_TOUCH);
    assert.equal(file.addedLength, count * 6);
    assert.equal(file.touchCount, count);
    assert.equal(grown.lengthGrowth.totalAddedLength, count * 6);
    assertConnected(grown);
    assertEnclosed(grown);
  }
  assert.deepEqual(base, original);
});

test('folder junctions and quiet subtrees remain fixed while touched files keep their initial direction', () => {
  const base = createRootLayout(modelFor(['src/deep/hot.js', 'src/deep/quiet.js', 'other/quiet.js']));
  const grown = createRootLengthLayout(base, { fileTouches: { f0: 12 } });
  assert.deepEqual(grown.folders, base.folders);
  for (const id of ['f1', 'f2']) {
    const old = base.nodes.find(node => node.id === id), current = grown.nodes.find(node => node.id === id);
    assert.deepEqual(current.position, old.position);
    assert.deepEqual(current.curve, old.curve);
  }
  const before = base.nodes.find(node => node.id === 'f0'), after = grown.nodes.find(node => node.id === 'f0');
  const normalize = vector => { const length = Math.hypot(...vector); return vector.map(value => value / length); };
  for (const control of [1, 2, 3]) {
    const a = normalize(before.curve[control].map((value, axis) => value - before.curve[0][axis]));
    const b = normalize(after.curve[control].map((value, axis) => value - after.curve[0][axis]));
    a.forEach((value, axis) => near(b[axis], value));
  }
  assertConnected(grown);
});

test('absolute touch counts give identical repeated poses and exact backward seeks', () => {
  const base = createRootLayout(modelFor(['a.js', 'b.js', 'c.js']));
  const options = { fileTouches: new Map([['f0', 2], ['f1', 5]]) };
  const first = createRootLengthLayout(base, options);
  createRootLengthLayout(base, { fileTouches: { f0: 300, f2: 800 } });
  const second = createRootLengthLayout(base, { fileTouches: new Map([['f1', 5], ['f0', 2]]) });
  assert.deepEqual(second, first);
  assert.deepEqual(geometry(createRootLengthLayout(base)), geometry(base));
  first.nodes[0].curve[1][0] = Infinity;
  assert.ok(createRootLengthLayout(base, options).nodes[0].curve[1].every(Number.isFinite));
});

const atCommit = (model, history, index) => {
  const frame = stateAt(model, index);
  const base = createRootLayout(model, { activeIds: frame.activeIds, paths: new Map(frame.files.map(file => [file.id, file.path])) });
  return createRootLengthLayout(base, { fileTouches: rootActivityAt(history, index).fileTouches });
};

test('cross-folder renames retain lifetime growth and future commits cannot affect an earlier pose', () => {
  const data = {
    repository: { name: 'rename' }, files: [{ path: 'lib/file.js' }, { path: 'quiet.js' }],
    commits: [
      { sha: 'first', files: [{ path: 'src/file.js', status: 'modified' }] },
      { sha: 'move', files: [{ path: 'lib/file.js', previousPath: 'src/file.js', status: 'renamed' }] },
      { sha: 'again', files: [{ path: 'lib/file.js', status: 'modified' }] },
    ],
  };
  const model = buildModel(data), history = buildRootActivityHistory(model);
  const before = atCommit(model, history, 0), moved = atCommit(model, history, 1), latest = atCommit(model, history, 2);
  const file = layout => layout.nodes.find(node => node.path.endsWith('/file.js'));
  assert.equal(file(before).folder, 'src');
  assert.equal(file(moved).folder, 'lib');
  assert.equal(file(before).id, file(moved).id);
  assert.deepEqual([file(before).addedLength, file(moved).addedLength, file(latest).addedLength], [6, 12, 18]);
  const shorter = { ...history, commitCount: 2, frames: history.frames.slice(0, 2) };
  assert.deepEqual(atCommit(model, shorter, 1), moved);
  assertConnected(moved);
});

test('delete and re-add at one path starts a new file identity with its own growth', () => {
  const model = buildModel({
    repository: { name: 'readd' }, files: [{ path: 'src/file.js' }],
    commits: [
      { sha: 'edit', files: [{ path: 'src/file.js', status: 'modified' }] },
      { sha: 'remove', files: [{ path: 'src/file.js', status: 'removed' }] },
      { sha: 'restore', files: [{ path: 'src/file.js', status: 'added' }] },
    ],
  });
  const history = buildRootActivityHistory(model);
  const before = atCommit(model, history, 0), absent = atCommit(model, history, 1), restored = atCommit(model, history, 2);
  assert.equal(absent.nodes.length, 0);
  assert.notEqual(before.nodes[0].id, restored.nodes[0].id);
  assert.equal(restored.nodes[0].addedLength, 6);
  assert.equal(restored.nodes[0].touchCount, 1);
});

test('zero increment, missing and invalid counts stay finite and configurable increments stay exact', () => {
  const base = createRootLayout(modelFor(['a.js', 'b.js', 'c.js']));
  const zero = createRootLengthLayout(base, { fileTouches: { f0: 8 }, lengthPerTouch: 0 });
  assert.deepEqual(geometry(zero), geometry(base));
  assert.equal(zero.lengthGrowth.active, false);
  const invalid = createRootLengthLayout(base, { fileTouches: { f0: Infinity, f1: -3, f2: NaN }, lengthPerTouch: NaN, padding: -1 });
  assert.deepEqual(geometry(invalid), geometry(base));
  assert.equal(invalid.lengthGrowth.lengthPerTouch, 6);
  const custom = createRootLengthLayout(base, { fileTouches: { f0: 2.9 }, lengthPerTouch: 3.5, padding: 9 });
  assert.equal(custom.nodes[0].touchCount, 2);
  near(rootCurveLength(custom.nodes[0].curve) - rootCurveLength(base.nodes[0].curve), 7);
  assertEnclosed(custom, 9);
});

test('large histories retain every file and an enclosing base without growth caps', () => {
  const base = createRootLayout(modelFor(Array.from({ length: 2501 }, (_, index) => `src/group${index % 37}/file${index}.js`)));
  const counts = new Map(base.nodes.map((node, index) => [node.id, index % 51]));
  counts.set('f0', 1_000_000);
  const grown = createRootLengthLayout(base, { fileTouches: counts });
  assert.equal(grown.nodes.length, 2501);
  assert.equal(grown.rows.length, base.rows.length);
  assert.equal(grown.nodes.find(node => node.id === 'f0').addedLength, base.proportions.lengthPerTouch * 1_000_000);
  assert.ok(Number.isFinite(grown.extent));
  assertConnected(grown);
  assertEnclosed(grown);
});

test('empty and coincident synthetic file edges remain finite with a fixed parent', () => {
  const empty = createRootLengthLayout(createRootLayout(modelFor([])));
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.lengthGrowth.totalAddedLength, 0);
  assertEnclosed(empty);
  const base = createRootLayout(modelFor(['one.js']));
  const file = base.nodes[0], root = base.folders[0];
  file.position = [...root.position];
  file.curve = Array.from({ length: 4 }, () => [...root.position]); file.points = file.curve;
  const grown = createRootLengthLayout(base, { fileTouches: { f0: 3 } });
  near(rootCurveLength(grown.nodes[0].curve), 18);
  assertConnected(grown);
  assertEnclosed(grown);
});


test('actual xo-space touches add the width-scaled arc length while xo preserves the six-unit increment', () => {
  const results = [];
  for (const name of ['xo', 'xo-space']) {
    const data = JSON.parse(readFileSync(new URL(`./examples/${name}.json`, import.meta.url), 'utf8'));
    const model = buildModel(data), frame = stateAt(model, model.commits.length - 1);
    const base = createRootLayout(model, { activeIds: frame.activeIds, paths: new Map(frame.files.map(file => [file.id, file.path])) });
    const id = base.nodes[0].id;
    const grown = createRootLengthLayout(base, { fileTouches: new Map([[id, 3]]) });
    const expected = 3 * base.proportions.lengthPerTouch;
    near(polylineLength(grown.nodes[0].curve) - polylineLength(base.nodes[0].curve), expected, 2e-5);
    assert.equal(grown.nodes[0].addedLength, expected);
    assert.equal(grown.lengthGrowth.lengthPerTouch, base.proportions.lengthPerTouch);
    assert.deepEqual(grown.folders, base.folders);
    assert.deepEqual(grown.nodes[1].curve, base.nodes[1].curve);
    assertConnected(grown);
    assertEnclosed(grown);
    results.push(grown.lengthGrowth.lengthPerTouch);
  }
  assert.deepEqual(results, [6, 23.79]);
});

test('explicit growth increments override width proportions and invalid overrides use the repository default', () => {
  const base = createRootLayout(modelFor(['a.js', 'b.js']), { repositoryWidth: 640 });
  assert.equal(base.proportions.lengthPerTouch, 24);
  for (const increment of [0, 3.5, 6, 42]) {
    const grown = createRootLengthLayout(base, { fileTouches: { f0: 2 }, lengthPerTouch: increment });
    near(rootCurveLength(grown.nodes[0].curve) - rootCurveLength(base.nodes[0].curve), 2 * increment);
    assert.equal(grown.lengthGrowth.lengthPerTouch, increment);
  }
  for (const increment of [undefined, NaN, -3, Infinity]) {
    const grown = createRootLengthLayout(base, { fileTouches: { f0: 2 }, lengthPerTouch: increment });
    assert.equal(grown.nodes[0].addedLength, 48);
  }
  const legacy = { ...base };
  delete legacy.proportions;
  assert.equal(createRootLengthLayout(legacy, { fileTouches: { f0: 1 } }).nodes[0].addedLength, 6);
});

test('one pinned repository width gives every historical membership the same per-touch growth', () => {
  const model = modelFor(Array.from({ length: 220 }, (_, index) => `src/group${index % 7}/file${index}.js`));
  const head = createRootLayout(model), repositoryWidth = head.footprint.width;
  const id = model.nodes[0].id;
  const early = createRootLayout(model, { activeIds: [id], repositoryWidth });
  const first = createRootLengthLayout(early, { fileTouches: new Map([[id, 2]]) });
  const latest = createRootLengthLayout(head, { fileTouches: new Map([[id, 2]]) });
  assert.equal(first.nodes[0].addedLength, latest.nodes.find(node => node.id === id).addedLength);
  assert.equal(first.lengthGrowth.lengthPerTouch, head.proportions.lengthPerTouch);
  assert.ok(first.nodes[0].addedLength > 12);
  assert.deepEqual(createRootLengthLayout(early, { fileTouches: { [id]: 2 } }), first);
});

test('classification grows exact vertical distance downward while every assigned label row remains fixed', () => {
  const base = createRootClassificationLayout(createRootLayout(modelFor(['left/a.js', 'left/b.js', 'right/a.js', 'right/b.js'])));
  const original = structuredClone(base);
  for (const count of [1, 3, 17]) {
    const counts = new Map(base.nodes.map(node => [node.id, count]));
    const grown = createRootLengthLayout(base, { fileTouches: counts });
    assert.equal(grown.lengthGrowth.metric, 'vertical');
    assert.deepEqual(grown.folders, base.folders);
    for (let index = 0; index < base.nodes.length; index++) {
      const before = base.nodes[index], after = grown.nodes[index];
      near(before.position[1] - after.position[1], count * 6);
      near(after.length, polylineLength(after.curve), 2e-5);
      assert.equal(after.actualArcLength, after.length);
      near(after.addedArcLength, polylineLength(after.curve) - polylineLength(before.curve), 2e-5);
      assert.deepEqual([after.position[0], after.position[2]], [before.position[0], before.position[2]]);
      assert.deepEqual(after.curve.map(point => [point[0], point[2]]), before.curve.map(point => [point[0], point[2]]));
      assert.deepEqual(after.curve.slice(0, 2), before.curve.slice(0, 2));
      assert.ok(before.position[1] - after.position[1] > 0);
      assert.deepEqual(after.rowSpan, before.rowSpan);
      const displacement = after.position[1] - before.position[1];
      near(after.labelBounds.min[1] - before.labelBounds.min[1], displacement);
      near(after.labelBounds.max[1] - before.labelBounds.max[1], displacement);
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(after.labelBounds.min[axis] >= grown.bounds.min[axis]);
        assert.ok(after.labelBounds.max[axis] <= grown.bounds.max[axis]);
      }
    }
    assertConnected(grown);
    assertEnclosed(grown);
  }
  assert.deepEqual(base, original);
});

test('classification leaves quiet geometry unchanged and absolute counts rewind without pose history', () => {
  const base = createRootClassificationLayout(createRootLayout(modelFor(['src/hot.js', 'src/quiet.js', 'other/file.js'])));
  const first = createRootLengthLayout(base, { fileTouches: { f0: 2 } });
  createRootLengthLayout(base, { fileTouches: { f0: 1000, f1: 30 } });
  const repeated = createRootLengthLayout(base, { fileTouches: new Map([['f0', 2]]) });
  assert.deepEqual(repeated, first);
  for (const id of ['f1', 'f2']) {
    const before = base.nodes.find(node => node.id === id), after = first.nodes.find(node => node.id === id);
    assert.deepEqual(after.position, before.position);
    assert.deepEqual(after.curve, before.curve);
    assert.deepEqual(after.labelBounds, before.labelBounds);
  }
  assert.deepEqual(geometry(createRootLengthLayout(base)), geometry(base));
});

test('classification rename growth keeps cumulative identity and the new exact attachment', () => {
  const model = buildModel({ repository: { name: 'rename' }, files: [{ path: 'lib/file.js' }, { path: 'quiet.js' }], commits: [
    { sha: 'edit', files: [{ path: 'src/file.js', status: 'modified' }] },
    { sha: 'move', files: [{ path: 'lib/file.js', previousPath: 'src/file.js', status: 'renamed' }] },
  ] });
  const history = buildRootActivityHistory(model), results = [];
  for (const index of [0, 1]) {
    const frame = stateAt(model, index);
    const base = createRootClassificationLayout(createRootLayout(model, { activeIds: frame.activeIds, paths: new Map(frame.files.map(file => [file.id, file.path])) }));
    const grown = createRootLengthLayout(base, { fileTouches: rootActivityAt(history, index).fileTouches });
    const file = grown.nodes.find(node => node.path.endsWith('/file.js'));
    const initial = base.nodes.find(node => node.id === file.id);
    results.push(file);
    near(initial.position[1] - file.position[1], 6 * (index + 1));
    near(file.actualArcLength, polylineLength(file.curve), 2e-5);
    assertConnected(grown);
  }
  assert.equal(results[0].id, results[1].id);
  assert.deepEqual(results.map(node => node.folder), ['src', 'lib']);
  assert.deepEqual(results.map(node => node.addedLength), [6, 12]);
});

test('calibrated classification row spacing stays exact under large downward growth', () => {
  const base = createRootClassificationLayout(createRootLayout(modelFor(['left/a.js', 'left/b.js', 'right/a.js', 'right/b.js'])), { lanePitch: 36, tierPitch: 45 });
  const grown = createRootLengthLayout(base, { fileTouches: { f0: 40, f2: 30 } });
  assert.equal(grown.readability.rowPitch, 36);
  assert.equal(grown.classification.rowPitch, 36);
  for (let index = 0; index < base.nodes.length; index++) {
    const before = base.nodes[index], after = grown.nodes[index];
    assert.equal(after.position[1], base.groundY - after.depth * 45 - after.addedLength);
    assert.deepEqual([after.position[0], after.position[2]], [before.position[0], before.position[2]]);
    near(before.position[1] - after.position[1], after.touchCount * 6);
    near(after.actualArcLength, polylineLength(after.curve), 2e-5);
    assert.equal(after.curve[3][0], after.curve[2][0]);
  }
  assertConnected(grown);
  assertEnclosed(grown);
});

test('equal classification touches give equal vertical extension for different bytes and branch shapes', () => {
  const model = modelFor(['left/top.js', 'left/middle.js', 'left/bottom.js', 'right/deep/file.js', 'root.js']);
  const sizes = [0, 12, 16384, 24 * 1024 * 1024, null];
  model.nodes.forEach((node, index) => { node.size = sizes[index]; });
  const base = createRootClassificationLayout(createRootLayout(model), { lanePitch: 36, tierPitch: 45 });
  assert.ok(new Set(base.nodes.map(node => rootCurveLength(node.curve).toFixed(3))).size > 2);
  const before = structuredClone(base), counts = new Map(base.nodes.map(node => [node.id, 4]));
  const grown = createRootLengthLayout(base, { fileTouches: counts, lengthPerTouch: 7.5 });
  const measuredArcIncreases = [];
  for (let index = 0; index < base.nodes.length; index++) {
    const initial = base.nodes[index], file = grown.nodes[index];
    assert.equal(file.addedLength, 30);
    near(initial.position[1] - file.position[1], 30);
    near(initial.curve[2][1] - file.curve[2][1], 30);
    assert.deepEqual(file.curve.slice(0, 2), initial.curve.slice(0, 2));
    assert.deepEqual(file.curve.map(point => [point[0], point[2]]), initial.curve.map(point => [point[0], point[2]]));
    near(file.actualArcLength, polylineLength(file.curve), 2e-5);
    near(file.addedArcLength, file.actualArcLength - file.baseLength);
    measuredArcIncreases.push(file.addedArcLength);
  }
  assert.ok(Math.max(...measuredArcIncreases) - Math.min(...measuredArcIncreases) > 1, 'arc distance should reflect the different branch slopes');
  assert.equal(grown.lengthGrowth.totalAddedLength, 150);
  assert.deepEqual(base, before);
  const changedSizes = { ...model, nodes: model.nodes.map(node => ({ ...node, size: 1_000_000_000 })) };
  const other = createRootLengthLayout(createRootClassificationLayout(createRootLayout(changedSizes), { lanePitch: 36, tierPitch: 45 }), { fileTouches: counts, lengthPerTouch: 7.5 });
  assert.deepEqual(geometry(other), geometry(grown));
  assertConnected(grown);
  assertEnclosed(grown);
});

test('classification vertical extension respects zero, custom and inherited calibrated increments', () => {
  const base = createRootClassificationLayout(createRootLayout(modelFor(['a.js', 'b.js']), { repositoryWidth: 640 }));
  for (const increment of [0, 3.5, undefined, NaN]) {
    const grown = createRootLengthLayout(base, { fileTouches: { f0: 3 }, lengthPerTouch: increment });
    const expected = Number.isFinite(increment) ? increment : 24;
    const file = grown.nodes.find(node => node.id === 'f0'), initial = base.nodes.find(node => node.id === 'f0');
    assert.equal(file.addedLength, 3 * expected);
    near(initial.position[1] - file.position[1], 3 * expected);
    near(file.actualArcLength, rootCurveLength(file.curve));
    assert.equal(grown.lengthGrowth.metric, 'vertical');
  }
});
