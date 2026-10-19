import './repository-dock-apps.css';

const APPS = [
  { mode: 'data', label: 'Data Lab', name: 'Data', icon: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>' },
  { mode: 'activity', label: 'Activity Lab', name: 'Activity', icon: '<path d="M7 8.25v7.5M17 8.25v1.5c0 4-10 1-10 6"/><circle cx="7" cy="6" r="2.25"/><circle cx="17" cy="6" r="2.25"/><circle cx="7" cy="18" r="2.25"/>' },
];
const ATTRIBUTES = ['class', 'aria-label', 'aria-current', 'data-repository-app', 'data-tooltip-dismissed'];

/** Restyle and relocate the real links; the shared navigation/session handler stays in charge. */
export function mountRepositoryDockApps(host, mode) {
  const links = APPS.map(app => document.getElementById(`tab-${app.mode}`));
  if (links.some(link => !link)) return null;
  const lifetime = new AbortController();
  const nav = document.createElement('nav');
  nav.className = 'repository-dock-apps';
  nav.setAttribute('aria-label', 'Repository apps');
  function positionTooltip(link) {
    const tooltip = link.querySelector('.repository-app-tooltip');
    const box = link.getBoundingClientRect();
    const width = tooltip.offsetWidth;
    const naturalLeft = box.left + (box.width - width) / 2;
    const left = Math.max(8, Math.min(naturalLeft, innerWidth - width - 8));
    tooltip.style.setProperty('--tooltip-shift', `${left - naturalLeft}px`);
    tooltip.dataset.side = box.top >= tooltip.offsetHeight + 16 ? 'above' : 'below';
  }
  const moves = links.map((link, index) => {
    const app = APPS[index];
    const placeholder = document.createComment(`${link.id} original position`);
    link.before(placeholder);
    const original = { link, placeholder, children: [...link.childNodes], attributes: ATTRIBUTES.map(name => [name, link.getAttribute(name)]) };
    link.classList.add('repository-app-link', 'repository-app-tile');
    link.classList.toggle('active', app.mode === mode);
    link.dataset.repositoryApp = app.mode;
    link.setAttribute('aria-label', app.label);
    if (app.mode === mode) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
    link.innerHTML = `<span class="repository-app-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" focusable="false">${app.icon}</svg></span><span class="repository-app-label" aria-hidden="true">${app.name}</span><span class="repository-app-tooltip" aria-hidden="true">${app.label}</span>`;
    for (const event of ['pointerenter', 'pointerleave', 'focus', 'blur']) {
      link.addEventListener(event, () => { delete link.dataset.tooltipDismissed; positionTooltip(link); }, { signal: lifetime.signal });
    }
    nav.append(link);
    return original;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') for (const link of links) link.dataset.tooltipDismissed = 'true';
  }, { signal: lifetime.signal });
  window.addEventListener('resize', () => links.forEach(positionTooltip), { signal: lifetime.signal });
  host.append(nav);
  document.body.classList.add('repository-apps-docked');
  return {
    element: nav,
    links,
    dispose() {
      lifetime.abort();
      for (const { link, placeholder, children, attributes } of moves) {
        link.replaceChildren(...children);
        for (const [name, value] of attributes) {
          if (value === null) link.removeAttribute(name);
          else link.setAttribute(name, value);
        }
        placeholder.replaceWith(link);
      }
      nav.remove();
      document.body.classList.remove('repository-apps-docked');
    },
  };
}
