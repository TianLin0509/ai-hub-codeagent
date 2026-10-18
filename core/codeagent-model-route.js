'use strict';
// AI特战队通道按模型派活（2026-10-18 用户：「号池里两个号分别能用 GLM 和 DeepSeek……允许家里的 agent 自己判断起哪个账号的哪个模型」）。
//
// 公司一端：把个人账号和号池里能用的号汇总成「号 → 模型清单 / 此刻启动会用的模型 / 进行中会话数」，
// 据此 1）按模型聚合出发给家里的模型表（不含账号名、工号、备注）；2）家里指定模型时挑号。
//
// 怎么让会话用上指定模型（设计取舍见 docs/design/tezhan-model-route.md）：
//   - CodeAgent 交互模式不认 --model（2026-10-13 公司真机三轮排查），/model 菜单会把第一条消息卡住约 1 分钟（2026-10-15），
//     所以只走配置目录 settings.json 的 model（号池同步配置时写，2.1.8 起已用它纠正 DS 号的默认模型）；
//   - 号池的号由 Hub 管配置，可以切默认模型，但只在这个号上没有进行中的会话时切（避免影响正在跑的会话）；
//   - 个人账号是号主自己日常用的配置，不切：只有它此刻的默认模型就是指定模型时才用它。
const fs = require('fs');
const pool = require('./codeagent-pool');

const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const hasModel = (account, model) => (account.models || []).some(m => eq(m, model));
// 日常主力（2026-10-18 用户：大家平时优先用 GLM）：GLM 一族标主力，其余是分流用的模型。
const isPrimary = model => /^glm/i.test(String(model || ''));

function personalAccount({ dataDir, personalDir, activeSessions = 0, now = Date.now(), fsModule = fs }) {
  if (!personalDir) return null;
  const creds = pool.readCredentials(personalDir, fsModule);
  if (pool.accountState(creds, now) !== 'ready') return null;
  const known = pool.accountModels(personalDir, fsModule, pool.personalModelsFile(dataDir));
  // 此刻启动会用的模型：settings.json 写了就是它；没写时取菜单标的默认，清单只有一个时就是那一个；都不知道就留空（不拿它分流）。
  const own = pool.readSettingsModel(personalDir, fsModule);
  const defaultModel = own || known.defaultModel || (known.models.length === 1 ? known.models[0] : '');
  return { key: 'personal', pool: false, models: known.models || [], defaultModel, activeSessions: Number(activeSessions) || 0, lastAssignedAt: 0 };
}

// 能接通道会话的号：个人账号（登录有效）+ 号池里可用的号（登录有效、不与个人账号或别的号重复）。
function routeAccounts({ dataDir, personalDir = '', activeCounts = {}, personalActive = 0, usePool = true, now = Date.now(), fsModule = fs } = {}) {
  const out = [];
  const personal = personalAccount({ dataDir, personalDir, activeSessions: personalActive, now, fsModule });
  if (personal) out.push(personal);
  if (usePool) {
    const personalAccountId = personalDir ? pool.readCredentials(personalDir, fsModule).accountId : '';
    for (const a of pool.listAccounts(dataDir, { activeCounts, personalAccountId, now, fsModule })) {
      if (a.state !== 'ready' || a.sameAsPersonal || a.duplicateOf) continue;
      out.push({ key: a.id, pool: true, models: a.models || [], defaultModel: pool.effectiveModel(a.dir, fsModule),
        activeSessions: a.activeSessions || 0, lastAssignedAt: a.lastAssignedAt || 0 });
    }
  }
  return out;
}

// 这个号能不能用来跑该模型（审核 2026-10-18：个人账号不切默认模型，只算它此刻的默认；号池的号清单里有就算）。
// 不能的号不进模型表、不参与挑号，免得家里看到「能用」却永远派不出去。
function canEverServe(account, model) {
  if (!hasModel(account, model)) return false;
  return account.pool ? true : eq(account.defaultModel, model);
}
// 这个号现在能不能开一个用该模型的会话：默认模型就是它；或是号池的号、手上没有进行中的会话（可以切默认模型）。
function canServe(account, model) {
  if (!canEverServe(account, model)) return false;
  return eq(account.defaultModel, model) || (account.pool && account.activeSessions === 0);
}

