'use strict';
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');
const EXTERNAL_SITES = Object.freeze({
  github: { name: 'GitHub', url: 'https://github.com/login' },
  githubDevice: { name: 'GitHub 授权', url: 'https://github.com/login/device' },
});
const RESEARCH_SITES = Object.freeze([]);
function externalSite(id) {
  if (!Object.hasOwn(EXTERNAL_SITES, id)) throw Error('外部服务标识无效');
  return EXTERNAL_SITES[id];
}
// message 只给投研站点（Hub 自己写的固定提示）；GitHub 等由外部工具产生的文字一律不外露。
function publicStatus(value, source = 'GitHub CLI', withMessage = false) {
  if (!value || !['signed_in', 'signed_out', 'unknown'].includes(value.state)) return null;
  return { state: value.state, account: typeof value.account === 'string' && /^[\w-]{1,39}$/.test(value.account) ? value.account : '',
    source, checkedAt: Number.isFinite(value.checkedAt) ? value.checkedAt : 0,
    ...(withMessage && typeof value.message === 'string' ? { message: value.message.slice(0, 120) } : {}) };
}
function readExternalState(root) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(root, 'external-accounts.json'), 'utf8'));
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw Error('invalid');
    const out = { github: publicStatus(d.github) };
    for (const key of RESEARCH_SITES) out[key] = publicStatus(d[key], 'Hub 专属 Chrome', true);
    return out;
  }
  catch (e) { if (e.code === 'ENOENT') return {}; throw Error('外部账号检查记录无法读取，未覆盖原文件'); }
}
function writeExternalState(root, service, result) {
  const data = readExternalState(root); data[service] = result;
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'external-accounts.json'), temp = file + '.' + require('crypto').randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data), 'utf8'); fs.renameSync(temp, file);
}
function githubCommand(env) {
  const installed = path.join(env.PROGRAMFILES || 'C:/Program Files', 'GitHub CLI', 'gh.exe');
  return fs.existsSync(installed) ? installed : 'gh';
}
function githubStatus(env = process.env, run = execFile) {
  return new Promise(resolve => {
    run(githubCommand(env), ['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'],
      { env, windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
        const unknown = message => resolve({ state: 'unknown', message, source: 'GitHub CLI', checkedAt: Date.now() });
        if (error) return unknown(error.code === 'ENOENT' ? '未找到 GitHub CLI，请先安装后再授权' : 'GitHub 授权检查未完成，请检查连接后重试');
        try {
          // --json can exit zero for failed authentication. Inspect the native state.
          const data = JSON.parse(stdout), rows = data.hosts?.['github.com'];
          if (!Array.isArray(rows)) return unknown('GitHub CLI 返回格式无法确认');
          const active = rows.find(r => r.active && r.state === 'success' && typeof r.login === 'string' && /^[\w-]{1,39}$/.test(r.login));
          resolve(active ? { state: 'signed_in', account: active.login, message: 'GitHub CLI 已确认授权；网页登录单独保留', source: 'GitHub CLI', checkedAt: Date.now() }
            : { state: rows.length ? 'unknown' : 'signed_out', message: rows.length ? 'GitHub CLI 未确认有效授权，请检查原工具或重新授权' : 'GitHub CLI 尚未授权', source: 'GitHub CLI', checkedAt: Date.now() });
        } catch { unknown('GitHub CLI 返回内容无法确认'); }
      });
  });
}
module.exports = { EXTERNAL_SITES, RESEARCH_SITES, externalSite, readExternalState, writeExternalState, githubStatus, githubCommand };
