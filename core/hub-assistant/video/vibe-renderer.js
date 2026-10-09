'use strict';
// Vibe 知识大赏式学习视频：无旁白，图形动画 + 事件拟声 + 氛围垫音。
// 画面由 vibe-template.html 按时间 t 纯函数渲染；抓帧方式可替换（Hub 里用 Electron 离屏，测试用无头浏览器）。
const fs = require('node:fs'), path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const TEMPLATE = path.join(__dirname, 'vibe-template.html');
const FPS = 24, W = 1280, H = 720;

const run = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20 * 60000 }, (err, out, stderr) => err ? reject(Error(String(stderr || err.message).slice(-600))) : resolve(out)));

// 分镜校验：只定格式与底线，不规定内容。
const TYPES = ['hook', 'concept', 'compare', 'number', 'flow', 'loop', 'quote'];
const str = (v, max, name) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw Error('视频分镜文字无效：' + name); return v.trim(); };
const opt = (v, max, name) => v == null || v === '' ? undefined : str(v, max, name);
const list = (v, min, max, len, name) => { if (!Array.isArray(v) || v.length < min || v.length > max) throw Error(`视频分镜「${name}」需要 ${min}–${max} 项`); return v.map((x, i) => str(x, len, `${name}[${i}]`)); };
function validateStoryboard(sb) {
  if (!sb || typeof sb !== 'object' || !Array.isArray(sb.screens) || sb.screens.length < 5 || sb.screens.length > 10) throw Error('视频需要 5–10 屏分镜');
  const screens = sb.screens.map((s, i) => {
    if (!TYPES.includes(s.type)) throw Error(`第 ${i + 1} 屏类型无效：${s.type}`);
    const base = { type: s.type, duration: Math.max(6, Math.min(40, Number(s.duration) || 16)), notes: s.notes == null ? [] : list(s.notes, 0, 3, 60, 'notes') };
    switch (s.type) {
      case 'hook': return { ...base, big: str(s.big, 10, 'big'), headline: str(s.headline, 24, 'headline') };
      case 'concept': return { ...base, headline: str(s.headline, 22, 'headline'), center: str(s.center, 8, 'center'), nodes: list(s.nodes, 3, 6, 16, 'nodes') };
      case 'compare': {
        const side = (x, n) => ({ title: str(x?.title, 12, n + '.title'), count: Math.max(1, Math.min(12, Number(x?.count) || 4)), items: list(x?.items, 1, 4, 18, n + '.items') });
        return { ...base, headline: str(s.headline, 20, 'headline'), left: side(s.left, 'left'), right: side(s.right, 'right'), verdict: opt(s.verdict, 30, 'verdict') };
      }
      case 'number': {
        const bars = s.bars == null ? [] : (Array.isArray(s.bars) && s.bars.length <= 4 ? s.bars : (() => { throw Error('对比柱最多 4 根'); })())
          .map((b, j) => ({ label: str(b.label, 12, `bars[${j}].label`), value: Number(b.value), text: opt(b.text, 12, `bars[${j}].text`), gold: !!b.gold }));
        if (bars.some(b => !Number.isFinite(b.value))) throw Error('对比柱的数值无效');
        return { ...base, value: str(String(s.value), 8, 'value'), unit: opt(s.unit, 8, 'unit'), headline: str(s.headline, 26, 'headline'), bars };
      }
      case 'flow': return { ...base, headline: str(s.headline, 22, 'headline'), steps: (Array.isArray(s.steps) && s.steps.length >= 3 && s.steps.length <= 6 ? s.steps : (() => { throw Error('流程需要 3–6 步'); })()).map((x, j) => ({ label: str(x.label, 12, `steps[${j}].label`), note: opt(x.note, 18, `steps[${j}].note`) })) };
      case 'loop': return { ...base, headline: str(s.headline, 22, 'headline'), center: opt(s.center, 8, 'center'), nodes: list(s.nodes, 3, 6, 16, 'nodes') };
      case 'quote': return { ...base, quote: str(s.quote, 26, 'quote'), sub: opt(s.sub, 40, 'sub') };
    }
  });
  if (screens[0].type !== 'hook') throw Error('第一屏须是钩子（hook）');
  if (screens.at(-1).type !== 'quote') throw Error('最后一屏须是金句（quote）');
  const total = screens.reduce((a, s) => a + s.duration + 0.3, 0);
  if (total < 90 || total > 300) throw Error(`视频总长 ${Math.round(total)} 秒，应在 90–300 秒之间`);
  return { title: str(sb.title, 40, 'title'), tag: opt(sb.tag, 40, 'tag'), footer: opt(sb.footer, 80, 'footer'), series: opt(sb.series, 24, 'series') || '今日一档', screens };
}

