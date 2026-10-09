'use strict';

/**
 * Claude 握手（initialize）的保守超时预算，不是预计加载耗时。
 *
 * 2026-09-18 真实事故：从一个 17.1 MB / 884 条记录的会话分支出群聊成员，
 * 当时 `claude --resume <父会话> --fork-session` 实测 124.6 秒才连上，
 * 但未分段测量，不能把全部耗时归因于历史读取。Hub 的 initialize 等待写死 60 秒，
 * 于是：60 秒判连接失败 → 群聊那条提交被标成「待核对」→ 侧栏亮异常 →
 * 一分钟后引擎其实连上了、照常把这一轮跑完。
 *
 * 当初始化超出预算时，表现是「报错，然后自己好了」——
 * 最容易让人误以为功能坏了的那一种。
 *
 * 全新会话没有历史要载入，仍然是原来的 60 秒，行为不变；只有 resume / fork
 * 才按父会话 transcript 的字节数放宽。每 MB 给多少是从上面那次实测反推的：
 * 17.1 MB 需要 ≥125 秒，约 7.3 秒/MB；这里给 25 秒/MB（约 3 倍余量），
 * 这只是容错余量，不能推导出线性的加载速度。2026-09-19 同一份 11.9 MB
 * 历史副本在隔离配置下实测 1.37 秒完成握手；真实慢启动仍需阶段证据定位。
 */

const fs = require('fs');
const { findTranscriptByCCSessionId } = require('./claude-transcript-locator.js');

// 全新会话的基准，等于历史行为。
const BASE_MS = 60_000;
// 每 MB 历史额外给的时间。
const PER_MB_MS = 25_000;
// 再大也不无限等：超过这个数说明真的不对劲，该报错让人看见。
const MAX_MS = 10 * 60_000;
const MB = 1024 * 1024;

function initializeTimeoutMsForBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return BASE_MS;
  return Math.min(MAX_MS, Math.round(BASE_MS + (size / MB) * PER_MB_MS));
}

function formatMb(bytes) {
  const size = Number(bytes) || 0;
  return size >= MB ? `${(size / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

/**
 * 算出这次启动该等多久，并给一句能放进界面的说明。
 *
 * 找不到父会话文件不是错误：可能是刚迁过目录、或者 provider 把它放在别处。
 * 那种情况回落到基准值，和以前一模一样。
 */
function resolveHandshakeBudget({ resumeSessionId = '', homeDir, statFile } = {}) {
  const id = String(resumeSessionId || '').trim();
  if (!id) return { timeoutMs: BASE_MS, bytes: 0, transcriptPath: null, reason: null };
  let transcriptPath = null;
  let bytes = 0;
  try {
    transcriptPath = findTranscriptByCCSessionId(id, homeDir);
    if (transcriptPath) {
      const stat = typeof statFile === 'function' ? statFile(transcriptPath) : fs.statSync(transcriptPath);
      bytes = Number(stat && stat.size) || 0;
    }
  } catch {
    // 量不到就按基准来；为了量一个超时值而让启动失败是本末倒置。
    transcriptPath = null;
    bytes = 0;
  }
  const timeoutMs = initializeTimeoutMsForBytes(bytes);
  // 只知道在等待 initialize，不能冒充引擎进度，也不能将超时预算当作预计耗时。
  const reason = bytes >= MB
    ? `正在连接 Claude（历史 ${formatMb(bytes)}）`
    : null;
  return { timeoutMs, bytes, transcriptPath, reason };
}

module.exports = {
  BASE_MS,
  MAX_MS,
  PER_MB_MS,
  formatMb,
  initializeTimeoutMsForBytes,
  resolveHandshakeBudget,
};
