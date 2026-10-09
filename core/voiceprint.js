'use strict';
// 声纹过滤：录入一次本人声纹（数据目录 voiceprint.json，只存一个数字向量，不存录音），
// 之后每段录音按 0.3 秒短停顿切成小句逐句比对，明显不是本人的小句在音频里静音后再识别（旁人插话也能去掉，
// 本人整句的上下文不被打断）。宁可放进一句别人的话，也不吞掉本人的话：
// - 短于 1.5 秒的小句不判断（太短判不准），照常保留；
// - 这条录音里还没出现像本人的小句之前不静音（多半是换了麦克风或环境，而不是全程别人在说）；
//   之后一旦确认有本人，先前「全是他人」的段落再从文字里拿掉。
// 门槛 0.40 来自 2026-10-05 合成语音实验（ERes2Net：旁人较响时本人保留 96%、他人拦下 78%），待真人录音再调。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_THRESHOLD = 0.40;
const MIN_ENROLL_SPEECH_SECONDS = 10;
const MIN_JUDGE_SECONDS = 1.5;
const MODEL = 'eres2net_large_sv_zh-cn';

const file = dataDir => path.join(dataDir, 'voiceprint.json');
function load(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(file(dataDir), 'utf8'));
    return Array.isArray(v.vector) && v.vector.length ? v : null;
  } catch { return null; }
}
function write(dataDir, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file(dataDir) + '.tmp', JSON.stringify(value), 'utf8');
  fs.renameSync(file(dataDir) + '.tmp', file(dataDir));
}
// 启用中的声纹（未录入或已关闭时为 null）。
function active(dataDir) { const v = load(dataDir); return v && v.enabled !== false ? v : null; }
function status(dataDir) {
  const v = load(dataDir);
  return v ? { enrolled: true, enabled: v.enabled !== false, threshold: v.threshold ?? DEFAULT_THRESHOLD, enrolledAt: v.enrolledAt, seconds: v.seconds, adapted: v.adapted || 0 }
    : { enrolled: false, enabled: false, threshold: DEFAULT_THRESHOLD };
}
function setOptions(dataDir, { enabled, threshold } = {}) {
  const v = load(dataDir);
  if (!v) throw new Error('还没有录入声纹');
  if (enabled !== undefined) v.enabled = !!enabled;
  if (threshold !== undefined) {
    const t = Number(threshold);
    if (!(t >= 0.1 && t <= 0.8)) throw new Error('声纹门槛需在 0.1～0.8 之间');
    v.threshold = t;
  }
  write(dataDir, v); return status(dataDir);
}
function remove(dataDir) { fs.rmSync(file(dataDir), { force: true }); return status(dataDir); }

function speechSeconds(pcm16k, frameLevels) {
  return frameLevels(pcm16k).filter(level => level > 200).length / 50; // 字与字之间较轻的帧也算说话
}
// 录入：至少 10 秒有声内容；用整段算一个声纹向量。
async function enroll(dataDir, pcm16k, { speaker, frameLevels }) {
  const seconds = speechSeconds(pcm16k, frameLevels);
  if (seconds < MIN_ENROLL_SPEECH_SECONDS) throw new Error(`有效说话只有 ${seconds.toFixed(0)} 秒，请连续朗读至少 ${MIN_ENROLL_SPEECH_SECONDS} 秒`);
  const [vector] = await speaker.embed([pcm16k], 0);
  const old = load(dataDir);
  write(dataDir, { vector, enrolledVector: vector, adapted: 0, model: MODEL, seconds: Math.round(seconds), enrolledAt: new Date().toISOString(),
    enabled: true, threshold: old?.threshold ?? DEFAULT_THRESHOLD });
  return status(dataDir);
}

