'use strict';
// 全屏检测（会议共享、放映 PPT、全屏视频时桌宠躲到屏幕边只露个头）。
// 用 Windows 自带的 SHQueryUserNotificationState：它就是系统判断「现在别弹通知」的依据，
// 2=有程序全屏、3=全屏 D3D 游戏、4=演示模式。由一个隐藏的 PowerShell 常驻进程每 3 秒查一次，状态变了才输出一行；
// 只在桌宠开着时运行，桌宠关掉或 Hub 退出时结束，Hub 意外退出时它发现父进程没了也会自己退出。
// 脚本用 -EncodedCommand 传入：打包后源码在 app.asar 里，PowerShell 读不到 .ps1 文件。
const { spawn } = require('child_process');

const BUSY_STATES = new Set([2, 3, 4]);

function buildScript(parentPid, intervalSec) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace HubPet -Name Quns -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern int SHQueryUserNotificationState(out int state);'",
    '$last = -1',
    'while ($true) {',
    '  if (-not (Get-Process -Id ' + Number(parentPid) + ' -ErrorAction SilentlyContinue)) { exit 0 }',
    '  $s = 0',
    '  [void][HubPet.Quns]::SHQueryUserNotificationState([ref]$s)',
    '  if ($s -ne $last) { [Console]::Out.WriteLine($s); [Console]::Out.Flush(); $last = $s }',
    '  Start-Sleep -Seconds ' + Number(intervalSec),
    '}',
  ].join('\n');
}

function encode(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

function createFullscreenWatch({ onChange, platform = process.platform, spawnFn = spawn, intervalSec = 3, logger = console } = {}) {
  let child = null;
  let fullscreen = false;
  let stopped = true;

  function handleLine(line) {
    const state = Number(String(line).trim());
    if (!Number.isFinite(state)) return;
    const next = BUSY_STATES.has(state);
    if (next === fullscreen) return;
    fullscreen = next;
    try { onChange?.(fullscreen, state); } catch (error) { logger.warn?.('[hub-pet] fullscreen handler', error.message); }
  }

  function start() {
    if (platform !== 'win32' || child) return false;
    stopped = false;
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encode(buildScript(process.pid, intervalSec))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { logger.warn?.('[hub-pet] fullscreen watch unavailable:', error.message); child = null; return false; }
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    let err = '';
    child.stderr.on('data', chunk => { if (err.length < 2000) err += chunk.toString('utf8'); });
    const me = child;
    child.on('error', error => logger.warn?.('[hub-pet] fullscreen watch error:', error.message));
    child.on('exit', code => {
      if (child === me) child = null;
      if (!stopped) logger.warn?.('[hub-pet] fullscreen watch exited', code, err.trim().slice(0, 300));
      if (fullscreen) { fullscreen = false; try { onChange?.(false, 0); } catch (_) {} }
    });
    return true;
  }

  function stop() {
    stopped = true;
    if (child) { try { child.kill(); } catch (_) {} child = null; }
  }

  return { start, stop, isFullscreen: () => fullscreen, isRunning: () => !!child, _handleLine: handleLine };
}

module.exports = { BUSY_STATES, buildScript, createFullscreenWatch, encode };
