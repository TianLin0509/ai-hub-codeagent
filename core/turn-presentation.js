'use strict';

const path = require('node:path');
const { discoverCompletionArtifacts } = require('./completion-artifacts.js');

const MAX_ACTIVITIES = 24;
const MAX_CHANGED_FILES = 12;
const MAX_CHECKS = 8;
// Keep source results complete; only the renderer limits its initial preview.

const FINAL_STOP_REASONS = new Set([
  'end_turn',
  'task_complete',
  'stop',
  'max_tokens',
  'refusal',
  'stop_sequence',
]);

function cleanText(value, max = 240) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeActivityStatus(tool = {}) {
  const raw = String(tool.status || '').replace(/[-\s]/g, '_').toLowerCase();
  const exit = optionalFiniteNumber(tool.exitCode);
  if (tool.isError === true || (exit !== null && exit !== 0)) return 'failed';
  if (raw === 'unknown') return 'unknown';
  if (raw === 'declined') return 'declined';
  if (raw === 'failed' || raw === 'error' || raw === 'errored') return 'failed';
  if (raw === 'cancelled' || raw === 'canceled' || raw === 'interrupted') return 'cancelled';
  if (raw === 'completed' || raw === 'complete' || raw === 'done' || raw === 'success' || raw === 'succeeded') {
    return 'completed';
  }
  if (raw === 'pending' || raw === 'queued' || raw === 'waiting') return 'pending';
  if (raw === 'running' || raw === 'in_progress' || raw === 'started') return 'running';
  if (Object.prototype.hasOwnProperty.call(tool, 'result')
      || Object.prototype.hasOwnProperty.call(tool, 'completedAt')) return 'completed';
  return 'running';
}

function activityKind(name, input = {}) {
  const normalized = String(name || '').replace(/[_\-\s]/g, '').toLowerCase();
  const rawInput = typeof input === 'string' ? input : '';
  if (/tools\.apply_patch|\*\*\*\s+(?:Begin Patch|Add File|Update File|Delete File)/i.test(rawInput)) return 'edit';
  if (/(delete|remove|unlink)/.test(normalized)) return 'delete';
  if (/(move|rename)/.test(normalized)) return 'move';
  if (/(applypatch|edit|write|filechange|notebookedit)/.test(normalized)) return 'edit';
  if (/(read|view|list|glob|inspect)/.test(normalized)) return 'read';
  if (/(search|grep|find)/.test(normalized)) return 'search';
  if (/(fetch|web|http|browser)/.test(normalized)) return 'fetch';
  if (/(bash|shell|exec|command|powershell|terminal|run)/.test(normalized)) return 'execute';
  if (/(think|plan|reason)/.test(normalized)) return 'think';
  if (input && (input.command || input.cmd || input.parsed_cmd)) return 'execute';
  return 'other';
}

// Same fields, same precedence, as activityDetail reads from an object input:
// a command wins over the file or query it touches.
const EMBEDDED_DETAIL_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description'];

function parseEmbeddedCommand(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      for (const key of EMBEDDED_DETAIL_KEYS) {
        if (typeof parsed[key] === 'string' && parsed[key].trim()) return parsed[key];
      }
    }
  } catch {}
  for (const key of EMBEDDED_DETAIL_KEYS) {
    const match = trimmed.match(new RegExp(`["']${key}["']\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 's'));
    if (match) {
      try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
    }
  }
  // A tool call whose arguments are still streaming is an unterminated JSON
  // string such as '{"file_path": "C:\\Users\\li'. Show the value typed so far,
  // so a running row reads like the finished one instead of a raw JSON prefix.
  for (const key of EMBEDDED_DETAIL_KEYS) {
    // A delta can end right after an escape character, leaving one lone
    // backslash; it is dropped rather than letting it break the whole match.
    const partial = trimmed.match(new RegExp(`["']${key}["']\\s*:\\s*"((?:\\\\.|[^"\\\\])*)\\\\?$`, 's'));
    if (partial) {
      try { return JSON.parse(`"${partial[1]}"`); } catch { return partial[1]; }
    }
  }
  return trimmed.split(/\r?\n/)[0].slice(0, 300);
}

function activityDetail(name, input = {}) {
  if (typeof input === 'string') return cleanText(parseEmbeddedCommand(input), 180);
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      return cleanText(input[key].split(/\r?\n/)[0], 180);
    }
  }
  if (Array.isArray(input.command)) return cleanText(input.command.join(' '), 180);
  return cleanText(name, 180);
}

