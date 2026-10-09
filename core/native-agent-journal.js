'use strict';
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const { trimRecordForJournal } = require('./native-transcript-trim');

// Compaction rewrites a journal whose history is dominated by superseded
// snapshots. One session measured 378 MB for 397 rewrites of the same 430
// frames (2026-09-13); each restart re-read and re-parsed all of it.
const COMPACT_MIN_BYTES = 4 * 1024 * 1024;

function frameKey(frame) { return frame && (frame.uuid || frame.message?.id) || null; }

// A save only has to record what changed. saveAppended() already took this
// route for late child output; this covers the remaining callers, so re-saving
// a settled record (reset() marking pending work unknown, or the pending sweep
// on reconnect) no longer rewrites its whole transcript.
//
// This is a bounded win, not the reason journals get large: in the largest
// production journal measured (105 MB / 81 records) every identity was distinct
// and its 2452 frames were all unique, so nothing there was a repeat. The size
// came from tool output inside those frames — see core/native-transcript-trim.js.
//
// The delta is used only when replaying it provably reproduces the array the
// caller passed: every frame keyed, no duplicate keys, and the existing frames
// still in their original order at the head. Removals, reorderings and unkeyed
// frames fall back to a whole snapshot instead of guessing, because mergeFrames
// cannot express them.
function transcriptDelta(previous, next) {
  if (!Array.isArray(next) || !Array.isArray(previous) || !previous.length) return null;
  if (next.length < previous.length) return null;
  const keys = new Array(next.length);
  const seen = new Set();
  for (let i = 0; i < next.length; i++) {
    const key = frameKey(next[i]);
    if (key === null || seen.has(key)) return null;
    seen.add(key);
    keys[i] = key;
  }
  for (let i = 0; i < previous.length; i++) if (frameKey(previous[i]) !== keys[i]) return null;
  const delta = [];
  for (let i = 0; i < next.length; i++) {
    if (i >= previous.length) { delta.push(next[i]); continue; }
    // Frames are held by reference and never rewritten in place, so identity
    // settles the common case; the encoded comparison covers frames restored
    // from disk, which match in content but not in identity.
    if (next[i] === previous[i]) continue;
    if (JSON.stringify(next[i]) !== JSON.stringify(previous[i])) delta.push(next[i]);
  }
  return delta.length < next.length ? delta : null;
}
// Appended frames are merged by identity so a replayed slice never duplicates.
function mergeFrames(previous, appended) {
  const frames = Array.isArray(previous) ? [...previous] : [];
  const index = new Map(frames.map((frame, i) => [frameKey(frame), i]));
  for (const frame of appended || []) {
    const key = frameKey(frame);
    const at = key !== null ? index.get(key) : undefined;
    if (at === undefined) { if (key !== null) index.set(key, frames.length); frames.push(frame); }
    else frames[at] = frame;
  }
  return frames;
}

// Durable submission identities live in Hub's data directory, not provider
// screen buffers. A malformed journal is an explicit recovery error.
class NativeAgentJournal {
  constructor({ directory, sessionId }) {
    if (!directory || !path.isAbsolute(directory)) throw new Error('Native journal requires an absolute data directory');
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('Invalid Hub session ID');
    this.sessionId = sessionId;
    this.filePath = path.join(directory, sessionId + '.jsonl');
    this.failure = null;
    this.bytes = 0;
    this.entries = this.read();
    this.records = new Map();
    this.activities = new Map();
    for (const entry of this.entries) this.project(entry);
    this.compactIfOversized();
  }

  read() {
    let raw;
    try {
      const bytes = fs.readFileSync(this.filePath);
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      this.bytes = bytes.length;
    }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (raw && !raw.endsWith('\n')) throw new Error('Native journal has an incomplete final record: ' + this.filePath);
    return raw.split('\n').filter(Boolean).map((line, index) => {
      const entry = JSON.parse(line);
      if (entry.version !== 1 || entry.sequence !== index + 1 || entry.sessionId !== this.sessionId
          || !['submission', 'lifecycle', 'activity'].includes(entry.type) || !entry.data) {
        throw new Error('Invalid native journal record ' + (index + 1));
      }
      return entry;
    });
  }

