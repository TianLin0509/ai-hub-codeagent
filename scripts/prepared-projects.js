#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { PreparedProjectRegistry, inventory } = require('../core/prepared-project-registry');
function main(argv) {
  const [command, ...rest] = argv;
  const args = [...rest];
  function option(name) {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} 需要值`);
    args.splice(i, 2); return value;
  }
  const dataDir = option('--data-dir');
  const apply = args.includes('--apply');
  if (apply) args.splice(args.indexOf('--apply'), 1);
  const expectedHash = option('--expected-hash');
  if (expectedHash && command !== 'restore') throw new Error('--expected-hash 只用于 restore');
  if (args.some(a => a.startsWith('--'))) throw new Error('未知参数');
  if (apply && command !== 'migrate') throw new Error('--apply 只用于 migrate');
  const registry = new PreparedProjectRegistry(dataDir ? { dataDir } : {});
  switch (command) {
    case 'list': if (args.length) break; return registry.list();
    case 'register': if (args.length !== 1) break; return registry.register(args[0]);
    case 'inventory': return { schemaVersion: 1, id: 'legacy-projects-v1', entries: inventory(args.map(path => ({ path }))) };
    case 'migrate': {
      if (args.length !== 1) break;
      const plan = JSON.parse(fs.readFileSync(args[0], 'utf8'));
      return apply ? registry.migrate(plan) : { preview: true, entries: registry.preview(plan) };
    }
    case 'restore': if (args.length !== 1 || !expectedHash) break; return registry.restore(args[0], expectedHash);
  }
  throw new Error('用法: prepared-projects.js register <项目绝对路径> | list | inventory <路径...> | migrate <计划.json> [--apply] | restore <备份> --expected-hash <当前文件SHA256>；可加 --data-dir <Hub数据目录>');
}
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
module.exports = { main };
