'use strict';

const defaultSessionArchive = require('../../core/session-archive.js');

function registerArchiveIpc(ipcMain, deps = {}) {
  const sessionArchive = deps.sessionArchive || defaultSessionArchive;
  const searchService = deps.searchService || null;
  const getSearchSnapshot = typeof deps.getSearchSnapshot === 'function'
    ? deps.getSearchSnapshot
    : () => ({ sessions: [], meetings: [] });
  const logger = deps.logger || console;

  ipcMain.handle('list-past-sessions', async (_e, { limit = 50 } = {}) => {
    try {
      return await sessionArchive.listRecent(limit);
    } catch (e) {
      logger.warn('[群聊] list-past-sessions failed:', e.message);
      return [];
    }
  });

  ipcMain.handle('search-past-sessions', async (_e, request = {}) => {
    try {
      if (searchService && typeof searchService.search === 'function') {
        return await searchService.search(request, getSearchSnapshot());
      }
      const { query, limit = 50 } = request;
      return await sessionArchive.searchAcross(query, { limit });
    } catch (e) {
      logger.warn('[群聊] search-past-sessions failed:', e.message);
      if (searchService) {
        return {
          results: [], totalSessions: 0, totalMatches: 0, truncated: false, state: 'error', total: {value:0,relation:'lowerBound'},
          facets: { providers: {}, scopes: {}, projects: [] },
          queryMs: 0,
          error: e.message,
        };
      }
      return { hits: [], truncated: false };
    }
  });

  ipcMain.handle('get-session-search-preview', async (_e, request = {}) => {
    if (!searchService || typeof searchService.preview !== 'function') return null;
    try {
      return await searchService.preview(request);
    } catch (e) {
      logger.warn('[session-search] preview failed:', e.message);
      return { error: e.message, state: 'error' };
    }
  });

  ipcMain.handle('get-session-search-status', async () => {
    if (!searchService || typeof searchService.status !== 'function') {
      return { phase: 'legacy', ready: true, refreshing: false, index: { sessions: 0, documents: 0 } };
    }
    try {
      return await searchService.status();
    } catch (e) {
      logger.warn('[session-search] status failed:', e.message);
      return { phase: 'error', ready: false, refreshing: false, lastError: e.message };
    }
  });

  ipcMain.handle('refresh-session-search', async (_e, request = {}) => {
    if (!searchService || typeof searchService.refresh !== 'function') return null;
    try {
      return await searchService.refresh(getSearchSnapshot(), { force: request.force === true, immediate: request.immediate === true });
    } catch (e) {
      logger.warn('[session-search] refresh failed:', e.message);
      return { phase: 'error', ready: false, refreshing: false, lastError: e.message };
    }
  });
}

module.exports = {
  registerArchiveIpc,
};
