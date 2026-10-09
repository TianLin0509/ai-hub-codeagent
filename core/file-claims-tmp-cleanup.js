'use strict';

// ~/.claude/scripts/file-scope-guard.py（Claude PreToolUse hook）把文件占用表原子写到
// Hub 数据目录的 file-claims.json：先写 file-claims.json.tmp.<pid> 再 replace。hook
// 进程被中断或超时硬杀时 tmp 会留下来（2026-09-26 生产目录已攒 252 个）。脚本本身已修
// 异常路径；硬杀来不及清理的，由 Hub 启动时按这里的规则收掉。
//
// 只匹配这一个精确前缀、只删普通文件、只删 1 小时前的：正在写的 tmp 是毫秒级的，
// 1 小时的余量保证不会和一次进行中的 hook 抢文件。

const fs = require('fs');
const path = require('path');

const FILE_CLAIMS_TMP_PREFIX = 'file-claims.json.tmp.';
const FILE_CLAIMS_TMP_MAX_AGE_MS = 60 * 60 * 1000;

function cleanupFileClaimsTmp(dataDir, {
  maxAgeMs = FILE_CLAIMS_TMP_MAX_AGE_MS,
  now = Date.now(),
  fsModule = fs,
} = {}) {
  const summary = { scanned: 0, removed: 0, kept: 0, errors: [] };
  if (!dataDir) return summary;
  let names;
  try {
    names = fsModule.readdirSync(dataDir);
  } catch (error) {
    if (error && error.code !== 'ENOENT') summary.errors.push(`${dataDir}: ${error.message}`);
    return summary;
  }
  for (const name of names) {
    if (typeof name !== 'string' || !name.startsWith(FILE_CLAIMS_TMP_PREFIX)) continue;
    if (name.length === FILE_CLAIMS_TMP_PREFIX.length) continue;
    summary.scanned += 1;
    const full = path.join(dataDir, name);
    try {
      const stat = fsModule.lstatSync(full);
      if (!stat.isFile() || now - stat.mtimeMs < maxAgeMs) {
        summary.kept += 1;
        continue;
      }
      fsModule.unlinkSync(full);
      summary.removed += 1;
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      summary.errors.push(`${name}: ${error && error.message}`);
    }
  }
  return summary;
}

module.exports = {
  FILE_CLAIMS_TMP_PREFIX,
  FILE_CLAIMS_TMP_MAX_AGE_MS,
  cleanupFileClaimsTmp,
};
