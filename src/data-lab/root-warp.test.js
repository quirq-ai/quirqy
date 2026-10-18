import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRootLayout } from './root-layout.js';
import { createRootWarpLayout } from './root-warp.js';

const model = paths => ({ repository: { name: 'warp' }, nodes: paths.map((path, index) => ({ id: `f${index}`, path })) });
const folderMap = layout => new Map(layout.folders.map(folder => [folder.path, folder]));
const geometry = layout => [...layout.folders, ...layout.nodes].map(item => ({ id: item.id, path: item.path, position: item.position, curve: item.curve }));
const near = (a, b) => Math.abs(a - b) < 1e-8;
function exactParents(layout) {
  const folders = folderMap(layout);
  assert.deepEqual(folders.get('').position, [0, -40, 0]);
  for (const item of [...layout.folders, ...layout.nodes]) {
    if (item.kind === 'folder' && !item.path) continue;
    const parent = folders.get(item.kind === 'file' ? item.folder : item.parent);
    assert.deepEqual(item.curve[0], parent.position);
    assert.deepEqual(item.curve[3], item.position);
    assert.ok(item.position[1] < parent.position[1]);
  }
}

test('baseline and missing radii preserve exact base geometry without mutating it', () => {
  const base = createRootLayout(model(['a/one.js', 'a/two.js', 'b/three.js']));
  const original = structuredClone(base);
  for (const options of [{}, { fileRadii: new Map(base.nodes.map(n => [n.id, .002])), folderRadii: new Map(base.folders.map(f => [f.path, .002])) }, { fileRadii: { f0: 0, f1: -3, f2: NaN } }]) {
    const warped = createRootWarpLayout(base, options);
    assert.deepEqual(geometry(warped), geometry(base));
    assert.deepEqual(warped.bounds, base.bounds);
    assert.equal(warped.warp.active, false);
  }
  assert.deepEqual(base, original);
});

test('one thick sibling pushes untouched neighbors away and bends their whole path', () => {
  const base = createRootLayout(model(['a.js', 'b.js', 'c.js']));
  const warped = createRootWarpLayout(base, { fileRadii: new Map([['f1', 1.024]]) });
  assert.ok(warped.nodes[0].position[0] < base.nodes[0].position[0]);
  assert.ok(warped.nodes[2].position[0] > base.nodes[2].position[0]);
  assert.notDeepEqual(warped.nodes[0].curve[1], base.nodes[0].curve[1]);
  assert.notDeepEqual(warped.nodes[2].curve[2], base.nodes[2].curve[2]);
  assert.ok(warped.nodes[1].position[1] < base.nodes[1].position[1]);
  assert.ok(warped.nodes[1].position[2] > base.nodes[1].position[2]);
  exactParents(warped);
});

test('ordinary one-to-six-touch growth visibly opens tips while physical radii remain inputs', () => {
  const base = createRootLayout(model(['left.js', 'right.js']));
  let previous = base;
  for (let touches = 1; touches <= 6; touches++) {
    const radius = .002 * 2 ** touches;
    const warped = createRootWarpLayout(base, { fileRadii: new Map([['f0', radius], ['f1', radius]]) });
    assert.ok(warped.nodes[0].position[0] < previous.nodes[0].position[0]);
    assert.ok(warped.nodes[0].position[1] < previous.nodes[0].position[1]);
    assert.ok(warped.nodes[0].position[2] > previous.nodes[0].position[2]);
    previous = warped;
  }
  assert.ok(Math.abs(previous.nodes[0].position[0] - base.nodes[0].position[0]) > 1);
  assert.ok(base.nodes.every(node => !Object.hasOwn(node, 'radius')));
});

test('balanced sibling activity mirrors geometry and keeps the trunk fixed', () => {
  const base = createRootLayout(model(['left/a.js', 'left/b.js', 'right/a.js', 'right/b.js']));
  const warped = createRootWarpLayout(base, { fileRadii: new Map(base.nodes.map(n => [n.id, .128])), folderRadii: new Map([['left', .128], ['right', .128]]) });
  const folders = folderMap(warped);
  assert.ok(near(folders.get('left').position[0], -folders.get('right').position[0]));
  assert.ok(near(folders.get('left').position[2], folders.get('right').position[2]));
  const left = warped.nodes.filter(n => n.folder === 'left'), right = warped.nodes.filter(n => n.folder === 'right').reverse();
  left.forEach((node, index) => node.curve.forEach((point, control) => {
    assert.ok(near(point[0], -right[index].curve[control][0]));
    assert.ok(near(point[1], right[index].curve[control][1]));
    assert.ok(near(point[2], right[index].curve[control][2]));
  }));
  exactParents(warped);
});

