/** Move the existing playback controls into an independent dock disclosure. */
export function mountRepositoryTimeline(dock, mode) {
  if (!dock || !['data', 'activity'].includes(mode)) return null;
  const controls = [`#${mode}-prev`, `#${mode}-play`, '.t-mid', `#${mode}-next`, `.${mode}-speed`]
    .map(selector => dock.querySelector(`:scope > ${selector}`));
  if (controls.some(control => !control)) return null;

  const lifetime = new AbortController();
  let disposed = false;
  const element = document.createElement('div');
  element.id = 'repository-timeline-controls';
  element.className = 'repository-timeline-controls';
  element.dataset.dockSurface = '';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Timeline');
  const moves = controls.map(node => {
    const placeholder = document.createComment('Repository timeline control original position');
    node.before(placeholder);
    element.append(node);
    return { node, placeholder };
  });

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = 'repository-timeline-trigger';
  trigger.className = 'repository-app-tile';
  trigger.dataset.repositoryApp = 'timeline';
  trigger.setAttribute('aria-label', 'Timeline');
  trigger.setAttribute('aria-controls', element.id);
  trigger.title = 'Timeline';
  trigger.innerHTML = '<span class="repository-app-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" focusable="false"><path d="M4 6h16M4 18h16M7 3v6M17 15v6"/><path d="m9 10 5 3-5 3Z"/></svg><span class="repository-timeline-status" aria-hidden="true"></span></span><span class="repository-app-label" aria-hidden="true">Timeline</span>';
  dock.append(element);
  dock.insertBefore(trigger, [...dock.children].find(child => !child.classList.contains('panel-dock-grip')) ?? null);

  function syncPlayback() {
    if (disposed) return;
    const playing = controls[1].getAttribute('aria-pressed') === 'true';
    const label = `Timeline, ${playing ? 'playing' : 'paused'}`;
    for (const node of [trigger, element]) {
      node.dataset.timelinePlaying = String(playing);
      node.setAttribute('aria-label', label);
      node.title = label;
    }
  }
  const playbackObserver = new MutationObserver(syncPlayback);
  playbackObserver.observe(controls[1], { attributes: true, attributeFilter: ['aria-pressed'] });
  syncPlayback();

  // Anchor the app to the actual scrubber, including responsive and dragged docks.
  const scrubber = controls[2].querySelector('input[type="range"]');
  let anchorFrame = 0;
  let anchorRatio = 0.5;
  function alignAnchor() {
    anchorFrame = 0;
    if (disposed || dock.classList.contains('is-dock-collapsed')) return;
    const box = dock.getBoundingClientRect();
    const style = getComputedStyle(dock);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const contentWidth = dock.clientWidth - paddingLeft - (parseFloat(style.paddingRight) || 0);
    if (contentWidth <= 0) return;
    const contentLeft = box.left + borderLeft + paddingLeft;
    const slider = scrubber?.getBoundingClientRect();
    if (slider?.width) anchorRatio = (slider.left + slider.width / 2 - contentLeft) / contentWidth;
    trigger.style.setProperty('--timeline-center', `${anchorRatio * contentWidth}px`);
    if (slider?.width && !element.hidden) {
      const tray = element.getBoundingClientRect();
      const trayBorder = parseFloat(getComputedStyle(element).borderLeftWidth) || 0;
      element.style.setProperty('--timeline-connector-x', `${slider.left + slider.width / 2 - tray.left - trayBorder}px`);
      element.style.setProperty('--timeline-connector-height', `${Math.max(0, trigger.getBoundingClientRect().top - tray.bottom + 4)}px`);
    }
  }
  function scheduleAnchor() {
    if (!disposed && !anchorFrame) anchorFrame = requestAnimationFrame(alignAnchor);
  }
  const anchorObserver = new ResizeObserver(scheduleAnchor);
  for (const node of [dock, element, scrubber].filter(Boolean)) anchorObserver.observe(node);
  window.addEventListener('resize', scheduleAnchor, { signal: lifetime.signal });

  function setOpen(open) {
    if (disposed) return;
    const expanded = Boolean(open);
    const restoreFocus = !expanded && element.contains(document.activeElement);
    element.hidden = !expanded;
    trigger.setAttribute('aria-expanded', String(expanded));
    dock.classList.toggle('repository-timeline-open', expanded);
    scheduleAnchor();
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', () => setOpen(element.hidden), { signal: lifetime.signal });
  trigger.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }, { signal: lifetime.signal });
  element.addEventListener('keydown', event => {
    // Native range, select and button keys must not also drive global playback.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }, { signal: lifetime.signal });
  setOpen(true);

  return {
    element,
    trigger,
    setOpen,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      playbackObserver.disconnect();
      anchorObserver.disconnect();
      cancelAnimationFrame(anchorFrame);
      for (const { node, placeholder } of moves) {
        if (placeholder.parentNode) placeholder.replaceWith(node);
        else node.remove();
      }
      element.remove();
      trigger.remove();
      dock.classList.remove('repository-timeline-open');
    },
  };
}
