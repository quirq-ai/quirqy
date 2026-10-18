import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ROOT_STRAND_RADIUS, rootStrandRadius, createRootStrandBatch,
  setRootStrandCurve, setRootStrandRadius, setRootStrandColor, finishRootStrandUpdate,
} from './root-geometry.js';

const cubic = points => new THREE.CubicBezierCurve3(...points.map(point => new THREE.Vector3(...point)));
const bent = () => cubic([[0, 0, 0], [1, -3, 1], [4, -7, -1], [7, -10, 2]]);
const edge = (key, curve = bent(), color = '#a77350') => ({ key, curve, color: new THREE.Color(color) });
const vectorAt = (array, vertex) => new THREE.Vector3().fromArray(array, vertex * 3);
const close = (a, b, epsilon = 1e-5) => assert.ok(Math.abs(a - b) <= epsilon, `${a} differs from ${b}`);
const closeVector = (a, b, epsilon = 1e-5) => { close(a.x, b.x, epsilon); close(a.y, b.y, epsilon); close(a.z, b.z, epsilon); };
const mutate = (curve, points) => points.forEach((point, index) => curve[`v${index}`].fromArray(point));

function assertFiniteSurface(batch) {
  for (const attribute of Object.values(batch.geometry.attributes)) assert.ok(attribute.array.every(Number.isFinite));
  for (const buffer of [batch.centers, batch.radial, batch.tangent, batch.profiles, batch.slopes]) assert.ok(buffer.every(Number.isFinite));
  for (let vertex = 0; vertex < batch.geometry.attributes.normal.count; vertex++) close(vectorAt(batch.geometry.attributes.normal.array, vertex).length(), 1, 1e-6);
  assert.ok(batch.geometry.boundingBox.min.toArray().every(Number.isFinite));
  assert.ok(batch.geometry.boundingBox.max.toArray().every(Number.isFinite));
  assert.ok(Number.isFinite(batch.geometry.boundingSphere.radius));
}

function assertExactBounds(batch) {
  const actual = new THREE.Box3().setFromBufferAttribute(batch.geometry.attributes.position);
  assert.deepEqual(batch.geometry.boundingBox, actual);
  for (let vertex = 0; vertex < batch.geometry.attributes.position.count; vertex++) {
    const point = vectorAt(batch.geometry.attributes.position.array, vertex);
    assert.ok(actual.containsPoint(point));
    assert.ok(point.distanceTo(batch.geometry.boundingSphere.center) <= batch.geometry.boundingSphere.radius + 1e-5);
  }
}

test('warping follows mutable cubic endpoints and refreshes cached arc lengths in the same buffers', () => {
  const curve = bent();
  const batch = createRootStrandBatch([edge('file', curve)], { pointed: true });
  const range = batch.ranges.get('file');
  const geometry = batch.geometry, uuid = geometry.uuid;
  const attributes = { ...geometry.attributes }, indices = geometry.index;
  const originalLength = curve.getLength();
  const target = [[3, -2, 4], [17, -8, -9], [-12, -32, 24], [21, -40, 10]];
  mutate(curve, target);
  // The same Three curve deliberately still holds its old cached length here.
  close(curve.getLength(), originalLength);
  setRootStrandCurve(batch, range, curve);
  assert.ok(batch.shapeDirty);
  finishRootStrandUpdate(batch);
  const expected = cubic(target);
  close(curve.getLength(), expected.getLength(), 1e-10);
  for (let ring = 0; ring <= range.segments; ring++) {
    const vertex = range.vertexStart + ring * (range.sides + 1);
    closeVector(vectorAt(batch.centers, vertex), expected.getPointAt(ring / range.segments));
  }
  assert.equal(batch.geometry, geometry);
  assert.equal(geometry.uuid, uuid);
  assert.equal(geometry.index, indices);
  for (const key of Object.keys(attributes)) assert.equal(geometry.attributes[key], attributes[key]);
  assert.equal(range.radius, ROOT_STRAND_RADIUS);
  assert.equal(range.curve, curve);
  assert.equal(batch.shapeDirty, false);
  assertFiniteSurface(batch);
  assertExactBounds(batch);
  geometry.dispose();
});

