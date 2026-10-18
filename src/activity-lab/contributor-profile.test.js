import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { contributorPortrait } from './contributor-profile.js';
import { ACTIVITY_EXAMPLES, getActivityExample } from './examples.js';

const known = { login: 'quirq-gates', avatarUrl: 'https://avatars.githubusercontent.com/u/333820652?v=4' };

test('bundled portraits require both the GitHub login and its verified avatar identity', () => {
  assert.equal(contributorPortrait(known), '/data-lab/authors/quirq-gates.png');
  assert.equal(contributorPortrait({ ...known, login: 'QUIRQ-GATES', avatarUrl: `${known.avatarUrl}&s=256` }), '/data-lab/authors/quirq-gates.png');
  assert.equal(contributorPortrait({ login: 'Copilot', avatar_url: 'https://avatars.githubusercontent.com/in/1143301?v=4' }), '/activity-lab/contributors/copilot.png');
  assert.equal(contributorPortrait({ ...known, avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4' }), 'https://avatars.githubusercontent.com/u/1?v=4');
  assert.equal(contributorPortrait({ ...known, login: 'someone-else' }), known.avatarUrl);
  assert.equal(contributorPortrait({ login: known.login }), null);
});

test('missing pictures and unsafe image URLs preserve the scene fallback', () => {
  for (const actor of [null, undefined, {}, { login: '../unsafe', avatarUrl: known.avatarUrl }]) assert.equal(contributorPortrait(actor), null);
  for (const avatarUrl of [
    'javascript:alert(1)', 'data:image/svg+xml,<svg/>', '/activity-lab/contributors/copilot.png',
    'http://avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com.evil.test/u/1',
    'https://evil.test/avatar.png', 'https://user:password@avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com:444/u/1', 'https://avatars.githubusercontent.com/u/1#fragment',
  ]) assert.equal(contributorPortrait({ ...known, avatarUrl }), null, avatarUrl);
  const remote = 'https://avatars.githubusercontent.com/u/987654321?v=4';
  assert.equal(contributorPortrait({ login: 'new-contributor', avatarUrl: remote, url: 'javascript:alert(1)' }), remote);
});

test('every bundled contributor has an existing local portrait with matching provenance and bytes', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../../public/activity-lab/contributors/provenance.json', import.meta.url), 'utf8'));
  const portraits = new Map(manifest.portraits.map(portrait => [portrait.login.toLowerCase(), portrait]));
  const seen = new Set();
  for (const example of ACTIVITY_EXAMPLES) {
    const dataset = await getActivityExample(example.url);
    for (const item of dataset.items.filter(item => item.kind === 'contributor')) {
      const record = portraits.get(item.actor.login.toLowerCase());
      assert.ok(record, item.actor.login);
      assert.equal(new URL(item.actor.avatarUrl).pathname, record.avatarIdentity);
      assert.equal(contributorPortrait(item.actor), record.avatarPath);
      assert.match(record.avatarPath, /^\/(?:activity-lab\/contributors|data-lab\/authors)\/[a-z0-9-]+\.(?:png|jpg)$/);
      const bytes = readFileSync(new URL(`../../public${record.avatarPath}`, import.meta.url));
      assert.equal(bytes.length, record.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
      assert.ok(record.width > 0 && record.width === record.height);
      assert.ok(record.repositories.includes(dataset.repository.fullName));
      seen.add(item.actor.login.toLowerCase());
    }
  }
  assert.equal(seen.size, 13);
  assert.equal(manifest.portraits.filter(record => record.reusedFrom).length, 7);
  assert.equal(manifest.portraits.filter(record => !record.reusedFrom).length, 6);
});
