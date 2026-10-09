'use strict';
const { isCodexCliKind, isClaudeFamily, isCodeAgentKind } = require('./ai-kinds');
function modelCommandType(kind, prompt) {
  if (isCodexCliKind(kind) && /^\s*\/model\s*$/i.test(prompt)) return 'codex-picker';
  // Code Agent 的 /model 是自己的选择界面，确认文案与 Claude 不同，不当成 Claude 的行内切换。
  if (isClaudeFamily(kind) && !isCodeAgentKind(kind) && /^\s*\/model\s+\S+\s*$/i.test(prompt)) return 'claude-inline';
  return null;
}
function modelCommandAcknowledged(type, screen, freshOutput) {
  if (type === 'codex-picker') return /Select Model and Effort/i.test(screen)
    && /^\s*[›>]?\s*\d+\.\s+(?:gpt-|o\d|deepseek-v4-)/im.test(screen);
  return type === 'claude-inline' && (/(?:set model to|model changed|model switched|now using)/i.test(freshOutput)
    || !!parseClaudeModelSwitchConfirmation(screen)||!!parseClaudeModelSwitchConfirmation(freshOutput));
}
function parseClaudeModelSwitchConfirmation(screen,modelId) {
  const text=String(screen||''),header=text.lastIndexOf('Switch model?');
  if(header<0)return null;
  const dialog=text.slice(header),yes=dialog.match(/(?:^|\s)([❯›>]?)\s*(\d+)\.\s*Yes, switch to (.+?)(?=\s+[❯›>]?\s*\d+\.\s*No, go back(?:\s|$))/s);
  const no=dialog.match(/(?:^|\s)([❯›>]?)\s*(\d+)\.\s*No, go back(?:\s|$)/);
  if(!yes||!no||(!yes[1]&&!no[1])||yes[1]&&no[1])return null;
  if(modelId){
    const expected=String(modelId).replace(/^claude-/,'').replace(/\[1m\]$/,'').replace(/-20\d{6}$/,'').replace(/-/g,' ');
    const actual=yes[3].trim().replace(/\./g,' ').replace(/\s+/g,' ');
    const a=actual.toLowerCase(),e=expected.toLowerCase();
    if(a!==e&&!(e.indexOf(' ')<0&&a.startsWith(e+' '))&&!a.startsWith(e+' ('))return null;
  }
  return {target:yes[3].trim(),number:Number(yes[2]),cursor:Number(yes[1]?yes[2]:no[2])};
}
module.exports = { modelCommandType, modelCommandAcknowledged,parseClaudeModelSwitchConfirmation };
