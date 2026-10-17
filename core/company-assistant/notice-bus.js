'use strict';
// 公司版助理的「提醒」总线（2026-10-16 用户：助理页 6 条提醒都要；桌宠融入 Hub，说的话就是助理的简报和提醒）。
// 助理服务（简报、会前准备、等你回复太久、答应的事快到期、会议排太满、下班前小结、关注词）只往这里发布；
// 助理页、桌宠、桌面通知各自订阅，互不依赖。同一条提醒（id 相同）只发布一次。
const { EventEmitter } = require('node:events');

const KINDS = Object.freeze(['brief', 'meeting-prep', 'awaiting-reply', 'commitment-due', 'overbooked', 'day-summary', 'keyword']);
const KEEP = 50;

class NoticeBus extends EventEmitter {
  constructor({ now = () => Date.now() } = {}) {
    super();
    this.now = now;
    this.items = [];
    this.seen = new Set();
  }
  // notice：{ id, kind, title, text, detail?, at?, sessionId? }。title 是一句话（桌宠气泡、通知标题），
  // text 是展开后的内容；sessionId 指向助理会话，点开时跳过去。返回 false 表示同一 id 已发布过或格式不对。
  publish(notice) {
    if (!notice || typeof notice.id !== 'string' || !notice.id || !KINDS.includes(notice.kind)) return false;
    if (this.seen.has(notice.id)) return false;
    const item = { title: '', text: '', ...notice, title: String(notice.title || '').slice(0, 80), at: Number(notice.at) || this.now() };
    this.seen.add(item.id);
    this.items.push(item);
    if (this.items.length > KEEP) this.items.splice(0, this.items.length - KEEP);
    this.emit('notice', item);
    return true;
  }
  latest(limit = 10) { return this.items.slice(-limit).reverse(); }
}

let shared = null;
function noticeBus() { if (!shared) shared = new NoticeBus(); return shared; }

module.exports = { NoticeBus, noticeBus, KINDS };
