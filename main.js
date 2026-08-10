// Glue: UI, canvas, interaction, loop, instrumentation. All simulation logic
// lives in sim.js (DOM-free); this file is the instrument panel around it.
import {
  createState, resetState, addAgent, step, computeStats,
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
function button(label, onclick, cls) { const b = el('button', cls ? { class: cls } : null, [label]); b.addEventListener('click', onclick); return b; }
function select(options, value, onchange) {
  const s = el('select');
  for (const [v, label] of options) { const o = el('option', { value: v }, [label]); if (v === value) o.selected = true; s.append(o); }
  s.addEventListener('change', () => onchange(s.value));
  return s;
}
function slider(label, min, max, stp, get, set, fmt) {
  const inp = el('input', { type: 'range', min, max, step: stp });
  inp.value = get();
  const out = el('output', {}, [fmt(get())]);
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); set(v); out.textContent = fmt(v); });
  return el('div', { class: 'ctrl' }, [el('label', {}, [label]), inp, out]);
}
const f2 = (v) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

// ---- side panel -----------------------------------------------------------
function section(title, kids) { return el('section', {}, [el('h2', {}, [title]), ...kids]); }

function buildSide() {
  const side = $('#side');
  side.textContent = '';

  // Simulation
  const playBtn = button(ui.playing ? '❚❚ pause' : '▶ play', togglePlay);
  playBtn.id = 'playbtn';
  side.append(section('Simulation', [
    el('div', { class: 'seg' }, [playBtn, button('▷ step', () => singleStep()), button('⟲ reset', () => applyInit())]),
    el('div', { class: 'row' }, [el('label', { class: 'k' }, ['seed']), (() => {
      const inp = el('input', { type: 'text' }); inp.value = init.seed;
      inp.addEventListener('change', () => { init.seed = parseInt(inp.value, 10) || 0; });
      return inp;
    })()]),
  ]));

  // Presets
  const names = ['Conway-ish', 'Gray goo', 'Blend collapse', 'Motile swarm', 'Allee frontier'];
  side.append(section('Presets', [
    el('div', { class: 'grid5' }, names.map((n, i) => button(String(i + 1), () => applyPreset(i)))),
    el('p', { class: 'hint' }, ['1 Conway · 2 Gray goo · 3 Blend · 4 Swarm · 5 Allee']),
  ]));

  // Rules
  side.append(section('Rules', [
    slider('softness σ', 0, 2, 0.05, () => P.sigma, (v) => P.sigma = v, f2),
    el('div', { class: 'row' }, [(() => {
      const b = button('max-age death', () => { P.maxAgeOn = !P.maxAgeOn; b.classList.toggle('on', P.maxAgeOn); }, P.maxAgeOn ? 'on' : '');
      return b;
    })()]),
    slider('max age', 50, 2000, 10, () => P.maxAge, (v) => P.maxAge = v, (v) => v.toFixed(0)),
  ]));

  // Costs
  const costToggle = button(P.costsOn ? 'costs ON' : 'costs OFF', () => {
    P.costsOn = !P.costsOn; costToggle.textContent = P.costsOn ? 'costs ON' : 'costs OFF'; costToggle.classList.toggle('on', P.costsOn);
  }, P.costsOn ? 'on' : '');
  side.append(section('Metabolic cost', [
    el('div', { class: 'row' }, [costToggle]),
    slider('kMove', 0, 2, 0.05, () => P.kMove, (v) => P.kMove = v, f2),
    slider('kSense', 0, 2, 0.05, () => P.kSense, (v) => P.kSense = v, f2),
    slider('kTol', 0, 2, 0.05, () => P.kTol, (v) => P.kTol = v, f2),
    slider('kTaxis', 0, 2, 0.05, () => P.kTaxis, (v) => P.kTaxis = v, f2),
  ]));

  // Inheritance
  side.append(section('Inheritance', [
    el('div', { class: 'ctrl' }, [el('label', {}, ['recomb']), select([['clonal', 'clonal'], ['crossover', 'crossover'], ['blend', 'blend']], P.recomb, (v) => P.recomb = v), el('span')]),
    el('div', { class: 'ctrl' }, [el('label', {}, ['mutation']), select([['gaussian', 'gaussian'], ['cornered', 'cornered']], P.mutation, (v) => P.mutation = v), el('span')]),
    slider('rate μ', 0, 0.5, 0.01, () => P.mu, (v) => P.mu = v, f2),
    slider('σ_g', 0, 0.3, 0.005, () => P.sigmaG, (v) => P.sigmaG = v, (v) => v.toFixed(3)),
    slider('corner κ', 0, 0.5, 0.01, () => P.kappa, (v) => P.kappa = v, f2),
  ]));

  // Rendering
  const linesBtn = button(ui.showLines ? 'lines ON' : 'lines OFF', () => {
    ui.showLines = !ui.showLines; linesBtn.textContent = ui.showLines ? 'lines ON' : 'lines OFF'; linesBtn.classList.toggle('on', ui.showLines);
  }, ui.showLines ? 'on' : '');
  side.append(section('Rendering', [
    el('div', { class: 'ctrl' }, [el('label', {}, ['color']), select([['phenotype', 'phenotype'], ['lineage', 'lineage']], ui.colorMode, (v) => ui.colorMode = v), el('span')]),
    el('div', { class: 'row' }, [linesBtn]),
  ]));

  // Brush genome
  const rr = geneR();
  const geneRows = GENE_NAMES.map((name, g) => slider(
    name, rr[g][0], rr[g][1], (rr[g][1] - rr[g][0]) / 200,
    () => brush[g], (v) => brush[g] = v,
    g === GENE.fecundity ? ((v) => v.toFixed(3)) : f2,
  ));
  side.append(section('Brush genome', [
    ...geneRows,
    el('div', { class: 'grid2' }, [button('randomize', randomizeBrush), button('copy hovered', copyHovered)]),
    el('p', { class: 'hint' }, ['click place · drag paint · shift-click blob · alt-drag erase · hover reads genome']),
  ]));

  // Initialize
  side.append(section('Initialize', [
    slider('population', 100, P.cap, 100, () => init.population, (v) => init.population = v, (v) => v.toFixed(0)),
    el('div', { class: 'ctrl' }, [el('label', {}, ['layout']), select([['uniform', 'uniform'], ['blob', 'central blob'], ['kblobs', 'k blobs'], ['ring', 'ring']], init.layout, (v) => init.layout = v), el('span')]),
    el('div', { class: 'ctrl' }, [el('label', {}, ['genome']), select([['brush', 'clone brush'], ['uniform', 'uniform random'], ['twoclone', 'two clones A/B']], init.genomeInit, (v) => init.genomeInit = v), el('span')]),
    slider('spread', 0, 0.15, 0.005, () => init.spread, (v) => init.spread = v, (v) => v.toFixed(3)),
    button('apply init', applyInit),
  ]));

  side.append(section('Blob brush', [
    slider('N', 2, 400, 1, () => init.blobN, (v) => init.blobN = v, (v) => v.toFixed(0)),
    slider('jitter', 2, 120, 1, () => init.blobJitter, (v) => init.blobJitter = v, (v) => v.toFixed(0)),
  ]));
}

