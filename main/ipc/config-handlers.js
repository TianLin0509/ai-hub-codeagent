'use strict';

const fs = require('fs');
const {
  getConfig,
  saveConfig,
  checkMissingConfig,
  getConfigPath,
  readConfigJsonForUpdate,
  DEFAULTS,
} = require('../../core/hub-config.js');
const {
  normalizeCardFontSize,
  normalizeCardFontFamily,
} = require('../../core/card-display-config.js');
const { withDefaultModelInJson } = require('../../core/default-model-preference.js');
const {
  isUsableFeishuTarget,
  normalizeNotificationConfig,
} = require('../../core/completion-notifier.js');
const {
  normalizeOperationsConfig,
  serializeOperationsConfig,
} = require('../../core/operations-config.js');

function maskSecret(secret) {
  const value = String(secret || '');
  return value ? `***${value.slice(-4)}` : '';
}

function toMaskedConfig(config) {
  const notifications = normalizeNotificationConfig(config.notifications || {});
  const operations = normalizeOperationsConfig(config.operations || {});
  return {
    proxy: config.proxy,
    claudeBackend: config.claudeBackend,
    claudeApiKey: config.claudeApiKey ? '***' + config.claudeApiKey.slice(-4) : '',
    claudeApiKeySet: !!config.claudeApiKey,
    claudeApiBaseUrl: config.claudeApiBaseUrl,
    claudeApiModel: config.claudeApiModel,
    deepseekApiKey: config.deepseekApiKey ? '***' + config.deepseekApiKey.slice(-4) : '',
    deepseekApiKeySet: !!config.deepseekApiKey,
    codexBackend: config.codexBackend,
    codexSubscriptionProfile: config.codexSubscriptionProfile,
    codexSubscriptionProfiles: config.codexSubscriptionProfiles || [],
    // Display-only, read fresh from each profile's own auth.json. Kept out of the profile
    // objects themselves so the account form cannot round-trip it back into config.json.
    codexProfileIdentities: Object.fromEntries((config.codexSubscriptionProfiles || []).map(p => [p.id,
      require('../../core/account-center').codexAccountLabel(
        require('path').resolve(require('../../core/codex-usage-scope').expandHomePath(
          p.home || process.env.CODEX_HOME || require('path').join(require('os').homedir(), '.codex'),
          require('os').homedir())))])),
    codexApiKey: config.codexApiKey ? '***' + config.codexApiKey.slice(-4) : '',
    codexApiKeySet: !!config.codexApiKey,
    codexApiBaseUrl: config.codexApiBaseUrl,
    codexApiModel: config.codexApiModel,
    // 新建会话面板要靠它决定预选哪个模型，不含敏感信息，原样透出。
    defaultModels: config.defaultModels || {},
    notificationEnabled: notifications.enabled,
    notificationIncludePreview: notifications.includePreview,
    notificationNotifyGroupChats: notifications.notifyGroupChats,
    notificationConfigured: isUsableFeishuTarget(notifications.feishuTarget),
    feishuTarget: notifications.feishuTarget,
    feishuTargetSet: isUsableFeishuTarget(notifications.feishuTarget),
    aliyunMonitorEnabled: operations.aliyunMonitor.enabled,
    aliyunMonitorLabel: operations.aliyunMonitor.label,
    aliyunHealthUrl: operations.aliyunMonitor.healthUrl,
    aliyunMetricsUrl: operations.aliyunMonitor.metricsUrl,
    aliyunBearerToken: maskSecret(operations.aliyunMonitor.bearerToken),
    aliyunBearerTokenSet: !!operations.aliyunMonitor.bearerToken,
  };
}

