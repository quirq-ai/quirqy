// Path routes for Quirqy instruments.
// Each section has a stable URL so it can be bookmarked and shared.

export const ROUTES = [
  { mode: 'data', path: '/data', title: 'Quirqy · Data Lab', aliases: ['/', '/data-lab'] },
  { mode: 'activity', path: '/activity', title: 'Quirqy · Activity Lab', aliases: ['/activity-lab'] },
  { mode: 'spm', path: '/spm', title: 'Quirqy · SPM Mooring', aliases: ['/mooring'] },
  { mode: 'solar', path: '/solar', title: 'Quirqy · Solar System', aliases: [] },
  { mode: 'math', path: '/equation', title: 'Quirqy · Equation Lab', aliases: ['/math', '/equations'] },
  { mode: 'earth', path: '/earth', title: 'Quirqy · Earth Lab', aliases: [] },
  { mode: 'light', path: '/light', title: 'Quirqy · Light Lab', aliases: ['/optics'] },
  { mode: 'gravity', path: '/gravity', title: 'Quirqy · Gravity Lab', aliases: [] },
  { mode: 'photo', path: '/photo', title: 'Quirqy · Photo Lab', aliases: ['/photosynthesis', '/photoelectric'] },
  { mode: 'fractal', path: '/fractals', title: 'Quirqy · Fractals Lab', aliases: ['/fractal'] },
];

const byMode = Object.fromEntries(ROUTES.map((r) => [r.mode, r]));
const byPath = new Map();
for (const r of ROUTES) {
  byPath.set(r.path, r.mode);
  for (const a of r.aliases) byPath.set(a, r.mode);
}

export function pathForMode(mode) {
  return (byMode[mode] || byMode.data).path;
}

export function titleForMode(mode) {
  return (byMode[mode] || byMode.data).title;
}

export function modeFromLocation(loc = window.location) {
  // Hash (#/equation or #photo) wins when present so old and shared links still work
  const hash = (loc.hash || '').replace(/^#\/?/, '');
  if (hash) {
    const hp = '/' + hash.replace(/^\/+/, '');
    if (byPath.has(hp)) return byPath.get(hp);
    if (byMode[hash]) return hash;
  }

  let raw = (loc.pathname || '/').replace(/\/+$/, '') || '/';
  if (raw === '') raw = '/';
  if (byPath.has(raw)) return byPath.get(raw);
  return 'data';
}

export function syncUrl(mode, { replace = false } = {}) {
  const route = byMode[mode] || byMode.data;
  const url = route.path + window.location.search;
  const state = { mode: route.mode };
  if (replace) window.history.replaceState(state, '', url);
  else {
    const cur = window.location.pathname.replace(/\/+$/, '') || '/';
    if (cur === route.path) {
      window.history.replaceState(state, '', url);
    } else {
      window.history.pushState(state, '', url);
    }
  }
  document.title = route.title;
}

export function bindPopState(onMode) {
  window.addEventListener('popstate', (e) => {
    const mode = (e.state && e.state.mode) || modeFromLocation();
    onMode(mode);
  });
}
