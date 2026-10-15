'use strict';
// 任务通道的一端（家里或公司）：配对状态、加密收发、发件箱重试、在线状态。
//
// 配对（2026-10-15，经两轮独立审查后改为绑定家里公钥的密钥协商）：
//   1. 家里生成一对 X25519 密钥和初始密钥，把通道地址、初始密钥、家里公钥写进配对码
//      （配对码会经过收件箱网页，可能被人看到）；
//   2. 公司粘贴后生成自己的一对，用「公司私钥 + 家里公钥」算出正式密钥，把公司公钥和证明（hello）
//      用初始密钥加密发给家里，然后去正式通道等家里确认；
//   3. 家里用「家里私钥 + 公司公钥」算出同一把正式密钥、核对证明，在正式通道回 welcome；
//   4. 公司在正式通道收到能用正式密钥解开、证明正确的 welcome，才算接通。
// 看到配对码的人只有公钥，算不出正式密钥，也冒充不了家里（welcome 只有家里私钥能产生）。
// 冒充公司抢先发 hello 的情况：家里配对后 24 小时内仍看一眼初始通道，出现第二个 hello 就解除配对并提醒。
// 每次配对有一个代次编号（gen），问题和回执都记着自己属于哪一代：解除配对后旧任务不会发给新对端。
const { randomUUID } = require('node:crypto');
const bridgeCrypto = require('./crypto');
const { BridgeClient } = require('./client');

const OTHER = { home: 'company', company: 'home' };
const OUTBOX_LIMIT = 1000;
const PAIRING_TTL_MS = 24 * 3600000;
// 发件箱满时只能丢「可替代的进度通知」（已收到 / 在读代码）；问题、回执、握手、报错一条不丢。
const droppable = item => item.droppable === true;

class BridgeLink {
  constructor({ side, store, fetchImpl, now }) {
    if (!OTHER[side]) throw new Error('side 只能是 home 或 company');
    this.side = side; this.other = OTHER[side]; this.store = store; this.fetchImpl = fetchImpl;
    this.now = now || (() => Date.now());
  }
  config() { return this.store.get('link') || { state: 'none' }; }
  saveConfig(next) { this.store.set('link', next); return next; }
  status() { return this.store.get('linkStatus') || {}; }
  saveStatus(patch) { const next = { ...this.status(), ...patch }; this.store.set('linkStatus', next); return next; }
  client(baseUrl = this.config().baseUrl) { return new BridgeClient({ baseUrl, fetchImpl: this.fetchImpl }); }
  activeSecret() { const c = this.config(); return ['paired', 'waiting-welcome'].includes(c.state) ? c.secret : c.state === 'pending' ? c.initialSecret : null; }
  paired() { return this.config().state === 'paired'; }
  gen() { return this.config().gen || null; }
  pairingExpired() { const c = this.config(); return ['pending', 'waiting-welcome'].includes(c.state) && this.now() - (c.createdAt || 0) > PAIRING_TTL_MS; }

  // ---- 家里：生成配对码 ----
  createPairing(baseUrl) {
    const initialSecret = bridgeCrypto.newSecret();
    const url = bridgeCrypto.checkBaseUrl(baseUrl);
    const pair = bridgeCrypto.newKeyPair();
    this.saveConfig({ state: 'pending', baseUrl: url, initialSecret, privateKey: pair.privateKey, publicKey: pair.publicKey, cursor: 0, createdAt: this.now() });
    this.store.set('outbox', []);
    return bridgeCrypto.makePairingCode(url, initialSecret, pair.publicKey);
  }
  // 家里收到 hello：核对证明，算出正式密钥；welcome 入发件箱和切换配置放在同一个事务里（中途崩溃不会两头不一致）。
  completeAsHome(message) {
    const c = this.config();
    if (c.state !== 'pending') return false;
    let secret;
    try { secret = bridgeCrypto.agree(c.privateKey, message.pub, c.initialSecret); } catch { return false; }
    if (message.proof !== bridgeCrypto.proof(secret, 'hello') || !message.gen) return false;
    const welcome = this.prepare('welcome', { proof: bridgeCrypto.proof(secret, 'welcome') }, secret);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.set('outbox', [...(this.store.get('outbox') || []), welcome]);
      this.saveConfig({ state: 'paired', baseUrl: c.baseUrl, secret, gen: String(message.gen), cursor: 0, epoch: null, pairedAt: this.now(), peerInfo: message.info || null,
        initialSecret: c.initialSecret, initialCursor: c.cursor || 0, peerPub: message.pub });
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return true;
  }
  // 家里配对后 24 小时内仍看一眼初始通道：出现别的公钥发来的 hello，说明配对码被别人用过。
  async checkPairingConflict() {
    const c = this.config();
    if (c.state !== 'paired' || !c.initialSecret || this.now() - (c.pairedAt || 0) > PAIRING_TTL_MS) return false;
    const link = bridgeCrypto.derive(c.initialSecret);
    const page = await this.client(c.baseUrl).fetchMessages(link.channel, this.side, c.initialCursor || 0, null);
    let cursor = c.initialCursor || 0, conflict = false;
    for (const row of page.messages || []) {
      cursor = row.seq;
      let m = null; try { m = bridgeCrypto.open(link, this.side, row.blob); } catch {}
      if (m && m.type === 'hello' && m.pub !== c.peerPub) conflict = true;
    }
    if (!conflict) this.saveConfig({ ...this.config(), initialCursor: cursor });
    return conflict;
  }
  // ---- 公司：粘贴配对码 ----
  async acceptPairing(code, info = {}) {
    const { baseUrl, secret: initialSecret, homePublicKey } = bridgeCrypto.parsePairingCode(code);
    if (!homePublicKey) throw new Error('配对码版本太旧：请在发起配对的 Hub 重新生成');
    const pair = bridgeCrypto.newKeyPair();
    const secret = bridgeCrypto.agree(pair.privateKey, homePublicKey, initialSecret);
    const gen = randomUUID();
    this.saveConfig({ state: 'waiting-welcome', baseUrl, secret, gen, cursor: 0, epoch: null, createdAt: this.now() });
    this.store.set('outbox', []);
    await this.send('hello', { pub: pair.publicKey, gen, proof: bridgeCrypto.proof(secret, 'hello'), info }, { secret: initialSecret });
    return this.config();
  }
  // 公司在正式通道收到 welcome：能解开说明对方有家里私钥；再核对证明。
  completeAsCompany(message) {
    const c = this.config();
    if (c.state !== 'waiting-welcome' || message.proof !== bridgeCrypto.proof(c.secret, 'welcome')) return false;
    this.saveConfig({ ...c, state: 'paired', pairedAt: this.now() });
    return true;
  }
  unpair() { this.saveConfig({ state: 'none' }); this.store.set('outbox', []); this.saveStatus({ lastError: null, gate: null, peerSeen: null }); }

