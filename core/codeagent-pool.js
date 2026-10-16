'use strict';
// CodeAgent 号池（2026-10-16 用户要求，AI特战队专用）：新建 CodeAgent 会话时可选「个人账号」或「号池」。
//
// 依据（公司真机 Q-1016-03/04/09 实测）：
//   - 登录凭证是配置目录里的 .credentials.json，换 CODEAGENT3_CONFIG_DIR 就换号；一台电脑可同时登多个号；
//   - 当前目录下的 .cac/.credentials.json 优先于配置目录 → 工作目录里有它时号池选的号会被盖掉，启动前拦下；
//   - 凭证用 Windows DPAPI 加密，只能在本机本用户下用 → 号主要在这台电脑上登录一次（账号密码方式不弹浏览器）；
//   - auth logout 会注销服务器上的这次登录 → 号池不提供退出，只提供「移出号池」（只删本机这份凭证）。
//
// 每个号一个配置目录：<Hub 数据目录>/codeagent-pool/accounts/<id>。登录凭证留在那里，
// 其余与账号无关的配置（settings.json 去掉 hooks 与 model、全局规则、skills）启动前从个人账号目录同步过去，
// Hub 的 hook 由调用方按个人账号目录同样的方式部署。会话固定一个号；挑号时优先没有进行中会话的号。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POOL_DIR = 'codeagent-pool';
const REGISTRY = 'pool.json';
const ACCOUNT_ID = /^[a-z0-9]{6,16}$/;
const NOTE_MAX = 24;
// 与账号无关、要和个人账号保持一致的内容。plugins、mcp-servers 体积大且多与本机安装绑定，不同步。
const SHARED_FILES = ['AGENTS.md', 'CLAUDE.md'];
const SHARED_DIRS = ['skills'];

function poolRoot(dataDir) { return path.join(dataDir, POOL_DIR); }
function accountDir(dataDir, id) {
  if (!ACCOUNT_ID.test(String(id || ''))) throw new Error('号池账号编号无效');
  return path.join(poolRoot(dataDir), 'accounts', id);
}

function readRegistry(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(poolRoot(dataDir), REGISTRY), 'utf8'));
    const accounts = (Array.isArray(raw && raw.accounts) ? raw.accounts : [])
      .filter(a => a && ACCOUNT_ID.test(String(a.id || '')))
      .map(a => ({ id: a.id, note: cleanNote(a.note), createdAt: a.createdAt || null, lastAssignedAt: Number(a.lastAssignedAt) || 0 }));
    return { accounts };
  } catch { return { accounts: [] }; }
}

function writeRegistry(dataDir, registry) {
  const root = poolRoot(dataDir);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, REGISTRY);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 1, accounts: registry.accounts }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function cleanNote(value) {
  return String(value || '').replace(/[\r\n\t<>]/g, ' ').trim().slice(0, NOTE_MAX);
}

// 工号只露头尾，界面和日志都用这个。
function maskAccountId(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.length <= 5 ? s.slice(0, 1) + '***' : s.slice(0, 4) + '****' + s.slice(-2);
}

