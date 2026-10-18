import * as THREE from 'three';

export const ROOT_STRAND_RADIUS = 0.002;
// The renderer supports either accumulation rule without changing the layout.
export function rootStrandRadius(touches, mode = 'doubling') {
  const count = Math.max(0, Math.floor(Number(touches) || 0));
  return ROOT_STRAND_RADIUS * (mode === 'doubling' ? 2 ** count : count + 1);
}

/** Shared buffers let each existing edge bend and thicken without duplicate meshes. */
export function createRootStrandBatch(edges, { pointed = false, segments = 16, sides = 6 } = {}) {
  if (!edges.length) return null;
  const verticesPerEdge = (segments + 1) * (sides + 1);
  const indexCount = segments * sides * 6;
  const totalVertices = edges.length * verticesPerEdge;
  const centers = new Float32Array(totalVertices * 3);
  const radial = new Float32Array(totalVertices * 3);
  const tangent = new Float32Array(totalVertices * 3);
  const profiles = new Float32Array(totalVertices);
  const slopes = new Float32Array(totalVertices);
  const shades = new Float32Array(totalVertices);
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const colors = new Float32Array(totalVertices * 3);
  const indices = totalVertices > 65535 ? new Uint32Array(edges.length * indexCount) : new Uint16Array(edges.length * indexCount);
  const ranges = new Map();
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
    const edge = edges[edgeIndex];
    const vertexStart = edgeIndex * verticesPerEdge;
    for (let ring = 0; ring <= segments; ring++) {
      const t = ring / segments;
      for (let side = 0; side <= sides; side++) {
        const vertex = vertexStart + ring * (sides + 1) + side;
        shades[vertex] = 0.93 + Math.sin(side / sides * Math.PI * 6 + t * 4) * 0.045;
      }
    }
    let index = edgeIndex * indexCount;
    for (let ring = 1; ring <= segments; ring++) {
      for (let side = 1; side <= sides; side++) {
        const a = vertexStart + (sides + 1) * (ring - 1) + side - 1;
        const b = vertexStart + (sides + 1) * ring + side - 1;
        const c = b + 1, d = a + 1;
        indices[index++] = a; indices[index++] = b; indices[index++] = d;
        indices[index++] = b; indices[index++] = c; indices[index++] = d;
      }
    }
    ranges.set(edge.key, {
      key: edge.key, vertexStart, vertexCount: verticesPerEdge,
      faceStart: edgeIndex * indexCount / 3, faceEnd: (edgeIndex + 1) * indexCount / 3,
      segments, sides, pointed, radius: ROOT_STRAND_RADIUS, color: new THREE.Color(-1, -1, -1),
      curveSignature: new Float64Array(12).fill(NaN),
      centerBounds: new THREE.Box3(), bounds: new THREE.Box3(),
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  const batch = {
    geometry, ranges, centers, radial, tangent, profiles, slopes, shades,
    centerBounds: new THREE.Box3(), positionDirty: false, colorDirty: false, shapeDirty: false,
    frame: {
      center: new THREE.Vector3(), direction: new THREE.Vector3(), previous: new THREE.Vector3(),
      normal: new THREE.Vector3(), binormal: new THREE.Vector3(),
    },
    cosines: Float64Array.from({ length: sides + 1 }, (_, side) => Math.cos(side / sides * Math.PI * 2)),
    sines: Float64Array.from({ length: sides + 1 }, (_, side) => Math.sin(side / sides * Math.PI * 2)),
  };
  for (const edge of edges) {
    const range = ranges.get(edge.key);
    setRootStrandCurve(batch, range, edge.curve);
    setRootStrandColor(batch, range, edge.color);
  }
  finishRootStrandUpdate(batch);
  return batch;
}

/**
 * Warp one existing range in place. Call finishRootStrandUpdate after a frame's
 * edits to upload buffers and refresh bounds once. Mutating the same cubic's
 * control vectors is supported; colors, topology and other edges are preserved.
 */
export function setRootStrandCurve(batch, range, curve, radius = range?.radius) {
  if (!batch || !range) return;
  const controls = [curve.v0, curve.v1, curve.v2, curve.v3];
  let changed = false;
  for (let point = 0; point < 4; point++) {
    const control = controls[point];
    const offset = point * 3;
    if (range.curveSignature[offset] !== control.x || range.curveSignature[offset + 1] !== control.y || range.curveSignature[offset + 2] !== control.z) changed = true;
  }
  if (!changed) {
    setRootStrandRadius(batch, range, radius);
    return;
  }

  // Three caches arc lengths independently from the mutable control vectors.
  curve.updateArcLengths();
  const length = Math.max(1e-6, curve.getLength());
  const { center, direction, previous, normal, binormal } = batch.frame;
  const { segments, sides, pointed } = range;
  range.centerBounds.makeEmpty();
  for (let ring = 0; ring <= segments; ring++) {
    const t = ring / segments;
    const parameter = curve.getUtoTmapping(t);
    curve.getPoint(parameter, center);
    const inverse = 1 - parameter;
    const a = 3 * inverse * inverse, b = 6 * inverse * parameter, c = 3 * parameter * parameter;
    // Analytic derivatives make C1-connected endpoint frames exactly agree.
    direction.set(
      a * (curve.v1.x - curve.v0.x) + b * (curve.v2.x - curve.v1.x) + c * (curve.v3.x - curve.v2.x),
      a * (curve.v1.y - curve.v0.y) + b * (curve.v2.y - curve.v1.y) + c * (curve.v3.y - curve.v2.y),
      a * (curve.v1.z - curve.v0.z) + b * (curve.v2.z - curve.v1.z) + c * (curve.v3.z - curve.v2.z),
    );
    // Newly added edges start collapsed at their parent junction. A zero
    // derivative still needs a finite radial frame until the curve opens.
    if (direction.lengthSq() < 1e-16) {
      if (ring) direction.copy(previous);
      else {
        direction.subVectors(curve.v3, curve.v0);
        if (direction.lengthSq() < 1e-16) direction.set(0, -1, 0);
      }
    }
    direction.normalize();
    // A common reference at every ring gives connected strands the same
    // cross-section phase, independent of the bends before their junction.
    // Root paths descend along Y; X is the fallback for an axial Z tangent.
    normal.set(0, 0, 1).addScaledVector(direction, -direction.z);
    if (normal.lengthSq() < 1e-10) normal.set(1, 0, 0).addScaledVector(direction, -direction.x);
    normal.normalize();
    binormal.crossVectors(direction, normal).normalize();
    previous.copy(direction);
    range.centerBounds.expandByPoint(center);
    const u = THREE.MathUtils.clamp((t - 0.68) / 0.32, 0, 1);
    // Keep the final ring nonzero so the PBR normals remain well defined.
    const profile = pointed ? 1 - 0.96 * u * u * (3 - 2 * u) : 1;
    const slope = pointed && u > 0 && u < 1 ? -0.96 * 6 * u * (1 - u) / (0.32 * length) : 0;
    for (let side = 0; side <= sides; side++) {
      const vertex = range.vertexStart + ring * (sides + 1) + side;
      const offset = vertex * 3;
      const cos = -batch.cosines[side], sin = batch.sines[side];
      batch.centers[offset] = center.x; batch.centers[offset + 1] = center.y; batch.centers[offset + 2] = center.z;
      batch.radial[offset] = cos * normal.x + sin * binormal.x;
      batch.radial[offset + 1] = cos * normal.y + sin * binormal.y;
      batch.radial[offset + 2] = cos * normal.z + sin * binormal.z;
      batch.tangent[offset] = direction.x; batch.tangent[offset + 1] = direction.y; batch.tangent[offset + 2] = direction.z;
      batch.profiles[vertex] = profile; batch.slopes[vertex] = slope;
    }
  }
  for (let point = 0; point < 4; point++) controls[point].toArray(range.curveSignature, point * 3);
  range.curve = curve;
  batch.shapeDirty = true;
  writeStrandSurface(batch, range, radius);
}

export function setRootStrandRadius(batch, range, radius) {
  if (!range || range.radius === radius) return;
  writeStrandSurface(batch, range, radius);
}

function writeStrandSurface(batch, range, radius) {
  const positions = batch.geometry.attributes.position.array;
  const normals = batch.geometry.attributes.normal.array;
  const { centers, radial, tangent, profiles, slopes } = batch;
  const min = range.bounds.min.set(Infinity, Infinity, Infinity);
  const max = range.bounds.max.set(-Infinity, -Infinity, -Infinity);
  for (let vertex = range.vertexStart; vertex < range.vertexStart + range.vertexCount; vertex++) {
    const offset = vertex * 3;
    const scale = profiles[vertex] * radius;
    const slope = slopes[vertex] * radius;
    positions[offset] = centers[offset] + radial[offset] * scale;
    positions[offset + 1] = centers[offset + 1] + radial[offset + 1] * scale;
    positions[offset + 2] = centers[offset + 2] + radial[offset + 2] * scale;
    // Use the stored float32 coordinates so bounds contain the actual surface.
    min.x = Math.min(min.x, positions[offset]); max.x = Math.max(max.x, positions[offset]);
    min.y = Math.min(min.y, positions[offset + 1]); max.y = Math.max(max.y, positions[offset + 1]);
    min.z = Math.min(min.z, positions[offset + 2]); max.z = Math.max(max.z, positions[offset + 2]);
    let x = radial[offset] - tangent[offset] * slope;
    let y = radial[offset + 1] - tangent[offset + 1] * slope;
    let z = radial[offset + 2] - tangent[offset + 2] * slope;
    const length = Math.hypot(x, y, z) || 1;
    normals[offset] = x / length; normals[offset + 1] = y / length; normals[offset + 2] = z / length;
  }
  range.radius = radius;
  batch.positionDirty = true;
}

export function setRootStrandColor(batch, range, color) {
  if (!range || range.color.equals(color)) return;
  const colors = batch.geometry.attributes.color.array;
  for (let vertex = range.vertexStart; vertex < range.vertexStart + range.vertexCount; vertex++) {
    const offset = vertex * 3;
    const shade = batch.shades[vertex];
    colors[offset] = color.r * shade;
    colors[offset + 1] = color.g * shade;
    colors[offset + 2] = color.b * shade;
  }
  range.color.copy(color);
  batch.colorDirty = true;
}

export function finishRootStrandUpdate(batch) {
  if (!batch) return;
  if (batch.positionDirty) {
    batch.geometry.attributes.position.needsUpdate = true;
    batch.geometry.attributes.normal.needsUpdate = true;
    const bounds = batch.geometry.boundingBox ||= new THREE.Box3();
    bounds.makeEmpty();
    batch.centerBounds.makeEmpty();
    for (const range of batch.ranges.values()) {
      bounds.union(range.bounds);
      batch.centerBounds.union(range.centerBounds);
    }
    batch.geometry.boundingSphere ||= new THREE.Sphere();
    bounds.getBoundingSphere(batch.geometry.boundingSphere);
    batch.positionDirty = false;
    batch.shapeDirty = false;
  }
  if (batch.colorDirty) { batch.geometry.attributes.color.needsUpdate = true; batch.colorDirty = false; }
}
