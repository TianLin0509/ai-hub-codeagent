'use strict';
const fs=require('fs');
const {displayTurns,userTextIdentity}=require('./conversation-display');
const {displayUserText}=require('./synthetic-user-filter');

// 2026-10-14: a streaming group member is captured every 1.5 s. Parsing the
// member's whole Claude transcript each time (median 3 MB, p90 18 MB) only to
// keep the turns after the dispatched prompt cost 140–190 ms per poll on a
// 23 MB file. The first poll finds the prompt in a tail window that grows until
// it is found (256 KB, then 4 MB); later polls of the same prompt read from
// that window's start. Not found in either: the full parse, as before.
const WINDOW_BYTES=[256*1024,4*1024*1024];
const MAX_REMEMBERED_WINDOWS=32;
const claudeWindows=new Map();

function readFrom(sourcePath,start,size) {
  const fd=fs.openSync(sourcePath,'r');
  try {
    const buf=Buffer.alloc(size-start);
    fs.readSync(fd,buf,0,buf.length,start);
    let raw=buf.toString('utf8');
    // The window may begin inside a line; that partial line is not ours.
    if(start>0){const newline=raw.indexOf('\n');raw=newline>=0?raw.slice(newline+1):'';}
    return raw;
  } finally {fs.closeSync(fd);}
}

function ownedTurns(turns,expected,since,{needEarlierTurn=false}={}) {
  const start=turns.findLastIndex(t=>t.role==='user' && Number(t.ts)>=Number(since || Infinity)-1000
    && userTextIdentity(t.text)===expected);
  // Inside a window the prompt must not be the first turn: what precedes it
  // decides how the parser groups entries, exactly as in the full file.
  if(start<0 || (needEarlierTurn && start===0))return null;
  const owned=[];
  for(const t of turns.slice(start+1)) {if(t.role==='user')break;owned.push(t);}
  return owned;
}

function claudeOwnedTurns(sourcePath,expected,since) {
  const {parseClaudeTranscriptText,parseClaudeTranscriptToTurns}=require('./claude-transcript-parser');
  const key=JSON.stringify([sourcePath,Number(since) || 0,expected]);
  const size=fs.statSync(sourcePath).size;
  const known=claudeWindows.get(key);
  const remember=start=>{
    claudeWindows.delete(key);claudeWindows.set(key,{start});
    while(claudeWindows.size>MAX_REMEMBERED_WINDOWS)claudeWindows.delete(claudeWindows.keys().next().value);
  };
  const starts=known && known.start<=size ? [known.start]
    : [...new Set(WINDOW_BYTES.map(bytes=>Math.max(0,size-bytes)).filter(start=>start>0))];
  for(const start of starts) {
    if(start===0)break;
    const owned=ownedTurns(parseClaudeTranscriptText(readFrom(sourcePath,start,size)),expected,since,{needEarlierTurn:true});
    if(owned){remember(start);return owned;}
  }
  const owned=ownedTurns(parseClaudeTranscriptToTurns(sourcePath,{limit:Infinity}),expected,since);
  // Found only in the whole file: go straight there next time instead of retrying windows.
  if(owned)remember(0);else claudeWindows.delete(key);
  return owned || [];
}

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
  // Historical providers have no App Server item stream. Bind to the exact
  // dispatched prompt and its submission time, never "latest assistant".
  const expected=userTextIdentity(displayUserText(prompt || '') || prompt);
  let owned;
  if (/^codex/.test(kind || '')) {
    turns=require('./codex-transcript-parser').parseCodexRolloutToTurns(sourcePath,{limit:Infinity});
    owned=ownedTurns(turns,expected,since);
  }
  else if (/^claude/.test(kind || '')) owned=claudeOwnedTurns(sourcePath,expected,since);
  else return [];
  if(!owned)return [];
  return displayTurns(owned).filter(m=>m.role==='assistant' && (m.text || m.toolCalls?.length));
}
module.exports={captureConversationMessages,_private:{claudeWindows,WINDOW_BYTES}};
