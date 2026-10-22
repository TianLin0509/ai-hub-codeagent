'use strict';
// 远程维护（2026-10-18 三期，hub-admin op:'act'）：对端在直查（diag.js）之后，请这台 Hub 做几件明确的维护动作。
// 每个动作单独白名单、单独校验；只认当前配对代次（hub-admin.js receive 已核）；公司设置「远程维护」总开关（allowRemoteMaintain，默认开）关了就回 refused。
// 每次执行写审计日志（logs/company-act.log），界面给一条不打断的轻提示「对端执行了：…」，回报动作结果和前后对比。
//
//   suspend-idle   让空闲的通道会话（purpose=company-bridge、不在干活、没有排队或在途的问题）立即休眠；人自己开的会话一律不动。
//                  走 suspendSession 现有底线（置顶、正看着、群聊成员不收；空闲不足 1 分钟不收）。
//   kill-orphans   只结束最近一次（5 分钟内）直查列为「可结束」的残留进程：对端传来的 PID + 启动时间必须和那次直查一致；
//                  动手前重新枚举进程、按同一套规则再判一次，仍是「可结束」、仍不在任何 Hub 进程树（当前的和别的）里才结束。
//                  只按 PID 结束，绝不按命令行匹配；永不结束 Hub 主进程、Hub 后台脚本和任何活着的 Hub 进程树里的进程。前后各记一次内存。
//   set-parallel   临时改 memFloorPct / maxParallel / maxParallelIdle / usePool（复用设置校验与上下限），可带「N 小时后恢复原值」。
//                  usePool=false：通道新开的会话只用个人账号（号池的号额度用完时从对端切走，2026-10-18 用户）。
//   cancel-queued  取消一个还在排队（没开会话、没在答）的问题，回执写明「被对端取消」。
//   retry          重试一个失败的问题（同页面上的「重试」按钮）。
//   pause-account  手动让一个号避让（代称：个人 / 号 1…），可带「N 小时后自动恢复」；通道新开会话、换号重做都不再挑它（额度感知，2026-10-18）。
//   resume-account 解除一个号的避让（手动暂停、识别到额度报错、Credit 读数，统统解除），之后照常派活。
//   set-personal-model 修正个人账号的默认模型（2026-10-19 用户授权）：只改个人配置目录 settings.json 的 model 一个键，目标必须在个人账号的权限清单里；
//                  改前整份备份、原子写、回读核对（不过就从备份还原），restore:true 用最近一次备份里的值撤销；只影响之后新开的会话；
//                  权限依据：清单经过探测，或个人账号实际作答过这个模型；都没有时拒绝，force:true 跳过这一条（回报、审计标「未经权限校验」）；
//                  改成某个模型成功后解除个人账号的模型配置避让，撤销不解除（core/codeagent-personal-model.js）。Hub 不会自动做这件事。
const os = require('node:os');

const ACTIONS = ['suspend-idle', 'kill-orphans', 'set-parallel', 'cancel-queued', 'retry', 'pause-account', 'resume-account', 'set-personal-model'];
const LABEL = { 'suspend-idle': '让空闲的通道会话休眠', 'kill-orphans': '结束残留进程', 'set-parallel': '临时调整并行档位', 'cancel-queued': '取消排队中的问题', retry: '重试失败的问题',
  'pause-account': '暂停派活给一个号', 'resume-account': '恢复派活给一个号', 'set-personal-model': '修改个人账号默认模型' };
// 限频：结束进程最快 60 秒一次，其余 10 秒一次（按动作分别算）。
const MIN_INTERVAL_MS = { 'kill-orphans': 60000, 'set-personal-model': 60000 };
const DEFAULT_INTERVAL_MS = 10000;
const DIAG_FRESH_MS = 5 * 60000;
const MAX_KILL = 20;
// 一次 kill-orphans 的总时长上限（v3.1.2）：单个进程最多等 5 秒确认退出，20 个就可能让对端等近 2 分钟。
// 到点后不再处理剩下的（如实回报），对端可以再执行一次，避免远程维护把连接拖死。
const KILL_BUDGET_MS = 30000;
const PARALLEL_KEYS = ['memFloorPct', 'maxParallel', 'maxParallelIdle'];
const THREAD_ID = /^[A-Za-z0-9-]{3,40}$/;

