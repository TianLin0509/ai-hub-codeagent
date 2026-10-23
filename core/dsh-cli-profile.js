'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The runtime is installed separately; Hub's shared node_modules stays intact.
function resolveDshCliRuntime(entry = {}, env = process.env) {
  let root = entry.cliRoot || env.AI_HUB_DSH_CLI_ROOT;
  if (!root) {
    const file = path.join(os.homedir(), '.dsh', 'hub-cli-runtime.json');
    if (fs.existsSync(file)) root = JSON.parse(fs.readFileSync(file, 'utf8')).root;
  }
  if (!root || !path.isAbsolute(root)) throw new Error('请先安装 DSH CLI 终端运行环境');
  const modules = path.join(root, 'node_modules');
  const entryPath = path.join(modules, '@deepseek-ai/dsh/lib/bin.js');
  for (const file of [entryPath, path.join(modules, '@deepseek-harness-tui/dsh-tui/package.json')]) {
    if (!fs.existsSync(file)) throw new Error('DSH CLI 终端运行环境不完整：' + file);
  }
  return { root, modules, entryPath };
}

function buildDshCliOptions(kind, opts, config, dataDir, env) {
  const runtime = resolveDshCliRuntime(config.acp?.providers?.['deepseek-acp'], env);
  const acp = config.acp || {};
  return require('./acp-profiles').buildAcpOptions(kind, { ...opts, dshCliRuntime: runtime }, {
    ...config, acp: { ...acp, providers: { ...acp.providers,
      'deepseek-acp': { ...acp.providers?.['deepseek-acp'], entryPath: runtime.entryPath } } },
  }, dataDir, env);
}
module.exports = { resolveDshCliRuntime, buildDshCliOptions };
