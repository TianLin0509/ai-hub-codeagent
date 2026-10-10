'use strict';
const { createHash } = require('node:crypto');

function promptFingerprint(text) {
  return createHash('sha256').update(String(text || '').replace(/\r\n?/g, '\n').trim()).digest('hex');
}

function contentFingerprint(text) {
  return promptFingerprint(String(text || '').replace(/\s/g, ''));
}

// Claude's actual UserPromptSubmit / transcript adds this complete envelope
// around a long bracketed paste. Preserve the inner text; never strip prose,
// partial tags or mismatched ids. Callers must try the raw receipt first.
function unwrapClaudePasteEnvelope(text) {
  if (typeof text !== 'string') return text;
  const match = text.match(/^\s*<pasted_content(?: id="([^"<>]+)")?>\r?\n([\s\S]*?)\r?\n<\/pasted_content(?: id="([^"<>]+)")?>\s*$/);
  return match && match[1] === match[3] ? match[2] : text;
}

// Delivery receipts share provider events with RuntimeTruth, but must identify
// the submitted message. Running/automatic continuation alone cannot do that.
class PromptSubmissionReceipts {
  constructor(onUpdate = () => {}) {
    this.entries = new Map();
    this.seen = new Map();
    this.unresolved = new Map();
    this.onUpdate = onUpdate;
  }

  begin(sessionId, clientSubmissionId, text, dispatchedAt = Date.now(), options = {}) {
    const receipt = {
      sessionId, clientSubmissionId, dispatchedAt, nativeOnly:options.nativeOnly === true,
      fingerprint: promptFingerprint(text), contentFingerprint: contentFingerprint(text),
      status: 'pending', acknowledgement: null,
      get started() { return this.status === 'confirmed'; },
      get resolved() { return this.started || this.status === 'content-mismatch'; },
      dispose() {}, // owned by the IPC registration, survives sendToPty timeout
    };
    this.entries.set(sessionId, receipt);
    const pending = this.unresolved.get(sessionId) || [];
    pending.push(receipt);
    this.unresolved.set(sessionId, pending);
    return receipt;
  }

  get(sessionId) { return this.entries.get(sessionId) || null; }

  snapshot(receipt) {
    return {
      sessionId: receipt.sessionId, clientSubmissionId: receipt.clientSubmissionId,
      status: receipt.status, acknowledgementSource: receipt.acknowledgement?.source || null,
      turnId: receipt.acknowledgement?.turnId || null,
      ...(receipt.acknowledgement?.threadId ? {threadId:receipt.acknowledgement.threadId} : {}),
    };
  }

  finish(receipt, result) {
    if (this.get(receipt.sessionId) !== receipt || receipt.resolved) return;
    // A generic PTY/activity success cannot identify this particular message.
    // 原文离开了输入框且屏幕在跑：记「已送达」——不是已确认（仍可被逐字回报升级），也不提示补发。
    receipt.status = result?.ok === false ? 'failed' : result?.sendStatus === 'queued' ? 'queued'
      : result?.acknowledgementSource === 'pty-input-cleared' ? 'delivered' : 'unconfirmed';
    this.onUpdate(this.snapshot(receipt));
  }

  observe(event = {}) {
    if (event.signalSource && !['user_message', 'item_completed_user_message',
      'claude-user-prompt-submit', 'codex-user-prompt-submit', 'prompt-submitted', 'codex-app-server', 'acp', 'qwen-cli', 'provider-cli'].includes(event.signalSource)) return false;
    const sessionId = event.sessionId || event.hubSessionId;
    if (!this.get(sessionId) || typeof event.text !== 'string' || !event.text.trim()) return false;
    const submittedAt = Number(event.submittedAt || event.observedAt);
    if (!Number.isFinite(submittedAt)) return false;
    const fingerprint = promptFingerprint(event.text);
    const content = contentFingerprint(event.text);
    // Claude hooks can be timestamped on arrival. Repeated "continue" sends
    // must consume the oldest unresolved matching attempt, never the newest.
    const pending = this.unresolved.get(sessionId) || [];
    const native = ['codex-app-server','acp','qwen-cli','provider-cli'].includes(event.signalSource);
    if (native && (!event.clientSubmissionId || !event.threadId || !event.turnId)) return false;
    const receipt = pending.find(item => (!item.nativeOnly || native)
      && (!native || item.clientSubmissionId === event.clientSubmissionId)
      && submittedAt >= item.dispatchedAt
      && (item.fingerprint === fingerprint || item.contentFingerprint === content));
    if (!receipt) return false;
    const key = `${native ? event.clientSubmissionId + ':' : ''}${event.turnId || submittedAt}:${fingerprint}`;
    const seen = this.seen.get(sessionId) || new Set();
    if (seen.has(key)) return false;
    seen.add(key);
    this.seen.set(sessionId, seen);
    if (receipt.resolved) return false;
    // A content-equivalent but whitespace-different record is evidence of a
    // possible altered submission, NEVER an exact success. Keep its warning
    // and stop retries rather than silently accepting loss or duplicating it.
    receipt.status = fingerprint === receipt.fingerprint ? 'confirmed' : 'content-mismatch';
    receipt.acknowledgement = {
      source: event.signalSource || 'prompt-submitted', observedAt: submittedAt,
      turnId: event.turnId || null,
      threadId: event.threadId || null,
    };
    this.unresolved.set(sessionId, pending.filter(item => item !== receipt));
    this.onUpdate(this.snapshot(receipt));
    return true;
  }

  prune(sessionExists) {
    for (const sid of this.entries.keys()) {
      if (sessionExists(sid)) continue;
      this.entries.delete(sid);
      this.seen.delete(sid);
      this.unresolved.delete(sid);
    }
  }
}

module.exports = { PromptSubmissionReceipts, promptFingerprint, unwrapClaudePasteEnvelope };
