'use strict';
// Before a session or group chat starts an AI CLI, confirm the CLI exists and
// say which one is missing in plain words. Otherwise a missing CLI only shows up
// later as a "command not found" line inside the terminal.
const { findCommand, PROVIDERS } = require('./community-setup');

function requireCommand(provider, env = process.env) {
  const command = findCommand(provider, env);
  if (!command) {
    const name = PROVIDERS.find(p => p.id === provider)?.name || provider;
    throw new Error(`未找到 ${name} CLI。请从首页「安装说明」安装 ${provider}，装好后点「重新检测」，再到账号中心登录。`);
  }
  return command;
}

function assertProviderAvailable(kind, env = process.env) {
  if (!require('./distribution').community) return;
  if (env.CLAUDE_HUB_E2E_ALLOW_MISSING_CLI === '1') return;
  const provider = String(kind || '').replace(/-resume$/, '');
  if (!PROVIDERS.some(p => p.id === provider)) return;
  requireCommand(provider, env);
}

module.exports = { requireCommand, assertProviderAvailable };
