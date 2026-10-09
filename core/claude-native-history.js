'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function findNativeClaudeHistory(sessionId, { cwd, env = process.env } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('Invalid Claude session identity');
  const config = env.CLAUDE_CONFIG_DIR || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude');
  const projects = path.join(config, 'projects');
  const slug = path.resolve(cwd || process.cwd()).replace(/[^A-Za-z0-9]/g, '-');
  const local = path.join(projects, slug, sessionId + '.jsonl');
  if (fs.existsSync(local)) return local;
  let entries;
  try { entries = fs.readdirSync(projects, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(projects, entry.name, sessionId + '.jsonl');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

// Same metadata contract as the official SDK's session_mutations.rename_session:
// https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/session_mutations.py
// Append to an existing history only; never create a metadata-only fake session.
function renameNativeClaudeHistory(sessionId, title, options) {
  const clean = typeof title === 'string' ? title.trim() : '';
  if (!clean || clean.includes('\0')) throw new Error('Claude 会话名称不能为空');
  const file = findNativeClaudeHistory(sessionId, options);
  if (!file) return { status: 'deferred' };
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'deferred' }; throw error; }
  try {
    if (!fs.fstatSync(fd).size) return { status: 'deferred' };
    const data = Buffer.from(JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId }) + '\n', 'utf8');
    if (fs.writeSync(fd, data) !== data.length) throw new Error('Claude 历史名称写入不完整');
    fs.fsyncSync(fd);
    return { status: 'synced' };
  } finally { fs.closeSync(fd); }
}

module.exports = { findNativeClaudeHistory, processExists, renameNativeClaudeHistory };
