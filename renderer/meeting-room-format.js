// Shared presentation helpers for meeting-room.js.

const { chatAvatarSrc } = require('./chat-avatar');

const KIND_AVATAR_FALLBACK = {
  claude: 'CL',
  gemini: 'GE',
  codex: 'CX',
  deepseek: 'DS',
  kimi: 'KM',
};

const SLOT_AVATARS = [
  '',
  '',
  '',
];
const SLOT_AVATAR_FALLBACK = ['1', '2', '3'];

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ftCtxClass(pct) {
  if (typeof pct !== 'number') return 'ok';
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'warn';
  return 'ok';
}

function formatTokens(n) {
  if (n == null || n === 0) return '-';
  if (n < 1000) return String(n);
  if (n < 1000000) {
    const v = (n / 1000).toFixed(1);
    return v.replace(/\.0$/, '') + 'k';
  }
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function formatThinkTime(seconds) {
  if (seconds == null || seconds === 0) return '-';
  if (seconds < 60) {
    return seconds < 10 ? `${seconds.toFixed(1).replace(/\.0$/, '')}s` : `${Math.round(seconds)}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, '0')}s`;
}

function avatarSrcFor(kind) {
  return chatAvatarSrc(kind) || '';
}

function avatarFallbackFor(kind) {
  return KIND_AVATAR_FALLBACK[kind] || '\uD83E\uDD16';
}

function avatarBySlot(index) {
  return SLOT_AVATARS[index] || '';
}

function avatarFallbackBySlot(index) {
  return SLOT_AVATAR_FALLBACK[index] || '\uD83E\uDD16';
}

module.exports = {
  avatarBySlot,
  avatarFallbackBySlot,
  avatarFallbackFor,
  avatarSrcFor,
  escapeHtml,
  formatThinkTime,
  formatTokens,
  ftCtxClass,
};
