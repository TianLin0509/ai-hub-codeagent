'use strict';
// 卡片上的「🔍 查看完整 Prompt」面板 + raw 原文预览。
//
// 展示的是「以这个会话的 cwd 起会话时，CLI 会注入哪些本地来源」——CLAUDE.md 链、
// AGENTS.md 链、记忆桶状态、以及它们各自的字节数。所有判定逻辑在主进程的
// core/prompt-inspect.js 里（有单测），这里只负责画。
//
// 2026-07-29 起每一条来源都可以点开看**磁盘上的真实全文**：
//   - 单文件预览：绝对路径 + 字节数 + sha256 前 12 位 + mtime，用户可以自己
//     Get-FileHash 对一遍；超大文件分段加载并明确写出「已显示 X/Y 字节」。
//   - 完整拼装预览：按实测注入顺序把规则块拼成一整段，标出每段起止字节偏移。
//
// 诚实边界（三档，UI 上有对应徽章，不许含糊）：
//   磁盘实读原文 —— CLAUDE.md 链 / @import / AGENTS.md / MEMORY.md 的正文
//   还原的顺序   —— 拼装顺序按抓包实测规则重建；@import 与记忆索引的插入位置只是近似
//   拿不到       —— CLI 内置系统提示词、工具定义、请求瞬间现算的环境块
// 最后一档只写「拿不到 + 为什么」，**绝不合成一段假文本冒充真实系统提示词**。

