export const DEFAULT_LOGO_URL = '/quirq-logo.svg';
export const MAX_LOGO_DATA_URL_LENGTH = 1_500_000;

const STORAGE_KEY = 'quirq-observatory.custom-logo.v1';
const PNG_PREFIX = 'data:image/png;base64,';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isPngDataUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_LOGO_DATA_URL_LENGTH || !value.startsWith(PNG_PREFIX)) return false;
  const encoded = value.slice(PNG_PREFIX.length);
  // Check the PNG signature and base64 without decoding a large image during startup.
  if (!encoded.startsWith('iVBORw0KGgo') || encoded.length < 44 || encoded.length % 4 !== 0) return false;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const body = padding ? encoded.slice(0, -padding) : encoded;
  if (/[^A-Za-z0-9+/]/.test(body)) return false;
  const last = BASE64_ALPHABET.indexOf(body.at(-1));
  return padding === 2 ? (last & 15) === 0 : padding === 1 ? (last & 3) === 0 : true;
}

function parseStoredLogo(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_LOGO_DATA_URL_LENGTH + 100) return null;
  try {
    const record = JSON.parse(raw);
    return record?.version === 1 && isPngDataUrl(record.dataUrl) ? record.dataUrl : null;
  } catch {
    return null;
  }
}

/** Browser-local branding. Storage is read lazily so unavailable storage never blocks startup. */
export function createLogoPreference({ getStorage = () => globalThis.localStorage, eventTarget } = {}) {
  let dataUrl = null;
  let initialized = false;
  let storageListenerTarget = null;
  const listeners = new Set();

  const snapshot = () => ({ url: dataUrl || DEFAULT_LOGO_URL, custom: dataUrl !== null });

  function update(nextDataUrl, notify = false) {
    if (nextDataUrl === dataUrl) return;
    dataUrl = nextDataUrl;
    if (!notify) return;
    const value = snapshot();
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(value);
      } catch (error) {
        // A broken view must not turn a completed storage write into an apparent failure.
        globalThis.reportError?.(error);
      }
    }
  }

  function refresh() {
    initialized = true;
    try {
      update(parseStoredLogo(getStorage().getItem(STORAGE_KEY)));
    } catch {
      // Keep the last known logo if browser privacy settings make storage unavailable.
    }
  }

  function onStorage(event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    if (event.storageArea) {
      try {
        if (event.storageArea !== getStorage()) return;
      } catch {
        return;
      }
    }
    update(event.key === null ? null : parseStoredLogo(event.newValue), true);
  }

  function getLogoUrl() {
    if (!initialized) refresh();
    return snapshot().url;
  }

  function hasCustomLogo() {
    if (!initialized) refresh();
    return snapshot().custom;
  }

  function saveCustomLogo(nextDataUrl) {
    if (!isPngDataUrl(nextDataUrl)) {
      throw new Error(typeof nextDataUrl === 'string' && nextDataUrl.length > MAX_LOGO_DATA_URL_LENGTH
        ? 'The logo is too large to save. Choose a smaller image.'
        : 'The logo must be a valid PNG image.');
    }
    if (!initialized) refresh();
    try {
      getStorage().setItem(STORAGE_KEY, JSON.stringify({ version: 1, dataUrl: nextDataUrl }));
    } catch (cause) {
      throw new Error('Your browser could not save this logo. Allow site storage or free some space, then try again.', { cause });
    }
    update(nextDataUrl, true);
  }

  function resetCustomLogo() {
    if (!initialized) refresh();
    try {
      getStorage().removeItem(STORAGE_KEY);
    } catch (cause) {
      throw new Error('Your browser could not reset the logo. Allow site storage, then try again.', { cause });
    }
    update(null, true);
  }

  function subscribeLogo(listener) {
    if (typeof listener !== 'function') throw new TypeError('A logo listener must be a function.');
    if (listeners.size === 0) refresh();
    listeners.add(listener);
    if (!storageListenerTarget) {
      const target = eventTarget === undefined ? globalThis.window : eventTarget;
      if (target?.addEventListener) {
        target.addEventListener('storage', onStorage);
        storageListenerTarget = target;
      }
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && storageListenerTarget) {
        storageListenerTarget.removeEventListener('storage', onStorage);
        storageListenerTarget = null;
      }
    };
  }

  return { getLogoUrl, hasCustomLogo, saveCustomLogo, resetCustomLogo, subscribeLogo };
}

const browserLogoPreference = createLogoPreference();
export const { getLogoUrl, hasCustomLogo, saveCustomLogo, resetCustomLogo, subscribeLogo } = browserLogoPreference;
