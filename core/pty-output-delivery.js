'use strict';

// The display stream has a latency bound independent of CLI activity. A
// partial escape/frame may wait briefly for its tail, never for silence.
class PtyOutputDelivery {
  constructor({ emit, rewriter = null, maxDelayMs = 16, setTimer = setTimeout, clearTimer = clearTimeout, onError = console.warn }) {
    this.emit = emit;
    this.rewriter = rewriter;
    this.maxDelayMs = maxDelayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onError = onError;
    this.timer = null;
    this.closed = false;
  }

  write(data) {
    if (this.closed || !data) return;
    let output = data;
    if (this.rewriter) {
      const pending = this.rewriter.pendingText();
      try { output = this.rewriter.write(data); }
      catch (error) {
        this.onError(error);
        // Retain the original stream from the first uncommitted fragment.
        // A faulty adapter must not stop the native display or hide a failure.
        output = pending + data;
        this.rewriter = null;
      }
    }
    if (output) this.emit(output);
    if (this.rewriter?.hasPending()) {
      if (this.timer === null) this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, this.maxDelayMs);
    } else this.cancelTimer();
  }

  cancelTimer() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  flush() {
    this.cancelTimer();
    if (this.closed || !this.rewriter) return;
    const pending = this.rewriter.pendingText();
    let data;
    try { data = this.rewriter.flush(); }
    catch (error) { this.onError(error); data = pending; this.rewriter = null; }
    if (data) this.emit(data);
  }

  close() {
    if (this.closed) return;
    try { this.flush(); } finally { this.closed = true; this.cancelTimer(); }
  }
}

module.exports = { PtyOutputDelivery };
