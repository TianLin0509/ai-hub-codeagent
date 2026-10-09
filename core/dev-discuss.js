/* 开发场景 · 「先讨论，再开工」阶段。
 *
 * 用户的痛点：开发群聊一建好就得给工作位一个明确任务，可有时任务本身就是要先讨论的。
 * 以前只能先开一个普通 session 聊清楚再把结论复述进开发群聊 —— 复述是有损的，
 * 合并位也看不到「为什么这么定」的取舍。
 *
 * 做法不是加第三个场景，而是让同一个开发群聊有两个阶段：
 *   discuss（讨论）：走普通群聊路径，工作位提方案、合并位挑刺，谁都不许改代码；
 *   build（开工）：现在这条「工作位实现 ↔ 合并位审查」的循环。
 * 两个阶段发给的是同一组会话，所以讨论上下文天然带进实现，不需要任何交接。
 *
 * 阶段字段放在 meeting.serialWorkflow.devPhase 里（和 devWorkbenchManual 同层）：
 * meeting-store 只持久化白名单字段，serialWorkflow 整个对象在白名单里，塞顶层会在重启后丢。
 *
 * 讨论提示词逐轮追加在 prompt 末尾，不能塞进 systemPrompt ——
 * 后者只在成员首次进群时发一次，群聊从开工切回讨论时就没机会再告诉它「现在别改代码」。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') window.DevDiscuss = api;
}(this, function () {
  'use strict';

  const PHASE_DISCUSS = 'discuss';
  const PHASE_BUILD = 'build';
  const PHASE_KICKOFF = 'kickoff';

  const TASK_SPEC_HEADING = '## 任务说明';

  // 用户点「收敛」时发给全群的固定文本。工作位按这个格式产出，「开工」弹窗才能把它捞出来预填。
  const CONVERGE_REQUEST = [
    '请把到目前为止的讨论收敛成一份任务说明，由工作位执笔，合并位只补充遗漏或指出仍有分歧的点。',
    `工作位的回复以「${TASK_SPEC_HEADING}」单独成行开头，正文按四项写：目标 / 非目标 / 验收标准 / 风险与回退。`,
    '任务说明要自包含：一个没看过本群讨论的人只读它就能动手。仍有分歧就写进「待拍板」一项，不要替我拍板。',
  ].join('\n');

  const DISCUSS_MARKER = '## 讨论阶段（本轮不改代码）';

  function phaseOf(serialWorkflow) {
    const sw = serialWorkflow && typeof serialWorkflow === 'object' ? serialWorkflow : null;
    if (!sw) return PHASE_BUILD;
    if (sw.devPhase === PHASE_DISCUSS) return PHASE_DISCUSS;
    // 开题：讨论收口，指定的那一位在写任务书。循环在这个阶段同样不许起。
    if (sw.devPhase === PHASE_KICKOFF) return PHASE_KICKOFF;
    return PHASE_BUILD;
  }

  function isDiscussing(meeting) {
    return !!(meeting && meeting.scene === 'dev' && meeting.groupChat && phaseOf(meeting.serialWorkflow) === PHASE_DISCUSS);
  }

  // 席位角色按工作流步骤的位置约定：第一步是工作位，第二步是合并位（dev-task 模板写死这个顺序）。
  function devRoleOf(serialWorkflow, memberId) {
    const sw = serialWorkflow && typeof serialWorkflow === 'object' ? serialWorkflow : null;
    const steps = sw && Array.isArray(sw.steps) ? sw.steps : [];
    const id = String(memberId || '');
    if (!id) return '';
    const has = (step) => Array.isArray(step) && step.map(String).includes(id);
    if (has(steps[0])) return 'worker';
    if (has(steps[1])) return 'merger';
    return '';
  }

  const ROLE_LINES = {
    worker: [
      '你是本群的工作位，讨论阶段你当「方案提出者」：先读本仓库 .agents/AUTHOR.md 了解开工后要遵守的合同，',
      '再基于仓库现状给出具体方案、改动范围和验收方式。方案要能被反驳，所以写清楚取舍。',
    ].join(''),
    merger: [
      '你是本群的合并位，讨论阶段你当「审视与反证者」：先读本仓库 .agents/MERGER.md 了解开工后你要怎么审，',
      '再专门找方案里会让审查过不去的地方 —— 范围蔓延、验收标准不可验证、回退困难、与现有约束冲突。不要迎合工作位。',
    ].join(''),
  };

  /**
   * 讨论阶段逐轮追加在 prompt 末尾的一段。
   * role 为空（成员不在工作流两步里）时只给通用约束。locator 是建群时的「先定位项目根」说明，
   * 开在工作根时才有 —— 讨论阶段读合同同样需要先知道仓库在哪。
   */
  function buildDiscussBlock(opts = {}) {
    const role = String(opts.role || '');
    const locator = String(opts.locator || '').trim();
    const lines = [DISCUSS_MARKER];
    if (locator) lines.push(locator, '');
    lines.push(
      '本群是开发群聊，现在处于讨论阶段：目标是把需求聊清楚，而不是动手实现。',
      '本轮禁止修改仓库里的任何文件、禁止建 worktree、禁止提交或推送；可以读代码、跑只读命令来核实事实。',
    );
    if (ROLE_LINES[role]) lines.push(ROLE_LINES[role]);
    lines.push(
      '讨论要往「目标 / 非目标 / 验收标准 / 风险与回退」四项收敛；已经有共识的不要反复重述，只说新增的分歧或证据。',
      `维护者说「收敛」时，工作位以「${TASK_SPEC_HEADING}」单独成行开头输出一份自包含的任务说明；维护者点「开工」后才进入实现流程。`,
    );
    return lines.join('\n');
  }

  function appendDiscussBlock(basePrompt, block) {
    const base = String(basePrompt || '').trim();
    const extra = String(block || '').trim();
    if (!extra) return base;
    return base ? `${base}\n\n${extra}` : extra;
  }

  /** dispatcher 用：这个成员这一轮该不该带讨论块。不在讨论阶段就返回空串。 */
  function discussBlockFor(meeting, memberId) {
    if (!isDiscussing(meeting)) return '';
    const sw = meeting.serialWorkflow || {};
    return buildDiscussBlock({
      role: devRoleOf(sw, memberId),
      locator: typeof require === 'function' ? require('./prepared-project-registry').projectLocator(meeting) : '',
    });
  }

  /**
   * 开题阶段：讨论已经收尾，由**一位**指定执笔者把需求写成任务书。
   * 和讨论阶段的区别只有两条：只派一个人（避免两人写重），且写完要改名交付。
   * 循环在这个阶段照样不许起 —— 任务书还没接收，开工就是绕过它。
   */
  function isKickingOff(meeting) {
    return !!(meeting && meeting.scene === 'dev' && meeting.groupChat
      && phaseOf(meeting.serialWorkflow) === PHASE_KICKOFF);
  }

  /** 开题任务的正文。文档路径由调用方用 dev-task-docs 的 buildDocBlock 追加。 */
  function buildKickoffPrompt(opts = {}) {
    const locator = String(opts.locator || '').trim();
    const lines = ['## 开题：把需求写成一份自包含的任务书'];
    if (locator) lines.push(locator, '');
    lines.push(
      '本群的讨论到此收口，由你执笔写任务书；另一位不写，避免两人写重。',
      '依据是本群到目前为止的讨论和维护者的要求；先读本仓库 .agents/ 下的合同了解开工后的规矩。',
      '任务书必须自包含 —— 一个没看过本群讨论的人只读它就能动手。至少写清四项：',
      '目标（要解决什么、用户能看到什么变化）／非目标（本任务明确不做什么）／',
      '验收标准（可执行的步骤、通过条件、关键异常情况）／风险与回退（风险、保留哪些成果、怎么退回去）。',
      '另外写上你核实过的项目定位和必要的工作入口，其中**项目根必须单独成一行**，格式就写：',
      '项目根：<绝对路径>',
      'Hub 会读这一行，把本群后续所有步骤都绑到这个已核实的现场 —— 实现位和审查位从此用同一个路径，不各自再猜一遍。',
      '有会改变范围或验收的未决问题，先写一条 ASK: 问维护者，不要替他拍板，也不要把没写完的报告当成完成。',
      '本阶段只写任务书：不改代码、不建 worktree、不提交、不推送；可以读代码和跑只读命令来核实事实。',
      '报告被接收后会自动进入实现阶段，不需要维护者再确认一次。',
    );
    return lines.join('\n');
  }

  /** 从一条 AI 回复里抠出任务说明（从「## 任务说明」那一行起到结尾）。没有就返回空串。 */
  function extractTaskSpec(text) {
    const s = String(text == null ? '' : text);
    const re = /(?:^|\n)[ \t]*##[ \t]*任务说明[ \t]*(?:\r?\n|$)/;
    const m = re.exec(s);
    if (!m) return '';
    return s.slice(m.index).trim();
  }

  /** 群聊消息列表（新在后）里最近一份任务说明。给「开工」弹窗预填用。 */
  function latestTaskSpec(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!m || (m.role && m.role !== 'assistant')) continue;
      const spec = extractTaskSpec(m.content || m.text || '');
      if (spec) return spec;
    }
    return '';
  }

  return {
    PHASE_DISCUSS,
    PHASE_BUILD,
    PHASE_KICKOFF,
    isKickingOff,
    buildKickoffPrompt,
    TASK_SPEC_HEADING,
    CONVERGE_REQUEST,
    DISCUSS_MARKER,
    phaseOf,
    isDiscussing,
    devRoleOf,
    buildDiscussBlock,
    appendDiscussBlock,
    discussBlockFor,
    extractTaskSpec,
    latestTaskSpec,
  };
}));
