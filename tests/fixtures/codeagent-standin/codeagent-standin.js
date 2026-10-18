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
for (let i = 0; i < input.length; i += 1) {
  if (DROP_FLAGS.has(input[i])) continue;
  if (DROP_WITH_VALUE.has(input[i])) { i += 1; continue; }
  if (ignoreModel && input[i] === '--model') { i += 1; continue; }
  // The company models do not exist for Claude; run the cheapest Claude model instead.
  if (input[i] === '--model' && /^(?:GLM|MiniMax)/i.test(input[i + 1] || '')) {
    args.push('--model', process.env.CODEAGENT_STANDIN_MODEL || 'haiku'); i += 1; continue;
  }
  args.push(input[i]);
}
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
const command = env.CODEAGENT_STANDIN_CLAUDE || 'claude';
// Let the child own Ctrl+C, like the real CLI does.
process.on('SIGINT', () => {});
const child = spawn(command, args, { stdio: 'inherit', env, windowsHide: false });
child.on('exit', code => process.exit(code == null ? 1 : code));
child.on('error', error => { console.error(`codeagent stand-in: cannot start ${command}: ${error.message}`); process.exit(1); });
