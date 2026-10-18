import { CHANGE_COLORS, FILE_KINDS } from './encoding.js';

const hex = value => `#${value.toString(16).padStart(6, '0')}`;
const icons = {
  trunk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 22 3-7V3h4v12l3 7ZM11 11 5 5l-1 2 7 8m2-7 6-5 1 2-7 7" fill="#ad8a61"/><path d="M12 5v16" stroke="#e2c39a" stroke-width=".7"/></svg>',
  branch: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21 13 10l8-7M8 15 5 8m8 2-1-8M9 14l12-3" fill="none" stroke="#ad8a61" stroke-width="2" stroke-linecap="round"/><path d="m5 8-3-2m10-2 2-2m6 10 3 2" fill="none" stroke="#c5ad82" stroke-width="1"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21C2 10 8 3 21 3 21 15 14 22 4 21Z" fill="#7ea27a"/><path d="M4 21 19 5M9 16l-1-6m5 2 6 1" fill="none" stroke="#c9ddab" stroke-width=".8"/></svg>',
  core: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 22 9 18 21 6 21 2 9Z" fill="#b5a482"/><path d="m12 2-6 19L22 9H2l16 12Z" fill="none" stroke="#f1ddac" stroke-width=".7"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 5 2 8-7 6-9-3-4-9Z" fill="#85b8dd"/><path d="m12 3 3 19M2 10l18-2-14 11Z" fill="none" stroke="#cbdff3" stroke-width=".7"/></svg>',
  code: '<span class="guide-sphere" aria-hidden="true"></span>',
  data: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 1 10 11-10 11L2 12Z" fill="#85b8dd"/><path d="m12 1 1 11-1 11L2 12Z" fill="#c2d9e9"/><path d="m2 12 11 0 9 0M12 1l1 11-1 11" fill="none" stroke="#5a819e" stroke-width=".7"/></svg>',
  document: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 10 5v11l-10 5-10-5V7Z" fill="#85b8dd"/><path d="M2 7 12 2 22 7 12 12Z" fill="#c2d9e9"/><path d="M12 12v11l10-5V7Z" fill="#587e9b"/></svg>',
};