// 能派的模型合集（第一次见到的写法为准）：个人账号只算它的默认模型。
function listModels(accounts) {
  const seen = new Map();
  for (const a of accounts) for (const m of a.models || []) if (canEverServe(a, m) && !seen.has(m.toLowerCase())) seen.set(m.toLowerCase(), m);
  return [...seen.values()];
}
// 此刻就能开会话的模型（有号的默认就是它，或有空闲的号池号可以切过去）：等不到切换时回执里告诉家里可以换哪个。
function servableNow(accounts) { return listModels(accounts).filter(m => accounts.some(a => canServe(a, m))); }
function canonicalModel(accounts, model) { return listModels(accounts).find(m => eq(m, model)) || ''; }

// 挑号。working：各号上通道正在处理的问题数（键 personal / 号池编号）；cap：每号同时处理的上限。
// 返回 { ok, account, model, switchModel } 或 { ok:false, reason }：
//   none   = 没有哪个号能跑这个模型（不开会话，回家里写明可选模型）；
//   switch = 能跑它的号池号都在跑别的模型的会话（排队等它们空出来，最多等一阵，见 company.js）；
//   busy   = 能用的号都到了每号上限（排队）。
// 同等条件下：进行中会话少的优先，其次不用切模型的，再次号池优先（个人账号留给号主自己），最后按上次分配时间轮转。
function pickRoute(accounts, model, { working = {}, cap = Infinity } = {}) {
  const all = accounts.filter(a => canEverServe(a, model));
  if (!all.length) return { ok: false, reason: 'none', model: '' };
  const canonical = canonicalModel(accounts, model);
  const ready = all.filter(a => canServe(a, canonical));
  if (!ready.length) return { ok: false, reason: 'switch', model: canonical };
  const free = ready.filter(a => (Number(working[a.key]) || 0) < cap);
  if (!free.length) return { ok: false, reason: 'busy', model: canonical };
  const needSwitch = a => (eq(a.defaultModel, canonical) ? 0 : 1);
  const account = free.slice().sort((x, y) => x.activeSessions - y.activeSessions || needSwitch(x) - needSwitch(y)
    || Number(!x.pool) - Number(!y.pool) || x.lastAssignedAt - y.lastAssignedAt)[0];
  return { ok: true, account, model: canonical, switchModel: needSwitch(account) === 1 };
}

// 发给家里的模型表：按模型聚合，只有模型名、号数、通道在处理几个、还能并行几个；不含账号名、工号、备注。
// 「几个号能用」只算真能派的号（个人账号只算它的默认模型）。parallel：通道整体 { cap, working }；cap 是每号上限（忙时 / 闲时）。
function modelTable(accounts, { working = {}, cap = Infinity, peak = false, parallel = null, at = Date.now() } = {}) {
  const globalFree = parallel ? Math.max(0, (Number(parallel.cap) || 0) - (Number(parallel.working) || 0)) : Infinity;
  const models = listModels(accounts).map(id => {
    const own = accounts.filter(a => canEverServe(a, id));
    const ready = own.filter(a => canServe(a, id));
    const free = ready.reduce((n, a) => n + Math.max(0, (Number.isFinite(cap) ? cap : 0) - (Number(working[a.key]) || 0)), 0);
    const busy = own.filter(a => eq(a.defaultModel, id)).reduce((n, a) => n + (Number(working[a.key]) || 0), 0);
    return { id, label: require('./codeagent-models').modelLabel(id), primary: isPrimary(id), accounts: own.length, working: busy, free: Math.min(free, globalFree) };
  }).sort((a, b) => Number(b.primary) - Number(a.primary) || a.id.localeCompare(b.id));
  return { schema: 1, at, peak: !!peak, models, parallel: parallel ? { cap: Number(parallel.cap) || 0, working: Number(parallel.working) || 0 } : null };
}

// 推送节流用的「明显变化」：模型集合、各模型号数、高峰与否、还能并行的档位（0 / 1 / 2 个以上）变了才算。
function tableSignature(table) {
  if (!table) return '';
  return JSON.stringify([table.peak, (table.models || []).map(m => [m.id.toLowerCase(), m.accounts, Math.min(2, m.free)])]);
}

module.exports = { routeAccounts, personalAccount, canServe, canEverServe, servableNow, pickRoute, modelTable, tableSignature, listModels, canonicalModel, isPrimary, hasModel };
