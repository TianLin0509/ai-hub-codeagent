const {
  guardMarkdownLocalPaths,
  restoreMarkdownLocalPaths,
} = require('./markdown-local-path-guard.js');
const {
  guardMarkdownMath,
  restoreMarkdownMath,
} = require('./markdown-math-guard.js');
const {
  buildTurnPresentation,
  normalizeToolActivity,
} = require('../core/turn-presentation.js');
const { renderImageAttachments, createCardDetailControls } = require('./card-detail-controls.js');
const { chatAvatarSrc, USER_AVATAR_SRC } = require('./chat-avatar');

function createTurnCardRenderer(options = {}) {
  const doc = options.document || document;
  const win = options.window || window;
  const state = options.state || win;
  const root = options.root || doc;
  const listeners = [];
  function listen(type, handler) { root.addEventListener(type, handler); listeners.push([type, handler]); }
  const overlay = () => options.container || doc.getElementById('msg-overlay');
  const nav = options.navigator || (win && win.navigator) || {};
  // All live Hub card surfaces share the native writer, verification and retries.
  // The browser fallback only serves standalone renderers without Hub services.
  const clipboardApi = typeof options.copyText === 'function' ? {
    async writeText(text) {
      const result = await options.copyText(text, { source: 'card-detail', silent: true });
      if (result && result.ok === false) throw new Error(result.reason || '复制失败');
    },
  } : nav.clipboard || { writeText: () => Promise.reject(new Error('剪贴板不可用')) };
  const cssApi = options.CSS || (win && win.CSS) || {};
  const cssEscape = typeof cssApi.escape === 'function'
    ? (value) => cssApi.escape(String(value))
    : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const marked = options.marked;
  const DOMPurify = options.DOMPurify;
  const renderMathInElement = typeof options.renderMathInElement === 'function'
    ? options.renderMathInElement
    : (win && typeof win.renderMathInElement === 'function' ? win.renderMathInElement : null);
  const formatAbsoluteTime = options.formatAbsoluteTime;
  const normalizeMarkdownPathBreaks = options.normalizeMarkdownPathBreaks;
  const escapeHtml = options.escapeHtml;
  const wrapPathLinksInElement = options.wrapPathLinksInElement;
  const getActiveSessionId = typeof options.getActiveSessionId === 'function' ? options.getActiveSessionId : () => null;
  const getSessionContext = typeof options.getSessionContext === 'function' ? options.getSessionContext : () => null;
  const onTurnPresentation = typeof options.onTurnPresentation === 'function' ? options.onTurnPresentation : null;
  const updateStreamingIndicator = typeof options.updateStreamingIndicator === 'function' ? options.updateStreamingIndicator : null;

  function prepareTurnForRender(sessionId, turn, opts = {}) {
    const session = opts.session || getSessionContext(sessionId) || null;
    if (turn?.role === 'user') {
      const assistantContext=require('../core/assistant-context-display').assistantContextDisplay(turn.text,session?.purpose)
        ||require('../core/hub-assistant/delegated-prompt').delegatedPromptDisplay(turn.text);
      if(!turn.clientSubmissionId&&assistantContext?.clientSubmissionId)turn={...turn,clientSubmissionId:assistantContext.clientSubmissionId};
      const feedback = require('../core/native-feedback');
      const receiptAuthoritative = feedback.hasNativeReceipt(turn);
      return { ...turn, simpleChat: true, attachmentCwd: session?.cwd || opts.cwd || turn.attachmentCwd,
        assistantContext,
        receiptAuthoritative, promptReceipt: feedback.promptReceipt(session, turn.clientSubmissionId,
          {authoritative: receiptAuthoritative, deliveryStatus: turn.deliveryStatus}) };
    }
    if (!turn || turn.role !== 'assistant') return turn;
    let toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
    const live = session && Array.isArray(session.liveToolActivities) ? session.liveToolActivities : [];
    if (live.length && session.livePresentationCardId === turn.id) {
      const merged = new Map();
      for (const tool of toolCalls.concat(live)) {
        const key = String(tool && (tool.id || tool.toolCallId || tool.callId) || `tool-${merged.size}`);
        merged.set(key, { ...(merged.get(key) || {}), ...tool });
      }
      toolCalls = Array.from(merged.values());
    }
    const presentationTurn = toolCalls === turn.toolCalls ? turn : { ...turn, toolCalls };
    const presentation = buildTurnPresentation(presentationTurn, {
      cwd: session && session.cwd || opts.cwd || null,
    });
    return { ...presentationTurn, simpleChat: true, presentation, assistantIdentity: session?.purpose === 'hub-assistant' };
  }

  function publishTurnPresentation(sessionId, turn) {
    if (!onTurnPresentation || !turn || turn.role !== 'assistant') return;
    try { onTurnPresentation(sessionId, turn.presentation || null, turn); }
    catch (error) { console.warn('[turn-card] onTurnPresentation failed:', error && error.message); }
  }

  function renderMarkdownPreservingLocalPaths(text) {
    const mathGuard = guardMarkdownMath(normalizeMarkdownPathBreaks(text));
    const guard = guardMarkdownLocalPaths(mathGuard.text);
    const rawHtml = marked.parse(guard.text, { breaks: true, gfm: true });
    const sanitized = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'data-lang'] });
    const withPaths = restoreMarkdownLocalPaths(sanitized, guard);
    return restoreMarkdownMath(withPaths, mathGuard);
  }

// === Spec 1 v0.9.0 · 工具调用块 ===
// _sessionTurns: turnId -> turn object map. Initialized here so rerenderTurn
// works for T5 toggle even before T10 wires real session.turns data.
// T10 will populate this from session.turns[]; for now it's an empty map.
if (!state._sessionTurns) state._sessionTurns = new Map();
const _fullActivityTurns = new Set();
const detailControls = createCardDetailControls({
  document: doc, window: win, clipboard: clipboardApi, root: options.root,
  resolveTurn: card => state._sessionTurns.get(card?.dataset.turnId),
  resolveResult: element => {
    const card = element.closest('.turn-card'), turn = state._sessionTurns.get(element.closest('[data-turn]')?.dataset.turn || card?.dataset.turnId);
    const id = element.closest('[data-activity-id]')?.dataset.activityId;
    const activity = (turn?.toolCalls || []).map(normalizeToolActivity).find(a => a.id === id);
    if (!activity) throw new Error('未找到完整工具来源，请重新载入会话');
    if (activity.resultRef) {
      if (!options.readToolResult) throw new Error('当前视图无法读取完整工具来源');
      return options.readToolResult(activity.resultRef);
    }
    return activity.result;
  },
  openAttachment: options.openAttachment,
});

// === Spec 3 · UI 方案 E (CardCluster) — 工具簇 ===
// 多 tool 同 turn 合并显示：1 行 cluster summary 默认折叠，展开后是工具列表。
// 每行 tool 显示 [Name] [cmd-from-input]，因 tool_result 在 parser 跳过故无 stdout
// （留待 spec 3+ 关联 tool_use_id ↔ tool_result 后再展开单 tool 详情）。
// 替代了之前每个 tool 单独渲染成大块的方案（信息密度低）。
const _TOOL_CMD_KEYS = ['file_path', 'command', 'pattern', 'path', 'url', 'query'];
function _toolCmdFromInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of _TOOL_CMD_KEYS) {
    if (typeof input[k] === 'string' && input[k]) {
      return input[k].split('\n')[0].slice(0, 100);
    }
  }
  return '';
}
// Spec 3 · W9 / Spec 4 · 工具返回预览：渲染单条 tool row。
// 有 result 时用 <details>/<summary>/<pre> 折叠；summary 右侧加 👁 预览按钮 +
// 结果区头部带 toolbar（meta + 复制全文 + [postProcess 动态注入]展开按钮）。
// DOM 只承载前 50,000 字符；完整来源留在 turn，复制、分页查看和下载从来源读取。
// 超过 2,048 字符的预览默认折叠；较短 JSON 可格式化并高亮。
const _TOOL_RESULT_HARD_LIMIT = 50000;
function _activityStatusHtml(activity) {
  const labels = {
    pending: '等待', running: '进行中', completed: '完成', failed: '失败', cancelled: '取消', unknown:'结果未确认', declined:'已拒绝',
  };
  const status = labels[activity.status] ? activity.status : 'pending';
  return `<span class="turn-activity-status ${status}" data-activity-status="${status}">${labels[status]}</span>`;
}

