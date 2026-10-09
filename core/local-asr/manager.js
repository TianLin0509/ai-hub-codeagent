'use strict';
// 本地语音识别的生命周期：运行环境常驻（不占显存），说话时才把模型装进显卡，
// 最后一次使用后空闲 10 分钟结束整个 worker 进程释放显存，并立即换一个只含环境的新 worker。
// 模型未就绪时调用方应改用 Token Plan 接力，本模块只回答「现在能不能本地识别」。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const DEFAULTS = {
  python: 'C:/AppData/venvs/hub-local-asr/Scripts/python.exe',
  model: 'C:/AppData/models/asr/Qwen3-ASR-1.7B',
  speakerModel: 'C:/AppData/models/speaker/3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx',
};
const IDLE_MS = 10 * 60 * 1000;

function localPaths(cfg = {}, env = process.env) {
  const local = cfg.local || {};
  return {
    python: env.HUB_LOCAL_ASR_PYTHON || local.python || DEFAULTS.python,
    model: env.HUB_LOCAL_ASR_MODEL || local.model || DEFAULTS.model,
    speakerModel: env.HUB_LOCAL_SPEAKER_MODEL || local.speakerModel || DEFAULTS.speakerModel,
  };
}
function localInstalled(paths) {
  return fs.existsSync(paths.python) && fs.existsSync(path.join(paths.model, 'config.json'));
}

// state: off → starting → env → loading → ready；失败回到 env（加载失败）或 off（进程退出）。
class LocalAsr extends EventEmitter {
  // mode='speaker'：只做声纹的轻量 worker（CPU、约 170MB 内存），与识别 worker 并行。
  constructor({ paths, mode = 'asr', idleMs = IDLE_MS, spawnImpl = spawn, requestTimeoutMs = 60000, log = (...a) => console.log('[local-asr]', ...a) }) {
    super();
    Object.assign(this, { paths, mode, idleMs, spawnImpl, requestTimeoutMs, log });
    this.state = 'off'; this.proc = null; this.pending = new Map(); this.seq = 0;
    this.loading = null; this.idleTimer = null; this.crashes = []; this.stopped = false;
  }
  get ready() { return this.state === 'ready'; }
  setState(state) { if (this.state !== state) { this.state = state; this.emit('state', state); } }

