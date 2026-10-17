'use strict';
// 助理桌宠的渲染端：所有动作都是「连续变换 + 按时间插值的帧序列」，由一个按需降频的 rAF 循环驱动。
// - 有动作（拖动、跳、回弹、姿态交叉淡入、播放序列）时每帧刷新；只剩呼吸时降到 20 帧/秒，打盹 12 帧/秒；
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
  const FADE_MS = 220;

  let state = { pose: 'idle', role: '', sequences: [], bubble: null, dots: 0, dock: null, peeking: false };
  let pose = null;
  let layers = [];
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
  const asset = name => '../assets/hub-pet/' + state.role + '/' + name + '.webp';
  const sheetAsset = name => asset('seq-' + name);

  // ---------- 图层：交叉淡入 + 序列插值 ----------
  function specKey(spec) { return spec.img ? 'img:' + spec.img : 'seq:' + spec.sheet + ':' + spec.seq.from + '-' + spec.seq.to + (spec.seq.loop ? 'L' : ''); }

  function makeLayer(spec) {
    const el = document.createElement('div');
    el.className = 'layer';
    const a = document.createElement('div');
    const b = document.createElement('div');
    a.className = 'cel' + (spec.sheet ? ' sheet' : '');
    b.className = 'cel next' + (spec.sheet ? ' sheet' : '');
    const url = 'url("' + (spec.sheet ? sheetAsset(spec.sheet) : asset(spec.img)) + '")';
    a.style.backgroundImage = url;
    if (spec.sheet) b.style.backgroundImage = url;
    el.appendChild(a); el.appendChild(b);
    el.style.opacity = '0';
    layersEl.appendChild(el);
    return { el, a, b, spec, key: specKey(spec), role: state.role, start: now(), fadeStart: now(), shownA: -1, shownB: -1, mix: -1, opacity: 0 };
  }

  function setVisual(spec, { instant = false } = {}) {
    const top = layers[layers.length - 1];
    if (top && top.key === specKey(spec) && top.role === state.role && !spec.restart) return;
    const layer = makeLayer(spec);
    if (instant || !top) { layer.fadeStart = now() - FADE_MS; }
    layers.push(layer);
    wake();
  }

  function renderLayers(t) {
    const top = layers[layers.length - 1];
    if (!top) return false;
    let busy = false;
    let then = null;
    const p = Math.min(1, (t - top.fadeStart) / FADE_MS);
    if (p < 1) busy = true;
    const topOpacity = M.easeInOut(p);
    // 新图层淡入的同时旧图层晚一点淡出：两层都半透明的瞬间不会露出底下的桌面。
    const oldOpacity = 1 - M.easeInOut((p - 0.35) / 0.65);
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      const o = L === top ? topOpacity : oldOpacity;
      if (Math.abs(o - L.opacity) > 0.002) { L.opacity = o; L.el.style.opacity = o.toFixed(3); }
      if (L.spec.sheet) {
        const f = M.sequenceFrame(t - L.start, L.spec.seq);
        if (f.a !== L.shownA) { L.shownA = f.a; L.a.style.backgroundPosition = M.sheetPosition(f.a); }
        if (f.b !== L.shownB) { L.shownB = f.b; L.b.style.backgroundPosition = M.sheetPosition(f.b); }
        const mix = Math.round(f.mix * 100) / 100;
        if (mix !== L.mix) { L.mix = mix; L.b.style.opacity = String(mix); }
        if (L === top && !L.spec.seq.loop) {
          if (!f.done) busy = true;
          else if (L.spec.then && !L.thenFired) { L.thenFired = true; then = L.spec.then; }
        }
      }
    }
    if (p >= 1 && layers.length > 1) {
      for (const L of layers.slice(0, -1)) L.el.remove();
      layers = [top];
    }
    // 序列播完后接下一个画面：放在清理之后再加图层，避免新图层被当成旧图层漏删（会留下一只半透明的重影）。
    if (then) { const next = typeof then === 'function' ? then() : then; if (next) { setVisual(next); busy = true; } }
    return busy;
  }

  // ---------- 姿态 → 怎么演 ----------
  function baseSpec(p) {
    if (p === 'typing') return has('typing') ? { sheet: 'typing', seq: { from: 0, to: 24, fps: 12, loop: true } } : { img: 'typing' };
    if (p === 'happy') return { img: 'happy' };
    if (p === 'sleep') return { img: 'sleep' };
    if (p === 'peek') return has('dock-right') ? { sheet: 'dock-right', seq: { from: 20, to: 24, fps: 9, loop: false } } : { img: 'idle' };
    return { img: 'idle' };
  }

  function wakeUpThen(nextPose) {
    if (has('stretch')) {
      setVisual({ sheet: 'stretch', seq: { from: 0, to: 24, fps: 15, loop: false }, then: () => baseSpec(pose) });
      return;
    }
    setVisual(baseSpec(nextPose));
    script = { start: now(), dur: 1400, fn: t => { const k = Math.sin(Math.PI * t); return { sy: 1 + 0.07 * k, sx: 1 - 0.04 * k, rot: 0, y: -2 * k }; } };
    hops.push({ start: now() + 1250, dur: 380, height: 8 });
  }

  // 犯困 → 惊醒 → 深垂 → 睡着（借鉴 WorkMate 的 NodOffDirector：2.4s / 0.5s / 1.8s）。
  function nodOff() {
    script = {
      start: now(), dur: 4700,
      fn: t => {
        const s = t * 4.7;
        if (s < 2.4) return { rot: 3 + 3 * Math.sin(Math.PI * 2 * s / 1.2), y: 2, sx: 1, sy: 1 };
        if (s < 2.9) { const k = M.easeOutCubic((s - 2.4) / 0.5); return { rot: 6 - 9 * k, y: 2 - 6 * k, sx: 1, sy: 1 + 0.02 * k }; }
        const k = M.easeInOut((s - 2.9) / 1.8);
        return { rot: -3 + 12 * k, y: -4 + 9 * k, sx: 1, sy: 1.02 - 0.05 * k };
      },
      done: () => { if (pose === 'sleep') setVisual({ img: 'sleep' }); },
    };
  }

  function applyPose(next, first) {
    const prev = pose;
    pose = next;
    if (first) { setVisual(baseSpec(next), { instant: true }); scheduleIdle(); return; }
    if (prev === next) return;
    script = null;
    if (next === 'sleep') { setVisual({ img: 'idle' }); nodOff(); return; }
    if (prev === 'sleep') { wakeUpThen(next); return; }
    if (prev === 'peek' && has('dock-right')) {
      setVisual({ sheet: 'dock-right', seq: { from: 24, to: 20, fps: 12, loop: false }, then: () => baseSpec(pose) });
      return;
    }
    setVisual(baseSpec(next));
    if (next === 'happy') { hops.push({ start: now(), dur: 420, height: 18 }, { start: now() + 520, dur: 380, height: 12 }); nextHappyHopAt = now() + 2600; }
    scheduleIdle();
  }

  function scheduleIdle() {
    const t = now();
    nextGestureAt = t + rand(28000, 45000);
    if (!nextRareAt) nextRareAt = t + rand(240000, 420000);
    nextYawnAt = t + rand(9000, 16000);
  }

  // 待机时偶尔换个姿势：猫和企鹅播 WorkMate 的生活小动作序列，其他角色用连续变换演。
  function idleGesture(t) {
    if (t >= nextRareAt && nextRareAt) {
      nextRareAt = t + rand(240000, 420000);
      if (has('stretch')) { setVisual({ sheet: 'stretch', seq: { from: 0, to: 24, fps: 14, loop: false }, then: () => baseSpec(pose) }); return; }
      script = { start: t, dur: 1600, fn: s => { const k = Math.sin(Math.PI * s); return { sy: 1 + 0.08 * k, sx: 1 - 0.05 * k, rot: 0, y: -2 * k }; } };
      return;
    }
    if (has('idle-life') && Math.random() < 0.7) {
      setVisual({ sheet: 'idle-life', seq: { from: 0, to: 24, fps: 10, loop: false }, then: () => baseSpec(pose), restart: true });
      return;
    }
    const pick = Math.floor(Math.random() * 3);
    if (pick === 0) { const dir = Math.random() < 0.5 ? -1 : 1; script = { start: t, dur: 2200, fn: s => ({ rot: dir * 6 * Math.sin(Math.PI * s), y: 0, sx: 1, sy: 1 }) }; }
    else if (pick === 1) hops.push({ start: t, dur: 360, height: 9 });
    else script = { start: t, dur: 900, fn: s => { const k = Math.sin(Math.PI * 2 * s) * (1 - s); return { rot: 0, y: 0, sx: 1 + 0.04 * k, sy: 1 - 0.04 * k }; } };
  }

  // ---------- 每帧 ----------
  function frame() {
    raf = 0;
    const t = now();
    const dt = Math.min(100, lastFrame ? t - lastFrame : 16);
    lastFrame = t;
    let busy = renderLayers(t);

    arousal = M.approach(arousal, AROUSAL[pose] ?? 0.25, dt, 500);
    const br = M.breathStep(phase, dt / 1000, arousal);
    phase = br.phase;
    let sx = br.sx, sy = br.sy, rot = 0, y = 0, x = 0;

    // 姿态自带的身形
    if (pose === 'tired') {
      rot += 3.5; y += 3; sy *= 0.975;
      if (t >= nextYawnAt) { script = script || { start: t, dur: 1400, fn: s => ({ rot: -2 * Math.sin(Math.PI * s), y: 0, sx: 1, sy: 1 + 0.045 * Math.sin(Math.PI * s) }) }; nextYawnAt = t + rand(12000, 20000); }
    } else if (pose === 'peek' && !has('dock-right')) {
      rot -= 7;
    } else if (pose === 'typing' && !has('typing')) {
      y -= 1.6 * Math.abs(Math.sin(Math.PI * 2 * 3.2 * t / 1000));
      rot += 1.2 * Math.sin(Math.PI * 2 * 1.6 * t / 1000);
    } else if (pose === 'happy' && t >= nextHappyHopAt && !hops.length) {
      hops.push({ start: t, dur: 380, height: 10 });
      nextHappyHopAt = t + 2600;
    } else if (pose === 'idle' && !script && layers.length === 1 && !layers[0].spec.sheet && t >= nextGestureAt) {
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
      if (ht > h.dur) { hops.splice(i, 1); squash = { start: t, power: 0.05 + h.height / 220 }; continue; }
      height += M.hopAt(ht / 1000, h.dur / 1000, h.height);
      busy = true;
    }
    y -= height;

    if (squash) {
      const q = M.squashAt((t - squash.start) / 1000, squash.power);
      if (t - squash.start > 1200) squash = null; else busy = true;
      sy *= 1 + q; sx *= 1 - 0.6 * q;
    }

    // 拖动：被拎起来放大一点，向移动方向倾斜，速度越快拉得越长；松手后弹回
    lift = M.approach(lift, lifted ? 1 : 0, dt, 70);
    const speed = Math.hypot(drag.vx, drag.vy);
    lean = M.approach(lean, M.clamp(drag.vx * 0.012, -14, 14), dt, 60);
    stretch = M.approach(stretch, M.clamp(speed / 3200, 0, 0.1), dt, 60);
    if (!lifted) { drag.vx = M.approach(drag.vx, 0, dt, 50); drag.vy = M.approach(drag.vy, 0, dt, 50); }
    if (lift > 0.002 || Math.abs(lean) > 0.05 || stretch > 0.002) busy = true;
    rot += lean;
    sy *= 1 + stretch; sx *= 1 - 0.5 * stretch;
    const ls = 1 + 0.05 * lift;
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
  function showBubble(b) {
    if (b && b.id !== bubbleId) {
      bubbleId = b.id;
      bubbleText.textContent = b.title;
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
    for (const item of items || []) {
      const row = document.createElement('div');
      row.className = 'panel-item';
      const title = document.createElement('b');
      title.textContent = item.title || '';
      row.appendChild(title);
      if (item.text) { const p = document.createElement('p'); p.textContent = item.text; row.appendChild(p); }
      const open = document.createElement('button');
      open.type = 'button';
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
      const first = !pose;
      if (first) applyPose(state.pose, true);
      else { pose = state.pose; setVisual(baseSpec(state.pose)); hops.push({ start: now(), dur: 360, height: 10 }); }
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

  window.__hubPetDebug = () => ({ pose, layers: layers.map(l => l.key), opacities: layers.map(l => +l.opacity.toFixed(2)), domLayers: layersEl.children.length, fps: raf ? 'raf' : timer ? 'timer' : 'stopped', bubble: bubbleId, dots: lastDots, transform: bodyEl.style.transform });
  api.ready();
})();