function _renderToolRow(tc, index = 0) {
  const activity = tc && tc.title ? tc : normalizeToolActivity(tc || {}, index);
  const name = escapeHtml(activity.name || '?');
  const cmd = escapeHtml(activity.detail || _toolCmdFromInput(activity.input));
  const duration = activity.durationMs !== null && activity.durationMs !== undefined && Number.isFinite(Number(activity.durationMs))
    ? `<span class="turn-activity-duration">${escapeHtml(_fmtDuration(Number(activity.durationMs)))}</span>`
    : '';
  const exit = activity.exitCode !== null ? `<span class="turn-activity-exit">exit ${escapeHtml(activity.exitCode)}</span>` : '';
  const head = `<span class="turn-activity-kind kind-${escapeHtml(activity.kind || 'other')}" aria-hidden="true"></span><span class="tc-row-name">${name}</span>${cmd ? ` <span class="tc-row-cmd">${cmd}</span>` : ''}<span class="turn-activity-row-meta">${duration}${exit}${_activityStatusHtml(activity)}</span>`;
  const hasResult = typeof activity.result === 'string' && activity.result.length > 0;
  const activityAttrs = ` data-activity-id="${escapeHtml(activity.id || `activity-${index}`)}" data-activity-kind="${escapeHtml(activity.kind || 'other')}"`;
  if (!hasResult) return `<div class="tc-row turn-activity-item"${activityAttrs}>${head}</div>`;
  const isErr = activity.status === 'failed' || activity.isError === true;
  const rawLen = activity.result.length;
  const deferred = activity.resultTruncated;
  const truncated = deferred || rawLen > _TOOL_RESULT_HARD_LIMIT;
  const body = truncated
    ? activity.result.slice(0, _TOOL_RESULT_HARD_LIMIT)
    : activity.result;
  const sizeText = rawLen.toLocaleString('zh-CN') + ' 字符';
  const errBadge = isErr ? '<span class="tc-row-errbadge">✗ 错误</span>' : '';
  return `<details class="tc-row tc-row-with-result turn-activity-item${isErr ? ' tc-row-err' : ''}" data-tool-result-len="${rawLen}"${activityAttrs}>
    <summary class="tc-row-head">${head}${errBadge}<span class="tc-row-actions"><button class="tc-row-preview-btn" data-action="tc-toggle-preview" type="button" title="预览工具返回">👁 预览</button></span></summary>
    <div class="tc-result-wrap">
      <div class="tc-result-toolbar">
        <span class="tc-result-meta">${deferred ? '预览 · 全文按需读取' : truncated ? `预览 ${_TOOL_RESULT_HARD_LIMIT.toLocaleString('zh-CN')} / ${sizeText} · 全文保留` : sizeText}</span>
        ${truncated ? '<button class="tc-result-full" data-action="tc-open-full-result" type="button">查看全文</button>' : ''}
        <button class="tc-result-copy" data-action="tc-copy-result" type="button" title="复制全文">📋 复制</button>
      </div>
      <pre class="tc-result${isErr ? ' tc-result-err' : ''}" data-result-raw>${escapeHtml(body)}</pre>
    </div>
  </details>`;
}

function renderToolCluster(turnId, toolCalls, total = toolCalls?.length || 0) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  const activities = toolCalls.map((tool, index) => normalizeToolActivity(tool, index));
  const counts = {};
  for (const activity of activities) counts[activity.status] = (counts[activity.status] || 0) + 1;
  const breakdown = [
    counts.running ? `${counts.running} 进行中` : '',
    counts.pending ? `${counts.pending} 等待` : '',
    counts.completed ? `${counts.completed} 完成` : '',
    counts.failed ? `${counts.failed} 失败` : '',
    counts.cancelled ? `${counts.cancelled} 取消` : '',
    counts.unknown ? `${counts.unknown} 结果未确认` : '',
    counts.declined ? `${counts.declined} 已拒绝` : '',
  ].filter(Boolean).join(' · ');
  const items = activities.map(_renderToolRow).join('');
  const activeOutput = [...activities].reverse().find(a => a.status === 'running' && a.name === 'commandExecution' && a.result);
  const outputTail = activeOutput ? String(activeOutput.result).slice(-600).trim().split(/\r?\n/).slice(-2).join('\n') : '';
  return `<details class="tc-cluster turn-activity-rail${activities.length === 1 ? ' tc-cluster-single' : ''}" data-turn="${escapeHtml(turnId)}" data-activity-count="${total}">
    <summary class="tc-cluster-head"><span class="turn-activity-title">活动 ${total}</span><span class="turn-activity-breakdown">${total > activities.length ? `最近 ${activities.length} 项：` : ''}${escapeHtml(breakdown)}</span></summary>
    <div class="tc-cluster-list">${items}${total > activities.length ? '<button type="button" data-action="tc-show-all">查看全部活动</button>' : ''}</div>
  </details>${outputTail ? `<div class="turn-active-output"><span>最近命令输出</span><pre>${escapeHtml(outputTail)}</pre></div>` : ''}`;
}

const renderDeliverySummary = delivery => require('./delivery-summary').renderDeliverySummary(delivery, escapeHtml);
const renderDeliveryGlance = delivery => require('./delivery-summary').renderDeliveryGlance(delivery, escapeHtml);

function _disclosureKey(element, index) {
  if (!element) return `details:${index}`;
  if (element.dataset && element.dataset.activityId) return `activity:${element.dataset.activityId}`;
  if (element.classList?.contains('conversation-long-message')) return require('./message-disclosure-state').key(element);
  if (element.classList && element.classList.contains('turn-thinking')) return 'thinking';
  if (element.classList && element.classList.contains('chat-process')) return 'chat-process';
  if (element.classList && element.classList.contains('turn-delivery-summary')) return 'delivery';
  if (element.classList && element.classList.contains('tc-cluster')) return `cluster:${element.dataset.turn || ''}`;
  return `details:${index}:${element.className || ''}`;
}

function _captureCardUiState(card) {
  const disclosures = new Map();
  Array.from(card.querySelectorAll('details')).forEach((element, index) => {
    disclosures.set(_disclosureKey(element, index), !!element.open);
  });
  const selectionApi = typeof win.getSelection === 'function' ? win.getSelection() : null;
  let selection = null;
  try {
    if (selectionApi && selectionApi.rangeCount > 0) {
      const range = selectionApi.getRangeAt(0);
      const body = card.querySelector('.turn-body');
      if (body && body.contains(range.commonAncestorContainer)) {
        const beforeStart = doc.createRange();
        beforeStart.selectNodeContents(body);
        beforeStart.setEnd(range.startContainer, range.startOffset);
        const beforeEnd = doc.createRange();
        beforeEnd.selectNodeContents(body);
        beforeEnd.setEnd(range.endContainer, range.endOffset);
        selection = {
          start: beforeStart.toString().length,
          end: beforeEnd.toString().length,
          text: selectionApi.toString(),
        };
      }
    }
  } catch {}
  const parent = card.parentElement;
  return {
    disclosures,
    selection,
    parent,
    followSnapshot: parent?._cardFollowController?.capture(),
    parentScrollTop: parent ? parent.scrollTop : 0,
    parentBottomGap: parent ? Math.max(0, parent.scrollHeight - parent.scrollTop - parent.clientHeight) : 0,
  };
}

function _restoreCardSelection(card, snapshot) {
  if (!snapshot || !snapshot.selection || typeof doc.createTreeWalker !== 'function') return false;
  const body = card.querySelector('.turn-body');
  const selectionApi = typeof win.getSelection === 'function' ? win.getSelection() : null;
  if (!body || !selectionApi) return false;
  const wantedStart = snapshot.selection.start;
  const wantedEnd = snapshot.selection.end;
  let cursor = 0;
  let startNode = null;
  let endNode = null;
  let startOffset = 0;
  let endOffset = 0;
  try {
    const showText = win.NodeFilter ? win.NodeFilter.SHOW_TEXT : 4;
    const walker = doc.createTreeWalker(body, showText);
    let node;
    while ((node = walker.nextNode())) {
      const length = node.textContent.length;
      // At a text-node boundary, start in the next node. Ending in the time
      // column would include a visual grid newline in the restored selection.
      if (!startNode && wantedStart < cursor + length) {
        startNode = node;
        startOffset = Math.max(0, Math.min(length, wantedStart - cursor));
      }
      if (!endNode && wantedEnd <= cursor + length) {
        endNode = node;
        endOffset = Math.max(0, Math.min(length, wantedEnd - cursor));
        if (!startNode && wantedStart === wantedEnd) { startNode = endNode; startOffset = endOffset; }
        break;
      }
      cursor += length;
    }
    if (!startNode) return false;
    if (!endNode) { endNode = startNode; endOffset = startOffset; }
    const range = doc.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    selectionApi.removeAllRanges();
    selectionApi.addRange(range);
    return selectionApi.toString() === body.textContent.slice(wantedStart, wantedEnd);
  } catch {}
  return false;
}

