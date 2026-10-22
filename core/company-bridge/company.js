'use strict';
// 公司 Hub 一端的常驻助理（2026-10-15）：像脚本一样定时去通道里取家里的问题，
// 每个问题新开一个 CodeAgent 会话作答，答完自动发回；同一问题的追问送进同一个会话，
// 它记得上一轮读过什么。家里一个 Agent 对应这里一个 CodeAgent 会话，不同问题之间上下文互不干扰。
// 起初只读 AirView / L2 代码；2026-10-15 用户要求放开成通用：查代码、查本机文件与文档、跑查询命令都行。
//
// 不改动公司电脑靠说明约束：公司真机的 CodeAgent 不认 --disallowedTools / --strict-mcp-config（2026-10-15 实测），
// 用户拍板只靠说明、公司电脑上已注册的 MCP 允许使用；会话以 purpose=company-bridge 启动，只是不挂 Hub 自己的 MCP。
// 模型用 CodeAgent 自己的默认，不走 /model 菜单：公司真机上它把第一条消息卡住约 1 分钟（2026-10-15 用户反馈）。
// 2026-10-18 起家里可以指定模型（GLM / DeepSeek 分流）：仍不走菜单、也不传不生效的 --model，而是挑有该模型权限的号、
// 用号配置目录 settings.json 的 model 定模型（core/codeagent-model-route.js）。
// 发回前查源码：围栏代码块、无围栏的代码行、压成一行的代码都算；超过限度先请它改写，改完仍超就删掉那几段再发。
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { AssistantStore } = require('../hub-assistant/store');
const { claimTimers, ownsTimers } = require('../hub-assistant/timer-owner');
const { BridgeLink } = require('./link');
const { receiptPromptFingerprint, transcriptHasRequest } = require('./receipt-reader');
// 2026-10-16：通道会话按追问规律和内存余量收放（session-care.js，设计见该文件开头）。
const care = require('./session-care');
// 反方向（这台电脑上的 CodeAgent 用 ask_home 向家里求助）由 ask-home.js 处理，共用这条通道和数据库。
const { AskHome } = require('./ask-home');
// 2026-10-15：设置菜单的隐藏入口（unlock.js）与放行页自动点击（gate-pass.js）。
const { matchesUnlock } = require('./unlock');
const { GatePasser } = require('./gate-pass');
// 2026-10-17：家里远程让这台 Hub 更新 / 重启（hub-admin.js），共用这条通道和数据库。
const { HubAdmin } = require('./hub-admin');
// 2026-10-18：家里按模型派活（GLM / DeepSeek 分流）。这里汇总各号的模型发给家里（模型表），家里指定模型时挑有它权限的号。
const route = require('../codeagent-model-route');
// 2026-10-18 额度感知：识别 CodeAgent 后台的额度 / 限流报错，把号标「避让中」，挑号时跳过；撞额度的轮次换号新开会话重做一次。
const Q = require('../codeagent-quota');
const { QuotaWatch } = require('./quota-watch');
// 2026-10-19 兜底：在途轮次的会话停在选择菜单上（CodeAgent 弹了选择题等人选）→ 这一轮报「卡在选择题」，带回题目和选项；
// 只读屏幕、不发按键、不替它选。对端追问给出选择或重试时，新开会话接着做（旧会话停在菜单上，不再往里发）。
const choiceMenu = require('../choice-menu-screen');
// 菜单要连续出现这么久才判定（一闪而过的不算）；同一会话两次读屏至少隔这么久。
const CHOICE_STABLE_MS = 20000;
const CHOICE_CHECK_MS = 8000;
// 工具权限确认（不是提问）先只报「等待权限确认」，停满这么久才按卡住处理（审核 2026-10-19）。通道会话按 bypass 权限启动，正常不该出现。
const PERMISSION_STABLE_MS = 5 * 60000;
// 一轮因额度中断后最多换号重做几次（只重做一次，不循环）。
const MAX_REHOME = 1;
// 撞额度后旧会话还在忙（多半在自己重试）时，最多等多久再换号（审核 2026-10-18）。
const REHOME_GRACE_MS = 60000;
// 换号重做时带给新会话的上下文：上一会话的进展、此前各轮回答，各自的上限。
const REHOME_PROGRESS_CHARS = 1500;
const REHOME_CONTEXT_CHARS = 12000;
// 模型表「明显变化」时推给家里，最快 10 分钟一次；启动后（或换了配对）先推一次，每份回执也带一份最新的。
// 号的避让状态变了另算：最快 30 秒推一次（家里据此选号，不能等 10 分钟）。
const MODELS_PUSH_MIN_MS = 10 * 60000;
const AVOID_PUSH_MIN_MS = 30000;
// 指定模型的轮次最多等多久「能跑它的号池号空出来切模型」（2026-10-18 审核：号一直有会话时不能无限排队）。
const MODEL_SWITCH_WAIT_MS = 10 * 60000;
// 发回家里前要去掉号身份的消息类型，和工号掩码的样子（codeagent-pool.js maskAccountId：头 4 位 + **** + 尾 2 位，或 1 位 + ***）。
const SCRUB_TYPES = new Set(['status', 'reply', 'hub-admin-status']);
const MASKED_ID = /[A-Za-z0-9]{1,4}\*{3,4}[A-Za-z0-9]{0,2}/g;

const PURPOSE = 'company-bridge';
const pairingPlate = require('./pairing-plate');
// 特战会话名（2026-10-18：「在公司侧 session 名字里直接看出对应家里哪个」）。2026-10-20 起用配对号牌
// 「Q21 · 家「会话名前 10 字 #短码」· 模型」（pairing-plate.js）；老版本家里没带短码，退回「1018-Q1-codex」；
// 换号重做的新会话加「· 重做 N」，不再出现两个同名会话。编号不是 Q-MMDD-NN（极少见）时退回「特战 · 问题标题」。
// 会话名只用于显示：补收、换号、恢复都按会话编号（t.sessionId / prevSessions）找会话，不按名字。
function tezhanSessionTitle(t) {
  return pairingPlate.companySessionTitle(t);
}
// 历代默认说明：没改过的老设置里存的就是它们，读设置时换成当前默认。
const V1_INSTRUCTIONS = [
  '你是公司电脑上的代码阅读助手，替家里的 Agent 回答关于公司代码的问题。请遵守：',
  '1. 只读代码：可以打开、搜索、阅读文件；不运行程序或测试，不修改、新建、删除任何文件，不提交。',
  '2. 不回传源码：用文字和简短伪代码讲清逻辑，不成段粘贴源码。可以写函数名、文件相对路径和行号，方便对方追问。',
  '3. 先写结论，再逐条说明；分清「读到了」和「推测」。',
  '4. 末尾写「把握程度」（高 / 中 / 低及原因）和「没读到的部分」。',
  '5. 篇幅控制在 2 万字以内。',
].join('\n');
const V2_INSTRUCTIONS = [
  '你是公司电脑上的助手，替家里的 Agent 办事：读公司代码（如 AirView、L2 的实际实现），查这台电脑上的文件、文档和环境，运行查询类命令收集信息。请遵守：',
  '1. 保持公司电脑原样：可以打开、搜索、阅读文件，运行查询类命令（如 git log、dir、findstr）；修改、新建、删除文件，提交代码，安装软件，这些都不做。',
  '2. 不回传源码：用文字和简短伪代码讲清逻辑，不成段粘贴源码。可以写函数名、文件相对路径和行号，方便对方追问。',
  '3. 账号、密码、密钥、令牌这类凭据不写进回答。',
  '4. 先写结论，再逐条说明；分清「读到了」和「推测」。',
  '5. 末尾写「把握程度」（高 / 中 / 低及原因）和「没读到的部分」。',
  '6. 篇幅控制在 2 万字以内。',
].join('\n');
const V3_INSTRUCTIONS = [
  '你是公司电脑上的助手，替家里的 Agent 办事：读公司代码（如 AirView、L2 的实际实现），查这台电脑上的文件、文档和环境，运行查询类命令，也可以用这台电脑上已注册的 MCP 工具（如 AirView、内网搜索）收集信息。请遵守：',
  '1. 保持公司电脑原样：可以打开、搜索、阅读文件，运行查询类命令（如 git log、dir、findstr）；修改、新建、删除文件，提交代码，安装软件，这些都不做。',
  '2. 有副作用的动作（提交或运行仿真、同步工程、发消息、改动共享平台上的内容），只在家里的问题里明确要求时才做，并在回答里写清做了什么。',
  '3. 只回答问题需要的内容：不回传源码，用文字和简短伪代码讲清逻辑，可以写函数名、文件相对路径和行号；账号、密码、密钥、令牌这类凭据和与问题无关的个人信息不写进回答。',
  '4. 先写结论，再逐条说明；分清「读到了」和「推测」。',
  '5. 末尾写「把握程度」（高 / 中 / 低及原因）和「没读到的部分」。',
  '6. 篇幅控制在 2 万字以内。',
].join('\n');
// 只迁移未改过的默认说明；成员自己写的说明原样保留。
const DEFAULT_INSTRUCTIONS = V3_INSTRUCTIONS.replace('替家里的 Agent 办事', '为已配对的授权 Agent 处理任务').replace('家里的问题里', '任务中');
const OLD_DEFAULTS = [V1_INSTRUCTIONS, V2_INSTRUCTIONS, V3_INSTRUCTIONS];
// maxParallel 是工作日忙时的上限；闲时（晚上、周末）放宽到 maxParallelIdle，并按可用账号和内存再收（session-care.js parallelCap）。
// usePool：通道新开的会话走号池（自动挑进行中会话最少的号），号池没有可用的号时用个人账号。
// 2026-10-17 用户：工作日忙时 3 个、每号忙时 3 / 闲时 6 个、内存保底 10%，都可在设置里调（parallelRev 2 起）。
const DEFAULT_SETTINGS = Object.freeze({ enabled: true, codeRoots: [], instructions: DEFAULT_INSTRUCTIONS, effort: 'high', maxParallel: 3, maxParallelIdle: 6,
  perAccountPeak: 3, perAccountIdle: 6, memFloorPct: 10, busyHours: care.DEFAULT_BUSY_HOURS, usePool: true, pollSeconds: 30, autoGate: false, parallelRev: 2,
  // 允许家里远程更新 / 重启这台 Hub（2026-10-17 用户：默认开）。
  // restartGraceMinutes：远程重启前最多等手上的任务几分钟，到时先记下、中断，重启后自动接着做（2.1.9；0 = 立即，hub-admin.js）。
  // 2026-10-21 起默认 20 分钟（同事公司 Hub 重启丢在途轮次）；graceRev 1 起存下的值按用户自己选的算，之前存下的旧默认 3 换成新默认。
  allowRemoteAdmin: true, restartGraceMinutes: 20, graceRev: 1,
  // 允许对端直查这台电脑的状态（2026-10-18，只读，hub-admin.js diag；独立于远程更新开关，默认开）。
  allowRemoteDiag: true,
  // 直查 airview 段看这些目录下最近更新的结果文件（只看名字、大小、修改时间），连同代码位置一起（diag.js resultFiles）。
  resultDirs: ['C:/AirView'],
  // 允许对端读取这台电脑上的文本文件（2026-10-20 用户：把 AirView 的文本拿回家里做 wireless-sim 的设计，见 file-query.js）。
  // 只读、永不写；能读的目录 = resultDirs + codeRoots + readRoots；默认开（用户本人要求、公司端界面可随时关）。
  allowRemoteFiles: true,
  // 除仿真结果目录和代码位置之外，另外允许读取的目录（合同、纪要这类文档放这里），最多 10 个。
  readRoots: [],
  // 允许对端远程维护（2026-10-18 三期，remote-act.js：休眠空闲通道会话、结束残留进程、临时调并行档位、取消排队 / 重试问题），默认开。
  allowRemoteMaintain: true,
  // 额度感知（2026-10-18）：识别额度 / 限流报错并避让（quotaGuard）；Stats 面板 Credit 不高于 creditFloor 也避让；
  // 报错里读不出重置时间时，quotaRetryMinutes 分钟后再试（Credit 恢复为正时提前解除）。
  quotaGuard: true, creditFloor: 0, quotaRetryMinutes: 60,
  // 在途轮次按屏幕识别「卡在选择题」（2026-10-19，core/choice-menu-screen.js；识别规则可在数据目录的 choice-menu-rules.json 里改）
  choiceDetect: true });
