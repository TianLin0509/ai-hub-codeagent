'use strict';
// 家里远程让公司 Hub 自己更新 / 重启（2026-10-17 用户：「不用为了更新 AI HUB 专门到公司一趟」）。
// 公司一端：收家里经加密通道发来的 hub-admin 指令，用这台 Hub 现有的一键更新流程（main/app-update-controller.js：
// 查版本 → 多源下载 → 校验 → 暂存 → 替换脚本 → 重启，失败自动回滚）完成，进度和结果用 hub-admin-status 报回家里。
//
//   家里 → 公司：{ type:'hub-admin', op:'update'|'restart'|'status', id, gen, force? }
//   公司 → 家里：{ type:'hub-admin-status', id, phase, note, current, latest, at, lastResult? }
//
// 底线：只处理当前配对代次的指令；同一时间只跑一条；只更新到发行源上的正式版本（清单校验 + sha256 由控制器保证，
// 通道里不接受任何文件或网址）；不降级（planUpdate 保证）。
//
// 重启时机（2.1.9，用户 10-17 22:40：「先记着，先重启中断，等重启完后再恢复——效率更高」）：
// 有在干活的会话时先等一个宽限期（设置 restartGraceMinutes，默认 3 分钟，0 = 立即；force = 0）；宽限内都答完就直接重启，
// 到时还有在干活的，就把这些会话记进持久化清单 resumeAfterRestart，立即重启；重启后逐个恢复会话，经正规发送入口
// 发一句纯「继续」（receipt-reader.js 的 BARE_CONTINUE 把它认作同一轮的延续，回执归属不变），通道轮次保持在途、
// 回执照常发回家里。恢复失败的通道轮次按现有失败流程报回家里（家里可补收或追问）；本机会话在侧栏标「重启打断」。
// 指令状态存在通道数据库里：重启后读替换脚本留下的结果（takeLastResult），通道接通时报回家里。
const { randomUUID } = require('node:crypto');
const { BARE_CONTINUE, transcriptTurnFinished } = require('./receipt-reader');

const HISTORY = 20;
// diag（2026-10-18 直查通道，diag.js）：只读，直接采集电脑与 Hub 状态回报，不经 CodeAgent、不排队；和更新 / 重启互不影响。
// act（2026-10-18 三期远程维护，remote-act.js）：休眠空闲通道会话、结束残留进程、临时调并行档位、取消排队 / 重试问题。
// files（2026-10-20 用户：把公司电脑上的文本文件直接拿回家里帮 wireless-sim 的设计，见 file-query.js）。
const OPS = ['update', 'restart', 'status', 'diag', 'act', 'files'];
// quota（2026-10-18 额度感知）：认得 ask/followup 的 account、直查 errors 段、远程维护 pause-account / resume-account。
// personal-model（2026-10-19）：认得模型配置避让、远程维护 set-personal-model（修正个人账号默认模型）。
const CAPS = ['diag', 'act', 'quota', 'personal-model', 'files'];
// 执行中的阶段；其余都是结束态。
const LIVE = ['checking', 'downloading', 'waiting', 'applying', 'restarting'];
const GRACE_DEFAULT_MINUTES = 3;
const GRACE_MAX_MINUTES = 30;
// 发出重启后这么久进程还在：重启没成（例如有会话没能保存退出、关闭被取消），作废这条指令。
const WATCHDOG_MS = 3 * 60000;
// 重启后发给被中断会话的话：只能是纯「继续」，多一个字就会被回执核对当成新提问（BARE_CONTINUE）。
const RESUME_TEXT = '继续';
if (!BARE_CONTINUE.test(RESUME_TEXT)) throw new Error('RESUME_TEXT 必须被 BARE_CONTINUE 认作续跑');
// 侧栏「重启打断，未能自动恢复」标记保留多久（有人在那个会话里打过字就提前消失）。
const ISSUE_TTL_MS = 24 * 3600000;

const runningRound = t => (t.rounds || []).find(x => !x.reply && !x.error && x.sentAt) || null;
const short = (s, n = 60) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

class HubAdmin {
  constructor({ bridge, deps }) {
    this.bridge = bridge; this.deps = deps; this.runner = null;
    // 每次程序启动一个编号：重启前写下的恢复清单，只在下一次启动里处理。
    this.boot = randomUUID();
    // 程序重开：上次停在检查 / 下载 / 等待的指令已随进程消失（下载好的暂存在内存里），如实报失败。
    const job = this.job();
    if (job && ['checking', 'downloading', 'waiting'].includes(job.phase)) {
      this.finish(job, 'failed', '公司 Hub 中途重启，这条指令没做完；可以再发一次');
    }
  }
  now() { return this.bridge.now(); }
  state() { return this.bridge.store.get('hubAdmin') || {}; }
  save(patch) { const next = { ...this.state(), ...patch }; this.bridge.store.set('hubAdmin', next); return next; }
  job() { return this.state().job || null; }
  controller() { try { return this.deps.appUpdate?.() || null; } catch { return null; } }
  current() {
    const c = this.controller();
    return String(c?.getState?.().current || this.deps.currentVersion || '') || null;
  }
  latest() { const c = this.controller(); return c?.getState?.().latest?.version || null; }
  graceMinutes() {
    const m = Number(this.bridge.settings().restartGraceMinutes);
    return Number.isFinite(m) ? Math.min(GRACE_MAX_MINUTES, Math.max(0, Math.round(m))) : GRACE_DEFAULT_MINUTES;
  }

