'use strict';

/**
 * 群聊分支的三个界面入口（2026-09-17）：
 *
 *   - 会话右键「加入群聊…」：选一个已有群聊，或直接以这个会话开一个新群聊
 *   - 群聊「+ 成员 → 从已有会话分支…」：从会话清单里挑一个进来
 *   - 群聊右键「分支群聊」：整个群聊连人带记录复制一份
 *
 * 界面用的是仓库里已有的两套壳：浮动小菜单沿用 `.mr-quote-menu`，
 * 列表弹窗沿用 `.modal-overlay / .modal / .modal-row`（和"恢复会话"弹窗同一套
 * CSS），所以这里只建 DOM、不新增样式文件。
 *
 * 所有失败都必须看得见：主进程返回 { ok:false, message } 时原样弹给用户，
 * 不吞、不降级成"已提交"。
 */

const KIND_SHORT = {
  claude: 'Claude',
  'claude-resume': 'Claude',
  codex: 'Codex',
  'codex-resume': 'Codex',
  deepseek: 'DeepSeek',
  'deepseek-resume': 'DeepSeek',
  'deepseek-acp': 'DeepSeek',
  qwen: 'Qwen',
  glm: 'GLM',
  gemini: 'Gemini',
  kimi: 'Kimi',
};

function _shortKind(kind) {
  return KIND_SHORT[kind] || String(kind || 'AI');
}

function _relativeTime(ms) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return '';
  const diff = Date.now() - at;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function _closeFloating(document, id) {
  const old = document.getElementById(id);
  if (old) old.remove();
}

