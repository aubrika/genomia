// Renderer — Canvas 2D. Everything on screen is a readout of genotype. Color is
// semantic (similar genomes look similar); adjacency lines show that "touching"
// in continuous space is a continuous quantity. Kept separate from sim.js.

import { G, GENE, geneRanges, bodyRadius } from './sim.js';
import { makeRNG } from './prng.js';

// --- color -----------------------------------------------------------------
// Phenotype: hue=niche center, saturation=niche breadth, lightness=motility.
// A degenerate (grey) genome falls out literally grey — a useful diagnostic.
export function phenotypeHSL(genome, base, R) {
  let m = (genome[base + GENE.sLo] + genome[base + GENE.sHi]) / 2;
  if (m < 0) m = 0; else if (m > 6) m = 6;
  const hue = 210 - 195 * (m / 6);                    // 210° solitary → 15° crowd
  let br = genome[base + GENE.sHi] - genome[base + GENE.sLo];
  if (br < 0) br = 0; else if (br > 6) br = 6;
  const sat = 85 - 73 * (br / 6);                     // 85% specialist → 12% generalist
  let mot = genome[base + GENE.step] / (0.3 * R);
  if (mot < 0) mot = 0; else if (mot > 1) mot = 1;
  const light = 38 + 34 * mot;                        // 38% sessile → 72% motile
  return [hue, sat, light];
}

// Genealogy-tree color (memoised per species on state._spColor, cleared on reset).
// Each founder lineage gets a well-separated base hue. A GENUS split makes a big
// hue jump, so each genus is a distinct colour family; a species split within a
// genus makes a clear-but-smaller hue+lightness step. Step direction comes from the
// genome change (not a hash), so related clades cluster in colour and drift step-wise.
const PW = [0.9, -0.7, 0.6, -0.5, 0.8, 0.4, -0.6, 0.5, -0.8, 1.0, 0.7, -0.9]; // fixed projection weights spread step directions
export function speciesHSL(state, sp, ranges) {
  const cache = state._spColor;
  if (cache[sp]) return cache[sp];
  // Iterative (not recursive): a deep divergence chain could be thousands long, so
  // walk up to the nearest cached/founder ancestor, then fill colours top-down.
  const chain = [];
  let s = sp;
  while (s != null && s >= 0 && !cache[s]) { chain.push(s); s = state.spParent[s]; }
  for (let k = chain.length - 1; k >= 0; k--) {
    const id = chain[k], parent = state.spParent[id];
    if (parent == null || parent < 0) {
      const hue = ((state.spLineage[id] * 137.508) % 360 + 360) % 360; // distinct base per founder lineage
      cache[id] = [hue, 64, 55];
    } else {
      const pc = cache[parent];                 // already filled (ancestor, done earlier this pass or previously cached)
      const ref = state.spRef[id], pref = state.spRef[parent];
      let proj = 0;
      for (let g = 0; g < G; g++) proj += ((ref[g] - pref[g]) / (ranges[g][1] - ranges[g][0])) * PW[g];
      const t = Math.tanh(proj);
      if (state.spBig[id]) {                     // new genus: big hue jump into a fresh colour family
        const hue = ((pc[0] + (t >= 0 ? 1 : -1) * (80 + 44 * Math.abs(t))) % 360 + 360) % 360;
        cache[id] = [hue, 64, 56];
      } else {                                   // species within a genus: clear hue + lightness step
        // a minimum step so every split is visible, larger for bigger divergences
        const hue = ((pc[0] + (t >= 0 ? 1 : -1) * (18 + 30 * Math.abs(t))) % 360 + 360) % 360;
        const light = Math.max(36, Math.min(78, pc[2] + (t >= 0 ? 9 : -9)));
        cache[id] = [hue, 64, light];
      }
    }
  }
  return cache[sp];
}

// Trophic color: hue reads the trophic gene (green autotroph "plant" -> red
// heterotroph "animal"), lightness reads current energy (bright = well-fed). Makes
// an emergent plant/animal split visible at a glance, and dying/starving cells dim.
export function trophicHSL(genome, base, en, emax) {
  const t = genome[base + GENE.trophic];
  const hue = 130 + 220 * t;                 // 130° green (plant) → 350° red (animal)
  let light = 52;
  if (emax > 0) { let f = en / emax; if (f < 0) f = 0; else if (f > 1) f = 1; light = 30 + 42 * f; }
  return [hue, 68, light];
}

