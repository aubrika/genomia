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

Opens on the **Trophic web** scenario, running (paused if your system asks for reduced motion), with a short guide on the first visit (the **?** button or key reopens it). **Space** play · **.** step · **R** reset · **H** hide the UI (just the habitat) · **[ ]** slower / faster (fast-forward up to 16 ticks per frame, or max). Choose a scenario from the
**preset** menu; hover any control to see what it does. **Copy link** shares a run
(seed, rules, brush and flora pattern) and **snapshot** saves the habitat as a PNG.

## A few things to try

- **Gray goo**: turn metabolic cost off. Tolerance becomes free, so every lineage
  evolves the widest possible survival and breeding windows, the habitat fills to the
  cap, and (in phenotype colour) everything turns grey.
- **Genealogy colour**: each founder lineage is a hue family, and each species split
  steps the shade, so the family tree is visible on the habitat.
- **Species bloom**: one founder under fast mutation and choosy mating splits into
  around ten large species.
- **Flocks**: strong pack instinct under a low population limit; the population
  breaks into groups that move together and hold their course.
- **Hunting packs**: cooperative hunting (prey only go down when several hunters press
  them at once) plus pack instinct: omnivorous hunters roam the plant field as
  travelling packs. Turn pack hunting off and they dwindle; drop the pack instinct
  and they survive only as stationary clumps.
- **Coevolution**: cooperative hunting with nobody starting pack-minded, at max speed.
  Over ~5–10k ticks the plants usually evolve herds (they turn into triangles and the
  pack instinct chart climbs), and hunters sometimes evolve packs.
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

Cells have **solid bodies** (toggle: Rules → bodies). Body size is its own gene (0.06R
to 0.35R radius), and no two bodies overlap: an offspring that can't find free space
isn't born, and a blocked move first tries to slide 60° either way before waiting. Each
cell is drawn at its body size.

By default, cells are coloured by **species hash**: each species' founding genome is
coarsely binned and hashed into an arbitrary colour, so species look distinct, and a
cell's colour never changes during its life; new colours appear as new species are
founded. Each cell shimmers by how its own genes differ from its species' founder. The
same hash picks each species' **shape** (square, pentagon, hexagon or circle).

Each cell also carries a **heading**, inherited by its offspring. Its **pack instinct**
gene sets how much it steers by that heading and turns it toward its neighbours'
average heading, so neighbours fall into step and travel together as a flock.
Strongly pack-minded species are drawn as triangles pointing the way they're going.
With the energy model on, **pack hunting** (cooperative hunting) makes a predator's
bite land in proportion to (total pressure on that prey ÷ a threshold)², capped at 1,
so lone hunters starve and packs thrive.

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
