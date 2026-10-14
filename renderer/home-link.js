'use strict';
// 家里联动 · 公司一端的界面（2026-10-15）：设置菜单里不显眼的一项「家里联动」，打开是一个弹窗。
// 弹窗里：粘贴配对码、网络放行提示、代码位置与给 CodeAgent 的说明（可改）、模型、收到的问题列表。
// 只有公司版、且主进程启用了公司一端时才出现；没配对的电脑什么也不做。
(() => {
  const { ipcRenderer } = require('electron');
  let dialog = null, data = null, editing = false;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = at => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  const ago = at => { if (!at) return '还没有'; const m = Math.round((Date.now() - Date.parse(at)) / 60000); return m <= 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : clock(at); };
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke(channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  const toast = m => (window.__hubToast ? window.__hubToast(m) : console.log(m));
  const STATE = { queued: ['排队', 'wait'], running: ['CodeAgent 在读代码', 'run'], replied: ['已回执', 'ok'], failed: ['没答上', 'bad'], cancelled: ['已作废', ''] };

  const css = `
  .hl-dialog{position:fixed;inset:0;margin:auto;height:fit-content;max-height:calc(100vh - 40px);overflow:auto;width:min(760px,calc(100vw - 40px));padding:0;border:1px solid var(--border-subtle,#e3e1ea);border-radius:14px;background:var(--surface-raised,#fff);color:var(--fg-default,#1f2330);box-shadow:0 24px 60px rgba(30,24,60,.22);font:inherit}
  .hl-dialog::backdrop{background:rgba(24,20,40,.38)}
  .hl-head{display:flex;align-items:center;gap:10px;padding:16px 20px 10px}
  .hl-head strong{font-size:15px;flex:1}
  .hl-x{border:0;background:transparent;color:var(--fg-muted,#6b7080);font-size:18px;cursor:pointer;padding:4px 8px;border-radius:6px}
  .hl-body{padding:0 20px 18px;font-size:13px;line-height:1.65}
  .hl-sec{margin:12px 0 0;padding-top:12px;border-top:1px solid var(--border-subtle,#eceaf2)}
  .hl-sec h3{font-size:13px;margin:0 0 6px}
  .hl-muted{color:var(--fg-muted,#6b7080);font-size:12px}
  .hl-banner{padding:10px 12px;border-radius:10px;margin:6px 0;display:flex;gap:10px;align-items:center}
  .hl-banner.bad{background:#fdecea;color:#a3271b}.hl-banner.ok{background:#ecf7ef;color:#1d6b39}.hl-banner.info{background:#f2f1f7;color:#4a4f60}
  .hl-banner span{flex:1}
  .hl-btn{padding:5px 12px;border:1px solid var(--border-subtle,#dcdbe5);border-radius:8px;background:var(--surface-raised,#fff);color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
  .hl-btn.primary{background:var(--brand,#5b5bd6);border-color:var(--brand,#5b5bd6);color:#fff}
  .hl-btn:disabled{opacity:.55;cursor:wait}
  .hl-link{border:0;background:transparent;color:var(--brand,#5b5bd6);font:inherit;font-size:12px;cursor:pointer;padding:2px 4px}
  .hl-dialog textarea,.hl-dialog select,.hl-dialog input{font:inherit;font-size:13px;border:1px solid var(--border-subtle,#dcdbe5);border-radius:8px;padding:6px 8px;background:var(--surface-raised,#fff);color:inherit;box-sizing:border-box}
  .hl-dialog textarea{width:100%;resize:vertical}
  .hl-grid{display:grid;grid-template-columns:96px 1fr;gap:8px 12px;align-items:start}
  .hl-grid label{padding-top:6px;color:var(--fg-muted,#6b7080)}
  .hl-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .hl-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
  .hl-item{padding:8px 0;border-bottom:1px solid var(--border-subtle,#f0eef5)}
  .hl-item:last-child{border-bottom:0}
  .hl-pill{font-size:11px;padding:1px 8px;border-radius:999px;background:#eef0f5;color:#4b5a70;margin-right:6px}
  .hl-pill.run{background:#e8f0ff;color:#315acb}.hl-pill.ok{background:#e7f6ec;color:#1d7a3e}.hl-pill.bad{background:#fdecea;color:#b42318}
  .hl-item details{margin-top:4px}.hl-item pre{white-space:pre-wrap;max-height:220px;overflow:auto;background:var(--surface-sunken,#f6f5fa);padding:8px;border-radius:8px;font:12px/1.6 inherit;margin:4px 0}`;

  function pairingView() {
    const state = data.link.state;
    if (state === 'waiting-welcome') return `<div class="hl-banner info"><span>已发出配对请求，等家里的 Hub 确认（家里 Hub 开着时 1 分钟内完成；24 小时没确认自动作废）。</span><button class="hl-btn" data-hl="check">立即检查</button><button class="hl-btn" data-hl="cancel-pair">取消，重新粘贴</button></div>`;
    return `<p>把家里 Hub「无线 → 公司联动」生成的配对码整段粘贴到下面（以 AIHUB-LINK-1. 开头）。配对后只有那一台家里电脑能向这里提问。</p>
      <textarea rows="3" data-hl-f="code" placeholder="AIHUB-LINK-1.…"></textarea>
      <div class="hl-foot"><button class="hl-btn primary" data-hl="pair">配对</button></div>`;
  }
  function netView() {
    const n = data.net || {};
    if (n.gate) return `<div class="hl-banner bad"><span>公司网络要求重新「允许访问」（${clock(n.gate.since)} 起）。点右边打开放行页，点完允许后关掉那个窗口，这里会自动接上；期间收到的问题和要发的回执都不会丢。</span><button class="hl-btn primary" data-hl="gate">打开放行页</button></div>`;
    // 放行页有时表现为直接断连（代理掐掉了连接），这里也给放行入口。
    if (n.lastError) return `<div class="hl-banner bad"><span>上次连接通道失败（${clock(n.lastError.at)}）：${esc(n.lastError.message)}。如果是公司网络要求重新允许访问，点「打开放行页」。</span><button class="hl-btn" data-hl="gate">打开放行页</button><button class="hl-btn" data-hl="check">重试</button></div>`;
    return `<div class="hl-banner ok"><span>通道正常 · 上次连通 ${clock(n.lastOkAt)} · ${n.peerSeen ? '家里 Hub ' + ago(n.peerSeen) + '在线' : '家里 Hub 还没来过（它每 3 分钟看一次）'}${data.link.outbox ? ` · 待发 ${data.link.outbox} 条` : ''}</span><button class="hl-btn" data-hl="check">立即检查</button></div>`;
  }
  function settingsView() {
    const s = data.settings;
    const models = [{ id: '', label: '默认（CodeAgent 配置里的模型）' }, ...(data.models || []).map(m => ({ id: m.id || m, label: m.label || m.id || m }))];
    if (s.model && !models.some(m => m.id === s.model)) models.push({ id: s.model, label: s.model });
    const opt = (list, cur) => list.map(x => `<option value="${esc(x.id)}"${x.id === cur ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
    return `<div class="hl-grid">
      <label>自动作答</label><div class="hl-row"><select data-hl-f="enabled"><option value="1"${s.enabled ? ' selected' : ''}>开：收到问题就开 CodeAgent 会话作答</option><option value="0"${s.enabled ? '' : ' selected'}>关：只收下问题，不作答</option></select></div>
      <label>只读方式</label><div class="hl-row"><select data-hl-f="strictReadOnly"><option value="1"${s.strictReadOnly !== false ? ' selected' : ''}>启动参数禁用命令行与改写工具（推荐）</option><option value="0"${s.strictReadOnly === false ? ' selected' : ''}>只靠说明约束（CodeAgent 不认上面的参数时用）</option></select></div>
      <label>代码位置</label><div><textarea rows="3" data-hl-f="codeRoots" placeholder="每行一个目录，例如 D:\\code\\l2">${esc(s.codeRoots.join('\n'))}</textarea><div class="hl-muted">第一行作为 CodeAgent 会话的工作目录，其余目录一并开放读取。</div></div>
      <label>模型</label><div class="hl-row"><select data-hl-f="model">${opt(models, s.model || '')}</select>
        思考<select data-hl-f="effort">${opt(['low', 'medium', 'high', 'max'].map(x => ({ id: x, label: { low: '低', medium: '中', high: '高', max: '最高' }[x] })), s.effort)}</select>
        同时<select data-hl-f="maxParallel">${opt([1, 2, 3, 4].map(x => ({ id: String(x), label: x + ' 个' })), String(s.maxParallel))}</select>
        检查间隔<select data-hl-f="pollSeconds">${opt([...new Set([15, 30, 60, 120, s.pollSeconds])].sort((a, b) => a - b).map(x => ({ id: String(x), label: x + ' 秒' })), String(s.pollSeconds))}</select></div>
      <label>给 CodeAgent<br>的说明</label><div><textarea rows="8" data-hl-f="instructions">${esc(s.instructions)}</textarea>
        <div class="hl-row hl-muted">每个新问题都以这段说明开头，后面自动接上代码位置和家里的问题。<button class="hl-link" data-hl="reset-instructions">恢复默认说明</button></div></div>
    </div><div class="hl-foot"><button class="hl-btn primary" data-hl="save">保存设置</button></div>`;
  }
  function threadsView() {
    const list = data.threads || [];
    if (!list.length) return '<p class="hl-muted">还没有收到家里的问题。</p>';
    return list.slice(0, 30).map(t => {
      const [label, tone] = STATE[t.state] || [t.state, ''];
      const rounds = t.rounds.map(r => `<div><b>第 ${r.round} 轮</b>${r.error ? ` <span class="hl-pill bad">${esc(r.error)}</span>` : ''}<pre>${esc(r.question)}</pre>${r.reply ? `<div class="hl-muted">回执（${clock(r.replyAt)}）</div><pre>${esc(r.reply)}</pre>` : ''}</div>`).join('');
      return `<div class="hl-item"><div class="hl-row"><span class="hl-pill ${tone}">${label}</span><b>${esc(t.id)}</b><span>${esc(t.title)}</span>
        <span style="flex:1"></span>${t.sessionId ? `<button class="hl-link" data-hl="open:${esc(t.sessionId)}">${t.session?.open ? '打开会话' : '找回会话'}</button>` : ''}${t.state === 'failed' ? `<button class="hl-link" data-hl="retry:${esc(t.id)}">重试</button>` : ''}</div>
        <div class="hl-muted">收到 ${clock(t.createdAt)} · ${t.rounds.length} 轮${t.from?.title ? ' · 来自家里会话「' + esc(t.from.title) + '」' : ''}</div>
        <details><summary class="hl-muted">看问答</summary>${rounds}</details></div>`;
    }).join('');
  }
  function render() {
    if (!dialog || !data) return;
    const paired = data.link.state === 'paired';
    const body = dialog.querySelector('.hl-body');
    const keep = editing && paired ? body.querySelector('[data-hl-sec="settings"]') : null;
    body.innerHTML = `${paired ? netView() : `<div class="hl-sec" style="border:0;margin:0;padding:0">${pairingView()}</div>${data.link.state === 'waiting-welcome' ? netView() : ''}`}
      ${paired ? `<div class="hl-sec" data-hl-sec="settings"><h3>设置</h3>${settingsView()}</div>
      <div class="hl-sec"><h3>家里的问题</h3>${threadsView()}</div>
      <div class="hl-sec hl-row"><span class="hl-muted" style="flex:1">配对于 ${clock(data.link.pairedAt)}。解除后家里需要重新生成配对码。</span><button class="hl-btn" data-hl="unpair">解除配对</button></div>` : ''}`;
    // 正在改设置时别把输入框刷掉
    if (keep) body.querySelector('[data-hl-sec="settings"]').replaceWith(keep);
    dialog.querySelector('.hl-state').textContent = { none: '未配对', 'waiting-welcome': '等待家里确认', paired: data.settings.enabled ? '已接通 · 自动作答' : '已接通 · 作答已关' }[data.link.state] || data.link.state;
  }
  async function load() { data = await call('bridge:status'); render(); }
  function field(name) { return dialog.querySelector(`[data-hl-f="${name}"]`); }
  async function act(name, button) {
    const [verb, arg] = name.split(/:(.*)/s);
    if (verb === 'close') { dialog.close(); return; }
    if (verb === 'open') {
      try { await call('bridge:open-session', { sessionId: arg }); dialog.close(); await window.__hubOpenSession?.(arg); }
      catch (error) { toast('打开会话失败：' + error.message); }
      return;
    }
    button && (button.disabled = true);
    try {
      if (verb === 'pair') { data = await call('bridge:pair', { code: field('code').value }); render(); toast('已发出配对请求，等家里 Hub 确认'); }
      else if (verb === 'check') { data = await call('bridge:check-now'); render(); }
      else if (verb === 'gate') { toast('放行页已打开：点完允许后关掉那个窗口'); data = await call('bridge:open-gate'); render(); }
      else if (verb === 'retry') { data = await call('bridge:retry', { id: arg }); render(); }
      else if (verb === 'cancel-pair') { data = await call('bridge:unpair'); render(); }
      else if (verb === 'unpair') { if (!window.confirm('解除和家里 Hub 的配对？之后家里需要重新生成配对码。')) return; data = await call('bridge:unpair'); render(); }
      else if (verb === 'reset-instructions') { field('instructions').value = data.defaultInstructions; editing = true; }
      else if (verb === 'save') {
        await call('bridge:set-settings', { enabled: field('enabled').value === '1', strictReadOnly: field('strictReadOnly').value === '1', codeRoots: field('codeRoots').value, model: field('model').value, effort: field('effort').value,
          maxParallel: Number(field('maxParallel').value), pollSeconds: Number(field('pollSeconds').value), instructions: field('instructions').value });
        editing = false; await load(); toast('家里联动设置已保存');
      }
    } catch (error) { toast(error.message); }
    finally { if (button && button.isConnected) button.disabled = false; }
  }
  function open() {
    if (!dialog) {
      const style = document.createElement('style'); style.textContent = css; document.head.append(style);
      dialog = document.createElement('dialog'); dialog.className = 'hl-dialog'; dialog.id = 'home-link-dialog';
      dialog.innerHTML = `<div class="hl-head"><strong>家里联动 <span class="hl-muted hl-state"></span></strong><button class="hl-x" data-hl="close" title="关闭">×</button></div><div class="hl-body"></div>`;
      document.body.append(dialog);
      dialog.addEventListener('click', e => { const b = e.target.closest('[data-hl]'); if (b) void act(b.dataset.hl, b); });
      dialog.addEventListener('input', e => { if (e.target.closest('[data-hl-sec="settings"]')) editing = true; });
      dialog.addEventListener('close', () => { editing = false; });
    }
    if (!dialog.open) dialog.showModal();
    void load().catch(e => toast('家里联动状态读取失败：' + e.message));
  }
  function addMenuEntry() {
    const menu = document.getElementById('options-menu');
    if (!menu || document.getElementById('options-home-link')) return;
    const item = document.createElement('div');
    item.className = 'options-item'; item.id = 'options-home-link'; item.textContent = '🏠 家里联动';
    item.addEventListener('click', () => { menu.style.display = 'none'; open(); });
    menu.appendChild(item);
  }
  ipcRenderer.invoke('bridge:status').then(status => {
    if (!status || status.role !== 'company') return;
    addMenuEntry();
    window.__homeLinkOpen = open;
    ipcRenderer.on('bridge:changed', () => { if (dialog?.open) void load().catch(() => {}); });
    ipcRenderer.on('bridge:notification', (_e, n) => { if (n?.text) toast(n.title + '：' + n.text); });
  }).catch(() => {});
})();
