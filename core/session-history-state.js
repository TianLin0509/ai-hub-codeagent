'use strict';

// PTY startup output and welcome suggestions are not submitted user prompts.
function hasSubmittedPrompt(session) {
  return [session?.runStartedAt, session?.lastRunStartedAt,
    session?._attentionClock?.lastPromptAt].some(at => Number(at) > 0);
}

// Capture the user's launch intent before provider launchers allocate native IDs.
function isFreshLaunch(kind, opts = {}) {
  return !String(kind || '').endsWith('-resume') && ![
    'useResume', 'useContinue', 'resumePicker', 'codexResumePicker', 'kimiResumePicker',
    'resumeCCSessionId', 'forkCCSessionId', 'codexSid', 'codexForkSid',
    'geminiChatId', 'kimiSid', 'kimiSessionDir', 'acpSid',
    'resumeTranscriptPath', 'transcriptPath', 'branchSourceSessionId',
  ].some(key => opts[key]);
}

function isFreshSession(session, { allowMissingTranscript = false } = {}) {
  if (!session || hasSubmittedPrompt(session) || session.freshLaunch === false
      || session.codexAllowMtimeFallback || String(session.kind || '').endsWith('-resume')
      || session.branchSourceSessionId) return false;
  if (session.transcriptPath && !(allowMissingTranscript && session.freshLaunch === true)) return false;
  // A preallocated identity alone is not conversation history. Older records
  // without explicit launch intent retain the conservative identity check.
  return session.freshLaunch === true || ![
    session.codexSid, session.ccSessionId, session.geminiChatId, session.kimiSid, session.kimiSessionDir, session.acpSid,
  ].some(Boolean);
}

// Claude does not create a fork's own JSONL until its first prompt. A parent
// identity is context, not proof that the child has already produced history.
// Never hide a missing file that was previously bound or a submitted turn.
function isUnsubmittedBranch(session) {
  return !!session?.branchSourceSessionId && !session.transcriptPath
    && !hasSubmittedPrompt(session) && !Number(session.lastCompletedAt);
}

module.exports = { hasSubmittedPrompt, isFreshSession, isFreshLaunch, isUnsubmittedBranch };
