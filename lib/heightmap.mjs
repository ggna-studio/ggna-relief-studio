export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export function rgbaToHeight(rgba) {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = (.2126 * rgba[p] + .7152 * rgba[p + 1] + .0722 * rgba[p + 2]) / 255 * (rgba[p + 3] / 255);
  }
  return out;
}

export function boxBlur(input, width, height, radius) {
  const r = Math.max(0, Math.min(12, Math.round(radius)));
  if (!r) return input.slice();
  const temp = new Float32Array(input.length), out = new Float32Array(input.length), size = 2 * r + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += input[row + clamp(k, 0, width - 1)];
    for (let x = 0; x < width; x++) {
      temp[row + x] = sum / size;
      sum += input[row + clamp(x + r + 1, 0, width - 1)] - input[row + clamp(x - r, 0, width - 1)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += temp[clamp(k, 0, height - 1) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / size;
      sum += temp[clamp(y + r + 1, 0, height - 1) * width + x] - temp[clamp(y - r, 0, height - 1) * width + x];
    }
  }
  return out;
}

export function processHeight(input, width, height, settings = {}) {
  const { black = 0, white = 100, gamma = 1, smooth = 0, invert = false } = settings;
  const low = clamp(Number(black) / 100), high = Math.max(low + .001, clamp(Number(white) / 100));
  const g = clamp(Number(gamma) || 1, .2, 4);
  const out = boxBlur(input, width, height, smooth);
  for (let i = 0; i < out.length; i++) {
    const v = Math.pow(clamp((out[i] - low) / (high - low)), 1 / g);
    out[i] = invert ? 1 - v : v;
  }
  return out;
}

export function resample(input, width, height, outW, outH) {
  if (outW === width && outH === height) return input;
  const out = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const sy = (outH === 1 ? 0 : y / (outH - 1)) * (height - 1), y0 = Math.floor(sy), y1 = Math.min(y0 + 1, height - 1), fy = sy - y0;
    for (let x = 0; x < outW; x++) {
      const sx = (outW === 1 ? 0 : x / (outW - 1)) * (width - 1), x0 = Math.floor(sx), x1 = Math.min(x0 + 1, width - 1), fx = sx - x0;
      out[y * outW + x] = (input[y0 * width + x0] * (1 - fx) + input[y0 * width + x1] * fx) * (1 - fy)
        + (input[y1 * width + x0] * (1 - fx) + input[y1 * width + x1] * fx) * fy;
    }
  }
  return out;
}

export function grayPixels(data) {
  const rgba = new Uint8ClampedArray(data.length * 4);
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(clamp(data[i]) * 255), p = i * 4;
    rgba[p] = rgba[p + 1] = rgba[p + 2] = v; rgba[p + 3] = 255;
  }
  return rgba;
}

export function histogram(data, bins = 64) {
  const counts = new Uint32Array(bins);
  for (let i = 0; i < data.length; i++) counts[Math.min(bins - 1, Math.floor(clamp(data[i]) * bins))]++;
  return Array.from(counts);
}

export function encodeBMP(data, width, height) {
  const stride = Math.ceil(width / 4) * 4, offset = 14 + 40 + 256 * 4;
  const bytes = new Uint8Array(offset + stride * height), view = new DataView(bytes.buffer);
  bytes[0] = 66; bytes[1] = 77;
  view.setUint32(2, bytes.length, true); view.setUint32(10, offset, true);
  view.setUint32(14, 40, true); view.setInt32(18, width, true); view.setInt32(22, height, true);
  view.setUint16(26, 1, true); view.setUint16(28, 8, true);
  view.setUint32(34, stride * height, true); view.setUint32(46, 256, true);
  for (let i = 0; i < 256; i++) { const p = 54 + i * 4; bytes[p] = bytes[p + 1] = bytes[p + 2] = i; }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes[offset + (height - 1 - y) * stride + x] = Math.round(clamp(data[y * width + x]) * 255);
  return bytes;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
  v.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < out.length - 4; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ (crc >>> 8);
  v.setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0);
  return out;
}

export async function encodePNG(data, width, height, depth = 16) {
  if (![8, 16].includes(depth)) throw new Error('Unsupported bit depth');
  const bpp = depth / 8, stride = width * bpp + 1, raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * stride + 1 + x * bpp, val = Math.round(clamp(data[y * width + x]) * (depth === 16 ? 65535 : 255));
    if (depth === 16) { raw[p] = val >>> 8; raw[p + 1] = val & 255; } else raw[p] = val;
  }
  const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height); ihdr[8] = depth;
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(chunks.reduce((n, a) => n + a.length, 0)); let offset = 0;
  for (const a of chunks) { out.set(a, offset); offset += a.length; }
  return out;
}

// Read non-interlaced grayscale 16-bit PNG without passing through an 8-bit canvas.
export async function decodeGray16PNG(buffer) {
  const a = new Uint8Array(buffer), v = new DataView(buffer);
  if (a.length < 33 || v.getUint32(0) !== 0x89504e47 || v.getUint32(4) !== 0x0d0a1a0a) return null;
  if (a[24] !== 16) return null;
  if (a[25] !== 0 || a[28] !== 0) throw new Error('PNG 16-bit cần là ảnh xám một kênh, không interlace. Hãy xuất grayscale PNG trước khi mở.');
  const width = v.getUint32(16), height = v.getUint32(20);
  if (!width || !height || width * height > 16777216) throw new Error('PNG 16-bit tối đa 16 triệu pixel.');
  const parts = [];
  for (let p = 8; p + 12 <= a.length;) {
    const size = v.getUint32(p); if (p + 12 + size > a.length) throw new Error('PNG không hợp lệ.');
    if (v.getUint32(p + 4) === 0x49444154) parts.push(a.slice(p + 8, p + 8 + size));
    p += 12 + size;
  }
  const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader(), expected = (width * 2 + 1) * height;
  const raw = new Uint8Array(expected); let cursor = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; if (cursor + value.length > expected) { await reader.cancel(); throw new Error('Dữ liệu PNG vượt kích thước khai báo.'); } raw.set(value, cursor); cursor += value.length; }
  if (cursor !== expected) throw new Error('PNG bị thiếu dữ liệu.');
  const rows = new Uint8Array(width * 2 * height), stride = width * 2;
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('PNG filter không hợp lệ.');
    for (let x = 0; x < stride; x++) {
      const p = y * stride + x, left = x >= 2 ? rows[p - 2] : 0, up = y ? rows[p - stride] : 0, ul = y && x >= 2 ? rows[p - stride - 2] : 0;
      rows[p] = (raw[y * (stride + 1) + x + 1] + [0, left, up, Math.floor((left + up) / 2), paeth(left, up, ul)][filter]) & 255;
    }
  }
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = ((rows[i * 2] << 8) | rows[i * 2 + 1]) / 65535;
  return { data, width, height, depth: 16 };
}
