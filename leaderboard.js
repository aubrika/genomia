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

// Silly names: an adjective and an animal, both picked from the species hash (re-mixed,
// so the name doesn't move in step with the hue). Same hash, same name.
const ADJECTIVES = [
  'hairy', 'deciduous', 'sleepy', 'wobbly', 'grumpy', 'sparkly', 'damp', 'fuzzy',
  'bashful', 'crunchy', 'velvet', 'nervous', 'majestic', 'soggy', 'tiny', 'dapper',
  'feral', 'gelatinous', 'polite', 'lumpy', 'glossy', 'ornery', 'jaunty', 'moody',
  'peculiar', 'rubbery', 'spiky', 'squishy', 'stately', 'thrifty', 'zesty', 'clumsy',
  'cosmic', 'curious', 'dizzy', 'elastic', 'fancy', 'fluffy', 'frilly', 'gallant',
  'giddy', 'hungry', 'itchy', 'jolly', 'lanky', 'mossy', 'nimble', 'pensive',
  'plucky', 'prickly', 'quirky', 'rowdy', 'rusty', 'salty', 'scruffy', 'smug',
  'speckled', 'stubborn', 'sneaky', 'woolly', 'nocturnal', 'carbonated', 'migratory', 'suspicious',
  'theatrical', 'unflappable', 'bewildered', 'cantankerous', 'bioluminescent', 'chonky', 'philosophical', 'sticky',
];
const ANIMALS = [
  'gibbon', 'fish', 'wombat', 'axolotl', 'capybara', 'newt', 'lemur', 'tapir',
  'platypus', 'pangolin', 'narwhal', 'otter', 'badger', 'heron', 'puffin', 'walrus',
  'yak', 'ferret', 'gecko', 'mole', 'shrew', 'quokka', 'okapi', 'aardvark',
  'armadillo', 'beaver', 'bison', 'camel', 'cuttlefish', 'dormouse', 'eel', 'emu',
  'flamingo', 'goose', 'hedgehog', 'ibis', 'jellyfish', 'kiwi', 'koala', 'llama',
  'lobster', 'manatee', 'marmot', 'mongoose', 'moose', 'octopus', 'ostrich', 'owl',
  'pelican', 'penguin', 'possum', 'raccoon', 'salamander', 'seahorse', 'sloth', 'snail',
  'squid', 'stoat', 'tortoise', 'toucan', 'vole', 'weasel', 'zebra', 'anchovy',
  'blobfish', 'tardigrade', 'sea cucumber', 'mudskipper', 'wallaby', 'hamster', 'bat', 'crab',
];
export function speciesName(hash) {
  let h = Math.imul(hash ^ 0x5bd1e995, 0x27d4eb2d) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x165667b1) >>> 0;
  return ADJECTIVES[h % ADJECTIVES.length] + ' ' + ANIMALS[Math.floor(h / ADJECTIVES.length) % ANIMALS.length];
}
