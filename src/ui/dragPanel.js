// Panels keep their CSS layout until moved. Saved positions are separate for
// desktop and mobile so a desktop arrangement does not displace mobile sheets.
const MOBILE_BREAKPOINT = 900;
const EDGE_GAP = 8;
const DRAG_THRESHOLD = 4;
const POSITION_STYLES = ['left', 'top', 'right', 'bottom', 'width', 'max-width', 'transform'];
const INTERACTIVE = 'button, input, select, textarea, a, label, summary, [contenteditable], [role="button"]';
const controllers = new WeakMap();

export function makePanelDraggable(el, {
  handleSelector = '.list-title, .panel-drag-handle',
  storageKey = null,
  addHint = true,
} = {}) {
  if (!el) return;
  if (controllers.has(el)) return controllers.get(el);
  if (el.dataset.draggable === '1') return;

  const handle = el.querySelector(handleSelector) || el;
  const originalStyles = readStyles();
  const originalTouchAction = [handle.style.getPropertyValue('touch-action'), handle.style.getPropertyPriority('touch-action')];
  const hadFloatClass = el.classList.contains('panel-float');
  const hadHandleClass = handle.classList.contains('panel-drag-handle');
  const originalDraggable = el.getAttribute('data-draggable');
  const listeners = [];
  let replacedHint = null;
  let createdGrip = null;
  let grip = handle.matches('button') ? handle : handle.querySelector('button.panel-drag-grip');

  if (!grip && addHint) {
    grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'panel-drag-hint panel-drag-grip';
    grip.textContent = '⠿';
    const label = el.getAttribute('aria-label') || handle.textContent.trim() || 'panel';
    grip.setAttribute('aria-label', `Move ${label}`);
    grip.title = 'Drag to move · Arrow keys to position · Home or double-click to reset';
    const oldHint = handle.querySelector('.panel-drag-hint');
    if (oldHint) {
      replacedHint = oldHint;
      oldHint.replaceWith(grip);
    } else {
      handle.appendChild(grip);
    }
    createdGrip = grip;
  }

  el.dataset.draggable = '1';
  el.classList.add('panel-float');
  handle.classList.add('panel-drag-handle');
  handle.style.setProperty('touch-action', 'none');

  let disposed = false;
  let frame = 0;
  let gesture = null;
  let suppressClick = false;
  let clickTimer = 0;
  let mobile = window.innerWidth <= MOBILE_BREAKPOINT;
  let position = readPosition();
  let preferredWidth = null;
  const remembered = new Map([[mobile, position]]);

  function listen(target, event, callback, options) {
    target.addEventListener(event, callback, options);
    listeners.push(() => target.removeEventListener(event, callback, options));
  }

  function readStyles() {
    return POSITION_STYLES.map(name => [name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]);
  }

  function restoreStyles(styles = originalStyles) {
    for (const [name, value, priority] of styles) {
      if (value) el.style.setProperty(name, value, priority);
      else el.style.removeProperty(name);
    }
  }

  function currentStorageKey() {
    return storageKey && (mobile ? `${storageKey}:mobile` : storageKey);
  }

  function readPosition() {
    const key = currentStorageKey();
    if (!key) return null;
    try {
      const value = JSON.parse(localStorage.getItem(key));
      if (value && Number.isFinite(value.left) && Number.isFinite(value.top)) {
        return { left: value.left, top: value.top };
      }
    } catch { /* A blocked or malformed preference must not prevent dragging. */ }
    return null;
  }

  function savePosition() {
    remembered.set(mobile, position && { ...position });
    const key = currentStorageKey();
    if (!key) return;
    try {
      if (position) localStorage.setItem(key, JSON.stringify(position));
      else localStorage.removeItem(key);
    } catch { /* Position still works for this session when storage is unavailable. */ }
  }

  function applyPosition(left, top) {
    const before = el.getBoundingClientRect();
    // Hidden sheets have no usable dimensions. ResizeObserver restores them
    // after opening, before a user can interact with an offscreen handle.
    if (!before.width || !before.height) return;
    preferredWidth ??= before.width;
    const availableWidth = Math.max(1, window.innerWidth - EDGE_GAP * 2);
    el.style.setProperty('width', `${Math.min(preferredWidth, availableWidth)}px`, 'important');
    el.style.setProperty('max-width', `${availableWidth}px`, 'important');
    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
    el.style.setProperty('transform', 'none', 'important');
    // Width changes can wrap contents, so clamp against the resulting height.
    const bounds = el.getBoundingClientRect();
    position = {
      left: Math.round(Math.max(EDGE_GAP, Math.min(left, window.innerWidth - bounds.width - EDGE_GAP))),
      top: Math.round(Math.max(EDGE_GAP, Math.min(top, window.innerHeight - bounds.height - EDGE_GAP))),
    };
    el.style.setProperty('left', `${position.left}px`, 'important');
    el.style.setProperty('top', `${position.top}px`, 'important');
    el.classList.add('is-user-positioned');
  }

  function refresh() {
    frame = 0;
    if (disposed) return;
    const nextMobile = window.innerWidth <= MOBILE_BREAKPOINT;
    if (nextMobile !== mobile) {
      cancelGesture();
      remembered.set(mobile, position && { ...position });
      mobile = nextMobile;
      restoreStyles();
      el.classList.remove('is-user-positioned');
      preferredWidth = null;
      if (!remembered.has(mobile)) remembered.set(mobile, readPosition());
      position = remembered.get(mobile);
    }
    if (position && !gesture) applyPosition(position.left, position.top);
  }

  function scheduleRefresh() {
    if (!disposed && !frame) frame = requestAnimationFrame(refresh);
  }

  function releaseCapture(pointerId) {
    try {
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    } catch { /* The element may have been hidden or detached during a drag. */ }
  }

  function cancelGesture() {
    if (!gesture) return;
    const previous = gesture;
    gesture = null;
    if (previous.moved) {
      position = previous.position;
      preferredWidth = previous.width;
      restoreStyles(previous.styles);
      el.classList.toggle('is-user-positioned', previous.wasPositioned);
    }
    el.classList.remove('is-dragging');
    releaseCapture(previous.pointerId);
  }

  function resetPosition() {
    cancelGesture();
    position = null;
    preferredWidth = null;
    restoreStyles();
    el.classList.remove('is-user-positioned');
    savePosition();
  }

  function permittedTarget(target) {
    if (!(target instanceof Element)) return false;
    const interactive = target.closest(INTERACTIVE);
    return !interactive || interactive === grip || interactive === handle;
  }

  function onDown(event) {
    if (gesture || event.isPrimary === false || event.button !== 0 || !permittedTarget(event.target)) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    gesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
      position: position && { ...position },
      width: preferredWidth,
      styles: readStyles(),
      wasPositioned: el.classList.contains('is-user-positioned'),
    };
    try { handle.setPointerCapture(event.pointerId); } catch { /* Window listeners are the fallback. */ }
  }

  function onMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    gesture.moved = true;
    el.classList.add('is-dragging');
    applyPosition(gesture.left + dx, gesture.top + dy);
    event.preventDefault();
  }

  function onUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const previous = gesture;
    gesture = null;
    el.classList.remove('is-dragging');
    releaseCapture(previous.pointerId);
    if (previous.moved) {
      savePosition();
      // Prevent a drag release from also activating a title's collapse action.
      suppressClick = true;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { suppressClick = false; }, 0);
    }
    scheduleRefresh();
  }

  function onCancel(event) {
    if (gesture && event.pointerId === gesture.pointerId) cancelGesture();
  }

  function onKeyDown(event) {
    if (!grip || !(event.target === grip || grip.contains(event.target))) return;
    // Scene-wide shortcuts must not run while operating a panel grip.
    event.stopPropagation();
    if (event.key === 'Home') {
      event.preventDefault();
      resetPosition();
      return;
    }
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    cancelGesture();
    const rect = el.getBoundingClientRect();
    const step = event.shiftKey ? 40 : 10;
    applyPosition(rect.left + direction[0] * step, rect.top + direction[1] * step);
    savePosition();
  }

  listen(handle, 'pointerdown', onDown);
  listen(window, 'pointermove', onMove, { passive: false });
  listen(window, 'pointerup', onUp);
  listen(window, 'pointercancel', onCancel);
  listen(handle, 'lostpointercapture', onCancel);
  listen(window, 'blur', cancelGesture);
  listen(handle, 'keydown', onKeyDown);
  listen(handle, 'click', event => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  listen(handle, 'dblclick', event => {
    if (!permittedTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    resetPosition();
  });
  listen(window, 'resize', scheduleRefresh);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleRefresh) : null;
  observer?.observe(el);
  refresh();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelGesture();
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(clickTimer);
    observer?.disconnect();
    for (const remove of listeners) remove();
    restoreStyles();
    if (originalTouchAction[0]) handle.style.setProperty('touch-action', ...originalTouchAction);
    else handle.style.removeProperty('touch-action');
    if (createdGrip) {
      if (replacedHint) createdGrip.replaceWith(replacedHint);
      else createdGrip.remove();
    }
    el.classList.remove('is-user-positioned', 'is-dragging');
    if (!hadFloatClass) el.classList.remove('panel-float');
    if (!hadHandleClass) handle.classList.remove('panel-drag-handle');
    if (originalDraggable === null) el.removeAttribute('data-draggable');
    else el.setAttribute('data-draggable', originalDraggable);
    controllers.delete(el);
  };
  controllers.set(el, dispose);
  return dispose;
}

