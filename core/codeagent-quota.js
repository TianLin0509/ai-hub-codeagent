'use strict';
// CodeAgent 额度感知（2026-10-18 用户：「最好能识别出 API 用量到达上限了（我看到的是 codeagent 后台的报错），然后自动避让」）。
//
// 这里只放与界面、通道无关的部分，公司一端的通道（core/company-bridge/quota-watch.js）、号池页签（main/ipc/session-handlers.js）、
// 直查（core/company-bridge/diag.js）共用：
//   1. 识别规则：内置一组（必须来自真实样本，带原文 sample）+ 数据文件 <Hub 数据目录>/codeagent-pool/quota-rules.json（公司可自己加、可停用内置的）；
//   2. 避让状态：<Hub 数据目录>/codeagent-pool/quota-avoid.json，键是 personal / 号池编号，记原因、首次时间、预计恢复时间、来源；
//   3. 额度读数：各号最近一次在 Stats 面板读到的 Credit（同一个文件），用于「Credit ≤ 阈值也避让」和「Credit 恢复为正提前解除」；
//   4. 代称：个人 / 号 1 / 号 2（每个号固定一个序号、落盘、删号不复用，与直查 diag.js poolAliases 一致），家里只见代称。
// 新增输出匹配须真实样本（项目规则）：内置规则每条都写明样本出处；没有样本的格式不写进内置表。
const fs = require('fs');
const path = require('path');

const RULES_FILE = 'quota-rules.json';
const STATE_FILE = 'quota-avoid.json';
const DEFAULT_RETRY_MS = 60 * 60000;
const KINDS = { quota: '额度上限', 'rate-limit': '限流', balance: '余额不足' };
const SOURCES = { error: '报错', credit: 'Credit 读数', manual: '手动暂停' };
const MAX_SAMPLE = 300;

// ---- 内置规则 ----
// 每条：id、kind（quota / rate-limit / balance）、where（transcript：原生记录里的 API 错误消息；screen：终端屏幕）、
// pattern（正则源码，宽松处理全角半角标点与空格）、sample（真实样本原文）、origin（样本出处）。
// 样本 1（2026-10-18 用户转述，公司 Hub 会话卡片视图里看到的 CodeAgent 报错）：「API Error token消耗过快， 已达到4亿上限」。
//   标点和空格是转述的，精确原文待 2.1.12 上线后从直查 errors 段取回再核对（见 docs/design/quota-aware-route.md）。
//   卡片视图读原生记录，所以以原生记录为主、终端屏幕补充。没写重置时间：按默认 1 小时后再试，Credit 恢复为正时提前解除。
const BUILTIN_RULES = Object.freeze([
  Object.freeze({
    id: 'codeagent-token-cap-v1', kind: 'quota', where: ['transcript', 'screen'],
    pattern: 'API\\s*Error[\\s\\S]{0,120}?(?:token\\s*消耗\\s*过快|已\\s*达\\s*到\\s*[\\d.,，]+\\s*(?:亿|万|千)?\\s*(?:tokens?\\s*)?上\\s*限)',
    flags: 'i',
    sample: 'API Error token消耗过快， 已达到4亿上限',
    origin: '2026-10-18 用户转述（公司 Hub 会话卡片视图），精确原文待直查 errors 段核对',
  }),
]);

// 宽松识别「疑似 API 报错」：只用来收集样本（直查 errors 段），从不据此避让。
const SUSPECT = /(api\s*error|\berror\b|错误|失败|异常)[^\n]{0,160}?(\b429\b|\b402\b|quota|rate.?limit|too many requests|insufficient|exceed|credit|balance|\blimit\b|token|额度|配额|限流|余额|用量|上限|频率|过快)|(\b429\b|quota|rate.?limit|too many requests|insufficient_quota|额度|配额|限流|余额不足|用量)[^\n]{0,160}?(error|错误|失败|exceed|reached|用完|耗尽|不足|上限)/i;

