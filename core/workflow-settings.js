'use strict';

// Settings are separate from durable execution checkpoints. Never round-trip
// a renderer snapshot over fileFlow/serialRunState when saving the editor.
const LIMIT = 6;
const PRESETS = [
  { id: 'development', name: '开发交付', minMembers: 2 },
  { id: 'roundtable', name: '方案圆桌', minMembers: 2 },
  { id: 'research', name: '资料调研', minMembers: 2 },
];
const GENERAL = '围绕用户本次目标和约束工作。同轮各成员收到同一份共享 prompt，能看到全部分工，只执行自己的职责。同轮独立完成，下一轮读取已交付的结果；区分事实、推断和未知，不为填满轮次扩展任务。最多执行 6 轮，完成可提前结束，达到上限保留现场并暂停。';
const DEV = [
  { name: '开题', phase: 'kickoff', prompt: '核实项目与合同，写自包含开题报告。本阶段只写开题文件，不改代码、不建 worktree。UTF-8 保存回读、原子改名交付。' },
  { name: '实现与自测', phase: 'build', prompt: '读取开题报告，返工时读取上一轮需返工合并手册。在独立 worktree 实现与自测，交付完整 SHA、验证证据和残余风险。实现位不得自行合并。' },
  { name: '独立审查与合并', phase: 'merge', prompt: '独立核验候选 SHA 与最新主干，亲自验证。真实缺陷交付需返工；环境、权限或审批阻塞保留草稿。已有授权且验证通过后实际合并，后置检查成功才交付已完成。' },
];
const clone = value => JSON.parse(JSON.stringify(value));
function createPreset(id, members) {
  const ids = members.map(m => m.memberId);
  const names = members.map(m => m.title || m.displayName || m.memberId);
  if (!ids.length || (id !== 'custom' && ids.length < 2)) throw new Error('此模板至少需要 2 位 Agent');
  const one = i => [ids[i] || ids[0]];
  const all = ids.slice(0, 3);
  const base = { enabled: true, presetId: id, kind: id === 'development' ? 'file' : 'serial' };
  if (id === 'development') return { ...base, rounds: DEV.map((s, i) => ({ ...s, members: one(i === 2 ? 1 : 0), after: i === 2 ? 'review' : 'next' })) };
  if (id === 'roundtable') return { ...base, rounds: [
    { name: '独立提案', members: all, prompt: '每位成员独立提出一个解决当前问题的方案，说明成立条件、代价和最大风险。不要迎合其他成员，也不要开始实施。', after: 'next' },
    { name: '交叉质疑', members: all, prompt: '阅读上一轮所有提案，找出最可能改变选择的假设、反例和遗漏。只补充有依据的新问题；没有异议可明确说明，不为辩论制造分歧。', after: 'next' },
    { name: '汇总建议', members: one(1), prompt: '综合提案与质疑，给出一个推荐方案、取舍理由、仍不确定的事项及需要用户决定的问题。到此结束，不自动进入实施。', after: 'end' },
  ] };
  if (id === 'research') return { ...base, rounds: [
    { name: '分工查证', members: all, prompt: `${names[0]}：查支持证据；${names[1]}：查最强反证和失败条件；${names[2] ? names[2] + '：查缺失信息与可比性。' : '两位共同记录缺失信息。'}\n围绕用户当前问题核对原始材料（文件、数据、代码或网页），引用外部或时效性信息时标明日期和来源。区分事实、推断与未知，不重复对方的分工。`, after: 'next' },
    { name: '补证核验', members: ids.slice(0, 2), prompt: '只补查前一轮最可能改变结论的争议与缺口。逐项核对原始材料及适用条件，不能核实就保留未知，不无限扩大检索范围。', after: 'next' },
    { name: '形成结论', members: one(1), prompt: '交付结论、关键依据与出处、最强反证、未知项和推荐下一步。证据不足时明确暂不能判断。只交付结论，不自行执行购买、交易、发布、开发或改写正式文件。', after: 'end' },
  ] };
  // 文件修改：非 git 开发的文件改动（文档、记忆、配置等）。审核需返工时退回上一步修改，不合并、不推送。
  if (id === 'filework') return { ...base, rounds: [
    { name: '修改与自查', members: one(0), prompt: '按目标修改指定文件，不改与目标无关的文件。改写已有文件前先备份。交付改动清单（文件路径、改了什么、依据）、备份位置和自查结果。收到需返工时先读上一轮审核意见，逐项修复后重新交付。不合并、不推送。', after: 'next' },
    { name: '独立审核', members: one(1), prompt: '对照目标与验收，独立核对实际文件内容、出处和副作用，不采信自查结论，不代为修改。全部满足交付已交付；有需修复的缺陷交付需返工，逐项写清问题与期望改法；环境或权限阻碍时交付阻塞。', after: 'review' },
  ] };
  if (id !== 'custom') throw new Error('未知工作流模板');
  return { ...base, rounds: [{ name: '第一轮', members: one(0), prompt: '', after: 'end' }] };
}
function fromConfig(config, members) {
  const c = config || {};
  if (c.deliveryVersion === 1) return {enabled:!!c.enabled,kind:c.deliveryKind,presetId:c.settingsPreset || 'custom',rounds:clone(c.deliveryStages)};
  if (c.fileFlowVersion === 2 && !c.soloDevelopment) {
    const fallback = DEV.map((s, i) => ({ ...s, members: [...(c.steps?.[i === 2 ? 1 : 0] || [])], after: i === 2 ? 'review' : 'next' }));
    return { enabled: true, kind: 'file', presetId: 'development', rounds: clone(c.fileStages || fallback) };
  }
  const d = createPreset('custom', members);
  if (Array.isArray(c.steps) && c.steps.length) d.rounds = c.steps.map((s, i) => ({ name: c.stepConfigs?.[i]?.name || `第 ${i + 1} 轮`, prompt: c.stepConfigs?.[i]?.prompt || '', members: [...s], after: c.stepConfigs?.[i]?.after || (i === c.steps.length - 1 ? 'end' : 'next'), ...(c.stepConfigs?.[i]?.timeoutMs ? { timeoutMs: c.stepConfigs[i].timeoutMs } : {}) }));
  d.enabled = !!c.enabled;
  d.presetId = c.settingsPreset || 'custom';
  if (c.loop?.enabled || c.soloDevelopment) d.legacyProtocol = true;
  return d;
}
function validate(d, memberIds) {
  if (d?.legacyProtocol) throw new Error('此群保留旧版执行协议；如需转换，请明确选择一套新模板后保存');
  if (!d || !['file', 'serial'].includes(d.kind)) throw new Error('工作流类型无效');
  if (!Array.isArray(d.rounds) || d.rounds.length < 1 || d.rounds.length > LIMIT) throw new Error('请配置 1–6 轮；已有超长流程请手动调整，不会自动截断');
  d.rounds.forEach((r, i) => {
    if (!Array.isArray(r.members) || r.members.length < 1 || r.members.length > 3 || new Set(r.members).size !== r.members.length) throw new Error(`第 ${i + 1} 轮请选择 1–3 位不同的 Agent`);
    if (r.members.some(id => !memberIds.includes(id))) throw new Error(`第 ${i + 1} 轮有已移除的成员，请重新选择`);
    if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 80) throw new Error(`第 ${i + 1} 轮名称不能为空且不能超过 80 字`);
    if (typeof r.prompt !== 'string' || r.prompt.length > 16000) throw new Error(`第 ${i + 1} 轮共享 prompt 须为文本且不能超过 16000 字（可以留空）`);
    // 串行流程可在最后一轮设审核：需返工退回上一轮。
    const serialReview = d.kind === 'serial' && i > 0 && i === d.rounds.length - 1;
    if (!['next', 'end', ...(d.kind === 'file' || serialReview ? ['review'] : [])].includes(r.after)) throw new Error('轮次接续规则无效');
  });
  if (d.kind === 'file') {
    const [k,b,m] = d.rounds;
    if (d.rounds.length !== 3 || k.phase !== 'kickoff' || b.phase !== 'build' || m.phase !== 'merge' || k.after !== 'next' || b.after !== 'next' || m.after !== 'review') throw new Error('开发文件流须保留开题、实现、独立审查三段接续');
    if (k.members[0] !== b.members[0] || b.members[0] === m.members[0] || k.members.includes(m.members[0]) || b.members.includes(m.members[0]) || m.members.includes(b.members[0])) throw new Error('开题与实现须由同一负责人交付，独立评审负责人不能混入实现阶段');
    if (!d.enabled) throw new Error('开发文件流请使用群聊的停止控制');
  }
  return true;
}
function toConfig(previous, d, memberIds) {
  validate(d, memberIds);
  const c = { ...(previous || {}), schemaVersion: 2, settingsVersion: 1, executionLimit: LIMIT, settingsPreset: d.presetId, enabled: !!d.enabled, loop: { enabled: false } };
  if (d.kind === 'file') {
    c.fileFlowVersion = 2; c.templateId = 'dev-task'; c.mdHandoff = true;
    c.steps = [[d.rounds[0].members[0]], [d.rounds[2].members[0]]];
    c.fileStages = clone(d.rounds);
    c.devPhase = c.devPhase || 'discuss';
    delete c.soloDevelopment;
  } else {
    for (const k of ['fileFlowVersion','fileStages','mdHandoff','soloDevelopment','devPhase','templateId','loopState','serialRunState']) delete c[k];
    c.templateId = d.presetId;
    c.steps = d.rounds.map(r => [...r.members]);
    c.stepConfigs = d.rounds.map(r => ({ name:r.name, prompt:r.prompt, after:r.after, ...(r.timeoutMs ? {timeoutMs:r.timeoutMs} : {}) }));
  }
  return c;
}
function toDeliveryConfig(previous, draft, memberIds) {
  const c=toConfig(previous,draft,memberIds);
  delete c.conversationVersion;
  if(previous?.deliveryVersion!==1 && (previous?.serialRunState || previous?.loopState || previous?.fileFlow)) {
    c.legacyExecution={serialRunState:previous.serialRunState,loopState:previous.loopState,fileFlow:previous.fileFlow};
  }
  for(const key of ['serialRunState','loopState','fileFlow','fileFlowVersion','fileStages','mdHandoff','devPhase']) delete c[key];
  c.deliveryVersion=1;c.deliveryKind=draft.kind;c.deliveryStages=clone(draft.rounds);
  c.steps=draft.rounds.map(r=>[...r.members]);
  c.stepConfigs=draft.rounds.map(r=>({name:r.name,prompt:r.prompt,after:r.after}));
  return c;
}
function usesDelivery(draft) {
  return draft?.kind === 'file' || !!draft?.rounds?.some(r=>r.after === 'review');
}
function toWorkflowConfig(previous, draft, memberIds) {
  if (usesDelivery(draft)) return toDeliveryConfig(previous,draft,memberIds);
  const c=toConfig(previous,draft,memberIds);
  for (const key of ['deliveryVersion','deliveryKind','deliveryStages','taskArmed','fileFlow','taskDocs','kickoff','stopRequested','stopRequestedAt','stopReason']) delete c[key];
  c.conversationVersion=1;
  return c;
}
// New rooms start on the delivery engine directly. extra carries room-level
// fields such as projectLocator / projectLibrary / workRoot.
function createDeliveryConfig(presetId, members, extra = {}) {
  const draft = createPreset(presetId, members);
  return toDeliveryConfig({ ...extra }, draft, members.map(m => m.memberId));
}
module.exports = { LIMIT, PRESETS, GENERAL, DEV, createPreset, fromConfig, validate, toConfig, toDeliveryConfig, toWorkflowConfig, usesDelivery, createDeliveryConfig };
