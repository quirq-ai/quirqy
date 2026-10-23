import * as THREE from 'three';
import { createRootLayout } from './root-layout.js';
import { createRootClassificationLayout } from './root-classification-layout.js';
import { createRootLengthLayout } from './root-length-layout.js';
import { buildRootActivityHistory, rootActivityAt, rootMembershipKey } from './root-activity.js';
import { buildRootAttentionHistory, rootAttentionAt, ROOT_ATTENTION_COLORS } from './root-attention.js';
import { RootLabels } from './root-labels.js';
import { ROOT_VINE_RADIUS, ROOT_ROPE_PITCH, rootRopeRadius, createRootRopeBatch, setRootRopeShape, setRootRopeColor, finishRootRopeUpdate } from './root-rope-geometry.js';
import { CHANGE_COLORS, FOLDER_COLORS } from './encoding.js';

const asVector = point => new THREE.Vector3(...point);
const toSet = value => value instanceof Set ? value : new Set(value || []);
const makeCurve = points => new THREE.CubicBezierCurve3(...points.map(asVector));
const STRAND_COLOR = new THREE.Color(0xb0926f);
const SELECTED_COLOR = new THREE.Color(0xe1eefc);
export const ROOT_NEUTRAL_ALPHA = 0.18;
const highlightedAlpha = 0.65;
const ease = value => value * value * (3 - 2 * value);
const curvePoints = curve => [curve.v0, curve.v1, curve.v2, curve.v3];
// Two twisted strands give the roots a natural surface. Their count does not
// encode activity: added length is the quantitative signal, caliber is subtle.
const ROPE_PACKING = 1;
const naturalCaliber = (baseLength, addedLength) => (1 + Math.max(0, addedLength) / Math.max(16, baseLength || 0)) ** 0.12;
const growthCounts = (layout, activity) => ({
  fileTouches: new Map(layout.nodes.map(node => [node.id, activity.fileTouches.get(node.id) || 0])),
  folderTouches: new Map(layout.folders.map(folder => [folder.path, activity.folderTouches.get(folder.path) || 0])),
});

// Reserve historical names and the largest count suffix once. A rename or
// another commit must not silently change the meaning of a hierarchy lane.
function classificationLabelWidths(model, maximumActivity) {
  const widths = new Map();
  const reserve = (key, text) => {
    const pixels = [...text].reduce((sum, glyph) => sum + (/[^\x00-\x7f]/.test(glyph) ? 13 : 8), 8);
    widths.set(key, Math.max(widths.get(key) || 0, pixels / 4));
  };
  const include = (path, id) => {
    if (typeof path !== 'string' || path.split('/').some(part => part.startsWith('.'))) return;
    const parts = path.split('/');
    reserve(`file:${id}`, parts.at(-1));
    for (let depth = 1; depth < parts.length; depth++) {
      const folder = parts.slice(0, depth).join('/');
      reserve(`folder:${folder}`, `${parts[depth - 1]} · ${maximumActivity.folderTouches.get(folder) || 0} touches`);
    }
  };
  for (const node of model.nodes) for (const path of new Set([node.path, ...(node.aliases || [])])) include(path, node.id);
  for (const snapshot of model._snapshots || []) for (const [path, id] of snapshot) include(path, id);
  return widths;
}

