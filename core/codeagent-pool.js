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

function fileExists(file, fsModule = fs) { try { return fsModule.statSync(file).isFile(); } catch { return false; } }
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

// 只回凭证元数据（工号、到期时间、登录方式、是否有认证内容）；token 不解密、不返回。
function readCredentials(configDir, fsModule = fs) {
  // 读不懂时带一句原因（detail，不含凭证内容；2026-10-19 公司 2.1.15 直查个人账号「凭证读不到」，要分清是读文件出错、
  // 不是 JSON，还是 JSON 里没有登录项）。文件开头的 BOM 去掉再解析；登录项的键名大小写不敏感（xxxOAuth / xxxOauth）。
  let text;
  try { text = String(fsModule.readFileSync(path.join(configDir, '.credentials.json'), 'utf8')); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { present: false, reason: 'missing' };
    return { present: false, reason: 'unreadable', detail: `读文件出错（${error && error.code || 'unknown'}）` };
  }
  let raw;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { return { present: false, reason: 'unreadable', detail: text.trim() ? `不是 JSON（${text.length} 字节）` : '文件是空的' }; }
  const keys = raw && typeof raw === 'object' ? Object.keys(raw).filter(k => raw[k] && typeof raw[k] === 'object') : [];
  // CodeAgent 自己的登录项（idaasOAuth / devUCOAuth）优先；只有没有这种写法时才认大小写不同的（Claude 自己的 claudeAiOauth 排在最后）
  const key = keys.find(k => /OAuth$/.test(k)) || keys.find(k => /oauth$/i.test(k) && k !== 'claudeAiOauth') || null;
  if (!key) {
    const keys = raw && typeof raw === 'object' ? Object.keys(raw).filter(k => /^[A-Za-z][\w-]{0,40}$/.test(k)).slice(0, 6) : [];
    return { present: false, reason: 'unreadable', detail: keys.length ? `没有登录项（顶层键：${keys.join('、')}）` : '没有登录项' };
  }
  const entry = raw[key];
  const expiresAt = Number(entry.xAuthExpires || entry.expiresAt) || null;
  return {
    present: true,
    method: key === 'idaasOAuth' ? 'idaas' : key === 'devUCOAuth' ? 'devuc' : key.replace(/oauth$/i, ''),
    accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
    expiresAt,
    // Presence only; never decrypt or return credential material. Display-ready
    // metadata alone is insufficient to replace an environment-token login.
    authMaterialPresent: ['xAuthToken', 'accessToken', ...(key.toLowerCase() === 'devucoauth' ? ['refreshToken'] : [])]
      .some(name => typeof entry[name] === 'string' && !!entry[name].trim()),
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
  const seen = new Map();
  return accounts.map(a => {
    const dir = accountDir(dataDir, a.id);
    const creds = readCredentials(dir, fsModule);
    const state = accountState(creds, now);
    const configured = accountModels(dir, fsModule);
    const duplicateOf = creds.accountId && seen.get(creds.accountId);
    if (creds.accountId && !seen.has(creds.accountId)) seen.set(creds.accountId, a.id);
    return {
      id: a.id, note: a.note, createdAt: a.createdAt, lastAssignedAt: a.lastAssignedAt, dir,
      state, method: creds.method || null, accountLabel: maskAccountId(creds.accountId), expiresAt: creds.expiresAt || null,
      ...(creds.detail ? { credentialsNote: creds.detail } : {}),
      models: configured.models, modelsAuthoritative: configured.authoritative, defaultModel: configured.defaultModel || '',
      // 号自己 settings.json 写的模型与严格判定的说明（账号即模型，号表和直查标「默认模型未知 / 写的不在清单里」）
      ...(() => { const written = readSettingsModel(dir, fsModule); const d = strictDefaultModel(written, configured.models, { authoritative: configured.authoritative }); return { configModel: written, ...(d.note ? { defaultNote: describeDefaultNote(d.note, written) } : {}) }; })(),
      modelsProbedAt: configured.probedAt || null,
      // 为通道指定模型切过默认模型、还没换回（hub-route-model.json，见 syncSharedConfig）。
      routeSwitched: fileExists(path.join(dir, ROUTE_MARKER), fsModule),
      activeSessions: Number(activeCounts[a.id]) || 0,
      sameAsPersonal: !!(creds.accountId && personalAccountId && creds.accountId === personalAccountId),
      duplicateOf: duplicateOf || null,
    };
  });
}

// 一个目录和号池是否重叠（相同或互相包含；先 realpath，Windows 上不分大小写和分隔符，见 codeagent-config.js dirsOverlap）：
// 和某个号的目录重叠返回 { id }；只和号池根目录重叠（比如落在号池目录里、但不是哪个号）返回 { id: null }；不重叠返回 null。
// 个人账号目录必须和号池完全分开：set-personal-model 据此拒绝，直查据此报「个人目录等于号 N 的目录」。
function poolDirMatch(dataDir, dir, { fsModule = fs } = {}) {
  if (!dataDir || !dir) return null;
  const { dirsOverlap } = require('./codeagent-config');
  for (const a of readRegistry(dataDir).accounts) {
    if (dirsOverlap(dir, accountDir(dataDir, a.id), { fsModule })) return { id: a.id };
  }
  return dirsOverlap(dir, poolRoot(dataDir), { fsModule }) ? { id: null } : null;
}

// 一个配置目录能用的模型：优先用「一键获取模型权限」从它自己的 /model 菜单读到的（core/codeagent-model-probe.js），
// 没获取过时退回配置文件里的账号清单。
function accountModels(dir, fsModule = fs, probedFile = null) {
  const probe = require('./codeagent-model-probe');
  const probed = probe.readProbed(probedFile || path.join(dir, probe.MODELS_FILE));
  if (probed) return { models: probed.models, defaultModel: probed.defaultModel, authoritative: true, probedAt: probed.at };
  const configured = require('./codeagent-models').configuredModels(dir, fsModule);
  return { ...configured, probedAt: null };
}
function personalModelsFile(dataDir) { return path.join(poolRoot(dataDir), 'personal-models.json'); }
function probeCwd(dataDir) { return path.join(poolRoot(dataDir), 'probe-cwd'); }

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
  // 没指定模型时（AI特战队通道开的会话）：知道自己有哪些模型的号排前面，清单未知的号放最后——它可能落到没权限的默认模型。
  const fit = a => !wanted ? (a.modelsAuthoritative && a.models.length ? 0 : 1)
    : a.models.some(m => m.toLowerCase() === wanted) ? 0 : a.modelsAuthoritative ? 2 : 1;
  const candidates = usable.filter(a => fit(a) < 2);
  if (!candidates.length) return null;
  // 不指定模型时避开「为通道切了模型、上面还有会话」的号（那个号此刻跑的不是它原来的默认模型）；只剩它时照用（2026-10-18 审核）。
  const switchedBusy = a => (!wanted && a.routeSwitched && a.activeSessions > 0 ? 1 : 0);
  return candidates.slice().sort((x, y) => fit(x) - fit(y)
    || switchedBusy(x) - switchedBusy(y)
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

// 个人账号上次分到通道会话的时间（2026-10-18 用户反馈 v2.1.11：通道只开号池的号、不开个人账号）。
// AI特战队通道不指定模型时在个人账号和号池各号之间按「进行中会话最少 → 上次分配时间」轮转
// （core/codeagent-model-route.js pickAnyRoute），个人账号的这个时间以前恒为 0，平局时永远是它；单独存一个小文件。
const PERSONAL_ASSIGNED = 'personal-assigned.json';
function personalLastAssignedAt(dataDir, fsModule = fs) {
  try { return Number(JSON.parse(fsModule.readFileSync(path.join(poolRoot(dataDir), PERSONAL_ASSIGNED), 'utf8')).lastAssignedAt) || 0; }
  catch { return 0; }
}
function markPersonalAssigned(dataDir, now = Date.now()) {
  const root = poolRoot(dataDir);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, PERSONAL_ASSIGNED);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 1, lastAssignedAt: now }) + '\n', 'utf8');
  fs.renameSync(tmp, file);
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

