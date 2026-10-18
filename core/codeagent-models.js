'use strict';
// 公司 CodeAgent 的模型身份：Hub 请求的模型 ≠ CLI 实际用的模型时，以实际为准。
//
// 2026-10-13 公司真机：同事有 DeepSeek 权限、没有 GLM 权限，Hub 按默认带 --model GLM-5.2-WX-Auto 启动，
// CodeAgent 实际用的是 deepseek0731… 这类内部名；卡片（读原生记录里每条回答的 model）是对的，
// 输入框下方和侧栏仍按 Hub 请求的 GLM 显示，头像也一律是 GLM。原因有三：
//   1. 模型名单写死 GLM / MiniMax，不认识的名字（含 deepseek…）被归一成 GLM 再传给 --model；
//   2. 会话的当前模型只记 Hub 请求的那个，从不按回答里的真实模型校正；
//   3. 头像与侧栏图标只看会话类型 codeagent，不看模型。
// 这里集中：模型名是否可以安全地传给命令行、属于哪家（定头像与图标）、显示名，
// 以及收到一条回答后会话模型该怎么改。公司内部模型名的完整列表未知，所以不靠名单校验，
// 只校验字符；实际见过的模型名记在 Hub 数据目录，供下次新建会话时选择。
const fs = require('fs');
const path = require('path');

const KNOWN = Object.freeze([
  { id: 'GLM-5.2-WX-Auto', label: 'GLM-5.2 Auto' },
  { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
]);
const DEFAULT_MODEL = KNOWN[0].id;
const OBSERVED_FILE = 'codeagent-models.json';
const OBSERVED_LIMIT = 24;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 能原样放进 PowerShell 命令行、也不会被当成别的参数：字母数字开头，只含常见模型名字符。
function isSafeModelId(value) {
  const id = clean(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]{0,95}$/.test(id) && !id.startsWith('<');
}

// 别的 CLI 的模型名（从 Claude / Codex 等会话带过来的设置）不是 CodeAgent 的，回到默认。
// 2026-10-13 用户确认：Qwen（含 Qwen3.6-27B-CodeAgent-VL）是他用过的另一个 harness 的模型，不是 CodeAgent 的，
// 即使出现在 .cac.json 里也不认。
const OTHER_CLI_MODEL = /^(?:claude-|fable|opus|sonnet|haiku|gpt-|o\d|gemini|kimi|qwen|chatgpt-web)/i;

// 已知模型按名单的大小写；其余安全的名字原样保留（公司内部名大小写敏感与否未知，不改它）。
function normalizeModel(value) {
  const id = clean(value);
  if (!isSafeModelId(id) || OTHER_CLI_MODEL.test(id)) return DEFAULT_MODEL;
  const known = KNOWN.find(option => option.id.toLowerCase() === id.toLowerCase());
  return known ? known.id : id;
}

// 哪家的模型：决定头像和侧栏图标。认不出的返回空串，界面沿用 CodeAgent 默认的样子。
function modelFamily(value) {
  const id = clean(value).toLowerCase();
  if (!id) return '';
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('minimax')) return 'minimax';
  if (id.includes('glm') || id.includes('zhipu') || id.includes('chatglm')) return 'glm';
  if (id.includes('qwen')) return 'qwen';
  return '';
}

