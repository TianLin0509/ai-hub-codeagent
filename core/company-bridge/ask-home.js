'use strict';
// 公司 CodeAgent 向家里求助，公司一端（2026-10-15 用户拍板）：公司 Hub 打开的 CodeAgent 会话带上 ask_home 工具（MCP，另有命令行兜底），
// 遇到难题时把问题交给家里 Hub；家里优先用 Claude、Claude 不行换 Codex 作答，必要时家里还会用「问公司」回来查证据，
// 所以一个来回通常 5–20 分钟，有时更久。回答到了，作为一条新消息送进发起求助的会话：停着就发，在忙就等，关了就先恢复。
// 外发的硬约束（用户 2026-10-15 定，不弹确认）：每次求助或追问的正文必须少于 2 万字，在本机接口这一关拦下，MCP 和命令行都绕不过去。
// 替家里办事的会话（purpose=company-bridge）不挂 ask_home：家里回公司查证据时不会再被转回家里，来回不会打转。
// 本机接口按会话发通行证（HMAC(本机密钥, 会话编号)）：会话只能以自己的身份求助、追问和查看。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, createHmac, timingSafeEqual, randomUUID } = require('node:crypto');

const MAX_OUTBOUND_CHARS = 20000; // 必须少于这个字数
const STATE_LABEL = { sent: '已发出', received: '家里已收到', running: '家里在处理', replied: '已回复', error: '家里没答上', cancelled: '已作废' };
const short = (s, n = 28) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const charCount = s => [...String(s || '')].length;

// 外发关口：正文少于 2 万字才放行（按字符数，中英文都算 1 个字）。
function checkOutbound(text, what) {
  const n = charCount(text);
  if (n >= MAX_OUTBOUND_CHARS) {
    throw new Error(`${what} ${n} 字，超过上限（必须少于 ${MAX_OUTBOUND_CHARS} 字），没有发出。请删掉不影响判断的内容（整段粘贴的大文件、完整日志、重复的背景），只留关键片段后重发`);
  }
  return n;
}
function replyMessage(t, r) {
  if (r.error) {
    return [`【家里回复 ${t.id} · 第 ${r.round} 轮 · 没答上】`, '', r.error, '', '——', '家里这一轮没有给出回答。可以用 followup_home 换个问法重问，或先按自己的判断继续，并在汇报里写明这一点。'].join('\n');
  }
  const who = r.meta?.agent === 'codex' ? 'Codex' : 'Claude';
  return [`【家里回复 ${t.id} · 第 ${r.round} 轮 · ${who}】`, '', r.reply, '', '——',
    `以上是家里 ${who} 的回复。请结合你在公司这边掌握的事实判断后采用；有疑问、和你看到的情况不符或需要更细的建议时，用 followup_home 追问（同一个家里会话，记得之前的讨论），次数不限，每次一个来回通常 5–20 分钟。`].join('\n');
}
function deriveState(t) {
  if (t.state === 'cancelled') return 'cancelled';
  const last = t.rounds[t.rounds.length - 1] || {};
  if (last.reply) return 'replied';
  if (last.error) return 'error';
  return last.status === 'running' ? 'running' : last.status === 'received' ? 'received' : 'sent';
}
const needsWork = t => t.state !== 'cancelled' && t.rounds.some(r => (!r.reply && !r.error) || ((r.reply || r.error) && !r.delivered));

class AskHome {
  constructor({ bridge, deps }) {
    this.bridge = bridge; this.deps = deps; this.link = bridge.link; this.store = bridge.store;
    this.dir = path.join(deps.dataDir, 'company-bridge');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS home_threads(id TEXT PRIMARY KEY,session TEXT,payload TEXT NOT NULL,state TEXT NOT NULL,open INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL)');
    this.endpointFile = path.join(this.dir, 'ask-home-endpoint.json');
    this.cliFile = path.join(this.dir, 'ask-home.cmd');
    let master = this.store.get('askHomeMaster');
    if (!master) { master = randomBytes(32).toString('hex'); this.store.set('askHomeMaster', master); }
    this.master = master; this.server = null;
  }
  now() { return this.bridge.now(); }

