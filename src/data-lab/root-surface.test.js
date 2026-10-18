import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRootLayout } from './root-layout.js';
import { createRootWarpLayout } from './root-warp.js';
import { MAX_ROOT_SURFACE_HEIGHT, createRootSurface, measureRootSurfaceCrowding, rootSurfaceHeight, rootSurfaceGradient, applyRootSurface } from './root-surface.js';

const model = paths => ({ repository: { name: 'surface' }, nodes: paths.map((path, i) => ({ id: `f${i}`, path })) });
const geometry = layout => [...layout.folders, ...layout.nodes].map(row => ({ id: row.id, path: row.path, position: row.position, curve: row.curve }));
const near = (a, b, tolerance = 1e-8) => Math.abs(a - b) < tolerance;
const unit = vector => { const length = Math.hypot(...vector); assert.ok(length > 0); return vector.map(value => value / length); };
function connected(layout) {
  const folders = new Map(layout.folders.map(folder => [folder.path, folder]));
  assert.deepEqual(folders.get('').position, [0, layout.groundY, 0]);
  for (const row of layout.rows) {
    if (row.kind === 'folder' && !row.path) continue;
    const parent = folders.get(row.kind === 'file' ? row.folder : row.parent);
    assert.deepEqual(row.curve[0], parent.position);
    assert.deepEqual(row.curve[3], row.position);
  }
}

test('unmeasured layouts and spacious clear views stay flat, regardless of repository density', () => {
  for (const count of [0, 1, 8, 53, 2501]) {
    const layout = createRootLayout(model(Array.from({ length: count }, (_, i) => `src/file${i}.js`)));
    assert.equal(createRootSurface(layout).height, 0);
    assert.equal(createRootSurface(layout, { viewportWidth: 1600, crowding: 0 }).height, 0);
  }
  const layout = createRootLayout(model(Array.from({ length: 53 }, (_, i) => `group${i % 6}/file${i}.js`)));
  const surface = createRootSurface(layout, { height: 48 });
  assert.equal(surface.height, 48);
  assert.equal(surface.radiusX, 50);
  assert.equal(surface.radiusZ, 30);
  assert.equal(surface.depthWeight, .2);
  assert.equal(surface.fileCount, 53);
});

test('the shared surface bends downward with the fixed trunk as its global maximum', () => {
  const surface = { height: 48, radiusX: 50, radiusZ: 30 };
  assert.equal(rootSurfaceHeight(surface, 0, 0), 0);
  assert.equal(rootSurfaceHeight(surface, 50, 0), -24);
  assert.ok(near(rootSurfaceHeight(surface, 0, 30), -8));
  assert.ok(near(rootSurfaceHeight(surface, 50, 30), -48 * 1.2 / 2.2));
  for (const [x, z] of [[4, 2], [50, 30], [250, 170], [1e200, 1e200]]) {
    const height = rootSurfaceHeight(surface, x, z);
    assert.equal(height, rootSurfaceHeight(surface, -x, z));
    assert.equal(height, rootSurfaceHeight(surface, x, -z));
    assert.ok(Number.isFinite(height) && height <= 0 && height >= -surface.height);
  }
  const epsilon = 1e-4;
  assert.ok(Math.abs(rootSurfaceHeight(surface, epsilon, 0) / epsilon) < 1e-4, 'slope at the trunk must vanish');
});

test('height zero clones the layout without changing geometry or bounds', () => {
  const base = createRootLayout(model(['src/a.js', 'src/deep/b.js', 'docs/readme.md']));
  const original = structuredClone(base);
  const surface = createRootSurface(base, { height: 0 });
  const next = applyRootSurface(base, surface);
  assert.deepEqual(geometry(next), geometry(base));
  assert.deepEqual(next.bounds, base.bounds);
  assert.deepEqual(next.center, base.center);
  assert.equal(next.extent, base.extent);
  assert.notEqual(next.folders[0].position, base.folders[0].position);
  assert.notEqual(next.folders[0].children, base.folders[0].children);
  next.nodes[0].curve[1][1] = 999;
  assert.deepEqual(base, original);
});

