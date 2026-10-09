'use strict';

function createPreviewImmersiveController({ document, ipcRenderer, onError, onExit }) {
  const panel = document.getElementById('preview-panel');
  const enter = document.getElementById('preview-layout-immersive');
  const exit = document.getElementById('preview-immersive-exit');
  let active = false;
  let pending = false;
  let revision = 0;
  function apply(value) {
    const wasActive = active;
    active = !!value;
    document.body.classList.toggle('preview-immersive-active', active);
    panel.classList.toggle('preview-immersive', active);
    enter?.setAttribute('aria-pressed', String(active));
    if (exit) exit.hidden = !active;
    if (wasActive && !active) onExit?.();
  }
  async function setActive(value) {
    if (value && (pending || panel.style.display !== 'flex')) return;
    const request = ++revision;
    pending = true;
    if (enter) enter.disabled = true;
    // Remove the overlay immediately when navigating/closing. IPC preserves
    // order even when exit follows an unfinished enter request.
    if (!value) apply(false);
    try {
      const result = await ipcRenderer.invoke('preview:set-immersive', !!value);
      if (request !== revision) return;
      if (!result?.ok) throw new Error(result?.error || '窗口未能切换全屏');
      apply(value);
    } catch (error) {
      if (request === revision) onError?.(`沉浸模式切换失败：${error.message}`);
    } finally {
      if (request === revision) {
        pending = false;
        if (enter) enter.disabled = false;
      }
    }
  }
  enter?.addEventListener('click', () => { void setActive(true); });
  exit?.addEventListener('click', () => { void setActive(false); });
  ipcRenderer.on?.('preview:immersive-state', (_event, state) => {
    if (state?.active === false) apply(false);
  });
  return { isActive: () => active, exit: () => { if (active || pending) void setActive(false); } };
}

module.exports = { createPreviewImmersiveController };
