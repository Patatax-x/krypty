// krypty2/qr.js — générateur de QR code (mode octets, correction L), sans dépendance.
// Sert à afficher un lien d'invitation à scanner : rien ne quitte la page.
const EC = [[7,1,19,0,0],[10,1,34,0,0],[15,1,55,0,0],[20,1,80,0,0],[26,1,108,0,0],[18,2,68,0,0],[20,2,78,0,0],[24,2,97,0,0],[30,2,116,0,0],[18,2,68,2,69],
  [20,4,81,0,0],[24,2,92,2,93],[26,4,107,0,0],[30,3,115,1,116],[22,5,87,1,88],[24,5,98,1,99],[28,1,107,5,108],[30,5,120,1,121],[28,3,113,4,114],[28,3,107,5,108],
  [28,4,116,4,117],[28,2,111,7,112],[30,4,121,5,122],[30,6,117,4,118],[26,8,106,4,107],[28,10,114,2,115],[30,8,122,4,123],[30,3,117,10,118],[30,7,116,7,117],[30,5,115,10,116],
  [30,13,115,3,116],[30,17,115,0,0],[30,17,115,1,116],[30,13,115,6,116],[30,12,121,7,122],[30,6,121,14,122],[30,17,122,4,123],[30,4,122,18,123],[30,20,117,4,118],[30,19,118,6,119]];
const ALIGN = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],
  [6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],
  [6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]];