test('downward surface deformation preserves exact identities, historical paths, immediate parents, and local depth', () => {
  const source = model(['old/moved.js', 'keep/a.js', 'removed/no.js']);
  const base = createRootLayout(source, { activeIds: ['f0', 'f1'], paths: new Map([['f0', 'new/deep/moved.js']]) });
  const original = structuredClone(base);
  const surface = createRootSurface(base, { height: 48 });
  const curled = applyRootSurface(base, surface);
  assert.deepEqual(curled.nodes.map(node => [node.id, node.path, node.parentPath]), base.nodes.map(node => [node.id, node.path, node.parentPath]));
  assert.deepEqual(curled.folders.map(folder => [folder.path, folder.parent, folder.count]), base.folders.map(folder => [folder.path, folder.parent, folder.count]));
  assert.equal(curled.nodes.length, 2);
  assert.ok(!curled.folders.some(folder => folder.path === 'old' || folder.path === 'removed'));
  for (let index = 0; index < curled.rows.length; index++) {
    const before = base.rows[index], after = curled.rows[index];
    const lift = rootSurfaceHeight(surface, before.position[0], before.position[2]);
    assert.equal(after.position[0], before.position[0]);
    assert.equal(after.position[2], before.position[2]);
    assert.ok(near(after.position[1] - (base.groundY + lift), before.position[1] - base.groundY));
  }
  assert.deepEqual(base, original);
  connected(curled);
});

test('the surface Jacobian preserves smooth tangent directions at folder junctions', () => {
  const base = createRootLayout(model(['src/core/hot.js', 'src/core/quiet.js', 'docs/readme.md']));
  const grown = createRootWarpLayout(base, { baseRadius: .14, fileRadii: { f0: .7 }, folderRadii: { src: .7, 'src/core': .7 } });
  const curled = applyRootSurface(grown, createRootSurface(base, { height: 48 }));
  const folders = new Map(curled.folders.map(folder => [folder.path, folder]));
  for (const folder of curled.folders.filter(folder => folder.path)) {
    const incoming = unit(folder.position.map((value, axis) => value - folder.curve[2][axis]));
    const children = [
      ...folder.children.map(path => folders.get(path)),
      ...curled.nodes.filter(node => node.folder === folder.path),
    ];
    for (const child of children) {
      const outgoing = unit(child.curve[1].map((value, axis) => value - child.curve[0][axis]));
      incoming.forEach((value, axis) => assert.ok(near(value, outgoing[axis])));
    }
  }
  connected(curled);
});

test('balanced activity retains mirror symmetry after downward bending', () => {
  const base = createRootLayout(model(['left/a.js', 'left/b.js', 'right/a.js', 'right/b.js']));
  const grown = createRootWarpLayout(base, {
    baseRadius: .14, fileRadii: new Map(base.nodes.map(node => [node.id, .6])), folderRadii: { left: .6, right: .6 },
  });
  const curled = applyRootSurface(grown, createRootSurface(base, { height: 48 }));
  const left = curled.nodes.filter(node => node.folder === 'left');
  const right = curled.nodes.filter(node => node.folder === 'right').reverse();
  left.forEach((node, i) => node.curve.forEach((point, j) => {
    assert.ok(near(point[0], -right[i].curve[j][0]));
    assert.ok(near(point[1], right[i].curve[j][1]));
    assert.ok(near(point[2], right[i].curve[j][2]));
  }));
  connected(curled);
});

test('dense and deep hierarchies retain every record with finite enclosing bounds', () => {
  const deep = Array.from({ length: 20 }, (_, i) => `depth${i}`).join('/');
  const base = createRootLayout(model([...Array.from({ length: 2501 }, (_, i) => `src/file${i}.js`), `${deep}/last.js`]));
  const surface = createRootSurface(base, { height: MAX_ROOT_SURFACE_HEIGHT });
  const curled = applyRootSurface(base, surface);
  assert.equal(curled.nodes.length, 2502);
  assert.equal(curled.folders.length, base.folders.length);
  assert.equal(curled.rows.length, base.rows.length);
  assert.equal(new Set(curled.nodes.map(node => node.position.join(','))).size, 2502);
  for (const row of curled.rows) for (const point of row.curve) {
    assert.ok(point.every(Number.isFinite));
    for (let axis = 0; axis < 3; axis++) assert.ok(point[axis] >= curled.bounds.min[axis] && point[axis] <= curled.bounds.max[axis]);
  }
  assert.ok(Number.isFinite(curled.extent));
  connected(curled);
});

