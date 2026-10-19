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

// 个人账号此刻启动会用的模型（只用于判定和显示，不改写它的 settings.json）：规则见 codeagent-pool.js personalDefaultModel。
// 2.1.11 要求「settings.json 写了模型且在菜单里」才算已知，没写或写分档名 GLM-5.2-WX 时个人账号整个从模型表消失（用户 2026-10-18 反馈）。
// written：settings.json 里实际写的 model（原样，可能为空）；configMismatch：默认模型和权限不符（2026-10-19 公司真机：
// 个人账号 settings.json 写了没权限的 deepseek-v4-flash-0731，每个会话一开就报「模型 … 不存在或配置有误」）——
// 纠正后的默认模型为空、而权限清单只有一个模型时标出来（这时「该改成什么」是确定的），带上写的值，号表和直查据此提示。
// 只判定和显示，不改写 settings.json（修正只走经授权的远程维护 set-personal-model，见 codeagent-personal-model.js）。
function personalModels({ dataDir, personalDir, fsModule = fs }) {
  if (!personalDir) return { models: [], defaultModel: '', written: '', configMismatch: null };
  const known = pool.accountModels(personalDir, fsModule, dataDir ? pool.personalModelsFile(dataDir) : null);
  const written = pool.readSettingsModel(personalDir, fsModule);
  const defaultModel = pool.personalDefaultModel(written, known);
  const models = (known.models || []).slice();
  // 收紧（审核 2026-10-19）：只有「写的值不在清单里（分档名按 -Auto 算在内）」且「这个号对写的值有还没清除的模型配置避让记录」
  // 才算不符——合法的内部别名（如 MiniMax-M2.7-CodeAgentCLI，CLI 实际按它跑）没报过错就不标红。清单只有一个模型时给出建议改成它。
  let configMismatch = null;
  if (written && !models.some(m => eq(m, written) || eq(m, written + '-Auto'))) {
    let record = null;
    try { record = dataDir ? (require('./codeagent-quota').modelAvoidAll(dataDir, fsModule).personal || {})[String(written).toLowerCase()] || null : null; } catch { record = null; }
    if (record) configMismatch = { written, models: models.slice(), suggest: models.length === 1 ? models[0] : '' };
  }
  if (defaultModel && !models.some(m => eq(m, defaultModel))) models.push(defaultModel);
  return { models, defaultModel, written, configMismatch, authoritative: !!known.authoritative, probedAt: known.probedAt || null };
}
// 号表、直查里的一句话（模型名不涉及隐私，原样写）。
function describeMismatch(m) {
  if (!m) return '';
  return `默认模型和权限不符：settings.json 里${m.written ? `写的是 ${m.written}` : '没写模型'}，权限只有 ${(m.models || []).join('、')}`;
}

