'use strict';
// Hub「配置」里的桌宠设置，以及桌宠 → Hub 的入口事件。
// 设置改了立即生效（不等「保存」按钮）：开关、角色、说话频率都直接写桌宠自己的 hub-pet.json。
// 点桌宠或右键菜单里的事项时，主进程把 Hub 拉到前台并发 hub-pet:open-assistant；
// 这里转成 window 上的同名 CustomEvent，detail 为 { source, action?, prompt?, noticeId?, sessionId? }，由助理页接住。

function mountHubPetSettings({ document, window, ipcRenderer }) {
  ipcRenderer.on('hub-pet:open-assistant', (_event, payload) => {
    try { window.dispatchEvent(new window.CustomEvent('hub-pet:open-assistant', { detail: payload || {} })); } catch (_) {}
  });

  // renderer.js 在配置弹窗的标记之前加载，等 DOM 建好再挂。
  if (!document.getElementById('config-main-view') && document.readyState === 'loading') {
    const api = { refresh: () => {} };
    document.addEventListener('DOMContentLoaded', () => { const mounted = mountSection({ document, window, ipcRenderer }); if (mounted) api.refresh = mounted.refresh; }, { once: true });
    return api;
  }
  return mountSection({ document, window, ipcRenderer });
}

function mountSection({ document, window, ipcRenderer }) {
  const host = document.getElementById('config-main-view');
  if (!host) return null;
  const section = document.createElement('div');
  section.id = 'cfg-hub-pet';
  section.hidden = true;
  section.innerHTML = [
    '<div class="config-section-label"><span>助理桌宠</span><span>立即生效</span></div>',
    '<div class="config-operations-card">',
    '  <label class="config-toggle-row" for="cfg-hub-pet-enabled">',
    '    <input type="checkbox" id="cfg-hub-pet-enabled">',
    '    <span><strong>在桌面角落显示桌宠</strong><small>Hub 开着时出现；有新提醒会说一句，点它打开助理。右键可让它安静一小时或今天别说话。</small></span>',
    '  </label>',
    '  <div class="config-reading-grid">',
    '    <div class="config-field"><label for="cfg-hub-pet-role">角色</label><select id="cfg-hub-pet-role"></select></div>',
    '    <div class="config-field"><label for="cfg-hub-pet-mode">说话频率</label><select id="cfg-hub-pet-mode"></select></div>',
    '  </div>',
    '  <p class="config-reading-note">温和：只说助理的提醒；活泼：再加早上问候、久坐提醒；安静：只亮小圆点。每小时最多开口 3 次。</p>',
    '</div>',
  ].join('\n');
  const proxyField = host.querySelector('.config-field');
  if (proxyField && proxyField.nextSibling) host.insertBefore(section, proxyField.nextSibling);
  else host.appendChild(section);

  const enabledEl = section.querySelector('#cfg-hub-pet-enabled');
  const roleEl = section.querySelector('#cfg-hub-pet-role');
  const modeEl = section.querySelector('#cfg-hub-pet-mode');

  function fill(data) {
    if (!data || !data.available) { section.hidden = true; return; }
    section.hidden = false;
    if (!roleEl.options.length) for (const r of data.roles) roleEl.add(new window.Option(r.name, r.id));
    if (!modeEl.options.length) for (const m of data.modes) modeEl.add(new window.Option(m.label, m.id));
    enabledEl.checked = !!data.settings.enabled;
    roleEl.value = data.settings.role;
    modeEl.value = data.settings.mode;
  }
  async function refresh() { try { fill(await ipcRenderer.invoke('hub-pet:get-settings')); } catch (_) {} }
  async function save(patch) { try { fill(await ipcRenderer.invoke('hub-pet:set-settings', patch)); } catch (_) {} }
  enabledEl.addEventListener('change', () => save({ enabled: enabledEl.checked }));
  roleEl.addEventListener('change', () => save({ role: roleEl.value }));
  modeEl.addEventListener('change', () => save({ mode: modeEl.value }));

  // 配置弹窗每次打开时重读一次（桌宠右键「收起」或换角色后，这里要跟着变）。
  const modal = document.getElementById('config-modal');
  if (modal && window.MutationObserver) {
    new window.MutationObserver(() => { if (!modal.classList.contains('hidden')) refresh(); }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
  refresh();
  return { refresh };
}

module.exports = { mountHubPetSettings };
