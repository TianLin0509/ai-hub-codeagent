'use strict';
const {ipcRenderer}=require('electron');
const Recipients=require('../core/groupchat-recipients');
const states=new Map(),pending=new Set(),versions=new Map(),expanded=new Set(),busy=new Set();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let refresh=()=>{};
ipcRenderer.on('delivery:changed',(_e,s)=>{if(s?.meetingId){versions.set(s.meetingId,(versions.get(s.meetingId)||0)+1);states.set(s.meetingId,s);refresh(s.meetingId);}});
function render(row,meeting,onRefresh,onError) {
  refresh=onRefresh;
  const id=meeting.id,s=states.get(id);
  const recipients=Recipients.selectedSids(meeting).map(sid=>{const i=meeting.subSessions.indexOf(sid),slot=meeting.slotSpecs?.[i];return slot?.title || slot?.displayName || (slot?.kind?require('../core/ai-kinds').getKindLabel(slot.kind)+' '+(i+1):`成员 ${i+1}`);});
  if(!s && !pending.has(id)){const version=versions.get(id)||0;pending.add(id);ipcRenderer.invoke('delivery:status',{meetingId:id}).then(r=>{
    if(version===(versions.get(id)||0))states.set(id,r.ok?r:{error:r.error,label:'状态读取失败'});
  }).catch(e=>{if(version===(versions.get(id)||0))states.set(id,{error:e.message,label:'状态读取失败'});}).finally(()=>{pending.delete(id);onRefresh(id);});}
  row.dataset.deliveryMeeting=id;
  const active=!!s?.runId && !s.finished,paused=s?.paused || s?.recoveryPending;
  // Idle room: either the next message starts a workflow task (armed) or it is
  // an ordinary group-chat message to the lit avatars (after a task ends).
  const idle=!!s && !s.error && !active, armed=idle && s.armed;
  const title=!s?'读取交付进度…':s.error && !s.runId?'状态读取失败':armed?'工作流已就绪':idle?'普通群聊':`${paused?'已暂停 · ':''}${s.name}`;
  const box=row.ownerDocument?.getElementById('mr-input-box');
  if(box && idle)box.dataset.placeholder=armed?'输入任务，下一条消息按工作流开工；只想聊天就点上方「改为普通群聊」':'普通群聊：消息直接发给点亮头像的成员；要按工作流做新任务，点上方「开新任务」';
  const primary=idle?(armed?'<button type="button" data-delivery="disarm" title="下一条消息不开工，直接发给点亮头像的成员">改为普通群聊</button>'
      :'<button type="button" class="continue" data-delivery="arm" title="下一条消息按工作流开始新任务">开新任务</button>'):active?(paused?'<button type="button" class="continue" data-delivery="resume" title="由 Hub 核对已交付文件，判断下一步交给谁；不重复派发已确认任务">继续</button>':'<button type="button" data-delivery="stop" title="暂停自动接续，并中断当前成员">暂停</button>'):'';
  const status=s?.runId&&!s.finished?(s.gate==='running'?`Hub 正在跑测试闸门 · 第 ${s.round} 轮`:`${s.delivered}/${s.total} 位已交付${s.round?` · 第 ${s.round} 轮`:''}`)
    :armed?'下一条消息按工作流开始任务':idle?(s.finished?`上个任务${s.done?'已完成':'已结束'}，记录已保留；消息直接发给点亮的成员`:'消息直接发给点亮的成员'):'输入任务，Hub 按工作流安排成员推进';
  row.innerHTML=`<section class="mr-file-flow mr-delivery-flow" aria-label="工作流进度" data-delivery-status="${esc(s?.status || 'loading')}" aria-busy="${busy.has(id)}">
    <div class="mr-file-detail" title="${esc([title,status,recipients.length?'发送给 '+recipients.join('、'):'请点亮至少一位成员头像'].join(' · '))}"><strong>${esc(active?title+' · '+status:title)}</strong><small>${esc(status)}</small></div>
    <div class="mr-file-actions">${primary}${s?.error&&!s.runId?'<button type="button" data-delivery="refresh">重试读取</button>':''}<button type="button" data-delivery="files">交付文件</button>
      <button type="button" data-delivery-details aria-expanded="${expanded.has(id)}" aria-controls="mr-delivery-details">${expanded.has(id)?'收起详情':'流程详情'}</button></div>
    ${s?.error?`<div class="mr-file-error" role="status">${esc(s.error)}</div>`:''}
    <div id="mr-delivery-details" class="mr-delivery-details" ${expanded.has(id)?'':'hidden'}>
      <p>${esc(status)} · ${esc(recipients.length?'发送给 '+recipients.join('、'):'请点亮至少一位成员头像')}</p>
      <ol class="mr-delivery-stages">${(s?.stageNames || meeting.serialWorkflow.deliveryStages.map(stage=>stage.name)).map((name,i)=>`<li ${active&&s.stageIndex===i?'aria-current="step"':''}>${esc(name)}</li>`).join('')}</ol>
      <p>${active&&s.missing?.length?'待交付：'+esc(s.missing.join('、')):'每位成员交付结果后接续；聊天结束不会提前交棒'}</p>
      ${active && s.missingIds?.length ? `<div class="mr-file-actions">${s.missingIds.map((mid,i)=>{const ends=s.kind==='file' && mid===s.ownerId;
        return `<button type="button" data-delivery-skip="${esc(mid)}" data-skip-ends="${ends}" title="${ends?'这位是本步负责人：跳过后本次任务结束，不合并':'跳过这位成员，其他成员的交付照常接续'}">${ends?'跳过并结束任务':'跳过'} ${esc(s.missing[i])}</button>`;}).join('')}</div>` : ''}
      ${active?`<div class="mr-file-actions">${!paused?'<button type="button" data-delivery="resume" title="只核对交付，不重复发送任务">重新核对交付</button><button type="button" data-delivery="continue" title="只向尚未交付且已空闲的成员补发继续指令">提醒未交付成员</button>':''}<button type="button" data-delivery="cancel" title="保留记录，结束本次任务后才能启动新目标">结束任务</button></div>`:''}
    </div><small class="mr-delivery-recipients">${esc(recipients.length?'发送给 '+recipients.join('、'):'请点亮至少一位成员头像')}</small></section>`;
  row.querySelector('[data-delivery-details]').addEventListener('click',()=>{
    if(expanded.has(id))expanded.delete(id);else expanded.add(id);
    render(row,meeting,onRefresh,onError);
    row.querySelector('[data-delivery-details]').focus();
  });
  row.querySelectorAll('[data-delivery]').forEach(b=>b.addEventListener('click',async()=>{
    if(busy.has(id))return;busy.add(id);
    row.querySelectorAll('[data-delivery]').forEach(button=>button.disabled=true);
    try{
      if(b.dataset.delivery==='refresh'){versions.set(id,(versions.get(id)||0)+1);states.delete(id);onRefresh(id);return;}
      if(b.dataset.delivery==='files'){
        const r=await ipcRenderer.invoke('delivery:status',{meetingId:id});if(!r.ok || !r.dir)throw new Error(r.error || '任务目录不可用');
        await require('fs').promises.mkdir(r.dir,{recursive:true});
        if(!row.isConnected || !row.getClientRects().length || row.dataset.deliveryMeeting!==id)return;
        const result=await window.FileManagerPanel.open({cwd:r.dir,label:'工作流交付'});if(!result?.ok)throw new Error(result?.error || '打开失败');return;
      }
      if(b.dataset.delivery==='cancel' && !window.confirm('结束本次任务？已交付文件与记录会保留，之后可输入新目标。'))return;
      const result=await ipcRenderer.invoke('delivery:'+b.dataset.delivery,{meetingId:id});if(!result.ok)throw new Error(result.error || '工作流操作失败');
      states.delete(id);onRefresh(id);
    }catch(e){
      if(row.isConnected && row.getClientRects().length && row.dataset.deliveryMeeting===id)onError(e.message);
      else console.warn('[delivery-controls] previous group operation failed:',id,e.message);
    }finally{busy.delete(id);onRefresh(id);}
  }));
  row.querySelectorAll('[data-delivery-skip]').forEach(b=>b.addEventListener('click',async()=>{
    if(busy.has(id))return;
    if(b.dataset.skipEnds==='true' && !window.confirm('跳过本步负责人会结束本次任务，不会合并。已交付的文件保留。确定吗？'))return;
    busy.add(id);b.disabled=true;
    try{const r=await ipcRenderer.invoke('delivery:skip',{meetingId:id,memberId:b.dataset.deliverySkip});if(!r.ok)throw new Error(r.error || '跳过失败');states.delete(id);}
    catch(e){onError(e.message);}finally{busy.delete(id);onRefresh(id);}
  }));
  if(busy.has(id))row.querySelectorAll('[data-delivery]').forEach(button=>button.disabled=true);
}
const BARE_CONTINUE=/^(?:继续(?:执行|施工|任务)?|接着做|恢复执行)[。！!\s]*$/u;
async function submit(meeting,text,recipientSids) {
  const s=await ipcRenderer.invoke('delivery:status',{meetingId:meeting.id});if(!s.ok)throw new Error(s.error);
  // A typed "继续" on a paused run means the same as the continue button;
  // any extra words after it are then sent as a supplement, never dropped.
  if(s.runId && !s.finished && (s.paused || s.recoveryPending) && require('../core/dev-file-workflow').isResume(text)){
    const r=await ipcRenderer.invoke('delivery:resume',{meetingId:meeting.id});if(!r.ok)throw new Error(r.error);
    if(BARE_CONTINUE.test(String(text).trim()))return {...r,resumed:true};
  }
  // Not armed and no task running: an ordinary group-chat message.
  if((!s.runId || s.finished) && !s.armed)return {plain:true};
  if(s.runId && !s.finished){
    const targets=Recipients.resolveRecipients(meeting,recipientSids);
    const r=await ipcRenderer.invoke('groupchat:user-supplement',{meetingId:meeting.id,text,recipientSids:targets});
    if(!r.ok)throw new Error(r.reason || r.error);return {...r,supplement:true};
  }
  // The workflow picks each step's members; the user only types the task.
  const r=await ipcRenderer.invoke('delivery:start',{meetingId:meeting.id,userInput:text});if(!r.ok)throw new Error(r.error);return r;
}
module.exports={render,submit,clear:id=>{versions.set(id,(versions.get(id)||0)+1);states.delete(id);}};
