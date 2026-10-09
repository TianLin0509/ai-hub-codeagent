'use strict';
// CodeAgent 真机验收：在装有公司 Code Agent CLI 的电脑上，启动已安装的 AI Hub（隔离数据目录），
// 用真实 CLI 和真实账号逐项验证最容易出错的链路，输出 report.md / report.json 与每步截图。
//
//   node tests/acceptance-codeagent-real.js --exe "<AI Hub Community.exe 的完整路径>" [--skip-group] [--model MiniMax-M2.7]
//
// 只用 Node 自带模块和随包的 ws。Hub 的状态回报会合并进真实的 Code Agent 配置目录（默认 ~/.cac/settings.json），
// 这是正常使用时也会发生的；其他工具的条目不受影响。每一步独立判定，某步失败后后续步骤照常尝试。
// 发送的都是极短测试消息；工作目录在系统临时目录下，结束后保留供查看。
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const exe = arg('--exe') || process.env.AI_HUB_EXE || '';
const skipGroup = argv.includes('--skip-group');
// --steps 01,03,04,11：只跑这些步骤（排查单项问题用）；未列出的步骤记为跳过。
const onlySteps = arg('--steps') ? new Set(arg('--steps').split(',').map(s => s.trim())) : null;
const secondModel = arg('--model') || 'MiniMax-M2.7';
const home = process.env.USERPROFILE || os.homedir();
// 在 Code Agent 自己的会话里运行本脚本时，会继承「当前会话」的变量；嵌套启动的 CLI 不能带着它们
// （2026-10-08 公司第二轮实测：清掉这些后嵌套启动正常，登录走 .credentials.json）。
for (const key of Object.keys(process.env)) {
  if (/^CODEAGENT_HUB_/.test(key) || ['CODEAGENT3_LAUNCHER_PID', 'CODEAGENT3_X_AUTH_TOKEN'].includes(key)) delete process.env[key];
}
const configDir = path.resolve(process.env.AI_HUB_CODEAGENT_CONFIG_DIR || process.env.CODEAGENT3_CONFIG_DIR || path.join(home, '.cac'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-acceptance-'));
const out = path.join(root, 'report');
fs.mkdirSync(out, { recursive: true });
const j = JSON.stringify;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const READY = String.raw`Anything I can assist you with|bypass permissions on \(`;
const BLOCKING = String.raw`版本更新提醒|Quick safety check|Yes, I trust this folder|Bypass Permissions mode`;

const report = { startedAt: new Date().toISOString(), exe, configDir, root, steps: [], facts: {} };
let hub = null, c = null;
const ctx = {};

function redact(text) {
  return String(text || '').split(home).join('%USERPROFILE%').replace(/https?:\/\/[^\s'"]+/g, '<URL>');
}
async function step(id, title, fn, { needs = [] } = {}) {
  const entry = { id, title, status: 'running', evidence: [] };
  report.steps.push(entry);
  if (onlySteps && !onlySteps.has(id)) { entry.status = 'skipped'; entry.evidence.push('未在 --steps 中'); print(entry); return; }
  const missing = needs.filter(n => !ctx[n]);
  if (missing.length) { entry.status = 'skipped'; entry.evidence.push('前置条件未满足：' + missing.join(', ')); print(entry); return; }
  const t0 = Date.now();
  try {
    await fn(note => entry.evidence.push(redact(note)));
    entry.status = 'pass';
  } catch (error) {
    entry.status = 'fail';
    entry.error = redact(error && error.message || String(error)).slice(0, 1500);
    try { if (c) entry.evidence.push('失败时屏幕：' + redact(await activeScreenTail(ctx.focusSid, 25))); } catch {}
  }
  entry.seconds = Math.round((Date.now() - t0) / 100) / 10;
  try { if (c) await shot(id); } catch {}
  print(entry);
}
function print(entry) {
  const mark = { pass: '通过', fail: '不通过', skipped: '跳过' }[entry.status] || entry.status;
  console.log(`[${mark}] ${entry.id} ${entry.title}${entry.seconds != null ? ` (${entry.seconds}s)` : ''}${entry.error ? ' — ' + entry.error.split('\n')[0] : ''}`);
}
async function shot(name) {
  const s = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64'));
}
async function until(expr, label, ms = 180000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try { if (await c.eval(expr)) return; } catch (error) { last = error; }
    await sleep(400);
  }
  throw new Error('超时：' + label + (last ? '（' + last.message + '）' : ''));
}
const bufferExpr = (sid, which) => `(() => { const t = terminalCache.get(${j(sid)})?.terminal; if (!t) return ''; const b = t.buffer.${which}; let x = ''; for (let i = 0; i < b.length; i++) x += (b.getLine(i)?.translateToString(true) || '') + '\\n'; return x; })()`;
// 终端内容：界面打开过的会话从终端模拟器读；群聊成员等没在界面打开的，从主进程取原始输出再去掉控制序列。
async function activeScreenTail(sid, lines = 20) {
  if (!sid) return '';
  let text = await c.eval(bufferExpr(sid, 'active'));
  if (!text.trim()) {
    const raw = String(await c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${j(sid)})`) || '');
    text = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\r/g, '\n');
  }
  return text.split('\n').filter(l => l.trim()).slice(-lines).join('\n');
}
const alertText = () => c.eval(`(document.body.innerText.match(/(?:会话恢复失败|操作未完成)[^\\n]*(?:\\n[^\\n]*){0,2}/) || [''])[0]`);
// 启动命令敲在 PowerShell 里：界面终端只回放当前画面时看不到它（终端藏在卡片后面的优化之后），
// 所以同时核对主进程保存的完整原始输出（去掉控制序列）。
async function normalCompact(sid) {
  const shown = await c.eval(bufferExpr(sid, 'normal'));
  const raw = String(await c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${j(sid)})`).catch(() => '') || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
  return (shown + raw).replace(/\s+/g, '');
}
async function openTerminal(sid) { await c.eval(`selectSession(${j(sid)})`); await sleep(500); await c.eval(`applyViewMode('pty')`); }
async function waitTui(sid, label) {
  await openTerminal(sid);
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const screen = await c.eval(bufferExpr(sid, 'active'));
    if (new RegExp(BLOCKING).test(screen.split('\n').slice(-40).join('\n')) && !new RegExp(READY).test(screen.split('\n').slice(-6).join('\n'))) {
      await sleep(4000);
      const again = await c.eval(bufferExpr(sid, 'active'));
      if (new RegExp(BLOCKING).test(again.split('\n').slice(-40).join('\n')) && !new RegExp(READY).test(again)) {
        throw new Error(label + '：CLI 停在弹窗上，Hub 不能代为确认。屏幕：\n' + again.split('\n').filter(l => l.trim()).slice(-20).join('\n'));
      }
    }
    if (new RegExp(READY).test(screen)) { await sleep(1500); return; }
    await sleep(700);
  }
  throw new Error(label + '：3 分钟内没有出现 Code Agent 的输入框');
}
async function sendAndWait(sid, text, mustContain, label, ms = 300000) {
  await c.eval(`applyViewMode('card')`);
  const t0 = Date.now();
  const result = await c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: sid, text })})`);
  if (!result || result.ok === false) throw new Error(label + '：发送没有被确认：' + j(result));
  await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state === 'completed'`, label + ' 完成状态', ms);
  await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes(${j(mustContain)})`, label + ' 卡片显示回答', 60000);
  return { seconds: Math.round((Date.now() - t0) / 1000), acknowledgement: result.acknowledgementSource || result.sendStatus || null, enterAttempts: result.enterAttempts };
}
const sessionInfo = sid => c.eval(`(() => { const s = sessions.get(${j(sid)}); return s && { kind: s.kind, status: s.status, cc: s.ccSessionId || null, transcript: s.transcriptPath || null, title: s.title, model: s.currentModel && s.currentModel.id }; })()`);
function hookEntries() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
    const hooks = settings.hooks || {};
    const all = Object.entries(hooks).flatMap(([event, groups]) => (groups || []).flatMap(g => (g.hooks || []).map(h => ({ event, command: String(h.command || '') }))));
    return { keys: Object.keys(settings).sort(), foreign: all.filter(h => !/session-hub-hook/.test(h.command)), hub: all.filter(h => /session-hub-hook/.test(h.command)) };
  } catch (error) { return { error: error.message }; }
}
async function launch(label) {
  hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), executablePath: exe, windowMode: 'background', label,
    extraEnv: { AI_HUB_CODEAGENT_CONFIG_DIR: configDir, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      ...(process.env.AI_HUB_CODEAGENT_COMMAND ? { AI_HUB_CODEAGENT_COMMAND: process.env.AI_HUB_CODEAGENT_COMMAND } : {}) } });
  c = await connectFirstPage(hub);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await until('typeof sessions !== "undefined" && typeof selectSession === "function"', 'Hub 界面加载', 60000);
}
async function quit() {
  if (c) { try { c.close(); } catch {} c = null; }
  if (hub) { try { report.facts['exit-' + hub.label] = await gracefulQuit(hub); } catch (error) { report.facts['exitError-' + hub.label] = error.message; } hub = null; }
}
function transcriptUserTexts(file) {
  const texts = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'user' || !r.message) continue;
    let content = r.message.content;
    if (Array.isArray(content)) { if (content.some(x => x && x.type === 'tool_result')) continue; content = content.filter(x => x && x.type === 'text').map(x => x.text).join('\n'); }
    if (typeof content === 'string') texts.push(content);
  }
  return texts;
}

async function main() {
  if (!exe || !fs.existsSync(exe)) throw new Error('请用 --exe 指定已安装的「AI Hub Community.exe」完整路径（安装回执 JSON 的 executable）');
  const cliCommand = process.env.AI_HUB_CODEAGENT_COMMAND || 'codeagent';
  const version = spawnSync('cmd.exe', ['/d', '/c', `chcp 65001>nul & ${/\s/.test(cliCommand) ? `"${cliCommand}"` : cliCommand} --version`],
    { encoding: 'utf8', windowsHide: true, timeout: 60000, windowsVerbatimArguments: true });
  report.facts.codeagentVersion = redact((version.stdout || version.stderr || '').trim()).slice(0, 200);
  report.facts.node = process.version;
  const before = hookEntries();
  report.facts.settingsBefore = { keys: before.keys, foreignHooks: before.foreign && before.foreign.length, hubHooks: before.hub && before.hub.length, error: before.error };
  const workA = path.join(root, 'work-a');
  const workGroup = path.join(root, 'work-group');
  for (const d of [workA, workGroup]) fs.mkdirSync(d, { recursive: true });

  await step('01', '启动 Hub，状态回报合并进 Code Agent 配置，其他工具的条目不变', async note => {
    await launch('acceptance-1');
    report.facts.windowTitleVersion = await c.eval('document.title');
    const after = hookEntries();
    if (after.error) throw new Error('读取 settings.json 失败：' + after.error);
    note(`其他工具的 hook 条目：之前 ${before.foreign.length}，之后 ${after.foreign.length}；Hub 条目 ${after.hub.length}（事件：${[...new Set(after.hub.map(h => h.event))].join(', ')}）`);
    if (after.foreign.length !== before.foreign.length) throw new Error('其他工具的 hook 条目数量变了');
    const removed = before.foreign.filter(h => !after.foreign.some(x => x.event === h.event && x.command === h.command));
    if (removed.length) throw new Error('有其他工具的 hook 被改动：' + removed.map(h => h.event).join(', '));
    if (!after.hub.some(h => h.event === 'Stop') || !after.hub.some(h => h.event === 'UserPromptSubmit')) throw new Error('Hub 的 Stop / UserPromptSubmit 条目没有写入');
    const addedKeys = after.keys.filter(k => !before.keys.includes(k) && k !== 'hooks');
    if (addedKeys.length) throw new Error('settings.json 被新增了字段：' + addedKeys.join(', '));
    ctx.hub = true;
  });

  await step('02', '首页「连接你的 AI」检测到 CodeAgent', async note => {
    await c.eval(`document.querySelector('[data-rail-view="home"], #btn-rail-home')?.click()`);
    await until(`[...document.querySelectorAll('.community-provider')].some(e => /CodeAgent/.test(e.textContent))`, '首页检测列表', 30000);
    const text = await c.eval(`[...document.querySelectorAll('.community-provider')].map(e => e.textContent.trim()).join(' | ')`);
    note('检测结果：' + text);
    if (!/CodeAgent[^|]*已安装/.test(text)) throw new Error('CodeAgent 没有显示为已安装');
  }, { needs: ['hub'] });

  await step('03', '新建 CodeAgent 会话：启动命令正确，没有被弹窗挡住', async note => {
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: workA, effort: 'low' } })})`);
    ctx.a = created.id; ctx.focusSid = ctx.a;
    note(`会话：${created.title}，模型 ${created.currentModel && created.currentModel.id}`);
    await until(`!!document.querySelector('.session-item[data-session-id="${ctx.a}"]')`, '侧栏出现会话', 30000);
    await waitTui(ctx.a, '首次启动');
    const typed = await normalCompact(ctx.a);
    if (!/--disable-update--skip-safe-check--modelGLM-5\.2-WX-Auto--effortlow--permission-modebypassPermissions/.test(typed)) throw new Error('终端里没找到预期的启动参数：' + typed.slice(-300));
    if (/--session-id/.test(typed)) throw new Error('启动命令里出现了 --session-id');
    note('启动参数正确：--disable-update --skip-safe-check --model GLM-5.2-WX-Auto --effort low --permission-mode bypassPermissions');
  }, { needs: ['hub'] });

  await step('04', '第一轮：卡片显示回答并进入完成状态，原生会话身份正确绑定', async note => {
    const r = await sendAndWait(ctx.a, '只回复 ACCEPT-1 这几个字符，不要做别的事。', 'ACCEPT-1', '第一轮');
    note(`从发送到完成 ${r.seconds}s；提交确认来源 ${r.acknowledgement}，回车次数 ${r.enterAttempts}`);
    const info = await sessionInfo(ctx.a);
    note(`原生会话 ${info.cc}；记录 ${info.transcript}`);
    if (!/^[0-9a-f-]{36}$/.test(String(info.cc))) throw new Error('没有绑定原生会话 ID');
    if (!info.transcript || path.basename(info.transcript, '.jsonl') !== info.cc) throw new Error('记录文件名与原生会话 ID 不一致');
    if (!fs.existsSync(info.transcript)) throw new Error('记录文件不存在');
    ctx.cc = info.cc; ctx.transcript = info.transcript; ctx.turn1 = true;
  }, { needs: ['a'] });

  await step('05', '卡片视图重新加载：切到别的会话再切回、终端视图与卡片视图来回切换', async note => {
    const other = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'powershell', opts: { cwd: workA } })})`);
    ctx.ps = other.id;
    await c.eval(`selectSession(${j(ctx.ps)})`); await sleep(1500);
    await c.eval(`selectSession(${j(ctx.a)})`); await c.eval(`applyViewMode('card')`);
    await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes('ACCEPT-1')`, '切回后卡片重新显示第一轮', 30000);
    await c.eval(`applyViewMode('pty')`); await sleep(1200); await c.eval(`applyViewMode('card')`);
    await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes('ACCEPT-1')`, '视图来回切换后卡片仍在', 30000);
    const cards = await c.eval(`document.querySelectorAll('#msg-overlay .turn-card').length`);
    note(`切回后卡片数 ${cards}`);
    if (cards > 2) throw new Error('卡片出现重复：' + cards);
  }, { needs: ['turn1'] });

  await step('06', '带工具调用的一轮：执行命令后回答出现在卡片里', async note => {
    const r = await sendAndWait(ctx.a, '请运行命令 cmd /c echo HUBTOOL-42 ，然后只回复命令输出的那一行。', 'HUBTOOL-42', '工具调用轮');
    note(`用时 ${r.seconds}s`);
    const tools = fs.readFileSync(ctx.transcript, 'utf8').split('\n').filter(l => l.includes('"tool_use"')).length;
    note(`记录里工具调用条数 ${tools}`);
    if (!tools) throw new Error('记录里没有工具调用（模型可能没有实际执行命令）');
  }, { needs: ['turn1'] });

  await step('07', '30 行长消息：CLI 收到的内容逐字完整，只提交一次', async note => {
    const lines = Array.from({ length: 30 }, (_, i) => `第${String(i + 1).padStart(2, '0')}行：信道估计与调度验收记录，编号 ${String(i * 37 % 1000).padStart(3, '0')}。`);
    const text = lines.join('\n') + '\n只回复「收到-30」这几个字。';
    const before = transcriptUserTexts(ctx.transcript).length;
    const r = await sendAndWait(ctx.a, text, '收到-30', '长消息');
    const received = transcriptUserTexts(ctx.transcript).slice(before);
    note(`用时 ${r.seconds}s；新增用户消息 ${received.length} 条`);
    if (received.length !== 1) throw new Error('应只提交一条用户消息，实际 ' + received.length);
    const norm = s => s.replace(/\r\n?/g, '\n').trim();
    const got = norm(received[0]);
    const missing = lines.filter(l => !got.includes(l));
    if (missing.length) throw new Error(`缺少 ${missing.length} 行，例如：${missing[0]}`);
    if (/\[Pasted/i.test(got)) throw new Error('CLI 收到的是折叠标记而不是正文');
    note('30 行全部完整');
  }, { needs: ['turn1'] });

  await step('08', '休眠后从侧栏点开：用同一个原生会话恢复，继续对话', async note => {
    const suspended = await c.eval(`ipcRenderer.invoke('suspend-session', { sessionId: ${j(ctx.a)} })`);
    if (!suspended || !suspended.ok) throw new Error('休眠失败：' + j(suspended));
    await until(`sessions.get(${j(ctx.a)})?.status === 'dormant'`, '进入休眠', 30000);
    await c.eval(`selectSession(${j(ctx.ps)})`); await sleep(800);
    await c.eval(`selectSession(${j(ctx.a)})`); await c.eval(`applyViewMode('card')`);
    await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes('ACCEPT-1')`, '休眠状态下卡片历史可见', 30000);
    try { await until(`sessions.get(${j(ctx.a)})?.status !== 'dormant'`, '点开后唤醒', 90000); }
    catch (error) { throw new Error(error.message + '；界面提示：' + ((await alertText()) || '无')); }
    await openTerminal(ctx.a);
    await until(`(${bufferExpr(ctx.a, 'normal')}).replace(/\\s+/g, '').includes('--resume${ctx.cc}')`, '终端敲出 --resume <同一 ID>', 90000);
    await waitTui(ctx.a, '恢复后');
    const r = await sendAndWait(ctx.a, '只回复 ACCEPT-2 这几个字符。', 'ACCEPT-2', '恢复后一轮');
    const info = await sessionInfo(ctx.a);
    note(`恢复后用时 ${r.seconds}s；原生会话 ${info.cc}`);
    if (info.cc !== ctx.cc) throw new Error(`恢复后原生会话变了：${ctx.cc} → ${info.cc}`);
    if (!fs.readFileSync(ctx.transcript, 'utf8').includes('ACCEPT-2')) throw new Error('第二轮没有写进同一份记录');
    ctx.resumed = true;
  }, { needs: ['turn1'] });

  await step('09', 'Hub 关闭再打开：会话还在、卡片历史加载、恢复后继续对话', async note => {
    await quit();
    await launch('acceptance-2');
    await until(`sessions.has(${j(ctx.a)})`, '重开后侧栏有原会话', 60000);
    await c.eval(`selectSession(${j(ctx.a)})`); await c.eval(`applyViewMode('card')`);
    const t0 = Date.now();
    await until(`['ACCEPT-1','ACCEPT-2'].every(k => (document.querySelector('#msg-overlay')?.innerText || '').includes(k))`, '重开后卡片历史加载', 60000);
    note(`重开后卡片历史加载用时 ${Math.round((Date.now() - t0) / 100) / 10}s`);
    try { await until(`sessions.get(${j(ctx.a)})?.status !== 'dormant'`, '重开后唤醒', 90000); }
    catch (error) { throw new Error(error.message + '；界面提示：' + ((await alertText()) || '无')); }
    await openTerminal(ctx.a);
    await until(`(${bufferExpr(ctx.a, 'normal')}).replace(/\\s+/g, '').includes('--resume${ctx.cc}')`, '重开后 --resume <同一 ID>', 90000);
    await waitTui(ctx.a, '重开后');
    await sendAndWait(ctx.a, '只回复 ACCEPT-3 这几个字符。', 'ACCEPT-3', '重开后一轮');
    const info = await sessionInfo(ctx.a);
    if (info.cc !== ctx.cc) throw new Error(`重开后原生会话变了：${ctx.cc} → ${info.cc}`);
    note('重开后同一原生会话续聊成功');
    ctx.hub = true;
  }, { needs: ['resumed'] });

  await step('10', '停止按钮：中断正在进行的回答，之后还能正常发下一条', async note => {
    await c.eval(`applyViewMode('card')`);
    await c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: ctx.a, text: '请写一篇 2000 字的文章，介绍无线信道估计的发展历史，分十节。' })})`);
    await until(`getSessionRuntimeTruth(sessions.get(${j(ctx.a)})).state === 'running'`, '开始执行', 60000);
    // 像人一样：看到 AI 开始输出后再点停止。还没出第一个字就停时，Claude 形态的 CLI 只把问题退回输入框、
    // 不写中断标记，Hub 收不到中断信号（已知边界，与 CLI 种类无关）。
    const outputStarted = () => {
      const lines = fs.readFileSync(ctx.transcript, 'utf8').split('\n');
      const at = lines.findIndex(l => l.includes('2000 字'));
      return at >= 0 && lines.slice(at + 1).some(l => l.includes('"type":"assistant"'));
    };
    for (let i = 0; i < 90 && !outputStarted(); i++) await sleep(1000);
    note('点停止时 AI 是否已开始输出：' + outputStarted());
    await sleep(2000);
    await until(`!!document.querySelector('.floating-input-stop')`, '停止按钮出现', 20000);
    const stateNow = () => c.eval(`getSessionRuntimeTruth(sessions.get(${j(ctx.a)})).state`);
    const timeline = [];
    note('点停止前状态：' + await stateNow() + '；记录里已收到长文请求：' + transcriptUserTexts(ctx.transcript).some(t => t.includes('2000 字')));
    await c.eval(`document.querySelector('.floating-input-stop').click()`);
    try {
      const end = Date.now() + 60000;
      for (;;) {
        const st = await stateNow(); if (timeline[timeline.length - 1] !== st) timeline.push(st);
        if (!['running', 'starting'].includes(st)) break;
        if (Date.now() > end) throw new Error('超时：停止生效');
        await sleep(1000);
      }
    } finally {
      note('点停止后状态变化：' + timeline.join(' → '));
      note('记录里有中断标记「[Request interrupted by user」：' + fs.readFileSync(ctx.transcript, 'utf8').includes('Request interrupted by user'));
    }
    note('停止后状态：' + await c.eval(`getSessionRuntimeTruth(sessions.get(${j(ctx.a)})).state`));
    await sleep(2000);
    await sendAndWait(ctx.a, '只回复 ACCEPT-4 这几个字符。', 'ACCEPT-4', '停止后一轮');
  }, { needs: ['turn1'] });

  if (!skipGroup) {
    await step('11', `群聊：两名 CodeAgent 成员（GLM-5.2-WX-Auto 与 ${secondModel}）都回答`, async note => {
      const slots = [{ kind: 'codeagent', model: 'GLM-5.2-WX-Auto' }, { kind: 'codeagent', model: secondModel }];
      const group = await c.eval(`ipcRenderer.invoke('create-meeting', ${j({ title: 'CodeAgent 验收群聊', scene: 'general', workspace: workGroup, slots })})`);
      if (!group || !group.id) throw new Error('建群失败：' + j(group));
      ctx.group = group;
      note(`群聊 ${group.id}，成员 ${group.subSessions.length}`);
      await c.eval(`window.MeetingRoom.openMeeting(${j(group.id)}, ${j(group)})`);
      await until('document.getElementById("mr-input-box")', '群聊输入框', 30000);
      await sleep(20000);
      // 像人一样输入：点进输入框、键入文字、点发送（直接改 textContent 不会进入输入框的草稿）。
      await c.eval(`(() => { const box = document.getElementById('mr-input-box'); box.focus(); const r = document.createRange(); r.selectNodeContents(box); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); })()`);
      await c.send('Input.insertText', { text: '请用一句话回复：GROUP-OK 加上你的群聊角色名字。' });
      await sleep(500);
      const typed = await c.eval(`document.getElementById('mr-input-box').innerText`);
      if (!typed.includes('GROUP-OK')) throw new Error('群聊输入框没有收到文字：' + typed);
      await c.eval(`document.getElementById('mr-send-btn').click()`);
      const stateExpr = `ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(group.id)} })`;
      try {
        await until(`(async () => { const s = await ${stateExpr}; return (s?.messages || []).filter(m => m.role === 'assistant' && String(m.content || '').includes('GROUP-OK')).length >= 2; })()`, '两名成员都回答', 420000);
      } catch (error) {
        const st = await c.eval(stateExpr).catch(() => null);
        note('群聊里记录的用户消息：' + j((st?.messages || []).filter(m => m.role === 'user').map(m => String(m.content || '').slice(0, 200))));
        for (const sid of group.subSessions) {
          const raw = String(await c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${j(sid)})`) || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
          const at = raw.lastIndexOf('## 用户');
          note(`成员 ${sid.slice(0, 8)} 收到的「## 用户」段：` + redact(at >= 0 ? raw.slice(at, at + 300) : '（终端里没有找到）'));
          note(`成员 ${sid.slice(0, 8)} 终端最后 15 行：\n` + redact(await activeScreenTail(sid, 15)));
        }
        throw error;
      }
      const state = await c.eval(stateExpr);
      note('成员回答：' + (state.messages || []).filter(m => m.role === 'assistant').map(m => String(m.content).slice(0, 80)).join(' | '));
    }, { needs: ['hub'] });
  }

  await step('12', '新建会话表单默认选中 CodeAgent，并排在第一位', async note => {
    // 首页「新建普通会话」与侧栏「启动」按钮都调用这个入口；默认选中的逻辑就在其中。
    await c.eval(`window.WorkspaceController.openNewSessionModal()`);
    await until(`document.querySelector('#new-session-submit')?.getBoundingClientRect().width > 0`, '新建会话表单', 20000);
    const state = await c.eval(`(() => { const grid = document.querySelector('.session-kind-grid'); const sel = document.querySelector('.new-session-option.selected'); return { selected: sel && sel.dataset.kind, first: grid && grid.firstElementChild && grid.firstElementChild.dataset.kind, summary: document.getElementById('new-session-summary')?.innerText || '' }; })()`);
    note('默认选中：' + state.selected + '；第一位：' + state.first + '；表单摘要：' + state.summary);
    await c.eval(`document.getElementById('new-session-cancel')?.click()`);
    if (state.selected !== 'codeagent') throw new Error('默认选中的不是 CodeAgent');
    if (state.first !== 'codeagent') throw new Error('CodeAgent 不在第一位');
  }, { needs: ['hub'] });

  await step('13', '浅色主题下 CodeAgent 终端用深色配色（与 CLI 自己的黑底协调）', async note => {
    const theme = await c.eval(`document.documentElement.getAttribute('data-theme')`);
    await openTerminal(ctx.a);
    await sleep(1500);
    const bg = await c.eval(`terminalCache.get(${j(ctx.a)})?.terminal?.options?.theme?.background || ''`);
    note('Hub 主题：' + theme + '；CodeAgent 终端背景色：' + bg);
    await c.eval(`applyViewMode('card')`);
    if (theme === 'codex' && !/^#0d1117$/i.test(bg)) throw new Error('浅色主题下 CodeAgent 终端不是深色配色');
  }, { needs: ['turn1'] });

  await step('14', '会话自动命名：第一句话后先显示临时名，再由 CodeAgent 生成正式名字', async note => {
    const titleOf = () => c.eval(`sessions.get(${j(ctx.a)})?.title || ''`);
    let title = await titleOf();
    note('当前标题：' + title);
    const end = Date.now() + 200000;
    while (/^CodeAgent( · |\s*\d+$)/.test(title) && Date.now() < end) { await sleep(3000); title = await titleOf(); }
    note('最终标题：' + title);
    if (/^CodeAgent( · |\s*\d+$)/.test(title)) throw new Error('3 分钟内没有生成正式名字（仍是临时名或默认名）');
  }, { needs: ['turn1'] });

  report.facts.settingsAfter = (() => { const a = hookEntries(); return { keys: a.keys, foreignHooks: a.foreign && a.foreign.length, hubHooks: a.hub && a.hub.length }; })();
}

