'use strict';

const labels = { fast: '快速', standard: '标准', flex: 'Flex' };
const rateText = value => value < 10 ? value.toFixed(1) : Math.round(value).toString();
function durationText(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${Math.round(seconds % 60)} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
const methods = { 'per-call': '逐次调用计时', 'api-duration': '按 CLI 记录的接口耗时', 'minus-tools': '整轮扣除工具执行时间' };
// Generation is the model's own speed; the whole-turn rate also spreads tool
// execution and waiting over the output. Both are shown when both are known.
function speedDisplay(metric) {
  if (!metric || !Number.isFinite(metric.tokensPerSecond) || metric.tokensPerSecond <= 0) return null;
  const mode = labels[metric.speedTier];
  const whole = rateText(metric.tokensPerSecond);
  const generation = metric.generation && Number.isFinite(metric.generation.tokensPerSecond)
    && metric.generation.tokensPerSecond > 0 ? metric.generation : null;
  const rate = generation ? rateText(generation.tokensPerSecond) : whole;
  const tail = `${metric.includesReasoning ? '输出含推理 token。' : ''}${mode ? '该轮速度档：' + mode + '。' : '该轮速度档未记录。'}`;
  const wholeLine = `整轮速度 ≈${whole} tok/s：${metric.outputTokens} 个输出 token ÷ 整轮 ${durationText(metric.elapsedMs)}`;
  const title = generation
    ? `生成速度 ≈${rate} tok/s：${generation.outputTokens} 个输出 token ÷ 模型生成用时 ${durationText(generation.activeMs)}`
      + `（${generation.calls ? generation.calls + ' 次调用，' : ''}${methods[generation.method] || ''}）。`
      + '每次调用从发出请求算到最后一段输出，含首字前的排队和读上下文，比纯出字速度略低。\n'
      + `${wholeLine}，其中工具、子代理和等待约 ${durationText(Math.max(0, metric.elapsedMs - generation.activeMs))}。${tail}`
    : `${wholeLine}。包含等待和工具执行时间，不代表纯生成速度；这一轮的记录不足以单独算出模型生成用时。${tail}`;
  const bare = `${generation ? `生成 ≈${rate} · 整轮 ${whole}` : `整轮 ≈${whole}`} tok/s`;
  return { text: `${mode ? mode + ' · ' : ''}${bare}`, bare,
    rate, whole: generation ? whole : null, label: generation ? '生成' : '整轮', mode, title };
}

function createTurnSpeedDisplay(document, getSession, getFocusedId) {
  const element = document.createElement('span');
  element.className = 'session-turn-speed'; element.hidden = true;
  const anchor = document.getElementById('btn-backstage');
  anchor?.before(element);
  function paint(visible = !anchor?.hidden) {
    const session = getSession(getFocusedId());
    const display = speedDisplay(session?.lastTurnSpeed);
    const speed = session && require('../core/session-speed').speedControl(session);
    const mode = speed?.visible ? labels[speed.tier] : null;
    element.hidden = !visible || (!display && !mode);
    element.textContent = [mode && `当前${mode}`, display && `上轮${display.bare}`].filter(Boolean).join(' · ');
    element.title = [mode && `当前速度设置：${mode}；不用于标记历史回复。`, display?.title].filter(Boolean).join('\n');
  }
  function observe(sessionId, turn) {
    const session = getSession(sessionId);
    if (!session || turn?.role !== 'assistant') return;
    const outcome = turn.nativeOutcome || turn.deliveryContext?.nativeOutcome;
    if (!turn.turnSpeed && !['completed', 'failed', 'interrupted'].includes(outcome)
        && !['stop', 'completed', 'end_turn'].includes(turn.stopReason)) return;
    const at = turn.turnSpeed?.endedAt || turn.tsEnd;
    if (!Number.isFinite(at) || at < (session.lastTurnSpeedAt || 0)) return;
    // A newer reply with insufficient measurements hides the old rate.
    session.lastTurnSpeedAt = at;
    session.lastTurnSpeed = turn.turnSpeed || null;
    if (getFocusedId() === sessionId) paint();
  }
  return { paint, observe };
}

module.exports = { speedDisplay, createTurnSpeedDisplay };
