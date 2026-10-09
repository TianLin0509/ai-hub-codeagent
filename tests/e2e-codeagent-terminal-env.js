'use strict';
// 公司真机（2026-10-09）两处问题的隔离实例回归：
//   1. 关闭显卡加速（兼容渲染）时，Canvas 终端渲染会让整个页面停止重绘 —— 终端必须默认用 DOM；
//      显卡正常时仍用 Canvas。
//   2. Code Agent 的界面框架看 WT_SESSION 判断「推荐终端」—— Hub 给 Code Agent 会话补上占位值。
// 用一个冒充 codeagent 的小脚本打印它收到的环境变量，不需要真 CLI。
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const fixture = path.join(__dirname, 'fixtures', 'codeagent-env-echo.cmd');

async function run(label, { gpuDisabled }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hub-termenv-${label}-`));
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  const hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), label, windowMode: 'background',
    extraEnv: { AI_HUB_CODEAGENT_COMMAND: fixture, AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'cac'), CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
      WT_SESSION: '', ...(gpuDisabled ? { AI_HUB_DISABLE_GPU: '1' } : {}) } });
  const c = await connectFirstPage(hub);
  try {
    for (let i = 0; i < 150 && !(await c.eval('typeof sessions !== "undefined" && typeof selectSession === "function"').catch(() => false)); i++) await sleep(400);
    const flag = await c.eval(`process.argv.includes('--ai-hub-gpu-disabled')`);
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work } })})`);
    let raw = '';
    for (let i = 0; i < 60 && !/CODEAGENT-ENV/.test(raw); i++) { await sleep(500); raw = String(await c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${j(created.id)})`) || ''); }
    const env = (raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').match(/CODEAGENT-ENV WT_SESSION=\[([^\]]*)\]/) || [])[1];
    await c.eval(`selectSession(${j(created.id)})`); await sleep(500);
    await c.eval(`applyViewMode('pty')`); await sleep(1500);
    const mode = await c.eval(`terminalCache.get(${j(created.id)})?._rendererMode || null`);
    // 页面还在重绘：两次 requestAnimationFrame 都能回来。
    const frames = await c.eval(`new Promise(r => { let n = 0; const t = setTimeout(() => r(n), 2000); const f = () => { n++; if (n >= 10) { clearTimeout(t); r(n); } else requestAnimationFrame(f); }; requestAnimationFrame(f); })`);
    await c.eval(`applyViewMode('card')`);
    return { label, flag, env, mode, frames };
  } finally {
    try { c.close(); } catch {}
    await gracefulQuit(hub).catch(() => {});
  }
}

(async () => {
  const off = await run('gpu-off', { gpuDisabled: true });
  const on = await run('gpu-on', { gpuDisabled: false });
  console.log(JSON.stringify({ off, on }, null, 2));
  assert.strictEqual(off.flag, true, '关闭显卡加速时界面进程要收到 --ai-hub-gpu-disabled');
  assert.strictEqual(off.mode, 'dom', '关闭显卡加速时终端用 DOM 渲染');
  assert.strictEqual(on.flag, false, '显卡正常时不带这个参数');
  assert.strictEqual(on.mode, 'canvas', '显卡正常时终端仍用 Canvas');
  for (const r of [off, on]) {
    assert.strictEqual(r.env, 'ai-hub', `${r.label}：Code Agent 会话拿到 WT_SESSION 占位值`);
    assert.ok(r.frames >= 10, `${r.label}：切到终端后页面仍在重绘`);
  }
  console.log('e2e-codeagent-terminal-env: OK');
  setTimeout(() => process.exit(0), 300);
})().catch(error => { console.error(error); process.exit(1); });
