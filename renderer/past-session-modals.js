const { latestActivityTime } = require('../core/session-recency.js');
const { createGlobalSessionSearch } = require('./global-session-search.js');
const { formatBeijingDateTime } = require('../core/beijing-time.js');

function highlightMatch(text, query, escapeHtml) {
  if (!query) return escapeHtml(text);
  const ql = query.toLowerCase();
  const tl = text.toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    const hit = tl.indexOf(ql, i);
    if (hit < 0) { out.push(escapeHtml(text.slice(i))); break; }
    out.push(escapeHtml(text.slice(i, hit)));
    out.push('<mark>' + escapeHtml(text.slice(hit, hit + query.length)) + '</mark>');
    i = hit + query.length;
  }
  return out.join('');
}

function normalizeTranscriptPath(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function codexSessionScopeKey(session) {
  const profile = String(session && session.codexProfile || '').trim().toLowerCase();
  if (profile) return `profile:${profile}`;
  const sessionsRoot = normalizeTranscriptPath(session && session.codexSessionsRoot);
  if (sessionsRoot) return `root:${sessionsRoot}`;
  // Pre-profile Hub state always used the default ~/.codex account.
  return 'profile:default';
}

function findReusableClaudeSession(sessionValues, native = {}) {
  const ccSessionId = String(native.sessionId || '').trim();
  const transcriptPath = normalizeTranscriptPath(native.path);
  const matches = [...(sessionValues || [])].filter((session) => {
    if (!session || !['claude', 'claude-resume'].includes(session.kind)) return false;
    if (ccSessionId && session.ccSessionId === ccSessionId) return true;
    return transcriptPath
      && normalizeTranscriptPath(session.transcriptPath) === transcriptPath;
  });
  matches.sort((a, b) => {
    const aLive = a.status !== 'dormant' ? 1 : 0;
    const bLive = b.status !== 'dormant' ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return latestActivityTime(b, b.updatedAt) - latestActivityTime(a, a.updatedAt);
  });
  return matches[0] || null;
}

function nativeTranscriptSessionKey(session) {
  if (!session || session.meetingId) return null;
  const kind = String(session.kind || '').replace(/-resume$/, '');
  if (kind === 'deepseek' && session.codexSid) {
    return `deepseek:codex:${codexSessionScopeKey(session)}:${session.codexSid}`;
  }
  if ((kind === 'claude' || kind === 'deepseek') && session.ccSessionId) {
    return `${kind}:cc:${session.ccSessionId}`;
  }
  if (kind === 'codex' && session.codexSid) {
    return `codex:${codexSessionScopeKey(session)}:${session.codexSid}`;
  }
  if (kind === 'gemini' && session.geminiChatId) return `gemini:${session.geminiChatId}`;
  if (kind === 'kimi' && session.kimiSid) return `kimi:${session.kimiSid}`;
  return null;
}

function collapseDormantNativeDuplicates(sessionMap) {
  if (!sessionMap || typeof sessionMap.values !== 'function') return [];
  const groups = new Map();
  for (const session of sessionMap.values()) {
    const key = nativeTranscriptSessionKey(session);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }

  const removed = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const live = group.filter(session => session.status !== 'dormant');
    // Never collapse two live PTYs.  They may have been deliberately opened in
    // parallel; only dormant shells are safe to consolidate as sidebar state.
    if (live.length > 1) continue;
    const ranked = [...group].sort((a, b) => {
      const aLive = a.status !== 'dormant' ? 1 : 0;
      const bLive = b.status !== 'dormant' ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;
      return latestActivityTime(b, b.updatedAt) - latestActivityTime(a, a.updatedAt);
    });
    const keep = ranked[0];
    for (const duplicate of ranked.slice(1)) {
      if (duplicate.status !== 'dormant') continue;
      keep.pinned = !!(keep.pinned || duplicate.pinned);
      keep.bottomed = !keep.pinned && !!(keep.bottomed || duplicate.bottomed);
      keep.unreadCount = Math.max(Number(keep.unreadCount || 0), Number(duplicate.unreadCount || 0));
      keep.createdAt = Math.min(
        Number(keep.createdAt || keep.lastMessageTime || Date.now()),
        Number(duplicate.createdAt || duplicate.lastMessageTime || Date.now()),
      );
      if (!keep.cwd && duplicate.cwd) keep.cwd = duplicate.cwd;
      if (!keep.transcriptPath && duplicate.transcriptPath) keep.transcriptPath = duplicate.transcriptPath;
      for (const field of [
        'codexSessionsRoot',
        'codexProfile',
        'codexProfileLabel',
        'mcpProfile',
        'codexSpeedTier',
      ]) {
        if (keep[field] == null && duplicate[field] != null) keep[field] = duplicate[field];
      }
      if (!keep.userRenamed && duplicate.userRenamed) {
        keep.title = duplicate.title;
        keep.userRenamed = true;
        keep.autoTitleGenerated = false;
      }
      sessionMap.delete(duplicate.id);
      removed.push({ removedId: duplicate.id, keptId: keep.id });
    }
  }
  return removed;
}

