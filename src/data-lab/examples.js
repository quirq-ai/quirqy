import xo from './examples/xo.json' with { type: 'json' };
import xoSpace from './examples/xo-space.json' with { type: 'json' };
import { parseRepositoryUrl } from './github.js';

// Both snapshots ship with Data Lab: choosing an example never fetches GitHub.
const snapshots = [xo, xoSpace];
export const DEFAULT_EXAMPLE_URL = xo.repository.url;
export const EXAMPLE_REPOSITORIES = Object.freeze(snapshots.map(({ repository }) => Object.freeze({
  name: repository.fullName,
  url: repository.url,
  headSha: repository.headSha,
  capturedAt: repository.capturedAt,
})));

export function getExampleDataset(input = DEFAULT_EXAMPLE_URL, limit = 12) {
  let url;
  try { url = parseRepositoryUrl(input).url.toLowerCase(); }
  catch { return null; }
  const snapshot = snapshots.find(data => data.repository.url.toLowerCase() === url);
  if (!snapshot) return null;
  const count = Math.min(20, Math.max(1, Math.floor(Number(limit) || 12)));
  // Each selection gets independent data so playback or export cannot alter a preset.
  const dataset = structuredClone(snapshot);
  dataset.commits = dataset.commits.slice(-count);
  dataset.provenance.bundledCommitCount = snapshot.commits.length;
  dataset.provenance.commitCount = dataset.commits.length;
  dataset.provenance.firstParentBoundarySha = dataset.commits[0]?.firstParent || null;
  dataset.provenance.changedFileCount = dataset.commits.reduce((sum, commit) => sum + commit.files.length, 0);
  dataset.provenance.binaryChangeCount = dataset.commits.reduce((sum, commit) => sum + commit.files.filter(file => file.binary).length, 0);
  dataset.coverage.label = `${dataset.commits.length} first-parent commits · preloaded ${dataset.repository.capturedAt.slice(0, 10)} · pinned ${dataset.repository.headSha.slice(0, 7)}`;
  return dataset;
}