const mb = b => Math.round((Number(b) || 0) / 1048576);
const short = (s, n = 120) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// 对端传来的参数：只挑每个动作认得的字段，类型和范围先核一遍（设置的上下限由 setSettings 再核）。
function parseParams(action, raw = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  if (action === 'kill-orphans') {
    const list = Array.isArray(p.targets) ? p.targets : [];
    const targets = list.slice(0, MAX_KILL + 1).map(x => ({ pid: Number(x && x.pid), startedAt: Number(x && x.startedAt) }))
      .filter(x => Number.isInteger(x.pid) && x.pid > 0 && Number.isFinite(x.startedAt) && x.startedAt > 0);
    if (!targets.length) throw new Error('要给出进程的 PID 和启动时间（取自最近一次直查的「可结束」残留）');
    if (targets.length > MAX_KILL) throw new Error(`一次最多结束 ${MAX_KILL} 个进程`);
    return { targets };
  }
  if (action === 'set-parallel') {
    const out = {};
    for (const k of PARALLEL_KEYS) if (p[k] != null) { const n = Number(p[k]); if (!Number.isInteger(n)) throw new Error(k + ' 要是整数'); out[k] = n; }
    if (p.usePool != null) { if (typeof p.usePool !== 'boolean') throw new Error('usePool 要是 true / false'); out.usePool = p.usePool; }
    if (!Object.keys(out).length) throw new Error('要给出 memFloorPct / maxParallel / maxParallelIdle / usePool 里至少一项');
    if (p.restoreAfterHours != null) {
      const h = Number(p.restoreAfterHours);
      if (!Number.isFinite(h) || h < 0.25 || h > 24) throw new Error('restoreAfterHours 只能是 0.25–24 小时');
      out.restoreAfterHours = Math.round(h * 100) / 100;
    }
    return out;
  }
  if (action === 'pause-account' || action === 'resume-account') {
    const account = require('../codeagent-quota').normalizeAlias(p.account);
    if (!account) throw new Error('要给出号的代称（「个人」或「号 1」这样的写法）');
    const out = { account };
    if (action === 'pause-account' && p.hours != null) {
      const h = Number(p.hours);
      if (!Number.isFinite(h) || h < 0.25 || h > 72) throw new Error('hours 只能是 0.25–72 小时（不填 = 直到手动恢复）');
      out.hours = Math.round(h * 100) / 100;
    }
    if (action === 'pause-account' && p.reason != null) out.reason = String(p.reason).replace(/[\r\n\t<>]/g, ' ').trim().slice(0, 60);
    return out;
  }
  if (action === 'set-personal-model') {
    const restore = p.restore === true;
    if (p.restore != null && typeof p.restore !== 'boolean') throw new Error('restore 要是 true / false');
    if (p.force != null && typeof p.force !== 'boolean') throw new Error('force 要是 true / false');
    const model = p.model == null ? '' : String(p.model).trim();
    if (restore && model) throw new Error('model 和 restore 只能给一个：改成某个模型，或撤销上一次修改');
    if (restore && p.force === true) throw new Error('force 只用于改成某个模型，撤销不需要');
    if (!restore && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(model)) throw new Error('要给出模型名 model（必须在个人账号的权限清单里，如 GLM-5.2-WX-Auto），或 restore:true 撤销上一次修改');
    // force：跳过「清单经过探测 / 实际作答过」这一条权限校验（回报和审计里标「未经权限校验」）；其余校验照常
    return restore ? { restore: true } : { model, ...(p.force === true ? { force: true } : {}) };
  }  if (action === 'cancel-queued' || action === 'retry') {
    const thread = String(p.thread || '');
    if (!THREAD_ID.test(thread)) throw new Error('要给出问题编号（如 Q-1018-03）');
    return { thread };
  }
  return {};
}

class RemoteAct {
  constructor(admin) { this.admin = admin; }
  get bridge() { return this.admin.bridge; }
  get deps() { return this.admin.bridge.deps; }
  now() { return this.admin.now(); }
  memory() { try { return this.deps.memory ? this.deps.memory() : { total: os.totalmem(), free: os.freemem() }; } catch { return { total: 0, free: 0 }; } }
  memView(m = this.memory()) { return { freeMB: mb(m.free), freePct: m.total > 0 ? Math.round(m.free / m.total * 100) : null }; }
  sleep(ms) { return (this.deps.diagSys?.sleep || (x => new Promise(r => setTimeout(r, x))))(ms); }
  audit(line) { try { this.bridge.appendLog?.('company-act.log', line); } catch { /* 审计日志写不了不挡回报 */ } }

