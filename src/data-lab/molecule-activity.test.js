import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from './model.js';
import { buildMolecularTree } from './molecule-layout.js';
import { activityLevel, membershipActivityKey, buildActivityHistory, activityAt } from './molecule-activity.js';

const dataset = (files, commits) => ({ repository: { name: 'activity-fixture' }, files: files.map(path => ({ path })), commits });
const build = (files, commits, options) => {
  const model = buildModel(dataset(files, commits)), graph = buildMolecularTree(model, options);
  return { model, graph, history: buildActivityHistory(model, graph) };
};
const idFor = (model, path) => model.nodes.find(node => node.path === path).id;
const change = (path, status = 'modified', other = {}) => ({ path, status, ...other });

function verifyRoutes(graph, routes) {
  for (const route of routes) {
    assert.equal(route.folderPaths[0], '');
    assert.equal(route.folderPaths.at(-1), route.folder);
    assert.equal(route.points.length, route.folderPaths.length + 1);
    assert.equal(route.segments.length, route.points.length - 1);
    assert.deepEqual(route.points.at(-1), graph.folderSlots.get(route.folder).get(route.fileId));
    assert.equal(route.key, membershipActivityKey(route.folder, route.fileId));
    for (let index = 0; index < route.folderPaths.length; index++) {
      assert.deepEqual(route.points[index], graph.folderByPath.get(route.folderPaths[index]).position);
      if (index) assert.equal(graph.folderByPath.get(route.folderPaths[index]).parent, route.folderPaths[index - 1]);
    }
    for (let index = 0; index < route.segments.length; index++) {
      const segment = route.segments[index];
      assert.deepEqual(segment.a, route.points[index]);
      assert.deepEqual(segment.b, route.points[index + 1]);
      assert.ok(segment.a.every(Number.isFinite) && segment.b.every(Number.isFinite));
      if (index === route.segments.length - 1) {
        assert.equal(segment.kind, 'membership');
        assert.equal(segment.bFileId, route.fileId);
        assert.equal(segment.key, route.key);
      } else {
        assert.equal(segment.kind, 'folder');
        assert.equal(segment.key, route.folderPaths[index + 1]);
        assert.equal(segment.bBackboneId, graph.folderByPath.get(segment.key).anchorId);
      }
    }
  }
}

test('fixed activity curve brightens monotonically without using future activity', () => {
  assert.equal(activityLevel(0), 0);
  assert.equal(activityLevel(-3), 0);
  assert.equal(activityLevel(NaN), 0);
  assert.equal(activityLevel(Infinity), 1);
  for (let count = 1; count <= 30; count++) {
    assert.ok(activityLevel(count) > activityLevel(count - 1));
    assert.ok(activityLevel(count) < 1);
  }
  assert.ok(Math.abs(activityLevel(4) - (1 - Math.exp(-1))) < 1e-12);
});

test('loaded-prefix counts deduplicate shared ancestry and leave unchanged files at zero', () => {
  const { model, graph, history } = build(['src/a.js', 'src/b.js', 'src/quiet.js', 'README.md'], [
    { sha: 'first', files: [change('src/a.js'), change('src/b.js')] },
    { sha: 'second', files: [change('src/a.js')] },
    { sha: 'empty', files: [] },
    { sha: 'last', files: [change('src/a.js')] },
  ]);
  const a = idFor(model, 'src/a.js'), b = idFor(model, 'src/b.js'), quiet = idFor(model, 'src/quiet.js');
  const baseline = activityAt(history, -1);
  assert.equal(baseline.fileTouches.size, 0);
  assert.equal(baseline.folderTouches.size, 0);
  assert.equal(baseline.routes.length, 0);
  const first = activityAt(history, 0);
  assert.equal(first.fileTouches.get(a), 1);
  assert.equal(first.fileTouches.get(b), 1);
  assert.equal(first.fileTouches.get(quiet) || 0, 0);
  assert.equal(first.folderTouches.get(''), 1);
  assert.equal(first.folderTouches.get('src'), 1);
  assert.equal(first.folderBondTouches.get('src'), 1);
  assert.equal(first.membershipTouches.get(membershipActivityKey('src', a)), 1);
  assert.equal(first.routes.length, 2);
  verifyRoutes(graph, first.routes);
  const second = activityAt(history, 1), unchanged = activityAt(history, 2), last = activityAt(history, 3);
  assert.equal(second.fileTouches.get(a), 2);
  assert.deepEqual(unchanged.fileTouches, second.fileTouches);
  assert.deepEqual(unchanged.folderTouches, second.folderTouches);
  assert.equal(unchanged.touchedFiles.size, 0);
  assert.equal(unchanged.routes.length, 0);
  assert.equal(last.fileTouches.get(a), 3);
  assert.equal(last.folderTouches.get(''), 3);
  assert.equal(last.fileTouches.get(b), 1);
});

