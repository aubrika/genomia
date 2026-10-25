# Genomia

*A little world of evolving genomes.*

**[▶ Open Genomia](https://aubrika.github.io/genomia/)** — runs in any modern browser, no install.

A browser artificial-life sandbox: a continuous-space, Conway-derived system where
every cell carries an evolvable genome and everything on screen is a readout of
genotype. Cells are points on a torus — born near a parent, dying of loneliness or
crowding, mutating as they reproduce. Selection does the rest: lineages compete,
diverge into species, and (with the energy model on) split into "plant" and "animal"
feeders.

## Run it

ES modules need to be served over HTTP (not `file://`):

```
python3 -m http.server 8000
# then open http://localhost:8000/
```

Opens on the **Trophic web** scenario, running (paused if your system asks for reduced motion). **Space** play · **.** step · **R** reset · **H** hide the UI (just the habitat). Choose a scenario from the
**preset** menu; hover any control to see what it does. **Copy link** shares a run
(seed, rules, brush and flora pattern) and **snapshot** saves the habitat as a PNG.

## A few things to try

- **Gray goo**: turn metabolic cost off. Tolerance becomes free, so every lineage
  evolves the widest possible survival and breeding windows, the habitat fills to the
  cap, and (in phenotype colour) everything turns grey.
- **Genealogy colour** (the default): each founder lineage is a hue family, and each
  species split steps the shade, so the family tree is visible on the habitat.
- **Species bloom**: one founder under fast mutation and choosy mating splits into
  around ten large species.
- **Trophic web**: switch on the energy model and one lineage grazing the flora
  field evolves predators that hunt it: an emergent food chain (green plants → red
  animals).

## How it works, briefly

Each cell measures **crowding**: the distance-weighted count of neighbours within its
reach, divided by its reach area, so it is a density. Each tick it survives if
crowding sits inside its survival window and breeds if crowding sits inside its
breeding window (both soft-edged). With metabolic cost on, features cost fertility,
and a wide survival window also raises the per-tick death risk ("generalist death").
Without that trade-off, every run converges on immortal grey generalists. Species are
divergence clusters: each species' reference genome follows its members, and an
offspring that strays past the threshold founds a new one.

Cells have **solid bodies** (toggle: Rules → bodies). Body size reads the reproductive
strategy (long reach and low fertility make a big body), and no two bodies overlap: an
offspring that can't find free space isn't born, and a blocked move waits. Each cell is
drawn at its body size; its **shape** is a species trait read from sociability, from a
triangle (shuns crowds) through square, pentagon and hexagon to a circle (seeks them).

## Controls

Each panel section is badged for when it applies: **live** (global rules — affect
every cell now), **new cells** (the brush you paint with), **on reset** (re-seeding).
Click to place · drag to paint · shift-click a blob · alt-drag to erase · hover a
cell to read its genome. On touch screens the controls stack below the habitat and
tap/drag paints; blobs, erasing and genome readouts need a mouse and keyboard.

## Structure

- `seed.js` — DOM-free seeding of a reset (shared by the app and tests).
- `sim.js` — DOM-free simulation core (typed-array state, seeded PRNG, `step()`);
  written to port to Rust.
- `prng.js` — seeded mulberry32; a seed plus parameters reproduces a run exactly.
- `render.js` — Canvas 2D renderer (color, the flora field, adjacency lines); also
  the fallback.
- `render_gl.js` — WebGL2 renderer: all cells / flora / lines as GPU point-sprites and
  lines, one draw call each. Used automatically when available; force it off with `#no-gl`.
- `main.js` — UI, interaction, loop, shareable links (`#cfg=…`).

`node smoketest.js` (or `gjs -m smoketest.js`) runs a headless regression over the
core: reproducibility, that costs on keeps a narrower survival window than costs off
(the gray-goo trade-off), blend collapse, and that the population sustains below the
cap. CI runs it on every push.

## License

[MIT](LICENSE)
