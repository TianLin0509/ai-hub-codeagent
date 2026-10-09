"use strict";
const {
  modelOptionsFor,
  DEFAULT_MODEL_BY_KIND,
} = require("../core/model-options");
const { ALL_AI_KINDS, getKindLabel } = require("../core/ai-kinds");
const { formatBeijingDateTime } = require("../core/beijing-time");
function createMemoryPanel({
  document,
  ipcRenderer,
  escapeHtml: esc,
  getActiveSessionInfo,
  openSession,
}) {
  let page,
    tab = "context",
    data = null,
    rows = [],
    selected = new Set(),
    sid = null,
    file = null,
    preview = "",
    previewNote = "",
    previewLabel = "",
    contextSelectionKey = null,
    error = "",
    busy = false,
    epoch = 0,
    timer,
    query = "",
    scanned = [],
    scanNote = "",
    catalogData = null,
    projectId = "",
    selectedProject = null,
    loading = false,
    loadedKey = "",
    visibleFiles = 200,
    refreshTimer,
    refreshAgain = false,
    previewEpoch = 0,
    sourcePreview = "";
  let kind = "codex",
    model = DEFAULT_MODEL_BY_KIND.codex,
    effort = "medium";
  try {
    const s = JSON.parse(localStorage.getItem("hubDreamSelection") || "null");
    if (s && ALL_AI_KINDS.includes(s.kind)) {
      kind = s.kind;
      model = s.model;
      effort = s.effort;
    }
  } catch {}
  const fmt = (n) => (n ? formatBeijingDateTime(n, { seconds: false }) : "—");
  const badge = (s) => `<span class="mp-badge">${esc(s)}</span>`;
  const button = (text, action, cls = "") =>
    `<button class="mp-btn ${cls}" data-action-mp="${action}">${text}</button>`;
  async function call(name, args = {}) {
    const r = await ipcRenderer.invoke("memory:" + name, args);
    if (!r?.ok) throw new Error(r?.error || "读取失败");
    return r.data;
  }
  function position() {
    const r = document.getElementById("scene-rail")?.getBoundingClientRect();
    if (page && r) {
      const sessionEdge = document.getElementById("session-sidebar")?.getBoundingClientRect().left;
      page.style.left = (sessionEdge ?? r.right) + "px";
      page.style.top = r.top + "px";
    }
  }
  function fail(e) {
    error = e.message || String(e);
    render();
  }
  function tuning() {
    return (
      window.WorkspaceController?.resolveSessionTuning(kind, model, {
        effort,
      }) || {
        model,
        modelOptions: modelOptionsFor(kind),
        showEffort: kind === "codex",
        effortOptions: [
          ["medium", "medium"],
          ["high", "high"],
          ["max", "max"],
        ],
      }
    );
  }
  async function catalog() {
    const before = kind;
    await window.WorkspaceController?.loadModelCatalog(kind);
    if (before === kind) render();
  }
  async function read(p, paint = true) {
    const version = epoch, request = ++previewEpoch;
    file = p;
    previewLabel = "";
    previewNote = tab === 'context' ? '当前磁盘内容；加载事件没有保留当时正文，不能视为注入快照。' : '';
    preview = "读取中…";
    if (paint) render();
    const r = await ipcRenderer.invoke("read-file", p);
    if (file !== p || version !== epoch || request !== previewEpoch || page.hidden) return;
    preview = r?.error ? "读取失败：" + r.error : String(r?.content || "");
    if (paint) render();
  }
  function resetPreview() { file = null; preview = ""; previewNote = ""; previewLabel = ""; contextSelectionKey = null; sourcePreview = ""; previewEpoch++; }
  function contextEntries() {
    return [...(data?.nativeEntries || []), ...(data?.receipts || []).map(r => ({ ...r, key: 'hub:' + r.id, label: r.label || 'DREAM_INDEX.md', status: '已发送' }))];
  }
  async function selectContextEntry(entry, paint = true) {
    contextSelectionKey = entry.key;
    if (entry.snapshot === false) return read(entry.path, paint);
    previewEpoch++; file = entry.path; preview = entry.content; previewLabel = entry.label;
    previewNote = entry.source === 'native' ? '原生记录中的注入正文快照；下方路径为原始记录位置。' : '本次确认发送的正文快照。';
    if (paint) render();
  }
  function scope() { return { projectId }; }
  function activeProject() {
    const cwd = String(getActiveSessionInfo()?.cwd || "").replace(/\\/g, "/").toLowerCase();
    return catalogData?.projects.find(p => p.sessionIds?.includes(getActiveSessionInfo()?.id))
      || catalogData?.projects.filter(p => cwd === p.cwd.replace(/\\/g,"/").toLowerCase()
        || cwd.startsWith(p.cwd.replace(/\\/g,"/").toLowerCase()+"/"))
        .sort((a,b)=>b.cwd.length-a.cwd.length)[0];
  }
  async function refresh(force = false) {
    const version = ++epoch, requestedTab = tab;
    sid = getActiveSessionInfo()?.id || null;
    const requestedSession = sid;
    const valid = () => version === epoch && !page.hidden && requestedTab === tab
      && (requestedTab !== 'context' || (getActiveSessionInfo()?.id || null) === requestedSession);
    const key = `${tab}:${tab === 'context' ? sid : projectId}`;
    error = ""; loading = true;
    if (loadedKey !== key) { data = null; loadedKey = key; }
    render();
    try {
      if (tab === "context") {
        if (sid) {
          const result = await call("context", {sessionId:sid, refresh:force});
          if (!valid()) return;
          data = result;
          // Preview the immutable submitted snapshot, never today's disk contents.
          const entries = contextEntries(), chosen = entries.find(e => e.key === contextSelectionKey) || entries[0];
          if (chosen) await selectContextEntry(chosen, false);
          else resetPreview();
        }
      } else {
        const result = await call("library", {refresh:force});
        if (!valid()) return;
        catalogData = result;
        if (projectId && !result.projects.some(p => p.id === projectId)) projectId = "";
        if (tab === "library") data = result;
        else {
          if (!projectId) projectId = activeProject()?.id || result.projects[0]?.id || "";
          if (projectId) {
            const state = await call("dream-state", scope());
            if (!valid()) return;
            data = state;
            render();
            const candidates = await call("candidates", scope());
            if (!valid()) return;
            rows = candidates;
            if (selectedProject !== projectId) {
              selected = new Set(rows.filter(x => !x.processed && !x.stale).slice(0,3).map(x=>x.key));
              selectedProject = projectId;
            } else {
              const available = new Set(rows.filter(x=>!x.stale).map(x=>x.key));
              selected = new Set([...selected].filter(key=>available.has(key)));
            }
          }
        }
      }
    } catch (e) { if (valid()) error = e.message || String(e); }
    finally { if (valid()) { loading = false; render(); if (refreshAgain) { refreshAgain = false; scheduleRefresh(); } } }
  }
  function scheduleRefresh() {
    if (!page || page.hidden || refreshTimer) return;
    if (loading) { refreshAgain = true; return; }
    refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 100);
  }
  function projectSelect(all) {
    return `<label class="mp-project-label">${all ? "筛选项目" : "造梦项目"}<select id="mp-project" aria-label="项目">${all ? '<option value="">全部项目与全局记忆</option>' : ''}${(catalogData?.projects || []).map(p=>`<option value="${esc(p.id)}" ${p.id===projectId ? "selected" : ""}>${esc(p.label)} · ${esc(p.cwd)}</option>`).join("")}</select></label>`;
  }
  function fileRow(f) {
    return `<button class="mp-file ${file === f.path ? "active" : ""}" data-file="${esc(f.path)}" title="${esc(f.path)}"><span class="mp-file-name">${esc(f.label || f.path.split(/[\\/]/).pop())}</span><span class="mp-meta">${esc(f.owner || "")} ${badge(f.status || "可读取")}</span><span class="mp-file-path">${esc(f.path)}</span></button>`;
  }
  function previewPane() {
    return `<section class="mp-preview"><div class="mp-preview-head"><span>${esc(previewLabel || (file ? file.split(/[\\/]/).pop() : "内容预览"))}</span>${file ? button("打开所在位置", "folder") : ""}</div>${previewNote ? `<p class="mp-note">${esc(previewNote)}</p>` : ""}<pre class="mp-preview-content">${esc(preview || "选择文件查看内容")}</pre><div class="mp-path">${esc(file || "")}</div></section>`;
  }
  function context() {
    const entries = contextEntries();
    const nativeLocation = r => esc(r.evidence || `原生记录第 ${r.line} 行`);
    return `<div class="mp-pagehead"><div><h2>本会话的记忆注入记录</h2><p>${esc(data.session.title || "当前 session")} · ${esc(data.session.kind)}</p></div>${button("返回当前会话", "close")}</div><div class="mp-two"><section class="mp-card"><div class="mp-section-title">原生规则、记忆与 Hub 索引</div>${entries.map((r,i)=>`<button class="mp-file" data-receipt="${i}"><span class="mp-file-name">${esc(r.label)} ${badge(r.status)}</span><span class="mp-meta">${esc(fmt(r.sentAt))} · ${r.source === 'native' ? nativeLocation(r) : esc(r.version?.slice(0,8) || '')}</span></button>`).join("")}${!entries.length ? '<p class="mp-empty">尚未取得可展示的注入记录，并不表示本会话没有加载规则或记忆。</p>' : ""}</section>${previewPane()}</div>${(data.warnings || []).map(w=>`<p class="mp-note">${esc(w)}</p>`).join('')}${data.unconfirmed ? `<p class="mp-note">另有 ${data.unconfirmed} 条提交尚无发送确认，未计入已注入内容。</p>` : ""}<div class="mp-note">${esc(data.note)}</div>`;
  }
  function library() {
    const seen = new Set(), q = query.toLowerCase();
    const all = [...data.files, ...scanned].filter(f=>{
      const key = f.path.replace(/\\/g,"/").toLowerCase();
      if (seen.has(key)) return false; seen.add(key);
      return (!projectId || !f.projectIds?.length || f.projectIds.includes(projectId))
        && (f.label + " " + f.path).toLowerCase().includes(q);
    });
    const historical = all.filter(f=>f.rule?.state==='unchanged');
    const regular = all.filter(f=>f.rule?.state!=='unchanged');
    const shown = regular.slice(0, visibleFiles), groups = [...new Set(shown.map(f=>f.group))];
    const historyGroups = new Map();
    for(const f of historical.slice(0, visibleFiles)) {const k=(f.rule.source||'来源未知')+'\0'+f.rule.bodyDigest; if(!historyGroups.has(k))historyGroups.set(k,[]);historyGroups.get(k).push(f);}
    const historyHtml = historical.length ? `<details class="mp-history"><summary>历史规则副本 · ${historical.length} 份（默认折叠，文件仍保留）</summary>${[...historyGroups.values()].map(files=>`<details><summary>${esc(files[0].rule.source||'来源未知')} · ${files.length} 份</summary>${files.map(fileRow).join('')}</details>`).join('')}</details>` : '';
    const globalHtml = data.globalRules?.length ? `<details class="mp-note"><summary>全局规则 · ${data.globalRulesAligned?'正文一致':'正文有差异或入口缺失，请核对'}</summary><p>固定入口分别供各家 AI 读取；不会随会话复制，也不会自动覆盖差异。</p>${data.globalRules.map(f=>f.exists?fileRow({...f,label:f.kind,status:'固定入口'}):`<p>${esc(f.kind)}：入口缺失</p>`).join('')}</details>` : '';
    return `<div class="mp-pagehead"><div><h2>记忆文件库</h2><p>全局文件库 · ${all.length} 个文件 · 不依赖打开的会话</p>${projectSelect(true)}${scanNote ? `<p class="mp-muted">${esc(scanNote)}</p>` : ""}</div><div class="mp-actions"><button class="mp-btn" data-action-mp="scan" ${!projectId || busy ? "disabled" : ""}>扫描所选项目文档</button>${button("☾ 造梦", "dream", "primary")}</div></div>${globalHtml}${data.warnings.length ? `<details class="mp-note"><summary>${data.warnings.length} 项读取问题，结果可能不完整</summary>${data.warnings.map(x=>`<p>${esc(x)}</p>`).join("")}</details>` : ""}<div class="mp-library"><section class="mp-tree"><input id="mp-search" placeholder="搜索文件名或路径" aria-label="搜索记忆文件" value="${esc(query)}">${groups.map(g=>`<div class="mp-section-title">${esc(g)}</div>${shown.filter(f=>f.group===g).map(fileRow).join("")}`).join("")}${historyHtml}${!all.length ? '<p class="mp-empty">没有匹配的文件</p>' : ""}${regular.length>shown.length || historical.length>visibleFiles ? button(`继续显示（剩余 ${regular.length-shown.length + Math.max(0,historical.length-visibleFiles)}）`,"more") : ""}</section>${previewPane()}</div><div class="mp-note">原生记忆保留原位。文件库中存在不代表已注入；Hub 梦境使用独立索引与主题文件。</div>`;
  }
  function dream() {
    const t = tuning();
    return `<div class="mp-pagehead"><div><h2>把聊过的事，留给下一次</h2><p>选择昨日之我的对话，交给一个普通 AI session 整理。</p>${projectSelect(false)}</div></div><div class="mp-dream-grid"><div><section class="mp-card"><div class="mp-section-title">素材 session <span>${rows.length} 个可用会话</span></div><div class="mp-sources">${rows.map((s) => `<div class="mp-source"><input type="checkbox" aria-label="选择 ${esc(s.title)}" data-source="${esc(s.key)}" ${selected.has(s.key) ? "checked" : ""}><span><strong>${esc(s.title)}</strong><small>${esc(s.provider)} · ${esc(fmt(s.updatedAt))} · ${s.records} 条记录</small><small>${s.processed ? "该版本已整理" : s.newRecords < s.records ? `约 ${s.newRecords} 条新增，已整理部分只作上文` : "有未整理记录"}${s.stale ? " · 请刷新后再整理" : ""}</small></span><button class="mp-link" data-source-preview="${esc(s.key)}">预览</button></div>`).join("") || '<p class="mp-empty">此项目暂无历史正文。点击右上角刷新，从昨日之我更新素材。</p>'}</div><div class="mp-selection">已选 ${selected.size} 个会话 · 导出新增正文，并附少量已整理上文</div></section><p class="mp-muted">默认勾选最近 3 个未整理会话，可自行修改。只读取历史，不打开素材 session。历史解析可能缺少工具结果或附件，不宣称无损归档。</p>${sourcePreview ? `<details open class="mp-card"><summary>素材预览（历史窗口，完整输入以导出文件为准）</summary><pre class="mp-source-preview">${esc(sourcePreview)}</pre></details>` : ""}</div><div><section class="mp-card mp-settings"><h3>造梦师</h3><label>AI<select id="mp-kind">${["codex", ...ALL_AI_KINDS.filter((v) => v !== "codex")].map((v) => `<option value="${v}" ${v === kind ? "selected" : ""}>${esc(getKindLabel(v))}</option>`).join("")}</select></label><label>模型<select id="mp-model">${!t.modelOptions.some((m) => m.id === model) ? `<option value="" selected>请选择模型（原选择不可用）</option>` : ""}${t.modelOptions.map((m) => `<option value="${esc(m.id)}" ${m.id === model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>${t.showEffort ? `<label>思考深度<select id="mp-effort">${!t.effortOptions.some(([v]) => v === effort) ? `<option value="" selected>请选择思考深度</option>` : ""}${t.effortOptions.map(([v, l]) => `<option value="${esc(v)}" ${v === effort ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` : ""}<p class="mp-muted">复用新建 session 的模型与档位。账号跟随 Hub 当前设置。</p><button class="mp-btn primary mp-wide" data-action-mp="start" ${busy || loading || !selected.size ? "disabled" : ""}>${busy ? "正在准备素材…" : "☾ 开始造梦"}</button></section>${data.jobs.slice(0,10).map(job).join("")}</div></div>`;
  }
  function job(j) {
    const labels = {
      preparing: "准备素材",
      running:
        {
          waiting: "等待你的回复或审批",
          unknown: "运行状态待核对",
          interrupted: "本轮已停止",
          failed: "本轮执行失败",
        }[j.runtimeState] || "造梦 session 正在处理",
      publishing: "保存结果",
      done: "造梦完成",
      attention: "需要在会话中处理",
      failed: "未完成",
    };
    return `<section class="mp-card mp-job"><h3>${esc(j.orphaned ? "任务中断，需核对" : labels[j.status] || j.status)}</h3><p>${esc(j.kind)} / ${esc(j.model)} / ${esc(j.effort || "默认配置")}</p><p>${j.sources.length} 个素材 session · ${esc(fmt(j.createdAt))}</p>${j.error ? `<div class="mp-error">${esc(j.error)}</div>` : ""}${j.summary ? `<p>${esc(j.summary)}</p>` : ""}<div class="mp-actions">${j.sessionId ? `<button class="mp-btn" data-job-session="${esc(j.sessionId)}">打开造梦 session ↗</button>` : ""}${j.status === "done" ? button("查看生成文件", "library") : j.sessionId ? `<button class="mp-btn" data-finalize="${j.id}">核对并保存结果</button><button class="mp-btn" data-abandon="${j.id}">结束本次</button>` : ""}</div><details><summary>输入文件与实际 prompt</summary><div class="mp-path">${esc(j.dir)}\input\manifest.json</div><pre>${esc(j.prompt || "素材准备中")}</pre></details></section>`;
  }
  function render() {
    if (!page || page.hidden) return;
    position();
    page.innerHTML = `<header class="mp-header"><div><span class="mp-eyebrow">AI HUB / MEMORY</span><h1>记忆</h1></div><div class="mp-actions"><span class="mp-muted">${esc(tab === "context" ? "当前 session" : "全局记忆")}</span>${button("刷新", "refresh")}${button("关闭", "close")}</div></header><nav class="mp-tabs" role="tablist">${[
      ["context", "当前上下文"],
      ["library", "记忆文件库"],
      ["dream", "造梦"],
    ]
      .map(
        ([id, name]) =>
          `<button role="tab" aria-selected="${tab === id}" class="mp-tab ${tab === id ? "active" : ""}" data-tab="${id}">${name}</button>`,
      )
      .join(
        "",
      )}</nav><div class="mp-content" role="tabpanel">${error ? `<div class="mp-error" role="alert">${esc(error)}</div>` : ""}${loading ? '<div class="mp-loading" role="status">正在读取…</div>' : ""}${data ? { context, library, dream }[tab]() : `<div class="mp-empty">${loading ? "" : tab === "context" ? "请先打开一个 session。群聊可点击成员头像进入对应 session，再查看当前上下文。" : tab === "dream" ? "暂无已知项目。文件库仍可浏览全局记忆。" : "暂未发现记忆文件。"}</div>`}</div>`;
  }
  async function action(b) {
    const version = epoch;
    const valid = () => version === epoch && !page.hidden;
    if (b.dataset.tab) {
      tab = b.dataset.tab;
      resetPreview(); rows = [];
      if (tab === "dream") void catalog().catch(fail);
      return refresh();
    }
    if (b.dataset.file) return read(b.dataset.file);
    if (b.dataset.receipt !== undefined) {
      const r = contextEntries()[+b.dataset.receipt];
      return selectContextEntry(r);
    }
    if (b.dataset.jobSession) {
      close();
      return openSession(b.dataset.jobSession);
    }
    if (b.dataset.sourcePreview) {
      const request = ++previewEpoch;
      const r = await ipcRenderer.invoke("get-session-search-preview", {
        sessionKey: b.dataset.sourcePreview,
      });
      if (!valid() || request !== previewEpoch) return;
      sourcePreview =
        (r?.context || [])
          .map((x) => `${x.role || x.scope}\n${x.text || ""}`)
          .join("\n\n") ||
        r?.error ||
        "暂无预览";
      return render();
    }
    if (b.dataset.finalize) {
      await call("finalize-dream", { jobId: b.dataset.finalize });
      if (valid()) return refresh();
      return;
    }
    if (b.dataset.abandon) {
      await call("abandon-dream", { jobId: b.dataset.abandon });
      if (valid()) return refresh();
      return;
    }
    switch (b.dataset.actionMp) {
      case "close":
        return close();
      case "refresh":
        if (tab === "dream") {
          const status = await ipcRenderer.invoke("refresh-session-search", {
            immediate: true,
          });
          if (!valid()) return;
          if (!status || status.phase === "error" || status.lastError)
            throw new Error(status?.lastError || "历史索引刷新失败");
        }
        if (tab !== 'context') resetPreview();
        return refresh(true);
      case "folder":
        if (file) await ipcRenderer.invoke("show-in-folder", file);
        return;
      case "more": visibleFiles += 200; return render();
      case "scan": {
        if (busy) return;
        busy = true; render();
        try {
          const result = await call("scan", scope());
          if (!valid()) return;
          scanned = result.files.map(f=>({...f, projectIds:[projectId]})); scanNote = result.note;
        } finally { busy = false; if (valid()) render(); }
        return render();
      }
      case "dream":
      case "library":
        tab = b.dataset.actionMp; resetPreview();
        if (tab === "dream") void catalog().catch(fail);
        return refresh();
      case "start":
        if (busy || loading) return;
        busy = true;
        error = "";
        render();
        try {
          model = page.querySelector("#mp-model").value;
          effort = page.querySelector("#mp-effort")?.value || "";
          if (!model || (tuning().showEffort && !effort))
            throw new Error("请选择可用的模型和思考深度");
          const opts = window.WorkspaceController?.buildSessionTuningOpts(
            kind,
            model,
            { effort },
          ) || { model, effort };
          if (opts.model !== model || (opts.effort && opts.effort !== effort))
            throw new Error("模型或思考档已变化，请重新选择");
          localStorage.setItem(
            "hubDreamSelection",
            JSON.stringify({ kind, model, effort }),
          );
          await call("start-dream", {
            projectId,
            keys: [...selected],
            kind,
            opts,
          });
          if (valid()) await refresh();
        } finally {
          busy = false;
          if (!page.hidden) render();
        }
        return;
    }
  }
  function build() {
    if (page) return;
    page = document.createElement("section");
    page.id = "memory-page";
    page.className = "mp-overlay";
    page.hidden = true;
    page.setAttribute("aria-label", "记忆");
    document.body.appendChild(page);
    page.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      const version = epoch;
      if (b) void action(b).catch(error => { if (version === epoch && !page.hidden) fail(error); });
    });
    page.addEventListener("change", (e) => {
      const el = e.target;
      if (el.id === "mp-project") {
        projectId = el.value; rows = []; scanned = []; scanNote = ""; visibleFiles = 200;
        resetPreview(); void refresh(); return;
      }
      if (el.dataset.source) {
        el.checked
          ? selected.add(el.dataset.source)
          : selected.delete(el.dataset.source);
        render();
      }
      if (el.id === "mp-kind") {
        kind = el.value;
        model =
          DEFAULT_MODEL_BY_KIND[kind] || modelOptionsFor(kind)[0]?.id || "";
        render();
        void catalog().catch(fail);
      }
      if (el.id === "mp-model") {
        model = el.value;
        render();
      }
      if (el.id === "mp-effort") effort = el.value;
    });
    page.addEventListener("input", (e) => {
      if (e.target.id === "mp-search") {
        const n = e.target.selectionStart;
        query = e.target.value; visibleFiles = 200;
        render();
        const i = page.querySelector("#mp-search");
        i.focus();
        i.setSelectionRange(n, n);
      }
    });
  }
  async function open(options = {}) {
    build();
    page.hidden = false;
    document.body.classList.add("memory-open");
    document
      .getElementById("btn-rail-memory")
      ?.setAttribute("aria-expanded", "true");
    tab = ['context', 'library', 'dream'].includes(options.tab) ? options.tab
      : options.preserve ? (tab === 'context' ? 'library' : tab)
      : getActiveSessionInfo()?.id ? "context" : "library";
    resetPreview(); data = null;
    render();
    clearInterval(timer);
    timer = setInterval(() => {
      if (tab === "context" && (getActiveSessionInfo()?.id || null) !== sid) { resetPreview(); void refresh(); }
    }, 800);
    await refresh();
  }
  function close() {
    if (!page) return;
    page.hidden = true;
    epoch++; previewEpoch++;
    refreshAgain = false;
    clearTimeout(refreshTimer); refreshTimer = null;
    clearInterval(timer);
    document.body.classList.remove("memory-open");
    document
      .getElementById("btn-rail-memory")
      ?.setAttribute("aria-expanded", "false");
    window.hubWorkspaces?.panelClosed('memory');
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="open-memory"]')) {
      if (window.hubWorkspaces) { window.hubWorkspaces.open('resources', 'memory'); return; }
      if (page && !page.hidden) close();
      else void open().catch(fail);
    } else if (e.target.closest("#scene-rail button") && page && !page.hidden && !page.classList.contains('hw-embedded'))
      close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  window.addEventListener("resize", position);
  ipcRenderer.on("memory:changed", () => {
    if (page && !page.hidden) scheduleRefresh();
  });
  ipcRenderer.on("session-updated", (_event, { session } = {}) => {
    if (!page || page.hidden || !session) return;
    const job = data?.jobs?.find(
      (j) =>
        j.sessionId === session.id && !["done", "failed"].includes(j.status),
    );
    if (job && job.runtimeState !== (session.nativeRuntime?.state || null))
      scheduleRefresh();
  });
  return { open, close };
}
module.exports = { createMemoryPanel };
