import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createRootLayout } from './root-layout.js';
import { CHANGE_COLORS, FOLDER_COLORS, fileKind } from './encoding.js';

const asVector = point => new THREE.Vector3(...point);
const toSet = value => value instanceof Set ? value : new Set(value || []);
const SELECTED_COLOR = new THREE.Color(0xe2efff);
const FILE_COLORS = { code: 0x9abbd8, document: 0xd9c6a4, data: 0xb7a4d2 };
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

function folderIconGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.95, -0.58); shape.lineTo(0.95, -0.58);
  shape.lineTo(0.95, 0.38); shape.lineTo(-0.02, 0.38);
  shape.lineTo(-0.3, 0.68); shape.lineTo(-0.95, 0.68); shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.34, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: 0.055, bevelThickness: 0.045 });
  geometry.translate(0, 0, -0.17);
  return geometry;
}

function fileIconGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.52, -0.67); shape.lineTo(0.52, -0.67);
  shape.lineTo(0.52, 0.3); shape.lineTo(0.16, 0.67);
  shape.lineTo(-0.52, 0.67); shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: 0.025, bevelThickness: 0.025 });
  geometry.translate(0, 0, -0.09);
  return geometry;
}

function arrowGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.4, -0.45); shape.lineTo(0.4, 0); shape.lineTo(-0.4, 0.45); shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false });
}

function appendSegments(target, points, color, colors) {
  for (let index = 1; index < points.length; index++) {
    target.push(...points[index - 1].toArray(), ...points[index].toArray());
    if (colors) colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  }
}

function instanceMesh(geometry, count, material) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  return mesh;
}

/** A familiar directory outline below the ground, with depth and shared file identity. */
export class RepositoryRoots {
  constructor(stage) {
    this.stage = stage;
    this.camera = stage.camera;
    this.group = new THREE.Group();
    this.group.name = 'Data Lab · Repository directory tree';
    stage.scene.add(this.group);
    this.files = new Map();
    this.folders = new Map();
    this.options = { roots: true, labels: true, activity: true };
    this.expandedPaths = new Set(['']);
    this.pageByPath = new Map();
    this.pageSize = 32;
    this.selectedId = null;
    this.hovered = null;
    this.changedIds = new Set();
    this.statuses = {};
    this.labelRecords = [];
    this.pickables = [];
    this.signature = null;
    this.disposed = false;
  }

  setModel(model) {
    this._clear();
    this.model = model;
    this.selectedId = null;
    this.hovered = null;
    this.signature = null;
    this.expandedPaths = new Set(['']);
    this.pageByPath = new Map();
    this.setFrame({ activeIds: new Set(model.nodes.filter(node => node.existsAtHead !== false).map(node => node.id)) });
  }

