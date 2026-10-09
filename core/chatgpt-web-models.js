'use strict';

// These are Codex Web GPT route identities, not interchangeable reasoning levels.
const ROUTES = Object.freeze({
  light: ['Instant', 'low'], medium: ['Medium', 'medium'], high: ['High', 'high'],
  'extra-high': ['Extra High', 'xhigh'], pro: ['Pro', 'ultra'],
  'zero-risk': ['Zero Risk', 'low'], 'zero-risk-pro': ['Zero Risk Pro', 'low'],
  luna: ['Luna', 'low'], think: ['Think', 'low'],
});
function chatgptWebRoute(id) {
  const match = /^chatgpt-web\/([a-z-]+)$/.exec(String(id || ''));
  const route = match && ROUTES[match[1]];
  return route ? { id, label: `ChatGPT · ${route[0]}`, effort: route[1] } : null;
}
function isChatgptWebModel(id) { return !!chatgptWebRoute(id); }
module.exports = { chatgptWebRoute, isChatgptWebModel };
