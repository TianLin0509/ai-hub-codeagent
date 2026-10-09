'use strict';

const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { acquireBroker } = require('../main/codex-runtime-broker-client');
const { createNativeRuntime, TERMINAL } = require('./codex-native-runtime');
const { SharedContentDecoder } = require('./shared-content-codec');

function restoredRuntime(options) {
  if (!options.restoredRuntime) {
    const runtime = createNativeRuntime();
    if (options.lazyStart) Object.assign(runtime, { lazyStart:true, state:'idle', connection:'unstarted', reason:'尚未开始，收到消息后启动' });
    return runtime;
  }
  const previous = options.restoredRuntime;
  return {
    ...createNativeRuntime(), ...previous, epoch:(Number(previous.epoch) || 0) + 1,
    revision:Number(previous.revision) || 0,
    endedTurns:Array.isArray(previous.endedTurns) ? previous.endedTurns.slice(-128) : [],
    requests:[], waitingFlags:[], connection:'connecting',
    state:TERMINAL.has(previous.state) ? previous.state : 'unknown',
    reason:'正在连接 Codex 共享服务',
    submission:previous.submission?.status === 'submitting'
      ? { ...previous.submission, status:'unknown' } : previous.submission,
  };
}

function cleanOptions(options) {
  return JSON.parse(JSON.stringify(options, (_key, value) => typeof value === 'function' ? undefined : value));
}

class CodexSharedSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.sharedRuntime = true;
    this.brokerConnector = options.brokerConnector || acquireBroker;
    this.runtime = restoredRuntime(options);
    this.viewEpoch = this.runtime.epoch;
    this.hostRuntimeEpoch = null;
    this.hostRuntimeRevision = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 250;
    this.reconnectBackoff = require('./reconnect-backoff').createReconnectBackoff(options.reconnectBackoffOptions);
    this.everAttached = false;
    this.threadId = this.runtime.threadId || options.resumeId || null;
    this.contentRevision = 0;
    this.fullContentRevision = null;
    this.turnContentRevisions = new Map();
    this.contentDecoder = new SharedContentDecoder();
    this.transcript = [];
    this.textBlocks = [];
    this.lastFinalText = '';
    this.receipts = new Map();
    this.control = { shared:true, role:'viewer', viewId:randomUUID(), controller:null,
      controllerEpoch:0, canTransfer:false, transferReason:'正在连接共享服务', viewerCount:0 };
    this.view = {
      viewId:this.control.viewId,
      contentMode:'turn',
      sessionId:options.id,
      hubPid:Number(options.hubPid) || process.pid,
      hubVersion:String(options.hubVersion || ''),
      label:`Hub v${options.hubVersion || '?'} · PID ${Number(options.hubPid) || process.pid}`,
    };
    this.key = null;
    this.client = null;
    this.clientSubscriptions = new WeakMap();
    this.ready = null;
    this.closed = false;
    this.exiting = false;
  }
  get pid() { return this.control?.serverPid || null; }
  onData(fn) { this.on('data', fn); return { dispose:() => this.off('data', fn) }; }
  onExit(fn) { this.on('exit', fn); return { dispose:() => this.off('exit', fn) }; }
  resize() {}
  print(text) { this.emit('data', String(text || '').replace(/\r?\n/g, '\r\n')); }
  applyRuntime(next) {
    if (!next || next === this.runtime) return;
    if (this.hostRuntimeEpoch != null && (next.epoch < this.hostRuntimeEpoch
      || (next.epoch === this.hostRuntimeEpoch && next.revision < this.hostRuntimeRevision))) return;
    if (this.hostRuntimeEpoch != null && next.epoch > this.hostRuntimeEpoch) this.viewEpoch++;
    this.hostRuntimeEpoch = next.epoch;
    this.hostRuntimeRevision = next.revision;
    // Renderer revisions belong to this view. A local transport disconnect
    // must never outrank a subsequent valid snapshot from the native host.
    next = { ...next, observation:null, brokerEpoch:next.epoch, epoch:this.viewEpoch,
      revision:Math.max(Number(this.runtime.revision) + 1 || 1, Number(next.revision) || 0) };
    if(this.options.nativeProvider==='claude')next.requests=(next.requests||[]).map(request=>({...request,brokerEpoch:request.epoch,epoch:this.viewEpoch}));
    const previous = this.runtime;
    this.runtime = next;
    this.threadId = next.threadId || this.threadId;
    this.emit('state', next, previous);
  }
  applyControl(control) {
    if (!control) return;
    control = { ...control, runtimeBuild:control.runtimeBuild || this.client?.runtimeBuild || null,
      backendUpgrade:control.backendUpgrade || this.client?.upgrade || null };
    const previous = this.control;
    this.control = control;
    this.emit('control', control, previous);
  }
  applyContent(content) {
    if (!content) return;
    if(Number.isFinite(content.contentRevision) && content.contentRevision<this.contentRevision)return;
    this.contentRevision = Number(content.contentRevision) || this.contentRevision;
    if (Array.isArray(content.transcript)) {
      if (content.replaceTurnId) {
        const key=`${content.threadId || this.threadId}:${content.replaceTurnId}`;
        this.transcript = this.transcript.filter(card => card.displayTurnKey !== key && card.providerTurnId !== content.replaceTurnId)
          .concat(content.transcript);
        this.turnContentRevisions.set(content.replaceTurnId,this.contentRevision);
      } else {
        this.transcript = content.transcript;
        this.fullContentRevision=this.contentRevision;this.turnContentRevisions.clear();
      }
    }
    this.textBlocks = Array.isArray(content.blocks) ? content.blocks : this.textBlocks;
    this.lastFinalText = typeof content.finalText === 'string' ? content.finalText : this.lastFinalText;
    this.emit('items', this.textBlocks);
    if(this.compatBackstage)this.emit('backstage-updated',{revision:this.contentRevision});
  }
  applySnapshot(snapshot) {
    if (!snapshot) return;
    const oldThread = this.threadId;
    this.key = snapshot.key || this.key;
    this.threadId = snapshot.threadId || this.threadId;
    if (snapshot.runtime) this.applyRuntime(snapshot.runtime);
    if(oldThread!==this.threadId) {
      this.contentRevision=0;this.fullContentRevision=null;this.turnContentRevisions.clear();
      this.compatBackstage?.close();this.compatBackstage=null;
    }
    const incoming=Number(snapshot.contentRevision)||0;
    if(this.options.nativeProvider!=='claude' && incoming<this.contentRevision && Array.isArray(snapshot.transcript)) {
      // BrokerConnection drains a socket chunk synchronously. New turn data
      // can arrive after the attach response but before its await continues.
      // Preserve that data while still hydrating earlier turns from the reply.
      if(this.fullContentRevision==null || this.fullContentRevision<incoming) {
        const newer=new Set([...this.turnContentRevisions].filter(([,revision])=>revision>incoming).map(([id])=>id));
        const turnId=card=>card.providerTurnId || card.displayTurnKey?.slice((this.threadId+':').length);
        const groups=new Map();for(const card of this.transcript) {
          const id=turnId(card);if(!newer.has(id))continue;
          if(!groups.has(id))groups.set(id,[]);groups.get(id).push(card);
        }
        const merged=[],placed=new Set();
        for(const card of snapshot.transcript) {
          const id=turnId(card);
          if(newer.has(id)){if(!placed.has(id)){merged.push(...(groups.get(id)||[]));placed.add(id);}}
          else merged.push(card);
        }
        for(const [id,cards] of groups)if(!placed.has(id))merged.push(...cards);
        this.transcript=merged;this.fullContentRevision=incoming;
        this.emit('items',this.textBlocks);
      }
    } else this.applyContent(snapshot);
    this.applyControl(snapshot.control);
    if (this.threadId && this.threadId !== oldThread) this.emit('bound', { threadId:this.threadId });
  }
  onNotification = message => {
    const p = message.params || {};
    if (p.previousKey && this.key === p.previousKey) this.key = p.key;
    if (this.key && p.key && p.key !== this.key) return;
    if (p.control?.viewId && p.control.viewId !== this.view.viewId) return;
    if (message.method === 'control') this.applyControl(p.control);
    else if (message.method === 'content') this.applyContent(p);
    else if (message.method === 'content-delta') {
      try { this.applyContent(this.contentDecoder.decode(p.key, p.transfer)); }
      catch (error) {
        // Reattach the observation channel to obtain an authoritative full
        // snapshot. No native reconnect, turn replay or automatic resend.
        this.onDisconnect(new Error('会话增量同步中断，正在重新读取完整状态：' + error.message));
      }
    }
    else if (message.method === 'locate-request') this.emit('locate-request', { sessionId:this.options.id });
    else if (message.method === 'session-event') {
      const args = Array.isArray(p.args) ? p.args : [];
      if (p.event === 'state') this.applyRuntime(args[0]);
      else if (p.event === 'bound') {
        const bound = args[0] || {};
        this.threadId = bound.threadId || this.threadId;
        this.emit('bound', bound);
      } else if (p.event === 'thread-reset') {
        this.threadId=null;
        this.contentRevision=0;this.fullContentRevision=null;this.turnContentRevisions.clear();
        this.compatBackstage?.close();this.compatBackstage=null;
        this.applyContent({transcript:[],blocks:[],finalText:'',contentRevision:0});
        this.emit('thread-reset',...args);
      } else if (p.event === 'lifecycle') {
        // Lifecycle has persistence, notification and workflow side effects in
        // Main. Only the controller Hub publishes those; viewers already get
        // the same authoritative state and content events.
        if (p.controllerViewId ? p.controllerViewId===this.view.viewId : this.control.role === 'controller') {
          this.emit('lifecycle', { ...(args[0] || {}), hubSessionId:this.options.id });
        }
      } else if (p.event === 'usage') {
        this.emit('usage', ...args);
      } else if (p.event === 'exit') this.emit('diagnostic', 'Codex 共享运行实例已退出');
      else this.emit(p.event, ...args);
    }
  };
  onDisconnect = error => {
    if (this.closed || this.exiting) return;
    const previous = this.runtime;
    this.runtime = { ...previous, connection:'disconnected', revision:previous.revision + 1,
      reason:'Hub 状态同步连接已断开，正在重新连接', observedAt:Date.now(),
      observation:{state:'reconnecting',since:previous.observation?.since || Date.now(),reason:error?.message || ''} };
    // The window transport knows nothing new about the native turn's outcome.
    // Keep its last state/identity, mark observation unavailable, never fail it.
    this.emit('state', this.runtime, previous);
    this.emit('diagnostic', error?.message || 'Hub 状态同步连接已断开');
    const client=this.client;
    this.client = null;
    this.releaseClient(client);
    this.ready = null;
    this.reconnectDelay = this.reconnectBackoff.disconnected();
    this.scheduleReconnect();
  };
  releaseClient(client) {
    if(!client)return;
    this.clientSubscriptions.get(client)?.();
    this.clientSubscriptions.delete(client);
    client.close();
  }
  scheduleReconnect() {
    if (this.closed || this.exiting || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer=null;
      this.start().catch(error => {
        this.emit('diagnostic', 'Hub 状态同步重连失败：' + error.message);
        this.reconnectDelay=this.reconnectBackoff.disconnected();
        this.scheduleReconnect();
      });
    },this.reconnectDelay);
    this.reconnectTimer.unref?.();
  }
  async start() {
    if (this.closed) throw new Error('Codex 会话已关闭，不能启动');
    if (!this.ready) this.ready = this._start().catch(error => {
      this.ready = null;
      const previous=this.runtime;
      this.runtime={...previous,connection:'disconnected',revision:previous.revision+1,reason:error.message,
        ...(this.everAttached?{observation:{state:'reconnecting',since:previous.observation?.since || Date.now(),reason:error.message}}:{})};
      this.emit('state',this.runtime,previous);
      throw error;
    });
    return this.ready;
  }
  async _start() {
    if (this.everAttached) this.viewEpoch++;
    const dataDir = this.options.hubDataDir || this.options.env?.CLAUDE_HUB_DATA_DIR
      || path.join(os.homedir(), '.ai-hub-community');
    const client = await this.brokerConnector({ dataDir });
    if (this.closed) { client.close(); return; }
    const serviceId=client.metadata?.serviceId;
    if (serviceId && this.serviceId && this.serviceId!==serviceId) {
      this.hostRuntimeEpoch=null;
      this.hostRuntimeRevision=null;
      this.contentRevision=0;this.fullContentRevision=null;this.turnContentRevisions.clear();
    }
    if(serviceId)this.serviceId=serviceId;
    this.client = client;
    this.backstageSupported=client.features?.includes('codex-backstage-v1')===true;
    this.contentDecoder.entries.clear();
    this.view.contentMode = client.features?.includes('content-delta-v1') ? 'delta-v1' : 'turn';
    this.view.codexToolMode = this.options.nativeProvider!=='claude' && client.features?.includes('codex-tool-preview-v1') ? 'preview-v1' : null;
    const onNotification = message => { if(this.client===client)this.onNotification(message); };
    const onDisconnect = error => { if(this.client===client)this.onDisconnect(error); };
    client.on('notification', onNotification);
    client.once('disconnect', onDisconnect);
    this.clientSubscriptions.set(client,()=>{
      client.off('notification',onNotification);
      client.off('disconnect',onDisconnect);
    });
    let snapshot;
    try {
      // A recovered window attaches to the same returned thread, never to its
      // stale pre-start/fork options which could create another native task.
      const options=this.attachOptions();
      snapshot = await client.request('attach', { options:cleanOptions(options), view:this.view });
    } catch (error) {
      if (this.client === client) this.client = null;
      this.releaseClient(client);
      throw error;
    }
    if (this.client !== client || client.closed || this.closed) throw new Error('Hub 状态同步连接在初始化时断开');
    this.applySnapshot(snapshot);
    this.everAttached = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer=null;
    this.reconnectBackoff.connected();
    return this.runtime;
  }
  attachOptions() { return this.threadId ? {...this.options,resumeId:this.threadId,forkId:null} : this.options; }
  async request(method, params = {}, timeoutMs) {
    await this.start();
    if (!this.client || this.client.closed) throw new Error('Codex 共享服务连接已断开');
    return this.client.request(method, { key:this.key, viewId:this.view.viewId, ...params }, timeoutMs);
  }
  async action(action, args = []) {
    await this.start();
    return this.request('action', { action, args, controllerEpoch:this.control.controllerEpoch });
  }
  async requestControl() {
    await this.start();
    const control = await this.request('request-control', { controllerEpoch:this.control.controllerEpoch });
    this.applyControl(control);
    return control;
  }
  locateController() { return this.request('locate-controller'); }
  async reserveWorkflow(reservationId, label) {
    await this.start();
    return this.request('reserve-workflow', { reservationId, label, controllerEpoch:this.control.controllerEpoch });
  }
  async releaseWorkflow(reservationId) {
    await this.start();
    return this.request('release-workflow', { reservationId, controllerEpoch:this.control.controllerEpoch });
  }
  send(text, options = {}) {
    const clean = { requireReady:options.requireReady, clientSubmissionId:options.clientSubmissionId,
      attachments:options.attachments };
    return this.action('send', [text, clean]).then(result => {
      if (result?.clientSubmissionId) this.receipts.set(result.clientSubmissionId, { result });
      return result;
    });
  }
  interrupt() { return this.action('interrupt'); }
  reply(requestId, result, epoch) {
    if (epoch !== this.runtime.epoch) return Promise.reject(new Error('审批来自旧窗口状态，请刷新'));
    return this.action('reply', [requestId, result, this.hostRuntimeEpoch]);
  }
  configure(options) { return this.action('configure', [options]); }
  configureMode(mode, epoch) {
    if (epoch !== this.runtime.epoch) return Promise.reject(new Error('工作模式切换来自旧窗口状态，请刷新'));
    return this.action('configureMode', [mode, this.hostRuntimeEpoch]);
  }
  chooseThread(threadId) { return this.action('chooseThread', [threadId]); }
  restartEmpty(options) {
    if (options?.epoch !== this.runtime.epoch) return Promise.reject(new Error('空会话恢复来自旧窗口状态，请刷新'));
    return this.action('restartEmpty', [{ ...options, epoch:this.hostRuntimeEpoch }]);
  }
  reviewUnknownSubmission(id, epoch) {
    if (epoch !== this.runtime.epoch) return Promise.reject(new Error('提交核对来自旧窗口状态，请刷新'));
    return this.action('reviewUnknownSubmission', [id, this.hostRuntimeEpoch]);
  }
  readOutcome(turnId) { return this.action('readOutcome', [turnId]).then(result => result ? { ...result, hubSessionId:this.options.id } : result); }
  async readBackstage(options={}) {
    if(!this.transcript.length)await this.start();
    if(this.backstageSupported && (!this.client || this.client.closed))throw Error('正在恢复后台同步，已有记录仍保留，请稍后重试');
    const source=(this.client?.features?.includes('codex-backstage-v1')?'native:':'compat:')+this.threadId;
    const reset=!!this.backstageReadSource && this.backstageReadSource!==source && options.mode!=='detail';
    if(reset)options={...options,before:undefined,after:undefined,since:undefined};
    if (!this.client?.features?.includes('codex-backstage-v1')) {
      this.compatBackstage ||= new (require('./codex-backstage-compat').CodexBackstageCompat)(this);
      const compat=this.compatBackstage;
      if(options?.mode==='raw')await compat.prepareExport();
      else if(compat.preparing)await compat.preparing;
      if(this.compatBackstage!==compat || this.closed)throw Error('后台记录来源已切换，请重新读取');
      const result=compat.read(options);this.backstageReadSource=source;
      return {...result,reset};
    }
    this.compatBackstage?.close();this.compatBackstage=null;
    const result=await this.action('readBackstage', [options]);this.backstageReadSource=source;
    return {...result,reset};
  }
  async prepareBackstageExport() {
    await this.readBackstage({limit:1});
    if(this.compatBackstage){await this.compatBackstage.prepareExport();return;}
    let page;
    do {page=await this.readBackstage({history:true,limit:1});}while(page.historyMore);
  }
  reconcile() { return this.action('reconcile'); }
  async reconnect() {
    if (this.client && !this.client.closed) {
      const snapshot = await this.request('snapshot');
      this.applySnapshot(snapshot);
      if (['connected','unstarted'].includes(snapshot.runtime?.connection)) return this.runtime;
      const recovered = await this.action('reconnect');
      if(recovered?.runtime)this.applySnapshot(recovered);
      return this.runtime;
    }
    this.ready = null;
    await this.start();
    return this.runtime;
  }
  finalText() { return this.lastFinalText; }
  blocks() { return this.textBlocks.slice(); }
  readTranscript(options = {}) {
    let cards = this.transcript.slice();
    const turnKey = card => card.displayTurnKey || (card.providerTurnId ? `${this.threadId}:${card.providerTurnId}` : null);
    if (options.turnId) {
      const wanted = `${this.threadId}:${options.turnId}`;
      cards = cards.filter(card => card.providerTurnId === options.turnId || turnKey(card) === wanted);
    }
    if (options.latestTurn && cards.length) {
      const wanted = turnKey(cards.at(-1));
      cards = wanted ? cards.filter(card => turnKey(card) === wanted) : cards.slice(-1);
    }
    if(options.toolPreviews || this.view.codexToolMode==='preview-v1')cards=require('./codex-tool-details').compactCodexTools(cards,{hubSessionId:this.options.id,threadId:this.threadId});
    const limit = options.limit == null ? 50 : options.limit;
    return Number.isFinite(limit) && limit >= 0
      ? (options.fromTail === false ? cards.slice(0, limit) : cards.slice(-limit)) : cards;
  }
  async readToolResult(reference) {
    if(reference.threadId!==this.threadId)throw Error('工具详情不属于当前 Codex 会话');
    if(this.client?.features?.includes('codex-tool-preview-v1'))return this.action('readToolResult',[reference]);
    return require('./codex-tool-details').toolResult(this.transcript,reference,this.threadId);
  }
  write(data) {
    if (data === '\x03' || data === '\x1b') this.interrupt().catch(error => this.emit('action-error', error.message));
    else if (String(data || '').trim()) this.emit('action-error', 'Codex 使用 Hub 输入框提交；终端为只读输出。');
  }
  kill() {
    if (this.closed || this.exiting) return;
    this.exiting = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer=null;
    const client = this.client;
    const finish = () => {
      this.compatBackstage?.close();this.compatBackstage=null;
      this.releaseClient(client);
      this.client = null;
      this.closed = true;
      this.exiting = false;
      this.emit('exit', { exitCode:0, sharedDetached:true });
    };
    if (!client || client.closed || !this.key) { finish(); return; }
    client.request('detach', { key:this.key, viewId:this.view.viewId }, 3000).then(finish, finish);
  }
}

module.exports = { CodexSharedSession, cleanOptions, restoredRuntime };
