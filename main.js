// Glue: UI, canvas, interaction, loop, instrumentation. All simulation logic
// lives in sim.js (DOM-free); this file is the instrument panel around it.
import {
  createState, resetState, addAgent, step, computeStats, foundClade, buildField, createOccupancy, bodyRadius,
  geneRanges, DEFAULTS, MAXCAP, G, GENE, GENE_NAMES,
} from './sim.js';
import { seedPopulation } from './seed.js';
import { draw, hslToRgb, speciesSides, SHAPE_NAMES, makeSpeciesHasher, drawSpeciesIcon } from './render.js';
import { updatePeaks, topSpecies, speciesName } from './leaderboard.js';
import { createGLRenderer } from './render_gl.js';

// ---- state ----------------------------------------------------------------
const P = Object.assign({}, DEFAULTS);
const state = createState(MAXCAP);   // arrays sized to the buffer ceiling; P.cap is the soft limit
// The resource-field pattern gets a fresh seed on every reset / energy activation, so
// the flora distribution is different each time (seeded off the clock, then advanced).
let fieldNonce = Date.now() >>> 0;
const freshFieldSeed = () => { fieldNonce = (fieldNonce + 0x9e3779b1) >>> 0; return fieldNonce; };
let pinnedFieldSeed = null;   // set by a shared link: the next reset reuses that flora pattern instead
const view = { scale: 1, ox: 0, oy: 0 };
const ui = { playing: false, speed: 1, colorMode: 'hash', showLines: true, shapes: true, lineCap: 20000, hovered: -1 };
// Fast-forward: simulation ticks per drawn frame. 'max' (Infinity) runs as many as fit
// in the frame's time budget; every speed is capped by that budget so the page stays
// responsive on slow machines.
const SPEEDS = [1, 2, 4, 8, 16, Infinity], SPEED_LABELS = ['1×', '2×', '4×', '8×', '16×', 'max'];
const STEP_BUDGET_MS = 40;
const INIT_DEFAULTS = { population: 10000, layout: 'uniform', k: 6, genomeInit: 'tworand', spread: 0.03, packs: 6, packSize: 40, blobN: 60, blobJitter: 26, seed: 12345 };
const init = Object.assign({}, INIT_DEFAULTS);
let selGene = GENE.step;
let curPreset = -1;   // index of the last-applied preset (-1 = the default two-lineage scene)

// default brush = a viable "aggregator" so the sandbox is alive on first play
const brush = new Float32Array(G);
// Write a preset-style spec (dispersal and motility in units of R) into a genome.
function specInto(g, spec) {
  g[GENE.rScale] = spec.rScale; g[GENE.sLo] = spec.sLo; g[GENE.sHi] = spec.sHi;
  g[GENE.bLo] = spec.bLo; g[GENE.bHi] = spec.bHi; g[GENE.fecundity] = spec.fec;
  g[GENE.dDisp] = spec.dDisp * P.R; g[GENE.dCV] = spec.dCV;
  g[GENE.step] = spec.step * P.R; g[GENE.taxis] = spec.taxis;
  if (spec.trophic != null) g[GENE.trophic] = spec.trophic;
  if (spec.align != null) g[GENE.align] = spec.align;
  if (spec.body != null) g[GENE.body] = spec.body;
  return g;
}
function setBrush(spec) { specInto(brush, spec); brushDirty = true; }
// A preset's second founder genome (the packs in 'prey + packs' seeding); null otherwise.
let brushB = null;

// A "lineage" is a founder identity = a distinct brush/ruleset. Cells painted with
// the same (unchanged) brush share a lineage; edit any gene and the next cells you
// place found a new lineage. brushFounder() lazily allocates that founder the first
// time it's needed after a change.
let brushDirty = true, curLineage = 0, curSpecies = -1;
const markBrushDirty = () => { brushDirty = true; };
function brushFounder() {
  if (brushDirty || curSpecies < 0 || curSpecies >= state.nextSpecies) {
    curLineage = state.nextLineage++;
    curSpecies = foundClade(state, brush, 0, curLineage);
    brushDirty = false;
  }
  return { lineage: curLineage, species: curSpecies };
}
setBrush({ rScale: 1.0, sLo: 0.4, sHi: 4.5, bLo: 0.8, bHi: 3.6, fec: 0.22, dDisp: 1.3, dCV: 0.4, step: 0.10, taxis: 0.10, trophic: 0.5, align: 0, body: 0.26 });

const geneR = () => geneRanges(P.R);

// ---- dom helpers ----------------------------------------------------------
const $ = (s) => document.querySelector(s);
function el(tag, props, kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) { if (k === 'class') e.className = props[k]; else e.setAttribute(k, props[k]); }
  if (kids != null) for (const c of [].concat(kids)) e.append(c && c.nodeType ? c : document.createTextNode(c));
  return e;
}
const withTip = (elm, text) => { if (text) elm.setAttribute('data-tip', text); return elm; };
function button(label, onclick, cls, tip) { const b = el('button', cls ? { class: cls } : null, [label]); b.addEventListener('click', onclick); return withTip(b, tip); }
function select(options, value, onchange) {
  const s = el('select');
  for (const [v, label] of options) { const o = el('option', { value: v }, [label]); if (v === value) o.selected = true; s.append(o); }
  s.addEventListener('change', () => onchange(s.value));
  return s;
}
function slider(label, min, max, stp, get, set, fmt, tip) {
  const inp = el('input', { type: 'range', min, max, step: stp });
  inp.value = get();
  const out = el('output', {}, [fmt(get())]);
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); set(v); out.textContent = fmt(v); });
  return withTip(el('div', { class: 'ctrl' }, [el('label', {}, [label]), inp, out]), tip);
}
function ctrlSelect(label, options, value, onchange, tip) {
  return withTip(el('div', { class: 'ctrl' }, [el('label', {}, [label]), select(options, value, onchange), el('span')]), tip);
}
const f2 = (v) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

