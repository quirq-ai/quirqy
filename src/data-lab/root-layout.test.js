import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRootLayout, ROOT_ROW_HEIGHT, ROOT_INDENT, ROOT_DEPTH_OFFSET } from './root-layout.js';
import { buildModel, stateAt } from './model.js';

const make = paths => ({ repository: { name: 'roots' }, nodes: paths.map((path, index) => ({ id: `file:${index}`, path, size: index * 17 })) });
const mapFolders = layout => new Map(layout.folders.map(folder => [folder.path, folder]));
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

function assertExactEdges(layout) {
  const folders = mapFolders(layout);
  assert.deepEqual(folders.get('').position, [0, layout.groundY - 3, 0]);
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
  const layout = createRootLayout(model, { expandedPaths: new Set(createRootLayout(model).folders.map(folder => folder.path)) });
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

test('outline rows align by depth with equal spacing and axis-aligned connectors', () => {
  const model = make(['README.md', 'src/index.js', 'src/ui/button.js', 'src/ui/menu.js', 'docs/start.md']);
  const layout = createRootLayout(model, { expandedPaths: new Set(['', 'src', 'src/ui', 'docs']) });
  assert.deepEqual(layout.rows.map(row => row.path), ['', 'docs', 'docs/start.md', 'src', 'src/ui', 'src/ui/button.js', 'src/ui/menu.js', 'src/index.js', 'README.md']);
  for (const [index, row] of layout.rows.entries()) {
    assert.equal(row.position[0], row.depth * ROOT_INDENT);
    assert.equal(row.position[2], row.depth * ROOT_DEPTH_OFFSET);
    assert.equal(row.position[1], -43 - index * ROOT_ROW_HEIGHT);
    for (let part = 1; part < row.points.length; part++) {
      const changedAxes = row.points[part].filter((value, axis) => value !== row.points[part - 1][axis]).length;
      assert.ok(changedAxes <= 1, `${row.path}: connector segment must turn at right angles`);
    }
  }
  assertExactEdges(layout);
});

test('collapsed folders retain exact hidden paths at the nearest visible ancestor', () => {
  const model = make(['README.md', 'src/index.js', 'src/ui/button.js', 'docs/start.md']);
  const closed = createRootLayout(model);
  assert.deepEqual(closed.rows.map(row => row.path), ['', 'docs', 'src', 'README.md']);
  const src = mapFolders(closed).get('src');
  assert.equal(src.expanded, false);
  for (const node of closed.nodes.filter(node => node.path.startsWith('src/'))) {
    assert.equal(node.visible, false);
    assert.deepEqual(node.position, src.position);
  }
  assert.equal(mapFolders(closed).get('src/ui').visible, false);
  const opened = createRootLayout(model, { expandedPaths: new Set(['', 'src']) });
  assert.deepEqual(opened.rows.map(row => row.path), ['', 'docs', 'src', 'src/ui', 'src/index.js', 'README.md']);
  assert.equal(opened.nodes.find(node => node.path === 'src/ui/button.js').visible, false);
  assert.equal(opened.fileCount, closed.fileCount);
  assert.equal(opened.folderCount, closed.folderCount);
});

test('large folders page immediate entries without dropping files from the full hierarchy', () => {
  const model = make(Array.from({ length: 2500 }, (_, index) => `file${String(index).padStart(4, '0')}.js`));
  const first = createRootLayout(model);
  assert.equal(first.nodes.length, 2500);
  assert.equal(first.rows.filter(row => row.kind === 'file').length, 32);
  const pager = first.rows.at(-1);
  assert.equal(pager.kind, 'pager');
  assert.deepEqual([pager.start, pager.end, pager.total, pager.pageCount], [0, 32, 2500, 79]);
  assert.equal(pager.hasPrevious, false);
  assert.equal(pager.hasNext, true);
  const last = createRootLayout(model, { pageByPath: new Map([['', 1000]]) });
  assert.deepEqual(last.rows.filter(row => row.kind === 'file').map(row => row.path), ['file2496.js', 'file2497.js', 'file2498.js', 'file2499.js']);
  assert.equal(last.rows.at(-1).hasPrevious, true);
  assert.equal(last.rows.at(-1).hasNext, false);
  assert.ok(last.extent < first.extent);
  assertExactEdges(last);
});

test('paging is local to each expanded folder and folders sort before files', () => {
  const model = make(['z/a.js', 'z/b.js', 'z/c.js', 'a.js', 'b.js', 'c.js', 'z/deep/index.js']);
  const layout = createRootLayout(model, { expandedPaths: new Set(['', 'z']), pageSize: 2, pageByPath: { z: 1 } });
  assert.deepEqual(layout.rows.map(row => [row.kind, row.path]), [
    ['folder', ''], ['folder', 'z'], ['file', 'z/b.js'], ['file', 'z/c.js'], ['pager', 'z'], ['file', 'a.js'], ['pager', ''],
  ]);
  const collapsedRoot = createRootLayout(model, { expandedPaths: new Set() });
  assert.equal(collapsedRoot.rows.length, 1);
  assert.equal(collapsedRoot.folders[0].expanded, false);
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
