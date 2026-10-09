'use strict';

// Preview guests have their own keyboard event stream. Capture Escape before
// the guest page/preload so an embedded page cannot trap the fullscreen user.
function bindPreviewImmersiveWindow(win) {
  if (win.__previewImmersiveInputBound) return;
  win.__previewImmersiveInputBound = true;
  const bind = contents => contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape' || !win.__exitPreviewImmersive) return;
    event.preventDefault();
    win.__exitPreviewImmersive();
  });
  bind(win.webContents);
  win.webContents.on('did-attach-webview', (_event, guest) => bind(guest));
}

// Own only the native fullscreen transition made by preview. Existing native
// fullscreen and maximized/windowed bounds remain Electron's responsibility.
function registerPreviewImmersiveIpc(ipcMain, { getMainWindow }) {
  let owner = null;
  let previousFullscreen = false;
  const publish = (win, active) => {
    if (!win.isDestroyed()) win.webContents.send('preview:immersive-state', { active });
  };
  ipcMain.handle('preview:set-immersive', (event, active) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return { ok: false, error: '预览窗口不可用' };
    }
    if (typeof active !== 'boolean') return { ok: false, error: '无效的沉浸模式请求' };
    try {
      if (active && owner !== win) {
        previousFullscreen = win.isFullScreen();
        win.setFullScreen(true);
        owner = win;
        win.__exitPreviewImmersive = () => {
          win.setFullScreen(previousFullscreen);
          owner = null;
          win.__exitPreviewImmersive = null;
          publish(win, false);
        };
        if (!win.__previewImmersiveBound) {
          win.__previewImmersiveBound = true;
          win.on('leave-full-screen', () => {
            if (owner !== win) return;
            owner = null;
            win.__exitPreviewImmersive = null;
            publish(win, false);
          });
          win.on('closed', () => { if (owner === win) owner = null; });
        }
      } else if (!active && owner === win) {
        win.setFullScreen(previousFullscreen);
        owner = null;
        win.__exitPreviewImmersive = null;
      }
      publish(win, active);
      return { ok: true, active, nativeFullscreen: win.isFullScreen() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

module.exports = { registerPreviewImmersiveIpc, bindPreviewImmersiveWindow };
