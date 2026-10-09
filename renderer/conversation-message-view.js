'use strict';

function plainProgressText(text) {
  let fence = null;
  return String(text || '').split('\n').map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence=marker[1]; else if (marker[1][0]===fence[0] && marker[1].length>=fence.length) fence=null; return line; }
    return fence ? line : line.replace(/^(\s*)(?:PLAN|UPDATE)\s*[:：]\s*/,'$1');
  }).join('\n');
}
function renderMessageBody(text, {isUser=false, plainProgress=false, foldLong=true, escapeHtml, renderMarkdown}) {
  const memory = isUser && require('../core/memory-index-envelope').splitMemoryIndex(text);
  if (memory?.indexText) return renderMessageBody(memory.userText,{isUser,plainProgress,foldLong,escapeHtml,renderMarkdown})
    + '<details class="conversation-memory-context"><summary>附带项目记忆索引 / 共享规则</summary>'
    + `<pre>${escapeHtml(memory.indexText)}</pre></details>`;
  const raw=plainProgress && !isUser ? plainProgressText(text) : String(text || '');
  const body=isUser ? `<div class="conversation-user-text">${escapeHtml(raw)}</div>` : renderMarkdown(raw);
  if(!foldLong || (raw.length<1200 && raw.split('\n').length<32))return body;
  // This is an explicit presentation fold of ONE source message. No invented
  // message boundaries, truncation of the source, or rewritten summary.
  // Reuse the complete, sanitized rendering: slicing Markdown can cut a fence,
  // link or emphasis delimiter. CSS clips the preview without changing source.
  // Keep block Markdown outside summary so tables/lists/code remain valid HTML.
  return `<div class="conversation-long-frame"><details class="conversation-long-message" open><summary><span>长消息 · ${raw.length.toLocaleString('zh-CN')} 字 · </span><span class="conversation-expand-label">展开全文</span><span class="conversation-collapse-label">收起全文</span></summary>`
    + `<div class="conversation-full-text">${body}</div></details>`
    + `<div class="conversation-long-preview" data-copy-exclude>${body}</div></div>`;
}
function phaseLabel(phase) {
  return ({commentary:'进展',final_answer:'结果',final:'结果',activity:'活动记录'})[phase] || '消息';
}
function renderActivity(message,escapeHtml) {
  return `<details class="conversation-activity"><summary>活动 · ${message.toolCalls.length} 项 · 展开执行记录</summary>`
    + message.toolCalls.map(t=>`<div class="conversation-tool"><strong>${escapeHtml(t.name || '工具')}</strong> · ${escapeHtml(({completed:'已完成',running:'进行中',failed:'失败',unknown:'结果未确认'})[t.status] || t.status || '待确认')}`
      + `<pre>${escapeHtml(typeof t.input==='string' ? t.input : JSON.stringify(t.input || {},null,2))}</pre>`
      + (t.output ? `<pre>${escapeHtml(typeof t.output==='string' ? t.output : JSON.stringify(t.output,null,2))}</pre>` : '')+'</div>').join('')+'</details>';
}
function renderSequenceActivity(messages, escapeHtml) {
  const activities = (messages || []).filter(m => m?.toolCalls?.length);
  if (!activities.length) return '';
  return require('./conversation-header-activity').renderHeaderActivity(activities.map(m =>
    `<div data-message-id="${escapeHtml(m.id || '')}:activity">${renderActivity(m,escapeHtml)}</div>`).join(''),
    activities.reduce((n,m) => n + m.toolCalls.length, 0));
}
function renderMessageSequence(messages,{escapeHtml,renderMarkdown,plainProgress=false,activityInHeader=false,foldLong=true}) {
  return messages.filter(m=>m && (m.text || m.toolCalls?.length) && !(activityInHeader && m.toolCalls?.length && !m.text))
    .map(m=>activityInHeader && m.toolCalls?.length ? {...m,toolCalls:[]} : m).map(m=>m.phase==='commentary' && !m.toolCalls?.length
    ? `<section class="conversation-entry conversation-progress-row" data-message-id="${escapeHtml(m.id || '')}" data-phase="commentary">`
      + renderProgressRow(m, {escapeHtml,renderMarkdown,plainProgress,foldLong}) + '</section>'
    : `<section class="conversation-entry" data-message-id="${escapeHtml(m.id || '')}" data-phase="${escapeHtml(m.phase || 'message')}">`
    + `<div class="conversation-entry-head"><span class="conversation-phase">${phaseLabel(m.phase)}</span>`
    + `${m.ts ? `<time>${escapeHtml(require('../core/beijing-time').formatBeijingClock(m.ts))}</time>` : ''}`
    + '<button class="conversation-message-copy" data-action="conversation-copy" title="复制这条消息" aria-label="复制这条消息">复制</button></div>'
    + (m.toolCalls?.length ? renderActivity(m,escapeHtml) : renderMessageBody(m.text,{escapeHtml,renderMarkdown,foldLong,plainProgress:plainProgress && m.phase==='commentary'}))+'</section>').join('');
}
// The same time/text grid is used by ordinary cards and meeting replies. The
// provider item remains the copy/selection/disclosure boundary.
function renderProgressRow(message, {escapeHtml,renderMarkdown,plainProgress=false,foldLong=true,actions}) {
  const clock=message.ts ? require('../core/beijing-time').formatBeijingClock(message.ts) : '';
  return `<time class="conversation-progress-time" data-copy-exclude title="${escapeHtml(clock)}">${escapeHtml(clock.slice(0,5))}</time>`
    + `<div class="conversation-progress-content">${renderMessageBody(message.text,{escapeHtml,renderMarkdown,plainProgress,foldLong})}</div>`
    + `<div class="conversation-progress-actions" data-copy-exclude>${actions ?? '<button class="conversation-message-copy" data-action="conversation-copy" title="复制这条进展" aria-label="复制这条进展">复制</button>'}</div>`;
}

