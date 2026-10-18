import { makePanelDraggable } from '../ui/dragPanel.js';
import { activityInsights } from './model.js';
import { FILE_ATOM_KINDS, fileAtomKind } from './molecule-layout.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fmt = value => Number(value || 0).toLocaleString();
const formatDate = value => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
};
const githubUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : null; } catch { return null; }
};
const PAGE_SIZE = 30;

/** Controls and readouts follow the same floating-panel contract as the other labs. */
export class DataPanel {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.state = null;
    this.filePage = 0;
    this.folder = '';
    this.search = '';
    this.listeners = new AbortController();
    this.el = document.createElement('aside');
    this.el.id = 'data-panel';
    this.el.className = 'panel';
    this.el.setAttribute('aria-label', 'Data Lab controls');
    this.el.innerHTML = `
      <div class="list-title">Data Lab <button class="data-sheet-close" type="button" aria-label="Close Data Lab controls">×</button></div>
      <p class="lab-note" id="data-view-intro">One folder, one carbon atom. Each file is one element atom bonded directly to its folder.</p>
      <div class="section-title">Repository <span class="lab-hint" id="data-source-kind"></span></div>
      <form id="data-source-form" aria-label="Load a public GitHub repository">
        <div class="data-source-row"><label class="data-sr-only" for="data-repository-url">Public GitHub repository URL</label><input id="data-repository-url" type="url" placeholder="https://github.com/owner/repo" autocomplete="off" spellcheck="false" required><button class="btn tiny primary" id="data-load" type="submit">Load</button></div>
        <div class="data-source-tools"><label for="data-history-limit">History</label><select id="data-history-limit"><option value="8">8 commits</option><option value="12" selected>12 commits</option><option value="20">20 commits</option></select><button class="btn tiny" id="data-demo" type="button">Sample</button></div>
      </form>
      <div class="data-repo-meta"><a id="data-repo-link" target="_blank" rel="noopener noreferrer"></a><span id="data-repo-name"></span><span id="data-branch"></span></div>
      <p class="lab-note" id="data-status" role="status" aria-live="polite"></p>
      <div class="section-title">View</div>
      <div class="seg data-view-switch" role="group" aria-label="Repository visualization"><button type="button" data-view="structure" class="active" aria-pressed="true">Structure</button><button type="button" data-view="tree" aria-pressed="false">Growth tree</button></div>
      <div class="kick-row eq-actions data-view-actions"><button class="btn tiny" id="data-frame" type="button">Frame view</button><button class="btn tiny" id="data-frame-roots" type="button" title="Frame the 3D directory outline beneath the tree" hidden>Frame roots</button><button class="btn tiny" id="data-focus" type="button" disabled>Focus file</button></div>
      <div class="data-view-toggles"><label class="setting"><input type="checkbox" data-option="links" checked> <span id="data-links-label">Bonds</span></label><label class="setting"><input type="checkbox" data-option="labels" checked> Folder labels</label><label class="setting"><input type="checkbox" data-option="ghosts" checked> Historical files</label><label class="setting"><input type="checkbox" data-option="activity" checked> <span id="data-activity-label">Commit effects</span></label><label class="setting" id="data-roots-option" hidden><input type="checkbox" data-option="roots" checked> Show roots</label></div>
      <section id="data-structure" class="data-structure" aria-label="Current repository structure">
        <div class="data-structure-summary"><span><b id="data-structure-folders"></b> folder carbons</span><span><b id="data-structure-atoms"></b> file atoms</span></div>
        <p class="lab-note" id="data-structure-scope"><span id="data-structure-connections"></span></p>
        <details class="data-structure-details"><summary>File elements in the repository</summary><div id="data-structure-composition"></div><p class="lab-note">Counts cover present mapped files and their folder carbons, including the repository root. Historical wireframes are excluded.</p></details>
      </section>
      <div class="section-title">Current commit</div>
      <div class="data-commit">
        <div id="data-commit-message"></div>
        <div class="data-commit-meta"><a id="data-commit-link" target="_blank" rel="noopener noreferrer"></a><span id="data-commit-sha"></span><span id="data-commit-author"></span></div>
        <div class="data-commit-date" id="data-commit-date"></div>
        <p class="data-commit-notice" id="data-commit-notice" hidden></p>
      </div>
      <div class="state-block" id="data-summary"></div>
      <div class="data-changes" id="data-changes" aria-label="Files changed by this commit"></div>
      <section id="data-selected-section" hidden>
        <div class="section-title">Selected file <button class="data-clear" type="button" id="data-clear-selection">Clear</button></div>
        <div class="light-detail" id="data-selected"></div>
      </section>
      <details class="eq-history data-secondary" id="data-files-section">
        <summary class="section-title">Repository files <span class="lab-hint" id="data-file-count"></span></summary>
        <div class="data-files-tools"><label class="data-sr-only" for="data-file-search">Search files</label><input id="data-file-search" type="search" placeholder="Find a file…" autocomplete="off"><div class="data-folder-filter" id="data-folder-filter" hidden><span></span><button type="button" class="data-clear">Show all</button></div></div>
        <div id="data-file-list" class="data-file-list" aria-label="Repository files"></div>
        <div class="data-pagination"><button class="btn tiny" id="data-files-prev" type="button" aria-label="Previous files">Previous</button><span id="data-file-page"></span><button class="btn tiny" id="data-files-next" type="button" aria-label="Next files">Next</button></div>
        <p class="lab-note" id="data-rendered-count"></p>
      </details>
      <details class="eq-history data-secondary">
        <summary class="section-title">Directories</summary>
        <div id="data-directories" class="data-directory-list"></div>
      </details>
      <details class="eq-history data-secondary">
        <summary class="section-title">Observed patterns</summary>
        <div id="data-patterns"></div>
        <p class="lab-note">Calculated from this commit and the loaded history.</p>
      </details>
      <details class="eq-history data-secondary">
        <summary class="section-title">Data coverage</summary>
        <div id="data-coverage"></div>
        <div class="kick-row eq-actions"><button class="btn tiny" type="button" id="data-export">Export loaded data</button></div>
      </details>`;
    this.timebar = document.createElement('footer');
    this.timebar.id = 'data-timebar';
    this.timebar.className = 'panel';
    this.timebar.setAttribute('aria-label', 'Commit history playback');
    this.timebar.innerHTML = `
      <button class="tbtn data-step" type="button" id="data-prev" title="Previous commit" aria-label="Previous commit">‹</button>
      <button class="tbtn big" type="button" id="data-play" title="Play / pause (Space)" aria-label="Play commit history" aria-pressed="false">▶</button>
      <div class="t-mid"><div id="data-time-label"></div><label class="data-sr-only" for="data-scrub">Commit history position</label><input id="data-scrub" type="range" min="-1" max="0" value="-1" step="1"><div class="mt-hint" id="data-time-date"></div></div>
      <button class="tbtn data-step" type="button" id="data-next" title="Next commit" aria-label="Next commit">›</button>
      <label class="data-speed"><span class="data-sr-only">Playback speed</span><select id="data-speed" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>`;
    this.toggle = document.createElement('button');
    this.toggle.id = 'data-panel-toggle';
    this.toggle.className = 'tbtn';
    this.toggle.type = 'button';
    this.toggle.textContent = 'Data Lab';
    this.toggle.setAttribute('aria-controls', 'data-panel');
    this.toggle.setAttribute('aria-expanded', 'false');
    document.body.append(this.el, this.timebar, this.toggle);
    this.$ = selector => this.el.querySelector(selector) || this.timebar.querySelector(selector);
    this.removeDrag = makePanelDraggable(this.el, { handleSelector: '.list-title', storageKey: 'observatory-data-panel-pos' });
    this.bind();
    this.clampFrame = requestAnimationFrame(() => this.clampPosition());
    this.setStatus('Choose a public GitHub repository or explore the synthetic sample.');
  }

  bind() {
    const on = (node, type, callback) => node.addEventListener(type, callback, { signal: this.listeners.signal });
    const invoke = (name, ...args) => this.hooks[name]?.(...args);
    on(this.$('#data-source-form'), 'submit', event => { event.preventDefault(); invoke('onLoad', this.$('#data-repository-url').value.trim(), Number(this.$('#data-history-limit').value)); });
    on(this.$('#data-demo'), 'click', () => invoke('onDemo'));
    on(this.$('#data-frame'), 'click', () => invoke('onFrame'));
    on(this.$('#data-frame-roots'), 'click', () => invoke('onFrameRoots'));
    on(this.$('#data-focus'), 'click', () => { if (this.isRendered(this.state?.selectedId)) invoke('onFocusFile', this.state.selectedId); });
    on(this.$('#data-clear-selection'), 'click', () => invoke('onSelectFile', null));
    on(this.$('#data-export'), 'click', () => invoke('onExport'));
    on(this.$('#data-prev'), 'click', () => invoke('onPrev'));
    on(this.$('#data-next'), 'click', () => invoke('onNext'));
    on(this.$('#data-play'), 'click', () => invoke('onPlay'));
    on(this.$('#data-speed'), 'change', event => invoke('onSpeed', Number(event.target.value)));
    on(this.$('#data-scrub'), 'input', event => invoke('onCommit', Number(event.target.value)));
    on(this.el, 'change', event => { if (event.target.dataset.option) invoke('onOptions', { [event.target.dataset.option]: event.target.checked }); });
    on(this.el, 'click', event => {
      const view = event.target.closest('[data-view]');
      if (view) invoke('onView', view.dataset.view);
      const commit = event.target.closest('[data-commit-index]');
      if (commit) invoke('onCommit', Number(commit.dataset.commitIndex));
      const file = event.target.closest('[data-file-id]');
      if (file) { this.pendingSelectionScroll = true; invoke('onSelectFile', file.dataset.fileId); }
      const focus = event.target.closest('[data-focus-id]');
      if (focus && this.isRendered(focus.dataset.focusId)) invoke('onFocusFile', focus.dataset.focusId);
      const directory = event.target.closest('[data-directory]');
      if (directory) invoke('onFocusFolder', directory.dataset.directory);
      const filter = event.target.closest('[data-directory-filter]');
      if (filter) {
        this.folder = filter.dataset.directoryFilter;
        this.filePage = 0;
        this.$('#data-files-section').open = true;
        this.renderFiles();
      }
    });
    on(this.$('#data-file-search'), 'input', event => { this.search = event.target.value; this.filePage = 0; this.renderFiles(); });
    on(this.$('#data-folder-filter button'), 'click', () => { this.folder = ''; this.filePage = 0; this.renderFiles(); });
    on(this.$('#data-files-prev'), 'click', () => { this.filePage = Math.max(0, this.filePage - 1); this.renderFiles(); });
    on(this.$('#data-files-next'), 'click', () => { this.filePage++; this.renderFiles(); });
    on(this.toggle, 'click', () => this.setSheetOpen(!this.el.classList.contains('data-sheet-open')));
    on(this.$('.data-sheet-close'), 'click', () => this.setSheetOpen(false));
    on(window, 'resize', () => this.clampPosition());
    on(this.el, 'keydown', event => {
      if (event.key === 'Escape' && this.el.classList.contains('data-sheet-open')) { this.setSheetOpen(false); this.toggle.focus(); }
    });
  }

  clampPosition() {
    // Only constrain a restored/dragged desktop position; keep native anchoring otherwise.
    if (window.innerWidth <= 900 || (!this.el.style.left && !this.el.style.top)) return;
    const rect = this.el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.el.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)))}px`;
    this.el.style.top = `${Math.round(Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8)))}px`;
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';
  }

  isRendered(id) {
    if (!id) return false;
    const mapped = this.state?.mappedIds;
    return mapped?.has ? mapped.has(id) : true;
  }

  showSelectedInPanel() {
    const section = this.$('#data-selected-section');
    if (section.hidden || !this.el.getClientRects().length) return;
    const panel = this.el.getBoundingClientRect();
    const bounds = section.getBoundingClientRect();
    const top = panel.top + 42;
    const bottom = panel.bottom - 12;
    if (bounds.bottom > bottom) this.el.scrollTop += Math.max(0, Math.min(bounds.top - top, bounds.bottom - bottom));
    else if (bounds.top < top) this.el.scrollTop += bounds.top - top;
  }

  setSheetOpen(open) {
    this.el.classList.toggle('data-sheet-open', open);
    this.toggle.setAttribute('aria-expanded', String(open));
  }

  setStatus(message, kind = '') {
    const target = this.$('#data-status');
    target.textContent = message || '';
    target.dataset.kind = kind;
    target.hidden = !message;
  }

  setLoading(loading) {
    this.$('#data-source-form').setAttribute('aria-busy', String(loading));
    this.$('#data-load').disabled = loading;
    // Sample stays available so the app can abort an in-flight import.
    this.$('#data-history-limit').disabled = loading;
    this.$('#data-load').textContent = loading ? 'Loading…' : 'Load';
  }

  setState(state) {
    const previous = this.state;
    this.state = state;
    if (!state.model || !state.frame) return;
    const modelChanged = previous?.model !== state.model;
    const viewChanged = previous?.view !== state.view || previous?.mappedIds !== state.mappedIds;
    const frameChanged = modelChanged || previous?.index !== state.index;
    const selectionChanged = modelChanged || previous?.selectedId !== state.selectedId;
    if (modelChanged) { this.filePage = 0; this.folder = ''; this.renderRepository(); this.renderCoverage(); }
    if (frameChanged) { this.renderCommit(); this.renderPatterns(); }
    if (viewChanged || !previous) this.renderView();
    if (frameChanged || viewChanged || previous?.structure !== state.structure) this.renderStructure();
    if (modelChanged || viewChanged || (frameChanged && state.view !== 'tree')) this.renderDirectories();
    if (frameChanged || selectionChanged || viewChanged) { this.renderChanges(); this.renderSelected(); this.renderFiles(); }
    this.$('#data-focus').disabled = !this.isRendered(state.selectedId);
    this.$('[data-option="roots"]').checked = state.rootsVisible !== false;
    if (selectionChanged && this.pendingSelectionScroll) this.showSelectedInPanel();
    this.pendingSelectionScroll = false;
    const play = this.$('#data-play');
    play.textContent = state.playing ? '⏸' : '▶';
    play.setAttribute('aria-label', state.playing ? 'Pause commit history' : 'Play commit history');
    play.setAttribute('aria-pressed', String(state.playing));
    play.disabled = !state.model.commits.length;
    this.$('#data-prev').disabled = state.index < 0;
    this.$('#data-next').disabled = state.index >= state.model.commits.length - 1;
    const scrub = this.$('#data-scrub');
    scrub.max = String(Math.max(-1, state.model.commits.length - 1));
    scrub.value = String(state.index);
    scrub.disabled = !state.model.commits.length;
    scrub.setAttribute('aria-valuetext', state.index < 0 ? 'Baseline before the loaded history' : `Commit ${state.index + 1} of ${state.model.commits.length}: ${state.frame.commit.message.split('\n')[0]}`);
    this.$('#data-speed').value = String(state.speed ?? 1);
    const shortSha = this.shortSha(state.frame.commit?.sha);
    this.$('#data-time-label').textContent = state.index < 0 ? `Baseline · ${state.model.commits.length} commits loaded` : `${state.index + 1} / ${state.model.commits.length} · ${shortSha}`;
    this.$('#data-time-date').textContent = state.frame.commit ? formatDate(state.frame.commit.date) : 'Before the first loaded commit';
    this.$('#data-rendered-count').textContent = state.view === 'tree' && state.rootLayout
      ? `${fmt(state.renderedCount)} canopy leaves mapped. The directory outline contains all ${fmt(state.rootLayout.nodes.length)} present loaded files; expand folders to browse their paths. All loaded files remain searchable here.`
      : `${fmt(state.renderedCount ?? state.model.nodes.length)} of ${fmt(state.model.nodes.length)} ${state.view === 'tree' ? 'leaves' : 'file atoms'} rendered. All loaded files remain searchable here.`;
  }

  renderView() {
    const tree = this.state.view === 'tree';
    for (const button of this.el.querySelectorAll('[data-view]')) {
      const active = button.dataset.view === (tree ? 'tree' : 'structure');
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    this.$('#data-view-intro').textContent = tree
      ? 'Each loaded commit grows the tree taller and thicker. Below ground, a 3D directory outline shows the exact folders and files at this point in history.'
      : 'One folder, one carbon atom. Each file is one element atom bonded directly to its folder.';
    this.$('#data-links-label').textContent = tree ? 'File stems' : 'Bonds';
    this.$('#data-activity-label').textContent = 'Commit effects';
    this.$('#data-roots-option').hidden = !tree;
    this.$('#data-frame-roots').hidden = !tree;
    this.$('#data-structure').hidden = tree;
  }

  renderStructure() {
    const structure = this.state.structure;
    const section = this.$('#data-structure');
    section.hidden = this.state.view === 'tree' || !structure;
    if (section.hidden) return;
    this.$('#data-structure-atoms').textContent = fmt(structure.atomCount);
    this.$('#data-structure-folders').textContent = fmt(structure.moleculeCount);
    this.$('#data-structure-connections').textContent = `${fmt(structure.folderBondCount)} parent–child folder bonds`;
    this.$('#data-structure-composition').innerHTML = FILE_ATOM_KINDS.map(kind => `<div class="data-structure-kind"><span class="data-element-symbol" style="--atom-color:#${kind.color.toString(16).padStart(6, '0')}" title="${esc(kind.elementName)}">${esc(kind.element)}</span><span>${esc(kind.label)}</span><b>${fmt(structure.typeCounts[kind.id])}</b></div>`).join('');
  }

  shortSha(sha) {
    if (!sha) return '';
    return this.state?.model.repository.source === 'demo' ? `${sha.slice(0, 7)}…${sha.slice(-4)}` : sha.slice(0, 7);
  }

  renderRepository() {
    const { repository } = this.state.model;
    const demo = repository.source === 'demo';
    this.$('#data-source-kind').textContent = demo ? 'Synthetic sample' : 'GitHub';
    const link = this.$('#data-repo-link');
    const url = githubUrl(repository.url);
    link.hidden = !url;
    link.removeAttribute('href');
    if (url) { link.href = url; link.textContent = repository.fullName || repository.name; }
    const name = this.$('#data-repo-name');
    name.hidden = !!url;
    name.textContent = repository.fullName || repository.name || 'Repository';
    this.$('#data-branch').textContent = `${repository.branch || 'default branch'} · ${this.shortSha(repository.headSha)}`;
    this.$('#data-file-count').textContent = fmt(this.state.model.nodes.length);
    if (!demo && url) this.$('#data-repository-url').value = url;
  }

  renderCommit() {
    const { frame, model } = this.state;
    const commit = frame.commit;
    this.$('#data-commit-message').textContent = commit?.message?.split('\n')[0] || 'Baseline before the loaded history';
    this.$('#data-commit-message').title = commit?.message || '';
    const link = this.$('#data-commit-link');
    const url = githubUrl(commit?.url);
    link.hidden = !url;
    link.removeAttribute('href');
    if (url) { link.href = url; link.textContent = this.shortSha(commit.sha); }
    const sha = this.$('#data-commit-sha');
    sha.hidden = !!url;
    sha.textContent = this.shortSha(commit?.sha);
    sha.title = commit?.sha || '';
    this.$('#data-commit-author').textContent = commit?.author || '';
    this.$('#data-commit-date').textContent = commit ? formatDate(commit.date) : `${fmt(frame.summary.activeFiles)} sampled files exist at this point.`;
    const notices = [];
    if (commit?.isMerge) notices.push('Merge: changes are relative to its first parent.');
    if (commit?.partial) notices.push('Partial diff: counts cover returned files only.');
    const notice = this.$('#data-commit-notice');
    notice.textContent = notices.join(' ');
    notice.hidden = !notices.length;
    const summary = frame.summary;
    this.$('#data-summary').innerHTML = `<div>Files present <b>${fmt(summary.activeFiles)}</b> · changed <b>${fmt(summary.changedFiles)}</b></div><div>Added <b>${fmt(summary.addedFiles)}</b> · removed <b>${fmt(summary.removedFiles)}</b> · renamed <b>${fmt(summary.renamedFiles)}</b></div><div>Lines <b>+${fmt(summary.additions)}</b> / <b>−${fmt(summary.deletions)}</b></div>`;
    if (!model.commits.length) this.$('#data-commit-date').textContent = 'No commits are available in this dataset.';
  }

  replaceContent(node, markup) {
    const active = document.activeElement;
    const focusKey = node.contains(active) ? ['fileId', 'focusId', 'commitIndex', 'directory', 'directoryFilter'].find(key => active?.dataset[key] !== undefined) : null;
    const focusValue = focusKey ? active.dataset[focusKey] : null;
    const scroll = node.scrollTop;
    node.innerHTML = markup;
    node.scrollTop = scroll;
    if (focusKey) [...node.querySelectorAll('button')].find(button => button.dataset[focusKey] === focusValue)?.focus({ preventScroll: true });
  }

  fileButton(file, compact = false) {
    const selected = file.id === this.state.selectedId;
    const status = file.status || 'unchanged';
    const label = status === 'unchanged' ? (file.exists ? '' : 'historical') : status;
    return `<button class="data-file-row${selected ? ' selected' : ''}${file.exists === false ? ' historical' : ''}" type="button" data-file-id="${esc(file.id)}" aria-pressed="${selected}" title="${esc(file.path)}"><span class="data-file-path">${esc(file.path)}</span>${label ? `<span class="data-file-status" data-status="${esc(status)}">${esc(label)}</span>` : ''}${compact ? '' : `<span class="data-file-diff">+${fmt(file.additions)} −${fmt(file.deletions)}</span>`}</button>`;
  }

  renderChanges() {
    const { frame } = this.state;
    const changed = new Set(frame.changedIds);
    const files = frame.files.filter(file => changed.has(file.id));
    const box = this.$('#data-changes');
    box.hidden = !files.length;
    this.replaceContent(box, files.map(file => this.fileButton(file)).join(''));
  }

  renderSelected() {
    const { frame, model, selectedId } = this.state;
    const file = frame.files.find(item => item.id === selectedId);
    this.$('#data-selected-section').hidden = !file;
    if (!file) return;
    const node = model.nodes.find(item => item.id === file.id);
    const historical = [...new Set(node?.aliases || [])].filter(path => path !== file.path);
    const rendered = this.isRendered(file.id);
    const changes = model.commits.map((commit, index) => ({ ...commit, index })).filter(commit => commit.changes.some(change => change.id === file.id));
    const historyWasOpen = this.$('#data-selected .data-file-history')?.open;
    const kind = this.state.view !== 'tree' ? fileAtomKind(file.path) : null;
    const currentFolder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '(root)';
    const atomRows = kind ? `<div class="stat-k">File category</div><div class="stat-v">${esc(kind.label)}</div><div class="stat-k">File element</div><div class="stat-v data-file-element">${esc(kind.element)} · ${esc(kind.elementName)}</div><div class="stat-k">Current folder</div><div class="stat-v data-folder-path">${esc(currentFolder)}</div>` : '';
    const history = changes.length ? `<details class="data-file-history" ${historyWasOpen ? 'open' : ''}><summary>File activity · ${changes.length} commits</summary>${changes.map(commit => `<button type="button" data-commit-index="${commit.index}" aria-current="${commit.index === this.state.index}" title="${esc(commit.message)}"><code>${esc(this.shortSha(commit.sha))}</code><span>${esc(commit.message.split('\n')[0])}</span></button>`).join('')}</details>` : '';
    this.replaceContent(this.$('#data-selected'), `<div class="data-selected-path">${esc(file.path)}</div><div class="stat-grid"><div class="stat-k">At this point</div><div class="stat-v">${file.exists ? 'Present' : 'Not present'}</div><div class="stat-k">Current change</div><div class="stat-v">${esc(file.status)}</div><div class="stat-k">Commits touching file</div><div class="stat-v">${fmt(changes.length)}</div>${atomRows}<div class="stat-k">Snapshot size</div><div class="stat-v">${file.size != null ? `${fmt(file.size)} bytes` : 'Unknown'}</div></div>${historical.length ? `<div class="data-history-paths"><span>Other paths for this file</span>${historical.map(path => `<code>${esc(path)}</code>`).join('')}</div>` : ''}${rendered ? '' : '<p class="lab-note" style="padding:0 0 8px">Outside the displayed subset; data remains available here.</p>'}<button class="btn tiny" type="button" data-focus-id="${esc(file.id)}" ${rendered ? '' : 'disabled'}>Focus in scene</button>${history}`);
  }

  renderFiles() {
    if (!this.state?.frame) return;
    const query = this.search.trim().toLowerCase();
    const inFolder = file => {
      if (!this.folder) return true;
      if (this.state.view === 'tree') return file.directory === this.folder;
      return this.folder === '(root)' ? !file.path.includes('/') : file.path.startsWith(`${this.folder}/`);
    };
    const files = this.state.frame.files.filter(file => inFolder(file) && (!query || file.path.toLowerCase().includes(query) || file.aliases.some(path => path.toLowerCase().includes(query))));
    const pages = Math.max(1, Math.ceil(files.length / PAGE_SIZE));
    this.filePage = Math.max(0, Math.min(this.filePage, pages - 1));
    const shown = files.slice(this.filePage * PAGE_SIZE, (this.filePage + 1) * PAGE_SIZE);
    this.replaceContent(this.$('#data-file-list'), shown.length ? shown.map(file => this.fileButton(file, true)).join('') : '<p class="lab-note">No files match this search.</p>');
    this.$('#data-files-prev').disabled = this.filePage === 0;
    this.$('#data-files-next').disabled = this.filePage >= pages - 1;
    this.$('#data-file-page').textContent = files.length ? `${this.filePage * PAGE_SIZE + 1}–${Math.min(files.length, (this.filePage + 1) * PAGE_SIZE)} of ${fmt(files.length)}` : '0 files';
    this.$('#data-folder-filter').hidden = !this.folder;
    this.$('#data-folder-filter span').textContent = this.folder;
  }

  renderDirectories() {
    const directories = this.state.view !== 'tree' && this.state.structure
      ? this.state.structure.folders.map(folder => ({ path: folder.path || '(root)', count: folder.path ? folder.totalCount : folder.directCount }))
      : this.state.model.directories;
    this.replaceContent(this.$('#data-directories'), directories.map(directory => `<div class="data-directory-row"><button class="data-directory-name" type="button" data-directory="${esc(directory.path)}" title="Focus ${esc(directory.path)} in the scene">${esc(directory.path)}<span>${fmt(directory.count)}</span></button><button class="data-clear" type="button" data-directory-filter="${esc(directory.path)}" aria-label="Show files in ${esc(directory.path)}">Files</button></div>`).join('') || '<p class="lab-note">No directories loaded.</p>');
  }

  renderPatterns() {
    this.$('#data-patterns').innerHTML = activityInsights(this.state.model, this.state.index).map(text => `<p class="lab-note">${esc(text)}</p>`).join('');
  }

  renderCoverage() {
    const coverage = this.state.model.coverage;
    this.$('#data-coverage').innerHTML = `<p class="lab-note">${esc(coverage.label)}</p>${coverage.limitations.map(text => `<p class="lab-note">${esc(text)}</p>`).join('')}`;
  }

  dispose() {
    this.listeners.abort();
    cancelAnimationFrame(this.clampFrame);
    this.removeDrag?.();
    this.el.remove();
    this.timebar.remove();
    this.toggle.remove();
  }
}
