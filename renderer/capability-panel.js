'use strict';
const {ALL_AI_KINDS,getKindLabel}=require('../core/ai-kinds');
const {coverage,related,isActive}=require('../core/capability-view-model');
const {presentation,mcpSharing,ORIGINS}=require('../core/capability-presentation');
const { SERVICES } = require('../core/tool-account-catalog');
const TYPE_LABEL={skill:'技能',mcp:'MCP 连接',plugin:'插件',command:'命令',tool:'工具'};
const ICON={skill:'<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9Z"/>',
  mcp:'<rect x="7" y="7" width="10" height="10" rx="3"/><path d="M9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4"/>',
  plugin:'<path d="M9 3H4v6h2a3 3 0 1 1 0 6H4v6h5v-2a3 3 0 1 1 6 0v2h5v-6h-2a3 3 0 1 1 0-6h2V3h-5v2a3 3 0 1 1-6 0Z"/>',
  command:'<path d="m5 6 6 6-6 6m8 0h6"/>',tool:'<path d="m4 20 9-9m-2-7a6 6 0 0 0 9 9l-4-2-1-3 2-4a6 6 0 0 0-6 0Z"/>'};
const svg=(type)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[type] || ICON.plugin}</svg>`;
function createCapabilityPanel({document,ipcRenderer,escapeHtml:esc,getActiveSessionId}) {
  let page,catalog=null,runtime=null,tab='catalog',agent='all',type='all',query='',scope='active',selected='',sessionId='',busy=false,error='',epoch=0;
  let sharing=null,shareBusy=false,notice='',origin='all',noteEdit=null,noteBusy=false;
  const label=id=>getKindLabel(id) || id;
  const button=(text,attrs,cls='')=>`<button type="button" class="cp-button ${cls}" ${attrs}>${text}</button>`;
  const badge=(text,cls='')=>`<span class="cp-badge ${cls}">${esc(text)}</span>`;
  function position(){const rail=document.getElementById('scene-rail')?.getBoundingClientRect();if(page&&rail){const sessionEdge=document.getElementById('session-sidebar')?.getBoundingClientRect().left;page.style.left=(sessionEdge??rail.right)+'px';page.style.top=rail.top+'px';}}
  const inScope=r=>scope==='all'||scope==='active'&&isActive(r)||scope==='shared'&&r.shared||scope==='conflict'&&r.conflict||scope==='disabled'&&r.sources.some(s=>s.enabled===false||s.missing);
  function rows(){
    let result=tab==='runtime'?(runtime?.rows || []):(catalog?.rows || []);
    if(tab==='runtime')result=result.map(r=>{
      const known=catalog?.rows.find(c=>c.id===r.id);
      const display=known||presentation(r);
      return {...r,displayName:display.displayName,summary:display.summary,summarySource:display.summarySource,origin:display.origin};
    });
    if(tab!=='runtime')result=result.filter(r=>(agent==='all'||tab==='coverage'||r.agents.includes(agent)) && inScope(r));
    return result.filter(r=>(type==='all'||r.type===type)&&(tab==='runtime'||origin==='all'||r.origin?.kind===origin)&&(!query||`${r.name} ${r.description} ${r.summary}`.toLowerCase().includes(query.toLowerCase())));
  }
  const originBadge=r=>badge(r.origin?.label||'来源待确认','cp-origin-'+(r.origin?.kind||'unknown'));
  function noteForm(r){
    if(noteEdit?.id!==r.id)return button('编辑简述与来源','data-cp-action="note-edit" '+(noteBusy?'disabled':''),'cp-note-edit');
    return `<form class="cp-note-form" id="cp-note-form"><label for="cp-note-summary">一句话说明用途</label><textarea id="cp-note-summary" maxlength="180" placeholder="留空则使用默认说明" ${noteBusy?'disabled':''}>${esc(noteEdit.summary)}</textarea><label for="cp-note-origin">来源类别</label><select id="cp-note-origin" ${noteBusy?'disabled':''}>${[['auto','自动识别'],['self','自建'],['external','外部导入'],['unknown','来源待确认']].map(([k,v])=>`<option value="${k}" ${noteEdit.origin===k?'selected':''}>${v}</option>`).join('')}</select><p class="cp-fine">只保存 Hub 展示信息，不改技能正文、MCP 连接或插件开关。</p><div class="cp-actions"><button type="submit" class="cp-button selected" ${noteBusy?'disabled':''}>${noteBusy?'保存中…':'保存'}</button>${button('取消','data-cp-action="note-cancel" '+(noteBusy?'disabled':''))}</div></form>`;
  }
  function status(r){
    if(tab==='runtime')return badge(r.status,/失败|禁用|未知|未启动|需要授权|未确认|取消/.test(r.status)?'warn':'native');
    if(agent!=='all'&&tab==='catalog'){const c=coverage(r,agent);return badge(c.label,c.tone);}
    const src=r.sources.filter(s=>agent==='all'||s.agent===agent);
    if(src.some(s=>s.missing))return badge('安装待核对','warn');
    if(src.every(s=>s.enabled===false))return badge('已禁用','muted');
    return badge(r.shared?'公共目录':'本地登记',r.shared?'shared':'');
  }
  function connections(r){
    const items=related(catalog?.rows || [],r);
    if(!items.length)return r.type==='plugin'?'<p class="cp-fine">未发现可展示的 Skill / MCP 组件。可能包含账号连接器或其他扩展，请在原生客户端核对。</p>':'';
    return `<h4>${r.type==='plugin'?'包含的技能与连接':'来自插件'}</h4><div class="cp-components">${items.map(x=>button(`${svg(x.type)}<span>${esc(x.name)}<small>${esc(TYPE_LABEL[x.type])}</small></span>`,`data-cp-related="${esc(x.id)}"`)).join('')}</div><p class="cp-fine">依据本地安装目录；组件可用性仍取决于启用范围、授权与客户端支持。</p>`;
  }
  function matrix(visible){
    const agents=ALL_AI_KINDS;
    return `<div class="cp-legend">${badge('共享入口','shared')}${badge('独立入口')}${badge('配置禁用','muted')}${badge('多份正文','warn')}<span>“未发现”只表示扫描范围内未找到；不代表客户端不支持。</span></div><div class="cp-matrix-wrap" tabindex="0" aria-label="各 AI 能力覆盖表，可横向滚动"><table class="cp-matrix"><thead><tr><th scope="col">能力 / 类型</th>${agents.map(a=>`<th scope="col">${esc(label(a))}</th>`).join('')}</tr></thead><tbody>${visible.map(r=>`<tr class="${r.id===selected?'selected':''}"><th scope="row"><button data-cp-row="${esc(r.id)}"><strong>${esc(r.displayName||r.name)}</strong><small>${esc(r.summary)}</small>${originBadge(r)}<small>${esc(TYPE_LABEL[r.type])}${r.conflict?' · 同名差异':''}</small></button></th>${agents.map(a=>{const c=coverage(r,a);return `<td>${badge(c.label,c.tone)}</td>`;}).join('')}</tr>`).join('')}</tbody></table>${!visible.length?'<p class="cp-empty">没有符合筛选条件的能力</p>':''}</div>`;
  }
  function sharingView(){
    if(!sharing)return '';
    return `<section class="cp-share" aria-label="补齐共享技能预览"><div><h3>补齐共享技能</h3><p>新增 ${sharing.operations.length} 个入口 · 保留 ${sharing.preserved} 个现有入口${sharing.variants?' · '+sharing.variants+' 个既有差异':''}</p></div><p class="cp-fine">只补本机普通技能，关联完整目录；已有文件和同名版本保留。专用工具、MCP 授权和 App 账号技能需要分别配置。完成后在新会话核对。</p><div class="cp-share-list">${sharing.operations.map(o=>`<div><strong>${esc(o.name)}</strong><code>${esc(o.source)} → ${esc(o.target)}</code></div>`).join('')||'<p>共享目录已补齐，没有需要新增的入口。</p>'}</div><div class="cp-actions">${sharing.operations.length?button(shareBusy?'正在补齐…':'确认补齐 '+sharing.operations.length+' 个入口','data-cp-action="share-apply" '+(shareBusy?'disabled':''),'selected'):''}${button('收起','data-cp-action="share-close" '+(shareBusy?'disabled':''))}</div></section>`;
  }
  function detail(r){
    if(!r)return '<div class="cp-placeholder">'+svg('plugin')+'<h3>探索你的 AI 能力</h3><p>选择左侧条目，查看来源、覆盖范围和状态。</p></div>';
    const sources=r.sources || [];
    const deps = r.accountDependency;
    const accountInfo = deps ? `<div class="cp-sharing-hint"><h4>账号与登录</h4><p>${esc(deps.services.map(id => SERVICES[id]?.name || id).join('、') || (deps.state === 'unknown' ? '账号依赖待核对' : '此工具本身无需额外登录'))}</p>${deps.services.length || deps.state === 'unknown' ? button('在账号页查看接入状态', 'data-cp-action="accounts"') : ''}<small>本机登记不等于授权有效；共享登录状态在账号页核对。</small></div>` : '';
    return `<div class="cp-detail-head"><span class="cp-glyph ${r.type}">${svg(r.type)}</span>${badge(TYPE_LABEL[r.type] || r.type)}${status(r)}${originBadge(r)}</div><h2>${esc(r.displayName||r.name)}</h2><p class="cp-description">${esc(r.summary || '尚无用途说明')}</p><p class="cp-caption">${esc(r.summarySource||'')}</p>
      ${tab!=='runtime'?`<div class="cp-origin-detail"><strong>${esc(r.origin?.label||'来源待确认')}</strong><p>${esc(r.origin?.evidence||'未提供来源信息')}</p>${noteForm(r)}</div><details class="cp-original"><summary>原始名称与说明</summary><code>${esc(r.name)}</code><p>${esc(r.description||'原条目未提供说明')}</p></details>${r.type==='mcp'?`<div class="cp-sharing-hint"><h4>${esc(mcpSharing(r).title)}</h4><p>${esc(mcpSharing(r).text)}</p><small>此处为共享建议，未向其他 AI 写入连接配置。</small></div>`:''}`:''}
      ${accountInfo}${r.conflict?'<div class="cp-notice warn">同名入口的正文不同。可能是专用适配，请核对后再统一。</div>':''}
      ${tab!=='runtime'?`<h4>AI 覆盖</h4><div class="cp-chips">${r.agents.map(a=>{const c=coverage(r,a);return badge(label(a)+' · '+c.label,c.tone);}).join('')}</div><p class="cp-fine">按本地目录和配置发现；不代表正在运行的会话已加载。</p>${connections(r)}<details class="cp-sources"><summary>来源与配置 · ${sources.length} 处</summary>${sources.map(s=>`<div class="cp-source"><div><strong>${esc(label(s.agent))}</strong>${badge(s.enabled===false?'已禁用':s.missing?'未找到安装记录':'已登记',s.missing?'warn':'')}</div><small>${esc(s.scope==='shared'?'公共技能目录':s.scope==='user'?'用户目录':s.scope==='system'?'系统技能':s.scope==='plugin'?'插件提供':s.scope)}</small><code>${esc(s.path)}</code>${s.realPath&&s.realPath!==s.path?`<small>指向</small><code>${esc(s.realPath)}</code>`:''}${s.version?`<small>版本 ${esc(s.version)}</small>`:''}${s.transport?`<small>连接方式 ${esc(s.transport)}</small>`:''}</div>`).join('')}</details><div class="cp-next"><h4>如何使用</h4><p>${r.type==='skill'?'在支持此入口的 AI 中描述任务，或明确点名技能。技能正文通常按需读取。':r.type==='mcp'?'在对应客户端完成连接和授权，再到“当前会话”核对连接状态。':'在对应客户端的插件管理中启用；安装与授权分别生效。'}</p>${r.type==='mcp'?button('查看账号与权限','data-cp-action="accounts"'):''}</div>`:`<div class="cp-notice">${esc(runtime?.note || '当前原生连接报告的能力。')}</div><h4>确认时间</h4><p>${esc(new Date(runtime?.observedAt || Date.now()).toLocaleString())}</p>`}`;
  }
  function render(){
    if(!page)return;
    const visible=rows(),all=catalog?.rows || [],active=visible.find(r=>r.id===selected) || visible[0];
    if(active)selected=active.id;
    const counts=t=>(tab==='runtime'?(runtime?.rows || []):all.filter(isActive)).filter(r=>r.type===t).length;
    const inactive=t=>tab==='runtime'?0:all.filter(r=>r.type===t&&!isActive(r)).length;
    const oldScroll=page.querySelector('.cp-scroll')?.scrollTop || 0;
    const oldMatrixScroll=page.querySelector('.cp-matrix-wrap')?.scrollLeft || 0;
    const filtersOpen=page.querySelector('.cp-filter-disclosure')?.open || false;
    page.innerHTML=`<header class="cp-header"><div><div class="cp-eyebrow">AI HUB / CAPABILITIES</div><h1>技能与工具 <span>找到能力，看清每个 AI 的准备情况</span></h1></div><div class="cp-actions">${button('补齐共享技能','data-cp-action="share-preview" '+(shareBusy?'disabled':''))}${button(busy?'读取中…':'刷新','data-cp-action="refresh" '+(busy?'disabled':''))}${button('返回','data-cp-action="close"')}</div></header>
      <div class="cp-scroll"><div class="cp-summary"><div class="cp-summary-intro"><span class="cp-summary-symbol">${svg('plugin')}</span><div><strong>能力中心</strong><p>公共资源，各有专长。<br>从安装来源到会话回执，都有据可查。</p></div></div>${[['skill',counts('skill'),'工作流与专业知识'],['mcp',counts('mcp'),'连接工具与外部服务'],['plugin',counts('plugin'),'成套扩展与集成']].map(([t,n,sub])=>`<button type="button" class="cp-stat" data-cp-type="${t}"><span>${svg(t)}${TYPE_LABEL[t]}</span><strong>${n}</strong><small>${inactive(t)?`${sub} · 另有 ${inactive(t)} 项已停用`:sub}</small></button>`).join('')}</div>
      <nav class="cp-tabs" aria-label="能力视图">${[['catalog','能力库'],['coverage','AI 覆盖对比'],['runtime','当前会话']].map(([id,name])=>button(name,`data-cp-tab="${id}" aria-pressed="${tab===id}"`,tab===id?'selected':'')).join('')}<span>${catalog?`扫描于 ${esc(new Date(catalog.generatedAt).toLocaleTimeString())}`:'尚未扫描'}</span></nav>
      ${sharingView()}${notice?`<div class="cp-notice" role="status">${esc(notice)}</div>`:''}
      <div class="cp-types" aria-label="能力类型">${[['all','全部'],...Object.entries(TYPE_LABEL).filter(([k])=>tab==='runtime'||['skill','mcp','plugin'].includes(k))].map(([id,name])=>button(`${id==='all'?'':svg(id)}${esc(name)}`,`data-cp-type="${id}" aria-pressed="${type===id}"`,type===id?'selected':'')).join('')}</div>
      ${tab==='catalog'?`<div class="cp-agents" aria-label="按 AI 筛选">${[['all','全部 AI'],...ALL_AI_KINDS.map(a=>[a,label(a)])].map(([id,name])=>button(`<span class="cp-agent-dot ${id}">${id==='all'?'◈':esc(name.slice(0,1))}</span>${esc(name)}<small>${all.filter(r=>inScope(r)&&(id==='all'||r.agents.includes(id))).length}</small>`,`data-cp-agent="${id}" aria-pressed="${agent===id}"`,agent===id?'selected':'')).join('')}</div>`:
      tab==='runtime'?`<div class="cp-session"><label for="cp-session">查看会话</label><select id="cp-session"><option value="">选择一个已打开的会话</option>${(catalog?.sessions || []).map(s=>`<option value="${esc(s.id)}" ${sessionId===s.id?'selected':''}>${esc(label(s.kind)+' · '+s.title)}</option>`).join('')}</select><span>MCP 档位 <b>${esc(runtime?.profile || '未确认')}</b></span></div>`:''}
      <div class="cp-toolbar"><label class="cp-search"><span aria-hidden="true">⌕</span><input id="cp-search" type="search" placeholder="搜索名称或功能…" aria-label="搜索能力" value="${esc(query)}"></label>${tab!=='runtime'?`<select id="cp-scope" aria-label="范围">${[['active','已启用'],['all','全部（含停用）'],['shared','公共技能'],['conflict','同名差异'],['disabled','禁用 / 待核对']].map(([k,v])=>`<option value="${k}" ${scope===k?'selected':''}>${v}</option>`).join('')}</select>`:''}<span>${visible.length} 项</span></div>
      ${tab!=='runtime'?`<nav class="cp-origins" aria-label="按创建来源筛选">${[['all','全部来源'],...Object.entries(ORIGINS)].map(([id,name])=>button(esc(name),`data-cp-origin="${id}" aria-pressed="${origin===id}"`,origin===id?'selected':'')).join('')}<span>自建与外部导入按来源区分，和是否共享无关</span></nav>`:''}
      ${error?`<div class="cp-notice warn" role="alert">${esc(error)}</div>`:''}${busy?'<div class="cp-progress" role="status">正在读取能力信息…</div>':''}
      ${tab==='runtime' && (!sessionId||runtime?.unknown)?`<div class="cp-notice">${esc(runtime?.unknown || '选择已打开的会话查看确认回执。此操作不会创建会话或启动 AI。')}</div>`:''}
      ${tab==='runtime'&&runtime?.note?`<p class="cp-runtime-note">${esc(runtime.note)}</p>`:''}
      ${(tab==='runtime'?runtime?.warnings:catalog?.warnings)?.length?`<details class="cp-warnings"><summary>部分信息未能读取 · ${(tab==='runtime'?runtime.warnings:catalog.warnings).length} 项</summary>${(tab==='runtime'?runtime.warnings:catalog.warnings).map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}
      ${tab==='coverage'?matrix(visible):''}<div class="cp-content ${tab==='coverage'?'cp-coverage-detail':''}">${tab==='coverage'?'':`<div class="cp-list" aria-label="能力列表">${visible.length?visible.map(r=>`<button type="button" class="cp-row ${r.id===active?.id?'selected':''}" data-cp-row="${esc(r.id)}" aria-pressed="${r.id===active?.id}"><span class="cp-glyph ${r.type}">${svg(r.type)}</span><span class="cp-row-copy"><span class="cp-row-title"><strong>${esc(r.displayName||r.name)}</strong>${originBadge(r)}</span><small class="cp-row-summary">${esc(r.summary || '尚无用途说明')}</small></span><span class="cp-row-meta">${status(r)}${r.conflict?badge('同名差异','warn'):''}<small>${tab==='runtime'?esc(TYPE_LABEL[r.type]):r.agents.map(a=>esc(label(a))).join(' · ')}</small></span></button>`).join(''):`<div class="cp-empty">${svg('skill')}<h3>${busy?'正在发现能力':'这里还没有匹配的能力'}</h3><p>${query?'试试更短的关键词，或切换筛选条件。':tab==='runtime'?'本地登记请在能力库查看；本类会话状态可能未报告。':'此客户端暂未发现对应入口；加载状态仍以会话回执为准。'}</p></div>`}</div>`}<aside class="cp-detail" aria-label="能力详情">${detail(active)}</aside></div>
      <details class="cp-help"><summary>技能、连接和插件有什么区别？</summary><p>技能是完成任务的方法和辅助文件；MCP 是 AI 调用工具和服务的连接；插件把相关技能和连接打包在一起。</p><p>能力库展示本机配置，AI 覆盖对比展示入口差异，当前会话展示原生客户端的回执。App 账号技能、云端连接器与本机 CLI 配置不一定同步。安装、启用、连接成功和实际使用是不同状态。</p></details><footer class="cp-footer">本机目录与已打开项目的配置 · 不包含完整云端市场 · 已登记不等于当前会话可用</footer></div>`;
    const advanced=[page.querySelector('.cp-agents'),page.querySelector('.cp-origins')].filter(Boolean);
    if(advanced.length){
      const filters=document.createElement('details');filters.className='cp-filter-disclosure';filters.open=filtersOpen;
      const summary=document.createElement('summary');
      summary.textContent=`筛选 · ${agent==='all'?'全部 AI':label(agent)} · ${origin==='all'?'全部来源':ORIGINS[origin] || origin}`;
      filters.append(summary,...advanced);page.querySelector('.cp-toolbar').after(filters);
    }
    page.querySelector('.cp-scroll').scrollTop=oldScroll;
    if(page.querySelector('.cp-matrix-wrap'))page.querySelector('.cp-matrix-wrap').scrollLeft=oldMatrixScroll;
    position();
  }
  async function refresh(force=false){
    const ticket=++epoch;busy=true;error='';if(tab==='runtime')runtime=null;render();
    try {
      const response=await ipcRenderer.invoke('capabilities:catalog',{refresh:force});
      if(ticket!==epoch||page.hidden)return;
      if(!response?.ok)throw Error(response?.error || '能力目录读取失败');
      catalog=response.data;
      if(tab==='runtime'&&sessionId){
        const r=await ipcRenderer.invoke('capabilities:runtime',{sessionId});
        if(ticket!==epoch||page.hidden)return;
        if(!r?.ok)throw Error(r?.error || '会话能力读取失败');
        runtime=r.data;
      }
    }catch(e){if(ticket===epoch){error=e.message;runtime=null;}}
    finally {if(ticket===epoch&&!page.hidden){busy=false;render();}}
  }
  async function saveNote(){
    if(!noteEdit||noteBusy)return;
    const input={...noteEdit};noteBusy=true;error='';render();
    try{
      const response=await ipcRenderer.invoke('capabilities:update-note',input);
      if(!response?.ok)throw Error(response?.error||'展示信息保存失败');
      noteEdit=null;notice='简述与来源已保存；原生配置保持不变。';
      if(!page.hidden)await refresh(true);
    }catch(e){error=e.message;}
    finally{noteBusy=false;if(!page.hidden)render();}
  }
  async function share(action){
    if(shareBusy)return;
    shareBusy=true;error='';notice='';render();
    try{
      const r=await ipcRenderer.invoke('capabilities:'+action,action==='share-skills'?{token:sharing?.token}:{});
      if(!r?.ok)throw Error(r?.error || '共享技能操作失败');
      if(action==='sharing-plan')sharing=r.data;
      else {
        sharing=null;
        notice=`已新增 ${r.data.created} 个共享入口。已有入口保持原样，请在新会话核对。记录：${r.data.manifest}`;
        if(r.data.errors.length)notice+=' 部分未完成：'+r.data.errors.map(e=>e.name+'：'+e.error).join('；');
        if(!page.hidden)await refresh(true);
      }
    }catch(e){error=e.message;sharing=null;}
    finally{shareBusy=false;if(!page.hidden)render();}
  }
  function close(){if(!page)return;page.hidden=true;epoch++;busy=false;document.body.classList.remove('capabilities-open');document.getElementById('btn-rail-capabilities')?.setAttribute('aria-expanded','false');window.hubWorkspaces?.panelClosed('capabilities');}
  async function open(options = {}){
    if (options.tab === 'runtime' || options.tab === 'catalog' || options.tab === 'coverage') {
      tab = options.tab; runtime = null; sessionId = getActiveSessionId() || ''; selected = '';
    } else if (tab === 'runtime') { tab = 'catalog'; runtime = null; }
    if(!page){
      page=document.createElement('section');page.id='capability-page';page.className='cp-page';page.setAttribute('aria-label','技能与工具');document.body.appendChild(page);
      page.addEventListener('click',e=>{
        const b=e.target.closest('button');if(!b)return;
        if(b.dataset.cpAction==='close'){close();document.getElementById('btn-rail-capabilities')?.focus();return;}
        if(b.dataset.cpAction==='refresh'){runtime=null;void refresh(true);return;}
        if(b.dataset.cpAction==='share-preview'){void share('sharing-plan');return;}
        if(b.dataset.cpAction==='share-apply'){void share('share-skills');return;}
        if(b.dataset.cpAction==='share-close'){sharing=null;render();return;}
        if(b.dataset.cpAction==='accounts'){close();document.getElementById('btn-rail-accounts')?.click();return;}
        if(b.dataset.cpRelated){tab='catalog';type='all';agent='all';scope='all';origin='all';noteEdit=null;query='';selected=b.dataset.cpRelated;render();return;}
        if(b.dataset.cpTab){tab=b.dataset.cpTab;origin='all';noteEdit=null;type='all';query='';scope='active';selected='';runtime=null;sessionId=getActiveSessionId() || catalog?.sessions[0]?.id || '';void refresh();return;}
        if(b.dataset.cpAction==='note-edit'){const r=rows().find(r=>r.id===selected);if(r)noteEdit={id:r.id,summary:r.note?.summary||'',origin:r.note?.origin||'auto'};render();return;}
        if(b.dataset.cpAction==='note-cancel'){noteEdit=null;render();return;}
        if(b.dataset.cpOrigin){origin=b.dataset.cpOrigin;selected='';noteEdit=null;render();return;}
        if(b.dataset.cpAgent){agent=b.dataset.cpAgent;selected='';render();return;}
        if(b.dataset.cpType){type=b.dataset.cpType;selected='';render();return;}
        if(b.dataset.cpRow){noteEdit=null;selected=b.dataset.cpRow;const scroll=page.querySelector('.cp-scroll').scrollTop;render();page.querySelector('.cp-scroll').scrollTop=scroll;page.querySelector(`[data-cp-row="${CSS.escape(selected)}"]`)?.focus({preventScroll:true});}
      });
      page.addEventListener('submit',e=>{if(e.target.id==='cp-note-form'){e.preventDefault();void saveNote();}});
      page.addEventListener('input',e=>{if(e.target.id==='cp-note-summary'&&noteEdit){noteEdit.summary=e.target.value;return;}if(e.target.id==='cp-search'){const pos=e.target.selectionStart;query=e.target.value;render();const input=page.querySelector('#cp-search');input.focus({preventScroll:true});input.setSelectionRange(pos,pos);}});
      page.addEventListener('change',e=>{if(e.target.id==='cp-note-origin'&&noteEdit){noteEdit.origin=e.target.value;return;}if(e.target.id==='cp-type')type=e.target.value;else if(e.target.id==='cp-scope')scope=e.target.value;else if(e.target.id==='cp-session'){sessionId=e.target.value;runtime=null;void refresh();return;}else return;selected='';render();});
    }
    page.hidden=false;document.body.classList.add('capabilities-open');document.getElementById('btn-rail-capabilities')?.setAttribute('aria-expanded','true');
    await refresh();
  }
  document.addEventListener('click',e=>{if(e.target.closest('[data-action="open-capabilities"]')){if(page&&!page.hidden)close();else void open();}else if(e.target.closest('#scene-rail button')&&page&&!page.hidden)close();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&page&&!page.hidden){close();document.getElementById('btn-rail-capabilities')?.focus();}});
  window.addEventListener('resize',position);
  ipcRenderer.on('session-closed',(_event,event)=>{if(page&&!page.hidden&&event?.sessionId===sessionId){runtime=null;epoch++;busy=false;error='会话已关闭，原生加载回执已失效。';render();}});
  ipcRenderer.on('session-updated',(_event,{session}={})=>{
    if(!page||page.hidden||!runtime||session?.id!==sessionId)return;
    const state=session.nativeRuntime;
    if(state&&(state.epoch!==runtime.epoch||state.connection!=='connected')){
      runtime=null;epoch++;busy=false;error='会话连接已变化，请刷新以读取当前回执。';render();
    }
  });
  return {open,close};
}
module.exports={createCapabilityPanel};