// ---- bottom sparklines ----------------------------------------------------
const hist = { pop: [], vi: [], lin: [], gm: [], gs: [] };
const HMAX = 320;
let sparkCanvases = {};
function buildBottom() {
  const bar = $('#bottom'); bar.textContent = '';
  function makeSpark(id, label, headline, extraLabelNode) {
    const box = el('div', { class: 'spark' + (headline ? ' headline' : '') });
    const lbl = el('div', { class: 'lbl' }, []);
    lbl.append(extraLabelNode || el('span', {}, [label]));
    const val = el('span', { class: 'val' }); val.id = id + 'v';
    lbl.append(val);
    const cvs = el('canvas'); cvs.id = id + 'c';
    box.append(lbl, cvs);
    bar.append(box);
    sparkCanvases[id] = cvs;
  }
  makeSpark('pop', 'population', false);
  const dd = select(GENE_NAMES.map((n, i) => [String(i), n]), String(selGene), (v) => { selGene = parseInt(v, 10); });
  makeSpark('gene', 'gene', false, dd);
  makeSpark('vi', 'variance index', true);
  makeSpark('lin', 'lineages', false);
}
function pushHist(s) {
  hist.pop.push(s.population); hist.vi.push(s.varianceIndex); hist.lin.push(s.lineages);
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
  $('#linv').textContent = s.lineages;
}

