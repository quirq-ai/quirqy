/** Composite frame painter: WebGL view + Quirq logo + live equation / lab HUD. */

import { DEFAULT_LOGO_URL, getLogoUrl, subscribeLogo } from '../branding/logo-preference.js';
const MAX_EDGE = 1920; // keep encode cost manageable on retina displays

export function createOverlayPainter() {
  const canvas = document.createElement('canvas');
  let ctx = null;
  try {
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  } catch {
    ctx = null;
  }
  if (!ctx) ctx = canvas.getContext('2d', { alpha: false });
  let logo = null;
  let logoReady = false;
  let locked = false;

  let logoSource = null, logoVersion = 0;
  function syncLogo() {
    const source = getLogoUrl();
    if (source === logoSource) return;
    logoSource = source;
    logoReady = false;
    const version = ++logoVersion;
    const load = url => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => {
        if (version !== logoVersion) return;
        logo = image;
        logoReady = true;
      };
      image.onerror = () => {
        if (version === logoVersion && url !== DEFAULT_LOGO_URL) load(DEFAULT_LOGO_URL);
      };
      image.src = url;
    };
    load(source);
  }
  // Preload while the recorder is idle so the next capture uses the selected logo.
  const unsubscribeLogo = subscribeLogo(syncLogo);
  syncLogo();

  function fitSize(srcW, srcH) {
    let w = Math.max(2, srcW | 0);
    let h = Math.max(2, srcH | 0);
    const edge = Math.max(w, h);
    if (edge > MAX_EDGE) {
      const s = MAX_EDGE / edge;
      w = Math.max(2, Math.round(w * s));
      h = Math.max(2, Math.round(h * s));
    }
    // MediaRecorder prefers even dimensions
    w -= w % 2;
    h -= h % 2;
    return { w, h };
  }

  /** Lock output size for the duration of a recording (resizing kills captureStream). */
  function lockFrom(src) {
    const { w, h } = fitSize(src.width || src.clientWidth || 1280, src.height || src.clientHeight || 720);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    locked = true;
    return { w, h };
  }

  function unlock() {
    locked = false;
  }

  /**
   * @param {HTMLCanvasElement} src
   * @param {object} hud
   */
  function paint(src, hud = {}) {
    syncLogo();
    if (!locked) lockFrom(src);
    const w = canvas.width;
    const h = canvas.height;
    if (!(w > 0 && h > 0)) return canvas;

    ctx.fillStyle = '#01030a';
    ctx.fillRect(0, 0, w, h);

    // Draw the WebGL frame. preserveDrawingBuffer must be on for reliable copies.
    try {
      if (src && src.width > 0 && src.height > 0) {
        ctx.drawImage(src, 0, 0, w, h);
      }
    } catch (err) {
      console.warn('Overlay drawImage failed:', err);
    }

    const grad = ctx.createLinearGradient(0, 0, 0, Math.min(110, h * 0.2));
    grad.addColorStop(0, 'rgba(1, 3, 10, 0.82)');
    grad.addColorStop(1, 'rgba(1, 3, 10, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, Math.min(110, h * 0.2));

    const pad = Math.max(16, Math.round(w * 0.018));
    const logoSize = Math.max(36, Math.round(w * 0.045));
    if (logoReady && logo) {
      const scale = logoSize / Math.max(logo.naturalWidth, logo.naturalHeight);
      const width = logo.naturalWidth * scale, height = logo.naturalHeight * scale;
      try { ctx.drawImage(logo, pad + (logoSize - width) / 2, pad + (logoSize - height) / 2, width, height); } catch { /* ignore */ }
    }

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#d7dfef';
    ctx.font = `600 ${Math.max(15, Math.round(w * 0.018))}px Inter, system-ui, sans-serif`;
    const textX = pad + logoSize + 12;
    const brand = 'quirq observatory';
    let headerRight = textX + ctx.measureText(brand).width;
    ctx.fillText(brand, textX, pad + 2);
    ctx.fillStyle = '#8b96ad';
    ctx.font = `500 ${Math.max(11, Math.round(w * 0.012))}px Inter, system-ui, sans-serif`;
    const title = hud.title || 'quirq observatory';
    headerRight = Math.max(headerRight, textX + ctx.measureText(title).width);
    ctx.fillText(title, textX, pad + Math.round(logoSize * 0.55));

    if (hud.recSec != null) {
      const label = `REC ${hud.recSec.toFixed(1)}s / ${(hud.recMaxSec ?? 10).toFixed(0)}s`;
      ctx.font = `700 ${Math.max(12, Math.round(w * 0.013))}px Inter, system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      const bx = w - pad - tw - 28;
      // Move the badge below the heading when a narrow capture cannot fit both.
      const by = headerRight + 12 > bx ? pad + logoSize + 12 : pad + 4;
      ctx.fillStyle = 'rgba(40, 12, 16, 0.75)';
      roundRect(ctx, bx, by, tw + 28, 28, 8);
      ctx.fill();
      ctx.fillStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.arc(bx + 12, by + 14, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffb0b0';
      ctx.fillText(label, bx + 22, by + 7);
    }

    const lines = [];
    if (hud.status) lines.push(hud.status);
    if (hud.lines) lines.push(...hud.lines.filter(Boolean));
    if (hud.points && hud.points.length) {
      lines.push('---');
      const maxPts = Math.min(hud.points.length, 8);
      for (let i = 0; i < maxPts; i++) {
        const p = hud.points[i];
        lines.push(`${p.name}: ${p.line}`);
      }
      if (hud.points.length > maxPts) lines.push(`... +${hud.points.length - maxPts} more`);
    }

    if (lines.length) {
      const fontSize = Math.max(11, Math.round(w * 0.0115));
      ctx.font = `500 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      let maxW = 0;
      for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
      const lineH = fontSize + 5;
      const boxH = lines.length * lineH + 20;
      const boxW = Math.min(w * 0.55, maxW + 28);
      // Place from normalized viewport coords when provided (draggable floater)
      const nx = hud.nx != null ? hud.nx : null;
      const ny = hud.ny != null ? hud.ny : null;
      let bx = pad;
      let by = h - pad - boxH;
      if (nx != null && ny != null) {
        bx = Math.round(nx * w);
        by = Math.round(ny * h);
        bx = Math.max(pad, Math.min(w - boxW - pad, bx));
        by = Math.max(pad, Math.min(h - boxH - pad, by));
      }
      ctx.fillStyle = 'rgba(9, 13, 24, 0.72)';
      roundRect(ctx, bx, by, boxW, boxH, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(140, 170, 255, 0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();

      let ty = by + 12;
      for (const ln of lines) {
        if (ln === '---') {
          ctx.strokeStyle = 'rgba(140, 170, 255, 0.2)';
          ctx.beginPath();
          ctx.moveTo(bx + 12, ty + lineH * 0.35);
          ctx.lineTo(bx + boxW - 12, ty + lineH * 0.35);
          ctx.stroke();
        } else {
          ctx.fillStyle = ln.startsWith('P') || ln.includes('err') ? '#cfe0ff' : '#d7dfef';
          if (ln.includes('x(') || ln.includes('y(') || ln.includes('z(') || (ln.includes('=') && ln.includes('('))) {
            ctx.fillStyle = '#ffca7a';
          }
          ctx.fillText(ln, bx + 14, ty);
        }
        ty += lineH;
      }
    }

    return canvas;
  }

  function dispose() {
    unsubscribeLogo();
    logoVersion += 1;
    logo = null;
    logoReady = false;
  }

  return { canvas, paint, lockFrom, unlock, ready: () => logoReady, dispose };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
