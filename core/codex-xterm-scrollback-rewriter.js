'use strict';

const { stripAnsi } = require('./ansi-utils.js');

// Codex's inline TUI occasionally scrolls a row-1-anchored partial region with
// CSI Ps S. Native terminals commonly move those rows into scrollback, but
// xterm.js deletes them. Once deleted, neither the renderer xterm nor the
// main-process TerminalSnapshot can recover the earlier conversation.
//
// Rewrite only that narrow normal-buffer case into an equivalent full-screen
// scroll. Codex repaints the composer/status rows immediately afterwards, so
// the final viewport stays the same while the displaced history becomes real
// scrollback. See https://github.com/openai/codex/issues/27644.
//
// Windows ConPTY consumes that original VT operation before node-pty sees it.
// For Codex's DEC-2026 synchronized frames it emits an adjacent h/l boundary,
// then serializes the shifted viewport as a repaint from cursor home. In that
// form we compare consecutive full frames, require an exact multi-row shift,
// and prepend the same safe full-screen scroll before forwarding the repaint.

const ESC = '\x1b';
const CSI = `${ESC}[`;
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);
const MAX_CSI_CARRY = 256;
const MAX_CONPTY_FRAME_CARRY = 512 * 1024;
const CONPTY_SYNC_BOUNDARY = `${CSI}?2026h${CSI}?2026l`;
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const CURSOR_HOME = `${CSI}H`;
const CURSOR_HOME_EXPLICIT = `${CSI}1;1H`;

function numericParams(body) {
  if (body === '') return [];
  if (!/^[0-9;]*$/.test(body)) return null;
  return body.split(';').map(part => (part === '' ? null : Number(part)));
}

function suffixPrefixLength(value, token) {
  const max = Math.min(value.length, token.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (token.startsWith(value.slice(-size))) return size;
  }
  return 0;
}

function findLastHome(value, startAt, endAt) {
  const implicitAt = value.lastIndexOf(CURSOR_HOME, endAt);
  const explicitAt = value.lastIndexOf(CURSOR_HOME_EXPLICIT, endAt);
  const index = Math.max(implicitAt, explicitAt);
  if (index < startAt) return null;
  return {
    index,
    length: index === explicitAt ? CURSOR_HOME_EXPLICIT.length : CURSOR_HOME.length,
  };
}

function parseConptyFrame(value, rows) {
  const showAt = value.lastIndexOf(CURSOR_SHOW);
  if (showAt < 0) return null;
  const hideAt = value.lastIndexOf(CURSOR_HIDE, showAt);
  if (hideAt < 0) return null;
  const home = findLastHome(value, hideAt + CURSOR_HIDE.length, showAt);
  if (!home) return null;

  const body = value.slice(home.index + home.length, showAt);
  const plain = stripAnsi(body)
    .replace(/\r\n/g, '\n')
    // ConPTY normally serializes screen rows with CRLF. Treat a lone CR as a
    // row boundary as well; it is safer than joining two independently drawn
    // rows into one comparison key.
    .replace(/\r/g, '\n');
  let lines = plain.split('\n').map(line => line.replace(/\u0000/g, '').trimEnd());
  while (lines.length > 1 && lines.at(-1) === '') lines.pop();
  if (Number.isFinite(rows) && rows > 0 && lines.length >= rows) {
    lines = lines.slice(0, rows);
  }
  return lines;
}

function detectFrameShift(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return 0;
  if (previous.length < 4 || next.length < 4) return 0;

  let best = { shift: 0, matches: 0 };
  const maxShift = Math.min(previous.length - 3, next.length - 1);
  for (let shift = 1; shift <= maxShift; shift += 1) {
    const overlap = Math.min(previous.length - shift, next.length);
    let matches = 0;
    let nonEmptyMatches = 0;
    while (matches < overlap && previous[matches + shift] === next[matches]) {
      if (next[matches].trim()) nonEmptyMatches += 1;
      matches += 1;
    }
    // Three exact leading rows, including at least two non-empty rows, make
    // accidental matches vanishingly unlikely while still covering short TUI
    // viewports. Real Codex history insertions normally match dozens of rows.
    if (matches < 3 || nonEmptyMatches < 2) continue;
    if (!previous.slice(0, shift).some(line => line.trim())) continue;
    if (matches > best.matches) best = { shift, matches };
  }
  return best.shift;
}

class CodexXtermScrollbackRewriter {
  constructor(options = {}) {
    this._csiCarry = '';
    this._alternateScreen = false;
    this._originMode = false;
    this._scrollRegion = null;
    this._conptySerialized = options.conptySerialized === true;
    this._cols = Number.isFinite(Number(options.cols)) ? Math.max(2, Math.floor(Number(options.cols))) : 120;
    this._rows = Number.isFinite(Number(options.rows)) ? Math.max(1, Math.floor(Number(options.rows))) : 30;
    this._conptyCarry = '';
    this._observationBuffer = '';
    this._lastConptyFrame = null;
    this._rewrittenScrolls = 0;
    this._rescuedLines = 0;
    this._observedConptyFrames = 0;
    this._rewrittenConptyFrames = 0;
    this._conptyFailOpenFrames = 0;
  }

