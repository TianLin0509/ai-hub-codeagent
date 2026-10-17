'use strict';
// 桌宠动画用到的数学（渲染端与单测共用）。参数借鉴 WorkMate 的 PetMotion，按 Hub 的帧调度重新整理：
// 呼吸频率 0.18+0.6·兴奋度 Hz，幅度 1.1%+1.0%·兴奋度，横向反向收缩一半多（体积守恒的感觉）；
// 落地回弹是衰减正弦 −p·e^(−3.5t)·sin(2π·2.2t)，1.2 秒内收完；帧序列按时间插值，相邻两帧按小数部分叠加淡入。
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

  // 帧序列按时间取帧：from→to（含），fps 帧/秒；loop 时循环，否则停在最后一帧。
  // 返回 { a, b, mix, done }：画 a，再把 b 以 mix 的不透明度叠在上面。
  function sequenceFrame(elapsedMs, seq) {
    const count = Math.abs(seq.to - seq.from) + 1;
    const dir = seq.to >= seq.from ? 1 : -1;
    let pos = Math.max(0, elapsedMs) / 1000 * seq.fps;
    let done = false;
    if (seq.loop) pos = pos % count;
    else if (pos >= count - 1) { pos = count - 1; done = true; }
    const i = Math.floor(pos);
    const mix = done ? 0 : pos - i;
    const j = seq.loop ? (i + 1) % count : Math.min(count - 1, i + 1);
    return { a: seq.from + dir * i, b: seq.from + dir * j, mix, done };
  }

  // 5×5 序列图里第 n 帧的 background-position（百分比）。
  function sheetPosition(n) {
    const col = n % 5;
    const row = Math.floor(n / 5);
    return (col * 25) + '% ' + (row * 25) + '%';
  }

  const api = { approach, breathStep, clamp, easeInOut, easeOutBack, easeOutCubic, hopAt, sequenceFrame, sheetPosition, squashAt };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HubPetMotion = api;
})(typeof window !== 'undefined' ? window : globalThis);
