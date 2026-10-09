'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { CodexRuntimeBroker } = require('../core/codex-runtime-broker');
const { PROTOCOL_VERSION, metadataPath, pipeName } = require('./codex-runtime-broker-client');
const runtimeBuild = require('../core/runtime-build-info').runtimeBuildInfo();
const { SharedContentEncoder } = require('../core/shared-content-codec');

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function writeMetadata(dataDir, data) {
  const target = metadataPath(dataDir);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding:'utf8', mode:0o600 });
  try { fs.renameSync(tmp, target); }
  catch (error) {
    if (!['EEXIST','EPERM'].includes(error.code)) throw error;
    // The server already owns the deterministic pipe, so a different file at
    // this exact path is stale discovery metadata, not another live broker.
    fs.unlinkSync(target);
    fs.renameSync(tmp, target);
  }
}

function removeOwnMetadata(dataDir, serviceId) {
  const target = metadataPath(dataDir);
  try {
    const current = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (current.serviceId === serviceId && current.pid === process.pid) fs.unlinkSync(target);
  } catch {}
}

class Peer extends EventEmitter {
  constructor(socket, broker, token, serviceId) {
    super();
    this.socket = socket;
    this.broker = broker;
    this.token = token;
    this.serviceId = serviceId;
    this.buffer = '';
    this.authenticated = false;
    this.views = new Map();
    this.closed = false;
    this.blocked = false;
    this.outbound = [];
    this.coalesced = new Map();
    this.contentEncoder = new SharedContentEncoder();
    socket.setEncoding('utf8');
    socket.on('data', chunk => this.feed(chunk));
    socket.on('error', error => this.close(error));
    socket.on('close', () => this.close());
    socket.on('drain', () => { this.blocked=false; this.flush(); });
  }
  send(message) {
    if (this.closed || this.socket.destroyed) return;
    if(message.method==='session-event' && message.params.event==='lifecycle') {
      for(const key of this.coalesced.keys())if(key.startsWith('control:'))this.coalesced.delete(key);
    }
    const key = message.method === 'content' ? `content:${message.params.key}:${message.params.replaceTurnId || ''}`
      : message.method === 'control' ? `control:${message.params.key}:${message.params.control.viewId}` : null;
    const pending = key && this.coalesced.get(key);
    if (pending) {
      // Claude updates can include a just-completed background activity plus
      // a foreground record. Keep both when a slow view coalesces snapshots.
      const older=pending.message.params?.nativeRecords,newer=message.params?.nativeRecords;
      if(older && newer && !message.params.replaceNativeRecords) {
        const rows=new Map(older.map(row=>[row.userMessageId,row]));
        for(const row of newer)rows.set(row.userMessageId,row);
        pending.message={...message,params:{...message.params,nativeRecords:[...rows.values()],
          replaceNativeRecords:pending.message.params.replaceNativeRecords || false}};
      } else pending.message = message;
    }
    else {
      const entry={message,key};
      this.outbound.push(entry);
      if(key)this.coalesced.set(key,entry);
    }
    this.flush();
  }
  flush() {
    while (!this.blocked && !this.closed && !this.socket.destroyed && this.outbound.length) {
      const entry=this.outbound.shift();
      if(entry.key && this.coalesced.get(entry.key)===entry)this.coalesced.delete(entry.key);
      this.write(entry.message);
    }
  }
  write(message) {
    let line;
    try {
      // Encode only when written, after coalescing. Computing patches when
      // queued would make the next patch depend on a snapshot never delivered.
      if (message.deltaContent) {
        message = { method:'content-delta', params:{ key:message.params.key,
          transfer:this.contentEncoder.encode(message.params.key, message.params) } };
      }
      line = JSON.stringify(message) + '\n';
    }
    catch (error) {
      this.socket.destroy(new Error('Codex 共享服务响应无法序列化：' + error.message));
      return;
    }
    // Respect Node stream backpressure; a brief reader delay is not a lost
    // Codex connection. Only redundant content snapshots are coalesced.
    this.blocked = !this.socket.write(line);
  }
  feed(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_MESSAGE_BYTES) {
      this.close(new Error('消息超过 32 MiB'));
      this.socket.destroy();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.socket.destroy(); return; }
      void this.handle(message);
    }
  }
  async handle(message) {
    const id = message && message.id;
    if (id == null || typeof message.method !== 'string') return;
    try {
      let result;
      if (!this.authenticated) {
        if (message.method !== 'hello' || message.params?.token !== this.token) throw Object.assign(new Error('Codex 共享服务认证失败'), { code:'unauthorized' });
        if (message.params?.protocolVersion !== PROTOCOL_VERSION) throw Object.assign(new Error('Codex 共享服务协议版本不兼容'), { code:'protocol-mismatch' });
        this.authenticated = true;
        result = { serviceId:this.serviceId, protocolVersion:PROTOCOL_VERSION, pid:process.pid,
          runtimeBuild, upgrade:this.broker.upgrade?.request(message.params?.runtimeBuild) || null,
          features:['content-delta-v1','claude-shared-v1','idle-upgrade-v1','codex-backstage-v1','codex-tool-preview-v1'] };
      } else if (message.method === 'hello') throw new Error('Codex 共享服务已经初始化');
      else result = await this.broker.handle(this, message.method, message.params || {});
      this.send({ id, result });
    } catch (error) {
      this.send({ id, error:{ code:error.code || 'request-failed', message:error.message || String(error) } });
    }
  }
  close(error) {
    if (this.closed) return;
    this.closed = true;
    this.outbound.length = 0;
    this.coalesced.clear();
    this.contentEncoder.entries.clear();
    this.broker.disconnect(this);
    if (error) console.warn(`[codex-broker] ${new Date().toISOString()} service=${this.serviceId} peer closed:`, error.message);
    this.emit('closed');
  }
}

