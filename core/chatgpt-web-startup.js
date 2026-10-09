'use strict';
const fs = require('fs');
const path = require('path');
const { isolatedPaths } = require('./chatgpt-isolation');
const web = require('./chatgpt-web-integration');
const { randomUUID } = require('crypto');

function acquireStartupClaim(env) {
  const file = path.join(isolatedPaths(env).runtime, 'ai-hub-startup.json');
  const contents = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
      return () => {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === contents) fs.unlinkSync(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let saved, owner;
      try { saved = fs.readFileSync(file, 'utf8'); owner = JSON.parse(saved); }
      catch (readError) { if (readError.code === 'ENOENT') continue; return null; }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null;
      try { process.kill(owner.pid, 0); return null; }
      catch (probeError) { if (probeError.code !== 'ESRCH') return null; }
      // Remove only an unchanged claim whose process has already exited.
      if (fs.readFileSync(file, 'utf8') === saved) fs.unlinkSync(file);
    }
  }
  return null;
}

function launcherRunning(env) {
  const file = path.join(isolatedPaths(env).runtime, 'runtime', 'launcher-browser.json');
  let descriptor;
  try { descriptor = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw new Error('ChatGPT 启动状态无法读取，请打开专用工具检查'); }
  if (!Number.isInteger(descriptor.pid) || descriptor.pid <= 0) throw new Error('ChatGPT 启动状态无效');
  try { process.kill(descriptor.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// Only called for explicit ChatGPT creation/submission, never on Hub startup or
// for dormant history. A running launcher/bridge is never restarted or stopped.
function createWebStartup({ status = web.webStatus, launch = web.openWebSettings,
  running = launcherRunning, timeoutMs = 60000, pollMs = 500,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const pending = new Map();
  return function ensureWebReady(model, env = process.env) {
    web.requireWebTools(model, env);
    const root = isolatedPaths(env).root;
    if (pending.has(root)) return pending.get(root);
    const task = (async () => {
      const deadline = now() + timeoutMs;
      let current = await status(env);
      if (!current.ok) throw new Error(current.message);
      if (current.online) return current;
      // --hidden second-instance in upstream can focus an existing window:
      // wait for an existing owner instead of spawning it again.
      let release;
      try {
        if (!current.connected && !running(env)) {
          release = acquireStartupClaim(env);
          if (release) await launch({ background: true, env });
        }
        while (now() < deadline) {
          await sleep(pollMs);
          current = await status(env);
          if (!current.ok) throw new Error(current.message);
          if (current.online) { web.requireWebTools(model, env); return current; }
        }
        throw new Error('ChatGPT 专用服务在 60 秒内未就绪，消息尚未发送。请打开“Codex Web GPT 设置”检查登录或启动错误后重试');
      } finally {
        if (release) release();
      }
    })().finally(() => pending.delete(root));
    pending.set(root, task);
    return task;
  };
}
module.exports = { ensureWebReady: createWebStartup(), createWebStartup, launcherRunning };
