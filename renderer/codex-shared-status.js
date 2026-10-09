'use strict';

function createCodexSharedStatus({ document:doc = document, invoke, getSession, onControlChanged = () => {} }) {
  const updateNotice = require('./backend-update-notice').createBackendUpdateNotice({ document: doc });
  const element = doc.createElement('section');
  element.id = 'codex-shared-status';
  element.className = 'codex-shared-status';
  element.hidden = true;
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');

  const icon = doc.createElement('span');
  icon.className = 'codex-shared-status-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="12" height="10" rx="2"/><rect x="9.5" y="9" width="12" height="10" rx="2"/></svg>';
  const copy = doc.createElement('span');
  copy.className = 'codex-shared-status-copy';
  const title = doc.createElement('strong');
  const detail = doc.createElement('small');
  copy.append(title, detail);
  const actions = doc.createElement('span');
  actions.className = 'codex-shared-status-actions';
  const locate = doc.createElement('button');
  locate.type = 'button';
  locate.textContent = '定位原窗口';
  const take = doc.createElement('button');
  take.type = 'button';
  take.className = 'primary';
  take.textContent = '在此操作';
  const feedback = doc.createElement('span');
  feedback.className = 'codex-shared-status-feedback';
  feedback.setAttribute('aria-live', 'polite');
  actions.append(locate, take);
  element.append(icon, copy, actions, feedback);

  let sessionId = null;
  let pending = false;
  async function run(action) {
    if (!sessionId || pending) return;
    pending = true;
    locate.disabled = true;
    take.disabled = true;
    feedback.textContent = action === 'request-control' ? '正在切换…' : '正在定位…';
    try {
      const response = await invoke('codex:native-action', { sessionId, action });
      if (!response?.ok) throw new Error(response?.message || '操作未确认');
      const session = getSession(sessionId);
      if (action === 'request-control' && session && response.result) {
        session.codexSharedControl = response.result;
        onControlChanged(session);
      }
      feedback.textContent = action === 'request-control' ? '已切换到本窗口' : '已唤起原窗口';
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      pending = false;
      update(getSession(sessionId));
    }
  }
  locate.addEventListener('click', () => run('locate-controller'));
  take.addEventListener('click', () => run('request-control'));

  function update(session) {
    const control = session?.codexSharedControl;
    if (sessionId !== (session?.id || null)) feedback.textContent = '';
    sessionId = session?.id || null;
    updateNotice.update(session);
    // The owning window needs no informational banner or reserved space.
    // Viewer actions still provide the actual cross-window control handoff.
    if (!control?.shared || !control.controller || control.role === 'controller') {
      element.hidden = true;
      actions.hidden = true;
      locate.hidden = true;
      take.hidden = true;
      locate.disabled = true;
      take.disabled = true;
      element.removeAttribute('data-role');
      element.removeAttribute('data-transferable');
      feedback.textContent = '';
      return;
    }
    element.hidden = false;
    const controller = control.controller;
    const own = control.role === 'controller';
    element.dataset.role = own ? 'controller' : 'viewer';
    element.dataset.transferable = control.canTransfer ? 'true' : 'false';
    title.textContent = own ? '当前由本窗口操作'
      : `当前由 ${controller?.label || '另一窗口'} 操作`;
    detail.textContent = own
      ? (control.transferReason || '其他窗口可以同步查看')
      : (control.transferReason || '工作结束后可以切换到本窗口');
    actions.hidden = own;
    locate.hidden = own;
    locate.disabled = pending || controller?.connected === false;
    locate.title = controller?.connected === false ? '原操作窗口已断开' : '显示并聚焦原操作窗口';
    take.hidden = own;
    take.textContent = control.canRecover ? '恢复操作' : '在此操作';
    take.disabled = pending || (!control.canTransfer && !control.canRecover);
    take.title = control.canRecover ? '原操作窗口已经断开；在此恢复同一后台的操作权'
      : control.canTransfer ? '将操作权切到本窗口；不会自动发送草稿'
      : (control.transferReason || '当前不能切换操作窗口');
    if (!pending && feedback.textContent && own) feedback.textContent = '已切换到本窗口';
  }

  return { element, update, updateNotice };
}

module.exports = { createCodexSharedStatus };
