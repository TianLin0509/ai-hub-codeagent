'use strict';
// 桌宠窗口的移动规划（主进程用）。借鉴 WorkMate 的 DragInertia / EdgeBehavior：
// 只看松手前最后 180ms 的速度；慢于 260 DIP/s 不滑；滑行距离 12+(v-260)*0.035，最多 52 DIP；
// 滑行 120–210ms，cubic-out 缓动；停下后离屏幕左右边或底边 28 DIP 以内就贴过去（190ms）。
// 「宠物身体」只占窗口中间一块，贴边按身体算，窗口两侧透明的部分可以伸出屏幕。

const SAMPLE_WINDOW_MS = 180;
const MIN_SPEED = 260;
const MAX_SLIDE = 52;
const SNAP_DISTANCE = 28;
const SNAP_MS = 190;

function cubicOut(t) { const u = 1 - Math.min(1, Math.max(0, t)); return 1 - u * u * u; }

// samples：[{ t, x, y }]（窗口左上角，DIP），按时间顺序。
function releaseVelocity(samples = []) {
  if (samples.length < 2) return { vx: 0, vy: 0, speed: 0 };
  const last = samples[samples.length - 1];
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > SAMPLE_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = Math.max(1, last.t - first.t) / 1000;
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  return { vx, vy, speed: Math.hypot(vx, vy) };
}

// 身体在屏幕上可活动的窗口左上角范围。inset：身体相对窗口的边距 { left, right, top, bottom }。
function allowedRange(area, size, inset) {
  return {
    minX: area.x - inset.left,
    maxX: area.x + area.width - size.width + inset.right,
    minY: area.y,
    maxY: area.y + area.height - size.height + inset.bottom,
  };
}

function clampTo(range, x, y) {
  return { x: Math.round(Math.min(range.maxX, Math.max(range.minX, x))), y: Math.round(Math.min(range.maxY, Math.max(range.minY, y))) };
}

// 松手后的完整计划：先惯性滑行（可能为空），再贴边（可能为空）。
function releasePlan({ samples, position, area, size, inset }) {
  const range = allowedRange(area, size, inset);
  const { vx, vy, speed } = releaseVelocity(samples);
  const steps = [];
  let at = clampTo(range, position.x, position.y);
  if (speed >= MIN_SPEED) {
    const dist = Math.min(MAX_SLIDE, 12 + (speed - MIN_SPEED) * 0.035);
    const to = clampTo(range, at.x + (vx / speed) * dist, at.y + (vy / speed) * dist);
    const durationMs = Math.round(Math.min(210, Math.max(120, 120 + (speed - MIN_SPEED) * 0.05)));
    if (to.x !== at.x || to.y !== at.y) { steps.push({ kind: 'slide', from: at, to, durationMs }); at = to; }
  }
  let dock = null;
  const snap = { x: at.x, y: at.y };
  if (at.x - range.minX <= SNAP_DISTANCE) { snap.x = range.minX; dock = 'left'; }
  else if (range.maxX - at.x <= SNAP_DISTANCE) { snap.x = range.maxX; dock = 'right'; }
  if (range.maxY - at.y <= SNAP_DISTANCE) snap.y = range.maxY;
  if (snap.x !== at.x || snap.y !== at.y) { steps.push({ kind: 'snap', from: at, to: snap, durationMs: SNAP_MS }); at = snap; }
  return { steps, final: at, dock, speed, vx, vy };
}

// 判断某个位置贴在哪条边（启动恢复位置、躲边后回来时用）。
function dockOf({ position, area, size, inset }) {
  const range = allowedRange(area, size, inset);
  if (position.x - range.minX <= 2) return 'left';
  if (range.maxX - position.x <= 2) return 'right';
  return null;
}

module.exports = { MIN_SPEED, MAX_SLIDE, SNAP_DISTANCE, SNAP_MS, allowedRange, clampTo, cubicOut, dockOf, releasePlan, releaseVelocity };
