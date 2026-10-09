'use strict';

// 「引用会话」的两个 IPC：列出可引用的会话与群聊、把选中项解析成聊天记录 md 路径。
// 设计说明见 core/session-reference.js。

const fs = require('node:fs');
const path = require('node:path');
const {
  mergeReferenceRows,
  referenceableMeetingRows,
  referenceableRows,
} = require('../../core/session-reference.js');
const groupTranscript = require('../../core/group-chat-transcript.js');

// md 在每次提交/每轮结束后由索引自动重写，绝大多数时候已是最新，直接用、零等待。
// 只有原始记录比 md 新（源会话正在回答，或索引还没跟上）才显式刷新一次；
// 全量刷新在冷启动或别的刷新进行中时可能要几分钟，所以只等这么久，
// 超时就用已有的 md，并如实告诉用户可能缺最近的内容。
const DEFAULT_REFRESH_TIMEOUT_MS = 5000;
const HEADER_BYTES = 4096;

// md 头部写着「- 原始记录：<路径>」（core/session-transcript-md.js）。
// 读不到或没有这一行（例如群聊来源）一律当作「不确定是否最新」。
function mdIsCurrent(mdPath) {
  let fd = null;
  try {
    fd = fs.openSync(mdPath, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
    const match = buffer.subarray(0, bytes).toString('utf8').match(/^- 原始记录：(.+)$/m);
    if (!match) return false;
    return fs.statSync(match[1].trim()).mtimeMs <= fs.fstatSync(fd).mtimeMs;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

// 群聊记录在引用那一刻从群聊状态文件现场生成：状态文件是权威（成员回答文件已归并进去），
// 群聊自己的 arena-prompts md 只在状态保存时刷新，老群聊根本没有。
// 写进 transcripts 目录而不是 arena-prompts：Claude 会话只给 transcripts 目录加了
// --add-dir，放在别处每次引用都会弹读取审批。
function groupReferencePath(transcriptDir, meetingId) {
  return path.join(transcriptDir, `group-${meetingId}.md`);
}

function writeUtf8Atomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

function hasGroupSpeech(state) {
  const messages = Array.isArray(state && state.messages) ? state.messages : [];
  return messages.some(m => !groupTranscript.isProgressUpdateMessage(m)
    && (groupTranscript.isUserSpeech(m) || groupTranscript.isAssistantSpeech(m)));
}

function registerSessionReferenceIpc(ipcMain, deps = {}) {
  const searchService = deps.searchService || null;
  const getSearchSnapshot = typeof deps.getSearchSnapshot === 'function'
    ? deps.getSearchSnapshot
    : () => ({ sessions: [], meetings: [] });
  const getMeeting = typeof deps.getMeeting === 'function' ? deps.getMeeting : () => null;
  const isCurrent = typeof deps.mdIsCurrent === 'function' ? deps.mdIsCurrent : mdIsCurrent;
  const refreshTimeoutMs = Number(deps.refreshTimeoutMs) || DEFAULT_REFRESH_TIMEOUT_MS;
  const logger = deps.logger || console;
  const getHubDataDir = typeof deps.getHubDataDir === 'function'
    ? deps.getHubDataDir
    : () => require('../../core/data-dir.js').getHubDataDir();
  const getTranscriptDir = typeof deps.getTranscriptDir === 'function'
    ? deps.getTranscriptDir
    : () => require('../../core/data-dir.js').getHubTranscriptDir();

  async function refreshWithin() {
    let timer = null;
    const refreshed = Promise.resolve()
      .then(() => searchService.refresh(getSearchSnapshot(), { immediate: true }))
      .then(() => true, error => {
        logger.warn('[session-reference] refresh failed:', error && error.message);
        return false;
      });
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), refreshTimeoutMs); });
    try {
      return await Promise.race([refreshed, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  ipcMain.handle('session-reference:list', (_e, { excludeSessionId = '', excludeMeetingId = '' } = {}) => {
    const snapshot = getSearchSnapshot() || {};
    const sessionRows = referenceableRows(snapshot.sessions, {
      excludeId: excludeSessionId,
      meetingTitleOf: meetingId => {
        const meeting = getMeeting(meetingId);
        return meeting ? meeting.title : null;
      },
    });
    return mergeReferenceRows(sessionRows, referenceableMeetingRows(snapshot.meetings, { excludeMeetingId }));
  });

  // 没有群聊状态文件的老式会议室：退回搜索索引那份（它的内容来自会议时间线，对老协议是对的）。
  async function resolveLegacyMeeting(meetingId, title) {
    if (!searchService || typeof searchService.transcriptFor !== 'function') return null;
    try {
      const found = await searchService.transcriptFor({ key: `meeting:${meetingId}` });
      if (!found || !found.path || !found.exists) return null;
      return { ok: true, path: found.path, title: title || found.title || '', fresh: isCurrent(found.path) };
    } catch (error) {
      logger.warn('[session-reference] legacy meeting lookup failed:', error && error.message);
      return null;
    }
  }

  async function resolveMeeting(meetingId) {
    const meeting = getMeeting(meetingId);
    const title = (meeting && meeting.title) || '';
    let state = null;
    try {
      const statePath = path.join(getHubDataDir(), 'arena-prompts', `${meetingId}-groupchat.json`);
      // 大群聊的状态文件可达几十 MB：异步读，别让主进程卡在磁盘上。
      if (fs.existsSync(statePath)) state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
    } catch (error) {
      return { ok: false, error: 'group-state-unreadable', message: `读取群聊记录失败：${error && error.message}` };
    }
    if (!state) {
      const legacy = await resolveLegacyMeeting(meetingId, title);
      if (legacy) return legacy;
      return { ok: false, error: 'transcript-missing', message: '这个群聊还没有可读取的记录：至少要有一轮发言' };
    }
    if (!hasGroupSpeech(state)) {
      return { ok: false, error: 'transcript-missing', message: '这个群聊还没有发言，暂时没有可引用的内容' };
    }
    const filePath = groupReferencePath(getTranscriptDir(), meetingId);
    try {
      writeUtf8Atomic(filePath, groupTranscript.renderTranscriptMarkdown({ ...state, meetingId }, { title }));
    } catch (error) {
      return { ok: false, error: 'transcript-write-failed', message: `生成群聊记录失败：${error && error.message}` };
    }
    return { ok: true, path: filePath, title, fresh: true };
  }

  ipcMain.handle('session-reference:resolve', async (_e, { sessionId = '', meetingId = '' } = {}) => {
    if (meetingId) {
      // id 会拼进文件路径，只接受 uuid 这类字符。
      if (!/^[\w-]+$/.test(String(meetingId))) return { ok: false, error: 'bad-meeting', message: '群聊 ID 不合法' };
      return resolveMeeting(String(meetingId));
    }
    const id = String(sessionId || '');
    if (!id) return { ok: false, error: 'missing-session', message: '没有指定要引用的会话' };
    if (!searchService || typeof searchService.transcriptFor !== 'function') {
      return { ok: false, error: 'search-unavailable', message: '会话索引不可用，无法生成聊天记录' };
    }
    const lookup = async () => {
      try {
        return { found: await searchService.transcriptFor({ hubSessionId: id }) };
      } catch (error) {
        return { error: `读取聊天记录失败：${error && error.message}` };
      }
    };
    const usable = found => !!(found && found.path && found.exists);

    let { found, error } = await lookup();
    let fresh = usable(found) && isCurrent(found.path);
    if (!fresh && typeof searchService.refresh === 'function') {
      const refreshed = await refreshWithin();
      ({ found, error } = await lookup());
      fresh = refreshed && usable(found);
    }
    if (error) return { ok: false, error: 'transcript-lookup-failed', message: error };
    if (!usable(found)) {
      return {
        ok: false,
        error: 'transcript-missing',
        message: '这个会话还没有可读取的聊天记录：至少要完成一轮对话，且来源需被会话搜索支持；'
          + '若会话索引正在建立，请稍后再试',
      };
    }
    return { ok: true, path: found.path, title: found.title || '', fresh };
  });
}

module.exports = { groupReferencePath, mdIsCurrent, registerSessionReferenceIpc };
