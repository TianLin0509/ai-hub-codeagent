const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { EventEmitter } = require('events');
const { getConfig } = require('./hub-config.js');
const { getHubDataDir } = require('./data-dir');
const { isAcpKind, buildAcpOptions, LABELS: ACP_LABELS } = require('./acp-profiles');
const { isClaudeFamily, isCodexCliKind, isKimiCliKind, isCodeAgentKind } = require('./ai-kinds.js');
const {
  nativeSessionIdentity,
  supportsRecoverableSession,
} = require('./session-capabilities.js');
const {
  normalizeDeepSeekModel,
  normalizeCodexSessionModel,
  isCodexConversationModelId,
  deepseekDisplayName,
  normalizeLegacyDeepSeekClaudeModel,
  legacyDeepSeekClaudeDisplayName,
  DEFAULT_MODEL_BY_KIND,
} = require('./model-options.js');
const {
  ensureDeepSeekCodexProfile,
} = require('./deepseek-codex-profile.js');
const { ensureMemoryLink } = require('./claude-memory-link.js');
const { isSyntheticUserEntry, textFromContent } = require('./synthetic-user-filter.js');
const { TerminalSnapshot } = require('./terminal-snapshot.js');
const { CodexXtermScrollbackRewriter } = require('./codex-xterm-scrollback-rewriter.js');
const { PtyOutputDelivery } = require('./pty-output-delivery.js');
const { compareLatestReplyDesc } = require('./session-recency.js');
const { detectHostShellTakeover, detectCodexThreadEnded } = require('./host-shell-detector.js');
const {
  DEFAULT_CLAUDE_MCP_PROFILE,
  WIRELESS_MCP_NAMES,
  buildClaudeMcpProfileArgs,
  normalizeClaudeMcpProfile,
} = require('./claude-mcp-profile.js');
const {
  CODEX_SPEED_TIERS,
  buildCodexSpeedTierArg,
  normalizeCodexSpeedTier,
} = require('./codex-speed-tier.js');
const {
  buildCodexContextWindowArg,
  normalizeCodexContextWindow,
  resolveCodexContextWindow,
} = require('./codex-context-window.js');

// Renderer 首次懒挂载、reload 或 surface 丢失后的降级恢复会用这个环形缓冲的
// 终端数据重建 xterm。16KB 装不下 Codex/Kimi 这类 TUI 的一整帧全屏重绘
// （带色彩的一帧几十 KB 很常见），尾切之后 `\x1b[2J` 和大部分绘制字节被丢掉、
// 只剩若干条 `\x1b[<行>;1H` 绝对定位序列 —— 重放出来就是"内容落在指定行、
// 上方全是空行"。实测（tests/e2e-terminal-rehydrate-cdp.js）：16KB 下重建时，
// 400 行内容只剩 227 行（保全率 56.8%）；256KB 下 400 行和 2000 行都是 100%。
// 取 1MB 是给带 ANSI 色彩的 TUI 输出留余量（同样内容字节数可达纯文本数倍）。
// 代价很小：每会话一个字符串，远低于多留一个 xterm + WebGL 实例。
const RING_BUFFER_BYTES = 1024 * 1024;

// 试过两种"起点对齐"，都已放弃，记在这里免得有人再走一遍：
//   1) 对齐到最后一次 \x1b[2J 全屏清屏 —— 实测是**倒退**。Codex/Kimi 每次重绘都清屏，
//      最后一次清屏往往就在缓冲末尾，对齐过去等于把整个滚动回缓冲丢光。
//   2) 剥掉开头被切剩的 CSI 参数残尾（形如 "38;5;196m"）—— 无法与正常文本可靠区分，
//      正文以数字开头时会吃掉真实内容，风险大于收益。
// 2026-07-30 根治：正常路径改由 TerminalSnapshot 在主进程持续解析完整 xterm 状态；
// 这个 1MB 原始尾部只保留为 snapshot 初始化失败时的降级兜底，不再承担长会话恢复。
// Claude CLI `--effort` 的合法枚举；弹窗传入的值必须在此集合内才会被拼进命令行。
const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_MCP_PROFILES = new Set(['none', 'lean', 'browser', 'wireless', 'full']);
const DEFAULT_IDLE_SUSPEND_MS = 5 * 60 * 60 * 1000;
// 「释放内存」面板休眠会话的闸门：正在回答、10 分钟内有活动、当前聚焦、群聊成员都不动。
// 群聊成员由群聊整体休眠管理，单独休眠一个成员会打断群聊派发。
// E2E 不能真等 10 分钟：仅在 CLAUDE_HUB_E2E=1 时允许用环境变量缩短（至少 1 ms，保留「正在回答不休眠」）。
const MEMORY_RELEASE_MIN_IDLE_MS = process.env.CLAUDE_HUB_E2E === '1'
  && Number.isFinite(Number(process.env.CLAUDE_HUB_E2E_MEMORY_RELEASE_IDLE_MS))
  ? Math.max(1, Number(process.env.CLAUDE_HUB_E2E_MEMORY_RELEASE_IDLE_MS))
  : 10 * 60 * 1000;
const MEMORY_RELEASE_SUSPEND_OPTIONS = Object.freeze({
  reason: 'memory-release',
  minIdleMs: MEMORY_RELEASE_MIN_IDLE_MS,
  excludeFocused: true,
  excludeMeeting: true,
});
// One default for ordinary/group Codex sessions and every new/resume/fork/relaunch path.
const CODEX_REASONING_EFFORT = 'max';
// Codex 的思考深度档位。2026-08-16 查 ~/.codex/models_cache.json 实测：
// gpt-5.6-sol/terra 支持 low/medium/high/xhigh/max/ultra，5.5/5.4 只到 xhigh。
// （早先以为 xhigh 是 Claude --effort 专属、Codex 会报错 —— 错的，每个模型都支持；
//   而且还有比 max 更高的 ultra："最大推理 + 自动任务分派"。）
// 这里是"语法层"白名单，真正按模型过滤在 core/codex-model-catalog.js，
// UI 也据此动态出选项；这一层只保证不会把乱字符串拼进命令行。
const CODEX_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const BARE_CODEX_COMMAND_RE = /^codex(?:\.cmd|\.exe)?$/i;
function normalizeCodexEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CODEX_EFFORT_LEVELS.has(normalized) ? normalized : CODEX_REASONING_EFFORT;
}
function buildCodexReasoningConfigArg(effort = CODEX_REASONING_EFFORT) {
  return [
    ` -c 'model_reasoning_effort="${effort}"'`,
    ` -c 'approval_policy="never"'`,
    ` -c 'sandbox_mode="danger-full-access"'`,
    ` -c 'windows.sandbox="unelevated"'`,
    ` -c 'notice.hide_full_access_warning=true'`,
  ].join('');
}
const CODEX_REASONING_CONFIG_ARG = buildCodexReasoningConfigArg(CODEX_REASONING_EFFORT);

// 打包后 __dirname 指向 app.asar 内部，外部进程（claude/codex CLI）读不到。
// 用 asarUnpack 解压副本 + 路径替换，源码模式 __dirname 不含 app.asar，noop。
function resolveAsarUnpacked(filename) {
  const baseDir = __dirname.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return path.join(baseDir, filename);
}

// 配置从 hub-config.js 加载（优先级：env > config.json > secrets.toml）
// 老用户无感知：如果 config.json 不存在，自动 fallback 到 secrets.toml
function _loadConfigValues() {
  const config = getConfig();
  return {
    CLAUDE_PROXY: config.proxy,
    CLAUDE_BACKEND: config.claudeBackend,
    CLAUDE_API_KEY: config.claudeApiKey,
    CLAUDE_API_BASE_URL: config.claudeApiBaseUrl,
    CLAUDE_API_MODEL: config.claudeApiModel,
    DEEPSEEK_API_KEY: config.deepseekApiKey,
    CODEX_BACKEND: config.codexBackend,
    CODEX_SUBSCRIPTION_PROFILE: config.codexSubscriptionProfile,
    CODEX_SUBSCRIPTION_PROFILES: config.codexSubscriptionProfiles,
    CODEX_API_KEY: config.codexApiKey,
    CODEX_API_BASE_URL: config.codexApiBaseUrl,
    CODEX_API_MODEL: config.codexApiModel,
    CODEX_API_PROVIDER: config.codexApiProvider || 'openai-api',
  };
}
// 惰性求值：首次使用时加载，之后缓存
let _configValues = null;
function getConfigValues() {
  if (!_configValues) _configValues = _loadConfigValues();
  return _configValues;
}
function clearSessionManagerConfigCache() {
  _configValues = null;
}

/**
 * 清空所有代理 env，让子进程对 DeepSeek 等国内/中转端点直连。
 * 必须清干净大小写两套——Hub 进程继承的可能是 Clash/Mihomo 设的 7890，
 * 走代理时长流式请求可能被 60s idle TCP 切断。
 */
function windowsPowerShellPath() {
  const candidate = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}
function clearProxyEnv(env) {
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  delete env.NO_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.all_proxy;
  delete env.no_proxy;
}

/**
 * 海外订阅 CLI 的唯一代理出口。先清掉 Hub 父进程可能继承的
 * ALL_PROXY / 小写 proxy 变量，再同时写入大小写 HTTP(S)_PROXY。
 * 否则不同 CLI / HTTP 库的变量优先级不同，界面看着是 7890，
 * 实际仍可能拾取父进程的另一个代理。
 */
function applyProxyEnv(env, proxy) {
  if (!String(proxy || '').trim()) return false;
  clearProxyEnv(env);
  const value = String(proxy || '').trim();
  if (!value) return false;
  env.HTTP_PROXY = value;
  env.HTTPS_PROXY = value;
  env.http_proxy = value;
  env.https_proxy = value;
  env.NO_PROXY = 'localhost,127.0.0.1';
  env.no_proxy = 'localhost,127.0.0.1';
  return true;
}

/**
 * Every Hub child runs inside a real xterm-compatible ConPTY.  A Hub launched
 * from CI/Codex can nevertheless inherit TERM=dumb from its parent shell.
 * Codex 0.151 treats that contradictory value as an interactive startup gate,
 * so normalize the child environment to the terminal we actually provide.
 */
function applyInteractiveTerminalEnv(env, { truecolor = false } = {}) {
  if (!env || typeof env !== 'object') return null;
  const term = String(env.TERM || '').trim().toLowerCase();
  if (!term || term === 'dumb') env.TERM = 'xterm-256color';
  if (!truecolor) return env.TERM;
  // xterm.js renders 24-bit RGB. Without this, Codex's diff palette falls back
  // to saturated indexed colors (or loses its backgrounds on newer versions).
  env.COLORTERM = 'truecolor';
  // supports-color on Windows classifies the console as ANSI-16 before it
  // consults COLORTERM. FORCE_COLOR=3 is its explicit truecolor declaration.
  // Preserve intentional user overrides, including monochrome output.
  if (process.platform === 'win32' && env.FORCE_COLOR === undefined && env.NO_COLOR === undefined) {
    env.FORCE_COLOR = '3';
  }
  return env.TERM;
}

