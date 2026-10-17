'use strict';
// 助理桌宠的窗口与行为（主进程）。设计：docs/design/hub-pet.md。
// 一个透明、无边框、置顶、不进任务栏的小窗，Hub 开着时出现；动画全在渲染端（renderer/hub-pet/pet.js），
// 这里负责：窗口位置（拖动、惯性、贴边、躲边、记住位置）、姿态判断、气泡排队、右键菜单、打开助理页。
const fs = require('fs');
const path = require('path');
const { ASSISTANT_ACTIONS, MODES, ROLES, SpeechQueue, chatterFor, decidePose, localDateKey, speakGate } = require('../core/hub-pet/state');
const { allowedRange, clampTo, cubicOut, dockOf, releasePlan } = require('../core/hub-pet/motion');
const { createSettingsStore } = require('../core/hub-pet/settings');
const { createFullscreenWatch } = require('../core/hub-pet/fullscreen-watch');

const WIN_W = 280;
const WIN_H = 340;
const BODY = 150;                        // 宠物身体的显示尺寸（DIP），在窗口底部居中
const INSET = { left: (WIN_W - BODY) / 2, right: (WIN_W - BODY) / 2, top: 0, bottom: 6 };
const MARGIN = 24;
const PEEK_VISIBLE = 0.42;               // 躲边时露出身体的比例
const POLL_MS = 4000;                    // 看助理忙不忙、有没有离开电脑
const DRAG_TICK_MS = 16;
const CLICK_SLOP = 4;
const MODE_LABELS = { lively: '活泼', gentle: '温和', quiet: '安静' };

const MODE_SET = new Set(MODES);

