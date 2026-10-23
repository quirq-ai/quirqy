import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { placeRootLabels, placeReadableRootLabels, placeClassificationRootLabels } from './root-label-layout.js';
import { ROOT_ATTENTION_COLORS } from './root-attention.js';

const basename = path => String(path || '').split('/').filter(Boolean).pop() || '';
const finite = value => Number.isFinite(value);
const FILE_FONT = 11;
const FILE_LINE = 14;
const FONT_FAMILY = 'ui-monospace,SFMono-Regular,Consolas,monospace';
const ATTENTION_TEXT_COLORS = Object.fromEntries(Object.entries(ROOT_ATTENTION_COLORS)
  .map(([direction, color]) => [direction, `#${color.toString(16).padStart(6, '0')}`]));

/** Persistent screen-space names anchored to the real folder junctions and file ends. */
export class RootLabels {
  constructor(stage, group) {
    this.stage = stage;
    this.group = group;
    this.camera = stage.camera;
    this.records = [];
    this.files = [];
    this.folders = [];
    this.levels = [];
    this.projected = new THREE.Vector3();
    this.outward = new THREE.Vector3();
    this.presentationMode = 'organic';
    this.textMetrics = document.createElement('canvas').getContext('2d');
    this.enabled = false;
    this.focusMode = false;
    this.focusedPath = null;
    this.compact = false;
    this.signature = null;
    this.obstacles = [];
    this.disposed = false;
  }

  setPresentationMode(mode) {
    const next = mode === 'classification' ? 'classification' : 'organic';
    if (next === this.presentationMode) return;
    this.presentationMode = next;
    this.signature = null;
  }

  setFocusMode(enabled) {
    const next = Boolean(enabled);
    if (!next) this.setFocusFolder(null);
    if (next === this.focusMode) return;
    this.focusMode = next;
    for (const record of this.records) this._styleName(record);
    this.signature = null;
  }

  setFocusFolder(path) {
    const next = path || null;
    if (next === this.focusedPath) return;
    this.focusedPath = next;
    this.signature = null;
  }

  setLayout(folders, files) {
    this.clear();
    if (this.focusedPath && !folders.has(this.focusedPath)) this.setFocusFolder(null);
    for (const [path, source] of folders) {
      // The visible trunk already names the repository root.
      if (!path) continue;
      this.folders.push(this._add('folder', path, path, source));
    }
    for (const [id, source] of files) {
      this.files.push(this._add('file', id, source.node?.path || source.path, source));
    }
    this.signature = null;
  }

  _add(kind, key, path, source) {
    const anchor = document.createElement('div');
    anchor.className = `data-root-label data-root-${kind}-anchor`;
    anchor.style.cssText = 'width:0;height:0;pointer-events:none;overflow:visible;';
    anchor.setAttribute('aria-hidden', 'true');
    const element = document.createElement('span');
    element.className = `data-root-${kind}-name`;
    element.textContent = this._nameText(kind, path, source);
    element.title = path;
    element.style.cssText = 'position:absolute;display:block;white-space:pre;pointer-events:none;box-sizing:border-box;text-shadow:0 1px 3px #000,0 0 5px #000;background:rgba(1,3,10,.58);';
    element.style.fontFamily = FONT_FAMILY;
    anchor.append(element);
    const object = new CSS2DObject(anchor);
    object.center.set(0, 0);
    object.position.copy(source.position);
    object.visible = false;
    this.group.add(object);
    const record = {
      kind, key, path, source, object, element,
      target: kind === 'file' ? { kind, id: key, path, root: true } : { kind, path, root: true },
      x: 0, y: 0, visible: false,
      textWidth: 12,
      orientation: 'horizontal',
    };
    this._styleName(record);
    this.records.push(record);
    return record;
  }

  _nameText(kind, path, source) {
    const name = basename(path);
    if (kind !== 'folder' || this.presentationMode !== 'classification') return name;
    const count = Math.max(0, source.touchCount || 0);
    return `${name} · ${count} ${count === 1 ? 'edit' : 'edits'}`;
  }

