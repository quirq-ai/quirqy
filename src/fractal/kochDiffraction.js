// Koch snowflake aperture + Fraunhofer diffraction via 2D FFT.
// Intensity I(fx, fy) ∝ |ℱ{A(x, y)}|² where A is the binary aperture.
// Classic diffractal: self-similar rings + hexagonal symmetry (Uozumi et al.).

const TAU = Math.PI * 2;

/** Equilateral triangle → Koch snowflake outline after `iters` generations. */
export function kochSnowflakePolygon(iters = 3) {
  const n = Math.max(0, Math.min(7, Math.round(iters)));
  // Pointy-top equilateral triangle, closed ring of edges
  let pts = [
    [0, 1],
    [-Math.sqrt(3) / 2, -0.5],
    [Math.sqrt(3) / 2, -0.5],
  ];
  for (let g = 0; g < n; g++) {
    const next = [];
    const m = pts.length;
    for (let i = 0; i < m; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % m];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const ax = x0 + dx / 3;
      const ay = y0 + dy / 3;
      const cx = x0 + (2 * dx) / 3;
      const cy = y0 + (2 * dy) / 3;
      // Outward bump: rotate (dx,dy)/3 by -60 deg (CW). CCW walk keeps exterior on the right.
      const bx = ax + (dx / 3) * 0.5 + (dy / 3) * (Math.sqrt(3) / 2);
      const by = ay - (dx / 3) * (Math.sqrt(3) / 2) + (dy / 3) * 0.5;
      next.push([x0, y0], [ax, ay], [bx, by], [cx, cy]);
    }
    pts = next;
  }
  return pts;
}

/** Hausdorff dimension of the Koch snowflake boundary. */
export const KOCH_DIM = Math.log(4) / Math.log(3);

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place radix-2 Cooley-Tukey FFT on interleaved complex Float64Array [re,im,...]. */
function fft1d(data, n, inverse) {
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = i * 2;
      const b = j * 2;
      const tr = data[a];
      const ti = data[a + 1];
      data[a] = data[b];
      data[a + 1] = data[b + 1];
      data[b] = tr;
      data[b + 1] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * TAU) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const u = (i + j) * 2;
        const v = (i + j + half) * 2;
        const vr = data[v] * wRe - data[v + 1] * wIm;
        const vi = data[v] * wIm + data[v + 1] * wRe;
        data[v] = data[u] - vr;
        data[v + 1] = data[u + 1] - vi;
        data[u] += vr;
        data[u + 1] += vi;
        const nWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nWRe;
      }
    }
  }
  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n * 2; i++) data[i] *= inv;
  }
}

/** Rasterize filled Koch snowflake onto an N×N binary aperture (1 = open). */
export function rasterizeKochAperture(size, iterations, { invert = false, margin = 0.12 } = {}) {
  const N = nextPow2(size);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = invert ? '#fff' : '#000';
  ctx.fillRect(0, 0, N, N);

  const poly = kochSnowflakePolygon(iterations);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const pad = margin * N;
  const usable = N - 2 * pad;
  const s = usable / span;
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;

  ctx.fillStyle = invert ? '#000' : '#fff';
  ctx.beginPath();
  for (let i = 0; i < poly.length; i++) {
    const px = pad + usable * 0.5 + (poly[i][0] - cx) * s;
    const py = pad + usable * 0.5 - (poly[i][1] - cy) * s; // y-up → canvas y-down
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  const img = ctx.getImageData(0, 0, N, N);
  const aperture = new Float32Array(N * N);
  let open = 0;
  for (let i = 0; i < N * N; i++) {
    const v = img.data[i * 4] / 255;
    aperture[i] = v;
    open += v;
  }
  return {
    size: N,
    aperture,
    openFraction: open / (N * N),
    segments: poly.length,
    iterations,
    dimension: KOCH_DIM,
  };
}

/**
 * Fraunhofer diffraction: fftshifted |FFT2(aperture)|².
 * Returns Float32 intensity (linear), plus peak for tone mapping.
 */
export function fraunhoferIntensity(aperture, size) {
  const N = size;
  const buf = new Float64Array(N * N * 2);
  for (let i = 0; i < N * N; i++) {
    buf[i * 2] = aperture[i];
    buf[i * 2 + 1] = 0;
  }

  // row FFTs
  const row = new Float64Array(N * 2);
  for (let y = 0; y < N; y++) {
    const off = y * N * 2;
    row.set(buf.subarray(off, off + N * 2));
    fft1d(row, N, false);
    buf.set(row, off);
  }
  // column FFTs
  const col = new Float64Array(N * 2);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      const i = (y * N + x) * 2;
      col[y * 2] = buf[i];
      col[y * 2 + 1] = buf[i + 1];
    }
    fft1d(col, N, false);
    for (let y = 0; y < N; y++) {
      const i = (y * N + x) * 2;
      buf[i] = col[y * 2];
      buf[i + 1] = col[y * 2 + 1];
    }
  }

  const intensity = new Float32Array(N * N);
  let peak = 0;
  const half = N >> 1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // fftshift
      const sx = (x + half) % N;
      const sy = (y + half) % N;
      const i = (sy * N + sx) * 2;
      const re = buf[i];
      const im = buf[i + 1];
      const I = re * re + im * im;
      intensity[y * N + x] = I;
      if (I > peak) peak = I;
    }
  }
  return { intensity, peak: peak || 1, size: N };
}

/** Pack aperture (R) + log-normalized diffraction (G) into RGBA Uint8 for GPU upload. */
export function packDiffractionTexture(apertureData, diffractionData, { logGain = 12 } = {}) {
  const N = apertureData.size;
  const rgba = new Uint8Array(N * N * 4);
  const { aperture } = apertureData;
  const { intensity, peak } = diffractionData;
  const gain = Math.max(0.5, logGain);
  for (let i = 0; i < N * N; i++) {
    const a = Math.max(0, Math.min(1, aperture[i]));
    const norm = intensity[i] / peak;
    // log₁₊ stretch reveals secondary rings without blowing the DC spike
    const logI = Math.log1p(norm * (Math.exp(gain) - 1)) / gain;
    const o = i * 4;
    rgba[o] = (a * 255) | 0;
    rgba[o + 1] = Math.max(0, Math.min(255, (logI * 255) | 0));
    rgba[o + 2] = Math.max(0, Math.min(255, (Math.sqrt(norm) * 255) | 0)); // gamma-ish spare
    rgba[o + 3] = 255;
  }
  return { rgba, size: N, peak, openFraction: apertureData.openFraction, segments: apertureData.segments };
}

/**
 * Full pipeline: Koch aperture → Fraunhofer pattern texture bytes.
 * @param {{ iterations?: number, size?: number, invert?: boolean, logGain?: number, margin?: number }} opts
 */
export function computeKochDiffraction(opts = {}) {
  const iterations = opts.iterations ?? 4;
  const size = opts.size ?? 512;
  const invert = !!opts.invert;
  const logGain = opts.logGain ?? 12;
  const margin = opts.margin ?? 0.12;

  const apertureData = rasterizeKochAperture(size, iterations, { invert, margin });
  const diffractionData = fraunhoferIntensity(apertureData.aperture, apertureData.size);
  const packed = packDiffractionTexture(apertureData, diffractionData, { logGain });

  return {
    ...packed,
    iterations: apertureData.iterations,
    dimension: KOCH_DIM,
    invert,
    logGain,
  };
}
