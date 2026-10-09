'use strict';
const {isCodexCliKind}=require('./ai-kinds');
// Codex 0.153 on Windows receives paste as key events. Enter may extend its
// paste burst instead of submitting. A non-text End key flushes that burst and
// clears Enter suppression without changing the prompt. It follows all payload
// bytes in the same PTY queue; no wall-clock delay can provide this boundary.
// Verified against openai/codex rust-v0.153.0 bottom_pane/chat_composer.rs.
function flushCodexPasteInput(sessionManager,sid,kind,prompt,platform=process.platform){
  if(platform!=='win32'||!isCodexCliKind(kind))return false;
  sessionManager.writeToSession(sid,'\x1b[F');
  return true;
}
module.exports={flushCodexPasteInput};
