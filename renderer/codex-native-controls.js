'use strict';

const { BACKEND } = require('../core/codex-native-runtime.js');
const { isNativeNoticeDismissed, dismissNativeNotice } = require('./native-notice-dismissal');

// Each form is bound to one server request and transport epoch. A state repaint
// never replaces typed answers, and a second click cannot reply twice.
function createCodexNativeControls({ sessionId, invoke, document: doc = document, openExternal }) {
  const element = doc.createElement('section');
  element.className = 'codex-native-controls';
  element.hidden = true;
  element.setAttribute('aria-label', '原生会话操作');
  let signature = '';
  const forms = new Map();
  const queueForms = new Map();
  const node = (tag, text, className) => {
    const el = doc.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const action = async (payload, form, error) => {
    const buttons = [...form.querySelectorAll('button,select')];
    buttons.forEach(b => { b.disabled = true; });
    error.textContent = '';
    try {
      const result = await invoke('codex:native-action', { sessionId, ...payload });
      if (!result || !result.ok) throw new Error(result && result.message || '原生会话未确认操作');
      if (payload.action === 'reply') error.textContent = '回答已送达，等待原生会话确认';
      else buttons.forEach(b => { b.disabled = false; });
    } catch (err) {
      error.textContent = err.message;
      buttons.forEach(b => { b.disabled = false; });
    }
  };
  function renderRequest(request, epoch) {
    const form = node('form', null, 'codex-native-request');
    form.dataset.requestId = String(request.id);
    form.dataset.epoch = String(epoch);
    const p = request.params || {};
    const error = node('div', '', 'codex-native-error');
    error.setAttribute('role', 'status');
    const controls = node('div', null, 'codex-native-actions');
    const reply = result => action({ action:'reply', requestId:request.id, epoch, result }, form, error);
    const button = (label, run) => {
      const b = node('button', label);
      b.type = 'button';
      b.addEventListener('click', run);
      controls.append(b);
    };
    if (request.method === 'session/request_permission' && p.toolCall?._meta?.qwenInteractionKind==='user_question') {
      form.append(node('strong','千问需要你的回答'));
      const fields=[];
      for(const [index,q] of (p.toolCall._meta.qwenQuestions || []).entries()) {
        const label=node('label',q.question || q.header);const input=node('textarea');
        input.required=true;input.setAttribute('aria-label',q.question || q.header);label.append(input);form.append(label);
        for(const option of q.options || []) {const choose=node('button',option.label);choose.type='button';choose.title=option.description || '';
          choose.addEventListener('click',()=>{input.value=q.multiSelect && input.value ? input.value+', '+option.label:option.label;input.focus();});form.append(choose);}
        fields.push([String(index),input]);
      }
      form.addEventListener('submit',event=>{event.preventDefault();if(!form.reportValidity())return;
        const option=p.options.find(o=>o.kind==='allow_once');if(!option){error.textContent='原生提问缺少提交选项';return;}
        reply({outcome:{outcome:'selected',optionId:option.optionId},answers:Object.fromEntries(fields.map(([key,input])=>[key,input.value]))});
      });
      const submit=node('button','提交回答');submit.type='submit';controls.append(submit);button('取消',()=>reply({outcome:{outcome:'cancelled'}}));
    } else if (request.method === 'session/request_permission') {
      form.append(node('strong','原生 Harness 请求授权'),node('p',p.toolCall?.title || p.reason || ''));
      if (p.toolCall?.rawInput) form.append(node('pre',JSON.stringify(p.toolCall.rawInput,null,2)));
      for (const option of p.options || []) button(option.name || option.optionId,
        () => reply({outcome:{outcome:'selected',optionId:option.optionId}}));
      button('取消', () => reply({outcome:{outcome:'cancelled'}}));
    } else if (request.method === 'elicitation/create') {
      form.append(node('strong','需要你的回答'),node('p',p.message || ''));
      const schema = p.requestedSchema || {};
      const fields = [];
      for (const [name, spec] of Object.entries(schema.properties || {})) {
        const label = node('label',spec.title || name);
        if (spec.description) label.append(node('p',spec.description));
        const choices = spec.oneOf || spec.enum?.map((v,i)=>({const:v,title:spec.enumNames?.[i] || String(v)}))
          || spec.items?.anyOf || spec.items?.enum?.map(v=>({const:v,title:String(v)}));
        let input;
        if (choices) {
          input = node('select'); input.multiple = spec.type === 'array';
          if (!input.multiple) { const blank=node('option','请选择'); blank.value=''; input.append(blank); }
          for (const choice of choices) { const option=node('option',choice.title || String(choice.const)); option.value=JSON.stringify(choice.const); input.append(option); }
        } else {
          input = node(spec.type === 'string' ? 'textarea' : 'input');
          if (spec.type === 'boolean') input.type='checkbox';
          if (['number','integer'].includes(spec.type)) {input.type='number';input.step=spec.type==='integer'?'1':'any';}
        }
        input.name=name; input.setAttribute('aria-label',spec.title || name);
        input.required=(schema.required || []).includes(name) && spec.type!=='boolean';
        label.append(input); form.append(label); fields.push({name,spec,input,choices});
      }
      form.addEventListener('submit',event=>{
        event.preventDefault(); if(!form.reportValidity())return;
        try {
          const content={};
          for(const {name,spec,input,choices} of fields) {
            if(spec.type==='boolean') content[name]=input.checked;
            else if(choices && spec.type==='array')content[name]=[...input.selectedOptions].map(o=>JSON.parse(o.value));
            else if(input.value!=='')content[name]=choices?JSON.parse(input.value):['integer','number'].includes(spec.type)?Number(input.value):input.value;
          }
          const result=require('../core/acp-elicitation').validateElicitation({action:'accept',content},schema);
          reply(result);
        }catch(err){error.textContent=err.message;}
      });
      const submit=node('button','提交回答'); submit.type='submit';controls.append(submit);
      button('跳过',()=>reply({action:'decline'}));button('取消',()=>reply({action:'cancel'}));
    } else if (request.method === 'item/tool/requestUserInput') {
      form.append(node('strong', p.isBlocking === false ? 'Codex 有一个问题，可在执行期间回答' : 'Codex 需要你的回答'));
      const fields = [];
      for (const q of p.questions || []) {
        const label = node('label', q.question || q.header || q.id);
        const input = node(q.isSecret ? 'input' : 'textarea');
        if (q.isSecret) input.type = 'password';
        input.name = q.id;
        input.setAttribute('aria-label', q.question || q.id);
        input.required = true;
        input.rows = 2;
        label.append(input);
        form.append(label);
        for (const option of q.options || []) {
          const choose = node('button', option.label);
          choose.type = 'button';
          choose.title = option.description || '';
          choose.addEventListener('click', () => { input.value = option.label; input.focus(); });
          form.append(choose);
        }
        fields.push([q.id,input]);
      }
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        reply({ answers:Object.fromEntries(fields.map(([id,input])=>[id,{answers:[input.value]}])) });
      });
      const send = node('button','提交回答');
      send.type = 'submit';
      controls.append(send);
    } else if (request.method === 'mcpServer/elicitation/request') {
      form.append(node('strong', 'MCP 需要确认'), node('p', p.message || ''));
      if (p.url && /^https?:\/\//i.test(p.url)) {
        button('打开验证页面', () => openExternal && openExternal(p.url));
      }
      let input;
      if (p.requestedSchema) {
        const details = node('details');
        details.append(node('summary','查看所需字段'),node('pre',JSON.stringify(p.requestedSchema,null,2)));
        input = node('textarea');
        input.setAttribute('aria-label','MCP 回答 JSON');
        input.placeholder = '按所需字段填写 JSON 对象';
        input.rows = 4;
        form.append(details,input);
      }
      button('确认', () => {
        let content = null;
        try {
          if (input) {
            content = JSON.parse(input.value);
            if (!content || Array.isArray(content) || typeof content !== 'object') throw new Error('请填写 JSON 对象');
          }
          reply({action:'accept',content});
        } catch(err) { error.textContent = err.message; }
      });
      button('拒绝', () => reply({action:'decline',content:null}));
      button('取消', () => reply({action:'cancel',content:null}));
    } else {
      form.append(node('strong', 'Codex 请求授权'));
      form.append(node('p', p.reason || '请查看具体操作后决定'));
      const operation = p.operation || {};
      const command = p.command || operation.command;
      if (command) form.append(node('pre', Array.isArray(command) ? command.join(' ') : command));
      if (p.cwd || operation.cwd) form.append(node('p', '工作目录：' + (p.cwd || operation.cwd)));
      for (const change of operation.changes || []) {
        form.append(node('strong', change.path), node('pre', change.diff || '文件内容未随请求提供'));
      }
      if (request.method === 'item/permissions/requestApproval') {
        form.append(node('pre', JSON.stringify(p.permissions || {}, null, 2)));
        form.append(node('p', '授权仅用于当前轮次。'));
      }
      const details = node('details');
      details.append(node('summary','查看完整请求'),node('pre',JSON.stringify(p,null,2)));
      form.append(details);
      button('允许本次', () => reply({decision:'accept'}));
      button('拒绝', () => reply({decision:'decline'}));
    }
    form.append(controls,error);
    return form;
  }
  function update(session) {
    if (!session || ![BACKEND,'acp'].includes(session.runtimeBackend)) {
      element.hidden = true;
      return;
    }
    const runtime = session.nativeRuntime;
    const cancelling = runtime?.cancellation?.status === 'pending';
    const requests = runtime && runtime.connection === 'connected' && !cancelling ? runtime.requests || [] : [];
    const choices = session.nativeThreadChoices || [];
    const next = JSON.stringify([
      runtime && runtime.epoch,
      runtime?.turnId,
      requests,
      choices,
      session.acpConfigOptions,
      session.nativeActionError,
      runtime?.configurationError,
      runtime?.submission?.status,
      runtime?.state,
      runtime?.connection,
      runtime?.collaborationMode,
      runtime?.cancellation,
      runtime?.emptyRecovery,
      runtime?.queued,
    ]);
    if (signature === next) return;
    signature = next;
    // Reuse the actual form nodes. Resolving another request must preserve
    // focus, secret answers, draft text and a reply already in flight.
    const keep = new Set(requests.map(r => JSON.stringify([runtime.epoch,r.id])));
    for (const key of forms.keys()) if (!keep.has(key)) forms.delete(key);
    const children = [];
    const queued=runtime?.queued || [];
    const queueKeys=new Set();
    for(const entry of queued) {
      const key=JSON.stringify([runtime.epoch,entry.id,entry.status,entry.reason,runtime.connection,runtime.submission?.status]);
      queueKeys.add(key);
      if(!queueForms.has(key)) {
        const box=node('div',null,'codex-native-request acp-queued-prompt');box.dataset.submissionId=entry.id;
        const error=node('div','','codex-native-error');
        box.append(node('strong',entry.status==='held'?'消息已保留，尚未发送':'已排队 · 当前轮结束后发送'),node('p',entry.reason || entry.preview,'acp-queued-preview'));
        const details=node('details'),summary=node('summary','查看待发送全文'),full=node('pre');details.append(summary,full);box.append(details);
        details.addEventListener('toggle',async()=>{
          if(!details.open || full.textContent)return;
          try{const result=await invoke('acp:queue',{sessionId,id:entry.id,epoch:runtime.epoch,action:'read'});full.textContent=result.text;}
          catch(err){error.textContent=err.message;}
        });
        const run=async action=>{
          const buttons=[...box.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
          try{await invoke('acp:queue',{sessionId,id:entry.id,epoch:runtime.epoch,action});}
          catch(err){error.textContent=err.message;buttons.forEach(b=>b.disabled=false);}
        };
        if(entry.status==='held') {
          const resume=node('button','确认发送');resume.type='button';resume.dataset.queueAction='resume';
          resume.disabled=runtime.connection!=='connected' || runtime.submission?.status==='unknown';
          resume.addEventListener('click',()=>run('resume'));box.append(resume);
        }
        const remove=node('button','移除');remove.type='button';remove.dataset.queueAction='remove';remove.addEventListener('click',()=>run('remove'));
        box.append(remove,error);queueForms.set(key,box);
      }
      children.push(queueForms.get(key));
    }
    for(const key of queueForms.keys())if(!queueKeys.has(key))queueForms.delete(key);
    if (runtime?.collaborationMode === 'plan') {
      const modeBox = node('div', null, 'codex-native-mode');
      modeBox.append(node('span', '计划模式 · 讨论与只读调查；后续消息沿用此模式。'));
      const error = node('div', '', 'codex-native-error');
      const reset = node('button', '切回默认模式'); reset.type = 'button';
      reset.disabled = runtime.connection !== 'connected' || !['idle', 'completed', 'failed', 'interrupted'].includes(runtime.state);
      reset.addEventListener('click', () => action({action:'collaboration-mode',mode:'default',epoch:runtime.epoch}, modeBox, error));
      modeBox.append(reset, error); children.push(modeBox);
    }
    if (cancelling) children.push(node('p','正在停止，等待原生 Harness 确认','acp-cancelling'));
    if (runtime?.connection === 'unstarted') children.push(node('p','尚未开始，收到消息后启动。'));
    if (runtime?.emptyRecovery) {
      const box=node('div',null,'codex-native-request'), error=node('div','','codex-native-error');
      box.append(node('p','旧线程没有可恢复记录，且旧版本没有提交凭证。仅在确认这个席位从未执行任务时，才建立新线程；不会自动重发任务。'));
      const confirm=node('input');confirm.type='checkbox';
      const label=node('label','我确认这个席位从未执行过任务','codex-native-confirm');label.prepend(confirm);box.append(label);
      const restart=node('button','为原席位建立新线程');restart.type='button';restart.disabled=true;
      confirm.addEventListener('change',()=>{restart.disabled=!confirm.checked;});
      restart.addEventListener('click',()=>action({action:'restart-empty',...runtime.emptyRecovery,confirmed:true},box,error));
      box.append(restart,error);children.push(box);
    }
    if(runtime?.configurationError)children.push(node('p',runtime.configurationError,'codex-native-error'));
    if (session.nativeActionError && !isNativeNoticeDismissed(session, session.nativeActionError) && !((runtime?.state === 'unknown' || runtime?.connection === 'disconnected')
        && [runtime?.reason,runtime?.submission?.error].includes(session.nativeActionError))) {
      const row = node('div', null, 'native-dismissible-notice');
      const dismiss = node('button', '忽略本次', 'native-notice-dismiss'); dismiss.type = 'button';
      dismiss.title = '隐藏本次提示，保留实际状态；不会重发消息';
      dismiss.addEventListener('click', () => {
        dismissNativeNotice(session, session.nativeActionError);
        signature = ''; update(session);
      });
      row.append(node('p', session.nativeActionError, 'codex-native-error'), dismiss);
      children.push(row);
    }
    if (choices.length) {
      children.push(node('strong','选择要恢复的 Codex 会话'));
      const list = node('div',null,'codex-native-thread-list');
      const error = node('div','','codex-native-error');
      for (const thread of choices) {
        const b = node('button',(thread.name || thread.preview || thread.id) + ' · ' + (thread.cwd || ''));
        b.type = 'button';
        b.dataset.threadId = thread.id;
        b.addEventListener('click',()=>action({action:'choose-thread',threadId:thread.id},list,error));
        list.append(b);
      }
      children.push(list,error);
    }
    for (const request of requests) {
      const key = JSON.stringify([runtime.epoch,request.id]);
      if (!forms.has(key)) forms.set(key,renderRequest(request,runtime.epoch));
      children.push(forms.get(key));
    }
    const focused = doc.activeElement;
    // insertBefore keeps existing nodes attached, unlike replaceChildren.
    children.forEach((child,index) => {
      if (element.children[index] !== child) element.insertBefore(child,element.children[index] || null);
    });
    while (element.children.length > children.length) element.lastElementChild.remove();
    if (focused && element.contains(focused) && doc.activeElement !== focused) focused.focus();
    element.hidden = element.childElementCount === 0;
  }
  return { element, update };
}
module.exports = { createCodexNativeControls };