  // 返回 { phase:'act'|'refused', note, act:{ action, ok, ... } }；hub-admin.js 负责回报。
  async run(id, message) {
    const action = String(message.action || '');
    if (!ACTIONS.includes(action)) return this.refuse(id, action, `不认识的动作：${short(action, 30)}（只认 ${ACTIONS.join(' / ')}）`);
    if (this.bridge.settings().allowRemoteMaintain === false) return this.refuse(id, action, '这台电脑没允许对端远程维护（「AI特战队专用功能」设置的「远程维护」里可以打开）');
    let params;
    try { params = parseParams(action, message.params); } catch (error) { return this.refuse(id, action, error.message); }
    const st = this.admin.state(), last = (st.actLast || {})[action] || 0, now = this.now();
    const gap = MIN_INTERVAL_MS[action] || DEFAULT_INTERVAL_MS;
    if (this.running) return this.refuse(id, action, '上一个维护动作还在执行，这条没处理');
    if (now - last < gap && now >= last) return this.refuse(id, action, `「${LABEL[action]}」${gap / 1000} 秒内只做一次：上一次在 ${Math.round((now - last) / 1000)} 秒前`);
    this.running = true;
    this.admin.save({ actLast: { ...(st.actLast || {}), [action]: now } });
    // 改个人账号默认模型的提示在执行后给（带前后值）
    if (action !== 'set-personal-model') this.bridge.notify('对端执行了：' + LABEL[action], `编号 ${id}`, null, { quiet: true });
    try {
      const result = await this[{ 'suspend-idle': 'suspendIdle', 'kill-orphans': 'killOrphans', 'set-parallel': 'setParallel', 'cancel-queued': 'cancelQueued', retry: 'retry',
        'pause-account': 'pauseAccount', 'resume-account': 'resumeAccount', 'set-personal-model': 'setPersonalModel' }[action]](params, id);
      this.audit(`${result.ok ? 'done' : 'failed'} ${id} ${action} ${JSON.stringify(params)} → ${short(result.note, 300)}`);
      this.bridge.changed();
      return { phase: 'act', note: `${LABEL[action]}：${result.note}`, act: { action, ...result } };
    } catch (error) {
      this.audit(`failed ${id} ${action} ${JSON.stringify(params)} ${error.message}`);
      return { phase: 'act', note: `${LABEL[action]}没做成：${short(error.message, 200)}`, act: { action, ok: false, error: short(error.message, 200) } };
    } finally { this.running = false; }
  }
  refuse(id, action, why) {
    this.audit(`refused ${id} ${action || '?'} ${why}`);
    return { phase: 'refused', note: '远程维护：' + why, act: { action: action || null, ok: false, refused: true } };
  }

  // ---- suspend-idle ----
  async suspendIdle() {
    const b = this.bridge, d = this.deps;
    if (!d.suspendSession) throw new Error('这台 Hub 不能让会话休眠');
    const threads = b.threads(300);
    const pending = new Set(threads.filter(t => ['queued', 'running'].includes(t.state)).map(t => t.sessionId).filter(Boolean));
    const bySession = new Map();
    for (const t of threads) if (t.sessionId && !bySession.has(t.sessionId)) bySession.set(t.sessionId, t.id);
    const before = this.memView();
    const suspended = [], skipped = [];
    for (const [sessionId, thread] of bySession) {
      const s = d.getSession(sessionId);
      if (!s || s.status === 'dormant' || s.status === 'closed') continue;
      const tag = { session: String(sessionId).slice(0, 8), thread };
      // 只动通道会话：人自己开的会话即使接过通道问题（purpose 不是 company-bridge）也不动
      if (s.purpose !== 'company-bridge') { skipped.push({ ...tag, why: '不是通道会话' }); continue; }
      if (pending.has(sessionId)) { skipped.push({ ...tag, why: '还有排队或在途的问题' }); continue; }
      if (b.sessionBusy(sessionId)) { skipped.push({ ...tag, why: '正在干活' }); continue; }
      let r;
      try { r = d.suspendSession(sessionId, { reason: 'remote-suspend-idle', minIdleMs: 60000, excludePinned: true, excludeFocused: true, excludeMeeting: true }); }
      catch (error) { r = { ok: false, message: error.message }; }
      if (r && r.ok) suspended.push(tag); else skipped.push({ ...tag, why: short(r?.message || r?.error || '没能休眠', 80) });
    }
    if (suspended.length) await this.sleep(3000); // 等进程退出，内存才看得出变化
    const after = this.memView();
    b.careLog?.(`remote suspend-idle ${suspended.length} 个：${suspended.map(x => x.thread).join(',')}`);
    return { ok: true, suspended, skipped, before, after, freedMB: after.freeMB - before.freeMB,
      note: suspended.length ? `休眠了 ${suspended.length} 个空闲通道会话，可用内存 ${before.freeMB} → ${after.freeMB} MB` : `没有可以休眠的空闲通道会话${skipped.length ? `（跳过 ${skipped.length} 个）` : ''}` };
  }

