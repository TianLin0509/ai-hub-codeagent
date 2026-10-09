'use strict';
// 说完再识别：走百炼 Token Plan 套餐里的 qwen-audio-3.0-asr-flash（按录音秒数扣套餐额度，
// 不另计费）。边说边出字的流式模型不在套餐内（core/voice-input.js，按量计费）。
// 录音在停顿处切成小段并发识别：电脑端说话时逐段出字、说完只等最后一段；
// 手机整段上传时几段同时识别，2 分钟录音不必等一整段的服务端耗时。
const fs = require('node:fs');
const path = require('node:path');

const MODEL = 'qwen-audio-3.0-asr-flash';
const PLAN_BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
const RATE = 16000;
const FRAME = RATE / 50; // 20ms
const MIN_SEGMENT_SECONDS = 8;
const MAX_SEGMENT_SECONDS = 30;
const PAUSE_MS = 500;
const CONCURRENCY = 6;

// 套餐 Key 与快速通道共用 Hub config.json 的 acp 配置；不是套餐端点就视为没有。
function tokenPlanKey(dataDir) {
  try {
    const acp = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8').replace(/^﻿/, '')).acp || {};
    const base = String(acp.baseURL || PLAN_BASE + '/compatible-mode/v1').replace(/\/compatible-mode\/v1\/?$/, '');
    return acp.apiKey && base === PLAN_BASE ? String(acp.apiKey) : '';
  } catch { return ''; }
}


// 16 位单声道 PCM 任意采样率 → 16kHz（区间平均，顺带抑制混叠）。
function toRate16k(pcm, sampleRate) {
  const src = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  if (sampleRate === RATE) return Buffer.from(src.buffer, src.byteOffset, src.byteLength);
  const ratio = sampleRate / RATE, n = Math.floor(src.length / ratio), out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = a; j < b && j < src.length; j++) sum += src[j];
    out.writeInt16LE(Math.round(sum / (b - a)), i * 2);
  }
  return out;
}

function wav(pcm16k) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm16k.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcm16k.length, 40);
  return Buffer.concat([h, pcm16k]);
}

const FRAME_BYTES = FRAME * 2;
// 每 20ms 一帧的音量（RMS），from 起按整帧计算。
function frameLevels(pcm16k, from = 0) {
  const levels = [];
  for (let at = from; at + FRAME_BYTES <= pcm16k.length; at += FRAME_BYTES) {
    let sum = 0; for (let i = 0; i < FRAME; i++) { const v = pcm16k.readInt16LE(at + i * 2); sum += v * v; }
    levels.push(Math.sqrt(sum / FRAME));
  }
  return levels;
}

// 找下一个切点（帧序号）：至少 8 秒后第一个持续 0.5 秒的停顿中点；
// 满 30 秒仍无停顿时切在最后 5 秒里最安静的一帧。不够一段时返回 0。
// 「安静」相对本段响度判断（响亮帧第 90 百分位的 12%），适应不同麦克风增益。
function cutFrame(levels) {
  const minF = MIN_SEGMENT_SECONDS * 50, maxF = MAX_SEGMENT_SECONDS * 50, pauseF = PAUSE_MS / 20;
  if (levels.length <= minF) return 0;
  const voiced = levels.slice(0, maxF).filter(v => v > 120).sort((a, b) => a - b);
  const quiet = Math.max(120, (voiced.length ? voiced[Math.floor(voiced.length * 0.9)] : 0) * 0.12);
  let run = 0;
  for (let f = minF; f < Math.min(levels.length, maxF); f++) {
    run = levels[f] < quiet ? run + 1 : 0;
    if (run >= pauseF) return f - Math.floor(run / 2);
  }
  if (levels.length < maxF) return 0;
  let best = maxF - 1;
  for (let f = maxF - 250; f < maxF; f++) if (levels[f] < levels[best]) best = f;
  return best;
}

// 断句用的帧「音量」：说话检测（TEN VAD）可用时用它（强噪声下也断得开），否则按音量。
function pauseLevels(pcm16k) {
  const vad = require('./voice-vad');
  return vad.available() ? vad.vadLevels(pcm16k) : frameLevels(pcm16k);
}