test('duplicate changes in one commit count each file and physical route only once', () => {
  const model = buildModel(dataset(['src/a.js'], [{ sha: 'one', files: [change('src/a.js')] }]));
  model.commits[0].changes.push({ ...model.commits[0].changes[0] }, { ...model.commits[0].changes[0] });
  const graph = buildMolecularTree(model), state = activityAt(buildActivityHistory(model, graph), 0);
  const id = model.nodes[0].id;
  assert.equal(state.fileTouches.get(id), 1);
  assert.equal(state.folderTouches.get('src'), 1);
  assert.equal(state.folderBondTouches.get('src'), 1);
  assert.equal(state.membershipTouches.get(membershipActivityKey('src', id)), 1);
  assert.equal(state.routes.length, 1);
});

test('cross-folder rename touches old and new routes but counts the stable file and shared ancestors once', () => {
  const { model, graph, history } = build([], [
    { sha: 'edit-before', files: [change('src/deep/a.js')] },
    { sha: 'move', files: [change('packages/core/a.md', 'renamed', { previousPath: 'src/deep/a.js' })] },
    { sha: 'edit-after', files: [change('packages/core/a.md')] },
    { sha: 'remove', files: [change('packages/core/a.md', 'removed')] },
  ]);
  assert.equal(model.nodes.length, 1);
  const id = model.nodes[0].id, moved = activityAt(history, 1);
  assert.equal(moved.fileTouches.get(id), 2);
  assert.equal(moved.folderTouches.get(''), 2);
  assert.equal(moved.folderTouches.get('src/deep'), 2);
  assert.equal(moved.folderTouches.get('packages/core'), 1);
  assert.equal(moved.routes.length, 2);
  assert.deepEqual(new Set(moved.routes.map(route => route.role)), new Set(['previous', 'current']));
  assert.deepEqual(new Set(moved.routes.map(route => route.fileId)), new Set([id]));
  verifyRoutes(graph, moved.routes);
  const removed = activityAt(history, 3);
  assert.equal(removed.fileTouches.get(id), 4);
  assert.equal(removed.membershipTouches.get(membershipActivityKey('src/deep', id)), 2);
  assert.equal(removed.membershipTouches.get(membershipActivityKey('packages/core', id)), 3);
  assert.equal(removed.routes.length, 1);
  assert.equal(removed.routes[0].status, 'removed');
  assert.equal(removed.routes[0].path, 'packages/core/a.md');
  verifyRoutes(graph, removed.routes);
});

test('same-folder rename retains both path names but sends only one physical route', () => {
  const { graph, history } = build(['src/output.json'], [{ sha: 'rename', files: [change('src/output.json', 'renamed', { previousPath: 'src/input.js' })] }]);
  const state = activityAt(history, 0), route = state.routes[0];
  assert.equal(state.routes.length, 1);
  assert.equal(state.fileTouches.get(route.fileId), 1);
  assert.equal(state.folderTouches.get('src'), 1);
  assert.equal(state.membershipTouches.get(route.key), 1);
  assert.deepEqual(route.paths, ['src/input.js', 'src/output.json']);
  assert.deepEqual(route.roles, ['previous', 'current']);
  assert.equal(route.path, 'src/output.json');
  assert.equal(route.role, 'current');
  verifyRoutes(graph, state.routes);
});

