'use strict';

const {
  canSwitchInSession,
  modelOptionsFor,
  modelSwitchStrategy,
} = require('../core/model-options.js');
// 档位说明文案复用 Codex 模型目录那份，不在 UI 层再拄一份。
const { EFFORT_DESCRIPTIONS } = require('../core/codex-model-catalog.js');
// 版本比较同样复用发现模块那份，避免 UI 层自己写一个会把 2.1.9 判成大于 2.1.280 的比较。
const { compareCliVersions } = require('../core/claude-model-discovery.js');
const { speedControl } = require('../core/session-speed.js');

// Map a model id to a CSS family class for badge coloring.
function modelClass(id) {
  if (!id) return '';
  const s = id.toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('fable')) return 'fable';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  if (s.includes('gemini')) return 'gemini';
  if (s.startsWith('chatgpt-web/')) return 'codex';
  if (s.includes('codex') || s.includes('gpt-5') || s.includes('o3') || s.includes('o4-mini')) return 'codex';
  if (s.includes('deepseek')) return 'deepseek';
  if (s.includes('qwen')) return 'qwen';
  // 公司 Code Agent 的模型（GLM-5.2-WX-Auto 等）用它自己的样式，不算智谱 ZCode。
  if (s.includes('-wx') || s.startsWith('minimax')) return 'codeagent';
  if (s.includes('glm')) return 'glm';
  if (s.includes('kimi') || s === 'k3') return 'kimi';
  return '';
}

// Short label for the sidebar badge. display_name is already compact
// ("Opus 4.6 (1M context)"); we strip the parenthetical to keep the pill slim.
function modelShort(m) {
  if (!m) return '';
  const web = require('../core/chatgpt-web-models').chatgptWebRoute(m.id);
  if (web) return web.label;
  const dn = m.displayName || '';
  if (dn) return dn.replace(/\s*\(.*?\)\s*$/, '').trim();
  const id = (m.id || '').toLowerCase();
  if (id.includes('opus')) return 'Opus';
  if (id.includes('fable')) return 'Fable';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('haiku')) return 'Haiku';
  if (id.includes('gemini')) return id.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ');
  if (id.includes('codex')) return 'Codex';
  if (id.includes('deepseek')) return 'DS';
  if (id.includes('kimi') || id === 'k3') return 'Kimi K3';
  return m.id || '';
}

const EFFORT_RANK = Object.freeze({ low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6 });

function pickerRows(screen) {
  const rows = [];
  for (const line of String(screen || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(›|>)?\s*(\d+)\.\s+(.+?)\s*$/);
    if (!match) continue;
    rows.push({
      highlighted: !!match[1],
      number: Number(match[2]),
      text: match[3],
    });
  }
  return rows;
}

function reasoningLabelToEffort(label) {
  // 面板会在当前项后面挂 (current)，在默认项后面挂 (default)。
  // 2026-09-07 实测二级面板的行长这样：「Max (current)  For difficult problems…」，
  // 不把 (current) 摘掉就一个档位都认不出来。
  const value = String(label || '')
    .replace(/\s*\((?:default|current)\)/ig, ' ')
    .trim()
    .toLowerCase();
  if (value.startsWith('extra high') || value === 'xhigh') return 'xhigh';
  if (value.startsWith('ultra')) return 'ultra';
  if (value.startsWith('maximum') || value.startsWith('max')) return 'max';
  if (value.startsWith('high')) return 'high';
  if (value.startsWith('medium')) return 'medium';
  if (value.startsWith('low')) return 'low';
  return '';
}

// 光标在**哪一行**，只能从原始行里读，不能从"能认出档位的那些行"里读。
// 2026-09-07 血泪：Codex 的推理面板第 5 行是「More reasoning… (current)」——
// 它不是档位而是二级菜单入口，被过滤掉之后 highlighted 回落到第 1 行 Low，
// 于是方向键从错误的起点开始数。当前档位是 max（Hub 新建 Codex 会话的默认值）
// 时必踩：点 high 实际选成 medium，然后确认超时。
function pickerCursor(rows) {
  return rows.find(row => row.highlighted) || rows[0] || null;
}

function parseCodexModelPicker(screen) {
  if (!/Select Model and Effort/i.test(String(screen || ''))) return null;
  const rows = pickerRows(screen);
  const entries = rows.map(row => {
    const match = row.text.match(/^((?:gpt-[\w.-]+|o\d[\w.-]*|deepseek-v4-(?:pro|flash)))\b/i);
    return match ? { ...row, value: match[1] } : null;
  }).filter(Boolean);
  if (!entries.length) return null;
  return {
    entries,
    rows,
    cursor: pickerCursor(rows),
    highlighted: entries.find(entry => entry.highlighted) || entries[0],
  };
}

// 一级面板：Low / Medium / High / Extra high +（可能有的）「More reasoning…」二级入口。
// max 与 ultra **不在这一页上**，它们在二级菜单里面。
function parseCodexReasoningPicker(screen, modelId = '') {
  const text = String(screen || '');
  if (!/Select Reasoning Level/i.test(text)) return null;
  if (modelId && !text.toLowerCase().includes(String(modelId).toLowerCase())) return null;
  const rows = pickerRows(text);
  const entries = rows.map(row => {
    const value = reasoningLabelToEffort(row.text);
    return value ? { ...row, value } : null;
  }).filter(Boolean);
  if (!entries.length) return null;
  return {
    entries,
    rows,
    cursor: pickerCursor(rows),
    advancedRow: rows.find(row => /more\s+reasoning/i.test(row.text)) || null,
    highlighted: entries.find(entry => entry.highlighted) || entries[0],
  };
}