  setLevels(levels = []) {
    for (const level of this.levels) { level.object.removeFromParent(); level.object.element.remove(); }
    this.levels = levels.map(source => {
      const element = document.createElement('span');
      element.className = 'data-root-level-name';
      element.textContent = `Level ${source.depth}`;
      element.setAttribute('aria-hidden', 'true');
      element.style.cssText = 'pointer-events:none;white-space:nowrap;color:#8c97aa;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.06em;text-shadow:0 1px 3px #000;';
      const object = new CSS2DObject(element);
      object.center.set(0, 0);
      object.position.fromArray(source.position);
      object.visible = false;
      this.group.add(object);
      return { source, object, width: 60 };
    });
    this.signature = null;
  }

  _placeLevels(width, height) {
    const overlaps = (a, b) => a.left < b.left + b.width + 3 && a.left + a.width + 3 > b.left
      && a.top < b.top + b.height + 3 && a.top + a.height + 3 > b.top;
    const occupied = [...this.obstacles, ...this.records.filter(record => record.visible && record.labelBounds).map(record => record.labelBounds)];
    for (const level of this.levels) {
      this.projected.copy(level.object.position).applyMatrix4(this.group.matrixWorld).project(this.camera);
      const x = (this.projected.x * 0.5 + 0.5) * width;
      const y = (-this.projected.y * 0.5 + 0.5) * height;
      const box = { left: x + 2, top: y - 18, width: level.width, height: 14 };
      level.object.visible = this.presentationMode === 'classification' && this.projected.z >= -1 && this.projected.z <= 1
        && box.left >= 4 && box.top >= 4 && box.left + box.width <= width - 4 && box.top + box.height <= height - 4
        && !occupied.some(other => overlaps(box, other));
      level.object.element.style.marginLeft = '2px';
      level.object.element.style.marginTop = '-18px';
      if (level.object.visible) occupied.push(box);
    }
  }

  _styleName(record) {
    const folder = record.kind === 'folder';
    const fontSize = folder ? (this.focusMode ? 13 : 12) : (this.focusMode && !this.compact ? 12 : FILE_FONT);
    record.lineHeight = folder ? 16 : FILE_LINE;
    record.boxHeight = record.lineHeight + 2;
    const style = record.element.style;
    style.fontSize = `${fontSize}px`;
    style.lineHeight = `${record.lineHeight}px`;
    style.fontWeight = folder ? '600' : '400';
    style.padding = folder ? '1px 3px' : '1px 2px';
    style.color = folder ? '#eadbc5' : '#d5dde7';
    style.writingMode = 'horizontal-tb';
    style.textOrientation = 'mixed';
    style.transform = 'none';
    style.borderRadius = '3px';
    style.border = 'none';
    style.background = folder ? 'rgba(6,10,17,.44)' : this.focusMode ? 'rgba(6,10,17,.3)' : 'rgba(6,10,17,.16)';
    style.textShadow = '0 1px 2px #000,0 0 3px rgba(0,0,0,.8)';
    style.overflow = 'hidden';
    style.textOverflow = 'ellipsis';
    record.element.dataset.orientation = 'horizontal';
    record.color = null;
    this.textMetrics.font = `${style.fontWeight} ${fontSize}px ${FONT_FAMILY}`;
    record.textWidth = Math.max(12, Math.ceil(this.textMetrics.measureText(record.element.textContent).width));
  }

