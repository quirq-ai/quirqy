import * as THREE from 'three';

const BASE_CAPACITY = 8;
const EXPANSION_DURATION = 0.25;
const finitePoint = point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite);

const vertexShader = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float instanceFocus;
  varying vec3 vViewPosition;
  varying vec3 vViewNormal;
  varying float vFocus;

  void main() {
    vec4 instancePosition = instanceMatrix * vec4(position, 1.0);
    vec4 viewPosition = modelViewMatrix * instancePosition;

    // Ellipsoids scale their axes independently. Inverse scale keeps the rim
    // perpendicular to the actual surface instead of the original unit sphere.
    mat3 instanceBasis = mat3(instanceMatrix);
    vec3 instanceNormal = normal / vec3(
      dot(instanceBasis[0], instanceBasis[0]),
      dot(instanceBasis[1], instanceBasis[1]),
      dot(instanceBasis[2], instanceBasis[2])
    );
    vViewNormal = normalize(normalMatrix * instanceBasis * instanceNormal);
    vViewPosition = -viewPosition.xyz;
    vFocus = instanceFocus;
    gl_Position = projectionMatrix * viewPosition;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */`
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uHasFocus;
  varying vec3 vViewPosition;
  varying vec3 vViewNormal;
  varying float vFocus;

  void main() {
    #include <logdepthbuf_fragment>
    float facing = abs(dot(normalize(vViewNormal), normalize(vViewPosition)));
    float rim = pow(1.0 - clamp(facing, 0.0, 1.0), 4.5);
    float focusWeight = mix(1.0, mix(0.48, 1.2, vFocus), uHasFocus);
    float alpha = (0.012 + rim * 0.19) * uOpacity * focusWeight;
    vec3 color = uColor * (0.8 + rim * 0.2 + vFocus * 0.08);
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Subtle world-space folder volumes; the caller owns membership and visibility. */
export class FolderEnclosureScene {
  constructor(parentGroup) {
    this.parentGroup = parentGroup;
    this.records = [];
    this.capacity = 0;
    this.mesh = null;
    this.focusedFolder = null;
    this.playing = false;
    this.expansionElapsed = EXPANSION_DURATION;
    this.expansionProgress = 1;
    this.expanding = false;
    this.disposed = false;
    this.matrix = new THREE.Matrix4();
    this.position = new THREE.Vector3();
    this.scale = new THREE.Vector3();
    this.rotation = new THREE.Quaternion();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x8dabc1) },
        uOpacity: { value: 1 },
        uHasFocus: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
    });
    this._reserve(BASE_CAPACITY);
  }

  _reserve(required) {
    if (required <= this.capacity) return;
    const capacity = Math.max(BASE_CAPACITY, 2 ** Math.ceil(Math.log2(required)));
    const previous = this.mesh;
    const geometry = new THREE.SphereGeometry(1, 64, 40);
    this.focusAttribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('instanceFocus', this.focusAttribute);
    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.name = 'Data Lab · Folder enclosures';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    // Composite the faint shell behind the transparent atom/bond instances.
    this.mesh.renderOrder = -2;
    this.parentGroup.add(this.mesh);
    this.capacity = capacity;
    if (previous) {
      previous.removeFromParent();
      previous.dispose();
      previous.geometry.dispose();
    }
  }

  setEnclosures(records = []) {
    if (this.disposed) return;
    this.records = records.filter(record => record.folder !== '' && finitePoint(record.center)
      && [record.radiusX, record.radiusY, record.radiusZ].every(radius => Number.isFinite(radius) && radius > 0));
    this._reserve(this.records.length);
    this.mesh.count = this.records.length;
    this.mesh.visible = this.playing && this.records.length > 0;
    this.records.forEach((record, index) => {
      this.focusAttribute.setX(index, this.focusedFolder !== null && record.folder === this.focusedFolder ? 1 : 0);
    });
    this.focusAttribute.needsUpdate = true;
    this._writeTransforms();
  }

  _writeTransforms() {
    const progress = this.expansionProgress;
    const amount = progress * progress * (3 - 2 * progress);
    this.records.forEach((record, index) => {
      const anchor = finitePoint(record.anchor) ? record.anchor : record.center;
      const radius = Number.isFinite(record.anchorRadius) && record.anchorRadius > 0 ? record.anchorRadius : 1.6;
      this.position.set(
        anchor[0] + (record.center[0] - anchor[0]) * amount,
        anchor[1] + (record.center[1] - anchor[1]) * amount,
        anchor[2] + (record.center[2] - anchor[2]) * amount,
      );
      this.scale.set(
        radius + (record.radiusX - radius) * amount,
        radius + (record.radiusY - radius) * amount,
        radius + (record.radiusZ - radius) * amount,
      );
      this.matrix.compose(this.position, this.rotation, this.scale);
      this.mesh.setMatrixAt(index, this.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }

  setFocus(path = null) {
    if (this.disposed || path === this.focusedFolder) return;
    this.focusedFolder = path;
    this.material.uniforms.uHasFocus.value = path === null ? 0 : 1;
    this.records.forEach((record, index) => this.focusAttribute.setX(index, path !== null && record.folder === path ? 1 : 0));
    this.focusAttribute.needsUpdate = true;
  }

  update(dt, { playing = false, reducedMotion = false } = {}) {
    if (this.disposed) return;
    const nextPlaying = Boolean(playing), starting = nextPlaying && !this.playing;
    const previousProgress = this.expansionProgress;
    this.playing = nextPlaying;
    this.reducedMotion = Boolean(reducedMotion);
    // Only a real play transition starts expansion. Rebuilding instance records
    // for focus or a commit keeps the same phase and never starts another one.
    if (!this.playing || this.reducedMotion) {
      this.expansionElapsed = EXPANSION_DURATION;
      this.expansionProgress = 1;
      this.expanding = false;
    } else if (starting) {
      this.expansionElapsed = 0;
      this.expansionProgress = 0;
      this.expanding = true;
    } else if (this.expanding) {
      const delta = Number.isFinite(Number(dt)) ? Math.max(0, Number(dt)) : 0;
      this.expansionElapsed = Math.min(EXPANSION_DURATION, this.expansionElapsed + delta);
      this.expansionProgress = this.expansionElapsed / EXPANSION_DURATION;
      this.expanding = this.expansionProgress < 1;
    }
    // Pause hides before changing transforms: no collapsing shell is rendered.
    this.mesh.visible = this.playing && this.records.length > 0;
    this.material.uniforms.uOpacity.value = 0.64;
    if (previousProgress !== this.expansionProgress) this._writeTransforms();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.expanding = false;
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.records = [];
  }
}
