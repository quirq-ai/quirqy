import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import GithubSlugger from 'github-slugger';
import { parseRepositoryUrl } from '../data-lab/github.js';
import { encodeRepositoryPath, MAX_README_BYTES } from './readme.js';

const TAGS = ['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'li', 'ol', 'p', 'pre', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul', 'var'];
const ATTRIBUTES = ['href', 'src', 'alt', 'title', 'id', 'name', 'class', 'align', 'width', 'height', 'colspan', 'rowspan', 'start', 'type', 'checked', 'disabled', 'open'];
const countWords = text => String(text || '').trim().split(/\s+/u).filter(Boolean).length;
const decodedFragment = value => { try { return decodeURIComponent(value); } catch { return value; } };

/** Resolve repository-relative references without granting executable URL schemes. */
export function resolveReadmeUrl(value, metadata, { image = false } = {}) {
  const input = String(value || '').trim();
  if (!input || /[\u0000-\u001f\u007f\\]/.test(input)) return null;
  if (input.startsWith('#')) return image ? null : input;
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) || input.startsWith('//')) {
    try {
      const url = new URL(input, 'https://github.com');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }
  let repository;
  try { repository = parseRepositoryUrl(metadata.repository?.url); } catch { return null; }
  const branch = String(metadata.repository.defaultBranch || 'main');
  const path = String(metadata.path || 'README.md');
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  try {
    // URL's path normalization handles ../ while keeping traversal inside this repository.
    const resolved = new URL(input, `https://readme.invalid/${encodeRepositoryPath(directory)}`);
    const relativePath = resolved.pathname.replace(/^\//, '');
    const base = image
      ? `https://raw.githubusercontent.com/${encodeRepositoryPath(repository.fullName)}/${encodeURIComponent(branch)}`
      : `${repository.url}/blob/${encodeURIComponent(branch)}`;
    return `${base}/${relativePath}${resolved.search}${resolved.hash}`;
  } catch { return null; }
}

/**
 * Returns a safe detached article and its heading index. Pass a Document (or
 * {document}) for tests/embedded hosts. README IDs are namespaced so untrusted
 * headings/custom anchors cannot collide with application controls.
 */
export function renderReadme(markdown, metadata, options = {}) {
  const document = options?.nodeType === 9 ? options : options.document || globalThis.document;
  if (!document?.defaultView) throw new Error('A browser document is required to render the README.');
  const source = String(markdown || '');
  if (source.length > MAX_README_BYTES || new TextEncoder().encode(source).byteLength > MAX_README_BYTES) {
    throw new Error('This README is too large to display here (maximum 1 MiB).');
  }
  const purifier = createDOMPurify(document.defaultView);
  const fragment = purifier.sanitize(marked.parse(source, { gfm: true, breaks: false, async: false }), {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
    // All identifiers are rewritten below, before anything is attached to the live DOM.
    SANITIZE_DOM: true,
  });
  // Keep source images in DOMPurify's inert document until URLs and policies are safe.
  const element = fragment.ownerDocument.createElement('article');
  element.className = 'about-readme-content';
  element.append(fragment);
  const slugger = new GithubSlugger();
  const anchorIds = new Map();
  const assignedIds = new Set();
  const uniqueId = slug => {
    const base = `readme-${slug || 'section'}`;
    let id = base;
    let suffix = 1;
    while (assignedIds.has(id)) id = `${base}-${suffix++}`;
    assignedIds.add(id);
    return id;
  };
  const sections = [];
  const sectionByElement = new Map();
  // Heading IDs win over arbitrary custom anchors, matching GitHub table-of-contents links.
  for (const heading of element.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const title = heading.textContent.trim() || 'Untitled section';
    const slug = slugger.slug(title);
    const id = uniqueId(slug);
    for (const alias of [slug, `user-content-${slug}`, heading.getAttribute('id')]) {
      if (alias && !anchorIds.has(alias)) anchorIds.set(alias, id);
    }
    heading.id = id;
    heading.tabIndex = -1;
    heading.removeAttribute('name');
    const section = { id, title, level: Number(heading.tagName.slice(1)), wordCount: 0 };
    sections.push(section);
    sectionByElement.set(heading, section);
  }
  for (const node of element.querySelectorAll('[id],[name]')) {
    if (sectionByElement.has(node)) continue;
    const aliases = [node.getAttribute('id'), node.getAttribute('name')].filter(Boolean);
    node.removeAttribute('id');
    node.removeAttribute('name');
    if (!aliases.length) continue;
    const id = uniqueId(new GithubSlugger().slug(aliases[0]));
    node.id = id;
    for (const alias of aliases) if (!anchorIds.has(alias)) anchorIds.set(alias, id);
  }
  for (const node of element.querySelectorAll('*')) {
    // README-provided CSS classes must never opt into application layout/styles.
    const language = node.tagName === 'CODE' ? /^language-[\w+-]+$/.exec(node.className)?.[0] : null;
    node.removeAttribute('class');
    if (language) node.className = language;
    if (node.hasAttribute('align') && !/^(left|center|right)$/i.test(node.getAttribute('align'))) node.removeAttribute('align');
    for (const attribute of ['width', 'height', 'colspan', 'rowspan', 'start']) {
      if (node.hasAttribute(attribute) && !/^\d{1,4}$/.test(node.getAttribute(attribute))) node.removeAttribute(attribute);
    }
    if (node.tagName === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') { node.remove(); continue; }
      node.disabled = true;
      node.tabIndex = -1;
    }
  }
  for (const anchor of element.querySelectorAll('a')) {
    const raw = anchor.getAttribute('href');
    const href = resolveReadmeUrl(raw, metadata);
    if (!href) { anchor.removeAttribute('href'); continue; }
    if (href.startsWith('#')) {
      const id = anchorIds.get(decodedFragment(href.slice(1)));
      // An unresolved fragment must not scroll/focus arbitrary application UI.
      if (id) anchor.setAttribute('href', `#${id}`);
      else anchor.removeAttribute('href');
    } else {
      anchor.setAttribute('href', href);
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
  }
  for (const image of element.querySelectorAll('img')) {
    const src = resolveReadmeUrl(image.getAttribute('src'), metadata, { image: true });
    if (!src) { image.removeAttribute('src'); continue; }
    image.setAttribute('src', src);
    image.setAttribute('loading', 'lazy');
    image.setAttribute('decoding', 'async');
    image.setAttribute('referrerpolicy', 'no-referrer');
    image.alt ||= '';
  }
  // Count text once, assigned to the nearest preceding heading. Inline markup
  // does not split words; block boundaries do, even in whitespace-free raw HTML.
  const walker = document.createTreeWalker(element, document.defaultView.NodeFilter.SHOW_ELEMENT | document.defaultView.NodeFilter.SHOW_TEXT);
  const textBySection = new Map(sections.map(section => [section, []]));
  const allText = [];
  let current = null;
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1 && sectionByElement.has(node)) current = sectionByElement.get(node);
    const text = node.nodeType === 3 ? node.textContent : /^(H[1-6]|P|DIV|LI|PRE|TR|TD|TH|BLOCKQUOTE|BR|SUMMARY|DD|DT)$/.test(node.tagName) ? '\n' : '';
    allText.push(text);
    if (current) textBySection.get(current).push(text);
  }
  for (const section of sections) section.wordCount = countWords(textBySection.get(section).join(''));
  return { element: document.importNode(element, true), sections, wordCount: countWords(allText.join('')) };
}