const ACTIVE_POLL_MS = 10000;
const FOLLOWUP_WINDOW_MS = 10 * 60000;
const EFFORTS = ['low', 'medium', 'high', 'max'];
const MAX_REPLY_CHARS = 40000;
// 源码检查的限度：成段（连续）超过 12 行，或全篇累计超过 30 行像代码的内容。
const MAX_CODE_RUN = 12;
const MAX_CODE_TOTAL = 30;
// 发出后会话停下、却一直没读到回答：判定没答上，告诉家里。
const NO_ANSWER_MS = 10 * 60000;
// 记录还在写时最多等多久（长仿真、全量编译）；过了照旧按「没答上」处理，避免永远挂着。
const LONG_RUN_MS = 3 * 60 * 60000;
// 发出后多久核实「提问真的写进了 CodeAgent 的记录」；刚发出这段时间里 hook 可能还没到，也按「在干活」占名额。
const VERIFY_MS = 3 * 60000;
const STARTUP_GRACE_MS = 3 * 60000;
// 家里报「发问方还在活动」的有效期。
const ASKER_TTL_MS = 15 * 60000;
const CARE_EVERY_MS = 60000;
// 收回答前核对：CodeAgent 收到的那条消息里得有本题编号。剪贴板里的图片会顶掉粘贴进去的问题（2026-10-15 公司真机），
// 这时它答的是图片，不能发回家；自动重发，连着被顶掉 2 次就报错让人清空剪贴板后重试。
const MAX_HIJACK = 2;
// CLI 还没就绪时（发送入口报 cli-not-ready，明确没发）重试的间隔和最长等待；重启后恢复发「继续」同样适用（hub-admin.js）。
const NOT_READY_RETRY_MS = 15000;
const NOT_READY_MAX_MS = 5 * 60000;
// 按问题文本在原生记录里找回答（receipt-reader.js findRoundAnswer，2026-10-21 同事公司 Hub）：同一轮最快多久查一次（读整份记录）；
// 找到的回答已收尾后，记录文件要静这么久才发（Stop 之后 CLI 可能还在补写几行）；重启后重新打开的会话，记录这么久内还在写就再等等。
const FIND_EVERY_MS = 30000;
const FOUND_QUIET_MS = 20000;
const RESTART_WRITING_MS = 2 * 60000;
// 一轮回答由多段文字拼成（工具调用前后各写了一些，2026-10-21）：总长超过上限时从前面截（结论在最后），并注明截掉多少；
// 只有一段、或最后一段本身就超限时原样交给 sendReply，沿用从后面截的老办法。
function fitReply(parts, max = MAX_REPLY_CHARS) {
  const list = (parts || []).map(p => String(p && p.text || '').trim()).filter(Boolean);
  const text = list.join('\n\n');
  if (text.length <= max || list.length < 2 || list[list.length - 1].length >= max - 400) return text;
  let kept = text.slice(text.length - (max - 400));
  const nl = kept.indexOf('\n');
  if (nl >= 0 && nl < 2000) kept = kept.slice(nl + 1);
  return `（这一轮的回答共 ${text.length} 字，超过 ${max} 字上限：前面 ${text.length - kept.length} 字的过程文字截掉了，保留后面的结论；需要的话请追问前半部分。）\n\n` + kept;
}
// 从 CodeAgent 的原生记录（Claude 格式 jsonl）里取用户发出的消息：时间、文字、图片张数（工具结果不算）。
function userTurnsFromTranscript(file) {
  let raw = '';
  try { raw = require('node:fs').readFileSync(file, 'utf8'); } catch { return []; }
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"user"')) continue;
    let o = null; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'user' || !o.message) continue;
    const c = o.message.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    if (!blocks.length || blocks.every(b => b && b.type === 'tool_result')) continue;
    turns.push({ at: Date.parse(o.timestamp) || 0, text: blocks.filter(b => b && b.type === 'text').map(b => String(b.text || '')).join('\n'),
      images: blocks.filter(b => b && b.type === 'image').length });
  }
  return turns;
}
const short = (s, n = 28) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// ---- 源码检查 ----
const CODE_LINE = /;\s*$|^\s*[{}]\s*;?\s*$|^\s*#\s*(?:include|define|ifn?def|if|endif|pragma)\b|^\s*(?:return|typedef|struct|static|const|void|int|unsigned|float|double|char|bool|uint\d+_t|int\d+_t|def|class|import|from)\b.*[;{(:]\s*$|^\s*(?:if|for|while|switch)\s*\(.*\)\s*\{?\s*$|^\s*}\s*else\b/;
// 每行的「代码行数」：围栏里的非空行算 1；围栏外像代码的行算 1；压成一长行的按分号数算。
function codeWeights(text) {
  const lines = String(text || '').split('\n');
  const weights = new Array(lines.length).fill(0);
  let fence = null;
  lines.forEach((line, i) => {
    const marker = line.match(/^\s*(```|~~~)/);
    if (marker) { fence = fence ? (fence === marker[1] ? null : fence) : marker[1]; return; }
    if (!line.trim()) return;
    if (fence) { weights[i] = 1; return; }
    const semis = (line.match(/;/g) || []).length;
    if (semis >= 4 && line.length > 120) weights[i] = semis;
    else if (!/^\s*\|/.test(line) && CODE_LINE.test(line.replace(/`[^`]*`/g, s => s.length > 60 ? s.slice(1, -1) : 'x'))) weights[i] = 1;
  });
  return { lines, weights };
}
// 连续的代码行（中间夹空行、围栏行也算连着）。
function codeRuns(text) {
  const { lines, weights } = codeWeights(text);
  const runs = [];
  let cur = null;
  lines.forEach((line, i) => {
    const glue = !line.trim() || /^\s*(```|~~~)/.test(line);
    if (weights[i]) { if (!cur) cur = { start: i, end: i, lines: 0 }; cur.end = i; cur.lines += weights[i]; }
    else if (!glue && cur) { runs.push(cur); cur = null; }
  });
  if (cur) runs.push(cur);
  return { lines, runs, total: runs.reduce((a, r) => a + r.lines, 0) };
}
function sourceVerdict(text) {
  const { runs, total } = codeRuns(text);
  const maxRun = runs.reduce((a, r) => Math.max(a, r.lines), 0);
  return { total, maxRun, tooMuch: maxRun > MAX_CODE_RUN || total > MAX_CODE_TOTAL };
}
// 兜底：把超过 3 行的代码段换成一句说明（含围栏行）。
function stripCode(text, minLines = 3) {
  const { lines, runs } = codeRuns(text);
  let removed = 0;
  const out = [...lines];
  for (const r of [...runs].reverse()) {
    if (r.lines <= minLines) continue;
    let start = r.start, end = r.end;
    if (start > 0 && /^\s*(```|~~~)/.test(out[start - 1])) start -= 1;
    if (end + 1 < out.length && /^\s*(```|~~~)/.test(out[end + 1])) end += 1;
    out.splice(start, end - start + 1, `（此处原有约 ${r.lines} 行代码，按规则不回传）`);
    removed += r.lines;
  }
  return { text: out.join('\n'), removed };
}

// 早期版本的表没有 open 列：补上并按内容回填（只有开发期的数据目录会遇到）。
function ensureOpenColumn(db, needsWork) {
  const cols = db.prepare('PRAGMA table_info(bridge_threads)').all().map(c => c.name);
  if (cols.includes('open')) return;
  db.exec('ALTER TABLE bridge_threads ADD COLUMN open INTEGER NOT NULL DEFAULT 0');
  for (const row of db.prepare('SELECT id,payload FROM bridge_threads').all()) {
    let t = null; try { t = JSON.parse(row.payload); } catch {}
    if (t) db.prepare('UPDATE bridge_threads SET open=? WHERE id=?').run(needsWork(t) ? 1 : 0, row.id);
  }
}

// ---- 线程状态：由各轮推导 ----
// 轮次的阶段：queued（等派发）、running（已发进会话等回答）、replied、failed。
function roundPhase(r) { return r.reply ? 'replied' : r.error ? 'failed' : r.sentAt ? 'running' : 'queued'; }
// 在途轮次从什么时候算起：发出时间；远程重启后恢复会话、发了「继续」的，从恢复时间算（hub-admin.js）。
function activeSince(r) { return Math.max(r.sentAt || 0, r.resumedAt || 0); }
// 派发途中重读线程后：这一轮是不是还在排队（没被取消、没落 error）。
function stillQueued(t, r) { const cur = t.rounds.find(x => x.round === r.round); return !!cur && roundPhase(cur) === 'queued'; }
function deriveState(t) {
  if (t.state === 'cancelled') return 'cancelled';
  const phases = t.rounds.map(roundPhase);
  if (phases.includes('running')) return 'running';
  if (phases.includes('queued')) return 'queued';
  return phases[phases.length - 1] === 'failed' ? 'failed' : 'replied';
}

class CompanyBridge {
  constructor(deps) {
    this.deps = deps;
    this.store = new AssistantStore(path.join(deps.dataDir, 'company-bridge'));
    this.store.db.exec('CREATE TABLE IF NOT EXISTS bridge_threads(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,open INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL)');
    ensureOpenColumn(this.store.db, t => ['queued', 'running'].includes(deriveState(t)));
    this.link = new BridgeLink({ side: 'company', store: this.store, fetchImpl: deps.fetchImpl, now: () => this.now() });
    // 发回家里的文字统一去掉号的身份（2026-10-18 审核：开会话失败的报错带着「号池账号 w001****11（同事备注）」原样回了家里）。
    // 报错、进度说明里的工号掩码、号主备注、号池编号都换掉。
    const rawPrepare = this.link.prepare.bind(this.link);
    // 配对信息（2026-10-20）：给家里的进度和回执带上公司会话名、作答的号（代称）和模型，家里据此显示「→ 公司 号 1 · GLM-5 · 会话 Q21 · 家「…」」。
    // 老版本家里不认这个字段，照收不误。
    this.link.prepare = (type, payload = {}, ...rest) => rawPrepare(type, SCRUB_TYPES.has(type) ? this.scrubPayload(this.withPairing(type, payload)) : payload, ...rest);
    this.busy = null; this.advanceBusy = null; this.deliverBusy = null; this.timer = null; this.nextPullAt = 0; this.lastPullAt = 0;
    // 本进程启动的时刻：上一个进程记下的「CLI 没就绪从何时起」「等切模型从何时起」在新进程里从头算（审核 2026-10-18）。
    this.bootAt = this.now();
    this.askHome = new AskHome({ bridge: this, deps });
    this.images = new (require('./images').BridgeImages)(this);
    this.hubAdmin = new HubAdmin({ bridge: this, deps });
    this.quota = new QuotaWatch(this);
    // 每个会话占多少内存：并行上限和收会话共用这一个估计（session-care.js createSessionMemEstimator；main 接了 measureSessionMem 才实测）。
    this.sessionMem = care.createSessionMemEstimator({ measure: deps.measureSessionMem || null, now: () => this.now() });
    this.gatePass = new GatePasser({ open: url => deps.openHiddenGate(url), logDir: path.join(deps.dataDir, 'logs'), now: () => this.now(),
      notify: (title, text) => this.notify(title, text) });
    // 升级前就配对过的电脑（入口还没隐藏时用过）直接算已解锁，不让成员升级后找不到入口。
    if (!this.store.get('featureUnlock') && (this.link.config().state || 'none') !== 'none') this.store.set('featureUnlock', { at: this.now(), via: 'paired' });
    if (!deps.noTimer) claimTimers(this.store);
  }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  // 本机各号的身份字样（工号掩码、备注、号池编号、显示名），由 main 从号池登记和个人账号凭证里取；读不到就只按掩码样式换。
  // 每次现读（号刚加进号池、备注刚改，下一条消息就要换掉）；读号池要同步读盘，批量脱敏的调用方先取一份快照再传给 scrubText
  // （2026-10-18 审核：直查脱敏上千个字符串时每次都读盘，会卡住主进程）。
  accountSecrets() {
    if (this.secretsSnapshot) return this.secretsSnapshot; // 直查采集与量大小期间用同一份（几秒内）
    let list = [];
    try { list = (this.deps.accountSecrets?.() || []).map(String).filter(s => s.trim().length >= 2); } catch { list = []; }
    return [...new Set(list)].sort((a, b) => b.length - a.length);
  }
  // secrets：调用方批量脱敏时传入同一份快照（hub-admin.js diag）。
  scrubText(text, secrets = this.accountSecrets()) {
    let s = String(text);
    for (const secret of secrets) {
      const isNote = !/\*|^[a-z0-9]{6,16}$/.test(secret);
      s = s.split(secret).join(isNote ? '（号主备注）' : '号池里的一个号');
    }
    return s.replace(MASKED_ID, '号池里的一个号').replace(/号池账号\s*号池里的一个号/g, '号池里的一个号');
  }
  scrubPayload(payload) {
    const out = { ...payload };
    // 回答正文是 CodeAgent 写的，里面不会有 Hub 自己的号身份，不动（免得改坏正文）。
    for (const key of ['note', 'error']) if (typeof out[key] === 'string') out[key] = this.scrubText(out[key]);
    // 远程更新的上次结果（hub-admin.js announce）里的失败原因同样过一遍。
    if (out.lastResult && typeof out.lastResult === 'object' && typeof out.lastResult.reason === 'string') out.lastResult = { ...out.lastResult, reason: this.scrubText(out.lastResult.reason) };
    if (out.meta && typeof out.meta === 'object') { const { poolLabel: _p, account: _a, ...meta } = out.meta; out.meta = meta; }
    // 公司会话名可能被人手改过，同样过一遍（号的代称本来就是脱敏后的写法）。
    if (out.pairing && typeof out.pairing === 'object' && typeof out.pairing.sessionTitle === 'string') out.pairing = { ...out.pairing, sessionTitle: this.scrubText(out.pairing.sessionTitle) };
    return out;
  }
  withPairing(type, payload) {
    if ((type !== 'status' && type !== 'reply') || !payload || !payload.thread || payload.pairing) return payload;
    let pairing = null;
    try { const t = this.thread(String(payload.thread)); pairing = t && this.pairingOf(t, payload.meta); } catch { pairing = null; }
    return pairing ? { ...payload, pairing } : payload;
  }
  // 这条线程现在由哪个公司会话、哪个号、哪个模型在答；还没开会话（排队中、换号刚把会话清空）时返回 null。
  // aliases：状态页一次列几十条时先取一份代称表（读号池登记要读盘），不每条都读；memoryOnly：只看内存里开着的会话，不读盘。
  pairingOf(t, meta = null, { aliases = null, memoryOnly = false } = {}) {
    if (!t || !t.sessionId) return null;
    const s = this.deps.getSession(t.sessionId) || (memoryOnly ? null : this.deps.getSessionMetadata?.(t.sessionId)) || null;
    const key = s ? (s.codeagentPoolAccount ? String(s.codeagentPoolAccount) : 'personal') : null;
    const alias = key && (aliases ? aliases.get(key) || (key === 'personal' ? '个人' : '号池里的一个号') : this.aliasOf(key));
    const last = [...(t.rounds || [])].reverse().find(r => r.meta) || null;
    const model = meta?.actualModel || meta?.model || last?.meta?.actualModel || last?.meta?.model || s?.codeagentActualModel || s?.currentModel?.displayName || s?.currentModel?.id || '';
    return { sessionTitle: String(s?.title || tezhanSessionTitle(t)), ...(alias ? { accountAlias: alias } : {}), ...(model ? { model: String(model) } : {}) };
  }
  // 隐藏入口：本机解锁过一次就一直显示（存在本机数据目录）。
  unlocked() { return !!this.store.get('featureUnlock'); }
  unlock(text) {
    if (!matchesUnlock(text, this.deps.unlockDigest)) return false;
    if (!this.unlocked()) this.store.set('featureUnlock', { at: this.now(), via: 'keys' });
    this.changed();
    return true;
  }
  settings() {
    const { model: _oldModel, ...s } = this.store.get('settings') || {}; // 旧版存过模型，现在不用
    const instructions = !s.instructions || OLD_DEFAULTS.includes(s.instructions.trim()) ? DEFAULT_INSTRUCTIONS : s.instructions;
    // 旧版设置页只能存「同时 N 个」且默认 2；没调过并行档位的（parallelRev 缺失且仍是旧默认 2）按新默认 3。
    if (!s.parallelRev && Number(s.maxParallel) === 2) delete s.maxParallel;
    // 设置页保存时整份写回，旧版存下的「重启前最多等 3 分钟」多半只是旧默认：没有 graceRev 的按新默认 20。
    if (!s.graceRev && Number(s.restartGraceMinutes) === 3) delete s.restartGraceMinutes;
    return { ...DEFAULT_SETTINGS, ...s, instructions, codeRoots: Array.isArray(s.codeRoots) ? s.codeRoots : [], resultDirs: Array.isArray(s.resultDirs) ? s.resultDirs : DEFAULT_SETTINGS.resultDirs,
      readRoots: Array.isArray(s.readRoots) ? s.readRoots : [], parallelRev: DEFAULT_SETTINGS.parallelRev, graceRev: DEFAULT_SETTINGS.graceRev };
  }
  setSettings(patch = {}) {
    const next = this.settings();
    if ('enabled' in patch) next.enabled = patch.enabled === true;
    if ('codeRoots' in patch) {
      const list = (Array.isArray(patch.codeRoots) ? patch.codeRoots : String(patch.codeRoots || '').split(/\r?\n/)).map(s => String(s).trim()).filter(Boolean);
      if (list.length > 20) throw new Error('代码位置最多 20 个');
      next.codeRoots = list;
    }
    if ('instructions' in patch) { const t = String(patch.instructions || '').trim(); if (t.length > 8000) throw new Error('说明太长（上限 8000 字）'); next.instructions = t || DEFAULT_INSTRUCTIONS; }
    if ('effort' in patch) { if (!EFFORTS.includes(patch.effort)) throw new Error('思考深度只能是 low / medium / high / max'); next.effort = patch.effort; }
    const int = (key, lo, hi, label) => { if (!(key in patch)) return; const n = Number(patch[key]); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${label}只能是 ${lo}–${hi}`); next[key] = n; };
    int('maxParallel', 1, 8, '工作日忙时同时处理的问题数');
    int('maxParallelIdle', 1, 12, '闲时同时处理的问题数');
    int('perAccountPeak', 1, 8, '每个账号忙时同时处理的问题数');
    int('perAccountIdle', 1, 12, '每个账号闲时同时处理的问题数');
    int('memFloorPct', 5, 50, '内存保底百分比');
    int('restartGraceMinutes', 0, 30, '远程重启前最多等待的分钟数');
    if ('busyHours' in patch) { const spec = String(patch.busyHours || '').trim(); if (spec && !care.parseHours(spec).length) throw new Error('忙时格式如 08:30-12:00,13:30-17:30'); next.busyHours = spec || care.DEFAULT_BUSY_HOURS; }
    if ('usePool' in patch) next.usePool = patch.usePool === true;
    if ('pollSeconds' in patch) { const n = Number(patch.pollSeconds); if (!Number.isInteger(n) || n < 10 || n > 600) throw new Error('检查间隔只能是 10–600 秒'); next.pollSeconds = n; }
    if ('autoGate' in patch) next.autoGate = patch.autoGate === true;
    if ('allowRemoteAdmin' in patch) next.allowRemoteAdmin = patch.allowRemoteAdmin === true;
    if ('allowRemoteDiag' in patch) next.allowRemoteDiag = patch.allowRemoteDiag === true;
    if ('allowRemoteMaintain' in patch) next.allowRemoteMaintain = patch.allowRemoteMaintain === true;
    if ('allowRemoteFiles' in patch) next.allowRemoteFiles = patch.allowRemoteFiles === true;
    if ('readRoots' in patch) {
      const list = (Array.isArray(patch.readRoots) ? patch.readRoots : String(patch.readRoots || '').split(/\r?\n/)).map(s => String(s).trim()).filter(Boolean);
      if (list.length > 10) throw new Error('额外可读目录最多 10 个');
      if (list.some(s => s.length > 260)) throw new Error('目录路径太长');
      next.readRoots = list;
    }
    if ('quotaGuard' in patch) next.quotaGuard = patch.quotaGuard === true;
    if ('choiceDetect' in patch) next.choiceDetect = patch.choiceDetect === true;
    if ('creditFloor' in patch) { const n = Number(patch.creditFloor); if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('额度阈值只能是 0–100000'); next.creditFloor = n; }
    int('quotaRetryMinutes', 5, 720, '撞到额度后多久再试（分钟）');
    if ('resultDirs' in patch) {
      const list = (Array.isArray(patch.resultDirs) ? patch.resultDirs : String(patch.resultDirs || '').split(/\r?\n/)).map(s => String(s).trim()).filter(Boolean);
      if (list.length > 10) throw new Error('仿真结果目录最多 10 个');
      if (list.some(s => s.length > 260)) throw new Error('目录路径太长');
      next.resultDirs = list;
    }
    this.store.set('settings', next);
    this.tightenPoll(); this.changed();
    return next;
  }

  // 任务进行中和答完后的追问窗口加快检查；空闲沿用成员原来的设置。
  // 窗口随配对代次持久化，程序重开可接上，换配对不会继承旧窗口。
  polling() {
    const c = this.link.config();
    if (!c.state || c.state === 'none') return { intervalSeconds: 0, active: false, activeUntil: null };
    if (c.state !== 'paired') return { intervalSeconds: ACTIVE_POLL_MS / 1000, active: false, activeUntil: null };
    const recent = this.store.get('pollActivity');
    const activeUntil = recent?.gen === c.gen ? recent.until : null;
    const active = activeUntil > this.now() || this.openThreads().some(t => t.gen === c.gen) || this.askHome.openThreads().length > 0 || this.link.pendingOutbox() > 0;
    return { intervalSeconds: active ? ACTIVE_POLL_MS / 1000 : this.settings().pollSeconds, active, activeUntil: activeUntil > this.now() ? activeUntil : null };
  }
  tightenPoll() {
    const ms = this.polling().intervalSeconds * 1000;
    if (ms) this.nextPullAt = Math.min(this.nextPullAt, (this.lastPullAt || this.now()) + ms);
  }

  threads(limit = 60) { return this.store.db.prepare('SELECT payload FROM bridge_threads ORDER BY updated DESC LIMIT ?').all(limit).map(r => JSON.parse(r.payload)); }
  openThreads() { return this.store.db.prepare('SELECT payload FROM bridge_threads WHERE open=1 ORDER BY updated').all().map(r => JSON.parse(r.payload)); }
  thread(id) { const r = this.store.db.prepare('SELECT payload FROM bridge_threads WHERE id=?').get(id); return r ? JSON.parse(r.payload) : null; }
  saveThread(t) {
    t.updatedAt = this.now(); t.state = deriveState(t);
    this.store.db.prepare('INSERT INTO bridge_threads(id,payload,state,open,updated) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state,open=excluded.open,updated=excluded.updated')
      .run(t.id, JSON.stringify(t), t.state, ['queued', 'running'].includes(t.state) ? 1 : 0, t.updatedAt);
    if (t.state !== 'cancelled' && t.gen && t.gen === this.link.gen()) {
      this.store.set('pollActivity', { gen: t.gen, until: this.now() + FOLLOWUP_WINDOW_MS });
      this.tightenPoll();
    }
    return t;
  }
  patchRound(t, round, patch) { return this.saveThread({ ...t, rounds: t.rounds.map(x => x.round === round ? { ...x, ...patch } : x) }); }

  sessionPlan(request) { return this.askHome.sessionPlan(request); }
  start() {
    if (!this.askHome.server) void this.askHome.start().catch(e => console.warn('[company-bridge] ask-home', e.message));
    if (this.deps.noTimer || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(e => console.warn('[company-bridge] tick', e.message)); }, 5000);
    this.timer.unref?.();
  }
  async tick({ force = false } = {}) {
    if (!force && !this.deps.noTimer && !ownsTimers(this.store)) return;
    // 收件和会话推进分别去重：开会话或发送问题可能等很久，期间仍能收下一条任务。
    if (!this.busy) this.busy = (async () => {
      const state = this.link.config().state;
      if (!state || state === 'none') return;
      if (this.link.pairingExpired()) { this.link.unpair(); this.notify('配对已过期', '24 小时内对端没有确认，请重新获取配对码。'); this.changed(); return; }
      this.tightenPoll();
      if (force || this.now() >= this.nextPullAt) {
        this.lastPullAt = this.now();
        this.nextPullAt = this.lastPullAt + this.polling().intervalSeconds * 1000;
        try { await this.link.pull(message => this.receive(message)); } catch {}
        await this.passGate();
        // 上次远程更新 / 重启的结果、版本变化，通道接通后报回家里。
        try { await this.hubAdmin.announce(); } catch (e) { console.warn('[company-bridge] hub-admin announce', e.message); }
        // 公司当前可用的模型与忙闲（模型表），家里据此决定用哪个模型。
        try { await this.pushModels(); } catch (e) { console.warn('[company-bridge] models', e.message); }
        this.changed();
      }
    })().finally(() => { this.busy = null; });
    await this.busy;
    // 额度感知：被动读各 CodeAgent 会话的原生记录与屏幕，识别额度报错、读 Credit（和配对无关，号池页签也用这份状态）。
    try { await this.quota.scan({ force }); } catch (e) { console.warn('[company-bridge] quota', e.message); }
    if (this.settings().enabled && this.link.paired()) {
      if (!this.advanceBusy) this.advanceBusy = this.advance().finally(() => { this.advanceBusy = null; });
      await this.advanceBusy;
    }
    // 远程更新 / 重启：等到安全时机就重启、重启没成的看门狗、配对变了作废（hub-admin.js）。不看配对：解除配对时等待中的指令要作废。
    try { await this.hubAdmin.advance(); } catch (e) { console.warn('[company-bridge] hub-admin', e.message); }
    // 重启前被中断的会话：恢复并发一句「继续」（和配对无关，本机会话也在里面）。
    try { await this.hubAdmin.resumeInterrupted(); } catch (e) { console.warn('[company-bridge] hub-admin resume', e.message); }
    // 家里对 ask_home 的回复：和「自动作答」开关无关，配对了就送。
    if (this.link.paired()) {
      if (!this.deliverBusy) this.deliverBusy = this.askHome.deliver().finally(() => { this.deliverBusy = null; });
      await this.deliverBusy;
      await this.images.tick();
    }
  }
  // 通道被放行页拦着、且开了自动放行：在看不见的窗口里点一次放行，点到了立即重试连接。
  async passGate() {
    const gate = this.link.status().gate;
    if (!gate) { if (this.gatePass.passed()) this.notify('已自动放行', '公司网络的放行页已自动点过，通道恢复。'); return; }
    if (!this.settings().autoGate || !this.deps.openHiddenGate) return;
    if (!(await this.gatePass.attempt(gate.url || this.link.client().gatePage()))) return;
    try { await this.link.pull(message => this.receive(message)); } catch {}
    if (!this.link.status().gate && this.gatePass.passed()) this.notify('已自动放行', '公司网络的放行页已自动点过，通道恢复。');
  }
  checkNow() { this.nextPullAt = 0; return this.tick({ force: true }).then(() => this.status()); }

  async pair(code) {
    this.cancelOpen('重新配对');
    await this.link.acceptPairing(code, { app: 'company-hub' });
    this.nextPullAt = 0;
    this.changed();
    return this.status();
  }
  unpair() { this.cancelOpen('已解除配对'); this.link.unpair(); this.changed(); return this.status(); }
  // 解除或重新配对：没答完的问题作废，答完的也不会再发给新的对端（发送前核对代次）。
  cancelOpen(why) { this.askHome.cancelOpen(why); for (const t of this.openThreads()) this.saveThread({ ...t, state: 'cancelled', cancelNote: why }); }

  receive(message) {
    if (['image-capabilities', 'image', 'image-ack'].includes(message.type)) return this.images.receive(message);
    if (message.type === 'welcome') {
      if (this.link.completeAsCompany(message)) this.notify('配对已完成', 'AI特战队专用功能已接通。');
      return;
    }
    if (this.askHome.receive(message)) return;
    if (this.hubAdmin.receive(message)) return;
    // 家里报：这些问题的发问会话还在活动（追问可能性大，答完的会话保温加倍）。
    if (message.type === 'asker') {
      if (message.gen && message.gen !== this.link.gen()) return;
      const threads = (Array.isArray(message.threads) ? message.threads : []).map(String).filter(id => /^[A-Za-z0-9-]{3,40}$/.test(id)).slice(0, 200);
      this.store.set('askerActive', { at: this.now(), threads });
      return;
    }
    if (message.type === 'recollect') { void this.recollect(message).catch(e => console.warn('[company-bridge] recollect', e.message)); return; }
    if (message.type !== 'ask' && message.type !== 'followup') return;
    const id = String(message.thread || '').slice(0, 40);
    if (!/^[A-Za-z0-9-]{3,40}$/.test(id)) return;
    const gen = this.link.gen();
    if (message.gen && message.gen !== gen) return; // 上一次配对的消息
    const question = String(message.question || '').slice(0, 60000);
    const round = Number(message.round) || 1;
    let existing = this.thread(id);
    // 家里换了数据目录、编号从头再来，或是上一次配对留下的同编号：不是重复投递，旧记录改名留档。
    if (existing && message.type === 'ask' && ((existing.rounds[0] && existing.rounds[0].mid && existing.rounds[0].mid !== message.mid) || existing.gen !== gen)) {
      this.store.db.prepare('DELETE FROM bridge_threads WHERE id=?').run(id);
      this.saveThread({ ...existing, id: id + '#' + existing.createdAt, state: existing.state === 'cancelled' ? 'cancelled' : existing.state });
      existing = null;
    }
    if (existing && (existing.state === 'cancelled' || existing.gen !== gen)) return;
    if (existing && existing.rounds.some(r => r.round === round)) return; // 重复投递
    if (!existing && message.type === 'followup') return; // 不认识的追问（多半属于已清理的旧问题）
    // 家里指定的模型（新版家里才带；只在开题时定，追问沿用原会话原模型）。
    const model = message.type === 'ask' && typeof message.model === 'string' ? message.model.trim().slice(0, 96) : '';
    // 家里指定的号（代称：个人 / 号 1…，2026-10-18 额度感知）：开题时定整题，追问时只管这一轮（换号就新开会话、带上前几轮作上下文）。
    const account = typeof message.account === 'string' ? Q.normalizeAlias(message.account) : '';
    const t = existing || { id, gen, title: short(message.title || question, 40), from: message.from || null, sessionId: null, createdAt: this.now(), rounds: [],
      ...(model ? { model } : {}) };
    t.rounds = [...t.rounds, { round, question, receivedAt: this.now(), mid: message.mid, ...(account ? { account } : {}),
      ...(typeof message.account === 'string' && message.account.trim() && !account ? { badAccount: message.account.trim().slice(0, 20) } : {}) }];
    this.saveThread(t);
    void this.link.send('status', { thread: id, gen, round, state: 'received', note: '公司已收到' }).catch(() => {});
    this.notify(existing ? '收到追问' : '收到任务', `${id}：${short(question, 60)}`, t.sessionId);
  }

  sessionBusy(id) {
    const s = id && this.deps.getSession(id);
    if (!s) return false;
    return !!this.deps.isAgentTurnActive?.(id) || require('../session-runtime-truth').sessionRuntimeIsActive(s) || s.status === 'running' || !!this.deps.hasPendingPrompt?.(id);
  }
  // 原生记录最近 NO_ANSWER_MS 内有写入：CodeAgent 还在干活。拿不到路径或读不到时间按「不新鲜」处理（沿用原判定）。
  transcriptFresh(sessionId) {
    const meta = this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId);
    const file = meta && meta.transcriptPath;
    if (!file) return false;
    let ms = null;
    try { ms = this.deps.transcriptMtime ? this.deps.transcriptMtime(file) : require('node:fs').statSync(file).mtimeMs; } catch { return false; }
    return Number.isFinite(ms) && this.now() - ms < NO_ANSWER_MS;
  }
  lastFinal(sessionId) {
    const meta = this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId);
    if (!meta) return null;
    const records = this.deps.readFinals ? this.deps.readFinals(meta) : [];
    return records && records.length ? records[records.length - 1] : null;
  }

  // 推进：在途的轮次看有没有答完；排队的轮次按并发上限开会话或续问。同一问题一次只有一轮在途。
  async advance() {
    const s = this.settings(), gen = this.link.gen();
    for (const listed of this.openThreads()) {
      // 每个都重读：前一个 collect 等待期间，这一个可能已被取消 / 解除配对（2026-10-18 审核：拿旧对象写回会把取消覆盖掉）
      const t = this.thread(listed.id);
      if (!t || !['queued', 'running'].includes(t.state)) continue;
      if (t.gen !== gen) { this.saveThread({ ...t, state: 'cancelled', cancelNote: '属于上一次配对' }); continue; }
      if (t.state === 'running') await this.collect(t);
    }
    // 名额只算真在干活的（2026-10-16）：会话在忙，或刚发出、hook 还没到。回答已写完只等核对、停在两轮之间的不占——
    // 以前它们照样占着，新问题排了一个半小时（Q-1016-06/07/08）。
    const working = this.openThreads().filter(x => x.state === 'running' && this.roundWorking(x)).length;
    const limit = this.parallelLimit(working);
    let free = limit.cap - working;
    // 已有会话的线索（追问、改写）先派：不用新开会话、不多占内存；同类按到达先后。
    const queue = this.openThreads().filter(x => x.state === 'queued')
      .sort((a, b) => (Number(!!b.sessionId) - Number(!!a.sessionId)) || a.createdAt - b.createdAt);
    let waiting = 0;
    // 家里要求重启、正在等手上的任务答完：新任务先排队，重启后接着做。
    if (this.hubAdmin.holdingDispatch()) { this.careSessions(); return; }
    for (const listed of queue) {
      // 重读：前一个 dispatch 等待（开会话、发送）期间，这一个可能已被对端取消（remote-act.js cancel-queued）或解除配对
      let t = this.thread(listed.id);
      if (!t || t.state !== 'queued' || t.gen !== gen) continue;
      // 原会话停在选择菜单上（collect 判过「卡在选择题」）：追问 / 重试都新开会话接着做，带上原问题和那道题；旧会话不再往里发
      if (t.choiceStuckSession && t.sessionId === t.choiceStuckSession) {
        const qr = t.rounds.find(x => roundPhase(x) === 'queued');
        if (qr) this.rehome(t, qr, { why: '原会话停在选择菜单上', fromKey: this.sessionAccountKey(t.sessionId), kind: 'choice' });
        t = this.thread(t.id);
        if (!t || t.state !== 'queued') continue;
      }
      if (t.sessionId && this.sessionBusy(t.sessionId)) continue; // 追问时原会话还在忙（例如改写上一轮），等它停下
      if (t.rounds.some(x => roundPhase(x) === 'queued' && x.retryAt > this.now())) continue; // CLI 还没就绪，到点再发
      // 额度感知（2026-10-18）：指定的号核对一遍；追问落在避让中的号（或指定了别的号）上就换号新开会话，不再撞墙。
      {
        const qr = t.rounds.find(x => roundPhase(x) === 'queued');
        if (qr && this.checkAccountRequest(t, qr) === 'rejected') continue;
        t = this.thread(t.id) || t;
        if (!t || t.state !== 'queued') continue;
      }
      const only = this.requestedKey(t);
      // 不指定模型、要新开会话：所有能用的号都在避让中就排队，回执写明预计恢复时间，不占名额、不硬派。
      if (!t.model && !t.sessionId) {
        const accounts = this.routeAccounts();
        const pick = accounts && accounts.length ? route.pickAnyRoute(accounts, { only }) : null;
        if (pick && !pick.ok && pick.reason === 'avoid') {
          if (this.failIfModelConfigDeadEnd(t, accounts, '', only)) continue; // 全是模型配置有误：不排队，直接报回修法
          waiting += 1;
          this.reportQueue(t, waiting, limit, working, this.avoidQueueNote(accounts, pick.until, only));
          continue;
        }
      }
      // 家里指定了模型、要新开会话：只等有这个模型的号空出来，不占别的问题的名额（没有哪个号有它的，交给 dispatch 报回）。
      if (t.model && !t.sessionId) {
        const pick = this.pickModelRoute(t.model, undefined, only);
        // 等「能跑它的号池号空出来切模型」最多 MODEL_SWITCH_WAIT_MS：号一直有会话就别无限排队，回家里说明并给出现在能直接用的模型。
        const qr = t.rounds.find(x => roundPhase(x) === 'queued');
        if (pick && pick.reason === 'switch' && qr) {
          // 号上只剩答完保温、没在干活的通道会话：先让它们休眠，号空出来就能切（复审 2026-10-18）。
          this.freeForSwitch(pick.model);
          const since = qr.switchWaitSince && qr.switchWaitSince >= this.bootAt ? qr.switchWaitSince : this.now();
          if (!qr.switchWaitSince || qr.switchWaitSince !== since) t = this.patchRound(t, qr.round, { switchWaitSince: since });
          if (this.now() - since >= MODEL_SWITCH_WAIT_MS) { this.rejectModel(t, qr, this.routeAccounts(), 'switch'); continue; }
        } else if (qr && qr.switchWaitSince) t = this.patchRound(t, qr.round, { switchWaitSince: null });
        if (pick && !pick.ok && pick.reason === 'avoid' && this.failIfModelConfigDeadEnd(t, this.routeAccounts(), pick.model || t.model, only)) continue;
        if (pick && !pick.ok && pick.reason !== 'none') {
          waiting += 1;
          this.reportQueue(t, waiting, limit, working, pick.reason === 'avoid' ? this.avoidQueueNote(this.routeAccounts(), pick.until, only, pick.model)
            : `排队：等 ${pick.model} 的号空出来（${pick.reason === 'switch' ? '有它权限的号正在处理其他会话，空出来后切换' : `有它权限的号都在处理 ${this.perAccountCap()} 个问题`}）`);
          continue;
        }
      }
      if (free > 0) { await this.dispatch(t); free -= 1; continue; }
      waiting += 1;
      this.reportQueue(t, waiting, limit, working);
    }
    this.careSessions();
  }
  // 当前允许几个问题同时在跑（session-care.js parallelCap）。
  parallelLimit(working) {
    const s = this.settings();
    let lanes = 1;
    if (s.usePool) { try { lanes += Math.max(0, Number(this.deps.poolLanes?.()) || 0); } catch { /* 号池读不到就只算个人账号 */ } }
    const mem = this.sessionMemEstimate();
    const limit = { ...care.parallelCap({ date: new Date(this.now()), busyHours: s.busyHours, peakCap: s.maxParallel, idleCap: s.maxParallelIdle,
      perAccountPeak: s.perAccountPeak, perAccountIdle: s.perAccountIdle, memFloor: s.memFloorPct / 100, lanes, working,
      memory: this.deps.memory ? this.deps.memory() : care.memoryNow(), sessionBytes: mem.bytes }), ...care.sessionMemView(mem) };
    this.parallelState = { ...limit, lanes, working, at: this.now() };
    return limit;
  }
  // 每个会话按多少内存算（实测均值或默认 3.8 GB）；估计器出任何问题都退回默认值，不挡派活。
  sessionMemEstimate() {
    try { const m = this.sessionMem.current(); if (Number.isFinite(m.bytes) && m.bytes > 0) return m; } catch { /* 退回默认值 */ }
    return { bytes: care.SESSION_BYTES, source: 'default', samples: 0, reason: 'failed', note: care.sessionMemNote({ bytes: care.SESSION_BYTES, source: 'default', reason: 'failed' }) };
  }
  // 设置页显示「现在最多同时几个、受什么限制、每个会话按多少 GB 算」；算不出来时不挡状态页。
  parallelLimitSafe() {
    try {
      const working = this.openThreads().filter(x => x.state === 'running' && this.roundWorking(x)).length;
      const { cap, peak, limitedBy, timeCap, laneCap, memCap, sessionGB, sessionMemSource, sessionMemSamples, sessionMemNote } = this.parallelLimit(working);
      return { cap, peak, limitedBy, timeCap, laneCap, memCap, working, sessionGB, sessionMemSource, sessionMemSamples, sessionMemNote };
    } catch { return null; }
  }
  // 排队的问题告诉家里：排第几、为什么在等。只在内容变化时发。
  reportQueue(t, position, limit, working, custom = '') {
    const r = t.rounds.find(x => roundPhase(x) === 'queued');
    if (!r) return;
    const note = custom || `排队第 ${position} 个：${working} 个在跑，上限 ${limit.cap}（受${limit.limitedBy}限制）`;
    if (r.queueNote === note) return;
    this.patchRound(t, r.round, { queueNote: note });
    void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'received', note }).catch(() => {});
  }
  roundWorking(t) {
    if (t.sessionId && this.sessionBusy(t.sessionId)) return true;
    const r = t.rounds.find(x => roundPhase(x) === 'running');
    // 重启前被中断、等重启后恢复的轮次（hub-admin.js resumeAfterRestart）也算在干活。
    return !!r && (!!r.resumePending || this.now() - activeSince(r) < STARTUP_GRACE_MS);
  }

  // ---- 按模型派活（2026-10-18，core/codeagent-model-route.js）----
  // 能接通道会话的号（个人账号 + 号池可用的号，各自的模型和此刻的默认模型）；读不到返回 null（老环境、测试夹具没接）。
  // 每个号带上避让状态（avoid：额度用完 / 限流 / 手动暂停，见 avoidMap），挑号时跳过避让中的号。
  // 模型配置避让（2026-10-19）另带 modelAvoid（{ 模型小写: 记录 }，只放此刻还在避让的）：只在这个号请求那个模型时避开（route.avoidFor）。
  routeAccounts() {
    const list = this.routeAccountsRaw();
    if (!list) return list;
    const avoid = this.avoidMap(), models = this.modelAvoidMap();
    return list.map(a => (avoid[a.key] || models[a.key] ? { ...a, ...(avoid[a.key] ? { avoid: avoid[a.key] } : {}), ...(models[a.key] ? { modelAvoid: models[a.key] } : {}) } : a));
  }
  modelAvoidMap() {
    if (this.settings().quotaGuard === false) return {};
    try { return Q.activeModelAvoid(this.deps.dataDir, this.now()); } catch { return {}; }
  }
  // 个人账号上实际作答过的模型（set-personal-model 的权限证据之一，审核 2026-10-19）：
  //   1. 通道回执：回执元数据里的实际模型（actualModel，否则 model——2.1.12 起是发回执前从原生记录读的回答模型），
  //      账号按回执里的代称（2.1.13 起有 accountAlias），没有代称的老回执按会话元数据（没有号池标记 = 个人账号）；
  //   2. 会话记录：个人账号 CodeAgent 会话落盘的 codeagentActualModel（main.js observeCodeAgentModel 从原生记录读到的回答模型）。
  // 返回 [{ model, source, count }]（模型名不涉及隐私，直查也显示）。
  personalAnsweredModels() {
    const seen = new Map();
    const add = (model, source) => {
      const m = String(model || '').trim();
      if (!m || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(m)) return;
      const k = m.toLowerCase() + '|' + source;
      seen.set(k, { model: m, source, count: (seen.get(k)?.count || 0) + 1 });
    };
    try {
      for (const t of this.threads(500)) {
        for (const r of t.rounds || []) {
          if (!r.reply || !r.meta) continue;
          let personal;
          if (r.meta.accountAlias) personal = r.meta.accountAlias === '个人';
          else {
            const s = t.sessionId && (this.deps.getSession?.(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId));
            personal = !!s && /^codeagent/.test(String(s.kind || 'codeagent')) && !s.codeagentPoolAccount;
          }
          if (personal) add(r.meta.actualModel || r.meta.model, 'receipt');
        }
      }
    } catch { /* 读不到回执就只看会话记录 */ }
    try { for (const m of this.deps.personalAnsweredModels?.() || []) add(m, 'session'); } catch { /* 读不到会话记录 */ }
    return [...seen.values()];
  }
  // 除了 key 这个号，还有没有能接这一题的号（不在避让中、指定了模型时有它的权限；指定了号时只看那个号）。
  otherAccountUsable(t, key) {
    const accounts = (this.routeAccounts() || []).filter(a => a.key !== key);
    return accounts.some(a => (t.model ? route.canEverServe(a, t.model) : true) && !route.avoidFor(a, t.model || ''));
  }
  // 「模型配置有误：个人请求了 X，该号只有 Y；可用 set-personal-model 改成 Y」（回执用，模型名原样）
  modelConfigFailText(key, model = '') {
    let entry = null;
    try { entry = Q.modelAvoidEntry(Q.modelAvoidAll(this.deps.dataDir), key, model || ''); } catch { entry = null; }
    const asked = (entry && entry.model !== '*' ? entry.model : model) || '（报错里没写模型）';
    const have = entry && Array.isArray(entry.have) && entry.have.length ? entry.have.join('、') : '（权限清单未知）';
    const hint = entry ? Q.modelConfigHint(entry) : '';
    return `模型配置有误：${this.aliasOf(key)}请求了 ${asked}，该号只有 ${have}${hint}；现在没有别的号能接这一题，没有换号重做、也没有排队（配置不改会一直报）`;
  }
  // 排队前：能接这一题的号全在避让中、且都是模型配置有误（不会自己恢复）→ 不排队，直接报回修法。返回 true 表示已处理。
  failIfModelConfigDeadEnd(t, accounts, model = '', only = '') {
    const list = (accounts || []).filter(a => (!only || a.key === only) && (!model || route.canEverServe(a, model)));
    if (!list.length || !list.every(a => { const e = route.avoidFor(a, model); return e && e.kind === 'model-config'; })) return false;
    const r = t.rounds.find(x => roundPhase(x) === 'queued');
    if (!r) return false;
    const a = list[0];
    this.rejectRound(t, r, this.scrubText(this.modelConfigFailText(a.key, route.requestModel(a, model))));
    return true;
  }
  // 派给一个有模型配置避让记录、已到试探时间的号：记一次试探（下一次再过 6 小时），这次照派；试探又报错就重新避让、按换号重做处理。
  noteProbe(account, model = '') {
    if (!account || !account.key) return;
    try {
      const want = route.requestModel(account, model);
      if (Q.noteModelProbe(this.deps.dataDir, account.key, want, this.now())) this.bridgeLog(`model-config probe ${account.pool ? 'pool' : 'personal'} model=${want}`);
    } catch { /* 记不下就下次再记 */ }
  }
  // 这个号（按它此刻会请求的模型，或指定的模型）是不是在避让：整号避让或模型配置避让。
  accountAvoid(key, model = '', accounts = this.routeAccounts()) {
    const a = (accounts || []).find(x => x.key === key);
    if (a) return route.avoidFor(a, model);
    return this.avoidMap()[key] || null;
  }
  // 给人看的避让状态（直查、界面）：整号避让优先；否则这个号的模型配置避让（含已到试探时间、等着试一次的）。
  avoidViewMap() {
    const out = { ...this.avoidMap() };
    if (this.settings().quotaGuard === false) return out;
    let all = {};
    try { all = Q.modelAvoidAll(this.deps.dataDir); } catch { all = {}; }
    // 只显示和这个号此刻会请求的模型对得上的记录（审核 2026-10-19）：配置已改成别的模型、或只是某个会话里临时换过的，不再挂「避让中」
    const accounts = new Map((this.routeAccountsRaw() || []).map(a => [a.key, a]));
    for (const [key, list] of Object.entries(all)) {
      if (out[key]) continue;
      const a = accounts.get(key);
      if (!a) continue;
      const e = Q.modelAvoidEntry({ [key]: list }, key, a.configModel || a.defaultModel || '');
      if (e) out[key] = e;
    }
    return out;
  }
  routeAccountsRaw() {
    if (!this.deps.routeAccounts) return null;
    try { return this.deps.routeAccounts({ usePool: this.settings().usePool }) || []; }
    catch (error) { console.warn('[company-bridge] 读账号与模型清单失败：' + error.message); return null; }
  }
  // 各号上通道正在处理的问题数（键：personal / 号池编号），和并行名额同一口径（roundWorking）。
  workingByAccount() {
    const out = {};
    for (const t of this.openThreads()) {
      if (t.state !== 'running' || !t.sessionId || !this.roundWorking(t)) continue;
      const s = this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId);
      const key = s?.codeagentPoolAccount || 'personal';
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  }
  // 每个号同时处理几个问题（设置里的每号忙时 / 闲时上限）。
  perAccountCap() { const s = this.settings(); return care.isPeak(new Date(this.now()), s.busyHours) ? s.perAccountPeak : s.perAccountIdle; }
  pickModelRoute(model, accounts = this.routeAccounts(), only = '') {
    if (!accounts) return null;
    return route.pickRoute(accounts, model, { working: this.workingByAccount(), cap: this.perAccountCap(), only });
  }

  // ---- 额度感知（2026-10-18，core/codeagent-quota.js、quota-watch.js）----
  // 此刻在避让中的号：{ 键: 记录 }。关了「额度识别」时只认手动暂停。
  avoidMap() {
    let map = {};
    try { map = Q.activeAvoid(this.deps.dataDir, this.now()); } catch { map = {}; }
    if (this.settings().quotaGuard === false) for (const k of Object.keys(map)) if (map[k].source !== 'manual') delete map[k];
    return map;
  }
  // 代称表（个人 / 号 1…，号池登记顺序；不在登记里的号按出现顺序往后排，和直查 diag.js 一致）。
  aliasTable(accounts = null) {
    let keys = [];
    try { keys = (accounts || this.routeAccountsRaw() || []).filter(a => a.pool).map(a => a.key); } catch { keys = []; }
    return Q.aliasMap(this.deps.dataDir, keys);
  }
  aliasOf(key) { if (!key) return '某个号'; return this.aliasTable().get(key) || (key === 'personal' ? '个人' : '号池里的一个号'); }
  accountKey(alias) { return Q.keyForAlias(this.aliasTable(), alias); }
  sessionAccountKey(sessionId) {
    const s = sessionId && (this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId));
    if (!s) return null;
    return s.codeagentPoolAccount ? String(s.codeagentPoolAccount) : 'personal';
  }
  // 这一题新开会话时只在哪个号里挑（排队那一轮指定了号）。
  requestedKey(t) {
    const r = t.rounds.find(x => roundPhase(x) === 'queued');
    return r && r.account ? this.accountKey(r.account) : '';
  }
  // 「所有号额度用完，预计 X 恢复」（排队说明，发回对端）。
  avoidQueueNote(accounts, until, only = '', model = '') {
    const list = (accounts || []).filter(a => (!only || a.key === only) && (!model || route.canEverServe(a, model)) && route.avoidFor(a, model));
    const parts = list.map(a => `${this.aliasOf(a.key)}：${Q.describeAvoid(route.avoidFor(a, model), this.now())}`);
    const who = only ? `指定的${this.aliasOf(only)}在避让中` : model ? `能跑 ${model} 的号都在避让中` : '所有号都在避让中（额度用完、限流或模型配置有误）';
    return this.scrubText(`排队：${who}${until ? `，预计 ${Q.clock(until)} 恢复` : ''}；恢复后自动派发${parts.length ? `（${parts.join('；')}）` : ''}`);
  }
  // 家里指定的号：写法不对、没有这个号、在避让中 → 这一轮不发出，回报原因和现在可用的号；
  // 追问换了号、或原会话的号在避让中 → 换号新开会话（rehome），带上前几轮作上下文。返回 'rejected' / 'switched' / 'ok'。
  checkAccountRequest(t, r) {
    // 整号避让，或这个号请求这一题的模型（指定的，或它配置里的）时在模型配置避让中
    const routed = this.routeAccounts();
    const avoidOf = key => this.accountAvoid(key, t.model || '', routed);
    const usable = () => {
      const accounts = this.routeAccounts() || [];
      const names = accounts.filter(a => !route.avoidFor(a, t.model || '')).map(a => this.aliasOf(a.key));
      return names.length ? `现在可用：${names.join('、')}` : '现在所有号都在避让中';
    };
    if (r.badAccount) { this.rejectRound(t, r, `指定的号「${r.badAccount}」写法不对（只认「个人」「号 1」这样的代称）；没有发出。${usable()}，或不指定号交给自动路由`); return 'rejected'; }
    if (r.account) {
      const key = this.accountKey(r.account);
      const accounts = this.routeAccounts();
      if (!key || (accounts && !accounts.some(a => a.key === key))) { this.rejectRound(t, r, `指定的号「${r.account}」现在不能用（不在这台电脑的账号里，或登录失效）；没有发出。${usable()}，或不指定号交给自动路由`); return 'rejected'; }
      const av = avoidOf(key);
      if (av) { this.rejectRound(t, r, this.scrubText(`指定的${r.account}在避让中：${Q.describeAvoid(av, this.now())}${av.sample ? `（${av.sample}）` : ''}；没有发出。${usable()}，或不指定号交给自动路由`)); return 'rejected'; }
      if (t.sessionId) {
        const cur = this.sessionAccountKey(t.sessionId);
        if (cur && cur !== key) { this.rehome(t, r, { why: `指定换到${r.account}`, fromKey: cur }); return 'switched'; }
      }
      return 'ok';
    }
    if (t.sessionId) {
      const cur = this.sessionAccountKey(t.sessionId);
      const curAvoid = cur ? avoidOf(cur) : null;
      if (curAvoid) { this.rehome(t, r, { why: `${Q.describeAvoid(curAvoid, this.now())}`, fromKey: cur }); return 'switched'; }
    }
    return 'ok';
  }
  rejectRound(t, r, why) {
    this.patchRound(t, r.round, { error: why, failedAt: this.now() });
    const models = this.modelTableSafe();
    void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'error', note: why, ...(models ? { models } : {}) }).catch(() => {});
    this.notify('没能开始', `${t.id}：${short(why, 80)}`);
    this.changed();
  }
  // 「模型配置有误」的当场兜底（2026-10-22 用户）：在同一个会话里用 /model 切到这个号权限清单里的模型（main 从探测到的权限清单里挑
