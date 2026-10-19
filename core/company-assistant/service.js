'use strict';
// 公司版「助理」服务（2026-10-16 定稿：简报 + 对话；6 条提醒都要；只读；数据只留在这台电脑）。
//   取数：Hub 用 welink-cli 的查询命令（白名单见 welink.js）取会议、日程、消息、邮件，存在 <数据目录>/company-assistant/。
//     消息（2026-10-18 用户改）：默认取回看时间（36 小时）内所有单聊和群的全部消息，不限个数、不限条数，宁可多；
//     「全部」= welink-cli 能列出的最近 50 个会话（--count 上限 50、不能翻页；默认只给 10 个）。设置里可以限个数、调回看时长。
//     免打扰、置顶 welink-cli 拿不到（Q-1018-10），所以不做这两个设置。不再要手动勾「关注群」。每个会话缓存已取到的消息，之后只补拉新的。
//   简报：工作日定时（默认 08:20）生成；打开助理页时当天还没有就当场生成。先出按规则排的清单，再请 CodeAgent 挑重点，逐条核对出处。
//   对话：固定一个 CodeAgent 会话（purpose=company-assistant，不挂 Hub 的 MCP 和「问家里」），它查 WeLink 只用工作目录里的只读包装 welink-ro.cmd。
//   提醒：每分钟按 reminders.js 算该发的，经提醒总线（notice-bus.js）发布；每小时最多 3 条，同一件事只提醒一次。
//   手机（2026-10-18）：用户在手机 WeLink 专用群里和助理对话（phone.js）；助理会话挂上 Hub 的会话工具（hub-tools.js，MCP 名 hub_sessions），
//     能看、推进、新开、盯着其他会话。助理会话本身仍然只读 WeLink、不发消息，回答由 Hub 发回群里。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const welink = require('./welink');
const D = require('./data');
const B = require('./brief');
const R = require('./reminders');
const Q = require('./queries');
const Identity = require('./identity');
const { noticeBus } = require('./notice-bus');
const { PhoneChannel, DEFAULT_PHONE, PHONE_NOTE } = require('./phone');
const { HubTools } = require('./hub-tools');

const PURPOSE = 'company-assistant';
// 助理会话的工具或说明有变化时加 1：旧会话启动时没挂这些工具，下一次提问时换一个新会话（旧会话留在历史里）。
const TOOLS_VERSION = 1;
const INSTRUCTIONS_VERSION = 2;
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true, briefTime: '08:20', summaryTime: '18:00', waitHours: 4, prepMinutes: 15, maxPerHour: 3, refreshMinutes: 10,
  watchGroups: [], keywords: [], myName: '', workdays: [1, 2, 3, 4, 5], cliPath: '', email: '', emailFrom: '', chips: [], phone: DEFAULT_PHONE,
  lookbackHours: 36, maxConversations: 0,
});
// 输入框上方的常用问题（设计稿 B）。fill=true 的只填进输入框，等补全再发。
const BUILTIN_CHIPS = Object.freeze([
  { action: 'meetings-today', label: '今天的会', text: '今天有哪些会？按时间列出，每场写一句我需要准备什么。' },
  { action: 'meeting-prep', label: '下午会前准备', text: '下午的会逐场做会前准备：相关的消息、邮件和材料要点，以及我可能被问到的问题。' },
  { action: 'awaiting-reply', label: '谁在等我回', text: '现在谁在等我回复？按等待时间排序，每条给一句建议怎么回（写成草稿，我自己发）。' },
  { action: 'group-summary', label: '汇总某个群…', text: '汇总群「」今天的讨论要点，以及和我相关的事。', fill: true },
  { action: 'mail-triage', label: '未读邮件分拣', text: '把未读邮件分成三类：要我处理、知会即可、可忽略；各列标题和一句理由。' },
  { action: 'weekly-report', label: '起草周报', text: '根据本周的会议、消息和邮件，起草一份周报（本周进展、问题与风险、下周计划），我来改。' },
]);
const INSTRUCTIONS = [
  '你是我在公司电脑上的工作助理，帮我整理 WeLink 里的会议、日程、消息和邮件。请遵守：',
  '1. 只读：查 WeLink 一律用当前目录的 welink-ro.cmd（参数和 welink-cli 一样，只放行查询命令），不直接调用 welink-cli。发消息、回邮件、建会议、建日程都不做；要发的内容写成草稿给我，我自己发。',
  '2. 先看 data/today.json（Hub 刚取到的今天的数据，每条带出处编号 sourceId），不够再用 welink-ro.cmd 查。',
  '3. 回答先写结论；提到具体的会、消息、邮件时，时间和主题照数据原样抄，并写清出处（谁、哪个群或哪场会、几点）。优先使用 senderName / sender 中的姓名，保留 account 便于重名核对。数据里有查询错误或范围未取全时说明影响；没查到就说没查到，不猜。',
  '4. 数据只留在这台电脑：不上传、不转发，不在当前目录以外写文件。',
  '5. 邮件或日历报「Exchange server domain not found」时：Hub 通常已自动配好；还没好就先看 data/today.json 里 mailSetup.email，有邮箱就直接运行 welink-ro.cmd mail autodiscover --email <邮箱> 再重查，不问我；只有那里也没有邮箱时才问我一次，并提醒我可以在助理页「设置 → WeLink 与邮箱」里填。',
  '6. 管这台电脑 Hub 里的其他会话（有哪些、做到哪了、推进、新开、卡住时替我按键、停下）用 hub_sessions 工具，直接执行，做完用一两句话复述做了什么、交给了哪个会话。给别的会话派活时只写任务本身，不要把 WeLink 消息、邮件原文整段转过去。',
  '7. 我在手机 WeLink 上发来的问题，你照常回答；回答由 Hub 发回我手机，你自己不发消息。',
  '可用的查询：welink-ro.cmd im query-recent-conversation；im query-history-message --group-id <群号> 或 --user-account <账号> --query-count <1-100>；meeting query-list（必须同时给分页、起止时间、类型、排序，下面给出当天可直接运行的命令）；meeting info --meeting-id <会议号>；calendar list --start YYYY-MM-DD --end YYYY-MM-DD --format json；mail list --is-read 0 --max 20；mail get；search person；contact detail。',
  '聊天查询会自动增加 senderName/displayName，原始 sender 仍是账号。简报预览省略的内容从 data/brief-input-<日期>.md 读完整原文；data/today.json 保留非文字消息原始内容。',
].join('\n');
const JOB_TIMEOUT_MS = 12 * 60000;
const FRESH_MS = 3 * 60000;
// 每页取 100 条（welink-cli 的上限）；一个会话最多往回翻 30 页，只为防止翻页死循环，正常回看时间内远到不了。
const HISTORY_PAGE = 100;
const MAX_PAGES = 30;
const LOOKBACK_CHOICES = [12, 24, 36, 48, 72];
const CONVERSATION_LIMIT = 50; // query-recent-conversation --count 的上限（默认 10），不能翻页
// 消息编号比大小：真机是长整数（BigInt 比），测试数据可能是普通字符串。
const idCmp = (a, b) => { try { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; } catch { return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; } };

