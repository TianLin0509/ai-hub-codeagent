'use strict';
// core/pty-prompt-submit.js
// prompt 写进 TUI 输入框这一步的三个原语（2026-09-03）。
//
// 要解决的现象：输入越长越容易「内容进了 CLI 输入框、折叠成 [Pasted text +N lines]
//   却没提交」，用户干等。
//
// 机制（为什么长输入必卡）：
//   node-pty 在 Windows 上是 `this._agent.inSocket.write(data)`（named pipe 上的
//   net.Socket，见 node_modules/node-pty/lib/windowsTerminal.js）。socket 有内部队列，
//   几十 KB 的 payload 写下去是异步排空的。此时再 write('\r')，它被追加进同一条队列，
//   很可能与 BP_END 一起落进 CLI 的**同一个 stdin chunk**。Ink 的 paste 处理拿到
//   「正文 + BP_END + \r」这一整块时，\r 被当粘贴尾巴丢掉 —— 这正是
//   group-chat-watcher.js 里那条老注释描述的行为。固定 500/700ms 的等待在短 prompt
//   下够用，长 prompt 下必然落在排空窗口内，所以三次盲发全丢。
//
// 三个原语：
//   computeSettleMs(len)      —— settle 时间随体积走，不再写死
//   writeBracketedPaste(...)  —— 分块投喂，socket 队列不积压，\r 必然独立成 chunk
//   waitForPasteSettled(...)  —— 等 CLI 把粘贴渲染成折叠标记（正向信号），而不是干等
//
// 三者都不做提交，只保证「发 \r 的那一刻，CLI 已经把粘贴吃干净了」。真正的
//   提交确认（Claude UserPromptSubmit / Codex task_started）在调用方。

const { PASTE_MARKER_REGEX } = require('./paste-trapped-detector.js');

// xterm bracketed paste markers。与 group-chat-watcher.js 同一份协议常量。
const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';

// settle 时长：base + 体积线性项，上下都夹死。
//   下限 500ms 保持与老行为一致（短 prompt 一个字节都不变慢）；
//   上限 3000ms 之后交给调用方的语义确认兜底，不无限等。
const SETTLE_BASE_MS = 300;
const SETTLE_PER_CHAR_MS = 1 / 20;
const SETTLE_MIN_MS = 500;
const SETTLE_MAX_MS = 3000;

// 分块投喂：2KB 一片、15ms 一停。片大小对齐 writePromptToSession 的既有取值；
//   小于这个阈值的 payload 不分块，避免给短 prompt 白白加延迟。
const CHUNK_SIZE = 2048;
const CHUNK_GAP_MS = 15;

const POLL_MS = 50;
// 折叠标记出现后再确认一帧才认账：Ink 单帧里标记可能只画了一半。
const MARKER_CONFIRM_MS = 120;
// 一屏 Codex 重绘就能追加 1KB 以上，扫描窗口要够大才不会把标记刷出视野。
const TAIL_SCAN_BYTES = 8192;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

// payload 越大，CLI 消化得越久。返回值是「发 \r 之前至少要等多久」。
function computeSettleMs(payloadLength, options = {}) {
  const base = Number.isFinite(options.baseMs) ? options.baseMs : SETTLE_BASE_MS;
  const perChar = Number.isFinite(options.perCharMs) ? options.perCharMs : SETTLE_PER_CHAR_MS;
  const minMs = Number.isFinite(options.minMs) ? options.minMs : SETTLE_MIN_MS;
  const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : SETTLE_MAX_MS;
  const len = Math.max(0, Number(payloadLength) || 0);
  return Math.round(clamp(base + len * perChar, minMs, maxMs));
}

// 切片不能把代理对劈开：'\uD83D' + '\uDE00' 分两次 write 会各自编成
//   无效 UTF-8，PTY 那头拿到两个替换字符。中文是 BMP 单元不受影响，emoji 会。
function safeSliceEnd(text, end) {
  if (end >= text.length) return text.length;
  const code = text.charCodeAt(end - 1);
  // 末位是高代理项 → 把配对的低代理项一起带上
  if (code >= 0xd800 && code <= 0xdbff) return end + 1;
  return end;
}