function poolRoot(dataDir) { return path.join(dataDir, 'codeagent-pool'); }
function rulesFile(dataDir) { return path.join(poolRoot(dataDir), RULES_FILE); }
function stateFile(dataDir) { return path.join(poolRoot(dataDir), STATE_FILE); }

// 自定义规则的防护（审核 2026-10-18）：匹配前把文字截到 2000 字；拒绝嵌套量词（(a+)+、(\w*)* 这类会回溯爆炸的写法）；
// reset 正则限长；读出的恢复时间最多 24 小时后。
const MATCH_INPUT_CHARS = 2000;
const MAX_RESET_MS = 24 * 3600000;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}]\)\s*(?:[+*]|\{\d)/;
// 把一条规则编成可用的形式；不合格的返回 { error }。
function compileRule(raw, origin = 'file') {
  if (!raw || typeof raw !== 'object') return { error: '不是对象' };
  const id = String(raw.id || '').trim();
  if (!/^[A-Za-z0-9_.-]{2,60}$/.test(id)) return { error: `规则编号无效：${id || '（空）'}` };
  const kind = KINDS[raw.kind] ? raw.kind : 'quota';
  const where = (Array.isArray(raw.where) ? raw.where : raw.where ? [raw.where] : ['transcript', 'screen']).map(String).filter(w => w === 'transcript' || w === 'screen');
  if (!where.length) return { error: `${id}：where 只能是 transcript / screen` };
  const pattern = String(raw.pattern || '');
  if (!pattern || pattern.length > 600) return { error: `${id}：pattern 为空或太长` };
  if (origin !== 'builtin' && NESTED_QUANTIFIER.test(pattern)) return { error: `${id}：pattern 里有嵌套量词（如 (a+)+），可能卡死匹配，没用` };
  if (raw.reset && raw.reset.pattern && (String(raw.reset.pattern).length > 300 || NESTED_QUANTIFIER.test(String(raw.reset.pattern)))) return { error: `${id}：reset 正则太长或有嵌套量词，没用` };
  let re;
  try { re = new RegExp(pattern, String(raw.flags || 'i').replace(/[^imsu]/g, '')); } catch (error) { return { error: `${id}：正则写错了（${error.message}）` }; }
  let reset = null;
  if (raw.reset && typeof raw.reset === 'object' && raw.reset.pattern) {
    try { reset = { re: new RegExp(String(raw.reset.pattern), 'i'), type: ['clock', 'datetime', 'epoch', 'duration'].includes(raw.reset.type) ? raw.reset.type : 'duration' }; }
    catch (error) { return { error: `${id}：reset 正则写错了（${error.message}）` }; }
  }
  return { rule: { id, kind, where, re, reset, sample: raw.sample ? String(raw.sample).slice(0, MAX_SAMPLE) : '', origin: raw.origin || origin, builtin: origin === 'builtin' } };
}

// 生效的规则：内置的（数据文件里 disabled 列出的除外）+ 数据文件里的。返回 { rules, errors, file, disabled }。
function loadRules(dataDir, { fsModule = fs } = {}) {
  const errors = [], rules = [];
  let data = null;
  const file = dataDir ? rulesFile(dataDir) : null;
  if (file) {
    try { data = JSON.parse(fsModule.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') errors.push('规则文件读不了：' + error.message); }
  }
  const disabled = new Set(Array.isArray(data?.disabled) ? data.disabled.map(String) : []);
  for (const raw of BUILTIN_RULES) {
    if (disabled.has(raw.id)) continue;
    const c = compileRule(raw, 'builtin');
    if (c.rule) rules.push(c.rule); else errors.push(c.error);
  }
  for (const raw of Array.isArray(data?.rules) ? data.rules.slice(0, 50) : []) {
    if (raw && raw.enabled === false) continue;
    const c = compileRule(raw, 'file');
    if (c.error) { errors.push(c.error); continue; }
    if (rules.some(r => r.id === c.rule.id)) { errors.push(`${c.rule.id}：和已有规则重名，没用`); continue; }
    rules.push(c.rule);
  }
  return { rules, errors, file, disabled: [...disabled] };
}

// 对一段文字套规则；返回第一条命中 { rule, text（命中的那一段，≤300 字）, resetAt } 或 null。
function matchText(text, rules, where, now = Date.now()) {
  const s = String(text || '').slice(0, MATCH_INPUT_CHARS);
  if (!s) return null;
  for (const rule of rules || []) {
    if (!rule.where.includes(where)) continue;
    const m = rule.re.exec(s);
    if (!m) continue;
    const start = Math.max(0, s.lastIndexOf('\n', m.index) + 1);
    const endNl = s.indexOf('\n', m.index + m[0].length);
    const line = s.slice(start, endNl < 0 ? undefined : endNl).trim();
    return { rule, text: line.slice(0, MAX_SAMPLE), resetAt: rule.reset ? parseReset(s, rule.reset, now) : null };
  }
  return null;
}
function isSuspect(text) { return SUSPECT.test(String(text || '')); }

// 从报错里读重置时间（只按规则写明的方式读，不猜）：
//   clock：HH:MM（本地时间，已过就算明天）；datetime：YYYY-MM-DD HH:MM；epoch：秒或毫秒；duration：N 秒/分/小时（中英文）。
function parseReset(text, reset, now = Date.now()) {
  const at = parseResetRaw(text, reset, now);
  return at && at > now ? Math.min(at, now + MAX_RESET_MS) : null;
}
function parseResetRaw(text, reset, now) {
  const m = reset.re.exec(String(text || '').slice(0, MATCH_INPUT_CHARS));
  if (!m) return null;
  // 时长按整段匹配读（单位常在捕获组外，如「(\d+) 分钟后」）；其余类型优先读第一个捕获组
  const v = String(reset.type !== 'duration' && m[1] != null ? m[1] : m[0]).trim();
  if (reset.type === 'epoch') { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return null; const ms = n < 1e12 ? n * 1000 : n; return ms > now ? ms : null; }
  if (reset.type === 'clock') {
    const c = /(\d{1,2})[:：](\d{2})/.exec(v); if (!c) return null;
    const d = new Date(now); d.setHours(Number(c[1]), Number(c[2]), 0, 0);
    let at = d.getTime(); if (at <= now) at += 24 * 3600000; return at;
  }
  if (reset.type === 'datetime') {
    const c = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]+(\d{1,2})[:：](\d{2})/.exec(v); if (!c) return null;
    const at = new Date(Number(c[1]), Number(c[2]) - 1, Number(c[3]), Number(c[4]), Number(c[5])).getTime();
    return at > now ? at : null;
  }
  let ms = 0;
  for (const [, n, unit] of v.matchAll(/(\d+(?:\.\d+)?)\s*(小时|时|h(?:ours?|rs?)?|分钟|分|m(?:in(?:ute)?s?)?|秒|s(?:ec(?:ond)?s?)?)/gi)) {
    const k = /^(小时|时|h)/i.test(unit) ? 3600000 : /^(分|m)/i.test(unit) ? 60000 : 1000;
    ms += Number(n) * k;
  }
  return ms > 0 ? now + Math.round(ms) : null;
}

// ---- 脱敏（报错原文）：号身份由调用方传 scrub；这里换掉令牌样式、网址、本机路径 ----
function redactSnippet(text, { scrub = s => s } = {}) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  try { s = scrub(s); } catch { /* 号身份换不了时按样式规则换 */ }
  return s.replace(/https?:\/\/[^\s'"<>]+/gi, '<网址>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<邮箱>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<IP>')
    .replace(/\b(?:[A-Za-z0-9-]+\.)+(?:com|cn|net|org|io|tech|xyz|top|info|biz|cc|co|ai|app|dev|cloud|site|online|edu|gov|int|local|internal|corp|lan)(?::\d+)?\b(?:\/[^\s'"<>]*)?/gi, '<域名>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <已隐去>')
    .replace(/\b(?:sk|ghp|gho|ghs|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{10,}/g, '<已隐去>')
    .replace(/[A-Za-z0-9_+-]{32,}={0,2}/g, m => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '<已隐去>' : m))
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|mnt|tmp|var|opt)\/)[^\s'"<>，。；;,]*/g, '<路径>')
    .replace(/\b[a-z]\d{8}\b/gi, '<工号>')
    .slice(0, MAX_SAMPLE);
}

// ---- 避让状态与额度读数（同一个小文件；原子写） ----
function readState(dataDir, fsModule = fs) {
  try {
    const raw = JSON.parse(fsModule.readFileSync(stateFile(dataDir), 'utf8'));
    return { accounts: raw && typeof raw.accounts === 'object' && raw.accounts ? raw.accounts : {}, credit: raw && typeof raw.credit === 'object' && raw.credit ? raw.credit : {} };
  } catch { return { accounts: {}, credit: {} }; }
}
function writeState(dataDir, state, fsModule = fs) {
  const root = poolRoot(dataDir);
  fsModule.mkdirSync(root, { recursive: true });
  const file = stateFile(dataDir), tmp = `${file}.${process.pid}.tmp`;
  fsModule.writeFileSync(tmp, JSON.stringify({ schema: 1, accounts: state.accounts || {}, credit: state.credit || {} }, null, 1) + '\n', 'utf8');
  // Windows 上目标文件正被别处读（杀毒、另一个读者）时 rename 偶尔失败：重试一次，仍失败就抛给调用方（识别那边不前进读取位置，下一轮重来）
  try { fsModule.renameSync(tmp, file); }
  catch { fsModule.renameSync(tmp, file); }
}
const validKey = key => key === 'personal' || /^[a-z0-9]{2,16}$/.test(String(key || ''));
function isActive(entry, now = Date.now()) { return !!entry && (entry.until == null ? entry.source === 'manual' : Number(entry.until) > now); }
// 此刻在避让中的号：{ key: entry }。过期的不算（文件里留着，下次写入时清掉）。
function activeAvoid(dataDir, now = Date.now(), fsModule = fs) {
  const { accounts } = readState(dataDir, fsModule), out = {};
  for (const [key, entry] of Object.entries(accounts)) if (isActive(entry, now)) out[key] = entry;
  return out;
}
function creditReadings(dataDir, fsModule = fs) { return readState(dataDir, fsModule).credit; }

// 标「避让中」。source：error（识别到报错）/ credit（Credit ≤ 阈值）/ manual（手动暂停，until 为 null = 直到手动恢复）。
// 已在避让中的号再撞到：首次时间不变，预计恢复取更晚的；手动暂停不被自动标记覆盖。返回 { entry, changed }。
function markAvoid(dataDir, key, { source = 'error', kind = 'quota', reason = '', until, ruleId = null, session = null, sample = '', retryMs = DEFAULT_RETRY_MS } = {}, now = Date.now(), fsModule = fs) {
  if (!validKey(key)) throw new Error('账号编号无效');
  const state = readState(dataDir, fsModule);
  prune(state, now);
  const prev = state.accounts[key];
  const at = until === null ? null : Number.isFinite(Number(until)) && Number(until) > now ? Number(until) : now + retryMs;
  if (prev && isActive(prev, now) && prev.source === 'manual' && source !== 'manual') {
    return { entry: prev, changed: false };
  }
  const credit = state.credit[key] || null;
  const entry = {
    source, kind: KINDS[kind] ? kind : 'quota', reason: String(reason || KINDS[kind] || '').slice(0, 160),
    since: prev && isActive(prev, now) && source !== 'manual' ? prev.since : now,
    until: prev && isActive(prev, now) && source !== 'manual' && at != null && prev.until != null ? Math.max(Number(prev.until), at) : at,
    lastHitAt: now, hits: (prev && isActive(prev, now) ? Number(prev.hits) || 0 : 0) + 1,
    ...(ruleId ? { ruleId } : {}), ...(session ? { session: String(session).slice(0, 8) } : {}), ...(sample ? { sample: String(sample).slice(0, MAX_SAMPLE) } : {}),
    // 标记时的 Credit 读数：之后读数变了且大于阈值才算「恢复为正」（屏幕上的读数可能还是标记前那一轮的）。
    creditAtMark: credit ? Number(credit.remaining) : null,
  };
  const changed = !prev || !isActive(prev, now) || prev.until !== entry.until || prev.source !== entry.source;
  state.accounts[key] = entry;
  writeState(dataDir, state, fsModule);
  return { entry, changed };
}
function clearAvoid(dataDir, key, { by = 'manual' } = {}, now = Date.now(), fsModule = fs) {
  const state = readState(dataDir, fsModule);
  const prev = state.accounts[key];
  delete state.accounts[key];
  prune(state, now);
  writeState(dataDir, state, fsModule);
  return { cleared: !!prev && isActive(prev, now), previous: prev || null, by };
}
function prune(state, now) { for (const [k, e] of Object.entries(state.accounts)) if (!isActive(e, now)) delete state.accounts[k]; }

// 记一次 Credit 读数，并按读数决定避让：
//   读数 ≤ 阈值 → 标避让（source credit，默认 1 小时后再看）；
//   读数比标记时回升、且高于阈值（含从「≤ 阈值」回到「> 阈值」）→ 解除 credit 来源的避让、以及额度类（quota / balance）报错的避让；
//   读数下降、没变，或标记时没有读数（creditAtMark 为空）都不解除；限流和手动暂停不因读数解除（审核 2026-10-18）。
// observedAt：读数来自的会话最近活动时间。同一个号有多个会话时，比已记下的读数（另一个会话的）更旧就不用。
// 返回 { marked, cleared, entry }。
function recordCredit(dataDir, key, reading, { floor = 0, retryMs = DEFAULT_RETRY_MS, session = null, observedAt = null } = {}, now = Date.now(), fsModule = fs) {
  if (!validKey(key) || !reading || !Number.isFinite(Number(reading.remaining))) return { marked: false, cleared: false };
  const state = readState(dataDir, fsModule);
  const prevReading = state.credit[key];
  const sid = session ? String(session).slice(0, 8) : null;
  const seenAt = Number(observedAt) || now;
  if (prevReading && prevReading.session && sid && prevReading.session !== sid && Number(prevReading.observedAt) > seenAt) {
    return { marked: false, cleared: false, entry: state.accounts[key] || null, stale: true };
  }
  const remaining = Number(reading.remaining);
  state.credit[key] = { remaining, pct: Number(reading.pct), bucket: reading.bucket || '', total: reading.total || null, at: now, observedAt: seenAt, ...(sid ? { session: sid } : {}) };
  const entry = state.accounts[key];
  if (remaining <= Number(floor)) {
    writeState(dataDir, state, fsModule);
    if (entry && isActive(entry, now) && (entry.source === 'manual' || entry.source === 'credit')) return { marked: false, cleared: false, entry };
    const r = markAvoid(dataDir, key, { source: 'credit', kind: 'quota', reason: `Credit 剩 ${remaining}（${reading.bucket || '当前额度'}），不高于阈值 ${floor}`, retryMs, session }, now, fsModule);
    return { marked: r.changed, cleared: false, entry: r.entry };
  }
  let cleared = false;
  if (entry && isActive(entry, now) && entry.source !== 'manual' && (entry.source === 'credit' || entry.kind !== 'rate-limit')) {
    const rose = entry.creditAtMark != null && Number.isFinite(Number(entry.creditAtMark)) && remaining > Number(entry.creditAtMark);
    if (rose) { delete state.accounts[key]; cleared = true; }
  }
  writeState(dataDir, state, fsModule);
  return { marked: false, cleared, entry: cleared ? null : entry || null };
}

// ---- 代称：个人 / 号 1 / 号 2（审核 2026-10-18：固定序号） ----
// 每个号第一次出现时按号池登记顺序分一个序号，落盘在 codeagent-pool/quota-aliases.json；移出号池的号序号不回收、不复用，
// 「号 2」永远指同一个号（家里记下的代称、远程暂停的对象不会因为删号而错位）。直查 diag.js 用同一份。
const ALIAS_FILE = 'quota-aliases.json';
function aliasMap(dataDir, extraKeys = [], { fsModule = fs } = {}) {
  const map = new Map([['personal', '个人']]);
  let ids = [];
  try { ids = require('./codeagent-pool').readRegistry(dataDir).accounts.map(a => a.id); } catch { ids = []; }
  for (const k of extraKeys) if (k && k !== 'personal' && !ids.includes(k)) ids.push(k);
  if (!dataDir) { ids.forEach((id, i) => map.set(id, `号 ${i + 1}`)); return map; }
  const file = path.join(poolRoot(dataDir), ALIAS_FILE);
  let saved = { next: 1, map: {} };
  try { const raw = JSON.parse(fsModule.readFileSync(file, 'utf8')); if (raw && raw.map && typeof raw.map === 'object') saved = { next: Math.max(1, Number(raw.next) || 1), map: raw.map }; } catch { /* 第一次 */ }
  let changed = false;
  for (const id of ids) {
    if (!validKey(id)) continue;
    if (!Number.isInteger(saved.map[id])) { saved.map[id] = saved.next; saved.next += 1; changed = true; }
  }
  if (changed) {
    try {
      fsModule.mkdirSync(poolRoot(dataDir), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fsModule.writeFileSync(tmp, JSON.stringify({ schema: 1, next: saved.next, map: saved.map }, null, 1) + '\n', 'utf8');
      try { fsModule.renameSync(tmp, file); } catch { fsModule.renameSync(tmp, file); }
    } catch { /* 写不下：这次照算出的序号用，下次再写 */ }
  }
  // 已移出号池的号也留着它的代称（旧会话、旧记录里还会提到它），只是不再出现在挑号里
  for (const [id, n] of Object.entries(saved.map)) if (validKey(id) && Number.isInteger(n)) map.set(id, `号 ${n}`);
  return map;
}
// 家里写的代称 → 统一写法：「个人」「personal」→ 个人；「号1」「号 1」「1」「pool-1」→ 号 1。认不出返回空串。
function normalizeAlias(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^(个人|个人账号|personal)$/i.test(s)) return '个人';
  const m = /^(?:号\s*|pool[-_\s]?|#)?(\d{1,2})$/i.exec(s);
  return m && Number(m[1]) >= 1 ? `号 ${Number(m[1])}` : '';
}
function keyForAlias(aliases, alias) {
  const want = normalizeAlias(alias);
  if (!want) return '';
  for (const [k, v] of aliases) if (v === want) return k;
  return '';
}

// 给人看的一句话：「额度上限（Credit 读数），预计 18:30 恢复」。
const clock = ms => { const d = new Date(Number(ms) + 8 * 3600000); return d.toISOString().slice(5, 16).replace('T', ' '); };
function describeAvoid(entry) {
  if (!entry) return '';
  const what = entry.source === 'manual' ? '手动暂停' : `${KINDS[entry.kind] || '额度'}（${SOURCES[entry.source] || entry.source}）`;
  const until = entry.until == null ? '直到手动恢复' : `预计 ${clock(entry.until)} 恢复`;
  return `${what}，${until}`;
}

module.exports = {
  BUILTIN_RULES, KINDS, SOURCES, DEFAULT_RETRY_MS, RULES_FILE, STATE_FILE,
  rulesFile, stateFile, compileRule, loadRules, matchText, isSuspect, parseReset, redactSnippet,
  readState, activeAvoid, creditReadings, markAvoid, clearAvoid, recordCredit, isActive,
  aliasMap, normalizeAlias, keyForAlias, describeAvoid, clock, ALIAS_FILE, MATCH_INPUT_CHARS, MAX_RESET_MS,
};
