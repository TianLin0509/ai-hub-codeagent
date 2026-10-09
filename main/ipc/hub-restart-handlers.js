'use strict';

const { HubRestart, restartToken, ARG } = require('../../core/hub-restart');
const F = require('../../core/dev-file-workflow');
const D = require('../../core/delivery-workflow');
const { nativeSessionIdentity } = require('../../core/session-capabilities');
const clone = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function restartGroupTargets(group, meeting) {
  const workflow=meeting?.serialWorkflow || {};
  let ids=group.memberIds || [];
  if (group.kind==='file') ids=workflow.fileFlow?.lastDispatch?.memberIds || ids;
  if (group.kind==='serial') ids=workflow.steps?.[workflow.serialRunState?.currentStepIndex ?? workflow.serialRunState?.nextStepIndex] || [];
  if (group.kind==='loop') ids=workflow.steps?.[workflow.loopState?.currentStep==='reviewer' ? 1 : 0] || [];
  if (group.kind==='kickoff') ids=[workflow.kickoff?.authorMemberId || ids[0]].filter(Boolean);
  return ids.map(id=>{
    let slot=(meeting?.slotSpecs || []).findIndex((s,i)=>(s.memberId || 'm'+(i+1))===id);
    if (slot<0 && /^m[1-9]\d*$/.test(id)) slot=Number(id.slice(1))-1;
    return meeting?.subSessions?.[slot];
  });
}

