'use strict';
const {displayTurns,userTextIdentity}=require('./conversation-display');
const {displayUserText}=require('./synthetic-user-filter');

function captureConversationMessages({native,kind,sourcePath,providerTurnId,clientSubmissionId,prompt,since}) {
  let turns;
  if (native) {
    if (!providerTurnId) return [];
    turns=native.readTranscript({limit:Infinity,turnId:providerTurnId}).map(t=>!clientSubmissionId || t.role!=='assistant' ? t : ({...t,
      clientSubmissionId,displayMessages:t.displayMessages?.filter(m=>m.clientSubmissionId===clientSubmissionId),
      toolCalls:t.toolCalls?.filter(tool=>tool.clientSubmissionId===clientSubmissionId),thinking:null}));
    return displayTurns(turns).filter(m=>m.providerTurnId===providerTurnId && m.role==='assistant' && (m.text || m.toolCalls?.length)
      && (!clientSubmissionId || m.clientSubmissionId===clientSubmissionId));
  }
  if (!sourcePath) return [];
  if (/^codex/.test(kind || '')) turns=require('./codex-transcript-parser').parseCodexRolloutToTurns(sourcePath,{limit:Infinity});
  else if (/^claude/.test(kind || '')) turns=require('./claude-transcript-parser').parseClaudeTranscriptToTurns(sourcePath,{limit:Infinity});
  else return [];
  // Historical providers have no App Server item stream. Bind to the exact
  // dispatched prompt and its submission time, never "latest assistant".
  const expected=userTextIdentity(displayUserText(prompt || '') || prompt);
  const start=turns.findLastIndex(t=>t.role==='user' && Number(t.ts)>=Number(since || Infinity)-1000
    && userTextIdentity(t.text)===expected);
  if(start<0)return [];
  const owned=[];
  for(const t of turns.slice(start+1)) {if(t.role==='user')break;owned.push(t);}
  return displayTurns(owned).filter(m=>m.role==='assistant' && (m.text || m.toolCalls?.length));
}
module.exports={captureConversationMessages};
