'use strict';
// Development guidance appended to delivery prompts (kind 'file'). Kept apart
// from the file protocol so review policy can evolve without touching it.
// Everything here is Hub-injected: the user only types the task.
const path = require('node:path');

const LESSON_CAP = 30;
const LEVELS = 'P1＝主功能不成立、数据丢失或损坏、安全或生产保护问题、测试或集成失败；P2＝其余（体验、边角场景、文案、测试稳定性等）';

function lessonsDir(dataDir) { return path.join(dataDir, 'project-lessons'); }
// Reviews up to and including this step; 1 means the first review of the run.
function reviewRound(run, step) {
  return run.steps.slice(0, step.number).filter(s => run.stages[s.index]?.after === 'review').length;
}
function overlapLines(overlaps) {
  return (overlaps || []).map(o => `在途任务「${o.title}」的候选也改动了：${o.files.slice(0, 12).join('、')}${o.files.length > 12 ? ` 等 ${o.files.length} 个文件` : ''}。避免无谓地大改同一处，合并前核对冲突。`);
}
function gateLine(gate) {
  if (!gate) return '';
  if (gate.state === 'passed') return `Hub 已在候选 ${gate.sha} 上跑完项目测试闸门并通过（${gate.commands.join('；')}，用时约 ${Math.max(1, Math.round(gate.durationMs / 60000))} 分钟，日志 ${gate.logPath}）。合并入口的 dry-run 自带测试属正常，不必另外单独重跑全量测试；把精力放在集成、真实行为和失败模式验证上。`;
  if (gate.state === 'skipped') return `Hub 未执行测试闸门（${gate.reason}），按项目合同自行完成验证。`;
  return '';
}

function lines(run, step, extras = {}) {
  const stage = run.stages[step.index], out = [], dir = extras.lessonsDir;
  const lessonFile = dir ? path.join(dir, '<项目目录名>.md') : '';
  if (stage.phase === 'kickoff') {
    out.push('开题报告另列「失败模式清单」：本任务最可能出错的 3–8 个场景（例如停止或重启后迟到的事件、并发与重复触发、配置或数据损坏、非 ASCII 路径、与在途任务改同一处），每条写清怎么检验。');
    if (dir) out.push(`先读 ${lessonFile}（目标项目的历史教训，文件名为项目目录名；不存在就跳过），把相关条目纳入失败模式清单。`);
  }
  if (stage.phase === 'build') {
    out.push('交付前逐条执行开题报告里的失败模式清单，并在交付中记录每条的结果；收到需返工时先修复列出的问题，再补跑清单中受影响的条目。');
    if (dir) out.push(`同时对照 ${lessonFile}（如存在）自查。`);
    out.push('交付文件中单独一行写 `CANDIDATE: <worktree 绝对路径> <完整 40 位提交 SHA>`。交付前提交全部改动并保持 worktree 干净；Hub 会在该提交上代跑项目测试闸门，失败直接退回你修复，不占用审查。');
    if (extras.gateFailure) out.push(`上一版候选未通过 Hub 测试闸门：先读 ${extras.gateFailure}，修复失败项后重新交付。`);
  }
  if (stage.after === 'review') {
    const round = reviewRound(run, step);
    out.push(round <= 1
      ? `第 1 轮审查：一次列全全部阻断问题并标注等级（${LEVELS}），不要留到下一轮再提。`
      : `第 ${round} 轮审查（复审）：先逐项复核上一轮需返工项是否修好、有无回归。新发现的 P1 仍交需返工；新发现的 P2 写进交付的「遗留清单」，不阻断合并。（${LEVELS}）`);
    out.push('与最新主干的冲突或集成失败先分级：机械性的（相邻行、导入顺序、版本号、文档、改名跟随等）且解决不改变实现意图，由你在候选分支上直接解决并提交，交付里写明改动和新 SHA，然后继续验证与合并；只有需要改变实现逻辑或取舍的冲突才交需返工。除此之外仍不代修实现缺陷。');
    const gate = gateLine(extras.gate);
    if (gate) out.push(gate);
    if (dir) out.push(`真实合并完成后，若本任务曾经返工，把可复用的教训追加到 ${lessonFile}：每条一句「场景 → 怎么检验」，同类合并，总数不超过 ${LESSON_CAP} 条，UTF-8 保存。没有新教训就不写；这一步不影响交付判断。`);
  }
  out.push(...overlapLines(extras.overlaps));
  return out;
}

module.exports = { LESSON_CAP, lessonsDir, reviewRound, lines };
