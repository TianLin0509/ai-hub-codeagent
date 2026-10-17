'use strict';
// 底栏「网络」一格要用的 Windows 网络环境（2026-10-17，公司真机回执 Q-1017-20）：
// - 公司电脑的代理配在 Windows 系统设置（注册表 Internet Settings 的 ProxyEnable / ProxyServer，办公代理:8080），
//   不在 HTTP(S)_PROXY 环境变量里，Hub 也没配代理，于是底栏一直显示「直连」；出口探测用 curl --noproxy 直连公网，
//   在公司被拦，显示「出口未知」。走系统代理实测能通（出口新加坡）。
// - 公司的 xGate 是公司安全终端 SPES 套件里的 SPES5.exe：节点配置加密、读不出选了哪个国家，也不改系统代理、
//   不建虚拟网卡；能可靠判断的只有「进程在不在」。所以 xGate 只标「开着」，国家以走系统代理实测的出口为准。
// - 公司 VPN（OpenVPN 的 TAP-Windows 网卡、Array SSL VPN 网卡等）：回执里最可靠的判据是「VPN 虚拟网卡 Up 且拿到
//   非 169.254 的 IPv4」。VPN 客户端进程常驻、不代表已连上，不看进程。
const childProcess = require('child_process');

const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const CACHE_MS = 60 * 1000;

function run(execFileImpl, file, args) {
  return new Promise(resolve => {
    execFileImpl(file, args, { windowsHide: true, timeout: 5000, encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
  });
}

// reg query 的输出 → 代理地址（http://host:port）；没开或没配返回 ''。
// ProxyServer 可能是「host:port」，也可能是「http=h:p;https=h:p;socks=h:p」——取 https，没有就取 http。
function parseSystemProxy(regText) {
  const text = String(regText || '');
  const enable = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(text);
  if (!enable || parseInt(enable[1], 16) === 0) return '';
  const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(text);
  if (!server) return '';
  let value = server[1].trim();
  if (value.includes('=')) {
    const parts = Object.fromEntries(value.split(';').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim().toLowerCase(), v.trim()]));
    value = parts.https || parts.http || '';
  }
  if (!value) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value;
}

// 已连上的 VPN 网卡：每行「网卡描述|IPv4」。
const VPN_ADAPTER_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -match 'TAP-Windows|SSL VPN|Array Networks|VPN|AnyConnect|Fortinet|WireGuard' } | ForEach-Object {",
  "  $ip = Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1",
  "  if ($ip) { [Console]::Out.WriteLine($_.InterfaceDescription + '|' + $ip.IPAddress) }",
  "}",
].join('\n');
function parseVpnAdapters(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const at = line.lastIndexOf('|');
    return at > 0 ? { name: line.slice(0, at).trim(), address: line.slice(at + 1).trim() } : null;
  }).filter(x => x && /^\d{1,3}(\.\d{1,3}){3}$/.test(x.address) && !x.address.startsWith('169.254.'));
}

// tasklist 的 CSV 输出里有没有 SPES5.exe。
function parseXgateRunning(tasklistText) {
  return /^"SPES5\.exe"/im.test(String(tasklistText || ''));
}

function offMainExecFile(file, args, opts, callback) {
  const { sharedOffMainExecFile } = require('./off-main-exec.js');
  sharedOffMainExecFile()(file, args, opts).then(({ stdout }) => callback(null, stdout), error => callback(error));
}

function createWindowsNetworkContext(options = {}) {
  const platform = options.platform || process.platform;
  // 起子进程在 Windows 上会同步卡住调用线程（50–125ms/次，见 network-egress-monitor.js），主进程里改用共享的后台执行线程。
  const execFileImpl = options.execFile || (require('worker_threads').isMainThread ? offMainExecFile : childProcess.execFile);
  const now = options.now || Date.now;
  let proxyCache = null;
  let tunnelCache = null;

  async function systemProxy() {
    if (platform !== 'win32') return '';
    if (proxyCache && now() - proxyCache.at < CACHE_MS) return proxyCache.value;
    const value = parseSystemProxy(await run(execFileImpl, 'reg.exe', ['query', INTERNET_SETTINGS]));
    proxyCache = { at: now(), value };
    return value;
  }

  async function tunnel() {
    if (platform !== 'win32') return { xgate: false, vpn: null };
    if (tunnelCache && now() - tunnelCache.at < CACHE_MS) return tunnelCache.value;
    const encoded = Buffer.from(VPN_ADAPTER_SCRIPT, 'utf16le').toString('base64');
    const [tasks, adapters] = await Promise.all([
      run(execFileImpl, 'tasklist.exe', ['/FI', 'IMAGENAME eq SPES5.exe', '/FO', 'CSV', '/NH']),
      run(execFileImpl, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]),
    ]);
    const value = { xgate: parseXgateRunning(tasks), vpn: parseVpnAdapters(adapters)[0] || null };
    tunnelCache = { at: now(), value };
    return value;
  }

  return { systemProxy, tunnel };
}

module.exports = { createWindowsNetworkContext, parseSystemProxy, parseVpnAdapters, parseXgateRunning };
