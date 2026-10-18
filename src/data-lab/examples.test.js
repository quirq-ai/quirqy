import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EXAMPLE_URL, EXAMPLE_REPOSITORIES, getExampleDataset } from './examples.js';
import { buildModel, stateAt } from './model.js';

test('the only built-in examples are the two requested repositories, with XO as default', () => {
  assert.deepEqual(EXAMPLE_REPOSITORIES.map(example => example.url), [
    'https://github.com/quirq-ai/xo',
    'https://github.com/quirq-ai/xo-space',
  ]);
  assert.equal(DEFAULT_EXAMPLE_URL, EXAMPLE_REPOSITORIES[0].url);
  assert.equal(getExampleDataset().repository.fullName, 'quirq-ai/xo');
  assert.equal(getExampleDataset('https://github.com/someone/another-repository'), null);
  assert.equal(getExampleDataset('https://example.com/quirq-ai/xo'), null);
  assert.equal(getExampleDataset(' https://github.com/QUIRQ-AI/XO.git/ ').repository.fullName, 'quirq-ai/xo');
});

for (const example of EXAMPLE_REPOSITORIES) {
  for (const limit of [8, 12, 20]) {
    test(`${example.name}: ${limit}-commit window preserves the pinned head and correct export provenance`, () => {
      const dataset = getExampleDataset(example.url, limit);
      assert.equal(dataset.repository.source, 'example');
      assert.match(dataset.repository.headSha, /^[0-9a-f]{40}$/);
      assert.equal(dataset.repository.headSha, example.headSha);
      assert.ok(Number.isFinite(Date.parse(dataset.repository.capturedAt)));
      assert.equal(dataset.commits.length, limit);
      assert.equal(dataset.commits.at(-1).sha, dataset.repository.headSha);
      assert.equal(dataset.provenance.commitCount, limit);
      assert.equal(dataset.provenance.firstParentBoundarySha, dataset.commits[0].firstParent);
      assert.equal(dataset.provenance.bundledCommitCount, 20);
      for (let i = 1; i < dataset.commits.length; i++) {
        assert.equal(dataset.commits[i].firstParent, dataset.commits[i - 1].sha);
      }
      const untouched = JSON.stringify(dataset);
      const model = buildModel(dataset);
      const head = stateAt(model, limit - 1);
      assert.deepEqual(head.files.filter(file => file.exists).map(file => file.path).sort(),
        dataset.files.filter(file => file.existsAtHead).map(file => file.path).sort());
      assert.equal(head.summary.activeFiles, dataset.provenance.headFileCount);
      assert.equal(model.coverage.limitations.length, dataset.coverage.limitations.length, 'complete snapshots must not need inferred membership');
      assert.equal(JSON.stringify(dataset), untouched, 'building a model does not mutate cached input');
    });
  }
}

test('switching or modifying an example cannot corrupt subsequent selections', () => {
  const first = getExampleDataset(DEFAULT_EXAMPLE_URL, 8);
  const originalMessage = first.commits[0].message;
  first.commits[0].message = 'Changed by a consumer';
  first.files.splice(0);
  first.repository.fullName = 'changed';
  getExampleDataset(EXAMPLE_REPOSITORIES[1].url, 20);
  const again = getExampleDataset(DEFAULT_EXAMPLE_URL, 8);
  assert.equal(again.commits[0].message, originalMessage);
  assert.ok(again.files.length > 0);
  assert.equal(again.repository.fullName, 'quirq-ai/xo');
});
