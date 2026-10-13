'use strict';
// Presentation/title helper only. Provider transcripts and submitted text stay intact.
// Hub 附带块（通用规则 + 工作区规则 + 梦境索引）在正文前面（2026-10-13 起）或后面（更早），
// 一并归到 indexText；拆法见 core/synthetic-user-filter.js 的 splitHubEnvelopes。
function splitMemoryIndex(text) {
  const original=String(text || '');
  const {text:userText,blocks}=require('./synthetic-user-filter').splitHubEnvelopes(original);
  return blocks.length ? {userText,indexText:blocks.join('\n\n')} : {userText:original,indexText:null};
}
module.exports={splitMemoryIndex};
