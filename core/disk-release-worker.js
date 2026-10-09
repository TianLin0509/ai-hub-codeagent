'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createDiskReleaseEngine } = require('./disk-release-engine');
const { createDiskUsageAnalyzer } = require('./disk-usage-analyzer');
const engine = createDiskReleaseEngine({ ...workerData,
  onProgress: progress => parentPort.postMessage({ progress }),
});
let lastProgress = 0;
const analyzer = createDiskUsageAnalyzer({ ...workerData, onProgress: progress => {
  if (Date.now() - lastProgress < 250) return;
  lastProgress = Date.now(); parentPort.postMessage({ progress });
} });
let running = false;
let runningMethod = null;
parentPort.on('message', async ({ id, method, request }) => {
  if (method === 'cancel') {
    if (runningMethod === 'usage') analyzer.cancel();
    else if (runningMethod === 'scan') engine.cancelScan();
    return;
  }
  if (running) { parentPort.postMessage({ id, error: '已有扫描或清理正在进行' }); return; }
  running = true; runningMethod = method;
  try {
    if (!['scan', 'execute', 'usage'].includes(method)) throw new Error('未知硬盘操作');
    const result = method === 'usage' ? await analyzer.analyze() : method === 'execute' ? await engine.execute(request) : await engine.scan();
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
  finally { running = false; runningMethod = null; }
});
