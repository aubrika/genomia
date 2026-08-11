// Glue: UI, canvas, interaction, loop, instrumentation. All simulation logic
// lives in sim.js (DOM-free); this file is the instrument panel around it.
import {
  createState, resetState, addAgent, step, computeStats, foundClade,
  geneRanges, DEFAULTS, G, GENE, GENE_NAMES,
} from './sim.js';
import { draw, phenotypeHSL, hslToRgb } from './render.js';

// ---- state ----------------------------------------------------------------
const P = Object.assign({}, DEFAULTS);
const state = createState(P.cap);
const view = { scale: 1, ox: 0, oy: 0 };
const ui = { playing: false, colorMode: 'phenotype', showLines: true, lineCap: 20000, hovered: -1 };
const init = { population: 6000, layout: 'uniform', k: 6, genomeInit: 'brush', spread: 0.03, blobN: 60, blobJitter: 26, seed: 12345 };
let selGene = GENE.step;

// default brush = a viable "aggregator" so the sandbox is alive on first play
const brush = new Float32Array(G);
function setBrush(spec) {
  brush[GENE.rScale] = spec.rScale; brush[GENE.sLo] = spec.sLo; brush[GENE.sHi] = spec.sHi;
  brush[GENE.bLo] = spec.bLo; brush[GENE.bHi] = spec.bHi; brush[GENE.fecundity] = spec.fec;
  brush[GENE.dDisp] = spec.dDisp * P.R; brush[GENE.dCV] = spec.dCV;
  brush[GENE.step] = spec.step * P.R; brush[GENE.taxis] = spec.taxis;
  brushDirty = true;
}

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
setBrush({ rScale: 1.0, sLo: 0.6, sHi: 3.0, bLo: 1.0, bHi: 2.4, fec: 0.22, dDisp: 1.3, dCV: 0.4, step: 0.10, taxis: 0.10 });

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
  rScale: 'Perception range. This cell senses neighbors out to R × rScale — bigger means it sees more of its surroundings (but sensing far costs offspring via kSense).',
  sLo: 'Survival lower bound. If local crowding drops below this, the cell dies of loneliness (the Allee effect). Raise it and isolated cells and expansion fronts die back.',
  sHi: 'Survival upper bound. If local crowding rises above this, the cell dies of overcrowding. Lower it and cells can only persist in thin, sparse structures.',
  bLo: 'Birth lower bound. The cell only reproduces when local crowding is at least this — it needs some company to breed.',
  bHi: 'Birth upper bound. The cell stops reproducing above this crowding, so the birth window is [bLo, bHi].',
  fecundity: 'Base chance per tick of emitting one offspring while inside the birth band (before metabolic cost is subtracted).',
  dDisp: 'Dispersal distance: how far, on average, offspring are placed from the parent. Short = children reinforce local structure; long = they colonise gaps.',
  dCV: 'Dispersal variability (coefficient of variation). 0 = every child lands at the same distance; higher = a wide spread of distances.',
  step: 'Motility: how far the cell random-walks each tick. Costs offspring via kMove.',
  taxis: 'Density steering. +1 = climb toward crowding (aggregate), −1 = flee crowding (disperse/repel), 0 = pure random walk. Costs offspring via kTaxis.',
  sigma: 'Band-edge softness. Birth/death thresholds are fuzzy, not hard: σ is the half-width of the smooth transition around each bound. Small σ ≈ crisp, Conway-like rules; large σ = gradual.',
  maxAgeToggle: 'When on, cells also die of old age once they pass "max age". Off by default — death is otherwise purely density-driven.',
  maxAge: 'Ticks a cell can live before dying of old age (only when max-age death is on).',
  costs: 'Metabolic cost. When ON, sensing far, moving fast, tolerating a wide density range, and steering all reduce fecundity. Turn it OFF to watch every gene run to its extreme and the board collapse into a grey monoculture — the degenerate attractor.',
  kMove: 'Cost weight on motility (step²). Higher makes fast movement more expensive in offspring.',
  kSense: 'Cost weight on perception (rScale²). Higher makes seeing far more expensive.',
  kTol: 'Cost weight on niche breadth. Higher makes tolerating a wide survival/birth range more expensive.',
  kTaxis: 'Cost weight on steering (taxis²). Higher makes deliberate movement more expensive.',
  recomb: 'How offspring inherit genes. clonal = copy one parent. crossover = mix two nearby parents gene-by-gene. blend = average two parents (this halves genetic variance every generation — included to demonstrate evolutionary collapse).',
  mutation: 'gaussian = each gene is randomly nudged with probability μ. cornered = same, but the four threshold genes (sLo, sHi, bLo, bHi) are also pulled toward the ends of their range, resisting a mushy middle where no structure survives.',
  mu: 'Mutation rate: the per-gene probability that a gene is nudged when an offspring is born.',
  sigmaG: 'Mutation size: the standard deviation of each nudge, as a fraction of that gene’s full range.',
  macroRate: 'Macromutation rate. Most mutations are small nudges; this fraction are outsized "knockouts" that re-roll a whole gene at random — a big, could-be-good-or-bad jump. Rare large jumps are what leap across the genus threshold and found new genera.',
  kappa: 'Cornered pull strength: how hard threshold genes are pushed toward their range ends (only in "cornered" mutation).',
  speciesThreshold: 'Species threshold (genetic distance, the FINE tier). When an offspring drifts this far from its species’ founding genome, it founds a new species within the same genus. Lower = species split more readily; 0 = never.',
  genusThreshold: 'Genus threshold (genetic distance, the COARSE tier). When an offspring drifts this far from its genus’ founding genome, it founds a new genus (and a new species inside it). Set it above the species threshold; genus = the larger colour family, species = the shade within it. 0 = off.',
  isolation: 'Reproductive isolation (genetic distance). With crossover, a second parent must be within this distance of the first, so diverged species stop interbreeding and can drift apart. 0 = off (mate with any neighbour).',
  color: 'phenotype = colour encodes the genome (hue = niche centre, saturation = niche breadth, lightness = motility) — similar genomes look similar. genealogy = each founder lineage gets a distinct base hue and every speciation steps the colour a little, so related species share a colour family and drift step-wise.',
  lines: 'Draw a link between cells that perceive each other. Solid = mutual perception, dashed = one-way (a real consequence of different rScale). Line opacity follows perception strength, so links fade in and out as cells drift.',
  seed: 'Random seed. The same seed plus the same parameters reproduces a run exactly.',
  play: 'Run or pause the simulation. (Space)',
  stepBtn: 'Advance exactly one tick. (.)',
  reset: 'Clear and re-seed the population using the Initialize settings below. (R)',
  population: 'How many cells to place when seeding.',
  layout: 'Spatial arrangement of the initial seed: scattered uniformly, one central blob, several blobs, a ring, or a low-variance jittered lattice (best for narrow-band genomes that would otherwise avalanche).',
  genomeInit: 'Genome of seeded cells. clone brush = one founder lineage (all share the current rules). uniform random = each cell its own random genome and its own founder. two clones A/B = two founder lineages placed apart to compete.',
  spread: 'Genetic jitter added to seeded genomes. A pure clone boom-busts in lockstep; a little spread gives selection material and smooths the opening crash.',
  applyInit: 'Clear everything and re-seed with the current Initialize settings.',
  randomize: 'Fill the brush with a random genome.',
  copyHovered: 'Copy the hovered cell’s genome into the brush.',
  blobN: 'How many cells a shift-click blob places.',
  blobJitter: 'Radius of the shift-click blob.',
  sparkPop: 'Living cell count over time.',
  sparkGene: 'Mean ± standard deviation of the selected gene across the whole population.',
  sparkVar: 'Genetic variance index — mean per-gene variance, normalised by range. The headline number: it collapses under blend inheritance and holds steady under crossover.',
  sparkSpecies: 'Number of distinct surviving species (the fine tier). Rises as genomes diverge past the species threshold and falls as species go extinct. Founder-lineage and genus counts are in the top-left readout.',
};