test('delete and re-add at one pathname keep separate identity and membership counters', () => {
  const { model, history } = build(['src/a.js'], [
    { sha: 'old-edit', files: [change('src/a.js')] },
    { sha: 'delete', files: [change('src/a.js', 'removed')] },
    { sha: 'new-add', files: [change('src/a.js', 'added')] },
    { sha: 'new-edit', files: [change('src/a.js')] },
  ]);
  const oldId = model.commits[0].changes[0].id, newId = model.commits[2].changes[0].id;
  assert.notEqual(oldId, newId);
  const state = activityAt(history, 3);
  assert.equal(state.fileTouches.get(oldId), 2);
  assert.equal(state.fileTouches.get(newId), 2);
  assert.equal(state.membershipTouches.get(membershipActivityKey('src', oldId)), 2);
  assert.equal(state.membershipTouches.get(membershipActivityKey('src', newId)), 2);
  assert.equal(state.folderTouches.get('src'), 4);
  assert.equal(activityAt(history, 1).routes[0].fileId, oldId);
  assert.equal(activityAt(history, 2).routes[0].fileId, newId);
});

test('display-capped identities never contribute touches and deep folder routes are not compressed', () => {
  const deep = 'a/b/c/d/e/f/g/h/main.js';
  const { model, graph, history } = build([deep, 'other/omitted.js'], [
    { sha: 'omitted', files: [change('other/omitted.js')] },
    { sha: 'selected', files: [change(deep)] },
  ], { maxNodes: 1 });
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].path, deep);
  assert.equal(activityAt(history, 0).fileTouches.size, 0);
  assert.equal(activityAt(history, 0).routes.length, 0);
  const state = activityAt(history, 1);
  assert.equal(state.fileTouches.get(idFor(model, deep)), 1);
  assert.equal(state.routes[0].folderPaths.length, 9);
  assert.equal(state.folderBondTouches.size, 8);
  verifyRoutes(graph, state.routes);
});

test('baseline, clamped seeks and repeat rewinds return independent counters and immutable routes', () => {
  const { history } = build(['src/a.js'], [
    { sha: 'one', files: [change('src/a.js')] }, { sha: 'two', files: [change('src/a.js')] },
  ]);
  const expected = activityAt(history, 0), latest = activityAt(history, 1000);
  assert.equal(latest.index, 1);
  assert.equal(activityAt(history, -1000).index, -1);
  assert.equal(activityAt(history, NaN).index, -1);
  assert.equal(activityAt(history, 0.9).index, 0);
  const mutable = activityAt(history, 0);
  mutable.fileTouches.set('injected', 100);
  mutable.folderTouches.clear(); mutable.touchedFiles.clear();
  assert.throws(() => { mutable.routes[0].points[0][0] = 999; }, TypeError);
  assert.deepEqual(activityAt(history, 0), expected);
  assert.deepEqual(activityAt(history, 1), latest);
});

test('root-level files have a direct route and history captures geometry independently of later graph edits', () => {
  const { graph, history } = build(['README.md'], [{ sha: 'root', files: [change('README.md')] }]);
  const state = activityAt(history, 0), route = state.routes[0];
  assert.deepEqual(route.folderPaths, ['']);
  assert.equal(route.points.length, 2);
  assert.equal(route.segments.length, 1);
  assert.equal(route.segments[0].kind, 'membership');
  assert.equal(state.folderBondTouches.size, 0);
  const original = [...route.points[0]];
  graph.folderByPath.get('').position[0] += 100;
  assert.deepEqual(activityAt(history, 0).routes[0].points[0], original);
});

test('empty histories and unknown historical aliases do not invent current paths', () => {
  const empty = build([], []);
  const state = activityAt(empty.history, 99);
  assert.equal(state.index, -1);
  assert.equal(state.routes.length, 0);
  const { model, graph } = build(['src/a.js'], [{ sha: 'one', files: [change('src/a.js')] }]);
  model.commits[0].changes[0].path = 'missing/alias.js';
  const incomplete = activityAt(buildActivityHistory(model, graph), 0);
  assert.equal(incomplete.fileTouches.get(model.nodes[0].id), 1);
  assert.equal(incomplete.routes.length, 0);
  assert.equal(incomplete.folderTouches.size, 0);
});
