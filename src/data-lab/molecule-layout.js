export const FILE_ATOM_RADIUS = 1.20;
export const BACKBONE_ATOM_RADIUS = 1.60;
// These element identities and display radii are a visual vocabulary for file
// categories. They are not a chemical analysis, atomic-radius data or masses.
export const FILE_ATOM_KINDS = Object.freeze([
  Object.freeze({ id: 'code', label: 'Code & other files', color: 0x729be8, element: 'N', elementName: 'Nitrogen', radius: 1.20 }),
  Object.freeze({ id: 'data', label: 'Data & configuration', color: 0xe97d78, element: 'O', elementName: 'Oxygen', radius: 1.15 }),
  Object.freeze({ id: 'document', label: 'Documents', color: 0xede7dc, element: 'H', elementName: 'Hydrogen', radius: 0.75 }),
  Object.freeze({ id: 'asset', label: 'Images, media & fonts', color: 0xe8cc74, element: 'S', elementName: 'Sulfur', radius: 1.40 }),
]);

export function fileAtomKind(path) {
  const name = String(path || '').split('/').pop().toLowerCase();
  const extension = name.includes('.') ? name.split('.').pop() : '';
  if (/^(json|jsonc|json5|ya?ml|csv|tsv|toml|ini|conf|config|sql|xml|env|lock)$/.test(extension) || name === '.env') return FILE_ATOM_KINDS[1];
  if (/^(md|mdx|markdown|txt|rst|pdf|adoc|rtf|docx?|odt|license)$/.test(extension) || /^(license|licence|readme|changelog|authors|copying|notice)(\.|$)/.test(name)) return FILE_ATOM_KINDS[2];
  if (/^(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|mp[34]|m4a|wav|ogg|flac|webm|mov|ttf|otf|woff2?|eot|glb|gltf|obj|fbx)$/.test(extension)) return FILE_ATOM_KINDS[3];
  return FILE_ATOM_KINDS[0];
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const add = (a, b) => a.map((value, index) => value + b[index]);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const scale = (point, factor) => point.map(value => value * factor);
const distance = (a, b) => Math.hypot(...subtract(a, b));
const chainFor = path => {
  const chain = [];
  while (path) { chain.unshift(path); path = parentOf(path); }
  return chain;
};

function selectFiles(model, maxNodes) {
  const source = [...(model.nodes || [])].sort((a, b) => compare(a.id, b.id));
  const byId = new Map(source.map(node => [node.id, node]));
  const recent = new Set();
  for (const commit of [...(model.commits || [])].reverse()) {
    for (const change of commit.changes || []) if (byId.has(change.id)) recent.add(change.id);
  }
  const cap = Number.isFinite(Number(maxNodes)) ? Math.max(0, Math.floor(Number(maxNodes))) : 500;
  return {
    totalCount: source.length,
    chosen: [...recent, ...source.filter(node => !recent.has(node.id)).map(node => node.id)]
      .slice(0, cap).map(id => byId.get(id)).sort((a, b) => compare(a.id, b.id)),
  };
}

// One layout for every containment level: files and subfolders share the same
// downward spread used by the repository root. Subtree footprints reserve room
// for descendants; file leaves reserve the largest element radius across types.
function packChildren(children) {
  if (!children.length) return { placements: [], width: 0, depth: 0, drop: 0 };
  const gap = 7;
  const totalArea = children.reduce((sum, child) => sum + (child.width + gap) * (child.depth + gap), 0);
  const targetWidth = Math.max(...children.map(child => child.width), Math.sqrt(totalArea) * 1.35);
  const rows = [];
  let row = { items: [], width: 0, depth: 0 };
  for (const child of children) {
    if (row.items.length && row.width + gap + child.width > targetWidth) { rows.push(row); row = { items: [], width: 0, depth: 0 }; }
    row.items.push(child);
    row.width += (row.items.length > 1 ? gap : 0) + child.width;
    row.depth = Math.max(row.depth, child.depth);
  }
  if (row.items.length) rows.push(row);
  // Balance the shelves by occupied width so a nearly empty last row does not
  // leave a detached-looking child. This rule also applies at the root.
  const rowCount = rows.length;
  rows.length = 0;
  let cursor = 0, remainingWidth = children.reduce((sum, child) => sum + child.width + gap, 0);
  for (let index = 0; index < rowCount; index++) {
    const rowsLeft = rowCount - index, target = remainingWidth / rowsLeft;
    const items = [];
    let occupied = 0;
    while (cursor < children.length) {
      const child = children[cursor], next = child.width + gap;
      const reserve = children.length - cursor === rowsLeft - 1;
      if (items.length && rowsLeft > 1 && (reserve || Math.abs(occupied - target) < Math.abs(occupied + next - target))) break;
      items.push(child); occupied += next; cursor++;
      if (rowsLeft > 1 && occupied >= target) break;
    }
    remainingWidth -= occupied;
    rows.push({ items, width: occupied - gap, depth: Math.max(...items.map(child => child.depth)) });
  }
  const width = Math.max(...rows.map(item => item.width));
  const depth = rows.reduce((sum, item) => sum + item.depth, 0) + gap * (rows.length - 1);
  const placements = [];
  let z = -depth / 2;
  for (const item of rows) {
    let x = -item.width / 2;
    for (const child of item.items) {
      placements.push({ child, x: x + child.width / 2, z: z + item.depth / 2 });
      x += child.width + gap;
    }
    z += item.depth + gap;
  }
  const spread = Math.max(...placements.map(child => Math.hypot(child.x, child.z)));
  return { placements, width, depth, drop: Math.max(8, spread * 0.55 + 4) };
}

/**
 * Exact containment mapping: one carbon atom per real folder (including the
 * repository root), one typed atom per file, and only direct parent/file bonds.
 * Atom counts follow the repository, not chemistry. Carbon degree and bond
 * length are unconstrained so a wide folder remains exactly one carbon.
 */
export function buildMolecularTree(model, { maxNodes = 500 } = {}) {
  const { chosen, totalCount } = selectFiles(model, maxNodes);
  const directoryMembers = new Map([['', new Set()]]);
  const addDirectory = path => {
    while (!directoryMembers.has(path)) { directoryMembers.set(path, new Set()); path = parentOf(path); }
  };
  for (const node of chosen) {
    for (const path of new Set([node.path, ...(node.aliases || [])].filter(path => typeof path === 'string'))) {
      const folder = parentOf(path);
      addDirectory(folder); directoryMembers.get(folder).add(node.id);
    }
  }
  const folders = [...directoryMembers].sort(([a], [b]) => compare(a, b)).map(([path, members]) => {
    const id = `folder:${encodeURIComponent(path)}`;
    return {
      path, name: path.split('/').pop() || model.repository?.name || 'Repository',
      parent: path ? parentOf(path) : null, depth: path ? path.split('/').length : 0,
      memberIds: [...members].sort(compare), directFiles: members.size, count: 0,
      position: [0, 0, 0], radius: BACKBONE_ATOM_RADIUS, children: [],
      backboneIds: [id], carbonIds: [id], anchorId: id,
    };
  });
  const folderByPath = new Map(folders.map(folder => [folder.path, folder]));
  for (const folder of folders) if (folder.parent !== null) folderByPath.get(folder.parent).children.push(folder.path);
  const measured = new Map();
  const fileRadius = Math.max(...FILE_ATOM_KINDS.map(kind => kind.radius));
  const measure = folder => {
    const directories = folder.children.map(path => measure(folderByPath.get(path)));
    const files = folder.memberIds.map(id => ({ kind: 'file', id, width: fileRadius * 2, depth: fileRadius * 2 }));
    const packing = packChildren([...directories, ...files]), members = new Set(folder.memberIds);
    for (const child of directories) for (const id of child.members) members.add(id);
    folder.count = members.size;
    const result = {
      kind: 'folder', path: folder.path, packing, members,
      width: Math.max(BACKBONE_ATOM_RADIUS * 2, packing.width) + 8,
      depth: Math.max(BACKBONE_ATOM_RADIUS * 2, packing.depth) + 8,
    };
    measured.set(folder.path, result);
    return result;
  };
  measure(folderByPath.get(''));
  const folderSlots = new Map(), fileAttachments = new Map();
  const place = (folder, position) => {
    folder.position = position;
    const { packing } = measured.get(folder.path), slots = new Map();
    folderSlots.set(folder.path, slots);
    fileAttachments.set(folder.path, new Map(folder.memberIds.map(id => [id, { backboneId: folder.anchorId }])));
    folder.radius = BACKBONE_ATOM_RADIUS;
    for (const placement of packing.placements) {
      const { child, x, z } = placement;
      const childPosition = add(position, [x, -packing.drop, z]);
      if (child.kind === 'folder') place(folderByPath.get(child.path), childPosition);
      else {
        slots.set(child.id, childPosition);
        folder.radius = Math.max(folder.radius, distance(position, childPosition) + fileRadius);
      }
    }
  };
  place(folderByPath.get(''), [0, 0, 0]);
  const points = [...folders.map(folder => folder.position), ...[...folderSlots.values()].flatMap(slots => [...slots.values()])];
  const rawMin = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis])));
  const rawMax = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])));
  const origin = scale(add(rawMin, rawMax), 0.5);
  for (const folder of folders) folder.position = subtract(folder.position, origin);
  for (const slots of folderSlots.values()) for (const [id, point] of slots) slots.set(id, subtract(point, origin));
  const backboneAtoms = folders.map(folder => ({
    id: folder.anchorId, folder: folder.path, element: 'C', radius: BACKBONE_ATOM_RADIUS, position: folder.position,
  }));
  const backboneById = new Map(backboneAtoms.map(atom => [atom.id, atom]));
  const bonds = folders.filter(folder => folder.parent !== null).map(folder => {
    const parent = folderByPath.get(folder.parent);
    return {
      kind: 'folder', a: parent.position, b: folder.position,
      aBackboneId: parent.anchorId, bBackboneId: folder.anchorId,
      aFileId: null, bFileId: null, folder: folder.path, parent: folder.parent,
    };
  });
  const nodes = chosen.map(node => {
    const folder = parentOf(node.path), kind = fileAtomKind(node.path);
    return {
      ...node, folder, chain: chainFor(folder), position: [...folderSlots.get(folder).get(node.id)],
      kind, type: kind.id, element: kind.element, radius: kind.radius, backboneId: folderByPath.get(folder).anchorId,
    };
  });
  const min = subtract(rawMin, origin).map(value => value - 3);
  const max = subtract(rawMax, origin).map(value => value + 3);
  const extent = Math.max(...points.map(point => distance(point, origin))) + 3;
  return {
    nodes, folders, nodeById: new Map(nodes.map(node => [node.id, node])), folderByPath, folderSlots, fileAttachments,
    backboneAtoms, backboneById, bonds,
    totalCount, mappedCount: nodes.length, center: [0, 0, 0], bounds: { min, max }, extent,
  };
}