// 一个号此刻启动会用哪个模型：号自己存的（settings.json 的 model）在清单里就用它；探测清单已知时不在清单里的换成
// 菜单标的默认、再不行用清单第一个（2026-10-17 公司实测：DS 号没定下模型就退回 CodeAgent 自己的默认 GLM）。
function chooseAccountModel(own, known) {
  let model = typeof own === 'string' && own.trim() ? own.trim() : '';
  if (known && known.authoritative && known.models.length) {
    const inList = m => !!m && known.models.some(x => x.toLowerCase() === String(m).toLowerCase());
    if (!inList(model)) model = inList(known.defaultModel) ? known.defaultModel : known.models[0];
  }
  return model;
}

// 个人账号此刻启动会用的模型，只用于判定和显示，不改写个人账号的 settings.json（号主自己日常用的配置）。
// 2026-10-18 用户反馈 v2.1.11：个人账号 settings.json 没写模型且没探测过、或写的是不在菜单里的分档名 GLM-5.2-WX 时，
// 以前判成「默认模型未知」，个人账号从模型表里整个消失，指定 GLM 被回「没有可用的号」。
// 个人账号的配置不能改，猜错就会开出跑不起来的会话（2026-10-18 独立审核），所以只在能确定的四种情况下给出，其余留空：
//   1. 写了、在清单里：就是它（按清单写法）；
//   2. 写的是分档名、清单里有「名字-Auto」：归到 -Auto（分档只是 Auto 里的配置，菜单里只能选 Auto，2026-10-13 公司真机）；
//   3. 没写、探测文件（CodeAgent 自己的 /model 菜单）标了默认：就是它；
//   4. 没写、清单里有 GLM-5.2-WX-Auto：就是它（2026-10-17 公司实测没定模型时 CodeAgent 退回它自己的默认 GLM）。
// 留空的例子：没写、清单里也没有 GLM-Auto（CodeAgent 仍会退回 GLM 并报找不到，不能判成清单第一个）；
// 写的是菜单外的内部别名（例如 MiniMax-M2.7-CodeAgentCLI，CLI 实际按它跑，不能改判成别的）。
// single：自动会话的挑号和选型用（见 strictDefaultModel 的例外）——写的不在清单里、而探测过的清单只有一个模型时就是它。
function personalDefaultModel(own, known, { single = false } = {}) {
  const models = (known && known.models) || [];
  const pick = m => models.find(x => x.toLowerCase() === String(m || '').toLowerCase()) || '';
  const written = typeof own === 'string' ? own.trim() : '';
  if (written) return pick(written) || pick(written + '-Auto') || (single && known && known.authoritative && models.length === 1 ? models[0] : '');
  return (known && known.probedAt ? pick(known.defaultModel) : '') || pick(require('./codeagent-models').DEFAULT_MODEL);
}
// 号池号的默认模型（账号即模型、切号开关关着时，2026-10-19 审核）：和个人号一样严格——settings.json 写了 model、且在清单里
// （分档名 GLM-5.2-WX 算清单里的 GLM-5.2-WX-Auto）才算已知；没写、清单未知或写的不在清单里都算未知，不参与按模型派活，
// 免得「判断是 DS、实际启动退回 CodeAgent 自己的默认 GLM」（2.1.8 修过的问题）。note：missing / not-in-list。
// 例外（2026-10-20 公司真机：CodeAgent 启动时自己把默认模型写回 deepseek，只有 GLM 权限的个人号和新号都被判成未知）：
// authoritative（探测过的清单）且只有一个模型时就是它——只给自动会话的挑号和选型用：它们开起来后在 /model 菜单里选中它（2.1.20 起），
// 不靠 settings.json 定模型。手动会话的预计模型显示（plannedModelFrom / syncSharedConfig）不传，照旧严格。
function strictDefaultModel(written, models, { authoritative = false } = {}) {
  const w = typeof written === 'string' ? written.trim() : '';
  const list = models || [];
  const only = authoritative && list.length === 1 ? { model: list[0], note: '', ...(w ? { written: w } : {}) } : null;
  if (!w) return only || { model: '', note: 'missing' };
  const hit = list.find(m => String(m).toLowerCase() === w.toLowerCase()) || list.find(m => String(m).toLowerCase() === (w + '-Auto').toLowerCase());
  return hit ? { model: hit, note: '' } : only || { model: '', note: 'not-in-list', written: w };
}
function describeDefaultNote(note, written = '') {
  if (note === 'missing') return '默认模型未知（settings.json 没写 model）';
  if (note === 'not-in-list') return `默认模型未知（settings.json 写的 ${written || '模型'} 不在权限清单里）`;
  return '';
}
// 号自己写的默认模型不在权限清单里时，换成清单里的模型（2026-10-22 公司真机 v3.1.1 的根因）：
// 导入号池时会把源 .cac 目录 settings 的 model 抄进新号（下面的 importLocal），公司那个目录常年写着 GLM-5.2-WX-Auto，
// 只有 DeepSeek 权限的号因此每轮通道会话都去请求 GLM → 后端报「模型不存在或配置有误」→ 记成模型配置避让，
// 这个避让不自动到期（6 小时才放行一次试探），看起来就是「一直避让」。
// 只在清单权威（探测文件或企业清单）且只有一个模型时改；清单有多个或未知时不动——该用哪个无法判断，
// 交给 /model 菜单和「发第一条问题前核对实际模型」那道兜底（main/ipc/session-handlers.js）。
function permissionSafeModel(written, known) {
  const value = typeof written === 'string' ? written.trim() : '';
  const list = (known && Array.isArray(known.models) ? known.models : []).map(String).filter(Boolean);
  if (!value || !known || !known.authoritative || !list.length) return { changed: false, model: written };
  if (list.some(m => m.toLowerCase() === value.toLowerCase())) return { changed: false, model: written };
  if (list.length === 1) return { changed: true, model: list[0], from: value };
  return { changed: false, model: written };
}
// 把一个号池号的默认模型改成它权限清单里的模型（只动 settings.json 的 model 一个键，其余内容原样保留）。
// 只给「号写的模型不在权限清单里」用：号池的号由 Hub 管配置；个人账号是号主自己日常用的配置，不走这里
// （要改走经授权的远程维护 set-personal-model，core/codeagent-personal-model.js）。
// 返回 { ok, from, to } 或 { ok:false, reason }：no-single-model（清单不权威或有多个模型，不知道该用哪个）、
// in-list（配置本来就是权限内的模型，问题不在配置）、read-error / write-error。
function fixPoolModel(dataDir, id, { fsModule = fs } = {}) {
  if (!dataDir || !id) return { ok: false, reason: 'no-account' };
  const dir = accountDir(dataDir, id);
  const known = accountModels(dir, fsModule);
  const list = (known.models || []).map(String).filter(Boolean);
  if (!known.authoritative || list.length !== 1) return { ok: false, reason: 'no-single-model' };
  const file = path.join(dir, 'settings.json');
  let value;
  try { value = JSON.parse(fsModule.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return { ok: false, reason: 'read-error' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'read-error' };
  const from = typeof value.model === 'string' ? value.model.trim() : '';
  const want = list[0];
  if (from && from.toLowerCase() === want.toLowerCase()) return { ok: false, reason: 'in-list', from };
  const temp = `${file}.hub-fix-${process.pid}.tmp`;
  try {
    fsModule.writeFileSync(temp, JSON.stringify({ ...value, model: want }, null, 2) + '\n', 'utf8');
    fsModule.renameSync(temp, file);
  } catch (error) {
    try { fsModule.unlinkSync(temp); } catch { /* 临时文件已不在 */ }
    return { ok: false, reason: 'write-error', detail: error && error.message ? error.message : String(error) };
  }
  return { ok: true, from, to: want };
}
function readSettingsModel(dir, fsModule = fs) {
  try { const v = JSON.parse(fsModule.readFileSync(path.join(dir, 'settings.json'), 'utf8')); return v && typeof v.model === 'string' ? v.model.trim() : ''; }
  catch { return ''; }
}
function effectiveModel(dir, fsModule = fs) { return chooseAccountModel(readSettingsModel(dir, fsModule), accountModels(dir, fsModule)); }

// 家里指定模型时（AI特战队通道，2026-10-18）把号的默认模型切到指定模型：CodeAgent 交互模式不认 --model、/model 菜单
// 会把第一条消息卡住约 1 分钟，只有配置目录 settings.json 的 model 能定新会话的模型。切之前的模型记在这个文件里，
// 之后不指定模型、且这个号上没有进行中的会话时换回去（不指定时的行为与以前相同）。
const ROUTE_MARKER = 'hub-route-model.json';

// 不指定模型开会话时这个号会用的模型（syncSharedConfig 与启动中心「默认模型」共用一套口径，审核 2026-10-19）：
// 号自己存的模型（不在清单里换成清单里的）；为通道切过模型（有 ROUTE_MARKER）且号上没有进行中的会话时，换回切之前的模型。
// 遗留 hub-route-model.json 能不能按原值写回（syncSharedConfig 与 plannedModel 共用，2026-10-19 审核）。
function markerRestoreDecision(ownModel, known, marker) {
  const original = marker && typeof marker.original === 'string' ? marker.original.trim() : '';
  const switchedTo = marker && typeof marker.model === 'string' ? marker.model : '';
  const listKnown = !!(known && known.authoritative && (known.models || []).length);
  const reason = !original ? 'original-empty'
    : String(ownModel || '').toLowerCase() !== switchedTo.toLowerCase() ? 'model-changed-since-switch'
      : listKnown && !known.models.some(m => m.toLowerCase() === original.toLowerCase()) ? 'original-not-in-list' : '';
  return { original, restored: !reason, reason };
}
// 号这次启动会用的模型。切号开关关着（账号即模型，默认）：号自己写的默认值（严格判定，写了且在清单里才算；
// 遗留标记满足写回条件且号空闲时是写回后的原值），不推断；开关打开时沿用 2.1.11 起的推断。
function plannedModelFrom(own, known, marker, { idle = false, routeSwitch = require('./codeagent-model-route').routeSwitchEnabled() } = {}) {
  if (!routeSwitch) {
    const ownModel = typeof own === 'string' ? own : '';
    const decision = marker && idle ? markerRestoreDecision(ownModel, known, marker) : null;
    return strictDefaultModel(decision && decision.restored ? decision.original : ownModel, (known && known.models) || []).model;
  }
  if (marker && idle) return chooseAccountModel(typeof marker.original === 'string' ? marker.original : '', known);
  return chooseAccountModel(own, known);
}
// 只读不写：idle = 这个号上没有进行中的会话。
function plannedModel(dir, { idle = false, fsModule = fs } = {}) {
  let marker = null;
  try { marker = JSON.parse(fsModule.readFileSync(path.join(dir, ROUTE_MARKER), 'utf8')); } catch { marker = null; }
  return plannedModelFrom(readSettingsModel(dir, fsModule), accountModels(dir, fsModule), marker, { idle });
}

// 启动前把与账号无关的配置同步进号的目录：settings.json 以个人账号为准，但去掉 hooks（由 Hub 按本目录部署，
// 避免指向个人目录的 hook 与本目录的重复触发）和 model（每个号能用的模型不同，保留号自己的）；
// 号自己没有默认模型、而账号清单里有模型时，用清单第一个，避免回落到这个号没有权限的模型。
// routeModel：家里指定的模型（调用方已核对这个号有它的权限）；idle：这个号上没有进行中的会话（可以换回切之前的模型）。
// routeSwitch：是否允许为通道指定的模型切号的默认模型（默认跟 core/codeagent-model-route.js routeSwitchEnabled，2026-10-19 起默认关）。
// 关着时（账号即模型）不改号自己 settings.json 的 model（原样保留，没写就不写）；只有以前切过、留着 hub-route-model.json 的号，
// 空闲时按记下的原值写回一次再删掉记录（onRouteRestore 回调记日志）。
function syncSharedConfig(personalDir, targetDir, fsModule = fs, { routeModel = '', idle = false, routeSwitch = require('./codeagent-model-route').routeSwitchEnabled(), onRouteRestore = null } = {}) {
  const errors = [];
  let model = '';
  let modelFix = null;
  // 来源和目标是同一个目录（或互相包含）时一个字都不写（2026-10-19 公司真机：个人目录被继承的环境变量指到了号 1 的目录，
  // 每次号 1 开会话都把号 1 的模型写回「个人」settings.json）。
  if (require('./codeagent-config').dirsOverlap(personalDir, targetDir, { fsModule })) {
    return { errors: ['个人账号目录和这个号的目录是同一个（或互相包含），没同步配置'], model: effectiveModel(targetDir, fsModule), skipped: true };
  }
  fsModule.mkdirSync(targetDir, { recursive: true });
  const readJson = file => { try { return JSON.parse(fsModule.readFileSync(file, 'utf8')); } catch { return null; } };
  try {
    const personal = readJson(path.join(personalDir, 'settings.json')) || {};
    const own = readJson(path.join(targetDir, 'settings.json')) || {};
    const next = { ...personal };
    delete next.hooks; delete next.model;
    if (own.hooks) next.hooks = own.hooks;
    // 定这个号用哪个模型（2026-10-17 公司实测：只有 DeepSeek v4 权限的号开出来报「找不到 GLM」）。
    // 以前只看配置文件里的账号清单，没读「一键获取模型权限」探测到的清单（hub-models.json），没定下模型时
    // CodeAgent 退回它自己的默认 GLM。现在探测清单优先；号自己存的模型不在清单里也换掉。
    const known = accountModels(targetDir, fsModule);
    const ownModel = typeof own.model === 'string' ? own.model : '';
    const markerFile = path.join(targetDir, ROUTE_MARKER);
    const marker = readJson(markerFile);
    // 这次启动定下的模型：和 plannedModel（启动中心显示的预计模型）同一口径（plannedModelFrom）。
    // 开关关着时不推断，只认号自己写的值；开关打开时沿用以前的推断。
    model = routeSwitch ? plannedModelFrom(own.model, known, marker, { idle: !routeModel && idle, routeSwitch }) : ownModel;
    if (!routeSwitch) {
      if (marker && idle) {
        // 只在两条都满足时写回原值（2026-10-19 审核，最保守）：号此刻的 model 仍是当初切过去的值（之后没人改过），
        // 且权限清单未知或原值在清单里。原值为空、号的 model 已被别处改过、原值不在清单里：只删记录，不写，回调里给原因。
        const decision = markerRestoreDecision(ownModel, known, marker);
        if (decision.restored) model = decision.original;
        try { fsModule.rmSync(markerFile, { force: true }); } catch { /* 删不掉下次再删 */ }
        try { onRouteRestore && onRouteRestore({ before: ownModel, after: model, original: decision.original, restored: decision.restored, ...(decision.reason ? { reason: decision.reason } : {}) }); } catch { /* 只是记日志 */ }
      }
    } else if (routeModel) {
      const want = known.models.find(m => m.toLowerCase() === String(routeModel).toLowerCase()) || String(routeModel);
      if (model.toLowerCase() !== want.toLowerCase()) {
        const original = marker && typeof marker.original === 'string' ? marker.original : model;
        fsModule.writeFileSync(markerFile, JSON.stringify({ original, model: want, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
        model = want;
      }
    } else if (marker && idle) {
      try { fsModule.rmSync(markerFile, { force: true }); } catch { /* 删不掉下次再删 */ }
    }
    // 权限兜底（2026-10-22）：写进配置的模型必须在这个号的权限清单里，否则新会话一开就报「模型不存在」。
    // 号自己写的值（导入时从源目录抄来的）不在清单里、而清单只有一个模型时，直接换成清单里那个。
    const safe = permissionSafeModel(model, known);
    if (safe.changed) { modelFix = { from: safe.from, to: safe.model }; model = safe.model; }
    if (model) next.model = model;
    else delete next.model;
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
  // model：这次启动会用的模型（显示用）；号没写默认模型时按清单推一个，只作显示，不写进配置。
  // 开关关着时只认号自己写的、在清单里的默认模型（strictDefaultModel），不猜；开关打开时沿用以前的推断。
  if (!routeSwitch) { try { model = strictDefaultModel(model, accountModels(targetDir, fsModule).models).model; } catch { model = ''; } }
  return { errors, model, modelFix };
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
// personal：个人账号的登录过期 / 读不懂时（2026-10-19），同样开这个窗口重新登录，目录是个人账号自己的配置目录（不能和号池重叠）。
function openLoginWindow(dataDir, id, config, { env = process.env, spawnFn = require('child_process').spawn, now = Date.now(), personal = false } = {}) {
  if (personal && poolDirMatch(dataDir, config.configDir)) throw new Error('个人账号的配置目录和号池重叠，不能在这里登录');
  const dir = personal ? config.configDir : accountDir(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  if (env.CLAUDE_HUB_DATA_DIR && env.AI_HUB_CODEAGENT_POOL_LOGIN_FIXTURE) {
    const accountId = String(env.AI_HUB_CODEAGENT_POOL_LOGIN_FIXTURE).replace(/[^a-z0-9]/gi, '').slice(0, 12) + id.slice(0, 3);
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: {
      xAuthToken: 'fixture', accountId, expiresAt: now + 72 * 3600 * 1000, env: 'test' } }), 'utf8');
    return { fixture: true };
  }
  if (process.platform !== 'win32') throw new Error('号池登录只支持 Windows');
  const childEnv = { ...env, [config.configDirEnv]: dir };
  require('./codeagent-launch-env').applyAccountEnv(childEnv, { ...config, configDir: dir });
  for (const key of Object.keys(childEnv)) if (/^CODEAGENT_HUB_/.test(key) || key === 'CODEAGENT3_LAUNCHER_PID') delete childEnv[key];
  const command = /^[A-Za-z0-9_.-]+$/.test(config.command) ? config.command : `"${String(config.command).replace(/"/g, '')}"`;
  const hint = personal ? 'echo 个人账号重新登录：请在下面输入你自己的 W3 用户名和密码。登录成功后关闭本窗口，回到 AI Hub 即可。& echo.'
    : 'echo 请号主本人在下面输入 W3 用户名和密码。登录成功后关闭本窗口，回到 AI Hub 即可。& echo.';
  const line = `start "${personal ? 'CodeAgent 个人账号登录' : 'CodeAgent 号池登录'}" cmd.exe /k "chcp 65001>nul & ${hint} & call ${command} auth login --method idaas"`;
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
    if (typeof own.model === 'string' && own.model.trim()) {
      // 抄来的默认模型必须在这个号的权限清单里（2026-10-22）：源目录写的是 GLM、而这个号只有 DeepSeek 权限时，
      // 直接抄进去会让它每轮会话都报「模型不存在」（号表里也显示成「默认模型未知」）。清单只有一个模型就换成它。
      // 权限清单从源目录读（这是同一个号、同一份配置；探测文件不随导入复制，读新目录会读不到）。
      const safe = permissionSafeModel(own.model.trim(), accountModels(candidate.dir, fsModule));
      const model = String(safe.model || '').trim();
      if (model) fsModule.writeFileSync(path.join(target, 'settings.json'), JSON.stringify({ model }, null, 2) + '\n', 'utf8');
    }
  } catch { /* 原目录没有设置 */ }
  return id;
}

module.exports = {
  accountModels, personalModelsFile, probeCwd,
  localCandidates, importLocal,
  openLoginWindow,
  POOL_DIR, poolRoot, accountDir, readRegistry, maskAccountId, readCredentials, accountState,
  listAccounts, label, pickAccount, markAssigned, addAccount, setNote, removeAccount,
  personalLastAssignedAt, markPersonalAssigned,
  projectCredentialsOverride, syncSharedConfig, poolModelOptions, poolDirMatch,
  chooseAccountModel, personalDefaultModel, readSettingsModel, effectiveModel, plannedModel, strictDefaultModel, describeDefaultNote, permissionSafeModel, fixPoolModel, markerRestoreDecision, ROUTE_MARKER,
};