test('surface poses are deterministic and invalid explicit heights remain flat', () => {
  const base = createRootLayout(model(Array.from({ length: 40 }, (_, i) => `src/file${i}.js`)));
  const surface = createRootSurface(base, { viewportWidth: 430, crowding: .8 });
  const first = applyRootSurface(base, surface);
  applyRootSurface(base, createRootSurface(base, { height: 100 }));
  assert.deepEqual(applyRootSurface(base, createRootSurface(base, { viewportWidth: 430, crowding: .8 })), first);
  for (const height of [0, -3, NaN, Infinity, null]) {
    const invalid = createRootSurface(base, { height });
    assert.equal(invalid.height, 0);
    assert.deepEqual(geometry(applyRootSurface(base, invalid)), geometry(base));
  }
  assert.equal(rootSurfaceHeight(undefined, 30, 20), 0);
});

test('the actual soil ellipse droops at its sides below the unchanged trunk', () => {
  const layout = createRootLayout(model(['src/file.js']));
  const surface = createRootSurface(layout, { height: 48 });
  const ring = Array.from({ length: 64 }, (_, index) => {
    const angle = index / 64 * Math.PI * 2;
    return rootSurfaceHeight(surface, Math.cos(angle) * 50, Math.sin(angle) * 30);
  });
  assert.ok(near(ring[0], -24));
  assert.ok(near(ring[16], -8));
  assert.ok(near(ring[32], -24));
  assert.ok(near(ring[48], -8));
  assert.ok(Math.max(...ring) - Math.min(...ring) > 15);
});

test('curled bounds retain physical padding without adding unused height above the trunk', () => {
  const base = createRootLayout(model(['src/a.js', 'src/b.js', 'docs/readme.md']));
  const grown = createRootWarpLayout(base, { baseRadius: .14, folderRadii: { src: .7 }, fileRadii: { f0: .4 } });
  const surface = createRootSurface(base, { height: 48 });
  const curled = applyRootSurface(grown, surface);
  const envelope = layout => {
    const values = layout.rows.flatMap(row => row.curve.map(point => point[1]));
    return { min: Math.min(...values), max: Math.max(...values) };
  };
  const before = envelope(grown), after = envelope(curled);
  assert.ok(near(before.min - grown.bounds.min[1], after.min - curled.bounds.min[1]));
  assert.ok(near(grown.bounds.max[1] - before.max, curled.bounds.max[1] - after.max));
  assert.ok(curled.bounds.max[1] < grown.bounds.max[1] + 2, 'small footprint should not create a full-height empty area');
  connected(curled);
});

test('exported negative field gradients match finite differences and preserve a zero-slope trunk', () => {
  const surface = { height: 48, radiusX: 50, radiusZ: 30, depthWeight: .2 };
  assert.deepEqual(rootSurfaceGradient(surface, 0, 0), [0, 0]);
  for (const [x, z] of [[15, 4], [-30, 20], [50, -30]]) {
    const [dx, dz] = rootSurfaceGradient(surface, x, z);
    const e = 1e-4;
    const measuredX = (rootSurfaceHeight(surface, x + e, z) - rootSurfaceHeight(surface, x - e, z)) / (2 * e);
    const measuredZ = (rootSurfaceHeight(surface, x, z + e) - rootSurfaceHeight(surface, x, z - e)) / (2 * e);
    assert.ok(near(dx, measuredX));
    assert.ok(near(dz, measuredZ));
    assert.ok(dx * x <= 0 && dz * z <= 0);
  }
});

