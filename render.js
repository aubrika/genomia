// Renderer — Canvas 2D. Everything on screen is a readout of genotype. Color is
// semantic (similar genomes look similar); adjacency lines show that "touching"
// in continuous space is a continuous quantity. Kept separate from sim.js.

import { G, GENE } from './sim.js';

// --- color -----------------------------------------------------------------
// Phenotype: hue=niche center, saturation=niche breadth, lightness=motility.
// A degenerate (grey) genome falls out literally grey — a useful diagnostic.
export function phenotypeHSL(genome, base, R) {
  let m = (genome[base + GENE.sLo] + genome[base + GENE.sHi]) / 2;
  if (m < 0) m = 0; else if (m > 8) m = 8;
  const hue = 210 - 195 * (m / 8);                    // 210° solitary → 15° crowd
  let br = genome[base + GENE.sHi] - genome[base + GENE.sLo];
  if (br < 0) br = 0; else if (br > 8) br = 8;
  const sat = 85 - 73 * (br / 8);                     // 85% specialist → 12% generalist
  let mot = genome[base + GENE.step] / (0.3 * R);
  if (mot < 0) mot = 0; else if (mot > 1) mot = 1;
  const light = 38 + 34 * mot;                        // 38% sessile → 72% motile
  return [hue, sat, light];
}

// Lineage: hue from a golden-ratio hash of lineageId — the drift null model.
export function lineageHSL(lineageId) {
  const hue = (lineageId * 137.508) % 360;
  return [hue < 0 ? hue + 360 : hue, 60, 55];
}

export function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (t) => {
    if (t < 0) t += 1; else if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(hk(h + 1 / 3) * 255), Math.round(hk(h) * 255), Math.round(hk(h - 1 / 3) * 255)];
}

// Reusable per-agent color buffers (avoid per-frame allocation).
let rB = null, gB = null, bB = null;
function ensureColor(cap) {
  if (!rB || rB.length < cap) { rB = new Uint8Array(cap); gB = new Uint8Array(cap); bB = new Uint8Array(cap); }
}

// Reusable adjacency-pair buffers.
let pI = null, pJ = null, pD = null, pW = null, pM = null, pCap = 0;
function ensurePairs(need) {
  if (need <= pCap) return;
  pCap = Math.max(need, pCap * 2, 8192);
  pI = new Int32Array(pCap); pJ = new Int32Array(pCap); pD = new Float32Array(pCap);
  pW = new Float32Array(pCap); pM = new Uint8Array(pCap);
}

const GROUND = '#12100E';

export function draw(ctx, state, P, view, opts) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, cw, ch);

  const N = state.count, GEN = state.genome, R = P.R, W = P.world;
  const { scale, ox, oy } = view;
  ensureColor(state.cap);

  // per-agent RGB for this frame
  for (let i = 0; i < N; i++) {
    const base = i * G;
    const hsl = opts.colorMode === 'lineage' ? lineageHSL(state.lineage[i]) : phenotypeHSL(GEN, base, R);
    const rgb = hslToRgb(hsl[0], hsl[1], hsl[2]);
    rB[i] = rgb[0]; gB[i] = rgb[1]; bB[i] = rgb[2];
  }

  if (opts.showLines && N > 1) drawLines(ctx, state, P, view, opts);

  // cells: filled circles, 2.5px, no stroke
  const X = state.x, Y = state.y;
  for (let i = 0; i < N; i++) {
    ctx.fillStyle = `rgb(${rB[i]},${gB[i]},${bB[i]})`;
    ctx.beginPath();
    ctx.arc(ox + X[i] * scale, oy + Y[i] * scale, 2.5, 0, 6.283185307179586);
    ctx.fill();
  }

  if (opts.hovered != null && opts.hovered >= 0 && opts.hovered < N) drawHover(ctx, state, P, view, opts.hovered);
}

