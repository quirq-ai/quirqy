import './glass-surfaces.css';
import './panel-appearance.css';
import './repository-view-nav.css';
import { mountGlassRefraction } from './glass-refraction.js';
import { REPOSITORY_LABS } from './repository-labs.js';

const STORAGE_KEY = 'quirq-observatory.panel-opacity.v1';
const DEFAULT_OPACITY = 62;
const ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m10 2 8 4-8 4-8-4 8-4Z"/><path d="m2 10 8 4 8-4M2 14l8 4 8-4"/></svg>';
const OPACITY_APP_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16V4Z" fill="currentColor" fill-opacity=".5" stroke="none"/><path d="M12 4v16"/></svg>';

function readOpacity(raw) {
  try {
    const value = JSON.parse(raw);
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : DEFAULT_OPACITY;
  } catch { return DEFAULT_OPACITY; }
}

/** One appearance preference and popover shared by all instrument controls. */
export function mountPanelAppearance() {
  const lifetime = new AbortController();
  const refraction = mountGlassRefraction();
  const on = (target, event, handler, options = {}) => target.addEventListener(event, handler, { ...options, signal: lifetime.signal });
  let opacity = DEFAULT_OPACITY;
  try { opacity = readOpacity(localStorage.getItem(STORAGE_KEY)); } catch { /* Session controls remain available. */ }
  let activeTrigger = null;
  const triggers = new Set();
  const observed = new WeakSet();
  const panelObservers = [];
  let repositoryViews = null;
  const popover = document.createElement('div');
  popover.id = 'glass-appearance-popover';
  popover.setAttribute('popover', 'auto');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-labelledby', 'glass-appearance-title');
  popover.innerHTML = `
    <div class="glass-popover-heading"><span class="glass-popover-icon">${ICON}</span><div><h2 id="glass-appearance-title">Liquid glass</h2><p>Appearance across all labs.</p></div><button class="glass-popover-close" type="button" aria-label="Close appearance controls">×</button></div>
    <div class="glass-opacity-section">
    <div class="glass-opacity-content">
    <label class="glass-opacity-label" for="glass-opacity-range"><span>Panel opacity</span><output id="glass-opacity-output" for="glass-opacity-range"></output></label>
    <input id="glass-opacity-range" type="range" min="0" max="100" step="1" aria-describedby="glass-opacity-description" />
    <div class="glass-opacity-scale" aria-hidden="true"><span>Clear</span><span>Solid</span></div>
    <p id="glass-opacity-description">Clearer glass bends the scene behind panels and playback bars.</p>
    <div class="glass-popover-footer"><span id="glass-opacity-status" role="status">Browser preference</span><button class="glass-opacity-reset" type="button">Reset</button></div></div></div>`;
  document.body.append(popover);
  const range = popover.querySelector('input');
  const output = popover.querySelector('output');
  const status = popover.querySelector('#glass-opacity-status');
  const nativePopover = typeof popover.showPopover === 'function';
  if (!nativePopover) popover.hidden = true;
  const isOpen = () => nativePopover ? popover.matches(':popover-open') : !popover.hidden;

  function render() {
    document.documentElement.style.setProperty('--glass-opacity', String(opacity / 100));
    document.documentElement.style.setProperty('--glass-opacity-percent', `${opacity}%`);
    refraction.update(opacity);
    range.value = String(opacity);
    range.setAttribute('aria-valuetext', `${opacity} percent`);
    output.value = `${opacity}%`;
    for (const trigger of triggers) {
      if (!trigger.isConnected) { triggers.delete(trigger); continue; }
      trigger.querySelector('.glass-opacity-value').textContent = `${opacity}%`;
      trigger.setAttribute('aria-label', `Adjust panel opacity, ${opacity} percent`);
      trigger.title = `Panel opacity: ${opacity}%`;
    }
  }

  function persist(reset = false) {
    try {
      if (reset) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(opacity));
      status.textContent = 'Saved in this browser';
    } catch {
      status.textContent = 'Applied for this visit';
    }
  }

  function positionPopover() {
    if (!isOpen() || !activeTrigger) return;
    const anchor = activeTrigger.getBoundingClientRect();
    if (!anchor.width || !anchor.height) { close(); return; }
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

  function syncExpanded() {
    for (const trigger of triggers) trigger.setAttribute('aria-expanded', String(isOpen() && trigger === activeTrigger));
  }
  function close() {
    if (!isOpen()) return;
    const restore = popover.contains(document.activeElement);
    if (nativePopover) popover.hidePopover();
    else popover.hidden = true;
    syncExpanded();
    if (restore && activeTrigger?.isConnected) activeTrigger.focus({ preventScroll: true });
  }
  function open(trigger) {
    if (isOpen() && activeTrigger === trigger) { close(); return; }
    activeTrigger = trigger;
    document.dispatchEvent(new CustomEvent('observatory:popover-open', { detail: popover.id }));
    if (!isOpen()) {
      if (nativePopover) popover.showPopover({ source: trigger });
      else popover.hidden = false;
    }
    syncExpanded();
    positionPopover();
    range.focus({ preventScroll: true });
  }

  function addTrigger(host, after = null) {
    if (!host || host.querySelector(':scope > .glass-opacity-trigger')) return;
    const button = document.createElement('button');
    button.type = 'button';
    const dockApp = host.classList.contains('repository-dock-actions');
    button.className = `glass-opacity-trigger${dockApp ? ' repository-app-tile' : ''}`;
    if (dockApp) button.dataset.repositoryApp = 'opacity';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', popover.id);
    button.setAttribute('popovertarget', popover.id);
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = dockApp
      ? `<span class="repository-app-icon" aria-hidden="true">${OPACITY_APP_ICON}</span><span class="glass-opacity-text repository-app-label">Opacity</span><span class="glass-opacity-value" hidden></span>`
      : `${ICON}<span class="glass-opacity-text">Opacity</span><span class="glass-opacity-value"></span>`;
    if (after) after.after(button);
    else host.append(button);
    triggers.add(button);
    on(button, 'click', event => { event.preventDefault(); open(button); });
    on(button, 'keydown', event => event.stopPropagation());
    render();
    return button;
  }

  function releaseRepositoryViews() {
    if (!repositoryViews) return;
    const { row, placeholder, nav, resize } = repositoryViews;
    repositoryViews = null;
    resize.disconnect();
    if (placeholder.parentNode) placeholder.replaceWith(row);
    else row.remove();
    nav.remove();
    document.body.classList.remove('repository-views-top');
    document.documentElement.style.removeProperty('--repository-header-height');
  }

  function attachRepositoryViews() {
    const lab = REPOSITORY_LABS.find(lab => document.getElementById(lab.panelId));
    const panel = lab && document.getElementById(lab.panelId);
    const topbar = document.getElementById('topbar');
    if (repositoryViews && (repositoryViews.panel !== panel || repositoryViews.topbar !== topbar
      || !repositoryViews.placeholder.isConnected || !repositoryViews.nav.isConnected
      || !repositoryViews.nav.contains(repositoryViews.row))) releaseRepositoryViews();
    if (!panel || !topbar || repositoryViews) return;
    const row = panel.querySelector(lab.viewSwitch);
    if (!row) return;
    const placeholder = document.createComment('Repository views are presented beneath the Observatory brand.');
    row.before(placeholder);
    const nav = document.createElement('nav');
    nav.className = 'repository-view-nav';
    nav.setAttribute('aria-label', 'Scene view');
    // Keep the original group and buttons, including the lab's listeners and pressed states.
    nav.append(row);
    topbar.append(nav);
    document.body.classList.add('repository-views-top');
    const updateHeight = () => {
      document.documentElement.style.setProperty('--repository-header-height', `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
    };
    const resize = new ResizeObserver(updateHeight);
    resize.observe(topbar);
    updateHeight();
    repositoryViews = { panel, row, placeholder, nav, topbar, resize };
  }

  function attachControls() {
    // A replaced dock must not leave an open popover pointing to a detached button.
    for (const trigger of triggers) {
      if (trigger.isConnected) continue;
      if (activeTrigger === trigger) { close(); activeTrigger = null; }
      triggers.delete(trigger);
    }
    attachRepositoryViews();
    for (const id of ['topbar', 'timebar', 'math-timebar', 'equation-panel', ...REPOSITORY_LABS.flatMap(lab => [lab.panelId, lab.dockId])]) {
      const container = document.getElementById(id);
      if (!container) continue;
      if (!observed.has(container)) {
        observed.add(container);
        // Only direct children: scene labels and live readouts update every frame.
        const observer = new MutationObserver(attachControls);
        observer.observe(container, { childList: true });
        panelObservers.push(observer);
      }
      const lab = REPOSITORY_LABS.find(lab => lab.dockId === id || lab.panelId === id);
      if (id === 'topbar' || id === lab?.panelId) continue;
      if (id === lab?.dockId) {
        const actions = container.querySelector('.repository-dock-actions');
        const trigger = addTrigger(actions);
        if (trigger) actions.prepend(trigger);
      } else if (id === 'equation-panel') {
        const row = container.querySelector('#eq-speed')?.previousElementSibling;
        if (row) { row.classList.add('glass-speed-heading'); addTrigger(row); }
      } else {
        const midpoint = container.querySelector('.t-mid');
        if (midpoint) addTrigger(container, midpoint);
      }
    }
  }

  on(range, 'input', () => { opacity = Number(range.value); render(); });
  on(range, 'change', () => persist());
  on(popover.querySelector('.glass-opacity-reset'), 'click', () => { opacity = DEFAULT_OPACITY; render(); persist(true); });
  on(popover.querySelector('.glass-popover-close'), 'click', close);
  on(popover, 'keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  on(popover, 'toggle', syncExpanded);
  on(document, 'pointerdown', event => {
    if (isOpen() && !popover.contains(event.target) && !event.target.closest('.glass-opacity-trigger')) close();
  });
  on(document, 'observatory:popover-open', event => { if (event.detail !== popover.id) close(); });
  on(window, 'resize', positionPopover);
  if (window.visualViewport) on(window.visualViewport, 'resize', positionPopover);
  on(document, 'scroll', event => { if (!popover.contains(event.target)) positionPopover(); }, { capture: true });
  on(window, 'storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== localStorage) return; } catch { return; }
    opacity = readOpacity(event.newValue);
    render();
  });
  const bodyObserver = new MutationObserver(attachControls);
  bodyObserver.observe(document.body, { childList: true });
  render();
  attachControls();

  return () => {
    close();
    lifetime.abort();
    bodyObserver.disconnect();
    for (const observer of panelObservers) observer.disconnect();
    for (const trigger of triggers) trigger.remove();
    releaseRepositoryViews();
    refraction.dispose();
    popover.remove();
  };
}