test('responsive curvature activates on narrow screens only when enough names are visible', () => {
  const layout = createRootLayout(model(Array.from({ length: 53 }, (_, i) => `src/file${i}.js`)));
  assert.equal(createRootSurface(layout, { viewportWidth: 1600, crowding: { score: 0, visibleFileCount: 53 } }).height, 0);
  const narrow = createRootSurface(layout, { viewportWidth: 430, crowding: { score: 0, visibleFileCount: 53 } });
  assert.ok(narrow.height > 50 && narrow.height <= MAX_ROOT_SURFACE_HEIGHT);
  assert.ok(createRootSurface(layout, { viewportWidth: 430, crowding: { score: 0, visibleFileCount: 10 } }).height > 0);
  assert.equal(createRootSurface(layout, { viewportWidth: 430, crowding: { score: 0, visibleFileCount: 8 } }).height, 0);
  assert.equal(createRootSurface(layout, { viewportWidth: 430, crowding: { score: 0, visibleFileCount: 0 } }).height, 0);
  assert.equal(createRootSurface(layout, { viewportWidth: 1600, crowding: 1 }).height, MAX_ROOT_SURFACE_HEIGHT);
  assert.equal(createRootSurface(layout, { height: 0, viewportWidth: 430, crowding: 1 }).height, 0);
});

test('projected compact filename overlap is detected independently of world layout or screen width', () => {
  const clear = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, x: 30 + i * 24, y: 120, textWidth: 75 }));
  const spacious = measureRootSurfaceCrowding(clear, { width: 1600, height: 900 });
  assert.equal(spacious.visibleFileCount, 40);
  assert.equal(spacious.overlapCount, 0);
  assert.equal(spacious.score, 0);
  const compressed = measureRootSurfaceCrowding(clear.map(point => ({ ...point, x: 30 + Number(point.id.slice(1)) * 5 })), { width: 1600, height: 900 });
  assert.ok(compressed.overlapCount > 0);
  assert.ok(compressed.score > .5);
  assert.ok(compressed.maxColumnLoad >= 3);
  const layout = createRootLayout(model(clear.map(point => `src/${point.id}.js`)));
  assert.equal(createRootSurface(layout, { crowding: spacious }).height, 0);
  assert.ok(createRootSurface(layout, { crowding: compressed }).height > 28);
});

test('sweep overlap counts match exact compact-label rectangle intersections', () => {
  const points = Array.from({ length: 40 }, (_, i) => ({ x: (i * 37) % 140 + 20, y: (i * 23) % 240, textWidth: 20 + (i % 7) * 8 }));
  const measured = measureRootSurfaceCrowding(points, { width: 300, height: 400 });
  let expected = 0;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const a = points[i], b = points[j];
    if (Math.abs(a.x - b.x) < 11 && a.y + 8 < b.y + 12 + b.textWidth && b.y + 8 < a.y + 12 + a.textWidth) expected++;
  }
  assert.equal(measured.overlapCount, expected);
  assert.deepEqual(measureRootSurfaceCrowding([...points].reverse(), { width: 300, height: 400 }), measured);
  assert.equal(measureRootSurfaceCrowding([{ x: 20, y: 20, textWidth: 40 }, { x: 31, y: 20, textWidth: 40 }], { width: 300, height: 400 }).overlapCount, 0);
  assert.equal(measureRootSurfaceCrowding([{ x: 20, y: 20, textWidth: 40 }, { x: 20, y: 64, textWidth: 40 }], { width: 300, height: 400 }).overlapCount, 0);
});

test('dense projected points stay bounded and offscreen points do not trigger crowding', () => {
  const dense = Array.from({ length: 2501 }, () => ({ x: 100, y: 100, textWidth: 90 }));
  const measured = measureRootSurfaceCrowding(dense, { width: 430, height: 900 });
  assert.equal(measured.visibleFileCount, 2501);
  assert.equal(measured.overlapCount, 2501 * 2500 / 2);
  assert.equal(measured.maxColumnLoad, 2501);
  assert.equal(measured.score, 1);
  const hidden = measureRootSurfaceCrowding([
    { x: -1, y: 100, textWidth: 90 }, { x: 500, y: 100, textWidth: 90 },
    { x: 100, y: -1, textWidth: 90 }, { x: 100, y: 901, textWidth: 90 },
    { x: 100, y: 100, textWidth: 90, visible: false }, { x: NaN, y: 100, textWidth: 90 },
  ], { width: 430, height: 900 });
  assert.equal(hidden.visibleFileCount, 0);
  assert.equal(hidden.overlapCount, 0);
  assert.equal(hidden.score, 0);
  assert.equal(measureRootSurfaceCrowding([], { width: 0, height: 0 }).score, 0);
});

