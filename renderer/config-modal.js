'use strict';

const { normalizeCardDisplayConfig } = require('../core/card-display-config.js');

const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
const DEFAULT_CLAUDE_SUBSCRIPTION_MODEL = 'claude-opus-5[1m]';
const DEFAULT_CLAUDE_FABLE_MODEL = 'claude-fable-5';

function createConfigModalController({
  document,
  ipcRenderer,
  providerModes,
  renderAccountUsage,
  applyCardDisplaySettings = () => {},
  getNotificationTarget = () => null,
}) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  if (!providerModes) throw new Error('providerModes is required');

  // Config/Settings Modal (API key + proxy)
  const CONFIG_AI_META = {
    server: {title:'服务器监控授权',hint:'仅管理 Bearer Token；监控地址和开关在设置中。',status:'访问凭据'},
    claude: {
      title: 'Claude 设置',
      hint: '使用当前本机 Claude Code 登录状态。新建 Claude 会话会走本机订阅和本机代理配置。',
      status: '订阅',
      statusClass: 'subscription',
    },
    gemini: {
      title: 'Gemini 设置',
      hint: '使用当前本机 Gemini CLI 登录状态。代理设置会影响新建 Gemini 会话。',
      status: '订阅',
      statusClass: 'subscription',
    },
    codex: {
      title: 'Codex 设置',
      hint: 'Codex 订阅账号对新建、恢复和重启统一生效，进行中的会话在本轮结束后切换。API 模式使用独立账号配置。',
    },
    kimi: {
      title: 'Kimi Code 设置',
      hint: '使用当前本机 Kimi Code CLI 登录状态；新建会话与群聊成员默认使用 Kimi K3。',
      status: '订阅',
      statusClass: 'subscription',
    },
    deepseek: {
      title: 'DeepSeek 设置',
      hint: 'DeepSeek V4 Pro / Flash 通过 Responses API 接入 Codex CLI，新建会话时可选。',
      status: 'API',
      statusClass: 'api',
    },
  };
  
  let activeConfigAi = 'codex';
  let codexSubscriptionProfiles = [
    { id: 'default', label: '主账号', home: '' },
    { id: 'second', label: '新账号', home: 'C:\\Users\\you\\.codex-profiles\\second' },
  ];
  let codexSubscriptionProfile = 'default';
  let savedCardDisplay = normalizeCardDisplayConfig();
  
  function configEl(id) {
    return document.getElementById(id);
  }

  function readCardDisplayForm() {
    return normalizeCardDisplayConfig({
      cardFontSize: configEl('cfg-card-font-size')?.value,
      cardFontFamily: configEl('cfg-card-font-family')?.value,
    });
  }

  function setCardDisplayForm(config, { apply = true } = {}) {
    const normalized = normalizeCardDisplayConfig(config);
    if (configEl('cfg-card-font-size')) configEl('cfg-card-font-size').value = String(normalized.cardFontSize);
    if (configEl('cfg-card-font-size-value')) configEl('cfg-card-font-size-value').textContent = `${normalized.cardFontSize}px`;
    if (configEl('cfg-card-font-family')) configEl('cfg-card-font-family').value = normalized.cardFontFamily;
    if (apply) applyCardDisplaySettings(normalized);
    return normalized;
  }

  function previewCardDisplay() {
    return setCardDisplayForm(readCardDisplayForm());
  }

  function readNotificationForm() {
    return {
      notificationTargetEnabled: !!configEl('cfg-notification-enabled')?.checked,
      notificationIncludePreview: !!configEl('cfg-notification-include-preview')?.checked,
      notificationNotifyGroupChats: configEl('cfg-notification-group-chats')
        ? !!configEl('cfg-notification-group-chats').checked
        : true,
      feishuTarget: configEl('cfg-feishu-target')?.value.trim() || '',
    };
  }

  function setNotificationForm(config = {}) {
    const target = getNotificationTarget();
    if (configEl('cfg-notification-enabled')) {
      configEl('cfg-notification-enabled').checked = !!(target && target.completionNotificationEnabled);
      configEl('cfg-notification-enabled').disabled = !target;
    }
    if (configEl('cfg-notification-target-title')) {
      configEl('cfg-notification-target-title').textContent = target
        ? `当前${target.type === 'meeting' ? '群聊' : '会话'}飞书通知`
        : '当前会话飞书通知';
    }
    if (configEl('cfg-notification-target-hint')) {
      configEl('cfg-notification-target-hint').textContent = target
        ? `仅控制“${String(target.title || '当前会话').slice(0, 36)}”；其他会话不受影响。`
        : '请先打开一个会话；新会话默认关闭，之后可在顶栏手动开启。';
    }
    if (configEl('cfg-notification-include-preview')) {
      configEl('cfg-notification-include-preview').checked = !!config.notificationIncludePreview;
    }
    if (configEl('cfg-notification-group-chats')) {
      configEl('cfg-notification-group-chats').checked = config.notificationNotifyGroupChats !== false;
    }
    if (configEl('cfg-feishu-target')) {
      configEl('cfg-feishu-target').value = config.feishuTarget || '';
    }
    return readNotificationForm();
  }

  function readOperationsForm() {
    return {
      aliyunMonitorEnabled: !!configEl('cfg-aliyun-enabled')?.checked,
      aliyunMonitorLabel: configEl('cfg-aliyun-label')?.value.trim() || '阿里云服务器',
      aliyunHealthUrl: configEl('cfg-aliyun-health-url')?.value.trim() || '',
      aliyunMetricsUrl: configEl('cfg-aliyun-metrics-url')?.value.trim() || '',
      operationsRestoreRoot: configEl('cfg-operations-restore-root')?.value.trim() || '',
    };
  }

  function setOperationsForm(config = {}) {
    if (configEl('cfg-aliyun-enabled')) configEl('cfg-aliyun-enabled').checked = config.aliyunMonitorEnabled === true;
    if (configEl('cfg-aliyun-label')) configEl('cfg-aliyun-label').value = config.aliyunMonitorLabel || '阿里云服务器';
    if (configEl('cfg-aliyun-health-url')) configEl('cfg-aliyun-health-url').value = config.aliyunHealthUrl || '';
    if (configEl('cfg-aliyun-metrics-url')) configEl('cfg-aliyun-metrics-url').value = config.aliyunMetricsUrl || '';
    if (configEl('cfg-aliyun-token')) configEl('cfg-aliyun-token').value = config.aliyunBearerToken || '';
    if (configEl('cfg-operations-restore-root')) configEl('cfg-operations-restore-root').value = config.operationsRestoreRoot || '';
    return readOperationsForm();
  }

  function setNotificationTestStatus(message, state = '') {
    const status = configEl('config-notification-status');
    if (!status) return;
    status.textContent = message || '';
    status.className = `config-notification-status${state ? ` ${state}` : ''}`;
  }

  function notificationErrorMessage(result) {
    const errorCode = result && result.errorCode;
    if (errorCode === 'invalid_target' || result?.status === 'configuration_missing') {
      return '请填写有效的飞书接收对象 ID（oc_ 会话/群聊，或 ou_ 用户）。';
    }
    if (errorCode === 'cli_not_found' || errorCode === 'cli_spawn_error') return '未找到飞书 CLI，请先安装或检查 HUB_NOTIFY_FEISHU_CLI_PATH。';
    if (errorCode === 'authorization_error' || errorCode === 'cli_configuration_error') return '飞书 CLI 尚未完成应用配置或授权，请先运行 lark-cli config init / auth login。';
    if (errorCode === 'missing_scope') return '飞书应用缺少 im:message:send_as_bot 权限，请补充权限后重试。';
    if (errorCode === 'confirmation_required') return '飞书 CLI 风险门禁要求人工确认；通知器不会静默绕过。';
    if (errorCode === 'timeout') return '飞书 CLI 发送超时，请检查网络后重试。';
    if (errorCode === 'network_error') return '飞书 CLI 无法连接开放平台，请检查网络或代理。';
    if (errorCode === 'invalid_response') return '飞书 CLI 返回了无法识别的结果，请检查 CLI 版本。';
    return `飞书测试发送失败${result?.providerCode ? `（${result.providerCode}）` : ''}，请检查机器人是否在目标会话内。`;
  }

  async function testCompletionNotification() {
    const button = configEl('config-notification-test');
    const target = configEl('cfg-feishu-target')?.value.trim() || '';
    if (!target) {
      setNotificationTestStatus('请先填写飞书接收对象 ID。', 'error');
      return { ok: false, status: 'configuration_missing' };
    }
    if (button) {
      button.disabled = true;
      button.textContent = '发送中…';
    }
    setNotificationTestStatus('正在通过飞书 CLI 发送测试通知…', 'working');
    try {
      const result = await ipcRenderer.invoke('test-completion-notification', { target });
      if (result && result.ok) {
        setNotificationTestStatus('测试通知已发送，请查看飞书。', 'success');
      } else {
        setNotificationTestStatus(notificationErrorMessage(result), 'error');
      }
      return result;
    } catch {
      setNotificationTestStatus('测试发送失败，主进程通知服务暂不可用。', 'error');
      return { ok: false, status: 'failed' };
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '发送测试';
      }
    }
  }
  
  function normalizeCodexProfilesForUi(profiles) {
    const byId = new Map(codexSubscriptionProfiles.map(p => [p.id, { ...p }]));
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        if (!p || typeof p !== 'object') continue;
        const id = String(p.id || '').trim();
        if (!id) continue;
        byId.set(id, {
          id,
          label: String(p.label || id).trim() || id,
          home: String(p.home || '').trim(),
        });
      }
    }
    return [...byId.values()];
  }
  
  function renderCodexProfileSelect(selectedId) {
    const select = configEl('cfg-codex-subscription-profile');
    if (!select) return;
    const selected = selectedId || codexSubscriptionProfile || 'default';
    select.innerHTML = '';
    for (const profile of codexSubscriptionProfiles) {
      const opt = document.createElement('option');
      opt.value = profile.id;
      opt.textContent = profile.label || profile.id;
      select.appendChild(opt);
    }
    select.value = codexSubscriptionProfiles.some(p => p.id === selected) ? selected : 'default';
    codexSubscriptionProfile = select.value;
  }
  
  function setCodexProfileForm(profiles, selectedId) {
    codexSubscriptionProfiles = normalizeCodexProfilesForUi(profiles);
    codexSubscriptionProfile = selectedId || 'default';
    const main = codexSubscriptionProfiles.find(p => p.id === 'default') || { label: '主账号', home: '' };
    const second = codexSubscriptionProfiles.find(p => p.id === 'second') || { label: '新账号', home: '' };
    if (configEl('cfg-codex-profile-default-label')) configEl('cfg-codex-profile-default-label').value = main.label || '主账号';
    if (configEl('cfg-codex-profile-second-label')) configEl('cfg-codex-profile-second-label').value = second.label || '新账号';
    if (configEl('cfg-codex-profile-second-home')) configEl('cfg-codex-profile-second-home').value = second.home || '';
    renderCodexProfileSelect(codexSubscriptionProfile);
    updateCodexProfileMenuLabels();
  }
  
  function readCodexProfilesFromForm() {
    const mainLabel = (configEl('cfg-codex-profile-default-label') && configEl('cfg-codex-profile-default-label').value.trim()) || '主账号';
    const secondLabel = (configEl('cfg-codex-profile-second-label') && configEl('cfg-codex-profile-second-label').value.trim()) || '新账号';
    const secondHome = (configEl('cfg-codex-profile-second-home') && configEl('cfg-codex-profile-second-home').value.trim()) || '';
    codexSubscriptionProfiles = [
      { id: 'default', label: mainLabel, home: '' },
      { id: 'second', label: secondLabel, home: secondHome },
    ];
    return codexSubscriptionProfiles;
  }
  
  function updateCodexProfileMenuLabels() {
    const byId = new Map(codexSubscriptionProfiles.map(p => [p.id, p]));
    document.querySelectorAll('[data-codex-profile-label]').forEach(el => {
      const profile = byId.get(el.dataset.codexProfileLabel);
      if (profile) el.textContent = profile.label || profile.id;
    });
  }
  
  function setConfigStatus(el, label, cls) {
    if (!el) return;
    el.textContent = label;
    el.className = 'config-ai-status ' + (cls || '');
  }

  function updateClaudeBackendControls() {
    const backend = configEl('cfg-claude-backend') ? configEl('cfg-claude-backend').value : 'subscription';
    const isApi = backend === 'api';
    for (const id of ['cfg-claude-key', 'cfg-claude-url', 'cfg-claude-model']) {
      const el = configEl(id);
      if (el) el.disabled = !isApi;
    }
    const subscriptionCard = configEl('cfg-claude-subscription-card');
    const apiCard = configEl('cfg-claude-api-card');
    if (subscriptionCard) subscriptionCard.classList.toggle('selected', !isApi);
    if (apiCard) apiCard.classList.toggle('selected', isApi);
    const routeNote = configEl('cfg-claude-route-note');
    if (routeNote) {
      routeNote.textContent = isApi
        ? '中转端当前使用 HTTP 明文连接。Key、提示词和回复可能在传输链路上被读取。'
        : '中转参数已保存备用；当前订阅模式不会读取或发送中转 Key。';
      routeNote.className = isApi ? 'config-note warning' : 'config-note';
    }
    if (activeConfigAi === 'claude' && configEl('cfg-detail-hint')) {
      configEl('cfg-detail-hint').textContent = isApi
        ? '新建 Claude 会话将直连同事中转，使用已保存的 Key 与 Fable 5 模型。'
        : CONFIG_AI_META.claude.hint;
    }
  }

  function claudeModelDisplayName(model) {
    return model === DEFAULT_CLAUDE_FABLE_MODEL ? 'Fable 5 · 1M' : model;
  }

  function updateConfigSummaries() {
    const claudeBackend = configEl('cfg-claude-backend') ? configEl('cfg-claude-backend').value : 'subscription';
    const claudeModel = configEl('cfg-claude-model') ? (configEl('cfg-claude-model').value.trim() || DEFAULT_CLAUDE_FABLE_MODEL) : DEFAULT_CLAUDE_FABLE_MODEL;
    const claudeKey = configEl('cfg-claude-key') ? configEl('cfg-claude-key').value.trim() : '';
    const codexBackend = configEl('cfg-codex-backend') ? configEl('cfg-codex-backend').value : 'subscription';
    const codexModel = configEl('cfg-codex-model') ? (configEl('cfg-codex-model').value.trim() || DEFAULT_CODEX_MODEL) : DEFAULT_CODEX_MODEL;
    const codexKey = configEl('cfg-codex-key') ? configEl('cfg-codex-key').value.trim() : '';
    const profiles = readCodexProfilesFromForm();
    const profileSelect = configEl('cfg-codex-subscription-profile');
    const selectedProfileId = profileSelect ? profileSelect.value : codexSubscriptionProfile;
    if (profileSelect) renderCodexProfileSelect(selectedProfileId);
    const selectedProfile = profiles.find(p => p.id === selectedProfileId) || profiles[0];
    codexSubscriptionProfile = selectedProfile ? selectedProfile.id : 'default';
    updateCodexProfileMenuLabels();
    const deepseekKey = configEl('cfg-deepseek-key') ? configEl('cfg-deepseek-key').value.trim() : '';
  
    const codexSummary = configEl('cfg-summary-codex');
    if (codexSummary) {
      codexSummary.textContent = codexBackend === 'api'
        ? `第三方 API · ${codexModel} · Packy`
        : `订阅模式 · ${(selectedProfile && selectedProfile.label) || '主账号'} · ${codexModel}`;
    }
    setConfigStatus(
      configEl('cfg-status-codex'),
      codexBackend === 'api' ? (codexKey ? 'API' : '缺 Key') : ((selectedProfile && selectedProfile.label) || '订阅'),
      codexBackend === 'api' ? (codexKey ? 'api' : 'missing') : 'subscription'
    );
  
    const deepseekSummary = configEl('cfg-summary-deepseek');
    if (deepseekSummary) deepseekSummary.textContent = deepseekKey ? 'Codex API · V4 Pro / Flash' : 'Codex API · 未配置 Key';
    setConfigStatus(configEl('cfg-status-deepseek'), deepseekKey ? 'API' : '缺 Key', deepseekKey ? 'api' : 'missing');

    const claudeSummary = configEl('cfg-summary-claude');
    if (claudeSummary) {
      claudeSummary.textContent = claudeBackend === 'api'
        ? `同事中转 · ${claudeModelDisplayName(claudeModel)}`
        : `订阅模式 · ${DEFAULT_CLAUDE_SUBSCRIPTION_MODEL}`;
    }
    setConfigStatus(
      configEl('cfg-status-claude'),
      claudeBackend === 'api' ? (claudeKey ? '中转' : '缺 Key') : '订阅',
      claudeBackend === 'api' ? (claudeKey ? 'api' : 'missing') : 'subscription'
    );
    if (activeConfigAi === 'claude') {
      setConfigStatus(
        configEl('cfg-detail-status'),
        claudeBackend === 'api' ? (claudeKey ? '中转' : '缺 Key') : '订阅',
        claudeBackend === 'api' ? (claudeKey ? 'api' : 'missing') : 'subscription'
      );
    }

    if (activeConfigAi === 'codex') {
      setConfigStatus(
        configEl('cfg-detail-status'),
        codexBackend === 'api' ? (codexKey ? 'API' : '缺 Key') : ((selectedProfile && selectedProfile.label) || '订阅'),
        codexBackend === 'api' ? (codexKey ? 'api' : 'missing') : 'subscription'
      );
    } else if (activeConfigAi === 'deepseek') {
      setConfigStatus(configEl('cfg-detail-status'), deepseekKey ? 'API' : '缺 Key', deepseekKey ? 'api' : 'missing');
    }
  }
  
  function showConfigMainView() {
    if (configEl('config-main-view')) configEl('config-main-view').classList.remove('hidden');
    if (configEl('config-detail-view')) configEl('config-detail-view').classList.add('hidden');
    document.querySelectorAll('.config-ai-row').forEach(row => row.classList.remove('active'));
    updateConfigSummaries();
  }
  
  function showConfigDetail(ai) {
    activeConfigAi = ai || 'codex';
    const meta = CONFIG_AI_META[activeConfigAi] || CONFIG_AI_META.codex;
    if (configEl('config-main-view')) configEl('config-main-view').classList.add('hidden');
    if (configEl('config-detail-view')) configEl('config-detail-view').classList.remove('hidden');
    if (configEl('cfg-detail-title')) configEl('cfg-detail-title').textContent = meta.title;
    if (configEl('cfg-detail-hint')) configEl('cfg-detail-hint').textContent = meta.hint;
    document.querySelectorAll('.config-ai-row').forEach(row => row.classList.toggle('active', row.dataset.ai === activeConfigAi));
    document.querySelectorAll('.config-ai-detail').forEach(panel => panel.classList.toggle('active', panel.id === 'cfg-detail-' + activeConfigAi));
  
    if (meta.status) {
      setConfigStatus(configEl('cfg-detail-status'), meta.status, meta.statusClass);
    }
    if (activeConfigAi === 'claude') updateClaudeBackendControls();
    updateConfigSummaries();
  }
  
  async function openConfigModal(options = {}) {
    let modal = document.getElementById('config-modal');
    if (!modal && document.readyState === 'loading') {
      await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
      modal = document.getElementById('config-modal');
    }
    if (!modal) return;
  
    // 加载当前配置；读取失败时禁止保存旧表单。
    configEl('config-save').disabled=true;
    try {
      const cfg = await ipcRenderer.invoke('get-hub-config-raw');
      providerModes.claude = cfg.claudeBackend === 'api' ? 'api' : 'subscription';
      providerModes.codex = cfg.codexBackend === 'api' ? 'api' : 'subscription';
      setCodexProfileForm(cfg.codexSubscriptionProfiles, cfg.codexSubscriptionProfile);
      document.getElementById('cfg-proxy').value = cfg.proxy || '';
      document.getElementById('cfg-claude-backend').value = cfg.claudeBackend || 'subscription';
      document.getElementById('cfg-claude-key').value = cfg.claudeApiKey || '';
      document.getElementById('cfg-claude-url').value = cfg.claudeApiBaseUrl || '';
      document.getElementById('cfg-claude-model').value = cfg.claudeApiModel || DEFAULT_CLAUDE_FABLE_MODEL;
      document.getElementById('cfg-deepseek-key').value = cfg.deepseekApiKey || '';
      document.getElementById('cfg-codex-backend').value = cfg.codexBackend || 'subscription';
      document.getElementById('cfg-codex-key').value = cfg.codexApiKey || '';
      document.getElementById('cfg-codex-url').value = cfg.codexApiBaseUrl || '';
      document.getElementById('cfg-codex-model').value = cfg.codexApiModel || '';
      savedCardDisplay = setCardDisplayForm(cfg);
      setNotificationForm(cfg);
      setOperationsForm(cfg);
      updateClaudeBackendControls();
      updateConfigSummaries();
      configEl('config-save').disabled=false;
    } catch (error) {
      if(options.accountsOnly)throw new Error("配置读取失败，未打开空白编辑器以免覆盖已有账号：" + error.message);
      configEl('config-main-view').classList.add('hidden');
      const msg=configEl('config-save-msg');msg.textContent='配置读取失败，请关闭后重试；未修改已有账号。';msg.className='config-save-msg error';msg.style.display='block';modal.classList.remove('hidden');return;
    }
    if (options.accountsOnly) { showConfigDetail(options.provider || 'codex'); return; }
    showConfigMainView();
    modal.classList.remove('hidden');
    if (options && options.notificationSetup === true) {
      setNotificationTestStatus('先填写飞书接收对象并发送测试；进入重要会话后，再为该会话单独开启通知。', 'working');
      const card = configEl('config-notification-card');
      try { card?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
      setTimeout(() => {
        try { configEl('cfg-feishu-target')?.focus(); } catch {}
      }, 0);
    }
    if (options && options.operationsSetup === true) {
      const card = configEl('cfg-aliyun-enabled')?.closest('.config-operations-card');
      try { card?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
      setTimeout(() => {
        try { configEl('cfg-aliyun-health-url')?.focus(); } catch {}
      }, 0);
    }
  }

  function openNotificationSetup() {
    return openConfigModal({ notificationSetup: true });
  }

  function openOperationsSetup() {
    return openConfigModal({ operationsSetup: true });
  }
  
  function closeConfigModal() {
    applyCardDisplaySettings(savedCardDisplay);
    const modal = document.getElementById('config-modal');
    if (modal) modal.classList.add('hidden');
    const msg = document.getElementById('config-save-msg');
    if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
    setNotificationTestStatus('');
  }
  
  async function saveAccountConfig() {
    const button=configEl('account-config-save'),msg=configEl('account-config-msg');
    if (button.disabled) return;
    button.disabled=true;msg.textContent='正在保存…';
    try {
      const fields={
        aliyunBearerToken: configEl('cfg-aliyun-token')?.value.trim() || '',
        claudeBackend: document.getElementById('cfg-claude-backend').value,
        claudeApiKey: document.getElementById('cfg-claude-key').value.trim() || undefined,
        claudeApiBaseUrl: document.getElementById('cfg-claude-url').value.trim() || undefined,
        claudeApiModel: document.getElementById('cfg-claude-model').value.trim() || undefined,
        deepseekApiKey: document.getElementById('cfg-deepseek-key').value.trim() || undefined,
        codexBackend: document.getElementById('cfg-codex-backend').value,
        codexSubscriptionProfile: (document.getElementById('cfg-codex-subscription-profile') && document.getElementById('cfg-codex-subscription-profile').value) || 'default',
        codexSubscriptionProfiles: readCodexProfilesFromForm(),
        codexApiKey: document.getElementById('cfg-codex-key').value.trim() || undefined,
        codexApiBaseUrl: document.getElementById('cfg-codex-url').value.trim() || undefined,
        codexApiModel: document.getElementById('cfg-codex-model').value.trim() || undefined,
      };
      const groups={claude:['claudeBackend','claudeApiKey','claudeApiBaseUrl','claudeApiModel'],codex:['codexBackend','codexSubscriptionProfile','codexSubscriptionProfiles','codexApiKey','codexApiBaseUrl','codexApiModel'],deepseek:['deepseekApiKey'],server:['aliyunBearerToken']};
      const newConfig=Object.fromEntries((groups[activeConfigAi]||[]).map(key=>[key,fields[key]]));
      if(newConfig.claudeBackend==='api' && (!newConfig.claudeApiKey||!newConfig.claudeApiBaseUrl||!newConfig.claudeApiModel))throw new Error('请完整填写 Claude 中转 Key、Base URL 和模型');
      const result=await ipcRenderer.invoke('save-hub-config',newConfig);
      if(!result?.success)throw new Error(result?.error||'保存失败');
      if(newConfig.claudeBackend!==undefined)providerModes.claude=newConfig.claudeBackend==='api'?'api':'subscription';
      if(newConfig.codexBackend!==undefined)providerModes.codex=newConfig.codexBackend==='api'?'api':'subscription';
      renderAccountUsage();updateConfigSummaries();
      msg.textContent='已保存。仅新建会话使用新的接入配置，当前会话不变。';
      document.dispatchEvent(new CustomEvent('hub-account-config-saved'));
      document.dispatchEvent(new CustomEvent('hub-config-saved'));
    } catch(error) { msg.textContent='保存失败：'+error.message; }
    finally { button.disabled=false; }
  }

  // 配置面板事件（DOM ready 后绑定）
  function initConfigModal() {
    const modal = document.getElementById('config-modal');
    if (!modal || modal.dataset.configBound) return;
    modal.dataset.configBound='true';
    configEl('account-config-save')?.addEventListener('click',saveAccountConfig);
    document.getElementById('config-close').addEventListener('click', closeConfigModal);
    document.getElementById('config-cancel').addEventListener('click', closeConfigModal);
    const backBtn = document.getElementById('config-back');
    if (backBtn) backBtn.addEventListener('click', showConfigMainView);
    document.querySelectorAll('.config-ai-row').forEach(row => {
      row.addEventListener('click', () => showConfigDetail(row.dataset.ai));
    });
    ['cfg-claude-backend', 'cfg-claude-key', 'cfg-claude-url', 'cfg-claude-model', 'cfg-codex-backend', 'cfg-codex-subscription-profile', 'cfg-codex-profile-default-label', 'cfg-codex-profile-second-label', 'cfg-codex-profile-second-home', 'cfg-codex-key', 'cfg-codex-url', 'cfg-codex-model', 'cfg-deepseek-key'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', updateConfigSummaries);
      if (el) el.addEventListener('change', () => {
        if (id === 'cfg-claude-backend') updateClaudeBackendControls();
        updateConfigSummaries();
      });
    });
    const cardSize = configEl('cfg-card-font-size');
    const cardFamily = configEl('cfg-card-font-family');
    if (cardSize) cardSize.addEventListener('input', previewCardDisplay);
    if (cardFamily) cardFamily.addEventListener('change', previewCardDisplay);
    const notificationTest = configEl('config-notification-test');
    if (notificationTest) notificationTest.addEventListener('click', testCompletionNotification);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeConfigModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        e.preventDefault(); closeConfigModal();
      }
    });
  
    document.getElementById('config-save').addEventListener('click', async () => {
      const msg = document.getElementById('config-save-msg');
      const notificationForm = readNotificationForm();
      const operationsForm = readOperationsForm();
      const notificationTarget = getNotificationTarget();
      const newConfig = {
        proxy: document.getElementById('cfg-proxy').value.trim() || undefined,
        ...readCardDisplayForm(),
        notificationIncludePreview: notificationForm.notificationIncludePreview,
        notificationNotifyGroupChats: notificationForm.notificationNotifyGroupChats,
        feishuTarget: notificationForm.feishuTarget,
        ...operationsForm,
      };
      if (newConfig.feishuTarget && !/^(?:oc|ou)_[A-Za-z0-9_-]{6,256}$/.test(newConfig.feishuTarget)) {
        msg.textContent = '飞书接收对象 ID 必须以 oc_（会话/群聊）或 ou_（用户）开头。';
        msg.className = 'config-save-msg error';
        msg.style.display = 'block';
        return;
      }
      if (notificationForm.notificationTargetEnabled && !newConfig.feishuTarget) {
        msg.textContent = '启用飞书通知前，请先填写飞书接收对象 ID。';
        msg.className = 'config-save-msg error';
        msg.style.display = 'block';
        return;
      }
      if (operationsForm.aliyunMonitorEnabled && !/^https?:\/\//i.test(operationsForm.aliyunHealthUrl)) {
        msg.textContent = '启用服务器监控前，请填写有效的 HTTP(S) 健康检查 URL。';
        msg.className = 'config-save-msg error';
        msg.style.display = 'block';
        return;
      }
      try {
        const result = await ipcRenderer.invoke('save-hub-config', newConfig);
        if (result && result.success) {
          if (notificationTarget) {
            const targetResult = await ipcRenderer.invoke('set-completion-notification-enabled', {
              enabled: notificationForm.notificationTargetEnabled,
              ...(notificationTarget.type === 'meeting'
                ? { meetingId: notificationTarget.id }
                : { sessionId: notificationTarget.id }),
            });
            if (!targetResult || !targetResult.ok) {
              throw new Error('会话通知状态保存失败');
            }
          }
          renderAccountUsage();
          savedCardDisplay = setCardDisplayForm(newConfig);
          try { document.dispatchEvent(new CustomEvent('hub-config-saved', { detail: newConfig })); } catch {}
          msg.textContent = notificationTarget
            ? (notificationForm.notificationTargetEnabled
              ? `配置已保存。“${notificationTarget.title || '当前会话'}”回答完成后会推送。`
              : `配置已保存。“${notificationTarget.title || '当前会话'}”通知已关闭，其他会话状态不变。`)
            : '连接配置已保存。打开需要关注的会话后，可在顶栏单独开启通知。';
          msg.className = 'config-save-msg success';
          msg.style.display = 'block';
          setTimeout(() => { msg.style.display = 'none'; }, 4000);
        } else {
          throw new Error('save failed');
        }
      } catch (err) {
        msg.textContent = '保存失败: ' + (err.message || '未知错误');
        msg.className = 'config-save-msg error';
        msg.style.display = 'block';
      }
    });
  }
  document.addEventListener('DOMContentLoaded', initConfigModal);
  // 如果 DOM 已经 ready 也立即尝试
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(initConfigModal, 0);
  }

  return {
    open: openConfigModal,
    openAccountConfig: provider => { configEl('account-config-msg').textContent=''; return openConfigModal({accountsOnly:true,provider}); },
    saveAccountConfig,
    openNotificationSetup,
    openOperationsSetup,
    close: closeConfigModal,
    init: initConfigModal,
    setCodexProfileForm,
    updateClaudeBackendControls,
    updateSummaries: updateConfigSummaries,
    showMainView: showConfigMainView,
    showDetail: showConfigDetail,
    readCodexProfilesFromForm,
    readCardDisplayForm,
    setCardDisplayForm,
    readNotificationForm,
    setNotificationForm,
    readOperationsForm,
    setOperationsForm,
    testCompletionNotification,
  };
}

module.exports = { createConfigModalController };
