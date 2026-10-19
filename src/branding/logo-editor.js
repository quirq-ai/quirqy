import './logo-editor.css';
import {
  DEFAULT_LOGO_URL, MAX_LOGO_DATA_URL_LENGTH,
  getLogoUrl, hasCustomLogo, saveCustomLogo, resetCustomLogo, subscribeLogo,
} from './logo-preference.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_LOGO_EDGE = 512;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);

/** Decode uploads as images and store a bounded raster, preserving transparency. */
export async function prepareLogo(file) {
  if (!file || !IMAGE_TYPES.has(file.type)) {
    throw new Error('Choose a PNG, JPG, WebP or SVG image.');
  }
  if (!file.size) throw new Error('This file is empty. Choose another image.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Choose an image smaller than 5 MB.');

  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('This image could not be opened. Try another file.'));
      image.src = url;
    });
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
      throw new Error('This image is too large to use. Choose an image under 40 megapixels.');
    }
    const scale = Math.min(1, MAX_LOGO_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not prepare this image. Try again.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let dataUrl;
    try { dataUrl = canvas.toDataURL('image/png'); }
    catch { throw new Error('This image could not be saved. Try a PNG or JPG file.'); }
    if (dataUrl.length > MAX_LOGO_DATA_URL_LENGTH) {
      throw new Error('This image is too detailed to save. Try a smaller or simpler logo.');
    }
    return dataUrl;
  } finally {
    image.onload = image.onerror = null;
    URL.revokeObjectURL(url);
  }
}

/** Shared branding controls for every instrument, independent of scene settings. */
export function mountLogoEditor() {
  const triggerSelector = '[data-logo-editor-trigger], #brand-logo-button';
  const lifetime = new AbortController();
  const listen = (node, event, handler, options = {}) => node.addEventListener(event, handler, { ...options, signal: lifetime.signal });
  const dialog = document.createElement('dialog');
  dialog.id = 'logo-editor';
  dialog.setAttribute('aria-labelledby', 'logo-editor-title');
  dialog.setAttribute('aria-describedby', 'logo-editor-description');
  dialog.innerHTML = `
    <div class="logo-editor-header">
      <h2 id="logo-editor-title">Your logo</h2>
      <button type="button" class="logo-editor-close" aria-label="Close logo editor">×</button>
    </div>
    <p id="logo-editor-description">Make Observatory yours. Your logo stays saved in this browser.</p>
    <div class="logo-editor-preview"><img alt="Current logo preview" /></div>
    <button type="button" class="btn logo-editor-upload" autofocus>Upload image</button>
    <input id="logo-upload" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden />
    <p class="logo-editor-formats">PNG, JPG, WebP or SVG · Up to 5 MB</p>
    <p id="logo-editor-status" role="status" aria-live="polite"></p>
    <div class="logo-editor-actions">
      <button type="button" class="btn logo-editor-reset">Reset to default</button>
      <button type="button" class="btn logo-editor-done">Done</button>
    </div>`;
  document.body.append(dialog);
  const preview = dialog.querySelector('.logo-editor-preview img');
  const upload = dialog.querySelector('.logo-editor-upload');
  const input = dialog.querySelector('input');
  const reset = dialog.querySelector('.logo-editor-reset');
  const done = dialog.querySelector('.logo-editor-done');
  const status = dialog.querySelector('#logo-editor-status');
  let busy = false, generation = 0;
  let opener = null, restoreFocusOnClose = true;

  function editorTrigger(event) {
    const trigger = event.target instanceof Element ? event.target.closest(triggerSelector) : null;
    // The dock logo controls movement and collapse; editing has its own button.
    return trigger && !trigger.closest('.panel-dock-grip') && !trigger.disabled ? trigger : null;
  }

  function finishClose({ restoreFocus = restoreFocusOnClose } = {}) {
    if (!opener) return;
    generation += 1;
    input.value = '';
    setBusy(false);
    opener.setAttribute('aria-expanded', 'false');
    if (restoreFocus && opener.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
    opener = null;
  }

  function close({ restoreFocus = true } = {}) {
    if (!dialog.open) return;
    restoreFocusOnClose = restoreFocus;
    dialog.close();
    finishClose();
  }

  function showStatus(message = '', error = false) {
    status.textContent = message;
    status.dataset.state = error ? 'error' : 'success';
  }
  function setBusy(next) {
    busy = next;
    upload.disabled = next;
    done.disabled = next;
    reset.disabled = next || !hasCustomLogo();
    dialog.setAttribute('aria-busy', String(next));
  }
  function applyLogo() {
    const url = getLogoUrl();
    const custom = hasCustomLogo();
    for (const image of [...document.querySelectorAll('.brand-mark, .load-logo'), preview]) {
      image.src = url;
      image.alt = custom ? 'Custom logo' : 'quirq observatory';
      image.onerror = () => {
        image.onerror = null;
        image.src = DEFAULT_LOGO_URL;
      };
    }
    for (const trigger of document.querySelectorAll(triggerSelector)) {
      trigger.classList.toggle('has-custom-logo', custom);
    }
    const favicon = document.querySelector('link[rel="icon"]');
    if (favicon) {
      favicon.type = custom ? 'image/png' : 'image/svg+xml';
      favicon.href = url;
    }
    reset.disabled = busy || !custom;
  }
  const unsubscribe = subscribeLogo(applyLogo);
  applyLogo();

  // Dock Edit buttons mount after bootstrap, so their clicks use delegation.
  listen(document, 'click', event => {
    const trigger = editorTrigger(event);
    if (!trigger || dialog.open) return;
    event.preventDefault();
    finishClose({ restoreFocus: false });
    opener = trigger;
    restoreFocusOnClose = true;
    showStatus();
    document.dispatchEvent(new CustomEvent('observatory:popover-open', { detail: dialog.id }));
    dialog.showModal();
    opener.setAttribute('aria-expanded', 'true');
  });
  // Capture keeps scene shortcuts out while preserving native button activation.
  listen(document, 'keydown', event => {
    if (editorTrigger(event)) event.stopPropagation();
  }, { capture: true });
  listen(dialog, 'keydown', event => event.stopPropagation());
  listen(dialog.querySelector('.logo-editor-close'), 'click', () => close());
  listen(done, 'click', () => close());
  listen(document, 'observatory:popover-open', event => {
    if (event.detail !== dialog.id) close({ restoreFocus: false });
  });
  listen(dialog, 'close', () => {
    // A queued close event may arrive after a different trigger reopens the dialog.
    if (dialog.open) return;
    finishClose();
  });
  listen(upload, 'click', () => input.click());
  listen(input, 'change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const request = ++generation;
    setBusy(true);
    showStatus('Preparing your logo…');
    try {
      const dataUrl = await prepareLogo(file);
      if (request !== generation) return;
      saveCustomLogo(dataUrl);
      showStatus('Logo saved.');
    } catch (error) {
      if (request === generation) showStatus(error.message || 'Could not save this logo. Please try again.', true);
    } finally {
      if (request === generation) {
        input.value = '';
        setBusy(false);
      }
    }
  });
  listen(reset, 'click', () => {
    try {
      resetCustomLogo();
      showStatus('Default logo restored.');
    } catch (error) {
      showStatus(error.message || 'Could not reset the saved logo. Please try again.', true);
    }
  });

  return () => {
    generation += 1;
    lifetime.abort();
    unsubscribe();
    opener?.setAttribute('aria-expanded', 'false');
    opener = null;
    dialog.remove();
  };
}
