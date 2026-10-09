'use strict';
// Stage 2 容错升级（2026-05-01）— 单家 AI 群聊等待器
//
// 替代 main.js 老 _gcWaitTurnComplete 内联实现的"硬性 watchdog"：
//   旧版：600s 强制 timeout → 整轮 settle → 按钮锁 10 分钟。
//   新版：永不自动 settle，只在 T1=90s / T2=180s 触发非阻塞软提醒回调；
//        真正退出由用户操作（manualExtract / skip）或 transcriptTap 的协议级
//        L1/L2 事件（turn-complete / turn-error）决定。
//
// 设计文档：
//   历史韧性设计文档 (Task 2)
//
// 状态机：
//   wait() called → submitted（监听 + T1/T2 定时器启动）
//      ├─→ transcriptTap turn-complete → status: 'completed'
//      ├─→ transcriptTap turn-error    → status: 'errored'
//      ├─→ manualExtract(text)         → status: 'manual_extracted'
//      ├─→ skip()                      → status: 'absent'
//      └─→ T1/T2 触发 onSoftAlert(level)，**不 settle**，等待真触发点
//
// 注意：watcher 本身不处理 L2（PTY exit）信号——P1 阶段在 main.js 里通过
//   onProcessExit 钩子注入。本文件只暴露 onProcessExit 占位，预留 P1 接入。

const DEFAULT_T1_MS = 90000;
const DEFAULT_T2_MS = 180000;
const { createGroupChatProviderAdapter } = require('./groupchat-provider-adapter.js');

const PATCH_WINDOW_MS = 300_000;  // 5 分钟（spec 2026-05-03）

