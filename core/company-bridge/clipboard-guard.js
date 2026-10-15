'use strict';
// 发给 CodeAgent 前，把剪贴板里的图片暂时拿开，发完放回（2026-10-15）。
// 公司真机：Hub 用终端粘贴把问题送进 CodeAgent，当时剪贴板里正好有一张图片，CodeAgent 收到的就成了那张图片，
// 家里的问题没进去（Q-1015-03 第 4 轮）。发送期间剪贴板是空的；用户这期间另外复制了东西，就不覆盖。
const IMAGE_FORMAT = /^image\/|png|bitmap|dib|jpe?g/i;

function hasImage(clipboard) {
  try { return clipboard.availableFormats().some(f => IMAGE_FORMAT.test(f)); } catch { return false; }
}

async function withImageAside(clipboard, fn) {
  let image = null;
  if (clipboard && hasImage(clipboard)) {
    try {
      const read = clipboard.readImage();
      if (read && !read.isEmpty()) { image = read; clipboard.clear(); }
    } catch { image = null; }
  }
  try { return await fn(); } finally {
    if (image) {
      try { if (!clipboard.availableFormats().length) clipboard.writeImage(image); } catch {}
    }
  }
}

module.exports = { withImageAside, hasImage };
