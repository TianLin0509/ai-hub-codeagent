'use strict';
const fs = require('node:fs');

// The stdout echo (--replay-user-messages) is not a receipt signal: Claude Code
// replays the user frame only when the model starts streaming. On 2026-09-24
// the API answered 529 Overloaded for minutes, so a prompt the engine had
// written to its own transcript 27 ms after the write went unconfirmed for
// over two minutes; the Hub declared it unknown, then killed the writer
// mid-retry when the next prompt was sent.
//
// The transcript row is written the moment the engine dequeues the input, under
// the exact UUID the Hub chose, so it is the receipt. This reads only the tail:
// the pending input is the last user row, followed at most by attachments and
// retry notes. A row larger than the window reads as not-found, which keeps the
// old behaviour (wait for the echo) instead of guessing.
const TAIL_BYTES = 8 * 1024 * 1024;

// 'received' | 'not-found' | 'history-missing' | 'mismatch'
async function probeSubmissionReceipt(file, { sessionId, userMessageId, matches }, { tailBytes = TAIL_BYTES } = {}) {
  if (!file) return 'history-missing';
  let handle;
  try { handle = await fs.promises.open(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return 'history-missing'; throw error; }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
    // Search bytes, decode only matching lines: this runs on Electron's main
    // thread for every send, and decoding megabytes of history there stutters.
    const needle = Buffer.from(userMessageId);
    const firstLine = start > 0 ? buffer.indexOf(10) + 1 : 0; // a cut line is not evidence
    if (start > 0 && firstLine === 0) return 'not-found';
    let verdict = 'not-found';
    for (let at = buffer.indexOf(needle, firstLine); at >= 0;) {
      const lineStart = buffer.lastIndexOf(10, at) + 1;
      const newline = buffer.indexOf(10, at);
      const lineEnd = newline < 0 ? buffer.length : newline;
      let row = null;
      try { row = JSON.parse(buffer.toString('utf8', Math.max(lineStart, firstLine), lineEnd)); } catch {}
      if (row?.type === 'user' && row.uuid === userMessageId) {
        if ((row.sessionId && row.sessionId !== sessionId) || !matches(row)) return 'mismatch';
        verdict = 'received';
      }
      at = newline < 0 ? -1 : buffer.indexOf(needle, lineEnd + 1);
    }
    return verdict;
  } finally { await handle.close(); }
}

module.exports = { probeSubmissionReceipt, TAIL_BYTES };
