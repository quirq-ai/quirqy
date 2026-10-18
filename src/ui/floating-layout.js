import { makePanelDraggable } from './dragPanel.js';
import './floating-layout.css';

/** Attach shared floating behavior without tying it to a lab's scene lifecycle. */
export function mountFloatingLayout() {
  const panels = new Map();
  const watched = new Map();
  const dockIds = ['data-timebar', 'timebar', 'math-timebar'];

  function release(element, entry) {
    entry.dispose?.();
    entry.resize?.disconnect();
    entry.grip?.remove();
    element.classList.remove('panel-dock');
    panels.delete(element);
  }

  function attach() {
    for (const [element, entry] of panels) {
      if (!element.isConnected || (entry.grip && !element.contains(entry.grip))) release(element, entry);
    }
    for (const [element, observer] of watched) {
      if (!element.isConnected) { observer.disconnect(); watched.delete(element); }
    }

    const guide = document.getElementById('data-guide');
    if (guide && !panels.has(guide)) {
      const dispose = makePanelDraggable(guide, {
        handleSelector: '.list-title', storageKey: 'observatory-data-guide-pos',
      });
      panels.set(guide, { dispose });
    }

    for (const id of dockIds) {
      const dock = document.getElementById(id);
      if (!dock) continue;
      if (!watched.has(dock)) {
        const observer = new MutationObserver(attach);
        observer.observe(dock, { childList: true });
        watched.set(dock, observer);
      }
      if (!dock.querySelector('.t-mid') || panels.has(dock)) continue;
      dock.classList.add('panel-dock');
      const grip = document.createElement('button');
      grip.type = 'button';
      grip.className = 'panel-dock-grip';
      grip.setAttribute('aria-label', 'Move timeline dock');
      grip.title = 'Drag to move · Arrow keys to move · Home or double-click to reset';
      grip.innerHTML = '<span aria-hidden="true"></span>';
      dock.prepend(grip);
      const dispose = makePanelDraggable(dock, {
        handleSelector: '.panel-dock-grip', storageKey: `observatory-${id}-pos`, addHint: false,
      });
      // Reserve enough room above the dock for nearby side panels.
      const updateHeight = () => {
        const height = dock.getBoundingClientRect().height;
        if (height) document.documentElement.style.setProperty(`--${id}-height`, `${Math.ceil(height)}px`);
      };
      const resize = new ResizeObserver(updateHeight);
      resize.observe(dock);
      updateHeight();
      panels.set(dock, { dispose, resize, grip });
    }
  }

  // Panels mount asynchronously. Observe only direct children, never scene updates.
  const bodyObserver = new MutationObserver(attach);
  bodyObserver.observe(document.body, { childList: true });
  attach();
  return () => {
    bodyObserver.disconnect();
    for (const observer of watched.values()) observer.disconnect();
    watched.clear();
    for (const [element, entry] of panels) release(element, entry);
    for (const id of dockIds) document.documentElement.style.removeProperty(`--${id}-height`);
  };
}