  // 报回家里：带上当前版本与发行源上的最新版本。
  report(id, phase, note, extra = {}) {
    // caps：这台 Hub 认得的远程指令能力；对端据此判断能不能发直查，版本旧的不白等（2026-10-18 审核）。
    const payload = { id: id || null, gen: this.bridge.link.gen(), phase, note, current: this.current(), latest: this.latest(), at: this.now(), caps: CAPS, ...extra };
    // 直查 / 读文件的回报内容（压缩包）不进本机历史，只记摘要。
    const { diag: _diag, files: _files, ...brief } = payload;
    const history = [brief, ...(this.state().history || [])].slice(0, HISTORY);
    this.save({ history });
    if (!this.bridge.link.paired()) return Promise.resolve();
    return this.bridge.link.send('hub-admin-status', payload).catch(() => {});
  }
  setJob(job) { this.save({ job }); this.bridge.changed(); return job; }
  finish(job, phase, note, extra = {}) {
    this.save({ job: { ...job, phase, note, endedAt: this.now() } });
    this.bridge.changed();
    return this.report(job.id, phase, note, extra);
  }
  // 等待安全重启、以及已报「即将重启」到进程退出的这段时间，暂不派发新任务（通道的 advance 读它），排队的任务重启后接着做。
  // applying / restarting 只在本进程里算数：重启后的新进程里这个标记由 announce 结案，不能挡住派发。
  holdingDispatch() {
    const j = this.job();
    if (!j) return false;
    if (j.phase === 'waiting') return true;
    return ['applying', 'restarting'].includes(j.phase) && !!this.applying;
  }
  // 指令是在哪一次配对下发来的：解除或重新配对后作废（旧指令没有 gen 的不查）。
  stale(job) { return !!job.gen && job.gen !== this.bridge.link.gen(); }

  receive(message) {
    if (message.type !== 'hub-admin') return false;
    const gen = this.bridge.link.gen();
    if (!gen || message.gen !== gen) return true; // 上一次配对的指令，或没带代次
    const id = String(message.id || '').slice(0, 40);
    if (!/^[A-Za-z0-9-]{3,40}$/.test(id) || !OPS.includes(message.op)) return true;
    const seen = this.state().seen || [];
    if (seen.includes(id)) return true; // 发件箱重发、服务端重放
    this.save({ seen: [id, ...seen].slice(0, 50) });
    if (message.op === 'status') { void this.report(id, 'status', this.describe()); return true; }
    if (message.op === 'act') {
      this.actTask = this.act(id, message).catch(error => { try { return Promise.resolve(this.report(id, 'failed', '远程维护没做完：' + error.message)).catch(() => null); } catch { return null; } });
      return true;
    }
    if (message.op === 'diag') {
      // 回报本身也可能在 Hub 退出的瞬间失败（库已关）：一律兜住，不留未处理的 rejection（2026-10-18 审核）。
      this.diagTask = this.diag(id, message).catch(error => { try { this.auditDiag(`failed ${id} ${error.message}`); return Promise.resolve(this.report(id, 'failed', '直查没做完：' + error.message)).catch(() => null); } catch { return null; } });
      return true;
    }
    if (message.op === 'files') {
      // 读文件（2026-10-20，file-query.js）：和直查一样只读、不等任务、不占并行名额；自己的开关单独管。
      this.filesTask = this.files(id, message).catch(error => { try { this.auditFiles(`failed ${id} ${error.message}`); return Promise.resolve(this.report(id, 'failed', '读文件没做完：' + error.message)).catch(() => null); } catch { return null; } });
      return true;
    }
    if (this.bridge.settings().allowRemoteAdmin === false) { void this.report(id, 'refused', '公司端没允许远程更新（公司 Hub「AI特战队专用功能」设置里可以打开）'); return true; }
    if (message.op === 'update' && !this.controller()) { void this.report(id, 'unsupported', '这台 Hub 不是安装版，不能远程更新'); return true; }
    if (message.op === 'restart' && !this.deps.relaunch) { void this.report(id, 'unsupported', '这台 Hub 不能远程重启'); return true; }
    const running = this.job();
    if (running && LIVE.includes(running.phase)) {
      // 旧指令还在等任务答完：新指令带 force 或换了动作，就由新指令接手（家里想改主意时不用干等旧的那条）。
      if (running.phase === 'waiting' && !this.applying && (message.force === true || message.op !== running.op)) {
        void this.finish(running, 'superseded', `被新指令 ${id}（${message.op === 'update' ? '更新' : '重启'}${message.force === true ? '，force' : ''}）取代，这条不再执行`);
      } else {
        void this.report(id, 'busy', `上一条远程指令（${running.id}）还在执行，这条没处理；等它结束再发`);
        return true;
      }
    }
    const job = this.setJob({ id, op: message.op, gen, force: message.force === true, phase: message.op === 'update' ? 'checking' : 'waiting', receivedAt: this.now() });
    this.bridge.notify(message.op === 'update' ? '家里让这台 Hub 更新' : '家里让这台 Hub 重启', '编号 ' + id);
    if (message.op === 'update') this.runner = this.runUpdate(job).catch(error => this.finish(this.job() || job, 'failed', '更新失败：' + error.message)).finally(() => { this.runner = null; });
    else {
      const grace = this.graceMinutes();
      void this.report(id, 'accepted', job.force || grace === 0 ? '收到重启指令，马上重启（手上的任务先记下，重启后自动接着做）'
        : `收到重启指令，等手上的任务答完再重启（最多等 ${grace} 分钟，到时先记下、重启后自动接着做）`);
      void this.advance();
    }
    return true;
  }
  describe() {
    const c = this.controller(), st = c?.getState?.() || {};
    const j = this.job();
    const parts = [`当前 v${this.current() || '?'}`];
    if (!c) parts.push('不是安装版，不能远程更新');
    else if (st.latest?.version) parts.push(`发行源最新 v${st.latest.version}`);
    if (st.phase && st.phase !== 'idle' && c) parts.push('一键更新状态：' + st.phase);
    if (j && LIVE.includes(j.phase)) parts.push(`远程指令 ${j.id} 进行中（${j.note || j.phase}）`);
    parts.push(this.bridge.settings().allowRemoteAdmin === false ? '远程更新：未允许' : `远程更新：已允许（重启前最多等 ${this.graceMinutes()} 分钟）`);
    return parts.join(' · ');
  }

