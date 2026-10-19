import { createDockMotion } from './dock-motion.js';

// Pointer clicks wait briefly so the logo retains the shared double-click reset.
// Keyboard activation is immediate; all controls keep their original DOM/state.
const CLICK_DELAY = 280;

export function mountDockDisclosure(dock, grip, dragController) {
  const lifetime = new AbortController();
  const on = (target, name, handler, options = {}) => target.addEventListener(name, handler, { ...options, signal: lifetime.signal });
  const inertChildren = new Map();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let motion = null;
  let collapsed = false;
  let clickTimer = 0;
  let clickStartCollapsed = false;
  let disposed = false;

  function syncControls() {
    if (collapsed || motion) {
      for (const child of dock.children) {
        if (child === grip || child.classList.contains('dock-motion-surface')) continue;
        if (!inertChildren.has(child)) inertChildren.set(child, child.inert);
        child.inert = true;
      }
    } else {
      for (const [child, inert] of inertChildren) child.inert = inert;
      inertChildren.clear();
    }
  }

  function render() {
    grip.setAttribute('aria-expanded', String(!collapsed));
    grip.setAttribute('aria-controls', dock.id);
    const action = collapsed ? 'Expand' : 'Collapse';
    grip.setAttribute('aria-label', `${action} timeline dock; drag or use arrow keys to move; Home or double-click to reset position`);
    grip.title = `${action} dock · Drag logo to move · Arrow keys to move · Home or double-click to reset`;
    syncControls();
  }

  function finishMotion() {
    // Commit the footprint once, preserving the logo's screen position.
    if (dock.classList.contains('is-dock-collapsed') !== collapsed) {
      dragController.reflowAroundAnchor(() => {
        dock.classList.toggle('is-dock-collapsed', collapsed);
      }, grip);
    }
    motion?.dispose();
    motion = null;
    render();
  }

  function setCollapsed(next, immediate = false) {
    if (disposed) return;
    if (next === collapsed) {
      if (immediate) finishMotion();
      return;
    }
    collapsed = next;
    if (next) {
      // Close floating popovers while retaining inline timeline/opacity state.
      document.dispatchEvent(new CustomEvent('observatory:popover-open', { detail: `${dock.id}-collapsed` }));
      grip.focus({ preventScroll: true });
    }
    if (immediate || reducedMotion.matches) {
      finishMotion();
      return;
    }
    if (motion) {
      motion.play(next);
    } else {
      if (!next) {
        dragController.reflowAroundAnchor(() => dock.classList.remove('is-dock-collapsed'), grip);
      }
      motion = createDockMotion(dock, grip, next, finishMotion);
      if (!motion) finishMotion();
    }
    render();
  }

  function clearClick() {
    clearTimeout(clickTimer);
    clickTimer = 0;
  }

  on(grip, 'click', event => {
    event.preventDefault();
    event.stopPropagation();
    clearClick();
    if (event.detail === 0) {
      setCollapsed(!collapsed);
    } else if (event.detail % 2 === 1) {
      clickStartCollapsed = collapsed;
      clickTimer = setTimeout(() => {
        clickTimer = 0;
        if (dock.isConnected) setCollapsed(!collapsed);
      }, CLICK_DELAY);
    }
  });
  on(grip, 'dblclick', () => {
    clearClick();
    // A slow system double-click may arrive after the first click committed.
    // Restore its initial state before the drag controller resets the position.
    setCollapsed(clickStartCollapsed, true);
  }, { capture: true });
  on(grip, 'pointerdown', () => {
    clearClick();
    // Settle before the drag controller captures its initial bounds.
    if (motion) finishMotion();
  }, { capture: true });
  on(grip, 'keydown', event => {
    // The drag controller handles positioning keys and prevents scene shortcuts.
    // Cancel a pending pointer activation when another explicit action begins.
    if (event.key === 'Home' || event.key.startsWith('Arrow') || event.key === 'Enter' || event.key === ' ') clearClick();
    if (motion && (event.key === 'Home' || event.key.startsWith('Arrow'))) finishMotion();
  }, { capture: true });
  on(window, 'resize', () => { if (motion) finishMotion(); });
  on(reducedMotion, 'change', () => { if (motion && reducedMotion.matches) finishMotion(); });
  const observer = new MutationObserver(syncControls);
  observer.observe(dock, { childList: true });
  render();

  return () => {
    if (disposed) return;
    disposed = true;
    clearClick();
    lifetime.abort();
    observer.disconnect();
    motion?.dispose();
    motion = null;
    collapsed = false;
    syncControls();
    dock.classList.remove('is-dock-collapsed');
    grip.removeAttribute('aria-expanded');
    grip.removeAttribute('aria-controls');
  };
}