/** Each file touch adds a fixed length; folder junctions stay rooted in place. */
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
    this.presentationMode = 'organic';
    this.attentionHistory = this.attentionState = null;
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

  setPresentationMode(mode) {
    const next = mode === 'classification' ? 'classification' : 'organic';
    this.labels.setPresentationMode(next);
    if (next === this.presentationMode) return false;
    this.presentationMode = next;
    this.signature = null;
    if (this.model) this.setFrame({
      activeIds: this.activeIds, paths: this.currentPaths, changedIds: this.changedIds,
      statuses: this.statuses, selectedId: this.selectedId, index: this.index, animate: false,
    });
    return true;
  }

  setModel(model) {
    this._clear();
    this.model = model;
    this.labels.setFocusFolder(null);
    // Calibrate once from the head snapshot: replay must never change the
    // physical meaning of a touch as files are added, removed, or renamed.
    this.repositoryWidth = createRootLayout(model).footprint.width;
    this.activityHistory = buildRootActivityHistory(model);
    this.attentionHistory = buildRootAttentionHistory(model);
    this.maximumActivity = rootActivityAt(this.activityHistory, model.commits.length - 1);
    const unionLayout = createRootLayout(model, { activeIds: new Set(model.nodes.map(node => node.id)), repositoryWidth: this.repositoryWidth });
    const labelWidths = classificationLabelWidths(model, this.maximumActivity);
    const classification = createRootClassificationLayout(unionLayout, { labelWidths });
    this.classificationCalibration = {
      // At a representative 900px reading pane, width/40 leaves roughly 22px
      // between folder levels. Calibrate once from the whole loaded history;
      // local lanes, exact attention increments and replay cannot change it.
      tierPitch: Math.max(classification.classification.tierPitch, classification.footprint.width / 40),
      lanePitch: classification.classification.lanePitch,
      labelWidths,
      referenceWidth: classification.footprint.width,
    };
    this.selectedId = null; this.hovered = null;
    this.signature = null; this.index = null;
    this.surface = this.surfaceDisplay = null;
    this.surfaceSignature = null;
    this.setFrame({ activeIds: new Set(model.nodes.filter(node => node.existsAtHead !== false).map(node => node.id)), index: model.commits.length - 1, animate: false });
  }

  setFrame({ activeIds, visibleIds, paths = {}, changedIds, statuses = {}, selectedId, index, duration = 1.6, animate = false } = {}) {
    if (!this.model || this.disposed) return;
    if (!animate) this._settleGrowth();
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
      const organic = createRootLayout(this.model, { activeIds: active, paths: currentPaths, groundY: -40, repositoryWidth: this.repositoryWidth });
      this.baseLayout = this.presentationMode === 'classification' ? createRootClassificationLayout(organic, this.classificationCalibration) : organic;
      this._build(this.baseLayout, previousShapes);
    }
    this.index = nextIndex;
    this.activityState = rootActivityAt(this.activityHistory, nextIndex);
    this.attentionState = rootAttentionAt(this.attentionHistory, nextIndex);
    const canAnimate = Boolean(animate && adjacent && this.options.activity && !this.motionPreference?.matches);
    if (layoutChanged || previousIndex !== nextIndex) {
      this.pathGrowth = growthCounts(this.baseLayout, this.activityState);
      this.growthLayout = createRootLengthLayout(this.baseLayout, { fileTouches: this.pathGrowth.fileTouches });
      this.layout = this.growthLayout;
      this.bounds.set(asVector(this.layout.bounds.min), asVector(this.layout.bounds.max));
      // Geometry and ground never react to the camera. Zoom only changes which
      // labels have room; activity length remains stable at every viewing angle.
      this.surface = this.surfaceDisplay = { ...this.layout.base, height: 0, active: false };
      const targets = new Map([
        ...this.layout.folders.map(folder => [`folder:${folder.path}`, folder]),
        ...this.layout.nodes.map(node => [`membership:${rootMembershipKey(node.folder, node.id)}`, node]),
      ]);
      // Parents precede children so a new strand can begin at its moving junction.
      const ordered = [...this.strands].sort((a, b) => (a.kind === 'file' ? a.node.depth : a.depth) - (b.kind === 'file' ? b.node.depth : b.depth));
      this.orderedStrands = ordered;
      let hasTransition = false;
      for (const record of ordered) {
        const target = targets.get(record.edgeKey);
        const previous = previousShapes?.get(record.edgeKey);
        record.touchCount = (record.kind === 'file' ? this.pathGrowth.fileTouches.get(record.node.id) : this.pathGrowth.folderTouches.get(record.path)) || 0;
        record.baseLength = target.baseLength || 0;
        record.addedLength = target.addedLength || 0;
        record.lengthPerTouch = this.layout.lengthGrowth.lengthPerTouch;
        record.lengthTarget = target.length ?? makeCurve(target.curve).getLength();
        record.radiusTarget = rootRopeRadius(ROPE_PACKING, naturalCaliber(record.baseLength, record.addedLength));
        record.touchesFrom = previous?.touches ?? record.displayTouches ?? 0;
        record.vineCountTarget = ROPE_PACKING + 1;
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
    const colorFor = path => new THREE.Color(layout.kind === 'classification' ? ROOT_ATTENTION_COLORS.unknown : FOLDER_COLORS[Math.max(0, topPaths.indexOf(path.split('/')[0])) % FOLDER_COLORS.length]);
    // Future counts reserve buffer capacity only. The displayed pose still uses
    // the selected history prefix in setFrame; untouched roots stay untouched.
    const capacityLayout = createRootLengthLayout(layout, { fileTouches: this.maximumActivity.fileTouches });
    const folderLengths = new Map(capacityLayout.folders.map(folder => [folder.path, makeCurve(folder.curve).getLength()]));
    const fileLengths = new Map(capacityLayout.nodes.map(node => [node.id, makeCurve(node.curve).getLength()]));
    if (previousShapes?.size) {
      // Membership changes can reflow the base hierarchy. Reserve the surviving
      // edge's old pose too, so the transition never exceeds its geometry budget.
      for (const [records, lengths, key, edgeKey] of [
        [layout.folders, folderLengths, 'path', record => `folder:${record.path}`],
        [layout.nodes, fileLengths, 'id', record => `membership:${rootMembershipKey(record.folder, record.id)}`],
      ]) for (const record of records) {
        const previous = previousShapes.get(edgeKey(record));
        if (previous) lengths.set(record[key], Math.max(lengths.get(record[key]) || 0,
          new THREE.CubicBezierCurve3(...previous.points).getLength()));
      }
    }
    const classification = layout.kind === 'classification';
    const folderEdges = [], fileEdges = [];
    for (const folder of layout.folders) {
      const color = colorFor(folder.path);
      const record = { ...folder, kind: 'folder', visible: true, position: asVector(folder.position), color, strandColor: layout.kind === 'classification' ? color.clone() : STRAND_COLOR.clone().lerp(color, 0.35), curve: makeCurve(folder.curve), edgeKey: `folder:${folder.path}`, touchCount: 0, radius: ROOT_VINE_RADIUS, radiusTarget: ROOT_VINE_RADIUS };
      this.folders.set(folder.path, record);
      // The existing trunk is the sole repository root; folders are junctions.
      if (folder.path) folderEdges.push({ key: folder.path, curve: record.curve, color: record.strandColor, touches: ROPE_PACKING, maxTouches: ROPE_PACKING, maxLength: folderLengths.get(folder.path) });
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
        const color = layout.kind === 'classification' ? new THREE.Color(ROOT_ATTENTION_COLORS.unknown) : STRAND_COLOR.clone().lerp(folder.color, 0.4);
        const curve = makeCurve(node.curve);
        const membershipKey = rootMembershipKey(node.folder, node.id);
        fileEdges.push({ key: node.id, curve, color, touches: ROPE_PACKING, maxTouches: ROPE_PACKING, maxLength: fileLengths.get(node.id) });
        matrix.makeTranslation(position.x, position.y, position.z);
        this.tipPicks.setMatrixAt(index, matrix);
        this.tipIds.push(node.id);
        this.files.set(node.id, { kind: 'file', node, visible: true, position, color, strandColor: color.clone(), curve, folder, instanceIndex: index, membershipKey, edgeKey: `membership:${membershipKey}`, touchCount: 0, radius: ROOT_VINE_RADIUS, radiusTarget: ROOT_VINE_RADIUS });
      }
      this.tipPicks.computeBoundingSphere();
      this.group.add(this.tipPicks); this.pickables.push(this.tipPicks);
    }
    if (layout.kind === 'classification') for (const edge of [...folderEdges, ...fileEdges]) {
      const budgetLength = Math.max(edge.curve.getLength() * 2, edge.maxLength || 0) + rootRopeRadius(ROPE_PACKING) * 4;
      edge.pitch = Math.max(ROOT_ROPE_PITCH, budgetLength * 12 / 256);
      edge.segments = Math.min(256, Math.max(16, Math.ceil(budgetLength * 12 / edge.pitch)));
    }
    this.folderBatch = createRootRopeBatch(folderEdges, { vertexAlpha: classification });
    this.fileBatch = createRootRopeBatch(fileEdges, { pointed: true, vertexAlpha: classification });
    const material = () => new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.83, metalness: 0.02, emissive: 0x392a1a, emissiveIntensity: 0.1, transparent: classification, depthWrite: !classification });
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
    // A faint centerline preserves the hierarchy at overview zoom; two fine
    // spiraling strands give the length-driven roots a natural surface.
    const linePositions = [], lineColors = [];
    for (const record of this.strands) {
      const points = record.curve.getPoints(20);
      record.centerlineRange = { vertexStart: linePositions.length / 3, vertexCount: 40, color: record.strandColor.clone(), alpha: 1 };
      for (let index = 1; index < points.length; index++) {
        linePositions.push(...points[index - 1].toArray(), ...points[index].toArray());
        for (let end = 0; end < 2; end++) {
          lineColors.push(record.strandColor.r, record.strandColor.g, record.strandColor.b);
          if (classification) lineColors.push(1);
        }
      }
    }
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    lineGeometry.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, classification ? 4 : 3));
    this.centerlines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: classification ? 1 : 0.38, depthWrite: false }));
    this.group.add(this.centerlines);
    this.selectionTrace = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xc9dce9, transparent: true, opacity: 0.72, depthWrite: false, depthTest: false }));
    this.selectionTrace.visible = false; this.selectionTrace.renderOrder = 2;
    this.group.add(this.selectionTrace);
    this._buildLevelGuides(layout);
    this.labels.setPresentationMode(this.presentationMode);
    this.labels.setLayout(this.folders, this.files);
    this.labels.setLevels?.(this.levels);
    this.labelWidths = new Map(this.labels.files.map(record => [record.key, record.textWidth]));
    this.surfaceSignature = null;
    this.group.visible = this.options.roots;
    if (this.hovered?.kind === 'file' && !this.files.has(this.hovered.id)) this.hovered = null;
    if (this.hovered?.kind === 'folder' && !this.folders.has(this.hovered.path)) this.hovered = null;
  }

  _buildLevelGuides(layout) {
    this.levels = [];
    if (layout.kind !== 'classification' || layout.classification?.orientation !== 'down') return;
    const positions = [...layout.folders, ...layout.nodes].map(record => record.position[0]);
    const xMin = Math.min(0, ...positions) - 4, xMax = Math.max(0, ...positions) + 4;
    const folderDepths = new Set(layout.folders.map(folder => folder.depth));
    const vertices = [];
    for (const level of layout.classification.levels || []) {
      if (!level.depth || !folderDepths.has(level.depth)) continue;
      const position = [xMin, level.y, -1.2];
      this.levels.push({ ...level, xMin, xMax, position });
      vertices.push(...position, xMax, level.y, -1.2);
    }
    if (!vertices.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    this.levelGuides = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x74849a, transparent: true, opacity: .11, depthWrite: false }));
    this.levelGuides.name = 'Repository depth guides';
    this.levelGuides.renderOrder = -1;
    // Guides explain depth only; they are never folders, index entries or picks.
    this.group.add(this.levelGuides);
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
    let moved = false;
    for (let i = 0; i < 4; i++) {
      if (!points[i].equals(source[i])) moved = true;
      points[i].copy(source[i]);
    }
    const parent = record.kind === 'file' ? record.folder : this.folders.get(record.parent);
    record.ropeStartDistance = parent?.ropeEndDistance || 0;
    // Preserve the inherited helix phase when a long classification connector
    // uses a different decorative pitch. Equal-pitch organic roots are unchanged.
    if (parent?.range && parent.range.pitch !== record.range.pitch) record.ropeStartDistance *= record.range.pitch / parent.range.pitch;
    const addedLength = record.kind === 'file' ? record.displayTouches * record.lengthPerTouch : 0;
    record.radialScale = naturalCaliber(record.baseLength, addedLength);
    setRootRopeShape(record.batch, record.range, record.curve, ROPE_PACKING, record.ropeStartDistance, record.radialScale);
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

  _settleGrowth() {
    if (!this.transition) return;
    for (const record of this.transition.records) this._setShape(record, 1);
    this.transition = null; this._finishGeometry();
  }

  setFocusFolder(path) {
    this.labels.setFocusFolder(path);
    this._updateColors();
  }

  _updateColors() {
    const classification = this.presentationMode === 'classification';
    const focus = classification ? this.labels.focusedPath : null;
    const inFocus = path => !focus || path === focus || path.startsWith(`${focus}/`);
    const color = new THREE.Color();
    for (const [id, record] of this.files) {
      record.attention = this.attentionState?.files.get(id) || null;
      if (classification) {
        // This is persistent data, independent of the transient Commit effects
        // toggle. Unknown comparisons replace a prior hue instead of guessing.
        color.setHex(ROOT_ATTENTION_COLORS[record.attention?.direction || 'unknown']);
      } else {
        color.copy(record.strandColor);
        if (this.options.activity && this.changedIds.has(id)) color.lerp(new THREE.Color(CHANGE_COLORS[this.statuses[id]] || CHANGE_COLORS.modified), 0.8);
      }
      const highlighted = id === this.selectedId || this.hovered?.id === id;
      record.alpha = classification && (!record.attention || record.attention.direction === 'unknown') ? highlighted ? highlightedAlpha : ROOT_NEUTRAL_ALPHA : 1;
      if (highlighted) color.lerp(SELECTED_COLOR, classification ? 0.12 : 0.75);
      else if (!inFocus(record.node.folder)) color.multiplyScalar(.13);
      setRootRopeColor(this.fileBatch, record.range, color, record.alpha);
      this._setCenterlineColor(record, color, record.alpha);
    }
    for (const folder of this.folders.values()) {
      folder.attention = this.attentionState?.folders?.get(folder.path) || null;
      const highlighted = this.hovered?.kind === 'folder' && this.hovered.path === folder.path;
      folder.alpha = classification && (!folder.attention || folder.attention.direction === 'unknown') ? highlighted ? highlightedAlpha : ROOT_NEUTRAL_ALPHA : 1;
      if (!folder.range) continue;
      if (classification) color.setHex(ROOT_ATTENTION_COLORS[folder.attention?.direction || 'unknown']);
      else {
        color.copy(folder.strandColor);
        if (this.options.activity && this.activityState?.touchedFolders.has(folder.path)) color.lerp(new THREE.Color(CHANGE_COLORS.modified), 0.28);
      }
      if (highlighted) color.lerp(SELECTED_COLOR, classification ? 0.12 : 0.5);
      else if (!inFocus(folder.path) && !focus?.startsWith(`${folder.path}/`)) color.multiplyScalar(.13);
      setRootRopeColor(this.folderBatch, folder.range, color, folder.alpha);
      this._setCenterlineColor(folder, color, folder.alpha);
    }
    this._finishGeometry();
    if (this.underlayColorDirty) { this.centerlines.geometry.attributes.color.needsUpdate = true; this.underlayColorDirty = false; }
  }

  _setCenterlineColor(record, color, alpha = 1) {
    const range = record.centerlineRange;
    if (!range) return;
    const attribute = this.centerlines.geometry.attributes.color, stride = attribute.itemSize;
    const opacity = stride === 4 ? alpha : 1;
    if (range.color.equals(color) && range.alpha === opacity) return;
    const colors = attribute.array;
    for (let index = range.vertexStart * stride; index < (range.vertexStart + range.vertexCount) * stride; index += stride) {
      colors[index] = color.r; colors[index + 1] = color.g; colors[index + 2] = color.b;
      if (stride === 4) colors[index + 3] = opacity;
    }
    range.color.copy(color); range.alpha = opacity;
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
    if (!this.options.activity) this._settleGrowth();
    this._updateColors();
  }

  update(dt = 0) {
    if (this.disposed || !this.layout) return;
    if (this.transition) {
      if (this.motionPreference?.matches || !this.options.activity) this._settleGrowth();
      else {
        this.transition.elapsed = Math.min(this.transition.duration, this.transition.elapsed + Math.max(0, Number(dt) || 0));
        const amount = ease(this.transition.elapsed / this.transition.duration);
        for (const record of this.transition.records) this._setShape(record, amount);
        if (this.transition.elapsed >= this.transition.duration) this.transition = null;
        this._finishGeometry();
      }
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
    this.folderBatch = this.fileBatch = this.tipPicks = this.branchMesh = this.filamentMesh = this.selectionTrace = this.centerlines = this.levelGuides = null;
    this.levels = [];
    this.tipIds = []; this.transition = null; this.underlayColorDirty = false; this.shapeDirty = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this._clear(); this.labels.dispose();
    this.group.removeFromParent();
    this.layout = this.baseLayout = this.growthLayout = this.surface = this.surfaceDisplay = this.labelWidths = this.surfaceCrowding = this.model = this.bounds = this.attentionHistory = this.attentionState = this.activityHistory = this.maximumActivity = this.activityState = this.pathGrowth = this.classificationCalibration = null;
  }
}