// Shape. Size is the cell's body (sim.js bodyRadius: reach and fertility). The polygon
// is a per-SPECIES trait read from the species' reference genome, so each species keeps
// one consistent shape: a species with strong pack instinct (align ≥ 0.5) is a triangle
// pointing along its heading — you can see which way a pack is going — and otherwise
// sociability picks square (shuns crowds), pentagon, hexagon or circle (seeks crowds).
// Other polygons get a per-cell rotation from their own genome. 0 sides = circle.
export const SHAPE_SIDES = [4, 5, 6, 0];
export function speciesSides(state, sp) {
  const ref = state.spRef[sp];
  if (!ref) return 0;
  if (ref[GENE.align] >= 0.5) return 3;
  const k = Math.floor((ref[GENE.taxis] + 1) / 2 * SHAPE_SIDES.length);
  return SHAPE_SIDES[k < 0 ? 0 : k >= SHAPE_SIDES.length ? SHAPE_SIDES.length - 1 : k];
}
// Rotation of the first vertex: a triangle's points along the cell's heading.
export function cellRotation(state, i, sides, R) {
  if (sides === 3) return state.heading[i];
  const genome = state.genome, base = i * G;
  let v = genome[base + GENE.dCV] * 7.31 + genome[base + GENE.dDisp] / R * 3.07 + genome[base + GENE.fecundity] * 17.3;
  v -= Math.floor(v);
  return v * 6.283185307179586;
}
export const SHAPE_NAMES = { 3: 'triangle', 4: 'square', 5: 'pentagon', 6: 'hexagon', 0: 'circle' };

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

// The resource field, drawn in the same flat-disc-and-line language as the cells:
// a fairly uniform but organic scatter of "flora" marks (grass/moss dots, the odd
// flower) whose size and brightness follow the local resource and vanish where the
// population has grazed. The marks are on a jittered (non-aligned) grid, so the
// distribution reads organic with no blocky grid.

// Static flora marks on a jittered (non-aligned) grid: x, y, base radius, colour tint,
// and an occasional "flower" flag. Pure — callers cache by (size, seed). Shared by both
// renderers so the flora look identical.
export function makeFlora(Wx, Wy, seed) {
  const spacing = 15;                                    // ~world units (CSS px) between flora
  const gx = Math.max(1, Math.floor(Wx / spacing)), gy = Math.max(1, Math.floor(Wy / spacing));
  const n = gx * gy, arr = new Float32Array(n * 5);      // x, y, size, tint, kind(0 grass/1 flower)
  const rng = makeRNG((seed ^ 0x1b56c4e9) >>> 0);
  const cellW = Wx / gx, cellH = Wy / gy;
  let k = 0;
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      arr[k * 5] = (i + 0.5 + (rng.next() - 0.5) * 1.6) * cellW; // ±0.8 cell jitter → organic, non-grid
      arr[k * 5 + 1] = (j + 0.5 + (rng.next() - 0.5) * 1.6) * cellH;
      arr[k * 5 + 2] = 0.8 + rng.next() * 1.3;           // base radius
      arr[k * 5 + 3] = rng.next() * 2 - 1;               // colour tint
      arr[k * 5 + 4] = rng.next() < 0.05 ? 1 : 0;        // occasional flower
      k++;
    }
  }
  return { arr, n };
}

// Canvas-2D renderer's cached flora.
let flora = null, floraN = 0, floraKey = '';
function ensureFlora(Wx, Wy, seed) {
  const key = Wx + 'x' + Wy + '@' + seed;
  if (key === floraKey && flora) return;
  floraKey = key;
  const f = makeFlora(Wx, Wy, seed); flora = f.arr; floraN = f.n;
}

// Bilinear sample of resource-remaining (F normalized by max capacity) at world (wx,wy).
export function sampleField(F, fnx, fny, Wx, Wy, inv, wx, wy) {
  const fu = wx / Wx * fnx - 0.5, fv = wy / Wy * fny - 0.5;
  const ix = Math.floor(fu), iy = Math.floor(fv), rx = fu - ix, ry = fv - iy;
  const x0 = ((ix % fnx) + fnx) % fnx, x1 = (x0 + 1) % fnx, y0 = ((iy % fny) + fny) % fny, y1 = (y0 + 1) % fny;
  const a = F[y0 * fnx + x0], b = F[y0 * fnx + x1], c = F[y1 * fnx + x0], d = F[y1 * fnx + x1];
  return ((a * (1 - rx) + b * rx) * (1 - ry) + (c * (1 - rx) + d * rx) * ry) * inv;
}

