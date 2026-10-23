import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ROOT_VINE_RADIUS, ROOT_ROPE_PITCH, rootRopeRadius, createRootRopeBatch,
  setRootRopeShape, setRootRopeColor, finishRootRopeUpdate,
} from './root-rope-geometry.js';

const cubic = points => new THREE.CubicBezierCurve3(...points.map(point => new THREE.Vector3(...point)));
const straight = (length = 16, start = 0) => cubic([[0, start, 0], [0, start - length / 3, 0], [0, start - 2 * length / 3, 0], [0, start - length, 0]]);
const edge = (key, curve = straight(), maxTouches = 22, touches = 0) => ({ key, curve, maxTouches, touches, color: new THREE.Color('#ad895f') });
const at = (array, vertex) => new THREE.Vector3().fromArray(array, vertex * 3);
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
const mutate = (curve, points) => points.forEach((point, index) => curve[`v${index}`].fromArray(point));

function finite(batch) {
  for (const attribute of Object.values(batch.geometry.attributes)) assert.ok(attribute.array.every(Number.isFinite));
  for (let vertex = 0; vertex < batch.geometry.attributes.normal.count; vertex++) near(at(batch.geometry.attributes.normal.array, vertex).length(), 1);
  assert.ok(batch.geometry.boundingBox.min.toArray().concat(batch.geometry.boundingBox.max.toArray()).every(Number.isFinite));
  assert.ok(Number.isFinite(batch.geometry.boundingSphere.radius));
}

function assertCaliber(batch, range) {
  const positions = batch.geometry.attributes.position.array;
  for (const vine of range.vines.filter(vine => vine.visible)) {
    for (let vertex = vine.vertexStart; vertex < vine.vertexStart + vine.vertexCount; vertex++) {
      const actual = at(positions, vertex).distanceTo(at(batch.centers, vertex));
      near(actual, ROOT_VINE_RADIUS * batch.profiles[vertex], 3e-6);
    }
  }
}

test('each touch adds one equally thin physical vine with symmetric integer packing', () => {
  const curve = straight();
  const batch = createRootRopeBatch([edge('root', curve)]);
  const range = batch.ranges.get('root');
  const geometry = batch.geometry, positions = geometry.attributes.position.array;
  for (let touches = 0; touches <= 22; touches++) {
    setRootRopeShape(batch, range, curve, touches); finishRootRopeUpdate(batch);
    assert.equal(range.vineCount, touches + 1);
    assert.equal(range.vines.filter(vine => vine.visible).length, touches + 1);
    assert.equal(range.capacity, 23);
    const offsets = range.vines.filter(vine => vine.visible).map(vine => vine.offset);
    near(offsets.reduce((sum, point) => sum + point[0], 0), 0, 1e-10);
    near(offsets.reduce((sum, point) => sum + point[1], 0), 0, 1e-10);
    near(Math.max(...offsets.map(point => Math.hypot(...point))) + ROOT_VINE_RADIUS, rootRopeRadius(touches), 1e-10);
    assertCaliber(batch, range);
  }
  assert.equal(batch.geometry, geometry); assert.equal(geometry.attributes.position.array, positions);
  assert.ok(rootRopeRadius(22) < 1, 'growth should remain a compact bundle of thin vines');
  finite(batch); geometry.dispose();
});

test('every off-center vine twists with the same handedness and world-space pitch', () => {
  const curve = straight(19);
  const batch = createRootRopeBatch([edge('root', curve, 2, 2)]);
  const range = batch.ranges.get('root');
  for (const vine of range.vines) {
    let previous;
    for (let ring = 0; ring <= range.segments; ring++) {
      const point = at(batch.centers, vine.vertexStart + ring * (range.sides + 1));
      const angle = Math.atan2(-point.x, point.z);
      if (previous !== undefined) {
        const delta = Math.atan2(Math.sin(angle - previous), Math.cos(angle - previous));
        assert.ok(delta > 0, 'opposing or reversing twist');
        near(delta, 2 * Math.PI * range.length / ROOT_ROPE_PITCH / range.segments, 1e-6);
      }
      previous = angle;
    }
  }
  finite(batch); batch.geometry.dispose();
});

