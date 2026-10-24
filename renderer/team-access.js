'use strict';
function createTeamAccess({ document, window, ipcRenderer, onUnlocked, onLocked, showMessage = () => {} }) {
  const button = document.getElementById('btn-team');
  let dialog, busy = false;
  const render = unlocked => { if (button) { button.hidden = !unlocked; button.style.display = unlocked ? '' : 'none'; } };
  render(false);
  async function refresh() {
    try { const state = await ipcRenderer.invoke('team:access'); render(state?.ok && state.unlocked); }
    catch { render(false); }
  }
  function open() {
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'team-access-dialog';
      dialog.style.cssText = 'padding:24px;border:1px solid var(--border,#ddd);border-radius:12px;background:var(--bg,#fff);color:var(--text,#222);min-width:340px';
      dialog.innerHTML = '<form><h2>私人团队入口</h2><p>输入专用口令，仅本次运行有效。</p><input type="password" name="password" aria-label="团队访问口令" autocomplete="off" maxlength="128" style="width:100%;box-sizing:border-box;padding:10px"><p role="status"></p><div style="display:flex;gap:12px"><button type="submit">解锁</button><button type="button" data-lock>锁定团队</button><button type="button" data-close>关闭</button></div></form>';
      document.body.append(dialog);
      dialog.querySelector('[data-close]').onclick = () => dialog.close();
      dialog.addEventListener('close', () => { dialog.querySelector('input').value = ''; });
      dialog.querySelector('form').onsubmit = async event => {
        event.preventDefault(); if (busy) return; busy = true;
        const input = dialog.querySelector('input'), password = input.value; input.value = '';
        try {
          const result = await ipcRenderer.invoke('team:unlock', { password });
          if (!result?.ok || !result.unlocked) throw Error(result?.error || '未能解锁');
          render(true); dialog.close(); await onUnlocked();
        } catch (error) { dialog.querySelector('[role=status]').textContent = error.message; }
        finally { busy = false; }
      };
      dialog.querySelector('[data-lock]').onclick = async () => {
        if (busy) return;
        if (!window.confirm('锁定会关闭团队网页，未提交的网页内容可能丢失。是否继续？')) return;
        busy = true;
        try {
          const result = await ipcRenderer.invoke('team:lock');
          if (!result?.ok) throw Error(result?.error || '锁定未完成');
          render(false); onLocked(); dialog.close(); showMessage('团队已锁定');
        } catch (error) { dialog.querySelector('[role=status]').textContent = error.message; }
        finally { busy = false; }
      };
    }
    if (!dialog.open) { dialog.querySelector('[role=status]').textContent = ''; dialog.showModal(); dialog.querySelector('input').focus(); }
  }
  window.addEventListener('keydown', event => {
    if (event.ctrlKey && event.altKey && event.code === 'KeyT' && !event.repeat) { event.preventDefault(); open(); }
  });
  void refresh();
  return { refresh, open };
}
module.exports = { createTeamAccess };
