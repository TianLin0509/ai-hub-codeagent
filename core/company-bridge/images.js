'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { hash, UUID, MAX_TEXT_BYTES, maxDataBytes } = require('./image-message');
const { probeImage, MAX_SOURCE_BYTES } = require('./image-probe');
const CAPABILITY = 'image-text-v1';
const stateNames = { queued: '等待发送', sent: '已发出，等待对端校验', received: '已接收并校验', delivered: '已通知会话', error: '未完成', cancelled: '配对已变更' };

class BridgeImages {
  constructor(bridge) {
    this.bridge = bridge; this.store = bridge.store; this.link = bridge.link; this.deps = bridge.deps;
    this.dir = path.join(this.deps.dataDir, 'company-bridge', 'images');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS bridge_images(id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated INTEGER NOT NULL)');
    this.busy = null;
  }
  available() { return !!this.deps.imageCodec; }
  get(id) { const row = this.store.db.prepare('SELECT payload FROM bridge_images WHERE id=?').get(id); return row ? JSON.parse(row.payload) : null; }
  save(item) {
    this.store.db.prepare('INSERT INTO bridge_images(id,payload,updated) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated')
      .run(item.id, JSON.stringify(item), this.bridge.now());
    this.bridge.changed(); return item;
  }
  list(limit = 100) { return this.store.db.prepare('SELECT payload FROM bridge_images ORDER BY updated DESC LIMIT ?').all(limit).map(x => JSON.parse(x.payload)); }
  context(thread) {
    if (!/^[QH]-\d{4}-\d{2,}$/.test(thread || '')) return null;
    if (thread.startsWith('Q-')) return this.bridge.thread(thread);
    return (this.link.side === 'home' ? this.bridge.consult : this.bridge.askHome)?.thread(thread);
  }
  requireContext(thread, sessionId, round) {
    const t = this.context(thread);
    if (!t || t.gen !== this.link.gen() || t.state === 'cancelled') throw new Error('找不到当前配对的图片所属线程');
    if (sessionId && t.sessionId !== sessionId) throw new Error('这个图片线程属于另一个会话');
    const r = round == null ? t.rounds.at(-1) : t.rounds.find(x => x.round === round);
    if (!r) throw new Error('找不到图片所属轮次');
    return { t, r };
  }
  supported() { const peer = this.store.get('imagePeer'); return peer?.gen === this.link.gen() && peer.capability === CAPABILITY; }
  async advertise() {
    if (!this.available() || !this.link.paired()) return;
    const old = this.store.get('imageAnnouncement');
    if (old?.gen === this.link.gen() && this.bridge.now() - old.at < 300000) return;
    const gen = this.link.gen();
    this.store.set('imageAnnouncement', { gen, at: this.bridge.now() });
    await this.link.send('image-capabilities', { gen, capability: CAPABILITY, maxTextBytes: MAX_TEXT_BYTES });
  }
  async send(sessionId, args) {
    if (!this.available()) throw new Error('当前 Hub 没有本机图片处理能力');
    if (!this.link.paired()) throw new Error('图片发送前必须完成配对');
    const { t, r } = this.requireContext(String(args.thread || ''), sessionId, args.round);
    if (!this.supported()) { await this.advertise(); throw new Error('尚未确认对端支持图片消息：两端都需升级，并等待一次通道检查；没有发送图片'); }
    const caption = String(args.caption || '').trim();
    if (Buffer.byteLength(caption, 'utf8') > 1200) throw new Error('图片说明超过 1200 字节');
    const sourcePath = String(args.path || '');
    if (!path.isAbsolute(sourcePath) || sourcePath.includes('\0') || /^(?:\\\\|\/\/)/.test(sourcePath)) throw new Error('请提供本机图片的绝对路径');
    const fd = fs.openSync(sourcePath, 'r');
    let input;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 24 || stat.size > MAX_SOURCE_BYTES) throw new Error('只支持最大 16 MB 的本机图片文件');
      input = Buffer.alloc(stat.size);
      let n = 0; while (n < input.length) { const read = fs.readSync(fd, input, n, input.length - n, n); if (!read) throw new Error('读取图片时文件发生变化'); n += read; }
    } finally { fs.closeSync(fd); }
    probeImage(input);
    const gen = this.link.gen(), thread = t.id, round = r.round;
    const budgetMeta = { v: 1, mid: randomUUID(), type: 'image', ts: this.bridge.now(), from: this.link.side, gen, thread, round, caption,
      sha256: '0'.repeat(64), format: 'webp', width: 16000, height: 16000, originalWidth: 16000, originalHeight: 16000, sourceBytes: MAX_SOURCE_BYTES, lossy: true, quality: .9999999999999999, resized: true };
    const maxBytes = Math.min(44000, maxDataBytes(this.link.other, budgetMeta) - 64);
    const image = await this.deps.imageCodec.compress(input, { maxBytes, allowResize: args.allow_resize === true });
    const actual = probeImage(image.buffer);
    if (actual.width !== image.width || actual.height !== image.height || actual.format !== image.format) throw new Error('本机图片编码结果不一致');
    if (!this.link.paired() || this.link.gen() !== gen) throw new Error('图片处理期间配对已变更，没有发送');
    this.requireContext(thread, sessionId, round);
    const metadata = { thread, round, caption, format: image.format, width: image.width, height: image.height, originalWidth: image.originalWidth, originalHeight: image.originalHeight,
      sourceBytes: input.length, lossy: !!image.lossy, quality: image.quality, resized: !!image.resized, sha256: hash(image.buffer) };
    const frame = this.link.prepareImage(metadata, image.buffer);
    const savedPath = this.writeImage(gen, frame.mid, image.format, image.buffer);
    const item = { ...metadata, id: frame.mid, gen, direction: 'out', sessionId, path: savedPath, imageBytes: image.buffer.length, textBytes: frame.textBytes, state: 'queued', createdAt: this.bridge.now() };
    this.store.db.exec('BEGIN IMMEDIATE');
    try { this.link.enqueue(frame); this.save(item); this.store.db.exec('COMMIT'); }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    await this.link.flush().catch(() => {});
    const current = this.get(item.id);
    if (current.state === 'queued' && !(this.store.get('outbox') || []).some(x => x.mid === item.id)) this.save({ ...current, state: 'sent' });
    this.bridge.nextPullAt = 0;
    return this.publicItem(this.get(item.id));
  }
  writeImage(gen, id, format, data) {
    if (!UUID.test(id) || !['png', 'jpeg', 'webp'].includes(format)) throw new Error('图片保存参数无效');
    const dir = path.join(this.dir, hash(Buffer.from(gen)).slice(0, 24));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id + '.' + format);
    try { fs.writeFileSync(file, data, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || hash(fs.readFileSync(file)) !== hash(data)) throw error; }
    return file;
  }
  async ack(message, state, error) {
    await this.link.send('image-ack', { gen: message.gen, imageId: message.mid || message.id, thread: message.thread, round: message.round, sha256: message.sha256, state,
      ...(state === 'delivered' ? { deliveryUncertain: message.deliveryUncertain === true } : {}), ...(error ? { error: String(error).slice(0, 200) } : {}) });
  }
  async receive(message) {
    if (!['image-capabilities', 'image', 'image-ack'].includes(message.type)) return false;
    if (!this.link.paired() || message.gen !== this.link.gen()) return true;
    if (message.type === 'image-capabilities') {
      if (message.capability === CAPABILITY && message.maxTextBytes === MAX_TEXT_BYTES) this.store.set('imagePeer', { gen: message.gen, capability: CAPABILITY });
      await this.advertise(); return true;
    }
    if (message.type === 'image-ack') {
      const old = this.get(message.imageId);
      if (old?.direction === 'out' && old.gen === message.gen && old.thread === message.thread && old.round === message.round && old.sha256 === message.sha256 && ['received', 'delivered', 'error'].includes(message.state)) {
        if (old.state !== 'delivered' || message.state === 'delivered') this.save({ ...old, state: message.state, deliveryUncertain: message.state === 'delivered' && message.deliveryUncertain === true, error: message.error || null, acknowledgedAt: this.bridge.now() });
      }
      return true;
    }
    try {
      if (!this.available()) throw new Error('接收端需要升级以支持图片消息');
      this.requireContext(message.thread, null, message.round);
      const old = this.get(message.mid);
      if (old) {
        if (old.direction !== 'in' || old.gen !== message.gen || old.sha256 !== message.sha256) throw new Error('重复图片编号内容不一致');
        await this.ack(old, old.state === 'delivered' ? 'delivered' : 'received'); return true;
      }
      const info = probeImage(message.data);
      if (info.format !== message.format || info.width !== message.width || info.height !== message.height) throw new Error('图片尺寸或格式与说明不一致');
      const decoded = await this.deps.imageCodec.validate(message.data);
      if (decoded.width !== message.width || decoded.height !== message.height) throw new Error('图片解码校验失败');
      if (!this.link.paired() || message.gen !== this.link.gen()) return true;
      const { t } = this.requireContext(message.thread, null, message.round);
      const savedPath = this.writeImage(message.gen, message.mid, message.format, message.data);
      const { data, mid, ...metadata } = message;
      const item = { ...metadata, id: mid, direction: 'in', sessionId: t.sessionId, path: savedPath, imageBytes: data.length, state: 'received', createdAt: this.bridge.now() };
      this.save(item);
      await this.ack(message, 'received');
      this.bridge.notify('收到图片', `${message.thread}：已还原并校验 ${data.length} 字节的图片`, t.sessionId);
    } catch (error) { await this.ack(message, 'error', error.message); this.bridge.notify('图片未接收', error.message); }
    return true;
  }
  async tick() {
    if (this.busy) return this.busy;
    this.busy = this.advance().finally(() => { this.busy = null; });
    return this.busy;
  }
  async deliveryAck(item) {
    if (!this.link.paired() || item.gen !== this.link.gen()) return;
    try {
      await this.ack(item, 'delivered');
      this.save({ ...this.get(item.id), ackPending: false, ackError: null, nextAckAt: 0 });
    } catch (error) {
      // Notification is already submitted. An outbox failure must only retry its ACK.
      this.save({ ...this.get(item.id), ackPending: true, ackError: '确认回执暂未入队，将重试：' + error.message, nextAckAt: this.bridge.now() + 60000 });
    }
  }
  async advance() {
    if (!this.link.paired()) return;
    await this.advertise();
    const outbox = new Set((this.store.get('outbox') || []).map(x => x.mid));
    // Pending work must not disappear behind a UI history limit.
    const pending = this.store.db.prepare("SELECT payload FROM bridge_images WHERE json_extract(payload, '$.state') NOT IN ('delivered','cancelled','error') OR json_extract(payload, '$.ackPending') = 1 ORDER BY updated").all().map(x => JSON.parse(x.payload));
    for (const item of pending) {
      if (item.gen !== this.link.gen()) {
        const state = ['delivered', 'cancelled', 'error'].includes(item.state) ? item.state : 'cancelled';
        this.save({ ...item, state, ackPending: false, ackError: null }); continue;
      }
      if (item.direction === 'out') { if (item.state === 'queued' && !outbox.has(item.id)) this.save({ ...item, state: 'sent' }); continue; }
      if (item.state === 'delivered' && item.ackPending) { if (!(item.nextAckAt > this.bridge.now())) await this.deliveryAck(item); continue; }
      if (item.state !== 'received' || item.nextTryAt > this.bridge.now()) continue;
      let delivered;
      try {
        const { t } = this.requireContext(item.thread, null, item.round);
        const sid = t.sessionId;
        if (!sid || this.bridge.sessionBusy(sid)) continue;
        if (!this.deps.getSession(sid)) {
          if (!this.deps.getSessionMetadata?.(sid)) { this.save({ ...item, error: '会话已不存在，图片保留在通道列表中', nextTryAt: this.bridge.now() + 60000 }); continue; }
          await this.deps.resumeSession?.(sid);
          if (!this.deps.getSession(sid) || this.bridge.sessionBusy(sid)) continue;
        }
        if (!this.link.paired() || item.gen !== this.link.gen()) continue;
        if (this.requireContext(item.thread, null, item.round).t.sessionId !== sid) continue;
        const text = [`【通道图片 ${item.thread} · 第 ${item.round} 轮】`, `图片已在本机还原并通过完整性校验：${item.path}`, `尺寸 ${item.width} × ${item.height}；${item.lossy ? '有损压缩' : 'PNG 编码'}${item.resized ? '，已缩小分辨率' : '，保留分辨率'}。`, item.caption ? `对端说明：${item.caption}` : '', '需要分析时请用本机看图工具读取以上文件；尚未读取图片时不要声称已看过。'].filter(Boolean).join('\n');
        const receipt = await this.deps.sendPrompt(sid, text, item.id);
        if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) throw new Error(receipt?.error || '图片通知未送进会话');
        delivered = this.save({ ...item, sessionId: sid, state: 'delivered', deliveredAt: this.bridge.now(), ackPending: true,
          deliveryUncertain: receipt.ok === false || receipt.unconfirmed === true || receipt.sendStatus === 'stuck', error: null });
      } catch (error) { this.save({ ...item, error: error.message, nextTryAt: this.bridge.now() + 60000 }); }
      if (delivered) await this.deliveryAck(delivered);
    }
  }
  publicItem(item) {
    const state = item.gen !== this.link.gen() && ['queued', 'sent', 'received'].includes(item.state) ? 'cancelled' : item.state;
    return { ...item, state, error: item.error || item.ackError || null, status: state === 'delivered' && item.deliveryUncertain ? '通知已提交，确认待核实' : stateNames[state] || state };
  }
  view(sessionId, thread) {
    if (thread) this.requireContext(thread, sessionId);
    return this.list().filter(x => {
      const owner = sessionId && this.context(x.thread);
      return (!thread || x.thread === thread) && (!sessionId || (owner?.sessionId === sessionId && owner.gen === x.gen));
    }).map(x => this.publicItem(x));
  }
  status() { return { available: this.available(), peerSupported: this.supported(), maxTextBytes: MAX_TEXT_BYTES, items: this.view() }; }
}
module.exports = { BridgeImages, CAPABILITY };
