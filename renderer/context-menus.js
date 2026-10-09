'use strict';

const { supportsRecoverableSession } = require('../core/session-capabilities.js');

function supportsRecoverableSessionKind(session) {
  return !!(session && session.purpose !== 'xresearch-research' && supportsRecoverableSession(session));
}

function createSessionContextMenuController({
  document,
  window,
  contextMenuEl,
  sessions,
  meetings,
  ipcRenderer,
  getActiveSessionId,
  setActiveSessionId,
  getActiveMeetingId,
  setActiveMeetingId,
  closeMeetingPanel,
  emptyStateEl,
  renderSessionList,
  schedulePersist,
  notify,
  wakeDormantSession,
  confirmAction = (message, options) => require('./ui-feedback').confirmHubAction(message, { document, ...options }),
  selectMeeting = null,
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  let contextMenuSessionId = null;
  let lastContextMenuPoint = { x: 0, y: 0 };
  const showNotice = typeof notify === 'function'
    ? notify
    : (message) => {
      require('./ui-feedback').showHubAlert(message, { document });
    };
  const forkUi = require('./groupchat-fork-ui.js').createGroupChatForkUi({
    document,
    ipcRenderer,
    notify: showNotice,
    getMeetings: () => meetings,
    selectMeeting,
    confirmAction,
  });
  const roomAlreadyAsleep = meeting => meeting?.status === 'dormant'
    && !(meeting.subSessions || []).some(id => sessions.has(id) && sessions.get(id).status !== 'dormant');

  function open(sessionId, x, y) {
    contextMenuSessionId = sessionId;
    lastContextMenuPoint = { x, y };
    contextMenuEl.style.display = 'block';
    contextMenuEl.style.left = `${x}px`;
    contextMenuEl.style.top = `${y}px`;
    requestAnimationFrameFn(() => {
      const rect = contextMenuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) contextMenuEl.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) contextMenuEl.style.top = `${y - rect.height}px`;
    });
    const pinBtn = contextMenuEl.querySelector('[data-action="pin"]');
    const restartBtn = contextMenuEl.querySelector('[data-action="restart"]');
    const closeBtn = contextMenuEl.querySelector('[data-action="close"]');
    const deleteBtn = contextMenuEl.querySelector('[data-action="delete"]');
    const bottomBtn = contextMenuEl.querySelector('[data-action="bottom"]');
    if (pinBtn) pinBtn.style.display = '';
    const session = sessions.get(sessionId);
    const meeting = meetings[sessionId];
    if (restartBtn) {
      const restartAllowed = !!(session && session.purpose !== 'xresearch-research');
      restartBtn.style.display = restartAllowed ? '' : 'none';
      if (restartAllowed) {
        restartBtn.textContent = '重启';
        restartBtn.title = session.status === 'dormant'
          ? '唤醒并继续该休眠会话'
          : (supportsRecoverableSessionKind(session) ? '重启并继续当前会话' : '重启终端');
      }
    }
    if (closeBtn) {
      closeBtn.style.display = meeting || session ? '' : 'none';
      closeBtn.disabled = !!(session && session.status === 'dormant') || roomAlreadyAsleep(meeting);
      closeBtn.textContent = meeting
        ? '休眠会议室'
        : (supportsRecoverableSessionKind(session) ? '休眠' : '关闭');
      if (closeBtn.classList && typeof closeBtn.classList.toggle === 'function') {
        closeBtn.classList.toggle('danger', false);
      }
    }
    if (deleteBtn) {
      deleteBtn.style.display = session || meeting ? '' : 'none';
      deleteBtn.textContent = meeting ? '删除会议室' : '删除';
    }
    if (pinBtn) {
      const target = session || meeting;
      pinBtn.textContent = target && target.pinned ? '取消置顶' : '置顶';
    }
    if (bottomBtn) {
      const target = session || meeting;
      bottomBtn.style.display = target ? '' : 'none';
      bottomBtn.textContent = target && target.bottomed ? '取消置底' : '置底';
    }
    // 群聊分支入口：会话看到「加入群聊…」，群聊看到「分支群聊」。能不能分支由主进程
    // 最终判定（要有原生会话 ID），这里只做最粗的类型过滤，不在前端复制那套规则。
    const joinGroupBtn = contextMenuEl.querySelector('[data-action="join-group"]');
    if (joinGroupBtn) {
      joinGroupBtn.style.display = session && !meeting && forkUi && session.purpose !== 'xresearch-research' ? '' : 'none';
    }
    const forkMeetingBtn = contextMenuEl.querySelector('[data-action="fork-meeting"]');
    if (forkMeetingBtn) {
      forkMeetingBtn.style.display = meeting && meeting.groupChat && forkUi ? '' : 'none';
    }
  }

  function close() {
    contextMenuEl.style.display = 'none';
    contextMenuSessionId = null;
  }

  function init() {
    document.addEventListener('mousedown', (e) => {
      if (contextMenuEl.style.display === 'block' && !contextMenuEl.contains(e.target)) {
        close();
      }
    });

    for (const btn of contextMenuEl.querySelectorAll('.context-menu-item')) {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const sid = contextMenuSessionId;
        close();
        if (!sid) return;

        const session = sessions.get(sid);
        const meeting = meetings[sid];

        if (action === 'close' && meeting) {
          if (roomAlreadyAsleep(meeting)) return;
          try {
            const result = await ipcRenderer.invoke('suspend-meeting', sid);
            if (!result?.ok || !result.meetingDormant) {
              const blocked = (result?.blocked || []).map(item => {
                const name = sessions.get(item.sessionId)?.title || item.sessionId;
                return name + '：' + (item.message || item.error);
              }).join('；');
              showNotice(blocked ? '部分成员未能休眠：' + blocked : (result?.message || '会议室休眠失败，请稍后重试。'));
            }
          } catch (error) {
            showNotice('会议室休眠失败：' + (error?.message || String(error)));
          }
          return;
        }

        if (action === 'fork-meeting' && meeting) {
          await forkUi.forkMeeting(sid);
          return;
        }

        if (action === 'join-group' && !meeting && session) {
          await forkUi.openJoinGroupMenu(sid, lastContextMenuPoint.x, lastContextMenuPoint.y);
          return;
        }

        if (action === 'delete' && meeting) {
          const result = await ipcRenderer.invoke('close-meeting', sid);
          if (result !== true) {
            showNotice(result?.message || '删除会议室失败，请稍后重试。');
            return;
          }
          delete meetings[sid];
          if (getActiveMeetingId() === sid) {
            setActiveMeetingId(null);
            closeMeetingPanel();
            if (emptyStateEl) emptyStateEl.style.display = '';
          }
          renderSessionList();
          schedulePersist();
          return;
        }

        if (action === 'pin' && meeting) {
          meeting.pinned = !meeting.pinned;
          if (meeting.pinned) meeting.bottomed = false;
          ipcRenderer.send('update-meeting', {
            meetingId: sid,
            fields: { pinned: !!meeting.pinned, bottomed: !!meeting.bottomed },
          });
          renderSessionList();
          schedulePersist();
          return;
        }

        if (action === 'bottom' && meeting) {
          meeting.bottomed = !meeting.bottomed;
          if (meeting.bottomed) meeting.pinned = false;
          ipcRenderer.send('update-meeting', {
            meetingId: sid,
            fields: { pinned: !!meeting.pinned, bottomed: !!meeting.bottomed },
          });
          renderSessionList();
          schedulePersist();
          return;
        }

        if (!session) return;

        if (action === 'pin') {
          session.pinned = !session.pinned;
          if (session.pinned) session.bottomed = false;
          ipcRenderer.send('update-session-placement', {
            sessionId: sid,
            pinned: !!session.pinned,
            bottomed: !!session.bottomed,
          });
          renderSessionList();
          schedulePersist();
        } else if (action === 'bottom') {
          session.bottomed = !session.bottomed;
          if (session.bottomed) session.pinned = false;
          ipcRenderer.send('update-session-placement', {
            sessionId: sid,
            pinned: !!session.pinned,
            bottomed: !!session.bottomed,
          });
          renderSessionList();
          schedulePersist();
        } else if (action === 'restart') {
          if (session.status === 'dormant') {
            if (typeof wakeDormantSession !== 'function') {
              showNotice('休眠会话唤醒服务尚未就绪');
              return;
            }
            try {
              const resumed = await wakeDormantSession(sid);
              if (!resumed) showNotice('会话唤醒失败，请稍后重试。');
            } catch (error) {
              showNotice(`会话唤醒失败：${error && error.message ? error.message : String(error)}`);
            }
            return;
          }
          try {
            const result = await ipcRenderer.invoke('restart-session', sid);
            if (result && result.ok === false) {
              showNotice(result.message || '会话重启失败，请稍后重试。');
            }
          } catch (error) {
            showNotice(`会话重启失败：${error && error.message ? error.message : String(error)}`);
          }
        } else if (action === 'close') {
          if (session.status === 'dormant') return;
          // 用户主动关闭就是休眠：即便本轮仍在运行，也允许中断 PTY 并保留恢复入口。
          // 自动休眠仍由主进程的 active watcher/loop 保护，不受这里影响。
          const result = await ipcRenderer.invoke('close-session', sid);
          if (!result || !result.ok) {
            showNotice((result && result.message) || '关闭休眠失败，请稍后重试。');
          }
        } else if (action === 'delete') {
          const confirmed = await confirmAction(`永久删除“${session.title || '此会话'}”？\n\n这会终止当前进程并移除 Hub 卡片，之后不能从该卡片唤醒。`, { title: '永久删除这个会话？', acceptLabel: '永久删除', cancelLabel: '保留会话', danger: true });
          if (!confirmed) return;
          if (session.meetingId && meetings[session.meetingId]) {
            // Remove membership and its dependent participant/workflow indices
            // through the room API, including when the member is already asleep.
            try {
              const result = await ipcRenderer.invoke('remove-meeting-sub', { meetingId: session.meetingId, sessionId: sid });
              if (!result?.ok) {
                const reasons = { last_member: '这是最后一个成员，请使用删除会议室。', turn_in_progress: '本轮群聊正在进行，请结束后再删除成员。',
                  turn_state_unavailable: '无法确认群聊状态，请稍后重试。' };
                showNotice(reasons[result?.reason] || result?.message || '删除会议室成员失败，请稍后重试。');
                return;
              }
              sessions.delete(sid);
              if (getActiveSessionId() === sid) setActiveSessionId(null);
              renderSessionList();
              schedulePersist();
            } catch (error) {
              showNotice('删除会议室成员失败：' + (error?.message || String(error)));
            }
            return;
          }
          if (session.status === 'dormant') {
            const result = await ipcRenderer.invoke('delete-session', sid);
            if (!result?.ok) {
              showNotice(result?.message || '永久删除失败，请稍后重试。');
              return;
            }
            sessions.delete(sid);
            if (getActiveSessionId() === sid) setActiveSessionId(null);
            renderSessionList();
            schedulePersist();
          } else {
            const result = await ipcRenderer.invoke('delete-session', sid);
            if (!result || !result.ok) {
              showNotice((result && result.message) || '永久删除失败，请稍后重试。');
            }
          }
        }
      });
    }
  }

  return { init, open, close };
}

