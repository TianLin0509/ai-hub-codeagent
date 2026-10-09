'use strict';
// main/ipc/memory-handlers.js
//
// 记忆面板 + 梦境系统的 IPC。只读数据走 memory-inspector；
// 手动跑一轮沉淀走 dream-consolidation.runConsolidation（与定时调度同一入口）。

const fs = require('fs');
const os = require('os');

const { getHubDataDir } = require('../../core/data-dir.js');
const { getConfig, clearConfigCache, saveConfig, getConfigPath } = require('../../core/hub-config.js');
const memoryInspector = require('../../core/memory-inspector.js');
const dream = require('../../core/dream-consolidation.js');
const { mergeIslandBucket } = require('../../core/claude-memory-link.js');

function appendChangelog(hubDataDir, record) {
  const dir = require('path').join(hubDataDir, 'consolidation');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(require('path').join(dir, 'changelog.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', 'utf8');
}

const PROVIDERS = new Set(['deepseek-api', 'claude-cli', 'codex-cli', 'kimi-cli', 'gemini-cli']);

function registerMemoryIpc(ipcMain, deps) {
  const { workspaceService, logger = console } = deps;
  // 隔离 Hub 验证时 home 也必须指向隔离目录（CLAUDE_HUB_HOME_DIR）——
  // 否则梦境的 memory 孤岛采集会扫真实 home，蒸馏结果会写进真实三件套
  // （2026-08-01 E2E 实测污染的根因，feedback 级教训）。
  const homeDir = process.env.CLAUDE_HUB_HOME_DIR || os.homedir();

  const ctx = () => ({
    homeDir,
    workspaceRoot: workspaceService.getWorkspaceRoot(),
    // 平铺模式下工作根就是会话 cwd，根上的 AGENTS.md 被直接读取而不是被播种出去。
    // 面板要靠这个标志改文案，否则会一直说「seed 源 · 自动播种到未来临时工作区」，
    // 而实际上已经不再有副本可播。
    flatRoot: typeof workspaceService.isFlatWorkRoot === 'function'
      ? workspaceService.isFlatWorkRoot()
      : false,
    hubDataDir: getHubDataDir(),
  });

  ipcMain.handle('memory:get-overview', () => {
    return memoryInspector.getOverview({
      ...ctx(),
      consolidationConfig: getConfig().consolidation,
    });
  });

  ipcMain.handle('memory:get-session-files', (_e, payload) => {
    const cwd = typeof payload === 'string' ? payload : payload && payload.cwd;
    const kind = typeof payload === 'object' && payload ? payload.kind : '';
    const runtimeKind = typeof payload === 'object' && payload ? payload.runtimeKind : '';
    const codexSessionsRoot = typeof payload === 'object' && payload ? payload.codexSessionsRoot : '';
    const codexProfile = typeof payload === 'object' && payload ? payload.codexProfile : '';
    const meetingId = typeof payload === 'object' && payload ? payload.meetingId : '';
    const base = ctx();
    // 旧工作根里的会话：规则链按它自己所在的根截断与核对。
    const ownRoot = cwd && typeof workspaceService.workspaceRootFor === 'function'
      ? workspaceService.workspaceRootFor(cwd)
      : null;
    return memoryInspector.getSessionFiles({
      ...base, ...(ownRoot ? { workspaceRoot: ownRoot } : {}), cwd, kind, runtimeKind, codexSessionsRoot, codexProfile, meetingId,
    });
  });

  // 孤岛桶「一键并入规范库」：机械合并（不是 LLM 蒸馏），行为记入梦境 changelog 可回溯。
  ipcMain.handle('memory:merge-island', (_e, payload) => {
    const { root, slug } = payload || {};
    const result = mergeIslandBucket(root, slug, { homeDir, logger });
    const runId = `island-${Date.now()}`;
    appendChangelog(getHubDataDir(), {
      runId, phase: result.error ? 'error' : 'island-merge',
      root, slug,
      merged: result.merged, conflicts: result.conflicts, deduplicated: result.deduplicated,
      backup: result.backup, error: result.error,
    });
    return result;
  });

  ipcMain.handle('memory:get-changelog', (_e, limit) => {
    return memoryInspector.readChangelog(getHubDataDir(), Math.max(1, Math.min(500, parseInt(limit, 10) || 200)));
  });

  ipcMain.handle('consolidation:get-config', () => {
    return dream.normalizeConsolidationConfig(getConfig().consolidation);
  });

  ipcMain.handle('consolidation:save-config', (_e, patch) => {
    const current = dream.normalizeConsolidationConfig(getConfig().consolidation);
    const next = { ...current };
    const H = (k) => Object.prototype.hasOwnProperty.call(patch || {}, k);
    if (H('enabled')) next.enabled = !!patch.enabled;
    if (H('autoApply')) next.autoApply = !!patch.autoApply;
    if (H('schedule') && /^\d{1,2}:\d{2}$/.test(String(patch.schedule))) next.schedule = String(patch.schedule);
    if (H('provider') && PROVIDERS.has(String(patch.provider))) next.provider = String(patch.provider);
    if (H('model')) next.model = String(patch.model || '').trim() || next.model;
    if (H('maxCandidatesPerRun')) next.maxCandidatesPerRun = parseInt(patch.maxCandidatesPerRun, 10);
    if (H('maxInputCharsPerCandidate')) next.maxInputCharsPerCandidate = parseInt(patch.maxInputCharsPerCandidate, 10);
    const normalized = dream.normalizeConsolidationConfig(next);

    // 只动 consolidation 段，其余配置原样保留——读不出原配置时中止，不静默覆盖。
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8').replace(new RegExp('^\\uFEFF'), ''));
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        return { success: false, error: 'config_read_failed' };
      }
    }
    existing.consolidation = normalized;
    saveConfig(existing);
    clearConfigCache();
    logger.log?.(`[dream] 配置已保存：provider=${normalized.provider} enabled=${normalized.enabled} schedule=${normalized.schedule} autoApply=${normalized.autoApply}`);
    return { success: true, config: normalized };
  });

  ipcMain.handle('consolidation:run-now', async () => {
    try {
      const summary = await dream.runConsolidation({
        ...ctx(),
        getHubConfig: getConfig,
        logger,
        trigger: 'manual',
      });
      return { success: true, summary };
    } catch (error) {
      logger.warn?.('[dream] 手动沉淀失败:', error && error.message);
      return { success: false, error: String(error && error.message || error) };
    }
  });
}

module.exports = { registerMemoryIpc };
