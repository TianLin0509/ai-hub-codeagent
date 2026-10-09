'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { nativeSessionIdentity, supportsRecoverableSession } = require('./session-capabilities');

const ARG = '--hub-restart=';
const CONTINUE_PROMPT = '刚才因 AI Hub 重启中断。请依据本会话现有对话，继续完成尚未完成的任务。先核对最后一步的实际执行结果、文件与工具状态，避免重复执行已完成操作；不要重新开始整个任务。若任务已经完成，请报告完成结果；若缺少必要审批或用户回答，请继续等待用户。';
const clone = value => JSON.parse(JSON.stringify(value));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };

function restartToken(argv = process.argv) {
  const value = argv.find(a => a.startsWith(ARG))?.slice(ARG.length);
  if (!value) return null;
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error('重启恢复标识无效');
  return value;
}

function classify(session) {
  const r = session.nativeRuntime;
  if (r) {
    if (r.state === 'waiting' || (r.requests || []).some(q => q.params?.isBlocking !== false)) return 'waiting';
    if (r.connection !== 'connected' && r.connection !== 'unstarted') return 'unknown';
    if (['unknown', 'submitting','queued'].includes(r.submission?.status || r.submission?.sendStatus) || ['unknown','starting'].includes(r.state)) return 'unknown';
    return r.state === 'running' ? 'working' : 'idle';
  }
  if (session.restartLegacyState) return session.restartLegacyState;
  // Legacy providers have no native submission receipts. Restore them, but do
  // not guess whether an interrupted command was accepted from terminal text.
  return session.status === 'running' ? 'unknown' : 'idle';
}

