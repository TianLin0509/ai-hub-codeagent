'use strict';
// 资料口播 · 写稿：一章资料 → 一集给耳朵听的口播稿。
// 默认 Claude Opus 5.5（命令行无头调用，不在侧栏开会话，用订阅额度）；失败或超时退回 Token Plan 的千问 qwen3.8-max。
// 2026-10-06 实测同一章：Claude 稿最贴合要求（篇幅、金句、呼应），Codex 次之，千问超长且结尾照抄开头。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TEMPLATE_FILE = path.join(__dirname, 'script-prompt.md');
const MAX_SOURCE = 12000;
function lengthFor(chars) { return chars < 1500 ? '900～1300' : chars < 6000 ? '1400～1800' : '1800～2400'; }
// listener：助理沉淀的记忆（USER.md / MEMORY.md）。听众身份不写进仓库：Claude 会加载用户自己的全局规则，记忆是给退回的模型用的。
function buildPrompt({ book, chapter, index, total, text, listener = '' }) {
  const src = String(text || '').slice(0, MAX_SOURCE);
  return fs.readFileSync(TEMPLATE_FILE, 'utf8')
    .replace('{{book}}', book).replace('{{chapter}}', chapter).replace('{{index}}', String(index)).replace('{{total}}', String(total))
    .replace('{{listener}}', String(listener || '').replace(/^[#>].*$/gm, '').trim().slice(0, 1500) || '（暂无）')
    .replace('{{length}}', lengthFor(src.length)).replace('{{text}}', src);
}
// 嵌套在 Hub 里启动 CLI 时，去掉会让它误以为是子会话、或把 hook 投回 Hub 的变量。
const STRIP = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID'];
function claudeWriter({ model = 'claude-opus-5-5', exe, cwd, timeoutMs = 6 * 60000, spawnImpl = spawn } = {}) {
  return { name: 'Claude ' + (model.includes('opus') ? 'Opus' : 'Sonnet'), write: prompt => new Promise((resolve, reject) => {
    const env = { ...process.env }; for (const k of STRIP) delete env[k];
    const bin = exe || require('../../account-adapters').resolveClaudeExe(env);
    const child = spawnImpl(bin, ['-p', '--model', model, '--tools', ''], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Claude 写稿超时')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); const t = out.trim(); if (code === 0 && t.length > 200) resolve(t); else reject(new Error('Claude 写稿失败：' + (err || t).slice(0, 200))); });
    child.stdin.end(prompt, 'utf8');
  }) };
}
function qwenWriter({ source, model = 'qwen3.8-max', fetchImpl = fetch } = {}) {
  return { name: '千问 ' + model, write: async prompt => {
    const src = typeof source === 'function' ? source() : source; if (!src) throw new Error('没有可用的千问凭据');
    const r = await fetchImpl(src.base + '/compatible-mode/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(5 * 60000),
      headers: { Authorization: 'Bearer ' + src.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.6, enable_thinking: false }) });
    const j = await r.json().catch(() => ({})); const t = j.choices?.[0]?.message?.content?.trim();
    if (!r.ok || !t) throw new Error('千问写稿失败：' + (j.error?.message || r.status)); return t;
  } };
}
// 稿子清理：去掉模型偶尔加的标题、分隔线和舞台说明，保证念出来的都是正文。
function tidy(text) {
  return String(text).replace(/\r/g, '').split('\n').filter(l => !/^\s*(#{1,6}\s|-{3,}\s*$|\*{3,}\s*$|【.*(音乐|停顿|片头|片尾).*】\s*$)/.test(l)).join('\n').replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim();
}
async function writeScript(prompt, writers) {
  const errors = [];
  for (const w of writers) {
    const t0 = Date.now();
    try { return { text: tidy(await w.write(prompt)), writer: w.name, ms: Date.now() - t0 }; }
    catch (e) { errors.push(w.name + '：' + e.message); }
  }
  throw new Error(errors.join('；'));
}
module.exports = { buildPrompt, claudeWriter, qwenWriter, writeScript, tidy, lengthFor };