// Plain-language help for every control/term — shown as a hover tooltip so new
// users know what each knob does. "Crowding" = the kernel-weighted neighbor count.
const HELP = {
  // Gene tooltips: a plain-language reading first, then the exact mechanics. The
  // first line names the friendly label with its code name, which is what sim.js uses.
  rScale: 'Reach (rScale)\n\nHow far this cell can sense its neighbours. Everything it reacts to (crowding, steering, choosing a mate, and, for predators, who it can eat) happens within this distance. A longer reach averages over more neighbours, so it reads crowding more reliably, but it costs more.\n\nHow it works: sensing radius r = R × reach, where R is the world’s base interaction radius. A neighbour at distance d inside r adds (1 − d²/r²)², so near neighbours count fully and distant ones barely. That sum is divided by reach², which makes crowding a density: the same neighbourhood reads the same crowding whatever the reach. Range 0.5–1.5. Costs kSense × reach².',
  sLo: 'Loneliness limit (sLo)\n\nThe least company this cell can live with. If its neighbourhood thins out below this, it dies of loneliness (the Allee effect). Raise it and isolated cells and advancing edges die back.\n\nHow it works: the lower bound of the survival window. Each tick, survival chance = smoothstep up across [limit − σ, limit + σ] × smoothstep down across the crowding limit, where σ is the softness rule. With metabolic cost on, a wide window also carries a standing death risk (see generalist death). Measured in crowding units (weighted neighbours per base-reach area); range 0–6.',
  sHi: 'Crowding limit (sHi)\n\nThe most crowding this cell can bear. Pack its neighbourhood tighter than this and it dies of overcrowding. Lower it and cells can only persist in thin, sparse structures.\n\nHow it works: the upper bound of the survival window [loneliness limit, crowding limit], with a soft edge of ±σ. If it ends up below the loneliness limit, the two are swapped. Range 0–6. A wider window costs kTol in fertility and, with metabolic cost on, raises the per-tick death chance by generalist death × width/6.',
  bLo: 'Breeding company (bLo)\n\nHow much company this cell needs before it will breed. Below this, it can still survive but won’t reproduce.\n\nHow it works: the lower bound of the breeding window [breeding company, nursery limit], with a soft edge of ±σ. Only cells that survive the tick can breed. Each tick, birth chance = fertility × window × cost factor. Range 0–6. A wider window costs kTol.',
  bHi: 'Nursery limit (bHi)\n\nThe most crowding at which this cell will still breed. Above this, it stops reproducing even if it survives.\n\nHow it works: the upper bound of the breeding window [breeding company, nursery limit], with a soft edge of ±σ. If it ends up below breeding company, the two are swapped. Range 0–6. A wider window costs kTol.',
  fecundity: 'Fertility (fecundity)\n\nHow eagerly this cell reproduces when conditions suit it.\n\nHow it works: the base chance per tick of producing one offspring while inside the breeding window. With metabolic cost on, it is multiplied by e^(−cost), where cost = kMove·(restlessness/R)² + kSense·reach² + kTol·(window widths)/12 + kTaxis·sociability². With the energy model on, cost is paid in energy instead, and the cell must also have banked 1.4 × breed cost. Range 0–0.30.',
  dDisp: 'Seed throw (dDisp)\n\nHow far from the parent its offspring land. Short throws reinforce the local cluster; long throws colonise gaps and new ground.\n\nHow it works: offspring are placed in a random direction at distance |throw × (1 + scatter × N(0,1))|, where N is a standard normal draw. Range 0.2R–3R, in world units. It scales with R, so it stays proportional when the window resizes.',
  dCV: 'Throw scatter (dCV)\n\nHow consistent the seed throw is. At 0, every offspring lands at exactly the throw distance; higher values spread them anywhere from close by to far away.\n\nHow it works: the coefficient of variation of the throw distance. Distance = |throw × (1 + scatter × N(0,1))|. Range 0–1.',
  step: 'Restlessness (step)\n\nHow far this cell moves each tick. Sessile cells hold their ground; restless ones roam and mix.\n\nHow it works: each tick the cell moves exactly this distance, in a direction mixed from a random heading and its sociability steering. Range 0–0.3R, in world units, scaled with R. Costs kMove × (restlessness/R)².',
  taxis: 'Sociability (taxis)\n\nWhether this cell drifts toward company or away from it. +1 = seeks crowds (aggregates into clumps), −1 = shuns them (spreads out), 0 = wanders at random.\n\nHow it works: direction = (1 − |s|) × random heading + s × ĝ, normalised, where ĝ points up the local crowding gradient (toward denser neighbours, within reach). Range −1 to +1. Costs kTaxis × sociability².',
  trophic: 'Diet (trophic)\n\nWhat this cell eats when the energy model is on. 0 = pure “plant”: grazes the resource field. 1 = pure “animal”: preys on neighbouring cells. Has no effect while the energy model is off.\n\nHow it works: grazing efficiency = (1 − diet)^p and hunting efficiency = diet^p, where p is the specialization rule. When p > 1, generalists are worse at both, so selection pushes lineages to the extremes. A hunter drains predation × its efficiency × closeness × (1 − the prey’s hunting efficiency) from each neighbour in reach per tick, and keeps a predGain share of it. Cells with diet ≥ 0.5 count as animals. Range 0–1.',
  align: 'Pack instinct (align)\n\nHow much this cell travels with its neighbours. At 0 it wanders on a fresh random heading every tick. Higher, it keeps a heading of its own and turns it toward the average heading of the cells around it, so neighbours fall into step and the group moves as one: a flock, school or hunting pack. Offspring inherit their parent’s heading.\n\nHow it works: each tick, heading ← (1 − a)·own + a·(kernel-weighted mean of neighbours’ headings within reach), then jittered by ±heading noise. The move direction blends a random heading (weight 1 − a) with that heading (weight a), then sociability’s pull as usual. Range 0–1. Costs kAlign × a². Species with pack instinct ≥ 0.5 are drawn as triangles pointing where they are going.',
  body: 'Body size (body)\n\nHow big this cell is: its solid body, and exactly what is drawn. Bigger bodies claim more room, so fewer fit in a crowd and offspring need a larger free spot to land.\n\nHow it works: body radius = R × (0.06 + 0.29 × size), from 0.06R to 0.35R. With bodies on, no two bodies may overlap. Range 0–1.',
  sigma: 'Band-edge softness. Birth/death thresholds are fuzzy, not hard: σ is the half-width of the smooth transition around each bound. Small σ ≈ crisp, Conway-like rules; large σ = gradual.',
  maxAgeToggle: 'When on, cells also die of old age once they pass "max age". Off by default — death is otherwise purely density-driven.',
  maxAge: 'Ticks a cell can live before dying of old age (only when max-age death is on).',
  maxPop: 'Maximum living population — births are rejected above it. The ecology often self-limits below it anyway; raise it for denser worlds. The hard ceiling is the array buffer (50k cells).',
  capOff: 'Remove the population limit: let the world grow until it hits the buffer ceiling (50k cells, where births are rejected to protect memory and framerate). Large populations run slower.',
  costs: 'Metabolic cost. When ON, features cost something: long reach, restlessness, wide crowding tolerance and strong sociability reduce fertility (the k weights below), and a wide survival window also raises the chance of dying each tick (generalist death). Turn it OFF and tolerance is free: every lineage evolves the widest possible survival and breeding windows, fertility maxes out and the colour drains to grey: gray goo.',
  kMove: 'Cost weight on restlessness: adds kMove × (restlessness/R)² to a cell’s cost. Higher makes moving far each tick more expensive.',
  kSense: 'Cost weight on reach: adds kSense × reach² to a cell’s cost. Higher makes sensing far more expensive.',
  kTolDeath: 'Generalist death: the extra chance per tick of dying for a cell whose survival window spans the whole crowding range (0–6), scaled down linearly for narrower windows. It is the trade-off that stops every lineage from evolving into an immortal generalist: a wide window survives more conditions but dies more often in all of them. Applies while metabolic cost is on and the energy model is off (the energy model has its own upkeep).',
  kTol: 'Cost weight on tolerance: adds kTol × (width of the survival window + width of the breeding window)/12 to a cell’s cost. Higher makes tolerating a wide range of crowding more expensive.',
  kAlign: 'Cost weight on pack instinct: adds kAlign × (pack instinct)² to a cell’s cost. Higher makes travelling in step with neighbours more expensive.',
  headNoise: 'Heading noise: how much a steering cell’s heading wobbles each tick (± this many radians). Low = long straight runs and tight, purposeful packs; high = packs lose their bearing. Only matters for cells with pack instinct.',
  kTaxis: 'Cost weight on sociability: adds kTaxis × sociability² to a cell’s cost. Higher makes deliberate steering (toward or away from crowds) more expensive.',
  recomb: 'How offspring inherit genes. clonal = copy one parent. crossover = mix two nearby parents gene-by-gene. blend = average two parents (this halves genetic variance every generation — included to demonstrate evolutionary collapse).',
  mutation: 'gaussian = each gene is randomly nudged with probability μ. cornered = same, but the four threshold genes (loneliness limit, crowding limit, breeding company, nursery limit) are also pulled toward the ends of their range, resisting a mushy middle where no structure survives.',
  mu: 'Mutation rate: the per-gene probability that a gene is nudged when an offspring is born.',
  sigmaG: 'Mutation size: the standard deviation of each nudge, as a fraction of that gene’s full range.',
  macroRate: 'Macromutation rate. Most mutations are small nudges; this fraction are outsized "knockouts" that re-roll a whole gene at random — a big, could-be-good-or-bad jump. Rare large jumps are what leap across the genus threshold and found new genera.',
  kappa: 'Cornered pull strength: how hard threshold genes are pushed toward their range ends (only in "cornered" mutation).',
  speciesThreshold: 'Species threshold (genetic distance, the FINE tier). Each species keeps a reference genome that follows its members as they drift. An offspring that differs from that reference by more than this founds a new species within the same genus, so a species splits only when part of it diverges from the rest. Lower = species split more readily; 0 = never.',
  genusThreshold: 'Genus threshold (genetic distance, the COARSE tier). Like the species threshold, but measured from the genus’ reference genome (which also follows its members): an offspring beyond this founds a new genus (and a new species inside it). Set it above the species threshold; genus = the larger colour family, species = the shade within it. 0 = off.',
  isolation: 'Reproductive isolation (genetic distance). With crossover, a second parent must be within this distance of the first, so diverged species stop interbreeding and can drift apart. 0 = off (mate with any neighbour).',
  color: 'species hash = each species gets an arbitrary colour from a hash of its founding genome, so a cell’s colour (and shape) never changes during its life, and new colours appear when new species are founded; each cell shimmers slightly lighter or darker by how its own genes differ from its species’ founder. phenotype = colour encodes the genome (hue = the middle of its survival window, saturation = how narrow that window is, lightness = restlessness) — similar genomes look similar. genealogy = each founder lineage gets a distinct base hue and every speciation steps the colour a little, so related species share a colour family and drift step-wise. trophic = green autotrophs ("plants") → red heterotrophs ("animals"), brightness = current energy (needs the energy model on).',
  energy: 'Energy / trophic model. When ON, every cell carries an energy budget: it pays metabolic upkeep each tick (more complex genomes cost more), FEEDS to refill it — autotrophs harvest the resource field (the olive gradient), heterotrophs prey on nearby cells — STARVES if energy hits zero, and must bank enough energy to reproduce. The `trophic` gene sets the mix, so selection can split a lineage into plants and animals. (Replaces the fecundity-discount cost model while on.)',
  fieldContrast: 'Patchiness of the resource field. 0 = flat (food everywhere), 1 = high-contrast peaks and deserts. Patchier fields reward autotrophs that sit in the rich spots and push others to prey instead.',
  fieldRegrow: 'How fast the resource field refills toward its local capacity each tick ("sunlight"). Low = grazed patches stay bare for a while, so autotrophs must spread out; high = food comes back fast.',
  autoGain: 'Autotroph harvest rate: energy a pure plant gains per tick sitting on a full field cell. Raise it to make photosynthesis pay better and plants dominate.',
  predRate: 'Predation rate: energy a pure animal drains from a neighbour per tick. Raise it to make hunting pay better and animals dominate (until they eat all the plants).',
  huntThreshold: 'Cooperative hunting. 0 = off: every predator drains its prey on its own. Above 0, prey can only be brought down together: a predator’s bite lands in proportion to (total predation pressure on that prey ÷ this threshold)², capped at 1. A lone hunter at a third of the threshold lands about 11% of its bite; a pack that reaches it lands all of it. This is what makes hunting in packs pay (pair it with pack instinct). Only cells with a real predation ability count as hunters.',
  trophicExp: 'Specialization curve. 1 = a generalist is as good as a specialist (no split). Above 1, being half-plant-half-animal is inefficient, so disruptive selection pushes cells to the pure-plant and pure-animal extremes — the cleaner the split.',
  upkeep: 'Base metabolic energy drained every tick, regardless of genome. Higher = cells starve sooner and must feed more actively.',
  geneCost: 'Extra upkeep charged per unit of genome complexity (long reach, high restlessness, wide survival/breeding windows, strong sociability). This is the "greater features cost more food" term — elaborate cells must out-feed simple ones to survive.',
  birthCost: 'Energy a parent invests into each offspring (the child starts life with it). A cell must bank ~1.4× this to breed, so reproduction is a real energy decision, not free.',
  shapes: 'Cell shapes. Each cell is drawn at its body size (the body-size gene). Its polygon is a SPECIES trait: species with strong pack instinct are triangles pointing the way they are heading; otherwise the species hash picks square, pentagon, hexagon or circle, so different species usually look different. OFF draws every cell as a circle (still at body size).',
  bodies: 'Solid bodies. When ON, every cell occupies its drawn body: an offspring can’t land on another cell (it tries a few directions, else the birth fails), and a move that would overlap another cell is skipped that tick. Bigger bodies therefore claim more room. OFF = the old point-particle physics, where cells can pile up anywhere.',
  lines: 'Draw a link between cells that perceive each other. Solid = mutual perception, dashed = one-way (a real consequence of different rScale). Line opacity follows perception strength, so links fade in and out as cells drift.',
  seed: 'Random seed. The same seed plus the same parameters reproduces a run exactly — in the same window size, since the habitat scales with the window. (The resource field is re-randomized on every reset, so trophic runs vary each time; a shared link pins it.)',
  share: 'Copy a link that re-creates this run from tick 0 with the current settings: seed, rules, brush, initializer, colour mode and flora pattern. Best reproduced in a similar window size.',
  snapshot: 'Download the habitat as a PNG image (at your screen’s full resolution).',
  play: 'Run or pause the simulation. (Space)',
  speed: 'Fast-forward: simulation ticks per drawn frame. Higher speeds make long evolutionary runs watchable; "max" runs as many ticks as fit in each frame. Every speed is capped so the page stays responsive, so very large populations may run slower than the label. ([ slower, ] faster)',
  stepBtn: 'Advance exactly one tick. (.)',
  reset: 'Clear and re-seed the population using the Initialize settings below. (R)',
  population: 'How many cells to place when seeding.',
  layout: 'Spatial arrangement of the initial seed: scattered uniformly, one central blob, several blobs, a ring, or a low-variance jittered lattice (best for narrow-band genomes that would otherwise avalanche).',
  genomeInit: 'Genome of seeded cells. clone brush = one founder lineage (all share the current rules). uniform random = each cell its own random genome and its own founder. two clones A/B = two founder lineages (a nudged variant of the brush) placed apart to compete. two random = two independently randomized founder lineages placed apart — a fresh natural-selection contest every seed.',
  spread: 'Genetic jitter added to seeded genomes. A pure clone boom-busts in lockstep; a little spread gives selection material and smooths the opening crash.',
  applyInit: 'Clear everything and re-seed with the current Initialize settings.',
  randomize: 'Fill the brush with a random genome.',
  copyHovered: 'Copy the hovered cell’s genome into the brush.',
  blobN: 'How many cells a shift-click blob places.',
  blobJitter: 'Radius of the shift-click blob.',
  sparkPop: 'Living cell count over time.',
  sparkGene: 'Mean ± standard deviation of the selected gene across the whole population.',
  sparkVar: 'Genetic variance index — mean per-gene variance, normalised by range. The headline number: it collapses under blend inheritance and holds steady under crossover.',
  board: 'The ten species that reached the most living members at once since the last reset. A species here is a species hash: related species whose founding genomes hash alike share a shape, colour and name, so they count together. Each row shows that shape, its colour in the current colour mode, and a made-up name picked from the hash. peak = the most members alive together; now = how many are alive now († = extinct). Hover a row for details.',
  sparkSpecies: 'Number of distinct surviving species (the fine tier). Rises as genomes diverge past the species threshold and falls as species go extinct. Founder-lineage and genus counts are in the top-left readout.',
  sparkShare: 'Population share of the founder lineages over time, as a stacked band. Watch one lineage competitively exclude the others (a band swallowing the rest) or a stable coexistence hold. Grey = any later-founded lineages lumped together.',
};

