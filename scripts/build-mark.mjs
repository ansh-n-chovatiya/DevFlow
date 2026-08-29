/**
 * Generates extension PNG icons from the FlowSnap mark geometry.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/icons');

/** Coordinate viewport size and corner radius. */
const VIEW = 20;
const RADIUS = 6;

/** Polygon vertices representing the central bolt mark. */
const BOLT = [
  [11.4, 3.4],
  [5.9, 11],
  [9.1, 11],
  [8.6, 16.6],
  [14.1, 9],
  [10.9, 9],
];

/** Plate and bolt RGB colors for toolbar contrast. */
const PLATE = [0x2b, 0xb3, 0xa3];
const BOLT_COLOUR = [0x04, 0x21, 0x1e];

/** Subsamples per axis for anti-aliasing. */
const SS = 4;

function insideRoundedRect(x, y) {
  const near = (v) => Math.min(v, VIEW - v);
  const dx = near(x);
  const dy = near(y);
  if (dx < 0 || dy < 0) return false;

  if (dx >= RADIUS || dy >= RADIUS) return true;
  return (RADIUS - dx) ** 2 + (RADIUS - dy) ** 2 <= RADIUS ** 2;
}

/** Point-in-polygon test for bolt geometry. */
function insidePolygon(points, x, y) {
  let inside = false;

  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }

  return inside;
}

/** Rasterizes the icon at the specified size with anti-aliasing. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = VIEW / (size * SS);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * scale;
          const y = (py * SS + sy + 0.5) * scale;

          if (!insideRoundedRect(x, y)) continue;

          const colour = insidePolygon(BOLT, x, y) ? BOLT_COLOUR : PLATE;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          hits += 1;
        }
      }

      const at = (py * size + px) * 4;
      if (hits === 0) continue;

      pixels[at] = Math.round(r / hits);
      pixels[at + 1] = Math.round(g / hits);
      pixels[at + 2] = Math.round(b / hits);
      pixels[at + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }

  return pixels;
}

/* --- PNG Encoding --- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

/** Encodes raw RGBA pixel data into a PNG buffer. */
function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8-bit depth
  header[9] = 6; // RGBA color type

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const from = y * size * 4;
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, from, from + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --- File Output --- */

mkdirSync(outDir, { recursive: true });

/** Target icon dimensions in pixels. */
const SIZES = [16, 32, 48, 128];

for (const size of SIZES) {
  const file = resolve(outDir, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`mark: wrote ${size}×${size} to public/icons/icon${size}.png`);
}
