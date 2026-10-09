const { app, BrowserWindow, ipcMain, clipboard, dialog, nativeImage, screen, shell, Menu } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
// Freeze the running window's build before a later source-mode merge changes
// files on disk, even if its first native session is opened much later.
require('./core/runtime-build-info').runtimeBuildInfo();

// 2026-05-16 maintainer：防卡死后门 — 默认开 Chromium CDP 端口（OS 自动分配）。
//   实际分配的端口在启动后写入 <dataDir>/control/<pid>.json 的 cdpPort 字段，
//   救援脚本 tools/hub-escape.ps1 + Playwright/DevTools 可 attach 进 Hub。
//   设环境变量 CLAUDE_HUB_NO_CDP=1 可关闭。
//   必须在 app.whenReady() 之前 appendSwitch 才生效。
//   注：如果启动命令行已经传了 --remote-debugging-port（E2E 测试用 hub-launcher 的场景），
//   不重复 append，避免 Chromium argv 冲突。
const _hasCdpSwitch = process.argv.some(a => a.startsWith('--remote-debugging-port'));
if (process.env.CLAUDE_HUB_NO_CDP !== '1' && !_hasCdpSwitch) {
  app.commandLine.appendSwitch('remote-debugging-port', '0');
}
const { SessionManager, clearSessionManagerConfigCache } = require('./core/session-manager.js');
const { WorkspaceService, normalizeKey: normalizeWorkspaceKey } = require('./core/workspace-service.js');
const stateStore = require('./core/state-store.js');
const { getHubDataDir, isIsolatedHub, getMeetingWorkspaceDir } = require('./core/data-dir.js');
const {
  appendManagedLaunchAudit,
  inspectManagedLaunchAudit,
  managedLaunchAuditPath,
} = require('./core/managed-launch-audit.js');
const { spawn } = require('child_process');
const { launchHubInstance } = require('./core/hub-instance-launcher.js');
const {
  HUB_APP_USER_MODEL_ID,
  ensureWindowsShellIntegration,
  startWindowsShellIntegrationWatchdog,
} = require('./core/windows-shell-integration.js');
const {
  describeBrandingHealth,
  resolveHubLaunchExePath,
} = require('./core/hub-exe-branding.js');
const { isPackagedHubRuntime } = require('./core/electron-runtime-mode.js');
const { acquireLockAsync, releaseLockAsync } = require('./core/file-lock.js');
const {
  ensureClaudeHookIntegration,
  startClaudeHookIntegrationWatchdog,
} = require('./core/claude-hook-integration.js');
const { cleanupFileClaimsTmp } = require('./core/file-claims-tmp-cleanup.js');
const hubControl = require('./core/hub-control.js');
const { MeetingRoomManager } = require('./core/meeting-room.js');
const meetingStore = require('./core/meeting-store.js');
const sessionStore = require('./core/session-store.js');
const { TranscriptTap } = require('./core/transcript-tap');
const { CompletionNotifier } = require('./core/completion-notifier.js');
const { createHtmlArtifactPreviewRenderer } = require('./core/html-artifact-preview.js');
const { normalizeEventTime } = require('./core/session-attention-state.js');
const { createUsageFilter } = require('./core/usage-filter.js');
const scenes = require('./core/group-chat-scenes.js');
const groupchat = require('./core/group-chat-orchestrator.js');
const cliReadyDetector = require('./core/group-chat-cli-ready-detector.js');
const { getConfig: getHubConfig } = require('./core/hub-config.js');
const {
  createFixtureProbe: createNetworkEgressFixtureProbe,
  createNetworkEgressMonitor,
} = require('./core/network-egress-monitor.js');
const {
  resolveCodexUsageScope,
  attachCodexUsageScope,
  filterUsageCacheForCodexScope,
} = require('./core/codex-usage-scope.js');
const { ALL_AI_KINDS, isClaudeFamily, isCodexCliKind, isKimiCliKind, isCodeAgentKind, SLOT_IDS, KIND_LABELS, getSlotPromptName, getSlotDisplayLabel, slotIdToIndex, slotIndexToId } = require('./core/ai-kinds.js');
const { registerConfigIpc } = require('./main/ipc/config-handlers.js');
const { registerWorkbenchOperationsIpc } = require('./main/ipc/workbench-operations-handlers.js');
const { createWorkbenchOperationsService } = require('./core/workbench-operations.js');
const { registerPathIpc } = require('./main/ipc/path-handlers.js');
const { registerSessionIpc } = require('./main/ipc/session-handlers.js');
const { registerPromptSubmitIpc } = require('./main/ipc/prompt-submit-handlers.js');
const { createClaudeQuotaResume, registerClaudeQuotaIpc } = require('./main/claude-quota-resume.js');
const { registerWorkspaceIpc } = require('./main/ipc/workspace-handlers.js');
const { getTerminalBatchDelay, isBackgroundMember } = require('./main/terminal-output-policy.js');
const { TerminalOutputBatcher } = require('./main/terminal-output-batcher.js');
const { registerUsageIpc } = require('./main/ipc/usage-handlers.js');
const { registerMeetingIpc } = require('./main/ipc/meeting-handlers.js');
const { registerMeetingCreateIpc } = require('./main/ipc/meeting-create-handlers.js');
const { registerMeetingTimelineIpc } = require('./main/ipc/meeting-timeline-handlers.js');
const { registerTranscriptIpc } = require('./main/ipc/transcript-handlers.js');
const { registerCliStatusIpc } = require('./main/ipc/cli-status-handlers.js');
const { registerPromptInspectIpc } = require('./main/ipc/prompt-inspect-handlers.js');
const { registerPersistenceIpc } = require('./main/ipc/persistence-handlers.js');
const { registerAppUtilityIpc } = require('./main/ipc/app-utility-handlers.js');
const { createDesktopNotificationController } = require('./main/desktop-notification-controller.js');
const { registerProcessReclaimIpc } = require('./main/ipc/process-reclaim-handlers.js');
const { registerMemoryReleaseIpc } = require('./main/ipc/memory-release-handlers.js');
const { registerDiskReleaseIpc } = require('./main/ipc/disk-release-handlers.js');
const { registerDesktopOrganizerIpc } = require('./main/ipc/desktop-organizer-handlers.js');
const { registerAutoSuspendIpc } = require('./main/ipc/auto-suspend-handlers.js');
const { registerGroupchatQueryIpc } = require('./main/ipc/groupchat-query-handlers.js');
const { registerGroupchatRecoveryIpc } = require('./main/ipc/groupchat-recovery-handlers.js');
const { registerGroupchatSupplementIpc } = require('./main/ipc/groupchat-supplement-handlers.js');
const { registerGroupchatTurnIpc } = require('./main/ipc/groupchat-turn-handlers.js');
const { createResumeSessionHandler, registerResumeSessionIpc } = require('./main/ipc/resume-session-handlers.js');
const { createGroupChatDispatcher } = require('./main/groupchat/dispatcher.js');
const {
  collectProtectedSessionIds,
  createSessionAutoSuspendScheduler,
} = require('./main/session-auto-suspend.js');
const { createAutoTitleManager } = require('./main/auto-title-manager.js');
const {
  parseCodexUsage,
  parseGeminiUsage,
  parseKimiUsage,
  stripAnsi,
} = require('./main/usage/agent-usage-parser.js');
const {
  expireCodexUsageWindows,
  readCodexAccountUsage,
  shouldPreferCodexLiveUsage,
} = require('./main/usage/codex-app-server-usage.js');
const { readKimiAccountUsage } = require('./main/usage/kimi-account-usage.js');
const { createTokenPlanUsageService } = require('./main/usage/token-plan-usage.js');
const { readDeepSeekAccountBalance } = require('./main/usage/deepseek-account-balance.js');
const {
  didClaudeSnapshotAdvance,
  selectClaudeStatuslineUsage,
} = require('./main/usage/claude-statusline-usage.js');
const {
  pruneCodexCliUsage,
  recordCodexCliUsage,
  selectCodexCliUsageForScope,
} = require('./main/usage/scoped-codex-cli-usage.js');
const {
  mergeCodexEntry,
  mergeUsageCacheSnapshots,
  readUsageCacheFile,
  writeMergedUsageCacheFile,
  writeMergedUsageCacheFileSync,
} = require('./main/usage/usage-cache-merge.js');

function isCodexBaseKind(kind) {
  return isCodexCliKind(kind);
}
const { readLastAssistantMessage } = require('./core/read-last-assistant.js');
const { readTranscriptTail } = require('./core/session-manager');
const { parseClaudeTranscriptToTurns, isTaskNotificationText } = require('./core/claude-transcript-parser.js');
const { TranscriptParserService } = require('./core/transcript-parser-service.js');
const { CodexJsonlUsageService } = require('./main/usage/codex-jsonl-usage-service.js');
const {
  claudeProjectRoots,
  findTranscriptByCCSessionId,
  healPersistedCwds,
  projectSlug,
} = require('./core/claude-transcript-locator.js');
const {
  DEFAULT_CODEX_SESSIONS_ROOT,
  parseCodexRolloutToTurns,
  findCodexRolloutBySid,
  findCodexRolloutByCwd,
  isUsableCodexRolloutPath,
  isCodexSubagentRolloutPath,
  readCodexRolloutMeta,
} = require('./core/codex-transcript-parser.js');
const { registerArchiveIpc } = require('./main/ipc/archive-handlers.js');
const { registerSessionReferenceIpc } = require('./main/ipc/session-reference-handlers.js');
const { SessionSearchService } = require('./core/session-search-service.js');
const transcriptParserService = new TranscriptParserService();
const codexJsonlUsageService = new CodexJsonlUsageService();
function sessionSearchRoots(envName, defaults) {
  if (process.env.HUB_SESSION_SEARCH_DISABLE_NATIVE === '1') return [];
  const configured = String(process.env[envName] || '').trim();
  return configured
    ? configured.split(path.delimiter).map(value => value.trim()).filter(Boolean)
    : defaults;
}
const sessionSearchService = new SessionSearchService({
  cachePath: path.join(getHubDataDir(), 'cache', 'session-search-v2.json'),
  claudeRoots: sessionSearchRoots('HUB_SESSION_SEARCH_CLAUDE_ROOTS', claudeProjectRoots()),
  codexRoots: sessionSearchRoots('HUB_SESSION_SEARCH_CODEX_ROOTS', [DEFAULT_CODEX_SESSIONS_ROOT]),
  // 2026-08-28：补上 Kimi 与 Gemini。此前只有 claude/codex/meeting 三个适配器，
  // Kimi 的 45 个会话、Gemini 的 21 个会话正文一条都进不了索引。
  kimiRoots: sessionSearchRoots('HUB_SESSION_SEARCH_KIMI_ROOTS', [path.join(os.homedir(), '.kimi-code', 'sessions')]),
  geminiRoots: sessionSearchRoots('HUB_SESSION_SEARCH_GEMINI_ROOTS', [path.join(os.homedir(), '.gemini', 'tmp')]),
  meetingDir: path.join(getHubDataDir(), 'meetings'),
  // 每个会话一份只含对话的 md 聊天记录，供分享路径与造梦阅读；由索引派生，可重建。
  transcriptDir: require('./core/data-dir').getHubTranscriptDir(),
  refreshTtlMs: Number(process.env.HUB_SESSION_SEARCH_REFRESH_TTL_MS) || 60_000,
  // Production warms the persistent index after the latency-sensitive boot
  // path. Isolated Hubs stay opt-in so an unrelated E2E can never scan the
  // user's real native transcript roots merely because it launched the app.
  prewarmEnabled: process.env.HUB_SESSION_SEARCH_PREWARM === '1'
    || (process.env.HUB_SESSION_SEARCH_PREWARM !== '0' && !isIsolatedHub()),
});
const transcriptTap = new TranscriptTap({ parserService: transcriptParserService });
// PTY Claude 在 /clear、/resume、重启后跟随新的原生身份；判据见 core/claude-identity-switch.js。
const claudeIdentitySwitch = require('./core/claude-identity-switch').createClaudeIdentitySwitch();
// AIHubCommunity.exe is a branded copy of Electron's default-app host. Electron
// 41 reports app.isPackaged=true solely because the exe was renamed, while
// process.defaultApp remains true and argv still contains this source tree.
// Using app.isPackaged directly strips the app-root from Jump List launches and
// also points hook deployment at the wrong resources directory.
const HUB_IS_PACKAGED = isPackagedHubRuntime({
  appIsPackaged: app.isPackaged,
  defaultApp: process.defaultApp,
});
// Recovery can temporarily attach several listeners per group-chat seat.
try { transcriptTap.setMaxListeners(100); } catch {}

// === EPIPE 防护（隔离 Hub 启动必需）===
// PowerShell `& exe ...` + run_in_background 启动模式下，parent 退出后
// stdout/stderr 管道关闭。任何 console.log/warn/error 写入会触发 EPIPE，
// 未捕获时整个 Electron 主进程崩溃（红色 "JavaScript error" dialog）。
// 真实触发点：listenWithFallback 端口被占用时 console.warn → EPIPE → uncaught。
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.on('uncaughtException', (e) => {
  if (e && e.code === 'EPIPE') return;
  throw e;
});

const STARTUP_TRACE = process.env.HUB_STARTUP_TRACE === '1';
const STARTUP_T0 = Date.now();
function traceStartup(msg) {
  if (!STARTUP_TRACE) return;
  console.log(`[startup +${Date.now() - STARTUP_T0}ms] ${msg}`);
}

// Isolate Chromium userData when CLAUDE_HUB_DATA_DIR is set (parallel test
// instances). Must run before app.whenReady(). Production Hub unaffected
// because the env var is only set by test harnesses.
if (process.env.CLAUDE_HUB_DATA_DIR) {
  app.setPath('userData', path.join(process.env.CLAUDE_HUB_DATA_DIR, 'electron-userdata'));
}
const HIDDEN_E2E_WINDOW_REQUESTED = process.env.CLAUDE_HUB_E2E === '1'
  && process.env.CLAUDE_HUB_E2E_WINDOW_MODE === 'hidden';
const HIDDEN_E2E_DATA_DIR_SAFE = isIsolatedHub()
  && path.resolve(getHubDataDir()).toLowerCase()
    !== path.resolve(path.join(os.homedir(), '.ai-hub-community')).toLowerCase();
if (HIDDEN_E2E_WINDOW_REQUESTED && !HIDDEN_E2E_DATA_DIR_SAFE) {
  throw new Error('hidden E2E window mode requires a non-production CLAUDE_HUB_DATA_DIR');
}
// Background E2E: the window renders like a visible one but sits off-screen,
// never activates and stays out of the taskbar, so a test run cannot steal the
// keyboard from someone typing in the production Hub.
const BACKGROUND_E2E_WINDOW_REQUESTED = process.env.CLAUDE_HUB_E2E_WINDOW_MODE === 'background';
if (BACKGROUND_E2E_WINDOW_REQUESTED && !HIDDEN_E2E_DATA_DIR_SAFE) {
  throw new Error('background E2E window mode requires a non-production CLAUDE_HUB_DATA_DIR');
}
const e2eDesktopSandbox = require('./core/e2e-desktop-sandbox.js');
if (BACKGROUND_E2E_WINDOW_REQUESTED) {
  e2eDesktopSandbox.prepareBackgroundChromium(app);
  app.on('browser-window-created', (_event, win) => e2eDesktopSandbox.keepWindowInBackground(win));
}
// Isolated E2E runs (background or hidden) keep their own in-memory clipboard;
// a test that must check the real one opts in with CLAUDE_HUB_E2E_REAL_CLIPBOARD=1.
if (HIDDEN_E2E_DATA_DIR_SAFE
    && ['background', 'hidden'].includes(process.env.CLAUDE_HUB_E2E_WINDOW_MODE)
    && process.env.CLAUDE_HUB_E2E_REAL_CLIPBOARD !== '1') {
  e2eDesktopSandbox.installFakeClipboard({ clipboard, nativeImage, ipcMain });
  process.env.CLAUDE_HUB_E2E_FAKE_CLIPBOARD_ACTIVE = '1';
  console.log('[e2e] in-memory clipboard active. Native copies (Ctrl+C in pages, webContents.copy) still reach the system '
    + 'clipboard and are not visible here; a test that checks them sets CLAUDE_HUB_E2E_REAL_CLIPBOARD=1.');
}

// Auto-deploy hook scripts + settings.json config on first launch.
// Idempotent — keeps Hub-owned entries current and preserves unrelated hooks.
// claudeDirPath: target Claude config dir (e.g. ~/.claude or ~/.claude-deepseek)
function ensureHooksDeployed(claudeDirPath) {
  const claudeDir = claudeDirPath;
  const srcDir = HUB_IS_PACKAGED
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');
  const hookResult = ensureClaudeHookIntegration({
    claudeDir,
    sourceScriptsDir: srcDir,
    logger: console,
  });
  if (hookResult.errors.length) {
    console.warn(`[claude-hooks] ${claudeDir}: ${hookResult.errors.join('；')}`);
  }

  // Ensure .claude.json project trust — Claude Code 将"信任文件夹"状态
  //    存在 .claude.json 而非 settings.json。隔离配置(~/.claude-deepseek)缺少
  //    主配置(~/.claude)的历史信任记录，需要每次启动检查并修复。
  const statePath = path.join(claudeDir, '.claude.json');
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(raw);
    if (state.projects && typeof state.projects === 'object') {
      let trustChanged = false;
      for (const [projectDir, proj] of Object.entries(state.projects)) {
        if (proj && typeof proj === 'object' && proj.hasTrustDialogAccepted === false) {
          proj.hasTrustDialogAccepted = true;
          trustChanged = true;
          console.log(`[群聊] .claude.json trust fixed: ${projectDir}`);
        }
      }
      if (trustChanged) {
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
        console.log('[群聊] .claude.json trust state updated');
      }
    }
  } catch { /* .claude.json 不存在或格式异常，跳过（首次启动可能尚未生成） */ }
}

// Ensure Codex CLI status bar includes context-remaining so the scanner can
// parse context usage. Idempotent — only patches if the key is absent.
function ensureCodexContextConfig() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const configPath = path.join(home, '.codex', 'config.toml');
  try {
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf8'); } catch {}
    if (content.includes('status_line')) return;
    const line = '\n[tui]\nstatus_line = ["model-with-reasoning", "context-remaining", "current-dir"]\n';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.appendFileSync(configPath, line);
    console.log('[群聊] codex config.toml patched with context-remaining');
  } catch (e) {
    console.warn('[群聊] codex config patch failed:', e.message);
  }
}

function ensureGeminiMcpInstalled() {}

// Read the last user message text from a Claude Code transcript JSONL file.
// Reads the trailing chunk(s) only (not the whole file) — long sessions can be
// 10MB+ and we used to readFileSync the whole thing on every hook POST, which
// stalled the main-process event loop. Now we seek from EOF and walk backward
// in 64KB chunks until we hit the first complete `user`-typed entry.
// Returns null on any failure — caller should treat absence as non-fatal.
async function readLastUserMessage(transcriptPath) {
  const CHUNK = 65536;
  let fh;
  try {
    fh = await fs.promises.open(transcriptPath, 'r');
    const { size } = await fh.stat();
    let pos = size;
    let tail = '';
    while (pos > 0) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, pos);
      tail = buf.toString('utf-8') + tail;
      const lines = tail.split('\n');
      // The first fragment may be an incomplete line — keep it for the next pass
      // by prepending it back to `tail`, except when we've reached the very start.
      const firstFragment = pos === 0 ? null : lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const role = entry.type || entry.role;
        if (role !== 'user') continue;
        const msg = entry.message;
        let text = '';
        if (typeof msg === 'string') {
          text = msg;
        } else if (msg && typeof msg.content === 'string') {
          text = msg.content;
        } else if (msg && Array.isArray(msg.content)) {
          // CC stores tool_result entries as role=user too (Anthropic API
          // convention). Skip those — they pollute the preview with strings
          // like "[Image: source: ]" pulled from tool return payloads.
          const hasTool = msg.content.some(c => c && c.type === 'tool_result');
          if (hasTool) continue;
          text = msg.content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' ').trim();
        }
        // 后台任务 / Monitor 的续跑由引擎注入，不是用户说的话，继续往前找真正的提问。
        if (entry.origin?.kind === 'task-notification' || isTaskNotificationText(text)) continue;
        if (text) return text;
      }
      tail = firstFragment == null ? '' : firstFragment;
    }
  } catch {
    // swallowed — non-fatal
  } finally {
    if (fh) { try { await fh.close(); } catch {} }
  }
  return null;
}

// Hook server picks the first free port in this range.
const HOOK_PORT_CANDIDATES = [
  3456, 3457, 3458, 3459, 3460,
  3461, 3462, 3463, 3464, 3465,
  3466, 3467, 3468, 3469, 3470,
  3471, 3472, 3473, 3474, 3475,
];
// Random per-launch token; hook POSTs must carry it. Stops any other local
// process from forging unread bumps.
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');

let hookPort = null;  // set after listen() succeeds
let claudeHookWatchdog = null;
let windowsShellWatchdog = null;

