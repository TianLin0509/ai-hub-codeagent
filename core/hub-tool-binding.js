'use strict';
const fs = require('fs'), path = require('path');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// Recognize only our generated entrypoints. Never execute a wrapper to discover its identity.
function wrapper(file) {
  try {
    if (fs.statSync(file).size > 16384) return null;
    const match = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').match(/^\s*['"]use strict['"];\s*require\(("(?:\\.|[^"\\])*")\)\.main\((\{[\s\S]*\})\);\s*$/);
    return match ? { module: JSON.parse(match[1]), binding: JSON.parse(match[2]) } : null;
  } catch { return null; }
}
function matchesBinding(binding, config, { requireEntry = false } = {}) {
  if (!binding || !config || typeof binding.entry !== 'string') return false;
  if (same(config.cli_entry, binding.entry)) return !requireEntry || fs.existsSync(binding.entry);
  if (binding.tool !== 'images' || !same(config.hub_cli_entry, binding.entry)) return false;
  const active = wrapper(config.cli_entry), original = wrapper(binding.entry);
  if (!active || !original || !fs.existsSync(active.module)) return false;
  if (!/[\\/]scripts[\\/]tab_client\.cjs$/i.test(active.module) || path.basename(original.module) !== 'hub-browser-tool.js') return false;
  const a = active.binding, b = original.binding;
  const pool = path.resolve(path.dirname(binding.config), '../../..');
  return ['id', 'tool', 'identity'].every(k => a[k] === binding[k] && b[k] === binding[k])
    && same(a.root, b.root) && same(a.root, path.dirname(path.dirname(binding.entry)))
    && same(a.hubCore, path.dirname(original.module)) && same(a.playwright, b.playwright)
    && same(a.poolRoot, pool) && same(config.cli_entry, path.join(pool, 'entrypoints', binding.id + '.cjs'));
}
module.exports = { matchesBinding };
