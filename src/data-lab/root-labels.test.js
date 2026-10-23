import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RootLabels } from './root-labels.js';
import { buildModel } from './model.js';
import { buildRootActivityHistory, rootActivityAt } from './root-activity.js';

// RootLabels needs text measurement and CSS2D element ownership, not a browser
// renderer. Keep the DOM stub local to each test and retain the real placement,
// camera projection and CSS2DObject lifecycle.
function dom(t) {
  const previous = new Map(['document', 'window', 'getComputedStyle'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Element {
    constructor(tag) {
      this.tagName = tag; this.style = {}; this.dataset = {}; this.children = [];
      this.parentNode = null; this.textContent = ''; this.attributes = new Map();
      this.ownerDocument = document;
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    append(child) { child.parentNode = this; this.children.push(child); }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
    getContext() { return { font: '', measureText: text => ({ width: [...text].length * 7 }) }; }
  }
  const document = { defaultView: { Element }, createElement: tag => new Element(tag), getElementById: () => null, querySelectorAll: () => [] };
  Object.assign(globalThis, { document, window: { innerWidth: 1200, innerHeight: 800 }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

function fixture(t, { files, folders, mode = 'classification', focusMode = true } = {}) {
  dom(t);
  const camera = new THREE.OrthographicCamera(-60, 60, 40, -40, .1, 1000);
  camera.position.set(0, 0, 100); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const group = new THREE.Group();
  const canvas = { clientWidth: 1200, clientHeight: 800, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }) };
  const labels = new RootLabels({ camera, renderer: { domElement: canvas } }, group);
  const source = (entry, index, kind) => ({
    ...entry, kind, position: new THREE.Vector3(...(entry.position || [(index - 1) * 32, kind === 'file' ? -12 : 16, 0])),
    touchCount: entry.touchCount ?? 0, row: index, labelDirection: [0, -1, 0],
    ...(kind === 'file' ? { node: { id: entry.id, path: entry.path, labelDirection: [0, -1, 0] } } : {}),
  });
  const folderSources = new Map((folders || [{ path: 'src' }, { path: 'quiet' }]).map((entry, index) => [entry.path, source(entry, index, 'folder')]));
  const fileSources = new Map((files || [{ id: 'root-file', path: 'a.js' }, { id: 'src-file', path: 'src/b.js' }, { id: 'quiet-file', path: 'quiet/c.js' }]).map((entry, index) => [entry.id, source(entry, index, 'file')]));
  labels.setPresentationMode(mode); labels.setFocusMode(focusMode); labels.setLayout(folderSources, fileSources);
  // Each CSS2D element retains its owning document for the removal hook.
  t.after(() => labels.dispose());
  return { labels, camera, group, files: fileSources, folders: folderSources };
}
const visible = labels => labels.records.filter(record => record.visible).map(record => `${record.kind}:${record.path}`).sort();
const assertHidden = record => {
  assert.equal(record.visible, false);
  assert.equal(record.object.visible, false);
};

test('classification baseline hides every zero-touch name while retaining all source records', t => {
  const { labels, files, folders } = fixture(t);
  const positions = [...files.values(), ...folders.values()].map(source => source.position.toArray());
  labels.update();
  assert.deepEqual(visible(labels), []);
  assert.equal(labels.files.length, 3); assert.equal(labels.folders.length, 2);
  labels.records.forEach(assertHidden);
  assert.deepEqual([...files.values(), ...folders.values()].map(source => source.position.toArray()), positions);
});

test('cumulative touch eligibility appears, persists through unrelated commits and rewinds without camera movement', t => {
  const model = buildModel({ repository: { name: 'Names' }, files: [{ path: 'a.js' }, { path: 'src/b.js' }, { path: 'quiet/c.js' }], commits: [
    { sha: 'root-edit', files: [{ path: 'a.js', status: 'modified' }] },
    { sha: 'folder-edit', files: [{ path: 'src/b.js', status: 'modified' }] },
    { sha: 'unrelated', files: [] },
  ] });
  const { labels, camera, files, folders } = fixture(t, { files: model.nodes.map(node => ({ id: node.id, path: node.path })) });
  const history = buildRootActivityHistory(model), cameraBefore = camera.matrixWorld.toArray();
  const seek = index => {
    const state = rootActivityAt(history, index);
    for (const [id, source] of files) source.touchCount = state.fileTouches.get(id) || 0;
    for (const [path, source] of folders) source.touchCount = state.folderTouches.get(path) || 0;
    labels.update(); // Do not invalidate the signature on behalf of production.
  };
  seek(-1); assert.deepEqual(visible(labels), []);
  seek(0); assert.deepEqual(visible(labels), ['file:a.js'], 'a root-file-only commit must refresh eligibility without folder text changes');
  seek(1); assert.deepEqual(visible(labels), ['file:a.js', 'file:src/b.js', 'folder:src']);
  assert.equal(labels.folders.find(record => record.path === 'src').element.textContent, 'src · 1 edit');
  seek(2); assert.deepEqual(visible(labels), ['file:a.js', 'file:src/b.js', 'folder:src'], 'past touches persist even when the selected commit changes no file');
  seek(0); assert.deepEqual(visible(labels), ['file:a.js']);
  seek(-1); assert.deepEqual(visible(labels), []);
  assert.deepEqual(camera.matrixWorld.toArray(), cameraBefore);
});

test('selection, hover and folder focus never override zero-touch classification eligibility', t => {
  const { labels, files } = fixture(t);
  files.get('root-file').touchCount = 2;
  labels.setFocusFolder('quiet');
  for (const options of [
    { selectedId: 'quiet-file' },
    { hovered: { kind: 'file', id: 'quiet-file', path: 'quiet/c.js', root: true } },
    { hovered: { kind: 'folder', path: 'quiet', root: true } },
    { selectedId: 'quiet-file', hovered: { kind: 'folder', path: 'quiet', root: true } },
  ]) {
    labels.update(options);
    assert.deepEqual(visible(labels), ['file:a.js']);
    labels.records.filter(record => record.path.startsWith('quiet')).forEach(assertHidden);
  }
});

test('organic names retain their existing zero-touch context and focus behavior across mode switches', t => {
  const { labels } = fixture(t, { mode: 'organic' });
  labels.update();
  assert.deepEqual(visible(labels), ['file:a.js', 'file:quiet/c.js', 'file:src/b.js', 'folder:quiet', 'folder:src']);
  assert.ok(labels.folders.every(record => !record.element.textContent.includes('touches')));
  labels.setPresentationMode('classification'); labels.update();
  assert.deepEqual(visible(labels), []);
  labels.setPresentationMode('organic'); labels.setFocusMode(false); labels.update();
  assert.deepEqual(visible(labels), ['folder:quiet', 'folder:src']);
  labels.update({ selectedId: 'quiet-file' });
  assert.deepEqual(visible(labels), ['file:quiet/c.js', 'folder:quiet', 'folder:src']);
});

test('untouched names do not consume collision slots and visible touched names remain nonoverlapping', t => {
  const { labels } = fixture(t, {
    folders: [{ path: 'untouched-folder', position: [0, 0, 0] }],
    files: [
      { id: 'quiet', path: 'a-quiet.js', position: [0, 0, 0] },
      { id: 'active', path: 'z-active.js', position: [0, 0, 0], touchCount: 1 },
      { id: 'nearby', path: 'zz-nearby.js', position: [.1, 0, 0], touchCount: 3 },
      { id: 'separate', path: 'separate.js', position: [30, 0, 0], touchCount: 2 },
    ],
  });
  labels.update();
  assert.deepEqual(visible(labels), ['file:separate.js', 'file:z-active.js']);
  assertHidden(labels.folders[0]); assertHidden(labels.files.find(record => record.key === 'quiet'));
  const boxes = labels.records.filter(record => record.visible).map(record => record.labelBounds);
  for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
    const first = boxes[a], second = boxes[b];
    assert.ok(!(first.left < second.left + second.width && first.left + first.width > second.left
      && first.top < second.top + second.height && first.top + first.height > second.top));
  }
  assert.equal(labels.files.length, 4, 'collision disclosure and activity eligibility retain every file record');
});
