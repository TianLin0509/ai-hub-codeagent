'use strict';
// 会话栏账号字母（2026-10-20 用户）：CodeAgent 会话标题前一个小写字母 = 会话所在账号的工号首字母，个人号和号池号一样；
// 悬停是代称（个人账号 / 号池 · 号 N），不写工号。字母与代称由主进程 codeagent-pool:badges 给出（core/codeagent-account-badge.js）。
const CODEAGENT_KIND = /^codeagent(?:-resume)?$/;

// 老会话记下的号池标签是「脱敏工号（备注）」，脱敏保留开头几位，号已移出号池时用它兜底。
function initialFromLabel(label) {
  const head = String(label || '').split('（')[0];
  const m = head.match(/[A-Za-z]/);
  return m ? m[0].toLowerCase() : '';
}

// 纯函数：会话 + 账号表 → { letter, title } 或 null（不是 CodeAgent 会话、或拿不到字母时不显示）。
function accountBadge(session, data) {
  if (!session || !CODEAGENT_KIND.test(String(session.kind || ''))) return null;
  const id = session.codeagentPoolAccount;
  if (id) {
    const a = (data && data.accounts && data.accounts[id]) || null;
    const letter = (a && a.initial) || initialFromLabel(session.codeagentPoolLabel);
    if (!letter) return null;
    return { letter, title: a && a.alias ? `号池 · ${a.alias}${a.note ? '（' + a.note + '）' : ''}` : '号池账号' };
  }
  const letter = data && data.personal && data.personal.initial;
  return letter ? { letter, title: '个人账号' } : null;
}

// 渲染层接线：第一次用到时取账号表，号池或个人账号登录变化（codeagent-pool:changed）后重取；取到后通知会话栏重画。
function createAccountBadges({ invoke, subscribe = null, onChange = () => {} } = {}) {
  let data = null;
  let loading = null;
  function load() {
    if (loading || typeof invoke !== 'function') return loading;
    loading = Promise.resolve().then(() => invoke('codeagent-pool:badges')).then(result => {
      const next = result && result.ok !== false ? { personal: result.personal || {}, accounts: result.accounts || {} } : { personal: {}, accounts: {} };
      const changed = JSON.stringify(next) !== JSON.stringify(data);
      data = next;
      if (changed) onChange();
    }).catch(() => { data = data || { personal: {}, accounts: {} }; }).finally(() => { loading = null; });
    return loading;
  }
  if (typeof subscribe === 'function') subscribe(change => { if (!(change && change.probing)) void load(); });
  return {
    badge(session) {
      if (!session || !CODEAGENT_KIND.test(String(session.kind || ''))) return null;
      if (!data) void load();
      return accountBadge(session, data);
    },
    load,
    data: () => data,
  };
}

module.exports = { accountBadge, initialFromLabel, createAccountBadges };
