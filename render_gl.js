// WebGL2 renderer — same picture as render.js, but every cell / flora mark / line is
// a GPU point-sprite or line drawn in ONE draw call per category instead of thousands
// of Canvas2D path ops. The per-cell colour loop is shared with the Canvas2D path
// (same HSL functions), so the two renderers are pixel-siblings. Kept behind the same
// draw() seam; main.js falls back to Canvas2D if WebGL2 is unavailable.

import { G, GENE, geneRanges } from './sim.js';
import { phenotypeHSL, speciesHSL, trophicHSL, hslToRgb, makeFlora, sampleField, computePairs } from './render.js';

const GROUND = [0x12 / 255, 0x10 / 255, 0x0e / 255];

// One program draws everything: point-sprites (round, optionally a ring) and lines.
const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_color;
layout(location=2) in float a_size;
uniform vec2 u_res; uniform vec2 u_off; uniform float u_scale;
out vec4 v_color;
void main() {
  vec2 s = a_pos * u_scale + u_off;
  vec2 clip = (s / u_res) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_size;
  v_color = a_color;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec4 v_color; out vec4 o;
uniform float u_round;   // 1 = round point sprite, 0 = line/plain
uniform float u_ring;    // 1 = draw a ring instead of a filled disc
void main() {
  vec4 col = v_color;
  if (u_round > 0.5) {
    float d = length(gl_PointCoord - 0.5);
    float aa = fwidth(d) + 0.001;
    float a = 1.0 - smoothstep(0.5 - aa, 0.5 + aa, d);
    if (u_ring > 0.5) a *= smoothstep(0.34 - aa, 0.34 + aa, d);
    if (a <= 0.0) discard;
    col.a *= a;
  }
  o = col;
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('shader:', gl.getShaderInfoLog(sh)); gl.deleteShader(sh); return null; }
  return sh;
}