  _resetTerminalState() {
    this._alternateScreen = false;
    this._originMode = false;
    this._scrollRegion = null;
    this._lastConptyFrame = null;
    this._observationBuffer = '';
  }

  _trackPrivateMode(body, final) {
    if ((final !== 'h' && final !== 'l') || !body.startsWith('?')) return;
    const modes = body.slice(1).split(';').map(Number).filter(Number.isFinite);
    const enabled = final === 'h';
    if (modes.some(mode => ALT_SCREEN_MODES.has(mode))) {
      this._alternateScreen = enabled;
      this._scrollRegion = null;
      this._lastConptyFrame = null;
      this._observationBuffer = '';
    }
    if (modes.includes(6)) this._originMode = enabled;
  }

  _transformCsi(sequence, body, final) {
    this._trackPrivateMode(body, final);

    if (final === 'p' && body === '!') {
      this._scrollRegion = null;
      this._originMode = false;
      return sequence;
    }

    if (final === 'r' && !body.startsWith('?')) {
      const params = numericParams(body);
      if (!params || params.length === 0) {
        this._scrollRegion = null;
        return sequence;
      }
      const top = params[0] == null || params[0] === 0 ? 1 : params[0];
      const bottom = params[1] == null || params[1] === 0 ? null : params[1];
      this._scrollRegion = Number.isFinite(top) && Number.isFinite(bottom) && bottom >= top
        ? { top, bottom }
        : null;
      return sequence;
    }

    if (final !== 'S' || this._alternateScreen || this._originMode) return sequence;
    const region = this._scrollRegion;
    if (!region || region.top !== 1) return sequence;

    const params = numericParams(body);
    if (!params || params.length > 1) return sequence;
    const requested = params.length === 0 || params[0] == null || params[0] === 0
      ? 1
      : params[0];
    if (!Number.isFinite(requested) || requested < 1) return sequence;

    // Clamp to the actual region height. An untrusted CSI 999 S must not turn
    // into hundreds of blank scrollback rows.
    const amount = Math.min(Math.floor(requested), region.bottom - region.top + 1);
    if (amount < 1) return sequence;

    this._rewrittenScrolls += 1;
    this._rescuedLines += amount;
    this._scrollRegion = null;
    return `${CSI}r${CSI}999;1H${'\n'.repeat(amount)}${CSI}H`;
  }

  _rewriteRegionScrolls(data) {
    const input = this._csiCarry + data;
    this._csiCarry = '';
    let output = '';
    let cursor = 0;

    while (cursor < input.length) {
      const escAt = input.indexOf(ESC, cursor);
      if (escAt < 0) {
        output += input.slice(cursor);
        break;
      }
      output += input.slice(cursor, escAt);
      if (escAt + 1 >= input.length) {
        this._csiCarry = input.slice(escAt);
        break;
      }

      const introducer = input[escAt + 1];
      if (introducer === 'c') {
        output += input.slice(escAt, escAt + 2);
        this._resetTerminalState();
        cursor = escAt + 2;
        continue;
      }
      if (introducer !== '[') {
        output += input.slice(escAt, escAt + 2);
        cursor = escAt + 2;
        continue;
      }

      let finalAt = escAt + 2;
      while (finalAt < input.length) {
        const code = input.charCodeAt(finalAt);
        if (code >= 0x40 && code <= 0x7e) break;
        finalAt += 1;
      }
      if (finalAt >= input.length) {
        const pending = input.slice(escAt);
        if (pending.length <= MAX_CSI_CARRY) {
          this._csiCarry = pending;
        } else {
          // Malformed/unbounded CSI: fail open instead of retaining arbitrary
          // PTY output forever.
          output += pending;
        }
        break;
      }

      const sequence = input.slice(escAt, finalAt + 1);
      const body = input.slice(escAt + 2, finalAt);
      output += this._transformCsi(sequence, body, input[finalAt]);
      cursor = finalAt + 1;
    }

    return output;
  }

  _minimumFrameRows() {
    return Math.max(4, this._rows - 2);
  }

  _observeConptyOutput(data) {
    if (!data) return;
    this._observationBuffer += data;
    if (this._observationBuffer.length > MAX_CONPTY_FRAME_CARRY) {
      this._observationBuffer = this._observationBuffer.slice(-MAX_CONPTY_FRAME_CARRY);
    }

    while (this._observationBuffer) {
      const hideAt = this._observationBuffer.indexOf(CURSOR_HIDE);
      if (hideAt < 0) {
        const held = suffixPrefixLength(this._observationBuffer, CURSOR_HIDE);
        this._observationBuffer = held ? this._observationBuffer.slice(-held) : '';
        return;
      }
      if (hideAt > 0) this._observationBuffer = this._observationBuffer.slice(hideAt);
      const showAt = this._observationBuffer.indexOf(CURSOR_SHOW, CURSOR_HIDE.length);
      if (showAt < 0) return;

      const endAt = showAt + CURSOR_SHOW.length;
      const candidate = this._observationBuffer.slice(0, endAt);
      const lines = parseConptyFrame(candidate, this._rows);
      if (lines && lines.length >= this._minimumFrameRows()) {
        this._lastConptyFrame = lines;
        this._observedConptyFrames += 1;
      }
      this._observationBuffer = this._observationBuffer.slice(endAt);
    }
  }