  // ---- 直查（2026-10-18，diag.js）：采集 → 脱敏 → 压缩 → 一条 hub-admin-status（phase:'diag'）报回 ----
  // 限频：同类最快 30 秒一次；同一时间只跑一条。每次写审计日志（logs/company-diag.log），界面给一条不打断的轻提示。
  async diag(id, message) {
    const D = require('./diag');
    const { sections, ignored } = D.parseSections(message.sections);
    const lines = D.parseLines(message.lines);
    const now = this.now(), last = Number(this.state().lastDiagAt) || 0;
    if (this.bridge.settings().allowRemoteDiag === false) return this.refuseDiag(id, sections, '这台电脑没允许对端查看状态（「AI特战队专用功能」设置的「状态查看」里可以打开）');
    if (this.diagRunning) return this.refuseDiag(id, sections, '上一条直查还在采集，这条没处理；等它回报后再发');
    if (now - last < D.MIN_INTERVAL_MS && now >= last) {
      return this.refuseDiag(id, sections, `${D.MIN_INTERVAL_MS / 1000} 秒内只查一次：上一次在 ${Math.round((now - last) / 1000)} 秒前，稍后再发`);
    }
    this.diagRunning = true;
    this.save({ lastDiagAt: now });
    const b = this.bridge;
    // 对端在看：接下来一段时间加快检查通道，紧接着的追查能更快送到（同 company.js saveThread 的追问窗口）。
    try { if (b.link.gen()) { b.store.set('pollActivity', { gen: b.link.gen(), until: now + 10 * 60000 }); b.tightenPoll?.(); } } catch { /* 只影响快慢 */ }
    b.notify('对端查看了这台电脑的状态', `编号 ${id} · ${sections.map(s => D.SECTION_LABEL[s]).join('、')}`, null, { quiet: true });
    try {
      const raw = await D.collect({ bridge: b, sections, lines, errorsLimit: D.parseErrorsLimit(message.errors) });
      // 记下这次直查认定「可结束」的残留（PID + 启动时间），远程维护 kill-orphans 只认 5 分钟内这份清单（remote-act.js）
      if (raw.processes && Array.isArray(raw.processes.leftovers)) this.save({ lastDiagKillable: { at: this.now(), id, list: raw.processes.leftovers.filter(x => x.killable).map(x => ({ pid: x.pid, startedAt: x.startedAt, name: x.name })) } });
      if (ignored.length) raw.ignored = ignored;
      // 号身份取一次快照，整份结果共用（逐个字符串读盘会卡住主进程）。
      const secrets = b.accountSecrets();
      b.secretsSnapshot = secrets; // 量大小时每次封装消息也要脱敏：这次直查期间共用这一份，结束即清（finally）
      const redact = D.makeRedactor({ scrub: s => b.scrubText(s, secrets), extra: process.env.HUB_UNLOCK_PHRASE ? [process.env.HUB_UNLOCK_PHRASE] : [] });
      const result = D.deepRedact(raw, redact);
      const base = { id, gen: b.link.gen(), phase: 'diag', current: this.current(), latest: this.latest(), at: this.now() };
      const draftNote = D.summarize(result) + ' · 超长已精简：进程只留前 5，残留嫌疑只留前 5，会话列表省略';
      const measure = data => {
        // 量的时候按最长的样子算：段落、整张降级清单、耗时位数都带上（2026-10-18 审核）。
        const item = b.link.prepare('hub-admin-status', { ...base, note: draftNote, diag: data, diagBytes: 99999, elapsedMs: 9999999, sections, degraded: [...D.STEP_LABELS, '全部省略'] });
        return Buffer.byteLength(JSON.stringify({ to: item.to, mid: item.mid, blob: item.blob }), 'utf8');
      };
      const fitted = b.link.paired() ? D.fit(result, measure) : { data: D.encode(result), result, degraded: [], bytes: 0 };
      const note = D.summarize({ ...result, degraded: fitted.degraded });
      this.auditDiag(`diag ${id} sections=${sections.join(',')}${ignored.length ? ' ignored=' + ignored.join(',') : ''} elapsed=${result.elapsedMs}ms bytes=${fitted.bytes}${fitted.degraded.length ? ' degraded=' + fitted.degraded.length : ''}`);
      await this.report(id, 'diag', note, { diag: fitted.data, diagBytes: fitted.bytes, elapsedMs: result.elapsedMs, sections, ...(fitted.degraded.length ? { degraded: fitted.degraded } : {}) });
      this.save({ lastDiag: { id, at: this.now(), sections, elapsedMs: result.elapsedMs, bytes: fitted.bytes, degraded: fitted.degraded.length } });
      return fitted;
    } finally {
      // 限频从这次采集结束算（采集慢时，紧接着的下一次不会马上又压上来）
      this.diagRunning = false; this.bridge.secretsSnapshot = null;
      try { this.save({ lastDiagAt: this.now() }); } catch { /* 库已关 */ }
    }
  }
  refuseDiag(id, sections, why) {
    this.auditDiag(`refused ${id} sections=${sections.join(',')} ${why}`);
    return this.report(id, 'refused', '直查：' + why);
  }
  auditDiag(line) { try { this.bridge.appendLog?.('company-diag.log', line); } catch { /* 审计日志写不了不挡回报 */ } }

