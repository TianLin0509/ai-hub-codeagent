'use strict';
// 公司 Hub 一端的常驻助理（2026-10-15）：像脚本一样定时去通道里取家里的问题，
// 每个问题新开一个 CodeAgent 会话作答，答完自动发回；同一问题的追问送进同一个会话，
// 它记得上一轮读过什么。家里一个 Agent 对应这里一个 CodeAgent 会话，不同问题之间上下文互不干扰。
// 起初只读 AirView / L2 代码；2026-10-15 用户要求放开成通用：查代码、查本机文件与文档、跑查询命令都行。
//
// 不改动公司电脑靠说明约束：公司真机的 CodeAgent 不认 --disallowedTools / --strict-mcp-config（2026-10-15 实测），
// 用户拍板只靠说明、公司电脑上已注册的 MCP 允许使用；会话以 purpose=company-bridge 启动，只是不挂 Hub 自己的 MCP。
// 模型用 CodeAgent 自己的默认，不走 /model 菜单：公司真机上它把第一条消息卡住约 1 分钟（2026-10-15 用户反馈）。
// 发回前查源码：围栏代码块、无围栏的代码行、压成一行的代码都算；超过限度先请它改写，改完仍超就删掉那几段再发。
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AssistantStore } = require('../hub-assistant/store');
const { claimTimers, ownsTimers } = require('../hub-assistant/timer-owner');
const { BridgeLink } = require('./link');
const { receiptPromptFingerprint, transcriptHasRequest } = require('./receipt-reader');
// 2026-10-16：通道会话按追问规律和内存余量收放（session-care.js，设计见该文件开头）。
const care = require('./session-care');
// 反方向（这台电脑上的 CodeAgent 用 ask_home 向家里求助）由 ask-home.js 处理，共用这条通道和数据库。
const { AskHome } = require('./ask-home');
// 2026-10-15：设置菜单的隐藏入口（unlock.js）与放行页自动点击（gate-pass.js）。
const { matchesUnlock } = require('./unlock');
const { GatePasser } = require('./gate-pass');
// 2026-10-17：家里远程让这台 Hub 更新 / 重启（hub-admin.js），共用这条通道和数据库。
const { HubAdmin } = require('./hub-admin');

const PURPOSE = 'company-bridge';
// 历代默认说明：没改过的老设置里存的就是它们，读设置时换成当前默认。
const V1_INSTRUCTIONS = [
  '你是公司电脑上的代码阅读助手，替家里的 Agent 回答关于公司代码的问题。请遵守：',
  '1. 只读代码：可以打开、搜索、阅读文件；不运行程序或测试，不修改、新建、删除任何文件，不提交。',
  '2. 不回传源码：用文字和简短伪代码讲清逻辑，不成段粘贴源码。可以写函数名、文件相对路径和行号，方便对方追问。',
  '3. 先写结论，再逐条说明；分清「读到了」和「推测」。',
  '4. 末尾写「把握程度」（高 / 中 / 低及原因）和「没读到的部分」。',
  '5. 篇幅控制在 2 万字以内。',
].join('\n');
const V2_INSTRUCTIONS = [
  '你是公司电脑上的助手，替家里的 Agent 办事：读公司代码（如 AirView、L2 的实际实现），查这台电脑上的文件、文档和环境，运行查询类命令收集信息。请遵守：',
  '1. 保持公司电脑原样：可以打开、搜索、阅读文件，运行查询类命令（如 git log、dir、findstr）；修改、新建、删除文件，提交代码，安装软件，这些都不做。',
  '2. 不回传源码：用文字和简短伪代码讲清逻辑，不成段粘贴源码。可以写函数名、文件相对路径和行号，方便对方追问。',
  '3. 账号、密码、密钥、令牌这类凭据不写进回答。',
  '4. 先写结论，再逐条说明；分清「读到了」和「推测」。',
  '5. 末尾写「把握程度」（高 / 中 / 低及原因）和「没读到的部分」。',
  '6. 篇幅控制在 2 万字以内。',
].join('\n');
const V3_INSTRUCTIONS = [
  '你是公司电脑上的助手，替家里的 Agent 办事：读公司代码（如 AirView、L2 的实际实现），查这台电脑上的文件、文档和环境，运行查询类命令，也可以用这台电脑上已注册的 MCP 工具（如 AirView、内网搜索）收集信息。请遵守：',
  '1. 保持公司电脑原样：可以打开、搜索、阅读文件，运行查询类命令（如 git log、dir、findstr）；修改、新建、删除文件，提交代码，安装软件，这些都不做。',
  '2. 有副作用的动作（提交或运行仿真、同步工程、发消息、改动共享平台上的内容），只在家里的问题里明确要求时才做，并在回答里写清做了什么。',
  '3. 只回答问题需要的内容：不回传源码，用文字和简短伪代码讲清逻辑，可以写函数名、文件相对路径和行号；账号、密码、密钥、令牌这类凭据和与问题无关的个人信息不写进回答。',
  '4. 先写结论，再逐条说明；分清「读到了」和「推测」。',
  '5. 末尾写「把握程度」（高 / 中 / 低及原因）和「没读到的部分」。',
  '6. 篇幅控制在 2 万字以内。',
].join('\n');
// 只迁移未改过的默认说明；成员自己写的说明原样保留。
const DEFAULT_INSTRUCTIONS = V3_INSTRUCTIONS.replace('替家里的 Agent 办事', '为已配对的授权 Agent 处理任务').replace('家里的问题里', '任务中');
const OLD_DEFAULTS = [V1_INSTRUCTIONS, V2_INSTRUCTIONS, V3_INSTRUCTIONS];
// maxParallel 是工作日忙时的上限；闲时（晚上、周末）放宽到 maxParallelIdle，并按可用账号和内存再收（session-care.js parallelCap）。
// usePool：通道新开的会话走号池（自动挑进行中会话最少的号），号池没有可用的号时用个人账号。
// 2026-10-17 用户：工作日忙时 3 个、每号忙时 3 / 闲时 6 个、内存保底 10%，都可在设置里调（parallelRev 2 起）。
const DEFAULT_SETTINGS = Object.freeze({ enabled: true, codeRoots: [], instructions: DEFAULT_INSTRUCTIONS, effort: 'high', maxParallel: 3, maxParallelIdle: 6,
  perAccountPeak: 3, perAccountIdle: 6, memFloorPct: 10, busyHours: care.DEFAULT_BUSY_HOURS, usePool: true, pollSeconds: 30, autoGate: false, parallelRev: 2,
  // 允许家里远程更新 / 重启这台 Hub（2026-10-17 用户：默认开）。
  // restartGraceMinutes：远程重启前最多等手上的任务几分钟，到时先记下、中断，重启后自动接着做（2.1.9；0 = 立即，hub-admin.js）。
  allowRemoteAdmin: true, restartGraceMinutes: 3 });