  // 启动只含运行环境的 worker（约 7～8 秒、0.9GB 内存、不占显存）。
  start() {
    if (this.proc || this.stopped) return;
    const recent = this.crashes.filter(t => Date.now() - t < 5 * 60 * 1000);
    if (recent.length >= 3) { this.setState('failed'); return; }
    const worker = path.join(__dirname, 'worker.py');
    const proc = this.spawnImpl(this.paths.python, ['-u', worker], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', HUB_LOCAL_ASR_MODEL: this.paths.model,
        HUB_LOCAL_SPEAKER_MODEL: this.paths.speakerModel, HUB_LOCAL_ASR_LANGUAGE: 'Chinese', HUB_LOCAL_WORKER: this.mode },
    });
    this.proc = proc; this.setState('starting');
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buf += chunk;
      for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) this.onLine(proc, line); }
    });
    let errTail = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', chunk => { errTail = (errTail + chunk).slice(-2000); });
    proc.on('error', error => this.onExit(proc, `无法启动：${error.message}`));
    proc.on('exit', code => this.onExit(proc, `退出码 ${code}：${errTail.split('\n').filter(Boolean).slice(-2).join(' | ')}`));
  }
  onLine(proc, line) {
    if (proc !== this.proc) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === 'env-ready') { this.setState('env'); this.log(`运行环境就绪 ${msg.ms}ms`); this.emit('env-ready'); return; }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id); clearTimeout(waiter.timer);
    if (msg.error) waiter.reject(new Error(msg.error)); else waiter.resolve(msg);
  }
  onExit(proc, reason) {
    if (proc !== this.proc) return;
    this.proc = null; this.loading = null; clearTimeout(this.idleTimer);
    for (const [, w] of this.pending) { clearTimeout(w.timer); w.reject(new Error('本地识别进程已结束')); }
    this.pending.clear();
    const planned = proc.plannedExit;
    this.setState('off');
    if (planned || this.stopped) return;
    this.crashes.push(Date.now());
    this.log(`worker 意外退出（${reason}），稍后重启运行环境`);
    setTimeout(() => this.start(), 5000).unref?.();
  }
  call(op, payload = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.proc) return Promise.reject(new Error('本地识别未启动'));
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`本地识别 ${op} 超时`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ op, id, ...payload }) + '\n');
    });
  }
  // 说话开始时调用：确保环境在、把模型装进显卡。返回就绪的 Promise；失败不抛给调用方以外的地方。
  prepare() {
    this.touch();
    if (this.state === 'ready') return Promise.resolve(true);
    if (this.loading) return this.loading;
    if (!this.proc) this.start();
    if (!this.proc) return Promise.reject(new Error('本地识别不可用'));
    const proc = this.proc;
    this.loading = (async () => {
      if (this.state === 'starting') await new Promise((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onState = s => { if (s === 'off' || s === 'failed') { cleanup(); reject(new Error('本地识别进程未能启动')); } };
        const cleanup = () => { this.off('env-ready', onReady); this.off('state', onState); };
        this.on('env-ready', onReady); this.on('state', onState);
      });
      if (proc !== this.proc) throw new Error('本地识别进程已更换');
      this.setState('loading');
      const t = Date.now();
      try { await this.call('load', {}, 120000); }
      catch (error) {
        if (proc === this.proc) { this.setState('env'); this.recycle(); } // 查显存本身也会占约 200MB：换个干净的环境进程
        throw error;
      }
      if (proc !== this.proc) throw new Error('本地识别进程已更换');
      this.setState('ready'); this.touch();
      this.log(`模型已装入显卡 ${Date.now() - t}ms`);
      return true;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }
  // timeoutMs：本地正常每 8 秒语音不到 1 秒；超时多半是显卡被别的程序挤占，此时卸掉模型把显存还回去，调用方改走 Token Plan。
  async transcribe(pcms, context = '', timeoutMs = this.requestTimeoutMs) {
    if (!this.ready) throw new Error('本地模型未就绪');
    this.touch();
    let r;
    try { r = await this.call('transcribe', { pcm: pcms.map(p => Buffer.from(p).toString('base64')), context }, timeoutMs); }
    catch (error) { if (/超时/.test(error.message)) { this.log('本地识别过慢（显卡可能被占用），释放模型'); this.release(); } throw error; }
    this.touch();
    if (!Array.isArray(r.texts) || r.texts.length !== pcms.length) throw new Error('本地识别返回数量不符');
    return r.texts.map(t => String(t || '').trim());
  }
  // 声纹向量（每段一个单位向量）；maxSeconds 只取每段开头，够判断是谁又省时间。
  async embed(pcms, maxSeconds = 6) {
    if (!this.proc) this.start();
    if (this.state === 'starting') await new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onState = s => { if (s === 'off' || s === 'failed') { cleanup(); reject(new Error('声纹进程未能启动')); } };
      const cleanup = () => { this.off('env-ready', onReady); this.off('state', onState); };
      this.on('env-ready', onReady); this.on('state', onState);
    });
    const r = await this.call('embed', { pcm: pcms.map(p => Buffer.from(p).toString('base64')), max_seconds: maxSeconds });
    if (!Array.isArray(r.vectors) || r.vectors.length !== pcms.length) throw new Error('声纹返回数量不符');
    return r.vectors;
  }
  touch() {
    clearTimeout(this.idleTimer);
    if (this.state !== 'ready' && !this.loading) return;
    this.idleTimer = setTimeout(() => this.release(), this.idleMs);
    this.idleTimer.unref?.();
  }
  // 结束 worker 释放显存，立即换一个只含环境的新 worker。
  release() {
    clearTimeout(this.idleTimer);
    if (!this.proc || this.state === 'env' || this.state === 'starting') return;
    if (this.pending.size) { this.touch(); return; } // 正在识别时不释放，识别完再重新计时
    if (this.keepWarm?.()) { this.touch(); return; } // 设置了「工作时段常驻显卡」且在时段内
    this.log('空闲到时，释放显存');
    this.recycle();
  }
  // 结束当前 worker 并立即换一个只含环境的新 worker（不占显存）。
  recycle() {
    const proc = this.proc; if (!proc) return;
    proc.plannedExit = true; this.onExit(proc, 'recycle'); proc.kill(); this.start();
  }
  stop() {
    this.stopped = true; clearTimeout(this.idleTimer);
    const proc = this.proc; if (!proc) return;
    proc.plannedExit = true; this.onExit(proc, 'stop'); proc.kill();
  }
  status() { return { state: this.state, installed: localInstalled(this.paths) }; }
}

let shared = null;
// 主进程共享一个实例；未安装（环境或模型缺失）时返回 null。
function getLocalAsr(cfg) {
  if (shared) return shared;
  const paths = localPaths(cfg);
  if (!localInstalled(paths)) return null;
  shared = new LocalAsr({ paths, idleMs: Number(process.env.HUB_LOCAL_ASR_IDLE_MS) || IDLE_MS });
  return shared;
}
let sharedSpeaker = null;
// 声纹 worker：模型文件在才创建；常驻（轻量），随 Hub 退出。
function getSpeakerWorker(cfg) {
  if (sharedSpeaker) return sharedSpeaker;
  const paths = localPaths(cfg);
  if (!fs.existsSync(paths.python) || !fs.existsSync(paths.speakerModel)) return null;
  sharedSpeaker = new LocalAsr({ paths, mode: 'speaker', log: (...a) => console.log('[voiceprint]', ...a) });
  return sharedSpeaker;
}
function resetLocalAsrForTests() { shared?.stop(); shared = null; sharedSpeaker?.stop(); sharedSpeaker = null; }

module.exports = { LocalAsr, getLocalAsr, getSpeakerWorker, localPaths, localInstalled, resetLocalAsrForTests, DEFAULTS, IDLE_MS };
