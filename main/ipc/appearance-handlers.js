'use strict';
const { createAppearanceStore, readJson } = require('../../core/appearance-packs');
function registerAppearanceIpc(ipcMain, { dataDir, sendToRenderer = () => {}, env = process.env, electron = require('electron') }) {
  let sources;
  if (env.AI_HUB_APPEARANCE_SOURCES) sources = JSON.parse(env.AI_HUB_APPEARANCE_SOURCES);
  const store = createAppearanceStore({ dataDir, ...(sources ? { sources } : {}),
    ...(env.AI_HUB_APPEARANCE_LIBRARY ? { bundledDir: env.AI_HUB_APPEARANCE_LIBRARY } : {}),
    fetchImpl: (...args) => electron.net.fetch(...args), emit: sendToRenderer,
    decodeImage: data => {
      const image = electron.nativeImage.createFromDataURL(data);
      const size = image.getSize();
      if (image.isEmpty() || !size.width || !size.height || size.width > 2048 || size.height > 2048) throw new Error('头像图片损坏或尺寸超限，原有头像保持不变');
    } });
  ipcMain.handle('appearance:get', () => store.snapshot());
  ipcMain.handle('appearance:save', (_e, prefs) => store.savePreferences(prefs));
  ipcMain.handle('appearance:check', () => store.check());
  ipcMain.handle('appearance:download', (_e, id) => store.download(id));
  ipcMain.handle('appearance:cancel', () => store.cancel());
  ipcMain.handle('appearance:import', async () => {
    const pick = await electron.dialog.showOpenDialog({ title: '导入头像包', properties: ['openFile'], filters: [{ name: 'AI Hub 头像包', extensions: ['json'] }] });
    if (pick.canceled) return null;
    return store.install(readJson(pick.filePaths[0]));
  });
  ipcMain.handle('appearance:upload', async (_e, input) => {
    // The renderer sends only the selected file bytes, never an arbitrary filesystem path.
    if (!(input instanceof Uint8Array) || input.byteLength > 8 * 1024 * 1024) throw new Error('请选择不超过 8 MB 的图片');
    const raw = Buffer.from(input);
    if (!(raw[0] === 137 && raw[1] === 80 || raw[0] === 255 && raw[1] === 216 || raw.toString('ascii', 0, 4) === 'RIFF')) throw new Error('支持 PNG、JPEG 和 WebP 图片');
    const image = electron.nativeImage.createFromBuffer(raw);
    if (image.isEmpty()) throw new Error('图片无法读取，请换一张');
    const size = image.getSize();
    if (size.width > 8192 || size.height > 8192) throw new Error('图片边长不能超过 8192 像素');
    const edge = Math.min(size.width, size.height);
    const cropped = image.crop({ x: Math.floor((size.width - edge) / 2), y: Math.floor((size.height - edge) / 2), width: edge, height: edge }).resize({ width: 384, height: 384, quality: 'best' });
    return store.saveCustom(cropped.toDataURL());
  });
  return store;
}
module.exports = { registerAppearanceIpc };
