'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const DEFAULT_CACHE_MS = 60 * 1000;
const DEFAULT_FAILURE_CACHE_MS = 5 * 1000;
const DEFAULT_TIMEOUT_MS = 12 * 1000;
const DEFAULT_TRANSIENT_FAILURE_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_FAILURE_CONFIRMATIONS = 2;
const DEFAULT_ENDPOINTS = [
  { name: 'geojs', url: 'https://get.geojs.io/v1/ip/geo.json' },
  { name: 'ipwhois', url: 'https://ipwho.is/' },
  { name: 'ipinfo', url: 'https://ipinfo.io/json' },
];

const CITY_ZH = new Map([
  ['beijing', '北京'],
  ['chengdu', '成都'],
  ['guangzhou', '广州'],
  ['hangzhou', '杭州'],
  ['hong kong', '香港'],
  ['los angeles', '洛杉矶'],
  ['new york', '纽约'],
  ['san francisco', '旧金山'],
  ['seattle', '西雅图'],
  ['shanghai', '上海'],
  ['shenzhen', '深圳'],
  ['singapore', '新加坡'],
  ['taipei', '台北'],
  ['tokyo', '东京'],
  ['washington', '华盛顿'],
]);

function countryNameZh(countryCode, fallback) {
  const code = String(countryCode || '').trim().toUpperCase();
  if (code) {
    try {
      const displayNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
      const localized = displayNames.of(code);
      if (localized && localized !== code) return localized;
    } catch {}
  }
  return String(fallback || code || '').trim();
}

function cityNameZh(city) {
  const value = String(city || '').trim();
  return CITY_ZH.get(value.toLowerCase()) || value;
}

function locationLabel(countryCode, country, city) {
  const countryLabel = countryNameZh(countryCode, country);
  const cityLabel = cityNameZh(city);
  if (countryLabel && cityLabel && countryLabel !== cityLabel) return `${countryLabel}·${cityLabel}`;
  return countryLabel || cityLabel || '未知地区';
}

function safeProxyEndpoint(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value.includes('://') ? value : `http://${value}`);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return value
      .replace(/^[a-z0-9+.-]+:\/\//i, '')
      .replace(/^[^@/]*@/, '')
      .split('/')[0];
  }
}

function normalizeGeoPayload(payload, source = 'unknown') {
  if (!payload || typeof payload !== 'object') throw new Error('invalid_geo_payload');
  if (payload.success === false || payload.status === 'fail' || payload.error === true) {
    throw new Error('geo_provider_rejected');
  }

  const ip = String(payload.ip || payload.query || '').trim();
  if (!net.isIP(ip)) throw new Error('invalid_geo_ip');
  const countryCode = String(payload.country_code || payload.countryCode || payload.country || '').trim().toUpperCase();
  const country = String(payload.country_name || payload.country || '').trim();
  const city = String(payload.city || '').trim();
  const region = String(payload.region_name || payload.regionName || payload.region || '').trim();
  const organization = String(
    payload.organization_name || payload.organization || payload.org || payload.isp || '',
  ).trim();
  const timezone = String(
    (payload.timezone && typeof payload.timezone === 'object' ? payload.timezone.id : payload.timezone) || '',
  ).trim();

  return {
    ok: true,
    ip,
    ipVersion: net.isIP(ip),
    city,
    cityZh: cityNameZh(city),
    region,
    country,
    countryCode,
    countryZh: countryNameZh(countryCode, country),
    locationLabel: locationLabel(countryCode, country, city),
    organization,
    timezone,
    source,
  };
}

function normalizeRouteResult(result, route, now = Date.now()) {
  if (!result || result.ok === false) {
    return {
      ok: false,
      route,
      errorCode: String(result && result.errorCode || 'probe_failed'),
      error: String(result && result.error || '出口检测失败'),
      checkedAt: Number(result && result.checkedAt) || now,
    };
  }
  const normalized = result.locationLabel && result.ip
    ? { ...result }
    : normalizeGeoPayload(result, result.source || 'probe');
  return {
    ...normalized,
    ok: true,
    route,
    checkedAt: Number(result.checkedAt) || now,
  };
}

