const PROMPT_LINE_RE = /^[\s│╭─╮╰╯]*[❯›>]\s+(.+?)(?:\s*[│╯╰╭╮]+\s*)?$/;
const PROMPT_PREFIX_RE = /^[\s│╭─╮╰╯]*[❯›>]\s+/;
const AI_MARKERS_RE = /[⏺●◉◐◑◒◓◔◕]/;
const { isNativeAgent } = require('../core/native-agent-runtime.js');
const SILENCE_MS = 2000;
const RUNTIME_PROBE_MS = 300;
// A renderer-side fit sends SIGWINCH to the CLI, and full-screen TUIs answer by
// repainting hundreds or thousands of bytes. That repaint is layout work, not
// agent activity. Keep the window shorter than the normal burst silence timer
// so genuine PTY fallback remains available when hooks/transcript signals fail.
const UI_RESIZE_REDRAW_SUPPRESS_MS = 1200;

function parseQuestionsFromLines(lines) {
  const questions = [];
  const seen = new Set();
  for (const raw of lines) {
    if (!raw) continue;
    if (AI_MARKERS_RE.test(raw)) continue;
    const m = raw.match(PROMPT_LINE_RE);
    if (!m) continue;
    const q = m[1].replace(/\s+$/, '').trim();
    if (q.length < 2) continue;
    if (seen.has(q)) continue;
    seen.add(q);
    questions.push(q);
  }
  return questions;
}

function isWaitingForUser(lines) {
  if (!lines || lines.length === 0) return { waiting: false };
  let lastMeaningful = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = (lines[i] || '').trim();
    if (!L) continue;
    if (PROMPT_PREFIX_RE.test(L)) continue;
    const stripped = L.replace(AI_MARKERS_RE, '').trim();
    if (!stripped) continue;
    lastMeaningful = stripped;
    break;
  }
  if (!lastMeaningful) return { waiting: false };
  const tail = lines.slice(-12).join('\n');
  if (/\[y\/N\]|\[Y\/n\]|\(yes\/no\)/i.test(tail)) {
    return { waiting: true, reason: 'confirm', text: lastMeaningful };
  }
  const hasList = /(^|\n)\s*[1-9][.\)]\s+\S|(^|\n)\s*[①②③④⑤⑥⑦⑧⑨]/m.test(tail);
  const hasQWord = /\b(which|what|choose|select|option|pick)\b|哪个|哪一|请选择|请确认|选择|选 ?[一二三1-9]/i.test(tail);
  if (hasList && hasQWord) {
    return { waiting: true, reason: 'choice', text: lastMeaningful };
  }
  if (lastMeaningful.length < 200 && /[?？]\s*$/.test(lastMeaningful)) {
    return { waiting: true, reason: 'question', text: lastMeaningful };
  }
  return { waiting: false };
}

