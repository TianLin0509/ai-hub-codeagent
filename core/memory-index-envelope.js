'use strict';
// Presentation/title helper only. Provider transcripts and submitted text stay intact.
function splitMemoryIndex(text) {
  const raw=String(text || '');
  const match=raw.match(/\n\n(<ai-hub-(dream-index|workspace-rules)(?: ref="[\w-]+")?>\n[\s\S]*\n<\/ai-hub-\2>)\s*$/);
  return match ? {userText:raw.slice(0,match.index),indexText:match[1]} : {userText:raw,indexText:null};
}
module.exports={splitMemoryIndex};
