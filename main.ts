// PNG Squeeze — a lossless PNG compressor for 1280x720 RGBA screenshots.
//
// Reads every instance under the input directory (<input>/<id>/image.png),
// re-encodes the same pixels as the smallest PNG it can build with Node's
// standard library alone, and writes it to <output>/<id>/image.png.
//
// Method: parse and unfilter the input, analyse the pixels, build every
// honest colour layout that fits (palette under several index orderings,
// grey, grey+alpha, RGB, RGBA), then try a fixed set of filter + deflate
// combinations per layout and keep the smallest file. No clocks, no
// randomness: the same input always yields the same output bytes, and the
// work per instance is bounded by the layout sizes, never by time.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants, deflateSync, inflateSync } from "node:zlib";

// ---------------------------------------------------------------- CRC-32

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ---------------------------------------------------------------- decode

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Reverse PNG row filtering. `data` is the inflated IDAT stream holding,
// per row, one filter byte followed by width*bpp bytes.
function unfilter(data: Buffer, width: number, height: number, bpp: number): Buffer {
  const rowBytes = width * bpp;
  const out = Buffer.alloc(rowBytes * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[pos++];
    const rowOff = y * rowBytes;
    const prevOff = rowOff - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[pos++];
      const a = i >= bpp ? out[rowOff + i - bpp] : 0;
      const b = y > 0 ? out[prevOff + i] : 0;
      const c = y > 0 && i >= bpp ? out[prevOff + i - bpp] : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) v = x + paeth(a, b, c);
      out[rowOff + i] = v & 0xff;
    }
  }
  return out;
}

interface DecodedImage {
  width: number;
  height: number;
  rgba: Buffer; // width*height*4 bytes, one byte per channel
}

