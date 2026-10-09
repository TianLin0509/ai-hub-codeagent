'use strict';
// 回复朗读：百炼 qwen-audio-3.1-tts-flash（Token Plan 不含语音合成，走语音设置里的按量 Key；
// 账号有 100 万 token 免费额度并已开「用完自动停止」）。实测 51 字约 191 token、1.2 秒，约 0.0017 元。
// 只把适合听的部分转成语音：去掉 Markdown 符号、链接、代码和表格，超长只读前 500 字。
const MODEL = 'qwen-audio-3.1-tts-flash', VOICE = 'yuxiaoyun_v3.1', MAX_CHARS = 500;

function speakable(markdown) {
  let t = String(markdown || '');
  t = t.replace(/```[\s\S]*?```/g, '（代码略）')
    .replace(/^\s*\|.*\|\s*$/gm, line => /^\s*\|?\s*:?-{2,}/.test(line) ? '' : '\u0001')
    .replace(/(\u0001\s*)+/g, '（表格略，请看文字）\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[A-Za-z]:[\\/][^\s，。；）)]+/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*|__|~~|\*/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS) + '……后面还有内容，请看文字。';
  return t;
}

// 返回阿里云生成的音频地址（约 24 小时有效），手机直接下载播放，不经过中继。
async function synthesize(text, { credentials, fetchImpl = fetch, voice = VOICE } = {}) {
  const body = speakable(text);
  if (!body) throw new Error('这条回复没有可朗读的文字');
  const { key, base } = credentials();
  const started = Date.now();
  const r = await fetchImpl(base + '/api/v1/services/audio/tts/SpeechSynthesizer', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ model: MODEL, input: { text: body, voice, format: 'mp3', sample_rate: 24000 } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.output?.audio?.url) throw new Error(j.message || ('语音合成失败（' + r.status + '）'));
  // 阿里云返回的是 http 地址；手机 App 只允许加密连接，换成同一存储的 https 地址。
  return { url: String(j.output.audio.url).replace(/^http:\/\//i, 'https://'), expiresAt: (j.output.audio.expires_at || 0) * 1000 || Date.now() + 23 * 3600000, chars: body.length, tokens: j.usage?.total_tokens || null, ms: Date.now() - started };
}
module.exports = { speakable, synthesize, MODEL, VOICE };
