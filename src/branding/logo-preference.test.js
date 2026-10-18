import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogoPreference, DEFAULT_LOGO_URL, MAX_LOGO_DATA_URL_LENGTH } from './logo-preference.js';

const KEY = 'quirq-observatory.custom-logo.v1';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const OTHER_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==';
const record = dataUrl => JSON.stringify({ version: 1, dataUrl });

class MemoryStorage {
  values = new Map();
  reads = 0;
  getItem(key) { this.reads++; return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

class StorageEvents {
  listeners = new Set();
  additions = 0;
  removals = 0;
  addEventListener(type, listener) {
    assert.equal(type, 'storage');
    this.additions++;
    this.listeners.add(listener);
  }
  removeEventListener(type, listener) {
    assert.equal(type, 'storage');
    this.removals++;
    this.listeners.delete(listener);
  }
  dispatch(event) { for (const listener of this.listeners) listener(event); }
}

function setup(raw) {
  const storage = new MemoryStorage();
  if (raw !== undefined) storage.setItem(KEY, raw);
  const events = new StorageEvents();
  const preference = createLogoPreference({ getStorage: () => storage, eventTarget: events });
  return { storage, events, preference };
}

test('startup is lazy and restored logo reads remain cheap for rendering', () => {
  const { storage, events, preference } = setup(record(PNG));
  assert.equal(storage.reads, 0);
  assert.equal(events.additions, 0);
  assert.equal(preference.getLogoUrl(), PNG);
  assert.equal(preference.hasCustomLogo(), true);
  for (let i = 0; i < 100; i++) assert.equal(preference.getLogoUrl(), PNG);
  assert.equal(storage.reads, 1);
  assert.equal(events.additions, 0);
});

test('missing, malformed, unsupported and oversized stored records fall back to the default', () => {
  const invalid = [
    undefined, '', '{broken', 'null', '[]', '{}', record(null),
    JSON.stringify({ version: 2, dataUrl: PNG }),
    JSON.stringify({ version: '1', dataUrl: PNG }),
    record(PNG.replace('image/png', 'image/svg+xml')),
    record('data:image/png;base64,aGVsbG8='),
    record(PNG.slice(0, -1)), record(PNG.replace('AAANS', 'AA!NS')),
    record(PNG.replace('AAANS', 'AA=NS')),
    record(PNG.slice(0, -2) + 'J='), // Nonzero padding bits are not canonical base64.
    record('data:image/png;base64,' + 'A'.repeat(MAX_LOGO_DATA_URL_LENGTH)),
  ];
  for (const raw of invalid) {
    const { preference } = setup(raw);
    assert.equal(preference.getLogoUrl(), DEFAULT_LOGO_URL);
    assert.equal(preference.hasCustomLogo(), false);
  }
});

test('saving persists a versioned PNG and notifies views in the same tab', () => {
  const { storage, preference } = setup();
  const changes = [];
  const unsubscribe = preference.subscribeLogo(value => changes.push(value));
  assert.deepEqual(changes, []);
  preference.saveCustomLogo(PNG);
  assert.deepEqual(JSON.parse(storage.getItem(KEY)), { version: 1, dataUrl: PNG });
  assert.deepEqual(changes, [{ url: PNG, custom: true }]);
  assert.equal(preference.getLogoUrl(), PNG);
  const reloaded = createLogoPreference({ getStorage: () => storage, eventTarget: null });
  assert.equal(reloaded.getLogoUrl(), PNG);
  preference.saveCustomLogo(PNG);
  assert.equal(changes.length, 1);
  unsubscribe();
});

test('invalid uploads never replace the current persisted or visible logo', () => {
  const { storage, preference } = setup(record(PNG));
  const changes = [];
  preference.subscribeLogo(value => changes.push(value));
  for (const dataUrl of [null, 'https://example.com/logo.png', 'data:image/svg+xml;base64,PHN2Zz4=', PNG + '!', 'x'.repeat(MAX_LOGO_DATA_URL_LENGTH + 1)]) {
    assert.throws(() => preference.saveCustomLogo(dataUrl), /valid PNG|too large/);
    assert.equal(preference.getLogoUrl(), PNG);
    assert.equal(storage.getItem(KEY), record(PNG));
  }
  assert.deepEqual(changes, []);
});

test('quota and write failures preserve the previous logo without reporting a change', () => {
  const { storage, preference } = setup(record(PNG));
  const changes = [];
  preference.subscribeLogo(value => changes.push(value));
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => preference.saveCustomLogo(OTHER_PNG), /could not save this logo/);
  assert.equal(preference.getLogoUrl(), PNG);
  assert.equal(preference.hasCustomLogo(), true);
  assert.equal(storage.getItem(KEY), record(PNG));
  assert.deepEqual(changes, []);
});

test('blocked storage getters and reads never prevent default branding or imply successful persistence', () => {
  for (const getStorage of [
    () => { throw new Error('SecurityError'); },
    () => ({ getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } }),
    () => undefined,
  ]) {
    const preference = createLogoPreference({ getStorage, eventTarget: null });
    assert.equal(preference.getLogoUrl(), DEFAULT_LOGO_URL);
    assert.equal(preference.hasCustomLogo(), false);
    const changes = [];
    preference.subscribeLogo(value => changes.push(value));
    assert.throws(() => preference.saveCustomLogo(PNG), /could not save this logo/);
    assert.throws(() => preference.resetCustomLogo(), /could not reset the logo/);
    assert.equal(preference.getLogoUrl(), DEFAULT_LOGO_URL);
    assert.deepEqual(changes, []);
  }
});

