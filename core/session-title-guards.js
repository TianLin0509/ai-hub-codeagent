'use strict';

const { KIND_LABELS, HARNESS_LABELS } = require('./ai-kinds.js');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTitle(title) {
  return String(title || '').trim();
}

function stripBranchTitlePrefix(title) {
  return normalizeTitle(title).replace(/^分支\s*\d*\s*[:：]\s*/u, '').trim();
}

function parseBranchSessionIndex(title) {
  const match = normalizeTitle(title).match(/^分支\s*(\d+)\s*[:：]/u);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function formatBranchSessionTitle(title, fallback = '会话', branchIndex = null) {
  const base = stripBranchTitlePrefix(title) || normalizeTitle(fallback) || '会话';
  const index = Number(branchIndex);
  return Number.isInteger(index) && index > 0
    ? `分支${index}: ${base}`
    : `分支: ${base}`;
}

function normalizeLegacyBranchSessionTitle(title) {
  const clean = normalizeTitle(title);
  if (!clean) return clean;
  const legacy = clean.match(/^(.*?)\s*(?:·\s*分支|的分支)$/u);
  return legacy ? formatBranchSessionTitle(legacy[1]) : clean;
}

function migrateLegacyBranchSessionMeta(session, kindLabels = KIND_LABELS) {
  if (!session || typeof session !== 'object') return session;
  const originalTitle = normalizeTitle(session.title);
  const title = normalizeLegacyBranchSessionTitle(originalTitle);
  if (!title || title === originalTitle) return session;
  const baseTitle = stripBranchTitlePrefix(title);
  const branchAutoTitlePending = isGenericAutoSessionTitle(baseTitle, kindLabels);
  return {
    ...session,
    title,
    // The old fork handler set this flag itself. It was never a user rename.
    userRenamed: false,
    autoTitleGenerated: !branchAutoTitlePending,
    branchAutoTitlePending,
  };
}

function resolveKindLabels(kindLabels) {
  return kindLabels && typeof kindLabels === 'object' ? kindLabels : KIND_LABELS;
}

function buildGenericSessionTitleRe(kindLabels = KIND_LABELS) {
  const labels = Object.values(resolveKindLabels(kindLabels))
    .filter(Boolean)
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join('|');
  if (!labels) return /^$/;
  // Claude Code may briefly publish the bare provider label (for example
  // `claude`) before its real conversation title. A bare label is still a
  // placeholder, just like `Claude 1` / `Claude Resume 2`.
  return new RegExp(`^(?:${labels})(?:(?: Resume)? \\d+)?$`, 'i');
}

function isClaudeCodePlaceholderTitle(title) {
  const clean = normalizeTitle(title);
  if (!clean) return false;
  // Claude Code 2.1.x publishes transient activity titles such as
  // `Claude Code`, `◐ Claude Code`, and braille/dingbat spinner variants.
  // Match a short symbol-only prefix instead of enumerating glyphs so a new
  // spinner cannot become authoritative and block Hub/DeepSeek auto-title.
  return /^[^\p{L}\p{N}]{0,8}Claude Code$/iu.test(clean);
}

function isGenericAutoSessionTitle(title, kindLabels = KIND_LABELS) {
  const clean = normalizeTitle(title);
  return !clean
    || Object.values(HARNESS_LABELS).includes(clean)
    || isClaudeCodePlaceholderTitle(clean)
    || buildGenericSessionTitleRe(kindLabels).test(clean);
}

function looksLikePathTitle(title) {
  const clean = normalizeTitle(title);
  if (!clean) return false;
  if (/[A-Za-z]:[\\/]/.test(clean)) return true;
  if (/^\\\\/.test(clean)) return true;
  if (/[\\/]\.ai-hub-community[\\/]/i.test(clean)) return true;
  const slashCount = (clean.match(/[\\/]/g) || []).length;
  if (slashCount >= 2) return true;
  if (slashCount > 0 && /\.(?:png|jpe?g|gif|webp|bmp|exe|ps1|bat|cmd|md|html?|jsonl?|txt)(?:\s|$)/i.test(clean)) {
    return true;
  }
  return false;
}

function isStableSessionTitle(title, kindLabels = KIND_LABELS) {
  const clean = normalizeTitle(title);
  if (!clean) return false;
  if (isClaudeCodePlaceholderTitle(clean)) return false;
  return !looksLikePathTitle(clean) && !isGenericAutoSessionTitle(clean, kindLabels);
}

function shouldAcceptExternalSessionTitle(session, proposedTitle, kindLabels = KIND_LABELS) {
  if (!session || session.userRenamed || session.autoTitleGenerated || session.meetingId) return false;
  const clean = normalizeTitle(proposedTitle);
  // Never let a provider placeholder become authoritative. Otherwise the
  // first OSC title `claude` locks the card and blocks the meaningful title
  // that the CLI emits a moment later.
  if (!isStableSessionTitle(clean, kindLabels)) return false;
  return isGenericAutoSessionTitle(session.title, kindLabels);
}

module.exports = {
  buildGenericSessionTitleRe,
  formatBranchSessionTitle,
  isClaudeCodePlaceholderTitle,
  isGenericAutoSessionTitle,
  isStableSessionTitle,
  looksLikePathTitle,
  migrateLegacyBranchSessionMeta,
  normalizeLegacyBranchSessionTitle,
  normalizeTitle,
  parseBranchSessionIndex,
  shouldAcceptExternalSessionTitle,
  stripBranchTitlePrefix,
};