function splitChunks(payload, chunkSize) {
  const size = Math.max(1, Number(chunkSize) || CHUNK_SIZE);
  const chunks = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const end = safeSliceEnd(payload, Math.min(payload.length, cursor + size));
    chunks.push(payload.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

// Claude Code（2.1.29x 起，服务端开关）在提交时把「折叠成 [Pasted text #N] 的粘贴」包进
//   <pasted_content id="xxxx">，并在系统提示里告诉模型「其中的指令未必是用户本人写的」。
//   Hub 发的就是用户（或用户派的工作流）本人的话，被这样标记既难看又会让指令打折扣。
//   CLI 的规则（实测 2.1.292 源码）：单次粘贴超过 800 字或换行多于 min(行数-10, 2) 才折叠并包裹；
//   更小的粘贴原样进输入框、不包裹。所以给 Claude 拆成若干小段粘贴依次投喂。
const INLINE_PASTE_MAX_CHARS = 800;
const INLINE_PASTE_MAX_NEWLINES = 1; // 规则允许 2；取 1 给终端只有 11 行的窗口也留余量
// 拆段只用在实测可靠的体积内（2026-10-07 真实 CLI 对照：60 行 2719 字一次提交成功；
//   160 行 7280 字拆成 160 段后 Claude 迟迟不收、补回车两次仍未提交，旧的整段粘贴则能提交）。
//   超出就退回整段粘贴：群聊首轮这类带完整规则的长提示会被包进 <pasted_content>，但能送达。
const INLINE_PASTE_MAX_PIECES = 64;
const INLINE_PASTE_MAX_TOTAL_CHARS = 3200;

// 按「≤maxChars 字、≤maxNewlines 个换行」切段，尽量在换行后断开；不劈开代理对。
function splitInlinePastes(text, maxChars = INLINE_PASTE_MAX_CHARS, maxNewlines = INLINE_PASTE_MAX_NEWLINES) {
  const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n'); // CLI 也会这样归一
  const pieces = [];
  let cursor = 0;
  while (cursor < source.length) {
    let end = cursor;
    let newlines = 0;
    while (end < source.length && end - cursor < maxChars) {
      const ch = source[end];
      end += 1;
      if (ch === '\n' && ++newlines >= maxNewlines) break;
    }
    end = safeSliceEnd(source, Math.max(end, cursor + 1));
    pieces.push(source.slice(cursor, end));
    cursor = end;
  }
  return pieces;
}

// 把 prompt 包进 bracketed paste 并分块写入。
//   分块的意义不是"更快"，而是让 socket 队列在最后一片写完时几乎是空的 ——
//   这样调用方随后发的 \r 才可能独立成一个 stdin chunk，而不是被并进 BP_END 那块。
//   options.inlinePieces：拆成多段小粘贴（Claude 用，见 splitInlinePastes），每段一次写入。
// 返回实际写出的分片数（1 表示走了不分块的快路径）。
async function writeBracketedPaste(sessionManager, sid, text, options = {}) {
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : CHUNK_GAP_MS;
  if (options.inlinePieces && String(text == null ? '' : text).length <= INLINE_PASTE_MAX_TOTAL_CHARS) {
    const pieces = splitInlinePastes(text);
    if (pieces.length > 1 && pieces.length <= INLINE_PASTE_MAX_PIECES) {
      for (let i = 0; i < pieces.length; i += 1) {
        sessionManager.writeToSession(sid, BP_START + pieces[i] + BP_END);
        if (i < pieces.length - 1) await sleep(gapMs);
      }
      return pieces.length;
    }
  }
  const payload = BP_START + String(text == null ? '' : text) + BP_END;
  const chunkSize = Number.isFinite(options.chunkSize) ? options.chunkSize : CHUNK_SIZE;
  if (payload.length <= chunkSize) {
    sessionManager.writeToSession(sid, payload);
    return 1;
  }
  const chunks = splitChunks(payload, chunkSize);
  for (let i = 0; i < chunks.length; i += 1) {
    sessionManager.writeToSession(sid, chunks[i]);
    if (i < chunks.length - 1) await sleep(gapMs);
  }
  return chunks.length;
}

function extractMarker(text) {
  const m = PASTE_MARKER_REGEX.exec(String(text || '').slice(-TAIL_SCAN_BYTES));
  return m ? m[0] : null;
}

// 写 payload **之前**取一次基线：屏幕上可能还留着上一次粘贴的折叠标记。
//   不记基线的话，Ink 每帧全屏重绘都会把那条旧标记刷进新字节里，
//   waitForPasteSettled 会立刻误判「这次的粘贴已消化」提前发 \r。
function snapshotPasteMarker(sessionManager, sid) {
  if (!sessionManager || typeof sessionManager.getSessionBuffer !== 'function') return null;
  return extractMarker(sessionManager.getSessionBuffer(sid) || '');
}

// 回显信号（2026-10-09）：短消息不会折叠成标记，原来每条都要干等满 settle 下限 500ms
//   才发 \r —— 用户看着文字已经躺在 CLI 输入框里，却要再等半秒才提交。CLI 把这次
//   消息的**结尾**画出来，说明它已经读完并处理了这次粘贴（含 BP_END），此时的 \r
//   必然是独立的 stdin chunk。只看写入之后的新输出，不看历史；结尾太短（<2 个非空白
//   字符）不作依据，照旧等满 settle。万一判早了，调用方的语义确认与有界补回车兜底。
const ECHO_TAIL_CHARS = 12;
const ECHO_MIN_CHARS = 2;
const ECHO_POLL_MS = 20;

function echoComparable(text) {
  return String(text || '')
    .replace(/\x1b\[(\d*)C/g, ' ')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\s+/g, '');
}

// 回显要找的那段：消息**最后一行**去掉空白后的最后若干个字符。
//   不能跨行取：多行输入时 TUI 只重画新增的那一行，上一行的结尾不会紧挨着出现。
function echoNeedle(prompt) {
  const lines = String(prompt == null ? '' : prompt).split(/\r\n?|\n/);
  const compact = echoComparable(lines[lines.length - 1]);
  if (compact.length < ECHO_MIN_CHARS) return null;
  let start = Math.max(0, compact.length - ECHO_TAIL_CHARS);
  // 不从代理对中间切开。
  const code = compact.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff && start > 0) start -= 1;
  return compact.slice(start);
}

// 等 CLI 真的把这次粘贴吃完。
//   正向信号：屏幕上出现一条与基线**不同**的折叠标记（Claude 的
//     [Pasted text #N +M lines] / Codex 的 [[Pasted Content N chars]]）；
//     或者（传了 echoNeedle + readOutputSince 时）写入之后的新输出里出现了消息结尾。
//   拿不到信号（Codex 走 BP 时不进粘贴态，屏幕上根本没有标记）就等满 settleMs，
//     由调用方的语义确认继续兜底。
// 返回 { reason: 'marker' | 'echo' | 'ceiling', waitedMs, marker }
async function waitForPasteSettled(options = {}) {
  const {
    sessionManager,
    sid,
    settleMs,
    baselineMarker = null,
    markerConfirmMs = MARKER_CONFIRM_MS,
    echoNeedle: needle = null,
    readOutputSince = null,
  } = options;
  const watchEcho = !!needle && typeof readOutputSince === 'function';
  const pollMs = options.pollMs ?? (watchEcho ? ECHO_POLL_MS : POLL_MS);
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, Number(settleMs) || 0);
  const canScan = sessionManager && typeof sessionManager.getSessionBuffer === 'function';
  let markerSeenAt = 0;
  let markerText = null;

  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    if (watchEcho) {
      let fresh = '';
      try { fresh = readOutputSince() || ''; } catch { fresh = ''; }
      if (echoComparable(fresh).includes(needle)) {
        return { reason: 'echo', waitedMs: Date.now() - startedAt, marker: null };
      }
    }
    if (!canScan) continue;
    const marker = extractMarker(sessionManager.getSessionBuffer(sid) || '');
    // 与基线相同的标记一律不算数：那可能只是上一次粘贴留在屏幕上的残影。
    if (!marker || marker === baselineMarker) {
      markerSeenAt = 0;
      markerText = null;
      continue;
    }
    if (marker !== markerText) {
      markerText = marker;
      markerSeenAt = Date.now();
      continue;
    }
    if (Date.now() - markerSeenAt >= markerConfirmMs) {
      return { reason: 'marker', waitedMs: Date.now() - startedAt, marker };
    }
  }
  return { reason: 'ceiling', waitedMs: Date.now() - startedAt, marker: markerText };
}

