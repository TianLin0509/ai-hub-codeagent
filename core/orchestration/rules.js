'use strict';
// 派发时给成员的群规补充（编排员守则 / 成员说明）。只读账本里的角色，不改任何状态。
const Store = require('./store');
const Prompt = require('./prompt');

function enabled(meeting) { return !!(meeting && meeting.groupChat && meeting.orchestration && meeting.orchestration.enabled === true); }
function rulesFor(dataDir, meeting, memberId) {
  if (!enabled(meeting) || !memberId) return '';
  const o = meeting.orchestration;
  if (o.memberId === memberId) {
    let ledgerFile = '';
    try { ledgerFile = Store.files(dataDir, meeting.id).md; } catch {}
    return Prompt.orchestratorBlock({ settings: o.settings || {}, ledgerFile });
  }
  let role = '';
  try { role = Store.load(dataDir, meeting.id)?.roles?.[memberId]?.role || ''; } catch {}
  return Prompt.memberBlock({ role });
}
module.exports = { enabled, rulesFor };
