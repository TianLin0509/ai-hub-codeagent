'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createHash, randomUUID } = require('crypto');
const { spawn } = require('child_process');

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

function metadataPath(dataDir) {
  return path.join(dataDir, 'codex-runtime-broker.json');
}

function startLockPath(dataDir) {
  return path.join(dataDir, 'codex-runtime-broker.start.lock');
}

function pipeName(dataDir) {
  const hash = createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ai-hub-codex-${hash}`
    : path.join(dataDir, `.codex-runtime-${hash}.sock`);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function readMetadata(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(metadataPath(dataDir), 'utf8'));
    return value && value.protocolVersion === PROTOCOL_VERSION ? value : null;
  } catch { return null; }
}

class BrokerConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => this.feed(chunk));
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('Codex 共享服务连接已关闭')));
  }
  feed(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_MESSAGE_BYTES) {
      this.fail(new Error('Codex 共享服务消息超过 32 MiB'));
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
      catch (error) { this.fail(new Error('Codex 共享服务返回损坏的 JSON：' + error.message)); return; }
      if (message.id != null) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Codex 共享服务请求失败'), { code:message.error.code }));
        else pending.resolve(message.result);
      } else if (message.method) this.emit('notification', message);
    }
  }
  request(method, params = {}, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Error('Codex 共享服务连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 共享服务请求超时：${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve:value => { clearTimeout(timer); resolve(value); },
        reject:error => { clearTimeout(timer); reject(error); },
      });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n', 'utf8', error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) { this.pending.delete(id); pending.reject(error); }
      });
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.socket.destroyed) this.socket.destroy?.();
    this.emit('disconnect', error);
  }
  close() {
    if (this.closed) return;
    this.socket.end();
    this.fail(new Error('Codex 共享服务连接已关闭'));
  }
}

function openSocket(pipe, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    const timer = setTimeout(() => socket.destroy(new Error('Codex 共享服务暂未响应')), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function connectMetadata(dataDir, metadata) {
  if (!metadata || !metadata.pipe || !metadata.token || !alive(Number(metadata.pid))) {
    throw new Error('Codex 共享服务登记已失效');
  }
  const connection = new BrokerConnection(await openSocket(metadata.pipe));
  try {
    const hello = await connection.request('hello', {
      token:metadata.token, protocolVersion:PROTOCOL_VERSION, hubPid:process.pid,
      runtimeBuild:require('../core/runtime-build-info').runtimeBuildInfo(),
    }, 3000);
    if (!hello || hello.serviceId !== metadata.serviceId || hello.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error('Codex 共享服务身份或协议不匹配');
    }
    connection.metadata = metadata;
    connection.features = Array.isArray(hello.features) ? hello.features : [];
    connection.runtimeBuild = hello.runtimeBuild || null;
    connection.upgrade = hello.upgrade || (hello.runtimeBuild ? null : { status:'legacy', reason:'共享后台尚未支持安全更新，现有工作保持运行；旧后台退出后才会加载新代码' });
    if (hello.upgrade?.status === 'draining') throw Object.assign(new Error('共享后台正在空闲交接，稍后自动恢复连接'), { code:'broker-upgrading' });
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

function tryAcquireStartLock(dataDir) {
  const lockPath = startLockPath(dataDir);
  const nonce = randomUUID();
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid:process.pid, nonce, at:Date.now() }), 'utf8');
    fs.closeSync(fd);
    return { lockPath, nonce };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (record.childPid ? !alive(Number(record.childPid)) : !alive(Number(record.pid))) fs.unlinkSync(lockPath);
    } catch {}
    return null;
  }
}

function releaseStartLock(lock) {
  if (!lock) return;
  try {
    const record = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
    if (record.nonce === lock.nonce) fs.unlinkSync(lock.lockPath);
  } catch {}
}

function launchBroker(dataDir) {
  const script = path.join(__dirname, 'codex-runtime-broker-process.js');
  const token = randomUUID() + randomUUID();
  const serviceId = randomUUID();
  const logDir = path.join(dataDir, 'diagnostics');
  fs.mkdirSync(logDir, { recursive:true });
  const logPath = path.join(logDir, 'codex-runtime-broker.log');
  const logFd = fs.openSync(logPath, 'a');
  const env = { ...process.env, AI_HUB_CODEX_BROKER_TOKEN:token, AI_HUB_CODEX_BROKER_SERVICE_ID:serviceId };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(process.execPath, [script, '--data-dir', dataDir], {
    env, detached:true, windowsHide:true, stdio:['ignore',logFd,logFd],
  });
  child.once('error', error => {
    try { fs.appendFileSync(logPath, `[codex-broker] launch failed: ${error.message}\n`, 'utf8'); } catch {}
  });
  fs.closeSync(logFd);
  child.unref();
  return { token, serviceId, pid:child.pid };
}

async function connectBroker({ dataDir, timeoutMs = 12_000 } = {}) {
  dataDir = path.resolve(dataDir || path.join(os.homedir(), '.ai-hub-community'));
  fs.mkdirSync(dataDir, { recursive:true });
  const deadline = Date.now() + timeoutMs;
  let launched = null;
  let lastError = null;
  let startLock = null;
  try {
  while (Date.now() < deadline) {
    const metadata = readMetadata(dataDir);
    if (metadata) {
      try { return await connectMetadata(dataDir, metadata); }
      catch (error) { lastError = error; }
    }
    // Keep the lock until the child publishes its pipe. Releasing it just
    // after spawn launched another broker every 100 ms during slow startup.
    if (!startLock && !(metadata && alive(Number(metadata.pid)))) startLock = tryAcquireStartLock(dataDir);
    if (startLock && !launched) {
        const existing = readMetadata(dataDir);
        if (existing) {
          try { return await connectMetadata(dataDir, existing); }
          catch (error) { lastError = error; }
        }
        launched = launchBroker(dataDir);
        fs.writeFileSync(startLock.lockPath, JSON.stringify({ pid:process.pid, childPid:launched.pid,
          nonce:startLock.nonce, at:Date.now() }), {encoding:'utf8',mode:0o600});
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('无法启动或连接 Codex 共享服务' + (lastError ? '：' + lastError.message : launched ? `（PID ${launched.pid}）` : ''));
  } finally {
    // A slow child still owns this startup attempt after the caller times out.
    // Its PID stays in the lock so another caller waits instead of respawning.
    if (!launched || !alive(Number(launched.pid)) || readMetadata(dataDir)?.serviceId===launched.serviceId) releaseStartLock(startLock);
  }
}

const acquireBroker = require('./broker-connect-singleflight').createBrokerConnector(connectBroker, connectMetadata);
module.exports = { PROTOCOL_VERSION, BrokerConnection, connectBroker, acquireBroker, metadataPath, pipeName, readMetadata };
