'use strict';
// 定时任务（到点提醒、21:00 备忘清单、早晚秘书）由哪个 Hub 进程负责。
// 2026-10-09 修复：之前借用「助理会话此刻是否开着」做判断，Hub 重启后在用户第一次用助理之前，
// 这三样都会静默跳过（10-09 凌晨发现：生产 Hub 00:51 重启后，若 8:00 前没用过助理，当天计划会被跳过）。现在改为：启动时登记进程号，最后启动的 Hub 负责；
// 助理会话没开不要紧，派活时会自动拉起。两个 Hub 共用一份数据时仍只有一个触发，不会重复提醒。
function claimTimers(store, pid = process.pid, now = Date.now()) { store.set('timerOwner', { pid, at: now }); }
function ownsTimers(store, pid = process.pid) { const o = store.get('timerOwner'); return !o || o.pid === pid; }
module.exports = { claimTimers, ownsTimers };