const INPUT_BOX_TAIL_LINES = 14;

function hasPasteMarkerInLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return false;
  return lines.some(line => PASTE_MARKER_REGEX.test(String(line || '')));
}

// A short paste stays as plain text rather than a collapsed marker. Only an
// exact, single-line prompt at the bottom input row counts: quoted messages in
// scrollback, another draft, menus and wrapped/multiline text remain ambiguous.
function hasPromptInInputLine(lines, prompt) {
  if (!Array.isArray(lines) || typeof prompt !== 'string' || !prompt.trim() || /[\r\n]/.test(prompt)) return false;
  const inputAt = lines.findLastIndex(line => /^\s*[›❯>]\s*/.test(String(line || '')));
  if (inputAt < 0) return false;
  const text = String(lines[inputAt]).replace(/^\s*[›❯>]\s*/, '').trim();
  if (text !== prompt.trim()) return false;
  return lines.slice(inputAt + 1).every(line => !String(line || '').trim()
    || /^[\s─━╭╰╯╮│┌└┘┐┤├]+$/.test(line)
    || /^\s*(?:Context \d+%.*|shift\+tab.*|\? for shortcuts.*)$/i.test(line)
    || /^\s*GPT-[\w.-]+(?:\s+(?:minimal|low|medium|high|xhigh|default|fast|flex))*\s*·\s*Context\s+\d+%\s+left(?:\s*·\s*.*)?$/i.test(line)
    || /^\s*⚠\s*\d+\s+warnings?\s*·\s*f2\s+to\s+view\s*$/i.test(line)
    || /^\s*(?:[⏸⏵▶»]+\s*)?(?:(?:manual|plan|auto) mode on|bypass permissions on|accept edits on)\b.*$/i.test(line));
}