class HubRestart {
  constructor({ directory, sessions, loadSession, restoreSession, prepareContinuation, sendContinuation,
    captureGroups = () => [], resumeGroup, quiesce = () => {}, flush = async () => {},
    shutdown, publish = () => {}, pid = process.pid, isAlive = alive }) {
    Object.assign(this, { directory, sessions, loadSession, restoreSession, prepareContinuation,
      sendContinuation, captureGroups, resumeGroup, quiesce, flush, shutdown, publish, pid, isAlive });
    this.plan = null;
    this.busy = null;
  }
  filename(token) {
    if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('重启恢复标识无效');
    return path.join(this.directory, 'restart', token + '.json');
  }
  save() {
    const file = this.filename(this.plan.token);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + this.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(this.plan, null, 2), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    this.publish(this.snapshot());
  }
  snapshot() { return this.plan ? clone(this.plan) : null; }
  request(view = {}) {
    if (this.busy) return this.busy;
    this.busy = this._request(view).finally(() => { this.busy = null; });
    return this.busy;
  }
  async _request(view) {
    if (this.plan && ['preparing','ready'].includes(this.plan.phase)) throw new Error('正在重启，请勿重复操作');
    if (this.plan?.phase === 'failed') {
      this.plan.phase = 'preparing';
      delete this.plan.error;
    } else {
    const live = this.sessions().filter(s => s.status !== 'dormant');
    const rows = live.map(s => ({ id:s.id, title:s.title || s.kind, identity:nativeSessionIdentity(s),
      recoverable:supportsRecoverableSession(s), before:!s.nativeRuntime && view.waitingSessionIds?.includes(s.id) ? 'waiting' : classify(s), meetingId:s.meetingId || null,
      unstarted:s.nativeRuntime?.connection === 'unstarted' && !s.nativeRuntime?.turnId,
      turnId:s.nativeRuntime?.turnId || null, submissionId:s.nativeRuntime?.submission?.id || s.nativeRuntime?.submission?.submissionId || null,
      status:'pending', message:'' }));
    this.plan = { version:1, token:randomUUID(), ownerPid:this.pid, createdAt:Date.now(), phase:'preparing',
      view:clone(view), sessions:rows, groups:clone(this.captureGroups(rows)) };
    }
    try {
      this.save(); // Do not interrupt anything until the restart intent is durable.
      await this.quiesce(this.plan);
      await this.flush();
      const result = await this.shutdown(this.plan);
      if (!result?.safeToQuit || result.cleanup?.clean === false) throw new Error(result?.error || '保存或停止未完成，已取消重启');
      return { ok:true, token:this.plan.token };
    } catch (error) {
      this.plan.phase = 'failed'; this.plan.error = error.message;
      try { this.save(); } catch (saveError) { error.message += '; 保存失败记录也未成功: ' + saveError.message; }
      throw error;
    }
  }
  ready() { this.plan.phase = 'ready'; this.save(); }
  restore(token) {
    if (this.busy) return this.busy;
    this.busy = this._restore(token).finally(() => { this.busy = null; });
    return this.busy;
  }
  async _restore(token) {
    const plan = JSON.parse(fs.readFileSync(this.filename(token), 'utf8'));
    if (plan.version !== 1 || plan.token !== token || !Array.isArray(plan.sessions) || !Array.isArray(plan.groups)) throw new Error('重启现场格式无效');
    if (plan.ownerPid !== this.pid && this.isAlive(plan.ownerPid)) throw new Error('旧 Hub 尚未退出，未接管会话');
    if (plan.restorerPid && plan.restorerPid !== this.pid && this.isAlive(plan.restorerPid)) throw new Error('另一 Hub 正在恢复这个现场');
    if (!['ready','restoring','done'].includes(plan.phase)) throw new Error('重启现场尚未保存完成');
    this.plan = plan;
    const newRestorer=plan.restorerPid !== this.pid;
    if (plan.phase === 'done' && !newRestorer) return this.snapshot();
    plan.restorerPid = this.pid; plan.phase = 'restoring'; this.save();
    for (const row of plan.sessions) {
      if (row.status==='unsupported') continue;
      if (!newRestorer && ['continued','completed','waiting','uncertain'].includes(row.status)) continue;
      const previousStatus=row.status;
      if(['dispatching','continued','uncertain'].includes(previousStatus))row.continuationAttempted=true;
      try {
        if (!row.recoverable || (!row.identity && !row.unstarted)) {
          row.status='unsupported'; row.message='缺少可精确恢复的原生会话身份，未新建替代会话'; this.save(); continue;
        }
        const meta = this.loadSession(row.id);
        const identity = nativeSessionIdentity(meta);
        if (!meta || identity?.family !== row.identity?.family || identity?.value !== row.identity?.value) throw new Error('原生身份已变化，未恢复其他会话');
        const session = await this.restoreSession(meta);
        if (!session || session.ok === false) throw new Error(session?.message || '会话恢复失败');
        if (row.continuationAttempted) {
          row.status='uncertain';row.message='续作曾提交或可能已提交，已恢复会话供核对；未自动重发';this.save();continue;
        }
        if (previousStatus==='completed') {row.status='completed';this.save();continue;}
        row.status='restored'; row.message='已恢复'; this.save();
        if (row.before === 'waiting' || row.before === 'unknown') {
          row.status='waiting'; row.message=row.before === 'waiting' ? '原任务等待审批或回答，请在会话中核对后继续' : '原提交状态待核对，未自动发送'; this.save();
        }
      } catch (error) { row.status='error'; row.message=error.message; this.save(); }
    }
    const grouped = new Set(plan.groups.flatMap(g => g.sessionIds));
    for (const row of plan.sessions) {
      if (grouped.has(row.id) || row.status !== 'restored' || row.before !== 'working') continue;
      await this.continueRow(row);
    }
    for (const group of plan.groups) {
      if(newRestorer && group.status==='continued'){
        group.status='uncertain';group.message='群聊续作曾提交，已恢复成员供核对；未重复派工';this.save();
      }
      if (['continued','completed','waiting','uncertain'].includes(group.status)) continue;
      if (group.status === 'dispatching') { group.status='uncertain'; group.message='群聊续作可能已提交，未重复派工'; this.save(); continue; }
      const members = plan.sessions.filter(s => group.sessionIds.includes(s.id));
      if (members.some(s => !['restored','completed'].includes(s.status))) {
        group.status='waiting'; group.message='有成员恢复失败或待核对，保留群聊阶段'; this.save(); continue;
      }
      try {
        for (const row of members.filter(s => s.before === 'working')) {
          const outcome = await this.prepareContinuation(row);
          if (outcome?.completed) { row.status='completed'; row.message='原任务已完成，无需续作'; }
        }
        group.status='dispatching'; this.save();
        const outcome=await this.resumeGroup(group, CONTINUE_PROMPT, plan.token);
        group.status=outcome?.completed ? 'completed' : 'continued';
        group.message=outcome?.completed ? '当前阶段已完成，无需重复派工' : '已确认群聊当前阶段续作';
      } catch (error) { group.status='uncertain'; group.message=error.message; }
      this.save();
    }
    plan.phase='done'; this.save();
    return this.snapshot();
  }
  async continueRow(row) {
    try {
      const outcome = await this.prepareContinuation(row);
      if (outcome?.completed) { row.status='completed'; row.message='原任务已完成，无需续作'; this.save(); return; }
      row.status='dispatching';row.continuationAttempted=true; this.save();
      const result = await this.sendContinuation(row, CONTINUE_PROMPT, 'restart:' + this.plan.token + ':' + row.id);
      // PTY Claude / Codex 的语义确认来自 hook（UserPromptSubmit）或 rollout 的 task_started；
      // 只凭屏幕推断的 pty-* 来源仍不算，照旧报待核对、不重发。
      const accepted = ['accepted','submitted','running','completed'].includes(result?.sendStatus)
        || (['ok','auto_recovered'].includes(result?.sendStatus) && ['codex-app-server','claude-stream-json','acp','kimi_wire_turn_prompt','gemini_user_message','user_message','item_completed_user_message',
          'claude-user-prompt-submit','codex-user-prompt-submit','task_started'].includes(result.acknowledgementSource));
      if (!result?.ok || !accepted) throw new Error(result?.message || result?.error || '续作未得到原生提交确认，未自动重发');
      row.status='continued'; row.message='已确认提交续作';
    } catch (error) { row.status=row.status === 'dispatching' ? 'uncertain' : 'error'; row.message=error.message; }
    this.save();
  }
}

module.exports = { HubRestart, restartToken, CONTINUE_PROMPT, classify, ARG };
