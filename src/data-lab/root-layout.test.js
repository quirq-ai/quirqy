import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRootLayout, ROOT_TIER_HEIGHT } from './root-layout.js';
import { buildModel, stateAt } from './model.js';

const make = paths => ({ repository: { name: 'roots' }, nodes: paths.map((path, index) => ({ id: `file:${index}`, path, size: index * 17 })) });
const mapFolders = layout => new Map(layout.folders.map(folder => [folder.path, folder]));
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

function assertExactEdges(layout) {
  const folders = mapFolders(layout);
  assert.deepEqual(folders.get('').position, [0, layout.groundY, 0]);
  for (const folder of layout.folders) {
    if (folder.parent === null) continue;
    assert.equal(folder.parent, parentOf(folder.path));
    assert.deepEqual(folder.curve[0], folders.get(folder.parent).position);
    assert.deepEqual(folder.curve[3], folder.position);
    if (folder.visible) assert.ok(folder.position[1] < folders.get(folder.parent).position[1]);
  }
  for (const node of layout.nodes) {
    assert.equal(node.folder, parentOf(node.path));
    assert.equal(node.parentPath, node.folder);
    assert.deepEqual(node.curve[0], folders.get(node.folder).position);
    assert.deepEqual(node.curve[3], node.position);
    if (node.visible) assert.ok(node.position[1] < folders.get(node.folder).position[1]);
  }
}

test('roots preserve each exact immediate parent and count actual descendants', () => {
  const layout = createRootLayout(make(['README.md', 'src/index.js', 'src/ui/button.js', 'src/ui/menu.js', 'docs/start.md']));
  assert.deepEqual(layout.folders.map(folder => folder.path), ['', 'docs', 'src', 'src/ui']);
  const folders = mapFolders(layout);
  assert.equal(folders.get('').count, 5);
  assert.equal(folders.get('src').count, 3);
  assert.equal(folders.get('src/ui').count, 2);
  assert.deepEqual(folders.get('src').children, ['src/ui']);
  assert.deepEqual(folders.get('src').directFiles, ['file:1']);
  assertExactEdges(layout);
});

test('roots retain more than three directory levels without collapsing a deep chain', () => {
  const path = `${Array.from({ length: 18 }, (_, index) => `level${index}`).join('/')}/file.js`;
  const model = make([path]);
  const layout = createRootLayout(model);
  assert.equal(layout.folders.length, 19);
  assert.equal(layout.nodes[0].depth, 19);
  assert.equal(layout.maxDepth, 19);
  assert.equal(new Set(layout.folders.map(folder => folder.position[1])).size, 19);
  assertExactEdges(layout);
});

test('roots render every loaded active file beyond canopy caps with no invented groups', () => {
  const paths = Array.from({ length: 2500 }, (_, index) => `packages/p${index % 83}/src/file${index}.js`);
  const model = make(paths);
  const layout = createRootLayout(model);
  assert.equal(layout.nodes.length, 2500);
  assert.equal(new Set(layout.nodes.map(node => node.id)).size, 2500);
  assert.equal(layout.folders.length, 168);
  assert.equal(layout.folders[0].count, 2500);
  assertExactEdges(layout);
});

test('current historical paths reattach renamed files and prune empty old folders', () => {
  const model = make(['new/sub/file.js', 'deleted/old.js', 'keep.js']);
  const previous = createRootLayout(model, { activeIds: ['file:0', 'file:1', 'file:2'], paths: new Map([['file:0', 'old/deep/file.js']]) });
  const current = createRootLayout(model, { activeIds: new Set(['file:0', 'file:2']), paths: { 'file:0': 'new/sub/file.js' } });
  assert.ok(mapFolders(previous).has('old/deep'));
  assert.ok(!mapFolders(previous).has('new'));
  assert.ok(!mapFolders(current).has('old'));
  assert.ok(!mapFolders(current).has('deleted'));
  assert.equal(current.nodes.find(node => node.id === 'file:0').folder, 'new/sub');
  assertExactEdges(previous);
  assertExactEdges(current);
});