function _restoreCardUiState(card, snapshot) {
  if (!snapshot) return;
  Array.from(card.querySelectorAll('details')).forEach((element, index) => {
    const key = _disclosureKey(element, index);
    if (snapshot.disclosures.has(key)) element.open = snapshot.disclosures.get(key);
  });
  const selectionRestored = _restoreCardSelection(card, snapshot);
  if (snapshot.selection) {
    const raf = typeof win.requestAnimationFrame === 'function'
      ? win.requestAnimationFrame.bind(win)
      : (callback) => setTimeout(callback, 0);
    const restoreIfStillOurs = () => {
      if (!card.isConnected) return;
      const current = typeof win.getSelection === 'function' ? win.getSelection().toString() : '';
      // Never clobber a new user selection made after the patch. Re-apply only
      // when a later renderer/layout pass cleared the selection we restored.
      if (!current || current === snapshot.selection.text) _restoreCardSelection(card, snapshot);
    };
    raf(() => {
      restoreIfStillOurs();
      raf(restoreIfStillOurs);
    });
  }
  const parent = snapshot.parent;
  if (parent && card.parentElement === parent) {
    if (parent._cardFollowController) parent._cardFollowController.restore(snapshot.followSnapshot);
    else if (snapshot.parentBottomGap < 50) parent.scrollTop = parent.scrollHeight;
    else parent.scrollTop = snapshot.parentScrollTop;
  }
  return selectionRestored;
}

function _postProcessTurnCard(card, sessionId, deferActivity = false) {
  if (!card) return;
  if (typeof postProcessCardCodeBlocks === 'function') postProcessCardCodeBlocks(card);
  if (typeof postProcessToolResults === 'function') postProcessToolResults(card);
  const bodyEl = card.querySelector('.turn-body');
  if (bodyEl && typeof wrapPathLinksInElement === 'function') wrapPathLinksInElement(bodyEl, { sessionId });
  postProcessCardMath(card);
  if (typeof postProcessLongTextFold === 'function') postProcessLongTextFold(card);
  require('./message-disclosure-state').restore(card);
  if (!deferActivity) require('./conversation-message-view').syncResponseNeighbors(card);
}

function patchTurnCardInPlace(existing, newCard, sessionId) {
  if (!existing || !newCard || typeof existing.replaceChildren !== 'function') return null;
  require('./conversation-header-activity').restoreActivitySources(existing.parentElement);
  const snapshot = _captureCardUiState(existing);
  const workingIndicator = existing.querySelector('.streaming-indicator');
  const workingAnimations = workingIndicator?.getAnimations?.({subtree:true}).map(animation=>({
    element:animation.effect?.target,name:animation.animationName,time:animation.currentTime,
  })) || [];
  const priorSessionId = existing.dataset.sessionId || String(sessionId || '');
  const patchCount = Number(existing.dataset.patchCount || 0) + 1;
  for (const attribute of Array.from(existing.attributes || [])) {
    if (attribute.name !== 'data-session-id') existing.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(newCard.attributes || [])) {
    existing.setAttribute(attribute.name, attribute.value);
  }
  existing.dataset.sessionId = priorSessionId;
  existing.dataset.patchCount = String(patchCount);
  existing.dataset.renderMode = 'in-place';
  existing.replaceChildren(...Array.from(newCard.childNodes));
  if (workingIndicator) {
    existing.querySelector('.turn-head')?.appendChild(workingIndicator);
    // A streaming patch must not restart the ring/breathing on every delta.
    for (const saved of workingAnimations) {
      const animation=saved.element?.getAnimations?.().find(a=>a.animationName===saved.name);
      if (animation && typeof saved.time==='number') animation.currentTime=saved.time;
    }
  }
  _postProcessTurnCard(existing, sessionId, true);
  const selectionRestored = _restoreCardUiState(existing, snapshot);
  require('./message-disclosure-state').restore(existing);
  require('./conversation-message-view').syncResponseNeighbors(existing);
  if (!win.__cardRenderMetrics) win.__cardRenderMetrics = { inPlacePatches: 0, rootReplacements: 0 };
  win.__cardRenderMetrics.inPlacePatches += 1;
  win.__cardRenderMetrics.lastSelection = {
    captured: snapshot.selection,
    restored: selectionRestored,
    text: typeof win.getSelection === 'function' ? win.getSelection().toString() : '',
  };
  return existing;
}

function rerenderTurn(turnId) {
  const card = root.querySelector(`.turn-card[data-turn-id="${turnId}"]`);
  if (!card || !state._sessionTurns) return;
  const turn = prepareTurnForRender(card.dataset.sessionId || getActiveSessionId(), state._sessionTurns.get(turnId));
  if (!turn) return;
  const tmp = doc.createElement('div');
  tmp.innerHTML = renderTurnCard(turn);
  const newCard = tmp.firstElementChild;
  if (newCard) {
    patchTurnCardInPlace(card, newCard, card.dataset.sessionId || getActiveSessionId());
    publishTurnPresentation(card.dataset.sessionId || getActiveSessionId(), turn);
  }
}

function aiLetterFallback(kind) {
  const k = (kind || '?').toUpperCase();
  return k.length >= 2 ? k.slice(0, 2) : k + '?';
}

// === Spec 3 · W7 头部 metadata pills ===
// 工具数已经进入活动轨；这里只保留 token / context / duration（user 卡片仅字数）。
// model context window 用模糊匹配（实际 model id 多变如 "claude-opus-4-7[1m]"），匹配不到默认 200k。
function _modelCtxWindow(model) {
  if (!model) return 200000;
  const m = String(model).toLowerCase();
  if (m.includes('k3') || m.includes('kimi')) return 1048576;
  if (m.includes('1m') || m.includes('opus-4')) return 1000000;
  if (m.includes('gemini')) return 1000000;
  if (m.includes('sonnet')) return 200000;
  if (m.includes('haiku')) return 200000;
  if (m.includes('gpt')) return 128000;
  return 200000;
}
function _fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
function _fmtDuration(ms) {
  const s = ms / 1000;
  if (s >= 60) return (s / 60).toFixed(1) + 'min';
  return s.toFixed(1) + 's';
}
function _renderMetaPills(turn, compact = false) {
  // Item timestamps inherit the logical turn end; repeating that elapsed time
  // on every progress item is both noisy and misleading.
  if (turn.phase === 'commentary') return '';
  const isUser = turn.role === 'user';
  if (isUser) {
    const n = (turn.assistantContext?.userText ?? turn.text ?? '').length;
    if (!n) return '';
    return compact ? `<span class="turn-meta chat-word-count" title="消息字数">${n} 字</span>`
      : `<span class="turn-meta-pills"><span class="pill">📝 ${n} 字</span></span>`;
  }
  const pills = [];
  // Activity count moved into the richer lifecycle rail. Keeping the legacy
  // tool pill would repeat the same number immediately below the rail.
  if (turn.usage && (turn.usage.input_tokens || turn.usage.output_tokens)) {
    pills.push(`<span class="pill pill-token">⇡${_fmtTokens(turn.usage.input_tokens||0)} ⇣${_fmtTokens(turn.usage.output_tokens||0)}</span>`);
  }
  const contextTokens = turn.usage && (Object.hasOwn(turn.usage, 'context_tokens')
    ? turn.usage.context_tokens : turn.usage.input_tokens);
  if (typeof contextTokens === 'number' && contextTokens >= 0) {
    const win = turn.usage.context_window || _modelCtxWindow(turn.model);
    const pct = Math.min(100, Math.round(contextTokens / win * 100));
    pills.push(`<span class="pill pill-ctx">📊 ${pct}% ctx</span>`);
  }
  const durationMs = turn.durationMs ?? (turn.tsEnd > turn.ts ? turn.tsEnd - turn.ts : null);
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    pills.push(`<span class="pill pill-time">⏱ ${_fmtDuration(durationMs)}</span>`);
  }
  if (pills.length === 0) return '';
  return `<span class="turn-meta-pills">${pills.join('')}</span>`;
}

