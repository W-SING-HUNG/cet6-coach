#!/usr/bin/env node
/**
 * 图标生成器 —— 零依赖。
 *
 * 为什么手写 PNG 编码：
 * - 项目不能使用来源不明的素材，必须自绘。
 * - 引入 sharp / canvas 会带来原生编译依赖，与本项目"零原生依赖"的取向冲突。
 * 几何图形用纯像素计算 + 内置 zlib 生成，可复现、可 diff、可 review。
 *
 * 视觉：纸底 + 墨色横线（呼应产品里的分隔线语言），其中一条为强调绿。
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "public", "icons");

const PAPER = [247, 244, 238];
const INK = [27, 26, 23];
const ACCENT = [31, 92, 74];

// --- PNG 编码 ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([length, payload, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前置一个 filter byte (0 = None)
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- 几何绘制 ---------------------------------------------------------------

/** 圆角矩形内部判定，坐标为 0..1 归一化空间。 */
function insideRoundRect(x, y, left, top, w, h, r) {
  if (x < left || x > left + w || y < top || y > top + h) return false;
  const cx = Math.min(Math.max(x, left + r), left + w - r);
  const cy = Math.min(Math.max(y, top + r), top + h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * 绘制图标。
 * @param size 边长
 * @param maskable maskable 图标需要内容更靠内，并把背景铺满到边缘
 */
function render(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3; // 每像素 3x3 超采样，得到平滑边缘
  const radius = maskable ? 0 : 0.21;
  const scale = maskable ? 0.62 : 0.78; // maskable 内容收进安全区
  const offset = (1 - scale) / 2;

  // 横线：宽度比例、纵向位置
  const bars = [
    { w: 0.66, y: 0.16, accent: false },
    { w: 0.52, y: 0.34, accent: false },
    { w: 0.62, y: 0.52, accent: false },
    { w: 0.38, y: 0.70, accent: true },
  ];
  const barH = 0.105;
  const barLeft = 0.17;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;

          // 背景：圆角纸面（maskable 时铺满整块）
          let color = null;
          if (insideRoundRect(x, y, 0, 0, 1, 1, radius)) {
            color = PAPER;
          }

          // 前景横线
          if (color) {
            for (const bar of bars) {
              const left = offset + barLeft * scale;
              const top = offset + bar.y * scale;
              const w = bar.w * scale;
              const h = barH * scale;
              const r = h / 2;
              if (insideRoundRect(x, y, left, top, w, h, r)) {
                color = bar.accent ? ACCENT : INK;
                break;
              }
            }
          }

          if (color) {
            rSum += color[0];
            gSum += color[1];
            bSum += color[2];
            aSum += 255;
          }
        }
      }

      const total = SS * SS;
      const idx = (py * size + px) * 4;
      const alpha = aSum / total;
      // 未覆盖的采样点按透明处理，颜色按覆盖比例归一，避免边缘发暗
      const coverage = aSum / (255 * total);
      rgba[idx] = coverage > 0 ? Math.round(rSum / (coverage * total)) : 0;
      rgba[idx + 1] = coverage > 0 ? Math.round(gSum / (coverage * total)) : 0;
      rgba[idx + 2] = coverage > 0 ? Math.round(bSum / (coverage * total)) : 0;
      rgba[idx + 3] = Math.round(alpha);
    }
  }

  return encodePng(size, size, rgba);
}

/** ICO 容器（内嵌 PNG，现代浏览器与 Windows 均支持）。 */
function encodeIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0; // palette colors
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset to data

  return Buffer.concat([header, entry, pngBuffer]);
}

// --- 产出 -------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  { file: "icon-192.png", buf: render(192, false) },
  { file: "icon-512.png", buf: render(512, false) },
  { file: "icon-maskable-512.png", buf: render(512, true) },
  { file: "apple-touch-icon.png", buf: render(180, false) },
];

for (const { file, buf } of outputs) {
  const target = join(OUT_DIR, file);
  writeFileSync(target, buf);
  console.log(`✓ ${file.padEnd(24)} ${(buf.length / 1024).toFixed(1)} KB`);
}

const faviconPng = render(32, false);
const faviconIco = encodeIco(faviconPng, 32);
writeFileSync(join(HERE, "..", "public", "favicon.ico"), faviconIco);
console.log(`✓ favicon.ico              ${(faviconIco.length / 1024).toFixed(1)} KB`);

console.log("\n图标已生成到 public/ 与 public/icons/");
