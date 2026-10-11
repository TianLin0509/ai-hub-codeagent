'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const Feed = require('../../core/dev-workbench-feed');
const DP = require('../../renderer/dev-progress');
const FileFlow = require('../../core/dev-file-workflow');
const Delivery = require('../../core/delivery-workflow');
const TaskView = require('../../core/dev-task-view');
const Runtime = require('../../core/session-runtime-truth');
const { createTaskReader } = require('./dev-task-reader');

// 项目卡的标题读项目自己的 .agents/project.json。
// 以前用的是 meeting.workspaceLabel —— 那个字段会被自动标题改写成 AI 的第一句回复
//（实测显示成「好的，收到任务。我先阅读仓库的 `.agents/AUTHO」），一个项目名都看不出来。
// 这是一次极小的定点读取，不是仓库扫描：只读一个文件、按工作目录缓存、拿不到就退回目录名。
const PROJECT_NAME_TTL_MS = 60_000;
const projectNameCache = new Map();
function projectNameOf(workspace, clean) {
  const dir = typeof workspace === 'string' ? workspace.trim() : '';
  if (!dir) return '';
  const cached = projectNameCache.get(dir);
  if (cached && Date.now() - cached.at < PROJECT_NAME_TTL_MS) return cached.name;
  let name = '';
  try { name = clean(JSON.parse(fs.readFileSync(path.join(dir, '.agents', 'project.json'), 'utf8')).name, 120); }
  catch { name = ''; }   // 没整理过的项目、路径不在了、JSON 坏了 —— 一律退回目录名，不报错
  projectNameCache.set(dir, { name, at: Date.now() });
  return name;
}

