'use strict';
// A steer can share its original request's provider turn. Suppress only the
// temporary/canonical mirror; never remove actual provider message records.
function matches(messages, candidate, attempts={}) {
  if(!candidate?.sid || !candidate.content)return false;
  const turn=candidate.providerTurnId || attempts?.[candidate.attemptId]?.providerTurnId;
  return (messages || []).some(m=>m?.sourceMessage && m.phase==='final'
    && m.sid===candidate.sid && m.content===candidate.content
    && (!turn || !m.providerTurnId || turn===m.providerTurnId)
    && ((candidate.attemptId && m.attemptId===candidate.attemptId)
      || (turn && m.providerTurnId===turn)));
}
module.exports={matches};