function sameResponse(previous, current) {
  return !!(previous && current && previous.role==='assistant' && current.role==='assistant'
    && previous.logicalTurnId && previous.logicalTurnId===current.logicalTurnId
    && previous.sessionId===current.sessionId && previous.agent===current.agent
    && previous.inherited===current.inherited);
}
function cardResponse(card) {
  return card && {role:card.classList.contains('assistant')?'assistant':'user',
    logicalTurnId:card.dataset.responseId,sessionId:card.dataset.sessionId,
    agent:card.dataset.responseAgent,inherited:card.dataset.inherited};
}
function adjacentCard(card, direction) {
  let next=card?.[direction];
  while(next && !next.classList.contains('turn-card'))next=next[direction];
  return next;
}
function syncResponseCard(card) {
  if(!card?.classList?.contains('turn-card'))return;
  const previous=adjacentCard(card,'previousElementSibling');
  card.classList.toggle('conversation-response-continuation',sameResponse(cardResponse(previous),cardResponse(card)));
}
function syncResponseNeighbors(card) {
  syncResponseCard(card);
  syncResponseCard(adjacentCard(card,'nextElementSibling'));
  require('./conversation-header-activity').syncHeaderActivities(card?.parentElement,responseCards);
}
function syncResponseGroups(container) {
  container.querySelectorAll(':scope > .turn-card').forEach(syncResponseCard);
  require('./conversation-header-activity').syncHeaderActivities(container,responseCards);
}
function responseCards(card) {
  const cards=[card];
  for(const direction of ['previousElementSibling','nextElementSibling']) {
    let current=card, next;
    while((next=adjacentCard(current,direction)) && sameResponse(cardResponse(current),cardResponse(next))) {
      if(direction==='previousElementSibling')cards.unshift(next);else cards.push(next);
      current=next;
    }
  }
  return cards;
}
function patchConversationArticle(existing, next) {
  const activity = existing.querySelector('.conversation-header-activity');
  const nextActivity = next.querySelector('.conversation-header-activity');
  if (activity && nextActivity) nextActivity.open = activity.open;
  const delivery = existing.querySelector('.turn-delivery-summary');
  const nextDelivery = next.querySelector('.turn-delivery-summary');
  if (delivery && nextDelivery) nextDelivery.open = delivery.open;
  const doc=existing.ownerDocument;
  const selection=doc.defaultView.getSelection();
  let savedSelection;
  if(selection?.rangeCount && existing.contains(selection.anchorNode) && existing.contains(selection.focusNode)) {
    const range=selection.getRangeAt(0),prefix=doc.createRange();
    prefix.selectNodeContents(existing);prefix.setEnd(range.startContainer,range.startOffset);
    savedSelection={start:prefix.toString().length,length:range.toString().length,text:range.toString()};
  }
  const oldEntries=new Map([...existing.querySelectorAll('[data-message-id]')].map(e=>[e.dataset.messageId,e]));
  for(const entry of next.querySelectorAll('[data-message-id]')) {
    const old=oldEntries.get(entry.dataset.messageId);
    if(!old)continue;
    const oldDetails=new Map();
    for(const detail of old.querySelectorAll('details')) {
      if(!oldDetails.has(detail.className))oldDetails.set(detail.className,[]);
      oldDetails.get(detail.className).push(detail.open);
    }
    for(const detail of entry.querySelectorAll('details')) {
      const states=oldDetails.get(detail.className);
      if(states?.length)detail.open=states.shift();
    }
    if(entry.innerHTML===old.innerHTML)entry.replaceWith(old);
  }
  // Keep the article anchor and unchanged provider items, including disclosure.
  for(const attr of [...existing.attributes])existing.removeAttribute(attr.name);
  for(const attr of [...next.attributes])existing.setAttribute(attr.name,attr.value);
  existing.replaceChildren(...next.childNodes);
  require('./message-disclosure-state').restore(existing);
  if(savedSelection) {
    const walker=doc.createTreeWalker(existing,4),nodes=[];let node,offset=0;
    while((node=walker.nextNode())){nodes.push({node,start:offset,end:offset+node.textContent.length});offset+=node.textContent.length;}
    const a=nodes.find(n=>n.end>savedSelection.start) || nodes[nodes.length-1],b=nodes.find(n=>n.end>=savedSelection.start+savedSelection.length);
    if(a && b){const r=doc.createRange();r.setStart(a.node,savedSelection.start-a.start);r.setEnd(b.node,savedSelection.start+savedSelection.length-b.start);
      if(r.toString()===savedSelection.text){selection.removeAllRanges();selection.addRange(r);}}
  }
}
module.exports={renderMessageBody,renderMessageSequence,renderSequenceActivity,renderProgressRow,sameResponse,syncResponseNeighbors,syncResponseGroups,responseCards,phaseLabel,patchConversationArticle,plainProgressText};
