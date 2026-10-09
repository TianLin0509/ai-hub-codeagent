'use strict';
// 助理回复里引用了本机的 HTML 报告时，把它渲染成手机宽度的长图发给手机（手机直接看图，点开可放大）。
// 平时回复只发 Markdown 文字，不再自动截图（2026-10-04 用户：大部分对话文字就够，截图多余）。
const fs = require('node:fs'), path = require('node:path');
const WIDTH = 430, SCALE = 2, SEGMENT = 1600, MAX_SEGMENTS = 6;

// 回复中指向 HTML 文件的 Markdown 链接或裸路径；只认允许目录内真实存在的文件。
function answerHtmlFiles(text, { roots = [] } = {}) {
  const found = [], seen = new Set();
  const candidates = [...String(text).matchAll(/\[([^\]]*)\]\(<?([^)>]+?\.html?)>?\)/gi)].map(m => ({ caption: m[1], file: m[2] }))
    .concat([...String(text).matchAll(/(?:^|[\s`「（(])([A-Za-z]:[\\/][^\s`」）)]+?\.html?)(?=$|[\s`」）)，。；])/gim)].map(m => ({ caption: '', file: m[1] })));
  for (const c of candidates) {
    const file = c.file.replace(/^file:\/\/\/?/i, '');
    if (!path.isAbsolute(file) || !fs.existsSync(file)) continue;
    const real = fs.realpathSync(file);
    if (seen.has(real)) continue;
    const inside = roots.some(root => { try { const rel = path.relative(fs.realpathSync(root), real); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); } catch { return false; } });
    if (!inside || fs.statSync(real).size > 20 * 1024 * 1024) continue;
    seen.add(real); found.push({ file: real, caption: c.caption || path.basename(real) });
  }
  return found.slice(0, 2);
}

// 以手机宽度加载网页（离线、无 Node 权限），等内容稳定后分段截长图。
async function renderHtml({ BrowserWindow }, file) {
  const win = new BrowserWindow({ show: false, frame: false, useContentSize: true, width: WIDTH, height: SEGMENT, skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, zoomFactor: 1, offscreen: false } });
  const images = [];
  try {
    win.webContents.setZoomFactor(1);
    await win.loadFile(file);
    await win.webContents.insertCSS('::-webkit-scrollbar{display:none!important}html,body{scrollbar-width:none!important}');
    await new Promise(r => setTimeout(r, 900));
    // 先把窗口压矮再量高度：页面常设「至少一屏高」，按高窗口量会把大片空白也截进去。
    win.setContentSize(WIDTH, 120); await new Promise(r => setTimeout(r, 200));
    const height = Math.max(160, Math.min(SEGMENT * MAX_SEGMENTS, await win.webContents.executeJavaScript('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))')));
    for (let top = 0; top < height; top += SEGMENT) {
      const h = Math.min(SEGMENT, height - top);
      if (h < 60 && top > 0) break; // 末尾零头不单独成图
      win.setContentSize(WIDTH, h);
      await win.webContents.executeJavaScript(`scrollTo(0, ${top})`);
      await new Promise(r => setTimeout(r, 150));
      const shot = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: h });
      // 统一缩放到手机两倍宽（系统缩放可能让原图很宽），JPEG 体积小、手机照常显示。
      images.push((shot.getSize().width !== WIDTH * SCALE ? shot.resize({ width: WIDTH * SCALE, quality: 'good' }) : shot).toJPEG(82));
    }
  } finally { win.destroy(); }
  return images;
}
module.exports = { answerHtmlFiles, renderHtml };
