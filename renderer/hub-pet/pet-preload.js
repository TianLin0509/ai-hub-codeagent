'use strict';
// 桌宠窗口的 preload：只开放桌宠自己用的几条 IPC。
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, fn) {
  if (typeof fn !== 'function') return;
  ipcRenderer.on(channel, (_event, payload) => fn(payload));
}

contextBridge.exposeInMainWorld('hubPet', {
  ready: () => ipcRenderer.send('hub-pet:ready'),
  hit: (value) => ipcRenderer.send('hub-pet:hit', !!value),
  press: (target) => ipcRenderer.send('hub-pet:press', { target: String(target || 'pet') }),
  release: () => ipcRenderer.send('hub-pet:release'),
  bodyBox: (box) => ipcRenderer.send('hub-pet:body-box', box && typeof box === 'object' ? { left: +box.left || 0, right: +box.right || 0, top: +box.top || 0, bottom: +box.bottom || 0, role: String(box.role || '').slice(0, 40) } : null),
  menu: () => ipcRenderer.send('hub-pet:menu'),
  openNotice: (item) => ipcRenderer.send('hub-pet:open-notice', { id: String(item && item.id || ''), sessionId: item && item.sessionId ? String(item.sessionId) : '' }),
  onState: (fn) => on('hub-pet:state', fn),
  onMotion: (fn) => on('hub-pet:motion', fn),
  onPanel: (fn) => on('hub-pet:panel', fn),
});