  _rewriteConptyCandidate(candidate) {
    if (this._alternateScreen) return candidate;
    const nextFrame = parseConptyFrame(candidate, this._rows);
    if (!nextFrame || nextFrame.length < this._minimumFrameRows()) return candidate;
    const shift = detectFrameShift(this._lastConptyFrame, nextFrame);
    if (!shift) return candidate;

    this._rewrittenConptyFrames += 1;
    this._rewrittenScrolls += 1;
    this._rescuedLines += shift;
    return `${CSI}r${CSI}999;1H${'\n'.repeat(shift)}${CSI}H${candidate}`;
  }

  _rewriteConptyFrames(data) {
    let input = this._conptyCarry + data;
    this._conptyCarry = '';
    // Fullscreen Codex owns its history and mouse input. There is no terminal
    // scrollback to rescue. Waiting for a cursor-show/home repaint here holds
    // its partial animation frames until the CLI becomes idle.
    if (this._alternateScreen) return input;
    let output = '';

    while (input) {
      const boundaryAt = input.indexOf(CONPTY_SYNC_BOUNDARY);
      if (boundaryAt < 0) {
        const held = suffixPrefixLength(input, CONPTY_SYNC_BOUNDARY);
        const plain = held ? input.slice(0, -held) : input;
        output += plain;
        this._observeConptyOutput(plain);
        this._conptyCarry = held ? input.slice(-held) : '';
        break;
      }

      const plain = input.slice(0, boundaryAt);
      output += plain;
      this._observeConptyOutput(plain);

      const hideAt = input.indexOf(CURSOR_HIDE, boundaryAt + CONPTY_SYNC_BOUNDARY.length);
      const showAt = hideAt < 0 ? -1 : input.indexOf(CURSOR_SHOW, hideAt + CURSOR_HIDE.length);
      const home = showAt < 0 ? null : findLastHome(input, hideAt + CURSOR_HIDE.length, showAt);
      if (hideAt < 0 || showAt < 0 || !home) {
        const pending = input.slice(boundaryAt);
        if (pending.length <= MAX_CONPTY_FRAME_CARRY) {
          this._conptyCarry = pending;
        } else {
          // A malformed or vendor-specific synchronized update must never
          // freeze terminal output indefinitely.
          output += pending;
          this._observeConptyOutput(pending);
          this._conptyFailOpenFrames += 1;
        }
        break;
      }

      const endAt = showAt + CURSOR_SHOW.length;
      const candidate = input.slice(boundaryAt, endAt);
      output += this._rewriteConptyCandidate(candidate);
      // Observe the ConPTY frame itself, not the synthetic scroll prefix, so
      // the next comparison represents the real final viewport.
      this._observeConptyOutput(candidate);
      input = input.slice(endAt);
    }

    return output;
  }

  write(data) {
    if (data === undefined || data === null || data === '') return '';
    const regionSafe = this._rewriteRegionScrolls(String(data));
    return this._conptySerialized ? this._rewriteConptyFrames(regionSafe) : regionSafe;
  }

  resize(cols, rows) {
    const nextCols = Number(cols);
    const nextRows = Number(rows);
    const normalizedCols = Number.isFinite(nextCols) ? Math.max(2, Math.floor(nextCols)) : this._cols;
    const normalizedRows = Number.isFinite(nextRows) ? Math.max(1, Math.floor(nextRows)) : this._rows;
    if (normalizedCols === this._cols && normalizedRows === this._rows) return;
    this._cols = normalizedCols;
    this._rows = normalizedRows;
    // A resize changes row boundaries and forces Codex to repaint. Treat that
    // repaint as the next baseline rather than comparing incompatible grids.
    this._lastConptyFrame = null;
    this._observationBuffer = '';
  }

  flush() {
    const pending = this.pendingText();
    this._conptyCarry = '';
    this._csiCarry = '';
    if (this._conptySerialized) this._observeConptyOutput(pending);
    return pending;
  }

  hasPending() {
    return this._csiCarry.length > 0 || this._conptyCarry.length > 0;
  }

  pendingText() {
    return this._conptyCarry + this._csiCarry;
  }

  stats() {
    return {
      rewrittenScrolls: this._rewrittenScrolls,
      rescuedLines: this._rescuedLines,
      pendingChars: this._csiCarry.length + this._conptyCarry.length,
      alternateScreen: this._alternateScreen,
      originMode: this._originMode,
      scrollRegion: this._scrollRegion ? { ...this._scrollRegion } : null,
      observedConptyFrames: this._observedConptyFrames,
      rewrittenConptyFrames: this._rewrittenConptyFrames,
      conptyFailOpenFrames: this._conptyFailOpenFrames,
    };
  }
}

module.exports = {
  CodexXtermScrollbackRewriter,
};