function toEditableConfig(config) {
  const notifications = normalizeNotificationConfig(config.notifications || {});
  const operations = normalizeOperationsConfig(config.operations || {});
  return {
    proxy: config.proxy,
    claudeBackend: config.claudeBackend,
    claudeApiKey: config.claudeApiKey || '',
    claudeApiBaseUrl: config.claudeApiBaseUrl,
    claudeApiModel: config.claudeApiModel,
    deepseekApiKey: config.deepseekApiKey || '',
    codexBackend: config.codexBackend,
    codexSubscriptionProfile: config.codexSubscriptionProfile,
    codexSubscriptionProfiles: config.codexSubscriptionProfiles || [],
    // Display-only, read fresh from each profile's own auth.json. Kept out of the profile
    // objects themselves so the account form cannot round-trip it back into config.json.
    codexProfileIdentities: Object.fromEntries((config.codexSubscriptionProfiles || []).map(p => [p.id,
      require('../../core/account-center').codexAccountLabel(
        require('path').resolve(require('../../core/codex-usage-scope').expandHomePath(
          p.home || process.env.CODEX_HOME || require('path').join(require('os').homedir(), '.codex'),
          require('os').homedir())))])),
    codexApiKey: config.codexApiKey || '',
    codexApiBaseUrl: config.codexApiBaseUrl,
    codexApiModel: config.codexApiModel,
    uiToolFoldThreshold: Number.isFinite(config.uiToolFoldThreshold) ? config.uiToolFoldThreshold : 15,
    uiCodeFoldThreshold: Number.isFinite(config.uiCodeFoldThreshold) ? config.uiCodeFoldThreshold : 30,
    cardFontSize: normalizeCardFontSize(config.cardFontSize),
    cardFontFamily: normalizeCardFontFamily(config.cardFontFamily),
    notificationEnabled: notifications.enabled,
    notificationIncludePreview: notifications.includePreview,
    notificationNotifyGroupChats: notifications.notifyGroupChats,
    notificationConfigured: isUsableFeishuTarget(notifications.feishuTarget),
    feishuTarget: notifications.feishuTarget,
    feishuCliPath: notifications.feishuCliPath,
    aliyunMonitorEnabled: operations.aliyunMonitor.enabled,
    aliyunMonitorLabel: operations.aliyunMonitor.label,
    aliyunHealthUrl: operations.aliyunMonitor.healthUrl,
    aliyunMetricsUrl: operations.aliyunMonitor.metricsUrl,
    aliyunBearerToken: operations.aliyunMonitor.bearerToken,
    operationsRestoreRoot: operations.restoreRoot,
  };
}

const NOTIFICATION_UPDATE_FIELDS = [
  'notificationEnabled',
  'notificationIncludePreview',
  'notificationNotifyGroupChats',
  'feishuTarget',
  'feishuCliPath',
];

const OPERATIONS_UPDATE_FIELDS = [
  'aliyunMonitorEnabled',
  'aliyunMonitorLabel',
  'aliyunHealthUrl',
  'aliyunMetricsUrl',
  'aliyunBearerToken',
  'operationsRestoreRoot',
];

function buildNotificationJsonUpdate(existingNotifications, newConfig, hasOwn) {
  const previous = normalizeNotificationConfig(existingNotifications || {}, {});
  const candidate = normalizeNotificationConfig({
    enabled: hasOwn('notificationEnabled') ? newConfig.notificationEnabled : previous.enabled,
    includePreview: hasOwn('notificationIncludePreview')
      ? newConfig.notificationIncludePreview
      : previous.includePreview,
    notifyGroupChats: hasOwn('notificationNotifyGroupChats')
      ? newConfig.notificationNotifyGroupChats
      : previous.notifyGroupChats,
    feishuTarget: hasOwn('feishuTarget')
      ? newConfig.feishuTarget
      : previous.feishuTarget,
    feishuCliPath: hasOwn('feishuCliPath')
      ? newConfig.feishuCliPath
      : previous.feishuCliPath,
  }, {});

  const existingFeishu = existingNotifications?.feishu && typeof existingNotifications.feishu === 'object'
    ? existingNotifications.feishu
    : {};
  const updated = {
    ...(existingNotifications || {}),
    enabled: candidate.enabled,
    provider: 'feishu-cli',
    include_preview: candidate.includePreview,
    preview_chars: candidate.previewChars,
    notify_group_chats: candidate.notifyGroupChats,
    feishu: {
      ...existingFeishu,
      target: candidate.feishuTarget || undefined,
      ...(hasOwn('feishuCliPath') ? { cli_path: candidate.feishuCliPath || undefined } : {}),
    },
  };
  // 旧版曾按窗口焦点/系统空闲/任务耗时自动过滤。连接设置变更时清理这些
  // 遗留字段；是否推送已经由 session / meeting 自己的开关决定。
  delete updated.mode;
  delete updated.idle_seconds;
  delete updated.min_duration_seconds;
  delete updated.serverchan;
  if (!updated.feishu.target) delete updated.feishu.target;
  if (!updated.feishu.cli_path) delete updated.feishu.cli_path;
  return updated;
}

function completionNotificationState(config = getConfig()) {
  const notifications = normalizeNotificationConfig(config.notifications || {});
  return {
    enabled: notifications.enabled,
    configured: isUsableFeishuTarget(notifications.feishuTarget),
  };
}

