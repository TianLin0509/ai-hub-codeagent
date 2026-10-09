'use strict';

// This is a display projection only. Stored text, sent prompts and exports
// retain the complete file protocol; older records need no inferred goal.
function render(message,escapeHtml) {
  const d=message.dispatch || {};
  const goal=typeof d.goal==='string' && d.goal;
  const heading=d.stageName || `步骤 ${Number(d.stepIndex)+1}`;
  const goalHtml=goal ? require('./conversation-message-view').renderMessageBody(goal,
    {isUser:true,escapeHtml,foldLong:true}) : '';
  return `<div class="mr-gc-dispatch-summary"><strong>${escapeHtml(heading)}</strong>${goalHtml?`<div class="mr-gc-md">${goalHtml}</div>`:''}</div>`
    + `<details class="mr-gc-dispatch-details"><summary>查看完整派工指令</summary><div class="mr-gc-md conversation-user-text">${escapeHtml(message.content || '')}</div></details>`;
}
module.exports={render};
