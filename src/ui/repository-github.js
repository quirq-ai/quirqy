import { REPOSITORY_LABS } from './repository-labs.js';

/** Present the lab's original repository connection controls in the dock. */
export function mountRepositoryGithub(dock, panel, mode) {
  if (!dock || !panel || !REPOSITORY_LABS.some(lab => lab.mode === mode)) return null;
  const title = panel.querySelector(`#${mode}-source-kind`)?.closest('.section-title');
  const form = panel.querySelector(`#${mode}-source-form`);
  const input = form?.querySelector(`#${mode}-repository-url`);
  const meta = panel.querySelector(`#${mode}-repository-meta, .${mode}-repo-meta`);
  const status = panel.querySelector(`#${mode}-status`);
  const actions = panel.querySelector(`.${mode}-source-actions`);
  if (!title || !form || !input || !meta || !status) return null;

  const lifetime = new AbortController();
  let disposed = false;
  let fitFrame = 0;
  const element = document.createElement('div');
  element.id = 'repository-github-controls';
  element.className = 'repository-github-controls';
  element.dataset.dockSurface = '';
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', 'GitHub repository');
  element.hidden = true;
  const header = document.createElement('div');
  header.className = 'repository-github-heading';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'repository-github-close';
  close.setAttribute('aria-label', 'Close GitHub controls');
  close.title = 'Close GitHub controls';
  close.textContent = '×';
  const moves = [title, form, meta, status, actions].filter(Boolean).map(node => {
    const placeholder = document.createComment('Repository connection control original position');
    node.before(placeholder);
    return { node, placeholder };
  });
  header.append(title, close);
  element.append(header, meta, form, status);
  if (actions) element.append(actions);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = 'repository-github-trigger';
  trigger.className = 'repository-app-tile';
  trigger.dataset.repositoryApp = 'github';
  trigger.setAttribute('aria-label', 'GitHub');
  trigger.title = 'GitHub';
  trigger.setAttribute('aria-controls', element.id);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = '<span class="repository-app-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" focusable="false"><path d="M9 19c-4.3 1.3-4.3-2.5-6-3m12 6v-3.9a3.4 3.4 0 0 0-.94-2.66c3.14-.35 6.44-1.54 6.44-7a5.4 5.4 0 0 0-1.5-3.75A5 5 0 0 0 18.91 1S17.73.65 15 2.48a13.4 13.4 0 0 0-6 0C6.27.65 5.09 1 5.09 1A5 5 0 0 0 5 4.69a5.4 5.4 0 0 0-1.5 3.77c0 5.42 3.3 6.61 6.44 7A3.4 3.4 0 0 0 9 18.1V22"/></svg></span><span class="repository-app-label" aria-hidden="true">GitHub</span>';
  dock.append(element);
  dock.insertBefore(trigger, dock.querySelector(':scope > #repository-timeline-trigger'));

  function fitPanel() {
    fitFrame = 0;
    if (disposed || element.hidden || !dock.isConnected || !element.isConnected
      || dock.classList.contains('is-dock-collapsed')) return;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const otherHeight = dock.getBoundingClientRect().height - element.getBoundingClientRect().height;
    const maxHeight = `${Math.floor(Math.min(280, Math.max(80, viewportHeight - otherHeight - 32)))}px`;
    if (element.style.getPropertyValue('--repository-github-max-height') !== maxHeight) {
      element.style.setProperty('--repository-github-max-height', maxHeight);
    }
  }
  function scheduleFit() {
    if (!disposed && !element.hidden && !fitFrame) fitFrame = requestAnimationFrame(fitPanel);
  }
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(dock);
  observer.observe(element);
  window.addEventListener('resize', scheduleFit, { signal: lifetime.signal });
  window.visualViewport?.addEventListener('resize', scheduleFit, { signal: lifetime.signal });

  function setOpen(open) {
    if (disposed) return;
    const expanded = Boolean(open);
    const restoreFocus = !expanded && element.contains(document.activeElement);
    element.hidden = !expanded;
    trigger.setAttribute('aria-expanded', String(expanded));
    dock.classList.toggle('repository-github-open', expanded);
    if (expanded) {
      document.dispatchEvent(new CustomEvent('observatory:popover-open', { detail: element.id }));
      scheduleFit();
      input.focus({ preventScroll: true });
    } else {
      cancelAnimationFrame(fitFrame);
      fitFrame = 0;
      if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    }
  }
  function onKeydown(event) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }
  trigger.addEventListener('click', () => setOpen(element.hidden), { signal: lifetime.signal });
  trigger.addEventListener('keydown', onKeydown, { signal: lifetime.signal });
  element.addEventListener('keydown', onKeydown, { signal: lifetime.signal });
  close.addEventListener('click', () => setOpen(false), { signal: lifetime.signal });

  return {
    element,
    trigger,
    setOpen,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      for (const { node, placeholder } of moves) {
        if (placeholder.parentNode) placeholder.replaceWith(node);
        else node.remove();
      }
      element.style.removeProperty('--repository-github-max-height');
      element.remove();
      trigger.remove();
      dock.classList.remove('repository-github-open');
    },
  };
}
