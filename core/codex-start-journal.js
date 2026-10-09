'use strict';
// A missing rollout or a null turn ID alone cannot prove that nothing was sent.
// This small journal is written synchronously before any turn-creating request.
const fs = require('fs'), path = require('path'), os = require('os');
const { createHash, randomUUID } = require('crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
function identity(options, threadId) {
  const home = path.resolve(options.env?.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const scope = hash(process.platform === 'win32' ? home.toLowerCase() : home);
  const dataDir = options.env?.CLAUDE_HUB_DATA_DIR || require('./data-dir').getHubDataDir();
  return { file:path.join(dataDir, 'codex-start-journal', scope, hash(String(threadId)) + '.json'),
    scope, threadId, hubId:options.id };
}
function read(options, threadId) {
  const id = identity(options, threadId);
  let data;
  try { data = JSON.parse(fs.readFileSync(id.file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Codex 启动凭证读取失败：' + error.message); }
  if (data.version !== 1 || data.scope !== id.scope || data.threadId !== threadId || data.hubId !== id.hubId
      || typeof data.submissionAttempted !== 'boolean') throw new Error('Codex 启动凭证身份不匹配');
  return data;
}
function write(options, threadId, submissionAttempted, extra = {}) {
  const id = identity(options, threadId);
  const previous = read(options, threadId);
  const data = { version:1, scope:id.scope, threadId, hubId:id.hubId,
    submissionAttempted:submissionAttempted || previous?.submissionAttempted === true, at:Date.now(), ...extra };
  fs.mkdirSync(path.dirname(id.file), { recursive:true });
  const tmp = id.file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(data), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, id.file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return data;
}
function provesUnsubmitted(options, threadId) { return read(options, threadId)?.submissionAttempted === false; }
module.exports = { identity, read, write, provesUnsubmitted };
