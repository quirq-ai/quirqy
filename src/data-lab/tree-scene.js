import * as THREE from 'three';
import { RepositoryScene } from './scene.js';
import { CHANGE_COLORS } from './encoding.js';
import { stableHash } from './layout.js';
import { createTreeLayout, createTreePose, trunkRadius } from './tree-layout.js';
import { stateAt } from './model.js';
import { RepositoryRoots } from './root-scene.js';
import { createRootLayout } from './root-layout.js';

const DURATION = 1.6;
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(0xf2f0d8);
const FOLIAGE = [0x83a974, 0xa1b775, 0x67a489, 0x9aa45c, 0x54886d, 0xa4b58c, 0x74a394, 0xaabb71];
const ease = value => value * value * (3 - 2 * value);
const toSet = value => value instanceof Set ? value : new Set(value || []);
const asVector = point => new THREE.Vector3(...point);

export function createLeafGeometry() {
  // Single vertices at the pointed ends avoid degenerate triangles / zero
  // normals, which can produce non-finite PBR pixels in the bloom pipeline.
  const positions = [0, 0, 0], indices = [], colors = [0.92, 0.92, 0.92];
  const rows = 18, columns = 6;
  for (let row = 1; row < rows; row++) {
    const t = row / rows;
    const profile = Math.pow(Math.sin(t * Math.PI), 0.82);
    for (let column = 0; column <= columns; column++) {
      const side = column / columns * 2 - 1;
      positions.push(side * profile * 1.03, t * 3.75, profile * (1 - Math.abs(side)) * 0.26 + side * side * profile * 0.12 - t * t * 0.19);
      const shade = 0.81 + (1 - Math.abs(side)) * 0.17 + t * 0.08;
      colors.push(shade, shade, shade);
      if (row < rows - 1 && column < columns) {
        const a = 1 + (row - 1) * (columns + 1) + column, b = a + columns + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const tip = positions.length / 3;
  positions.push(0, 3.75, -0.19);
  colors.push(1, 1, 1);
  for (let column = 0; column < columns; column++) {
    indices.push(0, 1 + column, 2 + column);
    const a = 1 + (rows - 2) * (columns + 1) + column;
    indices.push(a, tip, a + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function branchGeometry(curve, { trunk = false, segments = 28 } = {}) {
  const radialSegments = trunk ? 14 : 9;
  const geometry = new THREE.TubeGeometry(curve, segments, 1, radialSegments, false);
  const positions = geometry.attributes.position;
  const centers = new Float32Array(positions.array.length);
  const offsets = new Float32Array(positions.array.length);
  const colors = new Float32Array(positions.array.length);
  for (let ring = 0; ring <= segments; ring++) {
    const t = ring / segments, center = curve.getPointAt(t);
    const taper = trunk ? (1 - t * 0.86) * (1 + Math.pow(1 - t, 7) * 0.65) : 0.9 * Math.pow(1 - t, 0.74) + 0.055;
    for (let segment = 0; segment <= radialSegments; segment++) {
      const index = ring * (radialSegments + 1) + segment, offset = index * 3;
      const angle = segment / radialSegments * Math.PI * 2;
      const rib = 1 + Math.sin(angle * 5 + t * 3) * (trunk ? 0.055 : 0.025);
      const shade = 0.77 + Math.sin(angle * 7 + Math.sin(t * 16)) * 0.09 + Math.sin(t * 23 + angle) * 0.035;
      for (let axis = 0; axis < 3; axis++) {
        centers[offset + axis] = center.getComponent(axis);
        offsets[offset + axis] = (positions.array[offset + axis] - centers[offset + axis]) * taper * rib;
        colors[offset + axis] = shade;
      }
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.userData.radialCenters = centers;
  geometry.userData.radialOffsets = offsets;
  return geometry;
}

function setBranchRadius(geometry, radius) {
  if (geometry.userData.radius === radius) return;
  const { radialCenters: centers, radialOffsets: offsets } = geometry.userData;
  const position = geometry.attributes.position;
  for (let index = 0; index < position.array.length; index++) position.array[index] = centers[index] + offsets[index] * radius;
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.userData.radius = radius;
}

// Build each destination surface once per commit. Interpolating its existing
// buffers avoids allocating hundreds of new stem geometries on every frame.
function surfaceTransition(geometry, target) {
  const from = geometry.attributes.position.array.slice();
  const to = target.attributes.position.array.slice();
  const fromNormals = geometry.attributes.normal.array.slice();
  const toNormals = target.attributes.normal.array.slice();
  geometry.computeBoundingSphere();
  target.computeBoundingSphere();
  geometry.boundingSphere.union(target.boundingSphere);
  target.dispose();
  return { geometry, from, to, fromNormals, toNormals };
}

function updateSurface(surface, amount) {
  const { geometry, from, to, fromNormals, toNormals } = surface;
  const positions = geometry.attributes.position.array, normals = geometry.attributes.normal.array;
  for (let index = 0; index < positions.length; index++) positions[index] = from[index] + (to[index] - from[index]) * amount;
  for (let index = 0; index < normals.length; index += 3) {
    let x = fromNormals[index] + (toNormals[index] - fromNormals[index]) * amount;
    let y = fromNormals[index + 1] + (toNormals[index + 1] - fromNormals[index + 1]) * amount;
    let z = fromNormals[index + 2] + (toNormals[index + 2] - fromNormals[index + 2]) * amount;
    let length = Math.hypot(x, y, z);
    // Never feed zero normals to PBR/bloom, even at a sharp change of direction.
    if (length < 1e-6) { x = toNormals[index]; y = toNormals[index + 1]; z = toNormals[index + 2]; length = Math.hypot(x, y, z) || 1; }
    normals[index] = x / length; normals[index + 1] = y / length; normals[index + 2] = z / length;
  }
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.normal.needsUpdate = true;
}

/** A second scene for the same repository model, sharing Observatory's stage. */
export class TreeScene extends RepositoryScene {
  constructor(stage, callbacks = {}) {
    super(stage, callbacks);
    this.group.name = 'Data Lab · Growth tree';
    this.options.roots = true;
    this.roots = new RepositoryRoots(stage);
    this.group.add(this.roots.group);
    this.selectionInRoots = false;
    this.lastHit = null;
    // A folder is toggled on a single click. The shared double-click handler
    // would toggle it a third time; use double-click only to focus the outline.
    this.renderer.domElement.removeEventListener('dblclick', this._doubleClick);
    this._doubleClick = event => {
      const hit = this._hit(event);
      if (hit?.kind === 'file') this.focusNode(hit.id);
      else if (hit?.kind === 'folder') {
        if (hit.root) this.focusRootFolder(hit.path);
        else super.focusFolder(hit.path);
      }
    };
    this.renderer.domElement.addEventListener('dblclick', this._doubleClick);
    for (const [name, geometry] of Object.entries(this.geometries)) if (name !== 'pick') { geometry.dispose(); delete this.geometries[name]; }
    this.geometries.leaf = createLeafGeometry();
    const veinPoints = Array.from({ length: 19 }, (_, index) => {
      const t = index / 18;
      return new THREE.Vector3(0, t * 3.75, Math.pow(Math.sin(t * Math.PI), 0.82) * 0.26 - t * t * 0.19 + 0.013);
    });
    this.geometries.vein = new THREE.BufferGeometry().setFromPoints(veinPoints);
    this.branches = [];
    this.fallingLeaves = [];
    this.index = null;
    this.trunkRadius = trunkRadius(-1);
    this.renderer.domElement.setAttribute('aria-label', 'Three-dimensional repository growth tree. Each leaf is a file. Below ground, an indented directory outline shows actual folders and files. Click folders to expand or collapse, click files or leaves to inspect. Drag to orbit, scroll to zoom, double-click a file to focus.');
  }

  setModel(model) {
    this._clearWorld();
    this.model = model;
    this.roots.setModel(model);
    this.layout = createTreeLayout(model);
    this.extent = this.layout.extent;
    this.center = asVector(this.layout.center);
    this.renderedCount = this.layout.nodes.length;
    this.branches = [];
    this.poseTransition = null;
    this.poseTarget = null;
    this.lengthScale = 1;
    this.index = null;
    this.frameKey = undefined;
    this.trunkRadius = trunkRadius(-1);
    this.radiusFrom = this.radiusTarget = this.trunkRadius;
    const topPaths = this.layout.folders.filter(folder => folder.depth === 1).map(folder => folder.path).sort();
    const colorFor = path => new THREE.Color(FOLIAGE[Math.max(0, topPaths.indexOf(path.split('/')[0])) % FOLIAGE.length]);

    for (const folder of this.layout.folders) {
      const position = asVector(folder.position);
      const color = colorFor(folder.path);
      const curve = new THREE.CubicBezierCurve3(...folder.curve.map(asVector));
      const geometry = branchGeometry(curve, { trunk: !folder.path, segments: folder.path ? 28 : 44 });
      const material = new THREE.MeshStandardMaterial({ color: folder.path ? 0x76634b : 0x826b50, vertexColors: true, roughness: 0.86, metalness: 0.025, transparent: true, opacity: 1, emissive: 0x302719, emissiveIntensity: 0.07 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = { kind: 'folder', path: folder.path };
      const members = this.layout.nodes.filter(node => !folder.path || node.folder === folder.path || node.folder.startsWith(`${folder.path}/`)).map(node => node.id);
      const record = { ...folder, position, color, curve, mesh, members };
      this.folders.set(folder.path, record);
      this.world.add(mesh);
      this.branches.push(record);
      setBranchRadius(geometry, this.trunkRadius * folder.branchWeight);
      if (folder.path) this._label(folder.path, position.clone().add(new THREE.Vector3(0, 3.2, 0)), `#${color.getHexString()}`, folder.path);
    }
    this._label(model.repository?.name || 'Repository', new THREE.Vector3(0, -38, 0), '#b7a88b', '');

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), new THREE.MeshBasicMaterial({ color: 0x17251c, map: this.dot, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -40.3;
    this.world.add(ground);
    // A fine soil contour separates growth above from exact paths below without
    // hiding the underground geometry behind an opaque ground plane.
    const contour = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, index) => {
      const angle = index / 128 * Math.PI * 2;
      return new THREE.Vector3(Math.cos(angle) * 50, -40.25, Math.sin(angle) * 30);
    })), new THREE.LineBasicMaterial({ color: 0x8f7955, transparent: true, opacity: 0.28, depthWrite: false }));
    this.world.add(contour);

    for (const node of this.layout.nodes) {
      const folder = this.folders.get(node.folder);
      const color = folder.color.clone();
      const variation = ((stableHash(node.id) % 100) / 100 - 0.5) * 0.075;
      color.offsetHSL(variation * 0.25, variation, variation);
      if (!node.sizeKnown) color.lerp(new THREE.Color(0x99aba0), 0.55);
      const material = new THREE.MeshStandardMaterial({ color, vertexColors: true, roughness: 0.62, metalness: 0.025, side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.045, transparent: true });
      const mesh = new THREE.Mesh(this.geometries.leaf, material);
      const position = asVector(node.position);
      mesh.position.copy(position);
      mesh.quaternion.setFromUnitVectors(UP, asVector(node.direction));
      mesh.rotateY(node.roll);
      mesh.scale.setScalar(node.scale);
      mesh.userData = { kind: 'file', id: node.id };
      const vein = new THREE.Line(this.geometries.vein, new THREE.LineBasicMaterial({ color: 0xc6d3a1, transparent: true, opacity: 0.34, depthWrite: false }));
      mesh.add(vein);
      this.world.add(mesh);
      const pick = new THREE.Mesh(this.geometries.pick, new THREE.MeshBasicMaterial({ visible: false }));
      const center = new THREE.Vector3(0, 1.85 * node.scale, 0).applyQuaternion(mesh.quaternion).add(position);
      pick.position.copy(center);
      pick.scale.setScalar(Math.max(1, node.scale * 1.75));
      pick.userData = { kind: 'file', id: node.id };
      this.world.add(pick);
      const curve = new THREE.QuadraticBezierCurve3(asVector(node.stemStart), asVector(node.stemControl), position.clone());
      const link = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.065 + Math.min(0.055, node.scale * 0.025), 5, false), new THREE.MeshStandardMaterial({ color: 0x6c7050, roughness: 0.92, transparent: true, opacity: 0.8 }));
      this.linkGroup.add(link);
      this.nodes.set(node.id, { node, mesh, pick, link, vein, position, center, color, size: node.scale, sizeKnown: node.sizeKnown, areaRatio: node.areaRatio, folder, quaternion: mesh.quaternion.clone() });
    }
    this.pickables = [...this.nodes.values()].map(record => record.pick).concat([...this.folders.values()].map(folder => folder.mesh));
    this.activeIds = new Set(this.layout.nodes.map(node => node.id));
    this.changedIds = new Set();
    this.statuses = {};
    this.paths = {};
    this.selectedId = null;
    this.elapsed = this.duration = DURATION;
    this.animateTransition = false;
    this.setOptions(this.options);
    // Fit the complete loaded history once. Moving the camera on every commit
    // would cancel the apparent growth and fight the user's orbit/zoom gestures.
    this.cameraPoints = [];
    this.rootCameraPoints = [];
    for (let cursor = -1; cursor < model.commits.length; cursor++) {
      const pose = createTreePose(this.layout, { index: cursor, commitCount: model.commits.length, activeIds: stateAt(model, cursor).activeIds });
      this.cameraPoints.push(...pose.nodes.map(node => asVector(node.position)), ...pose.folders.flatMap(folder => folder.curve.map(asVector)));
      const frame = stateAt(model, cursor);
      const roots = createRootLayout(model, { activeIds: frame.activeIds, paths: Object.fromEntries(frame.files.map(file => [file.id, file.path])) });
      for (const x of [roots.bounds.min[0], roots.bounds.max[0]]) for (const y of [roots.bounds.min[1], roots.bounds.max[1]]) for (const z of [roots.bounds.min[2], roots.bounds.max[2]]) this.rootCameraPoints.push(new THREE.Vector3(x, y, z));
    }
    const bounds = new THREE.Box3().setFromPoints(this.cameraPoints);
    this.center = bounds.getCenter(new THREE.Vector3());
    this.extent = bounds.getBoundingSphere(new THREE.Sphere()).radius + 10;
    this.resetView(true);
  }

  setFrame({ visibleIds, changedIds, selectedId, statuses = {}, frameKey, paths = {}, duration = DURATION, index, commitCount } = {}) {
    const nextIndex = Number.isFinite(index) ? Math.floor(index) : (this.model?.commits.findIndex(commit => commit.sha === frameKey) ?? -1);
    const different = this.frameKey !== frameKey || nextIndex !== this.index;
    const adjacentForward = this.index !== null && nextIndex === this.index + 1;
    const previousActive = this.activeIds;
    if (visibleIds !== undefined) this.activeIds = toSet(visibleIds);
    this.changedIds = toSet(changedIds);
    this.statuses = { ...statuses };
    this.paths = paths instanceof Map ? Object.fromEntries(paths) : { ...paths };
    this.duration = Math.max(0.08, Number(duration) || DURATION);
    if (different) {
      this._clearActivity();
      this.animateTransition = adjacentForward && !this.reducedMotion && this.options.activity;
      this.elapsed = this.animateTransition ? 0 : this.duration;
      this.radiusFrom = this.trunkRadius;
      this.radiusTarget = trunkRadius(nextIndex);
      if (!this.animateTransition) this.trunkRadius = this.radiusTarget;
      if (this.animateTransition) for (const id of this.changedIds) {
        if (statuses[id] !== 'removed' || !previousActive.has(id) || this.activeIds.has(id)) continue;
        const record = this.nodes.get(id);
        if (!record) continue;
        const material = record.mesh.material.clone();
        material.color.setHex(CHANGE_COLORS.removed).lerp(new THREE.Color(0xc3a063), 0.32);
        material.emissive.copy(material.color);
        material.emissiveIntensity = 0.12;
        material.opacity = 1;
        material.wireframe = false;
        const mesh = new THREE.Mesh(this.geometries.leaf, material);
        mesh.position.copy(record.position);
        mesh.quaternion.copy(record.quaternion);
        mesh.scale.setScalar(record.size);
        this.activityGroup.add(mesh);
        this.fallingLeaves.push({ id, mesh, start: record.position.clone(), quaternion: record.quaternion.clone(), phase: stableHash(id) / 4294967295 * Math.PI * 2 });
      }
      this._preparePose(nextIndex, commitCount ?? this.model?.commits.length ?? 0);
    }
    this.index = nextIndex;
    this.commitCount = commitCount ?? this.model?.commits.length ?? 0;
    this.frameKey = frameKey;
    this.roots.setFrame({ activeIds: this.activeIds, paths: this.paths, changedIds: this.changedIds, statuses: this.statuses, selectedId, frameKey });
    if (selectedId !== undefined) this.select(selectedId);
    this.update(0);
  }

  _preparePose(index, commitCount) {
    const pose = createTreePose(this.layout, { index, commitCount, activeIds: this.activeIds });
    const surfaces = [], folders = [], nodes = [];
    for (const target of pose.folders) {
      const record = this.folders.get(target.path);
      const curve = new THREE.CubicBezierCurve3(...target.curve.map(asVector));
      const geometry = branchGeometry(curve, { trunk: !target.path, segments: target.path ? 28 : 44 });
      setBranchRadius(geometry, this.radiusTarget * target.branchWeight);
      surfaces.push(surfaceTransition(record.mesh.geometry, geometry));
      folders.push({ record, from: record.position.clone(), to: asVector(target.position), fromCurve: [record.curve.v0, record.curve.v1, record.curve.v2, record.curve.v3].map(point => point.clone()), toCurve: target.curve.map(asVector) });
      record.loadCount = target.loadCount;
      record.loadWeight = target.loadWeight;
      record.lengthFactor = target.lengthFactor;
      record.droop = target.droop;
    }
    for (const target of pose.nodes) {
      const record = this.nodes.get(target.id);
      const curve = new THREE.QuadraticBezierCurve3(asVector(target.stemStart), asVector(target.stemControl), asVector(target.position));
      const geometry = new THREE.TubeGeometry(curve, 12, 0.065 + Math.min(0.055, target.scale * 0.025), 5, false);
      surfaces.push(surfaceTransition(record.link.geometry, geometry));
      const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, asVector(target.direction));
      quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(UP, target.roll));
      nodes.push({ record, from: record.position.clone(), to: asVector(target.position), fromQuaternion: record.quaternion.clone(), toQuaternion: quaternion });
    }
    this.poseTarget = pose;
    this.poseTransition = { surfaces, folders, nodes, lengthFrom: this.lengthScale, amount: -1 };
  }

  _updatePose(amount) {
    const pose = this.poseTransition;
    if (!pose || pose.amount === amount) return;
    pose.amount = amount;
    this.lengthScale = THREE.MathUtils.lerp(pose.lengthFrom, this.poseTarget.lengthScale, amount);
    for (const surface of pose.surfaces) updateSurface(surface, amount);
    for (const { record, from, to, fromCurve, toCurve } of pose.folders) {
      record.position.lerpVectors(from, to, amount);
      [record.curve.v0, record.curve.v1, record.curve.v2, record.curve.v3].forEach((point, index) => point.lerpVectors(fromCurve[index], toCurve[index], amount));
      record.curve.needsUpdate = true;
    }
    for (const { record, from, to, fromQuaternion, toQuaternion } of pose.nodes) {
      record.position.lerpVectors(from, to, amount);
      record.mesh.position.copy(record.position);
      record.quaternion.slerpQuaternions(fromQuaternion, toQuaternion, amount);
      record.mesh.quaternion.copy(record.quaternion);
      record.center.set(0, 1.85 * record.size, 0).applyQuaternion(record.quaternion).add(record.position);
      record.pick.position.copy(record.center);
    }
    for (const label of this.labelRecords) {
      if (!label.path) continue; // The repository name stays beside its rooted base.
      label.position.copy(this.folders.get(label.path).position).add(new THREE.Vector3(0, 3.2, 0));
      label.object.position.copy(label.position);
    }
    if (amount === 1) this.poseTransition = null;
  }

  _clearActivity() {
    for (const leaf of this.fallingLeaves || []) leaf.mesh.material.dispose();
    this.fallingLeaves = [];
    this.activityGroup?.clear();
    this.particles = [];
  }

  setOptions(options = {}) {
    const previousRoots = this.options.roots;
    Object.assign(this.options, options);
    this.roots?.setOptions(this.options);
    if (previousRoots !== this.options.roots && this.layout) this.resetView();
    // Branches carry directory structure; Links controls fine file stems only.
    this.linkGroup.visible = this.options.links;
    this.grid.visible = false;
    if (!this.options.activity) { this._clearActivity(); this.elapsed = this.duration; this.animateTransition = false; }
  }

  update(dt) {
    if (this.disposed || !this.layout) return;
    const delta = Math.min(Math.max(Number(dt) || 0, 0), 0.1);
    this.time += delta;
    this.elapsed = Math.min(this.duration, this.elapsed + delta);
    if (this.tween) {
      const tween = this.tween;
      tween.elapsed += delta;
      const t = ease(Math.min(1, tween.elapsed / 0.9));
      this.camera.position.lerpVectors(tween.from, tween.to, t);
      this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, t);
      if (tween.elapsed >= 0.9) this.tween = null;
    }
    const transition = this.elapsed / this.duration;
    this.trunkRadius = THREE.MathUtils.lerp(this.radiusFrom, this.radiusTarget, ease(transition));
    this._updatePose(ease(transition));
    for (const branch of this.branches) {
      const active = !branch.path || branch.members.some(id => this.activeIds.has(id));
      branch.mesh.visible = active || this.options.ghosts;
      branch.mesh.material.opacity = active ? 1 : 0.1;
      branch.mesh.material.depthWrite = active;
      const touched = branch.members.some(id => this.changedIds.has(id));
      branch.mesh.material.emissiveIntensity = this.options.activity && touched ? 0.08 + Math.sin(Math.PI * transition) * 0.26 : 0.065;
    }
    for (const [id, record] of this.nodes) {
      const active = this.activeIds.has(id), changed = this.changedIds.has(id);
      const selected = id === this.selectedId, hovered = id === this.hoveredId;
      const status = this.statuses[id];
      let size = record.size, opacity = active ? 1 : this.options.ghosts ? 0.105 : 0;
      if (this.animateTransition && transition < 1 && changed && (status === 'added' || status === 'copied')) {
        const growth = ease(Math.min(1, transition * 1.25));
        size *= 0.015 + growth * 0.985;
        opacity *= Math.min(1, growth * 2);
      }
      const material = record.mesh.material;
      record.mesh.visible = opacity > 0;
      record.mesh.scale.setScalar(size * (selected ? 1.12 : hovered ? 1.06 : 1));
      material.opacity = opacity;
      material.wireframe = !active;
      material.depthWrite = active;
      material.color.copy(record.color);
      if (changed && this.options.activity) material.color.lerp(this.activityColor.setHex(CHANGE_COLORS[status] || CHANGE_COLORS.modified), status === 'modified' ? 0.72 : 0.63);
      if (selected || hovered) material.color.lerp(WHITE, selected ? 0.33 : 0.2);
      material.emissive.copy(material.color);
      material.emissiveIntensity = selected ? 0.27 : hovered ? 0.18 : changed && this.options.activity ? 0.09 + Math.sin(Math.PI * transition) * 0.22 : 0.045;
      record.vein.visible = active;
      record.link.visible = active || this.options.ghosts;
      record.link.material.opacity = selected ? 0.95 : active ? 0.72 : 0.06;
      record.link.material.depthWrite = active;
    }
    if (this.fallingLeaves.length) {
      if (transition >= 1 || this.reducedMotion) this._clearActivity();
      else for (const falling of this.fallingLeaves) {
        const drop = Math.pow(transition, 1.65);
        falling.mesh.position.copy(falling.start);
        falling.mesh.position.y = THREE.MathUtils.lerp(falling.start.y, -39.8, drop);
        falling.mesh.position.x += Math.sin(transition * Math.PI * 2 + falling.phase) * Math.sin(transition * Math.PI) * 4.5;
        falling.mesh.position.z += Math.sin(transition * Math.PI + falling.phase) * transition * 5;
        falling.mesh.quaternion.copy(falling.quaternion);
        falling.mesh.rotateZ(Math.sin(transition * 9 + falling.phase) * transition * 0.85);
        falling.mesh.rotateY(transition * Math.PI * 2);
        falling.mesh.material.opacity = 1 - Math.max(0, (transition - 0.75) / 0.25);
      }
    }
    const highlighted = this.nodes.get(this.hoveredId || this.selectedId);
    this.focusHalo.visible = Boolean(highlighted);
    this.selectionLabel.visible = Boolean(highlighted && this.options.labels);
    if (highlighted) {
      this.focusHalo.position.copy(highlighted.center);
      this.focusHalo.scale.setScalar(Math.max(4, highlighted.size * 7));
      this.selectionLabel.position.copy(highlighted.center).add(new THREE.Vector3(0, Math.max(3, highlighted.size * 2.2), 0));
      this.selectionLabelElement.textContent = this.paths[highlighted.node.id] || highlighted.node.path;
    }
    this._updateLabels();
    this.roots.update?.(dt);
  }

  _flyTo(target, distance, immediate = false, direction = null) {
    const ray = (direction || this.camera.position.clone().sub(this.controls.target)).normalize();
    if (ray.lengthSq() < 0.1) ray.set(0.18, 0.13, 1).normalize();
    const width = this.renderer.domElement.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.clientHeight || window.innerHeight;
    const rightPanel = width > 900 ? 390 : width > 700 ? 330 : 0;
    const leftGuide = width > 1100 ? 235 : width > 700 ? 200 : 0;
    const right = new THREE.Vector3().crossVectors(UP, ray).normalize();
    const shift = distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * (rightPanel - leftGuide) / height;
    const endTarget = target.clone().addScaledVector(right, shift);
    const endPosition = endTarget.clone().addScaledVector(ray, distance);
    if (immediate || this.reducedMotion) { this.camera.position.copy(endPosition); this.controls.target.copy(endTarget); this.camera.lookAt(endTarget); this.tween = null; return; }
    this.tween = { elapsed: 0, from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to: endPosition, toTarget: endTarget };
  }

  resetView(immediate = false) {
    if (!this.layout) return;
    const width = this.renderer.domElement.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.clientHeight || window.innerHeight;
    const availableWidth = Math.max(270, width - (width > 1100 ? 660 : width > 900 ? 610 : width > 700 ? 555 : 36));
    const availableHeight = Math.max(250, height - (width > 700 ? 210 : 290));
    const ray = new THREE.Vector3(0.16, 0.095, 1).normalize();
    const right = new THREE.Vector3().crossVectors(UP, ray).normalize();
    const up = new THREE.Vector3().crossVectors(ray, right);
    const canopy = this.cameraPoints || [...this.layout.nodes.map(node => asVector(node.position)), ...this.layout.trunk.map(asVector)];
    const rootBounds = this.roots?.getBounds();
    const currentRoots = rootBounds && !rootBounds.isEmpty() ? this._boundsPoints(rootBounds) : [];
    const points = this.options.roots ? [...canopy, ...(this.rootCameraPoints || []), ...currentRoots] : canopy;
    this.center = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
    const halfWidth = Math.max(14, ...points.map(point => Math.abs(point.clone().sub(this.center).dot(right)))) + 8;
    const halfHeight = Math.max(20, ...points.map(point => Math.abs(point.clone().sub(this.center).dot(up)))) + 7;
    const depth = Math.max(4, ...points.map(point => Math.abs(point.clone().sub(this.center).dot(ray))));
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distance = Math.max(halfWidth / (tangent * availableWidth / height), halfHeight / (tangent * availableHeight / height)) + depth * 0.45;
    this.controls.maxDistance = Math.max(650, distance * 1.2);
    this._flyTo(this.center, distance, immediate, ray);
  }

  get indexLayout() { return this.roots?.layout || this.layout; }
  get indexFolders() { return this.roots?.folders || this.folders; }
  get indexNodes() { return this.roots?.files || this.nodes; }
  get mappedNodes() {
    return this.options.roots ? new Map([...this.nodes, ...(this.roots?.files || [])]) : this.nodes;
  }

  select(id) {
    this.selectedId = this.nodes.has(id) || this.roots?.files.has(id) ? id : null;
    if (this.lastHit?.id === id) this.selectionInRoots = Boolean(this.lastHit.root);
    else if (id && !this.nodes.has(id)) this.selectionInRoots = true;
    this.roots?.select(this.selectedId);
  }

  _hit(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    let nearest = this.roots?.hit(this.raycaster) || null;
    for (const hit of this.raycaster.intersectObjects(this.pickables || [], false)) {
      const data = hit.object.userData;
      if (data.kind !== 'folder' && !this.activeIds.has(data.id) && !this.options.ghosts) continue;
      if (!nearest || hit.distance < nearest.distance) nearest = { ...data, distance: hit.distance, root: false };
      break;
    }
    this.lastHit = nearest;
    this.roots?.setHovered(nearest?.root ? nearest : null);
    return nearest;
  }

  _clearHover() {
    super._clearHover();
    this.lastHit = null;
    this.roots?.setHovered(null);
  }

  focusNode(id) {
    if (this.options.roots && this.roots?.files.has(id) && (this.selectionInRoots || !this.nodes.has(id))) {
      this.roots.revealFile(id);
      const rootPosition = this.roots.getNodePosition(id);
      if (rootPosition) {
        this.select(id);
        const node = this.roots.files.get(id).node;
        const bounds = this.roots.getFolderBounds(node.parentPath);
        if (bounds && !bounds.isEmpty()) this._frameRootsBounds(bounds);
        return;
      }
    }
    super.focusNode(id);
  }

  focusFolder(path) {
    if (this.lastHit?.root && this.lastHit.path === path) {
      if (this.lastHit.pagerDelta) this.roots.changePage(path, this.lastHit.pagerDelta);
      else if (this.lastHit.toggle) this.roots.toggleFolder(path);
      else { this.focusRootFolder(path); return; }
      this.focusRoots();
    } else super.focusFolder(path);
  }

  focusRootFolder(path) {
    if (!this.options.roots) { super.focusFolder(path); return; }
    this.roots?.revealFolder(path);
    const bounds = path ? this.roots?.getFolderBounds(path) : this.roots?.getBounds();
    if (!bounds || bounds.isEmpty()) return;
    this._frameRootsBounds(bounds);
  }

  focusRoots() {
    if (!this.options.roots) return;
    const bounds = this.roots?.getBounds();
    if (bounds && !bounds.isEmpty()) this._frameRootsBounds(bounds);
  }

  _boundsPoints(bounds) {
    const points = [];
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) points.push(new THREE.Vector3(x, y, z));
    return points;
  }

  _frameRootsBounds(bounds) {
    const width = this.renderer.domElement.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.clientHeight || window.innerHeight;
    const availableWidth = Math.max(270, width - (width > 1100 ? 660 : width > 900 ? 610 : width > 700 ? 555 : 36));
    const availableHeight = Math.max(250, height - (width > 700 ? 210 : 290));
    const ray = new THREE.Vector3(0.10, 0.025, 1).normalize();
    const right = new THREE.Vector3().crossVectors(UP, ray).normalize();
    const up = new THREE.Vector3().crossVectors(ray, right);
    const center = bounds.getCenter(new THREE.Vector3());
    const points = this._boundsPoints(bounds).map(point => point.sub(center));
    const halfWidth = Math.max(10, ...points.map(point => Math.abs(point.dot(right)))) + 3;
    const halfHeight = Math.max(8, ...points.map(point => Math.abs(point.dot(up)))) + 3;
    const depth = Math.max(1, ...points.map(point => Math.abs(point.dot(ray))));
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distance = Math.max(halfWidth / (tangent * availableWidth / height), halfHeight / (tangent * availableHeight / height)) + depth;
    this.controls.maxDistance = Math.max(650, distance * 1.2);
    this._flyTo(center, distance, false, ray);
  }

  getRootScreenPoint(id) { return this.roots?.getRootNodeScreenPoint(id); }

  dispose() {
    if (this.disposed) return;
    this.roots?.dispose();
    super.dispose();
    this.poseTransition = null;
    this.poseTarget = null;
    this.rootCameraPoints = [];
    this.cameraPoints = [];
  }

  getNodeScreenPoint(id) {
    const record = this.nodes.get(id);
    if (!record) return this.options.roots ? this.roots?.getRootNodeScreenPoint(id) : null;
    this.camera.updateMatrixWorld();
    const point = record.center.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (point.x * 0.5 + 0.5) * rect.width, y: rect.top + (-point.y * 0.5 + 0.5) * rect.height, visible: point.z > -1 && point.z < 1 && Math.abs(point.x) < 1 && Math.abs(point.y) < 1 };
  }
}