// ---------------------------------------------------------------- 本机 CodeAgent 配置里的模型
// 2026-10-13 公司探测：~/.cac/settings.json 的 model 是默认模型，.cac.json 的 tieredModelConfig / tierModelParams /
// modelParam 里列着这台电脑能用的模型（例如 GLM-5.2-WX、MiniMax-M2.7-CodeAgentCLI），
// 每个人的权限不同，列表也不同。只看键名带 model 的那几段（不碰 projects / history 里的聊天记录），
// 收集长得像模型名的字符串（厂商名 + 至少一个数字）。
// 2026-10-13 公司真机：.cac.json 里还存着各项目的历史（几千个会话），超过原来的 8 MB 上限被整个跳过，
// 启动中心只剩内置的两个模型 + 见过的模型。上限放到 64 MB，按 (路径, 修改时间, 大小) 缓存解析结果；
// 超上限或 JSON 读不懂时，退回在原始文本里找：键名含 model 的键后面约 4000 字符内、单独成串的模型名。
// 只认 CodeAgent 自家的三家（GLM / DeepSeek / MiniMax）；Qwen、Kimi 是别的 CLI 的模型（见 OTHER_CLI_MODEL）。
const CONFIG_MODEL_NAME = /^(?:glm|deepseek|minimax)[A-Za-z0-9_.\-]*\d[A-Za-z0-9_.\-]*$/i;
const CONFIG_MAX_BYTES = 64 * 1024 * 1024;
const CONFIG_SCAN_WINDOW = 4000;
const configFileCache = new Map();

// 原始文本扫描：只认没被反斜杠转义的键（聊天记录里的 JSON 字符串是转义过的 \"model\"，不算），
// 只收前后都是引号、单独成串的模型名（聊天里「试试 GLM-9.9」这种夹在句子里的不算）。
function scanModelNamesInText(text, out) {
  const keyRe = /"((?:[^"\\]|\\.)*)"\s*:/g;
  const nameRe = /(?<!\\)"((?:glm|deepseek|minimax)[A-Za-z0-9_.\-]*\d[A-Za-z0-9_.\-]*)"/gi;
  let m;
  while ((m = keyRe.exec(text)) && out.size <= 60) {
    if (m.index > 0 && text[m.index - 1] === '\\') continue;
    if (!/model/i.test(m[1]) || m[1].includes('\\')) continue;
    const windowText = text.slice(keyRe.lastIndex, keyRe.lastIndex + CONFIG_SCAN_WINDOW);
    for (const n of windowText.matchAll(nameRe)) if (isSafeModelId(n[1])) out.add(n[1]);
  }
}

function readConfigFile(full, fsModule) {
  const stat = fsModule.statSync(full);
  const cached = configFileCache.get(full);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;
  const text = String(fsModule.readFileSync(full, 'utf8')).replace(/^﻿/, '');
  const names = new Set();
  let data = null;
  if (stat.size <= CONFIG_MAX_BYTES) { try { data = JSON.parse(text); } catch { data = null; } }
  if (data) collectModelNames(data, false, names);
  else scanModelNamesInText(text, names);
  const defaultModel = data && isSafeModelId(data.model) ? String(data.model).trim() : '';
  const result = { names: [...names], defaultModel, parsed: !!data, enterprise: data ? enterpriseModels(data) : null,
    windows: data ? enterpriseWindows(data) : {} };
  configFileCache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}

// 2026-10-13 公司真机：可用模型清单在 .cac.json 的 enterpriseModelOptionsCache 里；缓存类的值有时是
// 再编码过一次的 JSON 文本，按 JSON 再解一层再找。
// 2026-10-13 公司真机第二轮排查：.cac.json 的 enterpriseModelOptionsCache 就是 CodeAgent 自己给这个账号的模型清单，
// 每项一个 value（用户的账号只有 GLM-5.2-WX-Auto 与 MiniMax-M2.7）。GLM-5.2-WX、Qwen3.6-27B-CodeAgent-VL 只是
// GLM Auto 那一项里的分档配置（tieredModelConfig），不能单独选；之前在模型段里见名就收，把它们也列了出来。
// 有这份清单时只认清单里的 value；没有（老版本 CodeAgent）才退回在模型段里找名字。
function enterpriseModels(data) {
  let list = data && data.enterpriseModelOptionsCache;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
  if (!Array.isArray(list)) return null;
  const ids = [];
  for (const item of list.slice(0, 100)) {
    const id = clean(typeof item === 'string' ? item : item && (item.value || item.model || item.id));
    if (!isSafeModelId(id) || OTHER_CLI_MODEL.test(id)) continue;
    if (!ids.some(other => other.toLowerCase() === id.toLowerCase())) ids.push(id);
  }
  return ids.length ? ids : null;
}

