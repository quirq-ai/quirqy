import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, stateAt } from './model.js';
import { buildRootActivityHistory, rootActivityAt, rootMembershipKey, rootPathGrowth } from './root-activity.js';
import { createRootLayout } from './root-layout.js';

const change = (path, status = 'modified', extra = {}) => ({ path, status, ...extra });
const build = (paths, commits) => {
  const model = buildModel({ repository: { name: 'root-activity' }, files: paths.map(path => ({ path })), commits });
  return { model, history: buildRootActivityHistory(model) };
};
const idFor = (model, path) => model.nodes.find(node => node.path === path).id;

// Compare the physical history encoding independently of commit-window metadata.
const counters = state => [state.fileTouches, state.folderTouches, state.membershipTouches];

test('baseline has no touches and shared ancestry gains one layer per loaded commit', () => {
  const { model, history } = build(['src/deep/a.js', 'src/deep/b.js', 'src/quiet.js'], [
    { sha: 'one', files: [change('src/deep/a.js'), change('src/deep/b.js')] },
    { sha: 'two', files: [change('src/deep/a.js')] },
    { sha: 'empty', files: [] },
  ]);
  const a = idFor(model, 'src/deep/a.js'), b = idFor(model, 'src/deep/b.js'), quiet = idFor(model, 'src/quiet.js');
  const baseline = rootActivityAt(history, -1);
  assert.ok(counters(baseline).every(map => map.size === 0));
  assert.equal(baseline.touchedFiles.size, 0);
  const first = rootActivityAt(history, 0);
  assert.equal(first.fileTouches.get(a), 1);
  assert.equal(first.fileTouches.get(b), 1);
  assert.equal(first.fileTouches.has(quiet), false);
  for (const path of ['', 'src', 'src/deep']) assert.equal(first.folderTouches.get(path), 1);
  assert.equal(first.membershipTouches.get(rootMembershipKey('src/deep', a)), 1);
  const second = rootActivityAt(history, 1);
  assert.equal(second.fileTouches.get(a), 2);
  assert.equal(second.fileTouches.get(b), 1);
  assert.equal(second.folderTouches.get('src'), 2);
  assert.deepEqual(counters(rootActivityAt(history, 2)), counters(second));
  assert.equal(rootActivityAt(history, 2).touchedFolders.size, 0);
});

test('a cross-folder rename preserves file counts and touches both actual attachments once', () => {
  const { model, history } = build(['lib/a.js'], [
    { sha: 'before', files: [change('src/deep/a.js')] },
    { sha: 'move', files: [change('lib/a.js', 'renamed', { previousPath: 'src/deep/a.js' })] },
    { sha: 'after', files: [change('lib/a.js')] },
  ]);
  const id = model.nodes[0].id;
  assert.equal(model.nodes.length, 1);
  const moved = rootActivityAt(history, 1);
  assert.equal(moved.fileTouches.get(id), 2);
  assert.equal(moved.folderTouches.get(''), 2);
  assert.equal(moved.folderTouches.get('src/deep'), 2);
  assert.equal(moved.folderTouches.get('lib'), 1);
  assert.equal(moved.membershipTouches.get(rootMembershipKey('src/deep', id)), 2);
  assert.equal(moved.membershipTouches.get(rootMembershipKey('lib', id)), 1);
  assert.deepEqual(moved.touchedFiles, new Set([id]));
  assert.deepEqual(moved.touchedFolders, new Set(['', 'lib', 'src', 'src/deep']));
  const after = rootActivityAt(history, 2);
  assert.equal(after.fileTouches.get(id), 3);
  assert.equal(after.membershipTouches.get(rootMembershipKey('src/deep', id)), 2);
  assert.equal(after.membershipTouches.get(rootMembershipKey('lib', id)), 2);
});

