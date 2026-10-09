function createShellController({
  document,
  menuEl,
  resumeMenuEl,
  contextMenuEl,
  termCtxMenuEl,
  terminalCache,
  terminalPanelEl,
  emptyStateEl,
  closeTerminalSearch,
  closePreviewPanel,
  closeMeetingPanel,
  setActiveSessionId,
  setActiveMeetingId,
  applySidebarCollapsed,
  preserveAndClearTerminalPanel,
  applyViewMode,
  renderSessionList,
  suspendTerminalRenderer,
}) {
  function hideEscapeOverlayTargets() {
    for (const el of [
      menuEl,
      resumeMenuEl,
      contextMenuEl,
      termCtxMenuEl,
      document.getElementById('options-menu'),
    ]) {
      if (el) el.style.display = 'none';
    }

    for (const id of ['resume-modal', 'search-modal']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }

    for (const el of document.querySelectorAll('.config-modal-overlay, .pair-modal-overlay, .meeting-create-modal-overlay')) {
      el.classList.add('hidden');
    }

    if (typeof closeTerminalSearch === 'function') closeTerminalSearch();
  }

  function restoreLauncherShell() {
    for (const [, cached] of terminalCache) {
      if (cached && cached.container) cached.container.style.display = 'none';
      if (typeof suspendTerminalRenderer === 'function') suspendTerminalRenderer(cached);
    }

    preserveAndClearTerminalPanel();
    if (emptyStateEl) {
      emptyStateEl.style.display = '';
      terminalPanelEl.insertBefore(emptyStateEl, terminalPanelEl.firstChild);
    }
    terminalPanelEl.classList.add('home-active');

    const overlay = document.getElementById('msg-overlay');
    if (overlay) {
      overlay.innerHTML = '';
      overlay.classList.add('hidden');
    }

    terminalPanelEl.style.display = '';
    if (typeof applyViewMode === 'function') applyViewMode('pty');
  }

  function escapeToHome() {
    try { hideEscapeOverlayTargets(); } catch (err) { console.warn('[escape-home] hide overlays failed:', err); }
    try { if (typeof closePreviewPanel === 'function') closePreviewPanel(); } catch (err) { console.warn('[escape-home] close preview failed:', err); }
    try { if (typeof closeMeetingPanel === 'function') closeMeetingPanel(); } catch (err) { console.warn('[escape-home] close meeting failed:', err); }

    setActiveSessionId(null);
    setActiveMeetingId(null);
    applySidebarCollapsed(false);
    restoreLauncherShell();
    renderSessionList();
  }

  return {
    hideEscapeOverlayTargets,
    restoreLauncherShell,
    escapeToHome,
  };
}

module.exports = { createShellController };