/** 浮动小菜单。items: [{ label, sub, run }] */
function openFloatingMenu({ document, id, x, y, items, emptyLabel = '（没有可选项）' }) {
  _closeFloating(document, id);
  const menu = document.createElement('div');
  menu.id = id;
  menu.className = 'mr-quote-menu';
  menu.style.top = `${y}px`;
  menu.style.left = `${x}px`;
  menu.style.maxHeight = '320px';
  menu.style.overflowY = 'auto';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'mr-quote-menu-item';
    empty.style.opacity = '0.6';
    empty.textContent = emptyLabel;
    menu.appendChild(empty);
  }
  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'mr-quote-menu-item';
    button.type = 'button';
    button.textContent = item.sub ? `${item.label}  ·  ${item.sub}` : item.label;
    button.addEventListener('click', async () => {
      menu.remove();
      await item.run();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, y - rect.height)}px`;
  const dismiss = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener('mousedown', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  return menu;
}

/** 会话选择弹窗：带过滤框的列表，选中即回调。 */
function openSessionPicker({ document, rows, title, hint, onPick, emptyLabel }) {
  _closeFloating(document, 'gc-fork-picker');
  const overlay = document.createElement('div');
  overlay.id = 'gc-fork-picker';
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">${title}</div>
        <button class="modal-close" type="button" data-gc-picker-close="1">×</button>
      </div>
      <input class="modal-filter" type="text" placeholder="筛选会话…" data-gc-picker-filter="1">
      <div class="modal-body" data-gc-picker-body="1"></div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('[data-gc-picker-body]');
  const filterInput = overlay.querySelector('[data-gc-picker-filter]');

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  function onKey(event) {
    if (event.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('[data-gc-picker-close]').addEventListener('click', close);

  function render(keyword) {
    const needle = String(keyword || '').trim().toLowerCase();
    const matched = rows.filter(row => !needle
      || String(row.title || '').toLowerCase().includes(needle)
      || String(row.kind || '').toLowerCase().includes(needle)
      || (row.kind === 'meeting' && '群聊'.includes(needle))
      || String(row.cwd || '').toLowerCase().includes(needle));
    body.textContent = '';
    if (!matched.length) {
      const empty = document.createElement('div');
      empty.className = 'modal-empty';
      empty.textContent = rows.length
        ? '没有匹配的会话'
        : (emptyLabel || '没有可分支的会话：会话至少要完成过一轮对话，才有原生会话 ID 可以分支。');
      body.appendChild(empty);
      return;
    }
    if (hint) {
      const note = document.createElement('div');
      note.className = 'modal-empty';
      note.style.textAlign = 'left';
      note.textContent = hint;
      body.appendChild(note);
    }
    for (const row of matched) {
      const item = document.createElement('div');
      item.className = 'modal-row';
      item.dataset.gcPickerRow = row.id;
      const meta = (row.kind === 'meeting'
        ? ['群聊', row.memberCount ? `${row.memberCount} 位成员` : '', _relativeTime(row.lastMessageTime)]
        : [_shortKind(row.kind), row.meetingTitle ? `群聊：${row.meetingTitle}` : '独立会话', _relativeTime(row.lastMessageTime)]
      ).filter(Boolean).join(' · ');
      const main = document.createElement('div');
      main.className = 'modal-row-main';
      main.textContent = row.title || (row.kind === 'meeting' ? '（未命名群聊）' : '（未命名会话）');
      const metaEl = document.createElement('div');
      metaEl.className = 'modal-row-meta';
      metaEl.textContent = meta;
      item.appendChild(main);
      item.appendChild(metaEl);
      item.addEventListener('click', async () => {
        close();
        await onPick(row);
      });
      body.appendChild(item);
    }
  }
  filterInput.addEventListener('input', () => render(filterInput.value));
  render('');
  setTimeout(() => filterInput.focus(), 0);
  return { close };
}

/**
 * 轻提示。进度和成功**不能**用模态框：2026-09-17 真机验证时就被自己的
 * 「正在加入…」对话框挡住了后面的操作——用户点一次菜单要多点一次「知道了」。
 * 失败仍然走调用方给的 notify（横幅或对话框），那种必须挡住人。
 */
function showForkToast(document, message, level) {
  let el = document.getElementById('gc-fork-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gc-fork-toast';
    Object.assign(el.style, {
      position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)',
      zIndex: '100000', maxWidth: 'min(520px, 90vw)', padding: '10px 15px',
      borderRadius: '10px', color: '#f5f5f7',
      font: '13px -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
      boxShadow: '0 8px 28px rgba(0,0,0,.35)', pointerEvents: 'none',
    });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.background = level === 'error' ? 'rgba(184, 47, 47, .96)' : 'rgba(34, 34, 38, .96)';
  el.style.display = 'block';
  if (el._hideTimer) clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 2600);
}

function createGroupChatForkUi({ document, ipcRenderer, notify, getMeetings, selectMeeting, confirmAction }) {
  const say = (message, level) => {
    if (level === 'error' && typeof notify === 'function') notify(message, level);
    else showForkToast(document, message, level);
  };

  async function fetchForkableSessions(meetingId) {
    return ipcRenderer.invoke('groupchat:forkable-sessions', { meetingId: meetingId || null });
  }

  /** 群聊「+ 成员 → 从已有会话分支…」 */
  async function addExistingSessionToMeeting(meetingId, onDone) {
    let rows = [];
    try { rows = await fetchForkableSessions(meetingId); }
    catch (error) { say(`读取会话清单失败：${error && error.message}`, 'error'); return; }
    openSessionPicker({
      document,
      rows,
      title: '从已有会话分支一个成员进来',
      hint: '会分支出一个新会话进群，原会话不受影响。',
      onPick: async (row) => {
        say(`正在把「${row.title}」分支进群聊…`);
        let result;
        try { result = await ipcRenderer.invoke('groupchat:add-existing-session', { meetingId, sessionId: row.id }); }
        catch (error) { say(`加入失败：${error && error.message}`, 'error'); return; }
        if (!result || !result.ok) {
          say(`加入失败：${(result && result.message) || '未知原因'}`, 'error');
          return;
        }
        say(`「${result.session.title}」已加入群聊`);
        if (typeof onDone === 'function') await onDone(result);
      },
    });
  }

  /** 会话右键「加入群聊…」：选已有群聊，或以它新建一个群聊。 */
  async function openJoinGroupMenu(sessionId, x, y) {
    const meetings = typeof getMeetings === 'function' ? getMeetings() : {};
    const groupChats = Object.values(meetings || {})
      .filter(meeting => meeting && meeting.groupChat)
      .filter(meeting => !(meeting.subSessions || []).includes(sessionId))
      .sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
    const items = [
      {
        label: '＋ 新建群聊（以此会话分支）',
        run: async () => {
          say('正在新建群聊…');
          let result;
          try { result = await ipcRenderer.invoke('groupchat:create-from-sessions', { sessionIds: [sessionId] }); }
          catch (error) { say(`新建群聊失败：${error && error.message}`, 'error'); return; }
          if (!result || !result.ok) {
            say(`新建群聊失败：${(result && result.message) || '未知原因'}`, 'error');
            return;
          }
          say(`已新建「${result.meeting.title}」`);
          if (typeof selectMeeting === 'function') selectMeeting(result.meeting.id);
        },
      },
      ...groupChats.map(meeting => ({
        label: meeting.title,
        sub: `${(meeting.subSessions || []).length} 人`,
        run: async () => {
          say(`正在加入「${meeting.title}」…`);
          let result;
          try { result = await ipcRenderer.invoke('groupchat:add-existing-session', { meetingId: meeting.id, sessionId }); }
          catch (error) { say(`加入失败：${error && error.message}`, 'error'); return; }
          if (!result || !result.ok) {
            say(`加入失败：${(result && result.message) || '未知原因'}`, 'error');
            return;
          }
          say(`已加入「${meeting.title}」`);
          if (typeof selectMeeting === 'function') selectMeeting(meeting.id);
        },
      })),
    ];
    openFloatingMenu({ document, id: 'gc-join-group-menu', x, y, items });
  }

  /** 群聊右键「分支群聊」：整群复制一份。 */
  async function forkMeeting(meetingId) {
    const meetings = typeof getMeetings === 'function' ? getMeetings() : {};
    const meeting = (meetings || {})[meetingId];
    if (!meeting) return;
    const memberCount = (meeting.subSessions || []).length;
    if (typeof confirmAction === 'function') {
      const ok = await confirmAction(
        `把「${meeting.title}」整个分支一份？\n\n会新建 ${memberCount} 个成员会话，各自继承现在的上下文，群聊记录一起复制过去。原群聊不受影响。`,
        { title: '分支群聊', acceptLabel: '开始分支' },
      );
      if (!ok) return;
    }
    say(`正在分支「${meeting.title}」，共 ${memberCount} 位成员…`);
    let result;
    try { result = await ipcRenderer.invoke('groupchat:fork-meeting', { meetingId }); }
    catch (error) { say(`分支失败：${error && error.message}`, 'error'); return; }
    if (!result || !result.ok) {
      say(`分支失败：${(result && result.message) || '未知原因'}`, 'error');
      return;
    }
    say(`已分支为「${result.meeting.title}」`);
    if (typeof selectMeeting === 'function') selectMeeting(result.meeting.id);
  }

  return { addExistingSessionToMeeting, forkMeeting, openJoinGroupMenu };
}

module.exports = { createGroupChatForkUi, openFloatingMenu, openSessionPicker, showForkToast };