function quotePowerShellLiteral(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

function resolveKimiExecutable(env = process.env) {
  const configured = env.KIMI_CODE_BIN || env.KIMI_BIN;
  const candidates = [
    configured,
    process.platform === 'win32' ? path.join(os.homedir(), '.kimi-code', 'bin', 'kimi.exe') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return 'kimi';
}

function kimiCommandPrefix(env = process.env) {
  const executable = resolveKimiExecutable(env);
  return executable === 'kimi' ? ' kimi' : ` & ${quotePowerShellLiteral(executable)}`;
}

function isKimiModelConfigured(modelAlias, env = process.env) {
  const homeDir = env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  const configPath = path.join(homeDir, 'config.toml');
  let configText;
  try { configText = fs.readFileSync(configPath, 'utf8'); } catch { return false; }
  const escaped = String(modelAlias || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[models\\.(?:"${escaped}"|'${escaped}')\\]\\s*$`, 'm').test(configText);
}

function kimiModelArg(modelAlias, env = process.env) {
  return isKimiModelConfigured(modelAlias, env)
    ? ` --model ${quotePowerShellLiteral(modelAlias)}`
    : '';
}

function isClaudeApiBackend(cv) {
  return cv.CLAUDE_BACKEND === 'api' && !!cv.CLAUDE_API_KEY;
}

// fast 默认开（保持历史行为），但新建会话弹窗可以显式关掉。
// 关的理由是真实存在的：2026-06-11 实测 fastMode 交互式会话不落盘 transcript jsonl，
// transcript-tap 拿不到 turn 文本 → 卡片视图收不到回复。以前只能靠全局环境变量
// CLAUDE_HUB_NO_FAST=1 一刀切，现在可以按会话选。
function shouldUseClaudeFastSettings(cv, opts = {}) {
  if (opts && opts.fastMode === false) return false;
  // autonomous 会话（Agent 联赛的自动赛程）没有人盯着终端：fast 一旦不落
  // transcript jsonl，transcript-tap 就永远收不到 turn-complete，整轮只能等
  // 30 分钟硬超时后判 failed。这里必须硬关，不给"默认开"留下沉默失败面。
  if (opts && opts.autonomous === true) return false;
  return process.env.CLAUDE_HUB_NO_FAST !== '1' && !isClaudeApiBackend(cv || getConfigValues());
}

// Claude CLI 的自动化档位。人类会话由用户逐条批准工具调用；autonomous 会话没有
// 人在场，任何一次权限询问都会把 PTY 停在弹窗上直到超时，所以必须显式旁路。
// 只接受白名单值，避免非法 IPC 字符串被拼进 PowerShell 命令行。
const CLAUDE_PERMISSION_MODES = new Set(['bypassPermissions', 'acceptEdits', 'plan', 'default']);

function claudePermissionModeArg(opts = {}) {
  const requested = opts.permissionMode || (opts.autonomous === true ? 'bypassPermissions' : '');
  return CLAUDE_PERMISSION_MODES.has(requested) ? ` --permission-mode ${requested}` : '';
}

// Hub 的聊天记录目录始终作为附加目录：「引用会话」让 Claude 读别的会话的记录 md，
// 它在工作目录之外，默认权限模式下每次都会弹 Read 审批（2026-09-26 真实 haiku 实测）。
// --add-dir 只让读取免审批，写入仍按原权限模式；恢复时会带回已持久化的 addDirs，所以去重。
// PTY（默认）、原生（回退）和 PTY 内重启三条启动路径都要带上。
function claudeNativeAddDirs(requested) {
  const dirs = Array.isArray(requested) ? requested.filter(Boolean).map(String) : [];
  const transcriptDir = require('./data-dir').getHubTranscriptDir();
  try { fs.mkdirSync(transcriptDir, { recursive: true }); } catch {}
  const seen = new Set(dirs.map(dir => path.resolve(dir).toLowerCase()));
  if (!seen.has(path.resolve(transcriptDir).toLowerCase())) dirs.push(transcriptDir);
  return dirs;
}

function createNativeClaudeDriver(id, kind, opts, cwd, env, legacy) {
  const { ClaudeNativeSession } = require('./claude-native-session');
  const { NativeAgentJournal } = require('./native-agent-journal');
  const { buildClaudeNativeArgs, prepareClaudeSettingsOverlay } = require('./claude-native-launch');
  if ((opts.useContinue || opts.resumePicker || kind === 'claude-resume')
      && !opts.resumeCCSessionId && !opts.forkCCSessionId) {
    throw new Error('请选择要恢复的 Claude 历史会话；原生连接需要明确的会话 ID');
  }
  const cv = getConfigValues();
  const hubDataDir = getHubDataDir();
  const mcp = buildClaudeMeetingMcpArgs({ cwd, hubDataDir, mcpConfigFile: opts.mcpConfigFile,
    mcpProfile: opts.mcpProfile || (legacy ? 'lean' : 'full') });
  const settings = [];
  if (opts.meetingId || opts.autonomous === true) settings.push(ensureGroupChatSettings(hubDataDir));
  if (!legacy && shouldUseClaudeFastSettings(cv, opts)) settings.push(resolveAsarUnpacked('claude-subscription-fast-settings.json'));
  const settingsFile = prepareClaudeSettingsOverlay(settings, {
    directory: path.join(hubDataDir, 'native-agent-settings'), sessionId: id + '-' + require('crypto').randomUUID(),
    overrides: { ...require('./agent-user-context').claudeSharedConfig(env,hubDataDir),fastMode: !legacy && shouldUseClaudeFastSettings(cv, opts),
      ...(opts.purpose === 'hub-assistant' && opts.autonomous === true ? {skipDangerousModePermissionPrompt:true} : {}) },
  });
  const launchArgs = buildClaudeNativeArgs({ model: legacy ? normalizeLegacyDeepSeekClaudeModel(opts.model) : opts.model,
    effort: legacy || process.env.CLAUDE_HUB_NO_EFFORT_MAX === '1' ? null
      : (opts.effort || 'max'),
    permissionMode: opts.permissionMode || 'bypassPermissions',
    appendSystemPromptFile: opts.appendSystemPromptFile, settingsFile,
    addDirs: claudeNativeAddDirs(opts.addDirs), settingSources: opts.settingSources,
    mcpConfigPaths: mcp.configPaths || [], strictMcpConfig: mcp.profile !== 'full' });
  const journal = new NativeAgentJournal({ directory: path.join(hubDataDir, 'native-agent-submissions'), sessionId: id });
  const fixture = process.env.CLAUDE_HUB_CLAUDE_STREAM_FIXTURE;
  if (fixture && !process.env.CLAUDE_HUB_DATA_DIR) throw new Error('Claude protocol fixtures require isolated Hub data');
  // A seat that never started has a Hub-assigned session ID but no conversation
  // behind it. Resuming that ID would fail ("no conversation found"), so it is
  // relaunched under the same identity instead -- provided the engine really
  // never wrote a history for it.
  const records = journal.list();
  const unstarted = opts.nativeRuntime?.connection === 'unstarted' && opts.nativeRuntime?.lazyStart === true
    && !records.length && !opts.forkCCSessionId && !!opts.resumeCCSessionId
    && !require('./claude-native-history').findNativeClaudeHistory(opts.resumeCCSessionId, { cwd, env });
  return new ClaudeNativeSession({ id, kind, cwd, env, launchArgs, settingsFile, hubDataDir, journalSessionId:id,
    hubPid:process.pid,hubVersion:require('../package.json').version,
    fastMode: !legacy && shouldUseClaudeFastSettings(cv, opts),
    ownership: true, exclusiveSession:true, nativeProvider: 'claude', lazyStart: opts.lazyStart === true,
    historyTitle: opts.userRenamed ? opts.title : null,
    ...(unstarted ? { sessionId: opts.resumeCCSessionId } : {}),
    resumeSessionId: unstarted ? null : (opts.forkCCSessionId || opts.resumeCCSessionId), fork: !!opts.forkCCSessionId,
    restoredRuntime: opts.nativeRuntime,
    restoredRecords: records,
    restoredActivities: journal.listActivities(), persistActivity: data => journal.saveActivity(data),
    persistSubmission: data => journal.saveSubmission(data), persistLifecycle: event => journal.saveLifecycle(event),
    ...(fixture ? { executable: process.execPath,
      commandArgs: [fixture, '--fixture=' + (process.env.CLAUDE_HUB_CLAUDE_FIXTURE_MODE || 'normal')],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
  });
}

// PTY 模式下 Claude 的启动命令。参数与原生驱动共用 buildClaudeNativeArgs，
// 保证两条后端的模型、思考档、权限、MCP、fast、群聊隔离完全一致。
//
// 会话身份尽量在启动前就确定下来，而不是事后按 cwd + 时间去猜 transcript：
//   新会话      → Hub 生成 uuid，--session-id
//   fork        → --resume <源> --fork-session --session-id <新 uuid>
//   已有历史    → --resume <id>
//   id 已分配但从未开聊（原生时代的懒启动席位）→ --session-id <同一个 id>
//   --continue / 选择器 → 身份未知，等第一个 hook 上报
function buildClaudePtyLaunch(id, kind, opts, cwd, env, cv) {
  const hubDataDir = getHubDataDir();
  const mcp = buildClaudeMeetingMcpArgs({ cwd, hubDataDir, mcpConfigFile: opts.mcpConfigFile,
    mcpProfile: opts.mcpProfile || 'full' });
  const fast = shouldUseClaudeFastSettings(cv, opts);
  const settings = [];
  if (opts.meetingId || opts.autonomous === true) settings.push(ensureGroupChatSettings(hubDataDir));
  if (fast) settings.push(resolveAsarUnpacked('claude-subscription-fast-settings.json'));
  const { buildClaudeNativeArgs, prepareClaudeSettingsOverlay } = require('./claude-native-launch');
  let cliTheme = null;
  try { cliTheme = require('./cli-coldwhite-theme').ensureClaudeTheme(env, opts.hubUiTheme); }
  catch (error) { console.warn('[CLI theme] Claude:', error.message); }
  const settingsFile = prepareClaudeSettingsOverlay(settings, {
    directory: path.join(hubDataDir, 'native-agent-settings'), sessionId: id + '-' + require('crypto').randomUUID(),
    overrides: { fastMode: fast, skipDangerousModePermissionPrompt: true, ...(cliTheme ? { theme: cliTheme } : {}) },
  });
  const args = buildClaudeNativeArgs({ model: opts.model,
    effort: process.env.CLAUDE_HUB_NO_EFFORT_MAX === '1' ? null
      : (CLAUDE_EFFORT_LEVELS.has(opts.effort) ? opts.effort : 'max'),
    permissionMode: opts.permissionMode || 'bypassPermissions',
    appendSystemPromptFile: opts.appendSystemPromptFile, settingsFile,
    addDirs: claudeNativeAddDirs(opts.addDirs), settingSources: opts.settingSources,
    mcpConfigPaths: mcp.configPaths || [], strictMcpConfig: mcp.profile !== 'full' });
  const { findNativeClaudeHistory } = require('./claude-native-history');
  const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
  let sessionId = null;
  let identity;
  if (opts.forkCCSessionId) {
    sessionId = require('crypto').randomUUID();
    // PTY Claude 启动前就预分配了 id，「一轮都没聊过」的源会话也带着 ccSessionId。没有可分支的
    // 对话时 `--resume <源> --fork-session` 报 No conversation found 并退回 shell（2026-09-26 实测），
    // Hub 却显示分支已建好。分支一个空对话就是新开一个。
    identity = findNativeClaudeHistory(opts.forkCCSessionId, { cwd, env })
      ? ['--resume', opts.forkCCSessionId, '--fork-session', '--session-id', sessionId]
      : ['--session-id', sessionId];
  } else if (opts.resumeCCSessionId && isUuid(opts.resumeCCSessionId)) {
    sessionId = opts.resumeCCSessionId;
    identity = findNativeClaudeHistory(sessionId, { cwd, env })
      ? ['--resume', sessionId]
      : ['--session-id', sessionId];
  } else if (opts.resumeCCSessionId) {
    identity = ['--resume', opts.resumeCCSessionId];
  } else if (opts.useContinue) {
    identity = ['--continue'];
  } else if (kind === 'claude-resume' || opts.resumePicker) {
    identity = ['--resume'];
  } else {
    sessionId = require('crypto').randomUUID();
    identity = ['--session-id', sessionId];
  }
  const quote = value => /^[A-Za-z0-9_.:=\/\\-]+$/.test(String(value)) ? String(value) : quotePowerShellLiteral(value);
  const cmd = ' claude ' + [...identity, ...args].map(quote).join(' ') + '\r\n';
  return { cmd, sessionId, fast };
}

// 公司 Code Agent 的启动命令（core/codeagent-config.js 说明了它与 Claude 的差异）。
// 与 buildClaudePtyLaunch 的区别：
//   - 它不认 --session-id：新会话和分支都不带身份参数，sessionId 留空，等第一个 hook 上报后绑定；
//     预先写一个它不会用的 id，会让后续每个 hook 都被当成外来会话丢弃，卡片永远不更新。
//   - 它不认 --settings：群聊插件隔离、fast、CLI 主题这些靠 overlay 的设置都不传；hook 写在配置目录。
//   - 必须带 --disable-update（否则弹阻塞的升级框）与 --skip-safe-check（信任框）。
//   - 没有 Claude 的模型目录与 fast 档；思考档只有 low/medium/high/max。
function buildCodeAgentPtyLaunch(id, kind, opts, cwd, env, config) {
  const { normalizeCodeAgentModel, EFFORTS, commandHead } = require('./codeagent-config');
  const hubDataDir = getHubDataDir();
  const mcp = buildClaudeMeetingMcpArgs({ cwd, hubDataDir, mcpConfigFile: opts.mcpConfigFile,
    mcpProfile: opts.mcpProfile || 'full' });
  const args = ['--disable-update', '--skip-safe-check', '--model', normalizeCodeAgentModel(opts.model)];
  if (EFFORTS.includes(opts.effort)) args.push('--effort', opts.effort);
  args.push('--permission-mode', CLAUDE_PERMISSION_MODES.has(opts.permissionMode) ? opts.permissionMode : 'bypassPermissions');
  if (opts.appendSystemPromptFile) args.push('--append-system-prompt-file', String(opts.appendSystemPromptFile));
  if (mcp.configPaths && mcp.configPaths.length) args.push('--mcp-config', ...mcp.configPaths);
  if (mcp.profile !== 'full') args.push('--strict-mcp-config');
  for (const dir of claudeNativeAddDirs(opts.addDirs)) args.push('--add-dir', dir);
  const { findNativeClaudeHistory } = require('./claude-native-history');
  const historyEnv = { ...env, CLAUDE_CONFIG_DIR: config.configDir };
  const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
  const hasHistory = value => isUuid(value) && !!findNativeClaudeHistory(value, { cwd, env: historyEnv });
  let sessionId = null;
  let identity = [];
  if (opts.forkCCSessionId) {
    // 分支一个从未聊过的源会话就是新开一个（同 Claude 的处理）。
    identity = hasHistory(opts.forkCCSessionId) ? ['--resume', opts.forkCCSessionId, '--fork-session'] : [];
  } else if (opts.resumeCCSessionId && hasHistory(opts.resumeCCSessionId)) {
    sessionId = opts.resumeCCSessionId;
    identity = ['--resume', sessionId];
  } else if (opts.resumeCCSessionId && !isUuid(opts.resumeCCSessionId)) {
    identity = ['--resume', opts.resumeCCSessionId];
  } else if (kind === 'codeagent-resume' || opts.resumePicker) {
    identity = ['--resume'];
  }
  // 其余情况（含「有 id 但没有落盘记录」）都是全新会话：不能用 --continue，它会接上这个目录里最近的别人的对话。
  const quote = value => /^[A-Za-z0-9_.:=\/\\-]+$/.test(String(value)) ? String(value) : quotePowerShellLiteral(value);
  const cmd = ' ' + commandHead(config.command) + ' ' + [...identity, ...args].map(quote).join(' ') + '\r\n';
  return { cmd, sessionId };
}

function applyClaudeSessionEnv(sessionEnv, cv) {
  if (isClaudeApiBackend(cv)) {
    // Custom Claude-compatible endpoints must be reached directly. Do not
    // inherit Clash/VPS proxy env, which can cut long-running API streams.
    clearProxyEnv(sessionEnv);
    if (cv.CLAUDE_API_BASE_URL) {
      sessionEnv.ANTHROPIC_BASE_URL = cv.CLAUDE_API_BASE_URL;
    } else {
      delete sessionEnv.ANTHROPIC_BASE_URL;
    }
    sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.CLAUDE_API_KEY;
    sessionEnv.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    sessionEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    sessionEnv.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';
    // Claude.ai account connectors cannot authenticate while an API token is
    // active. Disable that connector source explicitly so Claude Code does not
    // emit the expected-but-noisy auth-precedence warning on every Fable start.
    sessionEnv.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    delete sessionEnv.ANTHROPIC_API_BASE_URL;
    delete sessionEnv.ANTHROPIC_API_KEY;
    delete sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete sessionEnv.ANTHROPIC_MODEL;
    return 'api';
  }

  // Subscription OAuth (Claude Max): strip custom-endpoint env vars that would
  // otherwise route Claude Code to cc-switch / CCR, then use the configured
  // local proxy chain for claude.ai/Anthropic.
  delete sessionEnv.ANTHROPIC_BASE_URL;
  delete sessionEnv.ANTHROPIC_API_BASE_URL;
  delete sessionEnv.ANTHROPIC_AUTH_TOKEN;
  delete sessionEnv.ANTHROPIC_API_KEY;
  delete sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete sessionEnv.ANTHROPIC_MODEL;
  applyProxyEnv(sessionEnv, cv.CLAUDE_PROXY);
  return 'subscription';
}

function resolveClaudeLaunchModel(cv, requestedModel) {
  // The meeting creator always submits the subscription default model even
  // when the user never touched its model picker. Treat that value as an
  // implicit default so switching the global backend really does make Fable
  // the default for both 1:1 and group-chat Claude sessions. A genuinely
  // different per-session selection still wins.
  if (isClaudeApiBackend(cv) && cv.CLAUDE_API_MODEL
      && (!requestedModel || requestedModel === DEFAULT_MODEL_BY_KIND.claude)) {
    return cv.CLAUDE_API_MODEL;
  }
  if (requestedModel) return requestedModel;
  return DEFAULT_MODEL_BY_KIND.claude;
}

function toClaudeProjectKey(projectDir) {
  return path.resolve(projectDir || os.homedir()).replace(/\\/g, '/');
}

function ensureClaudeBypassAndTrust(claudeDir, projectDir) {
  if (!claudeDir) return;
  try {
    fs.mkdirSync(claudeDir, { recursive: true });

    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (settings.permissionMode !== 'bypassPermissions') {
      settings.permissionMode = 'bypassPermissions';
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    }

    const statePath = path.join(claudeDir, '.claude.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
    if (!state.projects || typeof state.projects !== 'object' || Array.isArray(state.projects)) {
      state.projects = {};
    }

    // 顶级 state：跳过 BypassPermissions 全屏警告菜单 + onboarding。
    // 缺这些字段时 claude CLI 首次启动会弹 "WARNING: Bypass Permissions mode" 全屏菜单
    // 要求按 2+Enter 通过 — conpty alt-screen 下方向键模拟不靠谱，普通用户体感"卡住"。
    // 字段名参考主 ~/.claude.json（生产 Claude 长期 accept 后的实际状态）。
    state.bypassPermissionsModeAccepted = true;
    state.skipDangerousModePermissionPrompt = true;
    state.hasCompletedOnboarding = true;

    const projectKey = toClaudeProjectKey(projectDir);
    const existing = state.projects[projectKey] && typeof state.projects[projectKey] === 'object'
      ? state.projects[projectKey]
      : {};
    state.projects[projectKey] = {
      allowedTools: Array.isArray(existing.allowedTools) ? existing.allowedTools : [],
      mcpContextUris: Array.isArray(existing.mcpContextUris) ? existing.mcpContextUris : [],
      mcpServers: existing.mcpServers && typeof existing.mcpServers === 'object' ? existing.mcpServers : {},
      enabledMcpjsonServers: Array.isArray(existing.enabledMcpjsonServers) ? existing.enabledMcpjsonServers : [],
      disabledMcpjsonServers: Array.isArray(existing.disabledMcpjsonServers) ? existing.disabledMcpjsonServers : [],
      ...existing,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[hub] failed to pretrust Claude config:', err.message);
  }
}

// 群聊 CLI 隔离 — 软隔离方案 (2026-05-02 / v2 白名单优化 2026-05-04 maintainer)
// 目的：群聊成员的 Claude/DeepSeek CLI 启动时,
//   `--settings <path>`  merge 一份"全 plugin disabled"的 settings.json
//   （只覆盖 enabledPlugins 字段，不动主目录的 hooks/permissions/statusLine 等）。
// 不动 CLAUDE_CONFIG_DIR — auto-memory / CLAUDE.md / OAuth 凭证全部继续共享。
// 仅当 opts.meetingId 存在（即群聊成员）时启用,主桌 Claude 会话不受影响。
//
// ⚠ settings 兜底盲区 (v2 修订 · 2026-05-04 maintainer):
//   `enabledPlugins` 仅对 **plugin 内的 skill** 生效。
//     ✅ 兜得住: superpowers 全家 (plan/brainstorming/TDD/debugging/SDD/post-refactor-verify/
//        simplify/review/security-review)、code-review/security-guidance/codex/
//        feature-dev/skill-creator/claude-md-management 等 23 个 plugin。
//     ❌ 兜不住: 用户自定义 skill (位于 ~/.claude/skills/),如 init / loop /
//        schedule / design-review。它们不属于任何 plugin,settings 完全无法禁用。
//   这部分必须靠 BASE_RULES (core/group-chat-scenes.js) 软约束兜底,详见该文件
//   "AI 禁止主动调用" 段。
//
// 历史 (v1 · 2026-05-02):
//   原方案另加 `--disable-slash-commands` (CLI 参数) 一刀切禁用所有斜杠命令,
//   误杀 /model /compact /help /clear /config 等用户基本操作 (用户反馈痛点)。
//   v2 删除该参数,改靠 settings 禁 plugin + BASE_RULES 软约束自定义 skill 双层兜底。
const _GROUP_CHAT_DISABLE_PLUGINS = {
  'hookify@claude-plugins-official': false,
  'code-review@claude-plugins-official': false,
  'security-guidance@claude-plugins-official': false,
  'commit-commands@claude-plugins-official': false,
  'pyright-lsp@claude-plugins-official': false,
  'feature-dev@claude-plugins-official': false,
  'claude-md-management@claude-plugins-official': false,
  'skill-creator@claude-plugins-official': false,
  'frontend-design@claude-plugins-official': false,
  'codex@openai-codex': false,
  'superpowers@claude-plugins-official': false,
  'harness@harness-marketplace': false,
  'differential-review@trailofbits-skills': false,
  'property-based-testing@trailofbits-skills': false,
  'supply-chain-risk-auditor@trailofbits-skills': false,
  'sharp-edges@trailofbits-skills': false,
  'variant-analysis@trailofbits-skills': false,
  'modern-python@trailofbits-skills': false,
  'second-opinion@trailofbits-skills': false,
  'git-cleanup@trailofbits-skills': false,
  'gh-cli@trailofbits-skills': false,
  'context7@context7': false,
  'ui-ux-pro-max@ui-ux-pro-max-skill': false,
};

function ensureGroupChatSettings(hubDataDir) {
  const fp = path.join(hubDataDir, 'group-chat-claude-settings.json');
  const content = JSON.stringify({ enabledPlugins: _GROUP_CHAT_DISABLE_PLUGINS }, null, 2);
  try {
    let cur = '';
    try { cur = fs.readFileSync(fp, 'utf8'); } catch {}
    if (cur !== content) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, 'utf8');
    }
  } catch (err) {
    console.warn('[hub] failed to write group chat settings:', err.message);
  }
  return fp;
}

// enabled 早期只是 meetingId（群聊成员），现在 Agent 联赛的 autonomous 会话也
// 复用同一份"全 plugin disabled"settings：自动跑批的 Agent 不该把 23 个 plugin
// 的 skill 拉进上下文，更不该在赛程里被 /loop、/schedule 这类命令带偏。
function buildGroupChatIsolationFlags(enabled) {
  if (!enabled) return '';
  const settingsPath = ensureGroupChatSettings(getHubDataDir());
  // settings 路径含反斜杠 — Claude CLI 在 PowerShell 下接受双反斜杠转义
  const escaped = settingsPath.replace(/\\/g, '\\\\');
  // 这里只隔离群聊里的 skill / plugin。MCP 是否 strict 现在由每位成员自己的
  // mcpProfile 决定，不能再在这里无条件覆盖用户在创建弹窗里的选择。
  return ` --settings "${escaped}"`;
}

function buildClaudeMeetingMcpArgs({
  mcpConfigFile,
  mcpProfile,
  cwd,
  hubDataDir,
  homeDir,
  fsModule,
} = {}) {
  const profile = normalizeClaudeMcpProfile(mcpProfile);
  const mandatoryFiles = typeof mcpConfigFile === 'string' && mcpConfigFile
    ? [mcpConfigFile]
    : [];
  const quoteConfig = value => `"${String(value).replace(/\\/g, '\\\\')}"`;

  // Full = 继承全部用户 MCP。research/群聊通信配置仍以额外 config 合并进去，
  // 但不加 strict，否则所谓 Full 实际会把全局 MCP 全部挡掉。
  if (profile === 'full') {
    const webPlan = buildClaudeMcpProfileArgs({ mcpProfile:profile, cwd, hubDataDir, homeDir, ...(fsModule ? { fsModule } : {}) });
    if (webPlan.configPath) mandatoryFiles.push(webPlan.configPath);
    return {
      args: mandatoryFiles.length ? ` --mcp-config ${mandatoryFiles.map(quoteConfig).join(' ')}` : '',
      profile,
      keptServers: [],
      configPaths: mandatoryFiles,
    };
  }

  const profilePlan = buildClaudeMcpProfileArgs({
    mcpProfile: profile,
    cwd,
    hubDataDir,
    homeDir,
    ...(fsModule ? { fsModule } : {}),
  });
  // 生成过滤配置失败时沿用 buildClaudeMcpProfileArgs 的 fail-open 语义：宁可 Full，
  // 也不能只剩群聊 MCP 却静默丢掉用户工具。
  if (!profilePlan.configPath) {
    return {
      args: mandatoryFiles.length ? ` --mcp-config ${mandatoryFiles.map(quoteConfig).join(' ')}` : '',
      profile: 'full',
      keptServers: [],
      configPaths: mandatoryFiles,
    };
  }
  const configPaths = [...mandatoryFiles, profilePlan.configPath];
  return {
    args: ` --mcp-config ${configPaths.map(quoteConfig).join(' ')} --strict-mcp-config`,
    profile,
    keptServers: profilePlan.keptServers,
    configPaths,
  };
}

// dismissCodexUpdatePrompt — 阻止 codex CLI 启动时弹 "Update available! X -> Y" 提示。
//
// 历史 bug：codex 在 alt-screen TUI 弹 update prompt 阻塞主循环，AI 群聊发 prompt 时
// 字符进 update 选择菜单 → codex 选 "1.Update now" 自动跑 npm install -g → 升级完
// codex 自退、PowerShell 接管 PTY → Hub 的 prompt 被 PowerShell 当命令执行 + 解析失败。
//
// 修：写 dismissed_version = latest_version 到 codex 的 version.json，让 prompt 静默。
//
// 默认对订阅模式 ~/.codex/version.json；API 模式（isolated CODEX_HOME）必须显式传
// configDir 指向 <hubDataDir>/codex-api-profile，否则 dismiss 写到错误位置不生效。
function dismissCodexUpdatePrompt(homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir(), configDir = null) {
  const versionPath = configDir
    ? path.join(configDir, 'version.json')
    : path.join(homeDir, '.codex', 'version.json');
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(versionPath, 'utf8')); } catch {}
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    if (!state.latest_version || state.dismissed_version === state.latest_version) return false;

    state.dismissed_version = state.latest_version;
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, JSON.stringify(state), 'utf8');
    console.log(`[hub] dismissed Codex update prompt for ${state.latest_version} at ${versionPath}`);
    return true;
  } catch (err) {
    console.warn('[hub] failed to dismiss Codex update prompt:', err.message);
    return false;
  }
}

// dismissCodexRateLimitDialog — 阻止 codex CLI 启动后弹 rate-limit / model-switch
// dialog（"Press enter to confirm or esc to go back" / "never show again"）。
//
// 历史 bug（2026-05-05 maintainer 实测确认）：codex 启动后某些条件（rate-limit 接近 / 模型
//   配额计数）会弹一个 TUI dialog 拦住 alt-screen 输入。Hub 主路径 sendToPty 的字符
//   写到 dialog 而不是输入框 → \r 被 dialog 当确认按钮 → prompt 留输入框未提交 →
//   用户看到"输入框卡 prompt"现象，需手动点 [📤 发送]。
//
// 修：写 hide_rate_limit_model_nudge = true 到 config.toml 的 [notice] 段，永久关闭
//   该 dialog（OpenAI 官方 opt-out 机制，见 developers.openai.com/codex/config-reference）。
//
// 行为：幂等。若 key 已是 true 直接返回 false（无需写盘）。文件不存在则创建。
//   有 [notice] section 时在 section 内追加 key；没有时文件末尾追加完整 section。
//
// 默认对订阅模式 ~/.codex/config.toml；API 模式（isolated CODEX_HOME）必须显式传
//   configDir，否则 dismiss 写到错误位置不生效（同 dismissCodexUpdatePrompt 约定）。
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureTomlSectionKey(content, sectionName, key, value) {
  const src = String(content || '');
  const desiredLine = `${key} = ${value}`;
  const headerRe = new RegExp(`^\\s*\\[${escapeRegExp(sectionName)}\\]\\s*$`, 'im');
  const headerMatch = src.match(headerRe);

  if (!headerMatch) {
    const sep = src ? (src.endsWith('\n') ? '\n' : '\n\n') : '';
    return {
      content: src + sep + `[${sectionName}]\n${desiredLine}\n`,
      changed: true,
    };
  }

  const sectionStart = headerMatch.index + headerMatch[0].length;
  const tail = src.slice(sectionStart);
  const nextHeaderMatch = tail.match(/\n\s*\[[^\]]+\]\s*$/m);
  const sectionEnd = nextHeaderMatch ? sectionStart + nextHeaderMatch.index : src.length;
  const section = src.slice(sectionStart, sectionEnd);
  const desiredRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*${escapeRegExp(value)}\\s*$`, 'im');
  if (desiredRe.test(section)) {
    return { content: src, changed: false };
  }

  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, 'im');
  if (keyRe.test(section)) {
    const nextSection = section.replace(keyRe, desiredLine);
    return {
      content: src.slice(0, sectionStart) + nextSection + src.slice(sectionEnd),
      changed: true,
    };
  }

  return {
    content: src.slice(0, sectionStart) + `\n${desiredLine}` + src.slice(sectionStart),
    changed: true,
  };
}

function dismissCodexRateLimitDialog(homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir(), configDir = null) {
  const configPath = configDir
    ? path.join(configDir, 'config.toml')
    : path.join(homeDir, '.codex', 'config.toml');
  try {
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf8'); } catch { /* 文件不存在 → 视作空 */ }

    // 幂等：key 已存在且为 true → 跳过写盘
    let newContent = content;
    // 已有 [notice] section（任意大小写 / 前后空格）→ 在 section 头之后插入 key
    const noticeMatch = content.match(/^\s*\[notice\]\s*$/m);
    if (noticeMatch && !/^\s*hide_rate_limit_model_nudge\s*=\s*true\b/m.test(content)) {
      const insertPos = noticeMatch.index + noticeMatch[0].length;
      newContent = content.slice(0, insertPos) + '\nhide_rate_limit_model_nudge = true' + content.slice(insertPos);
    } else if (!noticeMatch && !/^\s*hide_rate_limit_model_nudge\s*=\s*true\b/m.test(content)) {
      // 没 [notice] → 文件末尾追加完整 section
      const sep = (content && !content.endsWith('\n')) ? '\n' : '';
      newContent = content + sep + '\n[notice]\nhide_rate_limit_model_nudge = true\n';
    }

    const requiredKeys = [
      ['notice', 'hide_rate_limit_model_nudge', 'true'],
      ['notice', 'hide_full_access_warning', 'true'],
      ['windows', 'sandbox', '"unelevated"'],
    ];
    let changed = false;
    for (const [section, key, value] of requiredKeys) {
      const next = ensureTomlSectionKey(newContent, section, key, value);
      newContent = next.content;
      changed = changed || next.changed;
    }
    if (!changed) return false;

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, newContent, 'utf8');
    console.log(`[hub] ensured Codex silent full-access config at ${configPath}`);
    return true;
  } catch (err) {
    console.warn('[hub] failed to ensure Codex silent full-access config:', err.message);
    return false;
  }
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function tomlArray(values) {
  return '[' + (Array.isArray(values) ? values : []).map(tomlString).join(', ') + ']';
}

function getCodexApiHome() {
  return path.join(getHubDataDir(), 'codex-api-profile');
}

function ensureCodexApiProfile(cv, projectDir) {
  const codexHome = getCodexApiHome();
  const provider = cv.CODEX_API_PROVIDER || 'openai-api';
  const baseUrl = cv.CODEX_API_BASE_URL || 'https://api.openai.com/v1';
  const model = cv.CODEX_API_MODEL || DEFAULT_MODEL_BY_KIND.codex;
  const projectKey = path.resolve(projectDir || os.homedir());

  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'disable_response_storage = true',
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(provider)}`,
    `model_reasoning_effort = ${tomlString(CODEX_REASONING_EFFORT)}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[notice]',
    'hide_rate_limit_model_nudge = true',
    'hide_full_access_warning = true',
    '',
    '[windows]',
    'sandbox = "unelevated"',
    '',
    `[model_providers.${provider}]`,
    `base_url = ${tomlString(baseUrl)}`,
    `name = ${tomlString(provider)}`,
    'requires_openai_auth = true',
    'wire_api = "responses"',
    '',
    `[projects.${tomlString(projectKey)}]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: cv.CODEX_API_KEY || '',
  }), 'utf8');
  return codexHome;
}

function isCodexApiBackend(cv) {
  return cv.CODEX_BACKEND === 'api' && !!cv.CODEX_API_KEY;
}

function resolveDefaultCodexModel(cv) {
  return isCodexApiBackend(cv) && cv.CODEX_API_MODEL
    ? cv.CODEX_API_MODEL
    : DEFAULT_MODEL_BY_KIND.codex;
}

function expandHomePath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function resolveCodexSubscriptionProfile(cv, requestedId) {
  const profiles = Array.isArray(cv.CODEX_SUBSCRIPTION_PROFILES) ? cv.CODEX_SUBSCRIPTION_PROFILES : [];
  const fallback = profiles.find(p => p && p.id === 'default') || { id: 'default', label: '主账号', home: '' };
  const wanted = String(requestedId || cv.CODEX_SUBSCRIPTION_PROFILE || fallback.id || 'default').trim();
  const selected = profiles.find(p => p && p.id === wanted) || fallback;
  const home = expandHomePath(selected.home);
  return {
    id: selected.id || 'default',
    label: selected.label || selected.id || 'Codex',
    home: home ? path.resolve(home) : '',
  };
}

// 订阅模式 codex CLI 0.125.0 对未 trust 的 cwd 启动时会弹
// "Do you trust the contents of this directory? 1.Yes 2.No" 阻塞 TUI 主循环，
// 永远不写 ~/.codex/sessions/.../rollout-*.jsonl → CodexTap _bound 永远空。
// 修：spawn 前幂等追加 [projects.'<cwd>'] trust_level = "trusted" 到主 config.toml。
function ensureCodexCwdTrusted(projectDir, configDir = null) {
  if (!projectDir) return;
  try {
    const codexHome = configDir || path.join(os.homedir(), '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const cfgPath = path.join(codexHome, 'config.toml');
    const projectKey = path.resolve(projectDir);
    // Codex CLI 0.137-0.144 normalizes Windows cwd to lower-case before the
    // trust lookup. Store one normalized key instead of appending both cases.
    const trustKey = projectKey.toLowerCase();
    let cfg = '';
    try { cfg = fs.readFileSync(cfgPath, 'utf8'); } catch {}
    const existingKeys = Array.from(cfg.matchAll(/^\[projects\.'([^']+)'\]\s*$/gm), match => match[1]);
    if (existingKeys.includes(trustKey)) return;
    const append = (cfg && !cfg.endsWith('\n') ? '\n' : '')
      + `\n[projects.'${trustKey}']\ntrust_level = "trusted"\n`;
    fs.appendFileSync(cfgPath, append, 'utf8');
  } catch (err) {
    console.warn('[hub] failed to pretrust codex cwd:', err.message);
  }
}

// These servers are room-scoped. Never leave a persistent copy in the user's
// global Codex config: an ordinary Codex session must not discover room tools.
// xresearch_knowledge is a legacy standalone registration removed during launch.
const CODEX_MANAGED_MCP_NAMES = ['ai-team', 'arena_research', 'xresearch_knowledge'];

function listCodexMcpServerNames(configDir) {
  try {
    const codexHome = configDir || path.join(os.homedir(), '.codex');
    const cfg = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const names = new Set();
    for (const line of cfg.split(/\r?\n/)) {
      const match = line.trim().match(/^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.|\])/);
      const name = match && (match[1] || match[2] || match[3]);
      if (name && /^[A-Za-z0-9_-]+$/.test(name)) names.add(name);
    }
    return [...names];
  } catch {
    return [];
  }
}

function normalizeCodexMcpProfile(value) {
  const normalized = String(value || 'lean').trim().toLowerCase();
  return CODEX_MCP_PROFILES.has(normalized) ? normalized : 'lean';
}

function resolveCodexMcpProfile(kind, value) {
  // 2026-08-29 起 deepseek 也跟着默认 none（原来是 lean）。用户要求新建会话一律
  // 不加载 MCP —— lean 会让「无线工作区自动放行」把 wireless-sim 拉回来，等于没关。
  const fallback = 'none';
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return CODEX_MCP_PROFILES.has(normalized) ? normalized : fallback;
}

function resolveCodexSpeedTier(kind, value) {
  const fallback = String(kind || '').replace(/-resume$/, '') === 'deepseek' ? 'inherit' : 'fast';
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return CODEX_SPEED_TIERS.has(normalized) ? normalized : fallback;
}

function isPathInside(candidate, root) {
  if (!candidate || !root) return false;
  const resolvedCandidate = path.resolve(String(candidate)).toLowerCase();
  const resolvedRoot = path.resolve(String(root)).toLowerCase();
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

function isWirelessWorkspace(cwd) {
  const wirelessRoot = process.env.AI_HUB_WIRELESS_ROOT || '';
  return isPathInside(cwd, wirelessRoot);
}

// None disables every configured server, including workspace and room-scoped
// entries. Other profiles retain the existing selective behavior.
function buildCodexMcpIsolationArgs(configDir, options = {}) {
  const names = listCodexMcpServerNames(configDir);
  const allowed = new Set((options.allowedNames || [])
    .map(name => String(name || '').trim())
    .filter(Boolean));

  const profile = normalizeCodexMcpProfile(options.mcpProfile);
  if (profile === 'full') return '';
  if (profile === 'none') allowed.clear();
  if (profile === 'browser') allowed.add('playwright');
  if (profile !== 'none' && (profile === 'wireless' || isWirelessWorkspace(options.cwd))) {
    // 只写 superwireless 是个空转 bug：用户 ~/.codex/config.toml 里这个 server
    // 实际叫 wireless-sim，于是 wireless 档把唯一想留的那个也禁掉了。两个名字都放行。
    WIRELESS_MCP_NAMES.forEach(name => allowed.add(name));
  }
  return names
    .filter(name => !allowed.has(name))
    .map(name => ` -c 'mcp_servers.${name}.enabled=false'`)
    .join('');
}

function buildCodexGroupMcpIsolationArgs(configDir, meetingId, allowedNames = CODEX_MANAGED_MCP_NAMES) {
  if (!meetingId) return '';
  return buildCodexMcpIsolationArgs(configDir, { meetingId, allowedNames });
}

function getSessionResumeIdentity(info) {
  const identity = nativeSessionIdentity(info);
  return identity ? identity.value : null;
}

function supportsRecoverableSuspend(info) {
  return supportsRecoverableSession(info);
}

function buildCodexEphemeralMcpArgs(entries) {
  const out = [];
  const seen = new Set();
  const literal = (value) => `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
  const literalArray = (values) => `[${(Array.isArray(values) ? values : []).map(literal).join(', ')}]`;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry && entry.name || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    // Codex is launched through PowerShell's npm shim. Outer double quotes +
    // TOML literal strings survive both parsing layers; JSON-style arrays do
    // not and are silently interpreted as a scalar string.
    const add = (expression) => {
      const escaped = String(expression).replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"');
      out.push(` -c "${escaped}"`);
    };
    add(`mcp_servers.${name}.command=${literal(entry.command || '')}`);
    add(`mcp_servers.${name}.args=${literalArray(entry.args || [])}`);
    const env = entry.env && typeof entry.env === 'object' ? entry.env : {};
    for (const key of Object.keys(env).sort()) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      add(`mcp_servers.${name}.env.${key}=${literal(env[key])}`);
    }
    for (const [tool, policy] of require('./codex-mcp-tool-policy').toolPolicyEntries(entry)) {
      for (const [key, value] of Object.entries(policy)) add(`mcp_servers.${name}.tools.${tool}.${key}=${typeof value === 'number' ? value : literal(value)}`);
    }
  }
  return out.join('');
}

