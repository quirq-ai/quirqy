import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderReadme, resolveReadmeUrl } from './markdown.js';

const dom = new JSDOM('<!doctype html><body><button id="data-load">Load</button></body>', { url: 'http://localhost:5174/about' });
const document = dom.window.document;
const metadata = { repository: { url: 'https://github.com/owner/repo', defaultBranch: 'docs/v2' }, path: 'docs/README.md' };
const render = markdown => renderReadme(markdown, metadata, { document });

test('README preserves rich GFM structure, code text, tables, disabled task lists and details', () => {
  const { element, sections, wordCount } = render('# Hello *world*\n\nIntro text.\n\n## Usage\n\n- [x] Ready\n- [ ] Next\n\n| Item | Value |\n| --- | --- |\n| A | **B** |\n\n```js\nconst html = "<script>alert(1)</script>";\n```\n\n<details><summary>More</summary><p>Extra documentation.</p></details>');
  assert.equal(element.tagName, 'ARTICLE');
  assert.equal(element.className, 'about-readme-content');
  assert.equal(element.querySelector('h1 em').textContent, 'world');
  assert.equal(element.querySelectorAll('table tr').length, 2);
  assert.ok(element.querySelector('pre code').textContent.includes('<script>'));
  assert.equal(element.querySelector('pre code').className, 'language-js');
  assert.equal(element.querySelectorAll('input[type="checkbox"][disabled]').length, 2);
  assert.equal(element.querySelector('details summary').textContent, 'More');
  assert.deepEqual(sections.map(({ id, title, level }) => ({ id, title, level })), [
    { id: 'readme-hello-world', title: 'Hello world', level: 1 },
    { id: 'readme-usage', title: 'Usage', level: 2 },
  ]);
  assert.ok(wordCount > 10);
  assert.ok(sections[1].wordCount > sections[0].wordCount);
});

test('GitHub heading slugs and duplicate anchors are stable, Unicode-aware and scoped to README', () => {
  const markdown = '# Hello, world!\n\n## Hello, world!\n\n## 日本語 café\n\n## Hello, world!-1\n\n[Second](#hello-world-1) [Unicode](#%E6%97%A5%E6%9C%AC%E8%AA%9E-caf%C3%A9) [UI](#data-load)';
  const { element, sections } = render(markdown);
  assert.deepEqual(sections.map(s => s.id), ['readme-hello-world', 'readme-hello-world-1', 'readme-日本語-café', 'readme-hello-world-1-1']);
  const anchors = element.querySelectorAll('a');
  assert.equal(anchors[0].getAttribute('href'), '#readme-hello-world-1');
  assert.equal(anchors[1].getAttribute('href'), '#readme-日本語-café');
  assert.equal(anchors[2].hasAttribute('href'), false);
  assert.deepEqual(render(markdown).sections, sections);
});

test('custom anchors work without allowing duplicate IDs or application DOM clobbering', () => {
  const { element } = render('<a name="manual"></a><h2 id="data-load">Overview</h2><p id="manual">Text</p><a href="#manual">Jump</a><a href="#data-load">Heading</a>');
  const ids = [...element.querySelectorAll('[id]')].map(n => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id.startsWith('readme-')));
  assert.equal(element.querySelector('a[href="#readme-manual"]').textContent, 'Jump');
  assert.equal(element.querySelector('a[href="#readme-overview"]').textContent, 'Heading');
  assert.equal(element.querySelectorAll('[name]').length, 0);
});

