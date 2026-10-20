'use strict';
// 手机 WeLink 对话（2026-10-18 用户定）：手机上永远只和公司「助理」说话，助理用 hub-tools.js 的工具去管其他会话。
//   通道：用户自己在手机上建的专用群（拉小微助手和一位同事建群，再把同事移出，只剩本人和小微助手），在助理设置「手机」页选中。
//   收：每 3 秒查一次这个群的新消息。welink-cli 没有推送，只能查；公司实测 2–5 秒一次、66 次全成功不限频（Q-1018-04）。
//   发：Hub 只往这个群发文字（welink.js 的 sendAllowed 只放行选定的群号）；助理会话本身仍然只读、不发消息。
//   防误触发（借鉴同事的 WeRemoteControl）：只认本人账号发的；Hub 自己发的都带「【助理】」开头并记下，不当成指令；
//     同一条只处理一次；超过 120 秒的旧消息不执行（Hub 重启时不补跑积压）；每分钟最多 20 条。
//   推送：助理发过话、新建的会话（或让它盯的）答完或卡住时推到群里；其他会话卡住时也推，但电脑前 5 分钟内有人操作就不推。
const crypto = require('node:crypto');
const welink = require('./welink');

const PREFIX = '【助理】';
const DEFAULT_PHONE = Object.freeze({ enabled: false, groupId: '', groupName: '', pushWatched: true, pushStuck: true, since: 0 });
const POLL_MS = 3000, WATCH_TICK_MS = 10000;
const FRESH_MS = 120000, RATE_PER_MIN = 20, CHUNK = 1500, ACK_MS = 20000, AT_DESK_S = 300, WATCH_TTL_MS = 24 * 3600000;
const PHONE_NOTE = '（这句是我在手机 WeLink 上发的，你的回答会由 Hub 发回我手机：先说结论，尽量 300 字以内，不用表格。）';
const WELCOME = '手机对话已接通。在这个群里直接跟我说话就行，例如「现在有哪些会话在跑？」「让某某会话接着做，做完告诉我」。会话做完或卡住时我也会在这里提醒你。';

