import { CHANGE_COLORS } from './encoding.js';
import { FILE_ATOM_KINDS } from './molecule-layout.js';
import { ROOT_LENGTH_PER_TOUCH } from './root-length-layout.js';

const hex = value => `#${value.toString(16).padStart(6, '0')}`;
const icons = {
  trunk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 22 3-7V3h4v12l3 7ZM11 11 5 5l-1 2 7 8m2-7 6-5 1 2-7 7" fill="#ad8a61"/><path d="M12 5v16" stroke="#e2c39a" stroke-width=".7"/></svg>',
  branch: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21 13 10l8-7M8 15 5 8m8 2-1-8M9 14l12-3" fill="none" stroke="#ad8a61" stroke-width="2" stroke-linecap="round"/><path d="m5 8-3-2m10-2 2-2m6 10 3 2" fill="none" stroke="#c5ad82" stroke-width="1"/></svg>',
  roots: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 5h20" stroke="#9aab8d" stroke-width=".8"/><path d="M12 2v7m0 0-6 5-3 5m9-10 6 5 3 5M6 14l4 6m8-6-4 6" fill="none" stroke="#b79a77" stroke-width="1.7" stroke-linecap="round"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21C2 10 8 3 21 3 21 15 14 22 4 21Z" fill="#7ea27a"/><path d="M4 21 19 5M9 16l-1-6m5 2 6 1" fill="none" stroke="#c9ddab" stroke-width=".8"/></svg>',
  atom: '<span class="guide-atom" aria-hidden="true"></span>',
  carbon: '<span class="guide-atom guide-carbon" aria-hidden="true">C</span>',
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
        <p class="lab-note guide-intro">One folder, two forms: a small carbon marble when paused, an enclosure while playing. The root keeps the commit author’s portrait. Play adds a sun glow; pause opens the commit message and changes.</p>
        <div class="section-title">Reading the structure</div>
        <dl class="guide-key" id="guide-shape-key"></dl>
        <div id="guide-atom-types"><div class="section-title">File elements</div><div class="guide-atom-key">${FILE_ATOM_KINDS.map(kind => `<div><span class="data-element-symbol" style="--atom-color:${hex(kind.color)}">${kind.element}</span><span>${kind.label}<small>${kind.elementName}</small></span></div>`).join('')}</div></div>
        <p class="lab-note guide-relations" id="guide-relations"></p>
        <p class="lab-note guide-size-note" id="guide-size-note" hidden></p>
        <div class="section-title">Changes in this commit</div>
        <div class="guide-changes">
          ${[['added', 'Added / copied'], ['modified', 'Modified'], ['renamed', 'Renamed'], ['removed', 'Removed']].map(([key, label]) => `<span><i style="--change-color:${hex(CHANGE_COLORS[key])}"></i>${label}</span>`).join('')}
        </div>
        <div id="guide-activity-key" class="guide-activity-key" aria-label="Brightness and pulses in loaded commit history"><span title="Translucent: no commit touches yet"><i class="guide-activity-sample untouched" aria-hidden="true"></i>Untouched</span><span title="Brighter: more commit touches so far"><i class="guide-activity-sample frequent" aria-hidden="true"></i>More touches</span><span class="guide-activity-pulse" title="A brief travelling light marks the current commit"><i class="guide-activity-sample pulse" aria-hidden="true"></i>Pulse · current commit</span></div>
        <p class="lab-note guide-motion">Loaded commit touches build brightness up to this cursor. Playing shows current as folder marbles become enclosures. Pause restores small marbles and pathways, freezing current. Wireframes mark absent files; a halo marks selection.</p>
        <div class="section-title" id="guide-index-title">Repository index</div>
        <p class="lab-note guide-count-note" id="guide-index-caption"></p>
        <nav id="guide-index" aria-label="Focus a repository folder"></nav>
        <p class="lab-note guide-count-note" id="guide-count-explanation">Click a name to focus. Counts show present / mapped files; amber dots mark changes.</p>
        <details class="eq-history guide-loading"><summary class="section-title">How data becomes a scene</summary>
          <ol>
            <li><strong>Read GitHub.</strong> Fetch the default branch, pin its latest commit, and read that commit’s file tree.</li>
            <li><strong>Read changes.</strong> Load recent commits and their file changes, following the first parent through merges.</li>
            <li id="guide-map-step"><strong>Build the structure.</strong> Keep folders at repository depth and connect files to their own folders. Each non-root folder switches between a carbon marble and its enclosure.</li>
            <li id="guide-replay-step"><strong>Replay.</strong> Add or remove file atoms; renames retain their identity. Each loaded commit touch adds brightness to that file and its folder path. Rewinding restores the touch counts at that commit.</li>
          </ol>
          <p class="lab-note" id="guide-encoding-note">During playback, each non-root enclosure replaces its folder’s marble and fits current contents. Pause restores the small marble. The root keeps the current commit author’s portrait and name. Playing adds a sun glow; pausing opens a message bubble with the commit, changed files, line totals, and GitHub link. Initials stand in for unavailable pictures. Connections encode containment. Color and sphere size identify the assigned file element; byte size is shown in the inspector. Historical wireframes are excluded from current counts.</p>
          <p class="lab-note" id="guide-coverage-note">Up to 500 files are mapped. All their ancestor folders remain visible; the inspector lists every loaded file and change.</p>
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
    const indexLayout = view === 'tree' ? scene.indexLayout || scene.layout : scene.layout;
    const changedIndex = view === 'tree' && this.indexLayout !== indexLayout;
    if (changedModel || changedScene || changedView || changedIndex) {
      const focusedElement = document.activeElement;
      const focusedFolder = focusedElement?.dataset.guideFolder;
      const focusedExpand = focusedElement?.dataset.guideExpand;
      const scroll = this.el.querySelector('#guide-index').scrollTop;
      if (changedModel) this.expansionState = new Map();
      else {
        this.expansionState ||= new Map();
        for (const row of this.rows.values()) {
          if (row.expand) this.expansionState.set(row.path, row.expand.getAttribute('aria-expanded') === 'true');
        }
      }
      this.focusedPath = changedModel ? null : this.focusedPath;
      this.view = view;
      this.model = model;
      this.scene = scene;
      this.indexLayout = indexLayout;
      this.buildIndex();
      for (const [path, open] of this.expansionState) {
        const row = this.rows.get(path);
        if (row?.children) { row.children.hidden = !open; row.expand.setAttribute('aria-expanded', String(open)); row.expand.textContent = open ? '▾' : '▸'; }
      }
      if (focusedFolder !== undefined) this.rows.get(focusedFolder)?.focus.focus({ preventScroll: true });
      if (focusedExpand !== undefined) this.rows.get(focusedExpand)?.expand?.focus({ preventScroll: true });
      this.el.querySelector('#guide-index').scrollTop = changedModel ? 0 : scroll;
      if (changedModel || changedScene || changedView) this.renderLegend();
      this.el.querySelector('#guide-index-caption').textContent = view === 'tree' && scene.indexLayout
        ? `${indexLayout.nodes.length.toLocaleString()} present files · ${indexLayout.folders.length.toLocaleString()} folders including root`
        : `${scene.renderedCount.toLocaleString()} of ${model.nodes.length.toLocaleString()} loaded files mapped`;
      this.el.querySelector('#guide-source-note').textContent = `${model.repository.source === 'example' ? 'Preloaded repository snapshot. ' : ''}${model.commits.length} commits loaded. ${model.coverage.label}. Full limits and omissions are listed under Data coverage on the right.`;
    }
    if (view !== 'tree') this.refreshStructureMembership();
    const rootIndex = view === 'tree' && Boolean(scene.indexLayout);
    const active = new Set(frame.activeIds), changed = new Set(frame.changedIds);
    for (const row of this.rows.values()) {
      const present = row.ids.filter(id => active.has(id)).length;
      const changes = row.ids.filter(id => changed.has(id)).length;
      row.count.textContent = rootIndex ? String(present) : `${present}/${row.ids.length}`;
      row.marker.hidden = !changes;
      row.marker.title = `${changes} ${rootIndex ? 'present' : 'mapped'} files changed in this commit`;
      row.focus.setAttribute('aria-label', rootIndex
        ? `Focus ${row.path || model.repository.name}: ${present} files present, ${changes} changed`
        : `${row.historical ? 'Historical folder. ' : ''}Focus ${row.path || model.repository.name}: ${present} of ${row.ids.length} mapped files present, ${changes} changed`);
    }
    const selectedFolder = view !== 'tree'
      ? scene.structure?.nodes.find(node => node.id === selectedId)?.folder
      : (scene.indexNodes || scene.nodes).get(selectedId)?.node.folder;
    if (selectedId && (selectedId !== this.selectedId || selectedFolder !== this.selectedFolder || changedScene || changedView)) {
      this.focusedPath = selectedFolder ?? null;
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
    this.selectedFolder = selectedFolder;
    this.updateRootGrowthReadout();
    this.markFocus();
  }

  renderLegend() {
    const tree = this.view === 'tree';
    const $ = selector => this.el.querySelector(selector);
    $('.guide-intro').textContent = tree
      ? 'One repository, growing through the same commit history.'
      : 'One folder, two forms: a small carbon marble when paused, an enclosure while playing. The root keeps the commit author’s portrait. Play adds a sun glow; pause opens the commit message and changes.';
    $('#guide-atom-types').hidden = tree;
    $('#guide-activity-key').hidden = tree;
    $('#guide-index-title').textContent = tree ? 'Root directory index' : 'Repository index';
    $('#guide-count-explanation').textContent = tree
      ? 'Click a folder to focus its root subtree. In large repositories, zoom in to reveal more names without overlap. Every root stays rendered. Dot-prefixed entries and their contents are hidden. Amber dots mark changes.'
      : 'Click a name to focus. Counts show present / mapped files; amber dots mark changes.';
    this.el.querySelector('.guide-intro + .section-title').textContent = tree ? 'Reading the shapes' : 'Reading the structure';
    $('#guide-shape-key').innerHTML = tree
      ? `<div><dt><span class="guide-icon">${icons.trunk}</span>Repository trunk</dt><dd>The repository root, growing taller and thicker with each commit</dd></div>
         <div><dt><span class="guide-icon">${icons.branch}</span>Folder branches</dt><dd>More present leaves lengthen and bend a limb</dd></div>
         <div><dt><span class="guide-icon">${icons.leaf}</span>File leaves</dt><dd>One leaf for each mapped file</dd></div>
         <div><dt><span class="guide-icon">${icons.roots}</span>Directory roots</dt><dd>Exact folder junctions; each file root gains a fixed step per commit touch</dd></div>`
      : `<div><dt><span class="guide-icon">${icons.carbon}</span>Folder · C</dt><dd>Its small marble becomes an enclosing boundary while playing; pause restores it</dd></div>
         <div><dt><span class="guide-icon">${icons.atom}</span>File atom</dt><dd>One N, O, H or S atom per file, visible in both modes</dd></div>`;
    $('#guide-relations').innerHTML = tree
      ? 'The trunk is the repository root. The flat base scales with the visible file count and fits the full root footprint. Connections meet at the exact folder junctions in the current hierarchy. Each file starts with a connection to its own folder, then gains length through commit touches. Initial root spacing and the step per touch scale with the repository’s snapshot width, fixed through replay. Folder junctions stay fixed during this growth. Folder names sit beside junctions; file names stay near their tips in nearby rows. Click a name to focus its folder or inspect its file.'
      : '<span class="guide-connection" aria-hidden="true"></span>Each enclosure fits its folder’s current files. The root keeps its small marble, and folder levels preserve the actual hierarchy.';
    const sizeNote = $('#guide-size-note');
    sizeNote.hidden = !tree;
    if (tree) {
      const nodes = [...this.scene.nodes.values()].map(record => record.node);
      const known = nodes.filter(node => Number.isFinite(node.size) && node.size >= 0).length;
      sizeNote.textContent = `Leaf area follows snapshot bytes, with limits for readability. Empty files use the minimum size; unknown sizes use a muted fallback. ${known.toLocaleString()} known · ${(nodes.length - known).toLocaleString()} unknown.`;
    }
    $('.guide-motion').textContent = tree
      ? 'Each file touch adds the same calibrated length step within this repository. Renames retain growth; rewinding restores the earlier length. Above ground, new leaves grow and removed leaves fall.'
      : 'Loaded commit touches build brightness up to this cursor. Playing shows current as folder marbles become enclosures. Pause restores small marbles and pathways, freezing current. Wireframes mark absent files; a halo marks selection.';
    $('#guide-map-step').innerHTML = tree
      ? '<strong>Build both hierarchies.</strong> The trunk begins the root hierarchy. Every present file connects to its actual folder, and every folder connects to its parent. Above ground, mapped files become leaves on growing limbs.'
      : '<strong>Build the structure.</strong> Keep folders at repository depth and connect files to their own folders. Each non-root folder switches between a carbon marble and its enclosure.';
    $('#guide-replay-step').innerHTML = tree
      ? '<strong>Replay growth.</strong> Each distinct loaded commit touching a file adds the repository’s calibrated length step to its root. Rewinding restores its earlier length. Above ground, new leaves grow, removed leaves fall, and lighter branches lift back up.'
      : '<strong>Replay.</strong> Add or remove file atoms; renames retain their identity. Each loaded commit touch adds brightness to that file and its folder path. Rewinding restores the touch counts at that commit.';
    $('#guide-coverage-note').textContent = tree
      ? 'Roots display every present loaded file and ancestor folder except dot-prefixed entries and their contents. Names identify junctions and tapered ends. Large repositories reveal names as space becomes available; zoom or focus a folder to read more. All file roots remain present, including those whose names do not fit at the current zoom. The canopy maps up to 500 leaves. GitHub loading limits are listed under Data coverage.'
      : 'Up to 500 files are mapped. All their ancestor folders remain visible; the inspector lists every loaded file and change.';
    $('#guide-encoding-note').textContent = tree
      ? 'Trunk height and thickness show progress through the loaded history. Branch weight is a visual metaphor for present mapped leaf counts, not bytes or code quality. File identities survive renames; their positions follow the growing limbs. Leaf areas use known file sizes at the loaded snapshot, held constant during replay. Every distinct loaded commit touching a file adds the same length step within this repository. Baseline root spacing and growth are calibrated to the loaded repository snapshot’s width, and that calibration stays fixed throughout replay. The count follows file identity across renames and folder moves. Initial connections vary with the hierarchy, so compare added length within a repository rather than total root length. Use touch counts when comparing different repositories. Thickness is a gentle visual effect of length, not another activity count. For an unchanged hierarchy, folder junctions and untouched file roots keep their positions. Growth does not push neighboring roots or bend the ground; the base stays flat while zooming and rotating. File names remain attached to their actual tips, with no guide-line extensions. Historical byte sizes are not inferred from lines added or deleted. Areas are relative to the median known positive file size, limited to 0.16–6.25 times that area. Empty files use the minimum; unknown sizes use a muted 0.65 fallback.'
      : 'During playback, each non-root enclosure replaces its folder’s marble and fits current contents. Pause restores the small marble. The root keeps the current commit author’s portrait and name. Playing adds a sun glow; pausing opens a message bubble with the commit, changed files, line totals, and GitHub link. Initials stand in for unavailable pictures. Connections encode containment. Color and sphere size identify the assigned file element; byte size is shown in the inspector. Historical wireframes are excluded from current counts.';
  }

  updateRootGrowthReadout() {
    if (this.view !== 'tree') return;
    const layout = this.scene?.roots?.layout || this.scene?.indexLayout;
    const step = layout?.lengthGrowth?.lengthPerTouch ?? layout?.proportions?.lengthPerTouch ?? ROOT_LENGTH_PER_TOUCH;
    const formatted = Number(step).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const text = `Here, each file touch adds ${formatted} scene units. The step scales with the repository’s snapshot width and stays fixed during replay. Compare added length within this repository; use touch counts across repositories. Roots thicken gently with length. Renames retain growth, and rewinding restores it. Above ground, new leaves grow and removed leaves fall.`;
    const note = this.el.querySelector('.guide-motion');
    if (note.textContent !== text) note.textContent = text;
  }

  updateRootReadability() {
    if (this.view !== 'tree' || !this.scene?.roots?.labels) return;
    const layout = this.scene.roots.baseLayout;
    if (!layout) return;
    const focused = this.scene.frameMode === 'roots';
    const names = this.scene.roots.labels.visibleFileCount;
    const text = `${layout.fileCount.toLocaleString()} present files · ${layout.folderCount.toLocaleString()} folders including root${focused && layout.fileCount > 160 ? ` · ${names.toLocaleString()} filenames in view` : ''}`;
    const caption = this.el.querySelector('#guide-index-caption');
    if (caption.textContent !== text) caption.textContent = text;
  }

  buildIndex() {
    this.rows.clear();
    const container = this.el.querySelector('#guide-index');
    container.replaceChildren();
    const layout = this.indexLayout || this.scene.layout;
    const folders = layout.folders;
    const sceneFolders = this.view === 'tree' ? this.scene.indexFolders || this.scene.folders : this.scene.folders;
    const childrenByParent = new Map();
    for (const folder of folders) {
      const siblings = childrenByParent.get(folder.parent) || [];
      siblings.push(folder);
      childrenByParent.set(folder.parent, siblings);
    }
    const append = (folder, parent) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'guide-index-folder';
      const line = document.createElement('div');
      line.className = 'guide-index-row';
      const focus = document.createElement('button');
      focus.type = 'button';
      focus.className = 'body-row guide-index-focus';
      focus.dataset.guideFolder = folder.path;
      focus.title = folder.path || this.model.repository.fullName;
      const swatch = document.createElement('span');
      swatch.className = 'dot';
      const color = sceneFolders.get(folder.path)?.color;
      swatch.style.background = folder.path && color ? `#${color.getHexString()}` : '#b5a482';
      const name = document.createElement('span'); name.className = 'row-name'; name.textContent = folder.path ? folder.name || folder.path.split('/').at(-1) : this.model.repository.name;
      const marker = document.createElement('i'); marker.className = 'guide-change-dot'; marker.setAttribute('aria-hidden', 'true');
      const count = document.createElement('span'); count.className = 'guide-index-count'; count.setAttribute('aria-hidden', 'true');
      focus.append(swatch, name, marker, count); line.append(focus); wrapper.append(line); parent.append(wrapper);
      const ids = layout.nodes.filter(node => !folder.path || node.folder === folder.path || node.folder.startsWith(`${folder.path}/`)).map(node => node.id);
      const row = { path: folder.path, wrapper, focus, count, marker, ids };
      this.rows.set(folder.path, row);
      const children = childrenByParent.get(folder.path) || [];
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

  refreshStructureMembership() {
    const structure = this.scene.structure;
    if (!structure) return;
    for (const row of this.rows.values()) row.ids = [];
    for (const node of structure.nodes) {
      let path = node.folder;
      while (true) {
        this.rows.get(path)?.ids.push(node.id);
        if (!path) break;
        path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      }
    }
    const activeFolders = new Set(structure.folderIds || structure.folders.map(folder => folder.path));
    for (const row of this.rows.values()) {
      row.historical = !activeFolders.has(row.path);
      row.wrapper.classList.toggle('historical', row.historical);
      row.wrapper.hidden = row.historical && this.scene.options?.ghosts === false;
      row.focus.title = `${row.path || this.model.repository.fullName}${row.historical ? ' · historical folder' : ''}`;
    }
  }

  markFocus() {
    for (const row of this.rows.values()) {
      row.focus.classList.toggle('selected', this.focusedPath === row.path);
      row.focus.setAttribute('aria-pressed', String(this.focusedPath === row.path));
    }
  }

  dispose() { this.listeners.abort(); this.el.remove(); this.toggle.remove(); }
}
