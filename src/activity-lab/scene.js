import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { softDotTexture } from '../scene/setup.js';
import { radialSpriteTexture } from '../textures/procedural.js';
import { createActivityLayout, activityRadius, activityHash, ACTIVITY_KIND_COLORS, ACTIVITY_KIND_LABELS, REPOSITORY_NODE_ID } from './scene-layout.js';

export { ACTIVITY_KIND_COLORS, ACTIVITY_KIND_LABELS } from './scene-layout.js';
const UP = new THREE.Vector3(0, 1, 0);
const GOLD = new THREE.Color('#ffcd87');
const WHITE = new THREE.Color('#edf3ff');
const easing = value => value * value * (3 - 2 * value);
const vec = value => new THREE.Vector3(...value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const textLabel = (text, color = '#b7c5d9', size = 10) => {
  const element = document.createElement('div');
  element.className = 'activity-space-label';
  element.setAttribute('aria-hidden', 'true');
  element.textContent = text;
  element.style.cssText = `pointer-events:none;color:${color};font:500 ${size}px/1.4 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.03em;white-space:nowrap;text-shadow:0 1px 5px #000,0 0 14px #000;`;
  return new CSS2DObject(element);
};
const safeAvatar = value => {
  if (typeof value !== 'string') return null;
  if (/^\/data-lab\/authors\/[a-z\d_-]+\.(?:png|jpe?g|webp)$/i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'avatars.githubusercontent.com' && !url.username && !url.password && !url.port && !url.hash ? url.href : null;
  } catch { return null; }
};

/** Native Observatory scene. The caller owns stage rendering and controls.update(). */
export class ActivityScene {
  constructor(stage, { onSelect = () => {}, onHover = () => {} } = {}) {
    this.stage = stage;
    this.scene = stage.scene;
    this.camera = stage.camera;
    this.renderer = stage.renderer;
    this.controls = stage.controls;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.nodes = new Map();
    this.visibleIds = new Set();
    this.selectedId = null;
    this.hoveredId = null;
    this.view = 'constellation';
    this.items = [];
    this.repository = {};
    this.links = [];
    this.clusterLabels = [];
    this.decorations = [];
    this.dataMaterials = new Set();
    this.dataGeometries = new Set();
    this.ownedTextures = new Set();
    this.disposed = false;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.projected = new THREE.Vector3();
    this.lifetime = new AbortController();
    this.pointerIds = new Set();
    this.canvas = this.renderer.domElement;
    this.previousAria = this.canvas.getAttribute('aria-label');
    this.previousBackground = this.scene.background;
    this.previousCursor = this.canvas.style.cursor;
    this.scene.background = new THREE.Color('#01040a');
    this.canvas.style.cursor = 'grab';
    this.canvas.setAttribute('aria-label', 'Three-dimensional repository collaboration. Real pull requests, issues, reviews, comments, forks and contributors orbit the repository. Drag to orbit, scroll or pinch to zoom, click a body to inspect, double-click to focus.');

    this.group = new THREE.Group();
    this.group.name = 'Activity Lab · Repository collaboration';
    this.world = new THREE.Group();
    this.world.name = 'Real GitHub activity';
    this.linkGroup = new THREE.Group();
    this.linkGroup.name = 'Supplied parent and actor relationships';
    this.guideGroup = new THREE.Group();
    this.guideGroup.name = 'Layout reference rings';
    this.labelGroup = new THREE.Group();
    this.group.add(this.world, this.linkGroup, this.guideGroup, this.labelGroup);
    this.scene.add(this.group);
    this.dot = softDotTexture();
    this.ownedTextures.add(this.dot);
    this.geometries = {
      sphere: new THREE.SphereGeometry(1, 32, 24),
      small: new THREE.SphereGeometry(1, 18, 12),
      issue: new THREE.IcosahedronGeometry(1, 2),
      review: new THREE.OctahedronGeometry(1, 1),
      pick: new THREE.SphereGeometry(1, 12, 8),
      orbit: new THREE.TorusGeometry(1, .025, 5, 80),
      halo: new THREE.TorusGeometry(1, .022, 6, 96),
    };
    this.pickMaterial = new THREE.MeshBasicMaterial({ visible: false });

    this.baseLights = this.scene.children.filter(child => child.isLight).map(light => ({ light, intensity: light.intensity }));
    for (const { light } of this.baseLights) light.intensity = 0;
    const key = new THREE.DirectionalLight('#ffe9d1', 3.7);
    key.position.set(-35, 58, 80);
    const rim = new THREE.DirectionalLight('#92b4e8', 2.3);
    rim.position.set(60, 25, -60);
    const fill = new THREE.HemisphereLight('#a6c0e4', '#101a2a', 1.7);
    this.group.add(key, rim, fill);
    this._createSun();
    this._createStars();

    this.focusHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: '#d2dfff', transparent: true, opacity: .24, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.focusHalo.visible = false;
    this.focusHalo.raycast = () => {};
    this.selectionRing = new THREE.Mesh(this.geometries.halo, new THREE.MeshBasicMaterial({ color: '#ffe1ab', transparent: true, opacity: .8, depthWrite: false, toneMapped: false }));
    this.selectionRing.visible = false;
    this.selectionRing.raycast = () => {};
    this.selectionLabel = textLabel('', '#e6edf7', 11);
    this.selectionLabel.element.style.maxWidth = '280px';
    this.selectionLabel.element.style.overflow = 'hidden';
    this.selectionLabel.element.style.textOverflow = 'ellipsis';
    this.selectionLabel.visible = false;
    this.group.add(this.focusHalo, this.selectionRing, this.selectionLabel);

    this.controls.setRootMode?.(false);
    this.controls.enablePan = true;
    this.controls.enableDamping = true;
    this.controls.zoomSpeed = 1;
    this.controls.minDistance = 9;
    this.controls.maxDistance = 1500;
    this.camera.up.set(0, 1, 0);
    this.motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.motionPreference.matches;
    this.motionChange = () => {
      this.reducedMotion = this.motionPreference.matches;
      if (this.reducedMotion) { this._finishLayoutTransition(); this._finishCameraTransition(); }
    };
    this.motionPreference.addEventListener('change', this.motionChange);
    this.controlStart = () => { this.cameraTween = null; this._clearHover(); };
    this.controls.addEventListener('start', this.controlStart);
    this._bindPointer();
  }

  _createSun() {
    this.sunGroup = new THREE.Group();
    this.sunGroup.name = 'Repository sun';
    this.sun = new THREE.Mesh(this.geometries.sphere, new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd19a').multiplyScalar(1.45), toneMapped: false }));
    this.sun.scale.setScalar(4.5);
    this.sun.userData = { kind: 'repository' };
    this.sunGroup.add(this.sun);
    const layers = [
      { scale: 23, opacity: .8, stops: [[0, 'rgba(255,228,174,.92)'], [.22, 'rgba(255,183,91,.42)'], [.55, 'rgba(255,143,61,.09)'], [1, 'rgba(255,125,45,0)']] },
      { scale: 53, opacity: .55, stops: [[0, 'rgba(255,207,135,.22)'], [.25, 'rgba(255,171,81,.09)'], [1, 'rgba(255,140,61,0)']] },
    ];
    for (const layer of layers) {
      const map = radialSpriteTexture(layer.stops);
      this.ownedTextures.add(map);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, opacity: layer.opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      sprite.scale.setScalar(layer.scale);
      sprite.raycast = () => {};
      this.sunGroup.add(sprite);
    }
    this.sunLight = new THREE.PointLight('#ffd6a2', 24, 600, 1);
    this.sunGroup.add(this.sunLight);
    this.repositoryLabel = textLabel('Repository', '#e7c595', 11);
    this.repositoryLabel.position.set(0, -7.7, 0);
    this.sunGroup.add(this.repositoryLabel);
    this.group.add(this.sunGroup);
  }

  _createStars() {
    const positions = [], colors = [];
    let random = 71039;
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 4294967296; };
    for (let index = 0; index < 420; index++) {
      const azimuth = next() * Math.PI * 2, y = next() * 2 - 1;
      const radius = 850 + next() * 300, circle = Math.sqrt(1 - y * y);
      positions.push(Math.cos(azimuth) * circle * radius, y * radius, Math.sin(azimuth) * circle * radius);
      const light = .33 + next() * .44;
      colors.push(light * .82, light * .9, light);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.stars = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 1.8, vertexColors: true, map: this.dot, transparent: true, opacity: .63, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.stars.name = 'Decorative Observatory starfield';
    this.stars.raycast = () => {};
    this.group.add(this.stars);
  }

  _bindPointer() {
    const on = (type, handler) => this.canvas.addEventListener(type, handler, { signal: this.lifetime.signal });
    on('pointerdown', event => {
      this.pointerIds.add(event.pointerId);
      this.pointerStart = this.pointerIds.size === 1 ? { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() } : null;
    });
    on('pointerup', event => {
      const start = this.pointerStart;
      this.pointerIds.delete(event.pointerId);
      this.pointerStart = null;
      if (!start || start.id !== event.pointerId || event.button > 0 || performance.now() - start.time > 650 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      const hit = this._hit(event);
      if (hit?.id) this.onSelect(hit.id);
      else if (hit?.kind === 'repository') this.frame();
    });
    on('pointercancel', event => { this.pointerIds.delete(event.pointerId); this.pointerStart = null; });
    on('pointermove', event => {
      if (event.buttons || this.pointerIds.size > 1) { this._clearHover(); return; }
      const hit = this._hit(event);
      const id = hit?.id || null;
      if (id !== this.hoveredId) { this.hoveredId = id; this._paint(); }
      this.canvas.style.cursor = hit ? 'pointer' : 'grab';
      this.onHover(id ? { id, x: event.clientX, y: event.clientY } : null);
    });
    on('pointerleave', () => this._clearHover());
    on('dblclick', event => { const hit = this._hit(event); if (hit?.id) this.focus(hit.id); else if (hit?.kind === 'repository') this.frame(); });
  }

  setData(items, repository = {}) {
    if (this.disposed) return;
    this._clearData();
    this.items = Array.isArray(items) ? items : [];
    this.repository = repository || {};
    this.layout = createActivityLayout(this.items, this.view);
    this.controls.maxDistance = Math.max(1500, this.layout.extent * 12);
    this.repositoryLabel.element.textContent = this.repository.fullName || this.repository.name || 'Repository';
    for (const item of this.layout.items) {
      const color = new THREE.Color(ACTIVITY_KIND_COLORS[item.kind]);
      const material = new THREE.MeshStandardMaterial({ color, roughness: .26, metalness: .32, emissive: color.clone(), emissiveIntensity: .12 });
      this.dataMaterials.add(material);
      const geometry = item.kind === 'issue' ? this.geometries.issue : item.kind === 'review' ? this.geometries.review : item.kind === 'comment' ? this.geometries.small : this.geometries.sphere;
      const radius = activityRadius(item);
      const position = vec(this.layout.positions.get(item.id));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position);
      mesh.scale.setScalar(radius);
      mesh.userData = { id: item.id, kind: item.kind };
      mesh.name = item.title || item.actor?.login || item.id;
      if (item.kind === 'issue' || item.kind === 'review') mesh.rotation.set(.1, (activityHash(item.id) % 100) / 100, .2);
      const pick = new THREE.Mesh(this.geometries.pick, this.pickMaterial);
      pick.position.copy(position);
      pick.scale.setScalar(radius * 1.3);
      pick.userData = { id: item.id, kind: item.kind };
      this.world.add(mesh, pick);
      const record = { item, mesh, pick, position, radius, color };
      if (item.kind === 'fork' || item.kind === 'pull_request') {
        const ringMaterial = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(.8), transparent: true, opacity: item.kind === 'fork' ? .42 : .27, depthWrite: false });
        this.dataMaterials.add(ringMaterial);
        record.ring = new THREE.Mesh(this.geometries.orbit, ringMaterial);
        record.ring.scale.setScalar(radius * (item.kind === 'fork' ? 1.65 : 1.35));
        record.ring.rotation.set(1.05, .2, .3);
        record.ring.position.copy(position);
        record.ring.raycast = () => {};
        this.world.add(record.ring);
      }
      this.nodes.set(item.id, record);
    }
    this.visibleIds = new Set(this.nodes.keys());
    this.renderedCount = this.nodes.size;
    this.selectedId = this.hoveredId = null;
    this._buildGuidesAndLinks();
    this._paint();
    this.frame(true);
  }

  setView(view) {
    if (!['constellation', 'orbits', 'contributors'].includes(view) || this.view === view || this.disposed) return;
    this.view = view;
    this.layout = createActivityLayout(this.items, view);
    this.controls.maxDistance = Math.max(1500, this.layout.extent * 12);
    const from = new Map([...this.nodes].map(([id, record]) => [id, record.position.clone()]));
    this.layoutTransition = { elapsed: 0, duration: .8, from };
    if (this.reducedMotion) this._finishLayoutTransition();
    this._buildGuidesAndLinks();
    this.frame();
    this._paint();
  }

  _buildGuidesAndLinks() {
    this._clearGuidesAndLinks();
    for (const cluster of this.layout.clusters) {
      const label = textLabel(`${cluster.label} · ${cluster.ids.length}`, cluster.color, cluster.actor ? 10 : 11);
      label.position.fromArray(cluster.position).add(new THREE.Vector3(0, cluster.labelOnly ? 4 : cluster.radius + 4.5, 0));
      this.labelGroup.add(label);
      this.clusterLabels.push({ cluster, label });
      if (cluster.radius > 0) {
        const points = Array.from({ length: 129 }, (_, index) => {
          const angle = index / 128 * Math.PI * 2;
          return vec(cluster.position).add(new THREE.Vector3(Math.cos(angle) * cluster.radius, Math.sin(angle) * cluster.radius * .82, Math.sin(angle) * cluster.radius * .16));
        });
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineDashedMaterial({ color: cluster.color, transparent: true, opacity: .17, dashSize: .5, gapSize: .85, depthWrite: false });
        this.dataGeometries.add(geometry); this.dataMaterials.add(material);
        const line = new THREE.Line(geometry, material);
        line.computeLineDistances(); line.raycast = () => {};
        this.guideGroup.add(line); this.decorations.push({ line, ids: cluster.ids });
      }
    }
    for (const ring of this.layout.rings) {
      const points = Array.from({ length: 181 }, (_, index) => {
        const angle = index / 180 * Math.PI * 2;
        const x = Math.cos(angle) * ring.radius, z = Math.sin(angle) * ring.radius;
        return new THREE.Vector3(x * Math.cos(ring.rotation) - z * Math.cos(ring.tilt) * Math.sin(ring.rotation), z * Math.sin(ring.tilt), x * Math.sin(ring.rotation) + z * Math.cos(ring.tilt) * Math.cos(ring.rotation));
      });
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color: ACTIVITY_KIND_COLORS[ring.kind], transparent: true, opacity: .16, depthWrite: false });
      this.dataGeometries.add(geometry); this.dataMaterials.add(material);
      const line = new THREE.Line(geometry, material);
      line.raycast = () => {};
      this.guideGroup.add(line);
      this.decorations.push({ line, ids: this.layout.items.filter(item => item.kind === ring.kind).map(item => item.id) });
    }
    for (const link of this.layout.links) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(25 * 3), 3));
      const color = link.kind === 'repository' ? '#9c8261' : link.kind === 'actor' ? '#9faebf' : ACTIVITY_KIND_COLORS[this.nodes.get(link.to).item.kind];
      const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: .16, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.dataGeometries.add(geometry); this.dataMaterials.add(material);
      const line = new THREE.Line(geometry, material);
      line.raycast = () => {};
      this.linkGroup.add(line);
      this.links.push({ ...link, line });
    }
    this._updateLinks();
  }

  _updateLinks() {
    for (const link of this.links) {
      const a = link.from === REPOSITORY_NODE_ID ? new THREE.Vector3() : this.nodes.get(link.from).position;
      const b = this.nodes.get(link.to).position;
      const bend = Math.min(8, a.distanceTo(b) * .09);
      const midpoint = a.clone().lerp(b, .5).add(new THREE.Vector3(0, bend, bend * .4));
      const positions = link.line.geometry.attributes.position;
      for (let index = 0; index < positions.count; index++) {
        const t = index / (positions.count - 1), inverse = 1 - t;
        positions.setXYZ(index,
          inverse * inverse * a.x + 2 * inverse * t * midpoint.x + t * t * b.x,
          inverse * inverse * a.y + 2 * inverse * t * midpoint.y + t * t * b.y,
          inverse * inverse * a.z + 2 * inverse * t * midpoint.z + t * t * b.z);
      }
      positions.needsUpdate = true;
      link.line.geometry.computeBoundingSphere();
    }
  }

  setVisible(ids) {
    if (this.disposed) return;
    this.visibleIds = new Set(ids || []);
    if (this.hoveredId && !this.visibleIds.has(this.hoveredId)) this._clearHover();
    this._paint();
  }

  setSelected(id) {
    this.selectedId = this.nodes.has(id) ? id : null;
    this._paint();
  }

  _paint() {
    if (this.disposed) return;
    for (const [id, record] of this.nodes) {
      const visible = this.visibleIds.has(id);
      const selected = id === this.selectedId, hovered = id === this.hoveredId;
      record.mesh.visible = record.pick.visible = visible;
      if (record.ring) record.ring.visible = visible;
      record.mesh.material.color.copy(record.color).lerp(WHITE, selected ? .22 : hovered ? .12 : 0);
      record.mesh.material.emissive.copy(record.color);
      record.mesh.material.emissiveIntensity = selected ? .45 : hovered ? .3 : .12;
      record.mesh.scale.setScalar(record.radius * (selected ? 1.08 : 1));
    }
    for (const link of this.links) {
      const visible = this.visibleIds.has(link.to) && (link.from === REPOSITORY_NODE_ID || this.visibleIds.has(link.from));
      const selected = link.from === this.selectedId || link.to === this.selectedId || link.from === this.hoveredId || link.to === this.hoveredId;
      link.line.visible = visible && (link.kind !== 'actor' || this.view === 'contributors' || selected);
      link.line.material.opacity = selected ? .7 : link.kind === 'repository' ? .1 : this.view === 'contributors' ? .2 : .22;
    }
    for (const decoration of this.decorations) decoration.line.visible = decoration.ids.some(id => this.visibleIds.has(id));
    for (const { cluster, label } of this.clusterLabels) {
      const count = cluster.ids.filter(id => this.visibleIds.has(id)).length;
      label.element.textContent = `${cluster.label} · ${count}`;
      label.userData.active = count > 0;
      label.userData.count = count;
    }
    const highlighted = this.nodes.get(this.hoveredId || this.selectedId);
    this.focusHalo.visible = Boolean(highlighted && this.visibleIds.has(highlighted.item.id));
    this.selectionRing.visible = Boolean(this.selectedId && this.visibleIds.has(this.selectedId));
    this.selectionLabel.visible = this.focusHalo.visible;
    if (highlighted && this.focusHalo.visible) {
      this.focusHalo.position.copy(highlighted.position);
      this.focusHalo.scale.setScalar(highlighted.radius * 6.4);
      this.focusHalo.material.color.copy(highlighted.color);
      this.selectionLabel.position.copy(highlighted.position).add(new THREE.Vector3(0, highlighted.radius * 2.05, 0));
      this._setSelectionLabel(highlighted.item);
    }
    if (this.selectionRing.visible) {
      const selected = this.nodes.get(this.selectedId);
      this.selectionRing.position.copy(selected.position);
      this.selectionRing.scale.setScalar(selected.radius * 1.48);
    }
  }

  _setSelectionLabel(item) {
    if (this.labelItem === item.id) return;
    this.labelItem = item.id;
    const element = this.selectionLabel.element;
    element.replaceChildren();
    const title = document.createElement('span');
    title.textContent = item.kind === 'contributor' ? item.actor?.login || item.title || 'Contributor' : `${item.number ? `#${item.number} · ` : ''}${item.title || ACTIVITY_KIND_LABELS[item.kind]}`;
    title.style.cssText = 'display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    const caption = document.createElement('span');
    caption.textContent = `${ACTIVITY_KIND_LABELS[item.kind]}${item.actor?.login && item.kind !== 'contributor' ? ` · @${item.actor.login}` : ''}`;
    caption.style.cssText = `display:block;color:${ACTIVITY_KIND_COLORS[item.kind]};font-size:9px;opacity:.8;margin-top:3px;`;
    const avatar = safeAvatar(item.actor?.avatarUrl);
    if (avatar && item.kind === 'contributor') {
      const image = document.createElement('img');
      image.src = avatar; image.alt = ''; image.referrerPolicy = 'no-referrer';
      image.style.cssText = 'width:25px;height:25px;border-radius:50%;float:left;margin-right:7px;border:1px solid rgba(220,230,245,.25);';
      image.onerror = () => { image.onerror = null; image.remove(); };
      element.append(image);
    }
    element.append(title, caption);
  }

  _viewport() {
    const width = this.canvas.clientWidth || innerWidth, height = this.canvas.clientHeight || innerHeight;
    let left = 22, right = width - 22, top = width <= 900 ? 160 : 100;
    let bottom = height - (width <= 900 ? 150 : 126);
    if (width > 1200) for (const id of ['activity-guide', 'activity-panel']) {
      const panel = document.getElementById(id);
      const rect = panel?.getBoundingClientRect();
      if (!rect?.width || !rect.height) continue;
      if (rect.left < width * .35) left = Math.max(left, Math.min(rect.right + 20, width * .35));
      else if (rect.right > width * .65) right = Math.min(right, Math.max(rect.left - 20, width * .65));
    }
    return { width, height, left, right, top: Math.min(top, height * .3), bottom: Math.max(bottom, height * .68) };
  }

  _pose(records, direction) {
    const ray = direction.clone().normalize();
    const right = new THREE.Vector3().crossVectors(UP, ray).normalize();
    const up = new THREE.Vector3().crossVectors(ray, right).normalize();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const { position, radius } of records) {
      const x = position.dot(right), y = position.dot(up), z = position.dot(ray);
      minX = Math.min(minX, x - radius); maxX = Math.max(maxX, x + radius);
      minY = Math.min(minY, y - radius); maxY = Math.max(maxY, y + radius);
      minZ = Math.min(minZ, z - radius); maxZ = Math.max(maxZ, z + radius);
    }
    const viewport = this._viewport();
    const availableWidth = Math.max(180, viewport.right - viewport.left);
    const availableHeight = Math.max(150, viewport.bottom - viewport.top);
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distance = Math.max(28, Math.max((maxX - minX) * viewport.height / availableWidth, (maxY - minY) * viewport.height / availableHeight) / (2 * tangent) * 1.13 + (maxZ - minZ) / 2);
    const center = right.clone().multiplyScalar((minX + maxX) / 2).addScaledVector(up, (minY + maxY) / 2).addScaledVector(ray, (minZ + maxZ) / 2);
    const perPixel = 2 * distance * tangent / viewport.height;
    const target = center.clone().addScaledVector(right, -(viewport.left + viewport.right - viewport.width) / 2 * perPixel)
      .addScaledVector(up, (viewport.top + viewport.bottom - viewport.height) / 2 * perPixel);
    return { target, position: target.clone().addScaledVector(ray, distance) };
  }

  _flyTo(pose, immediate = false) {
    this.controls.stop?.();
    if (immediate || this.reducedMotion) {
      this.camera.position.copy(pose.position); this.controls.target.copy(pose.target); this.camera.lookAt(pose.target); this.cameraTween = null;
    } else this.cameraTween = { from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to: pose.position, toTarget: pose.target, elapsed: 0, duration: .75 };
  }

  frame(immediate = false) {
    if (this.disposed) return;
    const records = [{ position: new THREE.Vector3(), radius: 9 }];
    for (const [id, record] of this.nodes) if (this.visibleIds.has(id)) records.push({ position: vec(this.layout.positions.get(id)), radius: record.radius + 4 });
    this.camera.up.set(0, 1, 0);
    const direction = this.view === 'orbits' ? new THREE.Vector3(.2, .78, 1) : new THREE.Vector3(.12, .18, 1);
    this._flyTo(this._pose(records, direction), immediate);
  }

  focus(id) {
    const record = this.nodes.get(id);
    if (!record || !this.visibleIds.has(id)) return;
    const ray = this.camera.position.clone().sub(this.controls.target).normalize();
    if (Math.abs(ray.y) > .97) ray.set(.1, .6, 1).normalize();
    this._flyTo(this._pose([{ position: record.position, radius: Math.max(9, record.radius * 4.2) }], ray));
  }

  _hit(event) {
    if (this.disposed) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.camera.updateMatrixWorld(); this.group.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = [...this.nodes.values()].filter(record => this.visibleIds.has(record.item.id)).map(record => record.pick);
    targets.push(this.sun);
    return this.raycaster.intersectObjects(targets, false)[0]?.object.userData || null;
  }

  _clearHover() {
    const changed = this.hoveredId !== null;
    this.hoveredId = null;
    this.onHover(null);
    this.canvas.style.cursor = 'grab';
    if (changed) this._paint();
  }

  getNodeScreenPoint(id) {
    const record = this.nodes.get(id);
    if (!record) return null;
    this.camera.updateMatrixWorld();
    const position = record.position.clone().project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (position.x * .5 + .5) * rect.width, y: rect.top + (-position.y * .5 + .5) * rect.height,
      visible: this.visibleIds.has(id) && position.z > -1 && position.z < 1 && Math.abs(position.x) < 1 && Math.abs(position.y) < 1 };
  }

  _finishLayoutTransition() {
    if (!this.layoutTransition || !this.layout) return;
    for (const [id, record] of this.nodes) {
      record.position.fromArray(this.layout.positions.get(id));
      record.mesh.position.copy(record.position); record.pick.position.copy(record.position); record.ring?.position.copy(record.position);
    }
    this.layoutTransition = null;
    this._updateLinks(); this._paint();
  }

  _finishCameraTransition() {
    if (!this.cameraTween) return;
    this.camera.position.copy(this.cameraTween.to); this.controls.target.copy(this.cameraTween.toTarget); this.camera.lookAt(this.controls.target); this.cameraTween = null;
  }

  _updateLabels() {
    const viewport = this._viewport();
    const narrow = viewport.width <= 600;
    const occupied = [];
    const reserve = (object, half, height) => {
      object.getWorldPosition(this.projected).project(this.camera);
      if (this.projected.z < -1 || this.projected.z > 1) return;
      occupied.push({ x: (this.projected.x * .5 + .5) * viewport.width, y: (-this.projected.y * .5 + .5) * viewport.height, half, height });
    };
    // Scene labels are secondary to the repository sun, its name, and the
    // selected entity. Keep those readable even in dense participant clusters.
    const sunDistance = Math.max(1, this.camera.position.distanceTo(this.sun.getWorldPosition(new THREE.Vector3())));
    const sunPixels = 4.5 * viewport.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * sunDistance);
    reserve(this.sun, sunPixels + 10, (sunPixels + 10) * 2);
    const repositoryHalf = Math.max(40, this.repositoryLabel.element.offsetWidth / 2 || this.repositoryLabel.element.textContent.length * 3.2);
    reserve(this.repositoryLabel, repositoryHalf + 8, narrow ? 30 : 24);
    if (this.selectionLabel.visible) reserve(this.selectionLabel,
      Math.min(148, Math.max(50, this.selectionLabel.element.offsetWidth / 2 + 8)),
      Math.max(40, this.selectionLabel.element.offsetHeight + 10));

    const selectedActor = this.nodes.get(this.hoveredId || this.selectedId)?.item.actor?.login?.toLowerCase();
    const labels = narrow ? [...this.clusterLabels].sort((a, b) => {
      const aSelected = a.cluster.actor && a.cluster.id === selectedActor ? 1 : 0;
      const bSelected = b.cluster.actor && b.cluster.id === selectedActor ? 1 : 0;
      return bSelected - aSelected || (b.label.userData.count || 0) - (a.label.userData.count || 0);
    }) : this.clusterLabels;
    const budget = narrow && this.view === 'contributors' ? 4 : Infinity;
    let shown = 0;
    for (const { cluster, label } of labels) {
      label.visible = false;
      if (!label.userData.active || shown >= budget) continue;
      label.getWorldPosition(this.projected).project(this.camera);
      if (this.projected.z < -1 || this.projected.z > 1) continue;
      const x = (this.projected.x * .5 + .5) * viewport.width, y = (-this.projected.y * .5 + .5) * viewport.height;
      const half = Math.min(125, Math.max(label.element.offsetWidth / 2, (cluster.label.length + 6) * 3.1)) + (narrow ? 6 : 2);
      const height = narrow ? 28 : 22;
      if (x - half < 8 || x + half > viewport.width - 8 || y < 66 || y > viewport.height - 55) continue;
      if (occupied.some(box => Math.abs(x - box.x) < half + box.half && Math.abs(y - box.y) < (box.height + height) / 2)) continue;
      occupied.push({ x, y, half, height });
      label.visible = true;
      shown++;
    }
  }

  tick(dt) {
    if (this.disposed) return;
    const delta = clamp(Number(dt) || 0, 0, .1);
    if (this.cameraTween) {
      const tween = this.cameraTween;
      tween.elapsed += delta;
      const amount = easing(Math.min(1, tween.elapsed / tween.duration));
      this.camera.position.lerpVectors(tween.from, tween.to, amount);
      this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, amount);
      this.camera.lookAt(this.controls.target);
      if (amount === 1) this.cameraTween = null;
    }
    if (this.layoutTransition) {
      const transition = this.layoutTransition;
      transition.elapsed += delta;
      const amount = easing(Math.min(1, transition.elapsed / transition.duration));
      for (const [id, record] of this.nodes) {
        record.position.lerpVectors(transition.from.get(id), vec(this.layout.positions.get(id)), amount);
        record.mesh.position.copy(record.position); record.pick.position.copy(record.position); record.ring?.position.copy(record.position);
      }
      this._updateLinks(); this._paint();
      if (amount === 1) this.layoutTransition = null;
    }
    if (this.selectionRing.visible) this.selectionRing.quaternion.copy(this.camera.quaternion);
    this.camera.updateMatrixWorld(); this.group.updateMatrixWorld(true);
    this._updateLabels();
  }

  _clearGuidesAndLinks() {
    for (const label of this.clusterLabels) { label.label.element.remove(); label.label.removeFromParent(); }
    this.clusterLabels = [];
    for (const group of [this.guideGroup, this.linkGroup]) {
      group.traverse(object => {
        if (object.geometry) { object.geometry.dispose(); this.dataGeometries.delete(object.geometry); }
        if (object.material) { object.material.dispose(); this.dataMaterials.delete(object.material); }
      });
      group.clear();
    }
    this.links = []; this.decorations = [];
  }

  _clearData() {
    this.layoutTransition = this.cameraTween = null;
    this._clearGuidesAndLinks();
    this.world.clear();
    for (const material of this.dataMaterials) material.dispose();
    for (const geometry of this.dataGeometries) geometry.dispose();
    this.dataMaterials.clear(); this.dataGeometries.clear();
    this.nodes.clear();
    this.visibleIds.clear();
    this.focusHalo.visible = this.selectionRing.visible = this.selectionLabel.visible = false;
    this.labelItem = null;
    this.selectionLabel.element.replaceChildren();
    this.hoveredId = this.selectedId = null;
    this.onHover(null);
  }

  dispose() {
    if (this.disposed) return;
    this._clearData();
    this.disposed = true;
    this.lifetime.abort();
    this.controls.removeEventListener('start', this.controlStart);
    this.motionPreference.removeEventListener('change', this.motionChange);
    this.repositoryLabel.element.remove(); this.selectionLabel.element.remove();
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    this.pickMaterial.dispose(); this.focusHalo.material.dispose(); this.selectionRing.material.dispose();
    this.sunGroup.traverse(object => object.material?.dispose());
    this.stars.geometry.dispose(); this.stars.material.dispose();
    for (const texture of this.ownedTextures) texture.dispose();
    this.group.removeFromParent();
    this.scene.background = this.previousBackground;
    for (const { light, intensity } of this.baseLights) light.intensity = intensity;
    this.canvas.style.cursor = this.previousCursor;
    if (this.previousAria === null) this.canvas.removeAttribute('aria-label'); else this.canvas.setAttribute('aria-label', this.previousAria);
  }
}
