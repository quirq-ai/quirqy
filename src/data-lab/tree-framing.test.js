import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TreeScene } from './tree-scene.js';
import { createRepositoryFixture } from './test-fixtures/repository.js';
import { buildModel, stateAt } from './model.js';
import { createRootLayout } from './root-layout.js';
import { createRootWarpLayout } from './root-warp.js';
import { buildRootActivityHistory, rootActivityAt, rootPathGrowth } from './root-activity.js';
import { ROOT_VINE_RADIUS, rootRopeRadius } from './root-rope-geometry.js';
import { createRootSurface, measureRootSurfaceCrowding, applyRootSurface } from './root-surface.js';

function fixture(width, height, reducedMotion) {
  const model = buildModel(createRepositoryFixture());
  const frame = stateAt(model, model.commits.length - 1);
  const baseLayout = createRootLayout(model, { activeIds: frame.activeIds, paths: new Map(frame.files.map(file => [file.id, file.path])) });
  const activity = rootActivityAt(buildRootActivityHistory(model), frame.index);
  const growth = rootPathGrowth(baseLayout, activity);
  const fileRadii = new Map([...growth.fileTouches].map(([id, touches]) => [id, rootRopeRadius(touches)]));
  const folderRadii = new Map([...growth.folderTouches].map(([path, touches]) => [path, rootRopeRadius(touches)]));
  const growthLayout = createRootWarpLayout(baseLayout, { fileRadii, folderRadii, baseRadius: ROOT_VINE_RADIUS });
  // Reproduce the failure: focus begins in a bent overview, but the tighter
  // camera will make the surface recompute from the unbent projected names.
  const surfaceDisplay = createRootSurface(baseLayout, { height: 56 });
  const layout = applyRootSurface(growthLayout, surfaceDisplay);
  const scene = Object.create(TreeScene.prototype);
  scene.camera = new THREE.PerspectiveCamera(42, width / height, .05, 8e6);
  const ray = new THREE.Vector3(0, .32, 1).normalize();
  const target = new THREE.Vector3(0, -75, 0);
  scene.camera.position.copy(target).addScaledVector(ray, 240);
  scene.camera.up.set(width > 700 ? 0 : 1, width > 700 ? 1 : 0, 0).applyAxisAngle(ray, .25);
  scene.camera.lookAt(target);
  scene.camera.updateMatrixWorld(true);
  scene.controls = { target, stopCalls: 0, stop() { this.stopCalls++; } };
  scene.renderer = { domElement: { clientWidth: width, clientHeight: height } };
  scene.reducedMotion = reducedMotion;
  scene.presentationTarget = { canopy: .24, roots: 1 };
  scene.roots = {
    baseLayout, growthLayout, layout, surfaceDisplay,
    // Representative monospace metrics for the actual sample filenames.
    labelWidths: new Map(growthLayout.nodes.map(node => [node.id, node.path.split('/').pop().length * 7])),
    files: new Map(layout.nodes.map(node => [node.id, { radiusTarget: fileRadii.get(node.id) }])),
    folders: new Map(layout.folders.map(folder => [folder.path, { radiusTarget: folderRadii.get(folder.path) }])),
  };
  return { scene, model, growth, width, height };
}

function project(point, camera, width, height) {
  const screen = new THREE.Vector3(...point).project(camera);
  return { x: (screen.x + 1) * width / 2, y: (1 - screen.y) * height / 2, visible: screen.z >= -1 && screen.z <= 1 };
}

// This is the post-arrival responsive calculation, independent of the framing
// solver. A camera aimed only at the old bent bounds fails these assertions.
function settledRoots({ scene, width, height }) {
  const points = scene.roots.growthLayout.nodes.map(node => ({
    ...project(node.position, scene.camera, width, height), textWidth: scene.roots.labelWidths.get(node.id),
  }));
  const crowding = measureRootSurfaceCrowding(points, { width, height, labelOrientation: 'horizontal' });
  const surface = createRootSurface(scene.roots.baseLayout, { viewportWidth: width, crowding });
  return { layout: applyRootSurface(scene.roots.growthLayout, surface), surface };
}

