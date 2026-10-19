'use strict';
// 公司内部 Code Agent CLI 的启动配置。
//
// 这个 CLI 的界面、配置文件、会话记录与 hook 都是 Claude Code 形态（2026-10-08 两轮公司实测），
// Hub 按 Claude 家族接入，只在这里集中描述它与 Claude 不同的地方：
//   - 命令名默认 `codeagent`（安装目录里的 .bat 包装，负责企业证书与代理环境）；
//   - 配置目录由 CODEAGENT3_CONFIG_DIR 指定，默认 ~/.cac（相当于 CLAUDE_CONFIG_DIR / ~/.claude）；Hub 启动会话时显式写这个变量，
//     Hub 继承来的这个变量只在注册表里也这样设、且不在号池里时才当个人目录（见 resolveCodeAgentConfig），
//     状态文件是 .cac.json（相当于 .claude.json）；
//   - 不认 --session-id 与 --settings：会话身份只能等第一个 hook 上报后绑定，Hub 的 hook
//     只能写进配置目录的 settings.json；
//   - 必须带 --disable-update，否则启动时弹出阻塞的「版本更新提醒」。
//
// 命令名、配置目录变量名和配置目录都可覆盖（AI_HUB_CODEAGENT_* 环境变量优先，其次 config.json 的
// providers.codeagent），没有这个 CLI 的电脑可以指向测试替身
// tests/fixtures/codeagent-standin/codeagent.cmd（内部启动真 Claude Code）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_COMMAND = 'codeagent';
const DEFAULT_CONFIG_ENV = 'CODEAGENT3_CONFIG_DIR';
const STATE_FILE = '.cac.json';
// 已知模型；公司内部还有 deepseek… 等名字，按字符校验放行（见 core/codeagent-models.js）。
const codeAgentModels = require('./codeagent-models');
const MODELS = Object.freeze(codeAgentModels.KNOWN.map(option => option.id));
const DEFAULT_MODEL = codeAgentModels.DEFAULT_MODEL;
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);
// 实测能从 settings.json 触发的事件（公司探测第一轮 P5 与 CodeTeam 现有登记的并集）。
// 只登记这些，避免未知事件名让整份 settings.json 校验失败——这份文件同事的其他工具也在用。
const HOOK_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PermissionRequest',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification']);

