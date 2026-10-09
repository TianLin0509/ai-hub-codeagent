'use strict';

// Presentation only: elapsed time never changes execution/connection truth.
function backstageStatus(session, now = Date.now()) {
  const r = session?.nativeRuntime || {};
  const provider = require('./native-ui-labels').nativeUiLabel(session);
  const submission = r.submission || {};
  const delivery = submission.status || submission.sendStatus;
  let state = r.state || 'unknown', title, detail, animated = false;
  if (session?.status === 'dormant') {
    state = 'dormant'; title = '会话已关闭'; detail = '当前没有运行此会话，重新打开后恢复。';
  } else if (r.connection === 'unstarted') {
    state = 'idle'; title = '等待任务'; detail = '收到消息后启动。';
  } else if (r.connection === 'disconnected') {
    state = 'unknown'; title = '连接已断开 · 状态待核对'; detail = r.reason || '无法确认是否仍在运行，请在下方核对连接。';
  } else if (delivery === 'unknown' || r.cancellation?.status === 'unknown') {
    state = 'unknown'; title = '状态待核对'; detail = submission.error || r.reason || '引擎尚未确认当前状态。';
  } else if (r.connection === 'connecting') {
    state = 'connecting'; title = '正在连接'; detail = r.reason || '等待原生会话连接确认。'; animated = true;
  } else if (r.connection !== 'connected') {
    state = 'unknown'; title = '状态待核对'; detail = r.reason || '尚未收到原生会话状态。';
  } else if (r.configurationChange) {
    state = r.configurationChange.status === 'unknown' ? 'unknown' : 'configuring';
    title = state === 'unknown' ? '设置结果待核对' : '正在更新设置';
    detail = '等待引擎确认设置；确认前不发送新任务，晚到回执仍会更新实际设置。';
    animated = state !== 'unknown';
  } else if (r.cancellation?.status === 'pending') {
    state = 'stopping'; title = '正在停止'; detail = '停止请求已发出，等待引擎确认。'; animated = true;
  } else if (delivery === 'submitting') {
    state = 'starting'; title = '正在发送'; detail = '正在提交消息，尚未收到确认。'; animated = true;
  } else if (delivery === 'rejected' && !['running','waiting'].includes(state)) {
    state = 'failed'; title = '发送失败'; detail = submission.error || '引擎未接受本次消息。';
  } else if (state === 'starting') {
    title = delivery === 'accepted' ? '已收到 · 等待开始' : '正在发送';
    detail = delivery === 'accepted' ? '引擎已确认收到消息，暂未输出正文。' : '等待引擎确认收到消息。'; animated = true;
  } else if (state === 'running') {
    title = '思考 / 执行中'; detail = '引擎已开始本轮，尚未收到完成信号。'; animated = true;
  } else if (state === 'waiting') {
    title = '等待你确认'; detail = '请在下方处理审批或问题，处理后继续。';
  } else if (state === 'completed') {
    title = '已完成'; detail = '本轮已经结束，可以继续发送消息。';
  } else if (state === 'interrupted') {
    title = '已停止'; detail = '引擎已确认本轮中断。';
  } else if (state === 'failed' || delivery === 'rejected') {
    state = 'failed'; title = '执行失败'; detail = submission.error || r.reason || '请查看错误信息。';
  } else if (state === 'idle') {
    title = '就绪 · 等待任务'; detail = '当前没有正在执行的任务。';
  } else {
    state = 'unknown'; title = '状态待核对'; detail = r.reason || '引擎尚未确认当前状态。';
  }
  const startedAt = state === 'starting' ? submission.submittedAt || r.observedAt
    : state === 'connecting' ? r.observedAt : r.startedAt;
  const seconds = animated && Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;
  const elapsed = seconds == null ? '' : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const contentAge = require('./native-feedback').nativeContentAge(session, now);
  if (contentAge) detail = `${detail} ${contentAge}。`;
  return { state, provider, title, detail, animated, elapsed, engaged: !['idle','dormant'].includes(state) };
}
module.exports = { backstageStatus };
