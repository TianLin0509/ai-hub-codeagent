'use strict';
// 电脑上的助理对话入口（助理 Tab 输入框）。与手机同一套回答方式：
// 快速回答时先由 API 前台当场答，工作和难题交给专属助理会话；助理会话模式直接交给助理会话。
// 所有往来写进对话记录（dialog-log），助理 Tab 只展示「用户 ↔ 助理」，不展示助理会话内部过程。
const { randomUUID } = require('node:crypto');
const GIVE_UP_MS = 30 * 60000;

class AssistantDesk {
  constructor({ assistant, fastLane = null, pollMs = 2000 }) {
    this.a = assistant; this.fast = fastLane; this.pollMs = pollMs;
    this.queue = []; this.pending = null; this.timer = null; this.pumping = false;
  }
  // to='assistant' 时这一条跳过快答、直接交给助理会话（用户觉得难，或对快答不满意让助理再答）。
  async ask(rawText, { to = 'auto', again = null } = {}) {
    const text = String(rawText || '').trim();
    if (!text || text.length > 50000) throw new Error('请输入要交给助理的内容');
    const id = randomUUID(), at = Date.now();
    this.a.logDialog({ id, at, role: 'user', input: 'text', source: 'hub', text, ...(to === 'assistant' ? { forced: true } : {}), ...(again ? { again } : {}) });
    const fd = this.a.frontDesk();
    if (to !== 'assistant' && fd.mode === 'api' && this.fast?.eligible(text)) {
      try {
        const r = await this.fast.answer(text, { history: this.a.recentHistory(), userPrefs: this.a.memory?.read?.().user || '', memory: this.a.memory?.read?.().memory || '', model: fd.model, hubStatus: this.a.statusDigest?.() || '' });
        if (r.handoff) console.log('[assistant] desk fast lane handoff', Math.round(r.ms || 0) + 'ms');
        if (!r.handoff) {
          this.a.logDialog({ id, role: 'assistant', lane: 'fast', by: fd.modelLabel, text: r.text, ms: Date.now() - at });
          try { this.a.recordFastLane({ id, question: text, answer: r.text, model: r.model }); } catch {}
          return { ok: true, id, lane: 'fast' };
        }
      } catch (error) { console.warn('[assistant] desk fast lane fallback', error.message); }
    }
    this.a.logDialog({ id, role: 'route', lane: 'assistant', by: this.a.assistantLabel() });
    this.queue.push({ id, text, at }); this.arm(); void this.pump();
    return { ok: true, id, lane: 'assistant' };
  }
  // 助理空闲时把排队的话依次交给助理会话；忙时等它答完（turn 完成事件或兜底轮询）。
  async pump() {
    if (this.pumping || this.pending || !this.queue.length) return;
    this.pumping = true;
    try {
      const o = this.a.overview();
      if (o.submissionPending || ['running', 'waiting'].includes(o.status)) return;
      const job = this.queue[0];
      let r; try { r = await this.a.send({ text: job.text, requestId: job.id }); } catch (error) { r = { ok: false, error: error.message }; }
      if (!r?.ok) {
        job.tries = (job.tries || 0) + 1;
        if (job.tries >= 3) { this.queue.shift(); this.a.logDialog({ id: job.id, role: 'system', text: '助理暂时无法接收：' + (r?.error || r?.receipt?.message || '未知原因') + '。请稍后再说一次。' }); }
        return;
      }
      this.queue.shift(); this.pending = { ...job, sessionId: r.sessionId };
    } finally { this.pumping = false; }
  }
  check() {
    const p = this.pending;
    if (!p) { void this.pump(); return; }
    let found = null;
    try { found = this.a.readLiveFinal(p.sessionId).records.find(x => x.clientSubmissionId === p.id); } catch {}
    if (found) {
      this.pending = null;
      this.a.logDialog({ id: p.id, role: 'assistant', lane: 'assistant', by: this.a.assistantLabel(), text: found.text, ms: Date.now() - p.at });
      void this.pump();
    } else if (Date.now() - p.at > GIVE_UP_MS) {
      this.pending = null;
      this.a.logDialog({ id: p.id, role: 'system', text: '超过 30 分钟没拿到助理的回复，可到工作台的助理会话查看。' });
      void this.pump();
    }
  }
  arm() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.pending && !this.queue.length) { clearInterval(this.timer); this.timer = null; return; }
      this.check();
    }, this.pollMs);
    this.timer.unref?.();
  }
  busy() { return { waiting: !!this.pending, queued: this.queue.length }; }
}
module.exports = { AssistantDesk };