const ACTIVE_POLL_MS = 10000;
const FOLLOWUP_WINDOW_MS = 10 * 60000;
const EFFORTS = ['low', 'medium', 'high', 'max'];
const MAX_REPLY_CHARS = 40000;
// 源码检查的限度：成段（连续）超过 12 行，或全篇累计超过 30 行像代码的内容。
const MAX_CODE_RUN = 12;
const MAX_CODE_TOTAL = 30;
// 发出后会话停下、却一直没读到回答：判定没答上，告诉家里。
const NO_ANSWER_MS = 10 * 60000;
// 记录还在写时最多等多久（长仿真、全量编译）；过了照旧按「没答上」处理，避免永远挂着。
const LONG_RUN_MS = 3 * 60 * 60000;
// 发出后多久核实「提问真的写进了 CodeAgent 的记录」；刚发出这段时间里 hook 可能还没到，也按「在干活」占名额。
const VERIFY_MS = 3 * 60000;
const STARTUP_GRACE_MS = 3 * 60000;
// 家里报「发问方还在活动」的有效期。
const ASKER_TTL_MS = 15 * 60000;
const CARE_EVERY_MS = 60000;
// 收回答前核对：CodeAgent 收到的那条消息里得有本题编号。剪贴板里的图片会顶掉粘贴进去的问题（2026-10-15 公司真机），
// 这时它答的是图片，不能发回家；自动重发，连着被顶掉 2 次就报错让人清空剪贴板后重试。
const MAX_HIJACK = 2;
// 从 CodeAgent 的原生记录（Claude 格式 jsonl）里取用户发出的消息：时间、文字、图片张数（工具结果不算）。
function userTurnsFromTranscript(file) {
  let raw = '';
  try { raw = require('node:fs').readFileSync(file, 'utf8'); } catch { return []; }
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"user"')) continue;
    let o = null; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'user' || !o.message) continue;
    const c = o.message.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    if (!blocks.length || blocks.every(b => b && b.type === 'tool_result')) continue;
    turns.push({ at: Date.parse(o.timestamp) || 0, text: blocks.filter(b => b && b.type === 'text').map(b => String(b.text || '')).join('\n'),
      images: blocks.filter(b => b && b.type === 'image').length });
  }
  return turns;
}
const short = (s, n = 28) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// ---- 源码检查 ----
const CODE_LINE = /;\s*$|^\s*[{}]\s*;?\s*$|^\s*#\s*(?:include|define|ifn?def|if|endif|pragma)\b|^\s*(?:return|typedef|struct|static|const|void|int|unsigned|float|double|char|bool|uint\d+_t|int\d+_t|def|class|import|from)\b.*[;{(:]\s*$|^\s*(?:if|for|while|switch)\s*\(.*\)\s*\{?\s*$|^\s*}\s*else\b/;
// 每行的「代码行数」：围栏里的非空行算 1；围栏外像代码的行算 1；压成一长行的按分号数算。
function codeWeights(text) {
  const lines = String(text || '').split('\n');
  const weights = new Array(lines.length).fill(0);
  let fence = null;
  lines.forEach((line, i) => {
    const marker = line.match(/^\s*(```|~~~)/);
    if (marker) { fence = fence ? (fence === marker[1] ? null : fence) : marker[1]; return; }
    if (!line.trim()) return;
    if (fence) { weights[i] = 1; return; }
    const semis = (line.match(/;/g) || []).length;
    if (semis >= 4 && line.length > 120) weights[i] = semis;
    else if (!/^\s*\|/.test(line) && CODE_LINE.test(line.replace(/`[^`]*`/g, s => s.length > 60 ? s.slice(1, -1) : 'x'))) weights[i] = 1;
  });
  return { lines, weights };
}
// 连续的代码行（中间夹空行、围栏行也算连着）。
function codeRuns(text) {
  const { lines, weights } = codeWeights(text);
  const runs = [];
  let cur = null;
  lines.forEach((line, i) => {
    const glue = !line.trim() || /^\s*(```|~~~)/.test(line);
    if (weights[i]) { if (!cur) cur = { start: i, end: i, lines: 0 }; cur.end = i; cur.lines += weights[i]; }
    else if (!glue && cur) { runs.push(cur); cur = null; }
  });
  if (cur) runs.push(cur);
  return { lines, runs, total: runs.reduce((a, r) => a + r.lines, 0) };
}
function sourceVerdict(text) {
  const { runs, total } = codeRuns(text);
  const maxRun = runs.reduce((a, r) => Math.max(a, r.lines), 0);
  return { total, maxRun, tooMuch: maxRun > MAX_CODE_RUN || total > MAX_CODE_TOTAL };
}
// 兜底：把超过 3 行的代码段换成一句说明（含围栏行）。
function stripCode(text, minLines = 3) {
  const { lines, runs } = codeRuns(text);
  let removed = 0;
  const out = [...lines];
  for (const r of [...runs].reverse()) {
    if (r.lines <= minLines) continue;
    let start = r.start, end = r.end;
    if (start > 0 && /^\s*(```|~~~)/.test(out[start - 1])) start -= 1;
    if (end + 1 < out.length && /^\s*(```|~~~)/.test(out[end + 1])) end += 1;
    out.splice(start, end - start + 1, `（此处原有约 ${r.lines} 行代码，按规则不回传）`);
    removed += r.lines;
  }
  return { text: out.join('\n'), removed };
}

// 早期版本的表没有 open 列：补上并按内容回填（只有开发期的数据目录会遇到）。
function ensureOpenColumn(db, needsWork) {
  const cols = db.prepare('PRAGMA table_info(bridge_threads)').all().map(c => c.name);
  if (cols.includes('open')) return;
  db.exec('ALTER TABLE bridge_threads ADD COLUMN open INTEGER NOT NULL DEFAULT 0');
  for (const row of db.prepare('SELECT id,payload FROM bridge_threads').all()) {
    let t = null; try { t = JSON.parse(row.payload); } catch {}
    if (t) db.prepare('UPDATE bridge_threads SET open=? WHERE id=?').run(needsWork(t) ? 1 : 0, row.id);
  }
}

// ---- 线程状态：由各轮推导 ----
// 轮次的阶段：queued（等派发）、running（已发进会话等回答）、replied、failed。
function roundPhase(r) { return r.reply ? 'replied' : r.error ? 'failed' : r.sentAt ? 'running' : 'queued'; }
// 在途轮次从什么时候算起：发出时间；远程重启后恢复会话、发了「继续」的，从恢复时间算（hub-admin.js）。
function activeSince(r) { return Math.max(r.sentAt || 0, r.resumedAt || 0); }
function deriveState(t) {
  if (t.state === 'cancelled') return 'cancelled';
  const phases = t.rounds.map(roundPhase);
  if (phases.includes('running')) return 'running';
  if (phases.includes('queued')) return 'queued';
  return phases[phases.length - 1] === 'failed' ? 'failed' : 'replied';
}

class CompanyBridge {
  constructor(deps) {
    this.deps = deps;
    this.store = new AssistantStore(path.join(deps.dataDir, 'company-bridge'));
    this.store.db.exec('CREATE TABLE IF NOT EXISTS bridge_threads(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,open INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL)');
    ensureOpenColumn(this.store.db, t => ['queued', 'running'].includes(deriveState(t)));
    this.link = new BridgeLink({ side: 'company', store: this.store, fetchImpl: deps.fetchImpl, now: () => this.now() });
    this.busy = null; this.advanceBusy = null; this.deliverBusy = null; this.timer = null; this.nextPullAt = 0; this.lastPullAt = 0;
    this.askHome = new AskHome({ bridge: this, deps });
    this.images = new (require('./images').BridgeImages)(this);
    this.hubAdmin = new HubAdmin({ bridge: this, deps });
    this.gatePass = new GatePasser({ open: url => deps.openHiddenGate(url), logDir: path.join(deps.dataDir, 'logs'), now: () => this.now(),
      notify: (title, text) => this.notify(title, text) });
    // 升级前就配对过的电脑（入口还没隐藏时用过）直接算已解锁，不让成员升级后找不到入口。
    if (!this.store.get('featureUnlock') && (this.link.config().state || 'none') !== 'none') this.store.set('featureUnlock', { at: this.now(), via: 'paired' });
    if (!deps.noTimer) claimTimers(this.store);
  }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  // 隐藏入口：本机解锁过一次就一直显示（存在本机数据目录）。
  unlocked() { return !!this.store.get('featureUnlock'); }
  unlock(text) {
    if (!matchesUnlock(text, this.deps.unlockDigest)) return false;
    if (!this.unlocked()) this.store.set('featureUnlock', { at: this.now(), via: 'keys' });
    this.changed();
    return true;
  }
  settings() {
    const { model: _oldModel, ...s } = this.store.get('settings') || {}; // 旧版存过模型，现在不用
    const instructions = !s.instructions || OLD_DEFAULTS.includes(s.instructions.trim()) ? DEFAULT_INSTRUCTIONS : s.instructions;
    // 旧版设置页只能存「同时 N 个」且默认 2；没调过并行档位的（parallelRev 缺失且仍是旧默认 2）按新默认 3。
    if (!s.parallelRev && Number(s.maxParallel) === 2) delete s.maxParallel;
    return { ...DEFAULT_SETTINGS, ...s, instructions, codeRoots: Array.isArray(s.codeRoots) ? s.codeRoots : [], parallelRev: DEFAULT_SETTINGS.parallelRev };
  }
  setSettings(patch = {}) {
    const next = this.settings();
    if ('enabled' in patch) next.enabled = patch.enabled === true;
    if ('codeRoots' in patch) {
      const list = (Array.isArray(patch.codeRoots) ? patch.codeRoots : String(patch.codeRoots || '').split(/\r?\n/)).map(s => String(s).trim()).filter(Boolean);
      if (list.length > 20) throw new Error('代码位置最多 20 个');
      next.codeRoots = list;
    }
    if ('instructions' in patch) { const t = String(patch.instructions || '').trim(); if (t.length > 8000) throw new Error('说明太长（上限 8000 字）'); next.instructions = t || DEFAULT_INSTRUCTIONS; }
    if ('effort' in patch) { if (!EFFORTS.includes(patch.effort)) throw new Error('思考深度只能是 low / medium / high / max'); next.effort = patch.effort; }
    const int = (key, lo, hi, label) => { if (!(key in patch)) return; const n = Number(patch[key]); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${label}只能是 ${lo}–${hi}`); next[key] = n; };
    int('maxParallel', 1, 8, '工作日忙时同时处理的问题数');
    int('maxParallelIdle', 1, 12, '闲时同时处理的问题数');
    int('perAccountPeak', 1, 8, '每个账号忙时同时处理的问题数');
    int('perAccountIdle', 1, 12, '每个账号闲时同时处理的问题数');
    int('memFloorPct', 5, 50, '内存保底百分比');
    int('restartGraceMinutes', 0, 30, '远程重启前最多等待的分钟数');
    if ('busyHours' in patch) { const spec = String(patch.busyHours || '').trim(); if (spec && !care.parseHours(spec).length) throw new Error('忙时格式如 08:30-12:00,13:30-17:30'); next.busyHours = spec || care.DEFAULT_BUSY_HOURS; }
    if ('usePool' in patch) next.usePool = patch.usePool === true;
    if ('pollSeconds' in patch) { const n = Number(patch.pollSeconds); if (!Number.isInteger(n) || n < 10 || n > 600) throw new Error('检查间隔只能是 10–600 秒'); next.pollSeconds = n; }
    if ('autoGate' in patch) next.autoGate = patch.autoGate === true;
    if ('allowRemoteAdmin' in patch) next.allowRemoteAdmin = patch.allowRemoteAdmin === true;
    this.store.set('settings', next);
    this.tightenPoll(); this.changed();
    return next;
  }

  // 任务进行中和答完后的追问窗口加快检查；空闲沿用成员原来的设置。
  // 窗口随配对代次持久化，程序重开可接上，换配对不会继承旧窗口。
  polling() {
    const c = this.link.config();
    if (!c.state || c.state === 'none') return { intervalSeconds: 0, active: false, activeUntil: null };
    if (c.state !== 'paired') return { intervalSeconds: ACTIVE_POLL_MS / 1000, active: false, activeUntil: null };
    const recent = this.store.get('pollActivity');
    const activeUntil = recent?.gen === c.gen ? recent.until : null;
    const active = activeUntil > this.now() || this.openThreads().some(t => t.gen === c.gen) || this.askHome.openThreads().length > 0 || this.link.pendingOutbox() > 0;
    return { intervalSeconds: active ? ACTIVE_POLL_MS / 1000 : this.settings().pollSeconds, active, activeUntil: activeUntil > this.now() ? activeUntil : null };
  }
  tightenPoll() {
    const ms = this.polling().intervalSeconds * 1000;
    if (ms) this.nextPullAt = Math.min(this.nextPullAt, (this.lastPullAt || this.now()) + ms);
  }

  threads(limit = 60) { return this.store.db.prepare('SELECT payload FROM bridge_threads ORDER BY updated DESC LIMIT ?').all(limit).map(r => JSON.parse(r.payload)); }
  openThreads() { return this.store.db.prepare('SELECT payload FROM bridge_threads WHERE open=1 ORDER BY updated').all().map(r => JSON.parse(r.payload)); }
  thread(id) { const r = this.store.db.prepare('SELECT payload FROM bridge_threads WHERE id=?').get(id); return r ? JSON.parse(r.payload) : null; }
  saveThread(t) {
    t.updatedAt = this.now(); t.state = deriveState(t);
    this.store.db.prepare('INSERT INTO bridge_threads(id,payload,state,open,updated) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state,open=excluded.open,updated=excluded.updated')
      .run(t.id, JSON.stringify(t), t.state, ['queued', 'running'].includes(t.state) ? 1 : 0, t.updatedAt);
    if (t.state !== 'cancelled' && t.gen && t.gen === this.link.gen()) {
      this.store.set('pollActivity', { gen: t.gen, until: this.now() + FOLLOWUP_WINDOW_MS });
      this.tightenPoll();
    }
    return t;
  }
  patchRound(t, round, patch) { return this.saveThread({ ...t, rounds: t.rounds.map(x => x.round === round ? { ...x, ...patch } : x) }); }

  sessionPlan(request) { return this.askHome.sessionPlan(request); }
  start() {
    if (!this.askHome.server) void this.askHome.start().catch(e => console.warn('[company-bridge] ask-home', e.message));
    if (this.deps.noTimer || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(e => console.warn('[company-bridge] tick', e.message)); }, 5000);
    this.timer.unref?.();
  }
  async tick({ force = false } = {}) {
    if (!force && !this.deps.noTimer && !ownsTimers(this.store)) return;
    // 收件和会话推进分别去重：开会话或发送问题可能等很久，期间仍能收下一条任务。
    if (!this.busy) this.busy = (async () => {
      const state = this.link.config().state;
      if (!state || state === 'none') return;
      if (this.link.pairingExpired()) { this.link.unpair(); this.notify('配对已过期', '24 小时内对端没有确认，请重新获取配对码。'); this.changed(); return; }
      this.tightenPoll();
      if (force || this.now() >= this.nextPullAt) {
        this.lastPullAt = this.now();
        this.nextPullAt = this.lastPullAt + this.polling().intervalSeconds * 1000;
        try { await this.link.pull(message => this.receive(message)); } catch {}
        await this.passGate();
        // 上次远程更新 / 重启的结果、版本变化，通道接通后报回家里。
        try { await this.hubAdmin.announce(); } catch (e) { console.warn('[company-bridge] hub-admin announce', e.message); }
        this.changed();
      }
    })().finally(() => { this.busy = null; });
    await this.busy;
    if (this.settings().enabled && this.link.paired()) {
      if (!this.advanceBusy) this.advanceBusy = this.advance().finally(() => { this.advanceBusy = null; });
      await this.advanceBusy;
    }
    // 远程更新 / 重启：等到安全时机就重启、重启没成的看门狗、配对变了作废（hub-admin.js）。不看配对：解除配对时等待中的指令要作废。
    try { await this.hubAdmin.advance(); } catch (e) { console.warn('[company-bridge] hub-admin', e.message); }
    // 重启前被中断的会话：恢复并发一句「继续」（和配对无关，本机会话也在里面）。
    try { await this.hubAdmin.resumeInterrupted(); } catch (e) { console.warn('[company-bridge] hub-admin resume', e.message); }
    // 家里对 ask_home 的回复：和「自动作答」开关无关，配对了就送。
    if (this.link.paired()) {
      if (!this.deliverBusy) this.deliverBusy = this.askHome.deliver().finally(() => { this.deliverBusy = null; });
      await this.deliverBusy;
      await this.images.tick();
    }
  }
  // 通道被放行页拦着、且开了自动放行：在看不见的窗口里点一次放行，点到了立即重试连接。
  async passGate() {
    const gate = this.link.status().gate;
    if (!gate) { if (this.gatePass.passed()) this.notify('已自动放行', '公司网络的放行页已自动点过，通道恢复。'); return; }
    if (!this.settings().autoGate || !this.deps.openHiddenGate) return;
    if (!(await this.gatePass.attempt(gate.url || this.link.client().gatePage()))) return;
    try { await this.link.pull(message => this.receive(message)); } catch {}
    if (!this.link.status().gate && this.gatePass.passed()) this.notify('已自动放行', '公司网络的放行页已自动点过，通道恢复。');
  }
  checkNow() { this.nextPullAt = 0; return this.tick({ force: true }).then(() => this.status()); }

  async pair(code) {
    this.cancelOpen('重新配对');
    await this.link.acceptPairing(code, { app: 'company-hub' });
    this.nextPullAt = 0;
    this.changed();
    return this.status();
  }
  unpair() { this.cancelOpen('已解除配对'); this.link.unpair(); this.changed(); return this.status(); }
  // 解除或重新配对：没答完的问题作废，答完的也不会再发给新的对端（发送前核对代次）。
  cancelOpen(why) { this.askHome.cancelOpen(why); for (const t of this.openThreads()) this.saveThread({ ...t, state: 'cancelled', cancelNote: why }); }

  receive(message) {
    if (['image-capabilities', 'image', 'image-ack'].includes(message.type)) return this.images.receive(message);
    if (message.type === 'welcome') {
      if (this.link.completeAsCompany(message)) this.notify('配对已完成', 'AI特战队专用功能已接通。');
      return;
    }
    if (this.askHome.receive(message)) return;
    if (this.hubAdmin.receive(message)) return;
    // 家里报：这些问题的发问会话还在活动（追问可能性大，答完的会话保温加倍）。
    if (message.type === 'asker') {
      if (message.gen && message.gen !== this.link.gen()) return;
      const threads = (Array.isArray(message.threads) ? message.threads : []).map(String).filter(id => /^[A-Za-z0-9-]{3,40}$/.test(id)).slice(0, 200);
      this.store.set('askerActive', { at: this.now(), threads });
      return;
    }
    if (message.type === 'recollect') { void this.recollect(message).catch(e => console.warn('[company-bridge] recollect', e.message)); return; }
    if (message.type !== 'ask' && message.type !== 'followup') return;
    const id = String(message.thread || '').slice(0, 40);
    if (!/^[A-Za-z0-9-]{3,40}$/.test(id)) return;
    const gen = this.link.gen();
    if (message.gen && message.gen !== gen) return; // 上一次配对的消息
    const question = String(message.question || '').slice(0, 60000);
    const round = Number(message.round) || 1;
    let existing = this.thread(id);
    // 家里换了数据目录、编号从头再来，或是上一次配对留下的同编号：不是重复投递，旧记录改名留档。
    if (existing && message.type === 'ask' && ((existing.rounds[0] && existing.rounds[0].mid && existing.rounds[0].mid !== message.mid) || existing.gen !== gen)) {
      this.store.db.prepare('DELETE FROM bridge_threads WHERE id=?').run(id);
      this.saveThread({ ...existing, id: id + '#' + existing.createdAt, state: existing.state === 'cancelled' ? 'cancelled' : existing.state });
      existing = null;
    }
    if (existing && (existing.state === 'cancelled' || existing.gen !== gen)) return;
    if (existing && existing.rounds.some(r => r.round === round)) return; // 重复投递
    if (!existing && message.type === 'followup') return; // 不认识的追问（多半属于已清理的旧问题）
    const t = existing || { id, gen, title: short(message.title || question, 40), from: message.from || null, sessionId: null, createdAt: this.now(), rounds: [] };
    t.rounds = [...t.rounds, { round, question, receivedAt: this.now(), mid: message.mid }];
    this.saveThread(t);
    void this.link.send('status', { thread: id, gen, round, state: 'received', note: '公司已收到' }).catch(() => {});
    this.notify(existing ? '收到追问' : '收到任务', `${id}：${short(question, 60)}`, t.sessionId);
  }

  sessionBusy(id) {
    const s = id && this.deps.getSession(id);
    if (!s) return false;
    return !!this.deps.isAgentTurnActive?.(id) || require('../session-runtime-truth').sessionRuntimeIsActive(s) || s.status === 'running' || !!this.deps.hasPendingPrompt?.(id);
  }
  // 原生记录最近 NO_ANSWER_MS 内有写入：CodeAgent 还在干活。拿不到路径或读不到时间按「不新鲜」处理（沿用原判定）。
  transcriptFresh(sessionId) {
    const meta = this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId);
    const file = meta && meta.transcriptPath;
    if (!file) return false;
    let ms = null;
    try { ms = this.deps.transcriptMtime ? this.deps.transcriptMtime(file) : require('node:fs').statSync(file).mtimeMs; } catch { return false; }
    return Number.isFinite(ms) && this.now() - ms < NO_ANSWER_MS;
  }
  lastFinal(sessionId) {
    const meta = this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId);
    if (!meta) return null;
    const records = this.deps.readFinals ? this.deps.readFinals(meta) : [];
    return records && records.length ? records[records.length - 1] : null;
  }

  // 推进：在途的轮次看有没有答完；排队的轮次按并发上限开会话或续问。同一问题一次只有一轮在途。
  async advance() {
    const s = this.settings(), gen = this.link.gen();
    for (const t of this.openThreads()) {
      if (t.gen !== gen) { this.saveThread({ ...t, state: 'cancelled', cancelNote: '属于上一次配对' }); continue; }
      if (t.state === 'running') await this.collect(t);
    }
    // 名额只算真在干活的（2026-10-16）：会话在忙，或刚发出、hook 还没到。回答已写完只等核对、停在两轮之间的不占——
    // 以前它们照样占着，新问题排了一个半小时（Q-1016-06/07/08）。
    const working = this.openThreads().filter(x => x.state === 'running' && this.roundWorking(x)).length;
    const limit = this.parallelLimit(working);
    let free = limit.cap - working;
    // 已有会话的线索（追问、改写）先派：不用新开会话、不多占内存；同类按到达先后。
    const queue = this.openThreads().filter(x => x.state === 'queued')
      .sort((a, b) => (Number(!!b.sessionId) - Number(!!a.sessionId)) || a.createdAt - b.createdAt);
    let waiting = 0;
    // 家里要求重启、正在等手上的任务答完：新任务先排队，重启后接着做。
    if (this.hubAdmin.holdingDispatch()) { this.careSessions(); return; }
    for (const t of queue) {
      if (t.sessionId && this.sessionBusy(t.sessionId)) continue; // 追问时原会话还在忙（例如改写上一轮），等它停下
      if (free > 0) { await this.dispatch(t); free -= 1; continue; }
      waiting += 1;
      this.reportQueue(t, waiting, limit, working);
    }
    this.careSessions();
  }
  // 当前允许几个问题同时在跑（session-care.js parallelCap）。
  parallelLimit(working) {
    const s = this.settings();
    let lanes = 1;
    if (s.usePool) { try { lanes += Math.max(0, Number(this.deps.poolLanes?.()) || 0); } catch { /* 号池读不到就只算个人账号 */ } }
    const limit = care.parallelCap({ date: new Date(this.now()), busyHours: s.busyHours, peakCap: s.maxParallel, idleCap: s.maxParallelIdle,
      perAccountPeak: s.perAccountPeak, perAccountIdle: s.perAccountIdle, memFloor: s.memFloorPct / 100, lanes, working,
      memory: this.deps.memory ? this.deps.memory() : care.memoryNow() });
    this.parallelState = { ...limit, lanes, working, at: this.now() };
    return limit;
  }
  // 设置页显示「现在最多同时几个、受什么限制」；算不出来时不挡状态页。
  parallelLimitSafe() {
    try {
      const working = this.openThreads().filter(x => x.state === 'running' && this.roundWorking(x)).length;
      const { cap, peak, limitedBy, timeCap, laneCap, memCap } = this.parallelLimit(working);
      return { cap, peak, limitedBy, timeCap, laneCap, memCap, working };
    } catch { return null; }
  }
  // 排队的问题告诉家里：排第几、为什么在等。只在内容变化时发。
  reportQueue(t, position, limit, working) {
    const r = t.rounds.find(x => roundPhase(x) === 'queued');
    if (!r) return;
    const note = `排队第 ${position} 个：${working} 个在跑，上限 ${limit.cap}（受${limit.limitedBy}限制）`;
    if (r.queueNote === note) return;
    this.patchRound(t, r.round, { queueNote: note });
    void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'received', note }).catch(() => {});
  }
  roundWorking(t) {
    if (t.sessionId && this.sessionBusy(t.sessionId)) return true;
    const r = t.rounds.find(x => roundPhase(x) === 'running');
    // 重启前被中断、等重启后恢复的轮次（hub-admin.js resumeAfterRestart）也算在干活。
    return !!r && (!!r.resumePending || this.now() - activeSince(r) < STARTUP_GRACE_MS);
  }

  // 答完的通道会话按追问规律与内存余量休眠（session-care.js）；休眠保留记录，追问时 dispatch 会按编号恢复。
  careSessions() {
    if (!this.deps.suspendSession || this.now() - (this.lastCareAt || 0) < CARE_EVERY_MS) return;
    this.lastCareAt = this.now();
    const all = this.threads(300);
    const keep = care.learnKeepWarm(all);
    const asker = this.store.get('askerActive') || {};
    const askerFresh = asker.at && this.now() - asker.at < ASKER_TTL_MS ? new Set(asker.threads || []) : new Set();
    const bySession = new Map();
    for (const t of all) {
      if (!t.sessionId || t.state === 'cancelled') continue;
      if (t.state === 'queued' || t.state === 'running') { bySession.set(t.sessionId, null); continue; } // 在途：不收
      if (bySession.get(t.sessionId) === null) continue;
      const last = t.rounds[t.rounds.length - 1] || {};
      const idleSince = last.replyAt || last.failedAt || t.updatedAt || 0;
      const prev = bySession.get(t.sessionId);
      if (!prev || idleSince > prev.idleSince) bySession.set(t.sessionId, { sessionId: t.sessionId, threadId: t.id, idleSince, askerActive: askerFresh.has(t.id) });
    }
    // 有人在这个会话的终端里直接打过字（用户自己接着用），从那时算起：看实际活动，不只看回执时间。
    const candidates = [...bySession.values()].filter(c => c && this.deps.getSession(c.sessionId) && !this.sessionBusy(c.sessionId))
      .map(c => ({ ...c, idleSince: Math.max(c.idleSince, Number(this.deps.sessionInputAt?.(c.sessionId)) || 0) }));
    const memory = this.deps.memory ? this.deps.memory() : care.memoryNow();
    this.careState = { keepWarmMinutes: Math.round(keep.ms / 60000), samples: keep.samples, learned: keep.learned,
      freePercent: Math.round(memory.ratio * 100), warm: candidates.length, at: this.now() };
    for (const p of care.planRelease({ candidates, keepWarmMs: keep.ms, now: this.now(), memory })) {
      let result;
      try { result = this.deps.suspendSession(p.sessionId, { reason: 'company-bridge-idle', minIdleMs: 60000, excludePinned: true, excludeFocused: true, excludeMeeting: true }); }
      catch (error) { result = { ok: false, message: error.message }; }
      this.careLog(`${result?.ok ? 'suspend' : 'skip'} ${p.threadId} session=${String(p.sessionId).slice(0, 8)} ${p.reason}${result?.ok ? '' : '；跳过：' + (result?.message || result?.error || '未知')}`);
    }
  }
  careLog(line) {
    try {
      const fs = require('node:fs'), dir = path.join(this.deps.dataDir, 'logs'), file = path.join(dir, 'company-session-care.log');
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, file + '.1'); } catch { /* 还没有文件 */ }
      fs.appendFileSync(file, `${new Date(this.now()).toISOString()} ${line}\n`, 'utf8');
    } catch { /* 日志写不了不影响收放 */ }
  }

  promptFor(t, r, s) {
    if (r.rewrite) return `（编号 ${t.id}，第 ${r.round} 轮）你上一条回答里有成段的源码。按规则不能回传源码：请把整份回答重写一遍，代码部分改成文字说明或几行伪代码，其余内容保持。直接输出重写后的完整回答。`;
    const roots = s.codeRoots.length ? s.codeRoots.map(p => '- ' + p).join('\n') : '- （未设置，请在当前目录里找）';
    if (r.round === 1 || !t.everAnswered) {
      return [s.instructions, '', '代码位置：', roots, '', `## 成员请求（编号 ${t.id}${r.round > 1 ? `，第 ${r.round} 轮` : ''}）`, '', r.question].join('\n');
    }
    return [`## 成员追问（编号 ${t.id}，第 ${r.round} 轮）`, '', r.question, '', '（规则同前：保持公司电脑原样、不回传源码和凭据、末尾写把握程度和没读到的部分。）'].join('\n');
  }

  async dispatch(t) {
    const s = this.settings();
    const r = t.rounds.find(x => roundPhase(x) === 'queued');
    if (!r) { this.saveThread(t); return; }
    try {
      let sessionId = t.sessionId;
      const known = sessionId && (this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId));
      if (!known) {
        sessionId = randomUUID();
        const cwd = s.codeRoots.find(p => this.deps.isDirectory ? this.deps.isDirectory(p) : true) || this.deps.fallbackCwd;
        const opts = { id: sessionId, cwd, title: '特战 · ' + short(t.title, 26), purpose: PURPOSE, autonomous: true, noInheritCursor: true,
          effort: s.effort, addDirs: s.codeRoots.filter(p => p !== cwd) };
        // 号池里有可用的号就走号池（自动挑进行中会话最少的号），并行的问题分散到不同账号；挑不出号时退回个人账号，问题不卡住。
        let created = null;
        let poolLanes = 0;
        try { poolLanes = s.usePool ? Number(this.deps.poolLanes?.()) || 0 : 0; } catch { poolLanes = 0; }
        if (poolLanes > 0) {
          try { created = await this.deps.createSession('codeagent', { ...opts, codeagentAccount: 'pool' }); }
          catch (error) { console.warn('[company-bridge] 号池开会话失败，改用个人账号：' + error.message); created = null; }
        }
        if (!created) created = await this.deps.createSession('codeagent', opts);
        if (!created || created.id !== sessionId) throw new Error('会话创建结果与预留编号不一致');
        // 开会话要十几秒：期间可能已解除配对。重新读一次，作废了就不再发问题。
        const latest = this.thread(t.id);
        if (!latest || latest.state === 'cancelled' || latest.gen !== this.link.gen()) { if (latest) this.saveThread({ ...latest, sessionId }); return; }
        t = this.saveThread({ ...latest, sessionId, everAnswered: false });
      } else if (!this.deps.getSession(sessionId)) {
        await this.deps.resumeSession(sessionId);
        if (!this.deps.getSession(sessionId)) throw new Error('原会话没能恢复');
        const latest = this.thread(t.id);
        if (!latest || latest.state === 'cancelled' || latest.gen !== this.link.gen()) return;
        t = latest;
      }
      const before = this.lastFinal(sessionId);
      const prompt = this.promptFor(t, r, s);
      // 先记下「已派发」和发前最后一条回答，再发：发送结果未知时不会被当成失败重发。
      t = this.patchRound(t, r.round, { sentAt: this.now(), firstSentAt: r.firstSentAt || this.now(), baseline: before ? before.id : null,
        promptFingerprint: receiptPromptFingerprint(prompt), receiptIssue: null, error: null, sendUncertain: null });
      const receipt = await this.deps.sendPrompt(sessionId, prompt, randomUUID());
      if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) {
        throw Object.assign(new Error(receipt?.error || '问题没有发进会话'), { notSent: true });
      }
      if (receipt.ok === false || receipt.sendStatus === 'stuck' || receipt.unconfirmed) this.patchRound(this.thread(t.id), r.round, { sendUncertain: true });
      if (!r.rewrite) void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'running', note: '公司 CodeAgent 正在处理' }).catch(() => {});
    } catch (error) {
      const fresh = this.thread(t.id) || t;
      this.saveThread({ ...fresh, rounds: fresh.rounds.map(x => x.round === r.round ? { ...x, sentAt: null, error: '公司这边没能开始：' + short(error.message, 160), failedAt: this.now() } : x) });
      if (fresh.gen === this.link.gen()) void this.link.send('status', { thread: t.id, gen: fresh.gen, round: r.round, state: 'error', note: '公司这边没能开始：' + short(error.message, 120) }).catch(() => {});
      this.notify('没能开始', `${t.id}：${short(error.message, 80)}`, fresh.sessionId);
    }
    this.changed();
  }

  async collect(t) {
    const r = t.rounds.find(x => roundPhase(x) === 'running');
    if (!r) { this.saveThread(t); return; }
    // 公司 Hub 远程重启前中断的轮次：等 hub-admin 恢复会话、发「继续」后再收（期间会话关着，不能按「会话已关闭」判失败）。
    if (r.resumePending) return;
    if (this.sessionBusy(t.sessionId)) return;
    const since = activeSince(r);
    const final = this.lastFinal(t.sessionId);
    // 发出结果未知、3 分钟后会话停着而原生记录文件都还没有：CodeAgent 确实没收到，重发一次（不会重复）。
    if (!final && r.sendUncertain && !r.resent && this.now() - r.sentAt > 3 * 60000) {
      const meta = this.deps.getSession(t.sessionId) || {};
      const missing = !meta.transcriptPath || !(this.deps.fileExists ? this.deps.fileExists(meta.transcriptPath) : require('node:fs').existsSync(meta.transcriptPath));
      if (missing) { this.patchRound(t, r.round, { sentAt: null, resent: true, sendUncertain: null }); return; }
    }
    if (!final || final.id === r.baseline) {
      // 发出 3 分钟后会话停着、还没有回答：核实提问真的写进了记录（Q-1016-02 第 5 轮发给了已退出的 CodeAgent，干等 30 分钟）。
      // 没写进去就重发一次（dispatch 会按需恢复会话）；重发后仍没写进去，直接报出来。
      if (!r.landed && this.now() - r.sentAt > VERIFY_MS) {
        const meta = this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId);
        let landed = null;
        try { landed = (this.deps.transcriptHasRequest || transcriptHasRequest)(meta, { ...r, threadId: t.id }); } catch { landed = null; }
        if (landed === true) t = this.patchRound(t, r.round, { landed: true });
        else if (landed === false) {
          if (!r.resent) {
            this.patchRound(t, r.round, { sentAt: null, resent: true, sendUncertain: null });
            this.notify('提问没送进去，重发一次', `${t.id} 第 ${r.round} 轮：发出 3 分钟后 CodeAgent 的记录里还没有这条提问`, t.sessionId);
            return;
          }
          return this.failRound(t, r, '提问没能送进公司的 CodeAgent（重发一次后它的记录里仍没有这条提问）；可在「AI特战队专用功能」里点重试，或追问重发');
        }
      }
      // CodeAgent 的原生记录还在写就是还在干活（长时间的编译、仿真）：会话表里查不到、或停摆超过 30 分钟都先别判失败，
      // 最多等 LONG_RUN_MS（2026-10-17 Q-1017-17/21：跑 AirView 的会话还在运行，10 分钟就被判成「会话已关闭」）。
      if (this.now() - r.sentAt < LONG_RUN_MS && this.transcriptFresh(t.sessionId)) return;
      // 远程重启后恢复、发了「继续」的轮次从恢复时间算（activeSince）。
      if (this.now() - since > NO_ANSWER_MS && !this.deps.getSession(t.sessionId)) return this.failRound(t, r, '会话已关闭，没有读到回答');
      if (this.now() - since > NO_ANSWER_MS * 3) return this.failRound(t, r, '会话停下了，但一直没读到回答');
      return;
    }
    if (this.promptCheck(t, r) === 'hijacked') {
      const n = (r.hijacked || 0) + 1;
      if (n > MAX_HIJACK) return this.failRound(t, r, '问题连续被公司电脑剪贴板里的图片顶掉（CodeAgent 粘贴时会读剪贴板）：清空剪贴板后在「AI特战队专用功能」里点重试');
      this.patchRound(t, r.round, { sentAt: null, hijacked: n });
      this.notify('问题被剪贴板图片顶掉', `${t.id}：CodeAgent 收到的图片与本轮任务不符；已保留记录并重新发问`, t.sessionId);
      return;
    }
    let receipt = null;
    if (this.deps.readReceipt) {
      const session = this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId);
      try { receipt = this.deps.readReceipt(session, { ...r, threadId: t.id }); }
      catch (error) { receipt = { available: false, issue: '原生回执核对失败：' + error.message }; }
      if (!receipt?.available) {
        const issue = receipt?.issue || '本次请求的原生回执尚未核对';
        if (this.now() - since > NO_ANSWER_MS * 3) return this.failRound(t, r, issue);
        if (r.receiptIssue !== issue) {
          this.patchRound(t, r.round, { receiptIssue: issue });
          this.notify('回执待核对', `${t.id}：${issue}；记录已保留，稍后会继续核对`, t.sessionId);
          void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'running', note: '回执待核对：' + issue }).catch(() => {});
          this.changed();
        }
        return;
      }
      if (r.receiptIssue) t = this.patchRound(t, r.round, { receiptIssue: null });
    }
    let text = String(receipt ? receipt.text : final.text || '').trim();
    if (sourceVerdict(text).tooMuch && !r.rewriteAsked) {
      // 第一次发现成段源码：请它自己改写（同一会话），改写稿出来再发。
      this.patchRound(t, r.round, { rewriteAsked: true, rewrite: true, sentAt: null, firstDraftChars: text.length });
      return;
    }
    await this.sendReply(t, r, text, receipt ? { userMessageId: receipt.userMessageId, sourceMessageIds: receipt.records.map(record => record.messageId) } : {});
  }
  // 把一轮的回答发回家：删超限的源码、截长、核对代次，落账和入发件箱同一个事务。collect 和补收共用。
  async sendReply(t, r, text, extraMeta = {}) {
    let removed = 0;
    if (sourceVerdict(text).tooMuch) {
      // 先删成段的；零散的小段累计仍超限，就把所有代码行都换掉。
      const first = stripCode(text, 3); text = first.text; removed = first.removed;
      if (sourceVerdict(text).tooMuch) { const second = stripCode(text, 0); text = second.text; removed += second.removed; }
    }
    if (text.length > MAX_REPLY_CHARS) text = text.slice(0, MAX_REPLY_CHARS) + `\n\n（回答超过 ${MAX_REPLY_CHARS} 字，后面截掉了；需要的话请追问后半部分。）`;
    // 发送前再核对代次：解除配对后答完的旧问题不会发给新的对端。
    const fresh = this.thread(t.id);
    if (!fresh || fresh.state === 'cancelled' || fresh.gen !== this.link.gen()) return;
    const session = this.deps.getSession(t.sessionId);
    const meta = { model: session?.currentModel?.id || session?.model || null, elapsedSec: Math.round((this.now() - (r.firstSentAt || r.sentAt || r.receivedAt || this.now())) / 1000), codeLinesRemoved: removed, rewritten: !!r.rewriteAsked, ...extraMeta };
    // 回答落账和回执入发件箱放在同一个事务：要么都成，要么都不成（下一轮再收）。之后发件箱负责重发。
    const item = this.link.prepare('reply', { thread: t.id, gen: fresh.gen, round: r.round, text, meta });
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.link.enqueue(item);
      this.saveThread({ ...fresh, everAnswered: true, rounds: fresh.rounds.map(x => x.round === r.round ? { ...x, reply: text, replyAt: this.now(), meta, error: null } : x) });
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      if (!r.queueFullNotified) { this.patchRound(fresh, r.round, { queueFullNotified: true }); this.notify('回执发不出去', `${t.id}：${short(error.message, 80)}`, t.sessionId); }
      return;
    }
    await this.link.flush().catch(() => {});
    const pending = (this.store.get('outbox') || []).some(x => x.mid === item.mid);
    this.notify(pending ? '回执待发送' : '已回执', pending
      ? `${t.id} 第 ${r.round} 轮已保存；连接恢复后会自动发送。`
      : `${t.id} 第 ${r.round} 轮：${short(text, 60)}`, t.sessionId);
  }
  // 家里要求「补收」（2026-10-16）：这一轮报了没答上或迟迟没回执，但公司会话里其实写了回答——直接把这一轮发出之后
  // 最新的那条回答取回，不让 CodeAgent 重答。已经有回答的，原样再发一次（家里可能没收到）。取回的文字开头注明来历。
  async recollect(message) {
    const t = this.thread(String(message.thread || ''));
    if (!t || t.state === 'cancelled' || t.gen !== this.link.gen() || (message.gen && message.gen !== t.gen)) return;
    const r = t.rounds.find(x => x.round === Number(message.round));
    if (!r) return;
    if (r.reply) return this.sendReply(t, r, r.reply, { ...(r.meta || {}), resentReply: true });
    if (t.sessionId && this.sessionBusy(t.sessionId)) {
      void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'running', note: '补收：公司会话还在作答，答完会照常回执' }).catch(() => {});
      return;
    }
    const meta = t.sessionId && (this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId));
    const since = (r.firstSentAt || r.sentAt || r.receivedAt || 0) - 5000;
    const finals = meta && this.deps.readFinals ? this.deps.readFinals(meta) : [];
    const latest = [...(finals || [])].reverse().find(f => (f.timestamp || 0) >= since && f.id !== r.baseline);
    if (!latest) {
      void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'error', note: '补收不到：公司会话里这一轮发出之后没有新的回答，可以追问重问' }).catch(() => {});
      return;
    }
    const note = '（补收：这是公司会话在这一轮发出之后写下的最新回答，按家里要求直接取回，没有逐条核对它对应哪条提问。）';
    this.notify('补收', `${t.id} 第 ${r.round} 轮：已从公司会话取回最新回答`, t.sessionId);
    return this.sendReply(this.thread(t.id) || t, r, note + '\n\n' + String(latest.text || '').trim(), { recollected: true });
  }
  // ok：收到的消息里有本题编号；hijacked：这一轮之后只收到过带图片、却没有编号的消息；unknown：读不到记录，照旧处理。
  promptCheck(t, r) {
    const meta = this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId) || {};
    if (!meta.transcriptPath) return 'unknown';
    const turns = (this.deps.readUserTurns || userTurnsFromTranscript)(meta.transcriptPath).filter(u => u.at >= (r.sentAt || 0) - 5000);
    if (turns.some(u => u.text.includes('编号 ' + t.id))) return 'ok';
    return turns.some(u => u.images > 0) ? 'hijacked' : 'unknown';
  }
  failRound(t, r, why) {
    this.patchRound(t, r.round, { error: why, failedAt: this.now() });
    void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'error', note: why }).catch(() => {});
    this.notify('没答上', `${t.id}：${why}`, t.sessionId);
  }
  // 页面上点「重试」：失败的那一轮重新排队（同一会话还在就续用）。
  retry(id) {
    const t = this.thread(id);
    if (!t) throw new Error('找不到这个问题');
    if (t.state === 'cancelled' || t.gen !== this.link.gen()) throw new Error('这个问题属于上一次配对，已作废');
    const rounds = t.rounds.map(x => x.error && !x.reply ? { ...x, error: null, sentAt: null, failedAt: null, baseline: null, hijacked: 0 } : x);
    this.saveThread({ ...t, rounds }); this.changed();
    void this.tick({ force: true });
    return this.status();
  }

  status() {
    const c = this.link.config(), st = this.link.status();
    return {
      ok: true, role: 'company', unlocked: this.unlocked(), settings: this.settings(), defaultInstructions: DEFAULT_INSTRUCTIONS, parallel: this.parallelLimitSafe(),
      link: { state: c.state || 'none', baseUrl: c.baseUrl || null, pairedAt: c.pairedAt || null, createdAt: c.createdAt || null, outbox: this.link.pendingOutbox() },
      net: { lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, gate: st.gate || null, peerSeen: st.peerSeen || null, autoGate: this.gatePass.status() },
      nextPullAt: this.nextPullAt, now: this.now(), polling: this.polling(),
      threads: this.threads().map(t => ({ ...t, session: t.sessionId ? { open: !!this.deps.getSession(t.sessionId), busy: this.sessionBusy(t.sessionId) } : null })),
      askHome: this.askHome.status(),
      images: this.images.status(),
      care: this.careState || null,
      hubAdmin: this.hubAdmin.status(),
    };
  }
  notify(title, text, sessionId = null) { try { this.deps.onNotify?.({ title: 'AI特战队 · ' + title, text, sessionId }); } catch {} }
  changed() { try { this.deps.onChanged?.(); } catch {} }
  close() { clearInterval(this.timer); this.timer = null; this.askHome.close(); try { this.store.close(); } catch {} }
}

module.exports = { CompanyBridge, DEFAULT_INSTRUCTIONS, V1_INSTRUCTIONS, V2_INSTRUCTIONS, V3_INSTRUCTIONS, PURPOSE, userTurnsFromTranscript, sourceVerdict, stripCode, deriveState };
