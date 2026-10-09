'use strict';

// Hub 的 CLI hook 用哪个解释器执行。
//
// 私人版沿用 Python（session-hub-hook.py，经过长期实战）。社区版面向干净的
// Windows：那里 `python` 往往只是应用商店占位程序，hook 会静默失败，卡片永远
// 等不到完成。所以社区版改用系统自带的 PowerShell 执行 session-hub-hook.ps1，
// 只做原样转发，字段提取在 Hub 里完成（core/hook-payload.js）。
//
// 命令首词必须是裸命令名（python / powershell）：Claude 在 Git Bash、Codex 经
// COMSPEC 执行 hook，带引号的绝对路径开头在不同 shell 里解析不一致。
// CLAUDE_HUB_HOOK_RUNNER 只用于测试两条路径，不影响发行版判定。

const RUNNERS = Object.freeze({
  python: { script: 'session-hub-hook.py', prefix: 'python' },
  powershell: {
    script: 'session-hub-hook.ps1',
    prefix: 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File',
  },
});

function hookRunnerName(env = process.env) {
  const requested = String(env.CLAUDE_HUB_HOOK_RUNNER || '').trim().toLowerCase();
  if (RUNNERS[requested]) return requested;
  return require('./distribution').community ? 'powershell' : 'python';
}

function hookRunner(env = process.env) {
  const name = hookRunnerName(env);
  return { name, ...RUNNERS[name] };
}

function hookCommand(runner, scriptPath, arg) {
  return `${runner.prefix} "${scriptPath}" ${arg}`;
}

module.exports = { RUNNERS, hookRunnerName, hookRunner, hookCommand };
