'use strict';
// CodeAgent 屏幕右侧 Stats 面板里的上下文占用（2026-10-16 公司真机样本，Q-1016-01 第 2 轮）。
//
// 输入框旁的上下文圆环本来按每轮落盘记录里的 token 用量算（core/codeagent-models.js），
// 但公司的 GLM 后端写进记录的用量全是 0，圆环从来没有数。CodeAgent 自己在全屏界面右侧一直显示：
//   ▾ Stats
//   Context 32.7k (16%)
//   Credit 1,954.7 (78.2%)
//   Runtime 00:00:00
// 面板和回答正文同处一行（左边是正文，右边是面板），所以只认「Context 数字 (百分比)」这个固定结构，
// 取画面里最靠下的一处；正文里恰好出现同样写法的概率很低，且下一轮会被真实面板覆盖。
const CONTEXT_RE = /\bContext\s+(\d+(?:[.,]\d+)*)\s*([kKmM])?\s*\((\d+(?:\.\d+)?)%\)/;

function parseCount(digits, unit) {
  const n = Number(String(digits).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const scale = /k/i.test(unit || '') ? 1000 : /m/i.test(unit || '') ? 1000000 : 1;
  return Math.round(n * scale);
}

// 屏幕行 → { contextUsed, contextPct, contextEffectiveMax }；认不出返回 null。
function parseCodeAgentContext(lines) {
  const rows = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const m = CONTEXT_RE.exec(String(rows[i] || ''));
    if (!m) continue;
    const used = parseCount(m[1], m[2]);
    const pct = Number(m[3]);
    if (!(used > 0) || !(pct > 0) || pct > 100) return null;
    return { contextUsed: used, contextPct: pct, contextEffectiveMax: Math.round(used / pct * 100) };
  }
  return null;
}

module.exports = { parseCodeAgentContext };
