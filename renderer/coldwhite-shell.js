'use strict';

// Layout only: preserve each existing panel, IPC owner and stateful DOM element.
function installColdwhiteShell(doc = globalThis.document) {
  const app = doc?.getElementById('app-container');
  if (!app || doc.getElementById('hub-system-footer')) return;
  const badge = doc.getElementById('coldwhite-preview-label');
  if (badge && globalThis.process?.env?.CLAUDE_HUB_UI_PREVIEW === 'coldwhite') {
    badge.hidden = false;
    badge.textContent = '冷白预览 0.2';
  }
  const footer = doc.createElement('footer');
  footer.id = 'hub-system-footer';
  footer.setAttribute('aria-label', '系统、账户用量与网络状态；点击详情查看全部读数');
  footer.tabIndex = 0;
  const strip = doc.getElementById('sidebar-strip');
  if (strip) footer.append(strip);
  const usage = doc.getElementById('rail-usage');
  if (usage) footer.append(usage);
  app.append(footer);
  require('./status-footer-layout').installStatusFooterLayout(doc);
  const panelIds = ['hub-workspace', 'writing-panel', 'account-page', 'xresearch-panel', 'study-panel', 'ran-panel'];
  const watched = new Set();
  const navigation = ['btn-home','btn-assistant','btn-research','btn-study','btn-ran','btn-rail-memo','btn-rail-capabilities','btn-rail-accounts','btn-writing'];
  let scheduled = false;
  const sync = () => {
    scheduled = false;
    const visible = panelIds.some(id => {
      const panel = doc.getElementById(id);
      return panel && !panel.hidden && doc.defaultView.getComputedStyle(panel).display !== 'none';
    });
    app.classList.toggle('workspace-active', visible);
    const isVisible = id => {
      const e = doc.getElementById(id);
      return e && !e.hidden && doc.defaultView.getComputedStyle(e).display !== 'none';
    };
    let current = 'btn-home';
    if (isVisible('hub-workspace')) {
      current = doc.getElementById('hub-workspace').dataset.area === 'review' ? 'btn-rail-memo' : 'btn-rail-capabilities';
    } else {
      for (const [panel, button] of [['account-page','btn-rail-accounts'],['writing-panel','btn-writing'],['xresearch-panel','btn-research'],['study-panel','btn-study'],['ran-panel','btn-ran']]) {
        if (isVisible(panel)) { current = button; break; }
      }
      if (current === 'btn-home' && (doc.body.classList.contains('assistant-session-active') || doc.body.classList.contains('assistant-page-open'))) current = 'btn-assistant';
    }
    for (const id of navigation) {
      const button = doc.getElementById(id);
      if (!button) continue;
      button.classList.toggle('cw-current', id === current);
      if (id === current) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  };
  const schedule = () => {
    if (!scheduled) { scheduled = true; doc.defaultView.requestAnimationFrame(sync); }
  };
  const observer = new doc.defaultView.MutationObserver(schedule);
  observer.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
  const discover = () => {
    for (const id of panelIds) {
      const panel = doc.getElementById(id);
      if (panel && !watched.has(panel)) {
        watched.add(panel);
        observer.observe(panel, { attributes: true, attributeFilter: ['style', 'hidden', 'class', 'data-area'] });
      }
    }
    schedule();
  };
  // Observe panel mounting, not high-frequency conversation descendants.
  const mounts = new doc.defaultView.MutationObserver(discover);
  mounts.observe(doc.body, { childList: true });
  mounts.observe(app, { childList: true });
  discover();
}

module.exports = { installColdwhiteShell };
