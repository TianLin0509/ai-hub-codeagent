'use strict';
// 群聊 CLI ready 判定（2026-05-03 maintainer精测重构）
//
// 抽离动机：原 cli-ready 判定逻辑内联在 main.js 中，但本质是群聊专属功能
//   （非群聊会话不需要"启动期检测"），混在 main.js 里跟其他 IPC/启动逻辑纠缠。
//   独立模块后 main.js 只管 IPC 转发 + sessionManager 桥接。
//
// 判定模型（双门 + monotonic guard）：
//   - 必要条件 1：PTY buffer 末尾含 kind 对应的 marker 字符串
//     （Claude Code 输入框就绪后才出现的状态栏字串如 'shift+tab'）
//   - 必要条件 2：PTY buffer 总长 ≥ MIN_BUF_LEN，且连续 STABLE_MS 无新增
//     （TUI 屏幕真稳定，OAuth/初始化已完成）
//   - 一旦判 true → 加入 onceTrue Set 永久锁，防 PTY 心跳/光标重绘触发回退
//
// Historical 3-Claude debug design notes were removed during slimdown.

// kind → marker 字符串数组。空数组表示 "无 marker，仅靠 buffer 静默兜底"。
const MARKERS = {
  // Claude Code TUI 输入框就绪后状态栏稳定含 'shift+tab to cycle' 字符串
  // Newer Claude-family TUI can render
  // "? for shortcuts" without the old shift+tab footer in the ring buffer.
  // 2.1.28x 的底栏是 "manual mode on · ← for agents" / "bypass permissions on"，
  // 空输入框占位是 `Try "how does <filepath> work?"`（2026-09-25 真机截图）。
  claude: ['shift+tab', '? for shortcuts', 'bypass permissions', 'Try "', 'mode on', 'for agents'],
  gemini: ['Type your message', 'YOLO', 'gemini-'],
  // Do not use model ids such as "gpt-5.6-sol" here: the PowerShell launch
  // command itself contains "--model gpt-5.6-sol", which can falsely mark Codex
  // ready before the TUI input box exists.
  // 0.153 新会话的底栏不再有 "Context N% left"（首轮之后才出现），输入行是
  // `› <占位建议>`。选项菜单也用 `› 1. …`，所以提示符后面跟「数字.」的不算。
  // 0.159.3 may position the first input row with cursor moves and no LF.
  // This native placeholder survives ConPTY stripping; launch args never contain it.
  codex: ['Context ', 'Ask Codex to do anything', /(?:^|\n)\s*›\s+(?!\d+\.\s)\S/],
  deepseek: ['shift+tab', '? for shortcuts', 'bypass permissions', 'Try "edit'],
  // Kimi Code 官方 TUI 状态栏稳定显示小写 `context:`。不能设为强 marker：
  // 未登录启动也会短暂渲染状态栏，随后才显示 OAuth login expired。
  kimi: ['context:'],
  // 公司 Code Agent（opentui 界面，2026-10-08 公司实测录屏）：空闲输入框占位 "Anything I can assist you with?"，
  // 底栏 "Bypass (Cycle shift+tab) | <模型>"。保留 Claude 的标记，测试替身跑的是真 Claude 界面。
  codeagent: ['Anything I can assist you with', 'Cycle shift+tab', 'shift+tab', '? for shortcuts', 'bypass permissions', 'Try "', 'mode on', 'for agents'],
};

// 启动时的选择框（模型迁移提示、更新提示……）会把第一条粘贴吞掉，随后的回车还会
// 替用户选中默认项（2026-09-25 真机：GPT-5.5 退役提示被回车选成「换新模型」）。
// Claude 的 Chrome 扩展提示结尾是 "Enter to confirm · Esc to keep browser tools off"，
// 不是 "Esc to cancel"（2026-09-25 真机），所以只认前半句的固定结构。
const CHOICE_DIALOG_BLOCKERS = [/press enter to confirm/i, /Use ↑\/↓ to move/i, /Enter to confirm\s*[·|]\s*Esc to\b/i];

// Code Agent 的选择框底栏是 "Select ↑ ↓ | Confirm Enter | 退出 Esc"；未带 --disable-update 时启动即弹「版本更新提醒」。
const CODEAGENT_DIALOG_BLOCKERS = [/版本更新提醒/, /Quick safety check/i, /Confirm Enter\s*\|/i];

