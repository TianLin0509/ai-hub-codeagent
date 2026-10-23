'use strict';
const fs = require('node:fs');
const path = require('node:path');

let defaults = [];

function toolsCatalog() {
  let list = defaults;
  const file = path.join(__dirname, 'sites.json');
  if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf8'));
  return list.filter(item => {
    try { const u = new URL(item.url); return /^[a-z-]{1,30}$/.test(item.id) && u.protocol === 'https:' && !u.username && !u.password; }
    catch { return false; }
  }).map(item => Object.freeze({ id: item.id, name: item.name, url: item.url }));
}
function teamEnabled(env = process.env, distribution = require('../distribution')) {
  if (env.CLAUDE_HUB_E2E === '1' && env.CLAUDE_HUB_DATA_DIR && env.CLAUDE_HUB_TEAM === '1') return true;
  return distribution.personalModules || (distribution.target === 'company' && distribution.featureEnabled('teamWorkspace'));
}
module.exports = { toolsCatalog, teamEnabled };
