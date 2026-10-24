'use strict';
const profiles = require('./claude-subscription-profiles');
function scope(config, id, env) { return profiles.usageScope(config, id, env); }
function cached(cache, selected) {
  const entry = cache['claude:' + selected];
  if (entry) return entry;
  // Existing unscoped data was produced before multiple accounts existed.
  if (selected.startsWith('default:') && cache.claude && !cache.claude.claudeScope) return {...cache.claude,claudeScope:selected};
  return {usage5h:null,usage7d:null,ts:0,claudeScope:selected};
}
function selectStatusline(cache, selected) {
  return Object.fromEntries(Object.entries(cache || {}).filter(([,e]) => e && (e.claudeScope === selected || (!e.claudeScope && !e.claudeProfile && selected.startsWith('default:')))));
}
module.exports = {scope,cached,selectStatusline};
