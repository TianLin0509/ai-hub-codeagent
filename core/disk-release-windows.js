'use strict';

const { spawn } = require('child_process');

function powershell(script, input, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const command = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); [Console]::InputEncoding=[Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Windows 检查超时，未执行清理')); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) { child.kill(); finish(new Error('Windows 检查返回过大，未执行清理')); }
    });
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('close', code => {
      if (code !== 0) return finish(new Error(stderr.trim() || 'Windows 检查失败'));
      try { finish(null, JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
      catch { finish(new Error('Windows 检查返回无法读取，未执行清理')); }
    });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input), 'utf8');
  });
}

function retainLiveProcessRows(rows, probe = pid => process.kill(pid, 0)) {
  return rows.filter(row => {
    if (row.cmd) return true;
    try { probe(Number(row.pid)); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  });
}

async function readProcesses() {
  if (process.platform !== 'win32') throw new Error('硬盘释放目前支持 Windows');
  const rows = await powershell(`@(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='name';e={$_.Name}},@{n='cmd';e={$_.CommandLine}}) | ConvertTo-Json -Compress -Depth 3`);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('无法检查活动程序，未执行清理');
  // CIM can enumerate a process that exits before its command line is read.
  // Exclude only confirmed-gone PIDs; permission failures remain protected.
  return retainLiveProcessRows(rows);
}

async function allocatedSizes(files) {
  if (files.length === 0) return [];
  if (process.platform !== 'win32') return files.map(file => file.size);
  return powershell(`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HubDiskAllocation {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetCompressedFileSizeW(string path, out uint high);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  public static long Size(string path) {
    uint high; SetLastError(0);
    uint low=GetCompressedFileSizeW(path, out high);
    if(low==UInt32.MaxValue && Marshal.GetLastWin32Error()!=0) return -1;
    return ((long)high << 32) + low;
  }
}
'@
$paths=ConvertFrom-Json ([Console]::In.ReadToEnd())
$numbers=New-Object System.Collections.Generic.List[long]
foreach($p in $paths){ $numbers.Add([HubDiskAllocation]::Size([string]$p)) }
ConvertTo-Json -InputObject @($numbers.ToArray()) -Compress
`, files.map(file => file.path));
}

module.exports = { powershell, readProcesses, allocatedSizes, retainLiveProcessRows };
