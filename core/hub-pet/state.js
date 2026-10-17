'use strict';
// 助理桌宠的纯逻辑（2026-10-16 用户选定设计稿 D:\AI-Artifacts\20261016-助理桌宠设计-claude1.html）。
// 这里只决定「现在摆什么姿态」「这句话说不说、什么时候收」，不碰窗口和动画，方便单测。
// 姿态优先级借鉴 WorkMate 的 PetStateMachine：全屏躲边 > 开口欢呼 > 助理干活敲键盘 > 打盹 > 有点累 > 待机。

const POSES = Object.freeze(['idle', 'typing', 'happy', 'sleep', 'peek', 'tired']);
const MODES = Object.freeze(['lively', 'gentle', 'quiet']);
const ROLES = Object.freeze([
  { id: '01-cat', name: '小猫' },
  { id: '03-penguin', name: '企鹅' },
  { id: '05-rabbit', name: '兔子' },
  { id: '07-shiba', name: '柴犬' },
  { id: '09-hamster', name: '仓鼠' },
  { id: '11-cockatiel', name: '玄凤' },
]);

const SHOW_MS = 8000;           // 气泡停留 8 秒后收成小圆点
const MAX_PER_HOUR = 3;         // 每小时主动开口最多 3 次
const IDLE_SLEEP_SEC = 600;     // 10 分钟没操作就打盹
const NIGHT_FROM = 19;          // 19:00 后打盹
const NIGHT_UNTIL = 7;
const PETTED_AWAKE_MS = 60000;  // 夜里被点一下，醒一分钟
const SIT_LONG_MS = 90 * 60000; // 活泼档：连续坐 90 分钟提醒起来走走
const AWAY_BACK_SEC = 1800;     // 活泼档：离开 30 分钟回来打个招呼

// 右键菜单里交给助理办的事。prompt 是发给助理页的默认问题，助理页可以按 action 换成自己的流程。
const ASSISTANT_ACTIONS = Object.freeze([
  { action: 'meetings-today', label: '今天的会', prompt: '今天有哪些会？按时间列出来，标出需要我提前准备的。' },
  { action: 'meeting-prep', label: '下午会前准备', prompt: '帮我准备下午的会：每个会的材料要点、上次讨论到哪、我该问什么。' },
  { action: 'awaiting-reply', label: '谁在等我回', prompt: '谁在等我回复？按等待时间从长到短排。' },
  { action: 'group-summary', label: '汇总某个群', prompt: '帮我汇总一个群今天的讨论。' },
  { action: 'mail-triage', label: '未读邮件分拣', prompt: '把未读邮件分拣一下：要我处理的、知会我的、可以忽略的。' },
  { action: 'weekly-report', label: '起草周报', prompt: '根据本周的会、邮件和群消息起草一份周报。' },
]);

function localDateKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function isNight(ms) {
  const h = new Date(ms).getHours();
  return h >= NIGHT_FROM || h < NIGHT_UNTIL;
}

// ctx：{ now, fullscreen, speaking, assistantBusy, idleSec, quotaLow, pettedAt }
function decidePose(ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  if (ctx.fullscreen) return 'peek';
  if (ctx.speaking) return 'happy';
  if (ctx.assistantBusy) return 'typing';
  const petted = Number(ctx.pettedAt) > 0 && now - Number(ctx.pettedAt) < PETTED_AWAKE_MS;
  if (Number(ctx.idleSec) >= IDLE_SLEEP_SEC || (isNight(now) && !petted)) return 'sleep';
  if (ctx.quotaLow) return 'tired';
  return 'idle';
}

