'use strict';

// 循环（loop）报告的落盘位置。2026-10-06 用户确认桌面只放启动入口，
// 所以写到产物根（AI_HUB_ARTIFACTS_ROOT，默认 ~/AI-Artifacts），文件名按 YYYYMMDD-<任务> 规则带日期。

const fs = require('fs');
const path = require('path');
const storageRoots = require('./storage-roots.js');

function writeLoopReport(html, { root = storageRoots.artifactsRoot(), now = new Date() } = {}) {
  try {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, `${storageRoots.dateStamp(now)}-loop-report-${now.getTime()}.html`);
    fs.writeFileSync(file, html, { encoding: 'utf8', flag: 'wx' });
    return file;
  } catch {
    return null;
  }
}

module.exports = { writeLoopReport };
