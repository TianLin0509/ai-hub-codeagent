'use strict';
// 昨日之我第一次全量建索引让路给正在用电脑的人（2026-10-14）。
//
// 公司新装电脑「先卡后黑屏」都出在刚装好的头几个小时（启动后 2–5 分钟），之后再也复现不了；那段时间
// Hub 自己发起的唯一大块后台活，就是第一次把电脑上所有 CLI 记录读一遍建索引（启动 30 秒到 5 分半之间
// 开始）。本机用全新数据目录 + 22 GB 真实记录实测，界面不受影响；但公司电脑的防泄漏软件会拦每一次读
// 文件，本机模拟不了。所以：
//   1. 第一次建好之前，后台建索引要等电脑键鼠闲置够久（默认 3 分钟）才开始；用户自己打开昨日之我
//      搜索仍然立即开始。建好后在数据目录 cache/ 留一个标记，以后照常增量更新。
//   2. 索引没建好期间的阶段变化和建好那一刻写进 window-events.log，出事时能对上当时是不是正在建索引。
// HUB_SESSION_SEARCH_FIRST_BUILD_IDLE_SEC 改闲置秒数，0 表示不等。
const fs = require('fs');
const path = require('path');

const DEFAULT_IDLE_SEC = 180;
const MARKER = 'session-search-first-build.json';

function markerPath(dataDir) { return path.join(dataDir, 'cache', MARKER); }

function firstBuildDone(dataDir) {
  try { return fs.statSync(markerPath(dataDir)).isFile(); } catch { return false; }
}

function markFirstBuildDone(dataDir, detail = {}) {
  try {
    fs.mkdirSync(path.dirname(markerPath(dataDir)), { recursive: true });
    fs.writeFileSync(markerPath(dataDir), JSON.stringify({ at: new Date().toISOString(), ...detail }) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

function idleSecondsSetting(env = process.env) {
  const raw = String(env.HUB_SESSION_SEARCH_FIRST_BUILD_IDLE_SEC ?? '').trim();
  if (raw === '') return DEFAULT_IDLE_SEC;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_SEC;
}

// 等电脑键鼠闲置 idleSec 秒（getIdleSeconds = powerMonitor.getSystemIdleTime）。拿不到闲置时间就不等。
async function waitForUserIdle({ getIdleSeconds, idleSec, pollMs = 15000, delay, shouldStop = () => false }) {
  const started = Date.now();
  for (;;) {
    if (shouldStop()) return { stopped: true, waitedMs: Date.now() - started };
    let idle;
    try { idle = Number(getIdleSeconds()); } catch { idle = NaN; }
    if (!Number.isFinite(idle) || idle >= idleSec) return { idleSec: Number.isFinite(idle) ? idle : null, waitedMs: Date.now() - started };
    await delay(pollMs);
  }
}

// window-events.log 里一行能看懂的索引状态。
function statusLogDetail(status = {}) {
  const index = status.index || {};
  return {
    phase: status.phase || null,
    ready: !!status.ready,
    refreshing: !!status.refreshing,
    sessions: Number(index.sessions) || 0,
    documents: Number(index.documents) || 0,
    ...(status.lastError ? { error: String(status.lastError).slice(0, 200) } : {}),
  };
}

module.exports = { DEFAULT_IDLE_SEC, markerPath, firstBuildDone, markFirstBuildDone, idleSecondsSetting, waitForUserIdle, statusLogDetail };