let mainWindow;
let desktopNotificationController = null;
const sessionManager = new SessionManager();
const { SessionTokenUsageService } = require('./main/usage/session-token-usage-service.js');
const { isSessionViewer } = require('./core/session-observer-policy');
const { createContentUpdateBatcher } = require('./core/content-update-batcher');
const nativeItemNotifications = createContentUpdateBatcher();
const sessionUsageService = new SessionTokenUsageService({
  publish(id, usage) {
    const current = sessionManager.getSession(id);
    if (!current || current.status === 'exited') return;
    const persisted = lastPersistedSessions.find(item => item.hubId === id);
    const old = current?.sessionUsage || persisted?.sessionUsage;
    if (old?.sourcePath === usage.sourcePath && old.total > usage.total) return;
    const updated = sessionManager.updateSessionMeta(id, { sessionUsage: usage });
    if (persisted) persisted.sessionUsage = usage;
    if (updated) sessionStore.markDirty(id, updated);
    sendToRenderer('session-usage-updated', { sessionId: id, usage });
  },
});
sessionManager.on('session-token-usage', event => {
  sessionUsageService.native(sessionManager.getSession(event.sessionId), event.total);
});
sessionManager.on('session-usage-snapshot',event=>sessionUsageService.publish(event.sessionId,event.usage));
sessionManager.on('session-exited', event => sessionUsageService.remove(event.sessionId));
transcriptTap.on('session-bound', event => {
  const session = sessionManager.getSession(event.hubSessionId);
  if (session) sessionUsageService.bind({ ...session, transcriptPath: event.transcriptPath || event.rolloutPath || session.transcriptPath });
});
ipcMain.on('session-usage:watch', (_event, ids) => {
  if (!Array.isArray(ids)) return;
  for (const id of new Set(ids.filter(id => typeof id === 'string'))) {
    const session = sessionManager.getSession(id);
    if (session) sessionUsageService.bind(session);
  }
});
sessionManager.on('managed-launch', (record) => {
  appendManagedLaunchAudit(record, { logger: console });
});
sessionManager.on('codex-session-updated', session => {
  sessionUsageService.bind(session);
  sessionStore.markDirty(session.id, session);
  sendToRenderer('session-updated', {session});
});
sessionManager.on('codex-content-updated', event => sendToRenderer('codex-content-updated',event));
sessionManager.on('codex-backstage-updated', event => sendToRenderer('codex-backstage-updated',event));
sessionManager.on('codex-locate-request', ({ sessionId }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    sendToRenderer('codex-focus-session', { sessionId });
  }
});
sessionManager.on('codex-lifecycle', event => {
  transcriptTap.emit(event.type, event);
});
const meetingManager = new MeetingRoomManager();
const workspaceService = new WorkspaceService();
let networkEgressProbe;
if (process.env.CLAUDE_HUB_E2E === '1' && process.env.CLAUDE_HUB_EGRESS_FIXTURE) {
  try {
    networkEgressProbe = createNetworkEgressFixtureProbe(
      JSON.parse(process.env.CLAUDE_HUB_EGRESS_FIXTURE),
    );
  } catch (error) {
    console.warn('[network-egress] invalid E2E fixture:', error && error.message);
  }
}
const networkEgressMonitor = createNetworkEgressMonitor({
  getProxy: () => getHubConfig().proxy,
  statePath: path.join(getHubDataDir(), 'network-egress-state.json'),
  ...(networkEgressProbe ? { probe: networkEgressProbe } : {}),
  logger: console,
});
const completionNotifier = new CompletionNotifier({
  getConfig: getHubConfig,
  getLogPath: () => path.join(getHubDataDir(), 'notification-delivery.jsonl'),
  renderHtmlPreview: createHtmlArtifactPreviewRenderer({
    BrowserWindow,
    getOutputDir: getHubDataDir,
    logger: console,
  }),
  logger: console,
});
// SessionManager 构造不接收依赖；kimi 会话 spawn 前的 AGENTS.md seed 需要它
// （core/session-manager.js 里 this.workspaceService.seedUngovernedAgentsFile）。
sessionManager.workspaceService = workspaceService;
const workspaceMigrationSessionIds = new Set();

// 原生 Claude 撞到额度上限后的等待与续跑。CLI 的 REPL 以前自己干这件事，
//   stream-json 传输下没有输入框可敲，于是等待和发送都搬到 Hub 这边来。
//   判据全在 core/claude-quota-watchdog.js，这里只负责副作用。
const claudeQuotaResume = createClaudeQuotaResume({
  sessionManager,
  statePath: path.join(getHubDataDir(), 'claude-quota-waits.json'),
  isEnabled: () => getHubConfig().claudeQuotaAutoResume !== false,
  logger: console,
});

sessionManager.on('session-updated', session => {
  if (session.agentRuntime === 'pty' && isCodexCliKind(session.kind) && session.runtimeTruth) {
    sendToRenderer('session-updated', { session });
    return;
  }
  if (session.runtimeBackend !== 'claude-stream-json') return;
  sessionUsageService.bind(session);
  if(!isSessionViewer(session))sessionStore.markDirty(session.id, sessionManager.getSession(session.id));
  sendToRenderer('session-updated', { session });
});
sessionManager.on('native-agent-item', event => {
  const {sessionId,source,userMessageId,clientSubmissionId,epoch,providerSessionId}=event;
  nativeItemNotifications.schedule(sessionId,userMessageId || clientSubmissionId || '',()=>
    sendToRenderer('native-agent-item',{sessionId,source,userMessageId,clientSubmissionId,epoch,providerSessionId}));
});
sessionManager.on('native-agent-lifecycle', event => {
  nativeItemNotifications.flush(event.sessionId);
  if (event.signalSource !== 'claude-stream-json') return;
  const native = sessionManager.getNativeClaude(event.sessionId);
  const record = native?.records.get(event.clientSubmissionId);
  if (!native || !record) return;
  const payload = { ...event, submittedAt: record.createdAt, startedAt: native.runtime.startedAt,
    completedAt: native.runtime.completedAt, transcriptPath: null };
  if (event.type === 'submission-accepted') {
    transcriptTap.emit('prompt-submitted', { ...payload, text: record.text });
    sendToRenderer('session:prompt-receipt', { sessionId: event.sessionId,
      clientSubmissionId: event.clientSubmissionId, status: 'confirmed' });
  } else if (event.type === 'agent-turn-started') transcriptTap.emit('turn-started', payload);
  else if (event.type === 'agent-turn-complete') {
    if (event.status === 'completed') transcriptTap.emit('turn-complete', payload);
    else if (event.status === 'interrupted') transcriptTap.emit('turn-aborted', payload);
    else transcriptTap.emit('turn-error', { ...payload, message: native.runtime.reason });
    // 只有失败的一轮会武装等待，而且要在失败之后重读一次账号额度才作数。
    void Promise.resolve(claudeQuotaResume.onTurnComplete(event))
      .catch(error => console.warn('[claude-quota] arm failed:', error && error.message));
  }
});

// Deep-summary service singleton: instantiated from config-driven fallback chain.
// Providers tried in order; first one with a parseable response wins.

// Wire TranscriptTap → MeetingRoomManager timeline.
// When a sub-session's CLI finishes a turn, append the AI text to its
// meeting's timeline (if the sub-session belongs to a meeting).
transcriptTap.on('turn-complete', (ev) => {
  const { hubSessionId, text, completedAt } = ev || {};
  try { assistantService?.onTurnComplete?.(hubSessionId, { ...(ev || {}), completedAt: normalizeEventTime(completedAt, Date.now()) }); } catch (error) { console.warn('[assistant] usage', error.message); }
  sessionManager.noteAgentTurnFinished(hubSessionId, ev || {});
  const completionAt = normalizeEventTime(completedAt, Date.now());
  let session = sessionManager.getSession(hubSessionId);
  // Persist reply recency in main as well as renderer. This closes the gap where
  // a renderer reload/suspend between transcript completion and its IPC handler
  // left a dormant card anchored to the prompt time.
  if (session && completionAt >= (Number(session.lastCompletedAt) || 0)) {
    const updated = sessionManager.updateSessionMeta(hubSessionId, { lastCompletedAt: completionAt });
    if (updated) {
      session = updated;
      sessionStore.markDirty(hubSessionId, updated);
    }
  }
  Promise.resolve(completionNotifier.handleTurnComplete(ev || {}, session)).catch((error) => {
    console.warn('[completion-notifier] session completion handling failed:', error && error.message);
  });
  if (session && session.meetingId) {
    const turn = meetingManager.appendTurn(
      session.meetingId,
      hubSessionId,
      text,
      completionAt,
    );
    if (turn) {
      sendToRenderer('meeting-timeline-updated', { meetingId: session.meetingId, turn });
    }
    // (Driver-mode auto-review removed when driver mode was deprecated.)
  }

  // spec2/S3：把 turn-complete 广播给 renderer，供历史会话/侧边栏卡片实时刷新。
  // 注意：这里独立于上面的 meeting timeline 逻辑——非群聊的普通会话也要广播。
  try {
    let transcriptPath = ev && ev.transcriptPath ? ev.transcriptPath : null;
    if (!transcriptPath && session && session.transcriptPath) {
      transcriptPath = session.transcriptPath;
    }
    if (!transcriptPath && session && session.ccSessionId) {
      try { transcriptPath = findTranscriptByCCSessionId(session.ccSessionId); } catch {}
    }
    sendToRenderer('turn-complete-event', {
      hubSessionId,
      ccSessionId: session ? session.ccSessionId : null,
      transcriptPath,
      text,
      completedAt: completionAt,
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      durationMs: ev ? ev.durationMs : null,
      signalSource: ev ? ev.signalSource : null,
      turnId: ev ? ev.turnId || null : null,
    });
  } catch (e) {
    console.warn('[spec2/S3] turn-complete-event broadcast failed:', e && e.message);
  }
});

const autoTitleManager = createAutoTitleManager({
  allAiKinds: ALL_AI_KINDS,
  getHubConfig,
  kindLabels: KIND_LABELS,
  meetingManager,
  sendToRenderer,
  sessionManager,
  workspaceService,
});
const { maybeAutoTitleMeetingFromPrompt, maybeAutoTitleSessionFromPrompt } = autoTitleManager;
// Codex /goal auto-continuations can begin without a user_message event. Keep
// this lifecycle signal separate from prompt-submitted so it cannot trigger
// auto-title or notification prompt bookkeeping with synthetic text.
transcriptTap.on('turn-started', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  completionNotifier.noteTurnStarted(ev);
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    if (session?.runtimeBackend !== 'claude-stream-json') sessionManager.noteAgentTurnStarted(ev.hubSessionId, {
      startedAt: ev.startedAt,
      signalSource: ev.signalSource || 'task_started',
      turnId: ev.turnId || null,
    });
  } catch (error) {
    console.warn('[codex task] main-process lifecycle note failed:', error && error.message);
  }
  try {
    sendToRenderer('turn-started-event', {
      hubSessionId: ev.hubSessionId,
      transcriptPath: ev.transcriptPath || (session ? session.transcriptPath : null),
      startedAt: ev.startedAt != null ? ev.startedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev.signalSource || 'task_started',
      turnId: ev.turnId || null,
    });
  } catch (error) {
    console.warn('[codex task] turn-started-event broadcast failed:', error && error.message);
  }
});

transcriptTap.on('turn-aborted', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  sessionManager.noteAgentTurnFinished(ev.hubSessionId, ev);
  completionNotifier.noteTurnAborted(ev);
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    sendToRenderer('turn-aborted-event', {
      hubSessionId: ev.hubSessionId,
      transcriptPath: ev.transcriptPath || (session ? session.transcriptPath : null),
      abortedAt: ev.abortedAt != null ? ev.abortedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev.signalSource || 'turn_aborted',
      turnId: ev.turnId || null,
    });
  } catch (error) {
    console.warn('[codex task] turn-aborted-event broadcast failed:', error && error.message);
  }
});

// Codex writes transport failures as task_complete.error. Forward the
// authoritative occurrence instead of relying only on PTY text, because the
// full-screen TUI can redraw an old error line during every later turn.
transcriptTap.on('turn-error', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  // Rollout errors carry completedAt. Label the terminal event before main
  // retains it, so renderer reload cannot turn a failed request into success.
  const failedAt = ev.failedAt != null ? ev.failedAt : ev.completedAt != null ? ev.completedAt : Date.now();
  sessionManager.noteAgentTurnFinished(ev.hubSessionId, { ...ev, failedAt });
  completionNotifier.noteTurnFailed(ev);
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    sendToRenderer('turn-failed-event', {
      hubSessionId: ev.hubSessionId,
      transcriptPath: ev.transcriptPath || (session ? session.transcriptPath : null),
      failedAt,
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev.signalSource || 'task_complete_error',
      turnId: ev.turnId || null,
      message: ev.message || 'Codex turn failed',
      errorInfo: ev.errorInfo || null,
      occurrenceId: ev.occurrenceId || null,
    });
  } catch (error) {
    console.warn('[codex task] turn-failed-event broadcast failed:', error && error.message);
  }
});

transcriptTap.on('prompt-submitted', (ev) => {
  const { hubSessionId, text, submittedAt } = ev || {};
  completionNotifier.notePromptSubmitted(ev || {});
  if (!hubSessionId) return;
  const session = sessionManager.getSession(hubSessionId);
  maybeAutoTitleSessionFromPrompt({ ...ev, text: require('./core/memory-index-envelope').splitMemoryIndex(text).userText });
  try {
    sendToRenderer('prompt-submitted-event', {
      hubSessionId,
      transcriptPath: ev ? ev.transcriptPath : null,
      text,
      submittedAt: submittedAt != null ? submittedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev ? ev.signalSource : null,
      turnId: ev ? ev.turnId || null : null,
    });
  } catch (e) {
    console.warn('[codex prompt] prompt-submitted-event broadcast failed:', e && e.message);
  }
});

// Kimi's main wire stays quiet while an Agent/Coder sub-agent does the actual
// work. PTY byte bursts cannot be used as a status signal for Kimi because its
// interactive TUI redraws on ordinary typing. Forward the authoritative
// Agent tool.call/tool.result lifecycle instead, so the sidebar stays running
// for the whole background job rather than turning idle after the main step.
transcriptTap.on('background-work-changed', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    sendToRenderer('background-work-event', {
      ...ev,
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : (ev.kind || null),
    });
  } catch (error) {
    console.warn('[kimi background] background-work-event broadcast failed:', error && error.message);
  }
});

// `contextMax` is the user's launch request. Codex can clamp it to the current
// model catalog and then applies its effective-window percentage. The actual
// runtime value arrives in token_count.model_context_window; persist it under a
// separate key so a later resume never turns the clamp into the next request.
transcriptTap.on('context-window-observed', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  const contextEffectiveMax = Number(ev.contextEffectiveMax);
  if (!Number.isInteger(contextEffectiveMax) || contextEffectiveMax <= 0) return;
  const observedAtValue = Number(ev.observedAt);
  const contextEffectiveObservedAt = Number.isFinite(observedAtValue) && observedAtValue > 0
    ? observedAtValue
    : Date.now();
  try {
    const current = sessionManager.getSession(ev.hubSessionId);
    if (!current) return;
    if (current.contextEffectiveMax === contextEffectiveMax
        && Number(current.contextEffectiveObservedAt) >= contextEffectiveObservedAt) return;
    const updated = sessionManager.updateSessionMeta(ev.hubSessionId, {
      contextEffectiveMax,
      contextEffectiveObservedAt,
    });
    if (!updated) return;
    void sessionStore.markDirtyImmediate(ev.hubSessionId, updated).catch((error) => {
      console.warn('[codex-context] per-session persist failed:', error && error.message);
    });
    const persisted = lastPersistedSessions.find(item => item && item.hubId === ev.hubSessionId);
    if (persisted) {
      persisted.contextEffectiveMax = contextEffectiveMax;
      persisted.contextEffectiveObservedAt = contextEffectiveObservedAt;
      persisted.updatedAt = Date.now();
    }
    sendToRenderer('session-updated', { session: updated });
  } catch (error) {
    console.warn('[codex-context] observation handling failed:', error && error.message);
  }
});

// Persist resume meta when transcript-tap binds a sub-session to its native CLI sid.
transcriptTap.on('session-bound', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  try {
    if (isCodexCliKind(ev.kind) && (ev.codexSid || ev.rolloutPath)) {
      const current = sessionManager.getSession(ev.hubSessionId);
      const patch = {};
      if (ev.codexSid) patch.codexSid = ev.codexSid;
      if (ev.rolloutPath) patch.transcriptPath = ev.rolloutPath;
      if (current && current.codexSessionsRoot) patch.codexSessionsRoot = current.codexSessionsRoot;
      if (current && current.codexAllowMtimeFallback) patch.codexAllowMtimeFallback = true;
      sessionManager.updateSessionMeta(ev.hubSessionId, patch);
    } else if (isClaudeFamily(ev.kind) && ev.transcriptPath) {
      sessionManager.updateSessionMeta(ev.hubSessionId, {transcriptPath:ev.transcriptPath});
    } else if ((ev.kind === 'gemini' || ev.kind === 'gemini-resume')
        && (ev.geminiChatId || ev.geminiProjectHash || ev.geminiProjectRoot)) {
      const patch = {};
      if (ev.geminiChatId) patch.geminiChatId = ev.geminiChatId;
      if (ev.geminiProjectHash) patch.geminiProjectHash = ev.geminiProjectHash;
      if (ev.geminiProjectRoot) patch.geminiProjectRoot = ev.geminiProjectRoot;
      if (ev.sessionPath) patch.transcriptPath = ev.sessionPath;
      sessionManager.updateSessionMeta(ev.hubSessionId, patch);
    } else if (isKimiCliKind(ev.kind) && (ev.kimiSid || ev.wirePath || ev.sessionDir)) {
      const patch = {};
      if (ev.kimiSid) patch.kimiSid = ev.kimiSid;
      if (ev.sessionDir) patch.kimiSessionDir = ev.sessionDir;
      if (ev.wirePath) patch.transcriptPath = ev.wirePath;
      sessionManager.updateSessionMeta(ev.hubSessionId, patch);
    }
  } catch {}
  // A recovered group-chat attempt may have resumed before its rollout was
  // bound. Binding is the strongest moment to retry collection: never resend
  // the prompt, just reconcile the persisted final answer for this sid.
  const recoveryTimer = setTimeout(() => {
    if (groupChatDispatcher && typeof groupChatDispatcher.recoverSession === 'function') {
      groupChatDispatcher.recoverSession(ev.hubSessionId).catch((error) => {
        console.warn('[groupchat] transcript-bound recovery failed:', error && error.message);
      });
    }
  }, 0);
  recoveryTimer.unref?.();
  // Find the session in lastPersistedSessions and merge new fields.
  const idx = lastPersistedSessions.findIndex(s => s.hubId === ev.hubSessionId);
  if (idx < 0) {
    if (isCodexCliKind(ev.kind) && (ev.codexSid || ev.rolloutPath)) {
      sendToRenderer('session-meta-updated', {
        hubSessionId: ev.hubSessionId,
        kind: ev.kind,
        codexSid: ev.codexSid,
        transcriptPath: ev.rolloutPath,
        codexSessionsRoot: sessionManager.getSession(ev.hubSessionId)?.codexSessionsRoot || null,
        codexAllowMtimeFallback: !!sessionManager.getSession(ev.hubSessionId)?.codexAllowMtimeFallback,
      });
    } else if ((ev.kind === 'gemini' || ev.kind === 'gemini-resume')
        && (ev.geminiChatId || ev.geminiProjectHash || ev.geminiProjectRoot)) {
      sendToRenderer('session-meta-updated', {
        hubSessionId: ev.hubSessionId,
        kind: ev.kind,
        geminiChatId: ev.geminiChatId,
        geminiProjectHash: ev.geminiProjectHash,
        geminiProjectRoot: ev.geminiProjectRoot,
      });
    } else if (isKimiCliKind(ev.kind) && (ev.kimiSid || ev.wirePath || ev.sessionDir)) {
      sendToRenderer('session-meta-updated', {
        hubSessionId: ev.hubSessionId,
        kind: ev.kind,
        kimiSid: ev.kimiSid,
        kimiSessionDir: ev.sessionDir,
        transcriptPath: ev.wirePath,
      });
    }
    return;
  }
  const cur = lastPersistedSessions[idx];
  let changed = false;
  if (isCodexCliKind(ev.kind) && ev.codexSid && cur.codexSid !== ev.codexSid) {
    cur.codexSid = ev.codexSid;
    changed = true;
  }
  if (isCodexCliKind(ev.kind) && ev.rolloutPath && cur.transcriptPath !== ev.rolloutPath) {
    cur.transcriptPath = ev.rolloutPath;
    changed = true;
  }
  const liveSession = isCodexCliKind(ev.kind) ? sessionManager.getSession(ev.hubSessionId) : null;
  if (isCodexCliKind(ev.kind) && liveSession && liveSession.codexSessionsRoot && cur.codexSessionsRoot !== liveSession.codexSessionsRoot) {
    cur.codexSessionsRoot = liveSession.codexSessionsRoot;
    changed = true;
  }
  if (isCodexCliKind(ev.kind) && liveSession && liveSession.codexAllowMtimeFallback && cur.codexAllowMtimeFallback !== true) {
    cur.codexAllowMtimeFallback = true;
    changed = true;
  }
  if (ev.kind === 'gemini') {
    if (ev.geminiChatId && cur.geminiChatId !== ev.geminiChatId) { cur.geminiChatId = ev.geminiChatId; changed = true; }
    if (ev.geminiProjectHash && cur.geminiProjectHash !== ev.geminiProjectHash) { cur.geminiProjectHash = ev.geminiProjectHash; changed = true; }
    if (ev.geminiProjectRoot && cur.geminiProjectRoot !== ev.geminiProjectRoot) { cur.geminiProjectRoot = ev.geminiProjectRoot; changed = true; }
  }
  if (isKimiCliKind(ev.kind)) {
    if (ev.kimiSid && cur.kimiSid !== ev.kimiSid) { cur.kimiSid = ev.kimiSid; changed = true; }
    if (ev.sessionDir && cur.kimiSessionDir !== ev.sessionDir) { cur.kimiSessionDir = ev.sessionDir; changed = true; }
    if (ev.wirePath && cur.transcriptPath !== ev.wirePath) { cur.transcriptPath = ev.wirePath; changed = true; }
  }
  if (changed) {
    cur.updatedAt = Date.now();  // 让后续 stateStore merge 用最新版本胜出
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: meetingManager.getAllMeetings(),
      immersiveByMeeting: _immersiveByMeeting,
    });
    // 2026-05-07 maintainer：sid 类字段一旦确定就立刻 sync 写 per-session JSON。
    //   不靠 200ms debounce，不靠 state.json 防抖 500ms——任何一个 race / crash
    //   都不会再让 Codex/Gemini 的 transcript 关联丢失。
    try { void sessionStore.markDirtyImmediate(ev.hubSessionId, cur); }
    catch (e) { console.warn('[hub] sessionStore sync persist failed:', e.message); }

    // Spec 3 · W12：广播给 renderer 让 sessions Map 即刻同步（之前只写磁盘，
    // renderer 内存不更新 → codex/gemini 的 resume meta 必须 reboot 才生效）
    sendToRenderer('session-meta-updated', {
      hubSessionId: ev.hubSessionId,
      kind: ev.kind,
      codexSid: cur.codexSid,
      transcriptPath: cur.transcriptPath,
      codexSessionsRoot: cur.codexSessionsRoot,
      codexAllowMtimeFallback: !!cur.codexAllowMtimeFallback,
      geminiChatId: cur.geminiChatId,
      geminiProjectHash: cur.geminiProjectHash,
      geminiProjectRoot: cur.geminiProjectRoot,
      kimiSid: cur.kimiSid,
      kimiSessionDir: cur.kimiSessionDir,
    });
    console.log(`[群聊] persisted resume meta for ${ev.kind} session ${ev.hubSessionId.slice(0,8)}`);
  }
});

sessionManager.hookToken = HOOK_TOKEN;  // port set after listen

// Pin a stable AppUserModelID before creating the window so Windows keeps Hub's
// taskbar identity independent from electron.exe. Native toast notifications are
// intentionally disabled; this identity is still required by shell shortcuts and
// Explorer taskbar reconstruction. win32-only.
if (process.platform === 'win32' && !isIsolatedHub()) {
  app.setAppUserModelId(HUB_APP_USER_MODEL_ID); // = package.json build.appId
}

