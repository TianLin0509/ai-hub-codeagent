'use strict';
// 用户自己指定的「新建会话默认模型」，按 CLI 分别存。
//
// 在此之前，新建会话面板的模型一律回落到 model-options.js 里硬编码的
// DEFAULT_MODEL_BY_KIND，用户改不了：renderer 的 tuningMemory 是内存 Map
// （重启即失忆），而且它只对 chatgpt 记 model 字段，别的 CLI 连"记住上次选择"
// 都没有。结果就是每次开会话都回到 Opus 5，哪怕当前最新是 Opus 5.5。
//
// 这里存的是"用户拍板的默认值"，语义上强于"上次用过什么"，所以放进 config.json
// 持久化，而不是塞进那个内存 Map。
//
// 安全性：这些值最终会被拼进 CLI 命令行（--model xxx）。所以先过一道统一的
// 字符白名单，再过每个 kind 自己的语义校验，两关都过才允许落盘。

const {
  DEFAULT_MODEL_BY_KIND,
  MODEL_OPTIONS_BY_KIND,
  isClaudeModelSelection,
  isCodexConversationModelId,
} = require('./model-options.js');

// getConfig() 输出上的扁平字段名；config.json 里对应的嵌套路径是 models.defaults。
const CONFIG_KEY = 'defaultModels';
const CONFIG_JSON_PATH = ['models', 'defaults'];

// 命令行安全的模型 id 形状：字母数字开头，其后允许 . _ - / 和 Hub 自己的 [1m]
// 后缀。刻意不放行空格、引号、分号、反引号之类能改变命令语义的字符。
const SAFE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[1m\])?$/;

function isSafeModelId(modelId) {
  return SAFE_MODEL_ID_RE.test(String(modelId || '').trim());
}

// 每个 kind 自己的语义校验，防止把 Codex 的模型设成 Claude 的默认值。
// claude / codex 用各自已有的判据（它们能认出静态清单里还没有的新模型，
// 比如刚发布的 claude-opus-5-5）；其余 kind 回退到"必须在已知清单里"。
function isModelValidForKind(kind, modelId) {
  const base = String(kind || '').replace(/-resume$/, '');
  const value = String(modelId || '').trim();
  if (!isSafeModelId(value)) return false;
  if (base === 'claude') return isClaudeModelSelection(value);
  if (base === 'codex') return isCodexConversationModelId(value);
  if (base === 'chatgpt') return value.startsWith('chatgpt-web/');
  const known = MODEL_OPTIONS_BY_KIND[base];
  // 该 kind 压根没有模型概念（powershell 之类）→ 一律拒绝。
  if (!Array.isArray(known) || !known.length) return false;
  if (known.some(option => String(option.id).toLowerCase() === value.toLowerCase())) return true;
  // 清单之外还要放行一种情况：ACP 那几个 kind（qwen / deepseek-acp / glm）的下拉
  // 由 acpModelOptions(kind, configuredModel) 生成，会把用户在配置里自定义的模型
  // 追加进去。只认静态清单的话，那种模型在下拉里选得到、却存不进去也读不回来。
  // 放行的边界是「不能是别家 CLI 的模型」，跨 CLI 误设仍然被挡住。
  return !isClaudeModelSelection(value)
    && !isCodexConversationModelId(value)
    && !value.startsWith('chatgpt-web/');
}

// 从配置里读出 per-kind 的默认模型表，顺手扔掉不合法的条目 ——
// config.json 是用户可以手改的，不能假定里面的东西一定干净。
function readDefaultModels(config) {
  const raw = config && config[CONFIG_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [kind, modelId] of Object.entries(raw)) {
    if (isModelValidForKind(kind, modelId)) result[kind] = String(modelId).trim();
  }
  return result;
}

// 新建会话面板该预选哪个模型：用户拍板的 > 出厂硬编码。
// 第三个参数是当前这个 kind 实际可选的清单（renderer 那边是运行时目录，
// 可能含官方目录刚发现的新模型）；传了就用它兜底，避免预选到一个列表里
// 根本没有的 id，让下拉显示成空白。
function resolveDefaultModel(kind, config, availableIds = null) {
  const base = String(kind || '').replace(/-resume$/, '');
  const saved = readDefaultModels(config)[base];
  const ids = Array.isArray(availableIds) && availableIds.length
    ? availableIds.map(value => String(value))
    : null;
  const inList = value => !ids || ids.some(id => id.toLowerCase() === String(value).toLowerCase());
  if (saved && inList(saved)) return saved;
  const builtin = DEFAULT_MODEL_BY_KIND[base];
  if (builtin && inList(builtin)) return builtin;
  return ids ? ids[0] : (builtin || '');
}

// 在 config.json 的原始结构上落一个默认模型，返回**完整的新 json**（不落盘，
// 保存交给调用方，这样 main 侧可以在同一次读-改-写里避免覆盖其它字段）。
// modelId 传空表示「取消自定义默认值，回到出厂设置」。
function withDefaultModelInJson(rawJson, kind, modelId, options = {}) {
  const base = String(kind || '').replace(/-resume$/, '');
  if (!base) throw new Error('未指定 CLI 类型');
  const source = rawJson && typeof rawJson === 'object' ? rawJson : {};
  const [section, field] = CONFIG_JSON_PATH;
  const current = (source[section] && source[section][field]) || {};
  const next = { ...(typeof current === 'object' && !Array.isArray(current) ? current : {}) };
  const value = String(modelId || '').trim();
  if (value) {
    // availableIds 是调用方给的「当前下拉里真能选到的模型」。给了就以它为准：
    // ACP 那几个 kind 的下拉会追加用户自配的模型（acpModelOptions 第二参数），
    // 静态清单认不出来，只按静态清单校验会出现「选得到却存不进去」。
    // 安全白名单不受影响，仍然独立把关，所以放行清单不等于放行任意字符串。
    const available = Array.isArray(options.availableIds) && options.availableIds.length
      ? options.availableIds.map(id => String(id).toLowerCase())
      : null;
    const allowed = available
      ? (isSafeModelId(value) && available.includes(value.toLowerCase()))
      : isModelValidForKind(base, value);
    if (!allowed) {
      throw new Error(`模型 ${value} 不是 ${base} 可用的模型`);
    }
    next[base] = value;
  } else {
    delete next[base];
  }
  return {
    ...source,
    [section]: { ...(source[section] || {}), [field]: next },
  };
}

// 当前选中的模型是不是已经是该 kind 的默认值（UI 用来决定按钮显示成
// 「设为默认」还是「已是默认」）。
function isDefaultModel(kind, modelId, config) {
  const base = String(kind || '').replace(/-resume$/, '');
  const value = String(modelId || '').trim();
  if (!value) return false;
  return resolveDefaultModel(base, config).toLowerCase() === value.toLowerCase();
}

module.exports = {
  CONFIG_JSON_PATH,
  CONFIG_KEY,
  isDefaultModel,
  isModelValidForKind,
  isSafeModelId,
  readDefaultModels,
  resolveDefaultModel,
  withDefaultModelInJson,
};