const PRESET_NAMES = ['Conway-ish', 'Gray goo', 'Blend collapse', 'Motile swarm', 'Allee frontier', 'Membranes', 'Species bloom'];
const PRESET_TIPS = [
  'Conway-ish — a continuous B3/S23-flavoured regime: tight bands, low motility, short dispersal. Seeded on a lattice, it crashes then blooms into a patchy, oscillator-like population.',
  'Gray goo — costs off, wide tolerance. Every gene runs to its extreme and the board saturates into a grey monoculture: the degenerate attractor. Toggle "costs" to see why cost matters.',
  'Blend collapse — blend inheritance averages parents, halving genetic variance each generation. Watch the variance-index sparkline fall off a cliff and the colours wash out.',
  'Motile swarm — high motility and positive taxis: cells steer toward crowding and self-organise into moving clumps without any birth/death tuning.',
  'Allee frontier — high loneliness threshold and short dispersal make slow, pushed expansion fronts and strong clade structure (switch to genealogy colouring to see the founder clumps).',
  'Membranes (experimental) — cells aggregate, but a low overcrowding cap thins the crowded interior, and a HIGH niche-breadth cost (kTol) stops that cap from evolving upward — so clumps stay loose and partly hollow instead of filling in over time. A best-guess at emergent “cell membranes”; true hollow rings are hard here because density and crowding-tolerance are coupled.',
  'Species bloom — one founder lineage in a fast, mutating regime with a low species threshold, so genomes keep diverging past it and the species count climbs from 1. Switch to genealogy colouring to watch the palette fracture into a family tree.',
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
    withTip(el('div', { class: 'row' }, [el('label', { class: 'k' }, ['seed']), (() => {
      const inp = el('input', { type: 'text' }); inp.value = init.seed;
      inp.addEventListener('change', () => { init.seed = parseInt(inp.value, 10) || 0; });
      return inp;
    })()]), HELP.seed),
  ]));

  // Presets
  side.append(section('Presets', [
    el('div', { class: 'grid7' }, PRESET_NAMES.map((n, i) => button(String(i + 1), () => applyPreset(i), '', PRESET_TIPS[i]))),
    el('p', { class: 'hint' }, ['1 Conway · 2 Gray goo · 3 Blend · 4 Swarm · 5 Allee · 6 Membranes · 7 Species bloom — hover for details']),
  ]));

  // Rules
  const ageBtn = button('max-age death', () => { P.maxAgeOn = !P.maxAgeOn; ageBtn.classList.toggle('on', P.maxAgeOn); }, P.maxAgeOn ? 'on' : '', HELP.maxAgeToggle);
  side.append(section('Rules', [
    slider('softness σ', 0, 2, 0.05, () => P.sigma, (v) => P.sigma = v, f2, HELP.sigma),
    el('div', { class: 'row' }, [ageBtn]),
    slider('max age', 50, 2000, 10, () => P.maxAge, (v) => P.maxAge = v, (v) => v.toFixed(0), HELP.maxAge),
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
    slider('kTaxis', 0, 2, 0.05, () => P.kTaxis, (v) => P.kTaxis = v, f2, HELP.kTaxis),
  ], 'live'));

  // Inheritance
  side.append(section('Inheritance', [
    ctrlSelect('recomb', [['clonal', 'clonal'], ['crossover', 'crossover'], ['blend', 'blend']], P.recomb, (v) => P.recomb = v, HELP.recomb),
    ctrlSelect('mutation', [['gaussian', 'gaussian'], ['cornered', 'cornered']], P.mutation, (v) => P.mutation = v, HELP.mutation),
    slider('rate μ', 0, 0.5, 0.01, () => P.mu, (v) => P.mu = v, f2, HELP.mu),
    slider('σ_g', 0, 0.3, 0.005, () => P.sigmaG, (v) => P.sigmaG = v, (v) => v.toFixed(3), HELP.sigmaG),
    slider('macro', 0, 0.5, 0.01, () => P.macroRate, (v) => P.macroRate = v, (v) => v.toFixed(2), HELP.macroRate),
    slider('corner κ', 0, 0.5, 0.01, () => P.kappa, (v) => P.kappa = v, f2, HELP.kappa),
    slider('genus Δ', 0, 0.6, 0.005, () => P.genusThreshold, (v) => P.genusThreshold = v, (v) => v.toFixed(3), HELP.genusThreshold),
    slider('species Δ', 0, 0.4, 0.005, () => P.speciesThreshold, (v) => P.speciesThreshold = v, (v) => v.toFixed(3), HELP.speciesThreshold),
    slider('isolation', 0, 0.4, 0.005, () => P.isolation, (v) => P.isolation = v, (v) => v.toFixed(3), HELP.isolation),
  ], 'live'));

  // Rendering
  const linesBtn = button(ui.showLines ? 'lines ON' : 'lines OFF', () => {
    ui.showLines = !ui.showLines; linesBtn.textContent = ui.showLines ? 'lines ON' : 'lines OFF'; linesBtn.classList.toggle('on', ui.showLines);
  }, ui.showLines ? 'on' : '', HELP.lines);
  side.append(section('Rendering', [
    ctrlSelect('color', [['phenotype', 'phenotype'], ['lineage', 'genealogy']], ui.colorMode, (v) => ui.colorMode = v, HELP.color),
    el('div', { class: 'row' }, [linesBtn]),
  ], 'view'));

  // Brush genome
  const rr = geneR();
  const geneRows = GENE_NAMES.map((name, g) => slider(
    name, rr[g][0], rr[g][1], (rr[g][1] - rr[g][0]) / 200,
    () => brush[g], (v) => { brush[g] = v; markBrushDirty(); },
    g === GENE.fecundity ? ((v) => v.toFixed(3)) : f2, HELP[name],
  ));
  side.append(section('Brush genome', [
    ...geneRows,
    el('div', { class: 'grid2' }, [button('randomize', randomizeBrush, '', HELP.randomize), button('copy hovered', copyHovered, '', HELP.copyHovered)]),
    el('p', { class: 'hint' }, ['click place · drag paint · shift-click blob · alt-drag erase · hover reads genome']),
  ], 'neu'));

  // Initialize
  side.append(section('Initialize', [
    slider('population', 100, P.cap, 100, () => init.population, (v) => init.population = v, (v) => v.toFixed(0), HELP.population),
    ctrlSelect('layout', [['uniform', 'uniform'], ['blob', 'central blob'], ['kblobs', 'k blobs'], ['ring', 'ring'], ['lattice', 'jittered lattice']], init.layout, (v) => init.layout = v, HELP.layout),
    ctrlSelect('genome', [['brush', 'clone brush'], ['uniform', 'uniform random'], ['twoclone', 'two clones A/B']], init.genomeInit, (v) => init.genomeInit = v, HELP.genomeInit),
    slider('spread', 0, 0.15, 0.005, () => init.spread, (v) => init.spread = v, (v) => v.toFixed(3), HELP.spread),
    button('apply init', applyInit, '', HELP.applyInit),
  ], 'reset'));

  side.append(section('Blob brush', [
    slider('N', 2, 400, 1, () => init.blobN, (v) => init.blobN = v, (v) => v.toFixed(0), HELP.blobN),
    slider('jitter', 2, 120, 1, () => init.blobJitter, (v) => init.blobJitter = v, (v) => v.toFixed(0), HELP.blobJitter),
  ], 'neu'));
}