function createDevWorkbench(deps) {
  const { meetingManager, loopEngine, getHubDataDir, sendToRenderer, logger = console } = deps;
  const summaries = new Map(), revisions = new Map(), dirty = new Set(), queued = new Set(), controls = new Set();
  const readQueue = [], reads = new Map();
  let worker = null, timer = null, activeReads = 0, requestId = 0, sequence = 0, disposed = false;
  const epoch = crypto.randomUUID();
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,255}$/.test(id);
  const errorText = error => Feed.clean(error && error.message || String(error), 1000);
  const log = error => logger.warn('[dev-workbench]', errorText(error));
  const meeting = id => validId(id) ? (meetingManager.getDevWorkbenchRecord
    ? meetingManager.getDevWorkbenchRecord(id) : meetingManager.getMeeting(id)) : null;
  const allMeetings = () => meetingManager.getDevWorkbenchRecords ? meetingManager.getDevWorkbenchRecords() : meetingManager.getAllMeetings?.() || [];
  const taskReader = createTaskReader({ getMeetings:allMeetings, getMeeting:meeting, getRuntime:taskRuntime, getHubDataDir, onChanged:changed, read:readTaskInWorker });
  function readTaskInWorker(dataDir, m) {
    return new Promise((resolve,reject)=>{
      const key=++requestId;
      try{
        const instance=getWorker();
        const timeout=setTimeout(()=>failWorker(new Error('任务文件读取超时，保留最后有效记录')),10000);timeout.unref?.();
        reads.set(key,{timer:timeout,reject,resolve:p=>p.error?reject(new Error(p.error)):resolve(p.task)});
        instance.postMessage({requestId:key,type:'task',dataDir,meeting:m});
      }catch(error){const pending=reads.get(key);if(pending)clearTimeout(pending.timer);reads.delete(key);reject(error);}
    });
  }
  function taskRuntime(m) {
    const truths = (m.subSessions || []).map((sid,i) => {
      const s = deps.sessionManager?.getSession(sid);
      const t = Runtime.getSessionRuntimeTruth(s);
      return { state:t.state, source:t.source, confidence:t.confidence, label:Runtime.runtimeLabel(t.state), memberId:m.slotSpecs?.[i]?.memberId || `m${i+1}` };
    });
    return ['running','starting','waiting','failed','interrupted','unknown','completed','idle','dormant'].map(k=>truths.find(t=>t.state===k)).find(Boolean) || { state:'unknown',label:'运行状态未知' };
  }

  function runtime(m) {
    if (!loopEngine) return { running: false, unavailable: true };
    try { return loopEngine.getStatus(m.id); }
    catch (error) { return { running: false, unavailable: true, error: errorText(error) }; }
  }
  function token(m, live, execution) {
    const sw = m.serialWorkflow || {}, ls = sw.loopState || {};
    return crypto.createHash('sha256').update(JSON.stringify([
      m.id, m.subSessions, m.slotSpecs, sw.enabled, sw.loop, sw.steps, sw.stepConfigs,
      ls.runId, ls.status, ls.currentStep, ls.round, ls.goal, ls.deadlineTs, !!live.running,
      sw.devWorkbenchManual || null, sw.devPhase || null,
      execution?.runId, execution?.attempts?.map(a => [a.attemptId, a.status]),
    ])).digest('hex').slice(0, 24);
  }
  function memberProblem(m) {
    const steps = m.serialWorkflow?.steps;
    if (!Array.isArray(steps)) return '流程步骤缺失，请进入群聊检查设置';
    for (const memberId of steps.flat()) {
      const match = /^m([1-9]\d*)$/.exec(String(memberId));
      const specs = Array.isArray(m.slotSpecs) ? m.slotSpecs : [];
      const index = specs.findIndex((spec, i) => String(spec?.memberId || `m${i + 1}`) === String(memberId));
      const sid = m.subSessions?.[index >= 0 ? index : match ? Number(match[1]) - 1 : -1];
      if (!sid || (deps.sessionManager && !deps.sessionManager.getSession(sid))) {
        return '流程席位缺失，请进入群聊恢复成员后再继续；也可以手动接管';
      }
    }
    return '';
  }
  function makeRow(m) {
    if (FileFlow.enabled(m) || Delivery.enabled(m)) {
      const file = Delivery.enabled(m) ? deps.deliveryEngine?.status(m.id) : deps.fileEngine?.status(m.id);
      const error = file?.error || file?.dispatchError || (!file ? '文件工作流不可用' : '');
      return { id: m.id, title: Feed.clean(m.title, 240) || '开发群聊', workspace: m.workspace,
        project: projectNameOf(m.workspace, Feed.clean), createdAt: m.createdAt, activityAt: m.lastMessageTime || m.createdAt,
        pinned: !!m.pinned, bottomed: !!m.bottomed, goal: '', progress: error || file?.label || '',
        stage: { key: file?.done ? 'passed' : file?.phase || 'unavailable',
          label: `${file?.label || '文件状态不可用'}${file?.paused ? ' · 已暂停，在群聊点「继续」接续' : ''}`,
          tone: error ? 'bad' : file?.done ? 'good' : file?.paused ? 'warn' : file?.running ? 'run' : 'idle', running: !!file?.running },
        flow: { configured: true, phase: file?.phase, round: file?.round, status: file?.paused ? 'paused' : '', currentStep: file?.phase },
        attention: error ? { kind: 'error', label: '执行需处理', text: error } : null,
        ask: '', plan: '', blockers: '', report: '', chronicle: summaries.get(m.id)?.summary?.timeline || [],
        lastError: error, loading: false, controlToken: JSON.stringify(file), actions: {} };
    }
    const sw = m.serialWorkflow && typeof m.serialWorkflow === 'object' ? m.serialWorkflow : {};
    const ls = sw.loopState && typeof sw.loopState === 'object' ? sw.loopState : {};
    const live = runtime(m), saved = summaries.get(m.id) || {};
    const summary = saved.summary || {}, card = summary.card, review = summary.review, update = summary.update;
    let stage = DP.deriveStage(m);
    if (live.unavailable) stage = { ...stage, key: 'unavailable', label: '执行状态暂不可用', tone: 'bad', running: false };
    else if (sw.devWorkbenchManual && !live.running) stage = { ...stage, key: 'manual', label: '手动处理', tone: 'idle', running: false };
    else if (!live.running && ls.status === 'running') stage = { ...stage, key: 'interrupted', label: '运行已中断，可恢复', tone: 'bad', running: false };
    else if (live.running && stage.tone !== 'run') stage = { ...stage, key: 'settling', label: '正在结束当前流程', tone: 'run', running: true };
    if (m.metadataError && !live.running) stage = { ...stage, key: 'damaged', label: '任务信息需要检查', tone: 'bad', running: false };
    const execution = summary.execution || null;
    const activeAttempts = (Array.isArray(execution?.attempts) ? execution.attempts : []).filter(a => !['completed', 'failed', 'interrupted', 'superseded', 'absent'].includes(a.status));
    if (!live.running && !live.unavailable && activeAttempts.length && !m.metadataError) {
      const recovering = !!saved.hydrated || activeAttempts.some(a => a.status === 'recovering');
      stage = { ...stage, key: recovering ? 'recovering' : 'chatting', label: recovering ? '群聊尝试待恢复' : sw.devWorkbenchManual ? '手动处理 · 群聊进行中' : sw.devPhase === 'discuss' ? '讨论进行中' : '群聊进行中', tone: recovering ? 'bad' : 'run', running: !recovering };
    }
    if (!live.running && !live.unavailable && !activeAttempts.length && execution?.hasFailures && stage.key === 'passed') {
      stage = { ...stage, key: 'chatFailed', label: '最近群聊执行失败', tone: 'bad', running: false };
    }
    const progressSource = [update, card, review].filter(Boolean).sort((a, b) => (Number(b.index) || 0) - (Number(a.index) || 0))[0];
    const progress = !progressSource ? '' : progressSource === review
      ? (review.decision === 'pass' ? '审核通过' : '审核要求修订') + '：' + (review.blockers || review.verified || review.next || '请查看审核记录')
      : progressSource === update ? update.text : card.progress;
    const failedReview = review && review.decision === 'fail' ? review : null;
    const reportSource = review && review.report && (!card || !card.report || review.index >= card.index) ? review : card;
    // 讨论阶段不给「恢复」：恢复的是旧目标，会绕过「开工」那一步的任务说明确认（2026-09-06 合并位复现）。
    const resumeCandidate = !live.running && !live.unavailable && !sw.devWorkbenchManual && sw.loop && sw.loop.enabled
      && sw.devPhase !== 'discuss'
      && ['paused', 'running', 'stopped_user', 'reviewer_unavailable'].includes(ls.status) && !!ls.goal
      && !(ls.deadlineTs && Date.now() >= ls.deadlineTs);
    const missingMember = resumeCandidate ? memberProblem(m) : '';
    const canResume = resumeCandidate && !missingMember && stage.key !== 'chatting';
    const lastError = missingMember || Feed.clean(ls.lastError && (ls.lastError.reason || ls.lastError.message), 1000)
      || Feed.clean(execution?.attempts?.find(a => a.failure?.summary)?.failure?.summary, 1000);
    // 「需要我」—— 维护者每天只想扫这一行就知道要不要进群聊。
    // 以前这条筛选只看阶段色调，于是「工作位实现中 + 一条合并冲突提示」被算成不需要处理，
    // 屏幕上明明是红字，计数却是 0。现在只要行里有红/橙的东西，它就该被数进来。
    const pendingAsk = summary.ask && Number(summary.ask.index) > Number(summary.lastUserIndex ?? -1) ? summary.ask : null;
    const attention = pendingAsk ? { kind: 'ask', label: '需要你拍板', text: pendingAsk.text }
      : stage.tone === 'bad' ? { kind: 'stage', label: '需要你处理', text: lastError || stage.label }
        : lastError ? { kind: 'error', label: '需要你处理', text: lastError }
          : failedReview && failedReview.blockers ? { kind: 'blockers', label: '审核打回', text: failedReview.blockers }
            : stage.tone === 'warn' ? { kind: 'stage', label: '需要你留意', text: stage.label } : null;
    return {
      id: m.id, title: Feed.clean(m.title, 240) || '未命名开发群聊', workspace: Feed.clean(m.workspace, 2048),
      project: projectNameOf(m.workspace, Feed.clean), goal: Feed.clean(ls.goal, 4096), stage,
      createdAt: Number(m.createdAt) || 0, pinned: !!m.pinned, bottomed: !!m.bottomed && !m.pinned,
      activityAt: Math.max(...[m.createdAt, m.lastMessageTime, m.lastCompletedAt, ls.updatedAt, ls.startedAt, ls.finishedAt, execution?.updatedAt, card?.at, review?.at, update?.at,
        ...(Array.isArray(execution?.attempts) ? execution.attempts.map(a => a.updatedAt) : [])].map(t => Number(t) || 0)),
      execution, flow: { currentStep: ls.currentStep || '', configured: !!sw.loop?.enabled || !!sw.devWorkbenchManual,
        status: ls.status || '', manual: !!sw.devWorkbenchManual, round: Number(ls.round) || 0, maxRounds: Number(sw.loop?.maxRounds) || 3,
        phase: sw.devPhase === 'discuss' ? 'discuss' : 'build' },
      progress,
      card: card || null, review: review || null, progressSource: progressSource || null,
      // 人话通道：方案、待拍板的问题、按时间排开的任务纪事。全部由群聊消息派生，不新增存储。
      plan: summary.plan ? summary.plan.text : '', ask: pendingAsk ? pendingAsk.text : '',
      chronicle: Array.isArray(summary.timeline) ? summary.timeline : [], attention,
      blockers: failedReview ? failedReview.blockers : '', report: reportSource && reportSource.report || '',
      lastError,
      receivedAt: saved.receivedAt || 0, feedError: m.metadataError || saved.error || '', loading: !summaries.has(m.id),
      truncated: !!summary.truncated, controlToken: token(m, live, execution),
      actions: { stop: !!live.running || ls.status === 'running', resume: !!canResume,
        takeover: !live.unavailable && !sw.devWorkbenchManual && !!(sw.loop && sw.loop.enabled),
        restore: !live.unavailable && !live.running && !!sw.devWorkbenchManual },
    };
  }
  function safeRow(m) {
    try {
      if(Delivery.enabled(m)){
        const row=makeRow(m),file=deps.deliveryEngine?.status(m.id);
        return {...row,scope:file?.finished?'history':'current',mode:'文件交付',notice:row.lastError || '',basis:'逐成员交付文件与持久化执行记录',
          source:{name:'文件交付记录'},runtime:taskRuntime(m),quality:file?'fresh':'stale'};
      }
      if (FileFlow.enabled(m)) {
        const flow=m.serialWorkflow?.fileFlow || {};
        const row = TaskView.projectFileRow(m, taskReader.get(m), taskRuntime(m), { paused:flow.paused, dispatchError:flow.error });
        return { id:m.id, workspace:m.workspace || '', project:projectNameOf(m.workspace,Feed.clean), createdAt:m.createdAt, ...row };
      }
      const row = makeRow(m);
      const scope = ['passed','stopped','stoppedUser'].includes(row.stage.key) ? 'history' : row.flow.phase==='discuss' ? 'discuss' : 'current';
      // Legacy reports remain readable, but legacy ASK / FAIL is not a new user decision.
      return { ...row, scope, mode:'旧协议', attention:null, notice:row.feedError || row.lastError || '', actions:{},
        basis:'旧协议记录；阶段和报告尚未按文件工作流核对', source:{name:'旧群聊汇报',at:row.progressSource?.at || 0},
        runtime:taskRuntime(m), quality:row.feedError?'stale':row.loading?'loading':'fresh' };
    }
    catch (error) {
      log(error);
      return { id: m.id, title: Feed.clean(m.title, 240) || '开发群聊', stage: { key: 'damaged', tone: 'bad', label: '任务数据异常' },
        feedError: '这条任务暂时无法显示：' + errorText(error), actions: {}, controlToken: '' };
    }
  }
  function flush() {
    timer = null;
    if (disposed || !dirty.size) return;
    const ids = [...dirty].slice(0, 100), rows = [], removed = [];
    for (const id of ids) {
      dirty.delete(id);
      const m = meeting(id);
      if (DP.isDevMeeting(m)) rows.push(safeRow(m));
      else { removed.push(id); summaries.delete(id); revisions.delete(id); }
    }
    try { sendToRenderer('dev-workbench:changed', { epoch, sequence: ++sequence, rows, removed }); }
    catch (error) { log(error); } // Renderer reload gets a full snapshot from the same cache.
    if (dirty.size) schedule();
  }
  function schedule() { if (!timer && !disposed) { timer = setTimeout(flush, 60); timer.unref?.(); } }
  function changed(id) { if (validId(id)) { dirty.add(id); schedule(); } }

  function failWorker(error) {
    const old = worker; worker = null;
    for (const pending of reads.values()) { clearTimeout(pending.timer); pending.reject(error); }
    reads.clear();
    if (old) void old.terminate().catch(log);
  }
  function getWorker() {
    if (worker) return worker;
    const instance = new Worker(path.join(__dirname, '../../core/dev-workbench-reader-worker.js'));
    worker = instance;
    instance.on('message', payload => {
      const pending = reads.get(payload.requestId); if (!pending) return;
      reads.delete(payload.requestId); clearTimeout(pending.timer); pending.resolve(payload);
    });
    instance.on('error', error => { if (worker === instance) failWorker(error); });
    instance.on('exit', code => { if (worker === instance) failWorker(new Error('群聊摘要读取进程退出：' + code)); });
    instance.unref();
    return instance;
  }
  function readSummary(id) {
    if (typeof deps.readSummary === 'function') return deps.readSummary(id);
    return new Promise((resolve, reject) => {
      const key = ++requestId;
      try {
        const instance = getWorker();
        const timeout = setTimeout(() => failWorker(new Error('读取该群聊摘要超时，可以重新载入')), 8000);
        timeout.unref?.();
        reads.set(key, { resolve, reject, timer: timeout });
        instance.postMessage({ requestId: key, file: path.join(getHubDataDir(), 'arena-prompts', id + '-groupchat.json') });
      } catch (error) { const pending = reads.get(key); if (pending) clearTimeout(pending.timer); reads.delete(key); reject(error); }
    });
  }
  function pump() {
    while (!disposed && activeReads < 2 && readQueue.length) {
      const id = readQueue.shift(); queued.delete(id);
      if (!DP.isDevMeeting(meeting(id)) || summaries.has(id)) continue;
      const revision = revisions.get(id) || 0; activeReads++;
      Promise.resolve().then(() => readSummary(id)).then(result => {
        if (disposed || (revisions.get(id) || 0) !== revision || !DP.isDevMeeting(meeting(id))) return;
        summaries.set(id, { summary: result.summary || null, error: result.error || '', receivedAt: 0, hydrated: true }); changed(id);
      }).catch(error => {
        if (!disposed && (revisions.get(id) || 0) === revision && DP.isDevMeeting(meeting(id))) {
          summaries.set(id, { error: errorText(error) }); changed(id); log(error);
        }
      }).finally(() => { activeReads--; pump(); });
    }
  }
  function queue(id) { if (!summaries.has(id) && !queued.has(id)) { queued.add(id); readQueue.push(id); } }
  function ingest({ hubDataDir, meetingId, summary }) {
    if (disposed || path.resolve(hubDataDir) !== path.resolve(getHubDataDir()) || !DP.isDevMeeting(meeting(meetingId))) return;
    const previous = summaries.get(meetingId)?.summary;
    if (previous && Number(previous.revision) > Number(summary?.revision || 0)) return;
    revisions.set(meetingId, (revisions.get(meetingId) || 0) + 1);
    summaries.set(meetingId, { summary, receivedAt: Date.now(), error: '' }); changed(meetingId);
  }
  const unsubscribe = Feed.subscribe(ingest);
  function snapshot({ retryErrors = false } = {}) {
    const meetings = meetingManager.getDevWorkbenchRecords
      ? meetingManager.getDevWorkbenchRecords() : meetingManager.getAllMeetings();
    if (!Array.isArray(meetings)) throw new Error('开发群聊列表格式无效');
    const devs = meetings.filter(DP.isDevMeeting);
    for (const m of devs) {
      if (retryErrors && summaries.get(m.id)?.error) summaries.delete(m.id);
      if (!FileFlow.enabled(m) && !Delivery.enabled(m)) queue(m.id);
    }
    pump();
    return { ok: true, epoch, sequence, rows: devs.map(safeRow) };
  }
  function handleEvent(channel, data) {
    if (disposed || !data) return;
    if (channel==='session-updated') {
      const sid=data.session?.id || data.sid;
      if (!sid) return;
      if (meetingManager.getMeetingIdsForSession) { for (const id of meetingManager.getMeetingIdsForSession(sid)) changed(id); }
      else for(const m of allMeetings()) if(m.subSessions?.includes(sid)) changed(m.id);
      return;
    }
    const channels = ['delivery:changed', 'loop:progress', 'workflow:progress', 'meeting-created', 'meeting-updated', 'meeting-closed', 'meeting-created-with-errors'];
    if (!channels.includes(channel)) return;
    const id = data.meetingId || data.meeting?.id;
    if (!validId(id)) return;
    const m=meeting(id);if(FileFlow.enabled(m))taskReader.enqueue(m);
    if (DP.isDevMeeting(m) && !FileFlow.enabled(m) && !Delivery.enabled(m)) { queue(id); pump(); }
    changed(id);
  }

  async function action(args = {}) {
    const { meetingId: id, action: name, controlToken } = args;
    if (!validId(id)) return { ok: false, reason: '任务标识无效' };
    if (controls.has(id)) return { ok: false, reason: '这条任务的上一项操作尚未完成，其他任务可以继续处理' };
    controls.add(id);
    try {
      let m = meeting(id);
      if (!DP.isDevMeeting(m)) return { ok: false, reason: '该开发群聊已关闭或已切换场景' };
      if (['pin', 'unpin', 'bottom', 'unbottom'].includes(name)) {
        const updated = meetingManager.updateMeeting(id, { pinned: name === 'pin', bottomed: name === 'bottom' });
        if (!updated) throw new Error('任务排序保存失败');
        sendToRenderer('meeting-updated', { meeting: updated }); changed(id);
        return { ok: true, message: name === 'pin' ? '任务已置顶' : name === 'bottom' ? '任务已置底' : '已恢复按时间排序' };
      }
      if (!loopEngine) return { ok: false, reason: '执行引擎不可用，请进入群聊处理' };
      const row = makeRow(m);
      if (!controlToken || controlToken !== row.controlToken) return { ok: false, reason: '任务阶段已变化，请查看更新后的状态再操作', stale: true };
      if (!row.actions[name]) return { ok: false, reason: '当前阶段不支持此操作，请进入群聊处理' };
      if (name === 'stop' || name === 'takeover') {
        if (loopEngine.isRunning(id)) {
          const stopped = loopEngine.stopLoop(id, { interrupt: true });
          if (!stopped) return { ok: false, reason: '停止请求未被执行端接受，请进入群聊处理' };
          const until = Date.now() + 1800;
          while (loopEngine.isRunning(id) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
          if (loopEngine.isRunning(id)) return { ok: true, pending: true, message: name === 'takeover'
            ? '停止请求已发送，仍等待执行端确认；尚未切换为手动处理。可进入群聊检查。'
            : '停止请求已发送，仍等待执行端确认。可进入群聊检查。' };
        }
        m = meeting(id);
        if (!DP.isDevMeeting(m)) return { ok: false, reason: '任务已关闭' };
        const sw = m.serialWorkflow || {}, ls = sw.loopState || {};
        const next = { ...sw, loopState: ls.status === 'running' ? { ...ls, status: 'stopped_user' } : ls };
        if (name === 'takeover') {
          next.devWorkbenchManual = { enabled: sw.enabled, loopEnabled: sw.loop?.enabled, at: Date.now() };
          next.enabled = false; next.loop = { ...sw.loop, enabled: false };
        }
        const updated = meetingManager.updateMeeting(id, { serialWorkflow: next });
        if (!updated) throw new Error('任务设置保存失败');
        sendToRenderer('meeting-updated', { meeting: updated }); changed(id);
        return { ok: true, message: name === 'takeover' ? '已停止自动流程并切换为手动处理；群聊、成员、工作树和历史均保留。' : '流程已停止，已有成果和群聊记录保留。' };
      }
      if (name === 'restore') {
        const sw = m.serialWorkflow, backup = sw.devWorkbenchManual;
        const next = { ...sw, enabled: backup.enabled, loop: { ...sw.loop, enabled: backup.loopEnabled } };
        delete next.devWorkbenchManual;
        const updated = meetingManager.updateMeeting(id, { serialWorkflow: next });
        if (!updated) throw new Error('自动流程设置恢复失败');
        sendToRenderer('meeting-updated', { meeting: updated }); changed(id);
        return { ok: true, message: '原自动流程设置已恢复；尚未派发任务。可继续中断流程，或回群聊布置新要求。' };
      }
      if (name === 'resume') {
        // 讨论阶段恢复的是旧目标，会绕过「开工」的任务说明确认；引擎也拦，这里给人话原因
        if (m.serialWorkflow.devPhase === 'discuss') return { ok: false, reason: '讨论阶段不能恢复旧循环；回群聊点「开工」确认任务说明后再进入实现' };
        const validation = loopEngine.validateLoop(id);
        if (!validation.ok) return { ok: false, reason: validation.reason };
        // 工作台点「恢复」也是用户明确要求继续 → 清掉落盘的停止意图，否则引擎会立刻又停下。
        try { if (typeof loopEngine.clearStopIntent === 'function') loopEngine.clearStopIntent(id); }
        catch (error) { log(error); }
        const ls = m.serialWorkflow.loopState;
        const run = loopEngine.runLoop(id, null, { ...ls, status: 'running', stepAttempt: 0, lastError: null });
        Promise.resolve(run).catch(error => { log(error); changed(id); });
        if (!loopEngine.isRunning(id)) return { ok: false, reason: '恢复尚未启动，请进入群聊检查席位和流程配置' };
        changed(id);
        return { ok: true, message: '已按原任务与既有执行记录恢复流程；保留审核历史，不重置返工额度。' };
      }
      return { ok: false, reason: '不支持的任务操作' };
    } catch (error) { log(error); return { ok: false, reason: errorText(error) }; }
    finally { controls.delete(id); changed(id); }
  }
  function registerIpc(ipcMain) {
    ipcMain.handle('dev-workbench:get-snapshot', (_event, args) => {
      try { return snapshot(args && typeof args === 'object' ? args : {}); }
      catch (error) { log(error); return { ok: false, reason: errorText(error) }; }
    });
    // The workbench is read-only. Keep old internal helpers for compatibility,
    // but never expose dispatch or meeting mutation through its IPC surface.
    ipcMain.handle('dev-workbench:action', () => ({ ok:false, reason:'工作台只读，请在原群聊操作' }));
    ipcMain.handle('dev-workbench:read-source', async (_event, args={}) => {
      try {
        const m=meeting(args.meetingId);if(!FileFlow.enabled(m))throw new Error('该任务没有文件来源');
        const row=safeRow(m), name=row.source?.name;
        if(!name)throw new Error('尚无当前阶段的任务记录');
        const dir=FileFlow.directory(getHubDataDir(),m.id);
        const raw=await TaskView.readText(dir,path.join(dir,name));
        return {ok:true,name,text:raw.text,hash:raw.hash,at:raw.at};
      }catch(error){return {ok:false,reason:errorText(error)};}
    });
  }
  function dispose() { disposed = true; taskReader.dispose(); unsubscribe(); if (timer) clearTimeout(timer); failWorker(new Error('工作台已关闭')); }
  return { snapshot, action, handleEvent, registerIpc, dispose, ingest, flush, changed, _test: { makeRow, summaries, controls } };
}
module.exports = { createDevWorkbench };
