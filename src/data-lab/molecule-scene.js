import * as THREE from 'three';
import { RepositoryScene } from './scene.js';
import { buildMolecularTree, molecularTreeState } from './molecule-layout.js';
import { buildActivityHistory, activityAt, activityLevel, membershipActivityKey } from './molecule-activity.js';

const DURATION = 1.6;
const UP = new THREE.Vector3(0, 1, 0);
const FOLDER_COLOR = new THREE.Color(0x50545d);
const BOND_COLOR = new THREE.Color(0xadb6c7);
const GOLD = new THREE.Color(0xffd19a);
const ease = value => value * value * (3 - 2 * value);
const asSet = value => value instanceof Set ? value : new Set(value || []);
const vector = value => new THREE.Vector3(...value);

/** One carbon atom per folder, connected to one terminal element atom per file. */
export class MoleculeScene extends RepositoryScene {
  constructor(stage, callbacks = {}) {
    super(stage, callbacks);
    this.group.name = 'Data Lab · Repository molecule';
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    this.geometries = {
      atom: new THREE.SphereGeometry(1, 24, 16),
      bond: new THREE.CylinderGeometry(1, 1, 1, 8),
    };
    for (const light of this.group.children.filter(child => child.isDirectionalLight && child.position.z < 0)) { light.color.setHex(0xb0c6e3); light.intensity = 1.9; }
    this.pools = {};
    this.matrix = new THREE.Matrix4();
    this.quaternion = new THREE.Quaternion();
    this.scale = new THREE.Vector3();
    this.midpoint = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.paint = new THREE.Color();
    this.frameIndex = null;
    this.birthIds = new Set();
    this.exitIds = new Set();
    this.moves = new Map();
    this.renderer.domElement.setAttribute('aria-label', 'Three-dimensional repository molecule. Each gray carbon atom is exactly one folder, connected to its actual parent folder. Each colored terminal atom is exactly one file: nitrogen for code, oxygen for data, hydrogen for documents, sulfur for assets. Drag to orbit, scroll to zoom, click a file atom to inspect it, or click a carbon to focus its folder.');
  }