  update({ visible = true, labels = true, hovered = null, selectedId = null } = {}) {
    if (this.disposed) return;
    this.enabled = Boolean(visible && labels);
    if (!this.enabled) {
      for (const record of this.records) { record.object.visible = false; record.visible = false; }
      for (const level of this.levels) level.object.visible = false;
      this.signature = null;
      return;
    }
    for (const record of this.records) {
      // In root focus, labels describe attention accumulated through this
      // commit. Keep every root in the scene, but never reveal an untouched
      // name via hover, selection, folder focus, or a later camera move.
      const activityVisible = this.presentationMode !== 'classification' || record.source.touchCount > 0;
      if (record.activityVisible !== activityVisible) {
        record.activityVisible = activityVisible;
        this.signature = null;
      }
      if (record.kind !== 'folder') continue;
      const text = this._nameText(record.kind, record.path, record.source);
      if (record.element.textContent === text) continue;
      record.element.textContent = text;
      this._styleName(record);
      this.signature = null;
    }
    this.camera.updateMatrixWorld();
    this.group.updateWorldMatrix(true, false);
    const canvas = this.stage.renderer.domElement;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const compact = width < 380;
    if (compact !== this.compact) {
      this.compact = compact;
      for (const record of this.records) this._styleName(record);
      this.signature = null;
    }
    this.obstacles = this._screenObstacles(width, height);
    const obstacleSignature = this.obstacles.map(box => `${box.left},${box.top},${box.width},${box.height}`).join(';');
    const signature = `${width}:${height}:${obstacleSignature}:${this.focusMode}:${this.presentationMode}:${this.focusedPath || ''}:${selectedId || ''}:${hovered?.kind || ''}:${hovered?.id || hovered?.path || ''}:${this.camera.matrixWorld.elements.join(',')}:${this.camera.projectionMatrix.elements.join(',')}:${this.group.matrixWorld.elements.join(',')}`;
    if (signature !== this.signature) {
      this.signature = signature;
      for (const record of this.records) {
        record.object.position.copy(record.source.position);
        this.projected.copy(record.source.position).applyMatrix4(this.group.matrixWorld).project(this.camera);
        record.x = (this.projected.x * 0.5 + 0.5) * width;
        record.y = (-this.projected.y * 0.5 + 0.5) * height;
        if (this.presentationMode === 'classification') {
          const direction = record.source.labelDirection ?? record.source.node?.labelDirection ?? [0, -1, 0];
          this.outward.copy(record.source.position);
          this.outward.x += direction[0];
          this.outward.y += direction[1];
          this.outward.z += direction[2];
          this.outward.applyMatrix4(this.group.matrixWorld).project(this.camera);
          record.directionX = (this.outward.x - this.projected.x) * width;
          record.directionY = -(this.outward.y - this.projected.y) * height;
        }
        const contextual = record.kind === 'folder' || this.focusMode || record.key === selectedId || (hovered?.kind === 'file' && record.key === hovered.id);
        // A name should not escape from a root that is itself behind the HUD.
        // Keep its persistent record so it reappears as soon as the tip is clear.
        record.occludedByHud = this.obstacles.some(box => record.x >= box.left && record.x <= box.left + box.width
          && record.y >= box.top && record.y <= box.top + box.height);
        record.visible = record.activityVisible && contextual && !record.occludedByHud && finite(record.x) && finite(record.y) && this.projected.z >= -1 && this.projected.z <= 1
          && record.x >= -10 && record.x <= width + 10 && record.y >= -10 && record.y <= height;
        record.object.visible = record.visible;
        const inFocusedFolder = this.focusMode && this.focusedPath
          && (record.path === this.focusedPath || record.path.startsWith(`${this.focusedPath}/`));
        // Reserve readable names for the folder the user is inspecting before
        // unrelated branches; selected and hovered files still take precedence.
        record.priority = record.key === selectedId || (record.kind === hovered?.kind && record.key === (hovered.id || hovered.path))
          ? 100 : inFocusedFolder ? 50 : 0;
      }
      this._placeNames(width, height);
      this._placeLevels(width, height);
    }
    for (const record of this.records) {
      const highlighted = record.kind === 'file'
        ? record.key === selectedId || (hovered?.kind === 'file' && record.key === hovered.id)
        : hovered?.kind === 'folder' && record.path === hovered.path;
      const classification = this.presentationMode === 'classification';
      const direction = record.source.attention?.direction;
      const attentionColor = classification && direction !== 'unknown' ? ATTENTION_TEXT_COLORS[direction] : null;
      // Labels share the root's byte direction, never its low baseline alpha.
      // Underlining selection preserves the meaning of green/red/yellow text.
      const color = attentionColor || (highlighted ? '#fff1cf' : record.kind === 'folder' ? '#eadbc5' : '#d5dde7');
      if (record.color !== color) { record.element.style.color = color; record.color = color; }
      const underline = classification && highlighted;
      if (record.underlined !== underline) {
        record.element.style.textDecoration = underline ? 'underline' : 'none';
        record.underlined = underline;
      }
    }
  }

