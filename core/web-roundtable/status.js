'use strict';
const path = require('path');
function providerStatus(provider) {
  const p = require('./providers').get(provider), root = require('../hub-chrome').defaultRoot();
  const guard = require('../web-risk-guard'), paused = guard.blocked(root, 'main', provider), handoff = guard.handoff(root);
  const waiting = require('./recovery').list(require('./store').dataDir()).filter(t => t.provider === provider);
  return { provider, name: p.name, profile: path.join(root, 'main'), identity: 'main', loginSource: 'ai-hub-accounts', authentication: 'not_checked',
    automation: handoff ? 'human_handoff' : paused ? 'verification_required' : 'not_checked', retryAt: handoff?.until || paused?.until || null,
    waitingTasks: waiting.length, capabilities: ['ask','same_conversation_followup','collect','resume','cancel'],
    nextAction: handoff ? '完成人工操作并关闭专属窗口后继续原任务' : paused ? '在 Hub 账号页对应网站点去验证，完成后复核并继续原任务' : waiting.length ? '在 Hub 账号页复核并继续原任务；已发送问题只补收原会话' : '可提交问题；首次真实访问才确认登录和额度',
    mode: 'shared Hub Chrome; account checks use headless inspection' };
}
function progress(job) {
  return { ...job, progress: { phase: job.phase || job.state, completedRounds: job.rounds?.length || 0, requestedRounds: job.input.rounds,
    participants: job.input.providers.map(provider => {
      const flight = job.inFlight?.[provider];
      let child = null; if (flight?.task_id) try { child = require('./jobs').status(flight.task_id); } catch {}
      const result = job.rounds?.at(-1)?.results?.find(r=>r.provider === provider);
      const current = child || result;
      return { provider, state: current?.state || flight?.state || 'queued', taskId: current?.id || flight?.task_id || null,
        errorCode: current?.errorCode || null,
        nextAction: current?.errorCode === 'quota_exhausted' ? '等待该网站额度恢复；无需因此重新登录，保留其他成员回答' : current?.recovery ? current.submissionAttempted ? '验证后只补收原回答' : '验证后继续原提问' : current?.state === 'failed' || current?.state === 'interrupted' ? '核对原任务，已发送问题只补收' : null };
    }) } };
}
async function readProgress(id, waitSeconds = 0) {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 20) throw Error('wait_seconds must be an integer from 0 to 20');
  const jobs=require('./jobs'), store=require('./store'), end=Date.now()+waitSeconds*1000;
  let value=progress(jobs.status(id));
  const initial=JSON.stringify(value.progress);
  while (!jobs.terminal.has(value.state) && Date.now()<end) {
    await store.sleep(Math.min(500,end-Date.now())); value=progress(jobs.status(id));
    if (JSON.stringify(value.progress)!==initial) break;
  }
  return value;
}
module.exports = { providerStatus, progress, readProgress };
