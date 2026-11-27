// squeeze-png: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
// Built for make.fun's png-squeeze-01-run-20261127 (program/v1, Node 22, stdlib only).
//
// How it works, per instance:
//   1. Decode the stored input PNG (colour type 6, rows unfiltered) to RGBA.
//   2. Work out what the image holds: opaque or not, grey or not, at most 256
//      colours or not. From that, build the lossless forms it can be written in:
//      a palette (entries ordered by count, or by luminance, transparent ones
//      first so tRNS stays short), grey / grey+alpha, RGB, or RGBA, with a tRNS
//      key when exactly one value is fully transparent and nothing else uses it.
//   3. Screen every form under several per-row filterings (each row unfiltered,
//      Sub, Up, Paeth, the minimum-signed-sum row choice, the fewest-distinct-
//      pairs row choice, and brute force: each row's five filters weighed by a
//      real deflate of the row after the 32 KiB written before it). The screen
//      weighs each filtered form by zlib level 6 plus its PLTE/tRNS chunk bytes.
//   4. Re-encode the winning filtered bytes three ways and keep the smallest:
//      zlib level 9 (default strategy), zlib level 9 (filtered strategy), and
//      this file's own optimal-parsing deflate (hash-chain LZ77 + dynamic
//      programming over Pareto-optimal match candidates + length-limited
//      dynamic Huffman codes, one re-parse under the dynamic costs).
//   5. Write the PNG: IHDR, PLTE, tRNS, one IDAT, IEND, each CRC correct.
// Everything is deterministic: no clock, no randomness, no environment reads
// beyond the input/output directories the harness names. One run answers all
// eight instances well inside the 60-second wall.
//
// The PNG filter, palette and screening ideas follow the contest kit's own
// published helpers (kit program/scorer/checker/png.mjs and
// program/generator/subject/scale.mjs, MIT); the deflate encoder is original.
import { inflateSync, deflateSync, constants as zlibConstants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// PNG reading and writing
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, from, to) {
  let c = -1;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function assemblePng(chunks) {
  let size = PNG_SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let at = PNG_SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let k = 0; k < 4; k++) out[at + 4 + k] = type.charCodeAt(k);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrBytes(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paethPredict(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode any 8-bit non-interlaced PNG of colour type 0/2/3/4/6 to RGBA.
function decodeToRgba(bytes) {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('input is not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idatParts = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (at + 12 + len > bytes.length) throw new Error('truncated chunk ' + type);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error('bad CRC on ' + type);
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9] };
      if (header.depth !== 8 || header.colourType === 1 || header.colourType === 5) {
        throw new Error('unsupported IHDR');
      }
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error('unexpected chunk ' + type);
    }
  }
  if (!header || !ended || idatParts.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts));
  if (raw.length !== height * (stride + 1)) throw new Error('IDAT inflates to the wrong length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredict(a, b, c);
      }
    } else {
      throw new Error('bad filter type ' + ft);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// PNG row filtering and the screening heuristics
// ---------------------------------------------------------------------------

// Filter one row of `cur` (stride samples) against `prev` (or null) by `type`.
function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredict(a, b, c);
    }
  }
}

