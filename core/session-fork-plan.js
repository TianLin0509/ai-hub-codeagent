'use strict';

/**
 * 「从一个已有会话分支出一个新会话」需要准备的东西，抽成一处。
 *
 * 2026-09-17 之前这段逻辑只长在 `fork-session` 这个 IPC 里。现在有三个入口要用它：
 *   1. 单会话分支（原有的 Ctrl 快捷键）
 *   2. 把已有会话分支进某个群聊（新）
 *   3. 整个群聊一起分支（新，对每位成员各做一次）
 *
 * 复制三份必然走散——尤其是 effort / mcpProfile / fastMode / speedTier 这几个
 * 「不跟着分支走就会被悄悄打回默认值」的字段，历史上已经为它们补过好几次。
 *
 * 这里只负责算出 { kind, opts }，不创建任何会话、不碰 sessionManager。
 * ACP 家族需要先向原生侧要一个 fork 句柄，调用方拿到 needsAcpFork 自己去要。
 */

const {
  nativeSessionIdentity,
  sessionModelId,
  sessionProviderFamily,
  supportsForkSession,
} = require('./session-capabilities.js');
const { buildBranchSessionTitle, nextBranchIndex } = require('./branch-session-titles.js');

const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSafeNativeSessionId(value) {
  return typeof value === 'string' && NATIVE_SESSION_ID_RE.test(value);
}

/**
 * @param {object} params.source          原会话（活跃或休眠的持久记录都行）
 * @param {object[]} params.siblingPool   现存 + 已持久化的会话，用来给分支编号
 * @param {object} [params.meeting]       原会话所属群聊（决定分支标题的措辞）
 * @param {string} [params.rendererTitle] 用户此刻看到的标题，优先于存档标题
 * @param {object} [params.overrides]     覆盖项：title / cwd / meetingId 等
 * @param {string} [params.runtimeKind]   deepseek 旧 Claude 运行时的判定结果
 */
function planSessionFork({ source, siblingPool = [], meeting = null, rendererTitle = null, overrides = {}, runtimeKind = '' } = {}) {
  if (!source) {
    return { ok: false, error: 'session-not-found', message: '当前会话不存在或尚未启动' };
  }
  if (!supportsForkSession(source)) {
    return {
      ok: false,
      error: 'unsupported-kind',
      message: '仅支持 Claude Code、DeepSeek 和 Codex 会话创建分支（Kimi CLI 无 fork 能力）',
    };
  }
  const identity = nativeSessionIdentity(source);
  const nativeSessionId = identity && identity.value;
  if (!isSafeNativeSessionId(nativeSessionId)) {
    return {
      ok: false,
      error: 'native-session-id-missing',
      message: '当前会话尚未绑定原生会话 ID，请等待本轮回答完成后重试',
    };
  }

  const isDeepSeek = source.kind === 'deepseek' || source.kind === 'deepseek-resume';
  const providerFamily = sessionProviderFamily(source);
  const branchIndex = nextBranchIndex(source.id, siblingPool);
  const resolvedTitle = buildBranchSessionTitle({ rendererTitle, source, meeting, branchIndex });

  const opts = {
    ...(source.runtimeBackend === 'claude-stream-json' ? source.nativeConfig : {}),
    title: resolvedTitle.title,
    cwd: source.cwd,
    branchSourceSessionId: source.id,
    branchIndex,
    branchAutoTitlePending: resolvedTitle.branchAutoTitlePending,
    // Prefer the exact title visible to the user. A generic group member name
    // (for example Codex 2) inherits the owning meeting title; a truly unnamed
    // standalone parent stays pending and is named from the branch's first prompt.
    autoTitleGenerated: resolvedTitle.autoTitleGenerated,
  };
  const sourceModel = sessionModelId(source);
  if (sourceModel) opts.model = sourceModel;
  // 分支必须继承 effort，否则从 low/medium 会话拉分支会被打回默认 max。
  if (source.effort) opts.effort = source.effort;
  if (source.codexApprovalPolicy) opts.approvalPolicy = source.codexApprovalPolicy;
  if (source.codexSandbox) opts.sandbox = source.codexSandbox;
  // 同理：MCP 档位和 fast 开关也要跟着分支走，否则从 Lean/关 fast 的会话
  // 拉出来的分支会被悄悄拉回 Full / 开 fast。
  if (source.mcpProfile) opts.mcpProfile = source.mcpProfile;
  if (source.fastMode === false) opts.fastMode = false;
  if (source.codexSpeedTier) opts.codexSpeedTier = source.codexSpeedTier;
  if (typeof source.contextMax === 'number') opts.contextMax = source.contextMax;

  let kind;
  let needsAcpFork = false;
  if (providerFamily === 'acp') {
    kind = source.kind.replace(/-resume$/, '');
    needsAcpFork = true;
  } else if (providerFamily === 'claude') {
    // 公司 Code Agent 与 Claude 同属 Claude 家族，分支必须仍是 Code Agent，不能变成 Claude 会话。
    kind = isDeepSeek ? 'deepseek' : String(source.kind || '').startsWith('codeagent') ? 'codeagent' : 'claude';
    opts.forkCCSessionId = nativeSessionId;
    if (String(runtimeKind || '').startsWith('deepseek-legacy')) opts.deepseekLegacyClaude = true;
  } else {
    kind = isDeepSeek ? 'deepseek' : 'codex';
    if (source.codexProfile) opts.codexProfile = source.codexProfile;
    if (source.codexSessionsRoot) opts.codexSessionsRoot = source.codexSessionsRoot;
    if (source.transcriptPath) opts.resumeTranscriptPath = source.transcriptPath;
    opts.codexForkSid = nativeSessionId;
  }

  // overrides 里给 null 表示「这一项不要」——整群分支就靠它去掉分支标题那套：
  // 群聊标题已经写了「（分支N）」，成员再各自叫「分支1: <源群聊名>」会全部重名。
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined) continue;
    if (value === null) delete opts[key];
    else opts[key] = value;
  }

  return { ok: true, kind, opts, providerFamily, needsAcpFork, nativeSessionId, branchIndex };
}

module.exports = { isSafeNativeSessionId, planSessionFork };
