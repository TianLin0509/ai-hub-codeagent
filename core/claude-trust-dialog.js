'use strict';

// Claude Code 的目录信任框（"Accessing workspace" / "Quick safety check"）。
//
// 2026-08-28 实测 Claude Code v2.1.251，PTY 原始字节长这样：
//   \x1b[19;2H❯\x1b[1CNo,\x1b[1Cexit\x1b[m
//   \x1b[20;4HYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder
//   \x1b[22;2HEnter\x1b[1Cto\x1b[1Cconfirm\x1b[1C·\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel
//
// 两件事因此成立：
//  1. 整帧是用绝对光标定位（CSI row;colH）画的，词与词之间还插着 CSI nC 前移。
//     既不能按 \n 切行，也不能对 strip 后的连续字母串做位置判断 —— 必须把 CUP
//     还原成「行号 → 该行文本」才能知道谁在谁上面。
//  2. **默认高亮项是 `No, exit`**，不是 Yes。老实现「检测到就写 \r」在这个版本
//     里等于替用户选了退出。所以这里只认「定位得到光标行 + Yes 行」才动手，
//     用方向键把高亮移过去再回车；定位不出来就什么都不做，交给用户。
//
// 真正让信任框不出现的是 spawn 前预写 projects[cwd].hasTrustDialogAccepted
// （见 core/claude-project-trust.js）；本模块是那条路径失效时的兜底。

const CURSOR_MARKERS = ['❯', '›', '▶', '>'];
const MAX_MENU_DISTANCE = 8;

const TRUST_PROMPT_RE = /(?:quick\s+safety\s+check|accessing\s+workspace|do\s+you\s+trust)/i;
// 公司 Code Agent 的同款信任框底栏写作 "Select option ↑ ↓ | Confirm Enter | No, exit Esc"，默认高亮 Yes（2026-10-08 公司真机）。
const CONFIRM_HINT_RE = /(?:enter\s+to\s+confirm|to\s+confirm|confirm\s+enter)/i;
// 只匹配选项那一行的措辞。正文段落写的是 "or one you trust?" / "in this folder
// first."，两边都不连续，不会误命中。
const TRUST_OPTION_RE = /trust\s+(?:this\s+folder|the\s+files)/i;
// 便宜的前置闸门：绝大多数会话根本不会弹这个框，没必要每个 PTY chunk 都重放整帧。
const TRUST_HINT_RE = /trust/i;

// 参数段要收 `<=>?` 这一档私有前缀，否则 `\x1b[>0q`（终端能力查询，Claude 启动时
// 就会发）匹配不上，`[>0q` 会被当正文写进行里。
const CSI_RE = /^\x1b\[([0-9;:<=>?]*)([ -/]*)([@-~])/;
const OSC_RE = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const CHARSET_RE = /^\x1b[()][0-9A-Za-z]/;

// 把一段 PTY 字节按 CUP / CUF / 擦除语义重放成 Map<行号, 行文本>。
// 只实现信任框会用到的那几个序列，其余 CSI 直接跳过 —— 目标是还原版式，不是写终端。
function renderPtyRows(buffer, { maxRows = 400, maxCols = 400 } = {}) {
  const text = String(buffer || '');
  const rows = new Map();
  let row = 1;
  let col = 1;

  const write = (ch) => {
    if (row < 1 || row > maxRows || col < 1 || col > maxCols) return;
    const line = rows.get(row) || '';
    const padded = line.length >= col - 1 ? line : line + ' '.repeat(col - 1 - line.length);
    rows.set(row, padded.slice(0, col - 1) + ch + padded.slice(col));
    col += 1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\x1b') {
      const rest = text.slice(i, i + 64);
      const osc = OSC_RE.exec(rest);
      if (osc) { i += osc[0].length - 1; continue; }
      const csi = CSI_RE.exec(rest);
      if (csi) {
        const params = csi[1].split(';');
        const first = Number(params[0]);
        const final = csi[3];
        if (final === 'H' || final === 'f') {
          row = Number.isFinite(first) && first > 0 ? first : 1;
          const second = Number(params[1]);
          col = Number.isFinite(second) && second > 0 ? second : 1;
        } else if (final === 'C') {
          col += Number.isFinite(first) && first > 0 ? first : 1;
        } else if (final === 'D') {
          col = Math.max(1, col - (Number.isFinite(first) && first > 0 ? first : 1));
        } else if (final === 'A') {
          row = Math.max(1, row - (Number.isFinite(first) && first > 0 ? first : 1));
        } else if (final === 'B') {
          row += Number.isFinite(first) && first > 0 ? first : 1;
        } else if (final === 'J') {
          // 2J/3J 清屏：信任框就是清屏后重画的，不清会跟启动横幅串到一起。
          if (params[0] === '2' || params[0] === '3') rows.clear();
        } else if (final === 'K') {
          const line = rows.get(row);
          if (typeof line === 'string' && (!params[0] || params[0] === '0')) {
            rows.set(row, line.slice(0, col - 1));
          }
        }
        i += csi[0].length - 1;
        continue;
      }
      const charset = CHARSET_RE.exec(rest);
      if (charset) { i += charset[0].length - 1; continue; }
      continue;
    }
    if (ch === '\r') { col = 1; continue; }
    if (ch === '\n') { row += 1; col = 1; continue; }
    if (ch === '\b') { col = Math.max(1, col - 1); continue; }
    if (ch === '\t') { col += 8 - ((col - 1) % 8); continue; }
    if (ch < ' ' || ch === '\x7f') continue;
    write(ch);
  }
  return rows;
}

function startsWithCursorMarker(line) {
  const trimmed = String(line || '').trimStart();
  return CURSOR_MARKERS.some(marker => trimmed.startsWith(marker));
}

/**
 * 在一段 PTY 尾缓冲里找信任框，返回把高亮移到「信任」选项并确认所需的按键序列。
 * 只有同时定位到光标行与信任选项行才返回；否则返回 null（宁可让用户自己选，
 * 也绝不盲按回车 —— 新版默认项是 "No, exit"）。
 */
function detectClaudeTrustDialog(buffer) {
  if (!TRUST_HINT_RE.test(String(buffer || ''))) return null;
  const rows = renderPtyRows(buffer);
  if (!rows.size) return null;

  const entries = [...rows.entries()].sort((left, right) => left[0] - right[0]);
  const joined = entries.map(([, line]) => line).join('\n');
  if (!TRUST_PROMPT_RE.test(joined) || !CONFIRM_HINT_RE.test(joined)) return null;

  let trustRow = null;
  let cursorRow = null;
  for (const [rowNumber, line] of entries) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trustRow === null && TRUST_OPTION_RE.test(trimmed)) trustRow = rowNumber;
    if (startsWithCursorMarker(line)) cursorRow = rowNumber;
  }
  if (trustRow === null || cursorRow === null) return null;

  const delta = trustRow - cursorRow;
  if (Math.abs(delta) > MAX_MENU_DISTANCE) return null;

  const keys = [];
  for (let step = 0; step < Math.abs(delta); step += 1) keys.push(delta > 0 ? '\x1b[B' : '\x1b[A');
  keys.push('\r');
  return { cursorRow, trustRow, delta, keys };
}

module.exports = {
  CONFIRM_HINT_RE,
  MAX_MENU_DISTANCE,
  TRUST_HINT_RE,
  TRUST_OPTION_RE,
  TRUST_PROMPT_RE,
  detectClaudeTrustDialog,
  renderPtyRows,
};
