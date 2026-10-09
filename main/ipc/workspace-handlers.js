'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeKey } = require('../../core/workspace-service.js');
const { migrateTranscriptsForCwdChange } = require('../../core/claude-transcript-locator.js');
const { migrateKimiSession } = require('../../core/kimi-session-migrator.js');
const { migrateCodexSession } = require('../../core/codex-session-migrator.js');
const { buildSessionResumeMeta } = require('../../core/session-capabilities.js');
const { buildClaudeModelSnapshot } = require('../../core/claude-model-catalog.js');
const { createCodexModelCatalogService } = require('../codex-model-catalog-service.js');

// Claude CLI 的 --resume 按 cwd 分桶查找 transcript。DeepSeek 仅有迁移前、
// 携带 ccSessionId 的旧会话走这套；当前 DeepSeek 与 Codex 一样改写 rollout cwd。
//
// ⚠ 2026-07-28 修正：这里原本写着「codex 的 rollout 按日期存放…不受目录搬迁影响」，
// 并据此把 codex 排除在整个归档迁移之外。「rollout 文件放在哪」确实不受影响，但
// rollout 的**内容里**记着 cwd，CLI 启动时会拿它跟当前目录比对，对不上就弹
// "Choose working directory to resume this session" 等按键 —— 群聊成员会永久卡住，
// 而 Hub 侧显示 idle，用户只能靠肉眼发现它不说话了。文件找得到 ≠ 能无痛恢复。
// codex 现在走 migrateCodexSession（改写 rollout 里记的 cwd），见下方归档流程。
function baseKind(kind) {
  return String(kind || '').replace(/-resume$/, '');
}

