'use strict';

// CLI hook 原始载荷 → Hub hook 请求体。
//
// scripts/session-hub-hook.py 在 CLI 一侧做字段提取与截断；社区版不依赖 Python，
// 改由 scripts/session-hub-hook.ps1 把原始 JSON 原样转发到 /api/hook-raw/<event>，
// 在这里按与 Python 脚本逐字段一致的规则提取。两边一致性由
// tests/unit-hook-payload-parity.test.js 用同一批载荷比对。
//
// Python 语义的对应：
//   str(x)[:n]      → pyStr(x) 后按码点截取（不是 UTF-16 单元）
//   x or y / if x   → pyTruthy
//   json.dumps(x, ensure_ascii=False) → pyJsonDumps（默认分隔符带空格）

function pyTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function pyFloat(value) {
  if (Number.isInteger(value)) return value.toFixed(1);
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  return String(value);
}

function pyNumber(value) {
  // JSON 载荷里 1 与 1.0 解析后无法区分；按整数处理（Python json.loads 对 1 给 int）。
  return Number.isInteger(value) ? String(value) : pyFloat(value);
}

function pyJsonDumps(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return pyNumber(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(pyJsonDumps).join(', ') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).map(key => JSON.stringify(key) + ': ' + pyJsonDumps(value[key])).join(', ') + '}';
  }
  return JSON.stringify(String(value));
}

function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return pyNumber(value);
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const body = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
  }
  if (Array.isArray(value)) return '[' + value.map(pyRepr).join(', ') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).map(k => pyRepr(k) + ': ' + pyRepr(value[k])).join(', ') + '}';
  return String(value);
}

function pyStr(value) {
  return typeof value === 'string' ? value : pyRepr(value);
}

