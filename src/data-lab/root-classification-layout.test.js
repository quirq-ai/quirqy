import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRootLayout } from './root-layout.js';
import { createRootClassificationLayout, ROOT_CLASSIFICATION_ROW_PITCH, ROOT_CLASSIFICATION_TIER_PITCH } from './root-classification-layout.js';
import { buildModel, stateAt } from './model.js';

const make = paths => ({ repository: { name: 'classification' }, nodes: paths.map((path, index) => ({ id: `f${index}`, path })) });
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
function assertHierarchy(layout) {
  const folders = new Map(layout.folders.map(folder => [folder.path, folder]));
  assert.deepEqual(folders.get('').position, [0, layout.groundY, 0]);
  for (const row of layout.rows) {
    assert.ok(row.position.every(Number.isFinite));
    assert.equal(row.position[1], layout.groundY - row.depth * layout.classification.tierPitch);
    assert.equal(row.position[2], 0);
    assert.equal(row.visible, true);
    if (row.kind === 'folder' && !row.path) continue;
    assert.equal(row.parentPath, parentOf(row.path));
    const parent = folders.get(row.parentPath);
    assert.deepEqual(row.curve[0], parent.position);
    assert.deepEqual(row.curve[3], row.position);
    assert.ok(row.position[1] < parent.position[1]);
    assert.ok(row.curve.every(point => point.every(Number.isFinite)));
    assert.deepEqual(row.labelDirection, [0, -1, 0]);
    assert.ok(row.labelBounds.max[1] < row.position[1]);
  }
}
function assertSlotsClear(layout) {
  const records = layout.rows.filter(row => row.labelBounds);
  for (let a = 0; a < records.length; a++) for (let b = a + 1; b < records.length; b++) {
    const first = records[a].labelBounds, second = records[b].labelBounds;
    const overlap = [0, 1].every(axis => Math.min(first.max[axis], second.max[axis]) > Math.max(first.min[axis], second.min[axis]));
    assert.ok(!overlap, `slots intersect: ${records[a].path} / ${records[b].path}`);
  }
}

test('top-down classification preserves every exact identity and parent without mutating the organic layout', () => {
  const base = createRootLayout(make(['README.md', 'src/app.js', 'src/ui/button.js', 'src/ui/menu.js', 'docs/start.md']));
  const before = structuredClone(base), layout = createRootClassificationLayout(base);
  assert.equal(layout.kind, 'classification');
  assert.equal(layout.classification.orientation, 'down');
  assert.equal(layout.classification.depthAxis, 'y');
  assert.equal(layout.classification.rowAxis, 'x');
  assert.deepEqual(layout.classification.growthDirection, [0, -1, 0]);
  assert.deepEqual(layout.nodes.map(node => [node.id, node.path, node.parentPath]), base.nodes.map(node => [node.id, node.path, node.parentPath]));
  assert.deepEqual(layout.folders.map(folder => [folder.path, folder.parent, folder.count]), base.folders.map(folder => [folder.path, folder.parent, folder.count]));
  assert.deepEqual(layout.proportions, base.proportions);
  assert.equal(layout.rows.length, layout.fileCount + layout.folderCount);
  assertHierarchy(layout); assertSlotsClear(layout);
  assert.deepEqual(base, before);
  layout.nodes[0].curve[0][0] = 900;
  assert.deepEqual(base, before);
});

test('all folders at the same depth share an exact level with symmetric equal sibling subtrees', () => {
  const layout = createRootClassificationLayout(createRootLayout(make(['left/a.js', 'left/b.js', 'rght/a.js', 'rght/b.js'])));
  const rows = new Map(layout.rows.map(row => [row.path, row]));
  const left = rows.get('left'), right = rows.get('rght');
  assert.equal(left.position[0], -right.position[0]);
  assert.deepEqual(left.position.slice(1), right.position.slice(1));
  assert.equal(rows.get('left/a.js').position[0], -rows.get('rght/b.js').position[0]);
  for (const { depth, y } of layout.classification.levels) {
    assert.ok(layout.folders.filter(folder => folder.depth === depth).every(folder => folder.position[1] === y));
    assert.equal(layout.classification.depthOffsets[depth], depth * ROOT_CLASSIFICATION_TIER_PITCH);
  }
  assertSlotsClear(layout);
});

