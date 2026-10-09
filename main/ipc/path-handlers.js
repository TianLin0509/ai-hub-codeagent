'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { shell } = require('electron');
const { searchPreviewPaths } = require('../../core/preview-path-search.js');
const { listWorkspaceDirectory } = require('../../core/file-manager-directory.js');


const READ_FILE_EXTS = new Set([
  '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.txt', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bat', '.ps1', '.xml', '.sql', '.r', '.rb', '.php',
  '.swift', '.kt', '.lua', '.zig', '.asm', '.css', '.scss', '.less',
]);

// 社区版不附带公司文件中转；交付入口在界面上已移除，这里保留同名函数只为接口不变。
const runCompanyDrop = async () => ({ error: '社区版未包含这个交付工具', code: 'unavailable' });

function registerPathIpc(ipcMain, deps = {}) {
  require('./file-manager-handlers.js').registerFileManagerIpc(ipcMain, {
    runCompanyDrop: deps.runCompanyDrop || runCompanyDrop,
    ...deps,
  });
  const syncRunner = deps.runCompanyDrop || runCompanyDrop;
  const previewPathSearcher = deps.searchPreviewPaths || searchPreviewPaths;
  const directoryLister = deps.listWorkspaceDirectory || listWorkspaceDirectory;
  ipcMain.handle('open-path', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath.trim()) return 'empty path';
    try {
      return await shell.openPath(filePath);
    } catch (e) {
      return String(e && e.message || e);
    }
  });

  ipcMain.handle('read-file', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { error: 'invalid path' };
    const ext = path.extname(filePath).toLowerCase();
    if (!READ_FILE_EXTS.has(ext)) return { error: 'unsupported extension' };
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 5 * 1024 * 1024) return { error: 'file too large (>5MB)' };
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { content };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });

  ipcMain.handle('preview:search-paths', async (_e, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { results: [], source: 'invalid', truncated: false, indexedCount: 0 };
    }
    try {
      return await previewPathSearcher({
        query: typeof payload.query === 'string' ? payload.query : '',
        cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
        limit: payload.limit,
      });
    } catch (error) {
      return {
        results: [],
        source: 'error',
        truncated: false,
        indexedCount: 0,
        error: String(error && error.message || error),
      };
    }
  });

  ipcMain.handle('file-manager:list-directory', async (_e, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'invalid payload', code: 'invalid_payload', entries: [] };
    }
    try {
      return await directoryLister({
        root: typeof payload.root === 'string' ? payload.root : '',
        directory: typeof payload.directory === 'string' ? payload.directory : '',
        limit: payload.limit,
      });
    } catch (error) {
      return {
        ok: false,
        error: String(error && error.message || error),
        code: 'read_failed',
        entries: [],
      };
    }
  });

  ipcMain.handle('open-external-url', async (_e, url) => {
    if (!url || !/^https?:\/\//i.test(url)) return { success: false };
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle('show-in-folder', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      return { error: 'invalid path' };
    }
    if (!fs.existsSync(filePath)) return { error: 'file not found' };
    try {
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });

  ipcMain.handle('clipboard-copy-file', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      return { error: 'invalid path' };
    }
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() && !stat.isDirectory()) {
        return { error: 'not a file or directory' };
      }
    } catch (e) {
      return { error: 'file not found' };
    }

    const fakeClipboard = require('../../core/e2e-desktop-sandbox').activeFakeClipboard();
    if (fakeClipboard) { fakeClipboard.writeFiles([filePath]); return { success: true }; }

    if (process.platform !== 'win32') {
      return { error: 'platform not supported' };
    }

    return new Promise((resolve) => {
      const escaped = filePath.replace(/'/g, "''");
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Set-Clipboard -LiteralPath '${escaped}'`,
      ], { windowsHide: true });

      let stderr = '';
      ps.stderr.on('data', (d) => { stderr += d.toString(); });
      ps.on('close', (code) => {
        if (code === 0) resolve({ success: true });
        else resolve({ error: stderr.trim() || `exit ${code}` });
      });
      ps.on('error', (e) => resolve({ error: String(e && e.message || e) }));
    });
  });

}

module.exports = {
  READ_FILE_EXTS,
  registerPathIpc,
  runCompanyDrop,
};
