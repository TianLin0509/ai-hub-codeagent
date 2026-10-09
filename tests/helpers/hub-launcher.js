// tests/helpers/hub-launcher.js
//
// 安全启动隔离 Hub 实例 + CDP 控制 + 优雅关闭。
//
// 铁律（feedback_e2e_pid_whitelist.md / feedback_hub_isolation_env_pitfall.md）：
//   - PID 白名单：spawn 时拿 child.pid，关闭只针对这个 PID + 通过 CDP Browser.close
//   - 严禁 Get-Process electron / 时间窗口 PID 推断
//   - 严禁 Start-Process（不继承 env）；用 child_process.spawn 直接传 env
//   - 隔离数据目录：CLAUDE_HUB_DATA_DIR 必须设
//   - 隔离规范库：CLAUDE_HUB_HOME_DIR 默认落到 dataDir 下，且默认清空
//     DEEPSEEK_API_KEY，防止梦境任务扫描/改写真实 home；需要真实 Key 的专项
//     用例必须通过 extraEnv 显式覆盖。
//
// 用法：
//   const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
//   const hub = await launchIsolatedHub({ dataDir, port });
//   // ...do CDP work via hub.cdpUrl...
//   await gracefulQuit(hub);

const { execFile: execFileCallback, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { promisify } = require('util');

const execFileAsync = promisify(execFileCallback);

const HUB_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON_EXE = path.join(HUB_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PARENT_CONTROL_ENV_KEYS = new Set([
  'CLAUDECODE',
  'CLAUDE_HUB_PORT',
  'CLAUDE_HUB_TOKEN',
  'CLAUDE_HUB_SESSION_ID',
  'AI_TEAM_HUB_CALLBACK_URL',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
]);

function scrubParentControlEnv(baseEnv = {}) {
  const clean = { ...baseEnv };
  for (const key of Object.keys(clean)) {
    if (PARENT_CONTROL_ENV_KEYS.has(key)
        || key.startsWith('CLAUDE_CODE_')
        || key.startsWith('ARENA_HUB_')) {
      delete clean[key];
    }
  }
  return clean;
}

function _isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// 2026-09-26：测试 Hub 默认「后台窗口」—— 照常渲染，但在屏幕外、不激活、不进任务栏，
// 不会从正在 Hub 里打字的用户手里抢走键盘（见 core/e2e-desktop-sandbox.js）。
// 写 'visible' 的老测试同样按后台跑；真要看着它跑，设 HUB_E2E_SHOW_WINDOWS=1。
const WINDOW_MODES = new Set(['background', 'visible', 'hidden']);
function effectiveWindowMode(windowMode, env = process.env) {
  if (!WINDOW_MODES.has(windowMode)) {
    throw new Error('isolated Hub windowMode must be background, visible or hidden');
  }
  return windowMode === 'visible' && env.HUB_E2E_SHOW_WINDOWS !== '1' ? 'background' : windowMode;
}

function buildIsolatedHubEnv(dataDir, extraEnv = {}, baseEnv = process.env, {
  allowExternalState = false,
  windowMode = 'background',
} = {}) {
  windowMode = effectiveWindowMode(windowMode, baseEnv);
  const resolvedDataDir = path.resolve(dataDir);
  const testRoot = path.dirname(resolvedDataDir);
  const requestedDataDir = extraEnv.CLAUDE_HUB_DATA_DIR;
  const requestedHomeDir = extraEnv.CLAUDE_HUB_HOME_DIR;
  const requestedAgentLeagueDir = extraEnv.XRESEARCH_AGENT_LEAGUE_DIR;
  const requestedStudyDir = extraEnv.AGENT_STUDY_DIR;
  const requestedWritingRoot = extraEnv.CLAUDE_HUB_WRITING_ROOT;
  const requestedWritingSkills = extraEnv.CLAUDE_HUB_WRITING_SKILLS_DIR || extraEnv.CLAUDE_HUB_VOICE_DIR;
  const requestedCodexHome = extraEnv.CODEX_HOME;
  const requestedClaudeConfigDir = extraEnv.CLAUDE_CONFIG_DIR;
  const requestedKey = extraEnv.DEEPSEEK_API_KEY;
  if (!allowExternalState) {
    const tempRoot = path.resolve(os.tmpdir());
    if (resolvedDataDir === tempRoot || !_isPathInside(tempRoot, resolvedDataDir)) {
      throw new Error('isolated Hub requires dataDir inside a dedicated OS temp subdirectory');
    }
    if (requestedDataDir && path.resolve(requestedDataDir) !== resolvedDataDir) {
      throw new Error('isolated Hub forbids overriding CLAUDE_HUB_DATA_DIR');
    }
    if (requestedHomeDir && !_isPathInside(testRoot, requestedHomeDir)) {
      throw new Error('isolated Hub requires CLAUDE_HUB_HOME_DIR inside the test root');
    }
    if (requestedAgentLeagueDir && !_isPathInside(testRoot, requestedAgentLeagueDir)) {
      throw new Error('isolated Hub requires XRESEARCH_AGENT_LEAGUE_DIR inside the test root');
    }
    if (requestedStudyDir && !_isPathInside(testRoot, requestedStudyDir)) {
      throw new Error('isolated Hub requires AGENT_STUDY_DIR inside the test root');
    }
    if (requestedWritingRoot && !_isPathInside(testRoot, requestedWritingRoot)) {
      throw new Error('isolated Hub requires CLAUDE_HUB_WRITING_ROOT inside the test root');
    }
    if (requestedWritingSkills && !_isPathInside(testRoot, requestedWritingSkills)) {
      throw new Error('isolated Hub requires writing skill dirs inside the test root');
    }
    if (requestedCodexHome && !_isPathInside(testRoot, requestedCodexHome)) {
      throw new Error('isolated Hub requires CODEX_HOME inside the test root');
    }
    if (requestedClaudeConfigDir && !_isPathInside(testRoot, requestedClaudeConfigDir)) {
      throw new Error('isolated Hub requires CLAUDE_CONFIG_DIR inside the test root');
    }
    if (requestedKey) throw new Error('isolated Hub forbids a non-empty DEEPSEEK_API_KEY');
  }
  const cleanBaseEnv = scrubParentControlEnv(baseEnv);
  const safeExtraEnv = { ...extraEnv };
  delete safeExtraEnv.CLAUDE_HUB_DATA_DIR;
  delete safeExtraEnv.CLAUDE_HUB_HOME_DIR;
  delete safeExtraEnv.DEEPSEEK_API_KEY;
  delete safeExtraEnv.XRESEARCH_AGENT_LEAGUE_DIR;
  delete safeExtraEnv.AGENT_STUDY_DIR;
  delete safeExtraEnv.CLAUDE_HUB_E2E_WINDOW_MODE;
  const env = {
    ...cleanBaseEnv,
    ...safeExtraEnv,
    CLAUDE_HUB_DATA_DIR: allowExternalState && requestedDataDir ? requestedDataDir : resolvedDataDir,
    CLAUDE_HUB_HOME_DIR: requestedHomeDir || path.join(resolvedDataDir, 'isolated-home'),
    XRESEARCH_AGENT_LEAGUE_DIR: requestedAgentLeagueDir || path.join(resolvedDataDir, 'agent-league'),
    // 2026-09-08：学习任务的产物目录也必须隔离。合并位撞到过 —— 测试 Hub 起来后
    // 自动开了学习任务，真的往 C:\Workspace\AIgent-study 写了新文件。
    AGENT_STUDY_DIR: requestedStudyDir || path.join(resolvedDataDir, 'agent-study'),
    // 2026-09-30：写作 Tab 会在写作根目录新建篇目、在文风 skill 里写回确认。
    // 默认写作根指向用户真实的写作工坊，测试实例必须圈进临时目录；
    // 文风 skill 默认跟 CLAUDE_HUB_HOME_DIR 走，上面已经隔离。
    CLAUDE_HUB_WRITING_ROOT: requestedWritingRoot || path.join(resolvedDataDir, 'writing'),
    DEEPSEEK_API_KEY: allowExternalState && requestedKey ? requestedKey : '',
    CLAUDE_HUB_E2E_WINDOW_MODE: windowMode,
  };
  if (windowMode === 'hidden') env.CLAUDE_HUB_E2E = '1';
  // 2026-09-25 起 Claude / Codex 默认跑 PTY。带原生协议夹具的用例测的就是原生后端，
  // 这里替它们打开回退开关；显式传了 CLAUDE_HUB_AGENT_RUNTIME 的以调用方为准。
  if (!safeExtraEnv.CLAUDE_HUB_AGENT_RUNTIME
      && (safeExtraEnv.CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE || safeExtraEnv.CLAUDE_HUB_CLAUDE_STREAM_FIXTURE)) {
    env.CLAUDE_HUB_AGENT_RUNTIME = 'native';
  }
  return env;
}

function _waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function _waitForCDP(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ver = await _httpGetJson(`http://127.0.0.1:${port}/json/version`);
    if (ver && ver.webSocketDebuggerUrl) return ver;
    await _waitMs(300);
  }
  return null;
}

function _httpCloseTarget(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP close request timed out')));
  });
}