// 账号清单里每个模型的上下文上限（contextWindow，公司真机：GLM-5.2-WX-Auto 202752、MiniMax-M2.7 192000）。
function enterpriseWindows(data) {
  let list = data && data.enterpriseModelOptionsCache;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
  const windows = {};
  if (!Array.isArray(list)) return windows;
  for (const item of list.slice(0, 100)) {
    const id = clean(item && typeof item === 'object' ? (item.value || item.model || item.id) : '');
    const size = Number(item && item.contextWindow);
    if (isSafeModelId(id) && Number.isFinite(size) && size >= 1000) windows[id.toLowerCase()] = Math.round(size);
  }
  return windows;
}

function collectModelNames(node, inModelSection, out, depth = 0) {
  if (depth > 8 || out.size > 60 || node == null) return;
  if (typeof node === 'string') {
    const text = node.trim();
    if (inModelSection && CONFIG_MODEL_NAME.test(text) && isSafeModelId(text)) out.add(text);
    else if (inModelSection && /^[[{]/.test(text) && text.length <= 256 * 1024) {
      let inner = null;
      try { inner = JSON.parse(text); } catch { inner = null; }
      if (inner && typeof inner === 'object') collectModelNames(inner, true, out, depth + 1);
    }
    return;
  }
  if (Array.isArray(node)) { for (const item of node.slice(0, 200)) collectModelNames(item, inModelSection, out, depth + 1); return; }
  if (typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (/^(projects|history|messages|tipsHistory)$/i.test(key)) continue;
    const section = inModelSection || /model/i.test(key);
    if (section && CONFIG_MODEL_NAME.test(key) && isSafeModelId(key)) out.add(key);
    collectModelNames(value, section, out, depth + 1);
  }
}

// authoritative=true：模型来自 CodeAgent 自己的账号清单（enterpriseModelOptionsCache），界面只列这些。
function configuredModels(configDir, fsModule = fs) {
  if (!configDir) return { models: [], defaultModel: '', authoritative: false };
  const names = new Set();
  let defaultModel = '';
  let enterprise = null;
  for (const file of ['settings.json', '.cac.json']) {
    try {
      const result = readConfigFile(path.join(configDir, file), fsModule);
      if (file === 'settings.json' && result.defaultModel) defaultModel = result.defaultModel;
      if (result.enterprise) enterprise = result.enterprise;
      for (const name of result.names) names.add(name);
    } catch { /* 没有或读不了就跳过 */ }
  }
  if (enterprise) return { models: enterprise, defaultModel, authoritative: true };
  if (defaultModel) names.add(defaultModel);
  return { models: [...names], defaultModel, authoritative: false };
}

function modelLabel(value) {
  const id = clean(value);
  const known = KNOWN.find(option => option.id.toLowerCase() === id.toLowerCase());
  return known ? known.label : id;
}

function isCodeAgentSession(session) {
  return /^codeagent(?:-resume)?$/.test(String(session && session.kind || ''));
}

// 沿用 CodeAgent 当前模型、又不知道预计模型时的显示名（session-manager）。
const PLACEHOLDER_LABEL = 'CodeAgent 当前模型';
// 会话的显示名是不是「没有具体模型」：没有 id，显示名为空或是占位。
function isPlaceholderModel(model) {
  if (!model || typeof model !== 'object') return true;
  if (clean(model.id)) return false;
  const label = clean(model.displayName);
  return !label || label === PLACEHOLDER_LABEL;
}
// Hub 启动时休眠 CodeAgent 会话的显示模型（renderer 加载休眠会话）。2026-10-18 用户反馈 v2.1.11：存下的当前模型为空时
// 以前拿模型清单第一项（GLM-5.2-WX-Auto）顶上，DS 号的会话被标成 GLM。现在：
//   - 存了当前模型：用它；但它和上一轮回答里的实际模型不是同一家、又不是本次明确选的（codeagentModelPick），以实际为准；
//   - 没存：用上一轮回答里的实际模型；也没有就显示占位「CodeAgent 当前模型」。不拿清单第一项顶。
// 返回 { id, displayName }；id 只在本来就存了具体模型时非空（实际模型只作显示名，内部模型仍按原来的空值）。
function dormantDisplayModel(meta) {
  const saved = meta && meta.currentModel && typeof meta.currentModel === 'object' ? meta.currentModel : null;
  const actual = clean(meta && meta.codeagentActualModel);
  const savedId = clean(saved && saved.id);
  if (savedId) {
    const conflict = actual && isSafeModelId(actual) && meta.codeagentModelPick !== true
      && savedId.toLowerCase() !== actual.toLowerCase() && modelFamily(savedId) !== modelFamily(actual);
    return conflict ? { id: actual, displayName: modelLabel(actual) } : { ...saved };
  }
  if (actual && isSafeModelId(actual)) return { id: '', displayName: modelLabel(actual) };
  const label = clean(saved && saved.displayName);
  return { id: '', displayName: label || PLACEHOLDER_LABEL };
}

// 定头像 / 侧栏图标用的模型：当前模型；CodeAgent 当前模型还空着（沿用默认、第一轮回答前或刚恢复）时看上一轮回答里的实际模型。
function iconModelId(session) {
  const current = clean(session && session.currentModel && session.currentModel.id);
  if (current) return current;
  return isCodeAgentSession(session) ? clean(session.codeagentActualModel) : '';
}

// 收到一条回答（原生记录里的 model）后会话元数据怎么改。返回 null 表示不用改。
// - 记下实际模型 codeagentActualModel（界面提示用）；
// - 实际模型和请求的不是同一家（或认不出是同一家）：说明请求没生效（常见原因是没有该模型权限），
//   当前模型改成实际的那个，恢复会话时也按它启动；原来请求的记在 codeagentRequestedModel；
// - 同一家（例如 Auto 在大小模型间分流）：保留用户选的，避免 Auto 被钉成某个具体模型。
function observeModel(session, value) {
  if (!isCodeAgentSession(session)) return null;
  const id = clean(value);
  if (!isSafeModelId(id)) return null;
  const current = session.currentModel && typeof session.currentModel === 'object' ? session.currentModel : {};
  const currentId = clean(current.id);
  const fields = {};
  if (session.codeagentActualModel !== id) fields.codeagentActualModel = id;
  const sameId = currentId.toLowerCase() === id.toLowerCase();
  const sameFamily = !!modelFamily(id) && modelFamily(id) === modelFamily(currentId);
  let mismatch = null;
  if (!sameId && !sameFamily) {
    fields.currentModel = { id, displayName: modelLabel(id) };
    if (currentId) {
      fields.codeagentRequestedModel = currentId;
      mismatch = { requested: currentId, requestedLabel: modelLabel(currentId), actual: id };
    }
  }
  return Object.keys(fields).length ? { fields, mismatch } : null;
}

function mismatchNotice(mismatch) {
  if (!mismatch) return '';
  return `选的是 ${mismatch.requestedLabel}，CodeAgent 实际用的是 ${mismatch.actual}（可能没有所选模型的权限）。`
    + '界面已按实际模型显示，之后恢复这个会话也用它；新建会话时请在模型下拉里改选有权限的模型。';
}

// ---------------------------------------------------------------- 见过的模型（本机）
function observedPath(dataDir) {
  return path.join(dataDir, OBSERVED_FILE);
}

function readObserved(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(observedPath(dataDir), 'utf8'));
    return (Array.isArray(raw && raw.models) ? raw.models : [])
      .filter(entry => entry && isSafeModelId(entry.id))
      .map(entry => ({ id: clean(entry.id), lastSeenAt: Number(entry.lastSeenAt) || 0 }));
  } catch { return []; }
}

