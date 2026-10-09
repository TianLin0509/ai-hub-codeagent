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
for (let i = 0; i < input.length; i += 1) {
  if (DROP_FLAGS.has(input[i])) continue;
  if (DROP_WITH_VALUE.has(input[i])) { i += 1; continue; }
  // The company models do not exist for Claude; run the cheapest Claude model instead.
  if (input[i] === '--model' && /^(?:GLM|MiniMax)/i.test(input[i + 1] || '')) {
    args.push('--model', process.env.CODEAGENT_STANDIN_MODEL || 'haiku'); i += 1; continue;
  }
  args.push(input[i]);
}
const env = { ...process.env };
if (env.CODEAGENT3_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = env.CODEAGENT3_CONFIG_DIR;
const command = env.CODEAGENT_STANDIN_CLAUDE || 'claude';
// Let the child own Ctrl+C, like the real CLI does.
process.on('SIGINT', () => {});
const child = spawn(command, args, { stdio: 'inherit', env, windowsHide: false });
child.on('exit', code => process.exit(code == null ? 1 : code));
child.on('error', error => { console.error(`codeagent stand-in: cannot start ${command}: ${error.message}`); process.exit(1); });
