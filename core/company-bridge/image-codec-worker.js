'use strict';
// 沙箱中的 Chromium 编解码器。无网络、无 Node、无剪贴板；窗口仅处理本机传来的字节。
window.processBridgeImage = async ({ base64, maxBytes, allowResize, validateOnly }) => {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const source = await createImageBitmap(new Blob([bytes]));
  try {
    const originalWidth = source.width, originalHeight = source.height;
    if (originalWidth * originalHeight > 20000000) throw new Error('图片超过 2000 万像素');
    if (validateOnly) return { width: originalWidth, height: originalHeight };
    const canvas = document.createElement('canvas');
    const encoded = (type, quality) => new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片编码失败')), type, quality));
    const scales = allowResize ? [1, .8, .64, .512, .4096, .32768, .262144] : [1];
    for (const scale of scales) {
      const width = Math.max(1, Math.round(originalWidth * scale)), height = Math.max(1, Math.round(originalHeight * scale));
      if (scale < 1 && Math.max(width, height) < 256) break;
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, width, height);
      let chosen = await encoded('image/png'), quality = null, format = 'png';
      if (chosen.size > maxBytes) {
        chosen = null; format = 'webp';
        let low = .72, high = .95;
        const floor = await encoded('image/webp', low);
        if (floor.type !== 'image/webp') throw new Error('当前 Chromium 不支持 WebP 编码');
        if (floor.size <= maxBytes) {
          chosen = floor; quality = low;
          for (let i = 0; i < 6; i++) {
            const q = (low + high) / 2, candidate = await encoded('image/webp', q);
            if (candidate.size <= maxBytes) { chosen = candidate; quality = q; low = q; } else high = q;
          }
        }
      }
      if (chosen && chosen.size <= maxBytes) {
        const output = new Uint8Array(await chosen.arrayBuffer());
        let binary = ''; for (let i = 0; i < output.length; i += 8192) binary += String.fromCharCode(...output.subarray(i, i + 8192));
        return { base64: btoa(binary), format, width, height, originalWidth, originalHeight, lossy: format === 'webp', quality, resized: scale !== 1 };
      }
    }
    throw new Error(allowResize ? '缩放后仍不能在合理质量下满足 60KB 消息限制，请先裁出需要分析的区域' : '保留分辨率时无法满足 60KB 消息限制；可先裁图，或明确允许缩小分辨率');
  } finally { source.close(); }
};