function registerHubRestartIpc(ipcMain, deps) {
  const { app, sessionManager: sm, meetingManager: mm, sessionStore, stateStore, getHubDataDir,
    resumeSession, groupChatDispatcher: dispatcher, sendToRenderer, shutdown, flushState, transcriptTap } = deps;
  const bootToken = restartToken();
  const native = id => sm.getNativeSession?.(id) || sm.getNativeClaude?.(id);
  let requested = false;
  const legacy=require('../../core/hub-restart-legacy');
  const tracker=legacy.createRestartLegacyTracker(transcriptTap,sm);
  let oldChildren=[];
  function captureGroups(rows) {
    const groups=[];
    for (const m of mm.getAllMeetings()) {
      const members=rows.filter(s => s.meetingId === m.id);
      if (!m.groupChat || !members.length || (!members.some(s => s.before === 'working') && !global.__loopEngine?.isRunning(m.id) && !global.__devFileEngine?.status(m.id)?.running && !global.__deliveryEngine?.isBusy(m.id))) continue;
      const workflow = clone(m.serialWorkflow || {});
      groups.push({ id:m.id, title:m.title, sessionIds:members.map(s => s.id), workingIds:members.filter(s => s.before === 'working').map(s => s.id),
        memberIds:members.filter(s => s.before === 'working').map(s => {
          const index=m.subSessions.indexOf(s.id); return m.slotSpecs?.[index]?.memberId || 'm'+(index+1);
        }), workflow, deliveryPaused:D.enabled(m) && global.__deliveryEngine?.status(m.id)?.paused,
        kind:D.enabled(m) ? 'delivery' : F.enabled(m) ? 'file' : global.__loopEngine?.isRunning(m.id)
          ? global.__loopEngine.getStatus(m.id).mode : 'group', status:'pending' });
    }
    return groups;
  }
  async function prepareContinuation(row) {
    const n=native(row.id);
    if (!n) {
      const session=sm.getSession(row.id);
      const base=session?.kind?.replace(/-resume$/,'');
      // 2026-09-26：PTY 成为默认后，Claude / Codex 也走这里。只放行老式 CLI 会让每个正在干活的
      // PTY 会话重启后都报「缺少执行状态」而不续作（真机：Codex 计划 before=working → error）。
      // 续作提示自己要求先核对上一步的实际结果，已完成就只报告，不会重复执行。
      const ptyAgent=session?.agentRuntime === 'pty' && ['claude','codex'].includes(base);
      if (!ptyAgent && !['kimi','gemini','deepseek'].includes(base)) throw new Error('此提供方缺少执行状态，请核对后继续');
      return {completed:false};
    }
    await n.start?.();
    if (row.turnId && n.readOutcome) {
      const outcome=await n.readOutcome(row.turnId);
      if (outcome?.status === 'completed') return {completed:true};
    }
    await n.prepareForNewPrompt?.();
    if (row.submissionId && n.records?.get?.(row.submissionId)?.status === 'completed') return {completed:true};
    const r=n.runtime;
    if (r?.state === 'waiting' || ['unknown','submitting','queued'].includes(r?.submission?.status || r?.submission?.sendStatus)) throw new Error('原生会话仍待核对或审批，未自动发送');
    if (r?.state === 'running') throw new Error('原生会话仍报告执行中，未叠加发送续作');
    return {completed:false};
  }
  async function resumeGroup(group, prompt, token) {
    const m=mm.getMeeting(group.id);
    if (!m) throw new Error('原群聊不存在');
    if(group.kind==='delivery') {
      // Reconcile persisted deliveries only. Restart never replays a send
      // intent whose native acceptance may already have happened.
      if(group.deliveryPaused)throw new Error('文件交付工作流保持用户暂停，请进入群聊核对后继续');
      const result=await global.__deliveryEngine.resume(group.id);
      if(result.done)return {completed:true};
      throw new Error(result.error || '交付记录已恢复；未重复派工，请在群聊查看进度或继续未交付成员');
    }
    const receipt = id => {
      if(!native(id))return sm.restartContinuationReceipts?.get(id) || {};
      const r=native(id)?.runtime, s=r?.submission;
      return {id:s?.id || s?.submissionId,status:s?.status || s?.sendStatus};
    };
    const before=new Map(group.sessionIds.map(id => [id,receipt(id).id]));
    let expected=group.workingIds;
    let task;
    if (group.kind === 'file') {
      // Re-scan the actual handoff files; a rename may have advanced the stage
      // while shutdown was in progress. The file engine chooses its owner.
      task=global.__devFileEngine.resumeAfterRestart(group.id,prompt);
    } else if (group.kind === 'serial' || group.kind === 'loop') {
      global.__loopEngine.clearStopIntent(group.id);
      const checkpoint=group.kind === 'serial' ? group.workflow.serialRunState : group.workflow.loopState;
      if (!checkpoint) throw new Error('工作流检查点缺失，未重新开工');
      task=group.kind === 'serial'
        ? global.__loopEngine.runSerial(group.id,null,checkpoint,{restartContinuation:prompt})
        : global.__loopEngine.runLoop(group.id,null,checkpoint,{restartContinuation:prompt});
    } else if (group.kind === 'kickoff') {
      global.__loopEngine.clearStopIntent(group.id);
      task=global.__loopEngine.runKickoff(group.id,{restartContinuation:prompt});
    } else {
      const targets=group.memberIds.filter((_,i) => service.plan.sessions.find(s => s.id===group.workingIds[i])?.status !== 'completed');
      if (!targets.length) return {completed:true};
      expected=group.workingIds.filter(id=>service.plan.sessions.find(s=>s.id===id)?.status!=='completed');
      task=dispatcher.dispatchGroupChatTurn(group.id,{userInput:prompt,targetMemberIds:targets,
        clientMessageId:'restart:'+token+':'+group.id,appendUserMessage:true,dispatchMode:'restart',turnTimeoutMs:30*60_000});
    }
    let finished=false, failure=null;
    Promise.resolve(task).then(result => {
      finished=true;
      if (result?.ok === false || ['error','no_subs','paused','stopped_user'].includes(result?.status)
        || result?.results?.some(r=>['errored','failed','absent','timed_out','interrupted'].includes(r.status))) failure=new Error(result?.reason || result?.lastError?.reason || '群聊恢复未完成，请查看成员回执');
      if (failure && service.plan?.groups.includes(group)) {
        group.status='waiting';group.message=failure.message;service.save();
      }
    },error => {
      finished=true;failure=error;group.status='waiting';group.message=error.message;service.save();
    }).catch(error=>{
      finished=true;failure=error;
      group.status='uncertain';group.message='群聊恢复记录保存失败：'+error.message;
      console.error('[hub-restart] failed to persist group recovery:',error);
      sendToRenderer('hub-restart:progress',service.snapshot());
    });
    // A dispatch waits for an entire answer. A restart receipt only waits for
    // native acceptance, while the existing engine owns the rest of the turn.
    const deadline=Date.now()+60_000;
    while (!finished && Date.now()<deadline) {
      if (group.kind!=='group') expected=restartGroupTargets(group,mm.getMeeting(group.id));
      const accepted=expected.length && expected.every(id => {
        const r=receipt(id);
        return r.id && r.id!==before.get(id) && ['accepted','running','completed'].includes(r.status);
      });
      if (accepted) return;
      await delay(100);
    }
    if (failure) throw failure;
    if (!finished) throw new Error('群聊恢复提交待核对，未重复派工');
    return expected.some(id=>receipt(id).id && receipt(id).id!==before.get(id)) ? {continued:true} : {completed:true};
  }
  const service = new HubRestart({ directory:getHubDataDir(), sessions:() => sm.getAllSessions().map(s=>({...s,restartLegacyState:tracker.state(s)})),
    loadSession:id => sessionStore.loadSessionFile(id,{strict:true}),
    restoreSession:async meta => {
      const s=sm.getSession(meta.hubId);
      if (s && nativeSessionIdentity(s)?.value !== nativeSessionIdentity(meta)?.value) throw new Error('已有会话身份不匹配');
      const restored=s || await resumeSession(meta);
      const n=native(meta.hubId);
      if(!n && service.plan?.groups.some(g=>g.sessionIds.includes(meta.hubId))){
        sm.restartContinuationSessions ||= new Set();sm.restartContinuationSessions.add(meta.hubId);
      }
      if (n && n.runtime?.connection !== 'unstarted') await n.start();
      return restored;
    }, prepareContinuation,
    sendContinuation:(row,text,id) => require('../../core/group-chat-watcher').sendToPty(row.id,text,
      sm.getSession(row.id)?.kind,{clientSubmissionId:id,requireReady:true,restartContinuation:true}),
    captureGroups,resumeGroup,
    quiesce:async plan => {
      requested=true;
      sm.restartPending=true;
      // node-pty onExit closes the socket before its ConPTY worker necessarily
      // exits. Electron must keep Node alive until that worker's exit event too.
      oldChildren=[...new Set([...oldChildren,...plan.sessions.flatMap(s=>[
        native(s.id)?.client?.proc,sm.sessions.get(s.id)?.pty?._agent?._conoutSocketWorker?._worker,
      ]).filter(Boolean)])];
      global.__devFileEngine?.dispose();
      global.__deliveryEngine?.freeze();
      for (const g of plan.groups) {
        if (g.kind==='file') global.__devFileEngine.stop(g.id);
        else if (['loop','serial','kickoff'].includes(g.kind)) global.__loopEngine.stopLoop(g.id,{reason:'hub_restart',interrupt:false});
        dispatcher.interruptMeetingTurn(g.id,{reason:'hub_restart'});
      }
      // Interrupt first so providers can persist their final turn status. A
      // failed interrupt is reported; closing still waits for writer exit.
      const interrupted=await Promise.allSettled(plan.sessions.filter(s=>s.before==='working').map(async row => {
        const n=native(row.id);
        if (n) {
          await n.interrupt();
          if(sm.getSession(row.id)?.runtimeBackend==='acp')await n.idle(15000);
        }
      }));
      const working=plan.sessions.filter(s=>s.before==='working');
      interrupted.forEach((r,i)=>{if(r.status==='rejected'){
        working[i].before='unknown';console.warn('[hub-restart] interrupt pending:',r.reason?.message);
      }});
      service.save();
    },
    flush:async () => { await stateStore.flushPending(); await flushState(false); },
    shutdown:plan => shutdown('restart-and-continue',{beforeQuit:async () => {
      await Promise.all(oldChildren.map(child=>legacy.waitChildExit(child)));
      await flushState(true);
      service.ready();
      const args=process.argv.slice(1).filter(a=>!a.startsWith(ARG));
      app.relaunch({args:[...args,ARG+plan.token]});
    }}), publish:plan => sendToRenderer('hub-restart:progress',plan),
  });
  ipcMain.handle('hub-restart:request',async (_e,view={}) => {
    try {
      const result=await service.request(view);return result;
    } catch(error){requested=false;sm.restartPending=false;return {ok:false,message:error.message};}
  });
  ipcMain.handle('hub-restart:status',() => service.snapshot());
  ipcMain.handle('hub-restart:restore',async () => {
    if (!bootToken) return null;
    try {return await service.restore(bootToken);} catch(error){return {phase:'failed',error:error.message};}
  });
  ipcMain.handle('hub-restart:retry',async (_e,id) => {
    const plan=service.plan, row=plan?.sessions.find(s=>s.id===id);
    if (service.busy || !row || row.status!=='error') return {ok:false,message:'仅能重试尚未发送的恢复失败项；待核对项请先查看原会话'};
    row.status='pending';plan.phase='restoring';service.save();
    for(const group of plan.groups)if(group.sessionIds.includes(row.id) && group.status==='waiting' && group.message==='有成员恢复失败或待核对，保留群聊阶段')group.status='pending';
    service.save();
    try {return await service.restore(plan.token);} catch(error){return {ok:false,message:error.message};}
  });
  return {service,bootToken,isRestarting:()=>requested};
}
module.exports={registerHubRestartIpc,restartGroupTargets};
