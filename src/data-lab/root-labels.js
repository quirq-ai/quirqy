import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { placeRootLabels, placeReadableRootLabels } from './root-label-layout.js';

const basename = path => String(path || '').split('/').filter(Boolean).pop() || '';
const finite = value => Number.isFinite(value);
const FILE_FONT = 11;
const FILE_LINE = 14;
const FONT_FAMILY = 'ui-monospace,SFMono-Regular,Consolas,monospace';

/** Persistent screen-space names anchored to the real folder junctions and file ends. */
export class RootLabels {
  constructor(stage, group) {
    this.stage = stage;
    this.group = group;
    this.camera = stage.camera;
    this.records = [];
    this.files = [];
    this.folders = [];
    this.projected = new THREE.Vector3();
    this.textMetrics = document.createElement('canvas').getContext('2d');
    this.enabled = false;
    this.focusMode = false;
    this.compact = false;
    this.signature = null;
    this.obstacles = [];
    this.disposed = false;
  }

  setFocusMode(enabled) {
    const next = Boolean(enabled);
    if (next === this.focusMode) return;
    this.focusMode = next;
    for (const record of this.records) this._styleName(record);
    this.signature = null;
  }

  setLayout(folders, files) {
    this.clear();
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
    element.textContent = basename(path);
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
      this.signature = null;
      return;
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
    const signature = `${width}:${height}:${obstacleSignature}:${this.focusMode}:${selectedId || ''}:${hovered?.kind || ''}:${hovered?.id || hovered?.path || ''}:${this.camera.matrixWorld.elements.join(',')}:${this.camera.projectionMatrix.elements.join(',')}:${this.group.matrixWorld.elements.join(',')}`;
    if (signature !== this.signature) {
      this.signature = signature;
      for (const record of this.records) {
        record.object.position.copy(record.source.position);
        this.projected.copy(record.source.position).applyMatrix4(this.group.matrixWorld).project(this.camera);
        record.x = (this.projected.x * 0.5 + 0.5) * width;
        record.y = (-this.projected.y * 0.5 + 0.5) * height;
        const contextual = record.kind === 'folder' || this.focusMode || record.key === selectedId || (hovered?.kind === 'file' && record.key === hovered.id);
        // A name should not escape from a root that is itself behind the HUD.
        // Keep its persistent record so it reappears as soon as the tip is clear.
        record.occludedByHud = this.obstacles.some(box => record.x >= box.left && record.x <= box.left + box.width
          && record.y >= box.top && record.y <= box.top + box.height);
        record.visible = contextual && !record.occludedByHud && finite(record.x) && finite(record.y) && this.projected.z >= -1 && this.projected.z <= 1
          && record.x >= -10 && record.x <= width + 10 && record.y >= -10 && record.y <= height;
        record.object.visible = record.visible;
        record.priority = record.key === selectedId || (record.kind === hovered?.kind && record.key === (hovered.id || hovered.path)) ? 100 : 0;
      }
      this._placeNames(width, height);
    }
    for (const record of this.records) {
      const highlighted = record.kind === 'file'
        ? record.key === selectedId || (hovered?.kind === 'file' && record.key === hovered.id)
        : hovered?.kind === 'folder' && record.path === hovered.path;
      const color = highlighted ? '#fff1cf' : record.kind === 'folder' ? '#eadbc5' : '#d5dde7';
      if (record.color !== color) { record.element.style.color = color; record.color = color; }
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
    const placer = this.files.length > 160 ? placeReadableRootLabels : placeRootLabels;
    const placements = placer(visible.map(record => ({
      key: `${record.kind}:${record.key}`, kind: record.kind, priority: record.priority,
      depth: record.path.split('/').length,
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
    this.signature = null;
  }

  dispose() {
    this.clear();
    this.enabled = false;
    this.disposed = true;
  }
}
