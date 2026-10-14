'use strict';
// 卡片视图下，卡片后面那个终端不绘制（2026-10-13 公司版卡顿取证）。
//
// 「后台」9 月做法（core/backstage-path.js）让当前会话的终端常驻在卡片下面，点后台只藏卡片，所以快；
// 代价是卡片视图里终端照常绘制。显卡关着（公司版默认）时终端用 DOM 渲染器，CodeAgent 一直在输出，
// 每一屏都整行重建、重排、重算样式。隔离实测（关显卡、CodeAgent 风格替身、CPU 放慢 4 倍模拟公司电脑）：
// 卡片视图什么都不点，界面线程 59–62% 的时间在画这个看不见的终端；暂停后 5%。点后台时补画一次整屏 74 ms
// （正常速度约 20 ms）；开显卡时差别小（4% → 1%，补画 5 ms），所以各版本都启用。
//
// 做法：借 xterm 自己的「暂停」（终端不在可视区域时它就是这样省掉绘制的）。终端照常收输出、更新内容，
// 只是不画；离开卡片视图时解除暂停并整屏补画一次。xterm 根据可视区域自动解除暂停时，卡片视图下仍保持
// 暂停。依赖 xterm 内部字段；字段对不上（升级后结构变了）就什么都不做，行为退回原样。
// HUB_DISABLE_CARD_PAUSE=1 可关。
function renderServiceOf(terminal) {
  const rs = terminal && terminal._core && terminal._core._renderService;
  if (!rs || !('_isPaused' in rs) || typeof rs._handleIntersectionChange !== 'function') return null;
  return rs;
}

// refresh=false：调用方随后会走自己的整屏恢复（applyViewMode('pty') 的 scheduleVisibleTerminalRecovery 会强制重排并重画），
// 这里再补画一遍就是重复。
function setBehindCardsPaused(terminal, paused, { refresh = true, env = process.env } = {}) {
  if (env.HUB_DISABLE_CARD_PAUSE === '1') return false;
  const rs = renderServiceOf(terminal);
  if (!rs) return false;
  if (!rs.__hubCardPause) {
    const original = rs._handleIntersectionChange;
    rs.__hubCardPause = { on: false, paused: 0, resumed: 0 };
    rs._handleIntersectionChange = function cardPauseIntersection(entry) {
      const result = original.call(this, entry);
      if (this.__hubCardPause.on) this._isPaused = true;
      return result;
    };
  }
  const state = rs.__hubCardPause;
  if (paused) {
    if (!state.on) state.paused++;
    state.on = true;
    rs._isPaused = true;
    return true;
  }
  if (!state.on) return true;
  state.on = false;
  state.resumed++;
  rs._isPaused = false;
  // 补画前先把这一屏没量过的字一次性量完（renderer/xterm-shared-width-cache.js），补画时不再逐字强制排版。
  try { require('./xterm-shared-width-cache.js').prewarmViewportWidths(terminal); } catch {}
  // 暂停期间的输出只更新了内容，这里整屏补画；隐藏期间记下的选区由 xterm-hidden-render-guard 一起补上。
  const pending = rs.__hubHiddenGuard && rs.__hubHiddenGuard.pending;
  if (pending) { rs.__hubHiddenGuard.pending = null; rs.__hubHiddenGuard.replayed++; rs.handleSelectionChanged(...pending); }
  if (refresh) { try { terminal.refresh(0, Math.max(0, terminal.rows - 1)); } catch {} }
  return true;
}

function cardPauseStats(terminal) {
  const rs = renderServiceOf(terminal);
  return rs && rs.__hubCardPause ? { ...rs.__hubCardPause, isPaused: rs._isPaused } : null;
}

module.exports = { setBehindCardsPaused, cardPauseStats };
