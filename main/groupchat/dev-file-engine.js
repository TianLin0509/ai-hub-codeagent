'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const F = require('../../core/dev-file-workflow');
const Settings = require('../../core/workflow-settings');
const { getSessionRuntimeTruth } = require('../../core/session-runtime-truth');

const CONTINUE_NOTE = '继续：接续当前阶段，复用已有成果，已交付的不重做。';
// Budgets written before 2026-09-28 counted execution rounds (kickoff, every
// build and every review). Convert once to the reviews finished at that grant.
function reviewBudgetStart(runtime) {
  if (Number.isSafeInteger(runtime.reviewBudgetStart)) return runtime.reviewBudgetStart;
  const old = Number(runtime.budgetStart) || 0;
  return old > 0 ? Math.floor((old - 1) / 2) : 0;
}

function createDevFileEngine({ meetingManager, sessionManager, getHubDataDir, getDispatcher, ensureMemberReady, getMembers, deliveryEngine, isWorkflowRunning = () => false, stopWorkflow,
  sendToRenderer = () => {}, onChanged = () => {}, logger = console }) {
  const preparing = new Set(), active = new Map(), snapshots = new Map(), stopped = new Set();
  let timer = null, directoryEvents = null, restartScope = null;
  const get = id => meetingManager.getMeeting(id);
  const members = m => getMembers ? getMembers(m) : getDispatcher().groupMembersForMeeting?.(m, { includeDormant: true }) || [];
  function save(id, fields) {
    const m = get(id);
    if (!F.enabled(m)) throw new Error('文件工作流不可用');
    meetingManager.updateMeeting(id, { serialWorkflow: { ...m.serialWorkflow,
      fileFlow: { ...m.serialWorkflow.fileFlow, ...fields } } });
  }
  function status(id) {
    const m = get(id);
    if (!F.enabled(m)) return null;
    const dir = F.directory(getHubDataDir(), id), runtime = m.serialWorkflow.fileFlow || {};
    const progress = F.isSolo(m) ? { phase: 'discuss', key: 'solo', label: '独立开发 · 同一位负责实现与合并', done: false, error: null } : F.scan(dir);
    const inferred = progress.done ? progress.round * 2 + 1 : progress.phase === 'build' ? progress.round * 2 - 1 : progress.phase === 'merge' ? progress.round * 2 : progress.phase === 'kickoff' ? 1 : 0;
    const executedRounds = Math.max(Number(runtime.executedRounds) || 0, inferred);
    // Only a rework build is gated: every build still gets its review.
    const reviews = F.completedReviews(progress), budgetStart = reviewBudgetStart(runtime);
    const limitReached = !F.isSolo(m) && !progress.done && progress.phase === 'build' && progress.round > 1
      && reviews - budgetStart >= F.REVIEW_LIMIT && runtime.lastDispatch?.key !== progress.key;
    const recovering = m.serialWorkflow.settingsVersion === 1 && runtime.lastDispatch?.settled === false && !preparing.has(id) && !active.get(id)?.size;
    const running = preparing.has(id) || !!active.get(id)?.size;
    const paused = stopped.has(id) || !!runtime.paused || recovering || (limitReached && !active.get(id)?.size);
    return { ...progress, dir, executedRounds, reviews, reviewLimit: F.REVIEW_LIMIT, reviewBudgetStart: budgetStart, limitReached, recovering, paused,
      dispatchError: runtime.error || (recovering ? '上次派工回执尚未确认，请核对现场后点继续' : ''),
      running, participants: m.participants, next: paused && !running ? nextStep(m, progress) : null };
  }
  // Who the Hub itself would hand the current phase to; shown on the continue button.
  function nextStep(m, s) {
    if (s.done || s.error || (s.phase === 'discuss' && !F.isSolo(m))) return null;
    try {
      const names = members(m), owners = F.isSolo(m) ? [executor(m, F.spec('kickoff'))] : targets(m, s);
      const phase = F.isSolo(m) ? '独立开发' : { kickoff: '开题', build: '实现', merge: '审查与合并' }[s.phase];
      return { phase: s.phase, round: s.round || 0, memberIds: owners.map(t => t.id),
        label: `${owners.map(t => names.find(x => x.memberId === t.id)?.displayName || t.id).join('、')} · ${phase}${s.round ? ` · 第 ${s.round} 轮` : ''}` };
    } catch (error) { return { error: error.message }; }
  }
  function emit(id, s = status(id)) {
    const json = JSON.stringify(s);
    if (snapshots.get(id) === json) return;
    snapshots.set(id, json);
    sendToRenderer('dev-file:changed', { meetingId: id, ...s });
    onChanged(id);
  }
  function executor(m, s) {
    const index = s.phase === 'merge' ? 1 : 0;
    const id = m.serialWorkflow.steps?.[index]?.[0];
    const specs = m.slotSpecs || [];
    let slot = specs.findIndex((p, i) => (p?.memberId || `m${i + 1}`) === id);
    if (slot < 0 && /^m[1-9]\d*$/.test(id)) slot = Number(id.slice(1)) - 1;
    if (!id || !m.subSessions?.[slot]) throw new Error('当前执行席位缺失，请恢复群聊成员');
    return { id, slot };
  }
  function select(id, member) {
    meetingManager.setParticipants(id, [member.slot]);
    sendToRenderer('meeting-updated', { meeting: get(id) });
  }
  function targets(m, s) {
    const owner = executor(m, s);
    const ids = m.serialWorkflow.fileStages?.find(r => r.phase === s.phase)?.members || [owner.id];
    if (ids.length < 1 || ids.length > 3 || ids[0] !== owner.id || new Set(ids).size !== ids.length) throw new Error('本阶段文件负责人或参与人数无效');
    return ids.map(id => {
      const slot = (m.slotSpecs || []).findIndex((p,i) => (p.memberId || `m${i+1}`) === id);
      if (slot < 0 || !m.subSessions?.[slot]) throw new Error('工作流成员缺失，请恢复原成员');
      return {id,slot};
    });
  }
  function track(id, promise, token, key) {
    if (!active.has(id)) active.set(id, new Set());
    active.get(id).add(token);
    emit(id);
    return Promise.resolve(promise).then(result => {
      let failure = result?.status === 'error' || result?.status === 'no_subs'
        ? result.reason || result.status
        : result?.results?.find(r => ['errored', 'failed', 'absent', 'timed_out'].includes(r.status));
      if (failure && typeof failure === 'object') failure = failure.reason || failure.status;
      const runtime = get(id)?.serialWorkflow.fileFlow;
      if (get(id)?.serialWorkflow.settingsVersion === 1 && runtime?.lastDispatch?.token === token) {
        const expected = (runtime.lastDispatch.memberIds || []).map(mid => {
          const m=get(id), slot=(m.slotSpecs||[]).findIndex((p,i)=>(p.memberId||`m${i+1}`)===mid); return m.subSessions?.[slot];
        });
        if (result?.status !== 'completed' || expected.some(sid => !result.results?.some(r=>r.sid===sid && (!r.status || ['completed','manual_extracted'].includes(r.status))))) failure ||= '同轮成员交付回执不完整，请核对后继续';
        save(id,{lastDispatch:{...runtime.lastDispatch,settled:true}});
      }
      if (failure && get(id)?.serialWorkflow.fileFlow?.lastDispatch?.token === token) {
        save(id, { error: String(failure), paused: true });
      }
      return result;
    }, error => {
      logger.error('[dev-file] dispatch failed:', error);
      if (F.enabled(get(id)) && get(id).serialWorkflow.fileFlow?.lastDispatch?.token === token) save(id, { error: error.message, paused: true });
      throw error;
    }).finally(() => {
      active.get(id)?.delete(token);
      if (!active.get(id)?.size) active.delete(id);
      if (F.enabled(get(id))) emit(id);
      const current = F.enabled(get(id)) ? status(id) : null;
      // A rename can arrive before the previous dispatch receipt settles.
      // Reconsider it at that boundary instead of waiting for the safety scan.
      if (current && !current.paused && !current.error && !current.done && timer) setImmediate(() => { if (timer) tick(id); });
    });
  }
  async function dispatchStage(id, userArgs = null) {
    if (preparing.has(id)) return { status: 'error', reason: '正在准备派工，请稍后继续' };
    preparing.add(id);
    let released = false;
    try {
      let s = status(id), m = get(id);
      const continuingStage=userArgs?.restartContinuation === true && m.serialWorkflow.fileFlow?.lastDispatch?.key===s?.key;
      if (!s || s.error || s.done || (s.limitReached && !continuingStage) || (m.serialWorkflow.settingsVersion === 1 && active.get(id)?.size) || (s.paused && !userArgs)) return { status: 'error', reason: s?.error || '任务未处于可执行阶段' };
      if (s.phase === 'discuss') {
        return { status: 'error', reason: '尚未开题，请输入任务后点开题并发送' };
      }
      if (!userArgs && m.serialWorkflow.fileFlow?.lastDispatch?.key === s.key) return null;
      const stageMembers = targets(m, s), member = stageMembers[0], token = crypto.randomUUID(), key = s.key;
      save(id, { lastDispatch: { key, token, memberId: member.id }, error: '' });
      for (const target of stageMembers) await ensureMemberReady(m, target.id);

      s = status(id);
      // A stop or a rename during session wake must win over this scheduled send.
      if (!s || (s.paused && !(continuingStage && s.limitReached && !stopped.has(id) && !get(id).serialWorkflow.fileFlow?.paused)) || s.key !== key || s.error || s.done) return { status: 'error', reason: '现场已变化，取消本次派工' };
      select(id, member);
      meetingManager.setParticipants(id, stageMembers.map(t => t.slot));
      m = get(id);
      const prompt = F.phasePrompt(m, s.dir, s, members(m));
      save(id, { executedRounds: s.executedRounds + (continuingStage ? 0 : 1), lastDispatch: { key, token, memberId: member.id, memberIds: stageMembers.map(t => t.id), settled:false } });
      // The phase owner comes from the task files. The composer's lit avatars
      // must not override it (the dispatcher prefers recipientSids over member ids).
      const { recipientSids: _selected, targetSids: _explicit, ...extra } = userArgs || {};
      const args = { ...extra, userInput: userArgs ? `${userArgs.userInput}\n\n${prompt}` : prompt,
        targetMemberIds: stageMembers.map(t => t.id), appendUserMessage: true, dispatchMode: 'serial',
        turnTimeoutMs: 30 * 60_000, allowActiveExtend: true, fileHandoff: !userArgs,
        shouldDispatch: () => { const now = status(id); return !!now && !stopped.has(id) && !get(id)?.serialWorkflow.fileFlow?.paused && !now.error && !now.done && now.key === key; },
        workflowRun: { runId: token, kind: 'dev-file', stepIndex: s.phase === 'kickoff' ? 0 : s.round * 2 - (s.phase === 'build' ? 1 : 0), attempt: 1 } };
      const promise = getDispatcher().dispatchGroupChatTurn(id, args);
      // Do not hold the phase mutex while waiting for a chat reply. The rename advances independently.
      preparing.delete(id);
      released = true;
      return await track(id, promise, token, key);
    } catch (error) {
      if (!released && F.enabled(get(id))) save(id, { error: error.message });
      throw error;
    } finally {
      if (!released) { preparing.delete(id);  }
      if (F.enabled(get(id))) emit(id);
    }
  }
  function stop(id) {
    if (!F.enabled(get(id))) return false;
    stopped.add(id);
    save(id, { paused: true });

    emit(id);
    return true;
  }
  function interruptSids(id) {
    const m = get(id), s = status(id);
    if (!s || s.done || s.phase === 'discuss') return [];
    const memberId = m.serialWorkflow.fileFlow?.lastDispatch?.memberId;
    const specs = m.slotSpecs || [];
    const memberIds = m.serialWorkflow.fileFlow?.lastDispatch?.memberIds;
    if (memberIds?.length) return memberIds.map(id=>m.subSessions[specs.findIndex((p,i)=>(p?.memberId || `m${i+1}`)===id)]).filter(Boolean);
    const slot = memberId ? specs.findIndex((p, i) => (p?.memberId || `m${i + 1}`) === memberId) : -1;
    const index = slot >= 0 ? slot : executor(m, s).slot;
    return [m.subSessions[index]].filter(Boolean);
  }
  async function userTurn(id, args) {
    if (!F.enabled(get(id))) return getDispatcher().dispatchGroupChatTurn(id, args);
    restartScope?.add(id);
    const s = status(id);
    // A user-authored kickoff is the first actual execution round. Plain
    // discussion does not spend a round or clear a previous stop.
    const kickoff = !F.isSolo(get(id)) && String(args.userInput || '').includes(F.PRESET_START) && ['discuss','kickoff'].includes(s.phase);
    if (kickoff && (active.get(id)?.size || preparing.has(id))) return {status:'error',reason:'当前轮次尚未交付'};
    if (F.isResume(args.userInput) && !s.error && !F.isSolo(get(id)) && get(id).serialWorkflow.settingsVersion === 1) {
      try { return await continueFlow(id, args.userInput); }
      catch (error) { return { status: 'error', reason: error.message }; }
    }
    if (kickoff) preparing.add(id);
    try {

    if (kickoff && (stopped.has(id) || status(id)?.paused || status(id)?.key !== s.key)) return {status:'error',reason:'现场已变化，取消本次开题'};
    if (F.isResume(args.userInput) && !s.error) {
      // Resume is the user's message, not another phase prompt or a change
      // of recipient. Latch this phase so the scanner cannot race it with
      // automatic dispatch; only a later file handoff advances the workflow.
      const m = get(id), selected = (m.participants || [0])[0];
      save(id, { paused: false, error: '', ...(!F.isSolo(m) ? {executedRounds:s.executedRounds+1,...(s.limitReached?{budgetStart:s.executedRounds,reviewBudgetStart:s.reviews}:{})} : {}), lastDispatch: { key: s.key, token: crypto.randomUUID(),
        memberId: args.targetMemberIds?.[0] || m.slotSpecs?.[selected]?.memberId || `m${selected + 1}` } });
      stopped.delete(id);
    }
    // A normal question is still a normal group message; it must not clear stop intent.
    const token = crypto.randomUUID();
    if (kickoff) {
      if (s.limitReached) return {status:'error',reason:'已达审查轮次上限，请点继续接续当前任务'};
      const m = get(id), stageMembers = targets(m,F.spec('kickoff'));
      const { recipientSids: _selected, targetSids: _explicit, ...rest } = args; // kickoff owner is bound, not the lit avatar
      args = {...rest,targetMemberIds:stageMembers.map(t=>t.id)};
      save(id,{executedRounds:s.executedRounds + (s.phase === 'kickoff' && !m.serialWorkflow.fileFlow?.executedRounds ? 0 : 1),lastDispatch:{key:'kickoff:0',token,memberId:stageMembers[0].id,memberIds:stageMembers.map(t=>t.id),settled:false}});
    }
      const promise = getDispatcher().dispatchGroupChatTurn(id, args);
      const tracked = track(id, promise, token, s.key);
      if (kickoff) preparing.delete(id);
      return await tracked;
    } catch (error) {

      throw error;
    } finally { if (kickoff) {preparing.delete(id);  if(F.enabled(get(id)))emit(id);} }
  }
  // Explicit user continuation: the Hub reads the task files, picks the phase
  // owner and grants a fresh review budget when the previous one is spent.
  async function continueFlow(id, text = '') {
    const m = get(id);
    if (!F.enabled(m)) throw new Error('文件工作流不可用');
    const s = status(id), note = String(text || '').trim() || CONTINUE_NOTE;
    if (s.error) throw new Error('任务文件状态需要核对：' + s.error);
    if (s.done) throw new Error('本任务已完成，无需继续');
    if (s.phase === 'discuss' && !F.isSolo(m)) throw new Error('尚未开题，请输入任务后点开题并发送');
    if (s.running) throw new Error('当前轮次仍在执行，无需继续');
    const owners = F.isSolo(m) ? [executor(m, F.spec('kickoff'))] : targets(m, s);
    // Never stack a second prompt onto a member that is still working.
    const busy = owners.filter(t => {
      const session = sessionManager?.getSession?.(m.subSessions[t.slot]);
      return !!session && ['starting', 'running', 'waiting'].includes(getSessionRuntimeTruth(session).state);
    });
    if (busy.length) throw new Error(`${busy.map(t => members(m).find(x => x.memberId === t.id)?.displayName || t.id).join('、')} 仍在运行或等待确认，请等它结束或先停止本轮`);
    if (F.isSolo(m)) return userTurn(id, { userInput: F.isResume(note) ? note : `${CONTINUE_NOTE}\n\n${note}`, targetMemberIds: owners.map(t => t.id), appendUserMessage: true });
    stopped.delete(id);
    save(id, { paused: false, error: '', ...(s.limitReached ? { reviewBudgetStart: s.reviews } : {}) });
    return dispatchStage(id, { userInput: note, appendUserMessage: true });
  }
  function tick(onlyId = null) {
    const records = onlyId ? [get(onlyId)].filter(Boolean) :
      (meetingManager.getDevWorkbenchRecords?.() || meetingManager.getAllMeetings());
    for (const m of records) {
      if (restartScope && !restartScope.has(m.id)) continue;
      if (!F.enabled(m) || F.isSolo(m)) continue;
      try {
        const s = status(m.id);
        emit(m.id, s);
        if (s.paused || s.error || s.dispatchError || s.done) {  continue; }
        if (m.serialWorkflow.settingsVersion === 1 && active.get(m.id)?.size) continue;
        if (!['build', 'merge'].includes(s.phase) || preparing.has(m.id)) continue;
        if (m.serialWorkflow.fileFlow?.lastDispatch?.key === s.key) continue;
        void dispatchStage(m.id).catch(error => logger.error('[dev-file] automatic dispatch:', error));
      } catch (error) { logger.error('[dev-file] scan failed:', error); }
    }
  }
  function kickoffPreset(id) {
    const m = get(id);
    if (!F.enabled(m)) throw new Error('文件工作流不可用');
    if (F.isSolo(m)) throw new Error('单 Agent 请使用独立开工');
    const s = status(id);
    if (s.error || !['discuss', 'kickoff'].includes(s.phase)) throw new Error(s.error || '本任务已经开题，请用普通消息继续');
    // No mkdir, no phase change, no dispatch. The button only prepares editable composer text.
    return { prompt: F.phasePrompt(m, s.dir, F.spec('kickoff'), members(m)), slot: executor(m, F.spec('kickoff')).slot };
  }
  function independentPreset(id) {
    const m = get(id);
    if (!F.isSolo(m)) throw new Error('独立开工仅用于单 Agent 开发群聊');
    return { prompt: F.independentPrompt(m, F.directory(getHubDataDir(), id), members(m)), slot: executor(m, F.spec('kickoff')).slot };
  }
  function registerIpc(ipcMain, shell) {
    ipcMain.handle('workflow:set-enabled', (_e, {meetingId, enabled, expectedRevision} = {}) => {
      try {
        const m = get(meetingId), wf = m?.serialWorkflow;
        if (!m?.groupChat || !Array.isArray(wf?.steps) || !wf.steps.length) throw new Error('请先保存工作流设置');
        if (typeof enabled !== 'boolean') throw new Error('工作流开关状态无效');
        if ((wf.settingsRevision || 0) !== expectedRevision) throw new Error('设置已更新，请重试开关');
        if (wf.enabled === enabled) return {ok:true, config:wf};
        if (!enabled) {
          if (deliveryEngine?.handles(meetingId)) deliveryEngine.stop(meetingId, {interrupt:false});
          else if (F.enabled(m)) stop(meetingId);
          else if (isWorkflowRunning(meetingId)) {
            if (typeof stopWorkflow !== 'function') throw new Error('暂时无法暂停发言，请稍后重试');
            stopWorkflow(meetingId);
          }
        }
        const next = {...get(meetingId).serialWorkflow, enabled, settingsRevision:(wf.settingsRevision || 0)+1};
        if (enabled && next.deliveryVersion===1) next.taskArmed=true;
        meetingManager.updateMeeting(meetingId, {serialWorkflow:next});
        sendToRenderer('meeting-updated', {meeting:get(meetingId)});
        emit(meetingId);
        return {ok:true, config:next};
      } catch(error) { return {ok:false, reason:error.message}; }
    });
    ipcMain.handle('workflow:configure', (_e, {meetingId, draft, expectedRevision} = {}) => {
      try {
        const m = get(meetingId);
        if (!m?.groupChat) throw new Error('群聊不存在');
        const wf = m.serialWorkflow || {}, fileStatus = status(meetingId);
        if (deliveryEngine?.isBusy(meetingId)) throw new Error('当前任务尚未结束，请先完成或结束任务，再修改工作流');
        if (fileStatus?.error) throw new Error('任务目录状态无法确认，保留原设置：'+fileStatus.error);
        if (isWorkflowRunning(meetingId) || preparing.has(meetingId) || active.get(meetingId)?.size || wf.loopState?.status === 'running' || (wf.serialRunState?.status === 'running' && wf.conversationVersion!==1)) throw new Error('工作流运行中，停止并等待本轮结束后再修改');
        if ((wf.settingsRevision || 0) !== expectedRevision) throw new Error('设置已被更新，请关闭后重新打开');
        const ids = (m.slotSpecs || []).map((p,i)=>p.memberId || `m${i+1}`);
        // Existing delivered legacy tasks keep their original protocol and paths.
        // Saving is the user's choice to use this configuration. Old editors
        // may still send enabled:false; it must not leave the saved flow inert.
        const savedDraft = {...draft,enabled:true};
        const next = fileStatus?.files?.length ? Settings.toConfig(wf,savedDraft,ids) : Settings.toWorkflowConfig(wf,savedDraft,ids);
        if (fileStatus?.files?.length && (draft.kind !== 'file' || JSON.stringify(next.steps) !== JSON.stringify(wf.steps))) throw new Error('已有任务文件，不能切换协议或负责人；请为新任务创建群聊');
        next.settingsRevision = (wf.settingsRevision || 0) + 1;
        // A terminal run normally returns to ordinary chat. An explicit save
        // selects the new flow for the next message, without touching run.json.
        if(next.deliveryVersion===1)next.taskArmed=true;
        meetingManager.updateMeeting(meetingId,{serialWorkflow:next});
        if(next.enabled)meetingManager.setParticipants(meetingId,next.steps[0].map(id=>ids.indexOf(id)));
        sendToRenderer('meeting-updated',{meeting:get(meetingId)});
        emit(meetingId);
        return {ok:true,config:next};
      } catch(error) { return {ok:false,reason:error.message}; }
    });
    ipcMain.handle('dev-file:status', (_e, { meetingId }) => status(meetingId));
    ipcMain.handle('dev-file:continue', async (_e, { meetingId } = {}) => {
      try {
        const result = continueFlow(meetingId).then(value => ({ value }), error => ({ error }));
        // Report the handoff, not the whole agent turn; later failures arrive via dev-file:changed.
        const first = await Promise.race([result, new Promise(r => setTimeout(() => r(null), 1500))]);
        if (!first) result.then(late => late.error && logger.error('[dev-file] continue:', late.error));
        if (first?.error) return { ok: false, error: first.error.message };
        if (first?.value?.status === 'error') return { ok: false, error: first.value.reason || '继续失败' };
        return { ok: true, status: status(meetingId) };
      } catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('dev-file:kickoff-preset', (_e, { meetingId }) => kickoffPreset(meetingId));
    ipcMain.handle('dev-file:independent-preset', (_e, { meetingId }) => independentPreset(meetingId));
    ipcMain.handle('dev-file:open-docs', async (_e, { meetingId }) => {
      const s = status(meetingId);
      if (!s) throw new Error('文件工作流不可用');
      fs.mkdirSync(s.dir, { recursive: true });
      const error = await shell.openPath(s.dir);
      if (error) throw new Error(error);
      return { ok: true };
    });
  }
  async function resumeAfterRestart(id, prompt) {
    const m=get(id), s=status(id);
    if (!s || s.error) throw new Error(s?.error || '文件工作流不可用');
    if (s.done) return {status:'completed'};
    if (!timer) restartScope ||= new Set();
    restartScope?.add(id);
    stopped.delete(id);
    save(id,{paused:false,error:'',lastDispatch:{...m.serialWorkflow.fileFlow?.lastDispatch,settled:true}});
    const direct = F.isSolo(m) || s.phase==='discuss';
    // dispatchStage reads the current task files and chooses the actual phase
    // owner, including a handoff completed immediately before shutdown.
    const task=direct
      ? userTurn(id,{userInput:prompt,targetMemberIds:m.serialWorkflow.fileFlow?.lastDispatch?.memberIds,appendUserMessage:true})
      : dispatchStage(id,{userInput:prompt,restartContinuation:true});
    if (!timer) {
      directoryEvents=require('../../core/task-directory-events').subscribeTaskDirectory(getHubDataDir(), mid=>tick(mid),logger);
      timer=setInterval(()=>{directoryEvents.ensure();tick();},30_000);timer.unref?.();
    }
    return task;
  }
  return { status, userTurn, continueFlow, stop, interruptSids, tick, kickoffPreset, independentPreset, registerIpc, resumeAfterRestart,
    start({onlyIds=null} = {}) { if (!timer) {
      restartScope=Array.isArray(onlyIds) ? new Set(onlyIds) : null;
      directoryEvents = require('../../core/task-directory-events').subscribeTaskDirectory(getHubDataDir(), id => tick(id), logger);
      tick(); timer = setInterval(() => { directoryEvents.ensure(); tick(); }, 30_000); timer.unref?.();
    } },
    dispose() { if (timer) clearInterval(timer); timer = null; directoryEvents?.dispose(); directoryEvents = null;  } };
}
module.exports = { createDevFileEngine };
