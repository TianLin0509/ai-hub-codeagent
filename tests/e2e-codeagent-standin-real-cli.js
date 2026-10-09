'use strict';
// 真实验收（替身）：公司 Code Agent 会话在隔离 Hub 里的完整链路。
// 没有 Code Agent 的电脑用 tests/fixtures/codeagent-standin/codeagent.cmd 当替身：它启动真 Claude Code（haiku），
// 并复现真 CLI 的差异（忽略 --session-id / --settings，认 CODEAGENT3_CONFIG_DIR，接受 --disable-update）。
// 覆盖：启动时把 Hub hook 合并进 Code Agent 配置目录且保留同事工具（CodeTeam）的 hook；新建会话敲出的命令；
// 首个 hook 绑定原生身份；卡片收到回答并完成；休眠后从侧栏点开恢复，同一原生会话续聊。
// 凭据复制进临时目录，finally 删除；真 Claude 的配置不被改动（哈希核对）。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const FOREIGN_HOOK = 'python "C:/Users/x/.cac/scripts/codeagent-hub-hook.py" stop';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-'));
  const out = path.resolve('artifacts/20261008-codeagent-kind-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeSource = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const claudeAuth = path.join(claudeSource, '.credentials.json');
  const authBefore = hash(claudeAuth);
  const cac = path.join(root, '.cac'), cwd = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  for (const d of [cac, cwd, dataDir]) fs.mkdirSync(d, { recursive: true });
  const result = { checks: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(300); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    // 替身里跑的是 Claude，它读 <配置目录>/.claude.json；.cac.json 是真 Code Agent 的状态文件（Hub 往里写信任）。
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    // 与公司实测的 settings.json 一致：免确认模式、跳过危险模式提示，外加 CodeTeam 的一条 hook。
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true,
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: FOREIGN_HOOK, timeout: 5 }] }] } }));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'codeagent standin', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac,
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined"', 'renderer');

    // ① 启动时的 hook 部署
    const settings = JSON.parse(fs.readFileSync(path.join(cac, 'settings.json'), 'utf8'));
    const stopCommands = settings.hooks.Stop.flatMap(g => g.hooks.map(h => h.command));
    assert.ok(stopCommands.includes(FOREIGN_HOOK), 'CodeTeam hook kept');
    assert.ok(stopCommands.some(cmd => /session-hub-hook/.test(cmd)), 'Hub Stop hook deployed');
    assert.equal(settings.statusLine, undefined); assert.equal(settings.permissionMode, undefined);
    assert.equal(settings.hooks.InstructionsLoaded, undefined, 'events the CLI was not verified to support are not registered');
    result.checks.push('Hub hooks merged into the CodeAgent settings.json; the other tool\'s hook, status line and permissions untouched');

    // ② 新建会话入口在界面上可见
    assert.equal(await c.eval(`!!document.querySelector('.new-session-option[data-kind="codeagent"]')`), true);
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, effort: 'low', mcpProfile: 'none' } })})`);
    const sid = created.id, q = j(sid);
    result.created = { kind: created.kind, title: created.title, model: created.currentModel };
    assert.equal(created.kind, 'codeagent');
    assert.equal(created.currentModel && created.currentModel.id, 'GLM-5.2-WX-Auto');
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row', 20000);
    await c.eval(`selectSession(${q})`);
    // TUI 跑在备用屏幕上；PowerShell 里敲出的启动命令留在普通屏幕。
    const normalScreen = `(() => { const t = terminalCache.get(${q})?.terminal; if (!t) return ''; const b = t.buffer.normal; let x = ''; for (let i = 0; i < b.length; i++) x += (b.getLine(i)?.translateToString(true) || '') + '\\n'; return x; })()`;
    const screen = `(() => { const t = terminalCache.get(${q})?.terminal; if (!t) return ''; const b = t.buffer.active; let x = ''; for (let i = 0; i < b.length; i++) x += (b.getLine(i)?.translateToString(true) || '') + '\\n'; return x; })()`;
    await c.eval(`applyViewMode('pty')`);
    const READY = String.raw`bypass permissions on \(|Anything I can assist you with`;
    await until(`new RegExp(${j(READY)}).test(${screen})`, 'tui ready', 120000); await sleep(1500);
    const typed = await c.eval(normalScreen);
    // 终端按 120 列折行，比对时去掉全部空白。
    assert.ok(typed.replace(/\s+/g, '').includes("codeagent.cmd'--disable-update--skip-safe-check--modelGLM-5.2-WX-Auto--effortlow--permission-modebypassPermissions"),
      'typed launch command: ' + typed.slice(0, 400));
    assert.doesNotMatch(typed, /--session-id/);
    result.checks.push('Typed command: CodeAgent with --disable-update --skip-safe-check, the CodeAgent default model, no --session-id');
    await shot('01-tui');
    const trust = JSON.parse(fs.readFileSync(path.join(cac, '.cac.json'), 'utf8')).projects[path.resolve(cwd).replace(/\\/g, '/')];
    assert.equal(trust && trust.hasTrustDialogAccepted, true, '.cac.json pre-trusts the workspace');
    await c.eval(`applyViewMode('card')`);

    // ③ 第一条消息：首个 hook 绑定身份，卡片完成
    const done = async label => { await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed'`, label + ' completed', 240000); await sleep(1500); };
    const send1 = await c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: sid, text: '只回复 CODEAGENT-OK-1，不要做别的事。' })})`);
    result.send1 = send1;
    await done('first');
    await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes('CODEAGENT-OK-1')`, 'card shows answer 1', 60000);
    const bound = await c.eval(`(() => { const s = sessions.get(${q}); return { cc: s.ccSessionId, transcript: s.transcriptPath, pending: s.codeagentIdentityPending }; })()`);
    result.bound1 = bound;
    assert.match(String(bound.cc), /^[0-9a-f-]{36}$/, 'native identity bound from the hook');
    assert.ok(bound.transcript && path.resolve(bound.transcript).toLowerCase().startsWith(path.resolve(cac, 'projects').toLowerCase()), 'transcript under the CodeAgent config dir');
    assert.equal(path.basename(bound.transcript, '.jsonl'), bound.cc);
    result.checks.push('First hook bound the CLI\'s own session id; card shows the answer and the turn completed');
    await shot('02-card-first');

    // ④ 休眠后从侧栏点开恢复，同一原生会话续聊
    const suspended = await c.eval(`ipcRenderer.invoke('suspend-session', { sessionId: ${q} })`);
    assert.equal(suspended && suspended.ok, true, 'suspend: ' + j(suspended));
    await until(`sessions.get(${q})?.status === 'dormant'`, 'dormant', 30000);
    await c.eval(`selectSession(${q})`);
    await until(`sessions.get(${q})?.status !== 'dormant'`, 'woke', 60000);
    await c.eval(`applyViewMode('pty')`);
    try { await until(`(${normalScreen}).replace(/\\s+/g, '').includes('--resume${bound.cc}')`, 'resume command typed', 60000); }
    catch (error) {
      result.afterWake = { normal: (await c.eval(normalScreen)).slice(-1500), session: await c.eval(`(() => { const s = sessions.get(${q}); return s && { kind: s.kind, status: s.status, cc: s.ccSessionId, transcript: s.transcriptPath }; })()`) };
      throw error;
    }
    await sleep(3000); await until(`new RegExp(${j(READY)}).test(${screen})`, 'tui ready after resume', 120000); await sleep(2000);
    await c.eval(`applyViewMode('card')`);
    await c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: sid, text: '只回复 CODEAGENT-OK-2，不要做别的事。' })})`);
    await done('second');
    await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes('CODEAGENT-OK-2')`, 'card shows answer 2', 60000);
    const bound2 = await c.eval(`(() => { const s = sessions.get(${q}); return { cc: s.ccSessionId, transcript: s.transcriptPath }; })()`);
    result.bound2 = bound2;
    assert.equal(bound2.cc, bound.cc, 'resumed the same native session');
    const lines = fs.readFileSync(bound.transcript, 'utf8');
    assert.ok(lines.includes('CODEAGENT-OK-1') && lines.includes('CODEAGENT-OK-2'), 'both turns in one transcript');
    result.checks.push('Suspended, reopened from the sidebar: resumed with --resume <same id>, second answer in the same transcript');
    await shot('03-card-resumed');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    if (c) { try { await shot('fail'); } catch {} }
    if (hub) { try { result.hubLogTail = hub.log().slice(-60); } catch {} }
  } finally {
    if (c) { try { c.close(); } catch {} }
    if (hub) { try { result.exit = await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    result.credentialsUntouched = hash(claudeAuth) === authBefore;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed || !result.credentialsUntouched) process.exitCode = 1;
  }
}
main();