test('relative files and image assets resolve against README directory and branch', () => {
  assert.equal(resolveReadmeUrl('../src/index.js#L2', metadata), 'https://github.com/owner/repo/blob/docs%2Fv2/src/index.js#L2');
  assert.equal(resolveReadmeUrl('./images/logo.png?raw=true', metadata, { image: true }), 'https://raw.githubusercontent.com/owner/repo/docs%2Fv2/docs/images/logo.png?raw=true');
  assert.equal(resolveReadmeUrl('/assets/logo.png', metadata, { image: true }), 'https://raw.githubusercontent.com/owner/repo/docs%2Fv2/assets/logo.png');
  assert.equal(resolveReadmeUrl('images/my logo.png', metadata, { image: true }), 'https://raw.githubusercontent.com/owner/repo/docs%2Fv2/docs/images/my%20logo.png');
  assert.equal(resolveReadmeUrl('../../../../LICENSE', metadata), 'https://github.com/owner/repo/blob/docs%2Fv2/LICENSE');
  assert.equal(resolveReadmeUrl('//example.com/badge.svg', metadata, { image: true }), 'https://example.com/badge.svg');
  const { element } = render('[Source](../src/index.js)\n\n![Badge](https://img.shields.io/badge/ready-yes-green)\n\n![Logo](images/logo.png)');
  assert.equal(element.querySelector('a').target, '_blank');
  assert.equal(element.querySelector('a').rel, 'noopener noreferrer');
  assert.equal(element.querySelectorAll('img')[1].getAttribute('src'), 'https://raw.githubusercontent.com/owner/repo/docs%2Fv2/docs/images/logo.png');
  for (const image of element.querySelectorAll('img')) {
    assert.equal(image.getAttribute('loading'), 'lazy');
    assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
  }
});

test('README strips executable HTML, forms, CSS, SVG, MathML and hostile application classes', () => {
  const { element } = render('<script>alert(1)</script><iframe src="https://example.com"></iframe><object data="x"></object><svg><a href="javascript:alert(1)">SVG</a></svg><math><mtext>Math</mtext></math><style>body{display:none}</style><form action="https://example.com"><input type="password" name="secret"><input type="checkbox" checked></form><div class="panel-dock is-active" style="position:fixed" onclick="alert(1)" data-dock-material="" id="data-load">Safe</div>');
  assert.equal(element.querySelectorAll('script,iframe,object,svg,math,style,form,input:not([type="checkbox"])').length, 0);
  assert.equal(element.querySelectorAll('[style],[onclick],[data-dock-material]').length, 0);
  assert.equal(element.querySelectorAll('.panel-dock').length, 0);
  assert.equal(element.querySelector('input').disabled, true);
  assert.equal(element.querySelector('div').id, 'readme-data-load');
});

test('README rejects script/data/file/blob URLs, injected handlers and responsive image bypasses', () => {
  const { element } = render('<a href="javascript:alert(1)">JS</a><a href="jav&#x61;script:alert(1)">encoded</a><a href="data:text/html,hello">data</a><a href="file:///etc/passwd">file</a><a href="https://user:pass@example.com">credentials</a><img src="data:image/svg+xml,%3Csvg%20onload=alert(1)%3E" onerror="alert(1)" srcset="https://evil.test/a 2x"><img src="javascript:alert(1)">');
  assert.equal(element.querySelectorAll('a[href]').length, 0);
  assert.equal(element.querySelectorAll('img[src],img[srcset],[onerror]').length, 0);
  for (const url of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:image/png,a', 'blob:https://example.com/1', 'file:///tmp/x', '\\evil.test\\x']) {
    assert.equal(resolveReadmeUrl(url, metadata), null, url);
  }
});

test('malformed HTML attack vectors remain inert after fragment insertion', () => {
  const attacks = [
    '<svg><g/onload=alert(2)//<p>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<a href="jAvAsCrIpT&colon;alert(1)">x</a>',
    '<table><tbody><tr><td><svg><style><img src=x onerror=alert(1)></style></svg></td></tr></tbody></table>',
  ];
  for (const source of attacks) {
    const { element } = render(source);
    document.body.append(element);
    assert.equal(element.querySelectorAll('script,svg,math,style,[onload],[onerror]').length, 0);
    assert.ok([...element.querySelectorAll('[href],[src]')].every(n => /^(https?:|#readme-)/.test(n.getAttribute('href') || n.getAttribute('src'))));
    element.remove();
  }
});

test('README render limit bounds both character and UTF-8 byte size', () => {
  assert.throws(() => render('x'.repeat(1024 * 1024 + 1)), /too large/);
  assert.throws(() => render('🌏'.repeat(300000)), /too large/);
  assert.deepEqual(render('').sections, []);
});

test('section word counts respect inline word boundaries and block boundaries', () => {
  const { wordCount, sections } = render('<h1>Intro</h1><p>un<strong>break</strong>able word.</p><h2>Next</h2><p>One</p><p>Two</p>');
  assert.equal(wordCount, 6);
  assert.deepEqual(sections.map(section => section.wordCount), [3, 3]);
});
