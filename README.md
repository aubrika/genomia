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

Starts paused. **Space** play · **.** step · **R** reset. Choose a scenario from the
**preset** menu; hover any control to see what it does. **Copy link** shares a run
(seed, rules, brush and flora pattern) and **snapshot** saves the habitat as a PNG.

## A few things to try

- **Gray goo** — turn metabolic cost off and watch every gene run to its extreme and
  the variance index collapse into a grey monoculture.
- **Genealogy color** — color by ancestry instead of phenotype to see the family
  tree: each lineage a hue family, each species a shade within it.
- **Trophic web** — switch on the energy model and one lineage grazing the flora
  field evolves predators that hunt it: an emergent food chain (green plants → red
  animals).

## Controls

Each panel section is badged for when it applies: **live** (global rules — affect
every cell now), **new cells** (the brush you paint with), **on reset** (re-seeding).
Click to place · drag to paint · shift-click a blob · alt-drag to erase · hover a
cell to read its genome. On touch screens the controls stack below the habitat and
tap/drag paints; blobs, erasing and genome readouts need a mouse and keyboard.

## Structure

- `sim.js` — DOM-free simulation core (typed-array state, seeded PRNG, `step()`);
  written to port to Rust.
- `prng.js` — seeded mulberry32; a seed plus parameters reproduces a run exactly.
- `render.js` — Canvas 2D renderer (color, the flora field, adjacency lines); also
  the fallback.
- `render_gl.js` — WebGL2 renderer: all cells / flora / lines as GPU point-sprites and
  lines, one draw call each. Used automatically when available; force it off with `#no-gl`.
- `main.js` — UI, interaction, loop, shareable links (`#cfg=…`).

`node smoketest.js` (or `gjs -m smoketest.js`) runs a headless regression over the
core (reproducibility, the gray-goo attractor, blend-collapse, and that the
population neither dies instantly nor exceeds the cap); CI runs it on every push.

## License

[MIT](LICENSE)
