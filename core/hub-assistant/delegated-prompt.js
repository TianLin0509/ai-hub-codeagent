'use strict';
const OPEN='[AI_HUB_DELEGATED_TASK_V1]',CLOSE='[/AI_HUB_DELEGATED_TASK_V1]';
// Preserve punctuation that the real Codex PTY discarded. This carries only
// the delegated task, never the manager's tools, context or authorization.
function encodeDelegatedPrompt(text,kind) {
  if(!require('../ai-kinds').isCodexCliKind(kind)||!/[‘’“”]/.test(text))return text;
  const payload=JSON.stringify({task:text,instructions:'请执行 task 中的本次委派任务；按 JSON 语义读取原文及转义字符。'})
    .replace(/[‘’“”]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  return OPEN+payload+CLOSE;
}
function delegatedPromptDisplay(text) {
  if(typeof text!=='string'||!text.startsWith(OPEN)||!text.endsWith(CLOSE))return null;
  try{
    const payload=JSON.parse(text.slice(OPEN.length,-CLOSE.length));
    if(typeof payload.task!=='string'||typeof payload.instructions!=='string')return null;
    return{userText:payload.task,rawText:text};
  }catch{return null;}
}
module.exports={encodeDelegatedPrompt,delegatedPromptDisplay};