function renderTurnSpeed(turn) {
  const display = require('./turn-speed-display').speedDisplay(turn.turnSpeed);
  return display ? `<span class="turn-speed" title="${escapeHtml(display.title)}" aria-label="${escapeHtml(display.text)}"><span class="turn-speed-detail">${escapeHtml(display.mode ? display.mode + ' · ' : '')}均速 </span>≈${escapeHtml(display.rate)}<span class="turn-speed-unit"> tok</span>/s</span>` : '';
}

// === Spec 1 v0.9.0 · turn 卡片渲染 ===
function renderCardActions(turn) {
  const user = turn.role === 'user', activity = turn.phase === 'activity';
  const copy = activity ? '' : '<button class="ta-btn" data-action="copy" title="复制" aria-label="复制这条消息">复制</button>';
  const multi = '<button class="ta-btn ta-multi" data-action="multi-select">多选</button>';
  const secondary = user
    ? '<button class="ta-btn" data-action="resend">重发这条消息</button><button class="ta-btn" data-action="edit-resend">编辑重发</button><button class="ta-btn" data-action="prompt-inspect">查看完整 Prompt</button>'
      : ''
      + (!activity && turn.phase !== 'commentary' ? '<button class="ta-btn" data-action="regen" title="先查看待重发正文">重新生成…</button>' : '');
  return copy + '<details class="card-actions-menu"><summary class="card-actions-more" aria-label="更多消息操作">更多</summary>'
    + '<div class="card-actions-popover">' + multi + secondary + '</div></details>';
}

function confirmCardResend({ text, sessionLabel }) {
  return new Promise(resolve => {
    const modal = detailControls.dialog('查看待重发正文');
    const target = doc.createElement('p'), input = doc.createElement('textarea'), note = doc.createElement('p');
    target.textContent = '目标会话：' + sessionLabel;
    input.value = text; input.readOnly = true; input.setAttribute('aria-label', '待重发正文');
    note.textContent = '这是当前入口实际将发送的正文。只重发正文，不包含历史附件；不会仅重做某一条进展。';
    note.className = 'card-detail-image-source';
    const submit = doc.createElement('button'); submit.type = 'button'; submit.textContent = '按此正文重发';
    submit.className = 'card-resend-confirm';
    submit.addEventListener('click', () => { resolve(true); modal.close(); }, { once: true });
    modal.addEventListener('close', () => resolve(false), { once: true });
    modal.append(target, input, note, submit); modal.showModal();
  });
}

function renderTurnCard(turn) {
  // turn = { id, role: 'user'|'assistant', text, ts, model?, kind?, toolCalls? }
  const isUser = turn.role === 'user';
  const isSimple = turn.simpleChat === true;
  const isProgress = !isUser && turn.phase === 'commentary';
  // inherited = 从父会话补进来的「分支前」对话（见 core/branch-transcript-inheritance.js）。
  const cls = (isUser ? 'turn-card user' : 'turn-card assistant') + (turn.inherited ? ' inherited' : '');
  const who = isUser ? '用户' : (turn.model || (turn.source==='acp' ? require('../core/ai-kinds').getKindLabel(turn.kind) : turn.kind) || 'Claude');
  const ts = turn.ts ? formatAbsoluteTime(turn.ts) : '';

  // 头像分支
  let avatarHtml;
  if (isUser) {
    avatarHtml = `<span class="turn-avatar av-logo av-user"><img src="${USER_AVATAR_SRC}" alt="用户 · AI Hub"></span>`;
  } else {
    const logo = chatAvatarSrc(turn.kind, { assistant: turn.assistantIdentity });
    avatarHtml = logo
      ? `<span class="turn-avatar av-logo ${turn.assistantIdentity ? 'av-assistant' : 'av-character'}"><img src="${logo}" alt="${turn.assistantIdentity ? '企鹅助理' : escapeHtml(turn.kind || 'AI')}"></span>`
      : `<span class="turn-avatar av-letter">${escapeHtml(aiLetterFallback(turn.kind))}</span>`;
  }

  const emptyNative = !turn.text && ({completed:'本轮已完成，没有回答正文',interrupted:'本轮已中断',failed:'本轮执行失败'})[turn.nativeOutcome];
  // An engine-initiated turn (channel input, scheduled task) that could not
  // continue an earlier card is marked in the head, not above the body: the
  // body reads like every other answer, matching Codex's card density.
  const nativeChip = turn.nativeActivity && !isProgress
    ? `<span class="turn-branch-chip turn-native-chip" title="Claude 自行发起的回合${turn.nativeOrigin?.kind ? '：' + escapeHtml(turn.nativeOrigin.kind) : ''}">后台</span>` : '';
  const body = (isProgress && !isSimple ? require('./conversation-message-view').renderProgressRow(turn,
    {escapeHtml,renderMarkdown:renderMarkdownPreservingLocalPaths,actions:renderCardActions(turn)})
    : emptyNative ? `<span class="turn-native-outcome">${escapeHtml(emptyNative)}</span>`
    : require('./conversation-message-view').renderMessageBody(turn.assistantContext?.userText ?? turn.text,
      {isUser,escapeHtml,renderMarkdown:renderMarkdownPreservingLocalPaths}));
  const attachments = isUser ? renderImageAttachments(turn.attachments, { escapeHtml, cwd: turn.attachmentCwd }) : '';
  const assistantContext = isUser && turn.assistantContext
    ? `<details class="assistant-turn-context"><summary>本轮请求 · 查看原生提交内容</summary><pre>${escapeHtml(turn.assistantContext.rawText)}</pre></details>` : '';
  const presentation = turn.presentation || buildTurnPresentation(turn);
  // 活动轨保留原 tc-cluster class 兼容现有交互/样式，同时增加显式 lifecycle。
  const toolHtml = renderToolCluster(turn.id || '', _fullActivityTurns.has(turn.id) ? turn.toolCalls : presentation.activities, presentation.activityCount);
  const deliveryHtml = !isUser && turn.phase !== 'commentary' && turn.phase !== 'activity' ? renderDeliverySummary(presentation.delivery) : '';
  const glanceHtml = deliveryHtml && !isSimple ? renderDeliveryGlance(presentation.delivery) : '';
  const bodyHtml = `<div class="turn-body${isProgress && !isSimple ? ' conversation-progress-row' : ''}${turn.text || emptyNative ? '' : ' turn-body-empty'}">${body}</div>
      ${attachments}
      ${assistantContext}
      ${isUser && turn.promptReceipt ? `<div class="turn-prompt-receipt" role="status">${escapeHtml(turn.promptReceipt)}</div>` : ''}`;
  const primaryHtml = !isUser && !isProgress && turn.phase !== 'activity'
    ? `<div class="turn-primary${glanceHtml ? ' has-glance' : ''}"><div class="turn-primary-copy">${bodyHtml}</div>${glanceHtml}</div>`
    : bodyHtml;

  // === Spec 2 · S8: thinking 字段 (assistant only, default collapsed) ===
  // S1 parser exposes turn.thinking as multi-block joined string (or null).
  // Render as <details> ABOVE main body — chronologically thinking precedes the answer.
  // Only attached for assistant role with non-empty string; user turns never carry thinking.
  let thinkingHtml = '';
  if (!isUser && typeof turn.thinking === 'string' && turn.thinking.length > 0) {
    const thinkingBody = renderMarkdownPreservingLocalPaths(turn.thinking);
    // Long thinking (>5KB): summary shows first-200-char preview (HTML-escaped, newlines→space)
    let summaryLabel = '💭 思考过程';
    if (turn.thinking.length > 5120) {
      const previewRaw = turn.thinking.slice(0, 200).replace(/\s+/g, ' ').trim();
      summaryLabel = `💭 思考过程 (前 200 字符: ${escapeHtml(previewRaw)}…)`;
    }
    thinkingHtml = `<details class="turn-thinking">
        <summary class="turn-thinking-summary">${summaryLabel}</summary>
        <div class="turn-thinking-body">${thinkingBody}</div>
      </details>`;
  }

  const progressMessages = turn.chatProcessMessages || [];
  const progressHtml = isSimple && progressMessages.length
    ? require('./conversation-message-view').renderMessageSequence(progressMessages,
      { escapeHtml, renderMarkdown: renderMarkdownPreservingLocalPaths, foldLong: true }) : '';
  const processCount = progressMessages.length + Number(presentation.activityCount || 0);
  // The activity preview shows only the latest items; warnings count the full reply.
  const processFailures = (turn.toolCalls || []).map(normalizeToolActivity).filter(a => a.status === 'failed' || a.isError === true).length;
  const processHtml = isSimple && (progressHtml || thinkingHtml || toolHtml || (!isUser && _renderMetaPills(turn)))
    ? `<details class="chat-process" data-copy-exclude><summary title="展开本轮完整过程、工具结果与用量">过程${processCount ? ` ${processCount} 条` : ''}${processFailures ? `<span class="chat-process-warning"> · ${processFailures} 项失败</span>` : ''}</summary><div class="chat-process-body">${progressHtml}${thinkingHtml}${toolHtml}${_renderMetaPills(turn)}</div></details>` : '';

  return `<div class="${cls}"${isSimple ? ' data-chat-style="message"' : ''}${isUser && turn.promptReceipt ? ` data-submission-id="${escapeHtml(turn.clientSubmissionId)}" data-receipt-authoritative="${turn.receiptAuthoritative === true}" data-delivery-status="${escapeHtml(turn.deliveryStatus || '')}"` : ''} data-turn-id="${escapeHtml(turn.id || '')}" data-response-id="${escapeHtml(turn.logicalTurnId || '')}" data-response-agent="${escapeHtml(turn.kind || '')}" data-phase="${escapeHtml(turn.phase || 'message')}" data-presentation-source="${escapeHtml(presentation.source || 'deterministic')}"${turn.inherited ? ' data-inherited="1"' : ''}>
    ${avatarHtml}
    <div class="turn-content">
      <div class="turn-head">
        <span class="turn-who">${escapeHtml(who)}</span>
        ${!isUser && turn.phase ? `<span class="conversation-phase">${turn.phase === 'final_answer' ? '结果' : turn.phase === 'commentary' ? '进展' : turn.phase === 'activity' ? '活动记录' : '消息'}</span>` : ''}
        ${!isUser && !isSimple ? require('./conversation-header-activity').renderHeaderActivity('', '', true) : ''}
        ${turn.inherited ? '<span class="turn-branch-chip" title="分支前的对话，继承自父会话">分支前</span>' : ''}${nativeChip}
        <span class="turn-meta">${escapeHtml(ts)}</span>
        ${!isUser ? renderTurnSpeed(turn) : ''}
        ${isSimple && isUser ? _renderMetaPills(turn, true) : ''}
        ${processHtml}
        <div class="turn-actions">
          ${isProgress && !isSimple ? '<button class="conversation-response-copy" data-action="conversation-response-copy" title="复制本轮当前已收到的完整回复">复制本轮</button>' : renderCardActions(turn)}
        </div>
      </div>
      ${isSimple ? `<div class="chat-message-bubble">${primaryHtml}${deliveryHtml}</div>` : `${thinkingHtml}${primaryHtml}${deliveryHtml}${toolHtml}${_renderMetaPills(turn)}`}
    </div>
  </div>`;
  // 2026-06-28 maintainer · 深空灰气泡皮肤：气泡背景挂在 .turn-body 上，故把工具簇与 meta-pills
  //   移到 .turn-body 之后（气泡下方）——气泡只含对话正文，工具/徽章作为附属信息独立成行，
  //   同时让长文本折叠只作用于正文（不再连带折叠工具簇）。所有渲染路径都走整卡重渲染，无冲突。
}
if (!options.root) win._renderTurnCard = renderTurnCard;