function createTurnCompletionWatcher(opts) {
  const {
    transcriptTap,
    hubSessionId,
    label,
    softAlertT1Ms = DEFAULT_T1_MS,
    softAlertT2Ms = DEFAULT_T2_MS,
    onSoftAlert = () => {},
    // P1 占位：接入 PTY 退出事件作为 L2 信号源。watcher 不主动监听进程，
    //   由调用方在 PTY exit 时调 watcher 的 markProcessExit() 钩子。
    onProcessExit = null, // eslint-disable-line no-unused-vars
    onTurnPatched = null,                   // 新增（2026-05-03）
    patchWindowMs = PATCH_WINDOW_MS,        // 新增（测试可注入更短的窗口）
    attempt = null,
    kind = null,
    nativeOnly = false,
    onAttemptEvent = () => {},
    onEventRejected = () => {},
    onAwaitingFinalText = () => {},
  } = opts || {};

  if (!transcriptTap) throw new Error('createTurnCompletionWatcher: transcriptTap required');
  if (!hubSessionId) throw new Error('createTurnCompletionWatcher: hubSessionId required');

  let resolveFn = null;
  let settled = false;
  let t1Timer = null;
  let t2Timer = null;
  let onTurnComplete = null;
  let onTurnError = null;
  let onTurnAborted = null;
  const providerAdapter = createGroupChatProviderAdapter(kind || (attempt && attempt.kind), {nativeOnly});

  // patch-after-settle 状态（2026-05-03）
  let patchListener = null;
  let patchWindowTimer = null;
  let settledText = '';
  let patchCancelled = false;

  const cleanup = () => {
    if (t1Timer) { clearTimeout(t1Timer); t1Timer = null; }
    if (t2Timer) { clearTimeout(t2Timer); t2Timer = null; }
    if (onTurnComplete) { transcriptTap.removeListener('turn-complete', onTurnComplete); onTurnComplete = null; }
    if (onTurnError) { transcriptTap.removeListener('turn-error', onTurnError); onTurnError = null; }
    if (onTurnAborted) { transcriptTap.removeListener('turn-aborted', onTurnAborted); onTurnAborted = null; }
  };

  const _cleanupPatch = () => {
    if (patchListener) { transcriptTap.removeListener('turn-complete', patchListener); patchListener = null; }
    if (patchWindowTimer) { clearTimeout(patchWindowTimer); patchWindowTimer = null; }
  };

  const settle = (result) => {
    if (settled) return;
    if (attempt) {
      result.attemptId = result.attemptId || attempt.attemptId || null;
      result.runId = result.runId || attempt.runId || null;
      result.providerTurnId = result.providerTurnId || attempt.providerTurnId || null;
    }
    settled = true;
    cleanup();
    settledText = result.text || '';
    // 2026-05-04 codex equiv (Spec S6/B1.7)：partial→final patch 适用范围扩展。
    //   - status: completed（claude/codex 自动完成）+ manual_extracted（用户先点提取拿 partial，
    //     codex 后续 task_complete 来时把 final 覆盖回来，否则卡片永久停在 partial）
    //   - signalSource 白名单加 'task_complete'（codex L1 信号），原 'stop_reason_terminal' /
    //     'stop_hook' 仍保留（claude 信号源）
    const PATCHABLE_STATUSES = new Set(['completed', 'manual_extracted']);
    const retryableFailureCanRecover = result.status === 'errored'
      && result.failure && result.failure.retryable === true;
    const PATCHABLE_SIGNAL_SOURCES = new Set([
      'codex-app-server', 'acp',
      'stop_reason_terminal', 'stop_hook', 'idle_timer_terminal',
      'task_complete', 'item_completed_agent_message_final_answer',
      'claude_auto_extract_final_answer', 'codex_auto_extract_final_answer',
    ]);
    if ((!nativeOnly || result.status === 'manual_extracted')
        && (PATCHABLE_STATUSES.has(result.status) || retryableFailureCanRecover) && onTurnPatched && !patchCancelled) {
      patchListener = (evt) => {
        if (evt.hubSessionId !== hubSessionId) return;
        const decision = providerAdapter.completion(attempt, evt);
        if (!decision.accepted) {
          try { onEventRejected({ type: 'patch', reason: decision.reason, event: evt, attempt }); }
          catch (error) { console.warn('[watcher] onEventRejected(patch) threw:', error && error.message); }
          return;
        }
        if (!PATCHABLE_SIGNAL_SOURCES.has(evt.signalSource)) return;
        if (!evt.text || evt.text === settledText) return;
        // 2026-07-20 maintainer [修#1]：手动提取可能抓到上一轮旧答案（提取方曾无时间窗），
        //   其 settled 文本可信度低——final 无论长短都允许覆盖纠正；completed 仍要求
        //   "更长"，防短 emit 把真答案截断。此前一刀切"更长才 patch"，真实答案更短时
        //   误抓的旧答案会永久留在卡片与 state.turns。
        if (result.status !== 'manual_extracted' && evt.text.length <= settledText.length) return;
        try {
          // patch 后状态统一标 'completed'：partial 是过渡，final 才是真完成
          onTurnPatched({
            sid: hubSessionId,
            label,
            text: decision.text,
            status: decision.status,
            attemptId: attempt && attempt.attemptId,
            runId: attempt && attempt.runId,
            providerTurnId: decision.identity && decision.identity.providerTurnId,
            failure: decision.failure || null,
            signalSource: evt.signalSource,
            finality: 'provider_final',
          });
          settledText = evt.text;  // 仅成功后更新基线（spec 防 silent failure）
        } catch (e) {
          console.warn('[watcher] onTurnPatched threw:', e && e.message);
          // 不更新 settledText——下次更长 emit 仍可重试此 patch
          // 同 text 会被 transcriptTap.emit 内部 lastText 比对吞掉，不会风暴
        }
      };
      transcriptTap.on('turn-complete', patchListener);
      patchWindowTimer = setTimeout(_cleanupPatch, patchWindowMs);
      if (patchWindowTimer.unref) patchWindowTimer.unref();
    }
    if (resolveFn) resolveFn(result);
    try { onAttemptEvent({ type: 'settled', result, attempt }); }
    catch (error) { console.warn('[watcher] onAttemptEvent(settled) threw:', error && error.message); }
  };

  return {
    /**
     * 启动监听 + 定时器，返回 settle 后的 result 对象。
     * @returns {Promise<{
     *   sid: string,
     *   label: string,
     *   status: 'completed' | 'errored' | 'manual_extracted' | 'absent',
     *   text: string,
     *   signalSource?: string,
     *   completedAt?: number,
     *   reason?: string,
     * }>}
     */
    wait() {
      if (settled) return Promise.resolve({ sid: hubSessionId, label, status: 'absent', text: '' });

      return new Promise((resolve) => {
        resolveFn = resolve;
        try { onAttemptEvent({ type: 'waiting', attempt }); }
        catch (error) { console.warn('[watcher] onAttemptEvent(waiting) threw:', error && error.message); }

        onTurnComplete = (evt) => {
          if (evt.hubSessionId !== hubSessionId) return;
          const decision = providerAdapter.completion(attempt, evt);
          if (!decision.accepted) {
            if (decision.awaitingFinalText) {
              try { onAwaitingFinalText({ event: evt, attempt, reason: decision.reason }); }
              catch (error) { console.warn('[watcher] onAwaitingFinalText threw:', error && error.message); }
            }
            try { onEventRejected({ type: 'completion', reason: decision.reason, event: evt, attempt }); }
            catch (error) { console.warn('[watcher] onEventRejected(completion) threw:', error && error.message); }
            return;
          }
          if (attempt && decision.identity && decision.identity.providerTurnId && !attempt.providerTurnId) {
            attempt.providerTurnId = decision.identity.providerTurnId;
          }
          settle({
            sid: hubSessionId,
            label,
            status: decision.status,
            text: decision.text,
            reason: decision.reason || null,
            failure: decision.failure || null,
            signalSource: evt.signalSource || 'unknown',
            completedAt: evt.completedAt || Date.now(),
            providerTurnId: decision.identity && decision.identity.providerTurnId,
            finality: 'provider_final',
          });
        };

        onTurnError = (evt) => {
          if (evt.hubSessionId !== hubSessionId) return;
          const decision = providerAdapter.error(attempt, evt);
          if (!decision.accepted) {
            try { onEventRejected({ type: 'error', reason: decision.reason, event: evt, attempt }); }
            catch (error) { console.warn('[watcher] onEventRejected(error) threw:', error && error.message); }
            return;
          }
          settle({
            sid: hubSessionId,
            label,
            status: decision.status,
            text: decision.text,
            reason: attempt ? decision.reason : (evt.reason || evt.message || 'unknown'),
            failure: decision.failure,
            signalSource: evt.signalSource || 'provider_error',
            completedAt: evt.completedAt || Date.now(),
            providerTurnId: decision.identity && decision.identity.providerTurnId,
          });
        };

        onTurnAborted = (evt) => {
          if (evt.hubSessionId !== hubSessionId) return;
          const decision = providerAdapter.aborted(attempt, evt);
          if (!decision.accepted) {
            try { onEventRejected({ type: 'aborted', reason: decision.reason, event: evt, attempt }); }
            catch (error) { console.warn('[watcher] onEventRejected(aborted) threw:', error && error.message); }
            return;
          }
          settle({
            sid: hubSessionId,
            label,
            status: decision.status,
            text: decision.text,
            reason: decision.reason,
            signalSource: evt.signalSource || 'turn_aborted',
            completedAt: evt.abortedAt || Date.now(),
            providerTurnId: decision.identity && decision.identity.providerTurnId,
          });
        };

        transcriptTap.on('turn-complete', onTurnComplete);
        transcriptTap.on('turn-error', onTurnError);
        transcriptTap.on('turn-aborted', onTurnAborted);

        // 软提醒计时器：触发后**不 settle**，仅通知调用方"这家还在等"。
        t1Timer = setTimeout(() => {
          if (settled) return;
          try { onSoftAlert('t1'); } catch (e) { console.warn('[watcher] onSoftAlert t1 throw:', e.message); }
        }, softAlertT1Ms);
        t2Timer = setTimeout(() => {
          if (settled) return;
          try { onSoftAlert('t2'); } catch (e) { console.warn('[watcher] onSoftAlert t2 throw:', e.message); }
        }, softAlertT2Ms);
      });
    },

    /**
     * 用户在 UI 点"一键提取"——绕过完成检测，直接以传入文本 settle。
     * 文本由调用方先调 transcriptTap.extractLatestGeminiTurn() 拿到。
     */
    manualExtract(text) {
      settle({
        sid: hubSessionId,
        label,
        status: 'manual_extracted',
        text: text || '',
        signalSource: 'manual',
      });
    },

    /**
     * Automatic transcript fallback for providers whose completion event may be
     * missed even though the final answer is already persisted.
     */
    completeFromTranscript(text, signalSource = 'auto_extract', details = {}) {
      const event = {
        hubSessionId,
        text: text || '',
        signalSource,
        completedAt: details.completedAt || Date.now(),
        turnId: details.turnId || details.providerTurnId || null,
        attemptId: details.attemptId || null,
      };
      const decision = providerAdapter.completion(attempt, event);
      if (!decision.accepted) {
        if (decision.awaitingFinalText) {
          try { onAwaitingFinalText({ event, attempt, reason: decision.reason }); }
          catch (error) { console.warn('[watcher] onAwaitingFinalText(auto_extract) threw:', error && error.message); }
        }
        try { onEventRejected({ type: 'auto_extract', reason: decision.reason, event, attempt }); }
        catch (error) { console.warn('[watcher] onEventRejected(auto_extract) threw:', error && error.message); }
        return false;
      }
      settle({
        sid: hubSessionId,
        label,
        status: decision.status,
        text: decision.text,
        reason: decision.reason || null,
        failure: decision.failure || null,
        signalSource,
        completedAt: event.completedAt,
        providerTurnId: decision.identity && decision.identity.providerTurnId,
        finality: 'provider_final',
      });
      return true;
    },
    // Replay a stored engine outcome after subscription. It remains subject to
    // exactly the same attempt/thread-turn guards as the live event.
    observeNativeOutcome(event) {
      if (!event || !['codex-app-server','acp'].includes(event.signalSource)) return false;
      if (event.status === 'completed' && onTurnComplete) onTurnComplete(event);
      else if (event.status === 'interrupted' && onTurnAborted) onTurnAborted(event);
      else if (event.status === 'failed' && onTurnError) onTurnError(event);
      return settled;
    },

    /**
     * 用户跳过本家——下游 prompt 构建器会过滤这家，不引用其内容。
     */
    skip() {
      settle({
        sid: hubSessionId,
        label,
        status: 'absent',
        text: '',
      });
    },

    /**
     * 抢占式结算（2026-06-24 maintainer）：用户在本轮还没答完时就发了下一轮 —— 立即把
     *   这家「未完成的旧轮」结算掉，让 dispatcher 的 Promise.allSettled 立刻 resolve、
     *   串行队列放行新轮，不再因卡死的 AI 无限期挂起。
     *   状态 'superseded'（被新问题覆盖），空文本 —— 下游 prompt 构建器按 content
     *   过滤，自然不把这家的半截回答喂给其他队友（用户确认：直接丢弃）。
     *   不进 patch 窗口（superseded 不在 PATCHABLE_STATUSES）：旧轮已废弃，CLI 后续
     *   吐的收尾内容不该再回填这条被覆盖的记录。
     */
    handoff() {
      // Dispatch may advance independently; the durable source reader keeps
      // receiving this attempt's commentary and final text after this wait.
      settle({sid:hubSessionId,label,status:'handed_off',text:'',reason:'file_handoff'});
    },

    supersede() {
      settle({
        sid: hubSessionId,
        label,
        status: 'superseded',
        text: '',
      });
    },

    /**
     * 用户中断（2026-07-29 maintainer · 群聊运行中可操作）：用户点「停止本轮」时立即结算。
     *   与 supersede() 的差别：supersede 是"被下一问覆盖"（丢弃半截），interrupt 是
     *   "用户主动叫停"——已经生成的半截文本有价值，调用方会把 PTY 里已流出的内容
     *   传进来一并落盘。
     *   不进 patch 窗口（'interrupted' 不在 PATCHABLE_STATUSES）：本轮已被用户叫停，
     *   CLI 之后吐的收尾内容不该再回填这条记录。
     */
    interrupt(text = '', reason = 'user_interrupt') {
      settle({
        sid: hubSessionId,
        label,
        status: 'interrupted',
        text: text || '',
        reason,
        signalSource: 'user_interrupt',
        completedAt: Date.now(),
      });
    },

    /**
     * P1 钩子：PTY 子进程退出时由 main.js 调用，作为 L2 完成信号。
     *   exitCode === 0 视为"自然退出但无 L1 信号"→ completed（兜底，无文本）；
     *   exitCode !== 0 / signal 视为 errored。
     *   P0 阶段不调用此方法；watcher 暴露此 API 是为 commit 6（P1-1）预埋。
     */
    markProcessExit(exitInfo) {
      const { code, signal } = exitInfo || {};
      if (settled) return;
      if (code === 0 && !signal && !attempt) {
        settle({
          sid: hubSessionId,
          label,
          status: 'completed',
          text: '',
          signalSource: 'process_exit_clean',
          completedAt: Date.now(),
        });
      } else {
        const decision = providerAdapter.error(attempt, {
          hubSessionId,
          reason: `pty exit code=${code} signal=${signal || 'none'}`,
          signalSource: 'process_exit',
        });
        settle({
          sid: hubSessionId,
          label,
          status: 'errored',
          text: '',
          reason: attempt ? (decision.reason || 'runtime_exited') : `pty exit code=${code} signal=${signal || 'none'}`,
          failure: decision.failure || null,
          signalSource: 'process_exit',
          completedAt: Date.now(),
        });
      }
    },

    markErrored(reason = 'unknown') {
      const decision = providerAdapter.error(attempt, { hubSessionId, reason, signalSource: 'explicit_error' });
      settle({
        sid: hubSessionId,
        label,
        status: 'errored',
        text: '',
        reason: attempt ? (decision.reason || reason) : reason,
        failure: decision.failure || null,
        signalSource: 'explicit_error',
        completedAt: Date.now(),
      });
    },

    markTimedOut(reason = 'response_timeout') {
      const decision = providerAdapter.error(attempt, { hubSessionId, reason, signalSource: 'hard_timeout' });
      settle({
        sid: hubSessionId,
        label,
        status: 'errored',
        text: '',
        reason: attempt ? (decision.reason || reason) : reason,
        failure: decision.failure || null,
        signalSource: 'hard_timeout',
        completedAt: Date.now(),
      });
    },

    isSettled() { return settled; },

    getAttemptIdentity() {
      return attempt ? {
        attemptId: attempt.attemptId || null,
        runId: attempt.runId || null,
        providerTurnId: attempt.providerTurnId || null,
        sid: hubSessionId,
      } : null;
    },

    cancelPatch() {
      patchCancelled = true;
      _cleanupPatch();
    },
  };
}

module.exports = {
  createTurnCompletionWatcher,
  // 重新导出常量，让 main.js / 测试可以从单一入口拿
  SOFT_ALERT_T1_MS: DEFAULT_T1_MS,
  SOFT_ALERT_T2_MS: DEFAULT_T2_MS,
};
