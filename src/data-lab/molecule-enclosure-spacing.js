import { buildFolderEnclosures } from './molecule-enclosures.js';
import { BACKBONE_ATOM_RADIUS, FILE_ATOM_KINDS, fileAtomKind } from './molecule-layout.js';

const GAP = 3;
const FILE_MARGIN = 1;
const inSubtree = (path, root) => root === '' || path === root || path.startsWith(`${root}/`);
const distanceXZ = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/**
 * Give sibling folder environments room without changing a single vertical
 * tier. The existing mixed file/folder ordering and directions stay intact:
 * each parent's child offsets receive one uniform horizontal scale.
 */
export function spaceFolderEnclosures(graph) {
  if (!graph?.folders?.length) return graph;
  const fileRadii = new Map(graph.nodes.map(node => [node.id, Math.max(
    node.radius || 0,
    ...[node.path, ...(node.aliases || [])].map(path => fileAtomKind(path).radius),
  )]));
  const reservedAtoms = [...graph.folderSlots].flatMap(([folder, slots]) => [...slots].map(([id, position]) => ({
    id, folder, position, radius: fileRadii.get(id),
  })));
  const deepestFirst = [...graph.folders].sort((a, b) => b.depth - a.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const translateFolder = (path, dx, dz) => {
    const points = new Set();
    for (const folder of graph.folders) if (inSubtree(folder.path, path)) points.add(folder.position);
    for (const atom of graph.backboneAtoms) if (inSubtree(atom.folder, path)) points.add(atom.position);
    for (const [folder, slots] of graph.folderSlots) if (inSubtree(folder, path)) for (const position of slots.values()) points.add(position);
    for (const node of graph.nodes) if (inSubtree(node.folder, path)) points.add(node.position);
    for (const position of points) { position[0] += dx; position[2] += dz; }
  };

  for (const parent of deepestFirst) {
    const directories = parent.children.map(path => graph.folderByPath.get(path));
    const files = [...graph.folderSlots.get(parent.path)];
    if (directories.length + files.length < 2) continue;

    // Only descendants are needed to measure this parent's child footprints.
    // A file-only group requires no enclosure rebuild, and one-child chains
    // never gain extra spacing.
    let enclosures = new Map();
    if (directories.length) {
      const belowParent = path => path !== parent.path && inSubtree(path, parent.path);
      enclosures = new Map(buildFolderEnclosures(graph, {
        folders: graph.folders.filter(folder => belowParent(folder.path)),
        backboneAtoms: graph.backboneAtoms.filter(atom => belowParent(atom.folder)),
        atoms: reservedAtoms.filter(atom => belowParent(atom.folder)),
      }).map(record => [record.folder, record]));
    }
    const children = [
      ...directories.map(folder => ({ folder: folder.path, position: folder.position, radius: enclosures.get(folder.path).radiusX })),
      ...files.map(([id, position]) => ({ id, position, radius: fileRadii.get(id) + FILE_MARGIN })),
    ];
    let scale = 1;
    for (let a = 0; a < children.length; a++) for (let b = a + 1; b < children.length; b++) {
      const distance = distanceXZ(children[a].position, children[b].position);
      // buildMolecularTree gives every pair a distinct horizontal attachment.
      // Keeping its directions rules out inventing an offset for coincidence.
      if (distance <= 1e-12) throw new Error('Folder spacing requires distinct sibling attachments.');
      scale = Math.max(scale, (children[a].radius + children[b].radius + GAP) / distance);
    }
    if (scale <= 1 + 1e-9) continue;
    scale *= 1 + 1e-10;
    for (const child of children) {
      const dx = (child.position[0] - parent.position[0]) * (scale - 1);
      const dz = (child.position[2] - parent.position[2]) * (scale - 1);
      if (child.folder !== undefined) translateFolder(child.folder, dx, dz);
      else {
        const points = new Set([child.position]);
        const node = graph.nodeById.get(child.id);
        if (node.folder === parent.path) points.add(node.position);
        for (const point of points) { point[0] += dx; point[2] += dz; }
      }
    }
  }

  // Keep canonical records, aliases and bond endpoints coherent even if a
  // caller supplied copied arrays instead of the layout's shared references.
  const maxFileRadius = Math.max(...FILE_ATOM_KINDS.map(kind => kind.radius));
  for (const folder of graph.folders) {
    graph.backboneById.get(folder.anchorId).position = folder.position;
    folder.radius = BACKBONE_ATOM_RADIUS;
    for (const position of graph.folderSlots.get(folder.path).values()) {
      folder.radius = Math.max(folder.radius, Math.hypot(...position.map((value, axis) => value - folder.position[axis])) + maxFileRadius);
    }
  }
  for (const node of graph.nodes) node.position = [...graph.folderSlots.get(node.folder).get(node.id)];
  for (const bond of graph.bonds) {
    bond.a = graph.backboneById.get(bond.aBackboneId).position;
    bond.b = graph.backboneById.get(bond.bBackboneId).position;
  }
  const points = [...graph.folders.map(folder => folder.position), ...[...graph.folderSlots.values()].flatMap(slots => [...slots.values()])];
  const min = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis])) - 3);
  const max = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])) + 3);
  graph.bounds = { min, max };
  graph.center = min.map((value, axis) => (value + max[axis]) / 2);
  graph.extent = Math.max(...points.map(point => Math.hypot(...point.map((value, axis) => value - graph.center[axis])))) + 3;
  return graph;
}
