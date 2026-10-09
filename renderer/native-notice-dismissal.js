'use strict';
// View-only acknowledgement, scoped to the current native turn/connection.
// Never clear runtime errors, answer requests, reconnect or resend a prompt.
const dismissed = new WeakMap();
function identity(session) {
  const r = session?.nativeRuntime || {};
  return JSON.stringify([r.epoch, r.turnId, r.submission?.clientSubmissionId]);
}
function isNativeNoticeDismissed(session, text) {
  const record = session && dismissed.get(session);
  return !!record && record.identity === identity(session) && record.text === text;
}
function dismissNativeNotice(session, text) {
  if (session && text) dismissed.set(session, { identity: identity(session), text });
}
module.exports = { isNativeNoticeDismissed, dismissNativeNotice };
