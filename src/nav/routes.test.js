import test from 'node:test';
import assert from 'node:assert/strict';
import { modeFromLocation, pathForMode, titleForMode, syncUrl, ROUTES } from './routes.js';

const location = path => new URL(path, 'https://quirqy.example');

test('home and direct repository links boot the repository runtime', () => {
  for (const path of ['/', '/?source=bookmark', '/data', '/data/', '/data-lab']) {
    assert.equal(modeFromLocation(location(path)), 'data', path);
  }
  for (const path of ['/activity', '/activity/', '/activity-lab']) {
    assert.equal(modeFromLocation(location(path)), 'activity', path);
  }
  assert.equal(modeFromLocation(location('/unknown')), 'data');
  assert.equal(pathForMode(), '/data');
  assert.equal(titleForMode(), 'Quirqy · Data Lab');
});

test('Solar remains available explicitly without claiming the home page', () => {
  assert.equal(modeFromLocation(location('/solar')), 'solar');
  assert.equal(pathForMode('solar'), '/solar');
  assert.equal(ROUTES.find(route => route.mode === 'solar').path, '/solar');
  assert.equal(modeFromLocation(location('/equation')), 'math');
});

test('existing hash bookmarks still choose their intended instrument', () => {
  assert.equal(modeFromLocation(location('/#solar')), 'solar');
  assert.equal(modeFromLocation(location('/#/solar')), 'solar');
  assert.equal(modeFromLocation(location('/#equation')), 'math');
  assert.equal(modeFromLocation(location('/#/activity')), 'activity');
  assert.equal(modeFromLocation(location('/#unrecognized')), 'data');
});

test('navigation preserves search parameters and uses the new Solar route', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const calls = [];
  globalThis.window = {
    location: location('/data?source=share'),
    history: {
      pushState: (state, _, url) => calls.push({ state, url }),
      replaceState: (state, _, url) => calls.push({ state, url, replace: true }),
    },
  };
  globalThis.document = { title: '' };
  try {
    syncUrl('solar');
    assert.deepEqual(calls.at(-1), { state: { mode: 'solar' }, url: '/solar?source=share' });
    assert.equal(document.title, 'Quirqy · Solar System');
    syncUrl('data', { replace: true });
    assert.deepEqual(calls.at(-1), { state: { mode: 'data' }, url: '/data?source=share', replace: true });
    assert.equal(document.title, 'Quirqy · Data Lab');
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
