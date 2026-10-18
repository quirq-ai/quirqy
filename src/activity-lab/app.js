import './style.css';
import { createStage } from '../scene/setup.js';
import { DataLabControls } from '../data-lab/data-controls.js';
import { makePanelDraggable } from '../ui/dragPanel.js';
import { restoreRepositorySession, flushRepositorySession } from '../repository/session.js';
import { connectedRepository, connectRepository } from '../repository/connection.js';
import { loadActivityRepository } from './github.js';
import { getActivityExample, DEFAULT_ACTIVITY_EXAMPLE_URL } from './examples.js';
import { buildCommunityModel, filterCommunityItems } from './model.js';
import { ActivityScene } from './scene.js';

const KINDS = [
  ['pull_request', 'Pull requests', '#a6baf0', 'Proposed changes and merges'],
  ['issue', 'Issues', '#86d7ad', 'Questions, bugs and ideas'],
  ['review', 'Reviews', '#e5ba78', 'Feedback on pull requests'],
  ['comment', 'Comments', '#87c8d0', 'Conversations around the work'],
  ['fork', 'Forks', '#c6a5dd', 'Repositories branching outward'],
  ['contributor', 'Contributors', '#d9dfe9', 'People participating in the project'],
];
const VIEW_LABELS = { constellation: 'Constellation', orbits: 'Orbits', contributors: 'Contributors' };
const CACHE_KEY = 'quirq-observatory.activity-snapshot.v2';
const PREF_KEY = 'quirq-observatory.activity-view.v2';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateText = value => value && Number.isFinite(Date.parse(value)) ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Not dated';
const titleKind = kind => KINDS.find(entry => entry[0] === kind)?.[1] || 'Activity';
const safeUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port ? url.href : null; }
  catch { return null; }
};
const freshFilters = () => ({ query: '', kinds: [], actor: '', state: '' });