test('thick descendant footprints displace entire quiet neighboring subtrees', () => {
  const base = createRootLayout(model(['a/deep/hot.js', 'b/deep/quiet.js']));
  const warped = createRootWarpLayout(base, { fileRadii: new Map([['f0', 2.048]]), folderRadii: new Map([['a', 2.048], ['a/deep', 2.048]]) });
  const old = folderMap(base), next = folderMap(warped);
  assert.ok(next.get('b').position[0] > old.get('b').position[0]);
  const branchShift = next.get('b').position[0] - old.get('b').position[0];
  assert.ok(near(warped.nodes[1].position[0] - base.nodes[1].position[0], branchShift));
  assert.notDeepEqual(next.get('a/deep').curve, old.get('a/deep').curve);
  assert.deepEqual(warped.nodes.map(n => [n.id, n.path, n.folder]), base.nodes.map(n => [n.id, n.path, n.folder]));
  exactParents(warped);
});

test('twenty-touch radii keep every dense-file position and bound finite without collisions', () => {
  const base = createRootLayout(model(Array.from({ length: 2501 }, (_, index) => `src/file${index}.js`)));
  const radius = .002 * 2 ** 20;
  const warped = createRootWarpLayout(base, { fileRadii: new Map(base.nodes.map(node => [node.id, radius])), folderRadii: new Map([['src', radius]]) });
  assert.equal(warped.nodes.length, 2501);
  assert.equal(warped.rows.length, base.rows.length);
  assert.equal(new Set(warped.nodes.map(node => node.position.join(','))).size, 2501);
  for (const item of warped.rows) for (const point of item.curve) {
    assert.ok(point.every(Number.isFinite));
    for (let axis = 0; axis < 3; axis++) assert.ok(point[axis] >= warped.bounds.min[axis] && point[axis] <= warped.bounds.max[axis]);
  }
  assert.ok(Number.isFinite(warped.extent));
  exactParents(warped);
});

test('poses depend only on current radii and restore exactly after arbitrary seeks', () => {
  const base = createRootLayout(model(['a.js', 'b.js', 'c.js']));
  const options = { fileRadii: new Map([['f0', .064], ['f1', .008]]) };
  const first = createRootWarpLayout(base, options);
  createRootWarpLayout(base, { fileRadii: new Map([['f0', 2097.152], ['f2', 2097.152]]) });
  const second = createRootWarpLayout(base, { fileRadii: new Map([['f1', .008], ['f0', .064]]) });
  assert.deepEqual(second, first);
  assert.deepEqual(geometry(createRootWarpLayout(base)), geometry(base));
  first.nodes[0].position[0] = Infinity;
  assert.ok(Number.isFinite(createRootWarpLayout(base, options).nodes[0].position[0]));
});

test('single files curl and empty repositories remain finite without inventing topology', () => {
  const single = createRootLayout(model(['only.js']));
  const warped = createRootWarpLayout(single, { fileRadii: { f0: .032 } });
  assert.equal(warped.nodes.length, 1);
  assert.ok(warped.nodes[0].position[2] > single.nodes[0].position[2]);
  assert.notDeepEqual(warped.nodes[0].curve[2], single.nodes[0].curve[2]);
  exactParents(warped);
  const empty = createRootWarpLayout(createRootLayout(model([])), { folderRadii: { '': 2097.152 } });
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.folders.length, 1);
  assert.deepEqual(empty.folders[0].position, [0, -40, 0]);
  assert.ok(Number.isFinite(empty.extent));
});


