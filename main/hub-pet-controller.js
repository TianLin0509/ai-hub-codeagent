'use strict';
// 助理桌宠的窗口与行为（主进程）。设计：docs/design/hub-pet.md。
// 一个透明、无边框、置顶、不进任务栏的小窗，Hub 开着时出现；动画全在渲染端（renderer/hub-pet/pet.js），
// 这里负责：窗口位置（拖动、惯性、贴边、躲边、记住位置）、姿态判断、气泡排队、右键菜单、打开助理页。
const fs = require('fs');
const path = require('path');
const { ASSISTANT_ACTIONS, MODES, ROLES, SpeechQueue, chatterFor, decidePose, localDateKey, speakGate } = require('../core/hub-pet/state');
const { allowedRange, clampTo, cubicOut, dockOf, releasePlan } = require('../core/hub-pet/motion');
const { SCALE_MAX, SCALE_MIN, createSettingsStore, parseBox, parseScale } = require('../core/hub-pet/settings');
const { DEFAULT_ROLE, createRolePackStore } = require('../core/hub-pet/role-packs');
const { createFullscreenWatch } = require('../core/hub-pet/fullscreen-watch');

const WIN_W = 280;
const WIN_H = 340;                       // 原大小时的窗口高度；放大后按身体加高（winH）
const BODY = 150;                        // 原大小时宠物身体的显示尺寸（DIP），在窗口底部居中
const INSET = { left: (WIN_W - BODY) / 2, right: (WIN_W - BODY) / 2, top: 0, bottom: 6 };
// 大小（2026-10-18 用户：设置里滑动条连续调）：身体 = BODY × scale（SCALE_MIN–SCALE_MAX，见 core/hub-pet/settings.js）；
// 窗口宽不变（放到最大 240 也装得下），高度按身体加高。
const HEAD_ROOM = WIN_H - BODY;          // 身体上方留给气泡、提醒列表的高度
const MARGIN = 24;
const EDGE_CUT_MAX = 120;                // 告诉渲染端「窗口伸出屏幕」的宽度上限，见 edgeCut
const PEEK_VISIBLE = 0.42;               // 躲边时露出身体的比例
const POLL_MS = 4000;                    // 看助理忙不忙、有没有离开电脑
const DRAG_TICK_MS = 16;
const CLICK_SLOP = 4;
const MODE_LABELS = { lively: '活泼', gentle: '温和', quiet: '安静' };
const MODE_HINTS = { lively: '提醒之外，早上问候、久坐提醒', gentle: '只说助理的提醒', quiet: '不说话，只亮小圆点' };

const MODE_SET = new Set(MODES);