function drawField(ctx, state, P, view) {
  const F = state.field, K = state.fieldK, fnx = state.fieldNX, fny = state.fieldNY;
  if (!F) return;
  const Wx = P.worldW != null ? P.worldW : P.world, Wy = P.worldH != null ? P.worldH : P.world;
  ensureFlora(Wx, Wy, state._fieldSeed >>> 0);
  let kmax = 1e-3;
  for (let c = 0; c < K.length; c++) if (K[c] > kmax) kmax = K[c];
  const inv = 1 / kmax;

  // flora marks — kept dim and olive (not the vivid green of the plant particles) so
  // the living discs read clearly on top; brightness/size follow the local resource.
  for (let k = 0; k < floraN; k++) {
    const x = flora[k * 5], y = flora[k * 5 + 1];
    const v = sampleField(F, fnx, fny, Wx, Wy, inv, x, y);   // resource remaining here, 0..1
    if (v <= 0.07) continue;                                  // grazed/bare → no flora
    const tint = flora[k * 5 + 3], size = flora[k * 5 + 2] * (0.4 + 0.7 * v), flower = flora[k * 5 + 4];
    let r, g, b;
    if (flower) { r = 150 + 45 * tint; g = 104 + 24 * tint; b = 60; }        // warm flower speck
    else { r = 58 + 22 * tint; g = 82 + 26 * v; b = 34 + 10 * tint; }        // olive grass/moss, lusher where rich
    const a = 0.16 + 0.42 * v;
    ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, 6.283185307179586);
    ctx.fill();
  }
}

export function draw(ctx, state, P, view, opts) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, cw, ch);
  // Everything below draws in world coordinates (CSS px); the view transform maps them
  // to backing-store pixels, so radii and line widths stay crisp at any devicePixelRatio.
  ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
  if (P.energyOn) drawField(ctx, state, P, view);

  const N = state.count, GEN = state.genome, R = P.R;
  ensureColor(state.cap);
  const treeMode = opts.colorMode === 'lineage';
  const trophicMode = opts.colorMode === 'trophic';
  const ranges = treeMode ? geneRanges(R) : null;
  const emax = P.energyOn ? P.energyMax : 0, EN = state.energy;

  // per-agent RGB for this frame
  for (let i = 0; i < N; i++) {
    const base = i * G;
    const hsl = treeMode ? speciesHSL(state, state.species[i], ranges)
      : trophicMode ? trophicHSL(GEN, base, EN[i], emax)
        : phenotypeHSL(GEN, base, R);
    const rgb = hslToRgb(hsl[0], hsl[1], hsl[2]);
    rB[i] = rgb[0]; gB[i] = rgb[1]; bB[i] = rgb[2];
  }

  if (opts.showLines && N > 1) drawLines(ctx, state, P, view, opts);

  // cells: filled polygons / circles at body size, no stroke
  const X = state.x, Y = state.y, shapes = opts.shapes !== false;
  for (let i = 0; i < N; i++) {
    const base = i * G, r = bodyRadius(GEN, base, R), sides = shapes ? speciesSides(state, state.species[i]) : 0;
    ctx.fillStyle = `rgb(${rB[i]},${gB[i]},${bB[i]})`;
    ctx.beginPath();
    if (sides === 0) ctx.arc(X[i], Y[i], r, 0, 6.283185307179586);
    else {
      const rot = cellRotation(state, i, sides, R), step = 6.283185307179586 / sides;
      for (let k = 0; k < sides; k++) { const a = rot + k * step; k ? ctx.lineTo(X[i] + r * Math.cos(a), Y[i] + r * Math.sin(a)) : ctx.moveTo(X[i] + r * Math.cos(a), Y[i] + r * Math.sin(a)); }
      ctx.closePath();
    }
    ctx.fill();
  }

  if (opts.hovered != null && opts.hovered >= 0 && opts.hovered < N) drawHover(ctx, state, P, view, opts.hovered);
}