// ---- bottom sparklines ----------------------------------------------------
const hist = { pop: [], vi: [], lin: [], gm: [], gs: [] };
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
  const dd = select(GENE_NAMES.map((n, i) => [String(i), n]), String(selGene), (v) => { selGene = parseInt(v, 10); });
  makeSpark('gene', 'gene', false, HELP.sparkGene, dd);
  makeSpark('vi', 'variance index', true, HELP.sparkVar);
  makeSpark('lin', 'species', false, HELP.sparkSpecies);
}
function pushHist(s) {
  hist.pop.push(s.population); hist.vi.push(s.varianceIndex); hist.lin.push(s.species);
  hist.gm.push(s.mean[selGene]); hist.gs.push(s.sd[selGene]);
  for (const k in hist) if (hist[k].length > HMAX) hist[k].shift();
}
function drawSeries(cvs, data, color, lo, hi, band) {
  const dpr = 1; const w = cvs.clientWidth, h = cvs.clientHeight;
  if (cvs.width !== w) cvs.width = w; if (cvs.height !== h) cvs.height = h;
  const ctx = cvs.getContext('2d'); ctx.clearRect(0, 0, w, h);
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
function drawSparks(s) {
  const amax = (a, m) => Math.max(m, ...a);
  drawSeries(sparkCanvases.pop, hist.pop, '#D6CFC6', 0, Math.max(amax(hist.pop, 10) * 1.1, P.cap * 0.1));
  const rr = geneR();
  drawSeries(sparkCanvases.gene, hist.gm, '#D6CFC6', rr[selGene][0], rr[selGene][1], hist.gs);
  drawSeries(sparkCanvases.vi, hist.vi, '#C9873A', 0, Math.max(amax(hist.vi, 0.005) * 1.1, 0.01));
  drawSeries(sparkCanvases.lin, hist.lin, '#D6CFC6', 0, amax(hist.lin, 10) * 1.1);
  $('#popv').textContent = s.population;
  $('#genev').textContent = f2(s.mean[selGene]) + ' ±' + f2(s.sd[selGene]);
  $('#viv').textContent = s.varianceIndex.toFixed(4);
  $('#linv').textContent = s.species;
}

// ---- init / presets -------------------------------------------------------
function applyInit() {
  resetState(state, init.seed | 0);
  const rr = geneR(), Wx = P.worldW, Wy = P.worldH, Dm = Math.min(Wx, Wy), n = init.population, rng = state.rng;
  const wx_ = (v) => ((v % Wx) + Wx) % Wx, wy_ = (v) => ((v % Wy) + Wy) % Wy;
  const place = (x, y, g, lin, sp) => addAgent(state, wx_(x), wy_(y), g, lin, rr, sp);
  brushDirty = true; curSpecies = -1;   // a fresh run; interactive placement founds anew

  // small per-gene jitter around a template — a monoclonal seed boom-busts in
  // lockstep, so a touch of variation gives selection something to act on.
  const jitter = (g) => { const sp = init.spread; if (sp > 0) for (let j = 0; j < G; j++) g[j] += rng.gauss() * sp * (rr[j][1] - rr[j][0]); return g; };

  if (init.genomeInit === 'twoclone') {
    // two founder lineages A and B, each its own species, placed apart to compete
    const A = new Float32Array(brush), B = new Float32Array(brush);
    B[GENE.sLo] += 1.6; B[GENE.sHi] += 1.6; B[GENE.bLo] += 1.6; B[GENE.bHi] += 1.6;
    B[GENE.step] = Math.min(rr[GENE.step][1], B[GENE.step] * 1.8);
    const linA = state.nextLineage++, spA = foundClade(state, A, 0, linA);
    const linB = state.nextLineage++, spB = foundClade(state, B, 0, linB);
    curLineage = linA; curSpecies = spA; brushDirty = false;
    const half = n >> 1, jr = Dm * 0.12;
    for (let i = 0; i < n; i++) {
      const isA = i < half, ang = rng.next() * 6.283185307179586, rad = Math.abs(rng.gauss()) * jr;
      place((isA ? 0.3 : 0.7) * Wx + Math.cos(ang) * rad, 0.5 * Wy + Math.sin(ang) * rad,
        jitter(new Float32Array(isA ? A : B)), isA ? linA : linB, isA ? spA : spB);
    }
  } else {
    const centers = [];
    if (init.layout === 'kblobs') for (let i = 0; i < init.k; i++) centers.push([rng.next() * Wx, rng.next() * Wy]);
    const isUniform = init.genomeInit === 'uniform';
    // 'clone brush' seeds ONE founder lineage/species (same rules => one lineage);
    // 'uniform random' gives each cell its own founder (all different rules).
    let lin = null, sp = null;
    if (!isUniform) { lin = state.nextLineage++; sp = foundClade(state, brush, 0, lin); curLineage = lin; curSpecies = sp; brushDirty = false; }
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
        for (let gx = a / 2; gx < Wx && placed < n; gx += a) { place(gx + rng.gauss() * jit, gy + rng.gauss() * jit, genomeOf(), lin, sp); placed++; }
    } else {
      for (let i = 0; i < n; i++) {
        let x, y;
        if (init.layout === 'uniform') { x = rng.next() * Wx; y = rng.next() * Wy; }
        else if (init.layout === 'blob') { x = Wx / 2 + rng.gauss() * Dm * 0.14; y = Wy / 2 + rng.gauss() * Dm * 0.14; }
        else if (init.layout === 'kblobs') { const c = centers[(rng.next() * centers.length) | 0]; x = c[0] + rng.gauss() * Dm * 0.05; y = c[1] + rng.gauss() * Dm * 0.05; }
        else { const a = rng.next() * 6.283185307179586; x = Wx / 2 + Math.cos(a) * Dm * 0.38; y = Wy / 2 + Math.sin(a) * Dm * 0.38; }
        place(x, y, genomeOf(), lin, sp);
      }
    }
  }
  for (const k in hist) hist[k].length = 0;
  pushHist(computeStats(state, P));
}