test('lexical leaf lanes and actual subtree intervals remain distinct without depth shelves', () => {
  const layout = createRootClassificationLayout(createRootLayout(make(['a/z.js', 'a/deep/a.js', 'a/deep/b.js', 'b/start.js', 'b/end.js', 'plain.js'])));
  const nodes = [...layout.nodes].sort((a, b) => a.row - b.row);
  assert.deepEqual(nodes.map(node => node.row), nodes.map((_, index) => index));
  assert.deepEqual(nodes.map(node => node.path), nodes.map(node => node.path).sort());
  for (let index = 1; index < nodes.length; index++) {
    assert.ok(nodes[index].laneBounds[0] >= nodes[index - 1].laneBounds[1]);
    assert.ok(nodes[index].labelBounds.min[0] - nodes[index - 1].labelBounds.max[0] >= ROOT_CLASSIFICATION_ROW_PITCH - 1e-9);
  }
  for (const folder of layout.folders.filter(folder => folder.path)) {
    const descendants = layout.nodes.filter(node => node.path.startsWith(`${folder.path}/`));
    assert.deepEqual(folder.rowSpan, [Math.min(...descendants.map(node => node.row)), Math.max(...descendants.map(node => node.row))]);
    assert.equal(folder.position[0], (folder.laneBounds[0] + folder.laneBounds[1]) / 2);
  }
  assertSlotsClear(layout);
});

test('full monospace names and folder touch suffixes reserve clear centered slots', () => {
  const narrow = 'i'.repeat(60), wide = '界'.repeat(30);
  const layout = createRootClassificationLayout(createRootLayout(make([`${narrow}/child/one.js`, `${narrow}/child/two.js`, `${wide}/leaf.js`])));
  for (const row of layout.rows.filter(row => row.path)) {
    const text = `${row.name}${row.kind === 'folder' ? ' · 999 touches' : ''}`;
    const pixels = [...text].reduce((sum, glyph) => sum + (/[^\x00-\x7f]/.test(glyph) ? 13 : 8), 8);
    assert.ok(row.labelWidthWorld * layout.readability.labelPixelsPerWorld >= pixels);
    assert.equal((row.labelBounds.min[0] + row.labelBounds.max[0]) / 2, row.position[0]);
  }
  assertSlotsClear(layout);
});

test('2501 flat files retain unique horizontal lanes on one level without a cap or artificial split', () => {
  const layout = createRootClassificationLayout(createRootLayout(make(Array.from({ length: 2501 }, (_, index) => `file-${String(index).padStart(4, '0')}.js`))));
  assert.equal(layout.fileCount, 2501); assert.equal(layout.folderCount, 1);
  assert.equal(new Set(layout.nodes.map(node => node.position[0])).size, 2501);
  assert.equal(new Set(layout.nodes.map(node => node.position[1])).size, 1);
  assert.equal(layout.classification.rowCount, 2501);
  assert.ok(layout.footprint.depth < 8);
  assertHierarchy(layout);
});

test('historical moves, deletion and hidden paths retain the underlying exact root semantics', () => {
  const model = make(['new/deep/file.js', 'removed.js', '.agents/notes.md', 'visible/.hidden/secret.js']);
  const base = createRootLayout(model, { activeIds: ['f0', 'f2', 'f3'], paths: { f0: 'old/file.js' }, repositoryWidth: 640 });
  const layout = createRootClassificationLayout(base);
  assert.equal(layout.fileCount, 1); assert.equal(layout.nodes[0].id, 'f0');
  assert.equal(layout.nodes[0].path, 'old/file.js');
  assert.deepEqual(layout.folders.map(folder => folder.path), ['', 'old']);
  assert.equal(layout.proportions.lengthPerTouch, 24);
  assertHierarchy(layout);
});

test('empty, single-file and deep chains remain finite with every real tier preserved', () => {
  for (const paths of [[], ['single.js'], [`${Array.from({ length: 25 }, (_, index) => `level${index}`).join('/')}/file.js`]]) {
    const layout = createRootClassificationLayout(createRootLayout(make(paths)));
    assert.equal(layout.fileCount, paths.length);
    assert.ok([...layout.bounds.min, ...layout.bounds.max, layout.extent].every(Number.isFinite));
    assert.ok(layout.folders[0].rowSpan[1] >= 0);
    assertHierarchy(layout); assertSlotsClear(layout);
  }
});

