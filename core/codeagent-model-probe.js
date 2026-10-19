'use strict';
// 一键获取某个 CodeAgent 账号能用哪些模型（2026-10-16 用户要求：「我的号只有 GLM，另一个号只有 DeepSeek」要一眼看出来）。
// 做法：在后台悄悄起一个这个账号配置目录下的 CodeAgent，等它出现输入框，打开它自己的 /model 菜单，读出菜单里的模型，
// 按 Esc 关掉菜单再结束进程。读的是 CodeAgent 自己给这个账号列的菜单，所以就是它实际能选的模型；不发消息、不调模型。
// 菜单的识别沿用 core/codeagent-model-picker.js（公司真机逐行原文写成的规则）。
const fs = require('fs');
const path = require('path');

const MODELS_FILE = 'hub-models.json';
const NEEDS_LOGIN = /W3\s*用户名|please\s+(?:run\s+)?\/?login|not\s+(?:logged\s+in|authenticated)|No valid auth token|请先登录|未登录/i;

function cleanModelId(label) {
  const id = String(label || '').replace(/\s+default\b.*$/i, '').replace(/[✔✓]/g, '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(id) ? id : '';
}

function readProbed(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const models = (Array.isArray(raw.models) ? raw.models : []).map(cleanModelId).filter(Boolean);
    return models.length ? { models, defaultModel: cleanModelId(raw.defaultModel), at: raw.at || null } : null;
  } catch { return null; }
}

function writeProbed(file, result) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 1, models: result.models, defaultModel: result.defaultModel || '', at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function modelsFromPicker(picker) {
  const models = [];
  let defaultModel = '';
  for (const row of picker.rows) {
    const id = cleanModelId(row.label);
    if (!id || models.some(m => m.toLowerCase() === id.toLowerCase())) continue;
    models.push(id);
    if (/\bdefault\b/i.test(row.text)) defaultModel = id;
  }
  return { models, defaultModel };
}

// command/configDirEnv 来自 core/codeagent-config.js；cwd 必须是一个下面没有 .cac 凭证的目录（否则会认成别的号）。
async function probeModels({ command, configDirEnv, configDir, cwd, env = process.env, ptyModule = null,
  readyTimeoutMs = 40000, menuTimeoutMs = 15000, cols = 160, rows = 60 } = {}) {
  const picker = require('./codeagent-model-picker');
  const { createTrustScreen } = require('./claude-trust-dialog');
  const pty = ptyModule || require('node-pty');
  const screen = createTrustScreen({ cols, rows });
  if (!screen) return { ok: false, error: '终端组件不可用' };
  fs.mkdirSync(cwd, { recursive: true });
  try { require('./claude-project-trust.js').ensureClaudeProjectTrusted(cwd, { configDir, stateFileName: '.cac.json' }); } catch { /* 有 --skip-safe-check 兜底 */ }
  const childEnv = { ...env, [configDirEnv]: configDir };
  require('./codeagent-launch-env').applyAccountEnv(childEnv, { configDirEnv, configDir });
  // 不让这个临时进程的 hook 冒充 Hub 会话
  for (const key of Object.keys(childEnv)) if (/^CLAUDE_HUB_(?:SESSION_ID|PORT|TOKEN)$|^CODEAGENT_HUB_/.test(key)) delete childEnv[key];
  if (process.platform === 'win32' && !childEnv.WT_SESSION) childEnv.WT_SESSION = 'ai-hub';
  const head = /^[A-Za-z0-9_.-]+$/.test(command) ? command : `"${path.normalize(String(command).replace(/"/g, ''))}"`;
  let proc;
  // Windows 上 node-pty 收到数组会按 C 运行库规则给引号加反斜杠转义，cmd 不认；整行字符串原样交给它。
  // /s 去掉最外层一对引号，里面的命令照原样执行。
  const line = `/d /s /c "call ${head} --disable-update --skip-safe-check"`;
  try { proc = pty.spawn('cmd.exe', process.platform === 'win32' ? line : ['/d', '/s', '/c', `call ${head} --disable-update --skip-safe-check`], { name: 'xterm-256color', cols, rows, cwd, env: childEnv }); }
  catch (error) { screen.dispose(); return { ok: false, error: `启动 CodeAgent 失败：${error.message}` }; }
  let exited = false;
  proc.onData(data => screen.write(data));
  proc.onExit(() => { exited = true; });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (test, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !exited) {
      const lines = await screen.lines();
      const hit = test(lines);
      if (hit) return { hit, lines };
      await sleep(300);
    }
    return { hit: null, lines: await screen.lines() };
  };
  try {
    const ready = await waitFor(lines => (NEEDS_LOGIN.test(lines.join('\n')) ? 'login' : picker.promptInputReady(lines) ? 'ready' : null), readyTimeoutMs);
    if (ready.hit === 'login') return { ok: false, error: '这个号需要重新登录' };
    if (!ready.hit) return { ok: false, error: exited ? 'CodeAgent 启动后退出了' : 'CodeAgent 输入框没有出现（超时）' };
    proc.write('/model');
    await sleep(500);
    proc.write('\r');
    const menu = await waitFor(lines => picker.parsePicker(lines), menuTimeoutMs);
    if (!menu.hit) return { ok: false, error: '没有读到模型菜单' };
    const result = modelsFromPicker(menu.hit);
    if (!result.models.length) return { ok: false, error: '模型菜单是空的' };
    proc.write('\x1b');
    await sleep(300);
    return { ok: true, ...result };
  } finally {
    try { if (!exited) proc.kill(); } catch { /* 已退出 */ }
    screen.dispose();
  }
}

module.exports = { MODELS_FILE, probeModels, readProbed, writeProbed, modelsFromPicker, cleanModelId };
