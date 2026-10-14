'use strict';
const { isCodexCliKind, isClaudeFamily, isCodeAgentKind } = require('./ai-kinds');
function modelCommandType(kind, prompt) {
  if (isCodexCliKind(kind) && /^\s*\/model\s*$/i.test(prompt)) return 'codex-picker';
  // Code Agent 的 /model 是自己的选择界面，确认文案与 Claude 不同，不当成 Claude 的行内切换。
  // 不带参数的 /model 打开菜单，由 core/codeagent-model-picker.js 接着选（带参数的写法公司真机不生效）。
  if (isCodeAgentKind(kind) && /^\s*\/model\s*$/i.test(prompt)) return 'codeagent-picker';
  if (isClaudeFamily(kind) && !isCodeAgentKind(kind) && /^\s*\/model\s+\S+\s*$/i.test(prompt)) return 'claude-inline';
  if (/^gemini(?:-resume)?$/.test(String(kind || '')) && /^\s*\/model\s+\S+\s*$/i.test(prompt)) return 'agy-inline';
  return null;
}
function modelCommandAcknowledged(type, screen, freshOutput) {
  // Only output produced after this Enter counts: an earlier switch leaves the same text on screen.
  if (type === 'agy-inline') return /Model set to\s+\S/i.test(freshOutput);
  if (type === 'codeagent-picker') return !!require('./codeagent-model-picker').parsePicker(String(screen || '').split('\n'));
  if (type === 'codex-picker') return /Select Model and Effort/i.test(screen)
    && /^\s*[›>]?\s*\d+\.\s+(?:gpt-|o\d|deepseek-v4-|deepseek-flash\b)/im.test(screen);
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
