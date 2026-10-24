// Headless core check. Run: node smoketest.js  (or: gjs -m smoketest.js)
// Exits non-zero if any expectation fails, so CI can gate on it.
import { createState, resetState, addAgent, step, computeStats, foundClade, geneRanges, DEFAULTS, MAXCAP, G, GENE } from './sim.js';

const print = globalThis.print || console.log;
const failures = [];
function expect(ok, what) { if (!ok) { failures.push(what); print(`  FAIL: ${what}`); } }

function mk(spec, R) {
  const g = new Float32Array(G);
  g[GENE.rScale] = spec.rScale; g[GENE.sLo] = spec.sLo; g[GENE.sHi] = spec.sHi;
  g[GENE.bLo] = spec.bLo; g[GENE.bHi] = spec.bHi; g[GENE.fecundity] = spec.fec;
  g[GENE.dDisp] = spec.dDisp * R; g[GENE.dCV] = spec.dCV; g[GENE.step] = spec.step * R; g[GENE.taxis] = spec.taxis;
  g[GENE.trophic] = 0.5;
  return g;
}
// the app's default brush: a viable, moderately tolerant aggregator
const BRUSH = { rScale: 1.0, sLo: 0.4, sHi: 4.5, bLo: 0.8, bHi: 3.6, fec: 0.22, dDisp: 1.3, dCV: 0.4, step: 0.10, taxis: 0.10 };

function seedRun(seed, P, nInit, spread) {
  const st = createState(MAXCAP); resetState(st, seed);
  const rr = geneRanges(P.R), W = P.world, base = mk(BRUSH, P.R), rng = st.rng;
  const lin = st.nextLineage++, sp = foundClade(st, base, 0, lin);   // one founder lineage/species
  for (let k = 0; k < nInit; k++) {
    const g = new Float32Array(base);
    for (let j = 0; j < G; j++) g[j] += rng.gauss() * spread * (rr[j][1] - rr[j][0]);
    addAgent(st, rng.next() * W, rng.next() * W, g, lin, rr, sp);
  }
  return st;
}
const width = (s) => s.mean[GENE.sHi] - s.mean[GENE.sLo];

function traj(label, P, ticks, { n = 10000, spread = 0.03, seed = 7 } = {}) {
  const st = seedRun(seed, P, n, spread);
  let over = false;
  const marks = [];
  for (let t = 0; t <= ticks; t++) {
    if (t % (ticks / 4) === 0) marks.push(`t${t}:${st.count}`);
    if (t < ticks) step(st, P);
    if (st.count > P.cap) over = true;
  }
  const s = computeStats(st, P);
  print(`${label.padEnd(16)} ${marks.join('  ').padEnd(46)} | varIdx=${s.varianceIndex.toFixed(4)} survival window=${width(s).toFixed(2)}${over ? '  !!CAP EXCEEDED' : ''}`);
  expect(!over, `${label}: population stayed within the cap`);
  return s;
}

// The attractor checks need ~1000+ ticks to separate, so they run on a smaller world
// at the same density (cells scale with area; R is fixed, so crowding is unchanged).
const SMALL = { world: 600, cap: Math.round(DEFAULTS.cap * 0.36) }, nSmall = 3600;

print('=== costs on: a viable population sustains and self-limits below the cap ===');
const on = traj('costs on', Object.assign({}, DEFAULTS, SMALL), 1200, { n: nSmall });
expect(on.population > 0.2 * SMALL.cap && on.population < 0.95 * SMALL.cap, 'costs on: population sustains below the cap');

print('\n=== costs off: tolerance is free, so the survival window opens wider (gray goo) ===');
const off = traj('costs off', Object.assign({}, DEFAULTS, SMALL, { costsOn: false }), 1200, { n: nSmall });
expect(width(off) > width(on) + 0.5, 'costs off evolves a wider survival window than costs on');

print('\n=== blend inheritance collapses genetic variance; crossover holds it ===');
const cx = traj('crossover', Object.assign({}, DEFAULTS, { recomb: 'crossover' }), 100, { spread: 0.1 });
const bl = traj('blend', Object.assign({}, DEFAULTS, { recomb: 'blend' }), 100, { spread: 0.1 });
print(`blend/crossover varIdx ratio = ${(bl.varianceIndex / cx.varianceIndex).toFixed(3)} (want < 0.5)`);
expect(bl.varianceIndex < 0.5 * cx.varianceIndex, 'blend inheritance holds well under half the variance of crossover');

print('\n=== reproducibility: same seed+params => byte-identical run ===');
const P = Object.assign({}, DEFAULTS);
const a = traj('run A', P, 150);
const b = traj('run B', P, 150);
print(`identical: pop=${a.population === b.population} varIdx=${a.varianceIndex === b.varianceIndex} species=${a.species === b.species}`);
expect(a.population === b.population && a.varianceIndex === b.varianceIndex && a.species === b.species, 'same seed + params reproduces the run');

if (failures.length) throw new Error(`${failures.length} check(s) failed:\n  ` + failures.join('\n  '));
print('\nOK');