function hubProviderConfig() {
  try {
    const config = require('./hub-config').getConfig();
    const value = config && config.providers && config.providers.codeagent;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function configDirEnvName(env = process.env, provider = hubProviderConfig()) {
  const name = cleanString(env.AI_HUB_CODEAGENT_CONFIG_ENV) || cleanString(provider.configDirEnv) || DEFAULT_CONFIG_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`CodeAgent 配置目录变量名无效：${name}`);
  return name;
}

// 个人账号的配置目录（2026-10-19 公司真机事故后收紧），按优先级：
//   1. AI_HUB_CODEAGENT_CONFIG_DIR；2. Hub 设置 providers.codeagent.configDir；
//   3. Hub 进程继承来的 CODEAGENT3_CONFIG_DIR——只有它同时满足两条才采用：①注册表里的用户级或系统级环境变量就是它（同一目录）；
//      ②它和号池不重叠。判定在 Hub 启动时做一次（loadInheritedDecision，读注册表），结果缓存；这里只比缓存，不读注册表；
//   4. 默认 ~/.cac。
// 事故：公司 Hub 曾带着号池号 1 的目录启动（从某个号池会话的进程树里启动，之后的远程重启 / 更新又原样带下去），
// 「个人账号」会话全开在号 1 的目录里、号池同步又把号 1 的模型写回「个人」settings.json。
// 有的同事在用户级 / 系统级环境变量里把它指向自己的 CodeAgent 目录（不在号池里），这种照旧采用（审核 2026-10-19）。
// 注册表读不出来、出错时一律忽略：宁可落到 ~/.cac，也不回到号 1。
// 变量名本身照旧用：启动 CodeAgent 时由 Hub 把真正的配置目录显式写进这个变量。
function resolveCodeAgentConfig(env = process.env, provider = hubProviderConfig(), { decision = inheritedDecision } = {}) {
  const command = cleanString(env.AI_HUB_CODEAGENT_COMMAND) || cleanString(provider.command) || DEFAULT_COMMAND;
  const configDirEnv = configDirEnvName(env, provider);
  if (/[\r\n"`$;&|<>]/.test(command)) throw new Error('CodeAgent 命令包含不允许的字符');
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const explicit = cleanString(env.AI_HUB_CODEAGENT_CONFIG_DIR) || cleanString(provider.configDir);
  let configDir = explicit ? path.resolve(explicit) : '';
  if (!configDir) {
    const adopted = adoptedInheritedDir(env, provider, decision);
    configDir = adopted || path.resolve(path.join(home, '.cac'));
  }
  return { command, configDirEnv, configDir, stateFile: STATE_FILE };
}

// 缓存的判定只认当时那一份继承值（变量名与值都要一样）：不读注册表、不碰磁盘，纯字符串比较。
function adoptedInheritedDir(env, provider, decision) {
  if (!decision || !decision.adopt) return '';
  const inherited = inheritedConfigDir(env, provider);
  return inherited && decision.variable === configDirEnvName(env, provider) && decision.inherited === inherited ? inherited : '';
}

// 比较两个目录是否同一个 / 互相包含：先 realpath（解开 junction、符号链接和 8.3 短名；目录还不存在时解开它最近的已存在上级），
// Windows 上再统一分隔符、转小写。只用于判定，不用于拼路径。
// UNC 路径（\\server\share）不做 realpath，只按字面比：网络盘不通时 realpath 会卡住（审核 2026-10-19）。
function canonicalDir(dir, { fsModule = fs, platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let abs = p.resolve(String(dir || ''));
  const unc = platform === 'win32' && /^[\\/]{2}/.test(abs);
  const tail = [];
  for (let cur = abs; !unc;) {
    let real = null;
    try { real = (fsModule.realpathSync && (fsModule.realpathSync.native || fsModule.realpathSync))(cur); } catch { real = null; }
    if (typeof real === 'string' && real) { abs = tail.length ? p.join(real, ...tail.slice().reverse()) : real; break; }
    const parent = p.dirname(cur);
    if (parent === cur) break;
    tail.push(p.basename(cur));
    cur = parent;
  }
  if (platform === 'win32') abs = abs.replace(/\//g, '\\').replace(/^\\\\\?\\(UNC\\)?/i, (m, u) => (u ? '\\\\' : '')).toLowerCase();
  const sep = platform === 'win32' ? '\\' : '/';
  while (abs.length > 1 && abs.endsWith(sep) && !/^[a-z]:\\$/i.test(abs)) abs = abs.slice(0, -1);
  return abs;
}
function sameDir(a, b, opts = {}) {
  if (!a || !b) return false;
  return canonicalDir(a, opts) === canonicalDir(b, opts);
}
// 相同，或一个在另一个里面
function dirsOverlap(a, b, opts = {}) {
  if (!a || !b) return false;
  const x = canonicalDir(a, opts), y = canonicalDir(b, opts);
  if (x === y) return true;
  const sep = (opts.platform || process.platform) === 'win32' ? '\\' : '/';
  const under = (child, parent) => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  return under(x, y) || under(y, x);
}

// Hub 进程继承来的配置目录变量：没有返回 ''。
function inheritedConfigDir(env = process.env, provider = hubProviderConfig()) {
  let name;
  try { name = configDirEnvName(env, provider); } catch { return ''; }
  const value = cleanString(env[name]);
  return value ? path.resolve(value) : '';
}

// 读注册表里用户级、系统级环境变量（.NET [Environment]::GetEnvironmentVariable(name, 'User'/'Machine')，隐藏窗口，有超时）。
// 输出先转 UTF-8 再 base64，和本机代码页无关，中文用户名路径也比得上（reg.exe 的输出是 GBK，审核 2026-10-19）。
// 返回 { user, system, error }：没设置是 null；读取出错 / 超时 error 是原因（调用方按「读不到」处理，不当成「没设置」）。
function readPersistentEnv(name, { execFileImpl = null, timeoutMs = 8000, platform = process.platform } = {}) {
  if (platform !== 'win32') return Promise.resolve({ user: null, system: null, error: '不是 Windows' });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''))) return Promise.resolve({ user: null, system: null, error: '变量名无效' });
  const run = execFileImpl || require('child_process').execFile;
  const script = `$u=[Environment]::GetEnvironmentVariable('${name}','User');$m=[Environment]::GetEnvironmentVariable('${name}','Machine');`
    + `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress @{u=$u;m=$m})))`;
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    try {
      run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
          if (error) return finish({ user: null, system: null, error: error.killed || error.signal ? '读取超时' : String(error.message || error).slice(0, 200) });
          try {
            const parsed = JSON.parse(Buffer.from(String(stdout || '').trim(), 'base64').toString('utf8'));
            const pick = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
            finish({ user: pick(parsed && parsed.u), system: pick(parsed && parsed.m), error: null });
          } catch (e) { finish({ user: null, system: null, error: '输出解析不了：' + String(e.message || e).slice(0, 120) }); }
        });
    } catch (error) { finish({ user: null, system: null, error: String(error.message || error).slice(0, 200) }); }
  });
}

