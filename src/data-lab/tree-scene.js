import * as THREE from 'three';
import { RepositoryScene } from './scene.js';
import { CHANGE_COLORS } from './encoding.js';
import { stableHash } from './layout.js';
import { createTreeLayout, createTreePose, trunkRadius } from './tree-layout.js';
import { stateAt } from './model.js';
import { RepositoryRoots } from './root-scene.js';
import { createRootLayout } from './root-layout.js';

const DURATION = 1.6;
const GROUND_Y = -40;
const PRESENTATION = { tree: { canopy: 1, roots: 0.32 }, roots: { canopy: 0.24, roots: 1 } };
const FLAT_GROUND = { height: 0, radiusX: 50, radiusZ: 30, depthWeight: 0.2, active: false };
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(0xf2f0d8);
const UNKNOWN_COLOR = new THREE.Color(0x99aba0);
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

function finiteNormals(geometry) {
  const normals = geometry.attributes.normal;
  for (let index = 0; index < normals.array.length; index += 3) {
    const length = Math.hypot(normals.array[index], normals.array[index + 1], normals.array[index + 2]);
    if (!Number.isFinite(length) || length < 1e-6) { normals.array[index] = 0; normals.array[index + 1] = 1; normals.array[index + 2] = 0; }
  }
  normals.needsUpdate = true;
  return geometry;
}

function stemGeometry(curve, scale, leafScale) {
  return finiteNormals(new THREE.TubeGeometry(curve, 12, scale * 0.05 + leafScale * 0.025, 5, false));
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
  finiteNormals(geometry);
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
    if (!Number.isFinite(length) || length < 1e-6) { x = toNormals[index]; y = toNormals[index + 1]; z = toNormals[index + 2]; length = Math.hypot(x, y, z); }
    if (!Number.isFinite(length) || length < 1e-6) { x = 0; y = 1; z = 0; length = 1; }
    normals[index] = x / length; normals[index + 1] = y / length; normals[index + 2] = z / length;
  }
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.normal.needsUpdate = true;
}

// Largest unobstructed rectangle in the real canvas. Side sheets and the
// mobile dock can be taller than their nominal CSS breakpoints.
export function rootReadableViewport(width, height, obstacles) {
  if (!Array.isArray(obstacles)) return {
    left: width > 1200 ? 245 : 16,
    right: width - (width > 1100 ? 390 : width > 900 ? 360 : 16),
    top: width > 900 ? 100 : 140, bottom: height - (width > 900 ? 120 : 220),
  };
  const margin = 12;
  const boxes = obstacles.map(box => ({ left: Math.max(margin, box.left - 8), right: Math.min(width - margin, box.left + box.width + 8), top: Math.max(margin, box.top - 8), bottom: Math.min(height - margin, box.top + box.height + 8) }))
    .filter(box => box.right > box.left && box.bottom > box.top);
  const xs = [...new Set([margin, width - margin, ...boxes.flatMap(box => [box.left, box.right])])].sort((a, b) => a - b);
  let best = { left: margin, right: width - margin, top: margin, bottom: height - margin }, area = 0;
  for (let first = 0; first < xs.length - 1; first++) for (let last = first + 1; last < xs.length; last++) {
    const left = xs[first], right = xs[last];
    if (right - left < 100) continue;
    const blocked = boxes.filter(box => box.left < right && box.right > left).sort((a, b) => a.top - b.top);
    let top = margin;
    for (const box of [...blocked, { top: height - margin, bottom: height - margin }]) {
      const size = (right - left) * Math.max(0, box.top - top);
      if (size > area) { best = { left, right, top, bottom: box.top }; area = size; }
      top = Math.max(top, box.bottom);
    }
  }
  return best;
}

