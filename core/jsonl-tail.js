'use strict';

const fs = require('fs');
const { JsonlByteScanner } = require('./jsonl-byte-scanner.js');

class JsonlTail {
  constructor(filepath, onLine, opts = {}) {
    this._filepath = filepath;
    this._onLine = onLine;
    this._onError = typeof opts.onError === 'function' ? opts.onError : null;
    this._lastReadError = null;
    this._offset = 0;
    this._lineFilter = typeof opts.lineFilter === 'function' ? opts.lineFilter : null;
    this._maxPrefixBytes = Number.isFinite(opts.maxPrefixBytes) && opts.maxPrefixBytes > 0
      ? Math.floor(opts.maxPrefixBytes)
      : 64 * 1024;
    this._scanner = null;
    this._watcher = null;
    this._pollTimer = null;
    this._watchPollIntervalMs = Math.max(500, Number(opts.watchPollIntervalMs) || 500);
    this._closed = false;
    this._reading = false;
    this._startAtEnd = opts.startAtEnd === true;
    this._maxInitialBytes = Number.isFinite(opts.maxInitialBytes) && opts.maxInitialBytes > 0
      ? Math.floor(opts.maxInitialBytes)
      : null;
    this._maxReadBytes = Number.isFinite(opts.maxReadBytes) && opts.maxReadBytes > 0
      ? Math.floor(opts.maxReadBytes)
      : 4 * 1024 * 1024;
    this._maxObservedReadBytes = 0;
    this._yieldCount = 0;
    this._discardLeadingPartialLine = false;
  }

  async start() {
    if (this._closed) return;
    try { await this._prepareInitialOffset(); } catch {}
    this._resetScanner();
    try { await this._drain(); } catch {}
    if (this._closed) return;

    try {
      this._watcher = fs.watch(this._filepath, { persistent: false }, () => {
        this._drain().catch(() => {});
      });
      this._watcher.on('error', () => {
        this._watcher?.close(); this._watcher = null;
        this._startPolling(500);
      });
    } catch {
      // fs.watch can fail on network drives / exotic filesystems; polling below is the fallback.
    }

    this._startPolling(this._watcher ? this._watchPollIntervalMs : 500);
  }

  _startPolling(intervalMs) {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._closed) return;
    this._pollTimer = setInterval(() => {
      this._drain().catch(() => {});
    }, intervalMs);
    this._pollTimer.unref?.();
  }

  _resetScanner() {
    this._scanner = new JsonlByteScanner((obj, lineIndex, meta) => {
      try { this._onLine(obj, lineIndex, meta); } catch (error) {
        console.warn('[jsonl-tail] onLine callback failed; record dropped:', error && error.message, '| file:', this._filepath);
      }
    }, {
      lineFilter: this._lineFilter,
      maxPrefixBytes: this._maxPrefixBytes,
      startOffset: this._offset,
      discardLeadingPartialLine: this._discardLeadingPartialLine,
    });
  }

  async _prepareInitialOffset() {
    const stat = await fs.promises.stat(this._filepath);
    if (this._startAtEnd) {
      this._offset = stat.size;
      return;
    }
    if (!this._maxInitialBytes || stat.size <= this._maxInitialBytes) return;
    this._offset = stat.size - this._maxInitialBytes;
    if (this._offset <= 0) return;
    const fh = await fs.promises.open(this._filepath, 'r');
    try {
      const previous = Buffer.alloc(1);
      await fh.read(previous, 0, 1, this._offset - 1);
      this._discardLeadingPartialLine = previous[0] !== 0x0a;
    } finally {
      await fh.close();
    }
  }

  async _drain() {
    if (this._closed || this._reading) return;
    this._reading = true;
    try {
      const stat = await fs.promises.stat(this._filepath);
      if (stat.size < this._offset) {
        // File rotation/truncation: restart instead of staying permanently
        // beyond EOF.  Keep the same initial bound for a newly-large file.
        this._offset = this._maxInitialBytes && stat.size > this._maxInitialBytes
          ? stat.size - this._maxInitialBytes
          : 0;
        this._discardLeadingPartialLine = this._offset > 0;
        this._resetScanner();
      }
      if (stat.size <= this._offset) return;
      const fh = await fs.promises.open(this._filepath, 'r');
      try {
        while (!this._closed && this._offset < stat.size) {
          const len = Math.min(this._maxReadBytes, stat.size - this._offset);
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fh.read(buf, 0, len, this._offset);
          if (bytesRead <= 0) break;
          this._offset += bytesRead;
          this._maxObservedReadBytes = Math.max(this._maxObservedReadBytes, bytesRead);
          this._scanner.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
          if (this._offset < stat.size) {
            this._yieldCount += 1;
            await new Promise(resolve => setImmediate(resolve));
          }
        }
      } finally {
        await fh.close();
      }
    } catch (error) {
      // Transient IO errors such as rotation/deletion are retried on the next tick.
      this._lastReadError = error;
      if (this._onError) this._onError(error);
    } finally {
      this._reading = false;
    }
  }

  close() {
    this._closed = true;
    try { this._watcher?.close(); } catch {}
    try { clearInterval(this._pollTimer); } catch {}
    this._watcher = null;
    this._pollTimer = null;
    this._scanner = null;
  }

  getStats() {
    return {
      offset: this._offset,
      lastReadError: this._lastReadError,
      maxReadBytes: this._maxReadBytes,
      maxObservedReadBytes: this._maxObservedReadBytes,
      yieldCount: this._yieldCount,
      ...(this._scanner ? this._scanner.getStats() : {}),
    };
  }
}

module.exports = { JsonlTail };
