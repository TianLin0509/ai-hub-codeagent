'use strict';
// FIX-D（2026-05-01）：检测 PTY ring buffer 末尾是否回到宿主 shell prompt（PowerShell / bash / cmd）。
//   命中 → 视为 CLI 自我退出（Codex 自动更新 / Gemini OAuth refresh / Claude panic 等）。
//   配合 main.js _gcWaitTurnComplete 里的 10s 心跳 + 连续 2 次命中机制使用，让 watcher 在
//   ~10-20s 内 settle errored，而不是等 5min 硬 timeout。
//
// 误判防护：
//   1. 严格只看 buffer tail（最后 500 字符）— 避免命中历史 prompt
//   2. 调用方需要"连续 N 次命中"才确认（main.js 里 N=2）
//   3. 去 ANSI / 控制字符后再匹配 — CLI alt-screen 渲染不会在 tail 留下干净的 PS prompt 字串

// 匹配模式：
//   - PowerShell: `PS C:\Users\xxx>`、`PS C:\Users\xxx\>`
//   - cmd:       `C:\Users\xxx>`
//   - bash:      `user@host:~$`、`$`
//   都要求出现在行首、tail 末尾结束（^/(?:\n|^) 锚 + $\s*$ 锚）
const HOST_SHELL_PROMPT_RE = /(?:^|\n)\s*(?:PS [A-Za-z]:\\[^\n]*?>\s*(?:\n\s*>>\s*)*$|[\w-]+@[^\s]+:[^\s]*?\$\s*$|\$\s*$|[A-Za-z]:\\[^\n]*?>\s*$)/;

function stripAnsi(buf) {
  return String(buf || '')
    .replace(/\x1b\[(\d*)C/g, (_match, count) => ' '.repeat(Math.min(Number(count) || 1, 200)))
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '');
}

function detectHostShellTakeover(rawBuffer) {
  if (!rawBuffer) return false;
  const clean = stripAnsi(rawBuffer);
  const tail = clean.slice(-500);
  return HOST_SHELL_PROMPT_RE.test(tail);
}

// Codex 0.153 的 /new 在同一个 TUI 里结束当前线程时，先打印
// "To continue this session, run codex resume, then select … (<旧线程 id>)"，再以
// source=startup 报新线程的 SessionStart（2026-09-26 真机实测，不是 clear）。只认带着
// 「当前绑定线程 id」的这句提示：模型在工具里嵌套跑的 codex 不会把父线程 id 画到这个终端上。
// ConPTY 用光标移动代替空格、长 id 会折行，所以去掉控制序列与全部空白后再比对。
// 只看最后一次这样的提示，它必须指向当前绑定的线程。
function detectCodexThreadEnded(rawBuffer, boundSid) {
  const sid = String(boundSid || '').replace(/\s+/g, '');
  if (!rawBuffer || !sid) return false;
  const compact = stripAnsi(rawBuffer).replace(/\s+/g, '');
  const at = compact.lastIndexOf('Tocontinuethissession');
  if (at < 0) return false;
  const hint = compact.slice(at);
  // 0.157.1 prints the executable resume command directly, without the old
  // title + parenthesized id. Match the UUID in that command, not arbitrary
  // occurrences of the bound id elsewhere in a newer thread's output.
  const direct = /^Tocontinuethissession,runcodexresume([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/i.exec(hint);
  if (direct) return direct[1] === sid;
  const parenthesized = /^Tocontinuethissession,runcodexresume\(([^)]+)\)/.exec(hint);
  if (parenthesized) return parenthesized[1] === sid;
  return hint.startsWith('Tocontinuethissession,runcodexresume,thenselect') && hint.includes(`(${sid})`);
}

// ---------------------------------------------------------------------------
// createAuthBannerMonitor — CLI 登录失效横幅检测（2026-07-12 maintainer）。
//   血泪：旧实现在 dispatcher 心跳里对整个 8KB ring buffer 裸测 AUTH_FAILURE_RE，
//   AI 回答/工具输出里提到 "not logged in"（如 gh CLI 报 "not logged into any
//   GitHub hosts"）就被当场 markErrored('auth_required') —— PTY 明明在正常回答，
//   群聊 UI 却显示「发送失败」+ 空气泡。
//   判定收紧为三重门（全过才 'confirmed'）：
//     1. 只看 stripAnsi 后的 buffer 尾部（真登录错误 = CLI 停在错误横幅上）
//     2. 连续 2 次心跳命中（单次滚屏路过不算）
//     3. 两次命中之间 PTY 零新输出（正常回答会持续滚动/重绘 spinner，activity 一直变）
const AUTH_FAILURE_RE = /(not logged in|please run\s+\/login|run\s+\/login|authentication required|login required)/i;
const AUTH_TAIL_CHARS = 1200;

function createAuthBannerMonitor() {
  let hits = 0;
  let lastActivity = null;
  return {
    // rawBuffer: PTY ring buffer；activityStamp: sessionManager.getGroupChatLastActivity(sid)
    // 返回 'none' | 'suspect' | 'confirmed'
    tick(rawBuffer, activityStamp) {
      const tail = stripAnsi(rawBuffer || '').slice(-AUTH_TAIL_CHARS);
      if (!AUTH_FAILURE_RE.test(tail)) {
        hits = 0;
        lastActivity = null;
        return 'none';
      }
      // activityStamp 缺失（PTY 从未输出/接口异常）时不做"静默"判定——
      //   宁可漏报等 soft-alert 人工处理，不给误杀留门（2026-07-12 审查加固）。
      const quietSinceLastHit = hits > 0 && activityStamp != null && activityStamp === lastActivity;
      hits += 1;
      lastActivity = activityStamp;
      return (hits >= 2 && quietSinceLastHit) ? 'confirmed' : 'suspect';
    },
  };
}

module.exports = {
  HOST_SHELL_PROMPT_RE,
  AUTH_FAILURE_RE,
  stripAnsi,
  detectHostShellTakeover,
  detectCodexThreadEnded,
  createAuthBannerMonitor,
};
