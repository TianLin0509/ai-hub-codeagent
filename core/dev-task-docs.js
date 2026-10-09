'use strict';
/*
 * 开发群聊 · 阶段交接文档（MD 改名交付）
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 为什么要有这个模块：
 *   引擎原本把「某次 CLI 回复结束」当成「本开发步骤完成」。可 agent 在一步里会回很多次话 ——
 *   你插一句它答「收到」、它中途报 UPDATE、跑测试时转录静默被 idle timer 提前结算……
 *   任何一次都可能被误读成交付。允许用户随时插话之后，这个前提彻底不成立了。
 *
 *   所以交付需要一个**由 agent 明确做出、Hub 能独立核验、且不可能被聊天噪声碰巧触发**的动作。
 *   选的是文件改名：agent 把本阶段手册写完、存盘、关掉，再重命名成「已完成-…」。
 *   改名是原子的，不像「持续往完成文件里追加」那样能把半成品冒充成交付。
 *
 * 目录与命名（与任务书一致，统一短横线，不用 Windows 文件名禁止的冒号）：
 *   <Hub 数据目录>\task-docs\<meetingId>\
 *     开题报告.md            → 已完成-开题报告.md
 *     阶段1协作手册.md       → 已完成-阶段1协作手册.md      （实现位写）
 *     阶段1合并手册.md       → 已完成-阶段1合并手册.md      （合并位写）
 *     阶段2协作手册.md       → …
 *
 * 步骤位置 pos 是唯一的推导源，轮次、角色、预期文件名全从它算：
 *   0 开题 → 1 实现1 → 2 审查1 → 3 实现2 → 4 审查2 …
 * 不另存一份「当前阶段名」，免得 UI 显示和后端事实各说各话。
 *
 * 放在 Hub 数据目录而不是仓库里：任务目录按群隔离（同名文件不能证明身份），
 * 也不会在生产仓库根目录不断制造未跟踪文件。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KIND_KICKOFF = 'kickoff';
const KIND_BUILD = 'build';
const KIND_REVIEW = 'review';

const DONE_PREFIX = '已完成-';

// 空文件、只写了个标题的草稿都不算交付（任务书 B01）。40 字是「一句正经的交接都写不下」
// 的下限，不是质量判据 —— 质量由独立审查负责，这里只挡明显的半成品。
const MIN_DELIVERY_CHARS = 40;

// 文件被编辑器占用时 Windows 会抛 EBUSY/EPERM/EACCES。有界重读，读不到就保留阶段
// 等下一次检查，不判任务失败（任务书 B05）。
const TRANSIENT_READ_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const READ_RETRIES = 3;
const READ_RETRY_DELAY_MS = 120;

function taskDocsRoot(hubDataDir) {
  return path.join(String(hubDataDir || ''), 'task-docs');
}

/** 每群一个稳定目录。用 meetingId 而不是标题：标题会改，也可能重名。 */
function taskDocsDir(hubDataDir, meetingId) {
  return path.join(taskDocsRoot(hubDataDir), String(meetingId || ''));
}

