import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { TreeScene } from './tree-scene.js';
import { createRepositoryFixture } from './test-fixtures/repository.js';
import { buildModel, stateAt } from './model.js';
import { createRootLayout } from './root-layout.js';
import { createRootLengthLayout } from './root-length-layout.js';
import { buildRootActivityHistory, rootActivityAt } from './root-activity.js';
import { rootRopeRadius } from './root-rope-geometry.js';
import { createTreeLayout, createTreePose, trunkRadius } from './tree-layout.js';

function fixture(width, height, reducedMotion, dataset = createRepositoryFixture(), index) {
  const model = buildModel(dataset);
  const head = stateAt(model, model.commits.length - 1);
  const headLayout = createRootLayout(model, { activeIds: head.activeIds, paths: new Map(head.files.map(file => [file.id, file.path])) });
  const repositoryWidth = headLayout.footprint.width;
  const frame = stateAt(model, index ?? head.index);
  // Replay uses the pinned repository width, so its tier height and per-touch
  // growth stay comparable when the historical file membership changes.
  const baseLayout = frame.index === head.index ? headLayout : createRootLayout(model, {
    activeIds: frame.activeIds, paths: new Map(frame.files.map(file => [file.id, file.path])), repositoryWidth,
  });
  const activity = rootActivityAt(buildRootActivityHistory(model), frame.index);
  const growth = { fileTouches: activity.fileTouches, folderTouches: activity.folderTouches };
  const layout = createRootLengthLayout(baseLayout, { fileTouches: growth.fileTouches });
  const fileRadii = new Map(layout.nodes.map(node => [node.id,
    rootRopeRadius(1, (1 + node.addedLength / Math.max(16, node.baseLength)) ** .12)]));
  const folderRadii = new Map(layout.folders.map(folder => [folder.path, rootRopeRadius(1)]));
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
    baseLayout, growthLayout: layout, layout,
    // Representative monospace metrics for the actual sample filenames.
    labelWidths: new Map(layout.nodes.map(node => [node.id, node.path.split('/').pop().length * 7])),
    files: new Map(layout.nodes.map(node => [node.id, { radiusTarget: fileRadii.get(node.id) }])),
    folders: new Map(layout.folders.map(folder => [folder.path, { radiusTarget: folderRadii.get(folder.path) }])),
  };
  return { scene, model, growth, width, height, frame, repositoryWidth };
}

function project(point, camera, width, height) {
  const screen = new THREE.Vector3(...point).project(camera);
  return { x: (screen.x + 1) * width / 2, y: (1 - screen.y) * height / 2, visible: screen.z >= -1 && screen.z <= 1 };
}

function focusAndCheck(context, path, fileId = null) {
  const { scene, model, growth, width, height } = context;
  const before = structuredClone({ model, growth, base: scene.roots.baseLayout, layout: scene.roots.layout, files: scene.roots.files, folders: scene.roots.folders });
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
  const targets = scene.roots.layout.nodes.filter(node => fileId ? node.id === fileId : node.folder === path || node.folder.startsWith(`${path}/`));
  const region = {
    left: width > 1200 ? 245 : 16,
    right: width - (width > 1100 ? 390 : width > 900 ? 360 : 16),
    top: width > 900 ? 100 : 140,
    bottom: height - (width > 900 ? 120 : 220),
  };
  assert.equal(targets.length, fileId ? 1 : path === 'app' ? 9 : 10);
  for (const node of targets) {
    const screen = project(node.position, scene.camera, width, height);
    assert.ok(screen.visible, `${node.path}: tip must remain in the camera frustum`);
    // Labels choose their own left/right/above/below placement. Framing must
    // retain the real anchor in the readable area without changing its length.
    assert.ok(screen.x >= region.left + 2 && screen.x <= region.right - 2,
      `${node.path}: focused tip must remain between side panels (${screen.x})`);
    assert.ok(screen.y >= region.top + 2 && screen.y <= region.bottom - 2,
      `${node.path}: focused tip must remain below the header and above the timeline (${screen.y})`);
  }
  assert.deepEqual({ model, growth, base: scene.roots.baseLayout, layout: scene.roots.layout, files: scene.roots.files, folders: scene.roots.folders }, before,
    'focus must not alter repository data, touches, fixed-length curves, or rope radii');
}

