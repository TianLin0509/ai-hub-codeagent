'use strict';
// 桌宠右键菜单窗口的 preload：只开放菜单自己用的几条 IPC。
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, fn) {
  if (typeof fn !== 'function') return;
  ipcRenderer.on(channel, (_event, payload) => fn(payload));
}

contextBridge.exposeInMainWorld('hubPetMenu', {
  ready: () => ipcRenderer.send('hub-pet-menu:ready'),
  size: (box) => ipcRenderer.send('hub-pet-menu:size', { width: Number(box && box.width) || 0, height: Number(box && box.height) || 0 }),
  act: (payload) => ipcRenderer.send('hub-pet-menu:act', payload && typeof payload === 'object' ? payload : {}),
  onState: (fn) => on('hub-pet-menu:state', fn),
  onOpen: (fn) => on('hub-pet-menu:open', fn),
});
