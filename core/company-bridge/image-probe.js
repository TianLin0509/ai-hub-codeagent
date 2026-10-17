'use strict';
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 20000000;
function probeImage(b) {
  if (!Buffer.isBuffer(b) || b.length < 24 || b.length > MAX_SOURCE_BYTES) throw new Error('图片大小无效（最大 16 MB）');
  let format, width, height;
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii', 12, 16) === 'IHDR') {
    format = 'png'; width = b.readUInt32BE(16); height = b.readUInt32BE(20);
    for (let p = 8; p + 12 <= b.length;) {
      const n = b.readUInt32BE(p), tag = b.toString('ascii', p + 4, p + 8);
      if (tag === 'acTL') throw new Error('只支持静态图片，不支持动画');
      if (p + 12 + n > b.length) throw new Error('PNG 图片不完整');
      p += 12 + n;
    }
  } else if (b[0] === 255 && b[1] === 216) {
    format = 'jpeg';
    for (let p = 2; p + 3 < b.length;) {
      if (b[p++] !== 255) throw new Error('JPEG 图片格式无效');
      while (b[p] === 255) p++;
      const tag = b[p++];
      if (tag === 218 || tag === 217) break;
      if (tag === 1 || (tag >= 208 && tag <= 215)) continue;
      const n = b.readUInt16BE(p);
      if (n < 2 || p + n > b.length) throw new Error('JPEG 图片不完整');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(tag)) {
        if (n < 8) throw new Error('JPEG 图片尺寸无效');
        height = b.readUInt16BE(p + 3); width = b.readUInt16BE(p + 5); break;
      }
      p += n;
    }
  } else if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    format = 'webp';
    if (b.readUInt32LE(4) + 8 !== b.length) throw new Error('WebP 图片不完整');
    const tag = b.toString('ascii', 12, 16);
    if (tag === 'VP8X' && b.length >= 30) {
      if (b[20] & 2) throw new Error('只支持静态图片，不支持动画');
      width = 1 + b.readUIntLE(24, 3); height = 1 + b.readUIntLE(27, 3);
    } else if (tag === 'VP8 ' && b.length >= 30 && b[23] === 157 && b[24] === 1 && b[25] === 42) {
      width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff;
    } else if (tag === 'VP8L' && b[20] === 47) {
      const bits = b.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  } else throw new Error('只支持真实的 PNG、JPEG、WebP 静态图片');
  if (!width || !height || width > 16000 || height > 16000 || width * height > MAX_PIXELS) throw new Error('图片尺寸无效或超过 2000 万像素');
  return { format, width, height };
}
module.exports = { probeImage, MAX_SOURCE_BYTES, MAX_PIXELS };