/** Native left-side reading guide and navigation for the actual mapped hierarchy. */
export class DataGuide {
  constructor({ onOverview, onFocusFolder } = {}) {
    this.onOverview = onOverview;
    this.onFocusFolder = onFocusFolder;
    this.listeners = new AbortController();
    this.rows = new Map();
    this.focusedPath = null;
    this.el = document.createElement('aside');
    this.el.id = 'data-guide';
    this.el.className = 'panel';
    this.el.setAttribute('aria-label', 'Scene guide and repository index');
    this.el.innerHTML = `
      <div class="list-title"><span>Scene guide</span><button type="button" id="data-guide-collapse" aria-label="Collapse scene guide" aria-expanded="true" aria-controls="data-guide-body">−</button></div>
      <div id="data-guide-body">
        <p class="lab-note guide-intro">A fixed map of files and folders.<br>Commit history brings it to life.</p>
        <div class="section-title">Reading the shapes</div>
        <dl class="guide-key" id="guide-shape-key">
          <div><dt><span class="guide-icon">${icons.core}</span>Repository core</dt><dd>The whole project</dd></div>
          <div><dt><span class="guide-icon">${icons.folder}</span>Folder hub</dt><dd>A directory and its children</dd></div>
          ${FILE_KINDS.map(kind => `<div><dt><span class="guide-icon">${icons[kind.id]}</span>${kind.label}</dt><dd>${kind.description}</dd></div>`).join('')}
        </dl>
        <p class="lab-note guide-relations" id="guide-relations"><span class="guide-connection" aria-hidden="true"></span>Lines connect folders to their contents. Colors group top-level folders.</p>
        <p class="lab-note guide-size-note" id="guide-size-note" hidden></p>
        <div class="section-title">Changes in this commit</div>
        <div class="guide-changes">
          ${[['added', 'Added / copied'], ['modified', 'Modified'], ['renamed', 'Renamed'], ['removed', 'Removed']].map(([key, label]) => `<span><i style="--change-color:${hex(CHANGE_COLORS[key])}"></i>${label}</span>`).join('')}
        </div>
        <p class="lab-note guide-motion">A short moving trace reaches each animated file. Faint wireframes are absent at this step; a bright halo marks a hovered or selected file.</p>
        <div class="section-title">Repository index</div>
        <p class="lab-note guide-count-note" id="guide-index-caption"></p>
        <nav id="guide-index" aria-label="Focus a repository folder"></nav>
        <p class="lab-note guide-count-note">Click a name to focus. Counts show present / mapped files; amber dots mark changes.</p>
        <details class="eq-history guide-loading"><summary class="section-title">How data becomes a scene</summary>
          <ol>
            <li><strong>Read GitHub.</strong> Fetch the default branch, pin its latest commit, and read that commit’s file tree.</li>
            <li><strong>Read changes.</strong> Load recent commits and their file changes, following the first parent through merges.</li>
            <li id="guide-map-step"><strong>Build the map.</strong> Give files stable identities and arrange their folders in 3D.</li>
            <li id="guide-replay-step"><strong>Replay.</strong> Move oldest to newest. Presence and names change; positions stay fixed.</li>
          </ol>
          <p class="lab-note" id="guide-encoding-note">Shapes follow file extensions. Size varies gently with known file size at the loaded snapshot; it does not measure importance. Connections describe containment, not code dependencies or execution.</p>
          <p class="lab-note">Deep folders may be grouped under a visible ancestor. Large commits may animate only some changed files; the inspector lists every loaded change.</p>
          <p class="lab-note" id="guide-source-note"></p>
        </details>
      </div>`;
    this.toggle = document.createElement('button');
    this.toggle.id = 'data-guide-toggle';
    this.toggle.className = 'tbtn';
    this.toggle.textContent = 'Guide & index';
    this.toggle.setAttribute('aria-controls', 'data-guide');
    this.toggle.setAttribute('aria-expanded', 'false');
    document.body.append(this.el, this.toggle);
    const on = (el, event, callback) => el.addEventListener(event, callback, { signal: this.listeners.signal });
    on(this.el.querySelector('#data-guide-collapse'), 'click', () => {
      if (window.innerWidth <= 1200) { this.setOpen(false); this.toggle.focus(); return; }
      const collapsed = this.el.classList.toggle('guide-collapsed');
      const button = this.el.querySelector('#data-guide-collapse');
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', collapsed ? 'Expand scene guide' : 'Collapse scene guide');
      button.textContent = collapsed ? '+' : '−';
    });
    on(this.toggle, 'click', () => this.setOpen(!this.el.classList.contains('guide-open')));
    on(this.el, 'keydown', event => { if (event.key === 'Escape' && window.innerWidth <= 1200) { this.setOpen(false); this.toggle.focus(); } });
    on(this.el.querySelector('#guide-index'), 'click', event => {
      const expand = event.target.closest('[data-guide-expand]');
      if (expand) {
        const row = this.rows.get(expand.dataset.guideExpand);
        const open = expand.getAttribute('aria-expanded') !== 'true';
        expand.setAttribute('aria-expanded', String(open));
        expand.textContent = open ? '▾' : '▸';
        row.children.hidden = !open;
        return;
      }
      const target = event.target.closest('[data-guide-folder]');
      if (!target) return;
      this.focusedPath = target.dataset.guideFolder;
      this.markFocus();
      if (this.focusedPath === '') this.onOverview?.();
      else this.onFocusFolder?.(this.focusedPath);
      if (window.innerWidth <= 1200) this.setOpen(false);
    });
    // Mobile sheets share the same screen space, so only one is open at a time.
    on(document.getElementById('data-panel-toggle'), 'click', () => this.setOpen(false));
  }

