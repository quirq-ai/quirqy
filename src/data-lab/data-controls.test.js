import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { DataLabControls } from './data-controls.js';

// A small DOM event surface, with capture ordering and abort cleanup. The real
// Three controls receive the pointer events and update an actual camera.
class InputSurface {
  constructor() { this.listeners = []; this.signals = new Set(); this.style = {}; this.captures = new Set(); }
  addEventListener(type, callback, options = {}) {
    const capture = options === true || Boolean(options.capture);
    if (this.listeners.some(item => item.type === type && item.callback === callback && item.capture === capture)) return;
    this.listeners.push({ type, callback, capture, signal: options.signal });
    if (options.signal && !this.signals.has(options.signal)) {
      const signal = options.signal;
      this.signals.add(signal);
      signal.addEventListener('abort', () => { this.listeners = this.listeners.filter(item => item.signal !== signal); }, { once: true });
    }
  }
  removeEventListener(type, callback, options = {}) {
    const capture = options === true || Boolean(options.capture);
    this.listeners = this.listeners.filter(item => item.type !== type || item.callback !== callback || item.capture !== capture);
  }
  dispatchEvent(event) {
    event.target = this;
    const listeners = this.listeners.filter(item => item.type === event.type).sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const item of listeners) {
      if (event.stopped) break;
      if (this.listeners.includes(item)) item.callback(event);
    }
    return !event.defaultPrevented;
  }
  setPointerCapture(id) { this.captures.add(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  getRootNode() { return this.ownerDocument; }
}

class InputEvent {
  constructor(type, init = {}) {
    Object.assign(this, { type, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: 400, clientY: 300, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
      defaultPrevented: false, stopped: false }, init);
    this.pageX = this.clientX; this.pageY = this.clientY;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}

function fixture(t, distance = 24) {
  const previous = { window: globalThis.window, PointerEvent: globalThis.PointerEvent };
  const window = new InputSurface();
  window.pageXOffset = window.pageYOffset = 0;
  globalThis.window = window;
  globalThis.PointerEvent = InputEvent;
  const document = new InputSurface();
  document.documentElement = { clientLeft: 0, clientTop: 0 };
  const canvas = new InputSurface();
  canvas.clientWidth = 1200; canvas.clientHeight = 800; canvas.ownerDocument = document;
  const camera = new PerspectiveCamera(42, 1.5, .05, 8e6);
  camera.position.set(0, 0, distance);
  const controls = new DataLabControls(camera, canvas);
  controls.minDistance = 5; controls.maxDistance = 1e6;
  controls.enableDamping = false;
  const events = { start: 0, end: 0, change: 0 };
  for (const name of Object.keys(events)) controls.addEventListener(name, () => events[name]++);
  t.after(() => {
    controls.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const input = (type, init) => { const event = new InputEvent(type, init); canvas.dispatchEvent(event); return event; };
  const drag = (init = {}, delta = { x: 120, y: 60 }) => {
    input('pointerdown', init);
    input('pointermove', { ...init, clientX: (init.clientX ?? 400) + delta.x, clientY: (init.clientY ?? 300) + delta.y });
    controls.update();
    input('pointerup', { ...init, buttons: 0, clientX: (init.clientX ?? 400) + delta.x, clientY: (init.clientY ?? 300) + delta.y });
  };
  return { camera, controls, canvas, document, window, input, drag, events };
}

for (const distance of [5, 24, 650, 50000]) test(`roots primary drag pans the camera and target together at distance ${distance}`, t => {
  const { camera, controls, drag, events } = fixture(t, distance);
  controls.setRootMode(true);
  // Rolled inspection must still pan in the displayed screen plane.
  camera.up.set(.6, .8, 0); controls.update();
  const originalEye = camera.position.clone().sub(controls.target);
  const originalQuaternion = camera.quaternion.clone();
  const originalTarget = controls.target.clone();
  const originalPosition = camera.position.clone();
  drag();
  const delta = controls.target.clone().sub(originalTarget);
  assert.ok(delta.length() > distance * .1, 'primary drag must translate the focus target');
  assert.ok(camera.position.clone().sub(originalPosition).distanceTo(delta) < distance * 1e-12);
  assert.ok(camera.position.clone().sub(controls.target).distanceTo(originalEye) < distance * 1e-12);
  assert.ok(camera.quaternion.angleTo(originalQuaternion) < 1e-7, 'panning must not rotate or change zoom');
  // Repeated drags must not encounter a target clamp while browsing long roots.
  for (let i = 0; i < 12; i++) drag();
  assert.ok(controls.target.distanceTo(originalTarget) > distance);
  assert.equal(events.start, 13); assert.equal(events.end, 13);
});

test('Alt rotates freely, Shift rolls, and right drag remains pan in roots', t => {
  const { camera, controls, input, drag } = fixture(t);
  controls.setRootMode(true);
  const target = controls.target.clone(), eye = camera.position.clone().sub(target);
  input('pointerdown', { altKey: true });
  input('pointermove', { clientX: 540, clientY: 370, altKey: false });
  controls.update();
  input('pointerup', { clientX: 540, clientY: 370, buttons: 0 });
  assert.deepEqual(controls.target, target, 'releasing Alt mid-drag must not change the active rotation into pan');
  assert.ok(camera.position.clone().sub(target).distanceTo(eye) > 1);
  const position = camera.position.clone(), up = camera.up.clone();
  drag({ shiftKey: true }, { x: 150, y: 0 });
  assert.ok(camera.position.distanceTo(position) < 1e-10);
  assert.deepEqual(controls.target, target);
  assert.ok(camera.up.distanceTo(up) > .4, 'Shift must still provide sideways roll');
  const beforePan = camera.position.clone();
  drag({ button: 2, buttons: 2 });
  assert.ok(controls.target.distanceTo(target) > 1);
  assert.ok(camera.position.clone().sub(beforePan).distanceTo(controls.target.clone().sub(target)) < 1e-10);
  const ordinaryTarget = controls.target.clone();
  drag();
  assert.ok(controls.target.distanceTo(ordinaryTarget) > 1, 'the next unmodified gesture must return to pan');
});

test('filename overlay drags use the same root pan and suppress the following click', t => {
  const { camera, controls, input } = fixture(t);
  controls.setRootMode(true);
  const eye = camera.position.clone().sub(controls.target);
  assert.equal(controls.startOverlayDrag({ pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: 400, clientY: 300 }), true);
  input('pointermove', { pointerId: 7, clientX: 540, clientY: 360 }); controls.update();
  input('pointerup', { pointerId: 7, clientX: 540, clientY: 360, buttons: 0 });
  assert.ok(controls.target.length() > 1);
  assert.ok(camera.position.clone().sub(controls.target).distanceTo(eye) < 1e-10);
  assert.equal(input('click').defaultPrevented, true);
});

test('mode switches stop active drags, preserve normal orbit, and release all listeners', t => {
  const { camera, controls, canvas, document, window, input, drag } = fixture(t);
  const targetIdentity = controls.target;
  const normalTarget = controls.target.clone(), normalPosition = camera.position.clone();
  drag();
  assert.deepEqual(controls.target, normalTarget, 'ordinary view primary drag must remain orbit');
  assert.ok(camera.position.distanceTo(normalPosition) > 1);
  controls.setRootMode(true);
  input('pointerdown'); input('pointermove', { clientX: 550 });
  controls.setRootMode(false);
  const stopped = camera.position.clone();
  input('pointermove', { clientX: 600 }); input('pointerup', { clientX: 600, buttons: 0 }); controls.update();
  assert.ok(camera.position.distanceTo(stopped) < 1e-10, 'switching modes must discard pending root pan');
  assert.equal(controls.target, targetIdentity);
  assert.deepEqual(camera.up.toArray(), [0, 1, 0]);
  const listenerCount = canvas.listeners.length;
  for (let i = 0; i < 6; i++) { controls.setRootMode(true); controls.setRootMode(false); }
  assert.equal(canvas.listeners.length, listenerCount, 'switching views must not duplicate native input');
  controls.dispose();
  assert.equal(canvas.listeners.length, 0); assert.equal(document.listeners.length, 0); assert.equal(window.listeners.length, 0);
  assert.equal(canvas.captures.size, 0);
});

test('touch keeps single-finger rotation and two-finger pan, pinch, and twist', t => {
  const { camera, controls, input, drag } = fixture(t);
  controls.setRootMode(true);
  const original = camera.position.clone();
  drag({ pointerType: 'touch' }, { x: 90, y: 20 });
  assert.equal(controls.target.length(), 0);
  assert.ok(camera.position.distanceTo(original) > 1);
  const target = controls.target.clone();
  input('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 350, clientY: 300 });
  input('pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 450, clientY: 300 });
  const distance = camera.position.distanceTo(controls.target), up = camera.up.clone();
  input('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 390, clientY: 340 });
  input('pointermove', { pointerType: 'touch', pointerId: 3, clientX: 550, clientY: 360 });
  controls.update();
  assert.ok(controls.target.distanceTo(target) > 1, 'two fingers must continue to pan');
  assert.ok(camera.position.distanceTo(controls.target) < distance, 'pinch spread must continue to zoom');
  assert.ok(camera.up.distanceTo(up) > .05, 'two-finger twist must continue to roll');
  input('pointerup', { pointerType: 'touch', pointerId: 2, buttons: 0 });
  input('pointerup', { pointerType: 'touch', pointerId: 3, buttons: 0 });
  assert.ok([...camera.position, ...camera.up, ...controls.target].every(Number.isFinite));
});
