'use strict';

const labels = { fast: '快速', standard: '标准', flex: 'Flex' };
function speedDisplay(metric) {
  if (!metric || !Number.isFinite(metric.tokensPerSecond) || metric.tokensPerSecond <= 0) return null;
  const rate = metric.tokensPerSecond < 10 ? metric.tokensPerSecond.toFixed(1) : Math.round(metric.tokensPerSecond).toString();
  const mode = labels[metric.speedTier];
  return { text: `${mode ? mode + ' · ' : ''}均速 ≈${rate} tok/s`, rate, mode,
    title: `整轮平均速度：${metric.outputTokens} 个输出 token ÷ ${(metric.elapsedMs / 1000).toFixed(1)} 秒。包含等待和工具执行时间${metric.includesReasoning ? '，输出含推理 token' : ''}；不代表纯生成 TPS。${mode ? '该轮速度档：' + mode + '。' : '该轮速度档未记录。'}` };
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
    element.textContent = [mode && `当前${mode}`, display && `上轮${display.text}`].filter(Boolean).join(' · ');
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
