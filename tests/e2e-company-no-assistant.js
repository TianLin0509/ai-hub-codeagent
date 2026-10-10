'use strict';
// 公司版关掉助理后的真实界面回归（2026-10-10）：启动后过了助理通常的启动延迟（20 秒），
//   1. 没有建出助理会话；2. 左侧「助理」入口隐藏、主进程没有助理服务；3. 旧版本留下的助理会话不进侧栏。
// 只在 features.assistant=false 的导出目录里有意义（公司版）；其他发行版直接跳过。
//   node tests/e2e-company-no-assistant.js [--exe "<AI Hub Community.exe>"]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const exe = argv.includes('--exe') ? argv[argv.indexOf('--exe') + 1] : null;
if (require('../core/distribution').featureEnabled('assistant')) {
  console.log('e2e-company-no-assistant: SKIP（本发行版开着助理）');
  process.exit(0);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-no-assistant-'));
  const hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), label: 'no-assistant', windowMode: 'background',
    ...(exe ? { executablePath: exe } : {}), extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '' } });
  const c = await connectFirstPage(hub);
  try {
    for (let i = 0; i < 150 && !(await c.eval('typeof sessions !== "undefined" && typeof renderSessionList === "function"').catch(() => false)); i++) await sleep(400);
    await sleep(30000);
    const created = await c.eval(`ipcRenderer.invoke('get-sessions').then(list => list.filter(s => s.purpose === 'hub-assistant').length)`);
    assert.strictEqual(created, 0, '启动 30 秒内不应建出助理会话');
    const navHidden = await c.eval(`(() => { const b = document.getElementById('btn-assistant'); return !b || getComputedStyle(b).display === 'none'; })()`);
    assert.strictEqual(navHidden, true, '左侧「助理」入口应隐藏');
    const service = await c.eval(`ipcRenderer.invoke('assistant:get-overview').then(() => 'registered', e => String(e && e.message || e))`);
    assert.notStrictEqual(service, 'registered', '主进程不应注册助理服务');
    // 旧版本留下的助理会话：塞一条进界面数据，重画侧栏后不应出现。
    const shown = await c.eval(`(() => { sessions.set('old-assistant', { id: 'old-assistant', kind: 'claude', purpose: 'hub-assistant', title: 'AI Hub 助理 · Claude', status: 'dormant', createdAt: Date.now() });
      renderSessionList(); return !!document.querySelector('.session-item[data-session-id="old-assistant"]'); })()`);
    assert.strictEqual(shown, false, '旧助理会话不应出现在侧栏');
    console.log(JSON.stringify({ created, navHidden, service: service.slice(0, 80), oldSessionShown: shown }));
    console.log('e2e-company-no-assistant: OK');
  } finally {
    try { c.close(); } catch {}
    await gracefulQuit(hub).catch(() => {});
  }
  setTimeout(() => process.exit(0), 300);
})().catch(error => { console.error(error); process.exit(1); });
