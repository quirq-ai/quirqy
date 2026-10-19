import { Quaternion, Vector3 } from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Internal state used by the pinned Three.js TrackballControls implementation.
const TOUCH_ZOOM_PAN = 4;

/** Upright orbit normally; unrestricted rotation only while inspecting roots. */
export class DataLabControls extends TrackballControls {
  constructor(camera, canvas) {
    super(camera, canvas);
    this.staticMoving = true;
    this.keys = [];
    this.rootMode = false;
    this.enableDamping = true;
    this.dampingFactor = 0.08;
    this.panSpeed = 1;
    // The controllers share a target and camera, but only one owns native input.
    super.disconnect();
    this.object.up.set(0, 1, 0);
    this._orbit = new OrbitControls(camera, canvas);
    this._orbit.target = this.target;
    this._forwardOrbitEvent = event => {
      if (!this.rootMode && !this._disposed) this.dispatchEvent({ type: event.type });
    };
    for (const name of ['start', 'end', 'change']) this._orbit.addEventListener(name, this._forwardOrbitEvent);
    this._syncOrbitOptions();
    this._rollAxis = new Vector3();
    this._rollQuaternion = new Quaternion();
    this._rollPointer = null;
    this._touchPoints = new Map();
    this._touchGesture = false;
    this._twistAngle = null;
    this._ignoredPointers = new Set();
    this._overlayPointers = new Set();
    this._suppressClickUntil = 0;
    this._lifetime = new AbortController();
    const options = { capture: true, signal: this._lifetime.signal };
    canvas.addEventListener('pointerdown', event => this._captureDown(event), options);
    canvas.addEventListener('pointermove', event => this._captureMove(event), options);
    canvas.addEventListener('pointerup', event => this._captureUp(event), options);
    canvas.addEventListener('pointercancel', event => this._captureCancel(event), options);
    canvas.addEventListener('wheel', () => this._syncOrbitOptions(), options);
    canvas.addEventListener('lostpointercapture', event => {
      if (this._overlayPointers.has(event.pointerId) || this._rollPointer?.id === event.pointerId || this._touchPoints.has(event.pointerId)) this.stop();
    }, options);
    for (const name of ['click', 'dblclick']) canvas.addEventListener(name, event => {
      if (performance.now() < this._suppressClickUntil) this._consume(event);
    }, options);
    window.addEventListener('resize', () => this.handleResize(), { signal: this._lifetime.signal });
    this._resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.handleResize()) : null;
    this._resizeObserver?.observe(canvas);
  }

  get enablePan() { return !this.noPan; }
  set enablePan(value) { this.noPan = !value; }
  get enableRotate() { return !this.noRotate; }
  set enableRotate(value) { this.noRotate = !value; }
  get enableZoom() { return !this.noZoom; }
  set enableZoom(value) { this.noZoom = !value; }

  /** Start an overlay drag without sending a pick/select event to the scene. */
  startOverlayDrag(event) {
    if (this._disposed || !this.enabled) return false;
    const down = new PointerEvent('pointerdown', event);
    this._captureDown(down);
    if (!down.defaultPrevented) {
      (this.rootMode ? this : this._orbit)._onPointerDown(down);
    }
    // Every touch needs capture, including a second finger starting on a label.
    this._capturePointer(event.pointerId);
    this._overlayPointers.add(event.pointerId);
    return true;
  }

  _syncOrbitOptions() {
    if (!this._orbit) return;
    for (const name of ['enabled', 'enablePan', 'enableRotate', 'enableZoom', 'minDistance', 'maxDistance',
      'minZoom', 'maxZoom', 'zoomSpeed', 'rotateSpeed', 'panSpeed', 'enableDamping', 'dampingFactor']) {
      this._orbit[name] = this[name];
    }
  }

  /** Keep the public controller and target identity stable across view changes. */
  setRootMode(enabled) {
    const next = Boolean(enabled);
    if (this._disposed || next === this.rootMode) return this;
    this.stop();
    if (next) {
      this._orbit.disconnect();
      this.rootMode = true;
      super.connect();
      // Data Lab owns keyboard commands, including S for a snapshot.
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      this.handleResize();
    } else {
      super.disconnect();
      this.rootMode = false;
      this.object.up.set(0, 1, 0);
      this._orbit._quat.identity();
      this._orbit._quatInverse.identity();
      this._orbit.connect();
      this._syncOrbitOptions();
    }
    this.update();
    return this;
  }

  update() {
    if (this._disposed) return;
    // Trackball's constructor calls update before the delegate exists.
    if (!this._orbit || this.rootMode) super.update();
    else {
      this._syncOrbitOptions();
      this._orbit.update();
    }
  }

  _consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  _capturePointer(id) {
    try { this.domElement.setPointerCapture(id); } catch { /* A cancelled pointer may already be inactive. */ }
  }

  _releasePointer(id) {
    try { if (this.domElement.hasPointerCapture(id)) this.domElement.releasePointerCapture(id); } catch { /* Already released by the browser. */ }
  }

  _angle() {
    if (this._touchPoints.size !== 2) return null;
    const [a, b] = this._touchPoints.values();
    // Coincident fingers have no orientation. Rebase when they separate.
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2) return null;
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  _roll(angle) {
    if (!this.rootMode || !this.enabled || this.noRotate || !Number.isFinite(angle) || angle === 0) return;
    this._rollAxis.subVectors(this.object.position, this.target);
    if (this._rollAxis.lengthSq() < 1e-12) return;
    this._rollQuaternion.setFromAxisAngle(this._rollAxis.normalize(), angle);
    this.object.up.applyQuaternion(this._rollQuaternion).normalize();
    this.object.lookAt(this.target);
    this.object.updateMatrixWorld();
    this.dispatchEvent({ type: 'change' });
  }

  _captureDown(event) {
    this._syncOrbitOptions();
    if (!this.enabled) return;
    this._ignoredPointers.delete(event.pointerId);
    if (!this.rootMode) return;
    if (event.pointerType === 'touch') {
      this._touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this._capturePointer(event.pointerId);
      this._twistAngle = this._angle();
      if (this._touchPoints.size > 1) {
        this._touchGesture = true;
        this._suppressClickUntil = performance.now() + 400;
        // Finish any pending single-finger rotation before pinch/pan/twist.
        this._movePrev.copy(this._moveCurr);
      }
      return;
    }
    if (event.button !== 0 || !event.shiftKey || this.noRotate) return;
    this.stop();
    this._rollPointer = { id: event.pointerId, x: event.clientX };
    this._capturePointer(event.pointerId);
    this._suppressClickUntil = performance.now() + 400;
    this.dispatchEvent({ type: 'start' });
    this._consume(event);
  }

  _captureMove(event) {
    if (this._ignoredPointers.has(event.pointerId)) { this._consume(event); return; }
    if (!this.rootMode) return;
    if (this._rollPointer?.id === event.pointerId) {
      const width = Math.max(1, this.domElement.clientWidth);
      this._roll((event.clientX - this._rollPointer.x) * 2 * Math.PI / width);
      this._rollPointer.x = event.clientX;
      this._consume(event);
      return;
    }
    if (event.pointerType !== 'touch' || !this._touchPoints.has(event.pointerId)) return;
    this._touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const angle = this._angle();
    if (angle !== null && this._twistAngle !== null) {
      const delta = angle - this._twistAngle;
      this._roll(Math.atan2(Math.sin(delta), Math.cos(delta)));
    }
    this._twistAngle = angle;
    // Native Trackball still receives this event for pinch zoom and pan.
  }

  _captureUp(event) {
    if (this._overlayPointers.delete(event.pointerId)) this._suppressClickUntil = performance.now() + 400;
    if (this._ignoredPointers.delete(event.pointerId)) { this._consume(event); return; }
    if (!this.rootMode) return;
    if (this._rollPointer?.id === event.pointerId) {
      this._rollPointer = null;
      this._releasePointer(event.pointerId);
      this._suppressClickUntil = performance.now() + 400;
      this.dispatchEvent({ type: 'end' });
      this._consume(event);
      return;
    }
    if (event.pointerType !== 'touch' || !this._touchPoints.has(event.pointerId)) return;
    const gesture = this._touchGesture;
    this._touchPoints.delete(event.pointerId);
    this._twistAngle = this._angle();
    if (!this._touchPoints.size) this._touchGesture = false;
    if (gesture) {
      // Let native controls finish once, then prevent this gesture selecting a
      // file through the scene's pointerup listener or synthetic double-click.
      this._onPointerUp(event);
      this._suppressClickUntil = performance.now() + 400;
      this._consume(event);
    }
    this._releasePointer(event.pointerId);
  }

  _captureCancel(event) {
    if (this._overlayPointers.delete(event.pointerId)) this._suppressClickUntil = performance.now() + 400;
    if (this._rollPointer?.id === event.pointerId || this._touchPoints.has(event.pointerId)
      || this._pointers.some(pointer => pointer.pointerId === event.pointerId)) {
      this.stop();
      this._ignoredPointers.delete(event.pointerId);
      this._consume(event);
    }
  }

  _zoomCamera() {
    // Trackball's native two-finger ratio is undefined for coincident fingers.
    // Keep this pose and start a fresh ratio once they separate again.
    if (this.state === TOUCH_ZOOM_PAN && (!(this._touchZoomDistanceStart > 0) || !(this._touchZoomDistanceEnd > 0))) {
      this._touchZoomDistanceStart = this._touchZoomDistanceEnd;
      return;
    }
    super._zoomCamera();
  }

  /** Discard pending input before an explicit frame/reset or external camera move. */
  stop() {
    const pointers = new Set([...this._pointers.map(pointer => pointer.pointerId), ...this._touchPoints.keys(), ...(this._orbit?._pointers || [])]);
    if (this._rollPointer) pointers.add(this._rollPointer.id);
    const active = pointers.size > 0;
    this._rollPointer = null;
    this._overlayPointers.clear();
    this._touchPoints.clear();
    this._touchGesture = false;
    this._twistAngle = null;
    this._pointers.length = 0;
    this._pointerPositions = {};
    this.state = this.keyState = -1;
    this._lastAngle = 0;
    this._movePrev.copy(this._moveCurr);
    this._zoomStart.copy(this._zoomEnd);
    this._panStart.copy(this._panEnd);
    this._touchZoomDistanceStart = this._touchZoomDistanceEnd = 1;
    this.domElement.removeEventListener('pointermove', this._onPointerMove);
    this.domElement.removeEventListener('pointerup', this._onPointerUp);
    if (this._orbit) {
      const orbit = this._orbit;
      orbit.state = -1;
      orbit._pointers.length = 0;
      orbit._pointerPositions = {};
      orbit._sphericalDelta.set(0, 0, 0);
      orbit._panOffset.set(0, 0, 0);
      orbit._scale = 1;
      orbit._performCursorZoom = false;
      orbit._controlActive = false;
      this.domElement.removeEventListener('pointermove', orbit._onPointerMove);
      this.domElement.removeEventListener('pointerup', orbit._onPointerUp);
      this.domElement.getRootNode().removeEventListener('keyup', orbit._interceptControlUp, { capture: true });
    }
    for (const id of pointers) {
      this._ignoredPointers.add(id);
      this._releasePointer(id);
    }
    if (active) {
      this._suppressClickUntil = performance.now() + 400;
      this.dispatchEvent({ type: 'end' });
    }
  }

  reset() {
    this.stop();
    super.reset();
    this.update();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._lifetime.abort();
    this._resizeObserver?.disconnect();
    this.stop();
    for (const name of ['start', 'end', 'change']) this._orbit.removeEventListener(name, this._forwardOrbitEvent);
    this._orbit.dispose();
    super.dispose();
  }
}