test('world arc offsets align helical centers across a connected parent and child', () => {
  const parent = straight(13.3), child = straight(17, -13.3);
  const batch = createRootRopeBatch([edge('parent', parent, 4, 4), edge('child', child, 4, 4)]);
  const a = batch.ranges.get('parent'), b = batch.ranges.get('child');
  setRootRopeShape(batch, a, parent, 4, 2.7);
  setRootRopeShape(batch, b, child, 4, a.endDistance); finishRootRopeUpdate(batch);
  for (let index = 0; index < a.vineCount; index++) {
    const endpoint = at(batch.centers, a.vines[index].vertexStart + a.segments * (a.sides + 1));
    const start = at(batch.centers, b.vines[index].vertexStart);
    near(endpoint.distanceTo(start), 0, 1e-7);
  }
  near(a.endDistance, 16, 1e-9);
  batch.geometry.dispose();
});

test('fractional growth extends the new vine while polar repacking never shrinks the envelope', () => {
  const curve = straight();
  const batch = createRootRopeBatch([edge('root', curve)]);
  const range = batch.ranges.get('root');
  let previousRadius = 0;
  for (let step = 0; step <= 220; step++) {
    const touches = step / 10;
    setRootRopeShape(batch, range, curve, touches); finishRootRopeUpdate(batch);
    assert.ok(range.radius + 1e-10 >= previousRadius, `bundle shrank at ${touches} touches`);
    previousRadius = range.radius;
    const maximumOffset = Math.max(...range.vines.filter(vine => vine.visible).map(vine => Math.hypot(...vine.offset)));
    near(range.radius, maximumOffset + ROOT_VINE_RADIUS, 1e-10);
  }
  setRootRopeShape(batch, range, curve, 5.25); finishRootRopeUpdate(batch);
  const growing = range.vines[6];
  assert.equal(growing.growth, 0.25); assert.equal(growing.visible, true);
  const tip = at(batch.centers, growing.vertexStart + range.segments * (range.sides + 1));
  near(tip.y, -4);
  assert.equal(range.vines[7].visible, false);
  assertCaliber(batch, range); finite(batch); batch.geometry.dispose();
});

test('file tips taper and collapsed new edges retain finite unit lighting normals', () => {
  const point = [2, -40, 3];
  const curve = cubic([point, point, point, point]);
  const batch = createRootRopeBatch([edge('file', curve, 5)], { pointed: true });
  const range = batch.ranges.get('file');
  for (const touches of [0, 0.25, 1, 3.5, 5]) {
    setRootRopeShape(batch, range, curve, touches); finishRootRopeUpdate(batch); finite(batch);
  }
  mutate(curve, [[2, -40, 3], [5, -45, -2], [-6, -50, 9], [7, -60, 4]]);
  setRootRopeShape(batch, range, curve, 5); finishRootRopeUpdate(batch);
  finite(batch); assertCaliber(batch, range);
  for (const vine of range.vines) {
    const vertex = vine.vertexStart + range.segments * (range.sides + 1);
    near(batch.profiles[vertex], 0.06, 1e-7);
    assert.ok(at(batch.centers, vertex).distanceTo(curve.v3) < range.radius * 0.061);
  }
  batch.geometry.dispose();
});

