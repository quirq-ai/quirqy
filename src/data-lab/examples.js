import xo from './examples/xo.json' with { type: 'json' };
import xoSpace from './examples/xo-space.json' with { type: 'json' };
import { parseRepositoryUrl } from './github.js';

// Both snapshots ship with Data Lab: choosing an example never fetches GitHub.
const snapshots = [xo, xoSpace];
export const DEFAULT_EXAMPLE_URL = xo.repository.url;
export const DEFAULT_EXAMPLE_COMMIT_LIMIT = 50;
export const EXAMPLE_REPOSITORIES = Object.freeze(snapshots.map(({ repository }) => Object.freeze({
  name: repository.fullName,
  url: repository.url,
  headSha: repository.headSha,
  capturedAt: repository.capturedAt,
})));

export function getExampleDataset(input = DEFAULT_EXAMPLE_URL, limit = DEFAULT_EXAMPLE_COMMIT_LIMIT) {
  let url;
  try { url = parseRepositoryUrl(input).url.toLowerCase(); }
  catch { return null; }
  const snapshot = snapshots.find(data => data.repository.url.toLowerCase() === url);
  if (!snapshot) return null;
  const count = Math.min(DEFAULT_EXAMPLE_COMMIT_LIMIT, snapshot.commits.length, Math.max(1, Math.floor(Number(limit) || DEFAULT_EXAMPLE_COMMIT_LIMIT)));
  // Each selection gets independent data so playback or export cannot alter a preset.
  const dataset = structuredClone(snapshot);
  const start = dataset.commits.length - count;
  dataset.commits = dataset.commits.slice(start);
  if (dataset.sizeHistory?.version === 1) {
    const history = dataset.sizeHistory;
    if (start > 0) history.baseline = structuredClone(history.commits[start - 1]);
    history.commits = history.commits.slice(start);
  }
  dataset.provenance.bundledCommitCount = snapshot.commits.length;
  dataset.provenance.commitCount = dataset.commits.length;
  dataset.provenance.firstParentBoundarySha = dataset.commits[0]?.firstParent || null;
  dataset.provenance.changedFileCount = dataset.commits.reduce((sum, commit) => sum + commit.files.length, 0);
  dataset.provenance.binaryChangeCount = dataset.commits.reduce((sum, commit) => sum + commit.files.filter(file => file.binary).length, 0);
  if (dataset.provenance.firstParentBoundarySha) {
    dataset.coverage.limitations = dataset.coverage.limitations.map(note => note.includes('complete first-parent history')
      ? 'The snapshot follows recent first-parent history; earlier history and side-branch commits are not replayed separately.'
      : note);
  }
  dataset.coverage.label = `${dataset.commits.length} first-parent commits · preloaded ${dataset.repository.capturedAt.slice(0, 10)} · pinned ${dataset.repository.headSha.slice(0, 7)}`;
  return dataset;
}
