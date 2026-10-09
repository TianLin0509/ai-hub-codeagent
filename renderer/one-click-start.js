'use strict';
// Visible, one-shot composer text. No workflow state and no send-time injection.
const START = '【一键开工】';
const END = '【一键开工结束】';
const PROMPT = [
  '按当前需求自主完成任务，包括实现、验证、审阅和合并。自行安排工作，不必等待我逐步指挥；能合理判断的直接决定，遇到影响目标、超出授权或无法自行解决的问题再问我。',
  '先核实项目根、项目规范和已有成果。在本任务独立 worktree 中工作；已有则接续，没有则基于最新目标分支创建。保持提交只包含本任务改动，保护生产环境和他人的未提交内容，不为追求“干净”而清理或覆盖他人成果。',
  '完成必要测试并审阅实际改动。合并前同步目标分支、核对候选提交并验证集成结果；自行解决能够明确判断的冲突，解决后重新验证，不盲目覆盖任一方。验证通过后按项目入口合并，完成规定的推送和后置检查。本条授权上述任务范围内的操作，用户明确限制和项目额外审批要求仍须遵守。',
  '持续做到任务完成，不重复已完成步骤；已合并则只补剩余工作。不要仅凭提交成功宣称任务完成，也不将自审称为独立审查。不强制阶段文件或固定报告格式；复杂任务按需保存必要记录。',
  '用大白话简短汇报关键进展，最后说明完成了什么、验证结果、合并结果和遗留问题。复杂内容必要时制作 HTML。',
].join('\n\n');
function suffix(text) {
  const current = String(text || '');
  // Keep even an edited/partially deleted block: never overwrite user changes.
  if (current.includes(START) || current.includes(END) || current.includes(PROMPT)) return '';
  return `${current ? (current.endsWith('\n') ? '\n' : '\n\n') : ''}${START}\n${PROMPT}\n${END}`;
}
module.exports = { START, END, PROMPT, suffix };
