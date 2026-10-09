'use strict';

// File-scoped LRU: query variants share a file's memory budget. Larger parsed
// windows can serve smaller windows without changing parser options or IDs.
function estimateBytes(value, cap) {
  const pending = [value], seen = new Set();
  let bytes = 0;
  while (pending.length && bytes <= cap) {
    const item = pending.pop();
    if (typeof item === 'string') bytes += item.length * 2;
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item);
      bytes += 64;
      for (const [key, child] of Object.entries(item)) {
        bytes += key.length * 2 + 16;
        pending.push(child);
      }
    } else bytes += 8;
  }
  return bytes;
}
function queryKey(opts, withoutLimit = false) {
  return JSON.stringify(Object.fromEntries(Object.keys(opts || {})
    .filter(k => !withoutLimit || k !== 'limit').sort().map(k => [k, opts[k]])));
}
class TranscriptResultCache {
  constructor({ maxBytes = 32 * 1024 * 1024, maxFiles = 32, maxVariants = 4 } = {}) {
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.maxVariants = maxVariants;
    this.files = new Map();
    this.bytes = 0;
  }
  remove(key) {
    const file = this.files.get(key);
    if (file) {
      this.bytes -= file.bytes;
      this.files.delete(key);
    }
  }
  get(key, signature, opts = {}) {
    const file = this.files.get(key);
    if (!file) return null;
    if (file.signature !== signature) { this.remove(key); return null; }
    let variant = file.variants.get(queryKey(opts));
    if (!variant && Number.isInteger(opts.limit) && opts.limit > 0) {
      const base = queryKey(opts, true);
      variant = [...file.variants.values()].find(v => v.base === base
        && (v.turns.length >= opts.limit || !Object.hasOwn(v.opts, 'limit')));
      if (variant) {
        const tail = opts.fromTail === true
          || (['kimi', 'gemini'].includes(file.kind) && opts.fromTail !== false);
        variant = { ...variant, turns: tail ? variant.turns.slice(-opts.limit) : variant.turns.slice(0, opts.limit) };
      }
    }
    if (!variant) return null;
    this.files.delete(key);
    this.files.set(key, file);
    return variant.turns;
  }
  set(key, kind, signature, opts, turns) {
    const bytes = estimateBytes(turns, this.maxBytes);
    if (bytes > this.maxBytes) {
      if (this.files.get(key)?.signature !== signature) this.remove(key);
      return;
    }
    let file = this.files.get(key);
    if (file && file.signature !== signature) { this.remove(key); file = null; }
    if (!file) {
      file = { kind, signature, variants: new Map(), bytes: 0 };
      this.files.set(key, file);
    }
    const q = queryKey(opts), old = file.variants.get(q);
    if (old) {
      this.bytes -= old.bytes;
      file.bytes -= old.bytes;
      file.variants.delete(q);
    }
    const variant = { opts: { ...opts }, base: queryKey(opts, true), turns, bytes };
    file.variants.set(q, variant);
    file.bytes += bytes;
    this.bytes += bytes;
    while (file.variants.size > this.maxVariants) {
      const first = file.variants.keys().next().value, v = file.variants.get(first);
      file.variants.delete(first);
      file.bytes -= v.bytes;
      this.bytes -= v.bytes;
    }
    this.files.delete(key);
    this.files.set(key, file);
    while (this.files.size > this.maxFiles || this.bytes > this.maxBytes) {
      this.remove(this.files.keys().next().value);
    }
  }
}
module.exports = { TranscriptResultCache };
