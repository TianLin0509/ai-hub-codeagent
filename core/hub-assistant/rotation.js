'use strict';
// 助理会话的去留（纯函数，便于测试与调参）。
// 2026-10-05 用户：助理始终是同一个会话，不再自动换班新开会话——侧栏不该越积越多「助理」会话。
// 上下文变长交给 CLI 自带的压缩（Claude Code、Codex 快满时都会自动 compact，Claude 窗口可到 1M）。
// 保留每天一次的「交接记录」：同一会话空闲满 2 小时或跨过凌晨 4 点后，让它复盘并写交接，存进交接文件，
// 供压缩后或用户手动「新开助理」时接续。手动新开仍可用，旧会话保留可查。
const IDLE_MS = 2 * 3600 * 1000;
const DAILY_HOUR = 4;
const MIN_TOKENS = 30000;

function dailyBoundary(now, hour = DAILY_HOUR) {
  const d = new Date(now); d.setHours(hour, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}
// 返回写交接记录的原因：idle（空闲满 2 小时）、daily（跨过每天 4 点）；对话太少、上次记录后没再用过、今天已写过则为 null。
function checkpointReason({ tokens, lastActiveAt, lastCheckpointAt = 0, now = Date.now() }) {
  if (!tokens || tokens < MIN_TOKENS || !lastActiveAt || lastActiveAt <= lastCheckpointAt) return null;
  if (lastCheckpointAt >= dailyBoundary(now)) return null;
  if (now - lastActiveAt >= IDLE_MS) return 'idle';
  if (lastActiveAt < dailyBoundary(now)) return 'daily';
  return null;
}
const REASON_LABELS = { idle: '空闲超过 2 小时', daily: '跨过每天 4 点', manual: '手动新开' };
module.exports = { IDLE_MS, DAILY_HOUR, MIN_TOKENS, dailyBoundary, checkpointReason, REASON_LABELS };
