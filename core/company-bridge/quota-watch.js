'use strict';
// 额度感知的「看」（2026-10-18，公司一端）：定时被动读取开着的 CodeAgent 会话（通道会话、号池与个人账号上的会话都算），
// 识别「额度用完 / 限流 / 余额不足」类报错，把对应的号标「避让中」（core/codeagent-quota.js）；顺带读 Stats 面板的 Credit。
//
// 来源（用户 2026-10-18：卡片视图读的是原生记录，报错就在原生记录里）：
//   1. 原生记录——唯一能触发避让的来源：只看 API 错误消息（结构化标记 isApiErrorMessage、带 error 字段、模型是 <synthetic> 的回答，
//      或正文以「API Error」开头的回答 / 系统消息）。用户消息（问题里可能引用报错原文）和普通回答正文不看。
//   2. 终端屏幕——只留样本、读 Credit，不触发避让（审核 2026-10-18：屏幕上用户回显的「> API Error…」、回答里的「- API Error…」列表行
//      都长得像报错，用户把报错贴给 CodeAgent 问原因就会误停一个号）。只认以 ⎿ 开头或没有前缀的行；每个会话第一次读屏只记基线；
//      同一行一直留在屏幕上只算一次，滚走后再出现才再算。
// 样本（直查 errors 段）：命中规则的都留；没命中的「疑似」只收通道会话里以「API Error」开头的，个人会话里的编译错误一类不收。
// 底线：只读缓冲和记录文件，绝不往会话发按键或命令；样本脱敏后留最近 50 条。
const fs = require('node:fs');
const crypto = require('node:crypto');
const Q = require('../codeagent-quota');

const SCAN_MS = 20000;
const MAX_SESSIONS = 16;
const FIRST_TAIL_BYTES = 128 * 1024;
const READ_MAX_BYTES = 2 * 1024 * 1024;
const KEEP_ERRORS = 50;
const HIT_KEEP_MS = 3600000;
// 原生记录里的正文：以 API Error 开头
const TEXT_HEAD = /^\s*API\s*Error/i;
// 屏幕行：去掉 ⎿（CodeAgent 输出块的引线）或不带前缀后以 API Error 开头；行首的 >、-、*、●、│ 这类回显 / 列表前缀一律不认
const SCREEN_HEAD = /^\s*(?:⎿\s*)?API\s*Error/i;
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

// 一条原生记录（Claude 格式 jsonl 的一行）是不是 API 错误消息；是就返回 { text, structured, at }。
function apiErrorEntry(o) {
  if (!o || typeof o !== 'object' || o.type === 'user') return null;
  const c = o.message && o.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => String(b.text || '')).join('\n')
    : typeof o.content === 'string' ? o.content : typeof o.error === 'string' && !o.message ? o.error : '';
  const structured = o.isApiErrorMessage === true || (o.type === 'assistant' && !!o.error) || (o.message && o.message.model === '<synthetic>' && TEXT_HEAD.test(text))
    || (o.type === 'system' && /error/i.test(String(o.level || o.subtype || '')));
  if (!structured && !((o.type === 'assistant' || o.type === 'system') && TEXT_HEAD.test(text))) return null;
  if (!String(text).trim()) return null;
  return { text: String(text), structured, at: Date.parse(o.timestamp) || 0, uuid: o.uuid || null };
}

// 从字节缓冲里取完整的行：fromBoundary=false 时先跳过第一个换行之前的半行（按字节找，不会把多字节字符切坏）。
// 返回 { text, consumed（用掉的字节数，到最后一个换行为止） }。
function completeLines(buf, fromBoundary) {
  let start = 0;
  if (!fromBoundary) { const nl = buf.indexOf(0x0a); if (nl < 0) return { text: '', consumed: 0 }; start = nl + 1; }
  const last = buf.lastIndexOf(0x0a);
  if (last < start) return { text: '', consumed: start };
  return { text: buf.subarray(start, last).toString('utf8'), consumed: last + 1 };
}

class QuotaWatch {
  constructor(bridge) {
    this.bridge = bridge;
    this.lastScanAt = 0;
    this.offsets = new Map();   // 会话 → 原生记录已读到的字节位置
    this.visible = new Map();   // 会话 → 上一次屏幕上的报错行（同一行留在屏幕上只算一次；第一次读屏只记基线）
    this.screenSig = new Map(); // 会话 → 上一次缓冲的指纹（没变就不重新渲染）
    this.hits = new Map();      // 会话 → 最近一次识别到的额度报错 { at, key, ruleId, kind, text, resetAt }
  }
  get deps() { return this.bridge.deps; }
  get dataDir() { return this.deps.dataDir; }
  now() { return this.bridge.now(); }
  settings() {
    const s = this.bridge.settings();
    return { on: s.quotaGuard !== false, floor: Number(s.creditFloor) || 0, retryMs: Math.max(5, Number(s.quotaRetryMinutes) || 60) * 60000 };
  }
  sessionKey(s) { return s && s.codeagentPoolAccount ? String(s.codeagentPoolAccount) : 'personal'; }

