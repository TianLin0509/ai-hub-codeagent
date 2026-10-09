'use strict';
// 兼容渲染：有的电脑（2026-10-08 公司真机）用 GPU 渲染时 Hub 窗口全黑，进程却正常响应；
// 关闭 GPU 加速后正常。以下任一条件成立就在启动前关闭硬件加速：
//   - 环境变量 AI_HUB_DISABLE_GPU=1；
//   - 命令行带 --disable-gpu（例如快捷方式里加的）；
//   - Hub 数据目录里有 gpu-disabled.json（安装脚本 -DisableGpu 会写，删掉即恢复 GPU）。
// GPU 进程意外退出只记日志，不自动改设置：一次偶发的显卡问题不应把 Hub 永久切到软件渲染。
const fs = require('fs');
const path = require('path');

const MARKER = 'gpu-disabled.json';

function markerPath(dataDir) {
  return path.join(dataDir, MARKER);
}

function shouldDisableGpu({ env = process.env, argv = process.argv, dataDir } = {}) {
  if (env.AI_HUB_DISABLE_GPU === '1') return 'env';
  if (argv.some(arg => arg === '--disable-gpu')) return 'argv';
  try { if (dataDir && fs.existsSync(markerPath(dataDir))) return 'marker'; } catch {}
  return null;
}

function applyGpuMode({ app, env = process.env, argv = process.argv, dataDir, logger = console } = {}) {
  const reason = shouldDisableGpu({ env, argv, dataDir });
  if (reason) {
    app.disableHardwareAcceleration();
    if (!argv.includes('--disable-gpu-compositing')) app.commandLine.appendSwitch('disable-gpu-compositing');
    logger.log?.(`[gpu] hardware acceleration disabled (${reason})`);
  }
  app.on('child-process-gone', (_event, details) => {
    if (details && details.type === 'GPU') {
      logger.warn?.(`[gpu] GPU process gone: ${details.reason} (exit ${details.exitCode}). 窗口黑屏时可设置 AI_HUB_DISABLE_GPU=1 或在数据目录放 ${MARKER}`);
    }
  });
  return reason;
}

module.exports = { MARKER, markerPath, shouldDisableGpu, applyGpuMode };
