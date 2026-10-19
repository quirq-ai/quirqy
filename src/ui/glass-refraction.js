const SVG_NS = 'http://www.w3.org/2000/svg';
const SURFACES = '.panel, #glass-appearance-popover';
const MAX_MAP_SIZE = 512;
const ROOT_TOKENS = ['--glass-blur', '--glass-saturation', '--glass-refraction-index', '--glass-reflection'];
const ownedSurfaces = new Map();
const mountedManagers = new Set();
let nextFilterId = 0;

/** Register a surface whose owner controls its lifecycle, including nested scene labels. */
export function registerGlassSurface(element) {
  ownedSurfaces.set(element, (ownedSurfaces.get(element) || 0) + 1);
  for (const manager of mountedManagers) manager.register(element);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const owners = ownedSurfaces.get(element) - 1;
    if (owners > 0) {
      ownedSurfaces.set(element, owners);
      return;
    }
    ownedSurfaces.delete(element);
    for (const manager of mountedManagers) manager.release(element);
  };
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function supportsBackdropRefraction() {
  // Safari and Firefox can accept url() syntax without rendering SVG backdrop
  // filters. Keep their ordinary blur/saturation material until rendering support
  // is dependable; a syntax-only CSS.supports check cannot establish that.
  const chromium = navigator.userAgentData?.brands?.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge/.test(brand))
    || (/\b(?:Chrome|Chromium)\//.test(navigator.userAgent) && !/iPad|iPhone|iPod/.test(navigator.userAgent));
  return chromium && CSS.supports('backdrop-filter', 'url("#glass-support-check")') && typeof ResizeObserver === 'function';
}

/**
 * A rounded glass bevel, encoded as horizontal (R) and vertical (G) normals.
 * The neutral interior leaves the scene undisturbed; only the curved perimeter
 * bends it. Generate at most 512 pixels on either axis, once per surface size.
 */