// === Spec 1 v0.9.0 · 代码块强化 (D2) ===
let _codeFoldThreshold = 30;
const _foldedCodesState = new Map();
const _bodyFoldState = new Map(); // turnId -> true(expanded) / false(folded)
const _turnRenderSigs = new Map(); // turnId -> compact content signature

function postProcessCardMath(cardEl) {
  if (!cardEl || !renderMathInElement) return false;
  const body = cardEl.querySelector('.turn-body');
  if (!body || body.dataset.mathRendered === 'true') return false;
  try {
    renderMathInElement(body, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false },
      ],
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
      ignoredClasses: ['katex', 'katex-display'],
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    });
    body.dataset.mathRendered = 'true';
    return true;
  } catch (error) {
    console.warn('[card-math] KaTeX render failed:', error && error.message);
    return false;
  }
}

function postProcessCardCodeBlocks(cardEl) {
  if (!cardEl) return;
  const blocks = cardEl.querySelectorAll('pre > code');
  blocks.forEach((code, idx) => {
    const pre = code.parentElement;
    // marked adds class="language-xx"; pull first language match
    const lang = (code.className.match(/language-(\w+)/) || [, ''])[1];
    // prism highlight (only if language plugin loaded)
    if (lang && win.Prism && win.Prism.languages[lang]) {
      try { code.innerHTML = win.Prism.highlight(code.textContent, win.Prism.languages[lang], lang); }
      catch {}
    }
    // wrap pre in .code-block-wrap, add Copy button + fold toggle if long
    const lines = code.textContent.split('\n').length;
    const turnId = cardEl.dataset.turnId || '';
    const codeKey = `${cardEl.dataset.sessionId || ''}:${turnId}:code:${idx}`;
    const expanded = _foldedCodesState.has(codeKey) ? _foldedCodesState.get(codeKey) : true;
    const wrap = doc.createElement('div');
    wrap.className = 'code-block-wrap';
    wrap.dataset.codeKey = codeKey;
    wrap.dataset.lang = lang || 'text';
    wrap.dataset.lines = lines;
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    // Copy button
    const copyBtn = doc.createElement('button');
    copyBtn.className = 'code-copy';
    copyBtn.textContent = '📋 Copy';
    copyBtn.dataset.action = 'code-copy';
    wrap.appendChild(copyBtn);
    // Fold toggle (long blocks)
    if (lines > _codeFoldThreshold && !expanded) {
      pre.style.display = 'none';
      const toggle = doc.createElement('div');
      toggle.className = 'code-toggle';
      toggle.dataset.action = 'code-expand';
      toggle.textContent = `▸ 展开 ${_codeFoldThreshold} of ${lines} 行 · ${lang || 'text'}`;
      wrap.appendChild(toggle);
    } else if (lines > _codeFoldThreshold) {
      const toggle = doc.createElement('div');
      toggle.className = 'code-toggle';
      toggle.dataset.action = 'code-collapse';
      toggle.textContent = `▾ 折叠 (${lines} 行)`;
      wrap.appendChild(toggle);
    }
  });
}

// === Spec 3 · 长 markdown 文本默认展开，保留用户主动折叠 ===
// Mount 后按正文高度提供折叠按钮；只在用户选择后添加 folded。
const _BODY_FOLD_THRESHOLD_PX = 400;
function postProcessLongTextFold(cardEl) {
  if (!cardEl) return;
  const body = cardEl.querySelector('.turn-body');
  if (!body) return;
  if (body.querySelector('.conversation-long-message')) return;
  // 已存在折叠按钮（rerender 路径） → 跳过
  if (cardEl.querySelector('.body-fold-toggle')) return;
  if (body.scrollHeight <= _BODY_FOLD_THRESHOLD_PX) return;
  const turnId = `${cardEl.dataset.sessionId || ''}:${cardEl.dataset.turnId || ''}`;
  const expanded = _bodyFoldState.get(turnId) !== false;
  body.classList.add('body-foldable');
  if (!expanded) body.classList.add('folded');
  const btn = doc.createElement('div');
  btn.className = 'body-fold-toggle';
  btn.dataset.action = expanded ? 'body-collapse' : 'body-expand';
  btn.textContent = expanded ? '▴ 折叠' : '▾ 展开全文';
  body.parentElement.insertBefore(btn, body.nextSibling);
}

// 全局 click handler: 长文本展开/折叠
listen('click', (e) => {
  if (!options.root && e.target.closest('[data-split-secondary]')) return;
  const btn = e.target.closest && e.target.closest('[data-action="body-expand"], [data-action="body-collapse"]');
  if (!btn) return;
  const card = btn.closest('.turn-card');
  if (!card) return;
  const body = card.querySelector('.turn-body');
  if (!body) return;
  const turnId = `${card.dataset.sessionId || ''}:${card.dataset.turnId || ''}`;
  if (btn.dataset.action === 'body-expand') {
    if (turnId) _bodyFoldState.set(turnId, true);
    body.classList.remove('folded');
    btn.dataset.action = 'body-collapse';
    btn.textContent = '▴ 折叠';
  } else {
    if (turnId) _bodyFoldState.set(turnId, false);
    body.classList.add('folded');
    btn.dataset.action = 'body-expand';
    btn.textContent = '▾ 展开全文';
  }
});