// 对继承值下结论（纯函数，给定注册表读数）。返回 null（没有继承值，或它就是默认 ~/.cac）或：
//   { variable, inherited, adopt, reason, origin, inPool, inPoolAccount }
// reason：adopted-user-env / adopted-system-env（采用）；process-only（只在进程里出现，忽略）；in-pool（落在号池，忽略）；
//         unverified（注册表读不到，忽略）；explicit（个人目录已显式指定，不看它）。
// origin：user-env / system-env / process-only / unknown（读注册表出错）。
function decideInherited({ env = process.env, provider = hubProviderConfig(), dataDir = null, persisted = null } = {}) {
  const inherited = inheritedConfigDir(env, provider);
  if (!inherited) return null;
  let variable = DEFAULT_CONFIG_ENV;
  try { variable = configDirEnvName(env, provider); } catch { return null; }
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const explicit = cleanString(env.AI_HUB_CODEAGENT_CONFIG_DIR) || cleanString(provider.configDir);
  const base = { variable, inherited, adopt: false, inPool: false, inPoolAccount: null };
  if (explicit && sameDir(inherited, explicit)) return null;
  if (!explicit && sameDir(inherited, path.join(home, '.cac'))) return null;
  const origin = !persisted || persisted.error ? 'unknown'
    : sameDir(persisted.user, inherited) ? 'user-env' : sameDir(persisted.system, inherited) ? 'system-env' : 'process-only';
  let match = null, poolError = false;
  if (dataDir) { try { match = require('./codeagent-pool').poolDirMatch(dataDir, inherited); } catch { poolError = true; } }
  const out = { ...base, origin, inPool: !!match, inPoolAccount: match && match.id ? match.id : null };
  if (explicit) return { ...out, reason: 'explicit' };
  if (match) return { ...out, reason: 'in-pool' };
  if (origin === 'unknown' || poolError || !dataDir) return { ...out, reason: 'unverified' };
  if (origin === 'user-env' || origin === 'system-env') return { ...out, adopt: true, reason: 'adopted-' + origin };
  return { ...out, reason: 'process-only' };
}

// Hub 启动时调用一次：只有继承值存在且不是默认目录时才读注册表；结果缓存给 resolveCodeAgentConfig 用。
let inheritedDecision = null;
async function loadInheritedDecision({ env = process.env, provider = hubProviderConfig(), dataDir = null, read = readPersistentEnv } = {}) {
  let decision = decideInherited({ env, provider, dataDir, persisted: { user: null, system: null, error: '还没读' } });
  // 落在号池、或个人目录已显式指定时也读一次：结论不变（忽略），但直查要报它来自哪一层，用来查继承从哪来
  if (decision) {
    let persisted;
    try { persisted = await read(decision.variable); } catch (error) { persisted = { user: null, system: null, error: String(error.message || error) }; }
    decision = decideInherited({ env, provider, dataDir, persisted });
  }
  inheritedDecision = decision;
  return decision;
}
function setInheritedDecision(decision) { inheritedDecision = decision || null; }
function getInheritedDecision() { return inheritedDecision; }

// 个人账号配置目录从哪来（直查用，不带路径）：hub-env = AI_HUB_CODEAGENT_CONFIG_DIR；hub-config = config.json 的 providers.codeagent.configDir；
// inherited-user-env / inherited-system-env = 采用了继承来的值（注册表里用户级 / 系统级设置的就是它）；
// ignored-inherited-env = 默认 ~/.cac，Hub 进程继承了一个指向别处的值但没采用；default = ~/.cac。
// 2.1.14 以前继承来的值一律当成个人目录（当时这里报 codeagent-env）。
function configDirSource(env = process.env, provider = hubProviderConfig(), { decision = inheritedDecision } = {}) {
  if (cleanString(env.AI_HUB_CODEAGENT_CONFIG_DIR)) return 'hub-env';
  if (cleanString(provider.configDir)) return 'hub-config';
  if (adoptedInheritedDir(env, provider, decision)) return decision.origin === 'system-env' ? 'inherited-system-env' : 'inherited-user-env';
  const inherited = inheritedConfigDir(env, provider);
  if (inherited) {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    if (!sameDir(inherited, path.join(home, '.cac'))) return 'ignored-inherited-env';
  }
  return 'default';
}

