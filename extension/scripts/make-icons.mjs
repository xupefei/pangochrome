// Writes the extension icons as PNG files. Uses only Node built-ins.
// The icon is a blue rounded square with a white padlock.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLES = 4;
const CORNER_RADIUS = 0.2;
const BLUE = [0x4c, 0x78, 0xc6];
const WHITE = [0xff, 0xff, 0xff];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function main() {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "icons");
  mkdirSync(outDir, { recursive: true });
  for (const size of SIZES) {
    const file = join(outDir, `icon-${size}.png`);
    writeFileSync(file, encodePng(size, renderIcon(size)));
    console.log(file);
  }
}

/** Returns RGBA pixels. Each pixel averages its supersamples and gets coverage as alpha. */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLES * SUPERSAMPLES;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLES; sy++) {
        for (let sx = 0; sx < SUPERSAMPLES; sx++) {
          const u = (x + (sx + 0.5) / SUPERSAMPLES) / size;
          const v = (y + (sy + 0.5) / SUPERSAMPLES) / size;
          const color = colorAt(u, v);
          if (color === null) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          covered += 1;
        }
      }
      if (covered === 0) continue;
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(r / covered);
      pixels[offset + 1] = Math.round(g / covered);
      pixels[offset + 2] = Math.round(b / covered);
      pixels[offset + 3] = Math.round((covered / samples) * 255);
    }
  }
  return pixels;
}

/** Coordinates run from 0 to 1. Returns null outside the icon. */
function colorAt(u, v) {
  if (!inRoundedSquare(u, v)) return null;
  if (inKeyhole(u, v)) return BLUE;
  if (inPadlock(u, v)) return WHITE;
  return BLUE;
}

function inRoundedSquare(u, v) {
  const r = CORNER_RADIUS;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

function inPadlock(u, v) {
  const shackle =
    v <= 0.46 && (u - 0.5) ** 2 + (v - 0.46) ** 2 <= 0.2 ** 2 && (u - 0.5) ** 2 + (v - 0.46) ** 2 >= 0.125 ** 2;
  const body = u >= 0.26 && u <= 0.74 && v >= 0.46 && v <= 0.86;
  return shackle || body;
}

function inKeyhole(u, v) {
  const circle = (u - 0.5) ** 2 + (v - 0.62) ** 2 <= 0.06 ** 2;
  const slot = u >= 0.475 && u <= 0.525 && v >= 0.62 && v <= 0.72;
  return circle || slot;
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0: no filter
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

main();