  setFrame({ activeIds, visibleIds, paths = {}, changedIds, statuses = {}, selectedId } = {}) {
    if (!this.model || this.disposed) return;
    const active = toSet(activeIds ?? visibleIds ?? this.activeIds);
    const currentPaths = paths instanceof Map ? Object.fromEntries(paths) : paths;
    this.activeIds = active;
    this.currentPaths = currentPaths;
    this.changedIds = toSet(changedIds);
    this.statuses = statuses instanceof Map ? Object.fromEntries(statuses) : statuses;
    if (selectedId !== undefined) this.selectedId = selectedId;
    const signature = JSON.stringify([
      this.model.nodes.filter(node => active.has(node.id)).map(node => [node.id, currentPaths[node.id] ?? node.path]).sort(([a], [b]) => a.localeCompare(b)),
      [...this.expandedPaths].sort(), [...this.pageByPath].sort(([a], [b]) => a.localeCompare(b)),
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this._build(createRootLayout(this.model, { activeIds: active, paths: currentPaths, groundY: -40, expandedPaths: this.expandedPaths, pageByPath: this.pageByPath, pageSize: this.pageSize }));
    }
    this._updateColors();
    this._updateSelection();
  }

  _rebuild() {
    this.setFrame({ activeIds: this.activeIds, paths: this.currentPaths, changedIds: this.changedIds, statuses: this.statuses, selectedId: this.selectedId });
  }

  toggleFolder(path) {
    if (!this.folders.has(path)) return false;
    if (this.expandedPaths.has(path)) this.expandedPaths.delete(path);
    else this.expandedPaths.add(path);
    this._rebuild();
    return true;
  }

  _openPath(path) {
    const chain = [];
    let current = path;
    while (current) { chain.unshift(current); current = parentOf(current); }
    chain.unshift('');
    for (let index = 0; index < chain.length; index++) {
      this.expandedPaths.add(chain[index]);
      if (!index) continue;
      const parent = this.folders.get(chain[index - 1]);
      const ordinal = parent?.children.indexOf(chain[index]);
      if (ordinal >= 0) this.pageByPath.set(parent.path, Math.floor(ordinal / this.pageSize));
    }
  }

  revealFile(id) {
    const file = this.files.get(id);
    if (!file) return false;
    this._openPath(file.node.folder);
    const folder = this.folders.get(file.node.folder);
    const ordinal = folder.children.length + folder.directFiles.indexOf(id);
    this.pageByPath.set(folder.path, Math.floor(ordinal / this.pageSize));
    this._rebuild();
    return this.files.get(id)?.visible === true;
  }

  revealFolder(path) {
    if (!this.folders.has(path)) return false;
    this._openPath(path);
    this._rebuild();
    return this.folders.get(path)?.visible === true;
  }

  changePage(path, delta) {
    const folder = this.folders.get(path);
    if (!folder) return false;
    const pages = Math.max(1, Math.ceil((folder.children.length + folder.directFiles.length) / this.pageSize));
    const next = THREE.MathUtils.clamp((folder.page || 0) + delta, 0, pages - 1);
    this.pageByPath.set(path, next);
    this._rebuild();
    return true;
  }

  _build(layout) {
    this._clear();
    this.layout = layout;
    this.bounds = new THREE.Box3(asVector(layout.bounds.min), asVector(layout.bounds.max));
    const topPaths = layout.folders.filter(folder => folder.depth === 1).map(folder => folder.path).sort();
    const colorFor = path => new THREE.Color(FOLDER_COLORS[Math.max(0, topPaths.indexOf(path.split('/')[0])) % FOLDER_COLORS.length]);
    for (const folder of layout.folders) {
      const color = folder.path ? colorFor(folder.path).lerp(new THREE.Color(0xc9b078), 0.3) : new THREE.Color(0xd5b475);
      this.folders.set(folder.path, { ...folder, position: asVector(folder.position), color, points: (folder.points || folder.curve).map(asVector), instanceIndex: -1 });
    }
    for (const node of layout.nodes) {
      const folder = this.folders.get(node.folder);
      const color = new THREE.Color(FILE_COLORS[fileKind(node.path)]).lerp(folder.color, 0.18);
      this.files.set(node.id, { node, visible: node.visible, position: asVector(node.position), color, points: (node.points || node.curve).map(asVector), folder, instanceIndex: -1 });
    }
    const visibleFolders = [...this.folders.values()].filter(folder => folder.visible);
    const visibleFiles = [...this.files.values()].filter(file => file.visible);
    this.renderedCount = visibleFiles.length;
    this.folderIds = visibleFolders.map(folder => folder.path);
    this.tipIds = visibleFiles.map(file => file.node.id);
    const material = () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.48, metalness: 0.12, emissive: 0x17243a, emissiveIntensity: 0.12 });
    const matrix = new THREE.Matrix4();
    const addInstances = (records, geometry, indexName, pickName, pickGeometry) => {
      if (!records.length) { geometry.dispose(); pickGeometry.dispose(); return; }
      const mesh = instanceMesh(geometry, records.length, material());
      const pick = instanceMesh(pickGeometry, records.length, new THREE.MeshBasicMaterial({ visible: false }));
      records.forEach((record, index) => {
        record.instanceIndex = index;
        matrix.makeTranslation(record.position.x, record.position.y, record.position.z);
        mesh.setMatrixAt(index, matrix); mesh.setColorAt(index, record.color);
        pick.setMatrixAt(index, matrix);
      });
      mesh.computeBoundingSphere(); pick.computeBoundingSphere();
      this[indexName] = mesh; this[pickName] = pick;
      this.group.add(mesh, pick); this.pickables.push(pick);
    };
    addInstances(visibleFolders, folderIconGeometry(), 'folderIcons', 'folderPicks', new THREE.BoxGeometry(2.4, 1.8, 0.9));
    addInstances(visibleFiles, fileIconGeometry(), 'tips', 'tipPicks', new THREE.BoxGeometry(1.7, 1.8, 0.8));