class CompanyAssistant {
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || (() => Date.now());
    this.dir = path.join(deps.dataDir, 'company-assistant');
    this.workspace = path.join(this.dir, 'workspace');
    this.bus = deps.bus || noticeBus();
    this.queue = [];
    this.job = null;
    this.refreshing = null;
    this.loginFlow = null;
    this.timers = [];
    this.tools = deps.noTools ? null : new HubTools(this, deps);
    this.phone = new PhoneChannel(this, deps);
    this.toolsReady = null;
  }

  // ---- 本地文件（只在这台电脑的 Hub 数据目录里） ----
  file(name) { return path.join(this.dir, name); }
  read(name, fallback) { try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return fallback; } }
  write(name, value) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file(name) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
    fs.renameSync(tmp, this.file(name));
  }
  settings() { const s = this.read('settings.json', {}); return { ...DEFAULT_SETTINGS, ...s }; }
  setSettings(patch = {}) {
    const s = this.settings(), next = { ...s };
    const hhmm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : null;
    if ('enabled' in patch) next.enabled = !!patch.enabled;
    if (hhmm(patch.briefTime)) next.briefTime = hhmm(patch.briefTime);
    if (hhmm(patch.summaryTime)) next.summaryTime = hhmm(patch.summaryTime);
    if ('lookbackHours' in patch && LOOKBACK_CHOICES.includes(Number(patch.lookbackHours))) next.lookbackHours = Number(patch.lookbackHours);
    if ('maxConversations' in patch && Number.isFinite(Number(patch.maxConversations))) next.maxConversations = Math.max(0, Math.min(CONVERSATION_LIMIT, Math.round(Number(patch.maxConversations))));
    for (const [k, lo, hi] of [['waitHours', 1, 24], ['prepMinutes', 5, 60], ['maxPerHour', 1, 10], ['refreshMinutes', 5, 60]]) {
      if (k in patch && Number.isFinite(Number(patch[k]))) next[k] = Math.min(hi, Math.max(lo, Math.round(Number(patch[k]))));
    }
    if (Array.isArray(patch.watchGroups)) next.watchGroups = patch.watchGroups.filter(g => g && g.id).slice(0, 20).map(g => ({ id: String(g.id), name: String(g.name || g.id).slice(0, 60) }));
    if ('keywords' in patch) next.keywords = (Array.isArray(patch.keywords) ? patch.keywords : String(patch.keywords || '').split(/[,，、\s]+/)).map(w => String(w).trim()).filter(Boolean).slice(0, 30);
    if (Array.isArray(patch.workdays)) next.workdays = [...new Set(patch.workdays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
    if ('myName' in patch) next.myName = String(patch.myName || '').trim().slice(0, 30);
    if ('cliPath' in patch) next.cliPath = String(patch.cliPath || '').trim();
    if ('email' in patch) { next.email = String(patch.email || '').trim().slice(0, 120); next.emailFrom = patch.emailFrom === 'welink' ? 'welink' : 'settings'; }
    if (patch.phone && typeof patch.phone === 'object') {
      const cur = { ...DEFAULT_PHONE, ...(s.phone || {}) }, q = patch.phone, np = { ...cur };
      if ('enabled' in q) np.enabled = !!q.enabled;
      if ('groupId' in q) { np.groupId = String(q.groupId || '').trim().slice(0, 80); np.groupName = String(q.groupName || '').trim().slice(0, 60); }
      for (const k of ['pushWatched', 'pushStuck']) if (k in q) np[k] = !!q[k];
      // 刚接通（或换了群）：只认这之后发的消息，不把群里以前的话当成指令。
      if (np.enabled && np.groupId && (!cur.enabled || np.groupId !== cur.groupId)) np.since = this.now();
      next.phone = np;
    }
    if (Array.isArray(patch.chips)) next.chips = patch.chips.filter(c => c && String(c.text || '').trim()).slice(0, 12).map(c => ({ label: String(c.label || c.text).trim().slice(0, 16), text: String(c.text).trim().slice(0, 2000) }));
    this.write('settings.json', next);
    this.changed();
    return next;
  }
  state() { return { sent: {}, sentTimes: [], done: {}, notices: [], commitments: [], ...this.read('state.json', {}) }; }
  saveState(patch) { const s = { ...this.state(), ...patch }; this.write('state.json', s); return s; }
  chat() { return this.read('chat.json', []); }
  saveChat(list) { this.write('chat.json', list.slice(-200)); }
  snapshot(day = D.dayKey(this.now())) { return this.read(`raw-${day}.json`, null); }
  brief(day = D.dayKey(this.now())) { return this.read(`brief-${day}.json`, null); }
  changed() { try { this.deps.onChanged?.(); } catch { /* 界面没开 */ } }
  cli() { return (this.deps.resolveCli || welink.resolveCli)({ configured: this.settings().cliPath }); }
  // 快速查找没找到：后台全盘找一次（2026-10-19），找到就记进设置；同一次启动里没找到的，6 小时后再自动找。
  // 「再找一次」按钮传 force 立刻重找；状态给界面显示（正在找 / 找到了 / 没找到）。
  findCli({ force = false } = {}) {
    const s = this.cliSearch || { state: 'idle', at: 0 };
    if (s.state === 'searching') return this.cliSearching;
    if (!force && s.state === 'notfound' && this.now() - s.at < 6 * 3600000) return Promise.resolve(s);
    this.cliSearch = { state: 'searching', at: this.now(), stage: 'path' };
    this.changed();
    const find = this.deps.findCliDeep || welink.findCliDeep;
    this.cliSearching = Promise.resolve().then(() => find({ onStage: stage => { this.cliSearch = { ...this.cliSearch, stage }; this.changed(); } }))
      .catch(() => ({ path: null }))
      .then(found => {
        if (found && found.path) {
          this.setSettings({ cliPath: found.path });
          this.prepareWorkspace();
          this.cliSearch = { state: 'found', at: this.now(), path: found.path, via: found.via };
          // 找到了：马上取数；今天的简报还是「没找到 welink-cli」的空简报就重新生成。
          void this.refresh({ force: true }).then(() => { const b = this.brief(); if (!b || b.by === 'none') return this.generateBrief(); }).catch(() => {});
        } else this.cliSearch = { state: 'notfound', at: this.now() };
        this.cliSearching = null;
        this.changed();
        return this.cliSearch;
      });
    return this.cliSearching;
  }
  // 「手动选择…」：用户选的是 welink-cli.cmd 时换成旁边 node_modules 里的真 exe（不经 shell 调用）。
  useCliPath(file) {
    const f = String(file || '').trim();
    if (!f || !fs.existsSync(f)) throw new Error('这个文件不存在');
    const exe = /\.exe$/i.test(f) ? f : welink.cliUnder(path.dirname(f));
    if (!exe) throw new Error('请选 welink-cli.exe（或 npm 全局目录里的 welink-cli.cmd）');
    this.setSettings({ cliPath: exe });
    this.prepareWorkspace();
    this.cliSearch = { state: 'found', at: this.now(), path: exe, via: 'manual' };
    void this.refresh({ force: true }).then(() => { const b = this.brief(); if (!b || b.by === 'none') return this.generateBrief(); }).catch(() => {});
    return { ok: true, path: exe };
  }
  welink(args, opts = {}) { return (this.deps.welinkRun || ((a, o) => welink.run(a, { cli: this.cli(), ...o })))(args, opts); }

  start() {
    fs.mkdirSync(this.workspace, { recursive: true });
    const st = this.state();
    // 关注词只看从现在起的新消息；重启前没答完的对话标出来，可重问。
    const chat = this.chat();
    if (chat.some(c => ['queued', 'running'].includes(c.state))) this.saveChat(chat.map(c => ['queued', 'running'].includes(c.state) ? { ...c, state: 'error', error: 'Hub 重启前没答完，可点「重问」' } : c));
    if (!st.keywordSince) this.saveState({ keywordSince: this.now() });
    this.prepareWorkspace();
    if (this.tools) this.toolsReady = this.tools.start().catch(e => { console.warn('[company-assistant] tools', e.message); });
    this.phone.start();
    if (this.deps.noTimer) return;
    this.timers.push(setInterval(() => { void this.tick().catch(e => console.warn('[company-assistant] tick', e.message)); }, 60000));
    this.timers.push(setInterval(() => { void this.collectJob().catch(e => console.warn('[company-assistant] collect', e.message)); }, 4000));
    const first = setTimeout(() => { void this.tick().catch(() => {}); }, 15000); this.timers.push(first);
  }
  close() { for (const t of this.timers) { clearInterval(t); clearTimeout(t); } this.timers = []; this.phone.close(); this.tools?.close(); }
  // 给助理会话挂会话工具（main.js 注册的 extraMcpProvider 调用）：只挂给 purpose=company-assistant 的会话。
  sessionPlan({ opts = {}, id } = {}) {
    if (opts.purpose !== PURPOSE || !this.tools?.bridge.url) return null;
    return { mcp: this.tools.mcpEntry(opts.id || id) };
  }
  // 「手机」设置：刚接通时往群里发一句，顺带验证 Hub 能发进这个群。
  async setPhone(patch = {}) {
    const before = this.settings().phone || {};
    const s = this.setSettings({ phone: patch });
    const p = s.phone;
    let welcome = null;
    if (p.enabled && p.groupId && (!before.enabled || before.groupId !== p.groupId)) welcome = await this.phone.send(require('./phone').WELCOME, 'welcome');
    return { ok: true, phone: this.phone.status(), welcome };
  }

  // 助理会话的工作目录：说明（CLAUDE.md）、只读包装、今天的数据。
  prepareWorkspace() {
    fs.mkdirSync(path.join(this.workspace, 'data'), { recursive: true });
    fs.writeFileSync(path.join(this.workspace, 'CLAUDE.md'), '# 公司助理\n\n' + this.instructions() + '\n', 'utf8');
    const exe = this.deps.nodeExecutable || process.execPath;
    const script = path.join(__dirname, 'welink-ro.js');
    const cli = this.cli();
    const lines = ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `set "CLAUDE_HUB_ASSISTANT_DIR=${this.dir}"`, cli ? `set "CLAUDE_HUB_WELINK_CLI=${cli}"` : '', `"${exe}" "${script}" %*`].filter(Boolean);
    fs.writeFileSync(path.join(this.workspace, 'welink-ro.cmd'), lines.join('\r\n') + '\r\n', 'utf8');
  }
  instructions() { return INSTRUCTIONS + '\n今天待参加的会议（时间为本机时区的 13 位毫秒值）：welink-ro.cmd ' + Q.meetingArgs(this.now()).join(' ') + '；按返回 total 继续增加 --page。'; }

  // ---- 定时 ----
  async tick() {
    const s = this.settings(), now = this.now(), day = D.dayKey(now), minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    if (!s.enabled) return;
    const workday = R.isWorkday(now, s);
    const last = this.snapshot(day);
    if (workday && minute >= 7 * 60 + 30 && minute < 21 * 60 && (!last || now - (last.at || 0) >= s.refreshMinutes * 60000)) await this.refresh().catch(() => {});
    const brief = this.brief(day);
    // 没登录时生成的是空简报（提示扫码），之后每 10 分钟再试一次。
    const retry = !brief || (brief.by === 'none' && now - (brief.generatedAt || 0) >= 10 * 60000);
    if (workday && minute >= R.minutesOf(s.briefTime) && retry && !this.briefRunning(day)) await this.generateBrief().catch(() => {});
    this.remind();
    void this.pump();
  }
  briefRunning(day) { return [this.job, ...this.queue].some(j => j && j.type === 'brief' && j.day === day); }

  // ---- 取数 ----
  refresh({ force = false } = {}) {
    if (this.refreshing) return this.refreshing;
    const day = D.dayKey(this.now()), last = this.snapshot(day);
    if (!force && last && this.now() - (last.at || 0) < FRESH_MS) return Promise.resolve(last);
    this.refreshing = this.collect().finally(() => { this.refreshing = null; this.changed(); });
    return this.refreshing;
  }
  async collect() {
    const s = this.settings(), now = this.now(), day = D.dayKey(now), errors = [];
    const snap = { at: now, day, login: null, calendarNeedsSetup: false, meetings: [], calendar: [], conversations: [], messages: {}, mails: [], errors };
    const runJson = async (label, args) => {
      try {
        return await Q.readJson(args => this.welink(args), args);
      } catch (error) { errors.push({ label, text: D.short(error.message, 200), calendar: welink.calendarNeedsSetup(error.message) }); return null; }
    };
    try {
      const st = await this.welink(['auth', 'status']);
      snap.login = { ...welink.loginState(st.stdout + '\n' + st.stderr), checkedAt: now };
    } catch (error) {
      snap.login = { ok: false, reason: error.code === 'WELINK_MISSING' ? 'missing' : 'error', error: error.message, checkedAt: now };
      if (error.code === 'WELINK_MISSING') void this.findCli();
    }
    if (snap.login.ok) {
      const meetingResult = await Q.collectMeetings(runJson, now);
      snap.meetings = meetingResult.meetings; snap.meetingCoverage = meetingResult.coverage;
      if (meetingResult.coverage.status !== 'complete' && meetingResult.coverage.reason !== 'query-failed') errors.push({ label: '会议', text: meetingResult.coverage.reasonLabel });
      const queryCalendar = async () => {
        const cal = await runJson('日程', ['calendar', 'list', '--start', day, '--end', day, '--format', 'json']);
        if (cal) snap.calendar = D.calendarEvents(cal);
      };
      await queryCalendar();
      // 邮件和日历都要先按邮箱找一次 Exchange 服务器（mail autodiscover）。不让用户先填：
      // 先用设置里的邮箱，没有就从 WeLink 自己的账号信息（onebox user-info 的 email）读，配好后重查一次日程。
      if (errors.some(e => e.calendar)) {
        snap.mailSetup = await this.autoSetupMail(s);
        if (snap.mailSetup.ok) { for (let i = errors.length - 1; i >= 0; i -= 1) if (errors[i].calendar) errors.splice(i, 1); await queryCalendar(); }
      }
      snap.calendarNeedsSetup = errors.some(e => e.calendar);
      const convRaw = await runJson('最近会话', ['im', 'query-recent-conversation', '--count', String(CONVERSATION_LIMIT)]);
      if (convRaw && D.conversationRecords(convRaw) !== null) {
        snap.conversations = D.conversations(convRaw);
        await this.collectMessages(snap, s, now, runJson);
      } else {
        if (convRaw) errors.push({ label: '最近会话', text: '无法识别会话列表结构，保留此前记录' });
        // 会话目录失败不能把此前已取得的聊天覆盖成空结果；身份不明或换号时不复用。
        const previous = snap.login.uid && this.snapshotDays().map(d => this.snapshot(d)).find(p => p?.login?.uid === snap.login.uid);
        if (previous) {
          snap.conversations = previous.conversations || []; snap.messages = previous.messages || {};
          snap.nameResolution = previous.nameResolution;
        }
        const coverage = (previous?.scope?.conversations || []).map(c => ({ ...c, status: 'partial', reason: 'query-failed', reasonLabel: '最近会话查询失败，显示上次取得的记录' }));
        snap.scope = { ...(previous?.scope || {}), lookbackHours: previous?.scope?.lookbackHours || s.lookbackHours,
          fetched: 0, messages: Object.values(snap.messages).reduce((n, rows) => n + rows.length, 0),
          stale: true, capturedAt: previous?.scope?.capturedAt || previous?.at || null,
          partial: Math.max(1, coverage.length), conversations: coverage };
      }
      const mailRaw = await runJson('未读邮件', ['mail', 'list', '--is-read', '0', '--max', '20']);
      if (mailRaw) snap.mails = D.mails(mailRaw);
      snap.calendarNeedsSetup = errors.some(e => e.calendar);
    }
    this.write(`raw-${day}.json`, snap);
    // 给助理会话读的同一份数据（只留在本机）。
    try { fs.mkdirSync(path.join(this.workspace, 'data'), { recursive: true }); fs.writeFileSync(path.join(this.workspace, 'data', 'today.json'), JSON.stringify(snap, null, 1), 'utf8'); } catch { /* 下次再写 */ }
    this.pruneFiles();
    return snap;
  }
  // 消息：最近会话里每个会话在回看时间内的全部消息，按会话列表原顺序（最近的在前）。
  // 已缓存的会话只补拉比缓存里最新那条更新的消息；第一次取时从最新一页往回翻，翻到早于回看时间为止。
  // 会话列表没有时间字段，没法预先跳过安静的会话：每次刷新每个会话都要查一次（约 2 秒一次，50 个约 2 分钟，在后台跑）。
  async collectMessages(snap, s, now, runJson) {
    const cutoff = now - s.lookbackHours * 3600000, me = snap.login.uid, phoneGroup = s.phone?.groupId || '';
    let list = snap.conversations.filter(c => c.id !== phoneGroup); // 手机对话的专用群不进简报
    const limited = s.maxConversations > 0 && list.length > s.maxConversations;
    if (limited) list = list.slice(0, s.maxConversations);
    const stored = this.read('message-cache.json', {}), previous = this.snapshot(snap.day);
    const sameOwner = !!me && (stored.identity === me || (!stored.identity && stored.version !== 2 && previous?.login?.uid === me));
    const cache = sameOwner ? (stored.version === 2 ? stored.conversations || {} : stored) : {};
    const next = { version: 2, identity: me || null, conversations: {} }, names = D.namesOf(snap.conversations);
    const coverage = [];
    for (const conv of list) {
      const got = await this.conversationHistory(conv, cache[conv.id], cutoff, me, s.myName, runJson, names);
      next.conversations[conv.id] = got.cache;
      if (got.messages.length) snap.messages[conv.id] = got.messages;
      coverage.push({ id: conv.id, name: conv.name, ...got.coverage });
      if (got.coverage.status !== 'complete' && got.coverage.reason !== 'query-failed') snap.errors.push({ label: `消息（${conv.name}）`, text: `只取到部分消息：${got.coverage.reasonLabel}` });
    }
    for (const m of Object.values(snap.messages).flat()) if (!m.nameSource && !m.mine && m.sender && m.sender !== m.account) names.set(m.account, m.senderName || m.sender);
    const resolution = await Identity.resolveNames({ run: (args, opts) => this.welink(args, opts), cacheDir: this.dir, identity: me,
      accounts: Object.values(snap.messages).flat().map(m => m.account), seeds: names, now });
    for (const [id, rows] of Object.entries(snap.messages)) { snap.messages[id] = Identity.applyNames(rows, resolution); next.conversations[id].messages = snap.messages[id]; }
    snap.nameResolution = resolution.stats;
    this.write('message-cache.json', next);
    const all = Object.values(snap.messages);
    snap.scope = { lookbackHours: s.lookbackHours, since: cutoff, listed: snap.conversations.length, fetched: list.length, limited, maxConversations: s.maxConversations,
      withMessages: all.length, messages: all.reduce((n, l) => n + l.length, 0), p2p: Object.keys(snap.messages).filter(id => !snap.conversations.find(c => c.id === id)?.group).length,
      listCap: CONVERSATION_LIMIT, listFull: snap.conversations.length >= CONVERSATION_LIMIT,
      partial: coverage.filter(c => c.status !== 'complete').length, conversations: coverage, migrated: sameOwner && stored.version !== 2 };
  }
  async conversationHistory(conv, cached, cutoff, me, myName, runJson, names = null) {
    // 老缓存曾截断正文，必须重新拉；部分失败也要补齐旧页，不能只向前增量。
    const incremental = cached?.version === 2 && cached.coverage?.status === 'complete' && cached.since <= cutoff && cached.newest;
    const since = cutoff; // 输出缓存已经裁到 cutoff，覆盖起点必须同步，扩大窗口才能触发回填。
    const base = ['im', 'query-history-message', conv.group ? '--group-id' : '--user-account', conv.id, '--query-count', String(HISTORY_PAGE)];
    const label = `消息（${conv.name}）`;
    const norm = raw => D.messages(raw, conv, me, { myName, names });
    const keep = new Map((cached?.messages || []).filter(m => !m.at || m.at >= cutoff).map(m => [m.key, cached.version === 2 ? m : { ...m, contentComplete: false }]));
    const add = list => { for (const m of list) keep.set(m.key, m); };
    const coverage = { status: 'partial', reason: 'page-limit', pages: 0, rawCount: 0, since: cutoff };
    let cursor = incremental ? cached.newest : null;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const raw = await runJson(label, cursor ? [...base, '--message-id', cursor, '--query-direction', incremental ? '1' : '0'] : base);
      coverage.pages += 1;
      if (!raw) { coverage.status = keep.size ? 'partial' : 'failed'; coverage.reason = 'query-failed'; coverage.failedPage = i + 1; break; }
      const original = D.messageRecords(raw);
      if (original === null) { coverage.status = keep.size ? 'partial' : 'failed'; coverage.reason = 'invalid-shape'; break; }
      const page = norm(raw);
      add(page); coverage.rawCount += original.length;
      const ids = original.map(D.messageId).filter(id => id !== undefined && id !== null && id !== '').map(String);
      const next = ids.reduce((x, id) => !x || (incremental ? idCmp(id, x) > 0 : idCmp(id, x) < 0) ? id : x, null);
      if (original.length < HISTORY_PAGE || (!incremental && page.some(m => m.at && m.at < cutoff))) {
        coverage.status = 'complete'; coverage.reason = original.length < HISTORY_PAGE ? 'exhausted' : 'window-reached'; break;
      }
      if (!next || ids.length !== original.length) { coverage.reason = 'missing-cursor'; break; }
      if (cursor && (incremental ? idCmp(next, cursor) <= 0 : idCmp(next, cursor) >= 0)) { coverage.reason = 'repeated-cursor'; break; }
      cursor = next;
    }
    return this.historyResult(keep, conv, cutoff, cached?.newest, since, coverage);
  }
  historyResult(keep, conv, cutoff, previousNewest, since, coverage) {
    const messages = [...keep.values()].filter(m => !m.at || m.at >= cutoff).sort((a, b) => (a.at || 0) - (b.at || 0) || idCmp(a.key, b.key));
    const newest = [...keep.keys()].reduce((x, k) => (!x || idCmp(k, x) > 0 ? k : x), previousNewest || null);
    const times = messages.map(m => m.at).filter(Boolean);
    coverage.oldestAt = times.length ? Math.min(...times) : null;
    coverage.newestAt = times.length ? Math.max(...times) : null;
    coverage.unknownTime = messages.filter(m => !m.at).length;
    coverage.incompleteText = messages.filter(m => m.contentComplete === false).length;
    if (coverage.incompleteText && coverage.status === 'complete') { coverage.status = 'partial'; coverage.reason = 'legacy-text'; }
    coverage.reasonLabel = { 'page-limit': '已到本轮 30 页上限，所选范围未取全', 'query-failed': '某页查询失败，保留已取到的记录', 'missing-cursor': '返回记录缺少翻页编号',
      'repeated-cursor': '服务端重复返回同一页', 'invalid-shape': '无法识别消息返回结构，保留此前记录', 'legacy-text': '部分旧记录仍是截断内容', exhausted: '已到查询结果末尾', 'window-reached': '已覆盖所选回看时间' }[coverage.reason];
    return { messages, coverage, cache: { version: 2, newest, since, messages, coverage } };
  }
  // 本人邮箱：设置里填过的优先；否则读 WeLink 账号信息（onebox user-info，只读）。读到的存进设置，下次不再查。
  async accountEmail(s = this.settings()) {
    if (s.email) return { email: s.email, from: s.emailFrom || 'settings' };
    try {
      const r = await this.welink(['onebox', 'user-info']);
      const info = welink.parseJson(r.stdout);
      const found = [info, info?.data, info?.user].map(x => x && typeof x === 'object' ? x.email || x.mail : '').find(v => /^[^\s@]+@[^\s@]+$/.test(String(v || '')));
      // 顺带补上「我的名字」（认群里 @我 用），用户填过的不动。
      const name = [info, info?.data, info?.user].map(x => x && typeof x === 'object' ? x.name : '').find(v => typeof v === 'string' && v.trim());
      if (name && !s.myName) this.setSettings({ myName: name.trim() });
      if (found) { this.setSettings({ email: String(found), emailFrom: 'welink' }); return { email: String(found), from: 'welink' }; }
    } catch { /* 读不到就请用户填 */ }
    return { email: '', from: '' };
  }
  // 自动配置邮件和日历：同一个邮箱每天最多自动试一次，失败了不反复跑；用户在设置里点「配置」不受这个限制。
  async autoSetupMail(s = this.settings()) {
    const { email, from } = await this.accountEmail(s);
    if (!email) return { ok: false, reason: 'no-email' };
    const st = this.state(), day = D.dayKey(this.now()), key = `${email}|${day}`;
    if (st.autoSetupTried === key) return { ok: false, reason: 'tried', email, from };
    this.saveState({ autoSetupTried: key });
    try {
      const r = await this.welink(['mail', 'autodiscover', '--email', email], { allowSetup: true, timeoutMs: 120000 });
      const text = r.stdout + r.stderr;
      return { ok: r.code === 0 && !welink.calendarNeedsSetup(text), email, from, output: D.short(text, 200) };
    } catch (error) { return { ok: false, reason: 'error', email, from, output: D.short(error.message, 200) }; }
  }
  pruneFiles() {
    try {
      const keep = D.dayKey(this.now() - 14 * 86400000);
      for (const f of fs.readdirSync(this.dir)) { const m = f.match(/^(?:raw|brief)-(\d{4}-\d\d-\d\d)\.json$/); if (m && m[1] < keep) fs.unlinkSync(this.file(f)); }
      // 简报用的消息原文只留 3 天（量大）。
      const recent = D.dayKey(this.now() - 3 * 86400000), data = path.join(this.workspace, 'data');
      for (const f of fs.existsSync(data) ? fs.readdirSync(data) : []) { const m = f.match(/^brief-input-(\d{4}-\d\d-\d\d)\.md$/); if (m && m[1] < recent) fs.unlinkSync(path.join(data, f)); }
    } catch { /* 清理失败不要紧 */ }
  }

  // ---- 简报 ----
  doneSet() { return new Set(Object.keys(this.state().done || {})); }
  async generateBrief({ force = false } = {}) {
    const now = this.now(), day = D.dayKey(now), s = this.settings();
    if (this.briefRunning(day) && !force) return this.brief(day);
    const snap = await this.refresh({ force });
    if (!snap.login?.ok) {
      const brief = { day, generatedAt: now, by: 'none', sections: [], dropped: 0, total: 0, note: snap.login?.reason === 'missing' ? '这台电脑上没找到 welink-cli，装好后再生成。' : 'WeLink 没登录或登录过期：点上方「扫码登录」，登录后会自动生成。' };
      this.write(`brief-${day}.json`, brief);
      this.changed();
      return brief;
    }
    const st = this.state();
    const list = B.fallbackBrief(snap, { day, now, settings: s, commitments: st.commitments, done: this.doneSet() });
    const brief = { ...list, organizing: true, note: 'AI 正在挑重点，先看按规则排的清单。' };
    this.write(`brief-${day}.json`, brief);
    this.changed();
    this.queue = this.queue.filter(j => !(j.type === 'brief' && j.day === day));
    // 全部消息原文写进助理工作目录，提问里只列重要的那部分（brief.js 的 inlineMessages）。
    try { fs.mkdirSync(path.join(this.workspace, 'data'), { recursive: true }); fs.writeFileSync(path.join(this.workspace, B.inputFileName(day)), B.briefInputFile(snap, { day, now, settings: s }), 'utf8'); } catch { /* 写不了就只靠提问里的部分 */ }
    this.enqueue({ type: 'brief', day, prompt: B.briefPrompt(snap, { day, now, settings: s, commitments: st.commitments }) });
    return brief;
  }
  finishBrief(job, text, error) {
    const day = job.day, snap = this.snapshot(day), st = this.state(), prev = this.brief(day) || {};
    let brief = !error && snap ? B.parseAgentBrief(text, snap, { day, now: this.now(), done: this.doneSet(), commitments: st.commitments }) : null;
    if (brief) {
      brief.note = brief.dropped ? `AI 整理的条目里有 ${brief.dropped} 条找不到出处，已删掉。` : '';
      if (!brief.total && prev.total) brief = { ...prev, organizing: false, note: 'AI 没挑出重点，下面是按规则排的清单。' };
      this.saveState({ commitments: B.mergeCommitments(st.commitments, brief, day) });
    } else {
      brief = { ...prev, organizing: false, note: error ? `AI 整理没完成（${D.short(error, 80)}），下面是按规则排的清单。` : 'AI 的整理结果读不出来，下面是按规则排的清单。' };
    }
    brief.organizing = false;
    this.write(`brief-${day}.json`, brief);
    if (brief.total) {
      const top = brief.sections.flatMap(x => x.items.map(i => `${x.title}：${i.text}`)).slice(0, 4);
      this.publish({ id: `brief:${day}`, kind: 'brief', title: `今日简报：${brief.total} 条`, text: top.join('\n'), sessionId: null });
    }
    this.changed();
  }
  markDone(source, done = true) {
    const st = this.state(), map = { ...st.done };
    if (done) map[String(source)] = this.now(); else delete map[String(source)];
    for (const [k, at] of Object.entries(map)) if (this.now() - at > 14 * 86400000) delete map[k];
    this.saveState({ done: map });
    const day = D.dayKey(this.now()), brief = this.brief(day);
    if (brief && done) {
      brief.sections = brief.sections.map(s => ({ ...s, items: s.items.filter(i => i.source !== String(source)) })).filter(s => s.items.length);
      brief.total = brief.sections.reduce((n, s) => n + s.items.length, 0);
      this.write(`brief-${day}.json`, brief);
    }
    this.changed();
    return { ok: true };
  }

  snapshotDays() {
    const today = D.dayKey(this.now()), oldest = D.dayKey(this.now() - 14 * 86400000);
    try { return fs.readdirSync(this.dir).map(f => /^raw-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1]).filter(d => d && d >= oldest && d <= today).sort().reverse(); } catch { return []; }
  }
  sourceContext(source, day = D.dayKey(this.now())) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || typeof source !== 'string' || !source || source.length > 1000) throw new Error('出处参数无效');
    const login = this.snapshot(D.dayKey(this.now()))?.login;
    if (!login?.ok || !login.uid) throw new Error('请先刷新数据确认当前账号，再查看本机原文。');
    const days = this.snapshotDays();
    if (days.includes(day)) { days.splice(days.indexOf(day), 1); days.unshift(day); }
    let snap, entry;
    for (const candidateDay of days) {
      const candidate = this.snapshot(candidateDay);
      if (candidate?.login?.uid !== login.uid) continue;
      const found = D.sourceIndex(candidate).get(source);
      if (found) { snap = candidate; entry = found; day = candidateDay; break; }
    }
    if (!entry) throw new Error('本机资料中没有这条原文。可刷新数据后重试；较早的承诺可能已超出消息保留范围。');
    let context = [], coverage = null;
    if (entry.kind === 'message') {
      const rows = snap.messages[entry.item.conv] || [], index = rows.findIndex(m => m.sourceId === source);
      context = rows.slice(Math.max(0, index - 2), index + 3);
      coverage = snap.scope?.conversations?.find(c => c.id === entry.item.conv) || null;
    }
    const capturedAt = entry.kind === 'message' && snap.scope?.stale ? snap.scope.capturedAt : snap.at;
    return { ok: true, day, entry, context, coverage, capturedAt };
  }

  // ---- 提醒 ----
  remind() {
    const s = this.settings(), now = this.now(), snap = this.snapshot(D.dayKey(now));
    if (!s.enabled || !snap || !snap.login?.ok) return [];
    const st = this.state();
    const due = R.dueNotices({ snapshot: snap, settings: { ...s, keywordSince: st.keywordSince }, now, commitments: st.commitments, sessionId: st.sessionId || null });
    return due.filter(n => this.publish(n));
  }
  publish(notice) {
    const st = this.state(), now = this.now();
    if (st.sent[notice.id]) return false;
    if (R.quota(st.sentTimes, now, this.settings().maxPerHour) <= 0) return false; // 顺延：下一轮再算
    if (!this.bus.publish(notice)) { this.saveState({ sent: { ...st.sent, [notice.id]: now } }); return false; }
    const sent = { ...st.sent, [notice.id]: now };
    for (const [k, at] of Object.entries(sent)) if (now - at > 30 * 86400000) delete sent[k];
    this.saveState({ sent, sentTimes: [...st.sentTimes.filter(t => now - t < 3600000), now], notices: [{ ...notice, at: now }, ...st.notices].slice(0, 30) });
    this.changed();
    return true;
  }

  // ---- 对话 ----
  ask(text, { via = '' } = {}) {
    const q = String(text || '').trim();
    if (!q) throw new Error('问题是空的');
    const item = { id: randomUUID(), q, state: 'queued', askedAt: this.now(), ...(via === 'phone' ? { via } : {}) };
    this.saveChat([...this.chat(), item]);
    this.enqueue({ type: 'chat', chatId: item.id, prompt: via === 'phone' ? PHONE_NOTE + '\n\n' + q : q });
    this.changed();
    return item;
  }
  retryChat(id) {
    const item = this.chat().find(c => c.id === id);
    if (!item) throw new Error('这条对话已经不在了');
    return this.ask(item.q, { via: item.via });
  }
  enqueue(job) { this.queue.push({ ...job, id: randomUUID() }); void this.pump(); }
  sessionBusy(id) {
    const s = id && this.deps.getSession(id);
    if (!s) return false;
    return !!this.deps.isAgentTurnActive?.(id) || s.status === 'running';
  }
  lastFinal(id) {
    const meta = this.deps.getSession(id) || this.deps.getSessionMetadata?.(id);
    const records = meta && this.deps.readFinals ? this.deps.readFinals(meta) : [];
    return records && records.length ? records[records.length - 1] : null;
  }
  async ensureSession() {
    const st = this.state();
    this.prepareWorkspace(); // 包装与查询说明升级不要求丢弃已有会话。
    // 旧版助理会话没挂会话工具：换一个新会话（旧的留在历史里，不再当助理）。
    let id = st.sessionId && st.toolsVersion === TOOLS_VERSION ? st.sessionId : null;
    if (this.toolsReady) await this.toolsReady;
    if (id && this.deps.getSession(id)) return id;
    if (id && this.deps.getSessionMetadata?.(id)) {
      try { await this.deps.resumeSession(id); } catch { /* 恢复不了就新开 */ }
      if (this.deps.getSession(id)) return id;
    }
    this.prepareWorkspace();
    id = randomUUID();
    const created = await this.deps.createSession('codeagent', { id, cwd: this.workspace, title: '公司助理', purpose: PURPOSE, autonomous: true, noInheritCursor: true });
    if (!created || created.id !== id) throw new Error('助理会话没能打开');
    this.saveState({ sessionId: id, primed: null, toolsVersion: TOOLS_VERSION });
    return id;
  }
  async pump() {
    if (this.job || !this.queue.length || this.pumping) return;
    this.pumping = true;
    const job = this.queue.shift();
    try {
      this.job = job;
      if (job.type === 'chat') this.patchChat(job.chatId, { state: 'running' });
      const id = await this.ensureSession();
      if (this.sessionBusy(id)) { this.queue.unshift(job); this.job = null; return; }
      const st = this.state();
      const instructionsDay = D.dayKey(this.now());
      const prompt = st.primed === id && st.instructionsVersion === INSTRUCTIONS_VERSION && st.instructionsDay === instructionsDay ? job.prompt : this.instructions() + '\n\n---\n\n' + job.prompt;
      job.baseline = this.lastFinal(id)?.id || null;
      job.sessionId = id;
      job.sentAt = this.now();
      const receipt = await this.deps.sendPrompt(id, prompt, randomUUID());
      if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) throw new Error(receipt?.error || '问题没有发进助理会话');
      this.saveState({ primed: id, instructionsVersion: INSTRUCTIONS_VERSION, instructionsDay });
    } catch (error) {
      this.failJob(job, error.message);
    } finally { this.pumping = false; this.changed(); }
  }
  async collectJob() {
    const job = this.job;
    if (!job || !job.sentAt) { if (!job) void this.pump(); return; }
    if (this.sessionBusy(job.sessionId)) { if (this.now() - job.sentAt > JOB_TIMEOUT_MS * 2) this.failJob(job, '助理会话忙了太久'); return; }
    const final = this.lastFinal(job.sessionId);
    if (final && final.id !== job.baseline && String(final.text || '').trim()) {
      this.job = null;
      if (job.type === 'chat') this.patchChat(job.chatId, { state: 'done', a: final.text, answeredAt: this.now() });
      else this.finishBrief(job, final.text, null);
      this.changed();
      void this.pump();
      return;
    }
    if (this.now() - job.sentAt > JOB_TIMEOUT_MS) this.failJob(job, `助理会话 ${Math.round(JOB_TIMEOUT_MS / 60000)} 分钟没给出回答`);
  }
  failJob(job, message) {
    if (this.job === job) this.job = null;
    if (job.type === 'chat') this.patchChat(job.chatId, { state: 'error', error: message });
    else this.finishBrief(job, '', message);
    this.changed();
    setTimeout(() => { void this.pump(); }, 0);
  }
  patchChat(id, patch) {
    this.saveChat(this.chat().map(c => c.id === id ? { ...c, ...patch } : c));
    if (patch.state === 'done' || patch.state === 'error') { const item = this.chat().find(c => c.id === id); if (item?.via === 'phone') this.phone.settle(item); }
  }

  // ---- 登录与日历初始化（只在用户点按钮时） ----
  async login() {
    if (this.loginFlow && this.loginFlow.state === 'waiting') return this.loginFlow;
    this.loginFlow = { state: 'waiting', startedAt: this.now(), qr: null, text: '' };
    this.changed();
    const done = this.welink(['auth', 'login'], { allowSetup: true, timeoutMs: 5 * 60000, onData: text => {
      this.loginFlow = { ...this.loginFlow, text: text.slice(-4000), qr: welink.qrFromLoginOutput(text) || this.loginFlow.qr };
      this.changed();
    } }).then(r => {
      this.loginFlow = { ...this.loginFlow, state: 'finished', code: r.code, text: (r.stdout + r.stderr).slice(-4000), qr: this.loginFlow.qr || welink.qrFromLoginOutput(r.stdout + r.stderr) };
    }).catch(error => { this.loginFlow = { ...this.loginFlow, state: 'failed', error: error.message }; })
      .then(() => this.refresh({ force: true }).catch(() => {}))
      .then(snap => { if (snap?.login?.ok) { this.loginFlow = { ...this.loginFlow, state: 'ok' }; const day = D.dayKey(this.now()); if (!this.brief(day) || this.brief(day).by === 'none') void this.generateBrief().catch(() => {}); } this.changed(); });
    // 二维码一般几秒内出来；先等一会儿再回，界面随后靠状态刷新。
    await Promise.race([done, new Promise(r => setTimeout(r, 4000))]);
    return this.loginFlow;
  }
  async setupCalendar(email) {
    const addr = String(email || this.settings().email || (await this.accountEmail()).email || '').trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(addr)) throw new Error('请填写公司邮箱地址');
    if (addr !== this.settings().email) this.setSettings({ email: addr });
    const r = await this.welink(['mail', 'autodiscover', '--email', addr], { allowSetup: true, timeoutMs: 120000 });
    const snap = await this.refresh({ force: true });
    return { ok: !snap.calendarNeedsSetup, output: D.short(r.stdout + r.stderr, 400), needsSetup: snap.calendarNeedsSetup };
  }

  status() {
    const s = this.settings(), now = this.now(), day = D.dayKey(now), snap = this.snapshot(day), st = this.state();
    const next = this.nextBriefAt(s, now);
    const sid = st.sessionId || null;
    return { ok: true, enabled: s.enabled, now, day, settings: s, chips: [...BUILTIN_CHIPS, ...s.chips.map(c => ({ ...c, custom: true }))],
      cliFound: !!this.cli(), cliPath: this.cli() || '', cliSearch: this.cliSearch || { state: 'idle' }, login: snap?.login || null, loginFlow: this.loginFlow, calendarNeedsSetup: !!snap?.calendarNeedsSetup, mailSetup: snap?.mailSetup || null,
      counts: snap ? { meetings: (snap.meetings || []).length, calendar: (snap.calendar || []).length, messages: Object.values(snap.messages || {}).reduce((n, l) => n + l.length, 0), mails: (snap.mails || []).length } : null,
      refreshedAt: snap?.at || null, refreshing: !!this.refreshing, errors: snap?.errors || [], conversations: (snap?.conversations || []).slice(0, 60), scope: snap?.scope || null, nameResolution: snap?.nameResolution || null, meetingCoverage: snap?.meetingCoverage || null,
      brief: this.brief(day), nextBriefAt: next, chat: this.chat().slice(-60), job: this.job ? { type: this.job.type, sentAt: this.job.sentAt || null } : null,
      queued: this.queue.length, session: sid ? { id: sid, open: !!this.deps.getSession(sid), busy: this.sessionBusy(sid) } : null,
      notices: st.notices.slice(0, 10), commitments: st.commitments, phone: this.phone.status() };
  }
  nextBriefAt(s, now) {
    const at = new Date(now); const [h, m] = s.briefTime.split(':').map(Number);
    for (let i = 0; i < 8; i += 1) {
      const d = new Date(at.getFullYear(), at.getMonth(), at.getDate() + i, h, m);
      if (d.getTime() > now && (s.workdays || []).includes(d.getDay())) return d.getTime();
    }
    return null;
  }
}

module.exports = { CompanyAssistant, PURPOSE, TOOLS_VERSION, DEFAULT_SETTINGS, BUILTIN_CHIPS, INSTRUCTIONS };
