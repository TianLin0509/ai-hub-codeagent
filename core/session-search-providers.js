'use strict';

// 有自己筛选按钮的来源；其余模型归入“其他”（开放集合）。群聊是独立来源，不属于单模型会话。
// CodeAgent（公司 CLI）有自己的按钮：公司版只有它，个人版有结果时才显示（2026-10-13）。
const DEDICATED_SEARCH_PROVIDERS = Object.freeze(['codex', 'claude', 'codeagent', 'meeting']);

function isOtherSearchProvider(provider) {
  return !DEDICATED_SEARCH_PROVIDERS.includes(provider);
}

function matchesSearchProvider(provider, selected = []) {
  return !selected.length || selected.some(value => value === 'other'
    ? isOtherSearchProvider(provider) : value === provider);
}

module.exports = { DEDICATED_SEARCH_PROVIDERS, isOtherSearchProvider, matchesSearchProvider };
