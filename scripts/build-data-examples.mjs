#!/usr/bin/env node
// Build metadata-only example snapshots from precloned, public bare repositories.
// This script reads Git objects; it never checks out or executes repository code.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAuthorProfile } from '../src/data-lab/author-profile.js';
import { createSizeSnapshot } from '../src/data-lab/size-history.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Account identities cannot be recovered from Git author names. This checked-in
// map records GitHub's author for exact SHAs; unknown future commits stay null.
const verifiedAuthors = JSON.parse(readFileSync(resolve(root, 'src/data-lab/examples/author-profiles.json'), 'utf8'));
const definitions = [
  { name: 'xo', fullName: 'quirq-ai/xo' },
  { name: 'xo-space', fullName: 'quirq-ai/xo-space' },
];
const options = {
  cacheDir: resolve(root, '../.workspace-cache/observatory-examples'),
  outputDir: resolve(root, 'src/data-lab/examples'),
  limit: 50,
  capturedAt: new Date().toISOString(),
  refs: { xo: 'refs/heads/main', 'xo-space': 'refs/heads/main' },
};
const usage = `Usage: node scripts/build-data-examples.mjs [options]

Reads xo.git and xo-space.git bare clones from the cache directory.
No network requests, checkout, source execution or credentials are used.

  --cache-dir PATH       Clone directory (default: ../.workspace-cache/observatory-examples)
  --output-dir PATH      JSON destination (default: src/data-lab/examples)
  --limit NUMBER         First-parent commit count, 1–50 (default: 50)
  --captured-at ISO       Recorded snapshot time; reuse for reproducible output
  --xo-ref REF           Pinned XO commit/ref (default: refs/heads/main)
  --xo-space-ref REF     Pinned XO Space commit/ref (default: refs/heads/main)

Create clones first, or fetch main into the existing bare clones before refreshing:
  git clone --bare --depth=64 --single-branch --branch main https://github.com/quirq-ai/xo.git <cache>/xo.git
  git clone --bare --depth=64 --single-branch --branch main https://github.com/quirq-ai/xo-space.git <cache>/xo-space.git
  git -C <cache>/xo.git fetch --depth=64 origin main:refs/heads/main
  git -C <cache>/xo-space.git fetch --depth=64 origin main:refs/heads/main

If the first-parent boundary is shallow, deepen the relevant clone before rerunning.
`;
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--help' || flag === '-h') { console.log(usage); process.exit(0); }
  const value = process.argv[++index];
  if (!value) throw new Error(`Missing value for ${flag}.\n${usage}`);
  if (flag === '--cache-dir') options.cacheDir = resolve(value);
  else if (flag === '--output-dir') options.outputDir = resolve(value);
  else if (flag === '--limit') options.limit = Number(value);
  else if (flag === '--captured-at') options.capturedAt = value;
  else if (flag === '--xo-ref') options.refs.xo = value;
  else if (flag === '--xo-space-ref') options.refs['xo-space'] = value;
  else throw new Error(`Unknown option ${flag}.\n${usage}`);
}
assert(Number.isInteger(options.limit) && options.limit >= 1 && options.limit <= 50, 'Commit limit must be an integer between 1 and 50.');
assert(Number.isFinite(Date.parse(options.capturedAt)), 'The captured-at timestamp must be a valid ISO date.');
options.capturedAt = new Date(options.capturedAt).toISOString();

function git(directory, ...args) {
  return execFileSync('git', [
    '-c', `core.hooksPath=${devNull}`, '-c', 'diff.renameLimit=0',
    '-C', directory, ...args,
  ], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull },
  });
}
const splitZero = text => text.split('\0').filter((_, index, list) => index !== list.length - 1 || list[index]);
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const treeCache = new Map();
function readTree(directory, ref) {
  const key = `${directory}\0${ref}`;
  if (treeCache.has(key)) return treeCache.get(key);
  const files = splitZero(git(directory, 'ls-tree', '-r', '-l', '-z', ref)).map(record => {
    const tab = record.indexOf('\t');
    const [mode, type, sha, size] = record.slice(0, tab).trim().split(/\s+/);
    assert(tab > 0 && ['blob', 'commit'].includes(type), `Unexpected tree entry at ${ref}.`);
    return { path: record.slice(tab + 1), mode, type, sha, ...(size !== '-' ? { size: Number(size) } : {}) };
  });
  treeCache.set(key, files);
  return files;
}

