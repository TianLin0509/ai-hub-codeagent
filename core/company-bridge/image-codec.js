'use strict';
const path = require('node:path');
const { probeImage } = require('./image-probe');
let queue = Promise.resolve();
function createImageCodec() {
  const run = (buffer, options) => {
    probeImage(buffer);
    const job = queue.then(async () => {
      const { BrowserWindow, app } = require('electron');
      if (!app?.isReady()) throw new Error('图片处理需要已启动的 Hub');
      const win = new BrowserWindow({ show: false, skipTaskbar: true, width: 32, height: 32,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'bridge-image-codec' } });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      let timer;
      try {
        const operation = (async () => {
          await win.loadFile(path.join(__dirname, 'image-codec.html'));
          return win.webContents.executeJavaScript(`window.processBridgeImage(${JSON.stringify({ base64: buffer.toString('base64'), ...options })})`);
        })();
        const result = await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('本机图片处理超过 30 秒，请缩小图片后重试')), 30000); })]);
        if (result.base64) { result.buffer = Buffer.from(result.base64, 'base64'); delete result.base64; probeImage(result.buffer); }
        return result;
      } finally { clearTimeout(timer); if (!win.isDestroyed()) win.destroy(); }
    });
    queue = job.catch(() => {});
    return job;
  };
  return { compress: (buffer, options = {}) => run(buffer, { maxBytes: 43000, allowResize: false, ...options }), validate: buffer => run(buffer, { validateOnly: true }) };
}
module.exports = { createImageCodec };
