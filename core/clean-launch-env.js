'use strict';
// 干净启动环境（2026-10-19，用户要求：「以后要避免这种用户不从桌面打开就有 bug 的问题」）。
//
// 从桌面快捷方式打开的 Hub，环境是 Explorer 给的；由 Hub 自己拉起的 Hub（远程重启 / 重启并继续用 app.relaunch、
// 增量更新的替换脚本、完整安装包、任务栏「新 Hub」）以前原样继承当前进程的环境。只要某一代 Hub 是从会话的进程树里
// 启动的（公司 Hub 从号池会话里被拉起，带着 CODEAGENT3_CONFIG_DIR=号 1 的目录），这份环境就一代代传下去。
//
// 保守做法（用户定的原则：稳定优先，拿不准的先不做）：
//   1. 只去掉已确认会出问题的会话标记（SESSION_VARS / SESSION_PREFIXES）；
//   2. CODEAGENT3_CONFIG_DIR（或 AI_HUB_CODEAGENT_CONFIG_ENV 改过的名字）只在已确认不该用时去掉：它落在号池里，
//      或注册表里用户级 / 系统级都不是这个值（只在进程里出现）。注册表读不到时不动它
//      （Hub 自己的会话照旧不采用它，见 core/codeagent-config.js resolveCodeAgentConfig）；
//   3. PATH 和其他用户变量一律不动；
//   4. 工作目录只在明显异常（目录不存在、或在 Windows 系统目录里）时改成安装目录（源码运行为程序目录）。
// 隔离实例同样适用（CLAUDE_HUB_DATA_DIR 等实例身份、AI_HUB_* 显式设置都不在清单里）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_VARS = {
  CLAUDE_HUB_SESSION_ID: 'Hub 会话的 hook 身份：带着它，hook 会把事件记到启动 Hub 的那个会话名下',
  CLAUDE_HUB_PORT: 'Hub 会话的 hook 端口：指向启动它的那个 Hub',
  CLAUDE_HUB_TOKEN: 'Hub 会话的 hook 口令：属于启动它的那个 Hub',
  CLAUDE_HUB_SOFT_COMPACT: 'Hub 会话的软压缩标记：带着它，提醒钩子会让 AI 结束本轮等启动它的那个 Hub 来压缩',
  CODEAGENT3_LAUNCHER_PID: 'CodeAgent 启动器标记：说明 Hub 是从某个 CodeAgent 会话里拉起的',
  // 「禁止选择题」分支（fix/no-choice-prompt）给自动派活会话设的会话内部标记，hook 靠它判断要不要拦；
  // 用户不会持久设置这个开关，所以无条件清掉（审核 2026-10-19 确认）。
  AI_HUB_NO_CHOICE: '自动派活会话的「禁止选择题」内部标记：带着它，Hub 里所有会话都会被当成自动派活会话拦选择题',
};
const SESSION_PREFIXES = {
  CODEAGENT_HUB_: 'CodeAgent / CodeTeam 会话的 hook 标记：带着它，会话事件会投给别的程序',
};
const DEFAULT_CONFIG_ENV = 'CODEAGENT3_CONFIG_DIR';

const upper = name => String(name || '').toUpperCase();
const SESSION_UPPER = new Map(Object.keys(SESSION_VARS).map(k => [upper(k), k]));

function isSessionMarker(name) {
  const u = upper(name);
  return SESSION_UPPER.has(u) || Object.keys(SESSION_PREFIXES).some(p => u.startsWith(p));
}
function reasonFor(name) {
  const u = upper(name);
  if (SESSION_UPPER.has(u)) return SESSION_VARS[SESSION_UPPER.get(u)];
  const p = Object.keys(SESSION_PREFIXES).find(x => u.startsWith(x));
  return p ? SESSION_PREFIXES[p] : '';
}

