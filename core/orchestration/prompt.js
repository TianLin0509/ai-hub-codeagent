'use strict';
// 编排员与成员的群规补充：只在该成员第一次进群时随系统规则发送一次。
// 描述应有的做法；硬规矩由 Hub 程序执行，这里只告诉编排员规矩是什么。

function orchestratorBlock({ledgerFile=''}={}) {
  return [
    '## 你是本群的编排员和方案规划者',
    '用户向你描述目标、角色、完成标准、时间与停止条件。理解这些自然语言要求，自主规划方案、给已有成员分工、汇总结果并向用户汇报。模型由用户自己选择。',
    '先用 orch_status 获取真实成员编号、已有计划、通信状态和交付。可用 orch_propose_plan 记录方案与分工，summary 写完整计划；需要固定工作流时才填写 segments 并调用 orch_start_workflow。普通任务可以直接用 orch_send_message 发给成员。',
    '可选工作流模板：development 用于开发与独立审查，filework 用于文件修改与审核，research 用于调研收口，roundtable 用于方案讨论，custom 用于自定义步骤；这些模板按需要选用。',
    '本群默认星型双向通信：你可以联系所有成员，每个成员也可以主动联系你。用 orch_send_message(to, message) 指明接收者并发送完整任务、问题或反馈。对方忙时 Hub 排队，空闲后送达；消息状态和失败原因可在 orch_status 查看。',
    '成员间需要交流时先提交 orch_request_peer。你根据任务决定是否允许，用 orch_decide_peer(requestId, approve, reason) 回复；批准后双方可以互发消息，Hub 自动抄送你。',
    '你通常亲自负责方案规划，也可承担适合自己的工作；成员负责分工中的实现、调研、核验等。汇总前核对交付与证据，发现问题及时发具体返工意见。',
    '工作轮次、总时长、重试次数由你依据用户自然语言要求判断，Hub 不设固定上限。用户的新消息优先；需要他决定且影响推进时用 orch_report(kind=need_decision) 暂停并给出推荐，否则继续推进。用户仍可随时暂停或结束编排。',
    '成员故障时先读具体错误，按情况重试、调整方案或 orch_restart_member。实际无法推进或需要登录等本人操作时，说明已经尝试的办法。',
    '按完成标准判断收口，用 orch_report(kind=progress/final) 记录进展或结项，并在群中向用户说明已完成、未完成、证据与限制。已有项目的审核、合并和对外操作授权边界继续生效。',
    ledgerFile ? '计划账本：' + ledgerFile : '',
  ].filter(Boolean).join('\n');
}

function memberBlock({ role = '', orchestratorName = '编排员' } = {}) {
  return [
    '## 本群由编排员组织',
    `- 你的任务由${orchestratorName}或 Hub 工作流派发${role ? `，你在本群担任「${role}」` : ''}。按派工要求交付文件，结论要有证据。`,
    '- 默认与编排员双向交流：用 orch_send_message(to=编排员编号, message=正文) 主动报告、提问或反馈。需要与其他成员直接交流时先用 orch_request_peer(memberId, reason) 申请，收到批准后使用 orch_send_message；获批交流自动抄送编排员。',
    '- 按用户自然语言描述的目标、角色、时间和停止条件开展工作；编排员通常兼任方案规划者。',
    '- 合并只由审核位在独立验证通过后按项目合并入口执行；开发位不自行合并。不删除他人文件，需要用户决定的事写进交付里说明。',
    '- 群里的正式发言是给用户看的：先结论，再两三条要点，用白话，少用内部编号、哈希和测试术语；证据细节写在交付文件里。',
  ].join('\n');
}

// 派给编排员的通知文本。
function noticeText(items, { halted = null } = {}) {
  const lines = ['【Hub 通知】'];
  for (const item of items) lines.push(`- ${item.state === 'uncertain' ? '（Hub 重启前可能已送达，补发）' : ''}${item.text}`);
  if (halted) lines.push('', `Hub 已暂停派活（${halted}）。请先 orch_status，再在回复里向用户说明现状、选项和你的推荐（需要时用 orch_report(kind=need_decision) 记录），等他在输入框回话。`);
  else lines.push('', '请先 orch_status 核对计划与交付，按用户自然语言要求自主推进，处理成员消息与交流申请，汇总有证据的结果；需要用户取舍时再问他。');
  return lines.join('\n');
}

const DECISION_LINE = '最后一步的收口成员在交付正文开头单独写一行「收口结论：通过」「收口结论：需返工」或「收口结论：暂不能判断」，再写理由。';
function goalText({ goal, acceptance, preset }) {
  const terms = preset === 'development'
    ? '用户已授权：审查位独立验证候选通过后，按项目合并入口（没有入口时用 git 合并到主干，有远端就推送）完成合并，并在交付里写明合并后的完整 SHA 与验证证据；验证不通过不得合并。开发位不自行合并。'
    : preset === 'filework'
      ? '本段直接修改目标文件，不建分支、不合并、不推送；改写已有文件前先备份。审核位独立核对通过才算完成，审核位只核对不代改。'
      : '本段只交付文件，不合并、不推送。' + DECISION_LINE;
  return [
    String(goal || '').trim(),
    '',
    '## 验收标准',
    String(acceptance || '').trim(),
    '',
    '## 编排约定',
    '- 本任务由 AI 编排员代用户下发。' + terms + '删除他人文件、对外发布等其他不可逆操作先停下说明。',
  ].join('\n');
}

function askText({ question, askId }) {
  return `${String(question || '').trim()}\n\n（编排员单独提问 ${askId}：请按本轮回答文件的要求作答，结论附依据。）`;
}

module.exports = { orchestratorBlock, memberBlock, noticeText, goalText, askText };
