'use strict';
// 「问家里」MCP（2026-10-15）：公司电脑上的 CodeAgent 遇到难题时，请家里 AI Hub 的 Claude（不可用时换 Codex）帮它拿主意。JSON-RPC over stdio。
// 只转发给本机 Hub：地址在环境变量指向的文件里，会话通行证在环境变量里（只能代表本会话），都不出现在工具输出；本身不联网、不执行命令。
// 正文少于 2 万字的限制在 Hub 的本机接口里检查（core/company-bridge/ask-home.js），这里不重复。
const readline = require('node:readline');
const fs = require('node:fs');
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const tools = [
  {
    name: 'ask_home',
    description: '请家里 AI Hub 的 Claude（不可用时换 Codex）帮你拿主意。适合：拿不准的设计取舍或技术路线、反复排查仍找不到原因的问题、需要更强模型把关的关键判断；'
      + '用户让你「问一下家里」「让家里的 Claude 看看」时也用它。'
      + '家里看不到你的上下文，内容要自包含：写清背景、要决定的是什么、已经试过什么和结果、关键约束，以及你希望得到什么样的答复。'
      + '正文必须少于 2 万字，超了会被拒收：摘关键片段，不整段粘贴大文件或完整日志。'
      + '家里需要公司这边的事实时会回来查，所以一个来回通常 5–20 分钟、有时更久：把问题一次问全、问到关键。'
      + '调用后立即返回编号；回复到了 Hub 会把它作为一条新消息自动发到本会话。发出后请结束本轮，或先做不依赖回复的工作，不要循环等待或反复查询。',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: schema({ question: { type: 'string', description: 'Markdown 格式的完整求助内容（少于 2 万字）' }, title: { type: 'string', description: '一句话标题（可选，20 字内）' } }, ['question']),
  },
  {
    name: 'followup_home',
    description: '对同一编号追问。家里是同一个会话，记得之前的讨论。家里的回复和你在公司这边看到的事实不符、需要更细的建议、或想让它评估你的新方案时使用。'
      + '正文同样必须少于 2 万字。次数不限，每次一个来回通常 5–20 分钟；上一轮回复到达前不能追问。',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: schema({ thread: { type: 'string', description: '编号，如 H-1015-01' }, question: string }, ['thread', 'question']),
  },
  {
    name: 'home_thread',
    description: '查看本会话向家里求助过的问题、进度和全部回复（不传 thread 时列出本会话最近 10 个），以及家里 Hub 是否在线。回复会自动送达，一般不需要调用。',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: schema({ thread: string }),
  },
];

async function handle(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'home-bridge', version: '0.1.0' } };
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method === 'tools/call') {
    if (!tools.some(t => t.name === request.params?.name)) throw new Error('未知工具');
    const endpoint = JSON.parse(fs.readFileSync(process.env.HUB_HOME_LINK_ENDPOINT_FILE, 'utf8'));
    const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + (process.env.HUB_HOME_LINK_PASS || ''), 'Content-Type': 'application/json', 'X-Hub-Home-Link-Session': process.env.HUB_HOME_LINK_SESSION_ID || '' },
      body: JSON.stringify(request.params), signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(data.ok ? data.result : { error: data.error }, null, 1) }], isError: !data.ok };
  }
  throw new Error('未知方法');
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async line => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id == null) return;
    const result = await handle(request);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: error.message } }) + '\n');
  }
});
