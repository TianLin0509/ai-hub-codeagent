'use strict';

const DEFAULT_ALIYUN_MONITOR = Object.freeze({
  enabled: false,
  label: '阿里云服务器',
  healthUrl: '',
  metricsUrl: '',
  bearerToken: '',
});

function cleanUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeAliyunMonitor(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const healthUrl = cleanUrl(source.healthUrl ?? source.health_url);
  const metricsUrl = cleanUrl(source.metricsUrl ?? source.metrics_url);
  return {
    enabled: source.enabled === true,
    label: String(source.label || DEFAULT_ALIYUN_MONITOR.label).trim().slice(0, 48)
      || DEFAULT_ALIYUN_MONITOR.label,
    healthUrl,
    metricsUrl,
    bearerToken: String(source.bearerToken ?? source.bearer_token ?? '').trim(),
  };
}

function normalizeOperationsConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    aliyunMonitor: normalizeAliyunMonitor(source.aliyunMonitor ?? source.aliyun_monitor),
    restoreRoot: String(source.restoreRoot ?? source.restore_root ?? '').trim(),
  };
}

function serializeOperationsConfig(existing = {}, update = {}) {
  const previous = normalizeOperationsConfig(existing);
  const nextMonitor = normalizeAliyunMonitor({
    ...previous.aliyunMonitor,
    ...(update.aliyunMonitor || {}),
  });
  const restoreRoot = Object.prototype.hasOwnProperty.call(update, 'restoreRoot')
    ? String(update.restoreRoot || '').trim()
    : previous.restoreRoot;
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    aliyun_monitor: {
      enabled: nextMonitor.enabled,
      label: nextMonitor.label,
      health_url: nextMonitor.healthUrl || undefined,
      metrics_url: nextMonitor.metricsUrl || undefined,
      bearer_token: nextMonitor.bearerToken || undefined,
    },
    restore_root: restoreRoot || undefined,
  };
}

module.exports = {
  DEFAULT_ALIYUN_MONITOR,
  cleanUrl,
  normalizeAliyunMonitor,
  normalizeOperationsConfig,
  serializeOperationsConfig,
};