function focusAndCheck(context, path, fileId = null) {
  const { scene, model, growth, width, height } = context;
  const before = structuredClone({ model, growth, base: scene.roots.baseLayout, unbent: scene.roots.growthLayout });
  const originalUp = scene.camera.up.clone();
  const originalDirection = scene.camera.position.clone().sub(scene.controls.target).normalize();
  const originalQuaternion = scene.camera.quaternion.clone();
  const initial = fileId
    ? scene.roots.layout.nodes.filter(node => node.id === fileId)
    : [...scene.roots.layout.folders, ...scene.roots.layout.nodes].filter(record => record.path === path || record.path.startsWith(`${path}/`));
  const bounds = new THREE.Box3().setFromPoints(initial.flatMap(record => record.curve.map(point => new THREE.Vector3(...point))));
  scene._frameRootsBounds(bounds, false, path, fileId);
  if (!scene.reducedMotion) {
    assert.ok(scene.tween, 'animated focus must provide a destination');
    scene.camera.position.copy(scene.tween.to);
    scene.controls.target.copy(scene.tween.toTarget);
    scene.camera.lookAt(scene.controls.target);
  }
  scene.camera.updateMatrixWorld(true);
  assert.equal(scene.controls.stopCalls, 1);
  assert.deepEqual(scene.camera.up, originalUp, 'folder/file focus must retain roll');
  assert.ok(scene.camera.position.clone().sub(scene.controls.target).normalize().distanceTo(originalDirection) < 1e-12,
    'folder/file focus must retain viewing direction');
  assert.ok(scene.camera.quaternion.angleTo(originalQuaternion) < 1e-6, 'focus must retain camera orientation');
  const settled = settledRoots(context);
  assert.ok(settled.surface.height < 55, 'fixture must exercise surface flattening after focus');
  const targets = settled.layout.nodes.filter(node => fileId ? node.id === fileId : node.folder === path || node.folder.startsWith(`${path}/`));
  const region = {
    left: width > 1200 ? 245 : 16,
    right: width - (width > 900 ? 390 : width > 700 ? 330 : 16),
    top: width > 700 ? 100 : 140,
    bottom: height - (width > 700 ? 120 : 220),
  };
  assert.equal(targets.length, fileId ? 1 : path === 'app' ? 9 : 10);
  for (const node of targets) {
    const screen = project(node.position, scene.camera, width, height);
    assert.ok(screen.visible, `${node.path}: tip must remain in the camera frustum`);
    // Labels choose their own left/right/above/below placement. Framing must
    // retain the real anchor in the readable area after the ground responds.
    assert.ok(screen.x >= region.left + 2 && screen.x <= region.right - 2,
      `${node.path}: focused tip must remain between side panels (${screen.x})`);
    assert.ok(screen.y >= region.top + 2 && screen.y <= region.bottom - 2,
      `${node.path}: focused tip must remain below the header and above the timeline (${screen.y})`);
  }
  assert.deepEqual({ model, growth, base: scene.roots.baseLayout, unbent: scene.roots.growthLayout }, before,
    'focus must not alter repository data, touches, or the unbent hierarchy');
}

for (const [name, width, height] of [['desktop', 1600, 1000], ['mobile', 430, 932]]) {
  for (const path of ['app', 'tests']) test(`${name}: ${path} folder tips remain in the readable region after responsive roots settle`, () => {
    for (const reducedMotion of [true, false]) focusAndCheck(fixture(width, height, reducedMotion), path);
  });
  test(`${name}: a far-left root file remains visible after zoom flattens the ground`, () => {
    for (const reducedMotion of [true, false]) {
      const context = fixture(width, height, reducedMotion);
      const file = context.scene.roots.growthLayout.nodes.find(node => node.path === 'app/README.md');
      assert.ok(file);
      focusAndCheck(context, '', file.id);
    }
  });
}
