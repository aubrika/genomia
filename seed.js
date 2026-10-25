// Seeding — places the initial population for a reset. DOM-free (like sim.js), so the
// app, the smoke test and any headless check all seed a run identically.
import { addAgent, foundClade, createOccupancy, bodyRadius, geneRanges, G, GENE } from './sim.js';

const SEED_TRIES = 8;   // positions a seeded cell tries before it is skipped (bodies on)

// init: { population, layout, k, genomeInit, spread } (see main.js INIT_DEFAULTS).
// brush: the template genome. Returns the founder the brush now belongs to
// ({ lineage, species }), or null when every cell founded its own lineage.
export function seedPopulation(state, P, init, brush) {
  const rr = geneRanges(P.R), Wx = P.worldW != null ? P.worldW : P.world, Wy = P.worldH != null ? P.worldH : P.world;
  const Dm = Math.min(Wx, Wy), n = init.population, rng = state.rng;
  const wx_ = (v) => ((v % Wx) + Wx) % Wx, wy_ = (v) => ((v % Wy) + Wy) % Wy;
  const occ = createOccupancy(state, P);
  // Place one cell: draw positions from `pos` until one is free of other bodies.
  const place = (pos, g, lin, sp) => {
    const r = bodyRadius(g, 0, P.R);
    for (let t = 0; t < SEED_TRIES; t++) {
      const [px, py] = pos(), x = wx_(px), y = wy_(py);
      if (occ.fits(x, y, r)) { if (addAgent(state, x, y, g, lin, rr, sp) >= 0) occ.add(x, y, r); return; }
    }
  };

  // small per-gene jitter around a template — a monoclonal seed boom-busts in
  // lockstep, so a touch of variation gives selection something to act on.
  const jitter = (g) => { const sp = init.spread; if (sp > 0) for (let j = 0; j < G; j++) g[j] += rng.gauss() * sp * (rr[j][1] - rr[j][0]); return g; };

  if (init.genomeInit === 'twoclone' || init.genomeInit === 'tworand') {
    // two founder lineages A and B, each its own species, placed apart to compete
    let A, B;
    if (init.genomeInit === 'tworand') {
      // each lineage independently randomized around the viable brush — so every seed
      // is a fresh natural-selection contest between two distinct genomes
      const wild = () => { const g = new Float32Array(brush); for (let j = 0; j < G; j++) g[j] += rng.gauss() * 0.08 * (rr[j][1] - rr[j][0]); return g; };
      A = wild(); B = wild();
    } else {
      A = new Float32Array(brush); B = new Float32Array(brush);
      B[GENE.sLo] += 1.6; B[GENE.sHi] += 1.6; B[GENE.bLo] += 1.6; B[GENE.bHi] += 1.6;
      B[GENE.step] = Math.min(rr[GENE.step][1], B[GENE.step] * 1.8);
    }
    const linA = state.nextLineage++, spA = foundClade(state, A, 0, linA);
    const linB = state.nextLineage++, spB = foundClade(state, B, 0, linB);
    // A fills the left half of the world, B the right — a territorial contest with a
    // front where they meet. Uniform (not blobbed) so density starts viable everywhere.
    const half = n >> 1;
    for (let i = 0; i < n; i++) {
      const isA = i < half;
      const pos = () => [isA ? rng.next() * 0.5 * Wx : (0.5 + rng.next() * 0.5) * Wx, rng.next() * Wy];
      place(pos, jitter(new Float32Array(isA ? A : B)), isA ? linA : linB, isA ? spA : spB);
    }
    return { lineage: linA, species: spA };
  }

  const centers = [];
  if (init.layout === 'kblobs') for (let i = 0; i < init.k; i++) centers.push([rng.next() * Wx, rng.next() * Wy]);
  const isUniform = init.genomeInit === 'uniform';
  // 'clone brush' seeds ONE founder lineage/species (same rules => one lineage);
  // 'uniform random' gives each cell its own founder (all different rules).
  let lin = null, sp = null;
  if (!isUniform) { lin = state.nextLineage++; sp = foundClade(state, brush, 0, lin); }
  const genomeOf = () => {
    if (isUniform) { const g = new Float32Array(G); for (let j = 0; j < G; j++) g[j] = rng.range(rr[j][0], rr[j][1]); return g; }
    return jitter(new Float32Array(brush));
  };
  if (init.layout === 'lattice') {
    // jittered grid — low spatial variance, so a narrow-band (Conway-ish) genome
    // starts mostly in its survival window instead of in the density tails.
    // Spacing derives from population, so density is window-independent.
    const a = Math.sqrt((Wx * Wy) / Math.max(1, n)), jit = 0.1 * a; let placed = 0;
    for (let gy = a / 2; gy < Wy && placed < n; gy += a)
      for (let gx = a / 2; gx < Wx && placed < n; gx += a) { place(() => [gx + rng.gauss() * jit, gy + rng.gauss() * jit], genomeOf(), lin, sp); placed++; }
  } else {
    const pos = init.layout === 'uniform' ? () => [rng.next() * Wx, rng.next() * Wy]
      : init.layout === 'blob' ? () => [Wx / 2 + rng.gauss() * Dm * 0.14, Wy / 2 + rng.gauss() * Dm * 0.14]
        : init.layout === 'kblobs' ? () => { const c = centers[(rng.next() * centers.length) | 0]; return [c[0] + rng.gauss() * Dm * 0.05, c[1] + rng.gauss() * Dm * 0.05]; }
          : () => { const a = rng.next() * 6.283185307179586; return [Wx / 2 + Math.cos(a) * Dm * 0.38, Wy / 2 + Math.sin(a) * Dm * 0.38]; };
    for (let i = 0; i < n; i++) place(pos, genomeOf(), lin, sp);
  }
  return isUniform ? null : { lineage: lin, species: sp };
}
