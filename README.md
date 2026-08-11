# Genomic Particle Life

A browser simulator for a continuous-space, stochastic, Conway-derived system in
which every cell carries an evolvable eleven-gene genome. Cells are points on a torus
in ℝ², not lattice sites. They are born at a dispersal offset from a parent, die
from loneliness or overcrowding, wander, and pass on mutated copies of their
parameters. Everything on screen is a readout of genotype.

Two things make it an evolution sandbox rather than a cellular automaton: the
**default scene** seeds two independently randomized founder lineages, one in each
half of the world, and lets them fight for the space — a fresh natural-selection
contest every seed (watch the **lineage-share** sparkline to see one exclude the
other or a coexistence hold). And an optional **energy / trophic model** turns the
world into a food web: cells spend energy to live, feed to refill it, and a `trophic`
gene lets one lineage split into autotroph "plants" and heterotroph "animals".

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
- **Phenotype vs genealogy color** — phenotype color is semantic (hue = niche
  center, saturation = niche breadth, lightness = motility). Switch to *genealogy*
  to color by ancestry: each founder **lineage** gets a distinct base hue, and every
  **speciation** steps the color a little, so related species share a color family
  and drift step-wise — a visible family tree.
- **Adjacency lines** — solid where perception is mutual, dashed where one-way
  (asymmetric perception is a real consequence of the `rScale` gene). Alpha scales
  with kernel weight, so links condense and dissolve as cells drift.
- **Membranes** (preset 6, experimental) — cells aggregate but a low overcrowding
  cap kills the crowded interior, leaving a living shell around a void.
- **Species bloom** (preset 7) — one founder lineage in a fast-mutating regime with
  a low species threshold, so the species count climbs from 1 as genomes diverge.
- **Trophic web** (preset 8) — the energy model on, over an organic **flora field**:
  the resource is drawn as a fairly uniform but organic scatter of grass/moss marks
  (fractal-noise capacity) ringed by a **membrane** contour. One lineage of "plants"
  grazing the flora evolves a class of "animals" that prey on them: an emergent food
  chain. Coloured by trophic type (green → red); grazing thins the flora where the
  population feeds; the plant and animal counts are in the top-left readout.

**Taxonomy (coarse → fine): lineage > genus > species.** A *lineage* is a founder
identity — a distinct brush/ruleset. Cells painted with the same brush share a
lineage; edit a gene and the next cells you paint found a new one; it's inherited
unchanged forever. A *genus* and a *species* are divergence tiers *within* a lineage:
when an offspring's genome drifts past the **genus Δ** / **species Δ** genetic-distance
threshold from that tier's founding genome, it founds a new genus / species. Under
**genealogy** color, genus is the hue family and species is the shade within it.
**isolation** (a genetic-distance cutoff) optionally stops diverged clades from
interbreeding under crossover.

**Mutation.** Most mutations are small nudges (`σ_g`); a **macro** fraction are
outsized "knockouts" that re-roll a whole gene — big, could-be-good-or-bad jumps.
Rare macromutations are what leap across the genus threshold to found new genera.

**Energy / trophic model** (toggle, off by default). When on, each cell carries an
energy budget. Every tick it pays metabolic **upkeep** scaled by genome complexity
("greater features cost more food"); it **feeds** to refill — autotrophs harvest a
noise-generated **resource field** (the olive gradient) that regrows toward a spatial
capacity, heterotrophs **prey** on nearby cells; it **starves** if energy hits zero,
and must bank enough energy to reproduce (offspring cost their parent energy). The
`trophic` gene sets the autotroph↔heterotroph mix on a convex trade-off, so *disruptive
selection* pushes a mixed lineage toward the two pure extremes — plants and animals —
and the animals' food is the energy the plants pulled out of the field. The world's
plant carrying capacity is roughly `fieldRegrow · Σcapacity / upkeep`; predators are
rarer than prey, as they should be, and their share grows as the food chain assembles.

**Which controls apply when.** Each panel section is badged: **live** (global rules
read every tick — cost, softness, inheritance/thresholds — applied to all existing
cells immediately), **new cells** (the brush — only the cells you place next), or
**on reset** (Initialize — takes effect when you re-seed). Every control and gene
also has a **hover tooltip** explaining what it does.

## Layout

The habitat is the top-left region; the control panels are fixed beside and below it,
so they never cover live particles. Resizing the window rescales the running ecosystem
(positions, `R`, and the `R`-relative genes all scale together) rather than revealing
more world.

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
- `render.js` — Canvas 2D: semantic / genealogy / trophic color, the resource-field
  heatmap, torus-aware adjacency lines, hover.
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
