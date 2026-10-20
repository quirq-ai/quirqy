import * as THREE from 'three';
import { contributorPortrait } from './contributor-profile.js';
import { requestRender } from '../scene/render-on-demand.js';

/** One scene-owned texture; late image loads cannot outlive their repository. */
export function createContributorPortrait(actor) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d');
  const background = context.createLinearGradient(0, 0, 256, 256);
  background.addColorStop(0, '#344663'); background.addColorStop(1, '#101b2d');
  context.fillStyle = background; context.fillRect(0, 0, 256, 256);
  context.fillStyle = '#e9d2ac'; context.font = '600 88px system-ui, sans-serif';
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillText((actor?.login || '?').replace(/\[bot\]$/i, '').slice(0, 2).toUpperCase(), 128, 134);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const portrait = { map, source: contributorPortrait(actor), status: 'fallback', dispose };
  let image = null, active = true;
  if (portrait.source) {
    portrait.status = 'loading';
    image = new Image(); image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer'; image.decoding = 'async';
    image.onload = () => {
      if (!active || !image.naturalWidth || !image.naturalHeight) return;
      try {
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
        map.needsUpdate = true; portrait.status = 'ready'; requestRender();
      } catch { portrait.status = 'fallback'; }
    };
    image.onerror = () => { if (active) portrait.status = 'fallback'; };
    image.src = portrait.source;
  }
  function dispose() {
    if (!active) return;
    active = false; portrait.status = 'disposed';
    if (image) { image.onload = image.onerror = null; image.removeAttribute('src'); image = null; }
    map.dispose();
  }
  return portrait;
}