async function _verifyCdpPortOwner(port, expectedPid, execFile = execFileAsync) {
  const numericPort = Number(port);
  const numericPid = Number(expectedPid);
  if (!Number.isInteger(numericPort) || numericPort <= 0
      || !Number.isInteger(numericPid) || numericPid <= 0) return false;
  if (process.platform !== 'win32') return false;
  // netstat is substantially faster and less prone to transient CIM provider
  // stalls than Get-NetTCPConnection on a machine with many short-lived E2E
  // Electron processes. Parse only LISTENING rows for this exact local port.
  try {
    const result = await execFile('netstat.exe', ['-ano', '-p', 'TCP'], {
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const owners = String(result && result.stdout || '')
      .split(/\r?\n/)
      .map(line => line.trim().split(/\s+/))
      .filter(parts => parts.length >= 5
        && String(parts[0]).toUpperCase() === 'TCP'
        && String(parts[1]).endsWith(`:${numericPort}`)
        && String(parts[3]).toUpperCase() === 'LISTENING')
      .map(parts => Number(parts[parts.length - 1]))
      .filter(Number.isInteger);
    if (owners.length > 0) return owners.includes(numericPid);
  } catch {}

  const script = [
    "$ErrorActionPreference='Stop'",
    `$owners = @(Get-NetTCPConnection -State Listen -LocalPort ${numericPort} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
    "[Console]::Out.Write(($owners -join ','))",
  ].join('; ');
  try {
    const result = await execFile('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
    const owners = String(result && result.stdout || '')
      .split(',')
      .map(value => Number(value.trim()))
      .filter(Number.isInteger);
    return owners.includes(numericPid);
  } catch {
    return false;
  }
}

async function _waitForCdpPortOwner(port, expectedPid, timeoutMs = 1500, verify = _verifyCdpPortOwner) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    if (await verify(port, expectedPid)) return true;
    if (Date.now() >= deadline) break;
    await _waitMs(100);
  } while (true);
  return false;
}

async function _terminateSpawnedChild(child, { termWaitMs = 2000, killWaitMs = 1200 } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) {
    return { exited: true, forced: false };
  }
  let termSent = false;
  try { termSent = child.kill('SIGTERM') === true; } catch {}
  const termDeadline = Date.now() + termWaitMs;
  while (Date.now() < termDeadline && child.exitCode == null && child.signalCode == null) {
    await _waitMs(100);
  }
  if (child.exitCode != null || child.signalCode != null) {
    return { exited: true, forced: true, termSent };
  }
  let killSent = false;
  try { killSent = child.kill('SIGKILL') === true; } catch {}
  const killDeadline = Date.now() + killWaitMs;
  while (Date.now() < killDeadline && child.exitCode == null && child.signalCode == null) {
    await _waitMs(100);
  }
  return {
    exited: child.exitCode != null || child.signalCode != null,
    forced: true,
    termSent,
    killSent,
  };
}

async function launchIsolatedHub({
  dataDir,
  port,
  label = 'hub',
  extraEnv = {},
  executablePath = ELECTRON_EXE,
  allowExternalState = false,
  windowMode = 'background',
  entryPath = HUB_ROOT,
} = {}) {
  if (!dataDir) throw new Error('dataDir required');
  if (!port) throw new Error('port required');
  windowMode = effectiveWindowMode(windowMode);

  const env = buildIsolatedHubEnv(dataDir, extraEnv, process.env, {
    allowExternalState,
    windowMode,
  });
  fs.mkdirSync(env.CLAUDE_HUB_DATA_DIR, { recursive: true });
  const isolatedHomeDir = env.CLAUDE_HUB_HOME_DIR;
  fs.mkdirSync(isolatedHomeDir, { recursive: true });
  // main-bootstrap.js 会把 Electron userData 切到这个子目录；Chromium 在目录不存在时
  // 偶发无法写 DevToolsActivePort，表现为 CDP 已监听但 renderer 永远不响应。
  fs.mkdirSync(path.join(env.CLAUDE_HUB_DATA_DIR, 'electron-userdata'), { recursive: true });

  const args = [entryPath, `--remote-debugging-port=${port}`];
  // 关键：spawn 立即拿 PID，detached:false 让 child 跟随 parent 退出
  const child = spawn(executablePath, args, {
    env,
    cwd: HUB_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let spawnError = null;
  child.on('error', (error) => { spawnError = error; });

  const pid = child.pid;
  if (!pid) throw new Error(`[${label}] spawn failed, no PID`);
  // Test Hubs yield the CPU to the person using the production Hub. Children
  // (renderers, CLI fixtures) inherit a below-normal priority class on Windows.
  if (process.env.HUB_TEST_PRIORITY !== 'normal' && os.constants.priority) {
    try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  }

  const logLines = [];
  child.stdout?.on('data', d => {
    const s = d.toString();
    logLines.push(...s.split(/\r?\n/).filter(Boolean));
    if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  });
  child.stderr?.on('data', d => {
    const s = d.toString();
    logLines.push(...s.split(/\r?\n/).filter(Boolean));
    if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  });

  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal || null;
  });

  // 等 CDP ready (最长 30s)
  const ver = await _waitForCDP(port, 30000);
  if (spawnError || exited) {
    const termination = exited ? null : await _terminateSpawnedChild(child);
    const err = new Error(`[${label}] hub exited before CDP ready (code=${exitCode}, signal=${exitSignal || 'none'}): ${spawnError ? spawnError.message : 'early exit'}`);
    err.logTail = logLines.slice(-30).join('\n');
    if (termination) err.termination = termination;
    throw err;
  }
  if (!ver) {
    const termination = await _terminateSpawnedChild(child);
    const err = new Error(`[${label}] CDP not ready within 30s`);
    err.logTail = logLines.slice(-30).join('\n');
    err.termination = termination;
    throw err;
  }
  const identityVerified = await _waitForCdpPortOwner(port, pid, 1500);
  if (!identityVerified) {
    const termination = await _terminateSpawnedChild(child);
    const err = new Error(`[${label}] CDP port ${port} is not owned by spawned PID ${pid}; refusing to attach`);
    err.logTail = logLines.slice(-30).join('\n');
    err.termination = termination;
    throw err;
  }

  return {
    pid,
    port,
    label,
    dataDir,
    executablePath,
    windowMode,
    cdpUrl: ver.webSocketDebuggerUrl,
    cdpHttpBase: `http://127.0.0.1:${port}`,
    child,
    log: () => logLines.slice(),
    isAlive: () => !exited,
    exitCode: () => exitCode,
    exitSignal: () => exitSignal,
    spawnError: () => spawnError,
    identityVerified,
  };
}

function hubHasExited(hub) {
  return !!hub && (
    (typeof hub.isAlive === 'function' && !hub.isAlive())
    || (hub.child && hub.child.exitCode != null)
    || (hub.child && hub.child.signalCode != null)
  );
}

function requireCleanHubExit(hub, { forced = false } = {}) {
  const code = typeof hub.exitCode === 'function' ? hub.exitCode() : hub.child && hub.child.exitCode;
  const signal = typeof hub.exitSignal === 'function' ? hub.exitSignal() : hub.child && hub.child.signalCode;
  if (!forced && code === 0 && !signal) return { code, signal: null, forced: false };

  const details = `code=${code == null ? 'null' : code}, signal=${signal || 'none'}, forced=${forced}`;
  const error = new Error(`[${hub.label || 'hub'}] Hub did not exit cleanly (${details})`);
  error.exitCode = code;
  error.signal = signal || null;
  error.forced = forced;
  error.logTail = typeof hub.log === 'function' ? hub.log().slice(-40).join('\n') : '';
  throw error;
}

function _assertCleanHubExit(hub, context) {
  const spawnError = hub.spawnError && hub.spawnError();
  const exitCode = hub.exitCode ? hub.exitCode() : hub.child && hub.child.exitCode;
  const exitSignal = hub.exitSignal ? hub.exitSignal() : hub.child && hub.child.signalCode;
  if (spawnError || exitCode !== 0 || exitSignal) {
    const detail = spawnError ? spawnError.message : `code=${exitCode}, signal=${exitSignal || 'none'}`;
    const error = new Error(`[${hub.label || 'hub'}] ${context}: ${detail}`);
    error.logTail = hub.log ? hub.log().slice(-30).join('\n') : '';
    throw error;
  }
  return { exitCode, exitSignal: exitSignal || null, forced: false };
}

// 通过已验证属于本次 spawn PID 的 CDP 页面优雅关闭。任何强制终止、非零
// 退出或身份丢失都作为测试失败上抛，不能把 crash/残留伪装成 PASS。
// Production shutdown deliberately allows SessionManager up to 15s to drain
// node-pty callbacks safely. The verifier must wait longer than that contract;
// an 8s test timeout otherwise force-kills a healthy stress run mid-drain and
// reports the harness timeout as a product crash.
async function gracefulQuit(hub, { timeoutMs = 20_000, allowAlreadyExited = false } = {}) {
  if (!hub) return { exitCode: null, exitSignal: null, forced: false };
  if (!hub.isAlive || !hub.isAlive()) {
    const cleanExit = _assertCleanHubExit(hub, 'exited before teardown');
    if (allowAlreadyExited) return cleanExit;
    const error = new Error(`[${hub.label || 'hub'}] exited before teardown was requested`);
    error.exit = cleanExit;
    throw error;
  }
  if (!hub.identityVerified || !await _waitForCdpPortOwner(hub.port, hub.pid, 1000)) {
    // The CDP listener can disappear a fraction before Electron emits `exit`.
    // Never attach to or close an unverified port, but allow the exact spawned
    // child a short window to finish a clean shutdown on its own.
    const exitDeadline = Date.now() + 1000;
    while (Date.now() < exitDeadline && hub.isAlive()) await _waitMs(100);
    if (!hub.isAlive()) return _assertCleanHubExit(hub, 'clean exit while CDP listener closed');
    const termination = await _terminateSpawnedChild(hub.child);
    const error = new Error(`[${hub.label || 'hub'}] CDP identity changed; refused to close an unverified target`);
    error.termination = termination;
    throw error;
  }

  let closeError = null;
  try {
    const targets = await _httpGetJson(`${hub.cdpHttpBase}/json/list`);
    if (!Array.isArray(targets)) throw new Error('CDP target list unavailable');
    const page = targets.find(target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''))
      || targets.find(target => target.type === 'page');
    if (!page) throw new Error('Hub page target unavailable');
    const closed = await _httpCloseTarget(`${hub.cdpHttpBase}/json/close/${encodeURIComponent(page.id)}`);
    if (!closed) throw new Error('CDP close endpoint rejected the Hub page');
  } catch (error) {
    closeError = error;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!hub.isAlive()) {
      const cleanExit = _assertCleanHubExit(hub, 'unclean exit during teardown');
      if (closeError) {
        const error = new Error('CDP close failed before clean Hub exit: ' + closeError.message);
        error.exit = cleanExit;
        throw error;
      }
      _recordRealHubRun(hub);
      return cleanExit;
    }
    await _waitMs(200);
  }

  const termination = await _terminateSpawnedChild(hub.child);
  const error = new Error(`[${hub.label || 'hub'}] graceful teardown timed out${closeError ? `: ${closeError.message}` : ''}`);
  error.termination = termination;
  error.logTail = hub.log ? hub.log().slice(-30).join('\n') : '';
  throw error;
}