// Windows drops the window HICON whenever the taskbar identity is rebuilt, and
// the button then falls back to electron.exe's own icon — the Electron atom.
//
// 2026-08-08：b4fd5d5 已经预见到这点，但只挂了 'show'/'restore'，而这两个事件
// 对一个**始终可见**的窗口永远不会触发。实测链条：系统 08-06 14:11 启动 →
// Hub 14:17 起来图标正常 → explorer.exe 08-07 19:56:47 崩溃重启（Application
// Error 1000/1001 三条）→ 任务栏重建、HICON 丢失 → 08-08 17:40 截图已是原子图标，
// 期间窗口一直开着，没有任何事件把图标补回去。
// 所以除事件外，还要在 shell watchdog 的每一拍无条件重贴一次。setIcon 幂等，
// NativeImage 缓存后单次开销就是一个 WM_SETICON，15 秒一次可以忽略。
let _cachedHubWindowIcon = null;
function getHubWindowIcon() {
  if (_cachedHubWindowIcon && !_cachedHubWindowIcon.isEmpty()) return _cachedHubWindowIcon;
  _cachedHubWindowIcon = nativeImage.createFromPath(path.join(__dirname, 'claude-wx.ico'));
  return _cachedHubWindowIcon;
}
function reassertHubWindowIcon() {
  if (process.platform !== 'win32') return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const icon = getHubWindowIcon();
  if (!icon || icon.isEmpty()) return false;
  mainWindow.setIcon(icon);
  return true;
}

function keepIsolatedE2EWindowHidden() {
  return HIDDEN_E2E_WINDOW_REQUESTED && HIDDEN_E2E_DATA_DIR_SAFE;
}

function focusPrimaryWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // A hidden isolated E2E still exercises the real BrowserWindow/webContents,
  // but must never flash a Hub look-alike onto the user's production desktop.
  // Requiring both flags keeps normal and production launches unchanged.
  if (keepIsolatedE2EWindowHidden()) return true;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  reassertHubWindowIcon();
  return true;
}

module.exports.focusPrimaryWindow = focusPrimaryWindow;

// T6：窗口按钮区的底色与符号色。默认值对应 dark 皮肤，换皮肤时由渲染层把
// **当前皮肤真实算出来的颜色**发过来（见 hub:titlebar-overlay）—— 主进程不再
// 维护第二份调色板，否则加一套皮肤就得改两个地方，迟早对不上。
const HUB_TITLE_BAR_OVERLAY_DEFAULT = Object.freeze({
  color: '#0f1319',
  symbolColor: '#7f8a9a',
  height: 44,
});

// 合法的 #rgb / #rrggbb。渲染层送来的是 getComputedStyle 的结果，
// 主题里偶尔会是 rgb() 或带 alpha 的写法，setTitleBarOverlay 不认，
// 认不出就退回默认值 —— 宁可颜色不跟，也不要让整个调用抛异常。
function normalizeOverlayColor(value, fallback) {
  const text = String(value || '').trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text) ? text : fallback;
}

// 最后一次真正应用成功的 overlay 颜色。E2E 要断言「换皮肤时窗口按钮区跟着变」，
// 而这件事在页面里看不见（那三个按钮是 Windows 画的，不在 DOM 里）—— 不记一笔
// 就只能靠截图比色，那既不稳也说不清到底是哪一步没生效。
let lastAppliedTitleBarOverlay = null;

function applyHubTitleBarOverlay(colors = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  // 原生标题栏模式下没有 overlay 可改，调了会抛。
  if (mainWindow._hubNativeTitleBar) return null;
  const next = {
    color: normalizeOverlayColor(colors.color, HUB_TITLE_BAR_OVERLAY_DEFAULT.color),
    symbolColor: normalizeOverlayColor(colors.symbolColor, HUB_TITLE_BAR_OVERLAY_DEFAULT.symbolColor),
    height: HUB_TITLE_BAR_OVERLAY_DEFAULT.height,
  };
  try {
    mainWindow.setTitleBarOverlay(next);
    lastAppliedTitleBarOverlay = next;
    return next;
  } catch (error) {
    // 非 Windows 平台、或窗口已经在销毁流程里 —— 换个颜色而已，不值得让它冒泡。
    console.warn('[titlebar] setTitleBarOverlay failed:', error && error.message);
    return null;
  }
}

// 窗口的真实形态。E2E 专用：页面里问不出「我上面有没有一条系统标题栏」，
// 只有主进程知道。
ipcMain.handle('debug:window-shape', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  return {
    title: mainWindow.getTitle(),
    nativeTitleBar: !!mainWindow._hubNativeTitleBar,
    maximized: mainWindow.isMaximized(),
    overlay: lastAppliedTitleBarOverlay,
  };
});

ipcMain.on('hub:titlebar-overlay', (_event, colors) => {
  applyHubTitleBarOverlay(colors || {});
});

// 双击工具栏空白处最大化 / 还原。原生标题栏本来就有这个行为，隐掉它之后必须
// 自己补 —— 少了这一下，用户会觉得顶部这条栏「是个假标题栏」。
ipcMain.handle('hub:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  // 返回的是「这次做了哪个动作」，不是做完之后的状态：Windows 上
  // maximize() 是异步的，紧跟着读 isMaximized() 拿到的还是旧值，
  // 那个返回值会稳定地骗人。真状态由 maximize / unmaximize 事件推给渲染层。
  const action = mainWindow.isMaximized() ? 'unmaximize' : 'maximize';
  mainWindow[action]();
  return action;
});

ipcMain.handle('hub:new-instance', () => launchHubInstance({
  appRoot: __dirname,
  execPath: isIsolatedHub() || HUB_IS_PACKAGED ? process.execPath : resolveHubLaunchExePath({
    execPath: process.execPath,
    icoPath: path.join(__dirname, 'claude-wx.ico'),
    productVersion: require('./package.json').version,
  }),
  isPackaged: HUB_IS_PACKAGED,
}));

