'use strict';
// AI 编排员的 MCP 工具（JSON-RPC over stdio）。身份来自 Hub 写入的环境变量，
// 每次调用把参数转交 Hub，由 Hub 校验身份并执行；这里不执行任何命令。
const readline = require('node:readline');
const fs = require('node:fs');
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const presets = { type: 'string', enum: ['development', 'filework', 'research', 'roundtable', 'custom'] };
const tools = [
  { name: 'orch_status', annotations: { readOnlyHint: true },
    description: '读取本群计划账本：状态、额度、计划、已有成员（含会话状态）、进度与交付证据。currentRun 含派工回执、失败步骤和 recovery（能否原地续跑与可用手段）。每次被唤醒先调用。',
    inputSchema: schema({}) },
  { name: 'orch_propose_plan',
    description: '提交或更新计划，提交即生效（跳过成员、换人、调整步骤都直接提交新版本）。team 给已有成员分配角色（memberId 来自 orch_status，不含编排员）；segments 写各段唯一名称、模板、目标和验收标准；custom 段用 steps 写步数。Hub 按模板核算剩余各段至少需要的轮数并对比额度，结果在 budgetCheck 里，不够时向用户说明并给推荐额度。用户用自然语言说的额度由 Hub 识别并随计划生效；复杂表达可用 budget 引用用户原话，未指定的维度保持当前额度。',
    inputSchema: schema({
      summary: string,
      team: { type: 'array', items: schema({ memberId: string, role: string, reason: string }, ['memberId','role']) },
      budget: schema({roundCap:{type:'integer',minimum:1,maximum:30},timeCapMin:{type:'number',minimum:1,maximum:1440},sourceQuote:string},['sourceQuote']),
      segments: { type: 'array', items: schema({ name: string, preset: presets, goal: string, acceptance: string, steps: { type: 'integer', minimum: 1, maximum: 6 } }, ['name', 'preset', 'acceptance']) },
      estimateRounds: { type: 'number' },
    }, ['summary', 'segments']) },
  { name: 'orch_start_workflow',
    description: '启动当前计划中的工作段，name、preset、goal、acceptance 必须匹配计划；成员仅从已有队伍选取，同一时间一段。development：members=[实现位,独立审核位]，git 项目开题→实现与自测→审查并合并，返工自动迭代；filework：members=[实现位,独立审核位]，修改与自查→独立审核，需返工退回修改，不合并不推送；research / roundtable 为 2–3 位，members 第 2 位负责收口；custom 用 rounds 自定义 1–6 轮，各轮安排 1–3 位已有成员并行，轮间按 next/end 串行接续，最后一轮可设 review（需返工退回上一轮）。',
    inputSchema: schema({
      name: string, preset: presets, goal: string, acceptance: string,
      members: { type: 'array', items: string },
      rounds: { type: 'array', items: schema({ name: string, prompt: string, members: { type: 'array', items: string }, after: { type: 'string', enum: ['next', 'end', 'review'] } }, ['name', 'prompt', 'members']) },
    }, ['name', 'preset', 'goal', 'acceptance', 'members']) },
  { name: 'orch_control_workflow',
    description: '控制当前工作段：continue 续跑（故障处理后、额度追加后或返工上限暂停后）；remind 提醒未交付成员补交（可带 note 说明这一步该交什么）；skip 跳过当前步骤里某位未交付的成员（memberId，note 写跳过原因，会显示在群里并告诉后续成员；Hub 记为跳过而非交付；跳过开发/文件段的实现位会结束本段）；pause 暂停；cancel 取消本段，之后可改计划重派。',
    inputSchema: schema({ action: { type: 'string', enum: ['continue', 'remind', 'skip', 'pause', 'cancel'] }, note: string, memberId: string }, ['action']) },
  { name: 'orch_ask_member',
    description: '单独问某位成员一个问题（澄清、调研、复核），成员把回答写进群聊回答文件，Hub 回答后通知你。回答只作参考，不能当工作段的完成证据。成员正在工作流里干活时不能打断。',
    inputSchema: schema({ memberId: string, question: string }, ['memberId', 'question']) },
  { name: 'orch_restart_member',
    description: '重启某位成员的 CLI 会话（接着它原来的会话历史），用于成员报错、卡死或无响应；休眠的成员直接唤醒。之后用 orch_control_workflow 的 continue 或 remind 让它接着干。',
    inputSchema: schema({ memberId: string }, ['memberId']) },
  { name: 'orch_grant_budget',
    description: '用户在对话里同意追加额度后调用：rounds 追加的工作流轮数、minutes 追加的分钟，sourceQuote 引用他同意的原话（Hub 核对确为他本群发言，同一句只能用一次）。额度暂停随之解除。',
    inputSchema: schema({ rounds: { type: 'integer', minimum: 1, maximum: 30 }, minutes: { type: 'number', minimum: 1, maximum: 1440 }, sourceQuote: string }, ['sourceQuote']) },
  { name: 'orch_report',
    description: '记录汇报。progress=阶段进展；need_decision=需要用户取舍才能往下走，Hub 暂停派活，等他在输入框回话后自动解除；final=当前完整计划所有段满足验收且有审核或收口证据。用白话说明结果、缺项、阻塞与建议，附交付路径。',
    inputSchema: schema({ kind: { type: 'string', enum: ['progress', 'need_decision', 'final'] }, summary: string }, ['kind', 'summary']) },
];
async function handle(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hub-orchestrator', version: '0.1.0' } };
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method === 'tools/call') {
    if (!tools.some(t => t.name === request.params?.name)) throw new Error('未知工具');
    const endpoint = JSON.parse(fs.readFileSync(process.env.HUB_ORCH_ENDPOINT_FILE, 'utf8'));
    const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json', 'X-Hub-Orchestrator-Session': process.env.HUB_ORCH_SESSION_ID || '' }, body: JSON.stringify(request.params), signal: AbortSignal.timeout(120000) });
    const data = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(data.ok ? data.result : { error: data.error }) }], isError: !data.ok };
  }
  throw new Error('未知方法');
}
if (require.main === module) readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
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
module.exports = { tools };