test('reset removes only the custom logo and notifies views after persistence succeeds', () => {
  const { storage, preference } = setup(record(PNG));
  storage.setItem('unrelated', 'keep');
  const changes = [];
  preference.subscribeLogo(value => changes.push(value));
  preference.resetCustomLogo();
  assert.equal(storage.getItem(KEY), null);
  assert.equal(storage.getItem('unrelated'), 'keep');
  assert.equal(preference.getLogoUrl(), DEFAULT_LOGO_URL);
  assert.equal(preference.hasCustomLogo(), false);
  assert.deepEqual(changes, [{ url: DEFAULT_LOGO_URL, custom: false }]);
});

test('failed reset leaves the current custom logo intact', () => {
  const { storage, preference } = setup(record(PNG));
  const changes = [];
  preference.subscribeLogo(value => changes.push(value));
  storage.removeItem = () => { throw new Error('SecurityError'); };
  assert.throws(() => preference.resetCustomLogo(), /could not reset the logo/);
  assert.equal(preference.getLogoUrl(), PNG);
  assert.equal(storage.getItem(KEY), record(PNG));
  assert.deepEqual(changes, []);
});

test('other tabs update views on upload, malformed values, removal and storage clear', () => {
  const { storage, events, preference } = setup();
  const changes = [];
  preference.subscribeLogo(value => changes.push(value));
  function externalChange(newValue) {
    if (newValue === null) storage.removeItem(KEY);
    else storage.setItem(KEY, newValue);
    events.dispatch({ key: KEY, newValue, storageArea: storage });
  }
  externalChange(record(PNG));
  assert.equal(preference.getLogoUrl(), PNG);
  externalChange('{bad');
  assert.equal(preference.getLogoUrl(), DEFAULT_LOGO_URL);
  externalChange(record(OTHER_PNG));
  externalChange(null);
  externalChange(record(PNG));
  storage.values.clear();
  events.dispatch({ key: null, newValue: null, storageArea: storage });
  assert.equal(preference.getLogoUrl(), DEFAULT_LOGO_URL);
  assert.deepEqual(changes, [
    { url: PNG, custom: true }, { url: DEFAULT_LOGO_URL, custom: false },
    { url: OTHER_PNG, custom: true }, { url: DEFAULT_LOGO_URL, custom: false },
    { url: PNG, custom: true }, { url: DEFAULT_LOGO_URL, custom: false },
  ]);
});

test('unrelated keys and session storage changes do not affect branding', () => {
  const { storage, events, preference } = setup(record(PNG));
  const changes = [];
  preference.subscribeLogo(value => changes.push(value));
  events.dispatch({ key: 'other-key', newValue: null, storageArea: storage });
  events.dispatch({ key: KEY, newValue: null, storageArea: new MemoryStorage() });
  events.dispatch({ key: null, newValue: null, storageArea: new MemoryStorage() });
  assert.equal(preference.getLogoUrl(), PNG);
  assert.deepEqual(changes, []);
});

test('subscriptions share one browser listener, detach fully, and refresh after a gap', () => {
  const { storage, events, preference } = setup();
  const first = [], second = [];
  const stopFirst = preference.subscribeLogo(value => first.push(value));
  const stopSecond = preference.subscribeLogo(value => second.push(value));
  assert.equal(events.additions, 1);
  preference.saveCustomLogo(PNG);
  stopFirst();
  preference.saveCustomLogo(OTHER_PNG);
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);
  assert.equal(events.listeners.size, 1);
  stopSecond();
  stopSecond();
  assert.equal(events.listeners.size, 0);
  assert.equal(events.removals, 1);
  storage.setItem(KEY, record(PNG));
  const stopAgain = preference.subscribeLogo(() => {});
  assert.equal(preference.getLogoUrl(), PNG);
  assert.equal(events.additions, 2);
  stopAgain();
  assert.equal(events.listeners.size, 0);
});
