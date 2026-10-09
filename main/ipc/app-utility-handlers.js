'use strict';

const systemOs = require('os');
const { registerPreviewImmersiveIpc } = require('./preview-immersive-handlers.js');
const { createSystemTelemetry } = require('../../core/system-telemetry.js');
const { createLiveResourceTelemetry } = require('../../core/live-resource-telemetry.js');
const { createClashVergeDelayReader } = require('../../core/clash-verge-delay.js');
const { createVpnTrafficRecorder } = require('../../core/vpn-traffic-recorder.js');

function readCpuTotals(osApi) {
  const cpus = osApi.cpus();
  if (!Array.isArray(cpus) || cpus.length === 0) return null;

  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu && cpu.times;
    if (!times) continue;
    const values = Object.values(times).filter(Number.isFinite);
    idle += Number.isFinite(times.idle) ? times.idle : 0;
    total += values.reduce((sum, value) => sum + value, 0);
  }
  return total > 0 ? { idle, total } : null;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function createSystemResourceSampler(osApi = systemOs) {
  let previousCpu = readCpuTotals(osApi);

  return function sampleSystemResourceUsage() {
    const currentCpu = readCpuTotals(osApi);
    let cpuPct = null;
    if (previousCpu && currentCpu) {
      const totalDelta = currentCpu.total - previousCpu.total;
      const idleDelta = currentCpu.idle - previousCpu.idle;
      if (totalDelta > 0) cpuPct = clampPercent((1 - Math.max(0, idleDelta) / totalDelta) * 100);
    }
    previousCpu = currentCpu;

    const totalMemory = osApi.totalmem();
    const freeMemory = osApi.freemem();
    const memoryPct = totalMemory > 0
      ? clampPercent((1 - freeMemory / totalMemory) * 100)
      : null;

    return { cpuPct, memoryPct, sampledAt: Date.now() };
  };
}

function saveClipboardImage(deps) {
  const {
    clipboard,
    crypto,
    fs,
    imageDir,
    logger = console,
    path,
  } = deps;

  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;

    fs.mkdirSync(imageDir, { recursive: true });

    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const id = crypto.randomBytes(3).toString('hex');
    const filename = `${timestamp}-${id}.png`;
    const filePath = path.join(imageDir, filename);

    fs.writeFileSync(filePath, image.toPNG());
    return filePath;
  } catch (err) {
    logger.warn('[群聊] save-clipboard-image failed:', err.message);
    return null;
  }
}

function registerAppUtilityIpc(ipcMain, deps) {
  registerPreviewImmersiveIpc(ipcMain, deps);
  const sampleSystemResourceUsage = createSystemResourceSampler(deps.os || systemOs);
  const systemTelemetry = deps.systemTelemetry || createSystemTelemetry();
  const clashDelay = deps.clashDelay || createClashVergeDelayReader();
  const liveTelemetry = deps.liveTelemetry || createLiveResourceTelemetry();
  ipcMain.handle('get-network-transfer-usage', () => liveTelemetry.sampleNetwork());
  ipcMain.handle('get-resource-top-processes', () => liveTelemetry.sampleProcesses());

  ipcMain.handle('is-window-focused', () => {
    const mainWindow = deps.getMainWindow();
    return mainWindow ? mainWindow.isFocused() : false;
  });

  ipcMain.handle('save-clipboard-image', () => {
    return saveClipboardImage(deps);
  });

  ipcMain.handle('get-hook-status', () => ({
    up: deps.getHookPort() !== null,
    port: deps.getHookPort(),
  }));

  ipcMain.handle('get-system-resource-usage', async (_event, options = {}) => {
    const coreUsage = sampleSystemResourceUsage();
    // Reuse the bounded GPU (10 s) and disk (60 s) caches for the compact footer.
    if (options.extended === false) {
      const [gpu, disk] = await Promise.allSettled([
        systemTelemetry.sampleGpu?.(), systemTelemetry.sampleDisk?.(),
      ]);
      return { ...coreUsage, gpu: gpu.status === 'fulfilled' ? gpu.value || null : null,
        disk: disk.status === 'fulfilled' ? disk.value || null : null };
    }
    try {
      const extended = await systemTelemetry.sample({ force: options && options.force === true });
      return { ...coreUsage, ...extended };
    } catch {
      return coreUsage;
    }
  });

  ipcMain.handle('get-clash-proxy-delay', () => clashDelay.sample());

  // VPN 流量账本：只有传入数据目录时才启动（单测注册 IPC 时不起后台轮询）。
  const vpnTraffic = deps.vpnTraffic
    || (deps.vpnTrafficDir ? createVpnTrafficRecorder({ dir: deps.vpnTrafficDir }) : null);
  if (vpnTraffic && !deps.vpnTraffic) {
    vpnTraffic.start();
    deps.app?.on?.('will-quit', () => vpnTraffic.stop());
  }
  ipcMain.handle('get-vpn-traffic-report', (_event, options = {}) => {
    if (!vpnTraffic) return { status: { recording: false, holder: 'none', error: 'recorder-disabled' } };
    return vpnTraffic.report(options && options.range);
  });

  ipcMain.handle('get-network-egress-status', (_event, options = {}) => {
    if (typeof deps.getNetworkEgressStatus !== 'function') {
      return {
        checkedAt: Date.now(),
        foreign: { ok: false, route: 'proxy', errorCode: 'monitor_unavailable', error: '出口监测未启用' },
        domestic: { ok: false, route: 'direct', errorCode: 'monitor_unavailable', error: '出口监测未启用' },
        alert: { type: 'monitor_unavailable', severity: 'critical', title: '出口监测未启用' },
      };
    }
    return deps.getNetworkEgressStatus({ force: options && options.force === true });
  });

  ipcMain.handle('acknowledge-network-egress-change', () => {
    if (typeof deps.acknowledgeNetworkEgressChange !== 'function') {
      return { ok: false, error: 'monitor_unavailable' };
    }
    return deps.acknowledgeNetworkEgressChange();
  });
}

module.exports = {
  createSystemResourceSampler,
  registerAppUtilityIpc,
  saveClipboardImage,
};
