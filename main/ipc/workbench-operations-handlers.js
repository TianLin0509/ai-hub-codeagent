'use strict';

function publicError(error) {
  const code = String(error && error.message || 'operation_failed');
  const known = new Set([
    'invalid_repo_root', 'invalid_file_path', 'invalid_review_decision', 'stale_hunk',
    'invalid_checkpoint_id', 'unsafe_restore_destination', 'restore_destination_exists',
    'review_state_corrupt', 'review_state_unreadable', 'review_state_busy',
    'checkpoint_missing', 'checkpoint_corrupt', 'checkpoint_unreadable',
  ]);
  return known.has(code) ? code : 'operation_failed';
}

function registerWorkbenchOperationsIpc(ipcMain, deps = {}) {
  const service = deps.service;
  if (!service) throw new Error('workbench operations service is required');

  function handle(channel, method) {
    ipcMain.handle(channel, async (_event, payload = {}) => {
      try {
        return await service[method](payload || {});
      } catch (error) {
        deps.logger?.warn?.(`[workbench-operations] ${channel} failed:`, error && error.message);
        return { ok: false, error: publicError(error) };
      }
    });
  }

  // 2026-08-27：改动审阅驾驶舱 UI 已删除，只有 overview 还在用——工作台的
  // 「最近文件」卡靠它拿 Git 变更（Agent 产物那半来自 session 快照）。
  // diff / 审阅决定 / checkpoint / 溯源 / 时间线都是驾驶舱专用，一并撤掉 IPC 面。
  // core/workbench-operations.js 里的实现保留（有独立单测覆盖），将来要重做驾驶舱不用从零写。
  handle('workbench:get-overview', 'overview');
}

module.exports = {
  publicError,
  registerWorkbenchOperationsIpc,
};
