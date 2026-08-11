// Genomic Particle Life — simulation core.
//
// DOM-free by contract: this module knows nothing about canvas, events, or the
// document. It exports pure-ish operations over a Structure-of-Arrays `state`
// (typed arrays for 8k+ agents at 60fps) plus a seeded PRNG carried in the state.
// Written to be ported to Rust later — no closures over host objects, no globals.

import { makeRNG } from './prng.js';

export const G = 10; // genes per agent
export const GENE = {
  rScale: 0, sLo: 1, sHi: 2, bLo: 3, bHi: 4,
  fecundity: 5, dDisp: 6, dCV: 7, step: 8, taxis: 9,
};
export const GENE_NAMES = ['rScale', 'sLo', 'sHi', 'bLo', 'bHi', 'fecundity', 'dDisp', 'dCV', 'step', 'taxis'];

// Gene ranges. dDisp and step scale with the global interaction radius R, so the
// dispersal/motility genes are always expressed relative to perception distance.
export function geneRanges(R) {
  return [
    [0.5, 1.5],   // rScale
    [0, 6],       // sLo
    [0, 12],      // sHi
    [0, 6],       // bLo
    [0, 12],      // bHi
    [0, 0.30],    // fecundity
    [0.2 * R, 3 * R], // dDisp
    [0, 1.0],     // dCV
    [0, 0.3 * R], // step
    [-1, 1],      // taxis
  ];
}

export const DEFAULTS = {
  world: 1000, R: 17, sigma: 0.6,
  costsOn: true, kMove: 0.4, kSense: 0.3, kTol: 0.5, kTaxis: 0.2,
  recomb: 'crossover', mutation: 'gaussian', mu: 0.1, sigmaG: 0.05, kappa: 0.15,
  // Lineage = founder identity (which brush); inherited unchanged forever.
  // Species = divergence-based subdivisions within a lineage.
  speciesThreshold: 0.16, // genetic distance from a species' founding genome at which an offspring founds a NEW species (same lineage). 0 = off.
  isolation: 0,           // reproductive isolation: a crossover mate must be within this genetic distance. 0 = off (mate with any neighbor).
  maxAgeOn: false, maxAge: 400,
  cap: 12000,
};

// Normalized genetic distance: RMS of per-gene differences scaled by each gene's
// range, so it sits in ~[0,1] and every gene contributes comparably.
function geneDist(A, ao, B, bo, ranges) {
  let s = 0;
  for (let g = 0; g < G; g++) { const r = ranges[g][1] - ranges[g][0]; const d = (A[ao + g] - B[bo + g]) / r; s += d * d; }
  return Math.sqrt(s / G);
}

// Register a new species: records its founding genome, founder lineage, and parent
// species (-1 for a founder). Genealogy only — never read by the dynamics.
export function foundSpecies(state, genome, off, lineageId, parent) {
  const id = state.nextSpecies++;
  const ref = new Float32Array(G);
  for (let g = 0; g < G; g++) ref[g] = genome[off + g];
  state.spRef[id] = ref; state.spLineage[id] = lineageId; state.spParent[id] = parent;
  return id;
}

