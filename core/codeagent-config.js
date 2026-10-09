'use strict';
// 公司内部 Code Agent CLI 的启动配置。
//
// 这个 CLI 的界面、配置文件、会话记录与 hook 都是 Claude Code 形态（2026-10-08 两轮公司实测），
// Hub 按 Claude 家族接入，只在这里集中描述它与 Claude 不同的地方：
//   - 命令名默认 `codeagent`（安装目录里的 .bat 包装，负责企业证书与代理环境）；
//   - 配置目录由 CODEAGENT3_CONFIG_DIR 指定，默认 ~/.cac（相当于 CLAUDE_CONFIG_DIR / ~/.claude），
//     状态文件是 .cac.json（相当于 .claude.json）；
//   - 不认 --session-id 与 --settings：会话身份只能等第一个 hook 上报后绑定，Hub 的 hook
//     只能写进配置目录的 settings.json；
//   - 必须带 --disable-update，否则启动时弹出阻塞的「版本更新提醒」。
//
// 命令名、配置目录变量名和配置目录都可覆盖（环境变量优先，其次 config.json 的
// providers.codeagent），没有这个 CLI 的电脑可以指向测试替身
// tests/fixtures/codeagent-standin/codeagent.cmd（内部启动真 Claude Code）。
const os = require('os');
const path = require('path');

const DEFAULT_COMMAND = 'codeagent';
const DEFAULT_CONFIG_ENV = 'CODEAGENT3_CONFIG_DIR';
const STATE_FILE = '.cac.json';
const MODELS = Object.freeze(['GLM-5.2-WX-Auto', 'MiniMax-M2.7']);
const DEFAULT_MODEL = MODELS[0];
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);
// 实测能从 settings.json 触发的事件（公司探测第一轮 P5 与 CodeTeam 现有登记的并集）。
// 只登记这些，避免未知事件名让整份 settings.json 校验失败——这份文件同事的其他工具也在用。
const HOOK_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PermissionRequest',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification']);

function hubProviderConfig() {
  try {
    const config = require('./hub-config').getConfig();
    const value = config && config.providers && config.providers.codeagent;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveCodeAgentConfig(env = process.env, provider = hubProviderConfig()) {
  const command = cleanString(env.AI_HUB_CODEAGENT_COMMAND) || cleanString(provider.command) || DEFAULT_COMMAND;
  const configDirEnv = cleanString(env.AI_HUB_CODEAGENT_CONFIG_ENV) || cleanString(provider.configDirEnv) || DEFAULT_CONFIG_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(configDirEnv)) throw new Error(`CodeAgent 配置目录变量名无效：${configDirEnv}`);
  if (/[\r\n"`$;&|<>]/.test(command)) throw new Error('CodeAgent 命令包含不允许的字符');
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const configDir = path.resolve(cleanString(env.AI_HUB_CODEAGENT_CONFIG_DIR) || cleanString(provider.configDir)
    || cleanString(env[configDirEnv]) || path.join(home, '.cac'));
  return { command, configDirEnv, configDir, stateFile: STATE_FILE };
}

// PowerShell 里键入的命令头：普通命令名原样；带路径或空格的用调用运算符。
function commandHead(command) {
  if (/^[A-Za-z0-9_.-]+$/.test(command)) return command;
  return `& '${command.replace(/'/g, "''")}'`;
}

// 只查文件、不启动进程：命令是完整路径就看文件在不在；否则按 PATH + Windows 可执行扩展名找。
// 用于界面默认选中 CodeAgent（公司电脑），不作为能否登录或调用模型的证据。
function isCodeAgentInstalled(env = process.env, provider = hubProviderConfig()) {
  const fs = require('fs');
  let command;
  try { ({ command } = resolveCodeAgentConfig(env, provider)); } catch { return false; }
  const exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  if (path.isAbsolute(command)) return exists(command);
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const dirs = String(env[pathKey] || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  return dirs.some(dir => exts.some(ext => exists(path.join(dir.replace(/^"|"$/g, ''), command + ext))));
}

function normalizeCodeAgentModel(model) {
  const value = cleanString(model);
  return MODELS.find(id => id.toLowerCase() === value.toLowerCase()) || DEFAULT_MODEL;
}

module.exports = {
  DEFAULT_COMMAND,
  DEFAULT_CONFIG_ENV,
  STATE_FILE,
  MODELS,
  DEFAULT_MODEL,
  EFFORTS,
  HOOK_EVENTS,
  resolveCodeAgentConfig,
  commandHead,
  normalizeCodeAgentModel,
  isCodeAgentInstalled,
};
