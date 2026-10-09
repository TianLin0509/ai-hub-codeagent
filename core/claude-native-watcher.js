'use strict';

function createClaudeNativeWatcher(driver, { sid, label, submissionId, attemptId, runId, onPartial, onProgress }) {
  if (!submissionId) throw new Error('Native watcher requires the dispatched submission ID');
  let settled = false;
  let resolveWait;
  let started = false;
  let lastProgress = '';
  const promise = new Promise(resolve => { resolveWait = resolve; });
  const cleanup = () => {
    driver.off('lifecycle', onLifecycle); driver.off('state', onState); driver.off('item', onItem);
  };
  const settle = (status, record, reason = null) => {
    if (settled) return;
    settled = true; cleanup();
    // Group members share one failure vocabulary, so a Claude seat says
    // "额度中断" / "限流中断" / "网络中断" like a Codex seat instead of showing a
    // raw reason string. The engine's own transport message is the best input.
    const failure = status === 'errored'
      ? require('./groupchat-attempt-protocol').classifyProviderFailure({
        reason, message: driver.runtime?.reason, force: true })
      : null;
    // Token cost per member turn, from the usage the engine reports on its
    // result frame. Absent usage stays absent rather than being shown as zero.
    const usage = record && record.usage;
    const tokens = usage ? {
      total: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0),
      input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      output: usage.output_tokens || 0,
    } : null;
    resolveWait({ sid, label, attemptId, runId, submissionId, status,
      ...(failure ? { failure } : {}), ...(tokens ? { tokens } : {}),
      displayMessages: require('./claude-native-transcript').claudeDisplayMessages(record),
      text: record?.finalText || '', reason, completedAt: record?.completedAt || Date.now(),
      providerTurnId: null, userMessageId: record?.userMessageId || null,
      signalSource: 'claude-stream-json', finality: status === 'completed' ? 'provider_final' : status });
  };
  const inspect = () => {
    const record = driver.records.get(submissionId);
    if (!record) throw new Error('Native submission record is missing');
    if (['completed', 'failed', 'interrupted'].includes(record.status)) {
      settle(record.status === 'failed' ? 'errored' : record.status, record, driver.runtime.reason);
    } else if (['unknown', 'content-mismatch', 'rejected'].includes(record.status)
        || driver.closed || (driver.unreconciled && record.status === 'queued')) {
      settle('errored', record, 'native_submission_requires_reconciliation');
    } else if (onProgress) {
      const status = record.status === 'queued' ? 'queued' : !record.accepted ? 'submitting'
        : driver.active === record && driver.runtime.requests.length ? 'waiting'
          : record.started ? 'running' : 'accepted';
      const key = status + ':' + record.userMessageId;
      if (key !== lastProgress) {
        lastProgress = key;
        try {
          onProgress({ status, submissionId, userMessageId: record.userMessageId, providerTurnId: null,
            nativePromptFingerprint: record.fingerprint, acceptedAt: record.acceptedAt || null,
            startedAt: record.startedAt || null, signalSource: 'claude-stream-json' });
        } catch (error) {
          settle('errored', record, 'native_progress_delivery_failed: ' + error.message);
          driver.emit('action-error', '群聊状态保存失败：' + error.message);
        }
      }
    }
  };
  function onLifecycle(event) { if (event.clientSubmissionId === submissionId) inspect(); }
  function onState() { inspect(); }
  function onItem(event) {
    const record = driver.records.get(submissionId);
    if (!record || event.userMessageId !== record.userMessageId || !onPartial) return;
    const answer = driver.transcript().find(item => item.id === record.userMessageId + ':assistant');
    try {
      onPartial({ sid, label, attemptId, runId, submissionId, status: 'streaming',
        displayMessages: require('./claude-native-transcript').claudeDisplayMessages(record),
        source: 'claude-stream-json', text: answer?.text || '', blocks: [], cleanBufLen: answer?.text?.length || 0 });
    } catch (error) {
      // A display/persistence consumer failure does not prove the engine disconnected.
      settle('errored', record, 'native_partial_delivery_failed: ' + error.message);
      driver.emit('action-error', '群聊输出传递失败：' + error.message);
    }
  }
  return {
    wait() {
      if (!started) {
        started = true;
        driver.on('lifecycle', onLifecycle); driver.on('state', onState); driver.on('item', onItem);
        // Completion may precede the send RPC response / watcher registration.
        try { inspect(); } catch (error) { cleanup(); throw error; }
      }
      return promise;
    },
    isSettled: () => settled,
    supersede() { settle('superseded', driver.records.get(submissionId), 'new_dispatch'); },
    interrupt() { /* Dispatcher sends one protocol interrupt; only its result confirms stopping. */ },
    markProcessExit() { settle('errored', driver.records.get(submissionId), 'native_connection_lost'); },
    getAttemptIdentity: () => ({ attemptId, runId, submissionId }),
  };
}

module.exports = { createClaudeNativeWatcher };
