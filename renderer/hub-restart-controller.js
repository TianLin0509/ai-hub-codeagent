'use strict';

function createHubRestartController({document,ipcRenderer,flush,getView,restoreView}) {
  const button=document.getElementById('btn-hub-restart');
  const panel=document.createElement('section');panel.id='hub-restart-panel';panel.hidden=true;
  panel.setAttribute('aria-live','polite');
  const heading=document.createElement('strong'),summary=document.createElement('p'),list=document.createElement('ul');
  const close=document.createElement('button');close.type='button';close.textContent='收起';close.onclick=()=>{panel.hidden=true;};
  panel.append(heading,summary,list,close);document.body.append(panel);
  let busy=false, current=null;
  function render(plan) {
    if (!plan) return;
    current=plan;panel.hidden=false;list.replaceChildren();
    const restarting=['preparing','ready','restoring'].includes(plan.phase);
    close.disabled=restarting;
    for(const child of document.body.children)if(child!==panel)child.inert=restarting;
    heading.textContent=plan.phase==='preparing' || plan.phase==='ready' ? '正在重启并保存现场' : '重启恢复工作现场';
    const rows=[...(plan.sessions || []),...(plan.groups || []).map(g=>({...g,title:g.title || '群聊 '+g.id.slice(0,8)}))];
    const restored=(plan.sessions || []).filter(s=>['restored','continued','completed','waiting'].includes(s.status)).length;
    summary.textContent=plan.error || (plan.phase==='preparing' ? '正在保存并中断当前任务，新版启动后自动继续。'
      : `已恢复 ${restored}/${plan.sessions?.length || 0} 个会话；${rows.filter(s=>s.status==='continued').length} 项已续作。`);
    for (const row of rows) {
      const li=document.createElement('li'),label=document.createElement('span');
      label.textContent=(row.title || row.id)+'：'+(row.message || '准备恢复');li.append(label);
      if (row.status==='error') {
        const retry=document.createElement('button');retry.textContent='重试恢复';retry.type='button';
        retry.onclick=async()=>{retry.disabled=true;try {render(await ipcRenderer.invoke('hub-restart:retry',row.id));}
          catch(error){summary.textContent=error.message;}finally{retry.disabled=false;}};
        li.append(retry);
      }
      list.append(li);
    }
  }
  ipcRenderer.on('hub-restart:progress',(_e,plan)=>render(plan));
  button?.addEventListener('click',async()=>{
    if(busy)return;
    busy=true;button.disabled=true;panel.hidden=false;
    heading.textContent='正在保存工作现场';summary.textContent='保存草稿与会话后，中断当前任务并重启。';list.replaceChildren();
    try {
      const view=getView();await flush();
      const result=await ipcRenderer.invoke('hub-restart:request',view);
      if(!result?.ok)throw new Error(result?.message || '重启失败');
    } catch(error) {render({phase:'failed',error:error.message});heading.textContent='重启未完成';}
    finally {busy=false;button.disabled=false;}
  });
  return {async restore(){
    try {
      const plan=await ipcRenderer.invoke('hub-restart:restore');
      if(plan){render(plan);if(plan.phase==='done' && plan.view)await restoreView(plan.view);}
    }catch(error){render({phase:'failed',error:error.message});}
  },get current(){return current;}};
}
module.exports={createHubRestartController};
