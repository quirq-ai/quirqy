import * as THREE from 'three';
import { createRootLayout } from './root-layout.js';
import { createRootWarpLayout } from './root-warp.js';
import { MAX_ROOT_SURFACE_HEIGHT, createRootSurface, measureRootSurfaceCrowding, rootSurfaceHeight, rootSurfaceGradient, applyRootSurface } from './root-surface.js';
import { buildRootActivityHistory, rootActivityAt, rootMembershipKey, rootPathGrowth } from './root-activity.js';
import { RootLabels } from './root-labels.js';
import { ROOT_VINE_RADIUS, rootRopeRadius, createRootRopeBatch, setRootRopeShape, setRootRopeColor, finishRootRopeUpdate } from './root-rope-geometry.js';
import { CHANGE_COLORS, FOLDER_COLORS } from './encoding.js';

const asVector = point => new THREE.Vector3(...point);
const toSet = value => value instanceof Set ? value : new Set(value || []);
const makeCurve = points => new THREE.CubicBezierCurve3(...points.map(asVector));
const STRAND_COLOR = new THREE.Color(0xb0926f);
const SELECTED_COLOR = new THREE.Color(0xe1eefc);
const ease = value => value * value * (3 - 2 * value);
const curvePoints = curve => [curve.v0, curve.v1, curve.v2, curve.v3];

/** File activity grows the whole ancestral route; flexible roots make room around it. */
export class RepositoryRoots {
  constructor(stage) {
    this.stage = stage;
    this.camera = stage.camera;
    this.group = new THREE.Group();
    this.group.name = 'Data Lab · Repository roots';
    stage.scene.add(this.group);
    this.labels = new RootLabels(stage, this.group);
    this.files = new Map(); this.folders = new Map();
    this.options = { roots: true, labels: true, activity: true };
    this.selectedId = null; this.hovered = null;
    this.changedIds = new Set(); this.statuses = {};
    this.folderFaces = []; this.fileFaces = []; this.pickables = [];
    this.signature = null; this.index = null; this.transition = null;
    this.surface = this.surfaceDisplay = null;
    this.surfaceSignature = null;
    this.disposed = false;
    this.motionPreference = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  }

  get labelRecords() { return this.labels.records; }

  setModel(model) {
    this._clear();
    this.model = model;
    this.activityHistory = buildRootActivityHistory(model);
    this.maximumActivity = rootActivityAt(this.activityHistory, model.commits.length - 1);
    this.selectedId = null; this.hovered = null;
    this.signature = null; this.index = null;
    this.surface = this.surfaceDisplay = null;
    this.surfaceSignature = null;
    this.setFrame({ activeIds: new Set(model.nodes.filter(node => node.existsAtHead !== false).map(node => node.id)), index: model.commits.length - 1, animate: false });
  }

