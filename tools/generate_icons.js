#!/usr/bin/env node
/**
 * Generates the extension icons (icons/icon16.png, icon48.png, icon128.png).
 *
 * Pure node: only fs, path and zlib. Contains a tiny PNG encoder (signature,
 * IHDR/IDAT/IEND chunks, CRC32) and a signed-distance-field rasteriser with
 * 4x4 supersampling for smooth edges.
 *
 * Motif: dark rounded square, a cyan lens ring and a white play triangle.
 *
 * Usage: node tools/generate_icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// PNG encoder
// ---------------------------------------------------------------------------

const CRC_TABLE = (function buildCrcTable() {
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

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encodes an RGBA pixel buffer (width*height*4 bytes) as a PNG file buffer. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline is prefixed with filter type 0 (None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Rasteriser (coordinates are normalised to the 0..1 square)
// ---------------------------------------------------------------------------

const BG_TOP = [17, 24, 39]; // #111827
const BG_BOTTOM = [30, 27, 75]; // #1e1b4b
const RING = [34, 211, 238]; // #22d3ee
const PLAY = [255, 255, 255];

/** Signed distance to a rounded square centred at (0.5, 0.5). Negative = inside. */
function sdRoundedSquare(x, y, half, radius) {
  const qx = Math.abs(x - 0.5) - (half - radius);
  const qy = Math.abs(y - 0.5) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

/** Signed distance to a triangle (standard 2D SDF). */
function sdTriangle(px, py, a, b, c) {
  const e0 = [b[0] - a[0], b[1] - a[1]];
  const e1 = [c[0] - b[0], c[1] - b[1]];
  const e2 = [a[0] - c[0], a[1] - c[1]];
  const v0 = [px - a[0], py - a[1]];
  const v1 = [px - b[0], py - b[1]];
  const v2 = [px - c[0], py - c[1]];
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
  const pq = (v, e) => {
    const t = clamp01(dot(v, e) / dot(e, e));
    return [v[0] - e[0] * t, v[1] - e[1] * t];
  };
  const p0 = pq(v0, e0);
  const p1 = pq(v1, e1);
  const p2 = pq(v2, e2);
  const s = Math.sign(e0[0] * e2[1] - e0[1] * e2[0]);
  const d0 = [dot(p0, p0), s * (v0[0] * e0[1] - v0[1] * e0[0])];
  const d1 = [dot(p1, p1), s * (v1[0] * e1[1] - v1[1] * e1[0])];
  const d2 = [dot(p2, p2), s * (v2[0] * e2[1] - v2[1] * e2[0])];
  const dx = Math.min(d0[0], d1[0], d2[0]);
  const dy = Math.min(d0[1], d1[1], d2[1]);
  return -Math.sqrt(dx) * Math.sign(dy);
}

const TRI_A = [0.42, 0.34];
const TRI_B = [0.42, 0.66];
const TRI_C = [0.68, 0.5];

/** Returns [r, g, b, a] (0..255, non-premultiplied) for one sample point. */
function samplePoint(x, y) {
  if (sdRoundedSquare(x, y, 0.5, 0.22) > 0) return [0, 0, 0, 0];

  // Vertical gradient background.
  let r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * y;
  let g = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * y;
  let b = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * y;

  // Lens ring.
  const ringDist = Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.33) - 0.05;
  if (ringDist <= 0) {
    r = RING[0];
    g = RING[1];
    b = RING[2];
  }

  // Play triangle (slightly rounded by inflating the SDF).
  if (sdTriangle(x, y, TRI_A, TRI_B, TRI_C) - 0.02 <= 0) {
    r = PLAY[0];
    g = PLAY[1];
    b = PLAY[2];
  }
  return [r, g, b, 255];
}

function renderIcon(size) {
  const SS = 4; // 4x4 supersampling
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const [r, g, b, a] = samplePoint(x, y);
          // Accumulate premultiplied colour so transparent corners blend correctly.
          sr += r * a;
          sg += g * a;
          sb += b * a;
          sa += a;
        }
      }
      const o = (py * size + px) * 4;
      if (sa > 0) {
        rgba[o] = Math.round(sr / sa);
        rgba[o + 1] = Math.round(sg / sa);
        rgba[o + 2] = Math.round(sb / sa);
        rgba[o + 3] = Math.round(sa / (SS * SS));
      }
    }
  }
  return encodePng(size, size, rgba);
}

function main() {
  const outDir = path.join(__dirname, '..', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  [16, 48, 128].forEach((size) => {
    const file = path.join(outDir, `icon${size}.png`);
    fs.writeFileSync(file, renderIcon(size));
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  });
}

if (require.main === module) main();

module.exports = { encodePng, crc32, renderIcon };
