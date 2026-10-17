'use strict';
const { pathToFileURL } = require('node:url');
const { webUtils } = require('electron');

function createBridgeImages({ document, ipcRenderer, refresh }) {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = document.createElement('section');
  root.className = 'bridge-images';
  root.innerHTML = `<h3>图片文字通道 <small>候选 1</small></h3><p class="bi-hint"></p>
    <form class="bi-form"><label>所属问答<select name="thread" required></select></label>
    <label>本机图片<input name="file" type="file" accept=".png,.jpg,.jpeg,.webp" required></label>
    <label class="bi-caption">图片说明<input name="caption" maxlength="400" placeholder="例如：请看右下角曲线（可不填）"></label>
    <label class="bi-resize"><input name="resize" type="checkbox">允许在必要时缩小分辨率</label>
    <button type="submit">发送图片文字消息</button><span class="bi-result" role="status"></span></form>
    <div class="bi-items"></div>`;
  if (!document.getElementById('bridge-images-style')) {
    const style = document.createElement('style'); style.id = 'bridge-images-style';
    style.textContent = `.bridge-images{margin:22px 0;padding-top:18px;border-top:1px solid var(--border-color,#d9dee7);font-size:13px}.bridge-images h3{margin:0 0 8px;font-size:16px}.bridge-images small{font-size:11px;opacity:.6;font-weight:400}.bridge-images .bi-hint{opacity:.75;line-height:1.6}.bi-form{display:flex;flex-wrap:wrap;gap:12px;align-items:end}.bi-form[hidden]{display:none}.bi-form label{display:flex;flex-direction:column;gap:5px}.bi-form input,.bi-form select,.bi-form button{font:inherit;max-width:100%;box-sizing:border-box}.bi-form input:not([type=checkbox]),.bi-form select{padding:7px;border:1px solid #abb6c5;border-radius:5px;background:var(--input-bg,#fff);color:inherit}.bi-form .bi-caption{flex:1;min-width:220px}.bi-form .bi-resize{flex-direction:row;align-items:center;min-height:34px}.bi-form button{background:#3478f6;color:#fff;border:0;border-radius:5px;padding:9px 14px;cursor:pointer}.bi-form button:disabled{opacity:.5;cursor:default}.bi-result{width:100%;white-space:pre-wrap;line-height:1.5}.bi-items{margin-top:16px}.bi-item{padding:12px 0;border-top:1px solid var(--border-color,#d9dee7)}.bi-item p{margin:5px 0;line-height:1.5;overflow-wrap:anywhere}.bi-meta{font-size:12px;opacity:.75}.bi-item summary{cursor:pointer;color:#3478f6}.bi-item img{display:block;max-width:100%;max-height:480px;margin:10px 0;object-fit:contain;background:#fff}.bi-error{color:#bd493b}`;
    document.head.append(style);
  }
  const form = root.querySelector('form'), select = form.elements.thread, result = root.querySelector('.bi-result');
  let busy = false, current = null, lastSentId = null;
  function update(data) {
    current = data;
    const images = data.images || {}, paired = data.link?.state === 'paired';
    const threads = [...(data.threads || []), ...(data.consults || []), ...(data.askHome || [])].filter(t => t.state !== 'cancelled' && t.sessionId);
    const options = '<option value="">选择图片所属的问答</option>' + threads.map(t => `<option value="${esc(t.id)}">${esc(t.id)} · ${esc(t.title || '问答')}</option>`).join('');
    const keep = select.value; select.innerHTML = options; select.value = keep;
    root.querySelector('.bi-hint').textContent = !paired ? '配对后可在这里发送和查看图片。' : !images.available ? '本机版本尚不支持图片处理。' : !images.peerSupported ? '等待对端确认图片能力，请两端升级后立即检查通道。' : '每条完整文字消息小于 60,000 字节。默认保留分辨率，必要时有损压缩；压不下会明确提示。接收端校验后在本机还原图片。';
    form.hidden = !paired || !images.available;
    form.querySelector('button').disabled = busy || !images.peerSupported || !threads.length;
    const last = !busy && lastSentId && (images.items || []).find(x => x.id === lastSentId);
    if (last) result.textContent = `${last.status}；完整文字 ${last.textBytes.toLocaleString('en-US')} 字节。`;
    const list = root.querySelector('.bi-items');
    const expanded = new Set([...list.querySelectorAll('details[open]')].map(x => x.dataset.id));
    list.innerHTML = (images.items || []).slice(0, 30).map(item => `<article class="bi-item" data-image-id="${esc(item.id)}">
      <b>${item.direction === 'in' ? '收到' : '发出'} · ${esc(item.thread)} · ${esc(item.status)}</b>
      <p class="bi-meta">第 ${esc(item.round)} 轮 · ${esc(item.width)} × ${esc(item.height)} · ${item.lossy ? '有损压缩' : 'PNG 编码'} · ${item.resized ? '已缩小分辨率' : '保留分辨率'} · 图片 ${Number(item.imageBytes).toLocaleString('en-US')} B · 完整文字 ${Number(item.textBytes).toLocaleString('en-US')} B</p>
      ${item.caption ? `<p>${esc(item.caption)}</p>` : ''}${item.error ? `<p class="bi-error">${esc(item.error)}</p>` : ''}
      ${item.deliveryUncertain ? '<p class="bi-error">通知已尝试送入会话，提交确认待核实。</p>' : ''}
      <details data-id="${esc(item.id)}"${expanded.has(item.id) ? ' open' : ''}><summary>查看本机图片</summary><img loading="lazy" src="${esc(pathToFileURL(item.path).href)}" alt="${esc(item.caption || '通道还原图片')}"><p class="bi-meta">${esc(item.path)}</p></details></article>`).join('') || '<p class="bi-meta">还没有图片消息。</p>';
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const file = form.elements.file.files[0]; if (!file || !select.value) return;
    busy = true; lastSentId = null; result.textContent = '正在本机压缩、检查文字大小并发送……'; update(current);
    try {
      const reply = await ipcRenderer.invoke('bridge:image-send', { thread: select.value, path: webUtils.getPathForFile(file), caption: form.elements.caption.value, allow_resize: form.elements.resize.checked });
      if (!reply?.ok) throw new Error(reply?.error || '发送未完成');
      lastSentId = reply.image.id;
      result.textContent = `${reply.image.status}；完整文字 ${reply.image.textBytes.toLocaleString('en-US')} 字节。`;
      form.elements.file.value = '';
    } catch (error) { result.textContent = error.message; }
    finally { busy = false; if (current) update(current); await refresh?.(); }
  });
  return { root, update };
}
module.exports = { createBridgeImages };