// ---- init / presets -------------------------------------------------------
function applyInit() {
  resetState(state, init.seed | 0);
  const rr = geneR(), W = P.world, n = init.population, rng = state.rng;
  const wrapc = (v) => ((v % W) + W) % W;
  const place = (x, y, g, lin) => addAgent(state, wrapc(x), wrapc(y), g, lin, rr);

  // small per-gene jitter around a template — a monoclonal seed boom-busts in
  // lockstep, so a touch of variation gives selection something to act on.
  const jitter = (g) => { const sp = init.spread; if (sp > 0) for (let j = 0; j < G; j++) g[j] += rng.gauss() * sp * (rr[j][1] - rr[j][0]); return g; };

  if (init.genomeInit === 'twoclone') {
    const A = new Float32Array(brush), B = new Float32Array(brush);
    B[GENE.sLo] += 1.6; B[GENE.sHi] += 1.6; B[GENE.bLo] += 1.6; B[GENE.bHi] += 1.6;
    B[GENE.step] = Math.min(rr[GENE.step][1], B[GENE.step] * 1.8);
    const half = n >> 1, jr = W * 0.10;
    for (let i = 0; i < n; i++) {
      const isA = i < half, ang = rng.next() * 6.283185307179586, rad = Math.abs(rng.gauss()) * jr;
      place((isA ? 0.3 : 0.7) * W + Math.cos(ang) * rad, 0.5 * W + Math.sin(ang) * rad, jitter(new Float32Array(isA ? A : B)), isA ? 1 : 2);
    }
  } else {
    const centers = [];
    if (init.layout === 'kblobs') for (let i = 0; i < init.k; i++) centers.push([rng.next() * W, rng.next() * W]);
    const genomeOf = () => {
      if (init.genomeInit === 'uniform') { const g = new Float32Array(G); for (let j = 0; j < G; j++) g[j] = rng.range(rr[j][0], rr[j][1]); return g; }
      return jitter(new Float32Array(brush));
    };
    for (let i = 0; i < n; i++) {
      let x, y;
      if (init.layout === 'uniform') { x = rng.next() * W; y = rng.next() * W; }
      else if (init.layout === 'blob') { x = W / 2 + rng.gauss() * W * 0.12; y = W / 2 + rng.gauss() * W * 0.12; }
      else if (init.layout === 'kblobs') { const c = centers[(rng.next() * centers.length) | 0]; x = c[0] + rng.gauss() * W * 0.05; y = c[1] + rng.gauss() * W * 0.05; }
      else { const a = rng.next() * 6.283185307179586; x = W / 2 + Math.cos(a) * W * 0.35; y = W / 2 + Math.sin(a) * W * 0.35; }
      place(x, y, genomeOf(), null);
    }
  }
  for (const k in hist) hist[k].length = 0;
  pushHist(computeStats(state, P));
}

const PRESETS = [
  { // Conway-ish
    brush: { rScale: 1.0, sLo: 2.0, sHi: 3.3, bLo: 2.7, bHi: 3.3, fec: 0.15, dDisp: 1.2, dCV: 0.3, step: 0.05, taxis: 0.0 },
    P: { costsOn: true, recomb: 'crossover', mutation: 'gaussian' },
    init: { layout: 'blob', genomeInit: 'brush', population: 8000 },
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
];
function applyPreset(i) {
  const pr = PRESETS[i];
  Object.assign(P, pr.P);
  setBrush(pr.brush);
  Object.assign(init, pr.init);
  buildSide();
  applyInit();
  if (!ui.playing) togglePlay();
}

function randomizeBrush() {
  const rr = geneR(), rng = state.rng;
  for (let g = 0; g < G; g++) brush[g] = rng.range(rr[g][0], rr[g][1]);
  buildSide();
}
function copyHovered() {
  if (ui.hovered < 0 || ui.hovered >= state.count) return;
  const base = ui.hovered * G;
  for (let g = 0; g < G; g++) brush[g] = state.genome[base + g];
  buildSide();
}

// ---- canvas / view --------------------------------------------------------
const canvas = $('#canvas');
const ctx = canvas.getContext('2d', { alpha: false });
function resize() {
  const rect = $('#stage').getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));
  const scale = Math.min(canvas.width, canvas.height) / P.world;
  view.scale = scale;
  view.ox = (canvas.width - P.world * scale) / 2;
  view.oy = (canvas.height - P.world * scale) / 2;
}
window.addEventListener('resize', resize);