// 只在出现新名字时写盘；同名只更新时间不写，避免每轮回答都改文件。
function recordObserved(dataDir, value, now = Date.now()) {
  const id = clean(value);
  if (!dataDir || !isSafeModelId(id)) return false;
  const models = readObserved(dataDir);
  if (models.some(entry => entry.id.toLowerCase() === id.toLowerCase())) return false;
  models.unshift({ id, lastSeenAt: now });
  const next = { schema: 1, models: models.slice(0, OBSERVED_LIMIT) };
  fs.mkdirSync(dataDir, { recursive: true });
  const file = observedPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

// ---------------------------------------------------------------- 模型菜单里实际能选的（本机）
// 2026-10-16 公司真机第 9 轮：账号清单（.cac.json）列了 GLM-5.2-WX-Auto 和 MiniMax-M2.7，CodeAgent 自己的
// 模型菜单里却只有 GLM-5.2-WX-Auto，搜 MiniMax-M2.7 是「No results found」。菜单才是交互模式下真能选的，
// 选模型时读到的菜单清单记下来，模型下拉以它为准；清单有变化才写盘。
const MENU_FILE = 'codeagent-menu-models.json';

function readMenu(dataDir) {
  if (!dataDir) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, MENU_FILE), 'utf8'));
    return (Array.isArray(raw && raw.models) ? raw.models : []).map(clean).filter(isSafeModelId);
  } catch { return []; }
}

