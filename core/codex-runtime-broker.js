'use strict';

const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { CodexNativeSession } = require('./codex-native-session');
const { TERMINAL, isUnstartedRuntime } = require('./codex-native-runtime');
const { normalizedLaunch, prepareToolRoute } = require('./shared-runtime-tool-route');

const MUTATING_ACTIONS = new Set([
  'send', 'interrupt', 'reply', 'configure', 'configureMode', 'chooseThread', 'restartEmpty', 'reviewUnknownSubmission', 'reconnect',
  'submit','respond','setModel','setEffort','setPermissionMode','setFastMode','rename','slash','claude-reconcile',
]);

function normalizedHome(options) {
  const raw = options.nativeProvider==='claude' ? options?.env?.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude')
    : options?.env?.CODEX_HOME || path.join(require('os').homedir(), '.codex');
  const value = path.resolve(raw);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function threadIdentity(options, threadId) {
  return createHash('sha256').update(`${options.nativeProvider==='claude'?'claude\0':''}${normalizedHome(options)}\0${threadId}`).digest('hex');
}

function pendingIdentity(options) {
  return createHash('sha256').update(`${normalizedHome(options)}\0pending\0${options.id}`).digest('hex');
}

function recordIdentity(options) {
  if(options.nativeProvider==='claude')return threadIdentity(options,options.sessionId || options.resumeSessionId);
  // A fork source is not the identity of the new thread. Two independent
  // branch cards may fork the same source and must remain separate until each
  // receives its own returned thread id.
  const threadId = options.forkId ? null : (options.resumeId || options.restoredRuntime?.threadId);
  return threadId ? threadIdentity(options, threadId) : pendingIdentity(options);
}

function runtimeProfileFingerprint(options) {
  const env = options?.env || {};
  const relevantEnv = Object.keys(env).sort().filter(key =>
    key === 'PATH' || key === 'CODEX_HOME' || key === 'CLAUDE_CONFIG_DIR' || /^(ANTHROPIC|CLAUDE|OPENAI|CODEX|DEEPSEEK|HTTP|HTTPS|ALL_PROXY|NO_PROXY|SSL)_/i.test(key)
  ).filter(key=>!key.startsWith('CLAUDE_HUB_')).map(key => [key, env[key]]);
  return createHash('sha256').update(JSON.stringify({
    home:normalizedHome(options), cwd:path.resolve(options.cwd || options.threadParams?.cwd || '.'),
    launch:normalizedLaunch(options), relevantEnv,
  })).digest('hex');
}

function serializableOptions(options) {
  return JSON.parse(JSON.stringify(options, (_key, value) => typeof value === 'function' ? undefined : value));
}

class RuntimeRecord {
  constructor(broker, key, options) {
    this.broker = broker;
    this.key = key;
    this.options = { ...serializableOptions(options), id:options.nativeProvider==='claude'?options.id:`broker:${key.slice(0, 12)}`, sharedBroker:true };
    this.scopeFingerprint = runtimeProfileFingerprint(this.options);
    this.toolRoute = prepareToolRoute(this.options);
    try { this.session = broker.sessionFactory(this.options); }
    catch (error) { this.toolRoute?.dispose(); throw error; }
    this.views = new Map();
    this.controller = null;
    this.controllerEpoch = 1;
    this.reservations = new Map();
    this.started = null;
    this.exited = false;
    this.cleanupTimer = null;
    this.commandQueue = Promise.resolve();
    this.pendingCommands = 0;
    this.contentTimer = null;
    this.bindEvents();
  }
  bindEvents() {
    for (const name of ['data','state','thread-reset','choices','migration-draft','renamed','lifecycle','action-error','diagnostic','usage','session-usage','backstage-updated']) {
      this.session.on(name, (...args) => {
        if(name==='state' && args[0]?.connection==='connected')this.exited=false;
        // Terminal-only items must reach capture consumers before the state
        // and lifecycle events which cause them to read the transcript.
        if ((name === 'state' && TERMINAL.has(args[0]?.state)) || name === 'lifecycle') this.flushContent();
        if (name === 'lifecycle' && args[0]) args[0] = { ...args[0], hubSessionId:null };
        this.broadcast({ method:'session-event', params:{ key:this.key, event:name, args,
          ...(name==='lifecycle'?{controllerViewId:this.controller?.viewId,controllerEpoch:this.controllerEpoch}:{}) } });
        if (name === 'state') { this.broadcastControl(); this.scheduleCleanup(); this.broker.checkUpgrade?.(); }
      });
    }
    this.session.on('bound', bound => {
      const oldKey = this.key;
      const newKey = bound.threadId ? threadIdentity(this.options, bound.threadId) : oldKey;
      if (newKey !== oldKey) {
        const conflict = this.broker.records.get(newKey);
        if (conflict && conflict !== this) {
          this.session.emit('action-error', '该 Codex thread 已由共享服务中的另一条会话持有');
        } else {
          this.broker.records.delete(oldKey);
          this.key = newKey;
          this.broker.records.set(newKey, this);
        }
      }
      this.broadcast({ method:'session-event', params:{ key:this.key, previousKey:oldKey, event:'bound', args:[bound] } });
      if(bound.threadId)this.broadcastHistory();
      this.broadcastControl();
    });
    this.session.on('items', () => this.scheduleContent());
    this.session.once('exit', exit => {
      this.exited = true;
      this.broadcast({ method:'session-event', params:{ key:this.key, event:'exit', args:[exit] } });
      this.broadcastControl();
      this.scheduleCleanup();
    });
  }
  ensureStarted() {
    if (!this.started) {
      this.starting = true;
      this.started = Promise.resolve().then(() => this.session.start()).finally(() => { this.starting = false; this.broker.checkUpgrade?.(); });
    }
    return this.started;
  }
  enqueueCommand(operation) {
    this.pendingCommands++;
    const task = this.commandQueue.then(operation).finally(() => { this.pendingCommands--; this.broker.checkUpgrade?.(); });
    this.commandQueue = task.catch(() => {});
    return task;
  }
  addView(peer, view) {
    if (this.cleanupTimer) { clearTimeout(this.cleanupTimer); this.cleanupTimer = null; }
    const connectedBefore = this.views.size;
    const controllerWasConnected = !!(this.controller && this.views.has(this.controller.viewId));
    const previous = this.views.get(view.viewId);
    if (previous && previous.peer !== peer) previous.peer.views.delete(view.viewId);
    this.views.set(view.viewId, { ...view, connected:true, peer });
    peer.views.set(view.viewId, this);
    if (!this.controller) this.controller = { ...view };
    else if (!controllerWasConnected && connectedBefore === 0) {
      // Full Hub restart: nobody else is observing or operating this runtime,
      // so restoring the only view is recovery, not a competing takeover.
      this.controller = { ...view };
      this.controllerEpoch++;
      this.toolRoute?.update(this.controller, true);
      return true;
    }
    this.toolRoute?.update(this.controller, !!this.views.get(this.controller?.viewId));
    return false;
  }
  removeView(viewId, peer) {
    const view = this.views.get(viewId);
    if (!view || view.peer !== peer) return;
    this.views.delete(viewId);
    peer.views.delete(viewId);
    try { this.toolRoute?.update(this.controller, !!this.views.get(this.controller?.viewId)); }
    catch (error) {
      this.toolRoute.invalidate();
      console.error('[native-tool-route] detach update failed:', error.message);
      this.broadcast({method:'session-event',params:{key:this.key,event:'diagnostic',args:[{type:'tool-route-error',message:error.message}]}});
    }
    this.broadcastControl();
    this.scheduleCleanup();
  }
  scheduleCleanup() {
    if (this.cleanupTimer || this.views.size || (!this.exited && !this.canTransfer().ok)) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      if (this.views.size || (!this.exited && !this.canTransfer().ok)) return;
      this.broker.records.delete(this.key);
      this.session.kill();
      this.toolRoute?.dispose();
    }, this.broker.idleRetentionMs);
    this.cleanupTimer.unref?.();
  }
  canTransfer() {
    const r = this.session.runtime || {};
    if (this.exited) return { ok:false, reason:'Codex 共享运行实例已经退出' };
    if (!['connected','unstarted'].includes(r.connection)) return { ok:false, reason:'Codex 连接异常，状态待核对' };
    if (!isUnstartedRuntime(r) && !TERMINAL.has(r.state) && r.state !== 'idle') {
      return { ok:false, reason:r.cancellation?.status === 'pending' ? '正在停止，等待后台确认' : r.state === 'waiting' ? 'Codex 正在等待原操作窗口处理' : 'Codex 工作中，结束后才能切换' };
    }
    if (['submitting','unknown'].includes(r.submission?.status)) return { ok:false, reason:'消息提交结果尚未确认' };
    if ((r.requests || []).length) return { ok:false, reason:'仍有审批或问题待处理' };
    if(this.session.pendingWork?.())return {ok:false,reason:'仍有排队消息或后台活动未结束'};
    if (this.reservations.size) return { ok:false, reason:'自动工作流尚未结束或暂停' };
    return { ok:true, reason:'本轮已结束且没有待处理工作' };
  }
  controlFor(viewId) {
    const transfer = this.canTransfer();
    const owner = this.controller ? {
      viewId:this.controller.viewId, sessionId:this.controller.sessionId, hubPid:this.controller.hubPid,
      hubVersion:this.controller.hubVersion, label:this.controller.label,
      connected:!!this.views.get(this.controller.viewId),
    } : null;
    const canRecover = !!owner && owner.viewId !== viewId && owner.connected === false;
    return {
      shared:true,
      role:owner?.viewId === viewId ? 'controller' : 'viewer',
      viewId,
      controller:owner,
      controllerEpoch:this.controllerEpoch,
      transferReady:transfer.ok,
      canTransfer:transfer.ok && owner?.viewId !== viewId,
      canRecover,
      transferReason:canRecover ? '原操作窗口已断开，可以恢复操作' : transfer.reason,
      viewerCount:this.views.size,
      serviceId:this.broker.serviceId,
      runtimeBuild:this.broker.runtimeBuild || null,
      backendUpgrade:this.broker.upgrade?.info() || null,
      serverPid:this.session.pid,
    };
  }
  snapshot(viewId) {
    return {
      key:this.key,
      runtime:this.session.runtime,
      threadId:this.session.threadId,
      contentRevision:this.session.contentRevision,
      transcript:this.session.readTranscript({ limit:Infinity,toolPreviews:this.views.get(viewId)?.codexToolMode==='preview-v1' }),
      blocks:this.session.blocks(),
      finalText:this.session.finalText(),
      control:this.controlFor(viewId),
      ...this.session.snapshotExtra?.({full:true}),
    };
  }
  scheduleContent() {
    if (this.contentTimer || !this.views.size) return;
    this.contentTimer = setTimeout(() => { this.contentTimer=null; this.broadcastContent(); }, 50);
    this.contentTimer.unref?.();
  }
  flushContent() {
    if (this.contentTimer) clearTimeout(this.contentTimer);
    this.contentTimer = null;
    this.broadcastContent();
  }
  sendToView(viewId, message) {
    const view = this.views.get(viewId);
    if (view) view.peer.send(message);
  }
  broadcast(message) {
    const sent = new Set();
    for (const view of this.views.values()) {
      if (sent.has(view.peer)) continue;
      sent.add(view.peer);
      view.peer.send(message);
    }
  }
  broadcastControl() {
    for (const viewId of this.views.keys()) {
      this.sendToView(viewId, { method:'control', params:{ key:this.key, control:this.controlFor(viewId) } });
    }
  }
  broadcastContent() {
    if (!this.views.size) return;
    const turnId = this.session.runtime?.turnId;
    if (!turnId && !this.session.snapshotExtra) return;
    // History is hydrated once on attach. Streaming replaces only this turn;
    // sending all previous turns for every token flooded even a single Hub.
    const update={ method:'content', params:{ key:this.key, contentRevision:this.session.contentRevision,
      replaceTurnId:turnId, threadId:this.session.threadId,
      transcript:this.session.readTranscript({ limit:Infinity, turnId }), blocks:this.session.blocks(), finalText:this.session.finalText(),
      ...this.session.snapshotExtra?.({messagePatches:[...this.views.values()].every(view=>view.claudeMessageMode==='delta-v1')}) } };
    let legacy,compact;
    const sent = new Set();
    for(const view of this.views.values()) {
      // Old Hub adapters replace their whole cache on each message. Keep
      // their history complete while the new adapters use per-turn updates.
      if (sent.has(view.peer)) continue;
      sent.add(view.peer);
      if(view.codexToolMode==='preview-v1') {
        compact ||= {...update,params:{...update.params,transcript:require('./codex-tool-details').compactCodexTools(update.params.transcript,{threadId:this.session.threadId})}};
        view.peer.send({...compact,deltaContent:view.contentMode==='delta-v1'});
      }
      else if(view.contentMode==='delta-v1')view.peer.send({...update,deltaContent:true});
      else if(view.contentMode==='turn')view.peer.send(update);
      else {
        legacy ||= {method:'content',params:{...update.params,replaceTurnId:undefined,
          transcript:this.session.readTranscript({limit:Infinity})}};
        view.peer.send(legacy);
      }
    }
  }
  broadcastHistory() {
    if(!this.views.size)return;
    const message={method:'content',params:{key:this.key,threadId:this.session.threadId,
      contentRevision:this.session.contentRevision,transcript:this.session.readTranscript({limit:Infinity}),
      blocks:this.session.blocks(),finalText:this.session.finalText()}};
    let compact;const sent=new Set();
    for(const view of this.views.values()) {
      if(sent.has(view.peer))continue;sent.add(view.peer);
      if(view.codexToolMode==='preview-v1') {
        compact ||= {...message,params:{...message.params,transcript:require('./codex-tool-details').compactCodexTools(message.params.transcript,{threadId:this.session.threadId})}};
        view.peer.send(compact);
      } else view.peer.send(message);
    }
  }
  assertController(viewId, expectedEpoch) {
    if (!this.controller || this.controller.viewId !== viewId) throw new Error('此窗口只能查看；请在空闲后点击“在此操作”');
    if (Number(expectedEpoch) !== this.controllerEpoch) throw new Error('操作权已经变化，请刷新后重试');
  }
  async requestControl(viewId, expectedEpoch) {
    const view = this.views.get(viewId);
    if (!view) throw new Error('当前窗口没有连接共享会话');
    if (this.controller?.viewId === viewId) return this.controlFor(viewId);
    if (Number(expectedEpoch) !== this.controllerEpoch) throw new Error('操作权已经变化，请刷新后重试');
    if (this.controller && !this.views.has(this.controller.viewId)) {
      this.toolRoute?.update(view, true);
      this.controller = { viewId:view.viewId, sessionId:view.sessionId, hubPid:view.hubPid,
        hubVersion:view.hubVersion, label:view.label };
      this.controllerEpoch++;
      this.broadcastControl();
      if (!['connected','unstarted'].includes(this.session.runtime?.connection)) await this.session.reconnect();
      return this.controlFor(viewId);
    }
    const transfer = this.canTransfer();
    if (!transfer.ok) throw new Error(transfer.reason);
    this.toolRoute?.update(view, true);
    this.controller = { viewId:view.viewId, sessionId:view.sessionId, hubPid:view.hubPid,
      hubVersion:view.hubVersion, label:view.label };
    this.controllerEpoch++;
    this.broadcastControl();
    return this.controlFor(viewId);
  }
  async action(viewId, action, args, expectedEpoch) {
    if (MUTATING_ACTIONS.has(action)) this.assertController(viewId, expectedEpoch);
    if(this.options.nativeProvider==='claude' && this.session.invoke) {
      if(action==='start')return this.ensureStarted().then(()=>this.snapshot(viewId));
      if(action==='claude-reconcile')return this.session.invoke('reconcile',args);
      if(action==='readAccountUsage')return this.session.invoke(action,args);
      if(!MUTATING_ACTIONS.has(action))throw Error('共享服务不支持操作：'+action);
      const result=await this.session.invoke(action,args);
      this.flushContent();
      return result;
    }
    if (action === 'start') return this.ensureStarted().then(() => this.snapshot(viewId));
    if (action === 'readOutcome') return this.session.readOutcome(...args);
    if (action === 'readBackstage') return this.session.readBackstage(...args);
    if (action === 'readToolResult') return this.session.readToolResult(...args);
    if (action === 'reconcile') {
      const runtime=await this.session.reconcile();
      this.broadcastHistory();
      return runtime;
    }
    if (action === 'reconnect') {
      // A display refresh never restarts/reconciles a healthy native runtime.
      // Only the controller may explicitly recover an actually lost engine.
      this.assertController(viewId, expectedEpoch);
      if (!['connected','unstarted'].includes(this.session.runtime?.connection)) await this.session.reconnect();
      return this.snapshot(viewId);
    }
    if (!MUTATING_ACTIONS.has(action) || typeof this.session[action] !== 'function') throw new Error('共享服务不支持操作：' + action);
    return this.session[action](...args);
  }
}