function decodePng(buf: Buffer): DecodedImage {
  let width = 0;
  let height = 0;
  let colourType = 6;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idatParts: Buffer[] = [];
  let pos = 8; // skip the signature
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (type === "IHDR") {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      colourType = buf[dataStart + 9];
    } else if (type === "PLTE") {
      plte = buf.subarray(dataStart, dataStart + len);
    } else if (type === "tRNS") {
      trns = buf.subarray(dataStart, dataStart + len);
    } else if (type === "IDAT") {
      idatParts.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      break;
    }
    pos = dataStart + len + 4;
  }
  const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 4 ? 2 : 4;
  const bpp = colourType === 3 ? 1 : channels;
  const raw = inflateSync(Buffer.concat(idatParts));
  const rows = unfilter(raw, width, height, bpp);
  const rgba = Buffer.alloc(width * height * 4);
  if (colourType === 6) {
    rows.copy(rgba);
  } else if (colourType === 2) {
    for (let s = 0, d = 0; d < rgba.length; s += 3, d += 4) {
      rgba[d] = rows[s];
      rgba[d + 1] = rows[s + 1];
      rgba[d + 2] = rows[s + 2];
      rgba[d + 3] = 255;
    }
  } else if (colourType === 0) {
    for (let s = 0, d = 0; d < rgba.length; s += 1, d += 4) {
      rgba[d] = rows[s];
      rgba[d + 1] = rows[s];
      rgba[d + 2] = rows[s];
      rgba[d + 3] = 255;
    }
  } else if (colourType === 4) {
    for (let s = 0, d = 0; d < rgba.length; s += 2, d += 4) {
      rgba[d] = rows[s];
      rgba[d + 1] = rows[s];
      rgba[d + 2] = rows[s];
      rgba[d + 3] = rows[s + 1];
    }
  } else if (colourType === 3 && plte !== null) {
    for (let s = 0, d = 0; d < rgba.length; s += 1, d += 4) {
      const idx = rows[s];
      rgba[d] = plte[idx * 3];
      rgba[d + 1] = plte[idx * 3 + 1];
      rgba[d + 2] = plte[idx * 3 + 2];
      rgba[d + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- layouts

interface Layout {
  colourType: number;
  bpp: number; // bytes per pixel in the encoded rows
  rows: Buffer; // height * width * bpp bytes, unfiltered pixel rows
  plte: Buffer | null;
  trns: Buffer | null;
  overhead: number; // bytes the PLTE/tRNS chunks add to the file
}

function paletteLayout(img: DecodedImage, order: number[]): Layout {
  // `order` lists the distinct packed RGBA colours in palette order.
  const { width, height, rgba } = img;
  const pixels = width * height;
  const indexOf = new Map<number, number>();
  for (let i = 0; i < order.length; i++) indexOf.set(order[i], i);
  const rows = Buffer.alloc(pixels);
  for (let p = 0; p < pixels; p++) {
    const o = p * 4;
    const key = ((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]) >>> 0;
    rows[p] = indexOf.get(key) as number;
  }
  const plte = Buffer.alloc(order.length * 3);
  let lastAlpha = -1;
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    plte[i * 3] = (key >>> 24) & 0xff;
    plte[i * 3 + 1] = (key >>> 16) & 0xff;
    plte[i * 3 + 2] = (key >>> 8) & 0xff;
    if ((key & 0xff) !== 255) lastAlpha = i;
  }
  let trns: Buffer | null = null;
  let overhead = 12 + plte.length;
  if (lastAlpha >= 0) {
    trns = Buffer.alloc(lastAlpha + 1);
    for (let i = 0; i <= lastAlpha; i++) trns[i] = order[i] & 0xff;
    overhead += 12 + trns.length;
  }
  return { colourType: 3, bpp: 1, rows, plte, trns, overhead };
}

// Build every honest colour layout that fits the image. Palette index
// order matters to the filters: an ordering that keeps similar colours at
// nearby indices leaves smaller residuals, so several orderings compete.
function chooseLayouts(img: DecodedImage): Layout[] {
  const { width, height, rgba } = img;
  const pixels = width * height;
  let alphaOpaque = true;
  let grey = true;
  const seen = new Set<number>();
  const firstOccurrence: number[] = [];
  let tooManyColours = false;
  for (let p = 0; p < pixels; p++) {
    const o = p * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const a = rgba[o + 3];
    if (a !== 255) alphaOpaque = false;
    if (r !== g || g !== b) grey = false;
    if (!tooManyColours) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!seen.has(key)) {
        if (seen.size >= 256) {
          tooManyColours = true;
        } else {
          seen.add(key);
          firstOccurrence.push(key);
        }
      }
    }
  }

  const layouts: Layout[] = [];
  if (!tooManyColours) {
    const byValue = [...firstOccurrence].sort((x, y) => x - y);
    const byAlphaLuma = [...firstOccurrence].sort((x, y) => {
      const ax = x & 0xff;
      const ay = y & 0xff;
      if (ax !== ay) return ax - ay;
      const lx = ((x >>> 24) & 0xff) * 299 + ((x >>> 16) & 0xff) * 587 + ((x >>> 8) & 0xff) * 114;
      const ly = ((y >>> 24) & 0xff) * 299 + ((y >>> 16) & 0xff) * 587 + ((y >>> 8) & 0xff) * 114;
      return lx - ly || x - y;
    });
    layouts.push(paletteLayout(img, firstOccurrence));
    layouts.push(paletteLayout(img, byValue));
    layouts.push(paletteLayout(img, byAlphaLuma));
  }
  if (grey && alphaOpaque) {
    const rows = Buffer.alloc(pixels);
    for (let p = 0; p < pixels; p++) rows[p] = rgba[p * 4];
    layouts.push({ colourType: 0, bpp: 1, rows, plte: null, trns: null, overhead: 0 });
  }
  if (grey && !alphaOpaque) {
    const rows = Buffer.alloc(pixels * 2);
    for (let p = 0; p < pixels; p++) {
      rows[p * 2] = rgba[p * 4];
      rows[p * 2 + 1] = rgba[p * 4 + 3];
    }
    layouts.push({ colourType: 4, bpp: 2, rows, plte: null, trns: null, overhead: 0 });
  }
  if (!grey && alphaOpaque) {
    const rows = Buffer.alloc(pixels * 3);
    for (let p = 0; p < pixels; p++) {
      rows[p * 3] = rgba[p * 4];
      rows[p * 3 + 1] = rgba[p * 4 + 1];
      rows[p * 3 + 2] = rgba[p * 4 + 2];
    }
    layouts.push({ colourType: 2, bpp: 3, rows, plte: null, trns: null, overhead: 0 });
  }
  if (!grey && !alphaOpaque) {
    layouts.push({ colourType: 6, bpp: 4, rows: rgba, plte: null, trns: null, overhead: 0 });
  }
  return layouts;
}