// 个人账号的进行中会话数（activeSessions）包含号主自己手动开的、助理和论坛的会话（main.js routeAccounts）：
// 号主自己忙的时候它少接通道的活。
// configModel：不指定模型开会话时它实际会请求的模型（settings.json 写了就是写的那个，哪怕没权限）——模型配置避让按它判断。
function personalAccount({ dataDir, personalDir, activeSessions = 0, now = Date.now(), fsModule = fs }) {
  if (!personalDir) return null;
  const creds = pool.readCredentials(personalDir, fsModule);
  if (pool.accountState(creds, now) !== 'ready') return null;
  const { models, defaultModel, written, configMismatch } = personalModels({ dataDir, personalDir, fsModule });
  return { key: 'personal', pool: false, models, defaultModel, configModel: written || defaultModel, activeSessions: Number(activeSessions) || 0,
    lastAssignedAt: dataDir ? pool.personalLastAssignedAt(dataDir, fsModule) : 0, ...(configMismatch ? { configMismatch } : {}) };
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
      const own = pool.effectiveModel(a.dir, fsModule);
      out.push({ key: a.id, pool: true, models: a.models || [], defaultModel: own, configModel: own,
        activeSessions: a.activeSessions || 0, lastAssignedAt: a.lastAssignedAt || 0, routeSwitched: !!a.routeSwitched });
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
function servableNow(accounts) { return listModels(accounts).filter(m => accounts.some(a => canServe(a, m) && !avoidFor(a, m))); }
function canonicalModel(accounts, model) { return listModels(accounts).find(m => eq(m, model)) || ''; }

// 挑号。working：各号上通道正在处理的问题数（键 personal / 号池编号）；cap：每号同时处理的上限。
// 返回 { ok, account, model, switchModel } 或 { ok:false, reason }：
//   none   = 没有哪个号能跑这个模型（不开会话，回家里写明可选模型）；
//   switch = 能跑它的号池号都在跑别的模型的会话（排队等它们空出来，最多等一阵，见 company.js）；
//   busy   = 能用的号都到了每号上限（排队）。
// 同等条件下：进行中会话少的优先，其次不用切模型的，再次号池优先（个人账号留给号主自己），最后按上次分配时间轮转。
// 额度感知（2026-10-18，core/codeagent-quota.js）：账号带 avoid（避让中：额度用完 / 限流 / 手动暂停）的不参与挑号；
// 能跑这个模型的号全在避让中 → { ok:false, reason:'avoid', until: 最早恢复时间 }（排队等恢复，回执写明，不硬派）。
// only：家里指定了号（键），只在它里面挑。
// 模型配置避让（2026-10-19）：账号带 modelAvoid（{ 模型小写 | '*': 记录 }，调用方只放此刻还在避让的）时，
// 只在「这个号请求的模型」命中时算避让。请求的模型：指定了就是指定的；不指定就是号的 configModel（配置里写的，哪怕没权限）。
const requestModel = (a, model) => String(model || (a && (a.configModel || a.defaultModel)) || '');
function modelAvoidOf(a, model) {
  if (!a || !a.modelAvoid) return null;
  return a.modelAvoid[String(requestModel(a, model)).toLowerCase() || '*'] || a.modelAvoid['*'] || null;
}
// 这个号请求这个模型时的避让记录：整号避让优先，其次模型配置避让。
function avoidFor(a, model = '') { return (a && a.avoid) || modelAvoidOf(a, model); }
const avoided = (a, model = '') => !!avoidFor(a, model);
const untilOf = e => (e ? (e.until != null ? e.until : e.kind === 'model-config' ? e.probeAt : null) : null);
function earliestUntil(list, model = '') {
  const times = list.map(a => untilOf(avoidFor(a, model))).filter(x => Number.isFinite(Number(x)) && x != null).map(Number);
  return times.length ? Math.min(...times) : null;
}
function pickRoute(accounts, model, { working = {}, cap = Infinity, only = '' } = {}) {
  const everyone = accounts.filter(a => canEverServe(a, model) && (!only || a.key === only));
  if (!everyone.length) return { ok: false, reason: 'none', model: '' };
  const canonical = canonicalModel(accounts, model);
  const all = everyone.filter(a => !avoided(a, canonical));
  if (!all.length) return { ok: false, reason: 'avoid', model: canonical, until: earliestUntil(everyone, canonical) };
  const ready = all.filter(a => canServe(a, canonical));
  if (!ready.length) return { ok: false, reason: 'switch', model: canonical };
  const free = ready.filter(a => (Number(working[a.key]) || 0) < cap);
  if (!free.length) return { ok: false, reason: 'busy', model: canonical };
  const needSwitch = a => (eq(a.defaultModel, canonical) ? 0 : 1);
  const account = free.slice().sort((x, y) => x.activeSessions - y.activeSessions || needSwitch(x) - needSwitch(y)
    || Number(!x.pool) - Number(!y.pool) || x.lastAssignedAt - y.lastAssignedAt)[0];
  return { ok: true, account, model: canonical, switchModel: needSwitch(account) === 1 };
}

// 不指定模型时挑号（2026-10-18 用户反馈 v2.1.11：通道只开号池的号、从不开他自己的个人账号）。
// 以前「号池有可用的号就开在号池，个人账号只在号池开会话失败时兜底」，并行上限却把个人账号算作 1 条通道。
// 现在候选是个人账号 + 号池里能用的号（routeAccounts 已筛过），个人账号不要求默认模型已知。挑法依次：
//   1. 每号上限：通道在这个号上处理的问题数没到上限的优先（都到了就不看上限，名额由通道整体上限管，dispatch 前已核过）；
//   2. 避开：为通道切过模型、上面还有会话的号池号（它此刻跑的不是原来的默认模型），清单未知的号池号（可能落到没权限的默认模型），
//      默认模型不确定的个人账号；只剩它们时照用；
//   3. 进行中会话最少（个人账号的会话数含号主自己开的、助理和论坛的会话，号主自己忙时它少接活）；
//   4. 上次分配时间早的优先（轮转；个人账号的时间另存，见 codeagent-pool.js markPersonalAssigned）；
//   5. 全部相同时号池优先（个人账号留给号主自己）。
// 返回 { ok, account } 或 { ok:false, reason:'none' }。
function pickAnyRoute(accounts, { working = {}, cap = Infinity, only = '' } = {}) {
  const everyone = (accounts || []).filter(a => a && a.key && (!only || a.key === only));
  if (!everyone.length) return { ok: false, reason: 'none' };
  // 避让中的号不挑；全都在避让中就排队等最早恢复的那个（额度感知，2026-10-18）。
  const all = everyone.filter(a => !avoided(a));
  if (!all.length) return { ok: false, reason: 'avoid', until: earliestUntil(everyone) };
  const free = all.filter(a => (Number(working[a.key]) || 0) < cap);
  const candidates = free.length ? free : all;
  // 个人账号默认模型不确定（personalDefaultModel 留空）时同样排到后面，仍可兜底（2026-10-18 独立审核）。
  const avoid = a => (a.pool ? ((a.routeSwitched && a.activeSessions > 0) || !(a.models || []).length) : !a.defaultModel) ? 1 : 0;
  const account = candidates.slice().sort((x, y) => avoid(x) - avoid(y)
    || (Number(x.activeSessions) || 0) - (Number(y.activeSessions) || 0)
    || (Number(x.lastAssignedAt) || 0) - (Number(y.lastAssignedAt) || 0)
    || Number(!x.pool) - Number(!y.pool))[0];
  return { ok: true, account };
}

// 发给家里的模型表：按模型聚合，只有模型名、号数、通道在处理几个、还能并行几个；不含账号名、工号、备注。
// 「几个号能用」只算真能派的号（个人账号只算它的默认模型）。parallel：通道整体 { cap, working }；cap 是每号上限（忙时 / 闲时）。
// 2026-10-18 额度感知：模型表升级为「号 + 模型」——另附每个号一行 accountRows（代称、模型、进行中会话、通道在处理几个、
// 避让状态与原因、预计恢复、Credit 剩余），家里据此可以自己选号（ask_company 的 account）。只有代称，不含编号、工号、备注。
// aliases：键 → 代称（个人 / 号 1…）；credit：键 → 最近一次 Credit 读数；describe：避让原因的说明文字（调用方已脱敏）。
function modelTable(accounts, { working = {}, cap = Infinity, peak = false, parallel = null, at = Date.now(), aliases = null, credit = {}, describe = null } = {}) {
  const globalFree = parallel ? Math.max(0, (Number(parallel.cap) || 0) - (Number(parallel.working) || 0)) : Infinity;
  const perCap = (a, model = '') => (avoided(a, model) ? 0 : Math.max(0, (Number.isFinite(cap) ? cap : 0) - (Number(working[a.key]) || 0)));
  const models = listModels(accounts).map(id => {
    const own = accounts.filter(a => canEverServe(a, id));
    const ready = own.filter(a => canServe(a, id));
    const free = ready.reduce((n, a) => n + perCap(a, id), 0);
    const busy = own.filter(a => eq(a.defaultModel, id)).reduce((n, a) => n + (Number(working[a.key]) || 0), 0);
    const avoidedCount = own.filter(a => avoided(a, id)).length;
    return { id, label: require('./codeagent-models').modelLabel(id), primary: isPrimary(id), accounts: own.length, working: busy, free: Math.min(free, globalFree),
      ...(avoidedCount ? { avoided: avoidedCount } : {}) };
  }).sort((a, b) => Number(b.primary) - Number(a.primary) || a.id.localeCompare(b.id));
  const table = { schema: 1, at, peak: !!peak, models, parallel: parallel ? { cap: Number(parallel.cap) || 0, working: Number(parallel.working) || 0 } : null };
  if (aliases) {
    table.accountRows = accounts.filter(a => aliases.get(a.key)).map(a => {
      const c = credit && credit[a.key];
      // 不指定模型时这个号会不会被避开（整号避让，或它配置里的模型在模型配置避让中）
      const av = avoidFor(a, '');
      return { alias: aliases.get(a.key), pool: !!a.pool, models: (a.models || []).filter(m => canEverServe(a, m)), defaultModel: a.defaultModel || '',
        activeSessions: Number(a.activeSessions) || 0, working: Number(working[a.key]) || 0, free: Math.min(perCap(a), globalFree),
        avoid: av ? { kind: av.kind || 'quota', source: av.source || 'error', since: av.since || null, until: untilOf(av) == null ? null : Number(untilOf(av)),
          reason: describe ? describe(av) : String(av.reason || '') } : null,
        ...(a.configMismatch ? { configNote: describeMismatch(a.configMismatch) } : {}),
        credit: c && Number.isFinite(Number(c.remaining)) ? { remaining: Number(c.remaining), pct: Number(c.pct), bucket: c.bucket || '', at: c.at || null } : null };
    }).sort((x, y) => Number(x.pool) - Number(y.pool) || x.alias.localeCompare(y.alias, 'zh'));
  }
  return table;
}

// 推送节流用的「明显变化」：模型集合、各模型号数、高峰与否、还能并行的档位（0 / 1 / 2 个以上）变了才算。
function tableSignature(table) {
  if (!table) return '';
  return JSON.stringify([table.peak, (table.models || []).map(m => [m.id.toLowerCase(), m.accounts, Math.min(2, m.free)])]);
}
// 避让状态的签名（哪些号在避让、到什么时候）：变了就尽快推给家里，不等 10 分钟节流（额度感知，2026-10-18）。
function avoidSignature(table) {
  if (!table || !Array.isArray(table.accountRows)) return '';
  return JSON.stringify(table.accountRows.filter(r => r.avoid || r.configNote).map(r => [r.alias, r.avoid && r.avoid.source, r.avoid && r.avoid.kind, r.avoid && r.avoid.until, r.configNote || '']));
}

module.exports = { routeAccounts, personalAccount, personalModels, describeMismatch, canServe, canEverServe, servableNow, pickRoute, pickAnyRoute, modelTable, tableSignature, avoidSignature, listModels, canonicalModel, isPrimary, hasModel, earliestUntil, avoidFor, requestModel };
