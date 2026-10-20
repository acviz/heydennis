// Renders the app icon (build/icon.png, 1024x1024) procedurally - no image
// tools needed. electron-builder turns it into .ico / .icns when packaging.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const N = 1024, C = N / 2;
const px = Buffer.alloc(N * N * 4);
const clamp = (v) => Math.max(0, Math.min(1, v));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const band = (d, r, w) => 1 - smooth(w * 0.5, w * 0.5 + 2.5, Math.abs(d - r)); // anti-aliased ring

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const dx = x - C + 0.5, dy = y - C + 0.5, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    // rounded-square tile
    const q = Math.max(Math.abs(dx), Math.abs(dy)), rr = 200, inner = C - 24;
    const corner = Math.hypot(Math.max(0, Math.abs(dx) - (inner - rr)), Math.max(0, Math.abs(dy) - (inner - rr)));
    const tile = q < inner - rr ? 1 : 1 - smooth(rr - 2, rr + 1, corner);
    let r = 2 / 255, g = 6 / 255, b = 11 / 255;
    const add = (k, cr, cg, cb) => { r += k * cr; g += k * cg; b += k * cb; };
    add(Math.exp(-((d / 300) ** 2)) * 0.55, 0.37, 0.95, 1); // glow
    add(Math.exp(-((d / 95) ** 2)) * 1.2, 0.85, 1, 1); // hot core
    const seg = Math.sin(a * 12) > -0.2 ? 1 : 0; // dashed reactor ring
    add(band(d, 330, 26) * seg, 0.37, 0.95, 1);
    add(band(d, 400, 9) * 0.7, 0.37, 0.95, 1);
    add(band(d, 250, 14) * 0.9, 0.6, 0.98, 1);
    add(1 - smooth(70, 76, d), 0.92, 1, 1);
    const i = (y * N + x) * 4;
    px[i] = Math.round(clamp(r) * 255);
    px[i + 1] = Math.round(clamp(g) * 255);
    px[i + 2] = Math.round(clamp(b) * 255);
    px[i + 3] = Math.round(tile * 255);
  }
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const v of buf) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "build", "icon.png"), png(N, N, px));
console.log("wrote build/icon.png");
