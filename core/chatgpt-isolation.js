'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const DEFAULT_ROOT = path.join(os.homedir(), '.ai-hub-community', 'chatgpt-web');

function isolatedPaths(env = process.env) {
  const root = path.resolve(env.AI_HUB_CHATGPT_ROOT || DEFAULT_ROOT);
  const paths = { root, runtime: path.join(root, 'runtime'), codexHome: path.join(root, 'codex-home'), launcher: path.join(root, 'launcher') };
  // No symlink/junction component may redirect this boundary into another home.
  for (const value of Object.values(paths)) {
    let cursor = value;
    for (;;) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('ChatGPT 隔离目录不能使用链接或 junction');
      const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  }
  if (root.toLowerCase().startsWith(path.resolve(os.homedir(), '.codex').toLowerCase())) throw new Error('ChatGPT 不能使用普通 Codex 配置目录');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(root, 'isolation.json'), 'utf8')); }
  catch { throw new Error('ChatGPT 专用隔离环境未配置，已阻止使用共享 Codex 环境'); }
  if (marker.purpose !== 'ai-hub-chatgpt-only' || marker.version !== 1 || !Number.isInteger(marker.port) || marker.port < 1024 || marker.port > 65535 || marker.port === 17841) throw new Error('ChatGPT 隔离配置无效');
  for (const file of ['config.toml', 'auth.json']) {
    const target = path.join(paths.codexHome, file);
    if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || fs.statSync(target).nlink > 1)) throw new Error('ChatGPT 配置不能链接到其他会话');
  }
  const journal = path.join(paths.runtime, 'codex', 'integration-journal.json');
  if (fs.existsSync(journal)) {
    const value = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (path.resolve(value.configPath || '').toLowerCase() !== path.join(paths.codexHome, 'config.toml').toLowerCase()) throw new Error('ChatGPT 安装记录指向共享配置，已阻止启动');
  }
  if (marker.proxy) {
    const proxy = new URL(marker.proxy);
    if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || proxy.username || proxy.password) throw new Error('ChatGPT 专用代理必须是本机 HTTP 代理');
  }
  return { ...paths, port: marker.port, proxy: marker.proxy };
}

function launcherEnvironment(env = process.env) {
  const paths = isolatedPaths(env);
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (/API_KEY|TOKEN|SECRET|^OPENAI_BASE_URL$|^ELECTRON_RUN_AS_NODE$|^NODE_OPTIONS$/i.test(key)) delete clean[key];
  if (paths.proxy) Object.assign(clean, { HTTP_PROXY: paths.proxy, HTTPS_PROXY: paths.proxy, NO_PROXY: '127.0.0.1,localhost' });
  return { ...clean, CODEX_HOME: paths.codexHome, CODEX_CHATGPT_WEB_HOME: paths.runtime, CODEX_WEB_GPT_LAUNCHER_DATA_DIR: paths.launcher };
}
module.exports = { isolatedPaths, launcherEnvironment };
