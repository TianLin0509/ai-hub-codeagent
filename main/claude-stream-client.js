'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { randomUUID, createHash } = require('crypto');
const { TextDecoder } = require('util');
const { NATIVE_CONFIRMATION_MS } = require('../core/native-confirmation-policy');

// Wire contract: anthropics/claude-agent-sdk-python, _internal/query.py.
// This is the CLI's bidirectional SDK transport, never a terminal/key writer.
const PROTOCOL_FLAGS = new Set(['-p', '--print', '--input-format', '--output-format',
  '--permission-prompt-tool', '--replay-user-messages', '--include-partial-messages']);

function streamArgs(launchArgs = []) {
  if (!Array.isArray(launchArgs) || launchArgs.some(arg => typeof arg !== 'string')) {
    throw new TypeError('Claude launchArgs must be an array of strings');
  }
  for (const arg of launchArgs) {
    if (PROTOCOL_FLAGS.has(arg.split('=')[0])) {
      throw new Error('Claude protocol flag is owned by the transport: ' + arg.split('=')[0]);
    }
  }
  return ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--replay-user-messages', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', ...launchArgs];
}

function protocolError(message, code = 'CLAUDE_PROTOCOL_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

class ClaudeStreamClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.proc = null;
    this.closed = false;
    this.failure = null;
    this.ready = null;
    this.pending = new Map();
    this.requests = new Map();
    this.answeredRequests = new Map();
    this.expired = new Set();
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.buffer = '';
    this.stderrTail = '';
    this.writeQueue = Promise.resolve();
  }

  start() {
    if (!this.ready) this.ready = this._start();
    return this.ready;
  }

  async _start() {
    if (this.closed) throw protocolError('Claude transport is closed', 'CLAUDE_CLOSED');
    const args = [...(this.options.commandArgs || []), ...streamArgs(this.options.launchArgs)];
    // An explicit environment is complete. Re-merging process.env here would
    // restore credentials/callbacks deliberately removed by an isolated caller.
    const env = { ...(this.options.env || process.env) };
    // Nested interactive-session guards must not bind a child to its parent.
    delete env.CLAUDECODE;
    const executable = this.options.executable || (process.platform === 'win32' ? 'claude.exe' : 'claude');
    this.proc = spawn(executable, args, { cwd: this.options.cwd, env,
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', error => this.fail(protocolError('Claude process: ' + error.message, 'CLAUDE_PROCESS_ERROR')));
    this.proc.stdin.on('error', error => this.fail(protocolError('Claude stdin: ' + error.message, 'CLAUDE_WRITE_ERROR')));
    this.proc.stdout.on('error', error => this.fail(protocolError('Claude stdout: ' + error.message)));
    this.proc.stderr.on('error', error => this.fail(protocolError('Claude stderr: ' + error.message)));
    this.proc.stderr.on('data', chunk => {
      const message = chunk.toString('utf8');
      this.stderrTail = (this.stderrTail + message).slice(-8192);
      this.emit('diagnostic', { type: 'stderr', message });
    });
    this.proc.stdout.on('data', chunk => {
      try { this.consume(this.decoder.decode(chunk, { stream: true })); }
      catch (error) { this.fail(protocolError('Invalid Claude stream: ' + error.message)); }
    });
    this.proc.stdout.on('end', () => {
      try {
        this.inputEnded = true;
        this.consume(this.decoder.decode());
      } catch (error) { this.fail(protocolError('Invalid Claude stream ending: ' + error.message)); }
    });
    this.proc.on('close', (code, signal) => {
      this.processExit = { code, signal };
      this.finishProcessExit();
    });
    try {
      const info = await this.control({ subtype: 'initialize' }, this.options.initializeTimeoutMs || 60000);
      if (this.failure) throw this.failure;
      this.initialization = info;
      this.emit('ready', info);
      return info;
    } catch (error) {
      this.fail(error);
      await this.close();
      throw error;
    }
  }

  consume(text) {
    if (this.failure || this.closed) return;
    this.buffer += text;
    if (this.consumeContinuation) return;
    const deadline = performance.now() + 8;
    const limit = this.options.maxFrameBytes || 16 * 1024 * 1024;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line, 'utf8') > limit) throw new Error('JSONL frame exceeds configured limit');
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message || Array.isArray(message) || typeof message.type !== 'string') {
        throw new Error('JSONL frame has no message type');
      }
      this.receive(message);
      if (this.failure || this.closed) return;
      if (performance.now() >= deadline && this.buffer.includes('\n')) {
        this.proc?.stdout?.pause();
        this.consumeContinuation = setImmediate(() => {
          this.consumeContinuation = null;
          try { this.consume(''); }
          catch (error) { this.fail(protocolError('Invalid Claude stream: ' + error.message)); }
          this.finishProcessExit();
        });
        return;
      }
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > limit) throw new Error('JSONL frame exceeds configured limit');
    if (this.inputEnded) {
      if (this.buffer.trim()) throw new Error('truncated JSONL frame');
      if (!this.closed) this.fail(protocolError('Claude stdout ended', 'CLAUDE_DISCONNECTED'));
    } else this.proc?.stdout?.resume();
  }

  finishProcessExit() {
    // 'close' can follow EOF before a yielded parser drains complete frames.
    // Publish those receipts before reporting the process exit to the session.
    if (!this.processExit || this.consumeContinuation) return;
    const { code, signal } = this.processExit;
    this.processExit = null;
    const expected = this.closed;
    if (!expected) this.fail(protocolError(`Claude exited (${code ?? signal})`, 'CLAUDE_PROCESS_EXIT'));
    this.emit('exit', { code, signal, expected });
  }

  receive(message) {
    if (message.type === 'control_response') {
      const response = message.response;
      if (!response || typeof response.request_id !== 'string'
          || !['success', 'error'].includes(response.subtype)) throw new Error('Malformed control response');
      const pending = this.pending.get(response.request_id);
      if (!pending) {
        this.emit('diagnostic', { type: this.expired.has(response.request_id) ? 'late-response' : 'unmatched-response',
          requestId: response.request_id });
        return;
      }
      this.pending.delete(response.request_id);
      clearTimeout(pending.timer);
      if (response.subtype === 'error') {
        const error = protocolError(String(response.error || 'Claude rejected control request'), 'CLAUDE_CONTROL_REJECTED');
        pending.reject(error); pending.confirmReject?.(error);
      } else {
        pending.resolve(response.response || {}); pending.confirmResolve?.(response.response || {});
      }
      return;
    }
    if (message.type === 'control_request') {
      if (typeof message.request_id !== 'string' || !message.request || typeof message.request.subtype !== 'string') {
        throw new Error('Malformed server control request');
      }
      const signature = createHash('sha256').update(JSON.stringify(message.request)).digest('hex');
      const answered = this.answeredRequests.get(message.request_id);
      if (answered) {
        if (answered !== signature) throw new Error('Control request ID reused with different content');
        this.emit('diagnostic', { type: 'answered-request-repeated', requestId: message.request_id });
        return;
      }
      const previous = this.requests.get(message.request_id);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(message)) throw new Error('Control request ID reused with different content');
        return;
      }
      this.requests.set(message.request_id, message);
      this.emit('request', message);
      return;
    }
    if (message.type === 'control_cancel_request') {
      this.requests.delete(message.request_id);
      this.emit('request-cancelled', message.request_id);
      return;
    }
    this.emit('message', message);
  }

  write(message) {
    // JSON encoding preserves newlines/Unicode as one protocol message. No shell.
    let line;
    try { if (typeof message !== 'function') line = JSON.stringify(message) + '\n'; }
    catch (error) { return Promise.reject(error); }
    const send = () => new Promise((resolve, reject) => {
      if (this.failure || this.closed || !this.proc || this.proc.stdin.destroyed) {
        reject(this.failure || protocolError('Claude transport is not writable', 'CLAUDE_CLOSED'));
        return;
      }
      if (typeof message === 'function') {
        try { line = JSON.stringify(message()) + '\n'; }
        catch (error) { reject(error); return; }
      }
      this.proc.stdin.write(line, 'utf8', error => {
        if (error) {
          this.fail(protocolError('Claude write failed: ' + error.message, 'CLAUDE_WRITE_ERROR'));
          reject(this.failure);
        } else resolve();
      });
    });
    const result = this.writeQueue.then(send);
    // Only recover the queue cursor; the caller still receives the rejection.
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  control(request, timeoutMs = this.options.controlTimeoutMs || NATIVE_CONFIRMATION_MS, options = {}) {
    const id = randomUUID();
    let confirmResolve, confirmReject;
    const confirmation = new Promise((resolve, reject) => { confirmResolve = resolve; confirmReject = reject; });
    confirmation.catch(() => undefined); // Callers may only need the bounded response.
    const response = new Promise((resolve, reject) => {
      const pending = { resolve, reject, confirmResolve, confirmReject, sent: false };
      const timer = setTimeout(() => {
        const error = protocolError('Claude control timeout: ' + request.subtype
          + (pending.sent ? '；设置或操作结果待核对' : '；请求尚未写入，已取消'), 'CLAUDE_CONTROL_TIMEOUT');
        error.uncertain = pending.sent;
        error.notSent = !pending.sent;
        // Sent mutations retain their exact request ID until a reply or a real
        // disconnect. The session can reconcile that late reply without replay.
        if (!pending.sent || !options.reconcileLate) {
          this.pending.delete(id);
          this.expired.add(id);
          if (this.expired.size > 256) this.expired.delete(this.expired.values().next().value);
          confirmReject(error);
        }
        reject(error);
      }, timeoutMs);
      pending.timer = timer;
      this.pending.set(id, pending);
      this.write(() => {
        if (this.pending.get(id) !== pending) {
          const error = protocolError('Claude control expired before write', 'CLAUDE_CONTROL_CANCELLED');
          error.notSent = true;
          throw error;
        }
        pending.sent = true;
        return { type: 'control_request', request_id: id, request };
      }).catch(error => {
        const pending = this.pending.get(id);
        if (pending) { this.pending.delete(id); clearTimeout(timer); reject(error); confirmReject(error); }
      });
    });
    response.confirmation = confirmation;
    return response;
  }

  async respond(requestId, response, errorMessage = null, beforeWrite) {
    if (!this.requests.has(requestId)) throw protocolError('Claude request is no longer pending', 'CLAUDE_STALE_REQUEST');
    this.answeredRequests.set(requestId, createHash('sha256').update(JSON.stringify(this.requests.get(requestId).request)).digest('hex'));
    // Remove before awaiting write: two clicks cannot answer the same request.
    this.requests.delete(requestId);
    await this.write(() => ({ type: 'control_response', response: errorMessage
      ? { subtype: 'error', request_id: requestId, error: String(errorMessage) }
      : { subtype: 'success', request_id: requestId, response:beforeWrite ? beforeWrite(response) : response } }));
  }

  fail(error) {
    if (this.failure || this.closed) return;
    this.failure = error;
    clearImmediate(this.consumeContinuation); this.consumeContinuation=null;
    this.proc?.stdout?.resume();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); pending.confirmReject?.(error); }
    this.pending.clear();
    this.requests.clear();
    this.answeredRequests.clear();
    this.emit('disconnect', error);
    this.finishProcessExit();
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearImmediate(this.consumeContinuation); this.consumeContinuation=null;
    this.finishProcessExit();
    this.proc?.stdout?.resume();
    const error = protocolError('Claude transport closed', 'CLAUDE_CLOSED');
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); pending.confirmReject?.(error); }
    this.pending.clear();
    this.requests.clear();
    this.answeredRequests.clear();
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    this.closePromise = new Promise((resolve, reject) => {
      let finalTimer;
      const timer = setTimeout(() => {
        // Only the exact child owned by this client. Never search other processes.
        try {
          // Windows can report "already gone" before Node has delivered close.
          // The bounded close event, not kill's boolean, confirms the child exit.
          if (proc.exitCode === null && proc.signalCode === null) proc.kill();
          finalTimer = setTimeout(() => reject(protocolError('Claude child did not exit after termination', 'CLAUDE_CLOSE_TIMEOUT')), 3000);
        } catch (error) { reject(error); }
      }, this.options.closeTimeoutMs || 3000);
      proc.once('close', () => { clearTimeout(timer); clearTimeout(finalTimer); resolve(); });
      proc.stdin.end();
    });
    return this.closePromise;
  }
}

module.exports = { ClaudeStreamClient, streamArgs, protocolError };