test('mutable curves refresh arc caches and rewind restores positions, normals, colors and topology exactly', () => {
  const curve = cubic([[0, 0, 0], [1, -4, 3], [5, -9, -2], [6, -14, 3]]);
  const original = [curve.v0, curve.v1, curve.v2, curve.v3].map(point => point.toArray());
  const batch = createRootRopeBatch([edge('root', curve, 9, 2)]);
  const range = batch.ranges.get('root'), uuid = batch.geometry.uuid;
  setRootRopeColor(batch, range, new THREE.Color('#ccddff')); finishRootRopeUpdate(batch);
  const positions = batch.geometry.attributes.position.array.slice(), normals = batch.geometry.attributes.normal.array.slice();
  const colors = batch.geometry.attributes.color.array.slice(), indices = batch.geometry.index.array.slice();
  const oldLength = curve.getLength();
  const points = [[4, -2, 8], [13, -7, -5], [-11, -29, 16], [14, -40, 9]];
  mutate(curve, points); near(curve.getLength(), oldLength, 1e-10);
  setRootRopeShape(batch, range, curve, 8.5, 11); finishRootRopeUpdate(batch);
  near(curve.getLength(), cubic(points).getLength(), 1e-10);
  mutate(curve, original); setRootRopeShape(batch, range, curve, 2, 0); finishRootRopeUpdate(batch);
  assert.deepEqual(batch.geometry.attributes.position.array, positions);
  assert.deepEqual(batch.geometry.attributes.normal.array, normals);
  assert.deepEqual(batch.geometry.attributes.color.array, colors);
  assert.deepEqual(batch.geometry.index.array, indices);
  assert.equal(batch.geometry.uuid, uuid);
  const version = batch.geometry.attributes.position.version;
  setRootRopeShape(batch, range, curve, 2, 0); finishRootRopeUpdate(batch);
  assert.equal(batch.geometry.attributes.position.version, version);
  batch.geometry.dispose();
});

test('inactive capacity is invisible and changes to one edge preserve neighboring geometry and picking ranges', () => {
  const a = straight(), b = straight(17, -20);
  const batch = createRootRopeBatch([edge('a', a, 8), edge('b', b, 3, 2)]);
  const first = batch.ranges.get('a'), second = batch.ranges.get('b');
  assert.equal(first.faceEnd, second.faceStart);
  const start = second.vertexStart * 3, end = (second.vertexStart + second.vertexCount) * 3;
  const otherPositions = batch.geometry.attributes.position.array.slice(start, end);
  for (const vine of first.vines.filter(vine => !vine.visible)) {
    const reference = at(batch.geometry.attributes.position.array, vine.vertexStart);
    for (let i = 1; i < vine.vertexCount; i++) assert.deepEqual(at(batch.geometry.attributes.position.array, vine.vertexStart + i), reference);
  }
  a.v1.x = 7; a.v2.x = -3;
  setRootRopeShape(batch, first, a, 8, 3); finishRootRopeUpdate(batch);
  assert.deepEqual(batch.geometry.attributes.position.array.slice(start, end), otherPositions);
  for (const range of batch.ranges.values()) for (const vine of range.vines.filter(vine => vine.visible)) for (let vertex = vine.vertexStart; vertex < vine.vertexStart + vine.vertexCount; vertex++) {
    assert.ok(batch.geometry.boundingBox.containsPoint(at(batch.geometry.attributes.position.array, vertex)));
  }
  assert.throws(() => setRootRopeShape(batch, first, a, 9), /reserved history capacity/);
  batch.geometry.dispose();
});

test('2501 baseline files reserve their own histories rather than a global twenty-two-touch capacity', () => {
  const edges = Array.from({ length: 2501 }, (_, index) => edge(String(index), straight(16, -index / 100), index === 0 ? 22 : 0));
  const batch = createRootRopeBatch(edges);
  assert.equal(batch.ranges.size, 2501);
  assert.equal([...batch.ranges.values()].reduce((sum, range) => sum + range.capacity, 0), 2523);
  assert.ok(batch.geometry.attributes.position.count < 350000);
  assert.ok(batch.geometry.index.array instanceof Uint32Array);
  assert.ok(batch.geometry.attributes.position.array.every(Number.isFinite));
  assert.ok(batch.geometry.attributes.normal.array.every(Number.isFinite));
  batch.geometry.dispose();
});


