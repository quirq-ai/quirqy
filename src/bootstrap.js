// Repository labs have separate entries; existing instruments retain their runtime.
import { modeFromLocation } from './nav/routes.js';
import { mountLogoEditor } from './branding/logo-editor.js';
import { mountPanelAppearance } from './ui/panel-appearance.js';
import { mountFloatingLayout } from './ui/floating-layout.js';
import { flushRepositorySession } from './repository/session.js';

const navigation = new AbortController();
// Full-page lab links wait for the pending dataset write; small selections save synchronously.
document.addEventListener('click', async event => {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.hasAttribute('download')) return;
  const url = new URL(link.href, location.href);
  const repositoryModes = ['data', 'activity'];
  if (url.origin !== location.origin || !(repositoryModes.includes(modeFromLocation()) || repositoryModes.includes(modeFromLocation(url)))) return;
  event.preventDefault();
  await flushRepositorySession();
  location.assign(url.href);
}, { signal: navigation.signal });

const disposeLogoEditor = mountLogoEditor();
const disposePanelAppearance = mountPanelAppearance();
const disposeFloatingLayout = mountFloatingLayout();
if (import.meta.hot) import.meta.hot.dispose(() => {
  navigation.abort();
  disposeLogoEditor();
  disposeFloatingLayout();
  disposePanelAppearance();
});

const mode = modeFromLocation();
if (mode === 'data' || mode === 'activity') {
  const label = mode === 'activity' ? 'Activity Lab' : 'Data Lab';
  const entry = mode === 'activity' ? import('./activity-lab/app.js') : import('./data-lab/app.js');
  entry.then(module => mode === 'activity' ? module.mountActivityLab() : module.mountDataLab())
    .catch((error) => {
      console.error(`${label} could not start:`, error);
      document.getElementById('loading')?.remove();
      const message = document.createElement('p');
      message.className = 'panel';
      message.setAttribute('role', 'alert');
      message.style.cssText = 'top:80px;right:16px;width:min(360px,calc(100vw - 32px));padding:20px;z-index:100;line-height:1.6';
      message.textContent = `${label} could not start: ${error.message}. Reload to try again.`;
      document.body.append(message);
    });
} else {
  import('./main.js');
}