function stripCodexMcpEntries(cfg, names) {
  const managed = new Set((names || []).map(name => String(name || '').trim()).filter(Boolean));
  if (managed.size === 0 || !cfg) return cfg || '';
  const lines = cfg.split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const section = line.trim().match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1].match(/^mcp_servers\.([^.]+)(?:\.|$)/)?.[1] || '';
      skipping = managed.has(name);
    }
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\s+$/u, '');
}

function ensureCodexMcpEntries(configDir, entries, managedNames = []) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  if (safeEntries.length === 0 && (!Array.isArray(managedNames) || managedNames.length === 0)) return;
  try {
    const codexHome = configDir || path.join(os.homedir(), '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const cfgPath = path.join(codexHome, 'config.toml');
    let cfg = '';
    try { cfg = fs.readFileSync(cfgPath, 'utf8'); } catch {}
    cfg = stripCodexMcpEntries(cfg, managedNames);

    for (const entry of safeEntries) {
      const name = String(entry && entry.name || '').trim();
      if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
      cfg = stripCodexMcpEntries(cfg, [name]);

      const env = entry.env && typeof entry.env === 'object' ? entry.env : {};
      const block = [
        '',
        `[mcp_servers.${name}]`,
        `command = ${tomlString(entry.command || '')}`,
        `args = ${tomlArray(entry.args || [])}`,
      ];
      const envKeys = Object.keys(env).sort();
      if (envKeys.length > 0) {
        block.push('', `[mcp_servers.${name}.env]`);
        for (const key of envKeys) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
          block.push(`${key} = ${tomlString(env[key])}`);
        }
      }
      for (const [tool, policy] of require('./codex-mcp-tool-policy').toolPolicyEntries(entry)) {
        block.push('', `[mcp_servers.${name}.tools.${tool}]`);
        for (const [key, value] of Object.entries(policy)) block.push(`${key} = ${typeof value === 'number' ? value : tomlString(value)}`);
      }
      cfg += (cfg ? '\n' : '') + block.join('\n') + '\n';
    }
    fs.writeFileSync(cfgPath, cfg, 'utf8');
  } catch (err) {
    console.warn('[hub] failed to configure Codex MCP entries:', err.message);
  }
}

