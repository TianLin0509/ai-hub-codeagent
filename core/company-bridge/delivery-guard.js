'use strict';
// 把对端的回执送进本机会话时的兜底（2026-10-18，家里 v1.6.517 真机 Q-1018-07）：
// 第 1 轮回执里有 9 个制表符，粘进 Claude 后变成了空格；发送入口按「提交内容和原文只差空白」报 content-mismatch
// （ok:false，不带 unconfirmed / stuck，也不带 error），投递方当成「明确没发进去」，每 60 秒重投一次，
// 会话里实际已经收到 6 份同样的回执，第 2 轮也早发出去了。根因在发送入口对 content-mismatch 的口径
// （受保护链路 core/pty-prompt-submit.js / prompt-submission-receipts.js，先不改），这里在投递方兜底：
//   1. content-mismatch = 内容已进会话（只差空白），按已送达处理、标「有出入」，不再重投；
//   2. 重投前先看目标会话的原生记录里有没有这条回执（按回执第一行全文：真回执「…第 N 轮】」与「…· 没答上】」分开认），有就直接标已送达；
//   3. 同一线程已经从这个会话发出了更晚的一轮、且是在这一轮回执到达之后发的：更早的轮次标已送达（Agent 显然已经看到并接着问了）；
//   4. 结果不明确的失败最多重投 3 次，之后停止，列表里标「可能已送达，未能确认」（补收可在本机重投）；明确没发的按 1→2→5→10 分钟退避一直重试。
// 家里收公司回执（home.js）与公司收家里回复（ask-home.js）共用。
const fs = require('node:fs');

const MAX_DELIVERY_FAILURES = 3;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

// 发送入口的回执是不是「明确没发进去」：没回执、notSent、ok:false 且不是确认迟到 / 卡住 / 只差空白。
// 「只差空白」只信 PTY 提交闭环的回执（终端里的 CLI 把制表符换成空格）；原生后端（claude-stream-json）的 content-mismatch 不算（复审 2026-10-18）。
const NATIVE_BACKENDS = new Set(['claude-stream-json', 'codex-app-server']);
function contentArrivedWithDiff(receipt) {
  if (!receipt || receipt.sendStatus !== 'content-mismatch' || receipt.notSent) return false;
  if (NATIVE_BACKENDS.has(receipt.source) || NATIVE_BACKENDS.has(receipt.acknowledgementSource)) return false;
  return receipt.mode === 'closed-loop';
}
function explicitFailure(receipt) {
  if (!receipt || receipt.notSent) return true;
  if (contentArrivedWithDiff(receipt)) return false;
  return receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck';
}

// 会话的原生记录文件：Claude / CodeAgent 是绑定的 transcriptPath；Codex 按 codexSid 找 rollout。找不到返回 null。
function transcriptFile(meta) {
  if (!meta) return null;
  if (meta.transcriptPath) return meta.transcriptPath;
  if (meta.codexSid) {
    try {
      const parser = require('../codex-transcript-parser');
      return meta.codexSessionsRoot ? parser.findCodexRolloutBySid(meta.codexSid, meta.codexSessionsRoot) : parser.findCodexRolloutBySid(meta.codexSid);
    } catch { return null; }
  }
  return null;
}
// 原生记录里有没有一条「用户发来的消息」含这段文字（Agent 自己的回答里引用了标记不算）：true / false / null（没有记录可查）。
// Claude / CodeAgent 是 "type":"user"，Codex rollout 是 "role":"user" 或 "type":"user_message"。只看最后 16 MB。
const USER_LINE = /"type"\s*:\s*"user(?:_message)?"|"role"\s*:\s*"user"/;
function transcriptHasText(meta, needle, fsModule = fs) {
  const file = transcriptFile(meta);
  if (!file || !needle) return null;
  try {
    const size = fsModule.statSync(file).size;
    let text;
    if (size <= MAX_SCAN_BYTES) text = fsModule.readFileSync(file, 'utf8');
    else {
      const fd = fsModule.openSync(file, 'r');
      try { const buf = Buffer.alloc(MAX_SCAN_BYTES); fsModule.readSync(fd, buf, 0, MAX_SCAN_BYTES, size - MAX_SCAN_BYTES); text = buf.toString('utf8'); }
      finally { fsModule.closeSync(fd); }
    }
    return text.split('\n').some(line => line.includes(needle) && USER_LINE.test(line));
  } catch { return null; }
}

// 投递前的核对：不用再投时返回要落下的字段，否则 null。marker 是回执开头的「【… 编号 · 第 N 轮」。
function alreadyDelivered(t, r, { meta, marker, now, hasText = transcriptHasText }) {
  // 更晚一轮要在这一轮的回执 / 报错到达之后才发出，才说明 Agent 看到了它；补收晚到的回答（更晚一轮早已发出）照常投递（复审 2026-10-18）。
  const arrived = Number(r.reply ? r.replyAt : r.errorAt || r.failedAt) || 0;
  const later = t.rounds.find(x => x.round > r.round && x.sentAt && arrived && x.sentAt >= arrived);
  if (later) {
    return { delivered: true, deliveredAt: null, deliveryError: null, deliveryNote: `这个会话已经就同一编号发出了第 ${later.round} 轮，按已送达处理` };
  }
  if (hasText(meta, marker) === true) return { delivered: true, deliveredAt: now, deliveryError: null, deliveryNote: '会话的原生记录里已有这条回执，按已送达处理' };
  return null;
}
// 投递失败后怎么办。返回 { patch, final }。
// - 明确没发（notSent：会话关了、CLI 没就绪……）：照旧重试，不计入上限，间隔 1→2→5→10 分钟封顶；
// - 结果不明确（发送入口回 ok:false 却没说没发）：最多 3 次，之后停止，标「可能已送达，未能确认」（复审 2026-10-18）。
const RETRY_STEPS_MS = [60000, 2 * 60000, 5 * 60000, 10 * 60000];
function failure(r, message, { notSent = false, now = Date.now() } = {}) {
  if (notSent) {
    const k = (Number(r.deliveryRetries) || 0) + 1;
    return { final: false, patch: { deliveryError: message, deliveryRetries: k, nextTryAt: now + RETRY_STEPS_MS[Math.min(k, RETRY_STEPS_MS.length) - 1] } };
  }
  const n = (Number(r.deliveryFailures) || 0) + 1;
  if (n >= MAX_DELIVERY_FAILURES) {
    return { final: true, patch: { delivered: true, deliveredAt: null, deliveryFailures: n, deliveryUnconfirmed: true,
      deliveryError: `可能已送达，未能确认（发送入口连续 ${n} 次报没发进去：${message}）；停止自动重投` } };
  }
  return { final: false, patch: { deliveryError: message, deliveryFailures: n } };
}
// 收到新的回执或报错时清掉上一份的投递状态（不带到下一份）。
const FRESH_DELIVERY = Object.freeze({ delivered: false, nextTryAt: null, deliveryError: null, deliveryNote: null, deliveryFailures: 0, deliveryRetries: 0, deliveryUnconfirmed: null, deliveryUncertain: null });
// 发送入口报「只差空白」：内容已进会话。
const MISMATCH_NOTE = '内容已进会话（和原文只差空白字符，如制表符被换成空格）';

module.exports = { FRESH_DELIVERY, RETRY_STEPS_MS, MAX_DELIVERY_FAILURES, explicitFailure, contentArrivedWithDiff, transcriptFile, transcriptHasText, alreadyDelivered, failure, MISMATCH_NOTE };
