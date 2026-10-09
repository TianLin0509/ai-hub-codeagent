'use strict';
// 资料口播 · 合成声音：默认微软 edge-tts「曉臻」（免费，台湾腔温柔女声，2026-10-06 用户按推荐选定）；
// 失败时退回千问 qwen-audio-3.1-tts-flash「龙安风悦」（百炼按量 Key，免费额度已开用完自动停止）。
// 最后统一压成 24kbps 单声道 Opus（语音足够清楚，8 分钟约 1.4MB），手机经云中继按需下载。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const EDGE_VOICE = 'zh-TW-HsiaoChenNeural', QWEN_VOICE = 'longanfengyue_v3.1', QWEN_MODEL = 'qwen-audio-3.1-tts-flash';
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => execFile(bin, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout || 10 * 60000, ...opts },
    (e, stdout, stderr) => e ? reject(new Error((stderr || e.message).toString().slice(-300))) : resolve(stdout.toString())));
}
// 工具位置：环境变量优先；否则用本机常见安装位置。
function tools(env = process.env) {
  const exists = f => f && fs.existsSync(f);
  const winget = (() => { try { const base = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Packages');
    for (const d of fs.readdirSync(base).filter(n => /^Gyan\.FFmpeg/i.test(n))) for (const sub of fs.readdirSync(path.join(base, d))) { const f = path.join(base, d, sub, 'bin', 'ffmpeg.exe'); if (exists(f)) return f; } } catch {} return null; })();
  const ffmpeg = env.HUB_FFMPEG || winget || 'ffmpeg';
  const userPy = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Python', 'Python312', 'python.exe');
  return { ffmpeg, ffprobe: ffmpeg.replace(/ffmpeg(\.exe)?$/i, m => m.replace('ffmpeg', 'ffprobe')), python: env.HUB_PODCAST_PYTHON || (exists(userPy) ? userPy : 'python') };
}
const EDGE_SCRIPT = "import sys,asyncio,edge_tts;t=open(sys.argv[1],encoding='utf-8').read();asyncio.run(edge_tts.Communicate(t,sys.argv[2],rate=sys.argv[4]).save(sys.argv[3]))";
async function edge(text, out, { voice = EDGE_VOICE, rate = '+0%', t = tools() } = {}) {
  const txt = out + '.txt'; fs.writeFileSync(txt, text, 'utf8');
  try { await run(t.python, ['-c', EDGE_SCRIPT, txt, voice, out, rate], { timeout: 5 * 60000 }); } finally { fs.rmSync(txt, { force: true }); }
  if (!fs.existsSync(out) || fs.statSync(out).size < 2000) throw new Error('微软语音没有返回声音');
  return [out];
}
// 千问一次最多约 500 字，按句子切段。
function chunks(text, max = 450) {
  const out = []; let cur = '';
  for (const s of String(text).split(/(?<=[。！？；\n])/)) { if ((cur + s).length > max && cur) { out.push(cur); cur = ''; } cur += s; }
  if (cur.trim()) out.push(cur); return out;
}
async function qwen(text, out, { credentials, voice = QWEN_VOICE, fetchImpl = fetch } = {}) {
  const { key, base } = credentials(); const files = [];
  for (const [i, part] of chunks(text).entries()) {
    const r = await fetchImpl(base + '/api/v1/services/audio/tts/SpeechSynthesizer', { method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: QWEN_MODEL, input: { text: part, voice, format: 'mp3', sample_rate: 24000 } }) });
    const j = await r.json().catch(() => ({})); if (!j.output?.audio?.url) throw new Error('千问语音失败：' + (j.message || r.status));
    const f = `${out}.${i}.mp3`; fs.writeFileSync(f, Buffer.from(await (await fetchImpl(String(j.output.audio.url).replace(/^http:\/\//i, 'https://'))).arrayBuffer())); files.push(f);
  }
  return files;
}
// 拼接并压成 Opus；返回时长（秒）与大小。
async function encode(parts, out, t = tools()) {
  const list = out + '.list.txt'; fs.writeFileSync(list, parts.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  try { await run(t.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ac', '1', '-ar', '24000', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', out]); }
  finally { fs.rmSync(list, { force: true }); for (const f of parts) fs.rmSync(f, { force: true }); }
  const seconds = +(await run(t.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out])).trim();
  return { seconds: Math.round(seconds), bytes: fs.statSync(out).size };
}
async function synthesize(text, out, { credentials, t = tools() } = {}) {
  const tmp = out.replace(/\.ogg$/i, '');
  let parts, voice;
  try { parts = await edgeAll(text, tmp, { t }); voice = '微软 曉臻'; }
  catch (e) { if (!credentials) throw e; parts = await qwen(text, tmp + '.qwen', { credentials }); voice = '千问 龙安风悦'; }
  return { ...(await encode(parts, out, t)), voice };
}
// 长课程分段连接，任一段失败就整批失败，绝不把半截音频当成完整课程。
async function edgeAll(text, prefix, { t = tools(), edgeImpl = edge } = {}) {
  const parts = chunks(text, 1200), files = [];
  try {
    for (const [i, part] of parts.entries()) { const f = `${prefix}.edge-${i}.mp3`; files.push(f); await edgeImpl(part, f, { t }); }
    return files;
  } catch (e) { for (const f of files) fs.rmSync(f, { force: true }); throw e; }
}
module.exports = { synthesize, edge, edgeAll, qwen, encode, chunks, tools, EDGE_VOICE, QWEN_VOICE };