function recordMenu(dataDir, labels, now = Date.now()) {
  const models = [...new Set((Array.isArray(labels) ? labels : []).map(clean).filter(isSafeModelId))];
  if (!dataDir || !models.length) return false;
  const before = readMenu(dataDir);
  if (before.length === models.length && before.every((id, i) => id === models[i])) return false;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, MENU_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 1, models, seenAt: now }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

// ---------------------------------------------------------------- 上下文占比
// 2026-10-13 公司版：输入框旁的上下文圆环一直不显示。Claude 的占比来自状态栏回调，CodeAgent 会话没有接状态栏
// （Hub 不改同事 CodeAgent 配置里的状态栏）。改为每轮回答后从原生记录里这一轮的用量算：
// 已用 = 输入 + 缓存写入 + 缓存读取 + 输出 token；上限取账号清单里该模型的 contextWindow，
// 按「会话当前模型 → 回答实际模型」的顺序找；清单里都没有时按 200K 估（windowSource=estimated）。
const DEFAULT_CONTEXT_WINDOW = 200000;

function contextWindowFor(configDir, modelIds = [], fsModule = fs) {
  let windows = {};
  if (configDir) { try { windows = readConfigFile(path.join(configDir, '.cac.json'), fsModule).windows || {}; } catch { windows = {}; } }
  for (const id of modelIds) {
    const key = clean(id).toLowerCase();
    if (key && windows[key]) return { window: windows[key], source: 'account' };
  }
  return { window: DEFAULT_CONTEXT_WINDOW, source: 'estimated' };
}

function contextFromUsage(usage, window) {
  if (!usage || typeof usage !== 'object' || !(window > 0)) return null;
  const n = key => (Number.isFinite(Number(usage[key])) && Number(usage[key]) > 0 ? Number(usage[key]) : 0);
  const used = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens');
  if (!(used > 0)) return null;
  return { contextUsed: used, contextEffectiveMax: window, contextPct: Math.round(used / window * 1000) / 10 };
}

// ---------------------------------------------------------------- 模型证据日志（本机）
// 2026-10-13 公司真机：选了 MiniMax 仍显示 GLM，会话里却没留下「请求了谁、命令里带了谁、实际回答用了谁」，
// 只能请同事手工跑排查脚本。这里把这三件事各记一行到 Hub 数据目录 logs/codeagent-model.log，
// 只记会话号前 8 位与模型名，不记提示词和路径；超过 256 KB 时轮转一份。
const MODEL_LOG_MAX = 256 * 1024;

