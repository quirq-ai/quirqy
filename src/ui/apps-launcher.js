import { ROUTES } from '../nav/routes.js';
import { REPOSITORY_LABS } from './repository-labs.js';
import './apps-launcher.css';

const GRID_ICON = '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>';
const PRESENTATION = {
  solar: { name: 'Solar system', colors: ['#c99246', '#895321'], icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>' },
  spm: { name: 'SPM mooring', colors: ['#438ca6', '#24516b'], icon: '<path d="M12 7v13m-7-7v2a7 7 0 0 0 14 0v-2M9 11h6M3 15l2-2 2 2m10 0 2-2 2 2"/><circle cx="12" cy="5" r="2"/>' },
  math: { name: 'Equation lab', colors: ['#8e7ec0', '#514274'], icon: '<path d="M17 4H7l7 8-7 8h10M5 4h1m-1 16h1"/>' },
  earth: { name: 'Earth lab', colors: ['#489d89', '#245a50'], icon: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/>' },
  light: { name: 'Light lab', colors: ['#bf9560', '#7c5833'], icon: '<path d="m12 4 8 15H4L12 4Zm-10 7h6m7 1 7-5m-6 7 6-1m-5 3 5 3"/>' },
  gravity: { name: 'Gravity lab', colors: ['#6f8fb8', '#3a4f7b'], icon: '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-35 12 12)"/><circle cx="19" cy="6" r="1.5" fill="currentColor" stroke="none"/>' },
  photo: { name: 'Photo lab', colors: ['#b8788f', '#774457'], icon: '<path d="m13 2-7 11h6l-1 9 7-12h-6l1-8Z"/>' },
  fractal: { name: 'Fractals lab', colors: ['#6ca398', '#365e59'], icon: '<path d="m12 3 10 18H2L12 3Zm0 18L7 12h10l-5 9ZM7 12l5 9m5-9-5 9"/>' },
};
const icon = paths => `<span class="repository-app-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" focusable="false">${paths}</svg></span>`;

/** An app launcher with native links, so repository-session flushing and modified clicks still work. */
export function mountAppsLauncher(host) {
  const lifetime = new AbortController();
  const on = (target, event, handler, options = {}) => target.addEventListener(event, handler, { ...options, signal: lifetime.signal });
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'repository-app-tile repository-apps-trigger';
  trigger.dataset.repositoryApp = 'apps';
  trigger.setAttribute('aria-label', 'Apps');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'repository-apps-popover');
  trigger.setAttribute('popovertarget', 'repository-apps-popover');
  trigger.innerHTML = `${icon(GRID_ICON)}<span class="repository-app-label">Apps</span>`;
  host.append(trigger);

  const popover = document.createElement('div');
  popover.id = 'repository-apps-popover';
  popover.className = 'panel';
  popover.setAttribute('popover', 'auto');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-labelledby', 'repository-apps-title');
  popover.innerHTML = '<div class="repository-apps-heading"><h2 id="repository-apps-title">Apps</h2><button type="button" class="glass-popover-close" aria-label="Close apps">×</button></div><nav class="repository-apps-grid" aria-label="Observatory labs"></nav>';
  const grid = popover.querySelector('nav');
  const routes = ROUTES.filter(route => !REPOSITORY_LABS.some(lab => lab.mode === route.mode))
    .sort((a, b) => Number(b.mode === 'solar') - Number(a.mode === 'solar'));
  for (const route of routes) {
    const label = route.title.split('·').at(-1).trim();
    const app = PRESENTATION[route.mode] || { name: label, colors: ['#6f8fb8', '#3a4f7b'], icon: GRID_ICON };
    const link = document.createElement('a');
    link.href = route.path;
    link.className = 'repository-app-tile';
    link.dataset.lab = route.mode;
    link.setAttribute('aria-label', label);
    link.style.setProperty('--app-tile-start', app.colors[0]);
    link.style.setProperty('--app-tile-end', app.colors[1]);
    link.innerHTML = `${icon(app.icon)}<span class="repository-app-label"></span>`;
    link.querySelector('.repository-app-label').textContent = app.name;
    grid.append(link);
  }
  document.body.append(popover);
  const nativePopover = typeof popover.showPopover === 'function';
  if (!nativePopover) popover.hidden = true;
  const isOpen = () => nativePopover ? popover.matches(':popover-open') : !popover.hidden;
  const syncExpanded = () => trigger.setAttribute('aria-expanded', String(isOpen()));

  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;
    const focusInside = popover.contains(document.activeElement);
    if (nativePopover) popover.hidePopover();
    else popover.hidden = true;
    syncExpanded();
    if (restoreFocus && focusInside && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function position() {
    if (!isOpen()) return;
    if (!trigger.isConnected) { close({ restoreFocus: false }); return; }
    const anchor = trigger.getBoundingClientRect();
    const bounds = popover.getBoundingClientRect();
    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const offsetX = viewport?.offsetLeft || 0, offsetY = viewport?.offsetTop || 0;
    const left = Math.max(offsetX + 12, Math.min(anchor.right - bounds.width, offsetX + width - bounds.width - 12));
    const above = anchor.top - bounds.height - 12;
    const top = Math.max(offsetY + 12, Math.min(above >= offsetY + 12 ? above : anchor.bottom + 12, offsetY + height - bounds.height - 12));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function open() {
    if (isOpen()) { close(); return; }
    document.dispatchEvent(new CustomEvent('observatory:popover-open', { detail: popover.id }));
    if (nativePopover) popover.showPopover({ source: trigger });
    else popover.hidden = false;
    syncExpanded();
    position();
    grid.querySelector('a')?.focus({ preventScroll: true });
  }

  on(trigger, 'click', event => { event.preventDefault(); open(); });
  on(trigger, 'keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  on(popover.querySelector('.glass-popover-close'), 'click', () => close());
  on(popover, 'toggle', syncExpanded);
  on(popover, 'keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  on(grid, 'click', event => {
    // Keep the link and its event untouched for the shared navigation handler.
    if (event.target.closest('a') && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) close({ restoreFocus: false });
  });
  on(document, 'pointerdown', event => {
    if (isOpen() && !popover.contains(event.target) && !trigger.contains(event.target)) close({ restoreFocus: false });
  });
  on(document, 'observatory:popover-open', event => {
    if (event.detail !== popover.id) close({ restoreFocus: false });
  });
  on(window, 'resize', position);
  if (window.visualViewport) {
    on(window.visualViewport, 'resize', position);
    on(window.visualViewport, 'scroll', position);
  }
  on(document, 'scroll', event => { if (!popover.contains(event.target)) position(); }, { capture: true });
  on(window, 'pagehide', () => close({ restoreFocus: false }));

  return () => {
    close({ restoreFocus: false });
    lifetime.abort();
    popover.remove();
    trigger.remove();
  };
}