const INHERITED_NOTE = 'Hub 进程继承了一个指向别处的 CodeAgent 配置目录';
const INHERITED_NOTES = {
  'adopted-user-env': 'Hub 进程继承的 CodeAgent 配置目录就是用户级环境变量里设的，已采用为个人目录',
  'adopted-system-env': 'Hub 进程继承的 CodeAgent 配置目录就是系统级环境变量里设的，已采用为个人目录',
  'process-only': INHERITED_NOTE + '（只在进程里出现），已忽略',
  'in-pool': INHERITED_NOTE + '（落在号池里），已忽略',
  unverified: INHERITED_NOTE + '（读不到用户级 / 系统级设置，无法确认），已忽略',
  explicit: INHERITED_NOTE + '（个人目录已显式指定），已忽略',
};
// 直查与日志用的说明（不带路径）：{ adopted, ignored, reason, origin, variable, note, inPool, inPoolAccount }；
// inPoolAccount 是号的编号（调用方换成代称）。没有继承值或它就是默认目录时返回 null。
// decision 默认用启动时缓存的；还没缓存（启动判定没跑完）时按「读不到注册表」现算。
function inheritedConfigDirInfo(env = process.env, provider = hubProviderConfig(), { dataDir = null, decision } = {}) {
  let d = decision !== undefined ? decision : inheritedDecision;
  const inherited = inheritedConfigDir(env, provider);
  if (!inherited) return null;
  if (!d || d.inherited !== inherited) d = decideInherited({ env, provider, dataDir, persisted: { user: null, system: null, error: '还没读' } });
  if (!d) return null;
  return { adopted: !!d.adopt, ignored: !d.adopt, reason: d.reason, origin: d.origin, variable: d.variable,
    note: INHERITED_NOTES[d.reason] || INHERITED_NOTE, inPool: !!d.inPool, inPoolAccount: d.inPoolAccount || null };
}

// PowerShell 里键入的命令头：普通命令名原样；带路径或空格的用调用运算符。
function commandHead(command) {
  if (/^[A-Za-z0-9_.-]+$/.test(command)) return command;
  return `& '${command.replace(/'/g, "''")}'`;
}

// 只查文件、不启动进程：命令是完整路径就看文件在不在；否则按 PATH + Windows 可执行扩展名找。
// 用于界面默认选中 CodeAgent（公司电脑），不作为能否登录或调用模型的证据。
function isCodeAgentInstalled(env = process.env, provider = hubProviderConfig()) {
  const fs = require('fs');
  let command;
  try { ({ command } = resolveCodeAgentConfig(env, provider)); } catch { return false; }
  const exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  if (path.isAbsolute(command)) return exists(command);
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const dirs = String(env[pathKey] || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  return dirs.some(dir => exts.some(ext => exists(path.join(dir.replace(/^"|"$/g, ''), command + ext))));
}

function normalizeCodeAgentModel(model) {
  return codeAgentModels.normalizeModel(model);
}

// 模型菜单：已知模型 + 本机 CodeAgent 配置目录里的模型 + 回答里见过的模型（core/codeagent-models.js）。
function localModelOptions(dataDir, env = process.env) {
  let configDir = null;
  try { configDir = resolveCodeAgentConfig(env).configDir; } catch { configDir = null; }
  return codeAgentModels.modelOptions(dataDir, { configDir });
}

module.exports = {
  DEFAULT_COMMAND,
  DEFAULT_CONFIG_ENV,
  STATE_FILE,
  MODELS,
  DEFAULT_MODEL,
  EFFORTS,
  HOOK_EVENTS,
  resolveCodeAgentConfig,
  configDirEnvName,
  configDirSource,
  inheritedConfigDir,
  inheritedConfigDirInfo,
  INHERITED_NOTE,
  INHERITED_NOTES,
  readPersistentEnv,
  decideInherited,
  loadInheritedDecision,
  setInheritedDecision,
  getInheritedDecision,
  canonicalDir,
  sameDir,
  dirsOverlap,
  commandHead,
  normalizeCodeAgentModel,
  localModelOptions,
  isCodeAgentInstalled,
};
