// Genomia — simulation core.
//
// DOM-free by contract: this module knows nothing about canvas, events, or the
// document. It exports pure-ish operations over a Structure-of-Arrays `state`
// (typed arrays for 8k+ agents at 60fps) plus a seeded PRNG carried in the state.
// Written to be ported to Rust later — no closures over host objects, no globals.

import { makeRNG } from './prng.js';

export const G = 13; // genes per agent
export const GENE = {
  rScale: 0, sLo: 1, sHi: 2, bLo: 3, bHi: 4,
  fecundity: 5, dDisp: 6, dCV: 7, step: 8, taxis: 9,
  trophic: 10, align: 11, body: 12,
};
export const GENE_NAMES = ['rScale', 'sLo', 'sHi', 'bLo', 'bHi', 'fecundity', 'dDisp', 'dCV', 'step', 'taxis', 'trophic', 'align', 'body'];

// Gene ranges. dDisp and step scale with the global interaction radius R, so the
// dispersal/motility genes are always expressed relative to perception distance.
export function geneRanges(R) {
  return [
    [0.5, 1.5],   // rScale
    [0, 6],       // sLo
    [0, 6],       // sHi — overcrowding ceiling: max density a cell can survive. Capped (was 12) so
                  //       cells can't evolve to tolerate extreme crowding; dense clumps self-limit.
    [0, 6],       // bLo
    [0, 6],       // bHi
    [0, 0.30],    // fecundity
    [0.2 * R, 3 * R], // dDisp
    [0, 1.0],     // dCV
    [0, 0.3 * R], // step
    [-1, 1],      // taxis
    [0, 1],       // trophic: 0 = pure autotroph (feed on the field), 1 = pure heterotroph (feed on other cells)
    [0, 1],       // align: 0 = moves on a fresh random heading each tick, 1 = steers by its own heading, turned toward its neighbours' (flocking)
    [0, 1],       // body: body size, 0 = smallest (0.06R radius) to 1 = largest (0.35R)
  ];
}

export const DEFAULTS = {
  world: 1000, R: 17, sigma: 0.6,
  costsOn: true, kMove: 0.4, kSense: 0.3, kTol: 0.5, kTaxis: 0.2, kAlign: 0.1,
  headNoise: 0.3,         // heading jitter per tick (radians, ±): how wobbly a steering cell's course is
  kTolDeath: 0.055,       // generalist mortality: per-tick death chance added at a full-width survival window (costs on, energy off)
  bodiesOn: true,         // cells have solid bodies: births and moves can't overlap another cell's body
  recomb: 'crossover', mutation: 'gaussian', mu: 0.1, sigmaG: 0.05, kappa: 0.15,
  macroRate: 0.05,        // fraction of mutations that are outsized "knockouts" (re-roll the whole gene) rather than small nudges

  // Taxonomy, coarse -> fine: lineage (founder identity, inherited unchanged) >
  // genus (coarse divergence tier) > species (fine divergence tier). Both tiers are
  // divergence thresholds on genetic distance from the tier's founding genome.
  genusThreshold: 0.55,   // distance from a genus' founding genome at which an offspring founds a NEW genus. 0 = off.
  speciesThreshold: 0.30, // distance from a species' founding genome at which an offspring founds a NEW species. 0 = off.
  isolation: 0,           // reproductive isolation: a crossover mate must be within this genetic distance. 0 = off (mate with any neighbor).
  maxAgeOn: false, maxAge: 400,

  // Energy / trophic model (off by default; a whole separate layer). When on, cells
  // carry an energy budget: they PAY metabolic upkeep every tick (scaled by genome
  // complexity — "greater features cost more food"), FEED to refill it (autotrophs
  // harvest a noise-generated resource field directly, heterotrophs prey on nearby
  // cells), STARVE if it hits zero, and must bank enough energy to reproduce. The
  // `trophic` gene sets the autotroph/heterotroph mix, so disruptive selection can
  // split one lineage into "plant" and "animal" specialists — an emergent food chain.
  energyOn: false,
  fieldRes: 44,           // field grid resolution across the world's width
  fieldContrast: 0.7,     // spatial contrast of the resource gradient (0 = flat, 1 = very patchy)
  fieldRegrow: 0.20,      // per-tick refill of the field toward its local capacity ("sunlight"). Sets the
                          //   world's carrying capacity: sustainable plants ~= fieldRegrow*sum(K)/upkeep.
  autoGain: 1.1,          // autotroph harvest rate (energy gained per tick at a full field cell)
  predRate: 0.6,          // heterotroph predation rate (energy drained from a neighbor per tick)
  predGain: 0.6,          // fraction of drained energy the predator keeps (<1 = trophic loss)
  huntThreshold: 0,       // cooperative hunting: summed predation pressure a prey must be under for bites to
                          //   land fully (each bite lands (pressure/threshold)², capped at 1). 0 = off
  trophicExp: 1.8,        // specialization curve: >1 makes generalists inefficient, favoring the plant/animal split
  upkeep: 0.02,           // base metabolic drain per tick
  geneCost: 0.03,         // extra upkeep per unit genome complexity (perception, motility, tolerance, steering)
  birthCost: 2.0,         // energy a parent invests into each offspring (the child starts with it)
  energyMax: 12,          // cap on stored energy
  cap: 20000,             // soft population limit: births are rejected above it (<= MAXCAP)
  capOff: false,          // true = no soft limit; the population runs up to the MAXCAP buffer ceiling
};