function createWindow() {
  // Load the icon as a NativeImage so we can pass it to BrowserWindow AND
  // re-apply via setIcon — on Windows the constructor `icon` alone sometimes
  // misses the taskbar; the explicit setIcon nails it.
  const iconPath = path.join(__dirname, 'claude-wx.ico');
  const winIcon = getHubWindowIcon();

  // 标题动态读 package.json 版本号，避免硬编码漂移（card-redesign 0.2.0 起）
  const _pkgVersion = (() => {
    try { return require('./package.json').version || ''; } catch { return ''; }
  })();
  // 2026-05-03 maintainer：标题带 PID，方便桌面同时存在多个 Hub 窗口（生产+测试）时
  //   一眼区分哪个对应哪个 PID — 调试时不再需要 Get-Process 反查。
  // 社区版标题同时写出社区版本与所基于的上游版本，用户报问题时一眼可见。
  const _upstreamVersion = require('./core/distribution').upstreamVersion;
  const _hubTitle = `AI Hub Community v${_pkgVersion}${_upstreamVersion ? `（上游 ${_upstreamVersion}）` : ''}：PID ${process.pid}`;
  // T6 冷杉 v2：隐藏原生标题栏，让渲染层那条 44px 工具栏直接顶到窗口顶边。
  // 三个系统窗口按钮仍由 Windows 自己画（titleBarOverlay），所以最大化 / 还原 /
  // 关闭的行为、Snap Layouts、右键系统菜单全部保持原生，不需要 Hub 自己复刻一套。
  //
  // 逃生口：CLAUDE_HUB_NATIVE_TITLEBAR=1 时整段跳过，回到原生标题栏。
  // 无边框窗口出问题（远程桌面、某些 Windows 版本、辅助工具）时，用户还有一条
  // 不改代码就能开回去的路 —— Hub 是每天要用的工具，不能只有一种能开的形态。
  const nativeTitleBar = process.env.CLAUDE_HUB_NATIVE_TITLEBAR === '1';
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: _hubTitle,
    backgroundColor: '#0d1117',
    icon: winIcon,
    show: false,
    autoHideMenuBar: true,
    ...(nativeTitleBar ? {} : {
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...HUB_TITLE_BAR_OVERLAY_DEFAULT },
    }),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  mainWindow._hubNativeTitleBar = nativeTitleBar;
  require('./main/ipc/preview-immersive-handlers.js').bindPreviewImmersiveWindow(mainWindow);
  // 工具栏要知道窗口是不是最大化：Windows 最大化一个隐藏标题栏的窗口时，
  // 窗口会比屏幕大出一圈边框，顶部那几像素会被切掉。渲染层拿这个状态决定
  // 要不要补那一圈，而不是靠猜。
  const emitWindowState = () => {
    sendToRenderer('hub:window-state', {
      maximized: !mainWindow.isMaximized ? false : mainWindow.isMaximized(),
      fullScreen: !mainWindow.isFullScreen ? false : mainWindow.isFullScreen(),
      nativeTitleBar,
      version: _pkgVersion,
      pid: process.pid,
    });
  };
  mainWindow.on('maximize', emitWindowState);
  mainWindow.on('unmaximize', emitWindowState);
  mainWindow.on('enter-full-screen', emitWindowState);
  mainWindow.on('leave-full-screen', emitWindowState);
  mainWindow.webContents.on('did-finish-load', emitWindowState);
  if (!desktopNotificationController) {
    desktopNotificationController = createDesktopNotificationController({
      BrowserWindow,
      screen,
      ipcMain,
      htmlPath: path.join(__dirname, 'renderer', 'desktop-notification.html'),
      preloadPath: path.join(__dirname, 'renderer', 'desktop-notification-preload.js'),
      getMainWindow: () => mainWindow,
      focusPrimaryWindow,
      sendToRenderer,
      canShow: () => !keepIsolatedE2EWindowHidden()
        || process.env.CLAUDE_HUB_E2E_SHOW_NOTIFICATION === '1',
      logger: console,
    });
  }
  // index.html 的 <title>AI Hub Community</title> 在页面加载完成后会触发 page-title-updated 覆盖
  // BrowserWindow.title — preventDefault 阻止覆盖，保留带 PID 的标题
  mainWindow.on('page-title-updated', (e) => { e.preventDefault(); });

  if (!winIcon.isEmpty()) {
    mainWindow.setIcon(winIcon);
    // Windows can drop the source-mode HICON after the taskbar identity is
    // rebuilt (shortcut repair, Explorer refresh, multi-window regrouping).
    // These two cover the "window was hidden and came back" case; the
    // always-visible case is handled by the watchdog tick (see
    // reassertHubWindowIcon above).
    mainWindow.on('show', reassertHubWindowIcon);
    mainWindow.on('restore', reassertHubWindowIcon);
    mainWindow.on('focus', reassertHubWindowIcon);
  } else {
    console.warn('[icon] failed to load', iconPath);
  }

  let hasShown = false;
  const showMainWindow = () => {
    if (hasShown || !mainWindow || mainWindow.isDestroyed()) return;
    hasShown = true;
    if (keepIsolatedE2EWindowHidden()) {
      traceStartup('main window kept hidden for isolated E2E');
      return;
    }
    mainWindow.maximize();
    mainWindow.show();
  };
  ipcMain.once('renderer-sidebar-ready', showMainWindow);
  mainWindow.webContents.once('did-finish-load', showMainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    traceStartup('did-finish-load');
    sendToRenderer('hook-status', { up: hookPort !== null, port: hookPort });
    if (hubRestart.bootToken && !global.__loopResumeScanned) {
      global.__loopResumeScanned = true;
      // Keep the scanner available for future user-created workflows, while
      // admitting only groups restored by this restart or opened by the user.
      global.__devFileEngine?.start({onlyIds:[]});
    }
    // Phase 2b：boot 后由 main 循环引擎扫描未完成循环并自动续跑（main 驱动 + 自动 wake 成员）。once 守卫 + 延迟(等 session 恢复) + try，绝不影响启动。
    if (!global.__loopResumeScanned && !hubRestart.bootToken) {
      global.__loopResumeScanned = true;
      setTimeout(() => {
        if (hubRestart.isRestarting()) return;
        try { if (global.__loopEngine) global.__loopEngine.resumePending(); }
        catch (e) { console.warn('[loop] boot resume failed:', e && e.message); }
        global.__devFileEngine?.start();
      }, 8000);
    }
    if (!global.__groupChatRecoveryScanned && !hubRestart.bootToken) {
      global.__groupChatRecoveryScanned = true;
      setTimeout(() => {
        if (hubRestart.isRestarting()) return;
        Promise.resolve(groupChatDispatcher && groupChatDispatcher.recoverPendingAttempts())
          .then((summary) => {
            if (summary && summary.checked) console.log('[groupchat] boot attempt recovery:', summary);
          })
          .catch((error) => console.warn('[groupchat] boot attempt recovery failed:', error && error.message));
      }, 2000);
    }
  });
  setTimeout(showMainWindow, 4000);

  // 主 webContents 导航防护（2026-05-17 maintainer，2026-07-31 收紧）：renderer 若误把链接
  //   交给浏览器默认导航，会让主 webContents 整个跳走、Hub shell 和操作按钮一起消失。
  //   旧逻辑放行了所有 file://，所以本地 HTML 正好能绕过保护。主窗口现在只允许加载
  //   自己的 renderer/index.html；其他本地文件重新投递给 Hub preview webview。
  //   webview 内部导航走 guest webContents，不受这里影响。
  const hubShellPath = path.resolve(path.join(__dirname, 'renderer', 'index.html'));
  const isHubShellUrl = (urlStr) => {
    try {
      const u = new URL(urlStr);
      return u.protocol === 'file:'
        && path.resolve(fileURLToPath(u)).toLowerCase() === hubShellPath.toLowerCase();
    } catch { return false; }
  };
  const routeBlockedMainNavigation = (urlStr) => {
    try {
      const u = new URL(urlStr);
      if (u.protocol === 'file:') {
        const targetPath = fileURLToPath(u);
        console.warn('[nav-guard] block local file from main webContents -> preview', targetPath);
        sendToRenderer('preview-local-file', targetPath);
        return;
      }
      if (u.protocol === 'about:' || u.protocol === 'chrome:' || u.protocol === 'devtools:') {
        console.warn('[nav-guard] block internal protocol from main webContents:', urlStr);
        return;
      }
    } catch {}
    console.log('[nav-guard] block main webContents navigate to', urlStr, '→ openExternal');
    shell.openExternal(urlStr).catch((e) => console.warn('[nav-guard] openExternal failed:', e && e.message));
  };
  const interceptNavigate = (event, urlStr) => {
    if (isHubShellUrl(urlStr)) return;
    event.preventDefault();
    routeBlockedMainNavigation(urlStr);
  };
  mainWindow.webContents.on('will-navigate', interceptNavigate);
  mainWindow.webContents.on('will-redirect', interceptNavigate);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    routeBlockedMainNavigation(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (shutdownDrainState === 'drained' || shutdownDrainState === 'finalizing') return;
    // Closing the window releases its sessions; no invisible owner remains.
    event.preventDefault();
    void beginGracefulHubShutdown('window-close-requested');
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

var devWorkbench;
function sendToRenderer(channel, data) {
  if (devWorkbench) {
    try { devWorkbench.handleEvent(channel, data); }
    catch (error) { console.warn('[dev-workbench] event failed:', error.message); }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function syncSessionRuntimeModel(sessionId, model) {
  if (!sessionId || !model || typeof model.id !== 'string' || !model.id.trim()) return false;
  const session = sessionManager.getSession(sessionId);
  if (!session) return false;
  const currentId = session.currentModel && session.currentModel.id;
  if (currentId === model.id) return false;
  sessionManager.updateSessionMeta(sessionId, {
    currentModel: {
      id: model.id.trim(),
      displayName: String(model.displayName || model.id).trim().slice(0, 120),
    },
  });
  return true;
}

let groupChatDispatcher = null;
let sessionAutoSuspendScheduler = null;
let agentLeagueBridge = null;
let studyBridge = null;
const meetingTerminalActivitySentAt = new Map();
const terminalOutputBatcher = new TerminalOutputBatcher({
  emit: ({ sessionId, data, seq }) => {
    sendToRenderer('terminal-data', { sessionId, data, seq });
  },
});

sessionManager.onData = (sessionId, data, seq) => {
  // 未聚焦的群聊成员**降频转发，不再丢弃**。旧实现直接 return，让 xterm 在未聚焦
  // 期间收不到任何数据，切过去只能靠回灌一段截断的 ANSI 流重建画面 —— 对 alt-screen
  // TUI 来说基本只剩最后一屏，用户表现为"滚不上去 / 渲染卡住"。
  // 详见 main/terminal-output-policy.js 顶部。
  const delay = getTerminalBatchDelay(sessionManager, sessionId);
  if (isBackgroundMember(sessionManager, sessionId)) {
    // 房间列表的轻量活动指示仍然限流，2 次/秒足够，不受输出节奏影响。
    const now = Date.now();
    if (now - (meetingTerminalActivitySentAt.get(sessionId) || 0) >= 500) {
      meetingTerminalActivitySentAt.set(sessionId, now);
      sendToRenderer('meeting-terminal-activity', { sessionId });
    }
  }
  terminalOutputBatcher.push(sessionId, data, seq, delay);
};

sessionManager.onSessionClosed = (sessionId, meetingId, exitInfo) => {
  const isWorkspaceMigration = workspaceMigrationSessionIds.has(sessionId);
  completionNotifier.noteSessionClosed({ sessionId });
  terminalOutputBatcher.flush(sessionId);
  meetingTerminalActivitySentAt.delete(sessionId);
  if (!isWorkspaceMigration) groupChatDispatcher?.markProcessExitForSession(sessionId, exitInfo);
  // 让投研等原生 PTY 编排者能在用户关闭窗口或 CLI 异常退出时释放跨 Hub 租约。
  sessionManager.emit('session-exited', { sessionId, meetingId, exitInfo: exitInfo || null });

  try { transcriptTap.unregisterSession(sessionId); } catch {}
  // 会话真的关掉了，等待不该留在盘上等一个再也不会回来的席位。
  // 休眠走 onSessionSuspended，不经过这里，所以休眠会话的等待会保留。
  if (!isWorkspaceMigration) { try { claudeQuotaResume.forget(sessionId); } catch {} }
  // 群聊 cli-ready monotonic guard 清理（独立模块，详见 core/group-chat-cli-ready-detector.js）
  try { cliReadyDetector.cleanup(sessionId); } catch {}
  // 渲染层要靠 requested 分辨“用户删/重启/迁移”和“CLI 自己崩了”；
  // 后者不该把会话连同输入框一起抹掉，而要留一张断开卡片 + 重连入口。
  sendToRenderer('session-closed', {
    sessionId,
    exitInfo: exitInfo || null,
    requested: isWorkspaceMigration || !!(exitInfo && exitInfo.requested),
  });
  if (meetingId && !isWorkspaceMigration) {
    const updated = meetingManager.removeSubSession(meetingId, sessionId);
    if (updated) sendToRenderer('meeting-updated', { meeting: updated });
  }
};

sessionManager.onSessionSuspended = (sessionId, meetingId, session, exitInfo) => {
  completionNotifier.noteSessionClosed({ sessionId });
  terminalOutputBatcher.flush(sessionId);
  meetingTerminalActivitySentAt.delete(sessionId);
  groupChatDispatcher?.markProcessExitForSession(sessionId, { ...(exitInfo || {}), suspended: true });
  sessionManager.emit('session-exited', {
    sessionId,
    meetingId,
    exitInfo: { ...(exitInfo || {}), suspended: true },
  });
  try { transcriptTap.unregisterSession(sessionId); } catch {}
  try { cliReadyDetector.cleanup(sessionId); } catch {}
  // Keep meeting membership and persisted metadata intact. The renderer turns
  // the existing card into a dormant entry that the normal resume path wakes.
  sendToRenderer('session-suspended', { sessionId, session });
};

// Register a freshly-spawned session with the transcript tap so the appropriate
// backend starts watching its CLI-native transcript file. DeepSeek normally
// routes to Codex; transcriptKind keeps pre-migration Claude sessions resumable.
function registerSessionForTap(session) {
  sessionUsageService.bind(session);
  if (['codex-app-server','acp','claude-stream-json'].includes(session?.runtimeBackend)) return;
  if (!session || !session.id) return;
  try {
    transcriptTap.registerSession(session.id, session.transcriptKind || session.kind, {
      cwd: session.cwd,
      transcriptPath: session.transcriptPath || undefined,
      sessionsRoot: session.codexSessionsRoot || undefined,
      codexSid: session.codexSid || undefined,
      kimiSid: session.kimiSid || undefined,
      sessionDir: session.kimiSessionDir || undefined,
      registeredAt: session.createdAt || Date.now(),
      allowMtimeFallback: !!session.codexAllowMtimeFallback,
      requirePromptMatch: !!session.meetingId,
    });
    if (session.meetingId && groupChatDispatcher && typeof groupChatDispatcher.recoverSession === 'function') {
      const timer = setTimeout(() => {
        groupChatDispatcher.recoverSession(session.id).catch((error) => {
          console.warn('[groupchat] resumed-session recovery failed:', error && error.message);
        });
      }, 1200);
      timer.unref?.();
    }
  }
  catch (e) {
    // silent-failure-hunter L2（2026-05-04 maintainer）：注册失败 → watcher 收不到 turn-complete L1
    //   信号 → 群聊等到 180s 软提醒才感知该家"卡住"。日志方便定位根因。
    console.warn('[tap] registerSession failed for', session.id.slice(0, 8), session.kind, ':', e && e.message);
  }
}

const { isPtyCodexSession, createCodexPtyHookHandler } = require('./main/codex-pty-hook.js');
// 函数声明会提升；handler 在第一次 hook 到达时才创建，届时依赖都已就绪。
let _codexPtyHookHandler = null;
function handleCodexPtyHook(session, event, parsed) {
  if (!_codexPtyHookHandler) {
    _codexPtyHookHandler = createCodexPtyHookHandler({
      sessionManager, transcriptTap, sendToRenderer, maybeAutoTitleSessionFromPrompt, readCodexRolloutMeta,
      isCodexTopLevelRolloutMeta: require('./core/codex-transcript-parser.js').isCodexTopLevelRolloutMeta,
    });
  }
  return _codexPtyHookHandler(session, event, parsed);
}

function updateSessionTranscriptBinding(hubSessionId, fields = {}) {
  if (!hubSessionId) return null;
  const next = {};
  if (fields.ccSessionId) next.ccSessionId = fields.ccSessionId;
  if (fields.transcriptPath) next.transcriptPath = fields.transcriptPath;
  if (Object.keys(next).length === 0) return null;
  const current = sessionManager.getSession(hubSessionId);
  if (!current) return null;
  // 子进程劫持防护：在会话里再跑一个 `claude`（跑测试、批处理、脚本探针）时，
  // 子进程会继承 CLAUDE_HUB_SESSION_ID，它的 Stop hook 会把本卡片重绑到子进程的
  // transcript 上；子进程目录一旦被清理，卡片视图就 ENOENT 打不开。
  // hook 上报的 cwd 与会话 cwd 不一致时一律不重绑（卡片仍可用 ccSessionId 回退查找）。
  if (fields.cwd && current.cwd && normalizeWorkspaceKey(fields.cwd) !== normalizeWorkspaceKey(current.cwd)) {
    console.warn('[hook] ignored transcript rebind from a nested CLI:',
      `session=${String(hubSessionId).slice(0, 8)} reported=${fields.cwd} expected=${current.cwd}`);
    return null;
  }
  const changed = Object.keys(next).some(k => current[k] !== next[k]);
  if (!changed) return current;
  const updated = sessionManager.updateSessionMeta(hubSessionId, next);
  if (updated) {
    sendToRenderer('session-updated', { session: updated });
    sendToRenderer('session-meta-updated', { hubSessionId, ...next });
  }
  return updated || null;
}

const { addMeetingSubInternal } = registerMeetingCreateIpc(ipcMain, {
  ensureLaunchAuth:(kind,opts)=>launchAuth.ensure(kind,opts),
  fs,
  getOrchestrationService: () => global.__orchestrationService || null,
  getHookPort: () => hookPort,
  getHubDataDir,
  getMeetingWorkspaceDir,
  getSlotPromptName,
  groupchat,
  hookToken: HOOK_TOKEN,
  isClaudeFamily,
  isCodexBaseKind,
  isCodexSubagentRolloutPath,
  isIsolatedHub,
  kindLabels: KIND_LABELS,
  meetingManager,
  path,
  registerSessionForTap,
  scenes,
  sendToRenderer,
  sessionManager,
  slotIds: SLOT_IDS,
  workspaceService,
});

// 群聊分支（加入已有会话 / 从会话建群 / 整群分支）。必须排在 registerMeetingCreateIpc
// 之后：它复用那里的 addMeetingSubInternal，成员的 MCP 注入、槽位登记都长在那个函数里。
require('./main/ipc/groupchat-fork-handlers.js').registerGroupChatForkIpc(ipcMain, {
  addMeetingSubInternal,
  getHubDataDir,
  getImmersiveByMeeting: () => _immersiveByMeeting,
  getLastPersistedSessions: () => lastPersistedSessions,
  getPersistedSessions: () => lastPersistedSessions,
  groupchat,
  meetingManager,
  sendToRenderer,
  sessionManager,
  sessionStore,
  stateStore,
});

registerMeetingIpc(ipcMain, {
  deleteImmersiveByMeeting: (meetingId) => { delete _immersiveByMeeting[meetingId]; },
  getHubDataDir,
  getImmersiveByMeeting: () => _immersiveByMeeting,
  getLastPersistedSessions: () => lastPersistedSessions,
  getHubConfig,
  groupchat,
  meetingManager,
  scenes,
  sendToRenderer,
  sessionManager,
  sessionStore,
  slotIds: SLOT_IDS,
  stateStore,
});

// =====================================================================
// Group Chat Mode dispatch
// =====================================================================
groupChatDispatcher = createGroupChatDispatcher({
  recoverLaunchAuth:(session,failure)=>launchAuth.recover(session.kind,{...session,model:session.currentModel?.id},failure),
  cliReadyDetector,
  getHubDataDir,
  groupchat,
  isCodexBaseKind,
  kindLabels: KIND_LABELS,
  maybeAutoTitleMeetingFromPrompt,
  meetingManager,
  onGroupChatComplete: (event) => completionNotifier.handleGroupChatComplete(
    event,
    meetingManager.getMeeting(event && event.meetingId),
  ),
  sendToRenderer,
  sessionManager,
  transcriptTap,
});

registerGroupchatTurnIpc(ipcMain, {
  dispatchGroupChatTurn: (meetingId, args) => global.__devFileEngine
    ? global.__devFileEngine.userTurn(meetingId, args)
    : groupChatDispatcher.dispatchGroupChatTurn(meetingId, args),
  interruptGroupChatTurn: (meetingId, options) => groupChatDispatcher.interruptMeetingTurn(meetingId, {
    ...options, targetSids: global.__devFileEngine?.interruptSids(meetingId) || [],
  }),
  stopLoop: (meetingId, options) => global.__deliveryEngine?.stop(meetingId) || global.__devFileEngine?.stop(meetingId)
    || (global.__loopEngine ? global.__loopEngine.stopLoop(meetingId, options) : false),
});

// Phase 2b：main 进程循环引擎（崩溃续跑 + 成员 wake），复用 dispatcher。try 包裹，绝不影响启动。
// 仅测试启用的钩子（任务书 I 层）：隔离数据目录 + 显式 env 两个条件同时成立才加载，
// 否则一律是 null，生产走的还是真 dispatcher 和真 sessionManager。见模块头注释。
let __testHooks = null;
try {
  __testHooks = require('./main/groupchat/test-dispatch-stub.js').loadTestHooks({
    isIsolatedHub: require('./core/data-dir.js').isIsolatedHub,
    getHubDataDir, meetingManager, logger: console,
  });
  if (__testHooks) __testHooks.registerIpc(ipcMain);
} catch (e) { console.warn('[test-hooks] 加载失败（忽略）:', e && e.message); }

try {
  global.__loopEngine = require('./main/groupchat/loop-engine.js').createLoopEngine({
    getDispatcher: () => (__testHooks ? __testHooks.dispatcher : groupChatDispatcher),
    ...(__testHooks && __testHooks.stepTextWait ? { stepTextWait: __testHooks.stepTextWait } : {}),
    getOrchestrator: (meetingId) => groupchat.getOrchestrator(getHubDataDir(), meetingId),
    // 阶段交接文档落在 <Hub 数据目录>/task-docs/<meetingId>/；显式注入，隔离实例才隔得开。
    getHubDataDir,
    meetingManager,
    sessionManager: __testHooks ? __testHooks.wrapSessionManager(sessionManager) : sessionManager,
    sendToRenderer,
    // resumeSession is initialized later in this module; the closure is only
    // invoked after startup, when the provider-native resume handler exists.
    resumeSession: (meta) => resumeSession(meta),
    loadSessionMeta: (sid) => stateStore.isMarkedRemovedSession(sid) ? null : sessionStore.loadSessionFile(sid),
    // 循环报告写到产物根（AI_HUB_ARTIFACTS_ROOT，默认 ~/AI-Artifacts），不再落桌面。
    writeReport: (html) => require('./core/loop-report-file.js').writeLoopReport(html),
    logger: console,
  });
  require('./main/ipc/loop-handlers.js').registerLoopIpc(ipcMain, { loopEngine: global.__loopEngine, deliveryEngine:()=>global.__deliveryEngine });
} catch (e) { console.warn('[loop] engine init failed:', e && e.message); }

try {
  global.__deliveryEngine = require('./main/groupchat/delivery-engine').createDeliveryEngine({
    meetingManager, sessionManager, getHubDataDir,
    getDispatcher: () => (__testHooks ? __testHooks.dispatcher : groupChatDispatcher),
    ensureMemberReady: (meeting, memberId) => global.__loopEngine.ensureMemberReady(meeting, memberId),
    getMembers: meeting => groupChatDispatcher.groupMembersForMeeting(meeting, { includeDormant: true }),
    getAttemptEvidence: (id,attemptId,expected) => {
      const orch=groupchat.getOrchestrator(getHubDataDir(),id);
      const matches=attemptId ? [orch.getAttempt(attemptId)].filter(Boolean) : Object.values(orch.state.attempts || {}).filter(a=>
        a.memberId===expected.memberId && a.workflowRun?.runId===expected.runId && a.workflowRun?.stepIndex===expected.stepIndex && a.workflowRun?.attempt===expected.attempt);
      if(matches.length!==1)return null;
      const attempt=matches[0];return {attempt,sourceCompletedAt:orch.state.devChatHistory?.receipts?.[attempt.attemptId]?.sourceCompletedAt};
    },
    sendToRenderer,
    onStatus: id => global.__orchestrationService?.onDeliveryStatus(id),
  });
  global.__deliveryEngine.registerIpc(ipcMain);
  global.__deliveryEngine.startWatching();
} catch (error) { console.error('[delivery] initialization failed:', error); }

try {
  global.__devFileEngine = require('./main/groupchat/dev-file-engine').createDevFileEngine({
    meetingManager, sessionManager, getHubDataDir, getDispatcher: () => (__testHooks ? __testHooks.dispatcher : groupChatDispatcher),
    isWorkflowRunning: id => !!global.__loopEngine?.isRunning(id), deliveryEngine: global.__deliveryEngine,
    getMembers: meeting => groupChatDispatcher.groupMembersForMeeting(meeting, { includeDormant: true }),
    ensureMemberReady: (meeting, memberId) => global.__loopEngine.ensureMemberReady(meeting, memberId),
    sendToRenderer, onChanged: (id) => devWorkbench?.changed?.(id), logger: console,
  });
  global.__devFileEngine.registerIpc(ipcMain, require('electron').shell);
} catch (error) { console.error('[dev-file] initialization failed:', error); }

try {
  devWorkbench = require('./main/groupchat/dev-workbench.js').createDevWorkbench({
    meetingManager, sessionManager, loopEngine: global.__loopEngine, fileEngine: global.__devFileEngine, deliveryEngine: global.__deliveryEngine, getHubDataDir, sendToRenderer, logger: console,
  });
  devWorkbench.registerIpc(ipcMain);
} catch (error) { console.error('[dev-workbench] initialization failed:', error.message); }

const devChatHistory = require('./core/dev-chat-history').createHistoryService({
  getOrchestrator: id => groupchat.getOrchestrator(getHubDataDir(),id),
  onChanged: (meetingId,orch) => sendToRenderer('dev-workbench:progress',{meetingId,revision:orch.state.revision}),
});
function watchDevChatHistory(session, sourcePath) {
  if (['codex-app-server','acp','claude-stream-json'].includes(session?.runtimeBackend)) return;
  const meeting=session?.meetingId && meetingManager.getMeeting(session.meetingId);
  if(!require('./core/dev-file-workflow').enabled(meeting) && !require('./core/delivery-workflow').enabled(meeting))return;
  const orch=groupchat.getOrchestrator(getHubDataDir(),meeting.id);
  const paths=new Set([sourcePath || session.transcriptPath || transcriptTap.getCodexRolloutPath(session.id),
    ...Object.values(orch.state.devChatHistory?.receipts || {})
      .filter(r=>r.sid===session.id && r.sourcePath && !r.sourceCompletedAt).map(r=>r.sourcePath)]);
  for(const file of paths) {
    void devChatHistory.watch({sid:session.id,meetingId:meeting.id,kind:session.transcriptKind || session.kind,
      sourcePath:file,speaker:session.title || session.kind})
      .catch(error=>console.error('[dev-chat-history] watch failed:',error));
  }
}
transcriptTap.on('session-bound',event=>watchDevChatHistory(sessionManager.getSession(event.hubSessionId),event.transcriptPath || event.rolloutPath));
const collectGroupConversation=require('./core/group-conversation-history').createGroupConversationCollector();
const nativeGroupContent = createContentUpdateBatcher();
function collectNativeGroupItemsNow(event) {
  const sid = event.sessionId || event.id;
  const session = sessionManager.getSession(sid);
  if (isSessionViewer(session)) return;
  const meeting = session?.meetingId && meetingManager.getMeeting(session.meetingId);
  if (!meeting?.groupChat) return;
  const native = sessionManager.getNativeSession?.(sid) || sessionManager.getNativeCodex?.(sid);
  const claude = sessionManager.getNativeClaude?.(sid);
  if (!native && !claude) return;
  try {
    const orch = groupchat.getOrchestrator(getHubDataDir(), meeting.id);
    if (collectGroupConversation({ native, claude, event, orch, sid })) sendToRenderer('groupchat-history-updated',
      { meetingId: meeting.id, sid, revision: orch.state.revision });
  } catch (error) { console.error('[conversation-history] native item persistence failed:', error); }
}
function collectNativeGroupItems(event) {
  const sid=event.sessionId || event.id;
  const session=sessionManager.getSession(sid);
  if(!session?.meetingId || isSessionViewer(session))return;
  const runtime=session.nativeRuntime;
  if(event.type || ['completed','failed','interrupted','idle'].includes(runtime?.state)) {
    nativeGroupContent.flush(sid);
    collectNativeGroupItemsNow(event);
  } else nativeGroupContent.schedule(sid,event.userMessageId || event.clientSubmissionId || '',()=>collectNativeGroupItemsNow(event));
}
sessionManager.on('codex-content-updated', collectNativeGroupItems);
sessionManager.on('codex-session-updated', collectNativeGroupItems);
sessionManager.on('native-agent-item', collectNativeGroupItems);
sessionManager.on('native-agent-lifecycle', collectNativeGroupItems);
const devChatHistoryTimer=setInterval(()=>{
  for(const {info:session} of sessionManager.sessions.values()) {
    if (!session.meetingId) continue;
    if (isSessionViewer(session)) continue;
    const native=(sessionManager.getNativeSession?.(session.id) || sessionManager.getNativeCodex?.(session.id));
    const meeting=session.meetingId && meetingManager.getMeeting(session.meetingId);
    if(native && meeting?.groupChat) {
      try {
        const orch=groupchat.getOrchestrator(getHubDataDir(),meeting.id);
        if(collectGroupConversation({native,orch,sid:session.id}))sendToRenderer('groupchat-history-updated',
          {meetingId:meeting.id,sid:session.id,revision:orch.state.revision});
      } catch(error) { console.error('[conversation-history] native item persistence failed:',error); }
    } else watchDevChatHistory(session);
  }
},5000);
devChatHistoryTimer.unref?.();

transcriptTap.on('progress-update', event => {
  try {
    const session = event && sessionManager.getSession(event.hubSessionId);
    const meeting = session && session.meetingId && meetingManager.getMeeting(session.meetingId);
    if (!meeting || !meeting.groupChat || meeting.scene !== 'dev') return;
    if (require('./core/dev-file-workflow').enabled(meeting)) return; // collected losslessly by source identity
    const orch = groupchat.getOrchestrator(getHubDataDir(), meeting.id);
    if (orch.recordProgressUpdate(session.id, event.text, event.at, session.title || session.kind, event)) {
      sendToRenderer('dev-workbench:progress', { meetingId: meeting.id, revision: orch.state.revision,
        runId: orch.state.activeRun?.runId, turnNum: orch.state.currentTurn });
    }
  } catch (error) { console.warn('[dev-workbench] progress message could not be saved:', error.message); }
});

sessionAutoSuspendScheduler = createSessionAutoSuspendScheduler({
  sessionManager,
  getProtectedSessionIds: () => collectProtectedSessionIds({
    agentLeagueBridge,
    groupChatDispatcher,
    loopEngine: global.__loopEngine,
    meetingManager,
    studyBridge,
  }),
  logger: console,
});

// 自动休眠预演。参数与后台巡检完全一致（复用 scheduler 内部的 sweepOptions），
// 所以「预演说会休眠」和「实际会休眠」不会漂移。
registerAutoSuspendIpc(ipcMain, {
  getScheduler: () => sessionAutoSuspendScheduler,
  logger: console,
});

const xresearchBridge = null;

// Group chat cards come from members' Markdown answer files (2026-09-30).
const answerFileMonitor = require('./main/groupchat/answer-file-monitor').createAnswerFileMonitor({
  getHubDataDir, meetingManager, sendToRenderer, logger: console,
  onChanged: (id, orch) => global.__orchestrationService?.onAnswersChanged(id, orch),
  getOrchestrator: id => groupchat.getOrchestrator(getHubDataDir(), id),
});
answerFileMonitor.start();

registerGroupchatQueryIpc(ipcMain, {
  getHubDataDir,
  groupchat,
  transcriptTap,
  reconcileAnswers: id => answerFileMonitor.reconcile(id),
});

registerGroupchatRecoveryIpc(ipcMain, {
  dispatchGroupChatTurn: groupChatDispatcher.dispatchGroupChatTurn,
  getHubDataDir,
  getActiveWatchers: groupChatDispatcher.getActiveWatchers,
  groupchat,
  groupChatWatcher: groupChatDispatcher.getGroupChatWatcher(),
  isWorkflowRunning: (meetingId) => !!(global.__loopEngine && global.__loopEngine.isRunning(meetingId)),
  meetingManager,
  sendToRenderer,
  sessionManager,
  transcriptTap,
});
registerGroupchatSupplementIpc(ipcMain, {
  getActiveWatchers: groupChatDispatcher.getActiveWatchers,
  getHubDataDir,
  groupchat,
  groupChatWatcher: groupChatDispatcher.getGroupChatWatcher(),
  meetingManager,
  sendToRenderer,
  sessionManager,
  transcriptTap,
});
registerCliStatusIpc(ipcMain, {
  cliReadyDetector,
  sessionManager,
});

registerPromptInspectIpc(ipcMain, {
  sessionManager,
});

registerTranscriptIpc(ipcMain, {
  defaultCodexSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  findCodexRolloutByCwd,
  findCodexRolloutBySid,
  findTranscriptByCCSessionId,
  // 分支会话补分支前历史时要找祖先；祖先常常已经休眠，只剩落盘记录。
  getPersistedSessions: () => lastPersistedSessions,
  isCodexCliKind,
  isUsableCodexRolloutPath,
  parseClaudeTranscriptToTurns,
  parseClaudeTranscriptToNativeTurns: require('./core/claude-disk-transcript.js').parseClaudeTranscriptToNativeTurns,
  parseCodexRolloutToTurns,
  sessionManager,
  transcriptTap,
  transcriptParserService,
  updateSessionTranscriptBinding,
});

// build-injection IPC 历史用于 blackboard 用户输入合成注入子会话(meeting-blackboard.js)。
// Module C 后 blackboard 已删除,该 handler 不再被任何前端代码调用,清理。

const resumeSession = createResumeSessionHandler({
  ensureLaunchAuth:(kind,opts)=>launchAuth.ensure(kind,opts),
  async prepareAssistantResume(meta) {
    if (!assistantService) throw new Error('助理服务尚未就绪');
    assistantService.requireAssistantResume(meta);
    await assistantService.connectBridge();
    return assistantService.getLaunchOptions(meta.kind, meta.hubId);
  },
  prepareOrchestratorResume: meta => {
    if (!global.__orchestrationService) throw new Error('AI 编排服务尚未就绪，编排员暂不能恢复');
    return global.__orchestrationService.resumeOptions(meta);
  },
  defaultCodexSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  findCodexRolloutBySid,
  findTranscriptByCCSessionId,
  fs,
  getHookPort: () => hookPort,
  getHubDataDir,
  hookToken: HOOK_TOKEN,
  isClaudeFamily,
  isCodexBaseKind,
  isCodexSubagentRolloutPath,
  meetingManager,
  os,
  path,
  readCodexRolloutMeta,
  readTranscriptTail: (kind, sourcePath, n) => readTranscriptTail(kind, sourcePath, n, {
    parserService: transcriptParserService,
  }),
  registerSessionForTap,
  resolveCodexSessionsRoot: (meta = {}) => {
    // Meeting Codex deliberately shares the ordinary ~/.codex history. A
    // standalone resume follows its persisted subscription profile instead of
    // accidentally looking only in the currently selected account.
    if (meta.meetingId) return DEFAULT_CODEX_SESSIONS_ROOT;
    const config = getHubConfig();
    return resolveCodexUsageScope({
      ...config,
      ...(meta.codexProfile ? { codexSubscriptionProfile: meta.codexProfile } : {}),
    }, {
      hubDataDir: getHubDataDir(),
      homeDir: os.homedir(),
    }).sessionsRoot;
  },
  scenes,
  sendToRenderer,
  sessionManager,
  slotIds: SLOT_IDS,
});

const sessionOperations = registerSessionIpc(ipcMain, {
  ensureLaunchAuth:(kind,opts)=>launchAuth.ensure(kind,opts),
  getPersistedSessions: () => lastPersistedSessions,
  getTerminalOutputBatchStats: () => terminalOutputBatcher.snapshotStats(),
  meetingManager,
  registerSessionForTap,
  resumeSession,
  sendToRenderer,
  sessionManager,
  workspaceService,
});

// 普通会话输入框的闭环发送。必须排在 registerSessionIpc 之后：它复用
//   group-chat-watcher 的 sendToPty，而那份 _deps 由群聊 dispatcher 的 init 注入。
let assistantService = null;
let phoneService = null;
const promptOperations = registerPromptSubmitIpc(ipcMain, {
  sessionManager, transcriptTap, sendToRenderer,
  onPromptReceipt: receipt => { assistantService?.observePromptReceipt?.(receipt); phoneService?.observeReceipt(receipt); },
  preparePrompt(request, session) {
    if (session?.purpose !== 'hub-assistant') return request;
    if (!assistantService) throw new Error('助理服务尚未就绪，消息未发送');
    if (session.id !== request.sessionId || !assistantService.isAssistantSession(session.id)) throw new Error('请求不是固定助理会话，消息未发送');
    return assistantService.preparePrompt(request);
  },
});
try {
  assistantService = require('./main/ipc/assistant-handlers').registerAssistantIpc(ipcMain, {
    dataDir: getHubDataDir(),
    historyDatabasePath: (() => {
      const file = process.env.CLAUDE_HUB_ASSISTANT_HISTORY_DB;
      if (!file || process.env.CLAUDE_HUB_E2E !== '1') return undefined;
      const base = path.resolve(getHubDataDir()), target = path.resolve(file);
      if (!process.env.CLAUDE_HUB_DATA_DIR || base === path.resolve(require('node:os').homedir(), '.ai-hub-community')) throw new Error('助理验收必须使用独立数据目录');
      const relative = path.relative(base, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('助理验收历史必须位于隔离数据目录内');
      return target;
    })(),
    createSession: (kind, opts) => sessionOperations.createSession({ kind, opts }),
    sendPrompt: (sessionId, text, clientSubmissionId) => promptOperations.submitPrompt(null, { sessionId, text, clientSubmissionId, waitForCliReady: true }),
    // 助理 Tab 输入框的快速回答：与手机共用同一套凭据（Token Plan 优先、百炼按量兜底）。
    fastLane: process.env.HUB_ASSISTANT_FAST_LANE === '0' ? null : new (require('./core/hub-assistant/fast-lane').FastLane)({ credentials: () => require('./core/hub-assistant/fast-lane').fastLaneSources({ dataDir: getHubDataDir(), safeStorage: require('electron').safeStorage }) }),
    hasPendingPrompt:sessionId=>promptOperations.isAssistantSubmissionPending(sessionId),
    isAgentTurnActive:sessionId=>sessionManager.isAgentTurnActive(sessionId),
    getSession: id => sessionManager.getSession(id),
    getAllSessions: () => sessionManager.getAllSessions(),
    readNativeTurns: id => {
      const native=sessionManager.getNativeSession(id);
      if(!native?.readTranscript)return null;
      return {identity:native.threadId,turns:native.readTranscript({limit:80})};
    },
    getSessionMetadata: id => {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return null;
      const live = sessionManager.getSession(id);
      if (live) return live;
      const saved = require('./core/session-store').loadSessionFile(id, { strict: true });
      return saved ? { ...saved, id: saved.hubId || id } : null;
    },
    listKnownSessions: () => lastPersistedSessions.map(meta => ({ ...meta, id: meta.hubId || meta.id })),
    onAssistantNotification: notification => {
      sendToRenderer('assistant:notification', notification); phoneService?.kick?.();
      // 到点提醒在电脑上也弹出通知（用户可能没在看 Hub）。
      // 用 Hub 自绘的桌面通知卡片（项目约定不用 Windows 原生通知）；点击回到助理会话。
      if (notification?.kind === 'reminder') { try { void desktopNotificationController?.show({ sessionId: assistantService?.store?.get('sessionId') || 'hub-assistant', title: 'AI Hub 提醒', body: String(notification.text || ''), kind: 'reminder' }); } catch (error) { console.warn('[assistant] reminder notification', error.message); } }
    },
    onReminderChanged: event => phoneService?.reminder?.(event),
    // 备忘变了：助理页实时刷新，手机通道下一轮把清单发过去。
    onMemosChanged: () => { sendToRenderer('assistant:memos-changed', {}); phoneService?.kick?.(); },
    // 资料口播：Opus 写稿（失败退千问）、微软曉臻合成（失败退千问语音），产物在 Hub 数据目录 assistant/podcasts。
    podcast: (() => { const electron = require('electron'), sc = require('./core/hub-assistant/podcast/script'), voice = require('./core/hub-assistant/podcast/voice'), fl = require('./core/hub-assistant/fast-lane');
      return { extract: file => require('./core/hub-assistant/podcast/extract').extract(file, { electron }),
        writers: [sc.claudeWriter({ cwd: getHubDataDir() }), sc.qwenWriter({ source: () => fl.fastLaneSources({ dataDir: getHubDataDir(), safeStorage: electron.safeStorage }).find(s => s.via === 'token-plan') })],
        synthesize: (text, out) => voice.synthesize(text, out, { credentials: () => require('./core/hub-phone/voice').dashscopeCredentials({ dataDir: getHubDataDir(), safeStorage: electron.safeStorage }) }) }; })(),
    onWorkbenchChanged: () => { sendToRenderer('assistant:workbench-changed', {}); phoneService?.kick?.(); },
    onPodcastsChanged: () => { sendToRenderer('assistant:podcasts-changed', {}); phoneService?.kick?.(); },
    openPath: file => shell.openPath(file),
    getMeetings: () => meetingManager.getAllMeetings(),
    getDefaults: kind => require('./core/session-creation-defaults').creationDefaults(kind, getHubConfig()),
    resumeSession: async (id, _launchOptions, overrides) => {
      const meta = require('./core/session-store').loadSessionFile(id, { strict: true });
      // overrides：助理切换模型时，休眠中的助理直接按新模型恢复，避免先按旧模型启动再重启。
      return meta ? resumeSession({ ...meta, ...(overrides ? { launchOverrides: overrides } : {}), hubId: id }) : null;
    },
    restartSession: (id, overrides) => sessionOperations.restartSession(id, overrides),
    retireSession: async id => {
      const session = sessionManager.getSession(id);
      if (!session) return;
      const title = String(session.title || 'AI Hub 助理').replace(/（已换班）$/, '') + '（已换班）';
      const updated = sessionManager.updateSessionMeta(id, { title });
      if (updated) sessionStore.markDirty(id, updated);
      return sessionManager.closeSessionRecoverably(id, { reason: 'assistant-rotated' });
    },
    onAssistantRotated: event => sendToRenderer('assistant:rotated', event),
    onFrontDeskChanged: frontDesk => { sendToRenderer('assistant:front-desk', frontDesk); phoneService?.kick?.(); },
    onDialogEntry: entry => sendToRenderer('assistant:dialog', entry),
    onAssistantTurnComplete: () => { phoneService?.kick?.(); setTimeout(() => phoneService?.kick?.(), 1200); },
  });
  assistantService.startWatching();
  phoneService = require('./main/ipc/phone-handlers').registerPhoneIpc(ipcMain, assistantService, {dataDir:getHubDataDir(),electron:require('electron')});
} catch (error) { console.error('[assistant] service unavailable:', error.message); }
// AI 编排模式（2026-10-04）：编排员通过 hub_orchestrator 工具驱动群聊与交付工作流。
try {
  global.__orchestrationService = require('./main/orchestration/service').createOrchestrationService({
    meetingManager, sessionManager, getHubDataDir, sendToRenderer, logger: console,
    getDispatcher: () => (__testHooks ? __testHooks.dispatcher : groupChatDispatcher),
    getDeliveryEngine: () => global.__deliveryEngine,
    getMembers: meeting => groupChatDispatcher.groupMembersForMeeting(meeting, { includeDormant: true }),
    addMeetingSubInternal,
    ensureMemberReady: (meeting, memberId) => global.__loopEngine?.ensureMemberReady(meeting, memberId),
    // 编排员处理成员故障：重启该成员的 CLI 会话（接着原会话历史）。
    restartSession: id => sessionOperations.restartSession(id),
    getDefaults: kind => require('./core/session-creation-defaults').creationDefaults(kind, getHubConfig()),
  });
  require('./main/ipc/orchestration-handlers').registerOrchestrationIpc(ipcMain, () => global.__orchestrationService);
  global.__orchestrationService.start().catch(error => console.error('[orchestration] start failed:', error.message));
} catch (error) { console.error('[orchestration] service unavailable:', error.message); }
// 原生 Claude 额度看门狗。同样依赖 sendToPty 的 _deps，所以排在这之后。
claudeQuotaResume.start();
registerClaudeQuotaIpc(ipcMain, claudeQuotaResume);
require('./main/ipc/acp-handlers').registerAcpIpc(ipcMain, {sessionManager});

ipcMain.handle('debug:get-managed-launch-audit', (_event, request = {}) => {
  const sessionId = request && typeof request.sessionId === 'string' ? request.sessionId : null;
  const limit = request && Number.isInteger(Number(request.limit)) ? Number(request.limit) : 100;
  const persisted = inspectManagedLaunchAudit({ sessionId, limit });
  return {
    auditPath: managedLaunchAuditPath(),
    auditHealth: {
      exists: persisted.exists,
      malformedLines: persisted.malformedLines,
      readError: persisted.readError,
    },
    live: sessionManager.getManagedLaunchAudit(sessionId),
    persisted: persisted.records,
  };
});

registerWorkspaceIpc(ipcMain, {
  allowFallbackResume: process.env.HUB_WORKSPACE_E2E_ALLOW_FALLBACK_RESUME === '1',
  dialog,
  getLastPersistedSessions: () => lastPersistedSessions,
  meetingManager,
  sendToRenderer,
  sessionManager,
  shell,
  resumeSession,
  workspaceMigrationSessionIds,
  workspaceService,
});

// --- Dormant session persistence ---
// On boot we read state.json; those entries become dormant (sidebar entries
// with no live PTY). User clicks dormant session → resume-session IPC spawns
// PTY with `claude --resume <ccSessionId>`.
//
// 2026-05-07 maintainer：boot 走 loadAndSelfHeal，扫 sessions/ + meetings/ 目录把孤儿
// 条目（state.json 已丢但 per-id JSON 仍在）合并回来。多 Hub 并发覆盖、
// state.json 损坏、外部清理工具误删这三类灾难都能自我修复。
// Hold the same short transaction as opening a session while boot repairs write.
// Active sessions in other Hubs remain read-only, including title migration.
const bootOwners = sessionManager._openOwners();
const bootState = bootOwners.editSessions([], () => stateStore.loadAndSelfHeal({
  sessionStore, meetingStore,
  canEditSession: session => !bootOwners.owner(session.hubId || session.id),
}));
// loadAndSelfHeal 内部已经把 cleanShutdown 翻成 false（运行中状态），
//   bootWasCleanShutdown 是它额外暴露的"原始盘上值"，告知是否上次优雅退出。
const bootWasClean = !!bootState.bootWasCleanShutdown;
let lastPersistedSessions = Array.isArray(bootState.sessions) ? bootState.sessions : [];
// 2026-07-29 三方审查（Kimi 发现）：healPersistedCwds 自 2026-05 引入以来只被 import、
// 从未调用——药一直在手边没吃。workspace 从 ~/Workspaces 迁到 C:\Workspace 之后，state.json
// 里存的还是旧路径，唤醒这类休眠会话会静默回落 Home（见 session-manager 的 cwdFellBack）。
// transcript 的 jsonl 头里存着 CLI 当时真正用过的 cwd；只有该目录现在仍真实存在时
// 才能用于自愈（归档复制不会改写 jsonl，里面也可能是已经失效的旧 scratch）。
//
// 注意适用范围：它靠 ccSessionId 定位 transcript，所以只覆盖 Claude / DeepSeek。
// Codex 有 rollout 元数据、Kimi 有 session_index 各自对账，回落留痕才是它们的兜底。
// healPersistedCwds 就地改内存对象；修正成功后用完整 boot snapshot 异步落盘，避免用户
// 什么都不操作就退出时修复丢失。不能传历史语义不明的局部 state，这里显式带齐
// meetings / immersiveByMeeting，和正常持久化路径保持同一数据面。
// 只对账「可疑」的那些，不全量扫：实测 920 条会话全量对账要 873 ms，而 Hub 启动链上
// 加一秒同步 IO 是这仓库的头号痛点，不值得。可疑 = ①cwd 已不存在（迁移遗留）
// ②cwd 正好是 Home（回落的落点，最可能是被静默改写的）。实测这两类合计只有个位数。
// healPersistedCwds 是就地改对象，传子集同样会改到 lastPersistedSessions 里的那批引用。
try {
  const homeDir = path.resolve(process.env.USERPROFILE || process.env.HOME || '.').toLowerCase();
  const suspect = lastPersistedSessions.filter(s => {
    if (!s || !s.ccSessionId || !s.cwd) return false;
    if (bootOwners.owner(s.hubId || s.id)) return false;
    if (path.resolve(s.cwd).toLowerCase() === homeDir) return true;
    try { return !fs.statSync(s.cwd).isDirectory(); } catch { return true; }
  });
  const healed = suspect.length ? healPersistedCwds(suspect) : 0;
  if (healed > 0) {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: Array.isArray(bootState.meetings) ? bootState.meetings : [],
      immersiveByMeeting: (bootState.immersiveByMeeting && typeof bootState.immersiveByMeeting === 'object')
        ? bootState.immersiveByMeeting : {},
    });
    console.log(`[群聊] boot cwd 自愈：${suspect.length} 条可疑中修正 ${healed} 条（已排队持久化）`);
  }
} catch (error) {
  console.warn('[群聊] healPersistedCwds failed:', error && error.message);
}
// Card optimization Task 9（2026-05-01）— 沉浸/调试模式 per-meeting 状态（持久化）
//   key = meetingId，value = boolean（true=沉浸，false=调试）。
//   每个 stateStore.save 调用都把这份 dict 一起写回，避免被覆盖。
let _immersiveByMeeting = (bootState.immersiveByMeeting && typeof bootState.immersiveByMeeting === 'object')
  ? bootState.immersiveByMeeting : {};
const bootMeetings = Array.isArray(bootState.meetings) ? bootState.meetings : [];
const repairedMemberships = require('./core/session-meeting-membership.js')
  .restoreMissingMeetingIds(lastPersistedSessions.filter(s => !bootOwners.owner(s.hubId || s.id)), bootMeetings);
if (repairedMemberships.length) {
  console.info(`[sessions] restored ${repairedMemberships.length} missing meeting membership(s)`);
  for (const id of repairedMemberships) {
    try {
      bootOwners.editClosed(id, () => {
        const latest = sessionStore.loadSessionFile(id, { strict: true });
        const repaired = lastPersistedSessions.find(s => s.hubId === id);
        if (latest && repaired) sessionStore.saveSessionFile(id, { ...latest, meetingId: repaired.meetingId });
      });
    } catch (error) {
      if (error.code !== 'SESSION_OCCUPIED') console.warn('[sessions] membership repair failed:', error.message);
    }
  }
}
let lastPersistedMeetings = bootMeetings;
for (const m of bootMeetings) {
  meetingManager.restoreMeeting(m);
}
// 2026-09-28: one workflow engine. Idle legacy rooms move to the delivery
// engine once; rooms with a recent unfinished legacy task stay until it ends.
try { require('./core/delivery-migration').migrateAll({ meetingManager, dataDir: getHubDataDir(), logger: console }); }
catch (error) { console.error('[workflow-migration] failed:', error); }

registerMeetingTimelineIpc(ipcMain, {
  meetingManager,
  sendToRenderer,
});

function buildSessionSearchSnapshot() {
  const sessionsById = new Map();
  for (const session of lastPersistedSessions || []) {
    const id = session && (session.hubId || session.id);
    if (id) sessionsById.set(String(id), { ...session, hubId: String(id), status: 'dormant' });
  }
  for (const session of sessionManager.getAllSessions()) {
    const id = session && (session.hubId || session.id);
    if (id) sessionsById.set(String(id), { ...sessionsById.get(String(id)), ...session, hubId: String(id) });
  }
  return {
    sessions: [...sessionsById.values()],
    meetings: typeof meetingManager.getSearchMetadata === 'function'
      ? meetingManager.getSearchMetadata()
      : [],
  };
}

registerArchiveIpc(ipcMain, {
  searchService: sessionSearchService,
  getSearchSnapshot: buildSessionSearchSnapshot,
});
registerSessionReferenceIpc(ipcMain, {
  searchService: sessionSearchService,
  getSearchSnapshot: buildSessionSearchSnapshot,
  getMeeting: meetingId => meetingManager.getMeeting(meetingId),
});
// Let the renderer and hook server finish their latency-sensitive boot path
// before the worker starts walking transcript directories. Querying search
// earlier still starts the same worker on demand and reports visible progress.
//
// 2026-09-19: five seconds landed squarely on the first prompt of a session —
// the walk covers ~17 GB of provider transcripts, and the user feels it as the
// window stalling just as they start typing. Nothing is lost by waiting: the
// title layer answers from renderer memory throughout, and an explicit search
// still starts the worker immediately.
const sessionSearchPrewarmDelayMs = Math.max(
  250,
  Number(process.env.HUB_SESSION_SEARCH_PREWARM_DELAY_MS) || 30_000,
);
// The first full walk is the one heavy piece of work Hub does on its own
// initiative, so it yields to the user rather than competing with them. A
// prompt just sent means the model is answering and the disk is busy; the walk
// waits for a gap. The wait is capped so a continuously busy Hub still gets its
// index built instead of deferring forever.
let lastPromptSubmittedAt = 0;
const SEARCH_IDLE_GAP_MS = Math.max(0, Number(process.env.HUB_SESSION_SEARCH_IDLE_GAP_MS) || 30_000);
const SEARCH_IDLE_MAX_WAIT_MS = Math.max(
  SEARCH_IDLE_GAP_MS,
  Number(process.env.HUB_SESSION_SEARCH_IDLE_MAX_WAIT_MS) || 5 * 60_000,
);
const delayMs = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
async function waitForSearchIdle() {
  const deadline = Date.now() + SEARCH_IDLE_MAX_WAIT_MS;
  for (;;) {
    const quietFor = Date.now() - lastPromptSubmittedAt;
    if (quietFor >= SEARCH_IDLE_GAP_MS || Date.now() >= deadline) return;
    await delayMs(Math.min(SEARCH_IDLE_GAP_MS - quietFor, 5_000, Math.max(0, deadline - Date.now())));
  }
}
const sessionSearchPrewarmTimer = setTimeout(() => {
  void (async () => {
    await waitForSearchIdle();
    sessionSearchService.startMaintenance(buildSessionSearchSnapshot);
    const lockPath = path.join(getHubDataDir(), 'cache', 'session-search-prewarm.lock');
    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch {}
    const lock = await acquireLockAsync(lockPath, { retries: 0, staleMs: 30 * 60 * 1000 });
    if (!lock) return;
    try {
      await sessionSearchService.prewarm(buildSessionSearchSnapshot());
    } catch (error) {
      console.warn('[session-search] background prewarm failed:', error && error.message);
    } finally {
      await releaseLockAsync(lock, lockPath);
    }
  })().catch(error => {
    console.warn('[session-search] background prewarm lock failed:', error && error.message);
  });
}, sessionSearchPrewarmDelayMs);
sessionSearchPrewarmTimer.unref?.();
// Persistent source watchers cover external CLI saves too. Semantic events
// coalesce into the same background queue; the engine owns the shared writer lease.
for (const event of ['turn-complete', 'prompt-submitted', 'turn-aborted', 'turn-error', 'session-bound']) {
  transcriptTap.on(event, payload => sessionSearchService.queueRefresh(buildSessionSearchSnapshot, payload?.hubSessionId || event));
}
transcriptTap.on('prompt-submitted', () => { lastPromptSubmittedAt = Date.now(); });

// 2026-05-07：loadAndSelfHeal 内部已经写过一次 cleanShutdown=false 的快照，
//   这里不再重复写。原本的"flip flag immediately on boot"语义由 selfHeal 承担。

// 跟踪上一次 persist 的 hubId/meetingId 集合，用于 diff 出"用户主动移除"的条目。
//   stateStore.markRemovedSession 把 id 推到 state-store 的 removed set，
//   merge 时显式删除——不依赖"内存里没有 = 删了"，避免多 Hub 启动期间互相把对方
//   未感知到的条目抹掉。
let _lastPersistedSessionIds = new Set(lastPersistedSessions.map(s => s.hubId).filter(Boolean));
let _lastPersistedMeetingIds = new Set(bootMeetings.map(m => m && m.id).filter(Boolean));

registerPersistenceIpc(ipcMain, {
  sessionManager,
  bootWasClean,
  getLiveSession: id => sessionManager.getSession(id),
  getImmersiveByMeeting: () => _immersiveByMeeting,
  getLastPersistedMeetingIds: () => _lastPersistedMeetingIds,
  getLastPersistedMeetings: () => lastPersistedMeetings,
  getLastPersistedSessionIds: () => _lastPersistedSessionIds,
  getLastPersistedSessions: () => lastPersistedSessions,
  meetingManager,
  meetingStore,
  sessionStore,
  setLastPersistedMeetingIds: (ids) => { _lastPersistedMeetingIds = ids; },
  setLastPersistedMeetings: (meetings) => { lastPersistedMeetings = meetings; },
  setLastPersistedSessionIds: (ids) => { _lastPersistedSessionIds = ids; },
  setLastPersistedSessions: (sessions) => { lastPersistedSessions = sessions; },
  stateStore,
});

registerResumeSessionIpc(ipcMain, { resumeSession });

const hubRestart = require('./main/ipc/hub-restart-handlers').registerHubRestartIpc(ipcMain, {
  app, sessionManager, meetingManager, sessionStore, stateStore, getHubDataDir,
  resumeSession, groupChatDispatcher, sendToRenderer, shutdown:beginGracefulHubShutdown, transcriptTap,
  flushState:clean => stateStore.saveForRestart({version:1,cleanShutdown:clean,
    sessions:lastPersistedSessions,meetings:meetingManager.getAllMeetings(),immersiveByMeeting:_immersiveByMeeting}),
});

const imageDir = path.join(getHubDataDir(), 'images');
registerAppUtilityIpc(ipcMain, {
  clipboard,
  crypto,
  fs,
  getHookPort: () => hookPort,
  getMainWindow: () => mainWindow,
  getNetworkEgressStatus: options => networkEgressMonitor.getStatus(options),
  acknowledgeNetworkEgressChange: () => networkEgressMonitor.acknowledgeForeignChange(),
  imageDir,
  path,
  app,
  vpnTrafficDir: path.join(getHubDataDir(), 'traffic'),
});

// 全机残留回收。多个 Hub 实例共用同一个数据目录，所以任何一个实例打开这张卡片
// 看到的都是「整台电脑」的情况，而不只是自己名下那点进程。
// v1 只读：出清单 + 生成可审阅的预演脚本，Hub 自己不杀任何进程。
registerProcessReclaimIpc(ipcMain, {
  getSessionManager: () => sessionManager,
  getDataDir: () => getHubDataDir(),
  logger: console,
});

// 底部状态条 CPU/内存/硬盘区点开的「释放内存」面板：按会话认领进程，结束残留或休眠空闲会话。
registerMemoryReleaseIpc(ipcMain, {
  app,
  appVersion: app.getVersion(),
  dataDir: getHubDataDir(),
  getSessionManager: () => sessionManager,
  logger: console,
});
registerDesktopOrganizerIpc(ipcMain, { dataDir: getHubDataDir(), shell });
registerDiskReleaseIpc(ipcMain, {
  app,
  dataDir: getHubDataDir(),
});

// 驾驶舱 UI 删了，但这个服务还留着：工作台「最近文件」卡的 Git 变更来自它的 overview。
const workbenchOperationsService = createWorkbenchOperationsService({
  dataDir: getHubDataDir(),
  getConfig: getHubConfig,
});
registerWorkbenchOperationsIpc(ipcMain, {
  service: workbenchOperationsService,
  logger: console,
});

registerPathIpc(ipcMain);
ipcMain.handle('community:setup', () => require('./core/community-setup').inspectSetupAsync({ packaged: app.isPackaged }));

// --- Hook HTTP server ---
// Receives POSTs from ~/.claude/scripts/session-hub-hook.py when Claude Code
// fires lifecycle hooks. Forwards compact observations to the renderer's
// RuntimeTruth reducer; the hook request never blocks on transcript parsing
// except for the final Stop preview fallback.
let hubAccountsService = null;
const hookServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // 社区版的 hook 由 PowerShell 原样转发 CLI 的载荷（scripts/session-hub-hook.ps1），
  // 字段提取在这里做（core/hook-payload.js），之后与 Python 版走同一条处理路径。
  const rawHookEvent = req.method === 'POST' && /^\/api\/hook-raw\/[a-z-]+$/.test(req.url)
    ? req.url.slice('/api/hook-raw/'.length) : null;
  if (rawHookEvent) req.url = '/api/hook/' + rawHookEvent;
  const isHook = req.method === 'POST' && req.url.startsWith('/api/hook/');
  const isStatus = req.method === 'POST' && req.url === '/api/status';
  const isNativeOwnership = req.method === 'POST' && req.url === '/api/native-ownership';
  const isResearchAccount = false;
  // 2026-05-16 maintainer：防卡死 — 外部 HTTP 救援入口，tools/hub-escape.ps1 调
  const isEscapeHome = req.method === 'POST' && req.url === '/api/escape-home';
  const isResearchFetch = false;
  // plan 2026-05-05 阶段 0: 群聊记忆 MCP 回调（loopback）。
  if (!isHook && !isStatus && !isResearchFetch && !isEscapeHome && !isNativeOwnership && !isResearchAccount) {
    res.writeHead(404); res.end('{}'); return;
  }

  // Cap body size at 16KB — statusline payloads are tiny, hooks tinier.
  // Raw hook payloads are untruncated CLI JSON (tool output included), so they
  // get a larger cap and are decoded once, after all chunks arrive.
  if (rawHookEvent && String(req.headers['x-hub-token'] || '') !== HOOK_TOKEN) {
    res.writeHead(403); res.end('{}'); req.resume(); return;
  }
  let body = '';
  const rawChunks = [];
  let rawBytes = 0;
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    if (rawHookEvent) {
      rawBytes += c.length;
      if (rawBytes > 8 * 1024 * 1024) { tooBig = true; return; }
      rawChunks.push(c);
      return;
    }
    if (body.length + c.length > 16384) { tooBig = true; return; }
    body += c;
  });
  req.on('end', async () => {
    if (tooBig) { res.writeHead(413); res.end('{}'); return; }
    let parsed;
    if (rawHookEvent) {
      parsed = require('./core/hook-payload').normalizeHookPayload(rawHookEvent, Buffer.concat(rawChunks), {
        sessionId: String(req.headers['x-hub-session'] || ''),
        token: String(req.headers['x-hub-token'] || ''),
      });
      if (!parsed) { res.writeHead(200); res.end('{}'); return; }
    } else {
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
    }
    if (isNativeOwnership) {
      if (parsed.token !== HOOK_TOKEN) { res.writeHead(403); res.end('{}'); return; }
      // Main owns these identities. A restore must not wake every other
      // renderer or serialize its full session catalogue and prompt drafts.
      const sessions = [...sessionManager.sessions.values()].map(({info:s,pty}) => ({
        id:s.id, kind:s.kind, codexSid:s.codexSid, ccSessionId:s.ccSessionId, runtimeBackend:s.runtimeBackend,
        sharedRuntime:pty?.sharedRuntime===true,
      }));
      res.writeHead(200); res.end(JSON.stringify({ pid:process.pid, sessions })); return;
    }
    // 2026-05-16 maintainer：外部 HTTP 救援 — tools/hub-escape.ps1 调这条路由触发 escapeToHome()
    if (isEscapeHome) {
      if (parsed.token !== HOOK_TOKEN) {
        console.warn('[escape-home] 403 wrong token from', req.socket && req.socket.remoteAddress);
        res.writeHead(403); res.end('{}'); return;
      }
      // 检查 renderer 真的可达 — mainWindow.isDestroyed() 不够，renderer 进程 crash 时
      // webContents.send 会静默 drop。这种场景下回 503 让 ps1 提示"需手动重启 Hub"。
      const rendererReachable = mainWindow && !mainWindow.isDestroyed()
        && mainWindow.webContents && !mainWindow.webContents.isCrashed();
      if (!rendererReachable) {
        console.warn('[escape-home] renderer unreachable (destroyed or crashed) — endpoint returns 503');
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, pid: process.pid, error: 'renderer unreachable' }));
        return;
      }
      console.log('[escape-home] HTTP triggered');
      // 2026-05-17 maintainer：主 webContents 可能已被外部 URL navigate 走（renderer 跑的
      //   是远程网页，preload IPC 失效，sendToRenderer('escape-home') 收不到）。
      //   此时直接 loadFile 拉回 index.html — Hub 主进程没死，session 子进程没丢，
      //   只是 renderer 重新初始化从 state.json 恢复。
      const currentUrl = mainWindow.webContents.getURL();
      const navigatedAway = !currentUrl.startsWith('file:') || !currentUrl.includes('/renderer/index.html');
      if (navigatedAway) {
        console.warn('[escape-home] main webContents has been navigated to', currentUrl, '→ loadFile back to index.html');
        mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, pid: process.pid, recovered: 'loadFile', from: currentUrl }));
        return;
      }
      sendToRenderer('escape-home');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    if (parsed.token !== HOOK_TOKEN) {
      res.writeHead(403); res.end('{}'); return;
    }
    const hookTargetSession = parsed.sessionId ? sessionManager.getSession(parsed.sessionId) : null;
    // Instruction receipts are observability only, never native turn authority.
    if(isHook && req.url==='/api/hook/instructions-loaded') {
      try {
        const accepted=await sessionManager.memoryService?.nativeEvidence.loaded(hookTargetSession,parsed);
        res.writeHead(accepted?200:202,{'Content-Type':'application/json'});res.end(JSON.stringify({accepted:!!accepted}));
      } catch(error) {console.error('[memory] instruction hook failed:',error);res.writeHead(500);res.end('{"error":"instruction-receipt-failed"}');}
      return;
    }
    if (isHook && hookTargetSession && isPtyCodexSession(hookTargetSession)) {
      let outcome;
      try { outcome = await handleCodexPtyHook(hookTargetSession, req.url.slice('/api/hook/'.length), parsed); }
      catch (error) {
        console.error('[codex hook] handling failed:', error);
        res.writeHead(500); res.end('{"error":"codex-hook-failed"}'); return;
      }
      res.writeHead(outcome && outcome.ignored ? 202 : 200); res.end(JSON.stringify(outcome || {})); return;
    }
    if (hookTargetSession && require('./core/codex-native-runtime').isCodexSession(hookTargetSession)) {
      res.writeHead(202); res.end('{"ignored":"codex-native-only"}'); return;
    }
    if (isHook && hookTargetSession?.runtimeBackend === 'claude-stream-json') {
      res.writeHead(202); res.end('{"ignored":"native-protocol-authority"}'); return;
    }
    if (parsed.sessionId && hookTargetSession) {
      if (isHook) {
        const event = req.url.slice('/api/hook/'.length);
        const eventAt = Date.now();
        let boundClaudeSessionId = String(hookTargetSession.ccSessionId || '');
        const incomingClaudeSessionId = String(parsed.claudeSessionId || '');
        let initialCwdMismatch = false;
        let initialTranscriptBucketMismatch = false;
        if (!boundClaudeSessionId && parsed.cwd && hookTargetSession.cwd) {
          try {
            initialCwdMismatch = path.resolve(parsed.cwd).toLowerCase()
              !== path.resolve(hookTargetSession.cwd).toLowerCase();
          } catch {}
        }
        if (!boundClaudeSessionId && parsed.transcriptPath && hookTargetSession.cwd) {
          try {
            initialTranscriptBucketMismatch = path.basename(path.dirname(parsed.transcriptPath)).toLowerCase()
              !== projectSlug(hookTargetSession.cwd).toLowerCase();
          } catch {}
        }
        // 公司 Code Agent 不认 --session-id，Hub 启动时无法预定身份（core/codeagent-config.js）。
        // 待绑定期间（新建、分支、没有记录可恢复的重启），工作目录与记录所在目录都对得上的第一个
        // 顶层 hook 就是这个会话本人：绑定后立刻撤掉待绑定标记，之后与 Claude 一样严格拒收外来 id。
        // 子代理（agentId）和在会话里另起的 CLI（目录不同）不会被当成本人。
        if (hookTargetSession.codeagentIdentityPending === true && isCodeAgentKind(hookTargetSession.kind)
            && !parsed.agentId && incomingClaudeSessionId && hookTargetSession.cwd) {
          let sameCwd = false;
          let sameBucket = !parsed.transcriptPath;
          try { sameCwd = !parsed.cwd || path.resolve(parsed.cwd).toLowerCase() === path.resolve(hookTargetSession.cwd).toLowerCase(); } catch {}
          try {
            if (parsed.transcriptPath) sameBucket = path.basename(path.dirname(parsed.transcriptPath)).toLowerCase()
              === projectSlug(hookTargetSession.cwd).toLowerCase();
          } catch {}
          if (sameCwd && sameBucket) {
            sessionManager.updateSessionMeta(parsed.sessionId, { codeagentIdentityPending: false, ccSessionId: null });
            const bound = updateSessionTranscriptBinding(parsed.sessionId, {
              ccSessionId: incomingClaudeSessionId, transcriptPath: parsed.transcriptPath, cwd: parsed.cwd,
            });
            if (bound && bound.ccSessionId === incomingClaudeSessionId) {
              boundClaudeSessionId = incomingClaudeSessionId;
              console.log(`[codeagent hook] ${parsed.sessionId.slice(0, 8)} bound to CLI identity ${incomingClaudeSessionId.slice(0, 8)} (${event})`);
              if (parsed.transcriptPath) void transcriptTap.watchClaudeTranscript(parsed.sessionId, parsed.transcriptPath, { turnId: null, newTurn: false });
              if (event === 'session-start') { res.writeHead(200); res.end(JSON.stringify({ ok: true, identity: 'bound' })); return; }
            } else {
              sessionManager.updateSessionMeta(parsed.sessionId, { codeagentIdentityPending: true });
            }
          }
        }
        // PTY Claude 的身份生命周期：/clear、/resume、退出后重启都会换 session_id。
        // 只有当前绑定的会话先发出 SessionEnd，随后的新 SessionStart 才允许改绑；
        // 其余不同 id 的事件照旧按嵌套进程/子代理拒收（core/claude-identity-switch.js）。
        // /compact 的提交确认。PreCompact 是周期开始，带 trigger、custom_instructions（/compact 的参数）
        // 和 prompt_id；压缩完成后的 SessionStart(source=compact) 是同一周期（同一 prompt_id）的结束。
        // 谁被确认由 core/claude-local-command-acks 按参数与周期决定（R7）。不转给 renderer。
        const compactSignal = hookTargetSession.agentRuntime === 'pty' && !parsed.agentId
          && (event === 'pre-compact' || (event === 'session-start' && parsed.source === 'compact'))
          && (!boundClaudeSessionId || incomingClaudeSessionId === boundClaudeSessionId);
        if (compactSignal) {
          sessionManager.emit('claude-local-command-ack', {
            sessionId: parsed.sessionId, command: 'compact',
            phase: event === 'pre-compact' ? 'start' : 'end',
            cycleId: parsed.promptId || null,
            args: event === 'pre-compact' && typeof parsed.customInstructions === 'string' ? parsed.customInstructions : null,
            trigger: parsed.trigger || null,
          });
        }
        if (event === 'pre-compact') { res.writeHead(200); res.end('{"ok":true}'); return; }
        if ((event === 'session-start' || event === 'session-end') && hookTargetSession.agentRuntime === 'pty') {
          const verdict = claudeIdentitySwitch.observe(parsed.sessionId, {
            event, boundId: boundClaudeSessionId, incomingId: incomingClaudeSessionId,
            source: parsed.source || null, reason: parsed.reason || null, agentId: parsed.agentId || null,
            promptId: parsed.promptId || null,
          });
          if (verdict.action === 'rebind') {
            const updated = updateSessionTranscriptBinding(parsed.sessionId, {
              ccSessionId: incomingClaudeSessionId, transcriptPath: parsed.transcriptPath, cwd: parsed.cwd,
            });
            if (updated && updated.ccSessionId === incomingClaudeSessionId) {
              console.log(`[claude hook] ${parsed.sessionId.slice(0, 8)} follows CLI identity `
                + `${boundClaudeSessionId.slice(0, 8)} -> ${incomingClaudeSessionId.slice(0, 8)} (${parsed.source})`);
              sessionManager.emit('claude-identity-switched', { sessionId: parsed.sessionId, to: incomingClaudeSessionId,
                source: parsed.source || null, cycleId: verdict.cycleId || null });
              sendToRenderer('claude-identity-switched', {
                sessionId: parsed.sessionId, from: boundClaudeSessionId, to: incomingClaudeSessionId,
                source: parsed.source || null, transcriptPath: parsed.transcriptPath || null, at: eventAt,
              });
            } else {
              verdict.action = 'ignore';
              verdict.why = 'rebind-rejected';
            }
          } else if (verdict.action === 'ignore' && verdict.why !== 'no-identity') {
            console.warn(`[claude hook] ignored ${event} for ${parsed.sessionId.slice(0, 8)}: ${verdict.why}`);
          }
          res.writeHead(200); res.end(JSON.stringify({ ok: true, identity: verdict.action })); return;
        }
        if ((boundClaudeSessionId && incomingClaudeSessionId
              && boundClaudeSessionId !== incomingClaudeSessionId)
            || initialCwdMismatch || initialTranscriptBucketMismatch) {
          // Descendant/parallel Claude processes inherit environment variables.
          // A mismatched native session or first-hook cwd is not evidence for
          // this Hub session, even when it inherited the correct local token.
          console.warn(`[claude hook] ignored foreign ${event} for ${parsed.sessionId.slice(0, 8)}`);
          res.writeHead(202); res.end('{"ignored":"foreign-session"}'); return;
        }
        // Prefer the UserPromptSubmit payload's `prompt` field when present —
        // it's the just-submitted text and doesn't depend on CC having flushed
        // the new transcript entry to disk. For Stop events (no `prompt` in
        // payload) fall back to reading the transcript JSONL tail (async —
        // long transcripts used to block the main-process event loop).
        let latestUserMessage = null;
        // Claude Code 在后台任务结束或 Monitor 出事件时自己注入 <task-notification> 续跑，
        // 也会发 UserPromptSubmit。它不是用户发言：不当预览、不起标题、不算已读。
        const injectedContinuation = event === 'prompt' && isTaskNotificationText(parsed.prompt);
        if (!injectedContinuation && typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
          latestUserMessage = parsed.prompt;
        } else if (event === 'stop' && parsed.transcriptPath) {
          latestUserMessage = await readLastUserMessage(parsed.transcriptPath);
        }
        // Feed the Claude transcript tap so the Hub timeline (research/general)
        // gets the authoritative final assistant turn. Only fire on Stop events
        // — UserPromptSubmit fires before the assistant has responded, so the
        // transcript tail's last-assistant entry would be the previous turn
        // and immediately trigger a stale update.
        const isSubagentContext = !!parsed.agentId;
        if (!isSubagentContext && (parsed.claudeSessionId || parsed.transcriptPath)) {
          updateSessionTranscriptBinding(parsed.sessionId, {
            ccSessionId: parsed.claudeSessionId,
            transcriptPath: parsed.transcriptPath,
            cwd: parsed.cwd,
          });
        }
        // Bind the JSONL tail at prompt/tool time rather than waiting for Stop.
        // Claude's terminal stop_reason can then close the turn independently
        // when the Stop hook is delayed or missing.
        if (!isSubagentContext && event !== 'stop' && parsed.transcriptPath) {
          void transcriptTap.watchClaudeTranscript(parsed.sessionId, parsed.transcriptPath, {
            turnId: parsed.turnId || null,
            newTurn: event === 'prompt',
          });
        }
        if (!isSubagentContext && event === 'stop' && parsed.transcriptPath) {
          void transcriptTap.notifyClaudeStop(parsed.sessionId, parsed.transcriptPath, { turnId: parsed.turnId || null });
        }
        if (!isSubagentContext && event === 'stop-failure') {
          transcriptTap.notifyClaudeError(parsed.sessionId, {
            message: parsed.error || parsed.message || 'Claude StopFailure',
            errorDetails: parsed.errorDetails || null,
            turnId: parsed.turnId || null,
            completedAt: eventAt,
            signalSource: 'stop_failure',
          });
        }
        if (event === 'prompt' && !isSubagentContext) {
          try {
            sessionManager.noteAgentTurnStarted(parsed.sessionId, {
              startedAt: eventAt,
              signalSource: 'claude-user-prompt-submit',
              prompt: latestUserMessage,
              turnId: parsed.turnId || null,
            });
          } catch (error) {
            console.warn('[claude prompt] main-process lifecycle note failed:', error && error.message);
          }
          if (latestUserMessage) {
            maybeAutoTitleSessionFromPrompt({
              hubSessionId: parsed.sessionId,
              text: latestUserMessage,
              submittedAt: eventAt,
              signalSource: 'hook_prompt',
            });
          }
        }
        sendToRenderer('hook-event', {
          event,
          eventAt,
          sessionId: parsed.sessionId,
          claudeSessionId: parsed.claudeSessionId,
          cwd: parsed.cwd,
          latestUserMessage,
          backgroundTasks: Array.isArray(parsed.backgroundTasks) ? parsed.backgroundTasks : [],
          injectedContinuation,
          sessionCrons: Array.isArray(parsed.sessionCrons) ? parsed.sessionCrons : [],
          error: parsed.error || null,
          errorDetails: parsed.errorDetails || null,
          lastAssistantMessage: parsed.lastAssistantMessage || null,
          notificationType: parsed.notificationType || null,
          message: parsed.message || null,
          title: parsed.title || null,
          toolName: parsed.toolName || null,
          toolCallId: parsed.toolCallId || null,
          turnId: parsed.turnId || null,
          toolInput: parsed.toolInput ?? null,
          toolResult: parsed.toolResult ?? null,
          agentId: parsed.agentId || null,
          agentType: parsed.agentType || null,
          taskId: parsed.taskId || null,
          taskSubject: parsed.taskSubject || null,
        });
      } else {
        const filtered = claudeUsageFilter.filter(parsed.usage5h, parsed.usage7d);
        syncSessionRuntimeModel(parsed.sessionId, parsed.model);
        sendToRenderer('status-event', {
          sessionId: parsed.sessionId,
          contextPct: parsed.contextPct,
          contextUsed: parsed.contextUsed,
          contextMax: parsed.contextMax,
          usage5h: filtered.usage5h,
          usage7d: filtered.usage7d,
          model: parsed.model,
          sessionName: parsed.sessionName,
          cwd: parsed.cwd,
          apiMs: parsed.apiMs,
          linesAdded: parsed.linesAdded,
          linesRemoved: parsed.linesRemoved,
        });
        if (filtered.anyAccepted) cacheAccountUsage({ usage5h: filtered.usage5h, usage7d: filtered.usage7d });
      }
    }
    res.writeHead(200); res.end('{}');
  });
});