for (const [name, width, height] of [['desktop', 1600, 1000], ['tablet', 768, 1024], ['mobile', 430, 932]]) {
  for (const path of ['app', 'tests']) test(`${name}: ${path} folder tips remain in the readable region after fixed-step growth`, () => {
    for (const reducedMotion of [true, false]) focusAndCheck(fixture(width, height, reducedMotion), path);
  });
  test(`${name}: a far-left grown file remains visible without changing its geometry`, () => {
    for (const reducedMotion of [true, false]) {
      const context = fixture(width, height, reducedMotion);
      const file = context.scene.roots.growthLayout.nodes.find(node => node.path === 'app/README.md');
      assert.ok(file);
      focusAndCheck(context, '', file.id);
    }
  });
}

function overviewPoints(layout) {
  const roots = layout.rows.flatMap(record => record.curve);
  // The file-count-sized ground is part of the framed content, and stays flat.
  const ground = Array.from({ length: 48 }, (_, index) => {
    const angle = index / 48 * Math.PI * 2;
    return [Math.cos(angle) * layout.base.radiusX, layout.groundY, Math.sin(angle) * layout.base.radiusZ];
  });
  return [...roots, ...ground];
}

test('tablet roots overview uses the full pane when the permanent side panels are hidden', () => {
  const context = fixture(768, 1024, true);
  const { scene, width, height } = context;
  const bounds = new THREE.Box3(
    new THREE.Vector3(...scene.roots.layout.bounds.min),
    new THREE.Vector3(...scene.roots.layout.bounds.max),
  );
  scene._frameRootsBounds(bounds, true);
  scene.camera.updateMatrixWorld(true);
  // Portrait tablets arrange the tips in vertical rows so their horizontal
  // filenames have room, while still using the full panel-free content area.
  assert.deepEqual(scene.camera.up.toArray(), [1, 0, 0]);
  const { layout } = scene.roots;
  const points = overviewPoints(layout).map(point => project(point, scene.camera, width, height));
  const region = { left: 16, right: width - 16, top: 140, bottom: height - 220 };
  for (const point of points) {
    assert.ok(point.visible, 'the entire root hierarchy must remain in the tablet frustum');
    assert.ok(point.x >= region.left && point.x <= region.right, `root X=${point.x} must fit the panel-free pane`);
    assert.ok(point.y >= region.top && point.y <= region.bottom, `root Y=${point.y} must fit between tablet controls`);
  }
  const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
  assert.ok(maxY - minY > (region.bottom - region.top) * .75, 'portrait framing must use the available height between controls');
  assert.ok(Math.abs((minX + maxX) / 2 - width / 2) < width * .08, 'hidden side panels must not push the repository off center');
  assert.equal(scene.controls.stopCalls, 1);
});

function checkRepositoryOverview(context) {
  const { scene, width, height, model, growth } = context;
  const { layout, baseLayout } = scene.roots;
  const before = structuredClone({ model, growth, baseLayout, layout, files: scene.roots.files, folders: scene.roots.folders });
  const bounds = new THREE.Box3(new THREE.Vector3(...layout.bounds.min), new THREE.Vector3(...layout.bounds.max));
  scene._frameRootsBounds(bounds, true);
  scene.camera.updateMatrixWorld(true);
  assert.deepEqual(scene.camera.up.toArray(), width <= 900 && height > width ? [1, 0, 0] : [0, 1, 0]);
  const region = {
    left: width > 1200 ? 245 : 16,
    right: width - (width > 1100 ? 390 : width > 900 ? 360 : 16),
    top: width > 900 ? 100 : 140,
    bottom: height - (width > 900 ? 120 : 220),
  };
  for (const position of overviewPoints(layout)) {
    const point = project(position, scene.camera, width, height);
    assert.ok(point.visible, 'repository roots and ground must stay inside the camera frustum');
    assert.ok(point.x >= region.left && point.x <= region.right, `repository X=${point.x} must fit between side panels`);
    assert.ok(point.y >= region.top && point.y <= region.bottom, `repository Y=${point.y} must fit between header and timeline`);
  }
  assert.deepEqual({ model, growth, baseLayout, layout, files: scene.roots.files, folders: scene.roots.folders }, before,
    'overview framing must preserve all history, curve lengths, neighboring junctions, and proportional radii');
  assert.equal(scene.controls.stopCalls, 1);
}

