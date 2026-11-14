import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSvg } from '../src/qr.js';

// Independent reader for byte-mode, level-M codes: finds the format, unmasks,
// reads the codewords in zig-zag order, de-interleaves and decodes the bytes.
const M_BLOCKS = { 1: [1, 10], 2: [1, 16], 3: [1, 26], 4: [2, 18], 5: [2, 24], 6: [4, 16], 7: [4, 18], 8: [4, 22], 9: [5, 22], 10: [5, 26] };
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function reserved(ver, size) {
  const r = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && (r[y][x] = true);
  for (const [cx, cy] of [[0, 0], [size - 8, 0], [0, size - 8]]) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) mark(cx + x, cy + y);
  for (let i = 0; i < size; i++) (mark(6, i), mark(i, 6));
  for (let i = 0; i < 9; i++) (mark(8, i), mark(i, 8));
  for (let i = 0; i < 8; i++) (mark(size - 1 - i, 8), mark(8, size - 1 - i));
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (const a of pos) for (const b of pos) {
      if ((a === 6 && b === 6) || (a === 6 && b === size - 7) || (a === size - 7 && b === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(a + dx, b + dy);
    }
  }
  if (ver >= 7) for (let i = 0; i < 18; i++) (mark(size - 11 + (i % 3), Math.floor(i / 3)), mark(Math.floor(i / 3), size - 11 + (i % 3)));
  return r;
}

function decode(m) {
  const size = m.length;
  const ver = (size - 17) / 4;
  // format bits from around the top-left finder
  let f = 0;
  const seq = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  seq.forEach(([x, y], i) => (f |= (m[y][x] ? 1 : 0) << i));
  f ^= 0x5412;
  assert.equal(f >>> 13, 0, 'error correction level M');
  const mask = (f >>> 10) & 7;
  const res = reserved(ver, size);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
      if (!res[y][x]) bits.push(m[y][x] !== MASKS[mask](x, y) ? 1 : 0);
    }
  }
  const cw = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) cw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const [nb, ecc] = M_BLOCKS[ver];
  const total = cw.length - (cw.length % 1);
  const shortLen = Math.floor(total / nb);
  const numShort = nb - (total % nb);
  const dataLens = Array.from({ length: nb }, (_, i) => shortLen - ecc + (i < numShort ? 0 : 1));
  const data = Array.from({ length: nb }, () => []);
  let k = 0;
  for (let i = 0; i < Math.max(...dataLens); i++) for (let b = 0; b < nb; b++) if (i < dataLens[b]) data[b].push(cw[k++]);
  const flat = data.flat();
  const bitStr = flat.map((b) => b.toString(2).padStart(8, '0')).join('');
  assert.equal(bitStr.slice(0, 4), '0100', 'byte mode');
  const len = parseInt(bitStr.slice(4, 12), 2);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(parseInt(bitStr.slice(12 + i * 8, 20 + i * 8), 2));
  return { ver, mask, text: new TextDecoder().decode(new Uint8Array(bytes)) };
}

test('encodes otpauth URIs that read back exactly', () => {
  for (const text of [
    'otpauth://totp/Server%20Hub:demo?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Server%20Hub',
    'otpauth://totp/Server%20Hub:a_really_long_username?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=Server%20Hub',
    'hello',
    'x'.repeat(150),
  ]) {
    const out = decode(qrMatrix(text));
    assert.equal(out.text, text);
  }
});

test('every mask produces a readable code; version grows with length', () => {
  const t = 'otpauth://totp/Server%20Hub:demo?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Server%20Hub';
  for (let mask = 0; mask < 8; mask++) {
    const out = decode(qrMatrix(t, mask));
    assert.equal(out.mask, mask);
    assert.equal(out.text, t);
  }
  assert.equal(qrMatrix('hello').length, 21);
  assert.equal(qrMatrix(t).length, 41); // version 6
});

test('qrSvg is a standalone SVG document', () => {
  const svg = qrSvg('hello');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 25 25"/);
  assert.ok(!/script|on\w+=/i.test(svg));
});
