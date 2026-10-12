'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const MIN_LENGTH = 2048;
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function atomicJson(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function inputError(message) { return Object.assign(new Error(message), { notSent: true, code: 'codex-editor-input' }); }

// Any custom keymap may shadow Ctrl+G. Leave these sessions on their existing
// input path instead of guessing a shortcut or changing the user's config.
function hasCustomKeymap(home, cwd) {
  const files = new Set([path.join(home, 'config.toml')]);
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    files.add(path.join(dir, '.codex', 'config.toml'));
    if (path.dirname(dir) === dir) break;
  }
  for (const file of files) {
    try { if (/\bkeymap\b/.test(fs.readFileSync(file, 'utf8'))) return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

class CodexEditorInput {
  constructor(directory) {
    this.directory = directory;
    this.pending = null;
    this.closed = false;
    this.failed = false;
    this.lastTransfer = null;
  }

  // Parse only raw terminal protocol, before the scrollback compatibility layer.
  // Codex restores modes, flushes queued keys, then redraws. Its first completed
  // frame after the disable/enable cycle is our key-input resumption barrier.
  onOutput(data) {
    const p = this.pending;
    if (!p) return;
    const text = p.carry + String(data);
    const pattern = /\x1b\[\?(2004|2026)([hl])/g;
    let m;
    while ((m = pattern.exec(text))) {
      if (m[1] === '2004' && m[2] === 'l') p.suspended = true;
      else if (m[1] === '2004' && m[2] === 'h' && p.suspended) p.resumed = true;
      else if (m[1] === '2026' && m[2] === 'l' && p.resumed) p.frame = true;
    }
    // Carry only a partial CSI sequence, never re-process a complete marker.
    const last = text.lastIndexOf('\x1b');
    p.carry = last >= 0 && /^\x1b(?:\[\??[\d;]*)?$/.test(text.slice(last)) ? text.slice(last) : '';
  }

  // Codex 0.159 first paints a placeholder composer and accepts keys only after its
  // startup bootstrap (an online model-list refresh: 3-5 s on a fresh CODEX_HOME).
  // A Ctrl+G in that window is dropped, not queued (2026-10-12, writing-tab first
  // prompt failed 4 of 4). Until Codex takes the request -- the helper claims it or
  // the TUI suspends for the editor -- press again.
  async load(text, write, { timeoutMs = 8000, startupMs = 20000, repressMs = 2000, attachments = [], preservePunctuation = false } = {}) {
    text = String(text || '');
    if ((!preservePunctuation && text.length < MIN_LENGTH) || /^\s*\//.test(text) || attachments.length) return false;
    if (this.closed || this.failed) throw inputError('长文本输入通道未就绪，请重开此会话后重试；正文未提交');
    if (this.pending) throw inputError('此会话正在接收另一条长文本，请稍后重试');
    const id = crypto.randomUUID(), digest = hash(text), start = Date.now();
    const request = path.join(this.directory, 'request.json');
    const receipt = path.join(this.directory, 'receipt.json');
    const p = { id, carry: '', suspended: false, resumed: false, frame: false };
    this.pending = p;
    try {
      // Only an untouched handoff leaves the channel usable; its cancel marker must not block this one.
      try { fs.unlinkSync(path.join(this.directory, 'cancelled.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      atomicJson(request, { id, text, digest, expiresAt: start + startupMs + timeoutMs });
      write('\x07');
      let pressedAt = Date.now(), presses = 1, engagedAt = 0;
      for (;;) {
        if (this.closed) throw inputError('会话已关闭，长文本未提交');
        const now = Date.now();
        if (!engagedAt && (p.suspended || !fs.existsSync(request))) engagedAt = now;
        if (now >= (engagedAt ? engagedAt + timeoutMs : start + startupMs)) break;
        const ack = readJson(receipt);
        if (ack?.id === id) {
          if (!ack.ok || ack.digest !== digest) throw inputError(ack.message || '长文本回填校验失败，正文未提交');
          if (p.frame) {
            this.lastTransfer = { id, chars: text.length, milliseconds: Date.now() - start, digest, presses };
            return true;
          }
        }
        if (!engagedAt && now - pressedAt >= repressMs) { write('\x07'); pressedAt = now; presses += 1; }
        await sleep(10);
      }
      if (!engagedAt) {
        throw Object.assign(inputError(`Codex 在 ${Math.round(startupMs / 1000)} 秒内没有响应长文本输入（按了 ${presses} 次 Ctrl+G），正文未提交；稍后重试即可`), { untouched: true });
      }
      console.warn('[codex-editor-input] handoff timeout after Codex took the request', JSON.stringify({
        ms: Date.now() - start, presses, claimed: !fs.existsSync(request), suspended: p.suspended, resumed: p.resumed, frame: p.frame,
      }));
      throw inputError('未确认 Codex 已接收长文本并恢复输入，未发回车；请重开此会话后重试');
    } catch (error) {
      // Codex never took the request, so nothing reached it and a later message may use the channel.
      // Once it did, the native draft state is unknown: keep the channel closed until the session reopens.
      if (!error.untouched) this.failed = true;
      // A late helper must never consume this cancelled request.
      this.cancel(id);
      throw Object.assign(error, { notSent: true });
    } finally {
      this.pending = null;
      for (const file of [request, receipt, path.join(this.directory, 'active.json')].flatMap(file => [file, file + '.tmp'])) {
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') console.warn('[codex-editor-input] cleanup failed:', error.message); }
      }
      if (this.closed) this.removeFiles();
    }
  }

  dispose() {
    this.closed = true;
    if (this.pending) this.cancel(this.pending.id);
    // No recursive removal: the owned directory contains no links or user data.
    if (!this.pending) this.removeFiles();
  }
  cancel(id) {
    try { atomicJson(path.join(this.directory, 'cancelled.json'), { id }); }
    catch (error) { console.warn('[codex-editor-input] cancellation receipt failed:', error.message); }
  }
  removeFiles() {
    for (const name of ['editor.cmd', 'session.json', 'cancelled.json', 'request.json', 'active.json', 'receipt.json'].flatMap(name => [name, name + '.tmp'])) {
      try { fs.unlinkSync(path.join(this.directory, name)); }
      catch (error) { if (error.code !== 'ENOENT') console.warn('[codex-editor-input] cleanup failed:', error.message); }
    }
    try { fs.rmdirSync(this.directory); }
    catch (error) { if (error.code !== 'ENOENT') console.warn('[codex-editor-input] directory cleanup failed:', error.message); }
  }
}

function configureCodexEditorInput(env, { dataDir, cwd, platform = process.platform, executable = process.execPath } = {}) {
  if (platform !== 'win32' || env.HUB_CODEX_EDITOR_INPUT === '0') return null;
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (hasCustomKeymap(home, cwd)) {
    console.info('[codex-editor-input] custom keymap: retaining PTY paste');
    return null;
  }
  const root = path.join(dataDir, 'codex-editor-input');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'session-'));
  atomicJson(path.join(directory, 'session.json'), {
    visual: env.VISUAL, editor: env.EDITOR, runAsNode: env.ELECTRON_RUN_AS_NODE,
  });
  // ASCII launcher; Unicode paths travel in the environment and native argv.
  fs.writeFileSync(path.join(directory, 'editor.cmd'), '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%HUB_CODEX_EDITOR_NODE%" "%HUB_CODEX_EDITOR_SCRIPT%" "%HUB_CODEX_EDITOR_DIR%" "%~1"\r\nexit /b %errorlevel%\r\n');
  Object.assign(env, {
    VISUAL: '"' + path.join(directory, 'editor.cmd') + '"',
    HUB_CODEX_EDITOR_NODE: executable,
    HUB_CODEX_EDITOR_SCRIPT: path.join(__dirname, 'codex-editor-helper.js'),
    HUB_CODEX_EDITOR_DIR: directory,
  });
  return new CodexEditorInput(directory);
}

module.exports = { CodexEditorInput, configureCodexEditorInput, hasCustomKeymap, atomicJson, readJson, hash, MIN_LENGTH };