  setFrame({ activeIds, visibleIds, paths = {}, changedIds, statuses = {}, selectedId, index, duration = 1.6, animate = false } = {}) {
    if (!this.model || this.disposed) return;
    if (!animate) this._settleThickness();
    const active = toSet(activeIds ?? visibleIds ?? this.activeIds);
    const currentPaths = paths instanceof Map ? Object.fromEntries(paths) : paths;
    const nextIndex = Number.isFinite(index) ? Math.floor(index) : this.index ?? this.model.commits.length - 1;
    const previousIndex = this.index;
    const adjacent = previousIndex !== null && nextIndex === previousIndex + 1;
    this.activeIds = active; this.currentPaths = currentPaths;
    this.changedIds = toSet(changedIds);
    this.statuses = statuses instanceof Map ? Object.fromEntries(statuses) : statuses;
    if (selectedId !== undefined) this.selectedId = selectedId;
    const signature = JSON.stringify(this.model.nodes.filter(node => active.has(node.id))
      .map(node => [node.id, currentPaths[node.id] ?? node.path]).sort(([a], [b]) => a.localeCompare(b)));
    const layoutChanged = signature !== this.signature;
    const previousShapes = layoutChanged && animate
      ? new Map(this.strands.map(record => [record.edgeKey, { touches: record.displayTouches ?? record.touchCount, points: record.growthCurrent.map(point => point.clone()) }]))
      : null;
    if (layoutChanged) {
      this.signature = signature;
      this.baseLayout = createRootLayout(this.model, { activeIds: active, paths: currentPaths, groundY: -40 });
      this._build(this.baseLayout, previousShapes);
    }
    this.index = nextIndex;
    this.activityState = rootActivityAt(this.activityHistory, nextIndex);
    const canAnimate = Boolean(animate && adjacent && this.options.activity && !this.motionPreference?.matches);
    if (layoutChanged || previousIndex !== nextIndex) {
      this.pathGrowth = rootPathGrowth(this.baseLayout, this.activityState);
      const fileRadii = new Map([...this.pathGrowth.fileTouches].map(([key, touches]) => [key, rootRopeRadius(touches)]));
      const folderRadii = new Map([...this.pathGrowth.folderTouches].map(([key, touches]) => [key, rootRopeRadius(touches)]));
      this.growthLayout = createRootWarpLayout(this.baseLayout, { fileRadii, folderRadii, baseRadius: ROOT_VINE_RADIUS, compact: true });
      this._refreshSurface(true, !canAnimate);
      this._updateSurfaceLayout();
      // Commit targets remain unbent. Responsive presentation is applied only
      // when rendering, so resizing cannot advance or restart a growing vine.
      const warped = this.growthLayout;
      const targets = new Map([
        ...warped.folders.map(folder => [`folder:${folder.path}`, folder]),
        ...warped.nodes.map(node => [`membership:${rootMembershipKey(node.folder, node.id)}`, node]),
      ]);
      // Parents precede children so a new strand can begin at its moving junction.
      const ordered = [...this.strands].sort((a, b) => (a.kind === 'file' ? a.node.depth : a.depth) - (b.kind === 'file' ? b.node.depth : b.depth));
      this.orderedStrands = ordered;
      let hasTransition = false;
      for (const record of ordered) {
        const target = targets.get(record.edgeKey);
        const previous = previousShapes?.get(record.edgeKey);
        record.touchCount = (record.kind === 'file' ? this.pathGrowth.fileTouches.get(record.node.id) : this.pathGrowth.folderTouches.get(record.path)) || 0;
        record.radiusTarget = rootRopeRadius(record.touchCount);
        record.touchesFrom = previous?.touches ?? record.displayTouches ?? 0;
        record.vineCountTarget = record.touchCount + 1;
        record.growthTarget = target.curve.map(asVector);
        record.growthFrom = previous?.points || (record.growthCurrent || curvePoints(record.curve)).map(point => point.clone());
        if (canAnimate && layoutChanged && !previous) {
          const parent = record.kind === 'file' ? record.folder : this.folders.get(record.parent);
          const origin = parent?.growthFrom?.[3] || parent?.position || record.curve.v0;
          record.growthFrom = Array.from({ length: 4 }, () => origin.clone());
        }
        const changed = record.touchesFrom !== record.touchCount || record.growthFrom.some((point, i) => !point.equals(record.growthTarget[i]));
        if (canAnimate && changed) { this._setShape(record, 0); hasTransition = true; }
        else this._setShape(record, 1);
      }
      const root = this.folders.get('');
      if (root) root.touchCount = this.pathGrowth.folderTouches.get('') || 0;
      this.transition = hasTransition ? { elapsed: 0, duration: Math.max(0.08, Number(duration) || 1.6), records: ordered } : null;
    }
    this._finishGeometry();
    this._updateColors(); this._updateSelection();
  }

