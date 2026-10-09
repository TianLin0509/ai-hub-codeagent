'use strict';

// “其他”是开放集合；群聊是独立来源，不属于单模型会话。
function isOtherSearchProvider(provider) {
  return !['codex', 'claude', 'meeting'].includes(provider);
}

function matchesSearchProvider(provider, selected = []) {
  return !selected.length || selected.some(value => value === 'other'
    ? isOtherSearchProvider(provider) : value === provider);
}

module.exports = { isOtherSearchProvider, matchesSearchProvider };
