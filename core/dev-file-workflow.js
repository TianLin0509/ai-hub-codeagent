'use strict';
// v2 deliberately reads names only. Document quality belongs to the two Agents.
const fs = require('node:fs');
const path = require('node:path');
const VERSION = 2;
const PRESET_START = '【AI HUB 开题提示词】';
const PRESET_END = '【开题提示词结束】';
const PROJECT_PREP_PROMPT = '用 project-prep 整理当前仓库，接入 AI HUB 群聊开发，保留现有测试和合并规则。'
  + `准备验证通过后，在正式主目录运行 node "${path.resolve(__dirname, '../scripts/prepared-projects.js')}" register "<已核实的项目绝对路径>" --data-dir "${require('./data-dir').getHubDataDir()}"，`
  + '把占位路径替换为实际主目录；登记成功才完成 Hub 接入。不要登记 worktree 或验证副本。';
const SOLO_START = '【AI HUB 独立开工提示词】';
const SOLO_END = '【独立开工提示词结束】';
const PROMPT_VERSION = 4;
// One automatic budget covers this many independent reviews. Kickoff and
// builds are free: every build is always followed by its review.
const REVIEW_LIMIT = 3;
const HUMAN_REPORT = '用大白话、言简意赅地向用户汇报关键进展、结果或阻碍，不用固定英文标签，不复述文件全文。复杂内容必要时制作 HTML，给出准确路径；不为每一步都写报告。';
const isSolo = m => enabled(m) && m.serialWorkflow.soloDevelopment === true;
const currentProjectLocator = meeting => require('./prepared-project-registry').projectLocator(meeting);
function roles(meeting, members = []) {
  const specs = meeting.slotSpecs || [];
  const resolve = index => {
    const id = meeting.serialWorkflow?.steps?.[index]?.[0] || specs[index]?.memberId || `m${index + 1}`;
    const member = members.find(m => m.memberId === id);
    const spec = specs.find((m, i) => (m.memberId || `m${i + 1}`) === id);
    return { id, name: member?.displayName || spec?.title || spec?.name || `成员 ${id}` };
  };
  return { author: resolve(0), merger: resolve(1) };
}
function protocolKey(meeting, members = []) {
  return JSON.stringify([PROMPT_VERSION, !!isSolo(meeting), meeting.workspace || '', currentProjectLocator(meeting), roles(meeting, members)]);
}
function soloCommon(meeting, dir, members = []) {
  const { author } = roles(meeting, members);
  return [
    '## AI HUB 单 Agent 开发',
    `工作目录：${meeting.workspace || '先核实本群任务对应的项目根目录'}`,
    currentProjectLocator(meeting),
    `${author.name} 负责实现、验证和已授权的合并；自测不等于独立审查。普通讨论不启动施工，明确开工后持续完成任务，不等待 Hub 派下一阶段。`,
    `任务记录：${path.join(dir || '本群任务目录', '任务记录.md')}。执行前读取并核对现场，无记录则创建；只更新变化与必要证据，UTF-8 保存并回读。不另建阶段交接文件，不靠改名派工。`,
    '遵守用户范围和项目规范；项目要求独立审查或额外审批时仍须满足。完成写真实结果，阻塞写原因和未完成项，不反复索取已有授权。',
    require('./dev-task-view').recordInstruction(meeting),
    HUMAN_REPORT,
  ].filter(Boolean).join('\n');
}
function independentPrompt(meeting = {}, dir = '本群任务目录', members = []) {
  const { author } = roles(meeting, members), record = path.join(dir, '任务记录.md');
  return [
    `${author.name}：按当前需求独立开工，兼任实现 Agent 与合并 Agent。项目：${meeting.workspace || '先核实真实项目根'}。`,
    `先读项目 AGENTS.md、.agents/AUTHOR.md、.agents/MERGER.md、.agents/project.json 和 ${record}；无记录则创建。复用已有成果，在独立 worktree 实现，保护生产与他人改动。`,
    '完成必要测试，GUI 改动提供真实隔离证据；在最新主干核实完整 SHA、执行项目验证与 dry-run，通过后按项目入口合并并完成后置检查。已完成步骤不重复。',
    '本条授权本任务范围内的实现与合并；用户限制、项目独立审查或额外审批要求仍须满足，自测不冒充独立审查。',
    `在 ${record} 更新项目位置、分支、完整 SHA、实际验证命令及结果、合并结果和风险；UTF-8 保存回读后报告，不改名、不等待派工。阻塞如实记录。`,
    require('./dev-task-view').recordInstruction(meeting),
    HUMAN_REPORT,
  ].join('\n');
}
function appendIndependent(text, prompt = independentPrompt()) {
  let base = String(text || '');
  const start = base.indexOf(SOLO_START), end = base.indexOf(SOLO_END, start);
  if (start >= 0 && end >= start) base = base.slice(0, start).trimEnd() + base.slice(end + SOLO_END.length);
  return [base.trim(), `${SOLO_START}\n${prompt}\n${SOLO_END}`].filter(Boolean).join('\n\n');
}
function appendProjectPrep(text) {
  const base = String(text || '');
  if (base.includes(PROJECT_PREP_PROMPT)) return base;
  return base ? `${base}\n\n${PROJECT_PREP_PROMPT}` : PROJECT_PREP_PROMPT;
}
const enabled = m => !!(m?.groupChat && m.serialWorkflow?.fileFlowVersion === VERSION);
function directory(dataDir, id) {
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(String(id || ''))) throw new Error('无效的群聊任务目录');
  return path.join(dataDir, 'task-docs', id);
}
function spec(phase, round = 0) {
  const name = phase === 'kickoff' ? '开题报告.md' : `${phase === 'build' ? '实现' : '合并'}手册-轮次${round}.md`;
  return { phase, round, key: `${phase}:${round}`, draft: name, completed: `已完成-${name}`,
    ...(phase === 'merge' ? { rework: `需返工-${name}` } : {}) };
}
function fromNames(input) {
  const names = new Set(input);
  const known = [...names].filter(n => /^(?:已完成-)?开题报告\.md$|^(?:已完成-)?实现手册-轮次[1-9]\d*\.md$|^(?:已完成-|需返工-)?合并手册-轮次[1-9]\d*\.md$/.test(n));
  const seen = new Set();
  const fail = (s, error) => ({ ...s, error, label: '文件命名冲突 · 请查看任务目录', files: known, done: false });
  const at = (s, label, done = false) => {
    const extras = known.filter(n => !seen.has(n));
    if (extras.length) return fail(s, `存在未接续的阶段文件：${extras.join('、')}`);
    return { ...s, label, done, files: known, draftExists: names.has(s.draft), error: null };
  };
  let s = spec('kickoff');
  for (;;) {
    const found = [s.draft, s.completed, s.rework].filter(n => n && names.has(n));
    found.forEach(n => seen.add(n));
    if (found.length > 1) return fail(s, `同一阶段只能保留一个状态文件：${found.join('、')}`);
    if (!found.length || found[0] === s.draft) {
      if (!found.length && s.phase === 'kickoff') return at({ phase: 'discuss', key: 'discuss:0', round: 0 }, '讨论 · 尚未开题');
      const label = { kickoff: '开题报告', build: `实现手册 · 第 ${s.round} 轮`, merge: `合并手册 · 第 ${s.round} 轮` }[s.phase];
      return at(s, `${label} · ${found.length ? '未交付' : '待开始'}`);
    }
    if (s.phase === 'kickoff') s = spec('build', 1);
    else if (s.phase === 'build') s = spec('merge', s.round);
    else if (found[0] === s.completed) return at(s, '合并完成', true);
    else s = spec('build', s.round + 1);
  }
}
// Reviews already finished before the current phase; the budget unit.
function completedReviews(s) {
  if (!s) return 0;
  if (s.done) return Number(s.round) || 0;
  return ['build', 'merge'].includes(s.phase) ? Math.max(0, (Number(s.round) || 0) - 1) : 0;
}
function scan(dir) {
  try { return fromNames(fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name)); }
  catch (error) {
    if (error.code === 'ENOENT') return fromNames([]);
    return { phase: 'discuss', key: 'unreadable', round: 0, files: [], done: false, label: '任务目录暂不可读', error: error.message };
  }
}
function isResume(text) {
  return /^(?:继续(?:执行|施工|开工|开题|任务)?|接着做|恢复执行)(?:[。！!\s]*$|[，,：:]\s*[^？?]+$)/u.test(String(text || '').trim());
}
function appendKickoff(text, prompt) {
  let base = String(text || '');
  const start = base.indexOf(PRESET_START), end = base.indexOf(PRESET_END, start);
  if (start >= 0 && end >= start) base = base.slice(0, start).trimEnd() + base.slice(end + PRESET_END.length);
  return [base.trim(), `${PRESET_START}\n${prompt}\n${PRESET_END}`].filter(Boolean).join('\n\n');
}
function common(meeting, dir, members = []) {
  if (isSolo(meeting)) return soloCommon(meeting, dir, members);
  const { author, merger } = roles(meeting, members);
  return [
    '## AI HUB 文件工作流',
    `本群任务目录：${dir}`,
    `工作目录：${meeting.workspace || '按本群项目线索定位并核实真实 Git 根目录'}`,
    currentProjectLocator(meeting),
    `${author.name} 负责开题与实现，${merger.name} 负责独立验证与合并。头像选择只决定消息接收人，不改变已绑定的职责。`,
    '用户发送开题提示词后，授权按开题范围实现，并在独立验证通过后按项目入口合并；用户明确的禁止事项或额外审批条件优先。',
    '遵守项目规范及用户范围；能判断的选择直接采用合理方案，不反复索取已有授权。',
    '普通讨论和进度询问只回答，不据此开始施工。收到明确的开题、阶段派工或继续执行指令才执行对应阶段。',
    '执行前读指定输入并核对阶段文件；已有交付件则核实报告，不重建草稿。否则先创建或接续指定草稿，记录必要进展和证据。',
    '交付时 UTF-8 保存、回读，同目录原子改名；确认目标存在、草稿消失后结束当前阶段。不得自创文件名、跳轮、覆盖交付件或用聊天代替落盘。',
    'Hub 只按文件名接续；输入缺失、状态冲突或客观阻塞保留现状并报告，不伪造完成。用户手动继续仍接续同一任务，不另开分支或重复已完成步骤。',
    `每次自动执行最多 ${REVIEW_LIMIT} 轮独立审查；开题和实现不计轮数，每轮实现都会交给审查。完成提前结束；第 ${REVIEW_LIMIT} 轮审查仍需返工时保留现场并暂停，不自动派下一轮实现。用户点继续后再获得 ${REVIEW_LIMIT} 轮审查额度。`,
    '同轮每位成员收到相同职责说明；只执行自己分工。指定负责人是唯一交接文档写入者，其余协作成员只交付建议，不代写交接文件、不代替负责人实现、独立审查或合并。同轮全部交付后再接续下一阶段。',
    require('./dev-task-view').recordInstruction(meeting),
    HUMAN_REPORT,
  ].filter(Boolean).join('\n');
}
function phasePrompt(meeting, dir, state, members = []) {
  const s = state.phase === 'discuss' ? spec('kickoff') : state;
  const { author, merger } = roles(meeting, members);
  const draft = path.join(dir, s.draft), done = path.join(dir, s.completed);
  const base = [`## ${s.phase === 'merge' ? merger.name : author.name}：执行${{ kickoff: '开题', build: '实现', merge: '合并' }[s.phase]}${s.round ? ` · 第 ${s.round} 轮` : ''}`,
    `项目：${meeting.workspace || '先核实真实项目根'}`, currentProjectLocator(meeting),
    `先读指定输入并核对阶段文件，再创建或接续草稿：${draft}。已有交付件则核实，不重建或覆盖。`];
  if (s.phase === 'kickoff') base.push(
    '依据用户这条消息和此前讨论，先核实项目位置、阅读项目 AGENTS.md 和 .agents/project.json，写自包含开题报告。',
    '报告包括：目标、范围、推荐方案、可执行验收、风险与回退、项目绝对路径及工作入口；记录你采用的合理假设。',
    '本阶段仅写开题文件，不改业务代码、不建 worktree、不提交、不推送。已有完成报告则不重写。交付后自动开工。');
  if (s.phase === 'build') base.push(
    `阅读 ${path.join(dir, '已完成-开题报告.md')}、项目 .agents/AUTHOR.md 及用户后续补充。`,
    s.round > 1 ? `阅读 ${path.join(dir, spec('merge', s.round - 1).rework)}，优先修复其中具体阻断项，保留此前成果。` : '按开题范围开始实现。',
    '在独立 worktree 实现并完成必要测试，形成可审查提交；不得改写生产工作目录或混入别人的改动。',
    '手册写明项目根、worktree、分支、完整提交 SHA、实际执行的验证命令/结果和残余风险。GUI 改动需真实隔离 GUI 证据。',
    `只有可交给 ${merger.name} 独立审查时才交付；不自行合并。`);
  if (s.phase === 'merge') base.push(
    `阅读 ${path.join(dir, '已完成-开题报告.md')}、${path.join(dir, spec('build', s.round).completed)}、项目 .agents/MERGER.md 和 .agents/project.json。`,
    `独立核实分支和完整 SHA，不采信 ${author.name} 的自报通过，不代修实现。亲自执行项目 dry-run 和必要验证；使用隔离环境，不触碰运行中的生产服务。`,
    '针对最新主干核验集成；只有真实冲突或测试失败才要求返工，主干单纯前移不构成返工理由。',
    `有真实代码或验收缺陷：写清证据和修复要求，将 ${draft} 以 UTF-8 保存、回读后同目录原子改名为 ${path.join(dir, s.rework)}，确认目标存在、草稿消失后结束，由 Hub 派 ${author.name} 返工。`,
    '验证通过且本任务已有合并授权时，按项目规定入口合并被验证的完整 SHA，并完成规定的合并后检查。项目既有人工审批或远端发布要求仍须满足，不从“无 ASK”推导新的权限。',
    '先核查该提交是否已合并；中断发生在 Git 成功后时只补剩余检查和记录，不重复合并或升版本。',
    '只有真实合并及要求的后置操作成功才用“已完成”改名。环境、权限、审批或工具失败保留草稿并说明，不把它伪装成实现缺陷或成功。');
  base.push(`达到本阶段成功交付条件后，将 ${draft} 以 UTF-8 保存、回读，同目录原子改名为 ${done}；确认目标存在、草稿消失后结束本阶段，由 Hub 接续。不得覆盖交付件；输入缺失、状态冲突或客观阻塞则保留现状并说明。`,
    '用大白话简短汇报交付结果、文件位置和遗留问题；复杂内容必要时制作 HTML。');
  const stage = meeting.serialWorkflow?.fileStages?.find(r => r.phase === s.phase);
  if (stage) base.push(`本轮参与者：${stage.members.map(id => members.find(m => m.memberId === id)?.displayName || id).join('、')}。唯一文件交付负责人：${s.phase === 'merge' ? merger.name : author.name}。`, '本轮共享 Prompt（补充要求不取消以上文件交付条件）：', stage.prompt);
  return base.filter(Boolean).join('\n');
}
module.exports = { VERSION, REVIEW_LIMIT, completedReviews, enabled, directory, spec, fromNames, scan, isResume, appendKickoff, appendProjectPrep, PRESET_START, PRESET_END, common, phasePrompt,
  PROJECT_PREP_PROMPT, isSolo, soloCommon, independentPrompt, appendIndependent, SOLO_START, SOLO_END,
  PROMPT_VERSION, HUMAN_REPORT, roles, protocolKey };
