import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRootLayout } from './root-layout.js';
import { CHANGE_COLORS, FOLDER_COLORS } from './encoding.js';

const asVector = point => new THREE.Vector3(...point);
const toSet = value => value instanceof Set ? value : new Set(value || []);
const makeCurve = points => new THREE.CubicBezierCurve3(...points.map(asVector));
const BARK_COLOR = new THREE.Color(0x9f7e5d);
const TIP_COLOR = new THREE.Color(0xd6bea0);
const SELECTED_COLOR = new THREE.Color(0xe1eefc);
const LABEL_LIMIT = 48;

function rootGeometry(curve, startRadius, endRadius, color, segments = 16, sides = 7) {
  const geometry = new THREE.TubeGeometry(curve, segments, 1, sides, false);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  for (let ring = 0; ring <= segments; ring++) {
    const t = ring / segments;
    const center = curve.getPointAt(t);
    const radius = endRadius + (startRadius - endRadius) * Math.pow(1 - t, 0.82);
    for (let side = 0; side <= sides; side++) {
      const index = ring * (sides + 1) + side;
      const angle = side / sides * Math.PI * 2;
      const rib = 1 + Math.sin(angle * 3 + t * 5) * 0.045;
      const shade = 0.88 + Math.sin(angle * 5 + t * 9) * 0.075;
      positions.setXYZ(index,
        center.x + (positions.getX(index) - center.x) * radius * rib,
        center.y + (positions.getY(index) - center.y) * radius * rib,
        center.z + (positions.getZ(index) - center.z) * radius * rib);
      colors[index * 3] = color.r * shade;
      colors[index * 3 + 1] = color.g * shade;
      colors[index * 3 + 2] = color.b * shade;
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function mergedMesh(geometries, material) {
  if (!geometries.length) { material.dispose(); return null; }
  const geometry = mergeGeometries(geometries, false);
  for (const source of geometries) source.dispose();
  geometry.computeBoundingSphere();
  return new THREE.Mesh(geometry, material);
}

/** Organic roots follow the complete, balanced directory hierarchy below the trunk. */
export class RepositoryRoots {
  constructor(stage) {
    this.stage = stage;
    this.camera = stage.camera;
    this.group = new THREE.Group();
    this.group.name = 'Data Lab · Repository roots';
    stage.scene.add(this.group);
    this.files = new Map();
    this.folders = new Map();
    this.options = { roots: true, labels: true, activity: true };
    this.selectedId = null;
    this.hovered = null;
    this.changedIds = new Set();
    this.statuses = {};
    this.labelRecords = [];
    this.labelCandidates = [];
    this.folderFaces = [];
    this.pickables = [];
    this.signature = null;
    this.disposed = false;
    this.projected = new THREE.Vector3();
  }

  setModel(model) {
    this._clear();
    this.model = model;
    this.selectedId = null;
    this.hovered = null;
    this.signature = null;
    this.setFrame({ activeIds: new Set(model.nodes.filter(node => node.existsAtHead !== false).map(node => node.id)) });
  }

  setFrame({ activeIds, visibleIds, paths = {}, changedIds, statuses = {}, selectedId } = {}) {
    if (!this.model || this.disposed) return;
    const active = toSet(activeIds ?? visibleIds ?? this.activeIds);
    const currentPaths = paths instanceof Map ? Object.fromEntries(paths) : paths;
    this.activeIds = active;
    this.changedIds = toSet(changedIds);
    this.statuses = statuses instanceof Map ? Object.fromEntries(statuses) : statuses;
    if (selectedId !== undefined) this.selectedId = selectedId;
    const signature = JSON.stringify(this.model.nodes.filter(node => active.has(node.id))
      .map(node => [node.id, currentPaths[node.id] ?? node.path]).sort(([a], [b]) => a.localeCompare(b)));
    if (signature !== this.signature) {
      this.signature = signature;
      this._build(createRootLayout(this.model, { activeIds: active, paths: currentPaths, groundY: -40 }));
    }
    this._updateColors();
    this._updateSelection();
  }

  _build(layout) {
    this._clear();
    this.layout = layout;
    this.bounds = new THREE.Box3(asVector(layout.bounds.min), asVector(layout.bounds.max));
    this.renderedCount = layout.nodes.length;
    const topPaths = layout.folders.filter(folder => folder.depth === 1).map(folder => folder.path).sort();
    const colorFor = path => new THREE.Color(FOLDER_COLORS[Math.max(0, topPaths.indexOf(path.split('/')[0])) % FOLDER_COLORS.length]);
    const branchGeometries = [];
    let faceOffset = 0;
    for (const folder of layout.folders) {
      const color = colorFor(folder.path);
      const record = { ...folder, visible: true, position: asVector(folder.position), color, curve: makeCurve(folder.curve) };
      this.folders.set(folder.path, record);
      // The existing above-ground trunk is the repository root. There is no
      // second root icon, hub, collar, or label below the soil.
      if (!folder.path) continue;
      const share = folder.count / Math.max(1, layout.fileCount);
      const radius = 0.18 + 2.35 * Math.pow(share, 0.57) * Math.pow(0.82, folder.depth - 1);
      const geometry = rootGeometry(record.curve, radius, Math.max(0.13, radius * 0.78), BARK_COLOR.clone().lerp(color, 0.22));
      const faceCount = geometry.index.count / 3;
      this.folderFaces.push({ first: faceOffset, end: faceOffset + faceCount, path: folder.path });
      faceOffset += faceCount;
      branchGeometries.push(geometry);
      record.labelPosition = record.position.clone().add(new THREE.Vector3(0, 2.1, 0));
      this.labelCandidates.push(record);
    }
    this.branchMesh = mergedMesh(branchGeometries, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0.025, emissive: 0x392919, emissiveIntensity: 0.11 }));
    if (this.branchMesh) { this.group.add(this.branchMesh); this.pickables.push(this.branchMesh); }

    const filaments = [];
    const count = layout.nodes.length;
    if (count) {
      this.tips = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.38, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.63, metalness: 0.04, emissive: 0x483421, emissiveIntensity: 0.16 }), count);
      this.tipPicks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.8, 1), new THREE.MeshBasicMaterial({ visible: false }), count);
      const matrix = new THREE.Matrix4();
      for (let index = 0; index < count; index++) {
        const node = layout.nodes[index];
        const position = asVector(node.position);
        const folder = this.folders.get(node.folder);
        const color = TIP_COLOR.clone().lerp(folder.color, 0.35);
        const curve = makeCurve(node.curve);
        filaments.push(rootGeometry(curve, 0.12, 0.045, BARK_COLOR.clone().lerp(folder.color, 0.26), 10, 4));
        matrix.makeTranslation(position.x, position.y, position.z);
        this.tips.setMatrixAt(index, matrix); this.tipPicks.setMatrixAt(index, matrix);
        this.tips.setColorAt(index, color);
        this.tipIds.push(node.id);
        this.files.set(node.id, { node, visible: true, position, color, curve, folder, instanceIndex: index });
      }
      this.tips.computeBoundingSphere(); this.tipPicks.computeBoundingSphere();
      this.group.add(this.tips, this.tipPicks);
      this.pickables.push(this.tipPicks);
    }
    this.filamentMesh = mergedMesh(filaments, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.91, metalness: 0, emissive: 0x332619, emissiveIntensity: 0.1 }));
    if (this.filamentMesh) this.group.add(this.filamentMesh);

    // A bounded pool keeps label DOM work independent of repository size. Every
    // folder remains rendered and focusable; labels follow visible subtrees.
    this.labelCandidates.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
    for (let index = 0; index < Math.min(LABEL_LIMIT, this.labelCandidates.length); index++) {
      const element = document.createElement('div');
      element.className = 'body-label small data-root-label';
      element.style.cssText = 'font-size:10px;text-shadow:0 1px 6px #000;opacity:.9;pointer-events:none;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const object = new CSS2DObject(element);
      object.visible = false;
      this.group.add(object);
      this.labelRecords.push({ object, position: new THREE.Vector3(), text: '', target: null });
    }
    this.selectionTrace = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xc9dce9, transparent: true, opacity: 0.72, depthWrite: false, depthTest: false }));
    this.selectionTrace.visible = false;
    this.selectionTrace.renderOrder = 2;
    this.group.add(this.selectionTrace);
    const element = document.createElement('div');
    element.className = 'body-label small data-root-label data-root-selection';
    element.style.cssText = 'font-size:11px;color:#e3d2b4;text-shadow:0 1px 5px #000;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;';
    this.detailLabel = new CSS2DObject(element);
    this.detailLabel.visible = false;
    this.group.add(this.detailLabel);
    this.group.visible = this.options.roots;
    if (this.hovered?.kind === 'file' && !this.files.has(this.hovered.id)) this.hovered = null;
    if (this.hovered?.kind === 'folder' && !this.folders.has(this.hovered.path)) this.hovered = null;
  }

  _updateColors() {
    if (!this.tips) return;
    const color = new THREE.Color();
    for (const [id, record] of this.files) {
      color.copy(record.color);
      if (this.options.activity && this.changedIds.has(id)) color.lerp(new THREE.Color(CHANGE_COLORS[this.statuses[id]] || CHANGE_COLORS.modified), 0.8);
      if (id === this.selectedId || this.hovered?.id === id) color.lerp(SELECTED_COLOR, 0.75);
      this.tips.setColorAt(record.instanceIndex, color);
    }
    this.tips.instanceColor.needsUpdate = true;
  }

  _updateSelection() {
    if (!this.selectionTrace) return;
    const file = this.files.get(this.selectedId);
    const positions = [];
    if (file) {
      const curves = [file.curve];
      let folder = file.folder;
      while (folder?.path) { curves.push(folder.curve); folder = this.folders.get(folder.parent); }
      for (const curve of curves) {
        const points = curve.getPoints(24);
        for (let index = 1; index < points.length; index++) positions.push(...points[index - 1].toArray(), ...points[index].toArray());
      }
    }
    this.selectionTrace.geometry.dispose();
    this.selectionTrace.geometry = new THREE.BufferGeometry();
    this.selectionTrace.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.selectionTrace.visible = positions.length > 0;
  }

  select(id) {
    if (id === this.selectedId) return;
    this.selectedId = id || null;
    this._updateColors(); this._updateSelection();
  }

  setHovered(hit) {
    const next = hit?.root ? hit : null;
    if (next?.kind === this.hovered?.kind && next?.id === this.hovered?.id && next?.path === this.hovered?.path) return;
    this.hovered = next;
    this._updateColors();
  }

  setOptions(options = {}) {
    Object.assign(this.options, options);
    this.group.visible = this.options.roots !== false;
    if (!this.group.visible) this.hovered = null;
    this._updateColors();
  }

  update() {
    if (this.disposed || !this.layout) return;
    const showLabels = this.options.roots && this.options.labels;
    const width = this.stage.renderer.domElement.clientWidth;
    const height = this.stage.renderer.domElement.clientHeight;
    const highlighted = this.hovered?.kind === 'file' ? this.files.get(this.hovered.id)
      : this.hovered?.kind === 'folder' ? this.folders.get(this.hovered.path)
      : this.files.get(this.selectedId);
    this.detailLabel.visible = Boolean(showLabels && highlighted);
    if (highlighted) {
      this.detailLabel.position.copy(highlighted.position).add(new THREE.Vector3(0, -2, 0));
      this.detailLabel.element.textContent = highlighted.node?.path || `${highlighted.path}/`;
    }
    for (const record of this.labelRecords) { record.object.visible = false; record.target = null; }
    if (!showLabels) return;
    const occupied = [];
    let used = 0;
    for (const folder of this.labelCandidates) {
      if (used >= this.labelRecords.length) break;
      this.projected.copy(folder.labelPosition).project(this.camera);
      if (this.projected.z < -1 || this.projected.z > 1 || Math.abs(this.projected.x) > 1 || Math.abs(this.projected.y) > 1) continue;
      const x = (this.projected.x * 0.5 + 0.5) * width;
      const y = (-this.projected.y * 0.5 + 0.5) * height;
      const half = Math.min(100, folder.path.length * 3.2 + 8);
      if (occupied.some(box => Math.abs(x - box.x) < half + box.half && Math.abs(y - box.y) < 23)) continue;
      occupied.push({ x, y, half });
      const label = this.labelRecords[used++];
      label.text = `${folder.path}/`;
      label.position.copy(folder.labelPosition);
      label.object.position.copy(folder.labelPosition);
      label.object.element.textContent = label.text;
      label.object.element.style.color = `#${folder.color.clone().lerp(TIP_COLOR, 0.45).getHexString()}`;
      label.object.visible = true;
      label.target = { kind: 'folder', path: folder.path, root: true };
    }
  }

  hit(raycaster) {
    if (this.disposed || !this.group.visible) return null;
    this.group.updateMatrixWorld(true);
    if (this.options.labels) {
      const projected = raycaster.ray.at(1, new THREE.Vector3()).project(this.camera);
      const canvas = this.stage.renderer.domElement.getBoundingClientRect();
      const x = canvas.left + (projected.x * 0.5 + 0.5) * canvas.width;
      const y = canvas.top + (-projected.y * 0.5 + 0.5) * canvas.height;
      for (const record of this.labelRecords) {
        if (!record.target || !record.object.visible) continue;
        const rect = record.object.element.getBoundingClientRect?.();
        if (rect?.width && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { ...record.target, distance: 0 };
      }
    }
    for (const hit of raycaster.intersectObjects(this.pickables, false)) {
      if (hit.object === this.tipPicks) {
        const id = this.tipIds[hit.instanceId];
        const file = this.files.get(id);
        if (file) return { kind: 'file', id, path: file.node.path, root: true, distance: hit.distance };
      } else if (hit.object === this.branchMesh) {
        const folder = this.folderFaces.find(range => hit.faceIndex >= range.first && hit.faceIndex < range.end);
        if (folder) return { kind: 'folder', path: folder.path, root: true, distance: hit.distance };
      }
    }
    return null;
  }

  getNodePosition(id) { return this.files.get(id)?.position.clone() || null; }
  getBounds() { return this.bounds?.clone() || new THREE.Box3(new THREE.Vector3(0, -40, 0), new THREE.Vector3(0, -40, 0)); }

  getFolderBounds(path = '') {
    const folder = this.folders.get(path);
    if (!folder) return null;
    const bounds = new THREE.Box3().expandByPoint(folder.position);
    for (const file of this.files.values()) if (!path || file.node.folder === path || file.node.folder.startsWith(`${path}/`)) {
      bounds.expandByPoint(file.position);
      for (const point of [file.curve.v0, file.curve.v1, file.curve.v2, file.curve.v3]) bounds.expandByPoint(point);
    }
    for (const record of this.folders.values()) if (!path || record.path.startsWith(`${path}/`)) {
      bounds.expandByPoint(record.position);
      for (const point of [record.curve.v0, record.curve.v1, record.curve.v2, record.curve.v3]) bounds.expandByPoint(point);
    }
    return bounds.expandByScalar(2.5);
  }

  getRootNodeScreenPoint(id) {
    const position = this.getNodePosition(id);
    if (!position || !this.group.visible) return null;
    this.camera.updateMatrixWorld();
    const point = position.project(this.camera);
    const rect = this.stage.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (point.x * 0.5 + 0.5) * rect.width, y: rect.top + (-point.y * 0.5 + 0.5) * rect.height, visible: point.z > -1 && point.z < 1 && Math.abs(point.x) < 1 && Math.abs(point.y) < 1 };
  }

  _clear() {
    const disposed = new Set();
    this.group.traverse(object => {
      object.element?.remove();
      if (object.isInstancedMesh) object.dispose();
      for (const item of [object.geometry, ...(Array.isArray(object.material) ? object.material : [object.material])]) {
        if (item && !disposed.has(item)) { item.dispose(); disposed.add(item); }
      }
    });
    this.group.clear(); this.files.clear(); this.folders.clear();
    this.labelRecords = []; this.labelCandidates = []; this.folderFaces = []; this.pickables = [];
    this.tips = this.tipPicks = this.branchMesh = this.filamentMesh = this.selectionTrace = this.detailLabel = null;
    this.tipIds = [];
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._clear();
    this.group.removeFromParent();
    this.layout = this.model = this.bounds = null;
  }
}
