'use strict';

const path = require('node:path');
const { JsonlTail } = require('../../core/jsonl-tail.js');
const { isClaudeFamily, isCodexCliKind } = require('../../core/ai-kinds.js');
const { codexUsage, ClaudeUsageLedger } = require('../../core/session-token-usage.js');
const { isSessionViewer } = require('../../core/session-observer-policy');

class SessionTokenUsageService {
  constructor({ publish, logger = console }) {
    this.publish = publish;
    this.logger = logger;
    this.entries = new Map();
  }

  bind(session) {
    const id = session?.id || session?.hubId;
    if (id && (isSessionViewer(session) || (session.runtimeBackend==='claude-stream-json' && session.codexSharedControl?.shared))) { this.remove(id); return; }
    const kind = session?.transcriptKind || session?.kind;
    if (!id || !session.transcriptPath || (!isClaudeFamily(kind) && !isCodexCliKind(kind))) return;
    const sourcePath = path.resolve(session.transcriptPath);
    const previous = this.entries.get(id);
    if (previous?.sourcePath === sourcePath) return;
    this.remove(id);
    const entry = { sourcePath, ledger: new ClaudeUsageLedger(), usage: null, ready: false, timer: null };
    // A saved snapshot survives a missing/truncated history file. Different
    // native transcripts must never inherit each other's accumulated usage.
    if (session.sessionUsage?.sourcePath === sourcePath) entry.usage = session.sessionUsage;
    else if (session.sessionUsage) this.publish(id, { sourcePath, total: null, output: null });
    this.entries.set(id, entry);
    const publish = () => {
      entry.timer = null;
      if (this.entries.get(id) !== entry) return;
      const partial = entry.ledger.partial || entry.tail?.getStats().invalidRecords > 0;
      if (entry.usage) this.publish(id, { ...entry.usage, ...(partial ? { partial: true } : {}) });
    };
    const accept = record => {
      const usage = isClaudeFamily(kind)
        ? entry.ledger.accept(record)
        : (record?.type === 'event_msg' && record.payload?.type === 'token_count'
          ? codexUsage(record.payload.info?.total_token_usage, 'codex-transcript') : null);
      if (!usage) {
        if (entry.ready && entry.ledger.partial && entry.usage && !entry.timer) entry.timer = setTimeout(publish, 100);
        return;
      }
      // Late/replayed Codex snapshots and initial Claude history replay cannot
      // make the visible cumulative amount go backwards.
      if (entry.usage && usage.total < entry.usage.total) return;
      entry.usage = { ...usage, sourcePath };
      if (entry.ready && !entry.timer) entry.timer = setTimeout(publish, 100);
    };
    entry.tail = new JsonlTail(sourcePath, accept, {
      maxReadBytes: 256 * 1024,
      watchPollIntervalMs: 5000,
      onError: error => {
        if (!entry.errorLogged) this.logger.warn('[session-usage] transcript read failed:', id, error.message);
        entry.errorLogged = true;
        if (entry.usage) { entry.usage = { ...entry.usage, stale: true }; publish(); }
      },
    });
    entry.tail.start().then(() => {
      if (this.entries.get(id) !== entry) { entry.tail.close(); return; }
      entry.ready = true;
      publish();
    }).catch(error => this.logger.warn('[session-usage] watcher failed:', id, error.message));
  }

  native(session, total) {
    const usage = codexUsage(total, 'codex-app-server');
    if (!usage || !session?.id) return;
    const sourcePath = session.transcriptPath ? path.resolve(session.transcriptPath) : null;
    const old = session.sessionUsage;
    if (old?.sourcePath === sourcePath && old.total > usage.total) return;
    this.publish(session.id, { ...usage, sourcePath });
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.tail.close();
  }

  dispose() { for (const id of this.entries.keys()) this.remove(id); }
}

module.exports = { SessionTokenUsageService };