function buildNativeCodexOptions(info, opts, env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const profile = info.mcpProfile;
  const sharedConfig = require('./agent-user-context').codexSharedConfig(env,getHubDataDir());
  const configuredNames = [...new Set([...listCodexMcpServerNames(home),...Object.keys(sharedConfig.mcp_servers||{})])];
  const allowed = new Set(profile === 'full' ? configuredNames.filter(name=>!CODEX_MANAGED_MCP_NAMES.includes(name)) : []);
  if (profile === 'browser') allowed.add('playwright');
  if (profile !== 'none' && (profile === 'wireless' || isWirelessWorkspace(info.cwd))) {
    WIRELESS_MCP_NAMES.forEach(name => allowed.add(name));
  }
  const entries = profile === 'none' ? [] : require('./web-roundtable/integration').entries(opts.codexMcpEntries, profile, getHubDataDir());
  entries.forEach(entry => allowed.add(entry.name));
  const config = {...sharedConfig};
  if (require('./chatgpt-web-models').isChatgptWebModel(info.currentModel?.id)) {
    const web = require('./chatgpt-web-integration').requireWebTools(info.currentModel.id);
    config.model_provider = 'openai';
    config.openai_base_url = `http://127.0.0.1:${web.port}/v1`;
  }
  // Even a disabled MCP table must contain a valid transport in Codex. Never
  // synthesize incomplete tables for room servers absent from this profile.
  for (const name of new Set([...configuredNames, ...entries.map(entry=>entry.name)])) {
    config['mcp_servers.' + name + '.enabled'] = allowed.has(name);
  }
  for (const entry of entries) {
    if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) throw new Error('Codex MCP 名称无效');
    config['mcp_servers.' + entry.name + '.command'] = entry.command;
    config['mcp_servers.' + entry.name + '.args'] = entry.args || [];
    for (const [key,value] of Object.entries(entry.env || {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Codex MCP 环境字段无效');
      config['mcp_servers.' + entry.name + '.env.' + key] = String(value);
    }
    for (const [tool, policy] of require('./codex-mcp-tool-policy').toolPolicyEntries(entry)) {
      for (const [key, value] of Object.entries(policy)) config['mcp_servers.' + entry.name + '.tools.' + tool + '.' + key] = value;
    }
  }
  const tier = info.codexSpeedTier;
  if (tier !== 'inherit') {
    // Keep the native server capable of honoring per-turn speed changes.
    // The service tier below controls billing; false here silently drops Fast.
    config['features.fast_mode'] = true;
    config.service_tier = tier === 'standard' ? 'default' : tier;
  }
  const threadConfig = { project_root_markers:['.git','.vibe-root'],
    model_reasoning_effort:normalizeCodexEffort(info.effort),
    'windows.sandbox':'unelevated', 'notice.hide_full_access_warning':true };
  if (info.contextMax) threadConfig.model_context_window = info.contextMax;
  if (opts.codexInstructionFile) threadConfig.model_instructions_file = opts.codexInstructionFile;
  const approvalPolicy = opts.approvalPolicy || 'never';
  const sandbox = opts.sandbox || 'danger-full-access';
  return {
    mcpProfile:profile,
    processArgs:Object.entries(config).flatMap(([key,value]) => ['-c',key+'='+require('./agent-user-context').codexTomlValue(value)]),
    threadParams:{cwd:info.cwd,model:info.currentModel.id,approvalPolicy,sandbox,config:threadConfig},
    turnParams:{model:info.currentModel.id,effort:normalizeCodexEffort(info.effort),
      ...(tier && tier !== 'inherit' ? {serviceTier:tier === 'standard' ? 'default' : tier} : {})},
    resumeId:(opts.useResume || info.kind === 'codex-resume') ? opts.codexSid : null,
    resumePath:opts.resumeTranscriptPath || null,
    forkId:opts.codexForkSid || null,
    picker:!opts.lazyStart && !opts.codexSid && (info.kind === 'codex-resume' || opts.codexResumePicker),
    resumeLatest:!opts.lazyStart && opts.useResume && !opts.codexSid,
  };
}

function sharedCodexRuntimeEnabled() { return false; }

class SessionManager extends EventEmitter {
  async _syncCodexAccount(driver,info) {
    if (!driver.options.resolveAccount || driver.closed) return null;
    if (driver.accountSyncRequest) return driver.accountSyncRequest;
    driver.accountSyncRequest = driver.enqueueSend(intent=>driver.followGlobalAccount(intent));
    try {
      await driver.accountSyncRequest;
      const target=driver.options.resolveAccount();
      return {sessionId:info.id,profile:driver.options.accountId,pending:target.id!==driver.options.accountId};
    } finally { driver.accountSyncRequest=null; }
  }
  async syncCodexAccounts() {
    if (require('./codex-global-account').currentConfig().codexAccountSwitchScope === 'launch') return [];
    const entries=[...this.sessions.values()].filter(s=>s.pty?.options?.resolveAccount && !s.pty.closed);
    return Promise.all(entries.map(async ({pty,info})=>{
      try { return await this._syncCodexAccount(pty,info); }
      catch(error){pty.emit('action-error','账号切换未完成：'+error.message);return {sessionId:info.id,error:error.message};}
    }));
  }
  sessions = new Map();
  focusedSessionId = null;
  claudeCounter = 0;
  resumeCounter = 0;
  psCounter = 0;
  _outputSeq = 0;
  _lastWrite = null;
  _managedLaunchAudit = [];
  _isShuttingDown = false;
  _shutdownDrainPromise = null;
  _shutdownExitWaiters = new Map();
  _shutdownDrainedSessions = new Map();

  // Injected by main: the chosen hook HTTP port + per-launch auth token.
  hookPort = null;
  hookToken = null;

  constructor() {
    super();
    this.presentationTheme = require('./theme-config').DEFAULT_THEME;
  }

  setPresentationTheme(theme) {
    if (require('./theme-config').THEME_IDS.includes(theme)) this.presentationTheme = theme;
  }

  // Callbacks
  onData = (sessionId, data) => {};
  onSessionClosed = (sessionId) => {};
  onSessionSuspended = (sessionId) => {};

  // opts: { id?, title?, cwd?, resumeCCSessionId?, forkCCSessionId?, useContinue? }
  //   id:                 reuse a previous hub session id (dormant wake)
  //   title:              override default title (dormant wake preserves name)
  //   cwd:                launch cwd; defaults to user home
  //   resumeCCSessionId:  when set, runs `claude --resume <id>`
  //   forkCCSessionId:    when set, runs `claude --resume <id> --fork-session`
  //   useContinue:        when set, runs `claude --continue` (Claude fallback)
  //   useResume:          generic resume flag for codex/gemini → uses sid/index if provided, else --last/latest
  //   codexSid:           when set + kind=='codex' + useResume, runs `codex resume <sid>` precisely (T8 new)
  //   codexForkSid:       when set + kind=='codex', runs `codex fork <sid>` into a fresh task
  //   geminiChatId:       Gemini 8charId from chats/session-*.json (T8 new, used for index lookup)
  //   geminiProjectRoot:  required for Gemini resume (T8 new, used as cwd for correct project scoping)
  _openOwners() {
    // Plain Node unit fixtures never write the user's session library.
    if (!process.versions.electron && !process.env.CLAUDE_HUB_DATA_DIR) return null;
    return this.openOwners ||= new (require('./session-open-ownership').SessionOpenOwnership)();
  }

  _claimNativeOpenIdentity(id, kind, opts, env) {
    const lease = this.openLeases?.get(id);
    if (!lease) return;
    this.openOwners.add(lease, require('./session-open-ownership').nativeKeys(kind, opts, env));
    lease.env = env;
    if (opts.codexForkSid || opts.forkCCSessionId) lease.forkSource = opts.codexForkSid || opts.forkCCSessionId;
  }

  _refreshOpenIdentity(id) {
    const lease = this.openLeases?.get(id), entry = this.sessions.get(id);
    if (!lease || !entry) return;
    const info = entry.info;
    this._claimNativeOpenIdentity(id, info.kind, {...info,
      codexSid:info.codexSid === lease.forkSource ? null : info.codexSid,
      resumeCCSessionId:info.ccSessionId === lease.forkSource ? null : info.ccSessionId}, lease.env);
    this.openOwners.bindPid(lease, entry.pty?.pid);
  }

  _releaseOpenSession(id, info) {
    const lease = this.openLeases?.get(id);
    if (!lease) return;
    // Commit the last authoritative identity/history settings before another
    // Hub can acquire the session. A persistence failure keeps it unavailable.
    if (info) {
      const store = require('./session-store');
      store.cancelDirty(id);
      store.saveSessionFile(id, {...info, updatedAt:Date.now()});
    }
    this.openOwners.release(lease);
    this.openLeases.delete(id);
  }

  reserveSessionOpen(id) {
    if (this.sessions.has(id)) throw new Error('该会话已在本 Hub 打开，请返回原会话');
    const owners = this._openOwners();
    const lease = owners?.claim(id);
    if (lease) { this.openLeases ||= new Map(); this.openLeases.set(id, lease); }
    return lease?.nonce;
  }

  cancelReservedOpen(id, nonce) {
    if (nonce && this.openLeases?.get(id)?.nonce===nonce && !this.sessions.has(id)) this._releaseOpenSession(id);
  }

  createSession(kind = 'powershell', opts = {}) {
    const id = opts.id || uuid();
    if (opts._openLeaseNonce) {
      if (this.sessions.has(id) || this.openLeases?.get(id)?.nonce!==opts._openLeaseNonce) throw new Error('会话打开预约已失效');
    } else this.reserveSessionOpen(id);
    const lease = this.openLeases?.get(id);
    try {
      if (lease) require('./session-store').resumeSessionWrites(id);
      require('./community-provider').assertProviderAvailable(kind);
      return this._createSession(kind, {...opts, id, hubUiTheme: this.presentationTheme});
    }
    catch (error) {
      if (!this.sessions.has(id)) this._releaseOpenSession(id);
      else this.closeSession(id);
      throw error;
    }
  }

  _createSession(kind = 'powershell', opts = {}) {
    if (this._isShuttingDown || this.restartPending) {
      throw new Error('Hub is shutting down; refusing to create a new PTY');
    }
    const id = opts.id || uuid();
    const freshLaunch = require('./session-history-state').isFreshLaunch(kind, opts);
    const isAcp = isAcpKind(kind);
    const isProviderCli = ['qwen','glm'].includes(kind.replace(/-resume$/, '')) && require('./agent-runtime-mode').agentRuntimeMode() !== 'native';
    const isClaude = kind === 'claude' || kind === 'claude-resume';
    const isGemini = kind === 'gemini' || kind === 'gemini-resume';
    const isDeepSeek = kind === 'deepseek' || kind === 'deepseek-resume';
    // New DeepSeek sessions use Codex. Persisted pre-migration sessions carry a
    // Claude ccSessionId and opt into this compatibility runtime so their history
    // remains resumable instead of being silently discarded.
    const isDeepSeekLegacy = isDeepSeek && !!opts.deepseekLegacyClaude;
    const isCodex = kind === 'codex' || kind === 'codex-resume';
    // 公司 Code Agent：Claude 形态的 CLI，只有 PTY 运行方式（没有原生后端）。
    const isCodeAgent = isCodeAgentKind(kind);
    // Claude / Codex 默认跑 PTY 里的真实 CLI；原生后端只在回退开关打开时使用。
    const nativeAgentRuntime = require('./agent-runtime-mode').usesNativeAgentRuntime(kind);
    const isNativeCodex = isCodex && nativeAgentRuntime;
    const isPtyAgent = isProviderCli || isCodeAgent || ((isClaude || isCodex) && !nativeAgentRuntime) || (isDeepSeek && !isDeepSeekLegacy);
    const webRoute = isCodex && require('./chatgpt-web-models').chatgptWebRoute(opts.model);
    const followsGlobalAccount = isCodex && !webRoute && !isCodexApiBackend(getConfigValues());
    let globalAccount = null;
    if (followsGlobalAccount) {
      const accounts=require('./codex-global-account');
      const launch = accounts.prepareLaunch(opts,accounts.currentConfig());
      clearSessionManagerConfigCache();
      opts = launch.opts;
      globalAccount = launch.account;
    }
    if (webRoute) {
      require('./chatgpt-web-integration').requireWebTools(opts.model);
      if (opts.effort && opts.effort !== webRoute.effort) throw new Error('ChatGPT 模型与思考档不匹配');
      opts = { ...opts, effort: webRoute.effort, codexSpeedTier: 'inherit' };
    }
    if (isCodex) {
      if (opts.model && !isCodexConversationModelId(opts.model)) throw new Error('Codex 模型名称无效，未替换成默认模型');
      if (opts.effort && !CODEX_EFFORT_LEVELS.has(opts.effort)) throw new Error('Codex 思考档无效，未降低精度');
      if (opts.mcpProfile && !CODEX_MCP_PROFILES.has(opts.mcpProfile)) throw new Error('Codex MCP 配置档无效');
      if (opts.codexSpeedTier && !CODEX_SPEED_TIERS.has(opts.codexSpeedTier)) throw new Error('Codex 服务通道无效');
      if (opts.contextMax != null && !normalizeCodexContextWindow(opts.contextMax)) throw new Error('Codex 上下文配置无效');
      const nativeConfig=getConfigValues();
      if(!webRoute && nativeConfig.CODEX_BACKEND==='api' && !nativeConfig.CODEX_API_KEY) throw new Error('Codex API 账号未配置密钥，未切换到订阅账号');
      if(!webRoute && opts.codexProfile && resolveCodexSubscriptionProfile(nativeConfig,opts.codexProfile).id!==opts.codexProfile) throw new Error('Codex 账号配置不存在，未切换到默认账号');
    }
    if ((isCodex || isClaude || isCodeAgent || isDeepSeekLegacy) && this.sessions.has(id)) throw new Error('该 Hub 会话仍然存在，请返回原会话；不能重复接管');
    if (isCodex && opts.codexSid && opts.useResume) {
      for (const live of this.sessions.values()) {
        if (live.info?.codexSid === opts.codexSid && live.info.status !== 'dormant') {
          throw new Error('该 Codex 原生会话仍在另一个窗口中，请等待原会话关闭后恢复');
        }
      }
    }
    const isCodexRuntime = isCodex || (isDeepSeek && !isDeepSeekLegacy);
    const isKimi = isKimiCliKind(kind);
    const isAgent = isClaude || isGemini || isCodexRuntime || isDeepSeekLegacy || isKimi || isAcp || isCodeAgent;
    let title;
    if (opts.title) title = opts.title;
    else if (isAcp) title = ACP_LABELS[kind.replace(/-resume$/, '')];
    else if (kind === 'claude') title = `Claude ${++this.claudeCounter}`;
    else if (kind === 'claude-resume') title = `Claude Resume ${++this.resumeCounter}`;
    else if (kind === 'gemini') { this.geminiCounter = (this.geminiCounter || 0) + 1; title = `Gemini ${this.geminiCounter}`; }
    else if (webRoute) { this.codexCounter = (this.codexCounter || 0) + 1; title = `${webRoute.label} ${this.codexCounter}`; }
    else if (kind === 'codex') { this.codexCounter = (this.codexCounter || 0) + 1; title = `Codex ${this.codexCounter}`; }
    else if (kind === 'deepseek') { this.deepseekCounter = (this.deepseekCounter || 0) + 1; title = `DeepSeek ${this.deepseekCounter}`; }
    else if (kind === 'kimi') { this.kimiCounter = (this.kimiCounter || 0) + 1; title = `Kimi ${this.kimiCounter}`; }
    else if (kind === 'codeagent') { this.codeagentCounter = (this.codeagentCounter || 0) + 1; title = `CodeAgent ${this.codeagentCounter}`; }
    else if (kind === 'gemini-resume') title = `Gemini Resume ${++this.resumeCounter}`;
    else if (kind === 'codex-resume') title = `Codex Resume ${++this.resumeCounter}`;
    else if (kind === 'deepseek-resume') title = `DeepSeek Resume ${++this.resumeCounter}`;
    else if (kind === 'kimi-resume') title = `Kimi Resume ${++this.resumeCounter}`;
    else if (kind === 'codeagent-resume') title = `CodeAgent Resume ${++this.resumeCounter}`;
    else title = `PowerShell ${++this.psCounter}`;

    const sessionEnv = { ...process.env };
    applyInteractiveTerminalEnv(sessionEnv, { truecolor: isPtyAgent && (isClaude || isCodexRuntime || isCodeAgent) });
    let codexProfile = null;
    const codeagentConfig = isCodeAgent ? require('./codeagent-config').resolveCodeAgentConfig(process.env) : null;

    if (isClaude) {
      const cv = getConfigValues();
      applyClaudeSessionEnv(sessionEnv, cv);
      // Attribution + auth for the Stop/UserPromptSubmit hook script (both modes)
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      // Propagate data-dir override so the statusline script writes its cache
      // into the isolated test dir instead of the production ~/.ai-hub-community.
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isCodeAgent) {
      // 配置目录（相当于 CLAUDE_CONFIG_DIR）显式交给 CLI；证书与代理由它自己的 .bat 包装处理，这里不动代理。
      sessionEnv[codeagentConfig.configDirEnv] = codeagentConfig.configDir;
      // 同事电脑上的 CodeTeam 也往同一份 settings.json 登记 hook，它只认 CODEAGENT_HUB_*。
      // 从 CodeTeam 里启动的 Hub 会继承这些变量，清掉才不会把我们的会话事件投给它。
      for (const key of Object.keys(sessionEnv)) {
        if (/^CODEAGENT_HUB_/.test(key) || key === 'CODEAGENT3_LAUNCHER_PID') delete sessionEnv[key];
      }
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      if (process.env.CLAUDE_HUB_DATA_DIR) sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
    } else if (isDeepSeekLegacy) {
      const cv = getConfigValues();
      clearProxyEnv(sessionEnv);
      sessionEnv.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
      sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.DEEPSEEK_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude-deepseek');
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      if (process.env.CLAUDE_HUB_DATA_DIR) sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
    } else if (webRoute) {
      clearProxyEnv(sessionEnv);
      const isolation = require('./chatgpt-isolation').isolatedPaths();
      sessionEnv.CODEX_HOME = isolation.codexHome;
      sessionEnv.CODEX_CHATGPT_WEB_HOME = isolation.runtime;
      delete sessionEnv.OPENAI_BASE_URL;
      delete sessionEnv.OPENAI_API_KEY;
      delete sessionEnv.CODEX_API_KEY;
    } else if (isGemini || isCodex) {
      const cv = getConfigValues();
      if (isCodex && isCodexApiBackend(cv)) {
          // Codex API 模式必须直连，否则代理 60s idle 切长任务
        clearProxyEnv(sessionEnv);
        sessionEnv.CODEX_HOME = getCodexApiHome();
      } else {
        if (isCodex) {
          if (opts.meetingId && !opts.codexProfile) {
            // 群聊 Codex 统一用默认 ~/.codex/，记忆汇合到一处方便管理
            // 跟 Hub 直开 Codex 共享 1.9MB 历史记忆库
            delete sessionEnv.CODEX_HOME;
          } else {
            // 非群聊（Hub 直开 Codex）保留原有 profile 逻辑
            codexProfile = resolveCodexSubscriptionProfile(cv, opts.codexProfile);
            if (codexProfile.home) {
              sessionEnv.CODEX_HOME = codexProfile.home;
            } else {
              delete sessionEnv.CODEX_HOME;
            }
          }
        }
        // Gemini 走 google.com / Codex 订阅走 openai.com，需走代理过 GFW
        applyProxyEnv(sessionEnv, cv.CLAUDE_PROXY);
      }
    } else if (isDeepSeek) {
      const cv = getConfigValues();
      // V4 Pro / Flash 的 Responses API 国内直连。Key 只走 env_key，不落进
      // config.toml / auth.json；CODEX_HOME 在拿到真实 cwd 后再生成。
      clearProxyEnv(sessionEnv);
      sessionEnv.DEEPSEEK_API_KEY = cv.DEEPSEEK_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      delete sessionEnv.ANTHROPIC_BASE_URL;
      delete sessionEnv.ANTHROPIC_AUTH_TOKEN;
      delete sessionEnv.CLAUDE_CONFIG_DIR;
    } else if (isKimi) {
      // Kimi Code 会员登录与会话目录由官方 CLI 管理；国内端点默认直连，
      // 避免继承 Hub 的 Gemini/Codex 海外代理后让长流式请求被中途切断。
      clearProxyEnv(sessionEnv);
    }

    // Merge extra env vars (used by TeamSessionManager for MCP config etc.)
    if (opts.extraEnv) {
      Object.assign(sessionEnv, opts.extraEnv);
    }

    const shellArgs = isAgent ? ['-NoProfile', '-NoLogo'] : [];
    // cwd fallback order: opts.cwd (if exists) -> user home. We stat-check to
    // avoid node-pty failing if the stored cwd was later deleted/moved.
    //
    // 2026-07-29 三方审查：workspace 迁到 C:\Workspace 之后，唤醒一个 cwd 已失效的休眠会话会
    // 悄悄落回 Home 起 PTY——UI 零提示、session 记录还显示旧路径，于是「规则没注入 / 记忆
    // 是空的 / 产物写错地方」在 Home 这个聚合根上同时发生，而现场没有任何线索指向 cwd。
    // fallback 本身要保留（否则 node-pty 直接抛错更难用），但必须留痕：日志 + 会话上标记，
    // 让 UI 能把「这个会话已回落到 Home」显示出来。
    let spawnCwd = opts.cwd;
    // dormant 会话若上一轮已经回落，后续 resume 的 cwd=Home 本身是有效目录，必须把
    // 原始失败路径继续带着，否则警告会在第二次唤醒时凭空消失。
    let cwdFellBack = opts.cwdFellBackFrom ? String(opts.cwdFellBackFrom) : null;
    if (spawnCwd) {
      try {
        if (!fs.statSync(spawnCwd).isDirectory()) throw new Error('cwd is not a directory');
      } catch {
        cwdFellBack = spawnCwd;
        spawnCwd = null;
      }
    }
    if (!spawnCwd) {
      spawnCwd = process.env.USERPROFILE || process.env.HOME || '.';
      if (cwdFellBack) {
        console.warn(`[cwd] 会话 ${id} 的 cwd 已失效，回落到 ${spawnCwd}：${cwdFellBack}`);
      }
    }

    if (isCodex && cwdFellBack) throw new Error('Codex 工作目录不存在，未启动：' + cwdFellBack);

    // Claude 与旧 DeepSeek-Claude 的入口从这里把 cwd 的
    // memory 桶链到规范记忆库，否则每个 _scratch\inbox-* 都是零记忆开局。
    // 不能让 Codex / Kimi / PowerShell 的启动顺带迁移 Claude 的记忆目录：这段逻辑现在
    // 可能合并真实目录并换 junction，必须只由真正消费该机制的 CLI 触发。
    // 隔离 Hub / E2E 不碰用户主目录的记忆库。
    let memoryLinkWarning = null;
    if (!process.env.CLAUDE_HUB_DATA_DIR) {
      if (isClaude || isDeepSeekLegacy) {
        // ensureMemoryLink **从不 throw** —— 四种保护（错链 / 非普通文件 / memory 是文件 /
        // 锁竞争）全部收进 result.errors 返回。原先这里只写了个 catch 就把返回值丢了，
        // 于是那些保护一条都到不了用户：会话照常起，记忆却接在错误的库上或压根没接，
        // 现场没有任何线索。而同一轮里 cwd 回落已经有了完整的留痕链路，标准不该不一致。
        // 走同一条通道：session 上留痕 → 持久化白名单 → resume → 侧栏/弹窗。
        try {
          const memResult = ensureMemoryLink(spawnCwd, {
            projectRootDirs: [isDeepSeekLegacy ? '.claude-deepseek' : '.claude'],
          });
          if (memResult && memResult.errors.length) {
            memoryLinkWarning = memResult.errors.join('；');
            console.warn('[memory] link 未完成：', memoryLinkWarning);
          }
          if (memResult && (memResult.merged.length || memResult.conflicts.length)) {
            console.log(`[memory] 回收孤岛：并入 ${memResult.merged.length} 条，冲突另存 ${memResult.conflicts.length} 条`);
          }
        } catch (error) {
          memoryLinkWarning = error && error.message ? error.message : String(error);
          console.warn('[memory] ensureMemoryLink failed:', memoryLinkWarning);
        }
      }
      // Missing workspace rules are supplied by the shared submission path;
      // launching Kimi must not manufacture another AGENTS.md in its cwd.
    }

    if (isClaude) {
      const cv = getConfigValues();
      opts.model = resolveClaudeLaunchModel(cv, opts.model);
    }

    let codexSessionsRoot = null;
    let codexPtySqliteHome = null;
    if (webRoute) {
      codexSessionsRoot = path.join(sessionEnv.CODEX_HOME, 'sessions');
    } else if (isDeepSeek && !isDeepSeekLegacy) {
      const profile = ensureDeepSeekCodexProfile(spawnCwd);
      sessionEnv.CODEX_HOME = profile.codexHome;
      codexSessionsRoot = path.join(profile.codexHome, 'sessions');
      codexProfile = { id: 'deepseek-api', label: 'DeepSeek API · Codex' };
    } else if (isCodex) {
      const cv = getConfigValues();
      const selectedSubscriptionProfile = globalAccount ? { ...globalAccount,home:globalAccount.home } : codexProfile
        || (!opts.meetingId ? resolveCodexSubscriptionProfile(cv, opts.codexProfile) : null);
      const isolatedDataDir = process.env.CLAUDE_HUB_DATA_DIR || '';
      const selectedProfileHome = selectedSubscriptionProfile && selectedSubscriptionProfile.home;
      let selectedProfileHomeAllowed = !!selectedProfileHome;
      if (selectedProfileHomeAllowed && isolatedDataDir) {
        const testRoot = path.dirname(path.resolve(isolatedDataDir));
        const relative = path.relative(testRoot, path.resolve(selectedProfileHome));
        selectedProfileHomeAllowed = relative === ''
          || (!relative.startsWith('..') && !path.isAbsolute(relative));
        if(!selectedProfileHomeAllowed && opts.codexProfile) throw new Error('选定 Codex 账号不在隔离目录内，未替换账号或启动会话');
      }
      if (isCodexApiBackend(cv)) {
        sessionEnv.CODEX_HOME = ensureCodexApiProfile(cv, spawnCwd);
        // API 模式 codex 把 rollout 写到 isolated home（不写 ~/.codex/sessions）。
        // 记到 info 让 transcript-tap 注册时把这个 root 加进 CodexTap 的扫描列表。
        codexSessionsRoot = path.join(sessionEnv.CODEX_HOME, 'sessions');
      } else if (selectedProfileHomeAllowed) {
        codexProfile = selectedSubscriptionProfile;
        sessionEnv.CODEX_HOME = selectedProfileHome;
        ensureCodexCwdTrusted(spawnCwd, selectedProfileHome);
        codexSessionsRoot = path.join(selectedProfileHome, 'sessions');
      } else if (process.env.CLAUDE_HUB_DATA_DIR && process.env.CODEX_HOME) {
        // A test Hub's isolation boundary applies to ordinary Codex sessions
        // too, not only meeting members. Falling through to the default
        // subscription profile silently writes credential-backed diagnostics
        // into the real ~/.codex session store.
        sessionEnv.CODEX_HOME = process.env.CODEX_HOME;
        ensureCodexCwdTrusted(spawnCwd, process.env.CODEX_HOME);
        codexSessionsRoot = path.join(process.env.CODEX_HOME, 'sessions');
        if (selectedProfileHome && !selectedProfileHomeAllowed) {
          console.warn(`[codex] isolated Hub ignored external profile home: ${selectedProfileHome}`);
        }
      } else if (opts.meetingId) {
        delete sessionEnv.CODEX_HOME;
        ensureCodexCwdTrusted(spawnCwd);
        // codexSessionsRoot 保持 null，让 CodexTap 扫默认 ~/.codex/sessions
      } else {
        codexProfile = selectedSubscriptionProfile || resolveCodexSubscriptionProfile(cv, opts.codexProfile);
        if (codexProfile.home) {
          sessionEnv.CODEX_HOME = codexProfile.home;
          ensureCodexCwdTrusted(spawnCwd, codexProfile.home);
          // 非默认订阅账号也有独立 rollout root，否则 CodexTap 只扫 ~/.codex/sessions。
          codexSessionsRoot = path.join(codexProfile.home, 'sessions');
        } else {
          delete sessionEnv.CODEX_HOME;
          ensureCodexCwdTrusted(spawnCwd);
        }
      }
      // 换账号后恢复/分叉旧会话：凭据跟新账号，线程索引留在原历史所在的账号，
      // 否则 `codex resume <sid>` 在新账号里报 "No saved session found"。
      // 只作用于这一条 resume/fork 命令（-c sqlite_home），不写进 PTY 的 shell 环境：
      // CLI 退出后在同一终端里新开的 codex 必须回到当前账号自己的索引。
      const historyHome = opts.codexHistoryStorageHome;
      const liveHome = sessionEnv.CODEX_HOME || path.join(os.homedir(),'.codex');
      if (isPtyAgent && followsGlobalAccount && historyHome && (opts.codexForkSid || (opts.useResume && opts.codexSid))
          && path.toNamespacedPath(path.resolve(historyHome)).toLowerCase() !== path.toNamespacedPath(path.resolve(liveHome)).toLowerCase()) {
        codexPtySqliteHome = require('./codex-global-account')
          .historySqliteHomeSync(historyHome, opts.nativeRuntime && opts.nativeRuntime.sqliteHome, sessionEnv);
        // 以 PowerShell 双引号包 TOML 字面量字符串传参；这些字符无法无歧义地穿过两层引用。
        if (/['"`$\r\n]/.test(codexPtySqliteHome)) throw new Error('旧 Codex 历史目录含引号或 $，无法安全传给 CLI，未恢复');
      }
    }

    const isNativeClaude = (isClaude && nativeAgentRuntime) || isDeepSeekLegacy;
    // 个人规则同步与运行时无关：PTY 与原生的 Claude 都读同一个 CLAUDE_CONFIG_DIR。
    const contextKind = isCodexRuntime ? 'codex' : (isClaude || isDeepSeekLegacy) ? 'claude' : isKimi ? 'kimi' : isGemini ? 'gemini' : null;
    if(opts.assistantMcpEntry) require('./hub-assistant/project-tools').configureProjectTools(kind,{...opts,id},spawnCwd);
    if (contextKind) {
      const contextHome = contextKind === 'codex' ? sessionEnv.CODEX_HOME || path.join(os.homedir(),'.codex')
        : contextKind === 'claude' ? sessionEnv.CLAUDE_CONFIG_DIR || path.join(os.homedir(),'.claude')
        : contextKind === 'kimi' ? sessionEnv.KIMI_CODE_HOME || path.join(os.homedir(),'.kimi-code') : path.join(sessionEnv.GEMINI_CLI_HOME || os.homedir(),'.gemini');
      require('./agent-user-context').syncNativeUserContext({kind:contextKind,nativeHome:contextHome,env:sessionEnv,dataDir:getHubDataDir()});
    }
    if (followsGlobalAccount) codexSessionsRoot = opts.codexSessionsRoot;
    if (isCodexRuntime) {

      for (const key of ['CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_HUB_SESSION_ID',
        'CLAUDE_HUB_PORT','CLAUDE_HUB_TOKEN','AI_TEAM_HUB_CALLBACK_URL']) delete sessionEnv[key];
      if (!isNativeCodex) {
        // PTY Codex 的状态与卡片绑定都靠 hook：session-hub-hook.py 只认这三个变量。
        sessionEnv.CLAUDE_HUB_SESSION_ID = id;
        if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
        if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
        if (process.env.CLAUDE_HUB_DATA_DIR) sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    }
    let claudePtyLaunch = null;
    if (isClaude && isPtyAgent) {
      // 与 PTY 时代（8c5c6928）相同：spawn 前预写 projects[cwd].hasTrustDialogAccepted，
      // 信任框根本不出现；写在 CLI 起来之前，没有与运行中 CLI 的竞态。
      require('./claude-project-trust.js').ensureClaudeProjectTrusted(spawnCwd,
        { configDir: sessionEnv.CLAUDE_CONFIG_DIR || null });
      claudePtyLaunch = buildClaudePtyLaunch(id, kind, opts, spawnCwd, sessionEnv, getConfigValues());
      // 身份在启动前就定下来：独占声明和卡片都立即可用，不等第一个 hook。
      if (claudePtyLaunch.sessionId && !opts.forkCCSessionId) opts = { ...opts, resumeCCSessionId: claudePtyLaunch.sessionId };
    }
    let codeagentLaunch = null;
    if (isCodeAgent) {
      // .cac.json 的 projects 也预写信任（--skip-safe-check 之外的第二道保险）。
      require('./claude-project-trust.js').ensureClaudeProjectTrusted(spawnCwd,
        { configDir: codeagentConfig.configDir, stateFileName: codeagentConfig.stateFile });
      codeagentLaunch = buildCodeAgentPtyLaunch(id, kind, opts, spawnCwd, sessionEnv, codeagentConfig);
      // 只有真正 --resume 已有记录时身份才已知；其余一律清空，等第一个 hook 绑定。
      // 留着一个 CLI 不会用的旧 id，后面每个 hook 都会被当成外来会话丢弃。
      opts = { ...opts, resumeCCSessionId: codeagentLaunch.sessionId || undefined,
        resumeTranscriptPath: codeagentLaunch.sessionId ? opts.resumeTranscriptPath : undefined };
    }
    // Every native driver is owned directly by this Hub; no cross-Hub broker.
    const CodexSessionClass = require('./codex-native-session').CodexNativeSession;
    this._claimNativeOpenIdentity(id, kind, opts, sessionEnv);
    let codexEditorInput = null;
    if (isCodexRuntime && !isNativeCodex && !isAcp) {
      // 只装了官方原生 Codex、它的目录还没进入本进程 PATH 时，给这个会话补上，终端里输入 codex 才找得到。
      if (process.platform === 'win32') {
        try { require('../main/codex-windows-command').ensureCodexOnSessionPath(sessionEnv); }
        catch (error) { console.warn('[codex-path] could not check the Codex install folder:', error.message); }
      }
      try {
        codexEditorInput = require('./codex-editor-input').configureCodexEditorInput(sessionEnv,
          { dataDir: getHubDataDir(), cwd: spawnCwd });
      } catch (error) { console.warn('[codex-editor-input] unavailable, retaining PTY paste:', error.message); }
    }
    let ptyProcess;
    try { ptyProcess = isAcp
      ? new (isProviderCli ? (kind.replace(/-resume$/, '') === 'qwen' ? require('./qwen-cli-session').QwenCliSession : require('./martty-cli-session').MarttyCliSession) : require('./acp-session').AcpSession)(buildAcpOptions(kind,
        {...opts,id,cwd:spawnCwd},getConfig(),getHubDataDir(),sessionEnv))
      : isNativeCodex
      ? new CodexSessionClass({id,cwd:spawnCwd,env:sessionEnv,exclusiveSession:true,restoredRuntime:opts.nativeRuntime,
        ...(followsGlobalAccount ? {accountId:globalAccount.id,ownershipHome:opts.codexHistoryHome,
          historyStorageHome:opts.codexHistoryStorageHome,
          resolveAccount:()=>{
            const accounts=require('./codex-global-account');
            return accounts.resolveRunningAccount(accounts.currentConfig(),{
              id:ptyProcess.options.accountId,label:info.codexProfileLabel,
              home:ptyProcess.options.env.CODEX_HOME});
          },resolveLaunchAccount:()=>{
            const accounts=require('./codex-global-account');
            return accounts.resolveAccount(accounts.currentConfig());
          }} : {}),
        hubDataDir:getHubDataDir(),hubPid:process.pid,hubVersion:require('../package.json').version,
        lazyStart:opts.lazyStart === true, resumeId:opts.useResume ? opts.codexSid : null, forkId:opts.codexForkSid})
      : isNativeClaude ? createNativeClaudeDriver(id, kind, opts, spawnCwd, sessionEnv, isDeepSeekLegacy)
      : pty.spawn(windowsPowerShellPath(), shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: spawnCwd,
      env: sessionEnv,
      useConpty: true,
      // conptyInheritCursor=true kills PTY output for headless sessions (no
      // renderer xterm attached). TeamSessionManager sets noInheritCursor for
      // background character sessions. Normal user sessions don't set it, so
      // the default stays true for backward compatibility.
      // Codex's TUI does dense cursor-addressed redraws; inheriting the host
      // cursor makes Windows ConPTY more prone to transient cursor ghosts.
      conptyInheritCursor: (isCodexRuntime || isKimi) ? false : !opts.noInheritCursor,
    });
    } catch (error) { codexEditorInput?.dispose(); throw error; }

    let currentModel = null;
    if (isClaude) {
      // 默认走 DEFAULT_MODEL_BY_KIND.claude（当前 Opus 5 1M）；
      // AI 群聊 Modal 选 sonnet-4.5 等时透传 opts.model。
      const mid = opts.model || DEFAULT_MODEL_BY_KIND.claude;
      currentModel = { id: mid, displayName: mid };
    } else if (isGemini) {
      const mid = opts.model || 'gemini-3-pro-preview';
      currentModel = { id: mid, displayName: SessionManager.geminiDisplayName(mid) };
    } else if (isCodex) {
      const cv = getConfigValues();
      // opts.model（modal/picker 用户选择）必须最高优先级；只有未传时才落到 backend 默认 / DEFAULT_MODEL_BY_KIND.codex。
      // 旧写法 `isCodexApiBackend ? cv.CODEX_API_MODEL : (opts.model || ...)` 在 packy api 模式下
      // 强制覆盖用户选择，AI 群聊选 5.4/5.3 实际跑出来都是 5.5。
      const cmid = normalizeCodexSessionModel(opts.model || resolveDefaultCodexModel(cv));
      currentModel = { id: cmid, displayName: webRoute ? webRoute.label : cmid.toUpperCase() };
    } else if (isDeepSeek) {
      const mid = isDeepSeekLegacy
        ? normalizeLegacyDeepSeekClaudeModel(opts.model)
        : normalizeDeepSeekModel(opts.model);
      currentModel = {
        id: mid,
        displayName: isDeepSeekLegacy
          ? legacyDeepSeekClaudeDisplayName(mid)
          : deepseekDisplayName(mid),
      };
    } else if (isKimi) {
      const mid = opts.model || DEFAULT_MODEL_BY_KIND.kimi;
      currentModel = { id: mid, displayName: mid === 'kimi-code/k3' || mid === 'k3' ? 'Kimi K3' : mid };
    } else if (isCodeAgent) {
      const mid = require('./codeagent-config').normalizeCodeAgentModel(opts.model);
      currentModel = { id: mid, displayName: mid };
    }

    const effectiveCodexMcpProfile = isCodexRuntime
      ? resolveCodexMcpProfile(kind, opts.mcpProfile)
      : null;
    const effectiveCodexSpeedTier = isCodexRuntime
      ? resolveCodexSpeedTier(kind, opts.codexSpeedTier)
      : null;
    const normalizedContextMax = normalizeCodexContextWindow(opts.contextMax);
    const effectiveContextMax = isCodexRuntime
      ? resolveCodexContextWindow(currentModel && currentModel.id, normalizedContextMax, { configDir: sessionEnv.CODEX_HOME })
      : (typeof opts.contextMax === 'number' ? opts.contextMax : null);

    const now = Date.now();
    // 分支的 resumeTranscriptPath 是「源会话」的记录，只给原生 thread/fork 当参数用；终端里的
    // `codex fork` 会开新线程，不能预先挂上源路径（见下方 transcriptPath）。
    const ptyCodexForkLaunch = !!opts.codexForkSid && !isNativeCodex;
    const info = {
      id,
      kind,
      freshLaunch,
      ...(isNativeClaude ? { runtimeBackend: 'claude-stream-json', nativeRuntime: ptyProcess.runtime,
        ccSessionId: ptyProcess.sessionId,
        nativeConfig: require('./claude-native-launch').claudeNativeResumeConfig({ ...opts,
          permissionMode: opts.permissionMode || (opts.autonomous === true || isDeepSeekLegacy ? 'bypassPermissions' : undefined) }) } : {}),
      title,
      status: 'idle',
      ...(isNativeCodex ? {runtimeBackend:'codex-app-server',nativeRuntime:ptyProcess.runtime,
        codexApprovalPolicy:opts.approvalPolicy || 'never',codexSandbox:opts.sandbox || 'danger-full-access'} : {}),
      ...(isAcp ? {runtimeBackend:'acp',nativeRuntime:ptyProcess.runtime,acpSid:opts.acpSid || null,
        cliRuntime:isProviderCli?{...ptyProcess.runtime,source:'provider-cli',observedAt:Date.now()}:null,
        acpProfileId:ptyProcess.options.profileId,acpCapabilities:{},acpConfigOptions:[]} : {}),
      connectionIssue: null,
      lastMessageTime: opts.lastMessageTime || now,
      lastOutputPreview: opts.lastOutputPreview || '',
      unreadCount: 0,
      ...(opts.pinned ? { pinned: true } : {}),
      ...(opts.bottomed && !opts.pinned ? { bottomed: true } : {}),
      createdAt: now,
      cwd: spawnCwd,
      // 原 cwd 失效被迫回落时留痕，UI 据此提示「这个会话没跑在它原来的目录里」。
      ...(cwdFellBack ? { cwdFellBackFrom: cwdFellBack } : {}),
      // 必须显式携带 null：resume 时 renderer 会用 {...旧会话, ...新会话} 合并；若成功
      // 场景省略字段，旧的 warning 会继续粘在 UI 上，即使本轮检测已经恢复正常。
      memoryLinkWarning: memoryLinkWarning || null,
      ...(opts.workspaceLabel ? { workspaceLabel: String(opts.workspaceLabel) } : {}),
      meetingId: opts.meetingId || null,
      // Delivery is opt-in per conversation. Never inherit the former global
      // switch into a newly-created session.
      completionNotificationEnabled: opts.completionNotificationEnabled === true,
      ...(opts.purpose ? { purpose: String(opts.purpose) } : {}),
      ...(opts.researchSessionId ? { researchSessionId: String(opts.researchSessionId) } : {}),
      ...(opts.hiddenFromSidebar ? { hiddenFromSidebar: true } : {}),
      currentModel,
      ...(typeof opts.contextPct === 'number' ? { contextPct: opts.contextPct } : {}),
      ...(typeof opts.contextUsed === 'number' ? { contextUsed: opts.contextUsed } : {}),
      ...(opts.sessionUsage ? { sessionUsage: opts.sessionUsage } : {}),
      ...(typeof effectiveContextMax === 'number' ? { contextMax: effectiveContextMax } : {}),
      // contextMax is the launch request and must remain stable for
      // resume/fork/relaunch. Codex reports the clamped effective value later
      // through token_count; keep that observation in a separate field.
      ...(typeof opts.contextEffectiveMax === 'number' ? { contextEffectiveMax: opts.contextEffectiveMax } : {}),
      ...(typeof opts.contextEffectiveObservedAt === 'number'
        ? { contextEffectiveObservedAt: opts.contextEffectiveObservedAt }
        : {}),
      codexSessionsRoot,
      // registerSessionForTap uses this internal routing hint while the public
      // kind remains "deepseek" for branding and family identity.
      ...(isDeepSeekLegacy ? { transcriptKind: kind === 'deepseek-resume' ? 'deepseek-legacy-resume' : 'deepseek-legacy' } : {}),
      ...(isCodexRuntime && codexProfile ? { codexProfile: codexProfile.id, codexProfileLabel: codexProfile.label } : {}),
      ...(isCodexRuntime ? { mcpProfile: effectiveCodexMcpProfile } : {}),
      // 速度通道必须连同 inherit 一起落盘，否则显式选择"跟随全局"的会话在
      // resume/relaunch 后会被 Codex 新默认 Fast 覆盖。
      ...(isCodexRuntime ? { codexSpeedTier: effectiveCodexSpeedTier } : {}),
      // Claude 家族的 MCP 档位默认 full（全量继承，与改动前一致），与 Codex 的
      // none 默认各走各的。落到 info 是为了 resume/fork/relaunch 能沿用。
      ...(isClaudeFamily(kind) && !isDeepSeekLegacy
        ? { mcpProfile: normalizeClaudeMcpProfile(opts.mcpProfile) } : {}),
      // 迁移前的 DeepSeek 仍跑 Claude CLI。旧群聊没有 profile 字段时按历史的
      // strict/空全局 MCP 语义回落 Lean；恢复与原地 relaunch 都据此重建。
      ...(isDeepSeekLegacy
        ? { mcpProfile: normalizeClaudeMcpProfile(opts.mcpProfile || 'lean') } : {}),
      // fast 只对 Claude 家族有意义；显式关掉才落盘，避免给老会话凭空加字段。
      ...(opts.fastMode === false ? { fastMode: false } : {}),
      // autonomous = 由自动赛程驱动、没有人在终端前的会话。落盘是为了 relaunch /
      // resume 能重建同一套旁路（权限、plugin 隔离、strict MCP、关 fast）；漏掉任何
      // 一项，重启后的 Agent 都会在下一次自动 prompt 时静默卡住。
      ...(opts.autonomous === true ? { autonomous: true } : {}),
      // 记录经过 runtime 白名单归一化的 effort，让 resume / fork / relaunch
      // 沿用同一档位。不要直接存 opts.effort：否则非法 IPC 值虽然首次启动会
      // 回落，却会污染元数据并在后续恢复时再次扩散。
      ...(isClaude && CLAUDE_EFFORT_LEVELS.has(opts.effort) ? { effort: opts.effort } : {}),
      ...(isCodeAgent && require('./codeagent-config').EFFORTS.includes(opts.effort) ? { effort: opts.effort } : {}),
      // 身份待绑定：main.js 的 hook 路由据此接受第一个 hook 上报的原生 id（见 codeagentIdentityPending）。
      ...(isCodeAgent ? { codeagentConfigDir: codeagentConfig.configDir, codeagentIdentityPending: !codeagentLaunch.sessionId } : {}),
      ...(isCodexRuntime && opts.effort ? { effort: normalizeCodexEffort(opts.effort) } : {}),
      ...(opts.codexSid ? { codexSid: opts.codexSid } : {}),
      ...(opts.geminiChatId ? { geminiChatId: opts.geminiChatId } : {}),
      ...(opts.geminiProjectHash ? { geminiProjectHash: opts.geminiProjectHash } : {}),
      ...(opts.geminiProjectRoot ? { geminiProjectRoot: opts.geminiProjectRoot } : {}),
      ...(opts.kimiSid ? { kimiSid: opts.kimiSid } : {}),
      ...(opts.kimiSessionDir ? { kimiSessionDir: opts.kimiSessionDir } : {}),
      ...(isCodexRuntime && (kind.endsWith('-resume') || opts.codexResumePicker || (opts.useResume && !opts.codexSid)) ? { codexAllowMtimeFallback: true } : {}),
      ...(opts.userRenamed ? { userRenamed: true } : {}),
      ...(opts.autoTitleGenerated ? { autoTitleGenerated: true } : {}),
      ...(opts.branchSourceSessionId ? { branchSourceSessionId: String(opts.branchSourceSessionId) } : {}),
      ...(Number.isInteger(Number(opts.branchIndex)) && Number(opts.branchIndex) > 0
        ? { branchIndex: Number(opts.branchIndex) }
        : {}),
      ...(typeof opts.branchAutoTitlePending === 'boolean'
        ? { branchAutoTitlePending: opts.branchAutoTitlePending }
        : {}),
      // Spec 3 · W3 resume bug fix (a)：resume 启动时立即写入已知 ccSessionId，
      // 不等 Stop hook 第一次回调。否则 spawn 到第一次 Stop 之间 (~数秒) 卡片视图
      // 拿不到 ccSessionId → IPC parse-session-transcript 返 'transcript not found' → 空白。
      // 普通新建（非 resume）opts.resumeCCSessionId 为 undefined，info.ccSessionId 也为 undefined，
      // _toPublic 的 `info.ccSessionId !== undefined` 检查会跳过该字段，行为不变。
      ...(opts.resumeCCSessionId ? { ccSessionId: opts.resumeCCSessionId } : {}),
      ...(claudePtyLaunch && claudePtyLaunch.sessionId ? { ccSessionId: claudePtyLaunch.sessionId } : {}),
      // 分支的 resumeTranscriptPath 是「源会话」的记录，只给原生 thread/fork 当参数用。
      // 终端里的 `codex fork` 会开一条新线程：预先写上源路径，CodexTap 就把分支绑到
      // 源 rollout、登记源的线程 id，新线程的 hook 全被当成外来会话丢弃（2026-09-26 实测）。
      ...(opts.resumeTranscriptPath && !ptyCodexForkLaunch ? { transcriptPath: opts.resumeTranscriptPath } : {}),
      // 恢复时 renderer 会把旧会话元数据与新会话合并；原生时代留下的后端与
      // 快照必须显式清空，否则 PTY 会话会被当成原生会话去读状态。
      // 非 PTY 会话显式写空：agentRuntime 会落盘，原生回退模式下恢复时不能从休眠卡片上继承 'pty'。
      ...(isPtyAgent ? { runtimeBackend: null, nativeRuntime: null, agentRuntime: 'pty' } : { agentRuntime: null }),
    };

    const pendingTimers = [];
    // groupChatReady：群聊"快路径"缓存，CLI 首次 ready 后置 true，
    //   后续 groupChatWatcher.sendToPty 跳过 8s/8s/5s 硬 sleep；活性兜底失败时重置 false。
    // groupChatLastActivity：PTY 最近一次产出输出的 ms 时间戳，用于活性兜底判断。
    let terminalSnapshot = null;
    try {
      terminalSnapshot = new TerminalSnapshot({ cols: 120, rows: 30, scrollback: 10000 });
    } catch (error) {
      // Dependency/init failure must not prevent the CLI from starting. The old
      // The terminal ring remains available as an explicit degraded fallback.
      console.warn('[terminal-snapshot] init failed, using terminal ring fallback:', error && error.message);
    }
    this.sessions.set(id, {
      info,
      pty: ptyProcess,
      codexEditorInput,
      nativeRuleCoverage: require('./native-rule-coverage').captureNativeRuleCoverage({
        kind:isNativeClaude?'claude':isCodexRuntime?'codex':kind.replace(/-resume$/,''),cwd:spawnCwd,
        env:isAcp?ptyProcess.options.launch.env:sessionEnv,
        claudeSettingsFile:isNativeClaude?ptyProcess.options.settingsFile:null,settingSources:opts.settingSources}),
      codexMcpEntries: effectiveCodexMcpProfile !== 'none' && Array.isArray(opts.codexMcpEntries)
        ? opts.codexMcpEntries.map((entry) => ({ ...entry, env: { ...(entry.env || {}) } }))
        : [],
      // Claude 群聊的 research / 通信 MCP 在 CLI 原地 relaunch 时也要继续存在。
      claudeMcpConfigFile: typeof opts.mcpConfigFile === 'string' ? opts.mcpConfigFile : null,
      pendingTimers,
      ringBuffer: '',
      terminalSnapshot,
      // Codex's inline TUI uses partial-region scrolls that xterm.js drops
      // instead of committing to scrollback. Transform once at the shared PTY
      // boundary so the renderer, terminal-ring fallback, and TerminalSnapshot all see
      // the same lossless terminal stream. Legacy DeepSeek runs Claude and is
      // deliberately excluded; new DeepSeek uses the Codex runtime.
      terminalOutputRewriter: isCodexRuntime && !isNativeCodex ? new CodexXtermScrollbackRewriter({
        cols: 120,
        rows: 30,
        // On Windows, ConPTY consumes Codex's original region-scroll command
        // before node-pty sees it and emits a synchronized home-based repaint.
        // The rewriter handles that serialized form as well as raw VT streams.
        conptySerialized: process.platform === 'win32',
      }) : null,
      outputDelivery: null,
      lastOutputSeq: 0,
      groupChatReady: false,
      groupChatLastActivity: 0,
      // Monotonic PTY output counter for group-chat transport watchdogs.
      // `groupChatLastActivity` is a timestamp and must not be used as a byte
      // delta (a long-standing mismatch that made a continuously repainting
      // Codex input box look "active" forever while the prompt was still
      // waiting for Enter).
      groupChatOutputBytes: 0,
      // Main-process semantic lifecycle cursor shared by ordinary-session
      // status and group-chat submit acknowledgement.  PTY repaint is not
      // enough to prove that an agent actually started a turn.
      agentTurnStartSeq: 0,
      agentTurnStartedAt: 0,
      agentTurnStartSource: null,
      startedAt: now,
      lastInputAt: 0,
      lastOutputAt: 0,
      suspendRequestedAt: 0,
      suspendReason: null,
    });

    const deliverTerminalData = (terminalData) => {
      if (!terminalData) return;
      const current = this.sessions.get(id);
      if (!current || current.pty !== ptyProcess) return;
      this._appendToRingBuffer(id, terminalData);
      this._outputSeq += 1;
      const seq = this._outputSeq;
      current.lastOutputSeq = seq;
      if (current.terminalSnapshot) current.terminalSnapshot.write(terminalData, seq);
      this.onData(id, terminalData, seq);
      this.emit('output', { sessionId: id, seq, data: terminalData });
    };

    this.sessions.get(id).outputDelivery = new PtyOutputDelivery({
      emit: deliverTerminalData,
      rewriter: this.sessions.get(id).terminalOutputRewriter,
      onError: error => console.warn('[pty-output] terminal adapter failed:', error.message),
    });

    ptyProcess.onData((data) => {
      const entry = this.sessions.get(id);
      if (isNativeClaude || isNativeCodex) {
        // Display only, the same backstage contract Codex native sessions get.
        // Native items remain the single source of runtime state, so these
        // bytes must not feed activity counters, the CLI-ready detector or the
        // scrollback rewriter -- only the terminal pane.
        if (entry && entry.pty === ptyProcess) deliverTerminalData(data);
        return;
      }
      // Match the exit-path id-reuse guard: late bytes from an old PTY must
      // never mutate the replacement session's rewriter or terminal state.
      if (!entry || entry.pty !== ptyProcess) return;
      entry.codexEditorInput?.onOutput(data);
      entry.groupChatLastActivity = Date.now();
      entry.groupChatOutputBytes += Buffer.byteLength(String(data || ''), 'utf8');
      entry.lastOutputAt = entry.groupChatLastActivity;
      entry.outputDelivery.write(data);
    });

    ptyProcess.onExit((exitInfo) => {
      codexEditorInput?.dispose();
      if (isNativeClaude && !ptyProcess.closed) {
        // Keep the managed session and its unknown receipt available for explicit recovery.
        return;
      }
      const entry = this.sessions.get(id);
      if (entry && entry.pty === ptyProcess) entry.outputDelivery?.close();
      Promise.resolve(this._handlePtyExit(id, ptyProcess, exitInfo)).catch(error => {
        console.error('[session-release] history flush failed; ownership retained:', error);
        ptyProcess.emit?.('action-error', '历史保存失败，尚未释放会话：' + error.message);
      });
    });

    if (isNativeCodex || isAcp) {
      if (isNativeCodex) Object.assign(ptyProcess.options, buildNativeCodexOptions(info, opts, sessionEnv));
      if (followsGlobalAccount) ptyProcess.options.accountOptions = (_target,env) => {
        require('./agent-user-context').syncNativeUserContext({kind:'codex',nativeHome:env.CODEX_HOME,env,dataDir:getHubDataDir()});
        ensureCodexCwdTrusted(info.cwd,env.CODEX_HOME);
        const next=buildNativeCodexOptions(info,opts,env);
        return {processArgs:next.processArgs,threadParams:next.threadParams,turnParams:next.turnParams};
      };
      const publish = () => {
        if (this.sessions.get(id)?.pty !== ptyProcess) return;
        this.emit('codex-session-updated', this._toPublic(info));
      };
      ptyProcess.on('state', (runtime) => {
        if (!isProviderCli) info.nativeRuntime = runtime;
        else info.cliRuntime = { ...runtime, source:'provider-cli', observedAt:Date.now() };
        info.status = ['running','waiting'].includes(runtime.state) ? 'running' : 'idle';
        info.connectionIssue = null;
        const entry = this.sessions.get(id);
        if (entry) entry.groupChatReady = runtime.connection === 'connected';
        if (runtime.completedAt) info.lastCompletedAt = runtime.completedAt;
        publish();
        if (followsGlobalAccount && !ptyProcess.accountSwitch && (runtime.state === 'idle' || ['completed','failed','interrupted'].includes(runtime.state))) {
          setImmediate(() => {
            if (!ptyProcess.closed) this._syncCodexAccount(ptyProcess,info).catch(error=>ptyProcess.emit('action-error',error.message));
          });
        }
      });
      ptyProcess.on('account-changed', account => {
        info.codexProfile=account.id;info.codexProfileLabel=account.label;info.nativeActionError=null;
        if (!info.codexSid && !info.transcriptPath) info.codexSessionsRoot=path.join(account.home,'sessions');
        publish();
      });
      ptyProcess.on('bound', bound => {
        if (isAcp) {
          info.acpSid = bound.threadId;
          if (bound.capabilities) info.acpCapabilities = bound.capabilities;
          if (bound.configOptions) {
            info.acpConfigOptions = bound.configOptions;
            info.effort = bound.configOptions.find(o => o.category === 'thought_level')?.currentValue || null;
          }
        } else info.codexSid = bound.threadId;
        this._refreshOpenIdentity(id);
        if (bound.cwd) info.cwd = bound.cwd;
        if (Object.hasOwn(bound, 'path')) info.transcriptPath = bound.path;
        if (bound.model) info.currentModel = {id:bound.model,displayName:bound.model};
        if (bound.reasoningEffort) info.effort = bound.reasoningEffort;
        if (bound.codexSpeedTier) info.codexSpeedTier = bound.codexSpeedTier;
        publish();
      });
      ptyProcess.on('thread-reset', () => { info.codexSid=null; info.transcriptPath=null; publish(); });
      ptyProcess.on('choices', choices => { info.nativeThreadChoices = choices; publish(); });
      ptyProcess.on('migration-draft', text => { info.nativeMigrationDraft=text; publish(); });
      ptyProcess.on('renamed', name => { info.title = name; publish(); });
      ptyProcess.on('lifecycle', event => {
        this.emit('codex-lifecycle',event);
      });
      let contentTimer=null;
      ptyProcess.on('items',()=>{
        if(contentTimer)return;
        contentTimer=setTimeout(()=>{
          contentTimer=null;
          if(this.sessions.get(id)?.pty===ptyProcess)this.emit('codex-content-updated',
            {sessionId:id,threadId:ptyProcess.threadId,turnId:ptyProcess.runtime.turnId,
              epoch:ptyProcess.runtime.epoch,revision:ptyProcess.contentRevision});
        },80);
        contentTimer.unref?.();
      });
      ptyProcess.once('exit',()=>{if(contentTimer)clearTimeout(contentTimer);contentTimer=null;});
      ptyProcess.on('action-error', message => {
        info.nativeActionError = message; publish();
      });
      ptyProcess.on('diagnostic', message => console.warn('[codex-native]',id,message));
      ptyProcess.on('backstage-updated', event => {
        if (this.sessions.get(id)?.pty === ptyProcess) this.emit('codex-backstage-updated', {sessionId:id,...event});
      });
      ptyProcess.on('usage', usage => {
        this.emit('session-token-usage', { sessionId: id, total: usage && usage.total });
        const total = usage && usage.last;
        if (total && typeof total.totalTokens === 'number') info.contextUsed = total.totalTokens;
        if (usage && usage.modelContextWindow) {
          info.contextEffectiveMax = usage.modelContextWindow;
          info.contextPct = info.contextUsed / usage.modelContextWindow * 100;
        }
        publish();
      });
      // Deferral lets the normal session-created IPC finish before native updates.
      if (ptyProcess.sharedRuntime || ptyProcess.runtime.connection !== 'unstarted') queueMicrotask(() => ptyProcess.start().catch(error => {
        console.warn('[codex-native] start failed:',id,error.message);
      }));
      return this._toPublic(info);
    }

    if (kind === 'powershell') {
      ptyProcess.write('Set-PSReadLineOption -PredictionViewStyle ListView 2>$null; clear\r\n');
    }

    if (isNativeClaude) require('./claude-native-binding').bindClaudeNativeSession(this, id, ptyProcess);

    const agentPtyLaunch = claudePtyLaunch || codeagentLaunch;
    if (agentPtyLaunch) {
      // 信任框兜底（照搬 8c5c6928）：预写没生效时（.claude.json 损坏 / 只读）才会出现。
      // 绝不盲按回车——Claude Code 默认高亮 "No, exit"。detectClaudeTrustDialog 定位到
      // 「Yes, I trust this folder」那一行给出按键；定位不出来就一个键都不发。
      // 首帧时 ink 还没切 raw 模式，先等 1.2s 再用最新缓冲确认框还在。
      const { detectClaudeTrustDialog } = require('./claude-trust-dialog.js');
      let trustDone = false;
      let trustBuf = '';
      let trustTimer = null;
      const trustSub = ptyProcess.onData((d) => {
        if (trustDone) return;
        trustBuf = (trustBuf + d).slice(-16000);
        if (trustTimer || !detectClaudeTrustDialog(trustBuf)) return;
        trustTimer = setTimeout(() => {
          trustTimer = null;
          const dialog = detectClaudeTrustDialog(trustBuf);
          if (!dialog) return;
          trustDone = true;
          dialog.keys.forEach((key, index) => {
            setTimeout(() => { try { ptyProcess.write(key); } catch {} }, index * 80);
          });
          try { trustSub.dispose(); } catch {}
        }, 1200);
      });
      pendingTimers.push(setTimeout(() => {
        if (trustDone) return;
        if (trustTimer) { clearTimeout(trustTimer); trustTimer = null; }
        try { trustSub.dispose(); } catch {}
      }, 45000));

      // 与 8c5c6928 之前的 PTY 时代同一套投递：PowerShell 首屏安静 200ms 后敲入命令，
      // 3 秒安全兜底。所有参数都是启动前确定的，与原生后端同源。
      const cmd = agentPtyLaunch.cmd;
      let sent = false;
      let debounceTimer = null;
      const launch = () => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s && s.pty === ptyProcess) s.pty.write(cmd);
      };
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(launch, 200);
      });
      pendingTimers.push(setTimeout(launch, 3000));
      if (agentPtyLaunch.sessionId) queueMicrotask(() => this._refreshOpenIdentity(id));
    }

    if (isGemini) {
      let cmd = ' gemini --approval-mode yolo';
      if(opts.purpose==='hub-assistant')cmd+=' --skip-trust --allowed-mcp-server-names hub_assistant';
      cmd += ` --model ${opts.model || 'gemini-3-pro-preview'}`;
      if (opts.useResume && opts.geminiChatId && opts.geminiChatId.length > 8) {
        // Level 1: precise resume by full UUID.  The native id wins even when
        // the persisted public kind is gemini-resume.
        cmd += ` --resume ${opts.geminiChatId}`;
      } else if (kind === 'gemini-resume' || opts.useResume) {
        // Level 2: 8charId (old state.json format) or no chatId → fall back to latest
        cmd += ' --resume latest';
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);
    }

    if (isCodexRuntime) {
      // Remove legacy room MCP blocks left by older Hub versions. Current room
      // entries are injected only into this CLI command below.
      ensureCodexMcpEntries(sessionEnv.CODEX_HOME || null, [], CODEX_MANAGED_MCP_NAMES);
      dismissCodexUpdatePrompt(undefined, sessionEnv.CODEX_HOME || null);
      dismissCodexRateLimitDialog(undefined, sessionEnv.CODEX_HOME || null);
      const cv = getConfigValues();
      const codexModel = isDeepSeek
        ? normalizeDeepSeekModel(opts.model)
        : normalizeCodexSessionModel(opts.model || resolveDefaultCodexModel(cv));
      // Codex 的 model_reasoning_effort 是推理深度；fast 则由下面独立的
      // service_tier 控制，两者都不能和 Claude fastMode 混为一谈。
      // 非法值一律回落 max；群聊与普通 Session 一样尊重逐成员的 effort / service_tier。
      const codexReasoningArg = buildCodexReasoningConfigArg(normalizeCodexEffort(opts.effort))
        + buildCodexSpeedTierArg(effectiveCodexSpeedTier)
        + buildCodexContextWindowArg(effectiveContextMax);
      const codexInstructionFile = opts.codexInstructionFile || null;
      let cmd;
      if (opts.codexForkSid) {
        cmd = ` codex fork ${opts.codexForkSid} --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
      } else if (opts.useResume && opts.codexSid) {
        // Level 1: precise resume by sid
        cmd = ` codex resume ${opts.codexSid} --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
      } else if (kind.endsWith('-resume') || opts.codexResumePicker) {
        // Native id is unknown: show the picker.  Exact ids must win even when
        // the persisted public kind is "codex-resume" or "deepseek-resume".
        cmd = ` codex resume --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
      } else if (opts.useResume) {
        // Level 2 degradation: no sid recorded → use --last
        cmd = ` codex resume --last --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
      } else {
        // Research mode：完全 bypass approvals + sandbox（含 MCP 工具调用、shell 命令、文件写）
        // 避免任何 "Allow ... ?" 弹窗阻塞投研讨论流程；
        // 安全约束完全靠 prompt/covenant 软约束（已强化"不要改代码 / 不要 git / 不要删除"）
        // opts.model 让 meeting-create-modal 选定的非默认 model（如 gpt-5.4）生效。
        if (opts.codexBypassApprovals) {
          cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
        } else {
          cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
        }
        // 注：曾尝试 --no-alt-screen 改善观感，实测无明显改善 + Enter 提交失效 → 撤回。
        // 渲染观感问题改由"持久化 AI 群聊面板"（直接展示干净回答预览）绕过。
      }
      if (codexPtySqliteHome) cmd += ` -c "sqlite_home='${codexPtySqliteHome}'"`;
      if (codexInstructionFile) {
        cmd += ` -c "model_instructions_file=${codexInstructionFile.replace(/\\/g, '\\\\')}"`;
      }
      const effectiveCodexMcpEntries = effectiveCodexMcpProfile === 'none' ? [] : opts.codexMcpEntries;
      cmd += buildCodexEphemeralMcpArgs(effectiveCodexMcpEntries);
      const allowedGroupMcpNames = [
        ...(effectiveCodexMcpProfile === 'none' ? [] : CODEX_MANAGED_MCP_NAMES),
        ...(Array.isArray(effectiveCodexMcpEntries) ? effectiveCodexMcpEntries.map(entry => entry && entry.name) : []),
      ];
      cmd += buildCodexMcpIsolationArgs(sessionEnv.CODEX_HOME || null, {
        meetingId: opts.meetingId,
        cwd: spawnCwd,
        mcpProfile: effectiveCodexMcpProfile,
        allowedNames: allowedGroupMcpNames,
      });
      if (isCodexRuntime) {
        // hook 是 PTY Codex 的身份与状态来源；部署失败不拦启动，但要在会话上留痕。
        const hookResult = require('./codex-hook-integration').ensureCodexHookIntegration({
          codexHome: sessionEnv.CODEX_HOME || null,
        });
        info.hookIntegrationWarning = hookResult.errors.length ? hookResult.errors.join('；') : null;
        cmd += ` -c features.hooks=true`;
        try {
          const cliTheme = require('./cli-coldwhite-theme').ensureCodexTheme(sessionEnv, opts.hubUiTheme);
          cmd += ` -c tui.theme=${cliTheme}`;
        } catch (error) { console.warn('[CLI theme] Codex:', error.message); }
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          this._writeManagedCodexLaunch(id, cmd, 'create-pty-ready');
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        this._writeManagedCodexLaunch(id, cmd, 'create-safety-timeout');
      }, 3000);
      pendingTimers.push(safetyTimer);

      // picker 模式下把 Filter 从 Cwd 切到 All，让所有目录的历史会话都列出来
      if (kind.endsWith('-resume') || opts.codexResumePicker) {
        this._autoExpandResumePicker(id, ptyProcess, {
          marker: /Resume a previous session|Filter:\s*\[?Cwd\]?/i,
          key: '\x1b[C',   // Right
        });
      }
    }

    if (isKimi) {
      const model = opts.model || DEFAULT_MODEL_BY_KIND.kimi;
      // 首次 OAuth 前，官方 CLI 尚未把 managed K3 alias 写入 config.toml；此时强传
      // `--model kimi-code/k3` 会在 TUI 出现前直接退出，用户反而无法输入 /login。
      // 未配置时先启动原生登录 TUI；OAuth 完成后官方刷新会写入该 alias，后续启动再显式锁 K3。
      let cmd = `${kimiCommandPrefix(sessionEnv)} --yolo${kimiModelArg(model, sessionEnv)}`;
      if (opts.useResume && opts.kimiSid) {
        cmd += ` --session ${quotePowerShellLiteral(opts.kimiSid)}`;
      } else if (kind === 'kimi-resume' || opts.kimiResumePicker) {
        cmd += ' --session';
      } else if (opts.useContinue) {
        cmd += ' --continue';
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);

      // picker 模式下按 Ctrl+A 展开全部会话（默认只列当前目录）。
      // marker 必须够窄：这两条只在 picker 的页脚/空态里出现。曾经把 `Sessions\b`
      // 也算作命中，但那个词在正常输出里也可能出现，一旦误判就会往用户的实时会话里
      // 打进一个 Ctrl+A（TUI 里通常是行首/全选），属于可见的干扰。
      if (kind === 'kimi-resume' || opts.kimiResumePicker) {
        this._autoExpandResumePicker(id, ptyProcess, {
          marker: /Ctrl\+A\s+all|No sessions found/i,
          key: '\x01',   // Ctrl+A
        });
      }
    }

    this._refreshOpenIdentity(id);
    return { ...info };
  }

  _handlePtyExit(sessionId, ptyProcess, exitInfo) {
    const shutdownWaiter = this._shutdownExitWaiters.get(sessionId);
    const isShutdownExit = !!(shutdownWaiter && shutdownWaiter.pty === ptyProcess);
    const entry = this.sessions.get(sessionId);
    // Guard against id reuse: if a fresh session has already taken this id
    // (e.g., via restart-session reusing old.id), the entry's pty will be the
    // new one. Never delete that replacement when the old PTY exits late.
    if (!entry || entry.pty !== ptyProcess) {
      if (isShutdownExit) {
        this._shutdownExitWaiters.delete(sessionId);
        shutdownWaiter.resolve(exitInfo || null);
      }
      return false;
    }
    entry.confirmedExit = exitInfo || {};
    if (this.openLeases?.has(sessionId) && !entry.openReleaseReady) {
      return require('./session-store').flushSessionForRelease(sessionId, entry.info).then(() => {
        entry.openReleaseReady = true;
        return this._handlePtyExit(sessionId, ptyProcess, exitInfo);
      });
    }
    const meetingId = entry.info ? entry.info.meetingId : null;
    // A CLI can exit before Hub enters graceful shutdown (for example when
    // Windows closes the launcher console). That is not a request to remove
    // the logical group member or its native conversation identity.
    const unexpectedMemberExit = !!meetingId && !entry.closeRequestedAt && supportsRecoverableSession(entry.info);
    const wasSuspended = !!entry.suspendRequestedAt || unexpectedMemberExit;
    const dormantInfo = wasSuspended
      ? {
        ...entry.info,
        status: 'dormant',
        suspendedAt: entry.suspendRequestedAt || Date.now(),
        suspendReason: entry.suspendReason || (unexpectedMemberExit ? 'process-exit' : 'manual'),
      }
      : null;
    if (entry.terminalSnapshot) entry.terminalSnapshot.dispose();
    this._releaseOpenSession(sessionId);
    this.sessions.delete(sessionId);
    // App shutdown is process cleanup, not a user request to delete or suspend
    // a logical session. Preserve meeting membership and persisted cards; the
    // final shutdown flush writes the same logical state that existed before
    // PTY drainage began.
    if (isShutdownExit) {
      this._shutdownExitWaiters.delete(sessionId);
      shutdownWaiter.resolve(exitInfo || null);
      const shutdownDormantInfo = {
        ...entry.info,
        status: 'dormant',
        suspendedAt: Date.now(),
        suspendReason: 'shutdown-cancelled',
      };
      if (shutdownWaiter.timedOut) {
        this.onSessionSuspended(sessionId, meetingId, shutdownDormantInfo, exitInfo || null);
      } else {
        this._shutdownDrainedSessions.set(sessionId, {
          meetingId,
          session: shutdownDormantInfo,
          exitInfo: exitInfo || null,
        });
      }
      return true;
    }
    if (wasSuspended) {
      this.onSessionSuspended(sessionId, meetingId, dormantInfo, exitInfo || null);
    } else {
      this.onSessionClosed(sessionId, meetingId, { ...(exitInfo || {}), requested: !!entry.closeRequestedAt });
    }
    return true;
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // An explicit close wins over an in-flight suspend request.
    session.suspendRequestedAt = 0;
    // 删除 / 重启 / 工作区迁移都走这里，CLI 自己崩掉不会。没这个标记时，
    // 渲染层收到的“会话关闭了”在这四种情况下一模一样，只能把崩掉的会话
    // 当成用户主动删的一起抹掉——用户看到的就是界面凭空回到空状态。
    session.closeRequestedAt = Date.now();
    for (const t of session.pendingTimers) clearTimeout(t);
    if (!session.pty) {
      if (session.terminalSnapshot) session.terminalSnapshot.dispose();
      this._releaseOpenSession(sessionId, session.info);
      this.sessions.delete(sessionId);
      this.onSessionClosed(sessionId, null, { noPty: true, requested: true });
      return;
    }
    if (session.confirmedExit) return this._handlePtyExit(sessionId, session.pty, session.confirmedExit);
    session.pty.kill();
    // Do NOT delete from this.sessions here — the onExit handler does it.
    // The guard in onExit (entry.pty !== ptyProcess) requires the entry to
    // still be present so it can confirm the dying pty owns the entry.
    // Deleting early makes onExit see entry=undefined and return early, so
    // onSessionClosed never fires and the renderer never receives
    // `session-closed` — which is exactly the "X button does nothing" bug.
  }

  closeSessionRecoverably(sessionId, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    }
    if (session.confirmedExit) {
      session.suspendRequestedAt ||= Date.now();
      session.suspendReason = options.reason || 'user-close';
      return Promise.resolve(this._handlePtyExit(sessionId,session.pty,session.confirmedExit))
        .then(()=>({ok:true,sessionId,action:'suspended',recoverable:true}),error=>({ok:false,error:'history-save-failed',message:error.message}));
    }
    if (!supportsRecoverableSuspend(session.info)) {
      this.closeSession(sessionId);
      return { ok: true, sessionId, action: 'closed', recoverable: false };
    }
    const result = this.suspendSession(sessionId, {
      ...options,
      reason: options.reason || 'user-close',
      allowSharedViewerDetach: session.pty?.control?.shared && session.pty.control.role === 'viewer',
    });
    return result && result.ok
      ? { ...result, action: 'suspended', recoverable: true }
      : result;
  }

  // 休眠闸门的唯一判定处。suspendSession（真执行）和 previewIdleSuspend（预演）
  // 都走这里，保证「预演说会休眠」和「实际会休眠」永远是同一套判据——
  // 两边各写一份迟早会漂移，那样预演就失去意义了。
  //
  // 返回 { ok:false, error, message } 表示不休眠；{ ok:true, ... } 表示可以。
  _evaluateSuspendEligibility(sessionId, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    }
    if (session.info.agentRuntime === 'pty' && session.agentTurnActive
        && (options.reason === 'meeting-room-complete' || Number(options.minIdleMs) > 0)) {
      return { ok:false, error:'pty-turn-unfinished', message:'CLI 仍在执行或等待操作，已跳过自动休眠' };
    }
    if (['codex-app-server','acp','claude-stream-json'].includes(session.info.runtimeBackend)) {
      const runtime = session.info.nativeRuntime;
      const sharedViewerDetach = options.allowSharedViewerDetach === true
        && session.pty?.control?.shared && session.pty.control.role === 'viewer';
      if (!sharedViewerDetach && (!runtime || runtime.connection !== 'connected'
          || !['idle','completed','interrupted','failed'].includes(runtime.state)
          || runtime.backgroundTasks?.length || runtime.backgroundActivities?.length)) {
        return {ok:false,error:'native-turn-unfinished',message:'会话仍在执行、等待操作或状态待核对'};
      }
    }
    if (session.suspendRequestedAt) {
      return { ok: false, error: 'suspend-pending', message: '会话正在进入休眠' };
    }
    if (session.info && session.info.purpose === 'xresearch-research') {
      return { ok: false, error: 'protected-session', message: '扩展投研任务不能从这里休眠' };
    }
    if (!getSessionResumeIdentity(session.info)) {
      return {
        ok: false,
        error: 'native-session-id-missing',
        message: '尚未绑定原生会话 ID，请等待本轮完成后再休眠',
      };
    }
    if (options.excludePinned && session.info && session.info.pinned) {
      return { ok: false, error: 'pinned', message: '置顶会话不会被批量休眠' };
    }
    if (options.excludeMeeting && session.info && session.info.meetingId) {
      return { ok: false, error: 'meeting-member', message: '群聊成员不会被批量休眠' };
    }
    if (options.excludeFocused && this.focusedSessionId === sessionId) {
      return { ok: false, error: 'focused', message: '当前会话不会被批量休眠' };
    }
    const excludedSessionIds = options.excludeSessionIds;
    const isExplicitlyExcluded = excludedSessionIds instanceof Set
      ? excludedSessionIds.has(sessionId)
      : Array.isArray(excludedSessionIds) && excludedSessionIds.includes(sessionId);
    if (isExplicitlyExcluded) {
      return { ok: false, error: 'active-task', message: '会话仍有后台任务，已跳过休眠' };
    }

    const now = Number(options.now) || Date.now();
    const lastActivityAt = Math.max(
      Number(session.startedAt) || 0,
      Number(session.lastInputAt) || 0,
      Number(session.lastOutputAt) || 0,
    );
    const minIdleMs = Math.max(0, Number(options.minIdleMs) || 0);
    const idleMs = Math.max(0, now - lastActivityAt);
    if (minIdleMs > 0 && idleMs < minIdleMs) {
      return {
        ok: false,
        error: 'recently-active',
        message: '会话最近仍有活动，已跳过',
        lastActivityAt,
        idleMs,
        // 还差多久够钟。界面上把「为什么没休眠」说清楚，全靠这个数。
        remainingMs: minIdleMs - idleMs,
      };
    }

    return { ok: true, session, now, lastActivityAt, idleMs, remainingMs: 0 };
  }

  // 预演：按自动巡检那套参数逐个会话跑一遍闸门，只报结论不动任何 PTY。
  // 这是为了回答「我的 claude 会话到底会不会自动休眠、不会的话卡在哪一关」——
  // 在此之前 suspendIdleSessions 只回一个 skipped 计数，看不出是哪个会话、差多久。
  previewIdleSuspend(options = {}) {
    const idleMs = Math.max(60 * 1000, Number(options.idleMs) || DEFAULT_IDLE_SUSPEND_MS);
    const now = Number(options.now) || Date.now();
    const items = [];
    for (const sessionId of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      const verdict = this._evaluateSuspendEligibility(sessionId, {
        now,
        minIdleMs: idleMs,
        excludePinned: options.excludePinned !== false,
        excludeMeeting: options.excludeMeeting === true,
        excludeFocused: options.excludeFocused !== false,
        excludeSessionIds: options.excludeSessionIds,
      });
      const info = session.info || {};
      items.push({
        sessionId,
        kind: info.kind || '',
        title: info.title || '',
        eligible: verdict.ok === true,
        reason: verdict.ok ? null : (verdict.error || 'unknown'),
        message: verdict.ok ? null : (verdict.message || ''),
        idleMs: Number(verdict.idleMs) || 0,
        remainingMs: Number(verdict.remainingMs) || 0,
        lastActivityAt: Number(verdict.lastActivityAt) || 0,
      });
    }
    items.sort((a, b) => (b.eligible - a.eligible) || (b.idleMs - a.idleMs));

    const byReason = {};
    const byKind = {};
    for (const item of items) {
      const base = String(item.kind || '?').replace(/-resume$/, '');
      byKind[base] = byKind[base] || { total: 0, eligible: 0 };
      byKind[base].total += 1;
      if (item.eligible) byKind[base].eligible += 1;
      else byReason[item.reason] = (byReason[item.reason] || 0) + 1;
    }
    return {
      ok: true,
      idleMs,
      now,
      total: items.length,
      eligibleCount: items.filter(item => item.eligible).length,
      byReason,
      byKind,
      items,
    };
  }

  // 「释放内存」面板用：每个活会话的终端进程 PID、身份与能否休眠。
  // 能否休眠直接走 _evaluateSuspendEligibility，和真执行用同一套判据。
  describeSessionsForMemory(options = {}) {
    const now = Number(options.now) || Date.now();
    const suspendOptions = { ...MEMORY_RELEASE_SUSPEND_OPTIONS, now };
    const rows = [];
    for (const [sessionId, session] of this.sessions) {
      const info = session.info || {};
      const verdict = this._evaluateSuspendEligibility(sessionId, suspendOptions);
      const lastActivityAt = Math.max(
        Number(session.startedAt) || 0, Number(session.lastInputAt) || 0, Number(session.lastOutputAt) || 0,
      );
      const ptyPid = Number(session.pty && session.pty.pid);
      rows.push({
        id: sessionId,
        title: info.title || '',
        kind: info.kind || '',
        meetingId: info.meetingId || null,
        pinned: info.pinned === true,
        focused: this.focusedSessionId === sessionId,
        running: session.agentTurnActive === true || info.status === 'running',
        status: info.status || '',
        nativeId: getSessionResumeIdentity(info) || null,
        ptyPid: Number.isFinite(ptyPid) && ptyPid > 0 ? ptyPid : null,
        lastActivityAt,
        idleMs: Math.max(0, now - lastActivityAt),
        suspendable: verdict.ok === true,
        blockReason: verdict.ok ? null : (verdict.error || 'unknown'),
        blockMessage: verdict.ok ? null : (verdict.message || ''),
      });
    }
    return rows;
  }

  suspendSession(sessionId, options = {}) {
    const verdict = this._evaluateSuspendEligibility(sessionId, options);
    if (!verdict.ok) return { ok: false, error: verdict.error, message: verdict.message };

    const { session, now, lastActivityAt } = verdict;

    for (const timer of session.pendingTimers || []) clearTimeout(timer);
    session.suspendRequestedAt = now;
    session.suspendReason = typeof options.reason === 'string' && options.reason.trim()
      ? options.reason.trim()
      : 'manual';
    session.info.status = 'suspending';
    try {
      if (!session.pty) {
        const dormantInfo = {
          ...session.info,
          status: 'dormant',
          suspendedAt: now,
          suspendReason: session.suspendReason,
        };
        if (session.terminalSnapshot) session.terminalSnapshot.dispose();
        this.sessions.delete(sessionId);
        this.onSessionSuspended(sessionId, session.info.meetingId || null, dormantInfo, { noPty: true });
      } else {
        session.pty.kill();
      }
      return { ok: true, sessionId, lastActivityAt, reason: session.suspendReason };
    } catch (error) {
      session.suspendRequestedAt = 0;
      session.suspendReason = null;
      session.info.status = 'idle';
      return { ok: false, error: 'kill-failed', message: error && error.message ? error.message : String(error) };
    }
  }

  suspendIdleSessions(options = {}) {
    const idleMs = Math.max(60 * 1000, Number(options.idleMs) || DEFAULT_IDLE_SUSPEND_MS);
    const now = Number(options.now) || Date.now();
    const requested = [];
    const skipped = {};
    for (const sessionId of [...this.sessions.keys()]) {
      const result = this.suspendSession(sessionId, {
        now,
        minIdleMs: idleMs,
        excludePinned: options.excludePinned !== false,
        excludeMeeting: options.excludeMeeting !== false,
        excludeFocused: options.excludeFocused !== false,
        excludeSessionIds: options.excludeSessionIds,
        reason: options.reason || 'bulk-idle',
      });
      if (result.ok) requested.push(sessionId);
      else skipped[result.error || 'unknown'] = (skipped[result.error || 'unknown'] || 0) + 1;
    }
    return { ok: true, requested, count: requested.length, idleMs, skipped };
  }

  renameSession(sessionId, title, opts = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.info.title = title;
    if (opts.userRenamed === true) session.info.userRenamed = true;
    return { ...session.info };
  }

  updateSessionMeta(sessionId, fields = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !fields || typeof fields !== 'object') return undefined;
    Object.assign(session.info, fields);
    this._refreshOpenIdentity(sessionId);
    this.emit('session-updated', this._toPublic(session.info));
    return { ...session.info };
  }

  // Record proof that Hub actually wrote a managed Codex command. Never retain
  // the command itself: ephemeral MCP arguments can contain paths or env values.
  // A SHA-256 plus the normalized policy fields is enough to distinguish a Hub
  // launch from a later bare `codex` while keeping the audit safe to persist.
  _recordManagedCodexLaunch(sessionId, command, trigger) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.info) return null;
    const runtimeKind = session.info.transcriptKind || session.info.kind;
    if (!isCodexCliKind(runtimeKind)) return null;
    const now = Date.now();
    const info = session.info;
    const record = {
      schemaVersion: 1,
      ts: new Date(now).toISOString(),
      epochMs: now,
      sessionId,
      kind: info.kind,
      runtimeKind,
      trigger: String(trigger || 'managed-launch'),
      model: info.currentModel && info.currentModel.id ? info.currentModel.id : null,
      effort: info.effort || CODEX_REASONING_EFFORT,
      speedTier: info.codexSpeedTier || resolveCodexSpeedTier(runtimeKind, null),
      contextRequested: typeof info.contextMax === 'number' ? info.contextMax : null,
      mcpProfile: info.mcpProfile || resolveCodexMcpProfile(runtimeKind, null),
      mcpDisabled: (info.mcpProfile || resolveCodexMcpProfile(runtimeKind, null)) === 'none',
      commandSha256: crypto.createHash('sha256').update(String(command || ''), 'utf8').digest('hex'),
    };
    this._managedLaunchAudit.push(record);
    if (this._managedLaunchAudit.length > 100) this._managedLaunchAudit.splice(0, this._managedLaunchAudit.length - 100);
    this.emit('managed-launch', { ...record });
    return record;
  }

  _writeManagedCodexLaunch(sessionId, command, trigger) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.pty) return false;
    session.pty.write(command);
    this._recordManagedCodexLaunch(sessionId, command, trigger);
    return true;
  }

  getManagedLaunchAudit(sessionId = null) {
    return this._managedLaunchAudit
      .filter(record => !sessionId || record.sessionId === sessionId)
      .map(record => ({ ...record }));
  }

  // A managed Codex card owns more than a PowerShell process: its model,
  // reasoning, speed tier, context request and MCP isolation all live on the
  // Hub-built launch command. If Codex exits and the PTY falls back to the host
  // shell, typing a bare `codex` used to silently discard that entire contract.
  // Track only the current host-shell line and replace that exact command with
  // relaunchCli(); normal shell commands and all input inside the Codex TUI pass
  // through untouched.
  _interceptBareCodexHostLaunch(sessionId, s, data) {
    const runtimeKind = (s.info && s.info.transcriptKind) || (s.info && s.info.kind);
    if (!isCodexCliKind(runtimeKind)) return false;

    const chunk = String(data || '').replace(/\x1b\[(?:200|201)~/g, '');
    if (!chunk) return false;

    let line = s.hostShellInputLine;
    if (typeof line !== 'string') {
      if (!detectHostShellTakeover(s.ringBuffer)) return false;
      line = '';
    }

    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (ch === '\x03' || ch === '\x15') { // Ctrl+C / Ctrl+U
        line = '';
        continue;
      }
      if (ch === '\x08' || ch === '\x7f') {
        line = line.slice(0, -1);
        continue;
      }
      if (ch === '\x1b') {
        s.hostShellInputLine = null;
        return false;
      }
      if (ch === '\r' || ch === '\n') {
        const trailing = chunk.slice(i + 1).replace(/[\r\n]/g, '');
        const isBareCodex = BARE_CODEX_COMMAND_RE.test(line.trim()) && trailing.length === 0;
        s.hostShellInputLine = null;
        if (!isBareCodex) return false;

        // Earlier character-by-character input may already be echoed at the
        // prompt. Clear it before sending the full managed launch command.
        s.pty.write('\x15');
        const relaunched = this.relaunchCli(sessionId, { trigger: 'bare-codex-guard' });
        if (relaunched) {
          this._lastWrite = {
            sessionId,
            data: '<managed-codex-relaunch>',
            target: 'managed-relaunch',
            ts: Date.now(),
          };
          return true;
        }
        return false;
      }
      if (ch >= ' ') line += ch;
    }

    s.hostShellInputLine = line;
    return false;
  }

  writeToSession(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (s?.info.runtimeBackend === 'claude-stream-json') {
      if (data === '\u0003') {
        s.pty.interrupt().catch(error => s.pty.emit('action-error', error.message));
        return;
      }
      throw new Error('Claude 原生会话必须通过结构化消息入口发送');
    }
    if (s && s.pty) {
      const inputAt = Date.now();
      s.lastInputAt = inputAt;
      if (this._interceptBareCodexHostLaunch(sessionId, s, data)) return;
      this._lastWrite = { sessionId, data, target: 'pty', ts: inputAt };
      s.pty.write(data);
    }
  }

  getLastWrite() {
    return this._lastWrite ? { ...this._lastWrite } : null;
  }

  resizeSession(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (s && s.pty) {
      const safeCols = Math.max(cols, 60);
      s.pty.resize(safeCols, rows);
      if (s.terminalSnapshot) s.terminalSnapshot.resize(safeCols, rows);
      if (s.terminalOutputRewriter) s.terminalOutputRewriter.resize(safeCols, rows);
    }
  }

  // 「恢复历史会话」picker 默认只列当前目录的会话。会话以前都在用户主目录下时
  // 这没问题，改用 C:\Workspace\_scratch\* 之后就意味着 picker 里几乎什么都看不到。
  // Codex 和 Kimi 的 picker 各自内置了"看全部"的开关，这里在 picker 画出来之后
  // 替用户按一下，恢复"凭记忆挑会话、不用先想路径"的用法。
  //   Codex：顶部 `Filter: [Cwd] All`，右方向键切到 All
  //   Kimi ：底部 `Ctrl+A all`
  // Claude CLI 没有对应开关（footer 只有 Ctrl+B 切 git 分支），只能靠 Hub 侧栏。
  _autoExpandResumePicker(id, ptyProcess, { marker, key, timeoutMs = 20000 }) {
    let done = false;
    let buf = '';
    const finish = (send) => {
      if (done) return;
      done = true;
      try { watcher.dispose(); } catch {}
      clearTimeout(timer);
      if (!send) return;
      const s = this.sessions.get(id);
      if (s && s.pty) s.pty.write(key);
    };
    const watcher = ptyProcess.onData((d) => {
      if (done) return;
      buf = (buf + d).slice(-8000);
      if (marker.test(buf)) setTimeout(() => finish(true), 350);
    });
    // picker 没出现（比如直接恢复了某个会话）就安静放弃，绝不乱按键
    const timer = setTimeout(() => finish(false), timeoutMs);
    return () => finish(false);
  }

  setFocusedSession(sessionId) {
    this.focusedSessionId = sessionId;
  }

  markRead(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.info.unreadCount = 0;
      this.emit('session-updated', this._toPublic(session.info));
    }
  }

  getSession(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.info } : undefined;
  }

  async tryLoadCodexEditorInput(sessionId, text, options = {}) {
    const entry = this.sessions.get(sessionId);
    if (!entry?.codexEditorInput) return false;
    return entry.codexEditorInput.load(text, data => {
      if (this.sessions.get(sessionId) !== entry) throw Object.assign(new Error('会话已变化，未提交'), {notSent:true});
      this.writeToSession(sessionId, data);
    }, {...options,preservePunctuation:entry.info.purpose==='hub-assistant'&&/[‘’“”]/.test(String(text))});
  }

  getNativeCodex(sessionId) {
    const session = this.sessions.get(sessionId);
    return session && session.info.runtimeBackend === 'codex-app-server' ? session.pty : null;
  }

  getNativeClaude(sessionId) {
    const session = this.sessions.get(sessionId);
    return session?.info.runtimeBackend === 'claude-stream-json' ? session.pty : null;
  }

  getNativeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    return session && (session.pty?.isCliProvider || ['codex-app-server','acp'].includes(session.info.runtimeBackend)) ? session.pty : null;
  }

  // 群聊快路径缓存：首次 groupChatWatcher.waitCliReady 通过后置 true，后续 groupChatWatcher.sendToPty 跳过冷启动 sleep。
  getGroupChatReady(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? !!s.groupChatReady : false;
  }

  setGroupChatReady(sessionId, ready) {
    const s = this.sessions.get(sessionId);
    if (s) s.groupChatReady = !!ready;
  }

  // 返回 PTY 最近一次产出输出的 ms 时间戳，用于 groupChatWatcher.sendToPty 活性兜底（write 后 300ms 内有无 echo）。
  getGroupChatLastActivity(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? (s.groupChatLastActivity || 0) : 0;
  }

  // Monotonic PTY bytes received for a session.  Unlike the last-activity
  // timestamp this can safely answer "did the screen only repaint a little, or
  // did real streaming output arrive?" across watchdog samples.
  getGroupChatOutputBytes(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? (s.groupChatOutputBytes || 0) : 0;
  }

  getAgentTurnStartSeq(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? (s.agentTurnStartSeq || 0) : 0;
  }

  // Record an authoritative provider lifecycle signal in the main process.
  // Claude UserPromptSubmit and Codex task_started both flow through here, so
  // group-chat delivery can use the same semantic truth as ordinary-session
  // runtime status instead of guessing from terminal bytes.
  // CLI 已退出、终端回到宿主 PowerShell 提示符。用来判断 SessionStart(startup)
  // 是用户重新拉起了 CLI，还是 CLI 里嵌套跑的另一个 codex 进程。
  isHostShellActive(sessionId) {
    const s = this.sessions.get(sessionId);
    return !!(s && detectHostShellTakeover(s.ringBuffer));
  }

  // TUI 里的 /new 结束了这条已绑定的线程（屏幕上有带它 id 的「To continue this session」）。
  // Codex 要等新线程第一次提问才报 SessionStart，那时这句可能早已滚远：Hub 自己提交的
  // /new 在确认时就把结论记在会话上；用户直接在终端里敲的，扫最近一次改绑之后的输出。
  noteCodexThreadEnded(sessionId, threadSid) {
    const s = this.sessions.get(sessionId);
    if (s && threadSid) s.codexEndedThreadSid = String(threadSid);
  }
  getSessionOutputMark(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? Number(s.outputChars) || 0 : 0;
  }
  // 标记之后产生、且仍在缓冲区里的输出（缓冲区已截断掉一部分时，取剩下的那段）。
  getSessionOutputSince(sessionId, mark) {
    const s = this.sessions.get(sessionId);
    if (!s) return '';
    const buffer = s.ringBuffer || '';
    const fresh = Math.max(0, (Number(s.outputChars) || 0) - (Number(mark) || 0));
    return fresh >= buffer.length ? buffer : buffer.slice(buffer.length - fresh);
  }
  // 改绑到新线程后旧证据作废：/resume 回到那条线程时，它已不再是「已结束」。
  noteCodexThreadBound(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.codexEndedThreadSid = null;
    s.codexBoundOutputMark = Number(s.outputChars) || 0;
  }
  isCodexThreadEnded(sessionId, boundSid) {
    const s = this.sessions.get(sessionId);
    if (!s || !boundSid) return false;
    if (s.codexEndedThreadSid === String(boundSid)) return true;
    // 用户直接在终端里敲的 /new：只看最近一次改绑之后的输出。
    return detectCodexThreadEnded(this.getSessionOutputSince(sessionId, s.codexBoundOutputMark || 0), boundSid);
  }


  noteAgentTurnStarted(sessionId, event = {}) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.info.runtimeBackend === 'claude-stream-json' && event.signalSource !== 'claude-stream-json') return null;
    s.info.freshLaunch = false;
    const observedAt = Number(event.observedAt || event.startedAt) || Date.now();
    s.agentTurnStartSeq = (s.agentTurnStartSeq || 0) + 1;
    s.agentTurnStartedAt = observedAt;
    s.agentTurnActive = true;
    s.agentTurnId = event.turnId || null;
    s.agentTurnStartSource = event.signalSource || event.source || 'provider_lifecycle';
    const runtimeChanged = require('./codex-pty-runtime').observeCodexPtyRuntime(s, {
      state: 'running', source: s.agentTurnStartSource, startedAt: observedAt,
      turnId: s.agentTurnId,
    });
    if (runtimeChanged) this.emit('session-updated', this._toPublic(s.info));
    const payload = {
      sessionId,
      seq: s.agentTurnStartSeq,
      observedAt,
      signalSource: s.agentTurnStartSource,
      ...(typeof event.prompt === 'string' ? { prompt: event.prompt } : {}),
      turnId: event.turnId || null,
    };
    this.emit('agent-turn-started', payload);
    return payload;
  }

  prepareCodexFork(opts) {
    return require('./codex-cross-account-fork').prepareCrossAccountCodexFork(opts, {
      config: require('./codex-global-account').currentConfig(),
    });
  }

  // 只读：CLI hook 报告的本轮是否仍在进行（AI 编排模式据此决定何时投递通知）。
  isAgentTurnActive(sessionId) {
    const s = this.sessions.get(sessionId);
    return !!(s && s.agentTurnActive);
  }

  noteAgentTurnFinished(sessionId, event = {}) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.agentTurnActive) return false;
    if (s.agentTurnId && event.turnId && s.agentTurnId !== event.turnId) return false;
    const at = Number(event.completedAt || event.abortedAt || event.failedAt) || Date.now();
    if (at < s.agentTurnStartedAt) return false;
    s.agentTurnActive = false;
    const runtimeChanged = require('./codex-pty-runtime').observeCodexPtyRuntime(s, {
      state: event.failedAt ? 'failed' : event.abortedAt ? 'interrupted' : 'completed',
      source: event.failedAt ? 'codex-turn-failed' : event.abortedAt ? 'codex-turn-aborted' : 'codex-turn-complete',
      completedAt: at, turnId: event.turnId || s.agentTurnId,
      evidence: event.message || null,
    });
    if (runtimeChanged) this.emit('session-updated', this._toPublic(s.info));
    return true;
  }

  noteCodexHookActivity(sessionId, event, parsed, observedAt = Date.now()) {
    const entry = this.sessions.get(sessionId);
    const changed = require('./codex-pty-runtime').observeCodexHookActivity(entry, event, parsed, observedAt);
    if (changed) this.emit('session-updated', this._toPublic(entry.info));
    return changed;
  }

  // FIX-F（2026-05-01）：在已存在的 PTY 上重新启动 CLI 进程（不重 spawn PTY）。
  //   场景：CLI 自我退出（Codex 自动更新 / Gemini OAuth refresh / Claude panic），
  //   PTY 控制权回到宿主 shell（PowerShell / bash），ring buffer 末尾是 host prompt。
  //   往 PTY 写启动命令重新拉起 CLI；不带 resume，启动新 session（context 干净）。
  //   命令前导空格抑制 shell 历史记录，避免污染。
  // 返回 true 已写命令，false 找不到 session 或 kind 不支持。
  relaunchCli(sessionId, options = {}) {
    const s = this.sessions.get(sessionId);
    if (s && ['codex-app-server','acp'].includes(s.info.runtimeBackend)) {
      const runtime = s.info.nativeRuntime;
      if (runtime && ['running','waiting'].includes(runtime.state)) return false;
      s.pty.reconnect().catch(error => {
        s.info.nativeActionError = error.message;
        this.emit('codex-session-updated', this._toPublic(s.info));
      });
      return true;
    }
    if (!s || !s.pty) return false;
    if (s.info.runtimeBackend === 'claude-stream-json') return false;
    const kind = s.info && s.info.kind;
    const modelId = s.info && s.info.currentModel && s.info.currentModel.id;
    const meetingId = s.info && s.info.meetingId;
    // 群聊成员：复用 buildGroupChatIsolationFlags 输出 (v2 后仅 --settings,不含
    //   --disable-slash-commands;详见该函数注释)。
    // 用 isClaudeFamily 同时覆盖主 kind 与 *-resume 形态。
    const runtimeKind = (s.info && s.info.transcriptKind) || kind;
    const baseKind = (typeof runtimeKind === 'string') ? runtimeKind.replace(/-resume$/, '') : runtimeKind;
    const isClaudeCli = isClaudeFamily(baseKind);
    const autonomous = !!(s.info && s.info.autonomous);
    // Code Agent 不认 --settings，群聊隔离 overlay 对它无效，不传。
    const isolation = isClaudeCli && !isCodeAgentKind(baseKind) ? buildGroupChatIsolationFlags(meetingId || autonomous) : '';
    let cmd;
    if (isCodeAgentKind(runtimeKind)) {
      // 原地重拉开一个新的 CLI 进程（同 Claude）。它不认 --session-id，新身份要等 hook 上报：
      // 先清掉旧绑定并标记待绑定，否则新进程的 hook 会因 id 不同被当成外来会话丢弃。
      const config = require('./codeagent-config').resolveCodeAgentConfig(process.env);
      const launch = buildCodeAgentPtyLaunch(sessionId, 'codeagent', {
        model: modelId, effort: s.info && s.info.effort, mcpConfigFile: s.claudeMcpConfigFile,
        mcpProfile: s.info && s.info.mcpProfile,
      }, s.info && s.info.cwd, s.pty.options?.env || process.env, config);
      Object.assign(s.info, { ccSessionId: undefined, transcriptPath: undefined, codeagentIdentityPending: true });
      cmd = launch.cmd;
    } else if (isCodexCliKind(runtimeKind)) {
      // relaunch：API 模式时 codex 用 isolated CODEX_HOME，从 info.codexSessionsRoot 反推
      const codexConfigDir = s.info && s.info.codexSessionsRoot ? path.dirname(s.info.codexSessionsRoot) : null;
      dismissCodexUpdatePrompt(undefined, codexConfigDir);
      dismissCodexRateLimitDialog(undefined, codexConfigDir);
      // relaunch 要沿用会话自己选过的档位；群聊成员也不例外。
      const codexRelaunchModel = modelId || DEFAULT_MODEL_BY_KIND.codex;
      const codexReasoningArg = buildCodexReasoningConfigArg(normalizeCodexEffort(s.info && s.info.effort))
        + buildCodexSpeedTierArg(resolveCodexSpeedTier(runtimeKind, s.info && s.info.codexSpeedTier))
        + buildCodexContextWindowArg(resolveCodexContextWindow(codexRelaunchModel, s.info && s.info.contextMax, { configDir: codexConfigDir }));
      ensureCodexMcpEntries(codexConfigDir, [], CODEX_MANAGED_MCP_NAMES);
      cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${codexRelaunchModel}${codexReasoningArg}`;
      const relaunchMcpProfile = resolveCodexMcpProfile(runtimeKind, s.info && s.info.mcpProfile);
      const relaunchMcpEntries = relaunchMcpProfile === 'none' ? [] : s.codexMcpEntries;
      cmd += buildCodexEphemeralMcpArgs(relaunchMcpEntries);
      cmd += buildCodexMcpIsolationArgs(codexConfigDir, {
        meetingId,
        cwd: s.info && s.info.cwd,
        mcpProfile: relaunchMcpProfile,
        allowedNames: relaunchMcpProfile === 'none'
          ? []
          : [...CODEX_MANAGED_MCP_NAMES, ...(relaunchMcpEntries || []).map((entry) => entry && entry.name)],
      });
      cmd += '\r\n';
    } else if (kind === 'gemini' || kind === 'gemini-resume') {
      cmd = ` gemini --approval-mode yolo${s.info.purpose==='hub-assistant'?' --skip-trust --allowed-mcp-server-names hub_assistant':''} --model ${modelId || 'gemini-3-pro-preview'}\r\n`;
    } else if (kind === 'claude' || kind === 'claude-resume') {
      // 默认 --effort max（CLAUDE_HUB_NO_EFFORT_MAX=1 可关），但会话显式
      // 选过档位时必须沿用，不能在 CLI 原地重拉后静默回到 max。
      // 默认 model 跟随 DEFAULT_MODEL_BY_KIND.claude（当前 Opus 4.8 1M）。
      // 默认叠 fast 模式 settings（CLAUDE_HUB_NO_FAST=1 可关）—— 与 createSession
      //   spawn block 对齐，防止 relaunch 后丢 fast 状态。
      //   会话自己关过 fast（info.fastMode === false）时也要沿用，否则 relaunch
      //   会把用户显式关掉的开关又打开。
      const effort = CLAUDE_EFFORT_LEVELS.has(s.info && s.info.effort) ? s.info.effort : 'max';
      const effortFlag = process.env.CLAUDE_HUB_NO_EFFORT_MAX === '1' ? '' : ` --effort ${effort}`;
      let fastFlag = '';
      const cv = getConfigValues();
      if (shouldUseClaudeFastSettings(cv, { fastMode: s.info && s.info.fastMode, autonomous })) {
        const fastSettingsPath = resolveAsarUnpacked('claude-subscription-fast-settings.json');
        fastFlag = ` --settings "${fastSettingsPath.replace(/\\/g, '\\\\')}"`;
      } else if (s.info?.fastMode === false) {
        const standardSettingsPath = resolveAsarUnpacked('claude-subscription-standard-settings.json');
        fastFlag = ` --settings "${standardSettingsPath.replace(/\\/g, '\\\\')}"`;
      }
      if (s.info?.purpose === 'hub-assistant' && autonomous) {
        const fast = shouldUseClaudeFastSettings(cv, {fastMode:s.info.fastMode,autonomous});
        const settingsFile = require('./claude-native-launch').prepareClaudeSettingsOverlay(
          [ensureGroupChatSettings(getHubDataDir()),resolveAsarUnpacked(fast?'claude-subscription-fast-settings.json':'claude-subscription-standard-settings.json')],
          {directory:path.join(getHubDataDir(),'native-agent-settings'),sessionId:sessionId+'-'+require('crypto').randomUUID(),overrides:{skipDangerousModePermissionPrompt:true}});
        fastFlag = ` --settings "${settingsFile.replace(/\\/g, '\\\\')}"`;
      }
      // 单人和群聊都沿用自己的 MCP 档位；群聊与 autonomous 额外恢复 research config。
      const mcpPlan = (meetingId || (autonomous && s.claudeMcpConfigFile))
        ? buildClaudeMeetingMcpArgs({
          mcpConfigFile: s.claudeMcpConfigFile,
          mcpProfile: s.info && s.info.mcpProfile,
          cwd: s.info && s.info.cwd,
          hubDataDir: getHubDataDir(),
        })
        : buildClaudeMcpProfileArgs({
          mcpProfile: s.info && s.info.mcpProfile,
          cwd: s.info && s.info.cwd,
          hubDataDir: getHubDataDir(),
        });
      const mcpFlag = mcpPlan && mcpPlan.args ? mcpPlan.args : '';
      const relaunchPermissionFlag = claudePermissionModeArg({ autonomous });
      const addDirFlag = claudeNativeAddDirs([]).map(dir => ` --add-dir "${dir}"`).join('');
      cmd = ` claude --model ${modelId || DEFAULT_MODEL_BY_KIND.claude}${effortFlag}${relaunchPermissionFlag}${fastFlag}${mcpFlag}${addDirFlag}${isolation}\r\n`;
    } else if (kind === 'deepseek' || kind === 'deepseek-resume') {
      const mcpPlan = meetingId ? buildClaudeMeetingMcpArgs({
        mcpConfigFile: s.claudeMcpConfigFile,
        mcpProfile: (s.info && s.info.mcpProfile) || 'lean',
        cwd: s.info && s.info.cwd,
        hubDataDir: getHubDataDir(),
      }) : null;
      const mcpFlag = mcpPlan && mcpPlan.args ? mcpPlan.args : '';
      cmd = ` claude --model ${normalizeLegacyDeepSeekClaudeModel(modelId)} --permission-mode bypassPermissions${mcpFlag}${isolation}\r\n`;
    } else if (isKimiCliKind(kind)) {
      cmd = `${kimiCommandPrefix(process.env)} --yolo${kimiModelArg(modelId || DEFAULT_MODEL_BY_KIND.kimi, process.env)}\r\n`;
    } else {
      return false;
    }
    s.pty.write(cmd);
    if (isCodexCliKind(runtimeKind)) {
      this._recordManagedCodexLaunch(sessionId, cmd, options.trigger || 'relaunch');
    }
    // 重置 group-chat 快路径缓存：CLI 是新启动，必须重新走冷启动流程
    s.groupChatReady = false;
    return true;
  }

  getAllSessions() {
    return Array.from(this.sessions.values())
      .map(s => ({ ...s.info }))
      .sort(compareLatestReplyDesc);
  }

  // Returns the public shape used by renderer IPC and 'session-updated' events.
  _toPublic(info) {
    return {
      ...(isAcpKind(info.kind) ? {cliRuntime:info.cliRuntime||null} : {}),
      ...(isAcpKind(info.kind) ? {acpSid:info.acpSid,acpProfileId:info.acpProfileId,
        acpCapabilities:info.acpCapabilities,acpConfigOptions:info.acpConfigOptions} : {}),
      ...(info.runtimeBackend ? {runtimeBackend:info.runtimeBackend,nativeRuntime:info.nativeRuntime,
        nativeConfig:info.nativeConfig,
        ...(info.nativeMigrationDraft ? {nativeMigrationDraft:info.nativeMigrationDraft} : {}),
        codexApprovalPolicy:info.codexApprovalPolicy,codexSandbox:info.codexSandbox,
        nativeThreadChoices:info.nativeThreadChoices || [],nativeActionError:info.nativeActionError || null,
        ...(info.codexSharedControl ? {codexSharedControl:info.codexSharedControl} : {}),
        ...(info.nativeSharedControl ? {nativeSharedControl:info.nativeSharedControl} : {})} : {}),
      // PTY 会话显式带空值：renderer 按 {...旧, ...新} 合并，缺字段会让原生时代的后端残留下来。
      ...(info.agentRuntime === 'pty' ? {agentRuntime:'pty',runtimeBackend:null,nativeRuntime:null,
        ...(info.runtimeTruth ? {runtimeTruth:info.runtimeTruth} : {}),
        hookIntegrationWarning:info.hookIntegrationWarning || null} : {agentRuntime:null}),
      id: info.id,
      meetingId: info.meetingId || null,
      title: info.title,
      kind: info.kind,
      freshLaunch: info.freshLaunch === true,
      cwd: info.cwd,
      unreadCount: info.unreadCount,
      lastMessageTime: info.lastMessageTime,
      // 本次进程启动（新建或恢复）的时刻；文件面板据此列出「本会话改动」。
      ...(Number.isFinite(info.createdAt) ? { spawnedAt: info.createdAt } : {}),
      ...(typeof info.lastCompletedAt === 'number' ? { lastCompletedAt: info.lastCompletedAt } : {}),
      lastOutputPreview: info.lastOutputPreview,
      ...(info.pinned !== undefined ? { pinned: info.pinned } : {}),
      ...(info.bottomed !== undefined ? { bottomed: info.bottomed } : {}),
      ...(info.ccSessionId !== undefined ? { ccSessionId: info.ccSessionId } : {}),
      ...(info.transcriptPath !== undefined ? { transcriptPath: info.transcriptPath } : {}),
      ...(info.codexSid !== undefined ? { codexSid: info.codexSid } : {}),
      ...(info.codexSessionsRoot !== undefined ? { codexSessionsRoot: info.codexSessionsRoot } : {}),
      ...(info.codexAllowMtimeFallback ? { codexAllowMtimeFallback: true } : {}),
      ...(info.codexProfile !== undefined ? { codexProfile: info.codexProfile } : {}),
      ...(info.codexProfileLabel !== undefined ? { codexProfileLabel: info.codexProfileLabel } : {}),
      ...(info.mcpProfile !== undefined ? { mcpProfile: info.mcpProfile } : {}),
      ...(info.fastMode !== undefined ? { fastMode: info.fastMode } : {}),
      ...(info.autonomous !== undefined ? { autonomous: info.autonomous } : {}),
      ...(info.effort !== undefined ? { effort: info.effort } : {}),
      ...(info.codexSpeedTier !== undefined ? { codexSpeedTier: info.codexSpeedTier } : {}),
      ...(info.geminiChatId !== undefined ? { geminiChatId: info.geminiChatId } : {}),
      ...(info.geminiProjectHash !== undefined ? { geminiProjectHash: info.geminiProjectHash } : {}),
      ...(info.geminiProjectRoot !== undefined ? { geminiProjectRoot: info.geminiProjectRoot } : {}),
      ...(info.kimiSid !== undefined ? { kimiSid: info.kimiSid } : {}),
      ...(info.kimiSessionDir !== undefined ? { kimiSessionDir: info.kimiSessionDir } : {}),
      ...(info.currentModel ? { model: info.currentModel.id } : {}),
      ...(info.currentModel ? { currentModel: info.currentModel } : {}),
      ...(info.effort ? { effort: info.effort } : {}),
      ...(typeof info.contextPct === 'number' ? { contextPct: info.contextPct } : {}),
      ...(typeof info.contextUsed === 'number' ? { contextUsed: info.contextUsed } : {}),
      ...(info.sessionUsage ? { sessionUsage: info.sessionUsage } : {}),
      ...(typeof info.contextMax === 'number' ? { contextMax: info.contextMax } : {}),
      ...(typeof info.contextEffectiveMax === 'number' ? { contextEffectiveMax: info.contextEffectiveMax } : {}),
      ...(typeof info.contextEffectiveObservedAt === 'number'
        ? { contextEffectiveObservedAt: info.contextEffectiveObservedAt }
        : {}),
      ...(info.userRenamed ? { userRenamed: true } : {}),
      ...(info.autoTitleGenerated ? { autoTitleGenerated: true } : {}),
      ...(info.branchSourceSessionId ? { branchSourceSessionId: info.branchSourceSessionId } : {}),
      ...(Number.isInteger(Number(info.branchIndex)) && Number(info.branchIndex) > 0
        ? { branchIndex: Number(info.branchIndex) }
        : {}),
      ...(typeof info.branchAutoTitlePending === 'boolean'
        ? { branchAutoTitlePending: info.branchAutoTitlePending }
        : {}),
      ...(info.status !== undefined ? { status: info.status } : {}),
      connectionIssue: info.connectionIssue || null,
      ...(info.readOnly ? { readOnly: true } : {}),
      ...(info.provider ? { provider: info.provider } : {}),
      ...(info.nativeSession ? { nativeSession: info.nativeSession } : {}),
      ...(info.purpose ? { purpose: info.purpose } : {}),
      ...(info.researchSessionId ? { researchSessionId: info.researchSessionId } : {}),
      ...(info.hiddenFromSidebar ? { hiddenFromSidebar: true } : {}),
      completionNotificationEnabled: info.completionNotificationEnabled === true,
    };
  }

  // Returns array of public session objects for renderer IPC.
  listSessions() {
    return Array.from(this.sessions.values())
      .map(s => this._toPublic(s.info))
      .sort(compareLatestReplyDesc);
  }

  // 每个活跃会话 pty 顶层进程的 PID。全机残留回收（core/process-reclaim.js）
  // 靠它把「正在用的会话外壳」和「会话结束后没退干净的空壳」区分开——两者在
  // 系统里长得一模一样（都是 powershell.exe -NoProfile -NoLogo，见 :1008），
  // 光看进程信息无法分辨，只有 Hub 自己知道哪些还在用。
  //
  // node-pty 一直暴露着 ptyProcess.pid（ConPTY 下是 _innerPid），此前从未被读取过。
  listLivePtyPids() {
    const pids = [];
    for (const s of this.sessions.values()) {
      const pid = Number(s && s.pty && s.pty.pid);
      if (Number.isFinite(pid) && pid > 0) pids.push(pid);
    }
    return pids;
  }

  // Appends terminal-facing PTY data to the session's ring buffer, capping at
  // RING_BUFFER_BYTES (tail-slice). Codex data has already passed through the
  // xterm scrollback-safety rewrite; other runtimes remain byte-for-byte.
  // After truncation, trims any lone low-surrogate left at the start of the buffer
  // that could result from cutting a UTF-16 surrogate pair at the boundary.
  // Extracted as a named method so tests can drive it without spawning a real PTY.
  _appendToRingBuffer(id, data) {
    const s = this.sessions.get(id);
    if (!s) return;
    // 累计输出字符数：缓冲区截断后长度不再增长，「某时刻之后的新输出」只能靠它来定位。
    s.outputChars = (Number(s.outputChars) || 0) + String(data || '').length;
    let rb = (s.ringBuffer || '') + data;
    const ringLimit = Number(s.ringBufferLimit || RING_BUFFER_BYTES);
    if (rb.length > ringLimit) {
      rb = rb.slice(rb.length - ringLimit);
      // Trim leading lone low-surrogates (unpaired 0xDC00–0xDFFF) left by the cut.
      // A high surrogate (0xD800–0xDBFF) at position 0 is fine only if it's
      // immediately followed by a low surrogate; otherwise drop it too.
      let i = 0;
      while (i < rb.length && i < 4) {
        const cc = rb.charCodeAt(i);
        // Lone low-surrogate — definitely unpaired, drop it
        if (cc >= 0xDC00 && cc <= 0xDFFF) { i++; continue; }
        // High surrogate followed by something that is NOT a low surrogate — drop it
        if (cc >= 0xD800 && cc <= 0xDBFF) {
          const next = rb.charCodeAt(i + 1);
          if (!(next >= 0xDC00 && next <= 0xDFFF)) { i++; continue; }
        }
        break;
      }
      if (i > 0) rb = rb.slice(i);
    }
    s.ringBuffer = rb;
  }

  // Returns the ring-buffer string for a session, '' if exists but empty,
  // null if session not found.
  getSessionBuffer(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return s.ringBuffer || '';
  }
  getSessionOutputRevision(sessionId) { return this.sessions.get(sessionId)?.lastOutputSeq ?? null; }

  // Renderer 可以先拿一个带序号的原子尾部快照，再只接收更大的 seq，
  // 避免终端按需创建时既丢启动输出又把并发到达的 chunk 重复写入。
  getSessionBufferSnapshot(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.terminalSnapshot) {
      return s.terminalSnapshot.snapshot().then((snapshot) => (
        snapshot || { text: s.ringBuffer || '', seq: s.lastOutputSeq || this._outputSeq }
      )).catch((error) => {
        console.warn('[terminal-snapshot] serialize failed, using terminal ring fallback:', error && error.message);
        return { text: s.ringBuffer || '', seq: s.lastOutputSeq || this._outputSeq };
      });
    }
    return { text: s.ringBuffer || '', seq: s.lastOutputSeq || this._outputSeq };
  }

  dispose() {
    for (const s of this.sessions.values()) {
      for (const t of s.pendingTimers) clearTimeout(t);
      s.outputDelivery?.close();
      if (s.terminalSnapshot) s.terminalSnapshot.dispose();
      if (s.pty) {
        s.pty.kill();
      }
    }
    this.sessions.clear();
  }

  // Electron must not tear down Node while node-pty still has a
  // ThreadSafeFunction exit callback in flight. On Windows that race aborts the
  // process with 0xc0000409 / FAST_FAIL_FATAL_APP_EXIT. Register every waiter
  // before killing any PTY, then keep the JS environment alive until the
  // existing onExit path has completed for all of them.
  disposeGracefully(options = {}) {
    if (this._shutdownDrainPromise) return this._shutdownDrainPromise;

    this._isShuttingDown = true;
    const logger = options.logger || console;
    const configuredWarnAfterMs = Number(options.warnAfterMs);
    const warnAfterMs = Number.isFinite(configuredWarnAfterMs)
      ? Math.max(0, configuredWarnAfterMs)
      : 5000;
    const configuredDrainTimeoutMs = Number(options.drainTimeoutMs);
    const drainTimeoutMs = Number.isFinite(configuredDrainTimeoutMs)
      ? Math.max(100, configuredDrainTimeoutMs)
      : 15_000;
    const startedAt = Date.now();
    const entries = [...this.sessions.entries()];

    this._shutdownDrainPromise = (async () => {
      const waits = [];
      const killErrors = [];

      // Set up all waiters first. A native exit callback cannot run JS until
      // this synchronous setup yields, so no PTY can escape between snapshot
      // and waiter registration.
      for (const [sessionId, session] of entries) {
        for (const timer of session.pendingTimers || []) clearTimeout(timer);
        session.outputDelivery?.flush();
        if (!session.pty) {
          if (session.terminalSnapshot) session.terminalSnapshot.dispose();
          this._releaseOpenSession(sessionId, session.info);
          this.sessions.delete(sessionId);
          this._shutdownDrainedSessions.set(sessionId, {
            meetingId: session.info && session.info.meetingId || null,
            session: {
              ...session.info,
              status: 'dormant',
              suspendedAt: Date.now(),
              suspendReason: 'shutdown-cancelled',
            },
            exitInfo: { noPty: true },
          });
          continue;
        }
        waits.push(new Promise((resolve) => {
          this._shutdownExitWaiters.set(sessionId, { pty: session.pty, resolve });
        }));
      }

      for (const [sessionId, session] of entries) {
        if (!session.pty) continue;
        try {
          if (session.confirmedExit) await this._handlePtyExit(sessionId, session.pty, session.confirmedExit);
          else session.pty.kill();
        } catch (error) {
          // Do not pretend this PTY is drained. Its already-registered onExit
          // waiter remains authoritative and prevents unsafe teardown.
          killErrors.push({ sessionId, message: error && error.message ? error.message : String(error) });
          logger.warn('[shutdown] PTY kill failed; waiting for native exit callback:', sessionId, error && error.message);
        }
      }

      let warningTimer = null;
      if (waits.length > 0 && warnAfterMs > 0) {
        warningTimer = setTimeout(() => {
          const pendingIds = [...this._shutdownExitWaiters.keys()];
          logger.warn(`[shutdown] still draining ${pendingIds.length} PTY session(s): ${pendingIds.join(', ')}`);
        }, warnAfterMs);
        if (typeof warningTimer.unref === 'function') warningTimer.unref();
      }

      let timeoutTimer = null;
      const drained = waits.length === 0
        ? true
        : await Promise.race([
          Promise.all(waits).then(() => true),
          new Promise(resolve => {
            timeoutTimer = setTimeout(() => resolve(false), drainTimeoutMs);
          }),
        ]);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (warningTimer) clearTimeout(warningTimer);
      if (!drained) {
        const pendingSessionIds = [...this._shutdownExitWaiters.keys()];
        for (const sessionId of pendingSessionIds) {
          const waiter = this._shutdownExitWaiters.get(sessionId);
          if (waiter) waiter.timedOut = true;
        }
        for (const [sessionId, drainedSession] of this._shutdownDrainedSessions) {
          this.onSessionSuspended(
            sessionId,
            drainedSession.meetingId,
            drainedSession.session,
            drainedSession.exitInfo,
          );
        }
        this._shutdownDrainedSessions.clear();
        logger.error?.(`[shutdown] PTY drain timed out after ${drainTimeoutMs}ms: ${pendingSessionIds.join(', ')}`);
        this._isShuttingDown = false;
        return {
          safeToQuit: false,
          drainedPtyCount: waits.length - pendingSessionIds.length,
          pendingSessionIds,
          killErrors,
          durationMs: Date.now() - startedAt,
          error: 'pty_drain_timeout',
        };
      }
      this._shutdownExitWaiters.clear();
      this._shutdownDrainedSessions.clear();
      this.sessions.clear();

      return {
        safeToQuit: true,
        drainedPtyCount: waits.length,
        killErrors,
        durationMs: Date.now() - startedAt,
      };
    })();

    const activeDrain = this._shutdownDrainPromise;
    void activeDrain.then((result) => {
      if (result && result.safeToQuit === false && this._shutdownDrainPromise === activeDrain) {
        this._shutdownDrainPromise = null;
      }
    });
    return activeDrain;
  }

  static geminiDisplayName(id) {
    if (!id) return 'Gemini';
    return id
      .replace(/^gemini-/, 'Gemini ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .replace(/^Gemini (\d)/, 'Gemini $1');
  }

  // Strip ANSI escape codes from terminal output for pattern matching.
  static stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]|\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '');
  }
}

// Read tail N turns from a CLI transcript file and format into a prompt-injectable
// context block. Returns null if file unavailable or no usable turns.
//   kind:    'claude' | 'deepseek-legacy' | 'deepseek' | 'codex' | 'gemini'
//   sourcePath: kind-specific transcript file path
//
// DeepSeek now uses the Codex rollout shape. Only the internal deepseek-legacy
// runtime retains Claude's JSONL shape for pre-migration transcript recovery.
async function readTranscriptTail(kind, sourcePath, n = 10, opts = {}) {
  if (!sourcePath) return null;
  // Prompt injection has a real transport/context budget. Keep that explicit,
  // but never use raw rollout size as a reason to drop Codex history.
  const MAX_INJECT = 50 * 1024;
  if (isCodexCliKind(kind)) {
    try {
      const parsed = opts.parserService && typeof opts.parserService.parse === 'function'
        ? await opts.parserService.parse('codex', sourcePath, { limit: n, fromTail: true })
        : { turns: require('./codex-transcript-parser.js').parseCodexRolloutToTurns(
          sourcePath,
          { limit: n, fromTail: true },
        ) };
      const joined = (parsed.turns || []).map(turn => (
        turn.role === 'user' ? `USER: ${turn.text}` : `ASSISTANT: ${turn.text}`
      )).join('\n\n');
      return joined.length > MAX_INJECT ? joined.slice(0, MAX_INJECT) + '\n[CONTEXT TRUNCATED]' : joined;
    } catch (e) {
      console.warn(`[hub] readTranscriptTail(${kind}) failed:`, e.message);
      return null;
    }
  }
  // T13 fix: refuse oversized transcripts (>5MB) to avoid main-process memory spike
  // (readFileSync + split allocates ~2x file size in RAM).
  try {
    const stat = await fs.promises.stat(sourcePath);
    if (stat.size > 5 * 1024 * 1024) {
      console.warn(`[hub] readTranscriptTail skipping ${sourcePath} (${(stat.size/1024/1024).toFixed(1)}MB > 5MB cap)`);
      return null;
    }
  } catch { return null; }
  try {
    if (kind === 'gemini' && sourcePath.endsWith('.json') && !sourcePath.endsWith('.jsonl')) {
      // Gemini old format: single JSON file
      const obj = JSON.parse(await fs.promises.readFile(sourcePath, 'utf-8'));
      const msgs = Array.isArray(obj.messages) ? obj.messages.slice(-n) : [];
      const joined = msgs.map(m => {
        if (m.type === 'user') return `USER: ${(m.content||[]).map(c=>c.text).filter(Boolean).join('')}`;
        if (m.type === 'gemini') return `ASSISTANT: ${typeof m.content==='string'?m.content:''}`;
        return null;
      }).filter(Boolean).join('\n\n');
      return joined.length > MAX_INJECT ? joined.slice(0, MAX_INJECT) + '\n[CONTEXT TRUNCATED]' : joined;
    }
    // JSONL: tail N lines
    const lines = (await fs.promises.readFile(sourcePath, 'utf-8')).trim().split('\n').slice(-n*2);
    const out = [];
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (isClaudeFamily(kind)) {
        // Claude and migration-only deepseek-legacy share one JSONL shape.
        if (obj.type === 'user' && obj.message?.content) {
          const userText = typeof obj.message.content === 'string' ? obj.message.content : textFromContent(obj.message.content);
          if (!isSyntheticUserEntry(obj, userText)) out.push(`USER: ${userText}`);
        }
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          const txt = obj.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
          if (txt) out.push(`ASSISTANT: ${txt}`);
        }
      } else if (isCodexCliKind(kind)) {
        if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete' && obj.payload?.last_agent_message) {
          out.push(`ASSISTANT: ${obj.payload.last_agent_message}`);
        } else if (obj.type === 'response_item' && obj.payload?.role === 'user' && obj.payload?.content) {
          const userText = textFromContent(obj.payload.content);
          if (!isSyntheticUserEntry(obj, userText)) out.push(`USER: ${userText}`);
        }
      } else if (kind === 'gemini') {
        if (obj.type === 'user') {
          out.push(`USER: ${(obj.content||[]).map(c => c.text).filter(Boolean).join('')}`);
        }
        if (obj.type === 'gemini') {
          out.push(`ASSISTANT: ${typeof obj.content === 'string' ? obj.content : ''}`);
        }
      }
    }
    const joined = out.slice(-n).join('\n\n');
    return joined.length > MAX_INJECT ? joined.slice(0, MAX_INJECT) + '\n[CONTEXT TRUNCATED]' : joined;
  } catch (e) {
    console.warn(`[hub] readTranscriptTail(${kind}) failed:`, e.message);
    return null;
  }
}

module.exports = {
  SessionManager,
  MEMORY_RELEASE_SUSPEND_OPTIONS,
  readTranscriptTail,
  dismissCodexUpdatePrompt,
  dismissCodexRateLimitDialog,
  clearSessionManagerConfigCache,
  _private: {
    buildNativeCodexOptions,
    sharedCodexRuntimeEnabled,
    ensureCodexCwdTrusted,
    clearProxyEnv,
    applyProxyEnv,
    applyInteractiveTerminalEnv,
    isClaudeApiBackend,
    isCodexApiBackend,
    shouldUseClaudeFastSettings,
    claudePermissionModeArg,
    buildClaudePtyLaunch,
    buildCodeAgentPtyLaunch,
    applyClaudeSessionEnv,
    resolveClaudeLaunchModel,
    quotePowerShellLiteral,
    resolveKimiExecutable,
    kimiCommandPrefix,
    isKimiModelConfigured,
    kimiModelArg,
    buildGroupChatIsolationFlags,
    buildClaudeMeetingMcpArgs,
    listCodexMcpServerNames,
    normalizeCodexMcpProfile,
    resolveCodexMcpProfile,
    normalizeCodexEffort,
    normalizeCodexSpeedTier,
    resolveCodexSpeedTier,
    buildCodexSpeedTierArg,
    buildCodexContextWindowArg,
    normalizeClaudeMcpProfile,
    buildClaudeMcpProfileArgs,
    isWirelessWorkspace,
    buildCodexMcpIsolationArgs,
    buildCodexGroupMcpIsolationArgs,
    buildCodexEphemeralMcpArgs,
    stripCodexMcpEntries,
    getSessionResumeIdentity,
    supportsRecoverableSuspend,
    DEFAULT_IDLE_SUSPEND_MS,
  },
};