test('same-folder renames and duplicate changes do not double-count one strand', () => {
  const { model } = build(['src/output.js'], [{ sha: 'rename', files: [change('src/output.js', 'renamed', { previousPath: 'src/input.js' })] }]);
  model.commits[0].changes.push({ ...model.commits[0].changes[0] });
  const state = rootActivityAt(buildRootActivityHistory(model), 0);
  const id = model.nodes[0].id;
  assert.equal(state.fileTouches.get(id), 1);
  assert.equal(state.folderTouches.get('src'), 1);
  assert.equal(state.membershipTouches.get(rootMembershipKey('src', id)), 1);
  assert.equal(state.touchedMemberships.size, 1);
});

test('deletion keeps historical route counts while a re-added path starts a separate identity', () => {
  const { model, history } = build(['src/a.js'], [
    { sha: 'old-edit', files: [change('src/a.js')] },
    { sha: 'remove', files: [change('src/a.js', 'removed')] },
    { sha: 'add', files: [change('src/a.js', 'added')] },
    { sha: 'new-edit', files: [change('src/a.js')] },
  ]);
  const oldId = model.commits[0].changes[0].id, newId = model.commits[2].changes[0].id;
  assert.notEqual(oldId, newId);
  assert.equal(stateAt(model, 1).activeIds.includes(oldId), false);
  const deleted = rootActivityAt(history, 1);
  assert.equal(deleted.fileTouches.get(oldId), 2);
  assert.equal(deleted.membershipTouches.get(rootMembershipKey('src', oldId)), 2);
  const added = rootActivityAt(history, 2);
  assert.equal(added.fileTouches.get(newId), 1);
  assert.equal(added.membershipTouches.get(rootMembershipKey('src', newId)), 1);
  assert.equal(added.folderTouches.get('src'), 3);
  const latest = rootActivityAt(history, 3);
  assert.equal(latest.fileTouches.get(oldId), 2);
  assert.equal(latest.fileTouches.get(newId), 2);
});

test('every loaded known identity contributes, without a canopy or molecule display cap', () => {
  const nodes = Array.from({ length: 2500 }, (_, index) => ({ id: `file:${index}`, path: `src/f${index}.js` }));
  const history = buildRootActivityHistory({ nodes, commits: [{ sha: 'all', changes: nodes.map(node => ({ id: node.id, path: node.path, status: 'modified' })) }] });
  const state = rootActivityAt(history, 0);
  assert.equal(state.fileTouches.size, 2500);
  assert.equal(state.membershipTouches.size, 2500);
  assert.equal(state.folderTouches.get('src'), 1);
  assert.equal(state.folderTouches.get(''), 1);
});

test('seeking is reversible, clamps to the loaded window and returns independent maps', () => {
  const { history } = build(['a.js'], [
    { sha: 'one', files: [change('a.js')] },
    { sha: 'two', files: [change('a.js')] },
  ]);
  const first = rootActivityAt(history, 0);
  const latest = rootActivityAt(history, 999);
  assert.equal(latest.index, 1);
  first.fileTouches.clear(); first.folderTouches.set('invented', 99); first.touchedFiles.add('invented');
  assert.deepEqual(counters(rootActivityAt(history, 1)), counters(latest));
  assert.equal(rootActivityAt(history, 0).fileTouches.values().next().value, 1);
  assert.equal(rootActivityAt(history, 0).folderTouches.has('invented'), false);
  assert.equal(rootActivityAt(history, -999).index, -1);
  assert.equal(rootActivityAt(history, NaN).index, -1);
  assert.equal(rootActivityAt(history, 0.9).index, 0);
});

test('future commits and source ordering cannot change earlier touch counts', () => {
  const { model, history } = build(['src/a.js', 'src/b.js'], [{ sha: 'first', files: [change('src/a.js'), change('src/b.js')] }]);
  const original = rootActivityAt(history, 0);
  const reordered = { ...model, nodes: [...model.nodes].reverse(), commits: [{ ...model.commits[0], changes: [...model.commits[0].changes].reverse() }] };
  assert.deepEqual(buildRootActivityHistory(reordered), history);
  reordered.commits.push({ sha: 'future', changes: model.commits[0].changes });
  assert.deepEqual(counters(rootActivityAt(buildRootActivityHistory(reordered), 0)), counters(original));
});

