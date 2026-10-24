// Headless core check. Run: node smoketest.js  (or: gjs -m smoketest.js)
// Exits non-zero if any expectation fails, so CI can gate on it.
import { createState, resetState, addAgent, step, computeStats, geneRanges, DEFAULTS, G, GENE } from './sim.js';

const print = globalThis.print || console.log;
const failures = [];
function expect(ok, what) { if (!ok) { failures.push(what); print(`  FAIL: ${what}`); } }

function mk(spec, R) {
  const g = new Float32Array(G);
  g[GENE.rScale] = spec.rScale; g[GENE.sLo] = spec.sLo; g[GENE.sHi] = spec.sHi;
  g[GENE.bLo] = spec.bLo; g[GENE.bHi] = spec.bHi; g[GENE.fecundity] = spec.fec;
  g[GENE.dDisp] = spec.dDisp * R; g[GENE.dCV] = spec.dCV; g[GENE.step] = spec.step * R; g[GENE.taxis] = spec.taxis;
  return g;
}
const CONWAY = { rScale: 1.0, sLo: 2.0, sHi: 3.3, bLo: 2.7, bHi: 3.3, fec: 0.15, dDisp: 1.2, dCV: 0.3, step: 0.05, taxis: 0.0 };
const WIDE   = { rScale: 1.2, sLo: 0.0, sHi: 12,  bLo: 0.0, bHi: 12,  fec: 0.30, dDisp: 1.0, dCV: 0.3, step: 0.10, taxis: 0.0 };
const SWARM  = { rScale: 1.0, sLo: 1.5, sHi: 7.0, bLo: 2.5, bHi: 7.0, fec: 0.22, dDisp: 0.8, dCV: 0.3, step: 0.15, taxis: 0.6 };

function seedRun(seed, P, spec, nInit, spread) {
  const st = createState(P.cap); resetState(st, seed);
  const rr = geneRanges(P.R), W = P.world, base = mk(spec, P.R), rng = st.rng;
  for (let k = 0; k < nInit; k++) {
    const g = new Float32Array(base);
    for (let j = 0; j < G; j++) g[j] += rng.gauss() * spread * (rr[j][1] - rr[j][0]);
    addAgent(st, rng.next() * W, rng.next() * W, g, null, rr);
  }
  return st;
}

function traj(label, P, spec, nInit, ticks, spread = 0.05, seed = 7) {
  const st = seedRun(seed, P, spec, nInit, spread);
  let over = false;
  const marks = [];
  for (let t = 0; t <= ticks; t++) {
    if (t % (ticks / 5) === 0 || t === ticks) { const s = computeStats(st, P); marks.push(`t${t}:${s.population}`); }
    step(st, P);
    if (st.count > P.cap) over = true;
  }
  const s = computeStats(st, P);
  print(`${label.padEnd(20)} ${marks.join('  ').padEnd(44)} | final varIdx=${s.varianceIndex.toFixed(4)} lineages=${s.lineages}${over ? '  !!CAP EXCEEDED' : ''}`);
  expect(!over, `${label}: population stayed within the cap`);
  return s;
}

print('=== a viable population sustains (swarm: taxis aggregates into breeding-density clusters) ===');
const sw = traj('swarm', Object.assign({}, DEFAULTS), SWARM, 6000, 500);
expect(sw.population > 0, 'swarm: a viable population sustains');

print('\n=== gray goo: costs off + wide bands => saturates toward the cap, variance washes out ===');
const goo = traj('gray goo', Object.assign({}, DEFAULTS, { costsOn: false }), WIDE, 4000, 400);
expect(goo.population > 4000, 'gray goo: costs-off population grows');

print('\n=== conway-ish is near-critical by design (B3/S23 analogue — expected to thin out) ===');
traj('conway-ish', Object.assign({}, DEFAULTS), CONWAY, 8000, 200);

print('\n=== blend is meant to fail: variance index should sit well below crossover ===');
const cx = traj('crossover', Object.assign({}, DEFAULTS, { recomb: 'crossover' }), SWARM, 6000, 400);
const bl = traj('blend',     Object.assign({}, DEFAULTS, { recomb: 'blend'     }), SWARM, 6000, 400);
print(`blend/crossover varIdx ratio = ${(bl.varianceIndex / cx.varianceIndex).toFixed(3)} (want < 1)`);
expect(bl.varianceIndex < cx.varianceIndex, 'blend inheritance holds less variance than crossover');

print('\n=== reproducibility: same seed+params => byte-identical run ===');
const P = Object.assign({}, DEFAULTS);
const a = traj('run A', P, SWARM, 6000, 150);
const b = traj('run B', P, SWARM, 6000, 150);
print(`identical: pop=${a.population === b.population} varIdx=${a.varianceIndex === b.varianceIndex} lineages=${a.lineages === b.lineages}`);
expect(a.population === b.population && a.varianceIndex === b.varianceIndex && a.lineages === b.lineages, 'same seed + params reproduces the run');

if (failures.length) throw new Error(`${failures.length} check(s) failed:\n  ` + failures.join('\n  '));
print('\nOK');