// 只读凭证文件里的明文字段（工号、到期时间、登录方式），token 本身是 DPAPI 密文，不碰。
function readCredentials(configDir, fsModule = fs) {
  let raw;
  try { raw = JSON.parse(fsModule.readFileSync(path.join(configDir, '.credentials.json'), 'utf8')); }
  catch (error) { return { present: false, reason: error && error.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  const key = raw && typeof raw === 'object' ? Object.keys(raw).find(k => /OAuth$/.test(k) && raw[k] && typeof raw[k] === 'object') : null;
  if (!key) return { present: false, reason: 'unreadable' };
  const entry = raw[key];
  const expiresAt = Number(entry.xAuthExpires || entry.expiresAt) || null;
  return {
    present: true,
    method: key === 'idaasOAuth' ? 'idaas' : key === 'devUCOAuth' ? 'devuc' : key.replace(/OAuth$/, ''),
    accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
    expiresAt,
  };
}

// 账号密码（idaas）方式登录的凭证没有真的续期凭证，到期就得号主重登；浏览器方式（devuc）由 CodeAgent 自己续期。
function accountState(creds, now = Date.now()) {
  if (!creds.present) return creds.reason === 'missing' ? 'login-required' : 'unreadable';
  if (creds.method === 'idaas' && creds.expiresAt && creds.expiresAt <= now) return 'expired';
  return 'ready';
}

function listAccounts(dataDir, { activeCounts = {}, personalAccountId = '', now = Date.now(), fsModule = fs } = {}) {
  const { accounts } = readRegistry(dataDir);
  const models = require('./codeagent-models');
  const seen = new Map();
  return accounts.map(a => {
    const dir = accountDir(dataDir, a.id);
    const creds = readCredentials(dir, fsModule);
    const state = accountState(creds, now);
    const configured = models.configuredModels(dir, fsModule);
    const duplicateOf = creds.accountId && seen.get(creds.accountId);
    if (creds.accountId && !seen.has(creds.accountId)) seen.set(creds.accountId, a.id);
    return {
      id: a.id, note: a.note, createdAt: a.createdAt, lastAssignedAt: a.lastAssignedAt, dir,
      state, method: creds.method || null, accountLabel: maskAccountId(creds.accountId), expiresAt: creds.expiresAt || null,
      models: configured.models, modelsAuthoritative: configured.authoritative, defaultModel: configured.defaultModel || '',
      activeSessions: Number(activeCounts[a.id]) || 0,
      sameAsPersonal: !!(creds.accountId && personalAccountId && creds.accountId === personalAccountId),
      duplicateOf: duplicateOf || null,
    };
  });
}

function label(account) {
  if (!account) return '';
  const who = account.accountLabel || '未登录';
  return account.note ? `${who}（${account.note}）` : who;
}

// 挑号：只在可用的号里挑；指定了模型时优先挑明确有这个模型的号（清单未知的号排在后面）；
// 然后没有进行中会话的优先，其次会话最少的，最后按上次分配时间轮转。
function pickAccount(accounts, { model = '' } = {}) {
  const usable = accounts.filter(a => a.state === 'ready' && !a.sameAsPersonal && !a.duplicateOf);
  if (!usable.length) return null;
  const wanted = String(model || '').toLowerCase();
  const fit = a => !wanted ? 0 : a.models.some(m => m.toLowerCase() === wanted) ? 0 : a.modelsAuthoritative ? 2 : 1;
  const candidates = usable.filter(a => fit(a) < 2);
  if (!candidates.length) return null;
  return candidates.slice().sort((x, y) => fit(x) - fit(y)
    || x.activeSessions - y.activeSessions
    || x.lastAssignedAt - y.lastAssignedAt)[0];
}

function markAssigned(dataDir, id, now = Date.now()) {
  const registry = readRegistry(dataDir);
  const entry = registry.accounts.find(a => a.id === id);
  if (!entry) return;
  entry.lastAssignedAt = now;
  writeRegistry(dataDir, registry);
}

function addAccount(dataDir, { note = '' } = {}) {
  const registry = readRegistry(dataDir);
  let id;
  do { id = crypto.randomBytes(5).toString('hex'); } while (registry.accounts.some(a => a.id === id));
  fs.mkdirSync(accountDir(dataDir, id), { recursive: true });
  registry.accounts.push({ id, note: cleanNote(note), createdAt: new Date().toISOString(), lastAssignedAt: 0 });
  writeRegistry(dataDir, registry);
  return id;
}

function setNote(dataDir, id, note) {
  const registry = readRegistry(dataDir);
  const entry = registry.accounts.find(a => a.id === id);
  if (!entry) throw new Error('号池里没有这个账号');
  entry.note = cleanNote(note);
  writeRegistry(dataDir, registry);
}

// 移出号池：从登记里去掉，并删掉本机这份凭证（DPAPI 密文，只在本机有用）。不执行 logout，
// 否则服务器会注销这次登录。目录里的会话记录保留，旧会话还能在历史里看。
function removeAccount(dataDir, id) {
  const registry = readRegistry(dataDir);
  if (!registry.accounts.some(a => a.id === id)) throw new Error('号池里没有这个账号');
  registry.accounts = registry.accounts.filter(a => a.id !== id);
  writeRegistry(dataDir, registry);
  try { fs.rmSync(path.join(accountDir(dataDir, id), '.credentials.json'), { force: true }); } catch { /* 已不在 */ }
}

// 当前目录下的 .cac/.credentials.json 会盖过选定的号（公司实测）。用户目录本身就是这种情况。
function projectCredentialsOverride(cwd, fsModule = fs) {
  if (!cwd) return null;
  const file = path.join(cwd, '.cac', '.credentials.json');
  try { return fsModule.statSync(file).isFile() ? file : null; } catch { return null; }
}

// 启动前把与账号无关的配置同步进号的目录：settings.json 以个人账号为准，但去掉 hooks（由 Hub 按本目录部署，
// 避免指向个人目录的 hook 与本目录的重复触发）和 model（每个号能用的模型不同，保留号自己的）；
// 号自己没有默认模型、而账号清单里有模型时，用清单第一个，避免回落到这个号没有权限的模型。
function syncSharedConfig(personalDir, targetDir, fsModule = fs) {
  const errors = [];
  fsModule.mkdirSync(targetDir, { recursive: true });
  const readJson = file => { try { return JSON.parse(fsModule.readFileSync(file, 'utf8')); } catch { return null; } };
  try {
    const personal = readJson(path.join(personalDir, 'settings.json')) || {};
    const own = readJson(path.join(targetDir, 'settings.json')) || {};
    const next = { ...personal };
    delete next.hooks; delete next.model;
    if (own.hooks) next.hooks = own.hooks;
    let model = typeof own.model === 'string' && own.model.trim() ? own.model.trim() : '';
    if (!model) {
      const configured = require('./codeagent-models').configuredModels(targetDir, fsModule);
      if (configured.authoritative && configured.models.length) model = configured.models[0];
    }
    if (model) next.model = model;
    const text = JSON.stringify(next, null, 2) + '\n';
    const file = path.join(targetDir, 'settings.json');
    let current = null; try { current = fsModule.readFileSync(file, 'utf8'); } catch { /* 新目录 */ }
    if (current !== text) fsModule.writeFileSync(file, text, 'utf8');
  } catch (error) { errors.push(`settings.json：${error.message}`); }
  for (const name of SHARED_FILES) {
    const src = path.join(personalDir, name);
    const dest = path.join(targetDir, name);
    try {
      if (fsModule.existsSync(src)) fsModule.copyFileSync(src, dest);
      else if (fsModule.existsSync(dest)) fsModule.rmSync(dest, { force: true });
    } catch (error) { errors.push(`${name}：${error.message}`); }
  }
  for (const name of SHARED_DIRS) {
    const src = path.join(personalDir, name);
    try { if (fsModule.existsSync(src)) fsModule.cpSync(src, path.join(targetDir, name), { recursive: true, force: true }); }
    catch (error) { errors.push(`${name}：${error.message}`); }
  }
  return { errors };
}

// 本机号池里各号的模型合集（启动中心选「号池」时的模型菜单）。
function poolModelOptions(dataDir, accounts) {
  const models = require('./codeagent-models');
  const ids = new Map();
  for (const a of accounts.filter(x => x.state === 'ready' && !x.sameAsPersonal && !x.duplicateOf)) {
    for (const id of a.models) if (!ids.has(id.toLowerCase())) ids.set(id.toLowerCase(), id);
  }
  return [...ids.values()].map(id => ({ id, label: models.modelLabel(id), source: 'pool' }));
}

// 让号主在这台电脑上登录一次：开一个可见的命令行窗口，跑 CodeAgent 自己的账号密码登录（不弹浏览器，
// 公司实测提示「W3 用户名:」）。密码只交给 CodeAgent，Hub 不经手；Hub 只看配置目录里出现凭证文件。
// 工作目录用这个号自己的目录，避开「当前目录 .cac 凭证优先」的坑。
// 隔离测试（有独立数据目录且设了夹具开关）不开窗口，直接写一份假凭证，便于端到端走通界面。
function openLoginWindow(dataDir, id, config, { env = process.env, spawnFn = require('child_process').spawn, now = Date.now() } = {}) {
  const dir = accountDir(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  if (env.CLAUDE_HUB_DATA_DIR && env.AI_HUB_CODEAGENT_POOL_LOGIN_FIXTURE) {
    const accountId = String(env.AI_HUB_CODEAGENT_POOL_LOGIN_FIXTURE).replace(/[^a-z0-9]/gi, '').slice(0, 12) + id.slice(0, 3);
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: {
      xAuthToken: 'fixture', accountId, expiresAt: now + 72 * 3600 * 1000, env: 'test' } }), 'utf8');
    return { fixture: true };
  }
  if (process.platform !== 'win32') throw new Error('号池登录只支持 Windows');
  const childEnv = { ...env, [config.configDirEnv]: dir };
  for (const key of Object.keys(childEnv)) if (/^CODEAGENT_HUB_/.test(key) || key === 'CODEAGENT3_LAUNCHER_PID') delete childEnv[key];
  const command = /^[A-Za-z0-9_.-]+$/.test(config.command) ? config.command : `"${String(config.command).replace(/"/g, '')}"`;
  const hint = 'echo 请号主本人在下面输入 W3 用户名和密码。登录成功后关闭本窗口，回到 AI Hub 即可。& echo.';
  const line = `start "CodeAgent 号池登录" cmd.exe /k "chcp 65001>nul & ${hint} & call ${command} auth login --method idaas"`;
  const child = spawnFn('cmd.exe', ['/d', '/s', '/c', line], { cwd: dir, env: childEnv, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.on?.('error', () => {});
  child.unref?.();
  return { fixture: false };
}

// 本机已经登好的 CodeAgent 配置目录（用户目录下 .cac* 里有凭证的）。凭证用本机本用户的 DPAPI 加密，
// 同一台电脑、同一个 Windows 用户下换个目录照样能用，所以可以直接导入号池，不必重新登录。
// 隔离测试可用 AI_HUB_CODEAGENT_POOL_SCAN_ROOT 指定扫描目录（必须同时有独立数据目录）。
function scanRoot(env = process.env) {
  if (env.CLAUDE_HUB_DATA_DIR && env.AI_HUB_CODEAGENT_POOL_SCAN_ROOT) return env.AI_HUB_CODEAGENT_POOL_SCAN_ROOT;
  return env.USERPROFILE || env.HOME || require('os').homedir();
}

function localCandidates(dataDir, { personalDir = '', env = process.env, now = Date.now(), fsModule = fs } = {}) {
  const root = scanRoot(env);
  let names = [];
  try { names = fsModule.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^\.cac[\w.-]*$/i.test(d.name)).map(d => d.name); }
  catch { return []; }
  const inPool = new Set(listAccounts(dataDir, { now, fsModule }).map(a => a.accountLabel && readCredentials(a.dir, fsModule).accountId).filter(Boolean));
  const personal = personalDir ? readCredentials(personalDir, fsModule) : { present: false };
  const out = [];
  for (const name of names.sort()) {
    const dir = path.join(root, name);
    const creds = readCredentials(dir, fsModule);
    if (!creds.present) continue;
    const isPersonal = !!personalDir && path.resolve(dir).toLowerCase() === path.resolve(personalDir).toLowerCase();
    out.push({ dir, name, method: creds.method, accountLabel: maskAccountId(creds.accountId), state: accountState(creds, now),
      isPersonal, sameAsPersonal: !!(personal.accountId && creds.accountId === personal.accountId),
      alreadyInPool: inPool.has(creds.accountId) });
  }
  return out;
}

// 导入：新建一个号池账号，把凭证复制过去；顺带复制账号清单（.cac.json）和这个号自己的默认模型，
// 让模型菜单和挑号马上知道它能用哪些模型。不改原目录，原目录照常可用（不要在原目录执行退出登录）。
function importLocal(dataDir, sourceDir, { note = '', personalDir = '', env = process.env, now = Date.now(), fsModule = fs } = {}) {
  const candidate = localCandidates(dataDir, { personalDir, env, now, fsModule })
    .find(c => path.resolve(c.dir).toLowerCase() === path.resolve(String(sourceDir || '')).toLowerCase());
  if (!candidate) throw new Error('这个目录不在本机已登录的 CodeAgent 目录里');
  if (candidate.isPersonal || candidate.sameAsPersonal) throw new Error('这是个人账号，不放进号池');
  if (candidate.alreadyInPool) throw new Error('这个号已经在号池里');
  if (candidate.state !== 'ready') throw new Error('这个目录的登录已过期，请先重新登录');
  const id = addAccount(dataDir, { note: note || candidate.name });
  const target = accountDir(dataDir, id);
  fsModule.copyFileSync(path.join(candidate.dir, '.credentials.json'), path.join(target, '.credentials.json'));
  try { if (!fsModule.existsSync(path.join(target, '.cac.json'))) fsModule.copyFileSync(path.join(candidate.dir, '.cac.json'), path.join(target, '.cac.json')); } catch { /* 没有账号清单 */ }
  try {
    const own = JSON.parse(fsModule.readFileSync(path.join(candidate.dir, 'settings.json'), 'utf8'));
    if (typeof own.model === 'string' && own.model.trim()) fsModule.writeFileSync(path.join(target, 'settings.json'), JSON.stringify({ model: own.model.trim() }, null, 2) + '\n', 'utf8');
  } catch { /* 原目录没有设置 */ }
  return id;
}

module.exports = {
  localCandidates, importLocal,
  openLoginWindow,
  POOL_DIR, poolRoot, accountDir, readRegistry, maskAccountId, readCredentials, accountState,
  listAccounts, label, pickAccount, markAssigned, addAccount, setNote, removeAccount,
  projectCredentialsOverride, syncSharedConfig, poolModelOptions,
};
