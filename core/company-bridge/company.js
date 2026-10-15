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
const { receiptPromptFingerprint } = require('./receipt-reader');
// 反方向（这台电脑上的 CodeAgent 用 ask_home 向家里求助）由 ask-home.js 处理，共用这条通道和数据库。
const { AskHome } = require('./ask-home');

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
const DEFAULT_SETTINGS = Object.freeze({ enabled: true, codeRoots: [], instructions: DEFAULT_INSTRUCTIONS, effort: 'high', maxParallel: 2, pollSeconds: 30 });
const ACTIVE_POLL_MS = 10000;
const FOLLOWUP_WINDOW_MS = 10 * 60000;
const EFFORTS = ['low', 'medium', 'high', 'max'];
const MAX_REPLY_CHARS = 40000;
// 源码检查的限度：成段（连续）超过 12 行，或全篇累计超过 30 行像代码的内容。
const MAX_CODE_RUN = 12;
const MAX_CODE_TOTAL = 30;
// 发出后会话停下、却一直没读到回答：判定没答上，告诉家里。
const NO_ANSWER_MS = 10 * 60000;
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
    if (!deps.noTimer) claimTimers(this.store);
  }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  settings() {
    const { model: _oldModel, ...s } = this.store.get('settings') || {}; // 旧版存过模型，现在不用
    const instructions = !s.instructions || OLD_DEFAULTS.includes(s.instructions.trim()) ? DEFAULT_INSTRUCTIONS : s.instructions;
    return { ...DEFAULT_SETTINGS, ...s, instructions, codeRoots: Array.isArray(s.codeRoots) ? s.codeRoots : [] };
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
    if ('maxParallel' in patch) { const n = Number(patch.maxParallel); if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('同时处理的问题数只能是 1–4'); next.maxParallel = n; }
    if ('pollSeconds' in patch) { const n = Number(patch.pollSeconds); if (!Number.isInteger(n) || n < 10 || n > 600) throw new Error('检查间隔只能是 10–600 秒'); next.pollSeconds = n; }
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
        this.changed();
      }
    })().finally(() => { this.busy = null; });
    await this.busy;
    if (this.settings().enabled && this.link.paired()) {
      if (!this.advanceBusy) this.advanceBusy = this.advance().finally(() => { this.advanceBusy = null; });
      await this.advanceBusy;
    }
    // 家里对 ask_home 的回复：和「自动作答」开关无关，配对了就送。
    if (this.link.paired()) {
      if (!this.deliverBusy) this.deliverBusy = this.askHome.deliver().finally(() => { this.deliverBusy = null; });
      await this.deliverBusy;
    }
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
    if (message.type === 'welcome') {
      if (this.link.completeAsCompany(message)) this.notify('配对已完成', 'AI特战队专用功能已接通。');
      return;
    }
    if (this.askHome.receive(message)) return;
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
    let free = s.maxParallel - this.openThreads().filter(x => x.state === 'running').length;
    for (const t of this.openThreads().filter(x => x.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)) {
      if (free <= 0) break;
      if (t.sessionId && this.sessionBusy(t.sessionId)) continue; // 追问时原会话还在忙（例如改写上一轮），等它停下
      await this.dispatch(t);
      free -= 1;
    }
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
        const opts = { id: sessionId, cwd, title: 'AI特战队 · ' + short(t.title, 22), purpose: PURPOSE, autonomous: true, noInheritCursor: true,
          effort: s.effort, addDirs: s.codeRoots.filter(p => p !== cwd) };
        const created = await this.deps.createSession('codeagent', opts);
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
    if (this.sessionBusy(t.sessionId)) return;
    const final = this.lastFinal(t.sessionId);
    // 发出结果未知、3 分钟后会话停着而原生记录文件都还没有：CodeAgent 确实没收到，重发一次（不会重复）。
    if (!final && r.sendUncertain && !r.resent && this.now() - r.sentAt > 3 * 60000) {
      const meta = this.deps.getSession(t.sessionId) || {};
      const missing = !meta.transcriptPath || !(this.deps.fileExists ? this.deps.fileExists(meta.transcriptPath) : require('node:fs').existsSync(meta.transcriptPath));
      if (missing) { this.patchRound(t, r.round, { sentAt: null, resent: true, sendUncertain: null }); return; }
    }
    if (!final || final.id === r.baseline) {
      if (this.now() - r.sentAt > NO_ANSWER_MS && !this.deps.getSession(t.sessionId)) return this.failRound(t, r, '会话已关闭，没有读到回答');
      if (this.now() - r.sentAt > NO_ANSWER_MS * 3) return this.failRound(t, r, '会话停下了，但一直没读到回答');
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
        if (this.now() - r.sentAt > NO_ANSWER_MS * 3) return this.failRound(t, r, issue);
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
    const meta = { model: session?.currentModel?.id || session?.model || null, elapsedSec: Math.round((this.now() - (r.firstSentAt || r.sentAt)) / 1000), codeLinesRemoved: removed, rewritten: !!r.rewriteAsked,
      ...(receipt ? { userMessageId: receipt.userMessageId, sourceMessageIds: receipt.records.map(record => record.messageId) } : {}) };
    // 回答落账和回执入发件箱放在同一个事务：要么都成，要么都不成（下一轮再收）。之后发件箱负责重发。
    const item = this.link.prepare('reply', { thread: t.id, gen: fresh.gen, round: r.round, text, meta });
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.link.enqueue(item);
      this.saveThread({ ...fresh, everAnswered: true, rounds: fresh.rounds.map(x => x.round === r.round ? { ...x, reply: text, replyAt: this.now(), meta } : x) });
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
      ok: true, role: 'company', settings: this.settings(), defaultInstructions: DEFAULT_INSTRUCTIONS,
      link: { state: c.state || 'none', baseUrl: c.baseUrl || null, pairedAt: c.pairedAt || null, createdAt: c.createdAt || null, outbox: this.link.pendingOutbox() },
      net: { lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, gate: st.gate || null, peerSeen: st.peerSeen || null },
      nextPullAt: this.nextPullAt, now: this.now(), polling: this.polling(),
      threads: this.threads().map(t => ({ ...t, session: t.sessionId ? { open: !!this.deps.getSession(t.sessionId), busy: this.sessionBusy(t.sessionId) } : null })),
      askHome: this.askHome.status(),
    };
  }
  notify(title, text, sessionId = null) { try { this.deps.onNotify?.({ title: 'AI特战队 · ' + title, text, sessionId }); } catch {} }
  changed() { try { this.deps.onChanged?.(); } catch {} }
  close() { clearInterval(this.timer); this.timer = null; this.askHome.close(); try { this.store.close(); } catch {} }
}

module.exports = { CompanyBridge, DEFAULT_INSTRUCTIONS, V1_INSTRUCTIONS, V2_INSTRUCTIONS, V3_INSTRUCTIONS, PURPOSE, userTurnsFromTranscript, sourceVerdict, stripCode, deriveState };