  _screenObstacles(width, height) {
    const canvas = this.stage.renderer.domElement.getBoundingClientRect();
    const obstacles = [];
    const elements = ['topbar', 'data-timebar', 'data-guide', 'data-panel', 'data-guide-toggle', 'data-panel-toggle'].map(id => document.getElementById(id));
    elements.push(...document.querySelectorAll('.data-sun-credit:not([hidden]) .data-commit-bubble:not([hidden]), .data-sun-credit:not([hidden]) .data-sun-portrait, .data-sun-credit:not([hidden]) .data-sun-caption'));
    for (const element of elements) {
      if (!element || element.hidden) continue;
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left - canvas.left), top = Math.max(0, rect.top - canvas.top);
      const right = Math.min(width, rect.right - canvas.left), bottom = Math.min(height, rect.bottom - canvas.top);
      if (right <= left || bottom <= top) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      obstacles.push({ left, top, width: right - left, height: bottom - top });
    }
    return obstacles;
  }

  _placeNames(width, height) {
    const visible = this.records.filter(record => record.visible);
    const obstacles = this.obstacles;
    const placer = this.presentationMode === 'classification' ? placeClassificationRootLabels
      : this.files.length > 160 ? placeReadableRootLabels : placeRootLabels;
    const placements = placer(visible.map(record => ({
      key: `${record.kind}:${record.key}`, kind: record.kind, priority: record.priority,
      depth: record.path.split('/').length,
      row: record.source.row ?? record.source.node?.row,
      side: record.source.side ?? record.source.node?.side,
      directionX: record.directionX, directionY: record.directionY,
      parentPath: record.kind === 'file' ? record.path.slice(0, Math.max(0, record.path.lastIndexOf('/'))) : undefined,
      x: record.x, y: record.y, width: record.textWidth + (record.kind === 'folder' ? 6 : 4), height: record.boxHeight,
    })), { width, height, focusMode: this.focusMode, obstacles });
    for (const record of visible) {
      const box = placements.get(`${record.kind}:${record.key}`);
      if (!box) { record.visible = false; record.object.visible = false; record.labelBounds = null; continue; }
      record.labelTop = box.top - record.y;
      record.labelOffsetX = box.left - record.x;
      record.labelBounds = box;
      record.element.style.left = `${record.labelOffsetX}px`;
      record.element.style.top = `${record.labelTop}px`;
      record.element.style.width = `${box.width}px`;
      record.element.style.height = `${box.height}px`;
    }
  }

  get visibleFileCount() { return this.files.reduce((count, record) => count + Number(record.visible), 0); }

  hit(raycaster) {
    if (this.disposed || !this.enabled) return null;
    const projected = raycaster.ray.at(1, this.projected).project(this.camera);
    const canvas = this.stage.renderer.domElement.getBoundingClientRect();
    const x = canvas.left + (projected.x * 0.5 + 0.5) * canvas.width;
    const y = canvas.top + (-projected.y * 0.5 + 0.5) * canvas.height;
    for (const record of this.records) {
      if (!record.visible || !record.object.visible) continue;
      const box = record.element.getBoundingClientRect();
      if (box.width && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return { ...record.target, distance: 0 };
    }
    return null;
  }

  clear() {
    for (const record of this.records) { record.object.removeFromParent(); record.object.element.remove(); }
    this.records = []; this.files = []; this.folders = [];
    this.setLevels([]);
    this.signature = null;
  }

  dispose() {
    this.clear();
    this.enabled = false;
    this.disposed = true;
  }
}