test('history is immutable and ignores unknown identities without inventing missing paths', () => {
  const model = { nodes: [{ id: 'known', path: 'today/a.js' }], commits: [{ sha: 'one', changes: [
    { id: 'known', status: 'modified' },
    { id: 'unknown', path: 'wrong/a.js', status: 'modified' },
  ] }] };
  const history = buildRootActivityHistory(model), state = rootActivityAt(history, 0);
  assert.equal(state.fileTouches.get('known'), 1);
  assert.equal(state.fileTouches.has('unknown'), false);
  assert.equal(state.folderTouches.size, 0);
  assert.equal(state.membershipTouches.size, 0);
  assert.throws(() => history.frames[0].fileIds.push('fake'), TypeError);
  assert.throws(() => { history.frames[0].sha = 'fake'; }, TypeError);
  model.commits[0].changes[0].path = 'later/a.js';
  assert.deepEqual(rootActivityAt(history, 0).folderTouches, state.folderTouches);
});

test('root files touch the trunk attachment and empty histories remain valid', () => {
  const { model, history } = build(['README.md'], [{ sha: 'readme', files: [change('README.md')] }]);
  const state = rootActivityAt(history, 0);
  assert.deepEqual(state.folderTouches, new Map([['', 1]]));
  assert.equal(state.membershipTouches.get(rootMembershipKey('', model.nodes[0].id)), 1);
  const empty = rootActivityAt(buildRootActivityHistory({ nodes: [], commits: [] }), 100);
  assert.equal(empty.index, -1);
  assert.equal(empty.commitSha, null);
  assert.ok(counters(empty).every(map => map.size === 0));
});


const growthAt = (model, history, index) => {
  const frame = stateAt(model, index);
  const layout = createRootLayout(model, {
    activeIds: frame.activeIds,
    paths: Object.fromEntries(frame.files.map(file => [file.id, file.path])),
  });
  return rootPathGrowth(layout, rootActivityAt(history, index));
};

test('physical growth carries one hot attachment through its entire current route', () => {
  const { model, history } = build(['src/deep/inner/hot.js', 'src/quiet/cold.js', 'README.md'],
    Array.from({ length: 5 }, (_, index) => ({ sha: `edit-${index}`, files: [change('src/deep/inner/hot.js')] })));
  const growth = growthAt(model, history, 4);
  assert.equal(growth.fileTouches.get(idFor(model, 'src/deep/inner/hot.js')), 5);
  for (const path of ['', 'src', 'src/deep', 'src/deep/inner']) {
    assert.equal(growth.folderTouches.get(path), 5);
    assert.equal(2 ** growth.folderTouches.get(path), 32);
  }
  assert.equal(growth.folderTouches.get('src/quiet'), 0);
  assert.equal(growth.fileTouches.get(idFor(model, 'src/quiet/cold.js')), 0);
  assert.equal(growth.fileTouches.get(idFor(model, 'README.md')), 0);
});

test('alternating descendants grow their shared folder and every ancestor once per commit', () => {
  const { model, history } = build(['src/deep/inner/a.js', 'src/deep/inner/b.js', 'src/quiet/cold.js'],
    ['a', 'b', 'a', 'b'].map((name, index) => ({ sha: `edit-${index}`, files: [change(`src/deep/inner/${name}.js`)] })));
  const a = idFor(model, 'src/deep/inner/a.js'), b = idFor(model, 'src/deep/inner/b.js');
  const first = growthAt(model, history, 0);
  for (let index = 0; index < 4; index++) {
    const growth = growthAt(model, history, index);
    for (const path of ['', 'src', 'src/deep', 'src/deep/inner']) {
      assert.equal(growth.folderTouches.get(path), index + 1);
      assert.equal(2 ** growth.folderTouches.get(path), 2 ** (index + 1));
    }
    assert.equal(growth.folderTouches.get('src/quiet'), 0);
    assert.equal(growth.fileTouches.get(idFor(model, 'src/quiet/cold.js')), 0);
  }
  const latest = growthAt(model, history, 3);
  assert.equal(latest.fileTouches.get(a), 2);
  assert.equal(latest.fileTouches.get(b), 2);
  assert.deepEqual(growthAt(model, history, 0), first, 'rewinding restores the exact earlier cumulative counts');
});