test('moving a baseline edge uploads only its live vine and dormant slots reactivate correctly', () => {
  const curve = straight();
  const batch = createRootRopeBatch([edge('root', curve, 12)]);
  const range = batch.ranges.get('root');
  const position = batch.geometry.attributes.position, normal = batch.geometry.attributes.normal;
  const inactiveStart = range.vines[1].vertexStart * 3;
  const dormantPositions = position.array.slice(inactiveStart), dormantNormals = normal.array.slice(inactiveStart);
  // WebGL clears these after consuming the initial upload.
  position.clearUpdateRanges(); normal.clearUpdateRanges();
  mutate(curve, [[4, -3, 2], [8, -9, 6], [-2, -18, 9], [5, -25, 4]]);
  setRootRopeShape(batch, range, curve, 0, 7); finishRootRopeUpdate(batch);
  assert.deepEqual(position.updateRanges, [{ start: 0, count: range.vines[0].vertexCount * 3 }]);
  assert.deepEqual(normal.updateRanges, position.updateRanges);
  assert.deepEqual(position.array.slice(inactiveStart), dormantPositions);
  assert.deepEqual(normal.array.slice(inactiveStart), dormantNormals);
  setRootRopeColor(batch, range, new THREE.Color('#aaccee'));
  setRootRopeShape(batch, range, curve, 6.5, 7); finishRootRopeUpdate(batch);
  const grownPositions = position.array.slice(), grownNormals = normal.array.slice();
  const grownColors = batch.geometry.attributes.color.array.slice();
  assert.equal(range.vineCount, 8);
  assert.equal(range.vines[7].growth, .5);
  assertCaliber(batch, range); finite(batch);
  setRootRopeShape(batch, range, curve, 0, 7); finishRootRopeUpdate(batch);
  assert.deepEqual(position.array.slice(inactiveStart), dormantPositions);
  assert.deepEqual(normal.array.slice(inactiveStart), dormantNormals);
  setRootRopeShape(batch, range, curve, 6.5, 7); finishRootRopeUpdate(batch);
  assert.deepEqual(position.array, grownPositions);
  assert.deepEqual(normal.array, grownNormals);
  assert.deepEqual(batch.geometry.attributes.color.array, grownColors);
  batch.geometry.dispose();
});

test('partial uploads retain changes to separate edges until the renderer consumes them', () => {
  const a = straight(), b = straight(16, -20), c = straight(16, -40);
  const batch = createRootRopeBatch([edge('a', a, 4), edge('b', b, 4), edge('c', c, 4)]);
  const position = batch.geometry.attributes.position, normal = batch.geometry.attributes.normal;
  const color = batch.geometry.attributes.color;
  for (const attribute of [position, normal, color]) attribute.clearUpdateRanges();
  a.v1.x = 3; c.v2.z = -5;
  const first = batch.ranges.get('a'), last = batch.ranges.get('c');
  setRootRopeShape(batch, first, a, 1); finishRootRopeUpdate(batch);
  setRootRopeShape(batch, last, c, 0); finishRootRopeUpdate(batch);
  const expected = [
    { start: first.vertexStart * 3, count: first.vines[0].vertexCount * 3 * 2 },
    { start: last.vertexStart * 3, count: last.vines[0].vertexCount * 3 },
  ];
  assert.deepEqual(position.updateRanges, expected);
  assert.deepEqual(normal.updateRanges, expected);
  setRootRopeColor(batch, first, new THREE.Color('#ffeecc')); finishRootRopeUpdate(batch);
  assert.deepEqual(color.updateRanges, [{ start: first.vertexStart * 3, count: first.vertexCount * 3 }]);
  assert.deepEqual(position.updateRanges, expected, 'color changes must not discard pending shape uploads');
  const version = position.version;
  setRootRopeShape(batch, last, c, 0); finishRootRopeUpdate(batch);
  assert.equal(position.version, version, 'unchanged frames must not trigger buffer uploads');
  finite(batch); batch.geometry.dispose();
});


