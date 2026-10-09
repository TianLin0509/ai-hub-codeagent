'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function attachmentInfo(attachment = {}, index = 0, cwd) {
  let target = attachment.path || attachment.url || '';
  let src = '', name = attachment.name || '图片 ' + (index + 1);
  try {
    if (attachment.path) {
      if (!path.isAbsolute(target)) {
        if (!cwd) return { target, src, name, error: '图片路径无法解析' };
        target = path.resolve(cwd, target);
      }
      src = pathToFileURL(target).href;
      name = attachment.name || path.basename(target);
    } else if (/^(https?:|file:)/i.test(target)) {
      const url = new URL(target);
      src = url.href;
      name = attachment.name || decodeURIComponent(url.pathname.split('/').pop()) || name;
    } else if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml)[;,]/i.test(target)) {
      src = target;
    }
  } catch {
    return { target, src: '', name, error: '图片引用无法解析' };
  }
  return { target, src, name, error: src ? '' : '图片暂不可用' };
}

function renderImageAttachments(attachments, { escapeHtml: esc, cwd } = {}) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const render = (a, i) => {
    const info = attachmentInfo(a, i, cwd);
    const title = info.src.startsWith('data:') ? info.name : info.target || info.name;
    return '<button type="button" class="conversation-image-thumb" data-action="card-open-image"'
      + ' data-image-index="' + i + '" title="' + esc(title) + '" aria-label="查看图片：' + esc(info.name) + '"'
      + (info.src ? '' : ' disabled') + '>'
      + (info.src ? '<img class="conversation-image" loading="lazy" decoding="async" src="' + esc(info.src)
        + '" alt="' + esc(info.name) + '">' : '')
      + '<span class="conversation-image-error"' + (info.src ? ' hidden' : '') + '>'
      + esc(info.error || '图片暂不可用') + '</span><span class="conversation-image-name">' + esc(info.name) + '</span></button>';
  };
  return '<div class="conversation-attachments" aria-label="附件 · ' + attachments.length + ' 张图片">'
    + '<div class="conversation-image-list">' + attachments.slice(0, 4).map(render).join('') + '</div>'
    + (attachments.length > 4 ? '<details class="conversation-images-more"><summary>另有 ' + (attachments.length - 4)
      + ' 张图片</summary><div class="conversation-image-list">' + attachments.slice(4).map((a, i) => render(a, i + 4)).join('')
      + '</div></details>' : '') + '</div>';
}

