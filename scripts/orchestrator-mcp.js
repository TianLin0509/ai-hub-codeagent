'use strict';
// AI 负责人（原编排员）与成员的 MCP 工具（JSON-RPC over stdio）。身份来自 Hub 写入的环境变量，
// 每次调用把参数转交 Hub，由 Hub 校验身份并执行；这里不执行任何命令。
const readline = require('node:readline');
const fs = require('node:fs');
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const presets = { type: 'string', enum: ['development', 'filework', 'research', 'roundtable', 'custom'] };
const tools = [
  { name: 'orch_send_message', description: '向本群成员发送消息或任务。负责人可联系所有成员：对方空闲时立即开始；对方正在工作时默认排队到空闲，interrupt=true 则直接追加到它当前的工作里（用于改变它当前做法的指示）。成员默认联系负责人：wake=true（默认）立刻叫醒负责人，只用于卡住需拍板、发现与方案冲突的事实、完成里程碑；其余用 wake=false 留言，负责人下次醒来一起看。成员间获批后可相互交流（自动抄送负责人，抄送不叫醒）。', inputSchema: schema({ to: string, message: string, wake: { type: 'boolean' }, interrupt: { type: 'boolean' } }, ['to','message']) },
  { name: 'orch_request_peer', description: '工作成员向负责人申请与另一位工作成员交流，说明原因，等待批准后用 orch_send_message 联系。', inputSchema: schema({ memberId: string, reason: string }, ['memberId','reason']) },
  { name: 'orch_decide_peer', description: '负责人批准或拒绝成员间交流申请；批准后双方可互发消息并抄送负责人。', inputSchema: schema({ requestId: string, approve: { type: 'boolean' }, reason: string }, ['requestId','approve']) },
  { name: 'orch_allow_peer', description: '负责人主动开放或收回两位成员之间的直接交流（例如安排辩论、开发与审核对接），无需成员先申请。双方会收到通知；交流消息抄送负责人。', inputSchema: schema({ memberA: string, memberB: string, allow: { type: 'boolean' }, reason: string }, ['memberA','memberB','allow']) },
  { name: 'orch_status', annotations: { readOnlyHint: true },
    description: '读取本群计划账本：状态、额度、计划、已有成员（含会话状态）、进度与交付证据。currentRun 含派工回执、失败步骤和 recovery（能否原地续跑与可用手段）；communication 只列最近的通信。需要核对全局状态时调用。',
    inputSchema: schema({}) },
  { name: 'orch_propose_plan',
    description: '记录或更新方案规划与分工，提交即生效。summary 写自然语言目标、方案和完成标准；team 指定已有成员角色。segments 是可选的固定工作流；普通任务直接使用 orch_send_message。轮次、时长与停止条件由用户自然语言说明。',
    inputSchema: schema({
      summary: string,
      team: { type: 'array', items: schema({ memberId: string, role: string, reason: string }, ['memberId','role']) },
      segments: { type: 'array', items: schema({ name: string, preset: presets, goal: string, acceptance: string, steps: { type: 'integer', minimum: 1 } }, ['name', 'preset', 'acceptance']) },
      estimateRounds: { type: 'number' },
    }, ['summary']) },
  { name: 'orch_start_workflow',
    description: '启动当前计划中的工作段，name、preset、goal、acceptance 必须匹配计划；成员仅从已有队伍选取，同一时间一段。development：members=[实现位,独立审核位]，git 项目开题→实现与自测→审查并合并，返工自动迭代；filework：members=[实现位,独立审核位]，修改与自查→独立审核，需返工退回修改，不合并不推送；research / roundtable 为 2–3 位，members 第 2 位负责收口；custom 用 rounds 自定义步骤，各轮安排已有成员并行，轮间按 next/end 串行接续，最后一轮可设 review（需返工退回上一轮）。',
    inputSchema: schema({
      name: string, preset: presets, goal: string, acceptance: string,
      members: { type: 'array', items: string },
      rounds: { type: 'array', items: schema({ name: string, prompt: string, members: { type: 'array', items: string }, after: { type: 'string', enum: ['next', 'end', 'review'] } }, ['name', 'prompt', 'members']) },
    }, ['name', 'preset', 'goal', 'acceptance', 'members']) },
  { name: 'orch_control_workflow',
    description: '控制当前工作段：continue 续跑（故障处理后或用户暂停后）；remind 提醒未交付成员补交（可带 note 说明这一步该交什么）；skip 跳过当前步骤里某位未交付的成员（memberId，note 写跳过原因，会显示在群里并告诉后续成员；Hub 记为跳过而非交付；跳过开发/文件段的实现位会结束本段）；pause 暂停；cancel 取消本段，之后可改计划重派。',
    inputSchema: schema({ action: { type: 'string', enum: ['continue', 'remind', 'skip', 'pause', 'cancel'] }, note: string, memberId: string }, ['action']) },
  { name: 'orch_ask_member',
    description: '单独问某位成员一个问题（澄清、调研、复核），成员把回答写进群聊回答文件，Hub 回答后通知你。回答只作参考，不能当工作段的完成证据。成员正在工作流里干活时不能打断。',
    inputSchema: schema({ memberId: string, question: string }, ['memberId', 'question']) },
  { name: 'orch_restart_member',
    description: '重启某位成员的 CLI 会话（接着它原来的会话历史），用于成员报错、卡死或无响应；休眠的成员直接唤醒。之后用 orch_control_workflow 的 continue 或 remind 让它接着干。',
    inputSchema: schema({ memberId: string }, ['memberId']) },
  { name: 'orch_grant_budget',
    description: '兼容旧工具调用：本群已无固定轮次或时长上限，按用户自然语言要求推进。',
    inputSchema: schema({ rounds: { type: 'integer', minimum: 1 }, minutes: { type: 'number', minimum: 1 }, sourceQuote: string }, ['sourceQuote']) },
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
    let endpointFile = process.env.HUB_ORCH_ENDPOINT_FILE;
    const sid = process.env.HUB_ORCH_SESSION_ID || '';
    if (sid && /^[\w-]+$/.test(sid) && require('node:path').basename(endpointFile || '') === 'bridge-endpoint.json') {
      endpointFile = require('node:path').join(require('node:path').dirname(endpointFile), 'connections', sid + '.json');
    }
    const endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
    const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json', 'X-Hub-Orchestrator-Session': process.env.HUB_ORCH_SESSION_ID || '' }, body: JSON.stringify(request.params), signal: AbortSignal.timeout(120000) });
    if (response.status === 403) throw Error('群内通信身份已失效，请重新读取当前会话的通信入口后重试');
    const data = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(data.ok ? data.result : { error: data.error }) }], isError: !data.ok };
  }
  throw new Error('未知方法');
}
async function commandLine(argv) {
  const value = flag => argv[argv.indexOf(flag) + 1];
  process.env.HUB_ORCH_ENDPOINT_FILE = value('--connection');
  if (argv.includes('--list')) { console.log(JSON.stringify(tools)); return; }
  if (!argv.includes('--tool') || !argv.includes('--args-file')) throw Error('用法：--tool 工具名 --args-file UTF-8参数JSON文件；--list 查看工具');
  const result = await handle({ method: 'tools/call', params: { name: value('--tool'), arguments: JSON.parse(fs.readFileSync(value('--args-file'), 'utf8').replace(/^\uFEFF/, '')) } });
  console.log(result.content[0].text);
  if (result.isError) process.exitCode = 1;
}
if (require.main === module && process.argv.includes('--connection')) commandLine(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
else if (require.main === module) readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
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