  // ---- 本机接口：MCP 与命令行都经它调用，凭会话通行证认身份 ----
  passFor(sessionId, imagesOnly = false) { return createHmac('sha256', this.master).update((imagesOnly ? 'images-only:' : 'ask-home:') + String(sessionId)).digest('hex'); }
  checkPass(sessionId, pass, imagesOnly = false) {
    if (!sessionId) return false;
    const a = Buffer.from(String(pass || '')), b = Buffer.from(this.passFor(sessionId, imagesOnly));
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async start() {
    this.server = http.createServer((req, res) => {
      const sessionId = String(req.headers['x-hub-home-link-session'] || '');
      const pass = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const imagesOnly = this.checkPass(sessionId, pass, true);
      if (req.method !== 'POST' || req.url !== '/tool' || (!imagesOnly && !this.checkPass(sessionId, pass))) { res.writeHead(403); res.end(); return; }
      req.setEncoding('utf8');
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 400000) req.destroy(); });
      req.on('end', async () => {
        try { const request = JSON.parse(body); const result = await this.invoke({ ...request, callerSessionId: sessionId, imagesOnly }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); }
        catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: error.message })); }
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.server.unref();
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.endpointFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ url: `http://127.0.0.1:${this.server.address().port}/tool` }), { mode: 0o600 });
    fs.renameSync(tmp, this.endpointFile);
    // 命令行兜底：公司版是打包的，脚本在 app.asar 里，只能由 Hub 自己的程序以 Node 方式运行。
    const runner = this.runner();
    fs.writeFileSync(this.cliFile, ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `"${runner.command}" "${runner.cli}" %*`, ''].join('\r\n'));
  }
  runner() {
    return { command: this.deps.nodeExecutable || process.execPath,
      mcp: this.deps.mcpScript || path.resolve(__dirname, '../../scripts/ask-home-mcp.js'),
      cli: this.deps.cliScript || path.resolve(__dirname, '../../scripts/ask-home.js') };
  }

  // ---- 挂到会话上：配对后 Hub 打开的 CodeAgent 会话都带 ask_home（MCP）和命令行通行证 ----
  sessionPlan({ kind, opts = {}, id }) {
    if (!this.link.paired() || !id) return null;
    const base = String(kind || '').replace(/-resume$/, '');
    if (!require('../ai-kinds').isCodeAgentKind(base)) return null;
    // 公司助理会话读的是本人 WeLink 数据、论坛摘要会话读的是公司论坛内容，都只留在这台电脑：不挂「问家里」。
    if (opts.purpose === 'company-assistant' || opts.purpose === 'company-forum') return null;
    const imagesOnly = opts.purpose === 'company-bridge';
    if (imagesOnly && !this.bridge.images?.available()) return null;
    const pass = this.passFor(id, imagesOnly), runner = this.runner();
    const env = { HUB_HOME_LINK_SESSION_ID: id, HUB_HOME_LINK_PASS: pass, HUB_HOME_LINK_ENDPOINT_FILE: this.endpointFile, HUB_ASK_HOME_CMD: this.cliFile, ...(imagesOnly ? { HUB_HOME_LINK_IMAGES_ONLY: '1' } : {}) };
    return { env, mcp: { name: 'home_bridge', command: runner.command, args: [runner.mcp], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } } };
  }

  threads(limit = 60) { return this.store.db.prepare('SELECT payload FROM home_threads ORDER BY updated DESC LIMIT ?').all(limit).map(r => JSON.parse(r.payload)); }
  openThreads() { return this.store.db.prepare('SELECT payload FROM home_threads WHERE open=1 ORDER BY updated').all().map(r => JSON.parse(r.payload)); }
  thread(id) { const r = this.store.db.prepare('SELECT payload FROM home_threads WHERE id=?').get(id); return r ? JSON.parse(r.payload) : null; }
  saveThread(t) {
    t.updatedAt = this.now(); t.state = deriveState(t);
    this.store.db.prepare('INSERT INTO home_threads(id,session,payload,state,open,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session=excluded.session,payload=excluded.payload,state=excluded.state,open=excluded.open,updated=excluded.updated')
      .run(t.id, t.sessionId, JSON.stringify(t), t.state, needsWork(t) ? 1 : 0, t.updatedAt);
    return t;
  }
  nextThreadId() {
    const d = new Date(this.now() + 8 * 3600000);
    const day = String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
    const counter = this.store.get('askHomeCounter') || {};
    let n = counter.day === day ? counter.n + 1 : 1;
    while (this.thread(`H-${day}-${String(n).padStart(2, '0')}`)) n += 1;
    this.store.set('askHomeCounter', { day, n });
    return `H-${day}-${String(n).padStart(2, '0')}`;
  }
  cancelOpen(why) {
    for (const t of this.openThreads()) this.saveThread({ ...t, state: 'cancelled', cancelNote: why, rounds: t.rounds.map(r => (r.reply || r.error) ? r : { ...r, status: 'cancelled' }) });
  }

  // ---- 工具 ----
  async invoke(request) {
    const sessionId = String(request.callerSessionId || '');
    const args = request.arguments || {};
    if (!sessionId) throw new Error('无法识别发起求助的会话');
    if (!this.link.paired()) throw new Error('这台电脑还没和家里配对：先在「设置菜单 → AI特战队专用功能」里配对');
    if (!this.deps.getSession(sessionId) && !this.deps.getSessionMetadata?.(sessionId)) throw new Error('发起求助的会话已不在 Hub 里，回复无处投递');
    if (request.name === 'send_image_home') return this.bridge.images.send(sessionId, args);
    if (request.name === 'home_images') return { images: this.bridge.images.view(sessionId, args.thread) };
    const meta = this.meta(sessionId);
    if (request.imagesOnly || meta.purpose === 'company-bridge' || meta.opts?.purpose === 'company-bridge') throw new Error('这个查询会话只开放图片工具，不能再次向家里求助');
    if (request.name === 'ask_home') return this.ask(sessionId, args);
    if (request.name === 'followup_home') return this.followup(sessionId, args);
    if (request.name === 'home_thread') return this.view(sessionId, args);
    throw new Error('未知工具');
  }
  meta(sessionId) { return this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId) || {}; }
  async ask(sessionId, { question, title }) {
    question = String(question || '').trim();
    if (question.length < 10) throw new Error('求助内容太短：请写清背景、要决定什么、已经试过什么和结果、希望得到什么样的答复');
    const chars = checkOutbound(question, '求助内容');
    const id = this.nextThreadId(), m = this.meta(sessionId), gen = this.link.gen();
    const t = { id, sessionId, sessionTitle: m.title || null, title: short(title || question, 40), gen, createdAt: this.now(),
      rounds: [{ round: 1, question, chars, sentAt: this.now(), status: 'sent' }] };
    await this.link.send('home-ask', { thread: id, gen, round: 1, title: t.title, question, from: { title: m.title || null } });
    this.saveThread(t);
    this.bridge.tightenPoll();
    this.bridge.changed();
    return { thread: id, status: '已发出', chars, ...this.peer(),
      next: '家里的 Claude 作答（不可用时换 Codex），需要公司这边的事实时还会回来查，一个来回通常 5–20 分钟，有时更久。回复到了会作为一条新消息自动发到本会话：现在请结束本轮，或先做不依赖回复的工作，不要循环等待。' };
  }
  async followup(sessionId, { thread, question }) {
    const t = this.thread(String(thread || ''));
    if (!t || t.sessionId !== sessionId) throw new Error(t ? '这个编号属于另一个会话，不能在这里追问' : '找不到编号 ' + thread);
    if (t.state === 'cancelled' || t.gen !== this.link.gen()) throw new Error('这个编号属于上一次配对，已作废；请用 ask_home 重新求助');
    question = String(question || '').trim();
    if (question.length < 4) throw new Error('追问内容太短');
    const chars = checkOutbound(question, '追问内容');
    const pending = t.rounds.find(r => !r.reply && !r.error);
    if (pending) throw new Error(`第 ${pending.round} 轮还没回复，等它回来再追问`);
    const round = t.rounds.length + 1;
    await this.link.send('home-followup', { thread: t.id, gen: t.gen, round, question });
    this.saveThread({ ...t, rounds: [...t.rounds, { round, question, chars, sentAt: this.now(), status: 'sent' }] });
    this.bridge.tightenPoll();
    this.bridge.changed();
    return { thread: t.id, round, status: '已发出', chars, ...this.peer(), next: '回复到了会作为新消息自动发到本会话，现在请结束本轮。' };
  }
  view(sessionId, { thread }) {
    let list;
    if (thread) {
      const t = this.thread(String(thread));
      if (!t || t.sessionId !== sessionId) throw new Error('找不到本会话的编号 ' + thread);
      list = [t];
    } else list = this.store.db.prepare('SELECT payload FROM home_threads WHERE session=? ORDER BY updated DESC LIMIT 10').all(sessionId).map(r => JSON.parse(r.payload));
    return { ...this.peer(), threads: list.map(t => ({ thread: t.id, title: t.title, state: STATE_LABEL[t.state] || t.state,
      rounds: t.rounds.map(r => ({ round: r.round, question: r.question, status: STATE_LABEL[r.status] || r.status, note: r.note || null, reply: r.reply || null, error: r.error || null })) })) };
  }
  peer() {
    const st = this.link.status();
    const seen = st.peerSeen ? Date.parse(st.peerSeen) : null;
    const minutes = seen ? Math.max(0, Math.round((this.now() - seen) / 60000)) : null;
    return { homeOnline: minutes != null && minutes <= 3, homeLastSeen: minutes == null ? '还没在线过' : minutes <= 1 ? '刚刚在线' : `${minutes} 分钟前在线` };
  }

  // 家里的进度和回复；不是这两类消息返回 false，交回 CompanyBridge 处理。
  receive(message) {
    if (message.type !== 'home-status' && message.type !== 'home-reply') return false;
    const t = this.thread(String(message.thread || ''));
    if (!t || t.state === 'cancelled' || (message.gen && t.gen && message.gen !== t.gen)) return true;
    const round = Number(message.round) || 0;
    let changed = false;
    const rounds = t.rounds.map(r => {
      if (r.round !== round || r.reply) return r;
      if (message.type === 'home-status') {
        changed = true;
        if (message.state === 'error') return { ...r, status: 'error', error: String(message.note || '家里报错'), errorAt: this.now(), delivered: false, nextTryAt: null };
        return { ...r, status: message.state === 'running' ? 'running' : 'received', note: message.note || null };
      }
      // 同一轮只收第一份回复（发件箱重发、服务端重放都不会让它再投递一次）。
      changed = true;
      return { ...r, status: 'replied', reply: String(message.text || ''), replyMid: message.mid, replyAt: this.now(), meta: message.meta || null, error: null, delivered: false, nextTryAt: null };
    });
    if (!changed) return true;
    this.saveThread({ ...t, rounds });
    if (message.type === 'home-reply') this.bridge.notify('家里回复了', `${t.id} 第 ${round} 轮：${short(message.text, 60)}`, t.sessionId);
    else if (message.note) this.bridge.notify('求助进度', `${t.id}：${short(message.note, 80)}`, t.sessionId);
    this.bridge.changed();
    return true;
  }

  // 把回复送回发起求助的会话：停着就发，在忙就等，关着就先恢复。
  async deliver() {
    for (const t of this.openThreads()) {
      if (t.state === 'cancelled') continue;
      for (const r of t.rounds.filter(x => (x.reply || x.error) && !x.delivered && !(x.nextTryAt > this.now()))) {
        try {
          let session = this.deps.getSession(t.sessionId);
          if (!session) {
            const stored = this.deps.getSessionMetadata?.(t.sessionId);
            if (!stored || !this.deps.resumeSession) { this.markDelivery(t, r, { deliveryError: '发起求助的会话已不存在，回复留在「AI特战队专用功能」列表里' }); continue; }
            await this.deps.resumeSession(t.sessionId);
            session = this.deps.getSession(t.sessionId);
            if (!session) { this.markDelivery(t, r, { deliveryError: '发起求助的会话没能恢复，稍后重试' }, false); continue; }
          }
          if (this.bridge.sessionBusy(t.sessionId)) continue;
          const receipt = await this.deps.sendPrompt(t.sessionId, replyMessage(t, r), randomUUID());
          // 明确没发进去才算失败；确认迟到、结果未知都按已送达，不重发（重发会让 Agent 收到两遍）。
          if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) throw new Error(receipt?.error || '没有发进会话');
          this.markDelivery(t, r, { delivered: true, deliveredAt: this.now(), deliveryError: null, deliveryUncertain: receipt.ok === false || null });
        } catch (error) {
          this.markDelivery(t, r, { deliveryError: error.message }, false);
        }
      }
    }
  }
  markDelivery(t, r, patch, final = true) {
    const fresh = this.thread(t.id) || t;
    const rounds = fresh.rounds.map(x => x.round === r.round
      ? { ...x, ...patch, ...(final && !patch.delivered ? { delivered: true, deliveredAt: null } : {}), nextTryAt: final ? null : this.now() + 60000 } : x);
    this.saveThread({ ...fresh, rounds }); this.bridge.changed();
  }
  status() {
    return this.threads(60).map(t => ({ ...t, session: { open: !!this.deps.getSession(t.sessionId), title: this.meta(t.sessionId).title || t.sessionTitle || null } }));
  }
  close() { try { this.server?.close(); } catch {} }
}

module.exports = { AskHome, MAX_OUTBOUND_CHARS, checkOutbound, replyMessage, deriveState };