function createHubPetController({
  BrowserWindow, screen, ipcMain, Menu, powerMonitor, app,
  htmlPath, preloadPath, assetsDir, dataDir,
  company = false, available = true,
  getMainWindow, focusPrimaryWindow, sendToRenderer,
  noticeBus, isAssistantBusy = () => false,
  canShow = () => true, debug = false, watchFullscreen = true,
  logger = console, now = () => Date.now(),
} = {}) {
  // now 是「现在几点」（可在单测里固定）；窗口移动的动画计时一律用真实时钟 Date.now()。
  if (typeof BrowserWindow !== 'function') throw new Error('BrowserWindow is required');
  const settings = createSettingsStore({ dataDir, company, logger });
  const speech = new SpeechQueue({ now });
  const chatterTrack = {};
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'manifest.json'), 'utf8')); } catch (error) { logger.warn?.('[hub-pet] manifest missing:', error.message); }

  let win = null;
  let started = false;
  let disposed = false;
  let pollTimer = null;
  let deadlineTimer = null;
  let moveTimer = null;
  let drag = null;
  let lastSent = '';
  let pose = 'idle';
  let fullscreen = false;
  let peekFrom = null;           // 躲边前的位置，全屏结束后回去
  let dock = null;
  let pettedAt = 0;
  let lastRelease = null;       // 最近一次松手的速度与计划（隔离测试读）
  let signals = { quotaLow: false };
  const overrides = {};          // 隔离测试注入（idleSec / busy / fullscreen / cursor）

  const fsWatch = createFullscreenWatch({ logger, onChange: (value) => { if (overrides.fullscreen == null) setFullscreen(value); } });

  const enabled = () => available && !disposed && settings.get().enabled;
  const alive = () => !!(win && !win.isDestroyed());
  const send = (channel, payload) => { if (alive()) win.webContents.send(channel, payload); };

  function displayFor(point) {
    try { return screen.getDisplayNearestPoint(point); } catch (_) { return screen.getPrimaryDisplay(); }
  }
  function areaAt(pos) {
    return displayFor({ x: Math.round(pos.x + WIN_W / 2), y: Math.round(pos.y + WIN_H - INSET.bottom - BODY / 2) }).workArea;
  }
  function rangeAt(pos) { return allowedRange(areaAt(pos), { width: WIN_W, height: WIN_H }, INSET); }
  function currentPos() { const b = win.getBounds(); return { x: b.x, y: b.y }; }
  function place(pos) { if (alive()) win.setBounds({ x: Math.round(pos.x), y: Math.round(pos.y), width: WIN_W, height: WIN_H }, false); }

  function initialPosition() {
    const saved = settings.get().position;
    if (saved) {
      const area = areaAt(saved);
      const range = allowedRange(area, { width: WIN_W, height: WIN_H }, INSET);
      const pos = clampTo(range, saved.x, saved.y);
      // 存的位置所在的屏幕已经拔掉时，clamp 会把它拉回最近的屏幕。
      return pos;
    }
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - WIN_W + INSET.right - MARGIN, y: area.y + area.height - WIN_H + INSET.bottom - 8 };
  }

  function ensureWindow() {
    if (alive()) return win;
    win = new BrowserWindow({
      width: WIN_W, height: WIN_H, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: true /* 右键菜单要能拿到焦点，点别处才会收起 */, alwaysOnTop: true, hasShadow: false, title: 'AI Hub 桌宠',
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: true },
    });
    try { win.setAlwaysOnTop(true, 'floating'); } catch (_) {}
    win.setMenuBarVisibility?.(false);
    win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.setIgnoreMouseEvents(true, { forward: true });
    const pos = initialPosition();
    place(pos);
    dock = dockOf({ position: pos, area: areaAt(pos), size: { width: WIN_W, height: WIN_H }, inset: INSET });
    win.on('closed', () => { win = null; lastSent = ''; stopMove(); drag = null; });
    win.webContents.once('did-finish-load', () => {
      if (!alive()) return;
      lastSent = '';
      evaluate();
      if (canShow()) win.showInactive();
    });
    Promise.resolve(win.loadFile(htmlPath)).catch(error => logger.warn?.('[hub-pet] load failed:', error && error.message));
    return win;
  }

  // ---------- 姿态与说话 ----------
  // 隔离测试可以把「现在几点」挪到白天（nowShift），避免夜里跑测试时一直在打盹。
  const clock = () => now() + (Number(overrides.nowShift) || 0);

  function idleSeconds() {
    if (Number.isFinite(overrides.idleSec)) return overrides.idleSec;
    try { return powerMonitor.getSystemIdleTime(); } catch (_) { return 0; }
  }
  function assistantBusy() {
    if (typeof overrides.busy === 'boolean') return overrides.busy;
    try { return !!isAssistantBusy(); } catch (_) { return false; }
  }
  function gate(spokenAt) {
    return speakGate(settings.get(), { now: clock(), pose, fullscreen }, spokenAt);
  }

  function evaluate() {
    if (!alive()) return;
    const t = clock();
    const idleSec = idleSeconds();
    const ctxBase = { now: t, fullscreen, assistantBusy: assistantBusy(), idleSec, quotaLow: signals.quotaLow, pettedAt };
    // 先按「没在说话」定姿态（决定能不能开口：打盹时不说），再推进气泡队列，最后按是否在说话定最终姿态。
    pose = decidePose({ ...ctxBase, speaking: false });
    const chatter = chatterFor(settings.get().mode, { now: t, idleSec }, chatterTrack);
    if (chatter) speech.push(chatter);
    speech.tick(gate);
    const snap = speech.snapshot();
    pose = decidePose({ ...ctxBase, speaking: !!snap.bubble });
    const s = settings.get();
    const state = {
      pose, role: s.role, mode: s.mode, dock: fullscreen ? 'right' : dock, peeking: fullscreen,
      bubble: snap.bubble ? { id: snap.bubble.id, title: snap.bubble.title, kind: snap.bubble.kind } : null,
      dots: snap.dots, quiet: !gate([]).ok, sequences: (manifest[s.role] && manifest[s.role].sequences) || [],
      night: pose === 'sleep',
    };
    const key = JSON.stringify(state);
    if (key !== lastSent) { lastSent = key; send('hub-pet:state', state); }
    scheduleDeadline();
  }

  function scheduleDeadline() {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    const due = speech.nextDeadline();
    if (due == null) return;
    deadlineTimer = setTimeout(() => { deadlineTimer = null; evaluate(); }, Math.max(50, due - now() + 20));
  }

  function onNotice(notice) {
    if (!notice || !notice.id) return;
    if (speech.push(notice)) evaluate();
  }

  // ---------- 全屏躲边 ----------
  function setFullscreen(value) {
    if (value === fullscreen) return;
    fullscreen = value;
    if (alive() && !drag) {
      if (fullscreen) {
        peekFrom = currentPos();
        const pos = peekFrom;
        const area = areaAt(pos);
        const to = { x: area.x + area.width - INSET.left - Math.round(BODY * PEEK_VISIBLE), y: area.y + area.height - WIN_H + INSET.bottom };
        animateTo([{ from: pos, to, durationMs: 420 }], () => send('hub-pet:motion', { phase: 'land', impact: 0.2 }));
      } else if (peekFrom) {
        const back = peekFrom;
        peekFrom = null;
        animateTo([{ from: currentPos(), to: back, durationMs: 420 }], () => send('hub-pet:motion', { phase: 'land', impact: 0.4 }));
      }
    }
    evaluate();
  }

  // ---------- 移动动画（滑行、贴边、躲边） ----------
  function stopMove() { if (moveTimer) clearInterval(moveTimer); moveTimer = null; }
  function animateTo(steps, done) {
    stopMove();
    const queue = steps.filter(s => s.durationMs > 0);
    if (!queue.length || !alive()) { done?.(); return; }
    let step = queue.shift();
    let startAt = Date.now();
    moveTimer = setInterval(() => {
      if (!alive()) { stopMove(); return; }
      const p = Math.min(1, (Date.now() - startAt) / step.durationMs);
      const k = cubicOut(p);
      place({ x: step.from.x + (step.to.x - step.from.x) * k, y: step.from.y + (step.to.y - step.from.y) * k });
      if (p < 1) return;
      if (queue.length) { step = queue.shift(); startAt = Date.now(); return; }
      stopMove();
      done?.();
    }, DRAG_TICK_MS);
  }

  // ---------- 拖动 ----------
  function cursor() {
    if (overrides.cursor) return overrides.cursor; // 隔离测试不动真鼠标，用注入的位置模拟拖动
    try { return screen.getCursorScreenPoint(); } catch (_) { return { x: 0, y: 0 }; }
  }
  function onPress(target) {
    if (!alive()) return;
    stopMove();
    const c = cursor();
    const pos = currentPos();
    drag = { target: target || 'pet', start: c, offset: { x: c.x - pos.x, y: c.y - pos.y }, moved: false, samples: [{ t: Date.now(), x: pos.x, y: pos.y }], startedAt: Date.now(), last: pos };
    win.setIgnoreMouseEvents(false);
    moveTimer = setInterval(dragTick, DRAG_TICK_MS);
  }
  function dragTick() {
    if (!drag || !alive()) { stopMove(); return; }
    if (!drag.releasing && Date.now() - drag.startedAt > 120000) { onRelease(); return; }
    if (fullscreen) return; // 躲边时只认点击，不让拖出来
    const c = cursor();
    if (!drag.moved && Math.hypot(c.x - drag.start.x, c.y - drag.start.y) < CLICK_SLOP) return;
    if (!drag.moved) { drag.moved = true; send('hub-pet:motion', { phase: 'lift' }); }
    const range = rangeAt(drag.last);
    const pos = clampTo({ ...range, minY: range.minY - 40 }, c.x - drag.offset.x, c.y - drag.offset.y);
    const t = Date.now();
    const prev = drag.samples[drag.samples.length - 1];
    if (pos.x === prev.x && pos.y === prev.y && t - prev.t < 100) return;
    drag.samples.push({ t, x: pos.x, y: pos.y });
    if (drag.samples.length > 30) drag.samples.shift();
    const dt = Math.max(1, t - prev.t) / 1000;
    place(pos);
    drag.last = pos;
    send('hub-pet:motion', { phase: 'drag', vx: (pos.x - prev.x) / dt, vy: (pos.y - prev.y) / dt });
  }
  function onRelease() {
    if (!drag) return;
    drag.releasing = true;
    if (drag.moved) dragTick(); // 先跟上松手那一刻的鼠标位置，再按最后 180ms 的速度规划滑行
    if (!drag) return;
    const d = drag;
    drag = null;
    stopMove();
    if (!d.moved) { handleClick(d.target); return; }
    pettedAt = clock();
    const position = currentPos();
    const plan = releasePlan({ samples: d.samples, position, area: areaAt(position), size: { width: WIN_W, height: WIN_H }, inset: INSET });
    send('hub-pet:motion', { phase: 'release', speed: plan.speed, vx: plan.vx, vy: plan.vy });
    lastRelease = { speed: Math.round(plan.speed), samples: d.samples.length, steps: plan.steps.map(st => st.kind), dock: plan.dock };
    animateTo(plan.steps, () => {
      dock = plan.dock;
      settings.update({ position: plan.final });
      send('hub-pet:motion', { phase: 'land', impact: Math.min(1, 0.35 + plan.speed / 2400) });
      lastSent = '';
      evaluate();
    });
  }

  // ---------- 点击与菜单 ----------
  function openAssistant(payload = {}) {
    try { focusPrimaryWindow?.(); } catch (_) {}
    try { sendToRenderer?.('hub-pet:open-assistant', { source: 'pet', ...payload }); } catch (_) {}
  }
  function handleClick(target) {
    pettedAt = clock();
    if (target === 'bubble') {
      const item = speech.takeCurrent();
      if (item) send('hub-pet:panel', { items: [item] });
    } else if (target === 'dot') {
      const items = speech.takeDots();
      if (items.length) send('hub-pet:panel', { items });
    } else {
      send('hub-pet:motion', { phase: 'poke' });
      openAssistant({});
    }
    evaluate();
  }

  function popupMenu() {
    if (!alive() || !Menu) return;
    const s = settings.get();
    const t = clock();
    const quietHour = s.quietUntil > t;
    const silentToday = s.silentDate === localDateKey(t);
    const template = [
      ...ASSISTANT_ACTIONS.map(a => ({ label: a.label, click: () => openAssistant({ action: a.action, prompt: a.prompt }) })),
      { type: 'separator' },
      { label: quietHour ? '安静一小时（点一下恢复）' : '安静一小时', type: 'checkbox', checked: quietHour, click: () => { settings.update({ quietUntil: quietHour ? 0 : t + 3600000 }); evaluate(); } },
      { label: '今天别说话', type: 'checkbox', checked: silentToday, click: () => { settings.update({ silentDate: silentToday ? '' : localDateKey(t) }); evaluate(); } },
      { label: '说话频率', submenu: MODES.map(m => ({ label: MODE_LABELS[m], type: 'radio', checked: s.mode === m, click: () => { settings.update({ mode: m }); evaluate(); } })) },
      { label: '换角色', submenu: ROLES.map(r => ({ label: r.name, type: 'radio', checked: s.role === r.id, click: () => { settings.update({ role: r.id }); evaluate(); } })) },
      { type: 'separator' },
      { label: '收起桌宠（设置里可再打开）', click: () => setSettings({ enabled: false }) },
    ];
    try { Menu.buildFromTemplate(template).popup({ window: win }); } catch (error) { logger.warn?.('[hub-pet] menu', error.message); }
  }

  // ---------- IPC ----------
  const fromPet = event => !!(event && alive() && event.sender === win.webContents);
  const fromMain = event => { const m = getMainWindow?.(); return !!(event && m && !m.isDestroyed?.() && event.sender === m.webContents); };
  const handlers = {
    'hub-pet:ready': (event) => { if (fromPet(event)) { lastSent = ''; evaluate(); } },
    'hub-pet:hit': (event, hit) => { if (fromPet(event) && !drag) win.setIgnoreMouseEvents(!hit, { forward: true }); },
    'hub-pet:press': (event, payload) => { if (fromPet(event)) onPress(payload && payload.target); },
    'hub-pet:release': (event) => { if (fromPet(event)) onRelease(); },
    'hub-pet:menu': (event) => { if (fromPet(event)) { if (drag) { drag = null; stopMove(); } popupMenu(); } },
    'hub-pet:open-notice': (event, item) => {
      if (!fromPet(event) || !item) return;
      openAssistant({ noticeId: String(item.id || '').slice(0, 160), sessionId: item.sessionId ? String(item.sessionId).slice(0, 160) : undefined });
    },
    'hub-pet:signal': (event, patch) => { if (fromMain(event)) setSignal(patch); },
  };
  for (const [channel, fn] of Object.entries(handlers)) ipcMain.on(channel, fn);

  function publicSettings() { return { available, settings: settings.get(), roles: ROLES, modes: MODES.map(id => ({ id, label: MODE_LABELS[id] })) }; }
  ipcMain.handle('hub-pet:get-settings', (event) => (fromMain(event) ? publicSettings() : null));
  ipcMain.handle('hub-pet:set-settings', (event, patch) => (fromMain(event) ? (setSettings(patch), publicSettings()) : null));
  if (debug) {
    ipcMain.handle('hub-pet:debug', (event, req = {}) => {
      if (!fromMain(event)) return null;
      if (req.op === 'notice') return noticeBus?.publish(req.notice) || false;
      if (req.op === 'override') {
        for (const k of ['idleSec', 'busy', 'fullscreen', 'nowShift']) if (k in req) overrides[k] = req[k];
        if ('fullscreen' in req) setFullscreen(req.fullscreen === true);
        evaluate();
        return true;
      }
      if (req.op === 'state') return { lastSent: lastSent ? JSON.parse(lastSent) : null, bounds: alive() ? win.getBounds() : null, visible: alive() && win.isVisible(), petPid: alive() ? win.webContents.getOSProcessId() : null, fullscreenWatch: fsWatch.isRunning(), lastRelease };
      if (req.op === 'metrics') {
        const pid = alive() ? win.webContents.getOSProcessId() : null;
        return (app?.getAppMetrics?.() || []).filter(m => m.pid === pid || m.type === 'GPU').map(m => ({ pid: m.pid, type: m.type, cpu: m.cpu && m.cpu.percentCPUUsage }));
      }
      if (req.op === 'press') { onPress(req.target); return true; }
      if (req.op === 'release') { onRelease(); return true; }
      if (req.op === 'move') { if (alive()) place(req.pos); return true; }
      if (req.op === 'cursor') { overrides.cursor = req.pos || null; return true; }
      if (req.op === 'hide') { if (alive()) win.hide(); return true; }
      if (req.op === 'show') { if (alive()) win.showInactive(); return true; }
      return null;
    });
  }

  function setSignal(patch = {}) {
    if (typeof patch.quotaLow === 'boolean') signals = { ...signals, quotaLow: patch.quotaLow };
    evaluate();
  }

  function setSettings(patch = {}) {
    const clean = {};
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
    if (ROLES.some(r => r.id === patch.role)) clean.role = patch.role;
    if (MODE_SET.has(patch.mode)) clean.mode = patch.mode;
    settings.update(clean);
    if ('enabled' in clean) { if (clean.enabled) start(); else stop(); }
    else evaluate();
  }

  // ---------- 生命周期 ----------
  function start() {
    if (!enabled() || started) return false;
    started = true;
    ensureWindow();
    noticeBus?.on?.('notice', onNotice);
    pollTimer = setInterval(evaluate, POLL_MS);
    if (watchFullscreen && overrides.fullscreen == null) fsWatch.start();
    return true;
  }
  function stop() {
    if (!started) return;
    started = false;
    noticeBus?.removeListener?.('notice', onNotice);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    stopMove();
    drag = null;
    fsWatch.stop();
    fullscreen = false;
    peekFrom = null;
    if (alive()) win.destroy();
    win = null;
    lastSent = '';
  }
  function dispose() {
    if (disposed) return;
    stop();
    disposed = true;
    for (const [channel, fn] of Object.entries(handlers)) ipcMain.removeListener?.(channel, fn);
    ipcMain.removeHandler?.('hub-pet:get-settings');
    ipcMain.removeHandler?.('hub-pet:set-settings');
    if (debug) ipcMain.removeHandler?.('hub-pet:debug');
  }

  return { start, stop, dispose, setSignal, setSettings, getWindow: () => win, getSettings: () => settings.get(), _evaluate: evaluate, _speech: speech };
}

module.exports = { BODY, INSET, WIN_H, WIN_W, createHubPetController };