test('deleted and re-added paths preserve their distinct file identities through model replay', () => {
  const model = buildModel({
    repository: { name: 'lifecycle' },
    files: [{ path: 'src/file.js', size: 43 }],
    commits: [
      { sha: 'remove', files: [{ path: 'src/file.js', status: 'removed' }] },
      { sha: 'restore', files: [{ path: 'src/file.js', status: 'added' }] },
    ],
  });
  const layoutAt = index => {
    const frame = stateAt(model, index);
    return createRootLayout(model, { activeIds: frame.activeIds, paths: new Map(frame.files.map(file => [file.id, file.path])) });
  };
  const before = layoutAt(-1), absent = layoutAt(0), after = layoutAt(1);
  assert.equal(before.fileCount, 1);
  assert.equal(absent.fileCount, 0);
  assert.deepEqual(absent.folders.map(folder => folder.path), ['']);
  assert.equal(after.fileCount, 1);
  assert.notEqual(before.nodes[0].id, after.nodes[0].id);
  assert.equal(before.nodes[0].path, after.nodes[0].path);
});

test('root geometry is deterministic across input ordering, active ID order and path-map type', () => {
  const model = make(['z/file.js', 'src/a.js', 'src/ui/b.js', 'README.md', 'a/nested/file.js']);
  const ids = model.nodes.map(node => node.id);
  const paths = model.nodes.map(node => [node.id, node.path]);
  const a = createRootLayout(model, { activeIds: ids, paths: Object.fromEntries(paths) });
  const b = createRootLayout({ ...model, nodes: [...model.nodes].reverse() }, { activeIds: [...ids].reverse(), paths: new Map([...paths].reverse()) });
  assert.deepEqual(a, b);
});

test('every actual entry is fully expanded and depth sets a consistent vertical tier', () => {
  const model = make(['README.md', 'src/index.js', 'src/ui/button.js', 'src/ui/menu.js', 'docs/start.md']);
  const layout = createRootLayout(model);
  assert.equal(layout.rows.length, layout.nodes.length + layout.folders.length);
  assert.ok(layout.rows.every(row => row.visible && row.kind !== 'pager'));
  assert.equal(layout.visibleFileCount, 5);
  assert.equal(layout.visibleFolderCount, 4);
  for (const row of layout.rows) {
    assert.equal(row.position[1], layout.groundY - row.depth * ROOT_TIER_HEIGHT);
    assert.equal(row.curve.length, 4);
  }
  assertExactEdges(layout);
});

test('repository root is the canopy trunk anchor without an additional underground root', () => {
  const layout = createRootLayout(make(['a.js', 'b.js']), { groundY: -12 });
  const root = layout.folders[0];
  assert.equal(root.path, '');
  assert.equal(root.depth, 0);
  assert.equal(root.parent, null);
  assert.deepEqual(root.position, [0, -12, 0]);
  assert.ok(root.curve.every(point => point.every((value, axis) => value === root.position[axis])));
  assert.equal(layout.rows.filter(row => row.kind === 'folder' && row.depth === 0).length, 1);
});

test('equivalent sibling subtrees have symmetric spacing and real shallow depth', () => {
  const layout = createRootLayout(make(['left/a.js', 'left/b.js', 'right/a.js', 'right/b.js']));
  const folders = mapFolders(layout);
  const left = folders.get('left'), right = folders.get('right');
  assert.equal(left.position[0], -right.position[0]);
  assert.equal(left.position[1], right.position[1]);
  assert.equal(left.position[2], right.position[2]);
  assert.ok(left.position[2] > 0);
  const leftFiles = layout.nodes.filter(node => node.folder === 'left');
  const rightFiles = layout.nodes.filter(node => node.folder === 'right').reverse();
  leftFiles.forEach((node, index) => {
    assert.ok(Math.abs(node.position[0] + rightFiles[index].position[0]) < 1e-10);
    assert.ok(Math.abs(node.position[2] - rightFiles[index].position[2]) < 1e-10);
  });
  assert.ok(layout.bounds.min[0] === -layout.bounds.max[0]);
});

test('small sibling groups form a horizontal balanced arch instead of a vertical or radial outline', () => {
  const layout = createRootLayout(make(['a.js', 'b.js', 'c.js', 'd.js', 'e.js']));
  const positions = layout.nodes.map(node => node.position);
  for (let index = 0; index < positions.length; index++) {
    const mirror = positions[positions.length - index - 1];
    assert.ok(Math.abs(positions[index][0] + mirror[0]) < 1e-10);
    assert.ok(Math.abs(positions[index][2] - mirror[2]) < 1e-10);
    assert.equal(positions[index][1], -40 - ROOT_TIER_HEIGHT);
  }
  assert.ok(positions[2][2] > positions[0][2]);
  assert.ok(positions[4][0] > positions[3][0]);
});