test('horizontal filenames detect the desktop overlaps missed by compact vertical columns', () => {
  const points = Array.from({ length: 12 }, (_, i) => ({ x: 50 + i * 45, y: 100, textWidth: 80 }));
  const viewport = { width: 1600, height: 900 };
  const vertical = measureRootSurfaceCrowding(points, viewport);
  const horizontal = measureRootSurfaceCrowding(points, { ...viewport, labelOrientation: 'horizontal' });
  assert.equal(vertical.overlapCount, 0);
  assert.equal(horizontal.overlapCount, 11);
  assert.equal(horizontal.visibleFileCount, 12);
  assert.ok(horizontal.score > .5);
  const layout = createRootLayout(model(points.map((_, index) => `src/file${index}.js`)));
  assert.equal(createRootSurface(layout, { crowding: vertical }).height, 0);
  assert.ok(createRootSurface(layout, { crowding: horizontal }).height > 28);
  assert.deepEqual(measureRootSurfaceCrowding(points, { ...viewport, labelOrientation: 'vertical' }), vertical);
});

test('variable-width horizontal sweep matches brute-force rectangle overlap and ignores touching edges', () => {
  const viewport = { width: 500, height: 310, labelOrientation: 'horizontal' };
  const points = Array.from({ length: 90 }, (_, i) => ({
    x: (i * 37) % 490, y: (i * 23) % 310, textWidth: 12 + (i % 11) * 19,
  }));
  const rectangles = points.map(point => ({
    left: point.x - (point.textWidth + 10) / 2,
    right: point.x + (point.textWidth + 10) / 2,
    top: point.y + 8, bottom: Math.min(point.y + 30, viewport.height),
  })).filter(rectangle => rectangle.top < rectangle.bottom);
  let expected = 0;
  for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
    const a = rectangles[i], b = rectangles[j];
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) expected++;
  }
  const measured = measureRootSurfaceCrowding(points, viewport);
  assert.equal(measured.overlapCount, expected);
  assert.equal(measured.measuredFileCount, rectangles.length);
  assert.deepEqual(measureRootSurfaceCrowding([...points].reverse(), viewport), measured);
  for (const second of [{ x: 150, y: 100 }, { x: 100, y: 122 }]) {
    assert.equal(measureRootSurfaceCrowding([
      { x: 100, y: 100, textWidth: 30 }, { ...second, textWidth: 50 },
    ], viewport).overlapCount, 0);
  }
  assert.equal(measureRootSurfaceCrowding([
    { x: 100, y: 100, textWidth: 30 }, { x: 149, y: 100, textWidth: 50 },
  ], viewport).overlapCount, 1);
});

test('horizontal widths expire independently and dense labels remain bounded', () => {
  const viewport = { width: 1000, height: 300, labelOrientation: 'horizontal' };
  // The wide interval ends after both narrow intervals, although it starts first.
  const nested = [
    { x: 150, y: 100, textWidth: 290 },
    { x: 60, y: 100, textWidth: 10 },
    { x: 100, y: 100, textWidth: 10 },
  ];
  assert.equal(measureRootSurfaceCrowding(nested, viewport).overlapCount, 2);
  const dense = measureRootSurfaceCrowding(Array.from({ length: 2501 }, (_, i) => ({
    x: 100, y: 100, textWidth: 30 + i % 200,
  })), viewport);
  assert.equal(dense.overlapCount, 2501 * 2500 / 2);
  assert.equal(dense.maxColumnLoad, 2501);
  assert.equal(dense.score, 1);
  const hidden = measureRootSurfaceCrowding([
    { x: -1, y: 100, textWidth: 80 }, { x: 100, y: 100, textWidth: 80, visible: false },
    { x: 100, y: 301, textWidth: 80 }, { x: 100, y: 298, textWidth: 80 },
  ], viewport);
  assert.equal(hidden.visibleFileCount, 1);
  assert.equal(hidden.measuredFileCount, 0);
  assert.equal(hidden.overlapCount, 0);
  assert.equal(hidden.score, 0);
});
