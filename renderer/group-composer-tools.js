'use strict';

// Group input enhancements share the session reference/export and file-path
// conventions. Capture the destination before async work: the DOM is reused
// when the user switches rooms.
function mountGroupComposerTools({ toolbar, input, getMeeting, referenceSession,
  appendText, droppedFilePath, formatFilePaths, onDraft, onHistory, onExpand }) {
  const document = input.ownerDocument;
  const add = (className, label, title, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      action(button);
    });
    toolbar.appendChild(button);
    return button;
  };
  add('fi-bridge-reference', '引用会话', '引用其他会话或群聊的上下文', button => {
    const meeting = getMeeting();
    if (!meeting) return;
    void referenceSession(null, input, button, {
      excludeMeetingId: meeting.id,
      isCurrent: () => getMeeting()?.id === meeting.id && input.isConnected,
      saveDraft: () => onDraft(meeting.id),
    });
  });
  add('fi-bridge-reference mr-composer-history', '最近输入', '查看本群最近输入', button => onHistory(button));
  add('fi-bridge-reference mr-composer-expand', '展开编辑', '展开编辑长消息', onExpand);

  const row = input.parentNode;
  const carriesFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  row.addEventListener('dragover', event => {
    if (!getMeeting()?.groupChat || !carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    row.classList.add('drop-active');
  });
  row.addEventListener('dragleave', event => {
    if (!row.contains(event.relatedTarget)) row.classList.remove('drop-active');
  });
  row.addEventListener('drop', event => {
    row.classList.remove('drop-active');
    const meeting = getMeeting();
    if (!meeting?.groupChat || !carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const paths = Array.from(event.dataTransfer.files || []).map(droppedFilePath).filter(Boolean);
    if (!paths.length) return;
    appendText(input, formatFilePaths(paths));
    onDraft(meeting.id);
    input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    input.focus();
  });
}

module.exports = { mountGroupComposerTools };