function configEnvName(env = process.env) {
  const custom = String(env.AI_HUB_CODEAGENT_CONFIG_ENV || '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(custom) ? custom : DEFAULT_CONFIG_ENV;
}

// 继承来的 CodeAgent 配置目录该不该去掉：decision 是 core/codeagent-config.js decideInherited 的结论。
// 只有「落在号池里」「只在进程里出现（注册表里没有这个值）」两种确认不该用的情况去掉；采用的、读不到注册表的、
// 个人目录已显式指定的都不动。
const DROP_REASONS = new Set(['in-pool', 'process-only']);
function shouldDropConfigDir(decision) {
  return !!(decision && !decision.adopt && DROP_REASONS.has(decision.reason));
}

// 纯函数：去掉会话标记；decision 说该去掉时去掉 CodeAgent 配置目录变量。不改 baseEnv。
function buildCleanLaunchEnv(baseEnv = process.env, { decision = null } = {}) {
  const env = { ...baseEnv };
  const removed = [];
  for (const key of Object.keys(env)) {
    if (!isSessionMarker(key)) continue;
    delete env[key];
    removed.push({ name: key, reason: reasonFor(key) });
  }
  if (shouldDropConfigDir(decision)) {
    const name = decision.variable || configEnvName(baseEnv);
    for (const key of Object.keys(env)) {
      if (upper(key) !== upper(name) || String(env[key] || '').trim() === '') continue;
      delete env[key];
      removed.push({ name: key, reason: decision.reason === 'in-pool' ? 'CodeAgent 配置目录落在号池里（2026-10-19 公司事故）' : 'CodeAgent 配置目录只在进程里出现，注册表里没有这个设置' });
    }
  }
  return { env, removed };
}

// 工作目录是否明显异常：不存在，或在 Windows 系统目录里（隐藏的 PowerShell、服务拉起的进程常落在 System32）。
function abnormalCwd(dir, { exists = fs.existsSync, systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows', platform = process.platform } = {}) {
  if (!dir) return true;
  try { if (!exists(dir)) return true; } catch { return true; }
  if (platform !== 'win32') return false;
  const norm = v => path.win32.resolve(String(v)).replace(/[\\/]+$/, '').toLowerCase();
  const d = norm(dir), sys = norm(systemRoot);
  return d === sys || d.startsWith(sys + '\\');
}

// 桌面快捷方式里的工作目录：安装版是 exe 所在目录，源码运行是程序目录（core/windows-shell-integration.js buildLaunchSpec）。
function launchCwd({ execPath = process.execPath, appRoot, isPackaged = false, homeDir = os.homedir(), exists = fs.existsSync } = {}) {
  const dir = isPackaged || !appRoot ? path.dirname(path.resolve(execPath)) : path.resolve(appRoot);
  try { if (exists(dir)) return dir; } catch {}
  return homeDir;
}
// 新进程的工作目录：当前的正常就沿用（返回 null 表示不改），明显异常才换成安装目录。
function cwdFix(current, target = {}, opts = {}) {
  return abnormalCwd(current, opts) ? launchCwd({ ...target, ...(opts.exists ? { exists: opts.exists } : {}) }) : null;
}

// ---- Hub 主进程 ----
let startup = null;
let inheritedSnapshot = null;
let configDecision = null;

function eventLogWriter(dataDir) {
  if (!dataDir) return null;
  try { return require('./window-keep-rendering').createWindowEventLog(path.join(dataDir, 'logs', 'window-events.log'), { logger: {} }); } catch { return null; }
}

// main-bootstrap.js 最早处调用一次：会话标记立刻从 process.env 删掉（Hub 之后拉起的终端、CLI 都不再带）；
// 工作目录明显异常时改成安装目录。日志只写变量名，不写值。
function cleanOwnEnvAtStartup({ env = process.env, execPath = process.execPath, appRoot, isPackaged = false, dataDir = null,
  chdir = dir => process.chdir(dir), cwd = () => process.cwd(), logger = console, exists = fs.existsSync, systemRoot } = {}) {
  inheritedSnapshot = { ...env };
  const { removed } = buildCleanLaunchEnv(env);
  for (const r of removed) delete env[r.name];
  const initialCwd = (() => { try { return cwd(); } catch { return ''; } })();
  let cwdChanged = null;
  const fix = cwdFix(initialCwd, { execPath, appRoot, isPackaged }, { exists, ...(systemRoot ? { systemRoot } : {}) });
  if (fix) {
    try { chdir(fix); cwdChanged = { from: initialCwd, to: fix }; } catch (error) { cwdChanged = { from: initialCwd, to: fix, error: error.message }; }
  }
  startup = { at: Date.now(), removed, initialCwd, cwdChanged, configDir: null };
  if (removed.length || cwdChanged) {
    const names = removed.map(r => r.name);
    try { logger.warn?.(`[launch-env] Hub 继承了会话标记，已清掉：${names.join('、') || '（无）'}${cwdChanged ? '；工作目录异常，已改为安装目录' : ''}`); } catch {}
    const log = eventLogWriter(dataDir);
    if (log) log('launch-env-cleaned', { removed: names, cwdChanged: !!cwdChanged });
  }
  return startup;
}

// 继承的 CodeAgent 配置目录判定出来后（main.js codeagentInheritedReady）调用：确认不该用就从 process.env 删掉。
function applyConfigDirDecision(decision, { env = process.env, logger = console, dataDir = null } = {}) {
  configDecision = decision || null;
  if (!shouldDropConfigDir(decision)) return null;
  const removed = buildCleanLaunchEnv(env, { decision }).removed.filter(r => !isSessionMarker(r.name));
  for (const r of removed) delete env[r.name];
  if (!removed.length) return null;
  const info = { removed: removed.map(r => r.name), reason: decision.reason };
  if (startup) startup.configDir = info;
  try { logger.warn?.(`[launch-env] 继承的 ${info.removed.join('、')} 已从 Hub 进程环境去掉（${decision.reason === 'in-pool' ? '落在号池里' : '注册表里没有这个设置'}）`); } catch {}
  const log = eventLogWriter(dataDir);
  if (log) log('launch-env-configdir-dropped', info);
  return info;
}

function startupReport() { return startup; }
// 自检前的原始环境（没自检过就是当前环境）：直查报告「Hub 从哪个进程树里启动」、继承目录判定要看。
function inheritedEnv() { return inheritedSnapshot || process.env; }
function currentConfigDecision() { return configDecision; }

// 拉起新 Hub 前准备环境与工作目录（cwd 为 null 表示沿用当前的）。
// 判定还没出来时（启动后一两秒内就再启动）用 decide 现算（不读注册表：落在号池里照样去掉，其余不动）。
function prepareHubLaunch({ execPath = process.execPath, appRoot, isPackaged = false, env = process.env, decide = null,
  currentCwd = () => process.cwd() } = {}) {
  let decision = configDecision;
  if (!decision && typeof decide === 'function') { try { decision = decide(env); } catch { decision = null; } }
  const plan = buildCleanLaunchEnv(env, { decision });
  let cur = '';
  try { cur = currentCwd(); } catch { cur = ''; }
  return { ...plan, cwd: cwdFix(cur, { execPath, appRoot, isPackaged }) };
}

// app.relaunch 没有传环境和工作目录的参数，新进程继承调用那一刻的进程环境与工作目录（Electron 在 relaunch() 里就拉起
// 等待老进程退出的助手进程）。所以临时删掉要去掉的变量、必要时换工作目录 → app.relaunch → 立刻恢复。
// 兜底（审核 2026-10-19）：准备干净环境这一步（prepare、读工作目录、删变量）出错时，退回原来的 app.relaunch(options)
// 并记一条日志——清环境失败也不能影响 Hub 被拉起。app.relaunch 本身出错照原样抛出（和改动前一致）。
function relaunchApp(app, options = {}, target = {}, { prepare = prepareHubLaunch, logger = console, dataDir = null, cwd = () => process.cwd() } = {}) {
  const relaunchOptions = options && Object.keys(options).length ? options : undefined;
  let launch = null, beforeCwd = null;
  const saved = {};
  try {
    launch = prepare(target);
    for (const r of launch.removed) if (process.env[r.name] !== undefined) saved[r.name] = process.env[r.name];
    beforeCwd = cwd();
  } catch (error) {
    const message = String(error && error.message || error).slice(0, 200);
    try { logger.warn?.(`[launch-env] 准备干净启动环境失败，按原环境再启动：${message}`); } catch {}
    const log = eventLogWriter(dataDir);
    if (log) log('relaunch-clean-env-failed', { error: message });
    app.relaunch(relaunchOptions);
    return { removed: [], cwd: null, fallback: true, error: message };
  }
  try {
    try {
      for (const name of Object.keys(saved)) delete process.env[name];
      if (launch.cwd) { try { process.chdir(launch.cwd); } catch {} }
    } catch (error) {
      try { logger.warn?.(`[launch-env] 去掉会话标记失败，按原环境再启动：${error && error.message}`); } catch {}
    }
    app.relaunch(relaunchOptions);
  } finally {
    for (const [k, v] of Object.entries(saved)) { try { process.env[k] = v; } catch {} }
    if (launch.cwd && beforeCwd) { try { process.chdir(beforeCwd); } catch {} }
  }
  const summary = { removed: launch.removed.map(r => r.name), cwd: launch.cwd || null };
  try { logger.log?.(`[launch-env] 再启动：去掉 ${summary.removed.join('、') || '（无）'}${summary.cwd ? '；工作目录异常，改为安装目录' : ''}`); } catch {}
  const log = eventLogWriter(dataDir);
  if (log) log('relaunch-clean-env', summary);
  return summary;
}

module.exports = {
  SESSION_VARS, SESSION_PREFIXES, DEFAULT_CONFIG_ENV,
  isSessionMarker, reasonFor, configEnvName, shouldDropConfigDir, buildCleanLaunchEnv, abnormalCwd, launchCwd, cwdFix,
  cleanOwnEnvAtStartup, applyConfigDirDecision, startupReport, inheritedEnv, currentConfigDecision, prepareHubLaunch, relaunchApp,
};
