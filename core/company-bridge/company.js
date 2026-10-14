'use strict';
// 公司 Hub 一端的常驻助理（2026-10-15）：像脚本一样定时去通道里取家里的问题，
// 每个问题新开一个 CodeAgent 会话只读代码作答，答完自动发回；同一问题的追问送进同一个会话，
// 它记得上一轮读过什么。家里一个 Agent 对应这里一个 CodeAgent 会话，不同问题之间上下文互不干扰。
//
// 只读不靠提示词：会话以 purpose=company-bridge 启动，Hub 在启动参数上禁用命令行与改写类工具、
// 不加载 MCP（core/session-manager.js 的 buildCodeAgentPtyLaunch）。说明里再写一遍规则（页面上可以改）。
// 发回前查源码：围栏代码块、无围栏的代码行、压成一行的代码都算；超过限度先请它改写，改完仍超就删掉那几段再发。
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AssistantStore } = require('../hub-assistant/store');
const { claimTimers, ownsTimers } = require('../hub-assistant/timer-owner');
const { BridgeLink } = require('./link');

const PURPOSE = 'company-bridge';
const DEFAULT_INSTRUCTIONS = [
  '你是公司电脑上的代码阅读助手，替家里的 Agent 回答关于公司代码的问题。请遵守：',
  '1. 只读代码：可以打开、搜索、阅读文件；不运行程序或测试，不修改、新建、删除任何文件，不提交。',
  '2. 不回传源码：用文字和简短伪代码讲清逻辑，不成段粘贴源码。可以写函数名、文件相对路径和行号，方便对方追问。',
  '3. 先写结论，再逐条说明；分清「读到了」和「推测」。',
  '4. 末尾写「把握程度」（高 / 中 / 低及原因）和「没读到的部分」。',
  '5. 篇幅控制在 2 万字以内。',
].join('\n');
const DEFAULT_SETTINGS = Object.freeze({ enabled: true, codeRoots: [], instructions: DEFAULT_INSTRUCTIONS, model: '', effort: 'high', maxParallel: 2, pollSeconds: 30 });
const EFFORTS = ['low', 'medium', 'high', 'max'];
const MAX_REPLY_CHARS = 40000;
// 源码检查的限度：成段（连续）超过 12 行，或全篇累计超过 30 行像代码的内容。
const MAX_CODE_RUN = 12;
const MAX_CODE_TOTAL = 30;
// 发出后会话停下、却一直没读到回答：判定没答上，告诉家里。
const NO_ANSWER_MS = 10 * 60000;
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
    this.busy = null; this.timer = null; this.nextPullAt = 0;
    if (!deps.noTimer) claimTimers(this.store);
  }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  settings() {
    const s = this.store.get('settings') || {};
    return { ...DEFAULT_SETTINGS, ...s, codeRoots: Array.isArray(s.codeRoots) ? s.codeRoots : [] };
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
    if ('model' in patch) next.model = String(patch.model || '').trim().slice(0, 96);
    if ('effort' in patch) { if (!EFFORTS.includes(patch.effort)) throw new Error('思考深度只能是 low / medium / high / max'); next.effort = patch.effort; }
    if ('maxParallel' in patch) { const n = Number(patch.maxParallel); if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('同时处理的问题数只能是 1–4'); next.maxParallel = n; }
    if ('strictReadOnly' in patch) require('./strict').setStrict(patch.strictReadOnly !== false);
    if ('pollSeconds' in patch) { const n = Number(patch.pollSeconds); if (!Number.isInteger(n) || n < 10 || n > 600) throw new Error('检查间隔只能是 10–600 秒'); next.pollSeconds = n; }
    this.store.set('settings', next); this.changed();
    return next;
  }

  threads(limit = 60) { return this.store.db.prepare('SELECT payload FROM bridge_threads ORDER BY updated DESC LIMIT ?').all(limit).map(r => JSON.parse(r.payload)); }
  openThreads() { return this.store.db.prepare('SELECT payload FROM bridge_threads WHERE open=1 ORDER BY updated').all().map(r => JSON.parse(r.payload)); }
  thread(id) { const r = this.store.db.prepare('SELECT payload FROM bridge_threads WHERE id=?').get(id); return r ? JSON.parse(r.payload) : null; }
  saveThread(t) {
    t.updatedAt = this.now(); t.state = deriveState(t);
    this.store.db.prepare('INSERT INTO bridge_threads(id,payload,state,open,updated) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state,open=excluded.open,updated=excluded.updated')
      .run(t.id, JSON.stringify(t), t.state, ['queued', 'running'].includes(t.state) ? 1 : 0, t.updatedAt);
    return t;
  }
  patchRound(t, round, patch) { return this.saveThread({ ...t, rounds: t.rounds.map(x => x.round === round ? { ...x, ...patch } : x) }); }

  start() {
    if (this.deps.noTimer || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(e => console.warn('[company-bridge] tick', e.message)); }, 5000);
    this.timer.unref?.();
  }
  async tick({ force = false } = {}) {
    if (!force && !this.deps.noTimer && !ownsTimers(this.store)) return;
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const s = this.settings(), state = this.link.config().state;
      if (!state || state === 'none') return;
      if (this.link.pairingExpired()) { this.link.unpair(); this.notify('配对已过期', '24 小时内家里没有确认，请让家里重新生成配对码。'); this.changed(); return; }
      if (force || this.now() >= this.nextPullAt) {
        this.nextPullAt = this.now() + (state === 'paired' ? s.pollSeconds : 15) * 1000;
        try { await this.link.pull(message => this.receive(message)); } catch {}
        this.changed();
      }
      if (s.enabled && this.link.paired()) await this.advance();
    })().finally(() => { this.busy = null; });
    return this.busy;
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
  cancelOpen(why) { for (const t of this.openThreads()) this.saveThread({ ...t, state: 'cancelled', cancelNote: why }); }

  receive(message) {
    if (message.type === 'welcome') {
      if (this.link.completeAsCompany(message)) this.notify('已和家里接通', '家里的 Agent 现在可以向这台电脑提问了。');
      return;
    }
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
    this.notify(existing ? '家里追问' : '家里提问', `${id}：${short(question, 60)}`, t.sessionId);
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
    if (r.rewrite) return '你上一条回答里有成段的源码。按规则不能回传源码：请把整份回答重写一遍，代码部分改成文字说明或几行伪代码，其余内容保持。直接输出重写后的完整回答。';
    const roots = s.codeRoots.length ? s.codeRoots.map(p => '- ' + p).join('\n') : '- （未设置，请在当前目录里找）';
    if (r.round === 1 || !t.everAnswered) {
      return [s.instructions, '', '代码位置：', roots, '', `## 家里的问题（编号 ${t.id}${r.round > 1 ? `，第 ${r.round} 轮` : ''}）`, '', r.question].join('\n');
    }
    return [`## 家里的追问（编号 ${t.id}，第 ${r.round} 轮）`, '', r.question, '', '（规则同前：只读代码、不回传源码、末尾写把握程度和没读到的部分。）'].join('\n');
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
        const opts = { id: sessionId, cwd, title: '家里 · ' + short(t.title, 22), purpose: PURPOSE, autonomous: true, noInheritCursor: true,
          effort: s.effort, ...(s.model ? { model: s.model } : {}), addDirs: s.codeRoots.filter(p => p !== cwd) };
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
      // 先记下「已派发」和发前最后一条回答，再发：发送结果未知时不会被当成失败重发。
      t = this.patchRound(t, r.round, { sentAt: this.now(), firstSentAt: r.firstSentAt || this.now(), baseline: before ? before.id : null, error: null, sendUncertain: null });
      const receipt = await this.deps.sendPrompt(sessionId, this.promptFor(t, r, s), randomUUID());
      if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) {
        throw Object.assign(new Error(receipt?.error || '问题没有发进会话'), { notSent: true });
      }
      if (receipt.ok === false || receipt.sendStatus === 'stuck' || receipt.unconfirmed) this.patchRound(this.thread(t.id), r.round, { sendUncertain: true });
      if (!r.rewrite) void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'running', note: '公司 CodeAgent 正在读代码' }).catch(() => {});
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
    let text = String(final.text || '').trim();
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
    const meta = { model: session?.currentModel?.id || session?.model || null, elapsedSec: Math.round((this.now() - (r.firstSentAt || r.sentAt)) / 1000), codeLinesRemoved: removed, rewritten: !!r.rewriteAsked };
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
    this.notify('已回执', `${t.id} 第 ${r.round} 轮：${short(text, 60)}`, t.sessionId);
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
    const rounds = t.rounds.map(x => x.error && !x.reply ? { ...x, error: null, sentAt: null, failedAt: null, baseline: null } : x);
    this.saveThread({ ...t, rounds }); this.changed();
    void this.tick({ force: true });
    return this.status();
  }

  status() {
    const c = this.link.config(), st = this.link.status();
    return {
      ok: true, role: 'company', settings: { ...this.settings(), strictReadOnly: require('./strict').strictEnabled() }, defaultInstructions: DEFAULT_INSTRUCTIONS,
      link: { state: c.state || 'none', baseUrl: c.baseUrl || null, pairedAt: c.pairedAt || null, createdAt: c.createdAt || null, outbox: this.link.pendingOutbox() },
      net: { lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, gate: st.gate || null, peerSeen: st.peerSeen || null },
      nextPullAt: this.nextPullAt, now: this.now(),
      threads: this.threads().map(t => ({ ...t, session: t.sessionId ? { open: !!this.deps.getSession(t.sessionId), busy: this.sessionBusy(t.sessionId) } : null })),
      models: this.deps.modelOptions ? this.deps.modelOptions() : [],
    };
  }
  notify(title, text, sessionId = null) { try { this.deps.onNotify?.({ title: '家里联动 · ' + title, text, sessionId }); } catch {} }
  changed() { try { this.deps.onChanged?.(); } catch {} }
  close() { clearInterval(this.timer); this.timer = null; try { this.store.close(); } catch {} }
}

module.exports = { CompanyBridge, DEFAULT_INSTRUCTIONS, PURPOSE, sourceVerdict, stripCode, deriveState };