  // ---- 读文件（2026-10-20 用户，file-query.js）----
  // 和直查同一套：限频、同一时间只跑一条、正文只脱凭据、gzip 压缩、一条 hub-admin-status（phase:'files'）报回。
  // 只读：没有写、改、删、执行任何文件的路径；能读的目录是设置里的仿真结果目录 + 代码位置 + 额外可读目录。
  async files(id, message) {
    const F = require('./file-query');
    const action = String(message.action || '');
    if (!F.ACTIONS.includes(action)) return this.refuseFiles(id, action, `不认识的动作：${short(action, 30)}（只认 ${F.ACTIONS.join(' / ')}）`);
    if (this.bridge.settings().allowRemoteFiles === false) return this.refuseFiles(id, action, '这台电脑没允许对端读取文件（「AI特战队专用功能」设置的「文件读取」里可以打开）');
    let params;
    try { params = F.parseParams(action, message.params); } catch (error) { return this.refuseFiles(id, action, error.message); }
    // 限频按动作各算各的（读文件 5 秒、列目录 10 秒、找文件 20 秒）：列过目录不影响紧接着读文件
    const now = this.now();
    const gap = F.INTERVALS[action] || F.MIN_INTERVAL_MS;
    const lastBy = this.state().lastFilesByAction || {};
    const last = Number(lastBy[action]) || 0;
    if (this.filesRunning) return this.refuseFiles(id, action, '上一条文件读取还在跑，这条没处理；等它回报后再发');
    if (now - last < gap && now >= last) return this.refuseFiles(id, action, `${gap / 1000} 秒内只做一次：上一次在 ${Math.round((now - last) / 1000)} 秒前，稍后再发`);
    this.filesRunning = true;
    this.save({ lastFilesAt: now, lastFilesByAction: { ...lastBy, [action]: now } });
    const b = this.bridge;
    // 对端在看：接下来一段时间加快检查通道（同直查）
    try { if (b.link.gen()) { b.store.set('pollActivity', { gen: b.link.gen(), until: now + 10 * 60000 }); b.tightenPoll?.(); } } catch { /* 只影响快慢 */ }
    b.notify('对端读了这台电脑上的文件', `编号 ${id} · ${F.LABEL[action]}${action === 'read' ? '：' + short(params.file, 80) : action === 'list' ? '：' + short(params.dir, 60) : ''}`, null, { quiet: true });
    try {
      const roots = F.fileRoots(b);
      // 正文只脱凭据（账号实值 + key=value / 私钥块 / 各类 key 样式）；不动代码、路径、URL（动 URL 会把源码和报告读成废纸）
      const secrets = b.accountSecrets();
      b.secretsSnapshot = secrets;
      const redact = F.makeFileRedactor({ scrub: s => b.scrubText(s, secrets), extra: process.env.HUB_UNLOCK_PHRASE ? [process.env.HUB_UNLOCK_PHRASE] : [] });
      // 注意：read 的脱敏交给 file-query 在**整篇**上做（跨行的私钥块按行脱等于没脱，2026-10-20 被 e2e 逮到过）
      const raw = await F.run({ roots, action, params, redact });
      if (typeof raw.sample === 'string') raw.sample = redact(raw.sample);
      const base = { id, gen: b.link.gen(), phase: 'files', current: this.current(), latest: this.latest(), at: this.now() };
      const draftNote = F.summarize(raw);
      const measure = data => {
        const item = b.link.prepare('hub-admin-status', { ...base, note: draftNote, files: data, filesBytes: 99999, action, degraded: [...F.STEP_LABELS, '全部省略'] });
        return Buffer.byteLength(JSON.stringify({ to: item.to, mid: item.mid, blob: item.blob }), 'utf8');
      };
      const fitted = b.link.paired() ? F.fit(raw, measure, require('./diag').MESSAGE_LIMIT - 400) : { data: require('./diag').encode(raw), result: raw, degraded: [], bytes: 0 };
      const note = F.summarize({ ...fitted.result, degraded: fitted.degraded });
      this.auditFiles(`files ${id} ${action} ${JSON.stringify(params)} roots=${roots.length} bytes=${fitted.bytes}${fitted.degraded.length ? ' degraded=' + fitted.degraded.length : ''} → ${short(note, 300)}`);
      await this.report(id, 'files', note, { files: fitted.data, filesBytes: fitted.bytes, action, ...(fitted.degraded.length ? { degraded: fitted.degraded } : {}) });
      this.save({ lastFiles: { id, at: this.now(), action, bytes: fitted.bytes, degraded: fitted.degraded.length } });
      return fitted;
    } catch (error) {
      // 护栏类拒绝（路径越界 / 不是文本 / 二进制 / 太大）算「拒绝」不算「出错」：审计日志记 refused、
      // 家里看到的是「公司没处理」。保安要的正是这类「有人试图读不该读的东西、被挡了」的证据。
      if (error && ['outside', 'not-text', 'binary', 'too-big'].includes(error.code)) return this.refuseFiles(id, action, error.message);
      throw error;
    } finally {
      this.filesRunning = false; this.bridge.secretsSnapshot = null;
      try { this.save({ lastFilesByAction: { ...(this.state().lastFilesByAction || {}), [action]: this.now() } }); } catch { /* 库已关 */ }
    }
  }
  refuseFiles(id, action, why) {
    this.auditFiles(`refused ${id} ${action || '?'} ${why}`);
    // 回报里带上具体动作（读文件 / 列目录 / 找文件），家里一看就知道是哪条被挡了
    const F = require('./file-query');
    const label = F.LABEL[action];
    return this.report(id, 'refused', (label && label !== '读文件' ? `读文件·${label}：` : '读文件：') + why);
  }
  auditFiles(line) { try { this.bridge.appendLog?.('company-files.log', line); } catch { /* 审计日志写不了不挡回报 */ } }