main().catch(error => {
  report.fatal = redact(error && error.stack || String(error)).slice(0, 2000);
  console.error('致命错误：' + report.fatal);
}).finally(async () => {
  try { if (hub) report.facts.hubLogTail = hub.log().filter(l => /codeagent|hook|error|失败/i.test(l)).slice(-40).map(redact); } catch {}
  await quit();
  report.finishedAt = new Date().toISOString();
  const pass = report.steps.filter(s => s.status === 'pass').length;
  const md = [`# CodeAgent 真机验收报告`, '', `- 时间：${report.startedAt} → ${report.finishedAt}`, `- Code Agent 版本：${report.facts.codeagentVersion || '未知'}`,
    `- Hub：${report.facts.windowTitleVersion || '未知'}`, `- 结果：${pass} / ${report.steps.length} 项通过`, `- 截图与原始数据：${redact(out)}`, '',
    '| 项 | 内容 | 结论 | 用时 |', '|---|---|---|---|',
    ...report.steps.map(s => `| ${s.id} | ${s.title} | ${{ pass: '通过', fail: '不通过', skipped: '跳过' }[s.status] || s.status} | ${s.seconds ?? ''}s |`), ''];
  for (const s of report.steps) {
    md.push(`## ${s.id} ${s.title}`, '', `结论：${{ pass: '通过', fail: '不通过', skipped: '跳过' }[s.status] || s.status}`, '');
    if (s.error) md.push('错误：', '```text', s.error, '```', '');
    for (const e of s.evidence) md.push('```text', String(e).slice(0, 1500), '```');
    md.push('');
  }
  if (report.fatal) md.push('## 致命错误', '```text', report.fatal, '```', '');
  md.push('## 环境与配置变化', '```json', j(report.facts.settingsBefore), j(report.facts.settingsAfter), '```');
  if (report.facts.hubLogTail) md.push('## Hub 日志（相关行）', '```text', report.facts.hubLogTail.join('\n'), '```');
  fs.writeFileSync(path.join(out, 'report.md'), md.join('\n').slice(0, 40000), 'utf8');
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n报告：' + path.join(out, 'report.md'));
  process.exitCode = report.steps.length && report.steps.every(s => s.status === 'pass') && !report.fatal ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 500);
});
