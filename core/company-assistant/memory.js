'use strict';
// 有出处的短条目；原始聊天与消息快照仍在原处，记忆不复制整段历史。
const { randomUUID } = require('node:crypto');
const D = require('./data');
const TYPES = ['person', 'group', 'preference', 'routine'];
const MAX_ITEMS = 15; // 每类，按 Claude v3.1 设计
const MAX_CONTEXT = 1200;
const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
function terms(text) {
  const s = String(text || '').toLowerCase();
  const tokens = s.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]+/g) || [];
  return [...new Set(tokens.flatMap(t => /^[\u3400-\u9fff]+$/.test(t) && t.length > 2 ? [t, ...Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2))] : [t]))];
}
class AssistantMemory {
  constructor(assistant) { this.a = assistant; }
  owner() { return this.a.auth?.status()?.login?.uid || this.a.snapshot()?.login?.uid || 'local'; }
  all() { const data = this.a.read('memory.json', { version: 1, items: [] }); return Array.isArray(data.items) ? data.items : []; }
  active() { const now = this.a.now(), owner = this.owner(); return this.all().filter(x => x.owner === owner && !x.deletedAt && (!x.expiresAt || x.expiresAt > now)); }
  public(x) { const { owner, revisions, deletedAt, ...item } = x; return item; }
  search(query = '', limit = 6) {
    const words = terms(query);
    return this.active().map(item => ({ item, score: (String(query).includes(item.key) ? 100 : 0) + words.reduce((s, w) => s + (String(item.key + ' ' + item.text).toLowerCase().includes(w) ? Math.min(8, w.length) : 0), 0) }))
      .filter(x => !words.length || x.score > 0)
      .sort((x, y) => y.score - x.score || y.item.updatedAt - x.item.updatedAt)
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 6))).map(x => this.public(x.item));
  }
  context(query) {
    const matches = this.search(query, 6);
    const selected = [...matches, ...this.active().filter(x => x.kind === 'preference').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 2)];
    const ids = new Set(); let text = '';
    for (const item of selected) {
      if (ids.has(item.id)) continue;
      const line = `- ${item.key}：${item.text}（${D.dayKey(item.updatedAt)}）\n`;
      if (text.length + line.length > MAX_CONTEXT - 80) continue;
      text += line; ids.add(item.id);
    }
    this.touchIds(ids);
    return text ? '我记得的事（用户确认的偏好和关系，当前核实结果优先）：\n' + text : '';
  }
  source(args) {
    if (args.sourceId) {
      const row = D.sourceIndex(this.a.snapshot() || {}).get(String(args.sourceId));
      if (!row) throw new Error('记忆的出处不在最近取数中，请先查询核实');
      return { kind: 'welink', ref: String(args.sourceId), at: this.a.snapshot()?.at || this.a.now() };
    }
    const id = this.a.job?.type === 'chat' ? this.a.job.chatId : null;
    const chat = id && this.a.chat().find(x => x.id === id);
    if (!chat) throw new Error('保存记忆需要当前用户对话或已核实的 sourceId');
    return { kind: 'user', ref: chat.id, at: chat.askedAt };
  }
  touch(text) {
    const items = this.all(); let changed = false;
    for (const item of items) if (item.owner === this.owner() && String(text || '').includes(item.key)) { item.lastUsed = this.a.now(); changed = true; }
    if (changed) this.a.write('memory.json', { version: 1, items });
  }
  touchIds(ids) {
    const items = this.all(); let changed = false;
    for (const item of items) if (item.owner === this.owner() && ids.has(item.id)) { item.lastUsed = this.a.now(); changed = true; }
    if (changed) this.a.write('memory.json', { version: 1, items });
  }
  execute(args = {}, { fromSettings = false } = {}) {
    const op = ({ add: 'save', update: 'save', remove: 'forget' })[args.op] || args.op || 'search';
    if (op === 'search') return { items: this.search(args.query, args.limit), total: this.active().length, note: '只检索短记忆，原始消息请用 welink_inbox 和 welink_message 核实。' };
    if (op === 'list') {
      const all = this.active().sort((a, b) => b.updatedAt - a.updatedAt), offset = Math.max(0, Number(args.offset) || 0), limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
      return { items: all.slice(offset, offset + limit).map(x => this.public(x)), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null };
    }
    const now = this.a.now(), items = this.all(), owner = this.owner();
    if (op === 'forget') {
      const item = items.find(x => x.id === args.id && x.owner === owner && !x.deletedAt);
      if (!item) throw new Error('找不到这条记忆；先 list 或 search');
      // 删除文字，不在历史里暗留用户要求遗忘的内容。
      this.a.write('memory.json', { version: 1, items: items.filter(x => x !== item) });
      return { ok: true, forgotten: item.id };
    }
    if (op !== 'save') throw new Error('记忆操作只能是 search/list/save/forget');
    const key = clean(args.key, 40), text = clean(args.text, 60), kind = args.kind || 'preference';
    if (String(args.key || '').trim().length > 40) throw new Error('记忆key最多40字，请用稳定的简短称呼');
    if (!key || !text || !TYPES.includes(kind)) throw new Error('记忆需要简短的 key、text；kind 为 person/group/preference/routine');
    if (String(args.text || '').trim().length > 60) throw new Error('一条记忆最多 60 字，请提炼关系、偏好或例行安排');
    const source = fromSettings ? { kind: 'user', ref: 'settings-edit', at: now } : this.source({});
    let expiresAt = null;
    if (args.expiresAt) {
      if (!/(?:Z|[+-]\d\d:\d\d)$/.test(args.expiresAt)) throw new Error('到期时间需带时区，例如 2026-10-23T18:00:00+08:00');
      expiresAt = Date.parse(args.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('到期时间必须晚于当前时间');
    }
    const byId = args.id && items.find(x => x.owner === owner && x.id === args.id);
    if (args.id && !byId) throw new Error('找不到这条记忆；先 list 或 search');
    const sameKey = items.find(x => x.owner === owner && x.kind === kind && x.key === key);
    if (byId && sameKey && byId.id !== sameKey.id) throw new Error('这个类别已有同名记忆，请编辑该条或使用不同key');
    const existing = byId || sameKey;
    if (!Object.hasOwn(args, 'expiresAt')) expiresAt = existing?.expiresAt || null;
    const sameKind = items.filter(x => x.owner === owner && x.kind === kind);
    const evicted = (!existing || existing.kind !== kind) && sameKind.length >= MAX_ITEMS ? sameKind.sort((a, b) => (a.lastUsed || a.updatedAt) - (b.lastUsed || b.updatedAt))[0] : null;
    const item = { id: existing?.id || randomUUID(), owner, key, kind, text, source, createdAt: existing?.createdAt || now, updatedAt: now, lastUsed: now, expiresAt,
      revisions: existing ? Number(existing.revisions || 0) + 1 : 0 };
    this.a.write('memory.json', { version: 1, items: [...items.filter(x => x.id !== item.id && x.id !== evicted?.id), item] });
    return { ok: true, item: this.public(item), updated: !!existing, evicted: evicted ? this.public(evicted) : null };
  }
}
module.exports = { AssistantMemory, TYPES, MAX_ITEMS, MAX_CONTEXT, terms };
