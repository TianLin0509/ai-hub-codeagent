'use strict';
// Build-time only. The signed official binary stays out of Git.
// 2026-10-22（v3.1.3）：安装包不再自带这个 exe，第一次用「抢会议室」时由
// core/company-assistant/room-runtime-download.js 按签名清单现下。这个脚本只留给
// e2e（真实 exe 走本地那条路）和离线自测，不再挂在打包钩子上。
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { manifest, verified } = require('../room-component');

function stageRuntime({ appDir = path.resolve(__dirname, '..', '..', '..'), source = process.env.AI_HUB_ROOM_RUNTIME_SOURCE } = {}) {
  const bundle = path.join(appDir, 'core', 'company-assistant', 'room-component');
  const baseline = manifest(path.join(bundle, 'baseline.json'));
  const dest = path.join(bundle, 'runtime', baseline.exe.file);
  if (verified(dest, baseline.exe)) return { file: dest, bytes: baseline.exe.size, sha256: baseline.exe.sha256, reused: true };
  if (fs.existsSync(dest)) throw new Error('会议室运行时校验失败，拒绝打包：' + dest);
  if (!source) throw new Error('请把 AI_HUB_ROOM_RUNTIME_SOURCE（或 --source）指向官方 ' + baseline.exe.file + '；v3.1.3 起安装包不再自带运行时，这里只用于 e2e 与离线自测。');
  if (!verified(path.resolve(source), baseline.exe)) throw new Error('AI_HUB_ROOM_RUNTIME_SOURCE 与签名清单不符，拒绝打包');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = dest + '.' + randomUUID() + '.tmp';
  try {
    fs.copyFileSync(path.resolve(source), temp);
    if (!verified(temp, baseline.exe)) throw new Error('会议室运行时暂存校验失败');
    fs.renameSync(temp, dest);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return { file: dest, bytes: baseline.exe.size, sha256: baseline.exe.sha256, reused: false };
}
module.exports = async context => {
  const result = stageRuntime({ appDir: context.packager?.info?.appDir || context.appDir });
  console.log('[company-room-runtime] verified ' + result.bytes + ' bytes; sha256=' + result.sha256);
};
module.exports.stageRuntime = stageRuntime;
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--source')) throw new Error('用法：node core/company-assistant/room-component/build-runtime.js [--source <官方 exe>]');
    console.log(JSON.stringify(stageRuntime({ source: args[1] || process.env.AI_HUB_ROOM_RUNTIME_SOURCE })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
