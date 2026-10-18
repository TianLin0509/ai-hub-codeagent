'use strict';
// 公司助理会话的 MCP（stdio 上的 JSON-RPC）：把工具调用原样转给 Hub 的本机接口（hub-tools.js）。
// 口令在 Hub 写的接口文件里，会话编号在环境变量里；两者都不出现在工具返回里。这里不执行任何命令。
const readline = require('node:readline');
const fs = require('node:fs');
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const id = { type: 'string', description: 'list_sessions 返回的会话编号' };
const tools = [
  { name: 'list_sessions', description: '列出这台电脑 Hub 里的会话：编号、标题、目录、状态（stuck 卡住等确认 / running 运行中 / reply 答完等回复 / idle 空闲 / closed 没打开）。用户问「现在有哪些会话」「谁卡住了」时先调它。', annotations: { readOnlyHint: true }, inputSchema: schema({}) },
  { name: 'read_session', description: '看一个会话的最新回答（默认末尾 4000 字）；卡住时附终端画面（题目和选项）。用户问某个会话做到哪了时用。', annotations: { readOnlyHint: true }, inputSchema: schema({ sessionId: id, maxChars: { type: 'number' }, screen: { type: 'boolean', description: '没卡住也要看终端画面时填 true' } }, ['sessionId']) },
  { name: 'send_session', description: '给一个空闲或答完的会话发一段话（推进、追问、改要求），直接执行。会话关着会先自动恢复。发出后 Hub 自动盯着它，做完或卡住推到手机，不用轮询。', inputSchema: schema({ sessionId: id, text: string }, ['sessionId', 'text']) },
  { name: 'create_session', description: '新开一个 CodeAgent 会话并交代任务，直接执行。cwd 是工作目录（用户提到项目时填它的完整路径，不填就用 Hub 默认的新目录）。Hub 自动盯着它，做完或卡住推到手机。', inputSchema: schema({ title: string, text: string, cwd: string }, ['title', 'text']) },
  { name: 'watch_session', description: '盯着一个会话：它下一次答完或卡住时推到手机（24 小时内有效）。用户说「做完告诉我」时用。', inputSchema: schema({ sessionId: id }, ['sessionId']) },
  { name: 'press_keys', description: '会话卡在确认或选择上（stuck）时替用户按键回答，例如选第 2 项填 ["2"]，确认填 ["enter"]，取消填 ["esc"]。先用 read_session 看清画面再按；按完返回新画面。', inputSchema: schema({ sessionId: id, keys: { type: 'array', items: { type: 'string', enum: ['enter', 'esc', 'up', 'down', 'tab', 'space', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9'] } } }, ['sessionId', 'keys']) },
  { name: 'stop_session', description: '停止一个正在运行的会话这一轮（同电脑上的停止键）。只在用户明确要求停下时用。', inputSchema: schema({ sessionId: id }, ['sessionId']) },
];

async function handle(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hub-sessions', version: '1.0.0' } };
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method === 'tools/call') {
    if (!tools.some(t => t.name === request.params?.name)) throw new Error('未知工具');
    const endpoint = JSON.parse(fs.readFileSync(process.env.HUB_COMPANY_TOOLS_ENDPOINT, 'utf8'));
    const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json', 'X-Hub-Company-Assistant-Session': process.env.HUB_COMPANY_ASSISTANT_SESSION_ID || '' },
      body: JSON.stringify({ name: request.params.name, arguments: request.params.arguments || {} }), signal: AbortSignal.timeout(120000) });
    const data = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(data.ok ? data.result : { error: data.error }) }], isError: !data.ok };
  }
  throw new Error('未知方法');
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async line => {
  let request;
  try { request = JSON.parse(line); if (request.id == null) return; const result = await handle(request); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: error.message } }) + '\n'); }
});