// 二级面板（「Advanced Reasoning ⚠ Consumes usage limits faster」）：Max / Ultra。
function parseCodexAdvancedReasoningPicker(screen) {
  const text = String(screen || '');
  if (!/Advanced Reasoning/i.test(text)) return null;
  const rows = pickerRows(text);
  const entries = rows.map(row => {
    const value = reasoningLabelToEffort(row.text);
    return value ? { ...row, value } : null;
  }).filter(Boolean);
  if (!entries.length) return null;
  return { entries, rows, cursor: pickerCursor(rows) };
}

function pickerNavigationInput(fromNumber, toNumber) {
  const from = Number(fromNumber);
  const to = Number(toNumber);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return '';
  return (to > from ? '\x1b[B' : '\x1b[A').repeat(Math.abs(to - from));
}

function compatibleEffort(requested, entries, highlighted) {
  const available = (entries || []).map(entry => entry.value).filter(value => EFFORT_RANK[value]);
  if (!available.length) return null;
  const wanted = String(requested || '').toLowerCase();
  if (available.includes(wanted)) return wanted;
  const rank = EFFORT_RANK[wanted];
  if (rank) {
    const compatible = available.filter(value => EFFORT_RANK[value] <= rank);
    if (compatible.length) return compatible.sort((a, b) => EFFORT_RANK[b] - EFFORT_RANK[a])[0];
  }
  return highlighted && available.includes(highlighted.value) ? highlighted.value : available[0];
}

function modelSelectionMatches(actualId, selectedId) {
  const actual = String(actualId || '').replace(/\[1m\]$/i, '').toLowerCase();
  const selected = String(selectedId || '').replace(/\[1m\]$/i, '').toLowerCase();
  if (!actual || !selected) return false;
  if (actual === selected) return true;
  return ['fable', 'opus', 'sonnet', 'haiku'].some(alias => selected === alias && actual.includes(`-${alias}-`));
}

