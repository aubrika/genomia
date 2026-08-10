// Seeded PRNG (mulberry32). All stochasticity in the simulator flows through one
// of these — no Math.random anywhere — so a seed + parameter set reproduces a run
// exactly. State is a single uint32, held here and reset from the visible seed.
export function makeRNG(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    get state() { return s; },
    set state(v) { s = v >>> 0; },
    // Uniform in [a, b).
    range(a, b) { return a + (b - a) * next(); },
    // Standard normal via Box-Muller (no cached spare, so RNG consumption is
    // a fixed 2 draws per call — keeps the sequence deterministic and portable).
    gauss() {
      let u = next(); if (u < 1e-12) u = 1e-12;
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * v);
    },
  };
}
