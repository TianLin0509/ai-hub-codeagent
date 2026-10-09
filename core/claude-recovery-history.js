'use strict';
const fs = require('node:fs');

// Inspect exact native identity after the old writer has exited. Receipt/history
// evidence is not a completion signal and must never advance a workflow.
async function inspect(session, records) {
  const file = session.historyPath();
  const evidence = new Map(records.map(r => [r.userMessageId, file ? 'not-found' : 'history-missing']));
  if (!file || !records.length) return evidence;
  const expected = new Map(records.filter(r => !r.nativeActivity).map(r => [r.userMessageId, r]));
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const inspectLine = line => {
    if (!line.trim()) return;
    const row = JSON.parse(line);
    const record = expected.get(row.uuid);
    if (!record || row.type !== 'user') return;
    if ((row.sessionId && row.sessionId !== session.sessionId)
        || (row.session_id && row.session_id !== session.sessionId)
        || !session.echoMatches(row, { ...record, fingerprint: record.promptFingerprint })) throw new Error('原生历史与旧消息身份不一致，未发送');
    evidence.set(row.uuid, 'received');
  };
  let pending = '';
  try {
    // Iterate the stream itself so read/open errors reject this operation.
    // readline's iterator does not forward errors from its input stream.
    for await (const chunk of input) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        inspectLine(pending.slice(0, end)); pending = pending.slice(end + 1);
      }
    }
    inspectLine(pending);
  } finally { input.destroy(); }
  return evidence;
}
module.exports = { inspect };