function terminalAcceptsModelCommand(screen, strategy) {
  const lines = String(screen || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (strategy === 'codex-picker') {
    const prompts = lines.filter(line => line.startsWith('›'));
    const last = prompts[prompts.length - 1] || '';
    return /^›\s*Ask Codex to do anything\s*$/i.test(last);
  }
  if (strategy === 'claude-inline') {
    const prompts = lines.filter(line => line.startsWith('❯'));
    const last = prompts[prompts.length - 1] || '';
    return /^❯\s*$/.test(last) || /^❯\s*Try\s+["“].+["”]\s*$/i.test(last);
  }
  return false;
}

function createModelUiController({
  document,
  ipcRenderer,
  sessions,
  terminalPanelEl,
  getActiveSessionId,
  escapeHtml,
  getModelOptions = modelOptionsFor,
  refreshModelCatalog = async () => null,
  getTerminalScreenText = () => '',
  openCommandScreen = null,
  isSessionBusy = session => !!(session && session.status === 'running'),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  switchTimeoutMs = 7000,
  setTimeoutFn = setTimeout,
  repaintActiveComposer = () => {},
}) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  if (!sessions) throw new Error('sessions is required');
  if (!terminalPanelEl) throw new Error('terminalPanelEl is required');
  if (typeof getActiveSessionId !== 'function') throw new Error('getActiveSessionId is required');
  if (typeof escapeHtml !== 'function') throw new Error('escapeHtml is required');

  // 模型名在界面上只有一个落点了：composer 底栏那个 chip（T1 挪过去，T2 删掉头部
  // 徽章）。所以这里不再自己造节点，只请 composer 重画一遍 —— 名字、切换中的
  // 「A → B」、点击打开选择器全都是 composer 那一处画完的，两份 DOM 必然分叉。
  function updateActiveModelChip() {
    const activeSessionId = getActiveSessionId();
    const session = activeSessionId ? sessions.get(activeSessionId) : null;
    if (!session) return;
    repaintActiveComposer(session);
  }

  // ---- Model picker dropdown ----
  // Claude accepts an inline model argument. Codex 0.151 uses two native
  // keyboard pickers. Both are driven through the real PTY and confirmed from
  // the live screen before Hub changes its own metadata.
  
  
  let openModelPicker = null; // { el, badge, onDocClick } while a picker is open
  
  function attachModelPickerHandler(badgeEl, sessionId) {
    if (!badgeEl || badgeEl._modelPickerBound) return;
    badgeEl._modelPickerBound = true;
    badgeEl.classList.add('clickable');
    badgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openModelPicker && openModelPicker.badge === badgeEl) {
        closeModelPicker();
        return;
      }
      void showModelPicker(badgeEl, sessionId);
    });
  }

  // 挂载点从头部徽章挪到了 composer 底栏（T1），锚点在窗口底部：
  // 一律往下开会把整个菜单开到窗外。下方放不下就翻到锚点上方。
  function placeMenu(menu, badgeEl) {
    const rect = badgeEl.getBoundingClientRect();
    const viewportHeight = (menu.ownerDocument && menu.ownerDocument.defaultView
      && menu.ownerDocument.defaultView.innerHeight) || 0;
    const menuHeight = menu.getBoundingClientRect().height || 0;
    const below = rect.bottom + 4;
    const flipUp = viewportHeight > 0 && menuHeight > 0 && below + menuHeight > viewportHeight
      && rect.top - 4 - menuHeight >= 0;
    const view = menu.ownerDocument?.defaultView;
    const viewportWidth = view?.innerWidth || 0;
    menu.style.top = Math.max(8, Math.min(flipUp ? rect.top - 8 - menuHeight : below,
      viewportHeight > 0 ? viewportHeight - menuHeight - 8 : below)) + 'px';
    menu.style.left = (viewportWidth > 0 ? Math.max(8, Math.min(rect.left, viewportWidth - menu.getBoundingClientRect().width - 8)) : rect.left) + 'px';
    menu.setAttribute?.('role', 'menu');
    for (const item of menu.querySelectorAll?.('.model-picker-item') || []) {
      item.tabIndex = item.classList.contains('disabled') || item.disabled ? -1 : 0;
      item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-disabled', String(item.tabIndex < 0));
    }
    if (!menu._keyboardReady) {
      menu._keyboardReady = true;
      menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeModelPicker(); badgeEl.focus?.(); return; }
        const items = [...menu.querySelectorAll('.model-picker-item')].filter(item => item.tabIndex === 0);
        const index = items.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next].focus();
        } else if (['Enter',' '].includes(event.key) && index >= 0 && items[index].tagName !== 'BUTTON') {
          event.preventDefault(); items[index].click();
        }
      });
      menu.querySelector?.('.model-picker-item[tabindex="0"]')?.focus?.({ preventScroll:true });
    }
  }

  function menuNote(menu, text, state = 'info') {
    const note = document.createElement('div');
    note.className = 'model-picker-note';
    note.dataset.state = state;
    note.textContent = text;
    menu.appendChild(note);
    return note;
  }

  function renderModelPicker(menu, badgeEl, sessionId, message = null) {
    if (!menu || menu._removed) return;
    const session = sessions.get(sessionId);
    const kind = session && session.kind ? session.kind : '';
    const options = getModelOptions(require('../core/chatgpt-web-models').isChatgptWebModel(session?.currentModel?.id) ? 'chatgpt' : kind);
    const strategy = modelSwitchStrategy(kind);
    const currentId = session && session.currentModel ? (session.currentModel.id || '') : '';
    const hasExactCurrent = options.some(option => String(option.id).toLowerCase() === String(currentId).toLowerCase());
    menu.innerHTML = '';
    if (message) menuNote(menu, message.text, message.state);
    if (options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-picker-empty';
      empty.textContent = '该会话类型没有可用模型目录';
      menu.appendChild(empty);
      return;
    }
    if (!canSwitchInSession(kind)) {
      menuNote(menu, 'ℹ 该 CLI 暂不支持从 Hub 原地切换；请在新建会话时选择', 'warning');
    } else if (require('../core/chatgpt-web-models').isChatgptWebModel(currentId)) {
      menuNote(menu, 'ChatGPT 网页 · 选择档位时同步思考强度，下一轮生效。本地工具由 Codex 执行。');
      const settings = document.createElement('button');
      settings.type = 'button';
      settings.className = 'model-picker-item chatgpt-web-settings-link';
      settings.textContent = '打开专用网页窗口与高级设置';
      settings.title = '进入“浏览器”查看真实网页会话；自动/手动模式及更大上下文在专用设置中调整。';
      settings.addEventListener('click', async event => {
        event.stopPropagation();
        try { await ipcRenderer.invoke('chatgpt-web:settings'); }
        catch (error) { menuNote(menu, error.message, 'warning'); }
      });
      menu.appendChild(settings);
    } else if (strategy === 'acp-native') {
      menuNote(menu,'阿里云套餐模型 · 选择后由原生 Harness 确认，再更新显示。');
    } else if (strategy === 'codex-picker') {
      const live = options.some(option => option.source === 'codex-app-server');
      menuNote(menu, `${live ? '当前账号实时目录' : 'Codex CLI 本地缓存'} · `
        + (session.runtimeBackend === 'codex-app-server' ? '选择后由 Codex 确认模型和思考档，再更新显示。'
          : '将打开原生模型与推理档位面板；Hub 确认终端回执后再更新徽标。'));
    } else {
      const official = options.some(option => option.source === 'official-catalog');
      const accountCache = options.some(option => option.source === 'claude-cli-cache');
      const sourceName = official ? '官方模型目录'
        : (accountCache ? '当前账号模型缓存' : 'Claude CLI 兼容目录');
      menuNote(menu, `${sourceName} · `
        + '支持会话内切换；“最新可用版本”由 CLI 按当前账号解析。');
      // 被 CLI 版本挡住的模型自己就是「该升级了」的信号，不需要另开数据通道。
      // 这条提醒正是 Opus 5.5 那次缺失的东西：既说清有什么新模型，也说清怎么办。
      const blocked = options.filter(option => option.disabled && option.upgradeTo);
      if (blocked.length) {
        const names = [...new Set(blocked.map(option => option.label.replace(/\s*\(1M context\)$/, '')))];
        const target = blocked
          .map(option => option.upgradeTo)
          .sort((a, b) => compareCliVersions(a, b))[0];
        menuNote(menu, `${names.join('、')} 需要 Claude Code ${target}+，先在终端运行 claude update 再重开会话。`, 'warning');
      }
    }

    options.forEach((opt) => {
      const item = document.createElement('div');
      item.className = 'model-picker-item';
      if (!strategy) item.classList.add('disabled');
      // 官方目录说这个模型要求更高的 CLI 版本：列出来但不让点。隐藏它等于让
      // 用户完全无从知道新模型的存在 —— 那正是要修的毛病。
      if (opt.disabled) item.classList.add('disabled');
      item.dataset.modelId = opt.id;
      const current = String(currentId).toLowerCase() === String(opt.id).toLowerCase()
        || (!hasExactCurrent && modelSelectionMatches(currentId, opt.id));
      if (current) item.classList.add('current');
      if (session && session._modelSwitchPending) item.classList.add('disabled');
      item.title = opt.disabled && opt.upgradeTo
        ? `${opt.description || opt.id} · 需要 Claude Code ${opt.upgradeTo}+`
        : (opt.description || opt.id);
      item.innerHTML = `<span class="model-picker-check">${current ? '✓' : ''}</span>`
        + `<span class="model-picker-label">${escapeHtml(opt.label)}</span>`
        + `<span class="model-picker-id">${escapeHtml(
          opt.disabled && opt.upgradeTo ? `需 ${opt.upgradeTo}+` : opt.id,
        )}</span>`;
      if (strategy && !opt.disabled && !(session && session._modelSwitchPending)) {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          if (current) { closeModelPicker(); return; }
          void switchModel(sessionId, opt, menu, badgeEl);
        });
      }
      menu.appendChild(item);
    });
  }

  async function showModelPicker(badgeEl, sessionId) {
    closeModelPicker();
    const menu = document.createElement('div');
    menu.className = 'model-picker-menu';
    document.body.appendChild(menu);
    placeMenu(menu, badgeEl);
    const onDocClick = (e) => { if (!menu.contains(e.target)) closeModelPicker(); };
    // defer so the triggering click doesn't immediately close the menu
    setTimeoutFn(() => document.addEventListener('click', onDocClick), 0);
    openModelPicker = { el: menu, badge: badgeEl, onDocClick };
    menuNote(menu, '正在刷新当前账号的模型目录…', 'pending');
    const session = sessions.get(sessionId);
    try {
      const web = require('../core/chatgpt-web-models').isChatgptWebModel(session?.currentModel?.id);
      const catalog = await refreshModelCatalog(web ? 'chatgpt' : session && session.kind, session);
      if (openModelPicker && openModelPicker.el === menu) {
        renderModelPicker(menu, badgeEl, sessionId, catalog && catalog.refreshError ? {
          text: `实时目录刷新失败，已使用本地兜底：${catalog.refreshError}`,
          state: 'warning',
        } : null);
        placeMenu(menu, badgeEl);
      }
    } catch (error) {
      if (openModelPicker && openModelPicker.el === menu) {
        renderModelPicker(menu, badgeEl, sessionId, {
          text: `目录刷新失败，已使用本地兜底：${error && error.message ? error.message : String(error)}`,
          state: 'warning',
        });
      }
    }
  }

  const commandScreens = new Map();
  const commandText = id => commandScreens.get(id)?.text() ?? getTerminalScreenText(id);
  async function beginCommandScreen(sessionId, session) {
    if (!openCommandScreen || !['codex-picker','claude-inline'].includes(modelSwitchStrategy(session.kind))
        || ['codex-app-server','claude-stream-json','acp'].includes(session.runtimeBackend)) return;
    if (isSessionBusy(session)) throw new Error('当前回答仍在运行，请结束后再切换');
    const reader = await openCommandScreen(sessionId);
    commandScreens.set(sessionId, reader);
    return reader;
  }
  function endCommandScreen(sessionId, reader) {
    reader?.dispose();
    if (reader && commandScreens.get(sessionId) === reader) commandScreens.delete(sessionId);
  }

  async function waitForScreen(sessionId, predicate, label) {
    const deadline = now() + switchTimeoutMs;
    let lastScreen = '';
    while (now() < deadline) {
      lastScreen = String(commandText(sessionId) || '');
      const value = predicate(lastScreen);
      if (value) return { value, screen: lastScreen };
      await sleep(60);
    }
    const error = new Error(`${label}超时`);
    error.screen = lastScreen;
    throw error;
  }

  function writeTerminal(sessionId, data) {
    ipcRenderer.send('terminal-input', { sessionId, data });
  }

  function dismissOwnedCodexPicker(sessionId, pending) {
    if (!pending?.ownsCodexPicker) return;
    const screen = commandText(sessionId);
    if (parseCodexModelPicker(screen) || parseCodexReasoningPicker(screen) || parseCodexAdvancedReasoningPicker(screen)) {
      writeTerminal(sessionId, '\x1b');
    }
  }

  async function submitSlashCommand(sessionId, command, strategy) {
    const result = await ipcRenderer.invoke('session:send-prompt', { sessionId, text: command });
    if (!result?.ok || result.notSent || result.sendStatus === 'stuck') {
      throw new Error(result?.message || 'CLI 尚未确认模型命令，请查看终端');
    }
  }

  async function switchCodexModel(sessionId, session, option, { effortOverride = null } = {}) {
    if(session.deepseekLegacyClaude)throw new Error('这个旧 DeepSeek 会话使用 Claude 引擎，不能切换为 Codex 模型');
    if (session.runtimeBackend === 'codex-app-server') {
      const response = await ipcRenderer.invoke('codex:native-action', {
        sessionId, action:'configure', model:option.id, effort:effortOverride || require('../core/chatgpt-web-models').chatgptWebRoute(option.id)?.effort || session.effort,
      });
      if (!response || !response.ok) throw new Error(response && response.message || 'Codex 未确认模型切换');
      return response.result;
    }
    if (isSessionBusy(session)) throw new Error('当前回答仍在运行，请结束后再切换模型');
    if (!terminalAcceptsModelCommand(commandText(sessionId), 'codex-picker')) {
      throw new Error('Codex 输入框有未发送内容或当前不在主提示符；请先处理后再切换模型');
    }
    await submitSlashCommand(sessionId, '/model', 'codex-picker');
    const modelStep = await waitForScreen(sessionId, screen => parseCodexModelPicker(screen), '等待 Codex 模型面板');
    if (session._modelSwitchPending) session._modelSwitchPending.ownsCodexPicker = true;
    const target = modelStep.value.entries.find(entry => entry.value.toLowerCase() === option.id.toLowerCase());
    if (!target) {
      throw new Error('Codex 原生面板未列出该模型，目录可能刚刚变化，请重新打开后重试');
    }
    writeTerminal(sessionId, pickerNavigationInput(modelStep.value.highlighted.number, target.number) + '\r');
    const effortStep = await waitForScreen(
      sessionId,
      screen => parseCodexReasoningPicker(screen, option.id),
      '等待 Codex 推理档位面板',
    );
    // ── 档位这一步 ─────────────────────────────────────────────────────
    // 两件事在这里同时成立：
    //   1. 方向键必须从**面板真正的光标行**开始数（picker.cursor），不是从
    //      "第一个能认出档位的行"开始 —— 后者在当前档位是 max 时必然错位；
    //   2. max / ultra 不在一级面板上，要先进「More reasoning…」二级菜单。
    const picker = effortStep.value;
    const requestedEffort = String(effortOverride || session.effort || '').trim().toLowerCase();
    const directMatch = picker.entries.find(entry => entry.value === requestedEffort);
    let chosenEffort = null;

    if (!directMatch && requestedEffort && picker.advancedRow) {
      writeTerminal(sessionId, pickerNavigationInput(picker.cursor.number, picker.advancedRow.number) + '\r');
      const advancedStep = await waitForScreen(
        sessionId,
        screen => parseCodexAdvancedReasoningPicker(screen),
        '等待 Codex 高级推理面板',
      );
      const advanced = advancedStep.value;
      const advancedTarget = advanced.entries.find(entry => entry.value === requestedEffort);
      if (advancedTarget) {
        writeTerminal(sessionId, pickerNavigationInput(advanced.cursor.number, advancedTarget.number) + '\r');
        chosenEffort = advancedTarget.value;
      } else {
        // 二级菜单里也没有：退回一级面板（面板自己写着 esc to go back），
        // 换模型时允许回落到最接近的档，用户明确点档时则如实报错。
        writeTerminal(sessionId, '\x1b');
        const backStep = await waitForScreen(
          sessionId,
          screen => parseCodexReasoningPicker(screen, option.id),
          '等待退回 Codex 推理档位面板',
        );
        Object.assign(picker, backStep.value);
      }
    }

    if (!chosenEffort) {
      const effort = compatibleEffort(requestedEffort, picker.entries, picker.highlighted);
      if (effortOverride && effort !== effortOverride) {
        writeTerminal(sessionId, '\x1b');
        throw new Error(`该模型的原生面板没有 ${effortOverride} 这一档`);
      }
      const effortTarget = picker.entries.find(entry => entry.value === effort) || picker.highlighted;
      writeTerminal(sessionId, pickerNavigationInput(picker.cursor.number, effortTarget.number) + '\r');
      chosenEffort = effortTarget.value;
    }

    await waitForScreen(sessionId, screen => {
      const escaped = option.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`Model changed to\\s+${escaped}\\s+${chosenEffort}`, 'i').test(screen)
        && screen.toLowerCase().includes(`${option.id.toLowerCase()} ${chosenEffort}`);
    }, '确认 Codex 模型切换');
    return { modelId: option.id, displayName: option.label, effort: chosenEffort };
  }

  async function switchClaudeModel(sessionId, session, option) {
    if (isSessionBusy(session)) throw new Error('当前回答仍在运行，请结束后再切换模型');
    if (!terminalAcceptsModelCommand(commandText(sessionId), 'claude-inline')) {
      throw new Error('Claude 输入框有未发送内容或当前不在主提示符；请先处理后再切换模型');
    }
    await submitSlashCommand(sessionId, `/model ${option.id}`, 'claude-inline');
    let acceptedConfirmation=false;
    const confirmation = await waitForScreen(sessionId, screen => {
      const dialog=require('../core/cli-model-command').parseClaudeModelSwitchConfirmation(screen,option.id);
      if(dialog&&!acceptedConfirmation){
        acceptedConfirmation=true;
        writeTerminal(sessionId,pickerNavigationInput(dialog.cursor,dialog.number)+'\r');
        return null;
      }
      const current = sessions.get(sessionId);
      if (current && current.currentModel && modelSelectionMatches(current.currentModel.id, option.id)) {
        return { modelId: current.currentModel.id, displayName: current.currentModel.displayName || option.label };
      }
      const lower = String(screen || '').toLowerCase();
      const family = String(option.id).replace(/^claude-/, '').split('-')[0].replace(/\[1m\]$/i, '');
      if (/(invalid model|not available|does not have access|unknown model)/i.test(lower)) {
        const error = new Error('Claude Code 拒绝了该模型或当前账号无权限');
        error.modelRejected = true;
        throw error;
      }
      const commandEcho = `/model ${String(option.id).toLowerCase()}`;
      return lower.includes(commandEcho) && lower.includes(family.toLowerCase())
        && /(set model to|model changed|model switched|now using)/i.test(lower)
        ? { modelId: option.id, displayName: option.label }
        : null;
    }, '确认 Claude 模型切换');
    return confirmation.value;
  }

  async function confirmSwitch(sessionId, result) {
    if (typeof ipcRenderer.invoke !== 'function') return { ok: true, model: result };
    const response = await ipcRenderer.invoke('confirm-session-model-switch', {
      sessionId,
      modelId: result.modelId,
      displayName: result.displayName,
      effort: result.effort,
    });
    if (!response || response.ok !== true) {
      throw new Error(response && response.message || 'Hub 未能保存已确认的模型切换');
    }
    return response;
  }

  async function switchModel(sessionId, option, menu, badgeEl) {
    const session = sessions.get(sessionId);
    if (!session || !option || session._modelSwitchPending) return null;
    const strategy = modelSwitchStrategy(session.kind);
    if (!strategy) return null;
    session._modelSwitchPending = { id: option.id, label: option.label };
    updateActiveModelChip();
    renderModelPicker(menu, badgeEl, sessionId, { text: `正在切换到 ${option.label}…`, state: 'pending' });
    let preferencePrepared = false;
    let commandScreen;
    try {
      commandScreen = await beginCommandScreen(sessionId, session);
      if (session.runtimeBackend === 'claude-stream-json') {
        const result = await ipcRenderer.invoke('claude-native:set-model', { sessionId, modelId: option.id });
        if (!result?.ok) throw new Error(result?.error || '模型切换未确认');
        session.currentModel = result.model;
        delete session._modelSwitchPending;
        updateActiveModelChip();
        closeModelPicker();
        return result;
      }
      if (strategy === 'claude-inline' && typeof ipcRenderer.invoke === 'function') {
        const prepared = await ipcRenderer.invoke('prepare-session-model-switch', {
          sessionId,
          modelId: option.id,
        });
        if (!prepared || prepared.ok !== true) {
          throw new Error(prepared && prepared.message || '无法保护 Claude 的全局默认模型');
        }
        preferencePrepared = true;
      }
      const switched = strategy === 'acp-native'
        ? await (async()=>{const r=await ipcRenderer.invoke('codex:native-action',{sessionId,action:'configure',model:option.id});
          if(!r?.ok)throw new Error(r?.message || '原生 Harness 未确认模型');return r.result;})()
        : strategy === 'codex-picker'
        ? await switchCodexModel(sessionId, session, option)
        : await switchClaudeModel(sessionId, session, option);
      const confirmed = await confirmSwitch(sessionId, switched);
      const model = confirmed.model || { id: switched.modelId, displayName: switched.displayName };
      session.currentModel = { id: model.id || switched.modelId, displayName: model.displayName || switched.displayName };
      if (switched.effort) session.effort = switched.effort;
      delete session._modelSwitchPending;
      updateActiveModelChip();
      const preferenceWarning = confirmed.preference && confirmed.preference.restored !== true
        && confirmed.preference.status !== 'missing-snapshot';
      renderModelPicker(menu, badgeEl, sessionId, {
        text: preferenceWarning
          ? `已切换到 ${session.currentModel.displayName}，但恢复 Claude 默认模型失败：${confirmed.preference.status}`
          : switched.appliesOn === 'next-turn' ? `✓ 已选择 ${session.currentModel.displayName}；下次发送生效`
          : `✓ 已切换到 ${session.currentModel.displayName}${confirmed.preference ? '；全局默认未改变' : ''}`,
        state: preferenceWarning ? 'warning' : 'success',
      });
      await sleep(650);
      if (openModelPicker && openModelPicker.el === menu) closeModelPicker();
      return { ok: true, model: session.currentModel, effort: switched.effort || null };
    } catch (error) {
      let cleanupWarning = '';
      if (preferencePrepared && typeof ipcRenderer.invoke === 'function') {
        try {
          const cleanup = await ipcRenderer.invoke('cancel-session-model-switch', { sessionId });
          if (cleanup && cleanup.preference && cleanup.preference.status === 'restore-failed') {
            cleanupWarning = `；同时恢复 Claude 默认模型失败：${cleanup.preference.error || 'unknown error'}`;
          }
        }
        catch (restoreError) {
          cleanupWarning = `；同时恢复 Claude 默认模型失败：${restoreError && restoreError.message ? restoreError.message : String(restoreError)}`;
          console.warn('[model-switch] Claude preference cleanup failed:', restoreError && restoreError.message);
        }
      }
      const codexPickerPending = session._modelSwitchPending;
      delete session._modelSwitchPending;
      updateActiveModelChip();
      console.warn('[model-switch] failed:', error && (error.stack || error.message));
      // Only dismiss a picker this operation actually opened. A busy/draft
      // rejection must never send Escape to the user's running turn.
      if (strategy === 'codex-picker') dismissOwnedCodexPicker(sessionId, codexPickerPending);
      if (openModelPicker && openModelPicker.el === menu) {
        renderModelPicker(menu, badgeEl, sessionId, {
          text: `切换失败：${error && error.message ? error.message : String(error)}${cleanupWarning}`,
          state: 'error',
        });
      }
      return { ok: false, error: error && error.message ? error.message : String(error) };
    } finally { endCommandScreen(sessionId, commandScreen); }
  }
  
  // ── 思考档切换（T1）─────────────────────────────────────────────────
  // Codex 的档位本来就和模型在同一个原生面板里选（/model → 选模型 → 选 reasoning
  // level）。所以「只改档位」不需要任何新通路：把模型这一步停在当前模型上，
  // 只在第二步换档，其余（等回执、写回 Hub 元数据）与换模型完全同一条路径。
  // Claude 没有会话内改档的机制，这个入口对它不开放（chip 侧已经不可点）。
  function renderEffortPicker(menu, anchorEl, sessionId, efforts, message = null) {
    if (!menu || menu._removed) return;
    const session = sessions.get(sessionId);
    const nativeThought = require('../core/acp-model-catalog').acpThoughtOption(session);
    const current = nativeThought?.currentValue || String(session && session.effort || '').trim().toLowerCase();
    menu.innerHTML = '';
    if (message) menuNote(menu, message.text, message.state);
    const modelLabel = session && session.currentModel
      ? (session.currentModel.displayName || session.currentModel.id)
      : '当前模型';
    if (!message) {
      menuNote(menu, `${modelLabel} 支持的思考档 · `+(session?.runtimeBackend==='acp' ? '由原生 Harness 确认后生效。' : session?.runtimeBackend==='codex-app-server'
        ? '选择后由 Codex 确认，再更新显示。' : '将打开 Codex 原生面板，Hub 确认终端回执后再更新档位。'));
    }
    for (const effort of efforts) {
      const nativeChoice = require('../core/acp-model-catalog').acpThoughtChoices(session).find(o=>o.value===effort);
      const description = nativeChoice ? (nativeChoice.description || '') : (EFFORT_DESCRIPTIONS[effort] || '');
      const item = document.createElement('div');
      item.className = 'model-picker-item';
      item.dataset.effort = effort;
      const isCurrent = effort === current;
      if (isCurrent) item.classList.add('current');
      if (session && session._modelSwitchPending) item.classList.add('disabled');
      item.title = description || effort;
      item.innerHTML = `<span class="model-picker-check">${isCurrent ? '✓' : ''}</span>`
        + `<span class="model-picker-label">${escapeHtml(nativeChoice?.name || require('./ui-labels').effortLabel(effort))}</span>`
        + `<span class="model-picker-id">${escapeHtml(description)}</span>`;
      if (!isCurrent && !(session && session._modelSwitchPending)) {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          void switchEffort(sessionId, effort, menu, anchorEl);
        });
      }
      menu.appendChild(item);
    }
  }

  function showEffortPicker(anchorEl, sessionId, { efforts = [] } = {}) {
    closeModelPicker();
    const list = (Array.isArray(efforts) ? efforts : [])
      .map(value => String(value || '').trim())
      .filter(Boolean);
    if (!list.length) return null;
    const menu = document.createElement('div');
    menu.className = 'model-picker-menu effort-picker-menu';
    document.body.appendChild(menu);
    renderEffortPicker(menu, anchorEl, sessionId, list);
    placeMenu(menu, anchorEl);
    const onDocClick = (e) => { if (!menu.contains(e.target)) closeModelPicker(); };
    setTimeoutFn(() => document.addEventListener('click', onDocClick), 0);
    openModelPicker = { el: menu, badge: anchorEl, onDocClick, kind: 'effort', efforts: list };
    return menu;
  }

  async function switchEffort(sessionId, effort, menu, anchorEl) {
    const session = sessions.get(sessionId);
    if (!session || session._modelSwitchPending) return null;
    if (session.runtimeBackend === 'claude-stream-json') {
      session._modelSwitchPending = { id: session.currentModel?.id, label: effort };
      updateActiveModelChip();
      renderEffortPicker(menu, anchorEl, sessionId, (openModelPicker && openModelPicker.efforts) || [effort],
        { text: `正在切换到 ${effort}…`, state: 'pending' });
      try {
        const result = await ipcRenderer.invoke('claude-native:set-effort', { sessionId, effort });
        if (!result?.ok) throw new Error(result?.error || '引擎未确认思考档');
        session.effort = result.result.effort;
        delete session._modelSwitchPending;
        updateActiveModelChip();
        closeModelPicker();
        return result.result;
      } catch (error) {
        delete session._modelSwitchPending;
        updateActiveModelChip();
        renderEffortPicker(menu, anchorEl, sessionId, (openModelPicker && openModelPicker.efforts) || [effort],
          { text: '切换失败：' + error.message, state: 'error' });
        return null;
      }
    }
    if (!['codex-picker','acp-native'].includes(modelSwitchStrategy(session.kind))) return null;
    const modelId = String(session.currentModel && session.currentModel.id || '').trim();
    if (!modelId) return null;
    const option = {
      id: modelId,
      label: session.currentModel.displayName || modelId,
    };
    const efforts = (openModelPicker && openModelPicker.efforts) || [effort];
    session._modelSwitchPending = { id: modelId, label: effort };
    updateActiveModelChip();
    renderEffortPicker(menu, anchorEl, sessionId, efforts, { text: `正在切换到 ${effort}…`, state: 'pending' });
    let commandScreen;
    try {
      commandScreen = await beginCommandScreen(sessionId, session);
      const switched = session.runtimeBackend === 'acp'
        ? await (async () => {
          const response = await ipcRenderer.invoke('codex:native-action', {sessionId, action:'configure', effort});
          if (!response?.ok) throw new Error(response?.message || '原生 Harness 未确认思考深度');
          return response.result;
        })()
        : await switchCodexModel(sessionId, session, option, { effortOverride: effort });
      const confirmed = await confirmSwitch(sessionId, switched);
      const model = confirmed.model || { id: switched.modelId, displayName: switched.displayName };
      session.currentModel = {
        id: model.id || switched.modelId,
        displayName: model.displayName || switched.displayName,
      };
      if (switched.effort) session.effort = switched.effort;
      delete session._modelSwitchPending;
      updateActiveModelChip();
      if (openModelPicker && openModelPicker.el === menu) {
        renderEffortPicker(menu, anchorEl, sessionId, efforts, {
          text: switched.appliesOn === 'next-turn' ? `✓ 已选择 ${session.effort}；下次发送生效` : `✓ 思考档已切到 ${session.effort}`,
          state: 'success',
        });
      }
      await sleep(650);
      if (openModelPicker && openModelPicker.el === menu) closeModelPicker();
      return { ok: true, effort: session.effort };
    } catch (error) {
      const codexPickerPending = session._modelSwitchPending;
      delete session._modelSwitchPending;
      updateActiveModelChip();
      console.warn('[effort-switch] failed:', error && (error.stack || error.message));
      dismissOwnedCodexPicker(sessionId, codexPickerPending);
      if (openModelPicker && openModelPicker.el === menu) {
        renderEffortPicker(menu, anchorEl, sessionId, efforts, {
          text: `切换失败：${error && error.message ? error.message : String(error)}`,
          state: 'error',
        });
      }
      return { ok: false, error: error && error.message ? error.message : String(error) };
    } finally { endCommandScreen(sessionId, commandScreen); }
  }

  function closeModelPicker() {
    if (!openModelPicker) return;
    document.removeEventListener('click', openModelPicker.onDocClick);
    openModelPicker.el.remove();
    openModelPicker = null;
  }

  async function showSpeedPicker(anchorEl, sessionId) {
    closeModelPicker();
    let catalogLoading = true;
    const menu = document.createElement('div');
    menu.className = 'model-picker-menu speed-picker-menu';
    document.body.appendChild(menu);
    const onDocClick = event => { if (!menu.contains(event.target)) closeModelPicker(); };
    openModelPicker = {el:menu,badge:anchorEl,onDocClick};
    setTimeoutFn(()=>document.addEventListener('click',onDocClick),0);
    const paint = (note, state) => {
      menu.replaceChildren();
      const session = sessions.get(sessionId);
      const tuning = document.defaultView?.WorkspaceController?.codexModelTuning(session?.currentModel?.id);
      const control = speedControl(session,tuning);
      for (const [tier,label] of [['standard','标准'],['fast','快速 · 增加用量 / 费用']]) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'model-picker-item'; button.dataset.speed = tier;
        button.textContent = `${control.tier === tier ? '✓ ' : ''}${label}`;
        button.disabled = catalogLoading || !!session?._modelSwitchPending || (tier === 'fast' && !control.interactive);
        button.addEventListener('click',()=>void select(tier));
        menu.appendChild(button);
      }
      menuNote(menu,note || (control.interactive ? '仅调整当前会话速度，不改变模型或思考深度' : '当前目录尚未确认 Fast 支持；可选择标准'),state || 'pending');
      placeMenu(menu,anchorEl);
      const width = document.defaultView?.innerWidth;
      if (width) menu.style.left = Math.max(8,Math.min(anchorEl.getBoundingClientRect().left,width-menu.getBoundingClientRect().width-8))+'px';
    };
    const select = async tier => {
      const session = sessions.get(sessionId);
      if (!session || session._modelSwitchPending) return;
      session._modelSwitchPending = {id:session.currentModel?.id,label:tier};
      paint('正在确认速度设置…','pending'); updateActiveModelChip();
      let commandScreen;
      try {
        if (isSessionBusy(session)) throw new Error('请等当前回答结束后再切换速度');
        const native = session.runtimeBackend === 'codex-app-server';
        const codexPty = String(session.kind).replace(/-resume$/,'') === 'codex' && !native;
        // Native Claude answers over the protocol; there is no terminal prompt
        // to inspect, and the old screen check would reject every switch.
        const nativeClaude = session.runtimeBackend === 'claude-stream-json';
        if (!native && !nativeClaude && !codexPty) commandScreen = await beginCommandScreen(sessionId, session);
        // Codex's IPC checks the authoritative PTY snapshot and waits for the
        // CLI acknowledgement. The hidden renderer frame can be empty/stale
        // in card view; it must not veto that independent readiness check.
        if (!native && !nativeClaude && !codexPty && !terminalAcceptsModelCommand(commandText(sessionId),'claude-inline')) {
          throw new Error('终端输入框有草稿或不在主提示符，请先处理后再切换');
        }
        const response = await ipcRenderer.invoke(native ? 'codex:native-action' : codexPty ? 'codex:set-speed' : 'session:set-fast', native
          ? {sessionId,action:'configure',codexSpeedTier:tier}
          : codexPty ? {sessionId,tier} : {sessionId,enabled:tier === 'fast'});
        if (!response?.ok) throw new Error(response?.message || '未收到速度切换确认');
        if (native || codexPty) session.codexSpeedTier = response.result.codexSpeedTier;
        else session.fastMode = response.result.fastMode;
        delete session._modelSwitchPending;
        updateActiveModelChip();
        if (openModelPicker?.el === menu) paint(native ? '✓ 已选择，下次发送生效'
          : response.warning ? '✓ 已切换 · ' + response.warning : `✓ ${codexPty ? 'Codex' : 'Claude'} 已确认速度设置`,'success');
        await sleep(650);
        if (openModelPicker?.el === menu) closeModelPicker();
      } catch (error) {
        delete session._modelSwitchPending;
        updateActiveModelChip();
        if (openModelPicker?.el === menu) paint('切换失败：'+error.message,'error');
      } finally { endCommandScreen(sessionId, commandScreen); }
    };
    paint('正在核对当前模型支持的速度…','pending');
    const session = sessions.get(sessionId);
    try {
      await refreshModelCatalog(session?.kind,session);
      catalogLoading = false;
      if (openModelPicker?.el === menu) paint();
    } catch (error) {
      catalogLoading = false;
      if (openModelPicker?.el === menu) paint('目录刷新失败：'+error.message,'error');
    }
  }

  return {
    attachModelPickerHandler,
    updateActiveModelChip,
    closeModelPicker,
    showEffortPicker,
    showSpeedPicker,
    showModelPicker,
    switchEffort,
    switchModel,
  };
}

module.exports = {
  compatibleEffort,
  createModelUiController,
  modelClass,
  modelSelectionMatches,
  modelShort,
  parseCodexAdvancedReasoningPicker,
  parseCodexModelPicker,
  parseCodexReasoningPicker,
  pickerNavigationInput,
  reasoningLabelToEffort,
  terminalAcceptsModelCommand,
};
