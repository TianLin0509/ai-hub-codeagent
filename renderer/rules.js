'use strict';
/**
 * 规则 Tab（rules-panel，2026-10-12）—— 左侧导航「主页」和「助理」之间。
 *
 * 让用户随时看到 Hub 里的 Agent 默认带上了哪些规则：
 *   通用规则  服务器统一发布、本地只读；开关默认开（本机已有个人基础规则时默认关）；
 *             点「检查更新」才去服务器拉，拉到新版立即生效，可回到上一版
 *   我的规则  本机个人基础规则（USER_CONTEXT.md）或 Hub 里自己写的补充规则，可直接编辑
 *   场景      不同任务用不同的提示词（2026-10-13）：每个场景带什么、实际发给 AI 的全文、知识库索引、默认场景
 *   送达情况  每个会话最近一次带规则的消息：已送达 / 待确认 / 失败
 *
 * 数据都在主进程 main/ipc/hub-rules-handlers.js → core/hub-rules.js。
 */
(function () {
  const { ipcRenderer } = require('electron');
  const { lineDiff } = require('../core/hub-rules');
  const HUB_VERSION = (() => { try { return require('../package.json').version; } catch { return ''; } })();
  const VIEWS = [['official', '通用规则'], ['mine', '我的规则'], ['scenes', '场景'], ['delivery', '送达情况']];
  const DELIVERY = { system: ['启动时写进系统提示', 'ok'], sent: ['已送达', 'ok'], unconfirmed: ['已发出，待确认', ''], pending: ['发送中', ''], failed: ['发送失败', 'bad'] };
  const REASON = { launch: '会话启动时写入', new: '会话第一条消息', changed: '规则换版后补送', compacted: '上下文压缩后补送' };

  const S = { opened: false, view: 'official', data: null, officialMode: 'read', mineDraft: null, busy: false, lastUpdate: null,
    scenes: null, sceneSel: null, sceneMode: 'read', sceneDraft: null };
  let root = null;

  function h(tag, props, ...children) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return n;
  }
  async function call(name, args) {
    const r = await ipcRenderer.invoke('hub-rules:' + name, args || {});
    if (!r || !r.ok) throw new Error((r && r.error) || '调用失败');
    return r.data;
  }
  function toast(msg, bad) {
    // 最多同时留 3 条，新的在最下面，旧的往上挪
    const old = [...document.querySelectorAll('.rl-toast')];
    old.slice(0, Math.max(0, old.length - 2)).forEach(e => e.remove());
    const t = h('div', { class: 'rl-toast' + (bad ? ' bad' : ''), role: 'status', text: msg });
    document.body.appendChild(t);
    const restack = () => [...document.querySelectorAll('.rl-toast')].reverse().forEach((e, i) => { e.style.bottom = `${24 + i * 52}px`; });
    restack();
    setTimeout(() => { t.remove(); restack(); }, bad ? 7000 : 3200);
  }
  async function guarded(fn) {
    if (S.busy) return undefined;
    S.busy = true; paintBusy();
    try { return await fn(); } catch (e) { toast(e.message || String(e), true); return undefined; }
    finally { S.busy = false; paintBusy(); }
  }
  function paintBusy() { root?.querySelectorAll('[data-busy-lock]').forEach(b => { b.disabled = S.busy || b.dataset.disabledReason === 'true'; }); }
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  let _md = null;
  function renderMarkdown(el, text) {
    try {
      if (!_md) { const { marked } = require('marked'); const purify = require('dompurify'); _md = t => purify.sanitize(marked.parse(t, { gfm: true, breaks: false })); }
      el.innerHTML = _md(String(text || ''));
    } catch { el.textContent = String(text || ''); }
    return el;
  }
  function diffView(before, after) {
    const diff = lineDiff(before, after);
    if (!diff.rows) return h('div', { class: 'rl-muted', text: `改动较大：新增 ${diff.added} 行，删除 ${diff.removed} 行` });
    // 只显示改动行和前后各 2 行上下文，其余折叠成「…」
    const keep = new Set();
    diff.rows.forEach((r, i) => { if (r.type !== 'same') for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
    const lines = []; let gap = false;
    diff.rows.forEach((r, i) => {
      if (!keep.has(i)) { if (!gap) lines.push(h('div', { class: 'rl-diff-gap', text: '…' })); gap = true; return; }
      gap = false;
      lines.push(h('div', { class: 'rl-diff-line ' + r.type }, h('span', { class: 'mark', text: r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ' }), h('span', { class: 'txt', text: r.text || ' ' })));
    });
    return h('div', { class: 'rl-diff' },
      h('div', { class: 'rl-diff-sum' }, h('span', { class: 'add', text: `新增 ${diff.added} 行` }), h('span', { class: 'del', text: `删除 ${diff.removed} 行` })),
      diff.added + diff.removed ? lines : h('div', { class: 'rl-muted', text: '两版正文相同' }));
  }

  /* ─────────────── 骨架 ─────────────── */

  function buildSkeleton() {
    if (root) return;
    root = document.getElementById('rules-panel');
    if (!root) return;
    const tabs = h('div', { class: 'rl-tabs', role: 'tablist' }, ...VIEWS.map(([id, label]) =>
      h('button', { type: 'button', class: 'rl-tab', role: 'tab', 'data-view': id, onclick: () => switchView(id) }, label)));
    root.append(
      h('div', { class: 'rl-head' },
        h('div', { class: 'rl-title' }, h('h1', { text: '规则' }), h('div', { class: 'rl-sub', text: 'Hub 里的 Agent 默认带上的规则：在这里查看、开关和更新' })),
        tabs, h('span', { class: 'rl-spacer' }), h('span', { class: 'rl-version', text: HUB_VERSION ? `Hub ${HUB_VERSION}` : '' })),
      h('div', { class: 'rl-summary', id: 'rl-summary' }),
      h('div', { class: 'rl-body', id: 'rl-body' }));
  }

  // 切走「我的规则」时草稿留在内存里（S.mineDraft），切回来接着改，不弹对话框。
  function switchView(view) {
    S.view = view;
    root.querySelectorAll('.rl-tab').forEach(t => { const on = t.dataset.view === view; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); });
    paint();
  }

  async function load() {
    try { S.data = await call('snapshot'); }
    catch (e) { S.data = null; toast('读取规则失败：' + e.message, true); }
    await loadScenes();
    paint();
  }
  async function sceneCall(name, args) {
    const r = await ipcRenderer.invoke('session-scenes:' + name, args || {});
    if (!r || !r.ok) throw new Error((r && r.error) || '调用失败');
    return r.data;
  }
  async function loadScenes() {
    try { S.scenes = await sceneCall('snapshot'); }
    catch (e) { S.scenes = { scenes: [], error: e.message }; }
  }

  function mineDirty() { return S.mineDraft !== null && S.data && S.mineDraft !== S.data.mine.text; }

  /* ─────────────── 绘制 ─────────────── */

  function paint() {
    if (!root) return;
    const body = root.querySelector('#rl-body');
    paintSummary();
    if (!S.data) { body.replaceChildren(h('div', { class: 'rl-empty', text: '正在读取规则…' })); return; }
    body.replaceChildren(S.view === 'mine' ? mineView() : S.view === 'scenes' ? scenesView() : S.view === 'delivery' ? deliveryView() : officialView());
    paintBusy();
  }

  function paintSummary() {
    const el = root.querySelector('#rl-summary');
    const d = S.data;
    if (!d) { el.replaceChildren(); return; }
    const o = d.official, m = d.mine;
    const items = [
      h('span', { class: 'rl-chip ' + (o.enabled ? 'on' : 'off') }, h('b', { text: o.enabled ? '开' : '关' }), ` 通用规则 v${o.version}`),
      m.mode === 'personal'
        ? h('span', { class: 'rl-chip on' }, h('b', { text: '开' }), ' 我的规则（个人基础规则，已写入各 CLI）')
        : h('span', { class: 'rl-chip ' + (m.text.trim() ? 'on' : 'off') }, h('b', { text: m.text.trim() ? '开' : '空' }), ' 我的规则'),
    ];
    el.replaceChildren(h('span', { class: 'rl-summary-label', text: '当前生效' }), ...items,
      h('span', { class: 'rl-muted', text: 'Claude、CodeAgent 在会话启动时读入；其他 AI 随第一条消息读入，换版或上下文压缩后再送一次。' }));
  }

  function officialView() {
    const o = S.data.official;
    const sourceText = o.source === 'builtin' ? '随 Hub 内置' : `从服务器更新于 ${when(o.installedAt)}`;
    const toggle = h('button', { type: 'button', class: 'rl-switch' + (o.enabled ? ' on' : ''), role: 'switch', 'aria-checked': String(o.enabled), 'aria-label': '默认带上通用规则', 'data-busy-lock': true,
      onclick: () => guarded(async () => { S.data = await call('set-enabled', { enabled: !o.enabled }); toast(o.enabled ? '已关闭通用规则：之后的消息不再带上' : '已打开通用规则：每个会话的下一条消息会带上'); paint(); }) },
      h('span', { class: 'knob' }));
    const notes = [];
    if (!o.enabled) notes.push(o.enabledIsDefault && S.data.mine.mode === 'personal'
      ? '本机已有你的个人基础规则，内容更全，所以通用规则默认关闭，避免重复。需要时可以打开。'
      : '已关闭：之后的消息不再带上通用规则。已经带过的会话里 AI 仍记得之前的内容，新开会话就完全不带。');
    const check = o.lastCheck;
    const head = h('div', { class: 'rl-card rl-official-head' },
      h('div', { class: 'rl-row' },
        toggle,
        h('div', { class: 'rl-grow' },
          h('div', { class: 'rl-strong', text: '默认带上通用规则' }),
          h('div', { class: 'rl-muted', text: o.enabled ? '打开：每个会话的第一条消息都会带上这份规则' : '关闭：不带' })),
        h('div', { class: 'rl-ver' },
          h('div', { class: 'rl-ver-num', text: `v${o.version}` }),
          h('div', { class: 'rl-muted', text: `${sourceText}${o.publishedAt ? ' · 发布于 ' + String(o.publishedAt).slice(0, 10) : ''}` })),
        h('button', { type: 'button', class: 'rl-btn primary', id: 'rl-check-update', 'data-busy-lock': true, text: '检查更新', title: '到服务器看看有没有新版本；有就立即生效', onclick: checkUpdate }),
        h('button', { type: 'button', class: 'rl-btn', id: 'rl-rollback', 'data-busy-lock': true, 'data-disabled-reason': String(!o.previous), disabled: !o.previous,
          text: o.previous ? `回到上一版 v${o.previous.version}` : '回到上一版', title: o.previous ? '' : '还没有更新过，没有上一版',
          onclick: () => guarded(async () => { S.data = await call('rollback'); S.lastUpdate = null; toast(S.data.official.lastCheck?.message || '已回到上一版'); paint(); }) })),
      check ? h('div', { class: 'rl-check ' + (check.ok ? '' : 'bad'), id: 'rl-check-result', text: `${when(check.at)} · ${check.message}` }) : null,
      ...notes.map(t => h('div', { class: 'rl-note', text: t })),
      S.lastUpdate ? h('div', { class: 'rl-update' },
        h('div', { class: 'rl-strong', text: `已更新到 v${S.lastUpdate.to}（原来是 v${S.lastUpdate.from}）` }),
        S.lastUpdate.notes ? h('div', { text: '本版改动：' + S.lastUpdate.notes }) : null,
        h('div', { class: 'rl-muted', text: `新增 ${S.lastUpdate.added} 行，删除 ${S.lastUpdate.removed} 行。每个会话的下一条消息会带上新版。` })) : null);
    const modes = [['read', '排版'], ['raw', '原文'], ['diff', o.previous ? `和 v${o.previous.version} 对比` : '对比']];
    const modeBar = h('div', { class: 'rl-seg' }, ...modes.map(([id, label]) => h('button', { type: 'button', class: S.officialMode === id ? 'on' : '', disabled: id === 'diff' && !o.previousText,
      title: id === 'diff' && !o.previousText ? '还没有上一版可比' : '', onclick: () => { S.officialMode = id; paint(); } }, label)));
    let content;
    if (o.textError) content = h('div', { class: 'rl-note bad', text: o.textError });
    else if (S.officialMode === 'raw') content = h('pre', { class: 'rl-raw', text: o.text });
    else if (S.officialMode === 'diff' && o.previousText) content = diffView(o.previousText, o.text);
    else content = renderMarkdown(h('div', { class: 'rl-doc' }), o.text);
    const doc = h('div', { class: 'rl-card rl-doc-card' + (o.enabled ? '' : ' dim') },
      h('div', { class: 'rl-row rl-doc-head' }, h('div', { class: 'rl-strong', text: `通用规则正文 · v${o.version}` }), h('span', { class: 'rl-muted', text: `${(o.bytes / 1024).toFixed(1)} KB · 只读，由服务器统一发布` }), h('span', { class: 'rl-spacer' }), modeBar),
      content);
    return h('div', { class: 'rl-view rl-official' }, head, doc);
  }

  async function checkUpdate() {
    const btn = root.querySelector('#rl-check-update');
    if (btn) btn.textContent = '正在检查…';
    await guarded(async () => {
      const r = await call('check-update');
      S.data = r.snapshot;
      if (r.updated) { S.lastUpdate = { from: r.from, to: r.to, notes: r.notes, added: r.added, removed: r.removed }; toast(`已更新到 v${r.to}，立即生效`); }
      else toast(r.message, !!r.failed);
      paint();
    });
    if (btn && btn.isConnected) btn.textContent = '检查更新';
  }

  function mineView() {
    const m = S.data.mine;
    if (S.mineDraft === null) S.mineDraft = m.text;
    const intro = m.mode === 'personal'
      ? ['这是你本机的个人基础规则。Hub 新开会话时会把它写进 Claude、Codex 等 CLI 的全局规则文件。',
        m.syncScript ? '保存时先备份，再运行同步脚本复制到各 CLI。' : '保存时先备份；下次新开会话时 Hub 会写进各 CLI。']
      : ['写在这里的规则会和通用规则一起，随每个会话的第一条消息送给 AI。通用规则更新时不会覆盖这里。', '留空就是不加。'];
    const area = h('textarea', { class: 'rl-editor', id: 'rl-mine-editor', spellcheck: 'false', placeholder: '例如：回答一律用中文；代码注释写英文；提交前先跑测试……' });
    area.value = S.mineDraft;
    const preview = renderMarkdown(h('div', { class: 'rl-doc rl-preview' }), S.mineDraft);
    const status = h('span', { class: 'rl-muted', id: 'rl-mine-status' });
    const paintStatus = () => {
      const bytes = new TextEncoder().encode(area.value).length;
      status.textContent = `${(bytes / 1024).toFixed(1)} KB · ${mineDirty() ? '有未保存的修改' : '已保存'}`;
      status.classList.toggle('dirty', mineDirty());
    };
    let timer = null;
    area.addEventListener('input', () => {
      S.mineDraft = area.value; paintStatus();
      clearTimeout(timer); timer = setTimeout(() => renderMarkdown(preview, area.value), 150);
    });
    area.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveMine(); } });
    paintStatus();
    return h('div', { class: 'rl-view rl-mine' },
      h('div', { class: 'rl-card' },
        h('div', { class: 'rl-row' },
          h('div', { class: 'rl-grow' },
            h('div', { class: 'rl-strong', text: m.mode === 'personal' ? '我的规则 · 个人基础规则' : '我的规则 · 补充规则' }),
            ...intro.map(t => h('div', { class: 'rl-muted', text: t })),
            h('div', { class: 'rl-path', text: m.path })),
          h('button', { type: 'button', class: 'rl-btn primary', id: 'rl-mine-save', 'data-busy-lock': true, text: '保存', title: 'Ctrl+S', onclick: saveMine }),
          h('button', { type: 'button', class: 'rl-btn', 'data-busy-lock': true, text: '撤销修改', onclick: () => { S.mineDraft = S.data.mine.text; paint(); } }),
          h('button', { type: 'button', class: 'rl-btn', 'data-busy-lock': true, text: '重新载入', onclick: async () => { S.mineDraft = null; await load(); } }),
          h('button', { type: 'button', class: 'rl-btn', text: '打开文件夹', onclick: () => guarded(() => call('open-folder', { which: 'mine' })) })),
        m.error ? h('div', { class: 'rl-note bad', text: m.error }) : null),
      h('div', { class: 'rl-split' },
        h('div', { class: 'rl-card rl-pane' }, h('div', { class: 'rl-row rl-pane-head' }, h('span', { class: 'rl-strong', text: '编辑' }), h('span', { class: 'rl-spacer' }), status), area),
        h('div', { class: 'rl-card rl-pane' }, h('div', { class: 'rl-row rl-pane-head' }, h('span', { class: 'rl-strong', text: '预览' })), preview)));
  }

  async function saveMine() {
    if (!mineDirty()) { toast('没有修改'); return; }
    await guarded(async () => {
      const r = await call('save-mine', { text: S.mineDraft, baseSha: S.data.mine.sha });
      S.data = r.snapshot; S.mineDraft = S.data.mine.text;
      const sync = r.sync;
      toast(sync ? sync.message : '已保存：每个会话的下一条消息会带上新内容', sync && !sync.ok);
      paint();
    });
  }

  /* ─────────────── 场景（2026-10-13，数据见 core/session-scenes.js） ─────────────── */

  function sceneDirty(sc) { return S.sceneDraft !== null && sc && S.sceneDraft !== sc.body; }

  function scenesView() {
    const d = S.scenes;
    if (!d) return h('div', { class: 'rl-empty', text: '正在读取场景…' });
    if (!d.scenes || !d.scenes.length) {
      return h('div', { class: 'rl-view' }, h('div', { class: 'rl-card' },
        h('div', { class: 'rl-strong', text: '还没有场景' }),
        h('div', { class: 'rl-muted', text: '场景让不同任务用不同的提示词：讨论技术、投研、写作时不再带编程助手那一套。把场景文件放进下面的目录（每个场景一个 md，开头写 id 和 label）就会出现在这里，输入框也会多出「场景」按钮。' }),
        d.dir ? h('div', { class: 'rl-path', text: d.dir }) : null,
        d.error ? h('div', { class: 'rl-note bad', text: d.error }) : null));
    }
    if (!d.scenes.some(x => x.id === S.sceneSel)) S.sceneSel = d.defaultScene && d.scenes.some(x => x.id === d.defaultScene) ? d.defaultScene : d.scenes[0].id;
    const sc = d.scenes.find(x => x.id === S.sceneSel);
    const pick = id => {
      if (id === S.sceneSel) return;
      if (sceneDirty(sc)) { toast('「' + sc.label + '」有未保存的修改，先保存或撤销', true); return; }
      S.sceneSel = id; S.sceneDraft = null; if (S.sceneMode === 'edit' || S.sceneMode === 'kb') S.sceneMode = 'read'; paint();
    };
    const list = h('div', { class: 'rl-card rl-scene-list' },
      h('div', { class: 'rl-scene-default' }, h('label', { for: 'rl-scene-default', text: '新会话默认' }),
        h('select', { id: 'rl-scene-default', 'data-busy-lock': true, onchange: e => guarded(async () => {
          S.scenes = await sceneCall('set-default', { id: e.target.value });
          toast('之后新建的会话默认用「' + (S.scenes.scenes.find(x => x.id === e.target.value)?.label || e.target.value) + '」'); paint(); }) },
        ...d.scenes.map(x => { const o = h('option', { value: x.id, text: x.label }); if (x.id === d.defaultScene) o.selected = true; return o; }))),
      ...d.scenes.map(x => h('button', { type: 'button', class: 'rl-scene-item' + (x.id === S.sceneSel ? ' on' : ''), 'data-scene': x.id, onclick: () => pick(x.id) },
        h('span', { class: 'rl-scene-name' }, x.label,
          x.id === d.defaultScene ? h('span', { class: 'rl-pill', text: '默认' }) : null,
          x.knowledgeInfo ? h('span', { class: 'rl-pill ok', text: '知识库 ' + x.knowledgeInfo.entries + ' 条' }) : null),
        h('span', { class: 'rl-muted', text: x.desc }))));
    return h('div', { class: 'rl-view rl-scenes' }, h('div', { class: 'rl-scene-grid' }, list, sceneDetail(sc)));
  }

  function sceneDetail(sc) {
    const coding = sc.id === 'coding';
    const kb = sc.knowledgeInfo;
    const rows = coding
      ? [['加载什么', '和现在完全一样：全局个人规则、输出风格、技能、MCP、通用规则都照常带']]
      : [['关于用户', sc.base || '个人规则里「身份与沟通」「用户说明书（摘要）」两节，启动时现截'],
        ['工程规则', sc.engineering || '不带'], ['输出风格', sc.outputStyle || '默认（格式写在场景里）'],
        ['工具', sc.tools || '读写文件、检索、联网'], ['技能', sc.skills || '不带'],
        ['知识库', kb ? `${kb.name}：${kb.entries} 条结论，索引 ${kb.indexEntries} 条（${(kb.indexBytes / 1024).toFixed(1)} KB，每轮都带），正文按需读` : '不挂'],
        ['生效时机', '新开的会话；已经聊过的会话换场景会新开一个并引用原会话']];
    const modes = [['read', '排版'], ['edit', '编辑'], ['sent', '实际发送内容']].concat(kb ? [['kb', '知识库索引']] : []);
    const modeBar = coding ? null : h('div', { class: 'rl-seg', id: 'rl-scene-modes' }, ...modes.map(([id, label]) => h('button', { type: 'button', 'data-mode': id, class: S.sceneMode === id ? 'on' : '',
      onclick: () => { S.sceneMode = id; paint(); } }, label)));
    let content;
    if (coding) content = h('div', { class: 'rl-muted', text: '编程开发是默认场景，不额外加载任何东西。要改编程时的规则，去「我的规则」。' });
    else if (sc.error && S.sceneMode !== 'edit') content = h('div', { class: 'rl-note bad', text: sc.error });
    else if (S.sceneMode === 'sent') content = h('pre', { class: 'rl-raw', id: 'rl-scene-sent', text: sc.sent });
    else if (S.sceneMode === 'kb' && kb) content = renderMarkdown(h('div', { class: 'rl-doc', id: 'rl-scene-kb' }), kb.index);
    else if (S.sceneMode === 'edit') content = sceneEditor(sc);
    else content = renderMarkdown(h('div', { class: 'rl-doc' }), sc.body);
    const sizeText = coding ? '' : `实际发送 ${(sc.sentBytes / 1024).toFixed(1)} KB`;
    return h('div', { class: 'rl-scene-detail' },
      h('div', { class: 'rl-card' },
        h('div', { class: 'rl-row' }, h('div', { class: 'rl-grow' }, h('div', { class: 'rl-strong', text: sc.label }), h('div', { class: 'rl-muted', text: sc.desc })),
          sc.file ? h('button', { type: 'button', class: 'rl-btn', text: '打开场景文件夹', onclick: () => guarded(() => sceneCall('open-folder', { id: sc.id, which: 'scenes' })) }) : null,
          kb ? h('button', { type: 'button', class: 'rl-btn', text: '打开知识库', onclick: () => guarded(() => sceneCall('open-folder', { id: sc.id, which: 'knowledge' })) }) : null),
        h('table', { class: 'rl-table rl-scene-load' }, h('tbody', null, ...rows.map(([k, v]) => h('tr', null, h('th', { text: k }), h('td', { text: v })))))),
      h('div', { class: 'rl-card rl-doc-card' },
        h('div', { class: 'rl-row rl-doc-head' }, h('div', { class: 'rl-strong', text: coding ? '提示词' : '场景提示词' }), h('span', { class: 'rl-muted', text: sizeText }), h('span', { class: 'rl-spacer' }), modeBar),
        content,
        sc.file ? h('div', { class: 'rl-path', text: sc.file }) : null));
  }

  function sceneEditor(sc) {
    if (S.sceneDraft === null) S.sceneDraft = sc.body;
    const area = h('textarea', { class: 'rl-editor', id: 'rl-scene-editor', spellcheck: 'false' });
    area.value = S.sceneDraft;
    const status = h('span', { class: 'rl-muted', id: 'rl-scene-status' });
    const paintStatus = () => { status.textContent = sceneDirty(sc) ? '有未保存的修改' : '已保存'; status.classList.toggle('dirty', sceneDirty(sc)); };
    area.addEventListener('input', () => { S.sceneDraft = area.value; paintStatus(); });
    const save = () => {
      if (!sceneDirty(sc)) { toast('没有修改'); return; }
      guarded(async () => {
        S.scenes = await sceneCall('save', { id: sc.id, body: S.sceneDraft, baseSha: sc.bodySha });
        S.sceneDraft = null; toast('已保存「' + sc.label + '」：从下一个新开的该场景会话起生效（旧版备份在 _history）'); paint();
      });
    };
    area.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
    paintStatus();
    return h('div', { class: 'rl-scene-edit' },
      h('div', { class: 'rl-row' }, status, h('span', { class: 'rl-spacer' }),
        h('button', { type: 'button', class: 'rl-btn', 'data-busy-lock': true, text: '撤销修改', onclick: () => { S.sceneDraft = null; paint(); } }),
        h('button', { type: 'button', class: 'rl-btn primary', id: 'rl-scene-save', 'data-busy-lock': true, text: '保存', title: 'Ctrl+S', onclick: save })),
      area);
  }

  function deliveryView() {
    const rows = S.data.deliveries || [];
    const table = rows.length ? h('table', { class: 'rl-table' },
      h('thead', null, h('tr', null, ...['会话', 'CLI', '状态', '带的规则', '原因', '时间'].map(t => h('th', { text: t })))),
      h('tbody', null, ...rows.map(r => {
        const [label, cls] = r.status ? (DELIVERY[r.status] || [r.status, '']) : ['还没带过', 'muted'];
        return h('tr', null, h('td', { text: r.title || r.sessionId }), h('td', { text: r.kind }), h('td', null, h('span', { class: 'rl-pill ' + cls, text: label })),
          h('td', { text: r.label || '—' }), h('td', { text: r.reason ? (REASON[r.reason] || r.reason) : '—' }), h('td', { text: r.at ? when(r.at) : '—' }));
      }))) : h('div', { class: 'rl-empty', text: '还没有打开的 AI 会话' });
    return h('div', { class: 'rl-view' },
      h('div', { class: 'rl-card' },
        h('div', { class: 'rl-row' }, h('div', { class: 'rl-grow' },
          h('div', { class: 'rl-strong', text: '每个会话最近一次带规则的情况' }),
          h('div', { class: 'rl-muted', text: 'Claude、CodeAgent 会话在启动时把规则写进系统提示；其他 AI 随第一条消息送达，「已送达」表示在对话记录里确认看到了规则。「还没带过」的会话会在下一条消息带上。个人基础规则由 CLI 自己读取，不在这张表里。' })),
          h('button', { type: 'button', class: 'rl-btn', 'data-busy-lock': true, text: '刷新', onclick: () => guarded(load) })),
        table));
  }

  /* ─────────────── 显隐 ─────────────── */

  function setPanelVisible(visible) {
    buildSkeleton();
    if (!root) return;
    S.opened = visible;
    document.body.classList.toggle('rules-open', visible);
    if (visible) window.hubWorkspaces?.close();
    root.style.display = visible ? 'flex' : 'none';
    const btn = document.getElementById('btn-rules');
    if (btn) { btn.classList.toggle('active', visible); if (visible) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current'); }
    if (visible) {
      const home = document.getElementById('btn-home');
      if (home) { home.classList.remove('active'); home.removeAttribute('aria-current'); }
      window.__xresearchHide?.(); window.__studyHide?.(); window.__writingHide?.(); window.__ranHide?.(); window.__assistantHide?.(); window.__wirelessHide?.();
      for (const id of ['terminal-panel', 'meeting-room-panel']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
      const accountPage = document.getElementById('account-page');
      if (accountPage && !accountPage.hidden) document.getElementById('btn-rail-accounts')?.click();
      switchView(S.view);
      load();
    }
  }

  window.__rulesHide = function () { if (S.opened) setPanelVisible(false); };
  window.__rulesShow = function () { setPanelVisible(true); };

  function init() {
    buildSkeleton();
    document.querySelectorAll('#btn-rules, [data-rules-entry]').forEach(b => b.addEventListener('click', () => setPanelVisible(true)));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
