'use strict';

// One reusable, event-driven notice per window. Repeated runtime snapshots do
// not reopen it, add listeners, or create another polling loop.
function createBackendUpdateNotice({ document: doc }) {
  const element = doc.createElement('div');
  element.id = 'backend-update-notice';
  element.className = 'backend-update-notice';
  element.hidden = true;
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'backend-update-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'backend-update-details');
  toggle.title = '查看后台更新说明';
  const details = doc.createElement('div');
  details.id = 'backend-update-details';
  details.className = 'backend-update-details';
  details.hidden = true;
  details.setAttribute('role', 'region');
  details.setAttribute('aria-label', '后台更新说明');
  const title = doc.createElement('strong');
  const reason = doc.createElement('p');
  const hint = doc.createElement('p');
  const version = doc.createElement('small');
  const close = doc.createElement('button');
  close.type = 'button'; close.className = 'backend-update-close'; close.textContent = '收起';
  details.append(title, reason, hint, version, close);
  element.append(toggle, details);
  let identity = null, signature = null;
  function collapse({ focus = false } = {}) {
    details.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    if (focus && !element.hidden) toggle.focus();
  }
  toggle.addEventListener('click', () => {
    details.hidden = !details.hidden;
    toggle.setAttribute('aria-expanded', String(!details.hidden));
  });
  close.addEventListener('click', () => collapse({ focus: true }));
  doc.addEventListener('pointerdown', event => {
    if (!details.hidden && !element.contains(event.target)) collapse();
  });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !details.hidden) { collapse({ focus: true }); event.stopPropagation(); }
  });
  function update(session) {
    const control = session?.codexSharedControl;
    const upgrade = control?.shared && control.backendUpgrade;
    const nextIdentity = upgrade ? `${session.id}:${control.serviceId}:${upgrade.status}:${upgrade.target || ''}` : null;
    if (identity !== nextIdentity) { collapse(); identity = nextIdentity; }
    if (element.hidden !== !upgrade) element.hidden = !upgrade;
    if (!upgrade) { signature = null; return; }
    const nextSignature = JSON.stringify([nextIdentity, upgrade.reason, control.runtimeBuild?.version]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    const legacy = upgrade.status === 'legacy';
    toggle.textContent = upgrade.status === 'draining' ? '后台交接中' : '后台待更新';
    title.textContent = legacy ? '旧后台仍在运行' : '后台更新';
    reason.textContent = upgrade.reason || '后台将在会话空闲后完成更新。';
    hint.textContent = legacy
      ? '这不是更新按钮。切换操作权不会更新后台；请保留进行中的任务，旧后台正常退出后才会加载新代码。'
      : '等待运行中的任务和待处理事项结束后自动交接，无需反复点击。';
    version.textContent = `实际后台：${control.runtimeBuild?.version || '旧版本'}${upgrade.target ? ` → ${upgrade.target}` : ''}`;
  }
  return { element, update, collapse };
}

module.exports = { createBackendUpdateNotice };
