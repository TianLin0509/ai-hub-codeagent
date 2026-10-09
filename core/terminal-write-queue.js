'use strict';

// xterm.write completes asynchronously. Chaining one promise per PTY fragment
// turns a burst of thousands of small ConPTY packets into thousands of timer
// turns. Keep one write in flight and join everything that arrived meanwhile.
class TerminalWriteQueue {
  constructor(terminal, onError = () => {}) {
    this.terminal = terminal;
    this.onError = onError;
    this.pending = [];
    this.running = null;
    this.error = null;
    this.disposed = false;
    this.release = null;
    this.accepted = 0;
    this.completed = 0;
    this.waiters = [];
  }

  enqueue(data) {
    if (this.disposed || this.error || !data) return;
    this.pending.push(String(data));
    this.accepted++;
    this.start();
  }

  start() {
    if (this.running) return;
    this.running = Promise.resolve().then(async () => {
      while (!this.disposed && this.pending.length) {
        const payload = this.pending.join('');
        const through = this.accepted;
        this.pending = [];
        await new Promise((resolve, reject) => {
          this.release = resolve;
          try { this.terminal.write(payload, resolve); }
          catch (error) { reject(error); }
        });
        this.release = null;
        this.completed = through;
        this.settleWaiters();
      }
    }).catch(error => {
      this.error = error;
      this.pending = [];
      this.settleWaiters();
      this.onError(error);
    }).finally(() => {
      this.running = null;
      // A new packet may arrive after the loop finishes but before this
      // completion microtask. Do not strand it until another packet arrives.
      if (!this.disposed && !this.error && this.pending.length) this.start();
    });
  }

  async drain() {
    if (this.error) throw this.error;
    if (this.disposed || this.completed >= this.accepted) return;
    // Snapshot a barrier: continuous new CLI output must not indefinitely
    // postpone a probe of the screen that was already queued when it began.
    await new Promise((resolve, reject) => this.waiters.push({ through: this.accepted, resolve, reject }));
  }

  settleWaiters() {
    const waiting = [];
    for (const waiter of this.waiters) {
      if (this.error) waiter.reject(this.error);
      else if (this.disposed || this.completed >= waiter.through) waiter.resolve();
      else waiting.push(waiter);
    }
    this.waiters = waiting;
  }

  dispose() {
    this.disposed = true;
    this.pending = [];
    this.settleWaiters();
    this.release?.();
  }
}

module.exports = { TerminalWriteQueue };