const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
// 截短但保留换行（推到手机的会话回答要分段好读）。
const clip = (s, n) => { s = String(s ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const digest = t => crypto.createHash('sha256').update(String(t || '').replace(/\s+/g, '')).digest('hex').slice(0, 16);
// 手机上看 Markdown 符号很乱：去掉加粗、标题井号、代码围栏，保留换行和列表。
function plain(md) {
  return String(md || '').replace(/\r/g, '').replace(/^```[^\n]*\n?/gm, '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/`([^`\n]+)`/g, '$1').replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1（$2）').replace(/\n{3,}/g, '\n\n').trim();
}
// 长回答按段落切成几条（单条上限没实测过，按 1500 字保守切）。
function chunks(text, max = CHUNK) {
  const out = []; let cur = '';
  for (const para of String(text || '').split(/\n/)) {
    let p = para;
    while (p.length > max) { if (cur) { out.push(cur); cur = ''; } out.push(p.slice(0, max)); p = p.slice(max); }
    if ((cur ? cur.length + 1 : 0) + p.length > max) { out.push(cur); cur = p; } else cur = cur ? cur + '\n' + p : p;
  }
  if (cur.trim()) out.push(cur);
  return out.filter(x => x.trim());
}

class PhoneChannel {
  constructor(assistant, deps = {}) {
    this.a = assistant; this.deps = deps; this.now = assistant.now;
    this.timers = []; this.polling = false; this.watching = false; this.outbox = Promise.resolve(); this.backoffUntil = 0;
  }
  settings() { return { ...DEFAULT_PHONE, ...(this.a.settings().phone || {}) }; }
  active() { const p = this.settings(); return !!(p.enabled && p.groupId); }
  state() { return { cursor: '', cursorGroup: '', me: '', meAt: 0, sent: [], seen: [], inbound: [], log: [], watches: {}, stuck: {}, pending: {}, lastPollAt: null, lastOkAt: null, lastError: '', groupCheck: null, ...this.a.read('phone.json', {}) }; }
  save(patch) { const s = { ...this.state(), ...patch }; this.a.write('phone.json', s); return s; }
  // 读、改、存一气呵成（中间没有 await）：收消息、盯会话、助理工具三处都会改这份状态，不能拿旧副本覆盖别人的改动。
  update(fn) { return this.save(fn(this.state())); }
  note(dir, text, kind = '') {
    const st = this.state();
    this.save({ log: [{ at: this.now(), dir, kind, text: short(text, 300) }, ...st.log].slice(0, 40) });
    this.a.changed();
  }

  start() {
    if (this.deps.noTimer) return;
    this.timers.push(setInterval(() => { void this.poll().catch(() => {}); }, POLL_MS));
    this.timers.push(setInterval(() => { void this.watchTick().catch(e => console.warn('[company-phone] watch', e.message)); }, WATCH_TICK_MS));
  }
  close() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  // 本人账号：取数时 auth status 读到的 UID；群里只有它发的消息才交给助理。
  async me() {
    const snap = this.a.snapshot();
    if (snap?.login?.ok && snap.login.uid) return snap.login.uid;
    const st = this.state();
    if (st.me && this.now() - st.meAt < 3600000) return st.me;
    const r = await this.a.welink(['auth', 'status']);
    const login = welink.loginState(r.stdout + '\n' + r.stderr);
    if (!login.ok || !login.uid) throw new Error('WeLink 没登录或登录过期，手机对话暂停；在助理页扫码登录后自动恢复');
    this.save({ me: login.uid, meAt: this.now() });
    return login.uid;
  }

  // ---- 收 ----
  async poll() {
    if (!this.active() || this.polling || this.now() < this.backoffUntil) return;
    this.polling = true;
    const p = this.settings(), now = this.now();
    try {
      const me = await this.me();
      const st = this.state();
      const fresh = st.cursorGroup !== p.groupId || !st.cursor;
      const args = ['im', 'query-history-message', '--group-id', p.groupId, '--query-count', fresh ? '10' : '30'];
      // help 里写 0 是更新的，公司实测正好相反：1 才是「比这条更新的」（Q-1018-04 第 2 轮）。
      if (!fresh) args.push('--message-id', st.cursor, '--query-direction', '1');
      const r = await this.a.welink(args, { timeoutMs: 20000 });
      const list = welink.groupMessages(r.stdout);
      if (list == null) throw new Error(short(r.stderr || r.stdout || 'welink-cli 没有输出', 160));
      const cursor = fresh ? null : BigInt(st.cursor);
      const seen = new Set(st.seen), sent = st.sent.filter(x => now - x.at < 30 * 60000);
      let inbound = st.inbound.filter(t => now - t < 60000), top = cursor, throttled = false;
      const added = {};
      for (const m of list) {
        if (top === null || m.n > top) top = m.n;
        if ((cursor !== null && m.n <= cursor) || seen.has(m.id)) continue;
        seen.add(m.id);
        const text = m.text.trim();
        if (!text) continue;
        // 小微助手和别人的消息不理；记在往来里并写明发件账号：真机上要是本人账号和发件人格式对不上，一眼能看出来。
        if (m.sender !== me) { this.note('in', `${short(text, 40)}（${m.sender || '未知账号'} 发的，你的账号是 ${me}）`, 'other'); continue; }
        if (text.startsWith(PREFIX) || sent.some(x => x.hash === digest(text))) continue; // Hub 自己发出去的
        // 只认开启（或换群）之后发的，关掉期间发的重新开启后也不补执行；平时超过 120 秒的旧消息不执行（时间以 WeLink 服务器为准）。
        if (m.at ? m.at < (p.since || 0) : fresh) continue;
        if (m.at && now - m.at > FRESH_MS) { this.note('in', text, 'stale'); continue; }
        if (m.type && !/TEXT/i.test(m.type)) { this.note('in', '（' + m.type + '）', 'unsupported'); void this.send('现在只看得懂文字消息，图片和文件请在电脑上处理。', 'info'); continue; }
        if (inbound.length >= RATE_PER_MIN) { if (!throttled) { throttled = true; void this.send(`一分钟内超过 ${RATE_PER_MIN} 条，先歇一下，这条没处理。`, 'info'); } this.note('in', text, 'throttled'); continue; }
        inbound.push(now);
        this.note('in', text);
        const item = this.a.ask(text, { via: 'phone' });
        added[item.id] = { at: now, acked: false };
        this.update(cur => ({ pending: { ...cur.pending, ...added } }));
      }
      this.save({ cursor: top === null ? '' : String(top), cursorGroup: p.groupId, seen: [...seen].slice(-300), inbound, lastPollAt: now, lastOkAt: now, lastError: '' });
      this.backoffUntil = 0;
    } catch (error) {
      this.save({ lastPollAt: now, lastError: error.message });
      this.backoffUntil = this.now() + 60000; // 出错（多半是登录过期）时一分钟后再试
      this.a.changed();
    } finally { this.polling = false; }
  }

  // ---- 发 ----
  send(text, kind = 'answer', targetGroup = '') {
    const p = this.settings();
    if (targetGroup) p.groupId = targetGroup;
    if (!p.groupId) return Promise.resolve(false);
    const parts = chunks(plain(text));
    this.outbox = this.outbox.then(async () => {
      for (let i = 0; i < parts.length; i += 1) {
        const body = PREFIX + (parts.length > 1 ? `（${i + 1}/${parts.length}）` : '') + parts[i];
        try {
          const r = await this.a.welink(['im', 'send-to-group', '--group-id', p.groupId, '--text', body], { sendGroup: p.groupId, timeoutMs: 30000 });
          if (r.code !== 0) throw new Error(short(r.stderr || r.stdout || '发送命令失败', 160));
          const receipt = welink.parseJson(r.stdout), code = receipt?.code ?? receipt?.resultCode ?? receipt?.error?.error_code;
          if (receipt?.ok === false || receipt?.success === false || code !== undefined && !['0', '200'].includes(String(code)))
            throw new Error(short(receipt?.error?.error_msg || receipt?.message || receipt?.resultContext || `发送业务码 ${code}`, 160));
          this.update(cur => ({ sent: [...cur.sent.filter(x => this.now() - x.at < 30 * 60000), { hash: digest(body), at: this.now() }].slice(-100) }));
          this.note('out', body, kind);
        } catch (error) {
          this.save({ lastError: '发到手机没成功：' + error.message });
          this.note('out', body, 'failed');
          return false;
        }
      }
      return true;
    }).catch(() => false);
    return this.outbox;
  }
  // 手机问的那句答完（或没答上）：把回答发回群里。
  settle(item) {
    if (!item || !this.state().pending[item.id]) return;
    this.update(cur => { const pending = { ...cur.pending }; delete pending[item.id]; return { pending }; });
    if (item.state === 'done') void this.send(item.a, 'answer');
    else void this.send('这句没答上：' + short(item.error || '原因不明', 120) + '。可以再说一次。', 'error');
  }

  // ---- 盯会话 ----
  watch(id, { baseline = null, title = '', why = '' } = {}) {
    this.update(cur => ({ watches: { ...cur.watches, [id]: { at: this.now(), baseline, title, why } } }));
  }
  async watchTick() {
    if (!this.active() || this.watching) return;
    this.watching = true;
    try {
      const p = this.settings(), now = this.now();
      let ack = 0;
      this.update(cur => {
        const pending = { ...cur.pending };
        for (const [id, x] of Object.entries(pending)) {
          if (now - x.at > 30 * 60000) delete pending[id];
          else if (!x.acked && now - x.at > ACK_MS) { pending[id] = { ...x, acked: true }; ack += 1; }
        }
        return { pending };
      });
      if (ack) void this.send('收到，正在处理…', 'ack');
      const tools = this.a.tools, st = this.state();
      const watches = { ...st.watches }, stuck = { ...st.stuck }, dropped = new Set();
      if (tools) {
        const rows = tools.rows({ closed: 0 }), byId = new Map(rows.map(r => [r.id, r]));
        for (const [id, w] of Object.entries(watches)) {
          if (now - w.at > WATCH_TTL_MS) { dropped.add(id); continue; }
          const r = byId.get(id);
          if (!r || r.state === 'running') continue;
          if (r.state === 'stuck') { if (p.pushWatched) await this.pushStuck(r, stuck); continue; }
          const final = tools.lastFinal(id);
          if (final && final.id !== w.baseline && String(final.text || '').trim()) {
            dropped.add(id);
            if (p.pushWatched) void this.send(`「${r.title}」这一轮答完了：\n${clip(plain(final.text), 600)}`, 'done');
          }
        }
        const idle = typeof this.deps.systemIdleSeconds === 'function' ? Number(this.deps.systemIdleSeconds()) : Infinity;
        if (p.pushStuck && idle >= AT_DESK_S) for (const r of rows) if (r.state === 'stuck' && !watches[r.id]) await this.pushStuck(r, stuck);
        for (const id of Object.keys(stuck)) if (byId.get(id)?.state !== 'stuck') delete stuck[id];
      }
      // 期间助理可能又盯上了别的会话：以最新状态为底，只删这一轮处理掉的。
      this.update(cur => { const next = { ...cur.watches }; for (const id of dropped) if (next[id] && next[id].at <= (watches[id]?.at ?? Infinity)) delete next[id]; return { watches: next, stuck }; });
    } finally { this.watching = false; }
  }
  async pushStuck(r, stuck) {
    if (stuck[r.id]) return;
    stuck[r.id] = this.now();
    const screen = await this.a.tools.screen(r.id);
    const tail = (screen || []).filter(l => l.trim()).slice(-10).join('\n');
    void this.send(`「${r.title}」卡住了，在等你：\n${r.waitingText || tail || '（看不到终端画面）'}\n\n直接回我怎么处理就行，例如「${short(r.title, 10)} 选 1」或「先停下」。`, 'stuck');
  }

  // ---- 设置页用 ----
  async checkGroup(groupId = this.settings().groupId) {
    if (!groupId) throw new Error('请先填群 ID');
    const r = await this.a.welink(['im', 'query-group-member', '--group-id', String(groupId)], { timeoutMs: 20000 });
    const members = welink.groupMembers(r.stdout);
    if (!members.length && r.code !== 0) throw new Error(short(r.stderr || r.stdout || '没查到群成员', 160));
    let me = ''; try { me = await this.me(); } catch { /* 没登录也能看成员 */ }
    const others = members.filter(m => m.account !== me);
    const check = { at: this.now(), groupId: String(groupId), count: members.length, names: members.map(m => m.name || m.account).slice(0, 10), ok: members.length <= 2,
      note: members.length <= 2 ? '群里只有你和' + (others[0]?.name || '小微助手') + '，可以用。' : `群里有 ${members.length} 个成员（${others.map(m => m.name || m.account).slice(0, 5).join('、')}）。别人也能看到 Hub 发的回答，建议先把同事移出群。` };
    this.save({ groupCheck: check });
    return check;
  }
  status() {
    const p = this.settings(), st = this.state();
    return { settings: p, active: this.active(), lastPollAt: st.lastPollAt, lastOkAt: st.lastOkAt, lastError: st.lastError, log: st.log.slice(0, 15),
      watching: Object.entries(st.watches).map(([id, w]) => ({ id, title: w.title, at: w.at })), pending: Object.keys(st.pending).length, groupCheck: st.groupCheck };
  }
}

module.exports = { PhoneChannel, DEFAULT_PHONE, PREFIX, PHONE_NOTE, WELCOME, plain, chunks };