// Evidence for the commit guard (~/.claude/scripts/unified_bash_guard.py): a
// real isolated Hub was launched, driven over CDP and shut down cleanly.
function _recordRealHubRun(hub) {
  try {
    fs.writeFileSync(path.join(os.tmpdir(), '.e2e-tested'), JSON.stringify({
      ts: Date.now() / 1000, tool: 'hub-launcher', label: hub.label || 'hub', windowMode: hub.windowMode || null,
    }));
  } catch {}
}

// 列出 CDP 上所有 page targets（用于挑选 main window 来 attach）
async function listCdpTargets(hub) {
  if (!hub || !hub.identityVerified || !hub.isAlive()
      || !await _verifyCdpPortOwner(hub.port, hub.pid)) {
    throw new Error('refusing to list CDP targets for an unverified Hub instance');
  }
  return await _httpGetJson(`${hub.cdpHttpBase}/json/list`) || [];
}

module.exports = {
  buildIsolatedHubEnv,
  scrubParentControlEnv,
  launchIsolatedHub,
  gracefulQuit,
  listCdpTargets,
  _terminateSpawnedChild,
  _verifyCdpPortOwner,
  _waitForCdpPortOwner,
  _waitMs,  // 给 e2e 用
  _private: {
    hubHasExited,
    requireCleanHubExit,
  },
};