test('nine and ten siblings remain one horizontal fan with shallow mirrored depth', () => {
  for (const count of [9, 10]) {
    const layout = createRootLayout(make(Array.from({ length: count }, (_, index) => `file${String(index).padStart(2, '0')}.js`)));
    assert.ok(layout.nodes.every(node => node.visible));
    assert.equal(new Set(layout.nodes.map(node => node.position[0])).size, count);
    assert.ok(Math.max(...layout.nodes.map(node => node.position[2])) - Math.min(...layout.nodes.map(node => node.position[2])) <= 3 + 1e-10);
    layout.nodes.forEach((node, index) => {
      const mirror = layout.nodes[count - index - 1];
      assert.ok(Math.abs(node.position[0] + mirror.position[0]) < 1e-10);
      assert.ok(Math.abs(node.position[2] - mirror.position[2]) < 1e-10);
      if (index) assert.ok(node.position[0] > layout.nodes[index - 1].position[0]);
    });
  }
});

test('all 2500 sibling files retain readable slots in an expanded symmetric 3D grid', () => {
  const layout = createRootLayout(make(Array.from({ length: 2500 }, (_, index) => `file${String(index).padStart(4, '0')}.js`)));
  assert.equal(layout.nodes.length, 2500);
  assert.equal(layout.rows.length, 2501);
  assert.ok(layout.nodes.every(node => node.visible));
  assert.equal(new Set(layout.nodes.map(node => node.position.join(','))).size, 2500);
  assert.ok(layout.footprint.width > 160);
  assert.ok(layout.footprint.depth > 100);
  assert.equal(layout.footprint.scaleX, 1);
  assert.equal(layout.footprint.scaleZ, 1);
  assert.ok(layout.readability.adaptive);
  assert.ok(layout.readability.minFileWidth >= 8);
  assert.ok(layout.readability.minFileDepth >= 6);
  const key = (x, z) => `${Math.round(x * 1e7)},${Math.round(z * 1e7)}`;
  const positions = new Set(layout.nodes.map(node => key(node.position[0], node.position[2])));
  for (const node of layout.nodes) assert.ok(positions.has(key(-node.position[0], node.position[2])));
  assert.ok(new Set(layout.nodes.map(node => node.position[2])).size > 1);
  assertExactEdges(layout);
});

test('dense mixed subtrees retain distinct positions and non-overlapping sibling envelopes', () => {
  const model = make(Array.from({ length: 2500 }, (_, index) => `packages/p${index % 83}/src/file${index}.js`));
  const layout = createRootLayout(model);
  const byDepth = new Map();
  for (const item of [...layout.folders, ...layout.nodes]) {
    if (!byDepth.has(item.depth)) byDepth.set(item.depth, new Set());
    const points = byDepth.get(item.depth);
    const key = item.position.map(value => value.toFixed(8)).join(',');
    assert.ok(!points.has(key), `${item.path} overlaps another entry at its hierarchy level`);
    points.add(key);
  }
  assertExactEdges(layout);
});

test('empty, single-file and pinned-head default memberships produce finite bounded geometry', () => {
  for (const model of [make([]), make(['README.md']), make(['src/deep/file.js'])]) {
    const layout = createRootLayout(model, { groundY: -12 });
    assert.equal(layout.groundY, -12);
    assert.ok(Number.isFinite(layout.extent) && layout.extent > 0);
    assert.ok(layout.center.every(Number.isFinite));
    for (const item of [...layout.folders, ...layout.nodes]) for (const point of item.curve) {
      assert.ok(point.every(Number.isFinite));
      assert.ok(point[1] <= -12);
      for (let axis = 0; axis < 3; axis++) assert.ok(point[axis] >= layout.bounds.min[axis] && point[axis] <= layout.bounds.max[axis]);
    }
    assertExactEdges(layout);
  }
  const model = make(['head.js', 'removed.js']);
  model.nodes[1].existsAtHead = false;
  assert.deepEqual(createRootLayout(model).nodes.map(node => node.path), ['head.js']);
});


function assertBaseEncloses(layout) {
  const { radiusX, radiusZ } = layout.base;
  assert.ok(Number.isFinite(radiusX) && Number.isFinite(radiusZ));
  const inBase = point => (point[0] / radiusX) ** 2 + (point[2] / radiusZ) ** 2 <= 1 + 1e-10;
  for (const x of [layout.bounds.min[0], layout.bounds.max[0]]) {
    for (const z of [layout.bounds.min[2], layout.bounds.max[2]]) assert.ok(inBase([x, 0, z]));
  }
  for (const row of layout.rows) for (const point of row.curve) assert.ok(inBase(point), `${row.path} lies outside the ground base`);
}

