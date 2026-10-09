'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonlTail } = require('./jsonl-tail.js');

function normalizePathForCompare(value) {
  if (!value || typeof value !== 'string') return '';
  let normalized = path.resolve(value).replace(/\\/g, '/');
  if (normalized.length > 3 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inputText(input) {
  if (!Array.isArray(input)) return '';
  return input
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function messageText(message) {
  return inputText(message && message.content);
}

function recordTimeMs(record) {
  const raw = record && (record.timestamp || record.time || record.createdAt || record.created_at);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function isToolFinishReason(reason) {
  const normalized = String(reason || '').toLowerCase();
  return normalized === 'tool_calls' || normalized === 'tool_call' || normalized === 'tool_use';
}

function isAgentToolCall(event) {
  return !!(
    event
    && event.type === 'tool.call'
    && String(event.name || '').toLowerCase() === 'agent'
    && (event.toolCallId || event.uuid)
  );
}

function agentToolCallId(event) {
  if (!event) return '';
  // Some Kimi builds omit toolCallId on tool.result and only keep parentUuid;
  // its own result uuid is not the call id, so prefer parent before uuid there.
  if (event.type === 'tool.result') {
    return String(event.toolCallId || event.parentUuid || event.uuid || '');
  }
  return String(event.toolCallId || event.uuid || event.parentUuid || '');
}

function agentJobDescription(event) {
  if (!event) return '';
  return String(
    (event.args && event.args.description)
    || event.description
    || (event.display && event.display.agent_name)
    || '',
  );
}

function parseJsonl(text) {
  const records = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

function extractLatestKimiTurnFromText(text) {
  const state = {
    turnText: '',
    steps: new Map(),
    latest: null,
  };
  for (const record of parseJsonl(text)) {
    if (record.type === 'turn.prompt') {
      state.turnText = '';
      state.steps.clear();
      continue;
    }
    if (record.type !== 'context.append_loop_event' || !record.event) continue;
    const event = record.event;
    if (event.type === 'step.begin') {
      state.steps.set(event.uuid || `${event.turnId || ''}:${event.step || ''}`, { text: '', hadTool: false });
      continue;
    }
    const stepKey = event.stepUuid || event.uuid || `${event.turnId || ''}:${event.step || ''}`;
    const step = state.steps.get(stepKey) || { text: '', hadTool: false };
    if (event.type === 'content.part' && event.part && event.part.type === 'text' && typeof event.part.text === 'string') {
      step.text += event.part.text;
      state.steps.set(stepKey, step);
      continue;
    }
    if (event.type === 'tool.call') {
      step.hadTool = true;
      state.steps.set(stepKey, step);
      continue;
    }
    if (event.type !== 'step.end') continue;
    const ended = state.steps.get(event.uuid || stepKey) || step;
    if (ended.text) state.turnText += ended.text;
    if (isToolFinishReason(event.finishReason) || ended.hadTool) continue;
    const completedText = (ended.text || state.turnText).trim();
    if (completedText) {
      state.latest = {
        text: completedText,
        source: 'kimi_wire_step_end',
        completedAt: recordTimeMs(record),
      };
    }
  }
  return state.latest;
}

function extractOutstandingAgentCallsFromText(text) {
  const outstanding = new Map();
  for (const record of parseJsonl(text)) {
    if (record.type !== 'context.append_loop_event' || !record.event) continue;
    const event = record.event;
    if (isAgentToolCall(event)) {
      const jobId = agentToolCallId(event);
      outstanding.set(jobId, {
        jobId,
        description: agentJobDescription(event),
        changedAt: recordTimeMs(record),
      });
      continue;
    }
    if (event.type === 'tool.result') {
      const jobId = agentToolCallId(event);
      if (jobId) outstanding.delete(jobId);
    }
  }
  return Array.from(outstanding.values());
}

async function readUtf8Tail(filePath, maxBytes = 8 * 1024 * 1024) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = Number(stat.size) || 0;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.max(0, size - start));
    if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    // A bounded tail can begin in the middle of a UTF-8 JSONL record. Drop that
    // partial first line; every complete subsequent record remains authoritative.
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text;
  } finally {
    await handle.close();
  }
}

class KimiTap extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._parserService = opts.parserService || null;
    this.homeDir = opts.homeDir || process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
    this.indexPath = path.join(this.homeDir, 'session_index.jsonl');
    this.pollMs = Math.max(50, Number(opts.pollMs) || 350);
    this._pending = new Map();
    this._bound = new Map();
    this._claimedSids = new Set();
    this._timer = null;
    this._polling = false;
  }

  hasSession(hubSessionId) {
    return this._pending.has(hubSessionId) || this._bound.has(hubSessionId);
  }

  registerSession(hubSessionId, ctx = {}) {
    if (!hubSessionId) return;
    this.unregisterSession(hubSessionId);
    const pending = {
      hubSessionId,
      kind: ctx.kind || 'kimi',
      cwd: normalizePathForCompare(ctx.cwd || os.homedir()),
      registeredAt: Number(ctx.registeredAt) || Date.now(),
      kimiSid: ctx.kimiSid || null,
      allowExistingSession: !!ctx.allowExistingSession,
      knownSids: new Set(),
      initialized: false,
    };

    this._pending.set(hubSessionId, pending);

    if (ctx.transcriptPath || ctx.sessionDir) {
      const wirePath = ctx.transcriptPath || path.join(ctx.sessionDir, 'agents', 'main', 'wire.jsonl');
      const sessionDir = ctx.sessionDir || path.dirname(path.dirname(path.dirname(wirePath)));
      this._bind(pending, {
        sessionId: pending.kimiSid || path.basename(sessionDir),
        sessionDir,
        workDir: ctx.cwd || '',
      }, wirePath, true);
    } else {
      void this._initializePending(pending);
    }
    this._ensureTimer();
  }

  async _initializePending(pending) {
    const entries = await this._readIndex();
    if (this._pending.get(pending.hubSessionId) !== pending) return;
    pending.knownSids = new Set(entries.map(entry => entry.sessionId).filter(Boolean));
    pending.initialized = true;
    await this._scanIndex(entries);
  }

  notePrompt() {}

  unregisterSession(hubSessionId) {
    this._pending.delete(hubSessionId);
    const bound = this._bound.get(hubSessionId);
    try { bound?.tail?.close(); } catch {}
    if (bound && bound.kimiSid) this._claimedSids.delete(bound.kimiSid);
    this._bound.delete(hubSessionId);
    if (this._pending.size === 0 && this._bound.size === 0) this._stopTimer();
  }

  dispose() {
    for (const bound of this._bound.values()) {
      try { bound.tail?.close(); } catch {}
    }
    this._pending.clear();
    this._bound.clear();
    this._claimedSids.clear();
    this._stopTimer();
  }

  getLastAssistantText(hubSessionId) {
    const bound = this._bound.get(hubSessionId);
    return bound && bound.lastAssistantText ? bound.lastAssistantText : null;
  }

  getStreamingText(hubSessionId) {
    const bound = this._bound.get(hubSessionId);
    if (!bound || !bound.streamingText) return null;
    return [{ type: 'text', text: bound.streamingText }];
  }

  clearStreamingBuf(hubSessionId) {
    const bound = this._bound.get(hubSessionId);
    if (bound) bound.streamingText = '';
  }

  async extractLatestTurn(hubSessionId, sincePromptTs = 0) {
    const bound = this._bound.get(hubSessionId);
    if (!bound || !bound.wirePath) return null;
    try {
      let turn;
      if (this._parserService) {
        const { turns } = await this._parserService.parse('kimi', bound.wirePath, { limit: 1, fromTail: true });
        const latest = turns[turns.length - 1];
        turn = latest && latest.role === 'assistant'
          ? { text: latest.text, source: 'kimi_wire_step_end', completedAt: latest.tsEnd || latest.ts || 0 }
          : null;
      } else {
        turn = extractLatestKimiTurnFromText(fs.readFileSync(bound.wirePath, 'utf8'));
      }
      // 2026-07-20 maintainer [修#1]：时间窗下界——turn 完成时间早于本轮 prompt 5s 以上，
      //   判定为上一轮旧答案拒绝提取（与 ClaudeTap 同口径，防张冠李戴）。
      if (turn && sincePromptTs && turn.completedAt && turn.completedAt < sincePromptTs - 5000) return null;
      return turn;
    } catch {
      return null;
    }
  }

  getDebugSnapshot() {
    return {
      homeDir: this.homeDir,
      pending: Array.from(this._pending.values()).map((entry) => ({
        hubSessionId: entry.hubSessionId,
        cwd: entry.cwd,
        kimiSid: entry.kimiSid,
      })),
      bound: Array.from(this._bound.values()).map((entry) => ({
        hubSessionId: entry.hubSessionId,
        kimiSid: entry.kimiSid,
        wirePath: entry.wirePath,
        offset: entry.tail ? entry.tail.getStats().offset : entry.offset,
      })),
    };
  }

  _ensureTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => { void this._poll(); }, this.pollMs);
    this._timer.unref?.();
  }

  _stopTimer() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  async _poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      await this._scanIndex(await this._readIndex());
    } catch {
      // Discovery is best-effort; the next interval retries transient IO.
    } finally {
      this._polling = false;
    }
  }

  async _readIndex() {
    let text;
    try { text = await fs.promises.readFile(this.indexPath, 'utf8'); } catch { return []; }
    const bySid = new Map();
    for (const record of parseJsonl(text)) {
      if (!record || typeof record.sessionId !== 'string' || typeof record.sessionDir !== 'string') continue;
      const sessionDir = path.isAbsolute(record.sessionDir)
        ? record.sessionDir
        : path.resolve(this.homeDir, record.sessionDir);
      bySid.set(record.sessionId, { ...record, sessionDir });
    }
    return Array.from(bySid.values());
  }

  async _scanIndex(entries) {
    for (const pending of Array.from(this._pending.values())) {
      if (!pending.initialized) continue;
      let candidates = entries.filter((entry) => {
        if (!entry.sessionId || this._claimedSids.has(entry.sessionId)) return false;
        if (pending.kimiSid) return entry.sessionId === pending.kimiSid;
        return normalizePathForCompare(entry.workDir) === pending.cwd;
      });
      if (!pending.kimiSid && !pending.allowExistingSession) {
        candidates = candidates.filter((entry) => !pending.knownSids.has(entry.sessionId));
      }
      if (pending.allowExistingSession && !pending.kimiSid) {
        const withMtime = await Promise.all(candidates.map(async entry => ({
          entry,
          mtime: await this._wireMtime(entry),
        })));
        candidates = withMtime
          .filter(item => item.mtime >= pending.registeredAt - 2000)
          .map(item => ({ ...item.entry, _wireMtime: item.mtime }));
      }
      if (candidates.some(entry => !Number.isFinite(entry._wireMtime))) {
        candidates = await Promise.all(candidates.map(async entry => ({
          ...entry,
          _wireMtime: Number.isFinite(entry._wireMtime) ? entry._wireMtime : await this._wireMtime(entry),
        })));
      }
      candidates.sort((a, b) => b._wireMtime - a._wireMtime);
      const selected = candidates[0];
      if (!selected) continue;
      const startAtEnd = pending.allowExistingSession || pending.knownSids.has(selected.sessionId);
      this._bind(pending, selected, null, startAtEnd);
    }
  }

  async _wireMtime(entry) {
    const wirePath = path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
    try { return (await fs.promises.stat(wirePath)).mtimeMs; } catch { return 0; }
  }

  _bind(pending, nativeSession, explicitWirePath, startAtEnd) {
    const wirePath = explicitWirePath || path.join(nativeSession.sessionDir, 'agents', 'main', 'wire.jsonl');
    const bound = {
      hubSessionId: pending.hubSessionId,
      kind: pending.kind,
      kimiSid: nativeSession.sessionId,
      sessionDir: nativeSession.sessionDir,
      wirePath,
      offset: 0,
      partial: '',
      turnText: '',
      currentPrompt: '',
      currentTurnId: null,
      lastUserText: '',
      steps: new Map(),
      completedSteps: new Set(),
      backgroundAgentCalls: new Set(),
      streamingText: '',
      lastAssistantText: '',
      tail: null,
    };
    this._pending.delete(pending.hubSessionId);
    this._bound.set(pending.hubSessionId, bound);
    if (bound.kimiSid) this._claimedSids.add(bound.kimiSid);
    this.emit('session-bound', {
      hubSessionId: bound.hubSessionId,
      kind: 'kimi',
      kimiSid: bound.kimiSid,
      sessionDir: bound.sessionDir,
      wirePath: bound.wirePath,
    });
    bound.tail = new JsonlTail(bound.wirePath, record => this._processRecord(bound, record), {
      startAtEnd: !!startAtEnd,
      maxInitialBytes: 8 * 1024 * 1024,
      maxReadBytes: 4 * 1024 * 1024,
    });
    void bound.tail.start().then(async () => {
      bound.offset = bound.tail.getStats().offset;
      // A resumed Kimi session may already be waiting on a long-running Coder
      // Agent when Hub binds to it. JsonlTail intentionally starts at EOF in
      // that case, so reconcile the bounded existing tail once; live records
      // and this scan share the same Set and cannot double-emit a start event.
      if (startAtEnd) {
        try {
          const text = await readUtf8Tail(bound.wirePath);
          for (const job of extractOutstandingAgentCallsFromText(text)) {
            this._startBackgroundAgent(bound, job.jobId, job.description, job.changedAt, 'kimi_wire_reconcile');
          }
        } catch {}
      }
    }).catch(() => {});
  }

  _startBackgroundAgent(bound, jobId, description, changedAt, signalSource = 'kimi_wire_agent_call') {
    const normalizedId = String(jobId || '');
    if (!normalizedId || bound.backgroundAgentCalls.has(normalizedId)) return false;
    bound.backgroundAgentCalls.add(normalizedId);
    this.emit('background-work-changed', {
      hubSessionId: bound.hubSessionId,
      kind: 'kimi',
      phase: 'started',
      jobId: normalizedId,
      description: String(description || ''),
      remaining: bound.backgroundAgentCalls.size,
      changedAt: changedAt || Date.now(),
      transcriptPath: bound.wirePath,
      signalSource,
    });
    return true;
  }

  _finishBackgroundAgent(bound, jobId, changedAt) {
    const normalizedId = String(jobId || '');
    if (!normalizedId || !bound.backgroundAgentCalls.delete(normalizedId)) return false;
    this.emit('background-work-changed', {
      hubSessionId: bound.hubSessionId,
      kind: 'kimi',
      phase: 'finished',
      jobId: normalizedId,
      remaining: bound.backgroundAgentCalls.size,
      changedAt: changedAt || Date.now(),
      transcriptPath: bound.wirePath,
      signalSource: 'kimi_wire_agent_result',
    });
    return true;
  }

  _processRecord(bound, record) {
    if (record.type === 'context.append_message' && record.message) {
      if (record.message.role === 'user') bound.lastUserText = messageText(record.message);
      return;
    }
    if (record.type === 'turn.prompt') {
      bound.turnText = '';
      bound.steps.clear();
      bound.completedSteps.clear();
      bound.streamingText = '';
      bound.currentTurnId = record.turnId || record.turn_id || null;
      bound.currentPrompt = inputText(record.input) || bound.lastUserText || '';
      if (bound.currentPrompt && (!record.origin || record.origin.kind === 'user')) {
        this.emit('prompt-submitted', {
          hubSessionId: bound.hubSessionId,
          text: bound.currentPrompt,
          submittedAt: recordTimeMs(record),
          turnId: bound.currentTurnId,
          transcriptPath: bound.wirePath,
          signalSource: 'kimi_wire_turn_prompt',
        });
      }
      return;
    }
    if (record.type !== 'context.append_loop_event' || !record.event) return;
    const event = record.event;
    const fallbackStepKey = `${event.turnId || ''}:${event.step || ''}`;
    if (event.type === 'step.begin') {
      if (event.turnId != null) bound.currentTurnId = String(event.turnId);
      bound.steps.set(event.uuid || fallbackStepKey, { text: '', hadTool: false });
      bound.streamingText = '';
      return;
    }
    const stepKey = event.stepUuid || event.uuid || fallbackStepKey;
    const step = bound.steps.get(stepKey) || { text: '', hadTool: false };
    if (event.type === 'content.part' && event.part && event.part.type === 'text' && typeof event.part.text === 'string') {
      step.text += event.part.text;
      bound.steps.set(stepKey, step);
      bound.streamingText = step.text;
      return;
    }
    if (event.type === 'tool.call') {
      if (isAgentToolCall(event)) {
        this._startBackgroundAgent(
          bound,
          agentToolCallId(event),
          agentJobDescription(event),
          recordTimeMs(record),
        );
      }
      step.hadTool = true;
      bound.steps.set(stepKey, step);
      return;
    }
    if (event.type === 'tool.result') {
      this._finishBackgroundAgent(bound, agentToolCallId(event), recordTimeMs(record));
      return;
    }
    if (event.type !== 'step.end') return;
    const endedKey = event.uuid || stepKey;
    if (bound.completedSteps.has(endedKey)) return;
    bound.completedSteps.add(endedKey);
    const ended = bound.steps.get(endedKey) || bound.steps.get(stepKey) || step;
    if (ended.text) bound.turnText += ended.text;
    if (isToolFinishReason(event.finishReason) || ended.hadTool) {
      bound.streamingText = '';
      return;
    }
    const text = (ended.text || bound.turnText).trim();
    if (!text) return;
    bound.lastAssistantText = text;
    bound.streamingText = text;
    this.emit('turn-complete', {
      hubSessionId: bound.hubSessionId,
      text,
      source: 'kimi_wire_step_end',
      completedAt: recordTimeMs(record),
      turnId: event.turnId != null ? String(event.turnId) : bound.currentTurnId,
      transcriptPath: bound.wirePath,
    });
  }
}

module.exports = {
  KimiTap,
  extractOutstandingAgentCallsFromText,
  extractLatestKimiTurnFromText,
  isAgentToolCall,
  normalizePathForCompare,
};
