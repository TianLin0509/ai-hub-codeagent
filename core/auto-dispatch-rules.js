'use strict';
// 自动派活会话「不出选择题」（2026-10-19 用户：CodeAgent 有时弹出选择题，要在后台终端里选，自动派活的轮次就一直卡着）。
// 三类会话由程序派活、终端前没人值守：AI特战队通道（company-bridge）、公司助理（company-assistant）、论坛摘要（company-forum）。
// 两层，规则文字都只在这里：
//   说明层：NO_CHOICE_RULE 写进这三类会话启动时的系统提示（session-manager hubRulesSystemPrompt → --append-system-prompt-file，
//           2026-10-13 公司真机实测 CodeAgent 认这个参数）。不往任何代码目录写规则文件：公司电脑必须保持原样。
//   强制层：CodeAgent 配置目录 settings.json 里登记一条只匹配提问工具（AskUserQuestion）的同步 PreToolUse hook（ask-gate），
//           Hub 只给这三类会话的终端设 AI_HUB_NO_CHOICE=1；hook 见到它就以退出码 2 拒绝这次调用，把 DENY_REASON 交给模型。
//           用户自己开的会话没有这个变量，hook 直接放行。hook 本身出错（解释器缺失、超时）按非阻塞错误处理，提问照常弹出，
//           其余工具不经过这条 hook。
// 强制层可关：环境变量 AI_HUB_CODEAGENT_CHOICE_GATE=0，或 Hub 设置 providers.codeagent.choiceGate=false（默认开）。
// 提问工具名可改（CodeAgent 若改过名字）：AI_HUB_CODEAGENT_CHOICE_TOOLS=名1,名2，或 providers.codeagent.choiceTools=[...]。
// CodeAgent 是否按 Claude Code 的约定执行 PreToolUse 的退出码 2 拒绝，待公司真机确认；兜底见 core/choice-menu-screen.js（通道轮次按屏幕识别卡在选择菜单）。
const { createHash } = require('node:crypto');

const AUTO_PURPOSES = Object.freeze(['company-bridge', 'company-assistant', 'company-forum', 'company-ai']);
const isAutoDispatchPurpose = purpose => AUTO_PURPOSES.includes(String(purpose || ''));

const RULE_LABEL = '自动派活规则';
const NO_CHOICE_RULE = [
  '## 自动派活会话的工作方式',
  '这个会话由 AI Hub 自动派活，终端前没有人值守，你的回答会原样转给发问方。请这样工作：',
  '1. 一次做完：遇到需要确认、或要在几种做法里选一种的地方，按最合理的假设继续做下去，直到给出完整回答。',
  '2. 沟通都写在回答正文里：需要对方定夺的事项，用文字写进回答，由对方读完后追问。',
  '3. 回答末尾单列「假设与备选」：逐条写出这次采用的假设，以及每条对应的备选做法和适用情形，方便对方追问纠正。',
].join('\n');
const RULE_VERSION = createHash('sha256').update(NO_CHOICE_RULE, 'utf8').digest('hex').slice(0, 12);

// 系统提示里追加的一段：只有这三类会话有。
function autoRuleFor(purpose) {
  if (purpose === 'company-ai') return {label:RULE_LABEL, text:'这是无人值守的独立文字任务。直接按指定格式给出结果；材料有歧义时保留原有不确定性。', version:'company-ai-1'};
  return isAutoDispatchPurpose(purpose) ? { label: RULE_LABEL, text: NO_CHOICE_RULE, version: RULE_VERSION } : null;
}

// ---- 强制层：PreToolUse 拒绝提问工具 ----
const ENV_FLAG = 'AI_HUB_NO_CHOICE';
const ENV_REASON = 'AI_HUB_NO_CHOICE_REASON';
const ENV_TOOLS = 'AI_HUB_NO_CHOICE_TOOLS';
const DEFAULT_TOOLS = Object.freeze(['AskUserQuestion']);
const DENY_REASON = '这个会话是自动派活的，没人能回答选择题：请按最合理的假设继续，并在回答里写明假设';
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

function providerConfig() {
  try {
    const config = require('./hub-config').getConfig();
    const value = config && config.providers && config.providers.codeagent;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}
// { enabled, tools }：开关默认开；工具名不合法的丢掉，全丢光就用默认。
function gateConfig(env = process.env, provider = providerConfig()) {
  const flag = String(env.AI_HUB_CODEAGENT_CHOICE_GATE ?? '').trim().toLowerCase();
  const enabled = ['0', 'false', 'off', 'no'].includes(flag) ? false : ['1', 'true', 'on', 'yes'].includes(flag) ? true : provider.choiceGate !== false;
  const raw = String(env.AI_HUB_CODEAGENT_CHOICE_TOOLS || '').trim()
    ? String(env.AI_HUB_CODEAGENT_CHOICE_TOOLS).split(',')
    : Array.isArray(provider.choiceTools) ? provider.choiceTools : [];
  const tools = [...new Set(raw.map(s => String(s).trim()).filter(s => TOOL_NAME.test(s)))];
  return { enabled, tools: tools.length ? tools : [...DEFAULT_TOOLS] };
}
// settings.json 里这条 hook 的 matcher（Claude Code 的工具名匹配：名字或用 | 连起来的几个名字）。
function gateMatcher(config = gateConfig()) {
  return config.enabled ? config.tools.join('|') : null;
}
// 会话终端的环境变量：先去掉继承来的（Hub 可能是从某个自动派活会话的进程树里启动的），再只给这三类会话设上。
function applySessionEnv(sessionEnv, purpose, config = gateConfig()) {
  for (const key of [ENV_FLAG, ENV_REASON, ENV_TOOLS]) delete sessionEnv[key];
  if (!config.enabled || !isAutoDispatchPurpose(purpose)) return false;
  sessionEnv[ENV_FLAG] = '1';
  sessionEnv[ENV_REASON] = purpose === 'company-ai' ? '这是无人值守的文字任务，请保留材料原有的不确定性并按指定格式直接输出结果。' : DENY_REASON;
  sessionEnv[ENV_TOOLS] = config.tools.join(',');
  return true;
}

module.exports = {
  AUTO_PURPOSES, isAutoDispatchPurpose, RULE_LABEL, NO_CHOICE_RULE, RULE_VERSION, autoRuleFor,
  ENV_FLAG, ENV_REASON, ENV_TOOLS, DEFAULT_TOOLS, DENY_REASON, gateConfig, gateMatcher, applySessionEnv,
};
