'use strict';
const path = require('node:path');

function createPptHandlers(service) {
  return {
    'ppt-status': async () => ({ ok: true, ppt: await service.ppt.refresh({ force: true }) }),
    'ppt-index': () => ({ ok: true, ppt: service.ppt.startIndex() }),
    'ppt-pick-folders': async () => {
      const { dialog } = require('electron');
      const selected = await dialog.showOpenDialog({ title: '选择 1–3 个 PPT 素材文件夹', properties: ['openDirectory', 'multiSelections'] });
      if (selected.canceled || !selected.filePaths.length) return { ok: true, canceled: true };
      const roots = [...new Set(selected.filePaths.map(p => path.resolve(p)))];
      if (roots.length > 3) throw new Error('最多选择 3 个素材文件夹，本次没有改动索引设置');
      service.setSettings({ ppt: { roots } });
      return { ok: true, ppt: service.ppt.startIndex() };
    },
  };
}

module.exports = { createPptHandlers };