export function createGLRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: false, premultipliedAlpha: false });
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT), fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn('link:', gl.getProgramInfoLog(prog)); return null; }

  const u = {
    res: gl.getUniformLocation(prog, 'u_res'), off: gl.getUniformLocation(prog, 'u_off'),
    scale: gl.getUniformLocation(prog, 'u_scale'), round: gl.getUniformLocation(prog, 'u_round'),
    ring: gl.getUniformLocation(prog, 'u_ring'),
  };
  const A_POS = 0, A_COLOR = 1, A_SIZE = 2;
  const vao = gl.createVertexArray();
  const posB = gl.createBuffer(), colB = gl.createBuffer(), sizeB = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, posB); gl.enableVertexAttribArray(A_POS); gl.vertexAttribPointer(A_POS, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, colB); gl.enableVertexAttribArray(A_COLOR); gl.vertexAttribPointer(A_COLOR, 4, gl.UNSIGNED_BYTE, true, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, sizeB); gl.vertexAttribPointer(A_SIZE, 1, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // CPU staging (grown as needed) — filled per category, then uploaded and drawn.
  let sPos = new Float32Array(0), sCol = new Uint8Array(0), sSize = new Float32Array(0), sCap = 0;
  function grow(n) {
    if (n <= sCap) return;
    sCap = Math.max(n, sCap * 2, 8192);
    sPos = new Float32Array(sCap * 2); sCol = new Uint8Array(sCap * 4); sSize = new Float32Array(sCap);
    gl.bindBuffer(gl.ARRAY_BUFFER, posB); gl.bufferData(gl.ARRAY_BUFFER, sPos.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, colB); gl.bufferData(gl.ARRAY_BUFFER, sCol.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, sizeB); gl.bufferData(gl.ARRAY_BUFFER, sSize.byteLength, gl.DYNAMIC_DRAW);
  }
  function flush(mode, m, round, ring, sizeArray, sizeConst) {
    if (m <= 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, posB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sPos, 0, m * 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, colB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sCol, 0, m * 4);
    gl.uniform1f(u.round, round); gl.uniform1f(u.ring, ring);
    if (sizeArray) { gl.enableVertexAttribArray(A_SIZE); gl.bindBuffer(gl.ARRAY_BUFFER, sizeB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sSize, 0, m); }
    else { gl.disableVertexAttribArray(A_SIZE); gl.vertexAttrib1f(A_SIZE, sizeConst); }
    gl.drawArrays(mode, 0, m);
  }

  // Persistent per-cell colours (also used to tint the adjacency lines).
  let cellCol = new Uint8Array(0);

  // cached flora, keyed on habitat size + field seed
  let floraArr = null, floraN = 0, floraKey = '';

  const CELL_SIZE = 5.0;       // diameter in px (matches the Canvas2D arc radius 2.5)

  function draw(state, P, view, opts) {
    const cw = canvas.width, ch = canvas.height;
    const N = state.count, GEN = state.genome, R = P.R;
    const X = state.x, Y = state.y;
    const Wx = P.worldW != null ? P.worldW : P.world, Wy = P.worldH != null ? P.worldH : P.world;
    const halfWx = Wx / 2, halfWy = Wy / 2, px = view.scale;   // px = device pixels per world unit

    gl.viewport(0, 0, cw, ch);
    gl.useProgram(prog); gl.bindVertexArray(vao);
    gl.uniform2f(u.res, cw, ch); gl.uniform2f(u.off, view.ox, view.oy); gl.uniform1f(u.scale, view.scale);
    gl.clearColor(GROUND[0], GROUND[1], GROUND[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    grow(N + 8);

    // per-cell colour (same logic as Canvas2D) → cellCol
    if (cellCol.length < N * 4) cellCol = new Uint8Array(Math.max(N * 4, cellCol.length * 2, 4096));
    const treeMode = opts.colorMode === 'lineage', trophicMode = opts.colorMode === 'trophic';
    const ranges = treeMode ? geneRanges(R) : null;
    const emax = P.energyOn ? P.energyMax : 0, EN = state.energy;
    for (let i = 0; i < N; i++) {
      const base = i * G;
      const hsl = treeMode ? speciesHSL(state, state.species[i], ranges)
        : trophicMode ? trophicHSL(GEN, base, EN[i], emax)
          : phenotypeHSL(GEN, base, R);
      const rgb = hslToRgb(hsl[0], hsl[1], hsl[2]);
      cellCol[i * 4] = rgb[0]; cellCol[i * 4 + 1] = rgb[1]; cellCol[i * 4 + 2] = rgb[2]; cellCol[i * 4 + 3] = 255;
    }

    // 1. flora field (under everything)
    if (P.energyOn && state.field) drawFlora(state, P, px);

    // 2. adjacency lines
    if (opts.showLines && N > 1) drawGlLines(state, P, opts, X, Y, Wx, Wy, halfWx, halfWy);

    // 3. cells (on top of the field/lines)
    for (let i = 0; i < N; i++) {
      sPos[i * 2] = X[i]; sPos[i * 2 + 1] = Y[i];
      sCol[i * 4] = cellCol[i * 4]; sCol[i * 4 + 1] = cellCol[i * 4 + 1]; sCol[i * 4 + 2] = cellCol[i * 4 + 2]; sCol[i * 4 + 3] = 255;
    }
    flush(gl.POINTS, N, 1, 0, false, CELL_SIZE * px);

    // 4. hover overlay
    const h = opts.hovered;
    if (h != null && h >= 0 && h < N) drawHover(state, P, h, X, Y, Wx, Wy, halfWx, halfWy, px);
  }

  function drawFlora(state, P, px) {
    const F = state.field, K = state.fieldK, fnx = state.fieldNX, fny = state.fieldNY;
    const Wx = P.worldW != null ? P.worldW : P.world, Wy = P.worldH != null ? P.worldH : P.world;
    const key = Wx + 'x' + Wy + '@' + (state._fieldSeed >>> 0);
    if (key !== floraKey || !floraArr) { const f = makeFlora(Wx, Wy, state._fieldSeed >>> 0); floraArr = f.arr; floraN = f.n; floraKey = key; }
    grow(floraN);
    let kmax = 1e-3; for (let c = 0; c < K.length; c++) if (K[c] > kmax) kmax = K[c];
    const inv = 1 / kmax;
    let m = 0;
    for (let k = 0; k < floraN; k++) {
      const x = floraArr[k * 5], y = floraArr[k * 5 + 1];
      const v = sampleField(F, fnx, fny, Wx, Wy, inv, x, y);
      if (v <= 0.07) continue;
      const tint = floraArr[k * 5 + 3], size = floraArr[k * 5 + 2] * (0.4 + 0.7 * v), flower = floraArr[k * 5 + 4];
      let r, g, b;
      if (flower) { r = 150 + 45 * tint; g = 104 + 24 * tint; b = 60; }
      else { r = 58 + 22 * tint; g = 82 + 26 * v; b = 34 + 10 * tint; }
      const a = (0.16 + 0.42 * v) * 255;
      sPos[m * 2] = x; sPos[m * 2 + 1] = y;
      sCol[m * 4] = clamp255(r); sCol[m * 4 + 1] = clamp255(g); sCol[m * 4 + 2] = clamp255(b); sCol[m * 4 + 3] = clamp255(a);
      sSize[m] = size * 2 * px;   // radius → point diameter, in device pixels
      m++;
    }
    flush(gl.POINTS, m, 1, 0, true, 0);
  }

  function drawGlLines(state, P, opts, X, Y, Wx, Wy, halfWx, halfWy) {
    const { pI, pJ, pW, pM, order, np } = computePairs(state, P, opts.lineCap);
    grow(np * 2 + 8);
    const idx = (k) => (order ? order[k] : k);
    let m = 0;
    for (let k = 0; k < np; k++) {
      const e = idx(k), i = pI[e], j = pJ[e], w = pW[e];
      let dx = X[j] - X[i], dy = Y[j] - Y[i];
      if (dx > halfWx) dx -= Wx; else if (dx < -halfWx) dx += Wx;
      if (dy > halfWy) dy -= Wy; else if (dy < -halfWy) dy += Wy;
      const a = (0.06 + 0.34 * w) * (pM[e] ? 1 : 0.5) * 255;   // one-way links dimmer (no dashing in GL)
      const r = (cellCol[i * 4] + cellCol[j * 4]) >> 1, g = (cellCol[i * 4 + 1] + cellCol[j * 4 + 1]) >> 1, b = (cellCol[i * 4 + 2] + cellCol[j * 4 + 2]) >> 1;
      sPos[m * 2] = X[i]; sPos[m * 2 + 1] = Y[i]; sCol[m * 4] = r; sCol[m * 4 + 1] = g; sCol[m * 4 + 2] = b; sCol[m * 4 + 3] = a; m++;
      sPos[m * 2] = X[i] + dx; sPos[m * 2 + 1] = Y[i] + dy; sCol[m * 4] = r; sCol[m * 4 + 1] = g; sCol[m * 4 + 2] = b; sCol[m * 4 + 3] = a; m++;
    }
    flush(gl.LINES, m, 0, 0, false, 1);
  }

  function drawHover(state, P, h, X, Y, Wx, Wy, halfWx, halfWy, px) {
    const GEN = state.genome, R = P.R, N = state.count;
    const ri = R * GEN[h * G + GENE.rScale];
    grow(2 * N + 4);   // two vertices per link
    // this cell's links, bright
    let m = 0;
    for (let j = 0; j < N; j++) {
      if (j === h) continue;
      let dx = X[j] - X[h], dy = Y[j] - Y[h];
      if (dx > halfWx) dx -= Wx; else if (dx < -halfWx) dx += Wx;
      if (dy > halfWy) dy -= Wy; else if (dy < -halfWy) dy += Wy;
      const d = Math.hypot(dx, dy), rj = R * GEN[j * G + GENE.rScale];
      if (d >= (ri > rj ? ri : rj)) continue;
      sPos[m * 2] = X[h]; sPos[m * 2 + 1] = Y[h]; setCol(m, 214, 207, 198, 217); m++;
      sPos[m * 2] = X[h] + dx; sPos[m * 2 + 1] = Y[h] + dy; setCol(m, 214, 207, 198, 217); m++;
    }
    flush(gl.LINES, m, 0, 0, false, 1);
    // amber ring on the hovered cell
    sPos[0] = X[h]; sPos[1] = Y[h]; setCol(0, 201, 135, 58, 255); sSize[0] = 13 * px;
    flush(gl.POINTS, 1, 1, 1, true, 0);
  }

  function setCol(m, r, g, b, a) { sCol[m * 4] = r; sCol[m * 4 + 1] = g; sCol[m * 4 + 2] = b; sCol[m * 4 + 3] = a; }

  return { draw, mode: 'webgl2', gl };
}

function clamp255(v) { v = v | 0; return v < 0 ? 0 : v > 255 ? 255 : v; }
