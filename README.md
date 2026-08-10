# Genomic Particle Life

A browser simulator for a continuous-space, stochastic, Conway-derived system in
which every cell carries an evolvable ten-gene genome. Cells are points on a torus
in ℝ², not lattice sites. They are born at a dispersal offset from a parent, die
from loneliness or overcrowding, wander, and pass on mutated copies of their
parameters. Everything on screen is a readout of genotype.

## Run it

ES modules need to be served over HTTP (not `file://`):

```
python3 -m http.server 8000
# then open http://localhost:8000/
```

Defaults to **paused** (respecting `prefers-reduced-motion`). Press **Space** to
play, **`.`** to single-step, **R** to reset.

## What to look at

- **Costs off** (preset 2, *Gray goo*) — without the metabolic cost every gene
  walks to its best extreme; the population saturates into a grey monoculture.
  Toggling `costs ON/OFF` and watching the variance index collapse is the most
  instructive thing here.
- **Blend inheritance** (preset 3) — blending halves genetic variance every
  generation; the variance-index sparkline falls off a cliff and the colors wash
  out. It is included specifically to fail. `crossover` (default) holds.
- **Phenotype vs lineage color** — phenotype color is semantic (hue = niche
  center, saturation = niche breadth, lightness = motility). Switch to *lineage*
  to see the drift null model: spatial clumps of one hue are founder effects, not
  adaptation.
- **Adjacency lines** — solid where perception is mutual, dashed where one-way
  (asymmetric perception is a real consequence of the `rScale` gene). Alpha scales
  with kernel weight, so links condense and dissolve as cells drift.

## Interaction

Click place · drag paint · **shift-click** blob (the useful primitive under Allee
dynamics — lone cells often just die) · **alt-drag** erase · hover reads the full
genome and highlights that cell's links.

## Structure

- `sim.js` — the simulation core. **DOM-free by contract**: exports `step(state,
  params)`, `computeStats`, and Structure-of-Arrays state over typed arrays. No
  canvas, events, or document; written to be ported to Rust.
- `prng.js` — seeded mulberry32. All stochasticity flows through it, so a seed +
  parameter set reproduces a run exactly. No `Math.random` anywhere.
- `render.js` — Canvas 2D: semantic color, torus-aware adjacency lines, hover.
- `main.js` — UI, interaction, loop, instrumentation.

### Headless regression test

`gjs -m smoketest.js` (GNOME JavaScript / SpiderMonkey) exercises the DOM-free core
and checks the load-bearing claims: reproducibility, the gray-goo attractor,
blend-collapse, and that the population neither dies instantly nor exceeds the cap.

## Calibration notes

World is a fixed 1000×1000 torus; `R = 17` (uniform density gives `n ≈ 1.85` at
6,000 agents, `≈ 3.7` at the 12,000 cap). Carrying capacity for a viable genome
exceeds the cap, so a healthy board fills and churns at the cap — the sparse
outcomes are the pathological ones (high-`taxis` knot-collapse, over-packed blobs).
An exact-clone monoculture boom-busts in lockstep; the *Initialize → spread* control
adds a little seeding variation so selection has material from tick one.

Performance: ~8 ms/step at ~11,800 agents under SpiderMonkey, well inside the
60fps budget (V8 is faster). Hard cap 12,000; births are rejected at the cap
rather than culling.