test('a uniquely thick route has continuous tangent directions through every folder junction', () => {
  const base = createRootLayout(model(['src/core/hot.js', 'src/core/quiet.js', 'docs/readme.md']));
  const warped = createRootWarpLayout(base, { fileRadii: new Map([['f0', .512]]), folderRadii: new Map([['src', .512], ['src/core', .512]]) });
  const folders = folderMap(warped);
  const unit = vector => { const length = Math.hypot(...vector); assert.ok(length > 0); return vector.map(value => value / length); };
  for (const [path, child] of [['src', folders.get('src/core')], ['src/core', warped.nodes.find(node => node.id === 'f0')]]) {
    const folder = folders.get(path);
    const incoming = unit(folder.position.map((value, axis) => value - folder.curve[2][axis]));
    const outgoing = unit(child.curve[1].map((value, axis) => value - child.curve[0][axis]));
    incoming.forEach((value, axis) => assert.ok(near(value, outgoing[axis])));
    assert.ok(incoming[1] < 0);
  }
  const junction = folders.get('src/core');
  const hot = warped.nodes.find(node => node.id === 'f0'), quiet = warped.nodes.find(node => node.id === 'f1');
  const hotDirection = unit(hot.curve[1].map((value, axis) => value - junction.position[axis]));
  const quietDirection = unit(quiet.curve[1].map((value, axis) => value - junction.position[axis]));
  hotDirection.forEach((value, axis) => assert.ok(near(value, quietDirection[axis])));
  exactParents(warped);
});

test('equal dominant children use their centered mean direction without choosing a side', () => {
  const base = createRootLayout(model(['pkg/left.js', 'pkg/right.js']));
  const warped = createRootWarpLayout(base, { fileRadii: new Map([['f0', .128], ['f1', .128]]), folderRadii: new Map([['pkg', .128]]) });
  const folder = folderMap(warped).get('pkg');
  assert.ok(near(folder.position[0], 0));
  assert.ok(near(folder.curve[2][0], 0));
  const [left, right] = warped.nodes;
  assert.ok(near(left.curve[1][0], 0));
  assert.ok(near(right.curve[1][0], 0));
  left.curve.forEach((point, index) => {
    assert.ok(near(point[0], -right.curve[index][0]));
    assert.ok(near(point[1], right.curve[index][1]));
    assert.ok(near(point[2], right.curve[index][2]));
  });
  exactParents(warped);
});


test('alternating file touches lengthen quiet offshoots as their shared folder keeps doubling', () => {
  const base = createRootLayout(model(['src/a.js', 'src/b.js']));
  let previousA = 0, previousB = 0;
  for (let touches = 0; touches <= 10; touches++) {
    const folderRadius = .002 * 2 ** touches;
    const aRadius = .002 * 2 ** Math.ceil(touches / 2);
    const bRadius = .002 * 2 ** Math.floor(touches / 2);
    const files = new Map([['f0', aRadius], ['f1', bRadius]]);
    const folders = new Map([['src', folderRadius]]);
    const warped = createRootWarpLayout(base, { fileRadii: files, folderRadii: folders });
    const folder = folderMap(warped).get('src');
    const availableA = folder.position[1] - warped.nodes[0].position[1];
    const availableB = folder.position[1] - warped.nodes[1].position[1];
    assert.ok(availableA > previousA);
    assert.ok(availableB > previousB);
    previousA = availableA; previousB = availableB;
    assert.equal(files.get('f0'), aRadius);
    assert.equal(files.get('f1'), bRadius);
    assert.equal(folders.get('src'), folderRadius);
    exactParents(warped);
  }
});

test('a parent vastly thicker than its child reserves uncapped length beyond its body', () => {
  const base = createRootLayout(model(['src/quiet.js']));
  let previousLength = 0;
  for (const parentRadius of [.002, .004, .016, .256, 4.096, .002 * 2 ** 20]) {
    const warped = createRootWarpLayout(base, { fileRadii: new Map([['f0', .004]]), folderRadii: new Map([['src', parentRadius]]) });
    const folder = folderMap(warped).get('src'), file = warped.nodes[0];
    const available = folder.position[1] - file.position[1];
    assert.ok(available > previousLength);
    assert.ok(available >= 16 + 2 * Math.max(0, parentRadius - .002));
    previousLength = available;
    for (const item of warped.rows) for (let index = 1; index < item.curve.length; index++) {
      assert.ok(item.curve[index].every(Number.isFinite));
      assert.ok(item.curve[index][1] <= item.curve[index - 1][1]);
    }
    exactParents(warped);
  }
});

