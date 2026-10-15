'use strict';
// 先写临时文件再改名替换：Windows 上目标文件被杀毒或索引短暂占用时改名会报 EPERM / EBUSY，
// 稍等重试（与主干其他保存点同一规则：只重试这两类、仅 Windows、最多 20 次）。
// 2026-10-15 合并闸门里 connectBridge 写入口文件因此失败过一次。
const { renameWithRetrySync } = require('../claude-project-trust');
const RETRY_CODES = new Set(['EPERM', 'EBUSY']);
function renameRetry(source, target) {
  return renameWithRetrySync(source, target, { retries: process.platform === 'win32' ? 20 : 0, retryCodes: RETRY_CODES });
}
module.exports = { renameRetry };