// Friendly on-screen names for the genes. The code names (GENE_NAMES) stay the
// vocabulary of sim.js, shared links and the tooltips' first line.
const GENE_LABELS = ['reach', 'loneliness limit', 'crowding limit', 'breeding company', 'nursery limit',
  'fertility', 'seed throw', 'throw scatter', 'restlessness', 'sociability', 'diet', 'pack instinct', 'body size'];

const PRESET_NAMES = ['Conway-ish', 'Gray goo', 'Blend collapse', 'Aggregation', 'Allee frontier', 'Membranes', 'Species bloom', 'Trophic web', 'Two lineages', 'Flocks', 'Hunting packs', 'Coevolution'];
const DEFAULT_PRESET = PRESET_NAMES.indexOf('Trophic web');   // the scenario a fresh visit opens on (and runs)
// short, persistent one-liners shown under the preset menu (no hover needed)
const PRESET_BLURBS = [
  'Tight Life-like rules on a lattice: a near-total crash, then surviving colonies spread back.',
  'Costs off: survival and breeding windows open all the way, and every lineage turns the same grey.',
  'Blend inheritance averages parents: genetic variance drops ~85% in 100 ticks. Try crossover to compare.',
  'Strongly sociable cells under a low population limit condense into a handful of colonies that merge.',
  'One colony with a high loneliness limit: strays die, so it grows only at its edge, as a steady front.',
  'Sociable cells with a low crowding limit: packed interiors die, leaving colonies full of holes.',
  'Fast mutation, local breeding and choosy mates: one founder splits into around ten large species.',
  'Energy model on: plants graze the flora, animals evolve to hunt them.',
  'Two randomized founder lineages start on opposite halves and compete across a front.',
  'Strong pack instinct under a low population limit: cells fall into step and travel as flocks.',
  'Cooperative hunting: predators (triangles) only bring down prey together, so they hunt in packs.',
  'Evolve it yourself: cooperative hunting, no pack instinct to start. Over ~5–10k ticks the plants usually evolve herds (watch the gene chart; they turn into triangles) and hunters sometimes evolve packs. Runs at max speed.',
];

// ---- side panel -----------------------------------------------------------
// scope badge: makes it obvious whether a section's controls apply live to every
// existing cell, only to cells you place next, or on the next reset.
const SCOPE = {
  live: ['live', 'Applies to every existing cell immediately — these are global rules read each tick.'],
  neu: ['new cells', 'Sets the genome of cells you place next. Existing cells keep their own genes.'],
  reset: ['on reset', 'Takes effect only when you re-seed (Apply init / Reset / a preset).'],
  view: ['view', 'Changes the display only; it does not affect the simulation.'],
};
function section(title, kids, scope) {
  const h = el('h2', {}, [title]);
  if (scope) { const [lbl, tip] = SCOPE[scope]; h.append(withTip(el('span', { class: 'scope ' + scope }, [lbl]), tip)); }
  return el('section', {}, [h, ...kids]);
}