function createTerminalContextMenuController({
  document,
  window,
  termCtxMenuEl,
  openPreviewPanel,
  syncSelection,
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  let termCtxMenuSelection = null;

  function open(selection, x, y) {
    termCtxMenuSelection = selection;
    termCtxMenuEl.style.display = 'block';
    termCtxMenuEl.style.left = `${x}px`;
    termCtxMenuEl.style.top = `${y}px`;
    requestAnimationFrameFn(() => {
      const rect = termCtxMenuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) termCtxMenuEl.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) termCtxMenuEl.style.top = `${y - rect.height}px`;
    });
  }

  function close() {
    termCtxMenuEl.style.display = 'none';
    termCtxMenuSelection = null;
  }

  function init() {
    document.addEventListener('mousedown', (e) => {
      if (termCtxMenuEl.style.display === 'block' && !termCtxMenuEl.contains(e.target)) {
        close();
      }
    });

    const previewBtn = termCtxMenuEl.querySelector('[data-action="preview"]');
    if (previewBtn) {
      previewBtn.addEventListener('click', () => {
        const sel = termCtxMenuSelection;
        close();
        if (sel) openPreviewPanel(sel.trim());
      });
    }
    const syncBtn = typeof syncSelection === 'function'
      ? termCtxMenuEl.querySelector('[data-action="sync-chatgpt"]')
      : null;
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
        const sel = termCtxMenuSelection;
        close();
        if (sel && typeof syncSelection === 'function') await syncSelection(sel);
      });
    }
  }

  return { init, open, close };
}

module.exports = {
  createSessionContextMenuController,
  createTerminalContextMenuController,
  supportsRecoverableSessionKind,
};