  _pool(name, geometry, capacity, group, { ghost = false, fading = false, opacity = 1 } = {}) {
    const count = Math.max(1, capacity);
    // Instance attributes belong to each pool: sharing them would overwrite
    // another mesh's opacity when its visible records are compacted for focus.
    const instanceGeometry = geometry.clone();
    const opacityAttribute = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    const emissionAttribute = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    instanceGeometry.setAttribute('instanceOpacity', opacityAttribute);
    instanceGeometry.setAttribute('instanceEmission', emissionAttribute);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.23, transparent: true, opacity, depthWrite: false, wireframe: ghost });
    material.onBeforeCompile = shader => {
      shader.vertexShader = `attribute float instanceOpacity;
attribute float instanceEmission;
varying float vInstanceOpacity;
varying float vInstanceEmission;
${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>
vInstanceOpacity = instanceOpacity;
vInstanceEmission = instanceEmission;`);
      shader.fragmentShader = `varying float vInstanceOpacity;
varying float vInstanceEmission;
${shader.fragmentShader}`.replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.a *= vInstanceOpacity;`).replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vInstanceEmission;`);
    };
    material.customProgramCacheKey = () => 'repository-instance-activity-v1';
    const mesh = new THREE.InstancedMesh(instanceGeometry, material, count);
    mesh.name = name;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.pool = name;
    group.add(mesh);
    return this.pools[name] = { mesh, records: [], ghost, fading, opacityAttribute, emissionAttribute };
  }

  setModel(model) {
    this._clearWorld();
    this.model = model;
    this.graph = buildMolecularTree(model);
    this.activityHistory = buildActivityHistory(model, this.graph);
    this.activityState = activityAt(this.activityHistory, -1);
    this.activitySegments = [];
    this.currentSegmentKeys = new Set();
    this.currentExitIds = new Set();
    this.currentDistance = 1;
    this.activityElapsed = this.activityDuration = DURATION;
    this.activityPlaying = false;
    this.center = vector(this.graph.center || [0, 0, 0]);
    this.extent = this.graph.extent;
    this.renderedCount = this.graph.nodes.length;
    this.overviewAtoms = [
      ...this.graph.backboneAtoms,
      ...[...this.graph.folderSlots.values()].flatMap(slots => [...slots].map(([id, position]) => ({ position, radius: this.graph.nodeById.get(id).radius }))),
    ];
    this.frameKey = undefined;
    this.frameIndex = null;
    this.selectedId = null;
    this.birthIds = new Set();
    this.exitIds = new Set();
    this.moves = new Map();
    this.elapsed = this.duration = DURATION;
    this.activeIds = new Set(this.graph.nodes.map(node => node.id));
    this.changedIds = new Set();
    this.statuses = {};
    this.paths = {};
    for (const folder of this.graph.folders) {
      const position = vector(folder.position);
      this.folders.set(folder.path, { ...folder, position, color: FOLDER_COLOR.clone() });
      this._label(folder.path || model.repository?.name || 'Repository', position.clone().add(new THREE.Vector3(0, 2.3, 0)), folder.path ? '#bbc4d2' : '#dfc49a', folder.path);
    }
    const fileCapacity = this.graph.nodes.length, backboneCapacity = this.graph.backboneAtoms.length;
    this.atomMesh = this._pool('atoms', this.geometries.atom, fileCapacity, this.world).mesh;
    this._pool('ghostAtoms', this.geometries.atom, fileCapacity, this.world, { ghost: true });
    this._pool('exitAtoms', this.geometries.atom, fileCapacity, this.world, { fading: true });
    this.backboneMesh = this._pool('backbone', this.geometries.atom, backboneCapacity, this.world).mesh;
    this._pool('ghostBackbone', this.geometries.atom, backboneCapacity, this.world, { ghost: true });
    this._pool('backboneBonds', this.geometries.bond, backboneCapacity, this.linkGroup);
    this._pool('folderBonds', this.geometries.bond, backboneCapacity, this.linkGroup);
    this._pool('membershipBonds', this.geometries.bond, fileCapacity, this.linkGroup);
    this._pool('ghostBackboneBonds', this.geometries.bond, backboneCapacity, this.linkGroup, { ghost: true });
    this._pool('exitBonds', this.geometries.bond, fileCapacity * 2, this.linkGroup, { fading: true });
    const routeCapacity = backboneCapacity + [...this.graph.folderSlots.values()].reduce((sum, slots) => sum + slots.size, 0);
    this.currentMesh = this._pool('current', this.geometries.bond, routeCapacity, this.linkGroup).mesh;
    this.currentMesh.renderOrder = 2;
    this._pool('routeBonds', this.geometries.bond, routeCapacity, this.linkGroup);
    this._pool('currentExits', this.geometries.atom, fileCapacity, this.world, { fading: true });
    this.structure = molecularTreeState(this.graph, this.activeIds);
    this._prepareInstances();
    this._paintInstances();
    this.controls.maxDistance = Math.max(650, this.extent * 12);
    this.setOptions(this.options);
    this.resetView(true);
  }

  _prepareInstances(previous = null, previousPositions = new Map()) {
    this.layout = { ...this.graph, nodes: this.structure.nodes };
    this.nodes.clear();
    for (const node of this.structure.nodes) {
      this.nodes.set(node.id, { node, position: vector(node.position), color: new THREE.Color(node.kind.color), size: node.radius || 0.95, folder: this.folders.get(node.folder) });
    }
    const atoms = nodes => nodes.map(node => ({ ...node, record: this.nodes.get(node.id) }));
    this.pools.atoms.records = atoms(this.structure.atoms);
    this.pools.ghostAtoms.records = atoms(this.structure.ghosts);
    this.pools.exitAtoms.records = previous ? previous.atoms.filter(node => this.exitIds.has(node.id)).map(node => ({ ...node, record: { position: (previousPositions.get(node.id) || vector(node.position)).clone(), color: new THREE.Color(node.kind.color), size: node.radius || 0.95 } })) : [];
    this.pools.backbone.records = this.structure.backboneAtoms;
    this.pools.ghostBackbone.records = this.graph.backboneAtoms.filter(atom => !this.structure.backboneIds.has(atom.id));
    const bond = source => ({ ...source, start: vector(source.a), end: vector(source.b) });
    this.pools.backboneBonds.records = this.structure.bonds.filter(edge => edge.kind === 'backbone').map(bond);
    this.pools.folderBonds.records = this.structure.bonds.filter(edge => edge.kind === 'folder').map(bond);
    this.pools.membershipBonds.records = this.structure.bonds.filter(edge => edge.kind === 'membership').map(bond);
    this.pools.ghostBackboneBonds.records = this.graph.bonds.filter(edge => !this.structure.backboneIds.has(edge.aBackboneId) || !this.structure.backboneIds.has(edge.bBackboneId)).map(bond);
    this.pools.exitBonds.records = previous ? previous.bonds.filter(edge => edge.kind === 'membership' && (this.exitIds.has(edge.aFileId) || this.exitIds.has(edge.bFileId))).map(bond) : [];
    this.pickables = ['atoms', 'ghostAtoms', 'backbone', 'ghostBackbone'].map(name => this.pools[name].mesh);
    this.dirty = true;
  }

  setFrame({ visibleIds, changedIds, selectedId, statuses = {}, paths = {}, frameKey, duration = DURATION, index } = {}) {
    if (!this.graph) return;
    const frameChanged = this.frameKey !== frameKey || this.frameIndex !== (Number.isInteger(index) ? index : null);
    const next = visibleIds === undefined ? this.activeIds : asSet(visibleIds);
    const animate = this.frameKey !== frameKey && Number.isInteger(index) && this.frameIndex !== null && index === this.frameIndex + 1 && !this.reducedMotion && this.options.activity;
    const previous = this.structure;
    const previousPositions = new Map([...this.nodes].map(([id, record]) => [id, record.position.clone()]));
    this.birthIds = animate ? new Set([...next].filter(id => !this.activeIds.has(id))) : new Set();
    this.exitIds = animate ? new Set([...this.activeIds].filter(id => !next.has(id))) : new Set();
    this.activeIds = next;
    this.changedIds = asSet(changedIds);
    this.statuses = { ...statuses };
    this.paths = paths instanceof Map ? Object.fromEntries(paths) : { ...paths };
    this.frameKey = frameKey;
    this.frameIndex = Number.isInteger(index) ? index : null;
    this.duration = Math.max(0.08, Number(duration) || DURATION);
    this.elapsed = animate ? 0 : this.duration;
    this.structure = molecularTreeState(this.graph, this.activeIds, this.paths);
    this.moves = new Map();
    if (animate) for (const node of this.structure.atoms) {
      const from = previousPositions.get(node.id);
      if (from && !this.birthIds.has(node.id) && from.distanceToSquared(vector(node.position)) > 0.001) this.moves.set(node.id, from);
    }
    this.activityState = activityAt(this.activityHistory, this.frameIndex ?? -1);
    this._prepareCurrent();
    if (frameChanged) {
      this.activityDuration = Math.max(0.4, this.duration);
      this.activityPlaying = !this.reducedMotion && this.options.activity && this.activitySegments.length > 0;
      this.activityElapsed = this.activityPlaying ? 0 : this.activityDuration;
    }
    this._prepareInstances(animate ? previous : null, previousPositions);
    if (selectedId !== undefined) this.select(selectedId);
    this._paintInstances();
  }

  _paintInstances() {
    if (!this.graph) return;
    const progress = Math.min(1, this.elapsed / this.duration), growth = ease(progress);
    const highlight = this.hoveredId || this.selectedId;
    for (const name of ['atoms', 'ghostAtoms', 'exitAtoms']) {
      const pool = this.pools[name], { mesh } = pool;
      const records = pool.records.filter(atom => this._fileInFocus(atom) && !(pool.ghost && ((progress < 1 && this.exitIds.has(atom.id)) || (this.activityPlaying && this.options.activity && this.currentExitIds.has(atom.id)))));
      pool.visibleRecords = records;
      mesh.count = records.length;
      mesh.visible = (!pool.ghost || this.options.ghosts) && (!pool.fading || progress < 1);
      if (pool.fading) mesh.material.opacity = 1 - ease(Math.max(0, (progress - 0.72) / 0.28));
      records.forEach((atom, instance) => {
        const entering = !pool.ghost && !pool.fading && this.birthIds.has(atom.id) && progress < 1;
        const radius = atom.record.size * (entering ? Math.max(0.04, growth) : pool.fading ? 1 - growth * 0.7 : 1);
        if (!pool.fading) {
          atom.record.position.fromArray(atom.position);
          if (this.moves.has(atom.id) && progress < 1) atom.record.position.lerpVectors(this.moves.get(atom.id), vector(atom.position), growth);
        }
        this.matrix.makeScale(radius, radius, radius).setPosition(atom.record.position);
        mesh.setMatrixAt(instance, this.matrix);
        this.paint.copy(atom.record.color);
        if (pool.ghost) this.paint.lerp(FOLDER_COLOR, 0.5);
        else if (highlight && atom.id === highlight) this.paint.lerp(GOLD, 0.3);
        mesh.setColorAt(instance, this.paint);
        this._instanceLight(pool, instance, this.activityState.fileTouches.get(atom.id), this.options.activity && this.activityState.touchedFiles.has(atom.id), highlight === atom.id);
      });
      this._finishPool(pool);
    }
    for (const name of ['backbone', 'ghostBackbone']) {
      const pool = this.pools[name], { mesh } = pool;
      const records = pool.records.filter(atom => this._folderInFocus(atom.folder));
      pool.visibleRecords = records;
      mesh.count = records.length;
      mesh.visible = !pool.ghost || this.options.ghosts;
      records.forEach((atom, instance) => {
        const radius = atom.radius || 0.82;
        this.matrix.makeScale(radius, radius, radius).setPosition(vector(atom.position));
        mesh.setMatrixAt(instance, this.matrix);
        this.paint.copy(FOLDER_COLOR);
        if (pool.ghost) this.paint.setHex(0x8293ac);
        else if (this.focusedFolder !== null && atom.folder === this.focusedFolder) this.paint.lerp(GOLD, 0.35);
        mesh.setColorAt(instance, this.paint);
        this._instanceLight(pool, instance, this.activityState.folderTouches.get(atom.folder), this.options.activity && this.activityState.touchedFolders.has(atom.folder), this.focusedFolder === atom.folder);
      });
      this._finishPool(pool);
    }
    for (const name of ['backboneBonds', 'folderBonds', 'membershipBonds', 'ghostBackboneBonds', 'exitBonds']) {
      const pool = this.pools[name], { mesh } = pool;
      const records = pool.records.filter(bond => this._bondInFocus(bond));
      pool.visibleRecords = records;
      mesh.count = records.length;
      mesh.visible = this.options.links && (!pool.ghost || this.options.ghosts) && (!pool.fading || progress < 1);
      if (pool.fading) mesh.material.opacity = (1 - ease(Math.max(0, (progress - 0.72) / 0.28))) * 0.72;
      records.forEach((bond, instance) => {
        const start = !pool.fading && bond.aFileId ? this.nodes.get(bond.aFileId)?.position || bond.start : bond.start;
        const end = !pool.fading && bond.bFileId ? this.nodes.get(bond.bFileId)?.position || bond.end : bond.end;
        this.direction.subVectors(end, start);
        const length = this.direction.length();
        this.midpoint.copy(start).add(end).multiplyScalar(0.5);
        this.quaternion.setFromUnitVectors(UP, this.direction.normalize());
        const radius = bond.kind === 'membership' ? 0.14 : 0.16;
        this.scale.set(radius, Math.max(length, 0.0001), radius);
        this.matrix.compose(this.midpoint, this.quaternion, this.scale);
        mesh.setMatrixAt(instance, this.matrix);
        this.paint.copy(BOND_COLOR);
        if (highlight && (bond.aFileId === highlight || bond.bFileId === highlight)) this.paint.lerp(GOLD, 0.6);
        mesh.setColorAt(instance, this.paint);
        const key = this._bondActivityKey(bond);
        const touches = bond.kind === 'folder' ? this.activityState.folderBondTouches.get(bond.folder) : this.activityState.membershipTouches.get(membershipActivityKey(bond.folder, bond.bFileId || bond.aFileId));
        this._instanceLight(pool, instance, touches, this.options.activity && this.currentSegmentKeys.has(key), Boolean(highlight && (bond.aFileId === highlight || bond.bFileId === highlight)));
      });
      this._finishPool(pool);
    }
    this._paintCurrent();
    this.dirty = false;
    this.lastHighlight = highlight;
    this.lastProgress = progress;
  }

  _instanceLight(pool, instance, count = 0, current = false, selected = false) {
    const level = activityLevel(count || 0);
    const opacity = pool.ghost ? 0.08 + level * 0.12 : 0.27 + level * 0.68;
    pool.opacityAttribute.setX(instance, selected ? 1 : opacity);
    pool.emissionAttribute.setX(instance, pool.ghost ? 0.02 : 0.035 + level * 0.55 + (current ? 0.2 : 0) + (selected ? 0.35 : 0));
  }

  _bondActivityKey(bond) {
    return bond.kind === 'folder' ? `folder:${bond.folder}` : `membership:${membershipActivityKey(bond.folder, bond.bFileId || bond.aFileId)}`;
  }

  _bondInFocus(bond) {
    return this.focusedFolder == null || (bond.kind === 'folder' ? bond.parent === this.focusedFolder : bond.folder === this.focusedFolder);
  }

  _prepareCurrent() {
    const segments = new Map();
    this.currentDistance = 1;
    for (const route of this.activityState.routes) {
      let distance = 0;
      for (const segment of route.segments) {
        const start = vector(segment.a), end = vector(segment.b), length = start.distanceTo(end);
        const key = `${segment.kind}:${segment.key}`;
        if (!segments.has(key)) segments.set(key, { ...segment, activityKey: key, start, end, length, distance });
        distance += length;
      }
      this.currentDistance = Math.max(this.currentDistance, distance);
    }
    this.activitySegments = [...segments.values()];
    this.currentSegmentKeys = new Set(segments.keys());
    this.pools.current.records = this.activitySegments;
    const present = new Set(this.structure.bonds.map(bond => this._bondActivityKey(bond)));
    this.pools.routeBonds.records = this.activitySegments.filter(segment => !present.has(segment.activityKey));
    const removed = new Map();
    for (const route of this.activityState.routes) {
      if (route.status !== 'removed' || this.activeIds.has(route.fileId) || removed.has(route.fileId)) continue;
      const node = this.graph.nodeById.get(route.fileId);
      if (node) removed.set(route.fileId, { ...node, folder: route.folder, position: route.points.at(-1), activityKey: `membership:${membershipActivityKey(route.folder, route.fileId)}` });
    }
    this.pools.currentExits.records = [...removed.values()];
    this.currentExitIds = new Set(removed.keys());
  }

  _paintCurrent() {
    const pulse = this.pools.current, context = this.pools.routeBonds, exits = this.pools.currentExits;
    const progress = Math.min(1, this.activityElapsed / this.activityDuration);
    const tail = Math.max(2, this.currentDistance * 0.12);
    const headDistance = progress * (this.currentDistance + tail);
    const pulseRecords = [];
    for (const segment of pulse.records) {
      if (!this.activityPlaying || !this._bondInFocus(segment)) continue;
      const head = Math.min(segment.length, headDistance - segment.distance);
      const back = Math.max(0, headDistance - tail - segment.distance);
      if (head <= back || head < 0 || back >= segment.length) continue;
      const index = pulseRecords.length;
      this.direction.subVectors(segment.end, segment.start).normalize();
      this.midpoint.copy(segment.start).addScaledVector(this.direction, (head + back) / 2);
      this.quaternion.setFromUnitVectors(UP, this.direction);
      this.matrix.compose(this.midpoint, this.quaternion, this.scale.set(0.29, Math.max(0.001, head - back), 0.29));
      pulse.mesh.setMatrixAt(index, this.matrix);
      pulse.mesh.setColorAt(index, GOLD);
      pulse.opacityAttribute.setX(index, 0.92);
      pulse.emissionAttribute.setX(index, 2.4);
      pulseRecords.push(segment);
    }
    pulse.visibleRecords = pulseRecords;
    pulse.mesh.count = pulseRecords.length;
    pulse.mesh.visible = this.options.activity && this.options.links && this.activityPlaying;
    this._finishPool(pulse);

    // Only a selected commit may briefly reveal an old rename/deletion route.
    // These lines never become part of the active containment structure.
    const exitKeys = new Set(this.elapsed < this.duration ? this.pools.exitBonds.records.map(bond => this._bondActivityKey(bond)) : []);
    const contextRecords = context.records.filter(segment => this._bondInFocus(segment) && !exitKeys.has(segment.activityKey));
    context.visibleRecords = contextRecords;
    context.mesh.count = contextRecords.length;
    context.mesh.visible = this.options.activity && this.options.links && (this.activityPlaying || this.reducedMotion);
    for (let index = 0; index < contextRecords.length; index++) {
      const segment = contextRecords[index];
      this.direction.subVectors(segment.end, segment.start).normalize();
      this.midpoint.copy(segment.start).add(segment.end).multiplyScalar(0.5);
      this.quaternion.setFromUnitVectors(UP, this.direction);
      this.matrix.compose(this.midpoint, this.quaternion, this.scale.set(0.14, Math.max(0.001, segment.length), 0.14));
      context.mesh.setMatrixAt(index, this.matrix);
      context.mesh.setColorAt(index, BOND_COLOR);
      context.opacityAttribute.setX(index, this.reducedMotion ? 0.35 : 0.3 * (1 - ease(Math.max(0, (progress - 0.75) / 0.25))));
      context.emissionAttribute.setX(index, 0.22);
    }
    this._finishPool(context);

    const exitRecords = exits.records.filter(atom => this._fileInFocus(atom) && !this.exitIds.has(atom.id));
    exits.visibleRecords = exitRecords;
    exits.mesh.count = exitRecords.length;
    exits.mesh.visible = this.options.activity && this.activityPlaying;
    const fade = 1 - ease(Math.max(0, (progress - 0.72) / 0.28));
    exitRecords.forEach((atom, index) => {
      this.matrix.makeScale(atom.radius, atom.radius, atom.radius).setPosition(vector(atom.position));
      exits.mesh.setMatrixAt(index, this.matrix);
      this.paint.setHex(atom.kind.color);
      exits.mesh.setColorAt(index, this.paint);
      exits.opacityAttribute.setX(index, fade * 0.7);
      exits.emissionAttribute.setX(index, 0.35);
    });
    this._finishPool(exits);
  }

  _fileInFocus(atom) { return this.focusedFolder == null || atom.folder === this.focusedFolder; }

  _folderInFocus(path) {
    return this.focusedFolder == null || path === this.focusedFolder || this.graph.folderByPath.get(path)?.parent === this.focusedFolder;
  }

  _finishPool({ mesh, opacityAttribute, emissionAttribute }) {
    opacityAttribute.needsUpdate = true;
    emissionAttribute.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  setOptions(options = {}) {
    super.setOptions(options);
    if (!this.options.activity) { this.elapsed = this.duration; this.activityElapsed = this.activityDuration; this.activityPlaying = false; this.birthIds?.clear(); this.exitIds?.clear(); this.moves?.clear(); }
    if (this.graph) { this.dirty = true; this._paintInstances(); }
  }

  _hit(event) {
    if (!this.pickables?.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    for (const hit of this.raycaster.intersectObjects(this.pickables.filter(mesh => mesh.visible), false)) {
      const name = hit.object.userData.pool, pool = this.pools[name], record = (pool?.visibleRecords || pool?.records)?.[hit.instanceId];
      if (!record) continue;
      return name === 'backbone' || name === 'ghostBackbone' ? { kind: 'folder', path: record.folder } : { kind: 'file', id: record.id };
    }
    return null;
  }

  focusNode(id) {
    const record = this.nodes.get(id);
    if (!record) return;
    this.focusedFolder = null;
    this.select(id);
    this._paintInstances();
    this._flyTo(record.position, 19);
  }

  focusFolder(path) {
    if (!path) { this.resetView(); return; }
    const folder = this.folders.get(path);
    if (!folder) return;
    this.focusedFolder = path;
    this.dirty = true;
    const atoms = [
      ...this.graph.backboneAtoms.filter(atom => this._folderInFocus(atom.folder) && (this.options.ghosts || this.structure.backboneIds.has(atom.id))),
      ...[...this.nodes.values()].filter(record => record.node.folder === path && (this.options.ghosts || this.activeIds.has(record.node.id))).map(record => ({ position: record.position.toArray(), radius: record.size })),
    ];
    if (!atoms.length) atoms.push({ position: folder.position.toArray(), radius: 1.6 });
    this._paintInstances();
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const { position, target } = this._frameAtomsPose(atoms, direction);
    if (this.reducedMotion) { this.camera.position.copy(position); this.controls.target.copy(target); this.camera.lookAt(target); this.tween = null; }
    else this.tween = { elapsed: 0, from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to: position, toTarget: target };
  }

  _clusterOverviewDirection() {
    const folders = this.graph.folders.filter(folder => folder.directFiles > 0).slice(0, 80);
    const projectedFolders = new Map(), camera = this.camera.clone();
    const width = this.renderer.domElement.clientWidth, height = this.renderer.domElement.clientHeight;
    const portrait = width <= 700 && height > width;
    const azimuths = [0, 0.28, -0.28, 0.5, -0.5, 0.85, -0.85, 1.2, -1.2];
    if (portrait) azimuths.push(1.4, -1.4, Math.PI / 2, -Math.PI / 2, 1.7, -1.7);
    let best = -Infinity, bestFallback = -Infinity, result = null, fallback = new THREE.Vector3(0, 0, 1);
    // Cluster separation is secondary to a readable downward hierarchy.
    // Check the actual perspective projection, including the HUD framing,
    // so depth never makes a child carbon appear above its parent.
    for (const azimuth of azimuths) {
      for (const elevation of [0.75, 0.55, 0.35, 0.25, 0.15, 0.05, 0]) {
        const direction = new THREE.Vector3(Math.sin(azimuth), elevation, Math.cos(azimuth)).normalize();
        const pose = this._overviewPose(direction);
        camera.position.copy(pose.position);
        camera.lookAt(pose.target);
        camera.updateMatrixWorld(true);
        projectedFolders.clear();
        for (const folder of this.graph.folders) projectedFolders.set(folder.path, vector(folder.position).project(camera));
        const foldsUpward = this.graph.folders.some(folder => folder.parent !== null && projectedFolders.get(folder.path).y >= projectedFolders.get(folder.parent).y - 0.00001);
        if (foldsUpward) continue;
        let filesUpward = false;
        for (const [path, slots] of this.graph.folderSlots) {
          const folderY = projectedFolders.get(path).y;
          if ([...slots.values()].some(position => vector(position).project(camera).y >= folderY - 0.00001)) { filesUpward = true; break; }
        }
        if (filesUpward) continue;
        const right = new THREE.Vector3().crossVectors(UP, direction).normalize();
        const up = new THREE.Vector3().crossVectors(direction, right);
        let separation = folders.length < 2 ? 1 : Infinity;
        for (let a = 0; a < folders.length; a++) for (let b = a + 1; b < folders.length; b++) {
          this.temp.fromArray(folders[a].position).sub(vector(folders[b].position));
          const distance = Math.hypot(this.temp.dot(right), this.temp.dot(up));
          separation = Math.min(separation, distance / Math.max(4, folders[a].radius + folders[b].radius));
        }
        if (separation > bestFallback) { bestFallback = separation; fallback = direction; }
        const score = portrait ? this._portraitOccupancy(camera, direction, width, height) + Math.min(separation, 1) * 0.12 : separation;
        if (Number.isFinite(score) && score > best) { best = score; result = direction; }
      }
    }
    return result || fallback;
  }

  _portraitOccupancy(camera, direction, width, height) {
    const focalLength = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
    const points = this.overviewAtoms.map(atom => {
      const position = vector(atom.position), depth = camera.position.clone().sub(position).dot(direction);
      const projected = position.project(camera);
      return { x: projected.x * width / 2, y: projected.y * height / 2, radius: atom.radius * focalLength / depth };
    });
    const cellSize = Math.max(8, 2 * Math.max(...points.map(point => point.radius)) + 2);
    const cells = new Map();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const point of points) {
      const x = Math.floor(point.x / cellSize), y = Math.floor(point.y / cellSize);
      // Reject views where projected atom silhouettes crowd or overlap.
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const other of cells.get(`${x + dx},${y + dy}`) || []) {
          if (Math.hypot(point.x - other.x, point.y - other.y) - point.radius - other.radius < 1.5) return -Infinity;
        }
      }
      const key = `${x},${y}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(point);
      minX = Math.min(minX, point.x - point.radius); maxX = Math.max(maxX, point.x + point.radius);
      minY = Math.min(minY, point.y - point.radius); maxY = Math.max(maxY, point.y + point.radius);
    }
    return (maxX - minX) * (maxY - minY) / (width * height);
  }

  _overviewPose(direction) { return this._frameAtomsPose(this.overviewAtoms, direction); }

  _frameAtomsPose(atoms, direction) {
    const width = this.renderer.domElement.clientWidth || window.innerWidth, height = this.renderer.domElement.clientHeight || window.innerHeight;
    const left = width > 1200 ? 245 : 24, rightPanel = width > 900 ? 395 : width > 700 ? 335 : 24;
    const top = width > 700 ? 100 : 125, bottom = width > 700 ? 125 : 220;
    const usableWidth = Math.max(220, width - left - rightPanel), usableHeight = Math.max(240, height - top - bottom);
    const right = new THREE.Vector3().crossVectors(UP, direction).normalize(), up = new THREE.Vector3().crossVectors(direction, right);
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    // Frame the actual atoms, not a symmetric sphere around each whole folder.
    // Projected centering avoids reserving empty space above the hierarchy.
    for (const atom of atoms) {
      this.temp.fromArray(atom.position);
      const padding = (atom.radius || 1) + 0.8;
      const x = this.temp.dot(right), y = this.temp.dot(up), z = this.temp.dot(direction);
      minX = Math.min(minX, x - padding); maxX = Math.max(maxX, x + padding);
      minY = Math.min(minY, y - padding); maxY = Math.max(maxY, y + padding);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const center = right.clone().multiplyScalar((minX + maxX) / 2).addScaledVector(up, (minY + maxY) / 2).addScaledVector(direction, (minZ + maxZ) / 2);
    let distance = 20;
    for (const atom of atoms) {
      this.temp.fromArray(atom.position).sub(center);
      const depth = this.temp.dot(direction), padding = (atom.radius || 1) + 0.8;
      distance = Math.max(distance, depth + (Math.abs(this.temp.dot(right)) + padding) / (tangent * usableWidth / height), depth + (Math.abs(this.temp.dot(up)) + padding) / (tangent * usableHeight / height));
    }
    distance *= 1.055;
    const target = center.clone().addScaledVector(right, distance * tangent * (rightPanel - left) / height).addScaledVector(up, distance * tangent * (top - bottom) / height);
    return { target, position: target.clone().addScaledVector(direction, distance) };
  }

  resetView(immediate = false) {
    if (!this.graph) return;
    this.focusedFolder = null;
    this.dirty = true;
    this._paintInstances();
    this.overviewDirection = this._clusterOverviewDirection();
    const { position, target } = this._overviewPose(this.overviewDirection);
    if (immediate || this.reducedMotion) { this.camera.position.copy(position); this.controls.target.copy(target); this.camera.lookAt(target); this.tween = null; }
    else this.tween = { elapsed: 0, from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to: position, toTarget: target };
  }

  update(dt) {
    if (this.disposed) return;
    const delta = Math.min(Math.max(Number(dt) || 0, 0), 0.1), wasTransitioning = this.elapsed < this.duration;
    const currentWasPlaying = this.activityPlaying;
    if (this.reducedMotion || !this.options.activity) { this.activityPlaying = false; this.activityElapsed = this.activityDuration; }
    else if (this.activityPlaying) {
      this.activityElapsed = Math.min(this.activityDuration, this.activityElapsed + delta);
      if (this.activityElapsed >= this.activityDuration) this.activityPlaying = false;
    }
    this.time += delta;
    this.elapsed = this.reducedMotion ? this.duration : Math.min(this.duration, this.elapsed + delta);
    if (this.tween) {
      const tween = this.tween;
      tween.elapsed += delta;
      const amount = ease(Math.min(1, tween.elapsed / 0.9));
      this.camera.position.lerpVectors(tween.from, tween.to, amount);
      this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, amount);
      if (tween.elapsed >= 0.9) this.tween = null;
    }
    const highlight = this.hoveredId || this.selectedId;
    if (wasTransitioning || currentWasPlaying || this.dirty || highlight !== this.lastHighlight || this.elapsed / this.duration !== this.lastProgress) this._paintInstances();
    const candidate = this.nodes.get(highlight);
    const record = candidate && this._fileInFocus(candidate.node) && (this.activeIds.has(highlight) || this.options.ghosts) ? candidate : null;
    this.focusHalo.visible = Boolean(record);
    this.selectionLabel.visible = Boolean(record && this.options.labels);
    if (record) {
      this.focusHalo.position.copy(record.position);
      this.focusHalo.scale.setScalar(6.1);
      this.selectionLabel.position.copy(record.position).add(new THREE.Vector3(0, 2.5, 0));
      const element = record.node.kind.element || record.node.kind.symbol;
      this.selectionLabelElement.textContent = `${element ? `${element} · ` : ''}${this.paths[record.node.id] || record.node.path}`;
    }
    this._updateLabels();
  }

  _updateLabels() {
    const occupied = [], width = this.renderer.domElement.clientWidth, height = this.renderer.domElement.clientHeight;
    for (const record of this.labelRecords) record.object.visible = false;
    if (!this.structure || !this.options.labels) return;
    // Active directories claim label space first. Hidden historical folders
    // must never reserve collision boxes or suppress present directory names.
    for (const active of [true, false]) {
      if (!active && !this.options.ghosts) continue;
      for (const record of this.labelRecords) {
        if (!this._folderInFocus(record.path) || this.structure.folderIds.has(record.path) !== active) continue;
        const distance = this.camera.position.distanceTo(record.position);
        if (record.path && distance < 12) continue;
        this.temp.copy(record.position).project(this.camera);
        if (this.temp.z < -1 || this.temp.z > 1 || Math.abs(this.temp.x) > 1 || Math.abs(this.temp.y) > 1) continue;
        const x = (this.temp.x * 0.5 + 0.5) * width, y = (-this.temp.y * 0.5 + 0.5) * height;
        const half = Math.min(120, record.text.length * 3.2 + 5);
        if (occupied.some(box => Math.abs(x - box.x) < half + box.half && Math.abs(y - box.y) < 22)) continue;
        occupied.push({ x, y, half });
        record.element.style.opacity = active ? '.85' : '.3';
        record.object.visible = true;
      }
    }
  }

  _clearWorld() {
    for (const pool of Object.values(this.pools || {})) pool.mesh.dispose();
    super._clearWorld();
    this.pools = {};
    this.graph = null;
    this.structure = null;
    this.overviewAtoms = [];
    this.activityHistory = null;
    this.activityState = null;
    this.activitySegments = [];
    this.activityPlaying = false;
  }
}
