'use strict';

// Only small file identity headers are retained. Discovery still stats every
// source and rebuilds Hub/profile bindings on every refresh.
class SearchSourceMetaCache {
  constructor({ maxEntries = 10000, maxBytes = 8 * 1024 * 1024, maxAgeMs = 60000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.entries = new Map();
    this.bytes = 0;
  }

  signature(stat) {
    return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs, stat.ino, stat.dev].join(':');
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  get(key, stat) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.signature !== this.signature(stat) || this.now() - entry.at >= this.maxAgeMs) {
      this.remove(key);
      return null;
    }
    // Expiration remains tied to the actual read, not the last cache hit.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.meta;
  }

  set(key, stat, meta) {
    this.remove(key);
    if (!meta) return;
    const signature = this.signature(stat);
    const bytes = 128 + 2 * (key.length + signature.length + JSON.stringify(meta).length);
    if (bytes > this.maxBytes || this.maxEntries <= 0) return;
    this.entries.set(key, { meta, signature, bytes, at: this.now() });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value);
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

module.exports = { SearchSourceMetaCache };
