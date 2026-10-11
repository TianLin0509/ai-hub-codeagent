'use strict';

// Tail buffer of a session's terminal output (2026-10-11).
//
// The old buffer was one string: every PTY chunk did `ring = ring + chunk`
// followed by `ring.slice(-limit)`. Once a session had produced 1 MB, that
// slice flattened the whole buffer, so every chunk copied 1-2 MB on Electron's
// main thread (~0.5 ms each, measured) and fed the GC a fresh large string.
//
// This keeps the chunks as they arrive, trims whole chunks from the front, and
// builds the string only when someone reads it. Contents are identical to the
// old algorithm: after an append that crosses the limit the buffer is the last
// `limit` characters, minus any unpaired surrogate the cut left at the start.

const SURROGATE_SCAN = 5;

function leadingLoneSurrogates(head) {
  let i = 0;
  while (i < head.length && i < 4) {
    const cc = head.charCodeAt(i);
    // Lone low surrogate: drop it.
    if (cc >= 0xDC00 && cc <= 0xDFFF) { i++; continue; }
    // High surrogate not followed by a low surrogate: drop it too.
    if (cc >= 0xD800 && cc <= 0xDBFF) {
      const next = head.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) { i++; continue; }
    }
    break;
  }
  return i;
}

class TerminalRingBuffer {
  constructor(initial = '') {
    this._chunks = [];
    this._head = 0;
    this._length = 0;
    this._text = '';
    this.reset(initial);
  }

  get length() { return this._length; }

  reset(value) {
    const text = value == null ? '' : String(value);
    this._chunks = text ? [text] : [];
    this._head = 0;
    this._length = text.length;
    this._text = text;
  }

  append(data, limit) {
    const text = '' + data;
    if (text) {
      this._chunks.push(text);
      this._length += text.length;
      this._text = null;
    }
    if (this._length > limit) {
      this._text = null;
      this._dropFront(this._length - limit);
      const drop = leadingLoneSurrogates(this._peek(SURROGATE_SCAN));
      if (drop > 0) this._dropFront(drop);
    }
  }

  toString() {
    if (this._text !== null) return this._text;
    const text = this._head === 0 && this._chunks.length === 1
      ? this._chunks[0]
      : this._chunks.slice(this._head).join('');
    this._chunks = text ? [text] : [];
    this._head = 0;
    this._text = text;
    return text;
  }

  _peek(count) {
    let out = '';
    for (let i = this._head; i < this._chunks.length && out.length < count; i++) out += this._chunks[i];
    return out.slice(0, count);
  }

  _dropFront(count) {
    let remaining = count;
    while (remaining > 0 && this._head < this._chunks.length) {
      const first = this._chunks[this._head];
      if (first.length <= remaining) {
        remaining -= first.length;
        this._length -= first.length;
        this._chunks[this._head] = undefined;
        this._head++;
      } else {
        this._chunks[this._head] = first.slice(remaining);
        this._length -= remaining;
        remaining = 0;
      }
    }
    // Reclaim the consumed prefix of the array now and then (amortised O(1)).
    if (this._head > 1024 && this._head * 2 > this._chunks.length) {
      this._chunks = this._chunks.slice(this._head);
      this._head = 0;
    }
  }
}

module.exports = { TerminalRingBuffer, leadingLoneSurrogates };