  // ---- 远程维护（2026-10-18 三期，remote-act.js）----
  remoteAct() { if (!this.actor) { const { RemoteAct } = require('./remote-act'); this.actor = new RemoteAct(this); } return this.actor; }
  async act(id, message) {
    const out = await this.remoteAct().run(id, message);
    await this.report(id, out.phase, out.note, { act: out.act });
    return out;
  }

  async runUpdate(job) {
    const c = this.controller();
    let st = c.getState();
    if (st.phase !== 'ready') {
      st = await c.check({ silent: false });
      if (st.phase === 'none') return this.finish(job, 'up-to-date', `已是最新 v${this.current()}`);
      if (st.phase === 'error') return this.finish(job, 'failed', '查不到新版本：' + (st.error || '所有更新源都连不上'));
      if (st.phase === 'downloading') st = await this.waitDownload(c);
    }
    // 完整安装包要在公司电脑上点安装向导（oneClick:false）：远程退出后没人点，Hub 就一直关着。只走增量包。
    if (st.plan?.kind === 'full') return this.finish(job, 'failed', `v${st.latest?.version} 需要完整安装包（${st.plan.reason || '运行时有变化'}），安装向导要在公司电脑上点，远程不做；下次到公司时在设置菜单「检查更新」里手动装`);
    if (st.phase === 'available') {
      const mb = st.plan?.bytes ? `，${(st.plan.bytes / 1048576).toFixed(1)} MB` : '';
      const kind = st.plan?.kind === 'full' ? '完整安装包' : '增量包';
      this.setJob({ ...this.job(), phase: 'downloading', target: st.latest?.version });
      await this.report(job.id, 'downloading', `开始下载 v${st.latest?.version}（${kind}${mb}）`);
      st = await c.download();
      if (st.phase === 'downloading') st = await this.waitDownload(c);
    }
    if (st.phase !== 'ready') {
      const why = st.error || (st.attempts || []).map(a => `${a.name || a.id}：${a.reason || a.error || '失败'}`).join('；') || '没有下载完成';
      return this.finish(job, 'failed', '下载失败：' + why);
    }
    const target = st.latest?.version;
    // 下载期间被新指令取代或换了配对：不再往下走。
    const latest = this.job();
    if (!latest || latest.id !== job.id) return;
    if (this.stale(latest)) return this.finish(latest, 'failed', '配对已变化（解除或重新配对），这条远程指令作废');
    this.setJob({ ...latest, phase: 'waiting', target, waitSince: this.now() });
    await this.report(job.id, 'downloaded', `已下载 v${target}，校验通过`);
    return this.advance();
  }
  async waitDownload(c) {
    for (let i = 0; i < 3600; i++) {
      const st = c.getState();
      if (st.phase !== 'downloading') return st;
      await new Promise(r => setTimeout(r, 1000));
    }
    return c.getState();
  }