function execFileUtf8(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function probeErrorCode(error, route) {
  if (error && error.code === 'ENOENT') return 'curl_unavailable';
  if (error && (error.killed || error.code === 'ETIMEDOUT' || error.code === 28)) return 'probe_timeout';
  if (route === 'proxy') return 'vpn_unavailable';
  return 'direct_unavailable';
}

function createCurlGeoProbe(options = {}) {
  const execFileImpl = options.execFile || childProcess.execFile;
  const endpoints = Array.isArray(options.endpoints) && options.endpoints.length
    ? options.endpoints
    : DEFAULT_ENDPOINTS;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const curlBin = options.curlBin || (process.platform === 'win32' ? 'curl.exe' : 'curl');

  return async function probeRoute({ route, proxy }) {
    const routeName = route === 'proxy' ? 'proxy' : 'direct';
    if (routeName === 'proxy' && !String(proxy || '').trim()) {
      return { ok: false, route: routeName, errorCode: 'proxy_not_configured', error: '未配置 VPN 代理' };
    }

    let lastError = null;
    for (const endpoint of endpoints) {
      const args = [
        '--silent',
        '--show-error',
        '--location',
        '--fail',
        '--ipv4',
        // A local Mihomo/Clash CONNECT can legitimately take 5-6 seconds while
        // establishing a cold upstream tunnel. The old 4-second cutoff killed
        // healthy requests before they completed and produced false VPN alarms.
        '--connect-timeout', String(Math.max(4, Math.min(8, Math.ceil(timeoutMs / 1500)))),
        '--max-time', String(Math.max(3, Math.ceil(timeoutMs / 1000))),
        '--header', 'Accept: application/json',
        '--user-agent', 'AI-Hub-Network-Monitor/1.0',
      ];
      if (routeName === 'proxy') args.push('--proxy', String(proxy));
      else args.push('--noproxy', '*');
      args.push(endpoint.url);

      try {
        const stdout = await execFileUtf8(execFileImpl, curlBin, args, {
          windowsHide: true,
          timeout: timeoutMs + 2000,
          maxBuffer: 256 * 1024,
        });
        const parsed = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        return normalizeRouteResult(normalizeGeoPayload(parsed, endpoint.name), routeName);
      } catch (error) {
        lastError = error;
      }
    }

    return {
      ok: false,
      route: routeName,
      errorCode: probeErrorCode(lastError, routeName),
      error: routeName === 'proxy' ? 'VPN 出口不可用' : '直连出口不可用',
      checkedAt: Date.now(),
    };
  };
}

function routeFingerprint(route, proxyEndpoint = '') {
  if (!route || !route.ok || !route.ip) return '';
  return JSON.stringify([
    String(proxyEndpoint || ''),
    String(route.ip || ''),
    String(route.countryCode || ''),
    String(route.region || ''),
    String(route.city || ''),
  ]);
}

function routeSnapshot(route) {
  if (!route || !route.ok) return null;
  return {
    ip: route.ip,
    city: route.city,
    cityZh: route.cityZh,
    region: route.region,
    country: route.country,
    countryCode: route.countryCode,
    countryZh: route.countryZh,
    locationLabel: route.locationLabel,
    organization: route.organization,
    timezone: route.timezone,
  };
}

function loadBaseline(fsApi, statePath) {
  if (!statePath) return null;
  try {
    const parsed = JSON.parse(fsApi.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
    const baseline = parsed && parsed.acknowledgedForeign;
    if (!baseline || typeof baseline.fingerprint !== 'string' || !baseline.route) return null;
    return baseline;
  } catch {
    return null;
  }
}

function persistBaseline(fsApi, statePath, baseline, logger = console) {
  if (!statePath || !baseline) return;
  try {
    fsApi.mkdirSync(path.dirname(statePath), { recursive: true });
    fsApi.writeFileSync(statePath, JSON.stringify({
      version: 1,
      acknowledgedForeign: baseline,
    }, null, 2), 'utf8');
  } catch (error) {
    logger.warn('[network-egress] baseline save failed:', error && error.message);
  }
}

function buildAlert(foreign, domestic, proxyEndpoint, baseline) {
  if (!proxyEndpoint) {
    return {
      type: 'proxy_not_configured',
      severity: 'critical',
      title: 'VPN 未配置',
      message: 'Claude / Codex 订阅与 Gemini 没有可用的代理出口',
      acknowledgeable: false,
    };
  }
  if (!foreign || !foreign.ok) {
    return {
      type: 'vpn_unavailable',
      severity: 'critical',
      title: 'VPN 不可用',
      message: '无法通过当前代理检测海外出口',
      acknowledgeable: false,
    };
  }
  if (domestic && domestic.ok && foreign.ip === domestic.ip) {
    return {
      type: 'vpn_bypassed',
      severity: 'critical',
      title: 'VPN 疑似未生效',
      message: '海外模型与国产模型检测到相同公网 IP',
      acknowledgeable: false,
    };
  }
  if (String(foreign.countryCode || '').toUpperCase() === 'CN') {
    return {
      type: 'vpn_cn_exit',
      severity: 'critical',
      title: 'VPN 出口仍在中国大陆',
      message: '海外模型可能无法访问其服务',
      acknowledgeable: false,
    };
  }

  const currentFingerprint = routeFingerprint(foreign, proxyEndpoint);
  if (baseline && baseline.fingerprint && baseline.fingerprint !== currentFingerprint) {
    const previous = baseline.route || {};
    const previousLabel = previous.locationLabel || previous.ip || '上一节点';
    const currentLabel = foreign.locationLabel || foreign.ip || '当前节点';
    return {
      type: 'vpn_changed',
      severity: 'warning',
      title: 'VPN 节点已变化',
      message: `${previousLabel} → ${currentLabel}`,
      previous: baseline.route,
      current: routeSnapshot(foreign),
      acknowledgeable: true,
    };
  }
  return null;
}

function createFixtureProbe(fixture = {}, now = () => Date.now()) {
  return async ({ route }) => {
    const selected = route === 'proxy' ? fixture.foreign : fixture.domestic;
    return normalizeRouteResult(selected || {
      ok: false,
      errorCode: 'fixture_missing',
      error: '测试出口未配置',
    }, route, now());
  };
}

function createNetworkEgressMonitor(options = {}) {
  const fsApi = options.fs || fs;
  const logger = options.logger || console;
  const getProxy = typeof options.getProxy === 'function' ? options.getProxy : () => '';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const cacheMs = options.cacheMs == null ? DEFAULT_CACHE_MS : Math.max(0, Number(options.cacheMs) || 0);
  const failureCacheMs = options.failureCacheMs == null
    ? DEFAULT_FAILURE_CACHE_MS
    : Math.max(0, Number(options.failureCacheMs) || 0);
  const transientFailureGraceMs = options.transientFailureGraceMs == null
    ? DEFAULT_TRANSIENT_FAILURE_GRACE_MS
    : Math.max(0, Number(options.transientFailureGraceMs) || 0);
  const failureConfirmations = options.failureConfirmations == null
    ? DEFAULT_FAILURE_CONFIRMATIONS
    : Math.max(1, Number(options.failureConfirmations) || 1);
  const statePath = options.statePath || null;
  const probe = options.probe || createCurlGeoProbe(options);
  let baseline = loadBaseline(fsApi, statePath);
  let cached = null;
  let inFlight = null;
  let lastHealthyForeign = null;
  let lastProxyEndpoint = null;
  let consecutiveForeignFailures = 0;

  function setBaseline(foreign, proxyEndpoint) {
    baseline = {
      fingerprint: routeFingerprint(foreign, proxyEndpoint),
      proxyEndpoint,
      route: routeSnapshot(foreign),
      acknowledgedAt: now(),
    };
    persistBaseline(fsApi, statePath, baseline, logger);
  }

  async function sample() {
    const checkedAt = now();
    const rawProxy = String(getProxy() || '').trim();
    const proxyEndpoint = safeProxyEndpoint(rawProxy);
    if (proxyEndpoint !== lastProxyEndpoint) {
      lastProxyEndpoint = proxyEndpoint;
      lastHealthyForeign = null;
      consecutiveForeignFailures = 0;
    }
    const [foreignResult, domesticResult] = await Promise.all([
      rawProxy
        ? Promise.resolve(probe({ route: 'proxy', proxy: rawProxy }))
        : Promise.resolve({ ok: false, errorCode: 'proxy_not_configured', error: '未配置 VPN 代理' }),
      Promise.resolve(probe({ route: 'direct', proxy: '' })),
    ]);
    let foreign = normalizeRouteResult(foreignResult, 'proxy', checkedAt);
    const domestic = normalizeRouteResult(domesticResult, 'direct', checkedAt);

    let transientProbeAlert = null;
    if (foreign.ok) {
      consecutiveForeignFailures = 0;
      lastHealthyForeign = { proxyEndpoint, checkedAt, route: { ...foreign } };
    } else {
      consecutiveForeignFailures += 1;
      const recentHealthy = lastHealthyForeign
        && lastHealthyForeign.proxyEndpoint === proxyEndpoint
        && checkedAt - lastHealthyForeign.checkedAt <= transientFailureGraceMs;
      if (recentHealthy && consecutiveForeignFailures < failureConfirmations) {
        const failedProbe = foreign;
        foreign = {
          ...lastHealthyForeign.route,
          route: 'proxy',
          checkedAt,
          stale: true,
          lastSuccessfulAt: lastHealthyForeign.checkedAt,
          probeErrorCode: failedProbe.errorCode,
          probeError: failedProbe.error,
        };
        transientProbeAlert = {
          type: 'vpn_probe_retrying',
          severity: 'warning',
          title: 'VPN 出口正在复核',
          message: '本次探测失败，暂保留最近成功结果并将在下一轮自动复核',
          acknowledgeable: false,
        };
      }
    }

    let alert = transientProbeAlert || buildAlert(foreign, domestic, proxyEndpoint, baseline);
    if (!baseline && foreign.ok && (!alert || alert.type === 'vpn_changed')) {
      setBaseline(foreign, proxyEndpoint);
      alert = buildAlert(foreign, domestic, proxyEndpoint, baseline);
    }

    cached = {
      checkedAt,
      proxyEndpoint,
      foreign,
      domestic,
      alert,
      consecutiveForeignFailures,
      baseline: baseline ? {
        proxyEndpoint: baseline.proxyEndpoint,
        route: baseline.route,
        acknowledgedAt: baseline.acknowledgedAt,
      } : null,
    };
    return cached;
  }

  async function getStatus({ force = false } = {}) {
    const shortRetry = cached && cached.alert
      && (cached.alert.type === 'vpn_unavailable' || cached.alert.type === 'vpn_probe_retrying');
    const ttl = shortRetry ? failureCacheMs : cacheMs;
    if (!force && cached && now() - cached.checkedAt < ttl) return cached;
    if (inFlight) return inFlight;
    inFlight = sample().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function acknowledgeForeignChange() {
    const status = cached || await getStatus({ force: true });
    if (!status.foreign || !status.foreign.ok || !status.alert || status.alert.type !== 'vpn_changed') {
      return { ok: false, status };
    }
    setBaseline(status.foreign, status.proxyEndpoint);
    cached = {
      ...status,
      alert: buildAlert(status.foreign, status.domestic, status.proxyEndpoint, baseline),
      baseline: {
        proxyEndpoint: baseline.proxyEndpoint,
        route: baseline.route,
        acknowledgedAt: baseline.acknowledgedAt,
      },
    };
    return { ok: true, status: cached };
  }

  return {
    getStatus,
    acknowledgeForeignChange,
    getBaseline: () => baseline,
  };
}

module.exports = {
  DEFAULT_FAILURE_CACHE_MS,
  DEFAULT_TRANSIENT_FAILURE_GRACE_MS,
  DEFAULT_ENDPOINTS,
  buildAlert,
  cityNameZh,
  countryNameZh,
  createCurlGeoProbe,
  createFixtureProbe,
  createNetworkEgressMonitor,
  locationLabel,
  normalizeGeoPayload,
  normalizeRouteResult,
  routeFingerprint,
  safeProxyEndpoint,
};