function createLensMap(width, height, radius) {
  const resolution = Math.min(1, MAX_MAP_SIZE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * resolution));
  canvas.height = Math.max(1, Math.round(height * resolution));
  const context = canvas.getContext('2d');
  if (!context) return null;
  const pixels = context.createImageData(canvas.width, canvas.height);
  const bevel = Math.min(28, Math.max(12, radius * 1.35), width / 3, height / 3);
  const halfWidth = width / 2, halfHeight = height / 2;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const px = (x + .5) * width / canvas.width - halfWidth;
      const py = (y + .5) * height / canvas.height - halfHeight;
      const qx = Math.abs(px) - (halfWidth - radius);
      const qy = Math.abs(py) - (halfHeight - radius);
      const outsideX = Math.max(qx, 0), outsideY = Math.max(qy, 0);
      const cornerDistance = Math.hypot(outsideX, outsideY);
      const distance = -(cornerDistance + Math.min(Math.max(qx, qy), 0) - radius);
      const depth = Math.max(0, Math.min(1, distance / bevel));
      const strength = (1 - depth) * (1 - depth) * (1 + 2 * depth);
      let nx = 0, ny = 0;
      if (cornerDistance > 0) {
        nx = outsideX / cornerDistance;
        ny = outsideY / cornerDistance;
      } else if (qx > qy) nx = 1;
      else ny = 1;
      const offset = (y * canvas.width + x) * 4;
      pixels.data[offset] = Math.round(127.5 + 127.5 * Math.sign(px) * nx * strength);
      pixels.data[offset + 1] = Math.round(127.5 + 127.5 * Math.sign(py) * ny * strength);
      pixels.data[offset + 2] = 128;
      pixels.data[offset + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Opacity-linked optical material. No scene copies, animation loop, or filtered text. */
export function mountGlassRefraction() {
  const root = document.documentElement;
  const previousTokens = ROOT_TOKENS.map(name => [name, root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]);
  const surfaces = new Map();
  let disposed = false;
  let displacement = 0;
  let definitions = null;
  let observer = null;
  let sizes = null;

  function update(opacity) {
    if (disposed) return;
    const percent = Number.isFinite(opacity) ? Math.max(0, Math.min(100, opacity)) : 62;
    const amount = percent / 100;
    const index = 1.52 - .52 * amount;
    // A stylized air/glass lens: a higher relative index bends the sampled scene
    // farther. The material becomes gently frosted as its tint turns opaque.
    displacement = 70 * (1 - 1 / index);
    root.style.setProperty('--glass-blur', `${(12 * amount * amount).toFixed(3)}px`);
    root.style.setProperty('--glass-saturation', (1.30 - .30 * amount).toFixed(3));
    root.style.setProperty('--glass-refraction-index', index.toFixed(4));
    root.style.setProperty('--glass-reflection', (.24 - .14 * amount).toFixed(4));
    for (const surface of surfaces.values()) surface.displace.setAttribute('scale', displacement.toFixed(3));
  }
  update(62);

  function resize(element) {
    const surface = surfaces.get(element);
    if (!surface || !element.isConnected) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return; // Hidden panels initialize when revealed.
    const width = Math.round(bounds.width * 100) / 100;
    const height = Math.round(bounds.height * 100) / 100;
    const radius = Math.max(0, Math.min(parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0, width / 2, height / 2));
    const key = `${width}:${height}:${radius}`;
    if (surface.size === key) return;
    const map = createLensMap(width, height, radius);
    if (!map) return; // The CSS blur/saturation material remains available.
    surface.size = key;
    surface.filter.setAttribute('width', String(width + 64));
    surface.filter.setAttribute('height', String(height + 64));
    surface.image.setAttribute('width', String(width));
    surface.image.setAttribute('height', String(height));
    surface.image.setAttribute('href', map);
    element.style.setProperty('--glass-backdrop-filter', `url("#${surface.filter.id}") blur(var(--glass-blur)) saturate(var(--glass-saturation))`);
  }

  function register(element) {
    if (disposed || !sizes || surfaces.has(element)) return;
    const filter = svgElement('filter', {
      id: `quirq-glass-lens-${++nextFilterId}`, filterUnits: 'userSpaceOnUse',
      x: -32, y: -32, 'color-interpolation-filters': 'sRGB',
    });
    const image = svgElement('feImage', { x: 0, y: 0, preserveAspectRatio: 'none', result: 'lensNormals' });
    const displace = svgElement('feDisplacementMap', {
      in: 'SourceGraphic', in2: 'lensNormals', scale: displacement.toFixed(3),
      xChannelSelector: 'R', yChannelSelector: 'G',
    });
    filter.append(image, displace);
    definitions.firstElementChild.append(filter);
    surfaces.set(element, {
      filter, image, displace, size: null,
      previous: element.style.getPropertyValue('--glass-backdrop-filter'),
      priority: element.style.getPropertyPriority('--glass-backdrop-filter'),
    });
    sizes.observe(element);
    resize(element);
  }

  function unregister(element, surface) {
    sizes.unobserve(element);
    if (surface.previous) element.style.setProperty('--glass-backdrop-filter', surface.previous, surface.priority);
    else element.style.removeProperty('--glass-backdrop-filter');
    surface.filter.remove();
    surfaces.delete(element);
  }

  function release(element) {
    const surface = surfaces.get(element);
    if (surface) unregister(element, surface);
  }

  const manager = { register, release };
  mountedManagers.add(manager);

  if (supportsBackdropRefraction()) {
    definitions = svgElement('svg', { 'aria-hidden': 'true', focusable: 'false', width: 0, height: 0, 'data-glass-refraction': '' });
    definitions.style.cssText = 'position:fixed;width:0;height:0;pointer-events:none;overflow:hidden;';
    definitions.append(svgElement('defs'));
    document.body.append(definitions);
    sizes = new ResizeObserver(entries => { for (const { target } of entries) resize(target); });
    document.querySelectorAll(SURFACES).forEach(register);
    for (const element of ownedSurfaces.keys()) register(element);
    // Discover ordinary lab panels under body. Nested scene surfaces register
    // explicitly, without observing continuously changing scene labels.
    observer = new MutationObserver(records => {
      for (const { addedNodes } of records) {
        for (const node of addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(SURFACES)) register(node);
          node.querySelectorAll(SURFACES).forEach(register);
        }
      }
      for (const [element, surface] of surfaces) {
        if (!element.isConnected && !ownedSurfaces.has(element)) unregister(element, surface);
      }
    });
    observer.observe(document.body, { childList: true });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    mountedManagers.delete(manager);
    observer?.disconnect();
    sizes?.disconnect();
    for (const [element, surface] of surfaces) unregister(element, surface);
    definitions?.remove();
    for (const [name, value, priority] of previousTokens) {
      if (value) root.style.setProperty(name, value, priority);
      else root.style.removeProperty(name);
    }
  }
  return { update, dispose };
}
