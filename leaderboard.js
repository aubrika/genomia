import { hashBaseHSL, hslToRgb } from './render.js';

// Species leaderboard — DOM-free. Ranks distinct genomes, i.e. species hashes (see
// render.js makeSpeciesHasher): related species whose founding genomes land in the same
// hash bins share a look and a name, so they are counted together as one entry. Each
// entry's score is its peak count of simultaneously living members. Peaks live on
// state._hashPeak (a Map, cleared by resetState).

// Living members per species hash this tick: Map hash -> { n, sp } where sp is the
// oldest (lowest-id) living species with that hash. O(population + living species).
let counts = new Int32Array(0);
const live = [];
function countByHash(state, hash) {
  const S = state.nextSpecies, N = state.count, SP = state.species;
  if (counts.length < S) counts = new Int32Array(Math.max(S, counts.length * 2, 1024));
  live.length = 0;
  for (let i = 0; i < N; i++) { const sp = SP[i]; if (counts[sp]++ === 0) live.push(sp); }
  const byHash = new Map();
  for (const sp of live) {
    const h = hash(sp), e = byHash.get(h);
    if (e) { e.n += counts[sp]; if (sp < e.sp) e.sp = sp; } else byHash.set(h, { n: counts[sp], sp });
    counts[sp] = 0;
  }
  return byHash;
}

// Raise each living hash's peak. Call once per tick.
export function updatePeaks(state, hash) {
  if (!state._hashPeak) state._hashPeak = new Map();
  const peaks = state._hashPeak;
  for (const [h, e] of countByHash(state, hash)) {
    const p = peaks.get(h);
    if (!p) peaks.set(h, { hash: h, peak: e.n, tick: state.tick, sp: e.sp });
    else if (e.n > p.peak) { p.peak = e.n; p.tick = state.tick; }
  }
}

// The k hashes with the highest peaks, best first (ties: the earlier peak wins), each as
// { hash, peak, tick, sp, now, species } — sp is the species to draw (the oldest one
// seen), now the living members, species how many species share the hash now.
export function topSpecies(state, k, hash) {
  const peaks = state._hashPeak;
  if (!peaks) return [];
  const top = [...peaks.values()].sort((a, b) => b.peak - a.peak || a.tick - b.tick).slice(0, k);
  const nowBy = countByHash(state, hash), shared = new Map();
  for (const sp of live) { const h = hash(sp); shared.set(h, (shared.get(h) || 0) + 1); }
  return top.map((t) => { const e = nowBy.get(t.hash); return Object.assign({}, t, { now: e ? e.n : 0, species: shared.get(t.hash) || 0 }); });
}

// Species names: a colour word for the species' base hash colour plus an invented
// creature name, both from the species hash, so the same hash always gets the same name.
// The colour word is the named colour nearest (in CIELAB) to the colour the species is
// drawn in species-hash mode. The creatures came from a small character-level model
// trained on real animal names, filtered against real words and anything offensive, and
// reviewed by hand.
const COLOURS = [
  ['scarlet', 0xE0402F], ['vermilion', 0xE35A2B], ['tangerine', 0xEB7A2E], ['amber', 0xE39A2C],
  ['marigold', 0xE3B12E], ['saffron', 0xE8C437], ['citron', 0xC9C93A], ['chartreuse', 0xA3CC3A],
  ['lime', 0x7BCB3F], ['clover', 0x4FBF4A], ['emerald', 0x38B865], ['jade', 0x35B585],
  ['seafoam', 0x3DC4A2], ['turquoise', 0x33BFC4], ['cyan', 0x38B2D6], ['cerulean', 0x3A9DDB],
  ['azure', 0x3D86E0], ['cornflower', 0x5A7BE0], ['cobalt', 0x4363D9], ['indigo', 0x5A4FD6],
  ['violet', 0x7A4FD6], ['amethyst', 0x9A50D4], ['orchid', 0xB754CF], ['magenta', 0xD04FC6],
  ['fuchsia', 0xD9479F], ['cerise', 0xDB4380], ['raspberry', 0xD8435F], ['crimson', 0xD63A45],
];
const CREATURES = [
  'jat', 'lebra', 'squib', 'bexo', 'civo', 'civy', 'clep', 'clyn', 'crid', 'dral', 'fral',
  'frel', 'garg', 'gorn', 'hyel', 'juko', 'kraw', 'loby', 'lorp', 'meep', 'nivy', 'ploo',
  'pyty', 'wano', 'yfin', 'zela', 'fala', 'frid', 'clig', 'garm', 'gopo', 'imba', 'selo',
  'tarm', 'vuid', 'ysna', 'axibo', 'axine', 'axora', 'axovet', 'babbou', 'babug', 'baryx',
  'batig', 'beaca', 'bexig', 'bexoat', 'bobret', 'bonfin', 'bugoa', 'buzalo', 'buzark',
  'buzill', 'caryx', 'capork', 'capink', 'catape', 'cawnar', 'civala', 'civorm', 'civuff',
  'clabug', 'coada', 'cobong', 'cocong', 'codovy', 'conkat', 'coriaw', 'croby', 'cuppel',
  'derou', 'dincoo', 'drala', 'drimar', 'dugall', 'dunkal', 'egorm', 'elkaby', 'emulla',
  'erowl', 'falrew', 'firawk', 'fisolo', 'flynat', 'flynow', 'galcat', 'garaw', 'gargoo',
  'gazale', 'grony', 'heark', 'hinew', 'hyaril', 'hyog', 'hytur', 'ibeel', 'ibink', 'igall',
  'igauke', 'jacork', 'jagoo', 'jagly', 'julla', 'juzal', 'kabbou', 'kajer', 'kandog', 'kapear',
  'kapy', 'kesumb', 'ketang', 'kincoo', 'kinoby', 'kiwom', 'knarp', 'koato', 'koobo', 'krabug',
  'kricat', 'kunleo', 'langon', 'larpon', 'lobreo', 'malear', 'melow', 'ninco', 'ocemu',
  'panak', 'polfin', 'quesal', 'raflyn', 'tapyt', 'towlin', 'vula', 'walabu', 'weagoa',
  'whawna', 'wiguid', 'wolpan', 'womoss', 'wompe', 'womur', 'wooboa', 'woono', 'wraig', 'wrilda',
];
function rgbToLab(r, g, b) {
  const lin = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  r = lin(r); g = lin(g); b = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const COLOUR_LABS = COLOURS.map(([, c]) => rgbToLab(c >> 16, (c >> 8) & 255, c & 255));
export function colourWord(rgb) {
  const L = rgbToLab(rgb[0], rgb[1], rgb[2]);
  let best = 0, bd = Infinity;
  for (let k = 0; k < COLOUR_LABS.length; k++) {
    const c = COLOUR_LABS[k], d = (c[0] - L[0]) ** 2 + (c[1] - L[1]) ** 2 + (c[2] - L[2]) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return COLOURS[best][0];
}
export function speciesName(hash) {
  let h = Math.imul(hash ^ 0x5bd1e995, 0x27d4eb2d) >>> 0;   // re-mixed, so the creature isn't tied to the hue bits
  h ^= h >>> 13; h = Math.imul(h, 0x165667b1) >>> 0;
  return colourWord(hslToRgb(...hashBaseHSL(hash))) + ' ' + CREATURES[h % CREATURES.length];
}