test('proportional radial scaling preserves the twisted bundle count and exact rewind', () => {
  const curve = cubic([[0, 0, 0], [4, -8, 3], [-5, -18, 7], [2, -32, -4]]);
  const batch = createRootRopeBatch([{ ...edge('root', curve, 1, 1), radialScale: 1 }], { pointed: true });
  const range = batch.ranges.get('root'), uuid = batch.geometry.uuid;
  const baselinePositions = batch.geometry.attributes.position.array.slice();
  const baselineNormals = batch.geometry.attributes.normal.array.slice();
  const baselineCenters = batch.centers.slice(), baselineProfiles = batch.profiles.slice();
  const offset = [...range.vines[0].offset];
  const indices = batch.geometry.index.array.slice();
  for (const scale of [1.05, 1.12, 1.43, 2]) {
    setRootRopeShape(batch, range, curve, 1, 0, scale); finishRootRopeUpdate(batch);
    assert.equal(range.vineCount, 2);
    assert.equal(range.capacity, 2);
    assert.equal(range.radialScale, scale);
    near(range.radius, rootRopeRadius(1) * scale, 1e-12);
    near(rootRopeRadius(1, scale), range.radius, 1e-12);
    near(range.vines[0].offset[0], offset[0] * scale, 1e-12);
    near(range.vines[0].offset[1], offset[1] * scale, 1e-12);
    for (const vine of range.vines) for (let ring = 0; ring <= range.segments; ring++) {
      const vertex = vine.vertexStart + ring * (range.sides + 1);
      const center = at(batch.centers, vertex), axis = at(range.axisCenters, ring);
      const before = at(baselineCenters, vertex);
      near(center.distanceTo(axis), before.distanceTo(axis) * scale, 4e-6);
      near(batch.profiles[vertex], baselineProfiles[vertex] * scale, 2e-7);
    }
    assertCaliber(batch, range); finite(batch);
    assert.equal(batch.geometry.uuid, uuid);
    assert.deepEqual(batch.geometry.index.array, indices);
  }
  const version = batch.geometry.attributes.position.version;
  setRootRopeShape(batch, range, curve, 1, 0, 2); finishRootRopeUpdate(batch);
  assert.equal(batch.geometry.attributes.position.version, version, 'the same scale must not upload unchanged buffers');
  setRootRopeShape(batch, range, curve, 1, 0, 1); finishRootRopeUpdate(batch);
  assert.deepEqual(batch.geometry.attributes.position.array, baselinePositions);
  assert.deepEqual(batch.geometry.attributes.normal.array, baselineNormals);
  assert.deepEqual(batch.centers, baselineCenters);
  assert.deepEqual(batch.profiles, baselineProfiles);
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.throws(() => setRootRopeShape(batch, range, curve, 1, 0, invalid), /positive and finite/);
    assert.throws(() => rootRopeRadius(1, invalid), /positive and finite/);
  }
  batch.geometry.dispose();
});

test('a fixed bundle can start thickened and retain finite normals while its curve grows from a point', () => {
  const points = [[2, -40, 3], [2, -40, 3], [2, -40, 3], [2, -40, 3]];
  const curve = cubic(points);
  const batch = createRootRopeBatch([{ ...edge('root', curve, 1, 1), radialScale: 1.2 }], { pointed: true });
  const range = batch.ranges.get('root');
  near(range.radius, rootRopeRadius(1, 1.2), 1e-12);
  assert.equal(range.vineCount, 2); finite(batch);
  mutate(curve, [[2, -40, 3], [4, -45, 5], [-1, -58, 8], [3, -73, 4]]);
  setRootRopeShape(batch, range, curve, 1, 17.25, 1.3); finishRootRopeUpdate(batch);
  assert.equal(range.vineCount, 2); assertCaliber(batch, range); finite(batch);
  batch.geometry.dispose();
});