// === Spec 4 · 工具返回预览 (postProcessToolResults) ===
// _renderToolRow 已把有界预览放进 <pre data-result-raw>。这里做三件事：
//   1) JSON 自动检测：trim 后首字符是 { 或 [ 且 JSON.parse 成功 → 重排 + Prism 高亮
//   2) >2KB 加 is-folded class（CSS 控制 max-height + 渐变），toolbar 注入"展开全部"按钮
//   3) 已处理过的 <pre> 用 data-tc-processed=1 防重入（rerender 路径会重跑）
const _TOOL_RESULT_FOLD_THRESHOLD = 2048;
function postProcessToolResults(cardEl) {
  if (!cardEl) return;
  const pres = cardEl.querySelectorAll('pre.tc-result[data-result-raw]');
  pres.forEach((pre) => {
    if (pre.dataset.tcProcessed === '1') return;
    pre.dataset.tcProcessed = '1';
    const raw = pre.textContent;
    // JSON 检测：避免对纯文本/HTML/log 做无意义解析
    const lead = raw.trimStart()[0];
    if ((lead === '{' || lead === '[') && raw.length < _TOOL_RESULT_HARD_LIMIT) {
      try {
        const parsed = JSON.parse(raw.trim());
        const formatted = JSON.stringify(parsed, null, 2);
        if (win.Prism && win.Prism.languages && win.Prism.languages.json) {
          pre.innerHTML = win.Prism.highlight(formatted, win.Prism.languages.json, 'json');
        } else {
          pre.textContent = formatted;
        }
        pre.classList.add('is-json');
      } catch {
        // 不是合法 JSON（如 mcp 错误回包是 JSON 头但坏掉）→ 保留原文
      }
    }
    // 长内容折叠 — 走 dataset 里 <details> 的真实长度，比 textContent.length 准
    // （Prism 高亮后 innerHTML 多了 span tag，但 textContent 仍是纯文本所以也对，留 dataset 兜底）
    const details = pre.closest('.tc-row-with-result');
    const lenBytes = details ? parseInt(details.dataset.toolResultLen || '0', 10) : raw.length;
    if (lenBytes > _TOOL_RESULT_FOLD_THRESHOLD) {
      pre.classList.add('tc-result-foldable', 'is-folded');
      const toolbar = pre.parentElement && pre.parentElement.querySelector('.tc-result-toolbar');
      if (toolbar && !toolbar.querySelector('.tc-result-expand')) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'tc-result-expand';
        btn.dataset.action = 'tc-toggle-fold';
        btn.textContent = lenBytes > _TOOL_RESULT_HARD_LIMIT ? '展开预览' : '展开输出';
        btn.title = '展开/折叠当前预览';
        toolbar.appendChild(btn);
      }
    }
  });
}

// 全局 click handler: 👁 预览 toggle + 复制全文 + 展开/折叠超长
listen('click', (e) => {
  if (!options.root && e.target.closest('[data-split-secondary]')) return;
  const t = e.target;
  if (!t || !t.closest) return;

  // [1] 👁 预览按钮：toggle 父 <details>（按钮自身阻止冒泡防止"双重 toggle"）
  const previewBtn = t.closest('[data-action="tc-toggle-preview"]');
  if (previewBtn) {
    e.preventDefault();
    e.stopPropagation();
    const details = previewBtn.closest('details.tc-row-with-result');
    if (details) {
      details.open = !details.open;
      previewBtn.textContent = details.open ? '👁 收起' : '👁 预览';
    }
    return;
  }

  // Complete results are copied by card-detail-controls from their source.
  const allButton = t.closest('[data-action="tc-show-all"]');
  if (allButton) {
    e.preventDefault();
    const turnId = allButton.closest('[data-turn]')?.dataset.turn || allButton.closest('.turn-card')?.dataset.turnId;
    if (turnId) {
      _fullActivityTurns.add(turnId);
      rerenderTurn(turnId);
    }
    return;
  }

  // [3] ⏷ 展开/折叠超长 result
  const foldBtn = t.closest('[data-action="tc-toggle-fold"]');
  if (foldBtn) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = foldBtn.closest('.tc-result-wrap');
    const pre = wrap && wrap.querySelector('pre.tc-result');
    const details = foldBtn.closest('.tc-row-with-result');
    if (pre && details) {
      const folded = pre.classList.toggle('is-folded');
      const lenBytes = parseInt(details.dataset.toolResultLen || '0', 10);
      foldBtn.textContent = folded ? (lenBytes > _TOOL_RESULT_HARD_LIMIT ? '展开预览' : '展开输出') : '折叠预览';
    }
    return;
  }
});

function mountTurnCard(container, turn) {
  turn = prepareTurnForRender(getActiveSessionId(), turn);
  const tmp = doc.createElement('div');
  tmp.innerHTML = renderTurnCard(turn);
  const cardEl = tmp.firstElementChild;
  container.insertBefore(cardEl, container.querySelector(':scope > .streaming-indicator'));
  if (turn.id) state._sessionTurns.set(turn.id, turn);
  _postProcessTurnCard(cardEl, getActiveSessionId());
  publishTurnPresentation(getActiveSessionId(), turn);
  return cardEl;
}
if (!options.root) win._mountTurnCard = mountTurnCard;

// === Spec 2 · S4: mountSessionTurnCard ===
// Mount a single Turn (from S1 parseClaudeTranscriptToTurns) as a card into #msg-overlay.
//
// Used by:
//   - S5 loadSessionHistoryToOverlay      — batch mount on session switch
//   - S6 turn-complete-event listener     — append on new assistant turn
//
// Boundary adapters / contract notes:
//   * renderTurnCard (line ~1630) accepts { id, role, text, ts, model?, kind?,
//     slotPokemon?, toolCalls? } and ignores unknown fields. S1 turns may
//     additionally carry { thinking, stopReason, usage } — those are passed
//     through harmlessly until S8 adds thinking rendering inside renderTurnCard.
//   * state._sessionTurns: spec1 stores raw `turn` objects (not wrapped),
//     because rerenderTurn (line ~1593) and getTurnFromCard (line ~1758) both
//     do `_sessionTurns.get(turnId)` and use the result as a turn directly.
//     Wrapping it in `{ sessionId, turn, element }` here would break those
//     button handlers. Instead we keep the Map shape (turnId → turn), and
//     stash sessionId on the DOM via cardEl.dataset.sessionId so future
//     per-session cleanup can find cards by sessionId without changing the
//     Map contract. The `element` is recoverable via
//     `doc.querySelector('.turn-card[data-turn-id="…"]')` (used by
//     rerenderTurn already).
// 2026-05-06 maintainer 重做 b54a3b6（原 fix 在 fix/card-overlay-scroll-lock 分支没合上 master）+
// Codex 多方审查补漏：chat UI 标准 scroll-respect-user 模式 — 仅当用户在底部 50px
// 容差内才自动跟随,否则尊重用户向上翻历史的意图。此 helper 守护三处:
//   (1) mountSessionTurnCard 的 opts.autoScroll(turn-complete-event 路径会传 true)
//   (2) _updateStreamingIndicator 创建"还在生成更多回复…"indicator 时
//   (3) loadSessionHistoryToOverlay 末尾的 batch scrollIntoView (Codex 发现):
//       incremental=true throttle 反复触发时不应拍底;incremental=false 切 session
//       时 container 已 innerHTML='' → helper 自然 true → 初次加载行为不退化
function _isCardOverlayAtBottom(el) {
  if (el?._cardFollowController) return el._cardFollowController.isFollowing();
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < 50;
}