function buildConfigJsonUpdate(existing, newConfig) {
  // 2026-06-14 修复部分提交数据丢失：config-modal 全量提交始终带全部字段。旧逻辑对每个 provider 字段无条件
  //   `newConfig.X || default/undefined`，使部分提交把未提交的 deepseek
  //   api_key、各 base_url/model、proxy、packy cookie 全部重置/抹掉。
  //   修法：仅当 newConfig 显式带了该字段(hasOwnProperty)才用其值，否则保留 existing。
  //   全量提交所有 key 都在 → 行为与旧版完全一致(零回归)；部分提交其余字段原样保留。
  const H = (k) => Object.prototype.hasOwnProperty.call(newConfig, k);
  const hasNotificationUpdate = NOTIFICATION_UPDATE_FIELDS.some(H);
  const hasOperationsUpdate = OPERATIONS_UPDATE_FIELDS.some(H);
  const merged = {
    ...existing,
    proxy: { http: H('proxy') ? (newConfig.proxy || DEFAULTS.proxy) : (existing.proxy?.http || DEFAULTS.proxy) },
    providers: {
      ...(existing.providers || {}),
      claude: {
        ...(existing.providers?.claude || {}),
        backend: H('claudeBackend')
          ? (newConfig.claudeBackend === 'api' ? 'api' : DEFAULTS.claude_backend)
          : (existing.providers?.claude?.backend || DEFAULTS.claude_backend),
        api_key: H('claudeApiKey')
          ? (newConfig.claudeApiKey || undefined)
          : existing.providers?.claude?.api_key,
        base_url: H('claudeApiBaseUrl')
          ? (newConfig.claudeApiBaseUrl || DEFAULTS.claude_api_base_url)
          : (existing.providers?.claude?.base_url || DEFAULTS.claude_api_base_url),
        model: H('claudeApiModel')
          ? (newConfig.claudeApiModel || DEFAULTS.claude_api_model)
          : (existing.providers?.claude?.model || DEFAULTS.claude_api_model),
      },
      deepseek: {
        ...(existing.providers?.deepseek || {}),
        api_key: H('deepseekApiKey') ? (newConfig.deepseekApiKey || undefined) : existing.providers?.deepseek?.api_key,
      },
      codex: (() => {
        return {
          ...(existing.providers?.codex || {}),
          backend: H('codexBackend')
            ? (newConfig.codexBackend === 'api' ? 'api' : DEFAULTS.codex_backend)
            : (existing.providers?.codex?.backend || DEFAULTS.codex_backend),
          subscription_profile: H('codexSubscriptionProfile')
            ? (newConfig.codexSubscriptionProfile || DEFAULTS.codex_subscription_profile)
            : (existing.providers?.codex?.subscription_profile || DEFAULTS.codex_subscription_profile),
          subscription_profiles: H('codexSubscriptionProfiles')
            ? (Array.isArray(newConfig.codexSubscriptionProfiles) ? newConfig.codexSubscriptionProfiles : undefined)
            : existing.providers?.codex?.subscription_profiles,
          api_key: H('codexApiKey')
            ? (newConfig.codexApiKey || undefined)
            : existing.providers?.codex?.api_key,
          base_url: H('codexApiBaseUrl')
            ? (newConfig.codexApiBaseUrl || DEFAULTS.codex_api_base_url)
            : (existing.providers?.codex?.base_url || DEFAULTS.codex_api_base_url),
          model: H('codexApiModel')
            ? (newConfig.codexApiModel || DEFAULTS.codex_api_model)
            : (existing.providers?.codex?.model || DEFAULTS.codex_api_model),
          provider: existing.providers?.codex?.provider || DEFAULTS.codex_api_provider,
        };
      })(),
    },
    ui: {
      ...(existing.ui || {}),
      card_font_size: H('cardFontSize')
        ? normalizeCardFontSize(newConfig.cardFontSize)
        : normalizeCardFontSize(existing.ui?.card_font_size),
      card_font_family: H('cardFontFamily')
        ? normalizeCardFontFamily(newConfig.cardFontFamily)
        : normalizeCardFontFamily(existing.ui?.card_font_family),
    },
    ...(hasNotificationUpdate ? {
      notifications: buildNotificationJsonUpdate(existing.notifications, newConfig, H),
    } : {}),
    ...(hasOperationsUpdate ? {
      operations: serializeOperationsConfig(existing.operations, {
        aliyunMonitor: {
          ...(H('aliyunMonitorEnabled') ? { enabled: newConfig.aliyunMonitorEnabled === true } : {}),
          ...(H('aliyunMonitorLabel') ? { label: newConfig.aliyunMonitorLabel } : {}),
          ...(H('aliyunHealthUrl') ? { healthUrl: newConfig.aliyunHealthUrl } : {}),
          ...(H('aliyunMetricsUrl') ? { metricsUrl: newConfig.aliyunMetricsUrl } : {}),
          ...(H('aliyunBearerToken') ? { bearerToken: newConfig.aliyunBearerToken } : {}),
        },
        ...(H('operationsRestoreRoot') ? { restoreRoot: newConfig.operationsRestoreRoot } : {}),
      }),
    } : {}),
  };

  if (!merged.providers.claude.api_key) delete merged.providers.claude.api_key;
  if (!merged.providers.claude.base_url) delete merged.providers.claude.base_url;
  if (!merged.providers.deepseek.api_key) delete merged.providers.deepseek.api_key;
  if (!merged.providers.codex.api_key) delete merged.providers.codex.api_key;

  return merged;
}