test('classification is deterministic across model ordering and current-path map order', () => {
  const model = make(['z/z.js', 'a/a.js', 'b/deep/z.js', 'a/b.js', 'plain.js']);
  const ids = model.nodes.map(node => node.id), paths = model.nodes.map(node => [node.id, node.path]);
  const first = createRootClassificationLayout(createRootLayout(model, { activeIds: ids, paths: Object.fromEntries(paths) }));
  const second = createRootClassificationLayout(createRootLayout({ ...model, nodes: [...model.nodes].reverse() }, { activeIds: [...ids].reverse(), paths: new Map([...paths].reverse()) }));
  assert.deepEqual(second, first);
});

test('pinned label widths and tier spacing survive rename and membership changes', () => {
  const model = make(['a/long-filename-for-history.js', 'a/b.js', 'right/file.js']);
  const head = createRootClassificationLayout(createRootLayout(model), { tierPitch: 47, lanePitch: 12 });
  const options = { tierPitch: head.classification.tierPitch, lanePitch: head.classification.lanePitch, labelWidths: head.classification.labelWidths };
  const earlier = createRootClassificationLayout(createRootLayout(model, { activeIds: ['f0', 'f2'], paths: { f0: 'a/x.js' } }), options);
  assert.equal(earlier.nodes.find(node => node.id === 'f0').labelWidthWorld, head.nodes.find(node => node.id === 'f0').labelWidthWorld);
  assert.equal(earlier.folders.find(folder => folder.path === 'a').position[1], head.folders.find(folder => folder.path === 'a').position[1]);
  assert.deepEqual(createRootClassificationLayout(createRootLayout(model, { activeIds: ['f0', 'f2'], paths: { f0: 'a/x.js' } }), { ...options, labelWidths: Object.fromEntries(options.labelWidths) }), earlier);
  assertSlotsClear(earlier); assertHierarchy(earlier);
  const actualCountWidth = 38;
  const calibrated = createRootClassificationLayout(createRootLayout(model), { labelWidths: new Map([['folder:right', actualCountWidth]]) });
  assert.equal(calibrated.folders.find(folder => folder.path === 'right').labelWidthWorld, actualCountWidth);
  assert.ok(actualCountWidth < head.folders.find(folder => folder.path === 'right').labelWidthWorld);
  const base = createRootLayout(model), original = createRootClassificationLayout(base);
  for (const value of [undefined, 0, -5, NaN, Infinity, '36']) assert.deepEqual(createRootClassificationLayout(base, { tierPitch: value, lanePitch: value }), original);
});

test('shallow 3D rope relief preserves aligned folder endpoints and smooth fork tangents', () => {
  const layout = createRootClassificationLayout(createRootLayout(make(['left/deep/a.js', 'left/deep/b.js', 'right/a.js'])));
  const folders = new Map(layout.folders.map(folder => [folder.path, folder]));
  assert.ok(layout.rows.some(row => row.curve.some(point => point[2] !== 0)));
  for (const entry of layout.rows.filter(row => row.path)) {
    const parent = folders.get(entry.parentPath);
    const outgoing = entry.curve[1].map((value, axis) => value - entry.curve[0][axis]);
    assert.ok(outgoing[1] < 0);
    if (!parent.path) continue;
    const incoming = parent.curve[3].map((value, axis) => value - parent.curve[2][axis]);
    incoming.forEach((value, axis) => assert.ok(Math.abs(value - outgoing[axis]) < 1e-10));
  }
});

test('both bundled repositories keep every non-dot file with clear frontal name slots', () => {
  for (const [name, count] of [['xo', 35], ['xo-space', 754]]) {
    const data = JSON.parse(readFileSync(new URL(`./examples/${name}.json`, import.meta.url), 'utf8'));
    const model = buildModel(data), frame = stateAt(model, model.commits.length - 1);
    const layout = createRootClassificationLayout(createRootLayout(model, { activeIds: frame.activeIds, paths: new Map(frame.files.map(file => [file.id, file.path])) }));
    assert.equal(layout.fileCount, count); assert.equal(layout.classification.rowCount, count);
    assertSlotsClear(layout); assertHierarchy(layout);
  }
});