// optimistic user-card：用户在 floating-input 按 Enter 后立即 mount 一张 user 气泡卡。
//   不等 transcript 写盘 + 250ms throttle reload —— 后者经实测 user entry 写盘滞后 1-3s
//   （Claude CLI 等到 LLM call 启动才 append），用户视感 "气泡 5s 才出来"。
//   待真 user turn 从 transcript 解析进来时（mountSessionTurnCard 顶部的 dedup），扫一眼
//   现存 optimistic 卡片，文本匹配的删掉。turn.id 用 'pending-user-' 前缀的临时 id，
//   不进 _sessionTurns Map（不是权威 turn，避免被当作真 turn dedup-replace 链路对象）。
function mountOptimisticUserCard(sessionId, text, kind, options = {}) {
  const container = overlay();
  if (!container) return null;
  // 隐藏 placeholder 而非删除 — 后续 turn-complete-event / applyViewMode
  // 仍需通过 _cardHistoryHydratedSid 判是否需要全量重载，但保留 DOM 节点做 fallback
  const placeholder = container.querySelector('.msg-overlay-placeholder');
  if (placeholder) placeholder.style.display = 'none';

  const optimisticId = 'pending-user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const turn = prepareTurnForRender(sessionId, { id: optimisticId, role: 'user', text, ts: Date.now(), kind,
    clientSubmissionId: options.clientSubmissionId });
  let cardEl;
  try {
    const tmp = doc.createElement('div');
    tmp.innerHTML = renderTurnCard(turn);
    cardEl = tmp.firstElementChild;
  } catch (err) {
    console.warn('[mountOptimisticUserCard] renderTurnCard threw:', err);
    return null;
  }
  if (!cardEl) return null;
  cardEl.dataset.sessionId = String(sessionId || '');
  cardEl.dataset.optimistic = 'true';
  cardEl.dataset.optimisticText = text;
  if (options.clientSubmissionId) cardEl.dataset.clientSubmissionId = options.clientSubmissionId;
  cardEl.dataset.submittedAt = String(turn.ts);

  // 插在 streaming-indicator 之前（与 mountSessionTurnCard 一致），保证位置正确
  // 2026-05-24：必须用 `:scope > .streaming-indicator` 限定为 container 直接子。
  // 否则 W15 v2 把 indicator 迁进 turn-card.turn-head 后，querySelector 递归到嵌套
  // 节点 → insertBefore 撞 ref 非直接子节点抛 NotFoundError → mount 链路被静默吞掉。
  const streamingTail = container.querySelector(':scope > .streaming-indicator');
  if (streamingTail) container.insertBefore(cardEl, streamingTail);
  else container.appendChild(cardEl);
  postProcessCardMath(cardEl);
  if (updateStreamingIndicator) updateStreamingIndicator(sessionId);

  // 用户主动发了一条消息 → 一定希望看到自己刚发的气泡；不走 _wasAtBottom 守卫
  if (container._cardFollowController) {
    container._cardFollowController.follow();
    return cardEl;
  }
  try {
    cardEl.scrollIntoView({ behavior: 'auto', block: 'end' });
  } catch {
    container.scrollTop = container.scrollHeight;
  }
  // `scrollIntoView` can target an outer ancestor while the absolute card
  // overlay is still being laid out. A user-authored send is an explicit jump
  // to the newest question, so pin the actual overlay now and for two frames;
  // this also survives the streaming-chip move and optimistic-card styling.
  const pinToNewestQuestion = () => { container.scrollTop = container.scrollHeight; };
  pinToNewestQuestion();
  const raf = win && typeof win.requestAnimationFrame === 'function'
    ? win.requestAnimationFrame.bind(win)
    : (callback) => setTimeout(callback, 0);
  raf(() => {
    pinToNewestQuestion();
    raf(pinToNewestQuestion);
  });
  return cardEl;
}
if (!options.root) win._mountOptimisticUserCard = mountOptimisticUserCard;