  // ---- kill-orphans ----
  async killOrphans({ targets }) {
    const D = require('./diag');
    const st = this.admin.state(), seen = st.lastDiagKillable;
    if (!seen || !Array.isArray(seen.list) || this.now() - seen.at > DIAG_FRESH_MS || this.now() < seen.at) {
      throw new Error('5 分钟内没有带进程段的直查：先 company_diag（含 processes），再按里面列为「可结束」的 PID 和启动时间来结束');
    }
    const listed = new Map(seen.list.map(x => [x.pid, x]));
    const sys = { ...D.defaultSys(), ...(this.deps.diagSys || {}) };
    // 隔 1.5 秒采两次，才量得出每个进程最近用了多少 CPU（还在干活的不结束）
    const snap = await (sys.sampleProcesses ? sys.sampleProcesses(1500) : sys.processSnapshot());
    const fresh = D.analyzeProcesses(snap, { ...D.analyzeOptions(this.bridge, sys) });
    // 重新枚举里连当前 Hub 主进程都找不到：进程表不可信，一个都不结束（fail-closed，2026-10-18 审核）
    if (!fresh.hubFound) throw new Error('重新枚举进程时没找到当前 Hub 主进程，进程表不可信，这次一个都不结束');
    const byPid = new Map((snap.processes || []).map(p => [p.pid, p]));
    const killableNow = new Map(fresh.leftovers.filter(x => x.killable).map(x => [x.pid, x]));
    const alive = this.deps.processAlive || (pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } });
    const before = this.memView();
    const results = [];
    const started = this.now(), budget = Number.isFinite(Number(this.deps.killBudgetMs)) ? Number(this.deps.killBudgetMs) : KILL_BUDGET_MS;
    for (const t of targets) {
      const one = { pid: t.pid, startedAt: t.startedAt };
      if (this.now() - started >= budget) { results.push({ ...one, ok: false, why: `本次结束已到 ${Math.round(budget / 1000)} 秒上限，剩下的没处理，可以再执行一次` }); continue; }
      const prev = listed.get(t.pid), cur = byPid.get(t.pid);
      if (!prev || prev.startedAt !== t.startedAt) { results.push({ ...one, ok: false, why: '和最近一次直查的「可结束」清单对不上（PID 或启动时间不一致）' }); continue; }
      if (!cur) { results.push({ ...one, ok: true, already: true, why: '已经不在了' }); continue; }
      if (cur.startedAt !== t.startedAt) { results.push({ ...one, ok: false, why: '这个 PID 现在是另一个进程（启动时间变了），不动' }); continue; }
      // 硬保护：当前 Hub、别的 Hub 的整棵进程树、Hub 后台脚本、本进程，一律不动
      if (fresh.protectedPids.has(t.pid) || t.pid === process.pid || t.pid === Number(this.deps.hubPid)) { results.push({ ...one, ok: false, why: '属于正在运行的 Hub，不动' }); continue; }
      const now = killableNow.get(t.pid);
      if (!now) {
        const lo = fresh.leftovers.find(x => x.pid === t.pid);
        const why = lo && lo.windowed ? '开着窗口，不动' : lo && lo.cpu && lo.cpu.known && !lo.cpu.idle ? `最近还在用 CPU（${lo.cpu.pct}%），不动` : '重新判定后不再是「可结束」（父进程回来了或不再像残留）';
        results.push({ ...one, ok: false, why }); continue;
      }
      if (!now.cpu || !now.cpu.known || !now.cpu.idle) { results.push({ ...one, ok: false, why: now.cpu && now.cpu.known ? `最近还在用 CPU（${now.cpu.pct}%），不动` : '量不到它最近的 CPU 占用，不动' }); continue; }
      try { (this.deps.killProcess || (pid => process.kill(pid)))(t.pid); }
      catch (error) { results.push({ ...one, ok: false, why: '结束失败：' + short(error.message, 80) }); continue; }
      // 发出结束请求后最多等 5 秒，确认它真的退出了
      let gone = false;
      for (let i = 0; i < 10 && !gone; i += 1) { if (!alive(t.pid)) gone = true; else await this.sleep(500); }
      results.push({ ...one, ok: true, confirmed: gone, name: cur.name, memMB: mb(cur.wsBytes), ...(gone ? {} : { why: '已发出结束请求，5 秒内没确认退出' }) });
    }
    const killed = results.filter(x => x.ok && !x.already);
    const confirmed = killed.filter(x => x.confirmed);
    if (killed.length) await this.sleep(1000);
    const after = this.memView();
    this.admin.save({ lastDiagKillable: { ...seen, list: seen.list.filter(x => !killed.some(k => k.pid === x.pid)) } });
    return { ok: killed.length > 0 || results.every(x => x.ok), results, before, after, freedMB: after.freeMB - before.freeMB,
      note: `结束了 ${confirmed.length} 个${killed.length > confirmed.length ? `，${killed.length - confirmed.length} 个已发出结束请求、未确认` : ''}，${results.length - killed.length} 个没动；可用内存 ${before.freeMB} → ${after.freeMB} MB` };
  }

  // ---- set-parallel ----
  async setParallel(p) {
    const b = this.bridge, s = b.settings();
    const values = {}, prev = {};
    for (const k of [...PARALLEL_KEYS, 'usePool']) if (k in p) { values[k] = p[k]; prev[k] = s[k]; }
    const before = b.parallelLimitSafe();
    b.setSettings(values); // 超出上下限会抛错，原样回报
    const after = b.parallelLimitSafe();
    const st = this.admin.state(), old = st.parallelRestore || null;
    // actHourMs：只有隔离测试实例能把「1 小时」缩短（main.js 按 CLAUDE_HUB_DATA_DIR 判断），平时就是 1 小时
    const hourMs = Number(this.deps.actHourMs) > 0 ? Number(this.deps.actHourMs) : 3600000;
    // 待恢复计划（2026-10-18 审核）：values = 最初的原值（连调几次都恢复到第一次之前），applied = 远程最后设下的值（恢复时只动仍等于它的键）。
    // 已有计划时：这次没带恢复时间就沿用原计划的时间，这次改的键也并入计划；没有计划、这次也没带恢复时间就不恢复。
    let restore = null;
    if (p.restoreAfterHours || old) {
      restore = { at: p.restoreAfterHours ? this.now() + p.restoreAfterHours * hourMs : old.at,
        values: { ...prev, ...(old?.values || {}) }, applied: { ...(old?.applied || {}), ...values } };
    }
    this.admin.save({ parallelRestore: restore });
    const desc = Object.entries(values).map(([k, v]) => `${k} ${prev[k]} → ${v}`).join('，');
    return { ok: true, values, previous: prev, before, after, restoreAt: restore ? restore.at : null,
      note: `${desc}；现在最多同时 ${after ? after.cap : '?'} 个（受${after ? after.limitedBy : '?'}限制）${!restore ? '；不自动恢复' : p.restoreAfterHours ? `；${p.restoreAfterHours} 小时后恢复原值` : '；沿用之前的恢复时间，到时恢复到最初的原值'}` };
  }
  // 由通道定时器调用：到点恢复原值并告诉对端。
  async restoreDue() {
    const plan = this.admin.state().parallelRestore;
    if (!plan || this.now() < plan.at) return null;
    this.admin.save({ parallelRestore: null });
    try {
      // 只恢复「现在仍是远程设下的值」的键：这期间在公司设置页手动改过的，以人改的为准，不覆盖（2026-10-18 审核）
      const cur = this.bridge.settings(), applied = plan.applied || {}, back = {}, kept = {};
      for (const [k, v] of Object.entries(plan.values || {})) {
        if (!(k in applied) || cur[k] === applied[k]) back[k] = v; else kept[k] = cur[k];
      }
      if (Object.keys(back).length) this.bridge.setSettings(back);
      if (Object.keys(kept).length) this.audit('restore-skip ' + JSON.stringify(kept) + ' 期间在设置页改过，不恢复');
      const note = (Object.keys(back).length ? '临时调整的并行档位已到时恢复：' + Object.entries(back).map(([k, v]) => `${k} = ${v}`).join('，') : '临时调整的并行档位到时了')
        + (Object.keys(kept).length ? `；${Object.keys(kept).join('、')} 期间在公司设置页改过，保留现值` : '');
      this.audit('restored ' + JSON.stringify(back));
      this.bridge.notify('并行档位已恢复', note, null, { quiet: true });
      await this.admin.report(null, 'act', note, { act: { action: 'set-parallel', ok: true, restored: back, kept } });
      return back;
    } catch (error) { this.audit('restore-failed ' + error.message); return null; }
  }

  // ---- cancel-queued / retry ----
  async cancelQueued({ thread }) {
    const b = this.bridge, t = b.thread(thread);
    if (!t || t.gen !== b.link.gen()) throw new Error('找不到这个问题，或它属于上一次配对');
    if (t.state !== 'queued') throw new Error(`这个问题现在是「${t.state}」，只能取消还在排队的`);
    const r = t.rounds.find(x => !x.reply && !x.error && !x.sentAt);
    if (!r) throw new Error('这个问题没有排队中的轮次');
    // 只取消排队的这一轮（2026-10-18 审核）：第 1 轮就在排队（还没开过会话）才把整个问题作废；
    // 追问的轮次只给该轮落 error，线程状态照 deriveState 推导，之后还能接着追问，答完的会话照常按保温规则休眠。
    const whole = r.round === 1 && !t.sessionId;
    const why = whole ? '被对端取消（还在排队，没有开会话作答）' : `第 ${r.round} 轮被对端取消（还在排队，没有发给 CodeAgent）`;
    const rounds = t.rounds.map(x => x.round === r.round ? { ...x, error: why, failedAt: this.now(), cancelledBy: 'peer' } : x);
    b.saveThread(whole ? { ...t, state: 'cancelled', cancelNote: why, rounds } : { ...t, state: undefined, rounds });
    void b.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'error', note: why }).catch(() => {});
    return { ok: true, thread: t.id, round: r.round, whole, note: `${t.id} 第 ${r.round} 轮已取消${whole ? '（整个问题作废）' : '（之后还能追问）'}` };
  }
  // ---- pause-account / resume-account（额度感知，2026-10-18）----
  accountFor(alias) {
    const b = this.bridge, key = b.accountKey(alias);
    if (!key) throw new Error(`这台电脑上没有「${alias}」这个号`);
    return key;
  }
  avoidLabel(key) { const Q = require('../codeagent-quota'); const e = this.bridge.avoidMap()[key]; return e ? Q.describeAvoid(e) : '可用'; }
  async pauseAccount({ account, hours, reason }) {
    const Q = require('../codeagent-quota'), b = this.bridge, key = this.accountFor(account);
    const before = this.avoidLabel(key);
    const hourMs = Number(this.deps.actHourMs) > 0 ? Number(this.deps.actHourMs) : 3600000;
    const until = hours ? this.now() + hours * hourMs : null;
    Q.markAvoid(b.deps.dataDir, key, { source: 'manual', kind: 'quota', reason: reason ? '对端暂停：' + reason : '对端暂停', until }, this.now());
    b.avoidChanged?.({});
    const after = this.avoidLabel(key);
    return { ok: true, account, before, after, until, note: `${account}：${before} → ${after}；通道新开会话和换号重做都不再挑它` };
  }
  async resumeAccount({ account }) {
    const Q = require('../codeagent-quota'), b = this.bridge, key = this.accountFor(account);
    const before = this.avoidLabel(key);
    const r = Q.clearAvoid(b.deps.dataDir, key, { by: 'peer' }, this.now());
    b.avoidChanged?.({}); // 排队等它恢复的问题下一轮（5 秒内）就派
    return { ok: true, account, before, after: '可用', cleared: r.cleared, note: r.cleared ? `${account}：${before} → 可用，照常派活` : `${account} 本来就没在避让中` };
  }
  // ---- set-personal-model（2026-10-19 用户授权）----
  // 回给对端的只有固定文案 + code，路径、JSON 片段等原始信息只写本机审计日志（审核 2026-10-19）。
  async setPersonalModel({ model = '', restore = false, force = false }, id = '') {
    const b = this.bridge, Q = require('../codeagent-quota');
    const personalDir = this.deps.personalConfigDir ? this.deps.personalConfigDir() : require('../codeagent-config').resolveCodeAgentConfig(process.env).configDir;
    let answered = [];
    try { answered = (b.personalAnsweredModels?.() || []).map(x => x.model); } catch { answered = []; }
    let r;
    try { r = require('../codeagent-personal-model').setPersonalModel({ dataDir: b.deps.dataDir, personalDir, model, restore, force, answered, now: this.now() }); }
    catch (error) {
      const code = error.code || 'unexpected';
      this.audit(`detail ${id} set-personal-model ${code} ${short(error.detail || error.message, 400)}`);
      const text = error.code ? error.message : '修改个人账号默认模型时出错，没改';
      b.notify('对端修改个人账号默认模型没有成功', `${text}（${code}）`, null, { quiet: true });
      throw Object.assign(new Error(`${text}（${code}）`), { code });
    }
    const show = v => v || '（未设置）';
    const scope = '只影响之后新开的会话，已在跑的会话不动';
    const unverified = r.verifiedBy === 'force' ? '（未经权限校验）' : '';
    if (unverified) this.audit(`unverified-force ${id} set-personal-model ${show(r.before)} → ${r.ok ? show(r.after) : '（没改成）'} 权限清单未经探测、也没有作答记录，按 force 写入`);
    if (!r.ok) {
      this.audit(`detail ${id} set-personal-model ${r.code} ${short(r.detail, 400)}`);
      b.notify('对端修改个人账号默认模型没有成功', `${r.error}（${r.code}）`, null, { quiet: true });
      return { ok: false, code: r.code, before: r.before, after: r.after, backup: r.backup, rolledBack: !!r.rolledBack, error: `${r.error}（${r.code}）`, note: `没改成：${r.error}（${r.code}）` };
    }
    if (!r.changed) return { ok: true, changed: false, before: r.before, after: r.after, verifiedBy: r.verifiedBy, note: `个人账号默认模型本来就是 ${show(r.after)}，没改` };
    // 改成某个模型成功：解除个人账号的模型配置避让，新问题可以重新派给它。撤销（restore）不清：回到的值若有避让记录就保留（审核 2026-10-19）
    let cleared = 0;
    if (!restore) { try { cleared = Q.clearModelAvoid(b.deps.dataDir, 'personal'); } catch { cleared = 0; } }
    b.avoidChanged?.({});
    b.notify('对端修改了个人账号默认模型：' + show(r.before) + ' → ' + show(r.after) + unverified, scope, null, { quiet: true });
    const proof = { probe: '权限清单经过探测', enterprise: '权限清单是 CodeAgent 自己的账号模型清单', answered: '个人账号实际作答过这个模型', force: '未经权限校验（按 force 写入）', backup: '撤销到上一次修改前的值' }[r.verifiedBy] || '';
    return { ok: true, changed: true, before: r.before, after: r.after, backup: r.backup, restoredFrom: r.restoredFrom || null, clearedAvoid: cleared, scope, verifiedBy: r.verifiedBy, ...(unverified ? { unverified: true } : {}),
      note: `个人账号默认模型 ${show(r.before)} → ${show(r.after)}${unverified}${restore ? `（撤销上一次修改，用的是备份 ${r.restoredFrom}）` : ''}；依据：${proof}；改前已备份为 ${r.backup}；${scope}${cleared ? '；已解除个人账号的模型配置避让，新问题可以派给它' : ''}` };
  }  async retry({ thread }) {
    const b = this.bridge, t = b.thread(thread);
    if (!t || t.gen !== b.link.gen()) throw new Error('找不到这个问题，或它属于上一次配对');
    const failed = t.rounds.filter(x => x.error && !x.reply);
    if (!failed.length) throw new Error('这个问题没有失败的轮次');
    b.retry(thread);
    return { ok: true, thread: t.id, rounds: failed.map(x => x.round), note: `${t.id} 第 ${failed.map(x => x.round).join('、')} 轮重新排队` };
  }
}

module.exports = { RemoteAct, ACTIONS, LABEL, parseParams, DIAG_FRESH_MS, MAX_KILL };