function readDiff(directory, sha, parent) {
  const args = [
    'diff-tree', '--no-commit-id', '-r', '-z', '--no-ext-diff', '--no-textconv', '--no-color',
    '--no-relative', '--find-renames=50%', '--diff-algorithm=myers', '--no-indent-heuristic',
    '--ignore-submodules=none', ...(parent ? [parent, sha] : ['--root', sha]),
  ];
  const statuses = splitZero(git(directory, ...args, '--name-status'));
  const stats = splitZero(git(directory, ...args, '--numstat'));
  const counts = new Map();
  for (let index = 0; index < stats.length; index++) {
    const record = stats[index];
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    assert(firstTab >= 0 && secondTab > firstTab, `Invalid numstat for ${sha}.`);
    const added = record.slice(0, firstTab);
    const removed = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    let previousPath;
    if (path === '') { previousPath = stats[++index]; path = stats[++index]; }
    const binary = added === '-' || removed === '-';
    assert(binary || (/^\d+$/.test(added) && /^\d+$/.test(removed)), `Invalid line counts for ${sha}.`);
    assert(path && !counts.has(path), `Duplicate or missing numstat path for ${sha}.`);
    counts.set(path, {
      additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(removed),
      ...(binary ? { binary: true } : {}), ...(previousPath ? { previousPath } : {}),
    });
  }
  const names = { A: 'added', D: 'removed', M: 'modified', R: 'renamed', C: 'copied', T: 'changed' };
  const files = [];
  for (let index = 0; index < statuses.length; index++) {
    const code = statuses[index][0];
    const status = names[code];
    assert(status, `Unsupported change status ${statuses[index]} for ${sha}.`);
    const source = statuses[++index];
    const path = code === 'R' || code === 'C' ? statuses[++index] : source;
    const countsForPath = counts.get(path);
    assert(path && countsForPath, `Missing diff statistics for ${path} at ${sha}.`);
    if (code === 'R' || code === 'C') assert.equal(countsForPath.previousPath, source, `Rename source mismatch for ${path}.`);
    files.push({ path, status, ...countsForPath });
    counts.delete(path);
  }
  assert.equal(counts.size, 0, `Unexpected extra numstat entries for ${sha}.`);
  return files.sort(byPath);
}

