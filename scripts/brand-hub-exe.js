'use strict';

/**
 * 生成/刷新 node_modules/electron/dist/AIHubCommunity.exe（electron.exe 的品牌化副本）。
 *
 * 为什么单独一个脚本：electron.exe 220MB+，读一遍 + 重写资源 + 写一遍，
 * 在 Electron 主进程里同步跑会把 UI 卡住好几秒。main.js 用 ELECTRON_RUN_AS_NODE
 * spawn 这个脚本，跑完了再把快捷方式指过去。
 *
 * 手动跑（Hub 开着也安全，只新增文件，不碰 electron.exe）：
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   .\node_modules\electron\dist\electron.exe .\scripts\brand-hub-exe.js
 *
 * 原理和取舍见 core/hub-exe-branding.js 顶部注释。
 */

const path = require('path');
const {
  ensureBrandedHubExe,
  inspectBrandedHubExe,
} = require(path.join(__dirname, '..', 'core', 'hub-exe-branding.js'));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 0) out[token.slice(2, eq)] = token.slice(eq + 1);
    else out[token.slice(2)] = argv[++i];
  }
  return out;
}

function main() {
  const appRoot = path.resolve(__dirname, '..');
  const args = parseArgs(process.argv.slice(2));
  const execPath = args.exe || process.execPath;
  const icoPath = args.ico || path.join(appRoot, 'claude-wx.ico');
  let productVersion = args.version;
  if (!productVersion) {
    try { productVersion = require(path.join(appRoot, 'package.json')).version || ''; } catch { productVersion = ''; }
  }
  const productName = args.name || 'AI Hub Community';

  const before = inspectBrandedHubExe({ execPath, icoPath, productVersion });
  console.log(`[hub-brand] host=${before.hostExePath}`);
  console.log(`[hub-brand] target=${before.brandedExePath}`);
  console.log(`[hub-brand] state=${before.reason}`);

  const started = Date.now();
  const result = ensureBrandedHubExe({ execPath, icoPath, productName, productVersion });
  const elapsed = Date.now() - started;

  if (result.error) {
    console.error(`[hub-brand] FAILED (${result.reason}): ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(result.changed
    ? `[hub-brand] rebuilt in ${elapsed}ms -> ${result.brandedExePath}`
    : `[hub-brand] no change needed (${result.reason})`);
}

if (require.main === module) main();

module.exports = { parseArgs };