// Physical buffer size the typed arrays are allocated to. The soft `cap` limits births
// below this; "unlimited" means running up to this ceiling (arrays can't grow past it,
// so births are still rejected here to protect memory and framerate).
export const MAXCAP = 50000;

// Normalized genetic distance: RMS of per-gene differences scaled by each gene's
// range, so it sits in ~[0,1] and every gene contributes comparably.
function geneDist(A, ao, B, bo, ranges) {
  let s = 0;
  for (let g = 0; g < G; g++) { const r = ranges[g][1] - ranges[g][0]; const d = (A[ao + g] - B[bo + g]) / r; s += d * d; }
  return Math.sqrt(s / G);
}

function copyGenome(genome, off) {
  const ref = new Float32Array(G);
  for (let g = 0; g < G; g++) ref[g] = genome[off + g];
  return ref;
}

// Register a new genus (coarse tier). parent = -1 for a founder.
export function foundGenus(state, genome, off, lineageId, parent) {
  const id = state.nextGenus++;
  state.gRef[id] = copyGenome(genome, off); state.gLineage[id] = lineageId; state.gParent[id] = parent;
  return id;
}

// Register a new species (fine tier). `genus` is its containing genus; `big` marks
// species that also founded a new genus (a large colour step). Genealogy only.
export function foundSpecies(state, genome, off, lineageId, parent, genus, big) {
  const id = state.nextSpecies++;
  state.spRef[id] = copyGenome(genome, off);       // follows the members (divergence tests)
  state.spFounder[id] = copyGenome(genome, off);   // fixed forever (the species' look)
  state.spLineage[id] = lineageId; state.spParent[id] = parent; state.spGenus[id] = genus; state.spBig[id] = big ? 1 : 0;
  return id;
}

// Found a fresh clade (genus + species) from one genome — for hand-placed cells /
// brush founders. Returns the species id (its genus is state.spGenus[id]).
export function foundClade(state, genome, off, lineageId) {
  const g = foundGenus(state, genome, off, lineageId, -1);
  return foundSpecies(state, genome, off, lineageId, -1, g, true);
}

// Body size — its own gene. Radius is in units of R (so it scales with the window like
// every other length): 0.06R–0.35R. With bodies on it is physical (cells can't overlap);
// the renderers draw each cell at exactly this radius.
export const BODY_MIN = 0.06, BODY_SPAN = 0.29;
export function bodyRadius(genome, base, R) {
  let b = genome[base + GENE.body];
  if (b < 0) b = 0; else if (b > 1) b = 1;
  return R * (BODY_MIN + BODY_SPAN * b);
}

// Occupancy grid for placing cells outside the step loop (seeding, painting): a sparse
// bucket map of bodies, so "is this spot free?" checks only nearby cells.
export function createOccupancy(state, P) {
  const Wx = P.worldW != null ? P.worldW : P.world, Wy = P.worldH != null ? P.worldH : P.world;
  // buckets at least as wide as the largest pair of bodies (0.70R), and all full width
  // (floor), so a 3x3 search also covers pairs across the wrap-around edge
  const c = P.R * 0.71, nx = Math.max(1, Math.floor(Wx / c)), ny = Math.max(1, Math.floor(Wy / c));
  const sx = nx / Wx, sy = ny / Wy;
  const buckets = new Map(), halfWx = Wx / 2, halfWy = Wy / 2;
  const key = (x, y) => (Math.min(ny - 1, Math.max(0, (y * sy) | 0))) * nx + Math.min(nx - 1, Math.max(0, (x * sx) | 0));
  const add = (x, y, r) => { const k = key(x, y); let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(x, y, r); };
  for (let i = 0; i < state.count; i++) add(state.x[i], state.y[i], bodyRadius(state.genome, i * G, P.R));
  const fits = (x, y, r) => {
    if (!P.bodiesOn) return true;
    const bx = Math.min(nx - 1, (x * sx) | 0), by = Math.min(ny - 1, (y * sy) | 0);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const b = buckets.get(((by + dy + ny) % ny) * nx + ((bx + dx + nx) % nx)); if (!b) continue;
      for (let k = 0; k < b.length; k += 3) {
        let ddx = b[k] - x, ddy = b[k + 1] - y;
        if (ddx > halfWx) ddx -= Wx; else if (ddx < -halfWx) ddx += Wx;
        if (ddy > halfWy) ddy -= Wy; else if (ddy < -halfWy) ddy += Wy;
        const rr = r + b[k + 2]; if (ddx * ddx + ddy * ddy < rr * rr) return false;
      }
    }
    return true;
  };
  return { fits, add };
}

