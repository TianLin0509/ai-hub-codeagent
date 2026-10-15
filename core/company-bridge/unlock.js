'use strict';
// 公司版「AI特战队专用功能」的隐藏入口（2026-10-15 用户要求）：设置菜单默认不显示这一项，
// 菜单弹开时直接在键盘上敲出口令才出现；一台电脑解锁一次，以后一直显示。没有输入框，也没有任何提示。
// 公司版代码在公开仓库里：这里只放加盐后的摘要，不放口令原文。界面和主进程用同一个函数核对。
const { createHash, timingSafeEqual } = require('node:crypto');

const SALT = '201262fd2bf38ed155a3d56b66b716a2';
const DIGEST = '1ba04f5bf8bb8e3352649f06bedd31a91e525013e8dea1c09bf0bf5eb87d5571';
const UNLOCK_LENGTH = 11;

function unlockDigest(text) { return createHash('sha256').update(SALT + ':' + String(text || '').toLowerCase()).digest('hex'); }
// expected 只给测试用（换一个测试口令的摘要），平时用内置摘要。
function matchesUnlock(text, expected = DIGEST) {
  const s = String(text || '');
  if (s.length !== UNLOCK_LENGTH) return false;
  return timingSafeEqual(Buffer.from(unlockDigest(s), 'hex'), Buffer.from(expected || DIGEST, 'hex'));
}

module.exports = { matchesUnlock, unlockDigest, UNLOCK_LENGTH };
