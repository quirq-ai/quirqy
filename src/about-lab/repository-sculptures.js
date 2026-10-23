import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { formatRepositoryCount, normalizeRepositoryCount } from './repository-stats.js';

const PALETTES = { stars: { face: '#c8a373', edge: '#f1cf9d' }, forks: { face: '#6c9bb6', edge: '#b2d7ec' } };

function starGeometry() {
  const shape = new THREE.Shape();
  for (let index = 0; index < 10; index++) {
    const angle = Math.PI / 2 + index * Math.PI / 5;
    const radius = index % 2 ? .32 : .72;
    const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
    if (index) shape.lineTo(x, y); else shape.moveTo(x, y);
  }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: .12, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: .045, bevelThickness: .045 });
  geometry.translate(0, 0, -.06);
  return geometry;
}

function addMesh(group, geometry, material, edgeColor) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.raycast = () => {};
  group.add(mesh);
  if (edgeColor) {
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 24), new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: .7, toneMapped: false }));
    edge.raycast = () => {};
    group.add(edge);
  }
  return mesh;
}

function addFork(group, material, edgeColor) {
  const paths = [
    [new THREE.Vector3(-.34, -.42, 0), new THREE.Vector3(-.34, .47, 0)],
    [new THREE.Vector3(-.34, -.18, 0), new THREE.Vector3(.05, -.03, 0), new THREE.Vector3(.34, .18, 0), new THREE.Vector3(.34, .47, 0)],
  ];
  for (const path of paths) addMesh(group, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(path), 24, .052, 8, false), material);
  for (const [x, y] of [[-.34, -.52], [-.34, .55], [.34, .55]]) {
    const node = new THREE.Group(); node.position.set(x, y, 0);
    addMesh(node, new THREE.TorusGeometry(.13, .045, 8, 20), material, edgeColor);
    group.add(node);
  }
}

/** Fixed metric objects with screen-crisp labels; no render loop or event handlers. */
export function createRepositorySculptures(repository = {}) {
  const group = new THREE.Group();
  group.name = 'Repository stars and forks';
  const labels = [], metrics = [];
  for (const [index, kind] of ['stars', 'forks'].entries()) {
    const value = normalizeRepositoryCount(repository[kind]);
    const color = PALETTES[kind];
    const object = new THREE.Group(); object.position.x = (index ? 1 : -1) * 1.38;
    object.name = `${formatRepositoryCount(value)} ${kind}`;
    object.userData = { repositoryMetric: kind, value };
    const material = new THREE.MeshStandardMaterial({ color: color.face, metalness: .45, roughness: .3, emissive: color.face, emissiveIntensity: .08 });
    const sculpture = new THREE.Group();
    sculpture.rotation.y = kind === 'stars' ? -.16 : .13;
    if (kind === 'stars') addMesh(sculpture, starGeometry(), material, color.edge);
    else addFork(sculpture, material, color.edge);
    object.add(sculpture);

    // An interrupted orbit gives each object a quiet footing, not a solid card.
    const points = Array.from({ length: 49 }, (_, step) => {
      const angle = .2 + step / 48 * Math.PI * 1.68;
      return new THREE.Vector3(Math.cos(angle) * .84, -.85 + Math.sin(angle) * .12, -.1);
    });
    const orbit = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: color.edge, transparent: true, opacity: .25, depthWrite: false, toneMapped: false }));
    orbit.raycast = () => {};
    object.add(orbit);

    const element = document.createElement('div');
    element.className = `about-space-metric about-space-${kind}`;
    element.setAttribute('aria-hidden', 'true');
    element.style.cssText = `pointer-events:none;line-height:1.15;white-space:nowrap;color:${color.edge};font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-shadow:0 1px 5px #01040a,0 0 9px #01040a;font-variant-numeric:tabular-nums;`;
    const content = document.createElement('div');
    content.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:1px;';
    const number = document.createElement('span'); number.textContent = formatRepositoryCount(value, { compact: true }); number.style.cssText = 'font-size:13px;font-weight:500;letter-spacing:-.03em;';
    const caption = document.createElement('span'); caption.textContent = kind; caption.style.cssText = 'font-size:7px;letter-spacing:.12em;text-transform:uppercase;opacity:.75;';
    content.append(number, caption); element.append(content);
    const label = new CSS2DObject(element); label.position.set(0, -1.1, .1);
    label.center.set(.5, 0);
    object.add(label);
    labels.push({ object: label, element, number, caption });
    metrics.push(object); group.add(object);
  }
  return {
    group, labels, metrics,
    compact(value) {
      for (const label of labels) {
        label.number.style.fontSize = value ? '11px' : '13px';
        label.caption.style.fontSize = value ? '6px' : '7px';
      }
    },
    dispose() {
      const geometries = new Set(), materials = new Set();
      group.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) materials.add(object.material);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const label of labels) label.object.removeFromParent();
      group.removeFromParent(); group.clear();
    },
  };
}