test('multiple changed descendants grow a shared physical folder only once in a commit', () => {
  const { model, history } = build(['src/deep/a.js', 'src/deep/b.js'], [
    { sha: 'both', files: [change('src/deep/a.js'), change('src/deep/b.js')] },
    { sha: 'both-again', files: [change('src/deep/a.js'), change('src/deep/b.js')] },
  ]);
  const growth = growthAt(model, history, 1);
  for (const path of ['', 'src', 'src/deep']) assert.equal(growth.folderTouches.get(path), 2);
  assert.deepEqual([...growth.fileTouches.values()], [2, 2]);
});

test('a moved file resets its attachment while existing old folders retain cumulative growth', () => {
  const { model, history } = build(['lib/a.js', 'src/deep/quiet.js'], [
    { sha: 'one', files: [change('src/deep/a.js')] },
    { sha: 'two', files: [change('src/deep/a.js')] },
    { sha: 'three', files: [change('src/deep/a.js')] },
    { sha: 'move', files: [change('lib/a.js', 'renamed', { previousPath: 'src/deep/a.js' })] },
    { sha: 'after', files: [change('lib/a.js')] },
  ]);
  const id = idFor(model, 'lib/a.js');
  const before = growthAt(model, history, 2);
  assert.equal(before.fileTouches.get(id), 3);
  assert.equal(before.folderTouches.get('src/deep'), 3);
  assert.equal(before.folderTouches.has('lib'), false);
  const moved = growthAt(model, history, 3);
  assert.equal(moved.fileTouches.get(id), 1);
  assert.equal(moved.folderTouches.get('lib'), 1);
  assert.equal(moved.folderTouches.get('src/deep'), 4);
  assert.equal(moved.folderTouches.get('src'), 4);
  assert.equal(moved.folderTouches.get(''), 4);
  assert.equal(moved.fileTouches.get(idFor(model, 'src/deep/quiet.js')), 0);
  assert.equal(rootActivityAt(history, 3).membershipTouches.get(rootMembershipKey('src/deep', id)), 4);
  assert.equal(growthAt(model, history, 4).fileTouches.get(id), 2);
  assert.deepEqual(growthAt(model, history, 2), before, 'rewinding must restore the former current attachment');
});

test('deleting a file retains existing folder growth while re-addition starts a fresh file identity', () => {
  const { model, history } = build(['src/hot.js', 'src/quiet.js'], [
    { sha: 'one', files: [change('src/hot.js')] },
    { sha: 'two', files: [change('src/hot.js')] },
    { sha: 'remove', files: [change('src/hot.js', 'removed')] },
    { sha: 'add', files: [change('src/hot.js', 'added')] },
  ]);
  const oldId = model.commits[0].changes[0].id;
  const newId = model.commits[3].changes[0].id;
  assert.equal(growthAt(model, history, 1).folderTouches.get('src'), 2);
  const removed = growthAt(model, history, 2);
  assert.equal(removed.fileTouches.has(oldId), false);
  assert.equal(removed.folderTouches.get('src'), 3);
  assert.equal(removed.folderTouches.get(''), 3);
  assert.equal(rootActivityAt(history, 2).fileTouches.get(oldId), 3);
  const added = growthAt(model, history, 3);
  assert.equal(added.fileTouches.get(newId), 1);
  assert.equal(added.fileTouches.has(oldId), false);
  assert.equal(added.folderTouches.get('src'), 4);
  assert.equal(added.fileTouches.get(idFor(model, 'src/quiet.js')), 0);
  assert.equal(growthAt(model, history, 1).folderTouches.get('src'), 2);
});