/** A second scene for the same repository model, sharing Observatory's stage. */
export class TreeScene extends RepositoryScene {
  constructor(stage, callbacks = {}) {
    super(stage, callbacks);
    this.group.name = 'Data Lab · Growth tree';
    this.onFocusMode = callbacks.onFocusMode || (() => {});
    this.frameMode = 'tree';
    this.canopyGroup = new THREE.Group();
    this.canopyGroup.name = 'Canopy presentation';
    this.canopyGroup.add(this.world, this.linkGroup, this.activityGroup, this.focusHalo, this.selectionLabel);
    this.groundGroup = new THREE.Group();
    this.groundGroup.name = 'Ground presentation';
    this.group.add(this.canopyGroup, this.groundGroup);
    this.presentation = { ...PRESENTATION.tree };
    this.presentationTarget = { ...PRESENTATION.tree };
    this.presentationTransition = null;
    this.options.roots = true;
    this.roots = new RepositoryRoots(stage);
    this.group.add(this.roots.group);
    this._applyPresentation();
    this.selectionInRoots = false;
    this.lastHit = null;
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
    this.renderer.domElement.setAttribute('aria-label', 'Three-dimensional repository growth tree. Each leaf is a file; its surface area follows its current bytes. Tree dimensions follow the cube root of current known repository bytes, so both grow and shrink through history. Unknown file sizes use muted wireframe markers. The trunk is the repository root. Below ground, visible folders and files form the exact repository hierarchy. Dot-prefixed files and folders and their contents are hidden from roots. In Frame roots, names appear after their folder or file has been edited in the loaded history; folder names sit below their junctions and file names below tapered root ends. Starting root length and growth per loaded commit edit scale with repository width. The growth increment stays fixed throughout the loaded history. Rope thickness grows gently with length as a natural detail. Folder junctions stay fixed and the ground stays flat. The base grows with the visible file count and root extent. Horizontal filenames stay near their tips; zoom or focus a folder to reveal more names without overlap. Click a folder name to focus its subtree, or a file name or leaf to inspect. Frame roots arranges the hierarchy from top to bottom, with every folder depth on one horizontal level and files in ordered lanes. Each commit edit adds an equal downward step regardless of bytes. Unedited roots start faint and neutral. File roots and names use green for more bytes, red for fewer bytes, or yellow for equal bytes at the latest edit. Folder pathways and names use the net change in total bytes across all descendants, including hidden files. Unknown byte comparisons stay faint and neutral; names remain readable. Rewinding restores earlier length and color; zoom or pan to read dense groups. It shortens the canopy while preserving a sturdier trunk. In Frame roots, drag to pan at any zoom, Alt-drag to rotate freely, and Shift-drag to roll sideways. Right-drag also pans. On touch screens, use one finger to rotate and two fingers to pan, pinch to zoom, or twist to roll. Frame view emphasizes the byte-sized canopy with smaller organic roots and upright orbit. Scroll to zoom, double-click a file to focus.');
  }

  setModel(model) {
    this._clearWorld();
    this.model = model;
    this.roots.setModel(model);
    this.layout = createTreeLayout(model);
    const initialFrame = stateAt(model, model.commits.length - 1);
    const initialPose = createTreePose(this.layout, { frame: initialFrame });
    this.byteSummary = initialPose.sizeSummary;
    this.leafSizing = initialPose.sizing;
    this.extent = this.layout.extent;
    this.center = asVector(this.layout.center);
    this.renderedCount = this.layout.nodes.length;
    this.branches = [];
    this.poseTransition = null;
    this.poseTarget = initialPose;
    this.lengthScale = initialPose.lengthScale;
    this.index = null;
    this.frameKey = undefined;
    this.trunkRadius = initialPose.trunkRadius;
    this.radiusFrom = this.radiusTarget = this.trunkRadius;
    const topPaths = this.layout.folders.filter(folder => folder.depth === 1).map(folder => folder.path).sort();
    const colorFor = path => new THREE.Color(FOLIAGE[Math.max(0, topPaths.indexOf(path.split('/')[0])) % FOLIAGE.length]);

    for (const folder of initialPose.folders) {
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
      setBranchRadius(geometry, folder.radius);
      if (folder.path) this._label(folder.path, position.clone().add(new THREE.Vector3(0, 3.2, 0)), `#${color.getHexString()}`, folder.path);
    }
    this._label(model.repository?.name || 'Repository', new THREE.Vector3(0, -38, 0), '#b7a88b', '');

    const groundGeometry = new THREE.PlaneGeometry(150, 150, 48, 48);
    groundGeometry.rotateX(-Math.PI / 2);
    groundGeometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
    const ground = new THREE.Mesh(groundGeometry, new THREE.MeshBasicMaterial({ color: 0x17251c, map: this.dot, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
    ground.position.y = -40.3;
    this.ground = ground;
    this.groundBaseVertices = groundGeometry.attributes.position.array.slice();
    this.groundSurfaceSignature = null;
    this.groundGroup.add(ground);
    // A fine soil contour separates growth above from exact paths below without
    // hiding the underground geometry behind an opaque ground plane.
    const contour = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, index) => {
      const angle = index / 128 * Math.PI * 2;
      return new THREE.Vector3(Math.cos(angle) * 50, -40.25, Math.sin(angle) * 30);
    })), new THREE.LineBasicMaterial({ color: 0x8f7955, transparent: true, opacity: 0.28, depthWrite: false }));
    contour.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
    this.groundContour = contour;
    this.groundContourBaseVertices = contour.geometry.attributes.position.array.slice();
    this.groundGroup.add(contour);

