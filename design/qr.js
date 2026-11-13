/* Lastword: a tiny QR encoder (byte mode, error correction M, versions 1-6, up to 106 bytes).
 * Used at build time by design/build_site.py to inline a QR code as SVG; no runtime dependency.
 * Verified module-for-module against npm `qrcode` 1.5.4 for every mask (see design/qr.test.cjs).
 *
 *   node design/qr.js "https://example.com"      -> prints an <svg>
 *   require('./qr.js').matrix(text[, mask])        -> { size, version, mask, rows: boolean[][] }
 */
'use strict';

// Version table for level M: total codewords, EC codewords per block, number of blocks (all same size up to v6).
const M = {
  1: { total: 26, ec: 10, blocks: 1 },
  2: { total: 44, ec: 16, blocks: 1 },
  3: { total: 70, ec: 26, blocks: 1 },
  4: { total: 100, ec: 18, blocks: 2 },
  5: { total: 134, ec: 24, blocks: 2 },
  6: { total: 172, ec: 16, blocks: 4 },
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

// GF(256) with primitive polynomial 0x11d
const EXP = new Array(512), LOG = new Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generator(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}
function ecc(data, deg) {
  const g = generator(deg), res = data.concat(new Array(deg).fill(0));
  for (let i = 0; i < data.length; i++) {
    const c = res[i];
    if (c !== 0) for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], c);
  }
  return res.slice(data.length);
}

function codewords(bytes, v) {
  const t = M[v], dataLen = t.total - t.ec * t.blocks;
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  put(4, 4); put(bytes.length, 8); bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, dataLen * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; data.length < dataLen; p++) data.push(p % 2 ? 0x11 : 0xec);
  const per = dataLen / t.blocks, blocks = [], ecs = [];
  for (let b = 0; b < t.blocks; b++) { const d = data.slice(b * per, (b + 1) * per); blocks.push(d); ecs.push(ecc(d, t.ec)); }
  const out = [];
  for (let i = 0; i < per; i++) blocks.forEach((d) => out.push(d[i]));
  for (let i = 0; i < t.ec; i++) ecs.forEach((e) => out.push(e[i]));
  return out;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function formatBits(mask) {
  const data = (0 << 3) | mask; // level M = 00
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

function build(v, cw, mask) {
  const n = v * 4 + 17;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fn = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (r, c, val) => { m[r][c] = val; fn[r][c] = true; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
      const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on);
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[v];
  for (const r of al) for (const c of al) {
    if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (r === al[al.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // format information (ISO 18004 figure 25) and the dark module
  placeFormat(m, fn, n, formatBits(mask));
  set(n - 8, 8, true);

  // data
  const bits = [];
  cw.forEach((b) => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); });
  let k = 0, up = true;
  for (let c = n - 1; c > 0; c -= 2) {
    if (c === 6) c--;
    for (let i = 0; i < n; i++) {
      const r = up ? n - 1 - i : i;
      for (let d = 0; d < 2; d++) {
        const cc = c - d;
        if (fn[r][cc]) continue;
        let bit = k < bits.length ? bits[k] === 1 : false;
        k++;
        if (MASKS[mask](r, cc)) bit = !bit;
        m[r][cc] = bit;
      }
    }
    up = !up;
  }
  return m;
}

function placeFormat(m, fn, n, f) {
  const bit = (i) => ((f >> i) & 1) === 1;
  const s = (r, c, v) => { m[r][c] = v; fn[r][c] = true; };
  // copy 1: bits 0-7 down column 8 (skipping timing row 6), bits 8-14 left along row 8
  for (let i = 0; i <= 5; i++) s(i, 8, bit(i));
  s(7, 8, bit(6)); s(8, 8, bit(7)); s(8, 7, bit(8));
  for (let i = 9; i < 15; i++) s(8, 14 - i, bit(i));
  // copy 2: bits 0-7 along row 8 from the right, bits 8-14 up column 8 from the bottom
  for (let i = 0; i < 8; i++) s(8, n - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) s(n - 15 + i, 8, bit(i));
}

function penalty(m) {
  const n = m.length; let p = 0;
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
    let run = 1;
    for (let j = 1; j < n; j++) {
      const a = pass ? m[j][i] : m[i][j], b = pass ? m[j - 1][i] : m[i][j - 1];
      if (a === b) run++; else { if (run >= 5) p += run - 2; run = 1; }
    }
    if (run >= 5) p += run - 2;
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
  }
  const pat = [true, false, true, true, true, false, true, false, false, false, false];
  const rev = pat.slice().reverse();
  for (let i = 0; i < n; i++) for (let j = 0; j <= n - 11; j++) {
    for (const q of [pat, rev]) {
      let h = true, v = true;
      for (let k = 0; k < 11; k++) { if (m[i][j + k] !== q[k]) h = false; if (m[j + k][i] !== q[k]) v = false; }
      if (h) p += 40; if (v) p += 40;
    }
  }
  let dark = 0; m.forEach((row) => row.forEach((x) => { if (x) dark++; }));
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

function matrix(text, forceMask, forceVersion) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  let v = forceVersion || 1;
  while (!forceVersion && v <= 6 && bytes.length > M[v].total - M[v].ec * M[v].blocks - 2) v++;
  if (v > 6) throw new Error('text too long for this encoder (max 106 bytes)');
  const cw = codewords(bytes, v);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask != null && mask !== forceMask) continue;
    const m = build(v, cw, mask);
    const score = forceMask != null ? 0 : penalty(m);
    if (!best || score < best.score) best = { score, mask, m };
  }
  return { size: best.m.length, version: v, mask: best.mask, rows: best.m };
}

// One path of unit squares, merged per row run. Quiet zone of 4 modules.
function svg(text, opts) {
  opts = opts || {};
  const q = matrix(text), quiet = 4, dim = q.size + quiet * 2;
  let d = '';
  q.rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (!row[c]) continue;
      let w = 1; while (c + w < row.length && row[c + w]) w++;
      d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h' + w + 'v1h-' + w + 'z';
      c += w - 1;
    }
  });
  const label = opts.label ? ' role="img" aria-label="' + opts.label.replace(/"/g, '&quot;') + '"' : ' aria-hidden="true"';
  return '<svg class="' + (opts.className || 'qr') + '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges"' + label + '>' +
    '<rect width="' + dim + '" height="' + dim + '" fill="' + (opts.light || '#EDE7DC') + '"/>' +
    '<path fill="' + (opts.dark || '#0B0C0F') + '" d="' + d + '"/></svg>';
}

module.exports = { matrix, svg };
if (require.main === module) process.stdout.write(svg(process.argv[2] || 'https://will-wallet.vercel.app/pulse'));
