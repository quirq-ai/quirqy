import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRootProportions, ROOT_REFERENCE_WIDTH, ROOT_TIER_HEIGHT, ROOT_LENGTH_PER_TOUCH } from './root-proportions.js';

test('compact repositories keep the established tier and per-touch growth', () => {
  for (const width of [0, 35, 80, 160]) {
    const proportions = createRootProportions(width);
    assert.equal(proportions.repositoryWidth, width);
    assert.equal(proportions.referenceWidth, ROOT_REFERENCE_WIDTH);
    assert.equal(proportions.scale, 1);
    assert.equal(proportions.tierHeight, ROOT_TIER_HEIGHT);
    assert.equal(proportions.lengthPerTouch, ROOT_LENGTH_PER_TOUCH);
  }
});

test('baseline reach and growth increase together with repository width without changing their ratio', () => {
  let previous;
  for (const width of [160, 240, 320, 634.4, 1280, 3200]) {
    const current = createRootProportions(width);
    assert.equal(current.scale, width / 160);
    assert.equal(current.tierHeight, 16 * current.scale);
    assert.equal(current.lengthPerTouch, 6 * current.scale);
    assert.ok(Math.abs(current.lengthPerTouch / current.tierHeight - 6 / 16) < 1e-12);
    if (previous) {
      assert.ok(current.tierHeight > previous.tierHeight);
      assert.ok(current.lengthPerTouch > previous.lengthPerTouch);
    }
    previous = current;
  }
});

test('missing and invalid widths resolve to finite reference proportions', () => {
  const expected = createRootProportions(160);
  for (const width of [undefined, null, NaN, Infinity, -1, 'wide']) assert.deepEqual(createRootProportions(width), expected);
});