// Build adjacency pairs (each unordered pair once) on a uniform grid, with a
// nearest-first cap. Fills module scratch: pI/pJ endpoints, pW kernel weight, pM
// mutual flag; returns those plus an optional nearest-first `order` and the count np.
// Shared by the Canvas-2D and WebGL renderers.
export function computePairs(state, P, lineCap) {
  const N = state.count, GEN = state.genome, R = P.R;
  const Wx = P.worldW != null ? P.worldW : P.world, Wy = P.worldH != null ? P.worldH : P.world;
  const halfWx = Wx / 2, halfWy = Wy / 2;
  const X = state.x, Y = state.y;
  const bucket = R * 1.5;
  const nx = Math.max(1, Math.ceil(Wx / bucket)), ny = Math.max(1, Math.ceil(Wy / bucket)), nc = nx * ny;
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
          if (dx > halfWx) dx -= Wx; else if (dx < -halfWx) dx += Wx;
          if (dy > halfWy) dy -= Wy; else if (dy < -halfWy) dy += Wy;
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
  const cap = lineCap || 20000;
  let order = null;
  if (np > cap) { order = Array.from({ length: np }, (_, k) => k).sort((a, b) => pD[a] - pD[b]); np = cap; }
  return { pI, pJ, pW, pM, order, np };
}

function drawLines(ctx, state, P, view, opts) {
  const { pI, pJ, pW, pM, order, np } = computePairs(state, P, opts.lineCap);
  const Wx = P.worldW != null ? P.worldW : P.world, Wy = P.worldH != null ? P.worldH : P.world;
  const halfWx = Wx / 2, halfWy = Wy / 2, X = state.x, Y = state.y;
  const idx = (k) => (order ? order[k] : k);

  // two passes to avoid per-line dash state changes: solid mutual, then dashed one-way
  for (let pass = 0; pass < 2; pass++) {
    ctx.setLineDash(pass === 0 ? [] : [3, 3]);
    for (let k = 0; k < np; k++) {
      const e = idx(k);
      if (pM[e] !== (pass === 0 ? 1 : 0)) continue;
      const i = pI[e], j = pJ[e], w = pW[e];
      let dx = X[j] - X[i], dy = Y[j] - Y[i];
      if (dx > halfWx) dx -= Wx; else if (dx < -halfWx) dx += Wx;
      if (dy > halfWy) dy -= Wy; else if (dy < -halfWy) dy += Wy;
      const alpha = (0.06 + 0.34 * w) * (pass === 0 ? 1 : 0.5);
      const r = (rB[i] + rB[j]) >> 1, g = (gB[i] + gB[j]) >> 1, b = (bB[i] + bB[j]) >> 1;
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.lineWidth = 0.6 + 1.0 * w;
      ctx.beginPath();
      ctx.moveTo(X[i], Y[i]);
      ctx.lineTo(X[i] + dx, Y[i] + dy); // min-image endpoint (draws the short way across the torus)
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

function drawHover(ctx, state, P, view, h) {
  const N = state.count, GEN = state.genome, R = P.R;
  const Wx = P.worldW != null ? P.worldW : P.world, Wy = P.worldH != null ? P.worldH : P.world;
  const halfWx = Wx / 2, halfWy = Wy / 2;
  const X = state.x, Y = state.y;
  const ri = R * GEN[h * G + GENE.rScale];
  // this cell's links at full alpha (brute force over N — one cell, cheap enough)
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(214,207,198,0.85)';
  ctx.lineWidth = 1.0;
  for (let j = 0; j < N; j++) {
    if (j === h) continue;
    let dx = X[j] - X[h], dy = Y[j] - Y[h];
    if (dx > halfWx) dx -= Wx; else if (dx < -halfWx) dx += Wx;
    if (dy > halfWy) dy -= Wy; else if (dy < -halfWy) dy += Wy;
    const d = Math.hypot(dx, dy);
    const rj = R * GEN[j * G + GENE.rScale];
    if (d >= (ri > rj ? ri : rj)) continue;
    ctx.beginPath();
    ctx.moveTo(X[h], Y[h]);
    ctx.lineTo(X[h] + dx, Y[h] + dy);
    ctx.stroke();
  }
  // amber ring on the hovered cell (the one non-data accent)
  ctx.strokeStyle = '#C9873A';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(X[h], Y[h], bodyRadius(GEN, h * G, R) + 3, 0, 6.283185307179586);
  ctx.stroke();
}