function createCardDetailControls({ document: doc, window: win, clipboard, resolveTurn, resolveResult, openAttachment, root = null }) {
  const listeners = [];
  function listen(element, type, handler, opts) { element.addEventListener(type, handler, opts); listeners.push([element, type, handler, opts]); }
  const message = (owner, text) => {
    const root = owner?.isConnected === false ? doc.body : owner.closest('.tc-result-wrap, .turn-content') || owner;
    let notice = root.querySelector(root === doc.body ? ':scope > .card-detail-global-error' : '.card-detail-error');
    if (!notice) {
      notice = doc.createElement('div'); notice.className = 'card-detail-error'; notice.setAttribute('role', 'alert');
      root.appendChild(notice);
    }
    if (root === doc.body) notice.classList.add('card-detail-global-error');
    notice.textContent = text;
    if (root === doc.body) {
      const close = doc.createElement('button'); close.type = 'button'; close.textContent = '关闭';
      close.addEventListener('click', () => notice.remove()); notice.appendChild(close);
    }
  };
  // A stream update may replace the original button while an operation awaits.
  // Resolve the live message by identity when showing an asynchronous failure.
  function errorReporter(owner) {
    const turnId = owner.closest('.turn-card')?.dataset.turnId;
    const activityId = owner.closest('[data-activity-id]')?.dataset.activityId;
    return text => {
      const card = turnId && [...doc.querySelectorAll('.turn-card')].find(e => e.dataset.turnId === turnId);
      const row = card && activityId && [...card.querySelectorAll('[data-activity-id]')].find(e => e.dataset.activityId === activityId);
      message(row?.querySelector('.tc-result-wrap') || card?.querySelector('.turn-content') || owner, text);
    };
  }
  function dialog(title) {
    const modal = doc.createElement('dialog');
    modal.className = 'card-detail-dialog';
    const header = doc.createElement('div'); header.className = 'card-detail-dialog-head';
    const label = doc.createElement('strong'); label.textContent = title;
    const close = doc.createElement('button'); close.type = 'button'; close.textContent = '关闭';
    close.setAttribute('aria-label', '关闭详情'); close.addEventListener('click', () => modal.close());
    header.append(label, close); modal.appendChild(header); doc.body.appendChild(modal);
    modal.addEventListener('close', () => modal.remove(), { once: true });
    return modal;
  }
  async function copyResult(button) {
    const reportError = errorReporter(button);
    try {
      const full = await resolveResult(button);
      await clipboard.writeText(full);
      button.textContent = '已复制全文';
    } catch (error) { reportError('复制失败：' + error.message); }
  }
  async function openResult(button) {
    const reportError = errorReporter(button);
    if (button.disabled) return;
    button.disabled = true;
    try {
      const full = await resolveResult(button), size = 50000;
      const modal = dialog('工具返回 · 完整来源 ' + full.length.toLocaleString('zh-CN') + ' 字符');
      const toolbar = doc.createElement('div'); toolbar.className = 'card-detail-dialog-tools';
      const label = doc.createElement('span'), prev = doc.createElement('button'), next = doc.createElement('button');
      const copy = doc.createElement('button'), download = doc.createElement('button'), pre = doc.createElement('pre');
      let page = 0;
      prev.textContent = '上一段'; next.textContent = '下一段'; copy.textContent = '复制全文'; download.textContent = '下载全文';
      for (const b of [prev, next, copy, download]) b.type = 'button';
      const paint = () => {
        label.textContent = '第 ' + (page + 1) + ' / ' + Math.max(1, Math.ceil(full.length / size)) + ' 段';
        pre.textContent = full.slice(page * size, (page + 1) * size);
        prev.disabled = page === 0; next.disabled = (page + 1) * size >= full.length;
      };
      prev.addEventListener('click', () => { page--; paint(); });
      next.addEventListener('click', () => { page++; paint(); });
      copy.addEventListener('click', async () => {
        try { await clipboard.writeText(full); copy.textContent = '已复制全文'; }
        catch (error) { message(modal, '复制失败：' + error.message); }
      });
      download.addEventListener('click', () => {
        let url;
        try {
          url = win.URL.createObjectURL(new win.Blob([full], { type: 'text/plain;charset=utf-8' }));
          const a = doc.createElement('a'); a.href = url;
          a.download = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-tool-output.txt';
          modal.appendChild(a); a.click(); a.remove();
        } catch (error) { message(modal, '下载失败：' + error.message); }
        finally { if (url) setTimeout(() => win.URL.revokeObjectURL(url), 10000); }
      });
      toolbar.append(label, prev, next, copy, download); modal.append(toolbar, pre);
      paint(); modal.showModal();
    } catch (error) { reportError('无法查看全文：' + error.message); }
    finally { button.disabled = false; }
  }
  async function openImage(button) {
    const reportError = errorReporter(button);
    try {
      const card = button.closest('.turn-card'), turn = resolveTurn(card);
      if (!turn) throw new Error('图片所属消息已不在当前视图，请重新载入');
      const index = Number(button.dataset.imageIndex), a = turn.attachments?.[index];
      if (!a) throw new Error('没有找到对应附件');
      const info = attachmentInfo(a, index, turn.attachmentCwd);
      if (!info.src) throw new Error(info.error);
      if (a.path && typeof openAttachment === 'function') {
        const result = await openAttachment(info.target, { cwd: turn.attachmentCwd, requireExistsForRel: false, fullscreen: true, throwOnError: true });
        if (result?.ok === false) throw new Error(result.error || '图片预览失败');
        return;
      }
      const modal = dialog(info.name), img = doc.createElement('img'), source = doc.createElement('p');
      img.className = 'card-detail-image'; img.alt = info.name;
      img.addEventListener('error', () => { img.hidden = true; message(modal, '图片暂不可用；附件引用仍保留。'); });
      img.src = info.src; source.className = 'card-detail-image-source';
      source.textContent = info.src.startsWith('data:') ? '本条消息的内嵌图片' : info.target;
      modal.append(img, source); modal.showModal();
    } catch (error) { reportError('图片预览失败：' + error.message); }
  }
  listen(root || doc, 'error', event => {
    const img = event.target;
    if (!img?.classList?.contains('conversation-image')) return;
    img.hidden = true;
    const info = img.closest('.conversation-image-thumb')?.querySelector('.conversation-image-error');
    if (info) info.hidden = false;
  }, true);
  listen(root || doc, 'click', event => {
    if (!root && event.target.closest('[data-split-secondary]')) return;
    const currentMenu = event.target?.closest?.('.card-actions-menu');
    doc.querySelectorAll('.card-actions-menu[open]').forEach(menu => {
      if (menu !== currentMenu || event.target?.closest?.('.ta-btn')) menu.open = false;
    });
    const button = event.target?.closest?.('[data-action="tc-copy-result"],[data-action="tc-open-full-result"],[data-action="card-open-image"]');
    if (!button) return;
    event.preventDefault(); event.stopPropagation();
    if (button.dataset.action === 'tc-copy-result') void copyResult(button);
    else if (button.dataset.action === 'tc-open-full-result') openResult(button);
    else void openImage(button);
  });
  listen(root || doc, 'keydown', event => {
    if (event.key !== 'Escape') return;
    doc.querySelectorAll('.card-actions-menu[open]').forEach(menu => {
      const restoreFocus = menu.contains(doc.activeElement);
      menu.open = false;
      if (restoreFocus) menu.querySelector('summary')?.focus();
    });
  });
  return { dialog, dispose() { for (const [element, type, handler, opts] of listeners) element.removeEventListener(type, handler, opts); } };
}
module.exports = { attachmentInfo, renderImageAttachments, createCardDetailControls };