function main() {
  const dataDir = path.resolve(readArg('--data-dir') || '');
  const token = process.env.AI_HUB_CODEX_BROKER_TOKEN;
  const serviceId = process.env.AI_HUB_CODEX_BROKER_SERVICE_ID;
  if (!dataDir || !token || !serviceId) throw new Error('Codex broker 启动参数不完整');
  fs.mkdirSync(dataDir, { recursive:true });
  const pipe = pipeName(dataDir);
  const fixtureMode = !!(process.env.CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE || process.env.CLAUDE_HUB_CLAUDE_STREAM_FIXTURE);
  const broker = new CodexRuntimeBroker({ serviceId, idleRetentionMs:fixtureMode ? 1000 : 30 * 60_000 });
  const peers = new Set();
  let lastPeerAt = Date.now();
  const server = net.createServer(socket => {
    const peer = new Peer(socket, broker, token, serviceId);
    lastPeerAt = Date.now();
    peers.add(peer);
    peer.once('closed', () => { peers.delete(peer); lastPeerAt = Date.now(); });
  });
  broker.runtimeBuild = runtimeBuild;
  broker.upgrade = require('../core/broker-upgrade').createBrokerUpgrade({ broker, build:runtimeBuild, onReady:() => {
    console.log(`[codex-broker] ${new Date().toISOString()} idle upgrade; writers released`);
    for (const peer of peers) peer.socket.end();
    const closeTimer = setTimeout(() => { for (const peer of peers) peer.socket.destroy(); }, 2000);
    closeTimer.unref?.();
    server.close(() => { clearTimeout(closeTimer); process.exit(0); });
  } });
  broker.checkUpgrade = broker.upgrade.check;
  server.on('error', error => { console.error('[codex-broker] server error:', error.stack || error); process.exitCode = 1; });
  server.listen(pipe, () => {
    writeMetadata(dataDir, {
      protocolVersion:PROTOCOL_VERSION, serviceId, token, pipe, pid:process.pid,
      startedAt:Date.now(), root:path.resolve(__dirname, '..'), runtimeBuild,
    });
    console.log(`[codex-broker] listening pid=${process.pid} service=${serviceId}`);
  });
  const cleanup = () => removeOwnMetadata(dataDir, serviceId);
  const idleExit = setInterval(() => {
    const fixtureDone = fixtureMode && !peers.size && Date.now() - lastPeerAt >= 2000;
    if (fixtureDone || (!peers.size && !broker.records.size)) server.close(() => process.exit(0));
  }, fixtureMode ? 500 : 60_000);
  idleExit.unref?.();
  process.on('exit', cleanup);
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

if (require.main === module) main();

module.exports = { Peer, writeMetadata, removeOwnMetadata };