test('xo-space baseline and grown roots retain their pinned depth and fit the full hierarchy on desktop and mobile', () => {
  const dataset = JSON.parse(readFileSync(new URL('./examples/xo-space.json', import.meta.url), 'utf8'));
  const headIndex = dataset.commits.length - 1;
  for (const [width, height] of [[1600, 1000], [430, 932]]) for (const index of [-1, headIndex]) {
    const context = fixture(width, height, true, dataset, index);
    const { layout, baseLayout } = context.scene.roots;
    const expectedFiles = context.frame.files.filter(file => file.exists && !file.path.split('/').some(segment => segment.startsWith('.')));
    assert.equal(layout.nodes.length, expectedFiles.length, 'every current non-dot file must participate in framing');
    assert.equal(baseLayout.proportions.repositoryWidth, context.repositoryWidth);
    assert.ok(baseLayout.proportions.tierHeight > 60, 'the large fixture must exercise the deeper proportional hierarchy');
    assert.ok(layout.lengthGrowth.lengthPerTouch > 23, 'the large fixture must use its proportional per-touch increment');
    assert.equal(layout.lengthGrowth.lengthPerTouch, baseLayout.proportions.lengthPerTouch);
    if (index === headIndex) {
      assert.equal(layout.nodes.length, 754);
      assert.equal(layout.folders.length, 125);
      assert.ok(layout.lengthGrowth.totalAddedLength > 0);
    } else assert.equal(layout.lengthGrowth.totalAddedLength, 0);
    checkRepositoryOverview(context);
    const direction = context.scene.camera.position.clone().sub(context.scene.controls.target).normalize();
    if (width > height) assert.ok(direction.y / direction.z < 0.4, 'deep roots must reveal their vertical hierarchy in a landscape overview');
    else assert.ok(direction.y / direction.z > 1, 'portrait roots must keep enough perspective separation for sideways filename rows');
  }
});

test('the small xo repository retains its original proportions and readable framing', () => {
  const dataset = JSON.parse(readFileSync(new URL('./examples/xo.json', import.meta.url), 'utf8'));
  for (const index of [-1, dataset.commits.length - 1]) {
    const context = fixture(1600, 1000, true, dataset, index);
    const { layout, baseLayout } = context.scene.roots;
    assert.equal(baseLayout.proportions.scale, 1);
    assert.equal(baseLayout.proportions.tierHeight, 16);
    assert.equal(layout.lengthGrowth.lengthPerTouch, 6);
    checkRepositoryOverview(context);
  }
});

function presentationFixture() {
  const scene = Object.create(TreeScene.prototype);
  scene.group = new THREE.Group();
  scene.canopyGroup = new THREE.Group();
  scene.roots = { group: new THREE.Group() };
  scene.groundGroup = new THREE.Group();
  scene.group.add(scene.canopyGroup, scene.roots.group, scene.groundGroup);
  return scene;
}

const nearVector = (actual, expected, message) => assert.ok(actual.distanceTo(expected) < 1e-10, message);