function appendModelLog(dataDir, fields, now = new Date()) {
  if (!dataDir || !fields || typeof fields !== 'object') return false;
  try {
    const dir = path.join(dataDir, 'logs');
    const file = path.join(dir, 'codeagent-model.log');
    fs.mkdirSync(dir, { recursive: true });
    try { if (fs.statSync(file).size > MODEL_LOG_MAX) fs.renameSync(file, file + '.1'); } catch { /* 还没有文件 */ }
    const parts = Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${String(value).replace(/[\r\n\t]/g, ' ').slice(0, 120)}`);
    fs.appendFileSync(file, `${now.toISOString()} ${parts.join(' ')}\n`, 'utf8');
    return true;
  } catch { return false; }
}

// 新建会话和模型菜单用的列表：已知的在前，本机 CodeAgent 配置里的其次，回答里见过的其他模型在后。
// 有账号清单时只列清单里的模型（不再塞内置的两个：没有 MiniMax 权限的同事不该看到它）；
// 没有清单时沿用内置 + 配置里找到的名字。回答里实际见过的模型都附在最后。
function modelOptions(dataDir, { configDir = null, fsModule = fs } = {}) {
  const configured = configuredModels(configDir, fsModule);
  const options = configured.authoritative ? [] : KNOWN.map(option => ({ ...option, source: 'hub' }));
  for (const id of configured.models) {
    if (options.some(option => option.id.toLowerCase() === id.toLowerCase())) continue;
    options.push({ id, label: modelLabel(id), source: configured.authoritative ? 'account' : 'configured',
      description: configured.authoritative ? `${id} · 本机 CodeAgent 账号可用的模型` : `${id} · 本机 CodeAgent 配置里有这个模型` });
  }
  for (const entry of dataDir ? readObserved(dataDir) : []) {
    if (options.some(option => option.id.toLowerCase() === entry.id.toLowerCase())) continue;
    options.push({ id: entry.id, label: modelLabel(entry.id), source: 'observed', description: `${entry.id} · 本机 CodeAgent 实际用过` });
  }
  // Auto 路由背后的具体模型不能直接选：2026-10-16 公司真机 `--model GLM-5.2-WX` 报 401「未识别到用户认证信息」，
  // 只有 GLM-5.2-WX-Auto 能用。它出现在回答记录（实际模型）和分档配置里，列出来用户一选就失败，所以有「名字-Auto」时去掉它。
  // 账号清单里明确列出的照留（那是 CodeAgent 自己说这个账号能选的）。
  const ids = new Set(options.map(option => option.id.toLowerCase()));
  const listed = options.filter(option => option.source === 'account' || !ids.has(option.id.toLowerCase() + '-auto'));
  // 读到过 CodeAgent 自己的模型菜单：只列菜单里有的，菜单里有而上面没有的补在后面。
  const menu = readMenu(dataDir);
  if (!menu.length) return listed;
  const inMenu = new Set(menu.map(id => id.toLowerCase()));
  const kept = listed.filter(option => inMenu.has(option.id.toLowerCase()));
  for (const id of menu) {
    if (kept.some(option => option.id.toLowerCase() === id.toLowerCase())) continue;
    kept.push({ id, label: modelLabel(id), source: 'menu', description: `${id} · CodeAgent 模型菜单里有` });
  }
  return kept;
}

module.exports = {
  KNOWN,
  DEFAULT_MODEL,
  OBSERVED_FILE,
  isSafeModelId,
  normalizeModel,
  modelFamily,
  modelLabel,
  PLACEHOLDER_LABEL,
  isPlaceholderModel,
  iconModelId,
  isCodeAgentSession,
  dormantDisplayModel,
  observeModel,
  mismatchNotice,
  configuredModels,
  scanModelNamesInText,
  readObserved,
  recordObserved,
  readMenu,
  recordMenu,
  appendModelLog,
  modelOptions,
  contextWindowFor,
  contextFromUsage,
  DEFAULT_CONTEXT_WINDOW,
};
