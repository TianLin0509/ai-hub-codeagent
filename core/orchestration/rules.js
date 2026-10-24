'use strict';
// 派发时给成员的群规补充（负责人守则 / 成员说明）。只读账本里的角色，不改任何状态（项目档案缺失时只建模板）。
const Store = require('./store');
const Prompt = require('./prompt');
const Brief = require('./brief');

function enabled(meeting) { return !!(meeting && meeting.groupChat && meeting.orchestration && meeting.orchestration.enabled === true); }
function rulesFor(dataDir, meeting, memberId) {
  if (!enabled(meeting) || !memberId) return '';
  const o = meeting.orchestration;
  const index = (meeting.slotSpecs || []).findIndex((s, i) => (s.memberId || `m${i + 1}`) === memberId);
  const sid = meeting.subSessions?.[index];
  const command = sid ? require('./connection').commandFile(dataDir, sid) : '';
  const lead = o.memberId === memberId;
  const usage = lead
    ? '发消息：orch_send_message，参数 {"to":"成员编号","message":"正文","interrupt":false}（interrupt=true 追加到对方正在进行的工作里）；开放成员交流：orch_allow_peer，参数 {"memberA":"编号","memberB":"编号","allow":true,"reason":"原因"}。'
    : '发消息：orch_send_message，参数 {"to":"成员编号","message":"正文","wake":true}（wake=false 只留言、不叫醒负责人）；申请成员交流：orch_request_peer，参数 {"memberId":"成员编号","reason":"原因"}。';
  // 2026-10-23 真实 Haiku 实测：Claude Code 按需加载 MCP 工具，负责人只加载了常用 3 个，结项工具从未加载、无法调用。
  const tools = lead ? ['orch_status', 'orch_propose_plan', 'orch_send_message', 'orch_allow_peer', 'orch_decide_peer', 'orch_start_workflow', 'orch_control_workflow', 'orch_restart_member', 'orch_report']
    : ['orch_status', 'orch_send_message', 'orch_request_peer'];
  const preload = `工具需要先加载（ToolSearch）时，一次加载全部：select:${tools.map(t => 'mcp__hub_orchestrator__' + t).join(',')}。`;
  const communication = command ? `\n## 群内通信入口\n${preload}可直接使用已挂载的 orch_* 工具；也可把参数写入 UTF-8 JSON 文件，用本机终端调用：\nPowerShell：& '${command.replace(/'/g, "''")}' --tool orch_status --args-file '<参数文件路径>'\n先用空对象 {} 调用 orch_status 获取真实成员编号。工具清单：& '${command.replace(/'/g, "''")}' --list\n${usage}身份由 Hub 绑定，你只需指定收件人。\n` : '';
  const briefFile = Brief.ensureBrief(dataDir, meeting);
  if (lead) {
    let ledgerFile = '';
    try { ledgerFile = Store.files(dataDir, meeting.id).md; } catch {}
    return Prompt.orchestratorBlock({ settings: o.settings || {}, ledgerFile, briefFile }) + communication;
  }
  let role = '';
  try { role = Store.load(dataDir, meeting.id)?.roles?.[memberId]?.role || ''; } catch {}
  return Prompt.memberBlock({ role, briefFile }) + communication;
}
module.exports = { enabled, rulesFor };
