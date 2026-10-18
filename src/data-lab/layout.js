// Pure repository containment layout. Commit playback never changes coordinates.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map(v => v * s);
const normal = a => scale(a, 1 / (Math.hypot(...a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function createRepositoryLayout(model, { maxNodes = 500, maxFolders = 42 } = {}) {
  const source = [...(model.nodes || [])].sort((a, b) => compare(a.id, b.id));
  const byId = new Map(source.map(node => [node.id, node]));
  const changed = new Set();
  for (const commit of [...(model.commits || [])].reverse()) {
    for (const change of commit.changes || []) if (byId.has(change.id)) changed.add(change.id);
  }
  const chosen = [...changed, ...source.filter(node => !changed.has(node.id)).map(node => node.id)]
    .slice(0, Math.max(1, maxNodes)).map(id => byId.get(id)).sort((a, b) => compare(a.id, b.id));
  const counts = new Map();
  for (const node of chosen) {
    const parts = String(node.path).split('/').slice(0, -1);
    for (let depth = 1; depth <= Math.min(3, parts.length); depth++) {
      const path = parts.slice(0, depth).join('/');
      counts.set(path, (counts.get(path) || 0) + 1);
    }
  }
  // Keep ancestors of every visible group; deeper paths fold into their nearest
  // visible ancestor, never into invented dependency clusters.
  const visible = new Set(['']);
  const ranked = [...counts].sort(([a, na], [b, nb]) => {
    const da = a.split('/').length, db = b.split('/').length;
    return (da === 1 ? 0 : 1) - (db === 1 ? 0 : 1) || nb - na || da - db || compare(a, b);
  });
  for (const [path] of ranked) {
    const missing = [];
    let ancestor = path;
    while (!visible.has(ancestor)) { missing.unshift(ancestor); ancestor = parentOf(ancestor); }
    if (visible.size + missing.length <= maxFolders + 1) for (const part of missing) visible.add(part);
  }
  const folders = [...visible].sort(compare).map(path => ({
    path, name: path.split('/').pop() || model.repository?.name || 'Repository',
    parent: path ? parentOf(path) : null, depth: path ? path.split('/').length : 0,
    count: counts.get(path) || chosen.length, position: [0, 0, 0], children: [], files: [],
  }));
  const folderByPath = new Map(folders.map(folder => [folder.path, folder]));
  for (const folder of folders) if (folder.parent !== null) folderByPath.get(folder.parent).children.push(folder.path);
  for (const node of chosen) {
    let path = parentOf(node.path);
    while (!visible.has(path)) path = parentOf(path);
    folderByPath.get(path).files.push(node);
  }
  const placeChildren = folder => {
    const count = folder.children.length;
    const direction = folder.depth ? normal(folder.position) : [0, 0, 1];
    const tangent = normal(cross(direction, Math.abs(direction[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const bitangent = normal(cross(direction, tangent));
    folder.children.forEach((path, index) => {
      const child = folderByPath.get(path);
      if (!folder.depth) {
        // Equal-area sphere distribution gives each top-level module a distinct
        // volume. The hierarchy, rather than animation, determines the depth.
        const y = 1 - 2 * (index + 0.5) / Math.max(count, 1);
        const a = index * GOLDEN_ANGLE + 0.6;
        const radial = Math.sqrt(1 - y * y);
        const distance = count === 1 ? 14 : Math.min(42, 27 + Math.sqrt(count) * 2.2);
        child.position = [Math.cos(a) * radial * distance, y * distance * 0.82, Math.sin(a) * radial * distance];
      } else {
        const a = index * GOLDEN_ANGLE + stableHash(folder.path) / 4294967295 * Math.PI * 2;
        const spread = count === 1 ? 4 : 10 + Math.sqrt(count) * 1.2;
        const along = 13 + (folder.depth === 1 ? 2 : 0);
        child.position = add(folder.position, add(scale(direction, along), add(scale(tangent, Math.cos(a) * spread), scale(bitangent, Math.sin(a) * spread))));
      }
      placeChildren(child);
    });
  };
  placeChildren(folderByPath.get(''));
  const nodes = [];
  for (const folder of folders) {
    const members = folder.files;
    const radius = Math.max(folder.depth ? 6 : 7, Math.min(18, 4.5 + Math.cbrt(members.length) * 1.7));
    members.forEach((node, index) => {
      const y = 1 - 2 * (index + 0.5) / Math.max(members.length, 1);
      const angle = index * GOLDEN_ANGLE + stableHash(folder.path) / 4294967295 * Math.PI * 2;
      const radial = Math.sqrt(1 - y * y);
      const shell = radius * (0.83 + (stableHash(node.id) % 100) / 600);
      const position = add(folder.position, [Math.cos(angle) * radial * shell, y * shell, Math.sin(angle) * radial * shell]);
      const chain = [];
      let path = folder.path;
      while (path) { chain.unshift(path); path = parentOf(path); }
      nodes.push({ ...node, folder: folder.path, chain, position });
    });
  }
  const extent = Math.max(16, ...nodes.map(node => Math.hypot(...node.position) + 3), ...folders.map(folder => Math.hypot(...folder.position) + 4));
  return { nodes, folders: folders.map(({ files, children, ...folder }) => ({ ...folder, directFiles: files.length })), extent, totalCount: source.length };
}
