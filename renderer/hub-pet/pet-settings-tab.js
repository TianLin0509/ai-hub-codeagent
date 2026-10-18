'use strict';
// 「助理 → 设置 → 桌宠」分页的内容（2026-10-17 用户：在这里选形象、下载更多形象、定桌宠的行为）。
// 助理设置面板建好「桌宠」分页后调用 mountPetSettingsTab(空容器, { ipcRenderer, window, document })。
// 所有改动立即生效（写桌宠自己的 hub-pet.json），不等面板的「保存」；联网只发生在用户点「下载 / 检查新形象」时。

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
const kb = n => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const MODE_NOTES = { lively: '提醒之外，早上问候、久坐提醒也会说', gentle: '只说助理的提醒', quiet: '不开口，只亮小圆点' };

function mountPetSettingsTab(container, { ipcRenderer, window, document }) {
  if (!container || !ipcRenderer) return { refresh: () => {} };
  let data = null;        // hub-pet:get-settings 的结果
  let packs = null;       // hub-pet:roles 的结果（含下载状态）
  let busy = false;

  container.classList.add('pet-tab');
  container.innerHTML = '<p class="pet-tab-note">正在读取桌宠设置…</p>';

  function render() {
    if (!data) return;
    if (!data.available) { container.innerHTML = '<p class="pet-tab-note">这个版本没有桌宠。</p>'; return; }
    const s = data.settings;
    const st = (packs && packs.state) || {};
    const roles = (packs && packs.roles) || data.roles || [];
    const activeId = st.phase === 'downloading' ? st.activeId : null;
    const pct = st.progress && st.progress.total ? Math.min(100, Math.round(st.progress.received / st.progress.total * 100)) : 0;
    const card = r => {
      const current = r.installed && r.id === s.role;
      let status, action = '';
      if (r.id === activeId) {
        status = `下载中 ${pct}%`;
        action = `<span class="pet-tab-bar"><i style="width:${pct}%"></i></span>`;
      } else if (current) status = '使用中';
      else if (r.installed && r.update) { status = '有新版本'; action = `<button type="button" class="pet-tab-mini" data-pet="download" data-id="${esc(r.id)}">更新</button>`; }
      else if (r.installed) status = r.bundled ? '内置 · 点击使用' : '已安装 · 点击使用';
      else if (st.failedId === r.id) { status = '下载没成功'; action = `<button type="button" class="pet-tab-mini" data-pet="download" data-id="${esc(r.id)}">重试</button>`; }
      else { status = r.bytes ? `可下载 · ${kb(r.bytes)}` : '可下载'; action = `<button type="button" class="pet-tab-mini primary" data-pet="download" data-id="${esc(r.id)}"${activeId ? ' disabled' : ''}>下载</button>`; }
      const img = r.previewMain ? `<img src="${esc(r.previewMain)}" alt="" draggable="false">` : '<span class="pet-tab-noimg"></span>';
      return `<div class="pet-tab-card${current ? ' current' : ''}${r.installed ? ' installed' : ' remote'}" data-role="${esc(r.id)}"${r.installed && !current ? ' role="button" tabindex="0" title="点击换成' + esc(r.name) + '"' : ''}>
          <div class="pet-tab-pic">${img}${current ? '<span class="pet-tab-check" aria-hidden="true"></span>' : ''}</div>
          <b>${esc(r.name)}</b><span class="pet-tab-status">${esc(status)}</span>${action}</div>`;
    };
    const checking = st.phase === 'checking';
    const checkNote = checking ? '正在连接形象目录…' : st.phase === 'error' && !st.failedId ? st.error : '';
    const modes = data.modes || [];
    container.innerHTML = `
      <div class="pet-tab-row pet-tab-top">
        <div><b>在桌面显示桌宠</b><small>Hub 开着时待在屏幕右下角；有新提醒会说一句，点它打开助理。</small></div>
        <label class="pet-tab-switch"><input type="checkbox" data-pet="enabled"${s.enabled ? ' checked' : ''}><span></span></label>
      </div>
      <div class="pet-tab-head"><h4>形象</h4><span class="pet-tab-note${st.phase === 'error' && !st.failedId ? ' bad' : ''}">${esc(checkNote)}</span>
        <button type="button" class="pet-tab-mini" data-pet="check"${checking || activeId ? ' disabled' : ''}>检查新形象</button></div>
      ${st.failedId && st.error ? `<p class="pet-tab-note bad">${esc(st.error)}</p>` : ''}
      <div class="pet-tab-grid">${roles.map(card).join('')}</div>
      <div class="pet-tab-row">
        <div><b>大小</b><small>拖动滑块，桌面上的桌宠跟着变大变小；脚的位置不动。</small></div>
        <div class="pet-tab-size"><input type="range" min="${SIZE_MIN}" max="${SIZE_MAX}" step="1" value="${sizePct(s.scale)}" data-pet-size aria-label="桌宠大小"><span data-pet-size-label>${sizePct(s.scale)}%</span>
          <button type="button" class="pet-tab-mini" data-pet="sizeReset"${sizePct(s.scale) === 100 ? ' disabled' : ''}>原大小</button></div>
      </div>
      <div class="pet-tab-head"><h4>行为</h4></div>
      <div class="pet-tab-row">
        <div><b>说话频率</b><small>${esc(MODE_NOTES[s.mode] || '')}；每小时最多开口 3 次。</small></div>
        <div class="pet-tab-seg" role="radiogroup" aria-label="说话频率">${modes.map(m => `<button type="button" role="radio" aria-checked="${m.id === s.mode}" data-pet="mode" data-id="${esc(m.id)}"${m.id === s.mode ? ' class="on"' : ''}>${esc(m.label)}</button>`).join('')}</div>
      </div>
      <div class="pet-tab-row">
        <div><b>暂时别说话</b><small>到点自动恢复，提醒照样收进小圆点。</small></div>
        <div class="pet-tab-pair">
          <button type="button" class="pet-tab-toggle${data.quietHour ? ' on' : ''}" aria-pressed="${!!data.quietHour}" data-pet="quietHour">安静一小时</button>
          <button type="button" class="pet-tab-toggle${data.silentToday ? ' on' : ''}" aria-pressed="${!!data.silentToday}" data-pet="silentToday">今天别说话</button>
        </div>
      </div>
      <div class="pet-tab-row">
        <div><b>全屏时躲到屏幕边</b><small>演示、看视频或全屏开会时缩到右边只露一点，退出全屏后回来。</small></div>
        <label class="pet-tab-switch"><input type="checkbox" data-pet="peekOnFullscreen"${s.peekOnFullscreen !== false ? ' checked' : ''}><span></span></label>
      </div>
      <div class="pet-tab-row">
        <div><b>位置</b><small>拖到哪里就记住哪里；找不到它时点这里。</small></div>
        <button type="button" class="pet-tab-mini" data-pet="resetPosition"${s.enabled ? '' : ' disabled'}>回到右下角</button>
      </div>`;
  }

  // 大小滑块（2026-10-18 用户：连续调）：拖动时边拖边改（约 60ms 一次，不重画分页免得打断拖动）。
  // 拖动中带 live：主进程只改内存、实时挪窗口，不写盘；松手（change）再发一次不带 live 的，只写这一次。
  const SIZE_MIN = 60, SIZE_MAX = 160;
  const sizePct = v => Math.round((Number(v) || 1) * 100);
  let sizeTimer = null, sizeWant = null, sizeSent = null;
  const sendSize = () => { if (sizeWant == null || sizeWant === sizeSent) return; sizeSent = sizeWant; void ipcRenderer.invoke('hub-pet:set-settings', { scale: sizeWant / 100, live: true }).catch(() => {}); };
  function pushSize(final) {
    if (final) {
      clearTimeout(sizeTimer); sizeTimer = null;
      sizeSent = null;
      void ipcRenderer.invoke('hub-pet:set-settings', { scale: sizeWant / 100 }).then(next => { if (next) { data = next; render(); } }).catch(() => {});
      return;
    }
    if (sizeTimer) return;
    sendSize();
    sizeTimer = setTimeout(function tick() { sizeTimer = null; if (sizeWant !== sizeSent) { sendSize(); sizeTimer = setTimeout(tick, 60); } }, 60);
  }
  async function refresh() {
    try {
      const [settings, roles] = await Promise.all([ipcRenderer.invoke('hub-pet:get-settings'), ipcRenderer.invoke('hub-pet:roles')]);
      data = settings; packs = roles || packs; render();
    } catch (error) { container.innerHTML = `<p class="pet-tab-note bad">读取桌宠设置失败：${esc(error.message)}</p>`; }
  }
  async function save(patch) {
    if (busy) return;
    busy = true;
    try { const next = await ipcRenderer.invoke('hub-pet:set-settings', patch); if (next) data = next; packs = (await ipcRenderer.invoke('hub-pet:roles')) || packs; }
    catch (_) {} finally { busy = false; render(); }
  }

  container.addEventListener('click', event => {
    const btn = event.target.closest('[data-pet]');
    if (btn && !btn.disabled) {
      const kind = btn.dataset.pet;
      if (kind === 'mode') return void save({ mode: btn.dataset.id });
      if (kind === 'quietHour') return void save({ quietHour: !data.quietHour });
      if (kind === 'silentToday') return void save({ silentToday: !data.silentToday });
      if (kind === 'resetPosition') return void save({ resetPosition: true });
      if (kind === 'sizeReset') return void save({ scale: 1 });
      if (kind === 'check') { void ipcRenderer.invoke('hub-pet:roles-check').then(r => { if (r) packs = r; render(); }); return; }
      if (kind === 'download') {
        void ipcRenderer.invoke('hub-pet:role-download', btn.dataset.id).then(async r => { if (r) packs = r; data = (await ipcRenderer.invoke('hub-pet:get-settings')) || data; render(); });
        return;
      }
      return;
    }
    const cardEl = event.target.closest('.pet-tab-card.installed:not(.current)');
    if (cardEl) void save({ role: cardEl.dataset.role });
  });
  container.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const cardEl = event.target.closest('.pet-tab-card.installed:not(.current)');
    if (cardEl) { event.preventDefault(); void save({ role: cardEl.dataset.role }); }
  });
  container.addEventListener('input', event => {
    const range = event.target.closest('input[data-pet-size]');
    if (!range) return;
    const label = container.querySelector('[data-pet-size-label]');
    if (label) label.textContent = range.value + '%';
    sizeWant = Number(range.value);
    pushSize(false);
  });
  container.addEventListener('change', event => {
    const range = event.target.closest('input[data-pet-size]');
    if (range) { sizeWant = Number(range.value); pushSize(true); return; }
    const input = event.target.closest('input[data-pet]');
    if (input) void save({ [input.dataset.pet]: input.checked });
  });
  // 下载进度：主进程每有进展就推一次。分页被拆掉后（面板关了又重建）第一次收到推送时退订。
  let seen = false;
  const onState = (_event, snap) => {
    if (container.isConnected) seen = true;
    else if (seen) { ipcRenderer.removeListener?.('hub-pet:roles-state', onState); return; }
    if (snap) packs = snap;
    render();
  };
  ipcRenderer.on('hub-pet:roles-state', onState);
  // 在桌宠右键菜单里换了形象、说话频率或安静开关，分页跟着变。
  const onChanged = () => { if (!container.isConnected) { ipcRenderer.removeListener?.('hub-pet:settings-changed', onChanged); return; } void refresh(); };
  ipcRenderer.on('hub-pet:settings-changed', onChanged);

  refresh();
  return { refresh };
}

module.exports = { mountPetSettingsTab };
