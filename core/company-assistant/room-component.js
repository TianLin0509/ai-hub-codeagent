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
const RUNTIME_MISSING = '会议室组件还没下载到这台电脑；请在「助理 → 设置 → 抢会议室」里点「下载会议室组件」，不需要另装秘书终结者';
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
// 打包后 __dirname 是 ...\resources\app.asar\core\company-assistant。3.1.3 起安装包的 asar 里不再有
// runtime/，但 3.1.2 及更早装过的机器上，旧副本还留在 app.asar.unpacked 下；asar 路径下已经没有条目，
// 只有换成 unpacked 才找得到。老的安装包只是没用过会议室的那批人，不该为这 77MB 重下一遍。
function runtimeSourcePaths(bundle, file) {
  const primary = path.join(bundle, 'runtime', file), paths = [primary], asar = `app.asar${path.sep}`;
  if (primary.includes(asar)) paths.push(primary.replace(asar, `app.asar.unpacked${path.sep}`));
  return paths;
}
function bundledRuntime(bundle = BUNDLE) {
  const baseline = manifest(path.join(bundle, 'baseline.json'));
  const sources = runtimeSourcePaths(bundle, baseline.exe.file);
  const source = sources.find(file => fs.existsSync(file)) || sources[0];
  return { baseline, source, sources };
}
// Keep running executables outside the installation tree: Windows must be able to
// replace app.asar.unpacked during a Hub update, including while a booking runs.
function runtimeCachePath(a, baseline) { return path.join(a.dir, 'room-runtime', baseline.exe.sha256, baseline.exe.file); }
// 本机现状：数据目录缓存（下载或从旧安装包拷来的）、安装目录自带的旧副本、都没有。
// 这里只比字节数：状态几秒刷一次，不能每次都把 77MB 全读一遍算哈希；真要启动前
// prepareRuntime 会完整核对 sha256。
const sizeOk = (file, asset) => { try { return fs.statSync(file).size === asset.size; } catch { return false; } };
function runtimeInfo(a, { bundle = BUNDLE } = {}) {
  const { baseline, sources } = bundledRuntime(bundle);
  const cached = runtimeCachePath(a, baseline);
  return { bytes: baseline.exe.size, sha256: baseline.exe.sha256,
    cached: sizeOk(cached, baseline.exe), bundled: sources.some(file => sizeOk(file, baseline.exe)), baseline };
}
// 2026-10-22：安装包不再默认带 76.8MB 的运行时。顺序是 本机缓存（下载过的 / 旧安装包拷过来的）→
// 安装目录里的旧副本（3.1.2 及更早装的）→ 按签名清单现下（downloader 由 rooms 传入）。
async function prepareRuntime(a, { bundle = BUNDLE, downloader = null } = {}) {
  const { baseline, sources } = bundledRuntime(bundle);
  const exe = runtimeCachePath(a, baseline);
  if (fs.existsSync(exe)) {
    // 缓存被改过/传坏了：删掉重来（可能重新下载）。删不掉说明正被占用，照旧报错不硬来。
    if (verified(exe, baseline.exe)) return { exe, baseline };
    try { fs.rmSync(exe, { force: true }); }
    catch (_) { throw new Error('本机会议室组件校验失败，未启动'); }
  }
  const copies = sources.filter(file => fs.existsSync(file));
  if (copies.length) {
    const good = copies.find(file => verified(file, baseline.exe));
    // 有旧副本但内容不对：既不能跑，也不该拿它当「没下载」去悄悄联网。
    if (!good) throw new Error('随包会议室组件校验失败，请修复 Hub 安装包');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    const temp = exe + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.copyFileSync(good, temp);
      if (!verified(temp, baseline.exe)) throw new Error('会议室组件复制后校验失败');
      fs.renameSync(temp, exe);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return { exe, baseline };
  }
  if (downloader) {
    await downloader.ensure();
    if (!verified(exe, baseline.exe)) throw new Error('会议室组件下载后校验失败，未启动');
    return { exe, baseline };
  }
  throw Object.assign(new Error(RUNTIME_MISSING), { code: 'runtime-missing' });
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
// Compatibility IPC aliases; these no longer search for another installed app.
async function discover(a, options) {
  // 只返回真能用的路径：缓存优先；只有安装目录里的旧副本时返回那份旧副本，不报一个还不存在的缓存路径。
  try {
    const info = runtimeInfo(a, options);
    if (info.cached) return runtimeCachePath(a, info.baseline);
    return info.bundled ? bundledRuntime(options?.bundle).source : '';
  } catch { return ''; }
}
async function install(a, options) { return (await prepareRuntime(a, options)).exe; }
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
  bundledRuntime, runtimeSourcePaths, runtimeInfo, runtimeCachePath, prepareRuntime, foreignInstances, initializeHome, RUNTIME_MISSING };
