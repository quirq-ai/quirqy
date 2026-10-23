import './style.css';
import { createStage } from '../scene/setup.js';
import { createRenderScheduler } from '../scene/render-on-demand.js';
import { connectedRepository, connectRepository } from '../repository/connection.js';
import { parseRepositoryUrl } from '../data-lab/github.js';
import { loadReadme, loadRepositoryStats } from './readme.js';
import { renderReadme } from './markdown.js';
import { ReadmeScene } from './scene.js';
import { normalizeRepositoryCount, formatRepositoryCount } from './repository-stats.js';
import { readCachedReadme, README_CACHE_KEY } from './cache.js';
import { ABOUT_EXAMPLES, DEFAULT_ABOUT_REPOSITORY, getReadmeExample } from './examples.js';

const READING_SIZE_KEY = 'quirqy.about-reading-size.v1';
const decodeFragment = value => { try { return decodeURIComponent(value); } catch { return value; } };

/** A readable document and its navigable 3D section map share one README. */
export async function mountAboutLab() {
  document.body.dataset.mode = 'about';
  document.title = 'Quirqy · About';
  const lifetime = new AbortController();
  const on = (node, event, listener, options = {}) => node.addEventListener(event, listener, { ...options, signal: lifetime.signal });
  const $ = id => document.getElementById(id);
  const shell = document.createElement('main');
  shell.id = 'about-shell';
  shell.innerHTML = `
    <header class="about-introduction">
      <p class="about-eyebrow"><span></span> About the repository</p>
      <h1 id="about-repo-name">A story, in pages.</h1>
      <div id="about-repo-stats" role="group" aria-label="Repository stars and forks" hidden>
        <a id="about-stars" class="about-repo-stat" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m10 2 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L2.2 7.7l5.4-.8L10 2Z"/></svg><span class="about-stat-value">—</span><span class="about-stat-label">stars</span></a>
        <a id="about-forks" class="about-repo-stat" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="5" cy="4" r="2"/><circle cx="15" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><path d="M5 6v8m10-8v2a3 3 0 0 1-3 3H5"/></svg><span class="about-stat-value">—</span><span class="about-stat-label">forks</span></a>
      </div>
      <p id="about-repo-description">The README, with a little perspective.</p>
    </header>
    <div id="about-scene-slot" aria-hidden="true"></div>
    <div class="about-folio-caption"><span id="about-folio-section">Your README, unfolded</span><p id="about-folio-hint">Each page is a section. Select one to read.</p></div>
    <aside id="about-guide" class="panel" aria-label="README contents">
      <div class="list-title"><span>Contents</span><span id="about-section-count"></span><button id="about-contents-close" type="button" aria-label="Close contents">×</button></div>
      <nav id="about-contents" aria-label="README sections"><p class="about-empty-index">Sections will appear here.</p></nav>
      <button id="about-frame" type="button" class="about-frame">↺ Reset folio</button>
    </aside>
    <section id="about-reader" class="panel about-reader" aria-label="Repository README" aria-busy="true">
      <header class="about-reader-toolbar">
        <div class="about-document-label"><svg width="17" height="19" viewBox="0 0 20 22" fill="none" aria-hidden="true"><path d="M4 2h8l4 4v14H4V2Zm8 0v5h4M7 11h6m-6 4h6" stroke="currentColor" stroke-width="1.2"/></svg><span id="about-file-path">README.md</span><span id="about-branch"></span></div>
        <div class="about-reading-actions"><button id="about-contents-toggle" type="button" aria-expanded="false" aria-controls="about-guide">Contents</button><button id="about-text-smaller" type="button" aria-label="Decrease reading text size">A−</button><button id="about-text-larger" type="button" aria-label="Increase reading text size">A+</button><a id="about-github-link" target="_blank" rel="noopener noreferrer" hidden>GitHub ↗</a></div>
      </header>
      <div class="about-reader-meta"><span id="about-provenance">Opening the connected repository…</span><span id="about-reading-time"></span></div>
      <div id="about-notice" role="status" hidden></div>
      <div id="about-reader-scroll" tabindex="0" aria-label="Scroll README">
        <div id="about-document"><div class="about-reader-placeholder"><span class="about-placeholder-mark">↗</span><h2>Opening the README</h2><p>The repository’s own introduction, in its own words.</p><div class="about-skeleton"></div><div class="about-skeleton short"></div></div></div>
        <footer id="about-reader-end" hidden><span>End of README</span><button type="button" id="about-back-top">Back to top ↑</button></footer>
      </div>
      <div class="about-reading-progress" role="progressbar" aria-label="README reading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="about-progress-fill"></span></div>
    </section>
    <div id="about-hover" role="status" hidden></div>`;
  const source = document.createElement('aside');
  source.id = 'about-panel';
  source.hidden = true;
  source.innerHTML = `<div class="list-title">About</div><div class="section-title">Repository <span id="about-source-kind"></span></div><div id="about-repository-meta"></div><form id="about-source-form"><div class="about-source-row"><input id="about-repository-url" type="url" placeholder="https://github.com/owner/repo" aria-label="Public GitHub repository URL" required/><button id="about-load" class="btn primary" type="submit">Load</button></div><div class="about-example-choices"></div></form><p id="about-status" role="status"></p><div class="about-source-actions"><button id="about-refresh" class="btn" type="button">Refresh from GitHub</button><button id="about-cancel" class="btn" type="button" hidden>Cancel</button></div><div class="about-view-switch seg"><button class="active" type="button" aria-pressed="true">README</button></div>`;
  const dock = document.createElement('footer');
  dock.id = 'about-timebar'; dock.className = 'panel';
  dock.setAttribute('aria-label', 'About dock');
  dock.innerHTML = '<div class="t-mid about-dock-reading"><span id="about-reading-position">README</span><span id="about-reading-percent">0% read</span></div>';
  document.body.append(shell, source, dock);
  for (const repo of ABOUT_EXAMPLES) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = repo.fullName;
    on(button, 'click', () => openRepository(repo.url, { example: true }));
    source.querySelector('.about-example-choices').append(button);
  }
  const stage = createStage($('app'));
  stage.bloom.strength = .32;
  const redraw = createRenderScheduler({ controls: stage.controls });
  const scene = new ReadmeScene(stage, { onSelect: id => navigateSection(id), onHover: section => {
    $('about-hover').hidden = !section;
    if (section) $('about-hover').textContent = section.title || section.id || '';
  } });
  const canvas = stage.renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Interactive 3D folio of README sections. Drag to turn, click a page to read. Use the Contents navigation for keyboard access.');
  const scroll = $('about-reader-scroll');
  let current = null, sections = [], activeSection = null, request = 0, controller = null, raf = 0, previous = 0, disposed = false, scrollFrame = 0;
  let fontSize = 16;
  try { fontSize = Math.max(14, Math.min(20, Number(localStorage.getItem(READING_SIZE_KEY)) || 16)); } catch { /* Preferences are optional. */ }
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  function applyFont() {
    shell.style.setProperty('--readme-size', `${fontSize}px`);
    $('about-text-smaller').disabled = fontSize <= 14; $('about-text-larger').disabled = fontSize >= 20;
    try { localStorage.setItem(READING_SIZE_KEY, String(fontSize)); } catch { /* Optional preference. */ }
    scheduleReading();
  }
  function showContents(open) {
    $('about-guide').classList.toggle('is-open', open);
    $('about-contents-toggle').setAttribute('aria-expanded', String(open));
  }
  function navigateSection(id, { instant = false } = {}) {
    if (!id || !id.startsWith('readme-')) return;
    const heading = $('about-document').querySelector(`#${CSS.escape(id)}`);
    if (!heading) return;
    for (let parent = heading.parentElement; parent && parent !== scroll; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    const top = heading.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 24;
    scroll.scrollTo({ top: Math.max(0, top), behavior: instant || motion.matches ? 'instant' : 'smooth' });
    history.replaceState(history.state, '', `${location.pathname}${location.search}#${encodeURIComponent(id)}`);
    setActive(id); showContents(false);
    heading.tabIndex = -1; heading.focus({ preventScroll: true });
    redraw.invalidate();
  }
  function setActive(id) {
    if (id === activeSection) return;
    activeSection = id; scene.selectSection(id);
    for (const button of $('about-contents').querySelectorAll('button')) {
      if (button.dataset.section === id) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
    const section = sections.find(item => item.id === id);
    $('about-folio-section').textContent = section?.title || 'Your README, unfolded';
    $('about-reading-position').textContent = section ? `${sections.indexOf(section) + 1} / ${sections.length} · ${section.title}` : 'README';
    redraw.invalidate();
  }
  function updateReading() {
    scrollFrame = 0;
    if (!current) return;
    const max = scroll.scrollHeight - scroll.clientHeight;
    const percent = max > 1 ? Math.round(Math.min(1, scroll.scrollTop / max) * 100) : 100;
    $('about-progress-fill').style.width = `${percent}%`;
    shell.querySelector('.about-reading-progress').setAttribute('aria-valuenow', String(percent));
    $('about-reading-percent').textContent = `${percent}% read`;
    const start = scroll.getBoundingClientRect().top + 100;
    let id = sections[0]?.id;
    for (const section of sections) {
      const heading = $(section.id);
      if (heading?.getClientRects().length && heading.getBoundingClientRect().top <= start) id = section.id;
    }
    if (id) setActive(id);
  }
  function scheduleReading() { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateReading); }
  function sizeScene() {
    // Let long repository names and their counts set the top of the desktop folio.
    if (innerWidth > 1000) {
      const top = Math.max(innerHeight <= 850 ? 150 : 185, shell.querySelector('.about-introduction').getBoundingClientRect().bottom + 12);
      shell.style.setProperty('--about-scene-top', `${Math.ceil(top)}px`);
    } else shell.style.removeProperty('--about-scene-top');
    const box = $('about-scene-slot').getBoundingClientRect();
    scene.resize({ x: box.x, y: box.y, width: box.width, height: box.height });
    redraw.invalidate(); scheduleReading();
  }
  function notice(message = '', error = false) {
    $('about-notice').hidden = !message; $('about-notice').textContent = message; $('about-notice').dataset.error = String(error);
  }
  function renderRepositoryStats(repository) {
    const captured = repository.statsFetchedAt && Number.isFinite(Date.parse(repository.statsFetchedAt))
      ? new Date(repository.statsFetchedAt).toLocaleString() : null;
    for (const [key, path] of [['stars', 'stargazers'], ['forks', 'forks']]) {
      const count = normalizeRepositoryCount(repository[key]);
      const link = $(`about-${key}`);
      const exact = formatRepositoryCount(count);
      const description = count === null ? `${key === 'stars' ? 'Star' : 'Fork'} count unavailable in this snapshot` : `${exact} ${key}`;
      link.href = `${repository.url}/${path}`;
      link.querySelector('.about-stat-value').textContent = formatRepositoryCount(count, { compact: true });
      link.setAttribute('aria-label', `${description}. View on GitHub`);
      link.title = `${description}${captured && count !== null ? ` · Snapshot ${captured}` : ''}`;
    }
    $('about-repo-stats').hidden = false;
    canvas.setAttribute('aria-label', `Interactive 3D folio of README sections. ${['stars', 'forks'].map(key => normalizeRepositoryCount(repository[key]) === null ? `${key} unavailable` : `${formatRepositoryCount(repository[key])} ${key}`).join(', ')}. Drag to turn, click a page to read. Use the Contents navigation for keyboard access.`);
  }
  function renderDocument(document, sourceLabel) {
    const rendered = renderReadme(document.markdown, document, { document: window.document });
    current = document; sections = rendered.sections; activeSection = null;
    if (!sections.length) {
      rendered.element.id = 'readme-document';
      sections = [{ id: 'readme-document', title: 'README', level: 1, wordCount: rendered.wordCount }];
    }
    if (!document.markdown.trim()) {
      const empty = window.document.createElement('p'); empty.className = 'about-empty-index'; empty.textContent = 'This README is empty.'; rendered.element.append(empty);
    }
    $('about-document').replaceChildren(rendered.element);
    $('about-reader-end').hidden = false;
    $('about-repo-name').textContent = document.repository.name;
    $('about-repo-description').textContent = document.repository.description || document.repository.fullName;
    renderRepositoryStats(document.repository);
    $('about-file-path').textContent = document.path;
    $('about-branch').textContent = document.repository.defaultBranch;
    $('about-github-link').href = document.htmlUrl; $('about-github-link').hidden = false;
    $('about-section-count').textContent = String(sections.length).padStart(2, '0');
    $('about-reading-time').textContent = `${Math.max(1, Math.ceil(rendered.wordCount / 220))} min read`;
    const date = new Date(document.fetchedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    $('about-provenance').textContent = `${sourceLabel} · ${date}`;
    $('about-source-kind').textContent = sourceLabel;
    $('about-repository-meta').textContent = `${document.repository.fullName} · ${document.repository.defaultBranch}`;
    $('about-repository-url').value = document.repository.url;
    $('about-status').textContent = 'Reading the default branch README. Your connected repository is shared across About, Data, and Activity.';
    $('about-contents').replaceChildren();
    for (const [index, section] of sections.entries()) {
      const button = window.document.createElement('button'); button.type = 'button'; button.dataset.section = section.id;
      button.style.setProperty('--section-depth', Math.min(2, Math.max(0, section.level - 2)));
      const number = window.document.createElement('span'); number.className = 'about-section-number'; number.textContent = String(index + 1).padStart(2, '0');
      const title = window.document.createElement('span'); title.textContent = section.title;
      button.append(number, title); $('about-contents').append(button);
    }
    scene.setSections(sections);
    scene.setRepositoryStats(document.repository);
    $('about-folio-hint').textContent = sections.length ? 'Each page is a section. Select one to read.' : 'This README has no section headings.';
    for (const image of rendered.element.querySelectorAll('img')) {
      image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
      on(image, 'load', scheduleReading);
      on(image, 'error', () => { const fallback = window.document.createElement('span'); fallback.className = 'about-image-fallback'; fallback.textContent = image.alt || 'Image unavailable'; image.replaceWith(fallback); scheduleReading(); });
    }
    scroll.scrollTop = 0;
    connectRepository(document.repository.url);
    notice(); sizeScene();
    const fragment = decodeFragment(location.hash.slice(1));
    if (sections.some(section => section.id === fragment)) navigateSection(fragment, { instant: true });
    else { if (sections[0]) setActive(sections[0].id); scheduleReading(); }
  }
  async function openRepository(input, { refresh = false, example = false } = {}) {
    controller?.abort(); const version = ++request;
    const abort = new AbortController(); controller = abort;
    let timeout;
    $('about-reader').setAttribute('aria-busy', 'true'); $('about-load').disabled = true; $('about-refresh').disabled = true; $('about-cancel').hidden = false;
    try {
      const parsed = parseRepositoryUrl(input);
      $('about-repository-url').value = parsed.url;
      if (current) notice(`Opening ${parsed.fullName}…`);
      const snapshot = !refresh && (example ? getReadmeExample(parsed.url) : readCachedReadme(parsed.url) || getReadmeExample(parsed.url));
      let document = snapshot;
      if (!document) {
        timeout = setTimeout(() => abort.abort(new Error('GitHub took too long to respond. Please retry.')), 25000);
        document = await loadReadme(parsed.url, { signal: abort.signal, onProgress: message => { if (version === request) $('about-status').textContent = message; } });
      }
      if (disposed || version !== request || abort.signal.aborted) return;
      renderDocument(document, snapshot ? snapshot.source === 'bundled' ? 'Bundled README snapshot' : 'Saved README snapshot' : 'Live from GitHub');
      let hydratedStats = false;
      if (snapshot?.source === 'saved' && ['stars', 'forks'].some(key => normalizeRepositoryCount(document.repository[key]) === null)) {
        // Older saved READMEs can gain counts without refetching or replacing the document.
        timeout = setTimeout(() => abort.abort(), 12000);
        try {
          const stats = await loadRepositoryStats(parsed.url, { signal: abort.signal });
          if (disposed || version !== request || abort.signal.aborted) return;
          document.repository = { ...document.repository, ...stats };
          renderRepositoryStats(document.repository);
          scene.setRepositoryStats(document.repository);
          redraw.invalidate();
          hydratedStats = true;
        } catch { /* Keep the saved README and its honest unknown counts usable offline. */ }
      }
      if (disposed || version !== request) return;
      if (!snapshot || hydratedStats) try { localStorage.setItem(README_CACHE_KEY, JSON.stringify({ ...document, source: 'saved' })); } catch { /* Reading still works without cache storage. */ }
    } catch (error) {
      if (disposed || version !== request) return;
      const message = abort.signal.aborted ? abort.signal.reason?.message || 'README loading cancelled.' : error.message;
      $('about-status').textContent = message;
      if (current) notice(`${message} Still showing ${current.repository.fullName}.`, true);
      else {
        $('about-document').innerHTML = '<div class="about-reader-placeholder about-reader-error"><span class="about-placeholder-mark">↗</span><h2>README unavailable</h2><p></p><button type="button" class="btn" id="about-retry">Try again</button><p class="about-empty-source">Use GitHub in the dock to choose another repository or an example.</p></div>';
        $('about-document').querySelector('p').textContent = message;
        on($('about-retry'), 'click', () => openRepository(input, { refresh: true }));
        $('about-provenance').textContent = 'Unable to open this README';
      }
    } finally {
      clearTimeout(timeout);
      if (!disposed && version === request) {
        $('about-reader').setAttribute('aria-busy', 'false'); $('about-load').disabled = false; $('about-refresh').disabled = false; $('about-cancel').hidden = true;
      }
    }
  }
  on($('about-source-form'), 'submit', event => { event.preventDefault(); void openRepository($('about-repository-url').value, { refresh: true }); });
  on($('about-refresh'), 'click', () => openRepository($('about-repository-url').value || current?.repository.url || DEFAULT_ABOUT_REPOSITORY, { refresh: true }));
  on($('about-cancel'), 'click', () => controller?.abort(new Error('README loading cancelled.')));
  on($('about-contents'), 'click', event => { const button = event.target.closest('[data-section]'); if (button) navigateSection(button.dataset.section); });
  on($('about-document'), 'click', event => {
    const anchor = event.target.closest('a[href]'); if (!anchor || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = anchor.getAttribute('href');
    if (href?.startsWith('#')) { event.preventDefault(); navigateSection(decodeFragment(href.slice(1))); }
  });
  on($('about-back-top'), 'click', () => { scroll.scrollTo({ top: 0, behavior: motion.matches ? 'instant' : 'smooth' }); });
  on($('about-text-smaller'), 'click', () => { fontSize = Math.max(14, fontSize - 1); applyFont(); });
  on($('about-text-larger'), 'click', () => { fontSize = Math.min(20, fontSize + 1); applyFont(); });
  on($('about-contents-toggle'), 'click', () => showContents(!$('about-guide').classList.contains('is-open')));
  on($('about-contents-close'), 'click', () => { showContents(false); $('about-contents-toggle').focus(); });
  on($('about-frame'), 'click', () => { scene.frame(); redraw.invalidate(); });
  on(source.querySelector('.about-view-switch button'), 'click', () => { scroll.scrollTo({ top: 0, behavior: motion.matches ? 'instant' : 'smooth' }); });
  on(scroll, 'scroll', scheduleReading, { passive: true });
  on($('about-document'), 'toggle', scheduleReading, { capture: true });
  on(window, 'resize', sizeScene);
  on(window, 'hashchange', () => navigateSection(decodeFragment(location.hash.slice(1)), { instant: true }));
  on(document, 'keydown', event => { if (event.key === 'Escape' && $('about-guide').classList.contains('is-open')) { showContents(false); $('about-contents-toggle').focus(); } });
  const resize = new ResizeObserver(sizeScene); resize.observe($('about-scene-slot')); resize.observe(scroll); resize.observe(shell.querySelector('.about-introduction'));
  const previousAttribution = $('attribution').textContent;
  $('attribution').textContent = 'README folio · Drag to turn · Select a page to read';
  $('loading')?.remove();
  applyFont(); sizeScene();
  function tick(now) {
    if (disposed) return;
    const dt = previous ? Math.min((now - previous) / 1000, .1) : 0; previous = now;
    if (!document.hidden) {
      stage.controls.update(); scene.update(dt);
      if (redraw.shouldRender(now, scene.animating)) { stage.composer.render(); stage.labelRenderer.render(stage.scene, stage.camera); }
    }
    raf = requestAnimationFrame(tick);
  }
  function dispose() {
    if (disposed) return; disposed = true; request++; controller?.abort(); lifetime.abort(); resize.disconnect(); cancelAnimationFrame(raf); cancelAnimationFrame(scrollFrame);
    scene.dispose(); redraw.dispose(); stage.controls.dispose();
    for (const pass of stage.composer.passes) pass.dispose?.(); stage.composer.dispose(); stage.renderer.dispose();
    canvas.remove(); stage.labelRenderer.domElement.remove(); shell.remove(); source.remove(); dock.remove(); $('attribution').textContent = previousAttribution;
    delete window.__aboutLab;
  }
  on(window, 'pagehide', event => { if (!event.persisted) dispose(); });
  on(window, 'pageshow', event => { const url = connectedRepository(); if (event.persisted && url && url !== current?.repository.url) void openRepository(url); });
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  raf = requestAnimationFrame(tick);
  window.__aboutLab = { stage, scene, redraw, get document() { return current; }, get sections() { return sections; }, get activeSection() { return activeSection; }, openRepository };
  void openRepository(connectedRepository() || DEFAULT_ABOUT_REPOSITORY);
  return dispose;
}
