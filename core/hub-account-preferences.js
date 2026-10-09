'use strict';
const fs = require('fs'), path = require('path');
const { COMPANIES, companyFor } = require('./hub-account-catalog');
function readPreferences(root) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(path.join(root, 'accounts.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw Error('账号设置无法读取，请保留原文件并检查 accounts.json'); }
  const sites = {};
  for (const { site } of COMPANIES) {
    const value = saved?.sites?.[site];
    const secondary = value?.secondary === true || site === 'chatgpt';
    sites[site] = { secondary, preferred: secondary && value?.preferred === 'alt' ? 'alt' : 'main' };
  }
  return { version: 1, sites };
}
function updatePreferences(root, { site, identity, add = false }) {
  if (!companyFor(site) || !['main', 'alt'].includes(identity)) throw Error('账号或公司无效');
  const value = readPreferences(root);
  if (add) value.sites[site].secondary = true;
  else {
    if (identity === 'alt' && !value.sites[site].secondary) throw Error('请先添加第二个账号');
    value.sites[site].preferred = identity;
  }
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'accounts.json'), temp = file + '.' + require('crypto').randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8'); fs.renameSync(temp, file);
  return value;
}
module.exports = { readPreferences, updatePreferences };