function buildSide() {
  const side = $('#side');
  side.textContent = '';

  // Simulation
  const playBtn = button(ui.playing ? '❚❚ pause' : '▶ play', togglePlay, '', HELP.play);
  playBtn.id = 'playbtn';
  side.append(section('Simulation', [
    el('div', { class: 'seg' }, [playBtn, button('▷ step', () => singleStep(), '', HELP.stepBtn), button('⟲ reset', () => applyInit(), '', HELP.reset)]),
    withTip(el('div', { class: 'seg speed' }, SPEEDS.map((v, k) => {
      const b = button(SPEED_LABELS[k], () => setSpeed(v), ui.speed === v ? 'on' : '');
      b.dataset.speed = String(k);
      return b;
    })), HELP.speed),
    withTip(el('div', { class: 'row' }, [el('label', { class: 'k' }, ['seed']), (() => {
      const inp = el('input', { type: 'text' }); inp.value = init.seed;
      inp.addEventListener('change', () => { init.seed = parseInt(inp.value, 10) || 0; });
      return inp;
    })()]), HELP.seed),
    el('div', { class: 'grid2' }, [button('⧉ copy link', copyLink, '', HELP.share), button('⤓ snapshot', snapshot, '', HELP.snapshot)]),
  ]));

  // Presets — a menu, with the selected scenario's description shown persistently.
  const presetOpts = [['', 'Choose a preset…'], ...PRESET_NAMES.map((n, i) => [String(i), n])];
  side.append(section('Presets', [
    ctrlSelect('scenario', presetOpts, curPreset >= 0 ? String(curPreset) : '', (v) => { if (v !== '') applyPreset(+v); }),
    el('p', { class: 'hint' }, [curPreset >= 0 ? PRESET_BLURBS[curPreset] : 'A starting scenario.']),
  ]));

  // Leaderboard — rows are built once here and refilled by updateBoard()
  boardRows = [];
  const board = el('div', { class: 'board' }, [el('div', { class: 'brow bhead' }, [el('span', {}, ['#']), el('span'), el('span', {}, ['species']), el('span', {}, ['peak']), el('span', {}, ['now'])])]);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (let k = 0; k < BOARD_N; k++) {
    const icon = el('canvas'); icon.width = icon.height = Math.round(BOARD_ICON * dpr);
    const row = el('div', { class: 'brow' }, [el('span', { class: 'rank' }, [String(k + 1)]), icon, el('span', { class: 'bname' }), el('span', { class: 'bnum' }), el('span', { class: 'bnum' })]);
    row.style.display = 'none';
    board.append(row);
    boardRows.push(row);
  }
  boardEmpty = el('p', { class: 'hint' }, ['No species yet.']);
  side.append(withTip(section('Leaderboard', [board, boardEmpty]), HELP.board));
  boardAt = 0;

  // Rules
  const ageBtn = button('max-age death', () => { P.maxAgeOn = !P.maxAgeOn; ageBtn.classList.toggle('on', P.maxAgeOn); }, P.maxAgeOn ? 'on' : '', HELP.maxAgeToggle);
  const bodiesBtn = button('bodies', () => { P.bodiesOn = !P.bodiesOn; bodiesBtn.classList.toggle('on', P.bodiesOn); }, P.bodiesOn ? 'on' : '', HELP.bodies);
  const capBtn = button('unlimited', () => { P.capOff = !P.capOff; capBtn.classList.toggle('on', P.capOff); syncPopMax(); }, P.capOff ? 'on' : '', HELP.capOff);
  const kfmt = (v) => (v >= 1000 ? (v / 1000) + 'k' : String(v));
  side.append(section('Rules', [
    slider('softness σ', 0, 2, 0.05, () => P.sigma, (v) => P.sigma = v, f2, HELP.sigma),
    el('div', { class: 'row' }, [ageBtn]),
    slider('max age', 50, 2000, 10, () => P.maxAge, (v) => P.maxAge = v, (v) => v.toFixed(0), HELP.maxAge),
    (() => { const r = slider('heading noise', 0, 1.5, 0.05, () => P.headNoise, (v) => P.headNoise = v, f2, HELP.headNoise); r.classList.add('stack'); return r; })(),
    slider('max pop', 1000, MAXCAP, 1000, () => P.cap, (v) => { P.cap = v; syncPopMax(); }, kfmt, HELP.maxPop),
    el('div', { class: 'row' }, [capBtn, bodiesBtn]),
  ], 'live'));

  // Costs
  const costToggle = button(P.costsOn ? 'costs ON' : 'costs OFF', () => {
    P.costsOn = !P.costsOn; costToggle.textContent = P.costsOn ? 'costs ON' : 'costs OFF'; costToggle.classList.toggle('on', P.costsOn);
  }, P.costsOn ? 'on' : '', HELP.costs);
  side.append(section('Metabolic cost', [
    el('div', { class: 'row' }, [costToggle]),
    slider('kMove', 0, 2, 0.05, () => P.kMove, (v) => P.kMove = v, f2, HELP.kMove),
    slider('kSense', 0, 2, 0.05, () => P.kSense, (v) => P.kSense = v, f2, HELP.kSense),
    slider('kTol', 0, 2, 0.05, () => P.kTol, (v) => P.kTol = v, f2, HELP.kTol),
    (() => { const r = slider('generalist death', 0, 0.15, 0.005, () => P.kTolDeath, (v) => P.kTolDeath = v, (v) => v.toFixed(3), HELP.kTolDeath); r.classList.add('stack'); return r; })(),
    slider('kTaxis', 0, 2, 0.05, () => P.kTaxis, (v) => P.kTaxis = v, f2, HELP.kTaxis),
    slider('kAlign', 0, 2, 0.05, () => P.kAlign, (v) => P.kAlign = v, f2, HELP.kAlign),
  ], 'live'));

  // Trophic / energy
  const enToggle = button(P.energyOn ? 'energy ON' : 'energy OFF', () => {
    P.energyOn = !P.energyOn; enToggle.textContent = P.energyOn ? 'energy ON' : 'energy OFF'; enToggle.classList.toggle('on', P.energyOn);
    if (P.energyOn) { P.fieldSeed = freshFieldSeed(); buildField(state, P); }
  }, P.energyOn ? 'on' : '', HELP.energy);
  side.append(section('Trophic / energy', [
    el('div', { class: 'row' }, [enToggle]),
    slider('field patchiness', 0, 1, 0.02, () => P.fieldContrast, (v) => P.fieldContrast = v, f2, HELP.fieldContrast),
    slider('field regrow', 0, 0.3, 0.005, () => P.fieldRegrow, (v) => P.fieldRegrow = v, (v) => v.toFixed(3), HELP.fieldRegrow),
    slider('autotroph gain', 0, 1.5, 0.02, () => P.autoGain, (v) => P.autoGain = v, f2, HELP.autoGain),
    slider('predation', 0, 1.5, 0.02, () => P.predRate, (v) => P.predRate = v, f2, HELP.predRate),
    (() => { const r = slider('pack hunting', 0, 2, 0.05, () => P.huntThreshold, (v) => P.huntThreshold = v, f2, HELP.huntThreshold); r.classList.add('stack'); return r; })(),
    slider('specialization', 1, 4, 0.05, () => P.trophicExp, (v) => P.trophicExp = v, f2, HELP.trophicExp),
    slider('upkeep', 0, 0.3, 0.005, () => P.upkeep, (v) => P.upkeep = v, (v) => v.toFixed(3), HELP.upkeep),
    slider('feature cost', 0, 0.5, 0.01, () => P.geneCost, (v) => P.geneCost = v, f2, HELP.geneCost),
    slider('breed cost', 0.5, 8, 0.1, () => P.birthCost, (v) => P.birthCost = v, f2, HELP.birthCost),
  ], 'live'));

  // Inheritance
  side.append(section('Inheritance', [
    ctrlSelect('recomb', [['clonal', 'clonal'], ['crossover', 'crossover'], ['blend', 'blend']], P.recomb, (v) => P.recomb = v, HELP.recomb),
    ctrlSelect('mutation', [['gaussian', 'gaussian'], ['cornered', 'cornered']], P.mutation, (v) => P.mutation = v, HELP.mutation),
    slider('rate μ', 0, 0.5, 0.01, () => P.mu, (v) => P.mu = v, f2, HELP.mu),
    slider('σ_g', 0, 0.3, 0.005, () => P.sigmaG, (v) => P.sigmaG = v, (v) => v.toFixed(3), HELP.sigmaG),
    slider('macro', 0, 0.5, 0.01, () => P.macroRate, (v) => P.macroRate = v, (v) => v.toFixed(2), HELP.macroRate),
    slider('corner κ', 0, 0.5, 0.01, () => P.kappa, (v) => P.kappa = v, f2, HELP.kappa),
    slider('genus Δ', 0, 0.9, 0.005, () => P.genusThreshold, (v) => P.genusThreshold = v, (v) => v.toFixed(3), HELP.genusThreshold),
    slider('species Δ', 0, 0.6, 0.005, () => P.speciesThreshold, (v) => P.speciesThreshold = v, (v) => v.toFixed(3), HELP.speciesThreshold),
    slider('isolation', 0, 0.4, 0.005, () => P.isolation, (v) => P.isolation = v, (v) => v.toFixed(3), HELP.isolation),
  ], 'live'));

  // Rendering
  const linesBtn = button(ui.showLines ? 'lines ON' : 'lines OFF', () => {
    ui.showLines = !ui.showLines; linesBtn.textContent = ui.showLines ? 'lines ON' : 'lines OFF'; linesBtn.classList.toggle('on', ui.showLines);
  }, ui.showLines ? 'on' : '', HELP.lines);
  const shapesBtn = button(ui.shapes ? 'shapes ON' : 'shapes OFF', () => {
    ui.shapes = !ui.shapes; shapesBtn.textContent = ui.shapes ? 'shapes ON' : 'shapes OFF'; shapesBtn.classList.toggle('on', ui.shapes);
  }, ui.shapes ? 'on' : '', HELP.shapes);
  side.append(section('Rendering', [
    ctrlSelect('color', [['hash', 'species hash'], ['phenotype', 'phenotype'], ['lineage', 'genealogy'], ['trophic', 'trophic']], ui.colorMode, (v) => ui.colorMode = v, HELP.color),
    el('div', { class: 'row' }, [linesBtn, shapesBtn]),
  ], 'view'));

  // Brush genome
  const rr = geneR();
  const geneRows = GENE_NAMES.map((name, g) => slider(
    GENE_LABELS[g], rr[g][0], rr[g][1], (rr[g][1] - rr[g][0]) / 200,
    () => brush[g], (v) => { brush[g] = v; markBrushDirty(); },
    g === GENE.fecundity ? ((v) => v.toFixed(3)) : f2, HELP[name],
  ));
  for (const r of geneRows) r.classList.add('stack');   // long names: label on its own line
  side.append(section('Brush genome', [
    ...geneRows,
    el('div', { class: 'grid2' }, [button('randomize', randomizeBrush, '', HELP.randomize), button('copy hovered', copyHovered, '', HELP.copyHovered)]),
    el('p', { class: 'hint' }, ['click place · drag paint · shift-click blob · alt-drag erase · hover reads genome']),
  ], 'neu'));

  // Initialize
  const popRow = slider('population', 100, P.capOff ? MAXCAP : P.cap, 100, () => init.population, (v) => init.population = v, (v) => v.toFixed(0), HELP.population);
  popInput = popRow.querySelector('input'); popOut = popRow.querySelector('output');
  side.append(section('Initialize', [
    popRow,
    ctrlSelect('layout', [['uniform', 'uniform'], ['blob', 'central blob'], ['kblobs', 'k blobs'], ['ring', 'ring'], ['lattice', 'jittered lattice']], init.layout, (v) => init.layout = v, HELP.layout),
    ctrlSelect('genome', [['brush', 'clone brush'], ['uniform', 'uniform random'], ['twoclone', 'two clones A/B'], ['tworand', 'two random'], ['packs', 'prey + packs']], init.genomeInit, (v) => init.genomeInit = v, HELP.genomeInit),
    slider('spread', 0, 0.15, 0.005, () => init.spread, (v) => init.spread = v, (v) => v.toFixed(3), HELP.spread),
    button('apply init', applyInit, '', HELP.applyInit),
  ], 'reset'));

  side.append(section('Blob brush', [
    slider('N', 2, 400, 1, () => init.blobN, (v) => init.blobN = v, (v) => v.toFixed(0), HELP.blobN),
    slider('jitter', 2, 120, 1, () => init.blobJitter, (v) => init.blobJitter = v, (v) => v.toFixed(0), HELP.blobJitter),
  ], 'neu'));

  side.append(el('p', { class: 'hint about' }, [
    'Genomia — a little world of evolving genomes. ',
    el('a', { href: 'https://github.com/aubrika/genomia', target: '_blank', rel: 'noopener' }, ['Source & notes on GitHub']), '.',
  ]));
}

// ---- leaderboard -----------------------------------------------------------
const BOARD_N = 10, BOARD_ICON = 26, BOARD_EVERY_MS = 500;
let boardRows = [], boardEmpty = null, boardAt = 0;
function updateBoard(now) {
  if (now - boardAt < BOARD_EVERY_MS) return;
  boardAt = now;
  const hash = makeSpeciesHasher(state, P.R), top = topSpecies(state, BOARD_N, hash), seen = new Map();
  boardEmpty.style.display = top.length ? 'none' : '';
  boardRows.forEach((row, k) => {
    const t = top[k];
    if (!t) { row.style.display = 'none'; return; }
    row.style.display = '';
    const [, icon, nameEl, peakEl, nowEl] = row.children;
    drawSpeciesIcon(icon.getContext('2d'), state, t.sp, ui.colorMode, P.R, hash, ui.shapes);
    // two different hashes can draw the same name; number the repeats
    let name = speciesName(t.hash);
    const n = (seen.get(name) || 0) + 1; seen.set(name, n);
    if (n > 1) name += ' ' + ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n];
    nameEl.textContent = name;
    peakEl.textContent = String(t.peak);
    nowEl.textContent = t.now ? String(t.now) : '†';
    nowEl.classList.toggle('extinct', !t.now);
    const sides = ui.shapes ? speciesSides(state, t.sp, hash) : 0;
    row.setAttribute('data-tip', `${name}\nfirst seen as species ${t.sp} · genus ${state.spGenus[t.sp]} · lineage ${state.spLineage[t.sp]}\n` +
      `peaked at ${t.peak} living members on tick ${t.tick}\n` +
      `${t.now ? `${t.now} alive now${t.species > 1 ? `, across ${t.species} related species that share this look` : ''}` : 'extinct'}\n` +
      `${SHAPE_NAMES[sides]}${sides === 3 ? ' (pack instinct)' : ''}`);
  });
}

// The seeding-population slider can't exceed the population limit; keep its max (and
// value) in step when the limit changes, without rebuilding the panel mid-drag.
let popInput = null, popOut = null;
function syncPopMax() {
  if (!popInput) return;
  const mx = P.capOff ? MAXCAP : P.cap;
  popInput.max = mx;
  if (init.population > mx) init.population = mx;
  popInput.value = init.population; popOut.textContent = init.population.toFixed(0);
}

