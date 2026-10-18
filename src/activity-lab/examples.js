import xo from './examples/xo.json' with { type: 'json' };
import xoSpace from './examples/xo-space.json' with { type: 'json' };
import { parseRepositoryUrl } from '../data-lab/github.js';

const snapshots = [xo, xoSpace];
export const DEFAULT_ACTIVITY_EXAMPLE_URL = 'https://github.com/quirq-ai/xo';
export const ACTIVITY_EXAMPLES = Object.freeze(snapshots.map(dataset => Object.freeze({
  name: dataset.repository.fullName, fullName: dataset.repository.fullName,
  url: dataset.repository.url, fetchedAt: dataset.fetchedAt,
})));

// These actual collaboration snapshots ship with the app. No GitHub call is
// required to open either example, including when the public API is unavailable.
export async function getActivityExample(input = DEFAULT_ACTIVITY_EXAMPLE_URL) {
  let url;
  try { url = parseRepositoryUrl(input).url.toLowerCase(); }
  catch { return null; }
  const snapshot = snapshots.find(dataset => dataset.repository.url.toLowerCase() === url);
  return snapshot ? structuredClone(snapshot) : null;
}