// Reference tracking rates: how far a species' / genus' reference genome moves toward
// each offspring that stays in it. Large clades effectively track their mean genome.
const SPECIES_TRACK = 0.01, GENUS_TRACK = 0.002;
const BIRTH_TRIES = 4;   // landing directions an offspring tries before the birth fails (bodies on)
function track(ref, genome, off, rate) {
  for (let g = 0; g < G; g++) ref[g] += rate * (genome[off + g] - ref[g]);
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
    energy: new Float32Array(cap), energy0: 6,
    heading: new Float32Array(cap),   // direction of travel (radians); inherited by offspring
    // resource field (built lazily when the energy model runs): capacity from
    // spatial noise, current level regrows toward it and is grazed by autotrophs.
    field: null, fieldK: null, fieldNX: 0, fieldNY: 0, _fieldW: -1, _fieldH: -1, _fieldSeed: -1,
    // divergence registries (grow): species (fine) and genus (coarse) tiers
    spRef: [], spFounder: [], spParent: [], spLineage: [], spGenus: [], spBig: [], nextSpecies: 0,
    gRef: [], gParent: [], gLineage: [], nextGenus: 0,
    _spColor: [], _spHash: [],   // renderer-owned caches keyed by species id (genealogy colour, species hash); cleared on reset
    _hashPeak: null,   // leaderboard.js: each species hash's peak living count; cleared on reset
    rng: makeRNG(1),
    _scratch: null, _rangesR: -1, _ranges: null,
  };
}

export function resetState(state, seed) {
  state.count = 0; state.tick = 0; state.nextLineage = 1;
  state.spRef = []; state.spFounder = []; state.spParent = []; state.spLineage = []; state.spGenus = []; state.spBig = []; state.nextSpecies = 0;
  state.gRef = []; state.gParent = []; state.gLineage = []; state.nextGenus = 0;
  state._spColor = []; state._spHash = [];   // renderer caches (genealogy colours, species hashes)
  state._hashPeak = null;   // leaderboard peaks
  state._fieldW = -1; state._fieldH = -1; state._fieldSeed = -1;   // force the field to rebuild for the new run
  state.rng = makeRNG(seed >>> 0);
}

// Fractal (Perlin-like) value noise on a torus: several octaves of wrapped random
// lattices, each smoothstep-interpolated, summed with falling amplitude. Returns a
// sampler over [0,1)² so both the ecology field and the renderer can share the look.
export function makeFractalNoise(seed, octaves) {
  const rng = makeRNG(seed >>> 0);
  const lat = octaves.map((o) => { const g = new Float32Array(o.L * o.L); for (let i = 0; i < g.length; i++) g[i] = rng.next(); return g; });
  const smooth = (t) => t * t * (3 - 2 * t);
  let ampSum = 0; for (const o of octaves) ampSum += o.a;
  return (gx, gy) => {                                  // gx,gy in [0,1)
    let sum = 0;
    for (let o = 0; o < octaves.length; o++) {
      const L = octaves[o].L, a = octaves[o].a, g = lat[o];
      const u = gx * L, v = gy * L;
      const ix = Math.floor(u), iy = Math.floor(v);
      const fx = smooth(u - ix), fy = smooth(v - iy);
      const x0 = ((ix % L) + L) % L, y0 = ((iy % L) + L) % L, x1 = (x0 + 1) % L, y1 = (y0 + 1) % L;
      const A = g[y0 * L + x0], B = g[y0 * L + x1], C = g[y1 * L + x0], D = g[y1 * L + x1];
      sum += a * ((A * (1 - fx) + B * fx) * (1 - fy) + (C * (1 - fx) + D * fx) * fy);
    }
    return sum / ampSum;                                // ~[0,1]
  };
}

