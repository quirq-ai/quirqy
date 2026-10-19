// Data Lab uses quirq observatory's stage and HUD, with its own repository state.
import './style.css';
import { createStage } from '../scene/setup.js';
import { DEFAULT_EXAMPLE_URL, DEFAULT_EXAMPLE_COMMIT_LIMIT, getExampleDataset } from './examples.js';
import { DEFAULT_REPOSITORY_COMMIT_LIMIT, loadRepository } from './github.js';
import { buildModel, stateAt } from './model.js';
import { MoleculeScene } from './molecule-scene.js';
import { TreeScene } from './tree-scene.js';
import { DataPanel } from './panel.js';
import { DataGuide } from './guide.js';
import { DataLabControls } from './data-controls.js';
import { restoreRepositorySession, saveRepositoryDataset, updateRepositorySelection } from '../repository/session.js';
import { connectedRepository, connectRepository } from '../repository/connection.js';

export async function mountDataLab() {
  document.body.dataset.mode = 'data';
  document.title = 'quirq observatory · Data Lab';
  for (const tab of document.querySelectorAll('#tab-switch a')) {
    tab.classList.toggle('active', tab.id === 'tab-data');
  }
  const lifetime = new AbortController();
  const listen = (el, event, handler) => el?.addEventListener(event, handler, { signal: lifetime.signal });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let model, frame, index = -1, selectedId = null;
  let playing = false, restartAtEnd = false, speed = 1, stepTime = 0, previousTime = 0, raf;
  let requestId = 0, requestController = null, disposed = false, scene;
  let applyingDataset = false;
  let view = 'structure';
  const options = { links: true, labels: true, ghosts: true, activity: true, roots: true };
  document.body.dataset.dataView = view;

  const panel = new DataPanel({
    onLoad: importRepository,
    onExample: url => showExample(url),
    onFrame: () => { scene.resetView(); renderPanel(); },
    onFrameRoots: () => { options.roots = true; scene.setOptions({ roots: true }); scene.focusRoots?.(); renderPanel(); },
    onFocusFile: id => { selectFile(id); scene.focusNode(id); },
    onFocusFolder: path => focusDirectory(path === '(root)' ? '' : path),
    onSelectFile: selectFile,
    onCommit: next => { setPlaying(false); setIndex(next); },
    onPlay: togglePlayback,
    onPrev: () => { setPlaying(false); setIndex(index - 1); },
    onNext: () => { setPlaying(false); setIndex(index + 1); },
    onSpeed: next => {
      stepTime *= speed / next;
      speed = next;
      if (view === 'structure') updateScene();
      renderPanel();
    },
    onView: switchView,
    onOptions: next => { Object.assign(options, next); scene.setOptions(options); renderPanel(); },
    onExport: exportData,
  });
  const stage = createStage(document.getElementById('app'));
  stage.controls.dispose();
  stage.controls = new DataLabControls(stage.camera, stage.renderer.domElement);
  scene = new MoleculeScene(stage, { onSelect: selectFile });
  const guide = new DataGuide({
    onOverview: () => { if (scene.frameMode === 'roots') scene.focusRoots(); else scene.resetView(); renderPanel(); },
    onFocusFolder: focusDirectory,
  });

  const topDate = document.getElementById('date-text');
  const liveBadge = document.getElementById('live-badge');
  const attribution = document.getElementById('attribution');
  attribution.textContent = 'Repository atoms · Drag to orbit · Scroll to zoom · H for help';
  const help = document.getElementById('help-overlay');
  help.innerHTML = `<div class="help-card" role="dialog" aria-modal="true" aria-labelledby="data-help-title">
    <button class="panel-close" type="button" aria-label="Close help">×</button>
    <h2 id="data-help-title">Data Lab</h2>
    <p class="help-sub">Two views share one repository and commit timeline. Structure shows each folder as a small carbon marble when paused. During playback, non-root marbles expand into boundaries around their current contents; the root author portrait shines like a warm sun. Pausing opens its commit message bubble. Each file remains one typed atom. Each folder connects to its parent, and each file connects directly to its folder. File elements are nitrogen for code, oxygen for data, hydrogen for documents, and sulfur for media. Growth tree grows taller and thicker with each loaded commit; branches lengthen and droop as more leaves appear. The trunk itself is the repository root. Below ground, the visible folder hierarchy branches horizontally in a balanced, fully expanded 3D tree, following the exact paths at the selected commit.</p>
    <div class="help-grid"><span>Drag</span><span>Orbit upright; rotate freely in root focus</span>
    <span>Shift + drag</span><span>Roll sideways in root focus</span>
    <span>Right-drag / scroll</span><span>Pan / zoom the scene</span>
    <span>Two fingers</span><span>Pinch to zoom, drag to pan; twist to roll in root focus</span>
    <span>Click</span><span>Select a file and inspect its history</span>
    <span>Double-click</span><span>Focus a file or folder</span>
    <span>Space</span><span>Play or pause commit history</span>
    <span>← / →</span><span>Previous / next commit</span>
    <span>F / Frame view</span><span>Frame the repository and return upright</span>
    <span>S</span><span>Save a scene image</span>
    <span>H / Escape</span><span>Open / close help</span></div>
    <p class="help-tip">In Structure, click a colored atom to inspect its file, or a folder marble or boundary to focus its direct contents. Use Frame view to return to the full repository and its upright orbit. One folder always means one carbon anchor, including the repository root. During playback, each non-root folder’s marble expands into a softly outlined boundary around its current contents. The small marble is hidden while this boundary is visible. The boundary resizes as files are added, removed, or moved. The repository root keeps the current commit author’s portrait and name, with a warm sun glow during playback. When paused, the message panel shows the commit title, ID, changed files, line additions and deletions, and a GitHub link. Click the author’s photo or name to collapse or reopen it. Expand the file count to select a changed file. Initials stand in when a profile picture is unavailable. It has no boundary. Enclosure size follows occupied space, not bytes. The vertical gaps between hierarchy levels stay fixed. All files connect directly to their folder carbon; folders can have as many connections as their contents require. A moved file keeps its identity and reconnects to its current folder. Element assignments encode file types. Atoms and bonds begin translucent. Each loaded commit touching a file strengthens that file and its folder pathway; frequently touched parts become brighter. Travelling current marks the selected commit. During playback, only the moving current is visible between atoms; pathways are hidden. Pausing immediately returns folders to their small marbles, hides boundaries, freezes the current, and reveals all pathways enabled in this view. Rewinding restores the earlier brightness. This shows commit touches, not runtime calls. Counts cover present mapped files and their folders; historical ghosts are excluded. In Growth tree, leaves follow the growing limbs. Step forward to see additions grow, removals fall, and lighter branches lift; seeking restores the chosen state. Branch weight follows present mapped leaf counts. Leaf area uses known snapshot bytes, with size limits for readability. Use Frame roots to enlarge the roots and shorten the canopy around the same ground junction, retaining a broader, sturdier trunk like a bonsai. Root focus alone enables free rotation and sideways roll. In tall, narrow viewing areas, roots initially frame sideways to use the longer space. Frame view restores a full canopy with smaller roots and upright orbit. These presentation sizes do not change file bytes or commit growth. Folder roots split into their actual subfolders and files, with sibling branches spread symmetrically across the scene. Dot-prefixed files and folders, including their contents, are hidden from roots. Every other present loaded file and ancestor folder is expanded. Folder names sit beside junctions, and file basenames sit below naturally tapered ends. Each root begins with one thin initial strand. Every loaded commit touching a file adds one thin vine to its current attachment and each ancestor folder along the path to the trunk. The vines spiral in the same direction, forming a twisted rope that grows gradually. The new vine grows along its route during playback; rewinding removes later vines and restores the earlier shape. Shared folders gain one vine per commit touching any descendant, even when several files change. Existing folders retain earlier vines after a descendant moves or disappears. A cross-folder move starts a new file attachment with its own initial strand and touch count. Growth is expressed mainly through thicker bundles. Paths expand only enough to keep neighboring ropes and their tapered tips separate. On narrow screens or crowded viewing angles, the ground and connected roots use a shallow downward curve away from the trunk, which remains the highest point. The surface flattens when a wider view, zoom, or folder focus provides enough room. This adjustment follows the current view without changing repository data or vine counts. Root focus organizes horizontal file basenames into nearby sibling rows, keeping names close to their tips with compact spacing and no extended guide lines. The smaller roots in tree view show folder names and the hovered or selected file; Frame roots exposes the full root hierarchy. Its base grows with the visible file count and the space its folders need. In large repositories, names appear only when they fit near their tips; zoom in or focus a folder to read more. Click a folder name to focus its subtree, or a file name to inspect the same file as its canopy leaf. Public history follows the sampled first-parent chain. The scene guide explains each view and its coverage.</p>
    </div>`;
  const helpButton = document.getElementById('btn-help');
  let previousFocus = null;
  function toggleHelp(show = help.classList.contains('hidden')) {
    help.classList.toggle('hidden', !show);
    if (show) { previousFocus = document.activeElement; help.querySelector('button').focus(); }
    else previousFocus?.focus();
  }
  listen(helpButton, 'click', () => toggleHelp());
  listen(help.querySelector('.panel-close'), 'click', () => toggleHelp(false));
  listen(help, 'click', event => { if (event.target === help) toggleHelp(false); });
  listen(document.getElementById('btn-snap'), 'click', saveSnapshot);
  listen(document, 'keydown', event => {
    const editing = event.target.closest('input,textarea,select,[contenteditable="true"]');
    if (event.key === 'Escape') { toggleHelp(false); return; }
    if (!help.classList.contains('hidden')) {
      if (event.key === 'Tab') { event.preventDefault(); help.querySelector('button').focus(); }
      return;
    }
    if (editing || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    // Let focused buttons retain their normal Space and arrow behavior.
    if (event.target.closest('button,a') && [' ', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); setPlaying(false); setIndex(index - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); setPlaying(false); setIndex(index + 1); }
    if (event.key.toLowerCase() === 'f') { scene.resetView(); renderPanel(); }
    if (event.key.toLowerCase() === 's') saveSnapshot();
    if (event.key.toLowerCase() === 'h') toggleHelp();
  });
  listen(document, 'visibilitychange', () => { previousTime = 0; stepTime = 0; });

  function updateFocusHint() {
    const roots = view === 'tree' && scene.frameMode === 'roots';
    document.body.dataset.dataFocus = roots ? 'roots' : 'tree';
    attribution.textContent = roots
      ? 'Root focus · Scroll to reveal names · Drag to rotate · Shift-drag / two-finger twist to roll · F for tree view'
      : `${view === 'tree' ? 'Growth tree · Frame roots to inspect below ground' : 'Repository atoms'} · Drag to orbit · Scroll to zoom · H for help`;
  }

  function renderPanel() {
    if (!model || !frame) return;
    updateFocusHint();
    panel.setState({ model, frame, index, selectedId, playing, speed, view, frameMode: scene.frameMode, structure: scene.structure, activity: scene.activityState, renderedCount: scene.renderedCount, rootLayout: scene.roots?.layout, rootsVisible: scene.options.roots !== false, mappedIds: scene.mappedNodes || scene.nodes });
    guide.setState({ model, frame, scene, selectedId, view });
    topDate.textContent = index < 0 ? 'Before sampled history' : `${frame.commit.sha.slice(0, 7)} · ${index + 1}/${model.commits.length}`;
    liveBadge.textContent = model.repository.source === 'example' ? 'EXAMPLE' : playing ? 'REPLAY' : 'GITHUB';
    liveBadge.classList.toggle('on', playing);
  }
  function updateScene() {
    scene.setPlayback?.(playing);
    scene.setFrame({
      visibleIds: frame.activeIds,
      changedIds: frame.changedIds,
      selectedId,
      statuses: Object.fromEntries((frame.commit?.changes || []).map(c => [c.id, c.status === 'copied' ? 'added' : c.status])),
      paths: Object.fromEntries(frame.files.map(file => [file.id, file.path])),
      frameKey: frame.commit?.sha || 'baseline',
      duration: 1.6 / speed,
      index,
      commitCount: model.commits.length,
    });
  }
  function switchView(next) {
    if (!['structure', 'tree'].includes(next) || next === view) return;
    // Renderers share the same stage, source model and replay cursor. Disposing
    // the old view also releases its picking handlers, labels and light rig.
    scene.dispose();
    view = next;
    document.body.dataset.dataView = view;
    scene = view === 'tree'
      ? new TreeScene(stage, { onSelect: selectFile, onFocusMode: renderPanel })
      : new MoleculeScene(stage, { onSelect: selectFile });
    scene.setOptions(options);
    if (model) {
      scene.setModel(model);
      updateScene();
    }
    stepTime = 0;
    updateFocusHint();
    renderPanel();
  }
  function persistSelection() {
    if (model && !applyingDataset) updateRepositorySelection({ commitSha: frame?.commit?.sha ?? null, fileId: selectedId });
  }
  function setIndex(next) {
    if (!model) return;
    index = Math.max(-1, Math.min(model.commits.length - 1, Math.floor(Number(next))));
    frame = stateAt(model, index);
    restartAtEnd = !playing && index === model.commits.length - 1;
    stepTime = 0;
    updateScene();
    renderPanel();
    persistSelection();
  }
  function setPlaying(next) {
    playing = Boolean(next && model?.commits.length);
    if (playing) restartAtEnd = false;
    scene.setPlayback?.(playing);
    renderPanel();
  }
  function togglePlayback() {
    if (!playing && restartAtEnd) setIndex(-1);
    setPlaying(!playing);
  }
  function focusDirectory(path) {
    if (scene.focusRootFolder && scene.roots?.folders.has(path)) {
      options.roots = true;
      scene.setOptions({ roots: true });
      renderPanel();
      scene.focusRootFolder(path);
      renderPanel();
    } else scene.focusFolder(path);
  }
  function selectFile(id) {
    if (id !== null && !model?.nodes.some(node => node.id === id)) return;
    selectedId = id;
    scene.select(id);
    renderPanel();
    persistSelection();
  }
  function useDataset(dataset, autoplay = false, selection = null, publishConnection = true) {
    applyingDataset = true;
    playing = false;
    model = buildModel(dataset);
    if (publishConnection) connectRepository(dataset.repository.url);
    selectedId = null;
    scene.setModel(model);
    const restoredIndex = selection?.commitSha === null ? -1 : model.commits.findIndex(commit => commit.sha === selection?.commitSha);
    setIndex(selection ? (restoredIndex >= 0 || selection.commitSha === null ? restoredIndex : model.commits.length - 1) : autoplay && !reducedMotion.matches ? 0 : model.commits.length - 1);
    if (selection?.fileId && model.nodes.some(node => node.id === selection.fileId)) selectFile(selection.fileId);
    setPlaying(autoplay && !reducedMotion.matches);
    applyingDataset = false;
    void saveRepositoryDataset(dataset, { commitSha: frame?.commit?.sha ?? null, fileId: selectedId });
    panel.setStatus(dataset.repository.source === 'example'
      ? `Preloaded ${model.repository.fullName} · ${model.commits.length} commits from the ${model.repository.capturedAt.slice(0, 10)} snapshot.`
      : `Loaded ${model.commits.length} first-parent commits from ${model.repository.fullName}.`,
    'success');
  }
  function showExample(url, limit = DEFAULT_EXAMPLE_COMMIT_LIMIT, autoplay = false, publishConnection = true) {
    const dataset = getExampleDataset(url, limit);
    if (!dataset) return false;
    requestId++;
    requestController?.abort();
    requestController = null;
    panel.setLoading(false);
    useDataset(dataset, autoplay, null, publishConnection);
    return true;
  }
  async function importRepository(url, limit = DEFAULT_REPOSITORY_COMMIT_LIMIT) {
    if (showExample(url, limit)) return;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const request = ++requestId;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 90000);
    setPlaying(false);
    panel.setLoading(true);
    panel.setStatus('Reading repository metadata…', 'loading');
    try {
      const dataset = await loadRepository(url, {
        limit, signal: controller.signal,
        onProgress: message => {
          if (request === requestId) panel.setStatus(typeof message === 'string' ? message : message.message, 'loading');
        },
      });
      if (request === requestId) useDataset(dataset);
    } catch (error) {
      if (request === requestId && (timedOut || error.name !== 'AbortError')) {
        panel.setStatus(timedOut ? 'GitHub did not respond in time. Try loading again; the current repository is still available.' : error.message, 'error');
      }
    } finally {
      clearTimeout(timeout);
      if (request === requestId) panel.setLoading(false);
    }
  }
  function download(url, filename, revoke = false) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportData() {
    const blob = new Blob([JSON.stringify(model.dataset, null, 2)], { type: 'application/json' });
    download(URL.createObjectURL(blob), `data-lab-${model.repository.fullName.replace(/[^a-z0-9-]/gi, '-')}.json`, true);
  }
  function saveSnapshot() {
    if (!scene || !model) return;
    download(scene.capture(), `data-lab-${view}-${model.repository.name}-${frame.commit?.sha.slice(0, 7) || 'baseline'}.png`);
  }
  function tick(now) {
    if (disposed) return;
    const dt = previousTime ? Math.min((now - previousTime) / 1000, 0.1) : 0;
    previousTime = now;
    if (!document.hidden) {
      if (playing) {
        stepTime += dt;
        if (stepTime >= 2 / speed) {
          if (index === model.commits.length - 1) { restartAtEnd = true; setPlaying(false); }
          else setIndex(index + 1);
        }
      }
      scene.update(dt);
      stage.controls.update();
      scene.afterCameraUpdate?.(dt);
      guide.updateRootReadability();
      stage.composer.render();
      stage.labelRenderer.render(stage.scene, stage.camera);
    }
    raf = requestAnimationFrame(tick);
  }
  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    lifetime.abort();
    requestController?.abort();
    guide.dispose();
    panel.dispose();
    scene.dispose();
    stage.controls.dispose();
    for (const pass of stage.composer.passes) pass.dispose?.();
    stage.composer.dispose();
    stage.renderer.dispose();
  }
  listen(window, 'pagehide', event => { if (event.persisted) setPlaying(false); else dispose(); });
  listen(window, 'pageshow', async event => {
    if (!event.persisted || disposed) return;
    const restoreRequest = requestId;
    const saved = await restoreRepositorySession({ refresh: true });
    if (disposed || requestId !== restoreRequest) return;
    const connected = connectedRepository();
    if (connected && connected !== saved?.dataset.repository.url) await importRepository(connected);
    else if (saved) useDataset(saved.dataset, false, saved.selection);
  });
  const startupRequest = requestId;
  const savedSession = await restoreRepositorySession();
  if (disposed) return;
  if (requestId === startupRequest) {
    const connected = connectedRepository();
    if (savedSession) useDataset(savedSession.dataset, false, savedSession.selection, false);
    else showExample(DEFAULT_EXAMPLE_URL, DEFAULT_EXAMPLE_COMMIT_LIMIT, true, false);
    if (connected && connected !== model?.repository.url) await importRepository(connected);
    else if (model) connectRepository(model.repository.url);
  }
  document.getElementById('loading')?.remove();
  requestAnimationFrame(() => document.getElementById('tab-data')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  raf = requestAnimationFrame(tick);
  window.__dataLab = {
    stage, panel, guide,
    get scene() { return scene; }, get view() { return view; },
    get model() { return model; }, get frame() { return frame; },
    get index() { return index; }, get playing() { return playing; },
  };
}
