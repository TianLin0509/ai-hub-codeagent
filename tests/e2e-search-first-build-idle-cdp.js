'use strict';
// 昨日之我第一次全量建索引等电脑空闲再开始（core/session-search-first-build.js，2026-10-14 公司新装电脑先卡后黑屏）。
//   A. 电脑一直有人在用（闲置门槛设成很大）：后台不建索引，日志记「等空闲」；用户自己打开昨日之我搜索，照样立即建好、
//      搜得到，建好后留标记、日志记下建索引的阶段和建好那一刻。
//   B. 同一个数据目录重开：已经建好过，不再等空闲。
//   C. 新数据目录、电脑闲着（门槛 1 秒）：不用任何操作，后台自己开始建并建好。
// 隔离 Hub、合成的 Codex 记录、真实鼠标键盘操作搜索框；不调模型。
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const wait = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(label, read, ms = 45000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await read(); if (v) return v; await wait(200); } throw Error('Timeout: ' + label); }
async function click(c, selector) { const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Control not clickable');return {x,y}})()`); for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); }
async function query(c, text) { await click(c, '#search-query'); await c.send('Input.insertText', { text }); }

function fixture(root) {
  const home = path.join(root, 'home');
  const codexRoot = path.join(home, 'codex', 'sessions');
  const dir = path.join(codexRoot, '2026', '10', '14');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    const sid = `019d3333-3333-7333-8333-33333333333${i}`;
    const rows = [
      { type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: sid, cwd: root, source: 'cli' } },
      { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message: `FIRSTBUILD_MARK 第 ${i} 个问题` } },
      { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', last_agent_message: `FIRSTBUILD_MARK 第 ${i} 个回答` } },
    ];
    fs.writeFileSync(path.join(dir, `rollout-${sid}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  return { home, codexRoot };
}

async function launch(root, data, home, codexRoot, idleSec, label) {
  const hub = await launchIsolatedHub({ dataDir: data, port: await port(), label, extraEnv: {
    CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: home, HOME: home, USERPROFILE: home,
    HUB_SESSION_SEARCH_PREWARM: '1', HUB_SESSION_SEARCH_PREWARM_DELAY_MS: '250', HUB_SESSION_SEARCH_IDLE_GAP_MS: '0',
    HUB_SESSION_SEARCH_FIRST_BUILD_IDLE_SEC: String(idleSec),
    HUB_SESSION_SEARCH_CODEX_ROOTS: codexRoot, HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(home, 'claude'),
    HUB_SESSION_SEARCH_KIMI_ROOTS: path.join(home, 'kimi'), HUB_SESSION_SEARCH_GEMINI_ROOTS: path.join(home, 'gemini'),
  } });
  const c = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url));
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 960, deviceScaleFactor: 1, mobile: false });
  await until('renderer ready', () => c.eval('typeof sessions!=="undefined" && !!window.__hubE2E?.globalSessionSearch').catch(() => false), 60000);
  return { hub, c };
}

(async () => {
  const passed = [];
  const ok = (cond, label, detail) => { assert.ok(cond, label + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); passed.push(label); console.log('  ✓ ' + label); };
  let hub = null, c = null;
  const stop = async () => { try { c && c.close(); } catch {} c = null; if (hub) await gracefulQuit(hub).catch(e => console.warn('quit:', e.message)); hub = null; };
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-first-build-'));
    const data = path.join(root, 'data');
    const { home, codexRoot } = fixture(root);
    const logFile = path.join(data, 'logs', 'window-events.log');
    const marker = path.join(data, 'cache', 'session-search-first-build.json');
    const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
    const count = re => (readLog().match(re) || []).length;

    // A. 一直有人在用电脑。
    ({ hub, c } = await launch(root, data, home, codexRoot, 100000, 'search-first-build-busy'));
    await until('wait-idle logged', () => / search-index-wait-idle /.test(readLog()), 30000);
    await wait(6000);
    const held = await c.eval("ipcRenderer.invoke('get-session-search-status')");
    ok(!/ search-index-first-build-start /.test(readLog()) && !fs.existsSync(marker) && !(held.index && held.index.sessions), '有人在用电脑时，后台不开始第一次建索引（日志记「等空闲」）', { held: held.index, phase: held.phase });

    await click(c, '#btn-global-search');
    await query(c, 'FIRSTBUILD_MARK');
    const s = await until('search results', async () => { const st = await c.eval('window.__hubE2E.globalSessionSearch.state()'); return st.state === 'complete' && st.totalSessions === 3 && st; }, 60000);
    ok(s.totalSessions === 3, '用户自己打开昨日之我搜索，照样立即建好、搜到 3 个会话');
    await until('marker', () => fs.existsSync(marker), 30000);
    ok(/ search-index \{[^\n]*"ready":true/.test(readLog()), '建好那一刻写进窗口日志，并留下「第一次已建好」标记');
    await until('waiter released', () => / search-index-first-build-start \{[^\n]*"by":"user-search"/.test(readLog()), 30000);
    ok(true, '用户搜索建好后，等空闲的后台任务随即放行');
    await stop();

    // B. 同一个数据目录重开：不再等空闲。
    const waitsBefore = count(/ search-index-wait-idle /g);
    ({ hub, c } = await launch(root, data, home, codexRoot, 100000, 'search-first-build-again'));
    await wait(8000);
    ok(count(/ search-index-wait-idle /g) === waitsBefore, '已经建好过的电脑重开 Hub，不再等空闲');
    await stop();

    // C. 新数据目录，电脑闲着（门槛 1 秒）。
    const data2 = path.join(root, 'data2');
    const log2 = path.join(data2, 'logs', 'window-events.log');
    const read2 = () => { try { return fs.readFileSync(log2, 'utf8'); } catch { return ''; } };
    ({ hub, c } = await launch(root, data2, home, codexRoot, 1, 'search-first-build-idle'));
    const started = (await until('first build start', () => read2().match(/ search-index-first-build-start (\{.*\})/), 120000))[1];
    await until('ready', () => fs.existsSync(path.join(data2, 'cache', 'session-search-first-build.json')), 60000);
    const st2 = await c.eval("ipcRenderer.invoke('get-session-search-status')");
    ok(st2.index.sessions === 3, '电脑闲着时，后台自己开始并建好第一次索引（3 个会话）', { started: JSON.parse(started), index: st2.index });
    console.log(`\nPASS ${passed.length} checks`);
  } catch (error) {
    console.error('FAIL', error && error.stack || error);
    process.exitCode = 1;
  } finally { await stop(); }
})();
