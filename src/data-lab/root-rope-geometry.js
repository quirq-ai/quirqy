import * as THREE from 'three';

export const ROOT_VINE_RADIUS = 0.14;
export const ROOT_ROPE_PITCH = 8;
const GAP = 1.06;
const TAU = Math.PI * 2;
const packings = new Map([[1, [[0, 0]]]]);
const touchValue = value => Math.max(0, Number(value) || 0);

function packing(count) {
  if (packings.has(count)) return packings.get(count);
  const ring = (amount, radius, phase = 0) => Array.from({ length: amount }, (_, index) => {
    const angle = index / amount * TAU + phase;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
  const separation = ROOT_VINE_RADIUS * GAP;
  let points;
  if (count <= 6) points = ring(count, separation / Math.sin(Math.PI / count));
  else if (count <= 13) points = [[0, 0], ...ring(count - 1, Math.max(2 * separation, separation / Math.sin(Math.PI / (count - 1))))];
  else {
    const inner = packing(count - 12);
    const innerRadius = Math.max(...inner.map(point => Math.hypot(...point)));
    const outerRadius = Math.max(innerRadius + 2 * separation, separation / Math.sin(Math.PI / 12));
    points = [...inner, ...ring(12, outerRadius, Math.PI / 12)];
  }
  packings.set(count, points);
  return points;
}

function packingState(touches) {
  const lower = Math.floor(touches), amount = touches - lower;
  const from = packing(lower + 1), to = packing(lower + (amount > 0 ? 2 : 1));
  let outerRadius = 0;
  const offsets = to.map((b, index) => {
    const a = from[index] || [0, 0];
    const fromRadius = Math.hypot(...a), toRadius = Math.hypot(...b);
    const radius = fromRadius + (toRadius - fromRadius) * amount;
    const fromAngle = fromRadius ? Math.atan2(a[1], a[0]) : Math.atan2(b[1], b[0]);
    const toAngle = toRadius ? Math.atan2(b[1], b[0]) : fromAngle;
    const delta = Math.atan2(Math.sin(toAngle - fromAngle), Math.cos(toAngle - fromAngle));
    const angle = fromAngle + delta * amount;
    outerRadius = Math.max(outerRadius, radius);
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
  // Polar reflow retains the outside ring while vines move around one another.
  return { offsets, outerRadius };
}

/** Physical envelope of equally thin vines; touches add vines, never their caliber. */
export function rootRopeRadius(touches = 0) {
  const count = touchValue(touches);
  if (!Number.isFinite(count)) throw new RangeError('Root rope touches must be finite.');
  return packingState(count).outerRadius + ROOT_VINE_RADIUS;
}

/**
 * Reserve each edge's actual history capacity in one indexed geometry. maxTouches
 * must cover future replay states; no per-vine meshes or frame-time allocations
 * of geometry are needed. A baseline-only edge uses sixteen longitudinal steps.
 */
export function createRootRopeBatch(edges, { pointed = false, sides = 6, segments, pitch = ROOT_ROPE_PITCH, samplesPerTurn = 12 } = {}) {
  if (!edges.length) return null;
  const ranges = new Map();
  let vertexCount = 0, indexCount = 0;
  for (const edge of edges) {
    const touches = touchValue(edge.touches), maximum = Math.ceil(Math.max(touches, touchValue(edge.maxTouches ?? touches)));
    if (!Number.isFinite(maximum)) throw new RangeError('Root rope capacity must be finite.');
    edge.curve.updateArcLengths();
    const capacity = maximum + 1;
    const length = edge.curve.getLength();
    const divisions = Math.max(4, Math.ceil(segments ?? (maximum ? Math.max(16, (Math.max(length * 2, edge.maxLength || 0) + rootRopeRadius(maximum) * 4) / pitch * samplesPerTurn) : 16)));
    const verticesPerVine = (divisions + 1) * (sides + 1), indicesPerVine = divisions * sides * 6;
    const range = {
      key: edge.key, vertexStart: vertexCount, vertexCount: verticesPerVine * capacity,
      faceStart: indexCount / 3, faceEnd: (indexCount + indicesPerVine * capacity) / 3,
      capacity, maxTouches: maximum, segments: divisions, sides, pointed, pitch,
      touches: NaN, vineCount: 0, radius: ROOT_VINE_RADIUS, distanceOffset: NaN,
      color: new THREE.Color(-1, -1, -1), curveSignature: new Float64Array(12).fill(NaN),
      bounds: new THREE.Box3(), centerBounds: new THREE.Box3(), vines: [],
      axisCenters: new Float64Array((divisions + 1) * 3),
      axisNormals: new Float64Array((divisions + 1) * 3),
      axisBinormals: new Float64Array((divisions + 1) * 3),
      vineCenters: new Float64Array((divisions + 1) * 3),
      vineProfiles: new Float64Array(divisions + 1),
    };
    for (let index = 0; index < capacity; index++) range.vines.push({
      index, vertexStart: vertexCount + index * verticesPerVine, vertexCount: verticesPerVine,
      faceStart: (indexCount + index * indicesPerVine) / 3,
      faceEnd: (indexCount + (index + 1) * indicesPerVine) / 3,
      segments: divisions, sides, growth: 0, visible: false, offset: [0, 0],
    });
    ranges.set(edge.key, range);
    vertexCount += range.vertexCount;
    indexCount += indicesPerVine * capacity;
  }
  const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3), colors = new Float32Array(vertexCount * 3);
  const centers = new Float32Array(vertexCount * 3), profiles = new Float32Array(vertexCount), shades = new Float32Array(vertexCount);
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let cursor = 0;
  for (const range of ranges.values()) for (const vine of range.vines) {
    for (let ring = 0; ring <= range.segments; ring++) for (let side = 0; side <= sides; side++) {
      const vertex = vine.vertexStart + ring * (sides + 1) + side;
      shades[vertex] = (0.9 + 0.07 * Math.sin(vine.index * 2.4)) * (0.98 + 0.035 * Math.cos(side / sides * TAU));
    }
    for (let ring = 1; ring <= range.segments; ring++) for (let side = 1; side <= sides; side++) {
      const a = vine.vertexStart + (ring - 1) * (sides + 1) + side - 1;
      const b = vine.vertexStart + ring * (sides + 1) + side - 1;
      indices[cursor++] = a; indices[cursor++] = b; indices[cursor++] = a + 1;
      indices[cursor++] = b; indices[cursor++] = b + 1; indices[cursor++] = a + 1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  const batch = {
    geometry, ranges, centers, profiles, shades, positionDirty: false, colorDirty: false,
    centerBounds: new THREE.Box3(),
    scratch: { center: new THREE.Vector3(), tangent: new THREE.Vector3(), normal: new THREE.Vector3(), binormal: new THREE.Vector3() },
    cosines: Float64Array.from({ length: sides + 1 }, (_, side) => -Math.cos(side / sides * TAU)),
    sines: Float64Array.from({ length: sides + 1 }, (_, side) => Math.sin(side / sides * TAU)),
  };
  for (const edge of edges) {
    const range = ranges.get(edge.key);
    setRootRopeShape(batch, range, edge.curve, touchValue(edge.touches), edge.distanceOffset ?? edge.phaseOffset ?? 0);
    setRootRopeColor(batch, range, edge.color);
  }
  finishRootRopeUpdate(batch);
  return batch;
}

function axisFrame(curve, fraction, scratch) {
  const { center, tangent, normal, binormal } = scratch;
  const t = curve.getUtoTmapping(fraction), inverse = 1 - t;
  curve.getPoint(t, center);
  const a = 3 * inverse * inverse, b = 6 * inverse * t, c = 3 * t * t;
  tangent.set(
    a * (curve.v1.x - curve.v0.x) + b * (curve.v2.x - curve.v1.x) + c * (curve.v3.x - curve.v2.x),
    a * (curve.v1.y - curve.v0.y) + b * (curve.v2.y - curve.v1.y) + c * (curve.v3.y - curve.v2.y),
    a * (curve.v1.z - curve.v0.z) + b * (curve.v2.z - curve.v1.z) + c * (curve.v3.z - curve.v2.z),
  );
  if (tangent.lengthSq() < 1e-16) tangent.subVectors(curve.v3, curve.v0);
  if (tangent.lengthSq() < 1e-16) tangent.set(0, -1, 0);
  tangent.normalize();
  radialFrame(tangent, normal, binormal);
}

function radialFrame(tangent, normal, binormal) {
  normal.set(0, 0, 1).addScaledVector(tangent, -tangent.z);
  if (normal.lengthSq() < 1e-10) normal.set(1, 0, 0).addScaledVector(tangent, -tangent.x);
  normal.normalize();
  binormal.crossVectors(tangent, normal).normalize();
}

function taper(fraction) {
  const u = THREE.MathUtils.clamp((fraction - 0.72) / 0.28, 0, 1);
  return 1 - 0.94 * u * u * (3 - 2 * u);
}

/** Fifth argument is accumulated WORLD ARC DISTANCE, not an angle. */
export function setRootRopeShape(batch, range, curve, touchesFloat, distanceOffset = 0) {
  if (!batch || !range) return;
  const touches = touchValue(touchesFloat);
  if (!Number.isFinite(touches) || touches > range.maxTouches) throw new RangeError(`Root rope ${range.key} exceeds its reserved history capacity.`);
  const controls = [curve.v0, curve.v1, curve.v2, curve.v3];
  let curveChanged = false;
  for (let i = 0; i < 4; i++) {
    const p = controls[i], offset = i * 3;
    if (range.curveSignature[offset] !== p.x || range.curveSignature[offset + 1] !== p.y || range.curveSignature[offset + 2] !== p.z) curveChanged = true;
  }
  if (!curveChanged && touches === range.touches && distanceOffset === range.distanceOffset) return;
  const { center, tangent, normal, binormal } = batch.scratch;
  const { segments, sides } = range;
  if (curveChanged) {
    curve.updateArcLengths();
    range.length = curve.getLength();
    range.centerBounds.makeEmpty();
    for (let ring = 0; ring <= segments; ring++) {
      axisFrame(curve, ring / segments, batch.scratch);
      center.toArray(range.axisCenters, ring * 3);
      normal.toArray(range.axisNormals, ring * 3);
      binormal.toArray(range.axisBinormals, ring * 3);
      range.centerBounds.expandByPoint(center);
    }
    for (let i = 0; i < 4; i++) controls[i].toArray(range.curveSignature, i * 3);
  }
  const { offsets } = packingState(touches);
  const positions = batch.geometry.attributes.position.array, normals = batch.geometry.attributes.normal.array;
  const min = range.bounds.min.set(Infinity, Infinity, Infinity), max = range.bounds.max.set(-Infinity, -Infinity, -Infinity);
  range.vineCount = 0;
  for (const vine of range.vines) {
    const growth = THREE.MathUtils.clamp(touches + 1 - vine.index, 0, 1);
    vine.growth = growth; vine.visible = growth > 0;
    if (!vine.visible) {
      // Reserve future slots without visible geometry or invalid zero normals.
      for (let vertex = vine.vertexStart; vertex < vine.vertexStart + vine.vertexCount; vertex++) {
        const offset = vertex * 3;
        positions[offset] = batch.centers[offset] = curve.v0.x;
        positions[offset + 1] = batch.centers[offset + 1] = curve.v0.y;
        positions[offset + 2] = batch.centers[offset + 2] = curve.v0.z;
        normals[offset] = 0; normals[offset + 1] = 0; normals[offset + 2] = 1;
        batch.profiles[vertex] = 0;
      }
      continue;
    }
    range.vineCount++;
    const [x, y] = offsets[vine.index];
    vine.offset[0] = x; vine.offset[1] = y;
    for (let ring = 0; ring <= segments; ring++) {
      const fraction = ring / segments * growth, offset = ring * 3;
      if (growth === 1) {
        center.fromArray(range.axisCenters, offset); normal.fromArray(range.axisNormals, offset); binormal.fromArray(range.axisBinormals, offset);
      } else axisFrame(curve, fraction, batch.scratch);
      const angle = TAU * (distanceOffset + range.length * fraction) / range.pitch;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const profile = range.pointed ? taper(fraction) : 1;
      const spread = range.pointed ? profile : 1;
      const nx = (x * cos - y * sin) * spread, ny = (x * sin + y * cos) * spread;
      center.addScaledVector(normal, nx).addScaledVector(binormal, ny);
      center.toArray(range.vineCenters, offset);
      range.vineProfiles[ring] = profile;
    }
    for (let ring = 0; ring <= segments; ring++) {
      const offset = ring * 3;
      center.fromArray(range.vineCenters, offset);
      const before = Math.max(0, ring - 1) * 3, after = Math.min(segments, ring + 1) * 3;
      tangent.set(range.vineCenters[after] - range.vineCenters[before], range.vineCenters[after + 1] - range.vineCenters[before + 1], range.vineCenters[after + 2] - range.vineCenters[before + 2]);
      if (tangent.lengthSq() < 1e-16) tangent.subVectors(curve.v3, curve.v0);
      if (tangent.lengthSq() < 1e-16) tangent.set(0, -1, 0);
      tangent.normalize(); radialFrame(tangent, normal, binormal);
      const profile = range.vineProfiles[ring];
      const distance = Math.hypot(range.vineCenters[after] - range.vineCenters[before], range.vineCenters[after + 1] - range.vineCenters[before + 1], range.vineCenters[after + 2] - range.vineCenters[before + 2]);
      const slope = distance > 1e-10 ? ROOT_VINE_RADIUS * (range.vineProfiles[Math.min(segments, ring + 1)] - range.vineProfiles[Math.max(0, ring - 1)]) / distance : 0;
      for (let side = 0; side <= sides; side++) {
        const vertex = vine.vertexStart + ring * (sides + 1) + side, target = vertex * 3;
        const cos = batch.cosines[side], sin = batch.sines[side];
        const rx = cos * normal.x + sin * binormal.x, ry = cos * normal.y + sin * binormal.y, rz = cos * normal.z + sin * binormal.z;
        center.toArray(batch.centers, target); batch.profiles[vertex] = profile;
        positions[target] = center.x + rx * ROOT_VINE_RADIUS * profile;
        positions[target + 1] = center.y + ry * ROOT_VINE_RADIUS * profile;
        positions[target + 2] = center.z + rz * ROOT_VINE_RADIUS * profile;
        const dx = rx - tangent.x * slope, dy = ry - tangent.y * slope, dz = rz - tangent.z * slope;
        const length = Math.hypot(dx, dy, dz) || 1;
        normals[target] = dx / length; normals[target + 1] = dy / length; normals[target + 2] = dz / length;
        min.x = Math.min(min.x, positions[target]); max.x = Math.max(max.x, positions[target]);
        min.y = Math.min(min.y, positions[target + 1]); max.y = Math.max(max.y, positions[target + 1]);
        min.z = Math.min(min.z, positions[target + 2]); max.z = Math.max(max.z, positions[target + 2]);
      }
    }
  }
  range.touches = touches; range.radius = rootRopeRadius(touches); range.distanceOffset = distanceOffset;
  range.endDistance = distanceOffset + range.length; range.curve = curve;
  batch.positionDirty = true;
}

export function setRootRopeColor(batch, range, color) {
  if (!range || range.color.equals(color)) return;
  const colors = batch.geometry.attributes.color.array;
  for (let vertex = range.vertexStart; vertex < range.vertexStart + range.vertexCount; vertex++) {
    const offset = vertex * 3, shade = batch.shades[vertex];
    colors[offset] = color.r * shade; colors[offset + 1] = color.g * shade; colors[offset + 2] = color.b * shade;
  }
  range.color.copy(color); batch.colorDirty = true;
}

export function finishRootRopeUpdate(batch) {
  if (!batch) return;
  if (batch.positionDirty) {
    batch.geometry.attributes.position.needsUpdate = true;
    batch.geometry.attributes.normal.needsUpdate = true;
    const bounds = batch.geometry.boundingBox ||= new THREE.Box3(); bounds.makeEmpty();
    batch.centerBounds.makeEmpty();
    for (const range of batch.ranges.values()) { bounds.union(range.bounds); batch.centerBounds.union(range.centerBounds); }
    batch.geometry.boundingSphere ||= new THREE.Sphere(); bounds.getBoundingSphere(batch.geometry.boundingSphere);
    batch.positionDirty = false;
  }
  if (batch.colorDirty) { batch.geometry.attributes.color.needsUpdate = true; batch.colorDirty = false; }
}