function registerConfigIpc(ipcMain, deps) {
  const {
    attachCodexUsageScope,
    clearCodexJsonlCache,
    clearSessionManagerConfigCache,
    currentCodexUsageScope,
    getCompletionNotificationHealth,
    scanAgentSessions,
    sendToRenderer,
    sessionManager,
    meetingManager,
    testCompletionNotification,
    ensureLaunchAuth,
  } = deps;

  ipcMain.handle('get-hub-config', () => toMaskedConfig(require('../../core/codex-global-account').currentConfig()));

  ipcMain.handle('get-hub-config-raw', () => toEditableConfig(require('../../core/codex-global-account').currentConfig()));

  ipcMain.handle('codex:set-global-account', async (_e, payload = {}) => {
    try {
      if (payload.scope === 'launch' && ensureLaunchAuth) await ensureLaunchAuth('codex',{launchProfile:payload.profileId});
      const merged = require('../../core/codex-global-account').withGlobalAccount(
        readConfigJsonForUpdate(),require('../../core/codex-global-account').currentConfig(),payload.profileId,process.env,payload.scope);
      saveConfig(merged);
      clearSessionManagerConfigCache();
      const scope=currentCodexUsageScope();
      clearCodexJsonlCache();
      sendToRenderer('agent-usage',{codex:attachCodexUsageScope({usage5h:null,usage7d:null,unavailable:true},scope)});
      sendToRenderer('codex-global-account-changed',{profileId:payload.profileId});
      const switchScope=require('../../core/codex-global-account').currentConfig().codexAccountSwitchScope;
      const sessions=switchScope === 'launch' ? [] : await sessionManager.syncCodexAccounts();
      return {ok:true,profileId:payload.profileId,scope:switchScope,sessions};
    } catch(error) { return {ok:false,error:error.message}; }
  });

  ipcMain.handle('get-completion-notification-health', () => (
    typeof getCompletionNotificationHealth === 'function'
      ? getCompletionNotificationHealth()
      : { lastDelivery: null, retrying: false }
  ));

  ipcMain.handle('test-completion-notification', async (_event, payload = {}) => {
    if (typeof testCompletionNotification !== 'function') {
      return { ok: false, status: 'unavailable', errorCode: 'notifier_unavailable' };
    }
    try {
      return await testCompletionNotification({
        target: typeof payload.target === 'string' ? payload.target : '',
      });
    } catch {
      return { ok: false, status: 'failed', errorCode: 'unexpected_error' };
    }
  });

  ipcMain.handle('set-completion-notification-enabled', (_event, payload = {}) => {
    const enabled = payload.enabled === true;
    const connection = completionNotificationState();
    if (enabled && !connection.configured) {
      return { ok: false, status: 'configuration_missing', enabled: false, configured: false };
    }

    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const meetingId = typeof payload.meetingId === 'string' ? payload.meetingId : '';
    if (!sessionId && !meetingId) {
      return { ok: false, status: 'missing_target', enabled: false, configured: connection.configured };
    }

    let updated = null;
    let state = null;
    if (sessionId) {
      updated = sessionManager && sessionManager.updateSessionMeta(sessionId, {
        completionNotificationEnabled: enabled,
      });
      if (!updated) {
        return { ok: false, status: 'target_not_found', enabled: false, configured: connection.configured };
      }
      sendToRenderer('session-updated', { session: updated });
      state = { enabled, configured: connection.configured, targetType: 'session', targetId: sessionId };
    } else {
      updated = meetingManager && meetingManager.updateMeeting(meetingId, {
        completionNotificationEnabled: enabled,
      });
      if (!updated) {
        return { ok: false, status: 'target_not_found', enabled: false, configured: connection.configured };
      }
      sendToRenderer('meeting-updated', { meeting: updated });
      state = { enabled, configured: connection.configured, targetType: 'meeting', targetId: meetingId };
    }
    sendToRenderer('completion-notification-target-changed', state);
    return { ok: true, status: 'saved', ...state };
  });

  // 新建会话面板的「设为默认」。刻意不复用 save-hub-config：那条路要求 renderer
  // 提交一份完整表单，而这里只想改一个字段；走读-改-写并只替换 models.defaults，
  // 别的字段一律原样带过去。model 传空表示恢复出厂默认值。
  ipcMain.handle('session:set-default-model', (_e, payload = {}) => {
    let existing;
    try {
      // readConfigJsonForUpdate 只把「文件还不存在」当成空配置，其它读取失败会抛
      // 出来，由这里中止——否则整份写回会把别的字段静默抹掉。它同时剥 BOM，
      // 记事本改过 config.json 的机器才不会一直报 config_read_failed。
      existing = readConfigJsonForUpdate();
    } catch (e) {
      console.error('[config] set-default-model: 读取现有配置失败，已中止:', e && e.message);
      return { ok: false, error: 'config_read_failed' };
    }
    let merged;
    try {
      merged = withDefaultModelInJson(existing, payload.kind, payload.model, {
        // renderer 传来的是当前下拉里真正能选的清单。ACP 那几个 kind 的下拉会
        // 追加用户在配置里自定义的模型（acpModelOptions 的第二个参数），静态
        // 清单认不出来——下拉里选得到却存不进去就成了死路。清单只负责放行，
        // 命令行安全白名单仍然照样把关。
        availableIds: Array.isArray(payload.available) ? payload.available : null,
      });
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
    saveConfig(merged);
    clearSessionManagerConfigCache();
    return { ok: true, defaultModels: (merged.models && merged.models.defaults) || {} };
  });

  ipcMain.handle('save-hub-config', (_e, newConfig) => {
    let existing;
    try {
      // ENOENT = 配置文件还不存在（首次运行），当成空配置继续保存。
      // 其它错误（文件被锁 EBUSY/EPERM、JSON 损坏等）说明现有配置确实读不到——
      // 此时若用空对象合并，部分字段提交（如 网关 弹窗只发 3 个字段）会静默
      // 抹掉其它 provider 的已存 API key。宁可中止本次保存，也不能静默覆盖。
      // 这两种语义连同 BOM 剥离都收在 readConfigJsonForUpdate 里（旧代码漏了
      // 剥 BOM，记事本改过 config.json 的机器会一直存不进去）。
      existing = readConfigJsonForUpdate();
    } catch (e) {
      console.error('[config] save-hub-config: 读取现有配置失败，已中止保存以防覆盖其它字段:', e && e.message);
      return { success: false, error: 'config_read_failed' };
    }

    const merged = buildConfigJsonUpdate(existing, newConfig);
    saveConfig(merged);
    clearSessionManagerConfigCache();
    if (NOTIFICATION_UPDATE_FIELDS.some(key => Object.prototype.hasOwnProperty.call(newConfig, key))) {
      sendToRenderer('completion-notification-config-changed', completionNotificationState());
    }

    if (newConfig.codexSubscriptionProfile !== undefined || newConfig.codexSubscriptionProfiles !== undefined) {
      sendToRenderer('codex-global-account-changed',{profileId:getConfig().codexSubscriptionProfile});
      sessionManager?.syncCodexAccounts?.().catch(error=>console.error('[config] Codex account switch:',error.message));
    }

    if (newConfig.codexBackend !== undefined || newConfig.codexSubscriptionProfile !== undefined) {
      const scope = currentCodexUsageScope();
      clearCodexJsonlCache();
      sendToRenderer('agent-usage', { codex: attachCodexUsageScope({ usage5h: null, usage7d: null, unavailable: true }, scope) });
      setImmediate(() => {
        Promise.resolve(scanAgentSessions()).catch(error => {
          console.warn('[config] usage rescan failed:', error && error.message);
        });
      });
    }
    return { success: true };
  });

  ipcMain.handle('check-config-missing', () => {
    return checkMissingConfig();
  });

  ipcMain.handle('get-config-path', () => {
    return getConfigPath();
  });

}

module.exports = {
  buildConfigJsonUpdate,
  completionNotificationState,
  registerConfigIpc,
  toEditableConfig,
  toMaskedConfig,
};
