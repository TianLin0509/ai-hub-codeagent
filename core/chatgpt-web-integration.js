'use strict';
const fs = require('fs');
const path = require('path');
const { isolatedPaths, launcherEnvironment } = require('./chatgpt-isolation');
const { chatgptWebRoute } = require('./chatgpt-web-models');

function readWebConfig(env = process.env) {
  const isolation = isolatedPaths(env);
  const root = isolation.runtime;
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); }
  catch (error) { throw new Error(`无法读取 Codex Web GPT 配置，请打开原工具完成设置（${error.code || '配置无效'}）`); }
  if (config.host !== '127.0.0.1' || config.port !== isolation.port) {
    throw new Error('Codex Web GPT 本地服务地址无效');
  }
  return config;
}
function availableRoutes(config) {
  const ids = config.browserInteractionMode === 'manual'
    ? ['zero-risk', ...(config.zeroRiskProEnabled ? ['zero-risk-pro'] : [])]
    : config.solAvailable === false ? ['luna', 'think']
      : ['light', 'medium', 'high', ...(config.proAvailable ? ['extra-high', 'pro'] : [])];
  return ids.map(id => chatgptWebRoute('chatgpt-web/' + id));
}
function requireWebTools(model, env = process.env) {
  const config = readWebConfig(env);
  if (!availableRoutes(config).some(route => route.id === model)) {
    throw new Error('所选 ChatGPT 档位在当前账号或交互模式下不可用，请刷新模型列表');
  }
  if (config.mode !== 'full') {
    throw new Error('ChatGPT 本地工具尚未配置：请打开 Codex Web GPT → MCP，完成 Full MCP 并验证运行时');
  }
  return config;
}
async function webStatus(env = process.env) {
  try {
    const config = readWebConfig(env);
    let online = false, connected = false;
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(3000) });
      const health = await response.json();
      connected = response.ok && health.service === 'codex-chatgpt-web' && health.port === config.port && health.mode === config.mode;
      online = connected && health.accepting_turns === true;
    } catch { /* Explicit offline status is presented below and blocks launch. */ }
    return {
      ok: true, models: availableRoutes(config), online, connected, full: config.mode === 'full',
      interactionMode: config.browserInteractionMode,
      message: !online ? 'ChatGPT 专用服务未就绪，创建会话时将自动在后台启动'
        : config.mode !== 'full' ? '本地工具待配置：请在原工具 MCP 页面完成 Full MCP 并验证运行时'
          : config.browserInteractionMode === 'manual' ? '手动模式：每轮在原工具中选择模型并发送' : 'Full MCP 已配置；本地工具运行结果以实际会话为准',
    };
  } catch (error) { return { ok: false, models: [], online: false, full: false, message: error.message }; }
}
async function openWebSettings({ background = false, env: sourceEnv = process.env } = {}) {
  const launcher = String(sourceEnv.AI_HUB_CHATGPT_WEB_LAUNCHER || '');
  if (!launcher) throw new Error('社区版未附带网页 ChatGPT 启动器');
  const env = launcherEnvironment(sourceEnv);
  const marker = path.join(path.dirname(launcher), 'ai-hub-isolation-install.json');
  if (!fs.existsSync(marker)) throw new Error('未安装 AI Hub 专用隔离启动器');
  const installed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  // The pinned executable enforces its own fixed profile. A fixture or different
  // root must never accidentally start the user's installed launcher.
  if (installed.version !== 1 || installed.pinned !== true || typeof installed.root !== 'string'
      || path.resolve(installed.root).toLowerCase() !== isolatedPaths(sourceEnv).root.toLowerCase()) {
    throw new Error('ChatGPT 启动器与当前隔离目录不匹配，未启动');
  }
  if (!fs.existsSync(launcher)) throw new Error('未找到 AI Hub 专用 Codex Web GPT 启动器');
  readWebConfig(sourceEnv); // Validate the dedicated port before the launcher can start a service.
  await new Promise((resolve, reject) => {
    const child = require('child_process').spawn(launcher, background ? ['--hidden'] : [], { env, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { ok: true };
}
module.exports = { readWebConfig, availableRoutes, requireWebTools, webStatus, openWebSettings };