// GF(256), polynôme 0x11d
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
function rsRemainder(data, n) {
  let gen = [1];
  for (let i = 0; i < n; i++) { const g = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { g[j] ^= gen[j]; g[j + 1] ^= mul(gen[j], EXP[i]); } gen = g; }
  const r = new Uint8Array(n);
  for (const d of data) { const f = r[0] ^ d; r.copyWithin(0, 1); r[n - 1] = 0; if (f) for (let j = 0; j < n; j++) r[j] ^= mul(gen[j + 1], f); }
  return r;
}
const bch = (data, gen, bits) => { let d = data << bits; const top = 1 << (31 - Math.clz32(gen)); for (let i = 31 - Math.clz32(d); d >= top && i >= 0; i = 31 - Math.clz32(d)) d ^= gen << (i - (31 - Math.clz32(gen))); return (data << bits) | d; };
const MASK = [(i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => ((i >> 1) + Math.floor(j / 3)) % 2 === 0, (i, j) => (i * j) % 2 + (i * j) % 3 === 0, (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0, (i, j) => ((i * j) % 3 + (i + j) % 2) % 2 === 0];

// Retourne { size, m } : m[y][x] = 1 (sombre) / 0. `mask` fixé sert aux tests, sinon le meilleur est choisi.
export function qrEncode(bytes, mask = -1) {
  bytes = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let v = 1; for (; v <= 40; v++) { const [, g1, d1, g2, d2] = EC[v - 1]; if (g1 * d1 + g2 * d2 >= bytes.length + (v < 10 ? 2 : 3)) break; }
  if (v > 40) throw new Error("trop long pour un QR code");
  const [ec, g1, d1, g2, d2] = EC[v - 1], cap = g1 * d1 + g2 * d2;
  // Flux de bits : mode 0100, longueur, octets, terminateur, remplissage
  const bits = []; const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4); push(bytes.length, v < 10 ? 8 : 16); for (const b of bytes) push(b, 8);
  push(0, Math.min(4, cap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data = new Uint8Array(cap); for (let i = 0; i < cap; i++) data[i] = i * 8 < bits.length ? bits.slice(i * 8, i * 8 + 8).reduce((a, b) => a * 2 + b, 0) : (i - bits.length / 8) % 2 ? 0x11 : 0xEC;
  // Blocs + correction, entrelacés
  const blocks = []; let off = 0;
  for (let i = 0; i < g1 + g2; i++) { const n = i < g1 ? d1 : d2; const d = data.slice(off, off + n); off += n; blocks.push({ d, e: rsRemainder(d, ec) }); }
  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  // Matrice : motifs fonctionnels (null = libre pour les données)
  const N = 17 + 4 * v, m = Array.from({ length: N }, () => new Array(N).fill(null)), fn = Array.from({ length: N }, () => new Uint8Array(N));
  const set = (y, x, val) => { m[y][x] = val ? 1 : 0; fn[y][x] = 1; };
  for (const [oy, ox] of [[0, 0], [N - 7, 0], [0, N - 7]]) for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
    const Y = oy + y, X = ox + x; if (Y < 0 || X < 0 || Y >= N || X >= N) continue;
    set(Y, X, (y >= 0 && y <= 6 && (x === 0 || x === 6)) || (x >= 0 && x <= 6 && (y === 0 || y === 6)) || (y >= 2 && y <= 4 && x >= 2 && x <= 4));
  }
  for (const cy of ALIGN[v - 1]) for (const cx of ALIGN[v - 1]) {
    if (fn[cy][cx]) continue;
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) set(cy + y, cx + x, Math.max(Math.abs(y), Math.abs(x)) !== 1);
  }
  for (let i = 8; i < N - 8; i++) { if (!fn[6][i]) set(6, i, i % 2 === 0); if (!fn[i][6]) set(i, 6, i % 2 === 0); }
  for (let i = 0; i < 15; i++) { set(i < 6 ? i : i < 8 ? i + 1 : N - 15 + i, 8, 0); set(8, i < 8 ? N - 1 - i : i < 9 ? 15 - i : 14 - i, 0); }   // réservé : info de format
  set(N - 8, 8, 1);
  if (v >= 7) { const vi = bch(v, 0x1F25, 12); for (let i = 0; i < 18; i++) { const b = (vi >> i) & 1; set(Math.floor(i / 3), i % 3 + N - 11, b); set(i % 3 + N - 11, Math.floor(i / 3), b); } }
  // Données en zigzag
  const cells = [];
  for (let col = N - 1, up = true; col > 0; col -= 2, up = !up) {
    if (col === 6) col--;
    for (let k = 0; k < N; k++) { const y = up ? N - 1 - k : k; for (const x of [col, col - 1]) if (m[y][x] === null) cells.push([y, x]); }
  }
  const raw = new Uint8Array(cells.length); for (let i = 0; i < cells.length; i++) raw[i] = i < out.length * 8 ? (out[i >> 3] >> (7 - (i & 7))) & 1 : 0;
  const render = (mk) => {
    const g = m.map(r => r.slice());
    cells.forEach(([y, x], i) => g[y][x] = raw[i] ^ (MASK[mk](y, x) ? 1 : 0));
    const f = bch((1 << 3) | mk, 0x537, 10) ^ 0x5412;
    for (let i = 0; i < 15; i++) { const b = (f >> i) & 1; g[i < 6 ? i : i < 8 ? i + 1 : N - 15 + i][8] = b; g[8][i < 8 ? N - 1 - i : i < 9 ? 15 - i : 14 - i] = b; }
    return g;
  };
  if (mask >= 0) return { size: N, m: render(mask) };
  let best = null, bestPen = Infinity;
  for (let mk = 0; mk < 8; mk++) { const g = render(mk), p = penalty(g, N); if (p < bestPen) { bestPen = p; best = g; } }
  return { size: N, m: best };
}
function penalty(g, N) {
  let p = 0, dark = 0;
  const line = (get) => { for (let a = 0; a < N; a++) { let run = 1; for (let b = 1; b < N; b++) { if (get(a, b) === get(a, b - 1)) { if (++run === 5) p += 3; else if (run > 5) p++; } else run = 1; }
    for (let b = 0; b + 7 <= N; b++) { const s = Array.from({ length: 7 }, (_, i) => get(a, b + i)).join(""); if (s === "1011101" && (b >= 4 && [1, 2, 3, 4].every(i => !get(a, b - i)) || b + 11 <= N && [7, 8, 9, 10].every(i => !get(a, b + i)))) p += 40; } } };
  line((a, b) => g[a][b]); line((a, b) => g[b][a]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { dark += g[y][x]; if (y && x && g[y][x] === g[y - 1][x] && g[y][x] === g[y][x - 1] && g[y][x] === g[y - 1][x - 1]) p += 3; }
  return p + 10 * Math.floor(Math.abs(dark * 100 / (N * N) - 50) / 5);
}
// Dessine sur un canvas (module = px), marge de 4 modules, couleurs passées par l'appelant.
export function qrDraw(canvas, text, { px = 3, fg = "#000", bg = "#fff" } = {}) {
  const { size, m } = qrEncode(text), Q = 4;
  canvas.width = canvas.height = (size + 2 * Q) * px;
  const x = canvas.getContext("2d"); x.fillStyle = bg; x.fillRect(0, 0, canvas.width, canvas.height); x.fillStyle = fg;
  for (let y = 0; y < size; y++) for (let i = 0; i < size; i++) if (m[y][i]) x.fillRect((i + Q) * px, (y + Q) * px, px, px);
  return size;
}
