import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepositoryCount, formatRepositoryCount } from './repository-stats.js';

test('repository counts preserve real zero and exact nonnegative safe integers', () => {
  for (const count of [0, 1, 26, 1234567, Number.MAX_SAFE_INTEGER]) {
    assert.equal(normalizeRepositoryCount(count), count);
  }
  assert.equal(Object.is(normalizeRepositoryCount(-0), -0), false);
});

test('missing and malformed repository counts remain unknown rather than becoming zero', () => {
  for (const value of [undefined, null, false, true, '', ' ', '0', '26', -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, [], {}]) {
    assert.equal(normalizeRepositoryCount(value), null, String(value));
    assert.equal(formatRepositoryCount(value), '—', String(value));
    assert.equal(formatRepositoryCount(value, { compact: true }), '—', String(value));
  }
});

test('count formatting distinguishes zero, exact labels and compact visual counts', () => {
  assert.equal(formatRepositoryCount(0), '0');
  assert.equal(formatRepositoryCount(0, { compact: true }), '0');
  assert.equal(formatRepositoryCount(26), new Intl.NumberFormat().format(26));
  assert.equal(formatRepositoryCount(1234567), new Intl.NumberFormat().format(1234567));
  const compact = formatRepositoryCount(1234567, { compact: true });
  assert.equal(compact, new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(1234567));
  assert.ok(compact.length < formatRepositoryCount(1234567).length);
});
