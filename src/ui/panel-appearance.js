import './glass-surfaces.css';
import './panel-appearance.css';
import './repository-view-nav.css';
import { mountGlassRefraction } from './glass-refraction.js';
import { REPOSITORY_LABS } from './repository-labs.js';
import { mountRepositoryTimeline } from './repository-timeline.js';
import { mountRepositoryViewConnection } from './repository-view-connection.js';
import { mountRepositoryGithub } from './repository-github.js';
import './repository-github.css';
import './dock-material.css';

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

/** One appearance preference, inline in repository docks and a popover in other labs. */
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
  popover.dataset.dockMaterial = '';
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
    <p id="glass-opacity-description">Controls all dock surfaces, app tiles, menus, and panels. Lower is clearer; higher is more solid.</p>
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
    if (repositoryViews) {
      repositoryViews.range.value = String(opacity);
      repositoryViews.range.setAttribute('aria-valuetext', `${opacity} percent`);
      repositoryViews.range.title = `Panel opacity: ${opacity}%`;
      repositoryViews.output.value = `${opacity}%`;
    }
    for (const trigger of triggers) {
      if (!trigger.isConnected) { triggers.delete(trigger); continue; }
      trigger.querySelector('.glass-opacity-value').textContent = `${opacity}%`;
      trigger.setAttribute('aria-label', `Adjust panel opacity, ${opacity} percent`);
      trigger.title = `Panel opacity: ${opacity}% · Adjust how see-through panels and toolbars are`;
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
    for (const trigger of triggers) {
      const expanded = trigger.dataset.repositoryApp === 'opacity'
        ? Boolean(repositoryViews?.open && repositoryViews.trigger === trigger)
        : isOpen() && trigger === activeTrigger;
      trigger.setAttribute('aria-expanded', String(expanded));
    }
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

  function setRepositoryOpacity(open) {
    if (!repositoryViews) return;
    const { inline, range: inlineRange, trigger } = repositoryViews;
    const restoreFocus = inline.contains(document.activeElement);
    repositoryViews.open = open;
    inline.hidden = !open;
    syncExpanded();
    if (open) {
      document.dispatchEvent(new CustomEvent('observatory:popover-open', { detail: inline.id }));
      inlineRange.focus({ preventScroll: true });
    } else if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  function addTrigger(host, after = null) {
    if (!host || host.querySelector(':scope > .glass-opacity-trigger')) return;
    const button = document.createElement('button');
    button.type = 'button';
    const dockApp = REPOSITORY_LABS.some(lab => lab.dockId === host.id);
    button.className = `glass-opacity-trigger${dockApp ? ' repository-app-tile' : ''}`;
    if (dockApp) {
      button.id = 'repository-opacity-trigger';
      button.dataset.repositoryApp = 'opacity';
      button.setAttribute('aria-describedby', 'repository-opacity-description');
    }
    button.setAttribute('aria-controls', dockApp ? repositoryViews.inline.id : popover.id);
    if (!dockApp) {
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('popovertarget', popover.id);
    }
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = dockApp
      ? `<span class="repository-app-icon" aria-hidden="true">${OPACITY_APP_ICON}</span><span class="repository-opacity-copy"><span class="glass-opacity-text">Opacity</span><span class="glass-opacity-value"></span></span>`
      : `${ICON}<span class="glass-opacity-text">Opacity</span><span class="glass-opacity-value"></span>`;
    if (dockApp) {
      host.insertBefore(button, host.querySelector(':scope > :not(.panel-dock-grip)'));
      repositoryViews.trigger = button;
    } else if (after) after.after(button);
    else host.append(button);
    triggers.add(button);
    on(button, 'click', event => {
      event.preventDefault();
      if (dockApp) setRepositoryOpacity(!repositoryViews?.open);
      else open(button);
    });
    on(button, 'keydown', event => {
      event.stopPropagation();
      if (dockApp && event.key === 'Escape') setRepositoryOpacity(false);
    });
    render();
    return button;
  }

  function releaseRepositoryViews() {
    if (!repositoryViews) return;
    const { row, placeholder, heading, nav, dock, trigger, timeline, reading, github, connection, controller } = repositoryViews;
    setRepositoryOpacity(false);
    repositoryViews = null;
    controller.abort();
    timeline?.dispose();
    if (reading?.placeholder.parentNode) reading.placeholder.replaceWith(reading.element);
    github?.dispose();
    connection.dispose();
    trigger?.remove();
    triggers.delete(trigger);
    if (placeholder.parentNode) placeholder.replaceWith(row);
    else row.remove();
    heading.remove();
    nav.remove();
    dock.classList.remove('repository-parallel-controls', 'repository-reading-dock');
  }

  function attachRepositoryViews() {
    const lab = REPOSITORY_LABS.find(lab => document.getElementById(lab.panelId));
    const panel = lab && document.getElementById(lab.panelId);
    const dock = lab && document.getElementById(lab.dockId);
    const actions = dock?.querySelector('.repository-dock-actions');
    if (repositoryViews && (repositoryViews.panel !== panel || repositoryViews.actions !== actions
      || !repositoryViews.placeholder.isConnected || !dock?.contains(repositoryViews.heading)
      || !dock.contains(repositoryViews.nav) || !repositoryViews.controls.contains(repositoryViews.inline)
      || (repositoryViews.timeline && (!repositoryViews.controls.contains(repositoryViews.timeline.element) || !dock.contains(repositoryViews.timeline.trigger)))
      || (repositoryViews.reading && !repositoryViews.controls.contains(repositoryViews.reading.element))
      || !repositoryViews.nav.contains(repositoryViews.row)
      || (repositoryViews.github && (!repositoryViews.controls.contains(repositoryViews.github.element)
        || !dock.contains(repositoryViews.github.trigger))))) releaseRepositoryViews();
    if (!panel || !actions || repositoryViews) return;
    const row = panel.querySelector(lab.viewSwitch);
    if (!row) return;
    const timeline = lab.timeline ? mountRepositoryTimeline(dock, lab.mode) : null;
    if (lab.timeline && !timeline) return;
    let reading = null;
    if (!lab.timeline) {
      const element = dock.querySelector(':scope > .t-mid');
      if (!element) return;
      const placeholder = document.createComment('Repository reading status original position');
      element.before(placeholder);
      reading = { element, placeholder };
    }
    const placeholder = document.createComment('Repository views are presented above the dock apps.');
    row.before(placeholder);
    const heading = document.createElement('div');
    heading.className = 'repository-dock-heading';
    const controls = document.createElement('div');
    controls.className = 'repository-dock-tools';
    const nav = document.createElement('nav');
    nav.className = 'repository-view-nav';
    nav.dataset.dockSurface = '';
    nav.dataset.repositoryView = lab.mode;
    nav.setAttribute('aria-label', `${lab.label} views`);
    const inline = document.createElement('div');
    inline.id = 'repository-opacity-controls';
    inline.className = 'repository-opacity-inline';
    inline.dataset.dockSurface = '';
    inline.hidden = true;
    inline.setAttribute('role', 'group');
    inline.setAttribute('aria-label', 'Panel opacity');
    inline.innerHTML = `<button type="button" class="repository-opacity-back" aria-label="Close opacity controls" title="Close opacity controls"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m12 5-5 5 5 5"/></svg></button><div class="repository-opacity-content"><label class="repository-opacity-label" for="repository-opacity-range"><span>Panel opacity</span><output id="repository-opacity-output" for="repository-opacity-range"></output></label><input id="repository-opacity-range" type="range" min="0" max="100" step="1" aria-describedby="repository-opacity-description" /><p id="repository-opacity-description">Controls all dock surfaces, app tiles, menus, and panels. Lower is clearer; higher is more solid.</p></div>`;
    const inlineRange = inline.querySelector('input');
    const controller = new AbortController();
    inlineRange.addEventListener('input', () => { opacity = Number(inlineRange.value); render(); }, { signal: controller.signal });
    inlineRange.addEventListener('change', () => persist(), { signal: controller.signal });
    inline.querySelector('button').addEventListener('click', () => setRepositoryOpacity(false), { signal: controller.signal });
    inline.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); setRepositoryOpacity(false); }
    }, { signal: controller.signal });
    // Keep both controls independent and preserve the actual scene buttons and handlers.
    nav.append(row);
    const github = mountRepositoryGithub(dock, panel, lab.mode);
    if (github) controls.append(github.element);
    controls.append(inline);
    if (timeline) controls.append(timeline.element);
    if (reading) controls.append(reading.element);
    heading.append(controls);
    dock.prepend(heading, nav);
    dock.classList.add('repository-parallel-controls');
    dock.classList.toggle('repository-reading-dock', !lab.timeline);
    const connection = mountRepositoryViewConnection(dock, nav, actions.querySelector(`#tab-${lab.mode}`));
    repositoryViews = { panel, row, placeholder, heading, controls, timeline, reading, github, connection, nav, dock, actions, inline, range: inlineRange, output: inline.querySelector('output'), controller, open: false, trigger: null };
    render();
  }

  function attachControls() {
    // A replaced dock must not leave an open popover pointing to a detached button.
    for (const trigger of triggers) {
      if (trigger.isConnected) continue;
      if (activeTrigger === trigger) { close(); activeTrigger = null; }
      triggers.delete(trigger);
    }
    attachRepositoryViews();
    for (const id of ['timebar', 'math-timebar', 'equation-panel', ...REPOSITORY_LABS.flatMap(lab => [lab.panelId, lab.dockId])]) {
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
      if (id === lab?.dockId) {
        if (repositoryViews?.actions.closest(`#${id}`) === container) addTrigger(container);
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
  on(document, 'keydown', event => {
    if (event.key === 'Escape' && repositoryViews?.open) setRepositoryOpacity(false);
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