function createPastSessionModals({
  document,
  window = document.defaultView || globalThis,
  ipcRenderer,
  clipboard = null,
  escapeHtml,
  getSessions,
  getLocalTitles = null,
  selectSession,
  openSearchHit,
  searchCardRenderer = null,
  openSearchPath = null,
}) {
  const resumeModalEl = document.getElementById('resume-modal');
  const resumeListEl = document.getElementById('resume-list');
  const resumeFilterEl = document.getElementById('resume-filter');

  let resumeItems = [];

  function renderResumeList(items) {
    if (!items || items.length === 0) {
      resumeListEl.innerHTML = '<div class="modal-empty">No past sessions found.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const existing = findReusableClaudeSession(
        typeof getSessions === 'function' ? getSessions().values() : [],
        it,
      );
      const row = document.createElement('div');
      row.className = 'modal-row';
      const mtimeStr = it.mtime ? formatBeijingDateTime(it.mtime) : '';
      const preview = it.firstUserMessage || '(no user prompt captured)';
      const modelShort = (it.model || '').replace(/^claude-/, '').replace(/-\d+$/, '');
      row.innerHTML = `
        <div class="modal-row-main">
          <span class="modal-row-preview">${escapeHtml(preview)}</span>
        </div>
        <div class="modal-row-meta">
          <span class="modal-meta-time">${escapeHtml(mtimeStr)}</span>
          ${it.turnCount ? `<span class="modal-meta-chip">${it.turnCount}T</span>` : ''}
          ${modelShort ? `<span class="modal-meta-chip">${escapeHtml(modelShort)}</span>` : ''}
          ${existing ? '<span class="modal-meta-chip">Hub 已有</span>' : ''}
          ${it.cwd ? `<span class="modal-meta-cwd" title="${escapeHtml(it.cwd)}">${escapeHtml(it.cwd)}</span>` : ''}
        </div>
      `;
      row.addEventListener('click', async () => {
        closeResumeModal();
        const reusable = findReusableClaudeSession(
          typeof getSessions === 'function' ? getSessions().values() : [],
          it,
        );
        if (reusable && typeof selectSession === 'function') {
          await selectSession(reusable.id, { forceScrollBottom: true });
          return;
        }
        await ipcRenderer.invoke('create-session', {
          kind: 'claude-resume',
          opts: { resumeCCSessionId: it.sessionId, resumeTranscriptPath: it.path || undefined, cwd: it.cwd || undefined },
        });
      });
      frag.appendChild(row);
    }
    resumeListEl.innerHTML = '';
    resumeListEl.appendChild(frag);
  }

  function openResumeModal() {
    resumeModalEl.style.display = 'flex';
    resumeFilterEl.value = '';
    resumeListEl.innerHTML = '<div class="modal-empty">Scanning…</div>';
    requestAnimationFrame(() => resumeFilterEl.focus());
    ipcRenderer.invoke('list-past-sessions', { limit: 50 }).then((items) => {
      resumeItems = items || [];
      renderResumeList(resumeItems);
    }).catch(() => {
      resumeListEl.innerHTML = '<div class="modal-empty">Scan failed.</div>';
    });
  }

  function closeResumeModal() {
    resumeModalEl.style.display = 'none';
  }

  const globalSearch = createGlobalSessionSearch({
    document,
    window,
    ipcRenderer,
    clipboard,
    getLocalTitles,
    cardRenderer: searchCardRenderer,
    openPath: openSearchPath,
    openHit: typeof openSearchHit === 'function' ? openSearchHit : async () => {},
  });
  const openSearchModal = globalSearch.open;
  const closeSearchModal = globalSearch.close;

  resumeFilterEl.addEventListener('input', () => {
    const q = resumeFilterEl.value.trim().toLowerCase();
    if (!q) { renderResumeList(resumeItems); return; }
    const filtered = resumeItems.filter(it => {
      const hay = ((it.firstUserMessage || '') + ' ' + (it.cwd || '') + ' ' + (it.model || '')).toLowerCase();
      return hay.includes(q);
    });
    renderResumeList(filtered);
  });

  document.getElementById('resume-modal-close').addEventListener('click', closeResumeModal);
  resumeModalEl.addEventListener('click', (e) => {
    if (e.target === resumeModalEl) closeResumeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (resumeModalEl.style.display === 'flex') {
        e.preventDefault(); closeResumeModal();
      }
    }
  });

  return {
    openResumeModal,
    openSearchModal,
    closeResumeModal,
    closeSearchModal,
  };
}

module.exports = {
  createPastSessionModals,
  highlightMatch,
  findReusableClaudeSession,
  nativeTranscriptSessionKey,
  collapseDormantNativeDuplicates,
};
