'use strict';

function normalizeToggleState(value = {}) {
  const targetId = typeof value.targetId === 'string' ? value.targetId : null;
  const targetType = value.targetType === 'meeting' ? 'meeting' : (value.targetType === 'session' ? 'session' : null);
  return {
    enabled: value.enabled === true || value.completionNotificationEnabled === true,
    configured: value.configured === true
      || value.notificationConfigured === true
      || value.feishuTargetSet === true,
    available: value.available !== false && !!targetId && !!targetType,
    targetType,
    targetId,
  };
}

function createCompletionNotificationToggle({
  document,
  ipcRenderer,
  getNotificationTarget = () => null,
  openNotificationSettings = () => {},
} = {}) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');

  const button = document.getElementById('completion-notification-toggle');
  const label = document.getElementById('completion-notification-toggle-label');
  let state = normalizeToggleState();
  let busy = false;
  let initialized = false;

  function render() {
    if (!button || !label) return state;
    const visualState = !state.configured
      ? 'unconfigured'
      : (!state.available ? 'unavailable' : (state.enabled ? 'enabled' : 'disabled'));
    button.dataset.state = visualState;
    button.classList.toggle('enabled', visualState === 'enabled');
    button.classList.toggle('disabled', visualState === 'disabled');
    button.classList.toggle('unconfigured', visualState === 'unconfigured');
    button.classList.toggle('unavailable', visualState === 'unavailable');
    button.classList.toggle('busy', busy);
    button.setAttribute('aria-pressed', String(visualState === 'enabled'));
    button.setAttribute('aria-busy', String(busy));
    label.textContent = visualState === 'enabled'
      ? '通知开'
      : (visualState === 'disabled'
        ? '通知关'
        : (visualState === 'unavailable' ? '会话通知' : '通知未配'));
    button.title = visualState === 'enabled'
      ? '当前会话的飞书完成通知已开启。点击关闭'
      : (visualState === 'disabled'
        ? '当前会话的飞书完成通知已关闭。点击开启'
        : (visualState === 'unavailable'
          ? '打开一个会话后，可在这里单独开启飞书完成通知'
          : '未配置飞书接收对象，点击进入设置'));
    return state;
  }

  function applyState(next) {
    state = normalizeToggleState(next);
    return render();
  }

  function currentTarget() {
    const target = getNotificationTarget();
    if (!target || typeof target.id !== 'string' || !target.id) return null;
    const targetType = target.type === 'meeting' ? 'meeting' : 'session';
    return {
      targetType,
      targetId: target.id,
      enabled: target.completionNotificationEnabled === true || target.enabled === true,
    };
  }

  function refreshTarget(configured = state.configured) {
    const target = currentTarget();
    return applyState({
      configured,
      available: !!target,
      enabled: !!(target && target.enabled),
      targetType: target && target.targetType,
      targetId: target && target.targetId,
    });
  }

  async function refresh() {
    try {
      const config = await ipcRenderer.invoke('get-hub-config');
      return refreshTarget(!!(config && (
        config.notificationConfigured
        || config.feishuTargetSet
        || config.configured
      )));
    } catch {
      return render();
    }
  }

  async function toggle() {
    if (busy) return { ok: false, status: 'busy' };
    const target = currentTarget();
    if (!target) {
      await Promise.resolve(openNotificationSettings());
      return { ok: false, status: 'missing_target' };
    }
    if (!state.configured) {
      await Promise.resolve(openNotificationSettings());
      return { ok: false, status: 'configuration_missing' };
    }

    busy = true;
    render();
    try {
      const result = await ipcRenderer.invoke('set-completion-notification-enabled', {
        enabled: !target.enabled,
        ...(target.targetType === 'meeting'
          ? { meetingId: target.targetId }
          : { sessionId: target.targetId }),
      });
      if (result && result.ok) {
        const latest = currentTarget();
        if (latest && latest.targetType === target.targetType && latest.targetId === target.targetId) {
          applyState({ ...result, available: true });
        } else {
          refreshTarget();
        }
      } else if (result && result.status === 'configuration_missing') {
        applyState(result);
        await Promise.resolve(openNotificationSettings());
      }
      return result;
    } catch {
      return { ok: false, status: 'ipc_failed' };
    } finally {
      busy = false;
      render();
    }
  }

  function init() {
    if (initialized || !button) return;
    initialized = true;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggle();
    });
    if (typeof ipcRenderer.on === 'function') {
      ipcRenderer.on('completion-notification-config-changed', (_event, payload) => {
        const configured = !!(payload && (
          payload.configured
          || payload.notificationConfigured
          || payload.feishuTargetSet
        ));
        refreshTarget(configured);
      });
      ipcRenderer.on('completion-notification-target-changed', () => {
        refreshTarget();
      });
    }
    void refresh();
  }

  return {
    applyState,
    getState: () => ({ ...state }),
    init,
    refresh,
    refreshTarget,
    toggle,
  };
}

module.exports = {
  createCompletionNotificationToggle,
  normalizeToggleState,
};
