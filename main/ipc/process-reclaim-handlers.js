'use strict';

// 全机残留回收的 IPC 层。
//
// v1 刻意只读：Hub 自己**不杀任何进程**，只出清单和一份可审阅的预演脚本。
// 先让判据在真实数据上跑一段时间、确认零误判，再考虑放开真执行。
// 误杀的代价是实打实的——把正在跑的 agent 会话外壳当成垃圾关掉，
// 那个会话正在做的活就没了，所以这一步的信任必须靠时间换。

const fs = require('fs');
const path = require('path');

const { createProcessInspector } = require('../../core/process-inspector.js');
const { readHubInstances, classifyInstances } = require('../../core/hub-instance-registry.js');
const { buildReclaimReport, isHubProcess } = require('../../core/process-reclaim.js');

// Windows PowerShell 5.1 读 .ps1 时按系统 ANSI 码页解码，没有 BOM 的 UTF-8
// 中文会整段乱码并直接把脚本解析崩掉（实测：Unexpected token）。
// 所以落盘必须带 BOM——这也是为什么脚本要由 Hub 存文件而不是让用户复制粘贴。
const UTF8_BOM = '﻿';

// 判忙闲要靠两次采样之间的 CPU 增量，所以第一次扫描得连采两次。
// 之后基线留在 inspector 里，后续扫描单采即可。
const BASELINE_GAP_MS = 1_200;

