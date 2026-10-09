'use strict';

// Async, document-scoped dialogs. Never replace window.confirm with a Promise:
// each destructive caller explicitly awaits its decision before doing work.
const documents = new WeakMap();
const GLYPHS = {
  info: 'M12 8h.01M12 11v6M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0',
  lock: 'M5 10h14v11H5ZM8 10V6a4 4 0 0 1 8 0v4',
  warning: 'm12 3 10 18H2ZM12 9v5m0 3h.01',
};
function noticeContent(message, options = {}) {
  const raw = String(message ?? '');
  const occupied = /active writer|原 Hub 仍持有|已有.*写入权/i.test(raw);
  return {
    title: options.title || (occupied ? '这个会话正在另一窗口中使用' : /失败|错误|无法/.test(raw) ? '操作未完成' : '请留意这条提示'),
    body: occupied ? '请先在原 Hub 窗口结束该会话，再回来恢复。当前窗口没有启动第二个任务。' : raw,
    detail: occupied ? raw : options.detail || '',
    icon: occupied ? 'lock' : options.danger ? 'warning' : 'info',
  };
}
function requestDialog(message, options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  if (!doc?.body) {
    console.error('[ui-feedback] dialog unavailable:', message);
    return Promise.resolve(false); // A confirmation must fail closed.
  }
  let state = documents.get(doc);
  if (!state) { state = { queue: [], active: null }; documents.set(doc, state); }
  const key = JSON.stringify([String(message), options.title, options.confirm, options.danger]);
  // Repeated error events must not bury the user under identical alerts.
  if (!options.confirm) {
    const existing = [state.active, ...state.queue].find(item => item?.key === key);
    if (existing) return existing.promise;
  }
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  state.queue.push({ key, message, options, resolve, promise, trigger: doc.activeElement });
  if (!state.active) presentNext(doc, state);
  return promise;
}
function presentNext(doc, state) {
  const item = state.queue.shift();
  if (!item) return;
  state.active = item;
  const { options } = item;
  const content = noticeContent(item.message, options);
  const make = (tag, cls, text) => {
    const el = doc.createElement(tag); if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const dialog = make('dialog', 'hub-dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'hub-dialog-title');
  dialog.setAttribute('aria-describedby', 'hub-dialog-body');
  const glyph = make('div', 'hub-dialog-icon');
  glyph.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${GLYPHS[content.icon]}"/></svg>`;
  const title = make('h2', '', content.title); title.id = 'hub-dialog-title';
  const body = make('p', 'hub-dialog-body', content.body); body.id = 'hub-dialog-body';
  dialog.append(glyph, title, body);
  if (content.detail) {
    const details = make('details', 'hub-dialog-details');
    details.append(make('summary', '', '查看技术详情'), make('pre', '', content.detail));
    dialog.append(details);
  }
  const footer = make('footer', 'hub-dialog-actions');
  let settled = false;
  const finish = accepted => {
    if (settled) return;
    settled = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (item.trigger?.isConnected) item.trigger.focus({ preventScroll: true });
    state.active = null;
    item.resolve(accepted);
    presentNext(doc, state);
  };
  if (options.confirm) {
    const cancel = make('button', 'hub-button', options.cancelLabel || '取消');
    cancel.type = 'button'; cancel.autofocus = true;
    cancel.addEventListener('click', () => finish(false)); footer.append(cancel);
  }
  const accept = make('button', 'hub-button hub-button-primary' + (options.danger ? ' hub-button-danger' : ''), options.acceptLabel || (options.confirm ? '确认继续' : '知道了'));
  accept.type = 'button'; accept.autofocus = !options.confirm;
  accept.addEventListener('click', () => finish(true)); footer.append(accept); dialog.append(footer);
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
  dialog.addEventListener('close', () => finish(false));
  doc.body.appendChild(dialog);
  try { dialog.showModal(); }
  catch (error) {
    console.error('[ui-feedback] could not present dialog:', error);
    finish(false);
  }
}
function showHubAlert(message, options) { return requestDialog(message, { ...options, confirm: false }); }
function confirmHubAction(message, options) { return requestDialog(message, { ...options, confirm: true }); }
module.exports = { showHubAlert, confirmHubAction, noticeContent };
