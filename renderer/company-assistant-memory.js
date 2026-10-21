'use strict';
const LABELS = { person: '人物关系', group: '群聊', preference: '个人偏好', routine: '例行安排' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mountMemory(host, { call, showMessage }) {
  let offset = 0, items = [], edit = null, loading = false;
  async function render() {
    if (loading || !host.isConnected) return;
    loading = true;
    try {
      const value = await call('memory', { op: 'list', offset, limit: 10 });
      if (!host.isConnected) return;
      if (!value.items.length && offset) { offset = Math.max(0, offset - 10); loading = false; return render(); }
      items = value.items;
      host.innerHTML = `<p class="ca-note">只保存你明确要求记住的关系、偏好和安排。每类最多 15 条，每条 60 字；可以在这里纠正或删除。</p>
        <div class="ca-memory-list">${items.length ? items.map(item => `<div class="ca-memory-row"><div><b>${esc(LABELS[item.kind])} · ${esc(item.key)}</b><p>${esc(item.text)}</p></div><div class="ca-row"><button type="button" class="ca-link" data-memory-edit="${esc(item.id)}">修改</button><button type="button" class="ca-link" data-memory-remove="${esc(item.id)}">删除</button></div></div>`).join('') : '<p class="ca-note">还没有保存的记忆。你可以对助理说「记住……」。</p>'}</div>
        <div class="ca-row"><span class="ca-note">共 ${value.total} 条${value.total ? ` · 第 ${offset + 1}–${offset + items.length} 条` : ''}</span><button type="button" class="ca-link" data-memory-page="prev"${offset ? '' : ' disabled'}>上一页</button><button type="button" class="ca-link" data-memory-page="next"${value.nextOffset == null ? ' disabled' : ''}>下一页</button><button type="button" class="ca-link" data-memory-add>新增一条</button></div>
        <div data-memory-form hidden></div><p class="ca-note" data-memory-message role="status"></p>`;
    } catch (error) { if (host.isConnected) host.innerHTML = `<p class="ca-note bad">记忆暂时没能读到：${esc(error.message)}</p><button type="button" class="ca-link" data-memory-retry>重试</button>`; }
    finally { loading = false; }
  }
  function editor(item) {
    edit = item || null;
    const form = host.querySelector('[data-memory-form]');
    form.hidden = false;
    form.innerHTML = `<div class="ca-row"><label>类型<select data-memory-kind>${Object.entries(LABELS).map(([kind, label]) => `<option value="${kind}"${kind === (item?.kind || 'preference') ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label>称呼或主题<input type="text" data-memory-key maxlength="40" value="${esc(item?.key)}"></label></div><label class="ca-memory-text">记住的内容<textarea data-memory-text maxlength="60" rows="2">${esc(item?.text)}</textarea></label><div class="ca-row"><button type="button" class="ca-btn" data-memory-save>保存这条记忆</button><button type="button" class="ca-link" data-memory-cancel>取消</button></div>`;
    form.querySelector('[data-memory-key]').focus();
  }
  host.onclick = async event => {
    const target = event.target.closest('button'); if (!target || !host.contains(target)) return;
    if (target.hasAttribute('data-memory-retry')) return render();
    if (target.hasAttribute('data-memory-add')) return editor(null);
    if (target.dataset.memoryEdit) return editor(items.find(i => i.id === target.dataset.memoryEdit));
    if (target.hasAttribute('data-memory-cancel')) { host.querySelector('[data-memory-form]').hidden = true; edit = null; return; }
    if (target.dataset.memoryPage) { offset = Math.max(0, offset + (target.dataset.memoryPage === 'next' ? 10 : -10)); return render(); }
    if (!target.dataset.memoryRemove && !target.hasAttribute('data-memory-save')) return;
    target.disabled = true;
    try {
      const result = target.dataset.memoryRemove ? await call('memory', { op: 'remove', id: target.dataset.memoryRemove }) : await call('memory', {
        op: edit ? 'update' : 'add', ...(edit ? { id: edit.id } : {}), kind: host.querySelector('[data-memory-kind]').value,
        key: host.querySelector('[data-memory-key]').value.trim(), text: host.querySelector('[data-memory-text]').value.trim(),
      });
      const note = target.dataset.memoryRemove ? '这条记忆已删除' : result.evicted ? `已保存；这类记忆已满，替换了最久未用的「${result.evicted.key}」` : '记忆已保存';
      edit = null; await render(); if (host.isConnected) host.querySelector('[data-memory-message]').textContent = note; showMessage?.(note);
    } catch (error) { const msg = host.querySelector('[data-memory-message]'); if (msg) msg.textContent = '没有保存：' + error.message; target.disabled = false; }
  };
  void render();
}

module.exports = { mountMemory };