function ensureTaskDocsDir(hubDataDir, meetingId) {
  const dir = taskDocsDir(hubDataDir, meetingId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** pos → 这一步是谁、第几轮、写哪个文件。pos 非法时返回 null。 */
function docSpecForPos(pos) {
  const n = Number(pos);
  if (!Number.isInteger(n) || n < 0) return null;
  if (n === 0) {
    return {
      pos: 0, kind: KIND_KICKOFF, role: 'kickoff', round: 0, stageLabel: '开题',
      draft: '开题报告.md', done: DONE_PREFIX + '开题报告.md',
    };
  }
  const round = Math.ceil(n / 2);
  if (n % 2 === 1) {
    const draft = '阶段' + round + '协作手册.md';
    return { pos: n, kind: KIND_BUILD, role: 'builder', round, stageLabel: '实现 · 第' + round + ' 轮', draft, done: DONE_PREFIX + draft };
  }
  const draft = '阶段' + round + '合并手册.md';
  return { pos: n, kind: KIND_REVIEW, role: 'reviewer', round, stageLabel: '审查 · 第' + round + ' 轮', draft, done: DONE_PREFIX + draft };
}

/** 循环引擎按「第几轮 + 建造还是审查」思考，这里给它换算成 pos。round 从 0 起。 */
function posForLoopStep(round, role) {
  const r = Math.max(0, Number(round) || 0);
  return role === 'reviewer' ? r * 2 + 2 : r * 2 + 1;
}

function fingerprintOf(content) {
  const normalized = String(content == null ? '' : content).replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function sleepBlocking(ms) {
  const until = Date.now() + Math.max(0, ms);
  // 有界忙等：只在 ≤3 次的读取重试上走到，总计不超过 ~360ms。
  while (Date.now() < until) { /* spin */ }
}

/**
 * 读一份预期完成文件。
 * status: ok（拿到可用内容）/ missing（还没改名）/ empty（改了名但是空的或太短）/ unreadable（被占用等）
 * 任何一种都不代表任务失败，只代表「现在还不能接收」。
 */
function readDelivery(dir, fileName, opts = {}) {
  const filePath = path.join(String(dir || ''), String(fileName || ''));
  const retries = Number.isInteger(opts.retries) ? opts.retries : READ_RETRIES;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const content = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      if (content.trim().length < MIN_DELIVERY_CHARS) {
        return { status: 'empty', path: filePath, reason: 'delivery_too_short', size: content.trim().length };
      }
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (statError) { mtimeMs = 0; }
      return {
        status: 'ok',
        path: filePath,
        content,
        fingerprint: fingerprintOf(content),
        size: Buffer.byteLength(content, 'utf8'),
        mtimeMs,
      };
    } catch (error) {
      lastError = error;
      if (error && error.code === 'ENOENT') return { status: 'missing', path: filePath, reason: 'not_renamed_yet' };
      if (!error || !TRANSIENT_READ_CODES.has(error.code) || attempt >= retries) break;
      sleepBlocking(READ_RETRY_DELAY_MS);
    }
  }
  return {
    status: 'unreadable',
    path: filePath,
    reason: (lastError && lastError.code) || 'read_failed',
    detail: (lastError && lastError.message) || '',
  };
}

// 合并手册的裁决行。和群聊里那四行同一个契约，这里只认单独成行的 RESULT。
const RESULT_LINE = /(?:^|\n)[ \t]*RESULT[ \t]*[:：][ \t]*(PASS|FAIL)\b/i;

function parseReviewVerdict(content) {
  const matched = RESULT_LINE.exec(String(content || ''));
  if (!matched) return null;
  return matched[1].toUpperCase() === 'PASS' ? 'pass' : 'fail';
}

const KICKOFF_SECTIONS = [
  { key: '目标', re: /目标/ },
  { key: '非目标', re: /非目标/ },
  { key: '验收标准', re: /验收(标准|条件)/ },
  { key: '风险与回退', re: /(风险|回退)/ },
];

/**
 * 本阶段最少的交付字段是否可用。
 * 刻意只查「能不能往下走」所必需的那几项 —— 内容对不对由独立审查负责，
 * 不能用文件名或字段齐不齐证明代码正确。
 */
function checkDelivery(kind, content) {
  const text = String(content || '');
  if (kind === KIND_REVIEW) {
    const verdict = parseReviewVerdict(text);
    // 缺 RESULT 就是「审查还没给裁决」，停在待核对，不猜（任务书 B08）。
    return verdict ? { ok: true, verdict, missing: [] } : { ok: false, verdict: null, missing: ['RESULT'] };
  }
  if (kind === KIND_KICKOFF) {
    // 「非目标」里含「目标」两字，先摘掉它再判「目标」在不在，避免互相误命中。
    const withoutNonGoal = text.replace(/非目标/g, '〇');
    const missing = KICKOFF_SECTIONS
      .filter(section => (section.key === '目标' ? !section.re.test(withoutNonGoal) : !section.re.test(text)))
      .map(section => section.key);
    return { ok: missing.length === 0, verdict: null, missing };
  }
  return { ok: true, verdict: null, missing: [] };
}

// ── 接收账本 ────────────────────────────────────────────────────────────────
// 「交付是否成立」和「现在能否派下一位」是两件事，账本只回答前者。
// 后者由引擎结合「用户有没有喊停」「现场有没有人在跑」再判。

function emptyLedger(dir) {
  return { schemaVersion: 1, dir: String(dir || ''), accepted: {}, conflicts: {}, lastCheck: null };
}

function normalizeLedger(raw, dir) {
  const base = emptyLedger(dir);
  if (!raw || typeof raw !== 'object') return base;
  return {
    schemaVersion: 1,
    dir: String(raw.dir || dir || ''),
    accepted: raw.accepted && typeof raw.accepted === 'object' ? { ...raw.accepted } : {},
    conflicts: raw.conflicts && typeof raw.conflicts === 'object' ? { ...raw.conflicts } : {},
    lastCheck: raw.lastCheck && typeof raw.lastCheck === 'object' ? raw.lastCheck : null,
  };
}

function acceptedAt(ledger, pos) {
  const table = (ledger && ledger.accepted) || {};
  return table[String(pos)] || null;
}

/**
 * 把一次读取结果并进账本。**不写盘**，调用方负责持久化 —— 这样接收凭据和
 * 「下一步待派发」能在同一次落盘里一起写下去，中间崩溃不会留下半个事实。
 *
 * 返回 status：
 *   accepted             首次接收成功
 *   duplicate            同一份交付重复出现（丢事件重扫、文件事件重复），不重复派工
 *   changed_after_accept 已接收的文件后来被改动 —— 待核对，不静默改变已接收事实
 *   incomplete           文件在但最少字段不够（审查缺 RESULT / 开题缺四项）
 *   pending              还没改名 / 空文件 / 暂时读不到
 */
function reconcileDelivery(ledger, pos, delivery, kind) {
  const prior = acceptedAt(ledger, pos);
  if (!delivery || delivery.status !== 'ok') {
    return { status: 'pending', reason: (delivery && (delivery.reason || delivery.status)) || 'missing', prior };
  }
  if (prior && prior.fingerprint === delivery.fingerprint) {
    return { status: 'duplicate', record: prior, prior, verdict: prior.verdict || null };
  }
  if (prior && prior.fingerprint !== delivery.fingerprint) {
    return { status: 'changed_after_accept', reason: 'delivery_changed_after_accept', prior, current: delivery.fingerprint };
  }
  const check = checkDelivery(kind, delivery.content);
  if (!check.ok) {
    return { status: 'incomplete', reason: 'missing_fields', missing: check.missing, prior: null };
  }
  const record = {
    pos: Number(pos),
    kind,
    path: delivery.path,
    fingerprint: delivery.fingerprint,
    size: delivery.size,
    mtimeMs: delivery.mtimeMs || 0,
    acceptedAt: Date.now(),
    verdict: check.verdict || null,
  };
  return { status: 'accepted', record, verdict: check.verdict || null };
}

function withAccepted(ledger, pos, record) {
  const next = normalizeLedger(ledger, ledger && ledger.dir);
  next.accepted[String(pos)] = record;
  return next;
}

// ── 未解决的待核对 ──────────────────────────────────────────────────────────
//
// 2026-09-08 合并位复现的阻断：手册判 PASS、群聊里说 FAIL，引擎停在待核对；
// 用户点一下「继续」，因为这一步已经接收过、不再重新派发，聊天文本变成了占位符，
// 矛盾就这么凭空消失，任务直接变成完成 —— 期间没人改过文档，也没人重新审查过。
//
// 所以矛盾必须**连同当时那份手册的指纹**一起记下来：指纹没变就代表这份交付一个字没动，
// 矛盾自然还在，再点多少次继续都还是待核对。指纹变了则落到「已接收的交付被改动」那条路，
// 同样是待核对 —— 两条路都不会自己变成新裁决。

function withConflict(ledger, pos, record) {
  const next = normalizeLedger(ledger, ledger && ledger.dir);
  next.conflicts[String(pos)] = record;
  return next;
}

/** 这一位置上是否还挂着一条针对**当前**这份交付的未解决矛盾。 */
function unresolvedConflictAt(ledger, pos, fingerprint) {
  const record = ((ledger && ledger.conflicts) || {})[String(pos)];
  if (!record || !record.fingerprint) return null;
  return record.fingerprint === fingerprint ? record : null;
}

/** 每一步 prompt 末尾那段「你的文档在哪、写完怎么交」。路径一律给绝对路径。 */
function buildDocBlock(opts = {}) {
  const dir = String(opts.dir || '');
  const spec = docSpecForPos(opts.pos);
  if (!dir || !spec) return '';
  const lines = [
    '## 本阶段交接文档（Hub 按文件改名判定交付）',
    '任务目录（绝对路径）：' + dir,
    '本阶段草稿：' + path.join(dir, spec.draft),
    '完成文件：' + path.join(dir, spec.done),
  ];
  const inputs = (Array.isArray(opts.inputDocs) ? opts.inputDocs : []).filter(Boolean);
  if (inputs.length) {
    lines.push('先读这些已完成的上游文档（它们是本阶段的依据）：');
    for (const input of inputs) lines.push('- ' + input);
  }
  lines.push(
    '详细交接写进草稿：设计取舍、worktree、分支、完整提交 SHA、实际验证、未完成项与风险、审查入口。',
    '本阶段确实结束后，保存并关闭草稿，在同目录把它重命名为上面那个完成文件，再确认它存在且可读。',
    '不要直接往完成文件里持续追加内容冒充交付；不要覆盖已有的完成文件。',
    '群聊里只留 1~2 句人话：现在到哪、这意味着什么、下一步谁做。合同要求的字段照常输出。',
  );
  if (spec.kind === KIND_REVIEW) {
    lines.push(
      '合并手册里必须有单独成行的四行：RESULT: PASS 或 FAIL / BLOCKERS / VERIFIED / NEXT。',
      'Hub 以这份手册为裁决的权威依据；VERIFIED 空着一律不放行（那是你亲验过的证明）。',
      '群聊里也照常输出这四行 —— 两边说的必须一致，明确矛盾时 Hub 会停下来等维护者核对，不猜。',
    );
  }
  if (spec.kind === KIND_KICKOFF) {
    lines.push('开题报告要自包含：目标 / 非目标 / 验收标准 / 风险与回退，外加核实后的项目定位和必要工作入口。');
    lines.push('本阶段只写任务书，不要提前实现、不要建 worktree、不要提交。');
  }
  return lines.join('\n');
}

module.exports = {
  KIND_KICKOFF, KIND_BUILD, KIND_REVIEW, DONE_PREFIX, MIN_DELIVERY_CHARS,
  taskDocsRoot, taskDocsDir, ensureTaskDocsDir,
  docSpecForPos, posForLoopStep,
  readDelivery, fingerprintOf, parseReviewVerdict, checkDelivery,
  emptyLedger, normalizeLedger, acceptedAt, reconcileDelivery, withAccepted,
  withConflict, unresolvedConflictAt,
  buildDocBlock,
};
