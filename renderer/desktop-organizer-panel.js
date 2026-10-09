'use strict';
function attachDesktopOrganizerPanel({ document: doc, invoke, escapeHtml: esc }) {
  const trigger = doc.getElementById('btn-desktop-organizer');
  if (!trigger) return;
  const panel = doc.createElement('section');
  panel.id = 'desktop-organizer-panel'; panel.className = 'desktop-organizer-panel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '整理电脑桌面');
  doc.body.appendChild(panel);
  let plan, busy = false, message = '', selected = new Set();
  function render() {
    panel.innerHTML = '<header><strong>整理电脑桌面</strong><button type="button" data-do="close" aria-label="关闭">×</button></header>'
      + '<p>把资料收进桌面以外的归档目录，默认保留启动入口。图标从上往下排列，排满一列后排右侧下一列；收走或还原文件后自动排齐。</p>'
      + `<div class="do-message" role="status">${esc(message)}</div>`
      + (plan ? `<p class="do-location">资料：${esc(plan.archive)}<br>旧 AI 产物：${esc(plan.artifacts)}\\历史桌面产物</p><div class="do-list">${plan.items.map(item => `<label><input type="checkbox" data-key="${esc(item.key)}"${selected.has(item.key) ? ' checked' : ''}${busy ? ' disabled' : ''}><span>${esc(item.name)}<small>${esc(item.kind)} · ${esc(item.source)}</small></span></label>`).join('')}</div>` : '')
      + `<footer><button type="button" data-do="scan"${busy ? ' disabled' : ''}>重新扫描</button><button type="button" data-do="open"${busy ? ' disabled' : ''}>打开归档</button><button type="button" data-do="undo" title="还原最近一次文件归档，图标继续保持竖列排列"${busy ? ' disabled' : ''}>还原归档</button><button type="button" data-do="arrange"${busy ? ' disabled' : ''}>排齐图标</button><button type="button" class="do-primary" data-do="execute"${busy || !selected.size ? ' disabled' : ''}>收走并排齐 ${selected.size} 项</button></footer>`;
  }
  async function action(kind) {
    if (busy) return;
    busy = true; message = kind === 'scan' ? '正在读取桌面…' : kind === 'arrange' ? '正在按竖列排列桌面图标…' : '正在处理，请稍候…'; render();
    try {
      const result = await invoke('desktop-organizer:' + kind, kind === 'execute' ? { id: plan.id, keys: [...selected] } : {});
      if (!result.ok) throw new Error(result.error || '操作失败');
      if (kind === 'scan') { plan = result; selected = new Set(result.items.filter(item => item.selected).map(item => item.key)); message = result.items.length ? '资料默认勾选，启动入口默认保留；也可单独点击“排齐图标”。' : '没有需要收走的项目，可以单独点击“排齐图标”。'; }
      const layoutMessage = layout => layout?.ok ? `已排齐 ${layout.iconCount} 个图标，共 ${layout.columns} 列。${layout.simulated ? '（隔离测试：模拟桌面）' : ''}` : layout ? '图标排列未完成：' + layout.error : '';
      if (kind === 'arrange') message = layoutMessage(result);
      if (kind === 'execute' || kind === 'undo') {
        plan = null; selected.clear();
        const failed = result.rows.filter(row => row.error);
        message = `${kind === 'execute' ? '已收走 ' + result.moved : '已还原 ' + result.restored} 项。` + (result.layout ? '\n' + layoutMessage(result.layout) : '') + (failed.length ? '\n保留或未还原：' + failed.map(row => row.name + '：' + row.error).join('；') : '') + '\n记录：' + result.receipt;
      }
    } catch (e) { message = e.message; } finally { busy = false; render(); }
  }
  trigger.addEventListener('click', () => { panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); void action('scan'); });
  const close = () => { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); };
  panel.addEventListener('click', event => { const button = event.target.closest('[data-do]'); if (button) button.dataset.do === 'close' ? close() : void action(button.dataset.do); });
  panel.addEventListener('change', event => { const key = event.target.dataset.key; if (key) { event.target.checked ? selected.add(key) : selected.delete(key); render(); } });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(); });
  return { close };
}
module.exports = { attachDesktopOrganizerPanel };
