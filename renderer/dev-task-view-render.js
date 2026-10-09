'use strict';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (action,label,attrs='') => `<button type="button" data-devb-action="${action}" ${attrs}>${label}</button>`;
function rowHtml(row, expanded=false) {
  const source=row.source || {}, runtime=row.runtime || {}, at=source.at>0?new Date(source.at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'未记录';
  const stale=['stale','unavailable'].includes(row.quality), tone=['ok','run','warn','bad'].includes(row.stage?.tone)?row.stage.tone:'idle';
  const status = stale ? `${row.stage?.label || '状态未知'} · 待核对` : row.stage?.label || '状态未知';
  const title = row.title || '未命名开发群聊';
  return `<article class="devb-row" data-mid="${esc(row.id)}"><div class="devb-row-main">
    <div class="devb-identity">${button('details',esc(title),`class="devb-task-title" aria-expanded="${expanded}" aria-controls="devb-detail-${esc(row.id)}"`)}<div class="devb-project" title="${esc(row.workspace)}">${esc(row.project || row.workspace || '未绑定项目')}</div></div>
    <div class="devb-stage ${tone}">${esc(status)}</div><div class="devb-progress">${esc(row.progress || '尚无可核对的进展。')}${row.attention?.kind==='user-decision'?`<div class="devb-decision">${esc(row.attention.text)}</div>`:''}</div>
    <div class="devb-source" title="${source.at?esc(new Date(source.at).toISOString()):''}">${esc(at)}<br>${esc(source.name || row.mode || '')}</div>${button('open','↗','class="devb-open" aria-label="进入原群聊" title="进入原群聊"')}</div>
    ${row.notice?`<p class="devb-notice">${esc(row.notice)}</p>`:''}
    <section id="devb-detail-${esc(row.id)}" class="devb-detail" ${expanded?'':'hidden'}><div><h4>当前依据</h4><p>${esc(row.basis || '暂无核对依据')}</p><h4>验证与交付</h4><p>${esc(row.outcome || row.card?.verified || '尚无核对后的交付结果。')}</p>${row.evidence?.length?`<ul>${row.evidence.map(e=>`<li>${esc(e.kind)}：${esc(e.ref)} <small>文档引用，未自动验证</small></li>`).join('')}</ul>`:''}${row.merge?`<p class="devb-path">候选 ${esc(row.merge.candidate)}<br>合并 ${esc(row.merge.commit)}<br>目标 ${esc(row.merge.target)}</p>`:''}</div><dl><dt>运行状态</dt><dd>${esc(runtime.label || '状态未知')} ${runtime.memberId?`· ${esc(runtime.memberId)}`:''}</dd><dt>协作方式</dt><dd>${esc(row.mode || '未知')}</dd><dt>项目目录</dt><dd class="devb-path">${esc(row.workspace || '未绑定')}</dd><dt>记录修订</dt><dd>${source.revision || '未记录'}${stale?' · 上次有效记录':''}</dd></dl><div class="devb-read-links">${source.name&&row.mode!=='旧协议'?button('source','查看来源原文 ↗'):''}${button('open','进入原群聊 ↗')}</div></section></article>`;
}
module.exports={esc,button,rowHtml};