function drawLines(ctx, state, P, view, opts) {
  const N = state.count, GEN = state.genome, R = P.R, W = P.world, halfW = W / 2;
  const X = state.x, Y = state.y;
  const bucket = R * 1.5;
  const nx = Math.max(1, Math.ceil(W / bucket)), ny = nx, nc = nx * ny;
  const counts = new Int32Array(nc + 1), cellIdx = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    let cx = (X[i] / bucket) | 0; if (cx >= nx) cx = nx - 1; else if (cx < 0) cx = 0;
    let cy = (Y[i] / bucket) | 0; if (cy >= ny) cy = ny - 1; else if (cy < 0) cy = 0;
    const c = cy * nx + cx; cellIdx[i] = c; counts[c + 1]++;
  }
  for (let c = 0; c < nc; c++) counts[c + 1] += counts[c];
  const cursor = counts.slice(0, nc), items = new Int32Array(N);
  for (let i = 0; i < N; i++) { const c = cellIdx[i]; items[cursor[c]++] = i; }

  ensurePairs(N * 4);
  let np = 0;
  for (let i = 0; i < N; i++) {
    const ri = R * GEN[i * G + GENE.rScale];
    const cx = cellIdx[i] % nx, cy = (cellIdx[i] / nx) | 0;
    for (let ddy = -1; ddy <= 1; ddy++) {
      const cyy = ((cy + ddy) % ny + ny) % ny;
      for (let ddx = -1; ddx <= 1; ddx++) {
        const cxx = ((cx + ddx) % nx + nx) % nx;
        const c = cyy * nx + cxx;
        for (let p = counts[c]; p < counts[c + 1]; p++) {
          const j = items[p]; if (j <= i) continue;            // each unordered pair once
          let dx = X[j] - X[i], dy = Y[j] - Y[i];
          if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
          if (dy > halfW) dy -= W; else if (dy < -halfW) dy += W;
          const d = Math.hypot(dx, dy);
          const rj = R * GEN[j * G + GENE.rScale];
          const rmax = ri > rj ? ri : rj;
          if (d >= rmax) continue;                             // neither perceives
          if (np >= pCap) { np = pCap; break; }
          pI[np] = i; pJ[np] = j; pD[np] = d;
          const u = d / rmax, w = (1 - u * u); pW[np] = w * w;
          pM[np] = (d < ri && d < rj) ? 1 : 0;
          np++;
        }
      }
    }
  }

  // nearest-first cap
  const cap = opts.lineCap || 20000;
  let order = null;
  if (np > cap) {
    order = Array.from({ length: np }, (_, k) => k).sort((a, b) => pD[a] - pD[b]);
    np = cap;
  }
  const { scale, ox, oy } = view;
  const idx = (k) => (order ? order[k] : k);

  // two passes to avoid per-line dash state changes: solid mutual, then dashed one-way
  for (let pass = 0; pass < 2; pass++) {
    ctx.setLineDash(pass === 0 ? [] : [3, 3]);
    for (let k = 0; k < np; k++) {
      const e = idx(k);
      if (pM[e] !== (pass === 0 ? 1 : 0)) continue;
      const i = pI[e], j = pJ[e], w = pW[e];
      let dx = X[j] - X[i], dy = Y[j] - Y[i];
      if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
      if (dy > halfW) dy -= W; else if (dy < -halfW) dy += W;
      const alpha = (0.06 + 0.34 * w) * (pass === 0 ? 1 : 0.5);
      const r = (rB[i] + rB[j]) >> 1, g = (gB[i] + gB[j]) >> 1, b = (bB[i] + bB[j]) >> 1;
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.lineWidth = 0.6 + 1.0 * w;
      ctx.beginPath();
      ctx.moveTo(ox + X[i] * scale, oy + Y[i] * scale);
      ctx.lineTo(ox + (X[i] + dx) * scale, oy + (Y[i] + dy) * scale); // min-image endpoint (draws the short way across the torus)
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

function drawHover(ctx, state, P, view, h) {
  const N = state.count, GEN = state.genome, R = P.R, W = P.world, halfW = W / 2;
  const X = state.x, Y = state.y, { scale, ox, oy } = view;
  const ri = R * GEN[h * G + GENE.rScale];
  // this cell's links at full alpha (brute force over N — one cell, cheap enough)
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(214,207,198,0.85)';
  ctx.lineWidth = 1.0;
  for (let j = 0; j < N; j++) {
    if (j === h) continue;
    let dx = X[j] - X[h], dy = Y[j] - Y[h];
    if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
    if (dy > halfW) dy -= W; else if (dy < -halfW) dy += W;
    const d = Math.hypot(dx, dy);
    const rj = R * GEN[j * G + GENE.rScale];
    if (d >= (ri > rj ? ri : rj)) continue;
    ctx.beginPath();
    ctx.moveTo(ox + X[h] * scale, oy + Y[h] * scale);
    ctx.lineTo(ox + (X[h] + dx) * scale, oy + (Y[h] + dy) * scale);
    ctx.stroke();
  }
  // amber ring on the hovered cell (the one non-data accent)
  ctx.strokeStyle = '#C9873A';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(ox + X[h] * scale, oy + Y[h] * scale, 5.5, 0, 6.283185307179586);
  ctx.stroke();
}
