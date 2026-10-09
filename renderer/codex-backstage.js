'use strict';

const MAX_ENTRIES = 180;
const { backstageStatus } = require('../core/native-backstage-status');
function createCodexBackstage({ document:doc, ipcRenderer, sessionId, getSession, focusComposer, renderProse, onModeChange = () => {} }) {
  const make = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const root = make('section', 'codex-backstage');
  const provider = require('../core/native-ui-labels').nativeUiLabel(getSession());
  root.setAttribute('aria-label', provider + ' 后台工作记录');
  root.addEventListener('click', event => event.stopPropagation());
  const toolbar = make('div','cb-toolbar');
  const heading = make('span','cb-heading cb-live');
  const indicator = make('span','cb-live-indicator');indicator.setAttribute('aria-hidden','true');
  const liveLabel = make('span','cb-live-label');liveLabel.setAttribute('role','status');
  const elapsed = make('span','cb-live-elapsed');elapsed.setAttribute('aria-hidden','true');
  heading.append(indicator,liveLabel,elapsed);
  const tabs = make('div','cb-tabs'); tabs.setAttribute('aria-label','后台显示方式');
  const button = (text, action, className = '') => { const node = make('button', className, text); node.type='button'; node.addEventListener('click',action); return node; };
  const readable = button('工作记录',()=>changeView('readable'));
  const raw = button('原始记录',()=>changeView('raw'));
  const legacy = button('原终端',()=>changeView('legacy'));
  tabs.append(readable,raw,legacy);
  const appearance = make('select','cb-appearance'); appearance.setAttribute('aria-label','后台观感');
  for (const [value,text] of [['refined','清爽 CLI'],['classic','经典 CLI']]) { const option=make('option','',text);option.value=value;appearance.append(option); }
  const size = make('select','cb-font-size'); size.setAttribute('aria-label','后台字号');
  for (const value of [13,14,16,18]) { const option=make('option','',value+'px');option.value=String(value);size.append(option); }
  size.value='14';
  const exportButton = button('导出原始记录',()=>exportOriginal(),'cb-export');
  const compatibility = make('span','cb-compat');compatibility.hidden=true;
  toolbar.append(heading,tabs,appearance,size,compatibility,exportButton);
  const area = make('div','cb-area');
  const viewport = make('div','cb-viewport'); viewport.tabIndex=0;viewport.setAttribute('aria-label','后台记录，可上下滚动');
  const older = button('加载较早记录',()=>loadOlder(),'cb-older'); older.hidden=true;
  const list = make('div','cb-list');
  const rawList = make('div','cb-raw-list');rawList.hidden=true;
  const empty = make('div','cb-empty');
  const emptyTitle=make('h2','','让想法开始运行'),emptyDetail=make('p','','在下方输入任务，执行过程和原始输出会在这里展开。');
  const emptyInput=button('开始输入 ↗',focusComposer);
  empty.append(make('div','cb-empty-mark','›_'),emptyTitle,emptyDetail,emptyInput);
  const loading = make('div','cb-notice','正在读取后台记录…');
  const follow = button('↓ 回到最新',()=>followLatest(),'cb-follow');follow.hidden=true;
  viewport.append(older,loading,empty,list,rawList);area.append(viewport,follow);
  const status = make('div','cb-status');status.setAttribute('role','status');
  const stateText = make('span','cb-state');
  const stateDetail = make('span','cb-state-detail');
  const followState = make('span','cb-follow-state','跟随最新');
  status.append(stateText,stateDetail,followState);
  root.append(toolbar,area,status);
  const nodes = new Map();
  let mode='readable',visible=false,dead=false,host=null,timer=null,busy=false,dirty=true,revision=null,first=null,rawFirst=null,rawLast=null;
  let followBottom=true,unread=0,scrollTop=0,more=false,historyMore=false,unsupported=false,needsLatest=false,resizeFrame=null;
  let detailDialog=null,readCount=0,paintCount=0,pendingReset=true,modeEpoch=0,exporting=false;
  let statusTimer=null;
  try { const pref=JSON.parse(localStorage.getItem('codex-backstage-display')||'{}');appearance.value=pref.appearance==='classic'?'classic':'refined';if([13,14,16,18].includes(pref.size))size.value=String(pref.size); }
  catch (error) { console.warn('[codex-backstage] display preference:',error.message); }
  function saveDisplay() { root.classList.toggle('cb-classic',appearance.value==='classic');root.style.setProperty('--cb-font-size',size.value+'px');try{localStorage.setItem('codex-backstage-display',JSON.stringify({appearance:appearance.value,size:Number(size.value)}));}catch(error){console.warn('[codex-backstage] display preference:',error.message);}if(followBottom)pin(); }
  appearance.addEventListener('change',saveDisplay);size.addEventListener('change',saveDisplay);saveDisplay();
  function nearBottom(){return viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop<24;}
  function followUi(){follow.hidden=followBottom;follow.textContent=unread?`↓ ${unread} 次新输出 · 回到最新`:'↓ 回到最新';followState.textContent=followBottom?'跟随最新':'阅读历史';}
  function pin(){if(!visible||mode==='legacy')return;viewport.scrollTop=viewport.scrollHeight;scrollTop=viewport.scrollTop;}
  function anchor(){if(followBottom)return null;const rect=viewport.getBoundingClientRect();const row=[...((mode==='raw'?rawList:list).children)].find(node=>node.getBoundingClientRect().bottom>rect.top);return row?{row,top:row.getBoundingClientRect().top}:null;}
  function preserve(point){if(followBottom)pin();else if(point?.row.isConnected)viewport.scrollTop+=point.row.getBoundingClientRect().top-point.top;scrollTop=viewport.scrollTop;followUi();}
  viewport.addEventListener('wheel',event=>{if(event.deltaY<0){followBottom=false;followUi();}},{passive:true});
  viewport.addEventListener('keydown',event=>{if(['ArrowUp','PageUp','Home'].includes(event.key)){followBottom=false;followUi();}});
  viewport.addEventListener('scroll',()=>{if(!visible)return;scrollTop=viewport.scrollTop;if(nearBottom()){followBottom=true;unread=0;}else followBottom=false;followUi();},{passive:true});
  const ro=new ResizeObserver(()=>{if(!visible||!followBottom)return;cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(followBottom)pin();});});ro.observe(viewport);
  function setText(node,text){text=String(text??'');if(node.textContent===text)return;if(text.startsWith(node.textContent))node.append(doc.createTextNode(text.slice(node.textContent.length)));else node.textContent=text;}
  function error(message){loading.hidden=false;loading.classList.add('cb-error');loading.textContent=message;}
  async function request(options){readCount++;const result=await ipcRenderer.invoke('codex:backstage-read',{sessionId,...options});if(!result?.ok)throw Error(result?.message||'未能读取后台原始记录');return result;}
  function rowStatus(entry){if(entry.type==='diagnostic')return entry.level==='error'?'错误':entry.level==='warning'?'诊断':'记录';if(entry.exitCode!=null)return 'exit '+entry.exitCode;return ({running:'运行中',inProgress:'运行中',completed:'已完成',failed:'失败',declined:'已拒绝',interrupted:'已中断'})[entry.status]||entry.status||'状态未知';}
  function preview(entry){const fields=entry.fields||{};const field=fields.text||fields.output||fields.message||fields.summary||fields.error||fields.details;return field?field.preview:'';}
  function paint(entry,olderPage=false){
    if(entry.type==='reasoning'&&!entry.fields.summary?.length&&!entry.fields.text?.length)return;
    let row=nodes.get(entry.id);
    if(!row&&nodes.size>=MAX_ENTRIES&&!followBottom&&!olderPage){needsLatest=true;return;}
    if(!row){
      row=make('article','cb-entry');row.dataset.entryId=entry.id;row.dataset.ordinal=String(entry.ordinal);
      row._head=make('div','cb-entry-head');row._mark=make('span','cb-mark');row._title=make('span','cb-title');row._meta=make('span','cb-meta');row._head.append(row._mark,row._title,row._meta);
      row._command=make('pre','cb-command');row._body=make('div','cb-output');row._body.tabIndex=0;
      row._error=make('pre','cb-inline-error');
      row._details=make('details','cb-tool');row._summary=make('summary');row._summary.append(row._head);row._details.append(row._summary,row._command,row._body,row._error);
      row._full=button('查看完整内容',()=>openDetail(row._entry),'cb-full');row._length=make('span','cb-length');row._footer=make('div','cb-output-footer');row._footer.append(row._length,row._full);row._details.append(row._footer);row.append(row._details);
      row._details.open=['running','inProgress','failed'].includes(entry.status)||entry.exitCode>0||['agentMessage','userMessage','diagnostic'].includes(entry.type);
      nodes.set(entry.id,row);
      const next=[...list.children].find(node=>Number(node.dataset.ordinal)>entry.ordinal);list.insertBefore(row,next||null);
    }
    const last=row._entry;row._entry=entry;row.dataset.type=entry.type;row.dataset.status=entry.status;row.dataset.level=entry.level||'';
    const isError=entry.status==='failed'||entry.exitCode>0||entry.level==='error'||!!entry.fields.error;
    row.classList.toggle('cb-failed',isError);row.classList.toggle('cb-prose',['agentMessage','userMessage'].includes(entry.type));
    if(isError&&!(last?.status==='failed'||last?.exitCode>0||last?.level==='error'||last?.fields.error))row._details.open=true;
    setText(row._mark,entry.type==='userMessage'?'›':entry.type==='agentMessage'?'✳':isError?'×':entry.type==='diagnostic'?'·':['running','inProgress'].includes(entry.status)?'•':entry.type==='turn'?'—':'✓');
    let title=entry.title;
    if(entry.type==='agentMessage')title=entry.phase==='final_answer'?provider+' · 回答':provider;
    if(entry.type==='commandExecution'&&entry.fields.command?.preview)title='$ '+entry.fields.command.preview.split(/\r?\n/)[0].slice(0,140);
    setText(row._title,title);
    const prose=['agentMessage','userMessage'].includes(entry.type);
    const duration=Number(entry.durationMs);setText(row._meta,[entry.historical?'历史':null,entry.type==='userMessage'||(prose&&entry.status==='completed')?null:rowStatus(entry),duration>0?(duration/1000).toFixed(1)+'s':null].filter(Boolean).join(' · '));
    const command=entry.fields.command;row._command.hidden=!command||(entry.type==='commandExecution'&&command.preview.length<=140&&!command.preview.includes('\n'));setText(row._command,command?'$ '+command.preview:'');
    const errorText=entry.fields.error?.preview||(isError&&entry.type==='diagnostic'?entry.fields.details?.preview:'')||'';
    const text=preview(entry);const bodyText=text===errorText?'':text;
    const formatted=entry.type==='agentMessage'&&entry.status==='completed'&&!!renderProse;
    if(formatted){if(row._formattedSource!==bodyText){row._body.innerHTML=renderProse(bodyText);row._formattedSource=bodyText;}}
    else{if(row._formattedSource!=null){row._body.replaceChildren();row._formattedSource=null;}setText(row._body,bodyText);}
    row._body.classList.toggle('cb-markdown',formatted);row._body.hidden=!bodyText;
    if(followBottom&&row._details.open&&!prose)row._body.scrollTop=row._body.scrollHeight;
    setText(row._error,errorText);row._error.hidden=!errorText;
    const length=Object.values(entry.fields||{}).reduce((sum,field)=>sum+field.length,0);
    const cut=Object.values(entry.fields||{}).some(field=>field.length>field.preview.length);
    const showFull=length&&(!prose||cut);
    setText(row._length,cut?'显示末尾预览 · 原文 '+length.toLocaleString()+' 字符':'');row._full.hidden=!showFull;row._footer.hidden=!showFull;
    row._full.textContent=cut?'查看完整原文 ↗':'原始内容 ↗';
    if(nodes.size>MAX_ENTRIES){const removal=olderPage?list.lastElementChild:list.firstElementChild;if(removal!==row){nodes.delete(removal.dataset.entryId);removal.remove();more=true;if(olderPage)needsLatest=true;}}
  }
  function rawChunk(chunk,prepend=false){const row=make('section','cb-raw-chunk');row.dataset.seq=String(chunk.seq);row.append(make('div','cb-raw-source',`${new Date(chunk.stamp).toLocaleTimeString()} · ${chunk.id} / ${chunk.field} / v${chunk.generation}`),make('pre','cb-raw-text',chunk.text));if(prepend)rawList.prepend(row);else rawList.append(row);while(rawList.childElementCount>60){(prepend?rawList.lastElementChild:rawList.firstElementChild).remove();more=true;}rawFirst=Number(rawList.firstElementChild?.dataset.seq)||null;rawLast=Number(rawList.lastElementChild?.dataset.seq)||null;}
  function renderPage(page,{old=false,reset=false}={}){
    paintCount++;const point=anchor();loading.hidden=true;loading.classList.remove('cb-error');
    if(reset){nodes.clear();list.replaceChildren();rawList.replaceChildren();rawFirst=rawLast=null;first=null;needsLatest=false;}
    if(mode==='raw'){
      for(const chunk of old?[...(page.chunks||[])].reverse():page.chunks||[])if(!rawList.querySelector(`[data-seq="${chunk.seq}"]`)){
        if(!old&&!followBottom&&rawList.childElementCount>=60){needsLatest=true;break;}
        if(old&&rawList.childElementCount>=60)needsLatest=true;
        rawChunk(chunk,old);
      }
    }else for(const entry of page.entries||[])paint(entry,old);
    if(!old)revision=page.revision;
    first=Number(list.firstElementChild?.dataset.ordinal)||null;historyMore=page.historyMore;
    more=old?page.more:more||page.more;
    older.hidden=!(more||historyMore||(mode==='raw'&&rawFirst>1));empty.hidden=!!(list.childElementCount||rawList.childElementCount);empty.querySelector('p').textContent=page.capture||'在下方输入任务，执行过程与输出会在这里展开。';
    if(!followBottom&&!old)unread++;preserve(point);updateStatus();
  }
  async function refresh(reset=false){
    pendingReset ||= reset;
    if(dead||!visible||!root.isConnected||mode==='legacy'||doc.hidden){dirty=true;return;}
    if(mode==='raw'&&needsLatest&&!followBottom&&!pendingReset){dirty=true;return;}
    if(busy){dirty=true;return;}busy=true;dirty=false;
    reset=pendingReset;pendingReset=false;
    const requestedEpoch=modeEpoch;
    const incremental=mode==='raw'?rawLast!=null&&!reset:revision!=null&&!reset;
    try{
      const page=await request(mode==='raw'?{mode:'raw',...(rawLast&&!reset?{after:rawLast}:{})}:{...(revision!=null&&!reset?{since:revision}:{}),limit:40});
      if(dead||requestedEpoch!==modeEpoch||!visible||doc.hidden){dirty=true;pendingReset ||= reset;return;}
      if(page.unsupported){unsupported=true;exportButton.disabled=true;compatibility.hidden=false;compatibility.textContent='后台待升级';compatibility.title=page.message;error(page.message);changeView('legacy');return;}
      if(unsupported){unsupported=false;exportButton.disabled=exporting;compatibility.hidden=true;toolbar.title='';}
      if(page.compatibility){compatibility.hidden=false;compatibility.textContent='历史兼容视图';compatibility.title=page.capture;}
      else compatibility.hidden=true;
      renderPage(page,{reset:reset||page.reset});
      // Only catch up a bounded page when an event or user action found more
      // changes. There is no interval polling when the source is idle.
      if(page.more&&incremental&&!needsLatest)dirty=true;
    }catch(err){if(!dead)error(err.message+'；可切换“原终端”查看兼容输出。');}
    finally{busy=false;if(dirty)schedule();}
  }
  function schedule(){dirty=true;if(dead||timer||!visible||!root.isConnected||mode==='legacy'||doc.hidden)return;timer=setTimeout(()=>{timer=null;void refresh();},80);}
  async function loadOlder(){if(busy)return;busy=true;older.disabled=true;followBottom=false;followUi();const requestedEpoch=modeEpoch;try{const page=await request(mode==='raw'?{mode:'raw',before:rawFirst}:{before:first,history:true,limit:40});if(!dead&&requestedEpoch===modeEpoch)renderPage(page,{old:true});}catch(err){error(err.message);}finally{busy=false;older.disabled=false;if(dirty)schedule();}}
  function followLatest(){followBottom=true;unread=0;followUi();if(needsLatest){needsLatest=false;revision=null;void refresh(true);}else pin();}
  function changeView(next){mode=next;modeEpoch++;pendingReset=true;onModeChange(next);root.dataset.view=mode;readable.setAttribute('aria-pressed',String(next==='readable'));raw.setAttribute('aria-pressed',String(next==='raw'));legacy.setAttribute('aria-pressed',String(next==='legacy'));host?.classList.toggle('codex-backstage-legacy',next==='legacy');list.hidden=next!=='readable';rawList.hidden=next!=='raw';area.hidden=next==='legacy';status.hidden=next==='legacy';appearance.hidden=next!=='readable';older.hidden=true;
    if(next!=='legacy'){revision=null;rawFirst=rawLast=null;more=false;followBottom=true;unread=0;void refresh(true);}else{loading.hidden=!unsupported;toolbar.title=unsupported?loading.textContent:'';} }
  function updateStatus(){
    if(dead)return;
    const value=backstageStatus(getSession());
    const health = value.animated ? require('./hub-feedback-health').healthText() : '';
    if (health) value.detail = `${health} · ${value.detail}`;
    const animate=value.animated&&visible&&!doc.hidden;
    heading.dataset.state=value.state;heading.dataset.animated=String(animate);
    setText(liveLabel,`${value.provider} · ${value.title}`);setText(elapsed,value.elapsed);
    heading.title=value.detail+' 动态标记表示任务或请求尚未结束，不代表服务端持续返回心跳。';
    setText(indicator,value.animated?'':({completed:'✓',interrupted:'■',failed:'×',waiting:'?',unknown:'!'}[value.state]||'·'));
    status.dataset.state=value.state;setText(stateText,value.title);setText(stateDetail,value.detail);stateDetail.title=value.detail;
    setText(emptyTitle,value.engaged?value.title:'让想法开始运行');
    setText(emptyDetail,value.engaged?value.detail:'在下方输入任务，执行过程与输出会在这里展开。');emptyInput.hidden=value.engaged;
    host?.classList.toggle('cb-native-engaged',value.engaged);
    // This clock renders existing evidence only: no polling, history reload,
    // xterm writes or runtime mutation. Stop it when hidden or settled.
    if(!animate){clearTimeout(statusTimer);statusTimer=null;}
    else if(!statusTimer)statusTimer=setTimeout(()=>{statusTimer=null;updateStatus();},1000);
  }
  async function exportOriginal(){if(exporting||unsupported)return;exporting=true;exportButton.disabled=true;try{const result=await ipcRenderer.invoke('codex:backstage-export',{sessionId});if(!result?.ok)throw Error(result?.message||'导出失败');}catch(err){error(err.message);}finally{exporting=false;exportButton.disabled=unsupported;}}
  async function openDetail(entry){
    if(detailDialog)detailDialog.close();
    const dialog=make('dialog','cb-detail-dialog');detailDialog=dialog;
    const head=make('header');head.append(make('strong','',entry.title+' · 原始内容'),button('关闭',()=>dialog.close()));
    const content=make('div','cb-detail-content');const nav=make('footer');const notice=make('span','','每页最多 128 Ki 字符；可逐页查看或导出全部原始记录。');const prev=button('上一页',()=>load({before:pageFirst}));const next=button('下一页',()=>load({after:pageLast}));nav.append(notice,prev,next);dialog.append(head,content,nav);doc.body.append(dialog);
    let pageFirst=0,pageLast=0;const expected=entry.id;
    async function load(cursor={after:0}){prev.disabled=next.disabled=true;try{const page=await request({mode:'detail',id:expected,...cursor});if(!dialog.isConnected)return;content.replaceChildren();for(const chunk of page.chunks||[]){const block=make('section');block.append(make('div','cb-raw-source',`${chunk.field} / v${chunk.generation}`),make('pre','cb-raw-text',chunk.text));content.append(block);}if(!page.chunks?.length)content.textContent='该步骤没有原始文本。';pageFirst=page.first;pageLast=page.last;prev.disabled=cursor.after===0||!page.chunks?.length;next.disabled=cursor.before!=null?!page.chunks?.length:!page.more;content.scrollTop=0;}catch(err){content.textContent='读取原文失败：'+err.message;}}
    dialog.addEventListener('close',()=>{dialog.remove();if(detailDialog===dialog)detailDialog=null;},{once:true});dialog.showModal();await load();
  }
  function visibility(){updateStatus();if(!doc.hidden&&visible&&dirty)schedule();}
  doc.addEventListener('visibilitychange',visibility);
  changeView('readable');
  return {
    root,
    mount(target){host=target;target.classList.add('codex-backstage-enabled');target.classList.toggle('codex-backstage-legacy',mode==='legacy');target.append(root);onModeChange(mode);},
    setVisible(value,{force=false}={}){visible=!!value;root.hidden=!visible;updateStatus();if(!visible){clearTimeout(timer);timer=null;return;}viewport.scrollTop=scrollTop;if(force)followLatest();if(dirty||revision==null)schedule();},
    notify(event){if(event?.error)error(event.error);schedule();updateStatus();},
    updateStatus,
    stats(){return{readCount,paintCount,entries:nodes.size,mode,visible,followBottom,revision};},
    dispose(){dead=true;visible=false;clearTimeout(timer);clearTimeout(statusTimer);cancelAnimationFrame(resizeFrame);ro.disconnect();doc.removeEventListener('visibilitychange',visibility);detailDialog?.close();root.remove();host?.classList.remove('codex-backstage-enabled','codex-backstage-legacy','cb-native-engaged');},
  };
}

module.exports={createCodexBackstage,MAX_ENTRIES};
