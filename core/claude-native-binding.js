'use strict';

function bindClaudeNativeSession(manager, id, driver) {
  const current = () => {
    const entry = manager.sessions.get(id);
    return entry?.pty === driver ? entry : null;
  };
  const publish = () => {
    const entry = current();
    if (!entry) return;
    // A new CLI history can appear after initialization. Bind its exact UUID
    // for cumulative usage only; the native snapshot remains execution truth.
    if (!entry.info.transcriptPath) {
      try {
        const file = driver.historyPath();
        if (file) entry.info.transcriptPath = file;
      } catch (error) {
        driver.emit('diagnostic', { type: 'history-path-error', message: error.message });
      }
    }
    manager.emit('session-updated', manager._toPublic(entry.info));
  };
  driver.on('state', snapshot => {
    const entry = current();
    if (!entry) return;
    const info = entry.info;
    if (info.nativeRuntime?.configurationChange?.operation === 'apply_flag_settings' && !snapshot.configurationChange) {
      info.fastMode = snapshot.fastMode;
    }
    if (info.nativeRuntime?.cancellation?.status === 'unknown' && !snapshot.cancellation
        && info.nativeActionError === info.nativeRuntime.reason) info.nativeActionError = null;
    if (snapshot.connection === 'connected' && info.nativeRuntime?.connection !== 'connected') info.nativeActionError = null;
    info.nativeRuntime = snapshot;
    info.ccSessionId = snapshot.providerSessionId;
    manager._refreshOpenIdentity?.(id);
    if(snapshot.actualModel)info.currentModel={id:snapshot.actualModel,displayName:snapshot.actualModel};
    if(snapshot.effort)info.effort=snapshot.effort;
    if(snapshot.permissionMode)info.nativeConfig={...info.nativeConfig,permissionMode:snapshot.permissionMode};
    info.needsUserInput = snapshot.state === 'waiting';
    info.isWaiting = info.needsUserInput;
    info.gcWorking = false;
    info.runStartedAt = snapshot.startedAt || 0;
    info.status = ['starting', 'running', 'waiting'].includes(snapshot.state) ? 'running'
      : snapshot.state === 'failed' ? 'error' : 'idle';
    entry.groupChatReady = snapshot.connection === 'connected';
    publish();
  });
  driver.on('lifecycle', event => {
    const entry = current();
    if (!entry) return;
    if (event.type === 'agent-turn-started') manager.noteAgentTurnStarted(id, event);
    if (event.type === 'agent-turn-complete') {
      entry.info.lastCompletedAt = driver.runtime.completedAt;
      entry.info.lastMessageTime = driver.runtime.completedAt;
      entry.info.lastOutputPreview = event.text || '';
      publish();
    }
    manager.emit('native-agent-lifecycle', { ...event, sessionId: id });
  });
  driver.on('renamed',title=>{const entry=current();if(entry){entry.info.title=title;publish();}});
  driver.on('session-usage',usage=>{if(current())manager.emit('session-usage-snapshot',{sessionId:id,usage});});
  driver.on('backstage-updated', event => {
    if (current()) manager.emit('codex-backstage-updated', {sessionId:id, ...event});
  });
  driver.on('item', event => {
    if (current()) manager.emit('native-agent-item', { ...event, sessionId: id, source: 'claude-stream-json',
      epoch: driver.runtime.epoch, providerSessionId: driver.sessionId });
  });
  driver.on('usage', usage => {
    const entry = current();
    if (!entry) return;
    Object.assign(entry.info, { contextUsed: usage.totalTokens, contextMax: usage.rawMaxTokens || usage.maxTokens,
      contextEffectiveMax: usage.maxTokens, contextPct: usage.percentage, contextEffectiveObservedAt: Date.now() });
    publish();
  });
  driver.on('migration-draft', text => {
    const entry = current();
    if (!entry) return;
    entry.info.nativeMigrationDraft = text;
    publish();
  });
  driver.on('action-error', message => {
    const entry = current();
    if (!entry) return;
    entry.info.nativeActionError = String(message);
    publish();
  });
  driver.on('diagnostic', event => {
    if (current()) manager.emit('native-agent-diagnostic', { sessionId: id, ...event });
  });
  setImmediate(() => {
    if (!current() || driver.closed) return;
    // An unstarted dev-group seat spawns its engine on first dispatch, not here.
    if (driver.runtime.connection === 'unstarted' && !driver.sharedRuntime) return;
    driver.start().catch(error => {
      if (!current()) return;
      driver.update({ state: 'failed', connection: 'disconnected', reason: error.message });
      driver.emit('action-error', error.message);
    });
  });
}

function claudeNativeReceipt(receipt) {
  const accepted = ['accepted', 'completed', 'failed', 'interrupted'].includes(receipt.sendStatus);
  return { ...receipt, sendStatus: receipt.sendStatus === 'queued' ? 'queued' : accepted ? 'ok' : receipt.sendStatus,
    status: receipt.sendStatus, mode: 'claude-stream-json', enterAttempts: 0,
    acknowledgementSource: accepted ? 'claude-stream-json' : null,
    acknowledgementTurnId: null, // Claude exposes a user UUID, not a provider turn ID.
  };
}

module.exports = { bindClaudeNativeSession, claudeNativeReceipt };
