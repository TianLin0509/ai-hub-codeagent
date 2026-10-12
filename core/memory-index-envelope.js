'use strict';
// Presentation/title helper only. Provider transcripts and submitted text stay intact.
// 末尾可能连着挂几块（通用规则 + 工作区规则 + 梦境索引），逐块从尾部剥下来，一并归到 indexText。
// Claude 会把超长粘贴整段包进 <pasted_content>（见 core/pty-prompt-submit.js），先拆掉这层外壳再找。
const TRAILING_BLOCK=/\n\n(<ai-hub-(dream-index|workspace-rules|rules)(?: ref="[\w-]+")?>\n[\s\S]*\n<\/ai-hub-\2>)\s*$/;
function splitMemoryIndex(text) {
  const original=String(text || '');
  const unwrapped=require('./prompt-submission-receipts').unwrapClaudePasteEnvelope(original);
  const raw=TRAILING_BLOCK.test(unwrapped) ? unwrapped : original;
  let userText=raw,match;
  while((match=userText.match(TRAILING_BLOCK)))userText=userText.slice(0,match.index);
  return userText===raw ? {userText:original,indexText:null} : {userText,indexText:raw.slice(userText.length+2).replace(/\s+$/,'')};
}
module.exports={splitMemoryIndex};