test('deformed strands retain exact radial growth and support a simultaneous shape and radius update', () => {
  const curve = bent();
  const batch = createRootStrandBatch([edge('file', curve)], { pointed: true });
  const range = batch.ranges.get('file');
  const radii = [ROOT_STRAND_RADIUS, rootStrandRadius(1), rootStrandRadius(2), rootStrandRadius(20)];
  for (const radius of radii) {
    curve.v1.x += 0.4;
    setRootStrandCurve(batch, range, curve, radius);
    finishRootStrandUpdate(batch);
    for (let vertex = range.vertexStart; vertex < range.vertexStart + range.vertexCount; vertex++) {
      const distance = vectorAt(batch.geometry.attributes.position.array, vertex).distanceTo(vectorAt(batch.centers, vertex));
      close(distance, radius * batch.profiles[vertex], Math.max(2e-6, radius * 2e-7));
    }
    assert.equal(range.radius, radius);
    assertFiniteSurface(batch);
    assertExactBounds(batch);
  }
  setRootStrandRadius(batch, range, ROOT_STRAND_RADIUS);
  finishRootStrandUpdate(batch);
  assertExactBounds(batch);
  assert.ok(batch.geometry.boundingSphere.radius < 10);
  batch.geometry.dispose();
});

test('collapsed, reversed and nearly axial curves keep finite unit lighting normals while opening', () => {
  const shapes = [
    [[0, -40, 0], [0, -40, 0], [0, -40, 0], [0, -40, 0]],
    [[0, -40, 0], [0, -40, 0], [0, -40, 0], [0, -40, 0.000001]],
    [[0, 0, 0], [0, 0, 3], [0, 0, 6], [0, 0, 9]],
    [[0, 0, 0], [3, 0, 0], [-3, 0, 0], [0, 0, 0]],
    [[0, -40, 0], [4, -45, 6], [-7, -49, -5], [11, -57, 4]],
  ];
  const curve = cubic(shapes[0]);
  const batch = createRootStrandBatch([edge('new', curve)], { pointed: true });
  const range = batch.ranges.get('new');
  for (const points of shapes) {
    mutate(curve, points);
    setRootStrandCurve(batch, range, curve);
    finishRootStrandUpdate(batch);
    assertFiniteSurface(batch);
    assertExactBounds(batch);
    closeVector(vectorAt(batch.centers, range.vertexStart), curve.v0);
    closeVector(vectorAt(batch.centers, range.vertexStart + range.segments * (range.sides + 1)), curve.v3);
  }
  batch.geometry.dispose();
});

test('moving one edge preserves neighboring geometry, all colors and topology', () => {
  const curve = bent();
  const batch = createRootStrandBatch([edge('moving', curve), edge('fixed', cubic([[30, 0, 0], [33, -3, 0], [34, -6, 1], [35, -9, 1]]), '#67b0b7')]);
  const moving = batch.ranges.get('moving'), fixed = batch.ranges.get('fixed');
  setRootStrandColor(batch, moving, new THREE.Color('#ffffff'));
  finishRootStrandUpdate(batch);
  const colors = batch.geometry.attributes.color.array.slice();
  const topology = batch.geometry.index.array.slice();
  const start = fixed.vertexStart * 3, end = (fixed.vertexStart + fixed.vertexCount) * 3;
  const positions = batch.geometry.attributes.position.array.slice(start, end);
  const normals = batch.geometry.attributes.normal.array.slice(start, end);
  mutate(curve, [[55, 2, 6], [57, -4, 3], [60, -8, -2], [65, -13, 8]]);
  setRootStrandCurve(batch, moving, curve, 0.1);
  finishRootStrandUpdate(batch);
  assert.deepEqual(batch.geometry.attributes.position.array.slice(start, end), positions);
  assert.deepEqual(batch.geometry.attributes.normal.array.slice(start, end), normals);
  assert.deepEqual(batch.geometry.attributes.color.array, colors);
  assert.deepEqual(batch.geometry.index.array, topology);
  assert.equal(moving.faceEnd, fixed.faceStart);
  assert.ok(batch.geometry.boundingBox.min.x > 29, 'old curve positions must leave the bounds');
  assertExactBounds(batch);
  batch.geometry.dispose();
});

