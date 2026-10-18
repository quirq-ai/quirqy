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
