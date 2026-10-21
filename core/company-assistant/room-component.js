'use strict';
// Reuse the secretary's signed shell and code-update contract. No new booking engine.
const fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), { execFile, spawn } = require('node:child_process');
const BUNDLE = path.join(__dirname, 'room-component');
const PUBLIC_KEY = crypto.createPublicKey({ key: Buffer.from('302a300506032b6570032100484b4c7e2085c284d6a569b95c8defd152dec09a2f3015a9be18c5df8ec2bed4', 'hex'), format: 'der', type: 'spki' });
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
const version = v => String(v).split('.').map(Number).reduce((n, v) => n * 1000 + v, 0);
function manifest(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8')), { signature, ...body } = m;
  if (m.app !== 'mishu-terminator' || !/^\d+\.\d+\.\d+$/.test(m.version)
      || !crypto.verify(null, Buffer.from(JSON.stringify(ordered(body)), 'utf8'), PUBLIC_KEY, Buffer.from(signature || '', 'hex'))) throw new Error('秘书组件签名不正确，未安装');
  for (const a of [m.code, m.exe].filter(Boolean)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(a.file) || !Number.isSafeInteger(a.size) || a.size < 1 || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new Error('秘书组件清单格式不正确');
  }
  return m;
}
function verified(file, asset) {
  return fs.existsSync(file) && fs.statSync(file).size === asset.size
    && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === asset.sha256;
}
const exec = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 10000, encoding: 'utf8', maxBuffer: 1024 * 1024, ...options }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
// The version probe of a PyInstaller one-file exe is a bootloader plus an inner
// Python process; a cold start on a busy office PC can take well over 10 s.
const PROBE_TIMEOUT_MS = 120000;
const NEED_CONNECT = '请先在助理设置 → 抢会议室里接通';
const RUNTIME_MISSING = '安装包缺少会议室组件，请使用包含会议室组件的完整安装包修复；不需要另装秘书终结者';
// Ends only the process tree this module started (by PID), never by name.
function killTree(child) {
  return new Promise(resolve => {
    if (!child?.pid || child.exitCode != null) { resolve(); return; }
    if (process.platform !== 'win32') { try { child.kill('SIGKILL'); } catch {} resolve(); return; }
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', e => { console.warn('[company-assistant] 结束秘书检测进程树失败', e.message); try { child.kill(); } catch {} resolve(); });
    killer.on('close', () => resolve());
  });
}
// Ask the secretary shell for its version against a throwaway MSZ_HOME so the
// user's data and boot-retry counter stay untouched; the temp dir is always removed.
async function probe(a, exe, { spawnFn = spawn, timeoutMs = PROBE_TIMEOUT_MS, kill = killTree } = {}) {
  fs.mkdirSync(a.dir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(a.dir, 'mishu-probe-')), output = path.join(dir, 'version.json');
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const child = spawnFn(exe, ['--version-json', output], { windowsHide: true, stdio: 'ignore', env: { ...process.env, MSZ_HOME: dir } });
      const fail = async error => { if (settled) return; settled = true; clearTimeout(timer); await kill(child); reject(error); };
      const timer = setTimeout(() => { void fail(new Error(`秘书程序 ${Math.round(timeoutMs / 1000)} 秒内没有回报版本，已结束这次检测；请稍后再点「接通秘书」`)); }, timeoutMs);
      child.on('error', error => { void fail(error); });
      // A one-file bootloader exits only after its inner process, so a normal exit leaves no tree;
      // the PID is not killed afterwards because Windows may already have reused it.
      child.on('exit', code => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (code === 0) resolve(); else reject(new Error(`秘书版本检测没有完成（退出码 ${code}）`));
      });
    });
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { console.warn('[company-assistant] 秘书检测临时目录未能删除', dir, error.message); }
  }
}
function fileKey(exe) { const st = fs.statSync(exe); return { exe: path.resolve(exe), size: st.size, mtimeMs: st.mtimeMs }; }
function bundledRuntime(bundle = BUNDLE) {
  const baseline = manifest(path.join(bundle, 'baseline.json'));
  const source = path.join(bundle, 'runtime', baseline.exe.file);
  return { baseline, source };
}
function runtimeAvailable(bundle = BUNDLE) {
  try { const { baseline, source } = bundledRuntime(bundle); return fs.statSync(source).size === baseline.exe.size; }
  catch { return false; }
}
// Keep running executables outside the installation tree: Windows must be able to
// replace app.asar.unpacked during a Hub update, including while a booking runs.
function prepareRuntime(a, { bundle = BUNDLE } = {}) {
  const { baseline, source } = bundledRuntime(bundle);
  if (!fs.existsSync(source)) throw new Error(RUNTIME_MISSING);
  if (!verified(source, baseline.exe)) throw new Error('随包会议室组件校验失败，请修复 Hub 安装包');
  const exe = path.join(a.dir, 'room-runtime', baseline.exe.sha256, baseline.exe.file);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  if (!fs.existsSync(exe)) {
    const temp = exe + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.copyFileSync(source, temp);
      if (!verified(temp, baseline.exe)) throw new Error('会议室组件复制后校验失败');
      fs.renameSync(temp, exe);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  if (!verified(exe, baseline.exe)) throw new Error('本机会议室组件校验失败，未启动');
  return { exe, baseline };
}
async function foreignInstances(exe, { listProcesses } = {}) {
  if (!listProcesses && (process.platform !== 'win32' || process.env.MSZ_HUB_TEST_INSTANCE)) return [];
  const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $sid=[Diagnostics.Process]::GetCurrentProcess().SessionId; @((Get-CimInstance Win32_Process -Filter "Name LIKE \'MishuTerminator%\' OR Name = \'秘书终结者.exe\'") | Where-Object { $_.SessionId -eq $sid } | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress';
  const result = listProcesses ? await listProcesses() : JSON.parse((await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim() || '[]');
  const same = value => value && path.resolve(value).toLowerCase() === path.resolve(exe).toLowerCase();
  return (Array.isArray(result) ? result : [result]).filter(p => p && !same(p.ExecutablePath));
}
// A pre-existing connected user's data directory stays where it is. Only managed
// execution preferences change; rules, history and browser login files are retained.
function initializeHome(home) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.json');
  const exists = fs.existsSync(file), config = exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('会议室配置格式不正确，原文件已保留');
  const next = { ...config, 系统: { ...config['系统'], 自动检查更新: false, 开机自动启动守护: false }, 高级: { ...config['高级'], 无界面: true } };
  if (!exists) next['会后动作'] = { 模式: '不动作', 小鲁班ID: '' };
  if (JSON.stringify(config) !== JSON.stringify(next)) {
    const temp = file + '.hub.tmp'; fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8'); fs.renameSync(temp, file);
  }
}
// Compatibility IPC aliases; these no longer search for or download another app.
async function discover(a, options) { const { source } = bundledRuntime(options?.bundle); return fs.existsSync(source) ? source : ''; }
async function install(a, options) { return prepareRuntime(a, options).exe; }
async function stage(a, exe, home, { probe: allowProbe = false, probeOptions, baseline, bundle = BUNDLE } = {}) {
  const m = manifest(path.join(bundle, 'control.json')), source = path.join(bundle, m.code.file);
  if (!verified(source, m.code)) throw new Error('秘书控制组件校验不通过');
  const updates = path.join(home, 'updates'), currentFile = path.join(updates, 'current.json');
  let current = null;
  try { current = JSON.parse(fs.readFileSync(currentFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('秘书更新记录读不了，请在秘书里检查更新状态'); }
  if (current && version(current.version) > version(m.version)) {
    if (baseline) throw new Error('会议室数据目录已有较新组件，已保留原版本；请升级 Hub 后继续');
    return { newer: true };
  }
  if (current?.version === m.version && current.sha256 === m.code.sha256 && (current.bad || Number(current.boots) >= 3))
    throw new Error('此控制组件启动失败后已回退，未再次启用；请保留秘书现有版本，待修复组件后再接通');
  if (current?.version === m.version && current.sha256 === m.code.sha256 && !current.bad && verified(path.join(updates, m.code.file), m.code)) return { ready: true };
  // The version probe runs only when the user clicks connect; background starts reuse
  // the recorded result while the exe file is unchanged.
  const key = fileKey(exe), cached = a.state?.().roomProbe;
  let info;
  if (baseline && verified(exe, baseline.exe)) info = { exe_shell: baseline.shell, exe_version: baseline.version };
  else if (cached && cached.exe === key.exe && cached.size === key.size && cached.mtimeMs === key.mtimeMs) info = cached;
  else if (!allowProbe) throw new Error(NEED_CONNECT);
  else {
    const found = await probe(a, exe, probeOptions);
    info = { exe_shell: found.exe_shell, exe_version: found.exe_version };
    a.saveState?.({ roomProbe: { ...key, ...info } });
  }
  if (info.exe_shell !== m.shell) throw new Error('现有秘书运行环境不兼容，请更新秘书后再接通');
  if (version(info.exe_version) >= version(m.version)) return { bundled: true };
  fs.mkdirSync(updates, { recursive: true });
  const dest = path.join(updates, m.code.file);
  if (fs.existsSync(dest) && !verified(dest, m.code)) throw new Error('已有同名秘书组件内容不同，未覆盖；请先在秘书里检查更新');
  if (!fs.existsSync(dest)) fs.copyFileSync(source, dest);
  if (current && !fs.existsSync(path.join(updates, 'before-hub-control.json'))) fs.writeFileSync(path.join(updates, 'before-hub-control.json'), JSON.stringify(current), 'utf8');
  const next = { version: m.version, file: m.code.file, sha256: m.code.sha256, shell: m.shell, boots: 0, bad: false, installed: Date.now() / 1000 };
  fs.writeFileSync(currentFile + '.hub.tmp', JSON.stringify(next), 'utf8'); fs.renameSync(currentFile + '.hub.tmp', currentFile);
  return { installed: true, version: m.version };
}
module.exports = { manifest, verified, discover, install, stage, probe, killTree, PROBE_TIMEOUT_MS, NEED_CONNECT,
  bundledRuntime, runtimeAvailable, prepareRuntime, foreignInstances, initializeHome, RUNTIME_MISSING };
