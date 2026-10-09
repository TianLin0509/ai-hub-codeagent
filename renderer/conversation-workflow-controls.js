'use strict';
const {ipcRenderer}=require('electron');
const Relay=require('./conversation-relay');
const states=new Map(),pending=new Set(),versions=new Map(),busy=new Set();
let refresh=()=>{};
ipcRenderer.on('workflow:progress',(_e,s)=>{
  if(!s?.meetingId)return;
  versions.set(s.meetingId,(versions.get(s.meetingId)||0)+1);
  states.set(s.meetingId,{...s,running:s.status==='running'});refresh(s.meetingId);
});
function render(row,meeting,onRefresh,onError,options={}){
  refresh=onRefresh;
  const id=meeting.id,w=meeting.serialWorkflow,s=states.get(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  if(!s&&!pending.has(id)){
    const version=versions.get(id)||0;pending.add(id);
    ipcRenderer.invoke('loop:status',{meetingId:id}).then(r=>{
      if(version!==(versions.get(id)||0))return;
      if(r.error)throw Error(r.error);
      const previous=r.serialRunState||w.serialRunState||{};
      states.set(id,{...previous,...r,status:r.running?'running':previous.status==='running'?'paused':previous.status});
    }).catch(e=>{if(version===(versions.get(id)||0))states.set(id,{error:{reason:e.message},status:'unavailable'});})
      .finally(()=>{pending.delete(id);refresh(id);});
  }
  const order=[];
  for(let i=0;i<w.steps.length;i++){
    order.push(w.steps[i].map(mid=>{const n=meeting.slotSpecs.findIndex((slot,j)=>(slot.memberId||`m${j+1}`)===mid);return meeting.slotSpecs[n]?.displayName||meeting.slotSpecs[n]?.title||meeting.slotSpecs[n]?.kind||mid;}).join('、'));
    if(w.stepConfigs[i]?.after==='end')break;
  }
  const run={...(s?.status==='unavailable'?w.serialRunState:{}),...s};
  const members=Relay.targets(meeting,run,options.groupState),view=Relay.presentation(run,members,order);
  const shortcuts=view.abnormal?members.map(m=>`${m.prompt?`<button type="button" data-conversation="copy" data-member="${esc(m.memberId)}" title="复制存档全文；请先核对 CLI，避免重复发送">${members.length===1?'复制本轮 Prompt':`复制 ${esc(m.label)} Prompt`}</button>`:''}<button type="button" data-conversation="cli" data-member="${esc(m.memberId)}" title="只查看对应会话，不发送、不重启">打开 ${esc(m.label)} CLI</button>`).join(''):'';
  const detail=view.abnormal?(members.some(m=>!m.prompt)?'本轮完整 Prompt 暂无存档；先查看 CLI。':'先查看 CLI；若需手动发送，请先暂停接力。'):'';
  const markup=`<section class="mr-file-flow mr-conversation-flow" aria-label="按顺序发言" data-conversation-status="${esc(s?.status||'idle')}" data-relay-abnormal="${view.abnormal}"><div class="mr-relay-detail"><strong title="${esc(order.join(' → '))}">发言顺序：${esc(order.join(' → '))}</strong><p title="${esc(view.label)}">${esc(view.label)}</p>${detail?`<small>${esc(detail)}</small>`:''}</div><div class="mr-file-actions">${shortcuts}${view.running?'<button type="button" data-conversation="stop">暂停发言</button>':view.resume?'<button type="button" data-conversation="resume">继续发言</button>':s?.status==='unavailable'?'<button type="button" data-conversation="refresh">重试读取</button>':''}</div></section>`;
  // Metadata updates must not replace a button between pointer-down and click.
  // Keep its listener and identity when the visible progress has not changed.
  row._conversationActions={meetingId:id,members,options};
  const renderKey=id+':'+markup;
  if(row.firstElementChild?.classList.contains('mr-conversation-flow')&&row._conversationMarkup===renderKey){
    row.querySelectorAll('[data-conversation]').forEach(button=>{button.disabled=busy.has(id);});
    return;
  }
  row.innerHTML=markup;row._conversationMarkup=renderKey;
  row.querySelectorAll('[data-conversation]').forEach(button=>{
    button.disabled=busy.has(id);
    button.addEventListener('click',async()=>{
      if(busy.has(id))return;
      busy.add(id);button.disabled=true;
      try{
        const action=button.dataset.conversation;
        if(action==='copy'||action==='cli'){
          const context=row._conversationActions;
          const target=context?.meetingId===id&&context.members.find(m=>m.memberId===button.dataset.member);
          if(!target)throw Error('本轮成员已变化，请重新查看');
          if(action==='copy')await context.options.onCopy(target);
          else await context.options.onOpen(target);
          return;
        }
        if(action==='refresh'){states.delete(id);return;}
        const channel=button.dataset.conversation==='stop'?'workflow:stop':'serial:resume';
        const result=await ipcRenderer.invoke(channel,{meetingId:id});
        if(!result.ok)throw Error(result.reason||'发言操作未完成');
        states.delete(id);
      }catch(error){onError(error.message);}finally{busy.delete(id);onRefresh(id);}
    });
  });
}
function clear(id){versions.set(id,(versions.get(id)||0)+1);states.delete(id);}
module.exports={render,clear};
