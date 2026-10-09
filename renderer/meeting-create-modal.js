'use strict';

(function () {
const { ipcRenderer } = require('electron');
const { checkDevWorkspace } = require('./dev-workspace-guard.js');
const { KIND_LABELS } = require('../core/ai-kinds.js');
const { MODEL_OPTIONS_BY_KIND, modelOptionsFor } = require('../core/model-options.js');

const MODEL_KINDS = new Set(Object.keys(MODEL_OPTIONS_BY_KIND));

const DEFAULT_SLOTS = [
  { kind: 'claude' },
  { kind: 'codex' },
  { kind: 'deepseek' },
];
const GROUP_MEMBER_KINDS = ['claude', 'codex', 'deepseek', 'qwen', 'deepseek-acp', 'glm', 'codeagent'];
// Claude + Codex are the durable default pair. DeepSeek is an explicit third
// member rather than a cost/latency-bearing default in every room.
const DEFAULT_GROUP_MEMBERS = DEFAULT_SLOTS.slice(0, 2).map(x => ({ ...x }));
const SLOT_NAMES = ['一号位', '二号位', '三号位'];
// 场景是这一页唯一的任务分类维度。
// 2026-09-05：原来在成员配置上方还有一排四张任务模板卡，每张卡实际只做两件事 ——
// 选一个场景 + 换一句房名 placeholder，和这里的三个场景完全重叠。两处并存必然出现
// 「模板卡选了投研，底下场景还停在通用」这种自相矛盾状态，故删卡、只留场景。
const SCENES = [
  { id: 'dev', label: '开发', placeholder: '例如：实现这个需求，完成验证与合并' },
  { id: 'general',  label: '通用', placeholder: '例如：帮我拆解这个问题，给出可执行方案' },
];

let _modalEl = null;
let _currentMode = 'dev';
let _isGroupChat = true;
let _groupSlots = DEFAULT_GROUP_MEMBERS.map(x => ({ ...x }));
let _escListener = null;
let _meetingWorkspace = null;
// 群聊与单会话同一个默认档：工作根（2026-08-31 平铺决策）。
// 群聊尤其需要——180 场会议 100% 共用 cwd，本来就是「多个 AI 同一个目录」的场景。
let _meetingWorkspaceMode = 'existing';
// 项目库：已被 project-prep 整理过的项目（中文名 → 路径，按活跃时间排序）。
// 建群那一刻从主进程取快照；「选择已有路径」的下拉和开发场景的 prompt 都用它。
let _projectLibrary = [];
let _projectLibraryError = null;
let _projectLibraryLoading = null;
let _projectLibraryOpen = false;
let _creating = false;
let _presentation = { embedded: false, onCreated: null };
// AI 编排模式：成员 1 当编排员，用户预先选定工作成员，编排员安排其分工与参与阶段。
let _orchestrationOn = false;
const ORCHESTRATOR_KINDS = ['claude', 'codex'];

function _paintWorkspace(workspace) {
  if (workspace) _meetingWorkspace = workspace;
  if (!_modalEl) return;
  const path = _modalEl.querySelector('#mcm-workspace-path');
  if (path) {
    path.textContent = _meetingWorkspaceMode === 'existing' && _meetingWorkspace
      ? `${window.WorkspaceController.workspaceTierLabel(_meetingWorkspace.tier)} · ${window.WorkspaceController.compactPath(_meetingWorkspace.path, 58)}`
      : '尚未选择';
    path.title = _meetingWorkspaceMode === 'existing' && _meetingWorkspace ? _meetingWorkspace.path : '';
  }
  const existingRow = _modalEl.querySelector('#mcm-workspace-existing');
  if (existingRow) existingRow.hidden = _meetingWorkspaceMode !== 'existing';
  if (_meetingWorkspaceMode !== 'existing') _projectLibraryOpen = false;
  _modalEl.querySelectorAll('[data-mcm-workspace-mode]').forEach(button => {
    const selected = button.getAttribute('data-mcm-workspace-mode') === _meetingWorkspaceMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
  });
  _renderProjectLibrary();
}

// ── 项目库下拉 ──────────────────────────────────────────────────────────────
// 用户的原话：「AI HUB 就应该作为一个选项，我点击就行，不需要我自己输入路径去找」。
// 数据源是主进程的 workspace:prepared-projects（core/prepared-project-library.js）。
async function _loadProjectLibrary(force = false) {
  if (_projectLibraryLoading) return _projectLibraryLoading;
  // Refresh every open; no stale enrollment cache.
  _projectLibraryLoading = (async () => {
    try {
      const result = await ipcRenderer.invoke('workspace:prepared-projects');
      if (!Array.isArray(result?.items)) throw new Error('项目库返回格式无效');
      _projectLibrary = result.items.filter(item => item && item.path);
      _projectLibraryError = null;
    } catch (error) {
      console.warn('[meeting-create] 项目库读取失败:', error && error.message);
      _projectLibrary = [];
      _projectLibraryError = error;
    } finally {
      _projectLibraryLoading = null;
    }
    _renderProjectLibrary();
    return _projectLibrary;
  })();
  return _projectLibraryLoading;
}

function _pathKey(value) {
  return String(value || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

function _relativeActiveLabel(activeAt) {
  const at = Number(activeAt) || 0;
  if (!at) return '';
  const diff = Date.now() - at;
  if (diff < 60 * 60 * 1000) return '刚刚活跃';
  if (diff < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 3600000))} 小时前`;
  return `${Math.max(1, Math.round(diff / 86400000))} 天前`;
}

function _renderProjectLibrary() {
  if (!_modalEl) return;
  const listEl = _modalEl.querySelector('#mcm-project-library');
  const toggle = _modalEl.querySelector('#mcm-project-library-button');
  if (!listEl || !toggle) return;
  const open = _projectLibraryOpen && _meetingWorkspaceMode === 'existing';
  listEl.hidden = !open;
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.textContent = `项目库 ${open ? '▴' : '▾'}`;
  if (!open) return;
  if (_projectLibraryLoading && !_projectLibrary.length) {
    listEl.innerHTML = '<div class="mcm-project-library-empty">正在读取项目库…</div>';
    return;
  }
  if (_projectLibraryError) {
    listEl.textContent = `项目库读取失败：${_projectLibraryError.message}。重新打开可重试。`;
    return;
  }
  if (!_projectLibrary.length) {
    listEl.innerHTML = '<div class="mcm-project-library-empty">还没有整理过的项目。'
      + '在项目目录开一个普通会话，说「用 project-prep skill 整理这个仓库」，完成后按 docs/project-prep.md 登记正式目录。</div>';
    return;
  }
  const currentKey = _meetingWorkspace && _meetingWorkspace.path ? _pathKey(_meetingWorkspace.path) : '';
  listEl.innerHTML = _projectLibrary.map(item => {
    const selected = !!currentKey && _pathKey(item.path) === currentKey;
    const when = _relativeActiveLabel(item.activeAt);
    return `<button type="button" class="mcm-project-library-item${selected ? ' selected' : ''}" role="option"`
      + ` aria-selected="${selected ? 'true' : 'false'}" data-mcm-project-path="${_escapeHtml(item.path)}" title="${_escapeHtml(item.path)}">`
      + `<strong>${_escapeHtml(item.name || item.path)}</strong>`
      + `<small>${_escapeHtml(window.WorkspaceController.compactPath(item.path, 56))}</small>`
      + (when ? `<span>${_escapeHtml(when)}</span>` : '')
      + '</button>';
  }).join('');
  listEl.querySelectorAll('[data-mcm-project-path]').forEach(button => {
    button.addEventListener('click', () => {
      const target = _projectLibrary.find(item => item.path === button.dataset.mcmProjectPath);
      if (!target) return;
      void _selectLibraryProject(target).catch(err => _showError(`选择项目失败：${err && err.message ? err.message : String(err)}`));
    });
  });
}

async function _selectLibraryProject(item) {
  // workspace:select 让主进程把这条路径登记进工作区注册表并回 tier/label，
  // 与「选择文件夹…」走的是同一条归一化路径，后面的建群逻辑不用区分来源。
  const workspace = await ipcRenderer.invoke('workspace:select', item.path);
  if (!workspace || !workspace.path) throw new Error('主进程没有返回工作区');
  _meetingWorkspaceMode = 'existing';
  _meetingWorkspace = { ...workspace, label: workspace.label || item.name };
  _projectLibraryOpen = false;
  _clearError();
  _paintWorkspace(_meetingWorkspace);
  return _meetingWorkspace;
}

function _toggleProjectLibrary(open) {
  _projectLibraryOpen = typeof open === 'boolean' ? open : !_projectLibraryOpen;
  if (_projectLibraryOpen) void _loadProjectLibrary();
  _renderProjectLibrary();
}

async function _syncWorkspace() {
  if (_meetingWorkspaceMode === 'scratch') {
    _meetingWorkspace = await window.WorkspaceController.createScratch('未命名群聊');
  } else if (_meetingWorkspaceMode === 'default') {
    _meetingWorkspace = await window.WorkspaceController.createDefaultWorkspace('未命名群聊');
  } else if (!_meetingWorkspace || !_meetingWorkspace.path) {
    _meetingWorkspace = await window.WorkspaceController.pickWorkspace();
  }
  if (!_meetingWorkspace || !_meetingWorkspace.path) throw new Error('请选择群聊 workspace');
  _paintWorkspace(_meetingWorkspace);
  return _meetingWorkspace;
}

async function _chooseMeetingExistingWorkspace() {
  const workspace = await window.WorkspaceController.pickWorkspace();
  if (workspace && workspace.path) {
    _meetingWorkspaceMode = 'existing';
    _meetingWorkspace = workspace;
    _paintWorkspace(workspace);
  }
  return workspace;
}

function _escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _aiLogo(kind) {
  // *-resume 复用基础 kind 的 svg（assets 里没有 *-resume.svg）
  const base=String(kind).replace(/-resume$/, '');
  return `assets/ai-logos/${base === 'deepseek-acp' ? 'deepseek' : base}.svg`;
}

function _modelOptions(kind, selected) {
  const opts = modelOptionsFor(kind);
  return opts.map((option, i) =>
    `<option value="${_escapeHtml(option.id)}"${option.id === selected || (!selected && i === 0) ? ' selected' : ''}>${_escapeHtml(option.label || option.id)}</option>`
  ).join('');
}

function _selectOptions(entries, selected) {
  return (entries || []).map(([value, label]) =>
    `<option value="${_escapeHtml(value)}"${value === selected ? ' selected' : ''}>${_escapeHtml(label)}</option>`
  ).join('');
}

function _normalizeSlotSpec(spec = {}) {
  const kind = MODEL_KINDS.has(spec.kind) ? spec.kind : 'claude';
  const followDefault = spec.followDefault ?? !spec.model;
  const tuning = window.WorkspaceController.resolveSessionTuning(kind, followDefault ? undefined : spec.model, spec);
  return {
    kind,
    followDefault,
    model: tuning.model,
    effort: tuning.effort,
    mcpProfile: tuning.mcpProfile,
    fastMode: tuning.fastMode,
    codexSpeedTier: tuning.codexSpeedTier,
    contextMax: tuning.contextMax,
  };
}

function _cloneSlots(slots) {
  return (slots || require('./codeagent-preference').defaultGroupMembers(DEFAULT_GROUP_MEMBERS)).map(x => _normalizeSlotSpec(x));
}

function _renderSceneChoices(activeId = 'general') {
  return SCENES.map(scene => `
    <label class="mcm-scene-choice${scene.id === activeId ? ' selected' : ''}" data-mcm-scene="${_escapeHtml(scene.id)}">
      <input type="radio" name="mcm-scene" value="${_escapeHtml(scene.id)}"${scene.id === activeId ? ' checked' : ''}>
      ${_escapeHtml(scene.label)}
    </label>
  `).join('');
}

// 场景说明只认 _currentMode，不认「刚才点了哪个 radio」。
// 2026-09-05 合并位打回的那个泄漏就出在这里：说明原来画在 radio 的 change 里，
// 而重开弹窗走的是 _applyScene —— 场景已经回到通用、工作目录也回到默认，
// 屏幕上却还留着「开发场景…已切到选择已有路径」。凡是能被重开路径绕过的
// UI 状态，就必须挂在负责重置状态的那个函数上。
function _paintSceneHint() {
  const hint = _modalEl && _modalEl.querySelector('#mcm-scene-hint');
  if (!hint) return;
  if (_currentMode === 'dev') {
    hint.textContent = '从「项目库」选择项目，或选择已有文件夹。至少保留两位成员。建好后直接输入任务，Hub 安排第一位开题与实现、第二位独立审查与合并。单人开发请使用普通会话的「一键开工」。';
    hint.style.display = '';
  } else {
    hint.textContent = '';
    hint.style.display = 'none';
  }
}

// 场景切换保留已选成员、模型与调优。
function _applyScene(sceneId, opts = {}) {
  const scene = SCENES.find(s => s.id === sceneId) || SCENES[0];
  _currentMode = scene.id;
  if (opts.resetSlots) {
    // 装了 CodeAgent 的电脑默认两名 CodeAgent 成员（GLM + MiniMax），见 renderer/codeagent-preference.js。
    _groupSlots = _cloneSlots(require('./codeagent-preference').defaultGroupMembers(DEFAULT_GROUP_MEMBERS));
    _renderSlots();
  }
  const titleInput = _modalEl && _modalEl.querySelector('#mcm-title-input');
  if (titleInput) {
    if (opts.clearTitle) titleInput.value = '';
    titleInput.placeholder = scene.placeholder || '留空则自动编号：AI 群聊 #N';
  }
  if (_currentMode === 'dev') {
    _meetingWorkspaceMode = 'existing';
    _paintWorkspace();
  }
  if (!_modalEl) return;
  const sceneRadio = _modalEl.querySelector(`input[name="mcm-scene"][value="${_currentMode}"]`);
  if (sceneRadio) sceneRadio.checked = true;
  _modalEl.querySelectorAll('.mcm-scene-choice').forEach(el => {
    const input = el.querySelector('input[name="mcm-scene"]');
    el.classList.toggle('selected', !!input && input.value === _currentMode);
  });
  _renderSlots();
  _paintSceneHint();
}

function _slotHtml(i, spec, isGroup) {
  const def = _normalizeSlotSpec(spec || DEFAULT_SLOTS[i] || DEFAULT_SLOTS[0]);
  const tuning = window.WorkspaceController.resolveSessionTuning(def.kind, def.model, def);
  const providerKinds = isGroup ? GROUP_MEMBER_KINDS : Array.from(MODEL_KINDS);
  const aiOptions = providerKinds.filter(k => k !== 'deepseek-acp').map(k =>
    `<option value="${_escapeHtml(k)}"${k === (def.kind === 'deepseek-acp' ? 'deepseek' : def.kind) ? ' selected' : ''}>${_escapeHtml(KIND_LABELS[k] || k)}</option>`
  ).join('');
  const avatarSrc = _aiLogo(def.kind);
  const avatarAlt = KIND_LABELS[def.kind] || def.kind;
  const orchLead = isGroup && _orchestrationOn && i === 0;
  const label = !isGroup ? `Slot ${i + 1} · ${SLOT_NAMES[i]}`
    : orchLead ? '成员 1 · 编排员'
    : _orchestrationOn ? `成员 ${i + 1} · 工作成员` : `成员 ${i + 1}`;
  const removeBtn = isGroup && i >= 1 && (_orchestrationOn || _currentMode !== 'dev' || _groupSlots.length > 2)
    ? `<button type="button" class="mcm-remove-member" data-remove-member="${i}" title="移除此成员">×</button>`
    : '';
  const effortField = tuning.showEffort ? `
      <label class="mcm-tuning-field"><span class="mcm-slot-field-name">思考强度</span>
        <select class="mcm-effort-select">${_selectOptions(tuning.effortOptions, tuning.effort)}</select>
      </label>` : '';
  const mcpField = tuning.showMcp ? `
      <label class="mcm-tuning-field"><span class="mcm-slot-field-name">MCP 加载</span>
        <select class="mcm-mcp-select">${_selectOptions(tuning.mcpOptions, tuning.mcpProfile)}</select>
      </label>` : '';
  const fastField = tuning.showFast ? `
      <label class="mcm-tuning-field mcm-fast-field">
        <span class="mcm-slot-field-name">快速模式</span>
        <span class="mcm-check"><input class="mcm-fast-checkbox" type="checkbox"${tuning.fastMode ? ' checked' : ''}> 启用 Claude Fast</span>
      </label>` : '';
  const codexTierField = tuning.showCodexTier ? `
      <label class="mcm-tuning-field"><span class="mcm-slot-field-name">速度通道</span>
        <select class="mcm-codex-tier-select">${_selectOptions(tuning.codexTierOptions, tuning.codexSpeedTier)}</select>
      </label>` : '';
  return `
    <div class="mcm-slot${isGroup ? ' mcm-group-member' : ''}${orchLead ? ' mcm-orch-lead' : ''}" data-slot="${i}" data-kind="${_escapeHtml(def.kind)}">
      ${removeBtn}
      <div class="mcm-slot-head">
        <img class="mcm-avatar" src="${_escapeHtml(avatarSrc)}" alt="${_escapeHtml(avatarAlt)}">
        <div><div class="mcm-slot-label">${_escapeHtml(label)}</div><strong>${_escapeHtml(avatarAlt)}</strong></div>
      </div>
      <div class="mcm-slot-fields">
        <label><span class="mcm-slot-field-name">AI</span><select class="mcm-ai-select">${aiOptions}</select></label>
        ${['deepseek','deepseek-acp'].includes(def.kind) ? `<label><span class="mcm-slot-field-name">DeepSeek 接入</span><select class="mcm-deepseek-route"><option value="deepseek"${def.kind === 'deepseek' ? ' selected' : ''}>Codex CLI · DeepSeek API</option><option value="deepseek-acp"${def.kind === 'deepseek-acp' ? ' selected' : ''}>Token Plan · 旧 Harness</option></select></label>` : ''}
        <label><span class="mcm-slot-field-name">模型</span><select class="mcm-model-select">${_modelOptions(def.kind, def.model)}</select></label>
        ${effortField}
        ${mcpField}
        ${fastField}
        ${codexTierField}
      </div>
    </div>
  `;
}

function _readSlotSpec(el, i, { strict = true } = {}) {
  const aiSelect = el && el.querySelector('.mcm-ai-select');
  const modelSelect = el && el.querySelector('.mcm-model-select');
  if (!aiSelect || !aiSelect.value) {
    if (strict) throw new Error(`成员 ${i + 1} 未选择 AI`);
    return _groupSlots[i] ? _normalizeSlotSpec(_groupSlots[i]) : null;
  }
  const spec = {
    kind: aiSelect.value === 'deepseek' ? (el.querySelector('.mcm-deepseek-route')?.value || 'deepseek') : aiSelect.value,
    model: modelSelect ? modelSelect.value : '',
    followDefault: _groupSlots[i]?.followDefault ?? !_groupSlots[i]?.model,
  };
  const effort = el.querySelector('.mcm-effort-select');
  const mcp = el.querySelector('.mcm-mcp-select');
  const fast = el.querySelector('.mcm-fast-checkbox');
  const codexTier = el.querySelector('.mcm-codex-tier-select');
  if (effort) spec.effort = effort.value;
  if (mcp) spec.mcpProfile = mcp.value;
  if (fast) spec.fastMode = !!fast.checked;
  if (codexTier) spec.codexSpeedTier = codexTier.value;
  return _normalizeSlotSpec(spec);
}

function _syncGroupSlotsFromDom({ strict = false } = {}) {
  if (!_modalEl || !_isGroupChat) return;
  _groupSlots = Array.from(_modalEl.querySelectorAll('.mcm-slot'))
    .map((el, i) => _readSlotSpec(el, i, { strict }))
    .filter(Boolean);
}

// 「+ 添加成员」下一个默认落哪种 AI：先补齐还没出场的（Claude+Codex 两人时给 DeepSeek），
//   补齐后按顺序轮换。同一种 AI 允许多开（两个 Claude 跑不同模型/角色是有效用法），
//   成员数也不设上限——实际基本停在 3 人，但那是用户的选择，不该由代码写死。
function _nextGroupMemberKind() {
  const present = new Set(_groupSlots.map(slot => slot.kind));
  return GROUP_MEMBER_KINDS.find(kind => !present.has(kind))
    || GROUP_MEMBER_KINDS[_groupSlots.length % GROUP_MEMBER_KINDS.length];
}

function _renderSlots() {
  if (!_modalEl) return;
  const wrap = _modalEl.querySelector('.mcm-slots');
  if (!wrap) return;
  const specs = _isGroupChat ? _groupSlots : DEFAULT_SLOTS;
  wrap.innerHTML = specs.map((spec, i) => _slotHtml(i, spec, _isGroupChat)).join('');
  wrap.querySelectorAll('.mcm-slot').forEach(slotEl => {
    slotEl.querySelector('.mcm-ai-select').addEventListener('change', () => {
      const i = Number(slotEl.getAttribute('data-slot'));
      const selected = slotEl.querySelector('.mcm-ai-select').value;
      const kind = selected;
      _groupSlots[i] = _normalizeSlotSpec({ kind });
      _renderSlots();
    });
    slotEl.querySelector('.mcm-model-select').addEventListener('change', () => {
      _groupSlots[Number(slotEl.dataset.slot)].followDefault = false;
      _syncGroupSlotsFromDom();
      // Codex 的 effort / Fast 选项跟模型目录走，切模型后要重新生成这一张卡。
      _renderSlots();
    });
    slotEl.querySelector('.mcm-deepseek-route')?.addEventListener('change', event => {
      const kind = event.target.value;
      _groupSlots[Number(slotEl.getAttribute('data-slot'))] = _normalizeSlotSpec({ kind });
      _renderSlots();
    });
    slotEl.querySelectorAll('.mcm-effort-select, .mcm-mcp-select, .mcm-fast-checkbox, .mcm-codex-tier-select')
      .forEach(control => control.addEventListener('change', () => _syncGroupSlotsFromDom()));
  });
  wrap.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', () => {
      _syncGroupSlotsFromDom();
      const idx = parseInt(btn.getAttribute('data-remove-member'), 10);
      if ((_currentMode !== 'dev' || _groupSlots.length > 2) && Number.isInteger(idx) && idx >= 0 && idx < _groupSlots.length) {
        _groupSlots.splice(idx, 1);
        _renderSlots();
      }
    });
  });
  const addBtn = _modalEl.querySelector('#mcm-add-member');
  if (addBtn && _isGroupChat) {
    const nextKind = _nextGroupMemberKind();
    addBtn.disabled = false;
    addBtn.textContent = `+ 添加 ${KIND_LABELS[nextKind] || nextKind}`;
    addBtn.title = `添加成员 ${KIND_LABELS[nextKind] || nextKind}；同一种 AI 可以多开，人数不设上限`;
  }
}

function _ensureModal() {
  if (_modalEl && document.body.contains(_modalEl)) return _modalEl;
  _modalEl = document.createElement('div');
  _modalEl.id = 'meeting-create-modal';
  _modalEl.className = 'mcm-overlay';
  _modalEl.style.display = 'none';
  _modalEl.innerHTML = `
    <div class="mcm-dialog" role="dialog" aria-labelledby="mcm-title-text">
      <div class="mcm-header">
        <span class="mcm-title" id="mcm-title-text">新建<span id="mcm-mode-label">AI 群聊</span></span>
        <button class="mcm-close" aria-label="关闭">×</button>
      </div>
      <div class="mcm-body">
        <div class="mcm-name-row">
          <label class="mcm-name-label" for="mcm-title-input">房名（可选）</label>
          <input id="mcm-title-input" class="mcm-title-input" type="text" maxlength="40"
                 placeholder="留空则自动编号：AI 群聊 #N" autocomplete="off">
        </div>
        <div class="mcm-workspace-block">
          <span class="mcm-workspace-caption">Workspace</span>
          <div class="mcm-workspace-choices" role="radiogroup" aria-label="选择群聊 workspace 方式">
            <button type="button" class="mcm-workspace-choice selected" data-mcm-workspace-mode="default" role="radio" aria-checked="true"><strong>默认工作目录</strong><small>全员开在工作根，跨会话文件互相可见</small></button>
            <button type="button" class="mcm-workspace-choice" data-mcm-workspace-mode="scratch" role="radio" aria-checked="false"><strong>临时目录</strong><small>随机新建一次性目录，全员共用</small></button>
            <button type="button" class="mcm-workspace-choice" data-mcm-workspace-mode="existing" role="radio" aria-checked="false"><strong>选择已有路径</strong><small>可选项目、领域或外部目录</small></button>
          </div>
          <div class="mcm-workspace-existing" id="mcm-workspace-existing" hidden><code id="mcm-workspace-path">尚未选择</code><button type="button" class="mcm-workspace-button" id="mcm-project-library-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="mcm-project-library" title="已整理过的项目，按最近活跃排序，点一下即选">项目库 ▾</button><button type="button" class="mcm-workspace-button" id="mcm-workspace-button">选择文件夹…</button></div>
          <div class="mcm-project-library" id="mcm-project-library" role="listbox" aria-label="项目库" hidden></div>
        </div>
        <div class="mcm-scene" id="mcm-scene-row">
          <span class="mcm-scene-caption">场景</span>
          ${_renderSceneChoices('dev')}
        </div>
        <div class="mcm-scene-hint" id="mcm-scene-hint" style="display:none; font-size:12px; color:#888; margin:-6px 0 12px; line-height:1.6;"></div>
        <div class="mcm-orch-row" id="mcm-orch-row">
          <label class="mcm-orch-switch"><input type="checkbox" id="mcm-orch-toggle" role="switch"><span class="mcm-orch-track" aria-hidden="true"></span><strong>编排员</strong></label>
          <span class="mcm-orch-hint" id="mcm-orch-hint">打开后成员 1 当编排员：你只和它对话，它使用你选好的成员，自主分工、设计工作流并汇报进展；通过与否由审核位决定。</span>
          <div class="mcm-orch-options" id="mcm-orch-options" hidden>
            <label>迭代上限 <input type="number" id="mcm-orch-rounds" min="2" max="30" value="8"> 轮</label>
            <label>时长上限 <input type="number" id="mcm-orch-hours" min="0.5" max="24" step="0.5" value="3"> 小时</label>
            <span class="mcm-orch-note">关掉开关 = 和现在完全一样</span>
          </div>
        </div>
        <div class="mcm-member-caption">
          <strong>成员配置</strong>
          <span>开发群聊第一位实现、第二位独立验证与合并。需要第三视角时再添加 DeepSeek。可继续加人，同一种 AI 也能多开。每位成员可独立选择模型、思考强度、速度与 MCP。</span>
        </div>
        <div class="mcm-slots"></div>
        <button type="button" class="mcm-add-member" id="mcm-add-member">+ 添加成员</button>
      </div>
      <div class="mcm-footer">
        <button class="mcm-cancel">取消</button>
        <button type="button" class="mcm-create mcm-primary">创建群聊</button>
      </div>
    </div>
  `;
  document.body.appendChild(_modalEl);
  _bindEvents();
  return _modalEl;
}

function _setOrchestration(on) {
  _orchestrationOn = !!on;
  if (!_modalEl) return;
  const toggle = _modalEl.querySelector('#mcm-orch-toggle');
  if (toggle) toggle.checked = _orchestrationOn;
  _modalEl.querySelector('#mcm-orch-row')?.classList.toggle('on', _orchestrationOn);
  const options = _modalEl.querySelector('#mcm-orch-options');
  if (options) options.hidden = !_orchestrationOn;
  const caption = _modalEl.querySelector('.mcm-member-caption span');
  if (caption) {
    if (!caption.dataset.plainText) caption.dataset.plainText = caption.textContent;
    caption.textContent = _orchestrationOn
      ? '成员 1 为编排员，其余为工作成员。成员与模型由你选，分工和参与阶段由编排员安排；额度可在任务中用自然语言指定。'
      : caption.dataset.plainText;
  }
  const hint = _modalEl.querySelector('#mcm-orch-hint');
  if (hint) hint.textContent = _orchestrationOn
    ? '已开启：成员 1 当编排员。你只和它用自然语言对话，它使用你选好的成员自主分工、推进到结项，处理成员故障；需要你取舍时它会在对话里问。通过与否由审核位决定。'
    : '打开后成员 1 当编排员：你只和它对话，它使用你选好的成员，自主分工、设计工作流并汇报进展；通过与否由审核位决定。';
  _renderSlots();
}

function _orchestrationPayload() {
  if (!_orchestrationOn || !_modalEl) return null;
  const rounds = Number(_modalEl.querySelector('#mcm-orch-rounds')?.value) || 8;
  const hours = Number(_modalEl.querySelector('#mcm-orch-hours')?.value) || 3;
  return { enabled: true, settings: { roundCap: Math.round(rounds), timeCapMin: Math.round(hours * 60) } };
}

function _bindEvents() {
  _modalEl.querySelector('.mcm-close').addEventListener('click', closeMeetingCreateModal);
  _modalEl.querySelector('.mcm-cancel').addEventListener('click', closeMeetingCreateModal);
  _modalEl.querySelector('.mcm-create').addEventListener('click', (event) => {
    event.preventDefault();
    void _onCreate();
  });
  _modalEl.querySelector('#mcm-add-member').addEventListener('click', () => {
    _syncGroupSlotsFromDom();
    const nextKind = _nextGroupMemberKind();
    _groupSlots.push(_normalizeSlotSpec({ kind: nextKind }));
    _renderSlots();
  });
  _modalEl.querySelectorAll('[data-mcm-workspace-mode]').forEach(button => {
    button.addEventListener('click', () => {
      const requested = button.getAttribute('data-mcm-workspace-mode');
      _meetingWorkspaceMode = requested === 'existing' || requested === 'scratch' ? requested : 'default';
      _paintWorkspace();
      // 切到「选择已有路径」还没选过目录时，先展开项目库让用户点选；
      // 只有项目库确实是空的才回落到系统文件夹对话框（老行为）。
      if (_meetingWorkspaceMode === 'existing' && !_meetingWorkspace) {
        _toggleProjectLibrary(true);
        void _loadProjectLibrary().then(items => {
          if (_meetingWorkspaceMode !== 'existing' || _meetingWorkspace) return;
          if (!items.length) {
            _projectLibraryOpen = false;
            _renderProjectLibrary();
            return _chooseMeetingExistingWorkspace();
          }
          return undefined;
        }).catch(err => _showError(`选择目录失败：${err && err.message ? err.message : String(err)}`));
      }
    });
  });
  _modalEl.querySelector('#mcm-project-library-button').addEventListener('click', () => {
    _toggleProjectLibrary();
  });
  _modalEl.querySelector('#mcm-workspace-button').addEventListener('click', () => {
    _projectLibraryOpen = false;
    _renderProjectLibrary();
    void _chooseMeetingExistingWorkspace().catch(err => _showError(`选择目录失败：${err && err.message ? err.message : String(err)}`));
  });
  _modalEl.querySelector('#mcm-orch-toggle').addEventListener('change', event => {
    _syncGroupSlotsFromDom();
    _setOrchestration(event.target.checked);
  });
  _modalEl.querySelectorAll('input[name="mcm-scene"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      // 场景高亮、房名提示、场景说明都归 _applyScene 管，这里不重复画。
      _applyScene(radio.value);
      // 预热项目库；用户仍可手动改选工作目录方式。
      if (radio.value === 'dev') void _loadProjectLibrary();
    });
  });
  _modalEl.addEventListener('click', (e) => {
    if (!_presentation.embedded && e.target === _modalEl) closeMeetingCreateModal();
  });
}

async function _onCreate() {
  if (_creating) return;
  const createBtn = _modalEl && _modalEl.querySelector('.mcm-create');
  if (!createBtn) return;
  _creating = true;
  createBtn.disabled = true;
  createBtn.setAttribute('aria-busy', 'true');
  createBtn.textContent = '正在准备 workspace...';
  _clearError();
  try {
    // 即使用户在模型目录异步返回前立刻点创建，也要先用真实目录重新归一化。
    // 否则 gpt-5.5 可能把 fallback 里的 max 带进 CLI（该模型真实只支持到 xhigh）。
    await window.WorkspaceController.loadSessionDefaults();
    _syncGroupSlotsFromDom({ strict: true });
    _renderSlots();
    // 读取 DOM 也必须在 try 内。历史状态或第三方样式脚本一旦留下残缺 slot / 未选
    // scene，旧代码会在 invoke 之前同步 throw，界面上就像按钮完全没反应。
    const slots = Array.from(_modalEl.querySelectorAll('.mcm-slot')).map((el, i) => {
      const spec = _readSlotSpec(el, i, { strict: true });
      return {
        index: i,
        kind: spec.kind,
        ...window.WorkspaceController.buildSessionTuningOpts(spec.kind, spec.model, spec),
      };
    });
    if (!slots.length) throw new Error('请至少保留一个群聊成员');
    const sceneInput = _modalEl.querySelector('input[name="mcm-scene"]:checked');
    const scene = sceneInput ? sceneInput.value : 'general';
    const orchestration = _orchestrationPayload();
    if (orchestration && slots.length < 2) throw new Error('编排群至少需要编排员和一位工作成员；请先选择成员');
    if (orchestration && !ORCHESTRATOR_KINDS.includes(slots[0].kind)) throw new Error('编排员（成员 1）请选 Claude 或 Codex');
    if (!orchestration && scene === 'dev' && slots.length < 2) throw new Error('开发群聊至少需要两位成员；单人开发请使用普通会话的“一键开工”。');
    // createMeeting 的 scene 实际取自 mode（过 MEETING_MODES 白名单），scene 字段只是透传
    const mode = (scene === 'research' || scene === 'dev') ? scene : 'general';
    const titleInput = _modalEl.querySelector('#mcm-title-input');
    const title = titleInput ? titleInput.value.trim() : '';

    let workspace = await _syncWorkspace();
    // 开发场景开在平铺工作根上：放行，但 prompt 里要带项目库让 AI 自己定位项目根。
    let atWorkRoot = scene === 'dev' && _meetingWorkspaceMode === 'default' && !!(workspace && workspace.flat);
    let fellBackToWorkRoot = false;
    let devProjects = [];
    if (scene === 'dev') {
      // 挡在建群这一刻。落错目录的代价是几分钟后才看得出来的一次空转，
      // 而这里只要一行判断。见 renderer/dev-workspace-guard.js 的注释。
      // 工作根总是要问一次：失效目录的兜底落脚点就是它（任务书第七节第 8 条）。
      // 只读查询，没有副作用。
      let workRootPath = atWorkRoot && workspace ? workspace.path : '';
      if (!workRootPath) {
        try {
          const info = await ipcRenderer.invoke('workspace:work-root');
          if (info && info.flat && info.root) workRootPath = info.root;
        } catch (error) { console.warn('[meeting-create] 取工作根失败：', error && error.message); }
      }
      const verdict = checkDevWorkspace(workspace && workspace.path, { workRoot: workRootPath });
      if (!verdict.ok) throw new Error(verdict.message);
      // 用户选中的是仓库**子目录**时，闸门会把仓库根算出来。必须按仓库根建群 ——
      // 合同里那些仓库内相对路径（.agents/AUTHOR.md、scripts/merge_task.py）
      // 在子目录里是找不到的。
      if ((verdict.reason === 'ready-subdir' || verdict.reason === 'ready-fallback') && verdict.resolvedRoot) {
        workspace = { ...workspace, path: verdict.resolvedRoot };
      }
      // 路径被纠正过（原来那个已经不存在）时告诉用户一声 —— 建房照常继续，
      // 不要求他回去重新选一次（任务书第七节：唯一确认就自主继续）。
      if (verdict.reason === 'ready-fallback' && verdict.message) {
        console.warn('[meeting-create] 工作目录已纠正：' + verdict.message);
      }
      // 退到工作根时，这个房就是「不在项目根上」——项目库和定位说明要跟着进来，
      // 否则 AI 到了那儿既没有合同也没有线索。
      if (verdict.reason === 'ready-fallback' && verdict.atWorkRoot) fellBackToWorkRoot = true;
      if (fellBackToWorkRoot) atWorkRoot = true;
      if (atWorkRoot) {
        createBtn.textContent = '正在读取项目库...';
        devProjects = await _loadProjectLibrary(true);
        if (_projectLibraryError) throw _projectLibraryError;
      }
    }
    // 编排群的工作流由编排员按计划配置，建群时不预置。
    const serialWorkflow = orchestration ? null : _buildDefaultDevWorkflow(scene, slots, { atWorkRoot, projects: devProjects });
    createBtn.textContent = '正在创建成员会话...';
    const meeting = await ipcRenderer.invoke('create-meeting', {
      mode,
      scene,
      slots,
      title,
      groupChat: _isGroupChat,
      groupMode: _isGroupChat ? 'deliberation' : null,
      groupRecentRawN: 5,
      participants: _isGroupChat ? (orchestration || scene === 'dev' ? [slots[0].index] : slots.map((_, i) => i)) : null,
      workspace: workspace.path,
      workspaceLabel: workspace.label,
      workspaceDraft: !!workspace.draft,
      serialWorkflow,
      ...(orchestration ? { orchestration } : {}),
    });
    if (!meeting || !meeting.id) throw new Error('create-meeting returned empty meeting');
    const onCreated = _presentation.onCreated;
    closeMeetingCreateModal();
    if (typeof onCreated === 'function') {
      try { onCreated(meeting); } catch (error) { console.error('[meeting-create] onCreated failed', error); }
    }
    if (typeof selectMeeting === 'function') selectMeeting(meeting.id);
    else if (typeof window.selectMeeting === 'function') window.selectMeeting(meeting.id);
  } catch (e) {
    console.error('[meeting-create-modal] create failed:', e);
    _showError((e && e.message) ? e.message : String(e));
    _creating = false;
    createBtn.disabled = false;
    createBtn.removeAttribute('aria-busy');
    createBtn.textContent = '创建群聊';
  }
}

// 开发场景默认就配好「工作位 ↔ 合并位」循环，用户不用再点一次工作流配置。
//
// 为什么放在建群这一刻：发送按钮已经会看 serialWorkflow.loop.enabled 决定跑循环还是
// 普通提问（meeting-room.js 的 doSend 三岔路）。所以只要建群时把它写好，用户后面
// 就只剩「打一句话 + 回车」这一个动作 —— 零配置界面。
//
// 想随便问一句而不跑流程？关掉工作流开关即可，走的还是原来那条普通群聊路径。
// memberId 是位置约定：loop-engine 的 sidOf() 把 m1 解析成 subSessions[0]。
//
// 开在工作根（默认工作目录）时，workspaceHint 带上项目库快照，预设 prompt 前面会多一段
// 「先按任务定位项目根」—— 这是「允许选默认目录」的代价，由 prompt 而不是用户承担。
//
// devPhase 是起手方式：双席位一律先落 'discuss'（循环配置照样写好，只是发送先走普通群聊）。
// 用户在群里点「开题」→ 阶段翻成 'kickoff'，指定执笔者写任务书；
// 双席位报告交付后自动开工；单人开发使用普通会话。
function _buildDefaultDevWorkflow(scene, slots, workspaceHint = {}) {
  if (scene !== 'dev') return null;
  const WT = window.WorkflowTemplates;
  if (!WT || typeof WT.createTemplateConfig !== 'function') throw new Error('开发工作流尚未加载，请重试创建');
  if (!Array.isArray(slots) || slots.length < 2) throw new Error('开发群聊至少需要两位成员');
  const members = slots.map((s, i) => ({ memberId: `m${i + 1}`, kind: s.kind }));
  const templateId = 'dev-task';
  const config = WT.createTemplateConfig(templateId, members, {
    workspace: {
      atWorkRoot: !!(workspaceHint && workspaceHint.atWorkRoot),
      projects: (workspaceHint && workspaceHint.projects) || [],
    },
    devPhase: 'discuss',
  });
  if (!config) throw new Error('无法生成默认开发工作流，请重试创建');
  // 2026-09-28: new rooms run on the delivery engine only; the legacy template
  // above is used just for its project-locator fields.
  const delivery = require('../core/workflow-settings').createDeliveryConfig('development', members, {
    ...(config.projectLocator ? { projectLocator: config.projectLocator } : {}),
    ...(config.projectLibrary ? { projectLibrary: config.projectLibrary } : {}),
    workRoot: !!config.workRoot,
  });
  // Submit with create-meeting: the first creation event and response must
  // already contain the workflow, before the room constructs its controls.
  return delivery;
}

function _showError(text) {
  let bar = _modalEl.querySelector('.mcm-error');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'mcm-error';
    const footer = _modalEl.querySelector('.mcm-footer');
    if (footer) footer.before(bar);
  }
  bar.textContent = `创建失败：${text}`;
}

function _clearError() {
  const bar = _modalEl && _modalEl.querySelector('.mcm-error');
  if (bar) bar.remove();
}

function openMeetingCreateModal(mode = 'general', options = {}) {
  if (mode === 'group') {
    _isGroupChat = true;
  } else {
    _isGroupChat = true;
  }
  // 每次进入默认开发场景，并让用户选择已有项目路径。
  _currentMode = 'dev';
  _ensureModal();
  const embeddedHost = options.embedded === true && options.host && typeof options.host.appendChild === 'function'
    ? options.host
    : null;
  if (embeddedHost) embeddedHost.appendChild(_modalEl);
  else if (_modalEl.parentElement !== document.body) document.body.appendChild(_modalEl);
  _modalEl.classList.toggle('mcm-embedded', !!embeddedHost);
  const dialogEl = _modalEl.querySelector('.mcm-dialog');
  if (dialogEl) {
    dialogEl.setAttribute('role', embeddedHost ? 'group' : 'dialog');
    dialogEl.setAttribute('aria-labelledby', embeddedHost ? 'launch-center-group-title' : 'mcm-title-text');
  }
  _presentation = {
    embedded: !!embeddedHost,
    onCreated: typeof options.onCreated === 'function' ? options.onCreated : null,
  };
  _clearError();
  _orchestrationOn = false;
  _setOrchestration(false);
  _applyScene('dev', { clearTitle: true, resetSlots: true });
  _meetingWorkspaceMode = 'existing';
  _meetingWorkspace = null;
  _projectLibraryOpen = false;
  _paintWorkspace();
  // 项目库每次开弹窗都重新拉：别的终端刚 commit 过的项目要排到前面来。
  void _loadProjectLibrary(true);

  const modeLabel = _modalEl.querySelector('#mcm-mode-label');
  modeLabel.textContent = 'AI 群聊';

  const titleInput = _modalEl.querySelector('#mcm-title-input');
  if (titleInput) titleInput.value = '';
  const addBtn = _modalEl.querySelector('#mcm-add-member');
  if (addBtn) addBtn.style.display = 'inline-flex';
  const createBtn = _modalEl.querySelector('.mcm-create');
  _creating = false;
  createBtn.disabled = false;
  createBtn.removeAttribute('aria-busy');
  createBtn.textContent = '创建群聊';
  _modalEl.style.display = 'flex';
  // 单会话与群聊共用 codex-cli 的模型目录。目录异步返回后保留用户已选值重绘，
  // 让 gpt-5.6 的 ultra / Fast 与旧模型的较短枚举始终准确。
  void window.WorkspaceController.loadSessionDefaults().then(() => {
    if (!_modalEl || _modalEl.style.display === 'none') return;
    _syncGroupSlotsFromDom();
    _renderSlots();
  });
  if (_escListener) document.removeEventListener('keydown', _escListener);
  _escListener = null;
  if (!_presentation.embedded) {
    _escListener = (e) => {
      if (e.key === 'Escape' && _modalEl.style.display !== 'none') closeMeetingCreateModal();
    };
    document.addEventListener('keydown', _escListener);
  }
}

function closeMeetingCreateModal() {
  if (_modalEl) _modalEl.style.display = 'none';
  if (_escListener) {
    document.removeEventListener('keydown', _escListener);
    _escListener = null;
  }
  _presentation = { embedded: false, onCreated: null };
}

window.openMeetingCreateModal = openMeetingCreateModal;
window.closeMeetingCreateModal = closeMeetingCreateModal;
})();