test('bonsai presentation and framing points agree through transitions and retain the shared ground anchor', () => {
  const scene = presentationFixture();
  const camera = new THREE.PerspectiveCamera(42, 1.6, .05, 8e6);
  camera.position.set(60, 35, 240);
  camera.lookAt(0, -40, 0);
  camera.updateMatrixWorld(true);
  const anchor = new THREE.Vector3(0, -40, 0);
  const samplePoints = [anchor, new THREE.Vector3(12, 38, -9), new THREE.Vector3(-27, -95, 16)];
  const modes = [{ canopy: 1, roots: .32 }, { canopy: .62, roots: .66 }, { canopy: .24, roots: 1 }];
  for (const mode of modes) {
    scene.presentation = { ...mode };
    scene.presentationTarget = { ...mode };
    scene._applyPresentation();
    nearVector(scene.canopyGroup.scale, new THREE.Vector3(Math.sqrt(mode.canopy), mode.canopy, Math.sqrt(mode.canopy)), 'canopy must retain more radial size than height');
    for (const group of [scene.roots.group, scene.groundGroup]) nearVector(group.scale, new THREE.Vector3().setScalar(mode.roots), 'roots and ground remain uniform');
    for (const [part, group] of [['canopy', scene.canopyGroup], ['roots', scene.roots.group]]) {
      nearVector(group.localToWorld(anchor.clone()), anchor, 'presentation must not detach either tree from the ground');
      for (const point of samplePoints) {
        const original = point.clone();
        const rendered = group.localToWorld(point.clone());
        const framing = scene._presentationPoint(point, part);
        nearVector(framing, rendered, 'framing must match the actual anisotropic group transform');
        nearVector(framing.clone().project(camera), rendered.clone().project(camera), 'projected framing points must match rendered positions');
        nearVector(scene._presentationPoint(point, part, false), rendered, 'current-pose framing must match current group transform');
        assert.deepEqual(point, original, 'point conversion must not mutate hierarchy coordinates');
      }
    }
    nearVector(scene.groundGroup.localToWorld(anchor.clone()), anchor, 'soil must remain attached to the trunk');
  }
  // Framing can target the destination before the rendered transition arrives.
  scene.presentation = { ...modes[0] };
  scene.presentationTarget = { ...modes[2] };
  scene._applyPresentation();
  const point = samplePoints[1];
  const destination = scene._presentationPoint(point, 'canopy');
  assert.ok(destination.distanceTo(scene._presentationPoint(point, 'canopy', false)) > 1);
  scene.presentation = { ...scene.presentationTarget };
  scene._applyPresentation();
  nearVector(destination, scene.canopyGroup.localToWorld(point.clone()), 'target framing must predict the final bonsai pose');
});

test('small canopy presentation retains trunk thickness and commit growth ratios without changing geometry', () => {
  const repository = buildModel(createRepositoryFixture());
  const layout = createTreeLayout(repository);
  const earlyIndex = -1, lateIndex = repository.commits.length - 1;
  const poses = [earlyIndex, lateIndex].map(index => createTreePose(layout, {
    index, commitCount: repository.commits.length, activeIds: stateAt(repository, index).activeIds,
  }));
  const original = structuredClone({ repository, layout, poses });
  const scene = presentationFixture();
  const geometry = new THREE.BufferGeometry().setFromPoints(poses[1].trunk.map(point => new THREE.Vector3(...point)));
  const mesh = new THREE.Line(geometry, new THREE.LineBasicMaterial());
  scene.canopyGroup.add(mesh);
  const vertices = geometry.attributes.position.array.slice(), geometryId = geometry.uuid;
  const measurements = [];
  for (const canopy of [1, .24, 1]) {
    scene.presentation = scene.presentationTarget = { canopy, roots: canopy === 1 ? .32 : 1 };
    scene._applyPresentation();
    const heights = poses.map(pose => scene.canopyGroup.localToWorld(new THREE.Vector3(...pose.trunk.at(-1))).y + 40);
    const radii = [earlyIndex, lateIndex].map(index => scene.canopyGroup.localToWorld(new THREE.Vector3(trunkRadius(index), -40, 0)).x);
    assert.ok(heights[1] > heights[0] && radii[1] > radii[0], 'every mode must retain visible commit growth');
    measurements.push({ heights, radii });
    assert.equal(geometry.uuid, geometryId);
    assert.deepEqual(geometry.attributes.position.array, vertices, 'presentation must leave geometry buffers unchanged');
  }
  const [full, bonsai, restored] = measurements;
  assert.ok(Math.abs(bonsai.heights[1] / full.heights[1] - .24) < 1e-12);
  assert.ok(Math.abs(bonsai.radii[1] / full.radii[1] - Math.sqrt(.24)) < 1e-12);
  assert.ok(bonsai.radii[1] / bonsai.heights[1] > 2 * full.radii[1] / full.heights[1], 'compact canopy must look stockier rather than uniformly miniaturized');
  assert.ok(Math.abs(bonsai.heights[1] / bonsai.heights[0] - full.heights[1] / full.heights[0]) < 1e-12);
  assert.ok(Math.abs(bonsai.radii[1] / bonsai.radii[0] - full.radii[1] / full.radii[0]) < 1e-12);
  assert.deepEqual(restored, full, 'returning to full tree must restore its exact presentation');
  assert.deepEqual({ repository, layout, poses }, original, 'mode changes must not change repository history or growth poses');
  geometry.dispose();
  mesh.material.dispose();
});