test('rewinding a curve restores the original surface and unchanged calls avoid uploads', () => {
  const curve = bent();
  const original = [curve.v0, curve.v1, curve.v2, curve.v3].map(point => point.toArray());
  const batch = createRootStrandBatch([edge('file', curve)], { pointed: true });
  const range = batch.ranges.get('file');
  const positions = batch.geometry.attributes.position.array.slice();
  const normals = batch.geometry.attributes.normal.array.slice();
  const uuid = batch.geometry.uuid;
  for (let frame = 0; frame < 50; frame++) {
    curve.v1.set(Math.sin(frame) * 9, -3, Math.cos(frame) * 3);
    curve.v2.set(Math.cos(frame) * 7, -7, Math.sin(frame) * 4);
    setRootStrandCurve(batch, range, curve, ROOT_STRAND_RADIUS * (1 + frame / 20));
    finishRootStrandUpdate(batch);
  }
  mutate(curve, original);
  setRootStrandCurve(batch, range, curve, ROOT_STRAND_RADIUS);
  finishRootStrandUpdate(batch);
  assert.deepEqual(batch.geometry.attributes.position.array, positions);
  assert.deepEqual(batch.geometry.attributes.normal.array, normals);
  assert.equal(batch.geometry.uuid, uuid);
  const version = batch.geometry.attributes.position.version;
  setRootStrandCurve(batch, range, curve);
  finishRootStrandUpdate(batch);
  assert.equal(batch.geometry.attributes.position.version, version);
  batch.geometry.dispose();
});

test('tube topology faces outward and taper slope follows the new curve length', () => {
  const curve = cubic([[0, 0, 0], [0, -2, 0], [0, -4, 0], [0, -6, 0]]);
  const batch = createRootStrandBatch([edge('file', curve)], { pointed: true, sides: 8 });
  const range = batch.ranges.get('file');
  const ring = 13, vertex = ring * (range.sides + 1);
  const originalSlope = batch.slopes[vertex];
  for (const point of [curve.v0, curve.v1, curve.v2, curve.v3]) point.multiplyScalar(2);
  setRootStrandCurve(batch, range, curve);
  finishRootStrandUpdate(batch);
  close(batch.slopes[vertex], originalSlope / 2, 1e-8);
  const indices = batch.geometry.index.array, positions = batch.geometry.attributes.position.array;
  for (let face = 0; face < indices.length; face += 3) {
    const a = vectorAt(positions, indices[face]), b = vectorAt(positions, indices[face + 1]), c = vectorAt(positions, indices[face + 2]);
    const faceNormal = b.sub(a).cross(c.sub(a)).normalize();
    const surfaceNormal = vectorAt(batch.geometry.attributes.normal.array, indices[face]);
    assert.ok(faceNormal.dot(surfaceNormal) > 0.8);
  }
  batch.geometry.dispose();
});

test('C1-connected strands share identical cross-section rings at their junction', () => {
  const incoming = cubic([[0, 0, 0], [-2, -2, 7], [4, -5, 3], [7, -9, 4]]);
  const outgoing = cubic([[7, -9, 4], [10, -13, 5], [-5, -20, 9], [15, -25, 4]]);
  const batch = createRootStrandBatch([edge('in', incoming), edge('out', outgoing)], { sides: 12 });
  const first = batch.ranges.get('in'), second = batch.ranges.get('out');
  for (let frame = 0; frame < 10; frame++) {
    incoming.v2.x += 0.25;
    outgoing.v1.subVectors(incoming.v3, incoming.v2).add(incoming.v3);
    const radius = rootStrandRadius(frame);
    setRootStrandCurve(batch, first, incoming, radius);
    setRootStrandCurve(batch, second, outgoing, radius);
    finishRootStrandUpdate(batch);
    for (let side = 0; side <= first.sides; side++) {
      const end = first.vertexStart + first.segments * (first.sides + 1) + side;
      const start = second.vertexStart + side;
      assert.deepEqual(vectorAt(batch.geometry.attributes.position.array, end), vectorAt(batch.geometry.attributes.position.array, start));
      assert.deepEqual(vectorAt(batch.geometry.attributes.normal.array, end), vectorAt(batch.geometry.attributes.normal.array, start));
    }
  }
  batch.geometry.dispose();
});
