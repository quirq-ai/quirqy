import { makePanelDraggable } from './dragPanel.js';
import './floating-layout.css';
import { REPOSITORY_LABS } from './repository-labs.js';
import { mountRepositoryDockApps } from './repository-dock-apps.js';

/** Attach shared floating behavior without tying it to a lab's scene lifecycle. */
export function mountFloatingLayout() {
  const panels = new Map();
  const watched = new Map();
  const dockIds = [...REPOSITORY_LABS.map(lab => lab.dockId), 'timebar', 'math-timebar'];
  let repositoryControls = null;

  function restoreRepositoryControls() {
    if (!repositoryControls) return;
    const { moves, header, dock, group, apps } = repositoryControls;
    repositoryControls = null;
    apps?.dispose();
    // Restore the actual controls so their listeners and focus behavior survive.
    for (const { node, placeholder, label } of moves) {
      placeholder.replaceWith(node);
      if (label === null) node.removeAttribute('aria-label');
      else node.setAttribute('aria-label', label);
    }
    group.remove();
    header.classList.remove('repository-status-header');
    dock.classList.remove('repository-actions-dock');
    document.body.classList.remove('repository-dock-layout');
  }

  function attachRepositoryControls() {
    const lab = REPOSITORY_LABS.find(lab => document.getElementById(lab.panelId));
    const header = lab && document.querySelector(`#${lab.panelId} > .list-title`);
    const dock = lab && document.getElementById(lab.dockId);
    if (repositoryControls) {
      if (repositoryControls.header === header && repositoryControls.dock === dock && repositoryControls.group.isConnected
        && repositoryControls.apps?.links.every(link => repositoryControls.apps.element.contains(link))) return;
      restoreRepositoryControls();
    }
    const speed = dock?.querySelector(lab.speedSelector);
    const help = document.getElementById('btn-help');
    const status = document.getElementById('sim-date');
    if (!header || !speed || !help || !status || !REPOSITORY_LABS.every(app => document.getElementById(`tab-${app.mode}`))) return;

    const group = document.createElement('div');
    group.className = 'repository-dock-actions';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Dock actions');
    const moves = [help, status].map(node => {
      const placeholder = document.createComment(`${node.id} original position`);
      node.before(placeholder);
      return { node, placeholder, label: node.getAttribute('aria-label') };
    });
    help.setAttribute('aria-label', 'Help');
    group.append(help);
    const apps = mountRepositoryDockApps(group, lab.mode);
    speed.after(group);
    header.insertBefore(status, header.querySelector('button'));
    header.classList.add('repository-status-header');
    dock.classList.add('repository-actions-dock');
    document.body.classList.add('repository-dock-layout');
    repositoryControls = { moves, header, dock, group, apps };
  }

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

    for (const lab of REPOSITORY_LABS) {
      const guide = document.getElementById(lab.guideId);
      if (guide && !panels.has(guide)) {
        const dispose = makePanelDraggable(guide, {
          handleSelector: '.list-title', storageKey: `observatory-${lab.guideId}-pos`,
        });
        panels.set(guide, { dispose });
      }
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
        if (height) {
          document.documentElement.style.setProperty(`--${id}-height`, `${Math.ceil(height)}px`);
          if (REPOSITORY_LABS.some(lab => lab.dockId === id)) document.documentElement.style.setProperty('--repository-timebar-height', `${Math.ceil(height)}px`);
        }
      };
      const resize = new ResizeObserver(updateHeight);
      resize.observe(dock);
      updateHeight();
      panels.set(dock, { dispose, resize, grip });
    }
    attachRepositoryControls();
  }

  // Panels mount asynchronously. Observe only direct children, never scene updates.
  const bodyObserver = new MutationObserver(attach);
  bodyObserver.observe(document.body, { childList: true });
  attach();
  return () => {
    bodyObserver.disconnect();
    for (const observer of watched.values()) observer.disconnect();
    watched.clear();
    restoreRepositoryControls();
    for (const [element, entry] of panels) release(element, entry);
    for (const id of dockIds) document.documentElement.style.removeProperty(`--${id}-height`);
    document.documentElement.style.removeProperty('--repository-timebar-height');
  };
}