  // 定时调用（通道 tick）；force：立即看一次（checkNow / 单测）。返回 { marked, cleared }（号的键）。
  async scan({ force = false } = {}) {
    const now = this.now();
    if (this.scanning || (!force && now - this.lastScanAt < SCAN_MS)) return { marked: [], cleared: [] };
    const cfg = this.settings();
    if (!cfg.on) return { marked: [], cleared: [] };
    this.scanning = true; this.lastScanAt = now;
    const marked = [], cleared = [];
    try {
      const { rules } = Q.loadRules(this.dataDir);
      const ids = (() => { try { return this.deps.listSessionIds?.() || []; } catch { return []; } })();
      this.forget(ids);
      const live = ids.map(id => ({ id, s: this.deps.getSession?.(id) }))
        .filter(x => x.s && /^codeagent/.test(String(x.s.kind || '')) && x.s.status !== 'dormant' && x.s.status !== 'closed')
        .map(x => ({ ...x, at: Math.max(Number(x.s.lastMessageTime) || 0, Number(x.s.lastCompletedAt) || 0, Number(this.deps.sessionInputAt?.(x.id)) || 0) }))
        .sort((a, b) => b.at - a.at).slice(0, MAX_SESSIONS);
      const creditSeen = new Set();
      for (const x of live) {
        const key = this.sessionKey(x.s);
        try { this.scanTranscript(x.id, x.s, key, rules, cfg, marked, cleared); } catch (error) { this.bridge.bridgeLog?.(`quota transcript ${String(x.id).slice(0, 8)} 读不了：${error.message}`); }
        try { await this.scanScreen(x, key, rules, cfg, marked, cleared, creditSeen); } catch { /* 这个会话的屏幕读不了，看下一个 */ }
      }
    } finally { this.scanning = false; }
    if (marked.length || cleared.length) this.bridge.avoidChanged?.({ marked, cleared });
    return { marked, cleared };
  }
  // 已关闭的会话（不在 Hub 的会话表里了）：清掉读到哪、屏幕基线、指纹；撞额度记录过一小时再清。
  forget(ids) {
    const alive = new Set(ids);
    for (const map of [this.offsets, this.visible, this.screenSig]) for (const id of [...map.keys()]) if (!alive.has(id)) map.delete(id);
    for (const [id, h] of [...this.hits]) if (!alive.has(id) && this.now() - h.at > HIT_KEEP_MS) this.hits.delete(id);
  }

