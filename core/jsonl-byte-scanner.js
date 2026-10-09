'use strict';

/**
 * Incremental JSONL scanner that can reject a record from a small byte prefix
 * before the rest of a very large line is decoded or retained.
 *
 * lineFilter(prefix, context) returns:
 *   true  -> retain and JSON.parse this line
 *   false -> discard the remaining bytes of this line
 *   null  -> need more prefix bytes
 *
 * A filter that is still undecided at maxPrefixBytes fails open and retains
 * the line. This keeps the generic scanner lossless; provider-specific filters
 * should make a decision from their stable JSON envelope well before that.
 */
class JsonlByteScanner {
  constructor(onRecord, opts = {}) {
    this._onRecord = typeof onRecord === 'function' ? onRecord : () => {};
    this._lineFilter = typeof opts.lineFilter === 'function' ? opts.lineFilter : null;
    this._maxPrefixBytes = Math.max(1024, Number(opts.maxPrefixBytes) || 64 * 1024);
    this._startOffset = Math.max(0, Number(opts.startOffset) || 0);
    this._absoluteOffset = this._startOffset;
    this._lineIndex = Math.max(0, Number(opts.startLineIndex) || 0);
    this._discardLeadingPartialLine = opts.discardLeadingPartialLine === true;
    this._stats = {
      bytesSeen: 0,
      keptBytes: 0,
      skippedBytes: 0,
      keptRecords: 0,
      skippedRecords: 0,
      invalidRecords: 0,
      undecidedKeptRecords: 0,
      maxLineBytes: 0,
      maxBufferedLineBytes: 0,
    };
    this._resetLine(this._absoluteOffset);
  }

  _resetLine(startOffset) {
    this._lineStartOffset = startOffset;
    this._lineBytes = 0;
    this._decision = this._lineFilter ? null : true;
    this._prefixParts = [];
    this._prefixBytes = 0;
    this._keptParts = this._decision === true ? [] : null;
    this._bufferedLineBytes = 0;
  }

  _prefixText() {
    if (!this._prefixBytes) return '';
    return Buffer.concat(this._prefixParts, this._prefixBytes).toString('utf8');
  }

  _evaluateFilter(final) {
    if (!this._lineFilter || this._decision !== null) return this._decision;
    let result = null;
    try {
      result = this._lineFilter(this._prefixText(), {
        final: final === true,
        lineBytes: this._lineBytes,
        lineIndex: this._lineIndex,
        prefixBytes: this._prefixBytes,
        maxPrefixBytes: this._maxPrefixBytes,
      });
    } catch {
      // A filter must never make the underlying JSONL reader lossy.
      result = true;
    }
    if (result === true || result === false) this._decision = result;
    return this._decision;
  }

  _promotePrefixToKept() {
    if (this._keptParts) return;
    this._keptParts = this._prefixParts;
    this._bufferedLineBytes = this._prefixBytes;
    this._prefixParts = [];
  }

  _consumeSegment(segment) {
    if (!segment || segment.length === 0) return;
    this._lineBytes += segment.length;
    this._stats.bytesSeen += segment.length;
    this._stats.maxLineBytes = Math.max(this._stats.maxLineBytes, this._lineBytes);

    if (this._discardLeadingPartialLine || this._decision === false) return;
    if (this._decision === true) {
      this._keptParts.push(Buffer.from(segment));
      this._bufferedLineBytes += segment.length;
      this._stats.maxBufferedLineBytes = Math.max(
        this._stats.maxBufferedLineBytes,
        this._bufferedLineBytes,
      );
      return;
    }

    const take = Math.min(segment.length, this._maxPrefixBytes - this._prefixBytes);
    if (take > 0) {
      this._prefixParts.push(Buffer.from(segment.subarray(0, take)));
      this._prefixBytes += take;
      this._bufferedLineBytes += take;
      this._stats.maxBufferedLineBytes = Math.max(
        this._stats.maxBufferedLineBytes,
        this._bufferedLineBytes,
      );
    }

    this._evaluateFilter(false);
    if (this._decision === null && this._prefixBytes >= this._maxPrefixBytes) {
      // Fail open: an unknown provider record is retained, never silently lost.
      this._decision = true;
      this._stats.undecidedKeptRecords += 1;
    }

    if (this._decision === true) {
      this._promotePrefixToKept();
      if (segment.length > take) {
        const remainder = segment.subarray(take);
        this._keptParts.push(Buffer.from(remainder));
        this._bufferedLineBytes += remainder.length;
        this._stats.maxBufferedLineBytes = Math.max(
          this._stats.maxBufferedLineBytes,
          this._bufferedLineBytes,
        );
      }
    } else if (this._decision === false) {
      this._prefixParts = [];
      this._prefixBytes = 0;
      this._bufferedLineBytes = 0;
    }
  }

