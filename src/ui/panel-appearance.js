import './glass-surfaces.css';
import './panel-appearance.css';
import { mountGlassRefraction } from './glass-refraction.js';
import { REPOSITORY_LABS } from './repository-labs.js';

const STORAGE_KEY = 'quirq-observatory.panel-opacity.v1';
const DEFAULT_OPACITY = 62;
const STRUCTURE_ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 6 10 8M15 6 5 14M5 6h10M5 14h10"/><circle cx="5" cy="6" r="2"/><circle cx="15" cy="6" r="2"/><circle cx="5" cy="14" r="2"/><circle cx="15" cy="14" r="2"/></svg>';
const TREE_ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 18V5m0 7L5 7m5 7 5-5M10 7l4-4"/><circle cx="10" cy="3" r="1.5"/><circle cx="4" cy="6" r="1.5"/><circle cx="16" cy="8" r="1.5"/><path d="m6 18 4-2 4 2"/></svg>';
const ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m10 2 8 4-8 4-8-4 8-4Z"/><path d="m2 10 8 4 8-4M2 14l8 4 8-4"/></svg>';

const ACTIVITY_ICONS = {
  constellation: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 5 5 5 7-6M9 10l5 6M4 5l-1 10"/><circle cx="4" cy="5" r="2"/><circle cx="9" cy="10" r="2"/><circle cx="16" cy="4" r="1.5"/><circle cx="14" cy="16" r="1.5"/><circle cx="3" cy="15" r="1.5"/></svg>',
  orbits: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="2"/><ellipse cx="10" cy="10" rx="8" ry="4" transform="rotate(-30 10 10)"/><ellipse cx="10" cy="10" rx="8" ry="4" transform="rotate(45 10 10)"/></svg>',
  contributors: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="6" r="3"/><path d="M4 18v-2a6 6 0 0 1 12 0v2M3 4a2 2 0 0 0 0 4m14-4a2 2 0 0 1 0 4M1 14a4 4 0 0 1 3-4m15 4a4 4 0 0 0-3-4"/></svg>',
};

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
    <div class="glass-view-options" hidden></div>
    <details class="glass-opacity-section" open>
    <summary class="glass-opacity-summary"><span class="glass-view-icon">${ICON}</span><span>Opacity</span><span class="glass-opacity-summary-value"></span><span class="glass-opacity-chevron" aria-hidden="true">⌄</span></summary>
    <div class="glass-opacity-content">
    <label class="glass-opacity-label" for="glass-opacity-range"><span>Panel opacity</span><output id="glass-opacity-output" for="glass-opacity-range"></output></label>
    <input id="glass-opacity-range" type="range" min="0" max="100" step="1" aria-describedby="glass-opacity-description" />
    <div class="glass-opacity-scale" aria-hidden="true"><span>Clear</span><span>Solid</span></div>
    <p id="glass-opacity-description">Clearer glass bends the scene behind panels and playback bars.</p>
    <div class="glass-popover-footer"><span id="glass-opacity-status" role="status">Browser preference</span><button class="glass-opacity-reset" type="button">Reset</button></div></div></details>`;
  document.body.append(popover);
  const range = popover.querySelector('input');
  const output = popover.querySelector('output');
  const status = popover.querySelector('#glass-opacity-status');
  const viewOptions = popover.querySelector('.glass-view-options');
  const opacitySection = popover.querySelector('.glass-opacity-section');
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
    popover.querySelector('.glass-opacity-summary-value').textContent = `${opacity}%`;
    for (const trigger of triggers) {
      if (!trigger.isConnected) { triggers.delete(trigger); continue; }
      trigger.querySelector('.glass-opacity-value').textContent = `${opacity}%`;
      const isView = trigger.classList.contains('glass-view-trigger');
      trigger.setAttribute('aria-label', isView ? 'View' : `Adjust panel opacity, ${opacity} percent`);
      trigger.title = isView ? 'View and appearance' : `Panel opacity: ${opacity}%`;
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
    const isView = trigger.classList.contains('glass-view-trigger') && Boolean(repositoryViews);
    popover.classList.toggle('glass-view-popover', Boolean(isView));
    viewOptions.hidden = !isView;
    opacitySection.open = !isView;
    popover.querySelector('#glass-appearance-title').textContent = isView ? 'View' : 'Liquid glass';
    popover.querySelector('.glass-popover-heading p').textContent = isView ? 'Scene & appearance' : 'Appearance across all labs.';
    popover.querySelector('.glass-popover-close').setAttribute('aria-label', isView ? 'Close View controls' : 'Close appearance controls');
    if (!isOpen()) {
      if (nativePopover) popover.showPopover({ source: trigger });
      else popover.hidden = false;
    }
    syncExpanded();
    positionPopover();
    (isView ? repositoryViews.row.querySelector('[aria-pressed="true"]') || repositoryViews.row.querySelector('button') : range).focus({ preventScroll: true });
  }

  function addTrigger(host, after = null) {
    if (!host || host.querySelector(':scope > .glass-opacity-trigger')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `glass-opacity-trigger${REPOSITORY_LABS.some(lab => lab.dockId === host.id) ? ' glass-view-trigger' : ''}`;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', popover.id);
    button.setAttribute('popovertarget', popover.id);
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = `${ICON}<span class="glass-opacity-text">${REPOSITORY_LABS.some(lab => lab.dockId === host.id) ? 'View' : 'Opacity'}</span><span class="glass-opacity-value"></span>`;
    if (after) after.after(button);
    else host.append(button);
    triggers.add(button);
    on(button, 'click', event => { event.preventDefault(); open(button); });
    on(button, 'keydown', event => event.stopPropagation());
    render();
  }

  function releaseRepositoryViews() {
    if (!repositoryViews) return;
    const { row, placeholder, originalMarkup } = repositoryViews;
    if (activeTrigger?.classList.contains('glass-view-trigger')) close();
    for (const [button, markup] of originalMarkup) button.innerHTML = markup;
    if (placeholder.parentNode) placeholder.replaceWith(row);
    else row.remove();
    viewOptions.hidden = true;
    repositoryViews = null;
  }

  function attachRepositoryViews() {
    const lab = REPOSITORY_LABS.find(lab => document.getElementById(lab.panelId));
    const panel = lab && document.getElementById(lab.panelId);
    if (repositoryViews && (repositoryViews.panel !== panel || !repositoryViews.placeholder.isConnected)) releaseRepositoryViews();
    if (!panel || repositoryViews) return;
    const row = panel.querySelector(lab.viewSwitch);
    if (!row) return;
    const placeholder = document.createComment('Repository views are presented in the dock View popover.');
    row.before(placeholder);
    const originalMarkup = new Map();
    for (const button of row.querySelectorAll('[data-view]')) {
      originalMarkup.set(button, button.innerHTML);
      const tree = button.dataset.view === 'tree';
      const label = button.textContent.trim();
      button.replaceChildren();
      const icon = document.createElement('span');
      icon.className = 'glass-view-icon';
      icon.innerHTML = tree ? TREE_ICON : ACTIVITY_ICONS[button.dataset.view] || STRUCTURE_ICON;
      const text = document.createElement('span');
      text.textContent = label;
      const check = document.createElement('span');
      check.className = 'glass-view-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      button.append(icon, text, check);
    }
    repositoryViews = { panel, row, placeholder, originalMarkup };
    viewOptions.append(row);
  }

  function attachControls() {
    attachRepositoryViews();
    for (const id of ['timebar', 'math-timebar', 'equation-panel', ...REPOSITORY_LABS.flatMap(lab => [lab.dockId, lab.panelId])]) {
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
      if (id === lab?.panelId) continue;
      if (id === 'equation-panel') {
        const row = container.querySelector('#eq-speed')?.previousElementSibling;
        if (row) { row.classList.add('glass-speed-heading'); addTrigger(row); }
      } else {
        const midpoint = container.querySelector('.t-mid');
        if (midpoint) addTrigger(container, lab ? container.querySelector(lab.speedSelector) : midpoint);
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
  on(opacitySection, 'toggle', positionPopover);
  on(viewOptions, 'click', event => { if (event.target.closest('[data-view]')) close(); });
  on(document, 'pointerdown', event => {
    if (isOpen() && !popover.contains(event.target) && !event.target.closest('.glass-opacity-trigger')) close();
  });
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