function configuredCodexHome(config = {}, requestedId = null) {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  const profiles = Array.isArray(config.codexSubscriptionProfiles) ? config.codexSubscriptionProfiles : [];
  const selectedId = String(requestedId || config.codexSubscriptionProfile || 'default');
  const selected = profiles.find(profile => profile && String(profile.id) === selectedId)
    || profiles.find(profile => profile && String(profile.id) === 'default');
  const raw = String(selected && selected.home || '').trim();
  if (!raw) return undefined;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function isLegacyClaudeTranscriptSession(session) {
  const kind = baseKind(session && session.kind);
  return kind === 'claude' || (kind === 'deepseek' && !!session.ccSessionId && !session.codexSid);
}

function isCodexTranscriptSession(session) {
  const kind = baseKind(session && session.kind);
  return kind === 'codex' || (kind === 'deepseek' && !isLegacyClaudeTranscriptSession(session));
}

function registerWorkspaceIpc(ipcMain, deps) {
  const {
    dialog,
    meetingManager,
    sendToRenderer,
    sessionManager,
    shell,
    resumeSession,
    allowFallbackResume = false,
    workspaceMigrationSessionIds = new Set(),
    workspaceService,
    getLastPersistedSessions = () => [],
    getHubConfig = () => ({}),
    codexModelCatalogService = createCodexModelCatalogService(),
  } = deps;

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function entityContext(args = {}) {
    if (args.scope === 'meeting') {
      const meeting = meetingManager && meetingManager.getMeeting(args.id);
      if (!meeting) throw new Error('AI 群聊不存在或已经关闭');
      return {
        scope: 'meeting',
        id: meeting.id,
        title: meeting.title,
        source: meeting.workspace,
        label: meeting.workspaceLabel || meeting.title,
        meeting,
      };
    }
    const session = sessionManager.getSession(args.id);
    if (!session || session.meetingId) throw new Error('普通会话不存在或已经关闭');
    return {
      scope: 'session',
      id: session.id,
      title: session.title,
      source: session.cwd,
      label: session.workspaceLabel || session.title,
      session,
    };
  }

  function toResumeMeta(session, cwd, workspaceLabel) {
    const isGemini = typeof session.kind === 'string' && session.kind.replace(/-resume$/, '') === 'gemini';
    return buildSessionResumeMeta(session, {
      cwd,
      workspaceLabel,
      geminiProjectRoot: isGemini ? cwd : (session.geminiProjectRoot || null),
    });
  }

  function preciseResumeIssue(session) {
    if (allowFallbackResume) return null;
    const kind = String(session && session.kind || '').replace(/-resume$/, '');
    if (isLegacyClaudeTranscriptSession(session)) return session.ccSessionId ? null : `${session.title || kind} 尚未绑定 Claude session ID`;
    if (isCodexTranscriptSession(session)) return session.codexSid ? null : `${session.title || kind} 尚未绑定 Codex session ID`;
    if (kind === 'gemini') return session.geminiChatId ? null : `${session.title || kind} 尚未绑定 Gemini chat ID`;
    if (kind === 'kimi') return session.kimiSid ? null : `${session.title || kind} 尚未绑定 Kimi session ID`;
    return `${session && session.title || kind || '当前终端'} 不支持保留上下文迁移`;
  }

  function sessionsForEntity(entity) {
    if (entity.scope === 'meeting') {
      return (entity.meeting.subSessions || []).map(id => sessionManager.getSession(id)).filter(Boolean);
    }
    if (!entity.session) return [];
    // 分支会话（fork）继承源会话的 cwd，普通会话也可能被手动开在同一目录。
    // 只关掉 entity.id 的话，剩下的进程仍占着目录，rename 在 Windows 上会 EBUSY；
    // 就算侥幸移动成功，兄弟会话的 cwd 也会指向一个不存在的路径。
    return sessionManager.getAllSessions()
      .filter(session => session
        && !session.meetingId
        && session.cwd
        && normalizeKey(session.cwd) === normalizeKey(entity.source));
  }

  async function waitForSessionsClosed(ids, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (ids.some(id => sessionManager.getSession(id))) {
      if (Date.now() >= deadline) {
        const stillOpen = ids.filter(id => sessionManager.getSession(id));
        throw new Error(`CLI 未能及时退出：${stillOpen.map(id => id.slice(0, 8)).join(', ')}`);
      }
      await wait(50);
    }
  }

  async function resumeAll(snapshots, cwd, workspaceLabel) {
    const resumed = [];
    const failures = [];
    for (const snapshot of snapshots) {
      try {
        const session = await resumeSession(toResumeMeta(snapshot, cwd, workspaceLabel));
        if (session) resumed.push(session);
        else failures.push(`${snapshot.title || snapshot.id}: 返回空会话`);
      } catch (error) {
        failures.push(`${snapshot.title || snapshot.id}: ${error && error.message ? error.message : String(error)}`);
      }
    }
    return { resumed, failures };
  }

  // 归档流程里所有「成功但降级」的分支都必须走这一条通道。
  //
  // 血泪：codex rollout 迁移失败、transcript 找不到、休眠会话搬迁失败，过去清一色
  // 只有 console.warn。桌面图标启动的 Hub 根本没有终端窗口，那些日志等于不存在——
  // 用户看到「归档成功」，随后那个 codex 成员 resume 时弹目录选择菜单永久卡住，
  // 变成注释里一直说要避免的「在线但永远不说话的成员」。
  //
  // 通道有两条腿，缺一不可：
  //   ① 立刻 sendToRenderer('workspace-archive-warning')：即使归档后半程 throw
  //      （restart.failures 那条路），已经推出去的降级信息也不会跟着返回值一起丢；
  //   ② 汇总进返回值 warnings：渲染端在归档完成时一并呈现，不依赖事件时序。
  // 新增降级分支请调 report()，不要再写第二个「只落 console」的分支。
  function createArchiveReporter(entity) {
    const warnings = [];
    return {
      warnings,
      report(stage, target, message) {
        const entry = {
          scope: entity.scope,
          id: entity.id,
          stage,
          target: target == null ? '' : String(target),
          message: message == null ? '' : String(message),
        };
        warnings.push(entry);
        console.warn(`[workspace] archive degraded (${stage}):`, entry.target, entry.message);
        try {
          sendToRenderer('workspace-archive-warning', entry);
        } catch (error) {
          // 推送失败也不能吞：返回值里的 warnings 仍然带着这条。
          console.warn('[workspace] archive warning push failed:', error && error.message);
        }
      },
    };
  }

  async function archiveDraftAfterExit(source, opts) {
    let lastError = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { return workspaceService.archiveDraft(source, opts); } catch (error) {
        lastError = error;
        if (!error || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        await wait(100);
      }
    }
    throw lastError || new Error('workspace move failed after CLI exit');
  }

  function activePaths() {
    const sessionPaths = sessionManager.getAllSessions()
      .filter(session => session && session.cwd)
      .map(session => session.cwd);
    const meetingPaths = meetingManager && typeof meetingManager.getAllMeetings === 'function'
      ? meetingManager.getAllMeetings().map(meeting => meeting && meeting.workspace).filter(Boolean)
      : [];
    return [...sessionPaths, ...meetingPaths];
  }

  ipcMain.handle('workspace:list', () => workspaceService.listWorkspaces(activePaths()));

  // All project consumers share formal registration; activity never grants membership.
  ipcMain.handle('workspace:prepared-projects', (_event, request = {}) => {
    const { PreparedProjectRegistry } = require('../../core/prepared-project-registry');
    const registry = new PreparedProjectRegistry({ dataDir: path.dirname(workspaceService.getRegistryPath()) });
    const candidates = sessionManager.getAllSessions().filter(s => s && s.cwd).map(s => ({
      path: s.cwd, activeAt: Math.max(Number(s.lastInputAt) || 0, Number(s.lastOutputAt) || 0, Number(s.createdAt) || 0),
    }));
    if (meetingManager && typeof meetingManager.getAllMeetings === 'function') {
      for (const m of meetingManager.getAllMeetings()) if (m && m.workspace) candidates.push({
        path: m.workspace, activeAt: Math.max(Number(m.updatedAt) || 0, Number(m.createdAt) || 0),
      });
    }
    // 这条 IPC 的四个 renderer 调用方都只是「把已登记项目列出来给人看」，
    // 尚未登记 = 空列表，不是故障；库损坏仍然抛给 UI 显示。
    return registry.list({ searchRoots: request?.searchRoots === true, candidates, allowMissing: true });
  });

  // 新建会话弹窗要按**当前选中的模型**给出思考强度档位：Codex 的档位是按模型
  // 下发的（gpt-5.6-sol 有 ultra，5.5 只到 xhigh），写死一份必然给某些模型多出
  // 或少掉档位。数据来自 codex-cli 自己缓存的 ~/.codex/models_cache.json。
  // 顺带回一个用户全局配的 service_tier，好让"跟随全局"那一档显示成"（当前：fast）"。
  ipcMain.handle('codex:tuning-catalog', async (_event, request = {}) => {
    try {
      const { readCodexConfiguredServiceTier } = require('../../core/codex-speed-tier.js');
      const config = getHubConfig() || {};
      const snapshot = await codexModelCatalogService.getCatalog({
        force: request && request.force === true,
        home: configuredCodexHome(config, request && request.codexProfile),
        proxy: config.proxy || undefined,
        offline: process.env.CLAUDE_HUB_E2E === '1'
          && process.env.HUB_MODEL_CATALOG_LIVE_E2E !== '1',
      });
      return {
        ...snapshot,
        configuredServiceTier: readCodexConfiguredServiceTier(configuredCodexHome(config, request && request.codexProfile)),
      };
    } catch (error) {
      // 目录读不到不该让弹窗打不开 —— renderer 侧有静态兜底档位。
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  });

  // Claude Code refreshes account-specific extra model choices in .claude.json.
  // Reading it on demand makes newly granted models (for example Fable 5.1)
  // appear without a Hub release or restart. Stable CLI aliases remain the
  // fallback when no account cache is available.
  ipcMain.handle('claude:model-catalog', () => buildClaudeModelSnapshot({
    configDir: process.env.CLAUDE_CONFIG_DIR || undefined,
    homeDir: process.env.CLAUDE_HUB_HOME_DIR || undefined,
  }));

  ipcMain.handle('workspace:create-scratch', (_event, opts = {}) => {
    const workspace = workspaceService.createScratchWorkspace({ ...opts, select: false });
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  // 平铺模式的默认工作区（工作根本身）。renderer 用它来实现「默认」那一档，
  // 顺带回一个 flat 标志，让 UI 知道该不该显示平铺文案。
  ipcMain.handle('workspace:default', (_event, opts = {}) => {
    const flat = workspaceService.isFlatWorkRoot();
    const workspace = flat
      ? workspaceService.ensureDefaultWorkspace({ ...opts, select: false })
      : workspaceService.createScratchWorkspace({ ...opts, select: false });
    sendToRenderer('workspace-updated', { workspace });
    return { ...workspace, flat };
  });

  // 只读：拿平铺工作根的路径。建房闸门要用它做「失效目录」的兜底落脚点 ——
  // workspace:default 会顺带创建/选中工作区，问一句路径不该有副作用。
  ipcMain.handle('workspace:work-root', () => ({
    root: workspaceService.getWorkspaceRoot(),
    flat: workspaceService.isFlatWorkRoot(),
  }));

  ipcMain.handle('workspace:select', (_event, cwd) => {
    const workspace = workspaceService.resolveForSession(cwd, { select: false });
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 AI Hub workspace',
      defaultPath: workspaceService.getWorkspaceRoot(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用此文件夹',
    });
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    const workspace = workspaceService.resolveForSession(result.filePaths[0], { select: false });
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:pick-archive-parent', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择正式项目所在文件夹',
      defaultPath: workspaceService.getWorkspaceRoot(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '在这里新建项目目录',
    });
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    return { path: path.resolve(result.filePaths[0]) };
  });

  ipcMain.handle('workspace:dismiss-archive', (_event, args = {}) => {
    const workspace = workspaceService.dismissArchive(args && args.path);
    if (workspace) sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:archive-context', (_event, args = {}) => {
    const entity = entityContext(args);
    const context = workspaceService.getArchiveContext(entity.source);
    const entitySessions = sessionsForEntity(entity);
    const resumeIssues = entitySessions.map(preciseResumeIssue).filter(Boolean);
    if (entity.scope === 'meeting' && entitySessions.length !== (entity.meeting.subSessions || []).length) {
      resumeIssues.push('部分群聊成员当前未运行');
    }
    if (entity.scope === 'session' && entitySessions.length === 0) {
      resumeIssues.push('当前会话未在运行');
    }
    return {
      ...context,
      scope: entity.scope,
      id: entity.id,
      title: entity.title,
      source: entity.source,
      label: entity.label,
      resumeReady: resumeIssues.length === 0,
      resumeIssues,
    };
  });

  ipcMain.handle('workspace:archive-and-restart', async (_event, args = {}) => {
    if (typeof resumeSession !== 'function') throw new Error('Hub resume service is unavailable');
    const entity = entityContext(args);
    const plan = workspaceService.planArchive(entity.source, {
      parent: args.parent,
      folderName: args.folderName,
    });
    // session scope 收全部占用该目录的会话（含 fork 分支），meeting scope 收全体成员。
    const snapshots = sessionsForEntity(entity);
    const ids = snapshots.map(session => session.id);
    if (ids.length === 0) throw new Error('没有可安全重连的活动 CLI');
    if (entity.scope === 'meeting' && ids.length !== (entity.meeting.subSessions || []).length) {
      throw new Error('部分群聊成员未运行，请先恢复全部成员再归档');
    }
    const resumeIssues = snapshots.map(preciseResumeIssue).filter(Boolean);
    if (resumeIssues.length > 0) throw new Error(`${resumeIssues.join('；')}，请稍等会话绑定完成后重试`);
    ids.forEach(id => workspaceMigrationSessionIds.add(id));

    let moved = false;
    let workspace = null;
    // Kimi 迁移失败的会话 id：不再盲目重连（连上也是个死终端），汇总到失败列表。
    const kimiFailedIds = new Set();
    const kimiFailures = [];
    // Codex 迁移失败不至于让会话变成死终端（大不了 resume 时再弹一次菜单），
    // 所以只警告不拉黑，与 kimi 的处理级别刻意区分。
    // 但「不拉黑」不等于「不告诉用户」：所有降级统一走 archiveReporter → UI。
    const archiveReporter = createArchiveReporter(entity);
    try {
      ids.forEach(id => sessionManager.closeSession(id));
      await waitForSessionsClosed(ids);
      workspace = await archiveDraftAfterExit(entity.source, {
        parent: plan.parent,
        folderName: plan.folderName,
        label: entity.label,
      });
      moved = true;

      let meeting = null;
      if (entity.scope === 'meeting') {
        meeting = meetingManager.updateMeeting(entity.id, {
          workspace: workspace.path,
          workspaceLabel: workspace.label,
        });
        if (meeting) sendToRenderer('meeting-updated', { meeting });
      }

      // Must run before resumeAll: the CLI resolves --resume against the *new*
      // cwd bucket, so without this the archived session comes back empty.
      const migration = migrateTranscriptsForCwdChange({
        toCwd: workspace.path,
        ccSessionIds: snapshots
          .filter(isLegacyClaudeTranscriptSession)
          .map(snapshot => snapshot.ccSessionId)
          .filter(Boolean),
      });
      // transcript 没搬全 = 归档后 --resume 会拿到空上下文。归档本身仍然成功，
      // 所以不 throw，但必须让用户看见（以前只有 console.warn）。
      for (const detail of migration.errors) {
        archiveReporter.report('transcript', '', `对话记录迁移失败：${detail}`);
      }
      for (const ccSessionId of migration.missing) {
        archiveReporter.report('transcript', ccSessionId,
          '没找到对应的 Claude 对话记录，归档后重连可能是空上下文');
      }

      // Kimi 会校验会话记录的 workDir 与 cwd 是否一致，不迁移就直接
      // "created under a different directory" 退出——PTY spawn 仍然成功，
      // Hub 察觉不到，用户只会看到一个死掉的终端。必须在重连前搬好注册表。
      // 迁移成功后必须把新 sessionDir/wire 路径写回 resume meta，否则 tap 和
      // 卡片视图继续盯着已被搬走的旧路径（JsonlTail 对缺失文件静默轮询，永不恢复）；
      // 迁移失败的会话不再盲目重连（连上也是个死终端），而是汇总报错。
      const migrateKimiSnapshot = (snapshot) => {
        if (baseKind(snapshot.kind) !== 'kimi' || !snapshot.kimiSid) return;
        try {
          const migration = migrateKimiSession({ sessionId: snapshot.kimiSid, toCwd: workspace.path });
          if (!migration.ok) {
            kimiFailedIds.add(snapshot.id);
            kimiFailures.push(`${snapshot.title || snapshot.id}: ${migration.reason}`);
            return;
          }
          if (migration.sessionDir) {
            snapshot.kimiSessionDir = migration.sessionDir;
            snapshot.transcriptPath = path.join(migration.sessionDir, 'agents', 'main', 'wire.jsonl');
          }
        } catch (error) {
          kimiFailedIds.add(snapshot.id);
          kimiFailures.push(`${snapshot.title || snapshot.id}: ${error && error.message ? error.message : String(error)}`);
        }
      };
      // Codex 会拿 rollout 里记的 cwd 跟当前目录比对，对不上就弹交互菜单等按键。
      // 迁移失败不阻断归档（归档已经成功了），但要汇总告知——否则用户只会看到
      // 一个"在线但永远不说话"的成员。
      const migrateCodexSnapshot = (snapshot) => {
        if (!isCodexTranscriptSession(snapshot) || !snapshot.codexSid) return;
        try {
          const migration = migrateCodexSession({
            sessionId: snapshot.codexSid,
            toCwd: workspace.path,
            sessionsRoot: snapshot.codexSessionsRoot || undefined,
          });
          if (!migration.ok) {
            archiveReporter.report('codex', snapshot.title || snapshot.id, migration.reason);
          }
        } catch (error) {
          archiveReporter.report('codex', snapshot.title || snapshot.id,
            error && error.message ? error.message : String(error));
        }
      };
      for (const snapshot of snapshots) migrateKimiSnapshot(snapshot);
      for (const snapshot of snapshots) migrateCodexSnapshot(snapshot);

      // 同目录下 dormant（未运行）的 Kimi 会话也要一起搬：它们的 kimi 状态仍指着
      // 已被移走的旧目录，不搬的话之后唤醒必然 "created under a different directory"。
      // renderer 里该条目的 cwd/kimiSessionDir 由 session-meta-updated 广播同步，
      // resume 时还有 lookupKimiSession 对账兜底（resume-session-handlers）。
      const liveIds = new Set(ids);
      const dormantKimiMigrated = [];
      // 同目录下休眠的 claude / codex 也必须跟着搬 —— 它们不在 snapshots 里（只收活动
      // 会话），归档后持久化的 cwd 就指向一个已经不存在的目录。后果分别是：
      //   claude: spawn 时 fs.accessSync 失败 → 静默回退到 USERPROFILE，会话落回
      //           用户最想摆脱的 home 目录，且 --resume 在 home 桶里找不到 transcript；
      //   codex : rollout 里的 cwd 仍是旧路径 → resume 弹目录选择菜单永久卡住。
      // 两者都无声无息，UI 上看不出异常，所以必须在这里一次处理干净。
      const dormantMigrated = [];
      for (const entry of getLastPersistedSessions() || []) {
        if (!entry || !entry.hubId || liveIds.has(entry.hubId)) continue;
        if (!entry.cwd || normalizeKey(entry.cwd) !== normalizeKey(entity.source)) continue;
        const kind = baseKind(entry.kind);

        if (isLegacyClaudeTranscriptSession(entry)) {
          try {
            if (entry.ccSessionId) {
              migrateTranscriptsForCwdChange({ toCwd: workspace.path, ccSessionIds: [entry.ccSessionId] });
            }
            entry.cwd = workspace.path;
            dormantMigrated.push(entry.hubId);
            sendToRenderer('session-meta-updated', {
              hubSessionId: entry.hubId,
              kind: entry.kind,
              cwd: workspace.path,
            });
          } catch (error) {
            // 休眠 claude/deepseek 没搬成 = 它的 cwd 还指着已经不存在的旧目录，
            // 下次唤醒会静默回退到 USERPROFILE。同样不 throw，但必须可见。
            archiveReporter.report('dormant', entry.title || entry.hubId,
              `休眠会话未能跟随迁移：${error && error.message ? error.message : String(error)}`);
          }
          continue;
        }

        if (isCodexTranscriptSession(entry)) {
          try {
            if (entry.codexSid) {
              const migration = migrateCodexSession({
                sessionId: entry.codexSid,
                toCwd: workspace.path,
                sessionsRoot: entry.codexSessionsRoot || undefined,
              });
              if (!migration.ok) {
                archiveReporter.report('codex', `${entry.title || entry.hubId}（休眠）`, migration.reason);
              }
            }
            entry.cwd = workspace.path;
            dormantMigrated.push(entry.hubId);
            sendToRenderer('session-meta-updated', {
              hubSessionId: entry.hubId,
              kind: entry.kind,
              codexSid: entry.codexSid || null,
              cwd: workspace.path,
            });
          } catch (error) {
            archiveReporter.report('codex', `${entry.title || entry.hubId}（休眠）`,
              error && error.message ? error.message : String(error));
          }
          continue;
        }

        if (kind !== 'kimi' || !entry.kimiSid) continue;
        try {
          const migration = migrateKimiSession({ sessionId: entry.kimiSid, toCwd: workspace.path });
          if (!migration.ok) {
            kimiFailures.push(`${entry.title || entry.hubId}（休眠）: ${migration.reason}`);
            continue;
          }
          entry.cwd = workspace.path;
          if (migration.sessionDir) {
            entry.kimiSessionDir = migration.sessionDir;
            entry.transcriptPath = path.join(migration.sessionDir, 'agents', 'main', 'wire.jsonl');
          }
          dormantKimiMigrated.push(entry.hubId);
          sendToRenderer('session-meta-updated', {
            hubSessionId: entry.hubId,
            kind: entry.kind,
            kimiSid: entry.kimiSid,
            kimiSessionDir: entry.kimiSessionDir || null,
            transcriptPath: entry.transcriptPath || null,
            cwd: workspace.path,
          });
        } catch (error) {
          kimiFailures.push(`${entry.title || entry.hubId}（休眠）: ${error && error.message ? error.message : String(error)}`);
        }
      }

      const restart = await resumeAll(
        snapshots.filter(snapshot => !kimiFailedIds.has(snapshot.id)),
        workspace.path,
        workspace.label,
      );
      restart.failures.unshift(...kimiFailures);
      sendToRenderer('workspace-updated', { workspace });
      // restart 失败仍然 throw（kimi 的标准）：这一步失败意味着终端真的没回来。
      // 之前累积的 warnings 不会跟着丢——它们在 report() 里已经推给 renderer 了。
      if (restart.failures.length > 0) {
        throw new Error(`Workspace 已归档，但部分 CLI 重连失败：${restart.failures.join('；')}`);
      }
      return {
        ok: true,
        scope: entity.scope,
        id: entity.id,
        source: entity.source,
        workspace,
        resumedSessionIds: restart.resumed.map(session => session.id),
        dormantKimiMigrated,
        dormantMigrated,
        // 归档成功但有降级时，渲染端据此把归档框切成「完成 · N 项需要注意」。
        warnings: archiveReporter.warnings,
        // 旧字段保留兼容（历史上只被构造、没人读），内容改由统一通道派生。
        codexWarnings: archiveReporter.warnings
          .filter(item => item.stage === 'codex')
          .map(item => `${item.target}: ${item.message}`),
      };
    } catch (error) {
      const closedSnapshots = snapshots.filter(snapshot =>
        !sessionManager.getSession(snapshot.id) && !kimiFailedIds.has(snapshot.id));
      if (closedSnapshots.length > 0) {
        if (moved && workspace) await resumeAll(closedSnapshots, workspace.path, workspace.label);
        else await resumeAll(closedSnapshots, entity.source, entity.label);
      }
      throw error;
    } finally {
      ids.forEach(id => workspaceMigrationSessionIds.delete(id));
    }
  });

  ipcMain.handle('workspace:rename-label', (_event, args = {}) => {
    const workspace = workspaceService.renameLabel(args.path, args.label);
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:reveal', async (_event, cwd) => {
    const target = path.resolve(String(cwd || ''));
    const known = workspaceService.listWorkspaces(activePaths()).items
      .some(item => normalizeKey(item.path) === normalizeKey(target));
    if (!known) return { ok: false, error: 'unknown-workspace' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });
}

module.exports = { registerWorkspaceIpc };