// 声纹自动更新：用日常里很确定是本人的小句（分数 ≥0.6）每次微调 5%，适应换麦克风、嗓子状态变化。
// 防漂移：与当初录入的声纹相似度低于 0.6 的不采用；每天最多更新 30 次。
const ADAPT_MIN_SCORE = 0.6, ADAPT_RATE = 0.05, ADAPT_DAILY = 30;
function adapt(dataDir, vectors = []) {
  const v = load(dataDir);
  if (!v || v.enabled === false || !vectors.length) return 0;
  const origin = v.enrolledVector || v.vector;
  const today = new Date().toISOString().slice(0, 10);
  let count = v.adaptDay === today ? v.adaptToday || 0 : 0, used = 0;
  let cur = v.vector.slice();
  for (const x of vectors) {
    if (count >= ADAPT_DAILY) break;
    if (cosine(x, origin) < ADAPT_MIN_SCORE) continue;
    cur = cur.map((c, i) => c * (1 - ADAPT_RATE) + x[i] * ADAPT_RATE);
    const n = Math.hypot(...cur) || 1; cur = cur.map(c => c / n);
    count++; used++;
  }
  if (!used) return 0;
  write(dataDir, { ...v, vector: cur, enrolledVector: origin, adaptDay: today, adaptToday: count, adapted: (v.adapted || 0) + used });
  return used;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
}

const FRAME_BYTES = 640; // 20ms @16kHz
// 段内小句：按至少 0.3 秒的安静切开，返回字节区间 [start, end)。「安静」相对本段响度判断。
function utterances(pcm16k, frameLevels) {
  const levels = frameLevels(pcm16k);
  const voiced = levels.filter(v => v > 120).sort((a, b) => a - b);
  const quiet = Math.max(120, (voiced.length ? voiced[Math.floor(voiced.length * 0.9)] : 0) * 0.12);
  const out = []; let start = -1, run = 0;
  levels.forEach((level, f) => {
    if (level >= quiet) { if (start < 0) start = f; run = 0; return; }
    if (start >= 0 && ++run >= 15) { out.push([start * FRAME_BYTES, (f - run + 1) * FRAME_BYTES]); start = -1; run = 0; }
  });
  if (start >= 0) out.push([start * FRAME_BYTES, levels.length * FRAME_BYTES]);
  return out;
}

// 一段录音的声纹筛查：state.seenMe 跨段记住「这条录音已确认有本人」。
// 返回 { pcm（他人小句已静音）, me, removed（静音的小句数）, otherOnly（全是他人但因尚未确认本人而保留）, scores }。
async function screen(pcm16k, { vp, state, frameLevels }) {
  const threshold = vp.profile.threshold ?? DEFAULT_THRESHOLD;
  const judged = utterances(pcm16k, frameLevels).filter(([a, b]) => (b - a) / 32000 >= MIN_JUDGE_SECONDS);
  if (!judged.length) return { pcm: pcm16k, me: 0, removed: 0, otherOnly: false, scores: [] };
  const vectors = await vp.speaker.embed(judged.map(([a, b]) => pcm16k.subarray(a, b)));
  const scores = vectors.map(v => Math.round(cosine(v, vp.profile.vector) * 1000) / 1000);
  const me = scores.filter(s => s >= threshold).length, others = judged.filter((_, i) => scores[i] < threshold);
  const confident = vectors.filter((_, i) => scores[i] >= ADAPT_MIN_SCORE); // 很确定是本人的小句，用于声纹自动更新
  if (me) state.seenMe = true;
  if (!others.length) return { pcm: pcm16k, me, removed: 0, otherOnly: false, scores, confident };
  if (!state.seenMe) return { pcm: pcm16k, me, removed: 0, otherOnly: me === 0, scores, confident };
  const masked = Buffer.from(pcm16k);
  for (const [a, b] of others) masked.fill(0, a, b);
  return { pcm: masked, me, removed: others.length, otherOnly: false, scores, confident };
}

module.exports = { DEFAULT_THRESHOLD, MIN_ENROLL_SPEECH_SECONDS, MIN_JUDGE_SECONDS, load, active, status, setOptions, remove, enroll, cosine, utterances, screen, adapt };