// Try candidate ports in order; return the first that listens successfully.
// Any bind error on a candidate (EADDRINUSE, EACCES, EPERM, …) falls through
// to the next; only when all candidates fail do we give up.
function listenWithFallback() {
  return new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= HOOK_PORT_CANDIDATES.length) return resolve(null);
      const port = HOOK_PORT_CANDIDATES[idx++];
      hookServer.removeAllListeners('error');
      hookServer.removeAllListeners('listening');
      hookServer.once('error', (e) => {
        console.warn(`[群聊] hook server bind failed on :${port} (${e.code}): ${e.message}`);
        tryNext();
      });
      hookServer.once('listening', () => resolve(port));
      hookServer.listen(port, '127.0.0.1');
    };
    tryNext();
  });
}

// --- Account usage cache ---
// Persist the latest Claude account usage so the sidebar renders immediately on
// restart without waiting for the first statusline callback.
const USAGE_CACHE_FILE = path.join(getHubDataDir(), 'usage-cache.json');
const STATUSLINE_CACHE_FILE = path.join(getHubDataDir(), 'statusline-cache.json');
let _usageCacheMemory = null;
let _usageCacheWriteTimer = null;
let _usageCacheWriteQueue = Promise.resolve();

function scheduleUsageCacheWrite() {
  if (_usageCacheWriteTimer) clearTimeout(_usageCacheWriteTimer);
  _usageCacheWriteTimer = setTimeout(() => {
    _usageCacheWriteTimer = null;
    const snapshot = JSON.parse(JSON.stringify(_usageCacheMemory || {}));
    _usageCacheWriteQueue = _usageCacheWriteQueue.then(async () => {
      const merged = await writeMergedUsageCacheFile(USAGE_CACHE_FILE, snapshot);
      // Keep newer in-process updates that arrived while this write waited on
      // another Hub's lock; the next scheduled write will persist them.
      _usageCacheMemory = mergeUsageCacheSnapshots(merged, _usageCacheMemory || {}, Date.now());
    }).catch(error => console.warn('[usage-cache] async write failed:', error && error.message));
  }, 100);
  _usageCacheWriteTimer.unref?.();
}

