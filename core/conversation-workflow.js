'use strict';
// Ordered speech uses ordinary group answers and provider turn completion.
// It has no delivery run, frozen inputs, review verdict or task lifecycle.
function enabled(meeting) { return !!(meeting?.groupChat && meeting.serialWorkflow?.conversationVersion === 1); }
function prompt(input, stage, index, total) {
  return [`【按顺序发言 · 第 ${index+1}/${total} 轮 · ${stage.name}】`,
    `用户本次输入：${String(input || '').trim()}`,
    ...(String(stage.prompt || '').trim() ? ['本轮补充要求：',stage.prompt] : []),
    index > 0 ? '结合群内前序成员的发言回答用户，按本轮补充要求展开。' : '回答用户本次输入，按本轮补充要求展开。',
  ].join('\n\n');
}
module.exports={enabled,prompt};