export async function mountActivityLab() {
  document.body.dataset.mode = 'activity';
  document.title = 'quirq observatory · Activity Lab';
  for (const tab of document.querySelectorAll('#tab-switch a')) tab.classList.toggle('active', tab.id === 'tab-activity');
  const $ = selector => document.querySelector(selector);
  const lifetime = new AbortController();
  const on = (node, event, fn, options = {}) => node?.addEventListener(event, fn, { ...options, signal: lifetime.signal });
  let model = null, items = [], selectedId = null, view = 'constellation', filters = freshFilters();
  let index = -1, playing = false, speed = 1, elapsed = 0, previousTime = 0, raf = 0;
  let request = 0, controller = null, disposed = false, sheet = null, previousFocus = null;
  const collapsed = { guide: false, panel: false };
  try { const saved = JSON.parse(localStorage.getItem(PREF_KEY)); if (VIEW_LABELS[saved?.view]) view = saved.view; } catch { /* Optional preference. */ }
  for (const name of ['guide', 'panel']) {
    try { collapsed[name] = localStorage.getItem(`observatory-activity-${name}-collapsed`) === 'true'; } catch { /* Optional preference. */ }
  }
  const guide = document.createElement('aside');
  guide.id = 'activity-guide'; guide.className = 'panel'; guide.setAttribute('aria-label', 'Scene guide and activity filters');
  guide.innerHTML = `<div class="list-title"><span>Scene guide</span><button id="activity-guide-collapse" class="activity-sheet-close" type="button" aria-label="Collapse scene guide" aria-expanded="true" aria-controls="activity-guide-body">−</button></div>
    <div id="activity-guide-body"><p class="lab-note activity-intro">A repository is shaped by the people and conversations around it. Explore that community in three dimensions.</p>
    <div class="section-title">Reading the constellation</div><p id="activity-view-description" class="lab-note"></p>
    <div class="activity-kind-key" aria-label="Activity types">${KINDS.map(([kind, label, color, description]) => `<button type="button" data-kind="${kind}" aria-pressed="false" title="Filter ${label.toLowerCase()}"><i style="--kind-color:${color}" aria-hidden="true"></i><span>${label}<small>${description}</small></span><b data-count="${kind}">0</b></button>`).join('')}</div>
    <p class="lab-note activity-key-hint">Select a type to filter. Lines connect reviews and comments to their thread, and activity to its contributor.</p>
    <div class="section-title">Find activity</div><div class="activity-fields"><label class="activity-sr-only" for="activity-search">Search activity</label><input id="activity-search" type="search" placeholder="Title, #number or contributor…" autocomplete="off"><label for="activity-author">Contributor</label><select id="activity-author"><option value="">Everyone</option></select><label for="activity-state">Current status</label><select id="activity-state"><option value="">Any status</option><option value="open">Open</option><option value="closed">Closed</option><option value="merged">Merged</option></select></div>
    <div class="activity-filter-footer"><span id="activity-match-count" role="status"></span><button id="activity-clear-filters" class="activity-text-button" type="button">Reset</button></div>
    <div class="section-title">Explore</div><div class="activity-guide-actions"><button id="activity-frame" class="btn tiny" type="button">Frame view <kbd>F</kbd></button></div><p class="lab-note activity-key-hint">Drag to orbit · scroll to zoom<br>Click a body to inspect · double-click to focus</p>
    <details class="activity-guide-details"><summary class="section-title">What the scene means</summary><p class="lab-note">Every body represents a loaded GitHub record. Color identifies the kind of activity. Position groups relationships; it does not rank people. Contributor totals describe recorded contributions, not effort or productivity.</p><p class="lab-note">Playback reveals records as dated events arrive. Status and contribution totals are the current snapshot. Contributor bodies have no historical timestamp and remain visible throughout replay.</p></details></div>`;

  const panel = document.createElement('aside');
  panel.id = 'activity-panel'; panel.className = 'panel'; panel.setAttribute('aria-label', 'Activity Lab repository and inspector');
  panel.innerHTML = `<div class="list-title"><span>Activity Lab</span><button id="activity-panel-collapse" class="activity-sheet-close" type="button" aria-label="Collapse Activity Lab" aria-expanded="true" aria-controls="activity-panel-body">−</button></div>
    <div id="activity-panel-body"><div class="section-title">Repository <span id="activity-source-kind" class="lab-hint"></span></div>
    <form id="activity-source-form"><div class="activity-source-row"><label class="activity-sr-only" for="activity-repository-url">Public GitHub repository URL</label><input id="activity-repository-url" type="url" required placeholder="https://github.com/owner/repository" autocomplete="off" spellcheck="false"><button id="activity-load" class="btn tiny primary" type="submit">Load</button></div><div class="activity-example-choices" role="group" aria-label="Preloaded examples"><button class="btn tiny" type="button" data-example-url="https://github.com/quirq-ai/xo">quirq-ai/xo</button><button class="btn tiny" type="button" data-example-url="https://github.com/quirq-ai/xo-space">quirq-ai/xo-space</button></div></form>
    <div id="activity-repository-meta" class="activity-repository-meta"></div><p id="activity-status" class="lab-note" role="status" aria-live="polite">Loading repository activity…</p><div class="activity-source-actions"><button type="button" id="activity-refresh" class="activity-text-button">Refresh from GitHub</button><button type="button" id="activity-cancel" class="activity-text-button" hidden>Cancel</button></div>
    <div class="seg activity-view-switch" role="group" aria-label="3D activity view">${Object.entries(VIEW_LABELS).map(([key, label]) => `<button data-view="${key}" type="button" aria-pressed="${view === key}" class="${view === key ? 'active' : ''}">${label}</button>`).join('')}</div>
    <div class="section-title">Selected activity <button id="activity-clear-selection" class="activity-text-button" type="button" hidden>Clear</button></div><div id="activity-inspector" class="activity-inspector"><p class="lab-note">Select a body in the scene or an activity below to see its details.</p></div>
    <div class="section-title">Activity index <span class="lab-hint" id="activity-index-count"></span></div><div id="activity-index" class="activity-index" role="list" aria-label="Loaded activities"></div><button type="button" id="activity-more" class="activity-text-button activity-more" hidden>Show more</button>
    <details class="activity-coverage"><summary class="section-title">Data coverage</summary><div id="activity-coverage"></div><button class="btn tiny" id="activity-export" type="button">Export snapshot</button></details><div class="activity-crosslink"><a class="btn tiny" href="/data" id="activity-open-data">Open repository in Data Lab ↗</a></div></div>`;

  const dock = document.createElement('footer');
  dock.id = 'activity-timebar'; dock.className = 'panel'; dock.setAttribute('aria-label', 'Repository activity playback');
  dock.innerHTML = `<button class="tbtn activity-step" id="activity-prev" type="button" aria-label="Previous activity event" title="Previous event">‹</button><button class="tbtn big" id="activity-play" type="button" aria-label="Play activity events" title="Play / pause (Space)" aria-pressed="false">▶</button><div class="t-mid"><div id="activity-time-label">Loading activity…</div><label class="activity-sr-only" for="activity-scrub">Activity event position</label><input id="activity-scrub" type="range" min="-1" max="0" value="-1" step="1"><div class="mt-hint" id="activity-time-date">Public collaboration activity</div></div><button class="tbtn activity-step" id="activity-next" type="button" aria-label="Next activity event" title="Next event">›</button><label class="activity-speed"><span class="activity-sr-only">Playback speed</span><select id="activity-speed" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>`;
  const toggles = ['guide', 'panel'].map(name => {
    const el = document.createElement('button'); el.id = `activity-${name}-toggle`; el.className = 'tbtn activity-sheet-toggle'; el.type = 'button';
    el.textContent = name === 'guide' ? 'Scene guide' : 'Activity Lab'; el.setAttribute('aria-controls', `activity-${name}`); el.setAttribute('aria-expanded', 'false'); return el;
  });
  const tooltip = document.createElement('div'); tooltip.id = 'activity-tooltip'; tooltip.hidden = true;
  const empty = document.createElement('div'); empty.id = 'activity-empty'; empty.hidden = true; empty.setAttribute('role', 'status');
  document.body.append(guide, panel, dock, ...toggles, tooltip, empty);
  const viewSwitch = panel.querySelector('.activity-view-switch');
  const removeDrag = makePanelDraggable(panel, { storageKey: 'observatory-activity-panel-pos', handleSelector: '.list-title' });
  const stage = createStage($('#app'));
  stage.controls.dispose(); stage.controls = new DataLabControls(stage.camera, stage.renderer.domElement);
  const scene = new ActivityScene(stage, {
    onSelect: id => selectItem(id, true),
    onHover: hit => {
      const item = model?.items.find(item => item.id === hit?.id);
      tooltip.hidden = !item;
      if (item) { tooltip.textContent = item.title; tooltip.style.left = `${Math.max(8, Math.min(innerWidth - 270, hit.x + 14))}px`; tooltip.style.top = `${Math.min(innerHeight - 80, hit.y + 16)}px`; }
    },
  });
  scene.setView(view);
  const canvas = stage.renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Interactive 3D repository activity. Drag to orbit, scroll to zoom, click a body to inspect. The Activity index provides keyboard access to every loaded item.');
  const help = $('#help-overlay');
  const oldHelp = help.innerHTML;
  help.innerHTML = `<div class="help-card" role="dialog" aria-modal="true" aria-labelledby="activity-help-title" tabindex="-1"><button class="panel-close" id="activity-help-close" type="button" aria-label="Close help">×</button><h2 id="activity-help-title">Activity Lab</h2><p class="help-sub">A three-dimensional view of the collaboration around a repository: pull requests, issues, reviews, comments, forks and contributors.</p><div class="help-grid"><span>Drag / right-drag</span><span>Orbit / pan</span><span>Scroll / pinch</span><span>Zoom</span><span>Click / double-click</span><span>Inspect / focus an activity</span><span>Space</span><span>Play / pause</span><span>← / →</span><span>Previous / next event</span><span>F</span><span>Frame the whole scene</span><span>H / Escape</span><span>Open / close help</span></div><p>Constellation groups bodies by activity type. Orbits arranges them around the repository. Contributors brings related participation together. All three views use the same real records and filters.</p><p>Play to reveal records through their dated events. Contributor totals and statuses are current snapshot values, not historical state. Colors identify activity types. Connections represent real parent threads and matching contributors. Positions and sizes do not measure productivity.</p><p>Only XO and XO Space are bundled examples. Refresh from GitHub for newer public data, or connect another public repository. The Data coverage section lists sampling and access limits. Use View in the dock for scene choices and shared glass opacity.</p></div>`;
  const previousAttribution = $('#attribution').textContent;
  $('#attribution').textContent = 'Repository community · Drag to orbit · Scroll to zoom · H for help';
  let visibleLimit = 40;

  function status(message, kind = '') { $('#activity-status').textContent = message; $('#activity-status').dataset.kind = kind; }
  function loading(value) { $('#activity-source-form').setAttribute('aria-busy', String(value)); $('#activity-load').disabled = value; $('#activity-load').textContent = value ? 'Loading…' : 'Load'; $('#activity-refresh').disabled = value || !model; $('#activity-cancel').hidden = !value; }
  function updatePanels() {
    for (const name of ['guide', 'panel']) {
      const narrow = innerWidth <= (name === 'guide' ? 1200 : 900);
      const open = narrow ? sheet === name : !collapsed[name];
      $(`#activity-${name}-body`).hidden = !narrow && !open;
      $(`#activity-${name}`).classList.toggle('activity-collapsed', !narrow && !open);
      $(`#activity-${name}`).classList.toggle('activity-sheet-open', narrow && open);
      const button = $(`#activity-${name}-collapse`); button.textContent = !narrow && !open ? '+' : '−'; button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', `${narrow ? 'Close' : open ? 'Collapse' : 'Expand'} ${name === 'guide' ? 'scene guide' : 'Activity Lab'}`);
      $(`#activity-${name}-toggle`).setAttribute('aria-expanded', String(narrow && open));
    }
  }
  function collapse(name) {
    if (innerWidth <= (name === 'guide' ? 1200 : 900)) { sheet = null; $(`#activity-${name}-toggle`).focus(); }
    else { collapsed[name] = !collapsed[name]; try { localStorage.setItem(`observatory-activity-${name}-collapsed`, String(collapsed[name])); } catch { /* Optional preference. */ } }
    updatePanels();
  }
  function setPlaying(value) { playing = Boolean(value && model?.events.length); elapsed = 0; renderPlayback(); }
  function togglePlayback() {
    if (!model?.events.length) return;
    if (!playing && index >= model.events.length - 1) seek(-1);
    setPlaying(!playing);
  }
  function cursorDate() { return index < 0 ? '0001-01-01T00:00:00Z' : index >= (model?.events.length || 0) - 1 ? null : model.events[index]?.date || null; }
  function seek(next, pause = true) {
    if (!model) return;
    if (pause) setPlaying(false);
    index = Math.max(-1, Math.min(model.events.length - 1, Number(next)));
    selectedId = model.events[index]?.itemId || null;
    render();
  }
  function selectItem(id, focusPanel = false) {
    if (id && !items.some(item => item.id === id)) return;
    setPlaying(false); selectedId = id; scene.setSelected(id); renderInspector(); renderIndex();
    if (focusPanel && innerWidth <= 900) { sheet = 'panel'; updatePanels(); }
  }
  function renderPlayback() {
    if (!model) return;
    const event = model.events[index];
    $('#activity-play').textContent = playing ? '❚❚' : '▶'; $('#activity-play').setAttribute('aria-pressed', String(playing));
    $('#activity-play').setAttribute('aria-label', playing ? 'Pause activity events' : 'Play activity events');
    $('#activity-play').disabled = !model.events.length;
    $('#activity-prev').disabled = index < 0; $('#activity-next').disabled = index >= model.events.length - 1;
    $('#activity-scrub').max = String(Math.max(-1, model.events.length - 1)); $('#activity-scrub').value = String(index); $('#activity-scrub').disabled = !model.events.length;
    const item = model.items.find(item => item.id === event?.itemId);
    $('#activity-time-label').textContent = event ? `${index + 1} / ${model.events.length} · ${event.action || titleKind(event.kind)}${item?.number ? ` #${item.number}` : ''}` : model.events.length ? 'Before recorded activity' : 'No dated events in this snapshot';
    $('#activity-time-date').textContent = event ? dateText(event.date) : 'Contributors show current snapshot participation';
  }
  function renderInspector() {
    const item = model?.items.find(item => item.id === selectedId);
    $('#activity-clear-selection').hidden = !item;
    if (!item) { $('#activity-inspector').innerHTML = '<p class="lab-note">Select a body in the scene or an activity below to inspect its details.</p>'; return; }
    const url = safeUrl(item.url), profile = safeUrl(item.actor?.url), parent = model.items.find(record => record.id === item.parentId);
    const color = KINDS.find(entry => entry[0] === item.kind)?.[2] || '#d9dfe9';
    $('#activity-inspector').innerHTML = `<div class="activity-item-heading"><span class="activity-kind-label" style="--kind-color:${color}">${esc(titleKind(item.kind))}${item.number ? ` · #${esc(item.number)}` : ''}</span>${item.state ? `<span class="activity-state">${esc(item.state.replaceAll('_', ' '))}</span>` : ''}</div><h2>${esc(item.title)}</h2><dl class="stat-grid"><dt>${item.kind === 'contributor' ? 'Contributor' : item.kind === 'fork' ? 'Owner' : 'By'}</dt><dd>${profile ? `<a href="${esc(profile)}" target="_blank" rel="noopener noreferrer">${esc(item.actor?.login)}</a>` : esc(item.actor?.login || 'Unknown')}</dd>${item.createdAt ? `<dt>Created</dt><dd>${dateText(item.createdAt)}</dd>` : ''}${item.updatedAt && item.updatedAt !== item.createdAt ? `<dt>Updated</dt><dd>${dateText(item.updatedAt)}</dd>` : ''}${item.contributions != null ? `<dt>Contributions</dt><dd>${Number(item.contributions).toLocaleString()}</dd>` : ''}</dl>${parent ? `<button class="activity-parent activity-text-button" type="button" data-parent="${esc(parent.id)}">↳ ${esc(parent.title)}</button>` : ''}<div class="activity-inspector-actions"><button class="btn tiny" type="button" id="activity-focus">Focus in 3D</button>${url ? `<a class="btn tiny" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a>` : ''}</div>`;
  }
  function renderIndex() {
    $('#activity-index-count').textContent = String(items.length);
    $('#activity-index').innerHTML = items.slice(0, visibleLimit).map(item => `<button class="activity-index-row${item.id === selectedId ? ' selected' : ''}" type="button" data-item="${esc(item.id)}" aria-pressed="${item.id === selectedId}" aria-label="Inspect ${esc(titleKind(item.kind))}: ${esc(item.title)}"><i style="--kind-color:${KINDS.find(entry => entry[0] === item.kind)?.[2] || '#d9dfe9'}" aria-hidden="true"></i><span>${esc(item.title)}<small>${esc(item.actor?.login || 'Unknown')}${item.number ? ` · #${esc(item.number)}` : ''}</small></span></button>`).join('') || '<p class="lab-note">No activity matches this view.</p>';
    $('#activity-more').hidden = items.length <= visibleLimit;
  }
  function render() {
    if (!model) return;
    items = filterCommunityItems(model, filters, cursorDate());
    const ids = new Set(items.map(item => item.id));
    if (selectedId && !ids.has(selectedId)) selectedId = null;
    scene.setVisible(ids); scene.setSelected(selectedId);
    $('#activity-match-count').textContent = `${items.length} of ${model.items.length} bodies`;
    empty.hidden = items.length > 0;
    empty.textContent = model.items.length ? 'No activity matches these filters or this point in time.' : 'No public collaboration records were returned. Try refreshing or connecting another repository.';
    for (const button of viewSwitch.querySelectorAll('[data-view]')) { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-pressed', String(button.dataset.view === view)); }
    for (const button of guide.querySelectorAll('[data-kind]')) button.setAttribute('aria-pressed', String(filters.kinds.includes(button.dataset.kind)));
    $('#activity-view-description').textContent = { constellation: 'A warm core is the repository. Colored bodies form neighborhoods of pull requests, issues, conversations, forks and contributors.', orbits: 'The repository sits at the center. Its activity occupies colored orbits, with smaller conversations connected to their threads.', contributors: 'People anchor the scene. Activity gathers around its author, with connections back to related conversations.' }[view];
    renderPlayback(); renderInspector(); renderIndex();
  }
  function useDataset(dataset, publishConnection = true) {
    const next = buildCommunityModel(dataset);
    setPlaying(false); model = next; selectedId = null; index = model.events.length - 1; filters = freshFilters(); visibleLimit = 40;
    $('#activity-search').value = ''; $('#activity-state').value = '';
    if (publishConnection) connectRepository(dataset.repository.url);
    $('#activity-repository-url').value = dataset.repository.url;
    $('#activity-repository-meta').innerHTML = `<a href="${esc(safeUrl(dataset.repository.url) || '#')}" target="_blank" rel="noopener noreferrer">${esc(dataset.repository.fullName)}</a><span>${Number(dataset.repository.stars || 0).toLocaleString()} stars · ${Number(dataset.repository.forks || 0).toLocaleString()} forks</span>`;
    $('#activity-source-kind').textContent = dataset.source === 'snapshot' ? 'Preloaded' : 'GitHub';
    const actorNames = model.actors.map(actor => actor.login).sort();
    $('#activity-author').innerHTML = '<option value="">Everyone</option>' + actorNames.map(login => `<option value="${esc(login)}">${esc(login)}</option>`).join('');
    for (const [kind] of KINDS) $(`[data-count="${kind}"]`).textContent = model.items.filter(item => item.kind === kind).length;
    for (const button of panel.querySelectorAll('[data-example-url]')) button.setAttribute('aria-pressed', String(button.dataset.exampleUrl === dataset.repository.url));
    $('#date-text').textContent = dateText(dataset.fetchedAt).slice(0, 10);
    $('#live-badge').textContent = '● SNAPSHOT'; $('#live-badge').style.display = 'inline';
    $('#activity-coverage').innerHTML = `<p class="lab-note">Captured ${esc(dateText(dataset.fetchedAt))}. ${model.items.length} records and ${model.events.length} dated events loaded.</p><ul>${(dataset.limitations || []).map(text => `<li>${esc(text)}</li>`).join('')}</ul><p class="lab-note">Current statuses and contributor totals are snapshot values. This bounded sample is not the repository’s complete history.</p>`;
    scene.setData(model.items, dataset.repository); scene.setView(view); render(); scene.frame();
    const failedSources = (dataset.provenance?.endpoints || []).filter(endpoint => endpoint.error);
    status(failedSources.length ? `Partial data · ${failedSources.length} GitHub sources unavailable. ${model.items.length} records loaded; see Data coverage.` : `${dataset.source === 'snapshot' ? 'Preloaded' : 'Loaded'} ${dataset.repository.fullName} · ${model.items.length} collaboration records.`, failedSources.length ? 'warning' : 'success');
    loading(false);
    try { const serialized = JSON.stringify(dataset); if (!failedSources.length && serialized.length < 2_000_000) localStorage.setItem(CACHE_KEY, serialized); } catch { /* Public data stays usable without storage. */ }
  }
  async function load(url, { refresh = false } = {}) {
    controller?.abort(); const localController = new AbortController(); controller = localController;
    const ticket = ++request;
    $('#activity-repository-url').value = url;
    setPlaying(false); loading(true); status(refresh ? 'Refreshing public collaboration activity…' : 'Loading repository activity…', 'loading');
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; localController.abort(); }, 90000);
    try {
      const example = refresh ? null : await getActivityExample(url);
      const dataset = example || await loadActivityRepository(url, { signal: localController.signal, onProgress: message => { if (ticket === request && !disposed) status(typeof message === 'string' ? message : message.message, 'loading'); } });
      if (ticket === request && !localController.signal.aborted && !disposed) useDataset(dataset);
    } catch (error) {
      if (ticket === request && !disposed) status(timedOut ? 'GitHub took too long to respond. Your current scene is still available.' : error.name === 'AbortError' ? 'Loading cancelled. Your current scene is unchanged.' : error.message, error.name === 'AbortError' && !timedOut ? '' : 'error');
    } finally { clearTimeout(timeout); if (ticket === request && !disposed) { controller = null; loading(false); } }
  }
  function resetFilters() {
    filters = freshFilters();
    for (const id of ['activity-search', 'activity-author', 'activity-state']) $(`#${id}`).value = '';
    visibleLimit = 40; render();
  }
  function switchView(next) {
    if (!VIEW_LABELS[next] || view === next) return;
    view = next; scene.setView(view); scene.frame(); render();
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ view })); } catch { /* Optional preference. */ }
  }
  function setHelp(open) {
    if (open) previousFocus = document.activeElement;
    help.classList.toggle('hidden', !open);
    if (open) help.querySelector('.panel-close').focus(); else previousFocus?.focus?.({ preventScroll: true });
  }
  on($('#activity-source-form'), 'submit', event => { event.preventDefault(); load($('#activity-repository-url').value.trim()); });
  on($('#activity-refresh'), 'click', () => { if (model) load(model.dataset.repository.url, { refresh: true }); });
  on($('#activity-cancel'), 'click', () => { request++; controller?.abort(); controller = null; loading(false); status('Loading cancelled. Your current scene is unchanged.'); });
  for (const button of panel.querySelectorAll('[data-example-url]')) on(button, 'click', () => load(button.dataset.exampleUrl));
  on(viewSwitch, 'click', event => { const button = event.target.closest('[data-view]'); if (button) switchView(button.dataset.view); });
  on(guide, 'click', event => { const button = event.target.closest('[data-kind]'); if (!button) return; const kind = button.dataset.kind; filters.kinds = filters.kinds.includes(kind) ? filters.kinds.filter(value => value !== kind) : [...filters.kinds, kind]; visibleLimit = 40; render(); });
  on($('#activity-search'), 'input', event => { filters.query = event.target.value; visibleLimit = 40; render(); });
  on($('#activity-author'), 'change', event => { filters.actor = event.target.value; visibleLimit = 40; render(); });
  on($('#activity-state'), 'change', event => { filters.state = event.target.value; visibleLimit = 40; render(); });
  on($('#activity-clear-filters'), 'click', resetFilters);
  on($('#activity-index'), 'click', event => { const button = event.target.closest('[data-item]'); if (button) { selectItem(button.dataset.item); scene.focus(button.dataset.item); } });
  on($('#activity-inspector'), 'click', event => { if (event.target.closest('#activity-focus') && selectedId) scene.focus(selectedId); const parent = event.target.closest('[data-parent]'); if (parent) { if (!items.some(item => item.id === parent.dataset.parent)) resetFilters(); selectItem(parent.dataset.parent); scene.focus(parent.dataset.parent); } });
  on($('#activity-clear-selection'), 'click', () => selectItem(null));
  on($('#activity-more'), 'click', () => { visibleLimit += 40; renderIndex(); });
  on($('#activity-frame'), 'click', () => scene.frame());
  on($('#activity-play'), 'click', togglePlayback);
  on($('#activity-prev'), 'click', () => seek(index - 1)); on($('#activity-next'), 'click', () => seek(index + 1));
  on($('#activity-scrub'), 'input', event => seek(Number(event.target.value)));
  on($('#activity-speed'), 'change', event => { speed = Number(event.target.value); elapsed = 0; });
  for (const name of ['guide', 'panel']) { on($(`#activity-${name}-collapse`), 'click', () => collapse(name)); on($(`#activity-${name}-toggle`), 'click', () => { sheet = sheet === name ? null : name; updatePanels(); }); }
  on(window, 'resize', updatePanels);
  on($('#btn-help'), 'click', () => setHelp(help.classList.contains('hidden')));
  on($('#activity-help-close'), 'click', () => setHelp(false)); on(help, 'click', event => { if (event.target === help) setHelp(false); });
  on(help, 'keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); setHelp(false); }
    if (event.key === 'Tab') { const controls = [...help.querySelectorAll('button,a[href],[tabindex="0"]')]; const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
  });
  on(document, 'keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !help.classList.contains('hidden')) return;
    if (event.key === 'Escape') { if (sheet) { sheet = null; updatePanels(); } return; }
    if (event.target.closest('input,select,textarea,button,a,summary,[contenteditable="true"], [role="dialog"]')) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); seek(index - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); seek(index + 1); }
    if (event.key.toLowerCase() === 'f') scene.frame();
    if (event.key.toLowerCase() === 'h') setHelp(true);
  });
  on($('#activity-export'), 'click', () => {
    if (!model) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(model.dataset, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `activity-${model.dataset.repository.fullName.replaceAll('/', '-')}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  on($('#activity-open-data'), 'click', () => { if (model) connectRepository(model.dataset.repository.url); });
  on(document, 'visibilitychange', () => { previousTime = 0; if (document.hidden) setPlaying(false); });
  function tick(now) {
    if (disposed) return;
    const dt = previousTime ? Math.min((now - previousTime) / 1000, .1) : 0; previousTime = now;
    if (!document.hidden) {
      if (playing && model) { elapsed += dt; if (elapsed >= 1.5 / speed) { elapsed = 0; if (index >= model.events.length - 1) setPlaying(false); else seek(index + 1, false); } }
      scene.tick(dt); stage.controls.update(); stage.composer.render(); stage.labelRenderer.render(stage.scene, stage.camera);
    }
    raf = requestAnimationFrame(tick);
  }
  function dispose() {
    if (disposed) return; disposed = true; cancelAnimationFrame(raf); request++; controller?.abort(); lifetime.abort(); removeDrag(); scene.dispose(); stage.controls.dispose();
    for (const pass of stage.composer.passes) pass.dispose?.(); stage.composer.dispose(); stage.renderer.dispose();
    canvas.remove(); stage.labelRenderer.domElement.remove(); for (const el of [guide, panel, dock, ...toggles, tooltip, empty]) el.remove(); help.innerHTML = oldHelp; $('#attribution').textContent = previousAttribution;
    delete window.__activityLab;
  }
  on(window, 'pagehide', event => { if (event.persisted) setPlaying(false); else { void flushRepositorySession(); dispose(); } });
  on(window, 'pageshow', event => { if (event.persisted && !disposed) { const url = connectedRepository(); if (url && url !== model?.dataset.repository.url) load(url); } });
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  window.__activityLab = { stage, scene, get model() { return model; }, get items() { return items; }, get view() { return view; }, get index() { return index; }, get playing() { return playing; }, get selectedId() { return selectedId; }, get filters() { return structuredClone(filters); } };
  updatePanels();
  raf = requestAnimationFrame(tick);
  const startupRequest = request;
  const shared = await restoreRepositorySession();
  if (disposed) return;
  if (request !== startupRequest) { $('#loading')?.remove(); return; }
  const url = connectedRepository() || shared?.dataset?.repository?.url || DEFAULT_ACTIVITY_EXAMPLE_URL;
  let restored = false;
  try { const cached = JSON.parse(localStorage.getItem(CACHE_KEY)); if (cached?.repository?.url) { useDataset(cached, false); restored = true; } } catch { /* Invalid or unavailable cache is ignored. */ }
  if (!restored) {
    const fallback = await getActivityExample(DEFAULT_ACTIVITY_EXAMPLE_URL);
    if (disposed) return;
    if (request !== startupRequest) { $('#loading')?.remove(); return; }
    if (fallback) useDataset(fallback, false);
  }
  $('#loading')?.remove();
  if (url !== model?.dataset.repository.url) await load(url);
  else if (model) connectRepository(model.dataset.repository.url);
  if (disposed) return;
  requestAnimationFrame(() => $('#tab-activity')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}
