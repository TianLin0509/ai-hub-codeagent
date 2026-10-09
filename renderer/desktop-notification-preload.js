'use strict';

const { ipcRenderer } = require('electron');

let currentSessionId = '';

function formatClock(value) {
  const timestamp = Number(value) || Date.now();
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
  } catch (_) {
    return '';
  }
}

function applyPayload(payload = {}) {
  currentSessionId = String(payload.sessionId || '');
  const title = document.getElementById('notification-title');
  const body = document.getElementById('notification-body');
  const time = document.getElementById('notification-time');
  const count = document.getElementById('notification-count');
  const card = document.getElementById('notification-card');
  const progress = document.getElementById('notification-progress');
  if (title) title.textContent = String(payload.title || 'AI 会话');
  if (body) body.textContent = String(payload.body || '本轮回答已经完成，点击回到会话查看。');
  if (time) time.textContent = formatClock(payload.completedAt);
  if (count) {
    const readyCount = Math.max(1, Number(payload.readyCount) || 1);
    count.hidden = readyCount <= 1;
    count.textContent = readyCount > 1 ? `另有 ${readyCount - 1} 个待查看` : '';
  }
  if (card) {
    card.dataset.sessionId = currentSessionId;
    card.dataset.sequence = String((Number(card.dataset.sequence) || 0) + 1);
  }
  if (progress) {
    progress.style.setProperty('--notification-timeout', `${Math.max(1000, Number(payload.autoHideMs) || 9000)}ms`);
    progress.classList.remove('running');
    void progress.offsetWidth;
    progress.classList.add('running');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const card = document.getElementById('notification-card');
  const close = document.getElementById('notification-close');
  card?.addEventListener('click', () => {
    if (currentSessionId) ipcRenderer.send('desktop-notification:open', { sessionId: currentSessionId });
  });
  close?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    ipcRenderer.send('desktop-notification:dismiss');
  });
});

ipcRenderer.on('desktop-notification:payload', (_event, payload) => applyPayload(payload));
