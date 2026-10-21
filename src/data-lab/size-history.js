/** Git blob sizes are bytes. Null means unknown; an empty file is exactly zero. */
export const fileBytes = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const comparePath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Aggregate the whole returned tree before retaining only display-selected paths. */
export function createSizeSnapshot(files, { sha = null, treeSha, complete = true, selectedPaths } = {}) {
  const byPath = new Map();
  for (const file of files || []) {
    if (typeof file.path !== 'string' || !file.path || byPath.has(file.path)) continue;
    byPath.set(file.path, { path: file.path, size: file.type === 'commit' ? null : fileBytes(file.size) });
  }
  const entries = [...byPath.values()].sort(comparePath);
  const known = entries.filter(file => file.size !== null);
  const knownBytes = known.reduce((sum, file) => sum + file.size, 0);
  const unknownFiles = entries.length - known.length;
  const full = Boolean(complete) && !unknownFiles;
  return {
    sha, ...(treeSha ? { treeSha } : {}),
    files: selectedPaths ? entries.filter(file => selectedPaths.has(file.path)) : entries,
    totalBytes: full ? knownBytes : null, knownBytes,
    fileCount: entries.length, knownFiles: known.length, unknownFiles, complete: full,
  };
}

/** Public totals exclude per-path snapshot data, while preserving partial coverage. */
export function sizeSummary(snapshot) {
  const knownBytes = fileBytes(snapshot?.knownBytes) ?? 0;
  const fileCount = fileBytes(snapshot?.fileCount) ?? 0;
  const knownFiles = Math.min(fileCount, fileBytes(snapshot?.knownFiles) ?? 0);
  const unknownFiles = Math.max(fileCount - knownFiles, fileBytes(snapshot?.unknownFiles) ?? 0);
  const totalBytes = fileBytes(snapshot?.totalBytes);
  const complete = snapshot?.complete === true && unknownFiles === 0 && totalBytes !== null;
  return { totalBytes: complete ? totalBytes : null, knownBytes, fileCount, knownFiles, unknownFiles, complete };
}
