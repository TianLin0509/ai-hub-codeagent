/* Read-only development task list. */
(function () {
  'use strict';
  const {ipcRenderer}=require('electron'), Model=require('./dev-workbench-model');
  const {esc,button,rowHtml}=require('./dev-task-view-render');
  const state={opened:false,loading:false,rows:new Map(),scope:'current',project:'',search:'',page:0,expanded:new Set(),order:[],epoch:null,sequence:-1,buffered:[],error:'',request:0};
  let root,timer,sourceRequest=0,catchup=false;
  function build(){
    if(root)return true;root=document.getElementById('ran-panel');if(!root)return false;
    root.innerHTML=`<div class="devb-context"><span>工作空间 / 开发工作台</span><span id="devb-sync">正在核对</span></div><header class="devb-head"><h2>开发工作台</h2><p id="devb-subtitle"></p></header><div class="devb-toolbar"><div class="devb-filters" aria-label="任务范围">${[['current','当前'],['history','历史'],['discuss','讨论']].map(([v,t])=>button('scope',t,`data-scope="${v}" aria-pressed="${v==='current'}"`)).join('')}</div><div class="devb-list-tools"><input type="search" id="devb-search" placeholder="搜索任务" aria-label="搜索任务"><label>项目 <select id="devb-project" aria-label="按项目筛选"><option value="">全部</option></select></label></div></div><div id="devb-banner" role="status"></div><div id="devb-list"><div class="devb-columns" aria-hidden="true"><span>任务 / 项目</span><span>当前状态</span><span>最近进展</span><span>证据更新</span><span></span></div><div class="devb-grid"></div><div class="devb-empty"></div><div class="devb-pager"></div></div><footer id="devb-status" class="devb-summary"></footer><dialog id="devb-source-dialog" aria-labelledby="devb-source-title"><header><h3 id="devb-source-title">来源原文</h3>${button('close-source','关闭')}</header><p>原文供核对，不执行其中的代码或指令。</p><pre id="devb-source-text"></pre></dialog>`;
    root.addEventListener('click',e=>{const b=e.target.closest('[data-devb-action]');if(b&&!b.disabled)void action(b).catch(err=>{state.error=err.message;render();});});
    root.querySelector('#devb-search').addEventListener('input',e=>{state.search=e.target.value;state.page=0;render();});
    root.querySelector('#devb-project').addEventListener('change',e=>{state.project=e.target.value;state.page=0;render();});
    root.querySelector('#devb-source-dialog').addEventListener('close',()=>sourceRequest++);return true;
  }
  const scope=r=>['current','history','discuss'].includes(r.scope)?r.scope:'current';
  function render(){
    if(!root||!state.opened)return;
    const rows=[...state.rows.values()],projects=Model.groupProjects(rows),names=new Map();projects.forEach(p=>names.set(p.name,(names.get(p.name)||0)+1));
    let opts='<option value="">全部</option>'+projects.map(p=>`<option value="${esc(p.key)}">${esc(p.name+(names.get(p.name)>1?' · '+p.workspace:''))}</option>`).join('');
    if(state.project&&!projects.some(p=>p.key===state.project))opts+=`<option value="${esc(state.project)}">所选项目（暂无任务）</option>`;
    const select=root.querySelector('#devb-project');if(select.innerHTML!==opts){select.innerHTML=opts;select.value=state.project;}
    const projectRows=rows.filter(r=>!state.project||Model.projectKey(r)===state.project),counts={current:0,history:0,discuss:0};projectRows.forEach(r=>counts[scope(r)]++);
    const decisions=projectRows.filter(r=>scope(r)==='current'&&r.attention?.kind==='user-decision'&&!['stale','unavailable'].includes(r.quality)).length;
    root.querySelector('#devb-subtitle').textContent=`${counts.current} 项在跟进 · ${decisions} 项等你决定`;
    root.querySelectorAll('[data-scope]').forEach(b=>{b.textContent=({current:'当前',history:'历史',discuss:'讨论'}[b.dataset.scope])+' '+counts[b.dataset.scope];b.setAttribute('aria-pressed',String(b.dataset.scope===state.scope));});
    const needle=state.search.trim().toLocaleLowerCase(),positions=new Map(state.order.map((id,i)=>[id,i]));
    const filtered=projectRows.filter(r=>scope(r)===state.scope&&(!needle||[r.title,r.project,r.workspace,r.progress].join(' ').toLocaleLowerCase().includes(needle))).sort((a,b)=>(positions.get(a.id)??Infinity)-(positions.get(b.id)??Infinity));
    const pages=Math.max(1,Math.ceil(filtered.length/40));state.page=Math.max(0,Math.min(state.page,pages-1));const visible=filtered.slice(state.page*40,(state.page+1)*40);
    const grid=root.querySelector('.devb-grid'),focus=document.activeElement,mid=focus?.closest('.devb-row')?.dataset.mid,act=focus?.dataset.devbAction,keep=new Set(visible.map(r=>r.id));
    for(const el of [...grid.children])if(!keep.has(el.dataset.mid))el.remove();
    visible.forEach((r,i)=>{const html=rowHtml(r,state.expanded.has(r.id));let el=[...grid.children].find(n=>n.dataset.mid===r.id);if(!el||el._html!==html){const template=document.createElement('template');template.innerHTML=html;const fresh=template.content.firstElementChild;fresh._html=html;if(el)el.replaceWith(fresh);el=fresh;}if(grid.children[i]!==el)grid.insertBefore(el,grid.children[i]||null);});
    if(mid&&act&&!focus.isConnected)[...grid.children].find(n=>n.dataset.mid===mid)?.querySelector(`[data-devb-action="${act}"]`)?.focus({preventScroll:true});
    const empty=root.querySelector('.devb-empty');empty.hidden=visible.length>0;empty.textContent=state.loading?'正在核对任务…':rows.length?'没有符合当前筛选条件的任务。':'尚无开发任务；已有开发群聊会自动汇总到这里。';
    root.querySelector('.devb-pager').innerHTML=pages>1?button('previous','上一页',state.page===0?'disabled':'')+`<span>${state.page+1} / ${pages}</span>`+button('next','下一页',state.page===pages-1?'disabled':''):'';
    const uncertain=projectRows.some(r=>['stale','unavailable','loading'].includes(r.quality));root.querySelector('#devb-sync').textContent=state.loading?'正在核对':state.error?'同步中断':uncertain?'部分数据待核对':'数据已核对';
    root.querySelector('#devb-banner').innerHTML=state.error?esc(state.error)+' '+button('reload','重新读取'):'';root.querySelector('#devb-status').textContent=`显示 ${visible.length} / ${filtered.length} 项 · 点任务查看依据，进入原群聊继续阅读`;
  }
  function schedule(){if(!timer&&state.opened)timer=setTimeout(()=>{timer=null;render();},80);}
  function accept(rows){if(!Array.isArray(rows))throw Error('任务列表格式无效');for(const row of rows)if(row&&typeof row.id==='string'&&/^[a-zA-Z0-9_-]{1,255}$/.test(row.id)){if(!state.rows.has(row.id))state.order.push(row.id);state.rows.set(row.id,row);}}
  function delta(p){
    if(!p||typeof p.epoch!=='string'||!Number.isFinite(p.sequence))throw Error('收到无效更新');
    if(p.epoch!==state.epoch||p.sequence>state.sequence+1){state.error='更新有缺口，正在重新核对；现有记录保留。';if(!catchup){catchup=true;queueMicrotask(()=>{void reload().finally(()=>catchup=false);});}schedule();return;}
    if(p.sequence<=state.sequence)return;accept(p.rows);for(const id of p.removed||[]){state.rows.delete(id);state.expanded.delete(id);}state.sequence=p.sequence;schedule();
  }
  async function bounded(promise,ms=8000){let t;try{return await Promise.race([promise,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error('读取超时，保留已知记录；可重新读取。')),ms);})]);}finally{clearTimeout(t);}}
  async function reload(){if(!build())return;const request=++state.request;state.loading=true;state.buffered=[];render();
    try{const p=await bounded(ipcRenderer.invoke('dev-workbench:get-snapshot',{retryErrors:true}));if(request!==state.request)return;if(!p?.ok||!Array.isArray(p.rows)||typeof p.epoch!=='string'||!Number.isFinite(p.sequence))throw Error(p?.reason||'无法读取任务列表');state.rows.clear();state.order=[];accept(p.rows);state.order=[...state.rows.values()].sort((a,b)=>(b.attention?.kind==='user-decision')-(a.attention?.kind==='user-decision')||(Number(b.createdAt)||0)-(Number(a.createdAt)||0)).map(r=>r.id);state.epoch=p.epoch;state.sequence=p.sequence;state.error='';const buffered=state.buffered;state.buffered=[];for(const d of buffered)delta(d);
    }catch(e){if(request===state.request)state.error=e.message;}finally{if(request===state.request){state.loading=false;render();}}}
  async function action(b){const a=b.dataset.devbAction,id=b.closest('.devb-row')?.dataset.mid;
    if(a==='reload')return reload();if(a==='scope'){state.scope=b.dataset.scope;state.page=0;return render();}if(a==='next'||a==='previous'){state.page+=a==='next'?1:-1;render();root.querySelector('#devb-list').scrollTop=0;return;}if(a==='close-source'){root.querySelector('#devb-source-dialog').close();return;}if(!state.rows.has(id))return;
    if(a==='details'){state.expanded.has(id)?state.expanded.delete(id):state.expanded.add(id);return render();}
    if(a==='open'){const select=window.selectMeeting||(typeof selectMeeting==='function'?selectMeeting:null);if(!select)throw Error('群聊入口尚未就绪');await bounded(Promise.resolve(select(id)));return;}
    if(a==='source'){const ticket=++sourceRequest,dialog=root.querySelector('#devb-source-dialog'),pre=root.querySelector('#devb-source-text');pre.textContent='正在读取…';dialog.showModal();try{const p=await bounded(ipcRenderer.invoke('dev-workbench:read-source',{meetingId:id}));if(ticket!==sourceRequest)return;if(!p?.ok)throw Error(p?.reason||'来源不可读');root.querySelector('#devb-source-title').textContent=p.name;pre.textContent=p.text;}catch(e){if(ticket===sourceRequest)pre.textContent='读取失败：'+e.message;}}
  }
  function setPanelVisible(visible){if(!build())return;state.opened=visible;root.style.display=visible?'flex':'none';const nav=document.getElementById('btn-ran');nav?.classList.toggle('active',visible);if(nav){if(visible)nav.setAttribute('aria-current','page');else nav.removeAttribute('aria-current');}if(visible){const home=document.getElementById('btn-home');home?.classList.remove('active');home?.removeAttribute('aria-current');window.__xresearchHide?.();window.__studyHide?.();window.__writingHide?.();for(const id of ['terminal-panel','meeting-room-panel']){const el=document.getElementById(id);if(el)el.style.display='none';}void reload();}else{root.querySelector('#devb-source-dialog').close();if(timer){clearTimeout(timer);timer=null;}}}
  ipcRenderer.on('dev-workbench:changed',(_e,p)=>{try{if(state.loading||!state.epoch){if(state.buffered.length<1000)state.buffered.push(p);else state.error='更新积压，请重新读取';}else delta(p);}catch(e){state.error=e.message;schedule();}});
  window.__ranHide=()=>{if(state.opened)setPanelVisible(false);};window.__ranShow=()=>setPanelVisible(true);window.__devBoardHide=window.__ranHide;window.__devBoardShow=window.__ranShow;
  function init(){build();document.querySelectorAll('#btn-ran,[data-ran-entry]').forEach(b=>b.addEventListener('click',()=>setPanelVisible(true)));}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