  scanTranscript(id, s, key, rules, cfg, marked, cleared = []) {
    const file = s.transcriptPath;
    if (!file) return;
    let size;
    try { size = (this.deps.statSize || (f => fs.statSync(f).size))(file); } catch { return; }
    const known = this.offsets.has(id);
    let from = known ? this.offsets.get(id) : Math.max(0, size - FIRST_TAIL_BYTES);
    if (size < from) from = 0; // 记录被重写
    if (size === from) return;
    const start = size - from > READ_MAX_BYTES ? size - READ_MAX_BYTES : from;
    const buf = (this.deps.readRange || ((f, pos, n) => { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, pos); return b.subarray(0, got); } finally { fs.closeSync(fd); } }))(file, start, size - start);
    // 接着上次读到的行尾，或从文件头读：第一行是完整的；否则（第一次只读尾部、或积压太多跳过了一段）先跳过半行
    const { text, consumed } = completeLines(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'), start === 0 || (known && start === from));
    if (!consumed) return;
    // 这个号有模型配置避让记录时，也看正常回答的模型：用那个模型正常答出来了（试探成功、或配置已改好），就解除那一条。
    let watching = null;
    try { watching = Q.modelAvoidAll(this.dataDir)[key] || null; } catch { watching = null; }
    for (const line of text ? text.split('\n') : []) {
      const maybeAnswer = watching && line.includes('"assistant"') && line.includes('"model"');
      if (!line.includes('rror') && !maybeAnswer) continue; // 快速跳过：API Error / isApiErrorMessage / error 都含它
      let o = null; try { o = JSON.parse(line); } catch { continue; }
      const e = apiErrorEntry(o);
      if (!e) {
        const used = maybeAnswer && o && o.type === 'assistant' && o.message && typeof o.message.model === 'string' ? o.message.model : '';
        if (used && used !== '<synthetic>' && watching[Q.modelKey(used)] && Q.clearModelAvoid(this.dataDir, key, used)) {
          delete watching[Q.modelKey(used)];
          cleared.push(key);
          this.bridge.bridgeLog?.(`model-config cleared ${key === 'personal' ? 'personal' : 'pool'} session=${String(id).slice(0, 8)} model=${used}：用这个模型正常答出来了`);
        }
        continue;
      }
      const at = e.at || this.now();
      const hit = Q.matchText(e.text, rules, 'transcript', this.now());
      // 样本：命中规则的都留；没命中的只留通道会话里以 API Error 开头的
      if (hit || (s.purpose === 'company-bridge' && TEXT_HEAD.test(e.text))) {
        this.record({ id, s, key, source: 'transcript', structured: e.structured, text: hit ? hit.text : firstLines(e.text), hit, at, dedupe: e.uuid || hash(line) });
      }
      // 太久以前的报错（超过一个重试周期）只留作样本，不再避让。写避让状态失败就不前进读取位置，下一轮再读一次（不丢这次命中）。
      if (hit && this.now() - at < cfg.retryMs) {
        try { this.applyHit({ id, key, hit, at, cfg, marked, s }); }
        catch (error) { this.bridge.bridgeLog?.(`quota hit ${String(id).slice(0, 8)} 记不下避让状态：${error.message}，下一轮重读`); return; }
      }
    }
    this.offsets.set(id, start + consumed);
  }

  async scanScreen(x, key, rules, cfg, marked, cleared, creditSeen) {
    const { id, s } = x;
    if (!this.deps.readTerminalScreen) return;
    const raw = await this.deps.readTerminalScreen(id);
    if (!raw || !raw.text) return;
    const sig = raw.text.length + ':' + hash(raw.text.slice(-400));
    const unchanged = this.screenSig.get(id) === sig;
    this.screenSig.set(id, sig);
    if (unchanged && creditSeen.has(key)) return;
    const rows = await (this.deps.renderRows || require('../hub-phone/session-chat').renderRows)(raw);
    // Credit：同一个号有多个会话时，取最近活动的那个会话的读数（codeagent-quota.js recordCredit 按活动时间再核一遍）
    if (!creditSeen.has(key)) {
      const reading = require('../codeagent-screen-stats').parseCodeAgentCredit(rows);
      if (reading) {
        creditSeen.add(key);
        const r = Q.recordCredit(this.dataDir, key, reading, { floor: cfg.floor, retryMs: cfg.retryMs, session: id, observedAt: x.at || this.now() }, this.now());
        if (r.marked) { marked.push(key); this.bridge.bridgeLog?.(`quota credit ${key === 'personal' ? 'personal' : 'pool'} session=${String(id).slice(0, 8)} 剩 ${reading.remaining}，标避让`); }
        if (r.cleared) { cleared.push(key); this.bridge.bridgeLog?.(`quota credit ${key === 'personal' ? 'personal' : 'pool'} 剩 ${reading.remaining}，比标记时回升，解除避让`); }
      }
    }
    if (unchanged) return;
    const baseline = !this.visible.has(id);
    const prev = this.visible.get(id) || new Set();
    const now = new Set();
    for (const row of rows) {
      if (!SCREEN_HEAD.test(row)) continue;
      const line = row.replace(/^\s*(?:⎿\s*)?/, '').replace(/\s*[│┃|]\s*$/, '').trim();
      const k = hash(line);
      now.add(k);
      if (baseline || prev.has(k)) continue; // 第一次读屏只记基线；一直留在屏幕上的只算一次
      const hit = Q.matchText(line, rules, 'screen', this.now());
      // 屏幕只留样本、不避让：命中规则的都留；没命中的只留通道会话的
      if (!hit && s.purpose !== 'company-bridge') continue;
      this.record({ id, s, key, source: 'screen', structured: false, text: hit ? hit.text : line, hit, at: this.now(), dedupe: 'screen:' + id + ':' + k + ':' + this.now() });
    }
    this.visible.set(id, now);
  }

  applyHit({ id, key, hit, at, cfg, marked, s = null }) {
    // 模型配置有误（2026-10-19）：只对「这个号 + 被请求的模型」避让，不设自动到期，6 小时放行一次试探（codeagent-quota.js markModelAvoid）。
    if (hit.rule.kind === 'model-config') {
      const sample = Q.redactSnippet(hit.text, { scrub: t => this.bridge.scrubText(t) });
      // 报错里没写模型时，按这个会话此刻请求的模型（通道指定的，或预计模型）记；都没有就记成这个号的任何模型（'*'）
      const model = hit.model || (s && (s.codeagentRouteModel || (s.currentModel && s.currentModel.id))) || '';
      let have = [], account = null;
      try { account = (this.bridge.routeAccountsRaw?.() || []).find(x => x.key === key) || null; have = account ? (account.models || []).slice() : []; } catch { have = []; }
      // 用户自己开的会话（在里面用 /model 临时换过模型等）报错不标记（审核 2026-10-19）：只认通道会话，
      // 或报错里的模型就是这个号此刻配置里会请求的模型（新开会话一定也会报）。
      const configModel = account ? String(account.configModel || account.defaultModel || '') : '';
      if (!(s && s.purpose === 'company-bridge') && !(model && configModel && Q.modelKey(model) === Q.modelKey(configModel))) {
        this.bridge.bridgeLog?.(`model-config skip ${key === 'personal' ? 'personal' : 'pool'} session=${String(id).slice(0, 8)} model=${model || '?'}：不是通道会话，也不是这个号配置里的模型`);
        return;
      }
      const r = Q.markModelAvoid(this.dataDir, key, { model, have, reason: `${Q.KINDS['model-config']}：${sample}`, ruleId: hit.rule.id, session: id, sample }, this.now());
      const prev = this.hits.get(id);
      if (!prev || prev.at < at) this.hits.set(id, { at, key, ruleId: hit.rule.id, kind: 'model-config', text: sample, model: r.entry.model, resetAt: r.entry.probeAt });
      if (r.changed) {
        marked.push(key);
        this.bridge.bridgeLog?.(`model-config hit ${key === 'personal' ? 'personal' : 'pool'} session=${String(id).slice(0, 8)} model=${r.entry.model} 避让到 ${Q.clock(r.entry.probeAt)}（之后允许试一次）`);
      }
      return;
    }
    const resetAt = hit.resetAt && hit.resetAt > this.now() ? hit.resetAt : at + cfg.retryMs;
    const sample = Q.redactSnippet(hit.text, { scrub: t => this.bridge.scrubText(t) });
    const r = Q.markAvoid(this.dataDir, key, { source: 'error', kind: hit.rule.kind, reason: `${Q.KINDS[hit.rule.kind] || '额度'}：${sample}`, until: resetAt, ruleId: hit.rule.id, session: id, sample, retryMs: cfg.retryMs }, this.now());
    const prev = this.hits.get(id);
    if (!prev || prev.at < at) this.hits.set(id, { at, key, ruleId: hit.rule.id, kind: hit.rule.kind, text: sample, resetAt: r.entry.until });
    if (r.changed) {
      marked.push(key);
      this.bridge.bridgeLog?.(`quota hit ${key === 'personal' ? 'personal' : 'pool'} session=${String(id).slice(0, 8)} rule=${hit.rule.id} 避让到 ${Q.clock(r.entry.until)}`);
    }
  }

  // 识别到的报错样本留最近 50 条：直查 errors 段据此把原文带回去核对规则。
  record({ id, s, key, source, structured, text, hit, at, dedupe }) {
    const store = this.bridge.store;
    const list = store.get('quotaErrors') || [];
    if (list.some(x => x.dedupe === dedupe)) return;
    const entry = { at, seenAt: this.now(), key, session: String(id).slice(0, 8), purpose: s.purpose === 'company-bridge' ? 'company-bridge' : 'other', source, structured: !!structured,
      ruleId: hit ? hit.rule.id : null, kind: hit ? hit.rule.kind : null, text: Q.redactSnippet(text, { scrub: t => this.bridge.scrubText(t) }), dedupe };
    store.set('quotaErrors', [entry, ...list].slice(0, KEEP_ERRORS));
  }
  // 这个会话自 since 起有没有撞到额度（通道 collect 用来判断「这一轮是不是因额度中断」）。
  hitFor(sessionId, since) {
    const h = sessionId && this.hits.get(sessionId);
    return h && h.at >= since - 5000 ? h : null;
  }
  errors(limit = 20) { return (this.bridge.store.get('quotaErrors') || []).slice(0, Math.max(1, Math.min(KEEP_ERRORS, Number(limit) || 20))); }
}
function firstLines(text) { return String(text || '').split('\n').filter(l => l.trim()).slice(0, 3).join(' / '); }

module.exports = { QuotaWatch, apiErrorEntry, completeLines, SCAN_MS, KEEP_ERRORS, SCREEN_HEAD };
