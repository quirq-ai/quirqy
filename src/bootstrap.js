// Data Lab is a separate entry point: existing instruments retain their runtime.
import { modeFromLocation } from './nav/routes.js';
import { mountLogoEditor } from './branding/logo-editor.js';
import { mountPanelAppearance } from './ui/panel-appearance.js';
import { mountFloatingLayout } from './ui/floating-layout.js';

const disposeLogoEditor = mountLogoEditor();
const disposePanelAppearance = mountPanelAppearance();
const disposeFloatingLayout = mountFloatingLayout();
if (import.meta.hot) import.meta.hot.dispose(() => {
  disposeLogoEditor();
  disposeFloatingLayout();
  disposePanelAppearance();
});

if (modeFromLocation() === 'data') {
  import('./data-lab/app.js')
    .then(({ mountDataLab }) => mountDataLab())
    .catch((error) => {
      console.error('Data Lab could not start:', error);
      document.getElementById('loading')?.remove();
      const message = document.createElement('p');
      message.className = 'panel';
      message.setAttribute('role', 'alert');
      message.style.cssText = 'top:80px;right:16px;width:min(360px,calc(100vw - 32px));padding:20px;z-index:100;line-height:1.6';
      message.textContent = `Data Lab could not start: ${error.message}. Reload to try again.`;
      document.body.append(message);
    });
} else {
  import('./main.js');
}