function turnRenderSignature(turn) {
  if (!turn) return '';
  const raw = JSON.stringify({
    role: turn.role || '',
    logicalTurnId: turn.logicalTurnId || '',
    phase: turn.phase || '',
    attachments: turn.attachments || null,
    attachmentCwd: turn.attachmentCwd || null,
    deliveryContext: turn.deliveryContext || null,
    nativeOutcome: turn.nativeOutcome || null,
    text: turn.text || '',
    ts: turn.ts || null,
    model: turn.model || '',
    kind: turn.kind || '',
    thinking: turn.thinking || '',
    stopReason: turn.stopReason || '',
    durationMs: turn.durationMs || null,
    tsEnd: turn.tsEnd || null,
    toolCalls: Array.isArray(turn.toolCalls) ? turn.toolCalls : [],
    usage: turn.usage || null,
    turnSpeed: turn.turnSpeed || null,
    promptReceipt: turn.promptReceipt || '',
    chatProcessMessages: turn.chatProcessMessages || null,
  });
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${raw.length}:${hash >>> 0}`;
}

function mountSessionTurnCard(sessionId, turn, opts = {}) {
  if (turn && Array.isArray(turn.displayMessages)) {
    let last = null;
    for (const message of require('./simple-chat-display').displayChatTurns([turn])) {
      last = mountSessionTurnCard(sessionId, message, opts) || last;
    }
    return last;
  }
  // 1. validate inputs
  if (!turn || !turn.id || !turn.role) {
    console.warn('[mountSessionTurnCard] invalid turn (missing id/role):', turn);
    return null;
  }
  turn = prepareTurnForRender(sessionId, turn, opts);
  // 2. resolve container
  const container = opts.container || overlay();
  if (!container) {
    console.warn('[mountSessionTurnCard] container not found (msg-overlay missing)');
    return null;
  }
  // defensive init (spec1 also does this at line ~1545, but be paranoid)
  if (!state._sessionTurns) state._sessionTurns = new Map();

  // optimistic user-card dedup：真 user turn 从 transcript 进来时，扫现存
  //   optimistic 占位卡，文本相同则删掉（让真卡片接替）。trim 比较两端容差。
  if (turn.role === 'user' && !container.querySelector(`.turn-card[data-turn-id="${cssEscape(turn.id)}"]`)) {
    const sidStr = String(sessionId || '');
    const realText = (turn.text || '').trim();
    if (realText) {
      const opts2 = container.querySelectorAll('.turn-card.user[data-optimistic="true"]');
      const normalize = require('../core/conversation-display').userTextIdentity;
      const candidates = Array.from(opts2).filter(opt => {
        if (opt.dataset.sessionId !== sidStr) return false;
        if (turn.clientSubmissionId || opt.dataset.clientSubmissionId) return turn.clientSubmissionId === opt.dataset.clientSubmissionId;
        const sentAt = Number(opt.dataset.submittedAt);
        return (!sentAt || (Number(turn.ts) >= sentAt - 1000))
          && normalize(opt.dataset.optimisticText) === normalize(realText);
      });
      // One receipt claims one placeholder, never every repeated prompt.
      if (candidates[0]) candidates[0].remove();
    }
  }

  // provisional assistant-card dedup：turn-complete 时 transcript 常常还没落盘，
  //   renderer 会先用合成 id（turn-<时间戳>）挂一张兜底卡。随后的 backfill 用真实
  //   id 再挂一次，两个 id 不同 → 同一条回答重复出现。真卡到达时把兜底卡撤掉。
  //   文本用「前缀匹配」而非全等：兜底卡的文本来自 turn-complete 事件的纯文本，
  //   真卡是结构化解析（可能多出工具调用等），两者不会逐字相同。
  if (turn.role === 'assistant') {
    const sidStr = String(sessionId || '');
    const realText = (turn.text || '').trim();
    container.querySelectorAll('.turn-card.assistant[data-provisional="true"]').forEach(prov => {
      if (prov.dataset.sessionId !== sidStr) return;
      if (prov.dataset.turnId === turn.id) return;   // 就是它自己，别自杀
      const provText = (prov.dataset.provisionalText || '').trim();
      if (!provText) { prov.remove(); return; }
      if (!realText) return;
      const a = provText.slice(0, 200);
      const b = realText.slice(0, 200);
      if (a === b || realText.startsWith(provText) || provText.startsWith(realText)) prov.remove();
    });
  }

  // dedup with in-place patch：同 turnId 已在 DOM 时，不是 skip，而是在同一根节点内更新。
  // 原因：W5 后一个 logical turn 包含多个 raw entries，streaming 新 entry 合并进来时
  // turn.id 不变（取首条 entry uuid）但内容已变（toolCalls 多了 / text 长了 / tsEnd 变 /
  // mergedCount 增加）。skip 会让用户看不到新工具调用；replace 让卡片 in-place 更新。
  // 这样展开态、选区、滚动意图与绑定在根节点上的 UI 状态都能保留。
  const existing = container.querySelector(`.turn-card[data-turn-id="${cssEscape(turn.id)}"]`);
  if (existing) {
    const turnForRender2 = (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn;
    const prevTurn = state._sessionTurns.get(turn.id);
    const prevSig = _turnRenderSigs.get(turn.id) || turnRenderSignature(prevTurn);
    const nextSig = turnRenderSignature(turnForRender2);
    if (prevSig === nextSig) {
      state._sessionTurns.set(turn.id, turnForRender2);
      _turnRenderSigs.set(turn.id, nextSig);
      publishTurnPresentation(sessionId, turnForRender2);
      if (typeof updateStreamingIndicator === 'function') updateStreamingIndicator(sessionId);
      return existing;
    }
    let newCard = null;
    try {
      const tmp2 = doc.createElement('div');
      tmp2.innerHTML = renderTurnCard(turnForRender2);
      newCard = tmp2.firstElementChild;
    } catch (err) {
      console.warn('[mountSessionTurnCard replace] renderTurnCard threw:', err);
      return null;
    }
    if (!newCard) return null;
    const patchedCard = patchTurnCardInPlace(existing, newCard, sessionId);
    if (!patchedCard) return null;
    state._sessionTurns.set(turn.id, (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn);
    _turnRenderSigs.set(turn.id, nextSig);
    publishTurnPresentation(sessionId, turnForRender2);
    return patchedCard;
  }

  // 3. merge kind through to renderTurnCard without mutating caller's turn
  const turnForRender = (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn;

  // 4. build wrapper element from HTML string
  let cardEl = null;
  try {
    const tmp = doc.createElement('div');
    tmp.innerHTML = renderTurnCard(turnForRender);
    cardEl = tmp.firstElementChild;
  } catch (err) {
    console.warn('[mountSessionTurnCard] renderTurnCard threw:', err);
    return null;
  }
  if (!cardEl) {
    console.warn('[mountSessionTurnCard] renderTurnCard produced empty HTML for turn', turn.id);
    return null;
  }

  // multi-session safety: tag the DOM with sessionId for per-session cleanup
  cardEl.dataset.sessionId = String(sessionId || '');

  // 5. insert into container — Spec 3 W16：streaming indicator 必须在末尾，
  // 所以新卡插在 indicator 之前（如果存在）
  // 2026-05-06 maintainer scroll-respect-user：append 前先记录用户是否在底部,给 step 9 用
  // 2026-05-24：必须用 `:scope > .streaming-indicator` 限定为 container 直接子。
  // W15 v2 (_updateStreamingIndicator) 把 indicator 迁进 turn-card.turn-head 后，
  // 普通 querySelector 会递归命中嵌套节点 → insertBefore 撞 ref 非直接子抛
  // NotFoundError → for 循环中断后续 turn 全丢，外层 .catch 静默吞。
  const _wasAtBottom = _isCardOverlayAtBottom(container);
  const _streamingTail = container.querySelector(':scope > .streaming-indicator');
  if (_streamingTail) {
    container.insertBefore(cardEl, _streamingTail);
  } else {
    container.appendChild(cardEl);
  }

  // 6-7. Shared post processing. Keeping this in one function ensures new
  // cards and in-place streaming patches receive identical behavior.
  _postProcessTurnCard(cardEl, sessionId);

  // 8. register in _sessionTurns (turnId → turn) — keep spec1 Map shape
  // Use turnForRender (kind merged) so rerenderTurn won't lose kind on fold/unfold
  state._sessionTurns.set(turn.id, turnForRender);
  _turnRenderSigs.set(turn.id, turnRenderSignature(turnForRender));
  publishTurnPresentation(sessionId, turnForRender);

  // 9. autoScroll — 2026-05-06 maintainer scroll-respect-user:仅当用户原本在底部时才滚
  //   (向上翻历史时不打断,避免被新 turn 拍回底部)
  if (opts.autoScroll && _wasAtBottom) {
    if (container._cardFollowController) container._cardFollowController.request();
    else try {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } catch {
      // older browsers without smooth-scroll options: fall back to plain scroll
      container.scrollTop = container.scrollHeight;
    }
  }

  // Spec 3 · W16：cardCount 变化 → indicator 文案需切（"正在思考"→"还在生成更多"）
  if (typeof updateStreamingIndicator === 'function') updateStreamingIndicator(sessionId);

  // 10. return cardEl
  return cardEl;
}
if (!options.root) win._mountSessionTurnCard = mountSessionTurnCard;


// click handler — code-copy + code-expand/collapse
listen('click', (e) => {
  if (!options.root && e.target.closest('[data-split-secondary]')) return;
  const responseCopy = e.target.closest('[data-action="conversation-response-copy"]');
  if (responseCopy) {
    e.preventDefault();e.stopPropagation();
    const text=require('./conversation-message-view').responseCards(responseCopy.closest('.turn-card'))
      .filter(card=>card.dataset.phase!=='activity')
      .map(card=>require('./visible-card-text').extractVisibleCardText(card.querySelector('.turn-body'))).filter(Boolean).join('\n\n');
    Promise.resolve(clipboardApi.writeText(text)).then(()=>{responseCopy.textContent='已复制';})
      .catch(error=>{responseCopy.textContent='复制失败';console.warn('[conversation-response-copy]',error);});
    return;
  }
  const messageCopy = e.target.closest('[data-action="conversation-copy"]');
  if(messageCopy) {
    e.preventDefault();e.stopPropagation();
    const text=require('./visible-card-text').extractVisibleCardText(messageCopy.closest('.conversation-entry'));
    Promise.resolve(clipboardApi.writeText(text)).then(()=>{messageCopy.textContent='已复制';})
      .catch(error=>{messageCopy.textContent='复制失败';console.warn('[conversation-copy]',error);});
    return;
  }
  const copyBtn = e.target.closest('[data-action="code-copy"]');
  if (copyBtn) {
    const code = copyBtn.parentElement.querySelector('pre code');
    if (code) {
      Promise.resolve(clipboardApi.writeText(code.textContent)).then(() => {
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => copyBtn.textContent = '📋 Copy', 1500);
      }).catch(error => { copyBtn.textContent = '复制失败'; console.warn('[code-copy]', error); });
    }
    return;
  }
  const toggleBtn = e.target.closest('[data-action="code-expand"], [data-action="code-collapse"]');
  if (toggleBtn) {
    const wrap = toggleBtn.closest('.code-block-wrap');
    const key = wrap.dataset.codeKey;
    const want = toggleBtn.dataset.action === 'code-expand';
    _foldedCodesState.set(key, want);
    const pre = wrap.querySelector('pre');
    pre.style.display = want ? '' : 'none';
    if (want) {
      toggleBtn.dataset.action = 'code-collapse';
      toggleBtn.textContent = `▾ 折叠 (${wrap.dataset.lines} 行)`;
    } else {
      toggleBtn.dataset.action = 'code-expand';
      toggleBtn.textContent = `▸ 展开 ${_codeFoldThreshold} of ${wrap.dataset.lines} 行 · ${wrap.dataset.lang}`;
    }
  }
});



  function setCodeFoldThreshold(value) {
    if (typeof value === 'number' && !Number.isNaN(value)) _codeFoldThreshold = value;
  }

  function clearTurnRenderSignatures() {
    _turnRenderSigs.clear();
    _fullActivityTurns.clear();
  }

  return {
    // Search owns a detached read-only view. Never register these historical
    // cards in _sessionTurns or install resend/regen/company actions.
    renderReadOnlyCard(turn) {
      const root = doc.createElement('div');
      root.innerHTML = renderTurnCard({ ...turn, id: `search-preview-${turn.id || ''}` });
      root.querySelectorAll('.turn-actions, [data-action]').forEach(node => {
        if (node.classList.contains('conversation-image-thumb')) { node.removeAttribute('data-action'); node.disabled = true; }
        else node.remove();
      });
      root.querySelectorAll('[data-turn-id]').forEach(node => {
        node.removeAttribute('data-turn-id');
        node.dataset.searchReadonly = 'true';
      });
      postProcessCardMath(root);
      return root;
    },
    dispose() { for (const [type, handler] of listeners) root.removeEventListener(type, handler); detailControls.dispose(); },
    renderToolCluster,
    confirmCardResend,
    renderTurnCard,
    rerenderTurn,
    postProcessCardCodeBlocks,
    postProcessCardMath,
    postProcessLongTextFold,
    postProcessToolResults,
    mountTurnCard,
    isCardOverlayAtBottom: _isCardOverlayAtBottom,
    mountOptimisticUserCard,
    turnRenderSignature,
    mountSessionTurnCard,
    setCodeFoldThreshold,
    clearTurnRenderSignatures,
  };
}

module.exports = { createTurnCardRenderer };