const BLOCKERS = {
  claude: [...CHOICE_DIALOG_BLOCKERS],
  codeagent: [...CODEAGENT_DIALOG_BLOCKERS, ...CHOICE_DIALOG_BLOCKERS],
  codex: [/Do you trust the contents of this directory/i, /Booting MCP server/i, /esc to interrupt/i, ...CHOICE_DIALOG_BLOCKERS],
  kimi: [
    /OAuth login expired/i,
    /No active session\. Send \/login to login/i,
    /requires login/i,
    /Run \/login or \/provider to get started/i,
    /Model:\s+not set/i,
  ],
};

// 可以「过期」的阻断词：它们描述的是**瞬态**——启动中、正在跑，会自己结束。
// PTY 是追加流、清屏只是控制序列，所以这两句会永远留在 buffer 里；
// 一旦输入框标记出现在它们之后，就说明那一段已经被新画面盖掉了，不该再算数。
//
// 其余阻断词（Kimi 未登录、Codex 的信任弹窗）是**终态**：它们不会自己好，
// 而且登录页上本来就同时渲染着状态栏 marker —— 用「谁更新」判会直接放行，所以不许过期。
const STALEABLE_BLOCKERS = {
  // 选择框答完就消失：之后出现的输入行标记说明它已被新画面盖掉。
  claude: [...CHOICE_DIALOG_BLOCKERS],
  codeagent: [...CODEAGENT_DIALOG_BLOCKERS, ...CHOICE_DIALOG_BLOCKERS],
  codex: [/Booting MCP server/i, /esc to interrupt/i, ...CHOICE_DIALOG_BLOCKERS],
};

// ConPTY 用光标右移（ESC[nC）代替单词间的空格，并夹着大量颜色 / 光标序列；
// 直接在原始字节上找 "manual mode on" 这类多词标记永远找不到。先还原成可读文字。
function terminalText(buf) {
  return String(buf || '')
    // Codex 0.159.3 paints its input at ESC[33;1H without a line feed.
    // Preserve that row boundary before stripping ANSI, so the input marker
    // cannot become attached to the preceding splash-screen artwork.
    .replace(/\x1b\[(?:\d+;)?1[Hf]/g, '\n')
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.min(Number(n) || 1, 200)))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r/g, '');
}

const MIN_BUF_LEN = 500;
const STABLE_MS = 1500;

// 2026-05-04 gemini-equiv Bug 1 修复：强 marker kind 跳过静默期。
//   gemini 0.40.1 Ink TUI 在 PTY 下持续重渲染（spinner / cursor blink / token 计数刷新），
//   buffer 长度持续变化 → 永远不进入 STABLE_MS 静默 → 卡片永久卡"创建中"。
//   gemini 的 marker（'Type your message' / 'YOLO' / 'gemini-'）只在主输入框就绪后
//   才出现，是已 ready 的强信号；命中即应判 ready，不强制静默期。
//   claude/codex 的 marker 较 generic（'shift+tab' / 'send'）容易在加载阶段假命中，
//   仍保留静默期保护。
const _STRONG_MARKER_KINDS = new Set(['gemini']);

const _stableState = new Map(); // sid → { lastBufLen, lastChangeTs }
const _onceTrue = new Set();    // sid → 一旦 true 永久锁