// ---- bottom sparklines ----------------------------------------------------
const hist = { pop: [], vi: [], lin: [], gm: [], gs: [], share: [] };
const HMAX = 320;
let sparkCanvases = {};
function buildBottom() {
  const bar = $('#bottom'); bar.textContent = '';
  function makeSpark(id, label, headline, tip, extraLabelNode) {
    const box = withTip(el('div', { class: 'spark' + (headline ? ' headline' : '') }), tip);
    const lbl = el('div', { class: 'lbl' }, []);
    lbl.append(extraLabelNode || el('span', {}, [label]));
    const val = el('span', { class: 'val' }); val.id = id + 'v';
    lbl.append(val);
    const cvs = el('canvas'); cvs.id = id + 'c';
    box.append(lbl, cvs);
    bar.append(box);
    sparkCanvases[id] = cvs;
  }
  makeSpark('pop', 'population', false, HELP.sparkPop);
  const dd = select(GENE_LABELS.map((n, i) => [String(i), n]), String(selGene), (v) => { selGene = parseInt(v, 10); });
  makeSpark('gene', 'gene', false, HELP.sparkGene, dd);
  makeSpark('vi', 'variance', true, HELP.sparkVar);
  makeSpark('lin', 'species', false, HELP.sparkSpecies);
  makeSpark('share', 'share', false, HELP.sparkShare);
}
function pushHist(s) {
  hist.pop.push(s.population); hist.vi.push(s.varianceIndex); hist.lin.push(s.species);
  hist.gm.push(s.mean[selGene]); hist.gs.push(s.sd[selGene]);
  // per-founder-lineage counts for the share chart (tracked lineages + an "other" bin)
  const row = new Float32Array(trackedLins.length + 1);
  if (trackedLins.length) {
    const idx = new Map(trackedLins.map((l, i) => [l, i]));
    for (let i = 0; i < state.count; i++) { const li = idx.get(state.lineage[i]); if (li !== undefined) row[li]++; else row[row.length - 1]++; }
  }
  hist.share.push(row);
  for (const k in hist) if (hist[k].length > HMAX) hist[k].shift();
}
// Size a sparkline's backing store to its CSS box at devicePixelRatio (crisp on retina)
// and return a context that draws in CSS pixels.
function sparkCtx(cvs) {
  const dpr = devicePixelRatioCapped(), w = cvs.clientWidth, h = cvs.clientHeight;
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (cvs.width !== bw) cvs.width = bw; if (cvs.height !== bh) cvs.height = bh;
  const ctx = cvs.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function drawSeries(cvs, data, color, lo, hi, band) {
  const { ctx, w, h } = sparkCtx(cvs);
  if (data.length < 2) return;
  const n = data.length, span = (hi - lo) || 1;
  const X = (i) => (i / (HMAX - 1)) * w;
  const Y = (v) => h - ((v - lo) / span) * h;
  if (band) {
    ctx.fillStyle = 'rgba(138,128,120,0.18)';
    ctx.beginPath();
    for (let i = 0; i < n; i++) ctx.lineTo(X(i), Y(data[i] + band[i]));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(i), Y(data[i] - band[i]));
    ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.beginPath();
  for (let i = 0; i < n; i++) { const x = X(i), y = Y(data[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke();
}
// Stacked-area of founder-lineage share over time. Each band is a lineage's fraction
// of the living population; the top "other" band (grey) is anything founded later.
function drawStack(cvs, frames, cols) {
  const { ctx, w, h } = sparkCtx(cvs);
  const n = frames.length; if (n < 2) return;
  const bands = frames[n - 1].length;
  const X = (i) => (i / (HMAX - 1)) * w;
  const tot = frames.map((f) => { let t = 0; for (let k = 0; k < f.length; k++) t += f[k]; return t || 1; });
  for (let b = bands - 1; b >= 0; b--) {          // paint high cumulative first; lower bands overlay
    ctx.fillStyle = b < cols.length ? cols[b] : 'rgba(138,128,120,0.55)';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const f = frames[i]; let cum = 0; for (let k = 0; k <= b && k < f.length; k++) cum += f[k];
      ctx.lineTo(X(i), h - (cum / tot[i]) * h);
    }
    ctx.lineTo(X(n - 1), h); ctx.lineTo(X(0), h); ctx.closePath(); ctx.fill();
  }
}
function drawSparks(s) {
  const amax = (a, m) => Math.max(m, ...a);
  drawSeries(sparkCanvases.pop, hist.pop, '#D6CFC6', 0, Math.max(amax(hist.pop, 10) * 1.1, P.cap * 0.1));
  const rr = geneR();
  drawSeries(sparkCanvases.gene, hist.gm, '#D6CFC6', rr[selGene][0], rr[selGene][1], hist.gs);
  drawSeries(sparkCanvases.vi, hist.vi, '#C9873A', 0, Math.max(amax(hist.vi, 0.005) * 1.1, 0.01));
  drawSeries(sparkCanvases.lin, hist.lin, '#D6CFC6', 0, amax(hist.lin, 10) * 1.1);
  drawStack(sparkCanvases.share, hist.share, trackedCols);
  $('#popv').textContent = s.population;
  $('#genev').textContent = f2(s.mean[selGene]) + ' ±' + f2(s.sd[selGene]);
  $('#viv').textContent = s.varianceIndex.toFixed(4);
  $('#linv').textContent = s.species;
  // share value: the leading tracked lineage's percent of the population
  const last = hist.share[hist.share.length - 1];
  if (last && s.population > 0) {
    let mx = 0; for (let k = 0; k < trackedLins.length; k++) if (last[k] > mx) mx = last[k];
    $('#sharev').textContent = Math.round(100 * mx / s.population) + '%';
  } else $('#sharev').textContent = '—';
}

// ---- init / presets -------------------------------------------------------
function applyInit() {
  errorShown = '';   // a fresh run may show the same error again
  resetState(state, init.seed | 0);
  state.energy0 = P.energyMax * 0.5;
  P.fieldSeed = pinnedFieldSeed != null ? pinnedFieldSeed : freshFieldSeed();   // a new flora pattern each reset
  pinnedFieldSeed = null;
  const founder = seedPopulation(state, P, init, brush, brushB);
  // the brush belongs to the seeded founder (if any), so painting with it unchanged
  // extends that lineage; otherwise the next placement founds anew
  if (founder) { curLineage = founder.lineage; curSpecies = founder.species; brushDirty = false; }
  else { brushDirty = true; curSpecies = -1; }
  if (P.energyOn) buildField(state, P);
  captureTracked();
  for (const k in hist) hist[k].length = 0;
  pushHist(computeStats(state, P));
}

// The founder lineages present just after seeding — the bands the share chart tracks.
// Kept small (most-populous first); anything founded later is lumped as "other".
let trackedLins = [], trackedCols = [];
function captureTracked() {
  const counts = new Map();
  for (let i = 0; i < state.count; i++) { const l = state.lineage[i]; counts.set(l, (counts.get(l) || 0) + 1); }
  trackedLins = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0]);
  trackedCols = trackedLins.map((l) => { const [r, g, b] = hslToRgb(((l * 137.508) % 360 + 360) % 360, 60, 56); return `rgb(${r},${g},${b})`; });
}

// Presets are whole scenarios over the defaults (see applyPreset). Brush dispersal and
// motility are in units of R. Each is checked headlessly against its blurb across
// seeds and window sizes; the comment says what it reliably shows.
const PRESETS = [
  { // Conway-ish — tight Life-like bands from a dense lattice. The synchronous start
    // overshoots: ~95% die within ~300 ticks, then the surviving colonies spread back
    // over ~1000 ticks. Low mutation keeps the rules Life-like while they do.
    brush: { rScale: 1.0, sLo: 0.7, sHi: 3.4, bLo: 1.45, bHi: 2.5, fec: 0.22, dDisp: 0.72, dCV: 0.3, step: 0.035, taxis: -0.15 },
    P: { mu: 0.02, sigma: 0.6 },
    init: { layout: 'lattice', genomeInit: 'brush', population: 9000, spread: 0.03 },
  },
  { // Gray goo — costs off from 12000 random genomes (random body sizes make the opening
    // crash deep; 12000 leaves enough survivors to recover in every tested seed).
    // Tolerance is free, so survival and
    // breeding windows open to their limits, fertility maxes out and the habitat fills
    // to the cap; several lineages survive but all converge on the same grey phenotype.
    brush: { rScale: 1.2, sLo: 0.0, sHi: 6, bLo: 0.0, bHi: 6, fec: 0.30, dDisp: 1.0, dCV: 0.3, step: 0.10, taxis: 0.0 },
    P: { costsOn: false },
    init: { layout: 'uniform', genomeInit: 'uniform', population: 12000 },
    color: 'phenotype',
  },
  { // Blend collapse — a viable clone seeded with extra genetic spread, inherited by
    // blending. The variance index drops ~85% within ~100 ticks; with crossover the same
    // start holds and grows its variance instead.
    brush: { rScale: 1.0, sLo: 0.4, sHi: 4.5, bLo: 0.8, bHi: 3.6, fec: 0.22, dDisp: 1.3, dCV: 0.4, step: 0.10, taxis: 0.10 },
    P: { recomb: 'blend' },
    init: { layout: 'uniform', genomeInit: 'brush', population: 10000, spread: 0.1 },
    color: 'phenotype',
  },
  { // Aggregation — strong sociability under a low population limit. The scattered
    // population thins, then regrows as dense colonies that drift and merge; by ~2000
    // ticks usually 1–4 remain (sometimes up to ~8, still merging).
    brush: { rScale: 1.0, sLo: 0.22, sHi: 6.0, bLo: 0.4, bHi: 2.93, fec: 0.27, dDisp: 0.5, dCV: 0.3, step: 0.29, taxis: 0.67 },
    P: { mu: 0.05, cap: 3500 },
    init: { layout: 'uniform', genomeInit: 'brush', population: 3000 },
  },
  { // Allee frontier — one colony with a high loneliness limit: cells that stray from
    // the group die, so the colony grows only at its edge, as a front that sweeps the
    // habitat over ~1000 ticks.
    brush: { rScale: 1.0, sLo: 1.24, sHi: 5.9, bLo: 1.57, bHi: 5.2, fec: 0.26, dDisp: 0.5, dCV: 0.17, step: 0.04, taxis: 0.2 },
    P: { mu: 0.02, sigma: 0.5 },
    init: { layout: 'blob', genomeInit: 'brush', population: 1500 },
  },
  { // Membranes — sociable cells pull together, but a low crowding limit kills the
    // packed interiors, leaving colonies riddled with holes.
    brush: { rScale: 1.0, sLo: 0.37, sHi: 2.88, bLo: 1.47, bHi: 2.8, fec: 0.24, dDisp: 1.0, dCV: 0.3, step: 0.02, taxis: 0.68 },
    P: { mu: 0.02, sigma: 0.31, cap: 8000 },
    init: { layout: 'uniform', genomeInit: 'brush', population: 7000 },
  },
  { // Species bloom — one founder under fast mutation, with short dispersal (local
    // neighbourhoods) and reproductive isolation (mates must be genetically close), so
    // diverging groups stop interbreeding. By ~1500 ticks it holds around ten large
    // species (200+ cells; 7–14 across seeds) and many small ones.
    brush: { rScale: 1.0, sLo: 0.6, sHi: 4.0, bLo: 1.0, bHi: 2.6, fec: 0.24, dDisp: 0.6, dCV: 0.3, step: 0.03, taxis: 0.10 },
    P: { mu: 0.2, sigmaG: 0.06, macroRate: 0.03, isolation: 0.1, speciesThreshold: 0.2, genusThreshold: 0.4 },
    init: { layout: 'uniform', genomeInit: 'brush', population: 4000, spread: 0.02 },
  },
  { // Trophic web — the energy model on over a patchy resource field. One mixed lineage
    // under strong specialization selection (trophicExp) splits into green autotroph
    // "plants" grazing the field and red heterotroph "animals" preying on them.
    brush: { rScale: 1.0, sLo: 0.0, sHi: 6.0, bLo: 0.2, bHi: 6.0, fec: 0.5, dDisp: 0.45, dCV: 0.4, step: 0.06, taxis: 0.3, trophic: 0.05 },
    P: {
      costsOn: true, recomb: 'crossover', mutation: 'gaussian', sigma: 0.3, mu: 0.14, sigmaG: 0.06, macroRate: 0.05,
      energyOn: true, fieldContrast: 0.8, fieldRegrow: 0.20, autoGain: 1.1, predRate: 0.6, predGain: 0.6, trophicExp: 2.0, upkeep: 0.02, geneCost: 0.03, birthCost: 2.0,
    },
    init: { layout: 'uniform', genomeInit: 'brush', population: 3500, spread: 0.05 },
    color: 'trophic',
  },
  { // Two lineages — the plain sandbox scene: two founder genomes, each randomized
    // around the default brush, fill opposite halves and compete across the front where
    // they meet. Everything else at defaults.
    brush: { rScale: 1.0, sLo: 0.4, sHi: 4.5, bLo: 0.8, bHi: 3.6, fec: 0.22, dDisp: 1.3, dCV: 0.4, step: 0.10, taxis: 0.10, trophic: 0.5 },
    P: {},
    init: {},
  },
  { // Flocks — strong pack instinct (align 0.9) and mild sociability under a low
    // population limit: the population breaks into ~20–30 groups of ~100 that move
    // ~3x faster than without alignment and hold their course (direction persistence
    // ~0.7 vs ~0.2). Low mutation keeps the instinct from eroding under its cost.
    brush: { rScale: 1.0, sLo: 0.4, sHi: 4.5, bLo: 0.8, bHi: 3.6, fec: 0.22, dDisp: 0.6, dCV: 0.3, step: 0.2, taxis: 0.2, align: 0.9 },
    P: { cap: 3000, headNoise: 0.1, mu: 0.03 },
    init: { genomeInit: 'brush', population: 2500 },
  },
  { // Hunting packs — the Trophic web's plants plus five packs of omnivorous hunters
    // (diet 0.73) with strong pack instinct, under cooperative hunting: a bite only lands
    // fully when enough hunters press the same prey. Hunters persist as ~15–20 travelling
    // packs of ~20–40 that hold their course; with cooperative hunting off they dwindle
    // to a few dozen, and without pack instinct they survive only as stationary clumps.
    brush: { rScale: 1.0, sLo: 0.0, sHi: 6.0, bLo: 0.2, bHi: 6.0, fec: 0.5, dDisp: 0.45, dCV: 0.4, step: 0.06, taxis: 0.3, trophic: 0.05 },
    brushB: { rScale: 0.96, sLo: 0.27, sHi: 5.1, bLo: 1.04, bHi: 5.68, fec: 0.056, dDisp: 0.6, dCV: 0.3, step: 0.09, taxis: 0.25, trophic: 0.73, align: 0.94 },
    P: {
      costsOn: true, recomb: 'crossover', mutation: 'gaussian', sigma: 0.3, mu: 0.02, sigmaG: 0.06, macroRate: 0.004, headNoise: 0.14,
      energyOn: true, fieldContrast: 0.8, fieldRegrow: 0.20, autoGain: 1.1, predRate: 1.06, predGain: 0.88, trophicExp: 1.9, upkeep: 0.009, geneCost: 0.03, birthCost: 2.17,
      isolation: 0.3, huntThreshold: 0.75,
    },
    init: { genomeInit: 'packs', population: 3500, spread: 0.03, packs: 5, packSize: 33 },
    color: 'trophic',
  },
  { // Coevolution — the Trophic web, plus cooperative hunting (0.75) and mate choice
    // (isolation 0.3, so hunters and plants keep separate gene pools). Nobody starts with
    // pack instinct. In 6 of 6 test runs the plants' mean pack instinct rose from ~0.02 to
    // 0.59–0.84 within 10,000 ticks (herding under predation; without cooperative hunting
    // it stays 0.15–0.30); hunters' rose above 0.4 in 4 of 6, though they rarely formed
    // coherent travelling packs. Opens on the pack instinct chart, at max speed.
    brush: { rScale: 1.0, sLo: 0.0, sHi: 6.0, bLo: 0.2, bHi: 6.0, fec: 0.5, dDisp: 0.45, dCV: 0.4, step: 0.06, taxis: 0.3, trophic: 0.05 },
    P: {
      costsOn: true, recomb: 'crossover', mutation: 'gaussian', sigma: 0.3, mu: 0.14, sigmaG: 0.06, macroRate: 0.05,
      energyOn: true, fieldContrast: 0.8, fieldRegrow: 0.20, autoGain: 1.1, predRate: 0.6, predGain: 0.6, trophicExp: 2.0, upkeep: 0.02, geneCost: 0.03, birthCost: 2.0,
      huntThreshold: 0.75, isolation: 0.3,
    },
    init: { layout: 'uniform', genomeInit: 'brush', population: 3500, spread: 0.05 },
    color: 'trophic', gene: 'align', speed: Infinity,
  },
];
// A preset is a whole scenario: every rule and seeding setting starts from the
// defaults, so the result never depends on what was run before. Only the seed, the
// blob-brush tools and the window-derived values carry over.
function applyPreset(i) {
  const pr = PRESETS[i];
  curPreset = i;
  const keep = { worldW: P.worldW, worldH: P.worldH, R: P.R, fieldSeed: P.fieldSeed };
  Object.assign(P, DEFAULTS, keep, pr.P);
  setBrush(Object.assign({ trophic: 0.5, align: 0, body: 0.26 }, pr.brush));
  brushB = pr.brushB ? specInto(new Float32Array(G), Object.assign({ trophic: 0.5, align: 0, body: 0.26 }, pr.brushB)) : null;
  Object.assign(init, INIT_DEFAULTS, { seed: init.seed, blobN: init.blobN, blobJitter: init.blobJitter }, pr.init);
  ui.colorMode = pr.color || 'hash';
  ui.speed = pr.speed || 1;
  if (pr.gene) { selGene = GENE[pr.gene]; const dd = $('#bottom select'); if (dd) dd.value = String(selGene); }
  buildSide();
  applyInit();
  if (!ui.playing) togglePlay();
}

function randomizeBrush() {
  const rr = geneR(), rng = state.rng;
  for (let g = 0; g < G; g++) brush[g] = rng.range(rr[g][0], rr[g][1]);
  markBrushDirty(); buildSide();
}
function copyHovered() {
  if (ui.hovered < 0 || ui.hovered >= state.count) return;
  const base = ui.hovered * G;
  for (let g = 0; g < G; g++) brush[g] = state.genome[base + g];
  markBrushDirty(); buildSide();
}

// ---- canvas / view --------------------------------------------------------
const canvas = $('#canvas');
// The URL hash carries an optional shared config (#cfg=…) plus dev/testing flags; split
// them so a base64 config can never be mistaken for a flag.
const hashParts = location.hash.slice(1).split('&').filter(Boolean);
const cfgPart = hashParts.find((h) => h.startsWith('cfg='));
const devHash = hashParts.filter((h) => !h.startsWith('cfg=')).join('&');
// Prefer WebGL2 (one draw call for all cells — scales to the "unlimited" cap); fall
// back to the Canvas2D renderer if it's unavailable or forced off with #no-gl.
const glRenderer = devHash.includes('no-gl') ? null : createGLRenderer(canvas);
let renderFn, rendererName;
if (glRenderer) { renderFn = (s, pp, v, u) => glRenderer.draw(s, pp, v, u); rendererName = 'webgl2'; }
else { const ctx = canvas.getContext('2d', { alpha: false }); renderFn = (s, pp, v, u) => draw(ctx, s, pp, v, u); rendererName = 'canvas2d'; }
// The world is the habitat canvas: a rectangular torus the size of the canvas, drawn
// 1:1 (scale 1, no letterbox). The canvas occupies the top-left region (the fixed UI
// panels sit beside and below it, not over it — see style.css). Perception radius R
// scales with √area, so density depends only on population (window-independent) —
// every preset stays calibrated at any window size. A resize just "zooms" the
// running ecosystem: positions, R, and the R-relative genes (dDisp, step) all
// scale together, so the dynamics are preserved.
// The world is measured in CSS pixels; the canvas backing store is devicePixelRatio
// times larger (capped at 2 for fill-rate), and view.scale maps one onto the other —
// so the simulation is identical on a retina screen, just drawn sharper.
const R_FROM_AREA = (area) => Math.max(8, Math.min(40, 0.017 * Math.sqrt(area)));
function devicePixelRatioCapped() { return Math.min(2, window.devicePixelRatio || 1); }
function resize() {
  const rect = $('#stage').getBoundingClientRect(), dpr = devicePixelRatioCapped();
  const W = Math.max(1, Math.floor(rect.width)), H = Math.max(1, Math.floor(rect.height));
  if (W === P.worldW && H === P.worldH && canvas.width === Math.round(W * dpr)) return; // nothing changed
  const oldW = P.worldW, oldH = P.worldH, oldR = P.R;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  P.worldW = W; P.worldH = H;
  view.scale = canvas.width / W; view.ox = 0; view.oy = 0;
  const newR = R_FROM_AREA(P.worldW * P.worldH), s = newR / oldR;
  if (oldW) {
    const sx = P.worldW / oldW, sy = P.worldH / oldH;
    for (let i = 0; i < state.count; i++) {
      state.x[i] *= sx; state.y[i] *= sy;
      state.genome[i * G + GENE.dDisp] *= s; state.genome[i * G + GENE.step] *= s;
    }
  }
  brush[GENE.dDisp] *= s; brush[GENE.step] *= s;   // keep the brush R-relative too
  if (brushB) { brushB[GENE.dDisp] *= s; brushB[GENE.step] *= s; }
  P.R = newR; P._rangesR = -1;                      // force sim to recompute gene ranges
  if (P.energyOn) { if (P.fieldSeed == null) P.fieldSeed = freshFieldSeed(); buildField(state, P); } // rebuild at new dims, same pattern
  if (oldW && s !== 1) buildSide();   // brush sliders read R-relative genes
}
window.addEventListener('resize', resize);

function worldFromEvent(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function pickAgent(wx, wy) {
  const Wx = P.worldW, Wy = P.worldH, hx = Wx / 2, hy = Wy / 2, thr = 8; let bd = thr * thr, best = -1;
  for (let i = 0; i < state.count; i++) {
    let dx = state.x[i] - wx, dy = state.y[i] - wy;
    if (dx > hx) dx -= Wx; else if (dx < -hx) dx += Wx;
    if (dy > hy) dy -= Wy; else if (dy < -hy) dy += Wy;
    const d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = i; }
  }
  return best;
}
function eraseAt(wx, wy) {
  const Wx = P.worldW, Wy = P.worldH, hx = Wx / 2, hy = Wy / 2, r = 18, r2 = r * r;
  for (let i = 0; i < state.count;) {
    let dx = state.x[i] - wx, dy = state.y[i] - wy;
    if (dx > hx) dx -= Wx; else if (dx < -hx) dx += Wx;
    if (dy > hy) dy -= Wy; else if (dy < -hy) dy += Wy;
    if (dx * dx + dy * dy < r2) {
      const last = --state.count;
      state.x[i] = state.x[last]; state.y[i] = state.y[last]; state.age[i] = state.age[last];
      state.lineage[i] = state.lineage[last]; state.species[i] = state.species[last]; state.energy[i] = state.energy[last]; state.heading[i] = state.heading[last];
      const a = i * G, b = last * G; for (let g = 0; g < G; g++) state.genome[a + g] = state.genome[b + g];
    } else i++;
  }
}
// Hand placement respects bodies too: a spot overlapping another cell is skipped.
function paintOne(x, y) {
  if (!createOccupancy(state, P).fits(x, y, bodyRadius(brush, 0, P.R))) return;
  const f = brushFounder();
  addAgent(state, x, y, new Float32Array(brush), f.lineage, geneR(), f.species);
}
function placeBlob(wx, wy) {
  const rr = geneR(), Wx = P.worldW, Wy = P.worldH, rng = state.rng, f = brushFounder();
  const wx_ = (v) => ((v % Wx) + Wx) % Wx, wy_ = (v) => ((v % Wy) + Wy) % Wy;
  const occ = createOccupancy(state, P), r = bodyRadius(brush, 0, P.R);
  for (let i = 0; i < init.blobN; i++) {
    const ang = rng.next() * 6.283185307179586, rad = Math.abs(rng.gauss()) * init.blobJitter;
    const x = wx_(wx + Math.cos(ang) * rad), y = wy_(wy + Math.sin(ang) * rad);
    if (!occ.fits(x, y, r)) continue;
    if (addAgent(state, x, y, new Float32Array(brush), f.lineage, rr, f.species) >= 0) occ.add(x, y, r);
  }
}

// ---- interaction ----------------------------------------------------------
let dragMode = null, lastPaint = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const w = worldFromEvent(e);
  if (e.altKey) { dragMode = 'erase'; eraseAt(w.x, w.y); }
  else if (e.shiftKey) { dragMode = 'blob'; placeBlob(w.x, w.y); }
  else { dragMode = 'paint'; paintOne(w.x, w.y); lastPaint = w; }
});
canvas.addEventListener('pointermove', (e) => {
  const w = worldFromEvent(e);
  if (dragMode === 'erase') eraseAt(w.x, w.y);
  else if (dragMode === 'paint') {
    const dx = w.x - lastPaint.x, dy = w.y - lastPaint.y;
    if (dx * dx + dy * dy > (7 / view.scale) ** 2) { paintOne(w.x, w.y); lastPaint = w; }
  } else {
    ui.hovered = pickAgent(w.x, w.y);
    updateTooltip(e);
  }
});
canvas.addEventListener('pointerup', () => { dragMode = null; });
canvas.addEventListener('pointerleave', () => { ui.hovered = -1; $('#tooltip').style.display = 'none'; });

