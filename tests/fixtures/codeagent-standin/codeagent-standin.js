'use strict';
// Stand-in for the company Code Agent CLI on machines that only have Claude Code.
// It runs the real `claude` and reproduces the differences verified on the real CLI
// (company probe reports, 2026-10-08):
//   - the config directory comes from CODEAGENT3_CONFIG_DIR (mapped to CLAUDE_CONFIG_DIR),
//   - `--session-id <uuid>` is ignored (the real CLI creates its own id),
//   - `--settings <file>` is ignored (hooks passed that way never fire),
//   - `--disable-update` and `--skip-safe-check` are accepted (Claude does not know them).
// Everything else is passed through unchanged.
const { spawn } = require('child_process');

const DROP_FLAGS = new Set(['--disable-update', '--skip-safe-check']);
const DROP_WITH_VALUE = new Set(['--session-id', '--settings']);
const args = [];
const input = process.argv.slice(2);
// CODEAGENT_STANDIN_IGNORE_MODEL=1 reproduces the real CLI's interactive-mode bug (company probe, 2026-10-13):
// `--model` only works with -p; an interactive session always starts on the configured default model.
const ignoreModel = process.env.CODEAGENT_STANDIN_IGNORE_MODEL === '1' && !input.some(a => a === '-p' || a === '--print');
// CODEAGENT_STANDIN_DROP_SYSTEM_PROMPT=1 simulates a CLI that ignores --append-system-prompt-file
// (used to exercise the stuck-on-a-choice-menu fallback, 2026-10-19).
const dropSystemPrompt = process.env.CODEAGENT_STANDIN_DROP_SYSTEM_PROMPT === '1';
for (let i = 0; i < input.length; i += 1) {
  if (DROP_FLAGS.has(input[i])) continue;
  if (DROP_WITH_VALUE.has(input[i])) { i += 1; continue; }
  if (dropSystemPrompt && input[i] === '--append-system-prompt-file') { i += 1; continue; }
  if (ignoreModel && input[i] === '--model') { i += 1; continue; }
  // The company models do not exist for Claude; run the cheapest Claude model instead.
  // DeepSeek too (2026-10-20: automatic sessions now launch with the account's own model, e.g. --model DeepSeek-V4-Flash-0731).
  if (input[i] === '--model' && /^(?:GLM|MiniMax|DeepSeek)/i.test(input[i + 1] || '')) {
    args.push('--model', process.env.CODEAGENT_STANDIN_MODEL || 'haiku'); i += 1; continue;
  }
  args.push(input[i]);
}
// CODEAGENT_STANDIN_NO_CHROME=1: skip Claude Code's "use Chrome extension?" startup dialog on machines with the extension
// (the company CLI has no such dialog).
if (process.env.CODEAGENT_STANDIN_NO_CHROME === '1' && !args.includes('--no-chrome')) args.push('--no-chrome');
const env = { ...process.env };
if (env.CODEAGENT3_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = env.CODEAGENT3_CONFIG_DIR;
// 按模型派活的端到端（2026-10-18）：真 CLI 交互模式按配置目录 settings.json 的 model 定模型。
// CODEAGENT_STANDIN_LAUNCH_LOG=<文件> 时记下每次启动的配置目录和当时 settings.json 里的模型（证据：开在哪个号、用哪个模型）；
// CODEAGENT_STANDIN_MAP_SETTINGS_MODEL=1 时，那个模型是公司模型名（Claude 不认识）就改用 CODEAGENT_STANDIN_MODEL 跑。
{
  let settingsModel = '';
  try { settingsModel = String(JSON.parse(require('fs').readFileSync(require('path').join(env.CODEAGENT3_CONFIG_DIR || '', 'settings.json'), 'utf8')).model || ''); } catch { /* 没有设置 */ }
  if (env.CODEAGENT_STANDIN_LAUNCH_LOG) {
    try { require('fs').appendFileSync(env.CODEAGENT_STANDIN_LAUNCH_LOG, JSON.stringify({ at: Date.now(), configDir: env.CODEAGENT3_CONFIG_DIR || null, settingsModel, args: input, hubSession: env.CLAUDE_HUB_SESSION_ID || null }) + '\n'); } catch { /* 记不下不影响启动 */ }
  }
  if (env.CODEAGENT_STANDIN_MAP_SETTINGS_MODEL === '1' && settingsModel && !/^(?:claude|haiku|sonnet|opus|fable)/i.test(settingsModel) && !args.includes('--model')) {
    args.push('--model', env.CODEAGENT_STANDIN_MODEL || 'haiku');
  }
}
// 额度感知的端到端（2026-10-18）：配置目录里有 standin-api-base.txt 时，这个号的请求发到文件里写的本机假后端，
// 假后端按真实样本格式回报额度错误，真 Claude Code 照常把它写成一条 API 错误消息落进原生记录、显示在屏幕上（模拟 CodeAgent 后台报错）。
try {
  const base = require('fs').readFileSync(require('path').join(env.CODEAGENT3_CONFIG_DIR || '', 'standin-api-base.txt'), 'utf8').trim();
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) env.ANTHROPIC_BASE_URL = base;
} catch { /* 没有这个文件：正常调用 */ }
// 模型配置有误的端到端（2026-10-19）：配置目录里有 standin-model-permissions.json（{ base, allow: [这个号有权限的模型] }）时，
// settings.json 写的模型不在 allow 里，这个号的请求就发到假后端的 /m/<模型>，假后端按公司真机原文回报「模型 "<模型>" 不存在或配置有误」；
// 在 allow 里照常调用。模拟公司后端按号的权限校验模型：配置改对之前每次都报，改对之后正常。
try {
  const perm = JSON.parse(require('fs').readFileSync(require('path').join(env.CODEAGENT3_CONFIG_DIR || '', 'standin-model-permissions.json'), 'utf8'));
  let written = '';
  try { written = String(JSON.parse(require('fs').readFileSync(require('path').join(env.CODEAGENT3_CONFIG_DIR || '', 'settings.json'), 'utf8')).model || ''); } catch { /* 没有设置 */ }
  const allow = (Array.isArray(perm.allow) ? perm.allow : []).map(m => String(m).toLowerCase());
  if (written && !allow.includes(written.toLowerCase()) && /^http:\/\/127\.0\.0\.1:\d+$/.test(String(perm.base || ''))) {
    env.ANTHROPIC_BASE_URL = `${perm.base}/m/${encodeURIComponent(written)}`;
  }
} catch { /* 没有这个文件：正常调用 */ }
// 登录失效 / 刷屏的号（2026-10-19 启动中心按账号建会话的排查）：配置目录里有 standin-mode.txt 时不启动真 CLI：
//   login：像登录失效的 CodeAgent 一样停在登录提示上，等输入；flood：持续大量输出（模拟报错循环刷屏）。
try {
  const mode = require('fs').readFileSync(require('path').join(env.CODEAGENT3_CONFIG_DIR || '', 'standin-mode.txt'), 'utf8').trim();
  if (mode === 'login') {
    process.stdout.write('\x1b[1mCodeAgent\x1b[0m v1.2615.02.01\r\n\r\n登录已失效，请重新登录。\r\n  1. 账号密码登录\r\n  2. 浏览器登录\r\n\r\n请选择登录方式 (1/2): ');
    process.stdin.resume();
    process.stdin.on('data', () => process.stdout.write('\r\n请选择登录方式 (1/2): '));
    return;
  }
  if (mode === 'flood') {
    let n = 0;
    const tick = () => { let s = ''; for (let i = 0; i < 200; i++) s += `[${++n}] 刷新登录凭证失败，重试中…… ${'x'.repeat(80)}\r\n`; process.stdout.write(s, () => setImmediate(tick)); };
    tick();
    return;
  }
} catch { /* 没有这个文件：正常启动 */ }
const command = env.CODEAGENT_STANDIN_CLAUDE || 'claude';
// Let the child own Ctrl+C, like the real CLI does.
process.on('SIGINT', () => {});
const child = spawn(command, args, { stdio: 'inherit', env, windowsHide: false });
child.on('exit', code => process.exit(code == null ? 1 : code));
child.on('error', error => { console.error(`codeagent stand-in: cannot start ${command}: ${error.message}`); process.exit(1); });