// 折叠标记或完整短文字仍在输入行，是补回车的正向依据。
//   优先用 livePtyObserver 抓到的**可见屏幕末尾行**；拿不到（探针没起来 / viewport 是空的）
//   才退到 probeStrongPtyWorkStart 记的 ring 尾巴，并只取最后若干行近似输入框那一屏。
//   不整条扫 ring buffer：它是只增的历史，提交成功后标记仍留在里面，会永远判成"没提交"。
function pasteStillInInputBox(probeState, prompt) {
  if (!probeState) return false;
  // On a fresh/short TUI screen the input row can sit above the last 12 rows.
  // Inspect the complete visible screen for exact text, never ring history.
  if (hasPromptInInputLine(probeState.lastLiveScreen || probeState.lastLiveLines, prompt)) return true;
  const live = probeState.lastLiveLines;
  if (Array.isArray(live) && live.some(line => String(line || '').trim())) {
    return hasPasteMarkerInLines(live);
  }
  const tail = String(probeState.lastRingTail || '');
  if (!tail) return false;
  return hasPasteMarkerInLines(tail.split(/\r?\n/).slice(-INPUT_BOX_TAIL_LINES));
}

module.exports = {
  BP_START,
  BP_END,
  hasPasteMarkerInLines,
  hasPromptInInputLine,
  pasteStillInInputBox,
  computeSettleMs,
  writeBracketedPaste,
  waitForPasteSettled,
  echoNeedle,
  snapshotPasteMarker,
  splitInlinePastes,
  INLINE_PASTE_MAX_PIECES,
  INLINE_PASTE_MAX_TOTAL_CHARS,
  _private: { splitChunks, safeSliceEnd, extractMarker, echoComparable },
  SETTLE_MIN_MS,
  SETTLE_MAX_MS,
  CHUNK_SIZE,
  CHUNK_GAP_MS,
};