    const positions = [], colors = [], folds = [];
    appendSegments(positions, [new THREE.Vector3(0, -40, 0), this.folders.get('').position], new THREE.Color(0xb89a6d), colors);
    for (const record of [...visibleFolders, ...visibleFiles]) {
      const color = record.color.clone().multiplyScalar(0.58);
      appendSegments(positions, record.points, color, colors);
      if (record.node) {
        const p = record.position;
        folds.push(p.x + 0.15, p.y + 0.66, p.z + 0.13, p.x + 0.15, p.y + 0.29, p.z + 0.13,
          p.x + 0.15, p.y + 0.29, p.z + 0.13, p.x + 0.51, p.y + 0.29, p.z + 0.13);
      }
    }
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    edgeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.branchMesh = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    this.group.add(this.branchMesh);
    if (folds.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(folds, 3));
      this.group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x34465b, transparent: true, opacity: 0.7 })));
    }
    for (const row of layout.rows) {
      if (row.kind === 'folder') {
        const folder = this.folders.get(row.path);
        const text = `${folder.expanded ? '▾' : '▸'} ${folder.name}/`;
        this._label(text, folder.position.clone().add(new THREE.Vector3(1.4, 0, 0.24)), folder.color, 'folder');
      } else if (row.kind === 'file') {
        const file = this.files.get(row.id);
        this._label(file.node.path.split('/').pop(), file.position.clone().add(new THREE.Vector3(1.3, 0, 0.2)), file.color, 'file');
      } else if (row.kind === 'pager') this._pager(row);
    }
    this.selectionTrace = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xc8ddf4, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false }));
    this.selectionTrace.visible = false;
    this.selectionTrace.renderOrder = 2;
    this.group.add(this.selectionTrace);
    const element = document.createElement('div');
    element.className = 'body-label small data-root-label data-root-selection';
    element.style.cssText = 'font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#e0d3b9;text-shadow:0 1px 5px #000;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;';
    this.detailLabel = new CSS2DObject(element);
    this.detailLabel.visible = false;
    this.group.add(this.detailLabel);
    this.group.visible = this.options.roots;
    if (this.hovered?.kind === 'file' && !this.files.get(this.hovered.id)?.visible) this.hovered = null;
    if (this.hovered?.kind === 'folder' && !this.folders.get(this.hovered.path)?.visible) this.hovered = null;
  }

  _pager(row) {
    const position = asVector(row.position);
    this._label(`${row.page + 1} / ${row.pageCount}`, position.clone().add(new THREE.Vector3(1.5, 0, 0.2)), new THREE.Color(0xa8b8ca), 'pager');
    for (const [delta, enabled, offset] of [[-1, row.hasPrevious, 0], [1, row.hasNext, 12]]) {
      const mesh = new THREE.Mesh(arrowGeometry(), new THREE.MeshStandardMaterial({ color: enabled ? 0xb3c9e2 : 0x344254, roughness: 0.5, metalness: 0.1 }));
      mesh.position.copy(position).add(new THREE.Vector3(offset, 0, 0));
      if (delta < 0) mesh.rotation.z = Math.PI;
      this.group.add(mesh);
      if (enabled) {
        const pick = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1), new THREE.MeshBasicMaterial({ visible: false }));
        pick.position.copy(mesh.position);
        pick.userData = { kind: 'folder', root: true, path: row.path, pagerDelta: delta };
        this.group.add(pick); this.pickables.push(pick);
      }
    }
  }

  _label(text, position, color, kind) {
    const element = document.createElement('div');
    element.className = 'body-label small data-root-label';
    element.textContent = text;
    element.style.cssText = `font:10.5px ui-monospace,SFMono-Regular,Consolas,monospace;color:#${color.getHexString()};text-shadow:0 1px 6px #000;opacity:.94;pointer-events:none;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
    const object = new CSS2DObject(element);
    object.center.set(0, 0.5);
    object.position.copy(position);
    this.group.add(object);
    this.labelRecords.push({ text, position, object, kind });
  }

  _updateColors() {
    const color = new THREE.Color();
    for (const [id, record] of this.files) {
      if (!record.visible || !this.tips) continue;
      color.copy(record.color);
      if (this.options.activity && this.changedIds.has(id)) color.lerp(new THREE.Color(CHANGE_COLORS[this.statuses[id]] || CHANGE_COLORS.modified), 0.8);
      if (id === this.selectedId || this.hovered?.id === id) color.lerp(SELECTED_COLOR, 0.75);
      this.tips.setColorAt(record.instanceIndex, color);
    }
    if (this.tips?.instanceColor) this.tips.instanceColor.needsUpdate = true;
    for (const folder of this.folders.values()) {
      if (!folder.visible || !this.folderIcons) continue;
      color.copy(folder.color);
      if (this.hovered?.kind === 'folder' && this.hovered.path === folder.path) color.lerp(SELECTED_COLOR, 0.5);
      this.folderIcons.setColorAt(folder.instanceIndex, color);
    }
    if (this.folderIcons?.instanceColor) this.folderIcons.instanceColor.needsUpdate = true;
  }

  _updateSelection() {
    if (!this.selectionTrace) return;
    const file = this.files.get(this.selectedId);
    const positions = [];
    if (file) {
      if (file.visible) appendSegments(positions, file.points);
      let folder = file.folder;
      while (folder) {
        if (folder.visible) appendSegments(positions, folder.points);
        folder = folder.parent === null ? null : this.folders.get(folder.parent);
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
    if (next?.kind === this.hovered?.kind && next?.id === this.hovered?.id && next?.path === this.hovered?.path && next?.pagerDelta === this.hovered?.pagerDelta) return;
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
    const occupied = [];
    const width = this.stage.renderer.domElement.clientWidth;
    const height = this.stage.renderer.domElement.clientHeight;
    const highlighted = this.hovered?.kind === 'file' ? this.files.get(this.hovered.id)
      : this.hovered?.kind === 'folder' && !this.hovered.pagerDelta ? this.folders.get(this.hovered.path) : null;
    this.detailLabel.visible = Boolean(showLabels && highlighted);
    if (highlighted) {
      this.detailLabel.position.copy(highlighted.position).add(new THREE.Vector3(0, 1.6, 0.3));
      this.detailLabel.element.textContent = highlighted.node?.path || (highlighted.path ? `${highlighted.path}/` : `${this.model.repository?.name || 'Repository'}/`);
    }
    // Folder rows keep their names at distant overview zooms; zooming the outline
    // makes every file row readable without overlapping fixed-size DOM labels.
    const labels = [...this.labelRecords].sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file'));
    for (const record of labels) {
      record.object.visible = false;
      if (!showLabels) continue;
      const point = record.position.clone().project(this.camera);
      if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) continue;
      const x = (point.x * 0.5 + 0.5) * width;
      const y = (-point.y * 0.5 + 0.5) * height;
      const labelWidth = Math.min(230, record.text.length * 6.4 + 5);
      if (occupied.some(box => x < box.x + box.width && x + labelWidth > box.x && Math.abs(y - box.y) < 13)) continue;
      occupied.push({ x, y, width: labelWidth });
      record.object.visible = true;
    }
  }

  hit(raycaster) {
    if (this.disposed || !this.group.visible) return null;
    this.group.updateMatrixWorld(true);
    for (const hit of raycaster.intersectObjects(this.pickables, false)) {
      if (hit.object === this.tipPicks) {
        const id = this.tipIds[hit.instanceId];
        const file = this.files.get(id);
        if (file) return { kind: 'file', id, path: file.node.path, root: true, distance: hit.distance };
      } else if (hit.object === this.folderPicks) {
        return { kind: 'folder', path: this.folderIds[hit.instanceId], root: true, toggle: true, distance: hit.distance };
      } else if (hit.object.userData.kind) return { ...hit.object.userData, distance: hit.distance };
    }
    return null;
  }

  getNodePosition(id) { return this.files.get(id)?.position.clone() || null; }
  getBounds() { return this.bounds?.clone() || new THREE.Box3(new THREE.Vector3(0, -40, 0), new THREE.Vector3(0, -40, 0)); }

  getFolderBounds(path = '') {
    const folder = this.folders.get(path);
    if (!folder) return null;
    const bounds = new THREE.Box3().expandByPoint(folder.position);
    const include = (position, points) => {
      bounds.expandByPoint(position);
      bounds.expandByPoint(position.clone().add(new THREE.Vector3(18, 0, 0)));
      for (const point of points) bounds.expandByPoint(point);
    };
    for (const file of this.files.values()) if (file.visible && (!path || file.node.folder === path || file.node.folder.startsWith(`${path}/`))) include(file.position, file.points);
    for (const record of this.folders.values()) if (record.visible && (!path || record.path === path || record.path.startsWith(`${path}/`))) include(record.position, record.points);
    for (const row of this.layout.rows) if (row.kind === 'pager' && (!path || row.path === path || row.path.startsWith(`${path}/`))) include(asVector(row.position), (row.points || []).map(asVector));
    return bounds.expandByScalar(2);
  }

  getRootNodeScreenPoint(id) {
    const file = this.files.get(id);
    if (!file?.visible || !this.group.visible) return null;
    this.camera.updateMatrixWorld();
    const point = file.position.clone().project(this.camera);
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
    this.group.clear();
    this.files.clear(); this.folders.clear();
    this.labelRecords = []; this.pickables = [];
    this.tips = this.tipPicks = this.folderIcons = this.folderPicks = this.branchMesh = this.selectionTrace = this.detailLabel = null;
    this.tipIds = []; this.folderIds = [];
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._clear();
    this.group.removeFromParent();
    this.layout = this.model = this.bounds = null;
  }
}