function flushUsageCacheSync() {
  if (_usageCacheWriteTimer) {
    clearTimeout(_usageCacheWriteTimer);
    _usageCacheWriteTimer = null;
  }
  if (_usageCacheMemory === null) return;
  _usageCacheMemory = writeMergedUsageCacheFileSync(USAGE_CACHE_FILE, _usageCacheMemory);
}

// See core/usage-filter.js for why this filter exists (rate_limits monotonic
// within a window — stale low-pct snapshots from idle sessions must not
// overwrite the true usage from heavy sessions).
const claudeUsageFilter = createUsageFilter();
try { claudeUsageFilter.seed(loadUsageCache().claude); } catch {}

function cacheAccountUsage(data) {
  try {
    const existing = loadUsageCache();
    const cur = existing.claude || {};
    existing.claude = {
      usage5h: data.usage5h || cur.usage5h || null,
      usage7d: data.usage7d || cur.usage7d || null,
      ts: data.ts || Date.now(),
    };
    if (JSON.stringify(cur) === JSON.stringify(existing.claude)) return;
    _usageCacheMemory = existing;
    scheduleUsageCacheWrite();
  } catch (error) { console.warn('[claude-usage] cache update failed:', error && error.message); }
}

function loadStatuslineCache() {
  try { return JSON.parse(fs.readFileSync(STATUSLINE_CACHE_FILE, 'utf8')); } catch { return {}; }
}

// Native Claude sessions answer the account quota over their own control; the
// status line that used to feed this never runs in that transport. Any live
// connection can answer, so take the first one and fall back to the cache when
// none is connected or the engine will not say.
async function refreshClaudeAccountUsageLive() {
  for (const session of sessionManager.getAllSessions()) {
    if (session.runtimeBackend !== 'claude-stream-json') continue;
    const native = sessionManager.getNativeClaude?.(session.id);
    if (!native || native.closed || native.runtime?.connection !== 'connected') continue;
    let snapshot = null;
    try { snapshot = await native.readAccountUsage(); }
    catch (error) { console.warn('[claude-usage] native read failed:', error && error.message); continue; }
    if (!snapshot) continue;
    const before = loadUsageCache().claude || null;
    const filtered = claudeUsageFilter.filter(snapshot.usage5h, snapshot.usage7d);
    if (filtered.anyAccepted) {
      cacheAccountUsage({ usage5h: filtered.usage5h, usage7d: filtered.usage7d, ts: snapshot.observedAt });
    }
    const data = loadUsageCache().claude || null;
    return { data, changed: didClaudeSnapshotAdvance(before, { ...data, observedAt: snapshot.observedAt }),
      observedAt: snapshot.observedAt, source: 'claude-native' };
  }
  return null;
}

async function refreshClaudeAccountUsage() {
  return claudeAccountRefresh.refresh();
}

let claudeAccountBroadcast = '';
const claudeAccountRefresh = require('./main/usage/claude-usage-refresh').createClaudeUsageRefresh({
  refresh: async () => (await refreshClaudeAccountUsageLive()) || refreshClaudeAccountUsageFromStatuslineCache(),
  getSessions: () => sessionManager.getAllSessions().flatMap(session => {
    if (session.runtimeBackend !== 'claude-stream-json') return [];
    const native = sessionManager.getNativeClaude?.(session.id);
    return native && !native.closed && native.runtime?.connection === 'connected'
      ? [{ id: session.id, ...native.runtime }] : [];
  }),
  getCached: () => loadUsageCache().claude,
  publish: data => {
    const signature = JSON.stringify(data);
    if (signature === claudeAccountBroadcast) return;
    claudeAccountBroadcast = signature;
    sendToRenderer('status-event', { usage5h: data.usage5h, usage7d: data.usage7d,
      observedAt: data.observedAt || data.ts || 0 });
  },
});
app.on('browser-window-focus', () => { void claudeAccountRefresh.tick('focus'); });
app.on('will-quit', () => { claudeAccountRefresh.stop(); });

