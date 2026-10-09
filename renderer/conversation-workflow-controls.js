'use strict';
const {ipcRenderer}=require('electron');
const states=new Map(),pending=new Set(),versions=new Map(),busy=new Set();
let refresh=()=>{};
ipcRenderer.on('workflow:progress',(_e,s)=>{
  if(!s?.meetingId)return;
  versions.set(s.meetingId,(versions.get(s.meetingId)||0)+1);
  states.set(s.meetingId,{...s,running:s.status==='running'});refresh(s.meetingId);
});
function render(row,meeting,onRefresh,onError){
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
  const stageIndex=s?.currentStepIndex??s?.nextStepIndex??0;
  const order=[];
  for(let i=0;i<w.steps.length;i++){
    order.push(w.steps[i].map(mid=>{const n=meeting.slotSpecs.findIndex((slot,j)=>(slot.memberId||`m${j+1}`)===mid);return meeting.slotSpecs[n]?.displayName||meeting.slotSpecs[n]?.title||meeting.slotSpecs[n]?.kind||mid;}).join('、'));
    if(w.stepConfigs[i]?.after==='end')break;
  }
  const paused=s?.status==='paused',running=s?.running;
  const label=running?`正在等 ${order[stageIndex]||'本轮成员'} 回答 · 第 ${Number(stageIndex)+1}/${order.length} 轮`
    :paused?`发言已暂停：${s?.error?.reason||s?.lastError?.reason||'上次对话中断'}`
    :s?.status==='unavailable'?`暂时无法读取发言进度：${s.error.reason}`
    :'每条新输入都按此顺序回答';
  const markup=`<section class="mr-file-flow mr-conversation-flow" aria-label="按顺序发言" data-conversation-status="${esc(s?.status||'idle')}"><div><strong>发言顺序：${esc(order.join(' → '))}</strong><p>${esc(label)}</p></div><div class="mr-file-actions">${running?'<button type="button" data-conversation="stop">暂停发言</button>':paused?'<button type="button" data-conversation="resume">继续发言</button>':s?.status==='unavailable'?'<button type="button" data-conversation="refresh">重试读取</button>':''}</div></section>`;
  // Metadata updates must not replace a button between pointer-down and click.
  // Keep its listener and identity when the visible progress has not changed.
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
        if(button.dataset.conversation==='refresh'){states.delete(id);return;}
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
