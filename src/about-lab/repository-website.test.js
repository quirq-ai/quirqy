import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepositoryWebsite } from './repository-website.js';

test('repository websites preserve HTTP(S) links and infer HTTPS for bare domains', () => {
  const cases = [
    ['https://xo.quirq.dev', 'https://xo.quirq.dev/'],
    [' HTTP://Example.COM/docs?q=hello#start ', 'http://example.com/docs?q=hello#start'],
    ['example.com', 'https://example.com/'],
    ['www.example.com/docs?q=hello#start', 'https://www.example.com/docs?q=hello#start'],
    ['example.com:8443/docs', 'https://example.com:8443/docs'],
    ['//example.com/docs', 'https://example.com/docs'],
    ['https://例え.テスト/資料', 'https://xn--r8jz45g.xn--zckzah/%E8%B3%87%E6%96%99'],
    ['https://localhost:3000', 'https://localhost:3000/'],
    ['http://[::1]:8080', 'http://[::1]:8080/'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeRepositoryWebsite(input), expected, input);
});

test('missing and malformed repository websites stay absent instead of becoming relative links', () => {
  for (const value of [undefined, null, false, true, 123, [], {}, '', ' ', 'localhost', 'README',
    '/example.com', '///example.com', '/docs/README.md', '../example.com', 'docs/readme.md',
    'https:///example.com', 'https:example.com', 'http:/example.com', 'https://',
    'https://example..com', 'https://-example.com', 'https://example-.com', 'https://ex_ample.com',
    'https://example.com:65536', 'https://[not-an-ip]', 'not a website.com', 'https://example.com/a b']) {
    assert.equal(normalizeRepositoryWebsite(value), null, String(value));
  }
});

test('repository websites reject executable schemes, embedded credentials, controls and backslashes', () => {
  for (const value of ['javascript:alert(1)', 'JaVaScRiPt:123', 'data:text/html,hello',
    'mailto:hello@example.com', 'tel:1234', 'file:///tmp/site.html', 'blob:https://example.com/id',
    'ftp://example.com', 'https://user:pass@example.com', 'https://user@example.com',
    'user:pass@example.com', '//user:pass@example.com', 'https://@example.com',
    'https://example.com\n', '\thttps://example.com', 'https://exam\rple.com',
    'https://example.com/\u0000', 'https://example.com/\u007f', 'https://example.com/\u0085',
    'https:\\example.com', 'https://example.com\\@evil.test', 'https://example.com/a\u00a0b']) {
    assert.equal(normalizeRepositoryWebsite(value), null, JSON.stringify(value));
  }
});