// 服务端对纯静音段直接回 HTTP 400（实测），且静音也按秒扣额度：至少 0.2 秒有声才送识别。
// 说话检测或音量任一认为有声就送：检测器偶尔漏掉轻声时不至于丢字。
function hasSpeech(pcm16k) {
  const loudEnough = levels => { let n = 0; for (const level of levels) if (level > 400 && ++n >= 10) return true; return false; };
  if (loudEnough(frameLevels(pcm16k))) return true;
  const vad = require('./voice-vad');
  return vad.available() && loudEnough(vad.vadLevels(pcm16k));
}

function splitAtPauses(pcm16k) {
  const parts = [];
  let levels = pauseLevels(pcm16k), start = 0;
  for (let f; (f = cutFrame(levels)) > 0;) {
    parts.push(pcm16k.subarray(start, start + f * FRAME_BYTES)); start += f * FRAME_BYTES; levels = levels.slice(f);
  }
  if (start < pcm16k.length) parts.push(pcm16k.subarray(start));
  return parts;
}

function termsOf(profile = {}) {
  return [...new Set(String(profile.terms || '').split(/[,，;；\n]/).map(t => t.trim()).filter(Boolean))].slice(0, 80);
}

async function recognize(pcm16k, { apiKey, profile, fetchImpl = fetch, signal, timeoutMs = 60000 }) {
  const terms = termsOf(profile), context = String(profile?.context || '').trim();
  const body = { model: MODEL,
    input: { messages: [
      ...(context ? [{ role: 'system', content: [{ type: 'text', text: context }] }] : []),
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + wav(pcm16k).toString('base64') } }] }] },
    parameters: { format: 'wav', sample_rate: RATE, ...(terms.length ? { vocabulary: Object.fromEntries(terms.map(t => [t, 3])) } : {}) } };
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(PLAN_BASE + '/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body) });
  } catch (error) {
    if (signal?.aborted) throw new Error('已取消录音');
    throw new Error(timeout.aborted ? '套餐语音识别超时，请重试' : '套餐语音识别连接失败，请检查网络');
  }
  let json = {};
  try { json = await res.json(); } catch {}
  // 不回显服务端原文（可能含凭据或输入内容）。
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? '套餐 Key 无效或无权使用语音识别' : `套餐语音识别失败（HTTP ${res.status}）`);
  const out = json.output || {};
  const text = out.text ?? out.sentence?.text ?? out.output?.sentence?.text;
  if (typeof text !== 'string') throw new Error('套餐语音识别返回缺少文字');
  return text.trim();
}

// 按顺序拼接、并发识别若干段。
async function recognizeParts(parts, options) {
  parts = parts.filter(hasSpeech);
  const texts = new Array(parts.length);
  let next = 0;
  const worker = async () => { while (next < parts.length) { const i = next++; texts[i] = await recognize(parts[i], options); } };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parts.length) }, worker));
  return joinTexts(texts);
}

// 中文段落直接相连；两段边界都是拉丁字符时补一个空格。
function joinTexts(texts) {
  return texts.filter(Boolean).reduce((all, t) => all && /[A-Za-z0-9]$/.test(all) && /^[A-Za-z0-9]/.test(t) ? all + ' ' + t : all + t, '');
}

async function transcribePcm(pcm16k, options) {
  return recognizeParts(splitAtPauses(pcm16k), options);
}

// 有声的段落（手机整段录音走本地批量识别时用）。
function speechSegments(pcm16k) { return splitAtPauses(pcm16k).filter(hasSpeech); }