test('long classification edges keep a fixed smooth twist within a bounded geometry budget', () => {
  const curve = straight(10000), maximumLength = 20000;
  const pitch = (maximumLength + rootRopeRadius(1) * 4) * 12 / 256;
  const batch = createRootRopeBatch([{ ...edge('classification', curve, 1, 1), maxLength: maximumLength, pitch, segments: 256 }]);
  const range = batch.ranges.get('classification'), id = batch.geometry.uuid;
  assert.equal(range.segments, 256); assert.equal(range.pitch, pitch);
  assert.equal(range.vertexCount, 257 * 7 * 2);
  for (const length of [20000, 10000, 0, 20000]) {
    mutate(curve, [[0, 0, 0], [0, -length / 3, 0], [0, -2 * length / 3, 0], [0, -length, 0]]);
    setRootRopeShape(batch, range, curve, 1); finishRootRopeUpdate(batch);
    assert.ok(!length || range.segments / (length / range.pitch) >= 12);
    assert.equal(range.radius, rootRopeRadius(1)); assert.equal(range.vineCount, 2);
    assert.equal(batch.geometry.uuid, id); finite(batch);
  }
  batch.geometry.dispose();
});

test('optional native RGBA preserves geometry and updates alpha independently across replay capacity', () => {
  const input = [edge('a', straight(12), 3, 0), edge('b', straight(15, -12), 1, 1)];
  const rgb = createRootRopeBatch(input), rgba = createRootRopeBatch(input, { vertexAlpha: true });
  assert.equal(rgb.geometry.attributes.color.itemSize, 3);
  assert.equal(rgba.geometry.attributes.color.itemSize, 4);
  for (const name of ['position', 'normal']) assert.deepEqual(rgba.geometry.attributes[name].array, rgb.geometry.attributes[name].array);
  assert.deepEqual(rgba.geometry.index.array, rgb.geometry.index.array);
  const attribute = rgba.geometry.attributes.color, range = rgba.ranges.get('b');
  const color = range.color.clone(), positions = rgba.geometry.attributes.position.array.slice();
  attribute.clearUpdateRanges();
  setRootRopeColor(rgba, range, color, .18); finishRootRopeUpdate(rgba);
  assert.equal(range.alpha, .18);
  assert.deepEqual(attribute.updateRanges, [{ start: range.vertexStart * 4, count: range.vertexCount * 4 }]);
  for (const record of rgba.ranges.values()) for (let vertex = record.vertexStart; vertex < record.vertexStart + record.vertexCount; vertex++) {
    near(attribute.array[vertex * 4 + 3], record === range ? .18 : 1);
    for (let channel = 0; channel < 3; channel++) near(attribute.array[vertex * 4 + channel], rgb.geometry.attributes.color.array[vertex * 3 + channel]);
  }
  const version = attribute.version;
  setRootRopeColor(rgba, range, color, .18); finishRootRopeUpdate(rgba);
  assert.equal(attribute.version, version, 'unchanged alpha and hue must not trigger another upload');
  for (const alpha of [.65, 1, .18]) {
    setRootRopeColor(rgba, range, color, alpha); finishRootRopeUpdate(rgba);
    near(attribute.array[range.vertexStart * 4 + 3], alpha);
  }
  const a = rgba.ranges.get('a');
  setRootRopeColor(rgba, a, a.color, .18);
  setRootRopeShape(rgba, a, input[0].curve, 3); finishRootRopeUpdate(rgba);
  for (const vine of a.vines) near(attribute.array[vine.vertexStart * 4 + 3], .18, 1e-6);
  assert.deepEqual(rgba.geometry.attributes.position.array.slice(range.vertexStart * 3), positions.slice(range.vertexStart * 3), 'opacity edits never move another strand');
  const original = rgb.geometry.attributes.color.array.slice();
  setRootRopeColor(rgb, rgb.ranges.get('a'), rgb.ranges.get('a').color, .18); finishRootRopeUpdate(rgb);
  assert.deepEqual(rgb.geometry.attributes.color.array, original, 'legacy RGB batches preserve their exact output');
  finite(rgba); rgb.geometry.dispose(); rgba.geometry.dispose();
});
