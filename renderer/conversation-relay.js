'use strict';

// A clipboard shortcut must use this workflow run, step, member and attempt.
// Never substitute the composer, the user question alone or an older answer.
function targets(meeting, run, state = {}) {
  const index = run?.currentStepIndex ?? run?.nextStepIndex ?? 0;
  const ids = meeting.serialWorkflow?.steps?.[index] || [];
  return ids.map(memberId => {
    const slotIndex = meeting.slotSpecs.findIndex((slot, i) => (slot.memberId || `m${i+1}`) === memberId);
    const slot = meeting.slotSpecs[slotIndex], sid = meeting.subSessions?.[slotIndex];
    if (!slot || !sid) return null;
    const matches = Object.values(state.attempts || {}).filter(a => a?.sid === sid
      && run?.runId && a.workflowRun?.runId === run.runId
      && Number(a.workflowRun.stepIndex) === Number(index)
      && (run.currentTurnNum == null || Number(a.turnNum) === Number(run.currentTurnNum)));
    matches.sort((a,b) => Number(b.createdAt || b.dispatchAt || 0) - Number(a.createdAt || a.dispatchAt || 0));
    const attempt = matches[0];
    const pending = attempt && state.pendingPrompts?.[String(attempt.turnNum)]?.[sid];
    const message = attempt && (state.messages || []).find(m => m.role === 'assistant'
      && m.sid === sid && m.attemptId === attempt.attemptId && Number(m.turnNum) === Number(attempt.turnNum));
    const prompt = attempt && pending && pending.attemptId === attempt.attemptId && pending.workflowRun?.runId === run?.runId
      ? pending.prompt : message?.sourcePrompt;
    return { memberId, sid, label: slot.displayName || slot.title || slot.kind || memberId,
      prompt: typeof prompt === 'string' && prompt.trim() ? prompt : '',
      attemptId: attempt?.attemptId, runId: run?.runId, stepIndex: Number(index),
      uncertain: attempt?.status === 'submission_unknown' || attempt?.failure?.category === 'reconciliation',
      stale: state._partialBy?.[sid]?.status === 'soft_alert' };
  }).filter(Boolean);
}

function presentation(run, members, order) {
  const index = run?.currentStepIndex ?? run?.nextStepIndex ?? 0;
  const error = run?.error || run?.lastError;
  const paused = run?.status === 'paused', running = !!run?.running;
  const uncertain = error?.reason === 'submission_unknown' || members.some(m => m.uncertain);
  const stale = running && members.some(m => m.stale);
  const abnormal = uncertain || stale || run?.status === 'unavailable' || (paused && !!error
    && !['interrupted','workflow_stop','user_stop'].includes(error.reason));
  const who = members.map(m => m.label).join('、') || order[index] || '本轮成员';
  const label = uncertain ? `${who} 接收或完成状态待确认`
    : stale ? `${who} 状态可能过期 · 尚未收到本轮结束确认`
    : run?.status === 'unavailable' ? '暂时无法读取发言进度'
    : paused ? (abnormal ? `${who} 本轮未完成，接力已暂停` : '接力已暂停')
    : running ? `正在等 ${who} 回答 · 第 ${Number(index)+1}/${order.length} 轮`
    : '每条新输入都按此顺序回答';
  return { label, abnormal, running, resume: paused && !abnormal };
}
module.exports = { targets, presentation };
