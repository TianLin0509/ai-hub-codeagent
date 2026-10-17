'use strict';
// 家里远程让公司 Hub 自己更新 / 重启（2026-10-17 用户：「不用为了更新 AI HUB 专门到公司一趟」）。
// 公司一端：收家里经加密通道发来的 hub-admin 指令，用这台 Hub 现有的一键更新流程（main/app-update-controller.js：
// 查版本 → 多源下载 → 校验 → 暂存 → 替换脚本 → 重启，失败自动回滚）完成，进度和结果用 hub-admin-status 报回家里。
//
//   家里 → 公司：{ type:'hub-admin', op:'update'|'restart'|'status', id, gen, force? }
//   公司 → 家里：{ type:'hub-admin-status', id, phase, note, current, latest, at, lastResult? }
//
// 底线：只处理当前配对代次的指令；同一时间只跑一条；只更新到发行源上的正式版本（清单校验 + sha256 由控制器保证，
// 通道里不接受任何文件或网址）；不降级（planUpdate 保证）。重启前等安全时机：通道里没有正在作答的轮次、
// 也没有在干活的 CodeAgent 会话，最长等 30 分钟（force 不等）；等的期间新任务先排队，重启后接着做。
// 指令状态存在通道数据库里：重启后读替换脚本留下的结果（takeLastResult），通道接通时报回家里。
const WAIT_MAX_MS = 30 * 60000;
const HISTORY = 20;
const OPS = ['update', 'restart', 'status'];
// 执行中的阶段；其余都是结束态。
const LIVE = ['checking', 'downloading', 'waiting', 'applying', 'restarting'];

class HubAdmin {
  constructor({ bridge, deps }) {
    this.bridge = bridge; this.deps = deps; this.runner = null;
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

  // 报回家里：带上当前版本与发行源上的最新版本。
  report(id, phase, note, extra = {}) {
    const payload = { id: id || null, gen: this.bridge.link.gen(), phase, note, current: this.current(), latest: this.latest(), at: this.now(), ...extra };
    const history = [{ ...payload }, ...(this.state().history || [])].slice(0, HISTORY);
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
  // 等待安全重启期间暂不派发新任务（advance 读它），排队的任务重启后接着做。
  holdingDispatch() { const j = this.job(); return !!j && j.phase === 'waiting'; }

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
    if (this.bridge.settings().allowRemoteAdmin === false) { void this.report(id, 'refused', '公司端没允许远程更新（公司 Hub「AI特战队专用功能」设置里可以打开）'); return true; }
    const running = this.job();
    if (running && LIVE.includes(running.phase)) { void this.report(id, 'busy', `上一条远程指令（${running.id}）还在执行，这条没处理；等它结束再发`); return true; }
    if (message.op === 'update' && !this.controller()) { void this.report(id, 'unsupported', '这台 Hub 不是安装版，不能远程更新'); return true; }
    if (message.op === 'restart' && !this.deps.relaunch) { void this.report(id, 'unsupported', '这台 Hub 不能远程重启'); return true; }
    const job = this.setJob({ id, op: message.op, force: message.force === true, phase: message.op === 'update' ? 'checking' : 'waiting', receivedAt: this.now() });
    this.bridge.notify(message.op === 'update' ? '家里让这台 Hub 更新' : '家里让这台 Hub 重启', '编号 ' + id);
    if (message.op === 'update') this.runner = this.runUpdate(job).catch(error => this.finish(this.job() || job, 'failed', '更新失败：' + error.message)).finally(() => { this.runner = null; });
    else { void this.report(id, 'accepted', job.force ? '收到重启指令，马上重启' : '收到重启指令，等手上的任务答完再重启'); void this.advance(); }
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
    parts.push(this.bridge.settings().allowRemoteAdmin === false ? '远程更新：未允许' : '远程更新：已允许');
    return parts.join(' · ');
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
    this.setJob({ ...this.job(), phase: 'waiting', target, waitSince: this.now() });
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

  // 正在干活的：通道里在作答的轮次 + 在忙的 CodeAgent 会话（人自己开的也算）。
  workingCount() {
    const b = this.bridge;
    const threads = b.openThreads().filter(t => t.state === 'running' && b.roundWorking(t));
    const ids = new Set(threads.map(t => t.sessionId).filter(Boolean));
    let extra = 0;
    for (const id of (this.deps.listSessionIds?.() || [])) {
      if (ids.has(id)) continue;
      const s = this.deps.getSession?.(id);
      if (s && String(s.kind || '').replace(/-resume$/, '') === 'codeagent' && b.sessionBusy(id)) extra += 1;
    }
    return threads.length + extra;
  }
  // 由通道定时器调用：等待阶段看能不能重启了。
  async advance() {
    const job = this.job();
    if (!job || job.phase !== 'waiting' || this.applying) return;
    const working = job.force ? 0 : this.workingCount();
    const waited = this.now() - (job.waitSince || job.receivedAt || this.now());
    const verb = job.op === 'update' ? `重启到 v${job.target}` : '重启';
    if (working > 0 && waited < WAIT_MAX_MS) {
      if (job.waitingFor !== working) {
        this.setJob({ ...job, waitSince: job.waitSince || this.now(), waitingFor: working });
        const what = job.op === 'update' ? `已下载 v${job.target}，` : '';
        await this.report(job.id, 'waiting', `${what}等 ${working} 个任务答完后${verb}（最长等 30 分钟；期间新任务先排队）`);
      }
      return;
    }
    const note = working > 0 ? `等了 30 分钟仍有 ${working} 个任务在跑，照常${verb}（任务记录都保留，重启后接着处理）` : `即将${verb}`;
    return this.restartNow(job, note);
  }
  async restartNow(job, note) {
    this.applying = true;
    try {
      this.setJob({ ...job, phase: job.op === 'update' ? 'applying' : 'restarting', note, restartAt: this.now(), from: this.current() });
      await this.report(job.id, 'restarting', note);
      // 等这条消息真的送出去再退出；送不出去也照常重启（发件箱持久，重启后补发）。
      await this.bridge.link.flush().catch(() => {});
      if (job.op === 'update') this.controller().apply();
      else this.deps.relaunch();
    } catch (error) {
      this.applying = false;
      return this.finish(this.job() || job, 'failed', (job.op === 'update' ? '没能开始替换：' : '没能重启：') + error.message);
    }
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
  status() { const s = this.state(); return { job: s.job || null, history: (s.history || []).slice(0, 5), current: this.current(), installed: !!this.controller() }; }
}

module.exports = { HubAdmin, WAIT_MAX_MS, OPS };