test('ground capacity starts at 64 files and grows its minimum area in proportion to visible file count', () => {
  let previousArea = 0;
  for (const count of [0, 1, 64, 160, 161, 754, 2501]) {
    const layout = createRootLayout(make(Array.from({ length: count }, (_, index) => `file${String(index).padStart(4, '0')}.js`)));
    const scale = Math.sqrt(Math.max(1, count / 64));
    assert.equal(layout.base.fileCount, count);
    assert.equal(layout.base.capacityScale, scale);
    assert.equal(layout.base.countRadiusX, 50 * scale);
    assert.equal(layout.base.countRadiusZ, 30 * scale);
    const capacityArea = Math.PI * layout.base.countRadiusX * layout.base.countRadiusZ;
    assert.ok(capacityArea >= previousArea);
    previousArea = capacityArea;
    assert.ok(layout.base.radiusX >= layout.base.countRadiusX);
    assert.ok(layout.base.radiusZ >= layout.base.countRadiusZ);
    assertBaseEncloses(layout);
    assert.equal(layout.nodes.length, count);
  }
});

test('large repository packing is deterministic and basename slots retain local space', () => {
  const paths = Array.from({ length: 400 }, (_, index) => `group${index % 7}/child${index % 3}/${'long'.repeat(index % 5)}file${index}.js`);
  const model = make(paths);
  const forward = createRootLayout(model);
  const reverse = createRootLayout({ ...model, nodes: [...model.nodes].reverse() });
  assert.deepEqual(forward, reverse);
  assertExactEdges(forward);
  assertBaseEncloses(forward);
  for (const folder of forward.folders) {
    const children = forward.nodes.filter(node => node.folder === folder.path);
    for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
      const a = children[i], b = children[j];
      const dx = Math.abs(a.position[0] - b.position[0]);
      const dz = Math.abs(a.position[2] - b.position[2]);
      const widthA = Math.max(8, 4 + a.name.length * 0.8), widthB = Math.max(8, 4 + b.name.length * 0.8);
      assert.ok(dx >= (widthA + widthB) / 2 + 3.2 - 1e-9 || dz >= 6 + 3.2 - 1e-9,
        `${a.path} and ${b.path} share a reserved file slot`);
    }
  }
});

test('bundled xo-space keeps all 754 visible files at useful local spacing on a supporting ground base', () => {
  const snapshot = JSON.parse(readFileSync(new URL('./examples/xo-space.json', import.meta.url), 'utf8'));
  const model = buildModel(snapshot);
  const frame = stateAt(model, model.commits.length - 1);
  const layout = createRootLayout(model, { activeIds: frame.activeIds, paths: new Map(frame.files.map(file => [file.id, file.path])) });
  assert.equal(layout.fileCount, 754);
  assert.equal(layout.folderCount, 125);
  assert.equal(layout.maxDepth, 8);
  assert.equal(layout.footprint.scaleX, 1);
  assert.equal(layout.footprint.scaleZ, 1);
  assert.equal(layout.readability.adaptive, true);
  assert.equal(new Set(layout.nodes.map(node => node.id)).size, 754);
  assert.ok(layout.rows.every(row => row.visible && row.position.every(Number.isFinite)));
  assert.ok(layout.base.radiusX * 2 < 1500 && layout.base.radiusZ * 2 < 1500, 'recursive packing should not form a long ribbon');
  assertExactEdges(layout);
  assertBaseEncloses(layout);
  for (const folder of layout.folders) {
    const files = layout.nodes.filter(node => node.folder === folder.path);
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
      const a = files[i].position, b = files[j].position;
      assert.ok(Math.hypot(a[0] - b[0], a[2] - b[2]) >= 9.2 - 1e-9);
    }
  }
});

test('ground counts and adaptive threshold use current non-dot membership only', () => {
  const model = make(['visible.js', ...Array.from({ length: 300 }, (_, index) => `.agents/config${index}.json`)]);
  const layout = createRootLayout(model);
  assert.equal(layout.base.fileCount, 1);
  assert.equal(layout.base.capacityScale, 1);
  assert.equal(layout.readability.adaptive, false);
  assert.deepEqual(layout.folders.map(folder => folder.path), ['']);
  const renamed = createRootLayout(model, { activeIds: ['file:0'], paths: { 'file:0': '.hidden/visible.js' } });
  assert.equal(renamed.base.fileCount, 0);
  assert.deepEqual(renamed.nodes, []);
  assertBaseEncloses(renamed);
});
