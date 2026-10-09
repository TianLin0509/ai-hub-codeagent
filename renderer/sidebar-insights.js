'use strict';

const STORAGE_KEY = 'hub.sidebarInsightsCollapsed';

function createSidebarInsights({ document, storage, onExpand }) {
  const root = document.getElementById('sidebar-insights');
  const button = document.getElementById('sidebar-insights-toggle');
  const content = document.getElementById('sidebar-insights-content');
  let collapsed = false;
  if (!root || !button || !content) return { isCollapsed: () => false };
  try { collapsed = storage.getItem(STORAGE_KEY) === 'true'; } catch { /* Persistence is optional. */ }

  function apply() {
    // Move keyboard focus out before making the region inert.
    if (collapsed && content.contains(document.activeElement)) button.focus({ preventScroll: true });
    root.classList.toggle('is-collapsed', collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? '展开用量与系统状态' : '向下收起用量与系统状态';
    button.querySelector('.sidebar-insights-action').textContent = collapsed ? '展开' : '收起';
    content.inert = collapsed;
    content.setAttribute('aria-hidden', String(collapsed));
    document.dispatchEvent(new document.defaultView.CustomEvent('sidebar-insights:visibility', { detail: { collapsed } }));
  }
  apply();
  button.addEventListener('click', () => {
    collapsed = !collapsed;
    apply();
    try { storage.setItem(STORAGE_KEY, String(collapsed)); } catch { /* Still works for this window. */ }
    if (!collapsed && onExpand) onExpand();
  });
  return { isCollapsed: () => collapsed };
}

module.exports = { createSidebarInsights };