function smoothstep(a, b, x) {
  if (a === b) return x < a ? 0 : 1;
  let t = (x - a) / (b - a);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

function wrap(v, W) {
  v %= W;
  if (v < 0) v += W;
  return v;
}

export function createState(cap) {
  return {
    cap, count: 0, tick: 0, nextLineage: 1,
    x: new Float32Array(cap), y: new Float32Array(cap),
    age: new Float32Array(cap), lineage: new Int32Array(cap),
    genome: new Float32Array(cap * G),
    species: new Int32Array(cap),
    // species registry (grows with divergence): founding genome, parent species, founder lineage
    spRef: [], spParent: [], spLineage: [], nextSpecies: 0,
    _spColor: [],   // renderer-owned color cache, keyed by species id; cleared on reset
    rng: makeRNG(1),
    _scratch: null, _rangesR: -1, _ranges: null,
  };
}

export function resetState(state, seed) {
  state.count = 0; state.tick = 0; state.nextLineage = 1;
  state.spRef = []; state.spParent = []; state.spLineage = []; state.nextSpecies = 0; state._spColor = [];
  state.rng = makeRNG(seed >>> 0);
}

// Clamp every gene into range and enforce sLo<=sHi, bLo<=bHi (swap if inverted).
export function clampGene(genome, base, ranges) {
  for (let g = 0; g < G; g++) {
    let v = genome[base + g];
    const lo = ranges[g][0], hi = ranges[g][1];
    if (v < lo) v = lo; else if (v > hi) v = hi;
    genome[base + g] = v;
  }
  if (genome[base + GENE.sLo] > genome[base + GENE.sHi]) {
    const t = genome[base + GENE.sLo]; genome[base + GENE.sLo] = genome[base + GENE.sHi]; genome[base + GENE.sHi] = t;
  }
  if (genome[base + GENE.bLo] > genome[base + GENE.bHi]) {
    const t = genome[base + GENE.bLo]; genome[base + GENE.bLo] = genome[base + GENE.bHi]; genome[base + GENE.bHi] = t;
  }
}

// Place one agent. lineageId null => fresh founder lineage; speciesId null => found
// a fresh species from this genome (hand-placed cells that don't share a brush).
export function addAgent(state, x, y, genomeArr, lineageId, ranges, speciesId) {
  if (state.count >= state.cap) return -1;
  const i = state.count++;
  state.x[i] = x; state.y[i] = y; state.age[i] = 0;
  state.lineage[i] = lineageId != null ? lineageId : state.nextLineage++;
  const base = i * G;
  for (let g = 0; g < G; g++) state.genome[base + g] = genomeArr[g];
  clampGene(state.genome, base, ranges);
  state.species[i] = speciesId != null ? speciesId : foundSpecies(state, state.genome, base, state.lineage[i], -1);
  return i;
}

function ensureScratch(state) {
  let s = state._scratch;
  const cap = state.cap;
  if (!s) {
    s = state._scratch = {
      n: new Float32Array(cap), gx: new Float32Array(cap), gy: new Float32Array(cap),
      survive: new Uint8Array(cap), cellIdx: new Int32Array(cap), items: new Int32Array(cap),
      bx: new Float32Array(cap), by: new Float32Array(cap), bl: new Int32Array(cap), bspecies: new Int32Array(cap),
      bg: new Float32Array(cap * G),
      counts: null, cursor: null,
    };
  }
  return s;
}

function ranges(state, P) {
  if (state._rangesR !== P.R) { state._ranges = geneRanges(P.R); state._rangesR = P.R; }
  return state._ranges;
}

// Weighted-reservoir pick of a second parent among the emitter's perceived
// neighbors (kernel weight = perception strength). Returns index or -1 if alone.
function pickSecondParent(state, i, rng, counts, items, cellIdx, nx, ny, Wx, Wy, P, rr) {
  const R = P.R, base = i * G, iso = P.isolation;
  const ri = R * state.genome[base + GENE.rScale], ri2 = ri * ri;
  const xi = state.x[i], yi = state.y[i], halfWx = Wx / 2, halfWy = Wy / 2;
  const cx = cellIdx[i] % nx, cy = (cellIdx[i] / nx) | 0;
  let total = 0, chosen = -1;
  for (let ddy = -1; ddy <= 1; ddy++) {
    const cyy = ((cy + ddy) % ny + ny) % ny;
    for (let ddx = -1; ddx <= 1; ddx++) {
      const cxx = ((cx + ddx) % nx + nx) % nx;
      const c = cyy * nx + cxx;
      for (let p = counts[c]; p < counts[c + 1]; p++) {
        const j = items[p]; if (j === i) continue;
        let dx = state.x[j] - xi, dy = state.y[j] - yi;
        if (dx > halfWx) dx -= Wx; else if (dx < -halfWx) dx += Wx;
        if (dy > halfWy) dy -= Wy; else if (dy < -halfWy) dy += Wy;
        const d2 = dx * dx + dy * dy;
        if (d2 < ri2) {
          // reproductive isolation: skip mates too genetically distant
          if (iso > 0 && geneDist(state.genome, base, state.genome, j * G, rr) > iso) continue;
          const wj = 1 - d2 / ri2, wgt = wj * wj;
          total += wgt;
          if (rng.next() * total < wgt) chosen = j;
        }
      }
    }
  }
  return chosen;
}

function mutate(bg, off, rng, P, rr) {
  const mu = P.mu, sg = P.sigmaG;
  for (let g = 0; g < G; g++) {
    if (rng.next() < mu) bg[off + g] += rng.gauss() * sg * (rr[g][1] - rr[g][0]);
  }
  if (P.mutation === 'cornered') {
    const k = P.kappa;
    const thr = [GENE.sLo, GENE.sHi, GENE.bLo, GENE.bHi];
    for (let t = 0; t < thr.length; t++) {
      const g = thr[t], lo = rr[g][0], hi = rr[g][1], mid = (lo + hi) / 2;
      const end = bg[off + g] < mid ? lo : hi;
      bg[off + g] += k * (end - bg[off + g]);
    }
  }
}

function buildOffspring(state, i, rng, P, rr, bg, off, counts, items, cellIdx, nx, ny, Wx, Wy) {
  const base = i * G, GEN = state.genome, mode = P.recomb;
  for (let g = 0; g < G; g++) bg[off + g] = GEN[base + g];
  if (mode !== 'clonal') {
    const j = pickSecondParent(state, i, rng, counts, items, cellIdx, nx, ny, Wx, Wy, P, rr);
    if (j >= 0) {
      const bj = j * G;
      if (mode === 'crossover') {
        for (let g = 0; g < G; g++) if (rng.next() < 0.5) bg[off + g] = GEN[bj + g];
      } else { // blend: arithmetic mean, gene by gene (halves variance each gen)
        for (let g = 0; g < G; g++) bg[off + g] = 0.5 * (GEN[base + g] + GEN[bj + g]);
      }
    }
  }
  mutate(bg, off, rng, P, rr);
  clampGene(bg, off, rr);
}

// One strictly-synchronous tick: densities from tick-start positions, then death,
// then birth, then movement. Earlier agents never see later agents' effects.
export function step(state, P) {
  // Rectangular torus: worldW/worldH if present (the app fills the window),
  // else a square `world` (the headless tests).
  const Wx = P.worldW != null ? P.worldW : P.world, Wy = P.worldH != null ? P.worldH : P.world;
  const R = P.R, N = state.count;
  const rr = ranges(state, P);
  const rng = state.rng;
  const s = ensureScratch(state);
  const { n, gx, gy, survive } = s;
  const X = state.x, Y = state.y, GEN = state.genome, AGE = state.age, LIN = state.lineage, SPE = state.species;

  // 1. Uniform-grid spatial index. Bucket = R*1.5 = max perception radius, so a
  //    3x3 bucket neighborhood always covers any cell's r_i.
  const bucket = R * 1.5;
  const nx = Math.max(1, Math.ceil(Wx / bucket)), ny = Math.max(1, Math.ceil(Wy / bucket)), nc = nx * ny;
  let counts = s.counts;
  if (!counts || counts.length < nc + 1) { counts = s.counts = new Int32Array(nc + 1); s.cursor = new Int32Array(nc); }
  else counts.fill(0, 0, nc + 1);
  let cursor = s.cursor;
  if (cursor.length < nc) cursor = s.cursor = new Int32Array(nc);
  const cellIdx = s.cellIdx, items = s.items;
  for (let i = 0; i < N; i++) {
    let cx = (X[i] / bucket) | 0; if (cx >= nx) cx = nx - 1; else if (cx < 0) cx = 0;
    let cy = (Y[i] / bucket) | 0; if (cy >= ny) cy = ny - 1; else if (cy < 0) cy = 0;
    const c = cy * nx + cx; cellIdx[i] = c; counts[c + 1]++;
  }
  for (let c = 0; c < nc; c++) counts[c + 1] += counts[c];
  for (let c = 0; c < nc; c++) cursor[c] = counts[c];
  for (let i = 0; i < N; i++) { const c = cellIdx[i]; items[cursor[c]++] = i; }

  // 2. Density n_i (kernel-weighted count) and normalized gradient direction ĝ_i.
  const halfWx = Wx / 2, halfWy = Wy / 2;
  for (let i = 0; i < N; i++) {
    const base = i * G;
    const ri = R * GEN[base + GENE.rScale], ri2 = ri * ri;
    const xi = X[i], yi = Y[i];
    const cx = cellIdx[i] % nx, cy = (cellIdx[i] / nx) | 0;
    let acc = 0, agx = 0, agy = 0;
    for (let ddy = -1; ddy <= 1; ddy++) {
      const cyy = ((cy + ddy) % ny + ny) % ny;
      for (let ddx = -1; ddx <= 1; ddx++) {
        const cxx = ((cx + ddx) % nx + nx) % nx;
        const c = cyy * nx + cxx;
        for (let p = counts[c]; p < counts[c + 1]; p++) {
          const j = items[p]; if (j === i) continue;
          let dx = X[j] - xi, dy = Y[j] - yi;
          if (dx > halfWx) dx -= Wx; else if (dx < -halfWx) dx += Wx;
          if (dy > halfWy) dy -= Wy; else if (dy < -halfWy) dy += Wy;
          const d2 = dx * dx + dy * dy;
          if (d2 < ri2) {
            const wj = 1 - d2 / ri2, wgt = wj * wj; // (1 - u^2)^2
            acc += wgt;
            const d = Math.sqrt(d2);
            if (d > 1e-9) { const inv = wgt / d; agx += inv * dx; agy += inv * dy; }
          }
        }
      }
    }
    n[i] = acc;
    const gl = Math.hypot(agx, agy);
    if (gl > 1e-12) { gx[i] = agx / gl; gy[i] = agy / gl; } else { gx[i] = 0; gy[i] = 0; }
  }

  // 3. Death — probabilistic with soft band edges.
  const sigma = P.sigma, maxAgeOn = P.maxAgeOn, maxAge = P.maxAge;
  for (let i = 0; i < N; i++) {
    const base = i * G, ni = n[i];
    const pSurv = smoothstep(GEN[base + GENE.sLo] - sigma, GEN[base + GENE.sLo] + sigma, ni)
      * (1 - smoothstep(GEN[base + GENE.sHi] - sigma, GEN[base + GENE.sHi] + sigma, ni));
    let alive = rng.next() < pSurv;
    if (alive && maxAgeOn && AGE[i] >= maxAge) alive = false;
    survive[i] = alive ? 1 : 0;
  }

  // 4. Birth — survivors inside the (soft) birth band emit one offspring at f_eff.
  let bc = 0;
  const bx = s.bx, by = s.by, bg = s.bg, bl = s.bl, bspecies = s.bspecies;
  const spThr = P.speciesThreshold;
  for (let i = 0; i < N; i++) {
    if (!survive[i]) continue;
    const base = i * G, ni = n[i];
    const win = smoothstep(GEN[base + GENE.bLo] - sigma, GEN[base + GENE.bLo] + sigma, ni)
      * (1 - smoothstep(GEN[base + GENE.bHi] - sigma, GEN[base + GENE.bHi] + sigma, ni));
    if (win <= 0) continue;
    let feff = GEN[base + GENE.fecundity];
    if (P.costsOn) {
      const st = GEN[base + GENE.step], rs = GEN[base + GENE.rScale], tx = GEN[base + GENE.taxis];
      const tol = ((GEN[base + GENE.sHi] - GEN[base + GENE.sLo]) + (GEN[base + GENE.bHi] - GEN[base + GENE.bLo])) / 12;
      const cost = P.kMove * (st / R) * (st / R) + P.kSense * rs * rs + P.kTol * tol + P.kTaxis * tx * tx;
      feff *= Math.exp(-cost);
    }
    if (rng.next() >= feff * win) continue;
    if (state.count + bc >= P.cap) continue; // reject births at the hard cap
    buildOffspring(state, i, rng, P, rr, bg, bc * G, counts, items, cellIdx, nx, ny, Wx, Wy);
    const ang = rng.next() * 6.283185307179586;
    const dd = GEN[base + GENE.dDisp], cv = GEN[base + GENE.dCV];
    const dist = Math.abs(dd + dd * cv * rng.gauss());
    bx[bc] = wrap(X[i] + Math.cos(ang) * dist, Wx);
    by[bc] = wrap(Y[i] + Math.sin(ang) * dist, Wy);
    bl[bc] = LIN[i];                       // lineage (founder) is inherited unchanged
    // species: if the offspring has drifted past the threshold from its species'
    // founding genome, it founds a new species within the same lineage.
    const psp = SPE[i];
    bspecies[bc] = (spThr > 0 && geneDist(bg, bc * G, state.spRef[psp], 0, rr) > spThr)
      ? foundSpecies(state, bg, bc * G, LIN[i], psp) : psp;
    bc++;
  }

  // 5. Movement — blended random walk + density taxis, scaled by `step`.
  for (let i = 0; i < N; i++) {
    if (!survive[i]) continue;
    const base = i * G, st = GEN[base + GENE.step], tx = GEN[base + GENE.taxis];
    const ang = rng.next() * 6.283185307179586;
    const rxu = Math.cos(ang), ryu = Math.sin(ang), at = Math.abs(tx);
    let dx = (1 - at) * rxu + tx * gx[i];
    let dy = (1 - at) * ryu + tx * gy[i];
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-9) { dx /= dl; dy /= dl; } else { dx = rxu; dy = ryu; }
    X[i] = wrap(X[i] + dx * st, Wx); Y[i] = wrap(Y[i] + dy * st, Wy);
    AGE[i] += 1;
  }

  // 6. Compact survivors to the front, then append offspring.
  let w = 0;
  for (let i = 0; i < N; i++) {
    if (!survive[i]) continue;
    if (w !== i) {
      X[w] = X[i]; Y[w] = Y[i]; AGE[w] = AGE[i]; LIN[w] = LIN[i]; SPE[w] = SPE[i];
      const ws = w * G, bs = i * G;
      for (let g = 0; g < G; g++) GEN[ws + g] = GEN[bs + g];
    }
    w++;
  }
  for (let b = 0; b < bc; b++) {
    if (w >= state.cap) break;
    X[w] = bx[b]; Y[w] = by[b]; AGE[w] = 0; LIN[w] = bl[b]; SPE[w] = bspecies[b];
    const ws = w * G, bsrc = b * G;
    for (let g = 0; g < G; g++) GEN[ws + g] = bg[bsrc + g];
    w++;
  }
  state.count = w;
  state.tick++;
  return state;
}

// Population statistics — DOM-free so the harness and any Rust port share it.
export function computeStats(state, P) {
  const N = state.count, GEN = state.genome, rr = ranges(state, P);
  const mean = new Float64Array(G), m2 = new Float64Array(G);
  for (let i = 0; i < N; i++) { const base = i * G; for (let g = 0; g < G; g++) mean[g] += GEN[base + g]; }
  if (N > 0) for (let g = 0; g < G; g++) mean[g] /= N;
  for (let i = 0; i < N; i++) { const base = i * G; for (let g = 0; g < G; g++) { const d = GEN[base + g] - mean[g]; m2[g] += d * d; } }
  const sd = new Float64Array(G);
  let vi = 0;
  for (let g = 0; g < G; g++) {
    const v = N > 0 ? m2[g] / N : 0;
    sd[g] = Math.sqrt(v);
    const rg = rr[g][1] - rr[g][0];
    vi += v / (rg * rg);
  }
  vi /= G;
  const seen = new Set(), spSeen = new Set();
  for (let i = 0; i < N; i++) { seen.add(state.lineage[i]); spSeen.add(state.species[i]); }
  return { population: N, mean, sd, varianceIndex: vi, lineages: seen.size, species: spSeen.size };
}
