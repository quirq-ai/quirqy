// Data Lab uses quirq observatory's stage and HUD, with its own repository state.
import './style.css';
import { createStage } from '../scene/setup.js';
import { createDemoDataset } from './demo.js';
import { loadRepository } from './github.js';
import { buildModel, stateAt } from './model.js';
import { MoleculeScene } from './molecule-scene.js';
import { TreeScene } from './tree-scene.js';
import { DataPanel } from './panel.js';
import { DataGuide } from './guide.js';

export function mountDataLab() {
  document.body.dataset.mode = 'data';
  document.title = 'quirq observatory · Data Lab';
  for (const tab of document.querySelectorAll('#tab-switch a')) {
    tab.classList.toggle('active', tab.id === 'tab-data');
  }
  const lifetime = new AbortController();
  const listen = (el, event, handler) => el?.addEventListener(event, handler, { signal: lifetime.signal });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let model, frame, index = -1, selectedId = null;
  let playing = false, speed = 1, stepTime = 0, previousTime = 0, raf;
  let requestId = 0, requestController = null, disposed = false, scene;
  let view = 'structure';
  const options = { links: true, labels: true, ghosts: true, activity: true, roots: true };
  document.body.dataset.dataView = view;

  const panel = new DataPanel({
    onLoad: importRepository,
    onDemo: showDemo,
    onFrame: () => scene.resetView(),
    onFrameRoots: () => { options.roots = true; scene.setOptions({ roots: true }); renderPanel(); scene.focusRoots?.(); },
    onFocusFile: id => { selectFile(id); scene.focusNode(id); },
    onFocusFolder: path => focusDirectory(path === '(root)' ? '' : path),
    onSelectFile: selectFile,
    onCommit: next => { setPlaying(false); setIndex(next); },
    onPlay: togglePlayback,
    onPrev: () => { setPlaying(false); setIndex(index - 1); },
    onNext: () => { setPlaying(false); setIndex(index + 1); },
    onSpeed: next => { speed = next; stepTime = 0; renderPanel(); },
    onView: switchView,
    onOptions: next => { Object.assign(options, next); scene.setOptions(options); renderPanel(); },
    onExport: exportData,
  });
  const stage = createStage(document.getElementById('app'));
  scene = new MoleculeScene(stage, { onSelect: selectFile });
  const guide = new DataGuide({
    onOverview: () => scene.resetView(),
    onFocusFolder: focusDirectory,
  });

  const topDate = document.getElementById('date-text');
  const liveBadge = document.getElementById('live-badge');
  const attribution = document.getElementById('attribution');
  attribution.textContent = 'Repository atoms · Drag to orbit · Scroll to zoom · Double-click to focus · H for help';
  const help = document.getElementById('help-overlay');
  help.innerHTML = `<div class="help-card" role="dialog" aria-modal="true" aria-labelledby="data-help-title">
    <button class="panel-close" type="button" aria-label="Close help">×</button>
    <h2 id="data-help-title">Data Lab</h2>
    <p class="help-sub">Two views share one repository and commit timeline. Structure shows exactly one carbon atom per folder and one typed atom per file. Each folder connects to its parent, and each file connects directly to its folder. File elements are nitrogen for code, oxygen for data, hydrogen for documents, and sulfur for media. Growth tree grows taller and thicker with each loaded commit; branches lengthen and droop as more leaves appear. The trunk itself is the repository root. Below ground, the complete folder hierarchy branches horizontally in a balanced, fully expanded 3D tree, following the exact paths at the selected commit.</p>
    <div class="help-grid"><span>Drag / scroll</span><span>Orbit / zoom the scene</span>
    <span>Click</span><span>Select a file and inspect its history</span>
    <span>Double-click</span><span>Focus a file or folder</span>
    <span>Space</span><span>Play or pause commit history</span>
    <span>← / →</span><span>Previous / next commit</span>
    <span>F</span><span>Frame the repository</span>
    <span>S</span><span>Save a scene image</span>
    <span>H / Escape</span><span>Open / close help</span></div>
    <p class="help-tip">In Structure, click a colored atom to inspect its file, or a carbon atom to focus its folder and direct contents. Use Frame view to return to the full repository. One folder always means one carbon, including the repository root. All files connect directly to their folder carbon; folders can have as many connections as their contents require. A moved file keeps its identity and reconnects to its current folder. Element assignments encode file types. Atoms and bonds begin translucent. Each loaded commit touching a file strengthens that file and its folder pathway; frequently touched parts become brighter. Travelling current marks the selected commit, and rewinding restores the earlier brightness. This shows commit touches, not runtime calls. Counts cover present mapped files and their folders; historical ghosts are excluded. In Growth tree, leaves follow the growing limbs. Step forward to see additions grow, removals fall, and lighter branches lift; seeking restores the chosen state. Branch weight follows present mapped leaf counts. Leaf area uses known snapshot bytes, with size limits for readability. Use Frame roots to inspect the full hierarchy beneath the trunk. Folder roots split into their actual subfolders and files, with sibling branches spread symmetrically across the scene. Every present loaded file and ancestor folder is expanded. Click a folder root to focus its subtree, or a file tip to inspect the same file as its canopy leaf. Public history follows the sampled first-parent chain. The scene guide explains each view and its coverage.</p>
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
    if (event.key.toLowerCase() === 'f') scene.resetView();
    if (event.key.toLowerCase() === 's') saveSnapshot();
    if (event.key.toLowerCase() === 'h') toggleHelp();
  });
  listen(document, 'visibilitychange', () => { previousTime = 0; stepTime = 0; });

  function renderPanel() {
    if (!model || !frame) return;
    panel.setState({ model, frame, index, selectedId, playing, speed, view, structure: scene.structure, activity: scene.activityState, renderedCount: scene.renderedCount, rootLayout: scene.roots?.layout, rootsVisible: scene.options.roots !== false, mappedIds: scene.mappedNodes || scene.nodes });
    guide.setState({ model, frame, scene, selectedId, view });
    topDate.textContent = index < 0 ? 'Before sampled history' : `${frame.commit.sha.slice(0, 7)} · ${index + 1}/${model.commits.length}`;
    liveBadge.textContent = model.repository.source === 'demo' ? 'SAMPLE' : playing ? 'REPLAY' : 'GITHUB';
    liveBadge.classList.toggle('on', playing);
  }
  function updateScene() {
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
      ? new TreeScene(stage, { onSelect: selectFile })
      : new MoleculeScene(stage, { onSelect: selectFile });
    scene.setOptions(options);
    if (model) {
      scene.setModel(model);
      updateScene();
    }
    stepTime = 0;
    attribution.textContent = view === 'tree'
      ? 'Repository growth tree · Drag to orbit · Scroll to zoom · Double-click to focus · H for help'
      : 'Repository atoms · Drag to orbit · Scroll to zoom · Double-click to focus · H for help';
    renderPanel();
  }
  function setIndex(next) {
    if (!model) return;
    index = Math.max(-1, Math.min(model.commits.length - 1, Math.floor(Number(next))));
    frame = stateAt(model, index);
    stepTime = 0;
    updateScene();
    renderPanel();
  }
  function setPlaying(next) {
    playing = Boolean(next && model?.commits.length);
    stepTime = 0;
    renderPanel();
  }
  function togglePlayback() {
    if (!playing && index === model.commits.length - 1) setIndex(-1);
    setPlaying(!playing);
  }
  function focusDirectory(path) {
    if (scene.focusRootFolder) {
      options.roots = true;
      scene.setOptions({ roots: true });
      renderPanel();
      scene.focusRootFolder(path);
    } else scene.focusFolder(path);
  }
  function selectFile(id) {
    if (id !== null && !model?.nodes.some(node => node.id === id)) return;
    selectedId = id;
    scene.select(id);
    renderPanel();
  }
  function useDataset(dataset, autoplay = false) {
    playing = false;
    model = buildModel(dataset);
    selectedId = null;
    scene.setModel(model);
    setIndex(autoplay && !reducedMotion.matches ? 0 : model.commits.length - 1);
    setPlaying(autoplay && !reducedMotion.matches);
    panel.setStatus(dataset.repository.source === 'demo'
      ? 'Synthetic sample · 22 illustrative commits. Load a public repository to use real Git history.'
      : `Loaded ${model.commits.length} first-parent commits from ${model.repository.fullName}.`,
    dataset.repository.source === 'demo' ? 'sample' : 'success');
  }
  function showDemo() {
    requestId++;
    requestController?.abort();
    panel.setLoading(false);
    useDataset(createDemoDataset(), true);
  }
  async function importRepository(url, limit) {
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
          setIndex(index + 1);
          if (index === model.commits.length - 1) setPlaying(false);
        }
      }
      scene.update(dt);
      stage.controls.update();
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
  listen(window, 'pagehide', event => { if (!event.persisted) dispose(); });
  showDemo();
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
