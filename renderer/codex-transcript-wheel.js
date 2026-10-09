'use strict';

// Fullscreen Codex routes wheel reports by terminal cell. In a short viewport
// its Working/status/composer region can occupy the screen's center. Reports
// there are valid mouse input but do not scroll the transcript.
function transcriptWheelTarget(terminal, event) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !event.deltaY) return null;
  const buffer = terminal.buffer.active;
  if (buffer.type !== 'alternate' || terminal.rows < 6) return null;
  const lines = Array.from({ length: terminal.rows }, (_, row) =>
    buffer.getLine(buffer.baseY + row)?.translateToString(true) || '');
  if (!/\? (?:for )?shortcuts\b/.test(lines.at(-1))) return null;
  // Only the ordinary, empty native composer. Preserve menu, approval and
  // draft editing behavior rather than guessing their mouse hit areas.
  let composer = -1;
  for (let row = lines.length - 2; row >= 0; row--) {
    if (/^\s*›/.test(lines[row])) { composer = row; break; }
  }
  if (composer < 4 || !/^\s*›\s*(?:Ask Codex to do anything)?\s*$/.test(lines[composer])) return null;
  let footer = composer - 1;
  for (let row = 1; row < composer; row++) {
    if (/^\s*(?:[^\w\s]\s*)?(?:Working|Thinking|Waiting)\s*\(.*esc to interrupt/.test(lines[row])
        || /^\s*(?:New activity\s*·|↓)\s*.*Back to bottom/.test(lines[row])) {
      footer = Math.min(footer, row - 1);
    }
  }
  if (footer < 3) return null;
  const screen = terminal.element?.querySelector('.xterm-screen');
  const rect = screen?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const cellHeight = rect.height / terminal.rows;
  const row = Math.floor((event.clientY - rect.top) / cellHeight);
  if (row > 0 && row < footer) return null;
  return { clientX: rect.left + rect.width / 2, clientY: rect.top + cellHeight * 1.5 };
}

function createCodexTranscriptWheelRouter({ terminal, ownsTranscript, WheelEvent }) {
  const forwarded = new WeakSet();
  return event => {
    if (forwarded.has(event) || !ownsTranscript()) return false;
    const target = transcriptWheelTarget(terminal, event);
    const viewport = terminal.element?.querySelector('.xterm-viewport');
    if (!target || !viewport) return false;
    const redirected = new WheelEvent('wheel', {
      bubbles: true, cancelable: true, ...target,
      deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
    });
    forwarded.add(redirected);
    viewport.dispatchEvent(redirected);
    event.preventDefault();
    return true;
  };
}

module.exports = { transcriptWheelTarget, createCodexTranscriptWheelRouter };
