// A fictional, deterministic repository. This is not quirq observatory's Git history.
// Include code, configuration, documentation and media so each file encoding
// can be explored in the sample without changing its counts or timeline.
export function createDemoDataset() {
  const groups = {
    app: ['bootstrap.js', 'router.js', 'shell.js', 'navigation.js', 'state.js', 'README.md', 'shortcuts.js', 'views.js'],
    components: ['button.js', 'panel.js', 'slider.js', 'card.js', 'badge.js', 'dialog.js', 'tooltip.js', 'icons.svg'],
    engine: ['clock.js', 'integrator.js', 'vector.js', 'sampler.js', 'cache.js', 'worker.js', 'validation.js', 'legacy.js'],
    data: ['presets.json', 'schema.js', 'loader.js', 'fixtures.json', 'transforms.js', 'catalog.json', 'parse.js', 'units.json'],
    styles: ['base.css', 'tokens.css', 'panels.css', 'layout.css', 'forms.css', 'charts.css', 'dark.css', 'legacy.css'],
    tests: ['clock.test.js', 'integrator.test.js', 'loader.test.js', 'schema.test.js', 'router.test.js', 'vector.test.js', 'render.test.js', 'fixtures.js'],
  };
  const head = new Map();
  const union = new Set();
  let seed = 0;
  for (const [directory, names] of Object.entries(groups)) for (const name of names) {
    const path = `${directory}/${name}`;
    head.set(path, 400 + (++seed * 157) % 4200);
    union.add(path);
  }
  const modify = (path, additions, deletions = 0) => ({ path, status: 'modified', additions, deletions });
  const add = (path, additions) => ({ path, status: 'added', additions, deletions: 0 });
  const remove = (path, deletions) => ({ path, status: 'removed', additions: 0, deletions });
  const rename = (previousPath, path, additions = 0, deletions = 0) => ({ path, previousPath, status: 'renamed', additions, deletions });
  const events = [
    ['Connect the application shell', [modify('app/bootstrap.js', 26, 8), modify('app/shell.js', 48, 15), modify('app/navigation.js', 19, 4)]],
    ['Unify button and panel spacing', [modify('components/button.js', 14, 8), modify('components/panel.js', 31, 13), modify('styles/tokens.css', 22, 5), modify('styles/panels.css', 42, 20)]],
    ['Validate incoming experiment data', [modify('data/schema.js', 68, 12), modify('data/loader.js', 29, 9), modify('tests/schema.test.js', 57, 3)]],
    ['Improve the integration step', [modify('engine/integrator.js', 54, 31), modify('engine/vector.js', 12, 6), modify('tests/integrator.test.js', 36, 4)]],
    ['Add a reusable resize observer', [add('components/resize.js', 62), modify('components/panel.js', 11, 7), modify('styles/layout.css', 24, 10)]],
    ['Expand the preset catalog', [modify('data/presets.json', 94, 4), modify('data/catalog.json', 23, 6), modify('data/fixtures.json', 38, 0)]],
    ['Add keyboard navigation coverage', [add('tests/keyboard.test.js', 81), modify('app/shortcuts.js', 37, 11), modify('components/icons.svg', 16, 5)]],
    ['Replace the legacy engine shim', [remove('engine/legacy.js', 93), modify('engine/worker.js', 33, 14), modify('app/bootstrap.js', 9, 18)]],
    ['Introduce trace sampling', [add('engine/trace.js', 114), modify('engine/sampler.js', 45, 19), modify('data/transforms.js', 18, 6)]],
    ['Improve loading and error feedback', [modify('components/badge.js', 17, 4), modify('components/dialog.js', 28, 10), modify('data/loader.js', 41, 15)]],
    ['Rename the sampler to describe its role', [rename('engine/sampler.js', 'engine/trajectory.js', 12, 8), modify('engine/trace.js', 8, 8), modify('engine/worker.js', 5, 5)]],
    ['Persist the selected workspace', [add('app/persistence.js', 74), modify('app/state.js', 26, 9), modify('app/bootstrap.js', 13, 4)]],
    ['Add trace regression tests', [add('tests/trace.test.js', 96), modify('tests/fixtures.js', 33, 0), modify('engine/trace.js', 21, 7)]],
    ['Remove the old theme overrides', [remove('styles/legacy.css', 138), modify('styles/dark.css', 41, 22), modify('styles/base.css', 12, 19)]],
    ['Clarify units in the data pipeline', [modify('data/units.json', 32, 8), modify('data/parse.js', 26, 11), modify('data/transforms.js', 17, 6), modify('tests/loader.test.js', 24, 3)]],
    ['Tune worker scheduling', [modify('engine/worker.js', 51, 28), modify('engine/cache.js', 27, 13), modify('engine/clock.js', 16, 7), modify('tests/clock.test.js', 31, 4)]],
    ['Add a compact activity chart', [add('components/activity.js', 127), modify('styles/charts.css', 53, 14), modify('app/views.js', 22, 5)]],
    ['Align form controls', [modify('components/slider.js', 29, 17), modify('components/tooltip.js', 13, 6), modify('styles/forms.css', 36, 21)]],
    ['Make routes restore their view', [modify('app/router.js', 45, 18), modify('app/views.js', 23, 10), modify('tests/router.test.js', 52, 9)]],
    ['Extract theme settings', [add('styles/theme.css', 61), modify('styles/tokens.css', 18, 30), modify('styles/dark.css', 23, 17), modify('app/shell.js', 9, 3)]],
    ['Check dataset boundary conditions', [modify('engine/validation.js', 28, 5), modify('data/schema.js', 21, 9), modify('tests/schema.test.js', 47, 2), modify('tests/loader.test.js', 32, 3)]],
    ['Polish the workspace overview', [modify('app/navigation.js', 17, 8), modify('components/card.js', 34, 16), modify('components/activity.js', 24, 7), modify('styles/layout.css', 28, 11), modify('tests/render.test.js', 35, 6)]],
  ];
  const commits = events.map(([message, files], index) => {
    for (const file of files) {
      union.add(file.path);
      if (file.previousPath) union.add(file.previousPath);
      if (file.status === 'removed') head.delete(file.path);
      else {
        const oldSize = head.get(file.previousPath || file.path) || 0;
        if (file.previousPath) head.delete(file.previousPath);
        head.set(file.path, Math.max(80, oldSize + (file.additions - file.deletions) * 24));
      }
    }
    return {
      sha: `d3${(index + 1).toString(16).padStart(38, '0')}`,
      message,
      author: ['Mira', 'Noah', 'Ari'][index % 3],
      date: new Date(Date.UTC(2026, 1, index + 1, 10 + index % 5, 20)).toISOString(),
      url: '',
      files,
    };
  });
  return {
    repository: {
      name: 'Atlas', fullName: 'demo/atlas', url: '', branch: 'main',
      description: 'A fictional workspace with synthetic file changes, built to demonstrate the map and timeline.',
      source: 'demo', headSha: commits.at(-1).sha,
    },
    files: [...union].sort().map(path => ({ path, ...(head.has(path) ? { size: head.get(path) } : {}), existsAtHead: head.has(path) })),
    commits,
    coverage: {
      label: 'Synthetic demo · 22 fictional commits · 6 directories',
      limitations: [
        'All repository names, authors, commits and line counts in this demo are synthetic. This is not quirq observatory history.',
        'Motion represents changed files. It does not represent program execution or software quality.',
      ],
    },
  };
}
