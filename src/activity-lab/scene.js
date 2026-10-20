import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { softDotTexture } from '../scene/setup.js';
import { requestRender } from '../scene/render-on-demand.js';
import { radialSpriteTexture } from '../textures/procedural.js';
import { createContributorPortrait } from './contributor-portrait.js';
import { placeContributorCards } from './contributor-screen-layout.js';
import { encloseContributorCards, displaceConstellationClusters } from './constellation-enclosure.js';
import { createActivityLayout, activityFrameBounds, activityClusterVisible, activityRadius, activityHash, ACTIVITY_KIND_COLORS, ACTIVITY_KIND_LABELS, REPOSITORY_NODE_ID } from './scene-layout.js';

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


// CSS2DRenderer sets hidden captions to display:none. Measure changed text once
// without painting it, so a hidden label does not lose its collision footprint.
const labelSize = label => {
  const element = label.element, text = element.textContent;
  const previous = label.userData.textSize;
  let width = element.offsetWidth, height = element.offsetHeight;
  if (!width && (!previous || previous.text !== text) && element.isConnected) {
    const display = element.style.display, visibility = element.style.visibility;
    element.style.visibility = 'hidden'; element.style.display = '';
    width = element.offsetWidth; height = element.offsetHeight;
    element.style.display = display; element.style.visibility = visibility;
  }
  if (width) label.userData.textSize = { text, width, height };
  return label.userData.textSize?.text === text ? label.userData.textSize
    : { text, width: text.length * (parseFloat(element.style.fontSize) || 10) * .7, height: 20 };
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
    this.visibleKinds = new Set();
    this.kindStats = {};
    this.selectedId = null;
    this.hoveredId = null;
    this.view = 'constellation';
    this.items = [];
    this.repository = {};
    this.links = [];
    this.clusterLabels = [];
    this.decorations = [];
    this.envelopes = [];
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
    this.guideGroup.name = 'Repository total-capacity envelopes';
    this.labelGroup = new THREE.Group();
    this.group.add(this.world, this.linkGroup, this.guideGroup, this.labelGroup);
    this.scene.add(this.group);
    this.dot = softDotTexture();
    this.ownedTextures.add(this.dot);
    this.geometries = {
      sphere: new THREE.SphereGeometry(1, 32, 24),
      portrait: new THREE.CircleGeometry(1, 64),
      portraitRim: new THREE.RingGeometry(1.025, 1.085, 64),
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
      requestRender();
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

  setData(items, repository = {}, kindStats = {}) {
    if (this.disposed) return;
    this._clearData();
    this.items = Array.isArray(items) ? items : [];
    this.repository = repository || {};
    this.layout = createActivityLayout(this.items, this.view, kindStats);
    this.kindStats = this.layout.kindStats;
    this.controls.maxDistance = Math.max(1500, this.layout.extent * 12);
    this.repositoryLabel.element.textContent = this.repository.fullName || this.repository.name || 'Repository';
    for (const item of this.layout.items) {
      const color = new THREE.Color(ACTIVITY_KIND_COLORS[item.kind]);
      const portrait = item.kind === 'contributor' ? createContributorPortrait(item.actor) : null;
      const material = portrait ? new THREE.MeshBasicMaterial({ map: portrait.map, color: '#ffffff', toneMapped: false, side: THREE.DoubleSide })
        : new THREE.MeshStandardMaterial({ color, roughness: .26, metalness: .32, emissive: color.clone(), emissiveIntensity: .12 });
      this.dataMaterials.add(material);
      const geometry = portrait ? this.geometries.portrait : item.kind === 'issue' ? this.geometries.issue : item.kind === 'review' ? this.geometries.review : item.kind === 'comment' ? this.geometries.small : this.geometries.sphere;
      const radius = activityRadius(item);
      const position = vec(this.layout.positions.get(item.id));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position);
      mesh.scale.setScalar(radius);
      mesh.userData = { id: item.id, kind: item.kind };
      mesh.name = item.title || item.actor?.login || item.id;
      if (item.kind === 'issue' || item.kind === 'review') mesh.rotation.set(.1, (activityHash(item.id) % 100) / 100, .2);
      const pick = new THREE.Mesh(portrait ? this.geometries.portrait : this.geometries.pick, this.pickMaterial);
      pick.position.copy(position);
      pick.scale.setScalar(radius * (portrait ? 1.1 : 1.3));
      pick.userData = { id: item.id, kind: item.kind };
      this.world.add(mesh, pick);
      const record = { item, mesh, pick, position, renderPosition: position.clone(), radius, color, portrait };
      if (portrait) {
        const rimMaterial = new THREE.MeshBasicMaterial({ color: '#c5d5ec', transparent: true, opacity: .8, side: THREE.DoubleSide, toneMapped: false });
        this.dataMaterials.add(rimMaterial);
        record.ring = new THREE.Mesh(this.geometries.portraitRim, rimMaterial);
        record.ring.position.copy(position); record.ring.scale.setScalar(radius); record.ring.raycast = () => {};
        this.world.add(record.ring);
        record.tag = textLabel(item.actor?.login ? `@${item.actor.login}` : 'Unknown contributor', '#e8eef8', 10);
        record.tag.element.classList.add('activity-contributor-tag');
        record.tag.element.dataset.contributor = item.actor?.login || '';
        record.tag.center.set(.5, 0);
        this.labelGroup.add(record.tag);
      }
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
    this.layout = createActivityLayout(this.items, view, this.kindStats);
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
    const addDecoration = (object, cluster) => {
      object.raycast = () => {};
      object.userData = { kind: cluster.kind, role: 'capacity-envelope', total: cluster.total, loaded: cluster.loaded };
      this.guideGroup.add(object);
      this.decorations.push({ line: object, cluster, basePosition: object.position.clone(), baseQuaternion: object.quaternion.clone() });
    };
    for (const cluster of this.layout.clusters) {
      const label = textLabel('', cluster.color, cluster.actor ? 10 : 11);
      label.position.fromArray(cluster.position).add(new THREE.Vector3(0, cluster.labelOnly ? 4 : cluster.radius + 4.5, 0));
      this.labelGroup.add(label);
      this.clusterLabels.push({ cluster, label });
      // These quiet translucent volumes describe capacity, not extra entities.
      // In particular, an all-closed category retains its complete envelope.
      // Portraits and their full names face the camera; their enclosing circle
      // follows the same plane, while activity capacity keeps its 3D volumes.
      const portraitEnclosure = this.view === 'constellation' && cluster.kind === 'contributor';
      const geometry = cluster.envelope === 'band'
        ? new THREE.TorusGeometry(cluster.orbitRadius, cluster.tubeRadius, 12, 128)
        : portraitEnclosure ? new THREE.CircleGeometry(cluster.radius, 128) : new THREE.SphereGeometry(cluster.radius, 32, 20);
      const material = new THREE.MeshBasicMaterial({ color: cluster.color, transparent: true, opacity: cluster.actor ? .014 : .027,
        side: portraitEnclosure ? THREE.DoubleSide : THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.dataGeometries.add(geometry); this.dataMaterials.add(material);
      const shell = new THREE.Mesh(geometry, material);
      if (cluster.envelope === 'band') shell.rotation.set(Math.PI / 2 - cluster.tilt, -cluster.rotation, 0, 'YXZ');
      else shell.position.fromArray(cluster.position);
      addDecoration(shell, cluster);
      this.envelopes.push({ cluster, object: shell });
      if (cluster.radius > 0) for (const plane of portraitEnclosure ? ['xy'] : ['xy', 'xz']) {
        const points = Array.from({ length: 129 }, (_, index) => {
          const angle = index / 128 * Math.PI * 2;
          const point = plane === 'xy' ? [Math.cos(angle), Math.sin(angle), 0] : [Math.cos(angle), 0, Math.sin(angle)];
          return vec(point).multiplyScalar(cluster.radius);
        });
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const lineMaterial = new THREE.LineBasicMaterial({ color: cluster.color, transparent: true,
          opacity: cluster.actor ? .13 : plane === 'xy' ? .26 : .16, depthWrite: false });
        this.dataGeometries.add(lineGeometry); this.dataMaterials.add(lineMaterial);
        const outline = new THREE.Line(lineGeometry, lineMaterial);
        outline.position.fromArray(cluster.position);
        addDecoration(outline, cluster);
      }
    }
    for (const ring of this.layout.rings) {
      const points = Array.from({ length: 181 }, (_, index) => {
        const angle = index / 180 * Math.PI * 2;
        const x = Math.cos(angle) * ring.radius, z = Math.sin(angle) * ring.radius;
        return new THREE.Vector3(x * Math.cos(ring.rotation) - z * Math.cos(ring.tilt) * Math.sin(ring.rotation), z * Math.sin(ring.tilt), x * Math.sin(ring.rotation) + z * Math.cos(ring.tilt) * Math.cos(ring.rotation));
      });
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color: ACTIVITY_KIND_COLORS[ring.kind], transparent: true, opacity: .21, depthWrite: false });
      this.dataGeometries.add(geometry); this.dataMaterials.add(material);
      addDecoration(new THREE.Line(geometry, material), this.layout.clusters.find(cluster => cluster.kind === ring.kind));
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
      const a = link.from === REPOSITORY_NODE_ID ? new THREE.Vector3() : this.nodes.get(link.from).renderPosition;
      const b = this.nodes.get(link.to).renderPosition;
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

  setVisible(ids, { kinds } = {}) {
    if (this.disposed) return;
    this.visibleIds = new Set(ids || []);
    let leftCloseUp = false;
    if (this.focusedConstellation && (!this.visibleIds.has(this.focusedConstellation.id)
      || (kinds !== undefined && [...new Set(kinds || [])].sort().join(',') !== [...this.visibleKinds].sort().join(',')))) {
      this.focusedConstellation = null; this.contributorScreenSignature = null; leftCloseUp = true;
    }
    if (kinds !== undefined) this.visibleKinds = new Set(kinds || []);
    if (this.hoveredId && !this.visibleIds.has(this.hoveredId)) this._clearHover();
    this._paint();
    if (leftCloseUp) this.frame();
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
      if (record.portrait) {
        record.ring.material.color.set(selected ? '#ffe1ab' : hovered ? '#ffffff' : '#c5d5ec');
        record.ring.material.opacity = selected || hovered ? 1 : .8;
        record.tag.visible = visible;
        record.tag.element.classList.toggle('is-active', selected || hovered);
      } else {
        record.mesh.material.color.copy(record.color).lerp(WHITE, selected ? .22 : hovered ? .12 : 0);
        record.mesh.material.emissive.copy(record.color);
        record.mesh.material.emissiveIntensity = selected ? .45 : hovered ? .3 : .12;
      }
      record.mesh.scale.setScalar(record.radius * (selected ? 1.08 : 1));
    }
    for (const link of this.links) {
      const visible = this.visibleIds.has(link.to) && (link.from === REPOSITORY_NODE_ID || this.visibleIds.has(link.from));
      const selected = link.from === this.selectedId || link.to === this.selectedId || link.from === this.hoveredId || link.to === this.hoveredId;
      link.line.visible = visible && (link.kind !== 'actor' || this.view === 'contributors' || selected);
      link.line.material.opacity = selected ? .7 : link.kind === 'repository' ? .1 : this.view === 'contributors' ? .2 : .22;
    }
    for (const decoration of this.decorations) decoration.line.visible = activityClusterVisible(decoration.cluster, this.visibleKinds);
    for (const { cluster, label } of this.clusterLabels) {
      const count = cluster.ids.filter(id => this.visibleIds.has(id)).length;
      const total = cluster.total.toLocaleString('en-US');
      const denominator = cluster.actor ? `${total} loaded` : `${cluster.exact ? '' : '≥'}${total}`;
      label.element.textContent = `${cluster.label} · ${count} / ${denominator}`;
      label.element.title = cluster.actor ? 'Shown / loaded participation; per-person repository totals are unavailable.'
        : 'Shown / repository total, including closed and merged history. ≥ indicates a known lower bound.';
      label.userData.active = activityClusterVisible(cluster, this.visibleKinds);
      label.userData.count = cluster.total;
    }
    const highlighted = this.nodes.get(this.hoveredId || this.selectedId);
    // Portraits already have their own gold selection rim; an extra wide halo
    // or ring would reach into the attached username and neighboring cards.
    this.focusHalo.visible = Boolean(highlighted && !highlighted.portrait && this.visibleIds.has(highlighted.item.id));
    this.selectionRing.visible = Boolean(this.selectedId && !this.nodes.get(this.selectedId)?.portrait && this.visibleIds.has(this.selectedId));
    this.selectionLabel.visible = this.focusHalo.visible && !highlighted.portrait;
    if (highlighted && this.focusHalo.visible) {
      this.focusHalo.position.copy(highlighted.renderPosition);
      this.focusHalo.scale.setScalar(highlighted.radius * 6.4);
      this.focusHalo.material.color.copy(highlighted.color);
      this.selectionLabel.position.copy(highlighted.renderPosition).add(new THREE.Vector3(0, highlighted.radius * 2.05, 0));
      this._setSelectionLabel(highlighted.item);
    }
    if (this.selectionRing.visible) {
      const selected = this.nodes.get(this.selectedId);
      this.selectionRing.position.copy(selected.renderPosition);
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
    this.focusedConstellation = null; this.contributorScreenSignature = null;
    this.frameBounds = activityFrameBounds(this.layout, this.visibleKinds);
    const contributor = this.layout?.clusters.find(cluster => cluster.kind === 'contributor');
    if (this.view === 'constellation' && this.constellationEnclosure && contributor && activityClusterVisible(contributor, this.visibleKinds)) {
      // Frame the actual expanded guide and translated categories, not their
      // smaller original anchors. Count/state filtering still preserves capacity.
      this.frameBounds = [{ position: [0, 0, 0], radius: 9 }, ...this.layout.clusters
        .filter(cluster => activityClusterVisible(cluster, this.visibleKinds)).map(cluster => {
          const displayed = cluster === contributor ? this.constellationEnclosure : this.constellationPlacements.get(cluster.id);
          return { position: displayed?.position || cluster.bounds.position, radius: (displayed?.worldRadius || cluster.bounds.radius) + 5 };
        })];
    }
    const records = this.frameBounds.map(bound => ({ position: vec(bound.position), radius: bound.radius }));
    this.camera.up.set(0, 1, 0);
    const direction = this.view === 'orbits' ? new THREE.Vector3(.2, .78, 1) : new THREE.Vector3(.12, .18, 1);
    this._flyTo(this._pose(records, direction), immediate);
  }

  focus(id) {
    const record = this.nodes.get(id);
    if (!record || !this.visibleIds.has(id)) return;
    // A close-up inspects the already arranged map. Repacking whole categories
    // against the magnified camera would move the target we are flying toward.
    this.focusedConstellation = this.view === 'constellation' && !record.portrait
      ? { id, positions: new Map([...this.nodes].map(([key, node]) => [key, node.renderPosition.clone()])) } : null;
    this.contributorScreenSignature = null;
    const ray = this.camera.position.clone().sub(this.controls.target).normalize();
    if (Math.abs(ray.y) > .97) ray.set(.1, .6, 1).normalize();
    this._flyTo(this._pose([{ position: record.renderPosition, radius: Math.max(9, record.radius * 4.2) }], ray));
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
    const position = record.renderPosition.clone().project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (position.x * .5 + .5) * rect.width, y: rect.top + (-position.y * .5 + .5) * rect.height,
      visible: this.visibleIds.has(id) && position.z > -1 && position.z < 1 && Math.abs(position.x) < 1 && Math.abs(position.y) < 1 };
  }

  _finishLayoutTransition() {
    if (!this.layoutTransition || !this.layout) return;
    for (const [id, record] of this.nodes) {
      record.position.fromArray(this.layout.positions.get(id));
      record.renderPosition.copy(record.position);
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
    const reserve = (object, half, height, offsetY = 0) => {
      object.getWorldPosition(this.projected).project(this.camera);
      if (this.projected.z < -1 || this.projected.z > 1) return;
      occupied.push({ x: (this.projected.x * .5 + .5) * viewport.width, y: (-this.projected.y * .5 + .5) * viewport.height + offsetY, half, height });
    };
    // Scene labels are secondary to the repository sun, its name, and the
    // contributor identities. Keep those readable in dense participant clusters.
    const sunDistance = Math.max(1, this.camera.position.distanceTo(this.sun.getWorldPosition(new THREE.Vector3())));
    const sunPixels = 4.5 * viewport.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * sunDistance);
    reserve(this.sun, sunPixels + 10, (sunPixels + 10) * 2);
    const repositoryHalf = Math.max(40, labelSize(this.repositoryLabel).width / 2);
    reserve(this.repositoryLabel, repositoryHalf + 8, narrow ? 30 : 24);

    // Contributor identity stays attached to the camera-facing portrait. Category
    // captions yield to these tags so people remain readable at every zoom.
    for (const record of this.nodes.values()) if (record.tag) {
      record.tag.getWorldPosition(this.projected).project(this.camera);
      const x = (this.projected.x * .5 + .5) * viewport.width, y = (-this.projected.y * .5 + .5) * viewport.height;
      record.tag.visible = this.visibleIds.has(record.item.id) && this.projected.z >= -1 && this.projected.z <= 1
        && x >= 8 && x <= viewport.width - 8 && y >= 66 && y <= viewport.height - 55;
      if (record.tag.visible) {
        reserve(record.tag, Math.max(35, (record.tagWidth || labelSize(record.tag).width) / 2 + 6),
          (record.tagHeight || 20) + 8, (record.tagHeight || 20) / 2);
        const center = record.mesh.getWorldPosition(new THREE.Vector3()).project(this.camera);
        const edge = record.mesh.localToWorld(new THREE.Vector3(1.085, 0, 0)).project(this.camera);
        const radius = Math.hypot((edge.x - center.x) * viewport.width / 2, (edge.y - center.y) * viewport.height / 2);
        reserve(record.mesh, radius + 8, (radius + 8) * 2);
      }
    }
    // Transient activity captions yield to people too. The selected record's
    // details remain available in the inspector when no clear caption fits.
    const highlighted = this.nodes.get(this.hoveredId || this.selectedId);
    this.selectionLabel.visible = Boolean(highlighted && !highlighted.portrait && this.visibleIds.has(highlighted.item.id));
    if (this.selectionLabel.visible) {
      this.selectionLabel.getWorldPosition(this.projected).project(this.camera);
      const x = (this.projected.x * .5 + .5) * viewport.width, y = (-this.projected.y * .5 + .5) * viewport.height;
      const size = labelSize(this.selectionLabel), half = size.width / 2 + 8, height = size.height + 10;
      this.selectionLabel.visible = this.projected.z >= -1 && this.projected.z <= 1
        && x - half >= 8 && x + half <= viewport.width - 8 && y - height / 2 >= 66 && y + height / 2 <= viewport.height - 55
        && !occupied.some(box => Math.abs(x - box.x) < half + box.half && Math.abs(y - box.y) < (box.height + height) / 2);
      if (this.selectionLabel.visible) occupied.push({ x, y, half, height });
    }
    const selectedActor = highlighted?.item.actor?.login?.toLowerCase();
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
      const size = labelSize(label);
      const half = size.width / 2 + 6;
      const height = size.height + 8;
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
        record.renderPosition.copy(record.position);
        record.mesh.position.copy(record.position); record.pick.position.copy(record.position); record.ring?.position.copy(record.position);
      }
      this._updateLinks(); this._paint();
      if (amount === 1) this.layoutTransition = null;
    }
    this.camera.updateMatrixWorld();
    this._spaceContributorCards();
    if (this.selectionRing.visible) this.selectionRing.quaternion.copy(this.camera.quaternion);
    this.group.updateMatrixWorld(true);
    this._updateLabels();
  }

  _spaceContributorCards() {
    // The first frame can arrive before the saved repository has finished loading.
    if (!this.layout) return;
    const viewport = this._viewport();
    const dock = document.getElementById('activity-timebar')?.getBoundingClientRect();
    const signature = [this.view, this.selectedId, [...this.visibleKinds].sort().join(','), [...this.visibleIds].join(','), dock?.x, dock?.y, dock?.width, dock?.height, ...Object.values(viewport), ...this.camera.matrixWorld.elements,
      ...this.camera.projectionMatrix.elements, ...[...this.nodes.values()].filter(record => record.tag).map(record => record.tag.element.offsetWidth)].join('|');
    if (!this.layoutTransition && signature === this.contributorScreenSignature) return;
    this.contributorScreenSignature = this.layoutTransition ? null : signature;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const project = position => {
      const point = position.clone().project(this.camera);
      return { x: (point.x * .5 + .5) * viewport.width, y: (-point.y * .5 + .5) * viewport.height, z: point.z };
    };
    const cards = [], activityCards = [], obstacles = [], projected = new Map();
    const anchor = record => this.focusedConstellation?.positions.get(record.item.id) || record.position;
    if (dock?.width && dock.height) obstacles.push({ x: dock.x + dock.width / 2, y: dock.y + dock.height / 2, width: dock.width + 8, height: dock.height + 8 });
    for (const record of this.nodes.values()) {
      const position = anchor(record), center = project(position);
      if (center.z < -1 || center.z > 1) continue;
      const edge = project(position.clone().addScaledVector(right, record.mesh.scale.x * (record.portrait ? 1.085 : 1.65)));
      const pixels = Math.max(1, Math.hypot(edge.x - center.x, edge.y - center.y));
      if (!record.portrait) {
        projected.set(record.item.id, { center, pixels, footer: 0 });
        if (this.visibleIds.has(record.item.id)) activityCards.push({ id: record.item.id, x: center.x, y: center.y, width: pixels * 2 + 4, height: pixels * 2 + 4 });
        continue;
      }
      record.tagWidth = record.tag.element.offsetWidth || record.tagWidth || record.tag.element.textContent.length * 6 + 14;
      record.tagHeight = record.tag.element.offsetHeight || record.tagHeight || 20;
      const textWidth = record.tagWidth, textHeight = record.tagHeight;
      const footer = textHeight + 5;
      projected.set(record.item.id, { center, pixels, footer });
      cards.push({ id: record.item.id, x: center.x, y: center.y + footer / 2,
        width: Math.max(pixels * 2, textWidth), height: pixels * 2 + footer });
    }
    const sun = project(new THREE.Vector3());
    if (sun.z >= -1 && sun.z <= 1) {
      const edge = project(right.clone().multiplyScalar(7));
      const radius = Math.max(12, Math.hypot(edge.x - sun.x, edge.y - sun.y));
      obstacles.push({ x: sun.x, y: sun.y + 10, width: Math.max(radius * 2, 130), height: radius * 2 + 35 });
    }
    const repositoryName = project(this.repositoryLabel.getWorldPosition(new THREE.Vector3()));
    if (repositoryName.z >= -1 && repositoryName.z <= 1) {
      const size = labelSize(this.repositoryLabel);
      obstacles.push({ x: repositoryName.x, y: repositoryName.y, width: size.width + 12, height: size.height + 12 });
    }
    // Recompute from the immutable layout, never from last frame's correction.
    // All loaded contributor cards keep their anchors; hidden activities never
    // take away the screen space needed to read a visible person's name.
    const placementBounds = { left: viewport.left, right: viewport.right, top: viewport.top,
      bottom: Math.min(viewport.bottom, dock?.y > viewport.height * .65 ? dock.y - 20 : viewport.bottom) };
    const placed = placeContributorCards(cards, { ...(this.focusedConstellation ? {} : placementBounds), gap: 16,
      obstacles: this.focusedConstellation ? [...obstacles, ...activityCards] : obstacles, priorityId: this.selectedId });
    const portraitBounds = cards.filter(card => this.visibleIds.has(card.id)).map(card => ({ ...card, ...placed.get(card.id) }));
    const intersectsPortrait = card => portraitBounds.some(other => Math.abs(card.x - other.x) < (card.width + other.width) / 2 + 5
      && Math.abs(card.y - other.y) < (card.height + other.height) / 2 + 5);
    // Constellation moves neighboring categories with their entire envelopes.
    // Other views move only colliding activity bodies; links follow either way.
    const clusterOffsets = this.focusedConstellation ? null
      : this._layoutConstellationEnclosure(cards.map(card => ({ ...card, ...placed.get(card.id) })), viewport, project, right);
    const displaced = clusterOffsets || this.focusedConstellation ? [] : activityCards.filter(intersectsPortrait);
    const fixed = activityCards.filter(card => !intersectsPortrait(card));
    const activityPlaced = placeContributorCards(displaced, { ...placementBounds, gap: 5,
      obstacles: [...obstacles, ...portraitBounds, ...fixed], priorityId: this.selectedId });
    let changed = false;
    for (const record of this.nodes.values()) {
      const old = record.renderPosition.clone();
      record.renderPosition.copy(anchor(record));
      if (record.portrait) {
        const target = placed.get(record.item.id), original = projected.get(record.item.id);
        if (target && original) record.renderPosition.set(target.x / viewport.width * 2 - 1,
          1 - (target.y - original.footer / 2) / viewport.height * 2, original.center.z).unproject(this.camera);
        record.mesh.quaternion.copy(this.camera.quaternion);
        record.pick.quaternion.copy(this.camera.quaternion);
        record.ring.quaternion.copy(this.camera.quaternion);
        record.ring.scale.copy(record.mesh.scale);
        const point = project(record.renderPosition);
        const tagY = point.y + (original?.pixels || 0) + 5;
        record.tag.position.set(point.x / viewport.width * 2 - 1, 1 - tagY / viewport.height * 2, point.z).unproject(this.camera);
      }
      if (!record.portrait && clusterOffsets?.has(record.item.kind)) record.renderPosition.add(clusterOffsets.get(record.item.kind));
      if (!record.portrait && activityPlaced.has(record.item.id)) {
        const target = activityPlaced.get(record.item.id), original = projected.get(record.item.id);
        record.renderPosition.set(target.x / viewport.width * 2 - 1, 1 - target.y / viewport.height * 2, original.center.z).unproject(this.camera);
      }
      record.mesh.position.copy(record.renderPosition); record.pick.position.copy(record.renderPosition); record.ring?.position.copy(record.renderPosition);
      if (old.distanceToSquared(record.renderPosition) > 1e-8) changed = true;
    }
    if (changed) this._updateLinks();
    const highlighted = this.nodes.get(this.hoveredId || this.selectedId);
    if (highlighted) {
      this.focusHalo.position.copy(highlighted.renderPosition);
      if (!highlighted.portrait) this.selectionLabel.position.copy(highlighted.renderPosition).add(new THREE.Vector3(0, highlighted.radius * 2.05, 0));
    }
    const selected = this.nodes.get(this.selectedId);
    if (selected) this.selectionRing.position.copy(selected.renderPosition);
  }

  _layoutConstellationEnclosure(cards, viewport, project, right) {
    // Restore original anchors before every solve, including after view/filter
    // changes. Growing the circle must never accumulate translation or scale.
    for (const { line, basePosition, baseQuaternion } of this.decorations) {
      line.position.copy(basePosition); line.quaternion.copy(baseQuaternion); line.scale.setScalar(1);
    }
    for (const { cluster, label } of this.clusterLabels) label.position.fromArray(cluster.position)
      .add(new THREE.Vector3(0, cluster.labelOnly ? 4 : cluster.radius + 4.5, 0));
    this.constellationEnclosure = null; this.constellationPlacements = new Map();
    const contributor = this.view === 'constellation' && this.layout.clusters.find(cluster => cluster.kind === 'contributor');
    if (!contributor || !activityClusterVisible(contributor, this.visibleKinds)) return null;
    const original = project(vec(contributor.position));
    if (original.z < -1 || original.z > 1) return null;
    const edge = project(vec(contributor.position).addScaledVector(right, contributor.radius));
    const minimumCircle = { x: original.x, y: original.y, radius: Math.hypot(edge.x - original.x, edge.y - original.y) };
    const enclosure = encloseContributorCards(cards, { minimumCircle, padding: 14 });
    const unproject = (x, y, z) => new THREE.Vector3(x / viewport.width * 2 - 1, 1 - y / viewport.height * 2, z).unproject(this.camera);
    const center = unproject(enclosure.x, enclosure.y, original.z);
    const radius = center.distanceTo(unproject(enclosure.x + enclosure.radius, enclosure.y, original.z));
    this.constellationEnclosure = { ...enclosure, z: original.z, position: center.toArray(), worldRadius: radius };
    for (const { line, cluster } of this.decorations) if (cluster === contributor) {
      line.position.copy(center); line.quaternion.copy(this.camera.quaternion); line.scale.setScalar(radius / contributor.radius);
    }
    const caption = this.clusterLabels.find(entry => entry.cluster === contributor)?.label;
    if (caption) caption.position.copy(unproject(enclosure.x, enclosure.y - enclosure.radius - 13, original.z));

    const focal = viewport.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    // Conservative circular silhouette of a perspective-projected sphere. The
    // center offset and major axis account for categories away from the optical
    // axis; just projecting one radius would miss their outer edge after orbit.
    const silhouette = (position, radius) => {
      const local = position.clone().applyMatrix4(this.camera.matrixWorldInverse);
      const depth = -local.z, radial = Math.hypot(local.x, local.y);
      const denominator = Math.max(1, depth * depth - radius * radius);
      return focal * (radius * Math.sqrt(Math.max(0, depth * depth + radial * radial - radius * radius))
        + radius * radius * radial / Math.max(1, depth)) / denominator;
    };
    const neighbors = this.layout.clusters.filter(cluster => cluster !== contributor && activityClusterVisible(cluster, this.visibleKinds)).map(cluster => {
      const position = vec(cluster.position), local = position.clone().applyMatrix4(this.camera.matrixWorldInverse);
      const point = project(position);
      if (point.z < -1 || point.z > 1) return null;
      // A close-up can put the camera inside a category's capacity volume. Move
      // that whole volume farther along its sightline before moving it sideways.
      const depth = -local.z, safeDepth = Math.max(depth, cluster.radius * 3);
      if (safeDepth > depth) { local.multiplyScalar(safeDepth / Math.max(1, depth)); position.copy(local.applyMatrix4(this.camera.matrixWorld)); }
      return { cluster, anchor: project(position), position, radius: silhouette(position, cluster.radius) + 3 };
    }).filter(Boolean);
    const sun = project(new THREE.Vector3());
    const sunEdge = project(right.clone().multiplyScalar(7));
    const repositorySize = labelSize(this.repositoryLabel);
    const repositoryName = project(this.repositoryLabel.getWorldPosition(new THREE.Vector3()));
    const repositoryFootprint = Math.hypot(repositoryName.x - sun.x, repositoryName.y - sun.y)
      + Math.hypot(repositorySize.width / 2 + 8, repositorySize.height / 2 + 8);
    const obstacles = sun.z >= -1 && sun.z <= 1 ? [{ x: sun.x, y: sun.y,
      radius: Math.max(Math.hypot(sunEdge.x - sun.x, sunEdge.y - sun.y) + 8, repositoryFootprint) }] : [];
    let placement = new Map();
    // Translation changes a sphere's perspective silhouette slightly. Re-solve
    // from the same anchors with conservative radii until the full volumes clear.
    for (let pass = 0; pass < 24; pass++) {
      placement = displaceConstellationClusters(neighbors.map(item => ({ id: item.cluster.id, x: item.anchor.x, y: item.anchor.y, radius: item.radius })), { enclosure, obstacles, gap: 18 });
      let grew = false;
      for (const item of neighbors) {
        const target = placement.get(item.cluster.id), position = unproject(target.x, target.y, item.anchor.z);
        const needed = silhouette(position, item.cluster.radius) + 3;
        if (needed > item.radius + .01) { item.radius = needed + .25; grew = true; }
      }
      if (!grew) break;
    }
    const offsets = new Map();
    for (const item of neighbors) {
      const target = placement.get(item.cluster.id), position = unproject(target.x, target.y, item.anchor.z);
      const offset = position.clone().sub(vec(item.cluster.position));
      offsets.set(item.cluster.kind, offset);
      this.constellationPlacements.set(item.cluster.id, { ...target, position: position.toArray(), offset: offset.toArray(), worldRadius: item.cluster.radius });
      for (const { line, cluster, basePosition } of this.decorations) if (cluster === item.cluster) line.position.copy(basePosition).add(offset);
      const label = this.clusterLabels.find(entry => entry.cluster === item.cluster)?.label;
      if (label) label.position.add(offset);
    }
    return offsets;
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
    this.links = []; this.decorations = []; this.envelopes = [];
    this.constellationEnclosure = null; this.constellationPlacements = new Map();
    this.focusedConstellation = null; this.contributorScreenSignature = null;
  }

  _clearData() {
    this.contributorScreenSignature = null;
    this.layoutTransition = this.cameraTween = null;
    this._clearGuidesAndLinks();
    for (const record of this.nodes.values()) {
      record.portrait?.dispose();
      if (record.tag) { record.tag.element.remove(); record.tag.removeFromParent(); }
    }
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
