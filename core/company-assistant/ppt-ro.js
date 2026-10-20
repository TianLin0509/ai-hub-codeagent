'use strict';
// Agent-facing read-only CLI. Arguments are literal; no shell evaluation or organizer.
const fs = require('node:fs'), path = require('node:path');
const { PptLibrary } = require('./ppt-library');
async function main() {
  const dir = process.env.CLAUDE_HUB_ASSISTANT_DIR;
  if (!dir) throw new Error('请从助理工作目录调用 ppt-ro.cmd');
  const a = { dir, now: Date.now, changed() {}, settings() { try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } } };
  const [op = 'status', ...rest] = process.argv.slice(2);
  let args = {};
  if (op === 'search') args = { query: rest.join(' ') };
  else if (op === 'read') args = { ids: rest };
  else if (op === 'report') {
    // JSON input via stdin keeps data out of the command line.
    let text = ''; for await (const chunk of process.stdin) text += chunk;
    args = JSON.parse(text);
  } else if (rest.length) args = JSON.parse(rest.join(' '));
  const result = await new PptLibrary(a).execute(op, args);
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 2; });
