import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { softDotTexture } from '../scene/setup.js';
import { createRepositoryLayout, stableHash } from './layout.js';
import { FOLDER_COLORS, CHANGE_COLORS, fileKind } from './encoding.js';

const DURATION = 1.6;
const WHITE = new THREE.Color(0xf0f4ff);
const ROOT_POSITION = new THREE.Vector3();
const ease = value => value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;
const toSet = value => value instanceof Set ? value : new Set(value || []);

/** A native lab scene. The shared stage owns rendering, resize and its frame loop. */
export class RepositoryScene {
  constructor(stage, { onSelect = () => {}, onHover = () => {} } = {}) {
    this.stage = stage;
    this.scene = stage.scene;
    this.camera = stage.camera;
    this.controls = stage.controls;
    this.controls.setRootMode?.(false);
    this.renderer = stage.renderer;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.nodes = new Map();
    this.folders = new Map();
    this.activeIds = new Set();
    this.changedIds = new Set();
    this.statuses = {};
    this.paths = {};
    this.options = { links: true, labels: true, ghosts: true, grid: false, activity: true };
    this.time = 0;
    this.elapsed = DURATION;
    this.duration = DURATION;
    this.activityColor = new THREE.Color();
    this.renderedCount = 0;
    this.selectedId = null;
    this.hoveredId = null;
    this.disposed = false;
    this.particles = [];
    this.labelRecords = [];
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.temp = new THREE.Vector3();
    this.white = WHITE;
    this.group = new THREE.Group();
    this.group.name = 'Data Lab';
    this.scene.add(this.group);
    this.world = new THREE.Group();
    this.linkGroup = new THREE.Group();
    this.activityGroup = new THREE.Group();
    this.group.add(this.world, this.linkGroup, this.activityGroup);
    this.dot = softDotTexture();
    this.geometries = {
      code: new THREE.SphereGeometry(1, 24, 16),
      data: new THREE.OctahedronGeometry(1.15, 0),
      document: new THREE.BoxGeometry(1.5, 1.5, 1.5),
      folder: new THREE.IcosahedronGeometry(1.8, 1),
      pick: new THREE.SphereGeometry(1, 10, 8),
    };
    // createStage's solar key is inappropriate here; use a native lab-local rig.
    this.baseLights = this.scene.children.filter(child => child.isLight).map(light => ({ light, intensity: light.intensity }));
    for (const { light } of this.baseLights) light.intensity = 0;
    const key = new THREE.DirectionalLight(0xffead0, 3.6);
    key.position.set(-35, 65, 75);
    const rim = new THREE.DirectionalLight(0x8baeff, 2.4);
    rim.position.set(55, 20, -65);
    const fill = new THREE.HemisphereLight(0x9cbbdf, 0x131a29, 1.5);
    this.group.add(key, rim, fill);
    this.grid = new THREE.GridHelper(160, 20, 0x394354, 0x1b2432);
    this.grid.position.y = -48;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.28;
    this.grid.material.depthWrite = false;
    this.grid.visible = false;
    this.group.add(this.grid);
    this.focusHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: 0xa6cfff, transparent: true, opacity: 0.17, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.focusHalo.visible = false;
    this.group.add(this.focusHalo);
    this.selectionLabelElement = document.createElement('div');
    this.selectionLabelElement.className = 'body-label small data-object-label';
    this.selectionLabelElement.style.cssText = 'color:#edf1fa;font-size:11px;text-shadow:0 1px 5px #000;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    this.selectionLabel = new CSS2DObject(this.selectionLabelElement);
    this.selectionLabel.visible = false;
    this.group.add(this.selectionLabel);

    this.motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._motionChange = () => {
      this.reducedMotion = this.motionPreference.matches;
      if (this.reducedMotion) { this.elapsed = this.duration; this._clearActivity(); this.tween = null; }
    };
    this._motionChange();
    this.motionPreference.addEventListener('change', this._motionChange);
    this._onControlStart = () => { this.tween = null; };
    this.controls.addEventListener('start', this._onControlStart);
    this.controls.minDistance = 5;
    this.controls.maxDistance = 650;
    this.controls.zoomSpeed = 1;
    this.controls.enablePan = true;

    const canvas = this.renderer.domElement;
    canvas.setAttribute('aria-label', 'Three-dimensional repository structure. Drag to orbit, scroll to zoom, click a file to inspect, double-click to focus.');
    this._pointerDown = event => { this.pointerStart = { x: event.clientX, y: event.clientY, time: performance.now() }; };
    this._pointerUp = event => {
      const start = this.pointerStart;
      this.pointerStart = null;
      if (!start || performance.now() - start.time > 600 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      const hit = this._hit(event);
      if (hit?.kind === 'file') this.onSelect(hit.id);
      else if (hit?.kind === 'folder') this.focusFolder(hit.path);
    };
    this._doubleClick = event => { const hit = this._hit(event); if (hit?.kind === 'file') this.focusNode(hit.id); else if (hit?.kind === 'folder') this.focusFolder(hit.path); };
    this._pointerMove = event => {
      if (event.buttons) { this._clearHover(); return; }
      const hit = this._hit(event);
      this.hoveredId = hit?.kind === 'file' ? hit.id : null;
      canvas.style.cursor = hit ? 'pointer' : 'grab';
      if (this.hoveredId) {
        const record = this.nodes.get(this.hoveredId);
        this.onHover({ id: this.hoveredId, path: this.paths[this.hoveredId] || record.node.path, x: event.clientX, y: event.clientY });
      } else this.onHover(null);
    };
    this._pointerLeave = () => this._clearHover();
    for (const [name, handler] of [['pointerdown', this._pointerDown], ['pointerup', this._pointerUp], ['pointermove', this._pointerMove], ['pointerleave', this._pointerLeave], ['dblclick', this._doubleClick]]) canvas.addEventListener(name, handler);
  }

  setModel(model) {
    this._clearWorld();
    this.model = model;
    this.layout = createRepositoryLayout(model);
    this.extent = this.layout.extent;
    this.renderedCount = this.layout.nodes.length;
    const topPaths = this.layout.folders.filter(folder => folder.depth === 1).map(folder => folder.path).sort();
    const colorFor = path => new THREE.Color(FOLDER_COLORS[Math.max(0, topPaths.indexOf(path.split('/')[0])) % FOLDER_COLORS.length]);
    const rootMaterial = new THREE.MeshStandardMaterial({ color: 0xb5a482, roughness: 0.28, metalness: 0.6, emissive: 0x71542c, emissiveIntensity: 0.22 });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(3.4, 2), rootMaterial);
    this.world.add(core);
    const coreEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(3.48, 0)), new THREE.LineBasicMaterial({ color: 0xd3bc8f, transparent: true, opacity: 0.45 }));
    this.world.add(coreEdges);
    this._label(model.repository?.name || 'Repository', new THREE.Vector3(0, 5, 0), '#d9c6a0', '');

    for (const folder of this.layout.folders) {
      const position = new THREE.Vector3(...folder.position);
      const color = colorFor(folder.path);
      const record = { ...folder, position, color };
      this.folders.set(folder.path, record);
      if (!folder.path) continue;
      const mesh = new THREE.Mesh(this.geometries.folder, new THREE.MeshStandardMaterial({ color, roughness: 0.34, metalness: 0.52, emissive: color, emissiveIntensity: 0.13 }));
      mesh.position.copy(position);
      mesh.scale.setScalar(folder.depth === 1 ? 1 : 0.7);
      mesh.userData = { kind: 'folder', path: folder.path };
      this.world.add(mesh);
      record.mesh = mesh;
      this._label(folder.path, position.clone().add(new THREE.Vector3(0, 3.1, 0)), `#${color.getHexString()}`, folder.path);
    }
    for (const folder of this.folders.values()) {
      if (!folder.path) continue;
      const parent = this.folders.get(folder.parent);
      const midpoint = parent.position.clone().lerp(folder.position, 0.5).add(new THREE.Vector3(0, 2, 0));
      const curve = new THREE.QuadraticBezierCurve3(parent.position.clone(), midpoint, folder.position.clone());
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, folder.depth === 1 ? 0.14 : 0.09, 6, false), new THREE.MeshStandardMaterial({ color: folder.color.clone().multiplyScalar(0.45), roughness: 0.6, metalness: 0.25, emissive: folder.color, emissiveIntensity: 0.04 }));
      this.linkGroup.add(tube);
    }
    for (const node of this.layout.nodes) {
      const folder = this.folders.get(node.folder);
      const color = folder.color;
      const type = fileKind(node.path);
      const material = new THREE.MeshStandardMaterial({ color: color.clone(), roughness: 0.3, metalness: 0.32, emissive: color.clone(), emissiveIntensity: 0.055, transparent: true, opacity: 1 });
      const mesh = new THREE.Mesh(this.geometries[type], material);
      const position = new THREE.Vector3(...node.position);
      const size = Math.min(1.4, 0.9 + Math.log10(Math.max(1, Number(node.size) || 0)) * 0.08);
      mesh.position.copy(position);
      mesh.scale.setScalar(size);
      if (type !== 'code') mesh.rotation.set(0.15, (stableHash(node.id) % 60) / 60, 0.13);
      mesh.userData = { kind: 'file', id: node.id };
      this.world.add(mesh);
      const pick = new THREE.Mesh(this.geometries.pick, new THREE.MeshBasicMaterial({ visible: false }));
      pick.position.copy(position);
      pick.scale.setScalar(Math.max(size * 1.4, 1.5));
      pick.userData = { kind: 'file', id: node.id };
      this.world.add(pick);
      const midpoint = folder.position.clone().lerp(position, 0.5).add(new THREE.Vector3(0, 0.6, 0));
      const curve = new THREE.QuadraticBezierCurve3(folder.position.clone(), midpoint, position.clone());
      const link = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(16)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }));
      this.linkGroup.add(link);
      this.nodes.set(node.id, { node, mesh, pick, link, position, color: color.clone(), size, opacity: 1, folder });
    }
    this.pickables = [...this.nodes.values()].map(record => record.pick).concat([...this.folders.values()].filter(folder => folder.mesh).map(folder => folder.mesh));
    this.activeIds = new Set(this.layout.nodes.map(node => node.id));
    this.changedIds.clear();
    this.statuses = {};
    this.paths = {};
    this.frameKey = undefined;
    this.elapsed = DURATION;
    this.selectedId = null;
    this.setOptions(this.options);
    this.overviewDirection = this._overviewDirection();
    this.resetView(true);
  }

  _label(text, position, color, path) {
    const element = document.createElement('div');
    element.className = 'body-label small data-folder-label';
    element.textContent = text;
    element.style.cssText = `color:${color};font-size:${path ? 10 : 11}px;letter-spacing:.35px;opacity:.85;white-space:nowrap;text-shadow:0 1px 7px #000,0 1px 3px #000;`;
    const object = new CSS2DObject(element);
    object.position.copy(position);
    this.world.add(object);
    this.labelRecords.push({ object, element, position, path, text });
  }

  setFrame({ visibleIds, changedIds, selectedId, statuses = {}, frameKey, paths = {}, duration = DURATION } = {}) {
    if (visibleIds !== undefined) this.activeIds = toSet(visibleIds);
    const nextChanged = toSet(changedIds);
    const different = this.frameKey !== frameKey || nextChanged.size !== this.changedIds.size || [...nextChanged].some(id => !this.changedIds.has(id));
    this.changedIds = nextChanged;
    this.statuses = { ...statuses };
    this.paths = paths instanceof Map ? Object.fromEntries(paths) : { ...paths };
    this.frameKey = frameKey;
    this.duration = Math.max(0.08, Number(duration) || DURATION);
    if (selectedId !== undefined) this.select(selectedId);
    if (different) {
      this.elapsed = this.reducedMotion ? this.duration : 0;
      this._createActivity();
    }
  }

  _createActivity() {
    this._clearActivity();
    if (this.reducedMotion || !this.options.activity) return;
    const changes = [...this.changedIds].filter(id => this.nodes.has(id)).slice(0, 72);
    for (const [index, id] of changes.entries()) {
      const record = this.nodes.get(id);
      const points = [ROOT_POSITION.clone(), ...record.node.chain.map(path => this.folders.get(path).position.clone()), record.position.clone()];
      if (points.length === 2) points.splice(1, 0, points[0].clone().lerp(points[1], 0.5).add(new THREE.Vector3(0, 3, 0)));
      const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.2);
      const color = new THREE.Color(CHANGE_COLORS[this.statuses[id]] || CHANGE_COLORS.modified);
      const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(72));
      geometry.setDrawRange(0, 0);
      const trail = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(1.7), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: color.clone().multiplyScalar(2.3), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      dot.scale.setScalar(2.9);
      this.activityGroup.add(trail, dot);
      this.particles.push({ curve, trail, dot, delay: changes.length > 1 ? index / changes.length * this.duration * 0.1375 : 0 });
    }
  }

  _clearActivity() {
    for (const particle of this.particles) { particle.trail.geometry.dispose(); particle.trail.material.dispose(); particle.dot.material.dispose(); }
    this.activityGroup?.clear();
    this.particles = [];
  }

  select(id) { this.selectedId = this.nodes.has(id) ? id : null; }

  focusNode(id) {
    const record = this.nodes.get(id);
    if (!record) return;
    this.select(id);
    this._flyTo(record.position, Math.max(14, record.size * 17));
  }

  focusFolder(path) {
    let folder = this.folders.get(path);
    while (!folder && path.includes('/')) { path = path.slice(0, path.lastIndexOf('/')); folder = this.folders.get(path); }
    if (!folder) {
      // Folder compression can omit a hub while retaining files below it.
      const visible = [...this.nodes.values()].filter(record => record.node.path.startsWith(`${path}/`));
      if (!visible.length) return;
      const bounds = new THREE.Box3().setFromPoints(visible.map(record => record.position));
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      this._flyTo(sphere.center, Math.max(18, sphere.radius * 3.4));
      return;
    }
    const members = [...this.nodes.values()].filter(record => record.node.folder === folder.path || record.node.folder.startsWith(`${folder.path}/`));
    const radius = Math.max(10, ...members.map(record => record.position.distanceTo(folder.position) + 2));
    this._flyTo(folder.position, radius * 3.4);
  }

  _cameraRight(ray) {
    // Panel offsets and focus bounds follow the screen even when it is rolled.
    const right = new THREE.Vector3().crossVectors(this.camera.up, ray);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0).applyQuaternion(this.camera.quaternion).projectOnPlane(ray);
    if (right.lengthSq() < 1e-8) right.crossVectors(new THREE.Vector3(0, Math.abs(ray.y) < 0.9 ? 1 : 0, Math.abs(ray.y) < 0.9 ? 0 : 1), ray);
    return right.normalize();
  }

  _flyTo(target, distance, immediate = false, direction = null) {
    this.controls.stop?.();
    const ray = (direction?.clone() || this.camera.position.clone().sub(this.controls.target)).normalize();
    if (ray.lengthSq() < 0.1) ray.set(0.5, 0.4, 1).normalize();
    const width = this.renderer.domElement.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.clientHeight || window.innerHeight;
    const panelWidth = width > 900 ? 390 : width > 700 ? 330 : 0;
    const right = this._cameraRight(ray);
    const shift = distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * panelWidth / height;
    const endTarget = target.clone().addScaledVector(right, shift);
    const endPosition = endTarget.clone().addScaledVector(ray, distance);
    if (immediate || this.reducedMotion) { this.camera.position.copy(endPosition); this.controls.target.copy(endTarget); this.camera.lookAt(endTarget); this.tween = null; return; }
    this.tween = { elapsed: 0, from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to: endPosition, toTarget: endTarget };
  }

  _overviewDirection() {
    const top = [...this.folders.values()].filter(folder => folder.depth === 1);
    const points = (top.length > 2 ? top : [...this.folders.values()].filter(folder => folder.depth > 0 && folder.depth <= 2))
      .slice(0, 20).map(folder => folder.position).concat([ROOT_POSITION]);
    if (points.length < 2) return new THREE.Vector3(0.58, 0.38, 1).normalize();
    let best = -Infinity;
    let direction = new THREE.Vector3(0.58, 0.38, 1).normalize();
    // Select an overview with readable containment branches. This is computed
    // once per dataset, never as commits change or after a user camera gesture.
    for (let step = 0; step < 24; step++) for (const elevation of [0.2, 0.4, 0.6]) {
      const ray = new THREE.Vector3(Math.sin(step * Math.PI / 12), elevation, Math.cos(step * Math.PI / 12)).normalize();
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), ray).normalize();
      const up = new THREE.Vector3().crossVectors(ray, right);
      const projected = points.map(point => [point.dot(right), point.dot(up)]);
      let separation = Infinity;
      for (let a = 0; a < projected.length; a++) for (let b = a + 1; b < projected.length; b++) {
        separation = Math.min(separation, Math.hypot(projected[a][0] - projected[b][0], projected[a][1] - projected[b][1]));
      }
      if (separation > best) { best = separation; direction = ray; }
    }
    return direction;
  }

  resetView(immediate = false) {
    this.controls.stop?.();
    this.camera.up.set(0, 1, 0);
    const width = this.renderer.domElement.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.clientHeight || window.innerHeight;
    const availableWidth = Math.max(300, width - (width > 900 ? 410 : width > 700 ? 350 : 24));
    const availableHeight = Math.max(300, height - (width > 700 ? 200 : 380));
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const halfAngle = Math.atan(tangent * Math.min(availableHeight / height, availableWidth / height));
    const distance = (this.extent || 40) / Math.sin(halfAngle) * 0.94;
    this._flyTo(ROOT_POSITION, distance, immediate, (this.overviewDirection || new THREE.Vector3(0.58, 0.38, 1).normalize()).clone());
  }

  setOptions(options = {}) {
    Object.assign(this.options, options);
    this.linkGroup.visible = this.options.links;
    this.grid.visible = this.options.grid;
    if (!this.options.activity) this._clearActivity();
  }

  getPositions() { return Object.fromEntries([...this.nodes].map(([id, record]) => [id, record.position.toArray()])); }

  getNodeScreenPoint(id) {
    const record = this.nodes.get(id);
    if (!record) return null;
    this.camera.updateMatrixWorld();
    const point = record.position.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (point.x * 0.5 + 0.5) * rect.width, y: rect.top + (-point.y * 0.5 + 0.5) * rect.height, visible: point.z > -1 && point.z < 1 && Math.abs(point.x) < 1 && Math.abs(point.y) < 1 };
  }

  capture() { this.stage.composer.render(); return this.renderer.domElement.toDataURL('image/png'); }

  _hit(event) {
    if (!this.pickables?.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersections = this.raycaster.intersectObjects(this.pickables, false);
    for (const hit of intersections) {
      const data = hit.object.userData;
      if (data.kind === 'folder' || this.activeIds.has(data.id) || this.options.ghosts) return data;
    }
    return null;
  }

  _clearHover() { this.hoveredId = null; this.onHover(null); this.renderer.domElement.style.cursor = 'grab'; }

  update(dt) {
    if (this.disposed) return;
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
    for (const [id, record] of this.nodes) {
      const active = this.activeIds.has(id);
      const changed = this.changedIds.has(id);
      const selected = id === this.selectedId;
      const hovered = id === this.hoveredId;
      const status = this.statuses[id];
      const material = record.mesh.material;
      let opacity = active ? 1 : this.options.ghosts ? 0.12 : 0;
      let size = record.size;
      if (changed && transition < 1 && this.options.activity) {
        if (status === 'added' || status === 'copied') { const birth = ease(Math.min(1, transition * 1.5)); size *= 0.25 + birth * 0.75; opacity *= birth; }
        else if (status === 'removed') opacity = (1 - transition) * 0.8 + opacity;
      }
      record.mesh.visible = opacity > 0;
      material.opacity = Math.min(1, opacity);
      material.depthWrite = active;
      material.wireframe = !active;
      material.color.copy(record.color);
      const marked = changed && this.options.activity;
      if (marked) material.color.lerp(this.activityColor.setHex(CHANGE_COLORS[status] || CHANGE_COLORS.modified), 0.6);
      if (selected || hovered) material.color.lerp(WHITE, selected ? 0.38 : 0.22);
      material.emissive.copy(material.color);
      material.emissiveIntensity = selected ? 0.32 : hovered ? 0.22 : marked ? 0.12 + Math.sin(Math.PI * transition) * 0.28 : 0.055;
      record.mesh.scale.setScalar(size * (selected ? 1.22 : hovered ? 1.12 : 1));
      record.link.visible = active || this.options.ghosts;
      record.link.material.opacity = selected ? 0.7 : hovered ? 0.5 : active ? 0.22 : 0.065;
    }
    if (this.particles.length) {
      if (this.elapsed >= this.duration) this._clearActivity();
      else for (const particle of this.particles) {
        const progress = Math.max(0, Math.min(1, (this.elapsed - particle.delay) / (this.duration * 0.84375)));
        particle.dot.visible = progress > 0 && progress < 1;
        particle.curve.getPointAt(progress, this.temp);
        particle.dot.position.copy(this.temp);
        const head = Math.floor(progress * 72);
        const tail = Math.max(0, head - 11);
        particle.trail.geometry.setDrawRange(tail, Math.max(0, head - tail));
        particle.dot.material.opacity = Math.sin(progress * Math.PI) * 0.95;
        particle.trail.material.opacity = Math.sin(progress * Math.PI) * 0.9;
      }
    }
    const highlighted = this.nodes.get(this.hoveredId || this.selectedId);
    this.focusHalo.visible = Boolean(highlighted);
    this.selectionLabel.visible = Boolean(highlighted && this.options.labels);
    if (highlighted) {
      this.focusHalo.position.copy(highlighted.position);
      this.focusHalo.scale.setScalar(highlighted.size * 7);
      this.selectionLabel.position.copy(highlighted.position).add(new THREE.Vector3(0, highlighted.size * 2.2, 0));
      this.selectionLabelElement.textContent = this.paths[highlighted.node.id] || highlighted.node.path;
    }
    this._updateLabels();
  }

  _updateLabels() {
    const occupied = [];
    const width = this.renderer.domElement.clientWidth;
    const height = this.renderer.domElement.clientHeight;
    for (const record of this.labelRecords) {
      record.object.visible = false;
      if (!this.options.labels) continue;
      record.object.getWorldPosition(this.temp);
      const distance = this.camera.position.distanceTo(this.temp);
      if (record.path && distance < 12) continue;
      this.temp.project(this.camera);
      if (this.temp.z < -1 || this.temp.z > 1 || Math.abs(this.temp.x) > 1 || Math.abs(this.temp.y) > 1) continue;
      const x = (this.temp.x * 0.5 + 0.5) * width, y = (-this.temp.y * 0.5 + 0.5) * height;
      const half = Math.min(120, record.text.length * 3.2 + 5);
      if (occupied.some(box => Math.abs(x - box.x) < half + box.half && Math.abs(y - box.y) < 22)) continue;
      occupied.push({ x, y, half });
      record.object.visible = true;
    }
  }

  _clearWorld() {
    this._clearActivity();
    const shared = new Set(Object.values(this.geometries));
    const disposed = new Set();
    for (const group of [this.world, this.linkGroup]) {
      group.traverse(object => {
        if (object.element) object.element.remove();
        if (object.geometry && !shared.has(object.geometry) && !disposed.has(object.geometry)) { object.geometry.dispose(); disposed.add(object.geometry); }
        for (const material of object.material ? Array.isArray(object.material) ? object.material : [object.material] : []) if (!disposed.has(material)) { material.dispose(); disposed.add(material); }
      });
      group.clear();
    }
    this.nodes.clear();
    this.folders.clear();
    this.labelRecords = [];
    this.pickables = [];
    this.focusHalo.visible = false;
    this.selectionLabel.visible = false;
    this._clearHover();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._clearWorld();
    const canvas = this.renderer.domElement;
    for (const [name, handler] of [['pointerdown', this._pointerDown], ['pointerup', this._pointerUp], ['pointermove', this._pointerMove], ['pointerleave', this._pointerLeave], ['dblclick', this._doubleClick]]) canvas.removeEventListener(name, handler);
    this.controls.removeEventListener('start', this._onControlStart);
    this.motionPreference.removeEventListener('change', this._motionChange);
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.focusHalo.material.dispose();
    this.selectionLabelElement.remove();
    this.dot.dispose();
    this.scene.remove(this.group);
    for (const { light, intensity } of this.baseLights) light.intensity = intensity;
  }
}
