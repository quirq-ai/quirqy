import { parseRepositoryUrl } from '../data-lab/github.js';

const KEY = 'quirq-observatory.connected-repository.v1';
let current = null;

// Connection is shared; each lab keeps its own source data and timeline.
export function connectedRepository() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) current = parseRepositoryUrl(stored).url;
  } catch { /* Browser storage is optional. */ }
  return current;
}

export function connectRepository(url) {
  current = parseRepositoryUrl(url).url;
  try { localStorage.setItem(KEY, current); } catch { /* Keep working in memory. */ }
  return current;
}