(function () {
  const win = typeof window !== 'undefined' ? window : globalThis;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

  const SOURCE_LABEL = {
    'user-global': '全局',
    'project': '项目',
    'local': '私有未入库',
  };

  const MEM_STATE = {
    LINKED: ['ok', '已链到规范库'],
    WRONG_LINK: ['bad', '链接指向别处'],
    PRIVATE_REAL: ['warn', '独立记忆'],
    EMPTY_REAL: ['bad', '空目录·永久不共享'],
    NOBUCKET: ['warn', '尚无记忆桶'],
  };

  const CHUNK = 262144; // 与主进程 RAW_MAX_SLICE 对齐

  function ipcOf() {
    return win.ipcRenderer || (typeof require === 'function' ? require('electron').ipcRenderer : null);
  }

  // 可点击行：统一加 pi-clickable + data-pi-path，视觉上给个 👁 提示，
  // 否则用户根本不知道这一行能点。
  // 返回的是「属性串」，不含结尾的 '>'，调用点自己闭合，方便再追加 style。
  function clickAttrs(filePath, label) {
    if (!filePath) return ' class="pi-row"';
    return ' class="pi-row pi-clickable" role="button" tabindex="0"'
      + ` data-pi-path="${esc(filePath)}" data-pi-label="${esc(label || filePath)}"`
      + ' title="点击查看磁盘上的真实全文"';
  }

  function renderChecks(health) {
    if (!health || !health.length) return '';
    const items = health.map(c => `
      <div class="pi-chk ${esc(c.level)}">
        <b>${esc(c.title)}</b>
        <span>${esc(c.detail)}</span>
      </div>`).join('');
    return `<div class="pi-sec"><h5>注入体检</h5><div class="pi-checks">${items}</div></div>`;
  }

  function renderBudget(d) {
    const rule = d.totals.ruleBytes || 0;
    const mem = d.totals.memoryIndexBytes || 0;
    const total = rule + mem || 1;
    const pRule = Math.round(rule / total * 100);
    const pMem = 100 - pRule;
    return `<div class="pi-sec">
      <h5>你可控部分的体量</h5>
      <div class="pi-bar">
        <i style="width:${pRule}%;background:var(--accent-blue)"></i>
        <i style="width:${pMem}%;background:var(--ui-purple-2)"></i>
      </div>
      <div class="pi-legend">
        <span><i class="pi-sq" style="background:var(--accent-blue)"></i>规则文件 ${fmtBytes(rule)}</span>
        <span><i class="pi-sq" style="background:var(--ui-purple-2)"></i>记忆索引 ${fmtBytes(mem)}</span>
        <span>合计 ≈ ${d.totals.approxRuleTokens + Math.round(mem / 3.2)} tokens（粗估）</span>
      </div>
    </div>`;
  }

  function renderImports(imports) {
    if (!imports || !imports.length) return '';
    return imports.map(im => {
      const tag = im.absolute
        ? '<span class="pi-tag bad">绝对路径·不展开</span>'
        : (im.exists ? '<span class="pi-tag ok">已展开</span>' : '<span class="pi-tag bad">目标不存在</span>');
      const attrs = im.exists ? clickAttrs(im.resolved, `@${im.spec}`) : ' class="pi-row"';
      return `<div${attrs} style="margin-left:14px">
        <span class="pi-tag">@import</span>${tag}
        <span class="pi-path">${esc(im.spec)}</span>
        <span class="pi-sz">${im.exists ? fmtBytes(im.bytes) : '—'}</span>
        ${im.exists ? '<span class="pi-eye">👁 原文</span>' : ''}
      </div>`;
    }).join('');
  }

  function renderClaudeGroup(d) {
    const entries = d.claude.entries || [];
    const total = entries.reduce((s, e) => s + e.bytes, 0);
    const rows = entries.map(e => `
      <div class="pi-item">
        <div${clickAttrs(e.path, e.path)}>
          <span class="pi-tag">${esc(SOURCE_LABEL[e.source] || e.source)}</span>
          <span class="pi-path">${esc(e.path)}</span>
          <span class="pi-sz">${fmtBytes(e.bytes)}</span>
          <span class="pi-eye">👁 原文</span>
        </div>
        ${renderImports(e.imports)}
      </div>`).join('') || '<div class="pi-item"><span class="pi-path">（无）</span></div>';

    const orphans = (d.orphanAgents || []).map(o => `
      <div class="pi-item">
        <div${clickAttrs(o.path, o.path)}>
          <span class="pi-tag bad">读不到</span>
          <span class="pi-path">${esc(o.path)}</span>
          <span class="pi-sz">${fmtBytes(o.bytes)}</span>
          <span class="pi-eye">👁 原文</span>
        </div>
      </div>`).join('');

    return `<details class="pi-grp" open>
      <summary><span class="pi-gname">CLAUDE.md 链</span>
        <span class="pi-gmeta">${entries.length} 份 · ${fmtBytes(total)}</span></summary>
      <div class="pi-gbody">
        <div class="pi-why">从 cwd 一路向上收集到盘符根，<b>不受 git 边界限制</b>；顺序从外到内，越靠内越晚出现、实际优先级越高。<b>点任意一行看磁盘原文。</b></div>
        ${rows}
        ${orphans ? `<div class="pi-why">下面这些 AGENTS.md 就在路径上，但 Claude 从不自动读。想让它生效，在同目录放一个 CLAUDE.md 写一行 <code>@AGENTS.md</code>。</div>${orphans}` : ''}
      </div>
    </details>`;
  }

  function renderCodexGroup(d) {
    const cx = d.codex || { entries: [] };
    const entries = cx.entries || [];
    const total = entries.reduce((s, e) => s + e.bytes, 0);
    const rows = entries.map(e => `
      <div class="pi-item">
        <div${clickAttrs(e.path, e.path)}>
          <span class="pi-tag">${esc(SOURCE_LABEL[e.source] || e.source)}</span>
          <span class="pi-path">${esc(e.path)}</span>
          <span class="pi-sz">${fmtBytes(e.bytes)}</span>
          <span class="pi-eye">👁 原文</span>
        </div>
      </div>`).join('') || '<div class="pi-item"><span class="pi-path">（无）</span></div>';

    return `<details class="pi-grp" open>
      <summary><span class="pi-gname">AGENTS.md 链</span>
        <span class="pi-gmeta">${entries.length} 份 · ${fmtBytes(total)}</span></summary>
      <div class="pi-gbody">
        <div class="pi-why">Codex 从 project root 向下收集到 cwd，<b>不越过 root</b>。当前 root =
          <code>${esc(cx.projectRoot || '未找到')}</code>，markers = <code>[${esc((cx.markers || []).join(', '))}]</code>
          ${cx.markersConfigured ? '（已在 config.toml 配置）' : '（默认值）'}。<b>点任意一行看磁盘原文。</b></div>
        ${rows}
      </div>
    </details>`;
  }

  function renderKimiGroup(d) {
    const km = d.kimi || { entries: [] };
    const entries = km.entries || [];
    const total = entries.reduce((s, e) => s + e.bytes, 0);
    const rows = entries.map(e => `
      <div class="pi-item">
        <div${clickAttrs(e.path, e.path)}>
          <span class="pi-tag">${esc(SOURCE_LABEL[e.source] || e.source)}</span>
          <span class="pi-path">${esc(e.path)}</span>
          <span class="pi-sz">${fmtBytes(e.bytes)}</span>
          <span class="pi-eye">👁 原文</span>
        </div>
      </div>`).join('') || '<div class="pi-item"><span class="pi-path">（无）</span></div>';

    return `<details class="pi-grp" open>
      <summary><span class="pi-gname">AGENTS.md 链（Kimi）</span>
        <span class="pi-gmeta">${entries.length} 份 · ${fmtBytes(total)}</span></summary>
      <div class="pi-gbody">
        <div class="pi-why">Kimi 从最近的 <b>.git 根</b>向下收集到 cwd，不越过该根（嵌套 git 仓库会挡住外层）；
          <b>没有 .git 时只读 cwd 自己那一份</b>（2026-07-29 探针 + wire.jsonl 实测）。当前 root =
          <code>${esc(km.projectRoot || '未找到')}</code>，markers = <code>[.git]</code>（固定值，无配置项）。
          全局记忆 = <code>~/.kimi-code/AGENTS.md</code>。<b>点任意一行看磁盘原文。</b></div>
        ${rows}
      </div>
    </details>`;
  }

  function renderKimiMemoryNote() {
    return `<details class="pi-grp">
      <summary><span class="pi-gname">记忆</span>
        <span class="pi-gmeta">无记忆桶机制</span></summary>
      <div class="pi-gbody">
        <div class="pi-why">Kimi Code 没有 Claude 式 memory 桶（官方文档无 /memory 命令，2026-07-29 核实）。
          它的「记忆」就是 AGENTS.md 文件：全局靠 <code>~/.kimi-code/AGENTS.md</code>，项目级靠上面链里的那些。
          想沉淀项目记忆，用 <code>/init</code> 生成或让 Kimi 直接改 AGENTS.md。</div>
      </div>
    </details>`;
  }

  function renderCodexMemoryNote() {
    return `<details class="pi-grp">
      <summary><span class="pi-gname">记忆</span>
        <span class="pi-gmeta">不使用 Claude memory 桶</span></summary>
      <div class="pi-gbody">
        <div class="pi-why">Codex 不读取 <code>~/.claude/projects/*/memory</code>。
          上面的 <code>AGENTS.md</code> 链是 Hub 当前能从磁盘确定还原的规则来源；
          Codex CLI 内部动态拼装、但未暴露给 Hub 的记忆上下文不在这里冒充展示。</div>
      </div>
    </details>`;
  }

  function renderMemoryGroup(d) {
    const m = d.memory;
    const [lvl, label] = MEM_STATE[m.state] || ['warn', m.state];
    const indexRow = m.indexBytes > 0
      ? `<div class="pi-item">
          <div${clickAttrs(m.indexPath, 'MEMORY.md')}>
            <span class="pi-tag ok">进 prompt</span>
            <span class="pi-path">${esc(m.indexPath)}</span>
            <span class="pi-sz">${fmtBytes(m.indexBytes)}</span>
            <span class="pi-eye">👁 原文</span>
          </div>
        </div>`
      : '';
    return `<details class="pi-grp" open>
      <summary><span class="pi-gname">记忆</span>
        <span class="pi-gmeta">${m.files} 条 · 索引 ${fmtBytes(m.indexBytes)}</span></summary>
      <div class="pi-gbody">
        <div class="pi-why">记忆桶按 <b>cwd 的真实路径</b>分，不按会话分。同一个 cwd 的所有会话共享一个桶；换目录就换桶。<b>只有索引 MEMORY.md 进 prompt</b>，正文按需读取。</div>
        <div class="pi-item">
          <div class="pi-row"><span class="pi-tag ${lvl}">${esc(label)}</span>
            <span class="pi-path">${esc(m.memoryDir)}</span>
            <span class="pi-sz">${m.files} 条</span></div>
        </div>
        ${indexRow}
        <div class="pi-item">
          <div class="pi-row"><span class="pi-tag">桶名</span><span class="pi-path">${esc(m.slug)}</span></div>
        </div>
        ${m.linkTarget ? `<div class="pi-item"><div class="pi-row"><span class="pi-tag ok">指向</span>
          <span class="pi-path">${esc(m.linkTarget)}</span></div></div>` : ''}
        ${m.state === 'WRONG_LINK'
          ? `<div class="pi-why">这条链接不会被 Hub 擅自覆盖。请先确认它是否包含独有记忆，再决定是否改回规范库 <span class="pi-path">${esc(m.canonicalDir)}</span>。</div>`
          : (m.state === 'NOBUCKET' || m.state === 'EMPTY_REAL'
            ? `<div class="pi-why">规范库在 <span class="pi-path">${esc(m.canonicalDir)}</span>。下次 Claude/DeepSeek 会话启动时 Hub 会自动建链；真实目录会先合并并留备份，不需要手工删除。</div>` : '')}
      </div>
    </details>`;
  }

  function renderCwdGroup(d) {
    const c = d.claude || {};
    return `<details class="pi-grp">
      <summary><span class="pi-gname">工作目录解析</span>
        <span class="pi-gmeta">${c.junctionResolved ? 'junction 已解析' : '直连'}</span></summary>
      <div class="pi-gbody">
        <div class="pi-item"><div class="pi-row"><span class="pi-tag">会话 cwd</span>
          <span class="pi-path">${esc(d.cwd)}</span></div></div>
        <div class="pi-item"><div class="pi-row"><span class="pi-tag ${c.junctionResolved ? 'warn' : 'ok'}">真实路径</span>
          <span class="pi-path">${esc(c.realCwd || d.cwd)}</span></div></div>
        ${c.junctionResolved ? `<div class="pi-why">Claude 会按<b>真实路径</b>算记忆桶，Codex 按<b>字面路径</b>——同一个项目从两条路径打开，Codex 会分裂成两套记忆。</div>` : ''}
      </div>
    </details>`;
  }

  // 三档诚实标注。这块是这个面板的信誉所在，任何时候都要显式展示。
  function renderTruthLegend() {
    return `<div class="pi-sec">
      <h5>这里的内容有多真</h5>
      <div class="pi-truth">
        <div class="pi-truth-item ok"><b>磁盘实读原文</b>
          <span>CLAUDE.md 链 / @import / AGENTS.md / MEMORY.md 的正文，点开就是 fs 直读的字节，附 sha256 前 12 位与 mtime，可自行 <code>Get-FileHash</code> 复核。</span></div>
        <div class="pi-truth-item warn"><b>按实测规则还原的顺序</b>
          <span>拼装顺序来自对两个 CLI 的抓包实测；<code>@import</code> 展开位置与记忆索引的插入位置只是近似，已在拼装预览里逐段标注。</span></div>
        <div class="pi-truth-item bad"><b>拿不到</b>
          <span>CLI 内置系统提示词、工具定义、发请求瞬间现算的环境块——不落磁盘，Hub 读不到，<b>这里不会编一段假的顶上</b>。</span></div>
      </div>
    </div>`;
  }

  function renderInspection(d) {
    const isCodex = d.kind === 'codex' || d.kind === 'deepseek';
    const isKimi = d.kind === 'kimi';
    return `
      <div class="pi-head">
        <span class="pi-title">这个 cwd 会注入什么</span>
        <span class="pi-sub">${esc(d.kind)} · <code>${esc(d.cwd)}</code></span>
        <button class="pi-btn" data-pi-assemble type="button">🧩 完整拼装预览</button>
      </div>
      ${renderChecks(d.health)}
      ${renderBudget(d)}
      <div class="pi-sec">
        <h5>逐项来源<span class="pi-hint">（点任意一行看磁盘原文）</span></h5>
        ${isCodex ? renderCodexGroup(d) : isKimi ? renderKimiGroup(d) : renderClaudeGroup(d)}
        ${isCodex ? renderCodexMemoryNote() : isKimi ? renderKimiMemoryNote() : renderMemoryGroup(d)}
        ${renderCwdGroup(d)}
      </div>
      ${renderTruthLegend()}
      <div class="pi-foot">内置系统提示词与工具定义由 CLI 自己拼装、不落磁盘，无法读取，故此处只标注、不展示。</div>`;
  }

  // ---------------- raw 预览 modal ----------------
  // 用内嵌 overlay div，绝不用 alert/confirm（会阻塞 Electron 主线程）。

  function closeModal() {
    const old = document.querySelector('.pi-modal-overlay');
    if (old) old.remove();
    if (win._piEscHandler) {
      document.removeEventListener('keydown', win._piEscHandler, true);
      win._piEscHandler = null;
    }
  }

  function mountModal(title, subtitle) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'pi-modal-overlay';
    overlay.innerHTML = `
      <div class="pi-modal" role="dialog" aria-modal="true">
        <div class="pi-modal-head">
          <div class="pi-modal-titles">
            <div class="pi-modal-title">${esc(title)}</div>
            <div class="pi-modal-sub">${esc(subtitle || '')}</div>
          </div>
          <button class="pi-modal-close" data-pi-close type="button" title="关闭">✕</button>
        </div>
        <div class="pi-modal-meta"></div>
        <div class="pi-modal-body"><div class="pi-loading">读取中…</div></div>
        <div class="pi-modal-foot">
          <span class="pi-modal-status"></span>
          <span class="pi-modal-actions"></span>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay || ev.target.closest('[data-pi-close]')) closeModal();
    });
    win._piEscHandler = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeModal(); } };
    document.addEventListener('keydown', win._piEscHandler, true);
    return overlay;
  }

  function metaLine(d) {
    // 校验信息一行给全：用户拿 sha256 前 12 位就能自己 Get-FileHash 对账。
    return `<span class="pi-mtag">路径</span><code class="pi-mval pi-mpath">${esc(d.path)}</code>
      <span class="pi-mtag">字节</span><code class="pi-mval">${d.totalBytes}</code>
      <span class="pi-mtag">sha256[0:12]</span><code class="pi-mval pi-sha">${esc(d.sha256_12 || '')}</code>
      <span class="pi-mtag">mtime</span><code class="pi-mval">${esc(d.mtime || '')}</code>
      <span class="pi-verify">自行复核：<code>(Get-FileHash -Algorithm SHA256 "${esc(d.path)}").Hash.Substring(0,12)</code>（大小写不敏感）</span>`;
  }

  async function copyText(btn, text) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = '✓ 已复制';
      setTimeout(() => { btn.textContent = old; }, 1500);
    } catch {
      btn.textContent = '复制失败';
    }
  }

  // 单文件原文预览。大文件按 CHUNK 分段续读，状态栏永远写清「已显示 X/Y 字节」。
  async function openRawPreview(ctx, filePath, label) {
    const overlay = mountModal(label || filePath, '磁盘实读原文 · fs 直读，未做任何加工');
    const metaEl = overlay.querySelector('.pi-modal-meta');
    const bodyEl = overlay.querySelector('.pi-modal-body');
    const statusEl = overlay.querySelector('.pi-modal-status');
    const actionsEl = overlay.querySelector('.pi-modal-actions');

    const state = { text: '', offset: 0, loaded: 0, total: 0, eof: false, path: filePath };

    async function fetchChunk() {
      const ipc = ipcOf();
      if (!ipc) throw new Error('ipcRenderer 不可用');
      return ipc.invoke('prompt-inspect-raw', {
        sessionId: ctx.sessionId, cwd: ctx.cwd, kind: ctx.kind,
        path: filePath, offset: state.offset, limit: CHUNK,
      });
    }

    function paint() {
      bodyEl.innerHTML = `<pre class="pi-raw">${esc(state.text)}</pre>`;
      statusEl.textContent = state.eof
        ? `已显示全部 ${state.total} / ${state.total} 字节`
        : `已显示 ${state.loaded} / ${state.total} 字节（未完，可继续加载）`;
      actionsEl.innerHTML = `
        ${state.eof ? '' : '<button class="pi-btn" data-pi-more type="button">继续加载下一段</button>'}
        <button class="pi-btn" data-pi-copy type="button">复制原文</button>`;
      const more = actionsEl.querySelector('[data-pi-more]');
      if (more) more.addEventListener('click', () => { more.disabled = true; load(); });
      actionsEl.querySelector('[data-pi-copy]').addEventListener('click', (ev) => copyText(ev.currentTarget, state.text));
    }

    async function load() {
      let res = null;
      try {
        res = await fetchChunk();
      } catch (err) {
        bodyEl.innerHTML = `<div class="pi-err">读取失败：${esc(err && err.message ? err.message : err)}</div>`;
        return;
      }
      if (!res || !res.ok) {
        bodyEl.innerHTML = `<div class="pi-err">读取失败（${esc((res && res.code) || 'ERROR')}）：${esc((res && res.error) || '未知错误')}</div>`;
        statusEl.textContent = '';
        actionsEl.innerHTML = '';
        return;
      }
      const d = res.data;
      metaEl.innerHTML = metaLine(d);
      state.text += d.text;
      state.total = d.totalBytes;
      state.loaded = d.end;
      state.offset = d.end;
      state.eof = !!d.eof;
      paint();
    }

    await load();
    return overlay;
  }

  const ORDER_TAG = {
    measured: '<span class="pi-tag ok" title="顺序由抓包实测确认">顺序·实测</span>',
    approx: '<span class="pi-tag warn" title="插入位置只是近似，CLI 内部实际位置未知">顺序·近似</span>',
  };

  // 完整拼装预览：按真实注入顺序拼成一段，每段标出 [start, end) 字节偏移。
  async function openAssemblyPreview(ctx) {
    const overlay = mountModal('完整拼装预览', '内容=磁盘实读原文；顺序=按实测规则还原');
    const metaEl = overlay.querySelector('.pi-modal-meta');
    const bodyEl = overlay.querySelector('.pi-modal-body');
    const statusEl = overlay.querySelector('.pi-modal-status');
    const actionsEl = overlay.querySelector('.pi-modal-actions');

    let res = null;
    try {
      const ipc = ipcOf();
      if (!ipc) throw new Error('ipcRenderer 不可用');
      res = await ipc.invoke('prompt-inspect-assemble', { sessionId: ctx.sessionId, cwd: ctx.cwd, kind: ctx.kind });
    } catch (err) {
      bodyEl.innerHTML = `<div class="pi-err">拼装失败：${esc(err && err.message ? err.message : err)}</div>`;
      return overlay;
    }
    if (!res || !res.ok) {
      bodyEl.innerHTML = `<div class="pi-err">拼装失败（${esc((res && res.code) || 'ERROR')}）：${esc((res && res.error) || '未知错误')}</div>`;
      return overlay;
    }

    const d = res.data;
    const segs = d.segments || [];
    metaEl.innerHTML = `<span class="pi-mtag">cwd</span><code class="pi-mval pi-mpath">${esc(d.cwd || '')}</code>
      <span class="pi-mtag">段数</span><code class="pi-mval">${d.segmentCount}</code>
      <span class="pi-mtag">拼装总字节</span><code class="pi-mval">${d.totalBytes}</code>
      <span class="pi-verify">${esc(d.note || '')}</span>`;

    const index = segs.map((s, i) => `
      <div class="pi-row pi-asm-idx${s.missing ? ' missing' : ''}${s.duplicateOf ? ' duplicate' : ''}">
        <span class="pi-tag">#${i + 1}</span>
        ${ORDER_TAG[s.orderTruth] || ''}
        <span class="pi-path">${esc(s.label)}</span>
        <span class="pi-sz">${s.missing ? '读不到' : s.duplicateOf ? '已按路径去重' : `[${s.start}, ${s.end}) · ${s.bytes} B`}</span>
      </div>`).join('');

    const blocks = segs.map((s, i) => {
      if (s.duplicateOf) {
        return `<div class="pi-asm-seg"><div class="pi-seg-hdr warn">#${i + 1} ${esc(s.label)} · 已在前面注入，未重复计入拼装</div>
          <div class="pi-why">${esc(s.note || 'CLI 会按解析后的文件路径去重。')}</div></div>`;
      }
      if (s.missing) {
        return `<div class="pi-asm-seg"><div class="pi-seg-hdr bad">#${i + 1} ${esc(s.label)} · 磁盘上读不到，未计入拼装</div></div>`;
      }
      const bodyHtml = s.textOmitted
        ? `<div class="pi-why">这一段正文超出预览总量上限，未随拼装一起返回。请回面板单独点这个文件看全文。</div>`
        : `<pre class="pi-raw">${esc(s.text)}</pre>${s.textTruncated
          ? `<div class="pi-why">本段已显示 ${s.textBytes} / ${s.bytes} 字节；回面板单独点这个文件可分段读完。</div>` : ''}`;
      return `<div class="pi-asm-seg">
        <div class="pi-seg-hdr">
          <b>#${i + 1} ${esc(s.label)}</b>
          ${ORDER_TAG[s.orderTruth] || ''}
          <span class="pi-seg-off">字节偏移 [${s.start}, ${s.end}) · ${s.bytes} B · sha256[0:12] ${esc(s.sha256_12 || '')}</span>
          <span class="pi-seg-path">${esc(s.path)}</span>
        </div>
        ${bodyHtml}
      </div>`;
    }).join('');

    const unavailable = (d.unavailable || []).map(u => `
      <div class="pi-row"><span class="pi-tag bad">拿不到</span>
        <span class="pi-path">${esc(u.label)}</span>
        <span class="pi-seg-path">${esc(u.why)}</span></div>`).join('');

    bodyEl.innerHTML = `
      <div class="pi-asm-index"><h5>段索引（起止字节偏移）</h5>${index || '<div class="pi-why">这个 cwd 没有任何会被注入的规则文件。</div>'}</div>
      <div class="pi-asm-body">${blocks}</div>
      <div class="pi-asm-index"><h5>下面这些确实进了请求，但 Hub 拿不到 —— 不编，只标注</h5>${unavailable}</div>`;

    const joined = segs.filter(s => !s.missing && !s.duplicateOf && !s.textOmitted).map(s => s.text).join(d.joiner || '\n\n');
    statusEl.textContent = d.complete
      ? `拼装完整：${d.segmentCount} 段 / ${d.totalBytes} 字节全部载入`
      : `部分段落正文超限未载入，索引与偏移仍为真实值（共 ${d.totalBytes} 字节）`;
    actionsEl.innerHTML = '<button class="pi-btn" data-pi-copy type="button">复制拼装原文</button>';
    actionsEl.querySelector('[data-pi-copy]').addEventListener('click', (ev) => copyText(ev.currentTarget, joined));
    return overlay;
  }

  // 面板挂在卡片的 .turn-content 末尾；再次点击收起。
  //   opts 可选 { cwd, kind }：拿不到 sessionId（或会话已退出）时的显式回退，
  //   主进程会用它重算白名单——传什么 cwd 就只能读那个 cwd 的注入来源。
  async function togglePromptInspector(cardEl, sessionId, opts) {
    if (!cardEl) return;
    const host = cardEl.querySelector('.turn-content') || cardEl;
    const existing = host.querySelector(':scope > .pi-panel');
    if (existing) { existing.remove(); closeModal(); return; }

    const panel = document.createElement('div');
    panel.className = 'pi-panel';
    panel.innerHTML = '<div class="pi-loading">正在还原注入内容…</div>';
    host.appendChild(panel);

    const ctx = {
      sessionId,
      cwd: (opts && opts.cwd) || null,
      kind: (opts && opts.kind) || null,
    };
    panel._piCtx = ctx;

    // 面板内代理点击：任意带 data-pi-path 的行 → 原文预览；拼装按钮 → 拼装预览
    panel.addEventListener('click', (ev) => {
      const asmBtn = ev.target.closest('[data-pi-assemble]');
      if (asmBtn) { ev.preventDefault(); ev.stopPropagation(); openAssemblyPreview(ctx); return; }
      const row = ev.target.closest('[data-pi-path]');
      if (!row || !panel.contains(row)) return;
      ev.preventDefault();
      ev.stopPropagation();
      openRawPreview(ctx, row.getAttribute('data-pi-path'), row.getAttribute('data-pi-label'));
    });
    panel.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const row = ev.target.closest('[data-pi-path]');
      if (!row) return;
      ev.preventDefault();
      openRawPreview(ctx, row.getAttribute('data-pi-path'), row.getAttribute('data-pi-label'));
    });

    try {
      const ipc = ipcOf();
      if (!ipc) throw new Error('ipcRenderer 不可用');
      const res = await ipc.invoke('prompt-inspect', { sessionId, cwd: ctx.cwd, kind: ctx.kind });
      if (!res || !res.ok) {
        panel.innerHTML = `<div class="pi-err">还原失败：${esc((res && res.error) || '未知错误')}</div>`;
        return;
      }
      // 回填真实 cwd/kind：后续 raw / assemble 调用与面板展示的是同一次口径
      ctx.cwd = res.data.cwd;
      ctx.kind = res.data.kind;
      panel.innerHTML = renderInspection(res.data);
    } catch (err) {
      panel.innerHTML = `<div class="pi-err">还原失败：${esc(err && err.message ? err.message : err)}</div>`;
    }
  }

  win.togglePromptInspector = togglePromptInspector;
  win._renderPromptInspection = renderInspection; // 供测试/调试直接喂数据
  win._promptInspectorOpenRaw = openRawPreview;
  win._promptInspectorOpenAssembly = openAssemblyPreview;
  win._promptInspectorCloseModal = closeModal;
})();
