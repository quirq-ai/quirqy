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
  trigger.innerHTML = '<span class="repository-app-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" focusable="false"><path d="M4 6h16M4 18h16M7 3v6M17 15v6"/><path d="m9 10 5 3-5 3Z"/></svg></span><span class="repository-app-label" aria-hidden="true">Timeline</span>';
  dock.append(element);
  dock.insertBefore(trigger, [...dock.children].find(child => !child.classList.contains('panel-dock-grip')) ?? null);

  function setOpen(open) {
    if (disposed) return;
    const expanded = Boolean(open);
    const restoreFocus = !expanded && element.contains(document.activeElement);
    element.hidden = !expanded;
    trigger.setAttribute('aria-expanded', String(expanded));
    dock.classList.toggle('repository-timeline-open', expanded);
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
