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
// modelParam 里列着这台电脑能用的模型（例如 GLM-5.2-WX、MiniMax-M2.7-CodeAgentCLI、Qwen3.6-27B-CodeAgent-VL），
// 每个人的权限不同，列表也不同。只看键名带 model 的那几段（不碰 projects / history 里的聊天记录），
// 收集长得像模型名的字符串（厂商名 + 至少一个数字）。
const CONFIG_MODEL_NAME = /^(?:glm|deepseek|minimax|qwen|kimi)[A-Za-z0-9_.\-]*\d[A-Za-z0-9_.\-]*$/i;
const CONFIG_MAX_BYTES = 8 * 1024 * 1024;

function collectModelNames(node, inModelSection, out, depth = 0) {
  if (depth > 8 || out.size > 60 || node == null) return;
  if (typeof node === 'string') {
    if (inModelSection && CONFIG_MODEL_NAME.test(node.trim()) && isSafeModelId(node)) out.add(node.trim());
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

function configuredModels(configDir, fsModule = fs) {
  if (!configDir) return { models: [], defaultModel: '' };
  const names = new Set();
  let defaultModel = '';
  for (const file of ['settings.json', '.cac.json']) {
    try {
      const full = path.join(configDir, file);
      if (fsModule.statSync(full).size > CONFIG_MAX_BYTES) continue;
      const data = JSON.parse(fsModule.readFileSync(full, 'utf8').replace(/^﻿/, ''));
      if (file === 'settings.json' && isSafeModelId(data && data.model)) defaultModel = String(data.model).trim();
      collectModelNames(data, false, names);
    } catch { /* 没有或读不懂就跳过 */ }
  }
  if (defaultModel) names.add(defaultModel);
  return { models: [...names], defaultModel };
}

function modelLabel(value) {
  const id = clean(value);
  const known = KNOWN.find(option => option.id.toLowerCase() === id.toLowerCase());
  return known ? known.label : id;
}

function isCodeAgentSession(session) {
  return /^codeagent(?:-resume)?$/.test(String(session && session.kind || ''));
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
    + '界面已按实际模型显示，之后恢复这个会话也用它；新建会话时可以在模型下拉里选它并「设为默认」。';
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

// 新建会话和模型菜单用的列表：已知的在前，本机 CodeAgent 配置里的其次，回答里见过的其他模型在后。
function modelOptions(dataDir, { configDir = null, fsModule = fs } = {}) {
  const options = KNOWN.map(option => ({ ...option, source: 'hub' }));
  const configured = configuredModels(configDir, fsModule);
  for (const id of configured.models) {
    if (options.some(option => option.id.toLowerCase() === id.toLowerCase())) continue;
    options.push({ id, label: modelLabel(id), source: 'configured', description: `${id} · 本机 CodeAgent 配置里有这个模型` });
  }
  for (const entry of dataDir ? readObserved(dataDir) : []) {
    if (options.some(option => option.id.toLowerCase() === entry.id.toLowerCase())) continue;
    options.push({ id: entry.id, label: modelLabel(entry.id), source: 'observed', description: `${entry.id} · 本机 CodeAgent 实际用过` });
  }
  return options;
}

module.exports = {
  KNOWN,
  DEFAULT_MODEL,
  OBSERVED_FILE,
  isSafeModelId,
  normalizeModel,
  modelFamily,
  modelLabel,
  observeModel,
  mismatchNotice,
  configuredModels,
  readObserved,
  recordObserved,
  modelOptions,
};