// 现在能不能开口；不能就只亮小圆点。返回 { ok, reason }。
// settings：{ mode, quietUntil, silentDate }；ctx：{ now, pose, fullscreen }
function speakGate(settings = {}, ctx = {}, spokenAt = []) {
  const now = Number(ctx.now) || Date.now();
  if (settings.mode === 'quiet') return { ok: false, reason: 'quiet-mode' };
  if (Number(settings.quietUntil) > now) return { ok: false, reason: 'quiet-hour' };
  if (settings.silentDate && settings.silentDate === localDateKey(now)) return { ok: false, reason: 'silent-today' };
  if (ctx.fullscreen) return { ok: false, reason: 'fullscreen' };
  if (ctx.pose === 'sleep') return { ok: false, reason: 'sleeping' };
  const recent = spokenAt.filter(t => now - t < 3600000).length;
  if (recent >= MAX_PER_HOUR) return { ok: false, reason: 'hourly-cap' };
  return { ok: true, reason: '' };
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// 一次一句的气泡队列。提醒先排队；轮到时能开口就说 8 秒，再收进小圆点；不能开口直接进小圆点。
class SpeechQueue {
  constructor({ now = () => Date.now(), showMs = SHOW_MS, keepDots = 20 } = {}) {
    this.now = now;
    this.showMs = showMs;
    this.keepDots = keepDots;
    this.pending = [];
    this.current = null;
    this.dots = [];
    this.spokenAt = [];
    this.seen = new Set();
  }

  // item：{ id, kind, title, text, sessionId? }。同一 id 只收一次。
  push(item) {
    const id = cleanText(item && item.id, 160);
    const title = cleanText(item && item.title, 80);
    if (!id || !title || this.seen.has(id)) return false;
    this.seen.add(id);
    this.pending.push({ id, kind: cleanText(item.kind, 32), title, text: String(item.text == null ? '' : item.text).slice(0, 4000), sessionId: cleanText(item.sessionId, 160) || null });
    return true;
  }

  // 每次状态变化或定时器到点调用；gate(spokenAt) 返回 speakGate 的结果。返回是否有可见变化。
  tick(gate) {
    const now = this.now();
    let changed = false;
    if (this.current && now >= this.current.until) {
      this.toDot(this.current);
      this.current = null;
      changed = true;
    }
    while (!this.current && this.pending.length) {
      const next = this.pending.shift();
      const verdict = typeof gate === 'function' ? gate(this.spokenAt) : { ok: true };
      if (verdict && verdict.ok) {
        this.spokenAt.push(now);
        this.spokenAt = this.spokenAt.filter(t => now - t < 3600000);
        this.current = { ...next, at: now, until: now + this.showMs };
      } else {
        this.toDot(next);
      }
      changed = true;
    }
    return changed;
  }

  toDot(item) {
    const { until, at, ...rest } = item;
    this.dots.push(rest);
    if (this.dots.length > this.keepDots) this.dots.splice(0, this.dots.length - this.keepDots);
  }

  // 用户点了气泡：提前收起，内容交给展开面板；不算进小圆点。
  takeCurrent() {
    const item = this.current;
    this.current = null;
    if (!item) return null;
    const { until, at, ...rest } = item;
    return rest;
  }

  // 用户点了小圆点：取走全部，最新的在前。
  takeDots() {
    const items = this.dots.slice().reverse();
    this.dots = [];
    return items;
  }

  nextDeadline() {
    if (this.current) return this.current.until;
    return this.pending.length ? this.now() : null;
  }

  snapshot() {
    return {
      bubble: this.current ? { id: this.current.id, kind: this.current.kind, title: this.current.title, until: this.current.until } : null,
      dots: this.dots.length,
      pending: this.pending.length,
    };
  }
}

// 活泼档的闲聊（温和档只说助理的提醒，安静档什么都不说）。返回要说的话或 null。
// track：调用方保存的 { greetedDate, activeSince, sitRemindedAt, lastIdleSec }，本函数会更新它。
function chatterFor(mode, ctx = {}, track = {}) {
  if (mode !== 'lively') return null;
  const now = Number(ctx.now) || Date.now();
  const idleSec = Number(ctx.idleSec) || 0;
  const hour = new Date(now).getHours();
  const prevIdle = Number(track.lastIdleSec) || 0;
  track.lastIdleSec = idleSec;
  if (idleSec >= 300) { track.activeSince = 0; return null; }
  if (!track.activeSince) track.activeSince = now;
  const today = localDateKey(now);
  if (track.greetedDate !== today && hour >= NIGHT_UNTIL && hour < 11) {
    track.greetedDate = today;
    return { id: 'chatter-greet-' + today, kind: 'chatter', title: '早上好！今天也一起加油。' };
  }
  if (prevIdle >= AWAY_BACK_SEC && idleSec < 60) {
    return { id: 'chatter-back-' + now, kind: 'chatter', title: '欢迎回来～有新提醒我会叫你。' };
  }
  if (now - track.activeSince >= SIT_LONG_MS && now - (Number(track.sitRemindedAt) || 0) >= SIT_LONG_MS) {
    track.sitRemindedAt = now;
    track.activeSince = now;
    return { id: 'chatter-sit-' + now, kind: 'chatter', title: '坐了一个半小时啦，起来走走、喝口水？' };
  }
  return null;
}

module.exports = {
  ASSISTANT_ACTIONS,
  IDLE_SLEEP_SEC,
  MAX_PER_HOUR,
  MODES,
  POSES,
  ROLES,
  SHOW_MS,
  SpeechQueue,
  chatterFor,
  decidePose,
  isNight,
  localDateKey,
  speakGate,
};
