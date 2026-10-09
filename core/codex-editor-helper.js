'use strict';

// Invoked by the *native Codex external editor*. This writes the editor buffer,
// not a path for the model to read. A manual Ctrl+G delegates to the user's editor.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { atomicJson, readJson, hash } = require('./codex-editor-input');

async function run(directory, target, env = process.env) {
  const session = readJson(path.join(directory, 'session.json'));
  if (!session) throw new Error('Codex editor session is no longer available');
  if (readJson(path.join(directory, 'cancelled.json'))) throw new Error('长文本交接已取消，请重开会话');
  const pending = path.join(directory, 'request.json'), active = path.join(directory, 'active.json');
  let request;
  let claimed = false;
  try { fs.renameSync(pending, active); claimed = true; request = readJson(active); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (claimed && !request) throw new Error('长文本交接已取消');
  if (!request) {
    if (fs.existsSync(active)) throw new Error('已有长文本交接正在进行');
    const command = session.visual || session.editor;
    if (!command) throw new Error('请设置 VISUAL 或 EDITOR 后使用 Ctrl+G');
    const delegatedEnv = { ...env, HUB_CODEX_EDITOR_TARGET: target };
    for (const [key, value] of Object.entries({ VISUAL: session.visual, EDITOR: session.editor, ELECTRON_RUN_AS_NODE: session.runAsNode })) {
      if (value === undefined) delete delegatedEnv[key]; else delegatedEnv[key] = value;
    }
    await new Promise((resolve, reject) => {
      const child = spawn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + command + ' "%HUB_CODEX_EDITOR_TARGET%""'], {
        env: delegatedEnv, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true,
      });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('原编辑器退出码：' + code)));
    });
    return;
  }
  const receipt = path.join(directory, 'receipt.json');
  try {
    if (Date.now() >= request.expiresAt || readJson(path.join(directory, 'cancelled.json'))) throw new Error('长文本交接已过期或取消');
    if (typeof request.text !== 'string' || hash(request.text) !== request.digest) throw new Error('长文本交接内容校验失败');
    if (!target || !fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new Error('原生编辑器临时文件无效');
    const previous = fs.readFileSync(target, 'utf8');
    if (/\[Image #\d+\]/.test(previous)) throw new Error('CLI 输入框已有图片，请先在 CLI 中处理该草稿');
    fs.writeFileSync(target, request.text, 'utf8');
    const digest = hash(fs.readFileSync(target, 'utf8'));
    if (digest !== request.digest) throw new Error('原生编辑器写回校验失败');
    atomicJson(receipt, { id: request.id, ok: true, digest });
  } catch (error) {
    atomicJson(receipt, { id: request.id, ok: false, message: error.message });
    throw error;
  } finally {
    try { fs.unlinkSync(active); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
if (require.main === module) run(process.argv[2], process.argv[3]).catch(error => {
  console.error('[codex-editor-input]', error.message); process.exitCode = 1;
});
module.exports = { run };
