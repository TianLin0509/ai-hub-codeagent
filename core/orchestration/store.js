'use strict';
// 账本落盘：task-docs/<群>/orchestration/ledger.json（权威）+ ledger.md（给人和编排员读）。
const fs = require('node:fs');
const path = require('node:path');
const Ledger = require('./ledger');

const SAFE = /^[a-zA-Z0-9_-]{1,255}$/;
function directory(dataDir, meetingId) {
  if (!SAFE.test(String(meetingId))) throw new Error('群聊编号无效');
  return path.join(dataDir, 'task-docs', String(meetingId), 'orchestration');
}
function files(dataDir, meetingId) {
  const dir = directory(dataDir, meetingId);
  return { dir, json: path.join(dir, 'ledger.json'), md: path.join(dir, 'ledger.md') };
}
function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function load(dataDir, meetingId) {
  try {
    const data = JSON.parse(fs.readFileSync(files(dataDir, meetingId).json, 'utf8'));
    return data && data.version === 1 && data.meetingId === meetingId ? data : null;
  } catch { return null; }
}
function save(dataDir, ledger, now = Date.now()) {
  const f = files(dataDir, ledger.meetingId);
  fs.mkdirSync(f.dir, { recursive: true });
  ledger.updatedAt = now;
  atomicWrite(f.json, JSON.stringify(ledger, null, 2));
  try { atomicWrite(f.md, Ledger.renderMarkdown(ledger)); } catch { /* 展示文件失败不影响权威 JSON */ }
  return f;
}
module.exports = { directory, files, load, save };
