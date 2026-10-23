import * as THREE from 'three';
import { requestRender } from '../scene/render-on-demand.js';
import { createRepositorySculptures } from './repository-sculptures.js';

const GOLD = new THREE.Color('#e9c595');
const SILVER = new THREE.Color('#a7b8cc');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const ease = value => value * value * (3 - 2 * value);
const pageHeightAt = (x, width, z, height) => .12 * (x / width) ** 2 + .035 * Math.sin(z / height * Math.PI);

// Each leaf is a section, not an invented page count. Curvature, ruled lines and
// depth make the index a small physical folio beside the readable source text.
function leafGeometry(width, height) {
  const geometry = new THREE.PlaneGeometry(width, height, 12, 5);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i) + width / 2;
    const z = positions.getY(i);
    positions.setXYZ(i, x, pageHeightAt(x, width, z, height), z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function leafBorder(width, height) {
  const points = [];
  const add = (x, z) => points.push(new THREE.Vector3(x, pageHeightAt(x, width, z, height) + .012, z));
  for (let i = 0; i <= 16; i++) add(width * i / 16, -height / 2);
  for (let i = 1; i <= 10; i++) add(width, -height / 2 + height * i / 10);
  for (let i = 1; i <= 16; i++) add(width * (1 - i / 16), height / 2);
  for (let i = 1; i <= 10; i++) add(0, height / 2 - height * i / 10);
  return new THREE.BufferGeometry().setFromPoints(points);
}

function sectionLength(section) {
  if (Number.isFinite(section.wordCount)) return Math.max(0, section.wordCount);
  if (Number.isFinite(section.length)) return Math.max(0, section.length);
  const text = section.text || section.content || section.title || '';
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

/** A finite-motion 3D README index; the caller owns rendering and controls.update. */
export class ReadmeScene {
  constructor(stage, { onSelect = () => {}, onHover = () => {} } = {}) {
    this.stage = stage;
    this.scene = stage.scene;
    this.camera = stage.camera;
    this.controls = stage.controls;
    this.canvas = stage.renderer.domElement;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.leaves = [];
    this.selectedId = null;
    this.hoveredId = null;
    this.disposed = false;
    this.transition = null;
    this.repositorySculptures = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.lifetime = new AbortController();
    this.previousCursor = this.canvas.style.cursor;
    this.previousAria = this.canvas.getAttribute('aria-label');
    this.previousView = this.camera.view ? { ...this.camera.view } : null;
    this.previousBackground = this.scene.background;
    this.previousControlSettings = Object.fromEntries(['enablePan', 'enableDamping', 'minDistance', 'maxDistance', 'rotateSpeed', 'zoomSpeed'].map(key => [key, this.controls[key]]));
    this.baseLights = this.scene.children.filter(child => child.isLight).map(light => [light, light.intensity]);
    for (const [light] of this.baseLights) light.intensity = 0;
    this.scene.background = new THREE.Color('#01040a');
    this.canvas.setAttribute('aria-label', 'Three-dimensional README section index. Each glass leaf represents a section. Drag to orbit, scroll to zoom, or select a leaf to read its section. All sections are also available in the text index.');
    this.canvas.style.cursor = 'grab';

    this.group = new THREE.Group();
    this.group.name = 'About · README folio';
    this.folio = new THREE.Group();
    this.folio.name = 'README sections in source order';
    this.group.add(this.folio);
    const key = new THREE.DirectionalLight('#ffe8c6', 3.1);
    key.position.set(3, 8, 10);
    const rim = new THREE.DirectionalLight('#8baedb', 1.8);
    rim.position.set(-8, 2, -6);
    this.group.add(key, rim, new THREE.HemisphereLight('#bbcce3', '#111722', 1.5));
    this.scene.add(this.group);

    this.controls.setRootMode?.(false);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.rotateSpeed = .65;
    this.controls.zoomSpeed = .8;
    this.camera.up.set(0, 1, 0);
    this.motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.motionPreference.matches;
    this.motionChange = () => {
      this.reducedMotion = this.motionPreference.matches;
      if (this.reducedMotion) this._finishTransition();
      requestRender();
    };
    this.motionPreference.addEventListener('change', this.motionChange);
    this._bindPointer();
    // The shared stage resets camera.aspect on resize; restore the reserved view
    // after its listener even when a caller measures its layout on the next frame.
    window.addEventListener('resize', () => { this._projection(); requestRender(); }, { signal: this.lifetime.signal });
  }

  /** Rectangle in CSS pixels, relative to the full-canvas renderer. */
  resize(bounds) {
    if (this.disposed || !bounds) return;
    this.bounds = {
      x: Number(bounds.x) || 0, y: Number(bounds.y) || 0,
      width: Math.max(1, Number(bounds.width) || 1), height: Math.max(1, Number(bounds.height) || 1),
    };
    this.frame();
  }

  _projection() {
    const rect = this.canvas.getBoundingClientRect();
    const bounds = this.bounds || { x: 0, y: 0, width: rect.width, height: rect.height };
    // A camera framed for the reserved rectangle can still render to a full-size
    // composer. The negative offset places that rectangle inside the full canvas.
    this.camera.setViewOffset(bounds.width, bounds.height, -bounds.x, -bounds.y, Math.max(1, rect.width), Math.max(1, rect.height));
    this.camera.updateProjectionMatrix();
    return bounds;
  }

  setSections(sections = []) {
    if (this.disposed) return;
    this._clearLeaves();
    const seen = new Set();
    const valid = sections.filter(section => {
      if (!section?.id || seen.has(section.id)) return false;
      seen.add(section.id); return true;
    });
    const maximum = Math.max(1, ...valid.map(sectionLength));
    const count = valid.length;
    const gap = count > 1 ? Math.min(.73, 8.5 / (count - 1)) : .73;
    const totalHeight = Math.max(0, count - 1) * gap;
    this.markerGeometry = new THREE.SphereGeometry(.048, 12, 8);

    valid.forEach((section, index) => {
      const amount = Math.sqrt(sectionLength(section) / maximum);
      const width = 3.2 + amount * 1.35;
      const height = 2.25 + amount * .65;
      const depth = clamp((section.level ?? section.depth ?? 1) - 1, 0, 5);
      const fraction = count > 1 ? index / (count - 1) : .5;
      const group = new THREE.Group();
      const base = new THREE.Vector3(-2.1 + depth * .1, totalHeight / 2 - index * gap, 0);
      group.position.copy(base);
      group.rotation.y = -.26 + fraction * .47;
      group.name = `README section · ${section.title || section.id}`;
      const material = new THREE.MeshStandardMaterial({ color: '#72839b', roughness: .42, metalness: .16, transparent: true, opacity: .15, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(leafGeometry(width, height), material);
      mesh.userData.sectionId = section.id;
      mesh.renderOrder = count - index;
      group.add(mesh);
      const edge = new THREE.Line(leafBorder(width, height), new THREE.LineBasicMaterial({ color: SILVER, transparent: true, opacity: .45, depthWrite: false, toneMapped: false }));
      edge.raycast = () => {};
      group.add(edge);

      // Ruled marks communicate relative section length, without fabricating text.
      const rulePoints = [];
      const rules = Math.max(2, Math.round(3 + amount * 7));
      for (let line = 0; line < rules; line++) {
        const z = -height / 2 + .35 + line * (height - .7) / Math.max(1, rules - 1);
        const end = width - .38 - (line === rules - 1 ? width * .23 : 0);
        for (let segment = 0; segment < 8; segment++) {
          for (const x of [.4 + (end - .4) * segment / 8, .4 + (end - .4) * (segment + 1) / 8]) rulePoints.push(x, pageHeightAt(x, width, z, height) + .02, z);
        }
      }
      const ruleGeometry = new THREE.BufferGeometry();
      ruleGeometry.setAttribute('position', new THREE.Float32BufferAttribute(rulePoints, 3));
      const rule = new THREE.LineSegments(ruleGeometry, new THREE.LineBasicMaterial({ color: '#b3b8bd', transparent: true, opacity: .22, depthWrite: false, toneMapped: false }));
      rule.raycast = () => {};
      group.add(rule);
      const marker = new THREE.Mesh(this.markerGeometry, new THREE.MeshBasicMaterial({ color: SILVER, transparent: true, opacity: .65, toneMapped: false }));
      marker.position.set(-2.18, base.y, 0);
      marker.raycast = () => {};
      const connector = new THREE.Line(new THREE.BufferGeometry().setFromPoints([marker.position, base]), new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: .36, depthWrite: false, toneMapped: false }));
      connector.raycast = () => {};
      this.folio.add(group, marker, connector);
      this.leaves.push({ section, group, base, mesh, edge, rule, marker, connector, value: 0, target: 0 });
    });
    if (count) {
      this.spine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-2.18, totalHeight / 2 + .3, 0), new THREE.Vector3(-2.18, -totalHeight / 2 - .3, 0)]), new THREE.LineBasicMaterial({ color: '#d1b68f', transparent: true, opacity: .54, depthWrite: false, toneMapped: false }));
      this.spine.name = 'README source order';
      this.spine.raycast = () => {};
      this.folio.add(this.spine);
    }
    if (!seen.has(this.selectedId)) this.selectedId = valid[0]?.id || null;
    for (const leaf of this.leaves) {
      leaf.target = leaf.section.id === this.selectedId ? 1 : 0;
      leaf.value = leaf.target;
      this._paint(leaf);
    }
    this.frame();
    requestRender();
  }

  setRepositoryStats(repository) {
    if (this.disposed) return;
    this.repositorySculptures?.dispose();
    this.repositorySculptures = repository ? createRepositorySculptures(repository) : null;
    if (this.repositorySculptures) this.group.add(this.repositorySculptures.group);
    this.frame();
    requestRender();
  }

  selectSection(id) {
    if (this.disposed || this.selectedId === id || !this.leaves.some(leaf => leaf.section.id === id)) return;
    this.selectedId = id;
    for (const leaf of this.leaves) {
      leaf.from = leaf.value;
      leaf.target = leaf.section.id === id ? 1 : 0;
    }
    this.transition = { elapsed: 0, duration: .42 };
    if (this.reducedMotion) this._finishTransition();
    requestRender(500);
  }

  _paint(leaf) {
    const active = leaf.value;
    const hovered = leaf.section.id === this.hoveredId;
    leaf.group.position.copy(leaf.base);
    leaf.group.position.x += active * .38;
    leaf.group.position.z += active * .52;
    leaf.mesh.material.color.set('#72839b').lerp(GOLD, active * .6);
    leaf.mesh.material.opacity = .13 + active * .23 + (hovered ? .07 : 0);
    leaf.edge.material.color.copy(SILVER).lerp(GOLD, Math.max(active, hovered ? .65 : 0));
    leaf.edge.material.opacity = .32 + active * .64 + (hovered ? .04 : 0);
    leaf.rule.material.opacity = .1 + active * .4 + (hovered ? .08 : 0);
    leaf.marker.material.color.copy(SILVER).lerp(GOLD, active);
    leaf.marker.scale.setScalar(1 + active * .5);
    leaf.connector.material.opacity = .21 + active * .6;
    const points = leaf.connector.geometry.attributes.position;
    points.setXYZ(1, leaf.group.position.x, leaf.group.position.y, leaf.group.position.z);
    points.needsUpdate = true;
    leaf.connector.geometry.computeBoundingSphere();
  }

  _finishTransition() {
    for (const leaf of this.leaves) { leaf.value = leaf.target; this._paint(leaf); }
    this.transition = null;
  }

  get animating() { return Boolean(this.transition); }

  update(dt = 0) {
    if (this.disposed || !this.transition) return;
    this.transition.elapsed += Math.max(0, Number(dt) || 0);
    const t = clamp(this.transition.elapsed / this.transition.duration, 0, 1);
    for (const leaf of this.leaves) {
      leaf.value = leaf.from + (leaf.target - leaf.from) * ease(t);
      this._paint(leaf);
    }
    if (t >= 1) this._finishTransition();
  }

  frame() {
    if (this.disposed) return;
    const bounds = this._projection();
    this.folio.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.folio);
    const direction = new THREE.Vector3(8, 8, 14).normalize();
    const right = new THREE.Vector3().crossVectors(this.camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const points = [];
    // Use actual curved sheets instead of the empty corners of their bounds.
    for (const leaf of this.leaves) {
      const positions = leaf.mesh.geometry.attributes.position;
      for (let index = 0; index < positions.count; index++) points.push(new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(leaf.mesh.matrixWorld));
    }
    const metrics = this.repositorySculptures;
    if (metrics) {
      const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
      let lowerEdge = points.length ? Infinity : 1.1;
      let upperEdge = points.length ? -Infinity : 1.1;
      for (const point of points) {
        const projected = point.clone().sub(center).dot(up);
        lowerEdge = Math.min(lowerEdge, projected);
        upperEdge = Math.max(upperEdge, projected);
      }
      // Spread the footer across the reserved viewport, even when a tall folio
      // makes each world unit tiny on a short screen. This leaves room for both
      // fixed-pixel labels without reducing their readability.
      const spacing = Math.max(1.38, (upperEdge - lowerEdge + 3) * bounds.width / bounds.height * .3);
      metrics.metrics.forEach((metric, index) => { metric.position.x = (index ? 1 : -1) * spacing; });
      metrics.group.position.copy(center).addScaledVector(up, lowerEdge - 1.25);
      metrics.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, direction));
      metrics.compact(bounds.width < 220 || bounds.height < 150);
      metrics.group.updateMatrixWorld(true);
      metrics.group.traverse(object => {
        const positions = object.geometry?.attributes.position;
        if (!positions) return;
        for (let index = 0; index < positions.count; index++) points.push(new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld));
      });
      for (const label of metrics.labels) box.expandByPoint(label.object.getWorldPosition(new THREE.Vector3()));
      for (const point of points) box.expandByPoint(point);
    }
    if (box.isEmpty()) { requestRender(); return; }
    const center = box.getCenter(new THREE.Vector3());
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const horizontalTangent = tangent * bounds.width / bounds.height;
    let distance = 1;
    // For each point, perspective fit requires d >= z + |x| / tan(horizontal).
    for (const point of points) {
      const relative = point.clone().sub(center);
      const projectedExtent = Math.max(Math.abs(relative.dot(right)) / horizontalTangent, Math.abs(relative.dot(up)) / tangent);
      distance = Math.max(distance, relative.dot(direction) + projectedExtent * 1.2);
    }
    // CSS labels keep their pixel size on small screens. Reserve that real
    // footprint, including before the renderer has attached/measured them.
    for (const label of metrics?.labels || []) {
      const relative = label.object.getWorldPosition(new THREE.Vector3()).sub(center);
      const fontSize = parseFloat(label.number.style.fontSize);
      const width = label.element.offsetWidth || Math.max(30, label.number.textContent.length * fontSize * .7);
      const height = label.element.offsetHeight || fontSize * 1.15 + parseFloat(label.caption.style.fontSize) * 1.15 + 1;
      const focal = bounds.height / (2 * tangent);
      const horizontal = Math.max(1, (bounds.width - width) / 2 - 8);
      const vertical = Math.max(1, bounds.height / 2 - (relative.dot(up) < 0 ? height : 0) - 8);
      distance = Math.max(distance, relative.dot(direction) + focal * Math.max(Math.abs(relative.dot(right)) / horizontal, Math.abs(relative.dot(up)) / vertical));
    }
    this.camera.zoom = 1;
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.lookAt(center);
    this.controls.target.copy(center);
    this.controls.minDistance = distance * .45;
    this.controls.maxDistance = distance * 2.5;
    this.controls.update();
    this._projection();
    requestRender();
  }

  _pick(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const bounds = this.bounds;
    if (bounds && (x < bounds.x || x > bounds.x + bounds.width || y < bounds.y || y > bounds.y + bounds.height)) return null;
    this.pointer.set(x / Math.max(rect.width, 1) * 2 - 1, -(y / Math.max(rect.height, 1)) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.folio.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.leaves.map(leaf => leaf.mesh), false)[0]?.object.userData.sectionId || null;
  }

  _hover(id, event) {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.canvas.style.cursor = id ? 'pointer' : 'grab';
    for (const leaf of this.leaves) this._paint(leaf);
    this.onHover(this.leaves.find(leaf => leaf.section.id === id)?.section || null, event);
    requestRender();
  }

  _bindPointer() {
    const on = (type, fn) => this.canvas.addEventListener(type, fn, { signal: this.lifetime.signal });
    on('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) { this.down = null; return; }
      this.down = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, sectionId: this._pick(event) };
    });
    on('pointermove', event => {
      if (this.down && Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5) this.down.moved = true;
      this._hover(event.buttons ? null : this._pick(event), event);
    });
    on('pointerup', event => {
      const down = this.down; this.down = null;
      if (!down || down.id !== event.pointerId || down.moved || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
      const id = this._pick(event);
      if (id && id === down.sectionId) { this.selectSection(id); this.onSelect(id); }
    });
    on('pointerleave', () => this._hover(null));
    on('pointercancel', () => { this.down = null; this._hover(null); });
  }

  _clearLeaves() {
    this.transition = null;
    this.down = null;
    this.hoveredId = null;
    const geometries = new Set(), materials = new Set();
    this.folio.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    if (this.markerGeometry && !geometries.has(this.markerGeometry)) this.markerGeometry.dispose();
    this.markerGeometry = null;
    this.spine = null;
    this.leaves = [];
    this.folio.clear();
    this.canvas.style.cursor = 'grab';
    this.onHover(null);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.motionPreference.removeEventListener('change', this.motionChange);
    this._clearLeaves();
    this.repositorySculptures?.dispose();
    this.repositorySculptures = null;
    this.scene.remove(this.group);
    this.scene.background = this.previousBackground;
    for (const [light, intensity] of this.baseLights) light.intensity = intensity;
    Object.assign(this.controls, this.previousControlSettings);
    if (this.previousView?.enabled) {
      const v = this.previousView;
      this.camera.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height);
    } else this.camera.clearViewOffset();
    this.canvas.style.cursor = this.previousCursor;
    if (this.previousAria === null) this.canvas.removeAttribute('aria-label');
    else this.canvas.setAttribute('aria-label', this.previousAria);
  }
}