function buildSnapshot(definition) {
  const { name, fullName } = definition;
  const url = `https://github.com/${fullName}`;
  const directory = resolve(options.cacheDir, `${name}.git`);
  assert(existsSync(directory), `Missing bare clone: ${directory}. See --help for clone commands.`);
  assert.equal(git(directory, 'rev-parse', '--is-bare-repository').trim(), 'true', `${directory} must be a bare clone.`);
  assert.equal(git(directory, 'remote', 'get-url', 'origin').trim().replace(/\.git$/, ''), url, 'Clone remote does not match the requested public example.');
  const requestedRef = options.refs[name];
  const headSha = git(directory, 'rev-parse', '--verify', '--end-of-options', `${requestedRef}^{commit}`).trim();
  const treeSha = git(directory, 'rev-parse', `${headSha}^{tree}`).trim();
  const ancestry = git(directory, 'rev-list', '--first-parent', `--max-count=${options.limit + 1}`, headSha).trim().split('\n');
  const selected = ancestry.slice(0, options.limit);
  const shallowFile = resolve(directory, 'shallow');
  const shallow = new Set(existsSync(shallowFile) ? readFileSync(shallowFile, 'utf8').trim().split('\n') : []);
  assert(!selected.some(sha => shallow.has(sha)), `The ${name} snapshot reaches a shallow boundary. Deepen the clone, then retry; do not treat that boundary as a root.`);
  const commits = selected.map(sha => {
    const fields = git(directory, 'show', '-s', '--format=%H%x00%P%x00%an%x00%cI%x00%T%x00%B', sha).split('\0');
    assert.equal(fields[0], sha);
    const parents = fields[1].split(' ').filter(Boolean);
    const authorLogin = verifiedAuthors.repositories[fullName]?.commits[sha];
    const authorProfile = normalizeAuthorProfile(verifiedAuthors.profiles[authorLogin]);
    return {
      sha, treeSha: fields[4], message: fields.slice(5).join('\0').trimEnd(), author: fields[2], date: fields[3],
      authorProfile,
      url: `${url}/commit/${sha}`, isMerge: parents.length > 1, partial: false,
      firstParent: parents[0] || null,
      files: readDiff(directory, sha, parents[0]),
    };
  }).reverse();
  const boundarySha = commits[0].firstParent;
  if (boundarySha) assert.equal(ancestry[commits.length], boundarySha, 'Missing first-parent boundary commit.');
  for (let index = 1; index < commits.length; index++) assert.equal(commits[index].firstParent, commits[index - 1].sha, 'Commit sequence is not first-parent chronological order.');

  const headFiles = readTree(directory, headSha);
  const headPaths = new Set(headFiles.map(file => file.path));
  const selectedPaths = new Set(headPaths);
  for (const commit of commits) for (const file of commit.files) {
    selectedPaths.add(file.path);
    if (file.previousPath) selectedPaths.add(file.previousPath);
  }
  // Give historical-only paths their last available size while keeping head membership exact.
  const sizeByPath = new Map(headFiles.map(file => [file.path, file.size]));
  for (const ref of [...selected.slice(1), ...(boundarySha ? [boundarySha] : [])]) {
    for (const file of readTree(directory, ref)) {
      if (selectedPaths.has(file.path) && !sizeByPath.has(file.path)) sizeByPath.set(file.path, file.size);
    }
  }
  const files = [...selectedPaths].sort().map(path => ({
    path, ...(Number.isFinite(sizeByPath.get(path)) ? { size: sizeByPath.get(path) } : {}), existsAtHead: headPaths.has(path),
  }));
  const binaryChanges = commits.reduce((sum, commit) => sum + commit.files.filter(file => file.binary).length, 0);
  const limitations = [
    'Bundled snapshot from a precloned public repository. It loads locally and does not update from GitHub automatically.',
    boundarySha
      ? 'The snapshot follows recent first-parent history; earlier history and side-branch commits are not replayed separately.'
      : 'The snapshot follows the repository’s complete first-parent history; side-branch commits are not replayed separately.',
  ];
  if (commits.some(commit => commit.isMerge)) limitations.push('Merge activity is the net change from its first parent.');
  if (binaryChanges) limitations.push('Binary changes are included with binary: true. Their additions and deletions are zero because Git does not provide line counts for binary data.');
  if (headFiles.some(file => file.type === 'commit')) limitations.push('Submodules are shown as repository entries; their internal history is not loaded.');
  limitations.push('Line additions and deletions describe Git diffs; they do not measure runtime behavior, code quality or individual productivity.');
  const sizeHistory = {
    version: 1,
    baseline: createSizeSnapshot(boundarySha ? readTree(directory, boundarySha) : [], { sha: boundarySha, selectedPaths }),
    commits: commits.map(commit => createSizeSnapshot(readTree(directory, commit.sha), { sha: commit.sha, treeSha: commit.treeSha, selectedPaths })),
  };
  const dataset = {
    repository: { name, fullName, url, branch: 'main', source: 'example', headSha, treeSha, capturedAt: options.capturedAt },
    files, commits,
    sizeHistory,
    coverage: { label: `${commits.length} first-parent commits · bundled snapshot · pinned ${headSha.slice(0, 7)}`, limitations },
    provenance: {
      formatVersion: 2, generator: 'scripts/build-data-examples.mjs', source: 'local bare Git clone',
      remote: `${url}.git`, branchRef: 'refs/heads/main', headSha, treeSha,
      capturedAt: options.capturedAt, firstParentBoundarySha: boundarySha,
      commitCount: commits.length, headFileCount: headFiles.length, historicalPathCount: files.length - headFiles.length,
      changedFileCount: commits.reduce((sum, commit) => sum + commit.files.length, 0), binaryChangeCount: binaryChanges,
      completeHeadTree: true, completeCommitDiffs: true, completeSizeHistory: [sizeHistory.baseline, ...sizeHistory.commits].every(snapshot => snapshot.complete),
      diff: { parent: 'first', renameThreshold: '50%', algorithm: 'myers', indentHeuristic: false },
    },
  };
  assert.equal(dataset.files.filter(file => file.existsAtHead).length, headFiles.length);
  return dataset;
}

// Validate both snapshots before replacing either output.
const snapshots = definitions.map(buildSnapshot);
mkdirSync(options.outputDir, { recursive: true });
for (const dataset of snapshots) {
  const path = resolve(options.outputDir, `${dataset.repository.name}.json`);
  const json = `${JSON.stringify(dataset, null, 2)}\n`;
  writeFileSync(path, json);
  console.log(JSON.stringify({ file: path, bytes: Buffer.byteLength(json), ...dataset.provenance }));
}