// ---------- 声音：程序生成，不依赖素材文件 ----------
const FOLEY = {
  tick: ['-f', 'lavfi', '-i', 'sine=f=1760:d=0.07', '-af', 'afade=t=out:st=0:d=0.07,lowpass=f=4000,volume=0.5'],
  swish: ['-f', 'lavfi', '-i', 'anoisesrc=d=0.5:c=pink:a=0.4:seed=3', '-af', 'bandpass=f=1800:width_type=h:w=2400,afade=t=in:st=0:d=0.18,afade=t=out:st=0.18:d=0.32,volume=0.7'],
  pulse: ['-f', 'lavfi', '-i', 'sine=f=330:d=0.22', '-af', 'afade=t=out:st=0:d=0.22,lowpass=f=1200,volume=0.6'],
  impact: ['-f', 'lavfi', '-i', 'sine=f=58:d=1.1', '-af', 'afade=t=in:st=0:d=0.01,afade=t=out:st=0.05:d=1.0,volume=1.6'],
};
const LEVEL = { tick: -20, swish: -22, pulse: -18, impact: -13 };
async function buildAudio({ ffmpeg, dir, events, seconds }) {
  const sfx = {};
  for (const [k, args] of Object.entries(FOLEY)) { sfx[k] = path.join(dir, `sfx-${k}.wav`); await run(ffmpeg, ['-y', '-loglevel', 'error', ...args, '-ar', '44100', '-ac', '2', sfx[k]]); }
  // 氛围垫音：三个低频正弦慢速起伏，高通 20Hz，不加宽带白噪。
  const bed = path.join(dir, 'bed.wav');
  await run(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=f=55:d=${seconds}`, '-f', 'lavfi', '-i', `sine=f=82.41:d=${seconds}`, '-f', 'lavfi', '-i', `sine=f=110:d=${seconds}`,
    '-filter_complex', `[0]volume=0.5[a];[1]volume=0.32,tremolo=f=0.1:d=0.5[b];[2]volume=0.16,tremolo=f=0.13:d=0.6[c];[a][b][c]amix=inputs=3:normalize=0,highpass=f=20,lowpass=f=600,volume=-19dB,afade=t=in:st=0:d=3,afade=t=out:st=${Math.max(0, seconds - 4)}:d=4`, '-ar', '44100', '-ac', '2', bed]);
  // 同一时刻最多 2 个音效，最小间隔防止叠音
  const gap = { tick: .18, swish: .35, pulse: .2, impact: 1.5 }, last = {}, kept = [];
  for (const e of events) { if (!sfx[e.kind] || e.t < 0 || e.t > seconds - .3) continue; if (last[e.kind] != null && e.t - last[e.kind] < gap[e.kind]) continue; if (kept.filter(x => Math.abs(x.t - e.t) < .15).length >= 2) continue; kept.push(e); last[e.kind] = e.t; }
  const inputs = ['-i', bed], parts = [], labels = ['[0]'];
  kept.forEach((e, i) => { inputs.push('-i', sfx[e.kind]); const ms = Math.round(e.t * 1000); parts.push(`[${i + 1}]adelay=${ms}|${ms},volume=${LEVEL[e.kind]}dB[e${i}]`); labels.push(`[e${i}]`); });
  const out = path.join(dir, 'soundtrack.m4a');
  await run(ffmpeg, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${parts.join(';')}${parts.length ? ';' : ''}${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first,loudnorm=I=-20:TP=-1.5:LRA=11,aresample=44100`, '-t', String(seconds), '-c:a', 'aac', '-b:a', '128k', out]);
  return { file: out, events: kept.length };
}

// ---------- 画面 + 合成 ----------
// capture: { open(spec) -> {total, events}, frame(t) -> Promise<Buffer jpeg>, close() }
async function renderVibeVideo({ storyboard, dir, ffmpeg, ffprobe, capture, onProgress = () => {} }) {
  const spec = validateStoryboard(storyboard);
  fs.mkdirSync(dir, { recursive: true });
  const { total, events } = await capture.open(spec);
  const seconds = Math.round(total * 10) / 10, frames = Math.ceil(seconds * FPS);
  onProgress('合成配乐与拟声', 3);
  const audio = await buildAudio({ ffmpeg, dir, events, seconds });
  const output = path.join(dir, 'video.part.mp4');
  const enc = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-i', audio.file,
    '-vf', 'scale=in_range=full:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-profile:v', 'high', '-c:a', 'copy', '-movflags', '+faststart', '-shortest', output], { windowsHide: true });
  let err = ''; enc.stderr.on('data', d => { err += d; });
  const done = new Promise((resolve, reject) => enc.on('close', code => code === 0 ? resolve() : reject(Error('视频编码失败：' + err.slice(-400)))));
  try {
    for (let i = 0; i < frames; i++) {
      const jpg = await capture.frame(i / FPS);
      if (!enc.stdin.write(jpg)) await new Promise(r => enc.stdin.once('drain', r));
      if (i % (FPS * 5) === 0) onProgress(`绘制画面 ${Math.round(i / FPS)}/${Math.round(seconds)} 秒`, 5 + Math.round(85 * i / frames));
    }
    // 封面：钩子屏定格
    fs.writeFileSync(path.join(dir, 'cover.jpg'), await capture.frame(Math.min(spec.screens[0].duration - 1.2, 6)));
  } finally { enc.stdin.end(); await capture.close(); }
  await done;
  const actual = Number(String(await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output])).trim());
  if (!Number.isFinite(actual) || Math.abs(actual - seconds) > 1.5) throw Error(`视频时长 ${actual} 秒与分镜 ${seconds} 秒不符，未交付`);
  fs.renameSync(output, path.join(dir, 'video.mp4'));
  // 成片后只留 video.mp4 / cover.jpg，中间音频（垫音约 27MB）删掉。
  for (const f of fs.readdirSync(dir)) if (/^(sfx-.*\.wav|bed\.wav|soundtrack\.m4a)$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  // 章节：每屏的起点，供手机跳转
  let at = 0; const chapters = spec.screens.map(s => { const c = { title: s.headline || s.quote || s.big, at: Math.round(at) }; at += s.duration + 0.3; return c; });
  onProgress('视频已完成', 100);
  return { seconds: Math.round(actual), bytes: fs.statSync(path.join(dir, 'video.mp4')).size, chapters, foley: audio.events };
}

module.exports = { renderVibeVideo, validateStoryboard, buildAudio, TEMPLATE, FPS, W, H };
