'use strict';
const { resolveCommand, cliEnv } = require('../../core/antigravity-config');
const { run } = require('../../core/account-adapters');

function parseUsage(payload, observedAt) {
  if (payload?.status !== 'SUCCESS' || payload.num_turns !== 0 || payload.command?.name !== 'usage') throw Error('Antigravity 未返回有效的只读用量结果');
  const groups = (payload.command.data?.groups || []).map(group => {
    const windows = {};
    for (const bucket of group.buckets || []) {
      const fraction = bucket.remaining_fraction;
      if (!['weekly','5h'].includes(bucket.window) || typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      windows[bucket.window === 'weekly' ? 'usage7d' : 'usage5h'] = { pct: (1-fraction)*100, resetsAt: bucket.reset_time || null, observedAt };
    }
    const id = group.buckets?.some(b => String(b.id || '').startsWith('gemini-')) ? 'gemini' : group.buckets?.some(b => String(b.id || '').startsWith('3p-')) ? 'thirdParty' : group.name;
    return { id, label: group.name, ...windows };
  }).filter(g => g.usage5h || g.usage7d);
  if (!groups.length) throw Error('Antigravity 返回的额度窗口为空');
  const tightest = key => groups.map(g=>g[key]).filter(Boolean).sort((a,b)=>b.pct-a.pct)[0] || null;
  return { groups, usage5h: tightest('usage5h'), usage7d: tightest('usage7d'), observedAt, source: 'antigravity-cli' };
}
function createAntigravityUsage({ env = process.env, runImpl = run, now = Date.now, ttlMs = 300000 } = {}) {
  let cached = null, inflight = null, lastAttempt = -Infinity;
  async function query(name) {
    const childEnv = cliEnv(env);
    const result = await runImpl(resolveCommand(childEnv), ['--output-format','json','-p','/'+name], childEnv, 30000);
    if (result.code !== 0) throw Error('Antigravity 用量查询失败，请确认官方 CLI 已登录且网络可用');
    let payload;
    try { payload = JSON.parse(result.stdout); } catch { throw Error('Antigravity 用量结果不是有效 JSON'); }
    if (payload?.status !== 'SUCCESS' || payload.num_turns !== 0 || payload.command?.name !== name) throw Error('Antigravity 未返回有效的只读查询结果');
    return payload;
  }
  function refresh(force = false) {
    if (env.CLAUDE_HUB_HOME_DIR && !env.AI_HUB_ANTIGRAVITY_COMMAND) return Promise.reject(Error('隔离 Hub 未配置 Antigravity 用量夹具'));
    if (inflight) return inflight;
    if (!force && now()-lastAttempt < ttlMs) return Promise.resolve(cached);
    lastAttempt = now();
    inflight = Promise.allSettled([query('usage'), query('credits')]).then(([usage, credits]) => {
      let next;
      try {
        if (usage.status === 'rejected') throw usage.reason;
        next = parseUsage(usage.value, now());
      } catch (error) {
        next = { ...cached, error: error.message, attemptedAt: now() };
      }
      const value = credits.status === 'fulfilled' ? credits.value.command.data?.remaining_credits : undefined;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        next.credits = value; next.creditsObservedAt = now(); delete next.creditsError;
      } else {
        next.credits = cached?.credits ?? null; next.creditsObservedAt = cached?.creditsObservedAt || 0;
        next.creditsError = 'credits 余额未刷新' + (next.creditsObservedAt ? '，保留旧值' : '');
      }
      cached = next; return next;
    }).finally(() => { inflight = null; });
    return inflight;
  }
  return { refresh };
}
module.exports = { createAntigravityUsage, parseUsage };
