'use strict';

// Enlarge the mounted surface in place: xterm, cards, drafts and split panes
// keep their existing owners. The native fullscreen bridge is shared with preview.
function createSessionImmersiveController({ document, ipcRenderer, getSurface, getSessionId, refit, onError }) {
  const button = document.getElementById('btn-session-immersive');
  let surface = null, sessionId = null, pending = false, exiting = false, revision = 0;
  const zone = document.createElement('div');
  zone.className = 'session-immersive-exit-zone';
  const exitButton = document.createElement('button');
  exitButton.type = 'button';
  exitButton.className = 'session-immersive-exit';
  exitButton.textContent = '退出沉浸 · Esc';
  exitButton.setAttribute('aria-label', '退出沉浸模式');
  zone.append(exitButton);
  function clear() {
    const previous = surface;
    surface?.classList.remove('session-immersive');
    document.body.classList.remove('session-immersive-active');
    zone.remove();
    surface = null;
    sessionId = null;
    button.setAttribute('aria-pressed', 'false');
    if (previous) refit();
  }
  async function exit() {
    if (exiting || (!surface && !pending)) return;
    exiting = true;
    const request = ++revision;
    pending = true;
    button.disabled = true;
    clear();
    try {
      const result = await ipcRenderer.invoke('preview:set-immersive', false);
      if (!result?.ok) throw new Error(result?.error || '窗口未能退出全屏');
    } catch (error) { onError(error.message); }
    finally { if (request === revision) { pending = false; exiting = false; button.disabled = false; } }
  }
  async function enter() {
    if (pending || surface || button.hidden) return;
    const target = getSurface(), id = getSessionId();
    if (!target || !id) return;
    const request = ++revision;
    pending = true;
    button.disabled = true;
    try {
      const result = await ipcRenderer.invoke('preview:set-immersive', true);
      if (request !== revision) return;
      if (!result?.ok) throw new Error(result?.error || '窗口未能切换全屏');
      if (getSurface() !== target || getSessionId() !== id) { void exit(); return; }
      surface = target;
      sessionId = id;
      target.classList.add('session-immersive');
      document.body.classList.add('session-immersive-active');
      target.append(zone);
      button.setAttribute('aria-pressed', 'true');
      refit();
      // Reading never focuses the editor or summons the phone keyboard.
    } catch (error) { onError(error.message); }
    finally { if (request === revision) { pending = false; button.disabled = false; } }
  }
  button.addEventListener('click', () => { void enter(); });
  exitButton.addEventListener('click', () => { void exit(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !surface) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void exit();
  }, true);
  ipcRenderer.on('preview:immersive-state', (_event, state) => {
    if (state?.active !== false) return;
    // Escape/native exit can arrive while the entry response is still pending.
    ++revision;
    pending = exiting = false;
    button.disabled = false;
    clear();
  });
  return {
    sync(visible) {
      button.hidden = !visible;
      if (surface && (!visible || getSessionId() !== sessionId || getSurface() !== surface)) void exit();
      if (pending && !visible) void exit();
    },
    exit,
  };
}

module.exports = { createSessionImmersiveController };