/** Current paths select one reserved attachment and one type for each file. */
export function molecularTreeState(graph, activeIds, paths = {}) {
  const active = activeIds === undefined ? new Set(graph.nodes.map(node => node.id)) : activeIds instanceof Set ? activeIds : new Set(activeIds || []);
  const pathFor = id => paths instanceof Map ? paths.get(id) : paths[id];
  const nodes = graph.nodes.map(node => {
    const path = typeof pathFor(node.id) === 'string' ? pathFor(node.id) : node.path;
    const folder = parentOf(path), kind = fileAtomKind(path);
    const slot = graph.folderSlots.get(folder)?.get(node.id);
    if (!slot) throw new Error(`No molecular attachment exists for ${path}. Rebuild the layout with this file alias.`);
    return {
      ...node, path, name: path.split('/').pop(), folder, chain: chainFor(folder), position: [...slot],
      kind, type: kind.id, element: kind.element, radius: kind.radius, exists: active.has(node.id),
      backboneId: graph.fileAttachments.get(folder).get(node.id).backboneId,
    };
  });
  const atoms = nodes.filter(node => node.exists), ghosts = nodes.filter(node => !node.exists);
  const members = new Map(), folderIds = new Set(['']), totalCounts = new Map([['', 0]]);
  for (const atom of atoms) {
    if (!members.has(atom.folder)) members.set(atom.folder, []);
    members.get(atom.folder).push(atom);
    let path = atom.folder;
    while (path !== null) {
      folderIds.add(path); totalCounts.set(path, (totalCounts.get(path) || 0) + 1);
      path = graph.folderByPath.get(path).parent;
    }
  }
  const folders = graph.folders.filter(folder => folderIds.has(folder.path)).map(folder => ({
    ...folder, directCount: members.get(folder.path)?.length || 0, totalCount: totalCounts.get(folder.path) || 0,
  }));
  const backboneAtoms = graph.backboneAtoms.filter(atom => folderIds.has(atom.folder));
  const backboneIds = new Set(backboneAtoms.map(atom => atom.id));
  const carbonBonds = graph.bonds.filter(bond => backboneIds.has(bond.aBackboneId) && backboneIds.has(bond.bBackboneId));
  const bonds = [...carbonBonds, ...atoms.map(atom => ({
    kind: 'membership', a: graph.backboneById.get(atom.backboneId).position, b: atom.position,
    aBackboneId: atom.backboneId, bBackboneId: null, aFileId: null, bFileId: atom.id, fileId: atom.id, folder: atom.folder,
  }))];
  const typeCounts = Object.fromEntries(FILE_ATOM_KINDS.map(kind => [kind.id, atoms.filter(atom => atom.type === kind.id).length]));
  return {
    nodes, atoms, ghosts, folders, folderIds, backboneAtoms, backboneIds, backboneCount: backboneAtoms.length, bonds,
    atomCount: atoms.length, moleculeCount: folders.length, folderBondCount: carbonBonds.filter(bond => bond.kind === 'folder').length, typeCounts,
  };
}
