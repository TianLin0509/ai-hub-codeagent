'use strict';

// Capture stable session identities, never infer recipients from prose.
function selectedSids(meeting) {
  const sids=meeting.subSessions || [];
  const indexes=Array.isArray(meeting.participants)?meeting.participants:sids.map((_,i)=>i);
  return indexes.map(i=>sids[i]).filter(Boolean);
}
function resolveRecipients(meeting, snapshot) {
  const sids=snapshot===undefined?selectedSids(meeting):snapshot;
  if(!Array.isArray(sids) || !sids.length)throw new Error('请先点亮至少一位成员头像');
  if(sids.some(sid=>typeof sid!=='string' || !meeting.subSessions?.includes(sid)))throw new Error('收件成员已变化，请核对头像后重新发送');
  return [...new Set(sids)];
}
function memberIds(meeting, sids) {
  return resolveRecipients(meeting,sids).map(sid=>{
    const i=meeting.subSessions.indexOf(sid);return meeting.slotSpecs?.[i]?.memberId || `m${i+1}`;
  });
}
module.exports={selectedSids,resolveRecipients,memberIds};