// ---------------------------------------------------------------- filter

// Apply one fixed filter type to every row.
function filterFixed(rows: Buffer, width: number, height: number, bpp: number, filter: number): Buffer {
  const rowBytes = width * bpp;
  const out = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowBytes;
    const prevOff = rowOff - rowBytes;
    const outOff = y * (rowBytes + 1);
    out[outOff] = filter;
    for (let i = 0; i < rowBytes; i++) {
      const x = rows[rowOff + i];
      const a = i >= bpp ? rows[rowOff + i - bpp] : 0;
      const b = y > 0 ? rows[prevOff + i] : 0;
      const c = y > 0 && i >= bpp ? rows[prevOff + i - bpp] : 0;
      let v = x;
      if (filter === 1) v = x - a;
      else if (filter === 2) v = x - b;
      else if (filter === 3) v = x - ((a + b) >> 1);
      else if (filter === 4) v = x - paeth(a, b, c);
      out[outOff + 1 + i] = v & 0xff;
    }
  }
  return out;
}

// Per-row adaptive filtering: for each row, keep the filter whose output
// has the smallest sum of absolute signed byte values (the MSAD heuristic).
function filterAdaptive(rows: Buffer, width: number, height: number, bpp: number): Buffer {
  const rowBytes = width * bpp;
  const out = Buffer.alloc((rowBytes + 1) * height);
  const scratch = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowBytes;
    const prevOff = rowOff - rowBytes;
    const outOff = y * (rowBytes + 1);
    let bestFilter = 0;
    let bestCost = Infinity;
    let bestRow: Buffer | null = null;
    for (let filter = 0; filter <= 4; filter++) {
      let cost = 0;
      for (let i = 0; i < rowBytes; i++) {
        const x = rows[rowOff + i];
        const a = i >= bpp ? rows[rowOff + i - bpp] : 0;
        const b = y > 0 ? rows[prevOff + i] : 0;
        const c = y > 0 && i >= bpp ? rows[prevOff + i - bpp] : 0;
        let v = x;
        if (filter === 1) v = x - a;
        else if (filter === 2) v = x - b;
        else if (filter === 3) v = x - ((a + b) >> 1);
        else if (filter === 4) v = x - paeth(a, b, c);
        const byte = v & 0xff;
        scratch[i] = byte;
        cost += byte < 128 ? byte : 256 - byte;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestFilter = filter;
        bestRow = Buffer.from(scratch);
      }
    }
    out[outOff] = bestFilter;
    (bestRow as Buffer).copy(out, outOff + 1);
  }
  return out;
}

// Per-row adaptive filtering with an entropy estimate instead of MSAD:
// for each row, keep the filter whose output byte histogram has the
// highest sum of c*log2(c), i.e. the lowest estimated bits for the row.
const ENTROPY_TABLE: Float64Array = (() => {
  const table = new Float64Array(8192);
  for (let c = 1; c < table.length; c++) table[c] = c * Math.log2(c);
  return table;
})();

function filterAdaptiveEntropy(rows: Buffer, width: number, height: number, bpp: number): Buffer {
  const rowBytes = width * bpp;
  const out = Buffer.alloc((rowBytes + 1) * height);
  const scratch = Buffer.alloc(rowBytes);
  const hist = new Int32Array(256);
  const touched: number[] = [];
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowBytes;
    const prevOff = rowOff - rowBytes;
    const outOff = y * (rowBytes + 1);
    let bestFilter = 0;
    let bestScore = -Infinity;
    let bestRow: Buffer | null = null;
    for (let filter = 0; filter <= 4; filter++) {
      touched.length = 0;
      for (let i = 0; i < rowBytes; i++) {
        const x = rows[rowOff + i];
        const a = i >= bpp ? rows[rowOff + i - bpp] : 0;
        const b = y > 0 ? rows[prevOff + i] : 0;
        const c = y > 0 && i >= bpp ? rows[prevOff + i - bpp] : 0;
        let v = x;
        if (filter === 1) v = x - a;
        else if (filter === 2) v = x - b;
        else if (filter === 3) v = x - ((a + b) >> 1);
        else if (filter === 4) v = x - paeth(a, b, c);
        const byte = v & 0xff;
        scratch[i] = byte;
        if (hist[byte] === 0) touched.push(byte);
        hist[byte]++;
      }
      let score = 0;
      for (const value of touched) {
        score += ENTROPY_TABLE[hist[value]];
        hist[value] = 0;
      }
      if (score > bestScore) {
        bestScore = score;
        bestFilter = filter;
        bestRow = Buffer.from(scratch);
      }
    }
    out[outOff] = bestFilter;
    (bestRow as Buffer).copy(out, outOff + 1);
  }
  return out;
}

