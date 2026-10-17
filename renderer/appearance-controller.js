'use strict';
// Presentation-only: existing avatar identities and all session state remain owned by their renderers.
(() => {
  const { ipcRenderer } = require('electron');
  const { ARTWORK_KEYS, ICON_STYLES, compareVersion } = require('../core/appearance-packs');
  const { iconSource } = require('./appearance-icons');
  const distribution = require('../core/distribution');
  const NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini / Antigravity', deepseek: 'DeepSeek', kimi: 'Kimi', qwen: '千问', glm: '智谱', minimax: 'MiniMax' };
  const keys = distribution.allowedKinds ? ARTWORK_KEYS.filter(key => distribution.kindAllowed(key) || distribution.kindAllowed('codeagent') && ['glm', 'deepseek', 'minimax', 'qwen'].includes(key)) : ARTWORK_KEYS;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bytes = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`;
  let data = null, dialog = null, tab = 'packs', previewPack = '', busy = false, message = '', uploadTarget = null;
  const artStyle = document.createElement('style');
  artStyle.id = 'hub-appearance-artwork';
  document.head.appendChild(artStyle);
  function pack(id) { return data?.packs.find(p => p.id === id); }
  function source(key, ref) {
    if (ref && data?.custom[ref]) return data.custom[ref];
    return pack(ref)?.avatars[key] || `assets/ai-avatars/cel-v2/${key}.png`;
  }
  function avatar(key, prefs = data.preferences) { return source(key, prefs.overrides[key] || prefs.pack); }
  function refreshArtwork() {
    if (!data) return;
    const p = data.preferences;
    const css = [];
    for (const key of ARTWORK_KEYS) {
      const selected = avatar(key);
      if (selected.startsWith('data:image/')) css.push(`img[src="assets/ai-avatars/cel-v2/${key}.png"]:not(.appearance-dialog img){content:url("${selected}")}`);
      const logoKey = key === 'glm' ? ['glm', 'codeagent'] : [key];
      const ref = p.iconOverrides[key];
      for (const k of logoKey) {
        const icon = ref ? source(key, ref) : p.icons === 'portrait' ? selected : p.icons !== 'brand' ? iconSource(k, p.icons) : null;
        if (icon) css.push(`#session-list .ai-logo.logo-${k}{background-image:url("${icon}");background-size:contain}`);
      }
    }
    artStyle.textContent = css.join('\n');
    document.documentElement.dataset.hubIconStyle = p.icons;
  }
  function receive(next) { data = next; refreshArtwork(); if (dialog?.open) render(); }
  function status(text) { message = text; if (dialog?.open) render(); }
  async function action(fn, network = false) {
    if (!network && busy) return;
    if (!network) busy = true;
    try { await fn(); } catch (error) { status(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { if (!network) busy = false; if (dialog?.open) render(); }
  }
  async function save(prefs) {
    const change = await ipcRenderer.invoke('appearance:save', prefs);
    data.preferences = change.preferences; Object.assign(data.custom, change.custom); refreshArtwork();
    message = '已应用，当前窗口立即生效；下次启动会保留。';
  }
  function options(selected, includeFollow = true) {
    return `${includeFollow ? '<option value="">跟随整套</option>' : ''}<option value="default" ${selected === 'default' ? 'selected' : ''}>原有二次元</option>`
      + data.packs.map(p => `<option value="${p.id}" ${selected === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
      + (data.custom[selected] ? `<option value="${selected}" selected>自定义图片</option>` : '');
  }
  function preview() {
    const p = previewPack && tab === 'packs' ? { ...data.preferences, pack: previewPack, overrides: {} } : data.preferences;
    const items = keys.slice(0, 4);
    return `<aside class="appearance-preview"><h3>${previewPack && tab === 'packs' ? '整套预览' : '当前效果'}</h3><p>聊天头像</p><div class="appearance-preview-faces">${keys.map(k => `<figure><img src="${esc(avatar(k, p))}" alt="${NAMES[k]}"><figcaption>${NAMES[k].split(' / ')[0]}</figcaption></figure>`).join('')}</div>
      <p>侧栏实际尺寸 · 14 px</p><div class="appearance-demo-list">${items.map((k, i) => `<div><span>${['接口设计讨论', '修复登录问题', '梳理实现方案', '检查测试结果'][i]}</span><img class="appearance-mini" src="${esc(data.preferences.iconOverrides[k] ? source(k, data.preferences.iconOverrides[k]) : data.preferences.icons === 'portrait' ? avatar(k, p) : iconSource(k, data.preferences.icons))}" alt="${NAMES[k]}"><small>${i + 1} 分钟</small></div>`).join('')}</div><p class="appearance-hint">头像和小图标可分别选择。会话状态和模型提示保持原样。</p></aside>`;
  }
  function packList() {
    const all = [{ id: 'default', name: '原有二次元', description: '保留目前使用的头像' }, ...data.packs];
    return `<div class="appearance-heading"><div><h3>选一套喜欢的形象</h3><p>${data.packs.length} 套已安装；点击预览后可整套使用。</p></div><button class="appearance-btn" data-action="import">导入头像包</button></div><div class="appearance-pack-list">${all.map(p => `<section class="appearance-pack ${previewPack === p.id ? 'previewing' : ''}"><div class="appearance-pack-title"><strong>${esc(p.name)}</strong>${data.preferences.pack === p.id ? '<span class="appearance-tag">当前整套</span>' : ''}</div><p>${esc(p.description)}</p><div class="appearance-strip">${keys.map(k => `<img src="${esc(source(k, p.id))}" alt="${NAMES[k]}" title="${NAMES[k]}">`).join('')}</div><div class="appearance-actions"><button class="appearance-btn" data-preview="${p.id}">预览</button><button class="appearance-btn primary" data-apply="${p.id}">整套使用</button></div></section>`).join('')}</div><p class="appearance-hint">整套使用会替换各 AI 的头像混搭；侧栏小图标保持你的独立选择。</p>`;
  }
  function individual(icons = false) {
    const field = icons ? 'iconOverrides' : 'overrides';
    return `${icons ? `<h3>小图标样式</h3><div class="appearance-icon-choices">${ICON_STYLES.map(s => `<button class="appearance-btn ${data.preferences.icons === s.id ? 'selected' : ''}" data-icon-style="${s.id}"><img class="appearance-mini" src="${esc(s.id === 'portrait' ? avatar(keys[0]) : iconSource(keys[0], s.id))}" alt="">${s.name}</button>`).join('')}</div>` : '<h3>每个 AI 都能单独选</h3>'}
      <p>${icons ? '选择不同头像包中的图像作为小图标，也可以上传自己的图片。' : `例如 ${NAMES[keys[0]]} 用猫猫，${NAMES[keys[1]]} 用机器人。未单独指定的 AI 跟随整套。`}</p><div class="appearance-individual">${keys.map(k => `<div class="appearance-individual-row"><img src="${esc(icons ? data.preferences.iconOverrides[k] ? source(k, data.preferences.iconOverrides[k]) : data.preferences.icons === 'portrait' ? avatar(k) : iconSource(k, data.preferences.icons) : avatar(k))}" alt="${NAMES[k]}"><label for="appearance-${field}-${k}">${NAMES[k]}</label><select id="appearance-${field}-${k}" data-field="${field}" data-key="${k}">${options(data.preferences[field][k])}</select><button class="appearance-btn" data-upload="${k}" data-field="${field}">上传</button><button class="appearance-btn" data-reset="${k}" data-field="${field}">跟随</button></div>`).join('')}</div><p class="appearance-hint">上传支持 PNG / JPEG / WebP，最大 8 MB；居中裁成正方形，仅保存到本机。</p>`;
  }
  function online() {
    const s = data.state, progress = s.progress;
    const catalog = s.catalog || data.catalog;
    const active = s.phase === 'downloading', checking = s.phase === 'checking';
    return `<div class="appearance-heading"><div><h3>按需下载头像包</h3><p>只下载喜欢的套装，下载后可离线使用，无需重启。</p></div><button class="appearance-btn primary" data-action="check" ${active || checking ? 'disabled' : ''}>${checking ? '正在检查…' : '检查更新'}</button></div>
      <div class="appearance-source-list">${(s.sources || []).map(src => { const c = [...(s.attempts || []), ...(s.checks || [])].find(c => c.id === src.id); return `<div><b>${esc(src.name)}</b><span>${c ? c.status === 'downloading' ? '正在下载' : c.status === 'ok' || c.ok ? '连接正常' : esc(c.reason || '等待') : '点击检查后连接'}</span></div>`; }).join('')}</div>
      ${active ? `<div class="appearance-download"><progress max="${progress?.total || 1}" value="${progress?.received || 0}"></progress><p>${esc(progress?.sourceName || '正在连接下载源')} · ${bytes(progress?.received || 0)} / ${progress ? bytes(progress.total) : '正在获取'} · ${progress?.speed ? `${bytes(progress.speed)}/秒` : '正在估算速度'} · ${progress?.etaSec != null ? `剩余约 ${progress.etaSec} 秒` : '正在估算剩余时间'}</p><button class="appearance-btn" data-action="cancel">取消下载</button></div>` : ''}
      ${s.error ? `<p class="appearance-status bad" role="alert">${esc(s.error)}</p>` : s.phase === 'installed' ? '<p class="appearance-status">已下载，进入「整套头像」即可预览和使用。</p>' : ''}
      <div class="appearance-online-list">${(catalog?.packs || []).map(p => { const installed = pack(p.id), current = installed && compareVersion(installed.version, p.version) >= 0; return `<div><div><strong>${esc(p.name)}</strong><p>${esc(p.description)}</p><small>v${esc(p.version)} · ${bytes(p.bytes)}</small></div><button class="appearance-btn" data-download="${p.id}" ${active || checking || current ? 'disabled' : ''}>${current ? '已安装' : installed ? '更新' : '下载'}</button></div>`; }).join('') || '<p class="appearance-empty">点击「检查更新」查看可下载套装。也可以在「整套头像」导入离线头像包。</p>'}</div>`;
  }
  function render() {
    if (!dialog || !data) return;
    const tabs = [['packs', '整套头像'], ['individual', '逐个混搭'], ['icons', '侧栏小图标'], ['online', '在线更新']];
    const scroll = dialog.querySelector('.appearance-content')?.scrollTop || 0;
    const focus = document.activeElement?.id;
    dialog.innerHTML = `<div class="appearance-head"><div><strong>AI 头像与图标</strong><span>主题里的个性化外观</span></div><button class="appearance-close" data-action="close" aria-label="关闭">×</button></div><div class="appearance-tabs" role="tablist">${tabs.map(([id, name]) => `<button role="tab" aria-selected="${tab === id}" data-tab="${id}">${name}</button>`).join('')}</div><div class="appearance-layout"><section class="appearance-content">${tab === 'packs' ? packList() : tab === 'individual' ? individual() : tab === 'icons' ? individual(true) : online()}</section>${preview()}</div><div class="appearance-foot"><span class="appearance-feedback" role="status">${esc(message)}</span><button class="appearance-btn" data-action="reset">恢复默认</button><button class="appearance-btn primary" data-action="close">完成</button></div>`;
    dialog.querySelector('.appearance-content').scrollTop = scroll;
    if (focus) dialog.querySelector(`#${CSS.escape(focus)}`)?.focus();
  }
  const upload = document.createElement('input');
  upload.type = 'file'; upload.accept = 'image/png,image/jpeg,image/webp'; upload.hidden = true; upload.id = 'appearance-upload-file';
  document.body.appendChild(upload);
  upload.addEventListener('change', () => action(async () => {
    const file = upload.files[0], target = uploadTarget; upload.value = '';
    if (!file || !target) return;
    if (file.size > 8 * 1024 * 1024) throw new Error('请选择不超过 8 MB 的图片');
    // Chromium decodes WebP as well; nativeImage accepts the normalized PNG in the main process.
    const bitmap = await createImageBitmap(file);
    const edge = Math.min(bitmap.width, bitmap.height);
    if (bitmap.width > 8192 || bitmap.height > 8192) { bitmap.close(); throw new Error('图片边长不能超过 8192 像素'); }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 384;
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, 384, 384);
    bitmap.close();
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const custom = await ipcRenderer.invoke('appearance:upload', new Uint8Array(await png.arrayBuffer()));
    data.custom[custom.id] = custom.image;
    await save({ ...data.preferences, [target.field]: { ...data.preferences[target.field], [target.key]: custom.id } });
  }));
  async function open() {
    data = await ipcRenderer.invoke('appearance:get');
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'appearance-dialog'; dialog.id = 'appearance-dialog';
      dialog.setAttribute('aria-label', 'AI 头像与图标');
      document.body.appendChild(dialog);
      dialog.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.tab) { tab = b.dataset.tab; message = ''; render(); return; }
        if (b.dataset.action === 'close') { dialog.close(); document.getElementById('options-appearance')?.focus(); return; }
        if (b.dataset.preview) { previewPack = b.dataset.preview; render(); return; }
        if (b.dataset.upload) { uploadTarget = { key: b.dataset.upload, field: b.dataset.field }; upload.click(); return; }
        if (b.dataset.action === 'cancel') { void ipcRenderer.invoke('appearance:cancel'); return; }
        void action(async () => {
          if (b.dataset.apply) { previewPack = ''; await save({ ...data.preferences, pack: b.dataset.apply, overrides: {} }); }
          else if (b.dataset.iconStyle) await save({ ...data.preferences, icons: b.dataset.iconStyle, iconOverrides: {} });
          else if (b.dataset.reset) { const prefs = structuredClone(data.preferences); delete prefs[b.dataset.field][b.dataset.reset]; await save(prefs); }
          else if (b.dataset.download) { await ipcRenderer.invoke('appearance:download', b.dataset.download); receive(await ipcRenderer.invoke('appearance:get')); }
          else if (b.dataset.action === 'check') { await ipcRenderer.invoke('appearance:check'); receive(await ipcRenderer.invoke('appearance:get')); }
          else if (b.dataset.action === 'import') { const imported = await ipcRenderer.invoke('appearance:import'); if (imported) { receive(imported); status('头像包已导入，可以预览并使用。'); } }
          else if (b.dataset.action === 'reset') { previewPack = ''; await save({ pack: 'default', overrides: {}, icons: 'brand', iconOverrides: {} }); }
        }, !!(b.dataset.download || b.dataset.action === 'check'));
      });
      dialog.addEventListener('change', e => {
        const s = e.target.closest('select[data-key]'); if (!s) return;
        void action(async () => { const prefs = structuredClone(data.preferences); if (s.value) prefs[s.dataset.field][s.dataset.key] = s.value; else delete prefs[s.dataset.field][s.dataset.key]; await save(prefs); });
      });
    }
    previewPack = ''; render(); refreshArtwork(); dialog.showModal();
  }
  document.getElementById('options-appearance')?.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('theme-menu').style.display = 'none';
    document.getElementById('btn-theme').setAttribute('aria-expanded', 'false');
    void open().catch(error => console.error('[appearance]', error));
  });
  ipcRenderer.on('appearance:changed', (_e, next) => receive(next));
  ipcRenderer.on('appearance:preferences', (_e, change) => {
    if (!data) return;
    data.preferences = change.preferences; Object.assign(data.custom, change.custom); refreshArtwork();
    if (!busy && dialog?.open) render();
  });
  ipcRenderer.on('appearance:state', (_e, state) => { if (data) { data.state = state; if (dialog?.open && tab === 'online') render(); } });
  ipcRenderer.invoke('appearance:get').then(receive).catch(error => console.warn('[appearance]', error));
})();
