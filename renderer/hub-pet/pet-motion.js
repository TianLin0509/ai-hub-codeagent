'use strict';
// 桌宠动画用到的数学（渲染端与单测共用）。参数借鉴 WorkMate 的 PetMotion，按 Hub 的帧调度重新整理：
// 呼吸频率 0.18+0.6·兴奋度 Hz，幅度 1.1%+1.0%·兴奋度，横向反向收缩一半多（体积守恒的感觉）；
// 落地回弹是衰减正弦 −p·e^(−3.5t)·sin(2π·2.2t)，1.2 秒内收完。
// 帧序列（2026-10-17 改）：按「播放单」逐帧硬切，不再把相邻两帧按小数部分叠加淡入——两张不同的画半透明叠在一起
// 就是用户说的「残影」。片段的选法借鉴 WorkMate 的 AnimationPolicy：小动作只播 5 帧、停一下再倒放回来，
// 打字只循环第一行身体不动的 5 帧，伸懒腰播到峰值停 420ms 再收势；被裁切的帧（manifest.clipped）不进播放单。
(function (root) {
  const TAU = Math.PI * 2;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function easeInOut(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function easeOutCubic(t) { t = clamp(t, 0, 1); const u = 1 - t; return 1 - u * u * u; }
  function easeOutBack(t) { t = clamp(t, 0, 1); const c = 1.6; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; }

  // 呼吸：返回 { sx, sy, phase }。phase 连续累积，兴奋度变化时频率平滑过渡、不会跳相位。
  function breathStep(phase, dtSec, arousal) {
    const a = clamp(arousal, 0, 1);
    const hz = 0.18 + 0.6 * a;
    const amp = 0.011 + 0.010 * a;
    const next = (phase + TAU * hz * dtSec) % (TAU * 1000);
    const sy = 1 + amp * Math.sin(next);
    return { phase: next, sy, sx: 1 - 0.55 * (sy - 1) };
  }

  // 落地挤压：t 秒后的竖向形变量（正数是拉高，负数是压扁）。
  function squashAt(t, power) {
    if (!(t >= 0) || t > 1.2) return 0;
    return -power * Math.exp(-3.5 * t) * Math.sin(TAU * 2.2 * t);
  }

  // 跳一下：t∈[0,dur] 的高度（向上为正）与落地瞬间标记。
  function hopAt(t, dur, height) {
    if (!(t >= 0) || t > dur) return 0;
    return height * Math.sin(Math.PI * t / dur);
  }

  // 指数逼近：半衰期 halfLifeMs 内走完剩余距离的一半，帧率高低都一样快。
  function approach(current, target, dtMs, halfLifeMs) {
    if (halfLifeMs <= 0) return target;
    return target + (current - target) * Math.pow(0.5, dtMs / halfLifeMs);
  }

  // 播放单：[{ f: 帧号, ms: 停留毫秒 }]。返回 elapsed 时刻该显示哪一帧；loop 时循环，否则停在最后一帧并标 done。
  function playlistFrame(elapsedMs, list, loop) {
    if (!list || !list.length) return { f: 0, index: 0, done: true };
    const total = list.reduce((n, x) => n + x.ms, 0);
    let t = Math.max(0, elapsedMs);
    if (loop && total > 0) t %= total;
    else if (t >= total) return { f: list[list.length - 1].f, index: list.length - 1, done: true };
    for (let i = 0; i < list.length; i++) {
      if (t < list[i].ms) return { f: list[i].f, index: i, done: false };
      t -= list[i].ms;
    }
    return { f: list[list.length - 1].f, index: list.length - 1, done: !loop };
  }

  // 从 from 到 to（含两端，可倒序）的帧号，跳过被裁切的帧。
  function frameRange(from, to, clipped = []) {
    const out = [];
    const dir = to >= from ? 1 : -1;
    for (let f = from; dir > 0 ? f <= to : f >= to; f += dir) if (clipped.indexOf(f) < 0) out.push(f);
    return out;
  }

  // 小动作：start 起往后 len 帧，最后一帧停 holdMs，再倒放回 start（WorkMate：175ms/帧，停 220ms）。
  // 片段里有被裁切的帧就整段不用，返回 null。
  function gesturePlaylist(start, len, clipped = [], msPerFrame = 175, holdMs = 220) {
    const fwd = frameRange(start, start + len - 1, []);
    if (fwd.some(f => clipped.indexOf(f) >= 0)) return null;
    const list = fwd.map(f => ({ f, ms: msPerFrame }));
    list[list.length - 1] = { f: fwd[fwd.length - 1], ms: msPerFrame + holdMs };
    for (let i = fwd.length - 2; i >= 0; i--) list.push({ f: fwd[i], ms: msPerFrame });
    return list;
  }

  // 来回循环：0,1,2,3,4,3,2,1（打字时只有爪子动，身体不跳）。
  function pingPong(frames, msPerFrame) {
    const list = frames.map(f => ({ f, ms: msPerFrame }));
    for (let i = frames.length - 2; i >= 1; i--) list.push({ f: frames[i], ms: msPerFrame });
    return list;
  }

  // 5×5 序列图里第 n 帧的 background-position（百分比）。
  function sheetPosition(n) {
    const col = n % 5;
    const row = Math.floor(n / 5);
    return (col * 25) + '% ' + (row * 25) + '%';
  }

  const api = { approach, breathStep, clamp, easeInOut, easeOutBack, easeOutCubic, frameRange, gesturePlaylist, hopAt, pingPong, playlistFrame, sheetPosition, squashAt };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HubPetMotion = api;
})(typeof window !== 'undefined' ? window : globalThis);
