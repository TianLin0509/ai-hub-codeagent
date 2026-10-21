'use strict';
// 软压缩：上下文过 60 万软线后，用户目录下的提醒钩子（soft-compact-reminder，不随 Hub 分发）提醒 AI 收尾，
// AI 到自然断点时在回复末尾留标记结束本轮；Hub 在 Stop 时看到标记就替用户发 /compact，
// 压缩完成（SessionStart source=compact）后按需发一句「继续」。硬线 80 万由 Claude Code 自己兜底。
// 2026-10-21 用户拍板：60% 软线 + 80% 硬线 + Hub 自动压缩（方案 A）。
//
// 规矩：
//   1. 只认本轮最后一条回复末尾的标记；只管 PTY Claude 单聊会话，群聊成员交给硬线。
//   2. 发送只走 groupChatWatcher.sendToPty 闭环；/compact 带 localCommandObserver 等 PreCompact 确认。
//   3. 等待期间用户已经发了新消息（本轮又跑起来了），就不压缩，留给下一次断点。
//   4. 每一步（开始、完成、失败、超时）都在会话卡片上留一条看得见的提示。
//   5. 同一会话压缩完成后 10 分钟内再出现标记不再压，防止 AI 在继续的回复里重复留标记导致连环压缩。
const { readLastTerminalAssistantTextFromClaudeTranscript } = require('../core/transcript-tap');
const { observeClaudeLocalCommand } = require('../core/claude-identity-switch');

const MARKER_RE = /\[\[hub:compact(-continue)?\]\]/;
const CONTINUE_PROMPT = '（Hub 提示：上下文已自动压缩。先读本任务的进展卡，确认当前步骤和下一步，再接着做。）';

function findMarker(text) {
  const tail = String(text || '').trimEnd().slice(-400);
  const match = tail.match(MARKER_RE);
  if (!match) return null;
  return match[1] ? 'continue' : 'wait';
}

function createSoftCompactController(deps = {}) {
  const {
    sessionManager,
    sendToPty = (...args) => require('../core/group-chat-watcher').sendToPty(...args),
    readFinalText = async transcriptPath => (await readLastTerminalAssistantTextFromClaudeTranscript(transcriptPath))?.text || null,
    observeCompact = sessionId => observeClaudeLocalCommand(sessionManager, sessionId, 'compact', ''),
    isBusy = () => false,
    notify = null,
    logger = console,
    now = Date.now,
    settleMs = 1500,
    timeoutMs = 15 * 60 * 1000,
    cooldownMs = 10 * 60 * 1000,
  } = deps;
  if (!sessionManager) throw new Error('soft-compact-controller 缺少 sessionManager');
  const compacting = new Map();
  const lastDone = new Map();
  const short = id => String(id).slice(0, 8);
  const notice = (sessionId, message, level = 'info') => {
    try { notify?.(sessionId, message, level); } catch {}
  };

  function finish(sessionId, entry) {
    if (compacting.get(sessionId) !== entry) return;
    compacting.delete(sessionId);
    clearTimeout(entry.timer);
  }

  async function onStop(sessionId, { transcriptPath, lastAssistantMessage } = {}) {
    if (!sessionId || compacting.has(sessionId)) return null;
    const session = sessionManager.getSession?.(sessionId);
    if (!session || !/^claude/.test(String(session.kind || '')) || session.agentRuntime !== 'pty') return null;
    let text = null;
    if (transcriptPath) { try { text = await readFinalText(transcriptPath); } catch {} }
    const mode = findMarker(text) || findMarker(lastAssistantMessage);
    if (!mode) return null;
    if (now() - (lastDone.get(sessionId) || -Infinity) < cooldownMs) {
      logger.log(`[soft-compact] ${short(sessionId)} skipped: compacted within cooldown`);
      return null;
    }
    if (session.meetingId) {
      notice(sessionId, '群聊成员不自动压缩，上下文到 80 万时由 Claude Code 自动压缩。');
      return null;
    }
    const entry = { mode, startedAt: now(), timer: null };
    compacting.set(sessionId, entry);
    // 让 Claude 的 TUI 收完这一轮再输入。
    await new Promise(resolve => setTimeout(resolve, settleMs));
    if (isBusy(sessionId)) {
      finish(sessionId, entry);
      logger.log(`[soft-compact] ${short(sessionId)} skipped: new turn already running`);
      return null;
    }
    logger.log(`[soft-compact] ${short(sessionId)} marker=${mode}; sending /compact`);
    notice(sessionId, mode === 'continue' ? 'AI 已到断点，正在自动压缩上下文，压完会自动继续。' : 'AI 已到断点，正在自动压缩上下文。');
    entry.timer = setTimeout(() => {
      if (compacting.get(sessionId) !== entry) return;
      finish(sessionId, entry);
      notice(sessionId, '自动压缩 15 分钟没有完成，已放弃等待；请看一下终端，必要时手动输入 /compact。', 'warning');
    }, timeoutMs);
    entry.timer.unref?.();
    try {
      const receipt = await sendToPty(sessionId, '/compact', session.kind, {
        requireReady: false, localCommandObserver: observeCompact(sessionId),
        clientSubmissionId: `soft-compact-${entry.startedAt}`,
      });
      if (!receipt || receipt.ok === false) {
        finish(sessionId, entry);
        notice(sessionId, `自动压缩没有获得确认（${receipt?.message || '未知原因'}），可手动输入 /compact。`, 'warning');
        return null;
      }
    } catch (error) {
      finish(sessionId, entry);
      notice(sessionId, `自动压缩发送失败：${error.message}。可手动输入 /compact。`, 'warning');
      return null;
    }
    return mode;
  }

  async function onCompactEnd(sessionId) {
    const entry = compacting.get(sessionId);
    if (!entry) return;
    finish(sessionId, entry);
    lastDone.set(sessionId, now());
    const seconds = Math.round((now() - entry.startedAt) / 1000);
    logger.log(`[soft-compact] ${short(sessionId)} compact done in ${seconds}s; mode=${entry.mode}`);
    if (entry.mode !== 'continue') { notice(sessionId, `上下文已自动压缩（用时 ${seconds} 秒）。`); return; }
    const session = sessionManager.getSession?.(sessionId);
    if (!session) return;
    try {
      const receipt = await sendToPty(sessionId, CONTINUE_PROMPT, session.kind, {
        requireReady: false, clientSubmissionId: `soft-compact-continue-${entry.startedAt}`,
      });
      if (!receipt || receipt.ok === false || ['unknown', 'content-mismatch', 'rejected'].includes(receipt.status)) {
        notice(sessionId, '上下文已压缩，但自动继续未获确认；请看一下会话，必要时手动发「继续」。', 'warning');
        return;
      }
      notice(sessionId, `上下文已自动压缩（用时 ${seconds} 秒），已让 AI 读进展卡接着做。`);
    } catch (error) {
      notice(sessionId, `上下文已压缩，自动继续发送失败：${error.message}。请手动发「继续」。`, 'warning');
    }
  }

  function start() {
    sessionManager.on('claude-local-command-ack', event => {
      if (event && event.command === 'compact' && event.phase === 'end') void onCompactEnd(event.sessionId);
    });
  }

  function forget(sessionId) {
    const entry = compacting.get(sessionId);
    if (entry) finish(sessionId, entry);
    lastDone.delete(sessionId);
  }

  return { start, onStop, onCompactEnd, forget, isCompacting: id => compacting.has(id) };
}

module.exports = { createSoftCompactController, findMarker, CONTINUE_PROMPT };