  // 封好一条消息（加密 + 消息编号），不发送。
  prepare(type, payload = {}, secret = this.activeSecret()) {
    if (!secret) throw new Error('还没有配对');
    const link = bridgeCrypto.derive(secret);
    const mid = randomUUID();
    const message = { v: 1, mid, type, ts: this.now(), from: this.side, ...payload };
    return { channel: link.channel, to: this.other, mid, blob: bridgeCrypto.seal(link, this.other, message), type, at: this.now(),
      droppable: type === 'status' && payload.state !== 'error' };
  }
  // 发给对端：先放进发件箱再发，失败下一轮原样重发，服务端按编号去重。
  // 发件箱满了先丢进度通知；问题、回执、握手一条不丢，满了就拒绝新消息并报错。
  async send(type, payload = {}, { secret } = {}) {
    const item = this.prepare(type, payload, secret || this.activeSecret());
    this.enqueue(item);
    await this.flush().catch(() => {});
    return item.mid;
  }
  // 只入发件箱（不发）。调用方可以把它和自己的状态改动放进同一个事务。
  enqueue(item) {
    const outbox = [...(this.store.get('outbox') || []), item];
    while (outbox.length > OUTBOX_LIMIT) {
      const drop = outbox.findIndex(droppable);
      if (drop < 0) throw new Error('发件箱已满（' + OUTBOX_LIMIT + ' 条没发出去）：先检查网络或放行');
      outbox.splice(drop, 1);
    }
    this.store.set('outbox', outbox);
  }
  pendingOutbox() { return (this.store.get('outbox') || []).length; }
  async flush() {
    const outbox = this.store.get('outbox') || [];
    if (!outbox.length) return 0;
    const client = this.client();
    let sent = 0;
    try {
      for (const item of outbox) {
        await client.post(item.channel, item.to, item.mid, item.blob);
        sent += 1;
        this.store.set('outbox', (this.store.get('outbox') || []).filter(x => x.mid !== item.mid));
      }
      this.ok();
    } catch (error) { this.fail(error); throw error; }
    return sent;
  }

  // 拉取发给本端的新消息，逐条解密交给 handle；handle 抛错就停在这条，下轮重试。
  async pull(handle) {
    const config = this.config();
    const secret = this.activeSecret();
    if (!secret) return { received: 0 };
    await this.flush().catch(() => {});
    const link = bridgeCrypto.derive(secret);
    const client = this.client(config.baseUrl);
    let received = 0, more = true, cursor = config.cursor || 0;
    try {
      while (more) {
        const page = await client.fetchMessages(link.channel, this.side, cursor, this.side);
        this.saveStatus({ peerSeen: page.seen && page.seen[this.other] || null, serverTime: page.server_time || null });
        // 服务端通道被清理后重建：序号从头开始，本地游标作废（消息按编号去重，重读无害）。
        const known = this.config().epoch;
        if (page.epoch && known && page.epoch !== known && cursor > 0) { cursor = 0; this.saveConfig({ ...this.config(), cursor: 0, epoch: page.epoch }); more = true; continue; }
        if (page.epoch && !known) this.saveConfig({ ...this.config(), epoch: page.epoch });
        for (const row of page.messages || []) {
          let message = null;
          try { message = bridgeCrypto.open(link, this.side, row.blob); }
          catch { this.saveStatus({ rejected: (this.status().rejected || 0) + 1 }); }
          if (message) { await handle(message, { seq: row.seq, createdAt: row.created_at }); received += 1; }
          cursor = row.seq;
          // 换钥后 handle 已改写配置：游标归新通道，旧通道剩下的消息不再读。
          const latest = this.config();
          if (latest.state !== config.state || this.activeSecret() !== secret) return { received, switched: true };
          this.saveConfig({ ...latest, cursor });
        }
        more = !!page.more;
      }
      // POST 可能被代理拦下而 GET 仍成功；待发项还在时保留上传错误，不能把收件成功当作已送达。
      if (this.pendingOutbox() && this.status().lastError) this.saveStatus({ lastOkAt: this.now() });
      else this.ok();
    } catch (error) { this.fail(error); throw error; }
    return { received };
  }

  ok() { this.saveStatus({ lastOkAt: this.now(), lastError: null, gate: null }); }
  fail(error) {
    const at = this.now();
    const lastError = { code: error && error.code || 'error', message: String(error && error.message || error).slice(0, 300), at };
    this.saveStatus({ lastError, gate: lastError.code === 'gate' ? { since: this.status().gate?.since || at, url: error.gateUrl || this.client().gatePage() } : null });
  }
}

module.exports = { BridgeLink, OTHER, PAIRING_TTL_MS };
