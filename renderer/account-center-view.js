'use strict';
// Presentation only. The page shows each identity of the Hub Chrome (a cookie jar — one per
// account that needs its own login on the same site), the sites logged in there, and the
// command-line tools authorised from those logins. Nothing here decides anything.

// tone: ok = logged in, warn = needs you, idle = cannot tell right now.
function siteChip(site, now = Date.now(), running = false) {
  if (site.stale) return { tone: 'idle', text: `${site.name} · 上次${site.state === 'signed_in' ? '已登录' : '未确认'}`, action: '' };
  switch (site.state) {
    case 'signed_in':
      return { tone: 'ok', text: `${site.name} · 已确认`, action: '' };
    case 'cookie_present': return { tone: 'idle', text: `${site.name} · 有登录记录`, action: '' };
    case 'signed_out': return { tone: 'warn', text: `${site.name} · 需登录`, action: 'login' };
    case 'needs_attention': return { tone: 'warn', text: `${site.name} · 需人机验证`, action: 'login' };
    case 'login_open': return { tone: 'idle', text: `${site.name} · 登录窗口开着`, action: '' };
    case 'needs_browser': return { tone: 'idle', text: `${site.name} · 待检查`, action: 'check' };
    default: return { tone: 'idle', text: `${site.name} · 未确认`, action: 'check' };
  }
}
const CLI_STATE = { authorized: ' · 已配置', missing: ' · 未授权', expired: ' · 需重新授权', unreadable: ' · 凭据不可读', invalid: ' · 凭据格式错误，需重新授权', api_key: ' · 使用 API Key' };
function cliChip(cli) {
  const name = cli.kind === 'codex' ? `${cli.name}（${cli.label}）` : cli.name;
  const tone = cli.state === 'authorized' || cli.state === 'api_key' ? 'idle' : 'warn';
  return { tone, text: name + (CLI_STATE[cli.state] ?? ''), title: cli.account || '' };
}
function identityCards(state, now = Date.now()) {
  return (state.identities || []).map(identity => {
    const sites = identity.sites.map(s => ({ key: s.key, ...siteChip(s, now, !!state.chrome?.running) }));
    const clis = (state.clis || []).filter(c => c.identity === identity.id).map(c => ({ id: c.id, ...cliChip(c) }));
    return { id: identity.id, label: identity.label, account: identity.account || '', accountStale: !!identity.accountStale, sites, clis,
      attention: sites.filter(s => s.tone === 'warn').length + clis.filter(c => c.tone === 'warn').length };
  });
}
// Tools whose web login could not be placed yet (e.g. before the first check has learned
// which ChatGPT account each identity holds). Listed, never silently attached to one.
function unplacedClis(state) {
  return (state.clis || []).filter(c => !c.identity).map(c => ({ id: c.id, ...cliChip(c) }));
}
function attentionCount(state, now = Date.now()) {
  return identityCards(state, now).reduce((n, c) => n + c.attention, 0) + unplacedClis(state).filter(c => c.tone === 'warn').length;
}
function companyCards(state) {
  return require('../core/hub-account-catalog').COMPANIES.map((company, index) => ({
    ...company, shortcut: index + 1,
    accounts: (state.identities || []).flatMap(identity => {
      const site = identity.sites.find(s => s.key === company.site);
      if (!site) return [];
      const pending = state.progress?.status === 'running' && state.progress.items.find(i => i.identity === identity.id && i.site === company.site);
      const restricted = site.reason === 'headless_challenge';
      let status = restricted ? '后台检查受网站验证限制' : site.stale ? '上次' + (site.state === 'signed_in' ? '已登录' : '检查未确认') : ({ signed_in: '已登录', signed_out: '需要登录', needs_attention: '需要你完成验证', cookie_present: '有登录记录', login_open: '网页窗口使用中', needs_browser: '待检查' }[site.state] || '未确认');
      if (pending?.state === 'queued') status = '等待检查';
      if (pending?.state === 'checking') status = '检查中…';
      const account = site.account || (company.site === 'chatgpt' ? identity.account : '') || '账号待确认';
      const accountStale = !!site.account ? !!site.stale : company.site === 'chatgpt' && !!identity.account && !!identity.accountStale;
      return [{ ...site, identity: identity.id, account, accountStale, restricted, label: identity.id === 'main' ? '账号 1' : '账号 2', status,
        preferred: (state.preferences?.sites?.[company.site]?.preferred || 'main') === identity.id,
        tone: pending?.state === 'checking' ? 'checking' : pending?.state === 'queued' || site.stale ? 'idle' : site.state === 'signed_in' ? 'ok' : ['signed_out', 'needs_attention'].includes(site.state) ? 'warn' : 'idle' }];
    }),
    clis: (state.clis || []).filter(cli => cli.site === company.site).map(cli => ({ ...cli, ...cliChip(cli) })),
  }));
}
module.exports = { siteChip, cliChip, identityCards, unplacedClis, attentionCount, companyCards };