function escapeSingleQuotes(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

// 生成预演脚本。用户可以整段读完再决定要不要自己跑——这是 v1 的核心交付：
// 不替用户动手，但把"该关哪些、凭什么"完整交出去。
function buildReclaimScript(items, meta = {}) {
  const rows = [];
  let totalProcesses = 0;
  let totalBytes = 0;

  for (const item of items) {
    totalBytes += Number(item.wsBytes) || 0;
    const label = `${item.label || '残留'}${item.detail ? ` ${item.detail}` : ''}`;
    for (const member of (item.members || [])) {
      totalProcesses += 1;
      rows.push(
        `  @{ ProcessId = ${member.pid}; StartedAt = ${member.startedAt}; `
        + `Name = '${escapeSingleQuotes(member.name)}'; Label = '${escapeSingleQuotes(label)}' }`,
      );
    }
  }

  const generatedAt = new Date(Number(meta.generatedAt) || Date.now()).toISOString();
  const megabytes = (totalBytes / 1048576).toFixed(0);

  return `# AI Hub · 全机残留回收（预演脚本）
# 生成时间 ${generatedAt}
# 共 ${items.length} 项 / ${totalProcesses} 个进程 / 约 ${megabytes} MB
#
# 这份脚本由 Hub 生成但不由 Hub 执行。请先通读再决定是否运行。
# 每个进程都会先核对启动时间：对不上就跳过。Windows 会回收复用 PID，
# 只认 PID 不认启动时间的话，可能杀掉一个刚好占了同一个号的新程序。
#
# 默认是预演：跑一遍只会打印"会关掉哪些"，什么都不动。
# 通读确认无误后，把下面这行改成 $false，再跑一次才真的执行。
$WhatIfOnly = $true

$targets = @(
${rows.join(',\n')}
)

$killed = 0; $skipped = 0
foreach ($t in $targets) {
  $p = Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue
  if (-not $p) { Write-Host ("跳过 {0} ({1}) - 已经不在了" -f $t.ProcessId, $t.Name); $skipped++; continue }

  $actualStart = 0
  try { $actualStart = [int64]([System.DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } catch {}
  if ($t.StartedAt -gt 0 -and $actualStart -gt 0 -and [Math]::Abs($actualStart - $t.StartedAt) -gt 2000) {
    Write-Host ("跳过 {0} ({1}) - 启动时间对不上，PID 已被复用" -f $t.ProcessId, $t.Name) -ForegroundColor Yellow
    $skipped++; continue
  }

  if ($WhatIfOnly) {
    Write-Host ("[预演] 会关闭 {0} ({1}) - {2}" -f $t.ProcessId, $t.Name, $t.Label)
  } else {
    try {
      Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop
      Write-Host ("已关闭 {0} ({1})" -f $t.ProcessId, $t.Name) -ForegroundColor Green
      $killed++
    } catch {
      Write-Host ("失败 {0} ({1}) - {2}" -f $t.ProcessId, $t.Name, $_.Exception.Message) -ForegroundColor Red
      $skipped++
    }
  }
}

if ($WhatIfOnly) {
  Write-Host ""
  Write-Host "以上是预演，什么都没动。确认无误后把 \`$WhatIfOnly 改成 \`$false 再跑一次。" -ForegroundColor Cyan
} else {
  Write-Host ""
  Write-Host ("完成：关闭 {0} 个，跳过 {1} 个" -f $killed, $skipped) -ForegroundColor Cyan
}
`;
}

function collectItems(report, rootPids) {
  const wanted = new Set((rootPids || []).map(Number).filter(Boolean));
  const all = [
    ...(report.groups.deadHub || []).flatMap(bucket => bucket.items || []),
    ...(report.groups.endedSession || []),
    ...(report.groups.unattributed || []),
  ];
  if (wanted.size === 0) return all;
  return all.filter(item => wanted.has(Number(item.rootPid)));
}

function registerProcessReclaimIpc(ipcMain, deps = {}) {
  const logger = deps.logger || console;
  const inspector = deps.inspector || createProcessInspector({ logger });
  const getSessionManager = typeof deps.getSessionManager === 'function' ? deps.getSessionManager : () => null;
  const getDataDir = typeof deps.getDataDir === 'function' ? deps.getDataDir : () => undefined;
  const processRef = deps.processRef || process;
  const now = deps.now || Date.now;
  const delay = deps.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));

  let lastReport = null;
  let hasBaseline = false;

  async function scan(options = {}) {
    const force = options.force !== false;
    await inspector.snapshot({ force });
    if (!hasBaseline) {
      // 第一次扫：再采一次才有 CPU 增量，否则忙闲一律「未知」。
      await delay(BASELINE_GAP_MS);
      hasBaseline = true;
    }
    const snapshot = await inspector.snapshot({ force: true });

    const { instances, dataDir } = readHubInstances({ dataDir: getDataDir() });
    const { alive, dead } = classifyInstances(instances, {
      byPid: snapshot.byPid,
      isHubProcess,
      now: now(),
    });

    const sessionManager = getSessionManager();
    const liveSessionsKnown = !!(sessionManager && typeof sessionManager.listLivePtyPids === 'function');
    const liveSessionPids = liveSessionsKnown ? sessionManager.listLivePtyPids() : [];

    const report = buildReclaimReport({
      snapshot,
      aliveHubs: alive,
      deadHubs: dead,
      selfPid: processRef.pid,
      liveSessionPids,
      liveSessionsKnown,
      now: now(),
    });

    report.dataDir = dataDir;
    report.selfPid = processRef.pid;
    report.liveSessionCount = liveSessionPids.length;
    // 一并回传，好让 E2E 能直接断言「活跃会话 ∩ 可回收 = ∅」这条安全底线。
    report.liveSessionPids = liveSessionPids;
    lastReport = report;
    return report;
  }

  ipcMain.handle('get-process-reclaim-report', async (_event, options = {}) => {
    try {
      return await scan(options);
    } catch (err) {
      logger.warn('[群聊] 残留扫描失败:', err && err.message);
      return { ok: false, error: String((err && err.message) || err), sampledAt: now() };
    }
  });

  ipcMain.handle('build-process-reclaim-script', async (_event, options = {}) => {
    try {
      const report = lastReport || await scan({ force: true });
      const items = collectItems(report, options && options.rootPids);
      if (items.length === 0) return { ok: false, error: 'no-items' };
      return {
        ok: true,
        script: buildReclaimScript(items, { generatedAt: now() }),
        itemCount: items.length,
        processCount: items.reduce((sum, item) => sum + (item.processCount || 0), 0),
        wsBytes: items.reduce((sum, item) => sum + (item.wsBytes || 0), 0),
      };
    } catch (err) {
      logger.warn('[群聊] 预演脚本生成失败:', err && err.message);
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('save-process-reclaim-script', async (_event, options = {}) => {
    try {
      const report = lastReport || await scan({ force: true });
      const items = collectItems(report, options && options.rootPids);
      if (items.length === 0) return { ok: false, error: 'no-items' };

      const script = buildReclaimScript(items, { generatedAt: now() });
      const outDir = path.join(report.dataDir || getDataDir() || process.cwd(), 'reclaim');
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const filePath = path.join(outDir, `reclaim-preview-${stamp}.ps1`);
      fs.writeFileSync(filePath, UTF8_BOM + script, 'utf8');

      return {
        ok: true,
        filePath,
        itemCount: items.length,
        processCount: items.reduce((sum, item) => sum + (item.processCount || 0), 0),
        wsBytes: items.reduce((sum, item) => sum + (item.wsBytes || 0), 0),
      };
    } catch (err) {
      logger.warn('[群聊] 预演脚本落盘失败:', err && err.message);
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  return { scan, getLastReport: () => lastReport };
}

module.exports = {
  BASELINE_GAP_MS,
  UTF8_BOM,
  buildReclaimScript,
  collectItems,
  registerProcessReclaimIpc,
};
