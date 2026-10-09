'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const cache = new Map();
async function textOrMissing(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function refFingerprint(workspace, target) {
  let dir = path.resolve(workspace, '.git');
  if (!(await fs.stat(dir)).isDirectory()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dir, 'utf8'));
    if (!pointer) throw Error('Git directory pointer is invalid');
    dir = path.resolve(workspace, pointer[1].trim());
  }
  const common = (await textOrMissing(path.join(dir, 'commondir'))).trim();
  const root = common ? path.resolve(dir, common) : dir;
  let ref = target, value;
  for (let depth = 0; depth < 8; depth++) {
    if (!/^refs\/[A-Za-z0-9_./-]+$/.test(ref) || ref.includes('..')) throw Error('Git ref is invalid');
    value = (await textOrMissing(path.join(root, ref))).trim();
    if (!value) value = (await textOrMissing(path.join(root, 'packed-refs'))).split(/\r?\n/)
      .find(line => line.endsWith(' ' + ref))?.split(' ')[0];
    if (value?.startsWith('ref: ')) { ref = value.slice(5).trim(); continue; }
    if (!/^[a-f0-9]{40,64}$/.test(value || '')) throw Error('Git target ref is unavailable');
    return JSON.stringify([root, value, await textOrMissing(path.join(root, 'shallow'))]);
  }
  throw Error('Git symbolic ref cycle');
}
async function verifyMerge(workspace, merge, { run = exec, now = Date.now } = {}) {
  // Resolve loose/packed refs directly: an unchanged completed task needs no
  // child process. Unsupported repository layouts still use Git as authority.
  let fingerprint = null;
  try { fingerprint = await refFingerprint(workspace, merge.target); } catch {}
  const key = JSON.stringify([path.resolve(workspace), merge, fingerprint]);
  const previous = fingerprint && cache.get(key);
  if (previous && now() - previous < 5 * 60_000) return true;
  const options = { cwd: workspace, windowsHide: true, timeout: 4000, maxBuffer: 16384 };
  await run('git', ['merge-base', '--is-ancestor', merge.candidate, merge.commit], options);
  await run('git', ['merge-base', '--is-ancestor', merge.commit, merge.target], options);
  if (fingerprint) {
    if (await refFingerprint(workspace, merge.target) !== fingerprint) throw Error('Git target changed during verification');
    cache.set(key, now());
    while (cache.size > 256) cache.delete(cache.keys().next().value);
  }
  return true;
}
module.exports = { verifyMerge, refFingerprint };