const PRESETS = [
  { // Conway-ish — a continuous B3/S23-flavored regime: tight low-motility bands,
    // short dispersal so births reinforce local structure. A full field avalanches
    // (soft death at the density lower-edge cascades) then blooms back from a
    // lattice seed into a patchy, oscillator-like population.
    brush: { rScale: 1.0, sLo: 1.4, sHi: 3.6, bLo: 2.0, bHi: 3.4, fec: 0.24, dDisp: 0.6, dCV: 0.3, step: 0.05, taxis: 0.15 },
    P: { costsOn: true, recomb: 'crossover', mutation: 'gaussian', sigma: 0.4 },
    init: { layout: 'lattice', genomeInit: 'brush', population: 11000, spread: 0.03 },
  },
  { // Gray goo
    brush: { rScale: 1.2, sLo: 0.0, sHi: 12, bLo: 0.0, bHi: 12, fec: 0.30, dDisp: 1.0, dCV: 0.3, step: 0.10, taxis: 0.0 },
    P: { costsOn: false, recomb: 'crossover', mutation: 'gaussian' },
    init: { layout: 'uniform', genomeInit: 'uniform', population: 6000 },
  },
  { // Blend collapse
    brush: { rScale: 1.0, sLo: 1.5, sHi: 7.0, bLo: 2.5, bHi: 7.0, fec: 0.22, dDisp: 0.8, dCV: 0.3, step: 0.15, taxis: 0.6 },
    P: { costsOn: true, recomb: 'blend', mutation: 'gaussian' },
    init: { layout: 'kblobs', genomeInit: 'brush', population: 7000 },
  },
  { // Motile swarm
    brush: { rScale: 1.0, sLo: 1.0, sHi: 8.0, bLo: 2.0, bHi: 8.0, fec: 0.20, dDisp: 0.7, dCV: 0.3, step: 0.22, taxis: 0.7 },
    P: { costsOn: true, recomb: 'crossover', mutation: 'gaussian' },
    init: { layout: 'uniform', genomeInit: 'brush', population: 6000 },
  },
  { // Allee frontier
    brush: { rScale: 1.0, sLo: 3.5, sHi: 8.0, bLo: 3.2, bHi: 8.0, fec: 0.20, dDisp: 0.45, dCV: 0.25, step: 0.05, taxis: 0.2 },
    P: { costsOn: true, recomb: 'crossover', mutation: 'gaussian' },
    init: { layout: 'blob', genomeInit: 'brush', population: 8000 },
  },
    { // Membranes (experimental) — aggregate (positive taxis, short dispersal), but a
    // low overcrowding cap (sHi) kills the crowded interior, leaving a thin shell
    // around a void. Crucially, a HIGH kTol penalises widening the survival band, so
    // sHi can't evolve upward and re-fill the centres — the hollows persist over time.
    brush: { rScale: 1.0, sLo: 0.6, sHi: 2.6, bLo: 0.9, bHi: 2.2, fec: 0.24, dDisp: 0.6, dCV: 0.3, step: 0.05, taxis: 0.8 },
    P: { costsOn: true, recomb: 'crossover', mutation: 'gaussian', sigma: 0.4, macroRate: 0.02, kTol: 1.0 },
    init: { layout: 'uniform', genomeInit: 'brush', population: 6000, spread: 0.03 },
  },
  { // Species bloom — one founder lineage (clone brush) in a fast, mutating regime
    // with a low species threshold, so genomes keep diverging past it and the
    // species count climbs from 1 (a family tree unfurling under genealogy colour).
    brush: { rScale: 1.0, sLo: 0.6, sHi: 4.0, bLo: 1.0, bHi: 2.6, fec: 0.24, dDisp: 1.3, dCV: 0.4, step: 0.10, taxis: 0.10 },
    P: { costsOn: true, recomb: 'crossover', mutation: 'gaussian', mu: 0.25, sigmaG: 0.07, macroRate: 0.08, speciesThreshold: 0.09, genusThreshold: 0.34 },
    init: { layout: 'uniform', genomeInit: 'brush', population: 4000, spread: 0.02 },
  },
];
function applyPreset(i) {
  const pr = PRESETS[i];
  Object.assign(P, {
    sigma: DEFAULTS.sigma, genusThreshold: DEFAULTS.genusThreshold, speciesThreshold: DEFAULTS.speciesThreshold,
    isolation: DEFAULTS.isolation, mu: DEFAULTS.mu, sigmaG: DEFAULTS.sigmaG, macroRate: DEFAULTS.macroRate,
    kMove: DEFAULTS.kMove, kSense: DEFAULTS.kSense, kTol: DEFAULTS.kTol, kTaxis: DEFAULTS.kTaxis,
  }, pr.P);  // reset varied params to defaults unless the preset sets them
  setBrush(pr.brush);
  Object.assign(init, pr.init);
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
const ctx = canvas.getContext('2d', { alpha: false });
// The world IS the window: a rectangular torus the size of the canvas, drawn 1:1
// (scale 1, no letterbox), with the UI floating over it. Perception radius R
// scales with √area, so density depends only on population (window-independent) —
// every preset stays calibrated at any window size. A resize just "zooms" the
// running ecosystem: positions, R, and the R-relative genes (dDisp, step) all
// scale together, so the dynamics are preserved.
const R_FROM_AREA = (area) => Math.max(8, Math.min(40, 0.017 * Math.sqrt(area)));
function resize() {
  const rect = $('#stage').getBoundingClientRect();
  const oldW = P.worldW, oldH = P.worldH, oldR = P.R;
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));
  P.worldW = canvas.width; P.worldH = canvas.height;
  view.scale = 1; view.ox = 0; view.oy = 0;
  const newR = R_FROM_AREA(P.worldW * P.worldH), s = newR / oldR;
  if (oldW) {
    const sx = P.worldW / oldW, sy = P.worldH / oldH;
    for (let i = 0; i < state.count; i++) {
      state.x[i] *= sx; state.y[i] *= sy;
      state.genome[i * G + GENE.dDisp] *= s; state.genome[i * G + GENE.step] *= s;
    }
  }
  brush[GENE.dDisp] *= s; brush[GENE.step] *= s;   // keep the brush R-relative too
  P.R = newR; P._rangesR = -1;                      // force sim to recompute gene ranges
  if (oldW) buildSide();
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
      state.x[i] = state.x[last]; state.y[i] = state.y[last]; state.age[i] = state.age[last]; state.lineage[i] = state.lineage[last];
      const a = i * G, b = last * G; for (let g = 0; g < G; g++) state.genome[a + g] = state.genome[b + g];
    } else i++;
  }
}
function paintOne(x, y) {
  const f = brushFounder();
  addAgent(state, x, y, new Float32Array(brush), f.lineage, geneR(), f.species);
}
function placeBlob(wx, wy) {
  const rr = geneR(), Wx = P.worldW, Wy = P.worldH, rng = state.rng, f = brushFounder();
  const wx_ = (v) => ((v % Wx) + Wx) % Wx, wy_ = (v) => ((v % Wy) + Wy) % Wy;
  for (let i = 0; i < init.blobN; i++) {
    const ang = rng.next() * 6.283185307179586, rad = Math.abs(rng.gauss()) * init.blobJitter;
    addAgent(state, wx_(wx + Math.cos(ang) * rad), wy_(wy + Math.sin(ang) * rad), new Float32Array(brush), f.lineage, rr, f.species);
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
  const rows = GENE_NAMES.map((n, g) => `<span class="k">${n}</span> ${g === GENE.fecundity ? state.genome[base + g].toFixed(3) : f2(state.genome[base + g])}`);
  tip.innerHTML = `<b>#${ui.hovered}</b> · lin ${state.lineage[ui.hovered]} · age ${state.age[ui.hovered] | 0}<br>` + rows.join('<br>');
  tip.style.display = 'block';
  const r = canvas.getBoundingClientRect();
  let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
  if (x > canvas.width - 220) x -= 234; if (y > canvas.height - 190) y -= 200;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

// ---- loop -----------------------------------------------------------------
function togglePlay() {
  ui.playing = !ui.playing;
  const b = $('#playbtn'); if (b) b.textContent = ui.playing ? '❚❚ pause' : '▶ play';
}
function singleStep() { step(state, P); pushHist(computeStats(state, P)); }

let fpsT = 0, fpsN = 0, fps = 0;
function frame(t) {
  if (ui.playing) step(state, P);
  draw(ctx, state, P, view, ui);
  const s = computeStats(state, P);
  if (ui.playing) pushHist(s);
  drawSparks(s);
  fpsN++; if (t - fpsT > 500) { fps = Math.round(fpsN * 1000 / (t - fpsT)); fpsN = 0; fpsT = t; }
  $('#hud').innerHTML = `tick <b>${state.tick}</b> · pop <b>${state.count}</b> · lineages <b>${s.lineages}</b> · genera <b>${s.genera}</b> · ${fps} fps${ui.playing ? '' : ' · <b>paused</b>'}`;
  requestAnimationFrame(frame);
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === '.') { e.preventDefault(); singleStep(); }
  else if (e.key === 'r' || e.key === 'R') applyInit();
});