function createHubPetController({
  BrowserWindow, BaseWindow = null, screen, ipcMain, Menu, powerMonitor, app,
  htmlPath, preloadPath, assetsDir, dataDir,
  company = false, available = true,
  getMainWindow, focusPrimaryWindow, sendToRenderer,
  noticeBus, isAssistantBusy = () => false,
  canShow = () => true, debug = false, watchFullscreen = true,
  logger = console, now = () => Date.now(),
  fetchImpl = globalThis.fetch, roleSources = null, autoRoleDelayMs = 2500,
} = {}) {
  // now 是「现在几点」（可在单测里固定）；窗口移动的动画计时一律用真实时钟 Date.now()。
  if (typeof BrowserWindow !== 'function') throw new Error('BrowserWindow is required');
  // 形象：程序自带的（公司版只带小猫、企鹅）+ 在线下载到数据目录的（core/hub-pet/role-packs.js）。
  const roles = createRolePackStore({ assetsDir, dataDir, logger, fetchImpl, ...(roleSources ? { sources: roleSources } : {}),
    emit: (channel, payload) => { try { sendToRenderer?.(channel, payload); } catch (_) {} } });
  // 设置里记住的形象：装了的，或者是在线可下载的已知形象（2026-10-18：2.1.8 选了兔子等的用户升级后，
  // 记忆不能因为一次别的设置写盘就被改成小猫；显示时没装照样先用小猫，见 currentRole）。
  const knownRole = id => ROLES.some(r => r.id === id);
  const settings = createSettingsStore({ dataDir, company, logger, roleOk: id => roles.installed(id) || knownRole(id) });
  const speech = new SpeechQueue({ now });
  const chatterTrack = {};
  // 存的形象被删掉（或换到没带这只的版本）时用小猫顶上。
  const currentRole = () => { const r = settings.get().role; return roles.installed(r) ? r : DEFAULT_ROLE; };

  let win = null;
  let started = false;
  let disposed = false;
  let pollTimer = null;
  let deadlineTimer = null;
  let moveTimer = null;
  let drag = null;
  let lastSent = '';
  let pose = 'idle';
  let fullscreen = false;        // 正在躲边（全屏且设置里开着「全屏时躲边」）
  let screenFull = false;        // 前台程序是不是全屏（关了躲边也照样不说话）
  let peekFrom = null;           // 躲边前的位置，全屏结束后回去
  let dock = null;
  let pettedAt = 0;
  let lastRelease = null;       // 最近一次松手的速度与计划（隔离测试读）
  let signals = { quotaLow: false };
  // 形象图里身体四周的透明边（占身体框的比例，渲染端量出来的）。贴边按看得见的身体算，
  // 不然图里那圈透明边会像「空气墙」一样，离屏幕边还有二三十像素就停住（2026-10-18 用户在公司反馈）。
  // 量过的形象记在 hub-pet.json 的 bodyBoxes 里，启动时直接用，不再「先按整张图摆、量完又挪一下」（2026-10-18 审核）。
  const ZERO_BOX = { left: 0, right: 0, top: 0, bottom: 0 };
  const cachedBox = id => parseBox((settings.get().bodyBoxes || {})[id]);
  let boxRole = currentRole();
  let bodyBox = cachedBox(boxRole) || { ...ZERO_BOX };
  let flushTimer = null;          // 拖大小滑块时，停下 300ms 再写盘
  const overrides = {};          // 隔离测试注入（idleSec / busy / fullscreen / cursor）

  const fsWatch = createFullscreenWatch({ logger, onChange: (value) => { if (overrides.fullscreen == null) setScreenFull(value); } });

  const enabled = () => available && !disposed && settings.get().enabled;
  const alive = () => !!(win && !win.isDestroyed());
  const send = (channel, payload) => { if (alive()) win.webContents.send(channel, payload); };

  const scaleNow = () => parseScale(settings.get().scale) ?? 1;
  // 某个大小、某组透明边下的几何：身体边长、窗口高、身体相对窗口的边距。改大小或量出透明边时，新旧两套都要算。
  function geom(scale = scaleNow(), box = bodyBox) {
    const b = Math.round(BODY * scale), side = (WIN_W - b) / 2;
    const h = Math.max(WIN_H, HEAD_ROOM + b);
    return { body: b, h, size: { width: WIN_W, height: h },
      inset: { left: side + Math.round(box.left * b), right: side + Math.round(box.right * b), top: 0, bottom: INSET.bottom } };
  }
  const bodyPx = () => geom().body;
  const winH = () => geom().h;
  const winSize = () => geom().size;
  const inset = () => geom().inset;
  function displayFor(point) {
    try { return screen.getDisplayNearestPoint(point); } catch (_) { return screen.getPrimaryDisplay(); }
  }
  // 身体中心所在屏幕的工作区。
  function areaFor(pos, g = geom()) {
    return displayFor({ x: Math.round(pos.x + WIN_W / 2), y: Math.round(pos.y + g.h - INSET.bottom - g.body / 2) }).workArea;
  }
  const areaAt = pos => areaFor(pos);
  function rangeFor(pos, g = geom()) { return allowedRange(areaFor(pos, g), g.size, g.inset); }
  const rangeAt = pos => rangeFor(pos);
  function currentPos() { const b = win.getBounds(); return { x: b.x, y: b.y }; }
  // 最近一次自己放窗口的位置。混合 DPI 下 getBounds 读回来可能和设的差 1px，连续改大小时按读回值算会一点点漂；
  // 读回值和它相差不超过 2px 就以它为准（2026-10-18 审核）。
  let placed = null;
  function place(pos) {
    if (!alive()) return;
    placed = { x: Math.round(pos.x), y: Math.round(pos.y), height: winH() };
    win.setBounds({ x: placed.x, y: placed.y, width: WIN_W, height: placed.height }, false);
  }
  function placedBounds() {
    const b = win.getBounds();
    if (placed && Math.abs(b.x - placed.x) <= 2 && Math.abs(b.y - placed.y) <= 2 && Math.abs(b.height - placed.height) <= 2) return { ...placed };
    return { x: b.x, y: b.y, height: b.height };
  }

  // 存的位置不在现在的任何屏幕上（副屏拔了），窗口被拉回最近的屏幕时为 true：这时不拿窗口的位置覆盖存的副屏位置，
  // 只有用户真的拖过才写（2026-10-18 审核）。
  let savedDetached = false;
  function defaultPosition(g = geom()) {
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - WIN_W + g.inset.right - MARGIN, y: area.y + area.height - g.h + INSET.bottom - 8 };
  }
  function initialPosition() {
    const saved = settings.get().position;
    if (saved) {
      // 存的位置所在的屏幕已经拔掉时，clamp 会把它拉回最近的屏幕。
      const pos = clampTo(rangeAt(saved), saved.x, saved.y);
      savedDetached = pos.x !== saved.x || pos.y !== saved.y;
      return pos;
    }
    savedDetached = false;
    return defaultPosition();
  }
  // 大小或透明边变了，存的位置怎么换算：脚的位置不动（窗口底边对齐），原来贴边的继续贴边。
  // 窗口开没开都按这个算（桌宠关着时改大小，下次打开不会悬在半空）。存的位置不在现有屏幕上时只按脚换算，不往现有屏幕上拉。
  function convertSaved(saved, g0, g1) {
    const feetShift = { x: saved.x, y: saved.y + g0.h - g1.h };
    const r0 = rangeFor(saved, g0);
    const c = clampTo(r0, saved.x, saved.y);
    if (c.x !== saved.x || c.y !== saved.y) return feetShift;
    const d = dockOf({ position: saved, area: areaFor(saved, g0), size: g0.size, inset: g0.inset });
    const r1 = rangeFor(feetShift, g1);
    return clampTo(r1, d === 'left' ? r1.minX : d === 'right' ? r1.maxX : feetShift.x, feetShift.y);
  }
  // 窗口伸出所在屏幕工作区的宽度（左、右）。告诉渲染端，气泡、提醒面板、小圆点都只放在看得见的那一段里（2026-10-18 审核：
  // 原来写死 65px，小猫 100% 贴右边时会被裁约 30px，60% 时约 48px）。
  // 窗口和工作区完全不相交时（隔离测试把窗口停在屏幕外，或系统暂时没报对位置）按 0 算；每边最多 EDGE_CUT_MAX，
  // 保证气泡和面板总有地方放（正常贴边最多伸出约 113px：60%、贴右边；躲边时本来就不冒气泡）。
  function edgeCut() {
    if (!alive()) return { left: 0, right: 0 };
    const b = placedBounds();
    const area = areaFor(b);
    const h = winH();
    const apart = b.x + WIN_W <= area.x || b.x >= area.x + area.width || b.y + h <= area.y || b.y >= area.y + area.height;
    if (apart) return { left: 0, right: 0 };
    const cut = v => Math.min(EDGE_CUT_MAX, Math.max(0, Math.round(v)));
    return { left: cut(area.x - b.x), right: cut(b.x + WIN_W - (area.x + area.width)) };
  }

  // 隐藏的宿主窗口（2026-10-17，公司 CI 39030602842）：桌宠是置顶窗，Windows 挑「进程主窗口」时（Get-Process 的
  // MainWindowTitle、按标题里 PID/版本认实例）会先挑到它，读成「AI Hub 桌宠」。有宿主的窗口和看不见的窗口都不参与挑选，
  // 所以给桌宠挂一个永不显示的宿主：主窗口照旧被认出来。不挂在 Hub 主窗口下——那样主窗口最小化时桌宠会跟着消失。
  let owner = null;
  function ensureOwner() {
    if (!BaseWindow) return null;
    if (owner && !owner.isDestroyed?.()) return owner;
    try {
      owner = new BaseWindow({ show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false, resizable: false, title: 'AI Hub 桌宠宿主' });
      owner.on?.('closed', () => { owner = null; });
    } catch (error) { owner = null; logger.warn?.('[hub-pet] owner window failed:', error && error.message); }
    return owner;
  }
  function ensureWindow() {
    if (alive()) return win;
    // 关着时换过形象：用新形象量过的透明边摆位置。
    if (boxRole !== currentRole()) { boxRole = currentRole(); bodyBox = cachedBox(boxRole) || bodyBox; }
    const parent = ensureOwner();
    win = new BrowserWindow({
      ...(parent ? { parent } : {}),
      width: WIN_W, height: winH(), show: false, frame: false, transparent: true, backgroundColor: '#00000000',
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
    dock = dockOf({ position: pos, area: areaAt(pos), size: winSize(), inset: inset() });
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
    return speakGate(settings.get(), { now: clock(), pose, fullscreen: fullscreen || screenFull }, spokenAt);
  }

  function evaluate() {
    if (!alive()) return;
    // 换了形象：量过的就直接用它的透明边（refit 里会再进 evaluate，boxRole 先改掉，不会绕圈）。
    if (boxRole !== currentRole()) {
      boxRole = currentRole();
      const box = cachedBox(boxRole);
      if (box && JSON.stringify(box) !== JSON.stringify(bodyBox)) { applyBodyBox(box); return; }
    }
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
    const role = currentRole();
    const state = {
      pose, role, assetBase: roles.assetBase(role), mode: s.mode, dock: fullscreen ? 'right' : dock, peeking: fullscreen, scale: scaleNow(),
      bubble: snap.bubble ? { id: snap.bubble.id, title: snap.bubble.title, kind: snap.bubble.kind } : null,
      dots: snap.dots, quiet: !gate([]).ok, sequences: (roles.meta(role) && roles.meta(role).sequences) || [], clipped: (roles.meta(role) && roles.meta(role).clipped) || {},
      night: pose === 'sleep', edge: edgeCut(),
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
  function setScreenFull(value) {
    screenFull = !!value;
    setFullscreen(screenFull && settings.get().peekOnFullscreen !== false);
    evaluate();
  }
  function peekTarget(from, g = geom()) {
    const area = areaFor(from, g);
    const visible = g.body * (1 - bodyBox.left - bodyBox.right);
    return { x: area.x + area.width - g.inset.left - Math.round(visible * PEEK_VISIBLE), y: area.y + area.height - g.h + INSET.bottom };
  }
  function setFullscreen(value) {
    if (value === fullscreen) return;
    fullscreen = value;
    if (alive() && !drag) {
      if (fullscreen) {
        peekFrom = currentPos();
        const pos = peekFrom;
        const to = peekTarget(pos);
        animateTo([{ from: pos, to, durationMs: 420 }], () => send('hub-pet:motion', { phase: 'land', impact: 0.2 }));
      } else if (peekFrom) {
        const back = peekFrom;
        peekFrom = null;
        animateTo([{ from: currentPos(), to: back, durationMs: 420 }], () => { send('hub-pet:motion', { phase: 'land', impact: 0.4 }); evaluate(); });
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
    // 限位取「鼠标所在屏」和「宠物现在所在屏」的并集：以前只按现在所在的屏，宠物出不了这块屏（双屏拖不过去）；
    // 只按要去的位置所在屏时，身体中心一过两屏中线范围就整个换掉，会闪跳一下（2026-10-18 审核）。松手后再按落点所在屏贴好。
    const want = { x: c.x - drag.offset.x, y: c.y - drag.offset.y };
    const g = geom();
    const a = allowedRange(displayFor({ x: Math.round(c.x), y: Math.round(c.y) }).workArea, g.size, g.inset);
    const b = rangeFor(drag.last, g);
    const range = { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) };
    const pos = clampTo({ ...range, minY: range.minY - 40 }, want.x, want.y);
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
    const plan = releasePlan({ samples: d.samples, position, area: areaAt(position), size: winSize(), inset: inset() });
    send('hub-pet:motion', { phase: 'release', speed: plan.speed, vx: plan.vx, vy: plan.vy });
    lastRelease = { speed: Math.round(plan.speed), samples: d.samples.length, steps: plan.steps.map(st => st.kind), dock: plan.dock };
    animateTo(plan.steps, () => {
      dock = plan.dock;
      settings.update({ position: plan.final });
      savedDetached = false;
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

  // ---------- 右键菜单（2026-10-17：自绘浮层，替换系统原生菜单） ----------
  // 一个透明小窗，第一次右键时建好，之后只是显示/隐藏（打开快）。同样挂在隐藏宿主下，不抢 Hub 主窗口的标题。
  // 点菜单外面（失焦）、按 Esc、或点了会离开的项目就收起；切换开关、换频率、换形象后菜单留着，结果当场可见。
  const MENU_W = 260;
  const menuHtml = path.join(path.dirname(htmlPath || ''), 'pet-menu.html');
  const menuPreload = path.join(path.dirname(preloadPath || ''), 'pet-menu-preload.js');
  let menuWin = null;
  let menuReady = false;
  let menuAnchor = null;
  let menuSize = { width: MENU_W, height: 420 };
  const menuAlive = () => !!(menuWin && !menuWin.isDestroyed());
  const POSE_TEXT = { idle: '在旁边陪着你', typing: '助理正在干活', happy: '有话要跟你说', sleep: '在打盹', peek: '躲在屏幕边上', tired: '有点累了' };
  const pad2 = n => String(n).padStart(2, '0');

  function menuState() {
    const s = settings.get(), t = clock();
    const role = currentRole();
    const list = roleList();
    const me = list.find(r => r.id === role) || { id: role, name: (ROLES.find(r => r.id === role) || {}).name || '桌宠' };
    const dots = speech.snapshot().dots;
    const quietHour = s.quietUntil > t;
    const status = [POSE_TEXT[pose] || '', dots ? `${dots} 条提醒没看` : '', s.mode === 'quiet' ? '只亮小圆点' : ''].filter(Boolean).join(' · ');
    return {
      role: { id: me.id, name: me.name, preview: me.preview || '' }, status, mode: s.mode,
      modes: MODES.map(id => ({ id, label: MODE_LABELS[id], hint: MODE_HINTS[id] })),
      quietHour, quietUntilText: quietHour ? `${pad2(new Date(s.quietUntil).getHours())}:${pad2(new Date(s.quietUntil).getMinutes())}` : '',
      silentToday: s.silentDate === localDateKey(t),
      actions: ASSISTANT_ACTIONS.map(a => ({ action: a.action, label: a.label })),
      roles: list.filter(r => r.installed).map(r => ({ id: r.id, name: r.name, preview: r.preview || '' })),
      moreRoles: list.some(r => !r.installed),
    };
  }
  function sendMenuState() { if (menuAlive() && menuReady) menuWin.webContents.send('hub-pet-menu:state', menuState()); }

  function ensureMenu() {
    if (menuAlive()) return menuWin;
    const parent = ensureOwner();
    menuReady = false;
    menuWin = new BrowserWindow({
      ...(parent ? { parent } : {}),
      width: MENU_W, height: menuSize.height, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: true, alwaysOnTop: true, hasShadow: false, title: 'AI Hub 桌宠菜单',
      webPreferences: { preload: menuPreload, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    try { menuWin.setAlwaysOnTop(true, 'pop-up-menu'); } catch (_) {}
    menuWin.setMenuBarVisibility?.(false);
    menuWin.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    menuWin.webContents.on('will-navigate', event => event.preventDefault());
    menuWin.on('blur', () => hideMenu());
    menuWin.on('closed', () => { menuWin = null; menuReady = false; });
    Promise.resolve(menuWin.loadFile(menuHtml)).catch(error => logger.warn?.('[hub-pet] menu load failed:', error && error.message));
    return menuWin;
  }
  function menuBounds() {
    const c = menuAnchor || cursor();
    const area = displayFor(c).workArea;
    const w = MENU_W, h = Math.max(120, Math.min(area.height, menuSize.height));
    const right = c.x + w > area.x + area.width;
    const up = c.y + h > area.y + area.height;
    // 卡片在窗口里左留 14px、上留 10px：让卡片的角正好落在鼠标处。
    const x = right ? c.x - w + 14 : c.x - 14;
    const y = up ? c.y - h + 18 : c.y - 10;
    return { bounds: { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - w, x))), y: Math.round(Math.max(area.y, Math.min(area.y + area.height - h, y))), width: w, height: Math.round(h) }, origin: { right, up } };
  }
  function popupMenu() {
    if (!alive()) return;
    menuAnchor = cursor();
    ensureMenu();
    const open = () => {
      if (!menuAlive()) return;
      sendMenuState();
      const { bounds, origin } = menuBounds();
      menuWin.setBounds(bounds, false);
      menuWin.show();
      menuWin.focus();
      menuWin.webContents.send('hub-pet-menu:open', origin);
    };
    if (menuReady) open(); else menuWin.webContents.once('did-finish-load', () => { menuReady = true; open(); });
  }
  function hideMenu() { if (menuAlive() && menuWin.isVisible()) menuWin.hide(); }
  function menuAct(a = {}) {
    const t = clock();
    if (a.type === 'action') {
      const item = ASSISTANT_ACTIONS.find(x => x.action === a.action);
      hideMenu();
      if (item) openAssistant({ action: item.action, prompt: item.prompt });
      return;
    }
    if (a.type === 'settings') { hideMenu(); openAssistant({ settingsTab: String(a.tab || 'pet') }); return; }
    if (a.type === 'hide') { hideMenu(); setSettings({ enabled: false }); return; }
    if (a.type === 'close') { hideMenu(); return; }
    if (a.type === 'mode' && MODE_SET.has(a.mode)) settings.update({ mode: a.mode });
    else if (a.type === 'quietHour') settings.update({ quietUntil: a.value ? t + 3600000 : 0 });
    else if (a.type === 'silentToday') settings.update({ silentDate: a.value ? localDateKey(t) : '' });
    else if (a.type === 'role' && typeof a.role === 'string' && roles.installed(a.role)) settings.update({ role: a.role });
    else return;
    evaluate();
    sendMenuState();
    try { sendToRenderer?.('hub-pet:settings-changed', publicSettings()); } catch (_) {}
  }

  // ---------- IPC ----------
  const fromPet = event => !!(event && alive() && event.sender === win.webContents);
  const fromMenu = event => !!(event && menuAlive() && event.sender === menuWin.webContents);
  const fromMain = event => { const m = getMainWindow?.(); return !!(event && m && !m.isDestroyed?.() && event.sender === m.webContents); };
  const handlers = {
    'hub-pet:ready': (event) => { if (fromPet(event)) { lastSent = ''; evaluate(); } },
    'hub-pet:hit': (event, hit) => { if (fromPet(event) && !drag) win.setIgnoreMouseEvents(!hit, { forward: true }); },
    'hub-pet:press': (event, payload) => { if (fromPet(event)) onPress(payload && payload.target); },
    'hub-pet:release': (event) => { if (fromPet(event)) onRelease(); },
    'hub-pet:menu': (event) => { if (fromPet(event)) { if (drag) { drag = null; stopMove(); } popupMenu(); } },
    'hub-pet-menu:ready': (event) => { if (fromMenu(event)) { menuReady = true; sendMenuState(); } },
    'hub-pet-menu:size': (event, box) => {
      if (!fromMenu(event) || !box) return;
      const h = Math.round(Number(box.height) || 0);
      if (h < 80 || h > 1200 || h === menuSize.height) return;
      menuSize = { width: MENU_W, height: h };
      if (menuWin.isVisible()) menuWin.setBounds(menuBounds().bounds, false);
    },
    'hub-pet-menu:act': (event, payload) => { if (fromMenu(event)) menuAct(payload || {}); },
    'hub-pet:open-notice': (event, item) => {
      if (!fromPet(event) || !item) return;
      // 「形象没下载下来」的提示：直接打开「助理 → 设置 → 桌宠」。
      if (/^pet-role-missing-/.test(String(item.id || ''))) { openAssistant({ settingsTab: 'pet' }); return; }
      openAssistant({ noticeId: String(item.id || '').slice(0, 160), sessionId: item.sessionId ? String(item.sessionId).slice(0, 160) : undefined });
    },
    'hub-pet:signal': (event, patch) => { if (fromMain(event)) setSignal(patch); },
    // 渲染端量出的身体透明边（比例）。只认 0–0.45 的数，防止一张奇怪的图把限位算坏；量的是别的形象（刚换过）就不认。
    // 量出来就记进 hub-pet.json，下次启动直接用。
    'hub-pet:body-box': (event, box) => {
      if (!fromPet(event) || !box) return;
      const role = currentRole();
      if (typeof box.role === 'string' && box.role && box.role !== role) return;
      const next = parseBox(box);
      if (!next) return;
      boxRole = role;
      applyBodyBox(next, JSON.stringify(cachedBox(role)) !== JSON.stringify(next) ? { bodyBoxes: { [role]: next } } : {});
    },
  };
  for (const [channel, fn] of Object.entries(handlers)) ipcMain.on(channel, fn);

  // roles：[{ id, name, bundled, installed, available, update, bytes, preview, previewMain }]，「换形象」只列 installed 的。
  function roleList() { return roles.listRoles(); }
  function publicSettings() {
    const { bodyBoxes: _boxes, ...s } = settings.get();
    const t = clock();
    return { available, settings: { ...s, role: currentRole() }, roles: roleList(), modes: MODES.map(id => ({ id, label: MODE_LABELS[id] })),
      quietHour: s.quietUntil > t, silentToday: s.silentDate === localDateKey(t), running: alive() };
  }
  ipcMain.handle('hub-pet:get-settings', (event) => (fromMain(event) ? publicSettings() : null));
  ipcMain.handle('hub-pet:set-settings', (event, patch) => (fromMain(event) ? (setSettings(patch), publicSettings()) : null));
  // 形象下载：只在用户点「下载 / 检查新形象」时联网；进度经 hub-pet:roles-state 推给主窗口。
  ipcMain.handle('hub-pet:roles', (event) => (fromMain(event) ? roles.snapshot() : null));
  ipcMain.handle('hub-pet:roles-check', (event) => (fromMain(event) ? roles.check() : null));
  ipcMain.handle('hub-pet:role-download', async (event, id) => {
    if (!fromMain(event)) return null;
    const snap = await roles.download(String(id || ''));
    lastSent = '';
    evaluate();
    return snap;
  });
  if (debug) {
    ipcMain.handle('hub-pet:debug', (event, req = {}) => {
      if (!fromMain(event)) return null;
      if (req.op === 'notice') return noticeBus?.publish(req.notice) || false;
      if (req.op === 'override') {
        for (const k of ['idleSec', 'busy', 'fullscreen', 'nowShift']) if (k in req) overrides[k] = req[k];
        if ('fullscreen' in req) setScreenFull(req.fullscreen === true);
        evaluate();
        return true;
      }
      if (req.op === 'state') return { lastSent: lastSent ? JSON.parse(lastSent) : null, bounds: alive() ? win.getBounds() : null, area: alive() ? areaAt(currentPos()) : null, bodyBox: { ...bodyBox }, inset: inset(), edge: edgeCut(), scale: scaleNow(), dock, savedPosition: settings.get().position, savedDetached, visible: alive() && win.isVisible(), petPid: alive() ? win.webContents.getOSProcessId() : null, fullscreenWatch: fsWatch.isRunning(), lastRelease, autoRole: { ...autoRole }, role: settings.get().role };
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
    // live：设置页正在拖大小滑块。只改内存、实时挪窗口，停下 300ms（或松手发来不带 live 的最后一次）再写一次盘（2026-10-18 审核：
    // 原来每 60ms 一次、每次写两遍盘）。
    const live = patch.live === true;
    const clean = {};
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
    if (typeof patch.role === 'string' && roles.installed(patch.role)) clean.role = patch.role;
    if (MODE_SET.has(patch.mode)) clean.mode = patch.mode;
    if (typeof patch.peekOnFullscreen === 'boolean') clean.peekOnFullscreen = patch.peekOnFullscreen;
    const t = clock();
    if (typeof patch.quietHour === 'boolean') clean.quietUntil = patch.quietHour ? t + 3600000 : 0;
    if (typeof patch.silentToday === 'boolean') clean.silentDate = patch.silentToday ? localDateKey(t) : '';
    if (patch.resetPosition === true) clean.position = null;
    const scale = parseScale(patch.scale);
    const g0 = geom();
    if (scale != null && scale !== scaleNow()) {
      clean.scale = scale;
      // 存的位置按脚换算（窗口开没开都换算；没存过位置的照旧用默认位置，不写）。
      const saved = settings.get().position;
      if (saved && !('position' in clean)) clean.position = convertSaved(saved, g0, geom(scale));
    }
    settings.update(clean, { persist: !live });
    if (clean.position === null) savedDetached = false;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (live && settings.isDirty()) {
      flushTimer = setTimeout(() => { flushTimer = null; settings.flush(); }, 300);
      flushTimer.unref?.();
    }
    if ('scale' in clean) refitWindow(g0);
    if ('peekOnFullscreen' in clean) setFullscreen(screenFull && clean.peekOnFullscreen);
    if (clean.position === null && alive() && !drag) {
      // 「回到右下角」：滑回默认位置。
      const to = initialPosition();
      animateTo([{ from: currentPos(), to, durationMs: 420 }], () => {
        dock = dockOf({ position: to, area: areaAt(to), size: winSize(), inset: inset() });
        send('hub-pet:motion', { phase: 'land', impact: 0.3 }); lastSent = ''; evaluate();
      });
    }
    if ('enabled' in clean) { if (clean.enabled) start(); else stop(); }
    else evaluate();
  }

  // 大小或身体透明边变了，挪窗口（g0 是变之前的几何）：脚的位置不动（窗口底边对齐），窗口按新高度往上长；
  // 原来贴着边的继续贴着，超出屏幕的拉回来；没存过位置的回到新大小下的默认位置；躲边中的按新大小重新躲。
  // 只挪窗口，不写盘：存的位置由调用方按 convertSaved 换算后写。返回是否挪了（挪了就已经 evaluate 过）。
  function refitWindow(g0) {
    if (!alive() || drag) return false;
    stopMove();
    const g1 = geom();
    const base = placedBounds();
    if (fullscreen) {
      if (peekFrom) peekFrom = { x: peekFrom.x, y: peekFrom.y + g0.h - g1.h };
      place(peekTarget({ x: base.x, y: base.y + base.height - g1.h }, g1));
    } else if (!settings.get().position) {
      const pos = defaultPosition(g1);
      place(pos);
      dock = dockOf({ position: pos, area: areaFor(pos, g1), size: g1.size, inset: g1.inset });
    } else {
      const want = { x: base.x, y: base.y + base.height - g1.h };
      const range = rangeFor(want, g1);
      const pos = clampTo(range, dock === 'left' ? range.minX : dock === 'right' ? range.maxX : want.x, want.y);
      place(pos);
      dock = dockOf({ position: pos, area: areaFor(pos, g1), size: g1.size, inset: g1.inset });
    }
    lastSent = '';
    evaluate();
    return true;
  }
  // 换上新的身体透明边。存过位置、且不是「副屏拔了被拉回来」的，按贴边换算后写盘；没存过位置的不写（2026-10-18 审核）。
  function applyBodyBox(next, extraPatch = {}) {
    const patch = { ...extraPatch };
    const changed = JSON.stringify(next) !== JSON.stringify(bodyBox);
    const g0 = geom();
    if (changed) {
      bodyBox = { ...next };
      const saved = settings.get().position;
      if (saved && !savedDetached) patch.position = convertSaved(saved, g0, geom());
    }
    if (Object.keys(patch).length) settings.update(patch);
    if (changed && !refitWindow(g0)) evaluate();
  }

  // ---------- 记住的形象没装：后台补下载（2026-10-18） ----------
  // 2.1.9 起兔子、柴犬、仓鼠、玄凤改成在线下载。之前选了它们的用户升级后，设置里还记着，但这台电脑上没有图：
  // 启动后在后台用设置页同一条下载路径（多源、字节数 + SHA-256 校验）补装，装好就换上；
  // 下载不成功时，只说一次温和的提示，指到「助理 → 设置 → 桌宠」。每次启动最多试一次，不反复联网。
  let autoRoleTimer = null;
  let autoRole = { phase: 'idle', id: null, error: null };   // 隔离测试读
  function rememberedMissingRole() {
    const want = settings.get().role;
    return want && knownRole(want) && !roles.installed(want) ? want : null;
  }
  async function restoreRememberedRole() {
    const want = rememberedMissingRole();
    if (!want || disposed || autoRole.phase !== 'idle') return autoRole;
    // 用户正在设置页里自己下载，就交给那边，不抢。
    if (roles.snapshot().state.phase === 'downloading') { autoRole = { phase: 'skipped', id: want, error: null }; return autoRole; }
    autoRole = { phase: 'downloading', id: want, error: null };
    logger.info?.(`[hub-pet] remembered role ${want} is not installed; downloading it in the background`);
    let error = null;
    try {
      const snap = await roles.download(want);
      if (!roles.installed(want)) error = (snap && snap.state && snap.state.error) || '下载没成功';
    } catch (e) { error = (e && e.message) || String(e); }
    if (disposed) return autoRole;
    if (!error) {
      autoRole = { phase: 'installed', id: want, error: null };
      lastSent = '';
      evaluate();
      try { sendToRenderer?.('hub-pet:settings-changed', publicSettings()); } catch (_) {}
      return autoRole;
    }
    autoRole = { phase: 'failed', id: want, error: String(error).slice(0, 200) };
    logger.warn?.(`[hub-pet] background download of ${want} failed:`, autoRole.error);
    // 用户这期间自己换了别的形象，就不打扰了。
    if (settings.get().role !== want) return autoRole;
    const name = (ROLES.find(r => r.id === want) || {}).name || '你选的形象';
    onNotice({ id: `pet-role-missing-${want}`, kind: 'pet-role', title: `${name}还没下载下来，先由小猫陪你`,
      text: `新版里${name}改成在线下载了，刚才自动下载没成功。网络好的时候，在「助理 → 设置 → 桌宠」里点「下载」就能换回${name}。` });
    return autoRole;
  }
  function scheduleRoleRestore() {
    if (autoRoleTimer || autoRole.phase !== 'idle' || !rememberedMissingRole()) return;
    autoRoleTimer = setTimeout(() => { autoRoleTimer = null; void restoreRememberedRole(); }, autoRoleDelayMs);
    autoRoleTimer.unref?.();
  }

  // ---------- 生命周期 ----------
  function start() {
    if (!enabled() || started) return false;
    started = true;
    ensureWindow();
    noticeBus?.on?.('notice', onNotice);
    pollTimer = setInterval(evaluate, POLL_MS);
    if (watchFullscreen && overrides.fullscreen == null) fsWatch.start();
    scheduleRoleRestore();
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
    if (autoRoleTimer) clearTimeout(autoRoleTimer);
    autoRoleTimer = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    settings.flush();
    stopMove();
    drag = null;
    fsWatch.stop();
    fullscreen = false;
    screenFull = false;
    peekFrom = null;
    if (alive()) win.destroy();
    win = null;
    placed = null;
    if (menuAlive()) menuWin.destroy();
    menuWin = null; menuReady = false;
    if (owner && !owner.isDestroyed?.()) { try { owner.destroy(); } catch (_) {} }
    owner = null;
    lastSent = '';
  }
  function dispose() {
    if (disposed) return;
    stop();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    settings.flush();
    roles.cancel();
    disposed = true;
    for (const [channel, fn] of Object.entries(handlers)) ipcMain.removeListener?.(channel, fn);
    ipcMain.removeHandler?.('hub-pet:get-settings');
    ipcMain.removeHandler?.('hub-pet:set-settings');
    for (const ch of ['hub-pet:roles', 'hub-pet:roles-check', 'hub-pet:role-download']) ipcMain.removeHandler?.(ch);
    if (debug) ipcMain.removeHandler?.('hub-pet:debug');
  }

  return { start, stop, dispose, setSignal, setSettings, roleList, getWindow: () => win, getSettings: () => settings.get(), _evaluate: evaluate, _speech: speech, _roles: roles,
    _restoreRememberedRole: restoreRememberedRole, _autoRole: () => ({ ...autoRole }) };
}

module.exports = { BODY, INSET, SCALE_MAX, SCALE_MIN, WIN_H, WIN_W, createHubPetController };