test('path growth is deterministic under file, folder and counter ordering and returns fresh maps', () => {
  const { model, history } = build(['a/deep/one.js', 'a/two.js', 'b/three.js'], [
    { sha: 'first', files: [change('a/deep/one.js'), change('b/three.js')] },
    { sha: 'second', files: [change('a/deep/one.js')] },
  ]);
  const layout = createRootLayout(model), activity = rootActivityAt(history, 1);
  const expected = rootPathGrowth(layout, activity);
  const reversed = rootPathGrowth({ ...layout, nodes: [...layout.nodes].reverse(), folders: [...layout.folders].reverse() },
    { ...activity, membershipTouches: new Map([...activity.membershipTouches].reverse()), folderTouches: new Map([...activity.folderTouches].reverse()) });
  assert.deepEqual([...reversed.fileTouches], [...expected.fileTouches]);
  assert.deepEqual([...reversed.folderTouches], [...expected.folderTouches]);
  reversed.fileTouches.clear(); reversed.folderTouches.set('invented', 100);
  assert.deepEqual(rootPathGrowth(layout, activity), expected);
  assert.equal(activity.folderTouches.has('invented'), false);
});

test('future activity and unrelated counters cannot change an earlier cumulative growth result', () => {
  const { model, history } = build(['src/a.js', 'src/b.js'], [{ sha: 'first', files: [change('src/a.js')] }]);
  const layout = createRootLayout(model), original = rootPathGrowth(layout, rootActivityAt(history, 0));
  const future = { ...model, commits: [...model.commits, { sha: 'future', changes: [{ id: idFor(model, 'src/b.js'), path: 'src/b.js', status: 'modified' }] }] };
  const state = rootActivityAt(buildRootActivityHistory(future), 0);
  state.fileTouches.set(idFor(model, 'src/a.js'), 999);
  state.folderTouches.set('future', 999);
  state.membershipTouches.set(rootMembershipKey('future', idFor(model, 'src/a.js')), 999);
  assert.deepEqual(rootPathGrowth(layout, state), original);
});

test('path growth covers all 2500 present files and every real ancestor without a display limit', () => {
  const nodes = Array.from({ length: 2500 }, (_, index) => ({ id: `file:${index}`, path: `src/group-${index % 50}/file-${index}.js` }));
  const layout = createRootLayout({ repository: { name: 'large' }, nodes });
  const membershipTouches = new Map(layout.nodes.map((node, index) => [rootMembershipKey(node.folder, node.id), index % 7]));
  const folderTouches = new Map(layout.folders.map((folder, index) => [folder.path, index + 100]));
  const growth = rootPathGrowth(layout, { membershipTouches, folderTouches });
  assert.equal(growth.fileTouches.size, 2500);
  assert.equal(growth.folderTouches.size, 52);
  for (const node of layout.nodes) assert.equal(growth.fileTouches.get(node.id), membershipTouches.get(rootMembershipKey(node.folder, node.id)));
  for (const folder of layout.folders) assert.equal(growth.folderTouches.get(folder.path), folderTouches.get(folder.path));
});

test('baseline, root files and empty repositories preserve zero-growth entries', () => {
  const { model, history } = build(['README.md', 'src/quiet.js'], [{ sha: 'readme', files: [change('README.md')] }]);
  const baseline = growthAt(model, history, -1);
  assert.equal(baseline.fileTouches.size, 2);
  assert.ok([...baseline.fileTouches.values(), ...baseline.folderTouches.values()].every(count => count === 0));
  const growth = growthAt(model, history, 0);
  assert.equal(growth.fileTouches.get(idFor(model, 'README.md')), 1);
  assert.equal(growth.folderTouches.get(''), 1);
  assert.equal(growth.folderTouches.get('src'), 0);
  assert.deepEqual(rootPathGrowth(createRootLayout({ nodes: [] }), { membershipTouches: new Map() }), {
    fileTouches: new Map(), folderTouches: new Map([['', 0]]),
  });
});
