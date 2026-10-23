// Repository labs have separate entries; existing instruments retain their runtime.
import { modeFromLocation } from './nav/routes.js';
import { mountLogoEditor } from './branding/logo-editor.js';
import { mountPanelAppearance } from './ui/panel-appearance.js';
import { mountFloatingLayout } from './ui/floating-layout.js';
import { REPOSITORY_LABS } from './ui/repository-labs.js';
import { flushRepositorySession } from './repository/session.js';

const navigation = new AbortController();
// Full-page lab links wait for the pending dataset write; small selections save synchronously.
document.addEventListener('click', async event => {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.hasAttribute('download')) return;
  const url = new URL(link.href, location.href);
  // Reading a section within the current document must not reload the lab.
  if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search && url.hash
    && modeFromLocation(url) === modeFromLocation({ pathname: location.pathname, hash: '' })) return;
  const repositoryModes = REPOSITORY_LABS.map(lab => lab.mode);
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
const repositoryLab = REPOSITORY_LABS.find(lab => lab.mode === mode);
if (repositoryLab) {
  const label = repositoryLab.label;
  // Keep each import in its own loader: combining the imports in a conditional
  // can make the production preload helper attach only one lab's stylesheet.
  const loaders = {
    about: async () => {
      const { mountAboutLab } = await import('./about-lab/app.js');
      return mountAboutLab();
    },
    activity: async () => {
      const { mountActivityLab } = await import('./activity-lab/app.js');
      return mountActivityLab();
    },
    data: async () => {
      const { mountDataLab } = await import('./data-lab/app.js');
      return mountDataLab();
    },
  };
  loaders[mode]()
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