  _finishLine(terminatedByNewline) {
    const hadBytes = this._lineBytes > 0;
    let parsed = false;
    let safelyConsumed = terminatedByNewline === true;

    if (this._discardLeadingPartialLine) {
      this._stats.skippedBytes += this._lineBytes;
      if (hadBytes) this._stats.skippedRecords += 1;
      this._discardLeadingPartialLine = false;
    } else if (hadBytes) {
      if (this._decision === null) this._evaluateFilter(true);
      if (this._decision === null) {
        this._decision = true;
        this._stats.undecidedKeptRecords += 1;
      }

      if (this._decision === false) {
        this._stats.skippedBytes += this._lineBytes;
        this._stats.skippedRecords += 1;
        safelyConsumed = true;
      } else {
        this._promotePrefixToKept();
        let lineBuffer = Buffer.concat(this._keptParts, this._bufferedLineBytes);
        if (lineBuffer.length && lineBuffer[lineBuffer.length - 1] === 0x0d) {
          lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
        }
        try {
          const record = JSON.parse(lineBuffer.toString('utf8'));
          this._onRecord(record, this._lineIndex, {
            startOffset: this._lineStartOffset,
            byteLength: this._lineBytes,
          });
          parsed = true;
          safelyConsumed = true;
          this._stats.keptRecords += 1;
          this._stats.keptBytes += this._lineBytes;
        } catch {
          this._stats.invalidRecords += 1;
          // A complete newline-terminated bad row can be skipped forever. At
          // EOF it may merely be an in-progress append, so the caller should
          // resume from this line's start next time.
          safelyConsumed = terminatedByNewline === true;
        }
      }
    } else {
      safelyConsumed = true;
    }

    if (terminatedByNewline || (hadBytes && safelyConsumed)) this._lineIndex += 1;
    const safeOffset = safelyConsumed ? this._absoluteOffset : this._lineStartOffset;
    this._resetLine(this._absoluteOffset);
    return { parsed, safelyConsumed, safeOffset };
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk || '');
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      const end = newline >= 0 ? newline : chunk.length;
      this._consumeSegment(chunk.subarray(cursor, end));
      this._absoluteOffset += end - cursor;
      if (newline < 0) break;
      this._absoluteOffset += 1;
      this._finishLine(true);
      cursor = newline + 1;
    }
  }

  end(opts = {}) {
    let safeOffset = this._absoluteOffset;
    if (opts.flushFinal !== false && this._lineBytes > 0) {
      safeOffset = this._finishLine(false).safeOffset;
    } else if (this._lineBytes > 0) {
      safeOffset = this._lineStartOffset;
    }
    return {
      ...this.getStats(),
      safeOffset,
      nextLineIndex: this._lineIndex,
      pendingLineBytes: this._lineBytes,
    };
  }

  getStats() {
    return {
      ...this._stats,
      offset: this._absoluteOffset,
      lineIndex: this._lineIndex,
      pendingLineBytes: this._lineBytes,
    };
  }
}

module.exports = { JsonlByteScanner };