function activityTitle(kind, name) {
  const labels = {
    read: '读取',
    search: '搜索',
    fetch: '获取',
    edit: '修改',
    delete: '删除',
    move: '移动',
    execute: '执行',
    think: '计划',
    other: '工具',
  };
  const toolName = cleanText(name || 'Tool', 60);
  return `${labels[kind] || labels.other} · ${toolName}`;
}

function toolResultText(tool) {
  const value = tool?.result ?? tool?.output;
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function normalizeToolActivity(tool, index = 0) {
  const input = tool && Object.prototype.hasOwnProperty.call(tool, 'input') ? tool.input : {};
  const name = cleanText(tool && tool.name || 'Tool', 80) || 'Tool';
  const kind = activityKind(name, input);
  const result = toolResultText(tool);
  return {
    id: cleanText(tool && (tool.id || tool.toolCallId || tool.callId) || `activity-${index}`, 160),
    name,
    kind,
    status: normalizeActivityStatus(tool || {}),
    title: activityTitle(kind, name),
    detail: activityDetail(name, input),
    input,
    result,
    resultRef: tool?.resultRef || null,
    resultTruncated: tool?.resultTruncated === true,
    isError: tool?.isError === true,
    exitCode: optionalFiniteNumber(tool?.exitCode),
    durationMs: optionalFiniteNumber(tool?.durationMs),
    startedAt: optionalFiniteNumber(tool?.startedAt),
    completedAt: optionalFiniteNumber(tool?.completedAt),
    locations: Array.isArray(tool?.locations) ? tool.locations.slice(0, 12) : [],
    inferred: tool?.inferred === true,
  };
}

function resolveCandidatePath(value, cwd) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let candidate = value.trim().replace(/^file:\/\//i, '');
  try { candidate = decodeURIComponent(candidate); } catch {}
  candidate = candidate.replace(/^\/+([A-Za-z]:[\\/])/, '$1');
  try {
    if (path.isAbsolute(candidate)) return path.normalize(candidate);
    if (cwd) return path.resolve(cwd, candidate);
  } catch {}
  return null;
}

function patchPaths(command) {
  const paths = [];
  const re = /^\*\*\* (?:Add|Update|Delete|Move to) File:\s*(.+)$/gmi;
  let match;
  while ((match = re.exec(String(command || '')))) paths.push(match[1].trim());
  return paths;
}

function changedPathsFromActivity(activity, cwd) {
  if (!activity || !['edit', 'delete', 'move'].includes(activity.kind)) return [];
  const values = [];
  const input = activity.input;
  if (input && typeof input === 'object') {
    for (const key of ['file_path', 'path', 'target_path', 'destination', 'new_path']) {
      if (typeof input[key] === 'string') values.push(input[key]);
    }
    if (typeof input.command === 'string') values.push(...patchPaths(input.command));
    if (Array.isArray(input.changes)) {
      for (const item of input.changes) {
        if (item && typeof item.path === 'string') values.push(item.path);
      }
    } else if (input.changes && typeof input.changes === 'object') {
      values.push(...Object.keys(input.changes));
    }
  } else if (typeof input === 'string') {
    values.push(...patchPaths(input));
  }
  for (const location of activity.locations || []) {
    if (location && typeof location.path === 'string') values.push(location.path);
  }
  return values.map(value => resolveCandidatePath(value, cwd)).filter(Boolean);
}

function looksLikeVerification(command) {
  const value = String(command || '').trim();
  if (!value) return false;
  return /(?:^|[;&|\s])(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b/i.test(value)
    || /(?:^|[;&|\s])(?:pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\w*\s+test|tsc\b|node\s+[^\r\n]*test)/i.test(value)
    || /git\s+diff\s+--check\b/i.test(value);
}

function verificationStatus(activity) {
  if (!activity) return 'unknown';
  const exit = optionalFiniteNumber(activity.exitCode);
  if (activity.status === 'failed' || activity.isError === true || (exit !== null && exit !== 0)) return 'failed';
  if (activity.status === 'running' || activity.status === 'pending' || activity.status === 'cancelled') return activity.status;
  if (activity.exitCode === 0) return 'completed';
  const output = String(activity.result || '');
  if (/\bfail(?:ed|ures?)?\s*[:=]?\s*[1-9]\d*\b/i.test(output)
      || /\b[1-9]\d*\s+(?:tests?\s+)?failed\b/i.test(output)) return 'failed';
  if (/\b(?:all\s+)?tests?\s+passed\b/i.test(output)
      || /\bpass(?:ed)?\s*[:=]?\s*[1-9]\d*\b/i.test(output)
      || /\bfail(?:ed|ures?)?\s*[:=]?\s*0\b/i.test(output)
      || /\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*0\b/i.test(output)) return 'completed';
  return 'unknown';
}

function isTurnComplete(turn = {}) {
  if (['codex-app-server','acp','claude-stream-json'].includes(turn.source)) return turn.nativeOutcome === 'completed';
  return FINAL_STOP_REASONS.has(String(turn.stopReason || '').toLowerCase());
}

function buildTurnPresentation(turn = {}, options = {}) {
  const cwd = options.cwd || null;
  const allActivities = (Array.isArray(turn.toolCalls) ? turn.toolCalls : []).map(normalizeToolActivity);
  const activities = allActivities.slice(-MAX_ACTIVITIES);
  const deliveryTurn = turn.deliveryContext || turn;
  const deliveryActivities = deliveryTurn === turn ? allActivities
    : (deliveryTurn.toolCalls || []).map(normalizeToolActivity);
  const running = [...activities].reverse().find(activity => activity.status === 'running' || activity.status === 'pending') || null;
  const changedFiles = [];
  const changedSeen = new Map();
  for (const activity of deliveryActivities) {
    for (const filePath of changedPathsFromActivity(activity, cwd)) {
      const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
      const previous = changedSeen.get(key);
      if (previous) {
        previous.status = previous.status === 'completed' || activity.status === 'completed' ? 'completed' : activity.status;
        if (activity.status === 'completed') previous.kind = activity.kind;
        if (activity.status === 'failed') previous.failedAttempts++;
        continue;
      }
      const file = { path: filePath, name: path.basename(filePath), status: activity.status, kind: activity.kind,
        failedAttempts: activity.status === 'failed' ? 1 : 0 };
      changedSeen.set(key, file);
      changedFiles.push(file);
    }
  }

  const checks = deliveryActivities
    .filter(activity => activity.kind === 'execute' && looksLikeVerification(activity.detail))
    .map(activity => ({
      id: activity.id,
      command: activity.detail,
      status: verificationStatus(activity),
      exitCode: activity.exitCode,
      durationMs: activity.durationMs,
    }));

  let artifacts = [];
  if (isTurnComplete(deliveryTurn) && deliveryTurn.text) {
    try { artifacts = discoverCompletionArtifacts(deliveryTurn.text, cwd, { maxArtifacts: 3 }); }
    catch (error) {
      artifacts = [];
      console.warn('[turn-presentation] artifact discovery failed:', error && error.message);
    }
  }

  const delivery = {
    source: 'deterministic',
    complete: isTurnComplete(deliveryTurn),
    logicalTurnId: deliveryTurn.id || null,
    changedFiles,
    checks,
    artifacts,
  };
  delivery.hasContent = delivery.complete
    && (changedFiles.length > 0 || checks.length > 0 || artifacts.length > 0);

  return {
    source: 'deterministic',
    activities,
    activityCount: allActivities.length,
    currentActivity: running,
    delivery,
  };
}

module.exports = {
  FINAL_STOP_REASONS,
  MAX_ACTIVITIES,
  MAX_CHANGED_FILES,
  MAX_CHECKS,
  activityDetail,
  activityKind,
  buildTurnPresentation,
  changedPathsFromActivity,
  isTurnComplete,
  looksLikeVerification,
  normalizeActivityStatus,
  normalizeToolActivity,
  toolResultText,
  parseEmbeddedCommand,
  verificationStatus,
};
