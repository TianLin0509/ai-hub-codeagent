'use strict';
(function () {
const S = require('../core/workflow-settings');
const D = require('../core/delivery-workflow');
let modal, state, members, onSave, original, dirty, saving, focusBefore, sourceConfig, context;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const name = id => members.find(m => m.memberId === id)?.title || id;
function message(text) { modal.querySelector('#wf-error').textContent = text; }
function ensure() {
  if (modal) return;
  modal = document.createElement('div'); modal.id = 'workflow-config-modal'; modal.className = 'mcm-overlay'; modal.style.display = 'none';
  modal.innerHTML = `<section class="mcm-dialog wf-dialog" role="dialog" aria-modal="true" aria-labelledby="wf-title-text"><header class="wf-header"><div class="wf-mark" aria-hidden="true">≋</div><div><h2 id="wf-title-text">工作流设置</h2><p id="wf-description"></p></div><button class="mcm-close" aria-label="关闭工作流设置">×</button></header><div id="wf-body"></div><footer class="wf-footer"><div><p id="wf-usage"></p><p id="wf-error" role="status" aria-live="polite"></p></div><div class="wf-actions"><button data-wf="restore">恢复原设置</button><button data-wf="preview">预演轮次</button><button class="wf-save">保存设置</button></div></footer></section>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', async e => {
    if (saving) return;
    if (e.target.closest('.mcm-close')) return close();
    if (e.target.closest('.wf-save')) return save();
    const b = e.target.closest('[data-wf]'); if (!b || b.disabled) return;
    const action = b.dataset.wf, i = Number(b.dataset.step);
    if (action === 'task-preset') {
      if (dirty && !await require('./ui-feedback').confirmHubAction('替换当前未保存的轮次与 prompt？')) return;
      try { state = S.createPreset(b.dataset.taskPreset, members); dirty = true; render(); } catch (err) { message(err.message); }
    } else if (action === 'chip') {
      const r = state.rounds[i], id = b.dataset.member, at = r.members.indexOf(id);
      if (at >= 0 && r.members.length === 1) return message('每轮至少保留 1 位 Agent');
      if (at < 0 && r.members.length >= 3) return message('每轮最多 3 位 Agent');
      if (state.kind === 'file') {
        if (at === 0) return message('首位是文件交付负责人，保留其绑定；可以调整协作成员');
        if (id === state.rounds[i === 2 ? 0 : 2].members[0]) return message('实现与独立评审负责人不能参加对方阶段');
      }
      if (at >= 0) r.members.splice(at, 1); else r.members.push(id);
      dirty = true; render(); message('成员已更新，请检查共享 prompt 中的分工');
    } else if (action === 'add' && state.kind !== 'file' && state.rounds.length < 6) {
      state.rounds.push({ name:`第 ${state.rounds.length + 1} 轮`, members:[members[0].memberId], prompt:'', after:'end' });
      state.rounds[state.rounds.length - 2].after = 'next'; dirty = true; render();
      modal.querySelector('.wf-scroll').scrollTop = modal.querySelector('.wf-scroll').scrollHeight;
    } else if (action === 'remove' && state.kind !== 'file' && state.rounds.length > 1) {
      state.rounds.splice(i, 1); dirty = true; render();
    } else if (action === 'move' && state.kind !== 'file') {
      const j = i + Number(b.dataset.delta); if (j < 0 || j >= state.rounds.length) return;
      [state.rounds[i],state.rounds[j]] = [state.rounds[j],state.rounds[i]]; dirty = true; render();
    } else if (action === 'restore') { state = structuredClone(original); dirty = false; render(); }
    else if (action === 'protocol') { const box = modal.querySelector('#wf-protocol'); box.hidden = !box.hidden; if(!box.hidden) { try {box.textContent=protocol();} catch(err){box.textContent=err.message;} } }
    else if (action === 'preview') preview();
  });
  modal.addEventListener('input', e => {
    const i = Number(e.target.dataset.wfStepName ?? e.target.dataset.wfStepPrompt);
    if (e.target.matches('[data-wf-step-name]')) state.rounds[i].name = e.target.value;
    else if (e.target.matches('[data-wf-step-prompt]')) state.rounds[i].prompt = e.target.value;
    else return;
    dirty = true; modal.querySelector('#wf-dirty').textContent = '已修改';
  });
  modal.addEventListener('change', e => { if (e.target.matches('[data-after]')) { state.rounds[Number(e.target.dataset.after)].after = e.target.value; dirty = true; } });
  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key !== 'Tab') return;
    const nodes = [...modal.querySelectorAll('button:not(:disabled),input,textarea,select')].filter(n => n.getClientRects().length);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
function protocol() {
  return (S.usesDelivery(state) ? D.protocol() : '每条新输入按保存的顺序回答；同轮全部成员回答结束后，下一轮读取群内已有发言。不要求任务书、交付校验或审查裁决。') + '\n\n' + state.rounds.map((r,i)=>`${i+1}. ${r.name}\n${r.members.map(name).join(' / ')}\n${r.prompt}`).join('\n\n');
}
function render() {
  const file = state.kind === 'file', delivery = S.usesDelivery(state);
  modal.querySelector('#wf-description').textContent = delivery ? '按阶段安排成员与职责，交付结果后接续，审查需返工时继续迭代。' : '按你设定的顺序轮流发言；每条新输入都从第一轮开始。';
  modal.querySelector('#wf-usage').textContent = delivery ? '保存后下一条消息按本流程执行；每段最多 3 轮审查，仍需返工时保留现场，等你继续。' : '保存后每条新输入都按此顺序发言；本次说完，下次继续使用同一顺序。';
  modal.querySelector('#wf-body').innerHTML = `<div class="wf-templatebar"><small>从模板开始</small>${[...S.PRESETS,{id:'custom',name:'＋ 自定义',minMembers:1}].map(p=>`<button class="wf-preset${state.presetId===p.id?' selected':''}" data-wf="task-preset" data-task-preset="${p.id}" ${members.length<p.minMembers?'disabled':''}>${p.name}</button>`).join('')}<span class="wf-budget">最多预设 <b>6</b> 轮${delivery?' · 每段最多 3 轮审查':''}</span></div><div class="wf-summary"><span>${state.rounds.length} 个预设轮次 · 每轮 1–3 位 Agent · 同轮每位成员${delivery?'交付':'回答结束'}后接续 <em id="wf-dirty">${dirty?'已修改':''}</em></span><span class="wf-tag">${delivery?'文件交付 · 可恢复':'按顺序发言'}</span></div><div class="wf-scroll"><div class="wf-steps">${state.rounds.map((r,i)=>`<article class="wf-step-row" data-round="${i}"><header class="wf-round-header"><span class="wf-step-index">${String(i+1).padStart(2,'0')}</span><input class="wf-step-name" maxlength="80" aria-label="第 ${i+1} 轮名称" data-wf-step-name="${i}" value="${esc(r.name)}"><div class="wf-round-tools"><button data-wf="move" data-step="${i}" data-delta="-1" aria-label="上移第 ${i+1} 轮" ${file||i===0?'disabled':''}>↑</button><button data-wf="move" data-step="${i}" data-delta="1" aria-label="下移第 ${i+1} 轮" ${file||i===state.rounds.length-1?'disabled':''}>↓</button><button data-wf="remove" data-step="${i}" aria-label="删除第 ${i+1} 轮" ${file||state.rounds.length===1?'disabled':''}>×</button></div></header><div class="wf-member-chips"><small>参与者</small>${members.map(m=>`<button class="wf-member-chip${r.members.includes(m.memberId)?' selected':''}" data-wf="chip" data-step="${i}" data-member="${esc(m.memberId)}" aria-pressed="${r.members.includes(m.memberId)}"><img src="assets/ai-logos/${esc(String(m.kind||'claude').replace(/-resume$/,''))}.svg" alt="">${esc(m.title||m.memberId)}</button>`).join('')}</div><label class="wf-prompt-label" for="wf-prompt-${i}">本轮共享 Prompt（可留空）· ${delivery?'交付要求':'群聊上下文'}自动附加</label><textarea id="wf-prompt-${i}" class="wf-step-prompt" maxlength="16000" rows="4" data-wf-step-prompt="${i}" placeholder="可留空；本次任务和分工可在群聊输入框补充">${esc(r.prompt)}</textarea><div class="wf-round-rule"><span>${r.members.length} 位参与 · 同一份指令 · 每人独立${delivery?'交付':'回答'}${file?' · '+esc(name(r.members[0]))+' 负责阶段结果':''}</span>${file?`<span>${i===2?'完成 → 结束 · 需返工 → 实现':'交付后 → 下一轮'}</span>`:`<label>${delivery?'交付':'回答'}后 <select data-after="${i}" aria-label="第 ${i+1} 轮交付后"><option value="next" ${r.after==='next'?'selected':''}>进入下一轮</option><option value="end" ${r.after==='end'?'selected':''}>结束流程</option>${r.after==='review'?'<option value="review" selected>审核：通过结束 · 需返工退回上一轮</option>':''}</select></label>`}</div></article>`).join('')}</div><button class="wf-add" data-wf="add" ${file||state.rounds.length>=6?'disabled':''}>${file?'开发文件流保留三段接续结构；返工复用实现与评审配置':state.rounds.length>=6?'已达 6 个预设轮次':'＋ 添加一轮'}</button><div class="wf-protocolbar"><span>${delivery?'任务与前序交付随派工附加；超时或聊天结束不会跳到下一轮':'每条新输入按此顺序发言；后面的成员能看到前面的回答'}</span><button data-wf="protocol">${delivery?'查看交付规则':'查看发言规则'}</button></div><pre id="wf-protocol" hidden></pre><div id="wf-preview" hidden></div></div>`;
  message(context?.legacyTaskFiles ? '此群已有旧版交付文件，本次保存保留原协议；新任务请新建群聊使用逐成员交付。' : state.legacyProtocol ? '此群仍使用旧版执行协议；保留原设置继续使用，选择新模板后才会转换。' : '保存即使用这套工作流；下一条消息按新设置执行。');
}
function preview() {
  const box = modal.querySelector('#wf-preview'); box.hidden = false;
  if (state.kind === 'file') box.textContent = '首次通过：开题 1 → 实现 2 → 评审合并 3，完成。\n返工一次：开题 1 → 实现 2 → 评审 3 → 实现 4 → 评审合并 5，完成。\n持续返工：开题 1 → 实现 2 → 评审 3 → 实现 4 → 评审 5 → 实现 6 → 评审 7；第三次审查仍需返工时暂停，点继续后再执行。';
  else { const visible=[]; for (const r of state.rounds) { visible.push(r.name); if(r.after==='end')break; } box.textContent=visible.join(' → ')+' → 结束'; }
  box.scrollIntoView({block:'nearest'});
}
async function save() {
  try {
    state.enabled = true;
    S.validate(state,members.map(m=>m.memberId)); saving = true;
    modal.querySelector('.wf-save').disabled = true;
    if (typeof onSave === 'function') await onSave(S.toWorkflowConfig(sourceConfig,state,members.map(m=>m.memberId)),structuredClone(state));
    dirty=false; saving=false; close();
  } catch (err) { message('保存失败：'+err.message); }
  finally { saving=false; modal.querySelector('.wf-save').disabled=false; }
}
function close() { if(saving)return; modal.style.display='none'; focusBefore?.focus?.(); }
window.openWorkflowConfigModal = ({members:people=[],config=null,onSave:callback=null,...extra}={}) => {
  ensure(); members=people; if(!members.length)return;
  sourceConfig=structuredClone(config || {}); context=extra; onSave=callback;
  state=S.fromConfig(config,members); original=structuredClone(state); dirty=false; saving=false; focusBefore=document.activeElement;
  render(); modal.style.display='flex'; modal.querySelector('.mcm-close').focus();
};
window.closeWorkflowConfigModal=close;
})();