// Sum of a filtered row's bytes read as signed values: the PNG spec's
// minimum-sum filter heuristic (section 12.8).
function signedAbsSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// How many distinct neighbouring byte pairs a filtered row holds.
function distinctPairs(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// Filter every row of `samples` by `choice`: a fixed filter 0-4, 'minsum'
// (least signed sum a row), 'pairs' (fewest distinct byte pairs a row) or
// 'brute' (each row's five filters weighed by a real level-4 deflate of the
// row after the 32 KiB written before it). Writes into `raw` when given.
function filterSamples(samples, width, height, bpp, choice, raw) {
  const stride = width * bpp;
  const out = raw ?? new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      out[at] = choice;
      filterRowInto(choice, cur, prev, bpp, out.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = out.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedAbsSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = distinctPairs(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(trial[t], before.length === 0
          ? { level: BRUTE_LEVEL, memLevel: 9 }
          : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    out.set(trial[type], at);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What the image holds, and the lossless forms it can take
// ---------------------------------------------------------------------------

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

// Whether every pixel is opaque, whether every pixel is grey, and the colours
// when there are at most 256 of them (with their counts).
function analyseImage(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
    });
  }
  return { opaque, grey, colours };
}

// The one fully transparent value (grey or RGB) the image may key by tRNS
// instead of an alpha channel: every pixel opaque or that exact value at
// alpha 0, and no opaque pixel of the same value. Null when there is none.
function transparentKeyOf(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOfType(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

const luminanceOf = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];

function paletteEntries(colours, order) {
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return luminanceOf(x) - luminanceOf(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteFormOf(rgba, colours, order) {
  const entries = paletteEntries(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// Every lossless form of the image, each with the filter choices it is tried
// under. A palette image is not also tried as RGB/RGBA: a palette holds it in
// a third of the bytes or less.
function formsOfImage(rgba) {
  const { opaque, grey, colours } = analyseImage(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push({ ...paletteFormOf(rgba, colours, 'count'), filters: [0] });
    forms.push({ ...paletteFormOf(rgba, colours, 'luminance'), filters: [0, 'minsum', 'brute'] });
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKeyOf(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    colourType: ct, bpp, samples: samplesOfType(rgba, ct), plte: null, trns,
    filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

const chunkBytesOf = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

const SCREEN_ZLIB = Object.freeze({ level: 6, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY });

// The screen's winner for one image: its form, filter choice and filtered
// data, weighed by a level-6 zlib stream plus its PLTE/tRNS chunk bytes.
function screenBest(rgba, width, height) {
  let best = null;
  let spare = null;
  for (const form of formsOfImage(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytesOf(form);
    for (const choice of form.filters) {
      const data = filterSamples(form.samples, width, height, form.bpp, choice,
        spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, SCREEN_ZLIB);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, bytes };
      } else {
        spare = data;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Optimal-parsing deflate (original encoder, written for this entry)
// ---------------------------------------------------------------------------
// Hash-chain LZ77 match finding, a dynamic-programming optimal parse over
// Pareto-optimal (length, distance) candidates, and length-limited dynamic
// Huffman codes, one block per 256 KiB of input. A first parse under fixed
// Huffman costs seeds the code lengths; a second parse under those dynamic
// costs is what gets emitted. Deterministic throughout.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenCodeFor(len) {
  if (len === 258) return 285;
  let lo = 0;
  let hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return 257 + lo;
}
function distCodeFor(dist) {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const FIXED_LITLEN = new Uint8Array(288);
const FIXED_DISTLEN = new Uint8Array(32);
for (let i = 0; i < 288; i++) FIXED_LITLEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
for (let i = 0; i < 32; i++) FIXED_DISTLEN[i] = 5;
const LEN_CODE_IDX = new Uint8Array(259);
for (let L = 3; L <= 258; L++) LEN_CODE_IDX[L] = lenCodeFor(L) - 257;

class BitSink {
  constructor(cap) {
    this.buf = new Uint8Array(cap);
    this.pos = 0;
    this.bit = 0;
  }
  grow() {
    const next = new Uint8Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }
  putBits(value, count) {
    for (let i = 0; i < count; i++) {
      if (this.pos >= this.buf.length - 1) this.grow();
      if ((value >> i) & 1) this.buf[this.pos] |= 1 << this.bit;
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
  }
  putCode(code, len) {
    for (let i = len - 1; i >= 0; i--) {
      if (this.pos >= this.buf.length - 1) this.grow();
      if ((code >> i) & 1) this.buf[this.pos] |= 1 << this.bit;
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
  }
  align() {
    if (this.bit) { this.bit = 0; this.pos++; }
  }
  bytes() {
    return this.buf.subarray(0, this.pos + (this.bit ? 1 : 0));
  }
}

// Length-limited Huffman code lengths from symbol frequencies (zlib's
// overflow redistribution: lengths are capped while walking the tree, then
// the over-long codes are moved down). Returns a Uint8Array of lengths.
function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  const lens = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lens;
  if (syms.length === 1) {
    lens[syms[0]] = 1;
    return lens;
  }
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  const nodes = syms.map((s) => ({ f: freq[s], s, l: null, r: null }));
  let q1 = 0;
  const q2 = [];
  let q2i = 0;
  const take = () => {
    const a = q1 < nodes.length ? nodes[q1] : null;
    const b = q2i < q2.length ? q2[q2i] : null;
    if (b === null || (a !== null && a.f <= b.f)) {
      q1++;
      return a;
    }
    q2i++;
    return b;
  };
  let root = null;
  for (;;) {
    const a = take();
    const b = take();
    if (b === null) {
      root = a;
      break;
    }
    q2.push({ f: a.f + b.f, s: -1, l: a, r: b });
  }
  const blCount = new Int32Array(64);
  let overflow = 0;
  const walk = (node, depth) => {
    if (node.s >= 0) {
      let d = depth;
      if (d > maxBits) {
        d = maxBits;
        overflow++;
      }
      lens[node.s] = d;
      blCount[d]++;
      return;
    }
    walk(node.l, depth + 1);
    walk(node.r, depth + 1);
  };
  walk(root, 0);
  if (overflow > 0) {
    // Repair the capped lengths to a complete code (Kraft sum exactly 1):
    // lengthen the least-frequent longest code while over-subscribed, and
    // shorten the most-frequent longest code while under-subscribed. If the
    // repair ever fails, fall back to near-uniform lengths (always valid).
    const T = 1 << maxBits;
    const contrib = (l) => 1 << (maxBits - l);
    let S = 0;
    for (let i = 0; i < n; i++) if (lens[i]) S += contrib(lens[i]);
    let guard = 0;
    let ok = true;
    while (S !== T && guard++ < 100000) {
      if (S > T) {
        let bi = -1;
        let bl = -1;
        let bf = Infinity;
        for (let i = 0; i < n; i++) {
          if (lens[i] && lens[i] < maxBits) {
            if (lens[i] > bl || (lens[i] === bl && freq[i] < bf)) {
              bi = i;
              bl = lens[i];
              bf = freq[i];
            }
          }
        }
        if (bi < 0) {
          ok = false;
          break;
        }
        S -= contrib(bl) >> 1;
        lens[bi]++;
      } else {
        let bi = -1;
        let bl = -1;
        let bf = -1;
        for (let i = 0; i < n; i++) {
          if (lens[i] > 1) {
            if (lens[i] > bl || (lens[i] === bl && freq[i] > bf)) {
              bi = i;
              bl = lens[i];
              bf = freq[i];
            }
          }
        }
        if (bi < 0) {
          ok = false;
          break;
        }
        S += contrib(bl);
        lens[bi]--;
      }
    }
    if (!ok || S !== T) {
      // Near-uniform complete code: L = ceil(log2 k); the (2^L - k) most
      // frequent symbols take length L-1, the rest length L. Kraft is 1.
      const k = syms.length;
      const L = Math.ceil(Math.log2(k));
      const short = (1 << L) - k;
      const order = syms.slice().sort((a, b) => freq[b] - freq[a] || a - b);
      for (let i = 0; i < order.length; i++) lens[order[i]] = i < short ? L - 1 : L;
    }
  }
  return lens;
}

function canonicalCodes(lens) {
  let maxBits = 0;
  for (const l of lens) if (l > maxBits) maxBits = l;
  const blCount = new Int32Array(maxBits + 1);
  for (const l of lens) if (l) blCount[l]++;
  const nextCode = new Int32Array(maxBits + 1);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint32Array(lens.length);
  for (let s = 0; s < lens.length; s++) {
    const l = lens[s];
    if (l) {
      codes[s] = nextCode[l];
      nextCode[l]++;
    }
  }
  return codes;
}

const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const MATCH_WINDOW = 32768;
const MAX_MATCH_LEN = 258;
const MIN_MATCH_LEN = 3;
const PARETO_MAX = 3;

function hashTriple(d, i) {
  return ((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & HASH_MASK;
}

// Length of the match between d[pos..] and d[cand..]; w32 is a Uint32Array
// view of d's buffer when it is word-aligned, else null.
function matchLength(d, n, pos, cand, w32) {
  const maxLen = Math.min(MAX_MATCH_LEN, n - pos);
  let len = 0;
  if (w32 !== null && (pos & 3) === (cand & 3)) {
    while (len < maxLen && ((pos + len) & 3) !== 0 && d[cand + len] === d[pos + len]) len++;
    if (len < maxLen && ((pos + len) & 3) === 0) {
      const wpos = (pos + len) >> 2;
      const wcand = (cand + len) >> 2;
      const words = (maxLen - len) >> 2;
      let wl = 0;
      while (wl < words && w32[wcand + wl] === w32[wpos + wl]) wl++;
      len += wl * 4;
    }
  }
  while (len < maxLen && d[cand + len] === d[pos + len]) len++;
  return len;
}

// Pareto-optimal (length, distance) candidates at one position, written into
// `out` as [len, dist] pairs, longest first. A candidate is kept when no
// other kept candidate is at least as long and at most as far.
function paretoAt(d, n, pos, head, prev, chain, w32, out) {
  const limit = pos > MATCH_WINDOW ? pos - MATCH_WINDOW : 0;
  let cand = head[hashTriple(d, pos)];
  let steps = 0;
  let nc = 0;
  while (cand > limit && cand < pos && steps < chain) {
    steps++;
    const dist = pos - cand;
    if (d[cand + 2] === d[pos + 2]) {
      const len = matchLength(d, n, pos, cand, w32);
      if (len >= MIN_MATCH_LEN) {
        let dominated = false;
        for (let k = 0; k < nc; k++) {
          if (out[k * 2] >= len && out[k * 2 + 1] <= dist) {
            dominated = true;
            break;
          }
        }
        if (!dominated) {
          let w = 0;
          for (let k = 0; k < nc; k++) {
            if (!(len >= out[k * 2] && dist <= out[k * 2 + 1])) {
              out[w * 2] = out[k * 2];
              out[w * 2 + 1] = out[k * 2 + 1];
              w++;
            }
          }
          nc = w;
          if (nc < PARETO_MAX) {
            out[nc * 2] = len;
            out[nc * 2 + 1] = dist;
            nc++;
          } else {
            let si = 0;
            for (let k = 1; k < PARETO_MAX; k++) if (out[k * 2] < out[si * 2]) si = k;
            if (len > out[si * 2]) {
              out[si * 2] = len;
              out[si * 2 + 1] = dist;
            }
          }
        }
        if (len >= MAX_MATCH_LEN) break;
      }
    }
    if (nc > 0) {
      let bl = 0;
      let bd = 1 << 30;
      for (let k = 0; k < nc; k++) {
        if (out[k * 2] > bl) bl = out[k * 2];
        if (out[k * 2 + 1] < bd) bd = out[k * 2 + 1];
      }
      if ((bl >= 64 && bd <= 512) || (bl >= 32 && bd <= 64)) break;
    }
    cand = prev[cand];
  }
  if (nc === 2 && out[0] < out[2]) {
    const a = out[0];
    const b = out[1];
    out[0] = out[2];
    out[1] = out[3];
    out[2] = a;
    out[3] = b;
  } else if (nc === 3) {
    for (let a = 1; a < 3; a++) {
      const l = out[a * 2];
      const dd = out[a * 2 + 1];
      let b = a - 1;
      while (b >= 0 && out[b * 2] < l) {
        out[(b + 1) * 2] = out[b * 2];
        out[(b + 1) * 2 + 1] = out[b * 2 + 1];
        b--;
      }
      out[(b + 1) * 2] = l;
      out[(b + 1) * 2 + 1] = dd;
    }
  }
  return nc;
}

// Match candidates for every position, once (they do not depend on the cost
// model, so both parses reuse them).
function findMatchCandidates(d, chain) {
  const n = d.length;
  const cLen = new Uint16Array(PARETO_MAX * n);
  const cDist = new Uint16Array(PARETO_MAX * n);
  const cCnt = new Uint8Array(n);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const w32 = d.byteOffset % 4 === 0 ? new Uint32Array(d.buffer, d.byteOffset, d.length >>> 2) : null;
  const tmp = new Uint16Array(PARETO_MAX * 2);
  for (let i = 0; i + MIN_MATCH_LEN <= n; i++) {
    const nc = paretoAt(d, n, i, head, prev, chain, w32, tmp);
    if (nc > 0) {
      cCnt[i] = nc;
      for (let k = 0; k < nc; k++) {
        cLen[i * PARETO_MAX + k] = tmp[k * 2];
        cDist[i * PARETO_MAX + k] = tmp[k * 2 + 1];
      }
    }
    if (i + 2 < n) {
      const h = hashTriple(d, i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  return { cLen, cDist, cCnt };
}

// Dynamic-programming optimal parse under a bit-cost model. litCost is the
// cost of a literal byte, lenCost[k] of length code k, distCost[k] of distance
// code k. Returns the token list: {lit} or {len, dist}.
function optimalParse(d, cLen, cDist, cCnt, litCost, lenCost, distCost) {
  const n = d.length;
  const cost = new Float64Array(n + 1);
  cost.fill(Infinity);
  cost[0] = 0;
  const chLen = new Uint16Array(n + 1);
  const chDist = new Uint16Array(n + 1);
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci === Infinity) continue;
    const cl = ci + litCost[d[i]];
    if (cl < cost[i + 1]) {
      cost[i + 1] = cl;
      chLen[i + 1] = 0;
    }
    const nc = cCnt[i];
    for (let c = 0; c < nc; c++) {
      const maxL = cLen[i * PARETO_MAX + c];
      const dist = cDist[i * PARETO_MAX + c];
      const dc = distCost[distCodeFor(dist)];
      const de = DIST_EXTRA[distCodeFor(dist)];
      const cap = Math.min(maxL, n - i);
      let prevL = 2;
      for (let k = 0; k < 29; k++) {
        const L = LEN_BASE[k];
        if (L > cap) break;
        if (L <= prevL) continue;
        const tot = ci + lenCost[k] + LEN_EXTRA[k] + dc + de;
        if (tot < cost[i + L]) {
          cost[i + L] = tot;
          chLen[i + L] = L;
          chDist[i + L] = dist;
        }
        prevL = L;
      }
      if (cap > prevL) {
        const code = LEN_CODE_IDX[cap];
        const tot = ci + lenCost[code] + LEN_EXTRA[code] + dc + de;
        if (tot < cost[i + cap]) {
          cost[i + cap] = tot;
          chLen[i + cap] = cap;
          chDist[i + cap] = dist;
        }
      }
    }
  }
  const tokens = [];
  let p = n;
  while (p > 0) {
    const L = chLen[p];
    if (L === 0) {
      tokens.push({ lit: d[p - 1] });
      p -= 1;
    } else {
      tokens.push({ len: L, dist: chDist[p] });
      p -= L;
    }
  }
  tokens.reverse();
  return tokens;
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Write one dynamic-Huffman deflate block holding `tokens`.
function emitDynamicBlock(w, tokens, litLens, litCodes, distLens, distCodes, isFinal) {
  w.putBits(isFinal ? 1 : 0, 1);
  w.putBits(2, 2);
  let hlit = 29;
  while (hlit > 0 && litLens[257 + hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const total = 257 + hlit + hdist;
  const allLens = new Uint8Array(total);
  for (let i = 0; i < 257 + hlit; i++) allLens[i] = litLens[i];
  for (let i = 0; i < hdist; i++) allLens[257 + hlit + i] = distLens[i];
  const syms = [];
  let i = 0;
  while (i < total) {
    const v = allLens[i];
    let run = 0;
    while (i + run < total && allLens[i + run] === v) run++;
    let done = 0;
    if (v === 0) {
      while (run - done >= 11) {
        const t = Math.min(run - done, 138);
        syms.push([18, t - 11, 7]);
        done += t;
      }
      if (run - done >= 3) {
        syms.push([17, run - done - 3, 3]);
        done = run;
      }
      while (done < run) {
        syms.push([0, 0, 0]);
        done++;
      }
    } else {
      syms.push([v, 0, 0]);
      done = 1;
      while (run - done >= 3) {
        const t = Math.min(run - done, 6);
        syms.push([16, t - 3, 2]);
        done += t;
      }
      while (done < run) {
        syms.push([v, 0, 0]);
        done++;
      }
    }
    i += run;
  }
  const clFreq = new Uint32Array(19);
  for (const [s] of syms) clFreq[s]++;
  let clUsed = 0;
  for (let s = 0; s < 19; s++) if (clFreq[s] > 0) clUsed++;
  if (clUsed === 1) {
    if (clFreq[0] === 0) clFreq[0] = 1;
    else clFreq[1] = 1;
  }
  const clLens = huffmanLengths(clFreq, 7);
  const clCodes = canonicalCodes(clLens);
  let hclen = 19;
  while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
  w.putBits(hlit, 5);
  w.putBits(hdist - 1, 5);
  w.putBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.putBits(clLens[CL_ORDER[k]], 3);
  for (const [s, e, eb] of syms) {
    w.putCode(clCodes[s], clLens[s]);
    if (eb) w.putBits(e, eb);
  }
  for (const t of tokens) {
    if (t.lit !== undefined) {
      w.putCode(litCodes[t.lit], litLens[t.lit]);
    } else {
      const lc = lenCodeFor(t.len);
      w.putCode(litCodes[lc], litLens[lc]);
      if (LEN_EXTRA[lc - 257]) w.putBits(t.len - LEN_BASE[lc - 257], LEN_EXTRA[lc - 257]);
      const dc = distCodeFor(t.dist);
      w.putCode(distCodes[dc], distLens[dc]);
      if (DIST_EXTRA[dc]) w.putBits(t.dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  w.putCode(litCodes[256], litLens[256]);
}

// The optimal-parsing deflate of `data` as one zlib stream.
function deflateOptimal(data) {
  const n = data.length;
  if (n === 0) {
    const w = new BitSink(8);
    w.putBits(1, 1);
    w.putBits(1, 2);
    w.putCode(0, 7);
    w.align();
    const body = w.bytes();
    const out = new Uint8Array(2 + body.length + 4);
    out[0] = 0x78;
    out[1] = 0xda;
    out.set(body, 2);
    new DataView(out.buffer).setUint32(2 + body.length, 1);
    return out;
  }
  const { cLen, cDist, cCnt } = findMatchCandidates(data, 64);
  const lenCost1 = new Float64Array(29);
  for (let k = 0; k < 29; k++) lenCost1[k] = FIXED_LITLEN[257 + k];
  const distCost1 = new Float64Array(32);
  for (let i = 0; i < 32; i++) distCost1[i] = 5;
  const tokens1 = optimalParse(data, cLen, cDist, cCnt, FIXED_LITLEN, lenCost1, distCost1);
  const lf = new Uint32Array(288);
  const df = new Uint32Array(30);
  for (const t of tokens1) {
    if (t.lit !== undefined) lf[t.lit]++;
    else {
      lf[lenCodeFor(t.len)]++;
      df[distCodeFor(t.dist)]++;
    }
  }
  lf[256] = 1;
  const litLens2 = huffmanLengths(lf, 15);
  const distLens2 = huffmanLengths(df, 15);
  const lenCost2 = new Float64Array(29);
  for (let k = 0; k < 29; k++) lenCost2[k] = litLens2[257 + k] || 1;
  const litCost2 = new Float64Array(288);
  for (let i = 0; i < 288; i++) litCost2[i] = litLens2[i] || 1;
  const distCost2 = new Float64Array(30);
  for (let i = 0; i < 30; i++) distCost2[i] = distLens2[i] || 1;
  const tokens = optimalParse(data, cLen, cDist, cCnt, litCost2, lenCost2, distCost2);
  const blocks = [];
  let cur = [];
  let covered = 0;
  for (const t of tokens) {
    cur.push(t);
    covered += t.lit !== undefined ? 1 : t.len;
    if (covered >= 262144) {
      blocks.push(cur);
      cur = [];
      covered = 0;
    }
  }
  if (cur.length) blocks.push(cur);
  if (blocks.length === 0) blocks.push([]);
  const w = new BitSink(n + 65536);
  blocks.forEach((bt, bi) => {
    const flf = new Uint32Array(288);
    const fdf = new Uint32Array(30);
    for (const t of bt) {
      if (t.lit !== undefined) flf[t.lit]++;
      else {
        flf[lenCodeFor(t.len)]++;
        fdf[distCodeFor(t.dist)]++;
      }
    }
    flf[256] = 1;
    if (fdf[0] === 0 && fdf[1] === 0) {
      fdf[0] = 1;
      fdf[1] = 1;
    }
    const ll = huffmanLengths(flf, 15);
    const dl = huffmanLengths(fdf, 15);
    emitDynamicBlock(w, bt, ll, canonicalCodes(ll), dl, canonicalCodes(dl), bi === blocks.length - 1);
  });
  w.align();
  const body = w.bytes();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(data));
  return out;
}

// ---------------------------------------------------------------------------
// Final encoding and the run
// ---------------------------------------------------------------------------

// The PNG of one image: its screened form and filter, re-encoded by the
// smallest of zlib level 9 (default and filtered strategies) and the
// optimal-parsing deflate above.
function squeezeOne(rgba, width, height) {
  const best = screenBest(rgba, width, height);
  const form = best.form;
  const cands = [];
  cands.push(deflateSync(best.data, { level: 9, memLevel: 9, strategy: zlibConstants.Z_DEFAULT_STRATEGY }));
  cands.push(deflateSync(best.data, { level: 9, memLevel: 9, strategy: zlibConstants.Z_FILTERED }));
  cands.push(deflateOptimal(best.data));
  let idat = cands[0];
  for (const c of cands) if (c.length < idat.length) idat = c;
  const chunks = [['IHDR', ihdrBytes(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', new Uint8Array(idat)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return assemblePng(chunks);
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodeToRgba(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  if (image.width !== 1280 || image.height !== 720) throw new Error(`${id} is not 1280x720`);
  const png = squeezeOne(image.rgba, image.width, image.height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
