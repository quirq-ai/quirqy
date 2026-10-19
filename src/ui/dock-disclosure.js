// Pointer clicks wait briefly so the logo retains the shared double-click reset.
// Keyboard activation is immediate; all controls keep their original DOM/state.
const CLICK_DELAY = 280;

export function mountDockDisclosure(dock, grip, dragController) {
  const lifetime = new AbortController();
  const on = (target, name, handler, options = {}) => target.addEventListener(name, handler, { ...options, signal: lifetime.signal });
  const inertChildren = new Map();
  let collapsed = false;
  let clickTimer = 0;
  let clickStartCollapsed = false;
  let disposed = false;

  function syncControls() {
    if (collapsed) {
      for (const child of dock.children) {
        if (child === grip) continue;
        if (!inertChildren.has(child)) inertChildren.set(child, child.inert);
        child.inert = true;
      }
    } else {
      for (const [child, inert] of inertChildren) child.inert = inert;
      inertChildren.clear();
    }
  }

  function render() {
    dock.classList.toggle('is-dock-collapsed', collapsed);
    grip.setAttribute('aria-expanded', String(!collapsed));
    grip.setAttribute('aria-controls', dock.id);
    const action = collapsed ? 'Expand' : 'Collapse';
    grip.setAttribute('aria-label', `${action} timeline dock; drag or use arrow keys to move; Home or double-click to reset position`);
    grip.title = `${action} dock · Drag logo to move · Arrow keys to move · Home or double-click to reset`;
    syncControls();
  }

  function setCollapsed(next) {
    if (disposed || next === collapsed) return;
    if (next) {
      // Close floating Apps/appearance popovers without changing the inline
      // timeline or opacity disclosure states that should return on expansion.
      document.dispatchEvent(new CustomEvent('observatory:popover-open', { detail: `${dock.id}-collapsed` }));
      grip.focus({ preventScroll: true });
    }
    dragController.reflowAroundAnchor(() => {
      collapsed = next;
      render();
    }, grip);
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
    setCollapsed(clickStartCollapsed);
  }, { capture: true });
  on(grip, 'pointerdown', clearClick);
  on(grip, 'keydown', event => {
    // The drag controller handles positioning keys and prevents scene shortcuts.
    // Cancel a pending pointer activation when another explicit action begins.
    if (event.key === 'Home' || event.key.startsWith('Arrow') || event.key === 'Enter' || event.key === ' ') clearClick();
  });
  const observer = new MutationObserver(syncControls);
  observer.observe(dock, { childList: true });
  render();

  return () => {
    if (disposed) return;
    disposed = true;
    clearClick();
    lifetime.abort();
    observer.disconnect();
    collapsed = false;
    syncControls();
    dock.classList.remove('is-dock-collapsed');
    grip.removeAttribute('aria-expanded');
    grip.removeAttribute('aria-controls');
  };
}