// ---- help tooltips --------------------------------------------------------
// One floating element follows the cursor and shows the data-tip of whatever
// control is under it — read live, so rebuilding the panel needs no re-wiring.
function setupTips() {
  const tip = el('div'); tip.id = 'uitip'; document.body.appendChild(tip);
  let cur = null;
  const place = (e) => {
    let x = e.clientX + 18, y = e.clientY + 20;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
  };
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (t) {
      const txt = t.getAttribute('data-tip');
      if (txt !== cur) { cur = txt; tip.textContent = txt; tip.style.display = 'block'; }
      place(e);
    } else if (cur !== null) { cur = null; tip.style.display = 'none'; }
  });
}

// ---- boot -----------------------------------------------------------------
setupTips();
resize();
buildSide();
buildBottom();
const presetM = location.hash.match(/preset=?(\d)/);  // #preset=1 — boot into a preset (dev/testing)
if (presetM) applyPreset(+presetM[1] - 1); else applyInit();
if (location.hash.includes('genealogy')) ui.colorMode = 'lineage';  // #genealogy — dev/testing
// prefers-reduced-motion => stay paused (default); otherwise also default paused per spec
const runM = location.hash.match(/run=?(\d+)/);        // #run400 — pre-step headlessly (dev/testing)
if (runM) { const k = +runM[1]; for (let i = 0; i < k; i++) step(state, P); pushHist(computeStats(state, P)); }
// with a hash, playing state is explicit ('play' => run, else a paused snapshot);
// this also overrides a preset's autoplay so screenshots don't keep stepping.
if (location.hash.length > 1) {
  ui.playing = location.hash.includes('play');
  const pb = $('#playbtn'); if (pb) pb.textContent = ui.playing ? '❚❚ pause' : '▶ play';
}
requestAnimationFrame(frame);
