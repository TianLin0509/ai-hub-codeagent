'use strict';
// Community edition GUI end-to-end test on a simulated clean machine:
//   - fake HOME whose path contains a space, PATH limited to Windows itself
//     (no Python, Node, Git on PATH),
//   - first-run panel, private entry points absent, window title with version,
//   - hook deployment into the fake ~/.claude without touching global permissions,
//   - missing CLI reported before a session starts,
//   - a stand-in Claude CLI (tests/fixtures/fake-claude.ps1) runs in the Hub's
//     real PTY, fires the deployed PowerShell hooks, and the Hub turns them into
//     a completed card, driven by real mouse and keyboard input.
// It never contacts an AI provider.
// Usage: node tests/e2e-community-cdp.js [--packaged | --executable <installed exe>]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exeIndex = process.argv.indexOf('--executable');
const customExecutable = exeIndex >= 0 ? path.resolve(process.argv[exeIndex + 1]) : null;
const packaged = process.argv.includes('--packaged') || !!customExecutable;
const out = path.resolve(packaged ? 'artifacts/community-packaged-gui' : 'artifacts/community-gui');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function windowTitle(pid) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).MainWindowTitle`], { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return ''; }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub community gui '));
  const home = path.join(root, 'home dir');
  const data = path.join(root, 'data');
  const project = path.join(root, 'project');
  const fakeBin = path.join(home, 'fake-bin');
  for (const dir of [home, data, project, out, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    [pathKey]: [fakeBin, system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
  };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) env[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const report = { checks: [], packaged, providerNetworkTested: false, root };
  let hub;
  let cdp;
  const until = async (expression, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { try { if (await cdp.eval(expression)) return; } catch {} await sleep(200); }
    throw new Error('Timeout: ' + label);
  };
  // Real mouse input on the visible element, not IPC calls.
  async function click(selector) {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
  }
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'community', extraEnv: env,
      ...(packaged ? { executablePath: customExecutable || path.resolve('dist/win-unpacked/AI Hub Community.exe') } : {}) });
    cdp = await connectFirstPage(hub);
    await until('document.querySelectorAll(".community-provider").length === 5', 'first-run provider detection');

    const marker = JSON.parse(fs.readFileSync(path.resolve('community-edition.json'), 'utf8'));
    let title = '';
    for (let i = 0; i < 20 && !title.includes('AI Hub Community'); i++) { title = windowTitle(hub.pid || hub.child?.pid); await sleep(250); }
    assert.match(title, new RegExp(`AI Hub Community v${marker.version.replace(/\./g, '\\.')}（上游 ${marker.upstreamVersion.replace(/\./g, '\\.')}）`), title);
    report.checks.push(`Window title shows the edition and upstream version: ${title.replace(/：PID \d+/, '')}`);

    assert.equal(await cdp.eval('document.querySelectorAll("#btn-research,#btn-study,#study-panel,[data-action=sync-chatgpt],[data-action=sync-company],[data-kind=chatgpt]").length'), 0);
    assert.equal(await cdp.eval('document.querySelectorAll(".community-provider[data-installed=\\"1\\"]").length'), 0);
    report.checks.push('Clean machine: five providers (incl. CodeAgent) reported as not installed; no private entry points on the page');
    await shot('01-first-run');

    const settingsPath = path.join(home, '.claude', 'settings.json');
    await until(`(()=>{try{return require('fs').readFileSync(${JSON.stringify(settingsPath)},'utf8').includes('session-hub-hook.ps1');}catch{return false;}})()`, 'hooks deployed to the fake home');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.match(settings.hooks.Stop[0].hooks[0].command, /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ".*home dir.*session-hub-hook\.ps1" stop$/);
    assert.equal(settings.permissionMode, undefined);
    assert.equal(settings.statusLine, undefined, 'no Node on PATH, so no status line is registered');
    report.checks.push('Hooks deployed as PowerShell commands (path with a space); global permission mode untouched; no Node-dependent status line');

    // A missing CLI stays in the form with guidance and creates nothing.
    await click('#home-create-session');
    await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'new session form');
    await click('.new-session-option[data-kind="claude"]');
    await click('#new-session-submit');
    await until('document.querySelector("#new-session-error")?.innerText.includes("未找到")', 'missing CLI message');
    assert.equal(await cdp.eval('sessions.size'), 0);
    await shot('02-missing-cli');
    report.checks.push('Creating a Claude session without the CLI shows "未找到 Claude Code CLI" and starts nothing');
    await click('#new-session-cancel');

    // Install the stand-in CLI into the fake HOME, then let the page re-detect it.
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.copyFileSync(path.resolve('tests/fixtures/fake-claude.ps1'), path.join(fakeBin, 'fake-claude.ps1'));
    fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-claude.ps1" %*\r\n');
    await click('#community-refresh');
    await until('document.querySelector(\'.community-provider[data-provider="claude"]\')?.dataset.installed === "1"', 'Claude detected');

    await click('#home-create-session');
    await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'new session form again');
    await click('.new-session-option[data-kind="claude"]');
    await click('#new-session-submit');
    await until('[...sessions.values()].some(s => s.kind === "claude")', 'Claude session created');
    const id = await cdp.eval('[...sessions.values()].find(s => s.kind === "claude").id');
    const trace = path.join(home, 'fake-claude-trace.log');
    const traceText = () => { try { return fs.readFileSync(trace, 'utf8'); } catch { return ''; } };
    for (let i = 0; i < 150 && !traceText().includes('SessionStart exit=0'); i++) await sleep(200);
    assert.match(traceText(), /SessionStart exit=0/, 'the CLI ran the deployed SessionStart hook');

    const composer = `.floating-input-bar[data-session-id="${id}"]`;
    await until(`document.querySelector(${JSON.stringify(composer + ' .floating-input-box')})`, 'composer ready');
    await click(composer + ' .floating-input-box');
    await cdp.send('Input.insertText', { text: '社区版端到端 hello' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    for (let i = 0; i < 200 && !traceText().includes('Stop exit=0'); i++) await sleep(200);
    assert.match(traceText(), /prompt: 社区版端到端 hello/, 'the prompt reached the CLI through the PTY');
    assert.match(traceText(), /UserPromptSubmit exit=0[\s\S]*Stop exit=0/, 'prompt and stop hooks ran');
    // The reply is on the real terminal, and the composer status turns to "completed" from the relayed hooks.
    await until(`(async()=>String(await ipcRenderer.invoke("get-ring-buffer",${JSON.stringify(id)})).includes("FAKE-REPLY: 社区版端到端 hello"))()`, 'reply on the terminal');
    await until(`document.querySelector(${JSON.stringify(composer)})?.innerText.includes("完成")`, 'composer shows the turn completed');
    await shot('03-reply');
    report.checks.push('Prompt typed and sent with the keyboard reaches the CLI in the PTY; UserPromptSubmit and Stop hooks relay through PowerShell; the composer shows the turn completed');
    report.hookTrace = traceText().split(/\r?\n/).filter(Boolean);

    // Suspend, then open it again from the sidebar with the mouse: the Hub must resume the same
    // native session. v0.3.0/v0.4.0 failed here ("isAgentLeague is not defined") for every session.
    const q = JSON.stringify(id);
    const native = await cdp.eval(`sessions.get(${q}).ccSessionId`);
    const suspended = await cdp.eval(`ipcRenderer.invoke('suspend-session', { sessionId: ${q} })`);
    assert.equal(suspended && suspended.ok, true, 'suspend: ' + JSON.stringify(suspended));
    await until(`sessions.get(${q})?.status === 'dormant'`, 'session dormant');
    const startsBefore = (traceText().match(/SessionStart exit=0/g) || []).length;
    await click(`.session-item[data-session-id="${id}"]`);
    await until(`sessions.get(${q})?.status !== 'dormant' || document.body.innerText.includes('会话恢复失败')`, 'wake attempt');
    assert.equal(await cdp.eval(`document.body.innerText.includes('会话恢复失败')`), false, 'resume must not fail');
    for (let i = 0; i < 150 && (traceText().match(/SessionStart exit=0/g) || []).length <= startsBefore; i++) await sleep(200);
    assert.ok((traceText().match(/SessionStart exit=0/g) || []).length > startsBefore, 'the CLI started again on wake');
    assert.equal(await cdp.eval(`sessions.get(${q}).ccSessionId`), native, 'resumed the same native session');
    await shot('04-resumed');
    report.checks.push('Suspended and reopened from the sidebar: the CLI restarts with the same native session and no resume error');

    assert.ok(hub.log().some(line => line.includes('hook server listening')), 'hook listener must start');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) {
      await shot('failure').catch(() => {});
      fs.writeFileSync(path.join(out, 'failure-dom.txt'), String(await cdp.eval('document.body.innerText').catch(() => '')));
    }
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) { try { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); } finally { await gracefulQuit(hub); } }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
