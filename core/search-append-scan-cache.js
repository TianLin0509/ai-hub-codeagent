'use strict';

// Live agents append to their transcript several times a second, and every
// background sync used to re-read the whole file (a 130 MB Codex rollout or a
// 25 MB Claude transcript) only to rebuild the same records plus a few new
// ones. This cache keeps the records already scanned from complete lines of a
// large file and, while the file is provably the same file grown by appending,
// scans only the bytes after them. The caller still rebuilds turns and docs
// from the complete record list, so the result equals a full scan.
//
// "Provably appended": same file identity, not shorter than the cached offset,
// and the bytes at the head and right before the cached offset are unchanged.
// Anything else (truncation, rewrite, replacement) falls back to a full scan.
//
// Records are retained only for files read a second time, i.e. transcripts
// that changed after they were indexed. The initial build reads thousands of
// finished transcripts once; holding their records would only cost memory.

const fs = require('node:fs');
const { JsonlByteScanner } = require('./jsonl-byte-scanner.js');

const FINGERPRINT_BYTES = 4096;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_PREFIX_BYTES = 64 * 1024;

function readWindow(fd, start, end) {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const bytesRead = fs.readSync(fd, buffer, done, length - done, start + done);
    if (bytesRead <= 0) break;
    done += bytesRead;
  }
  return done === length ? buffer : buffer.subarray(0, done);
}

function scanRange(fd, onRecord, { lineFilter, maxPrefixBytes, chunkBytes, startOffset, startLineIndex, endOffset, flushFinal }) {
  const scanner = new JsonlByteScanner(onRecord, { lineFilter, maxPrefixBytes, startOffset, startLineIndex });
  if (endOffset > startOffset) {
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, endOffset - startOffset));
    let position = startOffset;
    while (position < endOffset) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, endOffset - position), position);
      if (bytesRead <= 0) break;
      scanner.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  }
  return scanner.end({ flushFinal });
}

function sameIdentity(entry, stat) {
  return entry.ino === Number(stat.ino || 0)
    && entry.dev === Number(stat.dev || 0)
    && entry.birthtimeMs === Number(stat.birthtimeMs || 0);
}

class AppendScanCache {
  constructor({
    minFileBytes = 1024 * 1024,
    maxEntryKeptBytes = 16 * 1024 * 1024,
    // Retained records cost about 1.35x their JSON size in V8 heap.
    maxTotalKeptBytes = 24 * 1024 * 1024,
    maxEntries = 16,
    maxSeenKeys = 50_000,
  } = {}) {
    this.maxSeenKeys = maxSeenKeys;
    this.seen = new Set();
    this.minFileBytes = minFileBytes;
    this.maxEntryKeptBytes = maxEntryKeptBytes;
    this.maxTotalKeptBytes = maxTotalKeptBytes;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.keptBytes = 0;
    this.stats = { fullScans: 0, appendScans: 0, invalidations: 0, scannedBytes: 0 };
  }

  _drop(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.keptBytes -= entry.keptBytes;
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.seen.clear();
    this.keptBytes = 0;
  }

  _stillAppendOnly(entry, fd, stat) {
    if (!sameIdentity(entry, stat) || stat.size < entry.offset) return false;
    if (!readWindow(fd, 0, entry.head.length).equals(entry.head)) return false;
    return readWindow(fd, entry.offset - entry.tail.length, entry.offset).equals(entry.tail);
  }

  /**
   * Returns every record a full scan with `lineFilter` (flushing the final
   * unterminated line) would produce, as `{ record, lineIndex }` in file order.
   * `kind` separates callers that scan the same file with different filters.
   */
  readRecords(filePath, kind, { lineFilter, maxPrefixBytes = DEFAULT_PREFIX_BYTES, chunkBytes = DEFAULT_CHUNK_BYTES } = {}) {
    const key = `${kind}\0${filePath}`;
    const readBefore = this.seen.has(key);
    if (!readBefore) {
      if (this.seen.size >= this.maxSeenKeys) this.seen.clear();
      this.seen.add(key);
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      let entry = this.entries.get(key) || null;
      if (entry && !this._stillAppendOnly(entry, fd, stat)) {
        this._drop(key);
        this.stats.invalidations += 1;
        entry = null;
      }
      const scanOptions = { lineFilter, maxPrefixBytes, chunkBytes };
      const startOffset = entry ? entry.offset : 0;
      const fresh = [];
      // Complete lines only: their records never change once appended.
      const complete = scanRange(fd, (record, lineIndex) => fresh.push({ record, lineIndex }), {
        ...scanOptions,
        startOffset,
        startLineIndex: entry ? entry.nextLineIndex : 0,
        endOffset: stat.size,
        flushFinal: false,
      });
      this.stats.scannedBytes += Math.max(0, stat.size - startOffset);
      if (entry) this.stats.appendScans += 1; else this.stats.fullScans += 1;
      // An unterminated last line is usually an append in progress. A full scan
      // still parses it when it is valid JSON, so do the same but never cache it.
      const transient = [];
      if (complete.pendingLineBytes > 0) {
        scanRange(fd, (record, lineIndex) => transient.push({ record, lineIndex }), {
          ...scanOptions,
          startOffset: complete.safeOffset,
          startLineIndex: complete.nextLineIndex,
          endOffset: stat.size,
          flushFinal: true,
        });
      }

      let records;
      const keptBytes = (entry ? entry.keptBytes : 0) + (Number(complete.keptBytes) || 0);
      if (readBefore && stat.size >= this.minFileBytes && keptBytes <= this.maxEntryKeptBytes) {
        records = entry ? entry.records : [];
        for (const item of fresh) records.push(item);
        if (entry) this._drop(key);
        const offset = complete.safeOffset;
        entry = {
          records,
          keptBytes,
          offset,
          nextLineIndex: complete.nextLineIndex,
          ino: Number(stat.ino || 0),
          dev: Number(stat.dev || 0),
          birthtimeMs: Number(stat.birthtimeMs || 0),
          head: readWindow(fd, 0, Math.min(offset, FINGERPRINT_BYTES)),
          tail: readWindow(fd, Math.max(0, offset - FINGERPRINT_BYTES), offset),
        };
        this.entries.set(key, entry);
        this.keptBytes += keptBytes;
        this._evict(key);
      } else {
        if (entry) this._drop(key);
        records = entry ? entry.records.concat(fresh) : fresh;
      }
      return transient.length ? records.concat(transient) : records;
    } finally {
      fs.closeSync(fd);
    }
  }

  _evict(keepKey) {
    for (const key of this.entries.keys()) {
      if (this.keptBytes <= this.maxTotalKeptBytes && this.entries.size <= this.maxEntries) break;
      if (key !== keepKey) this._drop(key);
    }
  }
}

module.exports = { AppendScanCache };