test('a very thick folder retains every quiet descendant with safe downward control points', () => {
  const base = createRootLayout(model(Array.from({ length: 2501 }, (_, index) => `src/child${index}/quiet.js`)));
  const radius = .002 * 2 ** 20;
  const warped = createRootWarpLayout(base, { folderRadii: new Map([['src', radius]]) });
  assert.equal(warped.nodes.length, 2501);
  assert.equal(warped.folders.length, 2503);
  assert.equal(new Set(warped.nodes.map(node => node.position.join(','))).size, 2501);
  const folders = folderMap(warped);
  for (const folder of warped.folders.filter(folder => folder.parent === 'src')) {
    assert.ok(folders.get('src').position[1] - folder.position[1] >= 16 + 2 * (radius - .002));
  }
  for (const item of warped.rows) for (let index = 1; index < item.curve.length; index++) {
    assert.ok(item.curve[index].every(Number.isFinite));
    assert.ok(item.curve[index][1] <= item.curve[index - 1][1], `${item.path} must not reverse above its parent`);
  }
  exactParents(warped);
});

test('a single rope vine uses its configured radius as the exact undeformed baseline', () => {
  const base = createRootLayout(model(['src/a.js', 'src/b.js', 'docs/readme.md']));
  for (const baseRadius of [.1, .14, .18]) {
    for (const options of [
      { baseRadius },
      { baseRadius, fileRadii: new Map(base.nodes.map(node => [node.id, baseRadius])), folderRadii: new Map(base.folders.map(folder => [folder.path, baseRadius])) },
      { baseRadius, fileRadii: { f0: baseRadius, f1: NaN }, folderRadii: { src: baseRadius, docs: undefined } },
    ]) {
      const warped = createRootWarpLayout(base, options);
      assert.deepEqual(geometry(warped), geometry(base));
      assert.deepEqual(warped.bounds, base.bounds);
      assert.equal(warped.warp.active, false);
      assert.equal(warped.warp.maxPressure, 0);
      exactParents(warped);
    }
  }
});

test('invalid rope baselines fall back to the compatible positive default', () => {
  const base = createRootLayout(model(['src/file.js']));
  const options = { fileRadii: { f0: .016 }, folderRadii: { src: .016 } };
  const expected = createRootWarpLayout(base, options);
  for (const baseRadius of [0, -1, NaN, Infinity, null, '']) {
    assert.deepEqual(createRootWarpLayout(base, { ...options, baseRadius }), expected);
  }
});

test('gradually widening ropes bend progressively without interpreting vine size as old growth', () => {
  const base = createRootLayout(model(['left.js', 'right.js']));
  const baseRadius = .14;
  let previous = base;
  for (const radius of [.141, .2, .3, .45, .7]) {
    const radii = new Map([['f0', radius], ['f1', radius]]);
    const warped = createRootWarpLayout(base, { baseRadius, fileRadii: radii });
    assert.ok(warped.nodes[0].position[0] < previous.nodes[0].position[0]);
    assert.ok(warped.nodes[0].position[1] < previous.nodes[0].position[1]);
    assert.ok(warped.nodes[0].position[2] > previous.nodes[0].position[2]);
    assert.ok(near(warped.nodes[0].position[0], -warped.nodes[1].position[0]));
    assert.ok(near(warped.nodes[0].position[1], warped.nodes[1].position[1]));
    assert.ok(near(warped.nodes[0].position[2], warped.nodes[1].position[2]));
    if (radius === .141) {
      const displacement = Math.hypot(...warped.nodes[0].position.map((value, axis) => value - base.nodes[0].position[axis]));
      assert.ok(displacement < .2, 'small rope growth should not jump to the old multi-touch pose');
    }
    assert.equal(radii.get('f0'), radius);
    previous = warped;
    exactParents(warped);
  }
  assert.deepEqual(geometry(createRootWarpLayout(base, { baseRadius })), geometry(base));
});

test('quiet rope descendants use the configured baseline while a thicker parent reserves length', () => {
  const base = createRootLayout(model(['src/a.js', 'src/b.js', 'docs/readme.md']));
  const baseRadius = .14;
  const folderRadii = new Map([['src', .7]]);
  const implicit = createRootWarpLayout(base, { baseRadius, folderRadii });
  const explicit = createRootWarpLayout(base, {
    baseRadius, folderRadii: new Map([['src', .7], ['docs', baseRadius]]),
    fileRadii: new Map(base.nodes.map(node => [node.id, baseRadius])),
  });
  assert.deepEqual(implicit, explicit);
  const parent = folderMap(implicit).get('src');
  for (const file of implicit.nodes.filter(node => node.folder === 'src')) {
    assert.ok(parent.position[1] - file.position[1] >= 16 + 2 * (.7 - baseRadius));
  }
  assert.deepEqual(createRootWarpLayout(base, { baseRadius, folderRadii }), implicit);
  exactParents(implicit);
});
