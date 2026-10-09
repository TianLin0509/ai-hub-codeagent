'use strict';
const { EventEmitter } = require('events');
const { randomUUID, createHash } = require('crypto');
const { ClaudeStreamClient, protocolError } = require('../main/claude-stream-client');
const { resolveHandshakeBudget } = require('./claude-handshake-timeout.js');
const { CONTINUATION_ORIGINS, claudeTranscriptTurns, tailClaudeRecords } = require('./claude-native-transcript');
const { findNativeClaudeHistory, processExists, renameNativeClaudeHistory } = require('./claude-native-history');
const ownership = require('./native-session-ownership');
const { ClaudeNativeActivities } = require('./claude-native-activities');
const { NATIVE_CONFIRMATION_MS } = require('./native-confirmation-policy');
const { probeSubmissionReceipt } = require('./claude-receipt-probe');
const { noteSessionStart } = require('./claude-model-discovery');

const BACKEND = 'claude-stream-json';
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const DELEGATED = new Set(['local_agent', 'local_workflow']);
const TASK_TERMINAL = new Set(['completed', 'failed', 'stopped', 'killed', 'cancelled']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Measured against Claude Code 2.1.269: `/effort banana` answers "Valid options
// are: low, medium, high, xhigh, max, ultracode, auto". The --effort launch flag
// accepts only the first five, so only those are written back to the args.
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto']);
const EFFORT_LAUNCH_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function contentBlocks(text, attachments = []) {
  if (typeof text !== 'string') throw new TypeError('Claude prompt must be one string');
  const content = [{ type: 'text', text }];
  for (const item of attachments) {
    if (item.type !== 'image' || !item.source || !['base64', 'url'].includes(item.source.type)) {
      throw new Error('Unsupported Claude attachment; expected an SDK image source');
    }
    content.push({ type: 'image', source: { ...item.source } });
  }
  return content;
}
function canonicalContent(content) {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function digest(content) { return createHash('sha256').update(JSON.stringify(stable(canonicalContent(content)))).digest('hex'); }
function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter(block => block.type === 'text').map(block => block.text).join('');
}
// The backstage pane is a terminal: model text arrives as plain newlines and an
// escape sequence from a tool result must never be able to drive the emulator.
// Same contract the Codex native session uses for its own backstage output.
function sanitizeTerminal(text) {
  return String(text || '').replace(/\x1b/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function initialRuntime(sessionId, previous) {
  return { state: 'unknown', connection: 'connecting', epoch: (previous?.epoch || 0) + 1, revision: 0,
    providerSessionId: sessionId, turnId: null, userMessageId: null, ownerPid: process.pid, childPid: null,
    startedAt: 0, completedAt: 0, requests: [], waitingFlags: [], submission: null, queued: [],
    reason: previous && !TERMINAL.has(previous.state) && previous.state !== 'idle'
      ? '上次 Claude 提交状态需要核对' : '正在连接 Claude' };
}

class ClaudeNativeSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.sessionId = options.resumeSessionId && !options.fork ? options.resumeSessionId : options.sessionId || randomUUID();
    if (!UUID.test(this.sessionId) || (options.resumeSessionId && !UUID.test(options.resumeSessionId))) {
      throw new Error('Claude resume/new session requires an exact UUID');
    }
    this.runtime = initialRuntime(this.sessionId, options.restoredRuntime);
    this.unreconciled = !!options.restoredRuntime && !TERMINAL.has(options.restoredRuntime.state)
      && options.restoredRuntime.state !== 'idle';
    this.records = new Map();
    for (const saved of options.restoredRecords || []) {
      if (saved.providerSessionId !== this.sessionId) throw new Error('Stored submission belongs to a different Claude session');
      if (digest(saved.content) !== saved.promptFingerprint) throw new Error('Stored Claude submission content is corrupted');
      const savedStatus = saved.status || saved.sendStatus;
      const terminal = TERMINAL.has(savedStatus);
      const status = terminal ? savedStatus : 'unknown';
      this.records.set(saved.submissionId, { ...saved, fingerprint: saved.promptFingerprint, status,
        accepted: saved.accepted === true || (saved.accepted == null && terminal), started: terminal, durable: true,
        messages: new Map((saved.transcriptMessages || []).map(frame => [frame.uuid || frame.message?.id, frame])),
        resolve() {}, reject() {}, ack: Promise.resolve(null) });
      if (!terminal && !saved.reconciliation) this.unreconciled = true;
    }
    if (this.records.size && [...this.records.values()].every(record => TERMINAL.has(record.status) || record.reconciliation)) {
      this.unreconciled = false;
    }
    // A dev-group seat holds its identity without spawning an engine until it is
    // actually given work. Claude owns its session UUID from the start, so an
    // unstarted seat is simply one whose engine has never run -- there is no
    // thread to reconcile and nothing to recover.
    this.lazyStart = options.lazyStart === true || options.restoredRuntime?.lazyStart === true;
    if (this.lazyStart && !this.records.size && !options.resumeSessionId && !this.unreconciled) {
      Object.assign(this.runtime, { state: 'idle', connection: 'unstarted', lazyStart: true,
        reason: '尚未开始，收到消息后启动' });
    }
    this.queue = [];
    this.active = null;
    this.seen = new Set();
    this.tasks = new Map();
    this.activities = new ClaudeNativeActivities(options);
    this.activities.recoverTasks(options.restoredRuntime?.backgroundTasks || [], this.runtime.epoch - 1, false);
    this.activities.settleUnknown('hub', { persist: false });
    for (const record of this.records.values()) this.activities.rememberTools(record);
    if (this.activities.pending().length) this.unreconciled = true;
    this.completedResultIds = new Set([...this.records.values(), ...this.activities.records.values()]
      .map(record => record.providerResultId || record.resultId).filter(Boolean));
    this.foregroundState = 'idle';
    this.items = new Map();
    this.closed = false;
    this.closePromise = null;
    this.ready = null;
    this.client = null;
    this.configurationChange = null;
    this.reconnecting = false;
    this.reconnectPending = false;
    this.recoveryReady = false;
    this.backstage = new (require('./claude-backstage').ClaudeBackstage)(this);
    this.on('item', event => this.backstage.frame(event.message, event.userMessageId));
    this.on('lifecycle', event => {
      if (event.type === 'agent-turn-complete') this.backstage.frame(event.result, event.userMessageId);
      if (event.type === 'submission-accepted') {
        const record = this.records.get(event.clientSubmissionId);
        if (record) this.backstage.frame({type:'user', uuid:record.userMessageId, message:{content:record.content}}, record.userMessageId);
      }
    });
    this.on('action-error', message => this.backstage.note('操作失败', message, 'error'));
    if (this.unreconciled) this.runtime.reason = '上次 Claude 提交状态需要核对；不会自动重发';
  }

  get pid() { return this.client?.proc?.pid || null; }
  readBackstage(options) { return this.backstage.read(options); }
  async prepareBackstageExport() {
    let page;
    do { page = this.backstage.read({history:true, limit:1}); await new Promise(resolve => setImmediate(resolve)); } while (page.historyMore);
  }
  onData(fn) { this.on('data', fn); return { dispose: () => this.off('data', fn) }; }
  print(text) { this.emit('data', sanitizeTerminal(text).replace(/\r?\n/g, '\r\n')); }
  onExit(fn) { this.on('exit', fn); return { dispose: () => this.off('exit', fn) }; }
  resize() {}
  kill() {
    this.close().catch(error => this.emit('action-error', error.message));
  }
  write() { throw new Error('Claude native sessions accept structured prompts, not terminal input'); }
  transcript(options = {}) {
    const records = [...this.records.values(), ...this.activities.records.values()].sort((a, b) => a.createdAt - b.createdAt);
    return claudeTranscriptTurns(options.tailRecords ? tailClaudeRecords(records, options.tailRecords) : records);
  }

  historyExclusions() {
    const excludeEntryIds = []; const excludeMessageIds = [];
    for (const record of [...this.records.values(), ...this.activities.records.values()]) {
      excludeEntryIds.push(record.userMessageId);
      for (const frame of [...(record.messages?.values() || []), ...(record.streams?.values() || [])]) {
        if (frame.uuid) excludeEntryIds.push(frame.uuid);
        if (frame.message?.id) excludeMessageIds.push(frame.message.id);
      }
    }
    return { excludeEntryIds, excludeMessageIds };
  }

  // The echo proves the engine received exactly this submission. A slash command
  // is the one case where it legitimately differs: the engine answers with its
  // own <command-name> envelope, so verify the command identity instead of the
  // bytes rather than weakening the check for ordinary prompts.
  echoMatches(message, record) {
    if (digest(message.message.content) === record.fingerprint) return true;
    if (!record.commandName) return false;
    const echoed = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(textOf(message.message.content));
    if (!echoed) return false;
    const normalize = value => String(value).trim().replace(/^\//, '').toLowerCase();
    return normalize(echoed[1]) === normalize(record.commandName);
  }

  update(patch) {
    // 这里清的是一次**还在期限内**的停止，所以判据必须是正面证据：所有活儿都
    // 拿到了终局回执。判成 unknown 不是证据 —— 用它清停止等于替 Claude 说「停好了」。
    // 超时之后那条另有出路（clearUnresolvedStop），不靠这里放宽。
    if (this.cancellation?.hadWork && !this.active && !this.activities.pending().length && !this.tasks.size) {
      clearTimeout(this.cancellation.timer); this.cancellation = null;
      patch = { ...patch, cancellation:null };
    }
    const backgroundTasks = [...this.tasks.values()];
    const backgroundActivities = this.activities?.pending().map(r => ({ id: r.userMessageId, origin: r.origin, state: r.status })) || [];
    if (['completed', 'failed', 'interrupted', 'idle'].includes(patch.state)) this.foregroundState = patch.state;
    if (!this.active && !this.unreconciled && this.runtime.connection === 'connected'
        && patch.connection !== 'disconnected') {
      const busy = backgroundTasks.some(task => DELEGATED.has(task.type)) || this.activities.live().length;
      const requests = patch.requests || this.runtime.requests;
      // 一次没得到确认的停止推翻的正是「它还在跑」这个判断本身，所以它压过
      // busy。继续报「工作中」会把核对按钮挡掉，用户就没有任何出口了 —— 这正是
      // 2026-09-23 那个会话被锁死两个多小时的那一步。
      const unresolvedStop = !!this.cancellation?.unresolved;
      // 没有活儿在跑、却还留着一条没有结局的后台活动：同样是待核对，不是工作中。
      const staleActivity = !busy && !requests.length
        && backgroundActivities.some(activity => activity.state === 'unknown');
      patch = unresolvedStop
        ? { ...patch, state: 'unknown',
          reason: patch.reason || this.runtime.reason || 'Claude 停止结果待核对；不会自动重发' }
        : staleActivity
          ? { ...patch, state: 'unknown', reason: patch.reason || 'Claude 后台活动没有结果，需要核对；不会自动重发' }
          : { ...patch, state: requests.length ? 'waiting' : busy ? 'running' : this.foregroundState,
            ...(busy && !requests.length ? { reason: 'Claude 后台活动仍在进行；用户回合已单独结算' } : {}) };
    }
    this.runtime = { ...this.runtime, ...patch, recoveryReady: this.recoveryReady,
      backgroundTasks, backgroundActivities,
      revision: this.runtime.revision + 1, observedAt: Date.now(),
      queued: this.queue.map(record => ({ submissionId: record.submissionId, userMessageId: record.userMessageId })) };
    this.emit('state', this.runtime);
  }

  receipt(record) {
    return { ok: !['rejected', 'unknown', 'content-mismatch'].includes(record.status),
      sendStatus: record.status, source: BACKEND, submissionId: record.submissionId,
      clientSubmissionId: record.submissionId, providerSessionId: this.sessionId,
      userMessageId: record.userMessageId, providerTurnId: null, promptFingerprint: record.fingerprint,
      ...(record.submittedAt ? {submittedAt:record.submittedAt} : {}) };
  }

  lifecycle(type, record, extra = {}, beforeEmit = null) {
    const event = { type, hubSessionId: this.options.id, kind: this.options.kind || 'claude',
      signalSource: BACKEND, providerSessionId: this.sessionId, ccSessionId: this.sessionId,
      // Hub's turn key is explicitly the input UUID, not an invented provider turn ID.
      turnId: record?.userMessageId || null, providerTurnId: null,
      userMessageId: record?.userMessageId || null, clientSubmissionId: record?.submissionId || null,
      promptFingerprint: record?.fingerprint || null, ...extra };
    if (this.options.persistLifecycle) {
      const saved = this.options.persistLifecycle(event);
      if (saved && typeof saved.then === 'function') throw new Error('persistLifecycle must durably save synchronously before emitting');
    }
    if (beforeEmit) beforeEmit();
    this.emit('lifecycle', event);
  }

  start() {
    if (!this.ready) this.ready = this._start();
    return this.ready;
  }

  async _start() {
    if (this.runtime.connection === 'unstarted') {
      this.update({ connection: 'connecting', state: 'unknown', reason: '正在连接 Claude' });
    }
    const previous = this.options.restoredRuntime;
    const oldHubAlive = previous && previous.ownerPid !== process.pid && require('./owned-process').matches(previous.ownerPid, previous.observedAt);
    const oldChildAlive = previous && previous.ownerPid !== process.pid && require('./owned-process').matches(previous.childPid, previous.observedAt);
    if (oldChildAlive || (!this.options.ownership && oldHubAlive)) {
      throw protocolError('旧 Claude 写入进程仍存活，请先在原 Hub 结束该会话再恢复', 'CLAUDE_WRITER_ACTIVE');
    }
    const launchArgs = [...(this.options.launchArgs || [])];
    if (this.options.ownership) {
      let proof;
      try { proof = await ownership.assertNoOtherHubOwner(this.options, this.sessionId); }
      catch (error) { if (error.nativeDraft) this.emit('migration-draft', error.nativeDraft); throw error; }
      if (oldHubAlive && !proof?.checkedPids.includes(previous.ownerPid)) {
        throw protocolError('无法核对旧 Hub 是否已释放此 Claude 会话', 'CLAUDE_WRITER_ACTIVE');
      }
      if (this.closed) throw protocolError('Claude startup was cancelled before ownership', 'CLAUDE_CLOSED');
      this.lease = ownership.claimThread(this.options, this.sessionId, null);
    }
    if (this.options.resumeSessionId) {
      launchArgs.push('--resume', this.options.resumeSessionId);
      if (this.options.fork) launchArgs.push('--fork-session', '--session-id', this.sessionId);
    } else launchArgs.push('--session-id', this.sessionId);
    // 保留 resume / fork 的容错预算；历史体积不能证明初始化的实际耗时或阶段。
    const handshake = resolveHandshakeBudget({
      resumeSessionId: this.options.resumeSessionId,
      homeDir: this.options.homeDir,
    });
    if (handshake.reason) {
      this.update({ connection: 'connecting', state: 'unknown', reason: handshake.reason });
      // 放宽过的预算要留痕：出问题时第一个要回答的问题就是「当时到底等了多久」。
      this.backstage.note('连接 Claude', `${handshake.reason}；握手超时上限 ${Math.round(handshake.timeoutMs / 1000)} 秒（非预计耗时）`);
      console.log(`[claude-native] handshake budget ${Math.round(handshake.timeoutMs / 1000)}s for ${handshake.bytes} bytes of history (${this.sessionId})`);
    }
    const clientOptions = {
      ...this.options,
      launchArgs,
      initializeTimeoutMs: Number(this.options.initializeTimeoutMs) > 0
        ? Number(this.options.initializeTimeoutMs)
        : handshake.timeoutMs,
    };
    try {
      this.client = this.options.clientFactory
        ? this.options.clientFactory(clientOptions)
        : new ClaudeStreamClient(clientOptions);
    } catch (error) {
      if (this.lease) { ownership.releaseThread(this.lease); this.lease = null; }
      throw error;
    }
    const client = this.client;
    const current = () => this.client === client && !this.reconnecting;
    client.on('disconnect', error => { if (current()) this.disconnect(error); });
    client.on('diagnostic', event => {
      if (!current()) return;
      if (event.type === 'stderr') this.backstage.note('Claude stderr', event.message, 'warning');
      this.emit('diagnostic', event);
    });
    // Unexpected child exits keep the logical session recoverable. Explicit
    // closure publishes its own single exit after the child and lease drain.
    client.on('exit', event => { if (current() && !this.closed) this.emit('exit', event); });
    client.on('message', message => {
      if (!current()) return;
      try { this.message(message); }
      catch (error) { this.disconnect(protocolError('Claude message handler: ' + error.message)); }
    });
    client.on('request', request => { if (current()) this.request(request); });
    client.on('request-cancelled', id => {
      if (!current()) return;
      const requests = this.runtime.requests.filter(r => r.id !== id);
      this.update({ requests, state: this.unreconciled ? 'unknown' : requests.length ? 'waiting'
        : this.active?.accepted ? 'running' : this.runtime.state });
    });
    const handshakeStarted = performance.now();
    try {
      const starting = this.client.start();
      // Bind the exact spawned child before awaiting the protocol handshake.
      starting.catch(() => undefined);
      if (this.lease && this.pid) ownership.bindServerPid(this.lease, this.pid);
      await starting;
      if (this.options.resumeSessionId) {
        const elapsedMs = Math.round(performance.now() - handshakeStarted);
        this.backstage.note('Claude 连接完成', `initialize 已确认，耗时 ${elapsedMs} ms；历史 ${handshake.bytes} bytes`);
        console.log(`[claude-native] initialize completed in ${elapsedMs}ms (${this.sessionId})`);
      }
    } catch (error) {
      await this.client.close();
      if (this.lease) { ownership.releaseThread(this.lease); this.lease = null; }
      throw error;
    }
    if (this.closed) throw protocolError('Claude session closed during startup', 'CLAUDE_CLOSED');
    for (const activity of this.activities.pending()) this.activities.save(activity);
    this.activities.saveUnsavedSettlements();
    // The engine reports whether Fast is actually serving this session and why
    // not. That is the only honest source for the speed chip: the launch
    // overlay is a request, and a subscription or model can refuse it.
    const initialization = this.client.initialization || {};
    this.update({ connection: 'connected', childPid: this.pid,
      fastMode: initialization.fast_mode_state === 'on',
      fastModeBlocked: initialization.fast_mode_disabled_reason || null,
      permissionMode: initialization.current_permission_mode || this.runtime.permissionMode || null,
      state: this.unreconciled ? 'unknown' : this.runtime.requests.length ? 'waiting' : 'idle',
      reason: this.unreconciled ? '上次 Claude 提交状态需要核对；不会自动重发' : null });
    this.print('\nClaude 已连接。请使用 Hub 输入框发送消息；本页显示引擎原始输出。\n');
    // 连上之后立刻把上一轮的悬空提交核对掉。Codex 有 thread/read 可以直接问
    // App Server「上一轮到底结束了没」，stream-json 没有对应的协议调用，所以
    // 这里读原生 transcript —— 这是 Hub 手上唯一的证据来源。
    // 不这么做的后果实测过：2026-09-20 17:04 那一轮被打断后，会话每次打开都
    // 连上（2388 ms），却永远停在 unknown，只有用户亲手发一条消息才会解开。
    // 群聊和无人值守席位不在这条路上：那里「停下来等人看一眼」是有意的关卡。
    // 普通会话用的是和「核对上次任务」按钮完全相同的语义（2026-09-24 用户决定：
    // 不要再弹这个提示）。此刻 start() 已确认旧 writer 退出、新进程刚起，旧提交
    // 不可能还在跑；按钮能做的也只是登记「不重发、不追认成功」，让人去点毫无增益。
    if (this.unreconciled && !this.options.meetingId && this.options.autonomous !== true) {
      try { await this.reconcileFromHistory({ source: 'hub' }); }
      // 失败就让它看得见：状态留在「待核对」，界面上的核对按钮仍然可用。
      catch (error) { this.emit('action-error', '上次任务自动核对未完成：' + error.message); }
    }
    this.refreshContext().catch(error => this.emit('action-error', '上下文用量读取失败：' + error.message));
    return this.runtime;
  }

  async submit(text, options = {}) {
    if (this.cancellation) throw protocolError('正在停止，请等待原生会话确认后发送', 'CLAUDE_CANCELLING');
    const content = contentBlocks(text, options.attachments);
    await this.start();
    if (this.runtime.configurationChange?.status === 'unknown') {
      throw protocolError('Claude 设置结果待核对，请等待原生回执或重连后再发送', 'CLAUDE_CONFIGURATION_UNKNOWN');
    }
    if (this.configurationChange) await this.configurationChange;
    if (this.reconnectPending || this.reconnecting) throw protocolError('Claude 正在重连', 'CLAUDE_RECONNECTING');
    if (this.closed || this.client.failure) throw this.client.failure || protocolError('Claude session closed', 'CLAUDE_CLOSED');
    if (this.unreconciled) throw protocolError('Claude submission requires reconciliation', 'CLAUDE_SUBMISSION_UNKNOWN');
    const submissionId = options.clientSubmissionId || options.submissionId || randomUUID();
    const fingerprint = digest(content);
    const existing = this.records.get(submissionId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw protocolError('Submission ID reused with different content', 'CLAUDE_CONTENT_MISMATCH');
      return this.receipt(existing);
    }
    const record = { submissionId, userMessageId: randomUUID(), fingerprint, content, text,
      status: 'queued', createdAt: Date.now(), accepted: false, started: false, finalText: '',
      metadata: options.metadata || null, delegated: false,
      // The engine rewrites a command echo into its own envelope, so the echo
      // check below verifies the command name instead of the exact bytes.
      commandName: options.localCommand === true ? String(text).trim().split(/\s/)[0] : null };
    record.ack = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    // Queued callers get a visible queued receipt; eventual errors are also emitted.
    record.ack.catch(() => undefined);
    this.records.set(submissionId, record);
    this.queue.push(record);
    this.update({});
    try {
      if (this.options.persistSubmission) await this.options.persistSubmission({ ...this.receipt(record),
        text, content, metadata: record.metadata, createdAt: record.createdAt });
      record.durable = true;
    } catch (error) {
      this.queue = this.queue.filter(item => item !== record);
      record.status = 'rejected'; record.reject(error);
      this.update(this.active ? {} : { state: 'failed', reason: '无法保存 Claude 提交记录：' + error.message,
        submission: this.receipt(record) });
      this.emit('action-error', error.message);
      throw error;
    }
    if (this.closed) throw protocolError('Claude session closed while saving submission', 'CLAUDE_CLOSED');
    if (record.cancelled) {
      this.cancelBeforeSend(record);
      return record.ack;
    }
    const busy = !!this.active || this.activities.live().length > 0 || this.queue[0] !== record;
    this.pump().catch(error => this.disconnect(error));
    return busy ? this.receipt(record) : record.ack;
  }

  async pump() {
    if (this.active || this.activities.live().length || this.closed || this.unreconciled || this.reconnectPending || this.client.failure || !this.queue[0]?.durable) return;
    const record = this.queue.shift();
    this.active = record;
    record.status = 'submitting';
    record.submittedAt = Date.now();
    record.speedTier = typeof this.runtime?.fastMode === 'boolean'
      ? (this.runtime.fastMode ? 'fast' : 'standard') : null;
    // Writing a submission is ordinary work in flight, not an uncertain result.
    // Publishing it as "unknown" made every send flash "本条提交待核对" and a
    // reconnect button. A crash here still leaves a non-idle snapshot, so a
    // restore continues to demand reconciliation; disconnect() still marks the
    // record unknown when the outcome really is unknown.
    this.update({ state: 'starting', reason: '正在提交给 Claude', turnId: record.userMessageId, apiRetry: null,
      userMessageId: record.userMessageId, submission: this.receipt(record), requests: [], startedAt: 0, completedAt: 0 });
    // Integration must persist this identity before handing bytes to the engine.
    try {
      if (this.options.persistSubmission) await this.options.persistSubmission({ ...this.receipt(record),
        text: record.text, content: record.content, metadata: record.metadata, createdAt: record.createdAt });
    } catch (error) {
      record.status = 'rejected'; record.reject(error); this.active = null;
      this.update({ state: 'failed', reason: '无法保存 Claude 提交记录：' + error.message, submission: this.receipt(record) });
      this.emit('action-error', error.message);
      // Do not advance following work across a failed persistence boundary.
      this.unreconciled = true;
      return;
    }
    if (this.closed) { record.reject(protocolError('Session closed before submission', 'CLAUDE_CLOSED')); return; }
    if (record.cancelled) {
      this.cancelBeforeSend(record);
      this.pump().catch(error => this.disconnect(error));
      return;
    }
    record.timer = setTimeout(() => {
      this.receiptDeadline(record).catch(error => this.disconnect(error));
    }, this.options.submissionTimeoutMs || NATIVE_CONFIRMATION_MS);
    try {
      record.writeStarted = true;
      await this.client.write({ type: 'user', uuid: record.userMessageId, session_id: this.sessionId,
        parent_tool_use_id: null, message: { role: 'user', content: record.content }, origin: { kind: 'human' } });
    } catch (error) { this.disconnect(error); }
  }

  // The deadline asks the engine's own transcript before calling the input
  // unknown: an API outage delays the echo, not the receipt.
  async receiptDeadline(record) {
    if (record.accepted || this.active !== record) return;
    if (await this.confirmFromHistory(record)) return;
    if (record.accepted || this.active !== record || this.closed) return;
    this.disconnect(protocolError('Claude 未确认本条输入，提交状态待核对', 'CLAUDE_SUBMISSION_TIMEOUT'));
  }

  // Receipt from the transcript row the engine wrote under this exact UUID and
  // content (see claude-receipt-probe). Only the same live writer and epoch may
  // use it; it never replays and never settles the turn's outcome.
  confirmFromHistory(record) {
    if (record.accepted) return Promise.resolve(true);
    if (this.active !== record || !record.writeStarted || this.closed) return Promise.resolve(false);
    if (record.historyProbe) return record.historyProbe;
    const client = this.client, epoch = this.runtime.epoch;
    record.historyProbe = (async () => {
      let verdict;
      try {
        verdict = await probeSubmissionReceipt(this.historyPath(), { sessionId: this.sessionId,
          userMessageId: record.userMessageId, matches: row => this.echoMatches(row, record) });
      } catch (error) {
        this.emit('diagnostic', { type: 'receipt-probe-failed', message: error.message });
        return false;
      }
      if (record.accepted) return true;
      if (verdict !== 'received' || this.closed || this.active !== record || this.client !== client
          || this.runtime.epoch !== epoch || client?.failure || this.reconnecting || this.reconnectPending) return false;
      this.acceptSubmission(record, 'history');
      return true;
    })().finally(() => { record.historyProbe = null; record.historyProbedAt = Date.now(); });
    return record.historyProbe;
  }

  acceptSubmission(record, source) {
    clearTimeout(record.timer);
    const recovery=this.lateAckRecovery;
    const confirmedLateAck=recovery?.record === record && recovery.client === this.client
      && recovery.epoch === this.runtime.epoch && this.runtime.connection === 'connected'
      && !this.client.failure && !this.reconnecting && !this.reconnectPending;
    record.accepted = true; record.status = 'accepted'; record.acceptedAt = Date.now(); record.receiptSource = source;
    this.lifecycle('submission-accepted', record, { status: 'accepted', accepted: true, acceptedAt: record.acceptedAt }, () => {
      // Exact receipt from the same live writer proves delivery even after the
      // local acknowledgement deadline. It cannot clear other failures.
      if (confirmedLateAck) {this.unreconciled=false;this.lateAckRecovery=null;}
      this.update({ state: this.unreconciled ? 'unknown' : 'starting', submission: this.receipt(record),
        reason: this.unreconciled ? 'Claude 已确认收到输入，但连接或历史状态仍需核对' : 'Claude 已收到输入，等待执行' });
    });
    if (source === 'history') this.backstage.note('提交确认', 'Claude 原生历史已记录这条输入；等待模型开始输出');
    record.resolve(this.receipt(record));
  }

  cancelBeforeSend(record) {
    this.lifecycle('submission-cancelled', record, { status: 'interrupted', accepted: false }, () => {
      this.queue = this.queue.filter(item => item !== record);
      if (this.active === record) this.active = null;
      record.status = 'interrupted';
      this.update({ state: 'interrupted', reason: '消息在发送前已取消', completedAt: Date.now(), submission: this.receipt(record) });
    });
    record.reject(protocolError('Claude submission cancelled before transmission', 'CLAUDE_SUBMISSION_CANCELLED'));
  }

  disconnect(error) {
    if (this.closed) return;
    if (this.cancellation) { clearTimeout(this.cancellation.timer); this.cancellation = null; }
    this.print('\n[连接中断] ' + (error && error.message || '') + '\n');
    this.unreconciled = true;
    const record = this.active;
    this.lateAckRecovery = error.code === 'CLAUDE_SUBMISSION_TIMEOUT' && record
      ? {record,client:this.client,epoch:this.runtime.epoch} : null;
    if (record) {
      clearTimeout(record.timer);
      if (!TERMINAL.has(record.status)) record.status = 'unknown';
      record.reject(error);
    }
    this.update({ connection: this.client?.failure ? 'disconnected' : this.runtime.connection,
      state: 'unknown', requests: [], reason: error.message,
      ...(this.runtime.cancellation ? {cancellation:{...this.runtime.cancellation,status:'unknown'}} : {}),
      submission: record ? this.receipt(record) : this.runtime.submission });
    // A missing receipt is a state, already shown by the composer, and a late
    // echo or transcript row may still clear it. As an action error it lingered
    // in red after that recovery -- only a reconnect cleared it.
    if (error.code === 'CLAUDE_SUBMISSION_TIMEOUT') this.backstage.note('提交确认', error.message, 'warning');
    else this.emit('action-error', error.message);
  }

  message(message) {
    if (this.closed) return;
    if (message.session_id && message.session_id !== this.sessionId) {
      this.emit('diagnostic', { type: 'foreign-session', sessionId: message.session_id }); return;
    }
    if (message.type === 'result' && message.uuid && this.completedResultIds.has(message.uuid)) return;
    const identity = message.uuid && message.type + ':' + message.uuid;
    if (identity && this.seen.has(identity)) return;
    if (identity) {
      this.seen.add(identity);
      if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    }
    const record = this.active;
    let outputOwner = this.activities.owner(message, record);
    const isToolResult = message.type === 'user' && Array.isArray(message.message?.content)
      && message.message.content.some(block => block.type === 'tool_result');
    if (isToolResult) {
      if (outputOwner && !this.unreconciled) {
        this.activities.capture(outputOwner, message);
        this.persistLateOutput(outputOwner, message);
        this.emit('item', { message, userMessageId: outputOwner.userMessageId });
      }
      else this.emit('diagnostic', { type: 'unassociated-tool-result', messageId: message.uuid });
      return;
    }
    if (message.type === 'user' && !message.parent_tool_use_id && message.message?.role === 'user') {
      if (message.origin?.kind && message.origin.kind !== 'human') {
        // 后台任务通知只有在引擎空闲时才会被取出来单独跑一轮；主回合还在跑的
        // 时候 CLI 直接把它并进当前这一轮（原生 transcript 里记作
        // queue-operation remove / reason=absorbed_mid_turn），**不会**再回一条
        // 属于它自己的 result。为这种通知开一条后台活动就等于开一条永远等不到
        // 结局的记录 —— 2026-09-23 实测积了 77 条，把会话锁死在假的「工作中」，
        // 输出还因为归属歧义整轮不渲染。判据用引擎自己的判据：主回合在不在跑。
        //
        // 只对「续跑」类来源成立。channel 这种远端输入是另一场对话，它自己会有
        // result，并进主回合等于把别人的话算成这一轮的回答。
        const host = this.active;
        if (CONTINUATION_ORIGINS.has(message.origin.kind) && host && !TERMINAL.has(host.status) && !this.unreconciled) {
          // 不把通知正文塞进卡片：原生历史侧同样把 <task-notification> 过滤掉，
          // 这里只是让后续输出继续归主回合，不新增一行看不懂的用户消息。
          this.emit('item', { message, userMessageId: host.userMessageId });
          this.emit('diagnostic', { type: 'absorbed-continuation', origin: message.origin.kind,
            userMessageId: host.userMessageId });
          return;
        }
        // 引擎一次只跑一轮：新的注入回合开始，上一条还没结局的注入回合就不会
        // 再有结局。判它 unknown 并让状态变成「待核对」，卡片上立刻出现核对按钮，
        // 而不是无声无息地攒成一串永远清不掉的「工作中」。
        const abandoned = this.activities.abandonStale();
        const activity = this.activities.inject(message);
        if (abandoned.length) {
          this.activities.settleUnknown();
          this.backstage.note('后台活动', `${abandoned.length} 条后台活动没有收到结果，已记为结果未知；不会重发`);
        }
        this.update({});
        this.emit('item', { message, userMessageId: activity.userMessageId });
        return;
      }
      if (!record || message.uuid !== record.userMessageId) {
        this.emit('diagnostic', { type: 'unmatched-user', userMessageId: message.uuid }); return;
      }
      if (!this.echoMatches(message, record)) {
        this.disconnect(protocolError('Claude 回显正文与本次提交不同', 'CLAUDE_CONTENT_MISMATCH'));
        record.status = 'content-mismatch';
        this.update({ submission: this.receipt(record) }); return;
      }
      // Already accepted from the transcript: the echo only confirms it again.
      if (record.accepted) { clearTimeout(record.timer); return; }
      this.acceptSubmission(record, 'echo');
      return;
    }
    if (message.type === 'system') {
      // Every engine frame while the input is unconfirmed is a cheap moment to
      // look for the transcript row -- the first ones (init, status=requesting)
      // arrive within half a second, long before a slow API lets the echo out.
      if (record && !record.accepted && record.writeStarted && !record.historyProbe
          && Date.now() - (record.historyProbedAt || 0) >= 2000) {
        this.confirmFromHistory(record).catch(error => this.emit('diagnostic', { type: 'receipt-probe-failed', message: error.message }));
      }
      if (message.subtype === 'api_retry' && record) {
        this.update({ apiRetry: { attempt: Number(message.attempt) || 0, maxRetries: Number(message.max_retries) || 0,
          status: Number(message.error_status) || null, error: message.error || null,
          delayMs: Number(message.retry_delay_ms) || 0, at: Date.now(), userMessageId: record.userMessageId } });
      }
      if (message.subtype === 'init') {
        this.update({ actualModel: message.model, capabilities: {
          tools: message.tools || [], commands: message.slash_commands || [], mcpServers: message.mcp_servers || [],
          skills: message.skills || [], plugins: message.plugins || [],
          cliVersion: message.claude_code_version || '',
          epoch: this.runtime.epoch, sessionId: this.sessionId, observedAt: Date.now() } });
        // init 帧是本地 CLI 版本唯一可靠的来源，模型下拉靠它判断哪些新模型被
        // 版本挡住；顺带在缓存过期时后台刷新官方模型目录，这样「开一个新会话」
        // 就足以发现当天发布的新模型。内部不抛、不等网络。
        noteSessionStart(message.claude_code_version);
      }
      if (message.subtype === 'task_started' && message.task_id) {
        const owner = this.activities.toolOwners.get(message.tool_use_id) || outputOwner;
        this.tasks.set(message.task_id, { id: message.task_id, type: message.task_type,
          submissionId: owner?.submissionId || null, userMessageId: owner?.userMessageId || null });
      } else if (message.subtype === 'task_notification'
          || (message.subtype === 'task_updated' && TASK_TERMINAL.has(message.patch?.status))) {
        this.tasks.delete(message.task_id);
      }
      this.update({});
      this.emit('item', { message, userMessageId: record?.userMessageId || null });
      return;
    }
    if (message.type === 'result') {
      const origin = message.origin?.kind || 'human';
      if (origin !== 'human') {
        if (!message.session_id || this.unreconciled) return;
        const activity = this.activities.finish(message);
        if (message.uuid) this.completedResultIds.add(message.uuid);
        this.update({ requests: this.runtime.requests.filter(r => r.activityId !== activity.userMessageId) });
        this.emit('item', { message, userMessageId: activity.userMessageId });
        this.emit('diagnostic', { type: 'background-result', resultId: message.uuid, origin });
        this.pump().catch(error => this.disconnect(error));
        return;
      }
      if (!record || !record.accepted || this.unreconciled || !message.session_id) {
        this.emit('diagnostic', { type: 'unmatched-result', resultId: message.uuid }); return;
      }
      this.activities.resolveSegment(record);
      this.finish(record, message); return;
    }
    // A root assistant frame with no owner is the start of an engine-initiated
    // turn whose injected input has not been replayed yet (see beginProvisional).
    if (!outputOwner && !record && !this.unreconciled && !message.parent_tool_use_id
        && (message.type === 'assistant' || message.type === 'stream_event')) {
      outputOwner = this.activities.beginProvisional();
      this.update({});
    }
    if (!outputOwner || (!outputOwner.nativeActivity && !outputOwner.accepted) || this.unreconciled) {
      this.emit('diagnostic', { type: 'unassociated-event', messageType: message.type }); return;
    }
    if (message.type === 'assistant' || message.type === 'stream_event') {
      if (this.runtime.apiRetry) this.update({ apiRetry: null });
      this.activities.capture(outputOwner, message);
      if (message.type === 'assistant') this.persistLateOutput(outputOwner, message);
      if (outputOwner === record && !record.started && !message.parent_tool_use_id && !this.activities.ambiguous) {
        record.started = true;
        record.startedAt = Date.now();
        this.update({ state: this.runtime.requests.length ? 'waiting' : 'running', startedAt: record.startedAt, reason: null });
        this.lifecycle('agent-turn-started', record, { status: 'running', accepted: true, startedAt: record.startedAt });
      }
      if (message.type === 'assistant') {
        this.items.set(message.message?.id || message.uuid, message);
        if (typeof message.message?.model === 'string' && message.message.model) outputOwner.model = message.message.model;
        // A slash command is executed by the engine itself and answered with a
        // local_command_source frame instead of a model reply. Keep that output
        // separate so the composer can report it as a command result.
        if (typeof message.local_command_source === 'string') {
          outputOwner.localCommand = true;
          const rendered = textOf(message.message?.content) || message.local_command_source;
          outputOwner.commandOutput = outputOwner.commandOutput ? outputOwner.commandOutput + '\n' + rendered : rendered;
        }
        if (!message.parent_tool_use_id && !this.activities.ambiguous) outputOwner.finalText = textOf(message.message?.content);
      }
      const delta = message.type === 'stream_event' && message.event?.delta?.type === 'text_delta'
        ? message.event.delta.text : null;
      if (delta) this.print(delta);
      this.emit('item', { message, userMessageId: outputOwner.userMessageId });
    } else this.emit('diagnostic', { type: 'unsupported-event', messageType: message.type });
  }

  finish(record, message) {
    clearTimeout(record.timer);
    const interrupted = ['aborted_streaming', 'aborted_tools'].includes(message.terminal_reason);
    const failed = message.is_error === true || message.subtype !== 'success';
    const status = interrupted ? 'interrupted' : failed ? 'failed' : 'completed';
    const completedAt = Date.now();
    record.resultId = message.uuid;
    record.finalText = typeof message.result === 'string' ? message.result : record.finalText;
    // The engine reports this turn's tokens on the result frame; the cards
    // showed them for every Claude turn before the native transport.
    if (message.usage && typeof message.usage === 'object') record.usage = message.usage;
    record.result = message;
    const reason = failed ? (message.errors?.join('; ') || message.result || message.subtype) : null;
    this.lifecycle('agent-turn-complete', record, { status, text: record.finalText,
      accepted: true, completedAt, transcriptMessages: [...(record.messages?.values() || [])],
      providerResultId: message.uuid, result: message }, () => {
      record.status = status;
      record.completedAt = completedAt;
      if (message.uuid) this.completedResultIds.add(message.uuid);
      this.active = null;
      this.update({ state: status, completedAt, apiRetry: null,
        requests: this.runtime.requests.filter(r => r.submissionId !== record.submissionId), reason,
        submission: this.receipt(record), resultId: message.uuid });
    });
    if (this.options.historyTitle) {
      try { this.rename(this.options.historyTitle); }
      catch (error) { this.emit('action-error', 'Hub 名称已保存；Claude 历史同步失败：' + error.message); }
    }
    this.refreshContext().catch(error => this.emit('action-error', '上下文用量读取失败：' + error.message));
    this.pump().catch(error => this.disconnect(error));
  }

  // Only frames that arrive after the record settled need their own durable
  // write; frames of a running record are covered by its terminal snapshot.
  // Each late frame is appended alone -- re-saving the whole transcript per
  // frame grew one session's journal to 378 MB (measured 2026-09-13).
  persistLateOutput(record, frame) {
    if (!TERMINAL.has(record.status)) return;
    if (record.nativeActivity) this.activities.saveAppended(record, frame);
    else this.lifecycle('transcript-appended', record, { status: record.status, text: record.finalText,
      transcriptAppend: [frame] });
  }

  request(message) {
    if (this.cancellation) {
      this.client.respond(message.request_id, {behavior:'deny',message:'该轮正在停止，旧请求已取消'})
        .catch(error=>this.disconnect(error));
      return;
    }
    const r = message.request;
    if (r.subtype !== 'can_use_tool') {
      const reason = 'Hub 尚未支持 Claude 控制请求：' + r.subtype;
      this.emit('action-error', reason);
      this.client.respond(message.request_id, null, reason).catch(error => this.disconnect(error));
      return;
    }
    const owner = this.activities.toolOwners.get(r.tool_use_id) || this.activities.current || this.active;
    const request = { id: message.request_id, submissionId: owner?.submissionId || null,
      activityId: owner?.nativeActivity ? owner.userMessageId : null,
      epoch: this.runtime.epoch, method: r.tool_name === 'AskUserQuestion'
      ? 'claude/requestUserInput' : 'claude/requestApproval', params: { ...r.input,
        toolName: r.tool_name, toolUseId: r.tool_use_id, suggestions: r.permission_suggestions }, raw: r };
    this.update({ state: 'waiting', requests: [...this.runtime.requests, request], reason: null });
  }

  async respond(requestId, decision, identity = null) {
    if (this.cancellation) throw protocolError('该轮正在停止，审批已失效', 'CLAUDE_STALE_REQUEST');
    const request = this.runtime.requests.find(r => r.id === requestId);
    if (!request) throw protocolError('Claude request no longer active', 'CLAUDE_STALE_REQUEST');
    if (identity && (identity.epoch !== request.epoch || identity.submissionId !== request.submissionId)) {
      throw protocolError('Claude request belongs to a different turn or connection', 'CLAUDE_STALE_REQUEST');
    }
    if (!decision || !['allow', 'deny'].includes(decision.behavior)) throw new Error('Explicit allow/deny decision required');
    const response = decision.behavior === 'deny' ? { behavior: 'deny', message: decision.message || '用户拒绝' }
      : { behavior: 'allow', updatedInput: decision.updatedInput || request.raw.input };
    if (decision.updatedPermissions) response.updatedPermissions = decision.updatedPermissions;
    let revoked = false;
    await this.client.respond(requestId, response, null, value => {
      revoked = !!this.cancellation || this.closed || request.epoch !== this.runtime.epoch
        || this.runtime.connection !== 'connected' || !this.runtime.requests.includes(request);
      return revoked ? {behavior:'deny',message:'原操作已失效，未继续执行'} : value;
    });
    if (revoked) throw protocolError('该轮操作已失效，未继续执行', 'CLAUDE_STALE_REQUEST');
    const requests = this.runtime.requests.filter(r => r.id !== requestId);
    const stillOwnsTurn = request.epoch === this.runtime.epoch && request.submissionId === (this.active?.submissionId || null);
    this.update({ requests, ...(stillOwnsTurn ? { state: this.unreconciled ? 'unknown'
      : requests.length ? 'waiting' : this.active?.accepted ? 'running' : this.runtime.state } : {}) });
  }

  // 超时的停止只剩一个「结果待核对」的标记，它不该继续冒充「正在停止」去挡住
  // 核对和后续操作。清掉它不等于认定 Claude 已停 —— 状态仍然是 unknown。
  clearUnresolvedStop() {
    if (!this.cancellation?.unresolved) return false;
    clearTimeout(this.cancellation.timer);
    this.cancellation = null;
    this.update({ cancellation: null });
    return true;
  }

  async interrupt() {
    if (this.cancellation) return {requested:true};
    if (this.runtime.connection === 'connecting' && this.client) {
      await this.close();
      this.update({ state: 'interrupted', connection: 'disconnected', requests: [], reason: 'Claude 启动已取消' });
      return { requested: true, cancelledStartup: true };
    }
    if (this.runtime.connection !== 'connected') await this.start();
    if (this.cancellation) return {requested:true};
    const pending = this.active || this.queue[0];
    if (pending && !pending.writeStarted) {
      pending.cancelled = true;
      return { requested: true, cancelledBeforeSend: true };
    }
    if (!this.active && !this.runtime.requests.length && !this.activities.live().length && !this.tasks.size) {
      return { interrupted: false, reason: 'idle' };
    }
    const client=this.client, epoch=this.runtime.epoch, requestedAt=Date.now();
    const cancellation={epoch,requestedAt,deadlineAt:requestedAt+(this.options.cancelTimeoutMs || NATIVE_CONFIRMATION_MS),
      hadWork:!!(this.active || this.activities.pending().length || this.tasks.size)};
    this.cancellation=cancellation;
    const requests=this.runtime.requests;
    this.update({requests:[],cancellation:{status:'pending',userMessageId:this.active?.userMessageId || null,
      requestedAt,deadlineAt:cancellation.deadlineAt}});
    const failCancellation = error => {
      if (this.cancellation !== cancellation || this.client !== client || this.runtime.epoch !== epoch) return;
      // Elapsed time cannot prove that the writer stopped. Keep consuming the
      // same stream so its terminal receipt can still settle this cancellation.
      // 但从这一刻起它不再是「正在停止」，而是「停止结果待核对」：写入闸门照旧
      // 关着，核对这条出路必须打开，否则会话再也回不来。
      cancellation.unresolved = true;
      this.update({state:'unknown',reason:error.message,
        cancellation:{...this.runtime.cancellation,status:'unknown'}});
      this.emit('action-error', error.message);
    };
    cancellation.timer=setTimeout(()=>failCancellation(protocolError('Claude 停止未在期限内确认，结果待核对；不会自动重发','CLAUDE_CANCEL_TIMEOUT')),
      Math.max(1,cancellation.deadlineAt-Date.now()));
    try {
      // Replies already in writeQueue recheck the cancellation at their actual
      // write; remaining requests are denied without exposing stale buttons.
      for (const request of requests) if(client.requests?.has(request.id))
        await client.respond(request.id,{behavior:'deny',message:'用户已停止本轮'});
      for (const task of this.tasks.values()) await client.control({ subtype: 'stop_task', task_id: task.id });
      await client.control({ subtype: 'interrupt' });
    } catch (error) { failCancellation(error); throw error; }
    return { requested: true }; // Only the terminal_reason confirms interruption.
  }

  async changeConfiguration(request, apply) {
    const client = this.client, epoch = this.runtime.epoch;
    const response = client.control(request, undefined, {reconcileLate:true});
    let reportedUnknown = false;
    const confirmation = (response.confirmation || response).then(value => {
      if (this.closed || this.client !== client || this.runtime.epoch !== epoch) {
        throw protocolError('旧连接的设置回执已失效', 'CLAUDE_STALE_CONFIGURATION');
      }
      return apply(value);
    });
    const pending = confirmation.finally(() => {
      if (this.configurationChange !== pending) return;
      this.configurationChange = null;
      if (!this.closed && this.client === client && this.runtime.epoch === epoch) this.update({configurationChange:null});
    });
    pending.catch(error => { if (reportedUnknown) this.emit('action-error', '设置核对结束：' + error.message); });
    this.configurationChange = pending;
    this.update({configurationChange:{status:'pending',operation:request.subtype,requestedAt:Date.now()}});
    try { await response; return await pending; }
    catch (error) {
      if (error.uncertain && this.configurationChange === pending && this.client === client && this.runtime.epoch === epoch) {
        reportedUnknown = true;
        this.update({configurationChange:{...this.runtime.configurationChange,status:'unknown',reason:error.message}});
      }
      throw error;
    }
  }

  async setModel(model) {
    await this.start();
    if (this.active || this.queue.length || this.activities.pending().length || [...this.tasks.values()].some(task => DELEGATED.has(task.type))
        || this.unreconciled || this.configurationChange || this.reconnectPending) {
      throw new Error('请等待当前任务和模型设置结束并核对提交状态后切换模型');
    }
    return this.changeConfiguration({ subtype: 'set_model', model }, () => {
      const args = [...(this.options.launchArgs || [])];
      const index = args.indexOf('--model');
      if (index >= 0) args[index + 1] = model; else args.push('--model', model);
      this.options = { ...this.options, launchArgs: args };
      this.update({ actualModel: model });
    });
  }

  // Fast is Claude's equivalent of the Codex speed tier.  apply_flag_settings
  // merges it into the engine's flag-settings layer, which is exactly the layer
  // --settings populates, so the switch stays scoped to this session instead of
  // writing the user's settings files the way /fast and update_settings do.
  // Only the control response confirms it; a rejection is surfaced, never
  // reported as a successful switch.
  // Slash commands. Measured on Claude Code 2.1.269: the engine executes its own
  // commands when they arrive as ordinary user text and answers with a
  // local_command_source frame, no model call. So the Hub forwards them instead
  // of hand-mapping a short list, and only intercepts the three whose result it
  // also displays -- model, speed and working mode would otherwise drift out of
  // sync with the chips.
  async slash(text, options = {}) {
    const line = String(text).trim();
    const space = line.search(/\s/);
    const command = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const value = space < 0 ? '' : line.slice(space).trim();
    const done = output => ({ ok: true, sendStatus: 'ok', mode: 'native-command',
      commandOutput: String(output || ''), enterAttempts: 0, acknowledgementSource: BACKEND });
    if (command === '/plan' && (!value || value === 'off')) {
      const mode = value === 'off' ? 'default' : 'plan';
      const applied = await this.setPermissionMode(mode);
      return done('工作方式：' + (applied.permissionMode === 'plan' ? '计划（只讨论不改文件）' : '默认') + '。');
    }
    if (command === '/model' && value) {
      await this.setModel(value);
      return done('模型已切换：' + value);
    }
    if (command === '/fast' && ['on', 'off'].includes(value)) {
      const applied = await this.setFastMode(value === 'on');
      return done('速度：' + (applied.fastMode ? 'Fast' : '标准') + (applied.warning ? ' · ' + applied.warning : ''));
    }
    // Everything else is the engine's own command. Wait for its result so the
    // composer reports the real output rather than "sent".
    const receipt = await this.submit(line, { ...options, localCommand: true });
    const record = this.records.get(receipt.clientSubmissionId);
    if (!record) throw new Error('命令提交记录缺失，执行结果无法确认');
    await record.ack;
    const deadline = Date.now() + (this.options.commandTimeoutMs || 120000);
    while (!TERMINAL.has(record.status) && Date.now() < deadline && !this.closed) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!TERMINAL.has(record.status)) {
      // Never claim an unconfirmed command succeeded; the card still shows it.
      return { ok: false, sendStatus: 'stuck', mode: 'native-command', enterAttempts: 0,
        message: '命令已发出，但引擎尚未返回结果；请看卡片或后台' };
    }
    if (record.status !== 'completed') {
      throw new Error('命令未完成：' + record.status);
    }
    return done(record.commandOutput || record.finalText || '命令已执行。');
  }

  // Thinking effort. The engine owns this as its own command, and answers an
  // unsupported level with an ordinary command message rather than an error --
  // so the reply is checked before the chip is allowed to move.
  async setEffort(level) {
    const normalized = String(level || '').trim().toLowerCase();
    if (!EFFORT_LEVELS.has(normalized)) throw new Error('思考档无效：' + level);
    const result = await this.slash('/effort ' + normalized);
    const output = String(result.commandOutput || '');
    if (!new RegExp('set effort level to ' + normalized + '(?![a-z])', 'i').test(output)) {
      throw new Error(output.trim().slice(0, 200) || '引擎未确认思考档切换');
    }
    if (EFFORT_LAUNCH_LEVELS.has(normalized)) {
      const args = [...(this.options.launchArgs || [])];
      const index = args.indexOf('--effort');
      if (index >= 0) args[index + 1] = normalized; else args.push('--effort', normalized);
      this.options = { ...this.options, launchArgs: args };
    }
    this.update({ effort: normalized });
    return { effort: normalized, output };
  }

  // Codex exposes plan mode as a collaboration mode; Claude's equivalent is the
  // permission mode, which the engine accepts mid-session and echoes back. The
  // echoed value is what gets stored -- a requested mode is not a confirmed one.
  async setPermissionMode(mode) {
    await this.start();
    if (this.active || this.queue.length || this.configurationChange || this.reconnectPending || this.unreconciled) {
      throw new Error('请等当前任务结束并核对提交状态后再切换工作方式');
    }
    return this.changeConfiguration({ subtype: 'set_permission_mode', mode }, value => {
      const applied = value?.mode || mode;
      const args = [...(this.options.launchArgs || [])];
      const index = args.indexOf('--permission-mode');
      if (index >= 0) args[index + 1] = applied; else args.push('--permission-mode', applied);
      this.options = { ...this.options, launchArgs: args };
      this.update({ permissionMode: applied });
      return { permissionMode: applied };
    });
  }

  async setFastMode(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('速度设置无效');
    await this.start();
    if (this.active || this.queue.length || this.configurationChange || this.reconnectPending || this.unreconciled) {
      throw new Error('请等当前任务和配置切换结束并核对提交状态后再切换速度');
    }
    return this.changeConfiguration({ subtype: 'apply_flag_settings', settings: { fastMode: enabled } }, () => {
      // Durability is best effort and must not claim the engine failed: the
      // tier is already live.  A failed overlay write is reported as a warning
      // so the next relaunch is not silently different from what the UI shows.
      let overlayWarning = null;
      if (this.options.settingsFile) {
        try { require('./claude-native-launch').mergeClaudeSettingsFile(this.options.settingsFile, { fastMode: enabled }); }
        catch (error) { overlayWarning = '速度已生效，但重连后可能回到启动时的设置：' + error.message; }
      }
      this.options = { ...this.options, fastMode: enabled };
      this.update({ fastMode: enabled, fastModeBlocked: null });
      return { fastMode: enabled, ...(overlayWarning ? { warning: overlayWarning } : {}) };
    });
  }

  // Account quota, read from the engine rather than the status line (see
  // core/claude-native-usage.js). Returns null when this connection cannot
  // answer, so a caller falls back instead of publishing an invented figure.
  async readAccountUsage() {
    if (this.closed || this.runtime.connection !== 'connected' || !this.client) return null;
    const client = this.client;
    const response = await client.control({ subtype: 'get_usage' });
    if (this.client !== client || this.closed) return null;
    return require('./claude-native-usage').claudeAccountUsageFromControl(response);
  }

  // The quota watchdog's wait rides on the runtime snapshot rather than a
  // channel of its own, so the composer reads "等额度恢复" from the same place
  // it reads every other state of this session (main/claude-quota-resume.js).
  setQuotaWait(wait) {
    if (this.closed) return;
    const current = this.runtime.quotaWait || null;
    if (JSON.stringify(current) === JSON.stringify(wait || null)) return;
    this.update({ quotaWait: wait || null });
  }

  historyPath() { return findNativeClaudeHistory(this.sessionId, this.options); }

  async refreshContext() {
    const client = this.client;
    const epoch = this.runtime.epoch;
    const userMessageId = this.runtime.userMessageId;
    try {
      const usage = await client.control({ subtype: 'get_context_usage' });
      if (this.closed || this.client !== client || this.runtime.epoch !== epoch || this.runtime.userMessageId !== userMessageId) return;
      if (![usage.totalTokens, usage.maxTokens, usage.percentage].every(Number.isFinite)
          || usage.totalTokens < 0 || usage.maxTokens <= 0) throw new Error('Claude 返回的上下文用量无效');
      this.emit('usage', usage);
      return usage;
    } catch (error) {
      if (this.closed || this.client !== client || this.runtime.epoch !== epoch || this.runtime.userMessageId !== userMessageId) return;
      throw error;
    }
  }

  rename(title) {
    const result = renameNativeClaudeHistory(this.sessionId, title, this.options);
    this.options.historyTitle = result.status === 'deferred' ? title : null;
    return result;
  }

  recoveryRecords() {
    const submissions = [...this.records.values()].filter(record => !TERMINAL.has(record.status) && !record.reconciliation)
      .map(record => ({ submissionId: record.submissionId, userMessageId: record.userMessageId,
        promptFingerprint: record.fingerprint, text: record.text, content: record.content,
        status: record.status, accepted: record.accepted, epoch: this.runtime.epoch }));
    return submissions.concat(this.activities.pending().map(record => ({ activityId: record.userMessageId,
      userMessageId: record.userMessageId, promptFingerprint: digest(record.content || ''),
      nativeActivity: true, text: 'Claude 后台活动，原状态：' + record.status,
      status: record.status, epoch: this.runtime.epoch })));
  }

  async reconnect({ stopActive = false } = {}) {
    if (this.reconnectPending) throw new Error('Claude 正在重连');
    // A seat that never started has no connection to rebuild and no submission
    // to reconcile; going through the reconnect path would mark it unreconciled
    // and block its first dispatch.
    if (this.runtime.connection === 'unstarted') return this.runtime;
    this.reconnectPending = true;
    try { return await this._reconnect({ stopActive }); }
    finally { this.reconnectPending = false; }
  }

  async _reconnect({ stopActive = false } = {}) {
    if (this.reconnecting) throw new Error('Claude 正在重连');
    const priorClose = this.closePromise;
    if (priorClose) await priorClose;
    const busy = this.active || this.activities.live().length || this.tasks.size;
    if (stopActive && busy && !this.unreconciled) await this.interrupt();
    if (!stopActive && !this.unreconciled && busy) throw new Error('请先停止当前任务，再重连');
    this.reconnecting = true; this.recoveryReady = false;
    this.unreconciled = true;
    const old = this.client;
    try {
      // End only this owned writer before a new connection may send anything.
      if (old) await old.close();
      if (this.closePromise !== priorClose) throw protocolError('Claude session closed during reconnect', 'CLAUDE_CLOSED');
      if (this.lease) { ownership.releaseThread(this.lease); this.lease = null; }
      for (const record of this.records.values()) {
        clearTimeout(record.timer);
        if (!TERMINAL.has(record.status) && !record.reconciliation) {
          record.status = 'unknown';
          record.reject(protocolError('Claude 已重连；旧提交须核对，不会自动重发', 'CLAUDE_SUBMISSION_UNKNOWN'));
        }
      }
      this.activities.recoverTasks(this.tasks.values(), this.runtime.epoch);
      this.queue = []; this.active = null; this.seen.clear(); this.tasks.clear();
      this.activities.reset();
      this.activities.settleUnknown();
      this.runtime = initialRuntime(this.sessionId, this.runtime);
      this.options = { ...this.options, restoredRuntime: null, fork: false,
        resumeSessionId: this.historyPath() ? this.sessionId : undefined };
      this.client = null; this.ready = null; this.closed = false; this.closePromise = null;
      if (this.backstage.closed) this.backstage = new (require('./claude-backstage').ClaudeBackstage)(this);
      this.unreconciled = this.recoveryRecords().length > 0;
      this.reconnecting = false;
      await this.start();
      this.recoveryReady = true;
      this.update({});
      return this.runtime;
    } catch (error) {
      this.reconnecting = false;
      this.update({ state: 'unknown', connection: 'disconnected', reason: error.message });
      throw error;
    }
  }

  // Only the explicit composer send calls this. Background/group dispatch keeps
  // its unknown-attempt gate; a quiet recovery never completes or replays it.
  prepareForNewPrompt() {
    if (this.promptRecovery) return this.promptRecovery;
    this.promptRecovery = this._prepareForNewPrompt().finally(() => { this.promptRecovery = null; });
    return this.promptRecovery;
  }

  async _prepareForNewPrompt() {
    if (this.closed) throw new Error('会话正在关闭，未发送');
    if (!this.unreconciled && this.runtime.connection !== 'disconnected') return;
    if (this.configurationChange) throw new Error('正在更新设置，请稍后发送');
    if (this.cancellation) throw new Error('正在停止，请等待结束后发送');
    // A timed-out input the live writer did record is still being worked on
    // (2026-09-24: 529 retries). Reconnecting here killed it mid-retry and the
    // engine resumed with "No response requested."; confirm it instead and let
    // the new prompt queue behind it.
    const late = this.lateAckRecovery;
    if (late?.client === this.client && late.record === this.active && this.runtime.connection === 'connected'
        && await this.confirmFromHistory(late.record) && !this.unreconciled) return;
    // reconnect waits for this owned writer to exit before resuming the UUID.
    await this.reconnect();
    await this.reconcileFromHistory({ source: 'hub' });
  }

  // 唯一的「拿原生历史核对上一轮」入口：连上时的自动核对、手点核对、发送前恢复都走它。
  //
  // 它只读 transcript，只登记 do-not-replay，既不重发旧消息，也不把旧任务改写成
  // 成功 —— 记录状态留在 unknown，reconciliation 里存下看到的证据字串
  // （received / not-found / history-missing）。
  //
  // 前置条件是这个 writer 刚由 start() 建立：start() 会先确认旧 writer 已退出
  // （CLAUDE_WRITER_ACTIVE）并抢到归属，所以此刻没有别的进程在追加这份历史，
  // 旧提交也不可能还在跑。
  //
  // 2026-09-24 以前，连上时的自动路径更严：找不到历史、或只剩后台活动时停下来
  // 等人点「核对上次任务」。那个按钮能做的也只是同样的登记，用户明确说这种提示
  // 很蠢、不要再弹，所以普通会话自动走完整语义。群聊 / 无人值守席位在 _start 里
  // 根本不自动核对，那里停下来防重复派工的关卡不变。
  async reconcileFromHistory({ source = 'hub' } = {}) {
    if (this.closed) throw new Error('会话正在关闭，未核对');
    if (this.configurationChange) throw new Error('正在更新设置，请稍后核对');
    // 停止还在期限内就等它确认；已经超时的那一条本身就是「结果待核对」，
    // 再用它去挡核对，就是用问题挡住问题唯一的出路。
    if (this.cancellation && !this.cancellation.unresolved) throw new Error('正在停止，请等待结束后核对');
    if (this.reconnecting || this.runtime.connection !== 'connected') throw new Error('连接尚未就绪，未核对');
    if (!this.unreconciled && !(this.recoveryRecords().length || this.cancellation)) {
      return { reconciled: 0, pending: 0, skipped: 0 };
    }
    const epoch = this.runtime.epoch;
    const records = this.recoveryRecords();
    if (!records.length) {
      // 没有待核对的记录（例如只剩一个持久化的「上一轮没结论」）就是没有东西要核对。
      this.recoveryReady = true;
      this.unreconciled = false;
      this.clearUnresolvedStop();
      this.update({ state: this.runtime.requests.length ? 'waiting' : 'idle', reason: null });
      return { reconciled: 0, pending: 0, skipped: 0 };
    }
    const evidence = await require('./claude-recovery-history').inspect(this, records);
    if (this.closed || this.runtime.epoch !== epoch || this.runtime.connection !== 'connected') {
      throw new Error('恢复期间连接已变化，未核对；本次没有发送任何消息');
    }
    this.recoveryReady = true;
    // 核对就是这次没确认的停止的结论：不重发、也不追认成功。先解掉它，
    // 后面每一次 update 才能发布真实状态而不是继续念「停止结果待核对」。
    this.clearUnresolvedStop();
    for (const record of records) {
      const history = evidence.get(record.userMessageId) || 'no-user-message';
      this.reconcile({ ...record, resolution: 'do-not-replay' }, { source, history });
    }
    this.backstage.note('会话恢复', '旧任务结果保留原状；未重发旧消息，可以接收新消息。');
    return { reconciled: records.length, pending: this.recoveryRecords().length, skipped: 0 };
  }

  reconcile(identity, { source = 'user', history } = {}) {
    const record = identity.activityId ? this.activities.records.get(identity.activityId) : this.records.get(identity.submissionId);
    const fingerprint = record?.nativeActivity ? digest(record.content || '') : record?.fingerprint;
    if (!this.recoveryReady || this.runtime.connection !== 'connected' || this.reconnecting
        || !record || TERMINAL.has(record.status) || record.reconciliation
        || identity.epoch !== this.runtime.epoch || identity.userMessageId !== record.userMessageId
        || identity.promptFingerprint !== fingerprint || identity.resolution !== 'do-not-replay') {
      throw protocolError('核对信息已变化，请重新查看本条记录', 'CLAUDE_STALE_RECONCILIATION');
    }
    const reconciliation = { source, resolution: identity.resolution, at: Date.now(), epoch: identity.epoch,
      ...(history ? { history } : {}) };
    if (record.nativeActivity) {
      this.activities.save({ ...record, status: 'unknown', reconciliation });
      Object.assign(record, { status: 'unknown', reconciliation });
      this.unreconciled = this.recoveryRecords().length > 0;
      this.update({ state: this.unreconciled ? 'unknown' : 'idle', reason: this.unreconciled ? '还有旧活动需要核对' : null });
      return { ok: true, activityId: record.userMessageId, sendStatus: 'unknown' };
    }
    // Administrative acknowledgement never invents a successful engine result.
    this.lifecycle('submission-reconciled', record, { status: 'unknown', reconciliation }, () => {
      record.reconciliation = reconciliation;
      this.unreconciled = this.recoveryRecords().length > 0;
      this.update({ state: this.unreconciled ? 'unknown' : 'idle',
        reason: this.unreconciled ? '还有旧提交需要核对' : '已核对旧提交，不会自动重发', submission: null });
    });
    return this.receipt(record);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (this.cancellation) { clearTimeout(this.cancellation.timer); this.cancellation=null; }
    this.closed = true;
    this.closePromise = Promise.resolve().then(async () => {
      for (const record of this.records.values()) {
        clearTimeout(record.timer);
        if (record.status === 'queued' || record.status === 'submitting') record.reject(protocolError('Claude session closed', 'CLAUDE_CLOSED'));
      }
      if (this.client) await this.client.close();
      this.backstage.close();
      if (this.lease) { ownership.releaseThread(this.lease); this.lease = null; }
      // A shutdown waiter may attach after the child already crashed (or
      // before startup). Do not wait for another impossible OS exit event.
      // This is resource closure only; unknown submissions retain their state.
      this.emit('exit', { exitCode: 0, expected: true });
    });
    return this.closePromise;
  }
}

module.exports = { ClaudeNativeSession, BACKEND, contentBlocks, digest };
