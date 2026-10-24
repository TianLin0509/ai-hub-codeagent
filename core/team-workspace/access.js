'use strict';
const { scryptSync, timingSafeEqual } = require('node:crypto');
class TeamAccess {
  constructor({ verifier = require('./access-verifier.json'), now = Date.now } = {}) {
    this.verifier = verifier; this.now = now; this.open = false; this.failures = 0; this.retryAt = 0;
  }
  status() { return { unlocked: this.open }; }
  assert() { if (!this.open) throw Error('团队私人入口尚未解锁'); }
  unlock(text) {
    if (this.now() < this.retryAt) throw Error('口令尝试过多，请稍后再试');
    const valid = typeof text === 'string' && text.length >= 16 && text.length <= 128;
    const expected = Buffer.from(this.verifier.digest, 'hex');
    const actual = valid ? scryptSync(text, this.verifier.salt, 32) : Buffer.alloc(32);
    if (!valid || expected.length !== 32 || !timingSafeEqual(actual, expected)) {
      this.failures++; if (this.failures >= 5) this.retryAt = this.now() + 60000;
      throw Error('口令不正确');
    }
    this.open = true; this.failures = 0; this.retryAt = 0; return this.status();
  }
  lock() { this.open = false; return this.status(); }
}
module.exports = { TeamAccess };