    for (const node of initialPose.nodes) {
      const folder = this.folders.get(node.folder);
      const color = folder.color.clone();
      const variation = ((stableHash(node.id) % 100) / 100 - 0.5) * 0.075;
      color.offsetHSL(variation * 0.25, variation, variation);
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
      const link = new THREE.Mesh(stemGeometry(curve, initialPose.lengthScale, node.scale), new THREE.MeshStandardMaterial({ color: 0x6c7050, roughness: 0.92, transparent: true, opacity: 0.8 }));
      this.linkGroup.add(link);
      this.nodes.set(node.id, { node, mesh, pick, link, vein, position, center, color, size: node.scale, currentBytes: node.size, sizeKnown: node.sizeKnown, areaRatio: node.areaRatio, folder, quaternion: mesh.quaternion.clone() });
    }
    this.pickables = [...this.nodes.values()].map(record => record.pick).concat([...this.folders.values()].map(folder => folder.mesh));
    this.activeIds = new Set(initialFrame.activeIds);
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
      const frame = stateAt(model, cursor);
      const pose = createTreePose(this.layout, { frame });
      for (const x of [pose.bounds.min[0], pose.bounds.max[0]]) for (const y of [pose.bounds.min[1], pose.bounds.max[1]]) for (const z of [pose.bounds.min[2], pose.bounds.max[2]]) this.cameraPoints.push(new THREE.Vector3(x, y, z));
      const roots = createRootLayout(model, { repositoryWidth: this.roots.repositoryWidth, activeIds: frame.activeIds, paths: Object.fromEntries(frame.files.map(file => [file.id, file.path])) });
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
      this._preparePose(nextIndex, previousActive);
      if (!this.animateTransition) this.trunkRadius = this.radiusTarget;
    }
    this.index = nextIndex;
    this.commitCount = commitCount ?? this.model?.commits.length ?? 0;
    this.frameKey = frameKey;
    this.roots.setFrame({ activeIds: this.activeIds, paths: this.paths, changedIds: this.changedIds, statuses: this.statuses, selectedId, frameKey, index: this.index, duration: this.duration, animate: different && this.animateTransition });
    if (selectedId !== undefined) this.select(selectedId);
    this.update(0);
  }

  _preparePose(index, previousActive = this.activeIds) {
    const pose = createTreePose(this.layout, { frame: stateAt(this.model, index), activeIds: this.activeIds });
    this.radiusTarget = pose.trunkRadius;
    this.byteSummary = pose.sizeSummary;
    this.leafSizing = pose.sizing;
    const surfaces = [], folders = [], nodes = [];
    for (const target of pose.folders) {
      const record = this.folders.get(target.path);
      const curve = new THREE.CubicBezierCurve3(...target.curve.map(asVector));
      const geometry = branchGeometry(curve, { trunk: !target.path, segments: target.path ? 28 : 44 });
      setBranchRadius(geometry, target.radius);
      surfaces.push(surfaceTransition(record.mesh.geometry, geometry));
      folders.push({ record, fromRadius: record.radius, toRadius: target.radius, from: record.position.clone(), to: asVector(target.position), fromCurve: [record.curve.v0, record.curve.v1, record.curve.v2, record.curve.v3].map(point => point.clone()), toCurve: target.curve.map(asVector) });
      record.loadBytes = target.loadBytes;
      record.radiusTarget = target.radius;
      record.loadCount = target.loadCount;
      record.loadWeight = target.loadWeight;
      record.lengthFactor = target.lengthFactor;
      record.droop = target.droop;
    }
    for (const target of pose.nodes) {
      const record = this.nodes.get(target.id);
      const curve = new THREE.QuadraticBezierCurve3(asVector(target.stemStart), asVector(target.stemControl), asVector(target.position));
      const geometry = stemGeometry(curve, pose.lengthScale, target.scale);
      surfaces.push(surfaceTransition(record.link.geometry, geometry));
      const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, asVector(target.direction));
      quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(UP, target.roll));
      const fromSize = this.animateTransition && !previousActive.has(target.id) && this.activeIds.has(target.id) ? 0 : record.size;
      nodes.push({ record, from: record.position.clone(), to: asVector(target.position), fromQuaternion: record.quaternion.clone(), toQuaternion: quaternion, fromSize, toSize: target.scale });
      record.currentBytes = target.size;
      record.sizeKnown = target.sizeKnown;
      record.areaRatio = target.areaRatio;
      record.node = target;
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
    for (const { record, from, to, fromCurve, toCurve, fromRadius, toRadius } of pose.folders) {
      record.radius = THREE.MathUtils.lerp(fromRadius, toRadius, amount);
      record.position.lerpVectors(from, to, amount);
      [record.curve.v0, record.curve.v1, record.curve.v2, record.curve.v3].forEach((point, index) => point.lerpVectors(fromCurve[index], toCurve[index], amount));
      record.curve.needsUpdate = true;
    }
    for (const { record, from, to, fromQuaternion, toQuaternion, fromSize, toSize } of pose.nodes) {
      // Interpolate quantitative area, rather than exaggerating the scale curve.
      record.size = Math.sqrt(THREE.MathUtils.lerp(fromSize * fromSize, toSize * toSize, amount));
      record.position.lerpVectors(from, to, amount);
      record.mesh.position.copy(record.position);
      record.quaternion.slerpQuaternions(fromQuaternion, toQuaternion, amount);
      record.mesh.quaternion.copy(record.quaternion);
      record.center.set(0, 1.85 * record.size, 0).applyQuaternion(record.quaternion).add(record.position);
      record.pick.position.copy(record.center);
      record.pick.scale.setScalar(Math.max(1, record.size * 1.75));
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
    this._updateGroundSurface();
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
    this._advancePresentation(delta);
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
      const active = !branch.path || branch.loadCount > 0;
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
      const size = record.size, opacity = active ? 1 : this.options.ghosts ? 0.105 : 0;
      const material = record.mesh.material;
      record.mesh.visible = opacity > 0 && size > 0;
      record.mesh.scale.setScalar(size);
      material.opacity = opacity;
      material.wireframe = !active || !record.sizeKnown;
      material.depthWrite = active;
      material.color.copy(record.color);
      if (!record.sizeKnown) material.color.lerp(UNKNOWN_COLOR, 0.75);
      if (changed && this.options.activity) material.color.lerp(this.activityColor.setHex(CHANGE_COLORS[status] || CHANGE_COLORS.modified), status === 'modified' ? 0.72 : 0.63);
      if (selected || hovered) material.color.lerp(WHITE, selected ? 0.33 : 0.2);
      material.emissive.copy(material.color);
      material.emissiveIntensity = selected ? 0.27 : hovered ? 0.18 : changed && this.options.activity ? 0.09 + Math.sin(Math.PI * transition) * 0.22 : 0.045;
      record.vein.visible = active && record.sizeKnown && size > 0;
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
  }

  afterCameraUpdate(dt) {
    // Project labels and responsive crowding from the same camera as the render.
    this._updateLabels();
    this.roots.update?.(dt);
    this._updateGroundSurface();
  }

  _updateLabels() {
    super._updateLabels();
    if (this.frameMode === 'roots') for (const record of this.labelRecords) if (record.path) record.object.visible = false;
  }

  _setFrameMode(mode, immediate = false) {
    const changed = this.frameMode !== mode;
    this.frameMode = mode;
    this.selectionInRoots = mode === 'roots';
    if (changed) this._clearHover();
    if (changed && mode === 'roots') this.rootFrameNeedsOrientation = true;
    this.presentationTarget = { ...PRESENTATION[mode] };
    this.controls.setRootMode?.(mode === 'roots');
    this.roots.setPresentationMode(mode === 'roots' ? 'classification' : 'organic');
    this.roots.labels.setFocusMode?.(mode === 'roots');
    this.roots.labelWidths = new Map(this.roots.labels.files.map(label => [label.key, label.textWidth]));
    this.roots.surfaceSignature = null;
    if (immediate || this.reducedMotion) {
      this.presentation = { ...this.presentationTarget };
      this.presentationTransition = null;
      this._applyPresentation();
    } else if (changed || this.presentationTransition) {
      this.presentationTransition = { elapsed: 0, from: { ...this.presentation } };
    }
    if (changed) this.onFocusMode(mode);
  }

  _applyPresentation() {
    for (const [group, scale] of [[this.canopyGroup, this.presentation.canopy], [this.roots.group, this.presentation.roots], [this.groundGroup, this.presentation.roots]]) {
      // A shorter, broader context canopy keeps a sturdy bonsai-like trunk.
      const girth = group === this.canopyGroup ? Math.sqrt(scale) : scale;
      group.scale.set(girth, scale, girth);
      group.position.set(0, GROUND_Y * (1 - scale), 0);
    }
    this.group.updateWorldMatrix(true, true);
  }

  _advancePresentation(delta) {
    const transition = this.presentationTransition;
    if (!transition) return;
    transition.elapsed += delta;
    const amount = this.reducedMotion ? 1 : ease(Math.min(1, transition.elapsed / 0.65));
    for (const part of ['canopy', 'roots']) this.presentation[part] = THREE.MathUtils.lerp(transition.from[part], this.presentationTarget[part], amount);
    this._applyPresentation();
    if (amount === 1) this.presentationTransition = null;
  }

  _presentationPoint(point, part, target = true) {
    const scale = (target ? this.presentationTarget : this.presentation)[part];
    const girth = part === 'canopy' ? Math.sqrt(scale) : scale;
    return point.clone().multiply(new THREE.Vector3(girth, scale, girth))
      .add(new THREE.Vector3(0, GROUND_Y * (1 - scale), 0));
  }

  _clearWorld() {
    if (this.groundGroup) {
      for (const object of [...this.groundGroup.children]) this.world.add(object);
    }
    super._clearWorld();
  }

  _updateGroundSurface() {
    if (!this.ground || !this.groundContour) return;
    const baseSize = this.roots?.layout?.base || this.roots?.baseLayout?.base || FLAT_GROUND;
    const radiusX = baseSize.radiusX, radiusZ = baseSize.radiusZ;
    const signature = `${radiusX}|${radiusZ}`;
    if (signature === this.groundSurfaceSignature) return;
    this.groundSurfaceSignature = signature;
    for (const [geometry, base] of [
      [this.ground.geometry, this.groundBaseVertices],
      [this.groundContour.geometry, this.groundContourBaseVertices],
    ]) {
      const position = geometry.attributes.position;
      for (let offset = 0; offset < base.length; offset += 3) {
        const x = base[offset] * radiusX / 50;
        // The soft soil texture is square; its contour has the original 50:30 ellipse.
        const z = base[offset + 2] * radiusZ / (geometry === this.ground.geometry ? 50 : 30);
        position.array[offset] = x;
        position.array[offset + 1] = base[offset + 1];
        position.array[offset + 2] = z;
      }
      position.needsUpdate = true;
      if (geometry === this.ground.geometry) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
  }

  _flyTo(target, distance, immediate = false, direction = null) {
    this.controls.stop?.();
    const ray = (direction?.clone() || this.camera.position.clone().sub(this.controls.target)).normalize();
    if (ray.lengthSq() < 0.1) ray.set(0.18, 0.13, 1).normalize();
    const width = this.renderer.domElement.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.clientHeight || window.innerHeight;
    const rightPanel = width > 900 ? 390 : width > 700 ? 330 : 0;
    const leftGuide = width > 1100 ? 235 : width > 700 ? 200 : 0;
    const right = this._cameraRight(ray);
    const shift = distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * (rightPanel - leftGuide) / height;
    const endTarget = target.clone().addScaledVector(right, shift);
    const endPosition = endTarget.clone().addScaledVector(ray, distance);
    if (immediate || this.reducedMotion) { this.camera.position.copy(endPosition); this.controls.target.copy(endTarget); this.camera.lookAt(endTarget); this.tween = null; return; }
    this.tween = { elapsed: 0, from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to: endPosition, toTarget: endTarget };
  }

  resetView(immediate = false) {
    if (!this.layout) return;
    this._setFrameMode('tree', immediate);
    this.controls.stop?.();
    this.camera.up.copy(UP);
    const width = this.renderer.domElement.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.clientHeight || window.innerHeight;
    const availableWidth = Math.max(270, width - (width > 1100 ? 660 : width > 900 ? 610 : width > 700 ? 555 : 36));
    const availableHeight = Math.max(250, height - (width > 700 ? 210 : 290));
    const ray = new THREE.Vector3(0, 0.12, 1).normalize();
    const right = new THREE.Vector3().crossVectors(UP, ray).normalize();
    const up = new THREE.Vector3().crossVectors(ray, right);
    const canopy = this.cameraPoints || [...this.layout.nodes.map(node => asVector(node.position)), ...this.layout.trunk.map(asVector)];
    const rootLayout = this.roots?.growthLayout;
    const rootBounds = rootLayout ? new THREE.Box3(asVector(rootLayout.bounds.min), asVector(rootLayout.bounds.max)) : this.roots?.getBounds();
    const currentRoots = rootBounds && !rootBounds.isEmpty() ? this._boundsPoints(rootBounds) : [];
    const canopyPoints = canopy.map(point => this._presentationPoint(point, 'canopy'));
    const points = this.options.roots ? [...canopyPoints, ...[...(this.rootCameraPoints || []), ...currentRoots].map(point => this._presentationPoint(point, 'roots'))] : canopyPoints;
    this.center = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
    const halfWidth = Math.max(14, ...points.map(point => Math.abs(point.clone().sub(this.center).dot(right)))) + 8;
    const halfHeight = Math.max(20, ...points.map(point => Math.abs(point.clone().sub(this.center).dot(up)))) + 7;
    const depth = Math.max(4, ...points.map(point => Math.abs(point.clone().sub(this.center).dot(ray))));
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distance = Math.max(halfWidth / (tangent * availableWidth / height), halfHeight / (tangent * availableHeight / height)) + depth * 0.45;
    this.controls.maxDistance = Math.max(650, distance * 1.2);
    // Leave room for persistent filenames beneath the roots on narrow screens.
    const target = this.center.clone();
    if (this.options.roots && width <= 700) target.addScaledVector(up, -2 * distance * tangent * 35 / height);
    this._flyTo(target, distance, immediate, ray);
  }

  get activityState() { return this.roots?.activityState; }
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
    this.group.updateWorldMatrix(true, true);
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
      this._setFrameMode('roots');
      this.roots.setFocusFolder(null);
      const rootPosition = this.roots.files.get(id)?.position.clone();
      if (rootPosition) {
        this.select(id);
        this._frameRootsBounds(new THREE.Box3().setFromCenterAndSize(rootPosition, new THREE.Vector3(4, 4, 4)), false, '', id);
        return;
      }
    }
    const record = this.nodes.get(id);
    if (!record) return;
    this._setFrameMode('tree');
    this.select(id);
    this._flyTo(this._presentationPoint(record.position, 'canopy'), Math.max(14, record.size * 17));
  }

  focusFolder(path) {
    if (this.lastHit?.root && this.lastHit.path === path) this.focusRootFolder(path);
    else { this._setFrameMode('tree'); super.focusFolder(path); }
  }

  focusRootFolder(path) {
    if (!this.options.roots) { super.focusFolder(path); return; }
    this.selectionInRoots = true;
    this._setFrameMode('roots');
    const bounds = path ? this.roots?.getFolderBounds(path) : this.roots?.getBounds();
    if (!bounds || bounds.isEmpty()) return;
    this.roots.setFocusFolder(path);
    this._frameRootsBounds(bounds, false, path);
  }

  focusRoots() {
    if (!this.options.roots) return;
    this.roots.setFocusFolder(null);
    this.selectionInRoots = true;
    this._setFrameMode('roots');
    const bounds = this.roots?.getBounds();
    if (bounds && !bounds.isEmpty()) this._frameRootsBounds(bounds, true);
  }

  _boundsPoints(bounds) {
    const points = [];
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) points.push(new THREE.Vector3(x, y, z));
    return points;
  }

  _frameRootsBounds(bounds, overview = false, path = '', fileId = null) {
    const width = this.renderer.domElement.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.clientHeight || window.innerHeight;
    // Explicit framing may run before the shared resize listener. The canvas
    // bounds and perspective must agree before computing any screen-space fit.
    if (this.camera.aspect !== width / height) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    const classification = this.roots.layout?.kind === 'classification';
    const obstacles = this.roots.labels?._screenObstacles?.(width, height);
    const region = rootReadableViewport(width, height, obstacles);
    this.rootViewport = region;
    const availableWidth = Math.max(80, region.right - region.left - 24);
    const availableHeight = Math.max(80, region.bottom - region.top - 24);
    this.controls.stop?.();
    const resetOrientation = overview || (classification && this.rootFrameNeedsOrientation);
    if (resetOrientation) this.camera.up.set(0, 1, 0);
    const ray = resetOrientation ? new THREE.Vector3(0, classification ? 0 : .32, 1) : this.camera.position.clone().sub(this.controls.target);
    if (ray.lengthSq() < 1e-8) ray.set(0, 0, 1);
    ray.normalize();
    this.rootFrameNeedsOrientation = false;
    const right = this._cameraRight(ray), up = new THREE.Vector3().crossVectors(ray, right).normalize();
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const fit = layout => {
      const points = [];
      const add = (control, radius = 0.5) => {
        for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
          const point = asVector(control);
          point.setComponent(axis, point.getComponent(axis) + sign * radius);
          points.push(this._presentationPoint(point, 'roots'));
        }
      };
      if (fileId) {
        const file = layout.nodes.find(node => node.id === fileId);
        if (file) add(file.position, 2);
      } else {
        const junction = layout.folders.find(folder => folder.path === path);
        if (junction) add(junction.position);
        for (const record of [...layout.folders, ...layout.nodes]) {
          const folder = record.kind === 'file' ? record.folder : record.path;
          if (path && folder !== path && !folder.startsWith(`${path}/`)) continue;
          if (path && record.kind !== 'file' && record.path === path) continue;
          const source = record.kind === 'file' ? this.roots.files.get(record.id) : this.roots.folders.get(record.path);
          for (const point of record.curve) add(point, Math.max(0.5, source?.radiusTarget || source?.radius || 0.5));
        }
      }
      if (overview && layout.base && !classification) {
        for (let index = 0; index < 48; index++) {
          const angle = index / 48 * Math.PI * 2;
          const x = Math.cos(angle) * layout.base.radiusX, z = Math.sin(angle) * layout.base.radiusZ;
          add([x, layout.groundY, z]);
        }
      }
      if (!points.length) points.push(...this._boundsPoints(bounds).map(point => this._presentationPoint(point, 'roots')));
      const center = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
      let distance = 24;
      for (const point of points) {
        const offset = point.clone().sub(center), depth = offset.dot(ray);
        distance = Math.max(distance,
          depth + Math.abs(offset.dot(right)) * height / (tangent * availableWidth),
          depth + Math.abs(offset.dot(up)) * height / (tangent * availableHeight));
      }
      distance *= 1.025;
      const target = center.clone();
      const labelByKey = new Map((this.roots.labels?.records || []).map(label => [`${label.kind}:${label.key}`, label]));
      const names = classification ? [...layout.folders, ...layout.nodes].filter(record => {
        if (record.kind !== 'file' && !record.path) return false;
        const source = record.kind === 'file' ? this.roots.files.get(record.id) : this.roots.folders.get(record.path);
        if (!(source?.touchCount > 0)) return false;
        if (fileId) return record.kind === 'file' && record.id === fileId;
        return !path || record.path === path || record.path.startsWith(`${path}/`);
      }).map(record => {
        const key = record.kind === 'file' ? record.id : record.path;
        const label = labelByKey.get(`${record.kind}:${key}`);
        return { point: this._presentationPoint(asVector(record.position), 'roots'), direction: asVector(record.labelDirection || layout.classification?.growthDirection || [record.side || 1, 0, 0]),
          width: (label?.textWidth || String(record.name || record.path.split('/').pop()).length * 7) + (record.kind === 'file' ? 4 : 6),
          height: label?.boxHeight || (record.kind === 'file' ? 16 : 18), gap: record.kind === 'file' ? 6 : 8 };
      }) : [];
      const probe = this.camera.clone();
      const screen = point => { const p = point.clone().project(probe); return { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 }; };
      const projectedBounds = () => {
        let left = Infinity, rightEdge = -Infinity, top = Infinity, bottom = -Infinity;
        for (const point of points) { const p = screen(point); left = Math.min(left, p.x); rightEdge = Math.max(rightEdge, p.x); top = Math.min(top, p.y); bottom = Math.max(bottom, p.y); }
        return { left, right: rightEdge, top, bottom };
      };
      probe.up.copy(this.camera.up); probe.position.copy(center).addScaledVector(ray, distance); probe.lookAt(center); probe.updateMatrixWorld(true);
      const geometryBox = projectedBounds();
      const nameBox = { ...geometryBox };
      for (const name of names) {
        // A fixed-pixel name wider than the usable pane can never be fitted by
        // zooming. Its label remains available when the user inspects its tip.
        if (name.width + name.gap > availableWidth || name.height + name.gap > availableHeight) continue;
        const p = screen(name.point), direction = screen(name.point.clone().add(name.direction));
        const dx = direction.x - p.x, dy = direction.y - p.y;
        let left, top;
        if (Math.abs(dx) >= Math.abs(dy)) {
          left = dx >= 0 ? p.x + name.gap : p.x - name.width - name.gap;
          top = p.y - name.height / 2;
        } else {
          left = p.x - name.width / 2;
          top = dy >= 0 ? p.y + name.gap : p.y - name.height - name.gap;
        }
        nameBox.left = Math.min(nameBox.left, left); nameBox.right = Math.max(nameBox.right, left + name.width);
        nameBox.top = Math.min(nameBox.top, top); nameBox.bottom = Math.max(nameBox.bottom, top + name.height);
      }
      const padding = {
        left: geometryBox.left - nameBox.left, right: nameBox.right - geometryBox.right,
        top: geometryBox.top - nameBox.top, bottom: nameBox.bottom - geometryBox.bottom,
      };
      // Opposing names may be individually feasible yet collectively wider
      // than a phone. Reserve a bounded text margin once, then fit geometry;
      // never repeatedly zoom against an impossible fixed-pixel text extent.
      const budget = fileId ? .82 : overview ? .24 : .30;
      for (const [first, second, extent] of [['left', 'right', availableWidth], ['top', 'bottom', availableHeight]]) {
        const total = padding[first] + padding[second];
        const factor = total ? Math.min(1, extent * budget / total) : 1;
        padding[first] *= factor; padding[second] *= factor;
      }
      const contentWidth = availableWidth - padding.left - padding.right;
      const contentHeight = availableHeight - padding.top - padding.bottom;
      distance = 24;
      for (const point of points) {
        const offset = point.clone().sub(center), depth = offset.dot(ray);
        distance = Math.max(distance, depth + Math.abs(offset.dot(right)) * height / (tangent * contentWidth), depth + Math.abs(offset.dot(up)) * height / (tangent * contentHeight));
      }
      distance *= 1.025;
      const regionX = (region.left + padding.left + region.right - padding.right) / 2;
      const regionY = (region.top + padding.top + region.bottom - padding.bottom) / 2;
      // Only the projected geometry participates in these perspective/centering
      // corrections, so text cannot push the camera toward an infinite zoom-out.
      for (let pass = 0; pass < 3; pass++) {
        probe.position.copy(target).addScaledVector(ray, distance); probe.lookAt(target); probe.updateMatrixWorld(true);
        const box = projectedBounds();
        const ratio = Math.max((box.right - box.left) / contentWidth, (box.bottom - box.top) / contentHeight);
        if (ratio > 1.002) distance *= ratio * 1.015;
        const unit = 2 * distance * tangent / height;
        target.addScaledVector(right, ((box.left + box.right) / 2 - regionX) * unit);
        target.addScaledVector(up, -((box.top + box.bottom) / 2 - regionY) * unit);
      }
      this.rootReadingFrame = null;
      // Top-down folder focus retains every descendant level and its junction.
      // Zoom and pan are explicit; no horizontal-row zoom is applied to lanes.
      return { distance, target, position: target.clone().addScaledVector(ray, distance) };
    };
    // Roots have a fixed data pose. Framing never changes their length, bends
    // the ground, or shifts neighboring paths to make labels fit.
    const pose = fit(this.roots.layout || this.roots.growthLayout);
    this.controls.maxDistance = Math.max(650, pose.distance * 1.25);
    if (this.reducedMotion) {
      this.camera.position.copy(pose.position); this.controls.target.copy(pose.target);
      this.camera.lookAt(pose.target); this.tween = null;
    } else this.tween = { elapsed: 0, from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to: pose.position, toTarget: pose.target };
  }

  getRootScreenPoint(id) { return this.roots?.getRootNodeScreenPoint(id); }

  dispose() {
    if (this.disposed) return;
    this.roots?.dispose();
    super.dispose();
    this.poseTransition = null;
    this.poseTarget = null;
    this.ground = this.groundContour = null;
    this.groundBaseVertices = this.groundContourBaseVertices = null;
    this.groundSurfaceSignature = null;
    this.rootCameraPoints = [];
    this.cameraPoints = [];
  }

  getNodeScreenPoint(id) {
    const record = this.nodes.get(id);
    if (!record) return this.options.roots ? this.roots?.getRootNodeScreenPoint(id) : null;
    this.camera.updateMatrixWorld();
    const point = this.world.localToWorld(record.center.clone()).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (point.x * 0.5 + 0.5) * rect.width, y: rect.top + (-point.y * 0.5 + 0.5) * rect.height, visible: point.z > -1 && point.z < 1 && Math.abs(point.x) < 1 && Math.abs(point.y) < 1 };
  }
}