  _build(layout, previousShapes) {
    this._clear();
    this.layout = layout;
    this.bounds = new THREE.Box3(asVector(layout.bounds.min), asVector(layout.bounds.max));
    this.renderedCount = layout.nodes.length;
    const topPaths = layout.folders.filter(folder => folder.depth === 1).map(folder => folder.path).sort();
    const colorFor = path => new THREE.Color(FOLDER_COLORS[Math.max(0, topPaths.indexOf(path.split('/')[0])) % FOLDER_COLORS.length]);
    // Future counts reserve buffer capacity only. The displayed pose still uses
    // the selected history prefix in setFrame; untouched roots stay untouched.
    const maximumGrowth = rootPathGrowth(layout, this.maximumActivity);
    const capacityGrowthLayout = createRootWarpLayout(layout, {
      fileRadii: new Map([...maximumGrowth.fileTouches].map(([id, touches]) => [id, rootRopeRadius(touches)])),
      folderRadii: new Map([...maximumGrowth.folderTouches].map(([path, touches]) => [path, rootRopeRadius(touches)])),
      baseRadius: ROOT_VINE_RADIUS, compact: true,
    });
    const maximumSurface = createRootSurface(layout, { height: MAX_ROOT_SURFACE_HEIGHT });
    const capacityLayout = applyRootSurface(capacityGrowthLayout, maximumSurface);
    const folderLengths = new Map(capacityLayout.folders.map((folder, i) => [folder.path, Math.max(makeCurve(folder.curve).getLength(), makeCurve(capacityGrowthLayout.folders[i].curve).getLength())]));
    const fileLengths = new Map(capacityLayout.nodes.map((node, i) => [node.id, Math.max(makeCurve(node.curve).getLength(), makeCurve(capacityGrowthLayout.nodes[i].curve).getLength())]));
    if (previousShapes?.size) {
      // A hierarchy change can replace a wide fan with a compact grid. Surviving
      // strands still animate from their old pose, which may be longer than any
      // target pose; reserve that pose at both responsive surface extremes too.
      const previousRecord = (record, key) => {
        const previous = previousShapes.get(key);
        if (!previous) return record;
        const curve = previous.points.map(point => point.toArray());
        return { ...record, curve, points: curve, position: [...curve[3]] };
      };
      const previousLayout = {
        ...layout,
        folders: layout.folders.map(folder => previousRecord(folder, `folder:${folder.path}`)),
        nodes: layout.nodes.map(node => previousRecord(node, `membership:${rootMembershipKey(node.folder, node.id)}`)),
      };
      const previousBentLayout = applyRootSurface(previousLayout, maximumSurface);
      for (const [records, bentRecords, lengths, key] of [
        [previousLayout.folders, previousBentLayout.folders, folderLengths, 'path'],
        [previousLayout.nodes, previousBentLayout.nodes, fileLengths, 'id'],
      ]) for (let index = 0; index < records.length; index++) {
        const record = records[index];
        lengths.set(record[key], Math.max(lengths.get(record[key]) || 0,
          makeCurve(record.curve).getLength(), makeCurve(bentRecords[index].curve).getLength()));
      }
    }
    const folderEdges = [], fileEdges = [];
    for (const folder of layout.folders) {
      const color = colorFor(folder.path);
      const record = { ...folder, kind: 'folder', visible: true, position: asVector(folder.position), color, strandColor: STRAND_COLOR.clone().lerp(color, 0.35), curve: makeCurve(folder.curve), edgeKey: `folder:${folder.path}`, touchCount: 0, radius: ROOT_VINE_RADIUS, radiusTarget: ROOT_VINE_RADIUS };
      this.folders.set(folder.path, record);
      // The existing trunk is the sole repository root; folders are junctions.
      if (folder.path) folderEdges.push({ key: folder.path, curve: record.curve, color: record.strandColor, touches: 0, maxTouches: this.maximumActivity.folderTouches.get(folder.path) || 0, maxLength: folderLengths.get(folder.path) });
    }
    const count = layout.nodes.length;
    if (count) {
      // These volumes only support picking; file ends have no visible node mesh.
      this.tipPicks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.8, 1), new THREE.MeshBasicMaterial({ visible: false }), count);
      const matrix = new THREE.Matrix4();
      for (let index = 0; index < count; index++) {
        const node = layout.nodes[index];
        const position = asVector(node.position);
        const folder = this.folders.get(node.folder);
        const color = STRAND_COLOR.clone().lerp(folder.color, 0.4);
        const curve = makeCurve(node.curve);
        const membershipKey = rootMembershipKey(node.folder, node.id);
        fileEdges.push({ key: node.id, curve, color, touches: 0, maxTouches: this.maximumActivity.membershipTouches.get(membershipKey) || 0, maxLength: fileLengths.get(node.id) });
        matrix.makeTranslation(position.x, position.y, position.z);
        this.tipPicks.setMatrixAt(index, matrix);
        this.tipIds.push(node.id);
        this.files.set(node.id, { kind: 'file', node, visible: true, position, color, strandColor: color.clone(), curve, folder, instanceIndex: index, membershipKey, edgeKey: `membership:${membershipKey}`, touchCount: 0, radius: ROOT_VINE_RADIUS, radiusTarget: ROOT_VINE_RADIUS });
      }
      this.tipPicks.computeBoundingSphere();
      this.group.add(this.tipPicks); this.pickables.push(this.tipPicks);
    }
    this.folderBatch = createRootRopeBatch(folderEdges);
    this.fileBatch = createRootRopeBatch(fileEdges, { pointed: true });
    const material = () => new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.83, metalness: 0.02, emissive: 0x392a1a, emissiveIntensity: 0.1 });
    this.strands = [];
    if (this.folderBatch) {
      this.branchMesh = new THREE.Mesh(this.folderBatch.geometry, material());
      this.group.add(this.branchMesh); this.pickables.push(this.branchMesh);
      for (const [path, range] of this.folderBatch.ranges) {
        const record = this.folders.get(path);
        record.range = range; record.batch = this.folderBatch;
        this.folderFaces.push({ first: range.faceStart, end: range.faceEnd, path });
        this.strands.push(record);
      }
    }
    if (this.fileBatch) {
      this.filamentMesh = new THREE.Mesh(this.fileBatch.geometry, material());
      this.group.add(this.filamentMesh); this.pickables.push(this.filamentMesh);
      for (const [id, range] of this.fileBatch.ranges) {
        const record = this.files.get(id);
        record.range = range; record.batch = this.fileBatch;
        this.fileFaces.push({ first: range.faceStart, end: range.faceEnd, id });
        this.strands.push(record);
      }
    }
    // A faint centerline preserves the hierarchy at overview zoom; individual
    // three-dimensional vines form the visible rope as activity accumulates.
    const linePositions = [], lineColors = [];
    for (const record of this.strands) {
      const points = record.curve.getPoints(20);
      record.centerlineRange = { vertexStart: linePositions.length / 3, vertexCount: 40, color: record.strandColor.clone() };
      for (let index = 1; index < points.length; index++) {
        linePositions.push(...points[index - 1].toArray(), ...points[index].toArray());
        for (let end = 0; end < 2; end++) lineColors.push(record.strandColor.r, record.strandColor.g, record.strandColor.b);
      }
    }
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    lineGeometry.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
    this.centerlines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.38, depthWrite: false }));
    this.group.add(this.centerlines);
    this.selectionTrace = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xc9dce9, transparent: true, opacity: 0.72, depthWrite: false, depthTest: false }));
    this.selectionTrace.visible = false; this.selectionTrace.renderOrder = 2;
    this.group.add(this.selectionTrace);
    this.labels.setLayout(this.folders, this.files);
    this.labelWidths = new Map(this.labels.files.map(record => [record.key, record.textWidth]));
    this.surfaceSignature = null;
    this.group.visible = this.options.roots;
    if (this.hovered?.kind === 'file' && !this.files.has(this.hovered.id)) this.hovered = null;
    if (this.hovered?.kind === 'folder' && !this.folders.has(this.hovered.path)) this.hovered = null;
  }

  _setShape(record, amount) {
    record.growthCurrent ||= Array.from({ length: 4 }, () => new THREE.Vector3());
    for (let i = 0; i < 4; i++) {
      if (amount === 1) record.growthCurrent[i].copy(record.growthTarget[i]);
      else record.growthCurrent[i].lerpVectors(record.growthFrom[i], record.growthTarget[i], amount);
    }
    record.displayTouches = amount === 1 ? record.touchCount : record.touchesFrom + (record.touchCount - record.touchesFrom) * amount;
    this._renderShape(record);
  }

  _renderShape(record) {
    const source = record.growthCurrent, points = curvePoints(record.curve);
    if (!source) return;
    const surface = this.surfaceDisplay;
    const start = source[0], end = source[3];
    const startDrop = rootSurfaceHeight(surface, start.x, start.z);
    const endDrop = rootSurfaceHeight(surface, end.x, end.z);
    const [startX, startZ] = rootSurfaceGradient(surface, start.x, start.z);
    const [endX, endZ] = rootSurfaceGradient(surface, end.x, end.z);
    let moved = false;
    for (let i = 0; i < 4; i++) {
      const point = source[i];
      // Transform endpoint tangents with the same Jacobian as the ground.
      const drop = i === 0 ? startDrop : i === 3 ? endDrop : i === 1
        ? startDrop + startX * (point.x - start.x) + startZ * (point.z - start.z)
        : endDrop + endX * (point.x - end.x) + endZ * (point.z - end.z);
      const y = point.y + drop;
      if (points[i].x !== point.x || points[i].y !== y || points[i].z !== point.z) moved = true;
      points[i].set(point.x, y, point.z);
    }
    const parent = record.kind === 'file' ? record.folder : this.folders.get(record.parent);
    record.ropeStartDistance = parent?.ropeEndDistance || 0;
    setRootRopeShape(record.batch, record.range, record.curve, record.displayTouches, record.ropeStartDistance);
    record.ropeEndDistance = record.ropeStartDistance + record.curve.getLength();
    record.radius = record.range.radius;
    record.vineCount = record.range.vineCount;
    if (!moved) return;
    record.position.copy(record.curve.v3);
    const positions = this.centerlines.geometry.attributes.position.array;
    let offset = record.centerlineRange.vertexStart * 3;
    const samples = record.curve.getPoints(20);
    for (let i = 1; i < samples.length; i++) {
      samples[i - 1].toArray(positions, offset); offset += 3;
      samples[i].toArray(positions, offset); offset += 3;
    }
    if (record.kind === 'file') {
      this.pickMatrix ||= new THREE.Matrix4();
      this.pickMatrix.makeTranslation(record.position.x, record.position.y, record.position.z);
      this.tipPicks.setMatrixAt(record.instanceIndex, this.pickMatrix);
    }
    this.shapeDirty = true;
  }

  _finishGeometry() {
    finishRootRopeUpdate(this.folderBatch); finishRootRopeUpdate(this.fileBatch);
    if (!this.shapeDirty) return;
    this.centerlines.geometry.attributes.position.needsUpdate = true;
    this.centerlines.geometry.computeBoundingSphere();
    if (this.tipPicks) {
      this.tipPicks.instanceMatrix.needsUpdate = true;
      this.tipPicks.computeBoundingSphere();
    }
    this.labels.signature = null;
    this._updateSelection();
    this.shapeDirty = false;
  }

  _settleThickness() {
    if (!this.transition) return;
    for (const record of this.transition.records) this._setShape(record, 1);
    this.transition = null; this._finishGeometry();
  }

  _updateColors() {
    const color = new THREE.Color();
    for (const [id, record] of this.files) {
      color.copy(record.strandColor);
      if (this.options.activity && this.changedIds.has(id)) color.lerp(new THREE.Color(CHANGE_COLORS[this.statuses[id]] || CHANGE_COLORS.modified), 0.8);
      if (id === this.selectedId || this.hovered?.id === id) color.lerp(SELECTED_COLOR, 0.75);
      setRootRopeColor(this.fileBatch, record.range, color);
      this._setCenterlineColor(record, color);
    }
    for (const folder of this.folders.values()) {
      if (!folder.range) continue;
      color.copy(folder.strandColor);
      if (this.options.activity && this.activityState?.touchedFolders.has(folder.path)) color.lerp(new THREE.Color(CHANGE_COLORS.modified), 0.28);
      if (this.hovered?.kind === 'folder' && this.hovered.path === folder.path) color.lerp(SELECTED_COLOR, 0.5);
      setRootRopeColor(this.folderBatch, folder.range, color);
      this._setCenterlineColor(folder, color);
    }
    this._finishGeometry();
    if (this.underlayColorDirty) { this.centerlines.geometry.attributes.color.needsUpdate = true; this.underlayColorDirty = false; }
  }

  _setCenterlineColor(record, color) {
    const range = record.centerlineRange;
    if (!range || range.color.equals(color)) return;
    const colors = this.centerlines.geometry.attributes.color.array;
    for (let index = range.vertexStart * 3; index < (range.vertexStart + range.vertexCount) * 3; index += 3) { colors[index] = color.r; colors[index + 1] = color.g; colors[index + 2] = color.b; }
    range.color.copy(color);
    this.underlayColorDirty = true;
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
    const geometry = this.selectionTrace.geometry;
    const attribute = geometry.attributes.position;
    if (attribute?.array.length === positions.length) {
      attribute.array.set(positions);
      attribute.needsUpdate = true;
    } else geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (positions.length) geometry.computeBoundingSphere();
    this.selectionTrace.visible = positions.length > 0;
  }

  select(id) { if (id !== this.selectedId) { this.selectedId = id || null; this._updateColors(); this._updateSelection(); } }
  setHovered(hit) {
    const next = hit?.root ? hit : null;
    if (next?.kind === this.hovered?.kind && next?.id === this.hovered?.id && next?.path === this.hovered?.path) return;
    this.hovered = next; this._updateColors();
  }

  setOptions(options = {}) {
    Object.assign(this.options, options);
    this.group.visible = this.options.roots !== false;
    if (!this.group.visible) this.hovered = null;
    if (!this.options.activity) this._settleThickness();
    this._updateColors();
  }

  _refreshSurface(force = false, immediate = false) {
    if (!this.growthLayout) return false;
    this.camera.updateMatrixWorld();
    this.group.updateWorldMatrix(true, false);
    const canvas = this.stage.renderer.domElement;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const signature = `${width}:${height}:${this.labels.compact}:${this.camera.matrixWorld.elements.join(',')}:${this.camera.projectionMatrix.elements.join(',')}:${this.group.matrixWorld.elements.join(',')}`;
    if (!force && signature === this.surfaceSignature) return false;
    this.surfaceSignature = signature;
    // Responsive labels can change their measured width after a resize.
    this.labelWidths = new Map(this.labels.files.map(record => [record.key, record.textWidth]));
    this.surfaceProjection ||= new THREE.Vector3();
    // Always probe the unbent data pose. Measuring the already bent roots would
    // make curvature feed back into its own crowding estimate while orbiting.
    const points = (this.labels.focusMode ? this.growthLayout.nodes : []).map(node => {
      const projected = this.surfaceProjection.fromArray(node.position).applyMatrix4(this.group.matrixWorld).project(this.camera);
      return { id: node.id, x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height,
        visible: projected.z >= -1 && projected.z <= 1, textWidth: this.labelWidths.get(node.id) || 70 };
    }).filter(point => point.visible);
    this.surfaceCrowding = measureRootSurfaceCrowding(points, { width, height, labelOrientation: 'horizontal' });
    this.surface = createRootSurface(this.baseLayout, { viewportWidth: width, crowding: this.surfaceCrowding });
    if (!this.surfaceDisplay || immediate || this.motionPreference?.matches) {
      const changed = this.surfaceDisplay?.height !== this.surface.height;
      this.surfaceDisplay = this.surface;
      return changed;
    }
    return false;
  }

  _advanceSurface(dt) {
    if (!this.surface || !this.surfaceDisplay) return false;
    const from = this.surfaceDisplay.height, target = this.surface.height;
    if (from === target) return false;
    const amount = this.motionPreference?.matches ? 1 : 1 - Math.exp(-Math.max(0, Number(dt) || 0) * 12);
    let height = from + (target - from) * amount;
    if (Math.abs(height - target) < .01) height = target;
    if (height === from) return false;
    this.surfaceDisplay = { ...this.surface, height };
    return true;
  }

  _updateSurfaceLayout() {
    this.layout = applyRootSurface(this.growthLayout, this.surfaceDisplay);
    this.bounds.set(asVector(this.layout.bounds.min), asVector(this.layout.bounds.max));
  }

  update(dt = 0) {
    if (this.disposed || !this.layout) return;
    const refreshed = this._refreshSurface();
    const advanced = this._advanceSurface(dt);
    const surfaceChanged = refreshed || advanced;
    if (surfaceChanged) this._updateSurfaceLayout();
    if (this.transition) {
      if (this.motionPreference?.matches || !this.options.activity) this._settleThickness();
      else {
        this.transition.elapsed = Math.min(this.transition.duration, this.transition.elapsed + Math.max(0, Number(dt) || 0));
        const amount = ease(this.transition.elapsed / this.transition.duration);
        for (const record of this.transition.records) this._setShape(record, amount);
        if (this.transition.elapsed >= this.transition.duration) this.transition = null;
        this._finishGeometry();
      }
    } else if (surfaceChanged) {
      for (const record of this.orderedStrands || []) this._renderShape(record);
      this._finishGeometry();
    }
    this.labels.update({ visible: this.options.roots, labels: this.options.labels, hovered: this.hovered, selectedId: this.selectedId });
  }

  hit(raycaster) {
    if (this.disposed || !this.group.visible) return null;
    this.group.updateWorldMatrix(true, true);
    const labelHit = this.options.labels && this.labels.hit(raycaster);
    if (labelHit) return labelHit;
    for (const hit of raycaster.intersectObjects(this.pickables, false)) {
      if (hit.object === this.tipPicks) {
        const id = this.tipIds[hit.instanceId];
        const file = this.files.get(id);
        if (file) return { kind: 'file', id, path: file.node.path, root: true, distance: hit.distance };
      } else if (hit.object === this.branchMesh) {
        const folder = this.folderFaces.find(range => hit.faceIndex >= range.first && hit.faceIndex < range.end);
        if (folder) return { kind: 'folder', path: folder.path, root: true, distance: hit.distance };
      } else if (hit.object === this.filamentMesh) {
        const file = this.fileFaces.find(range => hit.faceIndex >= range.first && hit.faceIndex < range.end);
        if (file) return { kind: 'file', id: file.id, path: this.files.get(file.id).node.path, root: true, distance: hit.distance };
      }
    }
    return null;
  }

  getNodePosition(id) {
    const position = this.files.get(id)?.position.clone();
    return position ? this.group.localToWorld(position) : null;
  }
  getBounds() {
    const bounds = this.bounds?.clone() || new THREE.Box3(new THREE.Vector3(0, -40, 0), new THREE.Vector3(0, -40, 0));
    for (const batch of [this.folderBatch, this.fileBatch]) if (batch?.geometry.boundingBox) bounds.union(batch.geometry.boundingBox);
    return bounds;
  }

  getFolderBounds(path = '') {
    const folder = this.folders.get(path);
    if (!folder) return null;
    const bounds = new THREE.Box3().expandByPoint(folder.position);
    const addStrand = record => {
      const edgeBounds = new THREE.Box3().setFromPoints([record.curve.v0, record.curve.v1, record.curve.v2, record.curve.v3]);
      bounds.union(edgeBounds.expandByScalar(record.radius || ROOT_VINE_RADIUS));
    };
    for (const file of this.files.values()) if (!path || file.node.folder === path || file.node.folder.startsWith(`${path}/`)) addStrand(file);
    for (const record of this.folders.values()) if (record.range && (!path || record.path.startsWith(`${path}/`))) addStrand(record);
    return bounds.expandByScalar(Math.max(2.5, folder.radius || ROOT_VINE_RADIUS));
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
    this.labels.clear();
    const disposed = new Set();
    this.group.traverse(object => {
      if (object.isInstancedMesh) object.dispose();
      for (const item of [object.geometry, ...(Array.isArray(object.material) ? object.material : [object.material])]) {
        if (item && !disposed.has(item)) { item.dispose(); disposed.add(item); }
      }
    });
    this.group.clear(); this.files.clear(); this.folders.clear();
    this.folderFaces = []; this.fileFaces = []; this.pickables = []; this.strands = []; this.orderedStrands = [];
    this.folderBatch = this.fileBatch = this.tipPicks = this.branchMesh = this.filamentMesh = this.selectionTrace = this.centerlines = null;
    this.tipIds = []; this.transition = null; this.underlayColorDirty = false; this.shapeDirty = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this._clear(); this.labels.dispose();
    this.group.removeFromParent();
    this.layout = this.baseLayout = this.growthLayout = this.surface = this.surfaceDisplay = this.labelWidths = this.surfaceCrowding = this.model = this.bounds = this.activityHistory = this.maximumActivity = this.activityState = this.pathGrowth = null;
  }
}