  // 正在干活的：通道里在作答的轮次 + 在忙的 CodeAgent 会话（人自己开的也算）。一个会话只记一次。
  // 通道轮次的原生记录最近 10 分钟还在写（transcriptFresh：长时间的 AirView 编译、仿真，会话表里可能查不到）也算在干活。
  workingList() {
    const b = this.bridge, out = [], seen = new Set();
    const fresh = id => { try { return !!b.transcriptFresh?.(id); } catch { return false; } };
    for (const t of b.openThreads()) {
      if (t.state !== 'running' || !t.sessionId || seen.has(t.sessionId) || !(b.roundWorking(t) || fresh(t.sessionId))) continue;
      // 会话停着、这一轮的回答已经写完（只等通道下一轮核对发回）：不算在干活，不能给它补「继续」。
      if (!b.sessionBusy(t.sessionId) && this.answered(t)) continue;
      seen.add(t.sessionId);
      out.push({ sessionId: t.sessionId, kind: 'bridge', thread: t.id, round: runningRound(t)?.round ?? null });
    }
    for (const id of (this.deps.listSessionIds?.() || [])) {
      if (seen.has(id)) continue;
      const s = this.deps.getSession?.(id);
      if (s && String(s.kind || '').replace(/-resume$/, '') === 'codeagent' && b.sessionBusy(id)) {
        seen.add(id);
        out.push({ sessionId: id, kind: 'local', thread: null, round: null, title: short(s.title, 40) || null });
      }
    }
    return out;
  }
  workingCount() { return this.workingList().length; }
  // 这一轮发出之后，会话里已经有新的最终回答（不是发前那条基线）。
  answered(t) {
    const r = runningRound(t);
    if (!r || !t.sessionId) return false;
    let final = null;
    try { final = this.bridge.lastFinal(t.sessionId); } catch { return false; }
    return !!final && final.id !== r.baseline;
  }
  // 由通道定时器调用：等待阶段看能不能重启了；重启阶段看进程是不是真的退出了（看门狗）。
  async advance() {
    // 远程维护临时调的并行档位：到点恢复（remote-act.js）
    if (this.state().parallelRestore) { try { await this.remoteAct().restoreDue(); } catch (e) { console.warn('[hub-admin] 恢复并行档位', e.message); } }
    const job = this.job();
    if (!job || !LIVE.includes(job.phase)) return;
    if (['applying', 'restarting'].includes(job.phase)) {
      if (this.applying && this.now() - (job.restartAt || this.now()) > WATCHDOG_MS) return this.watchdog(job);
      return;
    }
    if (job.phase !== 'waiting' || this.applying) return;
    if (this.stale(job)) return this.finish(job, 'failed', '配对已变化（解除或重新配对），这条远程指令作废');
    const working = this.workingList();
    const grace = job.force ? 0 : this.graceMinutes();
    const waited = this.now() - (job.waitSince || job.receivedAt || this.now());
    const verb = job.op === 'update' ? `重启到 v${job.target}` : '重启';
    if (!working.length) return this.restartNow(job, `即将${verb}`);
    if (waited < grace * 60000) {
      if (job.waitingFor !== working.length) {
        this.setJob({ ...job, waitSince: job.waitSince || this.now(), waitingFor: working.length });
        const what = job.op === 'update' ? `已下载 v${job.target}，` : '';
        await this.report(job.id, 'waiting', `${what}等 ${working.length} 个任务答完后${verb}（最多等 ${grace} 分钟，到时先记下、中断，重启后自动接着做；期间新任务先排队）`);
      }
      return;
    }
    return this.interruptAndRestart(job, working, verb, grace);
  }
  // 「中断—恢复」：把在干活的会话记进持久化清单，再重启；清单在下一次启动里处理（resumeInterrupted）。
  async interruptAndRestart(job, working, verb, grace) {
    const at = this.now();
    const items = working.map(w => ({ ...w, interruptedAt: at }));
    this.save({ resumeAfterRestart: { jobId: job.id, boot: this.boot, at, items } });
    for (const item of items.filter(x => x.kind === 'bridge')) this.markRound(item, { resumePending: true, interruptedAt: at },
      '公司 Hub 要重启：这一轮先记下，重启后自动恢复会话接着做，回执照常发回');
    const why = job.force ? 'force：不等' : grace === 0 ? '宽限设为 0' : `等了 ${grace} 分钟`;
    return this.restartNow(job, `中断 ${items.length} 个任务后${verb}（${why}；重启后自动恢复这些会话并接着做）`, { interrupted: items.length });
  }
  markRound(item, patch, note) {
    const b = this.bridge, t = b.thread(item.thread);
    const r = t?.rounds.find(x => x.round === item.round);
    if (!t || !r) return null;
    const next = b.patchRound(t, r.round, patch);
    if (note && t.gen === b.link.gen()) void b.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'running', note }).catch(() => {});
    return next;
  }
  async restartNow(job, note, extra = {}) {
    this.applying = true;
    try {
      this.setJob({ ...job, phase: job.op === 'update' ? 'applying' : 'restarting', note, restartAt: this.now(), from: this.current(), ...extra });
      await this.report(job.id, 'restarting', note);
      // 等这条消息真的送出去再退出；送不出去也照常重启（发件箱持久，重启后补发）。
      await this.bridge.link.flush().catch(() => {});
      // 送消息卡了 3 分钟以上、看门狗已把这条判失败并清了恢复清单：不再重启，免得中断的会话没人接（2026-10-17 审核）。
      if (!this.applying) return;
      if (job.op === 'update') this.controller().apply();
      else this.deps.relaunch();
    } catch (error) {
      this.applying = false;
      this.dropResume(); // 没开始重启：会话没被中断，清单作废
      return this.finish(this.job() || job, 'failed', (job.op === 'update' ? '没能开始替换：' : '没能重启：') + error.message);
    }
  }
  // 发出重启 3 分钟后进程还在：重启没成。清掉标记、指令判失败；关闭途中已被停掉的会话照清单恢复，没停的不动。
  async watchdog(job) {
    this.applying = false;
    const verb = job.op === 'update' ? '替换更新' : '重启';
    await this.finish(job, 'failed', `${verb}没有完成：发出 3 分钟后公司 Hub 还没退出（可能有会话没能保存退出、关闭被取消），这条指令作废；可以再发一次`);
    return this.resumeInterrupted({ sameProcess: true });
  }
  dropResume() {
    const plan = this.state().resumeAfterRestart;
    if (!plan) return;
    this.save({ resumeAfterRestart: null });
    for (const item of (plan.items || []).filter(x => x.kind === 'bridge')) this.markRound(item, { resumePending: null });
  }

  // 重启后（通道定时器每轮调用，和配对无关）：逐个恢复清单里被中断的会话，发一句纯「继续」。
  // 每一项先标「恢复中」再动手：恢复途中程序又重启，下次不会再发第二遍（同一会话只恢复一次）。处理完清单即清空。
  async resumeInterrupted({ sameProcess = false } = {}) {
    const plan = this.state().resumeAfterRestart;
    if (!plan || !Array.isArray(plan.items)) return null;
    // 还没重启；有「CLI 还没就绪、到点再发」的项时照常处理（看门狗那条路径在本进程里恢复过会话）。
    if (!sameProcess && plan.boot === this.boot && !plan.items.some(x => x.state === 'waiting-ready')) return null;
    if (this.resuming) return null;
    if (!sameProcess && this.deps.appReady && !this.deps.appReady()) return null; // 窗口和钩子服务就绪后再恢复
    this.resuming = true;
    try {
      const items = plan.items.map(x => ({ ...x }));
      for (const item of items) {
        // 恢复出来的会话 CLI 还没就绪、「继续」明确没发出：到点再发（resumeOne）。
        if (item.state === 'waiting-ready' && item.retryAt > this.now()) continue;
        if (item.state && item.state !== 'waiting-ready') {
          if (item.state === 'resuming') { item.state = 'failed'; item.note = '上次恢复途中公司 Hub 又重启了，没有再发「继续」'; this.settle(item, false); }
          continue;
        }
        item.state = 'resuming';
        this.save({ resumeAfterRestart: { ...plan, items } });
        const outcome = await this.resumeOne(item, { sameProcess });
        Object.assign(item, outcome);
        this.save({ resumeAfterRestart: { ...plan, items } });
      }
      // 还有等 CLI 就绪的项：清单留着，下一轮定时器再处理；全部有结果后再回报。
      if (items.some(x => x.state === 'waiting-ready')) { this.save({ resumeAfterRestart: { ...plan, items } }); this.bridge.changed(); return { items, waiting: true }; }
      this.save({ resumeAfterRestart: null });
      const done = items.filter(x => x.state !== 'failed' && !x.skipped), failed = items.filter(x => x.state === 'failed');
      const reasons = failed.map(x => `${x.thread ? x.thread + ' 第 ' + x.round + ' 轮' : '本机会话' + (x.title ? '「' + x.title + '」' : '')}：${x.note}`).join('；');
      const note = `${sameProcess ? '重启没成，' : '重启后'}恢复被中断的任务：已恢复 ${done.length} 个，失败 ${failed.length} 个${failed.length ? '（' + reasons + '）' : ''}`;
      this.bridge.changed();
      if (done.length || failed.length) {
        if (failed.length) this.bridge.notify('重启后有任务没能接着做', short(reasons, 120));
        await this.report(plan.jobId, 'resumed', note, { resumed: done.length, resumeFailed: failed.length });
      }
      return { items, note };
    } finally { this.resuming = false; }
  }
  async resumeOne(item, { sameProcess }) {
    const b = this.bridge, id = item.sessionId;
    if (item.kind === 'bridge') {
      const t = b.thread(item.thread), r = t?.rounds.find(x => x.round === item.round);
      if (!t || t.state === 'cancelled' || t.gen !== b.link.gen() || !r || r.reply || r.error) {
        if (t && r) b.patchRound(t, r.round, { resumePending: null });
        return { state: 'resumed', skipped: true, note: '这一轮已结束或已作废，不用恢复' };
      }
      // 关闭前它已经把这一轮答完了（只是还没核对发回）：不发「继续」，交给通道照常收回执。
      if (this.answered(t)) {
        b.patchRound(t, r.round, { resumePending: null, resumedAt: this.now() });
        return { state: 'resumed', skipped: true, note: '重启前已答完，不用继续' };
      }
    }
    let ok = false, note;
    try {
      let live = this.deps.getSession(id);
      if (live && sameProcess) { ok = true; note = '没被中断'; }
      else {
        if (!live) {
          if (!this.deps.getSessionMetadata?.(id)) throw new Error('会话记录已经不在了');
          await this.deps.resumeSession(id);
          live = this.deps.getSession(id);
          if (!live) throw new Error('会话没能恢复');
        }
        if (b.sessionBusy(id)) { ok = true; note = '恢复后它已自己接着做'; }
        else if (item.kind === 'local' && this.localFinished(id)) {
          // 本机会话在关闭途中其实已经答完（最后一条记录是完整的回答）：恢复会话就够了，不补「继续」。
          return this.settleOutcome(item, { state: 'resumed', skipped: true, note: '重启前已答完，不用继续', at: this.now() }, true);
        } else {
          // 正规发送入口（session:send-prompt 同一路径，等 CLI 就绪、分块提交、语义确认），只发纯「继续」。
          const receipt = await this.deps.sendPrompt(id, RESUME_TEXT, randomUUID());
          // CLI 还没就绪（发送入口等了 60 秒没见到输入框，明确没发）：不判失败，隔 15 秒再发，最多等 5 分钟（同 company.js dispatch）。
          // 2026-10-18 v2.1.10 真机：重启后恢复出来的 CodeAgent 会话启动慢，「继续」和随后的派发都撞上 cli-not-ready。
          if (receipt && receipt.notSent && receipt.error === 'cli-not-ready') {
            const { NOT_READY_RETRY_MS, NOT_READY_MAX_MS } = require('./company');
            const since = item.notReadySince && item.notReadySince >= this.bridge.bootAt ? item.notReadySince : this.now(); // 上一个进程记的从头算
            if (this.now() - since < NOT_READY_MAX_MS) return { state: 'waiting-ready', notReadySince: since, retryAt: this.now() + NOT_READY_RETRY_MS, note: '会话已恢复，CLI 还没就绪，稍后再发「继续」' };
            throw new Error(`会话恢复后 CodeAgent 等了 ${Math.round((this.now() - since) / 60000)} 分钟仍没启动就绪（cli-not-ready），「继续」没有发出`);
          }
          if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) {
            throw new Error('「继续」没有发进会话：' + (receipt?.message || receipt?.error || '原因不明'));
          }
          ok = true; note = receipt.ok === false ? '已发「继续」，确认迟到' : '已发「继续」';
        }
      }
    } catch (error) { ok = false; note = short(error.message, 120); }
    return this.settleOutcome(item, { state: ok ? 'resumed' : 'failed', note, at: this.now() }, ok);
  }
  settleOutcome(item, outcome, ok) {
    // 落结果出错也不能卡住清单：否则这一项一直停在「恢复中」，后面的会话都轮不到（2026-10-17 审核）。
    try { this.settle({ ...item, ...outcome }, ok); }
    catch (error) { console.warn('[hub-admin] 恢复结果没能落下：' + (error && error.message)); }
    return outcome;
  }
  // 本机会话（不是通道轮次）重启前是不是已经答完：读原生记录，最后一条有效记录是带正文的完整回答（receipt-reader.js）。
  // 读不到记录不下结论，照旧发「继续」。
  localFinished(id) {
    const meta = this.deps.getSession?.(id) || this.deps.getSessionMetadata?.(id);
    try { return (this.deps.transcriptTurnFinished || transcriptTurnFinished)(meta) === true; } catch { return false; }
  }
  // 结果落到各自的地方：通道轮次继续在途（只清标记、记下恢复时间）或按失败流程报回家里；本机会话失败记进侧栏标记。
  settle(item, ok) {
    const b = this.bridge;
    if (item.kind === 'bridge') {
      const t = b.thread(item.thread), r = t?.rounds.find(x => x.round === item.round);
      if (!t || !r || r.reply || r.error) return;
      if (ok) { this.markRound(item, { resumePending: null, resumedAt: this.now() }, item.note === '没被中断' ? null : '公司 Hub 已重启，已恢复会话接着做，回执照常发回'); return; }
      const fresh = b.patchRound(t, r.round, { resumePending: null });
      b.failRound(fresh, fresh.rounds.find(x => x.round === r.round), `公司 Hub 重启后没能接着做这一轮（${item.note}）；可以补收（recollect）或追问重问`);
      return;
    }
    if (ok) return;
    const issues = (this.state().resumeIssues || []).filter(x => x.sessionId !== item.sessionId);
    this.save({ resumeIssues: [{ sessionId: item.sessionId, title: item.title || null, note: item.note, at: this.now() }, ...issues].slice(0, 20) });
  }
  // 侧栏「重启打断，未能自动恢复」：24 小时内、之后没人在那个会话里打过字、它也没在跑。
  resumeIssues() {
    return (this.state().resumeIssues || []).filter(x => this.now() - x.at < ISSUE_TTL_MS
      && !(Number(this.deps.sessionInputAt?.(x.sessionId)) > x.at) && !this.bridge.sessionBusy(x.sessionId));
  }

  // 通道接通后调用：报上次重启 / 更新的结果；版本变了也报一次，家里面板据此显示公司 Hub 版本。
  async announce() {
    if (!this.bridge.link.paired()) return;
    const c = this.controller();
    // 界面弹完提示会把 state.lastResult 清掉，用控制器留着的本次启动结果。
    const last = (c?.lastResult ? c.lastResult() : c?.getState?.().lastResult) || null;
    const st = this.state();
    const lastKey = last ? String(last.at || '') + '|' + String(last.version || '') : null;
    const job = this.job();
    if (job && ['applying', 'restarting'].includes(job.phase) && (!this.applying)) {
      let phase, note;
      if (job.phase === 'restarting') { phase = 'restarted'; note = `公司 Hub 已重启（v${this.current()}）`; }
      else if (last && last.ok) { phase = 'updated'; note = `公司 Hub 已更新到 v${last.version}`; }
      else if (last) { phase = 'rolled-back'; note = `更新失败：${last.reason || '原因不明'}，${last.rolledBack === false ? '回滚也没完成，请到公司电脑上看一眼' : '已回滚到 v' + (last.from || this.current())}`; }
      else { phase = 'failed'; note = `重启后没读到更新结果（替换脚本可能没跑起来），当前仍是 v${this.current()}`; }
      if (job.interrupted) note += `；重启前中断的 ${job.interrupted} 个任务正在恢复`;
      this.save({ lastKey, announced: { gen: this.bridge.link.gen(), version: this.current() } });
      return this.finish(job, phase, note, last ? { lastResult: last } : {});
    }
    if (last && lastKey !== st.lastKey) {
      // 在公司电脑上手动点的更新：同样告诉家里。
      this.save({ lastKey, announced: { gen: this.bridge.link.gen(), version: this.current() } });
      return this.report(null, last.ok ? 'updated' : 'rolled-back', last.ok ? `公司 Hub 已更新到 v${last.version}` : `更新失败：${last.reason || '原因不明'}，已回滚到 v${last.from || this.current()}`, { lastResult: last });
    }
    const a = st.announced || {};
    if (a.gen !== this.bridge.link.gen() || a.version !== this.current()) {
      this.save({ announced: { gen: this.bridge.link.gen(), version: this.current() } });
      return this.report(null, 'online', `公司 Hub 在线 · v${this.current()}`);
    }
  }
  status() {
    const s = this.state();
    return { job: s.job || null, history: (s.history || []).slice(0, 5), current: this.current(), installed: !!this.controller(),
      graceMinutes: this.graceMinutes(), resumeAfterRestart: s.resumeAfterRestart || null, resumeIssues: this.resumeIssues(), lastDiag: s.lastDiag || null,
      lastFiles: s.lastFiles || null, parallelRestore: s.parallelRestore || null };
  }
}

module.exports = { HubAdmin, OPS, RESUME_TEXT, WATCHDOG_MS, GRACE_DEFAULT_MINUTES };