  project(entry) {
    if (entry.type === 'activity') {
      if (!entry.data.userMessageId || !entry.data.nativeActivity || !entry.data.origin?.kind
          || entry.data.origin.kind === 'human') throw new Error('Invalid native activity identity');
      const previous = this.activities.get(entry.data.userMessageId);
      const { transcriptAppend, ...data } = entry.data;
      if (transcriptAppend) data.transcriptMessages = mergeFrames(previous?.transcriptMessages, transcriptAppend);
      this.activities.set(entry.data.userMessageId, data);
      return;
    }
    const id = entry.data.submissionId || entry.data.clientSubmissionId;
    if (!id) throw new Error('Native journal record has no submission identity');
    const previous = this.records.get(id);
    if (previous?.promptFingerprint && entry.data.promptFingerprint
        && previous.promptFingerprint !== entry.data.promptFingerprint) throw new Error('Native journal content identity changed');
    const { transcriptAppend, ...data } = entry.data;
    const merged = { ...previous, ...data };
    if (transcriptAppend) merged.transcriptMessages = mergeFrames(previous?.transcriptMessages, transcriptAppend);
    if (entry.type === 'lifecycle') {
      // Lifecycle text is assistant output. Never overwrite the original prompt
      // under the same field when rebuilding durable submissions.
      merged.text = previous?.text;
      merged.finalText = entry.data.text ?? previous?.finalText;
      merged.lifecycleType = entry.data.type;
      merged.submissionId = id;
    }
    this.records.set(id, merged);
  }

  // Callers keep passing the whole transcript; only the stored form changes.
  asDelta(data, previous) {
    if (!data || !Array.isArray(data.transcriptMessages) || data.transcriptAppend) return data;
    const delta = transcriptDelta(previous?.transcriptMessages, data.transcriptMessages);
    if (!delta) return data;
    const { transcriptMessages, ...rest } = data;
    return { ...rest, transcriptAppend: delta };
  }

  append(type, data) {
    if (this.failure) throw this.failure;
    // Validate before writing. A failed append must not update in-memory truth.
    const target = type === 'activity' ? this.activities : this.records;
    const id = type === 'activity' ? data.userMessageId : data.submissionId || data.clientSubmissionId;
    const old = target.get(id);
    // Trim before diffing: the stored form is what a later delta compares
    // against, so diffing the untrimmed frames would never match.
    const stored = trimRecordForJournal(data);
    const entry = { version: 1, sequence: this.entries.length + 1,
      sessionId: this.sessionId, type, at: Date.now(), data: this.asDelta(stored, old) };
    this.project(entry);
    if (old) target.set(id, old); else target.delete(id);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    let size;
    try { size = fs.statSync(this.filePath).size; }
    catch (error) { if (error.code === 'ENOENT') size = 0; else throw error; }
    if (size !== this.bytes) throw new Error('Native journal changed outside its owner; reload required');
    const line = JSON.stringify(entry) + '\n';
    const fd = fs.openSync(this.filePath, 'a');
    try {
      fs.writeFileSync(fd, line, 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      // A failed append may have left a partial line. No subsequent writes may
      // pretend that line never existed; reopening performs strict validation.
      this.failure = error;
      throw error;
    } finally { fs.closeSync(fd); }
    this.bytes += Buffer.byteLength(line, 'utf8');
    this.entries.push(entry);
    this.project(entry);
    return entry;
  }

  // One entry per identity reproduces exactly what project() had rebuilt: a
  // submission entry merges every field, so the prompt text, receipt and
  // transcript survive; an activity entry is already a whole snapshot. The
  // rewrite is atomic (temp file + rename); on any failure the original file
  // stays authoritative and the next open simply tries again.
  compactIfOversized({ minBytes = COMPACT_MIN_BYTES } = {}) {
    if (this.bytes < minBytes || this.entries.length <= this.records.size + this.activities.size) return false;
    const compact = [];
    for (const record of this.records.values()) {
      const { lifecycleType, ...data } = record;
      compact.push({ type: 'submission', data: { ...data, ...(lifecycleType ? { lifecycleType } : {}) } });
    }
    for (const activity of this.activities.values()) compact.push({ type: 'activity', data: activity });
    const entries = compact.map((entry, index) => ({ version: 1, sequence: index + 1,
      sessionId: this.sessionId, type: entry.type, at: Date.now(), data: entry.data }));
    const body = entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '');
    const temp = this.filePath + '.compact-' + process.pid;
    try {
      const fd = fs.openSync(temp, 'w');
      try { fs.writeFileSync(fd, body, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
      return false;
    }
    this.entries = entries;
    this.bytes = Buffer.byteLength(body, 'utf8');
    this.records = new Map(); this.activities = new Map();
    for (const entry of entries) this.project(entry);
    return true;
  }

  saveSubmission(data) { return this.append('submission', data); }
  saveLifecycle(data) { return this.append('lifecycle', data); }
  saveActivity(data) { return this.append('activity', data); }
  listActivities() { return [...this.activities.values()].map(record => ({ ...record })); }
  list() { return [...this.records.values()].map(record => ({ ...record })); }
}

module.exports = { NativeAgentJournal, mergeFrames, transcriptDelta };
