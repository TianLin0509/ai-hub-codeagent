'use strict';
// 派发时给成员的群规补充（编排员守则 / 成员说明）。只读账本里的角色，不改任何状态。
const Store = require('./store');
const Prompt = require('./prompt');

function enabled(meeting) { return !!(meeting && meeting.groupChat && meeting.orchestration && meeting.orchestration.enabled === true); }
function rulesFor(dataDir, meeting, memberId) {
  if (!enabled(meeting) || !memberId) return '';
  const o = meeting.orchestration;
  const index = (meeting.slotSpecs || []).findIndex((s, i) => (s.memberId || `m${i + 1}`) === memberId);
  const sid = meeting.subSessions?.[index];
  const command = sid ? require('./connection').commandFile(dataDir, sid) : '';
  const communication = command ? `\n## 群内通信入口\n可直接使用已挂载的 orch_* 工具；也可把参数写入 UTF-8 JSON 文件，用本机终端调用：\nPowerShell：& '${command.replace(/'/g, "''")}' --tool orch_status --args-file '<参数文件路径>'\n先用空对象 {} 调用 orch_status 获取真实成员编号。工具清单：& '${command.replace(/'/g, "''")}' --list\n发消息：orch_send_message，参数 {"to":"成员编号","message":"正文"}；申请成员交流：orch_request_peer，参数 {"memberId":"成员编号","reason":"原因"}。身份由 Hub 绑定，你只需指定收件人。\n` : '';
  if (o.memberId === memberId) {
    let ledgerFile = '';
    try { ledgerFile = Store.files(dataDir, meeting.id).md; } catch {}
    return Prompt.orchestratorBlock({ settings: o.settings || {}, ledgerFile }) + communication;
  }
  let role = '';
  try { role = Store.load(dataDir, meeting.id)?.roles?.[memberId]?.role || ''; } catch {}
  return Prompt.memberBlock({ role }) + communication;
}
module.exports = { enabled, rulesFor };
