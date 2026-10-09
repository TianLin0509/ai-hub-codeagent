'use strict';
// Hub 进程内的离屏抓帧：隐藏的离屏窗口加载视频模板，逐帧渲染后截图。
// 不联网、不开可见窗口；窗口只在制作视频时存在，结束即销毁。
const { TEMPLATE, W, H } = require('./vibe-renderer');

function electronCapture({ electron = require('electron') } = {}) {
  let win = null;
  return {
    async open(spec) {
      win = new electron.BrowserWindow({
        show: false, width: W, height: H, useContentSize: true, frame: false, skipTaskbar: true,
        webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, javascript: true },
      });
      win.webContents.setAudioMuted(true);
      // 模板是本地静态文件，不允许跳转到别处。
      win.webContents.on('will-navigate', e => e.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await win.loadFile(TEMPLATE);
      await win.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
      return win.webContents.executeJavaScript(`window.__init(${JSON.stringify(spec)})`);
    },
    async frame(t) {
      await win.webContents.executeJavaScript(`window.__frame(${Number(t).toFixed(4)})`);
      let img = await win.webContents.capturePage();
      const size = img.getSize();
      if (size.width !== W || size.height !== H) img = img.resize({ width: W, height: H, quality: 'best' });
      return img.toJPEG(90);
    },
    async close() { if (win && !win.isDestroyed()) win.destroy(); win = null; },
  };
}
module.exports = { electronCapture };