// isReady(sessionId, kind, buf) → boolean
//   非群聊可参与 kind（powershell 等）：默认 ready
//   _STRONG_MARKER_KINDS 含 marker → marker 命中 + buf ≥ MIN 即 ready（无静默期）
//   其他 kind 含 marker → marker 命中 + 静默期双门
//   不含 marker（空数组）→ 仅静默期
function isReady(sessionId, kind, buf, options = {}) {
  if (!sessionId) return false;
  if (_onceTrue.has(sessionId)) return true;
  const need = MARKERS[kind];
  if (!need) return true; // 未注册 kind（如 powershell）默认 ready
  buf = terminalText(buf);
  const blockers = BLOCKERS[kind] || [];
  // 2026-09-08：PTY 是**追加**的字节流，清屏只是一个控制序列 —— 早先那句
  // `Booting MCP server` / `esc to interrupt` 会一直留在 buffer 里。原来按
  // 「末尾 2000 字里出现过就拦」判，于是缓冲短一点时 Codex 被永久判成未就绪，
  // 真实开题连着两次 cli_not_ready（合并位在真实链路上复现）。
  //
  // 现在分两类：瞬态阻断词（见 STALEABLE_BLOCKERS）在输入框标记出现之后就算过期；
  // 终态阻断词（未登录、信任弹窗）一律拦到底。
  const staleable = STALEABLE_BLOCKERS[kind] || [];
  const absolute = blockers.filter(re => !staleable.some(x => x.source === re.source));
  const markerAt = need.length > 0 ? _lastIncludesIndex(buf, need) : -1;
  const absoluteAt = _lastMatchIndex(buf, absolute);
  const staleableAt = _lastMatchIndex(buf, staleable);
  const staleableIsLive = staleableAt >= 0 && !(markerAt > staleableAt);
  if (absoluteAt >= 0 || staleableIsLive) {
    _stableState.delete(sessionId);
    return false;
  }
  const markerHit = markerAt >= 0;
  const noMarker = need.length === 0;
  if (!(markerHit || noMarker)) return false;
  if (buf.length < MIN_BUF_LEN) return false;
  // gemini 强信号 marker fast-path：marker 命中 + buf ≥ MIN 立即 ready
  if (markerHit && _STRONG_MARKER_KINDS.has(kind)) {
    _onceTrue.add(sessionId);
    return true;
  }
  // 稳定 = 画面末尾的文字不再变化。TUI 空闲时也会重画同一屏（光标闪烁、同步刷新），
  // 字节长度一直在涨，用长度判稳定对 Claude / Codex 永远不成立。
  const signature = buf.slice(-240).replace(/\s+/g, ' ');
  // 2026-10-09：稳定窗口原来从「第一次来问」才开始计时，CLI 早已安静几秒也要再干等
  //   1.5s（新会话第一条消息实测点发送后 1541ms 才开始写）。调用方给出 PTY 最后一次
  //   输出的时刻：那之后没有任何字节进来，画面必然没变，这段时间同样算稳定。
  const quietFor = Number(options.lastOutputAt) > 0 ? Date.now() - Number(options.lastOutputAt) : 0;
  let st = _stableState.get(sessionId);
  if (!st) {
    _stableState.set(sessionId, { signature, lastChangeTs: Date.now() });
    if (quietFor >= STABLE_MS) { _onceTrue.add(sessionId); return true; }
    return false;
  }
  if (signature === st.signature) {
    const ready = Math.max(Date.now() - st.lastChangeTs, quietFor) >= STABLE_MS;
    if (ready) _onceTrue.add(sessionId);
    return ready;
  } else {
    st.signature = signature;
    st.lastChangeTs = Date.now();
    return false;
  }
}

/** 选择框是否正挂在屏幕上（出现在最后一个输入行标记之后）。 */
function isChoiceDialogVisible(kind, buf) {
  const text = terminalText(buf);
  const dialogAt = _lastMatchIndex(text, kind === 'codeagent'
    ? [...CODEAGENT_DIALOG_BLOCKERS, ...CHOICE_DIALOG_BLOCKERS] : CHOICE_DIALOG_BLOCKERS);
  if (dialogAt < 0) return false;
  const need = MARKERS[kind] || [];
  return !(_lastIncludesIndex(text, need) > dialogAt);
}

/** 这些正则里，最后一次匹配落在哪个位置；一个都不匹配返回 -1。 */
function _lastMatchIndex(buf, regexes) {
  let last = -1;
  for (const re of regexes) {
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let hit = null;
    // eslint-disable-next-line no-cond-assign
    while ((hit = scan.exec(buf)) !== null) {
      last = Math.max(last, hit.index);
      if (hit.index === scan.lastIndex) scan.lastIndex += 1;   // 防零宽匹配死循环
    }
  }
  return last;
}

/** 这些固定字串里，最后一次出现落在哪个位置；一个都没有返回 -1。 */
function _lastIncludesIndex(buf, needles) {
  let last = -1;
  for (const needle of needles) {
    last = Math.max(last, needle instanceof RegExp ? _lastMatchIndex(buf, [needle]) : buf.lastIndexOf(needle));
  }
  return last;
}

// markReady(sessionId) — 外部强制锁（如 sessionManager.getGroupChatReady 已 true 时）
function markReady(sessionId) {
  if (sessionId) {
    _stableState.delete(sessionId);
    _onceTrue.add(sessionId);
  }
}

// cleanup(sessionId) — sub session 关闭/relaunch 时调，下次新建同 sid 从零判定
function cleanup(sessionId) {
  _stableState.delete(sessionId);
  _onceTrue.delete(sessionId);
}

module.exports = {
  isReady,
  isChoiceDialogVisible,
  terminalText,
  markReady,
  cleanup,
  MARKERS,
  BLOCKERS,
  STALEABLE_BLOCKERS,
  MIN_BUF_LEN,
  STABLE_MS,
};
