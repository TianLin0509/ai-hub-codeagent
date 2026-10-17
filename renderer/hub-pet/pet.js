'use strict';
// 助理桌宠的渲染端：所有动作都是「连续变换 + 逐帧硬切的帧序列」，由一个按需降频的 rAF 循环驱动。
// - 有动作（拖动、跳、回弹、换姿态、播放序列）时每帧刷新；只剩呼吸时降到 20 帧/秒，打盹 12 帧/秒；
// - 窗口不可见（最小化、被系统判定遮挡）时整个循环停下；
// - 只写 transform / opacity / background-position，不触发排版。
// 姿态和说话由主进程决定（main/hub-pet-controller.js），这里只负责「怎么演」。
(function () {
  const M = window.HubPetMotion;
  const api = window.hubPet;
  const $ = id => document.getElementById(id);
  const bodyEl = $('body');
  const layersEl = $('layers');
  const shadowEl = $('shadow');
  const bubbleEl = $('bubble');
  const bubbleText = $('bubble-text');
  const dotEl = $('dot');
  const panelEl = $('panel');
  const panelList = $('panel-list');

  const AROUSAL = { idle: 0.25, typing: 0.7, happy: 1, sleep: 0, peek: 0.15, tired: 0.08 };
  const CALM_FPS = { idle: 20, tired: 20, peek: 15, sleep: 12, typing: 30, happy: 30 };
  const POP_MS = 80;

  let state = { pose: 'idle', role: '', sequences: [], clipped: {}, bubble: null, dots: 0, dock: null, peeking: false };
  let pose = null;
  let phase = 0;
  let arousal = 0.25;
  let lastFrame = 0;
  let raf = 0;
  let timer = 0;
  let lift = 0;
  let lifted = false;
  let drag = { vx: 0, vy: 0 };
  let lean = 0;
  let stretch = 0;
  let squash = null;          // { start, power }
  let hops = [];              // [{ start, dur, height }]
  let script = null;          // 一段编排好的动作：{ start, dur, fn(t) -> { rot, y, sx, sy }, done() }
  let nextGestureAt = 0;
  let nextRareAt = 0;
  let nextYawnAt = 0;
  let nextHappyHopAt = 0;
  let bubbleId = '';
  let lastDots = 0;
  let hitNow = false;
  let pressing = false;

  const now = () => performance.now();
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const has = name => state.sequences.indexOf(name) >= 0;
  const asset = name => (state.assetBase || ('../assets/hub-pet/' + state.role + '/')) + name + '.webp';
  const sheetAsset = name => asset('seq-' + name);

  // ---------- 画面：只有一张图，逐帧硬切 ----------
  // 2026-10-17 用户反馈「有残影、看花眼」：原来换姿态时新旧两层各半透明叠 220ms，帧序列也把相邻两帧按小数部分叠着淡入，
  // 两张不同的画叠在一起就是残影。现在任何时刻只显示一张图：序列逐帧换，换姿态时身体先轻轻压一下（80ms），
  // 在压到最低时换图、再弹起来，用动作把切换遮住（卡通里常用的 squash 换形）。新图先解码好再换，不会闪空白。
  const cel = document.createElement('div');
  cel.className = 'cel';
  layersEl.appendChild(cel);
  const ready = new Set();
  const loading = new Map();
  let visual = null;          // { spec, key, role, start, shown, thenFired }
  let pendingSwap = null;     // { start, spec }：压一下再换的那 80ms
  let applyToken = 0;

  function preload(url) {
    if (ready.has(url)) return Promise.resolve(true);
    if (!loading.has(url)) {
      const img = new Image();
      img.src = url;
      loading.set(url, (img.decode ? img.decode() : Promise.resolve()).then(() => { ready.add(url); return true; }, () => false));
    }
    return loading.get(url);
  }
  function preloadRole() {
    for (const p of ['idle', 'typing', 'happy', 'sleep']) preload(asset(p));
    for (const s of state.sequences) preload(sheetAsset(s));
  }
  function urlOf(spec) { return spec.sheet ? sheetAsset(spec.sheet) : asset(spec.img); }
  function specKey(spec) { return (spec.sheet ? 'seq:' + spec.sheet + ':' + spec.list.map(x => x.f).join(',') + (spec.loop ? 'L' : '') : 'img:' + spec.img); }
  const clip = name => (state.clipped && Array.isArray(state.clipped[name]) ? state.clipped[name] : []);

  function applyVisual(spec) {
    const url = urlOf(spec);
    const token = ++applyToken;
    const commit = () => {
      if (token !== applyToken) return;
      cel.style.backgroundImage = 'url("' + url + '")';
      cel.classList.toggle('sheet', !!spec.sheet);
      visual = { spec, key: specKey(spec), role: state.role, start: now(), shown: -1, thenFired: false };
      if (!spec.sheet) cel.style.backgroundPosition = '';
      wake();
    };
    if (ready.has(url)) commit(); else preload(url).then(commit);
  }

  // transition：'cut' 直接换（同一段动作里的帧、外观相近的画面）；'pop' 压一下再换（换姿态）。
  function show(spec, { transition = 'pop' } = {}) {
    if (!spec) return;
    if (!spec.restart && visual && visual.key === specKey(spec) && visual.role === state.role && !pendingSwap) return;
    if (pendingSwap && specKey(pendingSwap.spec) === specKey(spec)) return;
    if (transition === 'pop' && visual) { pendingSwap = { start: now(), spec }; preload(urlOf(spec)); wake(); return; }
    pendingSwap = null;
    applyVisual(spec);
  }

  function renderVisual(t) {
    if (!visual || !visual.spec.sheet) return false;
    const spec = visual.spec;
    const at = M.playlistFrame(t - visual.start, spec.list, spec.loop);
    if (at.f !== visual.shown) { visual.shown = at.f; cel.style.backgroundPosition = M.sheetPosition(at.f); }
    if (spec.loop) return false; // 循环（打字）由降频的定时器推着走，不用每帧刷新
    if (!at.done) return true;
    if (spec.then && !visual.thenFired) {
      visual.thenFired = true;
      const next = typeof spec.then === 'function' ? spec.then() : spec.then;
      if (next) show(next, { transition: spec.thenTransition || 'cut' });
      return true;
    }
    return false;
  }

  // ---------- 姿态 → 怎么演 ----------
  const each = (frames, ms) => frames.map(f => ({ f, ms }));
  function baseSpec(p) {
    if (p === 'typing') {
      // 打字只循环第一行 5 帧：这几帧身体不动、只有爪子在动（WorkMate 也是「身体锁定、只动爪子」）。
      const frames = M.frameRange(0, 4, clip('typing'));
      return has('typing') && frames.length >= 3 ? { sheet: 'typing', list: M.pingPong(frames, 110), loop: true, base: true } : { img: 'typing', base: true };
    }
    if (p === 'happy') return { img: 'happy', base: true };
    if (p === 'sleep') return { img: 'sleep', base: true };
    if (p === 'peek') {
      const frames = M.frameRange(20, 24, clip('dock-right'));
      return has('dock-right') && frames.length >= 3 ? { sheet: 'dock-right', list: each(frames, 110), loop: false, base: true } : { img: 'idle', base: true };
    }
    // 待机：有小动作序列的角色就停在序列第 0 帧，小动作从这一帧起、演完回到这一帧，接缝处画面一致。
    return has('idle-life') && clip('idle-life').indexOf(0) < 0 ? { sheet: 'idle-life', list: [{ f: 0, ms: 1 }], loop: false, base: true } : { img: 'idle', base: true };
  }
  const isBase = p => !!(visual && visual.spec.base && visual.key === specKey(baseSpec(p)));

  // 伸懒腰：播到峰值停 420ms 再收势（WorkMate：小猫峰值第 16 帧、17→18 收；企鹅峰值第 8 帧、7→3 收）。
  function stretchSpec() {
    const cat = state.role === '01-cat';
    const peak = cat ? 16 : 8;
    const up = M.frameRange(0, peak, clip('stretch'));
    const down = cat ? M.frameRange(17, 18, clip('stretch')) : M.frameRange(7, 3, clip('stretch'));
    if (!has('stretch') || up.length < 5) return null;
    const list = each(up, 115);
    list[list.length - 1] = { f: up[up.length - 1], ms: 115 + 420 };
    return { sheet: 'stretch', list: list.concat(each(down, 115)), loop: false, restart: true, then: () => baseSpec(pose), thenTransition: 'pop' };
  }

  function wakeUpThen(nextPose) {
    const stretch = stretchSpec();
    if (stretch) { show(stretch); return; }
    show(baseSpec(nextPose));
    script = { start: now(), dur: 1400, fn: t => { const k = Math.sin(Math.PI * t); return { sy: 1 + 0.05 * k, sx: 1 - 0.03 * k, rot: 0, y: -2 * k }; } };
    hops.push({ start: now() + 1250, dur: 380, height: 7 });
  }

  // 犯困 → 惊醒 → 深垂 → 睡着（借鉴 WorkMate 的 NodOffDirector：2.4s / 0.5s / 1.8s）。
  function nodOff() {
    script = {
      start: now(), dur: 4700,
      fn: t => {
        const s = t * 4.7;
        if (s < 2.4) return { rot: 2 + 2 * Math.sin(Math.PI * 2 * s / 1.2), y: 2, sx: 1, sy: 1 };
        if (s < 2.9) { const k = M.easeOutCubic((s - 2.4) / 0.5); return { rot: 4 - 6 * k, y: 2 - 5 * k, sx: 1, sy: 1 + 0.015 * k }; }
        const k = M.easeInOut((s - 2.9) / 1.8);
        return { rot: -2 + 8 * k, y: -3 + 7 * k, sx: 1, sy: 1.015 - 0.035 * k };
      },
      done: () => { if (pose === 'sleep') show({ img: 'sleep', base: true }); },
    };
  }

  function applyPose(next, first) {
    const prev = pose;
    pose = next;
    if (first) { show(baseSpec(next), { transition: 'cut' }); scheduleIdle(); return; }
    if (prev === next) return;
    script = null;
    if (next === 'sleep') { show(baseSpec('idle')); nodOff(); return; }
    if (prev === 'sleep') { wakeUpThen(next); return; }
    if (prev === 'peek' && visual && visual.spec.sheet === 'dock-right') {
      const back = visual.spec.list.map(x => x.f).reverse();
      show({ sheet: 'dock-right', list: each(back, 110), loop: false, restart: true, then: () => baseSpec(pose), thenTransition: 'pop' }, { transition: 'cut' });
      return;
    }
    show(baseSpec(next));
    // 开口时跳两下就安静下来（原来每 2.6 秒跳一次，看久了晃眼）。
    if (next === 'happy') hops.push({ start: now() + 80, dur: 420, height: 14 }, { start: now() + 600, dur: 360, height: 8 });
    scheduleIdle();
  }

  function scheduleIdle() {
    const t = now();
    nextGestureAt = t + rand(28000, 45000);
    if (!nextRareAt) nextRareAt = t + rand(240000, 420000);
    nextYawnAt = t + rand(9000, 16000);
  }

  // 待机时偶尔换个姿势：猫和企鹅从小动作序列里挑一段没被裁切的 5 帧，演完倒放回来；其他角色用连续变换演。
  function idleGesture(t) {
    if (t >= nextRareAt && nextRareAt) {
      nextRareAt = t + rand(240000, 420000);
      const stretch = stretchSpec();
      if (stretch) { show(stretch, { transition: 'cut' }); return; }
      script = { start: t, dur: 1600, fn: s => { const k = Math.sin(Math.PI * s); return { sy: 1 + 0.05 * k, sx: 1 - 0.03 * k, rot: 0, y: -2 * k }; } };
      return;
    }
    if (has('idle-life')) {
      const options = [0, 5, 10, 15, 20].map(start => M.gesturePlaylist(start, 5, clip('idle-life'))).filter(Boolean);
      if (options.length) {
        const list = options[Math.floor(Math.random() * options.length)];
        show({ sheet: 'idle-life', list: list.concat([{ f: 0, ms: 1 }]), loop: false, restart: true, then: () => baseSpec(pose) }, { transition: 'cut' });
        return;
      }
    }
    const pick = Math.floor(Math.random() * 3);
    if (pick === 0) { const dir = Math.random() < 0.5 ? -1 : 1; script = { start: t, dur: 2400, fn: s => ({ rot: dir * 4 * Math.sin(Math.PI * s), y: 0, sx: 1, sy: 1 }) }; }
    else if (pick === 1) hops.push({ start: t, dur: 360, height: 7 });
    else script = { start: t, dur: 900, fn: s => { const k = Math.sin(Math.PI * 2 * s) * (1 - s); return { rot: 0, y: 0, sx: 1 + 0.03 * k, sy: 1 - 0.03 * k }; } };
  }

  // ---------- 每帧 ----------
  function frame() {
    raf = 0;
    const t = now();
    const dt = Math.min(100, lastFrame ? t - lastFrame : 16);
    lastFrame = t;
    let busy = renderVisual(t);

    arousal = M.approach(arousal, AROUSAL[pose] ?? 0.25, dt, 500);
    const br = M.breathStep(phase, dt / 1000, arousal);
    phase = br.phase;
    let sx = br.sx, sy = br.sy, rot = 0, y = 0, x = 0;

    // 换姿态：先压 80ms，压到底时换图，再弹起来
    if (pendingSwap) {
      const k = (t - pendingSwap.start) / POP_MS;
      if (k >= 1) { const spec = pendingSwap.spec; pendingSwap = null; applyVisual(spec); squash = { start: t, power: -0.035 }; }
      else { const e = M.easeInOut(k); sy *= 1 - 0.04 * e; sx *= 1 + 0.025 * e; }
      busy = true;
    }

    // 姿态自带的身形
    if (pose === 'tired') {
      rot += 2.5; y += 2; sy *= 0.98;
      if (t >= nextYawnAt) { script = script || { start: t, dur: 1400, fn: s => ({ rot: -1.5 * Math.sin(Math.PI * s), y: 0, sx: 1, sy: 1 + 0.035 * Math.sin(Math.PI * s) }) }; nextYawnAt = t + rand(12000, 20000); }
    } else if (pose === 'peek' && !(visual && visual.spec.sheet === 'dock-right')) {
      rot -= 6;
    } else if (pose === 'typing' && !(visual && visual.spec.sheet === 'typing')) {
      // 没有打字序列的角色：轻轻点头，1.6 次/秒（原来 3.2 次/秒加左右摆，看久了晃眼）
      y -= 1.2 * Math.abs(Math.sin(Math.PI * 1.6 * t / 1000));
    } else if (pose === 'idle' && !script && !pendingSwap && isBase('idle') && t >= nextGestureAt) {
      nextGestureAt = t + rand(28000, 45000);
      idleGesture(t);
    }

    if (script) {
      const s = Math.min(1, (t - script.start) / script.dur);
      const v = script.fn(s);
      rot += v.rot || 0; y += v.y || 0; sx *= v.sx || 1; sy *= v.sy || 1;
      busy = true;
      if (s >= 1) { const done = script.done; script = null; if (done) done(); }
    }

    // 跳：落地时接一个挤压回弹
    let height = 0;
    for (let i = hops.length - 1; i >= 0; i--) {
      const h = hops[i];
      const ht = t - h.start;
      if (ht < 0) { busy = true; continue; }
      if (ht > h.dur) { hops.splice(i, 1); squash = { start: t, power: 0.04 + h.height / 260 }; continue; }
      height += M.hopAt(ht / 1000, h.dur / 1000, h.height);
      busy = true;
    }
    y -= height;

    if (squash) {
      const q = M.squashAt((t - squash.start) / 1000, squash.power);
      if (t - squash.start > 1200) squash = null; else busy = true;
      sy *= 1 + q; sx *= 1 - 0.6 * q;
    }

    // 拖动：被拎起来放大一点，向移动方向倾斜，速度越快拉得越长；松手后弹回（幅度比原来收一些，不显得软塌塌）
    lift = M.approach(lift, lifted ? 1 : 0, dt, 70);
    const speed = Math.hypot(drag.vx, drag.vy);
    lean = M.approach(lean, M.clamp(drag.vx * 0.008, -9, 9), dt, 70);
    stretch = M.approach(stretch, M.clamp(speed / 4000, 0, 0.05), dt, 70);
    if (!lifted) { drag.vx = M.approach(drag.vx, 0, dt, 50); drag.vy = M.approach(drag.vy, 0, dt, 50); }
    if (lift > 0.002 || Math.abs(lean) > 0.05 || stretch > 0.002) busy = true;
    rot += lean;
    sy *= 1 + stretch; sx *= 1 - 0.5 * stretch;
    const ls = 1 + 0.04 * lift;
    sx *= ls; sy *= ls;
    y -= 6 * lift;

    bodyEl.style.transform = 'translate(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px) rotate(' + rot.toFixed(2) + 'deg) scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
    const air = M.clamp((height + 6 * lift) / 24, 0, 1);
    shadowEl.style.transform = 'scale(' + (1 - 0.35 * air).toFixed(3) + ',' + (1 - 0.3 * air).toFixed(3) + ')';
    shadowEl.style.opacity = (pose === 'peek' ? 0 : 1 - 0.5 * air).toFixed(3);

    schedule(busy);
  }

  function schedule(busy) {
    if (raf || timer || document.visibilityState === 'hidden') return;
    if (busy) { raf = requestAnimationFrame(frame); return; }
    const fps = CALM_FPS[pose] || 20;
    timer = setTimeout(() => { timer = 0; if (document.visibilityState !== 'hidden') raf = requestAnimationFrame(frame); }, 1000 / fps);
  }

  function wake() {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (!raf && document.visibilityState !== 'hidden') raf = requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      raf = 0; timer = 0;
    } else { lastFrame = 0; wake(); }
  });

  // ---------- 气泡、小圆点、展开面板 ----------
  // 提醒类别的短名（和助理页「今天的提醒」一致），气泡和展开面板里当小标签用，一眼知道是哪类事。
  const KIND = { brief: '简报', 'meeting-prep': '会前准备', 'awaiting-reply': '等你回复', 'commitment-due': '答应的事', overbooked: '会议太满', 'day-summary': '下班小结', keyword: '关注词' };
  const bubbleKind = $('bubble-kind');
  function showBubble(b) {
    if (b && b.id !== bubbleId) {
      bubbleId = b.id;
      bubbleText.textContent = b.title;
      bubbleKind.textContent = KIND[b.kind] || '';
      bubbleKind.hidden = !KIND[b.kind];
      bubbleEl.hidden = false;
      bubbleEl.classList.remove('out');
      bubbleEl.classList.remove('in');
      void bubbleEl.offsetWidth;
      bubbleEl.classList.add('in');
    } else if (!b && bubbleId) {
      bubbleId = '';
      bubbleEl.classList.remove('in');
      bubbleEl.classList.add('out');
      setTimeout(() => { if (!bubbleId) { bubbleEl.hidden = true; bubbleEl.classList.remove('out'); } }, 340);
    }
  }

  function showDots(n) {
    dotEl.hidden = !(n > 0);
    dotEl.textContent = n > 9 ? '9+' : String(n || '');
    if (n > lastDots) { dotEl.classList.remove('bump'); void dotEl.offsetWidth; dotEl.classList.add('bump'); }
    lastDots = n;
  }

  function showPanel(items) {
    panelList.textContent = '';
    $('panel-count').textContent = (items || []).length > 1 ? (items || []).length + ' 条' : '';
    for (const item of items || []) {
      const row = document.createElement('div');
      row.className = 'panel-item';
      if (KIND[item.kind]) { const k = document.createElement('span'); k.className = 'kind'; k.textContent = KIND[item.kind]; row.appendChild(k); }
      const title = document.createElement('b');
      title.textContent = item.title || '';
      row.appendChild(title);
      if (item.text) { const p = document.createElement('p'); p.textContent = item.text; row.appendChild(p); }
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      open.textContent = '在助理里打开 ›';
      open.addEventListener('click', () => { api.openNotice(item); hidePanel(); });
      row.appendChild(open);
      panelList.appendChild(row);
    }
    bubbleEl.hidden = true;
    bubbleId = '';
    panelEl.hidden = false;
  }
  function hidePanel() { panelEl.hidden = true; setHit(false); }
  $('panel-close').addEventListener('click', hidePanel);

  // ---------- 鼠标：透明处点穿，身体、气泡、圆点、面板上才接住 ----------
  function setHit(v) { if (v !== hitNow) { hitNow = v; api.hit(v); } }
  function hitTarget(x, y) {
    const el = document.elementFromPoint(x, y);
    const node = el && el.closest('[data-hit]');
    if (!node) return null;
    const kind = node.getAttribute('data-hit');
    if (kind !== 'pet') return kind;
    // 身体的方框四角大多是透明的，只认中间一块
    const r = bodyEl.getBoundingClientRect();
    const ix = r.width * 0.16, iy = r.height * 0.12;
    return x > r.left + ix && x < r.right - ix && y > r.top + iy && y < r.bottom - 4 ? 'pet' : null;
  }
  document.addEventListener('mousemove', e => { if (!pressing) setHit(!!hitTarget(e.clientX, e.clientY)); });
  document.addEventListener('mouseleave', () => { if (!pressing) setHit(false); });
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const target = hitTarget(e.clientX, e.clientY);
    if (!target || target === 'panel') return;
    pressing = true;
    try { document.documentElement.setPointerCapture(e.pointerId); } catch (_) {}
    api.press(target);
  });
  const endPress = () => { if (!pressing) return; pressing = false; bodyEl.classList.remove('dragging'); api.release(); };
  document.addEventListener('pointerup', endPress);
  document.addEventListener('lostpointercapture', endPress);
  document.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (hitTarget(e.clientX, e.clientY) === 'pet') api.menu();
  });

  // ---------- 主进程消息 ----------
  api.onState(next => {
    const roleChanged = next.role !== state.role;
    const prevDock = state.dock;
    state = { ...state, ...next };
    if (prevDock !== state.dock || roleChanged) {
      document.body.classList.toggle('dock-right', state.dock === 'right');
      document.body.classList.toggle('dock-left', state.dock === 'left');
    }
    if (roleChanged) {
      preloadRole();
      const first = !pose;
      if (first) applyPose(state.pose, true);
      else { pose = state.pose; show(baseSpec(state.pose), { transition: 'pop' }); hops.push({ start: now() + 80, dur: 360, height: 10 }); }
    } else applyPose(state.pose, false);
    showBubble(state.bubble);
    showDots(state.dots);
    wake();
  });
  api.onMotion(m => {
    if (!m) return;
    if (m.phase === 'lift') { lifted = true; bodyEl.classList.add('dragging'); script = null; }
    else if (m.phase === 'drag') { drag.vx = M.approach(drag.vx, m.vx || 0, 16, 30); drag.vy = M.approach(drag.vy, m.vy || 0, 16, 30); }
    else if (m.phase === 'release') { lifted = false; bodyEl.classList.remove('dragging'); }
    else if (m.phase === 'land') squash = { start: now(), power: 0.06 + 0.1 * M.clamp(m.impact || 0, 0, 1) };
    else if (m.phase === 'poke') { squash = { start: now(), power: 0.07 }; }
    wake();
  });
  api.onPanel(p => { showPanel(p && p.items); wake(); });

  window.__hubPetDebug = () => ({ pose, layers: visual ? [visual.key] : [], opacities: visual ? [1] : [], domLayers: layersEl.children.length, frame: visual ? visual.shown : -1, swapping: !!pendingSwap, fps: raf ? 'raf' : timer ? 'timer' : 'stopped', bubble: bubbleId, dots: lastDots, transform: bodyEl.style.transform });
  api.ready();
})();