  setOpen(open) {
    this.el.classList.toggle('guide-open', open);
    this.el.classList.remove('guide-collapsed');
    const collapse = this.el.querySelector('#data-guide-collapse');
    collapse.textContent = '−';
    collapse.setAttribute('aria-expanded', 'true');
    collapse.setAttribute('aria-label', window.innerWidth <= 1200 ? 'Close scene guide' : 'Collapse scene guide');
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open && window.innerWidth <= 900) {
      document.getElementById('data-panel')?.classList.remove('data-sheet-open');
      document.getElementById('data-panel-toggle')?.setAttribute('aria-expanded', 'false');
    }
  }

  setState({ model, frame, scene, selectedId, view = 'structure' }) {
    const changedModel = this.model !== model;
    const changedScene = this.scene !== scene;
    const changedView = this.view !== view;
    if (changedModel || changedScene || changedView) {
      const focusedPath = changedModel ? null : this.focusedPath;
      const expandedPaths = changedModel ? [] : [...this.rows.values()].filter(row => row.expand?.getAttribute('aria-expanded') === 'true').map(row => row.path);
      this.view = view;
      this.model = model;
      this.scene = scene;
      this.focusedPath = focusedPath;
      this.buildIndex();
      for (const path of expandedPaths) {
        const row = this.rows.get(path);
        if (row?.children) { row.children.hidden = false; row.expand.setAttribute('aria-expanded', 'true'); row.expand.textContent = '▾'; }
      }
      this.renderLegend();
      this.el.querySelector('#guide-index-caption').textContent = `${scene.renderedCount.toLocaleString()} of ${model.nodes.length.toLocaleString()} loaded files mapped`;
      this.el.querySelector('#guide-source-note').textContent = model.repository.source === 'demo'
        ? 'This view is a synthetic sample. No GitHub data has been requested for it.'
        : `${model.commits.length} commits loaded. ${model.coverage.label}. Full limits and omissions are listed under Data coverage on the right.`;
    }
    const active = new Set(frame.activeIds), changed = new Set(frame.changedIds);
    for (const row of this.rows.values()) {
      const present = row.ids.filter(id => active.has(id)).length;
      const changes = row.ids.filter(id => changed.has(id)).length;
      row.count.textContent = `${present}/${row.ids.length}`;
      row.marker.hidden = !changes;
      row.marker.title = `${changes} mapped files changed in this commit`;
      row.focus.setAttribute('aria-label', `Focus ${row.path || model.repository.name}: ${present} of ${row.ids.length} mapped files present, ${changes} changed`);
    }
    if (selectedId && (selectedId !== this.selectedId || changedScene || changedView)) {
      this.focusedPath = scene.nodes.get(selectedId)?.node.folder ?? null;
      // Reveal the selected file's mapped folder without replacing any buttons.
      let path = this.focusedPath;
      while (path) {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const row = this.rows.get(parent);
        if (row?.children && row.expand) { row.children.hidden = false; row.expand.setAttribute('aria-expanded', 'true'); row.expand.textContent = '▾'; }
        path = parent;
      }
    }
    this.selectedId = selectedId;
    this.markFocus();
  }

  renderLegend() {
    const tree = this.view === 'tree';
    const $ = selector => this.el.querySelector(selector);
    $('.guide-intro').textContent = tree
      ? 'One repository, growing through the same commit history.'
      : 'A fixed map of files and folders. Commit history brings it to life.';
    $('#guide-shape-key').innerHTML = tree
      ? `<div><dt><span class="guide-icon">${icons.trunk}</span>Repository trunk</dt><dd>Grows taller and thicker with each loaded commit</dd></div>
         <div><dt><span class="guide-icon">${icons.branch}</span>Folder branches</dt><dd>More present leaves lengthen and bend a limb</dd></div>
         <div><dt><span class="guide-icon">${icons.leaf}</span>File leaves</dt><dd>One leaf for each mapped file</dd></div>`
      : `<div><dt><span class="guide-icon">${icons.core}</span>Repository core</dt><dd>The whole project</dd></div>
         <div><dt><span class="guide-icon">${icons.folder}</span>Folder hub</dt><dd>A directory and its children</dd></div>
         ${FILE_KINDS.map(kind => `<div><dt><span class="guide-icon">${icons[kind.id]}</span>${kind.label}</dt><dd>${kind.description}</dd></div>`).join('')}`;
    $('#guide-relations').innerHTML = tree
      ? 'Branches follow the folder hierarchy. Length and droop respond to the number of present mapped leaves; removals lighten the limb.'
      : '<span class="guide-connection" aria-hidden="true"></span>Lines connect folders to their contents. Colors group top-level folders.';
    const sizeNote = $('#guide-size-note');
    sizeNote.hidden = !tree;
    if (tree) {
      const nodes = [...this.scene.nodes.values()].map(record => record.node);
      const known = nodes.filter(node => Number.isFinite(node.size) && node.size >= 0).length;
      sizeNote.textContent = `Leaf area follows snapshot bytes, with limits for readability. Empty files use the minimum size; unknown sizes use a muted fallback. ${known.toLocaleString()} known · ${(nodes.length - known).toLocaleString()} unknown.`;
    }
    $('.guide-motion').textContent = tree
      ? 'Commit effects adds change colors and motion: step forward to grow new leaves and let removed leaves fall. Jumps and backward steps settle immediately. Faint wireframes mark absent files; a bright halo marks hover or selection.'
      : 'A short moving trace reaches each animated file. Faint wireframes are absent at this step; a bright halo marks a hovered or selected file.';
    $('#guide-map-step').innerHTML = tree
      ? '<strong>Grow the hierarchy.</strong> Give files stable identities. Recursively branch their folders; leaves follow the growing limbs.'
      : '<strong>Build the map.</strong> Give files stable identities and arrange their folders in 3D.';
    $('#guide-replay-step').innerHTML = tree
      ? '<strong>Replay growth.</strong> Each loaded commit adds height and thickness. Additions grow, removals fall, and lighter branches lift back up.'
      : '<strong>Replay.</strong> Move oldest to newest. Presence and names change; positions stay fixed.';
    $('#guide-encoding-note').textContent = tree
      ? 'Trunk height and thickness show progress through the loaded history. Branch weight is a visual metaphor for present mapped leaf counts, not bytes or code quality. File identities survive renames; their positions follow the growing limbs. Leaf areas use known file sizes at the loaded snapshot, held constant during replay. Historical byte sizes are not inferred from lines added or deleted. Areas are relative to the median known positive file size, limited to 0.16–6.25 times that area. Empty files use the minimum; unknown sizes use a muted 0.65 fallback.'
      : 'Shapes follow file extensions. Size varies gently with known file size at the loaded snapshot; it does not measure importance. Connections describe containment, not code dependencies or execution.';
  }

  buildIndex() {
    this.rows.clear();
    const container = this.el.querySelector('#guide-index');
    container.replaceChildren();
    const folders = this.scene.layout.folders;
    const append = (folder, parent) => {
      const wrapper = document.createElement('div');
      const line = document.createElement('div');
      line.className = 'guide-index-row';
      const focus = document.createElement('button');
      focus.type = 'button';
      focus.className = 'body-row guide-index-focus';
      focus.dataset.guideFolder = folder.path;
      focus.title = folder.path || this.model.repository.fullName;
      const swatch = document.createElement('span');
      swatch.className = 'dot';
      swatch.style.background = folder.path ? `#${this.scene.folders.get(folder.path).color.getHexString()}` : '#b5a482';
      const name = document.createElement('span'); name.className = 'row-name'; name.textContent = folder.path ? folder.name : this.model.repository.name;
      const marker = document.createElement('i'); marker.className = 'guide-change-dot'; marker.setAttribute('aria-hidden', 'true');
      const count = document.createElement('span'); count.className = 'guide-index-count'; count.setAttribute('aria-hidden', 'true');
      focus.append(swatch, name, marker, count); line.append(focus); wrapper.append(line); parent.append(wrapper);
      const ids = this.scene.layout.nodes.filter(node => !folder.path || node.folder === folder.path || node.folder.startsWith(`${folder.path}/`)).map(node => node.id);
      const row = { path: folder.path, focus, count, marker, ids };
      this.rows.set(folder.path, row);
      const children = folders.filter(child => child.parent === folder.path);
      if (children.length) {
        const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'guide-expand'; expand.dataset.guideExpand = folder.path;
        expand.textContent = folder.path ? '▸' : '▾'; expand.setAttribute('aria-expanded', String(!folder.path)); expand.setAttribute('aria-label', `Expand or collapse ${folder.path || 'repository'} folders`);
        line.prepend(expand);
        const group = document.createElement('div'); group.className = folder.path ? 'guide-index-children' : 'guide-index-root-children'; group.hidden = Boolean(folder.path);
        wrapper.append(group); row.children = group; row.expand = expand;
        children.forEach(child => append(child, group));
      }
    };
    const root = folders.find(folder => folder.path === '');
    if (root) append(root, container);
  }

  markFocus() {
    for (const row of this.rows.values()) {
      row.focus.classList.toggle('selected', this.focusedPath === row.path);
      row.focus.setAttribute('aria-pressed', String(this.focusedPath === row.path));
    }
  }

  dispose() { this.listeners.abort(); this.el.remove(); this.toggle.remove(); }
}