function updateTooltip(e) {
  const tip = $('#tooltip');
  if (ui.hovered < 0) { tip.style.display = 'none'; return; }
  const base = ui.hovered * G;
  const rows = GENE_LABELS.map((n, g) => `<span class="k">${n}</span> ${g === GENE.fecundity ? state.genome[base + g].toFixed(3) : f2(state.genome[base + g])}`);
  const en = P.energyOn ? ` · <span class="k">e</span> ${state.energy[ui.hovered].toFixed(1)}` : '';
  const sp = state.species[ui.hovered];
  tip.innerHTML = `<b>${speciesName(makeSpeciesHasher(state, P.R)(sp))}</b><br>#${ui.hovered} · lin ${state.lineage[ui.hovered]} · genus ${state.spGenus[sp]} · sp ${sp} · ${SHAPE_NAMES[speciesSides(state, sp, makeSpeciesHasher(state, P.R))]} · age ${state.age[ui.hovered] | 0}${en}<br>` + rows.join('<br>');
  tip.style.display = 'block';
  const r = canvas.getBoundingClientRect();
  let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
  if (x + tip.offsetWidth > r.width - 8) x -= tip.offsetWidth + 28;
  if (y + tip.offsetHeight > r.height - 8) y -= tip.offsetHeight + 28;
  x = Math.max(4, x); y = Math.max(4, y);
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

// ---- share / snapshot -----------------------------------------------------
// A shared link (#cfg=<base64url JSON>) re-seeds the same run: seed, flora seed, every
// rule that differs from the defaults, the initializer, the brush (dispersal and
// motility stored relative to R, so it survives a different window size), and the view.
const NOT_SHARED = new Set(['world', 'worldW', 'worldH', 'R', 'fieldSeed', '_rangesR']);
const R_RELATIVE = (g) => g === GENE.dDisp || g === GENE.step;
const short = (v) => (typeof v === 'number' ? +v.toPrecision(5) : v);
function encodeConfig() {
  const p = {};
  for (const k in DEFAULTS) if (!NOT_SHARED.has(k) && P[k] !== DEFAULTS[k]) p[k] = short(P[k]);
  const cfg = {
    v: 1, seed: init.seed, fs: P.fieldSeed >>> 0, p,
    init: Object.fromEntries(Object.entries(init).map(([k, v]) => [k, short(v)])),
    b: Array.from(brush, (v, g) => short(R_RELATIVE(g) ? v / P.R : v)),
    b2: brushB ? Array.from(brushB, (v, g) => short(R_RELATIVE(g) ? v / P.R : v)) : undefined,
    c: ui.colorMode, l: ui.showLines ? 1 : 0, sh: ui.shapes ? 1 : 0, pr: curPreset,
  };
  return btoa(JSON.stringify(cfg)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Apply a decoded config, accepting only known keys of the right type (links are untrusted input).
function applyConfig(str) {
  let cfg;
  try { cfg = JSON.parse(atob(str.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return false; }
  if (!cfg || typeof cfg !== 'object') return false;
  const sameType = (a, b) => typeof a === typeof b && (typeof a !== 'number' || Number.isFinite(a));
  if (cfg.p && typeof cfg.p === 'object') for (const k in cfg.p) if (Object.hasOwn(DEFAULTS, k) && !NOT_SHARED.has(k) && sameType(cfg.p[k], DEFAULTS[k])) P[k] = cfg.p[k];
  if (cfg.init && typeof cfg.init === 'object') for (const k in cfg.init) if (Object.hasOwn(init, k) && sameType(cfg.init[k], init[k])) init[k] = cfg.init[k];
  if (Number.isFinite(cfg.seed)) init.seed = cfg.seed | 0;
  if (Number.isFinite(cfg.fs)) pinnedFieldSeed = cfg.fs >>> 0;
  // older links carry fewer brush genes: pad with the defaults of the genes added since
  // (pack instinct 0, body size 0.26)
  const pad = (b) => (Array.isArray(b) && b.length >= G - 2 && b.length < G ? b.concat([0, 0.26].slice(b.length - (G - 2))) : b);
  cfg.b = pad(cfg.b); cfg.b2 = pad(cfg.b2);
  if (Array.isArray(cfg.b) && cfg.b.length === G && cfg.b.every(Number.isFinite)) {
    for (let g = 0; g < G; g++) brush[g] = R_RELATIVE(g) ? cfg.b[g] * P.R : cfg.b[g];
    markBrushDirty();
  }
  if (Array.isArray(cfg.b2) && cfg.b2.length === G && cfg.b2.every(Number.isFinite)) {
    brushB = new Float32Array(G);
    for (let g = 0; g < G; g++) brushB[g] = R_RELATIVE(g) ? cfg.b2[g] * P.R : cfg.b2[g];
  }
  if (['hash', 'phenotype', 'lineage', 'trophic'].includes(cfg.c)) ui.colorMode = cfg.c;
  if (cfg.l === 0 || cfg.l === 1) ui.showLines = !!cfg.l;
  if (cfg.sh === 0 || cfg.sh === 1) ui.shapes = !!cfg.sh;
  if (Number.isInteger(cfg.pr) && cfg.pr >= -1 && cfg.pr < PRESETS.length) curPreset = cfg.pr;
  return true;
}
function copyLink(e) {
  const btn = e.currentTarget;
  const url = location.origin + location.pathname + '#cfg=' + encodeConfig();
  const done = () => { const t = btn.textContent; btn.textContent = '✓ copied'; setTimeout(() => { btn.textContent = t; }, 1400); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link:', url));
  else window.prompt('Copy this link:', url);
}
function snapshot() {
  // redraw without the hover overlay, then read the canvas in the same task (WebGL's
  // buffer is only guaranteed until the frame is composited)
  renderFn(state, P, view, Object.assign({}, ui, { hovered: -1 }));
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = el('a', { href: URL.createObjectURL(blob), download: `genomia-seed${init.seed}-t${state.tick}.png` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}

// ---- loop -----------------------------------------------------------------
function syncPlayButtons() {
  const b = $('#playbtn'); if (b) b.textContent = ui.playing ? '❚❚ pause' : '▶ play';
  const c = $('#cornerplay'); c.textContent = ui.playing ? '❚❚' : '▶'; c.setAttribute('aria-label', ui.playing ? 'Pause' : 'Play');
}
function setSpeed(v) {
  ui.speed = v;
  for (const b of document.querySelectorAll('.seg.speed button')) b.classList.toggle('on', SPEEDS[+b.dataset.speed] === v);
}
function togglePlay() {
  ui.playing = !ui.playing;
  syncPlayButtons();
}

// Collapsed view: hide the panel, sparklines and readout so the habitat fills the
// window. The world rescales like any window resize (resize() keeps dynamics intact).
function toggleUI() {
  const collapsed = document.body.classList.toggle('collapsed');
  const t = $('#uitoggle');
  t.textContent = collapsed ? '⤡' : '⤢';
  t.setAttribute('aria-label', collapsed ? 'Show controls' : 'Hide controls');
  t.setAttribute('data-tip', collapsed ? 'Show the controls and charts. (H or Esc)' : 'Hide the controls and charts — just the habitat. (H)');
  hideTip();   // the layout moved under the cursor; don't leave a stale tip behind
  resize();
}
function singleStep() { step(state, P); updatePeaks(state, makeSpeciesHasher(state, P.R)); pushHist(computeStats(state, P)); }

let fpsT = 0, fpsN = 0, fps = 0;
let ticksPerFrame = 0;
// A frame that throws would otherwise stop the animation loop silently (a frozen
// picture), so frame() runs its body in a try and keeps scheduling itself: an error
// pauses the run and shows a banner with copyable details instead.
function frame(t) {
  try { frameBody(t); } catch (err) {
    reportError(err);
    try { renderFn(state, P, view, ui); } catch (e) { /* keep the last picture if drawing itself fails */ }
  }
  requestAnimationFrame(frame);
}
function frameBody(t) {
  const hasher = makeSpeciesHasher(state, P.R);
  updatePeaks(state, hasher);   // counts seeded and painted cells too, not just births
  if (ui.playing) {
    const t0 = performance.now(); let k = 0;
    do { step(state, P); updatePeaks(state, hasher); k++; } while (k < ui.speed && performance.now() - t0 < STEP_BUDGET_MS);
    ticksPerFrame = k;
  }
  renderFn(state, P, view, ui);
  const s = computeStats(state, P);
  if (ui.playing) pushHist(s);
  drawSparks(s);
  updateBoard(t);
  fpsN++; if (t - fpsT > 500) { fps = Math.round(fpsN * 1000 / (t - fpsT)); fpsN = 0; fpsT = t; }
  const troph = P.energyOn ? ` · plants <b>${s.plants}</b> · animals <b>${s.animals}</b> · e̅ <b>${s.meanEnergy.toFixed(1)}</b>` : '';
  $('#starthint').style.display = !ui.playing && state.tick === 0 ? 'block' : 'none';
  $('#hud').innerHTML = `tick <b>${state.tick}</b> · pop <b>${state.count}</b> · lineages <b>${s.lineages}</b> · genera <b>${s.genera}</b>${troph} · ${fps} fps · ${rendererName}${ui.playing ? (ui.speed > 1 ? ` · <b>${ticksPerFrame}</b> ticks/frame` : '') : ' · <b>paused</b>'}`;
}

window.addEventListener('keydown', (e) => {
  if (welcome.open) return;   // the guide's own buttons take the keys (Esc closes it)
  if (e.key === '?') { openWelcome(); return; }
  const t = e.target;
  // text fields and menus keep their keys; sliders don't need Space/R, so shortcuts still work after a drag
  if ((t.tagName === 'INPUT' && t.type !== 'range') || t.tagName === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === '.') { e.preventDefault(); singleStep(); }
  else if (e.key === 'r' || e.key === 'R') applyInit();
  else if (e.key === '[' || e.key === ']') { const k = SPEEDS.indexOf(ui.speed) + (e.key === ']' ? 1 : -1); setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, k))]); }
  else if (e.key === 'h' || e.key === 'H' || (e.key === 'Escape' && document.body.classList.contains('collapsed'))) toggleUI();
});
// Some browsers activate a focused button on Space keyup even when keydown was
// cancelled, which would toggle play twice; swallow it.
window.addEventListener('keyup', (e) => { if (e.code === 'Space' && e.target.tagName === 'BUTTON') e.preventDefault(); });

// ---- help tooltips --------------------------------------------------------
// One floating element follows the cursor and shows the data-tip of whatever
// control is under it — read live, so rebuilding the panel needs no re-wiring.
let hideTip = () => {};
function setupTips() {
  const tip = el('div'); tip.id = 'uitip'; document.body.appendChild(tip);
  let cur = null;
  hideTip = () => { cur = null; tip.style.display = 'none'; };
  const place = (e) => {
    let x = e.clientX + 18, y = e.clientY + 20;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
  };
  // mouse only: on touch, a tap would leave a tip stuck on screen
  document.addEventListener('pointermove', (e) => {
    const t = e.pointerType === 'mouse' && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (t) {
      const txt = t.getAttribute('data-tip');
      if (txt !== cur) { cur = txt; tip.textContent = txt; tip.style.display = 'block'; }
      place(e);
    } else if (cur !== null) { cur = null; tip.style.display = 'none'; }
  });
}

// ---- error banner ---------------------------------------------------------
// Any uncaught error (in the frame loop, an event handler or at boot) pauses the run and
// shows what went wrong, with the details ready to copy into a bug report.
let errorShown = '';
function errorDetails(err) {
  const e = err && err.stack ? err : new Error(String(err && err.message || err));
  const stack = String(e.stack || '').split('\n').slice(0, 8).join('\n');
  const where = `tick ${state.tick} · pop ${state.count} · preset ${curPreset >= 0 ? PRESET_NAMES[curPreset] : 'custom'} · speed ${ui.speed === Infinity ? 'max' : ui.speed + '×'} · colour ${ui.colorMode} · ${typeof rendererName === 'string' ? rendererName : '?'}`;
  return `${e.message}\n${stack.startsWith(e.name) ? stack.split('\n').slice(1).join('\n') : stack}\n\n${where}\n${navigator.userAgent}`;
}
function reportError(err) {
  ui.playing = false;
  try { syncPlayButtons(); } catch (e) { /* the banner matters more */ }
  const details = errorDetails(err);
  if (details === errorShown) return;   // the same error again (e.g. every frame): already showing
  errorShown = details;
  const box = $('#errorbar');
  box.querySelector('pre').textContent = details;
  box.style.display = 'block';
  console.error(err);
}
window.addEventListener('error', (e) => reportError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
$('#errorcopy').addEventListener('click', (e) => {
  const btn = e.currentTarget, text = errorShown;
  const done = () => { btn.textContent = '✓ copied'; setTimeout(() => { btn.textContent = 'copy details'; }, 1400); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy these details:', text));
  else window.prompt('Copy these details:', text);
});
$('#errorclose').addEventListener('click', () => { $('#errorbar').style.display = 'none'; });   // stays quiet for this error until a reset

// ---- first-visit guide ----------------------------------------------------
// Shown once per browser (remembered in localStorage when available); the ? button
// and key reopen it. The simulation keeps running behind it.
const welcome = $('#welcome');
const WELCOMED_KEY = 'genomia.welcomed';
function openWelcome() { hideTip(); if (!welcome.open) welcome.showModal(); }
welcome.addEventListener('close', () => { try { localStorage.setItem(WELCOMED_KEY, '1'); } catch (e) { /* private mode: show again next time */ } });
welcome.addEventListener('click', (e) => { if (e.target === welcome) welcome.close(); });   // click on the backdrop
$('#welcomego').addEventListener('click', () => welcome.close());
$('#welcomex').addEventListener('click', () => welcome.close());
$('#helpbtn').addEventListener('click', openWelcome);
$('#helpbtn').setAttribute('data-tip', 'What is this, and how do I use it? (?)');

// ---- boot -----------------------------------------------------------------
setupTips();
resize();
const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
$('#starthint').innerHTML = coarse ? 'tap <b>▶ play</b> to start' : 'press <kbd>Space</kbd> to start';
$('#cornerplay').addEventListener('click', togglePlay);
$('#cornerplay').setAttribute('data-tip', HELP.play);
$('#uitoggle').addEventListener('click', toggleUI);
$('#uitoggle').setAttribute('data-tip', 'Hide the controls and charts — just the habitat. (H)');
const fromLink = cfgPart ? applyConfig(cfgPart.slice(4)) : false;   // shared link: settings first, then seed
buildSide();
buildBottom();
// A fresh visit opens on the default scenario, running (unless the viewer prefers
// reduced motion). A shared link re-seeds its own settings; #preset=N picks another.
const presetM = devHash.match(/preset=?(\d+)/);  // #preset=1 — boot into a preset (dev/testing)
if (fromLink) applyInit();
else {
  applyPreset(presetM ? +presetM[1] - 1 : DEFAULT_PRESET);   // applyPreset starts playing
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { ui.playing = false; syncPlayButtons(); }
}
if (devHash.includes('genealogy')) ui.colorMode = 'lineage';  // #genealogy — dev/testing
if (devHash.includes('phenotype')) ui.colorMode = 'phenotype';  // #phenotype — dev/testing
if (devHash.includes('trophic')) ui.colorMode = 'trophic';    // #trophic — dev/testing
if (devHash.includes('nolines')) ui.showLines = false;        // #nolines — cheap headless screenshots
const runM = devHash.match(/run=?(\d+)/);        // #run400 — pre-step headlessly (dev/testing)
if (runM) { const k = +runM[1], hz = makeSpeciesHasher(state, P.R); for (let i = 0; i < k; i++) { step(state, P); updatePeaks(state, hz); } pushHist(computeStats(state, P)); }
// with a dev hash, playing state is explicit ('play' => run, else a paused snapshot);
// this also overrides a preset's autoplay so screenshots don't keep stepping.
if (devHash.length > 0) {
  ui.playing = devHash.includes('play');
  syncPlayButtons();
}
// dev hashes are for screenshots and testing, so they skip the guide
let welcomed = false;
try { welcomed = localStorage.getItem(WELCOMED_KEY) === '1'; } catch (e) { /* storage blocked */ }
if (!welcomed && devHash.length === 0) openWelcome();
requestAnimationFrame(frame);
