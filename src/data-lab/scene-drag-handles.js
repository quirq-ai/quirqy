/** Keep label clicks native; hand drags to the same controls as the canvas. */
export function bindSceneDragHandles(handles, controls, onNavigate = () => {}) {
  const canvas = controls.domElement;
  const lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  const pending = new Map();
  const active = new Set();
  const dragged = new WeakSet();
  const release = (element, id) => {
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
  };
  const promote = () => {
    for (const [id, { event: start, handle }] of pending) {
      // Delete first: losing capture is expected when the canvas takes over.
      pending.delete(id);
      if (controls.startOverlayDrag(start)) {
        active.add(id);
        dragged.add(handle);
        onNavigate();
      } else release(handle, id);
    }
  };
  for (const handle of handles) {
    handle.addEventListener('pointerdown', event => {
      if (!controls.enabled) return;
      dragged.delete(handle);
      pending.set(event.pointerId, { event: new PointerEvent('pointerdown', event), handle });
      handle.setPointerCapture(event.pointerId);
      if (pending.size + active.size > 1) promote();
    }, options);
    handle.addEventListener('pointermove', event => {
      const start = pending.get(event.pointerId)?.event;
      if (!start || Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) <= 5) return;
      promote();
      if (active.has(event.pointerId)) {
        event.preventDefault();
        canvas.dispatchEvent(new PointerEvent('pointermove', event));
      }
    }, options);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      handle.addEventListener(name, event => {
        pending.delete(event.pointerId);
        release(handle, event.pointerId);
      }, options);
    }
    handle.addEventListener('click', event => {
      if (event.detail === 0 || !dragged.has(handle)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { ...options, capture: true });
    handle.addEventListener('wheel', event => {
      event.preventDefault();
      canvas.dispatchEvent(new WheelEvent('wheel', event));
    }, { ...options, passive: false });
    handle.addEventListener('contextmenu', event => event.preventDefault(), options);
  }
  // Once promoted, native pointer capture keeps working even if the label moves.
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(name, event => active.delete(event.pointerId), options);
  }
  const cancel = () => {
    for (const [id, { handle }] of pending) release(handle, id);
    pending.clear();
    if (active.size) controls.stop();
    active.clear();
  };
  window.addEventListener('blur', cancel, options);
  return () => { lifetime.abort(); cancel(); };
}
