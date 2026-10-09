'use strict';

(function () {
  const { ipcRenderer } = require('electron');
  const path = require('path');
  const {
    modelOptionsFor,
    DEFAULT_MODEL_BY_KIND,
    setRuntimeModelOptions,
  } = require('../core/model-options.js');
  const {
    isDefaultModel,
    resolveDefaultModel,
  } = require('../core/default-model-preference.js');
  const { defaultCodexContextWindow } = require('../core/codex-context-window.js');
  const { DEFAULT_EFFORT, DEFAULT_EFFORT_BY_KIND, DEFAULT_MCP_BY_KIND,
    DEFAULT_CODEX_SPEED_BY_KIND, defaultEffortFor } = require('../core/session-creation-defaults.js');

  const KIND_LABELS = {
    ...require('../core/acp-profiles').LABELS,
    claude: 'Claude Code',
    gemini: 'Gemini CLI',
    codex: 'Codex CLI',
    chatgpt: 'ChatGPT',
    deepseek: 'DeepSeek',
    kimi: 'Kimi Code · K3',
    codeagent: 'CodeAgent · 公司内网',
    powershell: 'PowerShell',
  };

  const WORKSPACE_TIER_LABELS = {
    root: '组织根·不可用',
    category: '领域工作区',
    scratch: '临时工作区',
    project: '项目工作区',
    external: '外部工作区',
  };

  // 三个 kind 有"速度/质量"档位可调：Claude 走 CLI 的 --effort，
  // Codex 与新版 DeepSeek（同一条 codex runtime）走 -c model_reasoning_effort。
  // 两边的合法枚举不一样：Claude 是固定表，Codex 按模型目录取值（部分模型有 ultra）。
  const EFFORT_KINDS = new Set(['claude', 'codex', 'deepseek', 'codeagent']);
  const MCP_KINDS = new Set(['claude', 'codex', 'deepseek', 'codeagent']);
  // 这个开关只表示 Claude Code 的 fastMode；Codex 的 fast 是另一套
  // service_tier 机制，由下面独立的速度通道控件承载。
  const FAST_KINDS = new Set(['claude']);
  // 2026-09-05：Claude Fast 默认关闭。它更快出字，但交互式会话可能不落 transcript
  // （2026-06-11 实测），当默认值弊大于利；要用的人自己勾。
  const DEFAULT_FAST_MODE = false;
  // Codex 也有 fast —— 是 service_tier（priority 通道，1.5× 速度、用量更高），
  // 跟 Claude 的 fastMode 完全两套机制，所以两个 kind 走两个不同控件。
  const CODEX_TIER_KINDS = new Set(['codex', 'deepseek']);
  // 2026-09-05：Claude / Codex 两家默认降到 high。max 在日常任务上只是更慢更贵，
  // 需要时用户仍可在弹窗里手动往上调。DeepSeek 未被点名，保持原来的 max。
  const CLAUDE_EFFORT_OPTIONS = [
    ['max', 'max · 最强'],
    ['xhigh', 'xhigh'],
    ['high', 'high · 默认'],
    ['medium', 'medium · 省额度'],
    ['low', 'low · 最省'],
  ];
  // Codex 的档位按模型下发（gpt-5.6-sol 有 ultra，5.5 只到 xhigh），
  // 开弹窗时向 main 要一次真实目录；拿不到就用这份保守兜底。
  const CODEX_EFFORT_FALLBACK = ['low', 'medium', 'high', 'xhigh', 'max'];
  const CODEX_EFFORT_HINTS = {
    low: '最快，推理最浅',
    medium: '速度与深度平衡',
    high: '更深的推理',
    xhigh: '超高推理深度',
    max: '最大推理深度',
    ultra: '最大推理 + 自动任务分派',
  };
  let chatgptCatalog = null;
  let codexTuningCatalog = null;
  let claudeModelCatalog = null;
  const codexCatalogInFlight = new Map();
  let codexAccounts = [];
  let codexAccountId = '';
  let codexBackend = 'subscription';
  let accountSaving = false;
  let pendingAccountId = '';
  let accountReadError = '';
  let accountNotice = '';
  let configReadRevision = 0;
  let claudeCatalogInFlight = null;
  // 2026-08-29 起三家统一默认 none：一个 MCP 都不加载，要用哪个当场选。
  // 起因是 wireless-sim 这个 MCP 每个进程恒定提交 2.66 GB（实占只有 20–30 MB），
  // Claude 原来默认 full，13 个会话就吃掉 34.6 GB 提交内存。
  const MCP_OPTIONS = {
    claude: [
      ['none', 'None · 默认，不加载任何 MCP'],
      ['browser', 'Browser · 只留 Playwright / Chrome'],
      ['lean', 'Lean · 仅保留 workspace / 群聊 MCP'],
      ['full', 'Full · 继承全部全局 MCP（最占内存）'],
    ],
    codex: [
      ['none', 'None · 默认，不加载任何 MCP'],
      ['lean', 'Lean · 仅保留 workspace / 群聊 MCP'],
      ['browser', 'Browser · 只留 Playwright'],
      ['full', 'Full · 全部全局 MCP'],
    ],
  };
  // 2026-09-05：Codex 的 fast（service_tier=priority）默认关掉 —— 用户要的是
  // 深思而不是抢通道，1.5× 速度换来的用量代价在长任务上不划算。
  const EFFORT_LABEL_BY_KIND = {
    claude: '思考强度 (--effort)',
    codex: '思考强度 (reasoning effort)',
    deepseek: '思考强度 (reasoning effort)',
  };
  // 用户按 kind 调过的档位记在这里，切回来时不必重选。
  const tuningMemory = new Map();
  const MCP_PROFILE_LABELS = {
    none: 'No MCP',
    lean: 'Lean MCP',
    browser: 'Browser MCP',
    wireless: 'Wireless MCP',
    full: 'Full MCP',
  };

  function effortFamily(kind) { return kind === 'claude' ? 'claude' : 'codex'; }
  function mcpOptionsFor(kind) { return MCP_OPTIONS[effortFamily(kind)] || []; }
  function defaultMcpFor(kind) { return DEFAULT_MCP_BY_KIND[kind] || 'none'; }
  function defaultCodexSpeedFor(kind, modelId) {
    const configuredDefault = DEFAULT_CODEX_SPEED_BY_KIND[kind] || 'inherit';
    // 2026-09-05 起配置默认就是 standard，这条分支只在有人把默认调回 fast 时才生效：
    // 模型目录明确说不支持该通道时回到 Standard，不能为了统一默认而送一个模型不提供的档位。
    if (configuredDefault === 'fast' && modelId && !codexModelTuning(modelId).supportsFast) return 'standard';
    return configuredDefault;
  }

  function codexModelTuning(modelId) {
    const entry = codexTuningCatalog && codexTuningCatalog.byModel && codexTuningCatalog.byModel[modelId];
    if (entry && Array.isArray(entry.efforts) && entry.efforts.length) return entry;
    return { efforts: CODEX_EFFORT_FALLBACK, supportsFast: true, fromCache: false };
  }

  function formatTokenCount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed).toLocaleString('en-US') : null;
  }

  // Claude 的档位是固定枚举；Codex 的按当前选中的模型来 —— 给 5.5 显示 ultra
  // 会拼出它不认识的值，给 5.6-sol 藏掉 ultra 又是白白少一档。
  function effortOptionsFor(kind, modelId) {
    if (kind === 'claude') return CLAUDE_EFFORT_OPTIONS;
    // 公司 Code Agent 的 --effort 只有这四档（实测帮助文本），没有 xhigh。
    if (kind === 'codeagent') return [['max', 'max · 最强'], ['high', 'high · 推荐'], ['medium', 'medium'], ['low', 'low · 最快']];
    if (!CODEX_TIER_KINDS.has(kind)) return [];
    return codexModelTuning(modelId).efforts
      .slice()
      .reverse()
      .map(level => [level, CODEX_EFFORT_HINTS[level] ? `${level} · ${CODEX_EFFORT_HINTS[level]}` : level]);
  }

  function codexTierOptionsFor(modelId) {
    const configured = (codexTuningCatalog && codexTuningCatalog.configuredServiceTier) || '';
    const inheritLabel = configured ? `跟随全局配置（当前：${configured}）` : '跟随全局配置';
    const options = [
      ['standard', 'Standard · 默认，显式关闭 Fast'],
      ['inherit', inheritLabel],
    ];
    if (codexModelTuning(modelId).supportsFast) options.push(['fast', 'Fast · priority 通道，1.5× 速度']);
    options.push(['flex', 'Flex · 更慢更省']);
    return options;
  }

  // 用户在新建会话面板点过「设为默认」的 per-CLI 模型。由 main 从 config.json
  // 读来，空表示沿用 model-options.js 的出厂默认值。
  //
  // 模块加载时就拉一次，不能只在打开新建会话面板时拉：群聊/圆桌成员走的是
  // resolveSessionTuning，它不经过那个面板，晚加载的话成员会一律回落出厂默认。
  let hubDefaultModels = {};
  // 本轮面板里用户有没有亲手动过模型下拉。异步回读配置后靠它决定能不能覆盖
  // 当前选择，避免把用户刚选的值改掉。
  let modelTouchedByUser = false;

  function defaultModelConfig() {
    return { defaultModels: hubDefaultModels };
  }

  // 读一次用户设过的默认模型。读不到就保持空表、回落出厂默认值 —— 这条路径
  // 决定的只是"预选哪个"，失败不该挡住新建会话。
  async function loadHubDefaultModels() {
    const revision=++configReadRevision;
    try {
      const config = await ipcRenderer.invoke('get-hub-config');
      hubDefaultModels = (config && config.defaultModels) || {};
      if (!accountSaving && revision===configReadRevision) {
        codexAccounts=(config.codexSubscriptionProfiles || []).map(p=>({...p,email:config.codexProfileIdentities?.[p.id] || ''}));
        codexAccountId=config.codexSubscriptionProfile || '';
        codexBackend=config.codexBackend;
        accountReadError='';
      }
    } catch (error) {
      hubDefaultModels = {};
      accountReadError='账号配置读取失败：'+error.message;
    }
    return hubDefaultModels;
  }

  // 新建 Session 与群聊成员共用这一份纯计算结果。群聊不能复制一套静态枚举：
  // Codex 的 effort / fast 支持会随模型目录变化，复制后迟早与单会话弹窗漂移。
  function resolveSessionTuning(kind, modelId, selection = {}) {
    const modelOptions = modelOptionsFor(kind);
    // 用户设过默认就用它，否则才回落出厂值；两者都不在当前可选清单里时取第一项。
    // 群聊成员走的也是这里，所以「设为默认」对群聊同样生效。
    const model = modelOptions.some(option => option.id === modelId)
      ? modelId
      : resolveDefaultModel(kind, defaultModelConfig(), modelOptions.map(option => option.id));
    const effortOptions = EFFORT_KINDS.has(kind) ? effortOptionsFor(kind, model) : [];
    const kindDefaultEffort = defaultEffortFor(kind);
    const fallbackEffort = effortOptions.some(([value]) => value === kindDefaultEffort)
      ? kindDefaultEffort
      : (effortOptions[0] ? effortOptions[0][0] : kindDefaultEffort);
    const effort = effortOptions.some(([value]) => value === selection.effort)
      ? selection.effort
      : fallbackEffort;
    const mcpOptions = MCP_KINDS.has(kind) ? mcpOptionsFor(kind) : [];
    const mcpProfile = mcpOptions.some(([value]) => value === selection.mcpProfile)
      ? selection.mcpProfile
      : defaultMcpFor(kind);
    const codexTierOptions = CODEX_TIER_KINDS.has(kind) ? codexTierOptionsFor(model) : [];
    const codexSpeedTier = codexTierOptions.some(([value]) => value === selection.codexSpeedTier)
      ? selection.codexSpeedTier
      : defaultCodexSpeedFor(kind, model);
    const contextMax = kind === 'codex' ? defaultCodexContextWindow(model) : null;

    return {
      model,
      modelOptions,
      showEffort: EFFORT_KINDS.has(kind),
      effort,
      effortOptions,
      showMcp: MCP_KINDS.has(kind),
      mcpProfile,
      mcpOptions,
      showFast: FAST_KINDS.has(kind),
      fastMode: typeof selection.fastMode === 'boolean' ? selection.fastMode : DEFAULT_FAST_MODE,
      showCodexTier: CODEX_TIER_KINDS.has(kind),
      codexSpeedTier,
      codexTierOptions,
      contextMax,
    };
  }

  function buildSessionTuningOpts(kind, modelId, selection = {}) {
    const tuning = resolveSessionTuning(kind, modelId, selection);
    const opts = {};
    if (kind === 'chatgpt') {
      const route = require('../core/chatgpt-web-models').chatgptWebRoute(tuning.model);
      if (!route || (modelId && modelId !== route.id)) throw new Error('所选 ChatGPT 模型已不可用，请重新选择档位');
      return { model: route.id, effort: route.effort, mcpProfile: 'none', codexSpeedTier: 'inherit' };
    }
    if (tuning.modelOptions.length > 0 && tuning.model) opts.model = tuning.model;
    if (tuning.showEffort && tuning.effort) opts.effort = tuning.effort;
    if (tuning.showMcp) opts.mcpProfile = tuning.mcpProfile;
    // 只有"关"需要写字段：session-manager 全链路按 fastMode === false 判断，
    // 开着就是省略。2026-09-05 默认改成关之后这条会常态写出 false，是预期行为。
    if (tuning.showFast && tuning.fastMode === false) opts.fastMode = false;
    // inherit = 不覆盖 ~/.codex/config.toml。
    if (tuning.showCodexTier && tuning.codexSpeedTier !== 'inherit') {
      opts.codexSpeedTier = tuning.codexSpeedTier;
    }
    if (typeof tuning.contextMax === 'number') opts.contextMax = tuning.contextMax;
    return opts;
  }
  const RECENT_LIMIT = 8;

  let menuEl = null;
  let selectedKind = 'claude';
  // 默认档从「新建临时目录」改成「工作根」（2026-08-31 平铺决策）。
  // 工作根没挂 .aiwork-root 标记时主进程会自动退回建 scratch，所以这个默认值
  // 在旧配置下也不会出错。
  let workspaceMode = 'default';
  let existingWorkspace = null;
  let preparedProjects = [];
  let projectLoadId = 0;
  let submitting = false;
  let selectedModel = '';
  let selectedEffort = defaultEffortFor('claude');
  let selectedMcpProfile = 'lean';
  let selectedFastMode = DEFAULT_FAST_MODE;
  let selectedCodexTier = 'inherit';
  let recentItems = [];
  let recommendedItems = [];
  let scratchRoot = '';
  let workspaceRoot = '';
  let flatWorkRoot = false;
  let archiveModalEl = null;
  let archiveContext = null;
  let archiveParent = null;
  let archiveBusy = false;
  let archiveReturnFocus = null;
  let archiveDoneWithWarnings = false;
  const archiveQueue = [];
  const archivePendingKeys = new Set();
  const archivePromptedKeys = new Set();
  // 「真的被 UI 承载过」的 key。archivePromptedKeys 只表示「问过一次」，
  // 而 P1-2 的历史损伤恰恰是：建议进了没人读的 Map，key 却被标记成问过了 ——
  // 于是补上 UI 之后这些会话再也不会提示。两个集合分开记，判重时要求「问过」
  // 且「确实呈现过」，把那种只标记没露面的 key 放行重试。
  const archiveSurfacedKeys = new Set();
  // scope:id → archive-context。存的是「可以归档」的建议，不是「必须现在处理」的任务。
  // 由 workspace chip 读取显示轻提示；用户点了才真正打开归档框。
  const archiveSuggestions = new Map();
  // scope:id → 归档过程中 main 推来的降级信息（codex rollout 没搬动、transcript 缺失…）。
  // 这些以前只写 main 进程 console，桌面图标启动的 Hub 没有终端窗口 = 用户永远看不到。
  const archiveWarnings = new Map();

  function compactPath(value, max = 58) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return `${text.slice(0, 3)}…${text.slice(-(max - 4))}`;
  }

  function workspacePathKey(value) {
    try { return path.resolve(String(value || '')).toLowerCase(); }
    catch { return String(value || '').toLowerCase(); }
  }

  // 平铺模式下工作根正是该用的目录，不能再显示成「组织根·不可用」——
  // 那会把默认落点标成不可用，与实际行为直接矛盾。
  function workspaceTierLabel(tier) {
    if (tier === 'root' && flatWorkRoot) return '工作根';
    return WORKSPACE_TIER_LABELS[tier] || '工作区';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeFolderName(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48);
  }

  function setArchiveError(message = '') {
    const error = archiveModalEl && archiveModalEl.querySelector('#workspace-archive-error');
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  }

  const ARCHIVE_WARNING_STAGES = {
    codex: 'Codex 会话目录',
    transcript: '对话记录',
    dormant: '休眠会话',
  };

  function archiveWarningKey(entry) {
    return `${entry && entry.stage}|${entry && entry.target}|${entry && entry.message}`;
  }

  function recordArchiveWarnings(key, entries) {
    if (!key || !Array.isArray(entries) || entries.length === 0) return;
    const list = archiveWarnings.get(key) || [];
    const seen = new Set(list.map(archiveWarningKey));
    for (const entry of entries) {
      if (!entry || seen.has(archiveWarningKey(entry))) continue;
      seen.add(archiveWarningKey(entry));
      list.push(entry);
    }
    archiveWarnings.set(key, list);
  }

  // 归档成功但有降级时的唯一呈现点。刻意复用已经在用户眼前的归档框，
  // 而不是再造一个 toast —— 少一个用户可能错过的通道。
  function setArchiveWarningList(entries = []) {
    const box = archiveModalEl && archiveModalEl.querySelector('#workspace-archive-warnings');
    if (!box) return;
    if (!entries.length) {
      box.innerHTML = '';
      box.hidden = true;
      return;
    }
    const items = entries.map(entry => {
      const stage = ARCHIVE_WARNING_STAGES[entry && entry.stage] || '归档';
      const target = entry && entry.target ? `${escapeHtml(entry.target)} · ` : '';
      return `<li><strong>${escapeHtml(stage)}</strong>${target}${escapeHtml((entry && entry.message) || '')}</li>`;
    }).join('');
    box.innerHTML = `<p>归档已完成，但有 ${entries.length} 项降级需要你知道：</p><ul>${items}</ul>`;
    box.hidden = false;
  }

  function archiveTargetPath() {
    const input = archiveModalEl && archiveModalEl.querySelector('#workspace-archive-folder-name');
    const name = input ? safeFolderName(input.value) : '';
    return archiveParent && name ? path.join(archiveParent, name) : '';
  }

  function paintArchiveModal() {
    if (!archiveModalEl || !archiveContext) return;
    archiveModalEl.querySelectorAll('[data-archive-parent]').forEach(button => {
      const selected = button.dataset.archiveParent === archiveParent;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    const custom = archiveModalEl.querySelector('#workspace-archive-custom-parent');
    if (custom) {
      const isCategory = (archiveContext.categories || []).some(item => item.path === archiveParent);
      custom.classList.toggle('selected', !!archiveParent && !isCategory);
      const value = custom.querySelector('small');
      if (value) value.textContent = archiveParent && !isCategory ? compactPath(archiveParent, 46) : '选择任意父目录，并在其中新建项目路径';
    }
    const target = archiveModalEl.querySelector('#workspace-archive-target');
    const targetPath = archiveTargetPath();
    if (target) {
      target.textContent = targetPath || '先选择正式分类或自定义位置';
      target.title = targetPath;
    }
    const submit = archiveModalEl.querySelector('#workspace-archive-submit');
    if (submit) submit.disabled = archiveBusy || !targetPath;
  }

  function ensureArchiveModal() {
    if (archiveModalEl && document.body.contains(archiveModalEl)) return archiveModalEl;
    archiveModalEl = document.createElement('div');
    archiveModalEl.id = 'workspace-archive-modal';
    archiveModalEl.className = 'workspace-archive-overlay';
    archiveModalEl.style.display = 'none';
    archiveModalEl.innerHTML = `
      <section class="workspace-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-archive-title" aria-describedby="workspace-archive-description">
        <header class="workspace-archive-head">
          <div class="workspace-archive-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7.5h6l2 2h8v9.5H4Z"/><path d="M12 4v10m-3-3 3 3 3-3"/></svg></div>
          <div><h2 id="workspace-archive-title">首轮完成，归档 Workspace</h2><p id="workspace-archive-description">选择正式位置后，Hub 会短暂重连 CLI，并从 _scratch 移走项目。</p></div>
          <button type="button" class="workspace-archive-close" aria-label="暂不归档">×</button>
        </header>
        <div class="workspace-archive-body">
          <div class="workspace-archive-source"><span>当前临时目录</span><strong id="workspace-archive-label"></strong><code id="workspace-archive-source"></code></div>
          <fieldset class="workspace-archive-fieldset"><legend>归档分类</legend><div class="workspace-archive-categories" id="workspace-archive-categories"></div></fieldset>
          <button type="button" class="workspace-archive-custom" id="workspace-archive-custom-parent"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3Z"/><path d="M15 5v6m-3-3h6"/></svg><span><strong>完全新建路径</strong><small>选择任意父目录，并在其中新建项目路径</small></span></button>
          <label class="workspace-archive-name" for="workspace-archive-folder-name"><span>项目文件夹名称</span><input id="workspace-archive-folder-name" type="text" maxlength="48" autocomplete="off" spellcheck="false"></label>
          <div class="workspace-archive-preview"><span>归档后路径</span><code id="workspace-archive-target"></code></div>
          <div class="workspace-archive-error" id="workspace-archive-error" role="alert" hidden></div>
          <div class="workspace-archive-warnings" id="workspace-archive-warnings" role="status" hidden></div>
        </div>
        <footer class="workspace-archive-footer"><button type="button" class="workspace-archive-later">暂留 _scratch</button><button type="button" class="workspace-archive-submit" id="workspace-archive-submit">归档并继续</button></footer>
      </section>`;
    document.body.appendChild(archiveModalEl);

    archiveModalEl.querySelector('.workspace-archive-close').addEventListener('click', closeArchiveModal);
    archiveModalEl.querySelector('.workspace-archive-later').addEventListener('click', closeArchiveModal);
    archiveModalEl.querySelector('#workspace-archive-folder-name').addEventListener('input', () => {
      setArchiveError('');
      paintArchiveModal();
    });
    archiveModalEl.querySelector('#workspace-archive-custom-parent').addEventListener('click', async () => {
      if (archiveBusy) return;
      setArchiveError('');
      try {
        const picked = await ipcRenderer.invoke('workspace:pick-archive-parent');
        if (picked && picked.path) archiveParent = picked.path;
      } catch (error) {
        setArchiveError(`选择路径失败：${error && error.message ? error.message : String(error)}`);
      }
      paintArchiveModal();
    });
    archiveModalEl.querySelector('#workspace-archive-submit').addEventListener('click', () => void submitArchive());
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && archiveModalEl && archiveModalEl.style.display !== 'none' && !archiveBusy) closeArchiveModal();
    });
    return archiveModalEl;
  }

  function openArchiveContext(context) {
    ensureArchiveModal();
    archiveContext = context;
    archiveParent = null;
    archiveBusy = false;
    archiveDoneWithWarnings = false;
    archiveReturnFocus = document.activeElement;
    setArchiveWarningList([]);
    setArchiveError(context.resumeReady === false
      ? `正在等待安全重连信息：${(context.resumeIssues || []).join('；')}`
      : '');
    archiveModalEl.querySelector('#workspace-archive-label').textContent = context.label || context.title || '未命名任务';
    archiveModalEl.querySelector('#workspace-archive-source').textContent = compactPath(context.source, 76);
    archiveModalEl.querySelector('#workspace-archive-source').title = context.source || '';
    const categories = archiveModalEl.querySelector('#workspace-archive-categories');
    categories.innerHTML = (context.categories || []).map(item => `<button type="button" data-archive-parent="${escapeHtml(item.path)}" aria-pressed="false"><span>${escapeHtml(item.name)}</span><small>${escapeHtml(compactPath(item.path, 34))}</small></button>`).join('');
    categories.querySelectorAll('[data-archive-parent]').forEach(button => {
      button.addEventListener('click', () => {
        archiveParent = button.dataset.archiveParent;
        setArchiveError('');
        paintArchiveModal();
      });
    });
    const input = archiveModalEl.querySelector('#workspace-archive-folder-name');
    input.value = (context.workspace && context.workspace.suggestedName) || context.title || 'new-project';
    archiveModalEl.style.display = 'flex';
    paintArchiveModal();
    const firstCategory = categories.querySelector('button');
    (firstCategory || archiveModalEl.querySelector('#workspace-archive-custom-parent')).focus();
  }

  function closeArchiveModal() {
    if (!archiveModalEl || archiveBusy) return;
    // 这里原来会把「已问过」标记删掉，于是每轮回答结束都会重新弹一次归档框——
    // 用户点了「暂留 _scratch」等于白点。关闭 = 用户已经做过决定，本次运行不再打扰；
    // 同时落盘到 workspace 注册表，Hub 重启后也不再问同一个 workspace。
    if (archiveContext) {
      const key = `${archiveContext.scope}:${archiveContext.id}`;
      archivePromptedKeys.add(key);
      archiveSurfacedKeys.add(key);
      // 用户已经处理过这条建议（归档完成或明确暂留），chip 上的提示态要跟着落下，
      // 否则下一次 header 重绘又会把琥珀边点亮，看起来像没生效。
      archiveSuggestions.delete(key);
      if (archiveContext.source) {
        void ipcRenderer.invoke('workspace:dismiss-archive', { path: archiveContext.source })
          .catch(error => console.warn('[workspace] dismiss archive failed:', error && error.message));
      }
    }
    archiveModalEl.style.display = 'none';
    archiveDoneWithWarnings = false;
    setArchiveWarningList([]);
    archiveContext = null;
    archiveParent = null;
    if (archiveReturnFocus && typeof archiveReturnFocus.focus === 'function') archiveReturnFocus.focus();
    archiveReturnFocus = null;
    const next = archiveQueue.shift();
    if (next) setTimeout(() => openArchiveContext(next), 0);
  }

  async function submitArchive() {
    // 归档已经跑完、只剩「知道了」等用户确认降级信息时，这个按钮就是关闭键。
    if (archiveDoneWithWarnings) {
      closeArchiveModal();
      return;
    }
    if (!archiveContext || archiveBusy) return;
    const target = archiveTargetPath();
    if (!target) return;
    const key = `${archiveContext.scope}:${archiveContext.id}`;
    const input = archiveModalEl.querySelector('#workspace-archive-folder-name');
    archiveBusy = true;
    setArchiveError('');
    setArchiveWarningList([]);
    archiveWarnings.delete(key);
    paintArchiveModal();
    const submit = archiveModalEl.querySelector('#workspace-archive-submit');
    submit.textContent = '正在安全重连…';
    try {
      const result = await ipcRenderer.invoke('workspace:archive-and-restart', {
        scope: archiveContext.scope,
        id: archiveContext.id,
        parent: archiveParent,
        folderName: safeFolderName(input.value),
      });
      if (!result || !result.ok) throw new Error('归档未返回成功状态');
      // 返回值里的 warnings 与归档过程中推来的事件合并——两条腿都收，避免任一
      // 时序下漏掉降级信息。
      recordArchiveWarnings(key, result.warnings);
      const warnings = archiveWarnings.get(key) || [];
      window.dispatchEvent(new CustomEvent('workspace-archive-completed', {
        detail: { ...result, warnings },
      }));
      archiveBusy = false;
      if (warnings.length > 0) {
        // 归档本身成功了，不该报错，但也绝不能像以前那样只写 main 进程 console
        // 就当处理完了：框留在原地，把降级项摆出来，用户按「知道了」才关。
        archiveDoneWithWarnings = true;
        submit.textContent = '知道了';
        submit.disabled = false;
        setArchiveWarningList(warnings);
        return;
      }
      submit.textContent = '归档并继续';
      closeArchiveModal();
    } catch (error) {
      archiveBusy = false;
      submit.textContent = '重试归档';
      setArchiveError(error && error.message ? error.message : String(error));
      // 失败路径同样要带上已经推来的降级信息：main 里 restart 失败会 throw，
      // 那之前累积的 codex/transcript 降级过去就跟着返回值一起消失了。
      setArchiveWarningList(archiveWarnings.get(key) || []);
      paintArchiveModal();
    }
  }

  async function maybePromptArchive(scope, id) {
    const key = `${scope}:${id}`;
    if (!id || archivePendingKeys.has(key)) return false;
    // 判重要求两条同时成立：问过 + 真的呈现过。
    // 只满足前者的 key 是 P1-2 留下的历史损伤（建议被塞进没人读的 Map），
    // 补上 UI 之后必须放行重试，否则那些会话永远不会再被提示。
    if (archivePromptedKeys.has(key) && archiveSurfacedKeys.has(key)) return false;
    archivePendingKeys.add(key);
    try {
      let context = null;
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        context = await ipcRenderer.invoke('workspace:archive-context', { scope, id });
        if (!context || !context.required) return false;
        if (context.workspace && context.workspace.suggestedName && context.resumeReady !== false) {
          ready = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      // 轮询跑满还没就绪 = 拿到的是半成品 context（点开只会看到「正在等待安全重连信息」）。
      // 这种情况不落「已问过」标记，让下一轮 turn 结束时重新取一次，
      // 否则一个时序不巧的会话会被永久钉死在残缺建议上。
      if (ready) archivePromptedKeys.add(key);
      // 2026-07-29：不再自动弹全局模态。
      // 旧行为是首轮一结束就把归档框糊到用户脸上——既打断当前阅读，又可能弹在
      // 用户根本没在看的那个会话上（模态是全局的，不属于任何 session）。
      // 现在只记下建议并广播，由 workspace chip 上的一个轻提示承载，
      // 用户点它才打开归档框。什么都不点就当没这回事，不再追问。
      archiveSuggestions.set(key, context);
      if (ready) archiveSurfacedKeys.add(key);
      try {
        window.dispatchEvent(new CustomEvent('workspace-archive-suggestion', {
          detail: { key, scope, id, context },
        }));
      } catch {}
      return true;
    } catch (error) {
      console.warn('[workspace] archive reminder failed:', error && error.message);
      return false;
    } finally {
      archivePendingKeys.delete(key);
    }
  }

  // AI 群聊 header 的 workspace chip（meeting-room.js）和独立会话 header 的
  // 📁 路径（renderer.js renderMetricsRow）共用这一个函数。
  //
  // P1-2 的根因就是这段逻辑只在群聊侧写过一遍：独立会话的建议被存进
  // archiveSuggestions 之后没有任何消费点，用户永远看不到提示。抽成一个函数
  // 是为了让「只改一边」在结构上不再可能。
  //
  // 行为：有建议 → 加 has-archive-hint + 换 title，点击打开归档框；
  //       没建议 → 保持调用方当前行为（两处都是「打开工作目录」）。
  // 调用方每次重渲染都会重建元素，所以这里直接 addEventListener 不会重复绑定。
  function attachArchiveHint(el, scope, id, options = {}) {
    if (!el || !id) return false;
    const key = `${scope}:${id}`;
    const runFallback = () => {
      if (typeof options.onFallback === 'function') options.onFallback();
    };
    if (archiveSuggestions.has(key)) {
      el.classList.add('has-archive-hint');
      el.title = options.hintTitle || '这个任务还在临时区 · 点击归档到正式项目目录';
    } else {
      el.classList.remove('has-archive-hint');
      if (options.idleTitle) el.title = options.idleTitle;
    }
    el.addEventListener('click', () => {
      const context = archiveSuggestions.get(key);
      if (!context) {
        runFallback();
        return;
      }
      el.classList.remove('has-archive-hint');
      openArchiveContext(context);
    });
    return true;
  }

  // main 在归档过程中推来的降级信息。即使随后 restart 失败 throw，
  // 这些也已经落在 renderer 侧，不会跟着返回值一起丢。
  ipcRenderer.on('workspace-archive-warning', (_event, entry) => {
    if (!entry || !entry.id) return;
    recordArchiveWarnings(`${entry.scope}:${entry.id}`, [entry]);
  });

  async function createScratch(label = '未命名任务') {
    return ipcRenderer.invoke('workspace:create-scratch', { label });
  }

  // 平铺模式下的默认工作区 = 工作根本身。工作根没挂 .aiwork-root 标记时，
  // 主进程会自动退回建 _scratch，所以 renderer 这边不需要分支。
  async function createDefaultWorkspace(label = '未命名任务') {
    return ipcRenderer.invoke('workspace:default', { label });
  }

  async function pickWorkspace() {
    return ipcRenderer.invoke('workspace:pick');
  }

  async function createSession(kind, options = {}) {
    let workspace = options.workspace || null;
    if (!workspace && options.cwd) {
      workspace = await ipcRenderer.invoke('workspace:select', options.cwd);
    }
    // 兜底改成「默认工作区」而不是「新建 scratch」：平铺模式下任何没指定目录的
    // 入口（快捷键、外部调用、恢复流程）都该落到工作根，而不是又造一个一次性目录。
    if (!workspace) workspace = await createDefaultWorkspace(options.workspaceLabel || '未命名任务');
    return ipcRenderer.invoke('create-session', {
      kind,
      opts: {
        ...(options.opts || {}),
        cwd: workspace.path,
        workspaceLabel: workspace.label,
        workspaceDraft: !!workspace.draft,
      },
    });
  }

  function setError(message = '') {
    const errorEl = document.getElementById('new-session-error');
    if (!errorEl) return;
    errorEl.textContent = message.replace(/Error invoking remote method '[^']+': (?:Error: )?/, '');
    errorEl.hidden = !message;
    if (message && (selectedKind === 'chatgpt' || /官方登录界面|登录入口/.test(message))) errorEl.scrollIntoView({ block: 'nearest' });
  }

  // Recent workspaces are the primary way to pick an existing path; the OS folder
  // dialog stays available as the fallback for directories Hub has never seen.
  async function loadRecent() {
    try {
      const listing = await ipcRenderer.invoke('workspace:list');
      scratchRoot = (listing && listing.scratchRoot) || scratchRoot;
      workspaceRoot = (listing && listing.root) || workspaceRoot;
      flatWorkRoot = !!(listing && listing.flatRoot);
      recommendedItems = ((listing && listing.recommended) || [])
        .filter(item => item && item.path);
      recentItems = ((listing && listing.items) || [])
        .filter(item => item && item.path && !item.legacy)
        .slice(0, RECENT_LIMIT);
    } catch (error) {
      recommendedItems = [];
      recentItems = [];
      console.warn('[workspace] recent list failed:', error && error.message);
    }
    renderRecommendations();
    renderRecent();
  }

  function renderRecommendations() {
    const section = document.getElementById('new-session-recommended-section');
    const listEl = document.getElementById('new-session-recommended');
    if (!section || !listEl) return;
    section.hidden = recommendedItems.length === 0;
    if (recommendedItems.length === 0) {
      listEl.innerHTML = '';
      return;
    }
    listEl.innerHTML = recommendedItems.map(item => {
      const selected = !!existingWorkspace
        && workspacePathKey(existingWorkspace.path) === workspacePathKey(item.path);
      return `<button type="button" class="session-recommended-item${selected ? ' selected' : ''}" role="option"`
        + ` aria-selected="${selected ? 'true' : 'false'}" data-recommended-path="${escapeHtml(item.path)}" title="${escapeHtml(item.path)}">`
        + `<strong>${escapeHtml(item.label || path.basename(item.path))}</strong>`
        + `<span>${escapeHtml(item.description || workspaceTierLabel(item.tier))}</span>`
        + `<small>${escapeHtml(compactPath(item.path, 30))}</small></button>`;
    }).join('');
    listEl.querySelectorAll('[data-recommended-path]').forEach(button => {
      button.addEventListener('click', () => {
        const target = recommendedItems.find(item => workspacePathKey(item.path) === workspacePathKey(button.dataset.recommendedPath));
        if (!target) return;
        existingWorkspace = target;
        workspaceMode = 'existing';
        setError('');
        renderRecommendations();
        renderRecent();
        paint();
      });
    });
  }

  async function loadPreparedProjects() {
    const loadId = ++projectLoadId;
    const list = document.getElementById('new-session-project-library');
    if (!list) return;
    list.textContent = '正在读取项目库…';
    try {
      const result = await ipcRenderer.invoke('workspace:prepared-projects');
      if (loadId !== projectLoadId) return;
      if (!Array.isArray(result?.items)) throw new Error('项目库返回格式无效');
      preparedProjects = result.items.filter(item => item && item.path);
      renderPreparedProjects();
    } catch (error) {
      if (loadId !== projectLoadId) return;
      preparedProjects = [];
      list.textContent = `项目库读取失败：${error.message}。可点击刷新重试，或浏览文件夹。`;
    }
  }

  function renderPreparedProjects() {
    const list = document.getElementById('new-session-project-library');
    if (!list) return;
    list.replaceChildren();
    if (!preparedProjects.length) {
      list.textContent = '暂无已整理的项目，可从下方最近工作区或浏览文件夹选择。';
      return;
    }
    for (const item of preparedProjects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-recent-item';
      button.setAttribute('role', 'option');
      const selected = workspacePathKey(existingWorkspace?.path) === workspacePathKey(item.path);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', String(selected));
      button.dataset.projectPath = item.path;
      button.title = item.path;
      const text = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = item.name || path.basename(item.path);
      const location = document.createElement('small');
      location.textContent = item.path;
      text.append(name, location);
      button.append(text);
      button.addEventListener('click', async () => {
        button.disabled = true;
        setError('');
        try {
          const workspace = await ipcRenderer.invoke('workspace:select', item.path);
          if (!workspace?.path) throw new Error('项目目录不可用');
          existingWorkspace = workspace;
          workspaceMode = 'existing';
          await loadRecent();
          paint();
        } catch (error) {
          setError(`选择项目失败：${error.message}`);
        } finally {
          button.disabled = false;
          renderPreparedProjects();
        }
      });
      list.append(button);
    }
  }

  function renderRecent() {
    const listEl = document.getElementById('new-session-recent');
    if (!listEl) return;
    const recommendedKeys = new Set(recommendedItems.map(item => workspacePathKey(item.path)));
    const visibleRecentItems = recentItems.filter(item => !recommendedKeys.has(workspacePathKey(item.path)));
    if (visibleRecentItems.length === 0) {
      listEl.innerHTML = '<div class="session-recent-empty">暂无最近工作区，用右上角「浏览文件夹…」选择。</div>';
      return;
    }
    listEl.innerHTML = visibleRecentItems.map(item => {
      const selected = !!existingWorkspace && existingWorkspace.path === item.path;
      const disabled = item.tier === 'root';
      const badges = [];
      if (item.tier && item.tier !== 'project') {
        badges.push(`<span class="session-recent-badge tier-${escapeHtml(item.tier)}">${escapeHtml(workspaceTierLabel(item.tier))}</span>`);
      }
      if (item.draft && item.tier !== 'scratch') badges.push('<span class="session-recent-badge">临时</span>');
      if (item.pinned) badges.push('<span class="session-recent-badge">置顶</span>');
      return `<button type="button" class="session-recent-item${selected ? ' selected' : ''}" role="option"`
        + ` aria-selected="${selected ? 'true' : 'false'}" data-recent-path="${escapeHtml(item.path)}"`
        + ` title="${escapeHtml(disabled ? `${workspaceTierLabel(item.tier)}：${item.path}` : item.path)}"`
        + `${disabled ? ' disabled aria-disabled="true"' : ''}>`
        + `<div><strong>${escapeHtml(item.label || path.basename(item.path))}</strong>`
        + `<small>${escapeHtml(compactPath(item.path, 52))}</small></div><span class="session-recent-badges">${badges.join('')}</span></button>`;
    }).join('');
    listEl.querySelectorAll('[data-recent-path]').forEach(button => {
      button.addEventListener('click', () => {
        const target = visibleRecentItems.find(item => item.path === button.dataset.recentPath);
        if (!target) return;
        existingWorkspace = target;
        workspaceMode = 'existing';
        setError('');
        renderRecommendations();
        renderRecent();
        paint();
      });
    });
  }

  // 「设为默认」按钮的三种状态：已是默认（禁用，用来回答"当前默认是不是它"）、
  // 可设为默认、以及 chatgpt 这种没有稳定模型 id 的 kind（整个隐藏）。
  function paintDefaultModelButton() {
    const button = document.getElementById('new-session-model-default');
    if (!button) return;
    const supported = !!selectedModel && selectedKind !== 'chatgpt';
    button.hidden = !supported;
    if (!supported) return;
    const already = isDefaultModel(selectedKind, selectedModel, defaultModelConfig());
    button.disabled = already;
    button.textContent = already ? '默认 ✓' : '设为默认';
    button.title = already
      ? `新建 ${selectedKind} 会话时默认就用这个模型`
      : `把 ${selectedModel} 设为新建 ${selectedKind} 会话的默认模型`;
  }

  function paintTuning() {
    const accountField=document.getElementById('new-session-account-field');
    const accountSelect=document.getElementById('new-session-account');
    const accountNote=document.getElementById('new-session-account-note');
    const showAccount=selectedKind === 'codex' && codexBackend !== 'api';
    if (accountField) accountField.hidden=!showAccount;
    if (accountNote) {
      accountNote.hidden=!showAccount;
      accountNote.textContent=accountReadError || (accountSaving ? '正在切换全局账号…' : accountNotice)
        || '选择后，新建、恢复和重启使用所选账号额度；已打开的会话继续使用原账号。';
    }
    if (accountSelect) {
      const signature=JSON.stringify(codexAccounts);
      if (accountSelect.dataset.accounts !== signature) {
        // The hand-typed label has been wrong before; lead with the account the profile is
        // actually logged into and keep the label as the secondary hint.
        accountSelect.innerHTML=codexAccounts.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.email ? `${p.email}（${p.label || p.id}）` : `${p.label || p.id} · 账号未确认`)}</option>`).join('');
        accountSelect.dataset.accounts=signature;
      }
      accountSelect.value=pendingAccountId || codexAccountId;
      accountSelect.disabled=accountSaving || submitting || !codexAccounts.length || !!accountReadError;
    }
    const label = document.getElementById('new-session-tuning-label');
    const grid = document.getElementById('new-session-tuning');
    const modelSelect = document.getElementById('new-session-model');
    const effortField = document.getElementById('new-session-effort-field');
    const effortSelect = document.getElementById('new-session-effort');
    const mcpField = document.getElementById('new-session-mcp-field');
    const mcpSelect = document.getElementById('new-session-mcp');
    if (!grid || !modelSelect) return;

    const options = modelOptionsFor(selectedKind);
    const hasModels = options.length > 0;
    if (label) label.hidden = !hasModels;
    grid.hidden = !hasModels;
    if (!hasModels) {
      // PowerShell 之类没有模型的 kind 整块 grid 隐藏。但提示条在 grid 外面，
      // 早退不管它就会把上一个 kind 的文案（"Codex 没有 fast 模式…"）留在屏幕上。
      // 顺手把三个 field 也归位，免得 hidden 属性停在上一个 kind 的状态。
      const staleNote = document.getElementById('new-session-tuning-note');
      if (staleNote) { staleNote.hidden = true; staleNote.textContent = ''; }
      for (const id of [
        'new-session-effort-field',
        'new-session-mcp-field',
        'new-session-fast-field',
        'new-session-codex-tier-field',
      ]) {
        const field = document.getElementById(id);
        if (field) field.hidden = true;
      }
      return;
    }

    if (!options.some(option => option.id === selectedModel)) {
      selectedModel = selectedKind === 'chatgpt' && selectedModel.startsWith('chatgpt-web/')
        ? selectedModel
        : resolveDefaultModel(selectedKind, defaultModelConfig(), options.map(option => option.id));
    }
    const wanted = options.map(option => `${option.id}\u0000${option.label}`).join('|');
    if (modelSelect.dataset.builtFor !== wanted) {
      modelSelect.innerHTML = options
        .map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`)
        .join('');
      modelSelect.dataset.builtFor = wanted;
    }
    modelSelect.querySelector('[data-chatgpt-unavailable]')?.remove();
    if (selectedKind === 'chatgpt' && !options.some(option => option.id === selectedModel)) {
      const unavailable = document.createElement('option');
      unavailable.value = selectedModel;
      unavailable.textContent = '原档位当前不可用，请选择模型';
      unavailable.disabled = true;
      unavailable.dataset.chatgptUnavailable = 'true';
      modelSelect.appendChild(unavailable);
    }
    modelSelect.value = selectedModel;
    paintDefaultModelButton();

    const effortLabel = document.getElementById('new-session-effort-label');
    const fastField = document.getElementById('new-session-fast-field');
    const fastCheckbox = document.getElementById('new-session-fast');
    const note = document.getElementById('new-session-tuning-note');

    const codexTierField = document.getElementById('new-session-codex-tier-field');
    const codexTierSelect = document.getElementById('new-session-codex-tier');

    const showEffort = EFFORT_KINDS.has(selectedKind);
    const showMcp = MCP_KINDS.has(selectedKind);
    const showFast = FAST_KINDS.has(selectedKind);
    const showCodexTier = CODEX_TIER_KINDS.has(selectedKind);

    if (effortField) effortField.hidden = !showEffort;
    if (showEffort) {
      if (effortLabel) effortLabel.textContent = EFFORT_LABEL_BY_KIND[selectedKind] || '思考强度';
      const effortOptions = effortOptionsFor(selectedKind, selectedModel);
      fillSelect(effortSelect, effortOptions);
      // 切 kind / 切模型之后旧档位可能不在新枚举里（gpt-5.6-sol 的 ultra → 5.5 没有），
      // 回落而不是把非法值送进命令行。回落到该模型支持的最高档，不硬套 max。
      if (!effortOptions.some(([value]) => value === selectedEffort)) {
        const kindDefaultEffort = defaultEffortFor(selectedKind);
        selectedEffort = effortOptions.some(([value]) => value === kindDefaultEffort)
          ? kindDefaultEffort
          : (effortOptions[0] ? effortOptions[0][0] : kindDefaultEffort);
      }
      if (effortSelect) effortSelect.value = selectedEffort;
    }

    if (codexTierField) codexTierField.hidden = !showCodexTier;
    if (showCodexTier) {
      const tierOptions = codexTierOptionsFor(selectedModel);
      fillSelect(codexTierSelect, tierOptions);
      if (!tierOptions.some(([value]) => value === selectedCodexTier)) selectedCodexTier = defaultCodexSpeedFor(selectedKind, selectedModel);
      if (codexTierSelect) codexTierSelect.value = selectedCodexTier;
    }

    if (mcpField) mcpField.hidden = !showMcp;
    if (showMcp) {
      fillSelect(mcpSelect, mcpOptionsFor(selectedKind));
      if (!mcpOptionsFor(selectedKind).some(([value]) => value === selectedMcpProfile)) {
        selectedMcpProfile = defaultMcpFor(selectedKind);
      }
      if (mcpSelect) mcpSelect.value = selectedMcpProfile;
    }

    if (fastField) fastField.hidden = !showFast;
    if (fastCheckbox) fastCheckbox.checked = selectedFastMode;

    if (note) {
      const lines = [];
      // fast 有真实代价，别只写"更快"就完事：2026-06-11 实测 fastMode 交互式会话
      // 不落盘 transcript jsonl，卡片视图因此收不到回复。用户有权在勾之前知道。
      if (showFast && selectedFastMode) lines.push('fast 更快出字，但交互式会话可能不落 transcript，卡片视图收不到回复时可关掉它。');
      if (showCodexTier && selectedCodexTier === 'inherit') {
        lines.push('「跟随全局配置」不覆盖 ~/.codex/config.toml；若全局开启 Fast，本会话也会 Fast。');
      }
      if (showCodexTier && selectedCodexTier === 'standard') lines.push('Standard 会在本次启动显式关闭 Codex Fast，不改写全局配置。');
      if (showCodexTier && selectedCodexTier === 'fast') lines.push('Fast 会在本次启动使用 priority 通道，不改写全局配置。');
      if (showCodexTier && !codexModelTuning(selectedModel).fromCache) {
        lines.push('未读到 codex 模型目录（~/.codex/models_cache.json），思考强度用的是保守兜底档位。');
      }
      if (selectedKind === 'codex' && codexTuningCatalog && codexTuningCatalog.refreshError) {
        lines.push('Codex 在线目录刷新失败，当前显示最近一次 CLI 本地缓存；下次打开会自动重试。');
      } else if (selectedKind === 'codex' && codexTuningCatalog) {
        lines.push(codexTuningCatalog.source === 'codex-app-server'
          ? '模型目录来自当前 Codex 账号的实时 model/list；打开界面时自动刷新。'
          : '模型目录来自 Codex CLI 本地缓存；打开界面时自动重读。');
      }
      if (selectedKind === 'claude' && claudeModelCatalog && claudeModelCatalog.catalogLoaded) {
        lines.push('额外模型来自当前 Claude Code 账号缓存；最新别名由 CLI 在切换时解析。');
      } else if (selectedKind === 'claude' && claudeModelCatalog && claudeModelCatalog.refreshError) {
        lines.push('Claude 账号模型缓存读取失败，当前显示内置兼容目录；下次打开会自动重试。');
      }
      if (showMcp && selectedMcpProfile !== 'full') lines.push('非 Full 档只在本次启动生效，不会改写你的全局 MCP 配置。');
      if (selectedKind === 'codex' && selectedMcpProfile === 'none') lines.push('None 会同时阻止 workspace、群聊通信与投研 MCP 注入。');
      if (selectedKind === 'codex' && defaultCodexContextWindow(selectedModel)) {
        const tuning = codexModelTuning(selectedModel);
        const catalogMax = formatTokenCount(tuning.maxContextWindow);
        const estimatedEffective = formatTokenCount(tuning.estimatedMaxEffectiveContextWindow);
        if (catalogMax && estimatedEffective) {
          const percent = Number(tuning.effectiveContextWindowPercent);
          lines.push(`Hub 会请求 1,000,000 tokens；当前模型目录最多接受 ${catalogMax}`
            + `${Number.isFinite(percent) ? `，按 ${percent}% 有效系数预计运行时为 ${estimatedEffective}` : ''}`
            + '。启动后以 Codex 的实时回报为准。');
        } else {
          lines.push('1M 是会话启动请求；实际可用窗口仍受当前 Codex 模型目录上限约束，启动后以实时回报为准。');
        }
      }
      if (selectedKind === 'claude' && selectedMcpProfile === 'full') lines.push('Claude 默认 Full：七个全局 MCP 各起一个常驻进程，开多个会话时可换 Lean 省内存。');
      note.hidden = lines.length === 0;
      note.textContent = lines.join(' ');
    }

    grid.style.gridTemplateColumns = (showEffort || showMcp || showFast || showCodexTier) ? '' : '1fr';
  }

  function fillSelect(selectEl, entries) {
    if (!selectEl) return;
    const signature = entries.map(([value, label]) => `${value}\u0000${label}`).join('|');
    if (selectEl.dataset.builtFor === signature) return;
    selectEl.innerHTML = entries
      .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
      .join('');
    selectEl.dataset.builtFor = signature;
  }

  function paint() {
    if (!menuEl) return;
    const webPanel = document.getElementById('chatgpt-web-panel');
    if (webPanel) webPanel.hidden = selectedKind !== 'chatgpt';
    const webStatus = document.getElementById('chatgpt-web-status');
    if (webStatus) webStatus.textContent = chatgptCatalog?.message || '正在读取 Codex Web GPT 配置…';
    menuEl.querySelectorAll('.new-session-option').forEach(button => {
      const selected = button.dataset.kind === (selectedKind === 'deepseek-acp' ? 'deepseek' : selectedKind);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    menuEl.querySelectorAll('.session-workspace-choice').forEach(button => {
      const selected = button.dataset.workspaceMode === workspaceMode;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
    });

    paintTuning();

    const routeField = document.getElementById('new-session-deepseek-route-field');
    if (routeField) routeField.hidden = !['deepseek','deepseek-acp'].includes(selectedKind);
    const routeSelect = document.getElementById('new-session-deepseek-route');
    if (routeSelect && routeField && !routeField.hidden) routeSelect.value = selectedKind;
    const existingRow = document.getElementById('new-session-existing-path');
    menuEl.querySelectorAll('[data-project-path]').forEach(button => {
      const selected = workspacePathKey(existingWorkspace?.path) === workspacePathKey(button.dataset.projectPath);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    const pathValue = document.getElementById('new-session-path-value');
    if (existingRow) existingRow.hidden = workspaceMode !== 'existing';
    if (pathValue) {
      pathValue.textContent = existingWorkspace
        ? `${workspaceTierLabel(existingWorkspace.tier)} · ${compactPath(existingWorkspace.path)}`
        : '尚未选择';
      pathValue.title = existingWorkspace ? existingWorkspace.path : '';
    }
    const summary = document.getElementById('new-session-summary');
    if (summary) {
      // 外层 span 是 rtl（为了从左侧省略），内容必须用 bdi 包回 ltr，
      // 否则路径里的 `\` 和标点会被双向算法重排。
      summary.innerHTML = `<bdi>${escapeHtml(summaryText())}</bdi>`;
      summary.title = summaryTitle();
    }
    const submit = document.getElementById('new-session-submit');
    if (submit) submit.disabled = submitting || accountSaving || (selectedKind === 'codex' && !!accountReadError) || (workspaceMode === 'existing' && !existingWorkspace);
  }

  // The footer states where the session will actually land, so a mis-set
  // AI_HUB_WORKSPACE_ROOT is visible before the session is created.
  function targetPathPreview() {
    if (workspaceMode === 'existing') return existingWorkspace ? existingWorkspace.path : '';
    if (workspaceMode === 'default') return workspaceRoot || '默认工作目录';
    return scratchRoot ? path.join(scratchRoot, 'inbox-…') : '新建临时 workspace';
  }

  function tuningTag() {
    const options = modelOptionsFor(selectedKind);
    if (options.length === 0) return '';
    const model = options.find(option => option.id === selectedModel);
    const modelLabel = model ? model.label : selectedModel;
    if (selectedKind === 'codex') {
      return `${modelLabel} · ${selectedEffort} · ${MCP_PROFILE_LABELS[selectedMcpProfile] || 'No MCP'} · ${selectedCodexTier}`;
    }
    if (EFFORT_KINDS.has(selectedKind)) return `${modelLabel} · ${selectedEffort}`;
    return modelLabel;
  }

  function summaryText() {
    const parts = [KIND_LABELS[selectedKind] || selectedKind];
    if (selectedKind === 'codex' && codexBackend !== 'api') {const p=codexAccounts.find(x=>x.id===codexAccountId);parts.push(p?(p.email||p.label||p.id):'读取账号中');}
    const tuning = tuningTag();
    if (tuning) {
      if (selectedKind === 'chatgpt') parts[0] = tuning;
      else parts.push(tuning);
    }
    const target = targetPathPreview();
    if (workspaceMode === 'existing' && existingWorkspace) parts.push(workspaceTierLabel(existingWorkspace.tier));
    parts.push(target ? compactPath(target, 46) : '请选择目录');
    return parts.join(' · ');
  }

  function summaryTitle() {
    const target = targetPathPreview();
    return target
      ? `${workspaceMode === 'existing' && existingWorkspace ? `${workspaceTierLabel(existingWorkspace.tier)}：` : ''}${target}`
      : '请选择目录';
  }

  async function chooseExistingPath() {
    setError('');
    try {
      const workspace = await pickWorkspace();
      if (workspace && workspace.path) {
        existingWorkspace = workspace;
        workspaceMode = 'existing';
        await loadRecent();
      }
    } catch (error) {
      setError(`选择目录失败：${error && error.message ? error.message : String(error)}`);
    }
    renderRecent();
    paint();
    return existingWorkspace;
  }

  function closeNewSessionModal() {
    if (menuEl) menuEl.style.display = 'none';
    setError('');
    window.dispatchEvent(new CustomEvent('launch-center:closed'));
  }

  function openNewSessionModal(options = {}) {
    if (!menuEl) return;
    selectedKind = KIND_LABELS[options.kind] ? options.kind : require('./codeagent-preference').preferredKind(Object.keys(KIND_LABELS));
    const requestedWorkspace = options.workspace && typeof options.workspace.path === 'string'
      ? { ...options.workspace }
      : null;
    workspaceMode = requestedWorkspace ? 'existing' : 'default';
    existingWorkspace = requestedWorkspace;
    void loadPreparedProjects();
    submitting = false;
    selectedModel = selectedKind === 'chatgpt'
      ? 'chatgpt-web/high'
      : resolveDefaultModel(selectedKind, defaultModelConfig());
    modelTouchedByUser = false;
    applyTuningMemory(selectedKind);
    // 配置可能在别处被改过（设置面板、手改 config.json）。重读一次再决定预选值。
    //
    // 判据只能是「用户这轮有没有亲手动过模型下拉」，不能拿「当前值是否等于出厂
    // 默认」来推断：同步那次 paint 可能已经把值换成了 options[0]（出厂默认不在
    // 当前清单里时就会这样），判据直接落空、用户设的默认值被丢掉；反过来，用户
    // 手选的模型若恰好等于出厂默认，又会被这次回读悄悄改掉。
    void loadHubDefaultModels().then(async () => {
      await loadModelCatalog(selectedKind);
      if (!modelTouchedByUser && selectedKind !== 'chatgpt') {
        selectedModel = resolveDefaultModel(
          selectedKind,
          defaultModelConfig(),
          modelOptionsFor(selectedKind).map(option => option.id),
        );
      }
      paint();
    }).catch(() => {});
    setError('');
    renderRecommendations();
    renderRecent();
    paint();
    // 「默认」档的页脚要显示真实的工作根路径，所以打开时就得先拿到 workspace:list，
    // 而不是等用户切到「选择已有路径」才加载 —— 否则默认档一直显示占位文案。
    void loadRecent().then(() => { renderRecommendations(); renderRecent(); paint(); });
    // 必须是 flex：.new-session-menu 用 column flex 把 head/footer 固定、中段滚动。
    // 早期这里写的是 'block'，内联样式压过 CSS 的 display:flex，
    // 于是 .session-create-body 拿不到 flex 高度，overflow-y 不生效，
    // max-height + overflow:hidden 直接把「创建会话」按钮裁掉。
    menuEl.style.display = 'flex';
    // Direct callers (workspace cards, launch links, E2E helpers) still open
    // this controller without going through the unified launcher. Always reset
    // the shell to the session intent before focusing the selected provider.
    window.dispatchEvent(new CustomEvent('launch-center:session-opened'));
    const selected = menuEl.querySelector(`.new-session-option[data-kind="${selectedKind === 'deepseek-acp' ? 'deepseek' : selectedKind}"]`);
    if (selected) selected.focus();
    void loadRecent().then(paint);
    // 每次打开都向当前 CLI 目录服务取一次（main 有短 TTL），不把模型表冻结到 Hub 启动时。
    void loadModelCatalog(selectedKind).then(paint);
  }

  // 记住每个 kind 上次调过的档位：在 Claude / Codex 之间来回切时不用重选。
  // 键按 kind 存而不是全局一份 —— 两家的合法枚举和默认值都不一样。
  function rememberTuning(kind) {
    tuningMemory.set(kind, {
      ...(kind === 'chatgpt' ? { model: selectedModel } : {}),
      effort: selectedEffort,
      mcpProfile: selectedMcpProfile,
      fastMode: selectedFastMode,
      codexSpeedTier: selectedCodexTier,
    });
  }

  function applyTuningMemory(kind) {
    const saved = tuningMemory.get(kind);
    if (kind === 'chatgpt') selectedModel = saved?.model || 'chatgpt-web/high';
    selectedEffort = (saved && saved.effort) || defaultEffortFor(kind);
    selectedMcpProfile = (saved && saved.mcpProfile) || defaultMcpFor(kind);
    selectedFastMode = saved && typeof saved.fastMode === 'boolean' ? saved.fastMode : DEFAULT_FAST_MODE;
    selectedCodexTier = (saved && saved.codexSpeedTier) || defaultCodexSpeedFor(kind, selectedModel);
  }

  // Main 优先调用 codex app-server model/list；失败再读 models_cache.json。
  // renderer 不做永久缓存，main 的短 TTL 既避免频繁拉进程，又能在 CLI 更新目录后自动刷新。
  async function loadCodexTuningCatalog(options = {}) {
    const profileId=options.codexProfile || codexAccountId;
    if (codexCatalogInFlight.has(profileId)) return codexCatalogInFlight.get(profileId);
    const task = (async () => {
      try {
        const result = await ipcRenderer.invoke('codex:tuning-catalog', {
          force: options.force === true,
          codexProfile: profileId || undefined,
        });
        if (profileId !== codexAccountId) return result;
        if (result && result.ok) {
          codexTuningCatalog = result;
          if (Array.isArray(result.models) && result.models.length) {
            setRuntimeModelOptions('codex', result.models);
          }
        }
      } catch (error) {
        if (profileId !== codexAccountId) throw error;
        codexTuningCatalog = {
          ok: false,
          refreshError: error && error.message ? error.message : String(error),
          source: 'static-fallback',
        };
      }
      return codexTuningCatalog;
    })().finally(() => { codexCatalogInFlight.delete(profileId); });
    codexCatalogInFlight.set(profileId,task);
    return task;
  }

  async function loadClaudeModelCatalog() {
    if (claudeCatalogInFlight) return claudeCatalogInFlight;
    claudeCatalogInFlight = (async () => {
      try {
        const result = await ipcRenderer.invoke('claude:model-catalog');
        if (result && result.ok) {
          claudeModelCatalog = result;
          if (Array.isArray(result.models) && result.models.length) {
            setRuntimeModelOptions('claude', result.models);
          }
        }
      } catch (error) {
        claudeModelCatalog = {
          ok: false,
          refreshError: error && error.message ? error.message : String(error),
          source: 'static-fallback',
        };
      }
      return claudeModelCatalog;
    })().finally(() => { claudeCatalogInFlight = null; });
    return claudeCatalogInFlight;
  }

  function loadModelCatalog(kind, options = {}) {
    const base = String(kind || '').replace(/-resume$/, '');
    if (base === 'chatgpt') {
      return ipcRenderer.invoke('chatgpt-web:status').then(result => {
        chatgptCatalog = result;
        setRuntimeModelOptions('chatgpt', result.models || []);
        return result;
      }).catch(error => {
        chatgptCatalog = { ok: false, models: [], message: error.message };
        setRuntimeModelOptions('chatgpt', []);
        return chatgptCatalog;
      });
    }
    if (require('../core/acp-profiles').isAcpKind(base)) return ipcRenderer.invoke('acp:settings:get').then(settings=>{
      const model=settings.providers?.[base]?.model;
      setRuntimeModelOptions(base,require('../core/acp-model-catalog').acpModelOptions(base,model));
      return settings;
    });
    if (base === 'codex') return loadCodexTuningCatalog(options);
    if (base === 'claude') return loadClaudeModelCatalog(options);
    return Promise.resolve(null);
  }

  function loadPrimaryModelCatalogs(options = {}) {
    return Promise.all([
      loadClaudeModelCatalog(options),
      loadCodexTuningCatalog(options),
      ...require('../core/acp-profiles').ACP_KINDS.map(kind=>loadModelCatalog(kind)),
    ]);
  }

  // Only send what the selected CLI understands: model for kinds with a model
  // list, effort/mcpProfile for the kinds whose CLI has the corresponding dial.
  // 省略等于沿用 session-manager 的默认值，所以只在"确实有这一档"时才传。
  function tuningOpts() {
    return buildSessionTuningOpts(selectedKind, selectedModel, {
      effort: selectedEffort,
      mcpProfile: selectedMcpProfile,
      fastMode: selectedFastMode,
      codexSpeedTier: selectedCodexTier,
    });
  }

  async function submitNewSession() {
    if (submitting || accountSaving || (selectedKind === 'codex' && accountReadError)) return null;
    setError('');
    let workspace = existingWorkspace;
    if (workspaceMode === 'existing' && !workspace) {
      workspace = await chooseExistingPath();
      if (!workspace) return null;
    }

    submitting = true;
    paint();
    const submit = document.getElementById('new-session-submit');
    if (submit) submit.textContent = selectedKind === 'chatgpt' ? '正在准备 ChatGPT…' : '创建中…';
    try {
      // 与群聊成员同一条准确性门：提交前等真实 Codex 模型目录并重新归一化，
      // 避免快速点击把 fallback 中该模型不支持的 effort 送进 PTY。
      await loadModelCatalog(selectedKind);
      paintTuning();
      if (workspaceMode === 'scratch') workspace = await createScratch('未命名任务');
      else if (workspaceMode === 'default') workspace = await createDefaultWorkspace('未命名任务');
      const session = await createSession(selectedKind, { workspace, opts: tuningOpts() });
      require('./codeagent-preference').rememberKind(selectedKind);
      closeNewSessionModal();
      return session;
    } catch (error) {
      setError(`创建失败：${error && error.message ? error.message : String(error)}`);
      return null;
    } finally {
      submitting = false;
      if (submit) submit.textContent = '创建会话';
      paint();
    }
  }

  function init() {
    menuEl = document.getElementById('new-session-menu');
    if (!menuEl) return;
    // 装了 CodeAgent 的电脑（公司内网）：把它排到会话类型第一位，默认选中它（见 renderer/codeagent-preference.js）。
    void require('./codeagent-preference').refresh(ipcRenderer).then(installed => {
      if (!installed) return;
      const grid = menuEl.querySelector('.session-kind-grid');
      const button = grid && grid.querySelector('.new-session-option[data-kind="codeagent"]');
      if (grid && button && grid.firstElementChild !== button) grid.insertBefore(button, grid.firstElementChild);
    });

    document.getElementById('new-session-account')?.addEventListener('change', async event => {
      if (accountSaving) return;
      const profileId=event.target.value;
      accountSaving=true;pendingAccountId=profileId;configReadRevision++;accountNotice='';setError('');paint();
      try {
        const result=await ipcRenderer.invoke('codex:set-global-account',{profileId,scope:'launch'});
        if (!result?.ok) throw new Error(result?.error || '账号切换失败');
        codexAccountId=result.profileId;
        const failed=(result.sessions || []).filter(s=>s?.error).length;
        const pending=(result.sessions || []).filter(s=>s?.pending).length;
        accountNotice=result.scope==='launch' ? '后续会话的用量账号已切换；已打开的会话保持原账号，新建、恢复和重启使用新账号。' : failed ? `全局账号已保存；${failed} 个会话切换失败，请查看会话提示并重试恢复。`
          : pending ? `全局账号已切换；${pending} 个进行中的会话将在本轮结束后切换。` : '全局账号已切换，新建、恢复和重启会话均跟随。';
        codexTuningCatalog=null;
        await loadCodexTuningCatalog({force:true});
      } catch(error) { setError(error.message); }
      finally { accountSaving=false;pendingAccountId='';paint(); }
    });
    ipcRenderer.on('codex-global-account-changed',()=>{
      if (accountSaving) return;
      void loadHubDefaultModels().then(()=>loadCodexTuningCatalog()).then(paint).catch(error=>setError(error.message));
    });

    document.getElementById('chatgpt-web-settings')?.addEventListener('click', async () => {
      try { await ipcRenderer.invoke('chatgpt-web:settings'); } catch (error) { setError(error.message); }
    });
    document.getElementById('chatgpt-web-refresh')?.addEventListener('click', () => { void loadModelCatalog('chatgpt').then(paint); });
    menuEl.querySelectorAll('.new-session-option').forEach(button => {
      button.addEventListener('click', () => {
        rememberTuning(selectedKind);
        selectedKind = button.dataset.kind === 'deepseek' ? (document.getElementById('new-session-deepseek-route')?.value || 'deepseek') : button.dataset.kind || 'claude';
        applyTuningMemory(selectedKind);
        setError('');
        paint();
        void loadModelCatalog(selectedKind).then(paint);
      });
    });
    menuEl.querySelectorAll('.session-workspace-choice').forEach(button => {
      button.addEventListener('click', () => {
        const requested = button.dataset.workspaceMode;
        workspaceMode = requested === 'existing' || requested === 'scratch' ? requested : 'default';
        setError('');
        paint();
        // No auto-opening the OS dialog: the recent list is shown first and
        // "浏览文件夹…" is the explicit fallback.
        if (workspaceMode === 'existing') {
          void loadRecent().then(paint);
          void loadPreparedProjects();
        }
      });
    });
    document.getElementById('new-session-deepseek-route')?.addEventListener('change', event => {
      rememberTuning(selectedKind);
      selectedKind = event.target.value === 'deepseek' ? 'deepseek' : 'deepseek-acp';
      applyTuningMemory(selectedKind);
      setError(''); paint();
      void loadModelCatalog(selectedKind).then(paint);
    });
    const modelSelect = document.getElementById('new-session-model');
    document.getElementById('new-session-project-refresh')?.addEventListener('click', loadPreparedProjects);
    if (modelSelect) {
      modelSelect.addEventListener('change', () => {
        selectedModel = modelSelect.value;
        modelTouchedByUser = true;
        paint();
      });
    }
    const defaultModelButton = document.getElementById('new-session-model-default');
    if (defaultModelButton) {
      defaultModelButton.addEventListener('click', async event => {
        // 按钮嵌在 <label for="new-session-model"> 里，不拦住就会连带聚焦并展开下拉。
        event.preventDefault();
        event.stopPropagation();
        if (defaultModelButton.disabled) return;
        const kind = selectedKind;
        const model = selectedModel;
        defaultModelButton.disabled = true;
        try {
          const result = await ipcRenderer.invoke('session:set-default-model', {
            kind,
            model,
            // 把下拉里真正能选的清单一并带上：ACP 那几个 kind 会有用户自配的
            // 模型，main 侧的静态清单认不出来。
            available: modelOptionsFor(kind).map(option => option.id),
          });
          if (!result || !result.ok) throw new Error((result && result.error) || '保存失败');
          hubDefaultModels = result.defaultModels || {};
          setError('');
        } catch (error) {
          setError(`设为默认失败：${error && error.message ? error.message : error}`);
        }
        paint();
      });
    }
    const effortSelect = document.getElementById('new-session-effort');
    if (effortSelect) {
      effortSelect.addEventListener('change', () => {
        selectedEffort = effortSelect.value;
        paint();
      });
    }
    const mcpSelect = document.getElementById('new-session-mcp');
    if (mcpSelect) {
      mcpSelect.addEventListener('change', () => {
        selectedMcpProfile = MCP_PROFILE_LABELS[mcpSelect.value] ? mcpSelect.value : defaultMcpFor(selectedKind);
        paint();
      });
    }
    const fastCheckbox = document.getElementById('new-session-fast');
    if (fastCheckbox) {
      fastCheckbox.addEventListener('change', () => {
        selectedFastMode = !!fastCheckbox.checked;
        paint();
      });
    }
    const codexTierSelect = document.getElementById('new-session-codex-tier');
    if (codexTierSelect) {
      codexTierSelect.addEventListener('change', () => {
        selectedCodexTier = codexTierSelect.value || 'inherit';
        paint();
      });
    }
    const pick = document.getElementById('new-session-pick-path');
    if (pick) pick.addEventListener('click', () => void chooseExistingPath());
    const submit = document.getElementById('new-session-submit');
    if (submit) submit.addEventListener('click', () => void submitNewSession());
    for (const id of ['new-session-close', 'new-session-cancel']) {
      const button = document.getElementById(id);
      if (button) button.addEventListener('click', closeNewSessionModal);
    }
    paint();
    // 默认模型要在这里就拉起来：群聊成员走 resolveSessionTuning，不经过新建
    // 会话面板，等到面板打开才加载的话成员会一律回落出厂默认。
    void loadHubDefaultModels().then(paint).catch(() => {});
    // 预热工作区信息：workspaceTierLabel() 要靠 flatWorkRoot 才能把工作根显示成
    // 「工作根」而不是「组织根·不可用」，而侧边栏 / 会话 header 的 chip 可能在
    // 启动中心第一次打开之前就调用它。不预热就会先闪一次错误标签。
    void loadRecent().then(paint).catch(() => {});
  }

  window.WorkspaceController = {
    closeNewSessionModal,
    compactPath,
    createScratch,
    createDefaultWorkspace,
    createSession,
    openNewSessionModal,
    maybePromptMeetingArchive: meetingId => maybePromptArchive('meeting', meetingId),
    maybePromptSessionArchive: sessionId => maybePromptArchive('session', sessionId),
    // 归档建议：由 UI（workspace chip / 会话 header 的 📁 路径）主动查询并显示轻提示，
    // 点了才开框。两处都走 attachArchiveHint，别再各写一套。
    attachArchiveHint,
    getArchiveSuggestion: (scope, id) => archiveSuggestions.get(`${scope}:${id}`) || null,
    getArchiveWarnings: (scope, id) => (archiveWarnings.get(`${scope}:${id}`) || []).slice(),
    hasArchiveSuggestion: (scope, id) => archiveSuggestions.has(`${scope}:${id}`),
    openArchiveSuggestion: (scope, id) => {
      const context = archiveSuggestions.get(`${scope}:${id}`);
      if (!context) return false;
      openArchiveContext(context);
      return true;
    },
    dismissArchiveSuggestion: (scope, id) => archiveSuggestions.delete(`${scope}:${id}`),
    pickWorkspace,
    submitNewSession,
    // 弹窗当前会送给 create-session 的 opts。暴露出来让 E2E 能断言"到底传了什么"，
    // 而不是靠截图猜 —— fast/思考强度/MCP 的默认值一旦漂移就是静默降级。
    tuningOpts,
    // 群聊成员配置必须与新建 Session 共用动态 Codex 模型目录和默认值。
    resolveSessionTuning,
    buildSessionTuningOpts,
    codexModelTuning,
    loadClaudeModelCatalog,
    loadCodexTuningCatalog,
    loadModelCatalog,
    loadPrimaryModelCatalogs,
    loadSessionDefaults: () => Promise.all([loadHubDefaultModels(), loadPrimaryModelCatalogs()]),
    workspaceTierLabel,
  };

  init();
})();
