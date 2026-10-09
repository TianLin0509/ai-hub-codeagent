'use strict';

const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

// ACP stdio is newline-delimited JSON-RPC 2.0, never a PTY or shell.
class AcpClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.pending = new Map();
    this.incoming = new Set();
    this.nextId = 1;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');
    this.stderrBuffer = '';
    this.tail = Promise.resolve();
    this.closed = false;
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    return this.ready;
  }
  redact(value) {
    let text = String(value);
    for (const secret of this.options.secrets || []) if (secret) text = text.split(secret).join('[REDACTED]');
    return text.replace(/\bsk-[\w.\-]{8,}/g, '[REDACTED]');
  }
  async _start() {
    const { command, args = [], cwd, env } = this.options;
    if (!command) throw new Error('ACP 可执行文件未配置');
    try {
      this.proc = (this.options.spawn || spawn)(command, args, {
        cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc.once('error', error => this.fail(error));
      this.proc.once('exit', (code, signal) => this.fail(new Error(`ACP 进程退出 (${code ?? signal})`)));
      this.proc.stdin.on('error', error => this.fail(error));
      this.proc.stdout.on('data', bytes => this.feed(bytes));
      this.proc.stdout.on('error', error => this.fail(error));
      this.proc.stdout.once('end', () => this.fail(new Error('ACP 输出连接已关闭')));
      this.proc.stderr.on('data', bytes => {
        this.stderrBuffer += this.stderrDecoder.write(bytes);
        for(let nl;(nl=this.stderrBuffer.indexOf('\n'))>=0;) {
          const line=this.stderrBuffer.slice(0,nl);this.stderrBuffer=this.stderrBuffer.slice(nl+1);
          this.emit('diagnostic',this.redact(line).slice(-8192));
        }
        if(this.stderrBuffer.length>65536){this.stderrBuffer='';this.emit('diagnostic','ACP 超长诊断已省略');}
      });
      this.proc.stderr.on('error', error => this.fail(error));
      this.proc.stderr.once('end',()=>{
        this.stderrBuffer+=this.stderrDecoder.end();
        if(this.stderrBuffer)this.emit('diagnostic',this.redact(this.stderrBuffer).slice(-8192));
        this.stderrBuffer='';
      });
      const result = await this.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'ai-hub', version: '1' },
        clientCapabilities: this.options.capabilities || {},
      });
      if (result?.protocolVersion !== 1) throw new Error('ACP 协议版本不兼容');
      this.initialized = result;
      return result;
    } catch (error) { this.fail(error); throw error; }
  }
  feed(bytes) {
    if (this.closed) return;
    this.buffer += this.decoder.write(bytes);
    if (!this.feedContinuation) this.drain();
  }
  drain() {
    if (this.closed) return;
    const deadline = performance.now() + 8;
    const max = this.options.maxBytes || 16 * 1024 * 1024;
    for (let nl; (nl = this.buffer.indexOf('\n')) >= 0;) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > max) return this.fail(new Error('ACP 消息超过大小限制'));
      let message;
      try { message = JSON.parse(line); }
      catch { return this.fail(new Error('ACP stdout 含非 JSON 协议消息')); }
      if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) return this.fail(new Error('ACP JSON-RPC 消息无效'));
      if (typeof message.method === 'string') {
        if (message.id != null) {
          if (this.incoming.has(message.id)) return this.fail(new Error('ACP 交互请求 ID 重复'));
          this.incoming.add(message.id);
          if (!this.listenerCount('request')) {
            this.respond(message.id, null, { code: -32601, message: 'Client method unsupported' }).catch(error => this.fail(error));
          } else this.emit('request', message);
        } else this.emit('notification', message);
      } else if (message.id != null) {
        const pending = this.pending.get(message.id);
        if (!pending) { this.emit('late-response', { id: message.id }); continue; }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const summary = message.error.message || 'ACP 请求失败';
          const detail = message.error.data?.details;
          const reason = summary === 'Internal error' && typeof detail === 'string'
            ? `${summary}: ${detail.slice(0, 2048)}` : summary;
          pending.reject(Object.assign(new Error(this.redact(reason)), {
          code: message.error.code, details: message.error.data == null ? null : this.redact(JSON.stringify(message.error.data)), uncertain: false }));
        } else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
        else pending.reject(Object.assign(new Error('ACP 响应缺少 result/error'), { uncertain: true }));
      } else return this.fail(new Error('ACP 消息缺少请求身份'));
      if (this.closed) return;
      if (performance.now() >= deadline && this.buffer.includes('\n')) {
        this.proc?.stdout?.pause();
        this.feedContinuation = setImmediate(() => {
          this.feedContinuation = null;
          this.drain();
        });
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > max) this.fail(new Error('ACP 未结束消息超过大小限制'));
    else if (!this.closed) this.proc?.stdout?.resume();
  }
  send(message) {
    const write = this.tail.then(() => new Promise((resolve, reject) => {
      if (this.closed || !this.proc) return reject(Object.assign(new Error('ACP 连接不可用'), { notSent: true }));
      // Evaluate response guards at the actual serialized write, not when an
      // approval first joins the queue. Stop can revoke it while stdin drains.
      const frame = typeof message === 'function' ? message() : message;
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n', 'utf8', error => error ? reject(error) : resolve());
    }));
    this.tail = write.catch(error => { if (!error.notSent) this.fail(error); });
    return write;
  }
  request(method, params, timeoutMs = this.options.timeoutMs || 30000) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`ACP 请求超时：${method}；结果待核对`), { uncertain: true }));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params }).catch(error => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(Object.assign(error, { uncertain: !error.notSent }));
      });
    });
    promise.requestId = id;
    return promise;
  }
  notify(method, params) { return this.send({ method, params }); }
  async respond(id, result, error, beforeWrite) {
    if (!this.incoming.has(id)) throw new Error('ACP 交互请求已失效');
    this.incoming.delete(id);
    await this.send(() => ({ id, ...(error ? { error } : { result: beforeWrite ? beforeWrite(result) : result }) }));
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    clearImmediate(this.feedContinuation);
    this.feedContinuation = null;
    const failure = Object.assign(new Error(this.redact(error.message)), { uncertain: true });
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(failure); }
    this.pending.clear();
    this.incoming.clear();
    this.emit('disconnect', failure);
    // Only the exact child we spawned, never a name/command-line process scan.
    if (this.proc && this.proc.exitCode == null && !this.proc.killed) {
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill.exe',['/pid',String(this.proc.pid),'/t','/f'],{windowsHide:true,stdio:'ignore',timeout:7000});
        if (result.error || result.status !== 0) this.emit('diagnostic','ACP 进程树清理未确认：'+(result.error?.message || result.status));
      } else this.proc.kill();
    }
    this.proc?.stdin?.destroy();
  }
  close() { this.fail(new Error('ACP 连接已关闭')); }
}

module.exports = { AcpClient };
