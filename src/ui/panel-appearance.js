import './glass-surfaces.css';
import './panel-appearance.css';

const STORAGE_KEY = 'quirq-observatory.panel-opacity.v1';
const DEFAULT_OPACITY = 62;
const ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m10 2 8 4-8 4-8-4 8-4Z"/><path d="m2 10 8 4 8-4M2 14l8 4 8-4"/></svg>';

function readOpacity(raw) {
  try {
    const value = JSON.parse(raw);
    return Number.isInteger(value) && value >= 20 && value <= 100 ? value : DEFAULT_OPACITY;
  } catch { return DEFAULT_OPACITY; }
}

/** One appearance preference and popover shared by all instrument controls. */
export function mountPanelAppearance() {
  const lifetime = new AbortController();
  const on = (target, event, handler, options = {}) => target.addEventListener(event, handler, { ...options, signal: lifetime.signal });
  let opacity = DEFAULT_OPACITY;
  try { opacity = readOpacity(localStorage.getItem(STORAGE_KEY)); } catch { /* Session controls remain available. */ }
  let activeTrigger = null;
  const triggers = new Set();
  const observed = new WeakSet();
  const panelObservers = [];
  const popover = document.createElement('div');
  popover.id = 'glass-appearance-popover';
  popover.setAttribute('popover', 'auto');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-labelledby', 'glass-appearance-title');
  popover.innerHTML = `
    <div class="glass-popover-heading"><span class="glass-popover-icon">${ICON}</span><div><h2 id="glass-appearance-title">Liquid glass</h2><p>Appearance across all labs.</p></div><button class="glass-popover-close" type="button" aria-label="Close appearance controls">×</button></div>
    <label class="glass-opacity-label" for="glass-opacity-range"><span>Panel opacity</span><output id="glass-opacity-output" for="glass-opacity-range"></output></label>
    <input id="glass-opacity-range" type="range" min="20" max="100" step="1" aria-describedby="glass-opacity-description" />
    <div class="glass-opacity-scale" aria-hidden="true"><span>Airy</span><span>Solid</span></div>
    <p id="glass-opacity-description">Applies to side panels and playback bars.</p>
    <div class="glass-popover-footer"><span id="glass-opacity-status" role="status">Browser preference</span><button class="glass-opacity-reset" type="button">Reset</button></div>`;
  document.body.append(popover);
  const range = popover.querySelector('input');
  const output = popover.querySelector('output');
  const status = popover.querySelector('#glass-opacity-status');
  const nativePopover = typeof popover.showPopover === 'function';
  if (!nativePopover) popover.hidden = true;
  const isOpen = () => nativePopover ? popover.matches(':popover-open') : !popover.hidden;

  function render() {
    document.documentElement.style.setProperty('--glass-opacity', String(opacity / 100));
    document.documentElement.style.setProperty('--glass-opacity-percent', `${(opacity - 20) / 80 * 100}%`);
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
    button.className = 'glass-opacity-trigger';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', popover.id);
    button.setAttribute('popovertarget', popover.id);
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = `${ICON}<span class="glass-opacity-text">Opacity</span><span class="glass-opacity-value"></span>`;
    if (after) after.after(button);
    else host.append(button);
    triggers.add(button);
    on(button, 'click', event => { event.preventDefault(); open(button); });
    on(button, 'keydown', event => event.stopPropagation());
    render();
  }

  function attachControls() {
    for (const id of ['timebar', 'math-timebar', 'data-timebar', 'equation-panel']) {
      const container = document.getElementById(id);
      if (!container) continue;
      if (!observed.has(container)) {
        observed.add(container);
        // Only direct children: scene labels and live readouts update every frame.
        const observer = new MutationObserver(attachControls);
        observer.observe(container, { childList: true });
        panelObservers.push(observer);
      }
      if (id === 'equation-panel') {
        const row = container.querySelector('#eq-speed')?.previousElementSibling;
        if (row) { row.classList.add('glass-speed-heading'); addTrigger(row); }
      } else {
        const midpoint = container.querySelector('.t-mid');
        if (midpoint) addTrigger(container, id === 'data-timebar' ? container.querySelector('.data-speed') : midpoint);
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
    popover.remove();
  };
}
