'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AcpClient } = require('../main/acp-client');
const { createNativeRuntime, reduceNativeRuntime, TERMINAL } = require('./codex-native-runtime');
const BACKEND = 'acp';

class AcpSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.label = require('./native-ui-labels').nativeUiLabel({runtimeBackend:BACKEND,kind:options.kind});
    this.runtime = { ...createNativeRuntime(), epoch: (options.restoredRuntime?.epoch || 0) + 1, reason: '正在连接原生 Harness' };
    this.threadId = null;
    this.items = new Map();
    this.history = new Map((options.forkHistory || []).map(turn=>[turn.id,structuredClone(turn)]));
    this.completed = new Map();
    this.receipts = new Map();
    this.contentRevision = 0;
    this.closed = false;
    this.storePath = options.storeDir && path.join(options.storeDir,
      createHash('sha256').update(options.id).digest('hex') + '.json');
    this.backstage = new (require('./acp-backstage').AcpBackstage)(this);
    this.promptQueue = new (require('./acp-prompt-queue').AcpPromptQueue)(this);
  }
  get pid() { return this.client?.proc?.pid || null; }
  onData(fn) { this.on('data', fn); return { dispose: () => this.off('data', fn) }; }
  onExit(fn) { this.on('exit', fn); return { dispose: () => this.off('exit', fn) }; }
  resize() {}
  readBackstage(options) { return this.backstage.read(options); }
  async prepareBackstageExport() {
    let page;do {page=this.readBackstage({history:true,limit:1});await new Promise(resolve=>setImmediate(resolve));}while(page.historyMore);
  }
  print(text) { this.emit('data', String(text).replace(/\x1b|[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/\r?\n/g, '\r\n')); }
  apply(event) {
    const next = reduceNativeRuntime(this.runtime, { epoch: this.runtime.epoch, ...event }, this.label);
    if (next === this.runtime) return;
    const previous = this.runtime;
    this.runtime = next;
    this.emit('state', next, previous);
  }
  lifecycle(type, extra = {}) {
    this.emit('lifecycle', { type, hubSessionId: this.options.id, kind: this.options.kind,
      threadId: this.threadId, turnId: this.runtime.turnId, signalSource: BACKEND, ...extra });
  }
  async start() { if (!this.ready) this.ready = this._start(); return this.ready; }
  historyStore() {
    if (!this.storePath) return null;
    return this._historyStore ||= new (require('./acp-history-store').AcpHistoryStore)(this.storePath);
  }
  loadHistory() {
    const saved = this.historyStore()?.read(saved => {
      if (saved.backend !== BACKEND || saved.kind !== this.options.kind || saved.profileId !== this.options.profileId
          || path.resolve(saved.cwd) !== path.resolve(this.options.cwd)) throw new Error('ACP 历史配置域不匹配');
    });
    if (!saved) return;
    this.saved = saved;
    this.history = new Map(saved.turns.map(turn => [turn.id, turn]));
    this.receipts = new Map(saved.receipts || []);
    if (saved.submission) this.runtime.submission = saved.submission;
    this.promptQueue.restore(saved.pendingPrompts);
  }
  persist() {
    if (!this.storePath || !this.threadId) return;
    const current = this.history.get(this.runtime.turnId);
    if (current) current.items = [...this.items.values()];
    try { this.historyStore().sync({ backend: BACKEND, kind: this.options.kind,
      profileId: this.options.profileId, cwd: this.options.cwd, sessionId: this.threadId,
      submission: this.runtime.submission, configOptions:this.configOptions,
      pendingPrompts:this.promptQueue.records,
      receipts: [...this.receipts], turns: [...this.history.values()] }); }
    catch (error) { this.storageError = error; throw error; }
  }
  async _start() {
    this.bootstrapping = true;
    try {
      this.loadHistory();
      const epoch = this.runtime.epoch;
      this.client = this.options.clientFactory ? this.options.clientFactory() : new AcpClient({ ...this.options.launch,
        capabilities: { elicitation: { form: {} } } });
      const client = this.client;
      const current = () => this.client === client && this.runtime.epoch === epoch && !this.closed;
      client.on('notification', message => {
        if (!current()) return;
        try { this.notification(message); } catch (error) { client.fail(error); }
      });
      client.on('request', message => {
        if (!current()) return;
        this.request(message).catch(error => client.fail(error));
      });
      client.on('diagnostic', text => {
        if (!current()) return;
        this.backstage.note(this.label+' stderr',text);
        this.emit('diagnostic', text);
      });
      client.on('disconnect', error => {
        if (!current()) return;
        this.apply({ type: 'disconnect', reason: error.message });
        try {this.promptQueue.hold('连接已断开，消息未发送');}
        catch(storageError){this.emit('action-error','待发送消息保存失败：'+storageError.message);}
        if (this.active) {
          clearTimeout(this.active.timer);
          clearTimeout(this.active.cancelTimer);
          this.apply({ type: 'submission', submission: { ...this.runtime.submission, status: 'unknown', error: error.message } });
          this.active.reject(error);
          try { this.persist(); }
          catch (storageError) { this.emit('action-error', 'ACP 历史保存失败：' + storageError.message); }
        }
      });
      this.initialized = await client.start();
      this.capabilities = this.initialized.agentCapabilities || {};
      for(const server of this.options.mcpServers || []) {
        if(server.type && server.type!=='stdio' && !this.capabilities.mcpCapabilities?.[server.type])
          throw new Error('当前 Harness 不支持 MCP 传输：'+server.type+'（'+server.name+'）');
      }
      if (this.options.authMethod) await client.request('authenticate', { methodId: this.options.authMethod,
        ...(this.options.authMeta ? {_meta:this.options.authMeta} : {}) });
      const resumeId = this.options.resumeId || this.saved?.sessionId;
      if (this.options.resumeId && this.saved?.sessionId && this.options.resumeId !== this.saved.sessionId) throw new Error('ACP 原生会话与显示历史身份不匹配');
      const method = resumeId ? this.capabilities.loadSession ? 'session/load'
        : this.capabilities.sessionCapabilities?.resume ? 'session/resume' : null : 'session/new';
      if (!method) throw new Error('该 Harness 未提供跨进程恢复，未新建会话替代');
      this.restoring = true;
      this.threadId = resumeId || null;
      const result = await client.request(method, { cwd: path.resolve(this.options.cwd),
        mcpServers: this.options.mcpServers || [], ...(resumeId ? { sessionId: resumeId } : {}) });
      if (!current()) throw new Error('ACP 初始化期间连接已变化');
      const sessionId = result.sessionId || resumeId;
      if (!sessionId || (resumeId && sessionId !== resumeId)) throw new Error('ACP 恢复返回了不同的会话 ID');
      this.threadId = sessionId;
      this.restoring = false;
      for(const message of this.prebound || [])this.notification(message);
      this.prebound=[];
      this.configOptions = result.configOptions || [];
      this.models = result.models || null;
      this.modes = result.modes || null;
      // Resume recovers engine context; Hub's own event log recovers display.
      // An interrupted process's unfinished turn remains unresolved, never replayed.
      const uncertain = [...this.history.values()].some(turn => turn.status === 'inProgress');
      this.apply({ type: 'snapshot', thread: { id: sessionId, status: { type: 'idle' }, turns: [] } });
      if (uncertain) {
        const submission = this.runtime.submission || {};
        this.apply({ type: 'submission', submission: { ...submission, status: 'unknown', error: '进程中断前轮次无终态，请核对原生会话' } });
      }
      if (this.options.model) await this.configure({ model: this.options.model, effort: this.options.effort }, true);
      if(resumeId)for(const saved of this.saved?.configOptions || []) {
        if(saved.category==='thought_level' || (saved.category==='mode' && this.options.permissionPolicy!=='bypass'))await this.configure({configId:saved.id,value:saved.currentValue},true);
      }
      if ((!resumeId || this.options.permissionPolicy==='bypass') && this.options.defaultMode) {
        const mode=this.configOptions.find(o=>o.category==='mode');
        if(!mode && this.options.permissionPolicy==='bypass')throw new Error('原生 Harness 未提供可确认的完全权限模式');
        if(mode)await this.configure({configId:mode.id,value:this.options.defaultMode},true);
      }
      this.bootstrapping = false;
      this.emit('bound', { threadId: sessionId, cwd: this.options.cwd, model: this.currentModel,
        capabilities: this.capabilities, configOptions: this.configOptions });
      const context=[...this.history.values()].findLast(turn=>turn.contextUsage)?.contextUsage;
      if(context)this.emit('usage',{last:{totalTokens:context.used},modelContextWindow:context.size});
      this.persist();
      this.print('\n'+require('./native-ui-labels').nativeOpeningBanner({runtimeBackend:BACKEND,kind:this.options.kind})+'\n');
      return result;
    } catch (error) {
      this.bootstrapping = false;
      this.client?.close();
      // Intentional cleanup emits its own generic disconnect; retain the
      // actual startup failure after closing the child process.
      this.apply({ type: 'disconnect', reason: error.message });
      throw error;
    }
  }
  acknowledge() {
    const active = this.active;
    if (!active || active.accepted) return;
    active.accepted = true;
    clearTimeout(active.timer);
    this.apply({ type: 'started', threadId: this.threadId, turn: { id: active.turnId } });
    this.apply({ type: 'submission', submission: { ...this.runtime.submission, status: 'accepted', turnId: active.turnId } });
    const result = { ok: true, sendStatus: 'ok', mode: BACKEND, acknowledgementSource: BACKEND,
      threadId: this.threadId, turnId: active.turnId, acknowledgementTurnId: active.turnId, clientSubmissionId: active.id, enterAttempts: 0 };
    this.receipts.set(active.id, { digest: active.digest, result });
    this.persist();
    this.lifecycle('prompt-submitted', { text: active.text, clientSubmissionId: active.id, submittedAt: active.at });
    this.lifecycle('turn-start', { startedAt: active.at });
    active.resolve(result);
  }
  changed(item) {
    this.contentRevision++;
    try {
      if (item) this.historyStore()?.saveItem(this.active.turnId, item);
      else this.persist();
    } catch (error) { this.storageError = error; throw error; }
    // Consumers request the latest content on their existing coalesced path.
    this.emit('items');
  }
  notification(message) {
    if(this.restoring && !this.threadId && message.method==='session/update') {
      (this.prebound ||= []).push(message);return;
    }
    if (message.method !== 'session/update' || message.params?.sessionId !== this.threadId) return;
    const update = message.params.update;
    if (!update || this.restoring) return; // Replay must not create a second live turn.
    if (update.sessionUpdate === 'config_option_update') {
      this.configOptions = update.configOptions || [];
      if(!this.bootstrapping && !this.configuring)this.emit('bound',{threadId:this.threadId,configOptions:this.configOptions});
      return;
    }
    if (update.sessionUpdate === 'available_commands_update') { this.commands = update.availableCommands || []; return; }
    if (!this.active) return; // Late events cannot enter the next turn.
    this.acknowledge();
    let changedItem;
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      if (update.content?.type !== 'text') throw new Error('ACP 返回未支持的输出内容类型：' + update.content?.type);
      const thought = update.sessionUpdate === 'agent_thought_chunk';
      const key = update.messageId || (thought ? 'thought' : 'message') + ':' + this.segment;
      const id = this.active.turnId + ':' + (thought ? 'thought:' : 'message:') + key;
      const item = this.items.get(id) || { id, type: thought ? 'reasoning' : 'agentMessage', text: '', hubStartedAt: Date.now() };
      item.text += update.content.text;
      if (thought) item.summary = [item.text];
      this.backstage.chunk(this.active.turnId,item,update.content.text);
      this.items.set(id, item);
      changedItem = item;
      this.print(update.content.text);
    } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      if (!update.toolCallId) throw new Error('ACP 工具更新缺少 ID');
      const id = this.active.turnId + ':tool:' + update.toolCallId;
      const prior = this.items.get(id) || { id, type: 'acpTool', hubStartedAt: Date.now() };
      this.items.set(id, { ...prior, ...update, id, type: 'acpTool',
        status: update.status === 'in_progress' || update.status === 'pending' ? 'inProgress' : update.status || prior.status,
        result: update.content || prior.result, isError: update.status === 'failed' });
      if (update.sessionUpdate === 'tool_call') this.segment++;
      changedItem = this.items.get(id);
      this.backstage.item(this.active.turnId,changedItem,false);
    } else if (update.sessionUpdate === 'usage_update') {
      const turn=this.history.get(this.active.turnId);
      if(Number.isFinite(update.used) && update.used>=0 && Number.isFinite(update.size) && update.size>0) {
        turn.contextUsage={used:update.used,size:update.size};this.persist();
      }
      this.emit('usage', { last: { totalTokens: update.used }, modelContextWindow: update.size });
      return;
    } else if (update.sessionUpdate === 'plan') {
      this.items.set(this.active.turnId + ':plan', { id: this.active.turnId + ':plan', type: 'acpPlan', entries: update.entries });
      changedItem = this.items.get(this.active.turnId + ':plan');
      this.backstage.item(this.active.turnId,changedItem,false);
    }
    if (changedItem) this.changed(changedItem);
  }
  async request(message) {
    const p = message.params || {};
    if (p.sessionId !== this.threadId || !this.active || this.restoring) {
      return this.client.respond(message.id, null, { code: -32602, message: 'No active session turn' });
    }
    if (!['session/request_permission','elicitation/create'].includes(message.method)) {
      return this.client.respond(message.id, null, { code: -32601, message: 'Unsupported ACP client method: ' + message.method });
    }
    if (this.active.cancelling) return this.client.respond(message.id, this.cancelResponse(message));
    this.acknowledge();
    // Explicit user-selected full access. Real questions still need user input.
    if(this.options.permissionPolicy==='bypass' && message.method==='session/request_permission'
        && !p.toolCall?._meta?.qwenQuestions) {
      const allow=(p.options || []).find(o=>o.kind==='allow_once') || (p.options || []).find(o=>o.kind==='allow_always');
      if(!allow)throw new Error('原生权限请求没有允许选项，无法按完全权限执行');
      const active=this.active,client=this.client,epoch=this.runtime.epoch;
      return client.respond(message.id,{outcome:{outcome:'selected',optionId:allow.optionId}},null,response =>
        this.active!==active || active.cancelling || this.client!==client || this.runtime.epoch!==epoch || this.closed
          ? this.cancelResponse(message) : response);
    }
    this.apply({ type: 'request', threadId: this.threadId, request: { ...message,
      params: { ...p, threadId: this.threadId, turnId: this.active.turnId, reason: p.toolCall?.title || '原生工具请求权限' } } });
  }
  async send(text, options = {}) {
    try {
    if(this.storageError)throw new Error('ACP 历史保存失败：'+this.storageError.message);
    await this.start();
    if(typeof text!=='string' || !text.trim())throw new Error('消息不能为空');
    options={...options,attachments:options.attachments || require('./acp-attachments').imagePaths(text)};
    require('./acp-attachments').validateImages(options.attachments,this.currentModel,this.capabilities);
    if(this.closed || this.runtime.connection!=='connected')throw new Error('ACP 未连接');
    if(this.storageError)throw new Error('ACP 历史保存失败：'+this.storageError.message);
    if(this.active?.cancelling)throw new Error('正在停止，请等待原生会话确认');
    if(this.configuring || this.runtime.configurationError)throw new Error('原生配置尚未确认');
    if(this.runtime.submission?.status==='unknown')throw new Error('当前轮次尚未结束或结果不明，请先核对；不会自动重发');
    }catch(error){error.notSent=true;throw error;}
    // Commands keep their native command semantics; they are never silently queued.
    if(text.trimStart().startsWith('/'))return this._send(text,options);
    return this.promptQueue.submit(text,options);
  }
  async _send(text, options = {}) {
    if (this.storageError) throw new Error('ACP 历史保存失败，请处理存储问题后恢复：' + this.storageError.message);
    await this.start();
    options={...options,attachments:options.attachments || require('./acp-attachments').imagePaths(text)};
    require('./acp-attachments').validateImages(options.attachments,this.currentModel,this.capabilities);
    if (typeof text === 'string' && text.trimStart().startsWith('/')) {
      const command=text.trim().split(/\s+/)[0].slice(1);
      if(['new','clear','fork','resume','login','logout'].includes(command)) throw new Error('请使用 Hub 会话菜单管理上下文与账号');
      if(command==='model') {
        const model=text.trim().split(/\s+/)[1];if(model)await this.configure({model});
        const commandOutput='当前套餐模型：'+this.currentModel;
        return {ok:true,mode:'acp-command',sendStatus:'ok',commandOutput};
      }
      if(command==='quota')return {ok:true,mode:'acp-command',sendStatus:'ok',
        commandOutput:'当前使用阿里云 Token Plan。套餐余量请到百炼控制台查看，Hub 尚未读取账单权益；不会调用其他供应商的额度接口。'};
      if(command==='status' || command==='help') {
        const commandOutput=command==='status' ? `${this.options.kind} · ${this.currentModel}\n原生会话：${this.threadId}\n套餐：${this.options.profileId}`
          : '原生命令：'+(this.commands || []).map(c=>'/'+c.name+' '+(c.description || '')).join('\n');
        this.print(commandOutput+'\n');return {ok:true,mode:'acp-command',sendStatus:'ok',commandOutput};
      }
    }
    const id = options.clientSubmissionId || randomUUID();
    const digest = createHash('sha256').update(JSON.stringify([text, options.attachments || []])).digest('hex');
    if (this.receipts.has(id)) {
      const previous = this.receipts.get(id);
      if (previous.digest !== digest) throw new Error('同一提交 ID 的正文或附件已变化');
      return previous.result;
    }
    if (this.active) {
      if (this.active.id === id && this.active.digest === digest) return this.active.ack;
      throw new Error('原生 Harness 当前轮次尚未结束');
    }
    if (this.closed || this.runtime.connection !== 'connected') throw new Error('ACP 未连接');
    if(this.configuring)throw new Error('原生配置正在确认，请稍后发送');
    if(this.runtime.configurationError)throw new Error(this.runtime.configurationError);
    if (this.runtime.submission?.status === 'unknown') throw new Error('上一条消息结果不明，请先核对；不会自动重发');
    if (typeof text !== 'string' || !text.trim()) throw new Error('消息不能为空');
    const prompt = [{ type: 'text', text }];
    for (const attachment of options.attachments || []) {
      if (!this.capabilities.promptCapabilities?.image || /^(deepseek-v4|glm-5\.2|qwen3\.7-max)/.test(this.currentModel)) throw new Error('当前模型或 Harness 不支持图片，未发送消息');
      if (attachment.type === 'localImage') {
        const ext = path.extname(attachment.path).toLowerCase();
        const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
        if (!mimeType) throw new Error('不支持的图片类型');
        prompt.push({ type: 'image', mimeType, data: fs.readFileSync(attachment.path).toString('base64') });
      } else if (attachment.type === 'image' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(attachment.url || '')) {
        const [header, data] = attachment.url.split(',');
        prompt.push({ type: 'image', mimeType: header.slice(5, header.indexOf(';')), data });
      } else throw new Error('不支持的 ACP 附件，未发送消息');
    }
    const turnId = randomUUID(), at = Date.now();
    const beforeRuntime=this.runtime;
    options.beforeStart?.();
    this.items = new Map([[turnId + ':user', { id: turnId + ':user', type: 'userMessage', clientId: id,
      content: [{ type: 'text', text },...(options.attachments || [])], hubStartedAt: at }]]);
    this.segment = 0;
    this.history.set(turnId, { id: turnId, status: 'inProgress', model:this.currentModel, hubStartedAt: at, items: [...this.items.values()] });
    this.apply({ type: 'submission', submission: { id, digest, submittedAt: at, status: 'submitting' } });
    let resolve, reject;
    const ack = new Promise((yes, no) => { resolve = yes; reject = no; });
    const active = { id, digest, text, turnId, at, ack, resolve, reject };
    this.active = active;
    // The RPC is in flight even before the first model delta. Keep Stop
    // available during long prefill; the separate receipt remains submitting.
    this.apply({ type:'started',threadId:this.threadId,turn:{id:turnId} });
    try {this.persist();}
    catch(error) {
      error.notSent=true;
      this.active=null;this.history.delete(turnId);
      this.runtime={...beforeRuntime,revision:this.runtime.revision+1,submission:{id,digest,status:'rejected',error:error.message}};
      this.emit('state',this.runtime);throw error;
    }
    options.onDurable?.();
    this.backstage.item(turnId,this.items.get(turnId+':user'),true);
    active.timer = setTimeout(() => {
      if (this.active !== active || active.accepted) return;
      const error = new Error('ACP 未在期限内返回执行证据；消息结果待核对');
      this.apply({ type: 'submission', submission: { ...this.runtime.submission, status: 'unknown', error: error.message } });
      reject(error);
      try { this.promptQueue.hold('提交结果待核对，消息未发送');this.persist(); }
      catch (storageError) { this.client.fail(storageError); this.emit('action-error', storageError.message); }
    }, this.options.ackTimeoutMs || 60000);
    this.client.request('session/prompt', { sessionId: this.threadId, prompt }, 0).then(result => {
      if (this.active !== active || this.closed) return;
      this.acknowledge();
      const status = result.stopReason === 'end_turn' ? 'completed' : result.stopReason === 'cancelled' ? 'interrupted' : 'failed';
      this.finish(active, status, status === 'failed' ? '原生执行停止：' + result.stopReason : null,result);
    }, error => {
      if (this.active !== active || this.closed) return;
      if (error.uncertain) {
        clearTimeout(active.cancelTimer);
        this.apply({ type: 'disconnect', reason: error.message });
        this.apply({ type: 'submission', submission: { ...this.runtime.submission, status: 'unknown', error: error.message } });
        active.reject(error);
        clearTimeout(active.timer);
        this.persist();
      } else {
        active.reject(error);
        this.apply({ type: 'submission', submission: { ...this.runtime.submission, status: 'rejected', error: error.message } });
        this.finish(active, 'failed', error.message);
      }
    }).catch(error => { this.client.fail(error); this.emit('action-error', error.message); });
    return ack;
  }
  finish(active, status, error, nativeResult) {
    clearTimeout(active.timer);
    clearTimeout(active.cancelTimer);
    if (this.runtime.turnId !== active.turnId) this.apply({ type: 'started', threadId: this.threadId, turn: { id: active.turnId } });
    const completedAt = Date.now();
    const turn = { ...this.history.get(active.turnId), status, items: [...this.items.values()], hubCompletedAt: completedAt, error };
    this.history.set(active.turnId, turn);
    try { this.persist(); }
    catch (storageError) {
      // Recovery must keep the unfinished turn visible; never publish completion
      // before its durable record exists.
      this.history.set(active.turnId, { ...turn, status:'inProgress', hubCompletedAt:undefined, error:undefined });
      throw storageError;
    }
    this.completed.set(active.turnId, { text: this.finalText(), status, completedAt, error });
    this.backstage.completed(turn,nativeResult);
    this.apply({ type: 'completed', threadId: this.threadId, turn: { id: active.turnId, status, ...(error ? { error: { message: error } } : {}) } });
    this.lifecycle(status === 'completed' ? 'turn-complete' : status === 'interrupted' ? 'turn-aborted' : 'turn-error',
      { text: this.finalText(), completedAt, finality: 'provider_final', message: error, durationMs: completedAt - active.at });
    this.active = null;
    this.changed();
    if(status!=='completed')this.promptQueue.hold('上一轮未正常完成，请确认后发送');
    else this.promptQueue.schedule();
  }
  finalText() { return this.blocks().map(block => block.text).join('\n\n'); }
  async readOutcome(turnId) {
    if (!turnId) return null;
    const turn = this.history.get(turnId);
    const result = this.completed.get(turnId) || (turn && TERMINAL.has(turn.status) ? {
      text: (turn.items || []).filter(i=>i.type==='agentMessage').map(i=>i.text || '').join('\n\n'),
      status: turn.status, completedAt: turn.hubCompletedAt, error: turn.error,
    } : null);
    if (!result) return null;
    return {hubSessionId:this.options.id,threadId:this.threadId,turnId,signalSource:BACKEND,
      ...result,abortedAt:result.completedAt,message:result.error,errorInfo:result.error,finality:'provider_final'};
  }
  blocks() { return [...this.items.values()].filter(item => item.type === 'agentMessage').map(item => ({
    type: 'text', text: item.text, id: item.id, itemId: item.id, threadId: this.threadId,
    turnId: this.active?.turnId || this.runtime.turnId, phase: 'message', ts: item.hubStartedAt })); }
  readTranscript(options = {}) {
    if (options.limit === 0) return [];
    let turns = options.turnId ? [this.history.get(options.turnId)].filter(Boolean)
      : options.latestTurn ? [...this.history.values()].slice(-1) : [...this.history.values()];
    // Each ACP turn has at least its user card. Select candidate turns before
    // converting large tool histories; slicing cards afterwards is too late.
    if(Number.isFinite(options.limit) && options.limit>0) turns = options.fromTail===false
      ? turns.slice(0,options.limit) : turns.slice(-options.limit);
    const cards = require('./codex-native-transcript').nativeTranscriptTurns(this.threadId,
      turns.map(turn => turn.id === this.active?.turnId ? { ...turn, items: [...this.items.values()] } : turn))
      .map(card => ({ ...card, source: BACKEND, kind: this.options.kind,
        ...(card.role==='assistant' ? (()=>{
          const turn=this.history.get(card.providerTurnId),context=turn?.contextUsage;
          return {...(turn?.model ? {model:turn.model}:{}),...(context ? {usage:{context_tokens:context.used,context_window:context.size}}:{})};
        })():{}),
        ...(card.toolCalls ? {toolCalls:card.toolCalls.map(tool=>({
          ...(options.toolPreviews && tool.input.type==='acpTool'
            ? require('./acp-tool-preview').toolPreview(tool,{hubSessionId:this.options.id,threadId:this.threadId,turnId:card.providerTurnId}) : tool),
          name:tool.input.title || (tool.input.type==='acpPlan' ? '执行计划' : tool.input.kind || tool.name)}))} : {}) }));
    return options.limit >= 0 ? options.fromTail === false ? cards.slice(0, options.limit) : cards.slice(-options.limit) : cards;
  }
  readToolResult({threadId,turnId,itemId}) {
    if(threadId!==this.threadId)throw new Error('工具详情不属于当前原生会话');
    const item=turnId===this.active?.turnId ? this.items.get(itemId)
      : this.history.get(turnId)?.items.find(item=>item.id===itemId);
    if(!item || item.type!=='acpTool')throw new Error('工具详情不存在，请重新载入会话');
    const result=item.result ?? item.content ?? item.error;
    return typeof result==='string' ? result : result==null ? '' : JSON.stringify(result,null,2);
  }
  async reply(requestId, result, epoch) {
    if (epoch !== this.runtime.epoch || this.runtime.connection !== 'connected') throw new Error('ACP 权限来自旧连接');
    const request = this.runtime.requests.find(r => r.id === requestId);
    if (!request || request.params.turnId !== this.active?.turnId || this.active.cancelling) throw new Error('ACP 权限请求已失效');
    const active = this.active, client = this.client;
    let revoked = false;
    const respond = async response => {
      await client.respond(requestId, response, null, value => {
        revoked = this.active !== active || active.cancelling || this.runtime.epoch !== epoch || this.closed;
        return revoked ? this.cancelResponse(request) : value;
      });
      if (revoked) throw new Error('ACP 权限请求已失效：轮次已停止');
    };
    if (request.method === 'elicitation/create') {
      const response = require('./acp-elicitation').validateElicitation(result, request.params.requestedSchema);
      await respond(response);
      this.apply({ type: 'resolved', threadId: this.threadId, requestId });
      return { ok: true };
    }
    const outcome = result?.outcome;
    if (!outcome || (outcome.outcome !== 'cancelled' && !(outcome.outcome === 'selected'
      && request.params.options?.some(option => option.optionId === outcome.optionId)))) throw new Error('ACP 权限选择无效');
    const questions = this.options.kind === 'qwen' && request.params.toolCall?._meta?.qwenQuestions;
    let answers;
    if (questions && outcome.outcome === 'selected' && request.params.options.find(o=>o.optionId===outcome.optionId)?.kind.startsWith('allow')) {
      answers = result.answers;
      if (!answers || questions.some((q,index)=>typeof answers[String(index)]!=='string' || !answers[String(index)].trim())) throw new Error('请填写每个问题的回答');
      if (Object.keys(answers).some(key=>!/^\d+$/.test(key) || Number(key)>=questions.length)) throw new Error('未知提问字段');
    }
    await respond({ outcome, ...(answers ? {answers} : {}) });
    this.apply({ type: 'resolved', threadId: this.threadId, requestId });
    return { ok: true };
  }
  cancelResponse(request) {
    return request.method === 'elicitation/create' ? { action:'cancel' } : { outcome:{ outcome:'cancelled' } };
  }
  async interrupt() {
    if (!this.active || this.runtime.connection !== 'connected') throw new Error('没有可确认的 ACP 活跃轮次');
    const active = this.active, client = this.client;
    if (active.cancelling) return { ok:true, pending:true };
    const requests = [...this.runtime.requests];
    // Fence both incoming requests and approvals already queued for writing
    // before any await or state callback can yield control to another action.
    active.cancelling = true;
    clearTimeout(active.timer);
    const timeoutMs = this.options.cancelTimeoutMs || 15000;
    active.cancelTimer = setTimeout(() => {
      if (this.active !== active || this.client !== client || this.closed) return;
      client.fail(new Error('ACP 停止未在期限内得到确认；结果未知，请核对原生记录，不会自动重发'));
    }, timeoutMs);
    this.apply({ type:'cancelling', threadId:this.threadId, turnId:active.turnId, deadlineAt:Date.now() + timeoutMs });
    this.promptQueue.hold('已停止，待发送消息保留供你确认');
    this.persist();
    try {
      const cancel = client.notify('session/cancel', { sessionId:this.threadId });
      // An already queued reply owns its incoming ID and has a write-time
      // revocation guard. Do not send a duplicate response for that ID.
      const replies = requests.filter(request => client.incoming.has(request.id))
        .map(request => client.respond(request.id, this.cancelResponse(request)));
      await Promise.all([cancel, ...replies]);
    } catch (error) { client.fail(error); throw error; }
    return { ok: true, pending: true };
  }
  async configure({ model, effort, configId, value:configValue }, starting = false) {
    if (!starting) await this.start();
    if(model && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model))throw new Error('套餐 profile 不允许切到其他供应商命名空间');
    if (this.active) throw new Error('请等待当前轮次结束后修改模型');
    if(this.configuring)throw new Error('正在确认上一项配置');
    this.configuring=true;
    try {
    if(configId) {
      const option=this.configOptions.find(o=>o.id===configId && ['mode','thought_level'].includes(o.category));
      const choice=option?.options?.flatMap(o=>o.options || [o]).find(o=>o.value===configValue);
      if(!choice)throw new Error('原生配置选项已失效');
      const result=await this.client.request('session/set_config_option',{sessionId:this.threadId,configId,value:configValue});
      if(result.configOptions?.find(o=>o.id===configId)?.currentValue!==configValue)throw new Error('原生 Harness 未确认设置');
      this.configOptions=result.configOptions;
    }
    for (const [category, value] of [['model', model], ['thought_level', effort]]) {
      if (!value) continue;
      const option = this.configOptions.find(o => o.category === category || o.id === (category === 'thought_level' ? 'reasoning_effort' : category));
      if (option) {
        const flat = (option.options || []).flatMap(o => o.options || [o]);
        const choice = flat.find(o => o.value === value || (category === 'model' && (
          (this.options.kind === 'qwen' && o.name === value)
          || (this.options.kind === 'glm' && o.value === 'hub-token-plan\\' + value)
          || (this.options.kind === 'deepseek-acp' && o.value === JSON.stringify(['bailian-tpp', value])))));
        if (!choice) throw new Error('Harness 未提供配置值：' + value);
        const response = await this.client.request('session/set_config_option', { sessionId: this.threadId, configId: option.id, value: choice.value });
        const confirmed = response.configOptions?.find(o => o.id === option.id);
        if (confirmed?.currentValue !== choice.value) throw new Error('Harness 未确认配置变更：' + value);
        this.configOptions = response.configOptions;
      } else if (category === 'model' && this.models?.currentModelId === value) {
        // Older ACP model capability already reports the requested model.
      } else if (category === 'model' && this.models?.availableModels?.some(m => m.modelId === value)) {
        await this.client.request('session/set_model', { sessionId: this.threadId, modelId: value });
      } else throw new Error('Harness 未声明可确认的配置：' + category);
      if (category === 'model') this.currentModel = value;
      if (category === 'thought_level') this.currentEffort = value;
    }
    this.currentEffort=this.configOptions.find(o=>o.category==='thought_level')?.currentValue || null;
    if(!this.bootstrapping)this.emit('bound', { threadId: this.threadId, model: this.currentModel, configOptions: this.configOptions });
    this.apply({type:'configuration',error:null});
    this.persist();
    return { ok: true, modelId:this.currentModel,displayName:this.currentModel,effort:this.currentEffort || null,appliesOn:'next-turn' };
    } catch(error) {
      if(error.uncertain)this.apply({type:'configuration',error:'原生配置结果不明，请重新连接核对后再发送'});
      throw error;
    } finally {this.configuring=false;}
  }
  async idle(timeoutMs = 0, signal) {
    await this.start();
    if (this.runtime.connection !== 'connected') throw new Error('ACP 连接异常');
    if (!this.active && this.runtime.submission?.status !== 'unknown') return;
    return new Promise((resolve, reject) => {
      let timer;
      const clean = () => { clearTimeout(timer); this.off('state', changed); signal?.removeEventListener('abort', abort); };
      const abort = () => { clean(); reject(signal.reason); };
      const changed = r => {
        if (r.connection !== 'connected') { clean(); reject(new Error('ACP 连接异常')); }
        else if (TERMINAL.has(r.state)) { clean(); resolve(); }
      };
      this.on('state', changed);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (timeoutMs) timer = setTimeout(() => { clean(); reject(new Error('ACP 尚未确认结束')); }, timeoutMs);
    });
  }
  async reconcile() { if (this.runtime.connection !== 'connected') throw new Error('ACP 需恢复连接'); return this.runtime; }
  async fork() {
    await this.start();
    if(this.active || this.runtime.connection!=='connected' || this.runtime.submission?.status==='unknown')throw new Error('请先确认当前轮次结束再分叉');
    let result;
    if(this.options.kind==='qwen') result=await this.client.request('qwen/control/session/branch',{sessionId:this.threadId});
    else if(this.capabilities.sessionCapabilities?.fork) result=await this.client.request('session/fork',{sessionId:this.threadId,cwd:this.options.cwd,modelId:this.currentModel,
      ...(this.options.kind==='glm'?{target:{kind:'turn',turnIndex:Math.max(0,this.history.size-1)}}:{})});
    else throw new Error('当前原生 Harness 不支持分叉');
    const sessionId=result.sessionId || result.newSessionId || result.forkedSessionId;
    if(!sessionId || sessionId===this.threadId)throw new Error('原生分叉未返回独立会话');
    this.persist();
    return {sessionId,home:this.options.home,history:[...this.history.values()]};
  }
  async reconnect() {
    if (this.active && this.runtime.connection === 'connected') throw new Error('当前 ACP 仍在执行，不重复启动');
    this.promptQueue.hold('连接已恢复，请确认后发送');
    this.persist();
    this.client?.close();
    this.runtime = { ...createNativeRuntime(this.runtime.epoch + 1), submission: this.runtime.submission };
    this.active = null;
    this.options.resumeId = this.threadId;
    this.ready = null;
    return this.start();
  }
  reviewUnknownSubmission(id, epoch) {
    if (this.active || this.runtime.connection !== 'connected' || this.runtime.epoch !== epoch
        || this.runtime.submission?.id !== id || this.runtime.submission?.status !== 'unknown') throw new Error('先恢复并核对原生会话');
    this.apply({ type: 'submission', submission: { ...this.runtime.submission, status: 'reviewed' } });
    this.persist();
    return { ok: true, resent: false };
  }
  write(data) {
    if (data === '\x03') this.interrupt().catch(error => this.emit('action-error',error.message));
    else this.emit('action-error','ACP 不接收终端按键，请使用 Hub 提交入口');
  }
  kill() {
    if (this.closed) return;
    try { this.promptQueue.hold('会话已关闭，消息未发送');this.persist(); }
    finally {
      this.closed = true;
      if (this.active) { clearTimeout(this.active.timer); clearTimeout(this.active.cancelTimer); this.active.reject(new Error('ACP 会话已关闭')); }
      this.client?.close();
      clearImmediate(this.promptQueue.scheduled);
      this.backstage.close();
      this._historyStore?.close();
      this._historyStore = null;
      this.emit('exit', { exitCode: 0 });
    }
  }
}
module.exports = { AcpSession, BACKEND };
