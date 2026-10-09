// core/hub-control.js
// 2026-05-16 maintainer：per-PID 控制文件 + CDP 端口探测 + stale 清理
//   控制文件：<dataDir>/control/<pid>.json，含 hookPort/cdpPort/token/dataDir/pid/startedAt
//   救援脚本（tools/hub-escape.ps1）通过这个文件发现目标 Hub 的端口和 token
//
// Hub control file used by local escape/recovery helpers.

const fs = require('fs');
const path = require('path');

function controlDir(dataDir) {
  return path.join(dataDir, 'control');
}

function controlFilePath(dataDir, pid) {
  return path.join(controlDir(dataDir), `${pid}.json`);
}

function writeControlFile({ pid, hookPort, cdpPort, token, dataDir, startedAt, nativeOwnershipVersion }) {
  const dir = controlDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = controlFilePath(dataDir, pid);
  const tmp = file + '.tmp';
  const data = JSON.stringify({ pid, hookPort, cdpPort, token, dataDir, startedAt, nativeOwnershipVersion }, null, 2);
  // 写 temp + rename 原子化，避免救援脚本读到半写文件
  fs.writeFileSync(tmp, data, { encoding: 'utf8' });
  fs.renameSync(tmp, file);
  return file;
}

async function readDevToolsActivePort(userDataDir, { timeoutMs = 3000, pollMs = 100 } = {}) {
  // Chromium 启动后会把 --remote-debugging-port=0 实际分配到的端口写到此文件第一行
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      const firstLine = txt.split('\n')[0].trim();
      const port = parseInt(firstLine, 10);
      if (!isNaN(port) && port > 0) return port;
    } catch { /* 文件还没生成，继续轮询 */ }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return null;
}

function _isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但无权限 signal（也算活）；ESRCH = 进程不存在
    return e.code === 'EPERM';
  }
}

function cleanStale(dataDir, { youngFileGraceMs = 5000 } = {}) {
  const dir = controlDir(dataDir);
  const removed = [];
  if (!fs.existsSync(dir)) return removed;
  const now = Date.now();
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { console.warn('[hub-control] cleanStale readdir failed:', e.message); return removed; }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      // race condition 缓解：刚启动的 Hub 可能还没把 PID 写到文件就被另一个 Hub 当死的清掉
      if (now - stat.mtimeMs < youngFileGraceMs) continue;
      const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!_isPidAlive(obj.pid)) {
        fs.unlinkSync(filePath);
        removed.push(obj.pid);
      }
    } catch (e) {
      console.warn(`[hub-control] cleanStale skip ${name}:`, e.message);
    }
  }
  return removed;
}

function unlinkSelf(dataDir, pid) {
  const file = controlFilePath(dataDir, pid);
  try { fs.unlinkSync(file); }
  catch (e) {
    if (e.code !== 'ENOENT') console.warn('[hub-control] unlinkSelf failed:', e.message);
  }
}

module.exports = {
  controlDir,
  controlFilePath,
  writeControlFile,
  readDevToolsActivePort,
  cleanStale,
  unlinkSelf,
  _isPidAlive,
};