function sliceChars(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

function head(value, max) {
  return sliceChars(pyStr(value), max);
}

function truncateUtf8(value, maxBytes) {
  const text = pyStr(value);
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return text;
  // Python：encoded[:max-3].decode('utf-8', 'ignore') —— 截断处的半个字符直接丢掉。
  let cut = Math.max(0, maxBytes - 3);
  while (cut > 0 && (encoded[cut] & 0xC0) === 0x80) cut -= 1;
  return encoded.subarray(0, cut).toString('utf8') + '…';
}

function get(payload, key) {
  return Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : undefined;
}

function firstTruthy(...values) {
  for (const value of values) if (pyTruthy(value)) return value;
  return values[values.length - 1];
}

/**
 * @param {string} event  hook 参数（stop / prompt / tool-start ...）
 * @param {string|Buffer} raw  CLI 写到 hook stdin 的原始 JSON
 * @param {{sessionId:string, token:string}} identity  来自 Hub 注入的会话环境变量
 * @returns {object|null}  与 session-hub-hook.py POST 的请求体一致；tool-use 事件返回 null（Python 版不发请求）
 */
function normalizeHookPayload(event, raw, { sessionId, token = '' }) {
  if (event === 'tool-use') return null;
  let payload = {};
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    if (text) {
      const parsed = JSON.parse(text);
      // Python 版对非对象载荷调用 .get 会抛错并落入 except，保留已取到的空值。
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
    }
  } catch { payload = {}; }

  const body = { sessionId, token };
  const ccSessionId = get(payload, 'session_id');
  const cwd = get(payload, 'cwd');
  const transcriptPath = get(payload, 'transcript_path');
  const prompt = get(payload, 'prompt');
  const toolName = get(payload, 'tool_name');
  const toolInput = get(payload, 'tool_input');
  const toolResult = firstTruthy(get(payload, 'tool_response'), get(payload, 'tool_output'));
  const toolCallId = firstTruthy(get(payload, 'tool_use_id'), get(payload, 'tool_call_id'));
  const turnId = get(payload, 'turn_id');
  const agentId = get(payload, 'agent_id');
  const agentType = firstTruthy(get(payload, 'agent_type'), get(payload, 'agent_name'));
  const taskId = firstTruthy(get(payload, 'task_id'), get(payload, 'id'));
  const taskSubject = firstTruthy(get(payload, 'subject'), get(payload, 'description'));
  const hookEventName = get(payload, 'hook_event_name');
  const backgroundTasks = firstTruthy(get(payload, 'background_tasks'), []);
  const sessionCrons = firstTruthy(get(payload, 'session_crons'), []);
  const errorType = get(payload, 'error');
  const errorDetails = get(payload, 'error_details');
  const lastAssistantMessage = get(payload, 'last_assistant_message');
  const notificationType = get(payload, 'notification_type');
  const notificationMessage = get(payload, 'message');
  const notificationTitle = get(payload, 'title');

  if (pyTruthy(ccSessionId)) body.claudeSessionId = ccSessionId;
  if (pyTruthy(cwd)) body.cwd = cwd;
  if (pyTruthy(transcriptPath)) body.transcriptPath = transcriptPath;
  if (pyTruthy(prompt)) body.prompt = prompt;
  if (pyTruthy(hookEventName)) body.hookEventName = head(hookEventName, 80);
  if (event === 'session-start' && pyTruthy(get(payload, 'source'))) body.source = head(payload.source, 40);
  if (event === 'session-end' && pyTruthy(get(payload, 'reason'))) body.reason = head(payload.reason, 40);
  if ((event === 'session-start' || event === 'session-end') && pyTruthy(agentId)) body.agentId = head(agentId, 180);
  if (['session-start', 'session-end', 'pre-compact'].includes(event) && pyTruthy(get(payload, 'prompt_id'))) {
    body.promptId = head(payload.prompt_id, 120);
  }
  if (event === 'pre-compact') {
    if (pyTruthy(get(payload, 'trigger'))) body.trigger = head(payload.trigger, 20);
    if (typeof get(payload, 'custom_instructions') === 'string') body.customInstructions = sliceChars(payload.custom_instructions, 2000);
  }
  if (event === 'instructions-loaded') {
    body.instructionPath = head(firstTruthy(get(payload, 'file_path'), ''), 8192);
    body.loadReason = head(firstTruthy(get(payload, 'load_reason'), ''), 80);
    body.memoryType = head(firstTruthy(get(payload, 'memory_type'), ''), 80);
    if (pyTruthy(agentId)) body.agentId = head(agentId, 180);
  }
  const isDict = item => item && typeof item === 'object' && !Array.isArray(item);
  const field = (item, key, fallback) => (Object.prototype.hasOwnProperty.call(item, key) ? item[key] : fallback);
  if (Array.isArray(backgroundTasks)) {
    body.backgroundTasks = backgroundTasks.slice(0, 8).filter(isDict).map(item => ({
      id: head(field(item, 'id', ''), 120),
      type: head(field(item, 'type', ''), 80),
      status: head(field(item, 'status', ''), 80),
      description: head(field(item, 'description', ''), 160),
    }));
  }
  if (Array.isArray(sessionCrons)) {
    body.sessionCrons = sessionCrons.slice(0, 8).filter(isDict).map(item => ({
      id: head(field(item, 'id', ''), 120),
      schedule: head(field(item, 'schedule', ''), 120),
      recurring: pyTruthy(field(item, 'recurring', false)),
    }));
  }
  if (pyTruthy(errorType)) body.error = head(errorType, 160);
  if (pyTruthy(errorDetails)) body.errorDetails = head(errorDetails, 1000);
  if (pyTruthy(lastAssistantMessage)) body.lastAssistantMessage = head(lastAssistantMessage, 1200);
  if (pyTruthy(notificationType)) body.notificationType = head(notificationType, 160);
  if (pyTruthy(notificationMessage)) body.message = head(notificationMessage, 1000);
  if (pyTruthy(notificationTitle)) body.title = head(notificationTitle, 300);
  if (pyTruthy(toolName)) body.toolName = head(toolName, 160);
  if (pyTruthy(toolCallId)) body.toolCallId = head(toolCallId, 180);
  if (pyTruthy(turnId)) body.turnId = head(turnId, 180);
  const toolEvent = ['tool-start', 'tool-complete', 'tool-failed'].includes(event);
  if (toolEvent && toolInput !== undefined && toolInput !== null) {
    const encoded = pyJsonDumps(toolInput);
    body.toolInput = Buffer.byteLength(encoded, 'utf8') <= 3000 ? toolInput : truncateUtf8(encoded, 3000);
  }
  if ((event === 'tool-complete' || event === 'tool-failed') && toolResult !== undefined && toolResult !== null) {
    const encoded = typeof toolResult === 'string' ? toolResult : pyJsonDumps(toolResult);
    body.toolResult = truncateUtf8(encoded, 6000);
  }
  if (pyTruthy(agentId)) body.agentId = head(agentId, 180);
  if (pyTruthy(agentType)) body.agentType = head(agentType, 160);
  if (pyTruthy(taskId)) body.taskId = head(taskId, 180);
  if (pyTruthy(taskSubject)) body.taskSubject = head(taskSubject, 500);
  return body;
}

module.exports = { normalizeHookPayload, pyJsonDumps, pyStr, truncateUtf8, pyTruthy };