/** Floating live description card used while recording (drives overlay HUD box). */
export function createRecDescFloater() {
  let el = document.getElementById('rec-desc-floater');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rec-desc-floater';
    el.className = 'rec-desc-floater hidden';
    el.innerHTML = `
      <div class="rec-desc-head panel-drag-handle">
        <span class="rec-desc-title">Recording description</span>
        <span class="panel-drag-hint">⠿ drag</span>
      </div>
      <div class="rec-desc-body" id="rec-desc-body"></div>
      <div class="rec-desc-note">Drag to place this box in the recorded video</div>`;
    document.body.appendChild(el);
  }

  // Default lower-left-ish
  if (!el.style.left) {
    el.style.left = '24px';
    el.style.top = `${Math.max(120, window.innerHeight - 280)}px`;
  }

  makePanelDraggable(el, {
    handleSelector: '.rec-desc-head',
    storageKey: 'observatory-rec-desc-pos',
  });

  function show() { el.classList.remove('hidden'); }
  function hide() { el.classList.add('hidden'); }

  function setContent(hud) {
    const body = el.querySelector('#rec-desc-body');
    if (!body) return;
    const lines = [];
    if (hud.status) lines.push(hud.status);
    if (hud.lines) lines.push(...hud.lines.filter(Boolean));
    if (hud.points?.length) {
      const maxPts = Math.min(hud.points.length, 8);
      for (let i = 0; i < maxPts; i++) {
        const p = hud.points[i];
        lines.push(`${p.name}: ${p.line}`);
      }
    }
    body.textContent = lines.join('\n') || '…';
  }

  /** Normalized box origin (0..1) for overlay painter, relative to viewport. */
  function getNormPos() {
    const r = el.getBoundingClientRect();
    const vw = Math.max(window.innerWidth, 1);
    const vh = Math.max(window.innerHeight, 1);
    return {
      nx: Math.min(0.92, Math.max(0.02, r.left / vw)),
      ny: Math.min(0.92, Math.max(0.02, r.top / vh)),
    };
  }

  return { el, show, hide, setContent, getNormPos };
}