function refreshClaudeAccountUsageFromStatuslineCache() {
  const before = loadUsageCache().claude || null;
  const snapshot = selectClaudeStatuslineUsage(loadStatuslineCache());
  if (!snapshot) {
    return {
      data: before,
      changed: false,
      observedAt: before && (before.observedAt || before.ts) || 0,
      source: 'statusline-cache',
    };
  }
  const filtered = claudeUsageFilter.filter(snapshot.usage5h, snapshot.usage7d);
  if (filtered.anyAccepted) {
    cacheAccountUsage({
      usage5h: filtered.usage5h,
      usage7d: filtered.usage7d,
      ts: snapshot.ts,
    });
  }
  const data = loadUsageCache().claude || null;
  return {
    data,
    changed: didClaudeSnapshotAdvance(before, { ...data, observedAt: snapshot.ts }),
    observedAt: snapshot.ts,
    source: snapshot.source,
  };
}

function cacheAgentUsage(provider, tokenData, scope = null) {
  try {
    const existing = loadUsageCache();
    const scoped = provider === 'codex' && scope
      ? attachCodexUsageScope(tokenData, scope)
      : tokenData;
    const observedAt = tokenData && (tokenData.observedAt || tokenData._ts) || Date.now();
    const next = { ...scoped, ts: observedAt };
    if (JSON.stringify(existing[provider]) === JSON.stringify(next)) return;
    existing[provider] = next;
    _usageCacheMemory = existing;
    scheduleUsageCacheWrite();
  } catch {}
}

function readUsageCacheDisk() {
  return readUsageCacheFile(USAGE_CACHE_FILE);
}

function loadUsageCache() {
  const disk = readUsageCacheDisk();
  _usageCacheMemory = _usageCacheMemory === null
    ? disk
    : mergeUsageCacheSnapshots(disk, _usageCacheMemory, Date.now());
  return { ..._usageCacheMemory };
}

function currentCodexUsageScope() {
  return resolveCodexUsageScope(getHubConfig(), {
    hubDataDir: getHubDataDir(),
    homeDir: os.homedir(),
  });
}

let _codexLiveUsage = null;

async function refreshCodexAccountUsageLive() {
  const scope = currentCodexUsageScope();
  if (scope.backend !== 'subscription') {
    throw new Error('Codex API 模式没有订阅配额窗口');
  }
  const config = getHubConfig();
  const raw = await readCodexAccountUsage({
    home: scope.home,
    proxy: config.proxy,
    cwd: os.homedir(),
    timeoutMs: 8000,
  });
  const payload = { ...raw, _ts: raw.observedAt };
  if (scope.scopeKey !== currentCodexUsageScope().scopeKey) {
    throw new Error('Codex 账号已切换，请重新刷新');
  }
  _codexLiveUsage = attachCodexUsageScope(payload, scope);
  cacheAgentUsage('codex', payload, scope);
  return _codexLiveUsage;
}

async function refreshKimiAccountUsageLive() {
  const raw = await readKimiAccountUsage({
    home: process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'),
    timeoutMs: 8000,
  });
  const payload = { ...raw, _ts: raw.observedAt };
  cacheAgentUsage('kimi', payload);
  return payload;
}

async function refreshDeepSeekAccountBalanceLive() {
  const raw = await readDeepSeekAccountBalance({
    apiKey: getHubConfig().deepseekApiKey,
    timeoutMs: 8000,
  });
  const payload = { ...raw, _ts: raw.observedAt };
  cacheAgentUsage('deepseek', payload);
  return payload;
}

const tokenPlanUsage = createTokenPlanUsageService({
  configDir: isIsolatedHub() ? path.join(getHubDataDir(), 'bailian') : undefined,
  backgroundIntervalMs: Number(process.env.HUB_TOKEN_PLAN_POLL_MS) || 60_000,
});

async function refreshTokenPlanUsage(force = false) {
  try { return await tokenPlanUsage.refresh(force); }
  finally { sendToRenderer('agent-usage', { tokenPlan: tokenPlanUsage.snapshot() }); }
}

function loadUsageCacheForCurrentConfig() {
  // Source selection checks expiry; display retains the last account-scoped
  // observation with its real age, including across reset/refresh gaps.
  return { ...filterUsageCacheForCodexScope(loadUsageCache(), currentCodexUsageScope()),
    tokenPlan: tokenPlanUsage.snapshot() };
}

try {
  const cachedCodex = loadUsageCacheForCurrentConfig().codex;
  if (cachedCodex && cachedCodex.source === 'app-server') _codexLiveUsage = cachedCodex;
} catch {}

// The Codex accounts not in use right now, for the usage popover (on demand, never polled).
const codexOtherUsage = require('./main/usage/codex-other-profiles-usage.js').createCodexOtherProfilesUsage({
  getConfig: getHubConfig,
  currentScope: currentCodexUsageScope,
  resolveScope: config => resolveCodexUsageScope(config, { hubDataDir: getHubDataDir(), homeDir: os.homedir() }),
  readUsage: opts => readCodexAccountUsage({ ...opts, cwd: os.homedir() }),
  file: path.join(getHubDataDir(), 'codex-other-usage.json'),
});
ipcMain.handle('codex-other-usage', () => codexOtherUsage.list());
ipcMain.handle('refresh-codex-other-usage', (_event, opts = {}) => codexOtherUsage.refresh({ force: opts && opts.force === true }));

registerUsageIpc(ipcMain, {
  clearCodexJsonlCache: () => _codexJsonlCachedByRoot.clear(),
  loadUsageCacheForCurrentConfig,
  refreshClaudeAccountUsage,
  getCodexUsageScopeKey: () => currentCodexUsageScope().scopeKey,
  refreshCodexAccountUsage: () => refreshCodexUsageIfDue(true),
  refreshDeepSeekAccountBalance: refreshDeepSeekAccountBalanceLive,
  refreshTokenPlanUsage: () => refreshTokenPlanUsage(true),
  refreshKimiAccountUsage: refreshKimiAccountUsageLive,
  scanAgentSessions,
});

registerConfigIpc(ipcMain, {
  ensureLaunchAuth:(kind,opts)=>launchAuth.ensure(kind,opts),
  attachCodexUsageScope,
  clearCodexJsonlCache: () => _codexJsonlCachedByRoot.clear(),
  clearSessionManagerConfigCache,
  currentCodexUsageScope,
  getCompletionNotificationHealth: () => completionNotifier.getHealth(),
  meetingManager,
  scanAgentSessions,
  sendToRenderer,
  sessionManager,
  testCompletionNotification: (payload) => completionNotifier.sendTest(payload),
});

const accountCenterHome = process.env.CLAUDE_HUB_HOME_DIR || os.homedir();
const capabilityService = new (require('./core/capability-service').CapabilityService)({ sessionManager, dataDir: getHubDataDir() });
const accountCenter = new (require('./core/account-center').AccountCenter)({
  dataDir: getHubDataDir(), homeDir: accountCenterHome,
  getConfig: () => require('./core/hub-config').getConfig(),
  adapter: require('./core/account-adapters').createAccountAdapters({ dataDir:getHubDataDir(),homeDir:accountCenterHome,
    onLoginComplete:result=>sendToRenderer('launch-auth-status',result) }),
});
const launchAuth = new (require('./core/launch-auth').LaunchAuth)({accounts:accountCenter,
  getConfig:()=>require('./core/codex-global-account').currentConfig(),
  notify:result=>sendToRenderer('launch-auth-status',result)});
sessionManager.on('codex-session-updated',session=>{
  const failure=session.nativeActionError || session.nativeRuntime?.reason || session.cliRuntime?.reason;
  if (failure) void launchAuth.recover(session.kind,{...session,model:session.currentModel?.id},failure);
});
app.on('before-quit',()=>{accountCenter.stopPump();accountCenter.adapter.dispose?.();});
require('./main/ipc/account-center-handlers').registerAccountCenterIpc(ipcMain,accountCenter);
// The account page: one Hub Chrome holds every web login; CLIs report their own token files.
hubAccountsService = new (require('./core/hub-accounts').HubAccounts)({
  getToolCatalog: refresh => capabilityService.catalog(refresh),
  recovery: new (require('./core/web-roundtable/recovery').AccountRecovery)({ dataDir: getHubDataDir() }),
});
require('./main/ipc/hub-accounts-handlers').registerHubAccountsIpc(ipcMain, hubAccountsService);
// About twice a day the logins are confirmed in the background; the sidebar shows how many
// accounts need the person.
hubAccountsService.startAuto({ onAttention: count => sendToRenderer('hub-accounts:attention', count) });
app.on('before-quit', () => hubAccountsService.stopAuto());

require('./main/ipc/voice-input-handlers').registerVoiceInputIpc(ipcMain, {
  app, safeStorage: require('electron').safeStorage,
  // 语音「动态背景」：当前会话聊天记录 md 的末尾（昨日之我的数据源），只给本地识别模型
  getRecentContext: async hubSessionId => {
    if (!hubSessionId || typeof sessionSearchService?.transcriptFor !== 'function') return '';
    const found = await sessionSearchService.transcriptFor({ hubSessionId: String(hubSessionId) });
    return found?.exists ? require('./core/voice-text').recentFromTranscript(found.path) : '';
  },
});
require('./main/ipc/prompt-polish-handlers').registerPromptPolishIpc(ipcMain, { getConfig: getHubConfig });

// --- 梦境系统（Dream Consolidation）+ 记忆面板 ---
// 保留旧 IPC 兼容入口，但不再启动向原生规则写入的旧沉淀调度器。
const { registerMemoryIpc } = require('./main/ipc/memory-handlers.js');
registerMemoryIpc(ipcMain, { workspaceService, logger: console });
// New dreams write independent project memory, never the legacy rule sections.
const { HubMemoryService } = require('./core/hub-memory-service');
const hubMemoryService = new HubMemoryService({
  dataDir:getHubDataDir(), workspaceService, sessionManager, transcriptTap,
  searchService:sessionSearchService, sendToRenderer,
  getPersistedSessions:()=>lastPersistedSessions,
  createSession:async(kind,opts)=>{
    const session=sessionManager.createSession(kind,opts);
    registerSessionForTap(session);sendToRenderer('session-created',{session});return session;
  },
  sendPrompt:(...args)=>require('./core/group-chat-watcher').sendToPty(...args),
});
require('./main/ipc/hub-memory-handlers').registerHubMemoryIpc(ipcMain,hubMemoryService);
require('./main/ipc/capability-handlers').registerCapabilityIpc(ipcMain,
  capabilityService);

// --- Gemini/Codex/Kimi ring-buffer usage scanner ---
// Periodically scans agent sessions' ring buffers for token/model patterns
// and emits status-event so the renderer can show context/usage badges.
const _agentLastStatus = new Map();
const _agentQuota = { gemini: null };
const _codexCliQuotaBySession = new Map();
const CODEX_CLI_USAGE_FRESH_MS = 2 * 60 * 1000;

// --- Codex JSONL-based usage scanner ---
// Codex CLI writes rate-limit snapshots to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// They are a passive fallback; manual refresh uses app-server for the selected profile.
// Each file contains token_count events with primary (5h) and secondary (7d) windows.
let _codexJsonlLastScan = 0;
let _codexJsonlCached = null;
const _codexJsonlCachedByRoot = new Map();
const CODEX_JSONL_THROTTLE_MS = 5_000;
const CODEX_JSONL_CANDIDATE_LIMIT = 20;

async function scanCodexJsonlUsage(sessionsDir = DEFAULT_CODEX_SESSIONS_ROOT, opts = {}) {
  try {
    const result = await codexJsonlUsageService.scan(sessionsDir, {
      minObservedAt: opts.minObservedAt || 0,
      candidateLimit: CODEX_JSONL_CANDIDATE_LIMIT,
    });
    return result.data;
  } catch {
    return null;
  }
}

async function scanCodexJsonlUsageThrottled(sessionsDir = DEFAULT_CODEX_SESSIONS_ROOT, opts = {}) {
  const now = Date.now();
  const key = [
    path.resolve(sessionsDir || DEFAULT_CODEX_SESSIONS_ROOT).toLowerCase(),
    Math.floor(Number(opts.minObservedAt) || 0),
  ].join('|');
  const cached = _codexJsonlCachedByRoot.get(key);
  if (!opts.force && cached && now - cached.ts < CODEX_JSONL_THROTTLE_MS) return cached.data;
  const data = await scanCodexJsonlUsage(sessionsDir, opts);
  _codexJsonlCachedByRoot.set(key, { ts: now, data });
  _codexJsonlLastScan = now;
  _codexJsonlCached = data;
  return data;
}

// Token-based rolling-window tracker for Gemini/Codex (fallback).
const AGENT_LIMITS = {
  gemini: { tokens5h: 2_000_000, tokens7d: 50_000_000 },
  codex:  { tokens5h: 1_000_000, tokens7d: 10_000_000 },
};
const _agentTokenLog = { gemini: [], codex: [] }; // [{ts, tokens}]

function agentUsageScopeKey(sessionsRoot) {
  return path.resolve(sessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT).toLowerCase();
}

function recordAgentTokens(kind, tokens, scopeKey = null) {
  if (!_agentTokenLog[kind]) return;
  _agentTokenLog[kind].push({ ts: Date.now(), tokens, scopeKey });
}

function calcAgentUsage(kind, scopeOrRoot = null) {
  const log = _agentTokenLog[kind];
  if (!log) return null;
  const now = Date.now();
  const H5 = 5 * 3600 * 1000;
  const D7 = 7 * 86400 * 1000;
  // Prune entries older than 7d
  while (log.length && log[0].ts < now - D7) log.shift();
  const scopeKey = scopeOrRoot ? agentUsageScopeKey(scopeOrRoot) : null;
  const scopedLog = scopeKey ? log.filter(e => e.scopeKey === scopeKey) : log;
  const tok5h = scopedLog.filter(e => e.ts >= now - H5).reduce((s, e) => s + e.tokens, 0);
  const tok7d = scopedLog.reduce((s, e) => s + e.tokens, 0);
  const lim = AGENT_LIMITS[kind];
  if (!lim) return null;
  if (tok5h === 0 && tok7d === 0) return null;
  return {
    usage5h: { pct: Math.min(100, Math.round(tok5h / lim.tokens5h * 100)), resetsAt: now + H5 },
    usage7d: { pct: Math.min(100, Math.round(tok7d / lim.tokens7d * 100)), resetsAt: now + D7 },
  };
}

const _agentBufferRevisions = new Map();
let _agentUsageBroadcastSignature = '';
async function scanAgentSessions(opts = {}) {
  const force = !!opts.force;
  const allSessions = sessionManager.getAllSessions();
  const liveIds = new Set(allSessions.map(s => s.id));
  for (const id of _agentBufferRevisions.keys()) if (!liveIds.has(id)) _agentBufferRevisions.delete(id);
  for (const s of allSessions) {
    if (['codex-app-server','acp'].includes(s.runtimeBackend)) continue;
    const runtimeKind = s.transcriptKind || s.kind;
    const isOpenAiCodex = s.kind === 'codex' || s.kind === 'codex-resume';
    if (runtimeKind !== 'gemini' && !isCodexBaseKind(runtimeKind) && !isKimiCliKind(runtimeKind)) continue;
    if (s.status === 'dormant') continue;
    const revision = sessionManager.getSessionOutputRevision?.(s.id);
    const bufferKey = revision == null ? null : `${runtimeKind}:${revision}`;
    if (!force && bufferKey !== null && _agentBufferRevisions.get(s.id) === bufferKey) continue;
    const buf = sessionManager.getSessionBuffer(s.id);
    if (!buf) continue;
    const plain = stripAnsi(buf);
    const parsed = runtimeKind === 'gemini'
      ? parseGeminiUsage(plain)
      : isKimiCliKind(runtimeKind)
        ? parseKimiUsage(plain)
        : parseCodexUsage(plain);
    if (bufferKey !== null) _agentBufferRevisions.set(s.id, bufferKey);
    if (isOpenAiCodex && (parsed.usage5h || parsed.usage7d)) {
      const usageSig = JSON.stringify({ usage5h: parsed.usage5h || null, usage7d: parsed.usage7d || null });
      const usageKey = s.id + ':codex-cli-usage';
      if (_agentLastStatus.get(usageKey) !== usageSig) {
        _agentLastStatus.set(usageKey, usageSig);
        recordCodexCliUsage(
          _codexCliQuotaBySession,
          s,
          parsed,
          Date.now(),
          DEFAULT_CODEX_SESSIONS_ROOT,
        );
      }
    }
    if (parsed.tokensUsed) {
      const prev = _agentLastStatus.get(s.id + ':tok');
      if (prev !== parsed.tokensUsed) {
        const delta = prev ? parsed.tokensUsed - prev : parsed.tokensUsed;
        const scopeKey = isOpenAiCodex
          ? agentUsageScopeKey(s.codexSessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT)
          : null;
        if (delta > 0) recordAgentTokens(isOpenAiCodex ? 'codex' : runtimeKind, delta, scopeKey);
        _agentLastStatus.set(s.id + ':tok', parsed.tokensUsed);
      }
    }
    // Gemini quotaPct → direct sidebar usage (real API quota from CLI footer)
    if (parsed.quotaPct != null) {
      const now = Date.now();
      const H5 = 5 * 3600 * 1000;
      const usageObj = { usage5h: { pct: parsed.quotaPct, resetsAt: now + H5 }, _ts: now };
      _agentQuota.gemini = usageObj;
    }
    if (!parsed.model && !parsed.tokensUsed && parsed.contextPct == null && parsed.quotaPct == null) continue;
    const prev = _agentLastStatus.get(s.id);
    const sig = JSON.stringify(parsed);
    if (prev === sig) continue;
    _agentLastStatus.set(s.id, sig);
    const payload = { sessionId: s.id };
    if (parsed.contextPct != null) payload.contextPct = parsed.contextPct;
    if (parsed.contextUsed != null) payload.contextUsed = parsed.contextUsed;
    if (parsed.contextMax != null) payload.contextMax = parsed.contextMax;
    if (parsed.model) {
      syncSessionRuntimeModel(s.id, parsed.model);
      payload.model = parsed.model;
    }
    sendToRenderer('status-event', payload);
  }
  // Expire stale CLI quota entries (no fresh CLI data for >10 min).
  const now = Date.now();
  if (_agentQuota.gemini && _agentQuota.gemini._ts && now - _agentQuota.gemini._ts > 10 * 60 * 1000) {
    _agentQuota.gemini = null;
  }
  pruneCodexCliUsage(_codexCliQuotaBySession, now, 10 * 60 * 1000);
  // Build and broadcast per-provider usage.
  // Manual app-server reads are authoritative for the selected profile. Newer
  // CLI/JSONL snapshots may supersede them only when the weekly reset boundary
  // proves they belong to the same account/window.
  const agentData = {};
  // Codex: visible `/usage` output is the freshest user-triggered source.
  // Fall back to JSONL token_count snapshots, then local token estimates.
  const codexScope = currentCodexUsageScope();
  const freshCodexCliUsage = selectCodexCliUsageForScope(_codexCliQuotaBySession, codexScope, {
    now,
    maxAgeMs: CODEX_CLI_USAGE_FRESH_MS,
    defaultSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  });
  const cachedCodexCliUsage = selectCodexCliUsageForScope(_codexCliQuotaBySession, codexScope, {
    now,
    maxAgeMs: 10 * 60 * 1000,
    defaultSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  });
  const codexJsonl = freshCodexCliUsage ? null : await scanCodexJsonlUsageThrottled(codexScope.sessionsRoot, {
    force,
    minObservedAt: codexScope.authSinceMs || 0,
  });
  if (freshCodexCliUsage) {
    const payload = { ...freshCodexCliUsage, source: 'cli-usage', observedAt: freshCodexCliUsage._ts, _ts: freshCodexCliUsage._ts };
    agentData.codex = attachCodexUsageScope(payload, codexScope);
    cacheAgentUsage('codex', payload, codexScope);
  } else if (codexJsonl) {
    const payload = { ...codexJsonl, source: 'jsonl', _ts: codexJsonl.observedAt || now };
    agentData.codex = attachCodexUsageScope(payload, codexScope);
    cacheAgentUsage('codex', payload, codexScope);
  } else if (cachedCodexCliUsage) {
    const payload = { ...cachedCodexCliUsage, source: 'cli', observedAt: cachedCodexCliUsage._ts, _ts: cachedCodexCliUsage._ts };
    agentData.codex = attachCodexUsageScope(payload, codexScope);
    cacheAgentUsage('codex', payload, codexScope);
  } else {
    const usage = calcAgentUsage('codex', codexScope.sessionsRoot);
    if (usage) {
      const payload = { ...usage, source: 'estimate', observedAt: now, _ts: now };
      agentData.codex = attachCodexUsageScope(payload, codexScope);
      cacheAgentUsage('codex', payload, codexScope);
    } else {
      agentData.codex = attachCodexUsageScope({ usage5h: null, usage7d: null, unavailable: true }, codexScope);
    }
  }
  const inMemoryLiveForScope = _codexLiveUsage && _codexLiveUsage.scopeKey === codexScope.scopeKey
    ? expireCodexUsageWindows(_codexLiveUsage, now)
    : null;
  const diskForScope = loadUsageCacheForCurrentConfig().codex;
  const cachedLiveForScope = diskForScope && diskForScope.source === 'app-server'
    ? expireCodexUsageWindows(diskForScope, now)
    : null;
  const liveForScope = mergeCodexEntry(cachedLiveForScope, inMemoryLiveForScope, now);
  if (shouldPreferCodexLiveUsage(liveForScope, agentData.codex, now)) {
    agentData.codex = liveForScope;
    cacheAgentUsage('codex', liveForScope, codexScope);
  }
  agentData.codex = mergeCodexEntry(diskForScope, agentData.codex, now);
  // Gemini: quota from CLI footer > token estimates
  if (_agentQuota.gemini) {
    const gemData = { usage5h: _agentQuota.gemini.usage5h };
    const tokenUsage = calcAgentUsage('gemini');
    if (tokenUsage && tokenUsage.usage7d) gemData.usage7d = tokenUsage.usage7d;
    agentData.gemini = gemData;
    cacheAgentUsage('gemini', gemData);
  } else {
    const usage = calcAgentUsage('gemini');
    if (usage) { agentData.gemini = usage; cacheAgentUsage('gemini', usage); }
  }
  const broadcastSignature = JSON.stringify(agentData);
  if (Object.keys(agentData).length > 0 && (force || broadcastSignature !== _agentUsageBroadcastSignature)) {
    _agentUsageBroadcastSignature = broadcastSignature;
    sendToRenderer('agent-usage', agentData);
  }
  return agentData;
}

let _agentScanInterval = null;
let _agentScanInFlight = null;
let _deepseekBalanceRefreshInFlight = null;
let _deepseekBalanceLastAttempt = 0;
let _kimiUsageRefreshInFlight = null;
let _kimiUsageLastAttempt = 0;
let _codexUsageRefreshInFlight = null;
let _codexUsageLastAttempt = 0;
const DEEPSEEK_BALANCE_REFRESH_MS = 5 * 60 * 1000;
const KIMI_USAGE_REFRESH_MS = 5 * 60 * 1000;
const CODEX_USAGE_REFRESH_MS = 5 * 60 * 1000;