function createTerminalActivityMonitor({
  sessions,
  terminalCache,
  getActiveSessionId,
  renderSessionList,
  schedulePersist,
  updateStreamingIndicator,
  hasSemanticCardWorking,
  hasSemanticWorking,
  needsPtyBurstUpgrade,
  canUsePtyBurstFallback,
  onPtyBurstStarted,
  onPtyBurstSettled,
  onSemanticWorkExpired,
  classifyRuntimeState,
  onRuntimeState,
  canObserveRuntimeState,
  silenceMs = SILENCE_MS,
  runtimeProbeMs = RUNTIME_PROBE_MS,
}) {
  const silenceTimers = new Map();
  const dataCounters = new Map();
  const runtimeProbeTimers = new Map();

  function extractUserQuestions(sessionId) {
    const cached = terminalCache.get(sessionId);
    if (!cached || !cached.opened) return [];
    const buf = cached.terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.trim()) lines.push(text);
    }
    return parseQuestionsFromLines(lines);
  }

  function extractTailLines(sessionId, count = 40) {
    const cached = terminalCache.get(sessionId);
    if (!cached || !cached.opened) return [];
    const buf = cached.terminal.buffer.active;
    const out = [];
    const start = Math.max(0, buf.length - count);
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      out.push(line.translateToString(true));
    }
    return out;
  }

  // Read the CLI's current logical screen, not the user's scroll viewport and
  // not arbitrary historical scrollback. Runtime markers such as Codex's
  // "esc to interrupt" and Claude's animated status row are only trustworthy
  // when they are still present in this live frame.
  function extractLiveScreenLines(sessionId) {
    const cached = terminalCache.get(sessionId);
    if (!cached || !cached.opened) return [];
    const terminal = cached.terminal;
    const buf = terminal && terminal.buffer && terminal.buffer.active;
    if (!buf) return [];
    const rows = Math.max(1, Number(terminal.rows) || Math.min(60, Number(buf.length) || 1));
    const baseY = Number(buf.baseY);
    const start = Number.isFinite(baseY)
      ? Math.max(0, baseY)
      : Math.max(0, (Number(buf.length) || 0) - rows);
    const end = Math.min(Number(buf.length) || 0, start + rows);
    const out = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      out.push(line.translateToString(true));
    }
    return out;
  }

  function observeRuntimeState(sessionId, observedAt = Date.now()) {
    const session = sessions.get(sessionId);
    if (isNativeAgent(session)) return null;
    if (!session || typeof classifyRuntimeState !== 'function') return null;
    let result = null;
    try {
      result = classifyRuntimeState(session, extractLiveScreenLines(sessionId));
    } catch (_) {
      return null;
    }
    if (!result || result.state === 'unknown') return result;
    let applied = null;
    if (typeof onRuntimeState === 'function') {
      try { applied = onRuntimeState(session, result, observedAt) === true; } catch (_) {}
    }
    return { ...result, applied };
  }

  function scheduleRuntimeProbe(sessionId) {
    if (isNativeAgent(sessions.get(sessionId))) return;
    if (runtimeProbeTimers.has(sessionId)) return;
    runtimeProbeTimers.set(sessionId, setTimeout(() => {
      runtimeProbeTimers.delete(sessionId);
      observeRuntimeState(sessionId, Date.now());
    }, Math.max(0, Number(runtimeProbeMs) || RUNTIME_PROBE_MS)));
  }

  function getQuestionsSignature(sessionId) {
    const qs = extractUserQuestions(sessionId);
    return qs.length === 0 ? '' : qs[qs.length - 1].slice(0, 200);
  }

  function readTerminalPreview(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { skipped: true, signature: '' };

    // Claude/Codex/Kimi already delivered an authoritative transcript preview.
    // Scanning the entire xterm scrollback here cannot improve that value and
    // used to add a synchronous O(scrollback) pass after every quiet period.
    if (session._previewFromTranscript) return { skipped: true, signature: '' };

    const questions = extractUserQuestions(sessionId);
    if (questions.length === 0) return { skipped: false, signature: '' };

    const lastQ = questions[questions.length - 1];
    const newPreview = lastQ.length > 60 ? lastQ.substring(0, 58) + '…' : lastQ;

    let changed = false;
    if (newPreview && newPreview !== session.lastOutputPreview) {
      session.lastOutputPreview = newPreview;
      renderSessionList();
      schedulePersist();
      changed = true;
    }
    return { skipped: false, signature: lastQ.slice(0, 200), changed };
  }

  function onTerminalOutput(sessionId, dataLen) {
    const session = sessions.get(sessionId);
    if (isNativeAgent(session)) return;
    if (!session) return;

    const now = Date.now();
    const cached = terminalCache.get(sessionId);
    const lastRendererResizeAt = Number(cached && cached._lastPtyResizeAt) || 0;
    const semanticCovered = typeof hasSemanticWorking === 'function' && hasSemanticWorking(session);

    // Current-screen provider markers are independent of the raw-byte burst
    // fallback. In particular, Codex may keep working after a transient prompt
    // frame prematurely closed the semantic turn; at that point neither
    // `semanticCovered` nor `burstEligible` remains true. Probe before those
    // gates so a structured "Working ... esc to interrupt" row (or Claude's
    // animated active row) can repair the state. The probe is coalesced and the
    // classifier reads only the logical live screen, never scrollback.
    const runtimeProbeEligible = typeof classifyRuntimeState === 'function'
      && (typeof canObserveRuntimeState !== 'function' || canObserveRuntimeState(session));
    if (runtimeProbeEligible) scheduleRuntimeProbe(sessionId);

    if (!semanticCovered
        && lastRendererResizeAt > 0
        && now >= lastRendererResizeAt
        && now - lastRendererResizeAt <= UI_RESIZE_REDRAW_SUPPRESS_MS) {
      return;
    }

    // AI TUIs can animate an idle footer indefinitely (observed Codex sessions
    // emitted repaint bytes roughly every 500ms hours after their last turn).
    // Raw PTY output is therefore only a fallback after a real local prompt
    // submission explicitly arms it. Shell sessions keep their old behaviour.
    const burstEligible = typeof canUsePtyBurstFallback !== 'function'
      || canUsePtyBurstFallback(session, now);
    if (!semanticCovered && !burstEligible) {
      dataCounters.delete(sessionId);
      if (silenceTimers.has(sessionId)) {
        clearTimeout(silenceTimers.get(sessionId));
        silenceTimers.delete(sessionId);
      }
      if (session.status === 'running' && session._runSource === 'burst') {
        session.status = 'idle';
        if (typeof onPtyBurstSettled === 'function') onPtyBurstSettled(session, now);
        session._runSource = null;
        renderSessionList();
        updateStreamingIndicator(sessionId);
      }
      return;
    }

    // 2026-07-21 maintainer [修进行中误判]：记录最近输出时间，供周期性兜底回收
    //   判断"语义 running 但 45min 无任何输出 = 卡死"。
    session._lastOutputTs = now;

    dataCounters.set(sessionId, (dataCounters.get(sessionId) || 0) + dataLen);

    // 2026-07-20 maintainer：byte burst 只在"无语义工作信号"的 kind 上标记 running
    //   （powershell / gemini / deepseek 等）。claude(hook prompt/stop) 与
    //   codex/kimi(transcript/cardWorking) 的 running 由语义事件驱动——否则
    //   用户在 TUI 输入框打字时的整屏重绘 >200B 会被误判为"agent 运行中"。
    const burstUpgradeNeeded = typeof needsPtyBurstUpgrade === 'function'
      && needsPtyBurstUpgrade(session);
    if (!semanticCovered && dataCounters.get(sessionId) > 200
        && (session.status !== 'running' || burstUpgradeNeeded)) {
      session.status = 'running';
      if (typeof onPtyBurstStarted === 'function') onPtyBurstStarted(session, now);
      session._runSource = 'burst';
      renderSessionList();
      updateStreamingIndicator(sessionId);
    }

    if (silenceTimers.has(sessionId)) clearTimeout(silenceTimers.get(sessionId));
    silenceTimers.set(sessionId, setTimeout(() => {
      silenceTimers.delete(sessionId);
      dataCounters.delete(sessionId);

      // Provider UI markers are stronger than raw silence. A long-running tool
      // may leave a stable "esc to interrupt"/animated status frame for more
      // than two seconds; do not turn that session idle merely because no new
      // bytes arrived. Conversely, a returned input box can close a stale
      // semantic running state when a hook/transcript completion was missed.
      const runtimeObservation = observeRuntimeState(sessionId, Date.now());
      const runtimeSaysRunning = runtimeObservation && runtimeObservation.state === 'running';
      const runtimeDefersIdle = runtimeObservation
        && runtimeObservation.state === 'idle'
        && runtimeObservation.applied === false;

      // burst 来源的 running：静默即退场（语义来源的 running 由各自完成事件收尾）。
      if (!runtimeSaysRunning && !runtimeDefersIdle
          && session.status === 'running' && session._runSource === 'burst') {
        session.status = 'idle';
        if (typeof onPtyBurstSettled === 'function') onPtyBurstSettled(session, Date.now());
        session._runSource = null;
        updateStreamingIndicator(sessionId);
      }
      // transcript 系(codex/kimi)语义 running 的兜底回收：
      //   完成事件丢失时，hasSemanticCardWorking 的 maxAge 到期 → 收回 running。
      if (!runtimeSaysRunning && session._agentWorking === 'card' && !hasSemanticCardWorking(session)) {
        session._agentWorking = null;
        if (session.status === 'running' && session._runSource === 'semantic') {
          if (typeof onSemanticWorkExpired === 'function') onSemanticWorkExpired(session, Date.now());
          else session.status = 'idle';
          session._runSource = null;
          updateStreamingIndicator(sessionId);
        }
      }

      const previewResult = readTerminalPreview(sessionId);

      const lastStopMs = Date.now() - (session._lastStopHookTs || 0);
      if (!previewResult.skipped && session.lastOutputPreview && lastStopMs >= 5000) {
        // Reuse the scan performed by readTerminalPreview. The old path walked
        // every xterm line twice on each silence callback.
        const sig = previewResult.signature;
        const prev = session.readSignature || '';
        if (sig !== prev) {
          session.lastMessageTime = Date.now();
          session.readSignature = sig;
          if (sessionId !== getActiveSessionId()) {
            session.unreadCount = (session.unreadCount || 0) + 1;
          }
        }
      }

      renderSessionList();
    }, Math.max(0, Number(silenceMs) || SILENCE_MS)));
  }

  function clearSession(sessionId) {
    if (silenceTimers.has(sessionId)) {
      clearTimeout(silenceTimers.get(sessionId));
      silenceTimers.delete(sessionId);
    }
    if (runtimeProbeTimers.has(sessionId)) {
      clearTimeout(runtimeProbeTimers.get(sessionId));
      runtimeProbeTimers.delete(sessionId);
    }
    dataCounters.delete(sessionId);
  }

  return {
    extractUserQuestions,
    extractTailLines,
    extractLiveScreenLines,
    getQuestionsSignature,
    readTerminalPreview,
    observeRuntimeState,
    onTerminalOutput,
    isWaitingForUser,
    clearSession,
  };
}

module.exports = {
  PROMPT_LINE_RE,
  PROMPT_PREFIX_RE,
  AI_MARKERS_RE,
  UI_RESIZE_REDRAW_SUPPRESS_MS,
  RUNTIME_PROBE_MS,
  parseQuestionsFromLines,
  isWaitingForUser,
  createTerminalActivityMonitor,
};
