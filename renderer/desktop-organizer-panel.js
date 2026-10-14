'use strict';
// 整理电脑桌面（2026-10-14 用户：不要逐项打勾，自动按类型归纳、一键收纳；最多给一个选项）。
// 打开即扫描 → 显示「将收走几项、各类多少、桌面保留什么」→ 一键收纳 → 自动排齐图标；可撤销上一次。
// 唯一的选项：保留快捷方式（默认）/ 全部收走，记在本机。
const MODE_KEY = 'hub.desktopOrganizer.mode';
const MODES = [
  { id: 'keep-launchers', label: '保留快捷方式', hint: '资料按类型收进归档，快捷方式留在桌面' },
  { id: 'all', label: '全部收走', hint: '快捷方式也一起收进归档，桌面清空' },
];
const ORDER = ['文件夹', '文档', '表格', '演示', 'PDF', '图片', '音视频', '压缩包', '安装包', '代码', '其他', '快捷方式'];

function attachDesktopOrganizerPanel({ document: doc, invoke, escapeHtml: esc, storage = globalThis.localStorage }) {
  const trigger = doc.getElementById('btn-desktop-organizer');
  if (!trigger) return;
  const panel = doc.createElement('section');
  panel.id = 'desktop-organizer-panel'; panel.className = 'desktop-organizer-panel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '整理电脑桌面');
  doc.body.appendChild(panel);
  let plan = null, busy = false, done = null, note = '', error = '', arranged = null;
  let mode = (() => { try { const v = storage && storage.getItem(MODE_KEY); return MODES.some(m => m.id === v) ? v : 'keep-launchers'; } catch { return 'keep-launchers'; } })();

  const pickedBy = id => item => id === 'all' || item.kind !== '启动入口';
  const groups = items => {
    const map = new Map();
    for (const item of items) { const key = item.category || item.kind; if (!map.has(key)) map.set(key, []); map.get(key).push(item); }
    return [...map.entries()].sort((a, b) => (ORDER.indexOf(a[0]) + 99) % 99 - (ORDER.indexOf(b[0]) + 99) % 99);
  };
  const chips = list => list.map(([name, rows]) => `<span class="do-chip" title="${esc(rows.map(r => r.name).join('\n'))}">${esc(name)}<b>${rows.length}</b></span>`).join('');
  const layoutText = layout => !layout ? '' : layout.ok
    ? `图标已排齐：${layout.iconCount} 个，${layout.columns} 列${layout.simulated ? '（隔离测试：模拟桌面）' : ''}`
    : `图标没排齐：${layout.error}`;

  function body() {
    if (done) {
      const failed = (done.rows || []).filter(row => row.error);
      return `<div class="do-done" role="status"><div class="do-done-title">✓ ${esc(done.title)}</div>`
        + (done.groups ? `<div class="do-chips">${chips(done.groups)}</div>` : '')
        + (done.layout ? `<div class="do-line${done.layout.ok ? '' : ' warn'}">${esc(layoutText(done.layout))}</div>` : '')
        + (failed.length ? `<div class="do-line warn">没有收走 ${failed.length} 项：${esc(failed.map(row => `${row.name}（${row.error}）`).join('；'))}</div>` : '')
        + '</div>';
    }
    if (!plan) return `<div class="do-empty">${busy ? '正在读取桌面…' : esc(error || '')}</div>`;
    const picked = plan.items.filter(pickedBy(mode));
    const kept = plan.items.filter(item => !pickedBy(mode)(item));
    const tabs = `<div class="do-modes" role="tablist" aria-label="收纳方式">${MODES.map(m => `<button type="button" role="tab" data-mode="${m.id}" aria-selected="${m.id === mode}" title="${esc(m.hint)}"${busy ? ' disabled' : ''}>${esc(m.label)}</button>`).join('')}</div>`;
    if (!picked.length) {
      return tabs + `<div class="do-summary empty"><div class="do-count"><b>0</b><span>桌面已经很整洁，没有需要收纳的资料</span></div>`
        + (kept.length ? `<div class="do-line">桌面上是 ${kept.length} 个快捷方式；要一起收走，选上面的「全部收走」。</div>` : '') + '</div>';
    }
    const list = groups(picked);
    return tabs
      + `<div class="do-summary"><div class="do-count"><b>${picked.length}</b><span>项将按类型收进归档</span></div>`
      + `<div class="do-chips">${chips(list)}</div>`
      + `<div class="do-line">${kept.length ? `桌面保留 ${kept.length} 个快捷方式` : '收完桌面只剩系统图标'}；收完自动排齐图标，可随时撤销。</div></div>`
      + `<details class="do-detail"><summary>查看明细</summary>${list.map(([name, rows]) => `<div class="do-group"><div class="do-group-name">${esc(name)} · ${rows.length}</div>${rows.map(r => `<div class="do-row" title="${esc(r.source)}">${esc(r.name)}</div>`).join('')}</div>`).join('')}</details>`;
  }

  function render() {
    const picked = plan && !done ? plan.items.filter(pickedBy(mode)).length : 0;
    const primary = done
      ? '<button type="button" class="do-primary" data-do="close">完成</button>'
      : `<button type="button" class="do-primary" data-do="execute"${busy || !picked ? ' disabled' : ''}>${busy && note ? esc(note) : '一键收纳'}</button>`;
    panel.innerHTML = '<header><div class="do-title"><strong>整理桌面</strong><span>按类型自动收进归档，图标自动排齐，随时可撤销</span></div>'
      + '<button type="button" class="do-close" data-do="close" aria-label="关闭">×</button></header>'
      + `<div class="do-body">${body()}</div>`
      + (arranged ? `<div class="do-line${arranged.ok ? ' ok' : ' warn'}" role="status">${esc(layoutText(arranged))}</div>` : '')
      + (error && (plan || done) ? `<div class="do-line warn" role="alert">${esc(error)}</div>` : '')
      + `<footer><div class="do-links"><button type="button" data-do="undo"${busy ? ' disabled' : ''}>撤销上次收纳</button>`
      + `<button type="button" data-do="open"${busy ? ' disabled' : ''}>打开归档</button>`
      + `<button type="button" data-do="arrange"${busy ? ' disabled' : ''}>只排齐图标</button></div>${primary}</footer>`
      + (plan || done ? `<div class="do-location" title="${esc((plan || done).archive || '')}">归档位置：${esc((plan || done).archive || '')}</div>` : '');
  }

  async function action(kind) {
    if (busy) return;
    busy = true; error = '';
    note = kind === 'execute' ? '正在收纳…' : kind === 'undo' ? '正在撤销…' : kind === 'arrange' ? '正在排齐…' : '';
    if (kind === 'scan') { plan = null; done = null; }
    if (kind !== 'arrange') arranged = null;
    render();
    try {
      const payload = kind === 'execute' ? { id: plan.id, mode } : {};
      const result = await invoke('desktop-organizer:' + kind, payload);
      if (!result.ok) throw new Error(result.error || '操作失败');
      if (kind === 'scan') plan = result;
      else if (kind === 'execute') {
        const moved = (result.rows || []).filter(row => row.status === 'moved');
        done = { title: `已收纳 ${result.moved} 项`, groups: groups(moved), layout: result.layout, rows: result.rows, archive: plan.archive };
        plan = null;
      } else if (kind === 'undo') {
        done = { title: `已撤销上次收纳，还原 ${result.restored} 项`, layout: result.layout, rows: result.rows, archive: plan ? plan.archive : done && done.archive };
        plan = null;
      } else if (kind === 'arrange') {
        if (done) done = { ...done, layout: result }; else arranged = result;
      }
    } catch (e) { error = e.message; }
    finally { busy = false; note = ''; render(); }
  }

  trigger.addEventListener('click', () => { panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); void action('scan'); });
  const close = () => { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); };
  panel.addEventListener('click', event => {
    const tab = event.target.closest('[data-mode]');
    if (tab && !busy) { mode = tab.dataset.mode; try { storage && storage.setItem(MODE_KEY, mode); } catch {} render(); return; }
    const button = event.target.closest('[data-do]');
    if (button) button.dataset.do === 'close' ? close() : void action(button.dataset.do);
  });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(); });
  return { close };
}
module.exports = { attachDesktopOrganizerPanel };
