'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const component = require('./room-component');
const { createRuntimeDownload } = require('./room-runtime-download');

const RULES = ['主题', '开始时间', '时长小时', '时长分钟', '优先会议室', '抢订日'];
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('会议室文件读取失败：' + path.basename(file) + '（' + error.message + '）'); }
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
// 「10-27（周一）14:00–16:00 · 会议室」：由记录里的日期、开始时间与时长计算；字段不全就原样显示。
const WEEK = '日一二三四五六';
function slotText(r = {}) {
  const room = r['会议室'] || '未选定', raw = `${r['日期'] || ''} ${r['时间'] || ''}`.trim();
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(r['日期'] || '').trim());
  const t = /^(\d{1,2}):(\d{2})\s*起\s*(\d+)h(\d+)m$/.exec(String(r['时间'] || '').trim());
  if (!d || !t) return `${raw} · ${room}`;
  const day = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
  const start = Number(t[1]) * 60 + Number(t[2]), end = start + Number(t[3]) * 60 + Number(t[4]);
  if (day.getMonth() !== Number(d[2]) - 1 || Number(t[2]) > 59 || end <= start || end > 24 * 60) return `${raw} · ${room}`;
  const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${d[2]}-${d[3]}（周${WEEK[day.getDay()]}）${hm(start)}–${hm(end)} · ${room}`;
}
class RoomBooking {
  constructor(a, deps = {}) {
    this.a = a; this.deps = deps; this.timer = null; this.starting = null; this.ticking = false;
    this.error = ''; this.preparationError = ''; this.lastStart = 0; this.child = null; this.runtime = null;
  }
  saved() { const exe = this.settings().exePath; return !!(exe && fs.existsSync(exe)); }
  // 会议室运行时（77MB 的秘书终结者）第一次用时才下载：这里只做一次性的准备，不联网。
  runtimeDownloader() {
    if (this.deps.roomCommand) return null;
    if (this.runtime && this.runtime.bundle === this.deps.roomBundle) return this.runtime.downloader;
    let downloader = null, error = '';
    try {
      const { baseline } = component.bundledRuntime(this.deps.roomBundle);
      // 'roomDownloader' in deps：测试要能明确说「这台机器不联网」，传 null 就别再建下载器。
      downloader = 'roomDownloader' in this.deps ? this.deps.roomDownloader
        : createRuntimeDownload({ dataDir: this.a.dir, baseline, sources: this.deps.roomRuntimeSources,
          fetchImpl: this.deps.roomFetch,
          // 下载器每 250ms 报一次进度，不能每次都把整页重画（下面还有 3 秒轮询）：1 秒最多推一次；
          // 结束态（成功/失败/取消）立即推，让界面马上换按钮。
          onState: state => {
            const now = Date.now();
            if (state.phase === 'downloading' && now - (this.runtime?.pushedAt || 0) < 1000) return;
            if (this.runtime) this.runtime.pushedAt = now;
            this.a.changed();
          } });
    } catch (e) { error = e.message; }
    this.runtime = { bundle: this.deps.roomBundle, downloader, error, pushedAt: 0 };
    return downloader;
  }
  runtimeState() {
    const dl = this.runtimeDownloader(), status = dl ? dl.status() : null;
    let info = { cached: false, bundled: false, bytes: null, sha256: null, error: '' };
    try {
      const now = component.runtimeInfo(this.a, { bundle: this.deps.roomBundle });
      info = { cached: now.cached, bundled: now.bundled, bytes: now.bytes, sha256: now.sha256, error: '' };
    } catch (error) { info = { ...info, error: error.message }; }
    return { ...info, ...(status || {}), installed: info.cached || info.bundled || !!(status && status.installed),
      phase: status ? status.phase : 'unavailable', error: (status && status.error) || info.error || this.runtime?.error || '' };
  }
  settings() { return this.a.settings().rooms || {}; }
  home() { return this.deps.roomHome || this.settings().home || path.join(this.a.dir, 'meeting-room'); }
  file(...parts) { return path.join(this.home(), ...parts); }
  helper() { return this.home() ? readJson(this.file('hub-control', 'status.json'), null) : null; }
  status() {
    let helper;
    try { helper = this.helper(); } catch (e) { this.error = e.message; }
    const live = !this.blockedExternal && helper?.protocol === 1 && (!helper.pid || processAlive(helper.pid))
      && this.a.now() - helper.at < 30000 && helper.at <= this.a.now() + 5000;
    const runtime = this.runtimeState();
    return { available: !!this.deps.roomCommand || runtime.installed, download: runtime, embedded: true, preparing: !!this.starting,
      connected: !!live, running: !!(live && helper.running), mode: live ? helper.mode : null,
      loginNeeded: !!helper?.loginNeeded, loginBusy: !!(live && helper.loginBusy),
      rules: helper?.rules || null, phases: live ? helper.phases : {}, nextOpen: helper?.nextOpen,
      error: this.preparationError || this.error, home: this.home(), enabled: !!this.settings().enabled,
      targetOffsetDays: 7, events: (this.a.state().roomEvents || []).map(e => ({ ...e, slot: slotText(e.record) })) };
  }
  start() {
    if (this.deps.noTimer) return;
    this.timer = setInterval(() => { void this.tick().catch(e => { this.error = e.message; this.a.changed(); }); }, 15000);
  }
  close() { clearInterval(this.timer); this.timer = null; }
  async discover() { return this.status(); }
  async install() { return this.ensure({ user: true }); }
  useExecutable(exePath) {
    if (!/\.exe$/i.test(exePath) || !fs.existsSync(exePath)) throw new Error('请选择已安装的秘书终结者 exe');
    this.a.setSettings({ rooms: { exePath, home: path.dirname(exePath), enabled: false } });
    this.error = ''; return this.status();
  }
  baselineHistory() {
    if (this.a.state().roomSeen !== undefined || !this.home()) return;
    const history = readJson(this.file('booking_history.json'), []);
    if (!Array.isArray(history)) throw new Error('秘书历史格式不正确，未启动抢订');
    this.a.saveState({ roomSeen: history.map(r => createHash('sha256').update(JSON.stringify(r)).digest('hex')) });
  }
  // Preparing the embedded control component does not start a booking. Only the
  // explicit start command (or an already enabled schedule) may enter daemon mode.
  async ensure({ user = false } = {}) {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const runtime = this.deps.roomCommand ? null
        : await component.prepareRuntime(this.a, { bundle: this.deps.roomBundle, downloader: this.runtimeDownloader() });
      const command = this.deps.roomCommand || [runtime.exe];
      if (!command[0] || !fs.existsSync(command[0])) throw new Error('会议室组件不可用，请修复 Hub 安装包');
      if (!this.deps.roomCommand) {
        const foreign = await component.foreignInstances(runtime.exe, { listProcesses: this.deps.roomProcesses });
        this.blockedExternal = foreign.length > 0;
        if (this.blockedExternal) throw new Error('旧秘书终结者正在运行，请先在它的托盘退出，再回到 Hub；当前未启动第二份抢订');
      }
      if (this.status().connected) { this.baselineHistory(); this.error = ''; this.preparationError = ''; return { ...this.status(), preparing: false }; }
      component.initializeHome(this.home());
      if (runtime) {
        await component.stage(this.a, runtime.exe, this.home(), { baseline: runtime.baseline, bundle: this.deps.roomBundle });
        this.a.setSettings({ rooms: { exePath: runtime.exe, home: this.home(), enabled: !!this.settings().enabled } });
      }
      this.baselineHistory();
      const child = (this.deps.roomSpawn || spawn)(command[0], [...command.slice(1), '--hub-control'], {
        cwd: path.dirname(command[0]), windowsHide: true,
        env: { ...process.env, ...(this.deps.roomEnv || {}), MSZ_HOME: this.home(), MSZ_NO_TRAY: '1', QT_QPA_PLATFORM: 'offscreen' }, stdio: 'ignore',
      });
      this.child = child;
      let failed = null, exited = false;
      child.on('error', e => { failed = e; });
      child.on('exit', () => { exited = true; });
      child.unref?.();
      const end = Date.now() + (this.deps.roomReadyTimeoutMs || 120000);
      while (Date.now() < end) {
        if (failed) throw failed;
        if (this.status().connected) { this.error = ''; this.preparationError = ''; return { ...this.status(), preparing: false }; }
        if (exited) throw new Error('会议室组件未接通。若旧秘书终结者正在运行，请先退出旧实例；当前未启动第二份抢订');
        await new Promise(r => setTimeout(r, 250));
      }
      await (this.deps.roomKill || component.killTree)(child);
      throw new Error('会议室组件准备超时，本次后台进程已关闭；请稍后重试');
    })().catch(error => { this.preparationError = error.message; throw error; }).finally(() => { this.starting = null; this.a.changed(); });
    this.a.changed();
    return this.starting;
  }
  async command(op, args = {}, { user = false } = {}) {
    if (!['status', 'configure', 'start', 'pause', 'login', 'show', 'test'].includes(op)) throw new Error('不支持的会议室操作');
    if (op === 'configure' && Object.keys(args).some(k => !RULES.includes(k))) throw new Error('此版本按每周规则抢七天后的会议室，不支持指定明天；请提供主题、时段、会议室和星期');
    if (op === 'status') return this.status();
    await this.ensure({ user });
    const id = randomUUID(), req = this.file('hub-control', 'requests', id + '.json'), reply = this.file('hub-control', 'replies', id + '.json');
    fs.mkdirSync(path.dirname(req), { recursive: true });
    const tmp = req + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ id, op, args, at: this.a.now() }), 'utf8'); fs.renameSync(tmp, req);
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const result = readJson(reply, null);
      if (result) {
        if (result.requestId !== id) throw new Error('秘书回执编号不一致');
        if (!result.ok) throw new Error(result.error || '秘书未执行这项操作');
        if (op === 'start' || op === 'pause') this.a.setSettings({ rooms: { enabled: op === 'start' } });
        this.error = ''; this.a.changed(); return { ...this.status(), ...result, connected: true };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('秘书尚未回报结果，请查看当前状态；没有自动重复执行');
  }
  async tick() {
    if (this.ticking || !this.home()) return;
    this.ticking = true;
    try {
      const now = this.a.now(), d = new Date(now), minute = d.getHours() * 60 + d.getMinutes();
      const live = this.status();
      if (this.settings().enabled && live.connected && !live.running) this.a.setSettings({ rooms: { enabled: false } });
      if (this.settings().enabled && minute >= 690 && minute < 720 && !live.connected && now - this.lastStart >= 10 * 60000) {
        this.lastStart = now; await this.command('start');
      }
      const history = readJson(this.file('booking_history.json'), []);
      if (!Array.isArray(history)) throw new Error('秘书历史格式不正确，已保留之前的结果');
      const idOf = r => createHash('sha256').update(JSON.stringify(r)).digest('hex');
      const stored = this.a.state(), prior = stored.roomSeen;
      const ids = history.map(idOf), seen = new Set(prior || ids);
      let events = stored.roomEvents || [];
      if (prior) for (const record of history) {
        const id = idOf(record);
        if (seen.has(id)) continue;
        seen.add(id);
        events = [{ id, at: now, record, phoneSent: false }, ...events].slice(0, 30);
      }
      this.a.saveState({ roomSeen: [...new Set([...(prior || []), ...ids])].slice(-200), roomEvents: events });
      for (const event of events.filter(e => !e.phoneSent).slice(0, 3)) {
        if (!this.a.phone?.active()) break;
        const r = event.record;
        const text = `会议室${r['状态'] || '结果'}：${slotText(r)}${r['备注'] ? '\n' + r['备注'] : ''}`;
        if (await this.a.phone.send(text, 'room')) {
          const latest = this.a.state().roomEvents || [];
          this.a.saveState({ roomEvents: latest.map(e => e.id === event.id ? { ...e, phoneSent: true } : e) });
        } else break;
      }
      this.error = ''; this.a.changed();
    } finally { this.ticking = false; }
  }
}
module.exports = { RoomBooking, RULES, readJson, slotText };