// 第一个不是刚报错那个的），然后把这一轮退回排队重发一次——不必换号新开会话，上下文照旧。返回 true 表示已经重发。
// 动手前先确认「切了能接着往下走」：会话不在忙、这个号此刻不因整号避让或它配置里的模型在避让中
// （那种情况下重发仍会被 checkAccountRequest 换号，白开一次菜单）；每轮只试一次（modelFixTried，rehome 时会清掉）。
  async fixModelInSession(t, r, hit) {
    if (r.modelFixTried || !this.deps.pickModel || !t.sessionId) return false;
    const sessionId = t.sessionId;
    if (!this.deps.getSession(sessionId) || this.sessionBusy(sessionId)) return false;
    const account = (this.routeAccounts() || []).find(a => a.key === hit.key);
    if (!account || route.avoidFor(account, t.model || '')) return false;
    const tried = { modelFixTried: this.now(), modelFixTriedModel: String(hit.model || '') };
    let fix = null;
    try { fix = await this.deps.pickModel(sessionId, { avoidModel: hit.model || '', reason: 'model-config-fix' }); }
    catch (error) { fix = { ok: false, message: error && error.message ? error.message : String(error) }; }
    if (!fix || !fix.ok) {
      this.bridgeLog(`model-fix ${t.id}#${r.round} session=${String(sessionId).slice(0, 8)} 没切动（${(fix && fix.message) || '未知'}），照旧换号 / 报错`);
      this.patchRound(this.thread(t.id) || t, r.round, tried);
      this.changed();
      return false;
    }
    // 重发这一轮：清掉上一次发送留下的痕迹（baseline / landed / 指纹等），dispatch 会按当前最后一条回答重新取基线再发。
    // 不算「换号重做」，rehomed 不动；reasent 也不动——那一轮没答出来，重发一次算第一次发。
    // 号的配置本身没写错（写的模型在权限清单里）时，把「这个号请求了 X」这条避让记录清掉：会话已经改用清单里的模型，
    // 新开会话也不会再请求 X，留着只会让「账号与号池」和直查以为这个号坏了。配置真写错（清单里没有它写的值）时留着，
    // 让新会话别一窝蜂撞同一个错。
    try {
      if ((account.models || []).some(m => Q.modelKey(m) === Q.modelKey(account.configModel))) Q.clearModelAvoid(this.deps.dataDir, hit.key, hit.model);
    } catch { /* 清不掉不影响这一轮 */ }
    this.bridgeLog(`model-fix ${t.id}#${r.round} session=${String(sessionId).slice(0, 8)} ${hit.model || '?'} → ${fix.model}，这一轮重发一次`);
    this.patchRound(this.thread(t.id) || t, r.round, { ...tried, modelFix: fix.model, sentAt: null, baseline: null, landed: null, sendUncertain: null,
      receiptIssue: null, promptFingerprint: null, notReadySince: null, retryAt: null, error: null,
      // 这一次模型配置报错已经处理过了：重发就在报错后几秒内发生，不记下来的话下一次 collect 还会拿同一条报错走下面的换号分支。
      quotaHitIgnored: hit.at });
    this.notify('模型配置有误，当场换模型重发', `${t.id} 第 ${r.round} 轮：用 ${fix.model} 重发一次`, sessionId, { quiet: true });
    void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'received',
      note: this.scrubText(`${this.aliasOf(hit.key)}请求的模型不在权限清单里，已在这个会话里改用 ${fix.model}，这一轮重发一次`) }).catch(() => {});
    this.changed();
    return true;
  }
  // 换号新开会话：hit（撞到额度，这一轮在途）时把这一轮退回排队、记一次重做；否则（排队的追问）只换会话。
  // 旧会话不动（不发按键、不关），保温规则照常让它休眠；新会话的提问带原问题、前几轮问答和上一会话的进展（promptFor）。
  // kind='choice'：原会话停在选择菜单上（不是换号），新会话的提问另带原问题和那道选择题（rehomeContext）。
  rehome(t, r, { why, fromKey, hit = null, kind = '' }) {
    const fromAlias = this.aliasOf(fromKey);
    const choice = !hit && kind === 'choice';
    const progress = hit ? this.progressSince(t.sessionId, r) : '';
    const prevSessions = [...(t.prevSessions || []), { sessionId: t.sessionId, account: fromKey, at: this.now(), why: short(why, 80) }].slice(-5);
    const rounds = t.rounds.map(x => x.round !== r.round ? x : {
      ...x, sentAt: null, baseline: null, landed: null, resent: null, sendUncertain: null, receiptIssue: null, promptFingerprint: null, hijacked: 0,
      modelFixTried: null, modelFix: null,
      notReadySince: null, retryAt: null, queueNote: null, rewrite: false, rewriteAsked: false, resumePending: null, resumedAt: null,
      ...(hit ? { rehomed: (Number(x.rehomed) || 0) + 1, account: undefined, requestedAccount: x.account || x.requestedAccount || undefined } : {}),
      rehome: { from: fromAlias, why: short(why, 120), progress, at: this.now(), kind: hit ? (hit.kind === 'model-config' ? 'model-config' : 'quota') : choice ? 'choice' : 'switch' },
    });
    const next = this.saveThread({ ...t, sessionId: null, everAnswered: false, prevSessions, redoCount: (Number(t.redoCount) || (t.prevSessions || []).length) + 1, rounds });
    // 模型配置有误只对这个号的这个模型避让（2026-10-19）
    const note = this.scrubText(hit && hit.kind === 'model-config' ? `${fromAlias}报模型配置有误（${hit.text || why}），请求这个模型时不再派给它；这一轮自动换号新开会话重做`
      : hit ? `${fromAlias}撞到${Q.KINDS[hit.kind] || '额度上限'}（${hit.text || why}），已暂停派给它；这一轮自动换号新开会话重做`
      : choice ? '原会话停在一道选择题上，这一轮新开会话接着做，带上原问题、那道选择题和前几轮问答'
      : `原会话在${fromAlias}上（${why}），这一轮换号新开会话，带上前几轮问答作上下文`);
    this.bridgeLog(`rehome ${t.id}#${r.round} from=${fromKey === 'personal' ? 'personal' : 'pool'} ${hit ? 'quota rule=' + hit.ruleId : choice ? 'choice' : 'switch'} session=${String(t.sessionId || '').slice(0, 8)}`);
    void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'received', note }).catch(() => {});
    this.notify(hit ? (hit.kind === 'model-config' ? '模型配置有误，换号重做' : '撞到额度，换号重做') : choice ? '新开会话接着做' : '换号新开会话', `${t.id}：${short(note, 80)}`, null, { quiet: !hit });
    this.changed();
    return next;
  }
  // 上一会话在这一轮里已经写出的进展（撞额度前的最后一段回答，去掉 API 报错本身），最多 1500 字。
  progressSince(sessionId, r) {
    try {
      const meta = sessionId && (this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId));
      const finals = meta && this.deps.readFinals ? this.deps.readFinals(meta) || [] : [];
      const since = (activeSince(r) || 0) - 5000;
      const last = [...finals].reverse().find(f => f.id !== r.baseline && (!f.timestamp || f.timestamp >= since) && !/^\s*API\s*Error/i.test(String(f.text || '')) && String(f.text || '').trim());
      if (!last) return '';
      const text = String(last.text).trim();
      return text.length > REHOME_PROGRESS_CHARS ? '…' + text.slice(-REHOME_PROGRESS_CHARS) : text;
    } catch { return ''; }
  }
  // 换号后新会话的上下文：为什么换、上一会话的进展、此前各轮问答（从最近的往前放，总共不超过 12000 字）。
  rehomeContext(t, r) {
    const h = r.rehome || {};
    const lines = [h.kind === 'quota' || h.kind === 'model-config'
      ? `（说明：这个请求原先在另一个会话里处理，那个会话所用的号${h.from ? `（${h.from}）` : ''}因${h.why || '额度'}中断，现换到新会话重做。${h.progress ? '上一会话已读到的进展如下，仅供参考，请自行核实：' : ''}）`
      : h.kind === 'choice'
        ? '（说明：同一编号此前在另一个会话里处理时，停在了一道选择题上、没有人能选，那一轮没有作答；现换到这个新会话接着做。下面附上那道题和此前各轮问答作上下文。）'
        : `（说明：同一编号此前的几轮在另一个会话里${h.from ? `（${h.from}）` : ''}，因${h.why || '换号'}换到这个新会话；下面附上此前各轮问答作上下文。）`];
    if (h.progress) lines.push('', '> ' + h.progress.split('\n').join('\n> '));
    // 停在选择题上的那一轮（没有回答）：它的提问和那道题都带上；本轮就是它自己（重试）时只带那道题
    const stuck = h.kind === 'choice' ? [...t.rounds].reverse().find(x => x.choiceStuck && !x.reply && x.round <= r.round) : null;
    let stuckBlock = '';
    if (stuck) {
      const what = stuck.choiceStuck.kind === 'permission' ? '权限确认' : '选择题';
      const menu = `那道${what}：${stuck.choiceStuck.question || '（没认出题目）'}\n选项：${(stuck.choiceStuck.options || []).join(' / ')}`;
      if (stuck.round === r.round) lines.push('', `上一次做这一轮时停在了这道${what}上：\n${menu}`);
      else {
        const q = String(stuck.question || '');
        stuckBlock = `### 第 ${stuck.round} 轮提问（停在${what}上，没有作答）\n${q.length > 4000 ? q.slice(0, 4000) + '…' : q}\n\n${menu}\n\n本轮请求是对方对那道题的选择或补充。`;
      }
    }
    const earlier = t.rounds.filter(x => x.round < r.round && x.reply);
    if (stuckBlock && !earlier.length) lines.push('', stuckBlock, '', `## 本轮（第 ${r.round} 轮）请求`);
    if (earlier.length) {
      let budget = REHOME_CONTEXT_CHARS;
      const blocks = [];
      for (const x of [...earlier].reverse()) {
        const reply = String(x.reply || '');
        const q = String(x.question || '');
        const piece = `### 第 ${x.round} 轮提问\n${q.length > 2000 ? q.slice(0, 2000) + '…' : q}\n\n### 第 ${x.round} 轮回答\n${reply.length > budget ? reply.slice(0, Math.max(500, budget)) + '…（后略）' : reply}`;
        if (budget <= 0) break;
        blocks.unshift(piece); budget -= piece.length;
      }
      lines.push('', '此前各轮问答（同一编号，供参考）：', '', blocks.join('\n\n'), ...(stuckBlock ? ['', stuckBlock] : []), '', `## 本轮（第 ${r.round} 轮）请求`);
    }
    return lines.join('\n');
  }
  // 额度识别报来的变化（quota-watch.js）：界面刷新，尽快把新的避让状态推给对端。
  avoidChanged({ marked = [], cleared = [] } = {}) {
    for (const k of [...new Set(marked)]) {
      const e = this.avoidViewMap()[k];
      if (e) this.notify('暂停派给' + this.aliasOf(k), this.scrubText(Q.describeAvoid(e, this.now()) + (e.sample ? '：' + e.sample : '')), null, { quiet: true });
    }
    for (const k of [...new Set(cleared)]) this.notify('恢复派给' + this.aliasOf(k), this.avoidMap()[k] ? '部分避让已解除' : '避让已解除（Credit 读数回升，或用那个模型正常答出来了）', null, { quiet: true });
    this.nextPullAt = Math.min(this.nextPullAt || Infinity, this.now() + 5000);
    this.changed();
  }
  // 有该模型权限、默认不是它的号池号上，只剩答完保温的通道会话（不在干活、没有待派的追问）时让它们休眠，号空出来就能切模型。
  // 人自己开的会话、在干活的通道会话都不动；每个模型一分钟最多试一次。返回请求休眠的会话数。
  freeForSwitch(model) {
    if (!this.deps.suspendSession || !this.deps.listSessionIds) return 0;
    this.freeAt = this.freeAt || {};
    const k = String(model).toLowerCase();
    if (this.now() - (this.freeAt[k] || 0) < CARE_EVERY_MS) return 0;
    this.freeAt[k] = this.now();
    const accounts = (this.routeAccounts() || []).filter(a => a.pool && route.hasModel(a, model) && String(a.defaultModel).toLowerCase() !== k && a.activeSessions > 0);
    if (!accounts.length) return 0;
    const threads = this.threads(300);
    const bridgeSessions = new Set(threads.map(t => t.sessionId).filter(Boolean));
    const pending = new Set(threads.filter(t => ['queued', 'running'].includes(t.state)).map(t => t.sessionId).filter(Boolean));
    let n = 0;
    for (const a of accounts) {
      const ids = (this.deps.listSessionIds() || []).filter(id => { const s = this.deps.getSession(id); return s && s.codeagentPoolAccount === a.key && s.status !== 'dormant' && s.status !== 'closed'; });
      if (!ids.length || !ids.every(id => bridgeSessions.has(id) && !pending.has(id) && !this.sessionBusy(id))) continue;
      for (const id of ids) {
        let result;
        try { result = this.deps.suspendSession(id, { reason: 'company-bridge-model-switch', minIdleMs: 60000, excludePinned: true, excludeFocused: true, excludeMeeting: true }); }
        catch (error) { result = { ok: false, message: error.message }; }
        this.careLog(`${result?.ok ? 'suspend' : 'skip'} session=${String(id).slice(0, 8)} 为切到 ${model} 先休眠保温会话${result?.ok ? '' : '；跳过：' + (result?.message || result?.error || '未知')}`);
        if (result?.ok) n += 1;
      }
    }
    return n;
  }
  // 发给家里的模型表：按模型聚合，不含账号名、工号、备注。
  modelTable() {
    const accounts = this.routeAccounts();
    if (!accounts) return null;
    const s = this.settings(), parallel = this.parallelLimitSafe();
    let credit = {};
    try { credit = Q.creditReadings(this.deps.dataDir); } catch { credit = {}; }
    // 号 + 模型（额度感知，2026-10-18）：每个号一行，只用代称；避让原因脱敏。
    const secrets = this.accountSecrets();
    return route.modelTable(accounts, { working: this.workingByAccount(), cap: this.perAccountCap(), peak: care.isPeak(new Date(this.now()), s.busyHours),
      parallel: parallel ? { cap: parallel.cap, working: parallel.working } : null, at: this.now(),
      aliases: this.aliasTable(accounts), credit, describe: e => this.scrubText(Q.describeAvoid(e) + (e.source === 'error' && e.sample ? '：' + e.sample : e.source === 'credit' ? '：' + e.reason : ''), secrets) });
  }
  modelTableSafe() { try { const table = this.modelTable(); return table && table.models.length ? table : null; } catch { return null; } }
  // 启动后（或换了配对）推一次；之后模型集合、号数、高峰与否、还能并行的档位明显变化才推，最快 10 分钟一次。
  async pushModels() {
    if (!this.link.paired()) return;
    const table = this.modelTableSafe();
    if (!table) return;
    const gen = this.link.gen(), sig = route.tableSignature(table), avoidSig = route.avoidSignature(table), last = this.modelsPush || {};
    // 号的避让状态变了：最快 30 秒推一次，不等 10 分钟
    const avoidMoved = avoidSig !== (last.avoidSig || '') && this.now() - (last.at || 0) >= AVOID_PUSH_MIN_MS;
    if (last.gen === gen && !avoidMoved && (sig === last.sig || this.now() - (last.at || 0) < MODELS_PUSH_MIN_MS)) return;
    await this.link.send('models', { gen, table });
    this.modelsPush = { gen, sig, avoidSig, at: this.now() };
  }
  // 指定的模型没有哪个号有：不开会话，回家里写明原因和可选模型（家里换模型重问）；不静默换模型。
  rejectModel(t, r, accounts, reason = 'none') {
    const options = reason === 'switch' ? route.servableNow(accounts || []) : route.listModels(accounts || []);
    const why = reason === 'switch'
      ? `指定的模型 ${t.model}：有它权限的号这段时间都在处理其他会话，等了 ${MODEL_SWITCH_WAIT_MS / 60000} 分钟没能空出来切换；没有开会话。${options.length ? `现在可直接用的模型：${options.join('、')}，` : ''}可以换一个模型重问，或不指定模型用公司默认`
      : `指定的模型 ${t.model} 在公司这边没有可用的号${options.length ? `（可选：${options.join('、')}）` : '（公司这边暂时没有可用的号）'}；没有开会话，可以换一个模型重问，或不指定模型用公司默认`;
    this.patchRound(t, r.round, { error: why, failedAt: this.now() });
    const models = this.modelTableSafe();
    void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'error', note: why, ...(models ? { models } : {}) }).catch(() => {});
    this.notify('没能开始', `${t.id}：${short(why, 80)}`);
    this.changed();
  }

  // 答完的通道会话按追问规律与内存余量休眠（session-care.js）；休眠保留记录，追问时 dispatch 会按编号恢复。
  careSessions() {
    if (!this.deps.suspendSession || this.now() - (this.lastCareAt || 0) < CARE_EVERY_MS) return;
    this.lastCareAt = this.now();
    const all = this.threads(300);
    const keep = care.learnKeepWarm(all);
    const asker = this.store.get('askerActive') || {};
    const askerFresh = asker.at && this.now() - asker.at < ASKER_TTL_MS ? new Set(asker.threads || []) : new Set();
    const bySession = new Map();
    for (const t of all) {
      if (!t.sessionId || t.state === 'cancelled') continue;
      if (t.state === 'queued' || t.state === 'running') { bySession.set(t.sessionId, null); continue; } // 在途：不收
      if (bySession.get(t.sessionId) === null) continue;
      const last = t.rounds[t.rounds.length - 1] || {};
      const idleSince = last.replyAt || last.failedAt || t.updatedAt || 0;
      const prev = bySession.get(t.sessionId);
      if (!prev || idleSince > prev.idleSince) bySession.set(t.sessionId, { sessionId: t.sessionId, threadId: t.id, idleSince, askerActive: askerFresh.has(t.id) });
    }
    // 有人在这个会话的终端里直接打过字（用户自己接着用），从那时算起：看实际活动，不只看回执时间。
    const mem = this.sessionMemEstimate(); // 和并行上限同一个估计
    // 每个候选带上自己进程树的实测字节数（最近一次测量，测不到就不带）：膨胀规则和「收一个腾出多少」按它算。
    // 只认答完之后测的：休眠前测到的旧值不能套在恢复后的新进程上（恢复后只有一批插件）。
    const measured = mem.byId && typeof mem.byId === 'object' ? mem.byId : {};
    const measuredAt = Number(mem.at) || 0;
    const candidates = [...bySession.values()].filter(c => c && this.deps.getSession(c.sessionId) && !this.sessionBusy(c.sessionId))
      .map(c => {
        const bytes = Number(measured[c.sessionId]);
        const idleSince = Math.max(c.idleSince, Number(this.deps.sessionInputAt?.(c.sessionId)) || 0);
        return { ...c, idleSince, ...(Number.isFinite(bytes) && bytes > 0 && measuredAt >= idleSince ? { bytes } : {}) };
      });
    const memory = this.deps.memory ? this.deps.memory() : care.memoryNow();
    const plan = care.planRelease({ candidates, keepWarmMs: keep.ms, now: this.now(), memory, sessionBytes: mem.bytes });
    const planned = new Map(plan.map(p => [p.sessionId, p.rule]));
    const gb = b => Math.round(b / (1024 ** 3) * 10) / 10;
    this.careState = { keepWarmMinutes: Math.round(keep.ms / 60000), samples: keep.samples, learned: keep.learned,
      freePercent: Math.round(memory.ratio * 100), warm: candidates.length, at: this.now(), ...care.sessionMemView(mem),
      bloatGB: gb(care.BLOAT_BYTES), bloatIdleMinutes: Math.round(care.BLOAT_MIN_IDLE_MS / 60000),
      // --diag hub 里看每个保温会话：实测多少 GB、空闲几分钟、这一轮按哪条规则收（没收为 null）
      sessions: candidates.map(c => ({ threadId: c.threadId, session: String(c.sessionId).slice(0, 8), gb: Number.isFinite(c.bytes) ? gb(c.bytes) : null,
        idleMinutes: Math.round((this.now() - c.idleSince) / 60000), release: planned.get(c.sessionId) || null })),
      bloatSuspended: (this.careState?.bloatSuspended || []).slice(-9) };
    for (const p of plan) {
      let result;
      const reason = p.rule === 'bloat' ? 'company-bridge-bloat' : 'company-bridge-idle';
      try { result = this.deps.suspendSession(p.sessionId, { reason, minIdleMs: 60000, excludePinned: true, excludeFocused: true, excludeMeeting: true }); }
      catch (error) { result = { ok: false, message: error.message }; }
      if (p.rule === 'bloat') this.careState.bloatSuspended.push({ threadId: p.threadId, session: String(p.sessionId).slice(0, 8), gb: gb(p.bytes), ok: !!result?.ok, at: this.now() });
      this.careLog(`${result?.ok ? 'suspend' : 'skip'} ${p.threadId} session=${String(p.sessionId).slice(0, 8)} ${p.reason}${result?.ok ? '' : '；跳过：' + (result?.message || result?.error || '未知')}`);
    }
    this.suspendRehomed(all, bySession);
  }
  // 因额度换号后留下的旧会话（prevSessions）：不再有问题指向它，停下来（不在干活）就让它休眠，不占内存（审核 2026-10-18）。
  // 仍是某个问题的当前会话、或在忙的不动；人在里面打过字的（sessionInputAt 晚于换号时间）不动。
  suspendRehomed(all, current) {
    const seen = new Set();
    for (const t of all) {
      for (const p of t.prevSessions || []) {
        const id = p && p.sessionId;
        if (!id || seen.has(id) || current.has(id)) continue;
        seen.add(id);
        const s = this.deps.getSession(id);
        if (!s || s.status === 'dormant' || s.status === 'closed' || this.sessionBusy(id)) continue;
        if ((Number(this.deps.sessionInputAt?.(id)) || 0) > (p.at || 0) + 5000) continue;
        let result;
        try { result = this.deps.suspendSession(id, { reason: 'company-bridge-rehomed', minIdleMs: 60000, excludePinned: true, excludeFocused: true, excludeMeeting: true }); }
        catch (error) { result = { ok: false, message: error.message }; }
        this.careLog(`${result?.ok ? 'suspend' : 'skip'} ${t.id} session=${String(id).slice(0, 8)} 换号后的旧会话${result?.ok ? '' : '；跳过：' + (result?.message || result?.error || '未知')}`);
      }
    }
  }
  careLog(line) { this.appendLog('company-session-care.log', line); }
  appendLog(name, line) {
    try {
      const fs = require('node:fs'), dir = path.join(this.deps.dataDir, 'logs'), file = path.join(dir, name);
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, file + '.1'); } catch { /* 还没有文件 */ }
      fs.appendFileSync(file, `${new Date(this.now()).toISOString()} ${line}\n`, 'utf8');
    } catch { /* 日志写不了不影响收放 */ }
  }

  promptFor(t, r, s) {
    if (r.rewrite) return `（编号 ${t.id}，第 ${r.round} 轮）你上一条回答里有成段的源码。按规则不能回传源码：请把整份回答重写一遍，代码部分改成文字说明或几行伪代码，其余内容保持。直接输出重写后的完整回答。`;
    const roots = s.codeRoots.length ? s.codeRoots.map(p => '- ' + p).join('\n') : '- （未设置，请在当前目录里找）';
    // 换号新开的会话（额度中断重做、追问换号）：完整说明 + 为什么换、上一会话的进展、此前各轮问答 + 本轮请求。
    if (r.rehome) {
      return [s.instructions, '', '代码位置：', roots, '', `## 成员请求（编号 ${t.id}${r.round > 1 ? `，第 ${r.round} 轮` : ''}）`, '', this.rehomeContext(t, r), '', r.question].join('\n');
    }
    if (r.round === 1 || !t.everAnswered) {
      return [s.instructions, '', '代码位置：', roots, '', `## 成员请求（编号 ${t.id}${r.round > 1 ? `，第 ${r.round} 轮` : ''}）`, '', r.question].join('\n');
    }
    return [`## 成员追问（编号 ${t.id}，第 ${r.round} 轮）`, '', r.question, '', '（规则同前：保持公司电脑原样、不回传源码和凭据、末尾写把握程度和没读到的部分。）'].join('\n');
  }

  async dispatch(t) {
    const s = this.settings();
    const r = t.rounds.find(x => roundPhase(x) === 'queued');
    if (!r) { this.saveThread(t); return; }
    try {
      let sessionId = t.sessionId;
      const known = sessionId && (this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId));
      if (!known) {
        sessionId = randomUUID();
        const cwd = s.codeRoots.find(p => this.deps.isDirectory ? this.deps.isDirectory(p) : true) || this.deps.fallbackCwd;
        const opts = { id: sessionId, cwd, title: tezhanSessionTitle(t), purpose: PURPOSE, autonomous: true, noInheritCursor: true,
          effort: s.effort, addDirs: s.codeRoots.filter(p => p !== cwd) };
        // 不指定模型：个人账号和号池里能用的号一起挑（route.pickAnyRoute：每号上限 → 进行中会话最少 → 上次分配时间轮转），
        // 并行的问题分散到不同账号（2026-10-18 用户反馈 v2.1.11：以前号池有号就只开号池，个人账号只在号池失败时兜底）。
        // 号池开会话失败时退回个人账号，问题不卡住。读不到账号清单的老环境按以前：有号池就走号池自动挑号。
        let created = null;
        let poolLanes = 0;
        try { poolLanes = s.usePool ? Number(this.deps.poolLanes?.()) || 0 : 0; } catch { poolLanes = 0; }
        // 指定了号（代称，advance 已核过）：只在它里面挑。避让中的号一律不挑（额度感知）。
        const only = r.account ? this.accountKey(r.account) : '';
        let fallbackPersonal = !only || only === 'personal';
        if (t.model) {
          // 家里指定了模型：在有它权限的号里（个人账号 + 号池）挑进行中会话最少的；用它的配置目录定模型（session-manager codeAgentRouteModel）。
          // 挑不出号不退回个人账号或别的模型。
          const accounts = this.routeAccounts();
          if (!accounts) throw new Error('这台公司 Hub 读不到账号与模型清单，不能按指定模型开会话；可以不指定模型重问');
          const pick = this.pickModelRoute(t.model, accounts, only);
          if (!pick.ok && pick.reason === 'none') return this.rejectModel(t, r, accounts);
          if (!pick.ok) return; // 刚才还有空的号，这会儿被占了（或刚进避让）：留在队里，下一轮再派
          if (pick.model !== t.model) t = this.saveThread({ ...(this.thread(t.id) || t), model: pick.model });
          this.noteProbe(pick.account, pick.model);
          created = await this.deps.createSession('codeagent', { ...opts, codeagentRouteModel: pick.model,
            ...(pick.account.pool ? { codeagentAccount: 'pool', codeagentPoolPick: pick.account.key } : {}) });
          this.bridgeLog(`route ${t.id} model=${pick.model} account=${pick.account.pool ? 'pool' : 'personal'}${pick.switchModel ? ' 切默认模型' : ''}`);
        } else {
          const accounts = this.routeAccounts();
          const pick = accounts && accounts.length ? route.pickAnyRoute(accounts, { working: this.workingByAccount(), cap: this.perAccountCap(), only }) : null;
          if (pick && !pick.ok && pick.reason === 'avoid') return; // 刚进避让：留在队里，advance 报排队原因
          // 号池开失败时退回个人账号：个人账号在避让中、或指定的是号池里的号时不退
          const personal = (accounts || []).find(a => a.key === 'personal');
          if (personal && route.avoidFor(personal, '')) fallbackPersonal = false;
          // 挑不出号（读不到账号清单的老环境）时：指定了个人就只开个人；指定了号池里的号就只开那个号，不改成号池自动挑号（2026-10-19）。
          const poolOpts = pick && pick.ok ? (pick.account.pool ? { codeagentAccount: 'pool', codeagentPoolPick: pick.account.key } : null)
            : only === 'personal' ? null
            : only ? { codeagentAccount: 'pool', codeagentPoolPick: only }
            : poolLanes > 0 ? { codeagentAccount: 'pool' } : null;
          if (pick && pick.ok) this.bridgeLog(`route ${t.id} model=(default) account=${pick.account.pool ? 'pool' : 'personal'} active=${pick.account.activeSessions || 0}`);
          if (pick && pick.ok) this.noteProbe(pick.account, '');
          if (poolOpts) {
            try { created = await this.deps.createSession('codeagent', { ...opts, ...poolOpts }); }
            catch (error) { console.warn('[company-bridge] 号池开会话失败，改用个人账号：' + error.message); created = null; }
          }
        }
        if (!created && !t.model) {
          if (!fallbackPersonal) throw new Error(only && only !== 'personal' ? `在指定的${r.account}上没能开会话` : '号池开会话失败，个人账号在避让中，没有可用的号');
          created = await this.deps.createSession('codeagent', opts);
        }
        if (!created || created.id !== sessionId) throw new Error('会话创建结果与预留编号不一致');
        // 开会话要十几秒：期间可能已解除配对。重新读一次，作废了就不再发问题。
        const latest = this.thread(t.id);
        // 这一轮在开会话期间被对端取消了（remote-act.js cancel-queued 给该轮落了 error）：也不再发
        if (!latest || latest.state === 'cancelled' || latest.gen !== this.link.gen() || !stillQueued(latest, r)) { if (latest) this.saveThread({ ...latest, sessionId }); return; }
        t = this.saveThread({ ...latest, sessionId, everAnswered: false });
      } else if (!this.deps.getSession(sessionId)) {
        await this.deps.resumeSession(sessionId);
        if (!this.deps.getSession(sessionId)) throw new Error('原会话没能恢复');
        const latest = this.thread(t.id);
        if (!latest || latest.state === 'cancelled' || latest.gen !== this.link.gen() || !stillQueued(latest, r)) return;
        t = latest;
      }
      const before = this.lastFinal(sessionId);
      const prompt = this.promptFor(t, r, s);
      // 先记下「已派发」和发前最后一条回答，再发：发送结果未知时不会被当成失败重发。
      t = this.patchRound(t, r.round, { sentAt: this.now(), firstSentAt: r.firstSentAt || this.now(), baseline: before ? before.id : null,
        promptFingerprint: receiptPromptFingerprint(prompt), receiptIssue: null, error: null, sendUncertain: null });
      const receipt = await this.deps.sendPrompt(sessionId, prompt, randomUUID());
      // CLI 还没就绪（发送入口等了 60 秒没见到输入框，明确没发）：不判失败，退回排队，隔 15 秒再发，最多等 5 分钟。
      // 2026-10-18 v2.1.10 真机 Q-1017-23 第 13 轮：远程重启后恢复出来的会话启动慢，派发直接报「cli-not-ready」判了失败。
      if (receipt && receipt.notSent && receipt.error === 'cli-not-ready') {
        const since = r.notReadySince && r.notReadySince >= this.bootAt ? r.notReadySince : this.now(); // 上一个进程记的从头算
        if (this.now() - since < NOT_READY_MAX_MS) {
          this.bridgeLog(`cli-not-ready ${t.id}#${r.round} session=${String(sessionId).slice(0, 8)} 已等 ${Math.round((this.now() - since) / 1000)} 秒，${NOT_READY_RETRY_MS / 1000} 秒后再发`);
          this.patchRound(this.thread(t.id) || t, r.round, { sentAt: null, notReadySince: since, retryAt: this.now() + NOT_READY_RETRY_MS });
          if (!r.notReadySince) void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'received', note: '公司会话的 CodeAgent 还没启动就绪（刚重启或启动慢），就绪后自动发出' }).catch(() => {});
          this.changed();
          return;
        }
        throw new Error(`公司会话的 CodeAgent 等了 ${Math.round((this.now() - since) / 60000)} 分钟仍没启动就绪（cli-not-ready），问题没有发出`);
      }
      if (r.notReadySince) this.patchRound(this.thread(t.id) || t, r.round, { notReadySince: null, retryAt: null });
      if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) {
        throw Object.assign(new Error(receipt?.error || '问题没有发进会话'), { notSent: true });
      }
      if (receipt.ok === false || receipt.sendStatus === 'stuck' || receipt.unconfirmed) {
        this.bridgeLog(`send-uncertain ${t.id}#${r.round} session=${String(sessionId).slice(0, 8)} status=${receipt.sendStatus || receipt.error || 'unconfirmed'}`);
        this.patchRound(this.thread(t.id), r.round, { sendUncertain: true });
      }
      if (!r.rewrite) void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'running', note: '公司 CodeAgent 正在处理' }).catch(() => {});
    } catch (error) {
      const fresh = this.thread(t.id) || t;
      this.saveThread({ ...fresh, rounds: fresh.rounds.map(x => x.round === r.round ? { ...x, sentAt: null, error: '公司这边没能开始：' + short(error.message, 160), failedAt: this.now() } : x) });
      if (fresh.gen === this.link.gen()) void this.link.send('status', { thread: t.id, gen: fresh.gen, round: r.round, state: 'error', note: '公司这边没能开始：' + short(error.message, 120) }).catch(() => {});
      this.notify('没能开始', `${t.id}：${short(error.message, 80)}`, fresh.sessionId);
    }
    this.changed();
  }

  async collect(t) {
    const r = t.rounds.find(x => roundPhase(x) === 'running');
    if (!r) { this.saveThread(t); return; }
    // 公司 Hub 远程重启前中断的轮次：等 hub-admin 恢复会话、发「继续」后再收（期间会话关着，不能按「会话已关闭」判失败）。
    if (r.resumePending) return;
    // 额度感知（2026-10-18）：这一轮发出后，会话所在的号撞到额度 / 限流报错 → 不判失败，换号新开会话重做一次；
    // 重做的那次又撞到就不再换（不循环），如实报回。会话还在自己重试也不等它（旧会话不动，保温规则照常收）。
    // 换号前先确认旧会话停下了（审核 2026-10-18）：还在忙（CodeAgent 可能在自己重试）就等 REHOME_GRACE_MS；
    // 等的过程中它自己重试成功、写出了回答，就不换号，照常收这份回答（避免两个号同时答同一题）。
    const hit = this.settings().quotaGuard !== false ? this.quota.hitFor(t.sessionId, activeSince(r)) : null;
    if (hit && !(r.quotaHitIgnored && r.quotaHitIgnored >= hit.at)) {
      const after = this.lastFinal(t.sessionId);
      const recovered = after && after.id !== r.baseline && (!after.timestamp || after.timestamp > hit.at) && String(after.text || '').trim() && !/^\s*API\s*Error/i.test(String(after.text || ''));
      if (recovered) {
        t = this.patchRound(t, r.round, { quotaHitIgnored: hit.at });
        this.bridgeLog(`rehome-skip ${t.id}#${r.round} 撞额度后原会话自己答出来了，不换号`);
      } else {
        if (this.sessionBusy(t.sessionId) && this.now() - hit.at < REHOME_GRACE_MS) return;
        // 模型配置有误的当场兜底（2026-10-22 用户）：先在同一个会话里用 /model 切到这个号权限清单里的模型，切成了就把这一轮重发一次。
        // 每轮只试一次；会话在忙、没有可换的模型、或切不动时，照旧走下面的换号 / 报错。
        if (hit.kind === 'model-config' && await this.fixModelInSession(t, r, hit)) return;
        // 模型配置有误、又没有别的号能接这一题：不换号重做（换了也只会排队 6 小时），直接如实报回并给出修法（审核 2026-10-19）
        if (hit.kind === 'model-config' && !this.otherAccountUsable(t, hit.key)) {
          return this.failRound(t, r, this.scrubText(this.modelConfigFailText(hit.key, hit.model)));
        }
        if ((Number(r.rehomed) || 0) >= MAX_REHOME) {
          const alias = this.aliasOf(hit.key);
          const why = (r.rehome && r.rehome.kind === 'model-config') ? '模型配置有误' : '额度';
          return this.failRound(t, r, this.scrubText(`这一轮已经因${why}换过一次号，换到${alias}重做后，${alias}也撞到了${Q.KINDS[hit.kind] || '额度上限'}（${hit.text}）；按规则只换号重做一次，这一轮不再换号。等号恢复后可在「AI特战队专用功能」里点重试，或追问重问`));
        }
        this.rehome(t, r, { why: Q.KINDS[hit.kind] || '额度上限', fromKey: hit.key, hit });
        return;
      }
    }
    // 会话停在选择菜单上等人选：这一轮报「卡在选择题」，不再干等（只读屏幕，不发按键）
    if (await this.watchChoice(t, r)) return;
    if (this.sessionBusy(t.sessionId)) return;
    const since = activeSince(r);
    const final = this.lastFinal(t.sessionId);
    // Hub 重启打断的在途轮次（2026-10-21 同事公司 Hub：三天重启 11 次，4 轮在重启后被判「会话已关闭，没有读到回答」）：
    // 重启前发出、不是远程重启后自动接着做的那种（那种有 resumePending / resumedAt，归 hub-admin.js），按问题文本从原生记录补收一次。
    if (r.restartChecked !== this.bootAt && since < this.bootAt && !(final && final.id !== r.baseline) && !this.roundResuming(t, r)) {
      if (await this.recoverAfterRestart(t, r)) return;
      t = this.thread(t.id) || t;
    }
    // 发出结果未知、3 分钟后会话停着而原生记录文件都还没有：CodeAgent 确实没收到，重发一次（不会重复）。
    // 重发前先查一遍记录：只是慢（提问已经落进记录、还没开工）的不重发（2026-10-18 v2.1.9 验收：重发的那一份和卡在输入框里的
    // 第一份一起提交，回执核对随之卡住，见 receipt-reader.js repeatedCopy）。
    if (!final && r.sendUncertain && !r.resent && this.now() - r.sentAt > 3 * 60000) {
      const meta = this.deps.getSession(t.sessionId) || {};
      const missing = !meta.transcriptPath || !(this.deps.fileExists ? this.deps.fileExists(meta.transcriptPath) : require('node:fs').existsSync(meta.transcriptPath));
      if (missing) {
        if (this.requestLanded(t, r) === true) t = this.patchRound(t, r.round, { landed: true, sendUncertain: null });
        else { this.bridgeLog(`resend ${t.id}#${r.round} 发送结果未知且记录文件不在`); this.patchRound(t, r.round, { sentAt: null, resent: true, sendUncertain: null }); return; }
      }
    }
    if (!final || final.id === r.baseline) {
      // 发出 3 分钟后会话停着、还没有回答：核实提问真的写进了记录（Q-1016-02 第 5 轮发给了已退出的 CodeAgent，干等 30 分钟）。
      // 没写进去就重发一次（dispatch 会按需恢复会话）；重发后仍没写进去，直接报出来。
      if (!r.landed && this.now() - r.sentAt > VERIFY_MS) {
        const landed = this.requestLanded(t, r);
        if (landed === true) t = this.patchRound(t, r.round, { landed: true });
        else if (landed === false) {
          if (!r.resent) {
            this.bridgeLog(`resend ${t.id}#${r.round} 发出 ${Math.round((this.now() - r.sentAt) / 1000)} 秒后记录里没有这条提问${r.sendUncertain ? '（发送时未确认）' : ''}`);
            this.patchRound(t, r.round, { sentAt: null, resent: true, sendUncertain: null });
            this.notify('提问没送进去，重发一次', `${t.id} 第 ${r.round} 轮：发出 3 分钟后 CodeAgent 的记录里还没有这条提问`, t.sessionId);
            return;
          }
          return this.failRound(t, r, '提问没能送进公司的 CodeAgent（重发一次后它的记录里仍没有这条提问）；可在「AI特战队专用功能」里点重试，或追问重发');
        }
      }
      // 绑定的记录里没有新回答：可能是会话身份没绑上（hook 没到），或休眠后恢复的 CLI 换了记录文件（2026-10-21 同事公司 Hub，
      // 「会话停下了，但一直没读到回答」、Q-1020-06 答完 20 分钟没送回）。按这一轮的问题在同号同工作目录的记录里找。
      if (this.now() - r.sentAt > VERIFY_MS) {
        const found = this.findByQuestion(t, r);
        if (found && found.finished && found.text && this.now() - found.mtime > FOUND_QUIET_MS) {
          this.bridgeLog(`found-by-question ${t.id}#${r.round} 绑定的记录里没有新回答，按问题在 ${require('node:path').basename(found.file)} 里找到`);
          return this.sendFound(t, r, found, { allowRewrite: true });
        }
        if (found && this.now() - found.mtime < NO_ANSWER_MS && this.now() - r.sentAt < LONG_RUN_MS) return; // 别的记录文件还在写：还在干活
      }
      // CodeAgent 的原生记录还在写就是还在干活（长时间的编译、仿真）：会话表里查不到、或停摆超过 30 分钟都先别判失败，
      // 最多等 LONG_RUN_MS（2026-10-17 Q-1017-17/21：跑 AirView 的会话还在运行，10 分钟就被判成「会话已关闭」）。
      if (this.now() - r.sentAt < LONG_RUN_MS && this.transcriptFresh(t.sessionId)) return;
      // 远程重启后恢复、发了「继续」的轮次从恢复时间算（activeSince）。
      if (this.now() - since > NO_ANSWER_MS && !this.deps.getSession(t.sessionId)) return this.failRound(t, r, '会话已关闭，没有读到回答');
      if (this.now() - since > NO_ANSWER_MS * 3) return this.failRound(t, r, '会话停下了，但一直没读到回答');
      return;
    }
    if (this.promptCheck(t, r) === 'hijacked') {
      const n = (r.hijacked || 0) + 1;
      if (n > MAX_HIJACK) return this.failRound(t, r, '问题连续被公司电脑剪贴板里的图片顶掉（CodeAgent 粘贴时会读剪贴板）：清空剪贴板后在「AI特战队专用功能」里点重试');
      this.patchRound(t, r.round, { sentAt: null, hijacked: n });
      this.notify('问题被剪贴板图片顶掉', `${t.id}：CodeAgent 收到的图片与本轮任务不符；已保留记录并重新发问`, t.sessionId);
      return;
    }
    let receipt = null;
    if (this.deps.readReceipt) {
      const session = this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId);
      try { receipt = this.deps.readReceipt(session, { ...r, threadId: t.id }); }
      catch (error) { receipt = { available: false, issue: '原生回执核对失败：' + error.message }; }
      if (!receipt?.available) {
        const issue = receipt?.issue || '本次请求的原生回执尚未核对';
        if (this.now() - since > NO_ANSWER_MS * 3) return this.failRound(t, r, issue);
        if (r.receiptIssue !== issue) {
          this.bridgeLog(`receipt-pending ${t.id}#${r.round} ${issue}`);
          this.patchRound(t, r.round, { receiptIssue: issue });
          this.notify('回执待核对', `${t.id}：${issue}；记录已保留，稍后会继续核对`, t.sessionId);
          void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'running', note: '回执待核对：' + issue }).catch(() => {});
          this.changed();
        }
        return;
      }
      if (r.receiptIssue) t = this.patchRound(t, r.round, { receiptIssue: null });
    }
    let text = String(receipt ? (Array.isArray(receipt.parts) && receipt.parts.length ? fitReply(receipt.parts) : receipt.text) : final.text || '').trim();
    if (sourceVerdict(text).tooMuch && !r.rewriteAsked) {
      // 第一次发现成段源码：请它自己改写（同一会话），改写稿出来再发。
      this.patchRound(t, r.round, { rewriteAsked: true, rewrite: true, sentAt: null, firstDraftChars: text.length });
      return;
    }
    await this.sendReply(t, r, text, receipt ? { userMessageId: receipt.userMessageId, sourceMessageIds: receipt.records.map(record => record.messageId) } : {});
  }
  // 会话原生记录里最后一条回答的模型（读不到返回空串）。
  answerModel(meta) {
    if (!meta || !this.deps.lastAnswerModel) return '';
    try { return String(this.deps.lastAnswerModel(meta) || '').trim(); } catch { return ''; }
  }
  // 把一轮的回答发回家：删超限的源码、截长、核对代次，落账和入发件箱同一个事务。collect 和补收共用。
  async sendReply(t, r, text, extraMeta = {}) {
    let removed = 0;
    if (sourceVerdict(text).tooMuch) {
      // 先删成段的；零散的小段累计仍超限，就把所有代码行都换掉。
      const first = stripCode(text, 3); text = first.text; removed = first.removed;
      if (sourceVerdict(text).tooMuch) { const second = stripCode(text, 0); text = second.text; removed += second.removed; }
    }
    if (text.length > MAX_REPLY_CHARS) text = text.slice(0, MAX_REPLY_CHARS) + `\n\n（回答超过 ${MAX_REPLY_CHARS} 字，后面截掉了；需要的话请追问后半部分。）`;
    // 发送前再核对代次：解除配对后答完的旧问题不会发给新的对端。
    const fresh = this.thread(t.id);
    if (!fresh || fresh.state === 'cancelled' || fresh.gen !== this.link.gen()) return;
    const session = this.deps.getSession(t.sessionId);
    // 先从会话原生记录读一次最后一条回答的模型：会话元数据里的实际模型由 main.js observeCodeAgentModel 异步补记，
    // 回执可能赶在它前面（2026-10-18 用户反馈 v2.1.11：DS 号的回答被标成 GLM / 只写「CodeAgent 当前模型」）。
    const answered = this.answerModel(session || this.deps.getSessionMetadata?.(t.sessionId));
    // 家里指定了模型的：另记指定的和回答里实际出现的模型，家里据此提示「指定 X、实际 Y」（不一致时）。
    // 没指定、却落在为通道切过模型的号上（session-manager codeagentLaunchModel）：也写明实际模型，免得家里以为用的是默认。
    const actual = answered || session?.codeagentActualModel || null;
    const routed = t.model ? { requestedModel: t.model, actualModel: actual }
      : session?.codeagentLaunchModel ? { actualModel: actual || session.codeagentLaunchModel } : {};
    // 哪个号作答（只用代称）、对端指定的号、因额度中断从哪个号换过来（额度感知，2026-10-18）。
    const accountKey = this.sessionAccountKey(t.sessionId);
    const accountMeta = { ...(accountKey ? { accountAlias: this.aliasOf(accountKey) } : {}), ...(r.account || r.requestedAccount ? { requestedAccount: r.account || r.requestedAccount } : {}),
      ...(r.rehome ? { rehomedFrom: r.rehome.from || null, rehomeKind: r.rehome.kind || null } : {}) };
    const meta = { model: answered || session?.currentModel?.id || session?.model || null, ...routed, ...accountMeta, elapsedSec: Math.round((this.now() - (r.firstSentAt || r.sentAt || r.receivedAt || this.now())) / 1000), codeLinesRemoved: removed, rewritten: !!r.rewriteAsked, ...extraMeta };
    // 回答落账和回执入发件箱放在同一个事务：要么都成，要么都不成（下一轮再收）。之后发件箱负责重发。
    // 每份回执带一份最新的模型表（家里据此更新本地存的那份）。
    const models = this.modelTableSafe();
    const item = this.link.prepare('reply', { thread: t.id, gen: fresh.gen, round: r.round, text, meta, ...(models ? { models } : {}) });
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.link.enqueue(item);
      this.saveThread({ ...fresh, everAnswered: true, rounds: fresh.rounds.map(x => x.round === r.round ? { ...x, reply: text, replyAt: this.now(), meta, error: null } : x) });
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      if (!r.queueFullNotified) { this.patchRound(fresh, r.round, { queueFullNotified: true }); this.notify('回执发不出去', `${t.id}：${short(error.message, 80)}`, t.sessionId); }
      return;
    }
    await this.link.flush().catch(() => {});
    const pending = (this.store.get('outbox') || []).some(x => x.mid === item.mid);
    this.notify(pending ? '回执待发送' : '已回执', pending
      ? `${t.id} 第 ${r.round} 轮已保存；连接恢复后会自动发送。`
      : `${t.id} 第 ${r.round} 轮：${short(text, 60)}`, t.sessionId);
  }
  // 家里要求「补收」（2026-10-16）：这一轮报了没答上或迟迟没回执，但公司会话里其实写了回答——直接把这一轮发出之后
  // 最新的那条回答取回，不让 CodeAgent 重答。已经有回答的，原样再发一次（家里可能没收到）。取回的文字开头注明来历。
  async recollect(message) {
    const t = this.thread(String(message.thread || ''));
    if (!t || t.state === 'cancelled' || t.gen !== this.link.gen() || (message.gen && message.gen !== t.gen)) return;
    const r = t.rounds.find(x => x.round === Number(message.round));
    if (!r) return;
    if (r.reply) return this.sendReply(t, r, r.reply, { ...(r.meta || {}), resentReply: true });
    // 公司 Hub 刚重启、这一轮正在自动接着做（2026-10-18 v2.1.10 真机 Q-1017-23 第 12 轮）：补收不判失败、轮次保持在途。
    // 以前回「补收不到」，家里把这一轮判成没答上、整题重发一遍，和恢复后的「继续」撞在同一个会话里。
    if (this.roundResuming(t, r)) {
      void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'running', note: '公司 Hub 刚重启，这一轮正在自动接着做，回执到了会照常发回，不用重问' }).catch(() => {});
      return;
    }
    if (t.sessionId && this.sessionBusy(t.sessionId)) {
      void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'running', note: '补收：公司会话还在作答，答完会照常回执' }).catch(() => {});
      return;
    }
    const meta = t.sessionId && (this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId));
    // 2026-10-21 起先按这一轮发出的问题在原生记录里定位（不靠内存状态，Hub 重启后照样能补收）：
    // 1) 绑定的记录里能逐条核对到（readReceipt）→ 取这一轮的全部回答；
    // 2) 按问题文本在同号同工作目录的记录里找到、且已收尾 → 取它之后的全部回答；没收尾的如实说「没写完」；
    // 3) 记录里找不到这一轮的问题，才退回老办法：取这一轮发出之后的最新回答（注明没核对归属）。
    let receipt = null;
    if (meta && this.deps.readReceipt) { try { receipt = this.deps.readReceipt(meta, { ...r, threadId: t.id }); } catch { receipt = null; } }
    if (receipt && receipt.available) {
      const text = Array.isArray(receipt.parts) && receipt.parts.length ? fitReply(receipt.parts) : String(receipt.text || '');
      this.notify('补收', `${t.id} 第 ${r.round} 轮：已从公司会话记录核对取回这一轮的回答`, t.sessionId);
      return this.sendReply(this.thread(t.id) || t, r, '（补收：按这一轮的问题在公司会话记录里核对到的回答，原样取回。）\n\n' + text.trim(),
        { recollected: true, userMessageId: receipt.userMessageId, sourceMessageIds: (receipt.records || []).map(x => x.messageId) });
    }
    const found = this.findByQuestion(t, r, { force: true });
    if (found && found.finished && found.text) {
      this.notify('补收', `${t.id} 第 ${r.round} 轮：已按问题从公司会话记录取回这一轮的回答`, t.sessionId);
      return this.sendFound(t, r, found, { note: '（补收：按这一轮的问题在公司会话记录里找到的回答，原样取回。）' });
    }
    if (found) {
      const written = found.parts.reduce((n, p) => n + p.text.length, 0);
      const writing = this.now() - found.mtime < RESTART_WRITING_MS && !!this.deps.getSession(t.sessionId);
      void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: writing ? 'running' : 'error', note: writing
        ? '补收：公司会话记录里这一轮的回答还在写，答完会照常回执'
        : `补收不到完整回答：公司会话记录里找到了这一轮的问题，但回答没写完（${written ? `之后写了 ${written} 字、没有最终回答` : '之后还没写回答'}），可以追问让它接着做，或重问` }).catch(() => {});
      return;
    }
    const since = (r.firstSentAt || r.sentAt || r.receivedAt || 0) - 5000;
    const finals = meta && this.deps.readFinals ? this.deps.readFinals(meta) : [];
    const latest = [...(finals || [])].reverse().find(f => (f.timestamp || 0) >= since && f.id !== r.baseline);
    if (!latest) {
      void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'error', note: '补收不到：公司会话里这一轮发出之后没有新的回答，可以追问重问' }).catch(() => {});
      return;
    }
    const note = '（补收：这是公司会话在这一轮发出之后写下的最新回答，按家里要求直接取回，没有逐条核对它对应哪条提问。）';
    this.notify('补收', `${t.id} 第 ${r.round} 轮：已从公司会话取回最新回答`, t.sessionId);
    return this.sendReply(this.thread(t.id) || t, r, note + '\n\n' + String(latest.text || '').trim(), { recollected: true });
  }
  // 按这一轮发出的问题在原生记录里找回答（receipt-reader.js findRoundAnswer）：不靠会话身份绑定和内存状态。
  // 同一轮 FIND_EVERY_MS 内重复调用返回上次的结果（要读整份记录）；force 时现读。
  findByQuestion(t, r, { force = false } = {}) {
    if (!t || !r || !t.sessionId || !(r.sentAt || r.firstSentAt)) return null;
    const memo = this.findMemo || (this.findMemo = new Map());
    const key = t.id + '#' + r.round + '#' + (r.sentAt || '') + '#' + (r.promptFingerprint || '');
    const prev = memo.get(key);
    if (!force && prev && this.now() - prev.at < FIND_EVERY_MS) return prev.found;
    const meta = this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId) || null;
    let found = null;
    if (meta) {
      try { found = (this.deps.findRoundAnswer || require('./receipt-reader').findRoundAnswer)(meta, { ...r, threadId: t.id }); } catch (e) { found = null; this.bridgeLog(`find-by-question ${t.id}#${r.round} 读记录出错：${short(e.message, 120)}`); }
    }
    if (memo.size > 200) memo.clear();
    memo.set(key, { at: this.now(), found });
    return found;
  }
  // 发回按问题找到的回答（collect 兜底、重启补收、家里补收共用）。allowRewrite：成段源码先请它改写（同 collect）。
  async sendFound(t, r, found, { note = '', allowRewrite = false, ...extra } = {}) {
    const text = fitReply(found.parts && found.parts.length ? found.parts : [{ text: found.text }]).trim();
    if (allowRewrite && sourceVerdict(text).tooMuch && !r.rewriteAsked) {
      this.patchRound(t, r.round, { rewriteAsked: true, rewrite: true, sentAt: null, firstDraftChars: text.length });
      return;
    }
    return this.sendReply(this.thread(t.id) || t, r, note ? note + '\n\n' + text : text, { foundBy: 'question', ...(note ? { recollected: true } : {}), ...extra });
  }
  // 重启前发出的在途轮次（recoverAfterRestart 只对每个进程每轮做一次）：答完整的照常回执；没答完的标失败、写明重启打断；
  // 记录里找不到这一轮的问题（或不知道记录在哪）就交回原有流程（核实提问、重发、超时判失败）。返回 true 表示已处理或要再等。
  async recoverAfterRestart(t, r) {
    const open = !!this.deps.getSession(t.sessionId);
    // 会话被重新打开了：CLI 刚起来状态还没报上来，先等启动宽限
    if (open && this.now() - this.bootAt < STARTUP_GRACE_MS) return true;
    const found = this.findByQuestion(t, r, { force: true });
    if (found && found.finished && found.text) {
      this.bridgeLog(`restart-recollect ${t.id}#${r.round} 重启前答完的回答按问题从原生记录补收`);
      await this.sendFound(t, r, found, { restartRecovered: true });
      return true;
    }
    if (found) {
      if (open && this.now() - found.mtime < RESTART_WRITING_MS) return true; // 重新打开的会话还在往记录里写
      const written = found.parts.reduce((n, p) => n + p.text.length, 0);
      this.bridgeLog(`restart-interrupted ${t.id}#${r.round} 重启前没答完（已写 ${written} 字）`);
      this.failRound(this.thread(t.id) || t, r, `Hub 重启打断，回答没写完（公司会话记录里找到了这一轮的问题，${written ? `之后写了 ${written} 字、没写出最终回答` : '之后还没写回答'}）；家里可以重问`);
      return true;
    }
    this.patchRound(t, r.round, { restartChecked: this.bootAt });
    return false;
  }
  // 这一轮是不是「重启中断、正在自动接着做」（hub-admin.js）：还没恢复（标着待恢复，或恢复清单里待处理 / 恢复中），
  // 或已恢复并发了「继续」、之后还没写出新回答，且仍在收回执的等待窗口里（原生记录还在写最多 LONG_RUN_MS，否则同 collect 的 NO_ANSWER_MS×3）。
  // 恢复失败的轮次已按失败流程落了 error，不算。
  roundResuming(t, r) {
    if (!r || r.reply || r.error) return false;
    if (r.resumePending) return true;
    let plan = null; try { plan = this.hubAdmin.state().resumeAfterRestart; } catch { plan = null; }
    if (plan && (plan.items || []).some(x => x.kind === 'bridge' && x.thread === t.id && x.round === r.round && x.state !== 'failed' && x.state !== 'resumed')) return true;
    if (!r.resumedAt) return false;
    const meta = t.sessionId && (this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId));
    let finals = [];
    try { finals = meta && this.deps.readFinals ? this.deps.readFinals(meta) || [] : []; } catch { finals = []; }
    if (finals.some(f => (f.timestamp || 0) >= r.resumedAt - 5000 && f.id !== r.baseline)) return false; // 恢复后已写出回答：照常补收
    const since = this.now() - r.resumedAt;
    if (since < NO_ANSWER_MS * 3) return true;
    return since < LONG_RUN_MS && (this.sessionBusy(t.sessionId) || this.transcriptFresh(t.sessionId));
  }
  // 提问是否已落进 CodeAgent 的原生记录：true / false / null（不知道记录在哪，不下结论）。
  requestLanded(t, r) {
    const meta = this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId);
    try { return (this.deps.transcriptHasRequest || transcriptHasRequest)(meta, { ...r, threadId: t.id }); } catch { return null; }
  }
  // 通道的重发等决定留一行日志（logs/company-bridge.log）：事后能看出是哪条规则触发的。
  bridgeLog(line) { this.appendLog('company-bridge.log', line); }
  // ok：收到的消息里有本题编号；hijacked：这一轮之后只收到过带图片、却没有编号的消息；unknown：读不到记录，照旧处理。
  promptCheck(t, r) {
    const meta = this.deps.getSession(t.sessionId) || this.deps.getSessionMetadata?.(t.sessionId) || {};
    if (!meta.transcriptPath) return 'unknown';
    const turns = (this.deps.readUserTurns || userTurnsFromTranscript)(meta.transcriptPath).filter(u => u.at >= (r.sentAt || 0) - 5000);
    if (turns.some(u => u.text.includes('编号 ' + t.id))) return 'ok';
    return turns.some(u => u.images > 0) ? 'hijacked' : 'unknown';
  }
  // 在途轮次的会话是不是停在选择菜单上（core/choice-menu-screen.js）。同一道题连续出现 CHOICE_STABLE_MS 才判定；
  // 判定后这一轮落 error（对端据此可以追问给出选择，或用 retry 重做，都新开会话接着做，见 advance）。返回 true 表示已处理。
  async watchChoice(t, r) {
    if (this.settings().choiceDetect === false || !this.deps.readTerminalScreen || !t.sessionId || !this.deps.getSession(t.sessionId)) return false;
    const memo = this.choiceMemo || (this.choiceMemo = new Map());
    const prev = memo.get(t.sessionId);
    const now = this.now();
    if (prev && prev.round === r.round && now - prev.checkedAt < CHOICE_CHECK_MS) return false;
    let menu = null, sig = '';
    try {
      const raw = await this.deps.readTerminalScreen(t.sessionId);
      if (raw && raw.text) {
        sig = raw.text.length + ':' + createHash('sha1').update(raw.text.slice(-6000)).digest('hex');
        if (prev && prev.sig === sig) menu = prev.menu;
        else {
          if (!this.choiceRules || now - this.choiceRules.at > 60000) this.choiceRules = { at: now, ...choiceMenu.loadRules(this.deps.dataDir) };
          const rows = await (this.deps.renderRows || require('../hub-phone/session-chat').renderRows)(raw);
          menu = choiceMenu.detectChoiceMenu(rows, this.choiceRules.rules);
        }
      }
    } catch { menu = null; }
    const key = menu ? JSON.stringify([menu.question, menu.options.map(o => o.label)]) : '';
    const since = menu && prev && prev.round === r.round && prev.key === key && prev.since ? prev.since : menu ? now : null;
    const noted = prev && prev.round === r.round && prev.key === key ? prev.noted : false;
    memo.set(t.sessionId, { round: r.round, sig, menu, key, since, checkedAt: now, noted });
    if (!menu || now - since < CHOICE_STABLE_MS) return false;
    // 工具权限确认不是选择题：先只在进度说明里写「等待权限确认」，停满 PERMISSION_STABLE_MS 才按卡住处理
    if (menu.kind === 'permission' && now - since < PERMISSION_STABLE_MS) {
      if (!noted) {
        memo.get(t.sessionId).noted = true;
        const q = Q.redactSnippet(menu.question, { scrub: x => this.scrubText(x) }).slice(0, 200);
        this.bridgeLog(`permission-wait ${t.id}#${r.round} session=${String(t.sessionId).slice(0, 8)}`);
        void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'running',
          note: `等待权限确认：公司 CodeAgent 停在一个工具权限确认上（${q || '没认出题目'}），没有替它选；停满 ${PERMISSION_STABLE_MS / 60000} 分钟仍没人处理会报回这一轮` }).catch(() => {});
      }
      return false;
    }
    memo.delete(t.sessionId);
    this.markChoiceStuck(t, r, menu);
    return true;
  }
  markChoiceStuck(t, r, menu) {
    const secrets = this.accountSecrets();
    const clean = s => Q.redactSnippet(s, { scrub: x => this.scrubText(x, secrets) });
    const question = clean(menu.question).slice(0, 300);
    const options = menu.options.slice(0, 9).map(o => `${o.key}. ${clean(o.label).slice(0, 120)}`);
    const permission = menu.kind === 'permission';
    const why = permission
      ? `卡在权限确认：公司 CodeAgent 停在一个工具权限确认上超过 ${PERMISSION_STABLE_MS / 60000} 分钟，这一轮没有作答（没有替它选）。题目：${question || '（没认出题目）'}；选项：${options.join(' / ')}。`
        + '可以追问说明怎么处理（公司新开会话、带上原问题接着做），或用远程维护的 retry 重做这一轮'
      : `卡在选择题：公司 CodeAgent 停在一个选择菜单上等人选，这一轮没有作答（没有替它选）。题目：${question || '（没认出题目）'}；选项：${options.join(' / ')}。`
        + '可以追问给出你的选择（公司新开会话、带上原问题和这道题接着做），或用远程维护的 retry 重做这一轮';
    const fresh = this.thread(t.id) || t;
    this.saveThread({ ...fresh, choiceStuckSession: t.sessionId,
      rounds: fresh.rounds.map(x => x.round === r.round ? { ...x, error: why, failedAt: this.now(), choiceStuck: { at: this.now(), kind: permission ? 'permission' : 'question', question, options } } : x) });
    this.bridgeLog(`${permission ? 'permission-stuck' : 'choice-stuck'} ${t.id}#${r.round} session=${String(t.sessionId).slice(0, 8)} options=${options.length}`);
    void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'error', note: why }).catch(() => {});
    this.notify(permission ? '卡在权限确认' : '卡在选择题', `${t.id}：${short(question, 60)}`, t.sessionId);
    this.changed();
  }
  failRound(t, r, why) {
    this.patchRound(t, r.round, { error: why, failedAt: this.now() });
    void this.link.send('status', { thread: t.id, gen: t.gen, round: r.round, state: 'error', note: why }).catch(() => {});
    this.notify('没答上', `${t.id}：${why}`, t.sessionId);
  }
  // 页面上点「重试」：失败的那一轮重新排队（同一会话还在就续用）。
  retry(id) {
    const t = this.thread(id);
    if (!t) throw new Error('找不到这个问题');
    if (t.state === 'cancelled' || t.gen !== this.link.gen()) throw new Error('这个问题属于上一次配对，已作废');
    // 额度中断换号重做过的（rehomed）重新给一次换号机会
    const rounds = t.rounds.map(x => x.error && !x.reply ? { ...x, error: null, sentAt: null, failedAt: null, baseline: null, hijacked: 0, notReadySince: null, retryAt: null, rehomed: 0 } : x);
    this.saveThread({ ...t, rounds }); this.changed();
    void this.tick({ force: true });
    return this.status();
  }

  pairingSafe(t, aliases) { try { return this.pairingOf(t, null, { aliases, memoryOnly: true }); } catch { return null; } }
  status() {
    const c = this.link.config(), st = this.link.status();
    let aliases; try { aliases = this.aliasTable(); } catch { aliases = new Map(); }
    return {
      ok: true, role: 'company', unlocked: this.unlocked(), settings: this.settings(), defaultInstructions: DEFAULT_INSTRUCTIONS, parallel: this.parallelLimitSafe(),
      link: { state: c.state || 'none', baseUrl: c.baseUrl || null, pairedAt: c.pairedAt || null, createdAt: c.createdAt || null, outbox: this.link.pendingOutbox() },
      net: { lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, gate: st.gate || null, peerSeen: st.peerSeen || null, autoGate: this.gatePass.status() },
      nextPullAt: this.nextPullAt, now: this.now(), polling: this.polling(),
      threads: this.threads().map(t => ({ ...t, pairing: this.pairingSafe(t, aliases), session: t.sessionId ? { open: !!this.deps.getSession(t.sessionId), busy: this.sessionBusy(t.sessionId) } : null })),
      askHome: this.askHome.status(),
      images: this.images.status(),
      care: this.careState || null,
      hubAdmin: this.hubAdmin.status(),
      models: this.modelTableSafe(),
      quota: this.quotaStatus(),
    };
  }
  // 额度识别的概况（设置页、号池页签显示）：规则条数、规则文件、写错的规则、最近识别到的报错条数。
  quotaStatus() {
    try {
      const loaded = Q.loadRules(this.deps.dataDir);
      return { on: this.settings().quotaGuard !== false, rules: loaded.rules.map(r => ({ id: r.id, kind: r.kind, builtin: r.builtin, origin: r.origin })), ruleErrors: loaded.errors,
        file: loaded.file, errors: (this.store.get('quotaErrors') || []).length };
    } catch (error) { return { on: this.settings().quotaGuard !== false, error: error.message }; }
  }
  // quiet：只在界面上给一条轻提示，不弹系统通知（对端直查这类不需要人处理的事，diag.js）。
  notify(title, text, sessionId = null, { quiet = false } = {}) { try { this.deps.onNotify?.({ title: 'AI特战队 · ' + title, text, sessionId, ...(quiet ? { quiet: true } : {}) }); } catch {} }
  changed() { try { this.deps.onChanged?.(); } catch {} }
  close() { clearInterval(this.timer); this.timer = null; this.askHome.close(); try { this.store.close(); } catch {} }
}

module.exports = { NOT_READY_RETRY_MS, NOT_READY_MAX_MS, CompanyBridge, DEFAULT_INSTRUCTIONS, V1_INSTRUCTIONS, V2_INSTRUCTIONS, V3_INSTRUCTIONS, PURPOSE, userTurnsFromTranscript, sourceVerdict, stripCode, deriveState };
