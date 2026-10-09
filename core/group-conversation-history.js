'use strict';
const {captureConversationMessages}=require('./conversation-capture');
// The content collector outlives a dispatch watcher: a file handoff may end
// that watcher while its original App Server turn continues producing items.
function createGroupConversationCollector() {
  const seen=new WeakMap();
  return function collect({native,claude,event,orch,sid}) {
    if (claude) {
      const { claudeDisplayMessages } = require('./claude-native-transcript');
      const records = event?.clientSubmissionId ? [claude.records.get(event.clientSubmissionId)]
        : [...claude.records.values()].filter(r => r.userMessageId === event?.userMessageId);
      let changed = false;
      for (const record of records.filter(Boolean)) {
        const attempt = orch.state.attempts?.[record.submissionId];
        if (!attempt || attempt.sid !== sid || (attempt.userMessageId && attempt.userMessageId !== record.userMessageId)) continue;
        changed = orch.recordDisplayMessages(record.submissionId, claudeDisplayMessages(record)) || changed;
      }
      return changed;
    }
    const attempts=Object.values(orch.state.attempts || {}).filter(a=>a.sid===sid && !a.supplementAliasOf
      && a.providerThreadId===native.threadId && a.providerTurnId);
    const signature=`${native.contentRevision}:${native.runtime.revision}:${attempts.length}`;
    if(seen.get(native)===signature)return false;
    let changed=false;
    for(const a of attempts) {
      const stored=orch.state.displayMessagesByAttempt?.[a.attemptId];
      if(a.providerTurnId!==native.runtime.turnId && stored?.some(m=>m.phase==='final_answer'))continue;
      const messages=captureConversationMessages({native,providerTurnId:a.providerTurnId,clientSubmissionId:a.attemptId});
      changed=orch.recordDisplayMessages(a.attemptId,messages) || changed;
    }
    seen.set(native,signature);
    return changed;
  };
}
module.exports={createGroupConversationCollector};