// ---------------------------------------------------------------- encode

function encodePng(img: DecodedImage, layout: Layout, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = layout.colourType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace
  const parts: Buffer[] = [PNG_SIGNATURE, chunk("IHDR", ihdr)];
  if (layout.plte !== null) parts.push(chunk("PLTE", layout.plte));
  if (layout.trns !== null) parts.push(chunk("tRNS", layout.trns));
  parts.push(chunk("IDAT", idat));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function zip(data: Buffer, strategy: number, memLevel?: number): Buffer {
  return deflateSync(data, { level: 9, strategy, memLevel });
}

interface Candidate {
  size: number;
  layout: Layout;
  scan: Buffer;
}

// Phase 1 deflates every filtered variant with the default strategy;
// phase 2 retries the two best scan buffers with the filtered strategy
// and the best one with a larger deflate memory. All choices depend only
// on the input bytes, so the output is deterministic.
function compressInstance(img: DecodedImage): Buffer {
  const { width, height } = img;
  let best: Buffer | null = null;
  const candidates: Candidate[] = [];
  const consider = (layout: Layout, scan: Buffer, strategy: number, memLevel?: number): void => {
    const png = encodePng(img, layout, zip(scan, strategy, memLevel));
    candidates.push({ size: png.length, layout, scan });
    if (best === null || png.length < best.length) best = png;
  };
  for (const layout of chooseLayouts(img)) {
    const small = layout.rows.length <= 1300000;
    consider(layout, filterAdaptive(layout.rows, width, height, layout.bpp), constants.Z_DEFAULT_STRATEGY);
    consider(layout, filterAdaptiveEntropy(layout.rows, width, height, layout.bpp), constants.Z_DEFAULT_STRATEGY);
    consider(layout, filterFixed(layout.rows, width, height, layout.bpp, 4), constants.Z_DEFAULT_STRATEGY);
    consider(layout, filterFixed(layout.rows, width, height, layout.bpp, 2), constants.Z_DEFAULT_STRATEGY);
    if (small) {
      consider(layout, filterFixed(layout.rows, width, height, layout.bpp, 1), constants.Z_DEFAULT_STRATEGY);
      consider(layout, filterFixed(layout.rows, width, height, layout.bpp, 3), constants.Z_DEFAULT_STRATEGY);
      consider(layout, filterFixed(layout.rows, width, height, layout.bpp, 0), constants.Z_DEFAULT_STRATEGY);
    }
  }
  candidates.sort((x, y) => x.size - y.size);
  const tried = new Set<Buffer>();
  let phase2 = 0;
  for (const cand of candidates) {
    if (phase2 >= 2) break;
    if (tried.has(cand.scan)) continue;
    tried.add(cand.scan);
    phase2++;
    const png = encodePng(img, cand.layout, zip(cand.scan, constants.Z_FILTERED));
    if (best === null || png.length < best.length) best = png;
  }
  if (candidates.length > 0) {
    const top = candidates[0];
    const png = encodePng(img, top.layout, zip(top.scan, constants.Z_DEFAULT_STRATEGY, 9));
    if (best === null || png.length < best.length) best = png;
  }
  return best as Buffer;
}

// ---------------------------------------------------------------- main

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const ids = readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const id of ids) {
    const srcPath = join(inputDir, id, "image.png");
    let img: DecodedImage;
    try {
      img = decodePng(readFileSync(srcPath));
    } catch {
      continue; // no readable input for this instance
    }
    const png = compressInstance(img);
    const outDir = join(outputDir, id);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "image.png"), png);
  }
}

main();