// 电脑端录音：与 VoiceStream 同一接口（ready / audio / finish / cancel / onEvent），
// 边录边在停顿处切段送识别，partial 事件按段推进。
// recognizeSegment(pcm16k, signal) → { text, via }：每段走哪条路由调用方决定（本地 / Token Plan），
// 不传时全部走 Token Plan。事件里的 via 记录各路段数，界面据此说明这次是谁识别的。
class RecordedVoice {
  // 声纹过滤由 recognizeSegment 完成（他人小句静音）；它返回的 me/otherOnly/removed 用于事后拿掉「确认本人前、全是他人」的段落。
  constructor({ apiKey, sampleRate, profile, onEvent, fetchImpl, maxSeconds = 300, recognizeSegment }) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('麦克风采样率不受支持');
    if (!apiKey && !recognizeSegment) throw new Error('请先在 Hub 配置百炼 Token Plan 套餐 Key');
    Object.assign(this, { apiKey, rate: sampleRate, profile, onEvent, fetchImpl, maxSeconds });
    this.recognizeSegment = recognizeSegment || (async (pcm, signal) => ({
      text: await recognize(pcm, { apiKey, profile, fetchImpl, signal }), via: 'tokenplan' }));
    this.via = {};
    this.state = 'recording'; this.pending = Buffer.alloc(0); this.carry = Buffer.alloc(0); this.levels = [];
    const vad = require('./voice-vad'); this.vadStream = vad.available() ? new vad.VadStream() : null; // 有说话检测时用它断句
    this.seconds = 0; this.parts = []; this.controller = new AbortController();
    this.ready = Promise.resolve();
  }
  get ended() { return ['done', 'error', 'cancelled'].includes(this.state); }
  kept() { const anyMe = this.parts.some(p => p.me > 0); return this.parts.map(p => !(anyMe && p.otherOnly)); }
  text() { const keep = this.kept(); return joinTexts(this.parts.map((p, i) => keep[i] ? p.text : '')); }
  dispatch(pcm16k) {
    if (!hasSpeech(pcm16k)) return;
    const part = { text: '' };
    part.done = this.recognizeSegment(pcm16k, this.controller.signal)
      .then(({ text, via, me = null, removed = 0, otherOnly = false }) => {
        Object.assign(part, { text, me, removed, otherOnly }); if (via) this.via[via] = (this.via[via] || 0) + 1;
        if (!this.ended) this.onEvent({ type: 'partial', text: this.text(), via: { ...this.via } });
      })
      .catch(error => this.fail(error.message));
    this.parts.push(part);
  }
  async audio(data) {
    if (this.state !== 'recording') throw new Error('录音已经结束');
    const bytes = Buffer.concat([this.carry, Buffer.from(data)]);
    const whole = bytes.length - (bytes.length % 2 ? 1 : 0);
    if (!whole || bytes.length > 65536) { this.fail('录音数据格式异常'); throw new Error('录音数据格式异常'); }
    // 降采样按整块做，残留的半个采样留到下一块。
    const usable = whole - (whole % (2 * Math.max(1, Math.round(this.rate / RATE))));
    this.carry = bytes.subarray(usable);
    this.seconds += usable / 2 / this.rate;
    if (this.seconds > this.maxSeconds) { this.fail('录音过长，请分段重试'); throw new Error('录音过长'); }
    const chunk16k = toRate16k(bytes.subarray(0, usable), this.rate);
    this.pending = Buffer.concat([this.pending, chunk16k]);
    if (this.vadStream) this.levels.push(...this.vadStream.push(chunk16k));
    else this.levels.push(...frameLevels(this.pending, this.levels.length * FRAME_BYTES));
    for (let f; (f = cutFrame(this.levels)) > 0;) {
      this.dispatch(this.pending.subarray(0, f * FRAME_BYTES));
      this.pending = Buffer.from(this.pending.subarray(f * FRAME_BYTES)); this.levels = this.levels.slice(f);
    }
  }
  async finish() {
    if (this.state !== 'recording') throw new Error('当前录音无法停止，请取消后重试');
    this.state = 'finishing';
    this.dispatch(this.pending);
    this.pending = Buffer.alloc(0); this.vadStream?.destroy();
    void Promise.all(this.parts.map(p => p.done)).then(() => {
      if (this.ended) return;
      const filtered = this.kept().filter(k => !k).length + this.parts.reduce((n, p) => n + (p.removed || 0), 0);
      this.state = 'done'; this.onEvent({ type: 'done', text: this.text(), via: { ...this.via, ...(filtered ? { filtered } : {}) } });
    });
    return true;
  }
  fail(message) {
    if (this.ended) return;
    this.state = 'error'; this.controller.abort(); this.vadStream?.destroy();
    this.onEvent({ type: 'error', message, text: this.text() });
  }
  cancel() {
    if (this.ended) return;
    this.state = 'cancelled'; this.controller.abort(); this.vadStream?.destroy();
  }
}

module.exports = { MODEL, PLAN_BASE, tokenPlanKey, toRate16k, wav, frameLevels, pauseLevels, cutFrame, hasSpeech, splitAtPauses, speechSegments, recognize, recognizeParts, transcribePcm, joinTexts, RecordedVoice };
