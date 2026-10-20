'use strict';
// 会话栏的账号字母（2026-10-20 用户：公司 Hub 不再用「池」标号池会话，个人号和号池号统一显示账号首个英文字母，如 l / f / s / w）。
// 字母取登录凭证里的工号（core/codeagent-pool.js readCredentials 的 accountId）——号主看工号首字母就认得是谁的号；
// 只回字母和代称（个人 / 号 N，core/codeagent-quota.js aliasMap，和通道、号表同一套），工号全文不出主进程。
const fs = require('fs');

// 工号里第一个英文字母，小写；没有字母返回空（界面就不显示徽标）。
function accountInitial(accountId) {
  const m = String(accountId || '').match(/[A-Za-z]/);
  return m ? m[0].toLowerCase() : '';
}

// { personal: { initial, alias }, accounts: { [号池编号]: { initial, alias, note } } }
function accountBadges({ dataDir, personalDir, fsModule = fs } = {}) {
  const pool = require('./codeagent-pool');
  const personal = personalDir ? pool.readCredentials(personalDir, fsModule) : { present: false };
  const out = { personal: { initial: accountInitial(personal.accountId), alias: '个人' }, accounts: {} };
  if (!dataDir) return out;
  let aliases = new Map();
  try { aliases = require('./codeagent-quota').aliasMap(dataDir); } catch { aliases = new Map(); }
  for (const a of pool.readRegistry(dataDir).accounts) {
    let creds = { present: false };
    try { creds = pool.readCredentials(pool.accountDir(dataDir, a.id), fsModule); } catch { /* 编号无效就当没登录 */ }
    out.accounts[a.id] = { initial: accountInitial(creds.accountId), alias: aliases.get(a.id) || '号池', note: a.note || '' };
  }
  return out;
}

module.exports = { accountInitial, accountBadges };