function refreshCodexUsageIfDue(force = false) {
  const now = Date.now();
  if (_codexUsageRefreshInFlight) return _codexUsageRefreshInFlight;
  if (!force && now - _codexUsageLastAttempt < CODEX_USAGE_REFRESH_MS) return null;
  _codexUsageLastAttempt = now;
  _codexUsageRefreshInFlight = refreshCodexAccountUsageLive()
    .then((codex) => {
      sendToRenderer('agent-usage', { codex });
      return codex;
    })
    .finally(() => { _codexUsageRefreshInFlight = null; });
  return _codexUsageRefreshInFlight;
}

function refreshDeepSeekBalanceIfDue(force = false) {
  const now = Date.now();
  if (_deepseekBalanceRefreshInFlight) return _deepseekBalanceRefreshInFlight;
  if (!force && now - _deepseekBalanceLastAttempt < DEEPSEEK_BALANCE_REFRESH_MS) return null;
  _deepseekBalanceLastAttempt = now;
  _deepseekBalanceRefreshInFlight = refreshDeepSeekAccountBalanceLive()
    .then((deepseek) => {
      sendToRenderer('agent-usage', { deepseek });
      return deepseek;
    })
    .catch(() => null)
    .finally(() => { _deepseekBalanceRefreshInFlight = null; });
  return _deepseekBalanceRefreshInFlight;
}

function refreshKimiUsageIfDue(force = false) {
  const now = Date.now();
  if (_kimiUsageRefreshInFlight) return _kimiUsageRefreshInFlight;
  if (!force && now - _kimiUsageLastAttempt < KIMI_USAGE_REFRESH_MS) return null;
  _kimiUsageLastAttempt = now;
  _kimiUsageRefreshInFlight = refreshKimiAccountUsageLive()
    .then((kimi) => {
      sendToRenderer('agent-usage', { kimi });
      return kimi;
    })
    .catch(() => null)
    .finally(() => { _kimiUsageRefreshInFlight = null; });
  return _kimiUsageRefreshInFlight;
}

function startAgentScanner() {
  if (_agentScanInterval) return;
  const run = () => {
    if (_agentScanInFlight) return _agentScanInFlight;
    _agentScanInFlight = scanAgentSessions()
      .catch(error => console.warn('[usage-scan] failed:', error && error.message))
      .finally(() => { _agentScanInFlight = null; });
    return _agentScanInFlight;
  };
  void run();
  void claudeAccountRefresh.tick();
  void refreshCodexUsageIfDue(true).catch(() => null);
  refreshDeepSeekBalanceIfDue(true);
  refreshKimiUsageIfDue(true);
  void refreshTokenPlanUsage().catch(() => {});
  _agentScanInterval = setInterval(() => {
    void run();
    void claudeAccountRefresh.tick();
    const codexRefresh = refreshCodexUsageIfDue(false);
    if (codexRefresh) void codexRefresh.catch(() => null);
    refreshDeepSeekBalanceIfDue(false);
    refreshKimiUsageIfDue(false);
    // The service publishes errors in its snapshot and bounds read-only polling.
    void refreshTokenPlanUsage().catch(() => {});
  }, 5000);
}

app.whenReady().then(async () => {
  traceStartup('app.whenReady');
  // Source-mode Electron has no installed exe identity of its own. Keep a
  // branded Start Menu shortcut + Jump List relaunch task bound to the Hub
  // AUMID, or Windows can cache a bare electron.exe relaunch command. Isolated
  // E2E Hubs must never touch this production Shell registration.
  if (process.platform === 'win32' && !isIsolatedHub()) {
    const hubIconPath = path.join(__dirname, 'claude-wx.ico');
    const hubProductVersion = (() => {
      try { return require('./package.json').version || ''; } catch { return ''; }
    })();
    const brandingOptions = {
      execPath: process.execPath,
      icoPath: hubIconPath,
      productVersion: hubProductVersion,
    };

    const startShellIntegration = (execPath) => {
      const windowsShellOptions = {
        app,
        shell,
        appRoot: __dirname,
        execPath,
        isPackaged: HUB_IS_PACKAGED,
        iconPath: hubIconPath,
      };
      const shellResult = ensureWindowsShellIntegration(windowsShellOptions);
      if (shellResult.legacyBackupPath) {
        console.warn(`[windows-shell] retired broken Electron shortcut: ${shellResult.legacyBackupPath}`);
      }
      if (windowsShellWatchdog) windowsShellWatchdog.stop();
      // The canonical shortcut was observed disappearing hours after a successful
      // repair, leaving an otherwise valid .ico rendered as Windows' white-page
      // placeholder. Re-check the tiny Shell Link every 15s and repair drift.
      windowsShellWatchdog = startWindowsShellIntegrationWatchdog({
        ...windowsShellOptions,
        // 每一拍无条件重贴窗口图标：Explorer 重启丢 HICON 时快捷方式是好的，
        // 健康检查不会失败，onRepair 不会触发（详见 reassertHubWindowIcon 注释）。
        onTick: reassertHubWindowIcon,
        onRepair: reassertHubWindowIcon,
      });
      return windowsShellOptions.execPath;
    };

    // 快捷方式先指向当前可用的启动器：品牌化副本在就用它，不在就回落 electron.exe。
    let hubLaunchExePath = startShellIntegration(resolveHubLaunchExePath(brandingOptions));

    // 品牌化副本缺失或过期时后台重建。electron.exe 220MB+，读+改资源+写一整遍
    // 要好几秒，绝不能在主进程同步跑；用 ELECTRON_RUN_AS_NODE 起子进程。
    // 只新增/替换 AIHubCommunity.exe，永不触碰 electron.exe（node_modules 完整性铁律）。
    const brandingState = describeBrandingHealth(brandingOptions);
    if (!brandingState.healthy && brandingState.expected) {
      console.log(`[hub-brand] ${brandingState.message}，后台重建中`);
      const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'brand-hub-exe.js')], {
        cwd: __dirname,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let childLog = '';
      child.stdout.on('data', d => { childLog += d.toString(); });
      child.stderr.on('data', d => { childLog += d.toString(); });
      child.on('error', err => console.warn(`[hub-brand] spawn 失败：${err.message}`));
      child.on('exit', (code) => {
        if (code !== 0) {
          console.warn(`[hub-brand] 重建失败 (exit ${code})，快捷方式继续用 electron.exe\n${childLog.trim()}`);
          return;
        }
        const rebuiltExePath = resolveHubLaunchExePath(brandingOptions);
        if (rebuiltExePath === hubLaunchExePath) return;
        // 重建成功：把快捷方式和 Jump List 重指到品牌化 exe。下次从桌面启动，
        // 窗口类图标就是橙色 logo，Explorer 再怎么重建任务栏都摸不到 Electron 原子。
        hubLaunchExePath = startShellIntegration(rebuiltExePath);
        console.log(`[hub-brand] 已重建并重指快捷方式：${rebuiltExePath}`);
      });
      child.unref();
    }
  }
  const _home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  // Isolated E2E must not mutate or poll production ~/.claude settings. Real
  // Claude integration tests provide their own config explicitly; ordinary
  // renderer/PTY tests need no hook deployment at all.
  // 端到端测试可以在完全伪造的 home 里部署 hook（CLAUDE_HUB_HOME_DIR 必须就是当前 home）。
  const e2eFakeHome = process.env.CLAUDE_HUB_E2E_FAKE_HOME === '1' && !!process.env.CLAUDE_HUB_HOME_DIR
    && path.resolve(process.env.CLAUDE_HUB_HOME_DIR).toLowerCase() === path.resolve(_home).toLowerCase();
  const claudeDirs = isIsolatedHub() && !e2eFakeHome
    ? []
    : ['.claude', '.claude-deepseek'].map(dir => path.join(_home, dir))
      .filter((dir, index) => index === 0 || fs.existsSync(dir));
  const hookSourceScriptsDir = HUB_IS_PACKAGED
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');
  traceStartup('deploy hooks start');
  // 2026-05-05 maintainer：所有 Claude family 隔离配置目录都必须部署 Stop hook，否则
  //   该家族 sub session 完成时 CC 不调 hook → notifyClaudeStop 永不触发 →
  //   ClaudeTap.JsonlTail 永不启动 → stop_reason 主路径 + idle 兜底全失效 →
  //   群聊卡片自动同步死，只能等 5min 硬 timeout 或用户手动点提取。
  //   scripts/session-hub-hook.py 也不存在。与 findTranscriptByCCSessionId 的
  //   candidateRoots 列表对齐，单一真理源应在 ai-kinds.js（后续可重构）。
  for (const claudeDir of claudeDirs) ensureHooksDeployed(claudeDir);
  // 公司 Code Agent（Claude 形态，core/codeagent-config.js）：配置目录已存在才部署，不凭空创建 ~/.cac。
  // 隔离 Hub 只在测试显式指定了它的配置目录时部署，绝不碰真实 home。
  const codeagentHookTargets = [];
  try {
    const codeagentConfig = require('./core/codeagent-config').resolveCodeAgentConfig(process.env);
    const allowed = isIsolatedHub() ? !!process.env.AI_HUB_CODEAGENT_CONFIG_DIR : true;
    if (allowed && fs.existsSync(codeagentConfig.configDir)) {
      const settingsOptions = { events: require('./core/codeagent-config').HOOK_EVENTS,
        manageStatusLine: false, managePermissionMode: false };
      const result = ensureClaudeHookIntegration({ claudeDir: codeagentConfig.configDir,
        sourceScriptsDir: hookSourceScriptsDir, logger: console, settingsOptions });
      if (result.errors.length) console.warn(`[codeagent-hooks] ${codeagentConfig.configDir}: ${result.errors.join('；')}`);
      codeagentHookTargets.push({ dir: codeagentConfig.configDir, settingsOptions });
    }
  } catch (error) { console.warn('[codeagent-hooks] skipped:', error.message); }
  // settings.json can be rewritten by Claude settings/plugin changes while the
  // Hub keeps running. A one-time boot merge is therefore insufficient: the
  // screenshot incident had UserPromptSubmit=[] and no Hub Stop hook five
  // hours after launch. Periodically repair only Hub-owned entries.
  if (claudeDirs.length || codeagentHookTargets.length) {
    claudeHookWatchdog = startClaudeHookIntegrationWatchdog({
      claudeDirs: [...claudeDirs, ...codeagentHookTargets],
      sourceScriptsDir: hookSourceScriptsDir,
      logger: console,
    });
  }
  traceStartup('deploy hooks done');
  // file-scope-guard hook 被中断/硬杀留下的 file-claims.json.tmp.<pid> 孤儿（只收 1 小时前的）。
  try {
    const tmpCleanup = cleanupFileClaimsTmp(getHubDataDir());
    if (tmpCleanup.removed) console.log(`[群聊] 清理 file-claims 临时文件孤儿 ${tmpCleanup.removed} 个`);
    if (tmpCleanup.errors.length) console.warn(`[群聊] file-claims 临时文件清理部分失败：${tmpCleanup.errors.slice(0, 3).join('；')}`);
  } catch (error) {
    console.warn('[群聊] file-claims 临时文件清理失败:', error && error.message);
  }
  traceStartup('codex config start');
  ensureCodexContextConfig();
  traceStartup('codex config done');
  traceStartup('gemini mcp install start');
  ensureGeminiMcpInstalled();
  traceStartup('gemini mcp install done');
  traceStartup('createWindow start');
  createWindow();
  traceStartup('createWindow done');
  traceStartup('hook listen start');
  hookPort = await listenWithFallback();
  if (hookPort) {
    console.log(`[群聊] hook server listening on 127.0.0.1:${hookPort}`);
    sessionManager.hookPort = hookPort;
  } else {
    console.warn('[群聊] hook server failed to bind — falling back to silence detection');
  }
  traceStartup(`hook listen done (${hookPort || 'none'})`);
  sendToRenderer('hook-status', { up: hookPort !== null, port: hookPort });

  // 2026-06-05 联邦记忆下线：claude-memory-loader 只做 readFileSync，无需预热

  // 2026-05-16 maintainer：写 per-PID 控制文件（含 hookPort + cdpPort + HOOK_TOKEN）。
  //   救援脚本 tools/hub-escape.ps1 通过 <dataDir>/control/<pid>.json 发现 Hub
  //   端口和 token。CDP 端口从 <userData>/DevToolsActivePort 读取（Chromium 写入）。
  try {
    const dataDir = getHubDataDir();
    let cdpPort = null;
    if (process.env.CLAUDE_HUB_NO_CDP !== '1') {
      // Chromium 只在 --remote-debugging-port=0（OS 自动分配）时才写 DevToolsActivePort 文件；
      // 当 CLI 已传明确端口（E2E hub-launcher 场景）时直接从 argv 解析。
      if (_hasCdpSwitch) {
        const m = process.argv.find(a => a.startsWith('--remote-debugging-port='));
        if (m) {
          const p = parseInt(m.split('=')[1], 10);
          if (!isNaN(p) && p > 0) cdpPort = p;
        }
      } else {
        cdpPort = await hubControl.readDevToolsActivePort(app.getPath('userData'));
        if (!cdpPort) console.warn('[hub-control] DevToolsActivePort not ready within 3s — CDP backdoor may be unreachable');
      }
    }
    const removed = hubControl.cleanStale(dataDir);
    if (removed.length) console.log(`[hub-control] cleaned stale entries for pids: ${removed.join(', ')}`);
    hubControl.writeControlFile({
      pid: process.pid,
      hookPort,
      cdpPort,
      token: HOOK_TOKEN,
      dataDir,
      startedAt: Date.now(),
      nativeOwnershipVersion: 1,
      sessionExclusiveVersion: 1,
    });
    console.log(`[hub-control] control file written: pid=${process.pid} hookPort=${hookPort} cdpPort=${cdpPort}`);
  } catch (e) {
    console.warn('[hub-control] init failed:', e.message);
  }

  traceStartup('startAgentScanner');
  startAgentScanner();
  sessionAutoSuspendScheduler.start();
});

let shutdownDrainState = 'idle';
let shutdownDrainPromise = null;
let finalShutdownCleanupDone = false;
let hookServerClosedForShutdown = false;

function closeHookServerForShutdown() {
  if (hookServerClosedForShutdown) return;
  hookServerClosedForShutdown = true;
  try { hookServer.close(); } catch (error) {
    console.warn('[shutdown] hook server close failed:', error && error.message);
  }
}

async function runFinalShutdownCleanup() {
  if (finalShutdownCleanupDone) return { clean: true, errors: [] };
  finalShutdownCleanupDone = true;
  const errors = [];
  const capture = (label, action) => {
    try { action(); }
    catch (error) { errors.push({ label, message: error && error.message ? error.message : String(error) }); }
  };
  capture('desktop-notification', () => desktopNotificationController?.dispose());
  desktopNotificationController = null;
  capture('completion-notifier', () => completionNotifier.dispose());
  capture('session-auto-suspend', () => sessionAutoSuspendScheduler?.stop());
  capture('claude-hook-watchdog', () => claudeHookWatchdog?.stop());
  claudeHookWatchdog = null;
  capture('windows-shell-watchdog', () => windowsShellWatchdog?.stop());
  windowsShellWatchdog = null;
  capture('terminal-output-batcher', () => terminalOutputBatcher.dispose({ flush: true }));
  capture('dev-workbench', () => devWorkbench?.dispose());
  capture('hub-assistant', () => assistantService?.close());
  capture('hub-orchestration', () => global.__orchestrationService?.stop());
  capture('hub-phone', () => phoneService?.close());
  clearTimeout(sessionSearchPrewarmTimer);
  const workerResults = await Promise.allSettled([
    transcriptParserService.close(),
    sessionSearchService.close(),
    codexJsonlUsageService.close(),
  ]);
  workerResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      errors.push({
        label: ['transcript-parser', 'session-search', 'codex-usage'][index],
        message: result.reason && result.reason.message ? result.reason.message : String(result.reason),
      });
    }
  });
  capture('dev-chat-history', () => { clearInterval(devChatHistoryTimer); nativeGroupContent.dispose(); nativeItemNotifications.dispose(); devChatHistory.dispose(); });
  capture('session-token-usage', () => sessionUsageService.dispose());
  capture('transcript-tap', () => transcriptTap.dispose());
  // 原生投研 PTY 的全局租约属于 Hub 进程生命周期。退出时同步释放，
  // 让另一台/另一个 Hub 可以立即恢复同一个 native session；崩溃场景
  // 仍由 registry 的过期租约兜底。
  if (xresearchBridge && typeof xresearchBridge.releaseAllOwnership === 'function') {
    capture('xresearch-ownership', () => xresearchBridge.releaseAllOwnership());
  }
  if (agentLeagueBridge && typeof agentLeagueBridge.stopScheduler === 'function') {
    capture('agent-league-scheduler', () => agentLeagueBridge.stopScheduler());
  }
  // 2026-05-07 maintainer：退出时保证三层都同步落盘——state.json（lock + merge）、
  //   per-meeting JSON、per-session JSON。任意一层丢了，下次 boot 的 selfHeal
  //   都能从另一层恢复。
  capture('usage-cache', () => flushUsageCacheSync());
  try {
    meetingStore.flushAll();
    console.log('[群聊] meeting-store flushed on quit');
  } catch (err) {
    errors.push({ label: 'meeting-store', message: err && err.message ? err.message : String(err) });
    console.warn('[群聊] meeting-store flush failed:', err.message);
  }
  try {
    sessionStore.flushAll();
    console.log('[hub] session-store flushed on quit');
  } catch (err) {
    errors.push({ label: 'session-store', message: err && err.message ? err.message : String(err) });
    console.warn('[hub] session-store flush failed:', err.message);
  }

  const clean = errors.length === 0;
  try {
    stateStore.save({ version: 1, cleanShutdown: clean, sessions: lastPersistedSessions, meetings: meetingManager.getAllMeetings(), immersiveByMeeting: _immersiveByMeeting }, { sync: true });
  } catch (error) {
    errors.push({ label: 'state-store', message: error && error.message ? error.message : String(error) });
  }

  // 2026-05-16 maintainer：清理自己的控制文件。unlinkSelf 内部已 try/catch + warn 非 ENOENT 错误，
  // 不外抛，所以这里裸调即可，不再加外层 catch（避免盖住内部 warn）。
  capture('hub-control', () => hubControl.unlinkSelf(getHubDataDir(), process.pid));
  if (errors.length) {
    finalShutdownCleanupDone = false;
    console.error('[shutdown] cleanup completed with errors:', errors);
  }
  return { clean: errors.length === 0, errors };
}

function restoreWindowAfterFailedShutdown() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (process.env.CLAUDE_HUB_E2E_WINDOW_MODE !== 'hidden') {
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (error) {
    console.error('[shutdown] failed to preserve a retryable Hub window:', error && error.message);
  }
}

// The renderer throttles persist-sessions (up to 2 s), so its newest workscene
// may not have reached Main yet. Ask for it and wait for the acknowledgement:
// the renderer sends persist-sessions first and the ack second, and Main
// handles one renderer's messages in order, so the ack proves the workscene
// is in lastPersistedSessions. Without waiting, a close with no live PTY
// drained at once and the final save could beat the reply.
function flushRendererWorkscene(timeoutMs = 1500) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  const requestId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise(resolve => {
    let timer = null;
    const onAck = (_event, ackId) => { if (ackId === requestId) finish(true); };
    const finish = ok => {
      clearTimeout(timer);
      ipcMain.removeListener('hub:flush-workscene:done', onAck);
      resolve(ok);
    };
    timer = setTimeout(() => {
      console.warn('[shutdown] renderer did not confirm the final workscene; saving the last one received');
      finish(false);
    }, timeoutMs);
    ipcMain.on('hub:flush-workscene:done', onAck);
    try { mainWindow.webContents.send('hub:flush-workscene', { requestId }); }
    catch { finish(false); }
  });
}

function beginGracefulHubShutdown(reason, { beforeQuit } = {}) {
  if (shutdownDrainPromise) return shutdownDrainPromise;

  shutdownDrainState = 'draining';
  global.__deliveryEngine?.freeze();
  global.__orchestrationService?.freeze();
  console.log(`[shutdown] draining PTYs before Electron teardown (${reason})`);
  // Freeze Agent League dispatch before SessionManager starts terminating PTYs.
  // Active tasks remain durable/orphan-recoverable and the phase lease is only
  // released by final cleanup after every PTY exit callback has settled.
  if (agentLeagueBridge && typeof agentLeagueBridge.beginHandoff === 'function') {
    try { agentLeagueBridge.beginHandoff(reason); }
    catch (error) { console.warn('[shutdown] agent league handoff preparation failed:', error && error.message); }
  }
  shutdownDrainPromise = flushRendererWorkscene()
    .then(() => sessionManager.disposeGracefully({ logger: console, warnAfterMs: 5000, drainTimeoutMs: 15_000 }))
    .then(async (result) => {
      if (!result || result.safeToQuit !== true) {
        shutdownDrainState = 'idle';
        shutdownDrainPromise = null;
        console.error('[shutdown] PTY drain did not reach a safe state; close was cancelled and may be retried', result);
        restoreWindowAfterFailedShutdown();
        global.__deliveryEngine?.startWatching(); global.__orchestrationService?.unfreeze();
        return result;
      }
      closeHookServerForShutdown();
      const cleanup = await runFinalShutdownCleanup();
      global.__deliveryEngine?.dispose();
      if (beforeQuit) {
        if (!cleanup.clean) throw new Error('最终保存或后台进程退出失败，已取消重启');
        await beforeQuit();
      }
      process.__hubShutdownCleanupClean = cleanup.clean === true;
      shutdownDrainState = 'drained';
      console.log(`[shutdown] PTY drain complete: ${result.drainedPtyCount} session(s), ${result.durationMs}ms`);
      if (!cleanup.clean) console.error('[shutdown] exiting with cleanShutdown=false because cleanup reported errors');
      // Re-enter app.quit only after every node-pty onExit callback completed
      // while the Node environment was still alive.
      app.quit();
      return { ...result, cleanup };
    })
    .catch((error) => {
      shutdownDrainState = 'idle';
      shutdownDrainPromise = null;
      console.error('[shutdown] PTY drain failed; refusing unsafe Electron teardown:', error && error.stack || error);
      restoreWindowAfterFailedShutdown();
      global.__deliveryEngine?.startWatching(); global.__orchestrationService?.unfreeze();
      return { safeToQuit: false, error: error && error.message ? error.message : String(error) };
    });
  return shutdownDrainPromise;
}

app.on('before-quit', (event) => {
  if (shutdownDrainState === 'drained' || shutdownDrainState === 'finalizing') {
    shutdownDrainState = 'finalizing';
    return;
  }
  event.preventDefault();
  void beginGracefulHubShutdown('before-quit');
});

app.on('window-all-closed', () => {
  void beginGracefulHubShutdown('window-all-closed');
});