// Build the resource field: a fractal-noise capacity map (organic, lichen-like patches
// at several scales) whose MEAN is normalized to 1 — so the world's carrying capacity
// is unchanged by the noise pattern — plus a current level initialized to capacity.
// Deterministic in its own seed, so it never disturbs the main simulation RNG sequence.
// Rebuilt when the world resizes or the seed changes.
export function buildField(state, P) {
  const Wx = P.worldW != null ? P.worldW : P.world, Wy = P.worldH != null ? P.worldH : P.world;
  const seed = (P.fieldSeed != null ? P.fieldSeed : 12345) >>> 0;
  if (state.field && state._fieldW === Wx && state._fieldH === Wy && state._fieldSeed === seed) return;
  const nx = Math.max(4, P.fieldRes | 0), ny = Math.max(4, Math.round(nx * Wy / Wx));
  const nc = nx * ny;
  const field = new Float32Array(nc), K = new Float32Array(nc);
  const noise = makeFractalNoise(seed ^ 0x9e3779b9, [{ L: 3, a: 1 }, { L: 6, a: 0.55 }, { L: 12, a: 0.3 }]);
  const contrast = P.fieldContrast;
  let mean = 0;
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      let nz = noise(gx / nx, gy / ny);
      nz = nz * nz * (3 - 2 * nz);                     // gentle smoothstep -> more distinct lichen blotches
      let k = 1 + contrast * (nz * 2 - 1);
      if (k < 0.02) k = 0.02;
      const c = gy * nx + gx; K[c] = k; mean += k;
    }
  }
  mean /= nc;
  for (let c = 0; c < nc; c++) { K[c] /= mean; field[c] = K[c]; } // normalize mean capacity to 1
  state.field = field; state.fieldK = K; state.fieldNX = nx; state.fieldNY = ny;
  state._fieldW = Wx; state._fieldH = Wy; state._fieldSeed = seed;
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
  state.x[i] = x; state.y[i] = y; state.age[i] = 0; state.energy[i] = state.energy0;
  state.heading[i] = state.rng.next() * 6.283185307179586;
  state.lineage[i] = lineageId != null ? lineageId : state.nextLineage++;
  const base = i * G;
  for (let g = 0; g < G; g++) state.genome[base + g] = genomeArr[g];
  clampGene(state.genome, base, ranges);
  state.species[i] = speciesId != null ? speciesId : foundClade(state, state.genome, base, state.lineage[i]);
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
      dE: new Float32Array(cap), ae: new Float32Array(cap), pe: new Float32Array(cap), // energy: net feed delta, autotroph & predator efficiencies
      br: new Float32Array(cap), bR: new Float32Array(cap),          // body radii: cells, newborns
      hux: new Float32Array(cap), huy: new Float32Array(cap),        // heading unit vectors (tick start)
      mhx: new Float32Array(cap), mhy: new Float32Array(cap),        // neighbours' mean heading (kernel-weighted)
      bh: new Float32Array(cap),                                     // newborn headings
      press: new Float32Array(cap), hI: null, hJ: null, hD: null,    // cooperative hunting: pressure per prey, bites (hunter, prey, drain)
      gNext: new Int32Array(2 * cap), gPrev: new Int32Array(2 * cap), gCell: new Int32Array(2 * cap), // collision-grid lists (cells + newborns)
      counts: null, cursor: null, gHead: null,
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
  const mu = P.mu, sg = P.sigmaG, macro = P.macroRate;
  for (let g = 0; g < G; g++) {
    if (rng.next() < mu) {
      // Most mutations are small nudges; a `macroRate` fraction are outsized
      // "knockouts" that re-roll the whole gene — a large, could-be-good-or-bad
      // jump that can leap across the genus threshold in a single birth.
      if (macro > 0 && rng.next() < macro) bg[off + g] = rr[g][0] + (rr[g][1] - rr[g][0]) * rng.next();
      else bg[off + g] += rng.gauss() * sg * (rr[g][1] - rr[g][0]);
    }
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
  const X = state.x, Y = state.y, GEN = state.genome, AGE = state.age, LIN = state.lineage, SPE = state.species, HD = state.heading;

  // Energy model setup: derive each cell's autotroph/heterotroph efficiencies from
  // its trophic gene (a convex trade-off, so specialists beat generalists), and zero
  // the per-cell energy delta that the density pass fills with predation.
  const eOn = P.energyOn;
  const EN = state.energy, dE = s.dE, ae = s.ae, pe = s.pe;
  const texp = P.trophicExp, predRate = P.predRate, predGain = P.predGain;
  if (eOn) {
    buildField(state, P);
    for (let i = 0; i < N; i++) {
      const t = GEN[i * G + GENE.trophic];
      ae[i] = Math.pow(1 - t, texp); pe[i] = Math.pow(t, texp); dE[i] = 0;
    }
  }

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

  // 2. Density n_i (kernel-weighted count), normalized gradient direction ĝ_i, and the
  //    kernel-weighted mean heading of the neighbours (what an aligning cell turns toward).
  const halfWx = Wx / 2, halfWy = Wy / 2;
  const hux = s.hux, huy = s.huy, mhx = s.mhx, mhy = s.mhy;
  for (let i = 0; i < N; i++) { hux[i] = Math.cos(HD[i]); huy[i] = Math.sin(HD[i]); }
  // Cooperative hunting: bites are recorded here and settled after the pass, once each
  // prey's total pressure is known. Only real hunters (predation efficiency ≥ 0.01) bite.
  const coop = eOn && P.huntThreshold > 0, press = s.press;
  let nb = 0;
  if (coop) {
    press.fill(0, 0, N);
    if (!s.hI) { s.hI = new Int32Array(8 * state.cap); s.hJ = new Int32Array(8 * state.cap); s.hD = new Float32Array(8 * state.cap); }
  }
  let hI = s.hI, hJ = s.hJ, hD = s.hD;
  for (let i = 0; i < N; i++) {
    const base = i * G;
    const ri = R * GEN[base + GENE.rScale], ri2 = ri * ri;
    const xi = X[i], yi = Y[i];
    const cx = cellIdx[i] % nx, cy = (cellIdx[i] / nx) | 0;
    const pei = eOn ? pe[i] : 0;
    let acc = 0, agx = 0, agy = 0, dEi = 0, ahx = 0, ahy = 0;
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
            ahx += wgt * hux[j]; ahy += wgt * huy[j];
            const d = Math.sqrt(d2);
            if (d > 1e-9) { const inv = wgt / d; agx += inv * dx; agy += inv * dy; }
            // predation: i drains energy from neighbor j; soft prey (low predEff)
            // is more vulnerable than a tough predator, so animals eat plants first.
            if (pei > 0) {
              const drain = predRate * pei * wgt * (1 - pe[j]);
              if (!coop) { dEi += predGain * drain; dE[j] -= drain; }
              else if (pei >= 0.01) {
                if (nb >= hI.length) {   // rare: grow the bite list
                  const g = (a, T) => { const b = new T(a.length * 2); b.set(a); return b; };
                  hI = s.hI = g(hI, Int32Array); hJ = s.hJ = g(hJ, Int32Array); hD = s.hD = g(hD, Float32Array);
                }
                press[j] += drain; hI[nb] = i; hJ[nb] = j; hD[nb] = drain; nb++;
              }
            }
          }
        }
      }
    }
    // Crowding is a density: the kernel sum normalised by the sensed area (rScale²), so
    // it reads "neighbours per base-reach area" whatever the reach. Shrinking reach
    // therefore can't be used to feel less crowded.
    const rsi = GEN[base + GENE.rScale];
    n[i] = acc / (rsi * rsi);
    if (acc > 0) { mhx[i] = ahx / acc; mhy[i] = ahy / acc; } else { mhx[i] = 0; mhy[i] = 0; }
    if (eOn) dE[i] += dEi;
    const gl = Math.hypot(agx, agy);
    if (gl > 1e-12) { gx[i] = agx / gl; gy[i] = agy / gl; } else { gx[i] = 0; gy[i] = 0; }
  }

  // Settle cooperative bites: each lands (pressure on its prey / threshold)², capped at 1.
  if (coop) {
    const T = P.huntThreshold;
    for (let k = 0; k < nb; k++) {
      const j = hJ[k], r = press[j] / T, d = hD[k] * (r >= 1 ? 1 : r * r);
      dE[j] -= d; dE[hI[k]] += predGain * d;
    }
  }

  // 2b. Energy — the field regrows toward capacity, autotrophs graze it (competing as
  //     it depletes), predation deltas land, then upkeep is paid, scaled by genome
  //     complexity. Energy may go negative here; that becomes starvation in the death pass.
  if (eOn) {
    const F = state.field, K = state.fieldK, fnx = state.fieldNX, fny = state.fieldNY;
    const regrow = P.fieldRegrow, autoGain = P.autoGain, upkeep = P.upkeep, geneCost = P.geneCost, emax = P.energyMax;
    for (let c = 0, fc = F.length; c < fc; c++) F[c] += regrow * (K[c] - F[c]);
    for (let i = 0; i < N; i++) {
      const base = i * G;
      let fx = (X[i] / Wx * fnx) | 0; if (fx >= fnx) fx = fnx - 1; else if (fx < 0) fx = 0;
      let fy = (Y[i] / Wy * fny) | 0; if (fy >= fny) fy = fny - 1; else if (fy < 0) fy = 0;
      const c = fy * fnx + fx, k = K[c];
      let e = EN[i];
      if (k > 0 && ae[i] > 0) { let take = autoGain * ae[i] * (F[c] / k); if (take > F[c]) take = F[c]; F[c] -= take; e += take; }
      e += dE[i];
      const st = GEN[base + GENE.step], rs = GEN[base + GENE.rScale], tx = GEN[base + GENE.taxis];
      const tol = ((GEN[base + GENE.sHi] - GEN[base + GENE.sLo]) + (GEN[base + GENE.bHi] - GEN[base + GENE.bLo])) / 12;
      const al = GEN[base + GENE.align];
      const complexity = P.kMove * (st / R) * (st / R) + P.kSense * rs * rs + P.kTol * tol + P.kTaxis * tx * tx + P.kAlign * al * al;
      e -= upkeep + geneCost * complexity;
      EN[i] = e > emax ? emax : e;
    }
  }

  // 3. Death — probabilistic with soft band edges (plus starvation when energy is on).
  //    With metabolic cost on (and energy off), a wide survival window also carries a
  //    standing mortality: generalists survive more conditions but die more often in
  //    all of them. Without it, widening the window is nearly free and every run
  //    converges on immortal grey generalists.
  const sigma = P.sigma, maxAgeOn = P.maxAgeOn, maxAge = P.maxAge;
  const tolDeath = P.costsOn && !eOn ? P.kTolDeath : 0;
  for (let i = 0; i < N; i++) {
    const base = i * G, ni = n[i];
    let pSurv = smoothstep(GEN[base + GENE.sLo] - sigma, GEN[base + GENE.sLo] + sigma, ni)
      * (1 - smoothstep(GEN[base + GENE.sHi] - sigma, GEN[base + GENE.sHi] + sigma, ni));
    if (tolDeath > 0) pSurv *= 1 - tolDeath * (GEN[base + GENE.sHi] - GEN[base + GENE.sLo]) / 6;
    let alive = rng.next() < pSurv;
    if (eOn && EN[i] <= 0) alive = false;                 // starvation
    if (alive && maxAgeOn && AGE[i] >= maxAge) alive = false;
    survive[i] = alive ? 1 : 0;
  }

  // Solid bodies: radius per cell, and an overlap test against every body present now —
  // surviving cells at their current positions and this tick's newborns. They live in a
  // collision grid of doubly-linked bucket lists that is kept up to date as cells are
  // born and move, so a bucket only needs to span the largest pair of bodies (0.70R)
  // and a 3x3 search around a point sees every body that could touch it.
  // Ids: cells are 0..N-1, newborns N+b.
  const bodies = !!P.bodiesOn, br = s.br, bR = s.bR;
  const fnx = Math.max(1, Math.floor(Wx / (R * 0.71))), fny = Math.max(1, Math.floor(Wy / (R * 0.71))), fnc = fnx * fny;
  const fsx = fnx / Wx, fsy = fny / Wy;
  let gHead = s.gHead;
  const gNext = s.gNext, gPrev = s.gPrev, gCell = s.gCell;
  const bucketOf = (x, y) => {
    let cx = (x * fsx) | 0; if (cx >= fnx) cx = fnx - 1; else if (cx < 0) cx = 0;
    let cy = (y * fsy) | 0; if (cy >= fny) cy = fny - 1; else if (cy < 0) cy = 0;
    return cy * fnx + cx;
  };
  const gInsert = (id, c) => {
    const h = gHead[c];
    gCell[id] = c; gPrev[id] = -1; gNext[id] = h;
    if (h >= 0) gPrev[h] = id;
    gHead[c] = id;
  };
  const gRemove = (id) => {
    const p = gPrev[id], n = gNext[id];
    if (p >= 0) gNext[p] = n; else gHead[gCell[id]] = n;
    if (n >= 0) gPrev[n] = p;
  };
  if (bodies) {
    if (!gHead || gHead.length < fnc) gHead = s.gHead = new Int32Array(fnc);
    gHead.fill(-1, 0, fnc);
    for (let i = 0; i < N; i++) { if (!survive[i]) continue; br[i] = bodyRadius(GEN, i * G, R); gInsert(i, bucketOf(X[i], Y[i])); }
  }
  const fits = (x, y, r, self) => {
    const c0 = bucketOf(x, y), cx = c0 % fnx, cy = (c0 - cx) / fnx;
    for (let ddy = -1; ddy <= 1; ddy++) {
      let yy = cy + ddy; if (yy < 0) yy += fny; else if (yy >= fny) yy -= fny;
      const row = yy * fnx;
      for (let ddx = -1; ddx <= 1; ddx++) {
        let xx = cx + ddx; if (xx < 0) xx += fnx; else if (xx >= fnx) xx -= fnx;
        for (let id = gHead[row + xx]; id >= 0; id = gNext[id]) {
          if (id === self) continue;
          let dx, dy, rj;
          if (id < N) { dx = X[id] - x; dy = Y[id] - y; rj = br[id]; } else { const b = id - N; dx = bx[b] - x; dy = by[b] - y; rj = bR[b]; }
          if (dx > halfWx) dx -= Wx; else if (dx < -halfWx) dx += Wx;
          if (dy > halfWy) dy -= Wy; else if (dy < -halfWy) dy += Wy;
          const q = r + rj; if (dx * dx + dy * dy < q * q) return false;
        }
      }
    }
    return true;
  };

  // 4. Birth — survivors inside the (soft) birth band emit one offspring at f_eff.
  let bc = 0;
  const bx = s.bx, by = s.by, bg = s.bg, bl = s.bl, bspecies = s.bspecies;
  const spThr = P.speciesThreshold, gThr = P.genusThreshold;
  const birthCost = P.birthCost, birthThreshold = birthCost * 1.4; // must bank 1.4x the investment to breed
  const popCap = P.capOff ? state.cap : (P.cap < state.cap ? P.cap : state.cap); // soft limit, never above the buffer
  for (let i = 0; i < N; i++) {
    if (!survive[i]) continue;
    const base = i * G, ni = n[i];
    const win = smoothstep(GEN[base + GENE.bLo] - sigma, GEN[base + GENE.bLo] + sigma, ni)
      * (1 - smoothstep(GEN[base + GENE.bHi] - sigma, GEN[base + GENE.bHi] + sigma, ni));
    if (win <= 0) continue;
    let feff = GEN[base + GENE.fecundity];
    // When energy is off, metabolic cost discounts fecundity directly. When on, the
    // cost is paid in energy (upkeep above) instead, and reproduction is gated on it.
    if (P.costsOn && !eOn) {
      const st = GEN[base + GENE.step], rs = GEN[base + GENE.rScale], tx = GEN[base + GENE.taxis];
      const tol = ((GEN[base + GENE.sHi] - GEN[base + GENE.sLo]) + (GEN[base + GENE.bHi] - GEN[base + GENE.bLo])) / 12;
      const al = GEN[base + GENE.align];
      const cost = P.kMove * (st / R) * (st / R) + P.kSense * rs * rs + P.kTol * tol + P.kTaxis * tx * tx + P.kAlign * al * al;
      feff *= Math.exp(-cost);
    }
    if (rng.next() >= feff * win) continue;
    if (eOn && EN[i] < birthThreshold) continue;          // not enough banked energy to reproduce
    if (state.count + bc >= popCap) continue; // reject births at the (soft or buffer) cap
    buildOffspring(state, i, rng, P, rr, bg, bc * G, counts, items, cellIdx, nx, ny, Wx, Wy);
    // Landing spot: a random direction at the seed-throw distance. With bodies on, a
    // spot that overlaps another body is rejected; up to BIRTH_TRIES directions are
    // tried, and if all are taken the birth fails (and costs nothing).
    const dd = GEN[base + GENE.dDisp], cv = GEN[base + GENE.dCV];
    const dist = Math.abs(dd + dd * cv * rng.gauss());
    const cr = bodies ? bodyRadius(bg, bc * G, R) : 0;
    let px = 0, py = 0, placed = false;
    for (let tr = 0; tr < (bodies ? BIRTH_TRIES : 1); tr++) {
      const ang = rng.next() * 6.283185307179586;
      px = wrap(X[i] + Math.cos(ang) * dist, Wx); py = wrap(Y[i] + Math.sin(ang) * dist, Wy);
      if (!bodies || fits(px, py, cr, -1)) { placed = true; break; }
    }
    if (!placed) continue;
    if (eOn) EN[i] -= birthCost;                           // parent invests energy into the child
    bx[bc] = px; by[bc] = py;
    if (bodies) { bR[bc] = cr; gInsert(N + bc, bucketOf(px, py)); }
    bl[bc] = LIN[i];                       // lineage (founder) is inherited unchanged
    s.bh[bc] = HD[i];                      // and the parent's heading
    // Divergence taxonomy, coarse first: past the genus threshold => new genus (and a
    // new species inside it, marked as a big colour step); else past the species
    // threshold => new species in the same genus; else inherit both.
    // Each tier's reference genome follows its members (nudged toward every offspring
    // that stays in it), so a clade drifting together stays one clade; only offspring
    // that diverge from the group found new ones.
    const psp = SPE[i], off = bc * G;
    let osp = psp;
    if (spThr > 0) {
      const pg = state.spGenus[psp];
      if (gThr > 0 && geneDist(bg, off, state.gRef[pg], 0, rr) > gThr) {
        const ng = foundGenus(state, bg, off, LIN[i], pg);
        osp = foundSpecies(state, bg, off, LIN[i], psp, ng, true);
      } else {
        if (geneDist(bg, off, state.spRef[psp], 0, rr) > spThr) osp = foundSpecies(state, bg, off, LIN[i], psp, pg, false);
        else track(state.spRef[psp], bg, off, SPECIES_TRACK);
        track(state.gRef[pg], bg, off, GENUS_TRACK);
      }
    }
    bspecies[bc] = osp;
    bc++;
  }

  // 5. Movement. Each cell first updates its heading: it turns toward its neighbours'
  //    mean heading by its alignment gene (a = 0 ignores them), then jitters by ±headNoise.
  //    Its direction blends a fresh random heading (weight 1 − a) with that steered
  //    heading (weight a), then density taxis as before; it moves `step` along it.
  //    With bodies on, a blocked move slides: it tries the direction rotated ±60° (random
  //    order) before staying put, so packed groups can still flow.
  const headNoise = P.headNoise;
  for (let i = 0; i < N; i++) {
    if (!survive[i]) continue;
    const base = i * G, st = GEN[base + GENE.step], tx = GEN[base + GENE.taxis], al = GEN[base + GENE.align];
    let hx = hux[i], hy = huy[i];
    if (al > 0) { hx = (1 - al) * hx + al * mhx[i]; hy = (1 - al) * hy + al * mhy[i]; }
    const h = (hx * hx + hy * hy > 1e-12 ? Math.atan2(hy, hx) : HD[i]) + (rng.next() - 0.5) * 2 * headNoise;
    HD[i] = h;
    const ang = rng.next() * 6.283185307179586;
    const ux = (1 - al) * Math.cos(ang) + al * Math.cos(h), uy = (1 - al) * Math.sin(ang) + al * Math.sin(h);
    const at = Math.abs(tx);
    let dx = (1 - at) * ux + tx * gx[i];
    let dy = (1 - at) * uy + tx * gy[i];
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-9) { dx /= dl; dy /= dl; } else { dx = Math.cos(ang); dy = Math.sin(ang); }
    if (!bodies) { X[i] = wrap(X[i] + dx * st, Wx); Y[i] = wrap(Y[i] + dy * st, Wy); AGE[i] += 1; continue; }
    let mx = wrap(X[i] + dx * st, Wx), my = wrap(Y[i] + dy * st, Wy), ok = fits(mx, my, br[i], i);
    if (!ok && st > 0) {
      const sgn = rng.next() < 0.5 ? 1 : -1;
      for (let k = 0; k < 2 && !ok; k++) {
        const c = 0.5, sn = (k === 0 ? sgn : -sgn) * 0.8660254037844386;   // cos/sin 60°
        const rdx = dx * c - dy * sn, rdy = dx * sn + dy * c;
        mx = wrap(X[i] + rdx * st, Wx); my = wrap(Y[i] + rdy * st, Wy); ok = fits(mx, my, br[i], i);
      }
    }
    if (ok) {
      const c = bucketOf(mx, my);
      if (c !== gCell[i]) { gRemove(i); gInsert(i, c); }
      X[i] = mx; Y[i] = my;
    }
    AGE[i] += 1;
  }

  // 6. Compact survivors to the front, then append offspring.
  let w = 0;
  for (let i = 0; i < N; i++) {
    if (!survive[i]) continue;
    if (w !== i) {
      X[w] = X[i]; Y[w] = Y[i]; AGE[w] = AGE[i]; LIN[w] = LIN[i]; SPE[w] = SPE[i]; EN[w] = EN[i]; HD[w] = HD[i];
      const ws = w * G, bs = i * G;
      for (let g = 0; g < G; g++) GEN[ws + g] = GEN[bs + g];
    }
    w++;
  }
  const childE = eOn ? birthCost : state.energy0;
  for (let b = 0; b < bc; b++) {
    if (w >= state.cap) break;
    X[w] = bx[b]; Y[w] = by[b]; AGE[w] = 0; LIN[w] = bl[b]; SPE[w] = bspecies[b]; EN[w] = childE; HD[w] = s.bh[b];
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
  const seen = new Set(), spSeen = new Set(), gSeen = new Set();
  for (let i = 0; i < N; i++) { const sp = state.species[i]; seen.add(state.lineage[i]); spSeen.add(sp); gSeen.add(state.spGenus[sp]); }
  // trophic split: a cell is an "animal" if its trophic gene is past the midpoint
  let animals = 0, esum = 0;
  for (let i = 0; i < N; i++) { if (GEN[i * G + GENE.trophic] >= 0.5) animals++; esum += state.energy[i]; }
  return {
    population: N, mean, sd, varianceIndex: vi, lineages: seen.size, species: spSeen.size, genera: gSeen.size,
    animals, plants: N - animals, meanEnergy: N > 0 ? esum / N : 0,
  };
}