function worldFromEvent(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale };
}
function pickAgent(wx, wy) {
  const W = P.world, halfW = W / 2, thr = 8 / view.scale; let bd = thr * thr, best = -1;
  for (let i = 0; i < state.count; i++) {
    let dx = state.x[i] - wx, dy = state.y[i] - wy;
    if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
    if (dy > halfW) dy -= W; else if (dy < -halfW) dy += W;
    const d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = i; }
  }
  return best;
}
function eraseAt(wx, wy) {
  const W = P.world, halfW = W / 2, r = 18 / view.scale, r2 = r * r;
  for (let i = 0; i < state.count;) {
    let dx = state.x[i] - wx, dy = state.y[i] - wy;
    if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
    if (dy > halfW) dy -= W; else if (dy < -halfW) dy += W;
    if (dx * dx + dy * dy < r2) {
      const last = --state.count;
      state.x[i] = state.x[last]; state.y[i] = state.y[last]; state.age[i] = state.age[last]; state.lineage[i] = state.lineage[last];
      const a = i * G, b = last * G; for (let g = 0; g < G; g++) state.genome[a + g] = state.genome[b + g];
    } else i++;
  }
}
function placeBlob(wx, wy) {
  const rr = geneR(), W = P.world, rng = state.rng, wrapc = (v) => ((v % W) + W) % W;
  for (let i = 0; i < init.blobN; i++) {
    const ang = rng.next() * 6.283185307179586, rad = Math.abs(rng.gauss()) * init.blobJitter;
    addAgent(state, wrapc(wx + Math.cos(ang) * rad), wrapc(wy + Math.sin(ang) * rad), new Float32Array(brush), null, rr);
  }
}

// ---- interaction ----------------------------------------------------------
let dragMode = null, lastPaint = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const w = worldFromEvent(e);
  if (e.altKey) { dragMode = 'erase'; eraseAt(w.x, w.y); }
  else if (e.shiftKey) { dragMode = 'blob'; placeBlob(w.x, w.y); }
  else { dragMode = 'paint'; addAgent(state, w.x, w.y, new Float32Array(brush), null, geneR()); lastPaint = w; }
});
canvas.addEventListener('pointermove', (e) => {
  const w = worldFromEvent(e);
  if (dragMode === 'erase') eraseAt(w.x, w.y);
  else if (dragMode === 'paint') {
    const dx = w.x - lastPaint.x, dy = w.y - lastPaint.y;
    if (dx * dx + dy * dy > (7 / view.scale) ** 2) { addAgent(state, w.x, w.y, new Float32Array(brush), null, geneR()); lastPaint = w; }
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
  $('#hud').innerHTML = `tick <b>${state.tick}</b> · pop <b>${state.count}</b> · ${fps} fps${ui.playing ? '' : ' · <b>paused</b>'}`;
  requestAnimationFrame(frame);
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === '.') { e.preventDefault(); singleStep(); }
  else if (e.key === 'r' || e.key === 'R') applyInit();
});

// ---- boot -----------------------------------------------------------------
resize();
buildSide();
buildBottom();
applyInit();
// prefers-reduced-motion => stay paused (default); otherwise also default paused per spec
const runM = location.hash.match(/run(\d+)/);       // #run400 — pre-step headlessly (dev/testing)
if (runM) { const k = +runM[1]; for (let i = 0; i < k; i++) step(state, P); pushHist(computeStats(state, P)); }
if (location.hash.includes('play')) togglePlay();
requestAnimationFrame(frame);