class CodexRuntimeBroker {
  constructor({ serviceId = randomUUID(), sessionFactory = options => options.nativeProvider==='claude'
    ? new (require('./claude-broker-session').ClaudeBrokerSession)(options) : new CodexNativeSession(options), idleRetentionMs = 30 * 60_000 } = {}) {
    this.serviceId = serviceId;
    this.sessionFactory = sessionFactory;
    this.idleRetentionMs = Math.max(1000, Number(idleRetentionMs) || 30 * 60_000);
    this.records = new Map();
    this.draining = false;
  }
  findRecord(key) {
    const record = this.records.get(key);
    if (!record) throw new Error('Codex 共享会话不存在或已经结束');
    return record;
  }
  async handle(peer, method, params = {}) {
    if (this.draining) throw Object.assign(new Error('共享后台正在空闲交接，请稍后重试'), { code:'broker-upgrading' });
    if (method === 'shutdown-test' && process.env.AI_HUB_CODEX_BROKER_TEST === '1') {
      setImmediate(() => process.exit(0));
      return { ok:true };
    }
    if (method === 'attach') {
      const options = serializableOptions(params.options || {});
      const view = params.view || {};
      if (!view.viewId || !view.sessionId) throw new Error('共享会话窗口身份缺失');
      const key = recordIdentity(options);
      let record = this.records.get(key);
      if (!record) {
        record = new RuntimeRecord(this, key, options);
        this.records.set(key, record);
      } else if ((record.session.profileOptions ? runtimeProfileFingerprint(record.session.profileOptions()) : record.scopeFingerprint) !== runtimeProfileFingerprint(options)) {
        throw new Error('同一 Codex 会话的运行配置不同，不能共享后台');
      }
      record.addView(peer, view);
      if (!isUnstartedRuntime(record.session.runtime)) {
        // Attaching an observer must not replace the App Server. Existing
        // runtime recovery is a separate, explicit controller operation.
        await record.ensureStarted();
      }
      record.broadcastControl();
      return record.snapshot(view.viewId);
    }
    const record = this.findRecord(params.key);
    if (method === 'detach') {
      record.removeView(params.viewId, peer);
      return { ok:true };
    }
    if (method === 'request-control') {
      return record.enqueueCommand(() => record.requestControl(params.viewId, params.controllerEpoch));
    }
    if (method === 'locate-controller') {
      const owner = record.controller;
      if (!owner) throw new Error('当前没有操作窗口，可以直接在此操作');
      if (!record.views.has(owner.viewId)) throw new Error('原操作窗口已断开；工作结束后可在此操作');
      record.sendToView(owner.viewId, { method:'locate-request', params:{ key:record.key, sessionId:owner.sessionId, viewId:owner.viewId } });
      return { ok:true, controller:record.controlFor(params.viewId).controller };
    }
    if (method === 'reserve-workflow') {
      return record.enqueueCommand(() => {
        record.assertController(params.viewId, params.controllerEpoch);
        record.reservations.set(params.reservationId, { at:Date.now(), label:params.label || 'workflow' });
        record.broadcastControl();
        return { ok:true };
      });
    }
    if (method === 'release-workflow') {
      return record.enqueueCommand(() => {
        record.assertController(params.viewId, params.controllerEpoch);
        record.reservations.delete(params.reservationId);
        record.broadcastControl();
        return { ok:true };
      });
    }
    if (method === 'action') {
      const run = () => record.action(params.viewId, params.action, params.args || [], params.controllerEpoch);
      // An acknowledgement may take seconds. Stop/approval remain responsive
      // while submit waits; each still checks the current controller epoch.
      if(['interrupt','respond','reply'].includes(params.action))return run();
      return MUTATING_ACTIONS.has(params.action) ? record.enqueueCommand(run) : run();
    }
    if (method === 'snapshot') return record.snapshot(params.viewId);
    throw new Error('Codex 共享服务不支持请求：' + method);
  }
  disconnect(peer) {
    for (const [viewId, record] of [...peer.views]) record.removeView(viewId, peer);
  }
}

module.exports = { CodexRuntimeBroker, RuntimeRecord, MUTATING_ACTIONS, recordIdentity, threadIdentity, runtimeProfileFingerprint };
